// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * GET /api/v1/node-profile — the public host-organization identity
 * (Phase 3d follow-up; org logo on the public blog surface).
 *
 * Deliberately lean: `{ profile: { orgName, logoUrl, tagline,
 * browseSubtitle } | null, features }` — what a public page needs to
 * attribute the node (blog header, and the app's loading-screen tagline
 * and dataset-browser subtitle today; an about page or footer later)
 * plus the per-node feature toggles the portal chrome, the public blog
 * boot and the SPA's Orbit gate read. `tagline` and `browseSubtitle`
 * are null when the operator has not set one, and the app then shows
 * its own translated default. The full profile (mission, about markdown,
 * links, updated-by) stays behind the authed `/publish/node-profile`
 * read.
 *
 * Caching mirrors the public blog list: KV at `node-profile:v4` with
 * a 300 s TTL (the profile changes rarely), busted by the profile
 * PUT, the logo upload/remove routes, and the node-settings PUT.
 * A failed profile read answers `{ profile: null, features }` with the
 * stored toggles still read, and a failed toggles read answers them
 * all-enabled; either is `no-store`, so nothing caches an error and a
 * storage blip never dark-launches a disabled feature.
 */

import { defaultFeatures } from '../../../src/types/node-features'
import type { CatalogEnv } from './_lib/env'
import {
  NODE_PROFILE_CACHE_KEY,
  getNodeProfile,
  storedBrowseSubtitle,
  storedTagline,
} from './_lib/node-profile-store'
import { featuresFromRow, getNodeSettings } from './_lib/node-settings-store'
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

/** A good profile beside an assumed feature map: answered, never
 *  cached, so the guess cannot outlive the blip that caused it. */
function uncached(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'no-store', 'X-Cache': 'BYPASS' },
  })
}

function degraded(): Response {
  return new Response(JSON.stringify({ profile: null, features: defaultFeatures() }), {
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

  // A profile that cannot be read costs the identity, not the toggles:
  // the features are still read below and served beside a null
  // profile, uncached, so a profile-side failure can never turn back
  // on a feature the operator turned off.
  let row
  let profileFailed = false
  try {
    row = await getNodeProfile(context.env.CATALOG_DB)
  } catch (err) {
    console.warn(
      '[node-profile] public read failed — returning null profile:',
      err instanceof Error ? err.message : String(err),
    )
    row = null
    profileFailed = true
  }

  const profile = row
    ? {
        orgName: row.org_name,
        logoUrl: row.logo_ref ? resolveHttpAssetUrl(context.env, row.logo_ref) : null,
        tagline: storedTagline(row.tagline),
        browseSubtitle: storedBrowseSubtitle(row.browse_subtitle),
      }
    : null

  // Fail-open: a node_settings read problem must not fail the
  // identity read or disable anything — default to all-enabled. But
  // never cache that default: the SPA decides from this payload
  // whether to offer Orbit at all, and one D1 hiccup cached for the
  // TTL here (and again in every browser) would put Orbit back in
  // front of visitors for ten minutes on a node that turned it off.
  let features = defaultFeatures()
  try {
    features = featuresFromRow(await getNodeSettings(context.env.CATALOG_DB))
  } catch {
    // Table missing (un-migrated deploy) or read error — all enabled.
    return uncached(JSON.stringify({ profile, features }))
  }

  const body = JSON.stringify({ profile, features })
  if (profileFailed) return uncached(body)
  if (context.env.CATALOG_KV) {
    try {
      await context.env.CATALOG_KV.put(NODE_PROFILE_CACHE_KEY, body, { expirationTtl: CACHE_TTL_SECONDS })
    } catch {
      // Best-effort cache fill.
    }
  }
  return ok(body, 'MISS')
}
