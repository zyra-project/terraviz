/**
 * `blog_posts` data access (`migrations/catalog/0029_blog_posts.sql`)
 * — Phase 3d curator-authored blog posts.
 *
 * Mirrors `events-store.ts` conventions: snake_case row types, public
 * (camelCase) mappers, pure D1 (`prepare/bind/first/all/run`), no
 * route wiring. Authorisation lives in the route handlers.
 *
 * Trust discipline: rows are born `draft`; only `publishBlogPost`
 * makes one publicly readable, and unpublish returns it to `draft`
 * (the audit log carries the history). Slugs are allocated once at
 * create and stay stable — published URLs must not churn on edits.
 */

import { newUlid } from './ulid'
import type { PublisherRow } from './publisher-store'

/** Bounds keep the stored payload sane; the portal enforces the same
 *  limits client-side. */
export const POST_TITLE_MAX_LEN = 200
export const POST_SUMMARY_MAX_LEN = 500
export const POST_BODY_MAX_LEN = 100_000
export const POST_MAX_DATASETS = 20

/** KV keys the public blog reads cache under; the write paths bust
 *  them so a publish/unpublish is live within a tick (the 60 s TTL
 *  on the routes is the backstop). */
export const BLOG_LIST_CACHE_KEY = 'blog:list:v1'
export function blogPostCacheKey(slug: string): string {
  return `blog:post:${slug}:v1`
}

/** Best-effort bust of the public blog caches after a write. */
export async function bustBlogCache(kv: KVNamespace | undefined, slug?: string): Promise<void> {
  if (!kv) return
  try {
    await kv.delete(BLOG_LIST_CACHE_KEY)
    if (slug) await kv.delete(blogPostCacheKey(slug))
  } catch {
    // TTL is the backstop.
  }
}

export type BlogPostStatus = 'draft' | 'published'

/** The `blog_posts` row as stored (snake_case). */
export interface BlogPostRow {
  id: string
  slug: string
  title: string
  summary: string | null
  body_md: string
  dataset_ids: string | null
  event_id: string | null
  author_id: string
  status: BlogPostStatus
  created_at: string
  updated_at: string
  published_at: string | null
  tour_id: string | null
}

/** The authoring-side wire shape (drafts included). */
export interface BlogPostPublic {
  id: string
  slug: string
  title: string
  summary: string | null
  bodyMd: string
  datasetIds: string[]
  eventId: string | null
  authorId: string
  status: BlogPostStatus
  createdAt: string
  updatedAt: string
  publishedAt: string | null
  /** The AI-generated companion tour's tours-row id, when one exists. */
  tourId: string | null
}

const COLUMNS =
  'id, slug, title, summary, body_md, dataset_ids, event_id, author_id, status, created_at, updated_at, published_at, tour_id'

function parseDatasetIds(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function toPublicPost(row: BlogPostRow): BlogPostPublic {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    bodyMd: row.body_md,
    datasetIds: parseDatasetIds(row.dataset_ids),
    eventId: row.event_id,
    authorId: row.author_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    tourId: row.tour_id,
  }
}

/** Slug derivation for posts — same rules as the dataset/tour slugs
 *  but with a `post` fallback prefix when the title yields nothing
 *  usable (mirrors `deriveSlug` in `validators.ts`). */
export function deriveBlogSlug(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/^-+|-+$/g, '')
  if (!base) return 'post'
  if (!/^[a-z]/.test(base)) {
    return `post-${base}`.slice(0, 64).replace(/-+$/, '')
  }
  return base
}

async function slugInUse(db: D1Database, slug: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM blog_posts WHERE slug = ? LIMIT 1')
    .bind(slug)
    .first<{ id: string }>()
  return row != null
}

async function ensureUniqueSlug(db: D1Database, desired: string): Promise<string> {
  let candidate = desired
  let n = 1
  while (await slugInUse(db, candidate)) {
    n++
    // Truncate the BASE to make room for the suffix — slicing the
    // composed string would drop the suffix on a max-length slug and
    // re-test the same candidate forever.
    const suffix = `-${n}`
    candidate = `${desired.slice(0, 64 - suffix.length)}${suffix}`
    if (n > 100) throw new Error('Could not allocate a unique blog slug')
  }
  return candidate
}

/** A validated create/update payload (route-side validation). */
export interface BlogPostInput {
  title: string
  summary: string | null
  bodyMd: string
  datasetIds: string[]
  eventId: string | null
  tourId: string | null
}

export async function insertBlogPost(
  db: D1Database,
  author: PublisherRow,
  input: BlogPostInput,
  now: string = new Date().toISOString(),
): Promise<BlogPostRow> {
  const id = newUlid()
  const slug = await ensureUniqueSlug(db, deriveBlogSlug(input.title))
  const row: BlogPostRow = {
    id,
    slug,
    title: input.title,
    summary: input.summary,
    body_md: input.bodyMd,
    dataset_ids: input.datasetIds.length > 0 ? JSON.stringify(input.datasetIds) : null,
    event_id: input.eventId,
    author_id: author.id,
    status: 'draft',
    created_at: now,
    updated_at: now,
    published_at: null,
    tour_id: input.tourId,
  }
  await db
    .prepare(
      `INSERT INTO blog_posts (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id, row.slug, row.title, row.summary, row.body_md, row.dataset_ids,
      row.event_id, row.author_id, row.status, row.created_at, row.updated_at, row.published_at,
      row.tour_id,
    )
    .run()
  return row
}

/** Update content fields. The slug never changes here. Returns the
 *  fresh row, or null when the id is unknown. */
export async function updateBlogPost(
  db: D1Database,
  id: string,
  input: BlogPostInput,
  now: string = new Date().toISOString(),
): Promise<BlogPostRow | null> {
  const existing = await getBlogPost(db, id)
  if (!existing) return null
  await db
    .prepare(
      `UPDATE blog_posts
          SET title = ?, summary = ?, body_md = ?, dataset_ids = ?, event_id = ?, tour_id = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(
      input.title,
      input.summary,
      input.bodyMd,
      input.datasetIds.length > 0 ? JSON.stringify(input.datasetIds) : null,
      input.eventId,
      input.tourId,
      now,
      id,
    )
    .run()
  return getBlogPost(db, id)
}

export async function getBlogPost(db: D1Database, id: string): Promise<BlogPostRow | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM blog_posts WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<BlogPostRow>()
  return row ?? null
}

export async function getPublishedBySlug(db: D1Database, slug: string): Promise<BlogPostRow | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM blog_posts WHERE slug = ? AND status = 'published' LIMIT 1`)
    .bind(slug)
    .first<BlogPostRow>()
  return row ?? null
}

/** Authoring list — newest first, optional status filter. */
export async function listBlogPosts(
  db: D1Database,
  opts: { status?: BlogPostStatus; limit?: number } = {},
): Promise<BlogPostRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200)
  const res = opts.status
    ? await db
        .prepare(`SELECT ${COLUMNS} FROM blog_posts WHERE status = ? ORDER BY updated_at DESC LIMIT ?`)
        .bind(opts.status, limit)
        .all<BlogPostRow>()
    : await db
        .prepare(`SELECT ${COLUMNS} FROM blog_posts ORDER BY updated_at DESC LIMIT ?`)
        .bind(limit)
        .all<BlogPostRow>()
  return res.results ?? []
}

/** Public list — published only, newest publish first. */
export async function listPublishedPosts(
  db: D1Database,
  opts: { limit?: number } = {},
): Promise<BlogPostRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100)
  const res = await db
    .prepare(
      `SELECT ${COLUMNS} FROM blog_posts
        WHERE status = 'published'
        ORDER BY published_at DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<BlogPostRow>()
  return res.results ?? []
}

/** Flip to published (idempotent; keeps the first publish time). */
export async function publishBlogPost(
  db: D1Database,
  id: string,
  now: string = new Date().toISOString(),
): Promise<BlogPostRow | null> {
  await db
    .prepare(
      `UPDATE blog_posts
          SET status = 'published',
              published_at = COALESCE(published_at, ?),
              updated_at = ?
        WHERE id = ?`,
    )
    .bind(now, now, id)
    .run()
  return getBlogPost(db, id)
}

/** Return to draft. `published_at` is kept for the audit trail; the
 *  public reads filter on `status` alone. */
export async function unpublishBlogPost(
  db: D1Database,
  id: string,
  now: string = new Date().toISOString(),
): Promise<BlogPostRow | null> {
  await db
    .prepare(`UPDATE blog_posts SET status = 'draft', updated_at = ? WHERE id = ?`)
    .bind(now, id)
    .run()
  return getBlogPost(db, id)
}

/** A single body-validation error in the publisher-API array shape. */
export interface BlogFieldError {
  field: string
  code: string
  message: string
}

/**
 * Validate a create/update body into a {@link BlogPostInput}.
 * `title` and `bodyMd` are mandatory; `datasetIds` is capped and
 * filtered to strings (existence/visibility is enforced where it
 * matters — the public read hydrates only visible datasets).
 */
export function validateBlogInput(
  raw: unknown,
): { ok: true; value: BlogPostInput } | { ok: false; errors: BlogFieldError[] } {
  const errors: BlogFieldError[] = []
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  let title = ''
  if (typeof body.title !== 'string' || body.title.trim().length === 0) {
    errors.push({ field: 'title', code: 'required', message: '`title` is required.' })
  } else if (body.title.length > POST_TITLE_MAX_LEN) {
    errors.push({ field: 'title', code: 'too_long', message: `\`title\` must be at most ${POST_TITLE_MAX_LEN} characters.` })
  } else {
    title = body.title.trim()
  }

  let summary: string | null = null
  if (body.summary != null) {
    if (typeof body.summary !== 'string') {
      errors.push({ field: 'summary', code: 'invalid', message: '`summary` must be a string.' })
    } else if (body.summary.length > POST_SUMMARY_MAX_LEN) {
      errors.push({ field: 'summary', code: 'too_long', message: `\`summary\` must be at most ${POST_SUMMARY_MAX_LEN} characters.` })
    } else {
      summary = body.summary.trim() || null
    }
  }

  let bodyMd = ''
  if (typeof body.bodyMd !== 'string' || body.bodyMd.trim().length === 0) {
    errors.push({ field: 'bodyMd', code: 'required', message: '`bodyMd` is required.' })
  } else if (body.bodyMd.length > POST_BODY_MAX_LEN) {
    errors.push({ field: 'bodyMd', code: 'too_long', message: `\`bodyMd\` must be at most ${POST_BODY_MAX_LEN} characters.` })
  } else {
    bodyMd = body.bodyMd
  }

  let datasetIds: string[] = []
  if (body.datasetIds != null) {
    if (!Array.isArray(body.datasetIds)) {
      errors.push({ field: 'datasetIds', code: 'invalid', message: '`datasetIds` must be an array of dataset ids.' })
    } else {
      datasetIds = [...new Set(body.datasetIds.filter((v): v is string => typeof v === 'string' && v.length > 0))]
      if (datasetIds.length > POST_MAX_DATASETS) {
        errors.push({ field: 'datasetIds', code: 'too_many', message: `\`datasetIds\` must have at most ${POST_MAX_DATASETS} entries.` })
      }
    }
  }

  let eventId: string | null = null
  if (body.eventId != null) {
    if (typeof body.eventId !== 'string' || body.eventId.length === 0) {
      errors.push({ field: 'eventId', code: 'invalid', message: '`eventId` must be a non-empty string.' })
    } else {
      eventId = body.eventId
    }
  }

  let tourId: string | null = null
  if (body.tourId != null) {
    // Tours mint Crockford ULIDs; reject anything else up front so a
    // garbage id can't occupy the column (a *dangling* valid id is
    // fine — the public read only surfaces playable tours).
    if (typeof body.tourId !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(body.tourId)) {
      errors.push({ field: 'tourId', code: 'invalid', message: '`tourId` must be a tour id.' })
    } else {
      tourId = body.tourId
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { title, summary, bodyMd, datasetIds, eventId, tourId } }
}

/**
 * The public-playability gate for a post's companion tour: the tours
 * row must be published, not retracted, and publicly visible — the
 * same predicate the public catalog applies. Returns the id when
 * playable, null otherwise (including dangling ids from deleted
 * tours).
 */
export async function resolvePlayableTourId(
  db: D1Database,
  tourId: string | null,
): Promise<string | null> {
  if (!tourId) return null
  const row = await db
    .prepare(
      `SELECT id FROM tours
        WHERE id = ?
          AND published_at IS NOT NULL
          AND retracted_at IS NULL
          AND visibility = 'public'
        LIMIT 1`,
    )
    .bind(tourId)
    .first<{ id: string }>()
  return row?.id ?? null
}
