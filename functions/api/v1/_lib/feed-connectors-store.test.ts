/**
 * Unit tests for the feed-connector registry store, run against the
 * real migration SQL via the `asD1` / `seedFixtures` harness — which
 * also proves migration 0026 applies and seeds the default EONET row.
 */

import { describe, it, expect } from 'vitest'
import { asD1, seedFixtures } from './test-helpers'
import {
  listFeedConnectors,
  getFeedConnector,
  insertFeedConnector,
  updateFeedConnector,
  deleteFeedConnector,
  recordFeedRun,
  toPublicFeedConnector,
} from './feed-connectors-store'

const NOW = '2026-07-02T12:00:00.000Z'

function db() {
  return asD1(seedFixtures({ count: 0 }))
}

describe('feed-connectors-store', () => {
  it('the migration seeds the default EONET connector, enabled', async () => {
    const d = db()
    const rows = await listFeedConnectors(d)
    expect(rows.map(r => r.id)).toEqual(['FEED_EONET_DEFAULT'])
    expect(rows[0]).toMatchObject({ kind: 'eonet', label: 'NASA EONET', enabled: 1, category: 'hazards' })
    expect(rows[0].url).toContain('eonet.gsfc.nasa.gov')
  })

  it('insert → get round-trips and mints a ULID', async () => {
    const d = db()
    const row = await insertFeedConnector(
      d,
      { kind: 'rss', label: 'USGS Quakes', url: 'https://example.usgs.gov/feed', category: 'hazards' },
      NOW,
    )
    expect(row.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(row).toMatchObject({ kind: 'rss', label: 'USGS Quakes', enabled: 1, created_at: NOW })
    expect(await getFeedConnector(d, row.id)).toEqual(row)
  })

  it('enabledOnly filters out disabled rows', async () => {
    const d = db()
    const off = await insertFeedConnector(
      d,
      { kind: 'rss', label: 'Paused', url: 'https://example.org/f', enabled: false },
      NOW,
    )
    expect(off.enabled).toBe(0)
    const enabled = await listFeedConnectors(d, { enabledOnly: true })
    expect(enabled.map(r => r.id)).toEqual(['FEED_EONET_DEFAULT'])
    expect(await listFeedConnectors(d)).toHaveLength(2)
  })

  it('update patches only supplied fields and stamps updated_at', async () => {
    const d = db()
    const updated = await updateFeedConnector(d, 'FEED_EONET_DEFAULT', { enabled: false }, NOW)
    expect(updated).toMatchObject({ enabled: 0, updated_at: NOW, label: 'NASA EONET' })
    expect(await updateFeedConnector(d, 'NOPE', { enabled: true }, NOW)).toBeNull()
    // Empty patch is a no-op that returns the row unchanged.
    const noop = await updateFeedConnector(d, 'FEED_EONET_DEFAULT', {}, '2027-01-01T00:00:00.000Z')
    expect(noop?.updated_at).toBe(NOW)
  })

  it('delete removes the row and reports whether one existed', async () => {
    const d = db()
    expect(await deleteFeedConnector(d, 'FEED_EONET_DEFAULT')).toBe(true)
    expect(await deleteFeedConnector(d, 'FEED_EONET_DEFAULT')).toBe(false)
    expect(await listFeedConnectors(d)).toHaveLength(0)
  })

  it('recordFeedRun stamps the outcome; ok clears a prior error', async () => {
    const d = db()
    await recordFeedRun(d, 'FEED_EONET_DEFAULT', { status: 'error', error: 'feed responded 502' }, NOW)
    let row = await getFeedConnector(d, 'FEED_EONET_DEFAULT')
    expect(row).toMatchObject({ last_run_at: NOW, last_run_status: 'error', last_run_error: 'feed responded 502' })
    await recordFeedRun(d, 'FEED_EONET_DEFAULT', { status: 'ok' }, '2026-07-02T13:00:00.000Z')
    row = await getFeedConnector(d, 'FEED_EONET_DEFAULT')
    expect(row).toMatchObject({ last_run_status: 'ok', last_run_error: null })
  })

  it('toPublicFeedConnector maps to camelCase and booleans', async () => {
    const d = db()
    const row = (await getFeedConnector(d, 'FEED_EONET_DEFAULT'))!
    const pub = toPublicFeedConnector(row)
    expect(pub).toMatchObject({
      id: 'FEED_EONET_DEFAULT',
      kind: 'eonet',
      enabled: true,
      lastRunAt: null,
      lastRunStatus: null,
    })
  })
})
