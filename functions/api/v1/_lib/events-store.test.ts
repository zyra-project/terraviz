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
  updateCurrentEventContent,
  expireStaleProposedEvents,
  setEventStatus,
  getEventDecorations,
  upsertEventDatasetLink,
  insertProposedLinkIfAbsent,
  listLinksForEvent,
  listLinksForDataset,
  setLinkStatus,
  toPublicEvent,
  getFeaturedEvent,
  toPublicFeaturedEvent,
  listLinksForEvents,
  getDecorationsForEvents,
  listPublicEvents,
  listApprovedEventsForDataset,
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
  it('orders newest-first by event time and filters by status', async () => {
    const { db } = freshDb()
    await insertCurrentEvent(
      db,
      sampleEvent({ title: 'older', occurredStart: '2026-05-20T06:00:00.000Z' }),
      '2026-06-01T00:00:00.000Z',
    )
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

  it("orders by the event's own time, not insertion order", async () => {
    const { db } = freshDb()
    // A feed lists newest articles first, so within one refresh run the
    // newest event gets the EARLIEST insert timestamp. The queue must
    // still put it on top.
    await insertCurrentEvent(
      db,
      sampleEvent({ title: 'newest article', occurredStart: '2026-06-24T00:00:00.000Z' }),
      '2026-06-25T10:00:00.000Z',
    )
    await insertCurrentEvent(
      db,
      sampleEvent({ title: 'oldest article', occurredStart: '2026-06-10T00:00:00.000Z' }),
      '2026-06-25T10:00:01.000Z',
    )
    // No occurred time → falls back to the source publish date.
    await insertCurrentEvent(
      db,
      sampleEvent({
        title: 'middle (publish-date fallback)',
        occurredStart: null,
        occurredEnd: null,
        publishedAt: '2026-06-17T00:00:00.000Z',
      }),
      '2026-06-25T10:00:02.000Z',
    )
    const all = await listCurrentEvents(db)
    expect(all.map(e => e.title)).toEqual([
      'newest article',
      'middle (publish-date fallback)',
      'oldest article',
    ])
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

describe('insertProposedLinkIfAbsent', () => {
  it('inserts a fresh proposed link (returns true) and no-ops on conflict without clobbering the score', async () => {
    const { db } = freshDb()
    const { id: eventId } = await insertCurrentEvent(db, sampleEvent())
    const datasetId = seededDatasetId(0)

    // A matcher link already exists with a real score.
    await upsertEventDatasetLink(db, { eventId, datasetId, matchScore: 0.9 })
    // Adding the same dataset again does nothing (returns false) and keeps the score.
    expect(await insertProposedLinkIfAbsent(db, eventId, datasetId)).toBe(false)
    expect((await listLinksForEvent(db, eventId))[0].match_score).toBeCloseTo(0.9)

    // A brand-new dataset inserts as proposed with no score (returns true).
    const fresh = seededDatasetId(1)
    expect(await insertProposedLinkIfAbsent(db, eventId, fresh)).toBe(true)
    const link = (await listLinksForEvent(db, eventId)).find(l => l.dataset_id === fresh)!
    expect(link.status).toBe('proposed')
    expect(link.match_score).toBeNull()
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

  it('upsert preserves a curator decision while refreshing the score (re-ingest)', async () => {
    const { db } = freshDb()
    const { id: eventId } = await insertCurrentEvent(db, sampleEvent())
    const datasetId = seededDatasetId(0)

    await upsertEventDatasetLink(db, { eventId, datasetId, matchScore: 0.4 })
    await setLinkStatus(db, eventId, datasetId, 'approved', 'PUB1', '2026-06-11T00:00:00.000Z')

    // Matcher re-run on an ingest refresh: same status argument the
    // matcher passes ('proposed'), a new score.
    await upsertEventDatasetLink(db, { eventId, datasetId, matchScore: 0.95, status: 'proposed' })

    const [link] = await listLinksForEvent(db, eventId)
    expect(link.status).toBe('approved') // curator decision survived
    expect(link.approved_by).toBe('PUB1') // audit intact
    expect(link.match_score).toBeCloseTo(0.95) // score refreshed
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
      image_url: null,
      source_name: 'USGS',
      source_url: 'https://example.gov/x',
      published_at: null,
      feed_id: null,
      external_id: null,
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
      inferred_fields: null,
    })
    expect(pub.geometry).toEqual({})
    expect(pub.summary).toBeUndefined()
    expect(pub.feedId).toBeUndefined()
    expect(pub.source.publishedAt).toBeUndefined()
    expect(pub.reviewedAt).toBeUndefined()
  })
})

describe('bulk review-queue reads', () => {
  it('listLinksForEvents / getDecorationsForEvents group by event id', async () => {
    const { db } = freshDb()
    const a = await insertCurrentEvent(db, { ...sampleEvent(), title: 'A', keywords: ['hurricane'] })
    const b = await insertCurrentEvent(db, { ...sampleEvent(), title: 'B', categories: {}, keywords: [] })
    await upsertEventDatasetLink(db, { eventId: a.id, datasetId: seededDatasetId(0), matchScore: 0.9 })
    await upsertEventDatasetLink(db, { eventId: a.id, datasetId: seededDatasetId(1), matchScore: 0.5 })

    const links = await listLinksForEvents(db, [a.id, b.id])
    expect(links.get(a.id)!.map(l => l.dataset_id)).toEqual([seededDatasetId(0), seededDatasetId(1)]) // score order
    expect(links.get(b.id)).toEqual([]) // present, empty

    const dec = await getDecorationsForEvents(db, [a.id, b.id])
    expect(dec.get(a.id)!.keywords).toEqual(['hurricane'])
    expect(dec.get(a.id)!.categories).toEqual({ Theme: ['Hazards', 'Storms'], Region: ['Atlantic'] })
    expect(dec.get(b.id)).toEqual({ categories: {}, keywords: [] })
  })
})

describe('getFeaturedEvent', () => {
  const NOW = Date.parse('2026-06-26T00:00:00.000Z')

  /** Seed an approved event with one approved link to seeded dataset
   *  `i`, published `publishedAt`. Returns the event id. */
  async function seedFeatured(
    db: D1Database,
    opts: { datasetIndex?: number; publishedAt?: string; approveEvent?: boolean; approveLink?: boolean } = {},
  ): Promise<string> {
    const datasetId = seededDatasetId(opts.datasetIndex ?? 0)
    const { id } = await insertCurrentEvent(db, {
      ...sampleEvent(),
      publishedAt: opts.publishedAt ?? '2026-06-20T00:00:00.000Z',
    })
    await upsertEventDatasetLink(db, { eventId: id, datasetId, matchScore: 0.9 })
    if (opts.approveEvent ?? true) await setEventStatus(db, id, 'approved', 'PUB1')
    if (opts.approveLink ?? true) await setLinkStatus(db, id, datasetId, 'approved', 'PUB1')
    return id
  }

  it('returns the approved event with an approved, visible dataset link', async () => {
    const { db } = freshDb()
    const id = await seedFeatured(db)
    const row = await getFeaturedEvent(db, { now: NOW })
    expect(row?.id).toBe(id)
    expect(row?.dataset_id).toBe(seededDatasetId(0))
    expect(row?.dataset_title).toBe('Test Dataset 0')

    const pub = toPublicFeaturedEvent(row!)
    expect(pub.datasetId).toBe(seededDatasetId(0))
    expect(pub.source).toEqual({ name: 'NOAA', url: 'https://example.gov/storm', publishedAt: '2026-06-20T00:00:00.000Z' })
  })

  it('returns null when the event is only proposed', async () => {
    const { db } = freshDb()
    await seedFeatured(db, { approveEvent: false })
    expect(await getFeaturedEvent(db, { now: NOW })).toBeNull()
  })

  it('returns null when the link is only proposed', async () => {
    const { db } = freshDb()
    await seedFeatured(db, { approveLink: false })
    expect(await getFeaturedEvent(db, { now: NOW })).toBeNull()
  })

  it('excludes an event whose linked dataset is hidden', async () => {
    const { sqlite, db } = freshDb()
    await seedFeatured(db, { datasetIndex: 0 })
    sqlite.prepare('UPDATE datasets SET is_hidden = 1 WHERE id = ?').run(seededDatasetId(0))
    expect(await getFeaturedEvent(db, { now: NOW })).toBeNull()
  })

  it('excludes events older than the recency window', async () => {
    const { db } = freshDb()
    await seedFeatured(db, { publishedAt: '2026-05-01T00:00:00.000Z' }) // ~8 weeks before NOW
    expect(await getFeaturedEvent(db, { now: NOW })).toBeNull()
  })

  it('picks the freshest of two approved events', async () => {
    const { db } = freshDb()
    await seedFeatured(db, { datasetIndex: 0, publishedAt: '2026-06-18T00:00:00.000Z' })
    const newer = await seedFeatured(db, { datasetIndex: 1, publishedAt: '2026-06-24T00:00:00.000Z' })
    const row = await getFeaturedEvent(db, { now: NOW })
    expect(row?.id).toBe(newer)
    expect(row?.dataset_id).toBe(seededDatasetId(1))
  })
})

describe('listPublicEvents', () => {
  const NOW = Date.parse('2026-06-26T00:00:00.000Z')

  /** Seed an approved event linked to seeded dataset `i`. */
  async function seedApprovedEvent(
    db: D1Database,
    opts: {
      datasetIndex?: number
      publishedAt?: string
      approveEvent?: boolean
      approveLink?: boolean
      geometry?: NewCurrentEvent['geometry']
    } = {},
  ): Promise<string> {
    const datasetId = seededDatasetId(opts.datasetIndex ?? 0)
    const { id } = await insertCurrentEvent(db, {
      ...sampleEvent(),
      publishedAt: opts.publishedAt ?? '2026-06-20T00:00:00.000Z',
      geometry: opts.geometry,
    })
    await upsertEventDatasetLink(db, { eventId: id, datasetId, matchScore: 0.9 })
    if (opts.approveEvent ?? true) await setEventStatus(db, id, 'approved', 'PUB1')
    if (opts.approveLink ?? true) await setLinkStatus(db, id, datasetId, 'approved', 'PUB1')
    return id
  }

  it('returns approved events with their approved, visible dataset ids + geometry', async () => {
    const { db } = freshDb()
    const id = await seedApprovedEvent(db, { geometry: { point: { lat: 29, lon: -89 } } })
    const events = await listPublicEvents(db, { now: NOW })
    expect(events).toHaveLength(1)
    expect(events[0].id).toBe(id)
    expect(events[0].datasetIds).toEqual([seededDatasetId(0)])
    expect(events[0].geometry.point).toEqual({ lat: 29, lon: -89 })
    expect(events[0].source).toMatchObject({ name: 'NOAA', url: 'https://example.gov/storm' })
  })

  it('excludes proposed events and unapproved links', async () => {
    const { db } = freshDb()
    await seedApprovedEvent(db, { datasetIndex: 0, approveEvent: false }) // proposed event
    await seedApprovedEvent(db, { datasetIndex: 1, approveLink: false }) // approved event, proposed link
    expect(await listPublicEvents(db, { now: NOW })).toEqual([])
  })

  it('drops an event whose only approved link is to a hidden dataset', async () => {
    const { sqlite, db } = freshDb()
    await seedApprovedEvent(db, { datasetIndex: 0 })
    sqlite.prepare('UPDATE datasets SET is_hidden = 1 WHERE id = ?').run(seededDatasetId(0))
    expect(await listPublicEvents(db, { now: NOW })).toEqual([])
  })

  it('excludes events older than the recency window', async () => {
    const { db } = freshDb()
    await seedApprovedEvent(db, { publishedAt: '2026-05-01T00:00:00.000Z' })
    expect(await listPublicEvents(db, { now: NOW })).toEqual([])
  })

  it('orders freshest-first', async () => {
    const { db } = freshDb()
    const older = await seedApprovedEvent(db, { datasetIndex: 0, publishedAt: '2026-06-18T00:00:00.000Z' })
    const newer = await seedApprovedEvent(db, { datasetIndex: 1, publishedAt: '2026-06-24T00:00:00.000Z' })
    const events = await listPublicEvents(db, { now: NOW })
    expect(events.map(e => e.id)).toEqual([newer, older])
  })

  describe('listApprovedEventsForDataset', () => {
    async function seedApprovedEvent(
      db: D1Database,
      opts: { datasetIndex?: number; publishedAt?: string; approveEvent?: boolean; approveLink?: boolean } = {},
    ): Promise<string> {
      const datasetId = seededDatasetId(opts.datasetIndex ?? 0)
      const { id } = await insertCurrentEvent(db, { ...sampleEvent(), publishedAt: opts.publishedAt ?? '2026-06-20T00:00:00.000Z' })
      await upsertEventDatasetLink(db, { eventId: id, datasetId, matchScore: 0.9 })
      if (opts.approveEvent ?? true) await setEventStatus(db, id, 'approved', 'PUB1')
      if (opts.approveLink ?? true) await setLinkStatus(db, id, datasetId, 'approved', 'PUB1')
      return id
    }

    it('returns approved events linked to the dataset, newest first', async () => {
      const { db } = freshDb()
      const older = await seedApprovedEvent(db, { datasetIndex: 0, publishedAt: '2026-06-18T00:00:00.000Z' })
      const newer = await seedApprovedEvent(db, { datasetIndex: 0, publishedAt: '2026-06-24T00:00:00.000Z' })
      const events = await listApprovedEventsForDataset(db, seededDatasetId(0), { now: NOW })
      expect(events.map(e => e.id)).toEqual([newer, older])
      expect(events[0].datasetIds).toContain(seededDatasetId(0))
    })

    it('excludes a proposed event or an unapproved link', async () => {
      const { db } = freshDb()
      await seedApprovedEvent(db, { datasetIndex: 0, approveEvent: false })
      await seedApprovedEvent(db, { datasetIndex: 0, approveLink: false })
      expect(await listApprovedEventsForDataset(db, seededDatasetId(0), { now: NOW })).toEqual([])
    })

    it('does not return an event linked only to a different dataset', async () => {
      const { db } = freshDb()
      await seedApprovedEvent(db, { datasetIndex: 1 }) // linked to DS001
      expect(await listApprovedEventsForDataset(db, seededDatasetId(0), { now: NOW })).toEqual([])
    })

    it('returns nothing when the requested dataset is hidden (no info leak)', async () => {
      const { sqlite, db } = freshDb()
      await seedApprovedEvent(db, { datasetIndex: 0 })
      // The dataset the caller is asking about is hidden — a public probe
      // of its id must not surface its linked events.
      sqlite.prepare('UPDATE datasets SET is_hidden = 1 WHERE id = ?').run(seededDatasetId(0))
      expect(await listApprovedEventsForDataset(db, seededDatasetId(0), { now: NOW })).toEqual([])
    })
  })
})

describe('expireStaleProposedEvents', () => {
  it('expires only untouched proposed events past the cutoff', async () => {
    const { db } = freshDb()
    const stale = await insertCurrentEvent(db, sampleEvent({ title: 'stale' }), '2026-06-01T00:00:00.000Z')
    const fresh = await insertCurrentEvent(db, sampleEvent({ title: 'fresh' }), '2026-06-20T00:00:00.000Z')
    // A curator-approved event past the cutoff must never be aged.
    const approved = await insertCurrentEvent(db, sampleEvent({ title: 'approved' }), '2026-05-01T00:00:00.000Z')
    await setEventStatus(db, approved.id, 'approved', 'PUB1', '2026-05-02T00:00:00.000Z')

    const n = await expireStaleProposedEvents(db, '2026-06-15T00:00:00.000Z', '2026-06-29T00:00:00.000Z')
    expect(n).toBe(1)
    expect((await getCurrentEvent(db, stale.id))!.status).toBe('expired')
    expect((await getCurrentEvent(db, fresh.id))!.status).toBe('proposed')
    expect((await getCurrentEvent(db, approved.id))!.status).toBe('approved')
  })

  it('a re-ingested (still-carried) event survives the sweep', async () => {
    const { db } = freshDb()
    const ev = await insertCurrentEvent(
      db,
      sampleEvent({ title: 'ongoing', externalId: 'ext-1' }),
      '2026-06-01T00:00:00.000Z',
    )
    // The feed still carries it: a content refresh bumps updated_at.
    await updateCurrentEventContent(db, ev.id, sampleEvent({ externalId: 'ext-1' }), '2026-06-28T00:00:00.000Z')
    const n = await expireStaleProposedEvents(db, '2026-06-15T00:00:00.000Z', '2026-06-29T00:00:00.000Z')
    expect(n).toBe(0)
    expect((await getCurrentEvent(db, ev.id))!.status).toBe('proposed')
  })
})
