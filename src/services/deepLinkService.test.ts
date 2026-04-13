import { describe, it, expect } from 'vitest'
import { parseDatasetFromUrl } from './deepLinkService'

describe('parseDatasetFromUrl', () => {
  it('parses zyra:// custom scheme URLs', () => {
    expect(parseDatasetFromUrl('zyra://dataset/INTERNAL_SOS_123')).toBe('INTERNAL_SOS_123')
  })

  it('parses https path-based URLs from production host', () => {
    expect(parseDatasetFromUrl('https://sphere.zyra-project.org/dataset/INTERNAL_SOS_456')).toBe('INTERNAL_SOS_456')
  })

  it('parses https path-based URLs from preview deploys', () => {
    expect(parseDatasetFromUrl('https://my-branch.interactive-sphere.pages.dev/dataset/INTERNAL_SOS_789')).toBe('INTERNAL_SOS_789')
  })

  it('parses ?dataset= query param from known hosts', () => {
    expect(parseDatasetFromUrl('https://sphere.zyra-project.org/?dataset=INTERNAL_SOS_100')).toBe('INTERNAL_SOS_100')
  })

  it('parses localhost URLs', () => {
    expect(parseDatasetFromUrl('http://localhost:5173/dataset/TEST_001')).toBe('TEST_001')
  })

  it('rejects query params with invalid characters', () => {
    expect(parseDatasetFromUrl('https://sphere.zyra-project.org/?dataset=<script>alert(1)</script>')).toBeNull()
  })

  it('rejects unknown hosts for path-based URLs', () => {
    expect(parseDatasetFromUrl('https://evil.com/dataset/INTERNAL_SOS_123')).toBeNull()
  })

  it('rejects unknown hosts for query param URLs', () => {
    expect(parseDatasetFromUrl('https://evil.com/?dataset=INTERNAL_SOS_123')).toBeNull()
  })

  it('returns null for URLs with no dataset reference', () => {
    expect(parseDatasetFromUrl('https://sphere.zyra-project.org/')).toBeNull()
  })

  it('handles bare path strings as fallback', () => {
    expect(parseDatasetFromUrl('dataset/INTERNAL_SOS_999')).toBe('INTERNAL_SOS_999')
  })

  it('returns null for empty string', () => {
    expect(parseDatasetFromUrl('')).toBeNull()
  })
})
