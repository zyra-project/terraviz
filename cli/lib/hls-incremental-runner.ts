/**
 * Incremental HLS re-encoding — runner orchestration
 * (`docs/INCREMENTAL_HLS_PLAN.md`, Stages 2 + 3).
 *
 * Drives one incremental transcode: load the prior segment manifest,
 * diff the new frame grid, encode only the changed chunks, recycle
 * the rest, assemble + publish the per-upload playlists, persist the
 * new manifest, and GC the segments no longer referenced.
 *
 * All I/O is behind the `IncrementalDeps` seam so this file is
 * unit-tested with in-memory fakes — no real ffmpeg or R2. The thin
 * wiring that supplies the real seams (R2 GET/PUT/HEAD/LIST/DELETE,
 * a per-chunk `encodeHls`, and the dataset time window) lives in
 * `cli/transcode-from-dispatch.ts`.
 */

import {
  assemblePlaylists,
  computeChunkGrid,
  finalizeManifest,
  MASTER_PLAYLIST_FILE,
  planSegments,
  segmentDescriptorHash,
  type FrameEntry,
  type RenditionDescriptor,
  type SegmentManifest,
} from './hls-incremental'

/** The I/O surface the orchestration needs. Real implementations
 *  (R2 + ffmpeg) are supplied by the runner; tests inject fakes. */
export interface IncrementalDeps {
  /** Load `videos/{dataset}/segment-manifest.json`, or null when
   *  absent (cold start → every chunk encodes). */
  loadManifest(): Promise<SegmentManifest | null>
  /** Persist the new manifest. */
  saveManifest(manifest: SegmentManifest): Promise<void>
  /** Encode one chunk's frames → one `.ts` per rendition (bytes keyed
   *  by `RenditionDescriptor.id`), the segment's measured `extinf`
   *  (ffmpeg's emitted `#EXTINF`, identical across renditions for the
   *  same chunk — same frame count + fps), and the per-rendition
   *  `CODECS` strings ffmpeg computed for its own master (constant
   *  across chunks, so the runner captures them once). One ffmpeg call
   *  produces all renditions (the `split`/`scale` filter graph). */
  encodeChunk(frames: readonly FrameEntry[]): Promise<{
    segments: Record<string, Uint8Array>
    extinf: number
    codecs?: Record<string, string>
  }>
  /** HEAD `segments/sha256/{hex}.ts` — skip the PUT when it exists
   *  (content-addressed ⇒ identical bytes already there). */
  segmentExists(hex: string): Promise<boolean>
  /** PUT a freshly-encoded segment to the shared store. */
  putSegment(hex: string, body: Uint8Array): Promise<void>
  /** Write the per-upload playlists (`master.m3u8` +
   *  `stream_N/playlist.m3u8`) under the upload prefix. */
  uploadPlaylists(files: Record<string, string>): Promise<void>
  /** GC: every segment hex currently in the shared store. */
  listSegmentHexes(): Promise<string[]>
  /** GC: delete these segment hexes. */
  deleteSegments(hexes: readonly string[]): Promise<void>
  log?: (line: string) => void
}

export interface IncrementalParams {
  frames: readonly FrameEntry[]
  renditions: readonly RenditionDescriptor[]
  /** Absolute grid offset of `frames[0]` (from `gridOffset()`). */
  offset: number
  /** Frozen epoch + cadence recorded in the manifest. `epoch` must
   *  be carried over unchanged from the prior manifest when present. */
  epoch: string | null
  period: string | null
  /** Per-rendition `BANDWIDTH` (bits/sec) for the master playlist. */
  bandwidthByRendition: ReadonlyMap<string, number>
  /** Filenames the pad-missing report flagged as synthetic, so chunks
   *  containing them are marked `padded` in the manifest. A padded→real
   *  swap already re-encodes via the frame-digest change (synthetic and
   *  real frames hash differently), so this only refines the manifest's
   *  provenance signal; the live runner passes it once the pad-report
   *  is wired to the transcode dispatch. */
  paddedNames?: ReadonlySet<string>
}

export interface IncrementalResult {
  totalChunks: number
  encodedChunks: number
  reusedChunks: number
  uploadedSegments: number
  prunedSegments: number
}

/**
 * Run one incremental transcode. Returns counts for the run summary;
 * throws on a hard failure (encode error, a missing rendition in the
 * encode output). GC failures are swallowed — a stranded segment is a
 * storage nit, never a reason to fail a published run.
 */
export async function runIncremental(
  deps: IncrementalDeps,
  params: IncrementalParams,
): Promise<IncrementalResult> {
  const log = deps.log ?? (() => {})
  const prev = await deps.loadManifest()
  const newChunks = computeChunkGrid(params.frames, params.offset, params.paddedNames)
  const plan = planSegments(newChunks, params.renditions, prev)

  // The grid epoch is frozen on first write and must never change, or
  // grid-cell assignment (and therefore reuse) drifts. When a prior
  // manifest exists its epoch is authoritative — the caller is
  // expected to derive `offset` from it, but enforce here too so a
  // drifted `params.epoch` can't silently corrupt the persisted grid.
  // Use an explicit prev-presence check (not `??`) so a prior
  // `epoch: null` (pure-sequence manifest) is preserved even if the
  // caller passes a non-null epoch.
  const epoch = prev ? prev.epoch : params.epoch
  if (prev && prev.epoch !== params.epoch) {
    log(
      `WARN: ignoring caller epoch ${params.epoch ?? 'null'} — keeping frozen ` +
        `manifest epoch ${prev.epoch ?? 'null'}`,
    )
  }
  log(
    `incremental: ${newChunks.length} chunks — ${plan.encodeChunks.length} to encode, ` +
      `${newChunks.length - plan.encodeChunks.length} reused`,
  )

  // Encode the changed chunks → content-addressed segment PUTs. The
  // segment duration is whatever ffmpeg actually emitted as `#EXTINF`
  // (the encoder pins -framerate 30 -r 30, so a full 180-frame chunk
  // is 6.0 s, but partial head/tail chunks and muxer rounding are
  // carried verbatim rather than assumed to be frames/30).
  const extinfByHex = new Map<string, number>()
  let uploadedSegments = 0
  // CODECS strings are constant across chunks (same encoder + ladder),
  // so capture them from the first fresh encode; fall back to the prior
  // manifest when this run reused every chunk (no encode happened).
  let codecs: Record<string, string> | undefined
  for (const chunk of plan.encodeChunks) {
    const produced = await deps.encodeChunk(chunk.frames)
    if (produced.codecs && !codecs) codecs = produced.codecs
    for (const rendition of params.renditions) {
      const hex = segmentDescriptorHash(chunk, rendition)
      extinfByHex.set(hex, produced.extinf)
      const body = produced.segments[rendition.id]
      if (!body) {
        throw new Error(`runIncremental: encodeChunk produced no ${rendition.id} segment`)
      }
      if (!(await deps.segmentExists(hex))) {
        await deps.putSegment(hex, body)
        uploadedSegments++
      }
    }
  }
  const resolvedCodecs = codecs ?? prev?.codecs

  // Stitch recycled + fresh segments into the per-upload playlists.
  const manifest = finalizeManifest(plan, params.renditions, extinfByHex, {
    epoch,
    period: params.period,
    codecs: resolvedCodecs,
  })
  const codecsByRendition = new Map(Object.entries(manifest.codecs ?? {}))
  const { master, variants } = assemblePlaylists(
    manifest,
    params.bandwidthByRendition,
    codecsByRendition,
  )
  await deps.uploadPlaylists({ [MASTER_PLAYLIST_FILE]: master, ...variants })
  await deps.saveManifest(manifest)

  // GC with a one-run grace window: keep the new live set AND the
  // immediately-prior set (protecting clients mid-playback against the
  // old master); delete everything else. Best-effort.
  const prunedSegments = await pruneSegments(deps, manifest, prev, log)

  return {
    totalChunks: newChunks.length,
    encodedChunks: plan.encodeChunks.length,
    reusedChunks: newChunks.length - plan.encodeChunks.length,
    uploadedSegments,
    prunedSegments,
  }
}

/** Mark-and-sweep the shared segment store. Returns the count
 *  deleted (0 on any GC error — never fatal). */
async function pruneSegments(
  deps: IncrementalDeps,
  manifest: SegmentManifest,
  prev: SegmentManifest | null,
  log: (line: string) => void,
): Promise<number> {
  const keep = new Set<string>()
  for (const m of [manifest, prev]) {
    if (!m) continue
    for (const chunk of m.chunks) {
      for (const ref of Object.values(chunk.segments)) keep.add(ref.hex)
    }
  }
  try {
    const all = await deps.listSegmentHexes()
    const orphans = all.filter(hex => !keep.has(hex))
    if (orphans.length === 0) return 0
    await deps.deleteSegments(orphans)
    log(`incremental GC: pruned ${orphans.length} orphaned segment(s)`)
    return orphans.length
  } catch (err) {
    log(`WARN: segment GC failed (continuing) — ${err instanceof Error ? err.message : String(err)}`)
    return 0
  }
}
