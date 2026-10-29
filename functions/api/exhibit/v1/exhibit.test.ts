// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the exhibit reads (`_lib/exhibit-reads.ts`): the card, the
 * menu's pages and the tags, against a migrated catalog in SQLite.
 *
 * Copies of the Second Life exhibit's scripts can't be updated once they
 * are rezzed, so these pin the contract as well as the behaviour: each
 * reply's field names and types, and each byte budget with the worst data
 * the node accepts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { asD1, makeCtx } from '../../v1/_lib/test-helpers'
import { freshMigratedDb } from '../../../../scripts/lib/catalog-migrations'
import {
  byteLength,
  CARD_ABSTRACT_CHARS,
  CARD_BUDGET,
  CARD_CAPS,
  CARD_SKELETON,
  exhibitList,
  listHash,
  LIST_STALE_MS,
  LIST_TTL_MS,
  PAGE_BUDGET,
  PAGE_CAPS,
  PAGE_MAX_OFFSET,
  buildCard,
  buildTags,
  resetExhibitListForTests,
  TAG_CAP,
  TAGS_BUDGET,
  TAGS_MAX,
  type ExhibitCard,
  type ExhibitPage,
  type ExhibitTags,
} from '../../v1/_lib/exhibit-reads'
import { jsonBytes } from '../../v1/_lib/exhibit-text'
import { resetHlsDurationsForTests, type PlaylistBucket } from '../../v1/_lib/hls-duration'
import { onRequestGet as getCard, onRequestHead as headCard } from './datasets/[id]'
import { onRequestGet as getPage, onRequestHead as headPage } from './datasets'
import { onRequestGet as getTags, onRequestHead as headTags } from './tags'
import { onRequest as noSuchRoute } from '../[[path]]'

const TS = '2026-10-01T00:00:00.000Z'

interface Row {
  id: string
  title?: string
  slug?: string
  format?: string
  data_ref?: string
  weight?: number
  tags?: string[]
  visibility?: string
  hidden?: boolean
  published?: boolean
  retracted?: boolean
  abstract?: string
  organization?: string | null
  attribution_text?: string | null
  rights_holder?: string | null
  license_spdx?: string | null
  license_url?: string | null
  license_statement?: string | null
  start_time?: string | null
  end_time?: string | null
  period?: string | null
}

function seed(sqlite: Database.Database, rows: Row[]): void {
  const insert = sqlite.prepare(
    `INSERT INTO datasets (id, slug, origin_node, title, abstract, organization, format, data_ref,
                           weight, visibility, is_hidden, schema_version,
                           attribution_text, rights_holder, license_spdx, license_url, license_statement,
                           start_time, end_time, period,
                           created_at, updated_at, published_at, retracted_at, publisher_id)
     VALUES (?, ?, 'NODE000', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PUB001')`,
  )
  const tag = sqlite.prepare('INSERT INTO dataset_tags (dataset_id, tag) VALUES (?, ?)')
  for (const row of rows) {
    insert.run(
      row.id, row.slug ?? row.id.toLowerCase(), row.title ?? `Title ${row.id}`, row.abstract ?? 'Abstract.',
      row.organization ?? null, row.format ?? 'video/mp4', row.data_ref ?? 'url:https://example.org/v.mp4', row.weight ?? 0,
      row.visibility ?? 'public', row.hidden ? 1 : 0,
      row.attribution_text ?? null, row.rights_holder ?? null, row.license_spdx ?? null,
      row.license_url ?? null, row.license_statement ?? null,
      row.start_time ?? null, row.end_time ?? null, row.period ?? null,
      TS, TS, row.published === false ? null : TS, row.retracted ? TS : null,
    )
    for (const t of row.tags ?? []) tag.run(row.id, t)
  }
}

function setup(rows: Row[]): Database.Database {
  const sqlite = freshMigratedDb()
  sqlite
    .prepare(
      `INSERT INTO node_identity (node_id, display_name, base_url, public_key, created_at)
       VALUES ('NODE000', 'T', 'https://t', 'k', ?)`,
    )
    .run(TS)
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, status, created_at)
       VALUES ('PUB001', 'p@t', 'P', 'admin', 'active', ?)`,
    )
    .run(TS)
  seed(sqlite, rows)
  return sqlite
}

interface Got<T> { status: number; body: T; text: string; res: Response }

async function call<T>(
  handler: (ctx: never) => Promise<Response> | Response,
  sqlite: Database.Database | null,
  path: string,
  extra: {
    params?: Record<string, string>
    env?: Record<string, unknown>
    method?: string
    waitUntil?: (p: Promise<unknown>) => void
  } = {},
): Promise<Got<T>> {
  const env: Record<string, unknown> = { ...(sqlite ? { CATALOG_DB: asD1(sqlite) } : {}), ...extra.env }
  const ctx = makeCtx({ url: `https://test.local${path}`, env, params: extra.params, method: extra.method })
  if (extra.waitUntil) Object.assign(ctx, { waitUntil: extra.waitUntil })
  const res = await handler(ctx as never)
  const text = await res.text()
  return { status: res.status, body: JSON.parse(text) as T, text, res }
}

const card = (sqlite: Database.Database, id: string, env?: Record<string, unknown>) =>
  call<ExhibitCard>(getCard as never, sqlite, `/api/exhibit/v1/datasets/${id}`, { params: { id }, env })
const page = (sqlite: Database.Database, query = '') =>
  call<ExhibitPage>(getPage as never, sqlite, `/api/exhibit/v1/datasets${query}`)
const tags = (sqlite: Database.Database) => call<ExhibitTags>(getTags as never, sqlite, '/api/exhibit/v1/tags')

const ULID = (n: number) => `01KQG6${String(n).padStart(20, '0')}`

/** A D1 whose every query fails, as during an outage or a spent quota. */
const BROKEN_DB = { prepare() { throw new Error('D1 is down') } }

const bytesOf = (text: string): number => new TextEncoder().encode(text).byteLength

/** A bucket holding one HLS bundle of 6 + 0.2 seconds with no audio, or failing. */
function bucket(mode: 'ok' | 'fail'): PlaylistBucket {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=4096x2048,CODECS="avc1.640033"\nstream_0/playlist.m3u8\n'
  const variant = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000000,\ns0.ts\n#EXTINF:0.200000,\ns1.ts\n#EXT-X-ENDLIST\n'
  const files: Record<string, string> = {
    'videos/DS/U/master.m3u8': master,
    'videos/DS/U/stream_0/playlist.m3u8': variant,
  }
  return {
    async get(key) {
      if (mode === 'fail') throw new Error('R2 is down')
      const text = files[key]
      return text === undefined ? null : { size: text.length, text: async () => text }
    },
  }
}

/** The fetch a test gets unless it arranges its own. */
let unarranged: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetExhibitListForTests()
  resetHlsDurationsForTests()
  // A card for a Vimeo row asks the video proxy and Vimeo: no test may
  // reach the network, and one that does without arranging it fails,
  // rather than passing on the retry card a failed fetch makes.
  unarranged = vi.fn(async (input: RequestInfo | URL) => {
    throw new Error(`unexpected fetch: ${String(input)}`)
  })
  vi.stubGlobal('fetch', unarranged)
})
afterEach(() => {
  resetExhibitListForTests()
  vi.unstubAllGlobals()
  expect(unarranged).not.toHaveBeenCalled()
})

/** The video proxy and Vimeo for one video, as a fetch, the way Vimeo
 *  serves it: the player's address answers 302 with the CDN's, whose
 *  master names video-only variants (`hls-duration.test.ts` has the
 *  fuller playlists and the refusals). Called as another object's
 *  method it throws, as Workers' fetch does and Node's doesn't: every
 *  card's Vimeo read failed on Cloudflare that way while these passed. */
function vimeoFetch(proxy = 'https://video-proxy.zyra-project.org/video') {
  const at = 'https://skyfire.vimeocdn.com/a/b/c/playlist.m3u8'
  const routes: Record<string, () => Response | Promise<Response>> = {
    [`${proxy}/920241809`]: () => Response.json({ id: '920241809', duration: 12, hls: 'https://player.vimeo.com/play/x/hls.m3u8' }),
    'https://player.vimeo.com/play/x/hls.m3u8': () => new Response(null, { status: 302, headers: { location: at } }),
    [at]: () => new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,FRAME-RATE=30.000,CODECS="avc1.640020"\n../../../x/media.m3u8?sig=1\n'),
    'https://skyfire.vimeocdn.com/x/media.m3u8?sig=1': () =>
      new Response('#EXTM3U\n#EXTINF:6.000000,\na.mp4\n#EXTINF:6.100000,\nb.mp4\n#EXT-X-ENDLIST\n'),
  }
  return vi.fn(async function (this: unknown, input: RequestInfo | URL) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError('Illegal invocation: function called with incorrect `this` reference.')
    }
    const route = routes[String(input)]
    if (!route) throw new Error(`unexpected fetch: ${String(input)}`)
    return route()
  })
}

describe('GET /api/exhibit/v1/datasets/{id}, the card', () => {
  it('has exactly the contract\'s fields, in order, with their types', async () => {
    const sqlite = setup([{ id: ULID(1) }])
    const { status, body, res } = await card(sqlite, ULID(1))
    expect(status).toBe(200)
    expect(Object.keys(body)).toEqual([
      'id', 'page', 'kind', 'showable', 'title', 'startTime', 'endTime', 'period', 'exactDuration', 'retry',
      'credit', 'license', 'licenseText', 'abstract', 'truncated',
    ])
    expect(Object.keys(JSON.parse(CARD_SKELETON))).toEqual(Object.keys(body))
    expect(Object.keys(CARD_CAPS)).toEqual(Object.keys(body).filter(k => k !== 'abstract'))
    const types = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v]))
    expect(types).toEqual({
      id: 'string', page: 'string', kind: 'string', showable: 'boolean', title: 'string',
      startTime: 'string', endTime: 'string',
      period: 'string', exactDuration: 'number', retry: 'number', credit: 'string', license: 'string',
      licenseText: 'string', abstract: 'string', truncated: 'boolean',
    })
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(res.headers.get('Content-Type')).toContain('application/json')
  })

  it('gives the plain text of a record, its page and its dates', async () => {
    const sqlite = setup([{
      id: ULID(1), slug: 'hurricane-maria-2017', title: 'Hurricane <b>Maria</b> &amp; Irma',
      abstract: '<p>Clouds over the <a href="https://x">Caribbean</a>.</p>',
      organization: 'NOAA', license_spdx: 'CC-BY-4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/',
      license_statement: 'Free to use with credit.',
      start_time: '2017-09-17T00:00:00Z', end_time: '2017-09-25T23:45:00Z', period: 'PT15M',
    }])
    const { body } = await card(sqlite, ULID(1))
    expect(body).toMatchObject({
      id: ULID(1), page: '/dataset/hurricane-maria-2017', kind: 'video', title: 'Hurricane Maria & Irma',
      startTime: '2017-09-17T00:00:00Z', endTime: '2017-09-25T23:45:00Z', period: 'PT15M',
      credit: 'NOAA', license: 'CC-BY-4.0',
      licenseText: 'Free to use with credit. https://creativecommons.org/licenses/by/4.0/',
      abstract: 'Clouds over the Caribbean.', truncated: false,
    })
  })

  it('takes the credit from the attribution, else the rights holder, else the organization', async () => {
    const sqlite = setup([
      { id: ULID(1), attribution_text: 'A', rights_holder: 'R', organization: 'O' },
      { id: ULID(2), rights_holder: 'R', organization: 'O' },
      { id: ULID(3), organization: 'O' },
      // A field with no text once its HTML is out passes to the next.
      { id: ULID(4), attribution_text: '<br>', rights_holder: '&nbsp;', organization: 'O' },
    ])
    expect((await card(sqlite, ULID(1))).body.credit).toBe('A')
    expect((await card(sqlite, ULID(2))).body.credit).toBe('R')
    expect((await card(sqlite, ULID(3))).body.credit).toBe('O')
    expect((await card(sqlite, ULID(4))).body.credit).toBe('O')
  })

  it('marks nothing cut for a title padded with spaces past the source bound', async () => {
    const sqlite = setup([{ id: ULID(1), title: `Hurricane Maria${' '.repeat(9000)}` }])
    expect((await card(sqlite, ULID(1))).body).toMatchObject({ title: 'Hurricane Maria', truncated: false })
  })

  it('passes over a credit that is all markup past the source bound', async () => {
    const sqlite = setup([
      { id: ULID(1), attribution_text: '<img src="x">'.repeat(1000), organization: 'NOAA' },
      // With nothing found, a field passed over leaves no mark either.
      { id: ULID(2), organization: '<img src="x">'.repeat(1000) },
    ])
    expect((await card(sqlite, ULID(1))).body.credit).toBe('NOAA')
    expect((await card(sqlite, ULID(2))).body).toMatchObject({ credit: '', truncated: false })
  })

  it('answers an abstract Markdown can\'t parse, or would parse slowly, with its text', async () => {
    const sqlite = setup([
      // Each overflowed the parser's stack, or took 40 to 690 ms.
      { id: ULID(1), abstract: '>'.repeat(3072) },
      { id: ULID(2), abstract: '&gt;'.repeat(4000) },
      { id: ULID(3), abstract: '1. '.repeat(1024) },
      { id: ULID(4), abstract: '*a _b '.repeat(1365) },
      { id: ULID(5), abstract: 'Ocean heat. ' + '> '.repeat(1500) },
    ])
    for (const n of [1, 2, 3, 4, 5]) {
      const { status, text } = await card(sqlite, ULID(n))
      expect(status, String(n)).toBe(200)
      expect(bytesOf(text), String(n)).toBeLessThanOrEqual(2048)
    }
    expect((await card(sqlite, ULID(4))).body.abstract.startsWith('*a _b *a _b')).toBe(true)
    expect((await card(sqlite, ULID(5))).body.abstract.startsWith('Ocean heat.')).toBe(true)
  })

  it('keeps a Markdown autolink as its address, and a tag holding one as a tag', async () => {
    const sqlite = setup([
      { id: ULID(1), abstract: 'Data at <https://www.ncei.noaa.gov/products> or <help@noaa.gov>.' },
      { id: ULID(2), abstract: '<!--contact:foo@bar.com-->Sea ice <a/href="mailto:x@y.org">by month</a>.' },
    ])
    expect((await card(sqlite, ULID(1))).body.abstract).toBe('Data at https://www.ncei.noaa.gov/products or help@noaa.gov.')
    expect((await card(sqlite, ULID(2))).body.abstract).toBe('Sea ice by month.')
  })

  it('reads a title and a credit as text, and only the abstract as Markdown', async () => {
    const sqlite = setup([
      { id: ULID(1), title: '1. Hurricane Maria', organization: '# of fires per day', abstract: '1. One\n2. **Two**' },
      { id: ULID(2), title: '&gt; 50 Years of Sea Ice', abstract: 'Use the &lt;b&gt; tag, and &amp;lt; too.' },
      { id: ULID(3), title: '2017. A year of storms' },
    ])
    expect((await card(sqlite, ULID(1))).body).toMatchObject({
      title: '1. Hurricane Maria', credit: '# of fires per day', abstract: 'One Two',
    })
    // Each escape is read once: escaped markup stays text.
    expect((await card(sqlite, ULID(2))).body).toMatchObject({
      title: '> 50 Years of Sea Ice', abstract: 'Use the <b> tag, and &lt; too.',
    })
    expect((await card(sqlite, ULID(3))).body.title).toBe('2017. A year of storms')
  })

  it('links by the id when the slug is one the app would not use', async () => {
    const sqlite = setup([{ id: ULID(1), slug: 'Bad_Slug' }])
    expect((await card(sqlite, ULID(1))).body.page).toBe(`/dataset/${ULID(1)}`)
  })

  it('answers a tour as a tour, and any other format as a word of its own', async () => {
    const sqlite = setup([
      { id: ULID(1), format: 'tour/json', data_ref: 'r2:tours/x.json' },
      { id: ULID(2), format: 'image/png', data_ref: 'url:https://x/y.png' },
      { id: ULID(3), format: 'application/json', data_ref: 'url:https://x/y.json' },
    ])
    expect((await card(sqlite, ULID(1))).body).toMatchObject({ kind: 'tour', showable: false })
    expect((await card(sqlite, ULID(2))).body).toMatchObject({ kind: 'image', showable: true })
    expect((await card(sqlite, ULID(3))).body).toMatchObject({ kind: 'application', showable: false })
  })

  it('says whether the page can show it, which the kind alone does not', async () => {
    vi.stubGlobal('fetch', vimeoFetch())
    const sqlite = setup([
      { id: ULID(1), format: 'video/mp4', data_ref: 'vimeo:920241809' },
      { id: ULID(2), format: 'video/mp4', data_ref: 'peer:NODE1/x' },
      { id: ULID(3), format: 'image/png', data_ref: 'vimeo:2' },
      // The manifest reads the format as written, case and all.
      { id: ULID(4), format: 'Video/MP4', data_ref: 'url:https://x/y.mp4' },
    ])
    expect((await card(sqlite, ULID(1))).body).toMatchObject({ kind: 'video', showable: true })
    expect((await card(sqlite, ULID(2))).body).toMatchObject({ kind: 'video', showable: false })
    expect((await card(sqlite, ULID(3))).body).toMatchObject({ kind: 'image', showable: false })
    expect((await card(sqlite, ULID(4))).body).toMatchObject({ kind: 'video', showable: false })
  })

  it('sends machine values whole or not at all', async () => {
    const sqlite = setup([
      {
        id: ULID(1), start_time: 'September 2017', end_time: '2017-09-25', period: 'every 15 minutes',
        license_spdx: 'CC-BY-4.0<script>', license_url: 'javascript:alert(1)',
      },
      // An address the node's own check calls unsafe is left out, rather
      // than repaired by URL into one that reads differently: a control
      // character, white space, a backslash, or credentials, which in chat
      // read as noaa.gov and go to evil.com.
      { id: ULID(2), license_url: 'https://x.org/\u0001a' },
      { id: ULID(3), license_url: 'https://creativecommons.org/licenses/by/4.0/ "CC BY"' },
      { id: ULID(4), license_url: 'https://x.org\\licence' },
      { id: ULID(5), license_url: 'https://user:pw@noaa.gov@evil.com/' },
      { id: ULID(6), license_url: 'not a url' },
      // A safe one that isn't ASCII goes in the ASCII form URL writes.
      { id: ULID(7), license_url: 'https://例え.jp/ライセンス' },
      { id: ULID(8), license_url: 'https://x.org/\ufdd0' },
    ])
    const { body } = await card(sqlite, ULID(1))
    expect(body).toMatchObject({ startTime: '', endTime: '', period: '', license: '', licenseText: '' })
    for (const n of [2, 3, 4, 5, 6]) expect((await card(sqlite, ULID(n))).body.licenseText, String(n)).toBe('')
    expect((await card(sqlite, ULID(7))).body.licenseText).toBe(
      'https://xn--r8jz45g.jp/%E3%83%A9%E3%82%A4%E3%82%BB%E3%83%B3%E3%82%B9',
    )
    expect((await card(sqlite, ULID(8))).body.licenseText).toBe('https://x.org/%EF%B7%90')
  })

  it('keeps an instant to the millisecond, as many digits as the validators allow', async () => {
    const sqlite = setup([{ id: ULID(1), start_time: '2017-09-17T00:00:00.123456Z', end_time: '2017-09-25T23:45:00Z' }])
    expect((await card(sqlite, ULID(1))).body).toMatchObject({
      startTime: '2017-09-17T00:00:00.123Z', endTime: '2017-09-25T23:45:00Z',
    })
  })

  it('carries the exact length of an HLS bundle the node holds', async () => {
    const sqlite = setup([{ id: ULID(1), data_ref: 'r2:videos/DS/U/master.m3u8' }])
    // The read is handed to waitUntil, so one that misses the time limit
    // still lands for the next request.
    const waitUntil = vi.fn()
    const { body } = await call<ExhibitCard>(getCard as never, sqlite, `/api/exhibit/v1/datasets/${ULID(1)}`, {
      params: { id: ULID(1) }, env: { CATALOG_R2: bucket('ok') }, waitUntil,
    })
    expect(body.exactDuration).toBeCloseTo(6.2, 6)
    expect(body.retry).toBe(0)
    expect(waitUntil).toHaveBeenCalledTimes(1)
  })

  it('writes the length as a plain decimal of at most six places, which a script reads digit by digit', async () => {
    // The info script reads exactDuration's whole and fractional digits
    // into microseconds (scripts/second-life-exhibit), so an exponent or a
    // seventh place would be misread, by copies that can't be updated.
    const sqlite = setup([{ id: ULID(1), data_ref: 'r2:videos/DS/U/master.m3u8' }])
    const [entry] = await exhibitList(asD1(sqlite))
    const lengths = [1e-6, 0.0000014, 0.1, 1.7, 4.333333333, 12.1, 143.7666721, 717.0333333, 2146.9999994,
      123456.789012345, 999_999_999.9999994]
    for (let i = 0; i < 200; i++) lengths.push(10 ** (Math.random() * 15 - 6))
    for (const seconds of lengths) {
      const text = JSON.stringify(buildCard(entry, { seconds, settled: true }))
      const written = text.match(/"exactDuration":([^,}]+)/)?.[1]
      expect(written, String(seconds)).toMatch(/^(0|[1-9]\d*)(\.\d{1,6})?$/)
      // Rounded to the microsecond: half of one off, and a double's own error.
      expect(Math.abs(Number(written) - (seconds < 1e9 ? seconds : 0))).toBeLessThanOrEqual(5e-7 + seconds * 1e-15)
    }
  })

  it('reads no length for a row the page can\'t show', async () => {
    // The manifest reads the format as written, so this one isn't shown.
    const sqlite = setup([{ id: ULID(1), format: 'Video/MP4', data_ref: 'r2:videos/DS/U/master.m3u8' }])
    const waitUntil = vi.fn()
    const { body } = await call<ExhibitCard>(getCard as never, sqlite, `/api/exhibit/v1/datasets/${ULID(1)}`, {
      params: { id: ULID(1) }, env: { CATALOG_R2: bucket('ok') }, waitUntil,
    })
    expect(body).toMatchObject({ showable: false, exactDuration: 0, retry: 0 })
    expect(waitUntil).not.toHaveBeenCalled()
  })

  it('reads the id percent-decoded, as llEscapeURL sends one with - or _', async () => {
    const sqlite = setup([{ id: 'LEGACY-ID_1' }])
    expect((await card(sqlite, 'LEGACY%2DID%5F1')).body.id).toBe('LEGACY-ID_1')
    expect((await card(sqlite, 'LEGACY%2')).status).toBe(404)
  })

  it('reads a Vimeo stream\'s exact length from its own playlists, not the API\'s whole seconds', async () => {
    // As Vimeo served the real-time sea surface temperature: the API says
    // 12, the stream's segments sum to 12.1.
    vi.stubGlobal('fetch', vimeoFetch())
    const sqlite = setup([{ id: ULID(1), data_ref: 'vimeo:920241809' }])
    // Handed to waitUntil, as the bucket's read is.
    const waitUntil = vi.fn()
    const { body, res } = await call<ExhibitCard>(getCard as never, sqlite, `/api/exhibit/v1/datasets/${ULID(1)}`, {
      params: { id: ULID(1) }, waitUntil,
    })
    expect(body).toMatchObject({ exactDuration: 12.1, retry: 0 })
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(waitUntil).toHaveBeenCalledTimes(1)
  })

  it('asks the video proxy the node names, not the default one', async () => {
    const proxied = vimeoFetch('https://proxy.staging.test/video')
    vi.stubGlobal('fetch', proxied)
    const sqlite = setup([{ id: ULID(1), data_ref: 'vimeo:920241809' }])
    expect((await card(sqlite, ULID(1), { VIDEO_PROXY_BASE: 'https://proxy.staging.test/video' })).body.exactDuration).toBe(12.1)
    expect(String(proxied.mock.calls[0][0])).toBe('https://proxy.staging.test/video/920241809')
  })

  it('asks nothing about a Vimeo row the page can\'t show', async () => {
    const sqlite = setup([{ id: ULID(1), format: 'image/png', data_ref: 'vimeo:920241809' }])
    expect((await card(sqlite, ULID(1))).body).toMatchObject({ showable: false, exactDuration: 0, retry: 0 })
    // afterEach holds that nothing was fetched.
  })

  it('is settled, with no length, for a Vimeo video that is gone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))
    const sqlite = setup([{ id: ULID(1), data_ref: 'vimeo:920241809' }])
    const { body, res } = await card(sqlite, ULID(1))
    expect(body).toMatchObject({ exactDuration: 0, retry: 0 })
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60')
    vi.mocked(console.warn).mockRestore()
  })

  it('asks the script to try again when the video proxy fails for a Vimeo row', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })))
    const sqlite = setup([{ id: ULID(1), data_ref: 'vimeo:920241809' }])
    const { body, res } = await card(sqlite, ULID(1))
    expect(body).toMatchObject({ exactDuration: 0, retry: 15 })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('says 0, settled, for a video with no playlist to read', async () => {
    const sqlite = setup([{ id: ULID(1), data_ref: 'url:https://example.org/v.mp4' }])
    expect((await card(sqlite, ULID(1))).body).toMatchObject({ exactDuration: 0, retry: 0 })
  })

  it('asks the script to try again, and is never kept, when the length read did not settle', async () => {
    const sqlite = setup([{ id: ULID(1), data_ref: 'r2:videos/DS/U/master.m3u8' }])
    const { body, res } = await card(sqlite, ULID(1), { CATALOG_R2: bucket('fail') })
    expect(body).toMatchObject({ exactDuration: 0, retry: 15 })
    // A cache keeping it as long as `retry` would answer the asking again.
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('cuts only prose, ending ..., and says so', async () => {
    const sqlite = setup([{ id: ULID(1), abstract: 'word '.repeat(2000) }])
    const { body } = await card(sqlite, ULID(1))
    expect(body.truncated).toBe(true)
    expect(body.abstract.endsWith('word...')).toBe(true)
  })

  it('says a licence statement the address left no room for was cut', async () => {
    // An address of 397 bytes leaves the statement less than a "...".
    const sqlite = setup([{
      id: ULID(1), license_url: `https://x.org/${'a'.repeat(383)}`, license_statement: 'Free to use with credit.',
    }])
    const { body } = await card(sqlite, ULID(1))
    expect(body.licenseText).toBe(`https://x.org/${'a'.repeat(383)}`)
    expect(body.truncated).toBe(true)
  })

  it('gives a statement no room at all rather than more than its share', async () => {
    // Where not even one character fits beside the "...", as a curly quote
    // in 4 bytes: once, the cut took the whole text.
    const sqlite = setup([{
      id: ULID(1), license_url: `https://x.org/${'a'.repeat(381)}`, license_statement: '“Free to use” with credit to NOAA '.repeat(100),
    }])
    const { text, body } = await card(sqlite, ULID(1))
    expect(bytesOf(text)).toBeLessThanOrEqual(2048)
    expect(jsonBytes(body.licenseText)).toBeLessThanOrEqual(CARD_CAPS.licenseText)
    expect(body.truncated).toBe(true)
  })

  it('cuts a long source before reading it, and says so', async () => {
    const sqlite = setup([
      { id: ULID(1), abstract: `<p>${'Clouds over the sea. '.repeat(5000)}</p>` },
      // Markup past the cut hides the rest of the text: what is left fits,
      // and is still marked cut.
      { id: ULID(2), abstract: `Storm ${'<span></span>'.repeat(1000)} Rain` },
    ])
    const { text, body } = await card(sqlite, ULID(1))
    expect(bytesOf(text)).toBeLessThanOrEqual(2048)
    expect(body.truncated).toBe(true)
    expect(body.abstract.endsWith('...')).toBe(true)
    expect((await card(sqlite, ULID(2))).body).toMatchObject({ abstract: 'Storm...', truncated: true })
  })

  it('sends no more of an abstract than the info script keeps, in characters', async () => {
    // Its 500: an abstract of exactly 500 is whole, one more is cut, and
    // one in characters of three bytes that fits is whole too, as every
    // rezzed copy showed it.
    const sqlite = setup([
      { id: ULID(1), abstract: 'x'.repeat(500) },
      { id: ULID(2), abstract: 'x'.repeat(501) },
      { id: ULID(3), abstract: '海'.repeat(400) },
      { id: ULID(4), abstract: '海'.repeat(600) },
      { id: ULID(5), abstract: 'Clouds over the sea. '.repeat(100) },
    ])
    expect((await card(sqlite, ULID(1))).body).toMatchObject({ abstract: 'x'.repeat(500), truncated: false })
    expect((await card(sqlite, ULID(3))).body).toMatchObject({ abstract: '海'.repeat(400), truncated: false })
    for (const id of [ULID(2), ULID(4), ULID(5)]) {
      const { body } = await card(sqlite, id)
      expect(body.truncated, id).toBe(true)
      expect(body.abstract.length, id).toBeLessThanOrEqual(CARD_ABSTRACT_CHARS)
      expect(body.abstract.endsWith('...'), id).toBe(true)
    }
    // Within a word of what the script kept: its cut ended at a space at
    // or before character 500, this one's "..." falls inside the 500.
    expect((await card(sqlite, ULID(4))).body.abstract.length).toBeGreaterThan(490)
    // Cut at a word, as before.
    const source = 'Clouds over the sea. '.repeat(100)
    const kept = (await card(sqlite, ULID(5))).body.abstract.slice(0, -3)
    expect(source.startsWith(kept)).toBe(true)
    expect(source[kept.length]).toBe(' ')
    expect(kept.length).toBeGreaterThan(480)
    expect(CARD_ABSTRACT_CHARS).toBe(500)
  })

  it('fills the budget exactly, and counts truncated as the longer of its two values', async () => {
    // Within its 500 characters the abstract fills the room only in text
    // of more than a byte a character, beside other fields near their
    // caps (three bytes a character here; two would do at every cap). The
    // room is measured with `false`: an abstract that fits exactly gives
    // 2,048 bytes and isn't truncated, one byte more is cut.
    const full = { title: 'T'.repeat(200), attribution_text: 'C'.repeat(200), license_statement: 'L'.repeat(400) }
    const probe = setup([{ id: ULID(1), abstract: 'x', ...full }])
    const room = 2048 - (bytesOf((await card(probe, ULID(1))).text) - 1)
    const fill = (bytes: number) => '海'.repeat(Math.floor(bytes / 3)) + 'x'.repeat(bytes % 3)
    expect(fill(room + 1).length).toBeLessThanOrEqual(CARD_ABSTRACT_CHARS)
    const sqlite = setup([{ id: ULID(1), abstract: fill(room), ...full }, { id: ULID(2), abstract: fill(room + 1), ...full }])
    const exact = await card(sqlite, ULID(1))
    expect(bytesOf(exact.text)).toBe(2048)
    expect(exact.body.truncated).toBe(false)
    const over = await card(sqlite, ULID(2))
    expect(bytesOf(over.text)).toBeLessThanOrEqual(2048)
    expect(over.body.truncated).toBe(true)
  })

  it('keeps its budget with the worst data the node accepts', async () => {
    const worst = (n: number) => '"\\海\u0001'.repeat(n)
    const sqlite = setup([{
      id: ULID(1), slug: 'a'.repeat(64), title: worst(200), abstract: worst(5000), attribution_text: worst(500),
      license_spdx: 'A'.repeat(64), license_url: `https://example.org/${'a'.repeat(370)}`,
      license_statement: worst(500), start_time: '2017-09-17T00:00:00.000Z', end_time: '2017-09-25T23:45:00.000Z',
      period: 'P1Y2M3W4DT5H6M7.5S',
    }])
    const { text, body } = await card(sqlite, ULID(1))
    const size = bytesOf(text)
    expect(size).toBeLessThanOrEqual(2048)
    // And uses it: a budget a card never comes near would prove nothing.
    expect(size).toBeGreaterThan(2000)
    expect(body.truncated).toBe(true)
    // The licence's address is kept whole.
    expect(body.licenseText.endsWith('a'.repeat(370))).toBe(true)
    // Each field within its own cap, and the abstract its share.
    for (const [name, cap] of Object.entries(CARD_CAPS)) {
      const value = body[name as keyof ExhibitCard]
      const sent = typeof value === 'string' ? jsonBytes(value) : bytesOf(JSON.stringify(value))
      expect(sent, name).toBeLessThanOrEqual(cap)
    }
    expect(jsonBytes(body.abstract)).toBeGreaterThanOrEqual(500)
    expect(body.abstract.length).toBeLessThanOrEqual(CARD_ABSTRACT_CHARS)
  })

  it('states its budgets as the contract does, and fixes them', () => {
    // These are promises to scripts already rezzed: a later node keeps them.
    expect({ CARD_BUDGET, PAGE_BUDGET, TAGS_BUDGET, TAGS_MAX }).toEqual({
      CARD_BUDGET: 2048, PAGE_BUDGET: 1024, TAGS_BUDGET: 2048, TAGS_MAX: 30,
    })
  })

  it('leaves the abstract room by the sum of the other caps', () => {
    const fixed = byteLength(JSON.parse(CARD_SKELETON))
    const caps = Object.values(CARD_CAPS).reduce((a, b) => a + b, 0)
    // At least 500 bytes of abstract on any card: 724 in fact.
    expect(CARD_BUDGET - fixed - caps).toBeGreaterThanOrEqual(500)
  })

  it('is a 404 in the node\'s envelope for a dataset that is not public', async () => {
    const sqlite = setup([
      { id: ULID(1), visibility: 'private' },
      { id: ULID(2), published: false },
      { id: ULID(3), hidden: true },
      { id: ULID(4), retracted: true },
    ])
    for (const id of [ULID(1), ULID(2), ULID(3), ULID(4), ULID(9), 'not-a-ulid!']) {
      const { status, body, res } = await card(sqlite, id)
      expect(status, id).toBe(404)
      expect(body, id).toEqual({ error: 'not_found', message: 'No such dataset.' })
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    }
  })

  it('is as current as the record, whatever the list says', async () => {
    const sqlite = setup([{ id: ULID(1) }])
    await page(sqlite)
    seed(sqlite, [{ id: ULID(2), title: 'Just published' }])
    const { status, body } = await card(sqlite, ULID(2))
    expect(status).toBe(200)
    expect(body.title).toBe('Just published')
    // And a retraction is a 404 at once, though the list still holds it.
    sqlite.prepare('UPDATE datasets SET retracted_at = ? WHERE id = ?').run(TS, ULID(1))
    expect((await card(sqlite, ULID(1))).status).toBe(404)
  })

  it('answers a failure in the node\'s envelope, never kept', async () => {
    const { status, body, res } = await call<{ error: string }>(getCard as never, null, `/api/exhibit/v1/datasets/${ULID(1)}`, {
      params: { id: ULID(1) }, env: { CATALOG_DB: BROKEN_DB },
    })
    expect(status).toBe(503)
    expect(body).toEqual({ error: 'unavailable', message: 'The node could not answer just now. Try again shortly.' })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('GET /api/exhibit/v1/datasets, a page of the menu', () => {
  it('has exactly the contract\'s fields, with their types', async () => {
    const sqlite = setup([{ id: ULID(1) }])
    const { status, body } = await page(sqlite)
    expect(status).toBe(200)
    expect(Object.keys(body)).toEqual(['total', 'offset', 'limit', 'tag', 'list', 'datasets'])
    expect(body).toEqual({
      total: 1, offset: 0, limit: 9, tag: '', list: listHash([ULID(1)]),
      datasets: [{ id: ULID(1), title: `Title ${ULID(1)}` }],
    })
    expect(body.list).toMatch(/^[0-9a-f]{8}$/)
  })

  it('names the list a page came from, the same on every page of it, and new when its ids change', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: ULID(i + 1), title: `T${String(i).padStart(2, '0')}`, tags: i < 4 ? ['Air'] : [] }))
    let sqlite = setup(rows)
    const first = (await page(sqlite)).body
    // Every page of one list, past the end included, and the ids of every
    // dataset that matched, in order, not only the page's.
    expect((await page(sqlite, '?offset=9')).body.list).toBe(first.list)
    expect((await page(sqlite, '?offset=50')).body.list).toBe(first.list)
    expect(first.list).toBe(listHash(rows.map(r => r.id)))
    // Each tag is a list of its own.
    expect((await page(sqlite, '?tag=Air')).body.list).toBe(listHash(rows.slice(0, 4).map(r => r.id)))
    // A title that changes without moving its dataset changes nothing.
    sqlite = setup(rows.map((r, i) => (i === 3 ? { ...r, title: 'T03 again' } : r)))
    resetExhibitListForTests()
    expect((await page(sqlite)).body.list).toBe(first.list)
    // A dataset gone, or one that moved, makes a new list.
    sqlite = setup(rows.map((r, i) => (i === 3 ? { ...r, retracted: true } : r)))
    resetExhibitListForTests()
    expect((await page(sqlite)).body.list).not.toBe(first.list)
    sqlite = setup(rows.map((r, i) => (i === 11 ? { ...r, weight: 5 } : r)))
    resetExhibitListForTests()
    expect((await page(sqlite)).body.list).not.toBe(first.list)
    // So does a retitle that moves its dataset, since the title orders them.
    sqlite = setup(rows.map((r, i) => (i === 3 ? { ...r, title: 'A00' } : r)))
    resetExhibitListForTests()
    expect((await page(sqlite)).body.list).not.toBe(first.list)
  })

  it('names the list by what matched alone, not by how it was paged or by rows the page leaves out', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: ULID(i + 1), title: `T${String(i).padStart(2, '0')}`, tags: ['Air'] }))
    let sqlite = setup(rows)
    const air = (await page(sqlite, '?tag=Air')).body.list
    for (const query of ['?tag=Air&limit=1', '?tag=Air&limit=4&offset=3', '?tag=Air&offset=99']) {
      expect((await page(sqlite, query)).body.list, query).toBe(air)
    }
    // Rows a page never lists: a tour, a peer's, one whose reference and
    // format disagree, one not public, and an id longer than a ULID.
    sqlite = setup([
      ...rows,
      { id: ULID(20), title: 'A tour', format: 'tour/json', data_ref: 'r2:t.json', tags: ['Air'] },
      { id: ULID(21), title: 'A peer', data_ref: 'peer:NODE1/x', tags: ['Air'] },
      { id: ULID(22), title: 'A mismatch', format: 'image/png', data_ref: 'vimeo:2', tags: ['Air'] },
      { id: ULID(23), title: 'Private', visibility: 'private', tags: ['Air'] },
      { id: `X${'1'.repeat(30)}`, title: 'Long id', tags: ['Air'] },
    ])
    resetExhibitListForTests()
    expect((await page(sqlite, '?tag=Air')).body.list).toBe(air)
    // A tag joining a dataset changes that tag's list and no other's.
    sqlite = setup([...rows.map((r, i) => (i < 2 ? { ...r, tags: ['Air', 'Water'] } : r)), { id: ULID(30), title: 'W', tags: ['Water'] }])
    resetExhibitListForTests()
    const water = (await page(sqlite, '?tag=Water')).body.list
    sqlite = setup([...rows.map((r, i) => (i < 3 ? { ...r, tags: ['Air', 'Water'] } : r)), { id: ULID(30), title: 'W', tags: ['Water'] }])
    resetExhibitListForTests()
    expect((await page(sqlite, '?tag=Water')).body.list).not.toBe(water)
    expect((await page(sqlite, '?tag=Air')).body.list).toBe(air)
  })

  it('computes the list as it always has, so a change to it is deliberate', () => {
    // FNV-1a over the ids joined by line breaks, as eight lowercase hex
    // digits, checked against an independent implementation. A reader
    // never computes it, but a change still costs every visitor paging
    // at the time a notice that a dataset may have moved.
    expect(listHash([])).toBe('811c9dc5')
    expect(listHash(['01KQG611HF8YXJNRBEHT0757KT', '01KQG65ZW1JC7M27EQ1CYD8YZ7'])).toBe('f0832b8f')
    expect(listHash(['01KQG65ZW1JC7M27EQ1CYD8YZ7', '01KQG611HF8YXJNRBEHT0757KT'])).toBe('ae28ed5b')
  })

  it('lists only what the output page can show, in the order browse lists it', async () => {
    const sqlite = setup([
      { id: ULID(1), title: 'banana', weight: 0 },
      { id: ULID(2), title: 'Apple', weight: 0 },
      { id: ULID(3), title: 'Zebra', weight: 10 },
      { id: ULID(4), title: 'apple', weight: 0 },
      { id: ULID(5), title: 'A tour', format: 'tour/json', data_ref: 'r2:t.json' },
      { id: ULID(6), title: 'A peer', data_ref: 'peer:NODE1/x' },
      { id: ULID(7), title: 'A mismatch', format: 'image/png', data_ref: 'vimeo:2' },
      { id: ULID(8), title: 'Private', visibility: 'private' },
      { id: ULID(9), title: 'cherry', format: 'image/png', data_ref: 'url:https://x/y.png' },
    ])
    const { body } = await page(sqlite)
    // Weight first, then the title as localeCompare sorts it, which puts
    // "apple" before "Apple": by id, or by SQLite's NOCASE with the id
    // breaking the tie, "Apple" would come first.
    expect(body.datasets.map(d => d.id)).toEqual([ULID(3), ULID(4), ULID(2), ULID(1), ULID(9)])
    expect(body.total).toBe(5)
  })

  it('matches a tag exactly in its canonical form, and echoes it', async () => {
    const sqlite = setup([
      { id: ULID(1), tags: ['Water'] },
      { id: ULID(2), tags: ['water'] },
      { id: ULID(3), tags: ['Water '] },
    ])
    const { body } = await page(sqlite, '?tag=Water')
    expect(body.tag).toBe('Water')
    expect(body.datasets.map(d => d.id).sort()).toEqual([ULID(1), ULID(3)])
    // The echo is the canonical form, the one that matched.
    expect((await page(sqlite, '?tag=%20Water%20')).body).toMatchObject({ tag: 'Water', total: 2 })
  })

  it('reads an empty parameter as a missing one, and answers past the end with nothing', async () => {
    const sqlite = setup([{ id: ULID(1), tags: ['Air'] }])
    expect((await page(sqlite, '?tag=&offset=&limit=')).body.total).toBe(1)
    expect((await page(sqlite, '?offset=5')).body).toMatchObject({ total: 1, offset: 5, datasets: [] })
    expect((await page(sqlite, '?tag=Nothing')).body).toMatchObject({ total: 0, datasets: [] })
  })

  it('refuses a malformed parameter with a 400 in the node\'s envelope, never kept', async () => {
    const sqlite = setup([{ id: ULID(1) }])
    const queries = [
      '?limit=10', '?limit=0', '?offset=-1', '?offset=1e3', '?offset=+1', '?limit=0x9', `?tag=${'x'.repeat(201)}`,
      // A tag longer than the tags read ever lists: a 400, not a page
      // that would echo nothing and look unfiltered.
      `?tag=${'x'.repeat(TAG_CAP + 1)}`, `?tag=${encodeURIComponent('海'.repeat(14))}`,
      // Nothing but spaces or a control character: not the whole menu.
      '?tag=%20%20', '?tag=%01',
    ]
    for (const query of queries) {
      const { status, body, res } = await page(sqlite, query)
      expect(status, query).toBe(400)
      expect(Object.keys(body), query).toEqual(['error', 'message'])
      expect((body as unknown as { error: string }).error).toBe('invalid_request')
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    }
  })

  it('takes a repeated key\'s first value and ignores a key it does not know', async () => {
    // So a query a later script writes still reads on this node.
    const sqlite = setup(Array.from({ length: 12 }, (_, i) => ({ id: ULID(i + 1) })))
    expect((await page(sqlite, '?limit=2&limit=500')).body.limit).toBe(2)
    expect((await page(sqlite, '?lang=fr&limit=3&sort=new')).body.datasets).toHaveLength(3)
    expect((await page(sqlite, '?limit=0004')).body.limit).toBe(4)
  })

  it('pages nine at a time, and leaves out a row whose id is longer than a ULID', async () => {
    const sqlite = setup([
      ...Array.from({ length: 12 }, (_, i) => ({ id: ULID(i + 1), title: `T${String(i).padStart(2, '0')}` })),
      { id: `X${'1'.repeat(30)}`, title: 'Long id' },
    ])
    const first = await page(sqlite)
    expect(first.body.total).toBe(12)
    expect(first.body.datasets).toHaveLength(9)
    const second = await page(sqlite, '?offset=9')
    expect(second.body.datasets.map(d => d.title)).toEqual(['T09', 'T10', 'T11'])
  })

  it('keeps its budget with the worst titles the node accepts', async () => {
    const sqlite = setup(Array.from({ length: 9 }, (_, i) => ({ id: ULID(i + 1), title: '"\\海'.repeat(70), tags: ['t'.repeat(40)] })))
    const { text, body } = await page(sqlite, `?tag=${'t'.repeat(40)}&offset=0`)
    expect(body.datasets).toHaveLength(9)
    expect(bytesOf(text)).toBeLessThanOrEqual(1024)
    for (const d of body.datasets) expect(jsonBytes(d.title)).toBeLessThanOrEqual(PAGE_CAPS.title)
  })

  it('fits its budget by its caps alone', () => {
    // Every field at its cap: the largest numbers, the longest tag, and
    // nine ids and titles of the most bytes allowed.
    const n = Number('9'.repeat(PAGE_CAPS.number))
    const worst: ExhibitPage = {
      total: n, offset: n, limit: n, tag: 'x'.repeat(PAGE_CAPS.tag), list: 'x'.repeat(PAGE_CAPS.list),
      datasets: Array.from({ length: 9 }, () => ({ id: 'x'.repeat(PAGE_CAPS.id), title: 'x'.repeat(PAGE_CAPS.title) })),
    }
    expect(byteLength(worst)).toBeLessThanOrEqual(PAGE_BUDGET)
    // As the plan counts it: 982 bytes, leaving 42 for any later field.
    expect(byteLength(worst)).toBe(982)
    // `list` spends the 18 bytes the API review held back for it before
    // any script read a page.
    expect(Buffer.byteLength(',"list":""') + PAGE_CAPS.list).toBe(18)
    expect(listHash([])).toHaveLength(PAGE_CAPS.list)
    expect(listHash(['x'.repeat(26)])).toHaveLength(PAGE_CAPS.list)
    expect(String(PAGE_MAX_OFFSET).length).toBeLessThanOrEqual(PAGE_CAPS.number)
  })

  it('answers a failure in the node\'s envelope', async () => {
    const { status, body } = await call<{ error: string }>(getPage as never, null, '/api/exhibit/v1/datasets', {
      env: { CATALOG_DB: BROKEN_DB },
    })
    expect(status).toBe(503)
    expect(body.error).toBe('unavailable')
  })
})

describe('GET /api/exhibit/v1/tags, the categories', () => {
  it('has exactly the contract\'s fields, most common first', async () => {
    const sqlite = setup([
      { id: ULID(1), tags: ['Water', 'Air'] },
      { id: ULID(2), tags: ['Water'] },
      { id: ULID(3), tags: ['Space'], format: 'tour/json', data_ref: 'r2:t.json' },
      { id: ULID(4), tags: ['Land'], format: 'image/png', data_ref: 'url:https://x/y.png' },
    ])
    const { body } = await tags(sqlite)
    expect(Object.keys(body)).toEqual(['tags', 'more'])
    expect(body).toEqual({ tags: [{ tag: 'Water', count: 2 }, { tag: 'Air', count: 1 }, { tag: 'Land', count: 1 }], more: false })
  })

  it('lists no tag of a dataset that is not public', async () => {
    const sqlite = setup([
      { id: ULID(1), tags: ['Water'] },
      { id: ULID(2), tags: ['Secret'], hidden: true },
      { id: ULID(3), tags: ['Draft'], published: false },
      { id: ULID(4), tags: ['Private'], visibility: 'private' },
      { id: ULID(5), tags: ['Withdrawn'], retracted: true },
    ])
    expect((await tags(sqlite)).body.tags.map(t => t.tag)).toEqual(['Water'])
    expect((await page(sqlite, '?tag=Secret')).body.total).toBe(0)
  })

  it('counts each tag as its page totals it', async () => {
    const sqlite = setup([
      { id: ULID(1), tags: ['Water', 'Air'] },
      { id: ULID(2), tags: ['Water '] },
      { id: ULID(3), tags: ['Ne\u0301vé'] },
      { id: ULID(4), tags: ['Névé'] },
    ])
    const { body } = await tags(sqlite)
    for (const { tag, count } of body.tags) {
      expect((await page(sqlite, `?tag=${encodeURIComponent(tag)}`)).body.total, tag).toBe(count)
    }
    expect(body.tags.find(t => t.tag === 'Névé')?.count).toBe(2)
  })

  it('never cuts a tag, keeps the most common, and leaves out one it can\'t hand a script', async () => {
    const rows: Row[] = []
    for (let i = 0; i < 40; i++) {
      // Tag i is on 40 - i datasets, so they rank in order: 38 bytes each.
      const tag = `${String(i).padStart(2, '0')}${'海'.repeat(12)}`
      for (let j = 0; j < 40 - i; j++) rows.push({ id: ULID(i * 100 + j), tags: [tag] })
    }
    // Over the cap by one byte, and a character beyond the BMP.
    rows.push({ id: ULID(9998), tags: ['x'.repeat(TAG_CAP + 1)] })
    rows.push({ id: ULID(9999), tags: ['Rain 🌧'] })
    const sqlite = setup(rows)
    const { text, body } = await tags(sqlite)
    expect(bytesOf(text)).toBeLessThanOrEqual(2048)
    expect(body.more).toBe(true)
    expect(body.tags).toHaveLength(TAGS_MAX)
    expect(body.tags.map(t => t.tag.slice(0, 2))).toEqual(body.tags.map((_, i) => String(i).padStart(2, '0')))
    for (const t of body.tags) expect(t.tag.endsWith('海'.repeat(12))).toBe(true)
    expect(body.tags.some(t => t.tag.startsWith('x') || t.tag.startsWith('Rain'))).toBe(false)
  })

  it('lists a tag in the form a page matches, a control character between letter and accent included', async () => {
    const sqlite = setup([{ id: ULID(1), tags: ['Ne\u0001\u0301ve'] }])
    const listed = (await tags(sqlite)).body.tags
    expect(listed).toEqual([{ tag: 'Néve', count: 1 }])
    expect((await page(sqlite, `?tag=${encodeURIComponent(listed[0].tag)}`)).body.total).toBe(1)
  })

  it('drops whole tags until the reply fits, measured with the longer value of more', () => {
    // Caps keep a real list from needing it, so it is driven directly: 29
    // tags of 46 characters and one of 62 come to 2,049 bytes with
    // `more: false` and 2,048 with `true`.
    const tagsOf = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, '0')}${'t'.repeat(i === 29 ? 60 : 44)}`)
    const list = tagsOf.map((tag, i) => ({
      row: { id: ULID(i + 1) }, kind: 'video', showable: true, tags: [tag],
    })) as unknown as Parameters<typeof buildTags>[0]
    expect(byteLength({ tags: tagsOf.map(tag => ({ tag, count: 1 })), more: false })).toBe(2049)
    const got = buildTags(list)
    expect(byteLength(got)).toBeLessThanOrEqual(TAGS_BUDGET)
    expect(got).toMatchObject({ more: true })
    expect(got.tags).toHaveLength(29)
  })

  it('leaves out a tag over the cap or beyond the BMP, which a page could not be asked for', async () => {
    const sqlite = setup([{ id: ULID(1), tags: ['Water', 'x'.repeat(TAG_CAP + 1), 'Rain 🌧'] }])
    expect((await tags(sqlite)).body.tags.map(t => t.tag)).toEqual(['Water'])
  })

  it('fits its budget by its caps alone, whichever value more ends as', () => {
    // Thirty tags of the most bytes allowed, each on a million datasets
    // less one: the reply fits without dropping any.
    const worst = (more: boolean): ExhibitTags => ({
      tags: Array.from({ length: TAGS_MAX }, () => ({ tag: 'x'.repeat(TAG_CAP), count: 999_999 })),
      more,
    })
    expect(byteLength(worst(false))).toBeLessThanOrEqual(TAGS_BUDGET)
    expect(byteLength(worst(false))).toBeGreaterThan(byteLength(worst(true)))
  })

  it('answers a failure in the node\'s envelope', async () => {
    const { status, body } = await call<{ error: string }>(getTags as never, null, '/api/exhibit/v1/tags', {
      env: { CATALOG_DB: BROKEN_DB },
    })
    expect(status).toBe(503)
    expect(body.error).toBe('unavailable')
  })
})

/** A D1 that counts its reads of the datasets table and can be made to fail. */
function counted(sqlite: Database.Database) {
  const d1 = asD1(sqlite)
  const state = { reads: 0, failing: false }
  const db = {
    prepare(sql: string) {
      if (state.failing) throw new Error('D1 is down')
      if (/FROM datasets\b/.test(sql)) state.reads++
      return d1.prepare(sql)
    },
  } as unknown as D1Database
  return { db, state }
}

describe('the list behind them', () => {
  it('is read again only once it is a minute old', async () => {
    const sqlite = setup([{ id: ULID(1) }])
    const db = asD1(sqlite)
    const t0 = Date.now()
    expect(await exhibitList(db, t0)).toHaveLength(1)
    seed(sqlite, [{ id: ULID(2) }])
    expect(await exhibitList(db, t0 + LIST_TTL_MS - 1)).toHaveLength(1)
    expect(await exhibitList(db, t0 + LIST_TTL_MS)).toHaveLength(2)
  })

  it('shares only a list already read: requests that miss together each read', async () => {
    // A Worker can't hand one request's I/O to another, so a read in
    // flight is never shared (functions/api/_lib/orbit-gate.ts).
    const { db, state } = counted(setup([{ id: ULID(1) }]))
    const t0 = Date.now()
    const [a, b] = await Promise.all([exhibitList(db, t0), exhibitList(db, t0)])
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(state.reads).toBe(2)
    await exhibitList(db, t0 + 1)
    expect(state.reads).toBe(2)
  })

  it('keeps the last good list through a failed read, trying again a minute later', async () => {
    const { db, state } = counted(setup([{ id: ULID(1) }]))
    const t0 = Date.now()
    await exhibitList(db, t0)
    state.failing = true
    expect(await exhibitList(db, t0 + LIST_TTL_MS)).toHaveLength(1)
    // No read is tried again for another minute.
    state.failing = false
    const reads = state.reads
    expect(await exhibitList(db, t0 + LIST_TTL_MS + 1)).toHaveLength(1)
    expect(state.reads).toBe(reads)
    expect(await exhibitList(db, t0 + 2 * LIST_TTL_MS)).toHaveLength(1)
    expect(state.reads).toBe(reads + 1)
  })

  it('fails, and is tried again, once the last good list is too old or there is none', async () => {
    const { db, state } = counted(setup([{ id: ULID(1) }]))
    const t0 = Date.now()
    state.failing = true
    await expect(exhibitList(db, t0)).rejects.toThrow('D1 is down')
    state.failing = false
    expect(await exhibitList(db, t0 + 1)).toHaveLength(1)
    state.failing = true
    await expect(exhibitList(db, t0 + 1 + LIST_STALE_MS)).rejects.toThrow('D1 is down')
  })
})

describe('HEAD', () => {
  it('is answered as GET is, on every read', () => {
    expect(headCard).toBe(getCard)
    expect(headPage).toBe(getPage)
    expect(headTags).toBe(getTags)
  })
})

describe('anything else under /api/exhibit/', () => {
  const other = (method: string) =>
    call<{ error: string; message: string }>(noSuchRoute as never, null, '/api/exhibit/nope', { method })

  it('is a JSON 404 the script can tell from the app\'s page', async () => {
    for (const method of ['GET', 'HEAD']) {
      const res = await (noSuchRoute as never as (ctx: unknown) => Promise<Response>)(
        makeCtx({ url: 'https://test.local/api/exhibit/nope', env: {}, method }),
      )
      expect(res.status, method).toBe(404)
    }
    const { status, body, res } = await other('GET')
    expect(status).toBe(404)
    expect(body).toEqual({ error: 'no_such_route', message: 'This node has no such exhibit read.' })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('is a 405 for another method on a real read, which falls through to here', async () => {
    for (const path of ['/api/exhibit/v1/tags', '/api/exhibit/v1/datasets', `/api/exhibit/v1/datasets/${ULID(1)}`, '/api/exhibit/V1/Tags/']) {
      const { status, body, res } = await call<{ error: string }>(noSuchRoute as never, null, path, { method: 'POST' })
      expect(status, path).toBe(405)
      expect(body.error).toBe('method_not_allowed')
      expect(res.headers.get('Allow')).toBe('GET, HEAD')
    }
  })

  it('is no_such_route for every method on a path the node lacks', async () => {
    // So a later script's POST to a read this node doesn't have is told so.
    for (const path of ['/api/exhibit/nope', '/api/exhibit/v2/datasets', '/api/exhibit/v1/datasets/a/b']) {
      const { status, body } = await call<{ error: string }>(noSuchRoute as never, null, path, { method: 'POST' })
      expect(status, path).toBe(404)
      expect(body.error).toBe('no_such_route')
    }
  })
})

describe('a missing database binding', () => {
  it('is a 503 on every read', async () => {
    for (const [handler, path] of [[getPage, '/api/exhibit/v1/datasets'], [getTags, '/api/exhibit/v1/tags']] as const) {
      const { status } = await call(handler as never, null, path)
      expect(status).toBe(503)
    }
    const { status } = await call(getCard as never, null, `/api/exhibit/v1/datasets/${ULID(1)}`, { params: { id: ULID(1) } })
    expect(status).toBe(503)
  })
})
