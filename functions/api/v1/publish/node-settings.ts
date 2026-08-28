// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * /api/v1/publish/node-settings — the per-node feature toggles.
 *
 * GET → The effective feature map (all keys, defaults filled), or
 *       all-enabled when never configured. Any signed-in publisher
 *       may read it — gated pages render their "feature disabled"
 *       card from authoritative data, not just the sidebar's copy.
 * PUT → Replace the toggle set. Body:
 *       `{ features: { <key>: boolean, ... } }` — partial is fine
 *       (missing keys stay enabled). 400 `{ errors }` for body
 *       problems (the publisher-API field-error envelope).
 *
 * Writes are **admin-only** (`isAdmin`, stricter than the node
 * profile's `isPrivileged`) — a service token must not be able to
 * flip node-level features. Writes are audit-logged
 * (`node_settings.update`) and bust both the effective-features
 * cache and the public node-profile cache (whose payload carries
 * the feature map to the SPA).
 */

import type { CatalogEnv } from '../_lib/env'
import type { PublisherData } from './_middleware'
import {
  bustNodeFeaturesCache,
  disabledKeys,
  featuresFromRow,
  getNodeSettings,
  setNodeFeatures,
  validateFeaturesInput,
} from '../_lib/node-settings-store'
import { bustNodeProfileCache } from '../_lib/node-profile-store'
import { isAdmin } from '../_lib/publisher-store'
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
  const row = await getNodeSettings(context.env.CATALOG_DB)
  return new Response(
    JSON.stringify({
      features: featuresFromRow(row),
      updatedBy: row?.updated_by ?? null,
      updatedAt: row?.updated_at ?? null,
    }),
    {
      status: 200,
      headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
    },
  )
}

export const onRequestPut: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isAdmin(publisher)) {
    return jsonError(403, 'forbidden_role', 'Editing feature toggles is restricted to admins.')
  }

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }

  const validation = validateFeaturesInput(body)
  if (!validation.ok) {
    return new Response(JSON.stringify({ errors: validation.errors }), {
      status: 400,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }

  const row = await setNodeFeatures(context.env.CATALOG_DB, publisher, validation.value)

  await writeAuditEvent(context.env.CATALOG_DB, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'node_settings.update',
    subject_kind: 'node_settings',
    subject_id: null,
    metadata_json: JSON.stringify({ disabled: disabledKeys(validation.value) }),
  })
  // Both hot paths carry the toggle set: the middleware/public-handler
  // gate reads node-features:v1, and the public node-profile payload
  // ships the map to the SPA.
  await bustNodeFeaturesCache(context.env.CATALOG_KV)
  await bustNodeProfileCache(context.env.CATALOG_KV)

  return new Response(
    JSON.stringify({
      features: featuresFromRow(row),
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    }),
    {
      status: 200,
      headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
    },
  )
}
