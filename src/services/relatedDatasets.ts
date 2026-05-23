/**
 * Algorithmic related-dataset recommendations.
 *
 * Phase 2 §4.2 of `docs/WEB_CATALOG_FEATURES_PLAN.md`. The
 * existing `EnrichedMetadata.relatedDatasets` is a manual curated
 * array — when it's empty or short, we augment with up to five
 * algorithmic suggestions scored against the rest of the catalog
 * by shared categories and keywords.
 *
 * Pure module — no DOM, no network, no analytics. The scorer is
 * the only export so tests can pin the exact ranking without
 * standing up a mock catalog through the rendering layer.
 */

import type { Dataset } from '../types'

/** Maximum number of algorithmic recommendations to return. */
const MAX_RECOMMENDATIONS = 5

/** Minimum score for a candidate to count as "actually related"
 *  rather than coincidentally sharing a generic tag. The plan's
 *  formula is `category_overlap × 2 + keyword_overlap`, so a
 *  score of 2 corresponds to either one shared category OR two
 *  shared keywords — a defensible floor for "this is more than
 *  noise." */
const MIN_SCORE = 2

/**
 * Score a candidate against a target dataset using shared
 * categories and keywords. The formula is from
 * `docs/WEB_CATALOG_FEATURES_PLAN.md` §4.2:
 *
 *     category_overlap_count × 2 + keyword_overlap_count
 *
 * Categories carry double weight because they're curator-set
 * groupings, while keywords are author-set and noisier.
 *
 * Categories are compared as flattened `group:value` tokens so
 * that two datasets in `Atmosphere → Temperature` match while
 * `Atmosphere → Pressure` vs `Ocean → Temperature` don't
 * (the bare leaf-string "Temperature" appearing in both is
 * coincidental). Falls back to `tags` when `enriched.categories`
 * is absent — the SOS-only dataset path through
 * `dataService.ts` populates `tags` instead.
 */
export function scoreRelatedness(target: Dataset, candidate: Dataset): number {
  if (target.id === candidate.id) return 0

  const targetCategories = collectCategories(target)
  const candidateCategories = collectCategories(candidate)
  const categoryOverlap = countOverlap(targetCategories, candidateCategories)

  const targetKeywords = collectKeywords(target)
  const candidateKeywords = collectKeywords(candidate)
  const keywordOverlap = countOverlap(targetKeywords, candidateKeywords)

  return categoryOverlap * 2 + keywordOverlap
}

/**
 * Return up to {@link MAX_RECOMMENDATIONS} algorithmically-
 * recommended datasets for `target`, ordered by descending score.
 *
 * `excludeIds` is the set of dataset IDs that have already been
 * surfaced as manual related-datasets — they're filtered out so
 * we don't duplicate them in the augmented list. `manualTitles`
 * is the same list expressed as titles (the manual entry shape
 * is `{ title, url }`, not `{ id }`), used to suppress
 * recommendations whose title matches a manual entry even if the
 * candidate's ID is different.
 *
 * Hidden datasets (`isHidden`) are excluded — they're not in the
 * public browse surface, so they shouldn't show up here either.
 */
export function recommendRelated(
  target: Dataset,
  catalog: Dataset[],
  excludeIds: ReadonlySet<string> = new Set(),
  manualTitles: ReadonlySet<string> = new Set(),
): Dataset[] {
  const scored: Array<{ dataset: Dataset; score: number }> = []
  for (const candidate of catalog) {
    if (candidate.id === target.id) continue
    if (candidate.isHidden) continue
    if (excludeIds.has(candidate.id)) continue
    if (manualTitles.has(normalizeTitle(candidate.title))) continue

    const score = scoreRelatedness(target, candidate)
    if (score < MIN_SCORE) continue
    scored.push({ dataset: candidate, score })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // Stable tiebreaker: catalog weight first, then title — keeps
    // the ranking deterministic so the same dataset doesn't move
    // around between renders when scores tie.
    const weightDiff = (b.dataset.weight ?? 0) - (a.dataset.weight ?? 0)
    if (weightDiff !== 0) return weightDiff
    return a.dataset.title.localeCompare(b.dataset.title)
  })

  return scored.slice(0, MAX_RECOMMENDATIONS).map((s) => s.dataset)
}

/**
 * Flatten `enriched.categories` into `group:value` tokens, falling
 * back to `tags` when categories are absent. A `group` with no
 * leaf values contributes the bare group name as a token so a
 * dataset categorised only at the group level still scores.
 */
function collectCategories(dataset: Dataset): Set<string> {
  const result = new Set<string>()
  const cats = dataset.enriched?.categories
  if (cats && Object.keys(cats).length > 0) {
    for (const [group, subs] of Object.entries(cats)) {
      if (!subs || subs.length === 0) {
        result.add(group)
      } else {
        for (const sub of subs) result.add(`${group}:${sub}`)
      }
    }
    return result
  }
  for (const tag of dataset.tags ?? []) result.add(tag)
  return result
}

/** Read keywords from `enriched.keywords`, falling back to `tags`
 *  for SOS-only rows that have tags but not enriched keywords. */
function collectKeywords(dataset: Dataset): Set<string> {
  const result = new Set<string>()
  const keywords = dataset.enriched?.keywords
  if (keywords && keywords.length > 0) {
    for (const kw of keywords) result.add(kw.toLowerCase())
    return result
  }
  for (const tag of dataset.tags ?? []) result.add(tag.toLowerCase())
  return result
}

function countOverlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0
  for (const item of a) if (b.has(item)) count++
  return count
}

/**
 * Normalize a title for matching against manually-curated
 * related-dataset entries. Mirrors the existing `datasetLoader.ts`
 * rule that strips any `(movie)` marker (case-insensitive) and
 * lowercases, so a manual title "Sea Ice" matches a catalog row
 * titled "Sea Ice (Movie)". The match is intentionally non-
 * anchored — a handful of SOS rows carry the marker mid-title
 * (e.g. "Sea Ice (Movie) — Climate Loop"), and stripping any
 * occurrence keeps the legacy normaliser in `dataService.ts`
 * (which uses the same global regex) in lockstep with this one.
 */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s*\(movie\)\s*/g, '').trim()
}
