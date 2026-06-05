/**
 * Tests for downloadService — asset resolution, input shaping, and utilities.
 *
 * The Tauri command wrappers (listDownloads, deleteDownload, etc.) are thin
 * pass-throughs and are not tested here. Focus is on the pure logic:
 * formatBytes, video/image asset resolution, caption URL proxying, and the
 * DownloadInput shape sent to the backend.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  classifySourceOfTruth,
  expandFrameAssets,
  formatBytes,
  isZipDownloadable,
  __test__,
} from './downloadService'
import { proxyCaptionUrl } from '../utils/captionProxy'
import type { Dataset } from '../types'

const { isHttpUrl, extFromUrl, pickBestVideoFile, orderImageCandidates } = __test__

// --- formatBytes ---

describe('formatBytes', () => {
  it('formats 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500 B')
  })

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('2 KB')
  })

  it('formats megabytes with one decimal', () => {
    expect(formatBytes(1048576)).toBe('1.0 MB')
    expect(formatBytes(5.5 * 1024 * 1024)).toBe('5.5 MB')
  })

  it('formats gigabytes with one decimal', () => {
    expect(formatBytes(1073741824)).toBe('1.0 GB')
    expect(formatBytes(2.3 * 1024 * 1024 * 1024)).toBe('2.3 GB')
  })

  it('formats terabytes with one decimal', () => {
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1.0 TB')
  })

  it('clamps to largest unit for huge values', () => {
    const result = formatBytes(Number.MAX_SAFE_INTEGER)
    expect(result).toMatch(/PB$/)
  })
})

// --- Asset resolution logic ---
// These test the internal functions via their module-level behavior.
// We re-implement the pure logic here since the functions are private.

describe('video asset resolution', () => {
  it('picks the highest quality (widest) MP4 from a manifest', () => {
    const files = [
      { quality: '720p', width: 1280, height: 720, size: 50_000_000, type: 'video/mp4', link: 'https://example.com/720.mp4' },
      { quality: '1080p', width: 1920, height: 1080, size: 100_000_000, type: 'video/mp4', link: 'https://example.com/1080.mp4' },
      { quality: '4K', width: 3840, height: 2160, size: 500_000_000, type: 'video/mp4', link: 'https://example.com/4k.mp4' },
      { quality: '480p', width: 854, height: 480, size: 20_000_000, type: 'video/mp4', link: 'https://example.com/480.mp4' },
    ]

    // Same logic as resolveVideoAssets
    const sorted = [...files].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
    const best = sorted[0]

    expect(best.quality).toBe('4K')
    expect(best.link).toBe('https://example.com/4k.mp4')
    expect(best.size).toBe(500_000_000)
  })

  it('handles files with missing width by sorting them last', () => {
    const files = [
      { quality: 'unknown', width: undefined, height: undefined, size: 10_000, type: 'video/mp4', link: 'https://example.com/unknown.mp4' },
      { quality: '720p', width: 1280, height: 720, size: 50_000_000, type: 'video/mp4', link: 'https://example.com/720.mp4' },
    ]

    const sorted = [...files].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
    expect(sorted[0].quality).toBe('720p')
  })
})

describe('image resolution candidate generation', () => {
  it('generates candidates in order: 4096, 2048, original', () => {
    const url = 'https://cdn.example.com/data/seafloor.jpg'
    const ext = url.match(/(\.\w+)$/)
    const base = ext ? url.slice(0, -ext[1].length) : url
    const suffix = ext ? ext[1] : ''

    const candidates = [
      { url: `${base}_4096${suffix}`, filename: `image_4096${suffix}` },
      { url: `${base}_2048${suffix}`, filename: `image_2048${suffix}` },
      { url, filename: `image${suffix}` },
    ]

    expect(candidates[0].url).toBe('https://cdn.example.com/data/seafloor_4096.jpg')
    expect(candidates[0].filename).toBe('image_4096.jpg')
    expect(candidates[1].url).toBe('https://cdn.example.com/data/seafloor_2048.jpg')
    expect(candidates[2].url).toBe(url)
    expect(candidates[2].filename).toBe('image.jpg')
  })

  it('handles URLs with .png extension', () => {
    const url = 'https://cdn.example.com/earth.png'
    const ext = url.match(/(\.\w+)$/)
    const base = ext ? url.slice(0, -ext[1].length) : url
    const suffix = ext ? ext[1] : ''

    expect(`${base}_4096${suffix}`).toBe('https://cdn.example.com/earth_4096.png')
  })

  it('handles URLs with no extension', () => {
    const url = 'https://cdn.example.com/data/noext'
    const ext = url.match(/(\.\w+)$/)
    const base = ext ? url.slice(0, -ext[1].length) : url
    const suffix = ext ? ext[1] : ''

    expect(base).toBe(url)
    expect(suffix).toBe('')
    expect(`${base}_4096${suffix}`).toBe('https://cdn.example.com/data/noext_4096')
  })
})

describe('caption URL proxying', () => {
  it('proxies sos.noaa.gov caption URLs through video-proxy', () => {
    const captionLink = 'https://sos.noaa.gov/media/captions/ocean_acidification.srt'
    expect(proxyCaptionUrl(captionLink)).toBe(
      'https://video-proxy.zyra-project.org/captions?url=https%3A%2F%2Fsos.noaa.gov%2Fmedia%2Fcaptions%2Focean_acidification.srt'
    )
  })

  it('passes non-NOAA caption URLs through unchanged', () => {
    const captionLink = 'https://example.com/captions/test.srt'
    expect(proxyCaptionUrl(captionLink)).toBe(captionLink)
  })

  it('does not proxy URLs whose path contains sos.noaa.gov', () => {
    // Regression for CodeQL "Incomplete URL substring sanitization":
    // a substring check would route this through the proxy, leaking
    // attacker-chosen URLs through our caption worker.
    const spoof = 'https://attacker.example/sos.noaa.gov/foo.srt'
    expect(proxyCaptionUrl(spoof)).toBe(spoof)
  })

  it('proxies subdomains of sos.noaa.gov', () => {
    const sub = 'https://media.sos.noaa.gov/captions/ocean.srt'
    expect(proxyCaptionUrl(sub)).toBe(
      `https://video-proxy.zyra-project.org/captions?url=${encodeURIComponent(sub)}`
    )
  })
})

describe('supplementary asset filenames', () => {
  it('derives thumbnail filename from URL extension', () => {
    const thumbnailLink = 'https://cdn.example.com/thumb/ocean.png'
    const ext = thumbnailLink.match(/(\.\w+)$/)?.[1] ?? '.jpg'
    expect(`thumbnail${ext}`).toBe('thumbnail.png')
  })

  it('defaults thumbnail extension to .jpg', () => {
    const thumbnailLink = 'https://cdn.example.com/thumb/noext'
    const ext = thumbnailLink.match(/(\.\w+)$/)?.[1] ?? '.jpg'
    expect(`thumbnail${ext}`).toBe('thumbnail.jpg')
  })

  it('derives legend filename from URL extension', () => {
    const legendLink = 'https://cdn.example.com/legend/scale.gif'
    const ext = legendLink.match(/(\.\w+)$/)?.[1] ?? '.png'
    expect(`legend${ext}`).toBe('legend.gif')
  })

  it('defaults legend extension to .png when link is absent', () => {
    const legendLink = null as string | null
    const ext = legendLink?.match(/(\.\w+)$/)?.[1] ?? '.png'
    expect(`legend${ext}`).toBe('legend.png')
  })
})

describe('Vimeo ID extraction', () => {
  // This tests the pattern used in downloadService via dataService
  const extractVimeoId = (url: string): string | null => {
    const match = url.match(/vimeo\.com\/(\d+)/)
    return match ? match[1] : null
  }

  it('extracts ID from standard Vimeo URL', () => {
    expect(extractVimeoId('https://vimeo.com/123456789')).toBe('123456789')
  })

  it('extracts ID from Vimeo URL with trailing path', () => {
    expect(extractVimeoId('https://vimeo.com/987654321/abcdef')).toBe('987654321')
  })

  it('returns null for non-Vimeo URLs', () => {
    expect(extractVimeoId('https://youtube.com/watch?v=abc')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(extractVimeoId('')).toBeNull()
  })
})

// --- Node-mode manifest envelope walking ---
// These exercise the real pickBestVideoFile / orderImageCandidates
// exported via __test__, so production drift (re-ordering, lost
// HLS guard, lost http(s) filter) surfaces as a test failure.

describe('pickBestVideoFile', () => {
  it('picks the highest-width file from a video manifest envelope', () => {
    const best = pickBestVideoFile({
      kind: 'video',
      files: [
        { quality: '480p', width: 854, height: 480, size: 20_000_000, type: 'video/mp4', link: 'https://r2.example/480.mp4' },
        { quality: '4K', width: 3840, height: 2160, size: 500_000_000, type: 'video/mp4', link: 'https://r2.example/4k.mp4' },
        { quality: '1080p', width: 1920, height: 1080, size: 100_000_000, type: 'video/mp4', link: 'https://r2.example/1080.mp4' },
      ],
    })
    expect(best.link).toBe('https://r2.example/4k.mp4')
    expect(best.size).toBe(500_000_000)
  })

  it('throws a clear HLS-streaming error when files[] is empty', () => {
    // The Phase 3 r2-hls migration populates `hls` but leaves
    // `files[]` empty. Without this guard the SPA would hand the
    // playlist URL to reqwest, which has no way to reassemble a
    // playlist + .ts segments into a single offline file.
    expect(() => pickBestVideoFile({ kind: 'video', files: [] })).toThrow(/HLS-streamed/)
  })

  it('throws a clear HLS-streaming error when files is omitted entirely', () => {
    expect(() => pickBestVideoFile({ kind: 'video' })).toThrow(/HLS-streamed/)
  })

  it('rejects a manifest whose best file has a non-http(s) link', () => {
    // Guards against the catalog serializer regression where a
    // raw `r2:` or `stream:` ref leaks through resolveDataRef.
    expect(() =>
      pickBestVideoFile({
        kind: 'video',
        files: [
          { quality: '4K', width: 3840, height: 2160, size: 0, type: 'video/mp4', link: 'r2:datasets/foo/4k.mp4' },
        ],
      }),
    ).toThrow(/non-HTTP file link/)
  })
})

describe('orderImageCandidates', () => {
  it('orders variants by descending width and appends the fallback', () => {
    expect(
      orderImageCandidates({
        kind: 'image',
        variants: [
          { width: 1024, url: 'https://r2.example/1024.jpg' },
          { width: 4096, url: 'https://r2.example/4096.jpg' },
          { width: 2048, url: 'https://r2.example/2048.jpg' },
        ],
        fallback: 'https://r2.example/original.jpg',
      }),
    ).toEqual([
      'https://r2.example/4096.jpg',
      'https://r2.example/2048.jpg',
      'https://r2.example/1024.jpg',
      'https://r2.example/original.jpg',
    ])
  })

  it('omits the fallback when none is provided', () => {
    expect(
      orderImageCandidates({
        kind: 'image',
        variants: [{ width: 1024, url: 'https://r2.example/1024.jpg' }],
      }),
    ).toEqual(['https://r2.example/1024.jpg'])
  })

  it('filters out non-http(s) variants and fallback', () => {
    // Defensive: even if the manifest endpoint leaks raw refs in
    // variants, the SPA never hands them to the Rust downloader.
    expect(
      orderImageCandidates({
        kind: 'image',
        variants: [
          { width: 4096, url: 'r2:datasets/foo/4096.jpg' },
          { width: 2048, url: 'https://r2.example/2048.jpg' },
        ],
        fallback: 'stream:abc123',
      }),
    ).toEqual(['https://r2.example/2048.jpg'])
  })

  it('returns an empty array when nothing is usable (callers throw their own error)', () => {
    expect(
      orderImageCandidates({
        kind: 'image',
        variants: [{ width: 4096, url: 'r2:datasets/foo/4096.jpg' }],
      }),
    ).toEqual([])
  })
})

describe('extFromUrl', () => {
  it('extracts a simple .jpg extension', () => {
    expect(extFromUrl('https://r2.example/foo.jpg', '.png')).toBe('.jpg')
  })

  it('extracts .png ignoring the path before the dot', () => {
    expect(extFromUrl('https://r2.example/path/to/earth.png', '.jpg')).toBe('.png')
  })

  it('is tolerant of query strings (Cloudflare Images variant URLs)', () => {
    // Without the `(\?|#|$)` boundary in the regex, the original
    // suffix-match swallows the query string as part of the
    // extension, producing a junk filename.
    expect(
      extFromUrl(
        'https://r2.example/cdn-cgi/image/width=4096/datasets/foo.jpg?format=auto',
        '.png',
      ),
    ).toBe('.jpg')
  })

  it('is tolerant of fragments', () => {
    expect(extFromUrl('https://r2.example/foo.png#anchor', '.jpg')).toBe('.png')
  })

  it('falls back to the default when no extension is present', () => {
    expect(extFromUrl('https://r2.example/datasets/no-ext', '.png')).toBe('.png')
  })
})

describe('isHttpUrl', () => {
  // The catalog serializer currently surfaces thumbnail_ref /
  // legend_ref / caption_ref as raw URIs (r2:, stream:, vimeo:),
  // not resolved HTTPS URLs. downloadService.ts filters those out
  // before pushing them to the Rust downloader, otherwise reqwest
  // fails the whole download with `builder error`.
  it('accepts absolute https URLs', () => {
    expect(isHttpUrl('https://example.com/thumb.jpg')).toBe(true)
  })

  it('accepts absolute http URLs', () => {
    expect(isHttpUrl('http://example.com/thumb.jpg')).toBe(true)
  })

  it('rejects raw r2: refs (catalog serializer pass-through)', () => {
    expect(isHttpUrl('r2:datasets/01KQG.../thumbnail.jpg')).toBe(false)
  })

  it('rejects raw stream: refs', () => {
    expect(isHttpUrl('stream:abc123')).toBe(false)
  })

  it('rejects raw vimeo: refs', () => {
    expect(isHttpUrl('vimeo:123456')).toBe(false)
  })

  it('rejects relative API paths', () => {
    expect(isHttpUrl('/api/v1/datasets/01KQG.../manifest')).toBe(false)
  })

  it('rejects null, undefined, and empty strings', () => {
    expect(isHttpUrl(null)).toBe(false)
    expect(isHttpUrl(undefined)).toBe(false)
    expect(isHttpUrl('')).toBe(false)
  })
})

// --- Source-of-truth classification ---
// The zip dialog (§8.2) shows a different note per provenance bucket
// so users know whether the archive contains the publisher's
// canonical upload, a Vimeo transcode, or a legacy SOS asset.
// Substring-matching would break on attacker-chosen URLs that happen
// to contain a known host in their path; these tests pin the
// hostname-based check.

describe('classifySourceOfTruth', () => {
  it('classifies the video-proxy host as vimeo', () => {
    expect(classifySourceOfTruth('https://video-proxy.zyra-project.org/video/foo.mp4')).toBe('vimeo')
  })

  it('classifies a vimeocdn subdomain as vimeo', () => {
    expect(
      classifySourceOfTruth('https://player.vimeocdn.com/external/123.mp4'),
    ).toBe('vimeo')
  })

  it('classifies sos.noaa.gov assets as sos', () => {
    expect(classifySourceOfTruth('https://sos.noaa.gov/data/foo.jpg')).toBe('sos')
  })

  it('classifies an R2 public origin (publisher upload) as publisher', () => {
    expect(
      classifySourceOfTruth('https://r2.terraviz.zyra-project.org/videos/DS01/source.mp4'),
    ).toBe('publisher')
  })

  it('classifies the bare Pages origin (terraviz.zyra-project.org) as publisher', () => {
    // Regression: the Pages origin serves R2 image transformations
    // via /cdn-cgi/image/ — it's a publisher-source URL, not the
    // generic "external" bucket. Pinning explicitly so the dialog's
    // source-of-truth note doesn't regress to "hosted externally"
    // for the most common image path in production.
    expect(
      classifySourceOfTruth('https://terraviz.zyra-project.org/cdn-cgi/image/width=4096/datasets/foo/image.png'),
    ).toBe('publisher')
  })

  it('classifies an arbitrary *.zyra-project.org subdomain as publisher', () => {
    // Project-controlled subdomains (image-resize, frames, etc.) all
    // count as publisher source for source-of-truth purposes; we
    // operate them, so users see the canonical "from the publisher
    // upload" note rather than the generic external one.
    expect(
      classifySourceOfTruth('https://frames.terraviz.zyra-project.org/datasets/DS01/frame_00000.png'),
    ).toBe('publisher')
  })

  it('falls through to external for an unknown *.r2.dev third-party bucket', () => {
    // Regression: a bare `r2.dev` apex entry in PUBLISHER_HOSTS
    // would suffix-match every third-party R2 public bucket. The
    // policy is "only zyra-project.org subdomains classify as
    // publisher"; everything on the shared r2.dev domain is
    // someone else's bucket until proven otherwise.
    expect(
      classifySourceOfTruth('https://competitor-bucket.r2.dev/asset.mp4'),
    ).toBe('external')
    expect(
      classifySourceOfTruth('https://pub-1234.r2.dev/asset.mp4'),
    ).toBe('external')
  })

  it('falls through to external for any other host', () => {
    expect(classifySourceOfTruth('https://example.com/foo.mp4')).toBe('external')
  })

  it('classifies the running node\'s own page-origin subdomain as publisher', () => {
    // Fork independence: a self-hosted node serving R2 assets from a
    // subdomain of its own domain must classify them as `publisher`,
    // not `external` — even though the fork's host is not in the
    // static PUBLISHER_HOSTS list. `publisherHosts()` adds the live
    // page origin at runtime. jsdom defaults window.location to
    // http://localhost/, so stub a fork host for this case.
    //
    // `hostname` is an accessor on jsdom's Location prototype, not an
    // own property — so capture the original own descriptor (likely
    // undefined) and restore it by deleting our shadow, rather than
    // writing back a static value descriptor that would permanently
    // mask the accessor for later tests in this file.
    const originalDescriptor = Object.getOwnPropertyDescriptor(window.location, 'hostname')
    Object.defineProperty(window.location, 'hostname', {
      value: 'terraviz.test.gsl.noaa.gov',
      configurable: true,
    })
    try {
      expect(
        classifySourceOfTruth('https://assets.terraviz.test.gsl.noaa.gov/datasets/DS01/source.mp4'),
      ).toBe('publisher')
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(window.location, 'hostname', originalDescriptor)
      } else {
        delete (window.location as unknown as { hostname?: string }).hostname
      }
    }
  })

  it('does not trust localhost as a publisher even when VITE_API_ORIGIN points at it', () => {
    // Local-dev guard: a `VITE_API_ORIGIN=http://localhost:...` must
    // NOT make loopback URLs classify as publisher source. The host
    // derived from getApiOrigin() is filtered by isLoopbackHost.
    vi.stubEnv('VITE_API_ORIGIN', 'http://localhost:8787')
    try {
      expect(
        classifySourceOfTruth('http://localhost:8787/datasets/DS01/source.mp4'),
      ).toBe('external')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('does not be tricked by sos.noaa.gov in the path', () => {
    // Regression for substring sanitization: the publisher-portal /
    // Vimeo note must not be applied to an attacker-controlled URL
    // that happens to contain a known host in its path.
    expect(
      classifySourceOfTruth('https://attacker.example/sos.noaa.gov/foo.srt'),
    ).toBe('external')
  })

  it('returns external on a malformed URL rather than throwing', () => {
    expect(classifySourceOfTruth('not-a-url')).toBe('external')
  })
})

// --- expandFrameAssets ---
// Frames-mode datasets carry an `urlTemplate` with a `{index}` token.
// The zip service uses these per-frame URLs to build a folder of
// frames inside the archive. Tests pin the zero-padding, the
// non-http filtering, and the count semantics.

describe('expandFrameAssets', () => {
  function frameDataset(overrides: Partial<Dataset> = {}): Dataset {
    return {
      id: 'DS01',
      title: 'Frames Dataset',
      format: 'video/mp4',
      dataLink: '/api/v1/datasets/DS01/manifest',
      frames: {
        count: 3,
        urlTemplate: 'https://r2.terraviz.zyra-project.org/frames/DS01/{index}.png',
      },
      ...overrides,
    } as Dataset
  }

  it('expands the urlTemplate with zero-padded 5-digit indices', () => {
    const assets = expandFrameAssets(frameDataset())
    expect(assets).toHaveLength(3)
    expect(assets[0].url).toBe('https://r2.terraviz.zyra-project.org/frames/DS01/00000.png')
    expect(assets[1].url).toBe('https://r2.terraviz.zyra-project.org/frames/DS01/00001.png')
    expect(assets[2].url).toBe('https://r2.terraviz.zyra-project.org/frames/DS01/00002.png')
  })

  it('routes every frame under a frames/ folder inside the zip', () => {
    const assets = expandFrameAssets(frameDataset())
    expect(assets[0].filename).toBe('frames/frame_00000.png')
    expect(assets[1].filename).toBe('frames/frame_00001.png')
  })

  it('marks every frame with the publisher-source bucket when hosted on R2', () => {
    const assets = expandFrameAssets(frameDataset())
    for (const a of assets) {
      expect(a.kind).toBe('frame')
      expect(a.sourceOfTruth).toBe('publisher')
    }
  })

  it('returns an empty array when the dataset has no frames envelope', () => {
    const noFrames = { ...frameDataset(), frames: undefined } as Dataset
    expect(expandFrameAssets(noFrames)).toEqual([])
  })

  it('returns an empty array when the frame count is zero', () => {
    const zero = frameDataset({ frames: { count: 0, urlTemplate: 'https://example.com/{index}.png' } })
    expect(expandFrameAssets(zero)).toEqual([])
  })

  it('skips frames whose substituted URL is not http(s)', () => {
    // Defensive: a publisher portal hand-rolling a `r2:` template
    // would otherwise leak into the zip and 404 mid-download.
    const bad = frameDataset({
      frames: { count: 2, urlTemplate: 'r2:frames/DS01/{index}.png' },
    })
    expect(expandFrameAssets(bad)).toEqual([])
  })

  it('returns an empty array when count is not an integer', () => {
    // Mirrors `resolveFrameQuery`'s guard in src/utils/frames.ts —
    // a corrupt / mid-ingest row with `frames.count = NaN` would
    // otherwise produce a zero-iteration loop that silently
    // returns []. Worse, `Infinity` would loop unbounded. Fail
    // closed for the same shape `parseFrameQueryToIndex` does.
    const nan = frameDataset({
      frames: { count: Number.NaN, urlTemplate: 'https://r2.example/{index}.png' },
    })
    expect(expandFrameAssets(nan)).toEqual([])

    const infinite = frameDataset({
      frames: { count: Number.POSITIVE_INFINITY, urlTemplate: 'https://r2.example/{index}.png' },
    })
    expect(expandFrameAssets(infinite)).toEqual([])

    const fractional = frameDataset({
      frames: { count: 2.5 as number, urlTemplate: 'https://r2.example/{index}.png' },
    })
    expect(expandFrameAssets(fractional)).toEqual([])
  })

  it('returns an empty array when count is negative', () => {
    const neg = frameDataset({
      frames: { count: -1, urlTemplate: 'https://r2.example/{index}.png' },
    })
    expect(expandFrameAssets(neg)).toEqual([])
  })
})

// --- isZipDownloadable ---
// Capability gate the browse + info-panel surfaces use to suppress
// the zip button on datasets we know will fail today (plain video
// rows post Phase 3 r2-hls migration). The gate widens once
// issues #147 + #148 land; until then it suppresses the misleading
// entry point so users only click into the dialog on rows that
// actually produce a working archive.

describe('isZipDownloadable', () => {
  it('renders for image datasets', () => {
    expect(isZipDownloadable({
      id: 'D', title: 'T', format: 'image/jpeg', dataLink: '/api/v1/datasets/D/manifest',
    } as Dataset)).toBe(true)
    expect(isZipDownloadable({
      id: 'D', title: 'T', format: 'image/png', dataLink: '/api/v1/datasets/D/manifest',
    } as Dataset)).toBe(true)
  })

  it('renders for frames-mode datasets even when stored as video/*', () => {
    // Phase 3pf image-sequence-source video rows: format is
    // video/mp4 (HLS playback) but `frames` carries the
    // canonical downloadable per-frame URLs that
    // expandFrameAssets() expands.
    expect(isZipDownloadable({
      id: 'D', title: 'T', format: 'video/mp4', dataLink: '/api/v1/datasets/D/manifest',
      frames: { count: 240, urlTemplate: 'https://r2.example/{index}.png' },
    } as Dataset)).toBe(true)
  })

  it('suppresses for plain video datasets routed through the manifest endpoint', () => {
    // Post Phase 3 r2-hls migration, every video row's data_ref
    // is r2:videos/{id}/<id>/master.m3u8 → manifest endpoint
    // returns files: [] → resolveVideoPrimary throws HLS-only.
    // Suppress the button until #147 / #148 land.
    expect(isZipDownloadable({
      id: 'D', title: 'T', format: 'video/mp4', dataLink: '/api/v1/datasets/D/manifest',
    } as Dataset)).toBe(false)
  })

  it('renders for legacy direct-Vimeo video rows whose dataLink bypasses the manifest endpoint', () => {
    // Legacy SOS catalog rows still carry `dataLink =
    // https://vimeo.com/123456`, which routes through
    // resolveVideoPrimary's Vimeo-proxy fallback. Those produce a
    // working archive. Pin that the temporary gate doesn't
    // over-suppress this cohort.
    expect(isZipDownloadable({
      id: 'D', title: 'T', format: 'video/mp4',
      dataLink: 'https://vimeo.com/123456789',
    } as Dataset)).toBe(true)
  })

  it('renders for direct-URL videos pointed at any non-manifest origin', () => {
    // Same shape, different host — direct MP4 hosted on
    // sos.noaa.gov or similar; resolveVideoPrimary's legacy
    // branch handles it.
    expect(isZipDownloadable({
      id: 'D', title: 'T', format: 'video/mp4',
      dataLink: 'https://example.com/clip.mp4',
    } as Dataset)).toBe(true)
  })

  it('suppresses for unknown / non-image / non-video formats', () => {
    // Tour/json and anything else not covered above — no archive
    // semantics defined, suppress.
    expect(isZipDownloadable({
      id: 'D', title: 'T', format: 'tour/json' as any, dataLink: '/api/v1/datasets/D/manifest',
    } as Dataset)).toBe(false)
  })
})
