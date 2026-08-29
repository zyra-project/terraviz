/**
 * The shipped `orderTourStops` loop, parameterised by similarity so the
 * variety-signal sweep can swap the signal without re-deriving the
 * algorithm. Lives beside the sequencing scripts rather than in
 * `harness.ts` so the matcher evaluation does not carry it.
 */

import type { RichCandidate, SimilarityFn } from './harness'

export function orderWith(
  candidates: readonly RichCandidate[],
  sim: SimilarityFn,
  limit: number,
  variety: number,
  /** Flip the penalty so the loop MAXIMISES similarity. Produces the
   *  deliberately-repetitive control arm: if judges cannot tell this
   *  apart from the real candidate, the judging instrument is dead and
   *  no preference it reports means anything. */
  invert = false,
): string[] {
  if (limit <= 0 || candidates.length === 0) return []
  const scores = candidates.map(c => c.matchScore ?? 0)
  const min = Math.min(...scores)
  const max = Math.max(...scores)
  const span = max - min
  const norm = new Map(candidates.map((c, i) => [c.id, span === 0 ? 1 : (scores[i] - min) / span]))
  const remaining = [...candidates].sort(
    (a, b) => (norm.get(b.id)! - norm.get(a.id)!) || a.id.localeCompare(b.id),
  )
  const selected: RichCandidate[] = [remaining.shift()!]
  while (selected.length < limit && remaining.length > 0) {
    const prev = selected[selected.length - 1]
    let bestIndex = 0
    let best = -Infinity
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i]
      const adjacent = sim(prev, c)
      let total = 0
      for (const s of selected) total += sim(s, c)
      const penalty = 0.7 * adjacent + 0.3 * (total / selected.length)
      const value = (1 - variety) * norm.get(c.id)! + (invert ? variety : -variety) * penalty
      if (value > best) {
        best = value
        bestIndex = i
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0])
  }
  return selected.map(c => c.id)
}
