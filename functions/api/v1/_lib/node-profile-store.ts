// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `node_profile` singleton row helpers (`migrations/catalog/0028_node_profile.sql`).
 *
 * The operator-authored "about the host organization" context — the
 * Phase 3d blog generator grounds AI drafts in it so they speak in
 * the node's own voice, and it is generic enough to back other
 * identity surfaces (the public app's splash tagline today; an about
 * page or footer attribution later).
 *
 * Mirrors `hero-override-store.ts`: pure data access + body
 * validation; authorisation lives in the route handler
 * (privileged-only writes via `isPrivileged`). Absence of a row means
 * "profile not filled in yet" — every consumer degrades gracefully.
 */

import type { PublisherRow } from './publisher-store'

/** Bounds keep the stored payload (and any prompt it is interpolated
 *  into) small. Generous for prose, hostile to paste-bombs. */
export const PROFILE_ORG_NAME_MAX_LEN = 200
export const PROFILE_MISSION_MAX_LEN = 1_000
export const PROFILE_ABOUT_MAX_LEN = 10_000
export const PROFILE_REGION_MAX_LEN = 200
export const PROFILE_TONE_MAX_LEN = 200
export const PROFILE_MAX_LINKS = 10
export const PROFILE_LINK_LABEL_MAX_LEN = 100
/** The splash-screen tagline sits on one line under the app title,
 *  uppercased and letter-spaced, so it is kept short. */
export const PROFILE_TAGLINE_MAX_LEN = 80

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
 *  Not bumped for `profile.tagline` (0060): a v2 body cached before
 *  the column existed lacks it, which every reader takes as "no
 *  tagline" — true of that row, since setting one goes through the
 *  PUT, which busts this key. */
export const NODE_PROFILE_CACHE_KEY = 'node-profile:v2'

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
  /** The splash-screen tagline, or null for the app's built-in one. */
  tagline: string | null
  updatedBy: string
  updatedAt: string
}

/** Fetch the singleton profile row, or null when never filled in. */
export async function getNodeProfile(db: D1Database): Promise<NodeProfileRow | null> {
  const row = await db
    .prepare(
      `SELECT org_name, mission, about_md, region_focus, default_tone,
              links_json, logo_ref, tagline, updated_by, updated_at
         FROM node_profile
        WHERE id = 1
        LIMIT 1`,
    )
    .first<NodeProfileRow>()
  return row ?? null
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
  tagline: string | null
}

/** Upsert the singleton profile. `logo_ref` is deliberately absent
 *  from the column list — the text-fields PUT must not clear a logo
 *  set through the dedicated upload route. */
export async function setNodeProfile(
  db: D1Database,
  publisher: PublisherRow,
  input: ValidatedProfileInput,
  now: string = new Date().toISOString(),
): Promise<NodeProfileRow> {
  await db
    .prepare(
      `INSERT INTO node_profile
         (id, org_name, mission, about_md, region_focus, default_tone,
          links_json, tagline, updated_by, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         org_name     = excluded.org_name,
         mission      = excluded.mission,
         about_md     = excluded.about_md,
         region_focus = excluded.region_focus,
         default_tone = excluded.default_tone,
         links_json   = excluded.links_json,
         tagline      = excluded.tagline,
         updated_by   = excluded.updated_by,
         updated_at   = excluded.updated_at`,
    )
    .bind(
      input.org_name,
      input.mission,
      input.about_md,
      input.region_focus,
      input.default_tone,
      input.links_json,
      input.tagline,
      publisher.id,
      now,
    )
    .run()
  // Re-read rather than reconstructing from input so columns the
  // upsert doesn't touch (logo_ref) come back accurate.
  const row = await getNodeProfile(db)
  if (!row) throw new Error('node_profile upsert did not persist')
  return row
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

/** Line breaks, tabs and the other C0/C1 control characters. A
 *  tagline is one line of display text; none of these has a place in
 *  it, and a newline would break the splash layout. */
const TAGLINE_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/

/**
 * A stored tagline as it may leave the store: trimmed, non-empty,
 * within {@link PROFILE_TAGLINE_MAX_LEN} and free of control
 * characters, else null (the app's built-in tagline). The PUT already
 * refuses anything else; this re-check is for a row edited by hand,
 * the same guard {@link toPublicProfile} applies to stored links.
 */
export function storedTagline(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > PROFILE_TAGLINE_MAX_LEN || TAGLINE_CONTROL_CHARS.test(trimmed)) return null
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
 * is mandatory — a node can fill in the rest over time. `tagline` is
 * optional like the other prose fields, and like them is cleared by a
 * PUT that omits it (the PUT replaces the whole profile). Links are
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
  const tagline = optionalText(body, 'tagline', PROFILE_TAGLINE_MAX_LEN, errors)
  if (tagline != null && TAGLINE_CONTROL_CHARS.test(tagline)) {
    errors.push({
      field: 'tagline',
      code: 'invalid',
      message: '`tagline` must be a single line of text.',
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
