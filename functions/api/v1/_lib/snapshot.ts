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
 * (the generation check below) and the D1 round trip it waits on.
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
 *   - `catalog_snapshot_generation` (migration 0062) holds a random
 *     token. `invalidateSnapshot` replaces it, then deletes the KV
 *     entry. Every caller invalidates after its data write, never
 *     before.
 *   - The catalog reads the generation before it reads any data, and
 *     stamps the payload it caches with it.
 *   - A cached payload is served only when its stamp is the current
 *     generation (`lookupSnapshot`). Anything else is a miss, and the
 *     rebuild overwrites it.
 *
 * A stale entry that a failed delete left behind carries an older
 * generation, and so does a raced render's late `put`, because it
 * read the generation before the retraction replaced it. Neither is
 * served. The KV delete stays as the fast path, and a failed one is
 * harmless while the generation write landed.
 *
 * This relies on every read here reaching D1's primary, which holds
 * while nothing on this path uses `withSession`. A replica that lagged
 * the write could hand back the old generation, which would match.
 *
 * What is left, each bounded by the entry's TTL:
 *
 *   - The generation cannot be read when a request arrives: D1 down
 *     or out of quota, or a deploy ahead of migration 0062. A payload
 *     this code wrote is then served unverified, logged at error
 *     level on every such request. A payload with no `generation`
 *     field was written before this check, without a TTL, and is never
 *     served this way.
 *   - The generation write fails after the data write landed (logged
 *     at error level, once, by `invalidateSnapshot`). An entry stamped
 *     with the old generation then still counts as current: the old
 *     snapshot itself if the KV delete failed too, a raced render's
 *     late `put`, an isolate copy that never reached KV, and every
 *     other deployment's entry for this D1.
 *   - A write that never reaches the generation write: one made
 *     through a deployment of older code sharing this D1 (a preview,
 *     or a rollback), a hand-run SQL fix or a D1 restore, or a request
 *     the runtime ends between its data write and `invalidateSnapshot`.
 *     Nothing is logged for these.
 *
 * In each, a withheld row can be served for at most
 * `SNAPSHOT_TTL_SECONDS` after the snapshot was written, plus the up
 * to 60 s KV edge locations keep a copy they have already read. All of
 * this is the server's side: the response's `Cache-Control` lets
 * browsers and intermediaries keep any catalog body for up to another
 * six minutes (`max-age=60, stale-while-revalidate=300`).
 *
 * Each isolate also keeps the last body it rendered (`isolateCopy`),
 * and serves it only in KV's place: when that body's own `put` failed,
 * as every put does once the free tier's 1k daily KV writes are spent,
 * or there is no KV binding to put it in.
 * A render then costs D1 once per isolate per generation rather than
 * once per request until the quota resets. A copy is served under the
 * same generation check and the same TTL as a KV entry, and when D1
 * cannot be read it fails open as a KV entry does. A copy whose put
 * landed is never served: KV holds that body, so a KV miss means a
 * delete or an expiry, and the next request renders.
 */

import { CatalogEnv } from './env'

export const SNAPSHOT_KEY = 'catalog:snapshot:v1'

/**
 * How long a KV snapshot lives, in seconds: six hours.
 *
 * The generation check, not this TTL, is what retires a snapshot after
 * a write. This TTL is only the upper bound in the cases that check
 * cannot cover (see the module comment). It costs a full D1 render
 * each time the entry expires: four times a day, plus one per KV edge
 * location that misses before the new entry reaches it, or one per
 * isolate when the `put` fails. A render reads every `datasets` row plus the public
 * rows' decorations, the reads `docs/CATALOG_BACKEND_PLAN.md`
 * "Free-tier limits to watch" prices at about 600 for a SOS-scale
 * catalog before decorations. Shorter is a tighter bound and a larger
 * share of the free tier's 5M daily D1 reads and 1k KV writes: an hour
 * would be 24 expiries a day.
 */
export const SNAPSHOT_TTL_SECONDS = 6 * 60 * 60

/**
 * A new generation token, as SQL. One expression for every place that
 * mints one: migration 0062's seed, `replaceSnapshotGeneration`, a
 * missing row read by `readSnapshotGeneration`, and the runbook's
 * manual purge (docs/CATALOG_BACKEND_DEVELOPMENT.md).
 */
const NEW_GENERATION_SQL = 'lower(hex(randomblob(16)))'

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
   * `null` when it could not be read. Served as current only when it
   * equals the generation in D1, so `null` never is.
   */
  generation: string | null
}

/**
 * What KV can hand back. An entry written before the generation check
 * existed has no `generation` field and no TTL.
 */
export type StoredSnapshot = Omit<SnapshotPayload, 'generation'> & {
  generation?: SnapshotPayload['generation']
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
 * A generation failure as a log line. A missing table is an operator
 * action rather than an outage, so it names the fix.
 */
function describeGenerationError(message: string): string {
  return /no such table/i.test(message)
    ? `${message} (migration 0062 has not been applied: run \`wrangler d1 migrations apply CATALOG_DB --remote\` from an up-to-date main checkout)`
    : message
}

/** Where an operator finds how to end an exposure now rather than at the TTL. */
const RUNBOOK =
  'To end it now, see "A withheld dataset is still in the public catalog" in docs/CATALOG_BACKEND_DEVELOPMENT.md.'

/**
 * The current snapshot generation. Throws when D1 fails, including
 * when migration 0062 has not been applied.
 *
 * A missing row (deleted by hand) is given a fresh token here rather
 * than read as a fixed value, which could come back and match an entry
 * stamped with it the last time the row was missing. Concurrent
 * readers agree: the insert is a no-op for all but the first.
 */
export async function readSnapshotGeneration(db: D1Database): Promise<string> {
  const select = () =>
    db
      .prepare('SELECT generation FROM catalog_snapshot_generation WHERE id = 1')
      .first<{ generation: string }>()
  let row = await select()
  if (!row) {
    await db
      .prepare(
        `INSERT INTO catalog_snapshot_generation (id, generation) VALUES (1, ${NEW_GENERATION_SQL})
         ON CONFLICT (id) DO NOTHING`,
      )
      .run()
    row = await select()
  }
  if (!row) throw new Error('catalog_snapshot_generation has no row after inserting one')
  return row.generation
}

/** Replace the snapshot generation with a new token, recreating the row if it is missing. */
async function replaceSnapshotGeneration(db: D1Database): Promise<void> {
  await db
    .prepare(
      `INSERT INTO catalog_snapshot_generation (id, generation) VALUES (1, ${NEW_GENERATION_SQL})
       ON CONFLICT (id) DO UPDATE SET generation = excluded.generation`,
    )
    .run()
}

/**
 * The last body this isolate rendered under a known generation, and
 * whether its KV `put` landed. Served only in KV's place, when it did
 * not (see the module comment), and then only as a KV entry would be:
 * under the current generation, or unverified when D1 cannot be read,
 * and within the TTL either way. Generations are random tokens, so no
 * token minted later can match a copy stamped with an older one, even
 * after a D1 restore.
 */
let isolateCopy: { payload: SnapshotPayload; inKV: boolean } | null = null

/**
 * The generation under which this isolate last deleted a stale KV entry
 * found beside its copy, so it tries once per generation, not on every
 * request.
 */
let staleEntryDeletedFor: string | null = null

/** Forget the isolate copy — tests only; module state outlives a test case. */
export function resetSnapshotIsolateCopyForTests(): void {
  isolateCopy = null
  staleEntryDeletedFor = null
}

function withinTtl(payload: { generatedAt: string }): boolean {
  return Date.now() - Date.parse(payload.generatedAt) < SNAPSHOT_TTL_SECONDS * 1000
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
export async function readSnapshot(env: CatalogEnv): Promise<StoredSnapshot | null> {
  if (!env.CATALOG_KV) return null
  try {
    const raw = await env.CATALOG_KV.get(SNAPSHOT_KEY, 'json')
    return (raw as StoredSnapshot | null) ?? null
  } catch (err) {
    console.warn('[catalog] KV snapshot read failed — rendering from D1:', messageOf(err))
    return null
  }
}

export type SnapshotLookup =
  /** Serve this payload. */
  | { hit: true; payload: StoredSnapshot }
  /**
   * Render from D1 and cache the result under `generation`, which was
   * read before the render starts (`null` when it could not be read).
   */
  | { hit: false; generation: string | null }

/**
 * Decide whether a cached snapshot may be served.
 *
 * The generation and the KV entry are read together, and both before
 * the caller renders anything, so a render's stamp can never be newer
 * than the data it read (see the module comment). A cached payload,
 * from KV or from this isolate, is served only when its stamp is the
 * current generation.
 *
 * When the generation cannot be read the payload cannot be checked.
 * A KV payload this code wrote is then served anyway, logged at error
 * level: D1 is the thing that failed, so a miss would have to render
 * from it and most likely fail too, and the payload carries a TTL that
 * bounds it. A payload from before the generation check carries no TTL,
 * so it is a miss instead.
 */
export async function lookupSnapshot(env: CatalogEnv): Promise<SnapshotLookup> {
  const generationRead = (async (): Promise<{ generation: string } | { error: string }> => {
    if (!env.CATALOG_DB) return { error: 'CATALOG_DB is not bound' }
    try {
      return { generation: await readSnapshotGeneration(env.CATALOG_DB) }
    } catch (err) {
      return { error: describeGenerationError(messageOf(err)) }
    }
  })()
  const [read, cached] = await Promise.all([generationRead, readSnapshot(env)])

  // Only a copy that never reached KV stands in for KV.
  const copy = isolateCopy && !isolateCopy.inKV && withinTtl(isolateCopy.payload) ? isolateCopy.payload : null

  if ('error' in read) {
    const unverified = cached && cached.generation !== undefined ? cached : copy
    if (unverified) {
      console.error(
        '[catalog] snapshot generation read failed — serving the cached snapshot unverified ' +
          `(rendered ${unverified.generatedAt}; served for at most ${SNAPSHOT_TTL_SECONDS} s after that):`,
        read.error,
      )
      return { hit: true, payload: unverified }
    }
    console.error('[catalog] snapshot generation read failed — rendering from D1:', read.error)
    return { hit: false, generation: null }
  }

  if (cached && cached.generation === read.generation) return { hit: true, payload: cached }
  if (copy && copy.generation === read.generation) {
    // KV holds a stale entry beside a current copy: KV is answering
    // again after the outage that failed this copy's put. Delete the
    // entry, so that nothing serves it unverified if D1 is unreadable
    // later. Not a put of the copy, which would give an old render a
    // fresh TTL.
    if (cached && env.CATALOG_KV && staleEntryDeletedFor !== read.generation) {
      staleEntryDeletedFor = read.generation
      try {
        await env.CATALOG_KV.delete(SNAPSHOT_KEY)
      } catch (err) {
        console.warn('[catalog] KV delete of a stale snapshot entry failed:', messageOf(err))
      }
    }
    return { hit: true, payload: copy }
  }
  return { hit: false, generation: read.generation }
}

/**
 * Persist a freshly-rendered snapshot, expiring after
 * `SNAPSHOT_TTL_SECONDS`, and say whether it landed. Best-effort — a
 * KV write failure should not
 * fail the request itself, since the response is already rendered and
 * serveable; we just won't cache it. Logged as a warning rather than
 * an error: an unwritten snapshot costs D1 reads, never correctness,
 * and during a KV outage every request reaches this.
 */
export async function writeSnapshot(env: CatalogEnv, payload: SnapshotPayload): Promise<boolean> {
  if (!env.CATALOG_KV) return false
  try {
    await env.CATALOG_KV.put(SNAPSHOT_KEY, JSON.stringify(payload), {
      expirationTtl: SNAPSHOT_TTL_SECONDS,
    })
    return true
  } catch (err) {
    console.warn('[catalog] KV snapshot write failed — not cached:', messageOf(err))
    return false
  }
}

/**
 * Build a fresh snapshot from the renderer fn, write it through to
 * KV, and return the payload. Used by the catalog handler when
 * `lookupSnapshot` misses, with the generation that lookup read. A
 * render under a known generation also becomes this isolate's copy,
 * served in KV's place if its put failed.
 *
 * The renderer is expected to return the etag along with the body —
 * the catalog response stamps the etag both inside the JSON body
 * (per the API contract in CATALOG_BACKEND_PLAN.md "API surface")
 * and in the response header. The two MUST match, so the renderer
 * derives the etag once and the snapshot stores that value.
 */
export async function buildAndCacheSnapshot(
  env: CatalogEnv,
  generation: string | null,
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
  const inKV = await writeSnapshot(env, payload)
  if (generation !== null) isolateCopy = { payload, inKV }
  return payload
}

/**
 * Invalidate the cached snapshot. Called from publisher write paths,
 * after their data write has landed.
 *
 * Replaces the generation first, then deletes the KV entry. The
 * generation write happens whether or not this deployment binds KV:
 * D1 can be shared by deployments that each cache their own catalog
 * (preview and production do), and the new generation retires all of
 * them. Neither failure fails the caller's request (the write it
 * follows has already landed), so each is logged at the level of what
 * it exposes:
 *
 *   - the generation write fails: error. A catalog stamped with the old
 *     generation still counts as current wherever it is cached (a raced
 *     late put, an isolate copy that never reached KV, every other
 *     deployment sharing this D1) until its TTL runs out.
 *   - only the delete fails: warning. The stale entry carries the old
 *     generation, so it is a miss, and the next read replaces it.
 */
export async function invalidateSnapshot(env: CatalogEnv): Promise<void> {
  let generationError: string | null = null
  if (env.CATALOG_DB) {
    try {
      await replaceSnapshotGeneration(env.CATALOG_DB)
    } catch (err) {
      generationError = describeGenerationError(messageOf(err))
    }
  } else {
    generationError = 'CATALOG_DB is not bound'
  }

  let deleteError: string | null = null
  if (env.CATALOG_KV) {
    try {
      await env.CATALOG_KV.delete(SNAPSHOT_KEY)
    } catch (err) {
      deleteError = messageOf(err)
    }
  }

  if (generationError === null) {
    if (deleteError !== null) {
      console.warn(
        '[catalog] KV snapshot delete failed — the generation write landed, so the stale entry is a ' +
          'miss and the next read replaces it:',
        deleteError,
      )
    }
    return
  }

  if (deleteError !== null) {
    console.error(
      '[catalog] snapshot invalidation failed — the previous catalog, including any row this write ' +
        `withheld, stays current until its KV entry expires (at most ${SNAPSHOT_TTL_SECONDS} s). ` +
        `Generation write: ${generationError}. KV delete: ${deleteError}. ${RUNBOOK}`,
    )
  } else {
    console.error(
      '[catalog] snapshot generation write failed — ' +
        (env.CATALOG_KV ? 'the KV entry was deleted, but ' : '') +
        'a catalog rendered before this write still counts as current wherever it is cached: a render that raced it can ' +
        're-cache it, isolates whose KV write failed keep their copy, and other deployments sharing this ' +
        `D1 keep theirs, for at most ${SNAPSHOT_TTL_SECONDS} s or until the next invalidation. ${RUNBOOK} Cause:`,
      generationError,
    )
  }
}
