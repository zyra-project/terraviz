/**
 * Client for the semantic "more like this" related-datasets endpoint
 * (`GET /api/v1/datasets/:id/related`). This is the network-backed,
 * Vectorize-powered upgrade to the pure lexical scorer in
 * `relatedDatasets.ts` (`docs/CURRENT_EVENTS_PLAN.md` Phase 3b).
 *
 * The info panel renders the lexical recommendations instantly (they
 * need no network and are always available), then calls this service to
 * progressively enhance the list with the semantic ordering. Any
 * failure — non-OK response, a `degraded` backend (Vectorize not wired
 * / quota exhausted), a malformed body, or a network error — resolves
 * to `null`, the signal to keep the lexical list. So the panel never
 * regresses below today's behaviour.
 *
 * Returns only the ordered neighbour ids; the caller maps them back to
 * its in-memory `Dataset[]` (the endpoint and the catalog share ids),
 * which keeps this module free of the `Dataset` shape and trivially
 * testable.
 */

import { logger } from '../utils/logger'

/** Default neighbour count — matches the endpoint's default + the
 *  lexical scorer's `MAX_RECOMMENDATIONS`. */
export const RELATED_DEFAULT_LIMIT = 5

function relatedUrl(datasetId: string, limit: number): string {
  const base =
    typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL ? import.meta.env.BASE_URL : '/'
  return `${base}api/v1/datasets/${encodeURIComponent(datasetId)}/related?limit=${limit}`
}

interface RelatedResponse {
  datasets?: Array<{ id?: unknown }>
  degraded?: unknown
}

/**
 * Fetch the semantic related-dataset ids for `datasetId`, ordered by
 * similarity (nearest first). Resolves to `null` on any failure or a
 * degraded backend, so the caller falls back to the lexical scorer.
 */
export async function fetchSemanticRelatedIds(
  datasetId: string,
  limit: number = RELATED_DEFAULT_LIMIT,
  signal?: AbortSignal,
): Promise<string[] | null> {
  try {
    const res = await fetch(relatedUrl(datasetId, limit), { signal })
    if (!res.ok) return null
    const parsed = (await res.json()) as RelatedResponse
    // A degraded backend returns an empty/partial set we shouldn't
    // treat as authoritative — keep the lexical list instead.
    if (parsed.degraded) return null
    if (!Array.isArray(parsed.datasets)) return null
    const ids = parsed.datasets
      .map(d => (d && typeof d.id === 'string' ? d.id : null))
      .filter((x): x is string => x !== null && x.length > 0)
    return ids.length > 0 ? ids : null
  } catch (err) {
    if ((err as { name?: string })?.name !== 'AbortError') {
      logger.warn('[related] semantic fetch failed; keeping lexical recommendations:', err)
    }
    return null
  }
}
