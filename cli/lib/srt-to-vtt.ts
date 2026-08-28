// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * SRT → WebVTT converter. Phase 3b uses this inline during the
 * caption-asset migration so every caption in R2 ends up as
 * `.vtt` regardless of the upstream NOAA format (all 35 current
 * SOS captions ship as `.srt`).
 *
 * The transform is well-defined and small enough to implement
 * inline rather than pulling in a dependency:
 *
 *   1. Prepend the `WEBVTT` magic header (a single blank line
 *      separator is part of the WebVTT grammar — `WEBVTT\n\n`).
 *   2. Replace comma decimal separators in cue timestamps with
 *      periods. SRT writes `00:00:01,500`; VTT writes
 *      `00:00:01.500`. The match is targeted at the timestamp
 *      line specifically (a cue's "00:00:00,000 --> 00:00:01,500"
 *      arrow line) so commas in dialogue text aren't touched.
 *   3. Strip a leading UTF-8 BOM if present — some authoring
 *      tools emit one and the WebVTT parser rejects a BOM in
 *      front of the magic header.
 *   4. Normalize line endings to `\n` (WebVTT spec allows
 *      `\r\n` and `\r` but normalizing makes downstream R2
 *      hashing / byte comparison stable).
 *
 * The cue numbering line that SRT carries (a bare integer above
 * each cue's timestamp) is *legal* in WebVTT — it's just an
 * optional cue identifier — so we leave it alone. The output is
 * byte-for-byte identical to the input for SRT files that don't
 * use comma timestamps (rare but possible for tooling that
 * already emits dot-separated decimals).
 */

const VTT_HEADER = 'WEBVTT\n\n'

/**
 * Convert SRT subtitle text to WebVTT. Pure function; no
 * filesystem or network. Caller owns the SRT input as a UTF-8
 * string (typically `new TextDecoder('utf-8').decode(bytes)`
 * from the asset-fetch helper in 3b/D).
 *
 * Returns the VTT body as a UTF-8 string. Empty input produces
 * `WEBVTT\n\n` (a valid empty caption file) rather than throwing
 * — callers that want stricter validation can check `input.length`
 * before calling.
 */
/** UTF-8 BOM as an explicit code-point escape. Using a literal
 * U+FEFF in source is invisible in most editors and trivially
 * eaten by an over-eager formatter. The escape form keeps the
 * intent unambiguous for the next reader. */
const UTF8_BOM = String.fromCharCode(0xFEFF)

export function srtToVtt(srtText: string): string {
  let body = srtText
  if (body.startsWith(UTF8_BOM)) body = body.slice(1)
  body = body.replace(/\r\n?/g, '\n')
  // SRT cue arrow lines look like:
  //   00:00:00,500 --> 00:00:01,200
  // optionally followed by cue-position settings. The full WebVTT
  // arrow grammar is "<timestamp> --> <timestamp>[ settings]" so
  // we match the timestamps on either side and swap their
  // decimal separators. Anchored on the arrow `-->` so a stray
  // line like "look, ma" in dialogue isn't touched.
  body = body.replace(
    /(\d{1,2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}),(\d{3})/g,
    '$1.$2 --> $3.$4',
  )
  return VTT_HEADER + body
}

/**
 * Convenience: convert a raw byte buffer (UTF-8) to a VTT buffer
 * (UTF-8). Used by the migrate-r2-assets pump (3b/G) so the
 * caller doesn't have to thread the encoder dance manually.
 */
export function srtBytesToVttBytes(srt: Uint8Array): Uint8Array {
  const text = new TextDecoder('utf-8').decode(srt)
  return new TextEncoder().encode(srtToVtt(text))
}
