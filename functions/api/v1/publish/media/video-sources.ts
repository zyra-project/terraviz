// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * GET/POST /api/v1/publish/media/video-sources — the node's registry of
 * non-YouTube Video Sitemaps for the media-suggestion engine (task:
 * video-sitemap media source). The media counterpart of
 * `publish/feeds.ts`.
 *
 * GET  → every registered source (enabled + paused) with its last-run
 *        bookkeeping, for the Feeds console's Media tab.
 * POST → add a source: `{ label, url, attribution?, enabled? }`. A
 *        duplicate URL is rejected (409). Indexing happens on the next
 *        scheduled/manual refresh — adding a source only registers it.
 *
 * Privileged-only (admin / service), audit-logged (`video_source.add`),
 * mirroring `publish/feeds.ts` conventions. Per-source patch/delete live
 * in `video-sources/[id].ts`; the refresh trigger in
 * `video-sources/refresh.ts`.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { isPrivileged } from '../../_lib/publisher-store'
import { writeAuditEvent } from '../../_lib/audit-store'
import {
  insertVideoSource,
  listVideoSources,
  getVideoSourceByUrl,
  toPublicVideoSource,
} from '../../_lib/video-sources-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const MAX_LABEL_CHARS = 120
const MAX_URL_CHARS = 2048
const MAX_ATTRIBUTION_CHARS = 120

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
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

/** Parse + validate a create body. Field errors in the same
 *  `{ field, code, message }` shape the events/feeds routes use. */
export function parseCreateVideoSource(raw: unknown):
  | { ok: true; value: { label: string; url: string; attribution: string | null; enabled: boolean } }
  | { ok: false; errors: Array<{ field: string; code: string; message: string }> } {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const errors: Array<{ field: string; code: string; message: string }> = []

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

  const attrRaw = typeof b.attribution === 'string' ? b.attribution.trim() : ''
  const attribution = attrRaw ? attrRaw.slice(0, MAX_ATTRIBUTION_CHARS) : null

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { label, url, attribution, enabled: b.enabled !== false } }
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Managing video sources is restricted to admin and service callers.')
  }
  const rows = await listVideoSources(context.env.CATALOG_DB)
  return json(200, { sources: rows.map(toPublicVideoSource) })
}

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Managing video sources is restricted to admin and service callers.')
  }
  const db = context.env.CATALOG_DB

  let raw: unknown
  try {
    raw = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'The request body must be JSON.')
  }
  const parsed = parseCreateVideoSource(raw)
  if (!parsed.ok) {
    return json(400, { error: 'validation_failed', errors: parsed.errors })
  }

  // Reject a duplicate sitemap URL — the portal shows it as "already added".
  if (await getVideoSourceByUrl(db, parsed.value.url)) {
    return jsonError(409, 'already_registered', 'A video source with this URL is already registered.')
  }

  const row = await insertVideoSource(db, { ...parsed.value, addedBy: publisher.id })

  await writeAuditEvent(db, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'video_source.add',
    subject_kind: 'video_source',
    subject_id: row.id,
    metadata_json: JSON.stringify({ label: row.label, url: row.url }),
  })

  return json(201, { source: toPublicVideoSource(row) })
}
