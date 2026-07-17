/**
 * Shared video-source refresh logic (task: video-sitemap media source).
 *
 * The engine behind the scheduled indexer and the portal's "Index now":
 * given one registered {@link VideoSourceRow}, fetch its sitemap, parse +
 * normalize the entries (`cli/lib/video-sitemap.ts`), embed the ones
 * whose text changed, upsert them into `video_index`, and prune entries
 * that fell out of the sitemap. Centralised here so the cron route and
 * any future importer can't drift — the same shape as `events-ingest.ts`
 * for the events pipeline.
 *
 * Embedding is budgeted and idempotent: an entry is re-embedded only when
 * its title/description/tags text (or the model version) changed since
 * the last run, so steady-state refreshes cost no model calls. When the
 * AI binding is unconfigured or the per-run budget is spent, entries
 * still upsert (content-only) and simply stay unembedded — they become
 * matchable on a later run that has budget. Every failure path is
 * recorded per-source; one bad sitemap never sinks the others.
 *
 * Sitemap-index documents are expanded one level (bounded) into their
 * child sitemaps before parsing.
 */

import {
  parseVideoSitemap,
  parseSitemapIndex,
  isSitemapIndex,
  buildVideoEmbeddingText,
  type SitemapVideo,
} from '../../../../cli/lib/video-sitemap'
import { embedDatasetText, EMBEDDING_MODEL_VERSION, type EmbeddingEnv } from './embeddings'
import {
  upsertIndexedVideo,
  getIndexedVideoStamp,
  pruneIndexedVideos,
} from './video-index-store'
import type { VideoSourceRow } from './video-sources-store'
import { videoSourceRequestHeaders } from './video-sources-store'

/** Give up on a slow sitemap rather than hang the request. */
const FETCH_TIMEOUT_MS = 10_000
/** Cap entries indexed from one source — a backstop against a
 *  pathological sitemap, well above Ocean Today's ~287. */
const MAX_ENTRIES = 2_000
/** Cap child sitemaps expanded from a `<sitemapindex>`. */
const MAX_CHILD_SITEMAPS = 25

export interface VideoRefreshOptions {
  /** Workers AI binding for embeddings. When unconfigured, entries index
   *  content-only (unembedded) — matchable once a later run has AI. */
  env?: EmbeddingEnv
  /** Shared budget of embedding calls across one refresh run (all
   *  sources). Omitted → unbounded (each changed entry embeds). */
  embedBudget?: { remaining: number }
  /** Injectable fetch (routes pass the runtime fetch; tests stub it). */
  fetchFn?: typeof fetch
}

export interface VideoRefreshResult {
  ok: boolean
  /** Raw entries seen across the sitemap (+ any child sitemaps). */
  fetched: number
  /** Entries upserted into the index. */
  indexed: number
  /** Entries (re)embedded this run. */
  embedded: number
  /** Entries dropped that fell out of the sitemap. */
  pruned: number
  /** Human-readable error when `ok` is false (recorded on the source). */
  error?: string
}

/** True only for the http(s) URLs a source may fetch. Registry rows are
 *  operator data — a malformed / non-http URL is a recorded error, never
 *  a `fetch`. */
function isFetchableUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

async function fetchText(url: string, fetchFn: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchFn(url, {
      headers: videoSourceRequestHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

/** Fetch + parse a source into normalized videos, expanding a
 *  sitemap-index one level. Returns null on an unreachable root. */
async function fetchVideos(url: string, fetchFn: typeof fetch): Promise<SitemapVideo[] | null> {
  const root = await fetchText(url, fetchFn)
  if (root === null) return null
  if (!isSitemapIndex(root)) return parseVideoSitemap(root).slice(0, MAX_ENTRIES)

  // Expand a sitemap-index: fetch each child (bounded) and concat. A
  // child that fails to fetch is skipped, not fatal.
  const children = parseSitemapIndex(root).slice(0, MAX_CHILD_SITEMAPS)
  const all: SitemapVideo[] = []
  const seen = new Set<string>()
  for (const child of children) {
    if (!isFetchableUrl(child)) continue
    const xml = await fetchText(child, fetchFn)
    if (xml === null) continue
    for (const v of parseVideoSitemap(xml)) {
      if (seen.has(v.externalId)) continue
      seen.add(v.externalId)
      all.push(v)
      if (all.length >= MAX_ENTRIES) return all
    }
  }
  return all
}

async function sha1Hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s)
  const hash = await crypto.subtle.digest('SHA-1', bytes)
  const view = new Uint8Array(hash)
  let hex = ''
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, '0')
  return hex
}

/** Whether the embedding bindings are usable (real AI or the deterministic mock). */
function haveEmbedding(env: EmbeddingEnv | undefined): boolean {
  return !!env && (env.AI != null || env.MOCK_AI === 'true')
}

/**
 * Refresh one source: fetch → parse → (re)embed changed entries → upsert
 * → prune. Returns a per-source summary. Never throws — a fetch/parse
 * failure returns `{ ok: false, error }` so the caller records it and
 * moves on.
 */
export async function refreshVideoSource(
  db: D1Database,
  source: VideoSourceRow,
  opts: VideoRefreshOptions = {},
): Promise<VideoRefreshResult> {
  const fetchFn = opts.fetchFn ?? fetch
  if (!isFetchableUrl(source.url)) {
    return { ok: false, fetched: 0, indexed: 0, embedded: 0, pruned: 0, error: 'invalid sitemap URL (must be http(s))' }
  }

  const videos = await fetchVideos(source.url, fetchFn)
  if (videos === null) {
    return { ok: false, fetched: 0, indexed: 0, embedded: 0, pruned: 0, error: 'could not reach the sitemap' }
  }

  const canEmbed = haveEmbedding(opts.env)
  let indexed = 0
  let embedded = 0
  const now = new Date().toISOString()

  for (const video of videos) {
    let embed: { vector: number[]; version: number; textHash: string } | null = null

    // Only spend hashing + a D1 stamp read when this entry could actually
    // be embedded — i.e. AI is available and the shared budget has
    // headroom. When embedding can't run (unconfigured / budget spent) the
    // entry is upserted content-only and keeps any existing vector, so the
    // hash + change-detection read would be pure waste on a large sitemap.
    const budgetOk = !opts.embedBudget || opts.embedBudget.remaining > 0
    if (canEmbed && budgetOk) {
      const embedText = buildVideoEmbeddingText(video)
      if (embedText) {
        const textHash = await sha1Hex(embedText)
        // Skip re-embedding when the text + model version are unchanged.
        const stamp = await getIndexedVideoStamp(db, source.id, video.externalId)
        const unchanged =
          stamp?.embedTextHash === textHash && stamp?.embeddingVersion === EMBEDDING_MODEL_VERSION
        if (!unchanged) {
          try {
            const vector = await embedDatasetText(opts.env!, embedText)
            embed = { vector, version: EMBEDDING_MODEL_VERSION, textHash }
            embedded++
            if (opts.embedBudget) opts.embedBudget.remaining--
          } catch {
            // Embedding failed this entry — index content-only; a later
            // run retries it.
            embed = null
          }
        }
      }
    }
    await upsertIndexedVideo(db, source.id, video, embed, now)
    indexed++
  }

  const pruned = await pruneIndexedVideos(db, source.id, videos.map(v => v.externalId))
  return { ok: true, fetched: videos.length, indexed, embedded, pruned }
}
