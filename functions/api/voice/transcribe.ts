// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Cloudflare Pages Function — POST /api/voice/transcribe
 *
 * Speech-to-text over Workers AI (Whisper large v3 turbo). The client
 * POSTs raw captured audio bytes (any container Whisper accepts, e.g.
 * webm/opus, mp4/aac); we base64-encode and run the model, returning
 * `{ text }`. No external key — the same `AI` binding as chat.
 *
 * See docs/ORBIT_VOICE_PLAN.md §3 (models), §7 (Phase 2).
 */

import { isWorkersAiQuotaError } from '../_lib/workers-ai-error'
import {
  type VoiceEnv,
  STT_MODEL,
  MAX_AUDIO_BYTES,
  isVoiceKilled,
  isAllowedOrigin,
  corsHeaders,
  voiceError,
  makeRateLimiter,
  arrayBufferToBase64,
} from './_voice-lib'

const isRateLimited = makeRateLimiter(30) // 30 transcriptions / min / IP

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

  // Kill switch — let the client cool down for the session.
  if (isVoiceKilled(env)) {
    return voiceError('voice disabled', 503, { ...cors, 'Retry-After': '300' }, 'voice_disabled')
  }
  // No binding (local dev) — client falls back to the browser engine.
  if (!env.AI) return voiceError('voice unavailable', 503, cors, 'voice_unavailable')

  const ip = request.headers.get('CF-Connecting-IP') ?? 'anon'
  if (isRateLimited(ip)) {
    return voiceError('rate limit', 429, { ...cors, 'Retry-After': '30' }, 'rate_limited')
  }

  // Size guard before reading.
  const contentLength = request.headers.get('Content-Length')
  if (contentLength && Number(contentLength) > MAX_AUDIO_BYTES) {
    return voiceError('audio too large', 413, cors, 'too_large')
  }

  let audio: ArrayBuffer
  try {
    audio = await request.arrayBuffer()
  } catch {
    return voiceError('read error', 400, cors)
  }
  if (audio.byteLength === 0) return voiceError('empty audio', 400, cors)
  if (audio.byteLength > MAX_AUDIO_BYTES) return voiceError('audio too large', 413, cors, 'too_large')

  try {
    const result = (await env.AI.run(STT_MODEL, {
      audio: arrayBufferToBase64(audio),
    })) as { text?: string }
    return new Response(JSON.stringify({ text: result?.text ?? '' }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    if (isWorkersAiQuotaError(err)) {
      return voiceError('quota exhausted', 429, { ...cors, 'Retry-After': '60' }, 'quota_exhausted')
    }
    return voiceError('transcription failed', 502, cors, 'inference_error')
  }
}
