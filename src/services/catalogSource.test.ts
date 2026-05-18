import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { apiFetch, getCatalogSource, isManifestUrl, resolveApiUrl } from './catalogSource'

const ORIGINAL = import.meta.env.VITE_CATALOG_SOURCE

describe('getCatalogSource', () => {
  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete (import.meta.env as Record<string, string>).VITE_CATALOG_SOURCE
    } else {
      ;(import.meta.env as Record<string, string>).VITE_CATALOG_SOURCE = ORIGINAL
    }
  })

  it('defaults to node (post-1d/G cutover)', () => {
    delete (import.meta.env as Record<string, string>).VITE_CATALOG_SOURCE
    expect(getCatalogSource()).toBe('node')
  })

  it('returns "legacy" only for the exact string', () => {
    ;(import.meta.env as Record<string, string>).VITE_CATALOG_SOURCE = 'legacy'
    expect(getCatalogSource()).toBe('legacy')
  })

  it('falls back to node on an unknown value', () => {
    ;(import.meta.env as Record<string, string>).VITE_CATALOG_SOURCE = 'wat'
    expect(getCatalogSource()).toBe('node')
  })
})

describe('resolveApiUrl', () => {
  const tauriWindow = window as unknown as { __TAURI__?: unknown }
  const ORIGINAL_API_ORIGIN = import.meta.env.VITE_API_ORIGIN

  afterEach(() => {
    delete tauriWindow.__TAURI__
    if (ORIGINAL_API_ORIGIN === undefined) {
      delete (import.meta.env as Record<string, string>).VITE_API_ORIGIN
    } else {
      ;(import.meta.env as Record<string, string>).VITE_API_ORIGIN =
        ORIGINAL_API_ORIGIN
    }
  })

  describe('web builds (no __TAURI__)', () => {
    it('returns relative API paths unchanged', () => {
      expect(resolveApiUrl('/api/v1/catalog')).toBe('/api/v1/catalog')
      expect(resolveApiUrl('/api/v1/datasets/DS001/manifest')).toBe(
        '/api/v1/datasets/DS001/manifest',
      )
    })

    it('returns absolute and non-API paths unchanged', () => {
      expect(resolveApiUrl('https://example.com/foo')).toBe(
        'https://example.com/foo',
      )
      expect(resolveApiUrl('/assets/test-tour.json')).toBe(
        '/assets/test-tour.json',
      )
      expect(resolveApiUrl('')).toBe('')
    })
  })

  describe('Tauri builds (__TAURI__ present)', () => {
    beforeEach(() => {
      tauriWindow.__TAURI__ = {}
    })

    it('rewrites /api/ paths to the production origin', () => {
      expect(resolveApiUrl('/api/v1/catalog')).toBe(
        'https://terraviz.zyra-project.org/api/v1/catalog',
      )
      expect(resolveApiUrl('/api/v1/datasets/DS001/manifest')).toBe(
        'https://terraviz.zyra-project.org/api/v1/datasets/DS001/manifest',
      )
    })

    it('strips a webview-origin prefix before rewriting', () => {
      // The docent constructs URLs via `new URL(path, window.location.origin)`,
      // which produces e.g. `http://localhost:3000/api/v1/search?q=foo` in
      // tests. The rewrite must reach the same production endpoint as a
      // bare-path caller, so the helper has to recognise the origin prefix.
      const constructed = `${window.location.origin}/api/v1/search?q=foo`
      expect(resolveApiUrl(constructed)).toBe(
        'https://terraviz.zyra-project.org/api/v1/search?q=foo',
      )
    })

    it('does NOT rewrite non-/api paths (the Tauri SPA still owns them)', () => {
      // The SPA bundle ships `/assets/test-tour.json`, `/sw.js`, etc.
      // Rewriting those would break the bundled asset path.
      expect(resolveApiUrl('/assets/test-tour.json')).toBe(
        '/assets/test-tour.json',
      )
      expect(resolveApiUrl('/sw.js')).toBe('/sw.js')
    })

    it('passes external HTTPS URLs through unchanged', () => {
      expect(resolveApiUrl('https://example.com/foo')).toBe(
        'https://example.com/foo',
      )
    })

    it('honours VITE_API_ORIGIN as an override origin', () => {
      ;(import.meta.env as Record<string, string>).VITE_API_ORIGIN =
        'https://staging.example.com'
      expect(resolveApiUrl('/api/v1/catalog')).toBe(
        'https://staging.example.com/api/v1/catalog',
      )
    })

    it('strips a trailing slash from VITE_API_ORIGIN', () => {
      ;(import.meta.env as Record<string, string>).VITE_API_ORIGIN =
        'https://staging.example.com/'
      expect(resolveApiUrl('/api/v1/catalog')).toBe(
        'https://staging.example.com/api/v1/catalog',
      )
    })

    it('strips a path/query from VITE_API_ORIGIN (origin-only contract)', () => {
      // Misconfiguration like `https://staging.example.com/foo` should
      // produce `https://staging.example.com/api/v1/...`, NOT
      // `https://staging.example.com/foo/api/v1/...`. The variable
      // name promises an origin; the parser enforces it.
      ;(import.meta.env as Record<string, string>).VITE_API_ORIGIN =
        'https://staging.example.com/foo/bar?q=1'
      expect(resolveApiUrl('/api/v1/catalog')).toBe(
        'https://staging.example.com/api/v1/catalog',
      )
    })

    it('preserves a non-default port on VITE_API_ORIGIN', () => {
      ;(import.meta.env as Record<string, string>).VITE_API_ORIGIN =
        'http://staging.example.com:8080'
      expect(resolveApiUrl('/api/v1/catalog')).toBe(
        'http://staging.example.com:8080/api/v1/catalog',
      )
    })

    it('ignores a malformed VITE_API_ORIGIN and falls back to default', () => {
      ;(import.meta.env as Record<string, string>).VITE_API_ORIGIN =
        'not-a-url'
      expect(resolveApiUrl('/api/v1/catalog')).toBe(
        'https://terraviz.zyra-project.org/api/v1/catalog',
      )
    })

    it('ignores a non-http(s) VITE_API_ORIGIN and falls back to default', () => {
      ;(import.meta.env as Record<string, string>).VITE_API_ORIGIN =
        'ftp://example.com'
      expect(resolveApiUrl('/api/v1/catalog')).toBe(
        'https://terraviz.zyra-project.org/api/v1/catalog',
      )
    })
  })
})

describe('apiFetch', () => {
  const tauriWindow = window as unknown as { __TAURI__?: unknown }

  afterEach(() => {
    delete tauriWindow.__TAURI__
    vi.restoreAllMocks()
  })

  it('routes /api requests through native fetch in web builds', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    await apiFetch('/api/v1/catalog')
    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/catalog', undefined)
  })

  it('uses native fetch (NOT the Tauri plugin) for non-/api paths in Tauri', async () => {
    // Same-origin relative paths in the Tauri webview don't need the
    // HTTP plugin's CORS bypass and the plugin doesn't know about
    // the webview origin. The gate has to be `isAbsolute`, not just
    // `isTauri`, so non-rewritten paths stay on native fetch.
    tauriWindow.__TAURI__ = {}
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    await apiFetch('/assets/test-tour.json')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledWith('/assets/test-tour.json', undefined)
  })
})

describe('isManifestUrl', () => {
  it('matches /api/v1/datasets/<id>/manifest', () => {
    expect(isManifestUrl('/api/v1/datasets/DS001/manifest')).toBe(true)
    expect(
      isManifestUrl('/api/v1/datasets/164DFJQ8SEZZRTXYDCJHB1SMNK/manifest'),
    ).toBe(true)
  })

  it('matches the token-gated preview manifest sibling', () => {
    // Lets the SPA's `?preview=` consumer route a draft's manifest
    // through the same hlsService / loadImageDataset path as a
    // published dataset.
    expect(
      isManifestUrl('/api/v1/datasets/DS001/preview/abc.def/manifest'),
    ).toBe(true)
  })

  it('does not match other URLs', () => {
    expect(isManifestUrl('/api/v1/catalog')).toBe(false)
    expect(isManifestUrl('https://video-proxy.example/video/123')).toBe(false)
    expect(isManifestUrl('/api/v1/datasets/DS001')).toBe(false)
    expect(isManifestUrl('/api/v1/datasets/DS001/preview/abc.def')).toBe(false)
    expect(isManifestUrl('/assets/test-tour.json')).toBe(false)
    expect(isManifestUrl('')).toBe(false)
  })
})
