// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * KV-backed snapshot cache for the public catalog response.
 *
 * The catalog endpoint is the hottest read path in the system.
 * Without caching, every browse-page load issues a SELECT against
 * `datasets` plus four IN-clause batch queries against the
 * decoration tables — five reads against D1's per-day quota. The
 * snapshot pattern renders from D1 once per write (publish, retract,
 * update) and serves every subsequent read from KV until the next
 * invalidation, at the cost of one single-row D1 read per request
 * (the generation check below).
 *
 * Layout:
 *   key:   `catalog:snapshot:v1`
 *   value: JSON `{ etag, generatedAt, body, contentType, generation }`
 *   expiry: `SNAPSHOT_TTL_SECONDS` after the put
 *
 * The body is the fully-rendered JSON string with no transforms
 * left for the handler — minimum work on the hot path. ETag is
 * derived from a SHA-256 of the body so identical D1 contents
 * produce identical ETags across rebuilds (deterministic 304s,
 * even after a KV eviction).
 *
 * Invalidation, and why a KV delete is not enough on its own:
 *
 * The snapshot can hold rows the public must no longer see — a
 * retracted, hidden or unpublished dataset. A KV delete is the only
 * thing that used to retire it, and a delete fails during a KV
 * outage. The entry then outlived the outage and was served again
 * once KV recovered, until some later write deleted it. A render
 * that began before a retraction could also `put` its body after
 * the retraction's delete, caching the retracted row afresh.
 *
 * So the cache is checked against D1, where the write itself lands:
 *
 *   - `catalog_snapshot_generation` (migration 0062) holds a counter.
 *     `invalidateSnapshot` adds 1 to it, then deletes the KV entry.
 *     Every caller invalidates after its data write, never before.
 *   - The catalog reads the generation before it reads any data, and
 *     stamps the payload it caches with that number.
 *   - A cached payload is served only when its generation is the
 *     current one (`lookupSnapshot`). Anything else is a miss, and
 *     the rebuild overwrites it.
 *
 * A stale entry that a failed delete left behind carries an older
 * generation, and so does a raced render's late `put`, because it
 * read the generation before the retraction bumped it. Neither is
 * served. The KV delete stays as the fast path, and a failed one is
 * harmless while the bump landed.
 *
 * What is left is bounded by the entry's TTL and logged at error
 * level when it happens:
 *
 *   - the bump and the delete both fail after the data write landed
 *     (D1 and KV failing together, at that moment);
 *   - the generation cannot be read when a request arrives (D1 down
 *     or out of quota, or a deploy ahead of migration 0062). The
 *     cached payload is then served unverified, as it always was
 *     before this check, rather than failing a read that D1 could
 *     not render anyway.
 *
 * In both, a withheld row can be served for at most
 * `SNAPSHOT_TTL_SECONDS` after the snapshot was written, plus the
 * up to 60 s KV edge locations keep a copy they have already read.
 */

import { CatalogEnv } from './env'

export const SNAPSHOT_KEY = 'catalog:snapshot:v1'

/**
 * How long a KV snapshot lives, in seconds: six hours.
 *
 * The generation check, not this TTL, is what retires a snapshot after
 * a write. This TTL is only the upper bound in the two cases that
 * check cannot cover (see the module comment). It costs a full D1
 * render each time the entry expires, roughly four a day on a quiet
 * node. A render reads every `datasets` row plus the public rows'
 * decorations, the reads `docs/CATALOG_BACKEND_PLAN.md` "Free-tier
 * limits to watch" prices at about 600 for a SOS-scale catalog before
 * decorations. Shorter is a tighter bound and a larger share of the
 * free tier's 5M daily D1 reads: an hour would be roughly 24 renders
 * a day per node.
 */
export const SNAPSHOT_TTL_SECONDS = 6 * 60 * 60

export interface SnapshotPayload {
  /** Strong validator that goes into the `ETag` response header. */
  etag: string
  /** ISO 8601 UTC timestamp of when this snapshot was rendered. */
  generatedAt: string
  /** The rendered response body (already stringified JSON). */
  body: string
  /** Content-Type header to serve alongside the body. */
  contentType: string
  /**
   * The snapshot generation read before this body was rendered, or
   * `null` when it could not be read. A payload is served as current
   * only when this equals the generation in D1, so `null` (and an
   * entry written before migration 0062, which has no such field)
   * never is. See `lookupSnapshot`.
   */
  generation: number | null
}

/**
 * SHA-256 of the body, base64url-encoded and truncated to 22 chars
 * (~132 bits of entropy). Plenty for a content-derived ETag — the
 * collision risk on a real-world catalog is negligible. The
 * shorter form keeps the response header tidy without sacrificing
 * uniqueness.
 */
export const ETAG_HASH_LENGTH = 22

export async function computeEtag(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const view = new Uint8Array(digest)
  let bin = ''
  for (const b of view) bin += String.fromCharCode(b)
  // Base64url, no padding.
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `"${b64.slice(0, ETAG_HASH_LENGTH)}"`
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The current snapshot generation. A database with no row yet reads
 * as 0, matching what the bump's upsert starts from. Throws when D1
 * fails, including when migration 0062 has not been applied.
 */
export async function readSnapshotGeneration(db: D1Database): Promise<number> {
  const row = await db
    .prepare('SELECT generation FROM catalog_snapshot_generation WHERE id = 1')
    .first<{ generation: number }>()
  return row?.generation ?? 0
}

/** Add 1 to the snapshot generation, creating the row if it is missing. */
async function bumpSnapshotGeneration(db: D1Database): Promise<void> {
  await db
    .prepare(
      `INSERT INTO catalog_snapshot_generation (id, generation) VALUES (1, 1)
       ON CONFLICT (id) DO UPDATE SET generation = generation + 1`,
    )
    .run()
}

/**
 * Read-through cache: returns the cached payload, or null on miss.
 * It does not decide whether the payload is current; `lookupSnapshot`
 * does.
 *
 * A read that fails is a miss. The snapshot is rebuilt from D1, the
 * source of truth, so the catalog renders from there instead of
 * answering 500 — which is what every visitor got from a node whose
 * `CATALOG_KV` was bound to a namespace that no longer existed. The
 * failure is logged so the broken binding shows up in Workers Logs;
 * the catalog itself stays up, at the cost of D1 reads per request.
 */
export async function readSnapshot(env: CatalogEnv): Promise<SnapshotPayload | null> {
  if (!env.CATALOG_KV) return null
  try {
    const raw = await env.CATALOG_KV.get(SNAPSHOT_KEY, 'json')
    return (raw as SnapshotPayload | null) ?? null
  } catch (err) {
    console.warn('[catalog] KV snapshot read failed — rendering from D1:', messageOf(err))
    return null
  }
}

export type SnapshotLookup =
  /** Serve this payload. */
  | { hit: true; payload: SnapshotPayload }
  /**
   * Render from D1 and cache the result under `generation`, which was
   * read before the render starts (`null` when it could not be read).
   */
  | { hit: false; generation: number | null }

/**
 * Decide whether the cached snapshot may be served.
 *
 * The generation and the KV entry are read together, and both before
 * the caller renders anything, so a render's stamp can never be newer
 * than the data it read (see the module comment). A cached payload is
 * served only when its stamp is the current generation.
 *
 * When the generation cannot be read the payload cannot be checked,
 * and it is served anyway, logged at error level: D1 is the thing that
 * failed, so a miss would have to render from it and most likely fail
 * too. That leaves the payload's exposure to its TTL.
 */
export async function lookupSnapshot(env: CatalogEnv): Promise<SnapshotLookup> {
  const generationRead = (async (): Promise<{ generation: number } | { error: string }> => {
    if (!env.CATALOG_DB) return { error: 'CATALOG_DB is not bound' }
    try {
      return { generation: await readSnapshotGeneration(env.CATALOG_DB) }
    } catch (err) {
      return { error: messageOf(err) }
    }
  })()
  const [read, cached] = await Promise.all([generationRead, readSnapshot(env)])

  if ('error' in read) {
    if (cached) {
      console.error(
        '[catalog] snapshot generation read failed — serving the cached snapshot unverified ' +
          `(rendered ${cached.generatedAt}; its KV entry lasts at most ${SNAPSHOT_TTL_SECONDS} s):`,
        read.error,
      )
      return { hit: true, payload: cached }
    }
    console.error('[catalog] snapshot generation read failed — rendering from D1:', read.error)
    return { hit: false, generation: null }
  }

  if (cached && cached.generation === read.generation) return { hit: true, payload: cached }
  return { hit: false, generation: read.generation }
}

/**
 * Persist a freshly-rendered snapshot, expiring after
 * `SNAPSHOT_TTL_SECONDS`. Best-effort — a KV write failure should not
 * fail the request itself, since the response is already rendered and
 * serveable; we just won't cache it. Logged as a warning rather than
 * an error: an unwritten snapshot costs D1 reads, never correctness,
 * and during a KV outage every request reaches this.
 */
export async function writeSnapshot(env: CatalogEnv, payload: SnapshotPayload): Promise<void> {
  if (!env.CATALOG_KV) return
  try {
    await env.CATALOG_KV.put(SNAPSHOT_KEY, JSON.stringify(payload), {
      expirationTtl: SNAPSHOT_TTL_SECONDS,
    })
  } catch (err) {
    console.warn('[catalog] KV snapshot write failed — not cached:', messageOf(err))
  }
}

/**
 * Build a fresh snapshot from the renderer fn, write it through to
 * KV, and return the payload. Used by the catalog handler when
 * `lookupSnapshot` misses, with the generation that lookup read.
 *
 * The renderer is expected to return the etag along with the body —
 * the catalog response stamps the etag both inside the JSON body
 * (per the API contract in CATALOG_BACKEND_PLAN.md "API surface")
 * and in the response header. The two MUST match, so the renderer
 * derives the etag once and the snapshot stores that value.
 */
export async function buildAndCacheSnapshot(
  env: CatalogEnv,
  generation: number | null,
  render: () => Promise<{ body: string; contentType: string; etag: string }>,
): Promise<SnapshotPayload> {
  const { body, contentType, etag } = await render()
  const payload: SnapshotPayload = {
    etag,
    generatedAt: new Date().toISOString(),
    body,
    contentType,
    generation,
  }
  await writeSnapshot(env, payload)
  return payload
}

/**
 * Invalidate the cached snapshot. Called from publisher write paths,
 * after their data write has landed.
 *
 * Bumps the generation first, then deletes the KV entry. Either one
 * alone retires the snapshot; the bump is the one that survives a KV
 * outage and closes the read-through race. Neither failure fails the
 * caller's request (the write it follows has already landed), so each
 * is logged at the level of what it exposes:
 *
 *   - the bump fails: error. A late `put` from a render that began
 *     before the write is then served as current, and if the delete
 *     failed too the old snapshot is, until its TTL runs out.
 *   - only the delete fails: warning. The stale entry carries the old
 *     generation, so it is a miss, and the next read replaces it.
 */
export async function invalidateSnapshot(env: CatalogEnv): Promise<void> {
  // No KV, no snapshot to retire: the catalog renders every request.
  if (!env.CATALOG_KV) return

  let bumpError: string | null = null
  if (env.CATALOG_DB) {
    try {
      await bumpSnapshotGeneration(env.CATALOG_DB)
    } catch (err) {
      bumpError = messageOf(err)
    }
  }

  let deleteError: string | null = null
  try {
    await env.CATALOG_KV.delete(SNAPSHOT_KEY)
  } catch (err) {
    deleteError = messageOf(err)
  }

  if (bumpError !== null && deleteError !== null) {
    console.error(
      '[catalog] snapshot invalidation failed — the previous catalog, including any row this write ' +
        `withheld, can be served until its KV entry expires (at most ${SNAPSHOT_TTL_SECONDS} s). ` +
        `Generation bump: ${bumpError}. KV delete: ${deleteError}.`,
    )
  } else if (bumpError !== null) {
    console.error(
      '[catalog] snapshot generation bump failed — the KV entry was deleted, but a render that ' +
        'began before this write can re-cache the previous catalog as current, served until the ' +
        `next invalidation or for at most ${SNAPSHOT_TTL_SECONDS} s:`,
      bumpError,
    )
  } else if (deleteError !== null) {
    console.warn(
      '[catalog] KV snapshot delete failed — the generation bump landed, so the stale entry is a ' +
        'miss and the next read replaces it:',
      deleteError,
    )
  }
}
