/**
 * Shared Weblate REST client.
 *
 * Config, auth, pagination, and source-unit resolution used by both
 * Weblate sync jobs:
 *   - `sync-weblate-metadata.ts`    — per-string Explanation field
 *   - `sync-weblate-screenshots.ts` — translator screenshots
 *
 * Both attach metadata to the **source** (`en`) units, keyed by the
 * unit's `context` field (our flat locale key, e.g.
 * `browse.card.load`). This module is the one place that knows how to
 * authenticate, walk the paginated units endpoint, and turn the live
 * unit list into a `key → unit` map.
 *
 * Defaults match the live Weblate component:
 *   - URL:        https://hosted.weblate.org
 *   - Project:    terraviz
 *   - Component:  app-locales
 *
 * Override via environment variables (`WEBLATE_URL`, `WEBLATE_PROJECT`,
 * `WEBLATE_COMPONENT`) when testing against a fork or self-hosted
 * instance. Token via `WEBLATE_TOKEN` — create one at
 * `<URL>/accounts/profile/#api` with at least "Manage component"
 * permission on the project.
 */

export const WEBLATE_URL = process.env.WEBLATE_URL ?? 'https://hosted.weblate.org'
export const WEBLATE_PROJECT = process.env.WEBLATE_PROJECT ?? 'terraviz'
export const WEBLATE_COMPONENT = process.env.WEBLATE_COMPONENT ?? 'app-locales'
const WEBLATE_TOKEN = process.env.WEBLATE_TOKEN

/** Thrown for any auth / HTTP failure surfaced by this client. */
export class WeblateError extends Error {}

export interface WeblateUnit {
  id: number
  context: string
  explanation: string
}

interface WeblatePage<T> {
  count: number
  next: string | null
  results: T[]
}

/** True when a token is configured. Callers print their own guidance. */
export function hasToken(): boolean {
  return Boolean(WEBLATE_TOKEN)
}

export function authHeaders(): Record<string, string> {
  if (!WEBLATE_TOKEN) {
    throw new WeblateError(
      'WEBLATE_TOKEN not set. Create one at ' +
        `${WEBLATE_URL}/accounts/profile/#api and pass via env var.`,
    )
  }
  return { Authorization: `Token ${WEBLATE_TOKEN}` }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))

// Light proactive pacing so a long association run doesn't constantly
// trip Weblate's burst limit (reactive backoff below still covers it).
// ~8 req/s by default; raise WEBLATE_MIN_INTERVAL_MS if hosted.weblate.org
// throttles harder.
const MIN_INTERVAL_DEFAULT = 120
const MIN_INTERVAL_RAW = Number(process.env.WEBLATE_MIN_INTERVAL_MS ?? MIN_INTERVAL_DEFAULT)
// A non-numeric env value would yield NaN, which silently disables
// pacing (every NaN comparison is false) — clamp it back to the default.
const MIN_INTERVAL_MS = Number.isFinite(MIN_INTERVAL_RAW)
  ? MIN_INTERVAL_RAW
  : MIN_INTERVAL_DEFAULT
let lastCallAt = 0
async function pace(): Promise<void> {
  if (MIN_INTERVAL_MS <= 0) return
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now()
  if (wait > 0) await sleep(wait)
  lastCallAt = Date.now()
}

/**
 * Parse a `Retry-After` header (seconds, or an HTTP date) into ms.
 * Returns null when absent/unparseable so the caller can fall back to
 * exponential backoff.
 */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null
  const secs = Number(header)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const date = Date.parse(header)
  return Number.isNaN(date) ? null : Math.max(0, date - now)
}

/**
 * `fetch` wrapper that rides out Weblate's rate limiting. hosted.weblate.org
 * returns 429 (DRF throttle) or 503 (front-proxy "Rate limit" page) when
 * requests come too fast; the screenshot sync makes thousands of
 * one-unit-per-call associations, so this is expected. On a 429/503 we
 * wait for `Retry-After` (or exponential backoff, capped) and retry. Other
 * statuses (including other errors) are returned to the caller as-is.
 *
 * Bodies must be re-readable across retries — use `FormData`,
 * `URLSearchParams`, or string/Buffer bodies, never a one-shot stream.
 *
 * `maxRetries` counts retries *after* the first request, so the worst
 * case is `maxRetries + 1` total requests (1 initial + up to 8 retries).
 */
export async function weblateFetch(
  url: string,
  init?: RequestInit,
  maxRetries = 8,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    await pace()
    const res = await fetch(url, init)
    if ((res.status !== 429 && res.status !== 503) || attempt >= maxRetries) {
      return res
    }
    const waitMs =
      retryAfterMs(res.headers.get('retry-after')) ??
      Math.min(60_000, 1_000 * 2 ** attempt)
    // Drain the body so the connection can be reused.
    await res.text().catch(() => {})
    // eslint-disable-next-line no-console
    console.warn(
      `  rate-limited (${res.status}); waiting ${Math.round(waitMs / 1000)}s ` +
        `then retrying (attempt ${attempt + 1}/${maxRetries})`,
    )
    await sleep(waitMs)
  }
}

/** Walk every page of a paginated Weblate list endpoint. */
export async function fetchAllPages<T>(firstUrl: string): Promise<T[]> {
  let next: string | null = firstUrl
  const all: T[] = []
  while (next) {
    const res = await weblateFetch(next, { headers: authHeaders() })
    if (!res.ok) {
      throw new WeblateError(`GET ${next} → ${res.status} ${res.statusText}`)
    }
    const page = (await res.json()) as WeblatePage<T>
    all.push(...page.results)
    next = page.next
  }
  return all
}

/**
 * Fetch every source (`en`) unit. Explanations and screenshots
 * attach to the source unit, not per-translation, so every locale
 * inherits the visible context.
 */
export async function fetchSourceUnits(): Promise<WeblateUnit[]> {
  return fetchAllPages<WeblateUnit>(
    `${WEBLATE_URL}/api/translations/${WEBLATE_PROJECT}/${WEBLATE_COMPONENT}/en/units/`,
  )
}

/** Index units by their `context` (the locale key). */
export function unitsByContext(units: WeblateUnit[]): Map<string, WeblateUnit> {
  return new Map(units.map((u) => [u.context, u]))
}

/** URL of the source (`en`) translation — needed when creating screenshots. */
export function sourceTranslationUrl(): string {
  return `${WEBLATE_URL}/api/translations/${WEBLATE_PROJECT}/${WEBLATE_COMPONENT}/en/`
}
