/**
 * Unit tests for the current-events store (data layer of
 * `docs/CURRENT_EVENTS_PLAN.md`). Exercises the real SQL from
 * `migrations/catalog/0024_current_events.sql` against an in-memory
 * SQLite via the `asD1` façade — including `ON DELETE CASCADE`, which
 * the `seedFixtures` harness enables with `PRAGMA foreign_keys = ON`.
 */

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { asD1, seedFixtures } from './test-helpers'
import {
  insertCurrentEvent,
  getCurrentEvent,
  listCurrentEvents,
  setEventStatus,
  getEventDecorations,
  upsertEventDatasetLink,
  listLinksForEvent,
  listLinksForDataset,
  setLinkStatus,
  toPublicEvent,
  type NewCurrentEvent,
} from './events-store'

/** Deterministic dataset id minted by `seedFixtures` for index `i`. */
function seededDatasetId(i: number): string {
  return `DS${String(i).padStart(3, '0')}` + 'A'.repeat(21)
}

function sampleEvent(overrides: Partial<NewCurrentEvent> = {}): NewCurrentEvent {
  return {
    originNode: 'NODE000',
    title: 'Major storm makes landfall',
    summary: 'A category 4 storm reached the coast overnight.',
    sourceName: 'NOAA',
    sourceUrl: 'https://example.gov/storm',
    publishedAt: '2026-06-01T12:00:00.000Z',
    feedId: 'demo-feed',
    occurredStart: '2026-06-01T06:00:00.000Z',
    occurredEnd: '2026-06-02T06:00:00.000Z',
    geometry: {
      boundingBox: { n: 31, s: 25, w: -92, e: -84 },
      point: { lat: 29.0, lon: -89.0 },
      regionName: 'Gulf of Mexico',
    },
    categories: { Theme: ['Storms', 'Hazards'], Region: ['Atlantic'] },
    keywords: ['hurricane', 'landfall'],
    ...overrides,
  }
}

function freshDb(): { sqlite: Database.Database; db: D1Database } {
  const sqlite = seedFixtures({ count: 2 })
  // The review-audit columns (`reviewed_by` / `approved_by`) FK to
  // publishers(id); seed the curator the tests act as.
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('PUB1', 'curator@test.local', 'Test Curator', 'staff', 1, 'active', '2026-01-01T00:00:00.000Z')
  return { sqlite, db: asD1(sqlite) }
}

describe('insertCurrentEvent + getCurrentEvent', () => {
  it('round-trips a row, minting a ULID and defaulting status to proposed', async () => {
    const { db } = freshDb()
    const inserted = await insertCurrentEvent(db, sampleEvent(), '2026-06-03T00:00:00.000Z')

    expect(inserted.id).toMatch(/^[0-9A-Z]{26}$/)
    expect(inserted.status).toBe('proposed')
    expect(inserted.created_at).toBe('2026-06-03T00:00:00.000Z')
    expect(inserted.updated_at).toBe('2026-06-03T00:00:00.000Z')
    expect(inserted.reviewed_at).toBeNull()

    const row = await getCurrentEvent(db, inserted.id)
    expect(row).not.toBeNull()
    expect(row!.title).toBe('Major storm makes landfall')
    expect(row!.source_name).toBe('NOAA')
    expect(row!.feed_id).toBe('demo-feed')
    expect(row!.bbox_n).toBe(31)
    expect(row!.point_lat).toBe(29.0)
    expect(row!.region_name).toBe('Gulf of Mexico')
  })

  it('returns null for an unknown id', async () => {
    const { db } = freshDb()
    expect(await getCurrentEvent(db, 'NOPE000000000000000000000A')).toBeNull()
  })

  it('persists category + keyword decorations', async () => {
    const { db } = freshDb()
    const { id } = await insertCurrentEvent(db, sampleEvent())
    const dec = await getEventDecorations(db, id)
    expect(dec.categories).toEqual({ Theme: ['Hazards', 'Storms'], Region: ['Atlantic'] })
    expect(dec.keywords).toEqual(['hurricane', 'landfall'])
  })

  it('stores nullable provenance/geometry when omitted', async () => {
    const { db } = freshDb()
    const { id } = await insertCurrentEvent(
      db,
      sampleEvent({
        summary: null,
        publishedAt: null,
        feedId: null,
        occurredEnd: null,
        geometry: { regionName: 'Arctic' },
        categories: {},
        keywords: [],
      }),
    )
    const row = await getCurrentEvent(db, id)
    expect(row!.summary).toBeNull()
    expect(row!.published_at).toBeNull()
    expect(row!.feed_id).toBeNull()
    expect(row!.bbox_n).toBeNull()
    expect(row!.point_lat).toBeNull()
    expect(row!.region_name).toBe('Arctic')
  })
})

describe('listCurrentEvents', () => {
  it('orders newest-first and filters by status', async () => {
    const { db } = freshDb()
    await insertCurrentEvent(db, sampleEvent({ title: 'older' }), '2026-06-01T00:00:00.000Z')
    const approved = await insertCurrentEvent(
      db,
      sampleEvent({ title: 'newer' }),
      '2026-06-05T00:00:00.000Z',
    )
    await setEventStatus(db, approved.id, 'approved', 'PUB1')

    const all = await listCurrentEvents(db)
    expect(all.map(e => e.title)).toEqual(['newer', 'older'])

    const onlyApproved = await listCurrentEvents(db, { status: 'approved' })
    expect(onlyApproved.map(e => e.title)).toEqual(['newer'])

    const onlyProposed = await listCurrentEvents(db, { status: 'proposed' })
    expect(onlyProposed.map(e => e.title)).toEqual(['older'])
  })

  it('honours the limit (clamped)', async () => {
    const { db } = freshDb()
    for (let i = 0; i < 3; i++) {
      await insertCurrentEvent(
        db,
        sampleEvent({ title: `e${i}` }),
        `2026-06-0${i + 1}T00:00:00.000Z`,
      )
    }
    expect(await listCurrentEvents(db, { limit: 2 })).toHaveLength(2)
  })
})

describe('setEventStatus', () => {
  it('transitions status and stamps the review audit', async () => {
    const { db } = freshDb()
    const { id } = await insertCurrentEvent(db, sampleEvent())
    await setEventStatus(db, id, 'approved', 'PUB1', '2026-06-10T00:00:00.000Z')

    const row = await getCurrentEvent(db, id)
    expect(row!.status).toBe('approved')
    expect(row!.reviewed_at).toBe('2026-06-10T00:00:00.000Z')
    expect(row!.reviewed_by).toBe('PUB1')
    expect(row!.updated_at).toBe('2026-06-10T00:00:00.000Z')
  })
})

describe('event_dataset_links', () => {
  it('upserts a link and reads it back from both directions', async () => {
    const { db } = freshDb()
    const { id: eventId } = await insertCurrentEvent(db, sampleEvent())
    const datasetId = seededDatasetId(0)

    await upsertEventDatasetLink(db, {
      eventId,
      datasetId,
      matchScore: 0.82,
      signals: { geo: 0.9, temporal: 0.7, semantic: null },
    })

    const forEvent = await listLinksForEvent(db, eventId)
    expect(forEvent).toHaveLength(1)
    expect(forEvent[0].dataset_id).toBe(datasetId)
    expect(forEvent[0].match_score).toBeCloseTo(0.82)
    expect(JSON.parse(forEvent[0].signals_json!)).toEqual({ geo: 0.9, temporal: 0.7, semantic: null })

    const forDataset = await listLinksForDataset(db, datasetId)
    expect(forDataset).toHaveLength(1)
    expect(forDataset[0].event_id).toBe(eventId)
  })

  it('upsert is last-write-wins on (event_id, dataset_id)', async () => {
    const { db } = freshDb()
    const { id: eventId } = await insertCurrentEvent(db, sampleEvent())
    const datasetId = seededDatasetId(0)

    await upsertEventDatasetLink(db, { eventId, datasetId, matchScore: 0.4 })
    await upsertEventDatasetLink(db, { eventId, datasetId, matchScore: 0.95 })

    const links = await listLinksForEvent(db, eventId)
    expect(links).toHaveLength(1)
    expect(links[0].match_score).toBeCloseTo(0.95)
  })

  it('filters the reverse lookup by status (the "In the news" read path)', async () => {
    const { db } = freshDb()
    const { id: eventId } = await insertCurrentEvent(db, sampleEvent())
    const datasetId = seededDatasetId(1)
    await upsertEventDatasetLink(db, { eventId, datasetId, matchScore: 0.6 })

    expect(await listLinksForDataset(db, datasetId, { status: 'approved' })).toHaveLength(0)
    await setLinkStatus(db, eventId, datasetId, 'approved', 'PUB1', '2026-06-11T00:00:00.000Z')

    const approved = await listLinksForDataset(db, datasetId, { status: 'approved' })
    expect(approved).toHaveLength(1)
    expect(approved[0].approved_at).toBe('2026-06-11T00:00:00.000Z')
    expect(approved[0].approved_by).toBe('PUB1')
  })

  it('setLinkStatus clears the approval audit when not approved', async () => {
    const { db } = freshDb()
    const { id: eventId } = await insertCurrentEvent(db, sampleEvent())
    const datasetId = seededDatasetId(0)
    await upsertEventDatasetLink(db, { eventId, datasetId })

    await setLinkStatus(db, eventId, datasetId, 'approved', 'PUB1')
    await setLinkStatus(db, eventId, datasetId, 'rejected', 'PUB1')

    const links = await listLinksForEvent(db, eventId)
    expect(links[0].status).toBe('rejected')
    expect(links[0].approved_at).toBeNull()
    expect(links[0].approved_by).toBeNull()
  })
})

describe('ON DELETE CASCADE', () => {
  it('deleting an event clears its links and decorations', async () => {
    const { sqlite, db } = freshDb()
    const { id: eventId } = await insertCurrentEvent(db, sampleEvent())
    await upsertEventDatasetLink(db, { eventId, datasetId: seededDatasetId(0) })

    sqlite.prepare('DELETE FROM current_events WHERE id = ?').run(eventId)

    expect(await listLinksForEvent(db, eventId)).toHaveLength(0)
    const dec = await getEventDecorations(db, eventId)
    expect(dec.keywords).toEqual([])
    expect(dec.categories).toEqual({})
  })

  it('deleting a dataset clears the links that pointed at it', async () => {
    const { sqlite, db } = freshDb()
    const { id: eventId } = await insertCurrentEvent(db, sampleEvent())
    const datasetId = seededDatasetId(0)
    await upsertEventDatasetLink(db, { eventId, datasetId })

    sqlite.prepare('DELETE FROM datasets WHERE id = ?').run(datasetId)

    expect(await listLinksForDataset(db, datasetId)).toHaveLength(0)
  })
})

describe('toPublicEvent', () => {
  it('shapes a row + decorations into the public payload', async () => {
    const { db } = freshDb()
    const { id } = await insertCurrentEvent(db, sampleEvent())
    const row = await getCurrentEvent(db, id)
    const dec = await getEventDecorations(db, id)
    const pub = toPublicEvent(row!, dec)

    expect(pub.id).toBe(id)
    expect(pub.source).toEqual({
      name: 'NOAA',
      url: 'https://example.gov/storm',
      publishedAt: '2026-06-01T12:00:00.000Z',
    })
    expect(pub.geometry.boundingBox).toEqual({ n: 31, s: 25, w: -92, e: -84 })
    expect(pub.geometry.point).toEqual({ lat: 29.0, lon: -89.0 })
    expect(pub.geometry.regionName).toBe('Gulf of Mexico')
    expect(pub.keywords).toEqual(['hurricane', 'landfall'])
    expect(pub.status).toBe('proposed')
  })

  it('omits absent optionals and partial geometry', () => {
    const pub = toPublicEvent({
      id: 'E0000000000000000000000000',
      origin_node: 'NODE000',
      title: 'Quiet day',
      summary: null,
      source_name: 'USGS',
      source_url: 'https://example.gov/x',
      published_at: null,
      feed_id: null,
      occurred_start: null,
      occurred_end: null,
      bbox_n: null,
      bbox_s: null,
      bbox_w: null,
      bbox_e: null,
      point_lat: null,
      point_lon: null,
      region_name: null,
      status: 'proposed',
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
      reviewed_at: null,
      reviewed_by: null,
    })
    expect(pub.geometry).toEqual({})
    expect(pub.summary).toBeUndefined()
    expect(pub.feedId).toBeUndefined()
    expect(pub.source.publishedAt).toBeUndefined()
    expect(pub.reviewedAt).toBeUndefined()
  })
})
