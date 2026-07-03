/**
 * /api/v1/publish/node-profile/logo — upload / remove the
 * organization logo (Phase 3d follow-up; task: org logo on the
 * public blog surface).
 *
 * POST → `{ contentType, dataBase64 }`. Raster images only
 *        (png / jpeg / webp — SVG is deliberately excluded: it is
 *        scriptable content destined for a public page), capped at
 *        {@link LOGO_MAX_BYTES}. The bytes travel base64-in-JSON so
 *        the publisher API keeps its uniform envelope (session
 *        retry, field errors) — at ≤512 KB the 33% inflation is
 *        noise, and the heavyweight presign→PUT→complete pipeline
 *        the dataset assets use would be three round-trips for a
 *        favicon-sized file.
 *
 *        The claimed content type is verified against the file's
 *        magic bytes before anything is stored — the object is
 *        served back publicly with this content type, so a lying
 *        `contentType` must not stick. Storage is content-addressed
 *        (`node/logo/sha256/{hex}/logo.{ext}`) via the CATALOG_R2
 *        binding, so public reads get immutable cache headers and a
 *        re-upload of new art lands at a new URL. A replaced logo's
 *        old object is left in place (tiny, and may still be cached
 *        by public pages until their TTL).
 *
 * DELETE → clear `logo_ref`. Idempotent.
 *
 * Both privileged-only (admin / service), audit-logged
 * (`node_profile.logo_update`), and both bust the public
 * `GET /api/v1/node-profile` KV cache.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import {
  LOGO_MAX_BYTES,
  bustNodeProfileCache,
  getNodeProfile,
  setNodeProfileLogo,
} from '../../_lib/node-profile-store'
import { sha256Hex, validateImagePayload } from '../../_lib/image-upload'
import { isPrivileged } from '../../_lib/publisher-store'
import { resolveHttpAssetUrl } from '../../_lib/r2-public-url'
import { writeAuditEvent } from '../../_lib/audit-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function fieldErrors(errors: Array<{ field: string; code: string; message: string }>): Response {
  return new Response(JSON.stringify({ errors }), {
    status: 400,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function ok(logoUrl: string | null): Response {
  return new Response(JSON.stringify({ logoUrl }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  if (!context.env.CATALOG_R2) {
    return jsonError(503, 'binding_missing', 'CATALOG_R2 binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Editing the node profile is restricted to admin and service callers.')
  }

  let body: { contentType?: unknown; dataBase64?: unknown }
  try {
    body = (await context.request.json()) as typeof body
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }

  const payload = validateImagePayload(body, LOGO_MAX_BYTES)
  if (!payload.ok) {
    // The shared validator speaks about "Image …"; this surface is
    // specifically the logo, so keep the route's original wording.
    return fieldErrors([
      { ...payload.error, message: payload.error.message.replace(/^Image /, 'Logo ') },
    ])
  }
  const { bytes, contentType, ext } = payload

  // Require a saved profile BEFORE writing to R2 so a premature
  // upload doesn't orphan an object it can never reference.
  if (!(await getNodeProfile(context.env.CATALOG_DB))) {
    return fieldErrors([{
      field: 'profile',
      code: 'missing',
      message: 'Save the node profile before uploading a logo.',
    }])
  }

  const hex = await sha256Hex(bytes)
  const key = `node/logo/sha256/${hex}/logo.${ext}`
  await context.env.CATALOG_R2.put(key, bytes.buffer as ArrayBuffer, {
    httpMetadata: {
      contentType,
      cacheControl: 'public, max-age=31536000, immutable',
    },
  })

  const ref = `r2:${key}`
  const result = await setNodeProfileLogo(context.env.CATALOG_DB, publisher, ref)
  if (result === 'missing') {
    // Pre-check raced a profile delete — clean up the just-written
    // object (best-effort) so the miss doesn't orphan it.
    try {
      await context.env.CATALOG_R2.delete(key)
    } catch {
      // Content-addressed and tiny; a failed cleanup is harmless.
    }
    return fieldErrors([{
      field: 'profile',
      code: 'missing',
      message: 'Save the node profile before uploading a logo.',
    }])
  }

  await writeAuditEvent(context.env.CATALOG_DB, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'node_profile.logo_update',
    subject_kind: 'node_profile',
    subject_id: null,
    metadata_json: JSON.stringify({ set: true, content_type: contentType, size: bytes.length }),
  })
  await bustNodeProfileCache(context.env.CATALOG_KV)

  return ok(resolveHttpAssetUrl(context.env, ref))
}

export const onRequestDelete: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Editing the node profile is restricted to admin and service callers.')
  }

  const result = await setNodeProfileLogo(context.env.CATALOG_DB, publisher, null)
  if (result === 'ok') {
    await writeAuditEvent(context.env.CATALOG_DB, {
      actor_kind: 'publisher',
      actor_id: publisher.id,
      action: 'node_profile.logo_update',
      subject_kind: 'node_profile',
      subject_id: null,
      metadata_json: JSON.stringify({ set: false }),
    })
  }
  // Bust regardless of `result` — a missing profile row with a stale
  // KV identity entry would otherwise keep serving the old header
  // until TTL. Idempotent, like the clear itself.
  await bustNodeProfileCache(context.env.CATALOG_KV)
  return ok(null)
}
