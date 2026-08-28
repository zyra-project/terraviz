// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for `terraviz migrate-r2-assets` (Phase 3b commit G).
 *
 * Exercised against:
 *   - a hand-rolled fake `TerravizClient` (list / get / updateDataset);
 *   - DI hooks for `fetchAsset` and `uploadR2Object` so no real
 *     HTTP traffic runs;
 *   - a telemetry recorder.
 *
 * Coverage:
 *   - parseAssetTypes: default list; valid CSV; deduplication;
 *     unknown value rejection.
 *   - refNeedsMigration: empty / null / r2:-prefixed / valid URL.
 *   - --dry-run plan summary: per-type counts, eligible rows,
 *     types filter.
 *   - Idempotency: r2:-prefixed columns skipped; empty columns
 *     skipped.
 *   - --types filter limits which columns are touched per row.
 *   - Happy path: each asset → fetchAsset → uploadR2Object →
 *     single PATCH per row covering all migrated columns.
 *   - SRT → VTT inline conversion: caption with .srt URL ends
 *     up at .vtt key with text/vtt content-type, body
 *     starts with WEBVTT header.
 *   - Partial failure: one asset's fetch fails, others succeed,
 *     PATCH body only includes the survivors.
 *   - patch_failed promotion: successful R2 PUTs become
 *     patch_failed in the telemetry when the row-level PATCH
 *     fails (so orphan objects are visible).
 *   - --id targets a single row.
 *   - Missing R2 credentials exits 2 before any work.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  parseAssetTypes,
  refNeedsMigration,
  runMigrateR2Assets,
  type AssetType,
} from './migrate-r2-assets'
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
  thumbnail_ref: string | null
  legend_ref: string | null
  caption_ref: string | null
  color_table_ref: string | null
  published_at: string | null
}

const NOAA = 'https://d3sik7mbbzunjo.cloudfront.net'

function makeRow(over: Partial<PublisherRow> = {}): PublisherRow {
  return {
    id: 'DS00001AAAAAAAAAAAAAAAAAAAAA',
    legacy_id: 'INTERNAL_SOS_768',
    title: 'Hurricane Season - 2024',
    format: 'video/mp4',
    data_ref: 'r2:videos/DS00001AAAAAAAAAAAAAAAAAAAAA/master.m3u8',
    thumbnail_ref: `${NOAA}/atmosphere/hurricane_season_2024/thumb.jpg`,
    legend_ref: `${NOAA}/atmosphere/hurricane_season_2024/colorbar.png`,
    caption_ref: null,
    color_table_ref: null,
    published_at: '2026-04-30T00:00:00.000Z',
    ...over,
  }
}

interface FakeClientOptions {
  rows?: PublisherRow[]
  singleRow?: PublisherRow
  patchFailFor?: Set<string>
}

function fakeClient(opts: FakeClientOptions = {}) {
  const rows = opts.rows ?? []
  const list = vi.fn(async () => ({
    ok: true as const,
    status: 200,
    body: { datasets: rows, next_cursor: null },
  }))
  const get = vi.fn(async (id: string) => {
    if (opts.singleRow && opts.singleRow.id === id) {
      return { ok: true as const, status: 200, body: { dataset: opts.singleRow } }
    }
    return { ok: false as const, status: 404, error: 'not_found' }
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

/** Build a successful fetchAsset stub that returns canned bytes
 * + a derived extension from the URL. */
function fakeFetchAsset(opts: { failFor?: Set<string>; bytesPerUrl?: Map<string, Uint8Array> } = {}) {
  return vi.fn(async (input: { url: string }) => {
    if (opts.failFor?.has(input.url)) {
      throw new Error(`fetch_failed simulated for ${input.url}`)
    }
    const ext = (input.url.match(/\.([a-z0-9]+)(?:\?|$)/i)?.[1] ?? '').toLowerCase()
    const bytes = opts.bytesPerUrl?.get(input.url) ?? new TextEncoder().encode(`fake-${ext}`)
    const contentType =
      ext === 'png' ? 'image/png' :
      ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
      ext === 'srt' ? 'application/x-subrip' :
      'application/octet-stream'
    return {
      bytes,
      contentType,
      sizeBytes: bytes.length,
      extension: ext,
      sourceUrl: input.url,
    }
  })
}

interface UploadCall {
  key: string
  bytes: Uint8Array
  contentType: string
}

function fakeUploadR2Object(opts: { failForKey?: Set<string> } = {}) {
  const calls: UploadCall[] = []
  const fn = vi.fn(
    async (_c: R2UploadConfig, key: string, body: Uint8Array, contentType: string) => {
      if (opts.failForKey?.has(key)) {
        throw new Error(`upload failed for ${key}`)
      }
      calls.push({ key, bytes: body, contentType })
      return { key, bytes: body.byteLength, durationMs: 5 }
    },
  )
  return { fn, calls }
}

function noopEmit(): (e: TelemetryEventPayload) => void {
  return () => {}
}

describe('parseAssetTypes', () => {
  it('returns the default 4-type list when the flag is absent / empty', () => {
    expect(parseAssetTypes(undefined)).toEqual(['thumbnail', 'legend', 'caption', 'color_table'])
    expect(parseAssetTypes('')).toEqual(['thumbnail', 'legend', 'caption', 'color_table'])
    expect(parseAssetTypes('   ')).toEqual(['thumbnail', 'legend', 'caption', 'color_table'])
  })

  it('parses CSV, trims whitespace, dedupes', () => {
    expect(parseAssetTypes('thumbnail, legend,  thumbnail')).toEqual(['thumbnail', 'legend'])
  })

  it('rejects an unknown value with an explicit error', () => {
    const r = parseAssetTypes('thumbnial')
    expect('error' in r).toBe(true)
    if (!('error' in r)) return
    expect(r.error).toMatch(/unknown asset type "thumbnial"/)
  })

  it('accepts each valid type in isolation', () => {
    for (const t of ['thumbnail', 'legend', 'caption', 'color_table'] as AssetType[]) {
      expect(parseAssetTypes(t)).toEqual([t])
    }
  })
})

describe('refNeedsMigration', () => {
  it('returns false for null / empty / whitespace-only', () => {
    expect(refNeedsMigration(null)).toBe(false)
    expect(refNeedsMigration('')).toBe(false)
    expect(refNeedsMigration('   ')).toBe(false)
  })

  it('returns false for r2:-prefixed values (already migrated)', () => {
    expect(refNeedsMigration('r2:datasets/DS001/thumbnail.png')).toBe(false)
  })

  it('returns true for a bare https URL', () => {
    expect(refNeedsMigration(`${NOAA}/x.png`)).toBe(true)
  })
})

describe('runMigrateR2Assets — plan + dry-run', () => {
  it('--dry-run summarises eligible rows + per-type counts', async () => {
    const { client, handles } = fakeClient({
      rows: [
        makeRow({
          id: 'DS_A',
          thumbnail_ref: `${NOAA}/a/thumb.jpg`,
          legend_ref: `${NOAA}/a/legend.png`,
          caption_ref: `${NOAA}/a/cap.srt`,
          color_table_ref: `${NOAA}/a/colortable.png`,
        }),
        makeRow({
          id: 'DS_B',
          thumbnail_ref: 'r2:datasets/DS_B/thumbnail.png', // already migrated
          legend_ref: `${NOAA}/b/legend.png`,
          caption_ref: null,
          color_table_ref: null,
        }),
      ],
    })
    const { ctx, out } = makeCtx(client, { 'dry-run': true })
    const code = await runMigrateR2Assets(ctx, {
      r2Config: R2_CONFIG,
      fetchAsset: fakeFetchAsset(),
      uploadR2Object: fakeUploadR2Object().fn,
    })
    expect(code).toBe(0)
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(out.text()).toContain('rows scanned:                          2')
    expect(out.text()).toContain('rows with at least one eligible asset: 2  (non-r2: *_ref values)')
    expect(out.text()).toContain('thumbnail      1') // DS_B already done, only DS_A's thumb counts
    expect(out.text()).toContain('legend         2')
    expect(out.text()).toContain('caption        1')
    expect(out.text()).toContain('color-table    1')
    expect(out.text()).toContain('Dry run')
  })

  it('--types restricts the dry-run summary + count', async () => {
    const { client } = fakeClient({
      rows: [
        makeRow({
          id: 'DS_A',
          thumbnail_ref: `${NOAA}/a/t.jpg`,
          legend_ref: `${NOAA}/a/l.png`,
        }),
      ],
    })
    const { ctx, out } = makeCtx(client, { 'dry-run': true, types: 'thumbnail' })
    await runMigrateR2Assets(ctx, {
      r2Config: R2_CONFIG,
      fetchAsset: fakeFetchAsset(),
      uploadR2Object: fakeUploadR2Object().fn,
    })
    expect(out.text()).toContain('types: thumbnail')
    expect(out.text()).toContain('thumbnail      1')
    // Legend wasn't requested so it doesn't appear in the summary.
    expect(out.text()).not.toMatch(/\blegend\s+\d/)
  })

  it('rejects --types=bogus with exit 2 before doing anything', async () => {
    const { client, handles } = fakeClient({ rows: [makeRow()] })
    const { ctx, err } = makeCtx(client, { types: 'bogus' })
    const code = await runMigrateR2Assets(ctx, { r2Config: R2_CONFIG })
    expect(code).toBe(2)
    expect(err.text()).toMatch(/unknown asset type "bogus"/)
    expect(handles.list).not.toHaveBeenCalled()
  })

  it('plan summary per-type counts respect --limit (3b/N)', async () => {
    // Pre-3b/N the per-type counts were computed across ALL eligible
    // rows even when --limit capped the run. Operator running
    // `--limit=2` saw "thumbnail: 5" and over-estimated. The
    // counts now reflect just the rows the run will actually touch,
    // with an "(of N)" suffix preserving the unfiltered total
    // for context.
    const rows: PublisherRow[] = []
    for (let i = 0; i < 5; i++) {
      rows.push(makeRow({
        id: `DS_${i}`,
        thumbnail_ref: `${NOAA}/${i}/t.jpg`,
        legend_ref: `${NOAA}/${i}/l.png`,
      }))
    }
    const { client } = fakeClient({ rows })
    const { ctx, out } = makeCtx(client, { 'dry-run': true, limit: '2' })
    await runMigrateR2Assets(ctx, {
      r2Config: R2_CONFIG,
      fetchAsset: fakeFetchAsset(),
      uploadR2Object: fakeUploadR2Object().fn,
    })
    // 5 rows × 2 types = 10 eligible total; limit=2 → 4 in this run.
    expect(out.text()).toContain('will migrate this run:                 2 (capped by --limit)')
    expect(out.text()).toContain('total asset uploads:                   4  (of 10 eligible across all rows)')
    expect(out.text()).toContain('thumbnail      2  (of 5)')
    expect(out.text()).toContain('legend         2  (of 5)')
  })
})

describe('runMigrateR2Assets — live migration', () => {
  it('migrates every eligible asset and PATCHes the row once', async () => {
    const { client, handles } = fakeClient({
      rows: [
        makeRow({
          id: 'DS_A',
          thumbnail_ref: `${NOAA}/a/thumb.jpg`,
          legend_ref: `${NOAA}/a/legend.png`,
        }),
      ],
    })
    const upload = fakeUploadR2Object()
    const events: TelemetryEventPayload[] = []
    const { ctx } = makeCtx(client)
    const code = await runMigrateR2Assets(ctx, {
      r2Config: R2_CONFIG,
      fetchAsset: fakeFetchAsset(),
      uploadR2Object: upload.fn,
      emitTelemetry: e => {
        events.push(e)
      },
      skipPace: true,
      now: FROZEN_NOW,
    })
    expect(code).toBe(0)
    // Two R2 PUTs, one PATCH.
    expect(upload.calls).toHaveLength(2)
    expect(handles.updateDataset).toHaveBeenCalledTimes(1)
    const patchBody = handles.updateDataset.mock.calls[0][1] as Record<string, unknown>
    expect(patchBody.thumbnail_ref).toBe('r2:datasets/DS_A/thumbnail.jpg')
    expect(patchBody.legend_ref).toBe('r2:datasets/DS_A/legend.png')
    // Telemetry: one event per asset, both ok.
    expect(events).toHaveLength(2)
    for (const e of events) {
      expect(e.event_type).toBe('migration_r2_assets')
      expect(e.outcome).toBe('ok')
      expect(e.dataset_id).toBe('DS_A')
    }
  })

  it('skips r2:-prefixed and null columns (idempotency)', async () => {
    const { client, handles } = fakeClient({
      rows: [
        makeRow({
          id: 'DS_X',
          thumbnail_ref: 'r2:datasets/DS_X/thumbnail.png', // already done
          legend_ref: null, // no asset
          caption_ref: `${NOAA}/x.srt`, // do this one
          color_table_ref: null,
        }),
      ],
    })
    const upload = fakeUploadR2Object()
    const { ctx } = makeCtx(client)
    await runMigrateR2Assets(ctx, {
      r2Config: R2_CONFIG,
      fetchAsset: fakeFetchAsset(),
      uploadR2Object: upload.fn,
      emitTelemetry: noopEmit(),
      skipPace: true,
    })
    // Only caption gets uploaded.
    expect(upload.calls).toHaveLength(1)
    expect(upload.calls[0].key).toBe('datasets/DS_X/caption.vtt')
    // PATCH body has only caption_ref.
    const patchBody = handles.updateDataset.mock.calls[0][1] as Record<string, unknown>
    expect(Object.keys(patchBody)).toEqual(['caption_ref'])
  })

  it('inline-converts SRT → VTT for captions', async () => {
    const srt = '1\n00:00:00,500 --> 00:00:01,200\nhello\n'
    const fetchAsset = vi.fn(async (input: { url: string }) => ({
      bytes: new TextEncoder().encode(srt),
      contentType: 'application/x-subrip',
      sizeBytes: srt.length,
      extension: 'srt',
      sourceUrl: input.url,
    }))
    const upload = fakeUploadR2Object()
    const { client } = fakeClient({
      rows: [
        makeRow({
          id: 'DS_C',
          thumbnail_ref: null,
          legend_ref: null,
          caption_ref: `${NOAA}/c.srt`,
        }),
      ],
    })
    const { ctx } = makeCtx(client)
    await runMigrateR2Assets(ctx, {
      r2Config: R2_CONFIG,
      fetchAsset: fetchAsset as unknown as typeof import('./lib/asset-fetch').fetchAsset,
      uploadR2Object: upload.fn,
      emitTelemetry: noopEmit(),
      skipPace: true,
    })
    expect(upload.calls).toHaveLength(1)
    expect(upload.calls[0].key).toBe('datasets/DS_C/caption.vtt')
    expect(upload.calls[0].contentType).toBe('text/vtt')
    const text = new TextDecoder('utf-8').decode(upload.calls[0].bytes)
    expect(text.startsWith('WEBVTT\n\n')).toBe(true)
    expect(text).toContain('00:00:00.500 --> 00:00:01.200')
  })

  it('--types filter limits which columns are touched', async () => {
    const { client, handles } = fakeClient({
      rows: [
        makeRow({
          id: 'DS_A',
          thumbnail_ref: `${NOAA}/a/t.jpg`,
          legend_ref: `${NOAA}/a/l.png`,
        }),
      ],
    })
    const upload = fakeUploadR2Object()
    const { ctx } = makeCtx(client, { types: 'legend' })
    await runMigrateR2Assets(ctx, {
      r2Config: R2_CONFIG,
      fetchAsset: fakeFetchAsset(),
      uploadR2Object: upload.fn,
      emitTelemetry: noopEmit(),
      skipPace: true,
    })
    expect(upload.calls).toHaveLength(1)
    expect(upload.calls[0].key).toBe('datasets/DS_A/legend.png')
    const patchBody = handles.updateDataset.mock.calls[0][1] as Record<string, unknown>
    expect(Object.keys(patchBody)).toEqual(['legend_ref'])
  })

  it('partial failure: failed asset is reported; survivors get PATCHed', async () => {
    const { client, handles } = fakeClient({
      rows: [
        makeRow({
          id: 'DS_PART',
          thumbnail_ref: `${NOAA}/x/thumb.jpg`,
          legend_ref: `${NOAA}/x/legend.png`,
        }),
      ],
    })
    const upload = fakeUploadR2Object()
    const events: TelemetryEventPayload[] = []
    const { ctx, err } = makeCtx(client)
    const code = await runMigrateR2Assets(ctx, {
      r2Config: R2_CONFIG,
      // Fail just the thumbnail fetch.
      fetchAsset: fakeFetchAsset({ failFor: new Set([`${NOAA}/x/thumb.jpg`]) }),
      uploadR2Object: upload.fn,
      emitTelemetry: e => {
        events.push(e)
      },
      skipPace: true,
    })
    // One asset failed → exit code 1, but the other asset got
    // migrated and PATCHed.
    expect(code).toBe(1)
    expect(upload.calls).toHaveLength(1)
    expect(upload.calls[0].key).toBe('datasets/DS_PART/legend.png')
    expect(handles.updateDataset).toHaveBeenCalledTimes(1)
    const patchBody = handles.updateDataset.mock.calls[0][1] as Record<string, unknown>
    // Only legend_ref in the PATCH; thumbnail_ref stays on NOAA.
    expect(Object.keys(patchBody)).toEqual(['legend_ref'])
    // Telemetry: one fetch_failed, one ok.
    const outcomes = events.map(e => e.outcome).sort()
    expect(outcomes).toEqual(['fetch_failed', 'ok'])
    expect(err.text()).toMatch(/fetch_failed/)
  })

  it('patch_failed: successful R2 PUTs are promoted to patch_failed (orphans)', async () => {
    const { client, handles } = fakeClient({
      rows: [
        makeRow({
          id: 'DS_PATCH_FAIL',
          thumbnail_ref: `${NOAA}/p/t.jpg`,
          legend_ref: `${NOAA}/p/l.png`,
        }),
      ],
      patchFailFor: new Set(['DS_PATCH_FAIL']),
    })
    const upload = fakeUploadR2Object()
    const events: TelemetryEventPayload[] = []
    const { ctx, err } = makeCtx(client)
    const code = await runMigrateR2Assets(ctx, {
      r2Config: R2_CONFIG,
      fetchAsset: fakeFetchAsset(),
      uploadR2Object: upload.fn,
      emitTelemetry: e => {
        events.push(e)
      },
      skipPace: true,
    })
    expect(code).toBe(1)
    // Both R2 PUTs happened (we don't roll back R2 on PATCH
    // failure — that's the operator's rollback flow).
    expect(upload.calls).toHaveLength(2)
    expect(handles.updateDataset).toHaveBeenCalledTimes(1)
    // Both telemetry events flipped to patch_failed.
    expect(events).toHaveLength(2)
    for (const e of events) expect(e.outcome).toBe('patch_failed')
    // Log mentions the specific auxiliary columns the PATCH tried
    // (not "data_ref" — that's the video pump's column). Helps
    // operator triage point at the right code path.
    expect(err.text()).toContain('asset *_ref PATCH failed')
    expect(err.text()).toContain('thumbnail_ref')
    expect(err.text()).toContain('legend_ref')
  })

  it('--id targets a single row via GET', async () => {
    const target = makeRow({
      id: 'DS_TARGET',
      thumbnail_ref: `${NOAA}/t.jpg`,
      legend_ref: null,
    })
    const { client, handles } = fakeClient({ singleRow: target })
    const upload = fakeUploadR2Object()
    const { ctx } = makeCtx(client, { id: 'DS_TARGET' })
    await runMigrateR2Assets(ctx, {
      r2Config: R2_CONFIG,
      fetchAsset: fakeFetchAsset(),
      uploadR2Object: upload.fn,
      emitTelemetry: noopEmit(),
      skipPace: true,
    })
    expect(handles.list).not.toHaveBeenCalled()
    expect(handles.get).toHaveBeenCalledWith('DS_TARGET')
    expect(upload.calls).toHaveLength(1)
  })

  it('exits 2 when R2 credentials are missing', async () => {
    const { client, handles } = fakeClient({ rows: [makeRow()] })
    const { ctx, err } = makeCtx(client)
    const code = await runMigrateR2Assets(ctx, {
      r2Config: { ...R2_CONFIG, accessKeyId: '' },
    })
    expect(code).toBe(2)
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(err.text()).toMatch(/R2_S3_ENDPOINT.*R2_ACCESS_KEY_ID.*R2_SECRET_ACCESS_KEY/)
  })

  it('nothing-to-migrate exits 0 cleanly', async () => {
    // All rows already migrated.
    const { client, handles } = fakeClient({
      rows: [
        makeRow({
          thumbnail_ref: 'r2:datasets/x/thumbnail.png',
          legend_ref: 'r2:datasets/x/legend.png',
          caption_ref: null,
          color_table_ref: null,
        }),
      ],
    })
    const upload = fakeUploadR2Object()
    const { ctx, out } = makeCtx(client)
    const code = await runMigrateR2Assets(ctx, {
      r2Config: R2_CONFIG,
      fetchAsset: fakeFetchAsset(),
      uploadR2Object: upload.fn,
      emitTelemetry: noopEmit(),
      skipPace: true,
    })
    expect(code).toBe(0)
    expect(upload.calls).toHaveLength(0)
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(out.text()).toContain('Nothing to migrate')
  })
})
