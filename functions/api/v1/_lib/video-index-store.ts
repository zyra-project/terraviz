/**
 * D1 store for the materialized, embedded video index (`video_index`,
 * migration 0040; task: video-sitemap media source).
 *
 * The scheduled refresh job writes here — one row per sitemap entry,
 * deduped on `(source_id, external_id)` — stamping each with the 768-dim
 * BGE embedding of its title/description/tags. The "suggested media"
 * engine reads here: {@link queryVideosBySimilarity} cosine-scans the
 * embeddings against a story's embedding entirely in-Worker (a few
 * hundred vectors is small), and {@link allowlistedContentHosts} derives
 * the media-proxy / native-`<video>` trust set from enabled sources.
 *
 * Vectors are stored as little-endian Float32 BLOBs — compact (~3 KB)
 * and portable across the Workers D1 runtime (ArrayBuffer) and the
 * better-sqlite3 test runtime (Buffer). BGE output is L2-normalized, so
 * cosine reduces to a dot product; {@link cosineSimilarity} still divides
 * by the norms defensively so an unnormalized/mock vector behaves.
 */

import { newUlid } from './ulid'
import { VECTORIZE_EMBEDDING_DIMENSIONS } from './vectorize-store'

/** A normalized sitemap video ready to upsert (the parser's
 *  `SitemapVideo` shape, decoupled to avoid a cli/ import in the
 *  Worker). */
export interface IndexVideoInput {
  externalId: string
  pageUrl: string
  title: string
  description: string
  tags: string[]
  category?: string
  contentUrl: string
  contentHost: string
  thumbnailUrl?: string
  durationSec?: number
  publishedAt?: string
}

/** One `video_index` row, column-for-column (embedding elided from the
 *  public read path — callers that need it use the raw row). */
export interface VideoIndexRow {
  id: string
  source_id: string
  external_id: string
  page_url: string
  title: string
  description: string | null
  tags_json: string | null
  category: string | null
  content_url: string
  content_host: string
  thumbnail_url: string | null
  duration_sec: number | null
  published_at: string | null
  embedding: ArrayBuffer | Uint8Array | null
  embedding_version: number | null
  embed_text_hash: string | null
  created_at: string
  updated_at: string
}

/** A ranked suggestion as the media engine / routes consume it. */
export interface VideoSuggestion {
  id: string
  sourceId: string
  pageUrl: string
  title: string
  description: string | null
  tags: string[]
  category: string | null
  contentUrl: string
  contentHost: string
  thumbnailUrl: string | null
  durationSec: number | null
  publishedAt: string | null
  /** Cosine similarity to the query embedding, 0..1. */
  score: number
}

// ---------------------------------------------------------------------------
// Float32 BLOB pack / unpack
// ---------------------------------------------------------------------------

/** Pack a plain number[] into a little-endian Float32 byte buffer for a
 *  BLOB bind. Returns a Uint8Array (accepted by both D1 and
 *  better-sqlite3). */
export function packEmbedding(values: number[]): Uint8Array {
  const f32 = new Float32Array(values.length)
  for (let i = 0; i < values.length; i++) f32[i] = values[i]
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
}

/** Unpack a BLOB (ArrayBuffer | Uint8Array | Buffer) back to number[].
 *  Returns null for a null/empty or wrong-sized blob so a corrupt row is
 *  skipped, never a throw. */
export function unpackEmbedding(blob: ArrayBuffer | Uint8Array | null | undefined): number[] | null {
  if (!blob) return null
  let bytes: Uint8Array
  if (blob instanceof Uint8Array) bytes = blob
  else if (blob instanceof ArrayBuffer) bytes = new Uint8Array(blob)
  else return null
  if (bytes.byteLength !== VECTORIZE_EMBEDDING_DIMENSIONS * 4) return null
  // Copy into an aligned buffer — a Uint8Array view may not be 4-byte
  // aligned for a direct Float32Array view.
  const aligned = new Uint8Array(bytes.byteLength)
  aligned.set(bytes)
  return Array.from(new Float32Array(aligned.buffer))
}

/** Cosine similarity of two equal-length vectors, or 0 when either is
 *  degenerate (zero norm / length mismatch). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// ---------------------------------------------------------------------------
// Reads / writes
// ---------------------------------------------------------------------------

/** The stored embed-text hash + version for one entry — the refresh job
 *  reads this to skip re-embedding an unchanged video. */
export async function getIndexedVideoStamp(
  db: D1Database,
  sourceId: string,
  externalId: string,
): Promise<{ id: string; embedTextHash: string | null; embeddingVersion: number | null } | null> {
  const row = await db
    .prepare(
      `SELECT id, embed_text_hash, embedding_version FROM video_index
        WHERE source_id = ? AND external_id = ?`,
    )
    .bind(sourceId, externalId)
    .first<{ id: string; embed_text_hash: string | null; embedding_version: number | null }>()
  if (!row) return null
  return { id: row.id, embedTextHash: row.embed_text_hash, embeddingVersion: row.embedding_version }
}

/** Upsert one sitemap video. Content fields are always refreshed;
 *  `embedding`/`embeddingVersion`/`embedTextHash` are written only when
 *  an embedding is supplied (the caller decides whether a re-embed was
 *  needed), so an unchanged video keeps its vector without a model call.
 *  Idempotent on `(source_id, external_id)`. */
export async function upsertIndexedVideo(
  db: D1Database,
  sourceId: string,
  video: IndexVideoInput,
  embed: { vector: number[]; version: number; textHash: string } | null,
  now: string = new Date().toISOString(),
): Promise<void> {
  const tagsJson = video.tags.length ? JSON.stringify(video.tags) : null
  const id = newUlid()
  if (embed) {
    await db
      .prepare(
        `INSERT INTO video_index
           (id, source_id, external_id, page_url, title, description, tags_json, category,
            content_url, content_host, thumbnail_url, duration_sec, published_at,
            embedding, embedding_version, embed_text_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id, external_id) DO UPDATE SET
           page_url = excluded.page_url, title = excluded.title,
           description = excluded.description, tags_json = excluded.tags_json,
           category = excluded.category, content_url = excluded.content_url,
           content_host = excluded.content_host, thumbnail_url = excluded.thumbnail_url,
           duration_sec = excluded.duration_sec, published_at = excluded.published_at,
           embedding = excluded.embedding, embedding_version = excluded.embedding_version,
           embed_text_hash = excluded.embed_text_hash, updated_at = excluded.updated_at`,
      )
      .bind(
        id, sourceId, video.externalId, video.pageUrl, video.title, video.description || null,
        tagsJson, video.category ?? null, video.contentUrl, video.contentHost,
        video.thumbnailUrl ?? null, video.durationSec ?? null, video.publishedAt ?? null,
        packEmbedding(embed.vector), embed.version, embed.textHash, now, now,
      )
      .run()
    return
  }
  // Content-only refresh: keep the existing embedding untouched.
  await db
    .prepare(
      `INSERT INTO video_index
         (id, source_id, external_id, page_url, title, description, tags_json, category,
          content_url, content_host, thumbnail_url, duration_sec, published_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id, external_id) DO UPDATE SET
         page_url = excluded.page_url, title = excluded.title,
         description = excluded.description, tags_json = excluded.tags_json,
         category = excluded.category, content_url = excluded.content_url,
         content_host = excluded.content_host, thumbnail_url = excluded.thumbnail_url,
         duration_sec = excluded.duration_sec, published_at = excluded.published_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      id, sourceId, video.externalId, video.pageUrl, video.title, video.description || null,
      tagsJson, video.category ?? null, video.contentUrl, video.contentHost,
      video.thumbnailUrl ?? null, video.durationSec ?? null, video.publishedAt ?? null, now, now,
    )
    .run()
}

/** Delete a source's indexed videos whose external ids are NOT in
 *  `keep` — the entries that fell out of the sitemap since the last run.
 *  Returns how many were pruned. A `keep` of `[]` clears the source. */
export async function pruneIndexedVideos(
  db: D1Database,
  sourceId: string,
  keep: readonly string[],
): Promise<number> {
  if (keep.length === 0) {
    const res = await db.prepare(`DELETE FROM video_index WHERE source_id = ?`).bind(sourceId).run()
    return res.meta?.changes ?? 0
  }
  // Chunk the NOT IN list so a large sitemap can't blow the SQLite
  // variable limit (999). We delete rows NOT kept, so process by reading
  // the current external ids and removing the complement.
  const existing = await db
    .prepare(`SELECT external_id FROM video_index WHERE source_id = ?`)
    .bind(sourceId)
    .all<{ external_id: string }>()
  const keepSet = new Set(keep)
  const toDelete = (existing.results ?? []).map(r => r.external_id).filter(x => !keepSet.has(x))
  let pruned = 0
  for (let i = 0; i < toDelete.length; i += 100) {
    const chunk = toDelete.slice(i, i + 100)
    const placeholders = chunk.map(() => '?').join(', ')
    const res = await db
      .prepare(`DELETE FROM video_index WHERE source_id = ? AND external_id IN (${placeholders})`)
      .bind(sourceId, ...chunk)
      .run()
    pruned += res.meta?.changes ?? 0
  }
  return pruned
}

/** The set of content hosts across all ENABLED sources' indexed videos —
 *  the media-proxy / native-`<video>` host allowlist. A host earns trust
 *  only by an operator registering a source that serves it. */
export async function allowlistedContentHosts(db: D1Database): Promise<Set<string>> {
  const res = await db
    .prepare(
      `SELECT DISTINCT vi.content_host AS host
         FROM video_index vi
         JOIN video_sources vs ON vs.id = vi.source_id
        WHERE vs.enabled = 1`,
    )
    .all<{ host: string }>()
  return new Set((res.results ?? []).map(r => r.host.toLowerCase()))
}

function rowToSuggestion(row: VideoIndexRow, score: number): VideoSuggestion {
  let tags: string[] = []
  if (row.tags_json) {
    try {
      const parsed: unknown = JSON.parse(row.tags_json)
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string')
    } catch {
      tags = []
    }
  }
  return {
    id: row.id,
    sourceId: row.source_id,
    pageUrl: row.page_url,
    title: row.title,
    description: row.description,
    tags,
    category: row.category,
    contentUrl: row.content_url,
    contentHost: row.content_host,
    thumbnailUrl: row.thumbnail_url,
    durationSec: row.duration_sec,
    publishedAt: row.published_at,
    score,
  }
}

/**
 * Rank a source-agnostic pool of indexed videos against a query
 * embedding by cosine similarity, returning the top matches at or above
 * `minScore`. Only videos from ENABLED sources with a stored embedding
 * are candidates. The scan is in-Worker over the raw BLOBs — fine for
 * the few-hundred-vector scale a node's registered sitemaps produce.
 */
export async function queryVideosBySimilarity(
  db: D1Database,
  queryVector: number[],
  opts: { minScore?: number; limit?: number } = {},
): Promise<VideoSuggestion[]> {
  const minScore = opts.minScore ?? 0.5
  const limit = opts.limit ?? 4
  const res = await db
    .prepare(
      `SELECT vi.* FROM video_index vi
         JOIN video_sources vs ON vs.id = vi.source_id
        WHERE vs.enabled = 1 AND vi.embedding IS NOT NULL`,
    )
    .all<VideoIndexRow>()
  const scored: VideoSuggestion[] = []
  for (const row of res.results ?? []) {
    const vector = unpackEmbedding(row.embedding)
    if (!vector) continue
    const score = cosineSimilarity(queryVector, vector)
    if (score >= minScore) scored.push(rowToSuggestion(row, score))
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return scored.slice(0, limit)
}
