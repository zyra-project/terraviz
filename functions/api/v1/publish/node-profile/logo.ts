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
  LOGO_CONTENT_TYPES,
  LOGO_MAX_BYTES,
  bustNodeProfileCache,
  getNodeProfile,
  setNodeProfileLogo,
} from '../../_lib/node-profile-store'
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

/** Decode standard base64 into bytes; null on malformed input. */
function decodeBase64(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/** Identify the image type from magic bytes — the source of truth
 *  the claimed `contentType` must agree with. */
function sniffImageType(bytes: Uint8Array): keyof typeof LOGO_CONTENT_TYPES | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
  let out = ''
  for (const b of new Uint8Array(hash)) out += b.toString(16).padStart(2, '0')
  return out
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

  const contentType = typeof body.contentType === 'string' ? body.contentType : ''
  const ext = LOGO_CONTENT_TYPES[contentType]
  if (!ext) {
    return fieldErrors([{
      field: 'contentType',
      code: 'unsupported',
      message: 'Logo must be a PNG, JPEG, or WebP image.',
    }])
  }

  const b64 = typeof body.dataBase64 === 'string' ? body.dataBase64 : ''
  // Length pre-check bounds the decode before allocating; 4/3 is the
  // base64 expansion factor (+ padding slack).
  if (!b64 || b64.length > Math.ceil((LOGO_MAX_BYTES * 4) / 3) + 8) {
    return fieldErrors([{
      field: 'dataBase64',
      code: 'too_large',
      message: `Logo must be at most ${Math.round(LOGO_MAX_BYTES / 1024)} KB.`,
    }])
  }
  const bytes = decodeBase64(b64)
  if (!bytes || bytes.length === 0) {
    return fieldErrors([{
      field: 'dataBase64',
      code: 'invalid',
      message: '`dataBase64` is not valid base64.',
    }])
  }
  if (bytes.length > LOGO_MAX_BYTES) {
    return fieldErrors([{
      field: 'dataBase64',
      code: 'too_large',
      message: `Logo must be at most ${Math.round(LOGO_MAX_BYTES / 1024)} KB.`,
    }])
  }
  if (sniffImageType(bytes) !== contentType) {
    return fieldErrors([{
      field: 'dataBase64',
      code: 'type_mismatch',
      message: 'The file bytes do not match the declared image type.',
    }])
  }

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
    await bustNodeProfileCache(context.env.CATALOG_KV)
  }
  // Idempotent — clearing an absent profile/logo is still "no logo".
  return ok(null)
}
