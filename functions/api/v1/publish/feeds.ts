// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * /api/v1/publish/feeds — the feed-connector registry surface
 * (`docs/CURRENT_EVENTS_PLAN.md` §9).
 *
 *   GET  — list every connector (enabled and paused) for the portal
 *          feeds page, newest state included (last_run_* bookkeeping).
 *   POST — add a connector: a curated preset the operator one-clicked,
 *          or a bring-your-own RSS/Atom URL. Body
 *          `{ kind, label, url, category?, enabled? }`.
 *
 * Adding a feed changes only what lands in the review queue — every
 * ingested event still starts `proposed` behind the curator gate, so a
 * mis-chosen feed can never surface anything publicly on its own.
 *
 * Privileged-only (admin / service), audit-logged, mirroring
 * `publish/events.ts` conventions.
 */

import type { CatalogEnv } from '../_lib/env'
import type { PublisherData } from './_middleware'
import { isPrivileged } from '../_lib/publisher-store'
import { writeAuditEvent } from '../_lib/audit-store'
import {
  FEED_CONNECTOR_KINDS,
  insertFeedConnector,
  listFeedConnectors,
  toPublicFeedConnector,
  type FeedConnectorKind,
} from '../_lib/feed-connectors-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

/** Bound operator-supplied text so a paste mistake can't bloat a row. */
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

/** Parse + validate a create body. Returns field errors in the same
 *  `{ field, code, message }` shape the events create route uses. */
export function parseCreateFeed(raw: unknown):
  | { ok: true; value: { kind: FeedConnectorKind; label: string; url: string; category: string | null; enabled: boolean } }
  | { ok: false; errors: Array<{ field: string; code: string; message: string }> } {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const errors: Array<{ field: string; code: string; message: string }> = []

  const kind = typeof b.kind === 'string' ? b.kind.trim() : ''
  if (!(FEED_CONNECTOR_KINDS as readonly string[]).includes(kind)) {
    errors.push({
      field: 'kind',
      code: 'invalid',
      message: `\`kind\` must be one of: ${FEED_CONNECTOR_KINDS.join(', ')}.`,
    })
  }

  const label = typeof b.label === 'string' ? b.label.trim() : ''
  if (!label) errors.push({ field: 'label', code: 'required', message: '`label` is required.' })
  else if (label.length > MAX_LABEL_CHARS) {
    errors.push({ field: 'label', code: 'too_long', message: `\`label\` must be ≤ ${MAX_LABEL_CHARS} characters.` })
  }

  const url = typeof b.url === 'string' ? b.url.trim() : ''
  if (!url || !isHttpUrl(url)) {
    errors.push({ field: 'url', code: 'invalid', message: '`url` must be an http(s) URL.' })
  } else if (url.length > MAX_URL_CHARS) {
    errors.push({ field: 'url', code: 'too_long', message: `\`url\` must be ≤ ${MAX_URL_CHARS} characters.` })
  }

  const categoryRaw = typeof b.category === 'string' ? b.category.trim() : ''
  const category = categoryRaw ? categoryRaw.slice(0, MAX_CATEGORY_CHARS) : null

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      kind: kind as FeedConnectorKind,
      label,
      url,
      category,
      enabled: b.enabled !== false,
    },
  }
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Managing feeds is restricted to admin and service callers.')
  }
  const rows = await listFeedConnectors(context.env.CATALOG_DB)
  return json(200, { feeds: rows.map(toPublicFeedConnector) })
}

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Managing feeds is restricted to admin and service callers.')
  }
  const db = context.env.CATALOG_DB

  let raw: unknown
  try {
    raw = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'The request body must be JSON.')
  }
  const parsed = parseCreateFeed(raw)
  if (!parsed.ok) {
    return json(400, { error: 'validation_failed', errors: parsed.errors })
  }

  const row = await insertFeedConnector(db, parsed.value)

  await writeAuditEvent(db, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'feed.created',
    subject_kind: 'feed',
    subject_id: row.id,
    metadata_json: JSON.stringify({ kind: row.kind, label: row.label, url: row.url }),
  })

  return json(201, { feed: toPublicFeedConnector(row) })
}
