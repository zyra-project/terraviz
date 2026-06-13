/**
 * /api/v1/publish/node-identity — read / provision this node's identity.
 *
 * The `node_identity` row defines the node: it backs
 * `/.well-known/terraviz.json` and supplies the `origin_node` every
 * published dataset is stamped with (the column is NOT NULL). The
 * catalog migrations create the table but never seed it, and the
 * `db:seed` / `gen:node-key` paths only write the local dev D1 — so
 * a fresh remote deploy starts with an empty table, which 503s the
 * well-known doc and fails every publish on the `origin_node`
 * constraint.
 *
 * This route is the bootstrap primitive that fixes that without
 * hand-written D1 SQL. It is the server side of the `terraviz
 * init-node` CLI command, and it works on an empty table because the
 * publisher middleware only depends on the `publishers` table, not
 * `node_identity`.
 *
 *   GET  → { identity: NodeIdentityRow | null }
 *   PUT  → upsert; body { display_name, base_url, description?,
 *          contact_email?, public_key? } → { identity }
 *
 * Authorisation: admin publishers (`is_admin`) or service tokens
 * (`role='service'` — the credential the operator bootstraps a fresh
 * deploy with, same role `/transcode-complete` accepts). Everyone
 * else gets 403.
 */

import type { CatalogEnv } from '../_lib/env'
import type { PublisherData } from './_middleware'
import {
  getNodeIdentity,
  upsertNodeIdentity,
  type NodeIdentityInput,
} from '../_lib/catalog-store'
import { invalidateSnapshot } from '../_lib/snapshot'
import { isPrivileged } from '../_lib/publisher-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const MAX_FIELD_LEN = 2048

/** Ed25519 public keys are 32 raw bytes; the wire format the
 *  well-known doc + `gen-node-key` use is `ed25519:<standard-base64>`.
 *  Validate the prefix and that the base64 body decodes to exactly
 *  32 bytes so a typo (e.g. `abc123`) can't provision a node that
 *  advertises an unusable key in `/.well-known/terraviz.json`. */
function isValidNodePublicKey(s: string): boolean {
  const prefix = 'ed25519:'
  if (!s.startsWith(prefix)) return false
  const b64 = s.slice(prefix.length)
  if (b64.length === 0) return false
  let decoded: string
  try {
    decoded = atob(b64)
  } catch {
    return false
  }
  return decoded.length === 32
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

function jsonError(status: number, error: string, message: string): Response {
  return json(status, { error, message })
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  const identity = await getNodeIdentity(context.env.CATALOG_DB!)
  return json(200, { identity })
}

export const onRequestPut: PagesFunction<CatalogEnv> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  // Admin users or service tokens (the bootstrap credential for a
  // fresh deploy) may set the node identity.
  if (!isPrivileged(publisher)) {
    return jsonError(
      403,
      'forbidden',
      'Setting the node identity requires an admin publisher or a service token.',
    )
  }

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body must be valid JSON.')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'Request body must be a JSON object.')
  }
  const b = body as Record<string, unknown>

  const errors: Array<{ field: string; code: string; message: string }> = []

  function optionalString(field: string): string | null | undefined {
    const v = b[field]
    if (v === undefined || v === null) return null
    if (typeof v !== 'string') {
      errors.push({ field, code: 'type', message: `${field} must be a string.` })
      return undefined
    }
    if (v.length > MAX_FIELD_LEN) {
      errors.push({ field, code: 'too_long', message: `${field} exceeds ${MAX_FIELD_LEN} chars.` })
      return undefined
    }
    return v
  }

  const display_name = typeof b.display_name === 'string' ? b.display_name.trim() : ''
  if (!display_name) {
    errors.push({ field: 'display_name', code: 'required', message: 'display_name is required.' })
  } else if (display_name.length > MAX_FIELD_LEN) {
    errors.push({ field: 'display_name', code: 'too_long', message: `display_name exceeds ${MAX_FIELD_LEN} chars.` })
  }

  const base_url = typeof b.base_url === 'string' ? b.base_url.trim() : ''
  if (!base_url) {
    errors.push({ field: 'base_url', code: 'required', message: 'base_url is required.' })
  } else if (base_url.length > MAX_FIELD_LEN) {
    errors.push({ field: 'base_url', code: 'too_long', message: `base_url exceeds ${MAX_FIELD_LEN} chars.` })
  } else {
    try {
      const u = new URL(base_url)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        errors.push({ field: 'base_url', code: 'scheme', message: 'base_url must be http(s).' })
      }
    } catch {
      errors.push({ field: 'base_url', code: 'invalid', message: 'base_url must be a valid URL.' })
    }
  }

  const description = optionalString('description')
  const contact_email = optionalString('contact_email')

  let public_key: string | undefined
  if (b.public_key !== undefined && b.public_key !== null) {
    if (typeof b.public_key !== 'string' || b.public_key.trim().length === 0) {
      errors.push({ field: 'public_key', code: 'invalid', message: 'public_key must be a non-empty string.' })
    } else if (b.public_key.length > MAX_FIELD_LEN) {
      errors.push({ field: 'public_key', code: 'too_long', message: `public_key exceeds ${MAX_FIELD_LEN} chars.` })
    } else if (!isValidNodePublicKey(b.public_key.trim())) {
      errors.push({
        field: 'public_key',
        code: 'format',
        message: 'public_key must be an ed25519 wire key ("ed25519:<base64>" decoding to 32 bytes), as written by `npm run gen:node-key`.',
      })
    } else {
      public_key = b.public_key.trim()
    }
  }

  // A fresh provision needs a public_key (the column is NOT NULL).
  const existing = await getNodeIdentity(context.env.CATALOG_DB!)
  if (!existing && !public_key) {
    errors.push({
      field: 'public_key',
      code: 'required',
      message: 'public_key is required to provision a node for the first time (run `npm run gen:node-key`).',
    })
  }

  if (errors.length > 0) {
    return json(400, { error: 'validation_failed', errors })
  }

  const input: NodeIdentityInput = {
    display_name,
    base_url,
    description: description ?? null,
    contact_email: contact_email ?? null,
    public_key,
  }
  const identity = await upsertNodeIdentity(context.env.CATALOG_DB!, input)

  // The public catalog snapshot embeds node identity, so bust it.
  await invalidateSnapshot(context.env)

  return json(200, { identity })
}
