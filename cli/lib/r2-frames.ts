/**
 * R2-backed frame cache for real-time Zyra workflow runs
 * (`docs/ZYRA_INTEGRATION_PLAN.md` §Real-time frame store, stage 1).
 *
 * A workflow's frame directory is the scheduler's working set: each
 * run wants the frames the previous run already fetched so
 * `acquire --sync-dir` only pulls the new ones from FTP, instead of
 * re-downloading the whole window. The GHA runner mounts a fresh
 * `_work` per run, so that working set has to live somewhere
 * durable — R2, under a mutable per-dataset prefix
 * `workflow-frames/{dataset_id}/`.
 *
 * This module is the runner-side sync: `restoreFramesFromR2` pulls
 * the cache into the workdir before the Zyra container runs;
 * `saveFramesToR2` pushes new frames back afterwards and prunes the
 * cache to the active window (window-only retention — the cache is
 * bounded by cadence × window, not by how long the workflow has
 * run). Recall (exposing frames for download) is a separate,
 * immutable per-upload snapshot and rides the existing
 * image-sequence `/frames` path — not this module.
 *
 * Talks to R2 via the S3 API with `aws4fetch`, reusing the operator
 * credential trio + helpers from `r2-upload.ts`
 * (`R2_S3_ENDPOINT` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`).
 * Everything here is best-effort at the call site: a cache miss or
 * an R2 hiccup must never fail a run that otherwise produced a
 * video, so the runner phases log and continue rather than throw.
 */

import { AwsClient } from 'aws4fetch'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  buildObjectUrl,
  contentTypeForFile,
  deleteR2Object,
  parseListKeys,
  uploadR2Object,
  validateR2Config,
  R2UploadError,
  type R2UploadConfig,
} from './r2-upload'

/** S3-API region R2 expects in the SigV4 signature (see r2-upload). */
const R2_REGION = 'auto'

/** Default parallelism for per-object transfers — matches the HLS
 *  bundle uploader's worker-pool size. */
const DEFAULT_CONCURRENCY = 6

/** Frame files we cache. Mirrors the scheduler's acquire patterns
 *  (PNG/JPEG/WebP); anything else under the prefix (a stray report,
 *  a sidecar) is ignored on both restore and prune so the cache
 *  only ever round-trips actual frames. */
const FRAME_EXT_RE = /\.(png|jpe?g|webp)$/i

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** Root prefix for every workflow's frame cache. */
export const WORKFLOW_FRAMES_PREFIX = 'workflow-frames'

/**
 * Mutable cache prefix for one dataset's workflow frames:
 * `workflow-frames/{dataset_id}/` (trailing slash included). Keyed
 * by the stable `target_dataset_id` — not the per-run `upload_id` —
 * because the whole point is that the set persists across runs.
 */
export function buildWorkflowFramesPrefix(datasetId: string): string {
  if (!ULID_RE.test(datasetId)) {
    throw new Error(
      `buildWorkflowFramesPrefix: datasetId must be a ULID, got "${datasetId}"`,
    )
  }
  return `${WORKFLOW_FRAMES_PREFIX}/${datasetId}/`
}

export interface FrameSyncOptions {
  /** Test injection — defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
  /** Per-line progress / diagnostics sink. Defaults to a no-op. */
  log?: (line: string) => void
  /** Bounded parallelism for per-object transfers (restore GETs).
   *  Defaults to `DEFAULT_CONCURRENCY` (6), matching the HLS bundle
   *  uploader — enough to hide per-request latency over large frame
   *  windows without hammering R2. */
  concurrency?: number
}

export interface RestoreResult {
  /** Frames downloaded from the cache into the workdir. */
  restored: number
  /** Frames already present locally, so skipped. */
  skipped: number
}

export interface SaveResult {
  /** Frames newly uploaded to the cache this run. */
  uploaded: number
  /** Cache objects deleted because they fell outside the window
   *  (or no longer exist locally). */
  pruned: number
  /** Frames retained in the cache after the prune. */
  kept: number
}

export interface SaveOptions extends FrameSyncOptions {
  /**
   * Window-only retention: keep at most the newest `keepFrames`
   * frames (by filename sort — the scheduler's date-stamped,
   * zero-padded names sort chronologically, and `pad-missing`
   * makes the sequence contiguous so "newest N names" is exactly
   * "the last N cadence steps"). Older frames are pruned from the
   * cache. Omit (or pass a non-positive value) to keep everything.
   */
  keepFrames?: number
  /**
   * Frame filenames to keep OUT of the cache — the synthetic frames
   * `pad-missing` created this run (its report's `created_files`).
   * Excluding them is the padded→real freshening mechanism: a
   * synthetic frame is never cached, so the next run's
   * `acquire --sync-dir` re-fetches the real frame once it lands
   * upstream (and `pad-missing` simply re-creates it while it is
   * still genuinely missing). Any matching object already in the
   * cache is pruned.
   */
  excludeNames?: Iterable<string>
}

function makeClient(config: R2UploadConfig): AwsClient {
  return new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: R2_REGION,
  })
}

/**
 * List every key under `prefix`, following ListObjectsV2
 * continuation tokens so a frame set larger than one S3 page (1000
 * objects) enumerates fully — the large frame sets this cache
 * exists for are exactly the ones that paginate.
 */
async function listPrefixKeys(
  config: R2UploadConfig,
  client: AwsClient,
  fetchImpl: typeof fetch,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = []
  let token: string | undefined
  do {
    let listUrl =
      `${config.endpoint}/${encodeURIComponent(config.bucket)}` +
      `?list-type=2&prefix=${encodeURIComponent(prefix)}`
    if (token) listUrl += `&continuation-token=${encodeURIComponent(token)}`
    const signed = await client.sign(listUrl, { method: 'GET' })
    let res: Response
    try {
      res = await fetchImpl(signed)
    } catch (e) {
      throw new R2UploadError(
        null,
        prefix,
        `LIST ${prefix} unreachable: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new R2UploadError(
        res.status,
        prefix,
        `LIST ${prefix} failed (${res.status}): ${text.slice(0, 200)}`,
      )
    }
    const xml = await res.text()
    for (const k of parseListKeys(xml)) keys.push(k)
    token = nextContinuationToken(xml)
  } while (token)
  return keys
}

/** Pull the NextContinuationToken from a ListObjectsV2 body when it
 *  is truncated, else undefined. */
function nextContinuationToken(xml: string): string | undefined {
  if (!/<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml)) return undefined
  const m = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)
  return m ? m[1] : undefined
}

/** Map a cache key back to its bare frame filename, or null if the
 *  key isn't a top-level frame object under the prefix. */
function frameNameFromKey(prefix: string, key: string): string | null {
  if (!key.startsWith(prefix)) return null
  const name = key.slice(prefix.length)
  // Only top-level frame files — never a nested object (a future
  // metadata/ sub-prefix) and never a non-frame extension.
  if (name.length === 0 || name.includes('/')) return null
  if (!FRAME_EXT_RE.test(name)) return null
  return name
}

/**
 * Restore a dataset's cached frames into `framesDir` before the
 * Zyra container runs. Frames already present locally are left
 * alone (idempotent re-runs, and a partially-populated workdir).
 * Creates `framesDir` if absent. Returns counts; throws
 * `R2UploadError` on an R2 failure (the caller decides whether a
 * cache miss is fatal — it isn't).
 */
export async function restoreFramesFromR2(
  config: R2UploadConfig,
  datasetId: string,
  framesDir: string,
  options: FrameSyncOptions = {},
): Promise<RestoreResult> {
  validateR2Config(config)
  const fetchImpl = options.fetchImpl ?? fetch
  const log = options.log ?? (() => {})
  const client = makeClient(config)
  const prefix = buildWorkflowFramesPrefix(datasetId)

  const keys = await listPrefixKeys(config, client, fetchImpl, prefix)
  await mkdir(framesDir, { recursive: true })

  // Resolve the set to download first (skipping frames already on
  // disk), then GET them with bounded concurrency — a large window
  // is exactly where serial round-trips would risk a runner timeout.
  const toFetch: Array<{ key: string; dest: string }> = []
  let skipped = 0
  for (const key of keys) {
    const name = frameNameFromKey(prefix, key)
    if (!name) continue
    const dest = join(framesDir, name)
    if (existsSync(dest)) {
      skipped++
      continue
    }
    toFetch.push({ key, dest })
  }

  let restored = 0
  let cursor = 0
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++
      if (i >= toFetch.length) return
      const { key, dest } = toFetch[i]
      const signed = await client.sign(buildObjectUrl(config, key), { method: 'GET' })
      let res: Response
      try {
        res = await fetchImpl(signed)
      } catch (e) {
        throw new R2UploadError(
          null,
          key,
          `GET ${key} unreachable: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new R2UploadError(res.status, key, `GET ${key} failed (${res.status}): ${text.slice(0, 200)}`)
      }
      await writeFile(dest, new Uint8Array(await res.arrayBuffer()))
      restored++
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, toFetch.length || 1) }, () => worker()),
  )

  log(`restore: ${restored} restored, ${skipped} already present (${keys.length} in cache)`)
  return { restored, skipped }
}

/**
 * Save new frames from `framesDir` back to the dataset's cache and
 * prune it to the active window.
 *
 *   - **Upload:** any kept local frame not already in the cache.
 *     Frame filenames are content-stable in stage 1 (a given name
 *     always holds the same bytes), so "already cached" ⇒ "no need
 *     to re-PUT" — this is what makes the per-run upload the delta,
 *     not the whole window. (Padded→real freshening, stage 2, will
 *     revisit this with a digest compare.)
 *   - **Prune:** with `keepFrames` set, keep only the newest N local
 *     frames; delete every cache object outside that set — both the
 *     ones that aged out of the window and any whose local file is
 *     gone. Without `keepFrames`, prune only deletes cache objects
 *     with no corresponding local frame.
 *
 * Returns counts; throws `R2UploadError` on an R2 failure.
 */
export async function saveFramesToR2(
  config: R2UploadConfig,
  datasetId: string,
  framesDir: string,
  options: SaveOptions = {},
): Promise<SaveResult> {
  validateR2Config(config)
  const fetchImpl = options.fetchImpl ?? fetch
  const log = options.log ?? (() => {})
  const client = makeClient(config)
  const prefix = buildWorkflowFramesPrefix(datasetId)

  let localNames: string[]
  try {
    localNames = (await readdir(framesDir)).filter(n => FRAME_EXT_RE.test(n)).sort()
  } catch {
    // No frames dir → nothing to save (e.g. acquire produced
    // nothing). Leave the cache untouched.
    log(`save: ${framesDir} unreadable — nothing to save`)
    return { uploaded: 0, pruned: 0, kept: 0 }
  }
  if (localNames.length === 0) {
    // The dir exists but holds no frames (acquire produced nothing,
    // or a failed run). Treat it as "nothing to save" rather than
    // pruning every cached frame — same fail-open posture as an
    // unreadable dir.
    log(`save: ${framesDir} has no frames — leaving the cache untouched`)
    return { uploaded: 0, pruned: 0, kept: 0 }
  }

  // Window prune: keep the newest N by name. Names are date-stamped
  // and zero-padded, so a lexical sort is chronological.
  const keep =
    options.keepFrames && options.keepFrames > 0
      ? Math.min(options.keepFrames, localNames.length)
      : localNames.length
  const kept = localNames.slice(localNames.length - keep)

  // Synthetic (padded) frames are deliberately NOT cached: leaving
  // them out is what lets the next run's acquire replace a padded
  // frame with the real one once it lands upstream. The desired
  // cache set is the window minus the synthetic frames.
  const exclude = new Set(options.excludeNames ?? [])
  const desired = exclude.size > 0 ? kept.filter(n => !exclude.has(n)) : kept
  const desiredSet = new Set(desired)

  const remoteKeys = await listPrefixKeys(config, client, fetchImpl, prefix)
  const remoteByName = new Map<string, string>()
  for (const key of remoteKeys) {
    const name = frameNameFromKey(prefix, key)
    if (name) remoteByName.set(name, key)
  }

  let uploaded = 0
  for (const name of desired) {
    if (remoteByName.has(name)) continue
    const body = new Uint8Array(await readFile(join(framesDir, name)))
    await uploadR2Object(config, prefix + name, body, contentTypeForFile(name), { fetchImpl })
    uploaded++
  }

  // Prune everything not in the desired set — frames that aged out
  // of the window, frames whose local file is gone, and any stale
  // synthetic copy a prior run cached.
  let pruned = 0
  for (const [name, key] of remoteByName) {
    if (desiredSet.has(name)) continue
    await deleteR2Object(config, key, { fetchImpl })
    pruned++
  }

  log(`save: ${uploaded} uploaded, ${pruned} pruned, ${desired.length} kept in cache` +
    (exclude.size > 0 ? ` (${exclude.size} synthetic excluded)` : ''))
  return { uploaded, pruned, kept: desired.length }
}

/**
 * Frame budget for the active window: how many cadence steps fit in
 * `sincePeriodSeconds`. Used to derive `keepFrames` from the
 * pipeline's `acquire --since-period` and `scan-frames
 * --period-seconds`. Returns null when either input is missing or
 * non-positive — the caller then keeps everything (fail-open: never
 * prune when the window is unknown).
 */
export function windowFrameBudget(
  sincePeriodSeconds: number | null,
  periodSeconds: number | null,
): number | null {
  if (
    sincePeriodSeconds == null ||
    periodSeconds == null ||
    !Number.isFinite(sincePeriodSeconds) ||
    !Number.isFinite(periodSeconds) ||
    sincePeriodSeconds <= 0 ||
    periodSeconds <= 0
  ) {
    return null
  }
  // +1 so the window is inclusive of both endpoints (N steps span
  // N+1 frames).
  return Math.ceil(sincePeriodSeconds / periodSeconds) + 1
}

/**
 * Convert an ISO-8601 duration (`P1Y`, `P6M`, `P1W`, `P30D`,
 * `PT1H`, `P1DT12H`, …) to seconds. Calendar components use fixed
 * approximations (year = 365 d, month = 30 d) — fine for a
 * retention window, which only needs to be roughly the data span.
 * Returns null on an unparseable string.
 */
export function isoDurationToSeconds(duration: string): number | null {
  const m =
    /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      duration.trim(),
    )
  if (!m) return null
  // Reject the empty match (`P` / `PT` with no components).
  if (m.slice(1).every(g => g === undefined)) return null
  const [, y, mo, w, d, h, min, s] = m.map(v => (v === undefined ? 0 : Number(v)))
  return (
    y * 365 * 86400 +
    mo * 30 * 86400 +
    w * 7 * 86400 +
    d * 86400 +
    h * 3600 +
    min * 60 +
    s
  )
}
