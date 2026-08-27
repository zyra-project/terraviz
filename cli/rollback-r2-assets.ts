// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `terraviz rollback-r2-assets` — undo migrated auxiliary assets.
 *
 * Phase 3b commit I. The symmetric inverse of `migrate-r2-assets`
 * (3b/G): flip a row's `<asset>_ref` column from `r2:<key>` back
 * to the original NOAA-hosted URL, then delete the R2 object.
 *
 * Two invocation shapes:
 *
 *   - **Single row.** `terraviz rollback-r2-assets <dataset_id>
 *     [--types=t1,t2,...]`. Rolls back the listed asset types
 *     on one row. Defaults to all 4 types when --types is
 *     omitted; only asset columns currently on `r2:` are
 *     touched (idempotent).
 *
 *   - **Bulk stdin.** `... | rollback-r2-assets --from-stdin`.
 *     Reads NDJSON, one `{ dataset_id, asset_type }` per line.
 *     Designed so operators can pipe a filtered subset of the
 *     `migration_r2_assets` Grafana telemetry into the rollback.
 *
 * Per-asset pipeline (identical in both modes):
 *
 *   1. Read the row's `<asset>_ref`. If it doesn't start with
 *      `r2:` → `wrong_scheme` (caller error, nothing to roll
 *      back).
 *   2. Recover the original upstream URL by looking up the
 *      row's `legacy_id` in the SOS snapshot at
 *      `public/assets/sos-dataset-list.json` and reading the
 *      matching link field (`thumbnailLink` / `legendLink` /
 *      `closedCaptionLink` / `colorTableLink`). If the lookup
 *      fails → `not_in_snapshot`; operator can fall back to
 *      passing `--to-url=<url>` for surgical recovery.
 *   3. PATCH `<asset>_ref` back to the original URL. **Commit
 *      point.**
 *   4. Delete the R2 object under the prior key (cleanup;
 *      non-fatal — orphans the R2 object on failure but the
 *      catalog is correct).
 *
 * Why explicit `--to-url`? The snapshot is the canonical source
 * for SOS-imported rows, but a publisher-portal row that the
 * 3b/G pump migrated wouldn't have a corresponding snapshot
 * entry. The `--to-url` escape hatch lets the operator name
 * the target explicitly, same way `rollback-r2-hls --to-vimeo`
 * stays deploy-agnostic for non-SOS catalogs.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  deleteR2Object as deleteR2ObjectLib,
  loadR2ConfigFromEnv,
  type R2UploadConfig,
} from './lib/r2-upload'
import type { CommandContext } from './commands'
import { getBool, getString } from './lib/args'

/** Asset types this CLI knows how to roll back. Same vocabulary
 * as the migration pump (3b/G); see `cli/migrate-r2-assets.ts`. */
export type AssetType = 'thumbnail' | 'legend' | 'caption' | 'color_table'

const DEFAULT_TYPES: readonly AssetType[] = ['thumbnail', 'legend', 'caption', 'color_table']
const DEFAULT_SNAPSHOT_PATH = 'public/assets/sos-dataset-list.json'

/** Per-asset-type metadata: the D1 column and the SOS-snapshot
 * field that holds the original upstream URL. */
const ASSET_META: Record<
  AssetType,
  { column: string; snapshotField: 'thumbnailLink' | 'legendLink' | 'closedCaptionLink' | 'colorTableLink' }
> = {
  thumbnail: { column: 'thumbnail_ref', snapshotField: 'thumbnailLink' },
  legend: { column: 'legend_ref', snapshotField: 'legendLink' },
  caption: { column: 'caption_ref', snapshotField: 'closedCaptionLink' },
  color_table: { column: 'color_table_ref', snapshotField: 'colorTableLink' },
}

interface DatasetRow {
  id: string
  legacy_id: string | null
  title?: string
  thumbnail_ref: string | null
  legend_ref: string | null
  caption_ref: string | null
  color_table_ref: string | null
}

interface DatasetGetEnvelope {
  dataset: DatasetRow
}

interface DatasetUpdateEnvelope {
  dataset: { id: string; slug: string }
}

interface SnapshotEntry {
  id: string
  thumbnailLink?: string
  legendLink?: string
  closedCaptionLink?: string
  colorTableLink?: string
}

export type RollbackOutcome =
  | 'ok'
  | 'get_failed'
  | 'wrong_scheme'
  | 'not_in_snapshot'
  | 'patch_failed'
  | 'delete_failed' // PATCH committed; orphan R2 object remains

export interface RollbackResult {
  datasetId: string
  assetType: AssetType
  /** R2 key that was rolled back (or attempted). Empty on
   * `get_failed` / `wrong_scheme` / `not_in_snapshot`. */
  r2Key: string
  /** Recovered upstream URL (the new `<asset>_ref` value after
   * PATCH). Empty when the rollback didn't reach PATCH. */
  toUrl: string
  outcome: RollbackOutcome
  errorMessage: string
}

export interface RollbackR2AssetsDeps {
  /** DI for the R2 single-object delete helper. */
  deleteR2Object?: typeof deleteR2ObjectLib
  r2Config?: R2UploadConfig
  /** Test injection — defaults to reading process.stdin to EOF. */
  readStdin?: () => Promise<string>
  /** Test injection — defaults to reading the snapshot file. */
  loadSnapshot?: () => SnapshotEntry[] | Promise<SnapshotEntry[]>
}

function parseAssetTypes(raw: string | undefined): readonly AssetType[] | { error: string } {
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

function defaultLoadSnapshot(path: string): SnapshotEntry[] {
  const raw = readFileSync(path, 'utf-8')
  const parsed = JSON.parse(raw) as unknown
  if (Array.isArray(parsed)) return parsed as SnapshotEntry[]
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { datasets?: unknown }).datasets)) {
    return (parsed as { datasets: SnapshotEntry[] }).datasets
  }
  throw new Error(
    `Snapshot at ${path} must be either a JSON array or ` +
      `an object with a top-level \`datasets\` array (got ` +
      `${parsed === null ? 'null' : typeof parsed}).`,
  )
}

/**
 * Roll back a single (row, assetType) pair. Pure per-asset
 * helper used by both single-row and bulk-stdin paths.
 */
async function rollbackOneAsset(
  ctx: CommandContext,
  datasetId: string,
  assetType: AssetType,
  snapshotIndex: Map<string, SnapshotEntry>,
  dryRun: boolean,
  r2Config: R2UploadConfig,
  deleteR2: typeof deleteR2ObjectLib,
  toUrlOverride: string | undefined,
): Promise<RollbackResult> {
  const result: RollbackResult = {
    datasetId,
    assetType,
    r2Key: '',
    toUrl: '',
    outcome: 'ok',
    errorMessage: '',
  }
  const column = ASSET_META[assetType].column

  // Stage 0 — fetch current state.
  const got = await ctx.client.get<DatasetGetEnvelope>(datasetId)
  if (!got.ok) {
    const msg =
      `Could not GET ${datasetId} (${got.status}): ${got.error}` +
      (got.message ? ` — ${got.message}` : '')
    ctx.stderr.write(`[${datasetId}] ${assetType} ${msg}\n`)
    result.outcome = 'get_failed'
    result.errorMessage = msg
    return result
  }
  const row = got.body.dataset
  const currentRef = (row[column as keyof DatasetRow] as string | null) ?? ''
  if (!currentRef.startsWith('r2:')) {
    const msg = `${column} is "${currentRef}", not r2:. Nothing to roll back.`
    ctx.stderr.write(`[${datasetId}] ${assetType} ${msg}\n`)
    result.outcome = 'wrong_scheme'
    result.errorMessage = msg
    return result
  }
  result.r2Key = currentRef.slice('r2:'.length).trim()

  // Stage 1 — recover the original URL.
  let toUrl = toUrlOverride
  if (!toUrl) {
    const legacyId = row.legacy_id ?? ''
    const snap = legacyId ? snapshotIndex.get(legacyId) : undefined
    const candidate = snap?.[ASSET_META[assetType].snapshotField]
    if (!candidate) {
      const msg =
        `cannot recover ${assetType} URL — ` +
        (legacyId ? `legacy_id ${legacyId} has no ${ASSET_META[assetType].snapshotField}` : 'row has no legacy_id') +
        '. Pass --to-url=<url> to roll back to an explicit target.'
      ctx.stderr.write(`[${datasetId}] ${assetType} ${msg}\n`)
      result.outcome = 'not_in_snapshot'
      result.errorMessage = msg
      return result
    }
    toUrl = candidate
  }
  result.toUrl = toUrl

  ctx.stdout.write(
    `[${datasetId}] ${assetType} rollback plan: r2:${result.r2Key} → ${toUrl}\n`,
  )
  if (dryRun) return result

  // Stage 2 — PATCH back to the original URL. Commit point.
  const patched = await ctx.client.updateDataset<DatasetUpdateEnvelope>(datasetId, {
    [column]: toUrl,
  })
  if (!patched.ok) {
    const msg =
      `${column} PATCH failed (${patched.status}): ${patched.error}` +
      (patched.message ? ` — ${patched.message}` : '')
    ctx.stderr.write(`[${datasetId}] ${assetType} ${msg}\n`)
    result.outcome = 'patch_failed'
    result.errorMessage = msg
    return result
  }
  ctx.stdout.write(`[${datasetId}] ${assetType} ✓ ${column} → ${toUrl}\n`)

  // Stage 3 — delete the R2 object (cleanup; non-fatal).
  if (!r2Config.endpoint || !r2Config.accessKeyId || !r2Config.secretAccessKey) {
    const msg = `R2 credentials unset — leaving orphan ${result.r2Key} in R2.`
    ctx.stderr.write(
      `[${datasetId}] ${assetType} ! ${msg}\n` +
        `  ${column} is correctly back on the original URL; delete the orphan via the Cloudflare dashboard if needed.\n`,
    )
    result.outcome = 'delete_failed'
    result.errorMessage = msg
    return result
  }
  try {
    await deleteR2(r2Config, result.r2Key)
    ctx.stdout.write(`[${datasetId}] ${assetType} ✓ deleted R2 object ${result.r2Key}\n`)
  } catch (e) {
    const msg = `R2 DELETE failed: ${e instanceof Error ? e.message : String(e)}`
    ctx.stderr.write(
      `[${datasetId}] ${assetType} ! ${msg}\n` +
        `  ${column} is already back on the original URL; delete the orphan via the Cloudflare dashboard.\n`,
    )
    result.outcome = 'delete_failed'
    result.errorMessage = msg
  }
  return result
}

async function defaultReadStdin(): Promise<string> {
  process.stdin.setEncoding('utf-8')
  const chunks: string[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as string)
  }
  return chunks.join('')
}

interface StdinRow {
  dataset_id: string
  asset_type: AssetType
}

function parseStdinRow(line: string): StdinRow | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (e) {
    return `not valid JSON: ${e instanceof Error ? e.message : String(e)}`
  }
  if (!parsed || typeof parsed !== 'object') return 'not a JSON object'
  const obj = parsed as Record<string, unknown>
  const datasetId = obj.dataset_id
  const assetType = obj.asset_type
  if (typeof datasetId !== 'string' || datasetId.length === 0) {
    return 'missing or empty dataset_id'
  }
  if (typeof assetType !== 'string' || !(assetType in ASSET_META)) {
    return `missing or invalid asset_type (got ${JSON.stringify(assetType)}); ` +
      `expected one of ${Object.keys(ASSET_META).join(', ')}`
  }
  return { dataset_id: datasetId, asset_type: assetType as AssetType }
}

export async function runRollbackR2Assets(
  ctx: CommandContext,
  deps: RollbackR2AssetsDeps = {},
): Promise<number> {
  const fromStdin = getBool(ctx.args.options, 'from-stdin')
  const dryRun = getBool(ctx.args.options, 'dry-run')
  const typesFlag = getString(ctx.args.options, 'types')
  const toUrl = getString(ctx.args.options, 'to-url')
  const snapshotPath =
    getString(ctx.args.options, 'snapshot') ?? join(process.cwd(), DEFAULT_SNAPSHOT_PATH)

  const r2Config = deps.r2Config ?? loadR2ConfigFromEnv()
  const deleteR2 = deps.deleteR2Object ?? deleteR2ObjectLib

  // Load the snapshot once — both single-row and bulk modes
  // need the legacy_id → URL index. --to-url override skips
  // the snapshot lookup, but we still load (cheap) so an
  // operator with both --to-url AND a missing/broken snapshot
  // file doesn't get confused.
  let snapshotIndex: Map<string, SnapshotEntry>
  try {
    const entries = await (deps.loadSnapshot ?? (() => defaultLoadSnapshot(snapshotPath)))()
    snapshotIndex = new Map<string, SnapshotEntry>()
    for (const e of entries) {
      if (e && typeof e.id === 'string') snapshotIndex.set(e.id, e)
    }
  } catch (e) {
    if (!toUrl) {
      ctx.stderr.write(
        `Could not load SOS snapshot at ${snapshotPath}: ${e instanceof Error ? e.message : String(e)}\n` +
          `Use --snapshot=<path> to override, or pass --to-url=<url> for surgical rollback without a snapshot.\n`,
      )
      return 1
    }
    snapshotIndex = new Map()
  }

  if (fromStdin) {
    // Bulk path.
    if (ctx.args.positional.length > 0) {
      ctx.stderr.write(
        '--from-stdin does not accept a positional dataset id; ' +
          'each row\'s id comes from the NDJSON `dataset_id` field.\n',
      )
      return 2
    }
    if (typesFlag) {
      ctx.stderr.write(
        '--from-stdin does not accept --types; ' +
          'each row\'s asset_type comes from the NDJSON `asset_type` field.\n',
      )
      return 2
    }
    if (toUrl) {
      ctx.stderr.write(
        '--from-stdin does not accept --to-url; the rollback target is recovered ' +
          'per-row from the snapshot.\n',
      )
      return 2
    }
    const readStdin = deps.readStdin ?? defaultReadStdin
    const raw = await readStdin()
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0)
    if (lines.length === 0) {
      ctx.stderr.write('--from-stdin received empty input. Nothing to roll back.\n')
      return 0
    }

    ctx.stdout.write(`Bulk asset rollback: ${lines.length} entry(ies) from stdin.\n`)
    if (dryRun) ctx.stdout.write('--dry-run set; no mutations will be issued.\n')
    ctx.stdout.write('\n')

    const counts: Record<RollbackOutcome | 'parse_failed', number> = {
      ok: 0,
      get_failed: 0,
      wrong_scheme: 0,
      not_in_snapshot: 0,
      patch_failed: 0,
      delete_failed: 0,
      parse_failed: 0,
    }
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseStdinRow(lines[i])
      if (typeof parsed === 'string') {
        ctx.stderr.write(`[line ${i + 1}] parse error — ${parsed}\n`)
        counts.parse_failed++
        continue
      }
      ctx.stdout.write(`\n[${i + 1}/${lines.length}] ${parsed.dataset_id} ${parsed.asset_type}\n`)
      const result = await rollbackOneAsset(
        ctx,
        parsed.dataset_id,
        parsed.asset_type,
        snapshotIndex,
        dryRun,
        r2Config,
        deleteR2,
        undefined,
      )
      counts[result.outcome]++
    }

    ctx.stdout.write(
      `\nBulk asset rollback complete:\n` +
        `  ok:                       ${counts.ok}\n` +
        (counts.delete_failed > 0
          ? `  ok (orphan R2 object):    ${counts.delete_failed}\n`
          : '') +
        (counts.parse_failed > 0 ? `  parse_failed:             ${counts.parse_failed}\n` : '') +
        (counts.get_failed > 0 ? `  get_failed:               ${counts.get_failed}\n` : '') +
        (counts.wrong_scheme > 0 ? `  wrong_scheme:             ${counts.wrong_scheme}\n` : '') +
        (counts.not_in_snapshot > 0
          ? `  not_in_snapshot:          ${counts.not_in_snapshot}\n`
          : '') +
        (counts.patch_failed > 0 ? `  patch_failed:             ${counts.patch_failed}\n` : ''),
    )
    const hardFailures =
      counts.parse_failed +
      counts.get_failed +
      counts.wrong_scheme +
      counts.not_in_snapshot +
      counts.patch_failed
    return hardFailures > 0 ? 1 : 0
  }

  // Single-row path.
  const datasetId = ctx.args.positional[0]
  if (!datasetId) {
    ctx.stderr.write(
      'Usage: terraviz rollback-r2-assets <dataset_id> [--types=t1,t2,...] [--to-url=<url>] [--dry-run]\n' +
        '   or: ... | terraviz rollback-r2-assets --from-stdin [--dry-run]\n',
    )
    return 2
  }
  const parsedTypes = parseAssetTypes(typesFlag)
  if ('error' in parsedTypes) {
    ctx.stderr.write(`${parsedTypes.error}\n`)
    return 2
  }
  const types = parsedTypes

  if (toUrl && types.length !== 1) {
    ctx.stderr.write(
      '--to-url requires --types=<single-type> so the override has a clear target column.\n',
    )
    return 2
  }

  const counts: Record<RollbackOutcome, number> = {
    ok: 0,
    get_failed: 0,
    wrong_scheme: 0,
    not_in_snapshot: 0,
    patch_failed: 0,
    delete_failed: 0,
  }
  for (const t of types) {
    const result = await rollbackOneAsset(
      ctx,
      datasetId,
      t,
      snapshotIndex,
      dryRun,
      r2Config,
      deleteR2,
      toUrl,
    )
    counts[result.outcome]++
  }

  // For single-row mode, summary is brief — every per-asset
  // outcome already streamed to stdout/stderr above.
  const hardFailures =
    counts.get_failed + counts.patch_failed + counts.not_in_snapshot
  // `wrong_scheme` is informational (caller error per asset, but
  // when targeting a row with --types-all we expect some columns
  // to be in that state already — don't fail the run for it).
  // Same for delete_failed (orphan tolerated, catalog correct).
  if (!dryRun && counts.ok > 0) {
    ctx.stdout.write(`\nRollback complete: ${counts.ok} asset(s) rolled back.\n`)
  }
  return hardFailures > 0 ? 1 : 0
}
