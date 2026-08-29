/**
 * Shot sequencing for generated event tours
 * (`docs/TOUR_DIRECTION_PLAN.md` D1).
 *
 * A generated tour used to inherit the matcher's ranking wholesale and
 * truncate it, so four stops that share a facet, a keyword cluster and
 * a bounding box could run back to back. A viewer reads that as the
 * same thing four times, which is the worst outcome for a surface
 * whose job is to show breadth.
 *
 * `orderTourStops` chooses the order instead. It is maximal marginal
 * relevance: the strongest match opens, and every stop after it is the
 * candidate with the best blend of its own match score and its
 * dissimilarity from what has already been shown. Adjacency dominates
 * that penalty (what the viewer actually perceives is "this looks like
 * the last one") with a smaller term against the whole selection, so a
 * plain A B A′ B′ alternation does not score well either.
 *
 * Pure and deterministic: no DB, no fetch, no clock. Ties break on id
 * so the same pool always yields the same tour, which matters because
 * a curator may regenerate a draft and expect to recognise it.
 *
 * Deliberately NOT applied to the blog companion tour, which runs over
 * a curator's hand-picked datasets — reordering an explicit human
 * choice is not this function's business.
 */

/** One candidate stop. `matchScore` is the event-link score; the
 *  facets are the dataset's own decorations, already flattened. */
export interface StopCandidate {
  id: string
  matchScore: number | null
  /** Flattened `facet:value` strings from `dataset_categories`. */
  categories: readonly string[]
  keywords: readonly string[]
  /** NSWE degrees, or null when the dataset declares no extent. */
  bbox: { n: number; s: number; w: number; e: number } | null
}

export interface OrderTourStopsOptions {
  /** How many stops to return. Fewer candidates than this returns them all. */
  limit: number
  /**
   * How hard variety pushes against match score, 0…1. At 0 this is a
   * plain score sort; at 1 the score only picks the opener. The
   * default was chosen so a clearly better match still wins against a
   * moderately similar neighbour, and only a near-duplicate loses.
   */
  varietyWeight?: number
}

export const DEFAULT_VARIETY_WEIGHT = 0.45

/** Weights inside the similarity blend. Categories carry more than
 *  keywords because a facet is curated and a keyword is free text;
 *  geography carries least because two datasets covering the same
 *  region is often exactly the point of an event tour. */
const W_CATEGORY = 0.5
const W_KEYWORD = 0.3
const W_BBOX = 0.2

/** Adjacency versus whole-selection weighting inside the penalty. */
const W_ADJACENT = 0.7
const W_SELECTED = 0.3

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setA = new Set(a)
  let shared = 0
  const seen = new Set<string>()
  for (const value of b) {
    if (seen.has(value)) continue
    seen.add(value)
    if (setA.has(value)) shared += 1
  }
  const union = setA.size + seen.size - shared
  return union === 0 ? 0 : shared / union
}

/**
 * Intersection over union of two lat/lon boxes, in degrees².
 *
 * Longitude is treated as a plain interval: a box crossing the
 * antimeridian would need splitting, and getting that subtly wrong is
 * worse here than not scoring it, so a wrapping box (w > e) scores 0
 * overlap rather than a wrong number. That is the conservative
 * direction — it under-penalises, so a stop is never dropped for a
 * geographic overlap that was miscomputed.
 */
export function bboxOverlap(
  a: StopCandidate['bbox'],
  b: StopCandidate['bbox'],
): number {
  if (!a || !b) return 0
  if (a.w > a.e || b.w > b.e) return 0
  const latOverlap = Math.max(0, Math.min(a.n, b.n) - Math.max(a.s, b.s))
  const lonOverlap = Math.max(0, Math.min(a.e, b.e) - Math.max(a.w, b.w))
  const inter = latOverlap * lonOverlap
  if (inter <= 0) return 0
  const areaA = Math.max(0, a.n - a.s) * Math.max(0, a.e - a.w)
  const areaB = Math.max(0, b.n - b.s) * Math.max(0, b.e - b.w)
  const union = areaA + areaB - inter
  return union <= 0 ? 0 : inter / union
}

/** How alike two candidates look to someone watching them in sequence, 0…1. */
export function stopSimilarity(a: StopCandidate, b: StopCandidate): number {
  return (
    W_CATEGORY * jaccard(a.categories, b.categories) +
    W_KEYWORD * jaccard(a.keywords, b.keywords) +
    W_BBOX * bboxOverlap(a.bbox, b.bbox)
  )
}

/**
 * Normalise match scores across the pool to 0…1.
 *
 * Link scores are not on a fixed scale, and an absolute threshold
 * would behave differently for a tightly-matched event than a loosely
 * matched one. Normalising within the pool keeps `varietyWeight`
 * meaning the same thing in both cases. A pool whose scores are all
 * equal (or all null) normalises to 1, which makes variety the only
 * live signal — the correct behaviour when the matcher has no opinion.
 */
function normalizedScores(candidates: readonly StopCandidate[]): Map<string, number> {
  const scores = candidates.map(c => c.matchScore ?? 0)
  const min = Math.min(...scores)
  const max = Math.max(...scores)
  const span = max - min
  const out = new Map<string, number>()
  candidates.forEach((c, i) => out.set(c.id, span === 0 ? 1 : (scores[i] - min) / span))
  return out
}

/**
 * Order candidates for a generated tour and cap them at `limit`.
 *
 * Returns ids in play order. Input order is not used as a tiebreak —
 * ties resolve on id — so a caller may pass the pool in any order.
 */
export function orderTourStops(
  candidates: readonly StopCandidate[],
  options: OrderTourStopsOptions,
): string[] {
  const limit = Math.max(0, Math.floor(options.limit))
  if (limit === 0 || candidates.length === 0) return []

  const variety = Math.min(1, Math.max(0, options.varietyWeight ?? DEFAULT_VARIETY_WEIGHT))
  const score = normalizedScores(candidates)
  const byId = new Map(candidates.map(c => [c.id, c]))
  const remaining = [...candidates].sort((a, b) => {
    const delta = (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0)
    return delta !== 0 ? delta : a.id.localeCompare(b.id)
  })

  // The opener is the strongest match, full stop. An event tour that
  // does not lead with its best pairing has buried the story.
  const selected: StopCandidate[] = [remaining.shift()!]

  while (selected.length < limit && remaining.length > 0) {
    const previous = selected[selected.length - 1]
    let bestIndex = 0
    let bestValue = -Infinity
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]
      const adjacent = stopSimilarity(previous, candidate)
      let total = 0
      for (const chosen of selected) total += stopSimilarity(chosen, candidate)
      const mean = total / selected.length
      const penalty = W_ADJACENT * adjacent + W_SELECTED * mean
      const value = (1 - variety) * (score.get(candidate.id) ?? 0) - variety * penalty
      // Strictly-greater keeps the earlier candidate on a tie, and
      // `remaining` is already id-ordered within equal scores.
      if (value > bestValue) {
        bestValue = value
        bestIndex = i
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0])
  }

  return selected.map(c => byId.get(c.id)!.id)
}
