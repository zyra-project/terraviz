import { describe, it, expect } from 'vitest'
import {
  downsampleTo16kHz,
  floatToLinear16,
  parseDeepgramMessage,
  parseStreamErrorFrame,
  TARGET_SAMPLE_RATE,
} from './voicePcm'

describe('downsampleTo16kHz', () => {
  it('returns input unchanged at or below the target rate', () => {
    const f = new Float32Array([0.1, 0.2, 0.3])
    expect(downsampleTo16kHz(f, 16000)).toBe(f)
    expect(downsampleTo16kHz(f, 8000)).toBe(f)
  })

  it('halves the length downsampling 32 kHz → 16 kHz', () => {
    const input = new Float32Array([0, 1, 0, 1, 0, 1, 0, 1])
    const out = downsampleTo16kHz(input, 32000)
    expect(out.length).toBe(4)
    // Each output sample averages a pair → 0.5.
    for (const s of out) expect(s).toBeCloseTo(0.5, 5)
  })

  it('handles an empty frame', () => {
    expect(downsampleTo16kHz(new Float32Array(0), 48000).length).toBe(0)
  })

  it('downsamples 48 kHz → 16 kHz by a factor of 3', () => {
    const input = new Float32Array(48)
    const out = downsampleTo16kHz(input, 48000)
    expect(out.length).toBe(16)
  })
})

describe('floatToLinear16', () => {
  function int16At(buf: ArrayBuffer, i: number): number {
    return new DataView(buf).getInt16(i * 2, true)
  }

  it('packs samples little-endian at 2 bytes each', () => {
    const buf = floatToLinear16(new Float32Array([0, 1, -1]))
    expect(buf.byteLength).toBe(6)
    expect(int16At(buf, 0)).toBe(0)
    expect(int16At(buf, 1)).toBe(32767)  // +1 → max
    expect(int16At(buf, 2)).toBe(-32768) // -1 → min
  })

  it('clamps out-of-range values', () => {
    const buf = floatToLinear16(new Float32Array([2, -2]))
    expect(int16At(buf, 0)).toBe(32767)
    expect(int16At(buf, 1)).toBe(-32768)
  })

  it('uses little-endian byte order', () => {
    const buf = floatToLinear16(new Float32Array([1]))
    const bytes = new Uint8Array(buf)
    // 32767 = 0x7FFF → little-endian [0xFF, 0x7F]
    expect(bytes[0]).toBe(0xff)
    expect(bytes[1]).toBe(0x7f)
  })

  it('targets 16 kHz', () => {
    expect(TARGET_SAMPLE_RATE).toBe(16000)
  })
})

describe('parseDeepgramMessage', () => {
  it('reads an interim transcript (is_final false)', () => {
    const msg = parseDeepgramMessage(JSON.stringify({
      channel: { alternatives: [{ transcript: 'show me' }] },
      is_final: false,
    }))
    expect(msg).toEqual({ transcript: 'show me', isFinal: false })
  })

  it('reads a finalized turn (is_final true)', () => {
    const msg = parseDeepgramMessage({
      channel: { alternatives: [{ transcript: 'show me sea ice' }] },
      is_final: true,
    })
    expect(msg).toEqual({ transcript: 'show me sea ice', isFinal: true })
  })

  it('returns null for non-transcript / malformed frames', () => {
    expect(parseDeepgramMessage('{"type":"Metadata"}')).toBeNull()
    expect(parseDeepgramMessage('not json')).toBeNull()
    expect(parseDeepgramMessage({ channel: { alternatives: [] } })).toBeNull()
    expect(parseDeepgramMessage(null)).toBeNull()
    expect(parseDeepgramMessage(42)).toBeNull()
  })
})

describe('parseStreamErrorFrame', () => {
  it('reads the code from a proxy error frame', () => {
    expect(parseStreamErrorFrame(JSON.stringify({ type: 'error', code: 'voice_disabled' }))).toBe('voice_disabled')
    expect(parseStreamErrorFrame({ type: 'error', code: 'rate_limited' })).toBe('rate_limited')
  })

  it('defaults a code-less error frame to a generic code', () => {
    expect(parseStreamErrorFrame({ type: 'error' })).toBe('voice_stream_error')
  })

  it('returns null for transcripts and malformed frames', () => {
    expect(parseStreamErrorFrame(JSON.stringify({ channel: { alternatives: [{ transcript: 'hi' }] } }))).toBeNull()
    expect(parseStreamErrorFrame('not json')).toBeNull()
    expect(parseStreamErrorFrame(null)).toBeNull()
    expect(parseStreamErrorFrame(42)).toBeNull()
  })
})
