// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `terraviz rollback-r2-hls` — undo migrated dataset(s).
 *
 * Phase 3 commit F (single-row mode); Phase 3a commit C
 * (`--from-stdin` bulk mode for the list-realtime-r2 pipe).
 * After a row has been migrated to R2/HLS, this subcommand
 * flips its `data_ref` back to `vimeo:<id>` and deletes the R2
 * bundle. Two invocation shapes:
 *
 *   - **Single row.** `terraviz rollback-r2-hls <id>
 *     --to-vimeo=<n>`. Rolls one row. Returns 0 on success,
 *     1/2 on failure.
 *   - **Bulk stdin.** `... | terraviz rollback-r2-hls
 *     --from-stdin`. Reads NDJSON from stdin (one
 *     `{ dataset_id, vimeo_id }` per line — the shape that
 *     `terraviz list-realtime-r2` emits), rolls each row
 *     sequentially, prints an aggregate report. Returns 0
 *     when every row succeeds, 1 if any failed.
 *
 * Per-row pipeline (identical in both modes):
 *
 *   1. GET the dataset, verify `data_ref` currently starts with
 *      `r2:videos/`. Refuses if it's already on `vimeo:` or any
 *      other scheme — caller error.
 *   2. PATCH `data_ref` back to `vimeo:<id>` (the operator
 *      provides the original vimeo id explicitly via
 *      `--to-vimeo=<n>` or in the NDJSON record). **Commit
 *      point.** After this PATCH, the SPA's manifest endpoint
 *      resolves the row through the Vimeo proxy again.
 *   3. Delete the R2 bundle under the dataset's key prefix
 *      (cleanup). Non-fatal — if it fails, the row is already
 *      correctly back on `vimeo:` and an orphan R2 prefix is
 *      left behind for manual cleanup.
 *
 * The PATCH-before-DELETE ordering matters: PATCH failure
 * leaves the catalog correct (row still on r2:, bundle intact
 * and playable). DELETE failure after a successful PATCH leaves
 * the catalog correct (row on vimeo:, orphan R2 prefix is just
 * storage cost the operator can clean up later).
 *
 * Why explicit `--to-vimeo=<n>` (or the NDJSON `vimeo_id`)?
 * The original Vimeo id is recoverable from the SOS snapshot
 * or the legacy_id, but the rollback tool stays deploy-agnostic:
 * any operator who knows the original `vimeo:<id>` can roll
 * back regardless of whether their catalog traces back to SOS
 * or another source. The `list-realtime-r2` helper is the
 * SOS-specific recovery; this CLI just consumes its output.
 */

import {
  deleteR2Prefix as deleteR2PrefixLib,
  loadR2ConfigFromEnv,
  type R2UploadConfig,
} from './lib/r2-upload'
import type { CommandContext } from './commands'
import { getString, getBool } from './lib/args'

interface DatasetGetEnvelope {
  dataset: { id: string; data_ref: string; title?: string }
}

interface DatasetUpdateEnvelope {
  dataset: { id: string; slug: string }
}

export interface RollbackR2HlsDeps {
  /** DI for the R2 prefix-delete helper. Defaults to the production import. */
  deleteR2Prefix?: typeof deleteR2PrefixLib
  /** R2 credentials. Defaults to reading R2_S3_ENDPOINT /
   * R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY from process.env. */
  r2Config?: R2UploadConfig
  /** Test injection for `--from-stdin` mode — defaults to
   * reading `process.stdin` to EOF. Tests pass a stubbed reader. */
  readStdin?: () => Promise<string>
}

/** Per-row rollback outcome — mirrors the migrate-r2-hls
 * outcome enum in shape so a future combined dashboard can
 * surface both pumps with one schema. */
export type RollbackOutcome =
  | 'ok'
  | 'get_failed'
  | 'wrong_scheme'
  | 'patch_failed'
  | 'delete_failed' // PATCH succeeded; orphan R2 prefix remains
  | 'malformed_ref'

export interface RollbackResult {
  datasetId: string
  toVimeo: string
  outcome: RollbackOutcome
  errorMessage: string
}

/**
 * Roll a single row back. Pure per-row helper used by both the
 * single-row CLI path and the `--from-stdin` bulk path.
 *
 * Returns a structured result so the bulk path can aggregate
 * outcomes; emits user-facing progress lines to stdout/stderr
 * along the way (so a long bulk run is visibly progressing).
 *
 * Pre-conditions: r2Config has been validated in the caller; we
 * just check `r2Config.endpoint` / etc. before the DELETE step.
 */
async function rollbackOne(
  ctx: CommandContext,
  datasetId: string,
  toVimeo: string,
  dryRun: boolean,
  r2Config: R2UploadConfig,
  deleteImpl: typeof deleteR2PrefixLib,
): Promise<RollbackResult> {
  const result: RollbackResult = {
    datasetId,
    toVimeo,
    outcome: 'ok',
    errorMessage: '',
  }

  // Stage 0 — fetch current state.
  const got = await ctx.client.get<DatasetGetEnvelope>(datasetId)
  if (!got.ok) {
    const msg =
      `Could not GET ${datasetId} (${got.status}): ${got.error}` +
      (got.message ? ` — ${got.message}` : '')
    ctx.stderr.write(msg + '\n')
    result.outcome = 'get_failed'
    result.errorMessage = msg
    return result
  }
  const currentRef = got.body.dataset.data_ref
  if (!currentRef.startsWith('r2:videos/')) {
    const msg = `Dataset ${datasetId} data_ref is "${currentRef}", not r2:videos/. Nothing to roll back.`
    ctx.stderr.write(msg + '\n')
    result.outcome = 'wrong_scheme'
    result.errorMessage = msg
    return result
  }
  // Strip both the `r2:` scheme prefix and the trailing
  // `/master.m3u8` filename to get the bundle's key prefix.
  // Anything below the master playlist (variant playlists,
  // segments) lives under the same prefix in R2.
  const r2Key = currentRef.slice('r2:'.length).trim()
  if (!r2Key) {
    const msg = `Dataset ${datasetId} has a malformed r2: data_ref ("${currentRef}").`
    ctx.stderr.write(msg + '\n')
    result.outcome = 'malformed_ref'
    result.errorMessage = msg
    return result
  }
  const lastSlash = r2Key.lastIndexOf('/')
  const keyPrefix = lastSlash >= 0 ? r2Key.slice(0, lastSlash) : r2Key

  ctx.stdout.write(
    `Rollback plan:\n` +
      `  dataset:                ${datasetId}` +
      (got.body.dataset.title ? `  (${got.body.dataset.title})` : '') +
      '\n' +
      `  current data_ref:       ${currentRef}\n` +
      `  target data_ref:        vimeo:${toVimeo}\n` +
      `  R2 prefix to delete:    ${keyPrefix}/\n`,
  )

  if (dryRun) {
    ctx.stdout.write('\nDry run — no changes will be made.\n')
    return result
  }

  // Stage 1 — flip data_ref. Commit point.
  const patched = await ctx.client.updateDataset<DatasetUpdateEnvelope>(datasetId, {
    data_ref: `vimeo:${toVimeo}`,
  })
  if (!patched.ok) {
    const msg =
      `data_ref PATCH failed (${patched.status}): ${patched.error}` +
      (patched.message ? ` — ${patched.message}` : '')
    ctx.stderr.write(msg + '\n')
    result.outcome = 'patch_failed'
    result.errorMessage = msg
    return result
  }
  ctx.stdout.write(`✓ data_ref flipped to vimeo:${toVimeo}\n`)

  // Stage 2 — delete the R2 bundle (cleanup; non-fatal).
  if (!r2Config.endpoint || !r2Config.accessKeyId || !r2Config.secretAccessKey) {
    const msg = `R2 credentials unset — leaving orphan ${keyPrefix}/ in R2.`
    ctx.stderr.write(
      `! ${msg}\n` +
        `  data_ref is correctly on vimeo:; delete the orphan via the Cloudflare dashboard or API if needed.\n`,
    )
    // Same artifact as the throw-path below — PATCH committed,
    // R2 prefix is orphaned. Reporting both under `delete_failed`
    // means the bulk-mode summary's "ok (orphan R2 prefix)" line
    // counts every orphan an operator has to clean up later,
    // regardless of whether the DELETE was skipped (creds unset)
    // or attempted-and-failed.
    result.outcome = 'delete_failed'
    result.errorMessage = msg
    return result
  }
  try {
    const out = await deleteImpl(r2Config, keyPrefix)
    ctx.stdout.write(`✓ deleted ${out.deleted} R2 object(s) under ${keyPrefix}/\n`)
  } catch (e) {
    const msg = `! Could not delete R2 prefix ${keyPrefix}/: ${e instanceof Error ? e.message : String(e)}`
    ctx.stderr.write(
      msg + '\n' +
        `  data_ref is already on vimeo:; delete the orphan via the Cloudflare dashboard or API.\n`,
    )
    // PATCH already committed, so the rollback's primary goal
    // succeeded — surface as `delete_failed` (vs `patch_failed`)
    // so the bulk-mode summary distinguishes "rolled back, orphan
    // remains" from "did not roll back at all."
    result.outcome = 'delete_failed'
    result.errorMessage = msg
    return result
  }

  return result
}

/** Read process.stdin to EOF as a single UTF-8 string. */
async function defaultReadStdin(): Promise<string> {
  process.stdin.setEncoding('utf-8')
  const chunks: string[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as string)
  }
  return chunks.join('')
}

/**
 * Parse one NDJSON line into `{ dataset_id, vimeo_id }`. Returns
 * the parsed pair, or an error string for the caller to surface.
 *
 * The expected shape mirrors `RealtimeRowReport` from
 * `cli/list-realtime-r2.ts` — operators can pipe directly.
 * Extra fields (legacy_id, title, etc.) are ignored, so a
 * pipeline using a richer NDJSON producer still works.
 */
interface StdinRowParsed {
  dataset_id: string
  vimeo_id: string
}
function parseStdinRow(line: string): StdinRowParsed | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (e) {
    return `not valid JSON: ${e instanceof Error ? e.message : String(e)}`
  }
  if (!parsed || typeof parsed !== 'object') {
    return `not a JSON object`
  }
  const obj = parsed as Record<string, unknown>
  const datasetId = obj.dataset_id
  const vimeoId = obj.vimeo_id
  if (typeof datasetId !== 'string' || datasetId.length === 0) {
    return `missing or empty dataset_id`
  }
  if (typeof vimeoId !== 'string' || vimeoId.length === 0) {
    return `missing or empty vimeo_id (the row may be unrecoverable from the snapshot — recover the id manually)`
  }
  if (!/^\d+$/.test(vimeoId)) {
    return `vimeo_id "${vimeoId}" is not numeric`
  }
  return { dataset_id: datasetId, vimeo_id: vimeoId }
}

export async function runRollbackR2Hls(
  ctx: CommandContext,
  deps: RollbackR2HlsDeps = {},
): Promise<number> {
  const fromStdin = getBool(ctx.args.options, 'from-stdin')
  const dryRun = getBool(ctx.args.options, 'dry-run')
  const r2Config = deps.r2Config ?? loadR2ConfigFromEnv()
  const deleteImpl = deps.deleteR2Prefix ?? deleteR2PrefixLib

  if (fromStdin) {
    // Bulk path. Mutually exclusive with the single-row args —
    // operator providing both is almost certainly a mistake.
    if (ctx.args.positional.length > 0) {
      ctx.stderr.write(
        '--from-stdin does not accept a positional dataset id; ' +
          'each row\'s id comes from the NDJSON `dataset_id` field.\n',
      )
      return 2
    }
    if (getString(ctx.args.options, 'to-vimeo') !== undefined) {
      ctx.stderr.write(
        '--from-stdin does not accept --to-vimeo; ' +
          "each row's vimeo id comes from the NDJSON `vimeo_id` field.\n",
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

    ctx.stdout.write(`Bulk rollback: ${lines.length} row(s) from stdin.\n`)
    if (dryRun) ctx.stdout.write('--dry-run set; no mutations will be issued.\n')
    ctx.stdout.write('\n')

    const counts: Record<RollbackOutcome | 'parse_failed', number> = {
      ok: 0,
      get_failed: 0,
      wrong_scheme: 0,
      patch_failed: 0,
      delete_failed: 0,
      malformed_ref: 0,
      parse_failed: 0,
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const parsed = parseStdinRow(line)
      if (typeof parsed === 'string') {
        ctx.stderr.write(`[line ${i + 1}] parse error — ${parsed}\n`)
        counts.parse_failed++
        continue
      }
      ctx.stdout.write(`\n[${i + 1}/${lines.length}] ${parsed.dataset_id} → vimeo:${parsed.vimeo_id}\n`)
      const result = await rollbackOne(
        ctx,
        parsed.dataset_id,
        parsed.vimeo_id,
        dryRun,
        r2Config,
        deleteImpl,
      )
      counts[result.outcome]++
    }

    ctx.stdout.write(
      `\nBulk rollback complete:\n` +
        `  ok:                       ${counts.ok}\n` +
        (counts.delete_failed > 0
          ? `  ok (orphan R2 prefix):    ${counts.delete_failed}\n`
          : '') +
        (counts.parse_failed > 0
          ? `  parse_failed:             ${counts.parse_failed}\n`
          : '') +
        (counts.get_failed > 0
          ? `  get_failed:               ${counts.get_failed}\n`
          : '') +
        (counts.wrong_scheme > 0
          ? `  wrong_scheme:             ${counts.wrong_scheme}\n`
          : '') +
        (counts.patch_failed > 0
          ? `  patch_failed:             ${counts.patch_failed}\n`
          : '') +
        (counts.malformed_ref > 0
          ? `  malformed_ref:            ${counts.malformed_ref}\n`
          : ''),
    )
    // delete_failed is bulk-mode tolerated: PATCH already
    // committed, the catalog is correct, just storage cost.
    // The other failure outcomes (and parse errors) are real.
    const hardFailures =
      counts.parse_failed +
      counts.get_failed +
      counts.wrong_scheme +
      counts.patch_failed +
      counts.malformed_ref
    return hardFailures > 0 ? 1 : 0
  }

  // Single-row path. Existing behavior preserved bit-for-bit.
  const datasetId = ctx.args.positional[0]
  if (!datasetId) {
    ctx.stderr.write(
      'Usage: terraviz rollback-r2-hls <dataset_id> --to-vimeo=<vimeo_id> [--dry-run]\n' +
        '   or: ... | terraviz rollback-r2-hls --from-stdin [--dry-run]\n',
    )
    return 2
  }
  const toVimeo = getString(ctx.args.options, 'to-vimeo')
  if (!toVimeo) {
    ctx.stderr.write('--to-vimeo=<vimeo_id> is required.\n')
    return 2
  }
  if (!/^\d+$/.test(toVimeo)) {
    ctx.stderr.write(`--to-vimeo must be a numeric Vimeo id (got "${toVimeo}").\n`)
    return 2
  }

  const result = await rollbackOne(ctx, datasetId, toVimeo, dryRun, r2Config, deleteImpl)
  switch (result.outcome) {
    case 'ok':
      ctx.stdout.write(`\nRollback complete.\n`)
      return 0
    case 'delete_failed':
      // PATCH committed; orphan R2 prefix is non-fatal in
      // single-row mode (matches the original Phase 3/F
      // behavior where the operator already saw the warning).
      return 0
    case 'wrong_scheme':
      // Caller error — usage exit code rather than runtime
      // failure (matches original).
      return 2
    case 'get_failed':
    case 'patch_failed':
    case 'malformed_ref':
      return 1
  }
}
