// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Cloudflare Pages Function — POST /api/voice/synthesize
 *
 * Text-to-speech over Workers AI. Default model is MeloTTS (~10×
 * cheaper than Aura — §8 decision 3); `model: 'aura'` opts into
 * Deepgram Aura. The client POSTs `{ text, lang?, model? }` and gets
 * `{ audio: <base64>, format: 'mp3' }` back, which it plays as a
 * data URL. No external key — the same `AI` binding as chat.
 *
 * See docs/ORBIT_VOICE_PLAN.md §3 (models), §7 (Phase 2).
 */

import { isWorkersAiQuotaError } from '../_lib/workers-ai-error'
import {
  type VoiceEnv,
  type TtsModelKey,
  TTS_MODELS,
  MAX_TTS_CHARS,
  isVoiceKilled,
  isAllowedOrigin,
  corsHeaders,
  voiceError,
  makeRateLimiter,
} from './_voice-lib'

interface SynthesizeBody {
  text?: string
  lang?: string
  model?: TtsModelKey
}

// TTS is sentence-chunked, so a single reply can issue several calls.
const isRateLimited = makeRateLimiter(120) // 120 sentences / min / IP

export const onRequestOptions: PagesFunction<VoiceEnv> = async (context) => {
  const origin = context.request.headers.get('Origin')
  if (!isAllowedOrigin(origin, context.request.url)) return new Response(null, { status: 403 })
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
}

export const onRequestPost: PagesFunction<VoiceEnv> = async (context) => {
  const { request, env } = context
  const origin = request.headers.get('Origin')
  if (!origin || !isAllowedOrigin(origin, request.url)) return new Response(null, { status: 403 })
  const cors = corsHeaders(origin)

  if (isVoiceKilled(env)) {
    return voiceError('voice disabled', 503, { ...cors, 'Retry-After': '300' }, 'voice_disabled')
  }
  if (!env.AI) return voiceError('voice unavailable', 503, cors, 'voice_unavailable')

  const ip = request.headers.get('CF-Connecting-IP') ?? 'anon'
  if (isRateLimited(ip)) {
    return voiceError('rate limit', 429, { ...cors, 'Retry-After': '30' }, 'rate_limited')
  }

  let body: SynthesizeBody
  try {
    body = await request.json()
  } catch {
    return voiceError('invalid json', 400, cors)
  }
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) return voiceError('text required', 400, cors)
  if (text.length > MAX_TTS_CHARS) return voiceError('text too long', 413, cors, 'too_large')

  const modelKey: TtsModelKey = body.model === 'aura' ? 'aura' : 'melotts'
  const lang = typeof body.lang === 'string' && body.lang ? body.lang.split('-')[0] : 'en'

  try {
    // MeloTTS: { prompt, lang } → { audio: <base64 mp3> }.
    // Aura: { text } → { audio: <base64> }.
    const inputs = modelKey === 'melotts' ? { prompt: text, lang } : { text }
    const result = (await env.AI.run(TTS_MODELS[modelKey], inputs)) as { audio?: string }
    if (!result?.audio) return voiceError('synthesis failed', 502, cors, 'inference_error')
    return new Response(JSON.stringify({ audio: result.audio, format: 'mp3' }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    if (isWorkersAiQuotaError(err)) {
      return voiceError('quota exhausted', 429, { ...cors, 'Retry-After': '60' }, 'quota_exhausted')
    }
    return voiceError('synthesis failed', 502, cors, 'inference_error')
  }
}
