// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `terraviz list-realtime-r2` — find migrated rows whose Vimeo
 * source is on a daily re-upload cadence, and recover the original
 * Vimeo id so they can be rolled back.
 *
 * Phase 3a commit B. Triage helper for the gap left by Phase 3 +
 * 3a/A: rows migrated *before* the `--skip-realtime` guard landed
 * in 3a/A may now be serving 24h-stale R2 snapshots. This tool
 * finds them and pairs each with the Vimeo id needed for
 * `terraviz rollback-r2-hls <id> --to-vimeo=<vimeo_id>`.
 *
 * Per-row pipeline:
 *
 *   1. List the catalog via the publisher API. Filter to rows
 *      with `data_ref` starting `r2:videos/` AND `format =
 *      video/mp4` AND `title` matching the same heuristic as
 *      `migrate-r2-hls --skip-realtime` (`/real[-\s]?time/i`).
 *      The catalog has no explicit `update_cadence` field — see
 *      the migrate-r2-hls header for why the title is the only
 *      reliable signal.
 *   2. Recover the original `vimeo_id` for each candidate by
 *      looking up the row's `legacy_id` (e.g. `INTERNAL_SOS_768`)
 *      in the SOS snapshot at
 *      `public/assets/sos-dataset-list.json`. The snapshot's
 *      `entry.id` is 1:1 with the row's `legacy_id` (Phase 1d
 *      import contract); the Vimeo id is embedded in the
 *      `dataLink` URL via the same `vimeo.com/(\d+)` pattern
 *      that `cli/lib/snapshot-import.ts:mapDataRef` uses.
 *   3. Emit one line per match. Two output modes:
 *
 *        Default: NDJSON (one JSON object per line). Designed
 *        for piping into `rollback-r2-hls --from-stdin` (3a/C).
 *
 *        --human: pretty-printed table for operator inspection.
 *        Includes a one-liner suggesting the rollback pipe.
 *
 *      Rows where the snapshot lookup fails (legacy_id not in
 *      snapshot, or dataLink doesn't match the Vimeo URL pattern)
 *      are deliberately omitted from stdout — emitting them with
 *      `vimeo_id: ""` would poison a `... | rollback-r2-hls
 *      --from-stdin` pipe (the downstream CLI rejects empty
 *      vimeo_ids). Instead each unmatched row is summarized to
 *      stderr at the end of the run so the operator can see them
 *      and recover the id from another source (Grafana telemetry's
 *      `migration_r2_hls` events, Vimeo dashboard) and call
 *      `rollback-r2-hls` per row manually.
 *
 * Read-only: makes no mutations to the catalog or R2.
 *
 * Flags:
 *   --human          Pretty-printed output instead of NDJSON.
 *   --snapshot=<path> Override the snapshot file location
 *                    (default: public/assets/sos-dataset-list.json).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandContext } from './commands'
import { getBool, getString } from './lib/args'
import { isRealtimeTitle } from './lib/realtime-title'

const LIST_PAGE_LIMIT = 200
const DEFAULT_SNAPSHOT_PATH = 'public/assets/sos-dataset-list.json'

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

/** Subset of `RawSosEntry` (snapshot-import.ts) the lookup needs. */
interface SnapshotEntry {
  id: string
  title?: string
  dataLink?: string
}

export interface RealtimeRowReport {
  /** Catalog row id (e.g. `DSXXXX...`). */
  dataset_id: string
  /** SOS-side identifier preserved on the row (e.g. `INTERNAL_SOS_768`). */
  legacy_id: string
  /** Recovered original Vimeo id, or '' when the snapshot lookup failed. */
  vimeo_id: string
  /** Catalog row title — the substring that matched the heuristic. */
  title: string
  /** Current `data_ref` (always starts with `r2:videos/`). */
  current_data_ref: string
}

export interface ListRealtimeR2Deps {
  /** Override the snapshot loader. Tests inject the entries directly
   * so they don't need a real on-disk snapshot. */
  loadSnapshot?: () => SnapshotEntry[] | Promise<SnapshotEntry[]>
}

/**
 * Default snapshot loader — reads the JSON file at
 * `public/assets/sos-dataset-list.json` relative to the cwd. The
 * operator runs `npm run terraviz` from the repo root, so the
 * relative path resolves correctly without configuration.
 *
 * The on-disk shape is `{ datasets: RawSosEntry[] }` (the
 * canonical SOS snapshot wrapper — see
 * `scripts/refresh-sos-snapshot.ts` and the snapshot-import
 * loader). A bare top-level array is also accepted so an
 * operator can `--snapshot=<path>` a hand-trimmed sub-list
 * without having to wrap it.
 */
function defaultLoadSnapshot(snapshotPath: string): SnapshotEntry[] {
  const raw = readFileSync(snapshotPath, 'utf-8')
  const parsed = JSON.parse(raw) as unknown
  if (Array.isArray(parsed)) {
    return parsed as SnapshotEntry[]
  }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { datasets?: unknown }).datasets)) {
    return (parsed as { datasets: SnapshotEntry[] }).datasets
  }
  throw new Error(
    `Snapshot at ${snapshotPath} must be either a JSON array or ` +
      `an object with a top-level \`datasets\` array (got ` +
      `${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}).`,
  )
}

/**
 * Extract the numeric Vimeo id from a `dataLink` URL — same pattern
 * as `cli/lib/snapshot-import.ts:mapDataRef`. Inlined here rather
 * than imported because pulling in `snapshot-import.ts` drags
 * `validators.ts` (Phase 1d), which is unrelated to triage.
 */
function extractVimeoId(dataLink: string | undefined): string {
  if (!dataLink) return ''
  const m = dataLink.match(/vimeo\.com\/(\d+)/i)
  return m ? m[1] : ''
}

export async function runListRealtimeR2(
  ctx: CommandContext,
  deps: ListRealtimeR2Deps = {},
): Promise<number> {
  const human = getBool(ctx.args.options, 'human')
  const snapshotPath =
    getString(ctx.args.options, 'snapshot') ?? join(process.cwd(), DEFAULT_SNAPSHOT_PATH)

  // Load + index the snapshot up front so the per-row lookup is O(1).
  let snapshot: SnapshotEntry[]
  try {
    snapshot = await (deps.loadSnapshot ?? (() => defaultLoadSnapshot(snapshotPath)))()
  } catch (e) {
    ctx.stderr.write(
      `Could not load SOS snapshot at ${snapshotPath}: ${e instanceof Error ? e.message : String(e)}\n` +
        `Use --snapshot=<path> to override the location.\n`,
    )
    return 1
  }
  const snapshotById = new Map<string, SnapshotEntry>()
  for (const entry of snapshot) {
    if (entry && typeof entry.id === 'string') snapshotById.set(entry.id, entry)
  }

  // Walk the catalog. Use the same status=published filter as
  // migrate-r2-hls so drafts and retracted rows aren't surfaced
  // by accident.
  const reports: RealtimeRowReport[] = []
  const unmatchedSnapshot: RealtimeRowReport[] = []
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
      return 1
    }
    for (const row of result.body.datasets) {
      if (row.format !== 'video/mp4') continue
      if (!row.data_ref.startsWith('r2:videos/')) continue
      if (!isRealtimeTitle(row.title)) continue

      const legacyId = row.legacy_id ?? ''
      const snapshotEntry = legacyId ? snapshotById.get(legacyId) : undefined
      const vimeoId = extractVimeoId(snapshotEntry?.dataLink)
      const report: RealtimeRowReport = {
        dataset_id: row.id,
        legacy_id: legacyId,
        vimeo_id: vimeoId,
        title: row.title,
        current_data_ref: row.data_ref,
      }
      if (vimeoId) reports.push(report)
      else unmatchedSnapshot.push(report)
    }
    cursor = result.body.next_cursor ?? undefined
  } while (cursor)

  // Emit. NDJSON for the matched rows is the default — a single
  // contiguous block of `{...}\n{...}\n...` lines on stdout, ready
  // to pipe into `rollback-r2-hls --from-stdin`. Unmatched rows go
  // to stderr so they don't pollute the pipeline.
  if (human) {
    if (reports.length === 0 && unmatchedSnapshot.length === 0) {
      ctx.stdout.write('No real-time rows currently migrated to r2:.\n')
      return 0
    }
    ctx.stdout.write(
      `Real-time rows on r2:\n` +
        `  with recoverable vimeo_id: ${reports.length}\n` +
        `  unrecoverable (no snapshot match): ${unmatchedSnapshot.length}\n\n`,
    )
    for (const r of reports) {
      ctx.stdout.write(
        `  ${r.dataset_id}  legacy=${r.legacy_id}  vimeo:${r.vimeo_id}  ${r.title}\n`,
      )
    }
    if (reports.length > 0) {
      ctx.stdout.write(
        `\nTo roll back all matched rows:\n` +
          `  terraviz list-realtime-r2 | terraviz rollback-r2-hls --from-stdin\n`,
      )
    }
  } else {
    for (const r of reports) {
      ctx.stdout.write(`${JSON.stringify(r)}\n`)
    }
  }

  if (unmatchedSnapshot.length > 0) {
    ctx.stderr.write(
      `\n${unmatchedSnapshot.length} real-time row(s) had no recoverable Vimeo id ` +
        `(legacy_id missing from the snapshot or dataLink not a vimeo.com URL):\n`,
    )
    for (const r of unmatchedSnapshot) {
      ctx.stderr.write(`  ${r.dataset_id}  legacy=${r.legacy_id}  ${r.title}\n`)
    }
    ctx.stderr.write(
      `Recover the Vimeo id from another source (Grafana ` +
        `migration_r2_hls events, Vimeo dashboard) and pass ` +
        `--to-vimeo=<id> manually to rollback-r2-hls.\n`,
    )
  }

  return 0
}
