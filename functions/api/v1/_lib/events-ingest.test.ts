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
