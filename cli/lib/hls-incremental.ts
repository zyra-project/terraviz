/**
 * Incremental HLS re-encoding — pure core
 * (`docs/INCREMENTAL_HLS_PLAN.md`).
 *
 * A scheduled real-time workflow re-publishes a frame sequence on a
 * cadence, but day-to-day the frames barely change: a few new ones at
 * the tail, the odd padded→real swap, old ones sliding off the front.
 * Re-encoding the whole video each run is wasted compute. This module
 * is the deterministic, I/O-free core that decides which HLS segments
 * can be recycled and which must be re-encoded, and assembles the
 * playlists that stitch them back together.
 *
 * The lever: `encodeHls()` pins `-r 30 -g 180 -keyint_min 180
 * -sc_threshold 0 -hls_time 6`, so **exactly 180 source frames = one
 * keyframe-led 6 s segment**. That lets us treat a fixed group of 180
 * frames as an independently-encodable "chunk".
 *
 * Stability under a sliding window comes from chunking on an ABSOLUTE
 * grid (anchored to a frozen per-dataset epoch), not on the frame's
 * position in the current window — so a given real frame keeps its
 * chunk no matter where the window now starts. Reuse is keyed on a
 * content hash over the chunk's frame digests (already recorded in
 * `source_filenames.json`), so x264's byte non-determinism is
 * irrelevant: identical inputs ⇒ same hash ⇒ recycle the segment.
 *
 * The runner (`transcode-from-dispatch.ts`) supplies the frame list +
 * the grid offset + the prior manifest, calls `planSegments`, encodes
 * only `encodeChunks`, fills in their measured durations, then calls
 * `assemblePlaylists` and persists the new `SegmentManifest`. None of
 * that I/O lives here.
 */

import { createHash } from 'node:crypto'

import {
  DEFAULT_RENDITIONS,
  DEFAULT_SEGMENT_SECONDS,
  MASTER_PLAYLIST_NAME,
  OUTPUT_FRAME_RATE,
  type HlsRendition,
} from './ffmpeg-hls'

/** Master playlist filename — the per-upload bundle entry point the
 *  `data_ref` points at. Mirrors the encoder's name so the two
 *  paths can never drift. */
export const MASTER_PLAYLIST_FILE = MASTER_PLAYLIST_NAME

/** Frames per chunk = one segment's worth at the pinned encode
 *  settings (6 s × 30 fps). The whole scheme rests on this matching
 *  `ffmpeg-hls.ts`'s `-hls_time` × `OUTPUT_FRAME_RATE`. */
export const FRAMES_PER_CHUNK = DEFAULT_SEGMENT_SECONDS * OUTPUT_FRAME_RATE

/** A frame as recorded in `source_filenames.json`
 *  (`frames-manifest.ts` `parseFrameManifest`). */
export interface FrameEntry {
  index: number
  filename: string
  /** `sha256:<hex>` of the frame bytes. */
  digest: string
}

/** One rendition of the ladder, reduced to what the incremental core
 *  needs. Pixel dims + CRF together form its stable identity. */
export interface RenditionDescriptor {
  /** Stream directory id — `stream_0` / `stream_1` / `stream_2`. */
  id: string
  width: number
  height: number
  /** x264 quality (CRF). Part of the segment identity so a quality
   *  change at the same dimensions forces a re-encode instead of
   *  recycling bytes produced under the old setting. */
  crf: number
}

/** The default ladder projected to `RenditionDescriptor`s, indexed
 *  the same way `buildFfmpegArgs` lays out `stream_%v`. */
export const DEFAULT_RENDITION_DESCRIPTORS: readonly RenditionDescriptor[] =
  DEFAULT_RENDITIONS.map((r: HlsRendition, i: number) => ({
    id: `stream_${i}`,
    width: r.height * 2,
    height: r.height,
    crf: r.crf,
  }))

/** A grid-aligned group of ≤ `FRAMES_PER_CHUNK` consecutive frames
 *  that encodes to exactly one segment per rendition. */
export interface ChunkInput {
  /** Absolute grid cell index: `floor((offset + windowIndex) / 180)`. */
  gridIndex: number
  /** The frames in this chunk, in playback order. */
  frames: FrameEntry[]
  /** True if any frame in the chunk is synthetic (padded). Folded
   *  into the segment hash so a padded→real swap re-encodes. */
  padded: boolean
  /** True when the chunk holds fewer than `FRAMES_PER_CHUNK` frames
   *  (the head/tail of the window) — its segment is shorter than 6 s. */
  partial: boolean
}

/** A produced (or recycled) segment: content key + its measured
 *  duration. `hex` maps to `videos/{dataset}/segments/sha256/{hex}.ts`. */
export interface SegmentRef {
  hex: string
  /** Segment duration in seconds (the `#EXTINF` value). */
  extinf: number
}

/** One chunk's row in the durable per-dataset manifest. */
export interface ManifestChunk {
  gridIndex: number
  frameDigests: string[]
  padded: boolean
  /** Per-rendition segment ref, keyed by `RenditionDescriptor.id`. */
  segments: Record<string, SegmentRef>
}

/**
 * The durable diff state for a dataset, stored at
 * `videos/{dataset}/segment-manifest.json`. It is the incremental
 * analogue of `source_filenames.json`: what the next run loads to
 * decide reuse.
 */
export interface SegmentManifest {
  version: 1
  /** Frozen ISO-8601 anchor for the absolute grid (time-series
   *  rows). Absent for pure-sequence rows. Written once and never
   *  changed, so the grid never shifts. */
  epoch: string | null
  /** Informational: the dataset's cadence at write time. */
  period: string | null
  /** Per-rendition `CODECS` string (e.g. `stream_0` → `avc1.4d4033`),
   *  parsed from ffmpeg's own master on the first encode and carried
   *  forward so reuse-only runs still emit `CODECS` in the master.
   *  Absent only for manifests written before this was tracked. */
  codecs?: Record<string, string>
  /** Rendition ids present in `chunks[*].segments`, in ladder order. */
  renditions: RenditionDescriptor[]
  /** Live chunks in playback order. */
  chunks: ManifestChunk[]
}

/**
 * Absolute grid offset of the window's first frame:
 * `round((startTime − epoch) / period)`. Frames are contiguous at
 * `period` cadence (guaranteed by `pad-missing`), so frame `i`'s grid
 * step is simply `offset + i`. Returns null when the inputs aren't a
 * usable time series (caller then falls back to a full encode).
 */
export function gridOffset(
  startTimeMs: number,
  epochMs: number,
  periodMs: number,
): number | null {
  if (
    !Number.isFinite(startTimeMs) ||
    !Number.isFinite(epochMs) ||
    !Number.isFinite(periodMs) ||
    periodMs <= 0
  ) {
    return null
  }
  // The first frame must land exactly on a cadence step from the
  // frozen epoch (the sequence is contiguous at `period`). If
  // `start_time` has drifted off the grid, rounding would silently
  // mis-bucket every frame into the wrong absolute chunk — return null
  // so the caller falls back to a full encode instead.
  const steps = (startTimeMs - epochMs) / periodMs
  const rounded = Math.round(steps)
  if (Math.abs(steps - rounded) > 1e-6) return null
  return rounded
}

/**
 * Partition the frame list into grid-aligned chunks. `offset` is the
 * absolute grid step of `frames[0]`; frame `i` lands in grid cell
 * `floor((offset + i) / 180)`. `paddedNames` (a set of filenames the
 * pad-missing report flagged) marks chunks that contain synthetic
 * frames.
 */
export function computeChunkGrid(
  frames: readonly FrameEntry[],
  offset: number,
  paddedNames: ReadonlySet<string> = new Set(),
): ChunkInput[] {
  const chunks: ChunkInput[] = []
  let current: ChunkInput | null = null
  for (let i = 0; i < frames.length; i++) {
    const gridIndex = Math.floor((offset + i) / FRAMES_PER_CHUNK)
    if (!current || current.gridIndex !== gridIndex) {
      current = { gridIndex, frames: [], padded: false, partial: false }
      chunks.push(current)
    }
    current.frames.push(frames[i])
    if (paddedNames.has(frames[i].filename)) current.padded = true
  }
  for (const chunk of chunks) {
    chunk.partial = chunk.frames.length < FRAMES_PER_CHUNK
  }
  return chunks
}

/**
 * Content hash identifying a (chunk, rendition) segment. Canonical
 * over `{ gridIndex, rendition dims+CRF, padded, ordered frame
 * digests }` — so the same real frames at the same grid cell always
 * produce the same hex (recycle), and any change (new digest,
 * padded→real, different dimensions or CRF) produces a new hex
 * (re-encode). Codec settings shared across the whole ladder (preset,
 * profile, GOP) aren't per-rendition fields here; a change to those in
 * `ffmpeg-hls.ts` must bump `v` to force a global re-encode.
 */
export function segmentDescriptorHash(
  chunk: Pick<ChunkInput, 'gridIndex' | 'frames' | 'padded'>,
  rendition: RenditionDescriptor,
): string {
  const descriptor = JSON.stringify({
    v: 1,
    grid: chunk.gridIndex,
    rendition: `${rendition.width}x${rendition.height}@crf${rendition.crf}`,
    padded: chunk.padded,
    digests: chunk.frames.map(f => f.digest),
  })
  return createHash('sha256').update(descriptor).digest('hex')
}

/** A chunk's segments laid out for the new manifest. `extinf` is
 *  known for recycled segments (carried from the prior manifest) and
 *  filled in after the encode for fresh ones. */
export interface PlannedChunk {
  gridIndex: number
  frameDigests: string[]
  padded: boolean
  /** Per-rendition segment plan; `extinf` is null until encoded. */
  segments: Record<string, { hex: string; extinf: number | null }>
}

export interface SegmentPlan {
  /** Chunks that must be re-encoded (at least one rendition is new). */
  encodeChunks: ChunkInput[]
  /** Every chunk in playback order, with its per-rendition hexes and
   *  the durations known so far. */
  plannedChunks: PlannedChunk[]
  /** Segment hexes referenced by the prior manifest but not the new
   *  one — GC candidates. */
  orphanHexes: string[]
}

/**
 * Diff the new chunk grid against the prior manifest and decide reuse
 * vs encode. A chunk is recyclable iff EVERY rendition's content hash
 * already exists in the prior manifest (so its bytes are already in
 * the shared store and we know its duration). Pure: the caller does
 * the actual encode + R2 work.
 */
export function planSegments(
  newChunks: readonly ChunkInput[],
  renditions: readonly RenditionDescriptor[],
  prev: SegmentManifest | null,
): SegmentPlan {
  const prevExtinfByHex = new Map<string, number>()
  if (prev) {
    for (const chunk of prev.chunks) {
      for (const ref of Object.values(chunk.segments)) {
        prevExtinfByHex.set(ref.hex, ref.extinf)
      }
    }
  }

  const encodeChunks: ChunkInput[] = []
  const plannedChunks: PlannedChunk[] = []
  const liveHexes = new Set<string>()

  for (const chunk of newChunks) {
    const segments: PlannedChunk['segments'] = {}
    let recyclable = true
    for (const rendition of renditions) {
      const hex = segmentDescriptorHash(chunk, rendition)
      liveHexes.add(hex)
      const extinf = prevExtinfByHex.get(hex)
      segments[rendition.id] = { hex, extinf: extinf ?? null }
      if (extinf === undefined) recyclable = false
    }
    if (!recyclable) encodeChunks.push(chunk)
    plannedChunks.push({
      gridIndex: chunk.gridIndex,
      frameDigests: chunk.frames.map(f => f.digest),
      padded: chunk.padded,
      segments,
    })
  }

  const orphanHexes = [...prevExtinfByHex.keys()].filter(hex => !liveHexes.has(hex))
  return { encodeChunks, plannedChunks, orphanHexes }
}

/**
 * Fold the measured per-chunk segment durations (from the fresh
 * encodes) into the plan, producing the finished `SegmentManifest`.
 * `extinfByHex` must cover every freshly-encoded segment hex; recycled
 * segments already carry their duration. Throws if any segment is
 * still missing a duration — a programming error that would otherwise
 * yield a playlist with a bad `#EXTINF`.
 */
export function finalizeManifest(
  plan: SegmentPlan,
  renditions: readonly RenditionDescriptor[],
  extinfByHex: ReadonlyMap<string, number>,
  meta: { epoch: string | null; period: string | null; codecs?: Record<string, string> },
): SegmentManifest {
  const chunks: ManifestChunk[] = plan.plannedChunks.map(planned => {
    const segments: Record<string, SegmentRef> = {}
    for (const [rid, ref] of Object.entries(planned.segments)) {
      const extinf = ref.extinf ?? extinfByHex.get(ref.hex)
      if (extinf == null) {
        throw new Error(`finalizeManifest: missing duration for segment ${ref.hex}`)
      }
      segments[rid] = { hex: ref.hex, extinf }
    }
    return {
      gridIndex: planned.gridIndex,
      frameDigests: planned.frameDigests,
      padded: planned.padded,
      segments,
    }
  })
  return {
    version: 1,
    epoch: meta.epoch,
    period: meta.period,
    ...(meta.codecs ? { codecs: meta.codecs } : {}),
    renditions: [...renditions],
    chunks,
  }
}

// --- Playlist assembly --------------------------------------------

/** Relative URI from a variant playlist
 *  (`{upload}/stream_N/playlist.m3u8`) to a shared content-addressed
 *  segment (`segments/sha256/{hex}.ts`) — both under the dataset
 *  prefix, so up two levels then into the shared store. */
export function segmentUri(hex: string): string {
  return `../../segments/sha256/${hex}.ts`
}

/** R2 key (relative to the dataset prefix) for a shared segment. */
export function segmentKey(hex: string): string {
  return `segments/sha256/${hex}.ts`
}

function formatExtinf(seconds: number): string {
  return seconds.toFixed(6)
}

/**
 * Build one rendition's VOD media playlist from its ordered segments.
 * Matches the shape ffmpeg's HLS muxer emits (VERSION 3, VOD type,
 * per-segment `#EXTINF`, `#EXT-X-ENDLIST`) so hls.js/Safari play it
 * identically. `#EXT-X-TARGETDURATION` is `ceil(max EXTINF)`.
 *
 * Each segment is encoded independently, so its internal PTS restarts
 * at the muxer's base (~1.4 s) rather than continuing the previous
 * segment's timeline. `#EXT-X-DISCONTINUITY` before every segment
 * after the first tells the player to reset its timestamp mapping at
 * each boundary — without it, hls.js sees overlapping PTS across
 * segments and stalls. (A single-segment playlist needs no
 * discontinuity; the first fragment's PTS offset is handled natively.)
 */
export function buildVariantPlaylist(segments: readonly SegmentRef[]): string {
  const target = segments.reduce((max, s) => Math.max(max, s.extinf), 0)
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(target))}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ]
  segments.forEach((seg, i) => {
    if (i > 0) lines.push('#EXT-X-DISCONTINUITY')
    lines.push(`#EXTINF:${formatExtinf(seg.extinf)},`)
    lines.push(segmentUri(seg.hex))
  })
  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n') + '\n'
}

export interface MasterVariant {
  /** `stream_0` etc. — the variant playlist lives at `{id}/playlist.m3u8`. */
  id: string
  /** Average bitrate in bits/sec for `BANDWIDTH`. */
  bandwidth: number
  width: number
  height: number
  /** `CODECS` attribute (e.g. `avc1.4d4033`). hls.js needs this to set
   *  up MSE before the first segment is probed — omitting it leaves the
   *  player unable to reach `canplay` for some content. Always supply
   *  it (parsed from ffmpeg's own master), matching the full-encode
   *  bundles. */
  codecs?: string
}

/**
 * Build the master playlist referencing each rendition's variant
 * playlist by the same relative `stream_N/playlist.m3u8` path the
 * existing encoder emits — so `/manifest` resolution and the
 * `data_ref` contract are unchanged.
 */
export function buildMasterPlaylist(variants: readonly MasterVariant[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3']
  for (const v of variants) {
    const attrs = [
      `BANDWIDTH=${Math.max(1, Math.round(v.bandwidth))}`,
      `RESOLUTION=${v.width}x${v.height}`,
    ]
    if (v.codecs) attrs.push(`CODECS="${v.codecs}"`)
    lines.push(`#EXT-X-STREAM-INF:${attrs.join(',')}`)
    lines.push(`${v.id}/playlist.m3u8`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Assemble the full per-upload bundle's playlists from a finished
 * manifest. Returns the master + one variant playlist per rendition,
 * keyed by relative path under the upload prefix. The runner writes
 * these into `videos/{dataset}/{upload}/`; the segments they point at
 * already live in the shared store.
 */
export function assemblePlaylists(
  manifest: SegmentManifest,
  bandwidthByRendition: ReadonlyMap<string, number>,
  codecsByRendition: ReadonlyMap<string, string> = new Map(),
): { master: string; variants: Record<string, string> } {
  const variants: Record<string, string> = {}
  const masterVariants: MasterVariant[] = []

  for (const rendition of manifest.renditions) {
    const segs: SegmentRef[] = manifest.chunks.map(chunk => {
      const ref = chunk.segments[rendition.id]
      if (!ref) {
        throw new Error(
          `assemblePlaylists: chunk ${chunk.gridIndex} has no ${rendition.id} segment`,
        )
      }
      return ref
    })
    variants[`${rendition.id}/playlist.m3u8`] = buildVariantPlaylist(segs)
    masterVariants.push({
      id: rendition.id,
      bandwidth: bandwidthByRendition.get(rendition.id) ?? 1,
      width: rendition.width,
      height: rendition.height,
      codecs: codecsByRendition.get(rendition.id),
    })
  }

  return { master: buildMasterPlaylist(masterVariants), variants }
}
