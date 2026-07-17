/**
 * Unit tests for the video-source registry store, run against the real
 * migration SQL via the `asD1` / `seedFixtures` harness (which also
 * proves migration 0040 applies).
 */

import { describe, it, expect } from 'vitest'
import { asD1, seedFixtures } from './test-helpers'
import {
  listVideoSources,
  getVideoSource,
  getVideoSourceByUrl,
  insertVideoSource,
  updateVideoSource,
  deleteVideoSource,
  recordVideoSourceRun,
  toPublicVideoSource,
} from './video-sources-store'

const NOW = '2026-07-17T12:00:00.000Z'

function db() {
  return asD1(seedFixtures({ count: 0 }))
}

const OCEAN_TODAY = {
  label: 'NOAA Ocean Today',
  url: 'https://oceantoday.noaa.gov/videositemap.xml',
  attribution: 'NOAA Ocean Today',
}

describe('video-sources-store', () => {
  it('starts empty (no seeded default)', async () => {
    expect(await listVideoSources(db())).toEqual([])
  })

  it('insert → get round-trips and mints a ULID, defaulting kind', async () => {
    const d = db()
    const row = await insertVideoSource(d, OCEAN_TODAY, NOW)
    expect(row.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(row).toMatchObject({
      kind: 'video-sitemap',
      label: 'NOAA Ocean Today',
      url: OCEAN_TODAY.url,
      attribution: 'NOAA Ocean Today',
      enabled: 1,
      created_at: NOW,
    })
    expect(await getVideoSource(d, row.id)).toEqual(row)
  })

  it('enabledOnly filters out paused sources', async () => {
    const d = db()
    await insertVideoSource(d, OCEAN_TODAY, NOW)
    const off = await insertVideoSource(d, { label: 'Paused', url: 'https://x.example/s.xml', enabled: false }, NOW)
    const enabled = await listVideoSources(d, { enabledOnly: true })
    expect(enabled.map(r => r.id)).not.toContain(off.id)
    expect(enabled).toHaveLength(1)
  })

  it('getVideoSourceByUrl finds a duplicate registration', async () => {
    const d = db()
    const row = await insertVideoSource(d, OCEAN_TODAY, NOW)
    expect((await getVideoSourceByUrl(d, OCEAN_TODAY.url))?.id).toBe(row.id)
    expect(await getVideoSourceByUrl(d, 'https://nope.example/s.xml')).toBeNull()
  })

  it('update patches only supplied fields and stamps updated_at', async () => {
    const d = db()
    const row = await insertVideoSource(d, OCEAN_TODAY, NOW)
    const later = '2026-07-18T09:00:00.000Z'
    const patched = await updateVideoSource(d, row.id, { enabled: false }, later)
    expect(patched).toMatchObject({ enabled: 0, label: 'NOAA Ocean Today', updated_at: later })
    expect(await updateVideoSource(d, 'nope', { enabled: false })).toBeNull()
  })

  it('recordVideoSourceRun stores ok count and clears prior error', async () => {
    const d = db()
    const row = await insertVideoSource(d, OCEAN_TODAY, NOW)
    await recordVideoSourceRun(d, row.id, { status: 'error', error: 'timeout' }, NOW)
    let got = await getVideoSource(d, row.id)
    expect(got).toMatchObject({ last_run_status: 'error', last_run_error: 'timeout', last_run_count: null })
    await recordVideoSourceRun(d, row.id, { status: 'ok', count: 283 }, NOW)
    got = await getVideoSource(d, row.id)
    expect(got).toMatchObject({ last_run_status: 'ok', last_run_error: null, last_run_count: 283 })
  })

  it('delete removes the row', async () => {
    const d = db()
    const row = await insertVideoSource(d, OCEAN_TODAY, NOW)
    expect(await deleteVideoSource(d, row.id)).toBe(true)
    expect(await getVideoSource(d, row.id)).toBeNull()
    expect(await deleteVideoSource(d, row.id)).toBe(false)
  })

  it('toPublicVideoSource maps the row to the wire shape', async () => {
    const d = db()
    const row = await insertVideoSource(d, OCEAN_TODAY, NOW)
    expect(toPublicVideoSource(row)).toMatchObject({
      id: row.id,
      kind: 'video-sitemap',
      enabled: true,
      lastRunStatus: null,
      lastRunCount: null,
    })
  })
})
