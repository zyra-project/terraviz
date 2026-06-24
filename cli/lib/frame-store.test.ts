/**
 * Tests for `cli/lib/frame-store.ts` — the runner-side content-
 * addressed frame key helpers + the pure mark-and-sweep selection.
 */

import { describe, expect, it } from 'vitest'
import {
  frameContentKey,
  frameHexFromDigest,
  frameHexFromKey,
  frameStorePrefix,
  selectFrameOrphans,
} from './frame-store'

const DS = '01HXAAAAAAAAAAAAAAAAAAAAAA'
const HEX = 'a'.repeat(64)

describe('frameHexFromDigest', () => {
  it('strips the sha256: prefix and validates hex', () => {
    expect(frameHexFromDigest(`sha256:${HEX}`)).toBe(HEX)
    expect(frameHexFromDigest(HEX)).toBe(HEX)
    expect(frameHexFromDigest('sha256:NOTHEX')).toBeNull()
    expect(frameHexFromDigest(`sha256:${'A'.repeat(64)}`)).toBeNull()
  })
})

describe('frameContentKey + frameStorePrefix', () => {
  it('builds the shared content-addressed key', () => {
    expect(frameContentKey(DS, `sha256:${HEX}`, 'jpg')).toBe(`videos/${DS}/frames/sha256/${HEX}.jpg`)
    expect(frameStorePrefix(DS)).toBe(`videos/${DS}/frames/sha256/`)
  })

  it('throws on a bad digest or extension (caller passes validated values)', () => {
    expect(() => frameContentKey(DS, 'sha256:bad', 'jpg')).toThrow(/digest/)
    expect(() => frameContentKey(DS, `sha256:${HEX}`, 'JPG')).toThrow(/extension/)
  })

  it('agrees with the server-side key shape', () => {
    // Must match functions/api/v1/_lib/r2-store.ts:buildContentAddressedFrameKey.
    expect(frameContentKey(DS, `sha256:${HEX}`, 'png')).toBe(`videos/${DS}/frames/sha256/${HEX}.png`)
  })
})

describe('frameHexFromKey', () => {
  it('extracts the hex from a content-addressed key, rejects others', () => {
    expect(frameHexFromKey(`videos/${DS}/frames/sha256/${HEX}.jpg`)).toBe(HEX)
    expect(frameHexFromKey(`videos/${DS}/frames/sha256/${HEX}.png`)).toBe(HEX)
    expect(frameHexFromKey(`uploads/${DS}/UP/frames/00000.jpg`)).toBeNull()
    expect(frameHexFromKey(`videos/${DS}/segments/sha256/${HEX}.ts`)).toBeNull()
    expect(frameHexFromKey(`videos/${DS}/frames/sha256/${'A'.repeat(64)}.jpg`)).toBeNull()
  })
})

describe('selectFrameOrphans', () => {
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  const c = 'c'.repeat(64)

  it('keeps hexes referenced by the live + previous manifest, prunes the rest', () => {
    const all = [a, b, c]
    // Live manifest references a+b; previous references b only.
    const keep = [`sha256:${a}`, `sha256:${b}`, `sha256:${b}`]
    expect(selectFrameOrphans(all, keep).sort()).toEqual([c])
  })

  it('returns [] when every stored hex is still referenced', () => {
    expect(selectFrameOrphans([a, b], [`sha256:${a}`, `sha256:${b}`])).toEqual([])
  })

  it('ignores unparseable keep digests rather than over-keeping', () => {
    // A junk digest can't accidentally protect an orphan.
    expect(selectFrameOrphans([a], ['not-a-digest']).sort()).toEqual([a])
  })
})
