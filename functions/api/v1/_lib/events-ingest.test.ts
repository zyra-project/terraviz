/**
 * Unit tests for the current-events ingestion core
 * (`docs/CURRENT_EVENTS_PLAN.md` §9) — focused on the hand-picked
 * dataset pairings the new-event drawer sends as `datasetIds`. Runs the
 * real SQL against in-memory SQLite via the `asD1` / `seedFixtures`
 * harness so the link FK + visibility filter are exercised for real.
 */

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { asD1, seedFixtures } from './test-helpers'
import {
  parseCreate,
  sanitizeDatasetIds,
  ingestEvent,
  resolveOriginNode,
  MAX_MANUAL_DATASET_IDS,
} from './events-ingest'
import { listLinksForEvent, type NewCurrentEvent } from './events-store'

/** Deterministic dataset id minted by `seedFixtures` for index `i`. */
function seededDatasetId(i: number): string {
  return `DS${String(i).padStart(3, '0')}` + 'A'.repeat(21)
}

function freshDb(count = 3): { sqlite: Database.Database; db: D1Database } {
  const sqlite = seedFixtures({ count })
  return { sqlite, db: asD1(sqlite) }
}

function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Manual storm',
    source: { name: 'NOAA', url: 'https://example.gov/storm' },
    summary: 'Hand-authored event.',
    ...overrides,
  }
}

describe('sanitizeDatasetIds', () => {
  it('keeps non-empty strings, dedupes, and drops invalid entries', () => {
    expect(sanitizeDatasetIds(['a', 'a', 'b', '', 3, null, { x: 1 }])).toEqual(['a', 'b'])
  })

  it('returns [] for a non-array', () => {
    expect(sanitizeDatasetIds(undefined)).toEqual([])
    expect(sanitizeDatasetIds('a,b')).toEqual([])
  })

  it('caps at MAX_MANUAL_DATASET_IDS', () => {
    const many = Array.from({ length: MAX_MANUAL_DATASET_IDS + 10 }, (_, i) => `ds-${i}`)
    expect(sanitizeDatasetIds(many)).toHaveLength(MAX_MANUAL_DATASET_IDS)
  })

  it('trims entries and dedupes across whitespace differences', () => {
    expect(sanitizeDatasetIds(['  DS1  ', 'DS1', '   ', 'DS2'])).toEqual(['DS1', 'DS2'])
  })
})

describe('parseCreate — datasetIds', () => {
  it('surfaces hand-picked datasetIds on the parsed result', () => {
    const parsed = parseCreate(createBody({ datasetIds: ['x', 'x', 'y'] }))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.manualDatasetIds).toEqual(['x', 'y'])
  })

  it('defaults to [] when datasetIds is absent', () => {
    const parsed = parseCreate(createBody())
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.manualDatasetIds).toEqual([])
  })
})

describe('ingestEvent — manual pairings', () => {
  async function ingest(
    db: D1Database,
    manualDatasetIds: string[],
    overrides: Partial<NewCurrentEvent> = {},
  ): Promise<{ id: string; proposedLinks: number; manualLinks: number }> {
    const input: NewCurrentEvent = {
      originNode: await resolveOriginNode(db),
      title: 'Manual storm',
      summary: null,
      sourceName: 'NOAA',
      sourceUrl: 'https://example.gov/storm',
      publishedAt: null,
      feedId: null,
      externalId: null,
      occurredStart: null,
      occurredEnd: null,
      geometry: {},
      categories: undefined,
      keywords: undefined,
      ...overrides,
    }
    const { id, proposedLinks, manualLinks } = await ingestEvent(db, input, { manualDatasetIds })
    return { id, proposedLinks, manualLinks }
  }

  it('inserts hand-picked datasets as proposed links', async () => {
    const { db } = freshDb()
    const picked = [seededDatasetId(0), seededDatasetId(1)]
    const { id } = await ingest(db, picked)

    const links = await listLinksForEvent(db, id)
    const linkIds = links.map(l => l.dataset_id)
    for (const dsId of picked) {
      expect(linkIds).toContain(dsId)
      expect(links.find(l => l.dataset_id === dsId)!.status).toBe('proposed')
    }
  })

  it('drops unknown and hidden dataset ids (no dangling link / FK throw)', async () => {
    const { sqlite, db } = freshDb()
    // Hide DS001 so it fails the visibility filter.
    sqlite.prepare(`UPDATE datasets SET is_hidden = 1 WHERE id = ?`).run(seededDatasetId(1))

    const { id, manualLinks } = await ingest(db, [
      seededDatasetId(0), // visible → kept
      seededDatasetId(1), // hidden → dropped
      'DS999' + 'A'.repeat(21), // unknown → dropped
    ])

    const linkIds = (await listLinksForEvent(db, id)).map(l => l.dataset_id)
    expect(linkIds).toContain(seededDatasetId(0))
    expect(linkIds).not.toContain(seededDatasetId(1))
    expect(linkIds.some(x => x.startsWith('DS999'))).toBe(false)
    // manualLinks reflects what was actually inserted, not what was requested.
    expect(manualLinks).toBe(1)
  })

  it('counts a manual-only pairing toward proposedLinks', async () => {
    const { db } = freshDb()
    const { proposedLinks, id } = await ingest(db, [seededDatasetId(0)])
    // At least the one manual link is reflected in the count and stored.
    expect(proposedLinks).toBeGreaterThanOrEqual(1)
    expect((await listLinksForEvent(db, id)).length).toBeGreaterThanOrEqual(1)
  })
})

describe('ingestEvent — slice-C AI enrichment', () => {
  const AI_REPLY = JSON.stringify({ date: '2026-06-23', place: 'Caribbean', confidence: 0.9 })
  const aiEnv = (reply = AI_REPLY) => ({
    AI: { run: async () => ({ response: reply }) },
  })

  function plainNewsInput(overrides: Partial<NewCurrentEvent> = {}): NewCurrentEvent {
    return {
      originNode: 'local',
      title: 'Storm floods coastal towns',
      summary: 'Heavy rain on Tuesday flooded several towns, officials said.',
      sourceName: 'Example Desk',
      sourceUrl: 'https://news.example.org/floods',
      publishedAt: '2026-06-25T09:00:00.000Z',
      feedId: 'FEED_X',
      externalId: 'item-1',
      geometry: {},
      ...overrides,
    }
  }

  async function eventRow(db: D1Database, id: string) {
    return db
      .prepare(`SELECT occurred_start, region_name, bbox_n, inferred_fields FROM current_events WHERE id = ?`)
      .bind(id)
      .first<{ occurred_start: string | null; region_name: string | null; bbox_n: number | null; inferred_fields: string | null }>()
  }

  it('fills missing date + location on create and stamps provenance', async () => {
    const { db } = freshDb()
    const { id, created } = await ingestEvent(db, plainNewsInput(), { env: aiEnv() as never })
    expect(created).toBe(true)
    const row = await eventRow(db, id)
    expect(row!.occurred_start).toBe('2026-06-23T00:00:00.000Z')
    expect(row!.region_name).toBe('Caribbean Sea')
    expect(row!.bbox_n).not.toBeNull()
    expect(JSON.parse(row!.inferred_fields!)).toEqual(['occurredStart', 'geometry'])
  })

  it('skips gracefully when the AI binding is absent', async () => {
    const { db } = freshDb()
    const { id } = await ingestEvent(db, plainNewsInput(), {})
    const row = await eventRow(db, id)
    expect(row!.occurred_start).toBeNull()
    expect(row!.inferred_fields).toBeNull()
  })

  it('re-ingest keeps inferred values the feed still lacks, without a new model call', async () => {
    const { db } = freshDb()
    let calls = 0
    const env = { AI: { run: async () => { calls++; return { response: AI_REPLY } } } }
    const first = await ingestEvent(db, plainNewsInput(), { env: env as never })
    expect(calls).toBe(1)

    const second = await ingestEvent(db, plainNewsInput(), { env: env as never })
    expect(second.created).toBe(false)
    expect(second.id).toBe(first.id)
    expect(calls).toBe(1) // update path never re-enriches
    const row = await eventRow(db, second.id)
    expect(row!.occurred_start).toBe('2026-06-23T00:00:00.000Z')
    expect(row!.region_name).toBe('Caribbean Sea')
    expect(JSON.parse(row!.inferred_fields!)).toEqual(['occurredStart', 'geometry'])
  })

  it('a source-provided field on re-ingest wins and drops its inferred flag', async () => {
    const { db } = freshDb()
    const first = await ingestEvent(db, plainNewsInput(), { env: aiEnv() as never })
    // The feed starts carrying its own occurred time; geometry stays absent.
    await ingestEvent(db, plainNewsInput({ occurredStart: '2026-06-24T12:00:00.000Z' }), {
      env: aiEnv() as never,
    })
    const row = await eventRow(db, first.id)
    expect(row!.occurred_start).toBe('2026-06-24T12:00:00.000Z')
    expect(row!.region_name).toBe('Caribbean Sea') // still-inferred geometry kept
    expect(JSON.parse(row!.inferred_fields!)).toEqual(['geometry'])
  })

  it('honours a shared enrichment budget across a loop', async () => {
    const { db } = freshDb()
    let calls = 0
    const env = { AI: { run: async () => { calls++; return { response: AI_REPLY } } } }
    const enrichBudget = { remaining: 1 }
    await ingestEvent(db, plainNewsInput({ externalId: 'a' }), { env: env as never, enrichBudget })
    await ingestEvent(db, plainNewsInput({ externalId: 'b' }), { env: env as never, enrichBudget })
    expect(calls).toBe(1)
    expect(enrichBudget.remaining).toBe(0)
  })
})

describe('story media (task: story media)', () => {
  it('parseCreate keeps a valid imageUrl and silently drops garbage', () => {
    const good = parseCreate(createBody({ imageUrl: 'https://img.ex/story.jpg' }))
    expect(good.ok && good.value.imageUrl).toBe('https://img.ex/story.jpg')

    // Lenient drop — a bad image must not refuse the event.
    const bad = parseCreate(createBody({ imageUrl: 'javascript:alert(1)' }))
    expect(bad.ok && bad.value.imageUrl).toBeNull()
    const long = parseCreate(createBody({ imageUrl: `https://img.ex/${'x'.repeat(2100)}` }))
    expect(long.ok && long.value.imageUrl).toBeNull()
  })

  const input = (overrides: Partial<NewCurrentEvent> = {}): NewCurrentEvent => ({
    originNode: 'NODE000',
    title: 'Storm story',
    sourceName: 'NOAA',
    sourceUrl: 'https://example.gov/storm',
    feedId: 'FEED1',
    externalId: 'item-1',
    ...overrides,
  })

  it('og:image fallback fills a missing image; a feed-provided image wins without fetching', async () => {
    const { sqlite, db } = freshDb()
    const ogFetch = (async () =>
      ({
        ok: true,
        headers: { get: () => 'text/html' },
        body: null,
        text: async () => '<meta property="og:image" content="https://img.ex/og.jpg">',
      }) as unknown as Response) as unknown as typeof fetch

    const a = await ingestEvent(db, input(), { ogFetch })
    let row = sqlite.prepare('SELECT image_url FROM current_events WHERE id = ?').get(a.id) as { image_url: string }
    expect(row.image_url).toBe('https://img.ex/og.jpg')

    // Feed image present → no article fetch, feed value stored.
    let fetched = 0
    const counting = (async () => {
      fetched++
      throw new Error('should not be called')
    }) as unknown as typeof fetch
    const b = await ingestEvent(db, input({ externalId: 'item-2', imageUrl: 'https://img.ex/feed.jpg' }), {
      ogFetch: counting,
    })
    row = sqlite.prepare('SELECT image_url FROM current_events WHERE id = ?').get(b.id) as { image_url: string }
    expect(row.image_url).toBe('https://img.ex/feed.jpg')
    expect(fetched).toBe(0)
  })

  it('spends the shared enrich budget and skips when exhausted', async () => {
    const { sqlite, db } = freshDb()
    let fetched = 0
    const ogFetch = (async () => {
      fetched++
      return {
        ok: true,
        headers: { get: () => 'text/html' },
        body: null,
        text: async () => '<meta property="og:image" content="https://img.ex/og.jpg">',
      } as unknown as Response
    }) as unknown as typeof fetch

    const budget = { remaining: 1 }
    const a = await ingestEvent(db, input(), { ogFetch, enrichBudget: budget })
    const b = await ingestEvent(db, input({ externalId: 'item-2' }), { ogFetch, enrichBudget: budget })
    expect(fetched).toBe(1)
    const rowA = sqlite.prepare('SELECT image_url FROM current_events WHERE id = ?').get(a.id) as { image_url: string | null }
    const rowB = sqlite.prepare('SELECT image_url FROM current_events WHERE id = ?').get(b.id) as { image_url: string | null }
    expect(rowA.image_url).toBe('https://img.ex/og.jpg')
    expect(rowB.image_url).toBeNull()
  })

  it('a re-ingest without an image preserves the previously stored one', async () => {
    const { sqlite, db } = freshDb()
    const first = await ingestEvent(db, input({ imageUrl: 'https://img.ex/original.jpg' }), {})
    // Same dedupe key, no image this time (typical refresh).
    const second = await ingestEvent(db, input(), {})
    expect(second.id).toBe(first.id)
    expect(second.created).toBe(false)
    const row = sqlite.prepare('SELECT image_url FROM current_events WHERE id = ?').get(first.id) as { image_url: string }
    expect(row.image_url).toBe('https://img.ex/original.jpg')
  })
})
