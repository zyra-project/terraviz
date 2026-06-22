/**
 * Cloudflare Pages Function — WS /api/voice/stream
 *
 * Realtime speech-to-text proxy for the Phase 3 hands-free path. The
 * browser opens a WebSocket here and streams linear16 PCM; we open a
 * second WebSocket to Cloudflare's **AI Gateway realtime endpoint**
 * (Deepgram Nova-3/Flux) with the `cf-aig-authorization` secret and
 * pipe bytes up / JSON transcripts back. The secret never reaches the
 * client — that's the whole reason this proxy exists.
 *
 * Config (Pages → Settings → Variables; the token as an encrypted
 * secret): `CF_ACCOUNT_ID`, `CF_AI_GATEWAY` (gateway name),
 * `CF_AIG_TOKEN` (AI Gateway authorization). Absent any of them, the
 * endpoint reports 503 and the client falls back to the batch Whisper
 * engine. `KILL_VOICE` disables it like the other voice routes.
 *
 * See docs/ORBIT_VOICE_PLAN.md §3 (realtime path) and
 * https://developers.cloudflare.com/ai-gateway/usage/websockets-api/realtime-api/
 */

import { type VoiceEnv, isVoiceKilled, isAllowedOrigin } from './_voice-lib'

export interface StreamEnv extends VoiceEnv {
  /** Cloudflare account id for the AI Gateway URL. */
  CF_ACCOUNT_ID?: string
  /** AI Gateway name. */
  CF_AI_GATEWAY?: string
  /** AI Gateway authorization (`cf-aig-authorization`) — encrypted secret. */
  CF_AIG_TOKEN?: string
  /** Optional model override; defaults to Deepgram Nova-3. */
  VOICE_STREAM_MODEL?: string
}

/** Base language (strip any region subtag) for the Deepgram `language` param. */
function baseLang(lang: string): string {
  return (lang || '').toLowerCase().split('-')[0]?.trim() ?? ''
}

/** True once all three gateway settings are present. Pure — tested. */
export function streamConfigured(env: StreamEnv): boolean {
  return !!(env.CF_ACCOUNT_ID && env.CF_AI_GATEWAY && env.CF_AIG_TOKEN)
}

/** Build the AI Gateway realtime WS URL for a locale. Pure — tested. */
export function buildGatewayUrl(env: StreamEnv, lang: string): string {
  const params = new URLSearchParams({
    model: env.VOICE_STREAM_MODEL || '@cf/deepgram/nova-3',
    encoding: 'linear16',
    sample_rate: '16000',
    interim_results: 'true',
  })
  const base = baseLang(lang)
  if (base) params.set('language', base)
  return `wss://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_AI_GATEWAY}/workers-ai?${params.toString()}`
}

export const onRequest: PagesFunction<StreamEnv> = async (context) => {
  const { request, env } = context

  if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
    return new Response('expected websocket', { status: 426 })
  }
  const origin = request.headers.get('Origin')
  if (!origin || !isAllowedOrigin(origin, request.url)) return new Response(null, { status: 403 })
  if (isVoiceKilled(env)) return new Response('voice disabled', { status: 503 })
  if (!streamConfigured(env)) return new Response('voice stream not configured', { status: 503 })

  const lang = new URL(request.url).searchParams.get('lang') ?? 'en'

  // Open the upstream gateway socket (server-side, with the secret).
  let upstream: WebSocket | null = null
  try {
    const resp = await fetch(buildGatewayUrl(env, lang), {
      headers: { Upgrade: 'websocket', 'cf-aig-authorization': env.CF_AIG_TOKEN ?? '' },
    })
    upstream = resp.webSocket
  } catch {
    upstream = null
  }
  if (!upstream) return new Response('upstream connect failed', { status: 502 })

  const pair = new WebSocketPair()
  const client = pair[0]
  const server = pair[1]
  server.accept()
  upstream.accept()

  // Audio up (binary), transcripts down (JSON) — opaque pass-through.
  server.addEventListener('message', (ev) => { try { upstream!.send(ev.data) } catch { /* closing */ } })
  upstream.addEventListener('message', (ev) => { try { server.send(ev.data) } catch { /* closing */ } })
  const closeBoth = (): void => {
    try { server.close() } catch { /* already closed */ }
    try { upstream!.close() } catch { /* already closed */ }
  }
  server.addEventListener('close', closeBoth)
  server.addEventListener('error', closeBoth)
  upstream.addEventListener('close', closeBoth)
  upstream.addEventListener('error', closeBoth)

  return new Response(null, { status: 101, webSocket: client })
}
