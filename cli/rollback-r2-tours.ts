// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `terraviz rollback-r2-tours` — undo a migrated tour.
 *
 * Phase 3c commit D. The symmetric inverse of `migrate-r2-tours`
 * (3c/B): flip a row's `run_tour_on_load` column from
 * `r2:tours/<id>/tour.json` back to the original NOAA-hosted
 * URL, then delete the R2 prefix (tour.json + every sibling).
 *
 * Two invocation shapes:
 *
 *   - **Single row.** `terraviz rollback-r2-tours <dataset_id>
 *     [--dry-run] [--to-url=<url>]`. Rolls back one row.
 *
 *   - **Bulk stdin.** `... | rollback-r2-tours --from-stdin
 *     [--dry-run]`. Reads NDJSON, one `{ dataset_id }` per line.
 *     Operators pipe a filtered subset of the
 *     `migration_r2_tours` Grafana telemetry (or the `--id`
 *     output of a partial migrate-r2-tours run) into the
 *     rollback.
 *
 * Per-row pipeline (identical in both modes):
 *
 *   1. GET the row. `get_failed` on any API error.
 *   2. Read `run_tour_on_load`. If it doesn't start with `r2:`
 *      → `wrong_scheme` (caller error, nothing to roll back).
 *   3. Recover the original upstream URL by looking up the
 *      row's `legacy_id` in the SOS snapshot at
 *      `public/assets/sos-dataset-list.json` and reading the
 *      `runTourOnLoad` field. If the lookup fails →
 *      `not_in_snapshot`; operator can fall back to
 *      `--to-url=<url>` for surgical recovery.
 *   4. PATCH `run_tour_on_load` back to the original URL.
 *      **Commit point.** Failure here → `patch_failed`.
 *   5. Delete the R2 prefix `tours/<dataset_id>/` (every
 *      uploaded tour.json + sibling at once via
 *      `deleteR2Prefix`'s list-then-DELETE pass). Failure
 *      here → `delete_failed`; the row is already on the
 *      original URL, so the SPA is correct — the operator
 *      just has R2 orphans to clean up via the dashboard.
 *
 * Unlike Phase 3b's rollback, this CLI doesn't take a `--types`
 * flag — there's no per-asset granularity to roll back. The 3c
 * migration is atomic per row, and so is the inverse.
 *
 * R2 credentials read from process.env: R2_S3_ENDPOINT /
 * R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY. R2 cleanup is
 * non-fatal — a PATCH-only rollback (D1 correct, R2 orphan
 * left behind) still exits 0 with a `delete_failed` count so
 * the operator can clean up via the dashboard.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  deleteR2Prefix as deleteR2PrefixLib,
  loadR2ConfigFromEnv,
  type R2UploadConfig,
} from './lib/r2-upload'
import type { CommandContext } from './commands'
import { getBool, getString } from './lib/args'

const DEFAULT_SNAPSHOT_PATH = 'public/assets/sos-dataset-list.json'

interface DatasetRow {
  id: string
  legacy_id: string | null
  title?: string
  run_tour_on_load: string | null
}

interface DatasetGetEnvelope {
  dataset: DatasetRow
}

interface DatasetUpdateEnvelope {
  dataset: { id: string; slug: string }
}

interface SnapshotEntry {
  id: string
  runTourOnLoad?: string
}

export type TourRollbackOutcome =
  | 'ok'
  | 'get_failed'
  | 'wrong_scheme'
  | 'not_in_snapshot'
  | 'patch_failed'
  | 'delete_failed' // PATCH committed; orphan R2 prefix remains

export interface TourRollbackResult {
  datasetId: string
  /** R2 prefix that was rolled back (or attempted). Empty on
   * `get_failed` / `wrong_scheme` / `not_in_snapshot`. */
  r2Prefix: string
  /** Recovered upstream URL (the new `run_tour_on_load` value
   * after PATCH). Empty when the rollback didn't reach PATCH. */
  toUrl: string
  /** How many R2 objects the cleanup deleted (tour.json +
   * siblings). 0 when the delete step didn't run or failed. */
  deletedCount: number
  outcome: TourRollbackOutcome
  errorMessage: string
}

export interface RollbackR2ToursDeps {
  /** DI for the R2 prefix-delete helper. */
  deleteR2Prefix?: typeof deleteR2PrefixLib
  r2Config?: R2UploadConfig
  /** Test injection — defaults to reading process.stdin to EOF. */
  readStdin?: () => Promise<string>
  /** Test injection — defaults to reading the snapshot file. */
  loadSnapshot?: () => SnapshotEntry[] | Promise<SnapshotEntry[]>
}

function defaultLoadSnapshot(path: string): SnapshotEntry[] {
  const raw = readFileSync(path, 'utf-8')
  const parsed = JSON.parse(raw) as unknown
  if (Array.isArray(parsed)) return parsed as SnapshotEntry[]
  if (
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { datasets?: unknown }).datasets)
  ) {
    return (parsed as { datasets: SnapshotEntry[] }).datasets
  }
  throw new Error(
    `Snapshot at ${path} must be either a JSON array or ` +
      `an object with a top-level \`datasets\` array (got ` +
      `${parsed === null ? 'null' : typeof parsed}).`,
  )
}

/**
 * Roll back a single row. Pure per-row helper used by both
 * single-row and bulk-stdin paths.
 */
async function rollbackOne(
  ctx: CommandContext,
  datasetId: string,
  snapshotIndex: Map<string, SnapshotEntry>,
  dryRun: boolean,
  r2Config: R2UploadConfig,
  deleteR2: typeof deleteR2PrefixLib,
  toUrlOverride: string | undefined,
): Promise<TourRollbackResult> {
  const result: TourRollbackResult = {
    datasetId,
    r2Prefix: '',
    toUrl: '',
    deletedCount: 0,
    outcome: 'ok',
    errorMessage: '',
  }

  // Stage 0 — fetch current state.
  const got = await ctx.client.get<DatasetGetEnvelope>(datasetId)
  if (!got.ok) {
    const msg =
      `Could not GET ${datasetId} (${got.status}): ${got.error}` +
      (got.message ? ` — ${got.message}` : '')
    ctx.stderr.write(`[${datasetId}] ${msg}\n`)
    result.outcome = 'get_failed'
    result.errorMessage = msg
    return result
  }
  const row = got.body.dataset
  const currentRef = (row.run_tour_on_load ?? '').trim()
  if (!currentRef.startsWith('r2:')) {
    const msg = `run_tour_on_load is "${currentRef}", not r2:. Nothing to roll back.`
    ctx.stderr.write(`[${datasetId}] ${msg}\n`)
    result.outcome = 'wrong_scheme'
    result.errorMessage = msg
    return result
  }
  // The migration always writes `r2:tours/<id>/tour.json`, so the
  // prefix to clean up is `tours/<id>/`. Derive from the ref
  // rather than the dataset id directly so a future repath
  // (e.g. multi-bucket sharding) doesn't silently leak orphans.
  const r2Key = currentRef.slice('r2:'.length).trim()
  const slash = r2Key.lastIndexOf('/')
  if (slash <= 0) {
    const msg =
      `run_tour_on_load r2: key "${r2Key}" is malformed (no path separator). ` +
      `Refusing to roll back — would risk deleting a wider prefix than intended.`
    ctx.stderr.write(`[${datasetId}] ${msg}\n`)
    result.outcome = 'wrong_scheme'
    result.errorMessage = msg
    return result
  }
  result.r2Prefix = r2Key.slice(0, slash + 1)

  // Stage 1 — recover the original URL.
  let toUrl = toUrlOverride
  if (!toUrl) {
    const legacyId = row.legacy_id ?? ''
    const snap = legacyId ? snapshotIndex.get(legacyId) : undefined
    const candidate = snap?.runTourOnLoad
    if (!candidate) {
      const msg =
        `cannot recover run_tour_on_load URL — ` +
        (legacyId
          ? `legacy_id ${legacyId} has no runTourOnLoad in the snapshot`
          : 'row has no legacy_id') +
        '. Pass --to-url=<url> to roll back to an explicit target.'
      ctx.stderr.write(`[${datasetId}] ${msg}\n`)
      result.outcome = 'not_in_snapshot'
      result.errorMessage = msg
      return result
    }
    toUrl = candidate
  }
  result.toUrl = toUrl

  ctx.stdout.write(
    `[${datasetId}] rollback plan: r2:${r2Key} → ${toUrl}` +
      `  (R2 prefix to clean: ${result.r2Prefix})\n`,
  )
  if (dryRun) return result

  // Stage 2 — PATCH back to the original URL. Commit point.
  const patched = await ctx.client.updateDataset<DatasetUpdateEnvelope>(datasetId, {
    run_tour_on_load: toUrl,
  })
  if (!patched.ok) {
    const msg =
      `run_tour_on_load PATCH failed (${patched.status}): ${patched.error}` +
      (patched.message ? ` — ${patched.message}` : '')
    ctx.stderr.write(`[${datasetId}] ${msg}\n`)
    result.outcome = 'patch_failed'
    result.errorMessage = msg
    return result
  }
  ctx.stdout.write(`[${datasetId}] ✓ run_tour_on_load → ${toUrl}\n`)

  // Stage 3 — delete the R2 prefix (cleanup; non-fatal).
  if (!r2Config.endpoint || !r2Config.accessKeyId || !r2Config.secretAccessKey) {
    const msg =
      `R2 credentials unset — leaving orphan prefix ${result.r2Prefix} in R2.`
    ctx.stderr.write(
      `[${datasetId}] ! ${msg}\n` +
        `  run_tour_on_load is correctly back on the original URL; ` +
        `delete the orphan prefix via the Cloudflare dashboard if needed.\n`,
    )
    result.outcome = 'delete_failed'
    result.errorMessage = msg
    return result
  }
  try {
    const { deleted } = await deleteR2(r2Config, result.r2Prefix)
    result.deletedCount = deleted
    ctx.stdout.write(
      `[${datasetId}] ✓ deleted ${deleted} R2 object${deleted === 1 ? '' : 's'} under ${result.r2Prefix}\n`,
    )
  } catch (e) {
    const msg = `R2 prefix DELETE failed: ${e instanceof Error ? e.message : String(e)}`
    ctx.stderr.write(
      `[${datasetId}] ! ${msg}\n` +
        `  run_tour_on_load is already back on the original URL; ` +
        `delete the orphan prefix via the Cloudflare dashboard.\n`,
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
  if (typeof datasetId !== 'string' || datasetId.length === 0) {
    return 'missing or empty dataset_id'
  }
  return { dataset_id: datasetId }
}

export async function runRollbackR2Tours(
  ctx: CommandContext,
  deps: RollbackR2ToursDeps = {},
): Promise<number> {
  const fromStdin = getBool(ctx.args.options, 'from-stdin')
  const dryRun = getBool(ctx.args.options, 'dry-run')
  const toUrl = getString(ctx.args.options, 'to-url')
  const snapshotPath =
    getString(ctx.args.options, 'snapshot') ?? join(process.cwd(), DEFAULT_SNAPSHOT_PATH)

  const r2Config = deps.r2Config ?? loadR2ConfigFromEnv()
  const deleteR2 = deps.deleteR2Prefix ?? deleteR2PrefixLib

  // Load the snapshot once — both modes need the
  // legacy_id → URL index. The --to-url override skips the
  // snapshot lookup, but we still load (cheap) so an operator
  // with both --to-url AND a missing/broken snapshot file
  // doesn't get a confusing failure.
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
          "each row's id comes from the NDJSON `dataset_id` field.\n",
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

    ctx.stdout.write(`Bulk tour rollback: ${lines.length} entry(ies) from stdin.\n`)
    if (dryRun) ctx.stdout.write('--dry-run set; no mutations will be issued.\n')
    ctx.stdout.write('\n')

    const counts: Record<TourRollbackOutcome | 'parse_failed', number> = {
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
      ctx.stdout.write(`\n[${i + 1}/${lines.length}] ${parsed.dataset_id}\n`)
      const result = await rollbackOne(
        ctx,
        parsed.dataset_id,
        snapshotIndex,
        dryRun,
        r2Config,
        deleteR2,
        undefined,
      )
      counts[result.outcome]++
    }

    ctx.stdout.write(
      `\nBulk tour rollback complete:\n` +
        `  ok:                       ${counts.ok}\n` +
        (counts.delete_failed > 0
          ? `  ok (orphan R2 prefix):    ${counts.delete_failed}\n`
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
      'Usage: terraviz rollback-r2-tours <dataset_id> [--to-url=<url>] [--dry-run]\n' +
        '   or: ... | terraviz rollback-r2-tours --from-stdin [--dry-run]\n',
    )
    return 2
  }

  const result = await rollbackOne(
    ctx,
    datasetId,
    snapshotIndex,
    dryRun,
    r2Config,
    deleteR2,
    toUrl,
  )
  // Hard-failure outcomes return exit 1; delete_failed exits 0
  // because the catalog is correct (only R2 orphans remain).
  return result.outcome === 'ok' || result.outcome === 'delete_failed' ? 0 : 1
}
