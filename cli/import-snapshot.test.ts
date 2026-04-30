/**
 * Tests for `terraviz import-snapshot` (Commit 1d/B).
 *
 * The CLI subcommand is exercised end-to-end against:
 *   - a hand-rolled fake `TerravizClient` whose `list`,
 *     `createDataset`, and `publishDataset` methods record calls
 *     and serve fixed responses, so the test asserts on what the
 *     subcommand POSTs to the publisher API;
 *   - a hand-rolled `readFile` that returns inline JSON for the
 *     snapshot list + enriched metadata, so the tests don't touch
 *     disk or depend on the production snapshot's row count.
 *
 * Coverage:
 *   - --dry-run prints the plan and exits 0 without mutating;
 *   - the live import POSTs draft + publish for each ok row;
 *   - rows whose legacy_id is already in the catalog are skipped;
 *   - a 409 conflict on create is recorded and surfaced as exit 1.
 */

import { describe, expect, it, vi } from 'vitest'
import { runImportSnapshot } from './import-snapshot'
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

const SNAPSHOT_FIXTURE = {
  datasets: [
    {
      id: 'INTERNAL_SOS_768',
      organization: 'NOAA',
      title: 'Hurricane Season - 2024',
      abstractTxt: 'Atlantic hurricane track animation.',
      startTime: '2024-06-01T12:00:00',
      endTime: '2024-11-30T12:00:00',
      format: 'video/mp4',
      websiteLink: 'http://sos.noaa.gov/Datasets/sosx_dataset_info.html?id=768',
      dataLink: 'https://vimeo.com/1107911993',
      thumbnailLink: 'https://example.org/thumb.jpg',
      legendLink: 'https://example.org/legend.png',
      weight: 10,
      isHidden: false,
      tags: ['Air'],
    },
    {
      id: 'INTERNAL_SOS_770',
      organization: '',
      title: 'Argo Buoys (by country)',
      abstractTxt: '',
      format: 'image/png',
      dataLink: 'https://example.org/argo.png',
      thumbnailLink: 'https://example.org/argo-thumb.jpg',
      weight: 5,
      isHidden: false,
      tags: ['Water'],
    },
    {
      id: 'INTERNAL_SOS_BAD',
      title: 'KML Layer',
      format: 'application/vnd.google-earth.kml',
      dataLink: 'https://example.org/x.kml',
    },
  ],
}

const ENRICHED_FIXTURE = [
  {
    title: 'Hurricane Season - 2024',
    description: 'Long-form description from the enriched metadata.',
    keywords: ['hurricane', 'atlantic'],
    categories: { Air: ['Hurricanes'] },
  },
]

interface FakeClientHandles {
  list: ReturnType<typeof vi.fn>
  createDataset: ReturnType<typeof vi.fn>
  publishDataset: ReturnType<typeof vi.fn>
  reindexDataset: ReturnType<typeof vi.fn>
}

interface FakeClientOptions {
  /** Pre-seeded legacy_id → dataset_id pairs returned by `list`. */
  existing?: Array<{ id: string; legacy_id: string; published_at?: string | null }>
  /** Override `createDataset` to return a 409 conflict. */
  createConflictFor?: Set<string>
  /** Override `publishDataset` to fail with a 400 for these dataset ids. */
  publishFailFor?: Set<string>
  /** Override `reindexDataset` to fail with 503 for these dataset ids. */
  reindexFailFor?: Set<string>
}

function fakeClient(opts: FakeClientOptions = {}): { client: TerravizClient; handles: FakeClientHandles } {
  const existing = opts.existing ?? []
  let createCounter = 0

  const list = vi.fn(async (query: { status?: string } = {}) => {
    const filtered = existing.filter(e => {
      const publishedAt = e.published_at === undefined ? '2026-04-30T00:00:00.000Z' : e.published_at
      if (query.status === 'published') return publishedAt != null
      if (query.status === 'draft') return publishedAt == null
      return true
    })
    return {
      ok: true as const,
      status: 200,
      body: {
        datasets: filtered.map(e => ({
          id: e.id,
          legacy_id: e.legacy_id,
          published_at:
            e.published_at === undefined ? '2026-04-30T00:00:00.000Z' : e.published_at,
        })),
        next_cursor: null,
      },
    }
  })

  const createDataset = vi.fn(async (body: Record<string, unknown>) => {
    const legacy = body.legacy_id as string | undefined
    if (legacy && opts.createConflictFor?.has(legacy)) {
      return {
        ok: false as const,
        status: 409,
        error: 'http_error',
        message: 'legacy_id already imported',
        errors: [
          {
            field: 'legacy_id',
            code: 'conflict',
            message: `legacy_id "${legacy}" already imported.`,
          },
        ],
      }
    }
    const id = `DS${String(++createCounter).padStart(5, '0')}` + 'A'.repeat(21)
    return {
      ok: true as const,
      status: 201,
      body: {
        dataset: {
          id,
          slug: `slug-${createCounter}`,
          title: body.title as string,
          published_at: null,
        },
      },
    }
  })

  const publishDataset = vi.fn(async (id: string) => {
    if (opts.publishFailFor?.has(id)) {
      return {
        ok: false as const,
        status: 400,
        error: 'invalid_for_publish',
        message: 'dataset is not publishable',
      }
    }
    return {
      ok: true as const,
      status: 200,
      body: {
        dataset: { id, slug: 'x', title: 't', published_at: '2026-04-30T00:00:00.000Z' },
      },
    }
  })

  const reindexDataset = vi.fn(async (id: string) => {
    if (opts.reindexFailFor?.has(id)) {
      return {
        ok: false as const,
        status: 503,
        error: 'embed_unconfigured',
        message: 'bindings missing',
      }
    }
    return {
      ok: true as const,
      status: 200,
      body: {
        dataset: { id, slug: 'x', title: 't', published_at: '2026-04-30T00:00:00.000Z' },
      },
    }
  })

  const stub = {
    serverUrl: 'http://localhost:8788',
    list,
    createDataset,
    publishDataset,
    reindexDataset,
  }
  return {
    client: stub as unknown as TerravizClient,
    handles: { list, createDataset, publishDataset, reindexDataset },
  }
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
  const args = parseArgs(argv)
  const readFile = (path: string): string => {
    if (path.endsWith('sos-dataset-list.json')) return JSON.stringify(SNAPSHOT_FIXTURE)
    if (path.endsWith('sos_dataset_metadata.json')) return JSON.stringify(ENRICHED_FIXTURE)
    throw new Error(`unexpected read: ${path}`)
  }
  return { ctx: { client, args, stdout: out, stderr: err, readFile }, out, err }
}

describe('runImportSnapshot', () => {
  it('--dry-run prints the plan and never mutates', async () => {
    const { client, handles } = fakeClient()
    const { ctx, out, err } = makeCtx(client, { 'dry-run': true })
    const code = await runImportSnapshot(ctx)
    expect(code).toBe(0)
    expect(handles.list).toHaveBeenCalledTimes(1)
    expect(handles.createDataset).not.toHaveBeenCalled()
    expect(handles.publishDataset).not.toHaveBeenCalled()
    expect(out.text()).toContain('ok rows:               2')
    expect(out.text()).toContain('new rows to publish:   2')
    expect(out.text()).toContain('unsupported_format')
    expect(out.text()).toContain('Dry run')
    expect(err.text()).toBe('')
  })

  it('imports each ok row via createDataset + publishDataset', async () => {
    const { client, handles } = fakeClient()
    const { ctx, out, err } = makeCtx(client)
    const code = await runImportSnapshot(ctx)
    expect(code).toBe(0)
    expect(handles.createDataset).toHaveBeenCalledTimes(2)
    expect(handles.publishDataset).toHaveBeenCalledTimes(2)
    // First call carries the legacy_id derived from the SOS row.
    const firstBody = handles.createDataset.mock.calls[0][0] as Record<string, unknown>
    expect(firstBody.legacy_id).toBe('INTERNAL_SOS_768')
    expect(firstBody.title).toBe('Hurricane Season - 2024')
    expect(firstBody.format).toBe('video/mp4')
    expect(firstBody.data_ref).toBe('vimeo:1107911993')
    // The second is the image row.
    const secondBody = handles.createDataset.mock.calls[1][0] as Record<string, unknown>
    expect(secondBody.legacy_id).toBe('INTERNAL_SOS_770')
    expect(secondBody.format).toBe('image/png')
    expect(out.text()).toContain('imported:              2')
    expect(err.text()).toBe('')
  })

  it('skips rows whose legacy_id already exists in the catalog', async () => {
    const { client, handles } = fakeClient({
      existing: [{ id: 'DS-EXISTING', legacy_id: 'INTERNAL_SOS_768' }],
    })
    const { ctx, out } = makeCtx(client)
    const code = await runImportSnapshot(ctx)
    expect(code).toBe(0)
    expect(handles.createDataset).toHaveBeenCalledTimes(1)
    const body = handles.createDataset.mock.calls[0][0] as Record<string, unknown>
    expect(body.legacy_id).toBe('INTERNAL_SOS_770')
    expect(out.text()).toContain('already imported:      1')
    expect(out.text()).toContain('imported:              1')
  })

  it('builds the idempotency index from published rows only (1d/L)', async () => {
    // The list call that builds the legacy_id index passes
    // ?status=published so a stuck draft from a prior failed run
    // gets re-attempted (and surfaces the unique-constraint 409 from
    // createDataset) rather than being silently skipped as
    // "already imported".
    const { client, handles } = fakeClient({
      existing: [
        // Stuck draft — same legacy_id as the snapshot's first row,
        // published_at: null. Pre-1d/L this would be indexed and the
        // row silently skipped on re-run; post-1d/L the importer
        // tries again and the create-fail surfaces it.
        { id: 'DS-STUCK', legacy_id: 'INTERNAL_SOS_768', published_at: null },
      ],
      createConflictFor: new Set(['INTERNAL_SOS_768']),
    })
    const { ctx, out, err } = makeCtx(client)
    const code = await runImportSnapshot(ctx)
    expect(handles.list.mock.calls[0][0]).toMatchObject({ status: 'published' })
    // Both snapshot ok-rows are attempted (the draft isn't counted
    // as already-imported); INTERNAL_SOS_768 hits the 409.
    expect(handles.createDataset).toHaveBeenCalledTimes(2)
    expect(code).toBe(1)
    expect(err.text()).toContain('[INTERNAL_SOS_768] create failed (409)')
    expect(out.text()).toContain('already imported:      0')
    expect(out.text()).toContain('failed (create):       1')
  })

  it('returns exit code 1 when a create fails with 409 and surfaces the error', async () => {
    const { client, handles } = fakeClient({
      createConflictFor: new Set(['INTERNAL_SOS_770']),
    })
    const { ctx, out, err } = makeCtx(client)
    const code = await runImportSnapshot(ctx)
    expect(code).toBe(1)
    expect(handles.createDataset).toHaveBeenCalledTimes(2)
    expect(handles.publishDataset).toHaveBeenCalledTimes(1)
    expect(err.text()).toContain('[INTERNAL_SOS_770] create failed (409)')
    expect(err.text()).toContain('legacy_id: conflict')
    expect(out.text()).toContain('imported:              1')
    expect(out.text()).toContain('failed (create):       1')
  })

  it('returns exit code 1 when publish fails after create succeeds', async () => {
    const { client, handles } = fakeClient({
      publishFailFor: new Set(['DS00001' + 'A'.repeat(21)]),
    })
    const { ctx, out, err } = makeCtx(client)
    const code = await runImportSnapshot(ctx)
    expect(code).toBe(1)
    expect(handles.createDataset).toHaveBeenCalledTimes(2)
    expect(err.text()).toContain('publish failed (400)')
    expect(out.text()).toContain('failed (publish):      1')
    expect(out.text()).toContain('imported:              1')
  })

  it('exits 1 when the list endpoint refuses (cannot build idempotency index)', async () => {
    const list = vi.fn(async () => ({
      ok: false as const,
      status: 401,
      error: 'unauthorized',
      message: 'no Access token',
    }))
    const stub = {
      serverUrl: 'x',
      list,
      createDataset: vi.fn(),
      publishDataset: vi.fn(),
      reindexDataset: vi.fn(),
    }
    const { ctx, err } = makeCtx(stub as unknown as TerravizClient)
    const code = await runImportSnapshot(ctx)
    expect(code).toBe(1)
    expect(err.text()).toContain('Could not list existing datasets')
    expect(err.text()).toContain('401')
  })
})

describe('runImportSnapshot --reindex', () => {
  it('reindexes every published dataset returned by the list endpoint', async () => {
    const { client, handles } = fakeClient({
      existing: [
        { id: 'DS-1', legacy_id: 'INTERNAL_SOS_1' },
        { id: 'DS-2', legacy_id: 'INTERNAL_SOS_2' },
        { id: 'DS-3', legacy_id: 'INTERNAL_SOS_3' },
      ],
    })
    const { ctx, out, err } = makeCtx(client, { reindex: true })
    const code = await runImportSnapshot(ctx)
    expect(code).toBe(0)
    expect(handles.list).toHaveBeenCalledTimes(1)
    expect(handles.createDataset).not.toHaveBeenCalled()
    expect(handles.publishDataset).not.toHaveBeenCalled()
    expect(handles.reindexDataset).toHaveBeenCalledTimes(3)
    expect(handles.reindexDataset.mock.calls.map(c => c[0])).toEqual(['DS-1', 'DS-2', 'DS-3'])
    expect(out.text()).toContain('published rows to re-embed: 3')
    expect(out.text()).toContain('reindexed:             3')
    expect(err.text()).toBe('')
  })

  it('--reindex --dry-run prints the count and never reindexes', async () => {
    const { client, handles } = fakeClient({
      existing: [{ id: 'DS-1', legacy_id: 'INTERNAL_SOS_1' }],
    })
    const { ctx, out } = makeCtx(client, { reindex: true, 'dry-run': true })
    const code = await runImportSnapshot(ctx)
    expect(code).toBe(0)
    expect(handles.reindexDataset).not.toHaveBeenCalled()
    expect(out.text()).toContain('Dry run')
    expect(out.text()).toContain('published rows to re-embed: 1')
  })

  it('--reindex returns exit 1 when a row fails to reindex', async () => {
    const { client, handles } = fakeClient({
      existing: [
        { id: 'DS-A', legacy_id: 'INTERNAL_SOS_A' },
        { id: 'DS-B', legacy_id: 'INTERNAL_SOS_B' },
      ],
      reindexFailFor: new Set(['DS-B']),
    })
    const { ctx, out, err } = makeCtx(client, { reindex: true })
    const code = await runImportSnapshot(ctx)
    expect(code).toBe(1)
    expect(handles.reindexDataset).toHaveBeenCalledTimes(2)
    expect(err.text()).toContain('[DS-B] reindex failed (503)')
    expect(out.text()).toContain('reindexed:             1')
    expect(out.text()).toContain('failed:                1')
  })
})
