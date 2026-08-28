// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Open Graph lead-image extraction (task: story media).
 *
 * The og:image fallback for events whose feed item carried no
 * enclosure: fetch the cited article once at ingest and read the
 * image its publisher designated for external previews — the same
 * image every link-preview card on the web uses, shown with the
 * citation attached.
 *
 * The fetch is deliberately bounded: one attempt, a short timeout, an
 * HTML-only content-type gate, and a byte cap on how much of the body
 * is read (og tags live in <head>; a page that hasn't yielded them in
 * the first quarter-megabyte isn't going to). Every failure path is
 * `null` — an event simply arrives imageless, never errored.
 */

export const OG_FETCH_TIMEOUT_MS = 5_000
/** Read at most this much of the article body. */
export const OG_MAX_BYTES = 256 * 1024

/** Minimal entity decode for attribute values (feeds/CMSes escape
 *  query separators as &amp;). A SINGLE pass over the string — every
 *  entity is decoded exactly once and the scan resumes after the
 *  replacement, so a double-escaped sequence (`&amp;quot;`,
 *  `&amp;#38;`) can never cascade into a second unescape. */
function decodeAttr(value: string): string {
  return value.replace(/&(quot|#39|amp|#38);/gi, (_whole, name: string) => {
    const key = name.toLowerCase()
    if (key === 'quot') return '"'
    if (key === '#39') return "'"
    return '&'
  })
}

/** A usable image URL: http(s) and sanely bounded. */
function usableUrl(raw: string | undefined): string | null {
  if (!raw) return null
  const url = decodeAttr(raw.trim())
  return /^https?:\/\//i.test(url) && url.length <= 2048 ? url : null
}

/**
 * Pull the designated preview image out of an HTML document:
 * `og:image` / `og:image:url` first, `twitter:image` as the fallback.
 * Attribute order inside the meta tag is not assumed. Pure — exported
 * for tests.
 */
export function extractOgImage(html: string): string | null {
  let twitter: string | null = null
  for (const m of html.matchAll(/<meta\s([^>]*?)\/?>/gi)) {
    const attrs = m[1]
    const key = (
      attrs.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1] ?? ''
    ).toLowerCase()
    if (key !== 'og:image' && key !== 'og:image:url' && key !== 'twitter:image') continue
    const content = usableUrl(attrs.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1])
    if (!content) continue
    if (key === 'twitter:image') {
      twitter = twitter ?? content
    } else {
      return content // first og:image wins
    }
  }
  return twitter
}

/** IPv4 literal in a private / loopback / link-local / unspecified
 *  range. */
function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 169 && b === 254) // link-local
  )
}

/**
 * SSRF guard for the article fetch: refuse loopback / private /
 * link-local targets a malicious feed item could point `sourceUrl`
 * at. Hostname-shaped private DNS (rebinding) can't be resolved from
 * a Worker, so this is scheme/host defense-in-depth on top of the
 * runtime's own egress restrictions. Exported for tests.
 */
export function isSafePublicUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (u.username || u.password) return false
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (host.endsWith('.local') || host.endsWith('.internal')) return false
  if (isPrivateIpv4(host)) return false
  // IPv6 literals arrive bracket-stripped from URL.hostname… except
  // they don't — keep both forms out: loopback, link-local, unique-local.
  const v6 = host.replace(/^\[|\]$/g, '')
  if (v6 === '::1' || v6 === '::' || /^fe80:/i.test(v6) || /^f[cd][0-9a-f]{2}:/i.test(v6)) return false
  return true
}

/**
 * Fetch `url` and extract its preview image. `fetchFn` is injectable
 * so tests never touch the network; callers pass the runtime fetch.
 */
export async function fetchOgImage(url: string, fetchFn: typeof fetch): Promise<string | null> {
  if (!isSafePublicUrl(url)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OG_FETCH_TIMEOUT_MS)
  try {
    const res = await fetchFn(url, {
      signal: controller.signal,
      headers: { Accept: 'text/html' },
      redirect: 'follow',
    })
    if (!res.ok) return null
    const contentType = res.headers.get('Content-Type') ?? ''
    if (!contentType.toLowerCase().includes('text/html')) return null

    // Stream up to the byte cap; og tags live in <head>, so stop as
    // soon as the head has closed.
    let html = ''
    if (res.body) {
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let bytes = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        html += decoder.decode(value, { stream: true })
        if (bytes >= OG_MAX_BYTES || /<\/head/i.test(html)) break
      }
      try {
        await reader.cancel()
      } catch {
        // Already closed — fine.
      }
    } else {
      html = (await res.text()).slice(0, OG_MAX_BYTES)
    }
    return extractOgImage(html)
  } catch {
    // Timeout, network refusal, TLS, abort — all mean "no image".
    return null
  } finally {
    clearTimeout(timer)
  }
}
