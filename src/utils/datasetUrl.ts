// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Dataset URL grammar — the single place that knows how a dataset is
 * named in a URL and how a URL reference resolves back to a catalog
 * row.
 *
 * A dataset can be referenced three ways, and all three are accepted
 * wherever a reference is read:
 *
 *   - **slug** (`north-america-smoke`) — the human-readable name the
 *     catalog assigns every row. This is the form we emit.
 *   - **id** (`01KYK82VR6KDQK0915JNMQQ8RG`) — the ULID primary key.
 *     What we used to emit, so it has to keep resolving forever.
 *   - **legacy id** (`INTERNAL_SOS_768`) — pre-cutover SOS ids that
 *     still appear in tour files and links shared before Phase 1d.
 *
 * The three alphabets are disjoint by construction: ULIDs and legacy
 * ids are uppercase with underscores, slugs are lowercase-leading with
 * hyphens (`SLUG_RE` in `functions/api/v1/_lib/validators.ts`). One
 * lookup can therefore try all three in order with no ambiguity about
 * which kind of reference it was handed.
 *
 * Canonical form is `/dataset/<slug>`. Keeping the `/dataset/` prefix
 * — rather than serving slugs from the root — leaves the root
 * namespace free, so adding a top-level page later can never collide
 * with a name a publisher already chose for a dataset.
 */

import type { Dataset } from '../types'

/**
 * The minimum a dataset needs to be nameable in a URL. Declared
 * structurally rather than as a full `Dataset` so callers holding a
 * narrower view of a row — the Tools menu's Share action, for
 * instance — can build a link without reconstructing one.
 */
export type DatasetUrlRef = Pick<Dataset, 'id' | 'slug'>

/** Path prefix every canonical dataset URL carries. */
export const DATASET_PATH_PREFIX = '/dataset/'

/**
 * Characters a dataset reference may contain — the union of the ULID
 * / legacy-id alphabet (`A-Z0-9_`) and the slug alphabet
 * (`a-z0-9-`), length-capped at the slug limit. Deliberately narrow:
 * this pattern is what keeps `?dataset=<script>alert(1)</script>` and
 * other injected values from ever reaching a lookup.
 */
const REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Mirrors `SLUG_RE` in `functions/api/v1/_lib/validators.ts` — the
 * shape the publisher API guarantees for every slug it stores. Used
 * only when *emitting* a URL, so a row that somehow carries a
 * malformed slug falls back to its id rather than producing a link
 * that won't parse on the way back in.
 */
const SLUG_RE = /^[a-z][a-z0-9-]{2,63}$/

/** Whether `raw` is shaped like a dataset reference we'd look up. */
export function isDatasetRef(raw: string): boolean {
  return REF_PATTERN.test(raw)
}

/**
 * Parse a dataset reference out of a `/dataset/<ref>` pathname. This
 * is the web boot path for the links `shareService` copies and blog
 * posts emit — the SPA is served at that path (Pages SPA fallback)
 * and `main.ts` resolves the dataset from it at startup.
 *
 * Returns the raw reference, which may be a slug, an id, or a legacy
 * id; hand it to {@link resolveDatasetRef} to get a catalog row.
 */
export function parseDatasetPathname(pathname: string): string | null {
  const m = pathname.match(/^\/dataset\/([^/]+)\/?$/)
  if (!m) return null
  const ref = m[1]
  return isDatasetRef(ref) ? ref : null
}

/**
 * Resolve a URL reference to its catalog row. Tries the canonical id
 * first, then `legacyId` (so tour files and long-lived links that
 * hard-code `INTERNAL_SOS_*` keep working), then `slug`.
 *
 * Slug matching is case-insensitive because slugs are lowercase by
 * construction and a URL that picked up a capital in transit — an
 * email client title-casing a link, a hand-typed address — should
 * still land on the dataset rather than a "not found".
 */
export function resolveDatasetRef(
  raw: string | null | undefined,
  catalog: readonly Dataset[],
): Dataset | undefined {
  if (!raw) return undefined
  const direct = catalog.find(d => d.id === raw)
  if (direct) return direct
  const legacy = catalog.find(d => d.legacyId === raw)
  if (legacy) return legacy
  const lowered = raw.toLowerCase()
  return catalog.find(d => d.slug !== undefined && d.slug.toLowerCase() === lowered)
}

/**
 * The reference to put in a URL for `dataset` — its slug when it has
 * a well-formed one, otherwise its id. Rows from the legacy SOS
 * snapshot carry no slug, and the synthesised `SOS_ONLY_*` rows build
 * theirs with underscores, so both fall back to the id form rather
 * than emitting a link that wouldn't round-trip.
 */
export function datasetUrlRef(dataset: DatasetUrlRef): string {
  const slug = dataset.slug
  return slug !== undefined && SLUG_RE.test(slug) ? slug : dataset.id
}

/**
 * Build the canonical in-app path for `dataset`, carrying `search`'s
 * query params across.
 *
 * `dataset` is dropped from the query because the path segment now
 * carries it, and `preview` is dropped because a draft-preview token
 * is scoped to one specific draft — pointing it at a different
 * dataset would be meaningless. Everything else (`catalog`, `embed`,
 * `layout`, …) survives, so switching datasets never silently drops
 * the mode the visitor arrived in.
 */
export function buildDatasetPath(dataset: DatasetUrlRef, search = ''): string {
  const params = new URLSearchParams(search)
  params.delete('dataset')
  params.delete('preview')
  const query = params.toString()
  return `${DATASET_PATH_PREFIX}${encodeURIComponent(datasetUrlRef(dataset))}${query ? `?${query}` : ''}`
}

/**
 * The dataset a token-gated draft preview URL is scoped to, or null
 * when this isn't a preview URL.
 *
 * A `?preview=<token>&dataset=<ref>` URL only resolves with its token
 * attached, so the address bar has to be left alone while that draft
 * is what's on screen. It must *not* be left alone once the visitor
 * navigates to a different dataset — that's a real navigation, and
 * holding the spent token there would leave the URL naming the draft
 * while the globe showed something else.
 *
 * Callers resolve the returned reference through the catalog before
 * comparing, since the URL may name the draft by slug or id.
 */
export function previewDatasetRef(search: string): string | null {
  const params = new URLSearchParams(search)
  if (!params.has('preview')) return null
  return params.get('dataset')
}

/**
 * Build the URL to show once no dataset is loaded — `goHome()`, or a
 * viewport promotion that lands on an empty panel. Strips the
 * `/dataset/<ref>` path segment and the `dataset` / `preview` query
 * params, keeping the rest of the query so unloading doesn't drop the
 * visitor's `?catalog=true` or `?embed=1` mode along with the data.
 */
export function buildNoDatasetPath(pathname: string, search = ''): string {
  const path = parseDatasetPathname(pathname) ? '/' : pathname
  const params = new URLSearchParams(search)
  params.delete('dataset')
  params.delete('preview')
  const query = params.toString()
  return `${path}${query ? `?${query}` : ''}`
}
