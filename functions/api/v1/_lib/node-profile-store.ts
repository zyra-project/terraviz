// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `node_profile` singleton row helpers (`migrations/catalog/0028_node_profile.sql`).
 *
 * The operator-authored "about the host organization" context — the
 * Phase 3d blog generator grounds AI drafts in it so they speak in
 * the node's own voice, and it is generic enough to back other
 * identity surfaces (the public app's loading-screen tagline and
 * dataset-browser subtitle today; an about
 * page or footer attribution later).
 *
 * Mirrors `hero-override-store.ts`: pure data access + body
 * validation; authorisation lives in the route handler
 * (privileged-only writes via `isPrivileged`). Absence of a row means
 * "profile not filled in yet" — every consumer degrades gracefully.
 */

import type { PublisherRow } from './publisher-store'
import {
  BROWSE_SUBTITLE_MAX_LEN,
  TAGLINE_MAX_LEN,
  hasOnlyDisplayLineChars,
} from '../../../../src/types/node-profile-lines'

/** Bounds keep the stored payload (and any prompt it is interpolated
 *  into) small. Generous for prose, hostile to paste-bombs. */
export const PROFILE_ORG_NAME_MAX_LEN = 200
export const PROFILE_MISSION_MAX_LEN = 1_000
export const PROFILE_ABOUT_MAX_LEN = 10_000
export const PROFILE_REGION_MAX_LEN = 200
export const PROFILE_TONE_MAX_LEN = 200
export const PROFILE_MAX_LINKS = 10
export const PROFILE_LINK_LABEL_MAX_LEN = 100
/** The display lines' bounds, and their character rules, live in
 *  `src/types/node-profile-lines.ts`, shared with the portal form. */
export const PROFILE_TAGLINE_MAX_LEN = TAGLINE_MAX_LEN
export const PROFILE_BROWSE_SUBTITLE_MAX_LEN = BROWSE_SUBTITLE_MAX_LEN

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
 *  the loading screen for up to the TTL.
 *  v4: `profile.browseSubtitle` (0061), for the same reason. */
export const NODE_PROFILE_CACHE_KEY = 'node-profile:v4'

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
  browse_subtitle: string | null
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
  /** The dataset browser's subtitle, or null for the app's built-in one. */
  browseSubtitle: string | null
  updatedBy: string
  updatedAt: string
}

/** The columns every deploy has, before the display lines were added. */
const BASE_COLUMNS = `org_name, mission, about_md, region_focus, default_tone,
              links_json, logo_ref, updated_by, updated_at`

/** A display line added to the profile after 0028, one migration each
 *  (see `src/types/node-profile-lines.ts`). Each is optional on a PUT
 *  and kept when omitted ({@link validateProfileInput}), and each may
 *  be missing from a database its migration has not reached. */
export type LateLineColumn = 'tagline' | 'browse_subtitle'

interface LateLine {
  column: LateLineColumn
  /** The field's name on the wire. */
  field: 'tagline' | 'browseSubtitle'
  migration: string
  maxLen: number
}

const LATE_LINES: readonly LateLine[] = [
  { column: 'tagline', field: 'tagline', migration: '0060', maxLen: TAGLINE_MAX_LEN },
  { column: 'browse_subtitle', field: 'browseSubtitle', migration: '0061', maxLen: BROWSE_SUBTITLE_MAX_LEN },
]

/**
 * Fetch the singleton profile row, or null when never filled in.
 *
 * Survives a database without the display lines' migrations (0060,
 * 0061), and has to: a fork has CI migrations off by default
 * (`docs/SELF_HOSTING.md` §14.3), and a preview deploy shares
 * production's D1 while migrations apply only from `main`. Failing
 * here would fail the public identity read, whose fallback turns every
 * feature back on, Orbit included, on a node that turned it off — the
 * hazard `node-settings-store` keeps 0057 off its hot path for. So the
 * full read is tried first and, **only** if it fails for a missing
 * column, the columns this database has, reading the rest as null.
 * Any other failure propagates: a one-off error answered with the
 * fallback would cache "no tagline" for the TTL, and hand the portal
 * an empty field whose next Save clears the real one.
 */
export async function getNodeProfile(db: D1Database): Promise<NodeProfileRow | null> {
  const all = LATE_LINES.map(l => l.column)
  try {
    const row = await db.prepare(selectProfileSql(all)).first<NodeProfileRow>()
    return row ?? null
  } catch (err) {
    if (!isMissingColumn(err)) throw err
    const present = await presentLateColumns(db)
    const row = await db.prepare(selectProfileSql(present)).first<Partial<NodeProfileRow>>()
    return row ? withAbsentLines(row) : null
  }
}

/** The profile read, naming only the late columns given. The names are
 *  fixed strings from {@link LATE_LINES}, never input. */
function selectProfileSql(late: readonly LateLineColumn[]): string {
  return `SELECT ${[BASE_COLUMNS, ...late].join(', ')} FROM node_profile WHERE id = 1 LIMIT 1`
}

/** A row read without some late columns, with each absent one null. */
function withAbsentLines(row: Partial<NodeProfileRow>): NodeProfileRow {
  const out = { ...row } as NodeProfileRow
  for (const { column } of LATE_LINES) if (out[column] === undefined) out[column] = null
  return out
}

/** SQLite's error for a column the table does not have, as D1 and
 *  better-sqlite3 both word it. */
function isMissingColumn(err: unknown): boolean {
  return err instanceof Error && /no such column/i.test(err.message)
}

/** The late columns this database has. Any failure other than a
 *  missing column propagates, so a one-off error is not reported as a
 *  pending migration. */
async function presentLateColumns(db: D1Database): Promise<LateLineColumn[]> {
  const present: LateLineColumn[] = []
  for (const { column } of LATE_LINES) {
    try {
      await db.prepare(`SELECT ${column} FROM node_profile LIMIT 0`).all()
      present.push(column)
    } catch (err) {
      if (!isMissingColumn(err)) throw err
    }
  }
  return present
}

/** One display line a database cannot store yet: its wire field and
 *  the migration that adds its column. */
export interface PendingLine {
  field: LateLine['field']
  migration: string
}

/** Display lines were given for a database that cannot store them yet.
 *  Every such line is listed, so one refusal names them all rather than
 *  the operator emptying one field to meet the next. */
export class ProfileMigrationPendingError extends Error {
  constructor(readonly pending: readonly PendingLine[]) {
    super(
      `node_profile cannot store ${pending
        .map(p => `${LATE_LINES.find(l => l.field === p.field)?.column} (migration ${p.migration})`)
        .join(', ')}`,
    )
    this.name = 'ProfileMigrationPendingError'
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
    browseSubtitle: storedBrowseSubtitle(row.browse_subtitle),
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
  /** For each display line, `undefined` (the body did not name it)
   *  keeps the stored value; null clears it. */
  tagline: string | null | undefined
  browse_subtitle: string | null | undefined
}

/** The display lines a write replaced, by column, for the audit trail:
 *  null for a line this database cannot hold. */
export type PreviousLines = Record<LateLineColumn, string | null>

/** Upsert the singleton profile. `logo_ref` is deliberately absent
 *  from the column list — the text-fields PUT must not clear a logo
 *  set through the dedicated upload route.
 *
 *  Each display line is named only when the body named it, so a writer
 *  that predates the field leaves it as it was (see
 *  {@link validateProfileInput}), and only where its migration has been
 *  applied, so the rest of the profile still saves on a database
 *  without it ({@link getNodeProfile}). Non-empty lines given there
 *  throw {@link ProfileMigrationPendingError}, naming every one, before
 *  anything is written, rather than saving the rest and dropping them. The column
 *  names are fixed strings chosen here, never input; every value is
 *  bound.
 *
 *  Returns the lines the write replaced beside the row as the write
 *  left it, both read in the same D1 batch as the write, so in one
 *  transaction with it: read separately, two admins saving at once
 *  could each record the same previous value, or one could report the
 *  other's line as its own. */
export async function setNodeProfile(
  db: D1Database,
  publisher: PublisherRow,
  input: ValidatedProfileInput,
  now: string = new Date().toISOString(),
): Promise<{ row: NodeProfileRow; previous: PreviousLines }> {
  const present = await presentLateColumns(db)
  const written: LateLineColumn[] = []
  const pending: PendingLine[] = []
  for (const line of LATE_LINES) {
    const value = input[line.column]
    if (value === undefined) continue
    if (!present.includes(line.column)) {
      if (value != null) pending.push({ field: line.field, migration: line.migration })
      continue
    }
    written.push(line.column)
  }
  if (pending.length > 0) throw new ProfileMigrationPendingError(pending)
  const columns = [
    'org_name',
    'mission',
    'about_md',
    'region_focus',
    'default_tone',
    'links_json',
    ...written,
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
    ...written.map(column => input[column] ?? null),
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
  // The row as this write left it, read back rather than reconstructed
  // from input so columns the upsert doesn't touch (logo_ref) come back
  // accurate — and read in the same batch as the write, as the replaced
  // lines are, so a save landing between them cannot leak into this
  // one's result or its audit row.
  const after = db.prepare(selectProfileSql(present))
  const results =
    present.length > 0
      ? await db.batch([db.prepare(`SELECT ${present.join(', ')} FROM node_profile WHERE id = 1`), upsert, after])
      : await db.batch([upsert, after])
  const firstRow = <T,>(r: D1Result | undefined): T | undefined => (r?.results as T[] | undefined)?.[0]
  const saved = firstRow<Partial<NodeProfileRow>>(results[results.length - 1])
  if (!saved) throw new Error('node_profile upsert did not persist')
  const before = present.length > 0 ? firstRow<Partial<PreviousLines>>(results[0]) : undefined
  const previous = {} as PreviousLines
  for (const { column } of LATE_LINES) previous[column] = before?.[column] ?? null
  return { row: withAbsentLines(saved), previous }
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
 * A stored display line as it may leave the store: trimmed, non-empty,
 * within its bound and free of the characters
 * `src/types/node-profile-lines.ts` refuses, else null (the app's
 * built-in line). The PUT already refuses anything else; this
 * re-check is for a row edited by hand, the same guard
 * {@link toPublicProfile} applies to stored links.
 */
function storedLine(raw: string | null | undefined, maxLen: number): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > maxLen || !hasOnlyDisplayLineChars(trimmed)) return null
  return trimmed
}

/** {@link storedLine} for the loading-screen tagline. */
export function storedTagline(raw: string | null | undefined): string | null {
  return storedLine(raw, PROFILE_TAGLINE_MAX_LEN)
}

/** {@link storedLine} for the dataset browser's subtitle. */
export function storedBrowseSubtitle(raw: string | null | undefined): string | null {
  return storedLine(raw, PROFILE_BROWSE_SUBTITLE_MAX_LEN)
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
 * The display lines `tagline` (0060) and `browseSubtitle` (0061) are
 * such fields, and any further one should follow them. Links are
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
  const lines = {} as Record<LateLineColumn, string | null | undefined>
  for (const { column, field, maxLen } of LATE_LINES) {
    const value = body[field] === undefined ? undefined : optionalText(body, field, maxLen, errors)
    if (value != null && !hasOnlyDisplayLineChars(value)) {
      errors.push({
        field,
        code: 'invalid_characters',
        message: `\`${field}\` must be a single line of visible text, with no tabs, line breaks or invisible characters.`,
      })
    }
    lines[column] = value
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
      tagline: lines.tagline,
      browse_subtitle: lines.browse_subtitle,
    },
  }
}
