/**
 * AI date/location enrichment for ingested current events — feeds
 * slice C (`docs/CURRENT_EVENTS_PLAN.md` §9).
 *
 * Plain news items (the bring-your-own-RSS kind) often arrive without
 * an occurred time or any geometry — exactly the metadata the matcher's
 * temporal/geo signals need. This module fills those gaps at ingest by
 * asking Workers AI to extract them from the headline + summary:
 *
 *   - **Date** — anchored to the item's publish date so relative
 *     phrasing ("overnight", "on Tuesday") resolves to a real day.
 *   - **Place** — constrained to the `src/data/regions.ts` vocabulary
 *     (~120 named regions), so a hallucinated place name simply fails
 *     to resolve and is dropped, and every accepted place carries a
 *     real bounding box the geo signal can score against.
 *
 * Discipline, in order of importance:
 *   1. Only fields the source did NOT provide are ever filled — the
 *      feed's own metadata always wins.
 *   2. Every filled field is recorded in `inferredFields`, which the
 *      curator review queue badges "AI-inferred" — a curator vets it
 *      before anything surfaces publicly (the existing trust gate).
 *   3. Confidence-gated: the model reports per-extraction confidence
 *      and anything below {@link MIN_CONFIDENCE} is discarded.
 *   4. Graceful skip: no AI binding, a model error, or unparseable
 *      output all yield `null` — ingestion proceeds unenriched, never
 *      fails because of enrichment.
 */

import { getRegionNames, resolveRegion } from '../../../../src/data/regions'
import { extractModelText } from '../../_lib/workers-ai-text'
import type { EventGeometry, NewCurrentEvent } from './events-store'

// Re-exported so existing consumers (event-tour.ts, the enrich probe)
// keep their import path; the canonical home is now the shared
// `functions/api/_lib/workers-ai-text.ts`, used by the Orbit chat proxy
// too.
export { extractModelText }

/** Default extraction model — the same id the Orbit chat path defaults
 *  to, so it is known-alive on this account (llama-3.1-8b was
 *  deprecated 2026-05-30 and taught us not to pin a second id here).
 *  Override per-deployment with the EVENTS_ENRICH_MODEL env var when
 *  this one is deprecated in turn. */
export const ENRICH_MODEL_ID = '@cf/meta/llama-4-scout-17b-16e-instruct'

/** Extractions the model itself is less sure of than this are dropped.
 *  Curators still vet everything; the gate just keeps obviously shaky
 *  guesses from cluttering the queue. */
export const MIN_CONFIDENCE = 0.6

/** Don't let one slow model call hold the ingest path hostage. */
const ENRICH_TIMEOUT_MS = 10_000

/** The Workers AI surface enrichment needs. Optional so callers degrade
 *  gracefully and tests can stub the binding shape directly (mirrors
 *  `EmbeddingEnv`). */
export interface EnrichEnv {
  AI?: {
    run(model: string, inputs: Record<string, unknown>): Promise<unknown>
  }
  /** Optional model-id override (deployment env var) — the escape hatch
   *  for the next Workers AI model deprecation. */
  EVENTS_ENRICH_MODEL?: string
}

export type InferredField = 'occurredStart' | 'geometry'

export interface EnrichmentResult {
  occurredStart?: string
  geometry?: EventGeometry
  /** Which of the above were filled — becomes the row's provenance. */
  inferred: InferredField[]
}

/** True when the event already carries any geometry the matcher can
 *  use — enrichment never second-guesses source-provided location. */
function hasGeometry(geometry: EventGeometry | undefined): boolean {
  return Boolean(geometry && (geometry.boundingBox || geometry.point || geometry.regionName))
}

/** Pull the first JSON object out of a model reply that may wrap it in
 *  prose or a code fence. Returns null when nothing parses. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** A plausible extracted date: a real calendar day, not decades off,
 *  and not after the anchor by more than a day (an event a feed reports
 *  on can't meaningfully post-date its own report by more). Items
 *  without a parseable publish date anchor to *now* instead, so a
 *  far-future hallucination can't slip through on anchor-less items. */
export function isPlausibleDate(iso: string, publishedAt: string | null | undefined): boolean {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return false
  const year = new Date(ms).getUTCFullYear()
  if (year < 1900) return false
  const publishedMs = publishedAt ? Date.parse(publishedAt) : NaN
  const anchorMs = Number.isFinite(publishedMs) ? publishedMs : Date.now()
  return ms <= anchorMs + 24 * 60 * 60 * 1000
}

/** True when `(lat, lon)` falls inside `[w, s, e, n]` bounds (plus a
 *  small margin for coastal spots), handling antimeridian-crossing
 *  regions (`w > e`). The containment check is the anti-hallucination
 *  cage for model-supplied coordinates: a point that contradicts the
 *  model's own region choice is dropped. */
export function pointInBounds(
  lat: number,
  lon: number,
  bounds: readonly [number, number, number, number],
  marginDeg = 1,
): boolean {
  const [w, s, e, n] = bounds
  if (lat < s - marginDeg || lat > n + marginDeg) return false
  if (w <= e) return lon >= w - marginDeg && lon <= e + marginDeg
  // Antimeridian crossing: the box wraps around ±180°.
  return lon >= w - marginDeg || lon <= e + marginDeg
}

/** Coerce an untrusted point value to valid coordinates, or null. */
function asPoint(raw: unknown): { lat: number; lon: number } | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const lat = typeof p.lat === 'number' && Number.isFinite(p.lat) ? p.lat : NaN
  const lon = typeof p.lon === 'number' && Number.isFinite(p.lon) ? p.lon : NaN
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  return { lat, lon }
}

/** Build the extraction prompt. Exported for tests. */
export function buildEnrichPrompt(input: {
  title: string
  summary?: string | null
  publishedAt?: string | null
}): { system: string; user: string } {
  const regionNames = getRegionNames().join(', ')
  const system =
    'You extract structured metadata from a news headline and summary. ' +
    'Respond with ONLY a JSON object, no prose, of the shape ' +
    '{"date": "YYYY-MM-DD" | null, "place": string | null, "point": {"lat": number, "lon": number} | null, "confidence": number}. ' +
    '"date" is the day the described event occurred (resolve relative phrases ' +
    'like "yesterday" or "on Tuesday" against the publication date given); null if the text does not say. ' +
    '"place" must be EXACTLY one name from the list below — the SMALLEST listed region that ' +
    'clearly contains the specific location the text names. If no listed region clearly contains ' +
    `it, use null; a wrong region is worse than none. The list: ${regionNames}. ` +
    '"point" is the coordinates of the SPECIFIC location the text names (a town, a volcano, a ' +
    'river) when you are certain of them; it must lie inside the chosen "place" region. ' +
    'Use null when the text names no more specific spot than the region, or you are unsure. ' +
    '"confidence" is 0-1 for how certain you are about the extracted values. ' +
    'Never guess — prefer null over a doubtful value.'
  const publishedLine = input.publishedAt ? `Published: ${input.publishedAt}\n` : ''
  const summaryLine = input.summary ? `Summary: ${input.summary}\n` : ''
  return { system, user: `${publishedLine}Headline: ${input.title}\n${summaryLine}` }
}

/**
 * Extract the missing occurred-date / location for an event, or `null`
 * when there is nothing to fill, no AI binding, or the model's answer
 * doesn't survive validation. Never throws.
 */
export async function enrichEventFields(
  env: EnrichEnv,
  input: Pick<NewCurrentEvent, 'title' | 'summary' | 'publishedAt' | 'occurredStart' | 'geometry'>,
): Promise<EnrichmentResult | null> {
  const needDate = !input.occurredStart
  const needPlace = !hasGeometry(input.geometry)
  if ((!needDate && !needPlace) || !env.AI) return null

  const { system, user } = buildEnrichPrompt(input)
  let text: string
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const modelCall = env.AI.run(env.EVENTS_ENRICH_MODEL || ENRICH_MODEL_ID, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 128,
    })
    // A late rejection from the losing branch must never surface as an
    // unhandled rejection in the Workers runtime.
    void modelCall.catch(() => {})
    const raced = await Promise.race([
      modelCall,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('enrich timeout')), ENRICH_TIMEOUT_MS)
      }),
    ])
    const extracted = extractModelText(raced)
    if (!extracted) {
      // Visible in the deployment's real-time logs — the raw payload
      // (truncated) names the envelope shape we failed to recognise.
      let shape = ''
      try {
        shape = JSON.stringify(raced).slice(0, 300)
      } catch {
        shape = String(raced)
      }
      console.warn('[events-enrich] unrecognised model response shape:', shape)
      return null
    }
    text = extracted
  } catch (e) {
    console.warn('[events-enrich] model call failed:', e instanceof Error ? e.message : String(e))
    return null
  } finally {
    clearTimeout(timer)
  }

  const parsed = extractJsonObject(text)
  if (!parsed) return null
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0
  if (confidence < MIN_CONFIDENCE) return null

  const out: EnrichmentResult = { inferred: [] }
  if (needDate && typeof parsed.date === 'string' && isPlausibleDate(parsed.date, input.publishedAt)) {
    // Store the calendar day as a midnight-UTC instant, matching the
    // ISO-8601 convention of source-provided occurred times.
    out.occurredStart = `${parsed.date.slice(0, 10)}T00:00:00.000Z`
    out.inferred.push('occurredStart')
  }
  if (needPlace && typeof parsed.place === 'string') {
    const region = resolveRegion(parsed.place)
    if (region) {
      const [w, s, e, n] = region.bounds
      out.geometry = { boundingBox: { n, s, w, e }, regionName: region.name }
      // A model-supplied point is accepted only when it agrees with the
      // model's own region choice — the region is the sanity cage. A
      // point without a resolvable region is always dropped.
      const point = asPoint(parsed.point)
      if (point && pointInBounds(point.lat, point.lon, region.bounds)) {
        out.geometry.point = point
      }
      out.inferred.push('geometry')
    }
  }
  return out.inferred.length > 0 ? out : null
}
