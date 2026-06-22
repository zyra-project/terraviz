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
 * `CF_AIG_TOKEN` (AI Gateway authorization). Absent any of them — or
 * with `KILL_VOICE` set, or over the per-IP rate cap — the proxy
 * accepts the socket and sends a JSON error frame
 * (`{ type: 'error', code }`) before closing, since a browser
 * WebSocket can't read an HTTP status. The client cools down on that
 * frame and the streaming resolver falls back to the batch Whisper
 * engine, so the realtime path is fully opt-in.
 *
 * See docs/ORBIT_VOICE_PLAN.md §3 (realtime path) and
 * https://developers.cloudflare.com/ai-gateway/usage/websockets-api/realtime-api/
 */

import { type VoiceEnv, isVoiceKilled, isAllowedOrigin, makeRateLimiter } from './_voice-lib'

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

// Per-IP new-connection cap. Streaming sockets are long-lived, so the
// abuse vector is opening many of them; 20 fresh connections/min/IP is
// generous for a real user (a few barge-in reopens) but caps a flood.
// In-memory per-isolate, like the POST voice routes.
const isRateLimited = makeRateLimiter(20)

/**
 * Accept the WebSocket and hand the client a single JSON error frame
 * (`{ type: 'error', code }`) before closing. A browser WebSocket can't
 * read an HTTP status, so this is how the client learns the route is
 * off / unconfigured / rate-limited and cools down to the batch engine.
 */
function wsError(code: string): Response {
  const pair = new WebSocketPair()
  const client = pair[0]
  const server = pair[1]
  server.accept()
  try { server.send(JSON.stringify({ type: 'error', code })) } catch { /* closing */ }
  try { server.close() } catch { /* already closed */ }
  return new Response(null, { status: 101, webSocket: client })
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
  // Origin is rejected with a plain 403 (no WS upgrade): a cross-origin
  // attacker isn't a real client and shouldn't get a socket. Legitimate
  // same-origin browsers always send a matching Origin.
  const origin = request.headers.get('Origin')
  if (!origin || !isAllowedOrigin(origin, request.url)) return new Response(null, { status: 403 })

  // From here the caller is a real same-origin WS client. Disabled /
  // unconfigured / rate-limited cases are reported as a readable error
  // frame (not an unreadable HTTP status) so the client can fall back.
  if (isVoiceKilled(env)) return wsError('voice_disabled')
  if (!streamConfigured(env)) return wsError('voice_unavailable')
  const ip = request.headers.get('CF-Connecting-IP') ?? 'anon'
  if (isRateLimited(ip)) return wsError('rate_limited')

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
  // Same reasoning: a 502 is unreadable by a browser WS. Report the
  // gateway hiccup as an error frame so the client falls back cleanly.
  if (!upstream) return wsError('upstream_unavailable')

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
