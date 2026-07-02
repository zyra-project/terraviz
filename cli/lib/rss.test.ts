/**
 * Unit tests for the generic RSS 2.0 / Atom → current-event mapper.
 * Fixtures mirror the real feed shapes the preset catalog points at:
 * a news-style RSS 2.0 channel (BBC/Guardian shape), a GeoRSS-bearing
 * Atom feed (USGS earthquakes shape), and the W3C geo pair (GDACS
 * shape).
 */

import { describe, it, expect } from 'vitest'
import { parseRssFeed, mapRssFeed, RSS_MAX_ITEMS } from './rss'

const RSS_NEWS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Example Environment</title>
  <item>
    <title>Storm batters the coast &amp; floods towns</title>
    <link>https://news.example.org/storm-coast</link>
    <guid isPermaLink="false">news-guid-1</guid>
    <description><![CDATA[<p>A <b>powerful storm</b> hit the coast&hellip; officials said.</p>]]></description>
    <pubDate>Tue, 30 Jun 2026 08:15:00 GMT</pubDate>
    <category>Weather</category>
    <category>Flooding</category>
  </item>
  <item>
    <title>No link — skipped</title>
    <description>Item without a link cannot be cited.</description>
  </item>
  <item>
    <title>FTP link — skipped</title>
    <link>ftp://news.example.org/file</link>
  </item>
</channel></rss>`

const ATOM_QUAKES = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:georss="http://www.georss.org/georss">
  <title>USGS-style quakes</title>
  <entry>
    <id>urn:earthquake:us7000abcd</id>
    <title>M 5.2 - 40 km SW of Example Town</title>
    <link rel="alternate" type="text/html" href="https://quakes.example.gov/us7000abcd"/>
    <updated>2026-06-29T21:07:00Z</updated>
    <summary type="html">&lt;p&gt;Depth: 10 km&lt;/p&gt;</summary>
    <georss:point>38.297 -122.463</georss:point>
    <category term="Past Day" label="Age"/>
  </entry>
</feed>`

const RSS_GEO_PAIR = `<rss version="2.0" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#"><channel>
  <item>
    <title>Flood alert — Example Basin</title>
    <link>https://alerts.example.org/flood-1</link>
    <geo:lat>-12.5</geo:lat>
    <geo:long>130.9</geo:long>
  </item>
</channel></rss>`

describe('parseRssFeed', () => {
  it('parses an RSS 2.0 item — plain-text summary, ISO date, keywords', () => {
    const items = parseRssFeed(RSS_NEWS)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'news-guid-1',
      title: 'Storm batters the coast & floods towns',
      link: 'https://news.example.org/storm-coast',
      publishedAt: '2026-06-30T08:15:00.000Z',
      keywords: ['Weather', 'Flooding'],
    })
    // CDATA unwrapped, HTML stripped, entities decoded.
    expect(items[0].summary).toBe('A powerful storm hit the coast… officials said.')
  })

  it('skips items without a title or an http(s) link', () => {
    const items = parseRssFeed(RSS_NEWS)
    expect(items.map(i => i.title)).toEqual(['Storm batters the coast & floods towns'])
  })

  it('parses an Atom entry with a GeoRSS point and category terms', () => {
    const items = parseRssFeed(ATOM_QUAKES)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'urn:earthquake:us7000abcd',
      title: 'M 5.2 - 40 km SW of Example Town',
      link: 'https://quakes.example.gov/us7000abcd',
      publishedAt: '2026-06-29T21:07:00.000Z',
      point: { lat: 38.297, lon: -122.463 },
      keywords: ['Past Day'],
    })
    expect(items[0].summary).toBe('Depth: 10 km')
  })

  it('parses the W3C geo:lat/geo:long pair', () => {
    const items = parseRssFeed(RSS_GEO_PAIR)
    expect(items[0].point).toEqual({ lat: -12.5, lon: 130.9 })
  })

  it('falls back to the link as the id when there is no guid', () => {
    const xml = `<rss><channel><item><title>T</title><link>https://x.example/a</link></item></channel></rss>`
    expect(parseRssFeed(xml)[0].id).toBe('https://x.example/a')
  })

  it('returns [] for garbage / empty input, never throws', () => {
    expect(parseRssFeed('')).toEqual([])
    expect(parseRssFeed('not xml at all')).toEqual([])
    expect(parseRssFeed('<html><body>a web page</body></html>')).toEqual([])
  })
})

describe('mapRssFeed', () => {
  const OPTS = { feedId: 'FEED_TEST_01', sourceName: 'Example Environment' }

  it('maps items to create bodies with the connector as provenance', () => {
    const [body] = mapRssFeed(RSS_NEWS, OPTS)
    expect(body).toMatchObject({
      title: 'Storm batters the coast & floods towns',
      feedId: 'FEED_TEST_01',
      externalId: 'news-guid-1',
      occurredStart: '2026-06-30T08:15:00.000Z',
      keywords: ['Weather', 'Flooding'],
      source: {
        name: 'Example Environment',
        url: 'https://news.example.org/storm-coast',
        publishedAt: '2026-06-30T08:15:00.000Z',
      },
    })
    expect(body.geometry).toBeUndefined() // plain news: slice C's AI gap
  })

  it('carries GeoRSS geometry through as an event point', () => {
    const [body] = mapRssFeed(ATOM_QUAKES, OPTS)
    expect(body.geometry).toEqual({ point: { lat: 38.297, lon: -122.463 } })
  })

  it('truncates a runaway summary and caps the item count', () => {
    const long = 'x'.repeat(2000)
    const many = Array.from(
      { length: RSS_MAX_ITEMS + 10 },
      (_, i) =>
        `<item><title>Item ${i}</title><link>https://x.example/${i}</link><description>${long}</description></item>`,
    ).join('')
    const bodies = mapRssFeed(`<rss><channel>${many}</channel></rss>`, OPTS)
    expect(bodies).toHaveLength(RSS_MAX_ITEMS)
    expect(bodies[0].summary!.length).toBe(500)
  })
})
