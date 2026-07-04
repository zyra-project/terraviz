import { describe, it, expect, afterEach, vi } from 'vitest'
import { parseDatasetFromUrl, parseDatasetPathname } from './deepLinkService'

describe('parseDatasetPathname', () => {
  it('parses the /dataset/<id> path form share links and blog posts emit', () => {
    expect(parseDatasetPathname('/dataset/INTERNAL_SOS_123')).toBe('INTERNAL_SOS_123')
    expect(parseDatasetPathname('/dataset/01JXCULID0000000000000000/')).toBe('01JXCULID0000000000000000')
  })

  it('rejects other paths, nested segments, and ids outside the shared alphabet', () => {
    expect(parseDatasetPathname('/')).toBeNull()
    expect(parseDatasetPathname('/blog/some-post')).toBeNull()
    expect(parseDatasetPathname('/dataset/')).toBeNull()
    expect(parseDatasetPathname('/dataset/id/extra')).toBeNull()
    expect(parseDatasetPathname('/dataset/bad%20chars')).toBeNull()
    // Aligned with parseDatasetFromUrl's ID_PATTERN — no hyphens.
    expect(parseDatasetPathname('/dataset/has-hyphen')).toBeNull()
  })
})

describe('parseDatasetFromUrl', () => {
  it('parses zyra:// custom scheme URLs', () => {
    expect(parseDatasetFromUrl('zyra://dataset/INTERNAL_SOS_123')).toBe('INTERNAL_SOS_123')
  })

  it('parses https path-based URLs from production host', () => {
    expect(parseDatasetFromUrl('https://terraviz.zyra-project.org/dataset/INTERNAL_SOS_456')).toBe('INTERNAL_SOS_456')
  })

  it('parses https path-based URLs from preview deploys', () => {
    expect(parseDatasetFromUrl('https://my-branch.terraviz.pages.dev/dataset/INTERNAL_SOS_789')).toBe('INTERNAL_SOS_789')
  })

  it('parses ?dataset= query param from known hosts', () => {
    expect(parseDatasetFromUrl('https://terraviz.zyra-project.org/?dataset=INTERNAL_SOS_100')).toBe('INTERNAL_SOS_100')
  })

  it('parses localhost URLs', () => {
    expect(parseDatasetFromUrl('http://localhost:5173/dataset/TEST_001')).toBe('TEST_001')
  })

  it('rejects query params with invalid characters', () => {
    expect(parseDatasetFromUrl('https://terraviz.zyra-project.org/?dataset=<script>alert(1)</script>')).toBeNull()
  })

  it('rejects unknown hosts for path-based URLs', () => {
    expect(parseDatasetFromUrl('https://evil.com/dataset/INTERNAL_SOS_123')).toBeNull()
  })

  it('rejects unknown hosts for query param URLs', () => {
    expect(parseDatasetFromUrl('https://evil.com/?dataset=INTERNAL_SOS_123')).toBeNull()
  })

  it('returns null for URLs with no dataset reference', () => {
    expect(parseDatasetFromUrl('https://terraviz.zyra-project.org/')).toBeNull()
  })

  it('handles bare path strings as fallback', () => {
    expect(parseDatasetFromUrl('dataset/INTERNAL_SOS_999')).toBe('INTERNAL_SOS_999')
  })

  it('returns null for empty string', () => {
    expect(parseDatasetFromUrl('')).toBeNull()
  })

  // Node independence: a fork serving its own domain must recognise
  // its own /dataset/<id> deep links. The host allowlist derives the
  // configured host from VITE_API_ORIGIN, so no code edit is needed.
  describe('forked node host (VITE_API_ORIGIN)', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it("recognises the fork's own configured host", () => {
      vi.stubEnv('VITE_API_ORIGIN', 'https://terraviz.acme-corp.org')
      expect(
        parseDatasetFromUrl('https://terraviz.acme-corp.org/dataset/INTERNAL_SOS_321'),
      ).toBe('INTERNAL_SOS_321')
      expect(
        parseDatasetFromUrl('https://terraviz.acme-corp.org/?dataset=INTERNAL_SOS_322'),
      ).toBe('INTERNAL_SOS_322')
    })

    it("recognises the fork's own *.pages.dev preview deploys", () => {
      expect(
        parseDatasetFromUrl('https://acme-terraviz.pages.dev/dataset/INTERNAL_SOS_654'),
      ).toBe('INTERNAL_SOS_654')
    })

    it('still rejects unrelated hosts', () => {
      vi.stubEnv('VITE_API_ORIGIN', 'https://terraviz.acme-corp.org')
      expect(parseDatasetFromUrl('https://evil.com/dataset/INTERNAL_SOS_1')).toBeNull()
    })
  })
})
