/**
 * Unit tests for the generic Video Sitemap parser. Fixtures mirror the
 * real NOAA Ocean Today feed shape — including its dirty data (a stray
 * trailing quote on every `content_loc`, doubled slashes in thumbnails,
 * junk tags: bare years and title echoes) — plus the standard
 * sitemap-index shape a multi-file sitemap uses.
 */

import { describe, it, expect } from 'vitest'
import {
  parseVideoSitemap,
  countSitemapEntries,
  isSitemapIndex,
  parseSitemapIndex,
  buildVideoEmbeddingText,
} from './video-sitemap'

// Mirrors the Ocean Today shape: content_loc has a trailing `"`,
// thumbnail has a doubled slash, tags include the title echo + a bare
// year, category is the generic catch-all "Ocean".
const OCEAN_TODAY = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
  <url>
    <loc>https://oceantoday.noaa.gov/blueiq/blueiq-ep1.html</loc>
    <video:video>
      <video:thumbnail_loc>https://oceantoday.noaa.gov//blueiq/BlueIQ_Ep1.jpg</video:thumbnail_loc>
      <video:title>Blue IQ: Not Sure? Stay on Shore!</video:title>
      <video:description>Discover why knowing what you don&#8217;t know can make you the smartest &mdash; and safest &mdash; person on the shore. </video:description>
      <video:content_loc>https://cdn.oceanservice.noaa.gov/oceantodayprod/media/blueiq/1701_BlueIQ_Ep01_0625_720p.mp4"</video:content_loc>
      <video:duration>119</video:duration>
      <video:publication_date>2025-06-25</video:publication_date>
      <video:tag>Blue IQ: Not Sure? Stay on Shore!</video:tag>
      <video:tag>Beach Safety</video:tag>
      <video:tag>2025</video:tag>
      <video:tag>Beach Safety</video:tag>
      <video:category>Ocean</video:category>
      <video:requires_subscription>no</video:requires_subscription>
    </video:video>
  </url>
  <url>
    <loc>https://oceantoday.noaa.gov/coral/coral-bleaching.html</loc>
    <video:video>
      <video:thumbnail_loc>https://oceantoday.noaa.gov/coral/bleach.jpg</video:thumbnail_loc>
      <video:title>Coral Bleaching Explained</video:title>
      <video:description>Warming seas push corals past their limit.</video:description>
      <video:content_loc>https://cdn.oceanservice.noaa.gov/oceantodayprod/media/coral/bleach_720p.mp4</video:content_loc>
      <video:duration>210</video:duration>
      <video:publication_date>2024-08-01</video:publication_date>
      <video:tag>Coral</video:tag>
      <video:tag>Climate</video:tag>
      <video:category>Ocean Life</video:category>
    </video:video>
  </url>
  <url>
    <loc>https://oceantoday.noaa.gov/broken.html</loc>
    <video:video>
      <video:title>No content URL — skipped</video:title>
    </video:video>
  </url>
  <url>
    <loc>https://oceantoday.noaa.gov/nonhttp.html</loc>
    <video:video>
      <video:title>Non-http content — skipped</video:title>
      <video:content_loc>ftp://oceantoday.noaa.gov/file.mp4</video:content_loc>
    </video:video>
  </url>
</urlset>`

const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.gov/videos-1.xml</loc></sitemap>
  <sitemap><loc>https://example.gov/videos-2.xml</loc></sitemap>
  <sitemap><loc>https://example.gov/videos-1.xml</loc></sitemap>
</sitemapindex>`

describe('parseVideoSitemap', () => {
  it('parses a well-formed entry with all fields, sanitizing dirty URLs', () => {
    const videos = parseVideoSitemap(OCEAN_TODAY)
    expect(videos).toHaveLength(2)
    const v = videos[0]
    expect(v.title).toBe('Blue IQ: Not Sure? Stay on Shore!')
    expect(v.pageUrl).toBe('https://oceantoday.noaa.gov/blueiq/blueiq-ep1.html')
    expect(v.externalId).toBe(v.pageUrl)
    // Trailing quote stripped from content_loc.
    expect(v.contentUrl).toBe(
      'https://cdn.oceanservice.noaa.gov/oceantodayprod/media/blueiq/1701_BlueIQ_Ep01_0625_720p.mp4',
    )
    expect(v.contentHost).toBe('cdn.oceanservice.noaa.gov')
    // Doubled slash collapsed in the thumbnail path.
    expect(v.thumbnailUrl).toBe('https://oceantoday.noaa.gov/blueiq/BlueIQ_Ep1.jpg')
    expect(v.durationSec).toBe(119)
    expect(v.publishedAt).toBe('2025-06-25T00:00:00.000Z')
    // Entities decoded in the description.
    expect(v.description).toContain('don’t')
    expect(v.description).toContain('—')
  })

  it('cleans tags: drops title echo, bare years, and duplicates', () => {
    const [v] = parseVideoSitemap(OCEAN_TODAY)
    expect(v.tags).toEqual(['Beach Safety'])
  })

  it('drops the generic "Ocean" category but keeps a specific one', () => {
    const [blue, coral] = parseVideoSitemap(OCEAN_TODAY)
    expect(blue.category).toBeUndefined()
    expect(coral.category).toBe('Ocean Life')
  })

  it('skips entries missing a content URL or with a non-http scheme', () => {
    const videos = parseVideoSitemap(OCEAN_TODAY)
    expect(videos.map(v => v.title)).not.toContain('No content URL — skipped')
    expect(videos.map(v => v.title)).not.toContain('Non-http content — skipped')
  })

  it('is tolerant of junk input', () => {
    expect(parseVideoSitemap('')).toEqual([])
    expect(parseVideoSitemap('<html>not a sitemap</html>')).toEqual([])
    expect(parseVideoSitemap(SITEMAP_INDEX)).toEqual([])
  })

  it('dedupes entries that repeat the same page URL', () => {
    const dup = OCEAN_TODAY.replace('</urlset>', `
      <url><loc>https://oceantoday.noaa.gov/blueiq/blueiq-ep1.html</loc>
      <video:video><video:title>dup</video:title>
      <video:content_loc>https://cdn.oceanservice.noaa.gov/x.mp4</video:content_loc>
      </video:video></url></urlset>`)
    expect(parseVideoSitemap(dup)).toHaveLength(2)
  })
})

describe('countSitemapEntries', () => {
  it('counts raw <url> entries before skip rules', () => {
    expect(countSitemapEntries(OCEAN_TODAY)).toBe(4)
    expect(countSitemapEntries('')).toBe(0)
  })
})

describe('sitemap index', () => {
  it('detects a sitemapindex document', () => {
    expect(isSitemapIndex(SITEMAP_INDEX)).toBe(true)
    expect(isSitemapIndex(OCEAN_TODAY)).toBe(false)
  })

  it('extracts deduped child sitemap URLs', () => {
    expect(parseSitemapIndex(SITEMAP_INDEX)).toEqual([
      'https://example.gov/videos-1.xml',
      'https://example.gov/videos-2.xml',
    ])
    expect(parseSitemapIndex(OCEAN_TODAY)).toEqual([])
  })
})

describe('buildVideoEmbeddingText', () => {
  it('joins title, description, category and tags, skipping empties', () => {
    const text = buildVideoEmbeddingText({
      title: 'Coral Bleaching Explained',
      description: 'Warming seas push corals past their limit.',
      category: 'Ocean Life',
      tags: ['Coral', 'Climate'],
    })
    expect(text).toBe('Coral Bleaching Explained\nWarming seas push corals past their limit.\nOcean Life\nCoral Climate')
  })

  it('returns empty string when there is nothing to embed', () => {
    expect(buildVideoEmbeddingText({})).toBe('')
  })
})
