/**
 * Tests for `cli/lib/hls-incremental-runner.ts` — the incremental
 * transcode orchestration (`docs/INCREMENTAL_HLS_PLAN.md` Stages 2+3).
 *
 * All I/O is faked in-memory (manifest store, segment store, encode
 * seam), so these exercise the real reuse/encode/upload/GC flow with
 * no ffmpeg or R2.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RENDITION_DESCRIPTORS,
  segmentDescriptorHash,
  type FrameEntry,
  type SegmentManifest,
} from './hls-incremental'
import { runIncremental, type IncrementalDeps, type IncrementalParams } from './hls-incremental-runner'

const RENDITIONS = DEFAULT_RENDITION_DESCRIPTORS

function frames(count: number, opts: { tag?: string; start?: number } = {}): FrameEntry[] {
  const tag = opts.tag ?? 'a'
  const start = opts.start ?? 0
  return Array.from({ length: count }, (_, i) => {
    const n = start + i
    return { index: i, filename: `f_${String(n).padStart(5, '0')}.png`, digest: `sha256:${tag}${n}` }
  })
}

/** In-memory fakes capturing every effect for assertions. */
function makeFakes(prev: SegmentManifest | null = null) {
  const segmentStore = new Set<string>() // hexes "in R2"
  if (prev) for (const c of prev.chunks) for (const r of Object.values(c.segments)) segmentStore.add(r.hex)

  let savedManifest: SegmentManifest | null = null
  let uploadedPlaylists: Record<string, string> | null = null
  const encodeCalls: number[] = [] // frame counts per encodeChunk
  const puts: string[] = []
  const deletes: string[] = []

  const deps: IncrementalDeps = {
    loadManifest: async () => prev,
    saveManifest: async m => {
      savedManifest = m
    },
    encodeChunk: async fr => {
      encodeCalls.push(fr.length)
      // One byte-blob per rendition; content irrelevant to the test.
      const segments: Record<string, Uint8Array> = {}
      const codecs: Record<string, string> = {}
      for (const r of RENDITIONS) {
        segments[r.id] = new Uint8Array([fr.length])
        codecs[r.id] = 'avc1.4d4028'
      }
      return { segments, extinf: fr.length / 30, codecs }
    },
    segmentExists: async hex => segmentStore.has(hex),
    putSegment: async (hex, _body) => {
      puts.push(hex)
      segmentStore.add(hex)
    },
    uploadPlaylists: async files => {
      uploadedPlaylists = files
    },
    listSegmentHexes: async () => [...segmentStore],
    deleteSegments: async hexes => {
      for (const h of hexes) {
        deletes.push(h)
        segmentStore.delete(h)
      }
    },
  }

  return { deps, segmentStore, get savedManifest() { return savedManifest }, get uploadedPlaylists() { return uploadedPlaylists }, encodeCalls, puts, deletes }
}

function params(fr: FrameEntry[], offset: number, epoch: string | null = '2026-01-01T00:00:00.000Z'): IncrementalParams {
  return {
    frames: fr,
    renditions: RENDITIONS,
    offset,
    epoch,
    period: 'PT10M',
    bandwidthByRendition: new Map(RENDITIONS.map(r => [r.id, 10_000_000])),
  }
}

/** Run a cold-start incremental and return the produced manifest
 *  (for use as the "prior" in a follow-up run). */
async function coldRun(fr: FrameEntry[], offset = 0): Promise<SegmentManifest> {
  const fakes = makeFakes(null)
  await runIncremental(fakes.deps, params(fr, offset))
  return fakes.savedManifest!
}

describe('runIncremental', () => {
  it('cold start encodes every chunk and writes the manifest + playlists', async () => {
    const fakes = makeFakes(null)
    const result = await runIncremental(fakes.deps, params(frames(400), 0)) // 3 chunks
    expect(result).toMatchObject({ totalChunks: 3, encodedChunks: 3, reusedChunks: 0 })
    expect(fakes.encodeCalls).toEqual([180, 180, 40])
    // 3 chunks × 3 renditions uploaded.
    expect(fakes.puts).toHaveLength(9)
    expect(fakes.savedManifest?.chunks).toHaveLength(3)
    expect(fakes.savedManifest?.epoch).toBe('2026-01-01T00:00:00.000Z')
    expect(Object.keys(fakes.uploadedPlaylists ?? {})).toContain('master.m3u8')
    // CODECS from the encode are persisted and emitted in the master.
    expect(fakes.savedManifest?.codecs).toEqual({
      stream_0: 'avc1.4d4028',
      stream_1: 'avc1.4d4028',
      stream_2: 'avc1.4d4028',
    })
    expect(fakes.uploadedPlaylists?.['master.m3u8']).toContain('CODECS="avc1.4d4028"')
    // Multi-segment variant playlists carry discontinuity tags between
    // independently-encoded segments (3 chunks → 2 boundaries).
    const variant = fakes.uploadedPlaylists?.['stream_0/playlist.m3u8'] ?? ''
    expect((variant.match(/#EXT-X-DISCONTINUITY/g) ?? []).length).toBe(2)
  })

  it('reuse-only run inherits CODECS from the prior manifest', async () => {
    const prev = await coldRun(frames(360))
    expect(prev.codecs).toBeTruthy()
    const fakes = makeFakes(prev)
    // Same frames → every chunk reused, no fresh encode this run.
    await runIncremental(fakes.deps, params(frames(360), 0))
    expect(fakes.encodeCalls).toEqual([])
    expect(fakes.savedManifest?.codecs).toEqual(prev.codecs)
    expect(fakes.uploadedPlaylists?.['master.m3u8']).toContain('CODECS=')
  })

  it('refuses to publish (throws → full-encode fallback) when no CODECS are available', async () => {
    // A pre-codecs manifest reused wholesale: no fresh encode, no
    // persisted codecs → publishing would reproduce the incident.
    const prev = await coldRun(frames(360))
    const prevNoCodecs = { ...prev }
    delete prevNoCodecs.codecs
    const fakes = makeFakes(prevNoCodecs)
    await expect(runIncremental(fakes.deps, params(frames(360), 0))).rejects.toThrow(/no CODECS/)
    // Nothing was published — the caller falls back to a full encode.
    expect(fakes.savedManifest).toBeNull()
    expect(fakes.uploadedPlaylists).toBeNull()
  })

  it('bails before uploading any segment when an encode yields no CODECS (no storage leak)', async () => {
    const fakes = makeFakes(null)
    // Cold start that encodes chunks but whose encoder reports no codecs
    // (e.g. ffmpeg master parse failure). The guard must fire before the
    // first putSegment so no orphaned content-addressed segments leak.
    fakes.deps.encodeChunk = async fr => {
      const segments: Record<string, Uint8Array> = {}
      for (const r of RENDITIONS) segments[r.id] = new Uint8Array([fr.length])
      return { segments, extinf: fr.length / 30 } // no codecs
    }
    await expect(runIncremental(fakes.deps, params(frames(400), 0))).rejects.toThrow(/no CODECS/)
    expect(fakes.puts).toEqual([]) // nothing uploaded → no orphaned segments
    expect(fakes.savedManifest).toBeNull()
  })

  it('append: reuses interior chunks, encodes only the grown tail', async () => {
    const prev = await coldRun(frames(360)) // 2 full chunks
    const fakes = makeFakes(prev)
    const result = await runIncremental(fakes.deps, params(frames(400), 0))
    expect(result).toMatchObject({ totalChunks: 3, encodedChunks: 1, reusedChunks: 2 })
    // Only the new tail chunk (40 frames) re-encodes.
    expect(fakes.encodeCalls).toEqual([40])
    expect(fakes.puts).toHaveLength(RENDITIONS.length) // 3 new segments
    expect(fakes.deletes).toEqual([]) // nothing orphaned on a pure append
  })

  it('skips the PUT when a content-addressed segment already exists', async () => {
    const prev = await coldRun(frames(360))
    // Pre-seed the store with the tail chunk's segments as if a prior
    // (GC-spared) run had produced identical bytes.
    const tail = { gridIndex: 2, frames: frames(40, { start: 360 }), padded: false }
    const fakes = makeFakes(prev)
    for (const r of RENDITIONS) fakes.segmentStore.add(segmentDescriptorHash(tail, r))
    const result = await runIncremental(fakes.deps, params(frames(400), 0))
    expect(result.encodedChunks).toBe(1) // still encoded (planned)…
    expect(fakes.puts).toHaveLength(0) // …but no PUTs — already present
  })

  it('window slide: reuses survivors, encodes the new cell, GCs the dropped one', async () => {
    const prev = await coldRun(frames(540), 0) // cells 0,1,2
    const fakes = makeFakes(prev)
    const slid = [
      ...frames(180, { start: 180 }), // cell 1 (same digests as before)
      ...frames(180, { start: 360 }), // cell 2
      ...frames(180, { tag: 'b', start: 540 }), // cell 3, new
    ]
    const result = await runIncremental(fakes.deps, params(slid, 180))
    expect(result).toMatchObject({ totalChunks: 3, encodedChunks: 1, reusedChunks: 2 })
    // GC keeps new ∪ prev (one-run grace), so cell 0's segments are
    // NOT pruned this run (grace) — they age out next run.
    expect(fakes.deletes).toEqual([])
  })

  it('prunes orphans that fall outside the new ∪ prev grace set', async () => {
    // run0: cells 0,1,2 ; run1: cells 1,2,3 (cell 0 now in grace) ;
    // run2: cells 2,3,4 — cell 0's segments are now beyond grace → GC.
    const m0 = await coldRun(frames(540), 0)
    const fakes1 = makeFakes(m0)
    await runIncremental(fakes1.deps, params(
      [...frames(360, { start: 180 }), ...frames(180, { tag: 'b', start: 540 })],
      180,
    ))
    const m1 = fakes1.savedManifest!
    // Carry run1's live segment store forward into run2.
    const fakes2 = makeFakes(m1)
    for (const c of m0.chunks) for (const r of Object.values(c.segments)) fakes2.segmentStore.add(r.hex)
    const result = await runIncremental(fakes2.deps, params(
      [...frames(360, { tag: 'b', start: 360 }), ...frames(180, { tag: 'c', start: 720 })],
      360,
    ))
    // Cell 0's three segments (only in m0, not m1 or the new run) are pruned.
    expect(result.prunedSegments).toBeGreaterThanOrEqual(RENDITIONS.length)
    for (const c of m0.chunks) {
      if (c.gridIndex === 0) {
        for (const r of Object.values(c.segments)) expect(fakes2.deletes).toContain(r.hex)
      }
    }
  })

  it('a GC failure never fails the run', async () => {
    const prev = await coldRun(frames(540), 0)
    const fakes = makeFakes(prev)
    fakes.deps.listSegmentHexes = async () => {
      throw new Error('R2 LIST exploded')
    }
    const result = await runIncremental(fakes.deps, params(frames(540), 0))
    expect(result.prunedSegments).toBe(0)
    expect(result.reusedChunks).toBe(3) // the publish itself succeeded
  })

  it('writes the encoder-emitted #EXTINF verbatim (not frames/30)', async () => {
    const fakes = makeFakes(null)
    // Return a duration the muxer might emit that is NOT frames/30, to
    // prove the runner carries the measured value through to the
    // playlist rather than recomputing it.
    fakes.deps.encodeChunk = async fr => {
      const segments: Record<string, Uint8Array> = {}
      const codecs: Record<string, string> = {}
      for (const r of RENDITIONS) {
        segments[r.id] = new Uint8Array([fr.length])
        codecs[r.id] = 'avc1.4d4028'
      }
      return { segments, extinf: 1.234567, codecs }
    }
    await runIncremental(fakes.deps, params(frames(40), 0)) // 1 partial chunk
    const variant = fakes.uploadedPlaylists?.['stream_0/playlist.m3u8'] ?? ''
    expect(variant).toContain('#EXTINF:1.234567')
    // The manifest records the same measured duration.
    const ref = fakes.savedManifest?.chunks[0].segments['stream_0']
    expect(ref?.extinf).toBe(1.234567)
  })

  it('freezes the epoch from the prior manifest, ignoring a drifted caller epoch', async () => {
    const prev = await coldRun(frames(360)) // epoch '2026-01-01T00:00:00.000Z'
    const fakes = makeFakes(prev)
    // Caller passes a different epoch; the frozen manifest epoch must win.
    await runIncremental(fakes.deps, params(frames(360), 0, '2027-06-15T12:00:00.000Z'))
    expect(fakes.savedManifest?.epoch).toBe('2026-01-01T00:00:00.000Z')
  })

  it('preserves a prior null epoch over a non-null caller epoch', async () => {
    // A pure-sequence manifest has epoch=null; that must stay frozen
    // even if the caller passes a non-null epoch (the `??` trap).
    const cold = makeFakes(null)
    await runIncremental(cold.deps, params(frames(360), 0, null))
    const prev = cold.savedManifest!
    expect(prev.epoch).toBeNull()
    const fakes = makeFakes(prev)
    await runIncremental(fakes.deps, params(frames(360), 0, '2027-06-15T12:00:00.000Z'))
    expect(fakes.savedManifest?.epoch).toBeNull()
  })
})
