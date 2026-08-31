// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `terraviz migrate-r2-tours` — migrate SOS tour.json files
 * (and their sibling assets: overlay images, narrated audio,
 * 360-pano JPGs) from NOAA-hosted CloudFront URLs to R2-hosted
 * URLs under `tours/{id}/...`.
 *
 * Phase 3c commit B. The user-facing pump for the tour migration.
 * Wires together the parser landed in 3c/A and the building
 * blocks from 3b (asset-fetch, r2-upload, migration-telemetry).
 *
 * Per-row pipeline (atomic — all-or-nothing):
 *
 *   1. Read the row's `run_tour_on_load`. If empty/null → skip
 *      (row has no tour). If it already starts with `r2:` →
 *      skip (idempotency).
 *   2. Fetch the tour.json bytes from NOAA.
 *      - 404 → `dead_source`. Don't PATCH; the row was already
 *        broken pre-migration (e.g. INTERNAL_SOS_726_ONLINE).
 *      - Any other fetch error → `fetch_failed`. Don't PATCH.
 *   3. Parse the tour.json. If it doesn't decode as JSON or has
 *      no `tourTasks` → `parse_failed`.
 *   4. Walk the parser's `assets` list. For each `relative`
 *      entry: resolve the sibling URL against the tour.json URL,
 *      fetch the bytes. Dedupe by sibling-key so a tour
 *      referencing the same audio.mp3 from multiple tasks pays
 *      one fetch. External / absolute_sos_cdn assets are left
 *      verbatim — policy 1, see 3c/A.
 *      - Any sibling fetch failure → `sibling_fetch_failed`.
 *        Atomic per-row: if one sibling 404s, the tour.json
 *        upload is skipped too. Operator gets the failing URL
 *        in the error message.
 *   5. Upload tour.json + every sibling to R2 under
 *      `tours/{id}/...`. Tour.json uploads as
 *      `application/json`; siblings inherit the content-type
 *      `fetchAsset` resolved.
 *      - Any upload error → `upload_failed`. The partial
 *        uploads are R2 orphans; the row still works via NOAA
 *        because we don't PATCH.
 *   6. PATCH the row: `run_tour_on_load = r2:tours/{id}/tour.json`.
 *      - PATCH error after uploads → `patch_failed`. Worst-case:
 *        every R2 object the run produced this row is an orphan
 *        and the row still points at NOAA. Recovery is to
 *        re-run; idempotent if the next attempt's tour.json
 *        bytes match (they will — same NOAA source).
 *   7. Emit one `migration_r2_tours` telemetry event per row,
 *      tagging the outcome and rolled-up sibling counts.
 *
 * Why per-row atomic (vs Phase 3b's per-asset)? A tour is a
 * single addressable resource — the SPA loads tour.json and
 * follows the sibling paths verbatim. If we upload tour.json
 * but not its sibling audio.mp3, every playback of the tour
 * 404s at runtime. By contrast, an auxiliary asset (thumbnail
 * vs caption vs legend) is independently consumable; a partial
 * 3b row degrades gracefully.
 *
 * Flags:
 *   --dry-run              Print plan + estimate; no mutations.
 *   --limit=N              Cap rows migrated this run.
 *   --id=<dataset>         Single-row mode.
 *   --pace-ms=N            Inter-row pacing. Default 200.
 *
 * R2 credentials read from process.env: R2_S3_ENDPOINT /
 * R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY (same as Phase 3
 * migrate-r2-hls / Phase 3b migrate-r2-assets).
 */

import {
  fetchAsset as fetchAssetLib,
  AssetFetchError,
  type FetchedAsset,
} from './lib/asset-fetch'
import {
  uploadR2Object as uploadR2ObjectLib,
  loadR2ConfigFromEnv,
  type R2UploadConfig,
} from './lib/r2-upload'
import {
  makeMigrationTelemetryEmitter,
  type TelemetryEventPayload,
} from './lib/migration-telemetry'
import {
  parseTourFile,
  siblingKeyForRelativeAsset,
  type DiscoveredAsset,
} from './lib/tour-json-parser'
import type { CommandContext } from './commands'
import { getString, getNumber, getBool } from './lib/args'

const DEFAULT_PACE_MS = 200
const LIST_PAGE_LIMIT = 200
/** Cap the in-memory size of a single tour.json. Production
 * tours are tiny (<10 KB; the largest in the 3c/A sweep was
 * INTERNAL_SOS_687 at ~30 KB). 1 MiB is the per-row ceiling. */
const TOUR_JSON_MAX_BYTES = 1024 * 1024
/** Cap the in-memory size of a single sibling. The 3c/A sweep
 * surfaced narrated-audio mp3 siblings up to ~5 MiB; 50 MiB
 * (asset-fetch's default) is a comfortable headroom for the
 * occasional larger overlay image without OOM risk. */
const SIBLING_MAX_BYTES = 50 * 1024 * 1024

interface PublisherDatasetRow {
  id: string
  legacy_id: string | null
  title: string
  run_tour_on_load: string | null
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

export type TourOutcome =
  | 'ok'
  | 'dead_source'
  | 'fetch_failed'
  | 'parse_failed'
  | 'sibling_fetch_failed'
  | 'upload_failed'
  | 'patch_failed'

export interface TourMigrationResult {
  datasetId: string
  legacyId: string
  sourceUrl: string
  /** R2 key written for the tour.json — empty when we didn't
   * get that far (any failure before the final tour.json PUT). */
  r2Key: string
  /** Total bytes fetched from NOAA across tour.json + every
   * sibling actually fetched. Includes siblings even on a
   * sibling_fetch_failed outcome (count up to the failure). */
  sourceBytes: number
  /** Counts by classification — used for telemetry + operator
   * progress lines. */
  siblingsRelative: number
  siblingsExternal: number
  siblingsSosCdn: number
  /** Number of unique sibling-keys successfully fetched +
   * uploaded. Equal to `siblingsRelative` for an `ok` row
   * (modulo dedupe); less on partial / failed rows. */
  siblingsMigrated: number
  durationMs: number
  outcome: TourOutcome
  errorMessage: string
}

export interface MigrateR2ToursDeps {
  fetchAsset?: typeof fetchAssetLib
  uploadR2Object?: typeof uploadR2ObjectLib
  /** Telemetry sink. Defaults to the real emitter posting to
   * `<server>/api/ingest`. Tests pass a recorder. */
  emitTelemetry?: (event: TelemetryEventPayload) => void | Promise<void>
  now?: () => number
  r2Config?: R2UploadConfig
  /** Skip the inter-row pacing wait (used by tests). */
  skipPace?: boolean
}

interface RowDeps {
  fetchAsset: typeof fetchAssetLib
  uploadR2Object: typeof uploadR2ObjectLib
  now: () => number
  r2Config: R2UploadConfig
  client: CommandContext['client']
  stdout: CommandContext['stdout']
  stderr: CommandContext['stderr']
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Is this `run_tour_on_load` value "ready to migrate"? True iff:
 *   - non-empty,
 *   - doesn't already start with `r2:` (idempotency).
 *
 * Returns false for null / empty / r2:-prefixed values.
 */
export function tourRefNeedsMigration(value: string | null): boolean {
  if (!value) return false
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  if (trimmed.startsWith('r2:')) return false
  return true
}

/**
 * Walk the catalog and build the work-list. Each entry is one
 * publisher row whose `run_tour_on_load` is non-empty and not
 * yet `r2:`. The dry-run summary uses this list as-is; the live
 * run iterates top-down respecting `--limit`.
 */
async function buildPlan(
  ctx: CommandContext,
  targetId: string | undefined,
): Promise<PublisherDatasetRow[] | null> {
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
    return [result.body.dataset]
  }
  const rows: PublisherDatasetRow[] = []
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
    rows.push(...result.body.datasets)
    cursor = result.body.next_cursor ?? undefined
  } while (cursor)
  return rows
}

function printPlanSummary(
  ctx: CommandContext,
  allRows: PublisherDatasetRow[],
  eligible: PublisherDatasetRow[],
  limit: number,
): void {
  const willRun = Math.min(eligible.length, limit)
  const withTour = allRows.filter(r => r.run_tour_on_load && r.run_tour_on_load.trim().length > 0)
  const alreadyR2 = withTour.filter(r => r.run_tour_on_load!.trim().startsWith('r2:'))
  const limitInForce = limit < eligible.length
  ctx.stdout.write(
    `Tour migration plan:\n` +
      `  rows scanned:                          ${allRows.length}\n` +
      `  rows with run_tour_on_load:            ${withTour.length}\n` +
      `  already on r2: (will skip):            ${alreadyR2.length}\n` +
      `  eligible (NOAA / external URLs):       ${eligible.length}\n` +
      `  will migrate this run:                 ${willRun}` +
      (limitInForce ? ` (capped by --limit)\n` : '\n'),
  )
  if (eligible.length === 0) return
  const sample = eligible.slice(0, Math.min(willRun, 5))
  for (const r of sample) {
    ctx.stdout.write(`  • ${r.id}  ${r.title}\n`)
    ctx.stdout.write(`      ${r.run_tour_on_load}\n`)
  }
  if (willRun > sample.length) {
    ctx.stdout.write(`  • … + ${willRun - sample.length} more\n`)
  }
}

/**
 * Resolve a sibling reference against the tour.json URL. The SPA
 * uses `new URL(filename, tourBaseUrl).toString()` at runtime;
 * we replicate that here so the URL we fetch from NOAA is
 * exactly the one the SPA would have asked for. The base URL
 * IS the tour.json URL — `new URL(s, base)` replaces the base's
 * filename component when `s` is a sibling-relative path.
 */
function resolveSiblingUrl(tourJsonUrl: string, rawValue: string): string {
  return new URL(rawValue, tourJsonUrl).toString()
}

/**
 * Migrate one row. Implements the all-or-nothing pipeline from
 * the file header. Returns a structured result the caller emits
 * as one telemetry event.
 */
async function migrateOne(
  row: PublisherDatasetRow,
  deps: RowDeps,
): Promise<TourMigrationResult> {
  const start = deps.now()
  const sourceUrl = row.run_tour_on_load!.trim()
  const result: TourMigrationResult = {
    datasetId: row.id,
    legacyId: row.legacy_id ?? '',
    sourceUrl,
    r2Key: '',
    sourceBytes: 0,
    siblingsRelative: 0,
    siblingsExternal: 0,
    siblingsSosCdn: 0,
    siblingsMigrated: 0,
    durationMs: 0,
    outcome: 'ok',
    errorMessage: '',
  }

  // (1) Fetch tour.json bytes.
  let tourJson: FetchedAsset
  try {
    tourJson = await deps.fetchAsset({ url: sourceUrl, maxBytes: TOUR_JSON_MAX_BYTES })
  } catch (e) {
    if (e instanceof AssetFetchError && e.status === 404) {
      result.outcome = 'dead_source'
    } else {
      result.outcome = 'fetch_failed'
    }
    result.errorMessage = e instanceof Error ? e.message : String(e)
    result.durationMs = deps.now() - start
    deps.stderr.write(
      `[${row.id}] tour.json ${result.outcome}: ${result.errorMessage}\n`,
    )
    return result
  }
  result.sourceBytes += tourJson.sizeBytes

  // (2) Parse tour.json.
  let parsed: unknown
  try {
    const text = new TextDecoder('utf-8').decode(tourJson.bytes)
    parsed = JSON.parse(text)
  } catch (e) {
    result.outcome = 'parse_failed'
    result.errorMessage = e instanceof Error ? e.message : String(e)
    result.durationMs = deps.now() - start
    deps.stderr.write(`[${row.id}] tour.json parse_failed: ${result.errorMessage}\n`)
    return result
  }
  // Shape check: the bytes parsed as JSON but if there's no
  // `tourTasks` array the file isn't a valid SOS tour file —
  // migrating it would just relocate broken bytes (the SPA's
  // tour engine bails on this same shape). Treat like
  // `dead_source`: the row was effectively broken pre-migration;
  // we don't make it worse, but we don't waste R2 bytes on it
  // either. Same outcome enum as a JSON-decode failure since
  // both are "bytes don't represent a usable tour."
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { tourTasks?: unknown }).tourTasks)
  ) {
    result.outcome = 'parse_failed'
    result.errorMessage =
      'tour.json has no `tourTasks` array — not a valid SOS tour file.'
    result.durationMs = deps.now() - start
    deps.stderr.write(`[${row.id}] tour.json parse_failed: ${result.errorMessage}\n`)
    return result
  }
  const parseResult = parseTourFile(parsed)

  // Tally classification counts (used for telemetry).
  for (const a of parseResult.assets) {
    if (a.kind === 'relative') result.siblingsRelative++
    else if (a.kind === 'absolute_external') result.siblingsExternal++
    else if (a.kind === 'absolute_sos_cdn') result.siblingsSosCdn++
  }

  // (3) Dedupe relative siblings by their sibling-key. A tour
  // can reference the same file from multiple tasks (e.g.
  // showImage + later hideImage both naming `overlays/title.png`);
  // we only need one fetch + one PUT.
  const uniqueSiblings = new Map<string, DiscoveredAsset>()
  for (const a of parseResult.assets) {
    if (a.kind !== 'relative') continue
    const key = siblingKeyForRelativeAsset(a.rawValue)
    if (!key) {
      // `..` traversal or empty — siblingKeyForRelativeAsset
      // refused. We classify the row as sibling_fetch_failed
      // because the asset is genuinely unreachable from a
      // sibling-rooted R2 key, and a partial upload would lie.
      result.outcome = 'sibling_fetch_failed'
      result.errorMessage =
        `relative asset "${a.rawValue}" can't be turned into a safe sibling key ` +
        `(path traversal or empty). taskIndex=${a.source.taskIndex} ` +
        `taskName=${a.source.taskName} field=${a.source.field}.`
      result.durationMs = deps.now() - start
      deps.stderr.write(`[${row.id}] ${result.outcome}: ${result.errorMessage}\n`)
      return result
    }
    if (!uniqueSiblings.has(key)) uniqueSiblings.set(key, a)
  }

  // (4) Fetch every unique sibling.
  const siblingBytes = new Map<string, FetchedAsset>()
  for (const [key, asset] of uniqueSiblings) {
    const siblingUrl = resolveSiblingUrl(sourceUrl, asset.rawValue)
    try {
      const fetched = await deps.fetchAsset({ url: siblingUrl, maxBytes: SIBLING_MAX_BYTES })
      siblingBytes.set(key, fetched)
      result.sourceBytes += fetched.sizeBytes
    } catch (e) {
      result.outcome = 'sibling_fetch_failed'
      result.errorMessage =
        `sibling "${key}" fetch failed (resolved URL: ${siblingUrl}): ` +
        (e instanceof Error ? e.message : String(e))
      result.durationMs = deps.now() - start
      deps.stderr.write(`[${row.id}] ${result.outcome}: ${result.errorMessage}\n`)
      return result
    }
  }

  // (5) Upload tour.json + every sibling to R2. Tour.json first
  // so a mid-flight upload failure leaves the row pointing at
  // NOAA without a "tour.json on R2 but siblings missing" hazard.
  const tourKey = `tours/${row.id}/tour.json`
  try {
    await deps.uploadR2Object(deps.r2Config, tourKey, tourJson.bytes, 'application/json')
  } catch (e) {
    result.outcome = 'upload_failed'
    result.errorMessage =
      `tour.json upload failed (${tourKey}): ` + (e instanceof Error ? e.message : String(e))
    result.durationMs = deps.now() - start
    deps.stderr.write(`[${row.id}] ${result.outcome}: ${result.errorMessage}\n`)
    return result
  }
  result.r2Key = tourKey

  for (const [key, fetched] of siblingBytes) {
    const siblingKey = `tours/${row.id}/${key}`
    try {
      await deps.uploadR2Object(deps.r2Config, siblingKey, fetched.bytes, fetched.contentType)
      result.siblingsMigrated++
    } catch (e) {
      result.outcome = 'upload_failed'
      result.errorMessage =
        `sibling upload failed (${siblingKey}): ` +
        (e instanceof Error ? e.message : String(e))
      result.durationMs = deps.now() - start
      deps.stderr.write(`[${row.id}] ${result.outcome}: ${result.errorMessage}\n`)
      return result
    }
  }

  // (6) PATCH the row.
  const patched = await deps.client.updateDataset<DatasetUpdateEnvelope>(row.id, {
    run_tour_on_load: `r2:${tourKey}`,
  })
  if (!patched.ok) {
    result.outcome = 'patch_failed'
    result.errorMessage =
      `${patched.status}: ${patched.error}` +
      (patched.message ? ` — ${patched.message}` : '')
    result.durationMs = deps.now() - start
    deps.stderr.write(
      `[${row.id}] run_tour_on_load PATCH failed: ${result.errorMessage}\n`,
    )
    return result
  }

  result.durationMs = deps.now() - start
  deps.stdout.write(
    `[${row.id}] ok ` +
      `(tour.json + ${result.siblingsMigrated} sibling${result.siblingsMigrated === 1 ? '' : 's'}, ` +
      `${result.sourceBytes} bytes, ${result.durationMs} ms) → ${tourKey}\n`,
  )
  return result
}

function toTelemetryEvent(r: TourMigrationResult): TelemetryEventPayload {
  return {
    event_type: 'migration_r2_tours',
    dataset_id: r.datasetId,
    legacy_id: r.legacyId,
    source_url: r.sourceUrl,
    r2_key: r.r2Key,
    source_bytes: r.sourceBytes,
    siblings_relative: r.siblingsRelative,
    siblings_external: r.siblingsExternal,
    siblings_sos_cdn: r.siblingsSosCdn,
    siblings_migrated: r.siblingsMigrated,
    duration_ms: r.durationMs,
    outcome: r.outcome,
  }
}

export async function runMigrateR2Tours(
  ctx: CommandContext,
  deps: MigrateR2ToursDeps = {},
): Promise<number> {
  const targetId = getString(ctx.args.options, 'id')
  const limitFlag = getNumber(ctx.args.options, 'limit')
  const dryRun = getBool(ctx.args.options, 'dry-run')
  const paceMs = getNumber(ctx.args.options, 'pace-ms') ?? DEFAULT_PACE_MS

  if (limitFlag !== undefined && limitFlag < 1) {
    ctx.stderr.write(`--limit must be a positive integer (got ${limitFlag}).\n`)
    return 2
  }
  if (paceMs < 0) {
    ctx.stderr.write(`--pace-ms must be non-negative (got ${paceMs}).\n`)
    return 2
  }

  const fetchAsset = deps.fetchAsset ?? fetchAssetLib
  const uploadR2Object = deps.uploadR2Object ?? uploadR2ObjectLib
  const now = deps.now ?? Date.now

  const allRows = await buildPlan(ctx, targetId)
  if (allRows === null) return 1
  const eligible = allRows.filter(r => tourRefNeedsMigration(r.run_tour_on_load))
  const limit = limitFlag ?? eligible.length

  printPlanSummary(ctx, allRows, eligible, limit)

  if (dryRun) {
    ctx.stdout.write(
      '\nDry run — no rows will be migrated. Re-run without --dry-run to apply.\n',
    )
    return 0
  }
  if (eligible.length === 0) {
    ctx.stdout.write('\nNothing to migrate.\n')
    return 0
  }

  const r2Config = deps.r2Config ?? loadR2ConfigFromEnv()
  if (!r2Config.endpoint || !r2Config.accessKeyId || !r2Config.secretAccessKey) {
    ctx.stderr.write(
      'R2_S3_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY must all be set in the environment.\n',
    )
    return 2
  }

  let emitTelemetry: NonNullable<MigrateR2ToursDeps['emitTelemetry']>
  if (deps.emitTelemetry) {
    emitTelemetry = deps.emitTelemetry
  } else {
    const emitter = makeMigrationTelemetryEmitter({ serverUrl: ctx.client.serverUrl })
    ctx.stdout.write(`Telemetry session id: ${emitter.sessionId}\n`)
    emitTelemetry = event => emitter.emit(event)
  }

  const work = eligible.slice(0, limit)
  const counts: Record<TourOutcome, number> = {
    ok: 0,
    dead_source: 0,
    fetch_failed: 0,
    parse_failed: 0,
    sibling_fetch_failed: 0,
    upload_failed: 0,
    patch_failed: 0,
  }
  for (let i = 0; i < work.length; i++) {
    const row = work[i]
    const r = await migrateOne(row, {
      fetchAsset,
      uploadR2Object,
      now,
      r2Config,
      client: ctx.client,
      stdout: ctx.stdout,
      stderr: ctx.stderr,
    })
    counts[r.outcome]++
    try {
      await emitTelemetry(toTelemetryEvent(r))
    } catch (e) {
      ctx.stderr.write(
        `[${row.id}] telemetry emit failed: ${e instanceof Error ? e.message : String(e)}\n`,
      )
    }
    if (!deps.skipPace && i < work.length - 1 && paceMs > 0) {
      await sleep(paceMs)
    }
  }

  ctx.stdout.write(
    `\nTour migration complete:\n` +
      `  ok:                       ${counts.ok}\n` +
      `  dead_source (NOAA 404):   ${counts.dead_source}\n` +
      `  fetch_failed:             ${counts.fetch_failed}\n` +
      `  parse_failed:             ${counts.parse_failed}\n` +
      `  sibling_fetch_failed:     ${counts.sibling_fetch_failed}\n` +
      `  upload_failed:            ${counts.upload_failed}\n` +
      `  patch_failed:             ${counts.patch_failed}\n`,
  )
  // dead_source is intentionally NOT counted as a failure — the
  // row was already broken pre-migration, the operator was warned
  // by the planner row, and the migration leaving it untouched is
  // the correct outcome. Exit non-zero only on true failures.
  const failures =
    counts.fetch_failed +
    counts.parse_failed +
    counts.sibling_fetch_failed +
    counts.upload_failed +
    counts.patch_failed
  return failures > 0 ? 1 : 0
}
