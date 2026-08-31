// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { frameRateFromMoov, detectVideoFrameRate } from './mp4-frame-rate'

// ---------------------------------------------------------------------------
// Box builders
//
// Synthetic rather than a fixture file: the point of moving the frame
// rate read into the container was that it needs no decoder, and a test
// that needs a real MP4 would give that back. These build the exact
// structures the parser walks, which also makes the malformed cases
// expressible — you cannot easily produce a truncated `stts` with
// ffmpeg.
// ---------------------------------------------------------------------------

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length)
  const size = out.length
  out[0] = (size >>> 24) & 0xff
  out[1] = (size >>> 16) & 0xff
  out[2] = (size >>> 8) & 0xff
  out[3] = size & 0xff
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(payload, 8)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

function u32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4)
  values.forEach((v, i) => {
    out[i * 4] = (v >>> 24) & 0xff
    out[i * 4 + 1] = (v >>> 16) & 0xff
    out[i * 4 + 2] = (v >>> 8) & 0xff
    out[i * 4 + 3] = v & 0xff
  })
  return out
}

/** `hdlr`: version+flags, pre_defined, handler_type. */
function hdlr(kind: string): Uint8Array {
  return box('hdlr', concat(u32(0, 0), new Uint8Array([...kind].map(c => c.charCodeAt(0)))))
}

/** `mdhd` v0: version+flags, creation, modification, timescale, duration. */
function mdhd(scale: number, duration = 0, version = 0): Uint8Array {
  if (version !== 0 && version !== 1) {
    // Same layout as v0, but carrying an unknown version byte — the
    // parser should refuse rather than read it as v0.
    return box('mdhd', concat(
      new Uint8Array([version, 0, 0, 0]),
      u32(0, 0),
      u32(scale),
      u32(duration),
    ))
  }
  if (version === 1) {
    // version(1)+flags(3), creation(8), modification(8), timescale(4), duration(8)
    return box('mdhd', concat(
      new Uint8Array([1, 0, 0, 0]),
      u32(0, 0, 0, 0),
      u32(scale),
      u32(0, duration),
    ))
  }
  return box('mdhd', concat(u32(0, 0, 0), u32(scale), u32(duration)))
}

/** `stts`: version+flags, entry_count, then (sample_count, sample_delta)*. */
function stts(entries: Array<[count: number, delta: number]>): Uint8Array {
  return box('stts', concat(
    u32(0),
    u32(entries.length),
    ...entries.map(([c, d]) => u32(c, d)),
  ))
}

function videoTrak(opts: {
  scale?: number
  entries?: Array<[number, number]>
  handler?: string
  mdhdVersion?: number
  omitStts?: boolean
} = {}): Uint8Array {
  const { scale = 30000, entries = [[300, 1000]], handler = 'vide', mdhdVersion = 0 } = opts
  const stbl = box('stbl', opts.omitStts ? new Uint8Array(0) : stts(entries))
  const minf = box('minf', stbl)
  const mdia = box('mdia', concat(mdhd(scale, 0, mdhdVersion), hdlr(handler), minf))
  return box('trak', mdia)
}

/** The payload of a `moov` — what `frameRateFromMoov` takes. */
function moovPayload(...traks: Uint8Array[]): Uint8Array {
  return concat(...traks)
}

// ---------------------------------------------------------------------------

describe('frameRateFromMoov', () => {
  it('reads 30 fps from a constant-rate track', () => {
    // timescale 30000, delta 1000 → 30 fps, which is what the catalog's
    // own encoder emits.
    expect(frameRateFromMoov(moovPayload(videoTrak()))).toBeCloseTo(30, 6)
  })

  it('reads a non-30 rate, which is the case the caller warns about', () => {
    const fps = frameRateFromMoov(
      moovPayload(videoTrak({ scale: 25000, entries: [[250, 1000]] })),
    )
    expect(fps).toBeCloseTo(25, 6)
  })

  it('averages across multiple stts runs rather than trusting the first', () => {
    // A short irregular run at the head is common; reading only the
    // first entry would report 15 fps for a file that is almost
    // entirely 30.
    const fps = frameRateFromMoov(
      moovPayload(videoTrak({ scale: 30000, entries: [[2, 2000], [298, 1000]] })),
    )
    expect(fps).toBeGreaterThan(29.8)
    expect(fps).toBeLessThan(30)
  })

  it('skips non-video tracks and reads the video one', () => {
    // An audio track's mdhd timescale is its sample rate — 48000 with
    // 1024-sample frames would read as ~47 fps if the walk took the
    // first track it found.
    const audio = videoTrak({ handler: 'soun', scale: 48000, entries: [[1000, 1024]] })
    const video = videoTrak({ scale: 30000, entries: [[300, 1000]] })
    expect(frameRateFromMoov(moovPayload(audio, video))).toBeCloseTo(30, 6)
  })

  it('handles a 64-bit mdhd (version 1)', () => {
    const fps = frameRateFromMoov(
      moovPayload(videoTrak({ mdhdVersion: 1, scale: 60000, entries: [[600, 1000]] })),
    )
    expect(fps).toBeCloseTo(60, 6)
  })

  it('returns null when there is no video track', () => {
    expect(frameRateFromMoov(moovPayload(videoTrak({ handler: 'soun' })))).toBeNull()
  })

  it('returns null when stts is absent — a fragmented file has no samples here', () => {
    expect(frameRateFromMoov(moovPayload(videoTrak({ omitStts: true })))).toBeNull()
  })

  it('returns null on an stts whose entries run past the box', () => {
    // entry_count claims two, payload carries one.
    const truncated = box('stts', concat(u32(0), u32(2), u32(300, 1000)))
    const stbl = box('stbl', truncated)
    const mdia = box('mdia', concat(mdhd(30000), hdlr('vide'), box('minf', stbl)))
    expect(frameRateFromMoov(moovPayload(box('trak', mdia)))).toBeNull()
  })

  it('returns null on an mdhd version it does not know', () => {
    // ISO BMFF defines 0 and 1. Treating anything else as version 0
    // reads whatever sits at that offset, which can be a perfectly
    // plausible timescale from an unrelated field.
    expect(frameRateFromMoov(moovPayload(videoTrak({ mdhdVersion: 7 })))).toBeNull()
  })

  it('returns null on a zero timescale rather than dividing by it', () => {
    expect(frameRateFromMoov(moovPayload(videoTrak({ scale: 0 })))).toBeNull()
  })

  it('returns null on an implausible rate', () => {
    // timescale 30000 with a 1-tick delta is 30 000 fps: a misread
    // field, not a video.
    expect(frameRateFromMoov(moovPayload(videoTrak({ entries: [[300, 1]] })))).toBeNull()
  })

  it('returns null on empty or garbage input rather than throwing', () => {
    expect(frameRateFromMoov(new Uint8Array(0))).toBeNull()
    expect(frameRateFromMoov(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull()
    expect(frameRateFromMoov(new Uint8Array(64).fill(0xff))).toBeNull()
  })
})

describe('detectVideoFrameRate', () => {
  /** `Blob` wants an `ArrayBuffer`, and a `Uint8Array` view is not one
   *  under the current lib types, so copy into a fresh buffer. */
  function blobOf(bytes: Uint8Array): Blob {
    const buf = new ArrayBuffer(bytes.length)
    new Uint8Array(buf).set(bytes)
    return new Blob([buf])
  }

  function file(...boxes: Uint8Array[]): Blob {
    return blobOf(concat(...boxes))
  }

  it('finds a moov placed first, as +faststart writes it', async () => {
    const f = file(
      box('ftyp', u32(0, 0)),
      box('moov', moovPayload(videoTrak())),
      box('mdat', new Uint8Array(1024)),
    )
    await expect(detectVideoFrameRate(f)).resolves.toBeCloseTo(30, 6)
  })

  it('finds a moov placed after the media, as a single-pass write leaves it', async () => {
    // The reason the walk follows box sizes instead of scanning a head
    // slice: here the moov is past a payload that could be gigabytes.
    const f = file(
      box('ftyp', u32(0, 0)),
      box('mdat', new Uint8Array(4096)),
      box('moov', moovPayload(videoTrak({ scale: 24000, entries: [[240, 1000]] }))),
    )
    await expect(detectVideoFrameRate(f)).resolves.toBeCloseTo(24, 6)
  })

  it('returns null when there is no moov at all', async () => {
    await expect(detectVideoFrameRate(file(box('ftyp', u32(0, 0))))).resolves.toBeNull()
  })

  it('returns null on a non-MP4 rather than throwing', async () => {
    await expect(detectVideoFrameRate(new Blob(['not an mp4 at all']))).resolves.toBeNull()
  })

  it('returns null on an empty file', async () => {
    await expect(detectVideoFrameRate(new Blob([]))).resolves.toBeNull()
  })

  it('terminates on a box whose size claims more than the file holds', async () => {
    // A truncated download: the header says 4 GB, the file is 16 bytes.
    const lying = new Uint8Array(16)
    lying.set([0xff, 0xff, 0xff, 0xff], 0)
    lying.set([...'mdat'].map(c => c.charCodeAt(0)), 4)
    await expect(detectVideoFrameRate(blobOf(lying))).resolves.toBeNull()
  })
})
