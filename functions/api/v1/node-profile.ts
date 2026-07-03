/**
 * GET /api/v1/node-profile — the public host-organization identity
 * (Phase 3d follow-up; org logo on the public blog surface).
 *
 * Deliberately lean: `{ profile: { orgName, logoUrl } | null }` — just
 * what a public page needs to attribute the node (blog header today;
 * an about page or footer later). The full profile (mission, about
 * markdown, links, updated-by) stays behind the authed
 * `/publish/node-profile` read.
 *
 * Caching mirrors the public blog list: KV at `node-profile:v1` with
 * a 300 s TTL (the profile changes rarely), busted by the profile PUT
 * and the logo upload/remove routes. Degrades to `{ profile: null }`
 * with `no-store` on any read failure so nothing caches an error.
 */

import type { CatalogEnv } from './_lib/env'
import { NODE_PROFILE_CACHE_KEY, getNodeProfile } from './_lib/node-profile-store'
import { resolveHttpAssetUrl } from './_lib/r2-public-url'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const CACHE_TTL_SECONDS = 300

function ok(body: string, xCache: 'HIT' | 'MISS'): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': CONTENT_TYPE,
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
      'X-Cache': xCache,
    },
  })
}

function degraded(): Response {
  return new Response(JSON.stringify({ profile: null }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'no-store', 'X-Cache': 'BYPASS' },
  })
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) return degraded()

  if (context.env.CATALOG_KV) {
    try {
      const cached = await context.env.CATALOG_KV.get(NODE_PROFILE_CACHE_KEY)
      if (cached) return ok(cached, 'HIT')
    } catch {
      // KV failure = cache miss; D1 is the source of truth.
    }
  }

  let row
  try {
    row = await getNodeProfile(context.env.CATALOG_DB)
  } catch (err) {
    console.warn(
      '[node-profile] public read failed — returning null profile:',
      err instanceof Error ? err.message : String(err),
    )
    return degraded()
  }

  const profile = row
    ? {
        orgName: row.org_name,
        logoUrl: row.logo_ref ? resolveHttpAssetUrl(context.env, row.logo_ref) : null,
      }
    : null
  const body = JSON.stringify({ profile })
  if (context.env.CATALOG_KV) {
    try {
      await context.env.CATALOG_KV.put(NODE_PROFILE_CACHE_KEY, body, { expirationTtl: CACHE_TTL_SECONDS })
    } catch {
      // Best-effort cache fill.
    }
  }
  return ok(body, 'MISS')
}
