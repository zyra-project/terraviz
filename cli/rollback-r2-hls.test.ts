// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for `terraviz rollback-r2-hls` (Phase 3 commit F).
 *
 * Coverage:
 *   - Argument validation (missing dataset_id; missing /
 *     non-numeric --to-vimeo)
 *   - GET failure exits 1, no mutations
 *   - Refuses non-r2: data_refs (already on vimeo:, on url:, etc.)
 *   - --dry-run prints plan, no mutations
 *   - Happy path: PATCH then DELETE both succeed
 *   - PATCH failure: exit 1, DELETE never attempted
 *   - DELETE failure: soft-fail, exit 0, data_ref still flipped
 *   - Missing R2 credentials: exit 0 with orphan warning
 *   - Commit-point ordering pinned (PATCH always before DELETE)
 */

import { describe, expect, it, vi } from 'vitest'
import { runRollbackR2Hls } from './rollback-r2-hls'
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

interface RowState {
  id: string
  data_ref: string
  title?: string
}

interface FakeClientOptions {
  row?: RowState
  getFails?: boolean
  patchFails?: boolean
}

function fakeClient(opts: FakeClientOptions = {}) {
  const get = vi.fn(async (_id: string) => {
    if (opts.getFails) {
      return { ok: false as const, status: 404, error: 'not_found' }
    }
    if (!opts.row) {
      return { ok: false as const, status: 404, error: 'not_found' }
    }
    return { ok: true as const, status: 200, body: { dataset: opts.row } }
  })
  const updateDataset = vi.fn(async (id: string, body: Record<string, unknown>) => {
    if (opts.patchFails) {
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
    else argv.push(`--${k}=${String(v)}`)
  }
  const args = parseArgs(argv)
  return { ctx: { client, args, stdout: out, stderr: err }, out, err }
}

const DS_ID = 'DS00001AAAAAAAAAAAAAAAAAAAAA'
const VIMEO_ID = '808489116'
const MIGRATED_ROW: RowState = {
  id: DS_ID,
  data_ref: `r2:videos/${DS_ID}/master.m3u8`,
  title: 'Tsunami: Asteroid Impact',
}

describe('runRollbackR2Hls — argument validation', () => {
  it('exits 2 when no dataset id is given', async () => {
    const { client } = fakeClient()
    const { ctx, err } = makeCtx(client, [], { 'to-vimeo': VIMEO_ID })
    const code = await runRollbackR2Hls(ctx, { r2Config: R2_CONFIG })
    expect(code).toBe(2)
    expect(err.text()).toContain('Usage:')
  })

  it('exits 2 when --to-vimeo is missing', async () => {
    const { client } = fakeClient()
    const { ctx, err } = makeCtx(client, [DS_ID])
    const code = await runRollbackR2Hls(ctx, { r2Config: R2_CONFIG })
    expect(code).toBe(2)
    expect(err.text()).toContain('--to-vimeo')
  })

  it('exits 2 when --to-vimeo is non-numeric', async () => {
    const { client } = fakeClient()
    const { ctx, err } = makeCtx(client, [DS_ID], { 'to-vimeo': 'not-a-number' })
    const code = await runRollbackR2Hls(ctx, { r2Config: R2_CONFIG })
    expect(code).toBe(2)
    expect(err.text()).toContain('must be a numeric Vimeo id')
  })
})

describe('runRollbackR2Hls — plan validation', () => {
  it('exits 1 when the GET fails', async () => {
    const { client, handles } = fakeClient({ getFails: true })
    const { ctx, err } = makeCtx(client, [DS_ID], { 'to-vimeo': VIMEO_ID })
    const code = await runRollbackR2Hls(ctx, { r2Config: R2_CONFIG })
    expect(code).toBe(1)
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(err.text()).toContain('Could not GET')
  })

  it('refuses when data_ref is already on vimeo:', async () => {
    const { client, handles } = fakeClient({
      row: { id: DS_ID, data_ref: 'vimeo:123456' },
    })
    const { ctx, err } = makeCtx(client, [DS_ID], { 'to-vimeo': VIMEO_ID })
    const code = await runRollbackR2Hls(ctx, { r2Config: R2_CONFIG })
    expect(code).toBe(2)
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(err.text()).toContain('Nothing to roll back')
  })

  it('refuses when data_ref is on a non-r2-videos scheme (url:, stream:)', async () => {
    const { client, handles } = fakeClient({
      row: { id: DS_ID, data_ref: 'stream:abc123' },
    })
    const { ctx, err } = makeCtx(client, [DS_ID], { 'to-vimeo': VIMEO_ID })
    const code = await runRollbackR2Hls(ctx, { r2Config: R2_CONFIG })
    expect(code).toBe(2)
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(err.text()).toContain('Nothing to roll back')
  })

  it('refuses r2: refs that do not target the videos/ prefix', async () => {
    // Image r2: refs use `r2:datasets/...` — not migration territory.
    const { client, handles } = fakeClient({
      row: { id: DS_ID, data_ref: 'r2:datasets/x/asset.png' },
    })
    const { ctx, err } = makeCtx(client, [DS_ID], { 'to-vimeo': VIMEO_ID })
    const code = await runRollbackR2Hls(ctx, { r2Config: R2_CONFIG })
    expect(code).toBe(2)
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(err.text()).toContain('Nothing to roll back')
  })
})

describe('runRollbackR2Hls — dry-run', () => {
  it('prints the plan and exits 0 without mutating', async () => {
    const { client, handles } = fakeClient({ row: MIGRATED_ROW })
    const deleteR2Prefix = vi.fn()
    const { ctx, out } = makeCtx(client, [DS_ID], {
      'to-vimeo': VIMEO_ID,
      'dry-run': true,
    })
    const code = await runRollbackR2Hls(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
    })
    expect(code).toBe(0)
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(deleteR2Prefix).not.toHaveBeenCalled()
    expect(out.text()).toContain('Rollback plan:')
    expect(out.text()).toContain(`vimeo:${VIMEO_ID}`)
    expect(out.text()).toContain(`videos/${DS_ID}/`)
    expect(out.text()).toContain('Dry run')
  })
})

describe('runRollbackR2Hls — live rollback', () => {
  it('PATCHes data_ref then deletes the R2 prefix (happy path, commit ordering)', async () => {
    const { client, handles } = fakeClient({ row: MIGRATED_ROW })
    const callOrder: string[] = []
    handles.updateDataset.mockImplementationOnce(async (id, body) => {
      callOrder.push('patch')
      return {
        ok: true as const,
        status: 200,
        body: { dataset: { id, slug: 's', ...body } },
      }
    })
    const deleteR2Prefix = vi.fn(async () => {
      callOrder.push('delete')
      return { deleted: 12, durationMs: 1500 }
    })
    const { ctx, out, err } = makeCtx(client, [DS_ID], { 'to-vimeo': VIMEO_ID })
    const code = await runRollbackR2Hls(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix: deleteR2Prefix as unknown as typeof import('./lib/r2-upload').deleteR2Prefix,
    })
    expect(code).toBe(0)
    // Commit-point ordering invariant: PATCH always before DELETE.
    expect(callOrder).toEqual(['patch', 'delete'])
    expect(handles.updateDataset).toHaveBeenCalledWith(DS_ID, {
      data_ref: `vimeo:${VIMEO_ID}`,
    })
    // The prefix passed to deleteR2Prefix strips the master.m3u8
    // filename, leaving just the bundle's directory.
    expect(deleteR2Prefix).toHaveBeenCalledWith(R2_CONFIG, `videos/${DS_ID}`)
    expect(out.text()).toContain('✓ data_ref flipped')
    expect(out.text()).toContain('deleted 12 R2 object(s)')
    expect(out.text()).toContain('Rollback complete')
    expect(err.text()).toBe('')
  })

  it('exits 1 when the PATCH fails — never attempts DELETE', async () => {
    const { client, handles } = fakeClient({ row: MIGRATED_ROW, patchFails: true })
    const deleteR2Prefix = vi.fn()
    const { ctx, err } = makeCtx(client, [DS_ID], { 'to-vimeo': VIMEO_ID })
    const code = await runRollbackR2Hls(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
    })
    expect(code).toBe(1)
    expect(handles.updateDataset).toHaveBeenCalledTimes(1)
    expect(deleteR2Prefix).not.toHaveBeenCalled()
    expect(err.text()).toContain('data_ref PATCH failed (503)')
  })

  it('soft-fails on DELETE failure — exit 0, data_ref still flipped', async () => {
    const { client, handles } = fakeClient({ row: MIGRATED_ROW })
    const deleteR2Prefix = vi.fn(async () => {
      throw new Error('R2 LIST timed out')
    })
    const { ctx, err, out } = makeCtx(client, [DS_ID], { 'to-vimeo': VIMEO_ID })
    const code = await runRollbackR2Hls(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix: deleteR2Prefix as unknown as typeof import('./lib/r2-upload').deleteR2Prefix,
    })
    expect(code).toBe(0)
    expect(handles.updateDataset).toHaveBeenCalledTimes(1)
    expect(out.text()).toContain('✓ data_ref flipped')
    expect(err.text()).toContain('Could not delete R2 prefix')
    expect(err.text()).toContain('delete the orphan')
  })

  it('warns about orphan and skips DELETE when R2 creds are absent', async () => {
    const prev = {
      end: process.env.R2_S3_ENDPOINT,
      ak: process.env.R2_ACCESS_KEY_ID,
      sk: process.env.R2_SECRET_ACCESS_KEY,
    }
    delete process.env.R2_S3_ENDPOINT
    delete process.env.R2_ACCESS_KEY_ID
    delete process.env.R2_SECRET_ACCESS_KEY
    try {
      const { client, handles } = fakeClient({ row: MIGRATED_ROW })
      const deleteR2Prefix = vi.fn()
      const { ctx, err } = makeCtx(client, [DS_ID], { 'to-vimeo': VIMEO_ID })
      const code = await runRollbackR2Hls(ctx, { deleteR2Prefix })
      expect(code).toBe(0)
      expect(handles.updateDataset).toHaveBeenCalledTimes(1)
      expect(deleteR2Prefix).not.toHaveBeenCalled()
      expect(err.text()).toContain('R2 credentials unset')
      expect(err.text()).toContain('orphan')
    } finally {
      if (prev.end !== undefined) process.env.R2_S3_ENDPOINT = prev.end
      if (prev.ak !== undefined) process.env.R2_ACCESS_KEY_ID = prev.ak
      if (prev.sk !== undefined) process.env.R2_SECRET_ACCESS_KEY = prev.sk
    }
  })
})

describe('runRollbackR2Hls — --from-stdin bulk mode (3a/C)', () => {
  // Per-row snapshot: a fakeClient configured with a row table
  // for multi-id GET resolution. Each row's data_ref starts on
  // r2:videos/, the bulk path GETs each id, PATCHes back to
  // vimeo:, and DELETEs the R2 prefix.
  function bulkClient(rows: RowState[], opts: { patchFailFor?: Set<string> } = {}) {
    const byId = new Map(rows.map(r => [r.id, r]))
    const get = vi.fn(async (id: string) => {
      const row = byId.get(id)
      if (!row) return { ok: false as const, status: 404, error: 'not_found' }
      return { ok: true as const, status: 200, body: { dataset: row } }
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

  const ROW_A: RowState = {
    id: 'DS00010AAAAAAAAAAAAAAAAAAAAA',
    data_ref: 'r2:videos/DS00010AAAAAAAAAAAAAAAAAAAAA/master.m3u8',
    title: 'Sea Surface Temperature - Real-time',
  }
  const ROW_B: RowState = {
    id: 'DS00011AAAAAAAAAAAAAAAAAAAAA',
    data_ref: 'r2:videos/DS00011AAAAAAAAAAAAAAAAAAAAA/master.m3u8',
    title: 'Precipitation - Real-time',
  }

  it('rolls back every NDJSON row in order; aggregate report is `ok: N`', async () => {
    const { client, handles } = bulkClient([ROW_A, ROW_B])
    const deleteR2Prefix = vi.fn(async (_c, _k) => ({ deleted: 5, durationMs: 100 }))
    const stdin =
      JSON.stringify({ dataset_id: ROW_A.id, vimeo_id: '111111111' }) +
      '\n' +
      JSON.stringify({ dataset_id: ROW_B.id, vimeo_id: '222222222' }) +
      '\n'
    const { ctx, out, err } = makeCtx(client, [], { 'from-stdin': true })
    const code = await runRollbackR2Hls(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
      readStdin: async () => stdin,
    })
    expect(code).toBe(0)
    // Both rows fetched + PATCHed + DELETEd in order.
    expect(handles.get).toHaveBeenCalledTimes(2)
    expect(handles.updateDataset).toHaveBeenCalledTimes(2)
    expect(handles.updateDataset.mock.calls[0]).toEqual([
      ROW_A.id,
      { data_ref: 'vimeo:111111111' },
    ])
    expect(handles.updateDataset.mock.calls[1]).toEqual([
      ROW_B.id,
      { data_ref: 'vimeo:222222222' },
    ])
    expect(deleteR2Prefix).toHaveBeenCalledTimes(2)
    // Headline + per-row progress + summary present.
    expect(out.text()).toContain('Bulk rollback: 2 row(s) from stdin.')
    expect(out.text()).toContain(`[1/2] ${ROW_A.id} → vimeo:111111111`)
    expect(out.text()).toContain(`[2/2] ${ROW_B.id} → vimeo:222222222`)
    expect(out.text()).toContain('ok:                       2')
    expect(err.text()).toBe('')
  })

  it('continues past a failed row and returns 1 in the summary', async () => {
    // ROW_A succeeds; ROW_B's PATCH fails. Bulk path should
    // continue past the failure (not abort), tally counts, and
    // return 1 because at least one row failed.
    const { client, handles } = bulkClient([ROW_A, ROW_B], { patchFailFor: new Set([ROW_B.id]) })
    const deleteR2Prefix = vi.fn(async () => ({ deleted: 1, durationMs: 100 }))
    const stdin =
      JSON.stringify({ dataset_id: ROW_A.id, vimeo_id: '111111111' }) +
      '\n' +
      JSON.stringify({ dataset_id: ROW_B.id, vimeo_id: '222222222' }) +
      '\n'
    const { ctx, out, err } = makeCtx(client, [], { 'from-stdin': true })
    const code = await runRollbackR2Hls(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
      readStdin: async () => stdin,
    })
    expect(code).toBe(1)
    // Both rows attempted (didn't abort on first failure).
    expect(handles.updateDataset).toHaveBeenCalledTimes(2)
    // ROW_A's DELETE ran (PATCH succeeded); ROW_B's didn't (PATCH failed).
    expect(deleteR2Prefix).toHaveBeenCalledTimes(1)
    expect(out.text()).toContain('ok:                       1')
    expect(out.text()).toContain('patch_failed:             1')
    expect(err.text()).toContain('data_ref PATCH failed')
  })

  it('counts parse errors separately and continues', async () => {
    const { client, handles } = bulkClient([ROW_A])
    const deleteR2Prefix = vi.fn(async () => ({ deleted: 0, durationMs: 100 }))
    const stdin =
      'not-json-at-all\n' +
      JSON.stringify({ vimeo_id: '111' }) + // missing dataset_id
      '\n' +
      JSON.stringify({ dataset_id: ROW_A.id, vimeo_id: 'not-numeric' }) +
      '\n' +
      JSON.stringify({ dataset_id: ROW_A.id, vimeo_id: '' }) +
      '\n' +
      JSON.stringify({ dataset_id: ROW_A.id, vimeo_id: '111111111' }) +
      '\n'
    const { ctx, out, err } = makeCtx(client, [], { 'from-stdin': true })
    const code = await runRollbackR2Hls(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
      readStdin: async () => stdin,
    })
    expect(code).toBe(1) // parse_failed > 0 → exit 1
    // Only the last (well-formed) row was actually rolled back.
    expect(handles.updateDataset).toHaveBeenCalledTimes(1)
    expect(out.text()).toContain('ok:                       1')
    expect(out.text()).toContain('parse_failed:             4')
    expect(err.text()).toContain('[line 1] parse error')
    expect(err.text()).toContain('[line 2] parse error — missing or empty dataset_id')
    expect(err.text()).toContain('[line 3] parse error')
    expect(err.text()).toContain('[line 4] parse error — missing or empty vimeo_id')
  })

  it('--from-stdin + positional dataset_id is rejected as a usage error', async () => {
    const { client } = bulkClient([])
    const { ctx, err } = makeCtx(client, ['DS_ANYTHING'], { 'from-stdin': true })
    const code = await runRollbackR2Hls(ctx, {
      r2Config: R2_CONFIG,
      readStdin: async () => '',
    })
    expect(code).toBe(2)
    expect(err.text()).toContain('--from-stdin does not accept a positional dataset id')
  })

  it('--from-stdin + --to-vimeo is rejected as a usage error', async () => {
    const { client } = bulkClient([])
    const { ctx, err } = makeCtx(client, [], {
      'from-stdin': true,
      'to-vimeo': '999',
    })
    const code = await runRollbackR2Hls(ctx, {
      r2Config: R2_CONFIG,
      readStdin: async () => '',
    })
    expect(code).toBe(2)
    expect(err.text()).toContain('--from-stdin does not accept --to-vimeo')
  })

  it('empty stdin returns 0 with a "nothing to do" stderr note', async () => {
    const { client, handles } = bulkClient([])
    const { ctx, err } = makeCtx(client, [], { 'from-stdin': true })
    const code = await runRollbackR2Hls(ctx, {
      r2Config: R2_CONFIG,
      readStdin: async () => '',
    })
    expect(code).toBe(0)
    expect(handles.get).not.toHaveBeenCalled()
    expect(err.text()).toContain('Nothing to roll back')
  })

  it('--dry-run in bulk mode runs each row through the plan without mutating', async () => {
    const { client, handles } = bulkClient([ROW_A, ROW_B])
    const deleteR2Prefix = vi.fn()
    const stdin =
      JSON.stringify({ dataset_id: ROW_A.id, vimeo_id: '111' }) +
      '\n' +
      JSON.stringify({ dataset_id: ROW_B.id, vimeo_id: '222' }) +
      '\n'
    const { ctx, out } = makeCtx(client, [], { 'from-stdin': true, 'dry-run': true })
    const code = await runRollbackR2Hls(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
      readStdin: async () => stdin,
    })
    expect(code).toBe(0)
    // GET ran (to display each plan), but PATCH + DELETE did not.
    expect(handles.get).toHaveBeenCalledTimes(2)
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(deleteR2Prefix).not.toHaveBeenCalled()
    expect(out.text()).toContain('--dry-run set; no mutations will be issued')
    // Each row counted as ok in the dry-run summary (the rollback
    // helper short-circuits before the failure paths could trigger).
    expect(out.text()).toContain('ok:                       2')
  })

  it('skips blank lines and trims whitespace in stdin input', async () => {
    const { client, handles } = bulkClient([ROW_A])
    const deleteR2Prefix = vi.fn(async () => ({ deleted: 1, durationMs: 100 }))
    const stdin =
      '\n\n  ' +
      JSON.stringify({ dataset_id: ROW_A.id, vimeo_id: '111' }) +
      '  \n\n'
    const { ctx, out } = makeCtx(client, [], { 'from-stdin': true })
    const code = await runRollbackR2Hls(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
      readStdin: async () => stdin,
    })
    expect(code).toBe(0)
    expect(handles.updateDataset).toHaveBeenCalledTimes(1)
    expect(out.text()).toContain('Bulk rollback: 1 row(s) from stdin.')
  })

  it('counts unset R2 creds the same as DELETE-throws in bulk mode (orphan accounting)', async () => {
    // Copilot review caught this: previously creds-unset returned
    // outcome=ok, so the bulk-mode summary under-reported the
    // orphan R2 prefixes (they showed under `ok` instead of
    // `ok (orphan R2 prefix)`). PATCH committed → catalog correct,
    // but the operator still has an orphan to clean up. Both the
    // throw-path and the skip-path now report as delete_failed
    // so the orphan count is accurate.
    const { client } = bulkClient([ROW_A])
    const deleteR2Prefix = vi.fn()
    // Empty creds config — simulates the operator running
    // bulk rollback without R2_S3_ENDPOINT / keys in env.
    const emptyR2Config: R2UploadConfig = {
      endpoint: '',
      accessKeyId: '',
      secretAccessKey: '',
      bucket: 'terraviz-assets',
    }
    const stdin = JSON.stringify({ dataset_id: ROW_A.id, vimeo_id: '111' }) + '\n'
    const { ctx, out, err } = makeCtx(client, [], { 'from-stdin': true })
    const code = await runRollbackR2Hls(ctx, {
      r2Config: emptyR2Config,
      deleteR2Prefix,
      readStdin: async () => stdin,
    })
    expect(code).toBe(0) // delete_failed is non-fatal in bulk mode
    expect(deleteR2Prefix).not.toHaveBeenCalled() // skipped, never attempted
    expect(out.text()).toContain('ok:                       0')
    expect(out.text()).toContain('ok (orphan R2 prefix):    1')
    expect(err.text()).toContain('R2 credentials unset')
  })

  it('delete_failed in bulk mode is non-fatal — counted under "ok (orphan R2 prefix)"', async () => {
    // PATCH succeeds; the R2 prefix DELETE throws. The single-row
    // path treats this as exit 0 (catalog correct, orphan storage
    // remains); bulk mode should mirror that — the row's primary
    // goal succeeded, so no hard failure, but the summary
    // distinguishes "ok (orphan R2 prefix)" from a clean ok so
    // the operator can see how many orphans they need to clean
    // up later.
    const { client } = bulkClient([ROW_A])
    const deleteR2Prefix = vi.fn(async () => {
      throw new Error('R2 LIST timed out')
    })
    const stdin = JSON.stringify({ dataset_id: ROW_A.id, vimeo_id: '111' }) + '\n'
    const { ctx, out, err } = makeCtx(client, [], { 'from-stdin': true })
    const code = await runRollbackR2Hls(ctx, {
      r2Config: R2_CONFIG,
      deleteR2Prefix,
      readStdin: async () => stdin,
    })
    expect(code).toBe(0)
    expect(out.text()).toContain('ok:                       0')
    expect(out.text()).toContain('ok (orphan R2 prefix):    1')
    expect(err.text()).toContain('Could not delete R2 prefix')
  })
})
