// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The exhibit reads: small replies, each inside a byte budget it states,
 * for callers that can afford little, of which the Second Life exhibit
 * globe is the first (`docs/SECOND_LIFE_COMPAT.md` §9 Phase 2, "The
 * exhibit's own reads from the node"). The routes are
 * `functions/api/exhibit/v1/`, beside `functions/api/exhibit/[[path]].ts`
 * for anything else under `/api/exhibit/`; this module holds what they
 * share. The exhibit's version is its own, outside `/api/v1/`, which the
 * federation protocol will one day retire with a 410 that a rezzed
 * script couldn't be updated past.
 *
 * - `GET /api/exhibit/v1/datasets/{id}`, a dataset's card (`buildCard`),
 *   at most `CARD_BUDGET` bytes.
 * - `GET /api/exhibit/v1/datasets`, a page of the menu (`buildPage`), at
 *   most `PAGE_BUDGET` bytes.
 * - `GET /api/exhibit/v1/tags`, the categories (`buildTags`), at most
 *   `TAGS_BUDGET` bytes.
 *
 * **A contract with copies already rezzed.** Scripts in Second Life can't
 * be updated remotely, so every later node serves these shapes to copies
 * running now. Under this path a change is additive only and inside the
 * budget, no field changes meaning, and a breaking change gets a new path
 * while the old one stays. `functions/api/exhibit/v1/exhibit.test.ts` pins
 * the names and types beside the budgets. Convenience reads of nodes
 * running this codebase, as `featured` is: not part of the federation
 * protocol, and not in `public/schema/v1/`. Any failure answers the node's
 * error envelope (`exhibitAnswer`), never the platform's own page.
 *
 * **Budgets are proved by summing caps.** Every field has a cap counted
 * as the body's UTF-8 bytes as sent (`jsonBytes`), and a reply's budget is
 * the envelope plus the caps. Only prose is ever cut, at a word and ending
 * `...`; a machine value (an id, a path, a kind, a date, a period, a
 * licence's address) is sent whole or left out.
 *
 * **One list per isolate** (`exhibitList`) for pages and tags: every
 * public dataset, with its kind, whether the output page can show it, and
 * its tags, read at most once every `LIST_TTL_MS` with the catalog's own
 * `listPublicDatasets`, so "public" means what the catalog means by it.
 * Only a list already read is shared, since a Worker can't hand one
 * request's I/O to another: requests that miss together each read. A
 * failed read keeps the last good list for up to `LIST_STALE_MS`. So two
 * pages from different isolates can come from lists a minute apart, or
 * while reads fail up to `LIST_STALE_MS` apart, and a retracted dataset
 * can stay in pages that long. A card reads its own row (`findPublicRow`),
 * so it is as current as the dataset's record.
 */

import {
  D1_BIND_BATCH,
  getPublicDataset,
  listPublicDatasets,
  type DatasetRow,
} from './catalog-store'
import { parseDataRef } from './data-ref'
import { readHlsDuration, readVimeoDuration, type HlsDurationReading } from './hls-duration'
import { DEFAULT_VIDEO_PROXY_BASE } from './video-proxy'
import { isSafeLicenseUrl } from './metadata-readiness'
import { canonicalTag, cutProse, exhibitPlainText, exhibitProse, jsonBytes, machineValue } from './exhibit-text'
import { SLUG_RE } from './validators'
import type { CatalogEnv } from './env'

export const CARD_BUDGET = 2048
export const PAGE_BUDGET = 1024
export const TAGS_BUDGET = 2048

export const PAGE_DEFAULT_LIMIT = 9
export const PAGE_MAX_LIMIT = 9
export const PAGE_MAX_OFFSET = 100_000
export const TAGS_MAX = 30

/** A card's caps, in bytes as sent. The abstract takes what's left. */
export const CARD_CAPS = {
  id: 64,
  page: 9 + 64, // "/dataset/" and a slug or an id
  kind: 16,
  showable: 5,
  title: 200,
  startTime: 24,
  endTime: 24,
  period: 32,
  exactDuration: 16,
  retry: 2,
  credit: 200,
  license: 64,
  licenseText: 400,
  truncated: 5,
} as const

/** A tag longer than this is left out of `tags` rather than cut, and a
 *  page asked for one is a 400. At 40, thirty tags fit `TAGS_BUDGET` by
 *  their caps alone. */
export const TAG_CAP = 40

/**
 * A page's caps: the id a ULID's 26, a title the 48 a dialog can list nine
 * of, the echoed tag, and `total`, `offset` and `limit`, whole numbers of
 * at most six digits (`PAGE_MAX_OFFSET`, and a catalog under a million).
 */
export const PAGE_CAPS = { id: 26, title: 48, tag: TAG_CAP, number: 6 } as const

/** How long one isolate keeps its list. */
export const LIST_TTL_MS = 60_000
/** How long a list stays in use while reading a new one fails: the five
 *  minutes `/api/v1/catalog` already lets a client serve a stale copy
 *  (`stale-while-revalidate=300`), since a dataset withdrawn meanwhile can
 *  stay in pages that long. */
export const LIST_STALE_MS = 5 * 60_000

/** Bytes of `PAGE_BUDGET` held back for the menu's change signal, a short
 *  hash of the matching list (`,"list":"<8 hex>"`), which is to ship with
 *  the first menu script (`docs/SECOND_LIFE_COMPAT.md`). Nothing else may
 *  spend them. */
export const PAGE_RESERVED = 18

/** Seconds a script waits before asking again for a length that didn't settle. */
export const RETRY_SECONDS = 15

/** A card with nothing in its prose: the fixed part every card spends. */
export const CARD_SKELETON = JSON.stringify({
  id: '', page: '', kind: '', showable: false, title: '', startTime: '', endTime: '', period: '',
  exactDuration: 0, retry: 0, credit: '', license: '', licenseText: '', abstract: '', truncated: false,
})

export interface ExhibitCard {
  id: string
  page: string
  kind: string
  showable: boolean
  title: string
  startTime: string
  endTime: string
  period: string
  exactDuration: number
  retry: number
  credit: string
  license: string
  licenseText: string
  abstract: string
  truncated: boolean
}

export interface ExhibitPage {
  total: number
  offset: number
  limit: number
  tag: string
  datasets: Array<{ id: string; title: string }>
}

export interface ExhibitTags {
  tags: Array<{ tag: string; count: number }>
  more: boolean
}

interface ListEntry {
  row: DatasetRow
  kind: string
  showable: boolean
  tags: string[]
}

/**
 * `video` for a `video/*` format, `image` for `image/*`, and a word of its
 * own for anything else: `tour` for `tour/json`, otherwise the format's
 * first part. The set is open. What a kind says is the media, not whether
 * the output page can show it, which is `canShow`'s: a script shows a
 * card that says `showable`, and only a kind it knows.
 */
export function kindOf(format: string): string {
  const major = (format.split('/')[0] ?? '').toLowerCase()
  if (major === 'video' || major === 'image') return major
  if (format.toLowerCase() === 'tour/json') return 'tour'
  return /^[a-z]{1,16}$/.test(major) ? major : 'other'
}

/**
 * Whether the output page can show a row: an image or a video whose data
 * reference the manifest resolves (`datasets/[id]/manifest.ts`), which
 * needs no network to tell. So no tours, no `peer:` rows, and no row whose
 * reference and format disagree.
 */
export function canShow(row: Pick<DatasetRow, 'format' | 'data_ref'>): boolean {
  // The manifest's own test, case and all.
  const video = row.format.startsWith('video/')
  if (!video && !row.format.startsWith('image/')) return false
  const ref = parseDataRef(row.data_ref)
  if (!ref) return false
  switch (ref.scheme) {
    case 'vimeo':
    case 'stream':
      return video
    case 'url':
    case 'r2':
      return true
    default:
      return false
  }
}

/** The order the app's browse lists the catalog in (`src/ui/browseUI.ts`), then the id. */
function browseOrder(a: ListEntry, b: ListEntry): number {
  return (b.row.weight ?? 0) - (a.row.weight ?? 0)
    || a.row.title.localeCompare(b.row.title)
    || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0)
}

async function tagsFor(db: D1Database, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (let i = 0; i < ids.length; i += D1_BIND_BATCH) {
    const chunk = ids.slice(i, i + D1_BIND_BATCH)
    const res = await db
      .prepare(`SELECT dataset_id, tag FROM dataset_tags WHERE dataset_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<{ dataset_id: string; tag: string }>()
    for (const r of res.results ?? []) {
      const tag = canonicalTag(r.tag)
      if (!listableTag(tag)) continue
      const list = out.get(r.dataset_id) ?? []
      if (!list.includes(tag)) list.push(tag)
      out.set(r.dataset_id, list)
    }
  }
  return out
}

function entryFor(row: DatasetRow, tags: string[]): ListEntry {
  return { row, kind: kindOf(row.format), showable: canShow(row), tags }
}

async function buildList(db: D1Database): Promise<ListEntry[]> {
  const rows = await listPublicDatasets(db)
  const tags = await tagsFor(db, rows.map(r => r.id))
  return rows.map(row => entryFor(row, tags.get(row.id) ?? [])).sort(browseOrder)
}

/**
 * A tag a script can be given and send back: not empty, within `TAG_CAP`,
 * and inside the Basic Multilingual Plane, since whether Second Life
 * carries a character beyond it whole, in a reply and back in an address,
 * hasn't been checked in-world.
 */
function listableTag(tag: string): boolean {
  return tag !== '' && jsonBytes(tag) <= TAG_CAP && !/[\u{10000}-\u{10FFFF}]/u.test(tag)
}

let cached: { atMs: number; list: ListEntry[] } | null = null
let failedAtMs: number | null = null

/** Forget the isolate's list, so one test's can't answer another's. */
export function resetExhibitListForTests(): void {
  cached = null
  failedAtMs = null
}

/**
 * The isolate's list, read again once it is `LIST_TTL_MS` old. Only a list
 * already read is shared. When a read fails, the last good list answers
 * for up to `LIST_STALE_MS`, and while it does no read is tried again for
 * another `LIST_TTL_MS`, so an outage costs an isolate holding a list one
 * read a minute. One holding none reads on every request, and fails each.
 */
export async function exhibitList(db: D1Database, nowMs: number = Date.now()): Promise<ListEntry[]> {
  if (cached && nowMs - cached.atMs < LIST_TTL_MS) return cached.list
  const usable = cached && nowMs - cached.atMs < LIST_STALE_MS ? cached.list : null
  if (usable && failedAtMs !== null && nowMs - failedAtMs < LIST_TTL_MS) return usable
  try {
    const list = await buildList(db)
    cached = { atMs: nowMs, list }
    failedAtMs = null
    return list
  } catch (error) {
    if (!usable) throw error
    failedAtMs = nowMs
    console.warn('[exhibit] list read failed; answering from one read',
      Math.round((nowMs - (cached?.atMs ?? nowMs)) / 1000), 's ago',
      error instanceof Error ? error.message : 'UnknownError')
    return usable
  }
}

/** A public row by id, read on its own, or null. */
export async function findPublicRow(db: D1Database, id: string): Promise<ListEntry | null> {
  const row = await getPublicDataset(db, id)
  return row ? entryFor(row, []) : null
}

/**
 * The clip's exact length, read from its own HLS playlists: an HLS bundle
 * the node holds in R2, or a Vimeo stream, whose API gives only whole
 * seconds (`readVimeoDuration`). 0 for any other video, which has no
 * playlist to read.
 */
export async function exactLength(
  row: Pick<DatasetRow, 'format' | 'data_ref'>,
  env: Pick<CatalogEnv, 'CATALOG_R2' | 'VIDEO_PROXY_BASE'>,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<HlsDurationReading> {
  const ref = parseDataRef(row.data_ref)
  if (kindOf(row.format) !== 'video' || !ref) return { seconds: 0, settled: true }
  if (ref.scheme === 'vimeo') {
    return readVimeoDuration(ref.value, env.VIDEO_PROXY_BASE ?? DEFAULT_VIDEO_PROXY_BASE, { waitUntil })
  }
  if (ref.scheme === 'r2' && ref.value.toLowerCase().endsWith('.m3u8')) {
    return readHlsDuration(env.CATALOG_R2, ref.value, { waitUntil })
  }
  return { seconds: 0, settled: true }
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

/** An instant as `YYYY-MM-DDTHH:MM:SS[.fff]Z`: the validators allow any
 *  number of digits after the second, which is kept to the millisecond. */
function instant(value: string | null): string {
  const m = value?.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?Z$/)
  if (!m) return ''
  return machineValue(`${m[1]}${m[2] ? m[2].slice(0, 4) : ''}Z`, ISO_INSTANT, CARD_CAPS.startTime)
}
/** An ISO 8601 duration, the shape the info script's `period()` reads. */
const ISO_DURATION = /^P(?!$)(\d+(\.\d+)?Y)?(\d+(\.\d+)?M)?(\d+(\.\d+)?W)?(\d+(\.\d+)?D)?(T(?=\d)(\d+(\.\d+)?H)?(\d+(\.\d+)?M)?(\d+(\.\d+)?S)?)?$/
const SPDX = /^[A-Za-z0-9.+\-() ]+$/
/** Printable ASCII only, without the quote, angle brackets or backslash. */
const ADDRESS = /^https?:\/\/[\x21\x23-\x3b\x3d\x3f-\x5b\x5d-\x7e]+$/

/** A safe address (`isSafeLicenseUrl`, the node's own check: no
 *  credentials, white space, controls or backslashes, which `URL` would
 *  otherwise repair into something that reads differently) in the ASCII
 *  form `URL` writes it, a punycode host and a percent-encoded path; else "". */
function asciiAddress(value: string | null | undefined): string {
  const raw = value?.trim()
  if (!raw || !isSafeLicenseUrl(raw)) return ''
  try {
    return new URL(raw).href
  } catch {
    return ''
  }
}
const ID = /^[A-Za-z0-9_-]+$/

/** The dataset's page in the main app, as `src/utils/datasetUrl.ts` builds it. */
export function pagePath(row: Pick<DatasetRow, 'id' | 'slug'>): string {
  const ref = row.slug && SLUG_RE.test(row.slug) ? row.slug : row.id
  return machineValue(`/dataset/${ref}`, /^\/dataset\/[A-Za-z0-9_-]+$/, CARD_CAPS.page)
}

export function buildCard(entry: ListEntry, length: HlsDurationReading): ExhibitCard {
  const { row } = entry
  let truncated = false
  const fit = (prose: { text: string; cut: boolean }, cap: number): string => {
    const cut = cutProse(prose.text, cap)
    if (cut.cut || prose.cut) truncated = true
    return cut.text
  }

  const title = fit(exhibitProse(row.title), CARD_CAPS.title)
  // The first of these with any text once the HTML is out, read in turn.
  let who = { text: '', cut: false }
  for (const field of [row.attribution_text, row.rights_holder, row.organization]) {
    const prose = exhibitProse(field)
    if (prose.text !== '') { who = prose; break }
  }
  const credit = fit(who, CARD_CAPS.credit)
  // The licence's address is whole or left out, and the statement gets the
  // rest: dropped whole when it has none, which counts as a cut.
  const address = machineValue(asciiAddress(row.license_url), ADDRESS, CARD_CAPS.licenseText)
  const statementCap = address ? CARD_CAPS.licenseText - jsonBytes(address) - 1 : CARD_CAPS.licenseText
  const statement = exhibitProse(row.license_statement)
  const statementText = fit(statement, Math.max(statementCap, 0))
  const licenseText = [statementText, address].filter(Boolean).join(' ')
  const seconds = Number.isFinite(length.seconds) && length.seconds > 0 && length.seconds < 1e9
    ? Math.round(length.seconds * 1e6) / 1e6
    : 0

  const card: ExhibitCard = {
    id: machineValue(row.id, ID, CARD_CAPS.id),
    page: pagePath(row),
    kind: entry.kind,
    showable: entry.showable,
    title,
    startTime: instant(row.start_time),
    endTime: instant(row.end_time),
    period: machineValue(row.period, ISO_DURATION, CARD_CAPS.period),
    exactDuration: seconds,
    retry: length.settled ? 0 : RETRY_SECONDS,
    credit,
    license: machineValue(row.license_spdx?.trim(), SPDX, CARD_CAPS.license),
    licenseText,
    abstract: '',
    truncated: false,
  }
  // The abstract takes whatever the rest leaves, counted with `false`,
  // the longer of the two values `truncated` can end as.
  const room = CARD_BUDGET - byteLength({ ...card, truncated: false })
  card.abstract = fit(exhibitProse(row.abstract, { markdown: true }), room)
  card.truncated = truncated
  return card
}

export interface PageQuery {
  tag: string
  offset: number
  limit: number
}

export function buildPage(list: ListEntry[], query: PageQuery): ExhibitPage {
  const { tag } = query
  const matching = list.filter(e => e.showable && ID.test(e.row.id) && e.row.id.length <= PAGE_CAPS.id
    && (tag === '' || e.tags.includes(tag)))
  return {
    total: matching.length,
    offset: query.offset,
    limit: query.limit,
    tag,
    datasets: matching.slice(query.offset, query.offset + query.limit).map(e => ({
      id: e.row.id,
      title: cutProse(exhibitPlainText(e.row.title), PAGE_CAPS.title).text,
    })),
  }
}

export function buildTags(list: ListEntry[]): ExhibitTags {
  const counts = new Map<string, number>()
  for (const e of list) {
    if (!e.showable || !ID.test(e.row.id) || e.row.id.length > PAGE_CAPS.id) continue
    for (const tag of e.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([tag, count]) => ({ tag, count }))
  let tags = ranked.slice(0, TAGS_MAX)
  let more = ranked.length > tags.length
  // Whole tags from the least common end until the reply fits, measured
  // with `false`, the longer of the two values `more` can end as.
  while (tags.length > 0 && byteLength({ tags, more: false }) > TAGS_BUDGET) {
    tags = tags.slice(0, -1)
    more = true
  }
  return { tags, more }
}

/** A reply's bytes as sent. */
export function byteLength(body: unknown): number {
  return new TextEncoder().encode(JSON.stringify(body)).byteLength
}

const CONTENT_TYPE = 'application/json; charset=utf-8'
/** For a reply that can be the same for a minute: pages, tags, and a card
 *  whose length read settled. Cloudflare doesn't keep a Function's reply
 *  at its edge, so this is for browsers; the saving is the list. */
export const EXHIBIT_CACHE_CONTROL = 'public, max-age=60'
/** For a card whose length read didn't settle: never kept, since the
 *  script asks again `retry` seconds later and wants a new reading. */
export const EXHIBIT_TRANSIENT_CACHE_CONTROL = 'no-store'

export function exhibitJson(body: unknown, cacheControl: string = EXHIBIT_CACHE_CONTROL): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': cacheControl },
  })
}

/** The node's error envelope, never cached. A script acts on a 404 only
 *  when its `error` is `not_found`. */
export function exhibitError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'no-store' },
  })
}

/**
 * A route's answer, or the node's 503 envelope if anything in it throws: a
 * failed D1 read, a quota, a parse. The platform's own error page is
 * neither JSON nor within a budget.
 */
export async function exhibitAnswer(read: string, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run()
  } catch (error) {
    console.error(`[exhibit] ${read} failed`, error instanceof Error ? error.message : 'UnknownError')
    return exhibitError(503, 'unavailable', 'The node could not answer just now. Try again shortly.')
  }
}

/** A whole number in [min, max]; `fallback` when absent or empty, since a
 *  script writes every key whether it has a value or not; else null. */
function integerParam(raw: string | null, min: number, max: number, fallback: number): number | null {
  if (raw === null || raw === '') return fallback
  if (!/^[0-9]{1,6}$/.test(raw)) return null
  const n = Number(raw)
  return n >= min && n <= max ? n : null
}

/** A page's query, or what is wrong with it. An empty value is the same
 *  as a missing one, a repeated key's first value counts, and a key it
 *  doesn't know is ignored, so a later script's query reads on this node.
 *  The tag is matched in its canonical form, which the page echoes. */
export function parsePageQuery(params: URLSearchParams): PageQuery | { message: string } {
  const raw = params.get('tag') ?? ''
  if (raw.length > 200) return { message: '`tag` must be at most 200 characters.' }
  const tag = raw === '' ? '' : canonicalTag(raw)
  // Only spaces or control characters: not a tag, and not the whole menu.
  if (raw !== '' && tag === '') return { message: '`tag` must name a tag.' }
  if (jsonBytes(tag) > TAG_CAP) return { message: `\`tag\` must be at most ${TAG_CAP} bytes.` }
  const offset = integerParam(params.get('offset'), 0, PAGE_MAX_OFFSET, 0)
  if (offset === null) return { message: `\`offset\` must be a whole number from 0 to ${PAGE_MAX_OFFSET}.` }
  const limit = integerParam(params.get('limit'), 1, PAGE_MAX_LIMIT, PAGE_DEFAULT_LIMIT)
  if (limit === null) return { message: `\`limit\` must be a whole number from 1 to ${PAGE_MAX_LIMIT}.` }
  return { tag, offset, limit }
}
