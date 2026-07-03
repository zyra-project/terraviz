/**
 * Auto-generated current-events tour (`docs/CURRENT_EVENTS_PLAN.md` §7)
 * — turn an approved event + its vetted dataset pairings into a
 * playable, *editable* tour draft with zero authoring effort.
 *
 * `buildEventTourTasks` is pure and deterministic: the event's geometry
 * becomes the `flyTo`, its occurred time a `setTime` on every seekable
 * stop, each paired dataset a `loadDataset` stop, and the captions —
 * AI-written when Workers AI is bound, template-composed otherwise —
 * ride on `showRect` overlays, exactly the task vocabulary
 * `tourEngine.ts` already plays. Nothing new is invented; the output
 * drops into the existing draft-tour pipeline (`tour-mutations.ts`) as
 * a normal editable draft behind the same human-in-the-loop discipline
 * as everything else in the events feature: the curator polishes and
 * publishes; nothing auto-publishes.
 *
 * Caption trust matches the docent's anti-hallucination rule: the
 * model is given only the approved event's own text and the real
 * dataset titles, and every AI failure degrades to the deterministic
 * templates — a tour is never blocked on the model.
 */

import type { TourTaskDef } from '../../../../src/types'
import type { CurrentEventRow } from './events-store'
import { extractModelText, ENRICH_MODEL_ID, type EnrichEnv } from './events-enrich'

/** Stops beyond this add length, not clarity — the plan pitches a
 *  ~30-second explainer, not a lecture. */
export const MAX_TOUR_STOPS = 4

/** Caption text beyond this overflows the overlay; the model is asked
 *  for one to two sentences and anything longer is truncated. */
export const MAX_CAPTION_CHARS = 280

/** Seconds each caption stays up before the tour advances. */
const INTRO_HOLD_S = 6
const STOP_HOLD_S = 10

/** Don't let one slow model call stall the whole generate request —
 *  past this, the deterministic template captions win (mirrors
 *  `ENRICH_TIMEOUT_MS` in `events-enrich.ts`). */
const CAPTIONS_TIMEOUT_MS = 10_000

/** The per-dataset facts a stop needs. */
export interface EventTourDataset {
  id: string
  title: string
  startTime: string | null
  endTime: string | null
  format: string | null
  /** Resolved public http(s) URL of the dataset's thumbnail, or null.
   *  Callers resolve `thumbnail_ref` via `resolveHttpAssetUrl` so only
   *  fetchable URLs reach the tour JSON. */
  thumbnailUrl: string | null
}

export interface EventTourCaptions {
  intro: string
  /** Keyed by dataset id; missing entries fall back to the template. */
  stops: Record<string, string>
}

/** The event fields the generator reads (a `current_events` row). */
export type EventTourEvent = Pick<
  CurrentEventRow,
  | 'title'
  | 'summary'
  | 'source_name'
  | 'occurred_start'
  | 'bbox_n'
  | 'bbox_s'
  | 'bbox_w'
  | 'bbox_e'
  | 'point_lat'
  | 'point_lon'
  | 'region_name'
>

/** The fly-to target + altitude for the event's geometry: a point gets
 *  a regional close-up; a bbox frames its span; region-only events use
 *  the bbox stored alongside the region name. */
export function eventFlyTarget(
  event: EventTourEvent,
): { lat: number; lon: number; altmi: number } | null {
  if (event.point_lat !== null && event.point_lon !== null) {
    return { lat: event.point_lat, lon: event.point_lon, altmi: 1200 }
  }
  if (event.bbox_n !== null && event.bbox_s !== null && event.bbox_w !== null && event.bbox_e !== null) {
    const lat = (event.bbox_n + event.bbox_s) / 2
    // Antimeridian-safe midpoint: when w > e the box wraps ±180°.
    let lon: number
    let lonSpan: number
    if (event.bbox_w <= event.bbox_e) {
      lon = (event.bbox_w + event.bbox_e) / 2
      lonSpan = event.bbox_e - event.bbox_w
    } else {
      lonSpan = 360 - (event.bbox_w - event.bbox_e)
      lon = event.bbox_w + lonSpan / 2
      if (lon > 180) lon -= 360
    }
    const spanDeg = Math.max(event.bbox_n - event.bbox_s, lonSpan)
    // ~69 miles per degree; frame the box with headroom, clamped to a
    // sensible regional-to-continental band.
    const altmi = Math.min(6000, Math.max(600, Math.round(spanDeg * 69 * 1.4)))
    return { lat, lon, altmi }
  }
  return null
}

/** Occurred day rendered for prose ("2026-06-25" → "2026-06-25"). */
function occurredDay(event: EventTourEvent): string | null {
  return event.occurred_start ? event.occurred_start.slice(0, 10) : null
}

/** Deterministic captions — the AI-free floor, and the per-stop
 *  fallback when the model omits or overruns an entry. */
export function buildTemplateCaptions(
  event: EventTourEvent,
  datasets: readonly EventTourDataset[],
): EventTourCaptions {
  const day = occurredDay(event)
  const where = event.region_name ? ` (${event.region_name})` : ''
  const intro = [
    `${event.title}${where}`,
    day ? `Reported ${day} — source: ${event.source_name}.` : `Source: ${event.source_name}.`,
  ].join(' — ')
  const stops: Record<string, string> = {}
  for (const d of datasets) {
    stops[d.id] = `${d.title} — data related to this event.`
  }
  return { intro: intro.slice(0, MAX_CAPTION_CHARS), stops }
}

/**
 * Assemble the tour: fly to the event, show the intro caption, then
 * one stop per dataset — load, seek to the occurred time (the engine
 * skips it for unseekable data), let it animate under its caption.
 */
export function buildEventTourTasks(
  event: EventTourEvent,
  datasets: readonly EventTourDataset[],
  captions: EventTourCaptions,
): TourTaskDef[] {
  const tasks: TourTaskDef[] = []
  const target = eventFlyTarget(event)
  if (target) {
    tasks.push({ flyTo: { lat: target.lat, lon: target.lon, altmi: target.altmi, animated: true } })
  }
  tasks.push({
    showRect: {
      rectID: 'event-intro',
      caption: captions.intro,
      captionPos: 'bottom',
      xPct: 10,
      yPct: 72,
      widthPct: 80,
      heightPct: 18,
    },
  })
  // Intro media card: while the camera flies and the intro caption
  // holds, the globe still shows plain Earth — a preview of the data
  // about to load fills that gap. Positionless on purpose: the
  // player routes it into the responsive media rail
  // (`tourUI.usesMediaRail`), so no coordinates to get wrong across
  // viewports. Hidden before the first dataset takes the globe.
  const introMedia = datasets.slice(0, MAX_TOUR_STOPS).find(d => d.thumbnailUrl)
  if (introMedia?.thumbnailUrl) {
    tasks.push({
      showImage: {
        imageID: 'event-intro-media',
        filename: introMedia.thumbnailUrl,
        caption: introMedia.title,
      },
    })
  }
  tasks.push({ pauseSeconds: INTRO_HOLD_S }, { hideRect: 'event-intro' })
  if (introMedia?.thumbnailUrl) {
    tasks.push({ hideImage: 'event-intro-media' })
  }
  datasets.slice(0, MAX_TOUR_STOPS).forEach((d, i) => {
    tasks.push({ loadDataset: { id: d.id, worldIndex: 1 } })
    if (event.occurred_start) tasks.push({ setTime: { time: event.occurred_start } })
    tasks.push(
      { datasetAnimation: { animation: 'on' } },
      {
        showRect: {
          rectID: `event-stop-${i + 1}`,
          caption: (captions.stops[d.id] ?? `${d.title}.`).slice(0, MAX_CAPTION_CHARS),
          captionPos: 'bottom',
          xPct: 10,
          yPct: 72,
          widthPct: 80,
          heightPct: 18,
        },
      },
      { pauseSeconds: STOP_HOLD_S },
      { hideRect: `event-stop-${i + 1}` },
    )
  })
  return tasks
}

/**
 * Ask Workers AI to write the intro + per-stop captions, grounded in
 * ONLY the approved event's own text and the real dataset titles. Any
 * failure — no binding, model error, unparseable output — returns the
 * templates instead; per-stop misses fall back individually.
 */
export async function generateTourCaptions(
  env: EnrichEnv,
  event: EventTourEvent,
  datasets: readonly EventTourDataset[],
): Promise<EventTourCaptions> {
  const fallback = buildTemplateCaptions(event, datasets)
  if (!env.AI || datasets.length === 0) return fallback

  const datasetLines = datasets
    .slice(0, MAX_TOUR_STOPS)
    .map((d, i) => `${i + 1}. id=${d.id} title="${d.title}"`)
    .join('\n')
  const system =
    'You write short on-screen captions for a guided globe tour about a current event. ' +
    'Respond with ONLY a JSON object of the shape ' +
    '{"intro": string, "stops": [{"id": string, "caption": string}]}. ' +
    '"intro" introduces the event in one or two sentences and MUST mention the source name. ' +
    'Each stop caption is one or two sentences explaining what the named dataset shows and how it ' +
    'relates to the event. Use ONLY the facts given — never invent numbers, places, dates, or ' +
    'claims that are not in the provided text. Plain text only, no markdown.'
  const day = occurredDay(event)
  const user =
    `Event: ${event.title}\n` +
    (event.summary ? `Summary: ${event.summary}\n` : '') +
    `Source: ${event.source_name}\n` +
    (day ? `Occurred: ${day}\n` : '') +
    (event.region_name ? `Region: ${event.region_name}\n` : '') +
    `Datasets:\n${datasetLines}`

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const modelCall = env.AI.run(env.EVENTS_ENRICH_MODEL || ENRICH_MODEL_ID, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 700,
    })
    // A late rejection from the losing branch must never surface as an
    // unhandled rejection in the Workers runtime.
    void modelCall.catch(() => {})
    const raced = await Promise.race([
      modelCall,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('caption timeout')), CAPTIONS_TIMEOUT_MS)
      }),
    ])
    const text = extractModelText(raced)
    if (!text) return fallback
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end <= start) return fallback
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      intro?: unknown
      stops?: Array<{ id?: unknown; caption?: unknown }>
    }
    const out: EventTourCaptions = { intro: fallback.intro, stops: { ...fallback.stops } }
    if (typeof parsed.intro === 'string' && parsed.intro.trim()) {
      out.intro = parsed.intro.trim().slice(0, MAX_CAPTION_CHARS)
    }
    if (Array.isArray(parsed.stops)) {
      for (const stop of parsed.stops) {
        if (typeof stop?.id === 'string' && typeof stop.caption === 'string' && stop.caption.trim() && stop.id in out.stops) {
          out.stops[stop.id] = stop.caption.trim().slice(0, MAX_CAPTION_CHARS)
        }
      }
    }
    return out
  } catch (e) {
    console.warn('[event-tour] caption generation failed:', e instanceof Error ? e.message : String(e))
    return fallback
  } finally {
    clearTimeout(timer)
  }
}
