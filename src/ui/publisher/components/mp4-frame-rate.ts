// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Read a video's frame rate out of its MP4 container, without decoding
 * it.
 *
 * The publisher portal needs this because publishing a data-encoded
 * video *as uploaded* skips the transcode, and the transcode is what
 * normally forces 30 fps — which `tourEngine` assumes when it computes
 * `playbackRate = requestedFps / 30`. A 25 fps file published as-is
 * plays every tour on it at the wrong speed, silently.
 *
 * The first version of this measured frame rate by playing the file and
 * timing `requestVideoFrameCallback` gaps. That worked, but it needed
 * the browser to *decode* the file — so it returned nothing on exactly
 * the publisher most likely to need the answer, a Firefox user
 * uploading HEVC. Reading the container instead is exact rather than
 * estimated, costs no decode, and works whatever the codec.
 *
 * ## What it reads
 *
 * An MP4 is a tree of boxes, each `size(4) type(4)` then payload. The
 * frame rate lives in the movie header:
 *
 *     moov → trak (the one whose mdia/hdlr is 'vide')
 *              → mdia → mdhd            timescale (ticks per second)
 *                     → minf → stbl → stts   sample counts + deltas
 *
 * `stts` is a run-length table of sample durations in timescale ticks.
 * Summing it gives total samples and total ticks, and the quotient —
 * scaled by the timescale — is the frame rate. Summing rather than
 * reading the first entry so a file with a short irregular run at the
 * start (or genuinely variable frame timing) still yields its average
 * rather than a misleading instantaneous value.
 *
 * ## What it does when it cannot
 *
 * Returns `null`, always. Every parse step is bounds-checked and every
 * failure — truncation, a missing box, a fragmented file with no `stts`
 * samples, an implausible result — takes the same exit. The caller uses
 * this to raise an advisory warning, so silence is an acceptable answer
 * and a wrong number is not.
 */

/** Bytes of box header to read when walking: 8 normally, 16 when the
 *  box uses a 64-bit `largesize`. */
const MAX_HEADER = 16

/** Anything outside this is a parse error rather than a frame rate.
 *  Real content sits between about 1 and 240; the bounds only exist to
 *  reject nonsense produced by misreading a field. */
const MIN_PLAUSIBLE_FPS = 0.1
const MAX_PLAUSIBLE_FPS = 1000

interface Box {
  type: string
  /** Offset of the payload's first byte, relative to the buffer start. */
  start: number
  /** Offset one past the payload's last byte. */
  end: number
}

function readU32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
}

function readType(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])
}

/**
 * Parse one box header at `at`.
 *
 * `size === 1` means the real size is a 64-bit value after the type;
 * `size === 0` means "to the end of the enclosing extent". Both are in
 * the spec and both appear in the wild — `size === 0` on the final
 * `mdat` of a stream-written file, `size === 1` on anything over 4 GB.
 */
function readBoxHeader(b: Uint8Array, at: number, limit: number): Box | null {
  if (at + 8 > limit) return null
  const size32 = readU32(b, at)
  const type = readType(b, at + 4)
  let headerSize = 8
  let size = size32
  if (size32 === 1) {
    if (at + 16 > limit) return null
    // JS numbers hold 2^53 exactly, and the high word only matters
    // above 4 GB, so this is lossless for any real file.
    size = readU32(b, at + 8) * 0x100000000 + readU32(b, at + 12)
    headerSize = 16
  } else if (size32 === 0) {
    size = limit - at
  }
  if (size < headerSize) return null
  const end = at + size
  if (end > limit) return null
  return { type, start: at + headerSize, end }
}

/** Direct children of the extent `[start, end)`. */
function children(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = []
  let at = start
  while (at + 8 <= end) {
    const box = readBoxHeader(b, at, end)
    if (!box) break
    out.push(box)
    // A zero-length advance would spin; `readBoxHeader` rejects
    // `size < headerSize`, so this is belt and braces.
    if (box.end <= at) break
    at = box.end
  }
  return out
}

function findChild(b: Uint8Array, parent: Box, type: string): Box | null {
  return children(b, parent.start, parent.end).find(c => c.type === type) ?? null
}

/** Walk a path of box types from a parent, e.g. `mdia/minf/stbl`. */
function descend(b: Uint8Array, from: Box, path: string[]): Box | null {
  let cur: Box | null = from
  for (const type of path) {
    if (!cur) return null
    cur = findChild(b, cur, type)
  }
  return cur
}

/** `hdlr` handler type — 'vide' for the video track. */
function handlerType(b: Uint8Array, hdlr: Box): string | null {
  // version(1) flags(3) pre_defined(4) handler_type(4)
  if (hdlr.start + 12 > hdlr.end) return null
  return readType(b, hdlr.start + 8)
}

/** `mdhd` timescale, in ticks per second. */
function timescale(b: Uint8Array, mdhd: Box): number | null {
  if (mdhd.start + 4 > mdhd.end) return null
  const version = b[mdhd.start]
  // ISO BMFF defines versions 0 and 1 for this box and nothing else.
  // Treating an unknown version as 0 would read whatever happens to sit
  // at that offset and could return a perfectly plausible frame rate
  // from an unrelated field — the one outcome this module is built to
  // avoid, since a wrong number is worse than none.
  if (version !== 0 && version !== 1) return null
  // version(1) flags(3), then creation/modification (4 or 8 each).
  const at = mdhd.start + 4 + (version === 1 ? 16 : 8)
  if (at + 4 > mdhd.end) return null
  const ts = readU32(b, at)
  return ts > 0 ? ts : null
}

/** Total samples and total duration in ticks, summed over `stts`. */
function sttsTotals(b: Uint8Array, stts: Box): { samples: number; ticks: number } | null {
  // version(1) flags(3) entry_count(4)
  if (stts.start + 8 > stts.end) return null
  const count = readU32(b, stts.start + 4)
  let samples = 0
  let ticks = 0
  for (let i = 0; i < count; i++) {
    const at = stts.start + 8 + i * 8
    if (at + 8 > stts.end) return null
    const sampleCount = readU32(b, at)
    const sampleDelta = readU32(b, at + 4)
    samples += sampleCount
    ticks += sampleCount * sampleDelta
  }
  return samples > 0 && ticks > 0 ? { samples, ticks } : null
}

/**
 * Frame rate from a `moov` box's payload, or null.
 *
 * Exported because it is the whole of the logic and it is pure — the
 * async wrapper below only locates the bytes. Tests build synthetic
 * boxes and call this directly, which needs no video support in the
 * test environment.
 *
 * `moovPayload` is the contents of the `moov` box, not including its
 * own 8-byte header.
 */
export function frameRateFromMoov(moovPayload: Uint8Array): number | null {
  const root: Box = { type: 'moov', start: 0, end: moovPayload.length }
  for (const trak of children(moovPayload, root.start, root.end)) {
    if (trak.type !== 'trak') continue
    const hdlr = descend(moovPayload, trak, ['mdia', 'hdlr'])
    // A `moov` carries every track — audio, subtitles, timed metadata.
    // Only the video one has a frame rate worth reporting, and picking
    // the first track blindly would read an audio track's sample rate
    // as though it were one.
    if (!hdlr || handlerType(moovPayload, hdlr) !== 'vide') continue

    const mdhd = descend(moovPayload, trak, ['mdia', 'mdhd'])
    const stts = descend(moovPayload, trak, ['mdia', 'minf', 'stbl', 'stts'])
    if (!mdhd || !stts) return null

    const ts = timescale(moovPayload, mdhd)
    const totals = sttsTotals(moovPayload, stts)
    if (ts === null || totals === null) return null

    const fps = (totals.samples * ts) / totals.ticks
    if (!Number.isFinite(fps) || fps < MIN_PLAUSIBLE_FPS || fps > MAX_PLAUSIBLE_FPS) {
      return null
    }
    return fps
  }
  return null
}

/**
 * Locate the `moov` box in a file and read its frame rate.
 *
 * Walks the top-level boxes by reading each 16-byte header and jumping
 * by its size, so a file with a multi-gigabyte `mdat` before its `moov`
 * costs a handful of tiny reads rather than a full load. `moov` is
 * commonly first (`-movflags +faststart`) and commonly last (anything
 * written in one pass); both are reached the same way.
 *
 * Never throws. Any malformed structure, unreadable slice or missing
 * box returns null, because the caller's warning is advisory and a
 * wrong frame rate would be worse than none.
 */
export async function detectVideoFrameRate(file: Blob): Promise<number | null> {
  try {
    let at = 0
    // A file made entirely of tiny boxes would otherwise spin; no real
    // MP4 has anything like this many at the top level.
    for (let guard = 0; guard < 4096; guard++) {
      if (at + 8 > file.size) return null
      const headerBytes = new Uint8Array(
        await file.slice(at, Math.min(at + MAX_HEADER, file.size)).arrayBuffer(),
      )
      if (headerBytes.length < 8) return null

      // Parsed here rather than through `readBoxHeader`, which validates
      // that the whole box fits its extent — true of a box inside a
      // buffer, false of one whose header we have read in isolation.
      // The size is checked against the *file* instead, just below.
      const size32 = readU32(headerBytes, 0)
      const type = readType(headerBytes, 4)
      const headerSize = size32 === 1 ? 16 : 8
      if (headerBytes.length < headerSize) return null
      const boxSize =
        size32 === 0
          ? file.size - at
          : size32 === 1
            ? readU32(headerBytes, 8) * 0x100000000 + readU32(headerBytes, 12)
            : size32
      // A size smaller than its own header, or one claiming more than
      // the file holds, means a truncated or malformed file.
      if (boxSize < headerSize || at + boxSize > file.size) return null

      if (type === 'moov') {
        const payload = new Uint8Array(
          await file.slice(at + headerSize, at + boxSize).arrayBuffer(),
        )
        return frameRateFromMoov(payload)
      }
      at += boxSize
    }
    return null
  } catch {
    return null
  }
}
