// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Cloudflare Pages Function — GET /api/exhibit/v1/tags
 *
 * The categories of the Second Life exhibit's dataset menu, at most
 * `TAGS_BUDGET` bytes: `{ tags: [{ tag, count }], more }`.
 * `_lib/exhibit-reads.ts` has the contract and the caps.
 *
 * The tags of the datasets the output page can show, most common first.
 * A tag is never cut, since it is the key sent back as `?tag=`; whole tags
 * are dropped from the least common end until the reply fits, and `more`
 * says so. A tag's `count` is the `total` of the page for that tag.
 *
 * Errors:
 *   - 503 `binding_missing` for a missing `CATALOG_DB`.
 *   - 503 `unavailable` for anything that fails while answering.
 */

import type { CatalogEnv } from '../../v1/_lib/env'
import { buildTags, exhibitAnswer, exhibitError, exhibitJson, exhibitList } from '../../v1/_lib/exhibit-reads'

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return exhibitError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const db = context.env.CATALOG_DB
  return exhibitAnswer('tags', async () => exhibitJson(buildTags(await exhibitList(db))))
}

export const onRequestHead = onRequestGet
