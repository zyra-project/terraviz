/**
 * Candidate variety signals for tour shot sequencing.
 *
 * The shipped `orderTourStops` scores similarity on categories,
 * keywords and bounding box. This file holds that blend plus the
 * alternatives the experiment compares it against, behind one
 * signature, so the harness can sweep them on equal terms.
 *
 * Experiment scaffolding — not shipped, not imported by the app.
 */

import { bboxOverlap } from '../../../functions/api/v1/_lib/tour-stop-order'
import { tokenize } from '../../../functions/api/v1/_lib/events-matcher'
import type { RichCandidate, SimilarityFn } from './harness'



function jaccard(a: readonly string[] | ReadonlySet<string>, b: readonly string[] | ReadonlySet<string>): number {
  const setA = a instanceof Set ? a : new Set(a as readonly string[])
  const setB = b instanceof Set ? b : new Set(b as readonly string[])
  if (setA.size === 0 || setB.size === 0) return 0
  let shared = 0
  for (const v of setB) if (setA.has(v)) shared += 1
  const union = setA.size + setB.size - shared
  return union === 0 ? 0 : shared / union
}

/** Fraction of the shorter time span that the two spans share. Two
 *  datasets covering the same window are more interchangeable than two
 *  covering different decades, and unlike bbox this IS populated (41%
 *  of the live catalog carries both bounds). */
function temporalOverlap(a: RichCandidate, b: RichCandidate): number {
  if (a.startMs === null || a.endMs === null || b.startMs === null || b.endMs === null) return 0
  const spanA = a.endMs - a.startMs
  const spanB = b.endMs - b.startMs
  if (spanA <= 0 || spanB <= 0) return 0
  const overlap = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs)
  if (overlap <= 0) return 0
  return overlap / Math.min(spanA, spanB)
}

/** V0 — exactly what shipped. Included so the sweep measures the real
 *  baseline rather than a reconstruction of it. */
export const shipped: SimilarityFn = (a, b) =>
  0.5 * jaccard(a.categories, b.categories) +
  0.3 * jaccard(a.keywords, b.keywords) +
  0.2 * bboxOverlap(a.bbox, b.bbox)

/** V1 — tags only. The one facet densely populated on real data. */
export const tagsOnly: SimilarityFn = (a, b) => jaccard(a.tags, b.tags)

/** V2 — tags + title tokens, through the matcher's own stemmer. Title
 *  text is 100% populated, so this cannot go null the way facets can. */
export const tagsAndTitle: SimilarityFn = (a, b) =>
  0.6 * jaccard(a.tags, b.tags) + 0.4 * jaccard(a.titleTerms, b.titleTerms)

/** V3 — V2 plus temporal overlap. */
export const tagsTitleTime: SimilarityFn = (a, b) =>
  0.5 * jaccard(a.tags, b.tags) +
  0.35 * jaccard(a.titleTerms, b.titleTerms) +
  0.15 * temporalOverlap(a, b)

/** V4 — everything, degrading field by field. The shipped facets still
 *  carry the most weight WHEN present; tags and title fill the hole
 *  when they are not. This is the shape a fix would most likely take. */
export const layered: SimilarityFn = (a, b) => {
  const parts: Array<[number, number]> = []
  const cat = jaccard(a.categories, b.categories)
  const kw = jaccard(a.keywords, b.keywords)
  const box = bboxOverlap(a.bbox, b.bbox)
  if (a.categories.length && b.categories.length) parts.push([0.35, cat])
  if (a.keywords.length && b.keywords.length) parts.push([0.2, kw])
  if (a.bbox && b.bbox) parts.push([0.15, box])
  if (a.tags.length && b.tags.length) parts.push([0.2, jaccard(a.tags, b.tags)])
  parts.push([0.25, jaccard(a.titleTerms, b.titleTerms)])
  const weight = parts.reduce((s, [w]) => s + w, 0)
  if (weight === 0) return 0
  // Renormalise over the signals that actually had data, so a dataset
  // pair with only titles is scored on titles rather than diluted
  // toward zero by the facets neither of them has.
  return parts.reduce((s, [w, v]) => s + w * v, 0) / weight
}

export const VARIANTS: ReadonlyArray<{ key: string; label: string; fn: SimilarityFn }> = [
  { key: 'v0', label: 'shipped (categories + keywords + bbox)', fn: shipped },
  { key: 'v1', label: 'tags only', fn: tagsOnly },
  { key: 'v2', label: 'tags + title tokens', fn: tagsAndTitle },
  { key: 'v3', label: 'tags + title + temporal', fn: tagsTitleTime },
  { key: 'v4', label: 'layered, renormalised over present signals', fn: layered },
]

export type { RichCandidate, SimilarityFn }
export { jaccard, temporalOverlap }
export { tokenize }
