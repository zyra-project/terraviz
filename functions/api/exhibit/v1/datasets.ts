// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Cloudflare Pages Function — GET /api/exhibit/v1/datasets
 *
 * A page of the Second Life exhibit's dataset menu, at most `PAGE_BUDGET`
 * bytes: `{ total, offset, limit, tag, list, datasets: [{ id, title }] }`.
 * `list` is eight hex digits naming the list the page came from
 * (`listHash`): two pages of one tag that differ there may have skipped
 * or repeated a dataset between them. It is opaque and a notice only: it
 * can alternate between two values for a minute after a change, and no
 * request can ask for a particular list, so a reader that started over
 * whenever it changed could loop. `_lib/exhibit-reads.ts` has the contract
 * and the caps.
 *
 * Only the datasets the output page can show, in the order the app's
 * browse lists them. Query parameters, each optional, and an empty one
 * the same as a missing one:
 *   - `tag`: only datasets carrying this tag, matched exactly in its
 *     canonical form, as `GET /api/exhibit/v1/tags` lists it. The reply
 *     echoes the tag it matched; an unknown one gives `total: 0`.
 *   - `offset`: where the page starts (0 to 100000; default 0). Past
 *     `total` gives no datasets.
 *   - `limit`: how many (1 to 9; default 9).
 *
 * Errors:
 *   - 400 `invalid_request` for a malformed parameter, a tag over
 *     `TAG_CAP` bytes among them.
 *   - 503 `binding_missing` for a missing `CATALOG_DB`.
 *   - 503 `unavailable` for anything that fails while answering.
 */

import type { CatalogEnv } from '../../v1/_lib/env'
import { buildPage, exhibitAnswer, exhibitError, exhibitJson, exhibitList, parsePageQuery } from '../../v1/_lib/exhibit-reads'

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return exhibitError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const db = context.env.CATALOG_DB
  const query = parsePageQuery(new URL(context.request.url).searchParams)
  if ('message' in query) return exhibitError(400, 'invalid_request', query.message)
  return exhibitAnswer('page', async () => exhibitJson(buildPage(await exhibitList(db), query)))
}

export const onRequestHead = onRequestGet
