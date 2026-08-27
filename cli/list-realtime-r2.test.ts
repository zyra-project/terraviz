// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for `terraviz list-realtime-r2` (Phase 3a commit B).
 *
 * Coverage:
 *   - Plan filtering — only `r2:videos/` + `video/mp4` + real-time
 *     title rows surface; other rows are silently dropped.
 *   - Vimeo id recovery from a stubbed snapshot via `legacy_id` →
 *     `entry.id` → `dataLink` regex.
 *   - NDJSON output (default) — one JSON object per matched row,
 *     stable field set, no human-formatting noise.
 *   - --human output — readable table + the rollback pipe hint.
 *   - Snapshot lookup failure (legacy_id missing from snapshot, or
 *     dataLink not a vimeo URL) emits to stderr with empty
 *     vimeo_id, doesn't pollute the NDJSON stream on stdout.
 *   - Empty result (no migrated real-time rows) handled cleanly
 *     in both modes.
 *   - Snapshot loader failure (missing/invalid file) returns 1
 *     with a useful stderr message.
 *   - Publisher list failure returns 1.
 */

import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runListRealtimeR2 } from './list-realtime-r2'
import type { CommandContext } from './commands'
import type { TerravizClient } from './lib/client'
import { parseArgs } from './lib/args'

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

interface PublisherRow {
  id: string
  legacy_id: string | null
  title: string
  format: string
  data_ref: string
  published_at: string | null
}

const ROW_RT_R2_SST: PublisherRow = {
  id: 'DS00001AAAAAAAAAAAAAAAAAAAAA',
  legacy_id: 'INTERNAL_SOS_805',
  title: 'Sea Surface Temperature - Real-time',
  format: 'video/mp4',
  data_ref: 'r2:videos/DS00001AAAAAAAAAAAAAAAAAAAAA/master.m3u8',
  published_at: '2026-04-30T00:00:00.000Z',
}
const ROW_RT_R2_PRECIP: PublisherRow = {
  id: 'DS00002AAAAAAAAAAAAAAAAAAAAA',
  legacy_id: 'INTERNAL_SOS_806',
  title: 'Precipitation - Real-time',
  format: 'video/mp4',
  data_ref: 'r2:videos/DS00002AAAAAAAAAAAAAAAAAAAAA/master.m3u8',
  published_at: '2026-04-30T00:00:00.000Z',
}
const ROW_STATIC_R2: PublisherRow = {
  // Migrated already, NOT real-time — must not surface.
  id: 'DS00003AAAAAAAAAAAAAAAAAAAAA',
  legacy_id: 'INTERNAL_SOS_768',
  title: 'Hurricane Season - 2024',
  format: 'video/mp4',
  data_ref: 'r2:videos/DS00003AAAAAAAAAAAAAAAAAAAAA/master.m3u8',
  published_at: '2026-04-30T00:00:00.000Z',
}
const ROW_RT_VIMEO: PublisherRow = {
  // Real-time but still on vimeo: — not yet migrated, must not surface.
  id: 'DS00004AAAAAAAAAAAAAAAAAAAAA',
  legacy_id: 'INTERNAL_SOS_807',
  title: 'Earthquakes - Real-time',
  format: 'video/mp4',
  data_ref: 'vimeo:444444444',
  published_at: '2026-04-30T00:00:00.000Z',
}
const ROW_IMAGE: PublisherRow = {
  // Image format — not in scope.
  id: 'DS00005AAAAAAAAAAAAAAAAAAAAA',
  legacy_id: 'INTERNAL_SOS_999',
  title: 'Real-time Snapshot Map',
  format: 'image/png',
  data_ref: 'r2:datasets/DS00005AAAAAAAAAAAAAAAAAAAAA/snapshot.png',
  published_at: '2026-04-30T00:00:00.000Z',
}

interface FakeClientOptions {
  rows?: PublisherRow[]
  listFails?: boolean
}

function fakeClient(opts: FakeClientOptions = {}) {
  const list = vi.fn(async () => {
    if (opts.listFails) {
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
      body: { datasets: opts.rows ?? [], next_cursor: null },
    }
  })
  const stub = { serverUrl: 'http://localhost:8788', list }
  return { client: stub as unknown as TerravizClient, handles: { list } }
}

function makeCtx(
  client: TerravizClient,
  flags: Record<string, string | boolean> = {},
): { ctx: CommandContext; out: BufStream; err: BufStream } {
  const out = makeStream()
  const err = makeStream()
  const argv: string[] = []
  for (const [k, v] of Object.entries(flags)) {
    if (v === true) argv.push(`--${k}`)
    else argv.push(`--${k}=${String(v)}`)
  }
  // 'human' is a presence-only boolean — register it so the parser
  // doesn't try to consume the next arg as its value.
  const args = parseArgs(argv, new Set(['human']))
  return { ctx: { client, args, stdout: out, stderr: err }, out, err }
}

/** Snapshot stub — only the fields the lookup needs. */
const SNAPSHOT = [
  {
    id: 'INTERNAL_SOS_805',
    title: 'Sea Surface Temperature - Real-time',
    dataLink: 'https://vimeo.com/111111111',
  },
  {
    id: 'INTERNAL_SOS_806',
    title: 'Precipitation - Real-time',
    dataLink: 'https://vimeo.com/222222222',
  },
  {
    id: 'INTERNAL_SOS_768',
    title: 'Hurricane Season - 2024',
    dataLink: 'https://vimeo.com/1107911993',
  },
  {
    id: 'INTERNAL_SOS_807',
    title: 'Earthquakes - Real-time',
    dataLink: 'https://vimeo.com/333333333',
  },
]

describe('runListRealtimeR2 — filtering', () => {
  it('emits only r2:videos/ + video/mp4 + real-time rows; ignores static r2:, vimeo:, and image rows', async () => {
    const { client, handles } = fakeClient({
      rows: [ROW_STATIC_R2, ROW_RT_R2_SST, ROW_RT_VIMEO, ROW_IMAGE, ROW_RT_R2_PRECIP],
    })
    const { ctx, out, err } = makeCtx(client)
    const code = await runListRealtimeR2(ctx, { loadSnapshot: () => SNAPSHOT })
    expect(code).toBe(0)
    expect(handles.list).toHaveBeenCalledTimes(1)
    // Two rows match — both real-time, both already migrated.
    const lines = out.text().trim().split('\n').filter(l => l.length > 0)
    expect(lines).toHaveLength(2)
    const parsed = lines.map(l => JSON.parse(l))
    const ids = parsed.map(r => r.dataset_id).sort()
    expect(ids).toEqual([ROW_RT_R2_SST.id, ROW_RT_R2_PRECIP.id].sort())
    // Stderr clean — no unmatched-snapshot complaint, no list error.
    expect(err.text()).toBe('')
  })

  it('returns 0 with no output when nothing matches', async () => {
    const { client } = fakeClient({ rows: [ROW_STATIC_R2, ROW_RT_VIMEO, ROW_IMAGE] })
    const { ctx, out, err } = makeCtx(client)
    const code = await runListRealtimeR2(ctx, { loadSnapshot: () => SNAPSHOT })
    expect(code).toBe(0)
    expect(out.text()).toBe('')
    expect(err.text()).toBe('')
  })
})

describe('runListRealtimeR2 — vimeo_id recovery', () => {
  it('recovers vimeo_id from snapshot dataLink for each matched row', async () => {
    const { client } = fakeClient({ rows: [ROW_RT_R2_SST, ROW_RT_R2_PRECIP] })
    const { ctx, out } = makeCtx(client)
    await runListRealtimeR2(ctx, { loadSnapshot: () => SNAPSHOT })
    const parsed = out
      .text()
      .trim()
      .split('\n')
      .filter(l => l.length > 0)
      .map(l => JSON.parse(l))
    const sst = parsed.find(r => r.dataset_id === ROW_RT_R2_SST.id)
    const precip = parsed.find(r => r.dataset_id === ROW_RT_R2_PRECIP.id)
    expect(sst).toMatchObject({
      legacy_id: 'INTERNAL_SOS_805',
      vimeo_id: '111111111',
      title: 'Sea Surface Temperature - Real-time',
      current_data_ref: ROW_RT_R2_SST.data_ref,
    })
    expect(precip).toMatchObject({
      legacy_id: 'INTERNAL_SOS_806',
      vimeo_id: '222222222',
    })
  })

  it('flags rows whose legacy_id is absent from the snapshot to stderr; keeps stdout NDJSON clean', async () => {
    const orphan: PublisherRow = {
      ...ROW_RT_R2_SST,
      id: 'DSORPHAN1AAAAAAAAAAAAAAAAAAA',
      legacy_id: 'INTERNAL_SOS_NOT_IN_SNAPSHOT',
    }
    const { client } = fakeClient({ rows: [ROW_RT_R2_SST, orphan] })
    const { ctx, out, err } = makeCtx(client)
    const code = await runListRealtimeR2(ctx, { loadSnapshot: () => SNAPSHOT })
    expect(code).toBe(0)
    // stdout has only the matched row — stderr has the unmatched note.
    const lines = out.text().trim().split('\n').filter(l => l.length > 0)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).dataset_id).toBe(ROW_RT_R2_SST.id)
    expect(err.text()).toContain('1 real-time row(s) had no recoverable Vimeo id')
    expect(err.text()).toContain('DSORPHAN1AAAAAAAAAAAAAAAAAAA')
  })

  it('treats a snapshot entry with a non-vimeo dataLink as unmatched', async () => {
    const orphanSnapshot = [
      {
        id: 'INTERNAL_SOS_805',
        dataLink: 'https://example.org/some-other-host/v/abc',
      },
    ]
    const { client } = fakeClient({ rows: [ROW_RT_R2_SST] })
    const { ctx, out, err } = makeCtx(client)
    await runListRealtimeR2(ctx, { loadSnapshot: () => orphanSnapshot })
    expect(out.text()).toBe('')
    expect(err.text()).toContain('1 real-time row(s) had no recoverable Vimeo id')
  })
})

describe('runListRealtimeR2 — output modes', () => {
  it('NDJSON is the default, one object per line, no leading/trailing wrapper', async () => {
    const { client } = fakeClient({ rows: [ROW_RT_R2_SST, ROW_RT_R2_PRECIP] })
    const { ctx, out } = makeCtx(client)
    await runListRealtimeR2(ctx, { loadSnapshot: () => SNAPSHOT })
    const text = out.text()
    // No human-output banners; every non-empty line is parseable JSON.
    expect(text).not.toContain('Real-time rows on r2:')
    expect(text).not.toContain('To roll back')
    for (const line of text.split('\n').filter(l => l.length > 0)) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it('--human prints a readable table and the rollback pipe hint when matches exist', async () => {
    const { client } = fakeClient({ rows: [ROW_RT_R2_SST] })
    const { ctx, out } = makeCtx(client, { human: true })
    await runListRealtimeR2(ctx, { loadSnapshot: () => SNAPSHOT })
    expect(out.text()).toContain('Real-time rows on r2:')
    expect(out.text()).toContain('with recoverable vimeo_id: 1')
    expect(out.text()).toContain('Sea Surface Temperature - Real-time')
    expect(out.text()).toContain('terraviz list-realtime-r2 | terraviz rollback-r2-hls --from-stdin')
  })

  it('--human prints "no matches" message when nothing is on r2:', async () => {
    const { client } = fakeClient({ rows: [ROW_RT_VIMEO, ROW_STATIC_R2] })
    const { ctx, out } = makeCtx(client, { human: true })
    await runListRealtimeR2(ctx, { loadSnapshot: () => SNAPSHOT })
    expect(out.text()).toContain('No real-time rows currently migrated to r2:')
  })
})

describe('runListRealtimeR2 — default snapshot loader on disk', () => {
  // The Explore-style introspection assumed the SOS snapshot was
  // a bare top-level JSON array; the canonical shape on disk is
  // actually `{ datasets: [...] }` (the wrapper used by both
  // scripts/refresh-sos-snapshot.ts and cli/lib/snapshot-import.ts).
  // These tests pin both forms — the wrapped form for the
  // production layout, and the bare-array form for an operator
  // overriding with a hand-trimmed snapshot via --snapshot=<path>.
  function writeFixture(content: unknown): {
    snapshotPath: string
    cleanup: () => void
  } {
    const tmp = mkdtempSync(join(tmpdir(), 'rt-snap-'))
    const snapshotPath = join(tmp, 'snapshot.json')
    writeFileSync(snapshotPath, JSON.stringify(content))
    return {
      snapshotPath,
      cleanup: () => rmSync(tmp, { recursive: true, force: true }),
    }
  }

  it('loads the canonical `{ datasets: [...] }` wrapped form', async () => {
    const { snapshotPath, cleanup } = writeFixture({ datasets: SNAPSHOT })
    try {
      const { client } = fakeClient({ rows: [ROW_RT_R2_SST] })
      const { ctx, out, err } = makeCtx(client, { snapshot: snapshotPath })
      const code = await runListRealtimeR2(ctx)
      expect(code).toBe(0)
      expect(err.text()).toBe('')
      const lines = out.text().trim().split('\n').filter(l => l.length > 0)
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toMatchObject({
        dataset_id: ROW_RT_R2_SST.id,
        vimeo_id: '111111111',
      })
    } finally {
      cleanup()
    }
  })

  it('loads a bare top-level JSON array (operator-overridden trim)', async () => {
    const { snapshotPath, cleanup } = writeFixture(SNAPSHOT)
    try {
      const { client } = fakeClient({ rows: [ROW_RT_R2_SST] })
      const { ctx, out } = makeCtx(client, { snapshot: snapshotPath })
      const code = await runListRealtimeR2(ctx)
      expect(code).toBe(0)
      const lines = out.text().trim().split('\n').filter(l => l.length > 0)
      expect(lines).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  it('rejects any other JSON shape with a clear message', async () => {
    const { snapshotPath, cleanup } = writeFixture({ unexpected: 'shape' })
    try {
      const { client } = fakeClient({ rows: [] })
      const { ctx, err } = makeCtx(client, { snapshot: snapshotPath })
      const code = await runListRealtimeR2(ctx)
      expect(code).toBe(1)
      expect(err.text()).toContain('must be either a JSON array')
      expect(err.text()).toContain('top-level `datasets` array')
    } finally {
      cleanup()
    }
  })
})

describe('runListRealtimeR2 — error paths', () => {
  it('returns 1 with a stderr hint when the snapshot loader throws', async () => {
    const { client } = fakeClient({ rows: [ROW_RT_R2_SST] })
    const { ctx, err } = makeCtx(client)
    const code = await runListRealtimeR2(ctx, {
      loadSnapshot: () => {
        throw new Error('ENOENT: snapshot file not found')
      },
    })
    expect(code).toBe(1)
    expect(err.text()).toContain('Could not load SOS snapshot')
    expect(err.text()).toContain('--snapshot=<path>')
  })

  it('returns 1 when the publisher list call fails', async () => {
    const { client } = fakeClient({ listFails: true })
    const { ctx, err } = makeCtx(client)
    const code = await runListRealtimeR2(ctx, { loadSnapshot: () => SNAPSHOT })
    expect(code).toBe(1)
    expect(err.text()).toContain('Could not list datasets')
  })
})
