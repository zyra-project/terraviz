// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for `terraviz migrate-r2-hls` (Phase 3 commit C).
 *
 * Exercised against:
 *   - a hand-rolled fake `TerravizClient` (list / get /
 *     updateDataset);
 *   - DI hooks for `resolveVimeoSource`, `encodeHls`, and
 *     `uploadHlsBundle` so no real FFmpeg or R2 round-trips run;
 *   - an injected workdir under a per-test tmpdir;
 *   - a telemetry recorder to assert on the events that would
 *     fire.
 *
 * Coverage:
 *   - --dry-run prints plan + cost estimate, never mutates
 *   - Plan filtering: stream:, url:, non-video, draft rows
 *   - --id mode targets a single row via GET
 *   - --limit caps work
 *   - Each per-row failure outcome and its telemetry shape
 *   - data_ref PATCH is the commit point (failed PATCH leaves R2
 *     bundle uploaded but row unchanged)
 *   - Workdir cleanup behavior (success → removed; failure →
 *     retained; --keep-workdir → retained even on success)
 *   - Missing R2 credentials exits 2 before any per-row work
 */

import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrateR2Hls, type MigrationResult } from './migrate-r2-hls'
import { isRealtimeTitle } from './lib/realtime-title'
import type { CommandContext } from './commands'
import type { TerravizClient } from './lib/client'
import { parseArgs } from './lib/args'
import type { R2UploadConfig } from './lib/r2-upload'
import type { TelemetryEventPayload } from './lib/migration-telemetry'

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

const ROW_VIDEO_VIMEO_1: PublisherRow = {
  id: 'DS00001AAAAAAAAAAAAAAAAAAAAA',
  legacy_id: 'INTERNAL_SOS_768',
  title: 'Hurricane Season - 2024',
  format: 'video/mp4',
  data_ref: 'vimeo:1107911993',
  published_at: '2026-04-30T00:00:00.000Z',
}
const ROW_VIDEO_VIMEO_2: PublisherRow = {
  id: 'DS00002AAAAAAAAAAAAAAAAAAAAA',
  legacy_id: 'INTERNAL_SOS_770',
  title: 'Drought Risk',
  format: 'video/mp4',
  data_ref: 'vimeo:497773621',
  published_at: '2026-04-30T00:00:00.000Z',
}
const ROW_VIDEO_R2: PublisherRow = {
  id: 'DS00003AAAAAAAAAAAAAAAAAAAAA',
  legacy_id: 'INTERNAL_SOS_771',
  title: 'Already Migrated',
  format: 'video/mp4',
  data_ref: 'r2:videos/DS00003.../master.m3u8',
  published_at: '2026-04-30T00:00:00.000Z',
}
const ROW_IMAGE: PublisherRow = {
  id: 'DS00004AAAAAAAAAAAAAAAAAAAAA',
  legacy_id: 'INTERNAL_SOS_780',
  title: 'Image Layer',
  format: 'image/png',
  data_ref: 'url:https://example.org/x.png',
  published_at: '2026-04-30T00:00:00.000Z',
}
const ROW_VIDEO_REALTIME_SST: PublisherRow = {
  id: 'DS00005AAAAAAAAAAAAAAAAAAAAA',
  legacy_id: 'INTERNAL_SOS_805',
  title: 'Sea Surface Temperature - Real-time',
  format: 'video/mp4',
  data_ref: 'vimeo:111111111',
  published_at: '2026-04-30T00:00:00.000Z',
}
const ROW_VIDEO_REALTIME_PRECIP: PublisherRow = {
  id: 'DS00006AAAAAAAAAAAAAAAAAAAAA',
  legacy_id: 'INTERNAL_SOS_806',
  title: 'Precipitation - Real-time',
  format: 'video/mp4',
  data_ref: 'vimeo:222222222',
  published_at: '2026-04-30T00:00:00.000Z',
}

interface FakeClientOptions {
  rows?: PublisherRow[]
  singleRow?: PublisherRow
  patchFailFor?: Set<string>
}

function fakeClient(opts: FakeClientOptions = {}) {
  const rows = opts.rows ?? []
  const list = vi.fn(async (query: { status?: string } = {}) => {
    const filtered = rows.filter(r => {
      if (query.status === 'published') return r.published_at != null
      return true
    })
    return { ok: true as const, status: 200, body: { datasets: filtered, next_cursor: null } }
  })
  const get = vi.fn(async (id: string) => {
    if (opts.singleRow && opts.singleRow.id === id) {
      return { ok: true as const, status: 200, body: { dataset: opts.singleRow } }
    }
    return { ok: false as const, status: 404, error: 'not_found' }
  })
  const updateDataset = vi.fn(async (id: string, body: Record<string, unknown>) => {
    if (opts.patchFailFor?.has(id)) {
      return { ok: false as const, status: 503, error: 'upstream_unavailable', message: 'D1 timeout' }
    }
    return {
      ok: true as const,
      status: 200,
      body: { dataset: { id, slug: `slug-${id}`, ...body } },
    }
  })
  const stub = { serverUrl: 'http://localhost:8788', list, get, updateDataset }
  return { client: stub as unknown as TerravizClient, handles: { list, get, updateDataset } }
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
    else if (v === false) argv.push(`--no-${k}`)
    else argv.push(`--${k}=${String(v)}`)
  }
  const args = parseArgs(argv)
  return { ctx: { client, args, stdout: out, stderr: err }, out, err }
}

const R2_CONFIG: R2UploadConfig = {
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  accessKeyId: 'AKIA',
  secretAccessKey: 'secret',
  bucket: 'terraviz-assets',
}

const FROZEN_NOW = (() => {
  let n = 1_000_000
  return () => {
    n += 100
    return n
  }
})()

// ---- Stubbed dependencies --------------------------------------------------

function fakeResolveVimeoSource(opts: { durationSeconds?: number; failFor?: string } = {}) {
  return vi.fn(async (vimeoId: string) => {
    if (opts.failFor === vimeoId) throw new Error(`vimeo fetch failed for ${vimeoId}`)
    return {
      vimeoId,
      title: `Vimeo ${vimeoId}`,
      durationSeconds: opts.durationSeconds ?? 60,
      mp4Url: `https://cdn.example.org/v/${vimeoId}/source.mp4`,
      sizeBytes: 41_000_000,
      width: 4096,
      height: 2048,
    }
  })
}

function fakeEncodeHls(workdirRoot: string, opts: { failFor?: string } = {}) {
  return vi.fn(async (input: Parameters<typeof import('./lib/ffmpeg-hls').encodeHls>[0]) => {
    if (opts.failFor && input.inputPath.includes(opts.failFor)) {
      throw new Error('ffmpeg exited non-zero')
    }
    // Simulate ffmpeg's output: master.m3u8 + a couple of stub segments.
    const dir = input.outputDir
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'master.m3u8'), '#EXTM3U\n')
    mkdirSync(join(dir, 'stream_0'), { recursive: true })
    writeFileSync(join(dir, 'stream_0', 'playlist.m3u8'), '#EXTM3U\n')
    writeFileSync(join(dir, 'stream_0', 'segment_000.ts'), Buffer.alloc(2048))
    return {
      masterPlaylistPath: join(dir, 'master.m3u8'),
      files: ['master.m3u8', 'stream_0/playlist.m3u8', 'stream_0/segment_000.ts'],
      durationMs: 30_000,
      outputBytes: 2048 + 50,
    }
  })
}

interface UploadStubOptions {
  failFor?: string
  uidFor?: (datasetId: string) => string
}
function fakeUploadHlsBundle(opts: UploadStubOptions = {}) {
  return vi.fn(async (
    _config: R2UploadConfig,
    _localDir: string,
    keyPrefix: string,
  ) => {
    if (opts.failFor && keyPrefix.includes(opts.failFor)) {
      throw new Error('R2 PUT failed')
    }
    const masterKey = `${keyPrefix}/master.m3u8`
    return {
      masterKey,
      keys: [masterKey, `${keyPrefix}/stream_0/playlist.m3u8`, `${keyPrefix}/stream_0/segment_000.ts`],
      totalBytes: 50_000_000,
      durationMs: 5_000,
    }
  })
}

function noopEmit(): (e: TelemetryEventPayload) => void {
  return () => {}
}

// ---- Tests -----------------------------------------------------------------

describe('runMigrateR2Hls — plan + dry-run', () => {
  it('--dry-run prints the plan + cost estimate and exits 0 without mutating', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client, handles } = fakeClient({
        rows: [ROW_VIDEO_VIMEO_1, ROW_VIDEO_VIMEO_2, ROW_VIDEO_R2, ROW_IMAGE],
      })
      const { ctx, out, err } = makeCtx(client, { 'dry-run': true })
      const code = await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        skipPace: true,
      })
      expect(code).toBe(0)
      expect(handles.updateDataset).not.toHaveBeenCalled()
      expect(out.text()).toContain('vimeo: rows on video/mp4:   2')
      expect(out.text()).toContain('Storage estimate')
      expect(out.text()).toContain('total source minutes:     2.0')
      expect(out.text()).toContain('Dry run')
      expect(err.text()).toBe('')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('filters out rows already on r2: at plan time', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client } = fakeClient({ rows: [ROW_VIDEO_R2, ROW_VIDEO_VIMEO_1] })
      const { ctx, out } = makeCtx(client, { 'dry-run': true })
      const code = await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        skipPace: true,
      })
      expect(code).toBe(0)
      expect(out.text()).toContain('vimeo: rows on video/mp4:   1')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('filters out non-video formats', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client } = fakeClient({ rows: [ROW_IMAGE] })
      const { ctx, out } = makeCtx(client, { 'dry-run': true })
      const code = await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        skipPace: true,
      })
      expect(code).toBe(0)
      expect(out.text()).toContain('vimeo: rows on video/mp4:   0')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('--limit caps the run and notes the cap in the plan summary', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client } = fakeClient({ rows: [ROW_VIDEO_VIMEO_1, ROW_VIDEO_VIMEO_2] })
      const { ctx, out } = makeCtx(client, { 'dry-run': true, limit: '1' })
      await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        skipPace: true,
      })
      expect(out.text()).toContain('will migrate this run:      1 (capped by --limit)')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('--id targets a single row via GET, skipping list paging', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client, handles } = fakeClient({ singleRow: ROW_VIDEO_VIMEO_1 })
      const { ctx, out } = makeCtx(client, { id: ROW_VIDEO_VIMEO_1.id, 'dry-run': true })
      const code = await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        skipPace: true,
      })
      expect(code).toBe(0)
      expect(handles.list).not.toHaveBeenCalled()
      expect(handles.get).toHaveBeenCalledWith(ROW_VIDEO_VIMEO_1.id)
      expect(out.text()).toContain('vimeo: rows on video/mp4:   1')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('--id pointing at a non-vimeo row prints skip and exits 0', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client, handles } = fakeClient({ singleRow: ROW_IMAGE })
      const { ctx, err } = makeCtx(client, { id: ROW_IMAGE.id })
      const code = await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        skipPace: true,
      })
      expect(code).toBe(0)
      expect(handles.updateDataset).not.toHaveBeenCalled()
      expect(err.text()).toContain('Skipping')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('exits 2 when --limit is non-positive', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client } = fakeClient({ rows: [ROW_VIDEO_VIMEO_1] })
      const { ctx, err } = makeCtx(client, { limit: '0' })
      const code = await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
      })
      expect(code).toBe(2)
      expect(err.text()).toContain('--limit must be a positive integer')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('exits 2 when R2 credentials are missing', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    const prevEnd = process.env.R2_S3_ENDPOINT
    const prevAk = process.env.R2_ACCESS_KEY_ID
    const prevSk = process.env.R2_SECRET_ACCESS_KEY
    delete process.env.R2_S3_ENDPOINT
    delete process.env.R2_ACCESS_KEY_ID
    delete process.env.R2_SECRET_ACCESS_KEY
    try {
      const { client, handles } = fakeClient({ rows: [ROW_VIDEO_VIMEO_1] })
      const { ctx, err } = makeCtx(client)
      const code = await runMigrateR2Hls(ctx, {
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        skipPace: true,
      })
      expect(code).toBe(2)
      expect(handles.updateDataset).not.toHaveBeenCalled()
      expect(err.text()).toContain('R2_S3_ENDPOINT')
    } finally {
      if (prevEnd !== undefined) process.env.R2_S3_ENDPOINT = prevEnd
      if (prevAk !== undefined) process.env.R2_ACCESS_KEY_ID = prevAk
      if (prevSk !== undefined) process.env.R2_SECRET_ACCESS_KEY = prevSk
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('exits 1 when the list endpoint refuses', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const list = vi.fn(async () => ({ ok: false as const, status: 401, error: 'unauthorized' }))
      const stub = { serverUrl: 'x', list, get: vi.fn(), updateDataset: vi.fn() }
      const { ctx, err } = makeCtx(stub as unknown as TerravizClient)
      const code = await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        skipPace: true,
      })
      expect(code).toBe(1)
      expect(err.text()).toContain('Could not list datasets (401)')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('runMigrateR2Hls — live migration', () => {
  it('migrates each row: resolve → encode → upload → PATCH', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client, handles } = fakeClient({ rows: [ROW_VIDEO_VIMEO_1, ROW_VIDEO_VIMEO_2] })
      const events: TelemetryEventPayload[] = []
      const { ctx, out } = makeCtx(client)
      const code = await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        encodeHls: fakeEncodeHls(tmp),
        uploadHlsBundle: fakeUploadHlsBundle(),
        emitTelemetry: e => {
          events.push(e)
        },
        skipPace: true,
        now: FROZEN_NOW,
      })
      expect(code).toBe(0)
      expect(handles.updateDataset).toHaveBeenCalledTimes(2)
      const [firstId, firstBody] = handles.updateDataset.mock.calls[0]
      expect(firstId).toBe(ROW_VIDEO_VIMEO_1.id)
      expect(firstBody).toEqual({
        data_ref: `r2:videos/${ROW_VIDEO_VIMEO_1.id}/master.m3u8`,
      })
      expect(events).toHaveLength(2)
      expect(events[0]).toMatchObject({
        event_type: 'migration_r2_hls',
        dataset_id: ROW_VIDEO_VIMEO_1.id,
        outcome: 'ok',
        r2_key: `videos/${ROW_VIDEO_VIMEO_1.id}/master.m3u8`,
      })
      expect(out.text()).toContain('ok:                       2')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('cleans up per-row workdir on success (default behavior)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client } = fakeClient({ rows: [ROW_VIDEO_VIMEO_1] })
      const { ctx } = makeCtx(client)
      await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        encodeHls: fakeEncodeHls(tmp),
        uploadHlsBundle: fakeUploadHlsBundle(),
        emitTelemetry: noopEmit(),
        skipPace: true,
      })
      expect(existsSync(join(tmp, ROW_VIDEO_VIMEO_1.id))).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('--keep-workdir retains the workdir on success', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client } = fakeClient({ rows: [ROW_VIDEO_VIMEO_1] })
      const { ctx } = makeCtx(client, { 'keep-workdir': true })
      await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        encodeHls: fakeEncodeHls(tmp),
        uploadHlsBundle: fakeUploadHlsBundle(),
        emitTelemetry: noopEmit(),
        skipPace: true,
      })
      expect(existsSync(join(tmp, ROW_VIDEO_VIMEO_1.id))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('vimeo_fetch_failed: no encode/upload/patch, telemetry emitted, exit 1', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client, handles } = fakeClient({ rows: [ROW_VIDEO_VIMEO_1] })
      const events: TelemetryEventPayload[] = []
      const encode = fakeEncodeHls(tmp)
      const upload = fakeUploadHlsBundle()
      const { ctx } = makeCtx(client)
      const code = await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource({ failFor: '1107911993' }),
        encodeHls: encode,
        uploadHlsBundle: upload,
        emitTelemetry: e => {
          events.push(e)
        },
        skipPace: true,
        now: FROZEN_NOW,
      })
      expect(code).toBe(1)
      expect(encode).not.toHaveBeenCalled()
      expect(upload).not.toHaveBeenCalled()
      expect(handles.updateDataset).not.toHaveBeenCalled()
      expect(events[0].outcome).toBe('vimeo_fetch_failed')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('encode_failed: no upload/patch, workdir retained for debugging', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client, handles } = fakeClient({ rows: [ROW_VIDEO_VIMEO_1] })
      const events: TelemetryEventPayload[] = []
      const upload = fakeUploadHlsBundle()
      const { ctx } = makeCtx(client)
      const code = await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        encodeHls: fakeEncodeHls(tmp, { failFor: '1107911993' }),
        uploadHlsBundle: upload,
        emitTelemetry: e => {
          events.push(e)
        },
        skipPace: true,
        now: FROZEN_NOW,
      })
      expect(code).toBe(1)
      expect(upload).not.toHaveBeenCalled()
      expect(handles.updateDataset).not.toHaveBeenCalled()
      expect(events[0].outcome).toBe('encode_failed')
      // Workdir retained on failure for inspection (no cleanup).
      expect(existsSync(join(tmp, ROW_VIDEO_VIMEO_1.id))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('r2_upload_failed: no patch, telemetry emitted, workdir retained', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client, handles } = fakeClient({ rows: [ROW_VIDEO_VIMEO_1] })
      const events: TelemetryEventPayload[] = []
      const { ctx } = makeCtx(client)
      const code = await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        encodeHls: fakeEncodeHls(tmp),
        uploadHlsBundle: fakeUploadHlsBundle({ failFor: ROW_VIDEO_VIMEO_1.id }),
        emitTelemetry: e => {
          events.push(e)
        },
        skipPace: true,
        now: FROZEN_NOW,
      })
      expect(code).toBe(1)
      expect(handles.updateDataset).not.toHaveBeenCalled()
      expect(events[0].outcome).toBe('r2_upload_failed')
      expect(existsSync(join(tmp, ROW_VIDEO_VIMEO_1.id))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('data_ref_patch_failed: orphan R2 key captured in telemetry', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client, handles } = fakeClient({
        rows: [ROW_VIDEO_VIMEO_1],
        patchFailFor: new Set([ROW_VIDEO_VIMEO_1.id]),
      })
      const events: TelemetryEventPayload[] = []
      const { ctx } = makeCtx(client)
      const code = await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        encodeHls: fakeEncodeHls(tmp),
        uploadHlsBundle: fakeUploadHlsBundle(),
        emitTelemetry: e => {
          events.push(e)
        },
        skipPace: true,
        now: FROZEN_NOW,
      })
      expect(code).toBe(1)
      expect(handles.updateDataset).toHaveBeenCalledTimes(1)
      // The orphan R2 key is captured in the telemetry's r2_key
      // field even on failure, so operators can clean up via the
      // rollback subcommand (3/F). Error context goes to stderr,
      // not telemetry — same shape as Phase 2's migration_video.
      expect(events[0]).toMatchObject({
        outcome: 'data_ref_patch_failed',
        r2_key: `videos/${ROW_VIDEO_VIMEO_1.id}/master.m3u8`,
      })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('telemetry emit failure does not abort the migration', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client, handles } = fakeClient({ rows: [ROW_VIDEO_VIMEO_1, ROW_VIDEO_VIMEO_2] })
      const { ctx } = makeCtx(client)
      const code = await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        encodeHls: fakeEncodeHls(tmp),
        uploadHlsBundle: fakeUploadHlsBundle(),
        emitTelemetry: () => {
          throw new Error('telemetry endpoint down')
        },
        skipPace: true,
        now: FROZEN_NOW,
      })
      expect(code).toBe(0)
      expect(handles.updateDataset).toHaveBeenCalledTimes(2)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('--limit caps the number of rows actually migrated', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client, handles } = fakeClient({
        rows: [ROW_VIDEO_VIMEO_1, ROW_VIDEO_VIMEO_2],
      })
      const { ctx } = makeCtx(client, { limit: '1' })
      const code = await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        encodeHls: fakeEncodeHls(tmp),
        uploadHlsBundle: fakeUploadHlsBundle(),
        emitTelemetry: noopEmit(),
        skipPace: true,
      })
      expect(code).toBe(0)
      expect(handles.updateDataset).toHaveBeenCalledTimes(1)
      expect(handles.updateDataset.mock.calls[0][0]).toBe(ROW_VIDEO_VIMEO_1.id)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('records every duration field on every result', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client } = fakeClient({ rows: [ROW_VIDEO_VIMEO_1] })
      const events: TelemetryEventPayload[] = []
      const { ctx } = makeCtx(client)
      await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        encodeHls: fakeEncodeHls(tmp),
        uploadHlsBundle: fakeUploadHlsBundle(),
        emitTelemetry: e => {
          events.push(e)
        },
        skipPace: true,
        now: FROZEN_NOW,
      })
      const event = events[0]
      expect(Number(event.encode_duration_ms)).toBeGreaterThan(0)
      expect(Number(event.upload_duration_ms)).toBeGreaterThan(0)
      expect(Number(event.duration_ms)).toBeGreaterThan(0)
      expect(Number(event.bundle_bytes)).toBeGreaterThan(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('does not leave an empty workdir behind on vimeo_fetch_failed (3/M)', async () => {
    // Copilot review caught: the original migrateOne created the
    // workdir up-front, then refused to clean it up when
    // vimeo_fetch_failed fired. That left behind useless empty
    // dirs for failed rows. Workdir creation now defers until
    // after the resolve succeeds.
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client } = fakeClient({ rows: [ROW_VIDEO_VIMEO_1] })
      const { ctx } = makeCtx(client)
      await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource({ failFor: '1107911993' }),
        encodeHls: fakeEncodeHls(tmp),
        uploadHlsBundle: fakeUploadHlsBundle(),
        emitTelemetry: noopEmit(),
        skipPace: true,
      })
      // workdir for the failed row should NOT exist — we never
      // created it because resolve failed before encode.
      expect(existsSync(join(tmp, ROW_VIDEO_VIMEO_1.id))).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('threads --proxy-base through cost estimate (3/M)', async () => {
    // Copilot review caught: the original printCostEstimate
    // didn't forward the operator's --proxy-base override, so
    // dry-run hit the default/prod proxy even when the live
    // run would target a different one.
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client } = fakeClient({ rows: [ROW_VIDEO_VIMEO_1] })
      const seenProxyBases: Array<string | undefined> = []
      const resolveSource = vi.fn(async (
        vimeoId: string,
        opts?: { proxyBase?: string },
      ) => {
        seenProxyBases.push(opts?.proxyBase)
        return {
          vimeoId,
          title: `Vimeo ${vimeoId}`,
          durationSeconds: 60,
          mp4Url: `https://cdn.example.org/v/${vimeoId}/source.mp4`,
          sizeBytes: 41_000_000,
          width: 4096,
          height: 2048,
        }
      })
      const { ctx } = makeCtx(client, {
        'dry-run': true,
        'proxy-base': 'https://video-proxy.staging.example.org/video',
      })
      await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: resolveSource as unknown as typeof import('./lib/vimeo-source').resolveVimeoSource,
        skipPace: true,
      })
      // The cost estimate calls resolveVimeoSource for each row.
      // Every call should have received the override.
      expect(seenProxyBases.length).toBeGreaterThan(0)
      for (const base of seenProxyBases) {
        expect(base).toBe('https://video-proxy.staging.example.org/video')
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('wipes the per-row workdir before encode so stale segments do not survive a retry (3/N)', async () => {
    // Copilot review round 2: when a previous attempt left files
    // behind (which happens on encode_failed / r2_upload_failed
    // — those keep the workdir for operator inspection), a retry
    // would call mkdirSync(workdir, { recursive: true }) — a
    // no-op — leaving the stale files in place. uploadHlsBundle
    // walks the entire workdir tree so it would PUT the old
    // files to R2 alongside the new bundle. Fix: rm -rf the
    // workdir after vimeo resolve succeeds but before encode.
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      // Pre-populate the workdir with a "stale" segment from a
      // hypothetical previous failed attempt.
      const datasetWorkdir = join(tmp, ROW_VIDEO_VIMEO_1.id)
      mkdirSync(join(datasetWorkdir, 'stream_0'), { recursive: true })
      writeFileSync(join(datasetWorkdir, 'stream_0', 'segment_999.ts'), Buffer.alloc(1024))
      writeFileSync(join(datasetWorkdir, 'stale-from-previous-attempt.txt'), 'leftover')

      // The fake encoder writes a small set of NEW files into the
      // workdir; the upload stub captures every file the bundle
      // walks so we can assert the stale segment isn't there.
      const capturedUploadedFiles: string[] = []
      const upload = vi.fn(async (
        _config: R2UploadConfig,
        localDir: string,
        keyPrefix: string,
      ) => {
        // Walk the workdir as the real uploadHlsBundle would.
        const { readdirSync } = await import('node:fs')
        const walk = (dir: string, rel: string): void => {
          for (const ent of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, ent.name)
            const r = rel ? `${rel}/${ent.name}` : ent.name
            if (ent.isDirectory()) walk(full, r)
            else if (ent.isFile()) capturedUploadedFiles.push(r)
          }
        }
        walk(localDir, '')
        return {
          masterKey: `${keyPrefix}/master.m3u8`,
          keys: capturedUploadedFiles.map(f => `${keyPrefix}/${f}`),
          totalBytes: 2_000,
          durationMs: 1_000,
        }
      })

      const { client } = fakeClient({ rows: [ROW_VIDEO_VIMEO_1] })
      const { ctx } = makeCtx(client)
      const code = await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        encodeHls: fakeEncodeHls(tmp),
        uploadHlsBundle: upload,
        emitTelemetry: noopEmit(),
        skipPace: true,
      })
      expect(code).toBe(0)
      // The stale files from the simulated previous attempt must
      // not have been uploaded.
      expect(capturedUploadedFiles).not.toContain('stale-from-previous-attempt.txt')
      expect(capturedUploadedFiles).not.toContain('stream_0/segment_999.ts')
      // The new encode's outputs must still be uploaded.
      expect(capturedUploadedFiles).toContain('master.m3u8')
      expect(capturedUploadedFiles).toContain('stream_0/segment_000.ts')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('does not wipe the workdir when vimeo_fetch_failed fires (preserves the empty-dir guarantee)', async () => {
    // Belt-and-braces: the wipe lives after resolve. If resolve
    // throws, we should NOT have created OR wiped the workdir
    // — confirming the 3/M empty-workdir guarantee still holds
    // and that nothing outside the dataset's own subdir was
    // touched.
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      // Pre-populate a SIBLING workdir to make sure the wipe is
      // scoped strictly to the failing row's own subdir.
      const siblingDir = join(tmp, 'unrelated-other-dataset')
      mkdirSync(siblingDir, { recursive: true })
      writeFileSync(join(siblingDir, 'do-not-touch.txt'), 'sibling content')

      const { client } = fakeClient({ rows: [ROW_VIDEO_VIMEO_1] })
      const { ctx } = makeCtx(client)
      await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource({ failFor: '1107911993' }),
        encodeHls: fakeEncodeHls(tmp),
        uploadHlsBundle: fakeUploadHlsBundle(),
        emitTelemetry: noopEmit(),
        skipPace: true,
      })
      // Failing row's workdir was never created (3/M).
      expect(existsSync(join(tmp, ROW_VIDEO_VIMEO_1.id))).toBe(false)
      // Sibling workdir untouched.
      expect(existsSync(join(siblingDir, 'do-not-touch.txt'))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('isRealtimeTitle (3a/A)', () => {
  // The catalog has no explicit `update_cadence` field, so the
  // filter is a heuristic substring match against the row title.
  // Pin the matrix so a subtle pattern change can't silently
  // start migrating real-time rows again.
  it('matches the SOS canonical "Real-time" suffix', () => {
    expect(isRealtimeTitle('Sea Surface Temperature - Real-time')).toBe(true)
    expect(isRealtimeTitle('Precipitation - Real-time')).toBe(true)
    expect(isRealtimeTitle('Earthquakes - Real-time')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isRealtimeTitle('REAL-TIME GLOBAL CLOUDS')).toBe(true)
    expect(isRealtimeTitle('real-time something')).toBe(true)
    expect(isRealtimeTitle('Real-Time Index')).toBe(true)
  })

  it('matches space and joined variants', () => {
    expect(isRealtimeTitle('Sea Ice Concentration - Real time')).toBe(true)
    expect(isRealtimeTitle('Realtime Ocean Temperature')).toBe(true)
  })

  it('does not match titles without the substring', () => {
    expect(isRealtimeTitle('Hurricane Season - 2024')).toBe(false)
    expect(isRealtimeTitle('Drought Risk')).toBe(false)
    expect(isRealtimeTitle('Sea Level Rise')).toBe(false)
    expect(isRealtimeTitle('Global Currents')).toBe(false)
  })
})

describe('runMigrateR2Hls — real-time row guard (3a/A)', () => {
  it('default-skips real-time rows in bulk mode and surfaces them in the plan summary', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client, handles } = fakeClient({
        rows: [
          ROW_VIDEO_VIMEO_1,
          ROW_VIDEO_REALTIME_SST,
          ROW_VIDEO_REALTIME_PRECIP,
          ROW_VIDEO_VIMEO_2,
        ],
      })
      const { ctx, out, err } = makeCtx(client)
      const code = await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        encodeHls: fakeEncodeHls(tmp),
        uploadHlsBundle: fakeUploadHlsBundle(),
        emitTelemetry: noopEmit(),
        skipPace: true,
      })
      expect(code).toBe(0)
      expect(handles.updateDataset).toHaveBeenCalledTimes(2)
      const migratedIds = handles.updateDataset.mock.calls.map(c => c[0])
      expect(migratedIds).toContain(ROW_VIDEO_VIMEO_1.id)
      expect(migratedIds).toContain(ROW_VIDEO_VIMEO_2.id)
      expect(migratedIds).not.toContain(ROW_VIDEO_REALTIME_SST.id)
      expect(migratedIds).not.toContain(ROW_VIDEO_REALTIME_PRECIP.id)
      expect(out.text()).toContain('skipped (real-time guard):  2')
      expect(out.text()).toContain('vimeo: rows on video/mp4:   4')
      expect(out.text()).toContain('Sea Surface Temperature - Real-time')
      expect(out.text()).toContain('Precipitation - Real-time')
      expect(err.text()).toBe('')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('--no-skip-realtime opts back in and migrates real-time rows', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client, handles } = fakeClient({
        rows: [ROW_VIDEO_REALTIME_SST, ROW_VIDEO_REALTIME_PRECIP],
      })
      const { ctx, out } = makeCtx(client, { 'skip-realtime': false })
      const code = await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        encodeHls: fakeEncodeHls(tmp),
        uploadHlsBundle: fakeUploadHlsBundle(),
        emitTelemetry: noopEmit(),
        skipPace: true,
      })
      expect(code).toBe(0)
      expect(handles.updateDataset).toHaveBeenCalledTimes(2)
      // Plan summary should NOT advertise a skipped count when the
      // guard is off — keeps the output uncluttered for the
      // intentional opt-out flow.
      expect(out.text()).not.toContain('skipped (real-time guard)')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('--id mode bypasses the guard but warns when the targeted row is real-time', async () => {
    // The existing precedent for --id (see the buildPlan comment)
    // is "operators using --id are surgically targeting a row and
    // know what they're typing." The real-time guard mirrors that:
    // --id overrides the filter so the operator can encode a
    // real-time row deliberately, but a stderr warning makes the
    // override visible in case it was a typo.
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client, handles } = fakeClient({
        singleRow: ROW_VIDEO_REALTIME_SST,
      })
      const { ctx, out, err } = makeCtx(client, { id: ROW_VIDEO_REALTIME_SST.id })
      const code = await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        encodeHls: fakeEncodeHls(tmp),
        uploadHlsBundle: fakeUploadHlsBundle(),
        emitTelemetry: noopEmit(),
        skipPace: true,
      })
      expect(code).toBe(0)
      expect(handles.updateDataset).toHaveBeenCalledTimes(1)
      expect(handles.updateDataset.mock.calls[0][0]).toBe(ROW_VIDEO_REALTIME_SST.id)
      expect(err.text()).toContain('real-time row')
      expect(err.text()).toContain(ROW_VIDEO_REALTIME_SST.id)
      expect(err.text()).toContain('--id overrides')
      expect(out.text()).not.toContain('skipped (real-time guard)')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('--id mode prints no warning for a static row (regression guard)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const { client } = fakeClient({ singleRow: ROW_VIDEO_VIMEO_1 })
      const { ctx, err } = makeCtx(client, { id: ROW_VIDEO_VIMEO_1.id })
      await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        encodeHls: fakeEncodeHls(tmp),
        uploadHlsBundle: fakeUploadHlsBundle(),
        emitTelemetry: noopEmit(),
        skipPace: true,
      })
      expect(err.text()).not.toContain('real-time')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('caps the skipped-row listing at 5 entries with an "+ N more" tail', async () => {
    // Match the willRun sample's listing convention so a catalog
    // with dozens of real-time rows doesn't dump them all into
    // the plan summary.
    const tmp = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const realtimeRows: PublisherRow[] = []
      for (let i = 0; i < 8; i++) {
        realtimeRows.push({
          id: `DSREAL${String(i).padStart(3, '0')}AAAAAAAAAAAAAAAAAA`,
          legacy_id: `INTERNAL_SOS_RT${i}`,
          title: `Realtime Sample ${i} - Real-time`,
          format: 'video/mp4',
          data_ref: `vimeo:90000000${i}`,
          published_at: '2026-04-30T00:00:00.000Z',
        })
      }
      const { client } = fakeClient({ rows: realtimeRows })
      const { ctx, out } = makeCtx(client, { 'dry-run': true })
      await runMigrateR2Hls(ctx, {
        r2Config: R2_CONFIG,
        workdirRoot: tmp,
        resolveVimeoSource: fakeResolveVimeoSource(),
        skipPace: true,
      })
      expect(out.text()).toContain('skipped (real-time guard):  8')
      expect(out.text()).toContain('+ 3 more')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

// MigrationResult is imported for type-only re-use by downstream
// test files (the rollback CLI in 3/F). Reference it once to
// suppress unused-import warnings without firing a runtime
// expression that TypeScript flags as a type mismatch.
type _MigrationResultRef = MigrationResult
