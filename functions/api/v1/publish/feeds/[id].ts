// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * /api/v1/publish/feeds/:id — one feed connector.
 *
 *   POST   — patch operator-editable fields: `{ label?, url?,
 *            category?, enabled? }`. Enable/disable is the everyday
 *            action (pause a noisy feed without losing its config).
 *   DELETE — remove the connector. Events already ingested from it are
 *            untouched — they carry their own provenance and stay under
 *            the curator gate.
 *
 * Privileged-only (admin / service), audit-logged, mirroring
 * `publish/events/[id].ts` conventions.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { isPrivileged } from '../../_lib/publisher-store'
import { writeAuditEvent } from '../../_lib/audit-store'
import {
  deleteFeedConnector,
  getFeedConnector,
  toPublicFeedConnector,
  updateFeedConnector,
} from '../../_lib/feed-connectors-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

/** Same operator-text bounds as the create route (`../feeds.ts`) — a
 *  patch must not be a back door past them. */
const MAX_LABEL_CHARS = 120
const MAX_URL_CHARS = 2048
const MAX_CATEGORY_CHARS = 60

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function requireId(context: Parameters<PagesFunction<CatalogEnv, 'id'>>[0]): string | null {
  const idParam = context.params.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  return id || null
}

export const onRequestPost: PagesFunction<CatalogEnv, 'id'> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Managing feeds is restricted to admin and service callers.')
  }
  const db = context.env.CATALOG_DB
  const id = requireId(context)
  if (!id) return jsonError(400, 'invalid_request', 'Missing feed id.')

  let raw: unknown
  try {
    raw = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'The request body must be JSON.')
  }
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  const patch: { label?: string; url?: string; category?: string | null; enabled?: boolean } = {}
  if (typeof b.label === 'string' && b.label.trim()) {
    const label = b.label.trim()
    if (label.length > MAX_LABEL_CHARS) {
      return jsonError(400, 'invalid_label', `\`label\` must be ≤ ${MAX_LABEL_CHARS} characters.`)
    }
    patch.label = label
  }
  if (typeof b.url === 'string') {
    const url = b.url.trim()
    if (!isHttpUrl(url)) return jsonError(400, 'invalid_url', '`url` must be an http(s) URL.')
    if (url.length > MAX_URL_CHARS) {
      return jsonError(400, 'invalid_url', `\`url\` must be ≤ ${MAX_URL_CHARS} characters.`)
    }
    patch.url = url
  }
  // An explicit `category: null` clears it; a string sets it (bounded).
  if (b.category === null) patch.category = null
  else if (typeof b.category === 'string') patch.category = b.category.trim().slice(0, MAX_CATEGORY_CHARS) || null
  if (typeof b.enabled === 'boolean') patch.enabled = b.enabled
  if (Object.keys(patch).length === 0) {
    return jsonError(400, 'empty_patch', 'Provide at least one of: label, url, category, enabled.')
  }

  const row = await updateFeedConnector(db, id, patch)
  if (!row) return jsonError(404, 'not_found', `No feed connector with id ${id}.`)

  await writeAuditEvent(db, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'feed.updated',
    subject_kind: 'feed',
    subject_id: id,
    metadata_json: JSON.stringify(patch),
  })

  return json(200, { feed: toPublicFeedConnector(row) })
}

export const onRequestDelete: PagesFunction<CatalogEnv, 'id'> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Managing feeds is restricted to admin and service callers.')
  }
  const db = context.env.CATALOG_DB
  const id = requireId(context)
  if (!id) return jsonError(400, 'invalid_request', 'Missing feed id.')

  const existing = await getFeedConnector(db, id)
  if (!existing) return jsonError(404, 'not_found', `No feed connector with id ${id}.`)
  await deleteFeedConnector(db, id)

  await writeAuditEvent(db, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'feed.deleted',
    subject_kind: 'feed',
    subject_id: id,
    metadata_json: JSON.stringify({ kind: existing.kind, label: existing.label, url: existing.url }),
  })

  return json(200, { deleted: true })
}
