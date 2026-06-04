/**
 * /api/v1/publish/featured-hero — the "Right now" hero admin write API
 * (Phase B of `docs/HERO_ADMIN_SCOPING.md`).
 *
 * PUT    → Set (upsert) the singleton hero override. Body:
 *          `{ dataset_id, window: { start, end }, headline? }`. The
 *          activation window is mandatory (§9.1). 404 if the dataset
 *          doesn't exist; 400 `{ errors }` for body problems (matches
 *          the rest of the publisher API + the portal client's
 *          validation-error parsing).
 * DELETE → Clear the hero override. Idempotent — 204 whether a pin
 *          was set or not.
 *
 * Both require a privileged caller (staff / admin / service token) —
 * community publishers cannot pin operator-wide homepage content.
 * Reads `context.data.publisher` injected by the publish middleware.
 *
 * Every mutation writes an audit row (`hero.set` / `hero.clear`) and
 * busts the public read cache (`hero:v1`) so a change is live within a
 * tick; the 60 s TTL on `GET /api/v1/featured-hero` is the backstop.
 */

import type { CatalogEnv } from '../_lib/env'
import type { PublisherData } from './_middleware'
import {
  bustHeroCache,
  clearHeroOverride,
  getHeroOverride,
  setHeroOverride,
  toPublicHero,
  validateHeroInput,
} from '../_lib/hero-override-store'
import { isPrivileged } from '../_lib/publisher-store'
import { writeAuditEvent } from '../_lib/audit-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function forbidden(): Response {
  return jsonError(
    403,
    'forbidden_role',
    'Hero override is restricted to staff, admin, and service callers.',
  )
}

export const onRequestPut: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) return forbidden()

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }

  const validation = validateHeroInput(body)
  if (!validation.ok) {
    // 400 with the `{ errors: [...] }` envelope — matches the rest of
    // the publisher API (validationFailure) and the portal client's
    // `publisherSend`, which parses field errors on 400/409.
    return new Response(JSON.stringify({ errors: validation.errors }), {
      status: 400,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }

  const result = await setHeroOverride(context.env.CATALOG_DB, publisher, validation.value)
  if (!result.ok) {
    return jsonError(result.status, result.error, result.message)
  }

  await writeAuditEvent(context.env.CATALOG_DB, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'hero.set',
    subject_kind: 'dataset',
    subject_id: result.row.dataset_id,
    metadata_json: JSON.stringify({
      window_start: result.row.window_start,
      window_end: result.row.window_end,
      has_headline: result.row.headline != null,
    }),
  })
  await bustHeroCache(context.env.CATALOG_KV)

  return new Response(JSON.stringify({ hero: toPublicHero(result.row) }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

export const onRequestDelete: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) return forbidden()

  // Read the existing pin (if any) so the audit row records which
  // dataset was un-pinned. Clear is idempotent regardless.
  const existing = await getHeroOverride(context.env.CATALOG_DB)
  await clearHeroOverride(context.env.CATALOG_DB)

  await writeAuditEvent(context.env.CATALOG_DB, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'hero.clear',
    subject_kind: 'dataset',
    subject_id: existing?.dataset_id ?? null,
  })
  await bustHeroCache(context.env.CATALOG_KV)

  return new Response(null, { status: 204 })
}
