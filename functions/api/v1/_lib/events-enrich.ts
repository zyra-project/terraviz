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
import type { EventGeometry, NewCurrentEvent } from './events-store'

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
 *  and not after the publish anchor by more than a day (an event a feed
 *  reports on can't meaningfully post-date its own report by more). */
export function isPlausibleDate(iso: string, publishedAt: string | null | undefined): boolean {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return false
  const year = new Date(ms).getUTCFullYear()
  if (year < 1900) return false
  const anchorMs = publishedAt ? Date.parse(publishedAt) : NaN
  if (Number.isFinite(anchorMs)) {
    if (ms > anchorMs + 24 * 60 * 60 * 1000) return false
  }
  return true
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
    '{"date": "YYYY-MM-DD" | null, "place": string | null, "confidence": number}. ' +
    '"date" is the day the described event occurred (resolve relative phrases ' +
    'like "yesterday" or "on Tuesday" against the publication date given); null if the text does not say. ' +
    `"place" must be EXACTLY one name from this list (or null if none fits): ${regionNames}. ` +
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
    const r = (raced ?? {}) as { response?: unknown }
    if (typeof r.response !== 'string' || r.response.length === 0) {
      // Visible in the deployment's real-time logs — distinguishes "the
      // model answered garbage" from "the binding is missing" (which
      // never reaches this function).
      console.warn('[events-enrich] model returned an empty/non-text response')
      return null
    }
    text = r.response
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
      out.inferred.push('geometry')
    }
  }
  return out.inferred.length > 0 ? out : null
}
