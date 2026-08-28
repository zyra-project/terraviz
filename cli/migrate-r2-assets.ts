// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `terraviz migrate-r2-assets` — migrate auxiliary asset URLs
 * (thumbnail / legend / caption / color-table) from NOAA-hosted
 * CloudFront URLs to R2-hosted URLs under `datasets/{id}/...`.
 *
 * Phase 3b commit G. The user-facing pump for the asset migration.
 * Wires together the building blocks landed in 3b/D (asset-fetch),
 * 3b/E (srt-to-vtt), and 3b/F (uploadR2Object).
 *
 * Per-row pipeline:
 *
 *   For each `--types` (default: thumbnail, legend, caption,
 *   color_table):
 *
 *     1. Read the row's `*_ref` column. If empty/null → skip
 *        (no asset of this type for this row). If it already
 *        starts with `r2:` → skip (already migrated; idempotency).
 *     2. `fetchAsset` the upstream URL into memory.
 *     3. If caption + extension is `.srt` → run the SRT → VTT
 *        converter inline. The R2 destination key gets `.vtt`,
 *        the Content-Type gets `text/vtt`. Every caption in R2
 *        ends up as VTT regardless of upstream format.
 *     4. `uploadR2Object` to `datasets/{id}/<asset>.<ext>`.
 *     5. Stage the column update (`r2:<key>`) for a single
 *        per-row PATCH at the end.
 *     6. Emit one `migration_r2_assets` telemetry event per
 *        attempted migration (one per asset, not per row).
 *
 *   Then per-row:
 *
 *     7. If any updates staged: PATCH the row with the new
 *        `*_ref` values. Each migrated asset emits its
 *        telemetry outcome AFTER the PATCH so a `patch_failed`
 *        outcome correctly tags every orphan R2 object the row
 *        produced this turn.
 *
 * Idempotency: re-running skips assets already on `r2:`. Partial
 * runs are safe — a row with thumbnail migrated but legend
 * still on NOAA picks up only the legend on resume.
 *
 * Per-asset failure handling: a `fetch_failed` on one asset does
 * NOT abandon the other three for the same row. The operator
 * sees per-asset stderr lines + a per-asset telemetry event;
 * the row's PATCH covers whatever succeeded.
 *
 * Flags:
 *   --dry-run              Print plan + estimate; no mutations.
 *   --limit=N              Cap rows migrated this run.
 *   --id=<dataset>         Single-row mode.
 *   --types=<csv>          Asset types to migrate. Default:
 *                          thumbnail,legend,caption,color_table.
 *   --pace-ms=N            Inter-row pacing. Default 200.
 *
 * R2 credentials read from process.env: R2_S3_ENDPOINT /
 * R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY (same as Phase 3
 * migrate-r2-hls).
 */

import { fetchAsset as fetchAssetLib, mimeForExtension } from './lib/asset-fetch'
import { srtBytesToVttBytes } from './lib/srt-to-vtt'
import {
  uploadR2Object as uploadR2ObjectLib,
  loadR2ConfigFromEnv,
  type R2UploadConfig,
} from './lib/r2-upload'
import {
  makeMigrationTelemetryEmitter,
  type TelemetryEventPayload,
} from './lib/migration-telemetry'
import type { CommandContext } from './commands'
import { getString, getNumber, getBool } from './lib/args'

/** Asset types the migration supports. `color_table` keeps the
 * underscore form to match the D1 column name; the destination
 * R2 key uses `color-table` for filesystem-style readability. */
export type AssetType = 'thumbnail' | 'legend' | 'caption' | 'color_table'

const DEFAULT_TYPES: readonly AssetType[] = ['thumbnail', 'legend', 'caption', 'color_table']
const DEFAULT_PACE_MS = 200
const LIST_PAGE_LIMIT = 200

/** Per-asset-type metadata: D1 column, R2 file basename, and
 * whether captions need SRT→VTT inline conversion. */
const ASSET_META: Record<AssetType, { column: string; basename: string }> = {
  thumbnail: { column: 'thumbnail_ref', basename: 'thumbnail' },
  legend: { column: 'legend_ref', basename: 'legend' },
  caption: { column: 'caption_ref', basename: 'caption' },
  color_table: { column: 'color_table_ref', basename: 'color-table' },
}

interface PublisherDatasetRow {
  id: string
  legacy_id: string | null
  title: string
  format: string
  data_ref: string
  thumbnail_ref: string | null
  legend_ref: string | null
  caption_ref: string | null
  color_table_ref: string | null
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

export type AssetOutcome =
  | 'ok'
  | 'fetch_failed'
  | 'upload_failed'
  | 'patch_failed'

export interface AssetMigrationResult {
  datasetId: string
  legacyId: string
  assetType: AssetType
  sourceUrl: string
  /** R2 key written. Empty on fetch_failed / upload_failed before
   * the PUT happened. */
  r2Key: string
  sourceBytes: number
  durationMs: number
  outcome: AssetOutcome
  errorMessage: string
}

export interface MigrateR2AssetsDeps {
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
  types: readonly AssetType[]
  stdout: CommandContext['stdout']
  stderr: CommandContext['stderr']
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Parse `--types` CSV against the AssetType vocabulary. Unknown
 * values produce an explicit error rather than a silent drop — a
 * typo like `--types=thumbnial` shouldn't pass a no-op run.
 */
export function parseAssetTypes(raw: string | undefined): readonly AssetType[] | { error: string } {
  if (!raw || raw.trim().length === 0) return DEFAULT_TYPES
  const parts = raw.split(',').map(s => s.trim()).filter(s => s.length > 0)
  const out: AssetType[] = []
  const seen = new Set<string>()
  for (const p of parts) {
    if (!(p in ASSET_META)) {
      return {
        error:
          `--types contains unknown asset type "${p}". ` +
          `Valid values: ${Object.keys(ASSET_META).join(', ')}.`,
      }
    }
    if (!seen.has(p)) {
      out.push(p as AssetType)
      seen.add(p)
    }
  }
  return out
}

/**
 * Is this *_ref value "ready to migrate"? True iff:
 *   - non-empty,
 *   - doesn't already start with `r2:` (idempotency).
 *
 * Returns false for null / empty / r2:-prefixed values.
 */
export function refNeedsMigration(value: string | null): boolean {
  if (!value) return false
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  if (trimmed.startsWith('r2:')) return false
  return true
}

/**
 * Walk the catalog and build a flat list of work units. Each work
 * unit is one (row, assetType) pair where the row's *_ref column
 * is non-empty and not yet `r2:`. Counts are used by the dry-run
 * summary; the live run iterates rows top-down and respects the
 * types filter per row.
 */
async function buildPlan(
  ctx: CommandContext,
  targetId: string | undefined,
  types: readonly AssetType[],
): Promise<{ rows: PublisherDatasetRow[]; perTypeCounts: Record<AssetType, number> } | null> {
  const perTypeCounts: Record<AssetType, number> = {
    thumbnail: 0,
    legend: 0,
    caption: 0,
    color_table: 0,
  }
  let rows: PublisherDatasetRow[]

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
    rows = [result.body.dataset]
  } else {
    rows = []
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
  }

  for (const row of rows) {
    for (const t of types) {
      const value = row[ASSET_META[t].column as keyof PublisherDatasetRow] as string | null
      if (refNeedsMigration(value)) perTypeCounts[t]++
    }
  }
  return { rows, perTypeCounts }
}

function rowHasWork(row: PublisherDatasetRow, types: readonly AssetType[]): boolean {
  for (const t of types) {
    const v = row[ASSET_META[t].column as keyof PublisherDatasetRow] as string | null
    if (refNeedsMigration(v)) return true
  }
  return false
}

function printPlanSummary(
  ctx: CommandContext,
  rows: PublisherDatasetRow[],
  perTypeCounts: Record<AssetType, number>,
  types: readonly AssetType[],
  limit: number,
): void {
  const eligibleRows = rows.filter(r => rowHasWork(r, types))
  const willRun = Math.min(eligibleRows.length, limit)
  // Recompute per-type counts against just the rows the run will
  // actually process (eligibleRows.slice(0, limit)). Without this
  // a `--limit=5` operator would still see "thumbnail: 135" in
  // the breakdown and over-estimate the run's scope. Show both
  // when --limit is in effect so the unfiltered totals stay
  // visible too — operators often want to know "how much is
  // left to do" alongside "what this run will do."
  const limited = eligibleRows.slice(0, willRun)
  const limitInForce = limit < eligibleRows.length
  const runCounts: Record<AssetType, number> = {
    thumbnail: 0,
    legend: 0,
    caption: 0,
    color_table: 0,
  }
  for (const r of limited) {
    for (const t of types) {
      const v = r[ASSET_META[t].column as keyof PublisherDatasetRow] as string | null
      if (refNeedsMigration(v)) runCounts[t]++
    }
  }
  const totalRunUploads = types.reduce((sum, t) => sum + runCounts[t], 0)
  const totalAllUploads = types.reduce((sum, t) => sum + perTypeCounts[t], 0)
  ctx.stdout.write(
    `Asset migration plan:\n` +
      `  rows scanned:                          ${rows.length}\n` +
      `  rows with at least one eligible asset: ${eligibleRows.length}` +
      `  (non-r2: *_ref values)\n` +
      `  will migrate this run:                 ${willRun}` +
      (limitInForce ? ` (capped by --limit)\n` : '\n') +
      `  total asset uploads:                   ${totalRunUploads}` +
      (limitInForce ? `  (of ${totalAllUploads} eligible across all rows)\n` : '\n') +
      `  types: ${types.join(', ')}\n`,
  )
  for (const t of types) {
    const runN = runCounts[t]
    const allN = perTypeCounts[t]
    const suffix = limitInForce ? `  (of ${allN})` : ''
    ctx.stdout.write(
      `    ${ASSET_META[t].basename.padEnd(14)} ${runN}${suffix}\n`,
    )
  }
  if (eligibleRows.length === 0) return
  const sample = eligibleRows.slice(0, Math.min(willRun, 5))
  for (const r of sample) {
    const assetSummary = types
      .filter(t =>
        refNeedsMigration(r[ASSET_META[t].column as keyof PublisherDatasetRow] as string | null),
      )
      .map(t => ASSET_META[t].basename)
      .join('+')
    ctx.stdout.write(`  • ${r.id}  ${assetSummary}  ${r.title}\n`)
  }
  if (willRun > sample.length) {
    ctx.stdout.write(`  • … + ${willRun - sample.length} more\n`)
  }
}

/**
 * Migrate one asset on one row. Returns a structured result the
 * caller (migrateOne) collects for batched PATCH + telemetry.
 * No mutations happen here other than the R2 PUT — the per-row
 * PATCH is deferred until every asset on the row has been
 * attempted.
 */
async function migrateOneAsset(
  row: PublisherDatasetRow,
  assetType: AssetType,
  sourceUrl: string,
  deps: RowDeps,
): Promise<AssetMigrationResult> {
  const start = deps.now()
  const result: AssetMigrationResult = {
    datasetId: row.id,
    legacyId: row.legacy_id ?? '',
    assetType,
    sourceUrl,
    r2Key: '',
    sourceBytes: 0,
    durationMs: 0,
    outcome: 'ok',
    errorMessage: '',
  }

  let fetched
  try {
    fetched = await deps.fetchAsset({ url: sourceUrl })
  } catch (e) {
    result.outcome = 'fetch_failed'
    result.errorMessage = e instanceof Error ? e.message : String(e)
    result.durationMs = deps.now() - start
    deps.stderr.write(
      `[${row.id}] ${assetType} fetch_failed: ${result.errorMessage}\n`,
    )
    return result
  }
  result.sourceBytes = fetched.sizeBytes

  // Inline SRT → VTT for captions whose upstream extension is
  // `.srt`. All 35 current SOS captions ship as SRT; the R2
  // destination uniformly carries `.vtt` so downstream consumers
  // don't need two paths.
  let bytes = fetched.bytes
  let ext = fetched.extension
  let contentType = fetched.contentType
  if (assetType === 'caption' && ext === 'srt') {
    bytes = srtBytesToVttBytes(fetched.bytes)
    ext = 'vtt'
    contentType = mimeForExtension('vtt')
  }
  // Fall back to a sane extension when the URL didn't carry one
  // (rare; would surface as `datasets/{id}/thumbnail.` otherwise).
  if (!ext) {
    deps.stderr.write(
      `[${row.id}] ${assetType} warning: source URL had no recognizable extension; ` +
        `defaulting to '.bin'. Source: ${sourceUrl}\n`,
    )
    ext = 'bin'
  }

  const key = `datasets/${row.id}/${ASSET_META[assetType].basename}.${ext}`
  try {
    await deps.uploadR2Object(deps.r2Config, key, bytes, contentType)
  } catch (e) {
    result.outcome = 'upload_failed'
    result.errorMessage = e instanceof Error ? e.message : String(e)
    result.durationMs = deps.now() - start
    deps.stderr.write(
      `[${row.id}] ${assetType} upload_failed: ${result.errorMessage}\n`,
    )
    return result
  }
  result.r2Key = key
  result.durationMs = deps.now() - start
  deps.stdout.write(
    `[${row.id}] ${assetType} ok (${result.sourceBytes} bytes, ${result.durationMs} ms) → ${key}\n`,
  )
  return result
}

async function migrateOne(
  row: PublisherDatasetRow,
  deps: RowDeps,
): Promise<AssetMigrationResult[]> {
  const results: AssetMigrationResult[] = []
  const updates: Record<string, string> = {}
  for (const t of deps.types) {
    const column = ASSET_META[t].column
    const currentValue = row[column as keyof PublisherDatasetRow] as string | null
    if (!refNeedsMigration(currentValue)) continue
    const r = await migrateOneAsset(row, t, currentValue!.trim(), deps)
    results.push(r)
    if (r.outcome === 'ok') updates[column] = `r2:${r.r2Key}`
  }
  if (Object.keys(updates).length === 0) return results

  // Single PATCH per row covering every asset that succeeded.
  const patched = await deps.client.updateDataset<DatasetUpdateEnvelope>(row.id, updates)
  if (!patched.ok) {
    // PATCH failed after R2 uploads succeeded — every successful
    // asset is now orphaned. Promote those results to patch_failed
    // so the operator's telemetry surface the orphans cleanly.
    const columnsAttempted = Object.keys(updates).join(', ')
    const msg =
      `${patched.status}: ${patched.error}` +
      (patched.message ? ` — ${patched.message}` : '')
    deps.stderr.write(
      `[${row.id}] asset *_ref PATCH failed (${columnsAttempted}): ${msg}\n`,
    )
    for (const r of results) {
      if (r.outcome === 'ok') {
        r.outcome = 'patch_failed'
        r.errorMessage = msg
      }
    }
  }
  return results
}

function toTelemetryEvent(r: AssetMigrationResult): TelemetryEventPayload {
  return {
    event_type: 'migration_r2_assets',
    dataset_id: r.datasetId,
    legacy_id: r.legacyId,
    asset_type: r.assetType,
    source_url: r.sourceUrl,
    r2_key: r.r2Key,
    source_bytes: r.sourceBytes,
    duration_ms: r.durationMs,
    outcome: r.outcome,
  }
}

export async function runMigrateR2Assets(
  ctx: CommandContext,
  deps: MigrateR2AssetsDeps = {},
): Promise<number> {
  const targetId = getString(ctx.args.options, 'id')
  const limitFlag = getNumber(ctx.args.options, 'limit')
  const dryRun = getBool(ctx.args.options, 'dry-run')
  const paceMs = getNumber(ctx.args.options, 'pace-ms') ?? DEFAULT_PACE_MS
  const typesFlag = getString(ctx.args.options, 'types')

  if (limitFlag !== undefined && limitFlag < 1) {
    ctx.stderr.write(`--limit must be a positive integer (got ${limitFlag}).\n`)
    return 2
  }
  if (paceMs < 0) {
    ctx.stderr.write(`--pace-ms must be non-negative (got ${paceMs}).\n`)
    return 2
  }
  const parsedTypes = parseAssetTypes(typesFlag)
  if ('error' in parsedTypes) {
    ctx.stderr.write(`${parsedTypes.error}\n`)
    return 2
  }
  const types = parsedTypes

  const fetchAsset = deps.fetchAsset ?? fetchAssetLib
  const uploadR2Object = deps.uploadR2Object ?? uploadR2ObjectLib
  const now = deps.now ?? Date.now

  const plan = await buildPlan(ctx, targetId, types)
  if (plan === null) return 1
  const eligibleRows = plan.rows.filter(r => rowHasWork(r, types))
  const limit = limitFlag ?? eligibleRows.length

  printPlanSummary(ctx, plan.rows, plan.perTypeCounts, types, limit)

  if (dryRun) {
    ctx.stdout.write(
      '\nDry run — no rows will be migrated. Re-run without --dry-run to apply.\n',
    )
    return 0
  }
  if (eligibleRows.length === 0) {
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

  let emitTelemetry: NonNullable<MigrateR2AssetsDeps['emitTelemetry']>
  if (deps.emitTelemetry) {
    emitTelemetry = deps.emitTelemetry
  } else {
    const emitter = makeMigrationTelemetryEmitter({ serverUrl: ctx.client.serverUrl })
    ctx.stdout.write(`Telemetry session id: ${emitter.sessionId}\n`)
    emitTelemetry = event => emitter.emit(event)
  }

  const work = eligibleRows.slice(0, limit)
  const counts: Record<AssetOutcome, number> = {
    ok: 0,
    fetch_failed: 0,
    upload_failed: 0,
    patch_failed: 0,
  }
  for (let i = 0; i < work.length; i++) {
    const row = work[i]
    const results = await migrateOne(row, {
      fetchAsset,
      uploadR2Object,
      now,
      r2Config,
      client: ctx.client,
      types,
      stdout: ctx.stdout,
      stderr: ctx.stderr,
    })
    for (const r of results) {
      counts[r.outcome]++
      try {
        await emitTelemetry(toTelemetryEvent(r))
      } catch (e) {
        ctx.stderr.write(
          `[${row.id}] ${r.assetType} telemetry emit failed: ${e instanceof Error ? e.message : String(e)}\n`,
        )
      }
    }
    if (!deps.skipPace && i < work.length - 1 && paceMs > 0) {
      await sleep(paceMs)
    }
  }

  ctx.stdout.write(
    `\nAsset migration complete:\n` +
      `  ok:                       ${counts.ok}\n` +
      `  fetch_failed:             ${counts.fetch_failed}\n` +
      `  upload_failed:            ${counts.upload_failed}\n` +
      `  patch_failed:             ${counts.patch_failed}\n`,
  )
  const failures = counts.fetch_failed + counts.upload_failed + counts.patch_failed
  return failures > 0 ? 1 : 0
}
