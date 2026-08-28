// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Cloudflare Pages Function — /api/legend
 *
 * Proxies legend image fetches from external origins (e.g. sos.noaa.gov)
 * so the browser avoids CORS restrictions when encoding images as base64
 * for LLM vision context.
 *
 * GET /api/legend?url=<encoded-image-url>
 */

type Env = Record<string, never>

/** Accept HTTPS URLs only; reject localhost and RFC-1918 private ranges. */
function isSafeUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr)
    if (url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.startsWith('192.168.') ||
      host.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) return false
    return true
  } catch {
    return false
  }
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const reqUrl = new URL(context.request.url)
  const target = reqUrl.searchParams.get('url')

  if (!target) {
    return new Response('Missing url parameter', { status: 400 })
  }

  if (!isSafeUrl(target)) {
    return new Response('URL not allowed', { status: 403 })
  }

  let upstream: Response
  try {
    upstream = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SOS-Docent-LegendProxy/1.0)' },
    })
  } catch {
    return new Response('Failed to fetch upstream image', { status: 502 })
  }

  if (!upstream.ok) {
    return new Response(`Upstream returned ${upstream.status}`, { status: upstream.status })
  }

  const contentType = upstream.headers.get('Content-Type') ?? 'image/png'
  if (!contentType.startsWith('image/')) {
    return new Response('Upstream response is not an image', { status: 415 })
  }

  const origin = context.request.headers.get('Origin') ?? '*'
  const body = await upstream.arrayBuffer()

  return new Response(body, {
    headers: {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': origin,
      'Cache-Control': 'public, max-age=3600',
      'Vary': 'Origin',
    },
  })
}

export const onRequestOptions: PagesFunction<Env> = async (context) => {
  const origin = context.request.headers.get('Origin') ?? '*'
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin',
    },
  })
}
