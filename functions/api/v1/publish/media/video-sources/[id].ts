// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * POST/DELETE /api/v1/publish/media/video-sources/:id — per-source
 * mutations for the video-sitemap registry (task: video-sitemap media
 * source).
 *
 * POST   → patch operator-editable fields `{ label?, url?, attribution?,
 *          enabled? }` (e.g. pause/resume). Only supplied keys change.
 * DELETE → remove the source; its `video_index` rows cascade.
 *
 * Privileged-only (admin / service), audit-logged. Mirrors
 * `publish/feeds/[id].ts`.
 */

import type { CatalogEnv } from '../../../_lib/env'
import type { PublisherData } from '../../_middleware'
import { isPrivileged } from '../../../_lib/publisher-store'
import { writeAuditEvent } from '../../../_lib/audit-store'
import {
  getVideoSource,
  updateVideoSource,
  deleteVideoSource,
  toPublicVideoSource,
} from '../../../_lib/video-sources-store'

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

function sourceId(context: Parameters<PagesFunction<CatalogEnv>>[0]): string | null {
  const raw = context.params.id
  const id = Array.isArray(raw) ? raw[0] : raw
  return typeof id === 'string' && id ? id : null
}

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Managing video sources is restricted to admin and service callers.')
  }
  const id = sourceId(context)
  if (!id) return jsonError(400, 'invalid_id', 'A source id is required.')
  const db = context.env.CATALOG_DB

  let raw: unknown
  try {
    raw = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'The request body must be JSON.')
  }
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const patch: { label?: string; url?: string; attribution?: string | null; enabled?: boolean } = {}
  if (typeof b.label === 'string') {
    const label = b.label.trim()
    if (!label || label.length > MAX_LABEL_CHARS) {
      return jsonError(400, 'validation_failed', `\`label\` must be 1–${MAX_LABEL_CHARS} characters.`)
    }
    patch.label = label
  }
  if (typeof b.url === 'string') {
    const url = b.url.trim()
    if (!isHttpUrl(url) || url.length > MAX_URL_CHARS) {
      return jsonError(400, 'validation_failed', '`url` must be an http(s) URL.')
    }
    patch.url = url
  }
  if (b.attribution !== undefined) {
    const attr = typeof b.attribution === 'string' ? b.attribution.trim() : ''
    patch.attribution = attr ? attr.slice(0, MAX_ATTRIBUTION_CHARS) : null
  }
  if (typeof b.enabled === 'boolean') patch.enabled = b.enabled

  const updated = await updateVideoSource(db, id, patch)
  if (!updated) return jsonError(404, 'not_found', 'No video source with that id.')

  await writeAuditEvent(db, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'video_source.update',
    subject_kind: 'video_source',
    subject_id: id,
    metadata_json: JSON.stringify(patch),
  })
  return json(200, { source: toPublicVideoSource(updated) })
}

export const onRequestDelete: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Managing video sources is restricted to admin and service callers.')
  }
  const id = sourceId(context)
  if (!id) return jsonError(400, 'invalid_id', 'A source id is required.')
  const db = context.env.CATALOG_DB

  const existing = await getVideoSource(db, id)
  if (!existing) return jsonError(404, 'not_found', 'No video source with that id.')
  await deleteVideoSource(db, id)

  await writeAuditEvent(db, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'video_source.remove',
    subject_kind: 'video_source',
    subject_id: id,
    metadata_json: JSON.stringify({ label: existing.label, url: existing.url }),
  })
  return json(200, { ok: true })
}
