// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

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
 * with `KILL_VOICE` set, the node's `orbit` feature off, or over the
 * per-IP rate cap — the proxy
 * accepts the socket and sends a JSON error frame
 * (`{ type: 'error', code }`) before closing, since a browser
 * WebSocket can't read an HTTP status. The client cools down on that
 * frame and the streaming resolver falls back to the batch Whisper
 * engine, so the realtime path is fully opt-in.
 *
 * See docs/ORBIT_VOICE_PLAN.md §3 (realtime path) and
 * https://developers.cloudflare.com/ai-gateway/usage/websockets-api/realtime-api/
 */

import { isOrbitEnabled } from '../_lib/orbit-gate'
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
 * The most one stream may cost: 60 seconds open, and 60 seconds' worth of
 * audio. The client opens one socket per spoken turn, bounded by the
 * voice detector in open mic, the button in push-to-talk and 8 s after a
 * wake word, so a real turn never comes near either. Without them a
 * socket ran for as long as anyone kept it open, and the Origin check
 * stops only browsers: a script that sets its own Origin could stream
 * audio through the operator's gateway, on the operator's bill, for as
 * long as it liked. The byte cap is the half a script cannot outrun,
 * since it can send an hour of recorded audio inside the first minute.
 * The lifetime also bounds how long a socket outlives a `KILL_VOICE` or
 * an Orbit switch-off, which are checked only at connect.
 *
 * Hitting either closes the client's socket with 1008 and no error frame
 * (the gateway's is closed plainly): the client ends that turn and
 * listens on, where an error frame would put the realtime path into
 * cooldown for the rest of the page's session.
 */
export const MAX_STREAM_MS = 60_000
/** 60 s of linear16 PCM, 16 kHz mono: 2 bytes × 16,000 samples/s. */
export const MAX_STREAM_BYTES = 2 * 16_000 * (MAX_STREAM_MS / 1000)

/**
 * The bytes a binary frame carries. Anything else counts as over the
 * cap: with `binaryType = 'arraybuffer'` nothing else should arrive, and
 * a type this does not recognise must not cross the cap uncounted.
 */
function frameBytes(data: unknown): number {
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength
  return Number.POSITIVE_INFINITY
}

/**
 * How the client's socket is closed for each reason the proxy ends a
 * stream itself. A text frame closes with 1003: the real client sends
 * only binary PCM, and text upstream reaches Deepgram's control channel,
 * where `{"type":"KeepAlive"}` would hold an idle stream open to the
 * lifetime cap and `Finalize` / `CloseStream` would act on the session.
 */
const PROXY_CLOSE = {
  time: { code: 1008, reason: 'stream_limit', log: 'closed at the stream limit (time)' },
  bytes: { code: 1008, reason: 'stream_limit', log: 'closed at the stream limit (bytes)' },
  text: { code: 1003, reason: 'binary_only', log: 'closed on a text frame from the client' },
} as const

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

/**
 * The gateway settings, trimmed. Every one of them ends up in a
 * URL path or a header value, where a trailing newline is either
 * rejected outright or silently routed somewhere that does not
 * exist — so whitespace is stripped once, here, and every reader
 * goes through it.
 */
function gatewayConfig(env: StreamEnv): {
  accountId?: string
  gateway?: string
  token?: string
} {
  return {
    accountId: env.CF_ACCOUNT_ID?.trim(),
    gateway: env.CF_AI_GATEWAY?.trim(),
    token: env.CF_AIG_TOKEN?.trim(),
  }
}

/** True once all three gateway settings are present. Pure — tested. */
export function streamConfigured(env: StreamEnv): boolean {
  const { accountId, gateway, token } = gatewayConfig(env)
  return !!(accountId && gateway && token)
}

/**
 * Build the AI Gateway realtime URL for a locale. Pure — tested.
 *
 * `https://`, not the `wss://` the gateway's docs show for a browser
 * client: a Worker opens an outbound WebSocket by `fetch()` with an
 * `Upgrade: websocket` header, and the Workers runtime refuses a
 * `wss://` URL outright ("Fetch API cannot load"). With `wss://` here
 * the upstream fetch always threw, the handler reported
 * `upstream_unavailable`, and every client fell back to batch Whisper
 * without a word.
 */
export function buildGatewayUrl(env: StreamEnv, lang: string): string {
  const params = new URLSearchParams({
    model: env.VOICE_STREAM_MODEL?.trim() || '@cf/deepgram/nova-3',
    encoding: 'linear16',
    sample_rate: '16000',
    interim_results: 'true',
  })
  const base = baseLang(lang)
  if (base) params.set('language', base)
  const { accountId, gateway } = gatewayConfig(env)
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gateway}/workers-ai?${params.toString()}`
}

/**
 * Why a same-origin client is refused a socket, or `null` to open one.
 * Split out because the order is the correctness and the handler
 * itself needs a `WebSocketPair` to test. `KILL_VOICE` first, so its
 * cooldown is what the client hears; the node's `orbit` feature next,
 * so a disabled node never opens the upstream gateway socket and an
 * unconfigured one still says why; the rate limit last, so a refusal
 * for any other reason does not spend the caller's allowance.
 */
export async function streamRefusal(
  env: StreamEnv,
  ip: string,
  rateLimited: (ip: string) => boolean = isRateLimited,
): Promise<string | null> {
  if (isVoiceKilled(env)) return 'voice_disabled'
  // Orbit turned off for this node — voice only exists to talk to it.
  if (!(await isOrbitEnabled(env))) return 'feature_disabled'
  if (!streamConfigured(env)) return 'voice_unavailable'
  if (rateLimited(ip)) return 'rate_limited'
  return null
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
  const refusal = await streamRefusal(env, request.headers.get('CF-Connecting-IP') ?? 'anon')
  if (refusal) return wsError(refusal)

  const lang = new URL(request.url).searchParams.get('lang') ?? 'en'

  // Open the upstream gateway socket (server-side, with the secret).
  // A fresh header set, so nothing of the visitor's request (cookies,
  // Origin, IP, user agent) reaches the gateway; the test pins it to
  // exactly these three. `cf-aig-collect-log: false` because a gateway
  // logs requests and responses by default, and docs/ORBIT_VOICE_PLAN.md
  // §6 says no audio is ever persisted. Cloudflare does not say whether
  // the header covers a WebSocket session, so the plan's live validation
  // checks the gateway's Logs page, and docs/SELF_HOSTING.md §14.5 has
  // operators turn the gateway's logs off rather than rely on it.
  let upstream: WebSocket | null = null
  try {
    const resp = await fetch(buildGatewayUrl(env, lang), {
      headers: {
        Upgrade: 'websocket',
        'cf-aig-authorization': gatewayConfig(env).token ?? '',
        'cf-aig-collect-log': 'false',
      },
    })
    upstream = resp.webSocket
    // Say why, in the server log only: a refusal that left no trace is
    // how this route went unnoticed while it relayed nothing. Status
    // only; never the URL's account path, the token, or a body.
    if (!upstream) {
      console.warn(`[voice/stream] gateway did not upgrade: HTTP ${resp.status}`)
      // Unread, it would hold the subrequest's connection until collected.
      resp.body?.cancel().catch(() => { /* already closed */ })
    }
  } catch (err) {
    console.warn('[voice/stream] gateway fetch failed:', err instanceof Error ? err.name : 'UnknownError')
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
  // From compatibility date 2026-03-17 (`websocket_standard_binary_type`)
  // a Worker-held socket delivers binary messages as a `Blob`, and
  // `send()` takes no Blob: it stringifies it, so the gateway received
  // the text "[object Blob]" in place of every audio frame, and nothing
  // threw. Ask both sockets for bytes. The project runs a date past that
  // one (wrangler.toml says which, and why it must match).
  server.binaryType = 'arraybuffer'
  upstream.binaryType = 'arraybuffer'

  let closed = false
  let bytesUp = 0
  const closeBoth = (why?: keyof typeof PROXY_CLOSE): void => {
    if (closed) return
    closed = true
    clearTimeout(lifetime)
    if (why) {
      const { code, reason, log } = PROXY_CLOSE[why]
      // Server log only, and no more than why: no audio, no IP.
      console.warn(`[voice/stream] ${log}`)
      try { server.close(code, reason) } catch { /* already closed */ }
    } else {
      try { server.close() } catch { /* already closed */ }
    }
    try { upstream!.close() } catch { /* already closed */ }
  }
  const lifetime = setTimeout(() => closeBoth('time'), MAX_STREAM_MS)

  // Audio up (binary only), transcripts down (JSON). The audio is counted
  // against MAX_STREAM_BYTES; a frame that would cross it is dropped, not
  // sent in part.
  server.addEventListener('message', (ev) => {
    if (closed) return
    if (typeof ev.data === 'string') { closeBoth('text'); return }
    bytesUp += frameBytes(ev.data)
    if (bytesUp > MAX_STREAM_BYTES) { closeBoth('bytes'); return }
    try { upstream!.send(ev.data) } catch { /* closing */ }
  })
  upstream.addEventListener('message', (ev) => {
    if (closed) return
    try { server.send(ev.data) } catch { /* closing */ }
  })
  // Wrapped, not passed bare: a bare closeBoth would take the event as its
  // `limit` argument and report every ordinary hang-up as a limit hit.
  const hangUp = (): void => closeBoth()
  server.addEventListener('close', hangUp)
  server.addEventListener('error', hangUp)
  upstream.addEventListener('close', hangUp)
  upstream.addEventListener('error', hangUp)

  return new Response(null, { status: 101, webSocket: client })
}
