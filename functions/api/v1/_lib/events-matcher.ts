/**
 * Topical + temporal + geo matcher for current events (see
 * `docs/CURRENT_EVENTS_PLAN.md` §4). Given a current event and the
 * node's catalog, it proposes the datasets the event relates to,
 * scoring each on independent signals:
 *
 *   - **topical (lexical)** — overlap of the event's subject vocabulary
 *     (title + summary + categories + keywords, expanded with related
 *     topics so a *storm* relates to *cloud* / *precipitation* data; see
 *     {@link buildEventTerms} / {@link TOPIC_EXPANSIONS}) with each
 *     dataset's subject (title + abstract + keywords + categories +
 *     tags). This is what makes different events match different,
 *     subject-relevant datasets instead of every recent event matching
 *     the same live ones. The curated topic map is the explainable
 *     alternative to semantic embeddings (deferred to Phase 2).
 *   - **temporal** — how well the event's time aligns with a dataset's
 *     coverage + liveness. This is the active signal today: the
 *     `datasets` table carries `start_time` / `end_time` / `period`, and
 *     a live dataset (recurring `period`, trailing edge near now) whose
 *     coverage spans the event time is a strong match. Liveness mirrors
 *     the SPA's `isLiveCadence` (`src/utils/time.ts`).
 *   - **geo** — bounding-box overlap (IoU) between the event geometry
 *     and a dataset's coverage box. The math is here and unit-tested,
 *     but the catalog does not yet persist a dataset bounding box
 *     (`migrations/catalog/0001_init.sql` has temporal columns, no
 *     spatial ones), so {@link runMatcherForEvent} currently passes no
 *     dataset box and the geo signal stays `null`. It lights up the
 *     moment dataset coverage lands, or when a caller supplies a box to
 *     the pure {@link scoreGeo} / {@link scoreMatch} helpers.
 *
 * Output is always `status: 'proposed'` — the curator gate (a later
 * slice) decides what an end-user ever sees. Semantic (Vectorize)
 * matching is deferred to Phase 2.
 *
 * The scoring functions are pure; {@link runMatcherForEvent} is the thin
 * D1 orchestration that reads candidates, scores, and upserts proposed
 * links via `events-store`.
 */

import { parseIsoDuration } from './iso-duration'
import {
  getCurrentEvent,
  getEventDecorations,
  upsertEventDatasetLink,
  type CurrentEventRow,
  type EventBoundingBox,
} from './events-store'
import { getDecorations } from './catalog-store'

/** Default minimum combined score for a proposed link. */
export const DEFAULT_MIN_SCORE = 0.5

/** Default cap on proposed links per event. */
export const DEFAULT_MATCH_LIMIT = 10

/** When a topical (lexical) signal is present, topical relevance drives
 *  the score; temporal coverage/liveness only boosts it within
 *  `[TOPICAL_BASE, 1]`. So a topically-irrelevant dataset (lexical 0)
 *  scores 0 and drops out — the fix for "every event matches the same
 *  live datasets". */
const TOPICAL_BASE = 0.75

/** Extra nudge for an overlapping real-time (live) dataset, so live data
 *  surfaces above an equally-topical static dataset. */
const LIVE_BONUS = 0.1

const EMPTY_TERMS: ReadonlySet<string> = new Set()

/** Horizon over which temporal proximity decays to zero when the event
 *  and a dataset's coverage do not overlap. 14 days: a fortnight either
 *  side of a dataset's window still reads as "around the same time". */
export const TEMPORAL_HORIZON_MS = 14 * 86_400_000

/** The event geometry + time + topic vocabulary the matcher reads.
 *  `terms` is the event's expanded topic-term set (see
 *  {@link buildEventTerms}); when present + non-empty it enables the
 *  topical signal. */
export interface MatchEvent {
  boundingBox?: EventBoundingBox | null
  point?: { lat: number; lon: number } | null
  occurredStart?: string | null
  occurredEnd?: string | null
  terms?: ReadonlySet<string>
}

/** The dataset coverage + subject the matcher reads. `boundingBox` is
 *  optional and absent from the catalog today (see module header);
 *  `subjectTerms` is the dataset's subject vocabulary (see
 *  {@link buildDatasetTerms}). */
export interface MatchDataset {
  id: string
  boundingBox?: EventBoundingBox | null
  startTime?: string | null
  endTime?: string | null
  period?: string | null
  subjectTerms?: ReadonlySet<string>
}

/** Per-signal scores; `null` means "this signal had nothing to read". */
export interface MatchSignals {
  geo: number | null
  temporal: number | null
  /** Topical relevance — overlap of the event's (expanded) topic terms
   *  with the dataset's subject terms. */
  lexical: number | null
}

export interface MatchResult {
  datasetId: string
  score: number
  signals: MatchSignals
}

/** Area of a NSWE box in square degrees (0 for a degenerate box). */
function boxArea(b: EventBoundingBox): number {
  return Math.max(0, b.n - b.s) * Math.max(0, b.e - b.w)
}

/**
 * Geographic score in [0, 1], or `null` when there's nothing to compare
 * (no event geometry, or no dataset box). Bounding boxes are scored by
 * intersection-over-union; an event point is scored 1 inside the box, 0
 * outside. Assumes non-antimeridian-crossing boxes (`w < e`) — the
 * catalog's coverage model is the same, and crossing boxes are a future
 * refinement.
 */
export function scoreGeo(
  event: MatchEvent,
  datasetBox: EventBoundingBox | null | undefined,
): number | null {
  if (!datasetBox) return null

  if (event.boundingBox) {
    const a = event.boundingBox
    const b = datasetBox
    const nsOverlap = Math.max(0, Math.min(a.n, b.n) - Math.max(a.s, b.s))
    const ewOverlap = Math.max(0, Math.min(a.e, b.e) - Math.max(a.w, b.w))
    const inter = nsOverlap * ewOverlap
    const union = boxArea(a) + boxArea(b) - inter
    if (union <= 0) return 0
    return inter / union
  }

  if (event.point) {
    const { lat, lon } = event.point
    const inside =
      lat >= datasetBox.s && lat <= datasetBox.n && lon >= datasetBox.w && lon <= datasetBox.e
    return inside ? 1 : 0
  }

  return null
}

/**
 * Whether a dataset is "live" — a recurring `period` whose trailing edge
 * is recent (within two cadences of now), or which has no end at all.
 * Mirrors `isLiveCadence` in the SPA's `src/utils/time.ts`.
 */
export function isLiveDataset(dataset: MatchDataset, nowMs: number): boolean {
  const periodMs = dataset.period ? parseIsoDuration(dataset.period) : null
  if (periodMs === null) return false
  if (!dataset.endTime) return true
  const end = Date.parse(dataset.endTime)
  if (!Number.isFinite(end)) return false
  return nowMs - end <= 2 * periodMs
}

/**
 * Temporal score in [0, 1], or `null` when neither side has a usable
 * timestamp. 1 when the event's time interval overlaps the dataset's
 * coverage; otherwise it decays linearly with the gap over
 * {@link TEMPORAL_HORIZON_MS}. A live dataset's coverage is extended to
 * `now` so an ongoing real-time feed matches a current event.
 */
export function scoreTemporal(
  event: MatchEvent,
  dataset: MatchDataset,
  nowMs: number,
): number | null {
  if (!event.occurredStart) return null
  const evStart = Date.parse(event.occurredStart)
  if (!Number.isFinite(evStart)) return null
  const evEndRaw = event.occurredEnd ? Date.parse(event.occurredEnd) : evStart
  const evEnd = Number.isFinite(evEndRaw) ? evEndRaw : evStart

  const dsStart = Date.parse(dataset.startTime ?? '')
  const dsEnd = Date.parse(dataset.endTime ?? '')
  const hasStart = Number.isFinite(dsStart)
  const hasEnd = Number.isFinite(dsEnd)
  if (!hasStart && !hasEnd) return null

  let covStart = hasStart ? dsStart : dsEnd
  let covEnd = hasEnd ? dsEnd : dsStart
  if (covStart > covEnd) [covStart, covEnd] = [covEnd, covStart]
  // A live dataset is still being appended to, so its effective
  // coverage runs up to the present.
  if (isLiveDataset(dataset, nowMs)) covEnd = Math.max(covEnd, nowMs)

  const overlaps = evStart <= covEnd && covStart <= evEnd
  if (overlaps) return 1

  const gap = evStart > covEnd ? evStart - covEnd : covStart - evEnd
  return Math.max(0, 1 - gap / TEMPORAL_HORIZON_MS)
}

// ----- Topical (lexical) signal -----

/** Glue / generic words that shouldn't drive a topical match. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'near', 'this', 'that', 'these', 'those',
  'over', 'first', 'observed', 'through', 'event', 'events', 'current', 'about',
  'data', 'dataset',
])

/**
 * Topic relationships that bridge the vocabulary gap between an event's
 * coarse category words and a dataset's subject words — e.g. a *severe
 * storm* relates to *cloud* / *precipitation* data even though the words
 * don't overlap. Keyed and valued in the stemmed form {@link tokenize}
 * produces. This is the curated, explainable alternative to semantic
 * embeddings (deferred to Phase 2); it generalizes across feeds that use
 * natural topic words, not just one connector.
 */
const TOPIC_EXPANSIONS: Record<string, readonly string[]> = {
  storm: ['cloud', 'precipitation', 'rain', 'wind', 'cyclone', 'hurricane', 'typhoon', 'lightning', 'weather'],
  severe: ['storm', 'cloud', 'precipitation', 'wind'],
  hurricane: ['cyclone', 'cloud', 'precipitation', 'wind', 'storm'],
  cyclone: ['hurricane', 'cloud', 'wind', 'storm'],
  typhoon: ['cyclone', 'cloud', 'wind', 'storm'],
  wildfire: ['fire', 'smoke', 'thermal', 'burn', 'aerosol'],
  fire: ['smoke', 'thermal', 'burn', 'aerosol'],
  volcano: ['ash', 'eruption', 'thermal', 'sulfur', 'aerosol', 'smoke'],
  volcanoe: ['volcano', 'ash', 'eruption', 'thermal', 'sulfur', 'aerosol'],
  flood: ['precipitation', 'rain', 'water', 'river', 'runoff'],
  drought: ['precipitation', 'soil', 'moisture', 'vegetation', 'temperature'],
  dust: ['aerosol', 'sand', 'air', 'smoke'],
  haze: ['aerosol', 'air', 'smoke', 'pollution'],
  iceberg: ['ice', 'sea', 'polar', 'ocean'],
  ice: ['snow', 'sea', 'polar'],
  snow: ['ice', 'cover', 'cold'],
  earthquake: ['seismic', 'ground'],
  landslide: ['precipitation', 'ground', 'soil'],
  flow: ['lava', 'thermal'],
}

/** Stem a single trailing 's' (storms→storm, clouds→cloud) without a
 *  full stemmer; good enough for plural/singular bridging. */
function stem(token: string): string {
  return token.length > 4 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token
}

/** Lowercase alphabetic tokens of length ≥ 3, stopwords dropped, stemmed.
 *  Digits are dropped (so dates in a summary don't match dataset years). */
export function tokenize(text: string | null | undefined): string[] {
  if (!text) return []
  const raw = text.toLowerCase().match(/[a-z]{3,}/g) ?? []
  return raw.filter(t => !STOPWORDS.has(t)).map(stem)
}

/**
 * Build the event's topic-term set: tokens from its title + summary +
 * category values + keywords, each expanded with related topic terms via
 * {@link TOPIC_EXPANSIONS}. Category values ("Severe Storms") and the
 * title carry the signal; the expansion is what connects them to
 * dataset subjects ("cloud", "precipitation").
 */
export function buildEventTerms(parts: {
  title?: string | null
  summary?: string | null
  categoryValues?: readonly string[]
  keywords?: readonly string[]
}): Set<string> {
  const set = new Set<string>()
  const add = (text: string | null | undefined): void => {
    for (const t of tokenize(text)) {
      set.add(t)
      for (const e of TOPIC_EXPANSIONS[t] ?? []) set.add(e)
    }
  }
  add(parts.title)
  add(parts.summary)
  for (const v of parts.categoryValues ?? []) add(v)
  for (const k of parts.keywords ?? []) add(k)
  return set
}

/** Build a dataset's subject-term set from its title + abstract +
 *  keywords + category values + tags. No expansion — a dataset describes
 *  its own subject directly. */
export function buildDatasetTerms(parts: {
  title?: string | null
  abstract?: string | null
  keywords?: readonly string[]
  categoryValues?: readonly string[]
  tags?: readonly string[]
}): Set<string> {
  const set = new Set<string>()
  const add = (text: string | null | undefined): void => {
    for (const t of tokenize(text)) set.add(t)
  }
  add(parts.title)
  add(parts.abstract)
  for (const k of parts.keywords ?? []) add(k)
  for (const v of parts.categoryValues ?? []) add(v)
  for (const tag of parts.tags ?? []) add(tag)
  return set
}

/**
 * Topical score in [0, 1] from the overlap of the event's (expanded)
 * topic terms with the dataset's subject terms. 0 means no shared
 * subject (the dataset is filtered out); a single shared term already
 * clears the default threshold so a clearly-related dataset surfaces,
 * with more overlap ranking higher.
 */
export function scoreLexical(eventTerms: ReadonlySet<string>, datasetTerms: ReadonlySet<string>): number {
  let overlap = 0
  for (const t of datasetTerms) if (eventTerms.has(t)) overlap++
  return overlap === 0 ? 0 : Math.min(1, 0.5 + 0.2 * overlap)
}

/**
 * Combine the available signals into a single score.
 *
 * When the event has topic terms, **topical relevance drives the score**
 * and temporal coverage/liveness only boosts it within
 * `[TOPICAL_BASE, 1]` (an overlapping real-time dataset gets an extra
 * {@link LIVE_BONUS}). A dataset with no topical overlap scores 0 and is
 * filtered out — so different events get different, subject-relevant
 * matches that favor overlapping real-time data.
 *
 * When the event has no usable topic terms, it falls back to the legacy
 * mean of the temporal (+ geo) signals so the matcher still proposes
 * something rather than nothing.
 */
export function scoreMatch(
  event: MatchEvent,
  dataset: MatchDataset,
  nowMs: number,
): MatchResult {
  const geo = scoreGeo(event, dataset.boundingBox)
  const temporal = scoreTemporal(event, dataset, nowMs)
  const lexical =
    event.terms && event.terms.size > 0
      ? scoreLexical(event.terms, dataset.subjectTerms ?? EMPTY_TERMS)
      : null

  if (lexical !== null) {
    // No shared subject → not a topical match, so no temporal/liveness
    // boost rescues it. (Geo, when dataset boxes land, can fold in here
    // as a separate spatial rescue path.)
    if (lexical === 0) {
      return { datasetId: dataset.id, score: 0, signals: { geo, temporal, lexical } }
    }
    let score = lexical * (TOPICAL_BASE + (1 - TOPICAL_BASE) * (temporal ?? 0))
    if (isLiveDataset(dataset, nowMs)) score = Math.min(1, score + LIVE_BONUS)
    if (geo !== null) score = (score + geo) / 2
    return { datasetId: dataset.id, score, signals: { geo, temporal, lexical } }
  }

  const present = [geo, temporal].filter((v): v is number => v !== null)
  const score = present.length ? present.reduce((a, b) => a + b, 0) / present.length : 0
  return { datasetId: dataset.id, score, signals: { geo, temporal, lexical: null } }
}

/**
 * Score an event against every candidate dataset and return the matches
 * at or above `minScore`, ranked by score (then dataset id for a stable
 * order), capped at `limit`.
 */
export function proposeMatches(
  event: MatchEvent,
  datasets: readonly MatchDataset[],
  opts: { nowMs: number; minScore?: number; limit?: number },
): MatchResult[] {
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE
  const limit = opts.limit ?? DEFAULT_MATCH_LIMIT
  return datasets
    .map(d => scoreMatch(event, d, opts.nowMs))
    .filter(m => m.score >= minScore)
    .sort((a, b) => b.score - a.score || a.datasetId.localeCompare(b.datasetId))
    .slice(0, limit)
}

/** A candidate dataset row as read from D1 for matching. */
interface CandidateRow {
  id: string
  title: string | null
  abstract: string | null
  start_time: string | null
  end_time: string | null
  period: string | null
}

/** Build the matcher's event shape from a stored row + its topic terms. */
function toMatchEvent(row: CurrentEventRow, terms: ReadonlySet<string>): MatchEvent {
  const boundingBox =
    row.bbox_n != null && row.bbox_s != null && row.bbox_w != null && row.bbox_e != null
      ? { n: row.bbox_n, s: row.bbox_s, w: row.bbox_w, e: row.bbox_e }
      : null
  const point = row.point_lat != null && row.point_lon != null
    ? { lat: row.point_lat, lon: row.point_lon }
    : null
  return {
    boundingBox,
    point,
    occurredStart: row.occurred_start,
    occurredEnd: row.occurred_end,
    terms,
  }
}

/**
 * Score an event against the node's published catalog and upsert the
 * resulting `proposed` event→dataset links. Returns the proposals it
 * wrote. Candidate datasets are published, non-hidden, non-retracted
 * rows. Matching runs on the topical signal (event topic terms vs each
 * dataset's subject) boosted by temporal coverage/liveness; geo lights
 * up when dataset bounding boxes land.
 */
export async function runMatcherForEvent(
  db: D1Database,
  eventId: string,
  opts: { now?: number; minScore?: number; limit?: number } = {},
): Promise<MatchResult[]> {
  const nowMs = opts.now ?? Date.now()
  const event = await getCurrentEvent(db, eventId)
  if (!event) return []

  // The event's topic vocabulary (title + summary + curated categories +
  // keywords, expanded with related topics).
  const decorations = await getEventDecorations(db, eventId)
  const eventTerms = buildEventTerms({
    title: event.title,
    summary: event.summary,
    categoryValues: Object.values(decorations.categories).flat(),
    keywords: decorations.keywords,
  })

  const res = await db
    .prepare(
      `SELECT id, title, abstract, start_time, end_time, period
         FROM datasets
        WHERE published_at IS NOT NULL
          AND is_hidden = 0
          AND retracted_at IS NULL`,
    )
    .all<CandidateRow>()
  const rows = res.results ?? []

  // Each candidate's subject vocabulary (title + abstract + keywords +
  // category values + tags), read in bulk.
  const datasetDecorations = await getDecorations(db, rows.map(r => r.id))
  const candidates: MatchDataset[] = rows.map(r => {
    const deco = datasetDecorations.get(r.id)
    return {
      id: r.id,
      startTime: r.start_time,
      endTime: r.end_time,
      period: r.period,
      subjectTerms: buildDatasetTerms({
        title: r.title,
        abstract: r.abstract,
        keywords: deco?.keywords,
        categoryValues: deco?.categories.map(c => c.value),
        tags: deco?.tags,
      }),
    }
  })

  const matches = proposeMatches(toMatchEvent(event, eventTerms), candidates, {
    nowMs,
    minScore: opts.minScore,
    limit: opts.limit,
  })

  const stamp = new Date(nowMs).toISOString()
  for (const m of matches) {
    await upsertEventDatasetLink(
      db,
      {
        eventId,
        datasetId: m.datasetId,
        matchScore: m.score,
        signals: m.signals,
        status: 'proposed',
      },
      stamp,
    )
  }
  return matches
}
