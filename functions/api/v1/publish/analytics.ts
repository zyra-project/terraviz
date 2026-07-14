/**
 * GET /api/v1/publish/analytics — data facade for the
 * `/publish/analytics` admin tab (Phase B of
 * `docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md`).
 *
 * Typed sections over the D1 rollup tables — **not** a SQL proxy;
 * the query shapes are a fixed enum and every parameter is
 * validated against an allowlist:
 *
 *   ?section=overview|datasets|spatial|funnel|errors|perf|orbit|research  (required)
 *   ?days=7|30|90|365                            (default 30)
 *   ?environment=production|preview              (default production)
 *   spatial only:
 *     ?event=camera_settled|map_click            (default camera_settled)
 *     ?layer=<id>                                ('' = default Earth; omit = all)
 *     ?projection=globe|mercator|vr|ar           (omit = all)
 *
 * Read-only for any active publisher (view access); mutations
 * elsewhere (the operator backfill in `analytics-export.ts`) stay
 * privileged. Responses are KV-cached ~5 minutes (key includes
 * every filter) so a dashboard refresh storm stays cheap; rollups
 * only change once a day anyway.
 */

import type { CatalogEnv } from '../_lib/env'
import {
  queryDatasets,
  queryErrors,
  queryFunnel,
  queryOrbit,
  queryOverview,
  queryPerf,
  queryResearch,
  querySpatial,
  type AnalyticsFilters,
} from '../_lib/analytics-query'
import { addDays, yesterdayUtc } from '../_lib/analytics-export'

const CONTENT_TYPE = 'application/json; charset=utf-8'
export const CACHE_TTL_SECONDS = 300
export const ALLOWED_DAYS = [7, 30, 90, 365] as const
const ALLOWED_SECTIONS = ['overview', 'datasets', 'spatial', 'funnel', 'errors', 'perf', 'orbit', 'research'] as const
const ALLOWED_ENVIRONMENTS = ['production', 'preview'] as const
const ALLOWED_SPATIAL_EVENTS = ['camera_settled', 'map_click'] as const
const ALLOWED_PROJECTIONS = ['globe', 'mercator', 'vr', 'ar'] as const

type Section = (typeof ALLOWED_SECTIONS)[number]

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  // Read-only view is open to any active publisher (the middleware
  // has already rejected pending / suspended accounts). No role gate
  // here — analytics is a dashboard, not a mutation surface.
  const params = new URL(context.request.url).searchParams
  const section = params.get('section') ?? ''
  if (!(ALLOWED_SECTIONS as readonly string[]).includes(section)) {
    return jsonError(400, 'invalid_section', `section must be one of: ${ALLOWED_SECTIONS.join(', ')}.`)
  }
  // Validate the raw string, not the parse result — parseInt('30junk')
  // is 30, which would defeat the strict-allowlist posture.
  const daysRaw = params.get('days') ?? '30'
  if (!ALLOWED_DAYS.some(d => String(d) === daysRaw)) {
    return jsonError(400, 'invalid_days', `days must be one of: ${ALLOWED_DAYS.join(', ')}.`)
  }
  const days = parseInt(daysRaw, 10)
  const environment = params.get('environment') ?? 'production'
  if (!(ALLOWED_ENVIRONMENTS as readonly string[]).includes(environment)) {
    return jsonError(400, 'invalid_environment', `environment must be one of: ${ALLOWED_ENVIRONMENTS.join(', ')}.`)
  }
  const event = params.get('event') ?? 'camera_settled'
  if (!(ALLOWED_SPATIAL_EVENTS as readonly string[]).includes(event)) {
    return jsonError(400, 'invalid_event', `event must be one of: ${ALLOWED_SPATIAL_EVENTS.join(', ')}.`)
  }
  const projection = params.get('projection') ?? undefined
  if (projection !== undefined && !(ALLOWED_PROJECTIONS as readonly string[]).includes(projection)) {
    return jsonError(400, 'invalid_projection', `projection must be one of: ${ALLOWED_PROJECTIONS.join(', ')}.`)
  }
  // `layer` is a dataset id (free-form, parameter-bound in SQL);
  // '' selects the default-Earth view, absence selects all.
  const layer = params.has('layer') ? (params.get('layer') ?? '') : undefined

  // Rollups cover complete days through yesterday; the range is
  // the last N of them.
  const yesterday = yesterdayUtc()
  const filters: AnalyticsFilters = { sinceDay: addDays(yesterday, -(days - 1)), environment }

  const kv = context.env.CATALOG_KV
  const cacheKey =
    `analytics:v1:${section}:${days}:${environment}` +
    (section === 'spatial' ? `:${event}:${layer ?? '*'}:${projection ?? '*'}` : '')
  if (kv) {
    try {
      const hit = await kv.get(cacheKey)
      if (hit) {
        return new Response(hit, {
          status: 200,
          headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store', 'X-Cache': 'hit' },
        })
      }
    } catch {
      // A flaky KV read must not take the dashboard down.
    }
  }

  const db = context.env.CATALOG_DB
  let data: unknown
  switch (section as Section) {
    case 'overview':
      data = await queryOverview(db, filters)
      break
    case 'datasets':
      data = await queryDatasets(db, filters)
      break
    case 'spatial':
      data = await querySpatial(db, filters, { event, layer, projection })
      break
    case 'funnel':
      data = await queryFunnel(db, filters)
      break
    case 'errors':
      data = await queryErrors(db, filters)
      break
    case 'perf':
      data = await queryPerf(db, filters)
      break
    case 'orbit':
      data = await queryOrbit(db, filters)
      break
    case 'research':
      data = await queryResearch(db, filters)
      break
  }

  const body = JSON.stringify({ section, since_day: filters.sinceDay, through_day: yesterday, environment, data })
  if (kv) {
    try {
      await kv.put(cacheKey, body, { expirationTtl: CACHE_TTL_SECONDS })
    } catch {
      // Cache write failures are invisible to the caller.
    }
  }
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store', 'X-Cache': 'miss' },
  })
}
