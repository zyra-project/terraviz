// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetFormatterCacheForTests } from '../i18n/format'
import {
  dateDetail,
  earthWhen,
  fetchKioskDataset,
  imageAddress,
  KioskDataError,
  kioskDate,
  kioskDatasetFrom,
  kioskWhen,
  plainParagraphs,
  type KioskDataset,
} from './kioskModel'
import type { WebClock } from './webMode'

const BASE = 'https://node.example/'

// The node's real card and record are checked against this reader in
// scripts/second-life-exhibit/exhibit.test.ts, built by the producers.
const CARD = {
  id: 'DS1',
  page: '/dataset/ds1',
  kind: 'video',
  showable: true,
  title: 'Card title',
  startTime: '2024-01-01T00:00:00Z',
  endTime: '2024-01-11T00:00:00Z',
  period: 'P1D',
  exactDuration: 100,
  retry: 0,
  credit: 'NOAA',
  license: 'CC-BY-4.0',
  licenseText: 'Use freely https://example.org/l',
  abstract: 'cut to 500',
  truncated: true,
}

const RECORD = {
  id: 'DS1',
  title: 'Record title',
  abstractTxt: 'The whole abstract, however long.',
  thumbnailLink: '/assets/thumb.jpg',
  legendLink: 'https://cdn.example/legend.png',
  frames: { count: 11 },
}

const dataset = (over: Partial<KioskDataset> = {}): KioskDataset => ({
  ...kioskDatasetFrom(CARD, RECORD, BASE),
  ...over,
})

const clock = (over: Partial<WebClock> = {}): WebClock => ({ positionS: 0, atUnixS: null, rate: 1, paused: false, ...over })

/** `a – b` as Intl writes a range, whatever spaces it puts round the dash. */
const range = (a: string, b: string) => new RegExp(`^${a}\\s?–\\s?${b}$`)

describe('kioskDatasetFrom', () => {
  it('takes the text and images from the record, and the credit, licence, times and length from the card', () => {
    const ds = kioskDatasetFrom(CARD, RECORD, BASE)
    expect(ds).toMatchObject({
      id: 'DS1',
      title: 'Record title',
      abstract: ['The whole abstract, however long.'],
      thumbnail: 'https://node.example/assets/thumb.jpg',
      legend: { kind: 'image', url: 'https://cdn.example/legend.png' },
      credit: 'NOAA',
      license: 'CC-BY-4.0',
      licenseText: 'Use freely https://example.org/l',
      kind: 'video',
      period: 'P1D',
      frameCount: 11,
      lengthS: 100,
      retryS: 0,
    })
    expect(ds.startTime?.toISOString()).toBe('2024-01-01T00:00:00.000Z')
    expect(ds.endTime?.toISOString()).toBe('2024-01-11T00:00:00.000Z')
  })

  it('draws a data-encoded dataset its colour bar, in readable units, rather than any image', () => {
    const ds = kioskDatasetFrom(CARD, {
      ...RECORD,
      renderEncoding: 'data-luma',
      colorScale: { stops: [{ t: 0, rgba: [0, 0, 0, 0] }, { t: 1, rgba: [255, 0, 0, 255] }], vmin: 0, vmax: 2e-7, units: 'kg m-3' },
    }, BASE)
    expect(ds.legend?.kind).toBe('scale')
    if (ds.legend?.kind !== 'scale') return
    expect(ds.legend.scale.units).toBe('µg m-3')
    expect(ds.legend.scale.sourceUnits).toBe('kg m-3')
  })

  it('falls back to the image when a declared colour scale does not parse', () => {
    const ds = kioskDatasetFrom(CARD, { ...RECORD, renderEncoding: 'data-luma', colorScale: { nonsense: true } }, BASE)
    expect(ds.legend).toEqual({ kind: 'image', url: 'https://cdn.example/legend.png' })
  })

  it('leaves out an image address that is not http(s)', () => {
    expect(imageAddress('javascript:alert(1)', BASE)).toBeNull()
    expect(imageAddress('data:image/png;base64,AAAA', BASE)).toBeNull()
    expect(imageAddress('', BASE)).toBeNull()
    expect(imageAddress(42, BASE)).toBeNull()
    expect(kioskDatasetFrom(CARD, { ...RECORD, legendLink: 'javascript:x', thumbnailLink: undefined }, BASE)).toMatchObject({
      legend: null,
      thumbnail: null,
    })
  })

  it('refuses a record with no id, and reads a missing length, retry or frame count as none', () => {
    expect(() => kioskDatasetFrom(CARD, { title: 'x' }, BASE)).toThrow(KioskDataError)
    const ds = kioskDatasetFrom({ ...CARD, exactDuration: -3, retry: 'soon' }, { id: 'DS1', frames: { count: 1 } }, BASE)
    expect(ds).toMatchObject({ lengthS: 0, retryS: 0, frameCount: null, title: 'Card title', abstract: [] })
  })

  it("refuses a dataset the card says the globe can't show, which the globe shows as the live Earth", () => {
    let caught: unknown
    try {
      kioskDatasetFrom({ ...CARD, kind: 'tour', showable: false }, RECORD, BASE)
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ failure: 'not_playable' })
  })
})

describe('plainParagraphs', () => {
  it("reads an SOS abstract's HTML as plain paragraphs, its own line breaks as spaces", () => {
    const sos = '<p>Ocean currents carry heat\nand salt &amp; nutrients.</p>\n<p>See <a href="https://sos.noaa.gov/">Science\nOn a Sphere</a>.<br>Updated daily.</p>'
    expect(plainParagraphs(sos)).toEqual([
      'Ocean currents carry heat and salt & nutrients.',
      'See Science On a Sphere.',
      'Updated daily.',
    ])
  })

  it('runs nothing in the HTML it reads', () => {
    expect(plainParagraphs('<p>Safe</p><script>window.ran = true</script><img src=x onerror="window.ran = true">')).toEqual(['Safe'])
    expect((window as unknown as { ran?: boolean }).ran).toBeUndefined()
  })

  it("reads a portal abstract's Markdown as its words", () => {
    const md = '## Overview\nSmoke from **wildfires** carries *fine* particles,\nsee [the forecast](https://x.example) and `PM2.5`.\n\n- hourly\n- two days ahead\n1. first\n![map](m.png)'
    expect(plainParagraphs(md)).toEqual([
      'Overview Smoke from wildfires carries fine particles, see the forecast and PM2.5.',
      '• hourly',
      '• two days ahead',
      '1. first',
    ])
  })

  it('keeps an underscore inside a word, and plain text as it is', () => {
    expect(plainParagraphs('The snake_case_name stays.\n\nA second paragraph.')).toEqual(['The snake_case_name stays.', 'A second paragraph.'])
    expect(plainParagraphs('   ')).toEqual([])
  })
})

describe('fetchKioskDataset', () => {
  const answer = (body: unknown, status = 200) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

  it('reads the card and the record for the id, both at once', async () => {
    const seen: string[] = []
    const fetchFn = vi.fn(async (url: string) => {
      seen.push(url)
      return url.includes('/exhibit/') ? answer(CARD) : answer(RECORD)
    })
    const ds = await fetchKioskDataset('a b', { fetchFn, base: BASE })
    expect(seen.sort()).toEqual(['/api/exhibit/v1/datasets/a%20b', '/api/v1/datasets/a%20b'])
    expect(ds.title).toBe('Record title')
  })

  it('says why a read failed', async () => {
    const fail = (fetchFn: (url: string) => Promise<Response>) => fetchKioskDataset('X', { fetchFn, base: BASE }).catch((e: unknown) => e)
    expect(await fail(async () => answer({ error: 'not_found' }, 404))).toMatchObject({ failure: 'not_found' })
    expect(await fail(async () => answer('oops', 500))).toMatchObject({ failure: 'http' })
    expect(await fail(async () => answer('<html>'))).toMatchObject({ failure: 'bad_response' })
    expect(await fail(async () => { throw new TypeError('offline') })).toMatchObject({ failure: 'network' })
  })
})

describe('kioskWhen', () => {
  // A ten-day span over a 100 s clip: 10 s of clip a day.
  const T0 = Date.UTC(2026, 9, 28, 12, 0, 0)

  it('dates a paused clip at its position, at the cadence its frames step', () => {
    const when = kioskWhen(dataset(), clock({ positionS: 50, paused: true }), T0, T0)
    expect(when).toEqual({ state: 'paused', text: 'Jan 6, 2024', rate: 1 })
  })

  it("runs a playing clip on from its anchor at the globe's rate, wrapping round the loop", () => {
    const at = T0 / 1000
    const playing = kioskWhen(dataset(), clock({ positionS: 0, atUnixS: at, rate: 2 }), T0 + 25_000, T0)
    expect(playing).toEqual({ state: 'playing', text: 'Jan 6, 2024', rate: 2 })
    // 25 s at 2x past a start of 80 s is 130 s, which is 30 s round a 100 s loop.
    expect(kioskWhen(dataset(), clock({ positionS: 80, atUnixS: at, rate: 2 }), T0 + 25_000, T0).text).toBe('Jan 4, 2024')
  })

  it('times a clock with no anchor from when this copy read it', () => {
    const when = kioskWhen(dataset(), clock({ positionS: 0 }), T0 + 50_000, T0)
    expect(when.text).toBe('Jan 6, 2024')
  })

  it('gives the time, in UTC, snapped to the frame the globe shows, for a dataset stepping faster than a day', () => {
    // A day in six-hour frames: 30 s of 100 is 07:12, inside the 06:00 frame.
    const ds = dataset({ period: 'PT6H', endTime: new Date('2024-01-02T00:00:00Z'), frameCount: null })
    expect(kioskWhen(ds, clock({ positionS: 30, paused: true }), T0, T0).text).toBe('Jan 1, 2024, 06:00 UTC')
  })

  it("lets a stated period decide whether there is a time, as the app's label does", () => {
    // A day over the clip in hundred-odd frames: the cadence alone says hours.
    const day = { endTime: new Date('2024-01-02T00:00:00Z'), frameCount: 97 }
    expect(kioskWhen(dataset({ ...day, period: '' }), clock({ positionS: 30, paused: true }), T0, T0).text).toMatch(/UTC$/)
    expect(kioskWhen(dataset({ ...day, period: 'P1D' }), clock({ positionS: 30, paused: true }), T0, T0).text).toBe('Jan 1, 2024')
  })

  it('writes the date in UTC wherever the page runs', () => {
    const zone = process.env.TZ
    process.env.TZ = 'America/Denver'
    __resetFormatterCacheForTests()
    try {
      expect(kioskDate(new Date(Date.UTC(2024, 0, 1, 3)), 'time')).toBe('Jan 1, 2024, 03:00 UTC')
      expect(kioskDate(new Date(Date.UTC(2024, 0, 1, 3)), 'day')).toBe('Jan 1, 2024')
    } finally {
      process.env.TZ = zone
      __resetFormatterCacheForTests()
    }
  })

  it("shows a picture at its date, or its span, with a time only for a period under a day", () => {
    expect(kioskWhen(dataset({ kind: 'image', endTime: null }), clock(), T0, T0)).toEqual({ state: 'still', text: 'Jan 1, 2024', rate: 1 })
    expect(kioskWhen(dataset({ kind: 'image' }), clock(), T0, T0).text).toMatch(range('Jan 1', '11, 2024'))
    // No period: a date, not a time, as the app shows a picture.
    expect(kioskWhen(dataset({ kind: 'image', period: '', endTime: null }), clock(), T0, T0).text).toBe('Jan 1, 2024')
    expect(kioskWhen(dataset({ kind: 'image', period: 'PT1H', endTime: null }), clock(), T0, T0).text).toBe('Jan 1, 2024, 00:00 UTC')
  })

  it("shows a video's whole span until the node gives its length, rather than a guessed date", () => {
    const when = kioskWhen(dataset({ lengthS: 0 }), clock({ positionS: 50, paused: true }), T0, T0)
    expect(when.state).toBe('span')
    expect(when.text).toMatch(range('Jan 1', '11, 2024'))
  })

  it('says nothing for a dataset with no dates, or a video with only one end, as the app does', () => {
    expect(kioskWhen(dataset({ startTime: null, endTime: null }), clock(), T0, T0)).toEqual({ state: 'none', text: '', rate: 1 })
    expect(kioskWhen(dataset({ endTime: null }), clock({ positionS: 50, paused: true }), T0, T0).state).toBe('none')
  })

  it('writes a coarser date while a clip plays too fast for its own to be read, and the exact one when paused', () => {
    // Fifteen years over three minutes: a month a second at 1x, a year at 12x.
    const quakes = dataset({
      startTime: new Date('2001-01-01T00:00:00Z'), endTime: new Date('2015-12-31T00:00:00Z'), lengthS: 180, period: 'P1D', frameCount: null,
    })
    const at = T0 / 1000
    expect(kioskWhen(quakes, clock({ positionS: 90, atUnixS: at }), T0, T0).text).toBe('Jul 2008')
    expect(kioskWhen(quakes, clock({ positionS: 90, atUnixS: at, rate: 12 }), T0, T0).text).toBe('2008')
    expect(kioskWhen(quakes, clock({ positionS: 90, paused: true }), T0, T0).text).toMatch(/^Jul \d+, 2008$/)
  })

  it("dates the live Earth now, to the minute, in UTC", () => {
    expect(earthWhen(T0)).toEqual({ state: 'live', text: 'Oct 28, 2026, 12:00 UTC', rate: 1 })
  })
})

describe('dateDetail', () => {
  afterEach(() => __resetFormatterCacheForTests())

  it('keeps the finest detail whose date changes at most once a second', () => {
    // An hour of data a second, in hourly frames: the time changes once a second.
    expect(dateDetail('time', 3600, 3600)).toBe('time')
    // Two hours a second: the day.
    expect(dateDetail('time', 7200, 3600)).toBe('day')
    // A day a second in daily frames: still the day.
    expect(dateDetail('day', 86_400, 86_400)).toBe('day')
    expect(dateDetail('day', 10 * 86_400, 86_400)).toBe('month')
    expect(dateDetail('day', 400 * 86_400, 86_400)).toBe('year')
    // Never finer than the dataset's own: a daily dataset never gains a time.
    expect(dateDetail('day', 1, 86_400)).toBe('day')
    // A slow clip in frames a week apart changes once a week of data, not once a day.
    expect(dateDetail('day', 3 * 86_400, 7 * 86_400)).toBe('day')
  })
})
