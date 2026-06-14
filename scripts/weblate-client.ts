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

/** Walk every page of a paginated Weblate list endpoint. */
export async function fetchAllPages<T>(firstUrl: string): Promise<T[]> {
  let next: string | null = firstUrl
  const all: T[] = []
  while (next) {
    const res = await fetch(next, { headers: authHeaders() })
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
