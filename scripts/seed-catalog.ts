/**
 * scripts/seed-catalog.ts — local D1 seed importer.
 *
 * Reads the SOS dataset list snapshot and the enriched metadata
 * file, runs the same merge `src/services/dataService.ts` performs
 * today, and writes catalog rows into the local D1 database via
 * `better-sqlite3` against the file Wrangler maintains under
 * `.wrangler/state/v3/d1/`.
 *
 * Why direct file access:
 * - D1 local mode IS SQLite (Miniflare backs it with the same
 *   library), so writing through better-sqlite3 exercises the same
 *   storage engine the runtime queries.
 * - Hundreds of inserts run in one transaction in <1s; round-tripping
 *   each through `wrangler d1 execute` would take minutes.
 * - The seed is dev-only by design. Production seeding will be the
 *   `terraviz publish --bulk` CLI flow once Commit G lands; this
 *   script is the bridge that lets Commits B-G have data to read
 *   while the API and CLI come up.
 *
 * Behaviour:
 * - Idempotent. Reseeding wipes catalog tables (not feedback) and
 *   reinserts. ULIDs are derived deterministically from the SOS id
 *   so a reseed produces stable rows.
 * - Subsets to 20 representative datasets by default; pass `--full`
 *   for the entire ~200-row catalog.
 * - Inserts a single `node_identity` row + a single placeholder
 *   `publishers` row keyed off the seed user. Real node-key
 *   generation lands in Commit D; real Access-driven publisher
 *   provisioning lands in Commit E.
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { findCatalogD1File } from './lib/d1-local.ts'
import Database from 'better-sqlite3'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

const DATASET_LIST_PATH = resolve(REPO_ROOT, 'public/assets/sos-dataset-list.json')
const ENRICHED_PATH = resolve(REPO_ROOT, 'public/assets/sos_dataset_metadata.json')

const SUBSET_DEFAULT = 20

// --- Source-of-truth shapes (mirrors src/types/index.ts) ----------

interface RawSosEntry {
  id: string
  localizationID?: string
  organization?: string
  title: string
  abstractTxt?: string
  startTime?: string
  endTime?: string
  period?: string
  dataLink: string
  format: string
  websiteLink?: string
  legendLink?: string
  thumbnailLink?: string
  closedCaptionLink?: string
  tags?: string[]
  weight?: number
  isHidden?: boolean
  runTourOnLoad?: string
}

interface RawEnrichedEntry {
  title?: string
  description?: string
  categories?: Record<string, string[]>
  keywords?: string[]
  related_datasets?: Array<{ title: string; url: string }>
  dataset_developer?: { name?: string; affiliation_url?: string }
  vis_developer?: { name?: string; affiliation_url?: string }
  date_added?: string
  url?: string
}

// --- Helpers ------------------------------------------------------

/**
 * Mirror of `dataService.normalizeTitle`. Kept inline rather than
 * imported to keep this script free of frontend module resolution.
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s*\(movie\)\s*/g, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * ULIDs require entropy; we want determinism for reseeds. A SHA-256
 * of the SOS id, base32-encoded and truncated to 26 chars, gives a
 * ULID-shaped lexicographic-stable identifier with no time prefix.
 * Real node-published rows mint real ULIDs (Commit F).
 */
function deterministicId(prefix: string, key: string): string {
  const hash = createHash('sha256').update(`${prefix}:${key}`).digest()
  // Crockford's base32 alphabet.
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let bits = 0n
  for (const byte of hash) bits = (bits << 8n) | BigInt(byte)
  let out = ''
  for (let i = 0; i < 26; i++) {
    out = alphabet[Number(bits & 31n)] + out
    bits >>= 5n
  }
  return out
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

function now(): string {
  return new Date().toISOString()
}

/**
 * Map a SOS-format `dataLink` to a `data_ref` scheme. Vimeo URLs
 * collapse to `vimeo:<id>`; everything else passes through as
 * `url:<href>`. Phase 1b's manifest endpoint resolves both.
 */
function mapDataRef(dataLink: string): string {
  const m = dataLink.match(/vimeo\.com\/(\d+)/i)
  if (m) return `vimeo:${m[1]}`
  return `url:${dataLink}`
}

interface EnrichedRecord {
  description?: string
  categories?: Record<string, string[]>
  keywords?: string[]
  relatedDatasets?: Array<{ title: string; url: string }>
  datasetDeveloper?: { name: string; affiliationUrl?: string }
  visDeveloper?: { name: string; affiliationUrl?: string }
  catalogUrl?: string
}

function buildEnrichedMap(entries: RawEnrichedEntry[]): Map<string, EnrichedRecord> {
  const map = new Map<string, EnrichedRecord>()
  for (const e of entries) {
    if (!e.title) continue
    const r: EnrichedRecord = {}
    if (e.description) r.description = e.description
    if (e.categories && Object.keys(e.categories).length) r.categories = e.categories
    if (e.keywords?.length) r.keywords = e.keywords
    if (e.related_datasets?.length) r.relatedDatasets = e.related_datasets
    if (e.dataset_developer?.name) {
      r.datasetDeveloper = {
        name: e.dataset_developer.name,
        affiliationUrl: e.dataset_developer.affiliation_url,
      }
    }
    if (e.vis_developer?.name) {
      r.visDeveloper = {
        name: e.vis_developer.name,
        affiliationUrl: e.vis_developer.affiliation_url,
      }
    }
    if (e.url) r.catalogUrl = e.url
    map.set(normalizeTitle(e.title), r)
  }
  return map
}

// --- Main ---------------------------------------------------------

interface SeedOptions {
  full: boolean
  subset: number
}

function parseArgs(argv: string[]): SeedOptions {
  const opts: SeedOptions = { full: false, subset: SUBSET_DEFAULT }
  for (const a of argv) {
    if (a === '--full') opts.full = true
    const m = a.match(/^--subset=(\d+)$/)
    if (m) opts.subset = Number(m[1])
  }
  return opts
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T
}

function selectSubset(entries: RawSosEntry[], n: number): RawSosEntry[] {
  // Pick a representative spread: a few of each format, sorted by
  // SOS id for determinism. Avoids the "first 20 are all the same
  // category" failure mode.
  const byFormat = new Map<string, RawSosEntry[]>()
  for (const e of entries) {
    const arr = byFormat.get(e.format) ?? []
    arr.push(e)
    byFormat.set(e.format, arr)
  }
  const ordered: RawSosEntry[] = []
  const formats = [...byFormat.keys()].sort()
  let i = 0
  while (ordered.length < n) {
    const f = formats[i % formats.length]
    const bucket = byFormat.get(f)!
    if (bucket.length) ordered.push(bucket.shift()!)
    i++
    // Avoid infinite loop if we exhaust everything.
    if (formats.every(f => (byFormat.get(f) ?? []).length === 0)) break
  }
  return ordered
}

function seed(opts: SeedOptions): void {
  const sosList = readJson<{ datasets: RawSosEntry[] }>(DATASET_LIST_PATH)
  const enriched = readJson<RawEnrichedEntry[]>(ENRICHED_PATH)
  const enrichedMap = buildEnrichedMap(enriched)

  // The upstream SOS catalog has at least one duplicate id
  // (INTERNAL_SOS_766_ONLINE appears twice as of the snapshot
  // fetched on 2026-04-28). First-wins keeps reseeds deterministic.
  const seenIds = new Set<string>()
  const all = sosList.datasets.filter(e => {
    if (!e.title || !e.format || !e.dataLink) return false
    if (seenIds.has(e.id)) return false
    seenIds.add(e.id)
    return true
  })
  const selected = opts.full ? all : selectSubset(all, opts.subset)

  const dbPath = findCatalogD1File()
  if (!dbPath) {
    console.error(
      'Could not locate the local CATALOG_DB sqlite file under .wrangler/.\n' +
        'Run `npm run db:migrate` first.',
    )
    process.exit(1)
  }
  console.log(`Seeding ${selected.length} datasets into ${dbPath}`)

  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')

  // Reset only the catalog tables. Feedback tables are left alone.
  const wipe = db.transaction(() => {
    db.exec(`
      DELETE FROM dataset_related;
      DELETE FROM dataset_developers;
      DELETE FROM dataset_keywords;
      DELETE FROM dataset_categories;
      DELETE FROM dataset_tags;
      DELETE FROM dataset_renditions;
      DELETE FROM tour_dataset_refs;
      DELETE FROM tours;
      DELETE FROM datasets;
      DELETE FROM publishers;
      DELETE FROM node_identity;
      DELETE FROM audit_events;
    `)
  })
  wipe()

  const ts = now()
  const nodeId = deterministicId('node', 'dev-local')
  const publisherId = deterministicId('publisher', 'seed@localhost')

  db.prepare(
    `INSERT INTO node_identity
       (node_id, display_name, base_url, description, contact_email, public_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    nodeId,
    'Terraviz (dev)',
    'http://localhost:8788',
    'Local development node — seeded from SOS catalog snapshot.',
    'seed@localhost',
    'ed25519:placeholder-key-replaced-by-gen-node-key-script',
    ts,
  )

  db.prepare(
    `INSERT INTO publishers
       (id, email, display_name, affiliation, role, is_admin, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(publisherId, 'seed@localhost', 'Seed Publisher', null, 'staff', 1, 'active', ts)

  const insertDataset = db.prepare(`
    INSERT INTO datasets (
      id, slug, origin_node, title, abstract, organization, format, data_ref,
      thumbnail_ref, legend_ref, caption_ref, website_link,
      start_time, end_time, period, weight, visibility, is_hidden, run_tour_on_load,
      schema_version, created_at, updated_at, published_at, publisher_id
    ) VALUES (
      @id, @slug, @origin_node, @title, @abstract, @organization, @format, @data_ref,
      @thumbnail_ref, @legend_ref, @caption_ref, @website_link,
      @start_time, @end_time, @period, @weight, @visibility, @is_hidden, @run_tour_on_load,
      @schema_version, @created_at, @updated_at, @published_at, @publisher_id
    )
  `)
  const insertCategory = db.prepare(
    `INSERT OR IGNORE INTO dataset_categories (dataset_id, facet, value) VALUES (?, ?, ?)`,
  )
  const insertKeyword = db.prepare(
    `INSERT OR IGNORE INTO dataset_keywords (dataset_id, keyword) VALUES (?, ?)`,
  )
  const insertTag = db.prepare(
    `INSERT OR IGNORE INTO dataset_tags (dataset_id, tag) VALUES (?, ?)`,
  )
  const insertDeveloper = db.prepare(
    `INSERT OR IGNORE INTO dataset_developers (dataset_id, role, name, affiliation_url)
     VALUES (?, ?, ?, ?)`,
  )
  const insertRelated = db.prepare(
    `INSERT OR IGNORE INTO dataset_related (dataset_id, related_title, related_url) VALUES (?, ?, ?)`,
  )

  const usedSlugs = new Set<string>()
  function uniqueSlug(title: string): string {
    let base = slugify(title) || 'dataset'
    let candidate = base
    let n = 1
    while (usedSlugs.has(candidate)) candidate = `${base}-${++n}`
    usedSlugs.add(candidate)
    return candidate
  }

  const tx = db.transaction(() => {
    for (const e of selected) {
      const id = deterministicId('dataset', e.id)
      const enriched = enrichedMap.get(normalizeTitle(e.title))

      insertDataset.run({
        id,
        slug: uniqueSlug(e.title),
        origin_node: nodeId,
        title: e.title,
        abstract: enriched?.description ?? e.abstractTxt ?? null,
        organization: e.organization ?? null,
        format: e.format,
        data_ref: mapDataRef(e.dataLink),
        thumbnail_ref: e.thumbnailLink ?? null,
        legend_ref: e.legendLink ?? null,
        caption_ref: e.closedCaptionLink ?? null,
        website_link: e.websiteLink || null,
        start_time: e.startTime ?? null,
        end_time: e.endTime ?? null,
        period: e.period ?? null,
        weight: e.weight ?? 0,
        visibility: 'public',
        is_hidden: e.isHidden ? 1 : 0,
        run_tour_on_load: e.runTourOnLoad ?? null,
        schema_version: 1,
        created_at: ts,
        updated_at: ts,
        published_at: ts,
        publisher_id: publisherId,
      })

      if (enriched?.categories) {
        for (const [facet, values] of Object.entries(enriched.categories)) {
          for (const v of values) insertCategory.run(id, facet, v)
        }
      }
      if (enriched?.keywords) for (const k of enriched.keywords) insertKeyword.run(id, k)
      if (e.tags) for (const t of e.tags) insertTag.run(id, t)
      if (enriched?.datasetDeveloper) {
        insertDeveloper.run(
          id,
          'data',
          enriched.datasetDeveloper.name,
          enriched.datasetDeveloper.affiliationUrl ?? null,
        )
      }
      if (enriched?.visDeveloper) {
        insertDeveloper.run(
          id,
          'visualization',
          enriched.visDeveloper.name,
          enriched.visDeveloper.affiliationUrl ?? null,
        )
      }
      if (enriched?.relatedDatasets) {
        for (const r of enriched.relatedDatasets) insertRelated.run(id, r.title, r.url)
      }
    }
  })
  tx()

  const counts = {
    datasets: db.prepare('SELECT COUNT(*) AS n FROM datasets').get() as { n: number },
    categories: db.prepare('SELECT COUNT(*) AS n FROM dataset_categories').get() as { n: number },
    keywords: db.prepare('SELECT COUNT(*) AS n FROM dataset_keywords').get() as { n: number },
    developers: db.prepare('SELECT COUNT(*) AS n FROM dataset_developers').get() as { n: number },
    related: db.prepare('SELECT COUNT(*) AS n FROM dataset_related').get() as { n: number },
  }
  console.log(
    `Seeded: ${counts.datasets.n} datasets, ${counts.categories.n} categories, ` +
      `${counts.keywords.n} keywords, ${counts.developers.n} developers, ` +
      `${counts.related.n} related links`,
  )

  db.close()
}

seed(parseArgs(process.argv.slice(2)))
