// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * POST /api/v1/publish/tours/{id}/media — upload an image for a
 * tour's media rail (task: tour media authoring).
 *
 * Body `{ contentType, dataBase64 }`, validated by the shared
 * `image-upload.ts` helpers (png/jpeg/webp allowlist, magic-byte
 * check, 4 MB cap). Storage is content-addressed under the tour —
 * `tours/{id}/media/sha256/{hex}/media.{ext}` — so public reads get
 * immutable cache headers and identical bytes dedupe to one object.
 *
 * Responds `{ url }`: the fetchable public URL the authoring dock
 * writes into the `showImage` task's `filename`. Hosting tour media
 * on the node's own R2 (rather than hot-linking external hosts) is
 * what makes the VR mirror work — WebGL texture upload requires CORS
 * (`Access-Control-Allow-Origin`), which the R2 public domain already
 * serves for dataset assets; an arbitrary external host usually
 * doesn't.
 *
 * Authorization mirrors `/tours/{id}/json`: the caller must own the
 * tour row (or be admin/service, per `getTourForPublisher`). Video
 * files are NOT accepted here — a tour video is referenced by URL
 * (multi-MB uploads belong to the presign pipeline if ever needed).
 */

import type { CatalogEnv } from '../../../_lib/env'
import type { PublisherData } from '../../_middleware'
import { sha256Hex, validateImagePayload } from '../../../_lib/image-upload'
import { getTourForPublisher } from '../../../_lib/tour-mutations'
import { resolveHttpAssetUrl } from '../../../_lib/r2-public-url'

const CONTENT_TYPE = 'application/json; charset=utf-8'

/** Generous for a context photo or diagram, small enough to stay
 *  comfortable as a base64 JSON body inside Workers memory. */
export const TOUR_MEDIA_MAX_BYTES = 4 * 1024 * 1024

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function pickId(p: string | string[] | undefined): string | null {
  const v = Array.isArray(p) ? p[0] : p
  return v || null
}

export const onRequestPost: PagesFunction<CatalogEnv, 'id'> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  if (!context.env.CATALOG_R2) {
    return jsonError(503, 'binding_missing', 'CATALOG_R2 binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  const id = pickId(context.params.id)
  if (!id) return jsonError(400, 'invalid_request', 'Missing tour id.')

  // Ownership gate BEFORE reading the body — same 404-for-invisible
  // semantics as the draft JSON routes.
  const tour = await getTourForPublisher(context.env.CATALOG_DB, publisher, id)
  if (!tour) {
    return jsonError(404, 'not_found', `Tour ${id} not found.`)
  }

  let body: { contentType?: unknown; dataBase64?: unknown }
  try {
    body = (await context.request.json()) as typeof body
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }

  const payload = validateImagePayload(body, TOUR_MEDIA_MAX_BYTES)
  if (!payload.ok) {
    return new Response(JSON.stringify({ errors: [payload.error] }), {
      status: 400,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }

  const hex = await sha256Hex(payload.bytes)
  const key = `tours/${tour.id}/media/sha256/${hex}/media.${payload.ext}`
  const ref = `r2:${key}`
  // Resolve BEFORE the put: if no public-read origin is bound, the
  // tour JSON could never reference the object — fail with the
  // standard runbook hint instead of writing an unreachable blob.
  const url = resolveHttpAssetUrl(context.env, ref)
  if (!url) {
    return jsonError(
      503,
      'r2_unconfigured',
      'No public R2 origin is configured (set R2_PUBLIC_BASE or MOCK_R2).',
    )
  }

  await context.env.CATALOG_R2.put(key, payload.bytes.buffer as ArrayBuffer, {
    httpMetadata: {
      contentType: payload.contentType,
      cacheControl: 'public, max-age=31536000, immutable',
    },
  })

  return new Response(JSON.stringify({ url }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}
