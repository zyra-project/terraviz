// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `terraviz migrate-r2-hls` — migrate legacy `vimeo:<id>` data_refs
 * to R2-hosted HLS bundles for 4K spherical streaming.
 *
 * Phase 3 commit C. Replaces Phase 2's `terraviz migrate-videos`
 * (which targeted Cloudflare Stream; abandoned after live testing
 * revealed the standard plan's 1080p rendition ceiling — see the
 * Phase 2 → 3 transition note in CHANGELOG.md).
 *
 * Per-row pipeline:
 *
 *   1. Resolve `vimeo:<id>` to a source MP4 URL via the
 *      video-proxy (3/C's `resolveVimeoSource`).
 *   2. FFmpeg-encode to a multi-rendition HLS bundle (3/A's
 *      `encodeHls`) in a per-row workdir. Three renditions at
 *      2:1 spherical aspect — 4K (4096x2048), 1080p (2160x1080),
 *      720p (1440x720). H.264 main profile, AAC 192kbps, 6-second
 *      VOD segments.
 *   3. Upload the bundle to R2 (3/B's `uploadHlsBundle`) under
 *      `videos/<dataset_id>/`. Bounded parallel PUTs via the S3
 *      API; per-file Content-Type is HLS-aware.
 *   4. PATCH the dataset's `data_ref` to
 *      `r2:videos/<dataset_id>/master.m3u8`. **This is the
 *      commit point.** Failures before it leave the row on
 *      `vimeo:` and the SPA's manifest endpoint keeps proxying
 *      through Vimeo as before. Failures *at* this step leave
 *      the R2 bundle uploaded but unreferenced — the rollback
 *      subcommand (3/F) cleans up.
 *   5. Emit a `migration_r2_hls` telemetry event (event_type
 *      added to KNOWN_EVENT_TYPES in 3/E; until E lands the
 *      ingest endpoint 400s these and the operator sees a soft
 *      warning).
 *   6. Clean up the per-row workdir on success. Failed rows
 *      keep their workdir for debugging unless --keep-workdir
 *      is explicitly suppressed.
 *
 * Idempotency: re-running skips rows whose `data_ref` already
 * starts with `r2:videos/`. Operators can interrupt with `^C` and
 * resume by re-invoking — already-migrated rows skip naturally.
 *
 * Pacing: sequential, 1 s default between rows. Encoding takes
 * minutes per row, so the pace is mostly nominal; it exists for
 * politeness to the publisher API.
 *
 * Real-time row guard: SOS publishes a handful of "Real-time"
 * datasets (sea surface temperature, precipitation, earthquakes,
 * etc.) whose Vimeo IDs are re-uploaded daily by NOAA's automation.
 * Phase 3 is a one-shot encode — the R2 copy goes stale within
 * 24h for these rows. By default the migration filters them out
 * at plan time (`--skip-realtime`, default true) by matching
 * `/real[-\s]?time/i` against the row title. Operators who want
 * to migrate them anyway (e.g. shipping a known-stale snapshot)
 * pass `--no-skip-realtime`. `--id <row>` is treated as an explicit
 * override: the filter doesn't apply, but a warning prints if the
 * targeted row matches.
 *
 * Flags:
 *   --dry-run            Print plan + storage estimate; no encoding.
 *   --limit=N            Cap rows migrated this run.
 *   --id=<dataset>       Single-row mode (skips list paging).
 *   --pace-ms=N          Inter-row pacing (default 1000).
 *   --workdir=<path>     Parent dir for per-row encode output
 *                        (default /tmp/terraviz-hls).
 *   --keep-workdir       Skip cleanup of per-row workdirs on
 *                        success. Failed rows always retained.
 *   --ffmpeg-bin=<path>  Override ffmpeg binary (default PATH).
 *   --proxy-base=<url>   Override the video-proxy base URL.
 *   --no-skip-realtime   Include real-time titled rows (default:
 *                        skipped — they need a recurring refresh
 *                        mechanism that Phase 3 does not ship).
 *
 * R2 credentials read from process.env: R2_S3_ENDPOINT,
 * R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY. The bucket defaults to
 * `terraviz-assets` (override via CATALOG_R2_BUCKET).
 */

import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveVimeoSource as resolveVimeoSourceLib } from './lib/vimeo-source'
import { encodeHls as encodeHlsLib } from './lib/ffmpeg-hls'
import {
  uploadHlsBundle as uploadHlsBundleLib,
  loadR2ConfigFromEnv,
  type R2UploadConfig,
} from './lib/r2-upload'
import { makeMigrationTelemetryEmitter, type TelemetryEventPayload } from './lib/migration-telemetry'
import type { CommandContext } from './commands'
import { getString, getNumber, getBool, getBoolDefault } from './lib/args'
import { isRealtimeTitle } from './lib/realtime-title'

/** A single row from the publisher list response, narrowed to the
 * fields the migration cares about. */
interface PublisherDatasetRow {
  id: string
  legacy_id: string | null
  title: string
  format: string
  data_ref: string
  published_at: string | null
}

interface DatasetListEnvelope {
  datasets: PublisherDatasetRow[]
  next_cursor: string | null
}

interface DatasetGetEnvelope {
  dataset: PublisherDatasetRow
}

interface DatasetUpdateEnvelope {
  dataset: { id: string; slug: string }
}

const LIST_PAGE_LIMIT = 200
const DEFAULT_PACE_MS = 1_000
const DEFAULT_WORKDIR_ROOT = '/tmp/terraviz-hls'

/**
 * Crude bytes-per-minute estimate for the 4K + 1080p + 720p HLS
 * ladder at our CRF settings. Used only for pre-flight cost
 * estimation — actual sizes will vary based on content complexity.
 * Calibration source: 4K @ ~25 Mbps + 1080p @ ~5 Mbps + 720p @
 * ~2.5 Mbps ≈ 32.5 Mbps total ≈ 244 MB / minute of content.
 */
const ESTIMATED_BUNDLE_MB_PER_MINUTE = 244

/** R2 storage pricing — used in the dry-run summary so operators
 * see a $/month estimate alongside the byte count. $0.015 / GB-month
 * as of 2026. */
const R2_USD_PER_GB_MONTH = 0.015

export type MigrationOutcome =
  | 'ok'
  | 'vimeo_fetch_failed'
  | 'encode_failed'
  | 'r2_upload_failed'
  | 'data_ref_patch_failed'

export interface MigrationResult {
  datasetId: string
  legacyId: string
  vimeoId: string
  /** R2 master playlist key (e.g. `videos/<id>/master.m3u8`).
   * Empty string until the upload completes. */
  r2Key: string
  /** Advertised source MP4 size in bytes, or 0 if unknown. */
  sourceBytes: number
  /** Total bytes uploaded to R2 across all files in the bundle. */
  bundleBytes: number
  /** ffmpeg wall-clock encode duration in ms. */
  encodeDurationMs: number
  /** R2 upload wall-clock duration in ms. */
  uploadDurationMs: number
  /** Overall per-row wall-clock duration in ms. */
  durationMs: number
  outcome: MigrationOutcome
  /** Operator-facing error message; '' on `outcome === 'ok'`. */
  errorMessage: string
}

export interface MigrateR2HlsDeps {
  /** DI for the vimeo source resolver. */
  resolveVimeoSource?: typeof resolveVimeoSourceLib
  /** DI for the FFmpeg encoder. */
  encodeHls?: typeof encodeHlsLib
  /** DI for the R2 bulk uploader. */
  uploadHlsBundle?: typeof uploadHlsBundleLib
  /** Telemetry sink. Defaults to the real emitter posting to
   * `<server>/api/ingest`. Tests pass a recorder. */
  emitTelemetry?: (event: TelemetryEventPayload) => void | Promise<void>
  /** DI for the wall clock. */
  now?: () => number
  /** R2 credentials. Defaults to reading from `process.env`. */
  r2Config?: R2UploadConfig
  /** Skip the inter-row pacing wait (used by tests). */
  skipPace?: boolean
  /** Override the workdir-root resolution (used by tests). */
  workdirRoot?: string
}

interface MigrationCandidate {
  datasetId: string
  legacyId: string
  title: string
  vimeoId: string
}

function asCandidate(row: PublisherDatasetRow): MigrationCandidate | null {
  if (row.format !== 'video/mp4') return null
  if (!row.data_ref.startsWith('vimeo:')) return null
  const vimeoId = row.data_ref.slice('vimeo:'.length).trim()
  if (!/^\d+$/.test(vimeoId)) return null
  return {
    datasetId: row.id,
    legacyId: row.legacy_id ?? '',
    title: row.title,
    vimeoId,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Build the migration plan. Two paths:
 *
 *   - Paginated walk (no `--id`): GETs the publisher list with
 *     `status=published` so drafts and retracted rows are out of
 *     scope. Filters in-memory to `format = video/mp4` AND
 *     `data_ref` begins `vimeo:`.
 *   - Single-row mode (`--id <id>`): GETs the row directly,
 *     bypasses the status filter. Same intentional divergence as
 *     Phase 2's migrate-videos — operators using `--id` are
 *     surgically targeting a row and know what they're typing.
 */
async function buildPlan(
  ctx: CommandContext,
  targetId: string | undefined,
): Promise<MigrationCandidate[] | null> {
  if (targetId) {
    const result = await ctx.client.get<DatasetGetEnvelope>(targetId)
    if (!result.ok) {
      ctx.stderr.write(
        `Could not GET ${targetId} (${result.status}): ${result.error}` +
          (result.message ? ` — ${result.message}` : '') +
          '\n',
      )
      return null
    }
    const candidate = asCandidate(result.body.dataset)
    if (!candidate) {
      ctx.stderr.write(
        `Dataset ${targetId} is not a vimeo: video/mp4 row ` +
          `(format=${result.body.dataset.format}, data_ref=${result.body.dataset.data_ref}). ` +
          `Skipping.\n`,
      )
      return []
    }
    return [candidate]
  }

  const candidates: MigrationCandidate[] = []
  let cursor: string | undefined
  do {
    const result = await ctx.client.list<DatasetListEnvelope>({
      status: 'published',
      limit: LIST_PAGE_LIMIT,
      cursor,
    })
    if (!result.ok) {
      ctx.stderr.write(
        `Could not list datasets (${result.status}): ${result.error}` +
          (result.message ? ` — ${result.message}` : '') +
          '\n',
      )
      return null
    }
    for (const row of result.body.datasets) {
      const candidate = asCandidate(row)
      if (candidate) candidates.push(candidate)
    }
    cursor = result.body.next_cursor ?? undefined
  } while (cursor)
  return candidates
}

function printPlanSummary(
  ctx: CommandContext,
  plan: MigrationCandidate[],
  limit: number,
  skippedRealtime: MigrationCandidate[],
): void {
  const willRun = Math.min(plan.length, limit)
  ctx.stdout.write(
    `Migration plan:\n` +
      `  vimeo: rows on video/mp4:   ${plan.length + skippedRealtime.length}\n` +
      (skippedRealtime.length > 0
        ? `  skipped (real-time guard):  ${skippedRealtime.length}` +
          ` (Vimeo source is updated daily; one-shot R2 copy would go stale)\n`
        : '') +
      `  will migrate this run:      ${willRun}` +
      (limit < plan.length ? ` (capped by --limit)\n` : '\n'),
  )
  if (skippedRealtime.length > 0) {
    // Surface the actual skipped IDs + titles so the operator can
    // sanity-check the heuristic. Cap the listing the same way the
    // willRun sample does — the full set is recoverable via the
    // `terraviz list-realtime-r2` subcommand (3a/B, planned).
    const skippedSample = skippedRealtime.slice(0, 5)
    ctx.stdout.write(`  Skipped real-time rows (--no-skip-realtime to override):\n`)
    for (const c of skippedSample) {
      ctx.stdout.write(`    • ${c.datasetId}  vimeo:${c.vimeoId}  ${c.title}\n`)
    }
    if (skippedRealtime.length > skippedSample.length) {
      ctx.stdout.write(
        `    • … + ${skippedRealtime.length - skippedSample.length} more\n`,
      )
    }
  }
  if (plan.length === 0) return
  const sample = plan.slice(0, Math.min(willRun, 5))
  for (const c of sample) {
    ctx.stdout.write(`  • ${c.datasetId}  vimeo:${c.vimeoId}  ${c.title}\n`)
  }
  if (willRun > sample.length) {
    ctx.stdout.write(`  • … + ${willRun - sample.length} more\n`)
  }
}

/**
 * Print a rough R2 storage estimate based on summed source
 * durations. The actual encode produces three renditions at our
 * configured bitrates; the per-minute multiplier is calibrated to
 * the 4K+1080p+720p ladder. Operator should treat this as
 * order-of-magnitude — real bundle sizes vary with content
 * complexity (motion, scene cuts).
 */
async function printCostEstimate(
  ctx: CommandContext,
  plan: MigrationCandidate[],
  limit: number,
  resolveSource: typeof resolveVimeoSourceLib,
  proxyBase: string | undefined,
): Promise<void> {
  const work = plan.slice(0, limit)
  let knownMinutes = 0
  let unknown = 0
  // Concurrent metadata-only fetches so the cost estimate doesn't
  // serialize 130 round-trips on long catalogs. The proxyBase
  // override flows through so a --proxy-base flag affects the
  // cost estimate the same way it'll affect the live encode.
  const durations = await Promise.all(
    work.map(async c => {
      try {
        const meta = await resolveSource(c.vimeoId, { proxyBase })
        return meta.durationSeconds
      } catch {
        return null
      }
    }),
  )
  for (const seconds of durations) {
    if (seconds === null) {
      unknown += 1
      continue
    }
    knownMinutes += seconds / 60
  }
  const estimatedBundleMb = knownMinutes * ESTIMATED_BUNDLE_MB_PER_MINUTE
  const estimatedGb = estimatedBundleMb / 1024
  const monthlyDollars = estimatedGb * R2_USD_PER_GB_MONTH

  ctx.stdout.write(
    `Storage estimate (R2):\n` +
      `  rows with known duration: ${work.length - unknown} / ${work.length}\n` +
      `  total source minutes:     ${knownMinutes.toFixed(1)}\n` +
      `  estimated bundle storage: ${estimatedBundleMb.toFixed(0)} MB (${estimatedGb.toFixed(2)} GB)\n` +
      `  ≈ \$${monthlyDollars.toFixed(2)}/month at \$${R2_USD_PER_GB_MONTH}/GB-month\n`,
  )
  if (unknown > 0) {
    ctx.stdout.write(
      `  (${unknown} row${unknown === 1 ? '' : 's'} had no resolvable duration — the bundle size will be larger than estimated)\n`,
    )
  }
}

interface RowDeps {
  resolveVimeoSource: typeof resolveVimeoSourceLib
  encodeHls: typeof encodeHlsLib
  uploadHlsBundle: typeof uploadHlsBundleLib
  now: () => number
  r2Config: R2UploadConfig
  client: CommandContext['client']
  workdirRoot: string
  ffmpegBin: string | undefined
  proxyBase: string | undefined
  keepWorkdir: boolean
  stdout: CommandContext['stdout']
}

async function migrateOne(
  candidate: MigrationCandidate,
  deps: RowDeps,
): Promise<MigrationResult> {
  const start = deps.now()
  const result: MigrationResult = {
    datasetId: candidate.datasetId,
    legacyId: candidate.legacyId,
    vimeoId: candidate.vimeoId,
    r2Key: '',
    sourceBytes: 0,
    bundleBytes: 0,
    encodeDurationMs: 0,
    uploadDurationMs: 0,
    durationMs: 0,
    outcome: 'ok',
    errorMessage: '',
  }

  const workdir = join(deps.workdirRoot, candidate.datasetId)
  let cleanupOnSuccess = !deps.keepWorkdir

  // Stage 1 — resolve the source URL.
  //
  // Workdir creation is deferred until *after* resolve succeeds —
  // a vimeo_fetch_failed row never encodes, so creating an empty
  // workdir for it would leave behind a useless empty dir the
  // operator has to clean up later.
  let source
  try {
    source = await deps.resolveVimeoSource(candidate.vimeoId, { proxyBase: deps.proxyBase })
  } catch (e) {
    result.outcome = 'vimeo_fetch_failed'
    result.errorMessage = e instanceof Error ? e.message : String(e)
    result.durationMs = deps.now() - start
    // No workdir created yet — nothing to keep or clean up.
    return result
  }
  // Resolve succeeded — now we'll be writing segment files. If
  // a previous attempt left behind any state in this dataset's
  // workdir (the migrator preserves dirs on `encode_failed` /
  // `r2_upload_failed` for operator inspection), wipe it before
  // starting the new encode. Without this wipe, a retry whose
  // encode trims to fewer segments than the previous attempt
  // would leave stale `.ts` files in place and `uploadHlsBundle`
  // — which walks the whole directory tree — would PUT them to
  // R2 alongside the new bundle.
  rmSync(workdir, { recursive: true, force: true })
  mkdirSync(workdir, { recursive: true })
  result.sourceBytes = source.sizeBytes ?? 0

  // Stage 2 — encode HLS bundle. ffmpeg pulls the URL directly via -i.
  let encoded
  try {
    encoded = await deps.encodeHls({
      inputPath: source.mp4Url,
      outputDir: workdir,
      ffmpegBin: deps.ffmpegBin,
      onProgress: line => deps.stdout.write(`  [${candidate.datasetId}] ${line}\n`),
    })
  } catch (e) {
    result.outcome = 'encode_failed'
    result.errorMessage = e instanceof Error ? e.message : String(e)
    result.durationMs = deps.now() - start
    cleanupOnSuccess = false
    return result
  }
  result.encodeDurationMs = encoded.durationMs

  // Stage 3 — upload to R2.
  let uploaded
  try {
    uploaded = await deps.uploadHlsBundle(
      deps.r2Config,
      workdir,
      `videos/${candidate.datasetId}`,
    )
  } catch (e) {
    result.outcome = 'r2_upload_failed'
    result.errorMessage = e instanceof Error ? e.message : String(e)
    result.durationMs = deps.now() - start
    cleanupOnSuccess = false
    return result
  }
  result.r2Key = uploaded.masterKey
  result.bundleBytes = uploaded.totalBytes
  result.uploadDurationMs = uploaded.durationMs

  // Stage 4 — flip data_ref. Commit point.
  const newDataRef = `r2:${uploaded.masterKey}`
  const patched = await deps.client.updateDataset<DatasetUpdateEnvelope>(candidate.datasetId, {
    data_ref: newDataRef,
  })
  if (!patched.ok) {
    result.outcome = 'data_ref_patch_failed'
    result.errorMessage = `${patched.status}: ${patched.error}${patched.message ? ` — ${patched.message}` : ''}`
    result.durationMs = deps.now() - start
    cleanupOnSuccess = false
    return result
  }

  result.durationMs = deps.now() - start

  // Cleanup: only on full success and unless --keep-workdir was set.
  if (cleanupOnSuccess) {
    rmSync(workdir, { recursive: true, force: true })
  }

  return result
}

/** Convert a typed `MigrationResult` to the flat telemetry event
 * payload. Every field is a stable identifier or scalar — no
 * free-text, no hashing required (dataset_id / vimeo_id /
 * r2_key are public catalog references). */
function toTelemetryEvent(result: MigrationResult): TelemetryEventPayload {
  return {
    event_type: 'migration_r2_hls',
    dataset_id: result.datasetId,
    legacy_id: result.legacyId,
    vimeo_id: result.vimeoId,
    r2_key: result.r2Key,
    source_bytes: result.sourceBytes,
    bundle_bytes: result.bundleBytes,
    encode_duration_ms: result.encodeDurationMs,
    upload_duration_ms: result.uploadDurationMs,
    duration_ms: result.durationMs,
    outcome: result.outcome,
  }
}

export async function runMigrateR2Hls(
  ctx: CommandContext,
  deps: MigrateR2HlsDeps = {},
): Promise<number> {
  const targetId = getString(ctx.args.options, 'id')
  const limitFlag = getNumber(ctx.args.options, 'limit')
  const dryRun = getBool(ctx.args.options, 'dry-run')
  const paceMs = getNumber(ctx.args.options, 'pace-ms') ?? DEFAULT_PACE_MS
  const workdirRoot = deps.workdirRoot ?? getString(ctx.args.options, 'workdir') ?? DEFAULT_WORKDIR_ROOT
  const keepWorkdir = getBool(ctx.args.options, 'keep-workdir')
  const ffmpegBin = getString(ctx.args.options, 'ffmpeg-bin')
  const proxyBase = getString(ctx.args.options, 'proxy-base')
  const skipRealtime = getBoolDefault(ctx.args.options, 'skip-realtime', true)

  if (limitFlag !== undefined && limitFlag < 1) {
    ctx.stderr.write(`--limit must be a positive integer (got ${limitFlag}).\n`)
    return 2
  }
  if (paceMs < 0) {
    ctx.stderr.write(`--pace-ms must be non-negative (got ${paceMs}).\n`)
    return 2
  }

  const resolveVimeoSource = deps.resolveVimeoSource ?? resolveVimeoSourceLib
  const encodeHls = deps.encodeHls ?? encodeHlsLib
  const uploadHlsBundle = deps.uploadHlsBundle ?? uploadHlsBundleLib
  const now = deps.now ?? Date.now

  const rawPlan = await buildPlan(ctx, targetId)
  if (rawPlan === null) return 1

  // Real-time row filter (3a/A). Two modes:
  //   - Bulk mode (no --id): filter the plan, surface the skipped
  //     count in the summary so the operator sees what was excluded
  //     and why. Default-on; `--no-skip-realtime` opts back in.
  //   - --id mode: the operator typed a specific row by hand, so
  //     the filter does NOT apply (matches the existing precedent
  //     that --id bypasses the published-status filter). A warning
  //     prints if the targeted row matches, so a slip-of-the-finger
  //     migration of a real-time row is still visible.
  let plan: MigrationCandidate[]
  let skippedRealtime: MigrationCandidate[]
  if (targetId) {
    plan = rawPlan
    skippedRealtime = []
    const realtimeHit = rawPlan.find(c => isRealtimeTitle(c.title))
    if (realtimeHit) {
      ctx.stderr.write(
        `Warning: ${realtimeHit.datasetId} (${realtimeHit.title}) is a real-time row — its ` +
          `Vimeo source is updated daily and the R2 copy will go stale within 24h. ` +
          `--id overrides the --skip-realtime guard; proceeding anyway.\n`,
      )
    }
  } else if (skipRealtime) {
    skippedRealtime = rawPlan.filter(c => isRealtimeTitle(c.title))
    plan = rawPlan.filter(c => !isRealtimeTitle(c.title))
  } else {
    plan = rawPlan
    skippedRealtime = []
  }

  const limit = limitFlag ?? plan.length
  printPlanSummary(ctx, plan, limit, skippedRealtime)

  if (plan.length > 0) {
    try {
      await printCostEstimate(ctx, plan, limit, resolveVimeoSource, proxyBase)
    } catch (e) {
      ctx.stderr.write(
        `Cost estimate skipped: ${e instanceof Error ? e.message : String(e)}\n`,
      )
    }
  }

  if (dryRun) {
    ctx.stdout.write('\nDry run — no rows will be migrated. Re-run without --dry-run to apply.\n')
    return 0
  }
  if (plan.length === 0) {
    ctx.stdout.write('\nNothing to migrate.\n')
    return 0
  }

  // Stage validation — config + workdir.
  const r2Config = deps.r2Config ?? loadR2ConfigFromEnv()
  if (!r2Config.endpoint || !r2Config.accessKeyId || !r2Config.secretAccessKey) {
    ctx.stderr.write(
      'R2_S3_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY must all be set in the environment.\n',
    )
    return 2
  }
  if (!existsSync(workdirRoot)) {
    mkdirSync(workdirRoot, { recursive: true })
  }

  // Telemetry: default to the real emitter unless tests injected
  // one. Print the session id up front so the operator can grep
  // Grafana for "this migration's progress."
  let emitTelemetry: NonNullable<MigrateR2HlsDeps['emitTelemetry']>
  if (deps.emitTelemetry) {
    emitTelemetry = deps.emitTelemetry
  } else {
    const emitter = makeMigrationTelemetryEmitter({ serverUrl: ctx.client.serverUrl })
    ctx.stdout.write(`Telemetry session id: ${emitter.sessionId}\n`)
    emitTelemetry = event => emitter.emit(event)
  }

  const work = plan.slice(0, limit)
  const counts: Record<MigrationOutcome, number> = {
    ok: 0,
    vimeo_fetch_failed: 0,
    encode_failed: 0,
    r2_upload_failed: 0,
    data_ref_patch_failed: 0,
  }

  for (let i = 0; i < work.length; i++) {
    const candidate = work[i]
    const result = await migrateOne(candidate, {
      resolveVimeoSource,
      encodeHls,
      uploadHlsBundle,
      now,
      r2Config,
      client: ctx.client,
      workdirRoot,
      ffmpegBin,
      proxyBase,
      keepWorkdir,
      stdout: ctx.stdout,
    })
    counts[result.outcome]++

    try {
      await emitTelemetry(toTelemetryEvent(result))
    } catch (e) {
      ctx.stderr.write(
        `[${candidate.datasetId}] telemetry emit failed: ${e instanceof Error ? e.message : String(e)}\n`,
      )
    }

    if (result.outcome === 'ok') {
      ctx.stdout.write(
        `[${candidate.datasetId}] vimeo:${candidate.vimeoId} → r2:${result.r2Key} ` +
          `(${result.bundleBytes} bytes, encode ${result.encodeDurationMs} ms, ` +
          `upload ${result.uploadDurationMs} ms, total ${result.durationMs} ms)\n`,
      )
    } else {
      ctx.stderr.write(
        `[${candidate.datasetId}] ${result.outcome}: ${result.errorMessage}\n`,
      )
    }

    if (!deps.skipPace && i < work.length - 1 && paceMs > 0) {
      await sleep(paceMs)
    }
  }

  ctx.stdout.write(
    `\nMigration complete:\n` +
      `  ok:                       ${counts.ok}\n` +
      `  vimeo_fetch_failed:       ${counts.vimeo_fetch_failed}\n` +
      `  encode_failed:            ${counts.encode_failed}\n` +
      `  r2_upload_failed:         ${counts.r2_upload_failed}\n` +
      `  data_ref_patch_failed:    ${counts.data_ref_patch_failed}\n`,
  )
  const failures =
    counts.vimeo_fetch_failed +
    counts.encode_failed +
    counts.r2_upload_failed +
    counts.data_ref_patch_failed
  return failures > 0 ? 1 : 0
}
