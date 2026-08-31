// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for `terraviz rollback-r2-assets` (Phase 3b commit I).
 *
 * Coverage:
 *   - Single-row mode: walks types (default all 4); only r2:-prefixed
 *     columns get rolled back; non-r2: columns produce
 *     wrong_scheme (informational, not exit-1).
 *   - Snapshot recovery: legacy_id → SOS link field mapping.
 *   - --to-url override (requires --types=<single-type>).
 *   - not_in_snapshot: row's legacy_id absent or the matching
 *     snapshot field is missing.
 *   - PATCH failure → exit 1 + no R2 delete attempted.
 *   - DELETE failure (R2 down) → exit 0 (catalog correct,
 *     orphan tolerated) with delete_failed counted.
 *   - Missing R2 creds → delete_failed (orphan skipped, not
 *     attempted).
 *   - Bulk --from-stdin: NDJSON parsing, continues past per-row
 *     failures, aggregate summary.
 *   - --from-stdin rejects positional / --types / --to-url
 *     combinations as usage errors.
 *   - Snapshot loader failure: 1 (without --to-url); tolerated
 *     when --to-url is set (single-row only — bulk requires
 *     the snapshot).
 */

import { describe, expect, it, vi } from 'vitest'
import { runRollbackR2Assets } from './rollback-r2-assets'
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

const NOAA_THUMB = 'https://d3sik7mbbzunjo.cloudfront.net/x/thumb.jpg'
const NOAA_LEGEND = 'https://d3sik7mbbzunjo.cloudfront.net/x/legend.png'
const NOAA_CAPTION = 'https://d3sik7mbbzunjo.cloudfront.net/extras/x.srt'
const NOAA_COLOR = 'https://d3sik7mbbzunjo.cloudfront.net/x/colortable.png'

const SNAPSHOT = [
  {
    id: 'INTERNAL_SOS_768',
    thumbnailLink: NOAA_THUMB,
    legendLink: NOAA_LEGEND,
    closedCaptionLink: NOAA_CAPTION,
    colorTableLink: NOAA_COLOR,
  },
]

interface RowState {
  id: string
  legacy_id: string
  title?: string
  thumbnail_ref: string | null
  legend_ref: string | null
  caption_ref: string | null
  color_table_ref: string | null
}

function makeRow(over: Partial<RowState> = {}): RowState {
  return {
    id: 'DS00001AAAAAAAAAAAAAAAAAAAAA',
    legacy_id: 'INTERNAL_SOS_768',
    title: 'Hurricane Season',
    thumbnail_ref: 'r2:datasets/DS00001AAAAAAAAAAAAAAAAAAAAA/thumbnail.jpg',
    legend_ref: 'r2:datasets/DS00001AAAAAAAAAAAAAAAAAAAAA/legend.png',
    caption_ref: null,
    color_table_ref: null,
    ...over,
  }
}

interface FakeClientOptions {
  row?: RowState
  patchFailFor?: Set<string>
}

function fakeClient(opts: FakeClientOptions = {}) {
  const get = vi.fn(async (_id: string) => {
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

describe('runRollbackR2Assets — single-row', () => {
  it('rolls back every r2: column on the row by default', async () => {
    const row = makeRow({
      thumbnail_ref: 'r2:datasets/X/thumbnail.jpg',
      legend_ref: 'r2:datasets/X/legend.png',
      caption_ref: 'r2:datasets/X/caption.vtt',
      color_table_ref: 'r2:datasets/X/color-table.png',
    })
    const { client, handles } = fakeClient({ row })
    const deleteR2Object = vi.fn(async () => ({ key: 'x', durationMs: 1 }))
    const { ctx } = makeCtx(client, [row.id])
    const code = await runRollbackR2Assets(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Object,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(0)
    expect(handles.updateDataset).toHaveBeenCalledTimes(4)
    expect(deleteR2Object).toHaveBeenCalledTimes(4)
    // Each PATCH targets one column and points it back at the
    // matching NOAA URL recovered from the snapshot.
    const patchBodies = handles.updateDataset.mock.calls.map(c => c[1] as Record<string, unknown>)
    const merged = Object.assign({}, ...patchBodies)
    expect(merged).toMatchObject({
      thumbnail_ref: NOAA_THUMB,
      legend_ref: NOAA_LEGEND,
      caption_ref: NOAA_CAPTION,
      color_table_ref: NOAA_COLOR,
    })
  })

  it('--types restricts which columns get rolled back', async () => {
    const row = makeRow({
      thumbnail_ref: 'r2:datasets/X/thumbnail.jpg',
      legend_ref: 'r2:datasets/X/legend.png',
    })
    const { client, handles } = fakeClient({ row })
    const deleteR2Object = vi.fn(async () => ({ key: 'x', durationMs: 1 }))
    const { ctx } = makeCtx(client, [row.id], { types: 'thumbnail' })
    await runRollbackR2Assets(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Object,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(handles.updateDataset).toHaveBeenCalledTimes(1)
    expect(handles.updateDataset.mock.calls[0][1]).toMatchObject({
      thumbnail_ref: NOAA_THUMB,
    })
    expect(deleteR2Object).toHaveBeenCalledTimes(1)
  })

  it('wrong_scheme: skips columns that are not on r2: without failing the run', async () => {
    // thumbnail is on r2: (will roll back). legend is already on
    // the bare URL (publisher edited?). caption/color_table are
    // null. The row's default types=all run touches thumbnail
    // only; legend/caption/color_table emit wrong_scheme but
    // exit code stays 0 (caller error per asset, not a
    // hard failure).
    const row = makeRow({
      thumbnail_ref: 'r2:datasets/X/thumbnail.jpg',
      legend_ref: NOAA_LEGEND, // already bare URL
      caption_ref: null,
      color_table_ref: null,
    })
    const { client, handles } = fakeClient({ row })
    const deleteR2Object = vi.fn(async () => ({ key: 'x', durationMs: 1 }))
    const { ctx, err } = makeCtx(client, [row.id])
    const code = await runRollbackR2Assets(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Object,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(0)
    expect(handles.updateDataset).toHaveBeenCalledTimes(1) // thumbnail only
    expect(err.text()).toContain('legend_ref')
    expect(err.text()).toContain('not r2:')
  })

  it('--to-url overrides the snapshot recovery (requires --types=single)', async () => {
    const row = makeRow({
      thumbnail_ref: 'r2:datasets/X/thumbnail.jpg',
      legend_ref: null,
    })
    const { client, handles } = fakeClient({ row })
    const deleteR2Object = vi.fn(async () => ({ key: 'x', durationMs: 1 }))
    const { ctx } = makeCtx(client, [row.id], {
      types: 'thumbnail',
      'to-url': 'https://custom.example.org/replacement.png',
    })
    const code = await runRollbackR2Assets(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Object,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(0)
    expect(handles.updateDataset.mock.calls[0][1]).toMatchObject({
      thumbnail_ref: 'https://custom.example.org/replacement.png',
    })
  })

  it('--to-url without --types=single is rejected', async () => {
    const { client } = fakeClient({ row: makeRow() })
    const { ctx, err } = makeCtx(client, ['DS_X'], {
      'to-url': 'https://custom.example.org/x.png',
    })
    const code = await runRollbackR2Assets(ctx, {
      r2Config: R2_CONFIG,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(2)
    expect(err.text()).toContain('--to-url requires --types=<single-type>')
  })

  it('not_in_snapshot: missing legacy_id surfaces an actionable error', async () => {
    const row = makeRow({
      legacy_id: '',
      thumbnail_ref: 'r2:datasets/X/thumbnail.jpg',
    })
    const { client } = fakeClient({ row })
    const { ctx, err } = makeCtx(client, [row.id], { types: 'thumbnail' })
    const code = await runRollbackR2Assets(ctx, {
      r2Config: R2_CONFIG,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(1)
    expect(err.text()).toMatch(/cannot recover thumbnail URL.*--to-url/)
  })

  it('patch_failed: exit 1, no R2 delete attempted', async () => {
    const row = makeRow({
      thumbnail_ref: 'r2:datasets/X/thumbnail.jpg',
      legend_ref: null,
      caption_ref: null,
      color_table_ref: null,
    })
    const { client, handles } = fakeClient({
      row,
      patchFailFor: new Set([row.id]),
    })
    const deleteR2Object = vi.fn(async () => ({ key: 'x', durationMs: 1 }))
    const { ctx, err } = makeCtx(client, [row.id], { types: 'thumbnail' })
    const code = await runRollbackR2Assets(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Object,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(1)
    expect(handles.updateDataset).toHaveBeenCalledTimes(1)
    expect(deleteR2Object).not.toHaveBeenCalled()
    expect(err.text()).toContain('PATCH failed')
  })

  it('delete_failed: exit 0 (catalog correct, orphan tolerated)', async () => {
    const row = makeRow({
      thumbnail_ref: 'r2:datasets/X/thumbnail.jpg',
      legend_ref: null,
      caption_ref: null,
      color_table_ref: null,
    })
    const { client, handles } = fakeClient({ row })
    const deleteR2Object = vi.fn(async () => {
      throw new Error('R2 unreachable')
    })
    const { ctx, err } = makeCtx(client, [row.id], { types: 'thumbnail' })
    const code = await runRollbackR2Assets(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Object,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(0) // delete_failed is non-fatal
    expect(handles.updateDataset).toHaveBeenCalledTimes(1)
    expect(err.text()).toContain('R2 DELETE failed')
    expect(err.text()).toContain('orphan')
  })

  it('R2 creds missing: PATCH commits, orphan tolerated, exit 0', async () => {
    const row = makeRow({
      thumbnail_ref: 'r2:datasets/X/thumbnail.jpg',
      legend_ref: null,
      caption_ref: null,
      color_table_ref: null,
    })
    const { client } = fakeClient({ row })
    const deleteR2Object = vi.fn()
    const { ctx, err } = makeCtx(client, [row.id], { types: 'thumbnail' })
    const code = await runRollbackR2Assets(ctx, {
      r2Config: { ...R2_CONFIG, accessKeyId: '' },
      deleteR2Object,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(0)
    expect(deleteR2Object).not.toHaveBeenCalled()
    expect(err.text()).toContain('R2 credentials unset')
  })

  it('get_failed: exit 1 when the row is not found', async () => {
    const { client } = fakeClient({})
    const { ctx, err } = makeCtx(client, ['DS_MISSING'], { types: 'thumbnail' })
    const code = await runRollbackR2Assets(ctx, {
      r2Config: R2_CONFIG,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(1)
    expect(err.text()).toContain('Could not GET DS_MISSING')
  })

  it('exits 2 when neither positional dataset id nor --from-stdin is given', async () => {
    const { client } = fakeClient({})
    const { ctx, err } = makeCtx(client, [])
    const code = await runRollbackR2Assets(ctx, {
      r2Config: R2_CONFIG,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(2)
    expect(err.text()).toMatch(/Usage:/)
  })

  it('unknown --types value rejected with exit 2', async () => {
    const { client } = fakeClient({ row: makeRow() })
    const { ctx, err } = makeCtx(client, ['DS_X'], { types: 'bogus' })
    const code = await runRollbackR2Assets(ctx, {
      r2Config: R2_CONFIG,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(2)
    expect(err.text()).toMatch(/unknown asset type "bogus"/)
  })
})

describe('runRollbackR2Assets — bulk --from-stdin', () => {
  const ROW_A: RowState = {
    id: 'DS_A',
    legacy_id: 'INTERNAL_SOS_768',
    thumbnail_ref: 'r2:datasets/DS_A/thumbnail.jpg',
    legend_ref: 'r2:datasets/DS_A/legend.png',
    caption_ref: null,
    color_table_ref: null,
  }

  function bulkClient(rows: RowState[]) {
    const byId = new Map(rows.map(r => [r.id, r]))
    const get = vi.fn(async (id: string) => {
      const row = byId.get(id)
      if (!row) return { ok: false as const, status: 404, error: 'not_found' }
      return { ok: true as const, status: 200, body: { dataset: row } }
    })
    const updateDataset = vi.fn(async (id: string, body: Record<string, unknown>) => ({
      ok: true as const,
      status: 200,
      body: { dataset: { id, slug: `slug-${id}`, ...body } },
    }))
    return {
      client: { serverUrl: 'http://localhost:8788', get, updateDataset } as unknown as TerravizClient,
      handles: { get, updateDataset },
    }
  }

  it('rolls back each NDJSON entry in order', async () => {
    const { client, handles } = bulkClient([ROW_A])
    const deleteR2Object = vi.fn(async () => ({ key: 'x', durationMs: 1 }))
    const stdin =
      JSON.stringify({ dataset_id: 'DS_A', asset_type: 'thumbnail' }) +
      '\n' +
      JSON.stringify({ dataset_id: 'DS_A', asset_type: 'legend' }) +
      '\n'
    const { ctx, out } = makeCtx(client, [], { 'from-stdin': true })
    const code = await runRollbackR2Assets(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Object,
      readStdin: async () => stdin,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(0)
    expect(handles.updateDataset).toHaveBeenCalledTimes(2)
    expect(deleteR2Object).toHaveBeenCalledTimes(2)
    expect(out.text()).toContain('Bulk asset rollback: 2 entry(ies) from stdin.')
    expect(out.text()).toContain('ok:                       2')
  })

  it('parse errors counted; valid lines still processed', async () => {
    const { client, handles } = bulkClient([ROW_A])
    const deleteR2Object = vi.fn(async () => ({ key: 'x', durationMs: 1 }))
    const stdin =
      'not-json\n' +
      JSON.stringify({ dataset_id: 'DS_A' }) + // missing asset_type
      '\n' +
      JSON.stringify({ dataset_id: 'DS_A', asset_type: 'bogus' }) + // bad asset_type
      '\n' +
      JSON.stringify({ dataset_id: 'DS_A', asset_type: 'thumbnail' }) +
      '\n'
    const { ctx, out, err } = makeCtx(client, [], { 'from-stdin': true })
    const code = await runRollbackR2Assets(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Object,
      readStdin: async () => stdin,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(1) // parse_failed > 0
    expect(handles.updateDataset).toHaveBeenCalledTimes(1)
    expect(out.text()).toContain('ok:                       1')
    expect(out.text()).toContain('parse_failed:             3')
    expect(err.text()).toContain('[line 1] parse error')
    expect(err.text()).toContain('[line 2] parse error')
    expect(err.text()).toContain('[line 3] parse error')
  })

  it('--from-stdin + positional dataset id rejected', async () => {
    const { client } = bulkClient([])
    const { ctx, err } = makeCtx(client, ['DS_X'], { 'from-stdin': true })
    const code = await runRollbackR2Assets(ctx, {
      r2Config: R2_CONFIG,
      readStdin: async () => '',
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(2)
    expect(err.text()).toContain('--from-stdin does not accept a positional dataset id')
  })

  it('--from-stdin + --types rejected', async () => {
    const { client } = bulkClient([])
    const { ctx, err } = makeCtx(client, [], {
      'from-stdin': true,
      types: 'thumbnail',
    })
    const code = await runRollbackR2Assets(ctx, {
      r2Config: R2_CONFIG,
      readStdin: async () => '',
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(2)
    expect(err.text()).toContain('--from-stdin does not accept --types')
  })

  it('empty stdin returns 0', async () => {
    const { client } = bulkClient([])
    const { ctx, err } = makeCtx(client, [], { 'from-stdin': true })
    const code = await runRollbackR2Assets(ctx, {
      r2Config: R2_CONFIG,
      readStdin: async () => '',
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(0)
    expect(err.text()).toContain('Nothing to roll back')
  })

  it('--dry-run does not mutate', async () => {
    const { client, handles } = bulkClient([ROW_A])
    const deleteR2Object = vi.fn()
    const stdin = JSON.stringify({ dataset_id: 'DS_A', asset_type: 'thumbnail' }) + '\n'
    const { ctx } = makeCtx(client, [], { 'from-stdin': true, 'dry-run': true })
    const code = await runRollbackR2Assets(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Object,
      readStdin: async () => stdin,
      loadSnapshot: () => SNAPSHOT,
    })
    expect(code).toBe(0)
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(deleteR2Object).not.toHaveBeenCalled()
  })
})

describe('runRollbackR2Assets — snapshot loader failure', () => {
  it('exits 1 when snapshot is unloadable AND --to-url is absent', async () => {
    const { client } = fakeClient({ row: makeRow() })
    const { ctx, err } = makeCtx(client, ['DS_X'], { types: 'thumbnail' })
    const code = await runRollbackR2Assets(ctx, {
      r2Config: R2_CONFIG,
      loadSnapshot: () => {
        throw new Error('ENOENT')
      },
    })
    expect(code).toBe(1)
    expect(err.text()).toContain('Could not load SOS snapshot')
    expect(err.text()).toContain('--to-url')
  })

  it('tolerates a broken snapshot when --to-url is provided', async () => {
    // Operator wants to surgically roll back a single asset and
    // doesn't care about the SOS snapshot at all (non-SOS catalog).
    const row = makeRow({
      thumbnail_ref: 'r2:datasets/X/thumbnail.jpg',
      legend_ref: null,
      caption_ref: null,
      color_table_ref: null,
    })
    const { client, handles } = fakeClient({ row })
    const deleteR2Object = vi.fn(async () => ({ key: 'x', durationMs: 1 }))
    const { ctx } = makeCtx(client, [row.id], {
      types: 'thumbnail',
      'to-url': 'https://custom.example.org/x.png',
    })
    const code = await runRollbackR2Assets(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Object,
      loadSnapshot: () => {
        throw new Error('snapshot file missing')
      },
    })
    expect(code).toBe(0)
    expect(handles.updateDataset).toHaveBeenCalledTimes(1)
  })
})
