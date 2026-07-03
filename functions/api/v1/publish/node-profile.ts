/**
 * /api/v1/publish/node-profile — the node / host-organization profile
 * (Phase 3d; `docs/CURRENT_EVENTS_PLAN.md` §7 companion work).
 *
 * GET → The singleton profile, or `{ profile: null }` when never
 *       filled in. Any signed-in publisher may read it (it grounds
 *       generated drafts every author sees), writes are privileged.
 * PUT → Upsert the profile. Body:
 *       `{ orgName, mission?, aboutMd?, regionFocus?, defaultTone?,
 *          links? }` — only `orgName` is mandatory. 400 `{ errors }`
 *       for body problems (the publisher-API field-error envelope).
 *
 * Writes require a privileged caller (admin / service) and are
 * audit-logged (`node_profile.update`). Mirrors `featured-hero.ts`.
 */

import type { CatalogEnv } from '../_lib/env'
import type { PublisherData } from './_middleware'
import {
  bustNodeProfileCache,
  getNodeProfile,
  setNodeProfile,
  toPublicProfile,
  validateProfileInput,
} from '../_lib/node-profile-store'
import { isPrivileged } from '../_lib/publisher-store'
import { resolveHttpAssetUrl } from '../_lib/r2-public-url'
import { writeAuditEvent } from '../_lib/audit-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

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
  const row = await getNodeProfile(context.env.CATALOG_DB)
  const env = context.env
  const profile = row ? toPublicProfile(row, ref => resolveHttpAssetUrl(env, ref)) : null
  return new Response(JSON.stringify({ profile }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

export const onRequestPut: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Editing the node profile is restricted to admin and service callers.')
  }

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }

  const validation = validateProfileInput(body)
  if (!validation.ok) {
    return new Response(JSON.stringify({ errors: validation.errors }), {
      status: 400,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }

  const row = await setNodeProfile(context.env.CATALOG_DB, publisher, validation.value)

  await writeAuditEvent(context.env.CATALOG_DB, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'node_profile.update',
    subject_kind: 'node_profile',
    subject_id: null,
    metadata_json: JSON.stringify({
      org_name: row.org_name,
      has_mission: row.mission != null,
      has_about: row.about_md != null,
    }),
  })
  // The public identity read serves orgName — keep it fresh.
  await bustNodeProfileCache(context.env.CATALOG_KV)

  const env = context.env
  return new Response(JSON.stringify({ profile: toPublicProfile(row, ref => resolveHttpAssetUrl(env, ref)) }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}
