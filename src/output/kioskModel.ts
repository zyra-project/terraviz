// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * What the exhibit's kiosk screen shows (docs/SECOND_LIFE_COMPAT.md §7
 * item 9): the dataset on the globe, read from the node by the page
 * itself, and the date the globe is showing, on the globe's own clock.
 *
 * Two reads, because each has what the other lacks. The exhibit card
 * (`/api/exhibit/v1/datasets/:id`) has the clip's exact length, which is
 * the period every copy of the globe loops on, and the credit and licence
 * the node composes for the in-world scripts. The record
 * (`/api/v1/datasets/:id`) has the full abstract, the thumbnail, the
 * legend and the colour scale, which a 2 KB card cuts or leaves out.
 *
 * The date is the app's own: `clockTargetS` places the clip where the
 * globe's address says, as the globe page does, and `videoTimeToDate`
 * and `inferDisplayInterval` turn that into the instant and the cadence
 * the control window's time label would show. It is written in UTC,
 * unlike the app's label, which uses the viewer's zone: every visitor at
 * the screen runs their own copy, and a presenter pointing at "12:00"
 * needs every copy to say the same thing.
 */
import { t } from '../i18n'
import { formatDate } from '../i18n/format'
import { RENDER_ENCODING_DATA_LUMA, parseColorScale } from '../types/color-scale'
import { toDisplayUnits, type DisplayColorScale } from '../types/unit-scale'
import { inferDisplayInterval, isSubDailyPeriod, videoTimeToDate } from '../utils/time'
import { clockTargetS } from './webClock'
import type { WebClock } from './webMode'

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/** Why a dataset could not be read: as `webDataset` says it. */
export type KioskFailure = 'not_found' | 'bad_response' | 'http' | 'network'

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
  /** The full abstract, as plain text: the app's info panel shows it the
   *  same way. */
  abstract: string
  thumbnail: string | null
  legend: KioskLegend | null
  /** Who to credit, as the node composed it for the exhibit. */
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

/**
 * The kiosk's dataset from the node's card and record.
 *
 * The title, abstract and images come from the record, the credit,
 * licence, times and length from the card, so each field has one source.
 * A record without an id is refused, as the globe page refuses one.
 */
export function kioskDatasetFrom(card: Record<string, unknown>, record: Record<string, unknown>, base: string): KioskDataset {
  const id = text(record.id)
  if (!id) throw new KioskDataError('bad_response', 'the record came back with no id')
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
    abstract: text(record.abstractTxt),
    thumbnail: imageAddress(record.thumbnailLink, base),
    legend,
    credit: text(card.credit),
    license: text(card.license),
    licenseText: text(card.licenseText),
    kind: text(card.kind),
    startTime: instant(card.startTime),
    endTime: instant(card.endTime),
    period: text(card.period),
    frameCount: typeof frames === 'number' && Number.isInteger(frames) && frames > 1 ? frames : null,
    lengthS: typeof length === 'number' && Number.isFinite(length) && length > 0 ? length : 0,
    retryS: typeof retry === 'number' && Number.isFinite(retry) && retry > 0 ? retry : 0,
  }
}

async function getJson(fetchFn: FetchFn, url: string, what: string): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetchFn(url, { headers: { Accept: 'application/json' } })
  } catch {
    throw new KioskDataError('network', `${what}: no answer`)
  }
  if (res.status === 404) throw new KioskDataError('not_found', `${what} not found`)
  if (!res.ok) throw new KioskDataError('http', `${what}: HTTP ${res.status}`)
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new KioskDataError('bad_response', `${what} was not JSON`)
  }
  if (!isRecord(body)) throw new KioskDataError('bad_response', `${what} was not an object`)
  return body
}

/** Read dataset `id`'s card and record from the node, both at once. */
export async function fetchKioskDataset(
  id: string,
  opts: { fetchFn?: FetchFn; apiBase?: string; base: string },
): Promise<KioskDataset> {
  const fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init))
  const apiBase = opts.apiBase ?? ''
  const path = encodeURIComponent(id)
  const [card, record] = await Promise.all([
    getJson(fetchFn, `${apiBase}/api/exhibit/v1/datasets/${path}`, `card for ${id}`),
    getJson(fetchFn, `${apiBase}/api/v1/datasets/${path}`, `dataset ${id}`),
  ])
  return kioskDatasetFrom(card, record, opts.base)
}

/**
 * When the globe is, in words.
 *
 * - `playing` / `paused`: a video whose length the node gave, at the
 *   instant the globe's clock puts it, at the cadence its frames step.
 * - `still`: a picture, at its one date (or its span, when it has two).
 * - `span`: a video whose length is not known yet, at its whole span,
 *   since a date guessed from the wrong length would be wrong.
 * - `none`: a dataset with no dates.
 * - `live`: the live Earth, which is now.
 */
export interface KioskWhen {
  state: 'playing' | 'paused' | 'still' | 'span' | 'none' | 'live'
  /** The date, or the span's two ends joined; "" for `none`. */
  text: string
  /** The globe's rate, for `playing`. */
  rate: number
}

/** A date as the kiosk writes it: in UTC, with the time only when the
 *  dataset steps faster than a day. */
export function kioskDate(date: Date, withTime: boolean): string {
  return formatDate(date, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' } : {}),
  })
}

/** The live Earth's date: now, to the minute, as its day and night are. */
export function earthWhen(nowMs: number): KioskWhen {
  return { state: 'live', text: kioskDate(new Date(nowMs), true), rate: 1 }
}

export function kioskWhen(ds: KioskDataset, clock: WebClock, nowMs: number, readAtMs: number): KioskWhen {
  const start = ds.startTime
  const end = ds.endTime ?? ds.startTime
  if (!start || !end) return { state: 'none', text: '', rate: 1 }
  const lengthS = ds.lengthS > 0 ? ds.lengthS : 1
  const interval = inferDisplayInterval(start, end, lengthS, {
    period: ds.period || undefined,
    frameCount: ds.frameCount ?? undefined,
  })
  // The app's rule: a stated period says, else the cadence does.
  const withTime = ds.period ? isSubDailyPeriod(ds.period) : interval.showTime
  const span = (): string => {
    const a = kioskDate(start, withTime)
    const b = kioskDate(end, withTime)
    return a === b ? a : t('kiosk.when.span', { start: a, end: b })
  }
  if (ds.kind !== 'video') return { state: 'still', text: span(), rate: 1 }
  if (ds.lengthS <= 0) return { state: 'span', text: span(), rate: 1 }
  const at = clockTargetS(clock, nowMs, readAtMs, ds.lengthS)
  const date = videoTimeToDate(at, ds.lengthS, start, end, interval.intervalMs)
  return { state: clock.paused ? 'paused' : 'playing', text: kioskDate(date, withTime), rate: clock.rate }
}
