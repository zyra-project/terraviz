// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * POST /api/v1/publish/events/:id/image — upload the publisher's own
 * photo as an event's story image (task: media suggestion engine).
 *
 * The third way an event gets its image, next to the feed/og:image
 * ingest path and the Suggested-media picks: a photo the host
 * organization took itself. Body is `{ contentType, dataBase64 }`
 * through the shared small-image validator (raster only — png / jpeg
 * / webp, SVG deliberately excluded; claimed type verified against
 * magic bytes; capped at {@link EVENT_IMAGE_MAX_BYTES}, the same 4 MB
 * budget as tour media — photos, not favicons).
 *
 * Storage is content-addressed under the CATALOG_R2 binding
 * (`events/image/sha256/{hex}.{ext}`) and the event's `image_url` is
 * set to the resolved PUBLIC http(s) URL — every downstream consumer
 * (blog lead figure, generated-tour intro + thumbnail, detail pane,
 * public events read) treats `image_url` as a plain URL, so the ref
 * indirection stops here. Requires the R2 public origin to be
 * configured; without it the upload is refused rather than storing a
 * URL nothing can fetch.
 *
 * Privileged-only (admin / service), audit-logged
 * (`event.image_upload`), busts the public event caches.
 */

import type { CatalogEnv } from '../../../_lib/env'
import type { PublisherData } from '../../_middleware'
import { writeAuditEvent } from '../../../_lib/audit-store'
import { sha256Hex, validateImagePayload } from '../../../_lib/image-upload'
import { isR2PublicConfigured, resolveHttpAssetUrl } from '../../../_lib/r2-public-url'
import { applyEventEdits, bustFeaturedEventCache, canMutateEvent, getCurrentEvent } from '../../../_lib/events-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

/** Same budget as tour media — these are photos, not favicons. */
export const EVENT_IMAGE_MAX_BYTES = 4 * 1024 * 1024

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestPost: PagesFunction<CatalogEnv, 'id'> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  if (!context.env.CATALOG_R2) {
    return jsonError(503, 'binding_missing', 'CATALOG_R2 binding is not configured on this deployment.')
  }
  if (!isR2PublicConfigured(context.env)) {
    // image_url must be a URL the public surfaces can actually fetch.
    return jsonError(503, 'r2_unconfigured', 'R2 public reads are not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher

  const idParam = context.params.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  if (!id) return jsonError(400, 'invalid_request', 'Missing event id.')

  const db = context.env.CATALOG_DB
  const event = await getCurrentEvent(db, id)
  if (!event) return jsonError(404, 'not_found', `Event ${id} not found.`)
  // Owner-scoped write: the owner writes via content.edit.own; an
  // unclaimed event (owner_id null) requires content.edit.any
  // (editor/admin/service). See canMutateEvent.
  if (!canMutateEvent(publisher, event)) {
    return jsonError(403, 'forbidden_owner', 'You can only edit events you own.')
  }

  let body: { contentType?: unknown; dataBase64?: unknown; altText?: unknown }
  try {
    body = (await context.request.json()) as typeof body
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }

  const payload = validateImagePayload(body, EVENT_IMAGE_MAX_BYTES)
  if (!payload.ok) {
    return new Response(JSON.stringify({ errors: [payload.error] }), {
      status: 400,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }
  const { bytes, contentType, ext } = payload

  // Alt text (media accessibility) — optional but encouraged; stored
  // with the image and used by every surface that renders it. A
  // replacement upload without one clears any stale description.
  let imageAlt: string | null = null
  if (body.altText != null) {
    const alt = typeof body.altText === 'string' ? body.altText.trim() : null
    if (alt === null || alt.length > 512) {
      return new Response(
        JSON.stringify({
          errors: [{ field: 'altText', code: 'invalid', message: '`altText` must be a string of at most 512 characters.' }],
        }),
        { status: 400, headers: { 'Content-Type': CONTENT_TYPE } },
      )
    }
    imageAlt = alt.length > 0 ? alt : null
  }

  // Content-addressed: immutable cache headers, and re-uploading the
  // same photo for another event reuses the object.
  const hex = await sha256Hex(bytes)
  const key = `events/image/sha256/${hex}.${ext}`
  await context.env.CATALOG_R2.put(key, bytes.buffer as ArrayBuffer, {
    httpMetadata: {
      contentType,
      cacheControl: 'public, max-age=31536000, immutable',
    },
  })

  const imageUrl = resolveHttpAssetUrl(context.env, `r2:${key}`)
  if (!imageUrl) {
    // Should be unreachable behind the isR2PublicConfigured gate;
    // refuse rather than store a URL nothing can fetch.
    return jsonError(503, 'r2_unconfigured', 'R2 public reads are not configured on this deployment.')
  }
  await applyEventEdits(db, id, { imageUrl, imageAlt })

  await writeAuditEvent(db, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'event.image_upload',
    subject_kind: 'event',
    subject_id: id,
    metadata_json: JSON.stringify({ content_type: contentType, size: bytes.length }),
  })
  // An approved event's image shows on public surfaces — refresh them.
  await bustFeaturedEventCache(context.env.CATALOG_KV)

  return new Response(JSON.stringify({ imageUrl }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}
