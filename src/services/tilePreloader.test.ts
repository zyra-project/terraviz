import { describe, it, expect } from 'vitest'
import { generateTileUrls } from './tilePreloader'

describe('generateTileUrls', () => {
  const TEMPLATE = '/tiles/{z}/{y}/{x}.jpg'

  it('generates 1 tile at zoom 0', () => {
    const urls = generateTileUrls(TEMPLATE, 0)
    expect(urls).toEqual(['/tiles/0/0/0.jpg'])
  })

  it('generates 5 tiles for z0-z1 (1 + 4)', () => {
    const urls = generateTileUrls(TEMPLATE, 1)
    expect(urls).toHaveLength(5)
    expect(urls).toContain('/tiles/1/0/0.jpg')
    expect(urls).toContain('/tiles/1/0/1.jpg')
    expect(urls).toContain('/tiles/1/1/0.jpg')
    expect(urls).toContain('/tiles/1/1/1.jpg')
  })

  it('generates 85 tiles for z0-z3 (1 + 4 + 16 + 64)', () => {
    const urls = generateTileUrls(TEMPLATE, 3)
    expect(urls).toHaveLength(85)
  })

  it('generates correct tile count per zoom level', () => {
    // Each zoom z has (2^z)^2 tiles; cumulative sum for z0..maxZ
    for (let maxZ = 0; maxZ <= 4; maxZ++) {
      const urls = generateTileUrls(TEMPLATE, maxZ)
      let expected = 0
      for (let z = 0; z <= maxZ; z++) {
        expected += (1 << z) * (1 << z)
      }
      expect(urls).toHaveLength(expected)
    }
  })

  it('substitutes z/y/x placeholders correctly', () => {
    const urls = generateTileUrls('/api/tile/{z}/{y}/{x}.png', 2)
    expect(urls).toContain('/api/tile/2/3/3.png')
    expect(urls).toContain('/api/tile/0/0/0.png')
    expect(urls).toContain('/api/tile/1/1/0.png')
  })

  it('returns empty array for negative maxZoom', () => {
    const urls = generateTileUrls(TEMPLATE, -1)
    expect(urls).toEqual([])
  })

  it('does not produce duplicate URLs', () => {
    const urls = generateTileUrls(TEMPLATE, 3)
    expect(new Set(urls).size).toBe(urls.length)
  })
})
