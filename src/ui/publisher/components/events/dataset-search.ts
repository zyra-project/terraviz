/**
 * Shared catalog-search helpers for the Events tab's dataset-pairing UIs
 * (the new-event drawer's "Pair datasets" pane and the detail pane's
 * "+ Add dataset" control). Both read the node's **published** datasets
 * via `GET /api/v1/publish/datasets` — an authed, Vectorize-independent
 * source — and filter client-side by title.
 */

import { publisherGet, handleSessionError, type PublisherApiResult } from '../../api'
import type { ListDatasetsResponse, PublisherDataset } from '../../types'

const DATASETS_ENDPOINT = '/api/v1/publish/datasets'

/** Cap on dataset pages fetched into the in-memory pairing index. */
const MAX_DATASET_PAGES = 6

/**
 * Fetch published datasets into a flat list (paginated, capped). Returns
 * `null` on a session redirect so the caller can leave its search UI
 * disabled rather than enabling it mid-navigation; a partial list is
 * returned on any other error.
 */
export async function loadPublishedDatasets(
  fetchFn: typeof fetch | undefined,
  navigate: ((url: string) => void) | undefined,
): Promise<PublisherDataset[] | null> {
  const all: PublisherDataset[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_DATASET_PAGES; page++) {
    const listUrl: string = `${DATASETS_ENDPOINT}?status=published${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const res: PublisherApiResult<ListDatasetsResponse> = await publisherGet<ListDatasetsResponse>(listUrl, { fetchFn })
    if (!res.ok) {
      if (res.kind === 'session') {
        handleSessionError({ navigate })
        return null
      }
      break
    }
    all.push(...res.data.datasets)
    cursor = res.data.next_cursor
    if (!cursor) break
  }
  return all
}

/**
 * Case-insensitive title-substring filter, excluding a set of dataset ids
 * (e.g. those already paired) and capped to `limit` rows.
 */
export function filterDatasetsByTitle(
  datasets: readonly PublisherDataset[],
  query: string,
  excludeIds: ReadonlySet<string>,
  limit: number,
): PublisherDataset[] {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return []
  const out: PublisherDataset[] = []
  for (const d of datasets) {
    if (excludeIds.has(d.id)) continue
    if (!d.title.toLowerCase().includes(q)) continue
    out.push(d)
    if (out.length >= limit) break
  }
  return out
}
