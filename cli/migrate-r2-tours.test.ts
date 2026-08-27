// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for `terraviz migrate-r2-tours` (Phase 3c commit B).
 *
 * Exercised against:
 *   - a hand-rolled fake `TerravizClient` (list / get / updateDataset);
 *   - DI hooks for `fetchAsset` and `uploadR2Object` so no real
 *     HTTP traffic runs;
 *   - a telemetry recorder.
 *
 * Coverage maps to the per-row pipeline in migrate-r2-tours.ts:
 *
 *   - `tourRefNeedsMigration`: null / empty / r2: / valid URL.
 *   - `--dry-run` plan summary: scanned, eligible, already-r2,
 *     sample listing.
 *   - Happy path: tour.json + 2 distinct siblings → 3 R2 uploads
 *     + 1 PATCH; telemetry event carries the right counts.
 *   - Dead source (NOAA 404): outcome=dead_source, no R2 PUTs,
 *     no PATCH, exit 0 (NOT counted as failure).
 *   - Non-404 fetch failure: outcome=fetch_failed, exit 1.
 *   - Parse failure (bytes aren't valid JSON): outcome=parse_failed.
 *   - Sibling fetch failure: tour.json is NOT uploaded (atomic),
 *     no PATCH, exit 1.
 *   - Sibling dedupe: a tour referencing `audio.mp3` from two
 *     different tasks fetches and uploads it once.
 *   - Path-traversal sibling (`../bad.png`): refused →
 *     sibling_fetch_failed.
 *   - External + absolute_sos_cdn assets in the tour are NOT
 *     fetched (policy 1).
 *   - Idempotency: rows whose `run_tour_on_load` already starts
 *     with `r2:` are excluded from the eligible set.
 *   - Empty tour.json (tourTasks: []) still migrates the bytes
 *     and PATCHes — zero siblings.
 *   - Upload failure → outcome=upload_failed, no PATCH.
 *   - PATCH failure after successful uploads → outcome=patch_failed.
 *   - `--id` targets a single row via the GET endpoint.
 *   - Missing R2 credentials exits 2 before any work.
 */

import { describe, expect, it, vi } from 'vitest'
import { runMigrateR2Tours, tourRefNeedsMigration } from './migrate-r2-tours'
import type { CommandContext } from './commands'
import type { TerravizClient } from './lib/client'
import { parseArgs } from './lib/args'
import { AssetFetchError, type FetchedAsset } from './lib/asset-fetch'
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
  run_tour_on_load: string | null
  published_at: string | null
}

const NOAA = 'https://d3sik7mbbzunjo.cloudfront.net'
const TOUR_URL = `${NOAA}/extras/foo/tour.json`

function makeRow(over: Partial<PublisherRow> = {}): PublisherRow {
  return {
    id: 'DS00001AAAAAAAAAAAAAAAAAAAAA',
    legacy_id: 'INTERNAL_SOS_TEST',
    title: 'Test Tour',
    run_tour_on_load: TOUR_URL,
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

/** Build a fetchAsset stub. `tourJsons` maps tour URLs → the
 * JSON object to serialize; `siblingsByUrl` maps sibling URLs
 * → canned bytes (and content type). `failFor` maps URL → an
 * Error or AssetFetchError to throw. */
function fakeFetchAsset(opts: {
  tourJsons?: Map<string, unknown>
  siblingsByUrl?: Map<string, { bytes: Uint8Array; contentType: string }>
  failFor?: Map<string, Error>
}) {
  return vi.fn(async (input: { url: string }): Promise<FetchedAsset> => {
    const failure = opts.failFor?.get(input.url)
    if (failure) throw failure
    const tour = opts.tourJsons?.get(input.url)
    if (tour !== undefined) {
      const bytes = new TextEncoder().encode(JSON.stringify(tour))
      return {
        bytes,
        contentType: 'application/json',
        sizeBytes: bytes.length,
        extension: 'json',
        sourceUrl: input.url,
      }
    }
    const sib = opts.siblingsByUrl?.get(input.url)
    if (sib) {
      return {
        bytes: sib.bytes,
        contentType: sib.contentType,
        sizeBytes: sib.bytes.length,
        extension: input.url.split('.').pop() ?? '',
        sourceUrl: input.url,
      }
    }
    throw new AssetFetchError(`no stub for ${input.url}`, input.url, null)
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

function recorder(): {
  events: TelemetryEventPayload[]
  emit: (e: TelemetryEventPayload) => void
} {
  const events: TelemetryEventPayload[] = []
  return { events, emit: e => void events.push(e) }
}

describe('tourRefNeedsMigration', () => {
  it('returns false for null / empty / whitespace-only', () => {
    expect(tourRefNeedsMigration(null)).toBe(false)
    expect(tourRefNeedsMigration('')).toBe(false)
    expect(tourRefNeedsMigration('   ')).toBe(false)
  })

  it('returns false for r2:-prefixed values (already migrated)', () => {
    expect(tourRefNeedsMigration('r2:tours/DS001/tour.json')).toBe(false)
  })

  it('returns true for a bare https URL', () => {
    expect(tourRefNeedsMigration(TOUR_URL)).toBe(true)
  })
})

describe('runMigrateR2Tours — plan + dry-run', () => {
  it('summarises scanned / eligible / already-r2 rows', async () => {
    const { client, handles } = fakeClient({
      rows: [
        makeRow({ id: 'DS_A', run_tour_on_load: `${NOAA}/a/tour.json` }),
        makeRow({ id: 'DS_B', run_tour_on_load: 'r2:tours/DS_B/tour.json' }),
        makeRow({ id: 'DS_C', run_tour_on_load: null }),
        makeRow({ id: 'DS_D', run_tour_on_load: `${NOAA}/d/tour.json` }),
      ],
    })
    const { ctx, out } = makeCtx(client, { 'dry-run': true })
    const exit = await runMigrateR2Tours(ctx, { skipPace: true })
    expect(exit).toBe(0)
    expect(handles.list).toHaveBeenCalledTimes(1)
    const text = out.text()
    expect(text).toMatch(/rows scanned:\s+4/)
    expect(text).toMatch(/rows with run_tour_on_load:\s+3/)
    expect(text).toMatch(/already on r2: \(will skip\):\s+1/)
    expect(text).toMatch(/eligible \(NOAA \/ external URLs\):\s+2/)
    expect(text).toMatch(/Dry run — no rows will be migrated/)
  })

  it('returns 0 with "Nothing to migrate" when no rows are eligible', async () => {
    const { client } = fakeClient({
      rows: [makeRow({ id: 'DS_A', run_tour_on_load: 'r2:tours/DS_A/tour.json' })],
    })
    const { ctx, out } = makeCtx(client)
    const exit = await runMigrateR2Tours(ctx, {
      skipPace: true,
      r2Config: R2_CONFIG,
      fetchAsset: fakeFetchAsset({}),
      uploadR2Object: fakeUploadR2Object().fn,
      emitTelemetry: recorder().emit,
    })
    expect(exit).toBe(0)
    expect(out.text()).toMatch(/Nothing to migrate/)
  })
})

describe('runMigrateR2Tours — happy path', () => {
  it('uploads tour.json + each unique sibling and emits one PATCH per row', async () => {
    const row = makeRow({ id: 'DS_X', run_tour_on_load: TOUR_URL })
    const { client, handles } = fakeClient({ rows: [row] })
    const tourFile = {
      tourTasks: [
        { setEnvView: '1globe' },
        { playAudio: { filename: 'audio/intro.mp3' } },
        { showImage: { imageID: 'i1', filename: 'overlays/title.png' } },
        // External link — must NOT be fetched.
        { playVideo: { filename: 'https://www.youtube.com/embed/abc' } },
        // hideImage referencing the earlier overlay — not a fetch.
        { hideImage: 'i1' },
      ],
    }
    const audioBytes = new TextEncoder().encode('fake mp3 bytes')
    const pngBytes = new TextEncoder().encode('fake png bytes')
    const fetchAsset = fakeFetchAsset({
      tourJsons: new Map([[TOUR_URL, tourFile]]),
      siblingsByUrl: new Map([
        [`${NOAA}/extras/foo/audio/intro.mp3`, { bytes: audioBytes, contentType: 'audio/mpeg' }],
        [`${NOAA}/extras/foo/overlays/title.png`, { bytes: pngBytes, contentType: 'image/png' }],
      ]),
    })
    const upload = fakeUploadR2Object()
    const events = recorder()
    const { ctx, out } = makeCtx(client)
    const exit = await runMigrateR2Tours(ctx, {
      skipPace: true,
      r2Config: R2_CONFIG,
      now: FROZEN_NOW,
      fetchAsset,
      uploadR2Object: upload.fn,
      emitTelemetry: events.emit,
    })
    expect(exit).toBe(0)
    // tour.json + 2 siblings (external YouTube is left alone).
    expect(upload.calls.map(c => c.key).sort()).toEqual([
      'tours/DS_X/audio/intro.mp3',
      'tours/DS_X/overlays/title.png',
      'tours/DS_X/tour.json',
    ])
    // Content types preserved per-file.
    const byKey = Object.fromEntries(upload.calls.map(c => [c.key, c]))
    expect(byKey['tours/DS_X/tour.json'].contentType).toBe('application/json')
    expect(byKey['tours/DS_X/audio/intro.mp3'].contentType).toBe('audio/mpeg')
    expect(byKey['tours/DS_X/overlays/title.png'].contentType).toBe('image/png')
    // One PATCH, body = the r2: ref to the tour.json.
    expect(handles.updateDataset).toHaveBeenCalledTimes(1)
    expect(handles.updateDataset).toHaveBeenCalledWith('DS_X', {
      run_tour_on_load: 'r2:tours/DS_X/tour.json',
    })
    // One telemetry event, outcome=ok, sibling counts roll up.
    expect(events.events).toHaveLength(1)
    expect(events.events[0]).toMatchObject({
      event_type: 'migration_r2_tours',
      dataset_id: 'DS_X',
      outcome: 'ok',
      r2_key: 'tours/DS_X/tour.json',
      siblings_relative: 2,
      siblings_external: 1,
      siblings_sos_cdn: 0,
      siblings_migrated: 2,
    })
    expect(out.text()).toMatch(/\[DS_X\] ok/)
  })

  it('dedupes a sibling referenced from multiple tasks', async () => {
    const row = makeRow({ id: 'DS_DUP', run_tour_on_load: TOUR_URL })
    const { client } = fakeClient({ rows: [row] })
    const tourFile = {
      tourTasks: [
        { playAudio: { filename: 'audio.mp3' } },
        { playAudio: { filename: 'audio.mp3' } }, // duplicate
        { showImage: { imageID: 'i1', filename: 'audio.mp3' } }, // duplicate (different field)
      ],
    }
    const fetchAsset = fakeFetchAsset({
      tourJsons: new Map([[TOUR_URL, tourFile]]),
      siblingsByUrl: new Map([
        [`${NOAA}/extras/foo/audio.mp3`, { bytes: new Uint8Array([1, 2, 3]), contentType: 'audio/mpeg' }],
      ]),
    })
    const upload = fakeUploadR2Object()
    const events = recorder()
    const { ctx } = makeCtx(client)
    const exit = await runMigrateR2Tours(ctx, {
      skipPace: true,
      r2Config: R2_CONFIG,
      fetchAsset,
      uploadR2Object: upload.fn,
      emitTelemetry: events.emit,
    })
    expect(exit).toBe(0)
    // 1 tour.json + 1 sibling (deduped), NOT 1 + 3.
    expect(upload.calls).toHaveLength(2)
    // The sibling URL was fetched exactly once.
    const siblingFetches = fetchAsset.mock.calls.filter(
      c => c[0].url === `${NOAA}/extras/foo/audio.mp3`,
    )
    expect(siblingFetches).toHaveLength(1)
    expect(events.events[0]).toMatchObject({
      siblings_relative: 3, // counts every parser hit
      siblings_migrated: 1, // unique uploads
      outcome: 'ok',
    })
  })

  it('empty tour (tourTasks: []) migrates the bytes and PATCHes', async () => {
    const row = makeRow({ id: 'DS_EMPTY' })
    const { client, handles } = fakeClient({ rows: [row] })
    const fetchAsset = fakeFetchAsset({
      tourJsons: new Map([[TOUR_URL, { tourTasks: [] }]]),
    })
    const upload = fakeUploadR2Object()
    const events = recorder()
    const { ctx } = makeCtx(client)
    const exit = await runMigrateR2Tours(ctx, {
      skipPace: true,
      r2Config: R2_CONFIG,
      fetchAsset,
      uploadR2Object: upload.fn,
      emitTelemetry: events.emit,
    })
    expect(exit).toBe(0)
    expect(upload.calls.map(c => c.key)).toEqual(['tours/DS_EMPTY/tour.json'])
    expect(handles.updateDataset).toHaveBeenCalledWith('DS_EMPTY', {
      run_tour_on_load: 'r2:tours/DS_EMPTY/tour.json',
    })
    expect(events.events[0]).toMatchObject({
      outcome: 'ok',
      siblings_relative: 0,
      siblings_migrated: 0,
    })
  })
})

describe('runMigrateR2Tours — failure modes', () => {
  it('NOAA 404 → outcome=dead_source, no uploads / PATCH, exit 0', async () => {
    const row = makeRow({ id: 'DS_726' })
    const { client, handles } = fakeClient({ rows: [row] })
    const fetchAsset = fakeFetchAsset({
      failFor: new Map([[TOUR_URL, new AssetFetchError('unexpected status 404 Not Found', TOUR_URL, 404)]]),
    })
    const upload = fakeUploadR2Object()
    const events = recorder()
    const { ctx, err } = makeCtx(client)
    const exit = await runMigrateR2Tours(ctx, {
      skipPace: true,
      r2Config: R2_CONFIG,
      fetchAsset,
      uploadR2Object: upload.fn,
      emitTelemetry: events.emit,
    })
    expect(exit).toBe(0) // dead_source is not a failure
    expect(upload.calls).toEqual([])
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(events.events[0]).toMatchObject({ outcome: 'dead_source' })
    expect(err.text()).toMatch(/dead_source/)
  })

  it('non-404 fetch error → outcome=fetch_failed, exit 1', async () => {
    const row = makeRow({ id: 'DS_NET' })
    const { client, handles } = fakeClient({ rows: [row] })
    const fetchAsset = fakeFetchAsset({
      failFor: new Map([[TOUR_URL, new AssetFetchError('connection reset', TOUR_URL, null)]]),
    })
    const upload = fakeUploadR2Object()
    const events = recorder()
    const { ctx } = makeCtx(client)
    const exit = await runMigrateR2Tours(ctx, {
      skipPace: true,
      r2Config: R2_CONFIG,
      fetchAsset,
      uploadR2Object: upload.fn,
      emitTelemetry: events.emit,
    })
    expect(exit).toBe(1)
    expect(upload.calls).toEqual([])
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(events.events[0]).toMatchObject({ outcome: 'fetch_failed' })
  })

  it('tour.json without a tourTasks array → outcome=parse_failed', async () => {
    // Bytes parse as JSON but the file isn't a valid SOS tour file
    // (no tourTasks). The migration must NOT upload + PATCH — the
    // row was effectively broken pre-migration; relocating the
    // bytes wouldn't fix it and would waste R2 storage.
    const row = makeRow({ id: 'DS_NOTASKS' })
    const { client, handles } = fakeClient({ rows: [row] })
    const fetchAsset = fakeFetchAsset({
      tourJsons: new Map([[TOUR_URL, { foo: 'bar' /* no tourTasks */ }]]),
    })
    const upload = fakeUploadR2Object()
    const events = recorder()
    const { ctx, err } = makeCtx(client)
    const exit = await runMigrateR2Tours(ctx, {
      skipPace: true,
      r2Config: R2_CONFIG,
      fetchAsset,
      uploadR2Object: upload.fn,
      emitTelemetry: events.emit,
    })
    expect(exit).toBe(1)
    expect(upload.calls).toEqual([])
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(events.events[0]).toMatchObject({ outcome: 'parse_failed' })
    expect(err.text()).toMatch(/no `tourTasks` array/)
  })

  it('tour.json with non-array tourTasks → outcome=parse_failed', async () => {
    // Defensive: tourTasks present but wrong type. parseTourFile
    // would silently return empty assets; the pump explicitly
    // refuses so the operator sees the malformed file.
    const row = makeRow({ id: 'DS_BADTASKS' })
    const { client, handles } = fakeClient({ rows: [row] })
    const fetchAsset = fakeFetchAsset({
      tourJsons: new Map([[TOUR_URL, { tourTasks: 'oops not an array' }]]),
    })
    const upload = fakeUploadR2Object()
    const events = recorder()
    const { ctx } = makeCtx(client)
    const exit = await runMigrateR2Tours(ctx, {
      skipPace: true,
      r2Config: R2_CONFIG,
      fetchAsset,
      uploadR2Object: upload.fn,
      emitTelemetry: events.emit,
    })
    expect(exit).toBe(1)
    expect(upload.calls).toEqual([])
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(events.events[0]).toMatchObject({ outcome: 'parse_failed' })
  })

  it('tour.json bytes that aren\'t valid JSON → outcome=parse_failed', async () => {
    const row = makeRow({ id: 'DS_BAD' })
    const { client, handles } = fakeClient({ rows: [row] })
    // Hand-craft a fetchAsset that returns bytes that won't JSON-parse.
    const fetchAsset = vi.fn(
      async (_input: { url: string }): Promise<FetchedAsset> => {
        const bytes = new TextEncoder().encode('<html>oops not JSON</html>')
        return {
          bytes,
          contentType: 'text/html',
          sizeBytes: bytes.length,
          extension: 'json',
          sourceUrl: TOUR_URL,
        }
      },
    )
    const upload = fakeUploadR2Object()
    const events = recorder()
    const { ctx } = makeCtx(client)
    const exit = await runMigrateR2Tours(ctx, {
      skipPace: true,
      r2Config: R2_CONFIG,
      fetchAsset,
      uploadR2Object: upload.fn,
      emitTelemetry: events.emit,
    })
    expect(exit).toBe(1)
    expect(upload.calls).toEqual([])
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(events.events[0]).toMatchObject({ outcome: 'parse_failed' })
  })

  it('sibling fetch failure → no tour.json upload, no PATCH, outcome=sibling_fetch_failed', async () => {
    const row = makeRow({ id: 'DS_SIB' })
    const { client, handles } = fakeClient({ rows: [row] })
    const tourFile = {
      tourTasks: [{ playAudio: { filename: 'broken.mp3' } }],
    }
    const fetchAsset = fakeFetchAsset({
      tourJsons: new Map([[TOUR_URL, tourFile]]),
      failFor: new Map([
        [`${NOAA}/extras/foo/broken.mp3`, new AssetFetchError('404', `${NOAA}/extras/foo/broken.mp3`, 404)],
      ]),
    })
    const upload = fakeUploadR2Object()
    const events = recorder()
    const { ctx, err } = makeCtx(client)
    const exit = await runMigrateR2Tours(ctx, {
      skipPace: true,
      r2Config: R2_CONFIG,
      fetchAsset,
      uploadR2Object: upload.fn,
      emitTelemetry: events.emit,
    })
    expect(exit).toBe(1)
    // Atomic: tour.json upload did NOT happen.
    expect(upload.calls).toEqual([])
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(events.events[0]).toMatchObject({ outcome: 'sibling_fetch_failed' })
    expect(err.text()).toMatch(/sibling_fetch_failed/)
  })

  it('path-traversal sibling (../bad.png) → outcome=sibling_fetch_failed without fetching', async () => {
    const row = makeRow({ id: 'DS_TRAVERSE' })
    const { client } = fakeClient({ rows: [row] })
    const tourFile = {
      tourTasks: [{ showImage: { imageID: 'i1', filename: '../bad.png' } }],
    }
    const fetchAsset = fakeFetchAsset({
      tourJsons: new Map([[TOUR_URL, tourFile]]),
    })
    const upload = fakeUploadR2Object()
    const events = recorder()
    const { ctx } = makeCtx(client)
    const exit = await runMigrateR2Tours(ctx, {
      skipPace: true,
      r2Config: R2_CONFIG,
      fetchAsset,
      uploadR2Object: upload.fn,
      emitTelemetry: events.emit,
    })
    expect(exit).toBe(1)
    expect(upload.calls).toEqual([])
    // Only tour.json was fetched; siblings were rejected pre-fetch.
    expect(fetchAsset).toHaveBeenCalledTimes(1)
    expect(events.events[0]).toMatchObject({ outcome: 'sibling_fetch_failed' })
  })

  it('R2 upload failure → outcome=upload_failed, no PATCH', async () => {
    const row = makeRow({ id: 'DS_PUT' })
    const { client, handles } = fakeClient({ rows: [row] })
    const tourFile = { tourTasks: [] }
    const fetchAsset = fakeFetchAsset({ tourJsons: new Map([[TOUR_URL, tourFile]]) })
    const upload = fakeUploadR2Object({ failForKey: new Set(['tours/DS_PUT/tour.json']) })
    const events = recorder()
    const { ctx } = makeCtx(client)
    const exit = await runMigrateR2Tours(ctx, {
      skipPace: true,
      r2Config: R2_CONFIG,
      fetchAsset,
      uploadR2Object: upload.fn,
      emitTelemetry: events.emit,
    })
    expect(exit).toBe(1)
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(events.events[0]).toMatchObject({ outcome: 'upload_failed' })
  })

  it('PATCH failure after uploads succeed → outcome=patch_failed', async () => {
    const row = makeRow({ id: 'DS_PATCH' })
    const { client, handles } = fakeClient({
      rows: [row],
      patchFailFor: new Set(['DS_PATCH']),
    })
    const tourFile = { tourTasks: [] }
    const fetchAsset = fakeFetchAsset({ tourJsons: new Map([[TOUR_URL, tourFile]]) })
    const upload = fakeUploadR2Object()
    const events = recorder()
    const { ctx } = makeCtx(client)
    const exit = await runMigrateR2Tours(ctx, {
      skipPace: true,
      r2Config: R2_CONFIG,
      fetchAsset,
      uploadR2Object: upload.fn,
      emitTelemetry: events.emit,
    })
    expect(exit).toBe(1)
    expect(upload.calls).toHaveLength(1) // tour.json uploaded
    expect(handles.updateDataset).toHaveBeenCalledTimes(1)
    expect(events.events[0]).toMatchObject({
      outcome: 'patch_failed',
      r2_key: 'tours/DS_PATCH/tour.json',
    })
  })
})

describe('runMigrateR2Tours — targeting and credentials', () => {
  it('--id targets a single row via the GET endpoint', async () => {
    const row = makeRow({ id: 'DS_SOLO' })
    const { client, handles } = fakeClient({ singleRow: row })
    const fetchAsset = fakeFetchAsset({
      tourJsons: new Map([[TOUR_URL, { tourTasks: [] }]]),
    })
    const upload = fakeUploadR2Object()
    const { ctx } = makeCtx(client, { id: 'DS_SOLO' })
    const exit = await runMigrateR2Tours(ctx, {
      skipPace: true,
      r2Config: R2_CONFIG,
      fetchAsset,
      uploadR2Object: upload.fn,
      emitTelemetry: recorder().emit,
    })
    expect(exit).toBe(0)
    expect(handles.get).toHaveBeenCalledWith('DS_SOLO')
    expect(handles.list).not.toHaveBeenCalled()
    expect(upload.calls.map(c => c.key)).toEqual(['tours/DS_SOLO/tour.json'])
  })

  it('--id 404 → exit 1, no work attempted', async () => {
    const { client, handles } = fakeClient({})
    const { ctx, err } = makeCtx(client, { id: 'DS_MISSING' })
    const exit = await runMigrateR2Tours(ctx, { skipPace: true })
    expect(exit).toBe(1)
    expect(handles.get).toHaveBeenCalledWith('DS_MISSING')
    expect(err.text()).toMatch(/Could not GET DS_MISSING/)
  })

  it('missing R2 credentials → exit 2 before any work', async () => {
    const row = makeRow({ id: 'DS_NOCREDS' })
    const { client, handles } = fakeClient({ rows: [row] })
    const fetchAsset = fakeFetchAsset({})
    const upload = fakeUploadR2Object()
    const { ctx, err } = makeCtx(client)
    const exit = await runMigrateR2Tours(ctx, {
      skipPace: true,
      r2Config: { endpoint: '', accessKeyId: '', secretAccessKey: '', bucket: '' },
      fetchAsset,
      uploadR2Object: upload.fn,
      emitTelemetry: recorder().emit,
    })
    expect(exit).toBe(2)
    expect(upload.calls).toEqual([])
    expect(handles.updateDataset).not.toHaveBeenCalled()
    expect(err.text()).toMatch(/R2_S3_ENDPOINT.+R2_ACCESS_KEY_ID.+R2_SECRET_ACCESS_KEY/)
  })
})

describe('runMigrateR2Tours — flag validation', () => {
  it('--limit < 1 → exit 2', async () => {
    const { client } = fakeClient({ rows: [makeRow()] })
    const { ctx, err } = makeCtx(client, { limit: '0' })
    const exit = await runMigrateR2Tours(ctx, { skipPace: true })
    expect(exit).toBe(2)
    expect(err.text()).toMatch(/--limit must be a positive integer/)
  })

  it('negative --pace-ms → exit 2', async () => {
    const { client } = fakeClient({ rows: [makeRow()] })
    const { ctx, err } = makeCtx(client, { 'pace-ms': '-1' })
    const exit = await runMigrateR2Tours(ctx, { skipPace: true })
    expect(exit).toBe(2)
    expect(err.text()).toMatch(/--pace-ms must be non-negative/)
  })
})
