// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `node_profile` singleton row helpers (`migrations/catalog/0028_node_profile.sql`).
 *
 * The operator-authored "about the host organization" context — the
 * Phase 3d blog generator grounds AI drafts in it so they speak in
 * the node's own voice, and it is generic enough to back other
 * identity surfaces (the public app's loading-screen tagline today; an about
 * page or footer attribution later).
 *
 * Mirrors `hero-override-store.ts`: pure data access + body
 * validation; authorisation lives in the route handler
 * (privileged-only writes via `isPrivileged`). Absence of a row means
 * "profile not filled in yet" — every consumer degrades gracefully.
 */

import type { PublisherRow } from './publisher-store'
import { TAGLINE_MAX_LEN, hasOnlyTaglineChars } from '../../../../src/types/node-tagline'

/** Bounds keep the stored payload (and any prompt it is interpolated
 *  into) small. Generous for prose, hostile to paste-bombs. */
export const PROFILE_ORG_NAME_MAX_LEN = 200
export const PROFILE_MISSION_MAX_LEN = 1_000
export const PROFILE_ABOUT_MAX_LEN = 10_000
export const PROFILE_REGION_MAX_LEN = 200
export const PROFILE_TONE_MAX_LEN = 200
export const PROFILE_MAX_LINKS = 10
export const PROFILE_LINK_LABEL_MAX_LEN = 100
/** The loading-screen tagline's bound, and its character rules, live
 *  in `src/types/node-tagline.ts`, shared with the portal form. */
export const PROFILE_TAGLINE_MAX_LEN = TAGLINE_MAX_LEN

/** Logo upload bounds (`POST /api/v1/publish/node-profile/logo`).
 *  Raster only — SVG is deliberately excluded (scriptable content on
 *  a public surface). The cap keeps the base64 JSON body and the
 *  in-Worker digest buffer small. The allowlist itself lives in the
 *  shared `image-upload.ts` helpers (also used by tour media). */
export const LOGO_MAX_BYTES = 512 * 1024
export { IMAGE_CONTENT_TYPES as LOGO_CONTENT_TYPES } from './image-upload'

/** KV key for the public `GET /api/v1/node-profile` payload.
 *  v2: the payload gained a `features` field (per-node feature
 *  toggles) — bumping the key means a stale v1 body (no `features`)
 *  is never served; orphaned v1 entries expire on their own TTL.
 *  v3: `profile.tagline` (0060). Bumped for the same reason: a build
 *  without the field that shares this namespace (a preview of an
 *  older branch, a rollback) would otherwise refill the key with a
 *  body lacking it, and a tagline the operator set would vanish from
 *  the loading screen for up to the TTL. */
export const NODE_PROFILE_CACHE_KEY = 'node-profile:v3'

/** Best-effort bust of the public profile cache. */
export async function bustNodeProfileCache(kv: KVNamespace | undefined): Promise<void> {
  if (!kv) return
  try {
    await kv.delete(NODE_PROFILE_CACHE_KEY)
  } catch {
    // Best-effort — a stale entry expires on its own TTL.
  }
}

/** The `node_profile` row as stored. */
export interface NodeProfileRow {
  org_name: string
  mission: string | null
  about_md: string | null
  region_focus: string | null
  default_tone: string | null
  links_json: string | null
  logo_ref: string | null
  tagline: string | null
  updated_by: string
  updated_at: string
}

export interface NodeProfileLink {
  label: string
  url: string
}

/** The wire shape the portal reads and writes. */
export interface NodeProfilePublic {
  orgName: string
  mission: string | null
  aboutMd: string | null
  regionFocus: string | null
  defaultTone: string | null
  links: NodeProfileLink[]
  logoUrl: string | null
  /** The loading-screen tagline, or null for the app's built-in one. */
  tagline: string | null
  updatedBy: string
  updatedAt: string
}

/** The columns every deploy has, before 0060's `tagline`. */
const BASE_COLUMNS = `org_name, mission, about_md, region_focus, default_tone,
              links_json, logo_ref, updated_by, updated_at`

/**
 * Fetch the singleton profile row, or null when never filled in.
 *
 * Survives a database without migration 0060 (`tagline`), and has to:
 * a fork has CI migrations off by default (`docs/SELF_HOSTING.md`
 * §14.3), and a preview deploy shares production's D1 while
 * migrations apply only from `main`. Failing here would fail the
 * public identity read, whose fallback turns every feature back on,
 * Orbit included, on a node that turned it off — the hazard
 * `node-settings-store` keeps 0057 off its hot path for. So the full
 * read is tried first and, **only** if it fails for a missing column,
 * the pre-0060 columns, reading `tagline` as null. Any other failure
 * propagates: a one-off error answered with the fallback would cache
 * "no tagline" for the TTL, and hand the portal an empty field whose
 * next Save clears the real one.
 */
export async function getNodeProfile(db: D1Database): Promise<NodeProfileRow | null> {
  try {
    const row = await db
      .prepare(`SELECT ${BASE_COLUMNS}, tagline FROM node_profile WHERE id = 1 LIMIT 1`)
      .first<NodeProfileRow>()
    return row ?? null
  } catch (err) {
    if (!isMissingColumn(err)) throw err
    const row = await db
      .prepare(`SELECT ${BASE_COLUMNS} FROM node_profile WHERE id = 1 LIMIT 1`)
      .first<Omit<NodeProfileRow, 'tagline'>>()
    return row ? { ...row, tagline: null } : null
  }
}

/** SQLite's error for a column the table does not have, as D1 and
 *  better-sqlite3 both word it. */
function isMissingColumn(err: unknown): boolean {
  return err instanceof Error && /no such column/i.test(err.message)
}

/** True when this database has 0060's `tagline` column. Any failure
 *  other than the missing column propagates, so a one-off error is
 *  not reported as a pending migration. */
async function hasTaglineColumn(db: D1Database): Promise<boolean> {
  try {
    await db.prepare('SELECT tagline FROM node_profile LIMIT 0').all()
    return true
  } catch (err) {
    if (isMissingColumn(err)) return false
    throw err
  }
}

/** A tagline was given for a database that cannot store one yet. */
export class TaglineMigrationPendingError extends Error {
  constructor() {
    super('node_profile.tagline is missing: apply catalog migration 0060')
    this.name = 'TaglineMigrationPendingError'
  }
}

/** Shape a stored row into the wire payload. A corrupt `links_json`
 *  degrades to an empty list rather than failing the read, and every
 *  stored link is re-validated on the way out (non-empty bounded
 *  label, http(s)-only url, clamped to {@link PROFILE_MAX_LINKS}) —
 *  legacy or hand-edited rows must not let a `javascript:` url reach
 *  a surface that renders these as anchors.
 *
 *  `resolveLogoRef` maps the stored `logo_ref` (`r2:<key>`) to a
 *  fetchable http(s) URL — routes bind `resolveHttpAssetUrl(env, …)`
 *  so only http(s) results ever reach an `<img src>`. Omitted (tests
 *  that don't care about R2 resolution) → `logoUrl: null`. */
export function toPublicProfile(
  row: NodeProfileRow,
  resolveLogoRef?: (ref: string) => string | null,
): NodeProfilePublic {
  let links: NodeProfileLink[] = []
  if (row.links_json) {
    try {
      const parsed: unknown = JSON.parse(row.links_json)
      if (Array.isArray(parsed)) {
        links = parsed
          .map(l => {
            if (!l || typeof l !== 'object') return null
            const rec = l as Record<string, unknown>
            const label = typeof rec.label === 'string' ? rec.label.trim() : ''
            const url = typeof rec.url === 'string' ? rec.url.trim() : ''
            if (!label || label.length > PROFILE_LINK_LABEL_MAX_LEN || !isHttpUrl(url)) return null
            return { label, url }
          })
          .filter((l): l is NodeProfileLink => l !== null)
          .slice(0, PROFILE_MAX_LINKS)
      }
    } catch {
      // Corrupt JSON — treat as no links.
    }
  }
  return {
    orgName: row.org_name,
    mission: row.mission,
    aboutMd: row.about_md,
    regionFocus: row.region_focus,
    defaultTone: row.default_tone,
    links,
    logoUrl: row.logo_ref && resolveLogoRef ? resolveLogoRef(row.logo_ref) : null,
    tagline: storedTagline(row.tagline),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  }
}

/** A validated `PUT` body, ready for {@link setNodeProfile}. */
export interface ValidatedProfileInput {
  org_name: string
  mission: string | null
  about_md: string | null
  region_focus: string | null
  default_tone: string | null
  links_json: string | null
  /** `undefined` (the body did not name it) keeps the stored value;
   *  null clears it. */
  tagline: string | null | undefined
}

/** Upsert the singleton profile. `logo_ref` is deliberately absent
 *  from the column list — the text-fields PUT must not clear a logo
 *  set through the dedicated upload route.
 *
 *  `tagline` is named only when the body named it, so a writer that
 *  predates the field leaves it as it was (see
 *  {@link validateProfileInput}), and only where 0060 has been
 *  applied, so the rest of the profile still saves on a database
 *  without it ({@link getNodeProfile}). A non-empty tagline given
 *  there throws {@link TaglineMigrationPendingError} before anything
 *  is written, rather than saving the rest and dropping it. The column
 *  names are fixed strings chosen here, never input; every value is
 *  bound.
 *
 *  Returns the tagline the write replaced beside the new row, for the
 *  audit trail. Where the write sets one, it is read in the same D1
 *  batch, so in one transaction with the write: read separately, two
 *  admins saving at once could each record the same previous value,
 *  and the trail could not say which save replaced which. */
export async function setNodeProfile(
  db: D1Database,
  publisher: PublisherRow,
  input: ValidatedProfileInput,
  now: string = new Date().toISOString(),
): Promise<{ row: NodeProfileRow; previousTagline: string | null }> {
  const named = input.tagline !== undefined
  const withTagline = named && (await hasTaglineColumn(db))
  if (named && !withTagline && input.tagline != null) throw new TaglineMigrationPendingError()
  const columns = [
    'org_name',
    'mission',
    'about_md',
    'region_focus',
    'default_tone',
    'links_json',
    ...(withTagline ? ['tagline'] : []),
    'updated_by',
    'updated_at',
  ]
  const values = [
    input.org_name,
    input.mission,
    input.about_md,
    input.region_focus,
    input.default_tone,
    input.links_json,
    ...(withTagline ? [input.tagline] : []),
    publisher.id,
    now,
  ]
  const upsert = db
    .prepare(
      `INSERT INTO node_profile (id, ${columns.join(', ')})
       VALUES (1, ${columns.map(() => '?').join(', ')})
       ON CONFLICT(id) DO UPDATE SET ${columns.map(c => `${c} = excluded.${c}`).join(', ')}`,
    )
    .bind(...values)
  let previousTagline: string | null = null
  if (withTagline) {
    const [before] = await db.batch([db.prepare('SELECT tagline FROM node_profile WHERE id = 1'), upsert])
    previousTagline = (before.results as Array<{ tagline: string | null }> | undefined)?.[0]?.tagline ?? null
  } else {
    await upsert.run()
  }
  // Re-read rather than reconstructing from input so columns the
  // upsert doesn't touch (logo_ref) come back accurate.
  const row = await getNodeProfile(db)
  if (!row) throw new Error('node_profile upsert did not persist')
  // A write that did not name the tagline left it as it was.
  return { row, previousTagline: withTagline ? previousTagline : row.tagline }
}

/**
 * Set (or clear, with `null`) the profile's logo ref. Returns
 * `'missing'` when no profile row exists yet — the logo upload
 * requires a saved profile so there is an `org_name` to attribute
 * the logo to.
 */
export async function setNodeProfileLogo(
  db: D1Database,
  publisher: PublisherRow,
  logoRef: string | null,
  now: string = new Date().toISOString(),
): Promise<'ok' | 'missing'> {
  const res = await db
    .prepare(
      `UPDATE node_profile
          SET logo_ref = ?, updated_by = ?, updated_at = ?
        WHERE id = 1`,
    )
    .bind(logoRef, publisher.id, now)
    .run()
  return res.meta.changes > 0 ? 'ok' : 'missing'
}

/** A single body-validation error in the publisher-API array shape. */
export interface FieldError {
  field: string
  code: string
  message: string
}

function optionalText(
  body: Record<string, unknown>,
  field: string,
  maxLen: number,
  errors: FieldError[],
): string | null {
  const raw = body[field]
  if (raw == null) return null
  if (typeof raw !== 'string') {
    errors.push({ field, code: 'invalid', message: `\`${field}\` must be a string.` })
    return null
  }
  if (raw.length > maxLen) {
    errors.push({ field, code: 'too_long', message: `\`${field}\` must be at most ${maxLen} characters.` })
    return null
  }
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * A stored tagline as it may leave the store: trimmed, non-empty,
 * within {@link PROFILE_TAGLINE_MAX_LEN} and free of the characters
 * `src/types/node-tagline.ts` refuses, else null (the app's built-in
 * tagline). The PUT already
 * refuses anything else; this re-check is for a row edited by hand,
 * the same guard {@link toPublicProfile} applies to stored links.
 */
export function storedTagline(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > PROFILE_TAGLINE_MAX_LEN || !hasOnlyTaglineChars(trimmed)) return null
  return trimmed
}

/** True for the http(s) URLs the profile is allowed to link out to —
 *  the same scheme guard the events surfaces apply to source URLs. */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Validate a `PUT /api/v1/publish/node-profile` body. Only `orgName`
 * is mandatory — a node can fill in the rest over time.
 *
 * The PUT replaces the text fields 0028 created, so omitting one of
 * those clears it: every writer has always sent them. A field added
 * since is different — a writer coded before it omits it because it
 * does not know it, not to clear it — so a later field is **kept when
 * omitted** and cleared by an explicit null or empty string, the rule
 * `logo_ref` (0030) and node-settings' sections already follow.
 * `tagline` (0060) is the first such text field; any further one
 * should follow it. Links are
 * validated as `{label, url}` pairs with http(s) urls; anything else
 * is a field error rather than a silent drop, so the operator sees
 * what the form refused.
 */
export function validateProfileInput(
  raw: unknown,
): { ok: true; value: ValidatedProfileInput } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = []
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  const orgNameRaw = body.orgName
  let orgName = ''
  if (typeof orgNameRaw !== 'string' || orgNameRaw.trim().length === 0) {
    errors.push({ field: 'orgName', code: 'required', message: '`orgName` is required.' })
  } else if (orgNameRaw.length > PROFILE_ORG_NAME_MAX_LEN) {
    errors.push({ field: 'orgName', code: 'too_long', message: `\`orgName\` must be at most ${PROFILE_ORG_NAME_MAX_LEN} characters.` })
  } else {
    orgName = orgNameRaw.trim()
  }

  const mission = optionalText(body, 'mission', PROFILE_MISSION_MAX_LEN, errors)
  const aboutMd = optionalText(body, 'aboutMd', PROFILE_ABOUT_MAX_LEN, errors)
  const regionFocus = optionalText(body, 'regionFocus', PROFILE_REGION_MAX_LEN, errors)
  const defaultTone = optionalText(body, 'defaultTone', PROFILE_TONE_MAX_LEN, errors)
  const tagline =
    body.tagline === undefined ? undefined : optionalText(body, 'tagline', PROFILE_TAGLINE_MAX_LEN, errors)
  if (tagline != null && !hasOnlyTaglineChars(tagline)) {
    errors.push({
      field: 'tagline',
      code: 'invalid_characters',
      message: '`tagline` must be a single line of visible text, with no tabs, line breaks or invisible characters.',
    })
  }

  let linksJson: string | null = null
  if (body.links != null) {
    if (!Array.isArray(body.links)) {
      errors.push({ field: 'links', code: 'invalid', message: '`links` must be an array of {label, url}.' })
    } else if (body.links.length > PROFILE_MAX_LINKS) {
      errors.push({ field: 'links', code: 'too_many', message: `\`links\` must have at most ${PROFILE_MAX_LINKS} entries.` })
    } else {
      const links: NodeProfileLink[] = []
      for (let i = 0; i < body.links.length; i++) {
        const l = body.links[i] as Record<string, unknown> | null
        const label = l && typeof l.label === 'string' ? l.label.trim() : ''
        const url = l && typeof l.url === 'string' ? l.url.trim() : ''
        if (!label || label.length > PROFILE_LINK_LABEL_MAX_LEN || !isHttpUrl(url)) {
          errors.push({
            field: `links[${i}]`,
            code: 'invalid',
            message: 'Each link needs a non-empty label and an http(s) url.',
          })
          continue
        }
        links.push({ label, url })
      }
      if (links.length > 0) linksJson = JSON.stringify(links)
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      org_name: orgName,
      mission,
      about_md: aboutMd,
      region_focus: regionFocus,
      default_tone: defaultTone,
      links_json: linksJson,
      tagline,
    },
  }
}
