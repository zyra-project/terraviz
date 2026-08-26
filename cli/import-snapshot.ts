// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `terraviz import-snapshot` — one-shot bulk importer for the legacy
 * SOS catalog snapshot.
 *
 * Drives the pure row-mapping helper from `lib/snapshot-import.ts`
 * (Commit 1d/A) and the existing publisher-API client. For each
 * snapshot row, the importer:
 *
 *   1. Maps the row to a publisher-API draft body.
 *   2. Skips it if its `legacy_id` is already present in the catalog
 *      (idempotency — re-running the importer is a no-op on rows
 *      already imported).
 *   3. Otherwise POSTs a draft (`/api/v1/publish/datasets`), then
 *      POSTs `/publish/datasets/{id}/publish` to flip the row to
 *      published. The publish step fires the embed-job enqueue
 *      added in Phase 1c/D, so the Vectorize index covers each row
 *      as it lands.
 *
 * Idempotency uses an in-memory legacy_id index built once at
 * startup by paging `GET /api/v1/publish/datasets` (the brief's
 * suggested approach — no API change required). For ~600 rows this
 * is two or three pages of round-trips at ~200 rows each.
 *
 * `--update-existing` (Phase 3b/C) flips the legacy_id-matched
 * branch from "skip silently" to "PATCH the row with the
 * Phase-3b columns from the snapshot." Useful when a new schema
 * migration (e.g. 0009's `color_table_ref` / `probing_info` /
 * `bounding_variables`) lands and the operator needs to backfill
 * already-imported rows from upstream values. Scoped to the
 * `BACKFILL_FIELDS` list explicitly so a re-import never clobbers
 * publisher-side edits to title / abstract / etc.
 *
 * `--dry-run` prints the planned mutations and exits before any
 * write. The contributor walkthrough in `CATALOG_BACKEND_DEVELOPMENT.md`
 * (commit 1d/H) requires a dry-run pass before running the live
 * import.
 *
 * Inputs default to the snapshot files committed under
 * `public/assets/`; `--list` and `--enriched` override the paths so
 * a self-hosting operator can point the importer at a fork of the
 * catalog without re-rolling the binary.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CommandContext } from './commands'
import { getString, getBool } from './lib/args'
import {
  mapSnapshot,
  type ImportPlan,
  type RawEnrichedEntry,
  type RawSosEntry,
} from './lib/snapshot-import'

const DEFAULT_LIST_PATH = 'public/assets/sos-dataset-list.json'
const DEFAULT_ENRICHED_PATH = 'public/assets/sos_dataset_metadata.json'

/** Page size for the legacy_id index build. The publisher API caps at 200. */
const LIST_PAGE_LIMIT = 200

/**
 * Modest pacing between publish round-trips. The embed pipeline
 * runs Workers AI inference per row; bursting 600 publishes in
 * parallel would saturate the AI quota. 200 ms ≈ 5 rows/s, which is
 * comfortably under the docent's expected steady-state and keeps
 * the import under ~3 minutes for a full SOS catalog.
 */
const PUBLISH_PACE_MS = 200

interface DatasetListEnvelope {
  datasets: Array<{ id: string; legacy_id: string | null; published_at: string | null }>
  next_cursor: string | null
}

interface DatasetEnvelope {
  dataset: { id: string; slug: string; title: string; published_at: string | null }
}

function readJson<T>(ctx: CommandContext, path: string): T {
  const reader = ctx.readFile ?? ((p: string) => readFileSync(p, 'utf-8'))
  let raw: string
  try {
    raw = reader(path)
  } catch (e) {
    throw new Error(`Could not read ${path}: ${e instanceof Error ? e.message : e}`)
  }
  try {
    return JSON.parse(raw) as T
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${e instanceof Error ? e.message : e}`)
  }
}

/**
 * Page through the publisher API to build a legacy_id → dataset_id
 * index of *published* rows. Returns null on the first non-OK list
 * response so the caller can surface a structured failure.
 *
 * The status filter matters for resume-after-failure semantics. If
 * a prior import created a draft with `legacy_id = X` but failed to
 * publish, that draft persists in the catalog as legacy_id-keyed
 * but unpublished. Including drafts in the index would cause the
 * next import-snapshot run to silently skip the row as
 * "already imported" — yet the draft is stuck and the operator
 * never sees the chip in the SPA. By filtering to status=published
 * the importer surfaces the 409 from createDataset on the next
 * run instead, which prints the existing draft id and gives the
 * operator something actionable to clean up (raised by the 1d/L
 * Copilot review).
 */
async function buildLegacyIdIndex(
  ctx: CommandContext,
): Promise<Map<string, string> | null> {
  const index = new Map<string, string>()
  let cursor: string | undefined
  // The list endpoint hard-caps `limit` at 200 (see
  // dataset-mutations.ts:169) so we don't try to ask for more.
  do {
    const result = await ctx.client.list<DatasetListEnvelope>({
      status: 'published',
      limit: LIST_PAGE_LIMIT,
      cursor,
    })
    if (!result.ok) {
      ctx.stderr.write(
        `Could not list existing datasets to build the idempotency index ` +
          `(${result.status}): ${result.error}` +
          (result.message ? ` — ${result.message}` : '') +
          '\n',
      )
      return null
    }
    for (const row of result.body.datasets) {
      if (row.legacy_id) index.set(row.legacy_id, row.id)
    }
    cursor = result.body.next_cursor ?? undefined
  } while (cursor)
  return index
}

interface PlanCounts {
  imported: number
  skippedExisting: number
  failedCreate: number
  failedPublish: number
  /** `--update-existing`: rows that matched a legacy_id and received
   * a PATCH with one or more of the Phase-3b columns (3b/C).
   * Always 0 when `--update-existing` is not set. */
  backfilled: number
  /** `--update-existing`: rows that matched a legacy_id but had no
   * new field values in the snapshot — nothing to PATCH, no
   * round-trip made. */
  backfillNoop: number
  /** `--update-existing`: PATCH failures. */
  backfillFailed: number
}

/**
 * Fields the `--update-existing` PATCH includes for an existing
 * row. Tightly scoped — the operator opted in to a backfill of
 * specific columns the schema gained, not to a full re-sync that
 * could clobber publisher-side edits to title / abstract / etc.
 * Listed here so a future column addition decides explicitly
 * whether the backfill flag covers it.
 */
const BACKFILL_FIELDS = [
  'color_table_ref',
  'probing_info',
  'bounding_box',
  'celestial_body',
  'radius_mi',
  'lon_origin',
  'is_flipped_in_y',
] as const

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * --reindex path. Walks every published, non-retracted dataset
 * visible to the caller and POSTs `/reindex` on each, paced at the
 * same 5-rows/sec rhythm as the publish path so a 600-row pass
 * doesn't burst Workers AI quota. Skips the snapshot files entirely.
 *
 * Uses cases (per the 1d brief):
 *   1. Operator wired up Vectorize after the catalog was already
 *      populated — embed jobs were silently no-op'd at publish
 *      time. Re-enqueue closes the gap.
 *   2. Future model-version bump rolled out as a one-off cron.
 */
async function runReindexAll(ctx: CommandContext, dryRun: boolean): Promise<number> {
  const ids: string[] = []
  let cursor: string | undefined
  do {
    const result = await ctx.client.list<DatasetListEnvelope>({
      status: 'published',
      limit: LIST_PAGE_LIMIT,
      cursor,
    })
    if (!result.ok) {
      ctx.stderr.write(
        `Could not list published datasets (${result.status}): ${result.error}` +
          (result.message ? ` — ${result.message}` : '') +
          '\n',
      )
      return 1
    }
    for (const row of result.body.datasets) {
      if (row.published_at) ids.push(row.id)
    }
    cursor = result.body.next_cursor ?? undefined
  } while (cursor)

  ctx.stdout.write(`Reindex plan:\n  published rows to re-embed: ${ids.length}\n`)
  if (dryRun) {
    ctx.stdout.write('\nDry run — no rows will be re-enqueued. Re-run without --dry-run to apply.\n')
    return 0
  }

  let succeeded = 0
  let failed = 0
  for (const id of ids) {
    const result = await ctx.client.reindexDataset(id)
    if (!result.ok) {
      failed++
      ctx.stderr.write(
        `[${id}] reindex failed (${result.status}): ${result.error}` +
          (result.message ? ` — ${result.message}` : '') +
          '\n',
      )
      if (result.errors?.length) {
        for (const e of result.errors) {
          ctx.stderr.write(`    ${e.field}: ${e.code} — ${e.message}\n`)
        }
      }
      continue
    }
    succeeded++
    if (PUBLISH_PACE_MS > 0) await sleep(PUBLISH_PACE_MS)
  }

  ctx.stdout.write(
    `\nReindex complete:\n` +
      `  reindexed:             ${succeeded}\n` +
      `  failed:                ${failed}\n`,
  )
  return failed > 0 ? 1 : 0
}

/**
 * Pretty-print the dry-run plan. Used by both `--dry-run` and the
 * pre-flight summary the live import emits before its first POST.
 */
function summarisePlan(
  ctx: CommandContext,
  plan: ImportPlan,
  alreadyImported: number,
  backfillCandidates: number,
  updateExisting: boolean,
): void {
  const okRows = plan.outcomes.filter(o => o.kind === 'ok')
  const newRows = okRows.length - alreadyImported
  ctx.stdout.write(
    `Snapshot plan:\n` +
      `  ok rows:               ${okRows.length}\n` +
      `  already imported:      ${alreadyImported}\n` +
      `  new rows to publish:   ${newRows}\n` +
      (updateExisting
        ? `  rows to backfill:      ${backfillCandidates}` +
          `  (--update-existing on ${BACKFILL_FIELDS.join(' / ')})\n`
        : '') +
      `  skipped (mapping):     ${plan.outcomes.length - okRows.length}\n`,
  )
  for (const reason of [
    'missing_title',
    'missing_data_link',
    'unsupported_format',
    'duplicate_id',
    'invalid_after_mapping',
  ] as const) {
    const n = plan.counts.skipped[reason]
    if (n) ctx.stdout.write(`    ${reason.padEnd(22)} ${n}\n`)
  }
}

export async function runImportSnapshot(ctx: CommandContext): Promise<number> {
  const listPath = resolve(getString(ctx.args.options, 'list') ?? DEFAULT_LIST_PATH)
  const enrichedPath = resolve(
    getString(ctx.args.options, 'enriched') ?? DEFAULT_ENRICHED_PATH,
  )
  const dryRun = getBool(ctx.args.options, 'dry-run')
  const reindex = getBool(ctx.args.options, 'reindex')
  const updateExisting = getBool(ctx.args.options, 'update-existing')

  if (reindex) {
    return runReindexAll(ctx, dryRun)
  }

  // --- Stage 1 — load + map ----------------------------------------
  let sosWrap: { datasets: RawSosEntry[] }
  let enriched: RawEnrichedEntry[]
  try {
    sosWrap = readJson<{ datasets: RawSosEntry[] }>(ctx, listPath)
    enriched = readJson<RawEnrichedEntry[]>(ctx, enrichedPath)
  } catch (e) {
    ctx.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    return 2
  }
  if (!Array.isArray(sosWrap.datasets)) {
    ctx.stderr.write(`${listPath}: missing datasets[] array.\n`)
    return 2
  }
  if (!Array.isArray(enriched)) {
    ctx.stderr.write(`${enrichedPath}: expected an array.\n`)
    return 2
  }

  const plan = mapSnapshot(sosWrap.datasets, enriched)

  // --- Stage 2 — build the legacy_id index ------------------------
  const index = await buildLegacyIdIndex(ctx)
  if (!index) return 1

  let alreadyImported = 0
  let backfillCandidates = 0
  for (const o of plan.outcomes) {
    if (o.kind !== 'ok') continue
    if (!index.has(o.row.legacyId)) continue
    alreadyImported++
    if (updateExisting && hasBackfillData(o.row.draft as Record<string, unknown>)) {
      backfillCandidates++
    }
  }

  summarisePlan(ctx, plan, alreadyImported, backfillCandidates, updateExisting)

  if (dryRun) {
    ctx.stdout.write('\nDry run — no rows will be imported. Re-run without --dry-run to apply.\n')
    return 0
  }

  // --- Stage 3 — publish new rows + (optionally) backfill existing -
  const counts: PlanCounts = {
    imported: 0,
    skippedExisting: alreadyImported,
    failedCreate: 0,
    failedPublish: 0,
    backfilled: 0,
    backfillNoop: 0,
    backfillFailed: 0,
  }
  for (const outcome of plan.outcomes) {
    if (outcome.kind !== 'ok') continue
    const { legacyId, draft } = outcome.row
    const existingId = index.get(legacyId)

    if (existingId) {
      if (!updateExisting) continue
      // --update-existing path. Backfill the Phase-3b columns
      // only — never touch publisher-edited fields like title or
      // abstract. If the snapshot has no value for any of the
      // backfill fields, skip the PATCH (no need for an HTTP
      // round-trip to clear nothing).
      const patchBody: Record<string, unknown> = {}
      for (const f of BACKFILL_FIELDS) {
        const v = (draft as Record<string, unknown>)[f]
        if (v !== undefined) patchBody[f] = v
      }
      if (Object.keys(patchBody).length === 0) {
        counts.backfillNoop++
        continue
      }
      const patched = await ctx.client.updateDataset<DatasetEnvelope>(existingId, patchBody)
      if (!patched.ok) {
        counts.backfillFailed++
        ctx.stderr.write(
          `[${legacyId}] backfill failed (${patched.status}): ${patched.error}` +
            (patched.message ? ` — ${patched.message}` : '') +
            '\n',
        )
        if (patched.errors?.length) {
          for (const e of patched.errors) {
            ctx.stderr.write(`    ${e.field}: ${e.code} — ${e.message}\n`)
          }
        }
        continue
      }
      counts.backfilled++
      ctx.stdout.write(
        `[${legacyId}] backfilled ${Object.keys(patchBody).join(', ')} → ${existingId}\n`,
      )
      if (PUBLISH_PACE_MS > 0) await sleep(PUBLISH_PACE_MS)
      continue
    }

    const created = await ctx.client.createDataset<DatasetEnvelope>({
      ...draft,
      legacy_id: legacyId,
    })
    if (!created.ok) {
      counts.failedCreate++
      ctx.stderr.write(
        `[${legacyId}] create failed (${created.status}): ${created.error}` +
          (created.message ? ` — ${created.message}` : '') +
          '\n',
      )
      if (created.errors?.length) {
        for (const e of created.errors) {
          ctx.stderr.write(`    ${e.field}: ${e.code} — ${e.message}\n`)
        }
      }
      continue
    }
    const datasetId = created.body.dataset.id

    const published = await ctx.client.publishDataset<DatasetEnvelope>(datasetId)
    if (!published.ok) {
      counts.failedPublish++
      ctx.stderr.write(
        `[${legacyId}] draft created (${datasetId}) but publish failed ` +
          `(${published.status}): ${published.error}` +
          (published.message ? ` — ${published.message}` : '') +
          '\n',
      )
      if (published.errors?.length) {
        for (const e of published.errors) {
          ctx.stderr.write(`    ${e.field}: ${e.code} — ${e.message}\n`)
        }
      }
      continue
    }
    counts.imported++
    ctx.stdout.write(`[${legacyId}] → ${datasetId} (${created.body.dataset.slug})\n`)
    if (PUBLISH_PACE_MS > 0) await sleep(PUBLISH_PACE_MS)
  }

  ctx.stdout.write(
    `\nImport complete:\n` +
      `  imported:              ${counts.imported}\n` +
      `  already imported:      ${counts.skippedExisting}\n` +
      (updateExisting
        ? `  backfilled:            ${counts.backfilled}\n` +
          `  backfill no-op:        ${counts.backfillNoop}` +
          ` (legacy_id matched but no new field values in snapshot)\n` +
          `  backfill failed:       ${counts.backfillFailed}\n`
        : '') +
      `  failed (create):       ${counts.failedCreate}\n` +
      `  failed (publish):      ${counts.failedPublish}\n`,
  )
  return counts.failedCreate + counts.failedPublish + counts.backfillFailed > 0 ? 1 : 0
}

/**
 * True if the mapped draft carries at least one BACKFILL_FIELDS
 * value worth PATCHing. Empty drafts skip the round-trip entirely
 * in `--update-existing` mode so a row that's already-imported AND
 * has no new field values doesn't produce a stale "no diff" PATCH.
 */
function hasBackfillData(draft: Record<string, unknown>): boolean {
  for (const f of BACKFILL_FIELDS) {
    if (draft[f] !== undefined) return true
  }
  return false
}
