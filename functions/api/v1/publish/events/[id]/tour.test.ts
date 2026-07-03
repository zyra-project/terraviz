/**
 * Wire-level tests for POST /api/v1/publish/events/:id/tour — the
 * generate-a-tour-draft action.
 *
 * Coverage: privileged gate (403), 404 unknown event, 400 when no
 * visible dataset pairings exist, the approved-links-beat-proposed
 * stop selection, the happy path (201, D1 tour row, R2 draft blob
 * whose tasks include the event's flyTo/setTime/captions), template
 * captions when Workers AI is unbound, and the `event.tour_generated`
 * audit row.
 */

import { describe, expect, it } from 'vitest'
import { onRequestPost as tourPost } from './tour'
import { asD1, makeKV, seedFixtures } from '../../../_lib/test-helpers'
import {
  insertCurrentEvent,
  upsertEventDatasetLink,
  setLinkStatus,
} from '../../../_lib/events-store'
import type { PublisherRow } from '../../../_lib/publisher-store'
import type { TourTaskDef } from '../../../../../../src/types'

const ADMIN: PublisherRow = {
  id: 'PUB-ADMIN',
  email: 'admin@example.com',
  display_name: 'Admin',
  affiliation: null,
  org_id: null,
  role: 'admin',
  is_admin: 1,
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
}
const PUBLISHER: PublisherRow = { ...ADMIN, id: 'PUB-PUB', email: 'p@e', role: 'publisher', is_admin: 0 }

const DS_0 = 'DS000' + 'A'.repeat(21)
const DS_1 = 'DS001' + 'A'.repeat(21)
const DS_2 = 'DS002' + 'A'.repeat(21)

interface BucketState {
  puts: Map<string, string>
}

function makeBucket(state: BucketState): R2Bucket {
  return {
    put: async (key: string, body: ReadableStream | string | ArrayBuffer | null) => {
      state.puts.set(key, typeof body === 'string' ? body : '')
      return {} as unknown as R2Object
    },
    get: async (key: string) => {
      const text = state.puts.get(key)
      if (text == null) return null
      return { text: async () => text } as unknown as R2ObjectBody
    },
  } as unknown as R2Bucket
}

function setupEnv() {
  const sqlite = seedFixtures({ count: 3 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ADMIN.id, ADMIN.email, ADMIN.display_name, ADMIN.role, ADMIN.is_admin, ADMIN.status, ADMIN.created_at)
  const bucket: BucketState = { puts: new Map() }
  return {
    sqlite,
    bucket,
    env: {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      CATALOG_R2: makeBucket(bucket),
    },
  }
}

function ctx(opts: { env: Record<string, unknown>; id: string; publisher?: PublisherRow }) {
  const url = `https://localhost/api/v1/publish/events/${opts.id}/tour`
  return {
    request: new Request(url, { method: 'POST' }),
    env: opts.env,
    params: { id: opts.id },
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<typeof tourPost>[0]
}

const SAMPLE = {
  originNode: 'NODE000',
  title: 'Hurricane Delta strengthens',
  summary: 'Delta reached category 3 overnight.',
  sourceName: 'NOAA',
  sourceUrl: 'https://example.gov/delta',
  occurredStart: '2026-06-25T12:00:00.000Z',
  geometry: { point: { lat: 25.5, lon: -80.2 } },
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('POST /api/v1/publish/events/:id/tour', () => {
  it('403 for a publisher-role account', async () => {
    const { env } = setupEnv()
    const id = (await insertCurrentEvent(env.CATALOG_DB, SAMPLE)).id
    const res = await tourPost(ctx({ env, id, publisher: PUBLISHER }))
    expect(res.status).toBe(403)
  })

  it('404 for an unknown event', async () => {
    const { env } = setupEnv()
    const res = await tourPost(ctx({ env, id: 'NOPE000000000000000000000A' }))
    expect(res.status).toBe(404)
  })

  it('400 no_datasets when the event has no visible pairings', async () => {
    const { env } = setupEnv()
    const id = (await insertCurrentEvent(env.CATALOG_DB, SAMPLE)).id
    const res = await tourPost(ctx({ env, id }))
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('no_datasets')
  })

  it('400 no_datasets when the only linked dataset is hidden', async () => {
    const { env, sqlite } = setupEnv()
    const id = (await insertCurrentEvent(env.CATALOG_DB, SAMPLE)).id
    await upsertEventDatasetLink(env.CATALOG_DB, { eventId: id, datasetId: DS_0, matchScore: 0.9 })
    sqlite.prepare('UPDATE datasets SET is_hidden = 1 WHERE id = ?').run(DS_0)
    const res = await tourPost(ctx({ env, id }))
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('no_datasets')
  })

  it('201: creates a draft tour whose tasks carry the event geometry, time, and captions', async () => {
    const { env, bucket, sqlite } = setupEnv()
    const id = (await insertCurrentEvent(env.CATALOG_DB, SAMPLE)).id
    await upsertEventDatasetLink(env.CATALOG_DB, { eventId: id, datasetId: DS_0, matchScore: 0.9 })
    await upsertEventDatasetLink(env.CATALOG_DB, { eventId: id, datasetId: DS_1, matchScore: 0.5 })

    const res = await tourPost(ctx({ env, id }))
    expect(res.status).toBe(201)
    const body = await readJson<{ tour: { id: string; slug: string; title: string } }>(res)
    expect(body.tour.title).toBe('Event: Hurricane Delta strengthens')

    // The D1 tour row exists and is an unpublished draft.
    const row = sqlite
      .prepare('SELECT id, published_at FROM tours WHERE id = ?')
      .get(body.tour.id) as { id: string; published_at: string | null }
    expect(row.published_at).toBeNull()

    // The R2 draft blob carries the generated task sequence.
    const blob = bucket.puts.get(`tours/${body.tour.id}/draft.json`)
    expect(blob).toBeTruthy()
    const file = JSON.parse(blob!) as { tourTasks: TourTaskDef[] }
    const keys = file.tourTasks.map(t => Object.keys(t)[0])
    expect(keys[0]).toBe('flyTo')
    expect(keys).toContain('setTime')
    const loads = file.tourTasks.filter(t => 'loadDataset' in t) as Array<{ loadDataset: { id: string } }>
    // Score order: DS_0 (0.9) before DS_1 (0.5).
    expect(loads.map(l => l.loadDataset.id)).toEqual([DS_0, DS_1])
    // No AI binding in this env → deterministic template captions.
    const intro = file.tourTasks.find(t => 'showRect' in t) as { showRect: { caption: string } }
    expect(intro.showRect.caption).toContain('Hurricane Delta strengthens')
    expect(intro.showRect.caption).toContain('NOAA')

    // Audit row written with the tour id + stops.
    const audit = sqlite
      .prepare(`SELECT metadata_json FROM audit_events WHERE action = 'event.tour_generated' AND subject_id = ?`)
      .get(id) as { metadata_json: string } | undefined
    expect(audit).toBeTruthy()
    const meta = JSON.parse(audit!.metadata_json) as { tour_id: string; stops: string[] }
    expect(meta.tour_id).toBe(body.tour.id)
    expect(meta.stops).toEqual([DS_0, DS_1])
  })

  it('falls through to lower-scored visible links when the top-scored dataset is hidden', async () => {
    // Regression: the visibility filter must run over the whole candidate
    // pool BEFORE the stop cap — a hidden top-scored link should yield
    // the next visible one, not a hole or a spurious no_datasets.
    const { env, bucket, sqlite } = setupEnv()
    const id = (await insertCurrentEvent(env.CATALOG_DB, SAMPLE)).id
    await upsertEventDatasetLink(env.CATALOG_DB, { eventId: id, datasetId: DS_0, matchScore: 0.99 })
    await upsertEventDatasetLink(env.CATALOG_DB, { eventId: id, datasetId: DS_1, matchScore: 0.3 })
    sqlite.prepare('UPDATE datasets SET is_hidden = 1 WHERE id = ?').run(DS_0)

    const res = await tourPost(ctx({ env, id }))
    expect(res.status).toBe(201)
    const body = await readJson<{ tour: { id: string } }>(res)
    const file = JSON.parse(bucket.puts.get(`tours/${body.tour.id}/draft.json`)!) as { tourTasks: TourTaskDef[] }
    const loads = file.tourTasks.filter(t => 'loadDataset' in t) as Array<{ loadDataset: { id: string } }>
    expect(loads.map(l => l.loadDataset.id)).toEqual([DS_1])
  })

  it('prefers approved links over proposed ones', async () => {
    const { env, bucket } = setupEnv()
    const id = (await insertCurrentEvent(env.CATALOG_DB, SAMPLE)).id
    await upsertEventDatasetLink(env.CATALOG_DB, { eventId: id, datasetId: DS_0, matchScore: 0.95 })
    await upsertEventDatasetLink(env.CATALOG_DB, { eventId: id, datasetId: DS_1, matchScore: 0.4 })
    await setLinkStatus(env.CATALOG_DB, id, DS_1, 'approved', ADMIN.id)

    const res = await tourPost(ctx({ env, id }))
    expect(res.status).toBe(201)
    const body = await readJson<{ tour: { id: string } }>(res)
    const file = JSON.parse(bucket.puts.get(`tours/${body.tour.id}/draft.json`)!) as { tourTasks: TourTaskDef[] }
    const loads = file.tourTasks.filter(t => 'loadDataset' in t) as Array<{ loadDataset: { id: string } }>
    // Only the approved DS_1 becomes a stop — the higher-scored but
    // merely proposed DS_0 is not the curator's vetted story.
    expect(loads.map(l => l.loadDataset.id)).toEqual([DS_1])
  })

  it('rejected links never become stops', async () => {
    const { env } = setupEnv()
    const id = (await insertCurrentEvent(env.CATALOG_DB, SAMPLE)).id
    await upsertEventDatasetLink(env.CATALOG_DB, { eventId: id, datasetId: DS_2, matchScore: 0.9 })
    await setLinkStatus(env.CATALOG_DB, id, DS_2, 'rejected', ADMIN.id)
    const res = await tourPost(ctx({ env, id }))
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('no_datasets')
  })
})
