// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for `cli/lib/srt-to-vtt.ts` (Phase 3b commit E).
 *
 * Coverage:
 *   - Header: every output starts with `WEBVTT\n\n`.
 *   - Timestamp conversion: comma → period on both sides of the
 *     arrow; multiple cues; cues that span multi-hour timestamps.
 *   - Dialogue commas preserved.
 *   - Cue numbering preserved (legal in VTT as cue identifier).
 *   - BOM strip.
 *   - CRLF / CR line endings normalized to LF.
 *   - Empty input → minimal valid VTT file.
 *   - srtBytesToVttBytes round-trip through UTF-8.
 */

import { describe, expect, it } from 'vitest'
import { srtBytesToVttBytes, srtToVtt } from './srt-to-vtt'

describe('srtToVtt — header', () => {
  it('always emits the WEBVTT magic header followed by a blank line', () => {
    expect(srtToVtt('').startsWith('WEBVTT\n\n')).toBe(true)
    expect(srtToVtt('1\n00:00:00,000 --> 00:00:01,000\nhi\n').startsWith('WEBVTT\n\n')).toBe(true)
  })

  it('emits a minimal valid VTT for empty input', () => {
    expect(srtToVtt('')).toBe('WEBVTT\n\n')
  })
})

describe('srtToVtt — timestamp conversion', () => {
  it('converts comma decimal separators to periods on both sides of the arrow', () => {
    const srt = '1\n00:00:00,500 --> 00:00:01,200\nhi\n'
    const vtt = srtToVtt(srt)
    expect(vtt).toContain('00:00:00.500 --> 00:00:01.200')
    expect(vtt).not.toContain('00:00:00,500')
  })

  it('handles multiple cues', () => {
    const srt =
      '1\n00:00:00,500 --> 00:00:01,200\nfirst\n\n' +
      '2\n00:00:02,100 --> 00:00:03,400\nsecond\n'
    const vtt = srtToVtt(srt)
    expect(vtt).toContain('00:00:00.500 --> 00:00:01.200')
    expect(vtt).toContain('00:00:02.100 --> 00:00:03.400')
  })

  it('handles multi-hour timestamps', () => {
    const srt = '1\n01:23:45,678 --> 02:34:56,789\nlong\n'
    expect(srtToVtt(srt)).toContain('01:23:45.678 --> 02:34:56.789')
  })

  it('handles flexible spacing around the arrow', () => {
    const srt = '1\n00:00:00,500-->00:00:01,200\nhi\n'
    // The arrow grammar is permissive; the comma swap should
    // still land even with no surrounding spaces.
    expect(srtToVtt(srt)).toContain('00:00:00.500 --> 00:00:01.200')
  })

  it('leaves dialogue commas untouched', () => {
    const srt =
      '1\n00:00:00,500 --> 00:00:01,200\nHello, world! Look, ma.\n'
    const vtt = srtToVtt(srt)
    expect(vtt).toContain('Hello, world! Look, ma.')
  })
})

describe('srtToVtt — cue numbering', () => {
  it('preserves bare integer cue identifiers (legal in VTT)', () => {
    // The leading "1" / "2" lines are SRT cue numbers. WebVTT
    // permits them as optional cue identifiers, so we don't
    // need to strip — and stripping would lose information.
    const srt = '1\n00:00:00,500 --> 00:00:01,200\nfirst\n'
    expect(srtToVtt(srt)).toContain('1\n00:00:00.500 --> 00:00:01.200')
  })
})

describe('srtToVtt — encoding hygiene', () => {
  it('strips a leading UTF-8 BOM', () => {
    // The BOM character U+FEFF is rejected by some WebVTT
    // parsers when it precedes the magic header. Some SRT
    // authoring tools (notably Subtitle Edit) emit one by
    // default.
    const srt = String.fromCharCode(0xFEFF) + '1\n00:00:00,500 --> 00:00:01,200\nhi\n'
    const vtt = srtToVtt(srt)
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true)
    expect(vtt.includes(String.fromCharCode(0xFEFF))).toBe(false)
  })

  it('normalizes CRLF line endings to LF', () => {
    const srt = '1\r\n00:00:00,500 --> 00:00:01,200\r\nhi\r\n'
    const vtt = srtToVtt(srt)
    expect(vtt).not.toContain('\r')
    expect(vtt).toContain('00:00:00.500 --> 00:00:01.200')
  })

  it('normalizes lone-CR line endings to LF', () => {
    const srt = '1\r00:00:00,500 --> 00:00:01,200\rhi\r'
    const vtt = srtToVtt(srt)
    expect(vtt).not.toContain('\r')
    expect(vtt).toContain('00:00:00.500 --> 00:00:01.200')
  })
})

describe('srtBytesToVttBytes', () => {
  it('round-trips through UTF-8 encoding', () => {
    const srt = '1\n00:00:00,500 --> 00:00:01,200\nhi\n'
    const srtBytes = new TextEncoder().encode(srt)
    const vttBytes = srtBytesToVttBytes(srtBytes)
    const vttText = new TextDecoder('utf-8').decode(vttBytes)
    expect(vttText.startsWith('WEBVTT\n\n')).toBe(true)
    expect(vttText).toContain('00:00:00.500 --> 00:00:01.200')
  })

  it('handles non-ASCII dialogue (accented characters)', () => {
    // Make sure the byte round-trip doesn't munge UTF-8 multi-
    // byte sequences. The catalog has Spanish / French
    // localizations that could land here.
    const srt = '1\n00:00:00,500 --> 00:00:01,200\nÁllo, mañana — ¿qué tal?\n'
    const vttBytes = srtBytesToVttBytes(new TextEncoder().encode(srt))
    expect(new TextDecoder('utf-8').decode(vttBytes)).toContain('Állo, mañana — ¿qué tal?')
  })
})
