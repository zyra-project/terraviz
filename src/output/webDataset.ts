// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The dataset a web output shows, fetched from the node it is served
 * by (`docs/SECOND_LIFE_COMPAT.md` §7 item 1).
 *
 * On desktop the control window resolves the dataset and hands the
 * output a `MirroredDataset`. On the web nobody does, so the page asks
 * the node itself — the dataset record, then its manifest — and builds
 * the same `MirroredDataset`, which `datasetMirror` then plays exactly
 * as it plays a mirrored one. The compositing (bounding box, longitude
 * origin, flip, palette) is `layerStack`'s, unchanged.
 *
 * **Its own module rather than `dataService`**, because the output
 * bundle is kept clear of the main app's loader graph. It reads only the
 * record's fields the overlay needs, and builds the overlay the way
 * `overlayForMirror(wireToDataset(record))` does on the control side —
 * a worldwide box when the record has none, and the palette only for a
 * record that declares itself data-encoded — so a dataset composites the
 * same on a web output as on a desktop one.
 *
 * **The size is chosen by the framebuffer**: the smallest image variant
 * at least as wide as the frame, or the largest there is. A 2048-wide
 * frame gains nothing from a 4096-wide image, and every visitor
 * downloads their own copy. Video renditions are capped the same way,
 * by the HLS layer (`hlsService`'s `maxWidth`).
 *
 * **An image comes with the rest of its candidates.** For a `url:` row
 * the node does not know which sizes exist: it lists the usual
 * `_4096` / `_2048` / `_1024` names whether or not they are there. The
 * main app tries every one and then the original (`datasetLoader`), and
 * this page took only the one it picked, so a dataset the app showed
 * could leave the page on the live Earth (found in review).
 * `imageCandidates` gives the rest in the order to try them.
 */

import type { MirroredDataset } from '../services/multiOutput/protocol'
import type { DatasetOverlayOptions } from '../types'
import { RENDER_ENCODING_DATA_LUMA, parseColorScale } from '../types/color-scale'
import { toDisplayUnits } from '../types/unit-scale'

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/** Why a dataset could not be shown. The page logs it and shows the
 *  live Earth; there is nobody on a sphere to show a message to. */
export type WebDatasetFailure =
  /** The node has no public dataset with that id. */
  | 'not_found'
  /** It exists, but is not an image or a video (a tour, say). */
  | 'not_playable'
  /** The node answered with something this page cannot read. */
  | 'bad_response'
  /** Any other HTTP failure. */
  | 'http'
  /** The request got no answer at all: offline, DNS, a dropped
   *  connection, or CORS. */
  | 'network'

export class WebDatasetError extends Error {
  constructor(
    readonly failure: WebDatasetFailure,
    message: string,
  ) {
    super(message)
    this.name = 'WebDatasetError'
  }
}

/** Where `wireToDataset` puts a dataset whose record carries no box. */
const WORLDWIDE = { n: 90, s: -90, w: -180, e: 180 }

interface Variant {
  width: number
  url: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function bbox(value: unknown): DatasetOverlayOptions['boundingBox'] | undefined {
  if (!isRecord(value)) return undefined
  const { n, s, w, e } = value
  return [n, s, w, e].every(v => typeof v === 'number' && Number.isFinite(v))
    ? { n: n as number, s: s as number, w: w as number, e: e as number }
    : undefined
}

/** The overlay the control window would build for this record. */
export function overlayFromRecord(record: Record<string, unknown>): DatasetOverlayOptions {
  const lonOrigin = record.lonOrigin
  const scale = record.renderEncoding === RENDER_ENCODING_DATA_LUMA ? parseColorScale(record.colorScale) : null
  return {
    boundingBox: bbox(record.boundingBox) ?? { ...WORLDWIDE },
    lonOrigin: typeof lonOrigin === 'number' && Number.isFinite(lonOrigin) ? lonOrigin : undefined,
    isFlippedInY: typeof record.isFlippedInY === 'boolean' ? record.isFlippedInY : undefined,
    celestialBody: typeof record.celestialBody === 'string' ? record.celestialBody : undefined,
    colorScale: scale ? toDisplayUnits(scale) : undefined,
    datasetId: str(record.id),
    datasetTitle: str(record.title),
  }
}

/** The smallest variant at least `frameWidth` wide, else the widest. */
export function pickVariant(variants: readonly Variant[], frameWidth: number): Variant | undefined {
  const sorted = [...variants].sort((a, b) => a.width - b.width)
  return sorted.find(v => v.width >= frameWidth) ?? sorted[sorted.length - 1]
}

/**
 * Every address for an image, in the order to try them: the variant
 * `pickVariant` chooses, then the wider ones narrowest first (they
 * still fill the frame), then the narrower ones widest first (they do
 * not, but beat nothing), then the original. Duplicates dropped.
 */
export function imageCandidates(variants: readonly Variant[], fallback: string | undefined, frameWidth: number): string[] {
  const pick = pickVariant(variants, frameWidth)
  const ascending = [...variants].sort((a, b) => a.width - b.width)
  const wider = ascending.filter(v => v !== pick && pick !== undefined && v.width >= pick.width)
  const narrower = ascending.filter(v => v !== pick && (pick === undefined || v.width < pick.width)).reverse()
  const urls = [pick, ...wider, ...narrower].flatMap(v => (v ? [v.url] : []))
  if (fallback) urls.push(fallback)
  return [...new Set(urls)]
}

/** A dataset to show, and other addresses for the same picture. */
export interface WebDataset {
  dataset: MirroredDataset
  /** Addresses to try in order if `dataset.url` will not load: the rest
   *  of an image's candidates, or a video's single file after its stream. */
  alternateUrls: string[]
}

function variantsOf(value: unknown): Variant[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (v): v is Variant =>
      isRecord(v) && typeof v.width === 'number' && Number.isFinite(v.width) && typeof v.url === 'string' && v.url !== '',
  )
}

/** A manifest with no HLS stream names files instead; the same order
 *  of preference the main app's `pickDirectFile` uses. */
function directFile(files: unknown): string | undefined {
  if (!Array.isArray(files)) return undefined
  const usable = files.filter(isRecord).filter(f => str(f.link))
  const pick =
    usable.find(f => f.quality === '1080p') ??
    usable.find(f => f.quality === '720p') ??
    usable.find(f => typeof f.width === 'number') ??
    usable[0]
  return pick ? (pick.link as string) : undefined
}

async function getJson(fetchFn: FetchFn, url: string, what: string): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetchFn(url, { headers: { Accept: 'application/json' } })
  } catch {
    // Said here, where it is known, rather than guessed later from the
    // error's type: a `TypeError` is also what a bug throws.
    throw new WebDatasetError('network', `${what}: no answer`)
  }
  if (res.status === 404) throw new WebDatasetError('not_found', `${what} not found`)
  if (!res.ok) throw new WebDatasetError('http', `${what}: HTTP ${res.status}`)
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new WebDatasetError('bad_response', `${what} was not JSON`)
  }
  if (!isRecord(body)) throw new WebDatasetError('bad_response', `${what} was not an object`)
  return body
}

/**
 * Fetch dataset `id` from the node and build what `datasetMirror` plays.
 *
 * Rejects with a `WebDatasetError` saying why, rather than resolving to
 * `null`, so the caller's log names the cause.
 */
export async function fetchWebDataset(
  id: string,
  opts: { frameWidth: number; fetchFn?: FetchFn; apiBase?: string },
): Promise<WebDataset> {
  const fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init))
  const base = `${opts.apiBase ?? ''}/api/v1/datasets/${encodeURIComponent(id)}`

  const record = await getJson(fetchFn, base, `dataset ${id}`)
  // The id is the node's, never the address's: what this page reports
  // as shown (`webTelemetry`) must be a dataset the node said exists.
  // The serializer always writes one, so a record without it is broken.
  const recordId = str(record.id)
  if (!recordId) throw new WebDatasetError('bad_response', `dataset ${id} came back with no id`)
  const format = typeof record.format === 'string' ? record.format : ''
  const kind = format.startsWith('video/') ? 'video' : format.startsWith('image/') ? 'image' : null
  if (!kind) throw new WebDatasetError('not_playable', `dataset ${id} is ${format || 'of no format'}, not an image or a video`)

  const manifest = await getJson(fetchFn, `${base}/manifest`, `manifest for ${id}`)
  if (manifest.kind !== kind) {
    throw new WebDatasetError('bad_response', `manifest for ${id} says ${String(manifest.kind)}, the record says ${kind}`)
  }

  // A video tries its stream, then its single file, as the main app
  // falls back (`datasetLoader`); an image tries its sizes.
  const urls =
    kind === 'video'
      ? [...new Set([str(manifest.hls), directFile(manifest.files)].filter((u): u is string => u !== undefined))]
      : imageCandidates(variantsOf(manifest.variants), str(manifest.fallback), opts.frameWidth)
  const [url, ...alternateUrls] = urls
  if (!url) throw new WebDatasetError('not_playable', `manifest for ${id} names nothing to play`)

  return {
    dataset: {
      id: recordId,
      url,
      kind,
      overlay: overlayFromRecord(record),
      startTime: str(record.startTime) ?? null,
      endTime: str(record.endTime) ?? null,
    },
    alternateUrls,
  }
}
