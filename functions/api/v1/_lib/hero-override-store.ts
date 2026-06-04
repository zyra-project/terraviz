/**
 * `hero_override` singleton row helpers.
 *
 * Backs the §9.1 "Right now" hero override (see
 * `docs/HERO_ADMIN_SCOPING.md` and `migrations/catalog/0017_hero_override.sql`).
 * Sits between the publisher route (`PUT`/`DELETE
 * /api/v1/publish/featured-hero`, Phase B) + the public read
 * (`GET /api/v1/featured-hero`, Phase A) and the single-row table.
 *
 * Pure data access + body validation; authorisation lives in the
 * route handlers (privileged-only writes via `isPrivileged`). The
 * store persists the raw activation window — it does NOT decide
 * whether the override is currently active. That window evaluation
 * lives in the client (`heroService`), the single source of truth
 * for "is the hero live right now", shared by the static-file and
 * backend paths.
 */

import type { PublisherRow } from './publisher-store'

/** Max characters in a curator headline. Keeps the hero card and the
 *  stored payload bounded; the UI truncates visually anyway. */
export const HERO_HEADLINE_MAX_LEN = 120

/** KV key the public `GET /api/v1/featured-hero` caches under. Shared
 *  with the write routes so a set/clear can bust it for immediate
 *  effect (the 60 s TTL is the backstop). */
export const HERO_CACHE_KEY = 'hero:v1'

/** Best-effort bust of the public hero cache after a write. Swallows
 *  errors — a missed bust just means the change waits out the TTL. */
export async function bustHeroCache(kv: KVNamespace | undefined): Promise<void> {
  if (!kv) return
  try {
    await kv.delete(HERO_CACHE_KEY)
  } catch {
    // TTL is the backstop.
  }
}

/** The `hero_override` row as stored. */
export interface HeroOverrideRow {
  dataset_id: string
  window_start: string
  window_end: string
  headline: string | null
  set_by: string
  set_at: string
}

/** The public read shape (what `GET /api/v1/featured-hero` returns
 *  and what `heroService` consumes). Mirrors the static
 *  `featured-now.json` schema so the client treats both sources
 *  identically. */
export interface HeroOverridePublic {
  datasetId: string
  window: { start: string; end: string }
  headline?: string
}

/** A validated `PUT` body, ready for {@link setHeroOverride}. */
export interface ValidatedHeroInput {
  dataset_id: string
  window_start: string
  window_end: string
  headline: string | null
}

/** Fetch the singleton override row, or null when no hero is set. */
export async function getHeroOverride(db: D1Database): Promise<HeroOverrideRow | null> {
  const row = await db
    .prepare(
      `SELECT dataset_id, window_start, window_end, headline, set_by, set_at
         FROM hero_override
        WHERE id = 1
        LIMIT 1`,
    )
    .first<HeroOverrideRow>()
  return row ?? null
}

/** Shape a stored row into the public override payload. */
export function toPublicHero(row: HeroOverrideRow): HeroOverridePublic {
  const out: HeroOverridePublic = {
    datasetId: row.dataset_id,
    window: { start: row.window_start, end: row.window_end },
  }
  if (row.headline) out.headline = row.headline
  return out
}

export type SetOutcome =
  | { ok: true; row: HeroOverrideRow }
  | { ok: false; status: number; error: string; message: string }

/**
 * Upsert the singleton hero override. Refuses a non-existent
 * `dataset_id` (404) — the FK would reject it anyway, but a typed
 * 404 is a better contract than letting the constraint surface as a
 * 500. The input is assumed already validated by
 * {@link validateHeroInput}; this only adds the existence check that
 * needs the DB.
 */
export async function setHeroOverride(
  db: D1Database,
  publisher: PublisherRow,
  input: ValidatedHeroInput,
  now: string = new Date().toISOString(),
): Promise<SetOutcome> {
  const dataset = await db
    .prepare(`SELECT id FROM datasets WHERE id = ? LIMIT 1`)
    .bind(input.dataset_id)
    .first<{ id: string }>()
  if (!dataset) {
    return {
      ok: false,
      status: 404,
      error: 'not_found',
      message: `Dataset ${input.dataset_id} not found.`,
    }
  }

  await db
    .prepare(
      `INSERT INTO hero_override (id, dataset_id, window_start, window_end, headline, set_by, set_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         dataset_id   = excluded.dataset_id,
         window_start = excluded.window_start,
         window_end   = excluded.window_end,
         headline     = excluded.headline,
         set_by       = excluded.set_by,
         set_at       = excluded.set_at`,
    )
    .bind(input.dataset_id, input.window_start, input.window_end, input.headline, publisher.id, now)
    .run()

  return {
    ok: true,
    row: {
      dataset_id: input.dataset_id,
      window_start: input.window_start,
      window_end: input.window_end,
      headline: input.headline,
      set_by: publisher.id,
      set_at: now,
    },
  }
}

/** Clear the hero override. Idempotent — a no-op when none is set. */
export async function clearHeroOverride(db: D1Database): Promise<void> {
  await db.prepare(`DELETE FROM hero_override WHERE id = 1`).run()
}

/** A single body-validation error in the publisher-API array shape. */
export interface FieldError {
  field: string
  code: string
  message: string
}

/**
 * Validate a `PUT /api/v1/publish/featured-hero` body. Mirrors §9.1's
 * mandatory-window contract: both `window.start` and `window.end` are
 * required, must be parseable ISO-8601, and `start` must be strictly
 * before `end`. Returns the publisher-API `{ errors: [...] }` array
 * shape on failure so the route can return it directly.
 */
export function validateHeroInput(
  raw: unknown,
): { ok: true; value: ValidatedHeroInput } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = []
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  const datasetId = body.dataset_id
  if (typeof datasetId !== 'string' || datasetId.length === 0) {
    errors.push({ field: 'dataset_id', code: 'required', message: '`dataset_id` is required.' })
  }

  const win = (body.window && typeof body.window === 'object' ? body.window : {}) as Record<string, unknown>
  const start = win.start
  const end = win.end
  let startMs = NaN
  let endMs = NaN
  if (typeof start !== 'string' || start.length === 0) {
    errors.push({ field: 'window.start', code: 'required', message: '`window.start` is required (ISO-8601).' })
  } else {
    startMs = Date.parse(start)
    if (!Number.isFinite(startMs)) {
      errors.push({ field: 'window.start', code: 'invalid', message: '`window.start` must be a valid ISO-8601 timestamp.' })
    }
  }
  if (typeof end !== 'string' || end.length === 0) {
    errors.push({ field: 'window.end', code: 'required', message: '`window.end` is required (ISO-8601).' })
  } else {
    endMs = Date.parse(end)
    if (!Number.isFinite(endMs)) {
      errors.push({ field: 'window.end', code: 'invalid', message: '`window.end` must be a valid ISO-8601 timestamp.' })
    }
  }
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs >= endMs) {
    errors.push({ field: 'window', code: 'invalid_range', message: '`window.start` must be before `window.end`.' })
  }

  let headline: string | null = null
  if (body.headline != null) {
    if (typeof body.headline !== 'string') {
      errors.push({ field: 'headline', code: 'invalid', message: '`headline` must be a string.' })
    } else if (body.headline.length > HERO_HEADLINE_MAX_LEN) {
      errors.push({ field: 'headline', code: 'too_long', message: `\`headline\` must be at most ${HERO_HEADLINE_MAX_LEN} characters.` })
    } else {
      const trimmed = body.headline.trim()
      headline = trimmed.length > 0 ? trimmed : null
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      dataset_id: datasetId as string,
      window_start: start as string,
      window_end: end as string,
      headline,
    },
  }
}
