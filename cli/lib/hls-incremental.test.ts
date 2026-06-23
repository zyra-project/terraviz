/**
 * Tests for `cli/lib/hls-incremental.ts` — the pure core of
 * incremental HLS re-encoding (`docs/INCREMENTAL_HLS_PLAN.md`).
 *
 * Covers the chunking grid (append / partial / sliding-window
 * offset / padded), the content hash's stability + sensitivity, the
 * reuse-vs-encode diff (cold start / append / padded→real / orphans),
 * manifest finalization, and the playlist string builders.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RENDITION_DESCRIPTORS,
  FRAMES_PER_CHUNK,
  assemblePlaylists,
  buildMasterPlaylist,
  buildVariantPlaylist,
  computeChunkGrid,
  finalizeManifest,
  gridOffset,
  planSegments,
  segmentDescriptorHash,
  segmentKey,
  segmentUri,
  type ChunkInput,
  type FrameEntry,
  type RenditionDescriptor,
  type SegmentManifest,
} from './hls-incremental'

/** Build N frame entries with deterministic digests. `from` shifts
 *  the digest content so two ranges differ; `padIndices` marks
 *  synthetic frames by their position. */
function frames(count: number, opts: { tag?: string; start?: number } = {}): FrameEntry[] {
  const tag = opts.tag ?? 'a'
  const start = opts.start ?? 0
  return Array.from({ length: count }, (_, i) => {
    const n = start + i
    return {
      index: i,
      filename: `f_${String(n).padStart(5, '0')}.png`,
      digest: `sha256:${tag}${n}`,
    }
  })
}

const RENDITIONS = DEFAULT_RENDITION_DESCRIPTORS

describe('gridOffset', () => {
  it('computes round((start − epoch) / period)', () => {
    const period = 600_000 // 10 min
    // start is 3 cadence steps after epoch
    expect(gridOffset(3 * period, 0, period)).toBe(3)
    expect(gridOffset(0, 0, period)).toBe(0)
  })
  it('returns null on non-positive / non-finite inputs', () => {
    expect(gridOffset(0, 0, 0)).toBeNull()
    expect(gridOffset(NaN, 0, 600)).toBeNull()
    expect(gridOffset(0, 0, -600)).toBeNull()
  })
  it('returns null when start is off the cadence grid', () => {
    const period = 600_000 // 10 min
    // 3.5 steps after epoch — not an integer number of periods, so the
    // grid is unusable and the caller must fall back to a full encode.
    expect(gridOffset(3.5 * period, 0, period)).toBeNull()
    // Even a small drift (one second on a 10-minute cadence) is off-grid.
    expect(gridOffset(period + 1_000, 0, period)).toBeNull()
    // Exact alignment still rounds cleanly.
    expect(gridOffset(4 * period, 0, period)).toBe(4)
  })
})

describe('computeChunkGrid', () => {
  it('groups exactly 180 frames into one chunk', () => {
    const chunks = computeChunkGrid(frames(180), 0)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].gridIndex).toBe(0)
    expect(chunks[0].partial).toBe(false)
    expect(chunks[0].frames).toHaveLength(180)
  })
  it('splits 181 frames into a full chunk + a 1-frame partial tail', () => {
    const chunks = computeChunkGrid(frames(181), 0)
    expect(chunks.map(c => c.frames.length)).toEqual([180, 1])
    expect(chunks.map(c => c.gridIndex)).toEqual([0, 1])
    expect(chunks[0].partial).toBe(false)
    expect(chunks[1].partial).toBe(true)
  })
  it('honours an absolute offset (sliding window → partial head chunk)', () => {
    // Window starts 100 steps into grid cell 0 → first chunk holds
    // steps 100..179 (80 frames, partial), then a full cell 1.
    const chunks = computeChunkGrid(frames(80 + 180), 100)
    expect(chunks.map(c => c.gridIndex)).toEqual([0, 1])
    expect(chunks[0].frames).toHaveLength(80)
    expect(chunks[0].partial).toBe(true)
    expect(chunks[1].frames).toHaveLength(180)
    expect(chunks[1].partial).toBe(false)
  })
  it('marks a chunk padded when it contains a synthetic frame', () => {
    const fs = frames(180)
    const chunks = computeChunkGrid(fs, 0, new Set([fs[42].filename]))
    expect(chunks[0].padded).toBe(true)
  })
  it('returns no chunks for an empty frame list', () => {
    expect(computeChunkGrid([], 0)).toEqual([])
  })
  it('FRAMES_PER_CHUNK matches the 6s × 30fps encode contract', () => {
    expect(FRAMES_PER_CHUNK).toBe(180)
  })
})

describe('segmentDescriptorHash', () => {
  const chunk: ChunkInput = { gridIndex: 3, frames: frames(180), padded: false, partial: false }
  const r = RENDITIONS[0]

  it('is stable for identical inputs', () => {
    expect(segmentDescriptorHash(chunk, r)).toBe(segmentDescriptorHash(chunk, r))
  })
  it('changes when a frame digest changes (padded→real)', () => {
    const changed: ChunkInput = { ...chunk, frames: frames(180, { tag: 'b' }) }
    expect(segmentDescriptorHash(changed, r)).not.toBe(segmentDescriptorHash(chunk, r))
  })
  it('changes with the padded marker', () => {
    expect(segmentDescriptorHash({ ...chunk, padded: true }, r)).not.toBe(
      segmentDescriptorHash(chunk, r),
    )
  })
  it('differs per rendition and per grid cell', () => {
    expect(segmentDescriptorHash(chunk, RENDITIONS[1])).not.toBe(
      segmentDescriptorHash(chunk, RENDITIONS[0]),
    )
    expect(segmentDescriptorHash({ ...chunk, gridIndex: 4 }, r)).not.toBe(
      segmentDescriptorHash(chunk, r),
    )
  })
})

/** Encode a plan into a finished manifest, faking 6.0s durations for
 *  every freshly-encoded segment. */
function fakeFinalize(
  plan: ReturnType<typeof planSegments>,
  renditions: readonly RenditionDescriptor[],
  meta = { epoch: '2026-01-01T00:00:00.000Z', period: 'PT10M' },
): SegmentManifest {
  const extinfByHex = new Map<string, number>()
  for (const chunk of plan.encodeChunks) {
    for (const r of renditions) extinfByHex.set(segmentDescriptorHash(chunk, r), 6)
  }
  return finalizeManifest(plan, renditions, extinfByHex, meta)
}

describe('planSegments', () => {
  it('cold start (no prior manifest) encodes every chunk', () => {
    const grid = computeChunkGrid(frames(400), 0) // 3 chunks: 180,180,40
    const plan = planSegments(grid, RENDITIONS, null)
    expect(plan.encodeChunks).toHaveLength(3)
    expect(plan.orphanHexes).toEqual([])
    expect(plan.plannedChunks).toHaveLength(3)
  })

  it('append: reuses unchanged chunks, encodes only the grown tail', () => {
    // Run 1: 360 frames = 2 full chunks.
    const grid1 = computeChunkGrid(frames(360), 0)
    const prev = fakeFinalize(planSegments(grid1, RENDITIONS, null), RENDITIONS)

    // Run 2: 400 frames = same 2 full chunks + a new 40-frame tail.
    const grid2 = computeChunkGrid(frames(400), 0)
    const plan = planSegments(grid2, RENDITIONS, prev)

    // Only the new tail chunk (grid 2) re-encodes; the two full
    // interior chunks are recycled.
    expect(plan.encodeChunks.map(c => c.gridIndex)).toEqual([2])
    expect(plan.orphanHexes).toEqual([])
  })

  it('padded→real: re-encodes just the changed interior chunk', () => {
    const fs1 = frames(360)
    const grid1 = computeChunkGrid(fs1, 0, new Set([fs1[200].filename])) // chunk 1 padded
    const prev = fakeFinalize(planSegments(grid1, RENDITIONS, null), RENDITIONS)

    // Run 2: same frames but chunk 1's frame 200 is now a real frame
    // (different digest) and no longer padded.
    const fs2 = frames(360)
    fs2[200] = { ...fs2[200], digest: 'sha256:real200' }
    const grid2 = computeChunkGrid(fs2, 0) // nothing padded now
    const plan = planSegments(grid2, RENDITIONS, prev)

    // Chunk 0 unchanged → reused; chunk 1 changed → re-encoded.
    expect(plan.encodeChunks.map(c => c.gridIndex)).toEqual([1])
    // The old padded chunk-1 segments are now orphaned.
    expect(plan.orphanHexes.length).toBe(RENDITIONS.length)
  })

  it('window slide (front drop): surviving chunks still match, old ones orphan', () => {
    // Run 1: grid cells 0,1,2 (540 frames from offset 0).
    const grid1 = computeChunkGrid(frames(540), 0)
    const prev = fakeFinalize(planSegments(grid1, RENDITIONS, null), RENDITIONS)

    // Run 2: window slid forward by one whole cell — cells 1,2,3.
    // Cells 1 and 2 hold the SAME real frames (same digests) → reused.
    const slid = [
      ...frames(180, { start: 180 }), // cell 1 frames (digests a180..a359)
      ...frames(180, { start: 360 }), // cell 2 frames (a360..a539)
      ...frames(180, { tag: 'b', start: 540 }), // cell 3, new
    ]
    const grid2 = computeChunkGrid(slid, 180) // offset 180 → first cell is 1
    expect(grid2.map(c => c.gridIndex)).toEqual([1, 2, 3])
    const plan = planSegments(grid2, RENDITIONS, prev)

    // Only the brand-new cell 3 encodes; cells 1,2 recycled.
    expect(plan.encodeChunks.map(c => c.gridIndex)).toEqual([3])
    // Cell 0's three segments dropped out → orphaned.
    expect(plan.orphanHexes.length).toBe(RENDITIONS.length)
  })
})

describe('finalizeManifest', () => {
  it('fills durations from the encode map and carries reused ones', () => {
    const grid = computeChunkGrid(frames(180), 0)
    const plan = planSegments(grid, RENDITIONS, null)
    const manifest = fakeFinalize(plan, RENDITIONS)
    expect(manifest.chunks).toHaveLength(1)
    for (const r of RENDITIONS) {
      expect(manifest.chunks[0].segments[r.id].extinf).toBe(6)
    }
  })
  it('throws when a freshly-encoded segment has no measured duration', () => {
    const grid = computeChunkGrid(frames(180), 0)
    const plan = planSegments(grid, RENDITIONS, null)
    expect(() =>
      finalizeManifest(plan, RENDITIONS, new Map(), { epoch: null, period: null }),
    ).toThrow(/missing duration/)
  })
})

describe('playlist builders', () => {
  it('segmentUri / segmentKey point at the shared content-addressed store', () => {
    expect(segmentUri('deadbeef')).toBe('../../segments/sha256/deadbeef.ts')
    expect(segmentKey('deadbeef')).toBe('segments/sha256/deadbeef.ts')
  })

  it('buildVariantPlaylist emits a VOD media playlist with EXTINF + ENDLIST', () => {
    const pl = buildVariantPlaylist([
      { hex: 'aaa', extinf: 6 },
      { hex: 'bbb', extinf: 2.5 },
    ])
    expect(pl).toContain('#EXT-X-PLAYLIST-TYPE:VOD')
    expect(pl).toContain('#EXT-X-TARGETDURATION:6')
    expect(pl).toContain('#EXTINF:6.000000,\n../../segments/sha256/aaa.ts')
    expect(pl).toContain('#EXTINF:2.500000,\n../../segments/sha256/bbb.ts')
    expect(pl.trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true)
  })

  it('buildMasterPlaylist lists each variant with BANDWIDTH + RESOLUTION', () => {
    const m = buildMasterPlaylist([
      { id: 'stream_0', bandwidth: 25_000_000, width: 4096, height: 2048, codecs: 'avc1.4d4028' },
      { id: 'stream_1', bandwidth: 8_000_000, width: 2160, height: 1080 },
    ])
    expect(m).toContain('BANDWIDTH=25000000,RESOLUTION=4096x2048,CODECS="avc1.4d4028"')
    expect(m).toContain('stream_0/playlist.m3u8')
    expect(m).toContain('BANDWIDTH=8000000,RESOLUTION=2160x1080\nstream_1/playlist.m3u8')
  })

  it('assemblePlaylists produces master + one variant playlist per rendition', () => {
    const grid = computeChunkGrid(frames(400), 0)
    const manifest = fakeFinalize(planSegments(grid, RENDITIONS, null), RENDITIONS)
    const bw = new Map(RENDITIONS.map(r => [r.id, 10_000_000]))
    const { master, variants } = assemblePlaylists(manifest, bw)
    expect(Object.keys(variants).sort()).toEqual(
      RENDITIONS.map(r => `${r.id}/playlist.m3u8`).sort(),
    )
    // Each variant lists all three chunks' segments in order.
    for (const r of RENDITIONS) {
      const pl = variants[`${r.id}/playlist.m3u8`]
      expect((pl.match(/#EXTINF:/g) ?? []).length).toBe(3)
    }
    expect(master).toContain('stream_0/playlist.m3u8')
  })
})
