// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * What the exhibit's kiosk screen shows (docs/SECOND_LIFE_COMPAT.md §7
 * item 9): the dataset on the globe, read from the node by the page
 * itself, and the date the globe is showing, on the globe's own clock.
 *
 * Two reads, because each has what the other lacks. The exhibit card
 * (`/api/exhibit/v1/datasets/:id`) has the clip's exact length, which is
 * the period every copy of the globe loops on, whether the globe can show
 * the dataset at all, and the credit and licence as the in-world scripts
 * show them. The record (`/api/v1/datasets/:id`) has the full abstract,
 * the thumbnail, the legend and the colour scale, which a 2 KB card cuts
 * or leaves out, and the full credit and licence where the card cut them.
 *
 * The length is the playlists' total, which is what the globe page loops
 * on wherever it plays a stream through hls.js: every Second Life viewer,
 * whose browser is Chromium. A browser with no Media Source Extensions
 * plays HLS natively and loops on the element's own `duration`, which
 * can differ by a frame; a globe there differs from every other copy of
 * the globe as much as from the screen, so the screen keeps the period
 * the others share.
 *
 * The abstract is made plain text here (`plainParagraphs`): the node's
 * SOS abstracts are HTML and the portal's Markdown, and the screen is
 * read, never clicked, so links and markup have nothing to do on it.
 *
 * The date follows the app's time label: `clockTargetS` places the clip
 * where the globe's address says, as the globe page does, and
 * `videoTimeToDate` and `inferDisplayInterval` turn that into the instant
 * and the cadence the control window's label would show, with its rules
 * for when there is a date at all and when it has a time. Three choices
 * are the kiosk's own. It is written in UTC, unlike the app's label,
 * which uses the viewer's zone: every visitor at the screen runs their own
 * copy, and a presenter pointing at "12:00" needs every copy to say the
 * same thing. A picture with a start and an end shows the span where the
 * app shows the start, since a picture of a decade's average is not a
 * picture of its first day. And while a clip plays too fast for its date
 * to be read, the date is shown coarser (`dateDetail`), down to the month
 * or the year, so it changes at most about once a second rather than
 * flickering several times a second over a frame nobody can read.
 */
import { formatDate, formatDateRange } from '../i18n/format'
import { RENDER_ENCODING_DATA_LUMA, parseColorScale } from '../types/color-scale'
import { toDisplayUnits, type DisplayColorScale } from '../types/unit-scale'
import { inferDisplayInterval, isSubDailyPeriod, videoTimeToDate } from '../utils/time'
import { clockTargetS } from './webClock'
import type { WebClock } from './webMode'

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/** Why a dataset could not be shown: as `webDataset` says it, with
 *  `not_playable` for one the node says the globe can't show. */
export type KioskFailure = 'not_found' | 'not_playable' | 'bad_response' | 'http' | 'network'

export class KioskDataError extends Error {
  constructor(
    readonly failure: KioskFailure,
    message: string,
  ) {
    super(message)
    this.name = 'KioskDataError'
  }
}

/** A dataset's legend: its own image, or a colour bar drawn from its
 *  colour scale (a data-encoded dataset has no image to show). */
export type KioskLegend = { kind: 'image'; url: string } | { kind: 'scale'; scale: DisplayColorScale }

export interface KioskDataset {
  id: string
  title: string
  /** The full abstract, as plain paragraphs. */
  abstract: string[]
  thumbnail: string | null
  legend: KioskLegend | null
  /** Who to credit, as the node composed it for the exhibit, in full. */
  credit: string
  /** An SPDX id, or "". */
  license: string
  /** A licence statement and its address, or "". */
  licenseText: string
  /** `video`, `image`, `tour` or another kind the node names. */
  kind: string
  startTime: Date | null
  endTime: Date | null
  /** ISO 8601 duration between frames, or "". */
  period: string
  /** Source frames, for a dataset that says how many. */
  frameCount: number | null
  /** The clip's exact length in seconds, which every copy of the globe
   *  loops on; 0 while the node can't say. */
  lengthS: number
  /** Seconds after which the node may know the length it couldn't give
   *  yet; 0 when there is nothing to wait for. */
  retryS: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function instant(value: unknown): Date | null {
  if (typeof value !== 'string' || value === '') return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

/** An image address the page may load: http(s), or a path on the node.
 *  Anything else (a `javascript:` or `data:` address in a hand-edited
 *  record) is left out rather than repaired. */
export function imageAddress(value: unknown, base: string): string | null {
  const raw = text(value)
  if (!raw) return null
  try {
    const url = new URL(raw, base)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

/** Elements that end a paragraph of an HTML abstract. */
const BLOCKS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'FOOTER',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL',
])

/** A paragraph break in the text an HTML walk builds. */
const BREAK = '\u0000'

/** The text of an HTML abstract, parsed into a `<template>`'s inert
 *  fragment: nothing in it runs or loads. The idiom `sanitizeHtml.ts`
 *  uses, and for its reason; `DOMParser`'s document was measured fetching
 *  nothing in Chromium too, but this one is the repo's. */
function htmlText(source: string): string {
  const template = document.createElement('template')
  template.innerHTML = source
  const out: string[] = []
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) out.push((child.textContent ?? '').replace(/\s+/g, ' '))
      else if (child.nodeType === 1) {
        const tag = (child as Element).tagName
        // What a document would hold out of its body, or never show.
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE' || tag === 'TITLE' || tag === 'NOSCRIPT') continue
        const block = BLOCKS.has(tag)
        if (block) out.push(BREAK)
        walk(child)
        if (block) out.push(BREAK)
      }
    }
  }
  walk(template.content)
  return out.join('')
}

/** Whether `raw` reads as HTML: a tag or an entity. */
function looksLikeHtml(raw: string): boolean {
  return /<[a-z!/]|&(?:#\d+|#x[\da-f]+|[a-z]+);/i.test(raw) && typeof document !== 'undefined'
}

/** HTML's words, its paragraphs as one line. */
function htmlLine(raw: string): string {
  return htmlText(raw).replace(new RegExp(BREAK, 'g'), ' ').replace(/\s+/g, ' ').trim()
}

/** What Markdown marks up, taken off, keeping the words: a link's text,
 *  emphasis, code, a heading's or a quote's marker. An image goes, since
 *  its text is usually a file name. */
function markdownText(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/(^|[\s(])[*_](\S(?:[^*_]*?\S)?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>)\s+/, '')
}

/**
 * An abstract as plain paragraphs. HTML (the node's SOS abstracts) is
 * read through an inert document, with its block elements as the breaks
 * and its own line breaks as spaces, since SOS wraps its source at about
 * seventy columns. Otherwise it is text or Markdown (the portal's): a
 * blank line ends a paragraph, a list item starts one, and a lone line
 * break is a space.
 */
export function plainParagraphs(source: string): string[] {
  const raw = source.trim()
  if (!raw) return []
  const paragraphs: string[] = []
  if (looksLikeHtml(raw)) {
    for (const part of htmlText(raw).split(BREAK)) {
      const words = part.replace(/\s+/g, ' ').trim()
      if (words) paragraphs.push(words)
    }
    return paragraphs
  }
  let current: string[] = []
  const end = (): void => {
    const words = current.join(' ').replace(/\s+/g, ' ').trim()
    if (words) paragraphs.push(words)
    current = []
  }
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') { end(); continue }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+/.exec(line)
    if (item) {
      end()
      const marker = /\d/.test(item[0]) ? item[0].trim() + ' ' : '• ' // i18n-exempt: a list bullet, not a word
      current.push(marker + markdownText(line.slice(item[0].length)))
      continue
    }
    current.push(markdownText(line))
  }
  end()
  return paragraphs
}

/** A field's words on one line, made plain as the card makes them: HTML
 *  read for its text, anything else as written, its white space one space. */
function plainLine(value: unknown): string {
  const raw = text(value)
  if (!raw) return ''
  return looksLikeHtml(raw) ? htmlLine(raw) : raw.replace(/\s+/g, ' ')
}

/** How the card ends a value it cut (`cutProse` and `exhibitProse` in
 *  functions/api/v1/_lib/exhibit-text.ts). */
const CUT = '...'

/**
 * Who to credit and the licence: the card's, which the node composes for
 * the in-world scripts (`buildCard` in functions/api/v1/_lib/exhibit-reads.ts),
 * so the screen, the floating text and the chat credit the same party in
 * the same words. The card cuts these to 200 and 400 bytes, a budget the
 * screen doesn't share, so a value the card cut, which ends `...`, is read
 * in full from the record instead: the credit by the card's order (the
 * attribution, the rights holder, then the organization, the first with
 * any words), and the licence's statement with the card's own address
 * after it. A value read there is made plain by the browser rather than by
 * the card's parser, which can space a word or decode an entity
 * differently; the licence's id and address are always the card's, since
 * the card checks them and never cuts them.
 */
function attributionFrom(card: Record<string, unknown>, record: Record<string, unknown>): Pick<KioskDataset, 'credit' | 'license' | 'licenseText'> {
  let credit = text(card.credit)
  if (credit.endsWith(CUT)) {
    for (const field of [record.attributionText, record.rightsHolder, record.organization]) {
      const words = plainLine(field)
      if (words) { credit = words; break }
    }
  }
  // The card's licence text is its statement, then its address; a
  // statement the address left no room for is dropped whole.
  const licence = text(card.licenseText)
  const parts = /^(?:(.*) )?(https?:\/\/\S+)$/.exec(licence)
  let statement = parts ? (parts[1] ?? '') : licence
  const address = parts ? parts[2] : ''
  const full = plainLine(record.licenseStatement)
  if (full && (statement.endsWith(CUT) || (!statement && address))) statement = full
  return {
    credit,
    license: text(card.license),
    licenseText: [statement, address].filter(Boolean).join(' '),
  }
}

/**
 * The kiosk's dataset from the node's card and record.
 *
 * The title, abstract and images come from the record, in full, and the
 * times and length from the card, which reads the length from the stream;
 * the credit and licence from the card, unless it cut them
 * (`attributionFrom`). A record without an id is refused, as the globe page
 * refuses one, and so is a dataset the card says the globe can't show (a
 * tour, or a format the globe page doesn't draw), since the globe then
 * shows the live Earth and the screen says what the globe shows.
 *
 * What the screen names is what the globe was asked to show. Whether each
 * visitor's copy of the globe loaded it, nothing in the exhibit can see,
 * the floating text and the chat included: a copy whose media fails shows
 * the live Earth and tries again, so a dataset whose media fails for
 * everyone shows on the globe itself, where its owner sees it.
 */
export function kioskDatasetFrom(card: Record<string, unknown>, record: Record<string, unknown>, base: string): KioskDataset {
  const id = text(record.id)
  if (!id) throw new KioskDataError('bad_response', 'the record came back with no id')
  if (card.showable === false) throw new KioskDataError('not_playable', `the globe can't show ${id}`)
  const scale = record.renderEncoding === RENDER_ENCODING_DATA_LUMA ? parseColorScale(record.colorScale) : null
  const legendImage = imageAddress(record.legendLink, base)
  const legend: KioskLegend | null = scale
    ? { kind: 'scale', scale: toDisplayUnits(scale) }
    : legendImage
      ? { kind: 'image', url: legendImage }
      : null
  const frames = isRecord(record.frames) ? record.frames.count : undefined
  const length = card.exactDuration
  const retry = card.retry
  return {
    id,
    title: text(record.title) || text(card.title) || id,
    abstract: plainParagraphs(typeof record.abstractTxt === 'string' ? record.abstractTxt : ''),
    thumbnail: imageAddress(record.thumbnailLink, base),
    legend,
    ...attributionFrom(card, record),
    kind: text(card.kind),
    startTime: instant(card.startTime),
    endTime: instant(card.endTime),
    period: text(card.period),
    frameCount: typeof frames === 'number' && Number.isInteger(frames) && frames > 1 ? frames : null,
    lengthS: typeof length === 'number' && Number.isFinite(length) && length > 0 ? length : 0,
    retryS: typeof retry === 'number' && Number.isFinite(retry) && retry > 0 ? retry : 0,
  }
}

/** How long a read may take, its body included, before it counts as no
 *  answer and is tried again: a card can wait on the node reading a
 *  stream's playlists, which takes seconds, never this long. */
export const KIOSK_READ_TIMEOUT_MS = 20_000

async function readJson(fetchFn: FetchFn, url: string, what: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetchFn(url, { headers: { Accept: 'application/json' }, signal })
  } catch {
    throw new KioskDataError('network', `${what}: no answer`)
  }
  const json = (): Promise<unknown> => res.json().catch(() => undefined)
  // Only the node's own 404, which says so in its JSON, means there is no
  // such dataset: anything between here and the node can answer 404, as
  // the info script knows too. Any other is tried again, and an error's
  // body is not waited for.
  if (res.status === 404) {
    const body = await json()
    if (isRecord(body) && body.error === 'not_found') throw new KioskDataError('not_found', `${what} not found`)
  }
  if (!res.ok) throw new KioskDataError('http', `${what}: HTTP ${res.status}`)
  const body = await json()
  if (body === undefined) throw new KioskDataError('bad_response', `${what} was not JSON`)
  if (!isRecord(body)) throw new KioskDataError('bad_response', `${what} was not an object`)
  return body
}

/**
 * Read dataset `id`'s card and record from the node, both at once.
 *
 * The two have one deadline, `timeoutMs`, bodies and all: a read not
 * finished by then is no answer, and the page tries again, rather than
 * waiting on a stalled connection for good with "Loading…" on the screen.
 * The deadline is raced as well as passed as the abort signal, so a fetch
 * that ignores the signal can't hold it, and when either read fails the
 * other is aborted, since the dataset is read again whole.
 */
export async function fetchKioskDataset(
  id: string,
  opts: { fetchFn?: FetchFn; apiBase?: string; base: string; timeoutMs?: number },
): Promise<KioskDataset> {
  const fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init))
  const apiBase = opts.apiBase ?? ''
  const timeoutMs = opts.timeoutMs ?? KIOSK_READ_TIMEOUT_MS
  const path = encodeURIComponent(id)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new KioskDataError('network', `dataset ${id}: no answer in ${timeoutMs / 1000} s`)), timeoutMs)
  })
  try {
    const [card, record] = await Promise.race([
      Promise.all([
        readJson(fetchFn, `${apiBase}/api/exhibit/v1/datasets/${path}`, `card for ${id}`, controller.signal),
        readJson(fetchFn, `${apiBase}/api/v1/datasets/${path}`, `dataset ${id}`, controller.signal),
      ]),
      deadline,
    ])
    return kioskDatasetFrom(card, record, opts.base)
  } catch (err) {
    controller.abort()
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * When the globe is, in words.
 *
 * - `playing` / `paused`: a video whose length the node gave, at the
 *   instant the globe's clock puts it, at the cadence its frames step.
 * - `still`: a picture, at its one date (or its span, when it has two).
 * - `span`: a video whose length is not known, at its whole span, since a
 *   date guessed from the wrong length would be wrong.
 * - `none`: a dataset with no dates, or a video with only one end.
 * - `live`: the live Earth, which is now.
 */
export interface KioskWhen {
  state: 'playing' | 'paused' | 'still' | 'span' | 'none' | 'live'
  /** The date, or the span; "" for `none`. */
  text: string
  /** The globe's rate, for `playing`. */
  rate: number
}

/** How much of a date is written: to the minute (with the zone), the
 *  day, the month or the year. */
export type DateDetail = 'time' | 'day' | 'month' | 'year'

const DETAIL_OPTIONS: Record<DateDetail, Intl.DateTimeFormatOptions> = {
  time: { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short', timeZone: 'UTC' },
  day: { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' },
  month: { year: 'numeric', month: 'short', timeZone: 'UTC' },
  year: { year: 'numeric', timeZone: 'UTC' },
}

/** A date as the kiosk writes it: in UTC, to `detail`. */
export function kioskDate(date: Date, detail: DateDetail): string {
  return formatDate(date, DETAIL_OPTIONS[detail])
}

/** A span as the kiosk writes it, the language's own way. */
export function kioskSpan(start: Date, end: Date, detail: DateDetail): string {
  return formatDateRange(start, end, DETAIL_OPTIONS[detail])
}

/** The seconds each detail's last part counts, the month an average one. */
const DETAIL_S: Record<DateDetail, number> = { time: 60, day: 86_400, month: 2_629_746, year: 31_556_952 }

/**
 * The finest detail at which a playing clip's date changes at most once
 * a second: `dataS` seconds of the dataset go by each second, and the
 * date steps once a frame (`stepS`) or once a unit of the detail,
 * whichever is longer. Starts from `finest`, the detail the dataset's own
 * cadence asks for.
 */
export function dateDetail(finest: DateDetail, dataS: number, stepS: number): DateDetail {
  const order: DateDetail[] = ['time', 'day', 'month', 'year']
  for (const detail of order.slice(order.indexOf(finest))) {
    if (dataS / Math.max(stepS, DETAIL_S[detail]) <= 1) return detail
  }
  return 'year'
}

/** The live Earth's date: now, to the minute, as its day and night are. */
export function earthWhen(nowMs: number): KioskWhen {
  return { state: 'live', text: kioskDate(new Date(nowMs), 'time'), rate: 1 }
}

const NONE: KioskWhen = { state: 'none', text: '', rate: 1 }

export function kioskWhen(ds: KioskDataset, clock: WebClock, nowMs: number, readAtMs: number): KioskWhen {
  const start = ds.startTime
  if (!start) return NONE
  if (ds.kind !== 'video') {
    // The app's picture rule: a time only when the stated period is
    // shorter than a day.
    const detail: DateDetail = isSubDailyPeriod(ds.period) ? 'time' : 'day'
    return { state: 'still', text: kioskSpan(start, ds.endTime ?? start, detail), rate: 1 }
  }
  // The app dates a video only between its two ends.
  const end = ds.endTime
  if (!end) return NONE
  const lengthS = ds.lengthS > 0 ? ds.lengthS : 1
  const interval = inferDisplayInterval(start, end, lengthS, {
    period: ds.period || undefined,
    frameCount: ds.frameCount ?? undefined,
  })
  // The app's video rule: a stated period says, else the cadence does.
  const finest: DateDetail = (ds.period ? isSubDailyPeriod(ds.period) : interval.showTime) ? 'time' : 'day'
  if (ds.lengthS <= 0) return { state: 'span', text: kioskSpan(start, end, finest), rate: 1 }
  const at = clockTargetS(clock, nowMs, readAtMs, ds.lengthS)
  const date = videoTimeToDate(at, ds.lengthS, start, end, interval.intervalMs)
  if (clock.paused) return { state: 'paused', text: kioskDate(date, finest), rate: clock.rate }
  const dataS = ((end.getTime() - start.getTime()) / 1000 / ds.lengthS) * Math.abs(clock.rate)
  const detail = dateDetail(finest, dataS, interval.intervalMs / 1000)
  return { state: 'playing', text: kioskDate(date, detail), rate: clock.rate }
}
