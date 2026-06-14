import { describe, expect, it } from 'vitest'

import { PNG } from 'pngjs'

import { diffPngBuffers, parseThreshold } from './diff'

/** A solid-colour PNG of the given size. */
function solidPng(
  width: number,
  height: number,
  [r, g, b]: [number, number, number],
): Buffer {
  const png = new PNG({ width, height })
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = r
    png.data[i * 4 + 1] = g
    png.data[i * 4 + 2] = b
    png.data[i * 4 + 3] = 255
  }
  return PNG.sync.write(png)
}

/** A PNG that is `fillFraction` red rows over a black background. */
function partialPng(width: number, height: number, fillRows: number): Buffer {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const red = y < fillRows
      png.data[i] = red ? 255 : 0
      png.data[i + 1] = 0
      png.data[i + 2] = 0
      png.data[i + 3] = 255
    }
  }
  return PNG.sync.write(png)
}

describe('parseThreshold', () => {
  it('defaults when unset or empty', () => {
    expect(parseThreshold(undefined)).toBe(0.001)
    expect(parseThreshold('')).toBe(0.001)
  })

  it('parses a finite non-negative number', () => {
    expect(parseThreshold('0.05')).toBe(0.05)
    expect(parseThreshold('0')).toBe(0)
  })

  it('throws on non-numeric or negative values instead of yielding NaN', () => {
    expect(() => parseThreshold('abc')).toThrow(/finite number/)
    expect(() => parseThreshold('-0.1')).toThrow(/≥ 0/)
  })
})

describe('diffPngBuffers', () => {
  it('reports unchanged for identical images', () => {
    const a = solidPng(10, 10, [0, 0, 0])
    const res = diffPngBuffers(a, a, 0.001)
    expect(res.status).toBe('unchanged')
    expect(res.changedPixels).toBe(0)
    expect(res.ratio).toBe(0)
    expect(res.diff).toBeInstanceOf(Buffer)
  })

  it('flags changed when the changed-pixel ratio exceeds the threshold', () => {
    const base = solidPng(10, 10, [0, 0, 0])
    // 10 of 100 pixels differ → ratio 0.1.
    const cur = partialPng(10, 10, 1)
    const res = diffPngBuffers(base, cur, 0.001)
    expect(res.status).toBe('changed')
    expect(res.changedPixels).toBe(10)
    expect(res.ratio).toBeCloseTo(0.1, 5)
  })

  it('stays unchanged when the diff is below the threshold', () => {
    const base = solidPng(10, 10, [0, 0, 0])
    const cur = partialPng(10, 10, 1) // ratio 0.1
    const res = diffPngBuffers(base, cur, 0.2) // threshold above the change
    expect(res.status).toBe('unchanged')
  })

  it('reports size-changed (no diff image) for differing dimensions', () => {
    const base = solidPng(10, 10, [0, 0, 0])
    const cur = solidPng(12, 10, [0, 0, 0])
    const res = diffPngBuffers(base, cur, 0.001)
    expect(res.status).toBe('size-changed')
    expect(res.ratio).toBe(1)
    expect(res.diff).toBeUndefined()
  })
})
