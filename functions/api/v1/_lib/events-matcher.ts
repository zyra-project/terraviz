// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

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
 *     baseline; the semantic signal below augments it.
 *   - **semantic** — event↔dataset embedding cosine from Vectorize (the
 *     same `@cf/baai/bge-base-en-v1.5` + `terraviz-datasets` index the
 *     docent's `search-datasets` uses). It catches subject relatedness the
 *     curated topic map misses and blends with the lexical signal via
 *     {@link SEMANTIC_WEIGHT}. Best-effort and env-gated: when Workers AI /
 *     Vectorize aren't wired the matcher runs pure lexical/temporal, exactly
 *     as before. The event is embedded on demand; datasets are already
 *     indexed by the publish-time `embed-dataset-job` (no backfill).
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
 * Output is always `status: 'proposed'` — the curator gate decides what an
 * end-user ever sees.
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
import { embedDatasetText, type EmbeddingEnv } from './embeddings'
import { queryEmbedding, VECTORIZE_MAX_TOP_K, type VectorizeEnv } from './vectorize-store'

/** Env surface the semantic signal needs — Workers AI to embed the event
 *  and Vectorize to find nearest datasets. Both optional: when either is
 *  unconfigured the matcher silently skips semantic and runs pure
 *  lexical/temporal, exactly as before Phase 2. Mirrors
 *  `search-datasets.ts`'s `SearchDatasetsEnv`. */
export type MatcherEnv = EmbeddingEnv & VectorizeEnv

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

/** How much the semantic (embedding) signal contributes to the topical
 *  driver when both semantic and lexical are present: `topical =
 *  (1 - w)·lexical + w·semantic`. When only one is present it stands
 *  alone. 0 disables semantic entirely (pure lexical, the pre-Phase-2
 *  behaviour); 1 makes it purely semantic. 0.5 is an even blend — the
 *  curated topic map and the embedding neighbourhood each get half a say,
 *  so an obvious keyword match and an embedding-only relation both surface,
 *  and agreement between them ranks highest. */
export const SEMANTIC_WEIGHT = 0.5

/**
 * Fold the lexical (curated topic-overlap) and semantic (embedding cosine)
 * signals into a single topical driver in [0, 1]:
 *   - both present, lexical > 0 → weighted blend by {@link SEMANTIC_WEIGHT}
 *   - both present, lexical = 0 → semantic stands alone. A lexical 0 means
 *     "the curated map has no evidence", not counter-evidence — blending it
 *     in would halve a strong embedding neighbour and cap it below the
 *     `DEFAULT_MIN_SCORE` gate, defeating the point of the semantic signal.
 *   - only one present → that one
 *   - neither → `null` (caller falls back to temporal/geo)
 * Semantic thus *augments* lexical: it can surface a subject-related
 * dataset the curated map missed (lexical 0, semantic > 0), and it lifts
 * datasets where both agree. Weak semantic-only matches still fall below
 * the min-score gate downstream, so this doesn't add noise.
 */
export function blendTopical(lexical: number | null, semantic: number | null): number | null {
  if (lexical !== null && semantic !== null) {
    if (lexical === 0) return semantic
    return (1 - SEMANTIC_WEIGHT) * lexical + SEMANTIC_WEIGHT * semantic
  }
  return lexical ?? semantic
}

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
 *  {@link buildDatasetTerms}); `semantic` is the event↔dataset cosine
 *  similarity from Vectorize (0..1), present only for datasets that came
 *  back as a nearest-neighbour of the event embedding and `null` (or
 *  absent) otherwise. */
export interface MatchDataset {
  id: string
  boundingBox?: EventBoundingBox | null
  startTime?: string | null
  endTime?: string | null
  period?: string | null
  subjectTerms?: ReadonlySet<string>
  semantic?: number | null
}

/** Per-signal scores; `null` means "this signal had nothing to read". */
export interface MatchSignals {
  geo: number | null
  temporal: number | null
  /** Topical relevance — overlap of the event's (expanded) topic terms
   *  with the dataset's subject terms. */
  lexical: number | null
  /** Semantic relevance — event↔dataset embedding cosine similarity from
   *  Vectorize (0..1), or `null` when semantic matching is unconfigured or
   *  the dataset wasn't a nearest-neighbour of the event. */
  semantic: number | null
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

/** Light plural→singular stem (no full stemmer) for plural/singular
 *  bridging: handles `-oes` (volcanoes→volcano), `-ies` (anomalies→
 *  anomaly), then a single trailing `-s` (storms→storm). */
function stem(token: string): string {
  if (token.length > 4) {
    if (token.endsWith('oes')) return token.slice(0, -2)
    if (token.endsWith('ies')) return `${token.slice(0, -3)}y`
    if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  }
  return token
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

/**
 * Canonical text to embed for an event's semantic signal — its headline,
 * summary, category values and keywords joined into one blob. This is the
 * event-side counterpart of `embeddings.buildDatasetEmbeddingText`: it
 * needn't be byte-identical in shape (the model maps both into the same
 * space), only capture the event's subject so the cosine to a subject-
 * relevant dataset is high. Returns `''` when there's nothing to embed.
 */
export function buildEventEmbeddingText(parts: {
  title?: string | null
  summary?: string | null
  categoryValues?: readonly string[]
  keywords?: readonly string[]
}): string {
  return [
    parts.title ?? '',
    parts.summary ?? '',
    (parts.categoryValues ?? []).join(' '),
    (parts.keywords ?? []).join(' '),
  ]
    .map(s => s.trim())
    .filter(Boolean)
    .join('\n')
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
 * Inverse document frequency over the candidate set: how much evidence
 * one shared term is worth.
 *
 * Without this every shared token counted the same, so a dataset could
 * top a hurricane event on `coast`, `are` and `expected` — three words
 * of abstract prose — while every hurricane-titled dataset sat below
 * it. Smoothed so a term in every dataset is worth ~0 and a term in one
 * dataset is worth ~ln(N).
 */
export function buildIdf(datasets: readonly MatchDataset[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const d of datasets) {
    for (const term of d.subjectTerms ?? EMPTY_TERMS) {
      df.set(term, (df.get(term) ?? 0) + 1)
    }
  }
  const n = Math.max(1, datasets.length)
  const idf = new Map<string, number>()
  for (const [term, count] of df) idf.set(term, Math.log(1 + n / count))
  return idf
}

/**
 * Topical score in [0, 1]: the IDF-weighted cosine similarity between
 * the event's (expanded) topic terms and the dataset's subject terms.
 * 0 means no shared subject and the dataset is filtered out.
 *
 * This replaced `min(1, 0.5 + 0.2 * overlap)`, which had three faults
 * that compounded. It **saturated at three shared terms**, so a quarter
 * of the catalogue scored exactly 1.0 against a typical event and the
 * signal carried no ordering information across them. It counted a raw
 * overlap, so **a long abstract beat a precise title** — a dataset
 * pooling ~100 prose tokens outranked one whose title named the subject.
 * And it **weighted every term equally**, so glue words that survived
 * the short stopword list counted as topical evidence.
 *
 * Cosine fixes all three at once: it never saturates, the dataset's own
 * term mass sits in the denominator so verbosity stops paying, and IDF
 * makes a rare shared term (`aurora`, `tsunami`) worth far more than a
 * common one (`temperature`, `global`). `idf` is optional so a caller
 * scoring a single pair without corpus statistics still gets sane
 * unweighted cosine rather than a fabricated ranking.
 */
/**
 * The IDF-weighted cosine a genuinely strong topical match reaches, used
 * to map cosine onto the 0-1 scale the rest of the system already
 * speaks.
 *
 * This calibration is not cosmetic. `match_score` is stored on
 * `event_dataset_links` and drives the curator UI: the Match Badge
 * percentage and the "Approve all >= 90%" shortcut
 * (`AUTO_PAIR_THRESHOLD`). Raw cosines over sparse term sets run an
 * order of magnitude lower than the old saturating score, so shipping
 * them unscaled would silently retire that shortcut. Normalising by the
 * best match in each candidate set would do the opposite and make every
 * event's top link auto-pairable, including events with nothing
 * relevant in the catalogue at all.
 *
 * An absolute reference keeps the threshold meaning what a curator
 * thinks it means: a weak event scores low and proposes nothing, rather
 * than promoting the best of a bad set. Measured over the live 180-row
 * catalogue, clearly-correct matches reach 0.12-0.21 (wildfire smoke
 * 0.207, sea ice 0.167, drought 0.139, tsunami 0.133, hurricane 0.121)
 * while events with no true match top out at 0.08-0.11. 0.2 puts the
 * first group near 1.0 and leaves the second below the floor.
 */
export const LEXICAL_REFERENCE = 0.20

export function scoreLexical(
  eventTerms: ReadonlySet<string>,
  datasetTerms: ReadonlySet<string>,
  idf?: ReadonlyMap<string, number>,
): number {
  if (eventTerms.size === 0 || datasetTerms.size === 0) return 0
  const weight = (term: string): number => idf?.get(term) ?? 1
  let shared = 0
  let eventMass = 0
  let datasetMass = 0
  for (const term of eventTerms) {
    // Every event term counts toward the denominator, including the
    // ones TOPIC_EXPANSIONS added and no dataset can match.
    //
    // Restricting this to terms present in the corpus was tried and
    // reverted: it made an event whose vocabulary barely intersects the
    // catalogue look *perfectly* covered. A "severe storm" event whose
    // only answerable term was `cloud` scored a cloud dataset at 1.0,
    // because the query had been quietly redefined as the one word the
    // corpus happened to contain. Depressing scores for unmatched
    // expansion terms is the lesser fault, and it is uniform across
    // candidates so it does not distort ranking.
    const w = weight(term)
    eventMass += w * w
    if (datasetTerms.has(term)) shared += w * w
  }
  if (shared === 0) return 0
  for (const term of datasetTerms) {
    const w = weight(term)
    datasetMass += w * w
  }
  if (eventMass === 0 || datasetMass === 0) return 0
  const cosine = shared / Math.sqrt(eventMass * datasetMass)
  return Math.min(1, cosine / LEXICAL_REFERENCE)
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
  idf?: ReadonlyMap<string, number>,
): MatchResult {
  const geo = scoreGeo(event, dataset.boundingBox)
  const temporal = scoreTemporal(event, dataset, nowMs)
  const lexical =
    event.terms && event.terms.size > 0
      ? scoreLexical(event.terms, dataset.subjectTerms ?? EMPTY_TERMS, idf)
      : null
  const semantic = dataset.semantic ?? null
  // Topical relevance drives the score; it's the blend of the curated
  // lexical overlap and the embedding cosine (either may stand alone).
  const topical = blendTopical(lexical, semantic)

  if (topical !== null) {
    // No topical relevance at all → not a match, so no temporal/liveness
    // boost rescues it. (Geo, when dataset boxes land, can fold in here
    // as a separate spatial rescue path.)
    if (topical === 0) {
      return { datasetId: dataset.id, score: 0, signals: { geo, temporal, lexical, semantic } }
    }
    let score = topical * (TOPICAL_BASE + (1 - TOPICAL_BASE) * (temporal ?? 0))
    // Boost toward 1 rather than adding and clamping. An additive bonus
    // has no headroom once the score reaches 1, so a live dataset and an
    // equally-topical static one tie there — the preference silently
    // vanishes exactly for the strongest matches. Scaling the remaining
    // distance keeps live strictly ahead at every score below 1 and can
    // never exceed 1, so no clamp is needed.
    if (isLiveDataset(dataset, nowMs)) score += (1 - score) * LIVE_BONUS
    if (geo !== null) score = (score + geo) / 2
    return { datasetId: dataset.id, score, signals: { geo, temporal, lexical, semantic } }
  }

  const present = [geo, temporal].filter((v): v is number => v !== null)
  const score = present.length ? present.reduce((a, b) => a + b, 0) / present.length : 0
  return { datasetId: dataset.id, score, signals: { geo, temporal, lexical: null, semantic: null } }
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
  // One pass over the candidate set gives every term its rarity, so a
  // shared word is scored by how much it actually distinguishes.
  const idf = buildIdf(datasets)
  return datasets
    .map(d => scoreMatch(event, d, opts.nowMs, idf))
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
/**
 * Best-effort semantic scores: embed the event and ask Vectorize for the
 * nearest datasets, returning a `datasetId → cosine (0..1)` map restricted
 * to the supplied candidate ids. Returns an empty map (never throws) when
 * the AI/Vectorize bindings are unconfigured or any call fails — the
 * matcher then runs pure lexical/temporal, exactly as before. Embed-on-
 * demand: the event is embedded here per run; datasets are already indexed
 * by the publish-time `embed-dataset-job`, so there's no backfill.
 */
async function computeSemanticScores(
  env: MatcherEnv | undefined,
  embedText: string,
  candidateIds: readonly string[],
): Promise<Map<string, number>> {
  const scores = new Map<string, number>()
  if (!env || !embedText || candidateIds.length === 0) return scores
  const haveAi = env.AI != null || env.MOCK_AI === 'true'
  const haveVec = env.CATALOG_VECTORIZE != null || env.MOCK_VECTORIZE === 'true'
  if (!haveAi || !haveVec) return scores
  try {
    const vector = await embedDatasetText(env, embedText)
    const candidateSet = new Set(candidateIds)
    // Query broadly (max top-K) since the nearest neighbours may include
    // datasets outside this event's candidate set (other peers / unpublished);
    // we keep only those that are candidates here.
    const matches = await queryEmbedding(env, vector, { limit: VECTORIZE_MAX_TOP_K })
    for (const m of matches) {
      if (!candidateSet.has(m.dataset_id)) continue
      // Per vectorize-store's contract the score is a cosine similarity
      // (1 = identical, 0 = orthogonal). Clamp defensively to [0, 1] so it
      // blends cleanly with the other [0, 1] signals — the mock (and a raw
      // cosine) can yield a negative value, which just means "unrelated".
      scores.set(m.dataset_id, Math.max(0, Math.min(1, m.score)))
    }
  } catch {
    // Soft-degrade: any embed/query failure → no semantic signal this run.
    return new Map()
  }
  return scores
}

export async function runMatcherForEvent(
  db: D1Database,
  eventId: string,
  opts: { now?: number; minScore?: number; limit?: number; env?: MatcherEnv } = {},
): Promise<MatchResult[]> {
  const nowMs = opts.now ?? Date.now()
  const event = await getCurrentEvent(db, eventId)
  if (!event) return []

  // The event's topic vocabulary (title + summary + curated categories +
  // keywords, expanded with related topics).
  const decorations = await getEventDecorations(db, eventId)
  const categoryValues = Object.values(decorations.categories).flat()
  const eventTerms = buildEventTerms({
    title: event.title,
    summary: event.summary,
    categoryValues,
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
  // category values + tags), read in bulk — but only when the event has
  // topic terms to match against. With no event topics `scoreMatch`
  // falls back to temporal(+geo) and ignores `subjectTerms`, so skip the
  // decoration queries + term building entirely.
  const datasetDecorations = eventTerms.size > 0 ? await getDecorations(db, rows.map(r => r.id)) : null

  // Semantic signal (best-effort): embed the event and find its nearest
  // datasets in Vectorize. Empty map when unconfigured → pure lexical/temporal.
  const semanticScores = await computeSemanticScores(
    opts.env,
    buildEventEmbeddingText({
      title: event.title,
      summary: event.summary,
      categoryValues,
      keywords: decorations.keywords,
    }),
    rows.map(r => r.id),
  )

  const candidates: MatchDataset[] = rows.map(r => {
    const base: MatchDataset = {
      id: r.id,
      startTime: r.start_time,
      endTime: r.end_time,
      period: r.period,
      semantic: semanticScores.get(r.id) ?? null,
    }
    if (!datasetDecorations) return base
    const deco = datasetDecorations.get(r.id)
    return {
      ...base,
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
