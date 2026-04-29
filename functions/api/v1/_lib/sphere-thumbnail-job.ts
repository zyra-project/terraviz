/**
 * Sphere-thumbnail generation job — Phase 1b.
 *
 * Per `CATALOG_ASSETS_PIPELINE.md` "Sphere thumbnails (2:1
 * equirectangular)", every dataset gets a small 512×256
 * equirectangular thumbnail alongside the regular flat one so the
 * browse UI / network-graph view / tour ribbons can render a
 * miniature spinning globe.
 *
 * Triggered by the asset-complete handler (Commit D) when a `data`
 * or `thumbnail` upload finishes. Runs through the InMemoryJobQueue
 * shim (Commit E) — same Worker, no separate consumer — until
 * Cloudflare Queues lands in a later phase.
 *
 * Source picking:
 *   - Stream-uid datasets:  fetch
 *     `https://customer-<id>.cloudflarestream.com/<uid>/thumbnails/thumbnail.jpg?width=512&height=256&time=25%25&fit=crop`.
 *     The `25%` offset avoids title cards and end-frame fades for
 *     most data visualisations.
 *   - R2 image datasets:    if `CF_IMAGES_RESIZE_BASE` is set, use
 *                           Cloudflare Images URL transformations
 *                           (`/cdn-cgi/image/fit=fill,width=512,height=256/<source>`).
 *                           Else fall back to the source bytes
 *                           directly — a publisher portal
 *                           "regenerate sphere thumbnail" button
 *                           (Phase 3) lets a publisher provide a
 *                           hand-cropped version when the
 *                           auto-pick is unrepresentative.
 *
 * The output bytes land in R2 at the predictable, cache-friendly
 * key
 *   `datasets/{id}/sphere-thumbnail.{jpg|webp}`
 * (NOT under `by-digest/sha256/...` because the bytes are derived,
 * not publisher-uploaded — the digest is computed after rendering
 * and stored in `auxiliary_digests.sphere_thumbnail` for federation
 * verification, but the path is fixed so the publisher portal
 * "regenerate" button has a stable target).
 *
 * 1b ships the JPEG variant only. WebP encoding requires either an
 * `IMAGES` binding or a separate transcode step; the schema field
 * `sphere_thumbnail_ref_lg` is reserved but unused until a Phase 4
 * follow-on adds the WebP / 1024×512 paths.
 */

import type { CatalogEnv } from './env'

/** Source descriptor handed to the job. */
export interface SphereThumbnailJobPayload {
  dataset_id: string
  /** `stream:<uid>` for video datasets, `r2:<key>` for image datasets. */
  source_ref: string
}

/** What the job did, surfaced for tests + audit logging. */
export interface SphereThumbnailJobResult {
  ok: true
  sphere_thumbnail_ref: string
  digest: string
  size: number
}

/**
 * Optional injection points so tests can run the job without
 * standing up a real R2 / fetch. The route handler default is
 * `{ fetchImpl: fetch }`.
 */
export interface SphereThumbnailDeps {
  fetchImpl?: typeof fetch
}

/**
 * Render + persist a sphere thumbnail. Idempotent on re-run — the
 * key is fixed and R2 writes overwrite. If the job fails partway
 * through (network blip while fetching the source), the dataset
 * row's `sphere_thumbnail_ref` simply stays at its previous value.
 *
 * Returns `null` if the source isn't a supported scheme yet (e.g.,
 * `vimeo:` — legacy backfill is Phase 4 territory). The caller
 * treats null as "nothing to do, no failure".
 */
export async function generateSphereThumbnail(
  env: CatalogEnv,
  payload: SphereThumbnailJobPayload,
  deps: SphereThumbnailDeps = {},
): Promise<SphereThumbnailJobResult | null> {
  if (!env.CATALOG_R2) {
    throw new Error('CATALOG_R2 binding is required to persist sphere thumbnails.')
  }

  const sourceUrl = pickSourceUrl(env, payload.source_ref)
  if (!sourceUrl) return null

  const fetchImpl = deps.fetchImpl ?? fetch
  const res = await fetchImpl(sourceUrl, { method: 'GET' })
  if (!res.ok) {
    throw new Error(`sphere thumbnail fetch failed (${res.status}) for ${sourceUrl}`)
  }
  const bytes = await res.arrayBuffer()

  // The Stream thumbnail endpoint returns JPEG; the Cloudflare
  // Images variant honours an explicit `format=` parameter (we ask
  // for jpeg in `pickSourceUrl`). Either way we land at jpeg in 1b.
  const ext = 'jpg'
  const r2Key = `datasets/${payload.dataset_id}/sphere-thumbnail.${ext}`
  await env.CATALOG_R2.put(r2Key, bytes, {
    httpMetadata: { contentType: 'image/jpeg' },
  })

  // Compute digest for federation verification. Tiny by construction
  // (≈ tens of KB) so the cost is in noise.
  const digest = await sha256Bytes(bytes)
  const size = bytes.byteLength
  const sphereRef = `r2:${r2Key}`

  await env.CATALOG_DB!
    .prepare(
      `UPDATE datasets
         SET sphere_thumbnail_ref = ?,
             auxiliary_digests = ?,
             updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      sphereRef,
      mergeAuxDigests(
        await readAuxDigests(env.CATALOG_DB!, payload.dataset_id),
        'sphere_thumbnail',
        digest,
      ),
      new Date().toISOString(),
      payload.dataset_id,
    )
    .run()

  return { ok: true, sphere_thumbnail_ref: sphereRef, digest, size }
}

function pickSourceUrl(env: CatalogEnv, sourceRef: string): string | null {
  if (sourceRef.startsWith('stream:')) {
    const uid = sourceRef.slice('stream:'.length)
    const sub =
      env.STREAM_CUSTOMER_SUBDOMAIN?.trim() ||
      (env.MOCK_STREAM === 'true' ? 'customer-mock.cloudflarestream.com' : null)
    if (!sub) return null
    return `https://${sub}/${encodeURIComponent(uid)}/thumbnails/thumbnail.jpg?width=512&height=256&time=25%25&fit=crop`
  }
  if (sourceRef.startsWith('r2:')) {
    const key = sourceRef.slice('r2:'.length)
    const base = env.CF_IMAGES_RESIZE_BASE?.trim()
    const bucket = env.CATALOG_R2_BUCKET?.trim() || 'terraviz-assets'
    if (base) {
      return `${base.replace(/\/$/, '')}/cdn-cgi/image/fit=fill,width=512,height=256,format=jpeg/${bucket}/${encodePath(key)}`
    }
    // No Cloudflare Images integration set up — fall back to using
    // the source bytes verbatim. The publisher portal's "regenerate
    // sphere thumbnail" button (Phase 3) lets a publisher provide a
    // hand-cropped version when the auto-pick is unrepresentative.
    if (env.MOCK_R2 === 'true') {
      return `https://mock-r2.localhost/${bucket}/${encodePath(key)}`
    }
    if (env.R2_S3_ENDPOINT) {
      // Direct R2 read — only valid for public buckets; for Phase 1b
      // this is the operator's call. Restricted assets get a NULL
      // sphere thumbnail until they configure Cloudflare Images.
      const endpoint = env.R2_S3_ENDPOINT.replace(/\/$/, '')
      return `${endpoint}/${bucket}/${encodePath(key)}`
    }
    return null
  }
  // Vimeo + URL + peer schemes are out of 1b scope.
  return null
}

function encodePath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

async function readAuxDigests(
  db: D1Database,
  datasetId: string,
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT auxiliary_digests FROM datasets WHERE id = ? LIMIT 1`)
    .bind(datasetId)
    .first<{ auxiliary_digests: string | null }>()
  return row?.auxiliary_digests ?? null
}

function mergeAuxDigests(existing: string | null, key: string, digest: string): string {
  let parsed: Record<string, string> = {}
  if (existing) {
    try {
      const value = JSON.parse(existing) as unknown
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value as Record<string, string>
      }
    } catch {
      /* malformed → overwrite */
    }
  }
  parsed[key] = digest
  return JSON.stringify(parsed)
}

async function sha256Bytes(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  const view = new Uint8Array(hash)
  let hex = ''
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, '0')
  return `sha256:${hex}`
}
