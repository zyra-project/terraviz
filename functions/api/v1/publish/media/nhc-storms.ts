/**
 * GET /api/v1/publish/media/nhc-storms — same-origin proxy over NHC's
 * CurrentStorms.json (task: media suggestion engine).
 *
 * The NHC forecast-cone suggestion needs the active-storms list to
 * match a storm name against the event title, but nhc.noaa.gov serves
 * no CORS headers, so the portal can't fetch it directly. This route
 * fetches the one fixed upstream URL (never caller-supplied), trims
 * each storm to `{ id, name }`, and KV-caches the result briefly —
 * active-storm state changes on advisory cadence, not per-request.
 *
 * Every failure path degrades to `{ activeStorms: [] }` (uncached):
 * the pane simply offers no cone card. Privileged-only — this exists
 * for the curator review surface, not as a public NHC mirror.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { isPrivileged } from '../../_lib/publisher-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const UPSTREAM = 'https://www.nhc.noaa.gov/CurrentStorms.json'
const CACHE_KEY = 'nhc-storms:v1'
const CACHE_TTL_SECONDS = 300
const UPSTREAM_TIMEOUT_MS = 5_000
/** Far above any real season's simultaneous-storm count. */
const MAX_STORMS = 50

function ok(body: string, xCache: 'HIT' | 'MISS'): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store', 'X-Cache': xCache },
  })
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return new Response(
      JSON.stringify({ error: 'forbidden_role', message: 'The media proxy is restricted to admin and service callers.' }),
      { status: 403, headers: { 'Content-Type': CONTENT_TYPE } },
    )
  }

  if (context.env.CATALOG_KV) {
    try {
      const cached = await context.env.CATALOG_KV.get(CACHE_KEY)
      if (cached) return ok(cached, 'HIT')
    } catch {
      // KV failure = cache miss.
    }
  }

  let storms: Array<{ id: string; name: string }> = []
  let upstreamOk = false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const res = await fetch(UPSTREAM, { signal: controller.signal })
    if (res.ok) {
      const body = (await res.json()) as { activeStorms?: Array<{ id?: unknown; name?: unknown }> }
      if (Array.isArray(body.activeStorms)) {
        upstreamOk = true
        storms = body.activeStorms
          .filter(s => typeof s?.id === 'string' && typeof s?.name === 'string')
          .slice(0, MAX_STORMS)
          .map(s => ({ id: s.id as string, name: s.name as string }))
      }
    }
  } catch {
    // Timeout / network / parse — degrade to an empty list below.
  } finally {
    clearTimeout(timer)
  }

  const body = JSON.stringify({ activeStorms: storms })
  // Cache only real upstream answers (an empty list IS the correct
  // steady state outside storm season); an outage shouldn't pin
  // emptiness for the whole TTL.
  if (upstreamOk && context.env.CATALOG_KV) {
    try {
      await context.env.CATALOG_KV.put(CACHE_KEY, body, { expirationTtl: CACHE_TTL_SECONDS })
    } catch {
      // Best-effort cache fill.
    }
  }
  return ok(body, 'MISS')
}
