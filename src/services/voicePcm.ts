/**
 * PCM audio helpers for the realtime WebSocket STT path (Phase 3).
 *
 * Cloudflare's Deepgram realtime endpoint wants **linear16** — 16-bit
 * signed PCM, mono, 16 kHz — as raw binary frames. The browser's
 * `MediaRecorder` produces webm/opus, not raw PCM, so the streaming
 * engine taps the mic via Web Audio (Float32 samples at the device
 * rate) and these pure helpers downsample to 16 kHz and pack to
 * linear16. Kept dependency-free and pure so they're unit-tested
 * without any audio hardware. (docs/ORBIT_VOICE_PLAN.md §10.1)
 */

/** Target sample rate for the Deepgram linear16 stream. */
export const TARGET_SAMPLE_RATE = 16000

/**
 * Downsample a mono Float32 frame to 16 kHz by simple block averaging.
 * Adequate for speech STT (the model is robust to mild aliasing) and
 * cheap enough for the audio thread. Upsampling is not supported —
 * input at or below 16 kHz is returned unchanged.
 */
export function downsampleTo16kHz(input: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate <= TARGET_SAMPLE_RATE || input.length === 0) return input
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE
  const outLength = Math.floor(input.length / ratio)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.floor((i + 1) * ratio))
    let sum = 0
    let n = 0
    for (let j = start; j < end; j++) { sum += input[j] ?? 0; n++ }
    out[i] = n > 0 ? sum / n : 0
  }
  return out
}

/**
 * Pack a Float32 frame (samples in [-1, 1]) into linear16 PCM bytes.
 * Values are clamped and scaled to the signed 16-bit range, written
 * little-endian (the wire order Deepgram expects). Returns the backing
 * `ArrayBuffer`, ready for `WebSocket.send`.
 */
export function floatToLinear16(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2)
  const view = new DataView(buffer)
  for (let i = 0; i < input.length; i++) {
    let s = input[i] ?? 0
    s = s < -1 ? -1 : s > 1 ? 1 : s
    // Asymmetric scale: negative range is one larger in two's complement.
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true /* little-endian */)
  }
  return buffer
}

/** A transcript message decoded from the Deepgram realtime stream. */
export interface DeepgramTranscript {
  transcript: string
  /** `true` = finalized (a turn); `false` = interim/partial. */
  isFinal: boolean
}

/**
 * Parse a Deepgram realtime results message
 * (`{ channel: { alternatives: [{ transcript }] }, is_final }`).
 * Returns `null` for non-transcript frames (metadata, keep-alives) or
 * malformed input, so callers can ignore them safely.
 */
export function parseDeepgramMessage(raw: unknown): DeepgramTranscript | null {
  let msg: unknown = raw
  if (typeof raw === 'string') {
    try { msg = JSON.parse(raw) } catch { return null }
  }
  if (!msg || typeof msg !== 'object') return null
  const m = msg as { channel?: { alternatives?: Array<{ transcript?: unknown }> }; is_final?: unknown }
  const transcript = m.channel?.alternatives?.[0]?.transcript
  if (typeof transcript !== 'string') return null
  return { transcript, isFinal: m.is_final === true }
}

/**
 * Parse a control frame sent by our `/api/voice/stream` proxy. A
 * browser WebSocket can't read an HTTP status, so the proxy signals
 * "this route is off / unconfigured / rate-limited" with a JSON frame
 * (`{ type: 'error', code }`) before closing. Returns the `code` so the
 * client can cool down and fall back to the batch engine; `null` for
 * any other frame (a normal transcript). (docs/ORBIT_VOICE_PLAN.md §3)
 */
export function parseStreamErrorFrame(raw: unknown): string | null {
  let msg: unknown = raw
  if (typeof raw === 'string') {
    try { msg = JSON.parse(raw) } catch { return null }
  }
  if (!msg || typeof msg !== 'object') return null
  const m = msg as { type?: unknown; code?: unknown }
  if (m.type !== 'error') return null
  return typeof m.code === 'string' && m.code ? m.code : 'voice_stream_error'
}
