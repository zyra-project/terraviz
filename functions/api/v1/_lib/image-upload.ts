// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Shared validation for small direct image uploads (base64-in-JSON).
 *
 * Used by the node-profile logo route and the tour-media route. Both
 * accept `{ contentType, dataBase64 }` bodies, allow only raster
 * types (SVG is deliberately excluded — scriptable content destined
 * for public pages), and verify the claimed content type against the
 * file's magic bytes before anything is stored: the object is served
 * back publicly with that content type, so a lying claim must not
 * stick.
 *
 * The base64-in-JSON transport keeps the publisher API's uniform
 * envelope (session retry, field errors); the presign→PUT→complete
 * pipeline the dataset assets use would be three round-trips for
 * files this small. Callers cap size per surface (logo 512 KB, tour
 * media 4 MB) — the length pre-check bounds the decode before any
 * allocation.
 */

/** Allowlisted raster content types → R2 key extension. */
export const IMAGE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

export interface ImageFieldError {
  field: string
  code: string
  message: string
}

export type ImagePayloadResult =
  | { ok: true; bytes: Uint8Array; contentType: string; ext: string }
  | { ok: false; error: ImageFieldError }

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
export function sniffImageType(bytes: Uint8Array): keyof typeof IMAGE_CONTENT_TYPES | null {
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

/** SHA-256 of the bytes as lowercase hex (for content-addressed keys). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
  let out = ''
  for (const b of new Uint8Array(hash)) out += b.toString(16).padStart(2, '0')
  return out
}

/** Human-readable cap for error copy — whole MiB reads as "4 MB",
 *  anything else as KB, matching the UI's own wording. */
function formatMaxBytes(maxBytes: number): string {
  const mib = maxBytes / (1024 * 1024)
  return Number.isInteger(mib) ? `${mib} MB` : `${Math.round(maxBytes / 1024)} KB`
}

/**
 * Validate a `{ contentType, dataBase64 }` body: allowlisted type,
 * bounded size (length pre-check before decode), well-formed base64,
 * magic bytes agreeing with the claim. Field errors use the
 * publisher-API `{ field, code, message }` shape.
 */
export function validateImagePayload(
  body: { contentType?: unknown; dataBase64?: unknown },
  maxBytes: number,
): ImagePayloadResult {
  const contentType = typeof body.contentType === 'string' ? body.contentType : ''
  const ext = IMAGE_CONTENT_TYPES[contentType]
  if (!ext) {
    return {
      ok: false,
      error: {
        field: 'contentType',
        code: 'unsupported',
        message: 'Image must be a PNG, JPEG, or WebP.',
      },
    }
  }

  const tooLarge: ImageFieldError = {
    field: 'dataBase64',
    code: 'too_large',
    message: `Image must be at most ${formatMaxBytes(maxBytes)}.`,
  }
  const b64 = typeof body.dataBase64 === 'string' ? body.dataBase64 : ''
  // 4/3 is the base64 expansion factor (+ padding slack).
  if (!b64 || b64.length > Math.ceil((maxBytes * 4) / 3) + 8) {
    return { ok: false, error: tooLarge }
  }
  const bytes = decodeBase64(b64)
  if (!bytes || bytes.length === 0) {
    return {
      ok: false,
      error: { field: 'dataBase64', code: 'invalid', message: '`dataBase64` is not valid base64.' },
    }
  }
  if (bytes.length > maxBytes) {
    return { ok: false, error: tooLarge }
  }
  if (sniffImageType(bytes) !== contentType) {
    return {
      ok: false,
      error: {
        field: 'dataBase64',
        code: 'type_mismatch',
        message: 'The file bytes do not match the declared image type.',
      },
    }
  }
  return { ok: true, bytes, contentType, ext }
}
