// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Cloudflare Pages Function — GET /api/exhibit/v1/datasets/{id}
 *
 * A dataset's card for the Second Life exhibit's info script, at most
 * `CARD_BUDGET` bytes: `{ id, page, kind, showable, title, startTime,
 * endTime, period, exactDuration, retry, credit, license, licenseText,
 * abstract, truncated }`. `_lib/exhibit-reads.ts` has the contract and the
 * caps.
 *
 * A tour is a 200 with `kind: "tour"` and `showable: false`, since the
 * dataset exists: the script says why it isn't shown. `showable` is
 * whether the output page can show it, which `kind` alone doesn't say (a
 * video on a `peer:` reference can't be). `exactDuration` is the clip's
 * exact length from its own HLS playlists, a bundle the node holds or a
 * Vimeo stream (whose API gives only whole seconds), or 0 when the node
 * has none, as for a single file. `retry` is set when that length read
 * didn't settle, and the card is then never cached; it isn't read at all
 * for a row the page can't show. The row is read on its own, so the card
 * is as current as the dataset's record. The id is read percent-decoded,
 * since the router hands it over as sent and `llEscapeURL` escapes `-`
 * and `_`.
 *
 * Errors:
 *   - 404 `not_found` for a dataset that isn't public.
 *   - 503 `binding_missing` for a missing `CATALOG_DB`.
 *   - 503 `unavailable` for anything that fails while answering.
 */

import type { CatalogEnv } from '../../../v1/_lib/env'
import {
  buildCard,
  exactLength,
  EXHIBIT_CACHE_CONTROL,
  EXHIBIT_TRANSIENT_CACHE_CONTROL,
  exhibitAnswer,
  exhibitError,
  exhibitJson,
  findPublicRow,
} from '../../../v1/_lib/exhibit-reads'

const ID = /^[A-Za-z0-9_-]{1,64}$/

/** `value` percent-decoded, or "" when it can't be. */
function decoded(value: string | undefined): string {
  try {
    return value ? decodeURIComponent(value) : ''
  } catch {
    return ''
  }
}

export const onRequestGet: PagesFunction<CatalogEnv, 'id'> = async context => {
  if (!context.env.CATALOG_DB) {
    return exhibitError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const db = context.env.CATALOG_DB
  const raw = context.params.id
  const id = decoded(Array.isArray(raw) ? raw[0] : raw)
  if (!id || !ID.test(id)) return exhibitError(404, 'not_found', 'No such dataset.')

  return exhibitAnswer('card', async () => {
    const entry = await findPublicRow(db, id)
    if (!entry) return exhibitError(404, 'not_found', 'No such dataset.')
    const length = entry.showable
      ? await exactLength(entry.row, context.env, p => context.waitUntil(p))
      : { seconds: 0, settled: true }
    const card = buildCard(entry, length)
    return exhibitJson(card, card.retry > 0 ? EXHIBIT_TRANSIENT_CACHE_CONTROL : EXHIBIT_CACHE_CONTROL)
  })
}

export const onRequestHead = onRequestGet
