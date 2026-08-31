// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * GET /api/v1/publish/media/video-suggest?q=<story text> — ranked
 * non-YouTube video suggestions for an event or blog (task: video-sitemap
 * media source). The server-side counterpart of the `youtube-search`
 * proxy: given a story's text, embed it and cosine-rank the node's
 * indexed sitemap videos (`video_index`), returning the top matches with
 * their direct file URL, thumbnail, and source attribution.
 *
 * Topic-only matching by design — sitemap videos carry no geography and
 * their publish date isn't the story's date, so an ocean-themed story
 * surfaces ocean videos and a non-ocean story surfaces nothing (the
 * min-score gate). The detail pane's "Use as event video" stores the
 * pick on `current_events.video_file_url`.
 *
 * Privileged-only (admin / service), matching the sibling media proxy.
 * Degrades to `{ videos: [] }` — never an error — when AI is unconfigured
 * or the index is empty, so the suggestion card simply shows nothing.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { isPrivileged } from '../../_lib/publisher-store'
import { embedDatasetText } from '../../_lib/embeddings'
import { listVideoSources } from '../../_lib/video-sources-store'
import { queryVideosBySimilarity, type VideoSuggestion } from '../../_lib/video-index-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

/** Max query length embedded — a title + summary is short; cap so a
 *  pathological query can't bloat the embed call. */
const MAX_QUERY_CHARS = 1000
/** Default surfacing threshold. Real BGE cosines for topically-related
 *  text sit well above orthogonal; 0.35 is permissive enough to surface
 *  an ocean video for an ocean story while the min-score gate still keeps
 *  an unrelated story empty. Tunable via `?minScore=`. */
const DEFAULT_MIN_SCORE = 0.35
const MAX_LIMIT = 8
const DEFAULT_LIMIT = 4

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

/** A suggestion as the client card consumes it — the direct file plus the
 *  card's provenance. `contentUrl` is what a native <video> plays and what
 *  the pick stores on `current_events.video_file_url`. */
interface WireSuggestion {
  id: string
  title: string
  pageUrl: string
  contentUrl: string
  thumbnailUrl: string | null
  durationSec: number | null
  attribution: string
  score: number
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return json(403, { error: 'forbidden_role', message: 'Video suggestions are restricted to admin and service callers.' })
  }
  // Missing DB or AI → empty, never an error (the card just shows nothing).
  if (!context.env.CATALOG_DB) return json(200, { videos: [] })
  const haveAi = context.env.AI != null || context.env.MOCK_AI === 'true'
  if (!haveAi) return json(200, { videos: [] })

  const url = new URL(context.request.url)
  const query = (url.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY_CHARS)
  if (!query) return json(200, { videos: [] })

  const minScoreRaw = Number.parseFloat(url.searchParams.get('minScore') ?? '')
  const minScore = Number.isFinite(minScoreRaw) ? minScoreRaw : DEFAULT_MIN_SCORE
  const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(MAX_LIMIT, limitRaw)) : DEFAULT_LIMIT

  const db = context.env.CATALOG_DB
  let suggestions: VideoSuggestion[]
  try {
    const vector = await embedDatasetText(context.env, query)
    suggestions = await queryVideosBySimilarity(db, vector, { minScore, limit })
  } catch {
    // Embedding/query failure → empty, same soft-degrade as the matcher.
    return json(200, { videos: [] })
  }
  if (suggestions.length === 0) return json(200, { videos: [] })

  // Attach each video's source attribution (label fallback). One lookup
  // over the small source list, then a map.
  const sources = await listVideoSources(db)
  const attributionById = new Map(sources.map(s => [s.id, s.attribution || s.label]))

  const videos: WireSuggestion[] = suggestions.map(v => ({
    id: v.id,
    title: v.title,
    pageUrl: v.pageUrl,
    contentUrl: v.contentUrl,
    thumbnailUrl: v.thumbnailUrl,
    durationSec: v.durationSec,
    attribution: attributionById.get(v.sourceId) ?? 'Video source', // i18n-exempt: server payload, client localizes
    score: v.score,
  }))
  return json(200, { videos })
}
