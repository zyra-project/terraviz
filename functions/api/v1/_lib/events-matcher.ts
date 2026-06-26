/**
 * Geo + temporal matcher for current events (see
 * `docs/CURRENT_EVENTS_PLAN.md` §4). Given a current event and the
 * node's catalog, it proposes the datasets the event relates to,
 * scoring each on two independent signals:
 *
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
  upsertEventDatasetLink,
  type CurrentEventRow,
  type EventBoundingBox,
} from './events-store'

/** Default minimum combined score for a proposed link. */
export const DEFAULT_MIN_SCORE = 0.5

/** Default cap on proposed links per event. */
export const DEFAULT_MATCH_LIMIT = 10

/** Horizon over which temporal proximity decays to zero when the event
 *  and a dataset's coverage do not overlap. 14 days: a fortnight either
 *  side of a dataset's window still reads as "around the same time". */
export const TEMPORAL_HORIZON_MS = 14 * 86_400_000

/** The event geometry + time the matcher reads. */
export interface MatchEvent {
  boundingBox?: EventBoundingBox | null
  point?: { lat: number; lon: number } | null
  occurredStart?: string | null
  occurredEnd?: string | null
}

/** The dataset coverage the matcher reads. `boundingBox` is optional and
 *  absent from the catalog today (see module header). */
export interface MatchDataset {
  id: string
  boundingBox?: EventBoundingBox | null
  startTime?: string | null
  endTime?: string | null
  period?: string | null
}

/** Per-signal scores; `null` means "this signal had nothing to read". */
export interface MatchSignals {
  geo: number | null
  temporal: number | null
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

/**
 * Combine the available signals into a single score (the mean of the
 * non-null signals). When no signal has anything to read the score is 0
 * with both signals `null`, so the caller filters it out.
 */
export function scoreMatch(
  event: MatchEvent,
  dataset: MatchDataset,
  nowMs: number,
): MatchResult {
  const geo = scoreGeo(event, dataset.boundingBox)
  const temporal = scoreTemporal(event, dataset, nowMs)
  const present = [geo, temporal].filter((v): v is number => v !== null)
  const score = present.length ? present.reduce((a, b) => a + b, 0) / present.length : 0
  return { datasetId: dataset.id, score, signals: { geo, temporal } }
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
  start_time: string | null
  end_time: string | null
  period: string | null
}

/** Build the matcher's event shape from a stored row. */
function toMatchEvent(row: CurrentEventRow): MatchEvent {
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
  }
}

/**
 * Score an event against the node's published catalog and upsert the
 * resulting `proposed` event→dataset links. Returns the proposals it
 * wrote. Candidate datasets are published, non-hidden, non-retracted
 * rows; their bounding box is not read (the catalog has none yet), so
 * matching runs on the temporal signal today.
 */
export async function runMatcherForEvent(
  db: D1Database,
  eventId: string,
  opts: { now?: number; minScore?: number; limit?: number } = {},
): Promise<MatchResult[]> {
  const nowMs = opts.now ?? Date.now()
  const event = await getCurrentEvent(db, eventId)
  if (!event) return []

  const res = await db
    .prepare(
      `SELECT id, start_time, end_time, period
         FROM datasets
        WHERE published_at IS NOT NULL
          AND is_hidden = 0
          AND retracted_at IS NULL`,
    )
    .all<CandidateRow>()
  const candidates: MatchDataset[] = (res.results ?? []).map(r => ({
    id: r.id,
    startTime: r.start_time,
    endTime: r.end_time,
    period: r.period,
  }))

  const matches = proposeMatches(toMatchEvent(event), candidates, {
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
