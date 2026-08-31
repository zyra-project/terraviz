// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for `terraviz rollback-r2-tours` (Phase 3c commit D).
 *
 * Coverage:
 *   - Single-row happy path: snapshot recovery → PATCH →
 *     R2 prefix delete.
 *   - wrong_scheme: run_tour_on_load is not r2:.
 *   - wrong_scheme: r2: key has no path separator (defensive —
 *     refuses to delete a too-wide prefix).
 *   - not_in_snapshot: legacy_id absent / unmapped.
 *   - --to-url override.
 *   - --dry-run leaves the row alone.
 *   - patch_failed → exit 1, no R2 delete attempted.
 *   - delete_failed → exit 0 (catalog correct, orphan tolerated).
 *   - Missing R2 creds → delete_failed (orphan skipped).
 *   - Bulk --from-stdin: NDJSON parsing, per-row continuation,
 *     aggregate summary.
 *   - --from-stdin rejects positional / --to-url combinations.
 *   - Snapshot loader failure: exit 1 (without --to-url);
 *     tolerated when --to-url is set (single-row only).
 */

import { describe, expect, it, vi } from 'vitest'
import { runRollbackR2Tours } from './rollback-r2-tours'
import type { CommandContext } from './commands'
import type { TerravizClient } from './lib/client'
import { parseArgs } from './lib/args'
import type { R2UploadConfig } from './lib/r2-upload'

interface BufStream {
  write(chunk: string): boolean
  text(): string
}

function makeStream(): BufStream {
  let buf = ''
  return {
    write(chunk: string) {
      buf += chunk
      return true
    },
    text() {
      return buf
    },
  }
}

const R2_CONFIG: R2UploadConfig = {
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  accessKeyId: 'AKIA',
  secretAccessKey: 'secret',
  bucket: 'terraviz-assets',
}

const NOAA_TOUR = 'https://d3sik7mbbzunjo.cloudfront.net/terraviz/maria/tour.json'

const SNAPSHOT = [
  { id: 'INTERNAL_SOS_MARIA_360', runTourOnLoad: NOAA_TOUR },
  { id: 'INTERNAL_SOS_768', runTourOnLoad: 'https://d3sik7mbbzunjo.cloudfront.net/atmosphere/hurricane_season_2024/tour.json' },
]

interface RowState {
  id: string
  legacy_id: string | null
  title?: string
  run_tour_on_load: string | null
}

function makeRow(over: Partial<RowState> = {}): RowState {
  return {
    id: 'DS00001AAAAAAAAAAAAAAAAAAAAA',
    legacy_id: 'INTERNAL_SOS_MARIA_360',
    title: 'Hurricane Maria 360',
    run_tour_on_load: 'r2:tours/DS00001AAAAAAAAAAAAAAAAAAAAA/tour.json',
    ...over,
  }
}

interface FakeClientOptions {
  row?: RowState
  // Per-id row table — for bulk-stdin tests where multiple GETs hit
  // distinct dataset ids.
  rowsById?: Record<string, RowState>
  patchFailFor?: Set<string>
}

function fakeClient(opts: FakeClientOptions = {}) {
  const get = vi.fn(async (id: string) => {
    if (opts.rowsById) {
      const row = opts.rowsById[id]
      if (row) return { ok: true as const, status: 200, body: { dataset: row } }
      return { ok: false as const, status: 404, error: 'not_found' }
    }
    if (!opts.row) return { ok: false as const, status: 404, error: 'not_found' }
    return { ok: true as const, status: 200, body: { dataset: opts.row } }
  })
  const updateDataset = vi.fn(async (id: string, body: Record<string, unknown>) => {
    if (opts.patchFailFor?.has(id)) {
      return {
        ok: false as const,
        status: 503,
        error: 'upstream_unavailable',
        message: 'D1 timeout',
      }
    }
    return {
      ok: true as const,
      status: 200,
      body: { dataset: { id, slug: `slug-${id}`, ...body } },
    }
  })
  const stub = { serverUrl: 'http://localhost:8788', get, updateDataset }
  return { client: stub as unknown as TerravizClient, handles: { get, updateDataset } }
}

function makeCtx(
  client: TerravizClient,
  positional: string[],
  flags: Record<string, string | boolean> = {},
): { ctx: CommandContext; out: BufStream; err: BufStream } {
  const out = makeStream()
  const err = makeStream()
  const argv: string[] = [...positional]
  for (const [k, v] of Object.entries(flags)) {
    if (v === true) argv.push(`--${k}`)
    else if (v === false) argv.push(`--no-${k}`)
    else argv.push(`--${k}=${String(v)}`)
  }
  const args = parseArgs(argv)
  return { ctx: { client, args, stdout: out, stderr: err }, out, err }
}

describe('runRollbackR2Tours — single-row', () => {
  it('happy path: snapshot recovery → PATCH → R2 prefix delete', async () => {
    const row = makeRow()
    const { client, handles } = fakeClient({ row })
    const deleteR2Prefix = vi.fn(async () => ({ deleted: 2, durationMs: 30 }))
    const { ctx, out } = makeCtx(client, [row.id])
    const code = await runRollbackR2Tours(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(0)
    expect(handles.updateDataset).toHaveBeenCalledWith(row.id, { run_tour_on_load: NOAA_TOUR })
    expect(deleteR2Prefix).toHaveBeenCalledWith(R2_CONFIG, `tours/${row.id}/`)
    expect(out.text()).toMatch(/✓ run_tour_on_load/)
    expect(out.text()).toMatch(/deleted 2 R2 objects/)
  })

  it('wrong_scheme: run_tour_on_load already on NOAA bare URL', async () => {
    const row = makeRow({ run_tour_on_load: NOAA_TOUR })
    const { client, handles } = fakeClient({ row })
    const deleteR2Prefix = vi.fn(async () => ({ deleted: 0, durationMs: 0 }))
    const { ctx, err } = makeCtx(client, [row.id])
    const code = await runRollbackR2Tours(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(1)
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(deleteR2Prefix).not.toHaveBeenCalled()
    expect(err.text()).toMatch(/not r2:/)
  })

  it('wrong_scheme: malformed r2: key without path separator', async () => {
    // Defensive — a bare `r2:tour.json` (no slash) could trick the
    // prefix derivation into rolling back too wide. The CLI must
    // refuse rather than delete the whole bucket root.
    const row = makeRow({ run_tour_on_load: 'r2:no-slash-key' })
    const { client, handles } = fakeClient({ row })
    const deleteR2Prefix = vi.fn(async () => ({ deleted: 0, durationMs: 0 }))
    const { ctx, err } = makeCtx(client, [row.id])
    const code = await runRollbackR2Tours(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(1)
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(deleteR2Prefix).not.toHaveBeenCalled()
    expect(err.text()).toMatch(/malformed/)
  })

  it('not_in_snapshot: legacy_id absent', async () => {
    const row = makeRow({ legacy_id: null })
    const { client, handles } = fakeClient({ row })
    const deleteR2Prefix = vi.fn(async () => ({ deleted: 0, durationMs: 0 }))
    const { ctx, err } = makeCtx(client, [row.id])
    const code = await runRollbackR2Tours(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(1)
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(err.text()).toMatch(/row has no legacy_id/)
  })

  it('not_in_snapshot: legacy_id present but missing from snapshot', async () => {
    const row = makeRow({ legacy_id: 'INTERNAL_SOS_UNKNOWN' })
    const { client, handles } = fakeClient({ row })
    const deleteR2Prefix = vi.fn(async () => ({ deleted: 0, durationMs: 0 }))
    const { ctx, err } = makeCtx(client, [row.id])
    const code = await runRollbackR2Tours(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(1)
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(err.text()).toMatch(/has no runTourOnLoad in the snapshot/)
  })

  it('--to-url overrides snapshot recovery', async () => {
    const row = makeRow({ legacy_id: null }) // not in snapshot
    const { client, handles } = fakeClient({ row })
    const deleteR2Prefix = vi.fn(async () => ({ deleted: 1, durationMs: 1 }))
    const replacement = 'https://custom.example.org/tour.json'
    const { ctx } = makeCtx(client, [row.id], { 'to-url': replacement })
    const code = await runRollbackR2Tours(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(0)
    expect(handles.updateDataset).toHaveBeenCalledWith(row.id, {
      run_tour_on_load: replacement,
    })
  })

  it('--dry-run prints the plan but mutates nothing', async () => {
    const row = makeRow()
    const { client, handles } = fakeClient({ row })
    const deleteR2Prefix = vi.fn(async () => ({ deleted: 0, durationMs: 0 }))
    const { ctx, out } = makeCtx(client, [row.id], { 'dry-run': true })
    const code = await runRollbackR2Tours(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(0)
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(deleteR2Prefix).not.toHaveBeenCalled()
    expect(out.text()).toMatch(/rollback plan:/)
  })

  it('patch_failed → exit 1 and no R2 delete attempted', async () => {
    const row = makeRow()
    const { client, handles } = fakeClient({ row, patchFailFor: new Set([row.id]) })
    const deleteR2Prefix = vi.fn(async () => ({ deleted: 0, durationMs: 0 }))
    const { ctx, err } = makeCtx(client, [row.id])
    const code = await runRollbackR2Tours(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(1)
    expect(handles.updateDataset).toHaveBeenCalledTimes(1)
    expect(deleteR2Prefix).not.toHaveBeenCalled()
    expect(err.text()).toMatch(/PATCH failed/)
  })

  it('delete_failed → exit 0 (catalog correct, orphan tolerated)', async () => {
    const row = makeRow()
    const { client, handles } = fakeClient({ row })
    const deleteR2Prefix = vi.fn(async () => {
      throw new Error('R2 down')
    })
    const { ctx, err } = makeCtx(client, [row.id])
    const code = await runRollbackR2Tours(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(0) // catalog is correct; only an R2 orphan remains
    expect(handles.updateDataset).toHaveBeenCalledTimes(1)
    expect(err.text()).toMatch(/R2 prefix DELETE failed/)
  })

  it('missing R2 creds → delete_failed (orphan skipped, exit 0)', async () => {
    const row = makeRow()
    const { client, handles } = fakeClient({ row })
    const deleteR2Prefix = vi.fn(async () => ({ deleted: 0, durationMs: 0 }))
    const { ctx, err } = makeCtx(client, [row.id])
    const code = await runRollbackR2Tours(ctx, {
      r2Config: { endpoint: '', accessKeyId: '', secretAccessKey: '', bucket: '' },
      deleteR2Prefix,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(0)
    expect(handles.updateDataset).toHaveBeenCalledTimes(1) // PATCH still runs
    expect(deleteR2Prefix).not.toHaveBeenCalled()
    expect(err.text()).toMatch(/R2 credentials unset/)
  })

  it('get_failed → exit 1', async () => {
    const { client } = fakeClient({}) // no row registered
    const deleteR2Prefix = vi.fn(async () => ({ deleted: 0, durationMs: 0 }))
    const { ctx, err } = makeCtx(client, ['DS_NOPE'])
    const code = await runRollbackR2Tours(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(1)
    expect(err.text()).toMatch(/Could not GET DS_NOPE/)
  })

  it('snapshot loader failure → exit 1 (when --to-url is not set)', async () => {
    const row = makeRow()
    const { client } = fakeClient({ row })
    const deleteR2Prefix = vi.fn(async () => ({ deleted: 0, durationMs: 0 }))
    const { ctx, err } = makeCtx(client, [row.id])
    const code = await runRollbackR2Tours(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
      loadSnapshot: () => {
        throw new Error('ENOENT')
      },
    })
    expect(code).toBe(1)
    expect(err.text()).toMatch(/Could not load SOS snapshot/)
  })

  it('snapshot loader failure tolerated with --to-url', async () => {
    const row = makeRow()
    const { client } = fakeClient({ row })
    const deleteR2Prefix = vi.fn(async () => ({ deleted: 1, durationMs: 1 }))
    const { ctx } = makeCtx(client, [row.id], {
      'to-url': 'https://override.example/tour.json',
    })
    const code = await runRollbackR2Tours(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
      loadSnapshot: () => {
        throw new Error('ENOENT')
      },
    })
    expect(code).toBe(0)
  })

  it('missing positional dataset id → usage exit 2', async () => {
    const { client } = fakeClient({})
    const { ctx, err } = makeCtx(client, [])
    const code = await runRollbackR2Tours(ctx, {
      r2Config: R2_CONFIG,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(2)
    expect(err.text()).toMatch(/Usage:/)
  })
})

describe('runRollbackR2Tours — bulk --from-stdin', () => {
  it('reads NDJSON, rolls back each row, prints aggregate summary', async () => {
    const rows = {
      DS_A: makeRow({ id: 'DS_A', legacy_id: 'INTERNAL_SOS_MARIA_360', run_tour_on_load: 'r2:tours/DS_A/tour.json' }),
      DS_B: makeRow({ id: 'DS_B', legacy_id: 'INTERNAL_SOS_768', run_tour_on_load: 'r2:tours/DS_B/tour.json' }),
    }
    const { client, handles } = fakeClient({ rowsById: rows })
    const deleteR2Prefix = vi.fn(async () => ({ deleted: 1, durationMs: 1 }))
    const stdin = `{"dataset_id":"DS_A"}\n{"dataset_id":"DS_B"}\n`
    const { ctx, out } = makeCtx(client, [], { 'from-stdin': true })
    const code = await runRollbackR2Tours(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
      readStdin: async () => stdin,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(0)
    expect(handles.updateDataset).toHaveBeenCalledTimes(2)
    expect(deleteR2Prefix).toHaveBeenCalledTimes(2)
    expect(out.text()).toMatch(/Bulk tour rollback complete:[\s\S]*ok:\s+2/)
  })

  it('continues past per-row failures and surfaces hard-failure exit', async () => {
    // DS_A rolls back fine; DS_BAD doesn't exist; DS_WRONG is on
    // a bare URL.
    const rows: Record<string, RowState> = {
      DS_A: makeRow({ id: 'DS_A', run_tour_on_load: 'r2:tours/DS_A/tour.json' }),
      DS_WRONG: makeRow({ id: 'DS_WRONG', run_tour_on_load: NOAA_TOUR }),
    }
    const { client, handles } = fakeClient({ rowsById: rows })
    const deleteR2Prefix = vi.fn(async () => ({ deleted: 1, durationMs: 1 }))
    const stdin =
      `{"dataset_id":"DS_A"}\n` +
      `{"dataset_id":"DS_BAD"}\n` +
      `{"dataset_id":"DS_WRONG"}\n`
    const { ctx, out } = makeCtx(client, [], { 'from-stdin': true })
    const code = await runRollbackR2Tours(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
      readStdin: async () => stdin,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(1) // get_failed + wrong_scheme are hard failures
    expect(handles.updateDataset).toHaveBeenCalledTimes(1) // DS_A only
    expect(out.text()).toMatch(/ok:\s+1/)
    expect(out.text()).toMatch(/get_failed:\s+1/)
    expect(out.text()).toMatch(/wrong_scheme:\s+1/)
  })

  it('counts parse_failed entries and continues', async () => {
    const { client } = fakeClient({})
    const deleteR2Prefix = vi.fn(async () => ({ deleted: 0, durationMs: 0 }))
    const stdin = `not json\n{"oops":"missing dataset_id"}\n{"dataset_id":""}\n`
    const { ctx, out, err } = makeCtx(client, [], { 'from-stdin': true })
    const code = await runRollbackR2Tours(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
      readStdin: async () => stdin,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(1)
    expect(out.text()).toMatch(/parse_failed:\s+3/)
    expect(err.text()).toMatch(/parse error/)
  })

  it('--from-stdin rejects positional dataset id with exit 2', async () => {
    const { client } = fakeClient({})
    const { ctx, err } = makeCtx(client, ['DS_X'], { 'from-stdin': true })
    const code = await runRollbackR2Tours(ctx, {
      r2Config: R2_CONFIG,
      readStdin: async () => '',
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(2)
    expect(err.text()).toMatch(/does not accept a positional/)
  })

  it('--from-stdin rejects --to-url with exit 2', async () => {
    const { client } = fakeClient({})
    const { ctx, err } = makeCtx(client, [], {
      'from-stdin': true,
      'to-url': 'https://x.example/tour.json',
    })
    const code = await runRollbackR2Tours(ctx, {
      r2Config: R2_CONFIG,
      readStdin: async () => '',
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(2)
    expect(err.text()).toMatch(/does not accept --to-url/)
  })

  it('empty stdin → exit 0 with informational note', async () => {
    const { client } = fakeClient({})
    const { ctx, err } = makeCtx(client, [], { 'from-stdin': true })
    const code = await runRollbackR2Tours(ctx, {
      r2Config: R2_CONFIG,
      readStdin: async () => '',
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(0)
    expect(err.text()).toMatch(/received empty input/)
  })
})
