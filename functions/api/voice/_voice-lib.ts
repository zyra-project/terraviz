/**
 * Shared helpers for the Orbit voice Pages Functions
 * (`/api/voice/transcribe`, `/api/voice/synthesize`).
 *
 * Mirrors the CORS / origin / rate-limit posture of
 * `functions/api/chat/completions.ts`, and adds the `KILL_VOICE`
 * kill switch from the voice plan's §8 decision 4. All voice
 * inference runs on the same Workers AI `AI` binding the chat proxy
 * uses — no external key. See docs/ORBIT_VOICE_PLAN.md §3, §7.
 */

/** Workers AI binding (subset we use). */
export interface VoiceEnv {
  AI?: {
    run(
      model: string,
      inputs: Record<string, unknown>,
      options?: { returnRawResponse?: boolean },
    ): Promise<Response | ReadableStream | Record<string, unknown>>
  }
  /** Server-side kill switch. Any deny value disables voice edge inference. */
  KILL_VOICE?: string
}

// Workers AI model IDs (docs/ORBIT_VOICE_PLAN.md §3).
export const STT_MODEL = '@cf/openai/whisper-large-v3-turbo'
export const TTS_MODELS = {
  // MeloTTS is the default — ~10× cheaper than Aura (§8 decision 3).
  melotts: '@cf/myshell-ai/melotts',
  aura: '@cf/deepgram/aura-1',
} as const
export type TtsModelKey = keyof typeof TTS_MODELS

// Request caps.
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024 // 10 MB of captured audio
export const MAX_TTS_CHARS = 2000               // one reply's worth of text

// --- Kill switch ---

const KILL_DENY_VALUES = new Set(['1', 'true', 'on', 'yes', 'disabled'])

/** True when `KILL_VOICE` is set to a deny value — voice edge inference off. */
export function isVoiceKilled(env: VoiceEnv): boolean {
  const v = env.KILL_VOICE?.trim().toLowerCase()
  return !!v && KILL_DENY_VALUES.has(v)
}

// --- CORS / origin (same posture as the chat proxy) ---

const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://localhost:4173',
])

export function isAllowedOrigin(origin: string | null, requestUrl: string): boolean {
  if (!origin) return false
  if (ALLOWED_ORIGINS.has(origin)) return true
  try {
    return origin === new URL(requestUrl).origin
  } catch {
    return false
  }
}

export function corsHeaders(origin?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }
  if (origin) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

/** `{ error, code }` JSON with CORS headers — uniform error shape. */
export function voiceError(
  message: string,
  status: number,
  cors: Record<string, string>,
  code?: string,
): Response {
  return new Response(JSON.stringify({ error: message, code }), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

// --- Rate limiting (in-memory, per-isolate) — the practical per-IP cap ---

interface RateEntry { count: number; resetAt: number }
export const RATE_WINDOW_MS = 60_000

export function makeRateLimiter(limit: number) {
  const map = new Map<string, RateEntry>()
  return function isRateLimited(ip: string, now: number = Date.now()): boolean {
    const entry = map.get(ip)
    if (!entry || now > entry.resetAt) {
      map.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
      if (map.size > 1000) {
        for (const [k, v] of map) if (now > v.resetAt) map.delete(k)
      }
      return false
    }
    entry.count++
    return entry.count > limit
  }
}

// --- base64 (chunked, stack-safe) ---

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  const parts: string[] = []
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunk)))
  }
  return btoa(parts.join(''))
}
