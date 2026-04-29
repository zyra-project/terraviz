/**
 * KV-backed snapshot cache for the public catalog response.
 *
 * The catalog endpoint is the hottest read path in the system.
 * Without caching, every browse-page load issues a SELECT against
 * `datasets` plus four IN-clause batch queries against the
 * decoration tables — five reads against D1's per-day quota. The
 * snapshot pattern reads from D1 once per write (publish, retract,
 * update) and serves every subsequent read from KV until the next
 * invalidation.
 *
 * Layout:
 *   key:   `catalog:snapshot:v1`
 *   value: JSON `{ etag, generatedAt, body, contentType }`
 *
 * The body is the fully-rendered JSON string with no transforms
 * left for the handler — minimum work on the hot path. ETag is
 * derived from a SHA-256 of the body so identical D1 contents
 * produce identical ETags across rebuilds (deterministic 304s,
 * even after a KV eviction).
 *
 * Invalidation is a simple `KV.delete(key)` issued by the publisher
 * write paths (Commits F+). Until those land, the snapshot is
 * effectively immutable per `db:reset`; that is fine for Commit B.
 */

import { CatalogEnv } from './env'

export const SNAPSHOT_KEY = 'catalog:snapshot:v1'

export interface SnapshotPayload {
  /** Strong validator that goes into the `ETag` response header. */
  etag: string
  /** ISO 8601 UTC timestamp of when this snapshot was rendered. */
  generatedAt: string
  /** The rendered response body (already stringified JSON). */
  body: string
  /** Content-Type header to serve alongside the body. */
  contentType: string
}

/**
 * SHA-256 of the body, base64url-encoded and truncated to 22 chars
 * (~132 bits of entropy). Plenty for a content-derived ETag — the
 * collision risk on a real-world catalog is negligible. The
 * shorter form keeps the response header tidy without sacrificing
 * uniqueness.
 */
export async function computeEtag(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const view = new Uint8Array(digest)
  let bin = ''
  for (const b of view) bin += String.fromCharCode(b)
  // Base64url, no padding.
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `"${b64.slice(0, 22)}"`
}

/** Read-through cache: returns the cached payload, or null on miss. */
export async function readSnapshot(env: CatalogEnv): Promise<SnapshotPayload | null> {
  if (!env.CATALOG_KV) return null
  const raw = await env.CATALOG_KV.get(SNAPSHOT_KEY, 'json')
  return (raw as SnapshotPayload | null) ?? null
}

/**
 * Persist a freshly-rendered snapshot. Best-effort — a KV write
 * failure should not fail the request itself, since the response
 * is already rendered and serveable; we just won't cache it.
 */
export async function writeSnapshot(env: CatalogEnv, payload: SnapshotPayload): Promise<void> {
  if (!env.CATALOG_KV) return
  try {
    await env.CATALOG_KV.put(SNAPSHOT_KEY, JSON.stringify(payload))
  } catch {
    // Swallow — operator alerts on KV errors live in Workers Logs.
  }
}

/**
 * Build a fresh snapshot from the renderer fn, write it through to
 * KV, and return the payload. Used by the catalog handler when
 * `readSnapshot` returns null.
 *
 * The renderer is expected to return the etag along with the body —
 * the catalog response stamps the etag both inside the JSON body
 * (per the API contract in CATALOG_BACKEND_PLAN.md "API surface")
 * and in the response header. The two MUST match, so the renderer
 * derives the etag once and the snapshot stores that value.
 */
export async function buildAndCacheSnapshot(
  env: CatalogEnv,
  render: () => Promise<{ body: string; contentType: string; etag: string }>,
): Promise<SnapshotPayload> {
  const { body, contentType, etag } = await render()
  const payload: SnapshotPayload = {
    etag,
    generatedAt: new Date().toISOString(),
    body,
    contentType,
  }
  await writeSnapshot(env, payload)
  return payload
}

/** Invalidate the cached snapshot. Called from publisher write paths. */
export async function invalidateSnapshot(env: CatalogEnv): Promise<void> {
  if (!env.CATALOG_KV) return
  try {
    await env.CATALOG_KV.delete(SNAPSHOT_KEY)
  } catch {
    // See writeSnapshot.
  }
}
