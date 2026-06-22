/**
 * Realtime WebSocket streaming STT engine (Phase 3) — live interim
 * transcripts over Cloudflare's Deepgram Nova-3/Flux endpoint.
 *
 * Unlike the batch `cloudStreamingSttEngine` (record → Whisper, no
 * partials), this opens a WebSocket to our own `/api/voice/stream`
 * proxy (which adds the `cf-aig-authorization` secret and connects on
 * to the AI Gateway — the key never reaches the client), streams
 * **linear16 PCM** from the mic, and emits `onPartial` for interim
 * results and `onTurn` when Deepgram marks a result `is_final`.
 *
 * The socket and the Web Audio capture are injectable seams so the
 * message/transport logic is unit-testable without real audio or a
 * live gateway (§10.3). Registered as the `cloud` streaming provider
 * when available; falls back to the batch engine otherwise.
 * (docs/ORBIT_VOICE_PLAN.md §3 realtime path, §10.1)
 */
import {
  type StreamingSttEngine,
  type VoiceCapabilities,
} from './voiceService'
import { downsampleTo16kHz, floatToLinear16, parseDeepgramMessage, parseStreamErrorFrame } from './voicePcm'
import { baseLanguage, CLOUD_STT_LANGUAGES } from './voiceService'
import { logger } from '../utils/logger'

/**
 * Set once the proxy signals the realtime route is off (an error
 * control frame, or a handshake/socket failure). A browser WebSocket
 * can't read the 503 the POST routes return, so this session-scoped
 * cooldown is how the WS engine reports "unavailable" — the streaming
 * resolver then skips it and falls back to the batch cloud engine
 * (registered behind it). Mirrors `cloudVoiceDisabled` in
 * `voiceCloudEngines.ts`. (docs/ORBIT_VOICE_PLAN.md §3)
 */
let wsStreamingDisabled = false

/** Test seam. */
export function __resetWsStreamingDisabled(): void {
  wsStreamingDisabled = false
}

/** Minimal WebSocket surface (injectable for tests). */
export interface WsLike {
  binaryType: string
  readyState: number
  send(data: ArrayBuffer | string): void
  close(): void
  onopen: ((ev?: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev?: unknown) => void) | null
  onclose: ((ev?: unknown) => void) | null
}
export type CreateSocket = (url: string) => WsLike

/** A running PCM capture; `stop()` tears down the audio graph. */
export interface PcmCapture { stop(): void }
/** Pump linear16 PCM frames from a mic stream into `onFrame`. */
export type StartPcmCapture = (stream: MediaStream, onFrame: (pcm: ArrayBuffer) => void) => PcmCapture

const STREAM_PATH = '/api/voice/stream'

/** Build the same-origin `wss://…/api/voice/stream` URL for a locale. */
export function buildStreamUrl(lang: string): string {
  if (typeof location === 'undefined') return STREAM_PATH
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const q = lang ? `?lang=${encodeURIComponent(baseLanguage(lang))}` : ''
  return `${proto}//${location.host}${STREAM_PATH}${q}`
}

const defaultCreateSocket: CreateSocket = (url) => new WebSocket(url) as unknown as WsLike

/** Default Web Audio capture: Float32 → 16 kHz → linear16 frames. */
const defaultStartPcmCapture: StartPcmCapture = (stream, onFrame) => {
  const w = window as unknown as Record<string, unknown>
  const Ctx = (w['AudioContext'] ?? w['webkitAudioContext']) as (new () => AudioContext) | undefined
  if (!Ctx) return { stop: () => {} }
  const ctx = new Ctx()
  const source = ctx.createMediaStreamSource(stream)
  // ScriptProcessorNode is deprecated in favour of AudioWorklet, but it
  // needs no separate worklet module and is universally supported — a
  // pragmatic first cut; AudioWorklet is a later refinement.
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  processor.onaudioprocess = (e: AudioProcessingEvent) => {
    const input = e.inputBuffer.getChannelData(0)
    onFrame(floatToLinear16(downsampleTo16kHz(input, ctx.sampleRate)))
  }
  source.connect(processor)
  processor.connect(ctx.destination)
  return {
    stop: () => {
      try { processor.disconnect(); source.disconnect(); void ctx.close() } catch { /* already torn down */ }
    },
  }
}

export interface WsStreamingEngineDeps {
  createSocket?: CreateSocket
  startCapture?: StartPcmCapture
}

/**
 * Build the realtime WS streaming engine. The deps default to the real
 * WebSocket + Web Audio; tests inject fakes.
 */
export function createWsStreamingSttEngine(deps: WsStreamingEngineDeps = {}): StreamingSttEngine {
  const createSocket = deps.createSocket ?? defaultCreateSocket
  const startCapture = deps.startCapture ?? defaultStartPcmCapture
  return {
    provider: 'cloud',
    supportsLanguage: (lang) => CLOUD_STT_LANGUAGES.has(baseLanguage(lang)),
    // Needs Web Audio + a live mic stream (the session provides it) and
    // a same-origin proxy — so web-only, like the batch cloud engine.
    // Goes unavailable for the session once the proxy signals the route
    // is off, so the resolver falls back to the batch engine.
    isAvailable: (caps: VoiceCapabilities) =>
      !wsStreamingDisabled && caps.getUserMedia && typeof WebSocket !== 'undefined',
    startStreaming: ({ lang, stream, onPartial, onTurn, onError, onEnd }) => {
      // This engine streams the session's mic PCM up the socket; with no
      // stream there's nothing to send. Fail fast rather than opening an
      // idle connection that would just sit there.
      if (!stream) {
        onError(new Error('voice stream requires a mic stream'))
        onEnd?.()
        return { stop: () => {}, abortTurn: () => {} }
      }

      let ended = false // the whole session is over (stop / fatal error)
      let capture: PcmCapture | null = null
      let socket: WsLike | null = null

      const dropConnection = (): void => {
        capture?.stop(); capture = null
        if (socket) {
          const s = socket
          socket = null // detach first so the stale onclose is ignored
          try { s.close() } catch { /* already closing */ }
        }
      }
      const end = (): void => {
        if (ended) return
        ended = true
        dropConnection()
        onEnd?.()
      }

      // Open (or re-open, on barge-in) a socket and wire its handlers.
      const connect = (): void => {
        let s: WsLike
        try {
          s = createSocket(buildStreamUrl(lang))
        } catch (err) {
          onError(err as Error)
          end()
          return
        }
        socket = s
        s.binaryType = 'arraybuffer'

        s.onopen = () => {
          if (ended || socket !== s) return
          // Only now (socket ready) start pumping audio.
          capture = startCapture(stream, (pcm) => {
            if (!ended && socket === s) {
              try { s.send(pcm) } catch { /* socket closing */ }
            }
          })
        }
        s.onmessage = (ev) => {
          if (ended || socket !== s) return
          // The proxy sends a JSON error frame (route off / unconfigured
          // / rate-limited) instead of an unreadable HTTP status. Cool
          // down for the session and surface the error so the resolver
          // falls back to the batch engine next time.
          const code = parseStreamErrorFrame(ev.data)
          if (code) {
            wsStreamingDisabled = true
            logger.info(`[voice] ws streaming disabled by server (${code})`)
            onError(new Error(`voice stream ${code}`))
            end()
            return
          }
          const msg = parseDeepgramMessage(ev.data)
          if (!msg || !msg.transcript) return
          if (msg.isFinal) onTurn(msg.transcript.trim())
          else onPartial?.(msg.transcript)
        }
        s.onerror = () => {
          if (ended || socket !== s) return
          onError(new Error('voice stream socket error'))
          end()
        }
        s.onclose = () => {
          // Ignore the close of a socket we've already detached (a
          // barge-in reopen, or teardown). A live socket closing on us
          // ends the session.
          if (socket !== s) return
          end()
        }
      }

      connect()

      return {
        stop: () => end(),
        abortTurn: () => {
          // Barge-in: discard the in-flight turn WITHOUT ending the
          // session (the contract). Deepgram realtime is a continuous
          // socket, so reset its context by closing and reopening; the
          // detached socket's onclose is ignored (identity guard) so no
          // onEnd fires and listening continues on the fresh socket.
          if (ended) return
          logger.debug('[voice] ws stream abortTurn (reopen)')
          dropConnection()
          connect()
        },
      }
    },
  }
}
