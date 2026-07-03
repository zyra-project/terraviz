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

/**
 * Fetch `url` and extract its preview image. `fetchFn` is injectable
 * so tests never touch the network; callers pass the runtime fetch.
 */
export async function fetchOgImage(url: string, fetchFn: typeof fetch): Promise<string | null> {
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
