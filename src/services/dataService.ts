/**
 * Data service - fetches and manages SOS dataset metadata
 */

import axios from 'axios'
import type { Dataset, DatasetFormat, DatasetMetadata, EnrichedMetadata, TimeInfo, Tour } from '../types'
import { isLiveCadence, parseISO8601Duration, safePeriodMs } from '../utils/time'
import { logger } from '../utils/logger'
import { reportError } from '../analytics'
import { apiFetch, getCatalogSource } from './catalogSource'

/** Milliseconds floor for period-driven cache expiry — even a PT15M
 *  workflow shouldn't make every page interaction re-fetch the
 *  catalog. */
const MIN_PERIOD_TTL_MS = 5 * 60 * 1000

/**
 * Phase Z4 (docs/ZYRA_INTEGRATION_PLAN.md): the catalog cache TTL,
 * given its contents. Static catalogs keep the default; when any
 * dataset carries `period` (a workflow-maintained real-time row),
 * the TTL shrinks to the shortest period present, floored at
 * 5 minutes — fresh enough to pick up the next scheduled
 * re-publish, bounded enough to not hammer the API.
 */
export function effectiveCatalogTtl(
  datasets: Dataset[],
  defaultMs: number,
  now: number = Date.now(),
): number {
  let shortest = defaultMs
  for (const dataset of datasets) {
    // Only LIVE cadences count — historical time-series rows carry
    // `period` too, and malformed periods are ignored rather than
    // thrown (PR #179 review).
    if (!isLiveCadence(dataset.period, dataset.endTime, now)) continue
    const ms = safePeriodMs(dataset.period)
    if (ms !== null && ms < shortest) shortest = ms
  }
  // Floor at 5 min, but never grow past the caller's default — the
  // helper's contract is shrink-only (PR #179 review).
  return Math.min(defaultMs, Math.max(shortest, MIN_PERIOD_TTL_MS))
}


const METADATA_URL = 'https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/dataset.json'
const ENRICHED_METADATA_URL = '/assets/sos_dataset_metadata.json'
const NODE_CATALOG_URL = '/api/v1/catalog'
const NODE_TOURS_URL = '/api/v1/tours'

/**
 * Tour datasets from the upstream SOS catalog that we suppress from the UI
 * because they use tour tasks our TourEngine doesn't implement yet (e.g.
 * 360-degree media, Unity-specific scene controls). Revisit when adding
 * support for the missing tasks.
 */
export const HIDDEN_TOUR_IDS: ReadonlySet<string> = new Set([
  'INTERNAL_SOS_687',                     // 360 Media - National Marine Sanctuaries
  'INTERNAL_SOS_HRRR_Smoke_Tour_Mobile',  // Tour - HRRR-Smoke and 2020 Fire Season
])

interface RawEnrichedEntry {
  url?: string
  title?: string
  description?: string
  categories?: Record<string, string[]>
  keywords?: string[]
  date_added?: string
  dataset_developer?: { name?: string; affiliation_url?: string }
  vis_developer?: { name?: string; affiliation_url?: string }
  related_datasets?: Array<{ title: string; url: string }>
  /** Catalog surfaces this dataset is published on — `["SOS"]`,
   *  `["Explorer"]`, or `["SOS","Explorer"]`. Phase 4 §6.4 keys
   *  the `availableFor` tag and the SOS-only synthesis path off
   *  this field. */
  available_for?: string[]
  /** Lower-fidelity preview URL — used as `dataLink` for the
   *  synthesised SOS-only datasets (§6.4). Plays back from the
   *  SOS-public CloudFront origin rather than the SOSx Vimeo HLS. */
  movie_preview?: string
  /** Thumbnail URL — used as `thumbnailLink` for synthesised
   *  SOS-only datasets. */
  thumbnail_image?: string
}

/** Synthesised dataset ID prefix for entries that exist only in the
 *  enriched metadata (SOS-only). The prefix keeps them out of the
 *  `INTERNAL_SOS_*` legacy ID space and the ULID namespace, so a
 *  malformed lookup against a synthesised ID never collides with a
 *  real catalog row. */
const SOS_ONLY_ID_PREFIX = 'SOS_ONLY_'

/** Length cap on the slug component of a synthesised SOS-only ID.
 *  Long titles get truncated to keep the deep-link URL short. The
 *  underlying title remains unique so two truncated slugs would only
 *  collide on the first 60 chars, which the title-key dedupe in
 *  {@link synthesizeSosOnlyDatasets} would have already caught. */
const SOS_ONLY_ID_SLUG_MAX = 60

/**
 * Derive a stable slug for a SOS-only dataset ID. Lowercases,
 * replaces non-alphanumeric runs with `_`, trims edge underscores,
 * caps length. The result is deterministic for a given input
 * title — Phase 4 §6.4 deep links keyed off the synthesised ID
 * stay stable across enriched-JSON reorderings or additions.
 *
 * Exported for tests.
 */
export function sosOnlyIdSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, SOS_ONLY_ID_SLUG_MAX)
}

/**
 * Derive the `availableFor` tag from an enriched entry's
 * `available_for` array. Returns `undefined` when the entry
 * lacks the field (legacy enriched data); callers default to
 * `'Explorer'` for live-catalog rows in that case.
 *
 * Exported so tests can pin the mapping without instantiating
 * the full {@link DataService}.
 */
export function deriveAvailableFor(
  available_for: string[] | undefined,
): 'Explorer' | 'SOS' | 'Both' | undefined {
  if (!available_for || available_for.length === 0) return undefined
  const sos = available_for.includes('SOS')
  const explorer = available_for.includes('Explorer')
  if (sos && explorer) return 'Both'
  if (sos) return 'SOS'
  if (explorer) return 'Explorer'
  return undefined
}

/**
 * Synthesise `Dataset` rows for entries that exist only in the
 * broader SOS catalog (the enriched metadata file) and have no
 * live-catalog counterpart. Phase 4 §6.4 from the catalog
 * features plan.
 *
 * `existingTitleKeys` is the set of normalized titles already
 * represented in the live catalog; entries with a matching key
 * are skipped so we don't duplicate the SOSx subset. Returns a
 * list of `Dataset` records suitable for merging alongside the
 * live catalog — each carries `availableFor: 'SOS'` so consumers
 * can filter them in/out independently.
 *
 * Synthesis maps:
 *
 *   movie_preview     →  dataLink
 *   thumbnail_image   →  thumbnailLink
 *   description       →  abstractTxt
 *   dataset_developer →  organization
 *   keywords          →  tags  (also via the enrichedMap)
 *   url               →  websiteLink
 *
 * Entries without a `movie_preview` URL are skipped — without a
 * playable asset there's nothing to load on click.
 *
 * `normalizeTitle` is injected so the function stays pure (no
 * implicit `this` binding) and tests can use any matching
 * normaliser.
 */
export function synthesizeSosOnlyDatasets(
  enrichedEntries: RawEnrichedEntry[],
  existingTitleKeys: ReadonlySet<string>,
  normalizeTitle: (title: string) => string,
): Dataset[] {
  const synthesized: Dataset[] = []
  // Disambiguate the rare case where two distinct titles slugify
  // to the same string (e.g. long titles that collide past the
  // 60-char cap). The title-key dedupe above catches
  // normalize-identical titles, but slugification is lossier.
  const seenSlugs = new Map<string, number>()

  for (const entry of enrichedEntries) {
    if (!entry.title || !entry.movie_preview) continue
    const availableFor = deriveAvailableFor(entry.available_for)
    // Only synthesise pure SOS-only rows — Both and Explorer
    // entries are already covered by the live catalog merge.
    if (availableFor !== 'SOS') continue

    const titleKey = normalizeTitle(entry.title)
    if (existingTitleKeys.has(titleKey)) continue

    // Stable, title-derived ID — Phase 4 §6.4 follow-up. Earlier
    // version used an iteration-order counter, which meant adding
    // a single new entry to the enriched file could shift every
    // downstream ID and break shared `?dataset=SOS_ONLY_X` links.
    const baseSlug = sosOnlyIdSlug(entry.title) || 'untitled'
    const dupeCount = seenSlugs.get(baseSlug) ?? 0
    seenSlugs.set(baseSlug, dupeCount + 1)
    const slug = dupeCount === 0 ? baseSlug : `${baseSlug}_${dupeCount + 1}`

    const dataset: Dataset = {
      id: `${SOS_ONLY_ID_PREFIX}${slug}`,
      title: entry.title,
      format: 'video/mp4',
      dataLink: entry.movie_preview,
      thumbnailLink: entry.thumbnail_image,
      abstractTxt: entry.description,
      organization: entry.dataset_developer?.name,
      tags: entry.keywords,
      websiteLink: entry.url,
      availableFor: 'SOS',
      // Worldwide bbox by default — synthesised SOS-only rows
      // have no spatial-extent source data, and the SOS catalog
      // is overwhelmingly global (see GLOBAL_BBOX docstring on
      // `wireToDataset`). Keeping the default in lockstep so
      // SPA-side `Dataset.boundingBox` is always populated.
      boundingBox: { n: 90, s: -90, w: -180, e: 180 },
      // No live-catalog provenance, no weight signal — sort to
      // the bottom of catalog-weight-ordered listings until
      // explicit relevance signals layer on.
      weight: 0,
    }
    synthesized.push(dataset)
  }

  return synthesized
}

/**
 * The wire shape served by `/api/v1/catalog`. Subset of the full
 * server-side `WireDataset` interface — we only declare the fields
 * we actually consume, so the frontend doesn't drift if the backend
 * adds federation-only fields later.
 */
interface WireDataset {
  id: string
  /** Phase 1d/T — bulk-import provenance (e.g. `INTERNAL_SOS_768`). */
  legacyId?: string
  /** Phase 3pg/C — URL-safe slug used for frame-button display naming. */
  slug?: string
  title: string
  format: string
  dataLink: string
  organization?: string
  abstractTxt?: string
  thumbnailLink?: string
  legendLink?: string
  closedCaptionLink?: string
  websiteLink?: string
  startTime?: string
  endTime?: string
  period?: string
  weight?: number
  isHidden?: boolean
  runTourOnLoad?: string
  tags?: string[]
  enriched?: EnrichedMetadata
  /**
   * Geographic bounding box (NSWE in degrees) for the dataset's
   * spatial extent. Phase 3d typed-column promotion (see the
   * backend serializer's docstring); the SPA's regional-projection
   * feature reads this at render time. Missing on rows whose
   * `bbox_*` D1 columns are NULL — `wireToDataset` defaults those
   * to worldwide so the SPA-side `Dataset.boundingBox` is always
   * populated. Phase 4 §6.9 Map view depends on every dataset
   * carrying *some* bbox so the include-global toggle has a
   * complete view of the catalog.
   */
  boundingBox?: { n: number; s: number; w: number; e: number }
  /** Celestial body the dataset visualises. Omitted == Earth.
   *  Non-Earth values (Mars / Moon / Sun / Jupiter / …) cue the
   *  SPA's Phase 3e base-texture swap. */
  celestialBody?: string
  /** Radius of the celestial body in miles, when non-Earth. */
  radiusMi?: number
  /** Globe longitude rotation reference in degrees. Omitted == 0
   *  (prime-meridian-centered); ±180 is dateline-centered (Pacific-
   *  focused datasets). */
  lonOrigin?: number
  /** Image Y-axis flip flag for datasets with inverted Y conventions.
   *  Omitted == false. */
  isFlippedInY?: boolean
  /**
   * Set by the node-catalog serializer for tour rows: the resolved
   * URL the tour engine fetches the tour document from. Bypasses
   * the manifest endpoint (which 415s tour formats). Older catalog
   * responses don't carry this field; the tour-load path falls
   * back to `dataLink`.
   */
  tourJsonUrl?: string
  /**
   * Phase 3pg/A — image-sequence frame envelope, populated only
   * for rows transcoded from a frames upload. Older clients ignore
   * this and continue to play the HLS bundle via `dataLink`.
   */
  frames?: {
    count: number
    urlTemplate: string
    framesDigest?: string
  }
}

/**
 * Map a `WireDataset` from `/api/v1/catalog` (or the token-gated
 * preview consumer) into the frontend's `Dataset` shape. The two
 * shapes are mostly the same — `WireDataset` is the additive
 * superset documented in CATALOG_BACKEND_PLAN.md — so this is a
 * field-rename layer rather than a real conversion. Kept as a
 * named helper so both the catalog fetch and the preview path
 * stay in lockstep when new wire fields land.
 */
/**
 * Default geographic bounding box for SPA-side datasets that
 * arrive on the wire without one. The SOS catalog is overwhelmingly
 * worldwide (sea surface temperature, atmospheric reanalysis,
 * satellite imagery — all global by design); only a handful of
 * regional datasets (specific hurricane basins, named-region
 * studies) carry a narrower bbox today. Defaulting to worldwide
 * at the SPA boundary makes the spatial extent explicit on every
 * `Dataset` record so the §6.9 Map view's include-global toggle
 * sees the complete catalog, rather than the ~95% of rows whose
 * `bbox_*` D1 columns are still NULL falling out of the Map
 * surface entirely.
 *
 * Publishers should set a regional bbox when applicable — the
 * default acknowledges the current data-shape reality without
 * blocking a future where bboxes are populated row-by-row.
 */
const GLOBAL_BBOX = { n: 90, s: -90, w: -180, e: 180 } as const

function wireToDataset(d: WireDataset): Dataset {
  return {
    id: d.id,
    legacyId: d.legacyId,
    slug: d.slug,
    title: d.title,
    format: d.format as DatasetFormat,
    dataLink: d.dataLink,
    organization: d.organization,
    abstractTxt: d.abstractTxt,
    thumbnailLink: d.thumbnailLink,
    legendLink: d.legendLink,
    closedCaptionLink: d.closedCaptionLink,
    websiteLink: d.websiteLink,
    startTime: d.startTime,
    endTime: d.endTime,
    period: d.period,
    weight: d.weight,
    isHidden: d.isHidden,
    runTourOnLoad: d.runTourOnLoad,
    tags: d.tags,
    enriched: d.enriched,
    // Phase 3d typed metadata — propagate boundingBox /
    // celestialBody / lonOrigin / isFlippedInY from the wire so
    // the SPA's regional-projection feature + the §6.9 Map view
    // see them. boundingBox defaults to worldwide (see
    // GLOBAL_BBOX docstring) so the Map's spatial-extent
    // surface is complete even before publishers populate the
    // D1 bbox columns.
    boundingBox: d.boundingBox ?? { ...GLOBAL_BBOX },
    celestialBody: d.celestialBody,
    lonOrigin: d.lonOrigin,
    isFlippedInY: d.isFlippedInY,
    tourJsonUrl: d.tourJsonUrl,
    frames: d.frames,
  }
}

/**
 * Error class for the SPA-side `?preview=` consumer. Carries the
 * server's typed error code (`invalid_token`, `token_id_mismatch`,
 * `not_found`, `preview_unconfigured`, …) so the caller can map
 * to a user-facing message without parsing the raw response body.
 */
export class PreviewFetchError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'PreviewFetchError'
  }
}

/**
 * Built-in tour datasets shared by the SOS-source and node-source
 * paths. Pulled out as a function so both call sites get identical
 * rows; once these are publishable as real `tours/json` rows we can
 * delete this helper.
 */
function sampleTourBuiltins(): Dataset[] {
  return [
    {
      id: 'SAMPLE_TOUR',
      title: "Climate Connections — How Earth's Systems Tell One Story",
      format: 'tour/json',
      dataLink: '/assets/test-tour.json',
      organization: 'Terraviz',
      abstractTxt:
        "An educational tour exploring how climate change shows up across Earth's systems — temperature anomalies, Arctic sea ice loss, sea level rise, ocean acidification, the carbon cycle, and global vegetation. Six datasets, one connected story.",
      tags: ['Tours'],
      weight: 50,
      thumbnailLink: '',
    },
    {
      id: 'SAMPLE_TOUR_CLIMATE_FUTURES',
      title: 'Climate Futures — Three Paths to 2100',
      format: 'tour/json',
      dataLink: '/assets/climate-futures-tour.json',
      organization: 'Terraviz',
      abstractTxt:
        "Compare three possible climate futures side by side using NOAA's SSP scenario models. Single-globe, two-globe, and four-globe layouts walk through air temperature, precipitation, sea surface temperature, and sea ice concentration across the SSP1 (Sustainability), SSP2 (Middle of the Road), and SSP5 (Fossil-fueled Development) pathways from 2015 to 2100.",
      tags: ['Tours'],
      weight: 49,
      thumbnailLink: '',
    },
  ]
}

/**
 * Phase 3pt/G follow-up — wire shape of the public tour
 * discovery endpoint (`GET /api/v1/tours`). Mirrors the
 * `Tour` UI type but uses snake_case (the server format) so
 * the conversion lives in `tourWireToDataset` alongside
 * `wireToDataset`.
 */
interface WireTour {
  id: string
  slug: string
  title: string
  description: string | null
  tour_json_url: string | null
  thumbnail_url: string | null
  visibility: string
  schema_version: number
  created_at: string
  updated_at: string
  published_at: string
  origin_node: string
}

/**
 * Phase 3pt/G follow-up — convert a publisher-portal tour into
 * the same Dataset shape `sampleTourBuiltins` produces, so the
 * Browse UI's existing `format === 'tour/json'` card path
 * surfaces them without per-surface changes. The `Tour`
 * interface is the public type a future refactor can switch
 * the UI over to once the card needs tour-specific affordances
 * (e.g. a "Tour" badge that doesn't get folded into
 * `tags: ['Tours']`).
 */
export function tourWireToDataset(t: WireTour): Dataset {
  return {
    id: t.id,
    slug: t.slug,
    title: t.title,
    format: 'tour/json',
    // `dataLink` is the legacy field; `tourJsonUrl` is the
    // tour-engine-preferred field (see `loadDataset` in
    // `datasetLoader.ts`). Set both to the same resolved URL.
    dataLink: t.tour_json_url ?? '',
    tourJsonUrl: t.tour_json_url ?? undefined,
    organization: undefined,
    abstractTxt: t.description ?? undefined,
    thumbnailLink: t.thumbnail_url ?? undefined,
    // Tag with 'Tours' so the existing browse filter chips include
    // these alongside SOS sample tours.
    tags: ['Tours'],
    // Weight 0 so SOS sample tours (weight 49-50) sort above for
    // now; once the publisher tour count grows we'll wire a
    // weight column through the publisher dock.
    weight: 0,
    isHidden: false,
  }
}

/**
 * Phase 3pt/G follow-up — convert the same wire shape into the
 * structured Tour type. Used by the docent and any future
 * tour-specific UI that needs the unflattened metadata.
 */
export function tourWireToTour(t: WireTour): Tour {
  return {
    id: t.id,
    slug: t.slug,
    title: t.title,
    description: t.description,
    tourJsonUrl: t.tour_json_url,
    thumbnailUrl: t.thumbnail_url,
    visibility: t.visibility,
    schemaVersion: t.schema_version,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    publishedAt: t.published_at,
    originNode: t.origin_node,
  }
}

/**
 * Phase 1f/L — collapse the legacy SOS catalog's non-standard
 * JPEG MIME values to the standard `image/jpeg` at the
 * source-fetch boundary. The publisher API's validator already
 * canonicalises on the way in (`functions/api/v1/_lib/validators.ts`
 * `FORMAT_VALUES`); this mirror on the read path means the SPA's
 * downstream code (logs, analytics, debugger views) only ever
 * sees one canonical JPEG value regardless of which catalog
 * source the deploy reads from. The renderer (`isImageDataset`)
 * still tolerates the legacy values as defense in depth — a
 * future fork that bypasses this normaliser keeps working
 * rather than silently dropping rows like the cutover did
 * pre-1f/K.
 */
export function normaliseSourceFormat<T extends { format?: DatasetFormat }>(d: T): T {
  if (d.format === 'image/jpg' || d.format === 'images/jpg') {
    return { ...d, format: 'image/jpeg' as DatasetFormat }
  }
  return d
}

/**
 * Fetches and caches the SOS dataset catalog, merges enriched metadata,
 * and provides lookup/filter helpers for the rest of the application.
 *
 * Use the pre-built singleton {@link dataService} rather than constructing directly.
 */
export class DataService {
  private cache: DatasetMetadata | null = null
  private cacheTime: number = 0
  private readonly CACHE_DURATION = 60 * 60 * 1000 // 1 hour
  private enrichedMap: Map<string, EnrichedMetadata> | null = null
  /** Parallel map of normalized titles → raw `available_for` array
   *  from the enriched file. Kept separate from `enrichedMap`
   *  because `EnrichedMetadata` doesn't carry the field (it's a
   *  data-source artefact, not a renderable metadata field).
   *  Phase 4 §6.4. */
  private rawAvailableForMap: Map<string, string[]> | null = null

  /**
   * Fetch all datasets. Branches on `VITE_CATALOG_SOURCE`:
   *   - `node` (default, post-1d/G cutover): pull from this
   *     deployment's `/api/v1/catalog`.
   *   - `legacy`: pull from the upstream SOS S3 + enriched JSON.
   *     Kept behind the explicit flag for the cutover stabilisation
   *     window; an operator can roll back with one env-var flip.
   *
   * The two paths produce values of the same `Dataset[]` shape; the
   * sample-tour built-ins and the supported-format filter apply to
   * both so consumer code in `browseUI.ts` / `datasetLoader.ts` is
   * source-blind.
   */
  async fetchDatasets(): Promise<Dataset[]> {
    try {
      const now = Date.now()
      // Phase Z4: a catalog containing period-bearing (real-time)
      // rows expires early — at the shortest period present,
      // floored at 5 minutes — so a workflow re-publish is picked
      // up on the next fetch instead of waiting out the full hour.
      const ttl = this.cache
        ? effectiveCatalogTtl(this.cache.datasets, this.CACHE_DURATION, now)
        : this.CACHE_DURATION
      if (this.cache && now - this.cacheTime < ttl) {
        logger.info('[DataService] Using cached datasets')
        return this.cache.datasets
      }

      const source = getCatalogSource()
      if (source === 'node') {
        const datasets = await this.fetchDatasetsFromNode()
        this.cache = { datasets }
        this.cacheTime = now
        logger.info(`[DataService] Loaded ${datasets.length} datasets from node catalog`)
        return datasets
      }

      logger.info('[DataService] Fetching datasets from SOS API...')

      // Fetch both sources in parallel
      const [s3Response, enrichedData] = await Promise.all([
        axios.get<DatasetMetadata>(METADATA_URL, {
          timeout: 10000,
          headers: { 'Accept': 'application/json' }
        }),
        this.fetchEnrichedMetadata()
      ])

      if (!s3Response.data || !s3Response.data.datasets) {
        throw new Error('Invalid response format: missing datasets array')
      }

      // Build enriched lookup map by normalized title
      this.enrichedMap = this.buildEnrichedMap(enrichedData)

      const rawDatasets = [...s3Response.data.datasets, ...sampleTourBuiltins()].map(
        normaliseSourceFormat,
      )

      // Filter, sort, and enrich datasets
      const liveDatasets = rawDatasets
        .filter(d => !d.isHidden && !HIDDEN_TOUR_IDS.has(d.id) && this.isSupportedDataset(d))
        .sort((a, b) => (b.weight || 0) - (a.weight || 0))
        .map(d => this.enrichDataset(d))

      // Phase 4 §6.4 — synthesise rows for entries that exist only
      // in the broader SOS catalog. They carry `availableFor: 'SOS'`
      // so downstream UI (Phase 4 chip rail) can filter them in/out
      // independently. The synthesis is unconditional here — gating
      // happens at the consumer (browse UI default-excludes them
      // until the toggle lands) so no user-visible regression today.
      const liveTitleKeys = new Set(liveDatasets.map(d => this.normalizeTitle(d.title)))
      const sosOnlyDatasets = this.synthesizeSosOnlyDatasets(enrichedData, liveTitleKeys)
        .map(d => this.enrichDataset(d))

      const datasets = [...liveDatasets, ...sosOnlyDatasets]

      this.cache = { datasets }
      this.cacheTime = now

      const enrichedCount = datasets.filter(d => d.enriched).length
      logger.info(`[DataService] Loaded ${datasets.length} datasets (${enrichedCount} enriched)`)
      return datasets
    } catch (error) {
      logger.warn('[DataService] Failed to fetch datasets:', error)
      reportError('download', error)
      throw new Error(`Failed to fetch datasets: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Node-mode fetch: hit this deployment's own `/api/v1/catalog`.
   *
   * The wire shape is the existing `Dataset` interface plus a few
   * additive Phase-1a fields (originNode, visibility, etc.) which
   * the frontend can ignore — the renderers only read the original
   * fields. Backend rows already merge the enriched metadata under
   * `enriched`, so no second-source lookup is needed.
   *
   * Sample tours are injected client-side so the local
   * `/assets/test-tour.json` and `/assets/climate-futures-tour.json`
   * built-ins keep working independent of whether the operator has
   * registered them in the catalog. Once Phase 1a's CLI lands those
   * tours as real `tours/json` rows, this client-side injection
   * becomes redundant; we'll remove it then.
   */
  private async fetchDatasetsFromNode(): Promise<Dataset[]> {
    logger.info('[DataService] Fetching datasets from node catalog...')
    // Fetch datasets + tours in parallel. Tours are a separate
    // public endpoint (see `functions/api/v1/tours.ts`) — the
    // catalog stays dataset-only by design so federation peers
    // can mirror each surface independently. A tours fetch
    // failure is non-fatal: browse should still render datasets
    // even if the tours endpoint is down.
    const [catalogRes, tourDatasets] = await Promise.all([
      apiFetch(NODE_CATALOG_URL, { headers: { Accept: 'application/json' } }),
      this.fetchToursFromNode(),
    ])
    if (!catalogRes.ok) {
      throw new Error(`Node catalog fetch failed: ${catalogRes.status} ${catalogRes.statusText}`)
    }
    const body = (await catalogRes.json()) as { datasets: WireDataset[] }
    if (!body || !Array.isArray(body.datasets)) {
      throw new Error('Node catalog: unexpected response shape (missing datasets[]).')
    }

    const fromNode: Dataset[] = body.datasets.map(wireToDataset)

    fromNode.push(...sampleTourBuiltins())
    fromNode.push(...tourDatasets)

    return fromNode
      .map(normaliseSourceFormat)
      .filter(d => !d.isHidden && !HIDDEN_TOUR_IDS.has(d.id) && this.isSupportedDataset(d))
      .sort((a, b) => (b.weight || 0) - (a.weight || 0))
  }

  /**
   * Phase 3pt/G follow-up — fetch the publisher-portal tours
   * from `GET /api/v1/tours` and synthesise them as
   * `format: 'tour/json'` datasets so the Browse UI's existing
   * tour-card path surfaces them without a separate render
   * pass. Returns an empty array on any fetch / parse / shape
   * failure — tours are additive discovery, not a blocker for
   * dataset browse.
   */
  private async fetchToursFromNode(): Promise<Dataset[]> {
    try {
      const res = await apiFetch(NODE_TOURS_URL, {
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) {
        logger.warn(`[DataService] /api/v1/tours returned ${res.status} ${res.statusText}`)
        return []
      }
      const body = (await res.json()) as { tours: WireTour[] }
      if (!body || !Array.isArray(body.tours)) {
        logger.warn('[DataService] /api/v1/tours: unexpected response shape')
        return []
      }
      // Phase 3pt/G follow-up — drop tours the server couldn't
      // resolve to an HTTPS URL (typically R2_PUBLIC_BASE unset
      // on the deployment). Surfacing a card the user can't
      // launch is worse UX than a missing card — the launch
      // path would call `fetch('')` and confuse on the HTML
      // response. Operators see the warning and can wire the
      // bucket up.
      const usable: WireTour[] = []
      let droppedNullUrl = 0
      for (const t of body.tours) {
        if (!t.tour_json_url) {
          droppedNullUrl++
          continue
        }
        usable.push(t)
      }
      if (droppedNullUrl > 0) {
        logger.warn(
          `[DataService] Dropped ${droppedNullUrl} publisher tour(s) with no tour_json_url ` +
            '(server could not resolve an HTTPS URL — check R2_PUBLIC_BASE).',
        )
      }
      logger.info(`[DataService] Loaded ${usable.length} publisher tours`)
      return usable.map(tourWireToDataset)
    } catch (error) {
      logger.warn('[DataService] /api/v1/tours fetch failed:', error)
      return []
    }
  }

  /**
   * Fetch the local enriched metadata file
   */
  private async fetchEnrichedMetadata(): Promise<RawEnrichedEntry[]> {
    try {
      const response = await axios.get<RawEnrichedEntry[]>(ENRICHED_METADATA_URL, {
        timeout: 5000
      })
      return response.data || []
    } catch (error) {
      logger.warn('[DataService] Could not load enriched metadata, continuing without it')
      return []
    }
  }

  /**
   * Normalize a title for fuzzy matching
   */
  private normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/\s*\(movie\)\s*/g, '')  // Strip "(movie)" suffix
      .replace(/[^\w\s]/g, '')          // Strip punctuation
      .replace(/\s+/g, ' ')            // Collapse whitespace
      .trim()
  }

  /**
   * Build a lookup map from enriched metadata, keyed by normalized
   * title. Also populates `rawAvailableForMap` so the live-catalog
   * merge can tag rows with `availableFor` without re-walking the
   * raw entries. Phase 4 §6.4.
   */
  private buildEnrichedMap(entries: RawEnrichedEntry[]): Map<string, EnrichedMetadata> {
    const map = new Map<string, EnrichedMetadata>()
    const availableForMap = new Map<string, string[]>()

    for (const entry of entries) {
      if (!entry.title) continue
      const key = this.normalizeTitle(entry.title)
      if (entry.available_for && entry.available_for.length > 0) {
        availableForMap.set(key, entry.available_for)
      }

      const enriched: EnrichedMetadata = {}

      if (entry.description) enriched.description = entry.description
      if (entry.categories && Object.keys(entry.categories).length > 0) {
        enriched.categories = entry.categories
      }
      if (entry.keywords && entry.keywords.length > 0) {
        enriched.keywords = entry.keywords
      }
      if (entry.related_datasets && entry.related_datasets.length > 0) {
        enriched.relatedDatasets = entry.related_datasets
      }
      if (entry.dataset_developer?.name) {
        enriched.datasetDeveloper = {
          name: entry.dataset_developer.name,
          affiliationUrl: entry.dataset_developer.affiliation_url
        }
      }
      if (entry.vis_developer?.name) {
        enriched.visDeveloper = {
          name: entry.vis_developer.name,
          affiliationUrl: entry.vis_developer.affiliation_url
        }
      }
      if (entry.date_added) enriched.dateAdded = entry.date_added
      if (entry.url) enriched.catalogUrl = entry.url

      map.set(key, enriched)
    }

    this.rawAvailableForMap = availableForMap
    return map
  }

  /**
   * Derive the `availableFor` tag from an enriched entry's
   * `available_for` array. Returns `undefined` when the entry
   * lacks the field (legacy enriched data); callers default to
   * `'Explorer'` for live-catalog rows in that case.
   */
  private deriveAvailableFor(
    available_for: string[] | undefined,
  ): 'Explorer' | 'SOS' | 'Both' | undefined {
    return deriveAvailableFor(available_for)
  }

  /** Internal-class shim that delegates to the module-level
   *  {@link synthesizeSosOnlyDatasets}. Kept as a method so the
   *  fetch path reads naturally; the implementation lives at
   *  module scope so tests can exercise it without standing up
   *  the whole class. */
  private synthesizeSosOnlyDatasets(
    enrichedEntries: RawEnrichedEntry[],
    existingTitleKeys: ReadonlySet<string>,
  ): Dataset[] {
    return synthesizeSosOnlyDatasets(enrichedEntries, existingTitleKeys, (title) =>
      this.normalizeTitle(title),
    )
  }

  /**
   * Try to find enriched metadata for a dataset by title matching.
   * Sets `availableFor` from the enriched lookup when the entry's
   * `available_for` array is populated, defaulting to `'Explorer'`
   * for any live-catalog row (those are SOSx-subset by definition,
   * even if the enriched data is missing). Synthesised SOS-only
   * rows set their own `availableFor` and never flow through here.
   */
  private enrichDataset(dataset: Dataset): Dataset {
    if (!this.enrichedMap) {
      return { ...dataset, availableFor: dataset.availableFor ?? 'Explorer' }
    }

    const normalized = this.normalizeTitle(dataset.title)
    const enriched = this.enrichedMap.get(normalized)
    const rawAvailableFor = this.rawAvailableForMap?.get(normalized)
    const availableFor = this.deriveAvailableFor(rawAvailableFor) ?? 'Explorer'

    if (enriched) {
      return { ...dataset, enriched, availableFor }
    }
    return { ...dataset, availableFor }
  }

  /**
   * Get a single dataset by ID. Primary match is `dataset.id` (the
   * post-cutover ULID); falls back to `dataset.legacyId` (the
   * `INTERNAL_SOS_*` id from before the SOS bulk import) so tour
   * files and other long-lived references that hard-code legacy IDs
   * keep resolving against the new ULID-keyed catalog. The fallback
   * is the operator-friendly equivalent of doing a one-off rewrite
   * of every tour file in the wild — see Phase 1d/T.
   */
  getDatasetById(id: string): Dataset | undefined {
    if (!this.cache) {
      return undefined
    }
    const direct = this.cache.datasets.find(d => d.id === id)
    if (direct) return direct
    return this.cache.datasets.find(d => d.legacyId === id)
  }

  /**
   * Extract Vimeo video ID from URL
   */
  extractVimeoId(url: string): string | null {
    const match = url.match(/vimeo\.com\/(\d+)/)
    return match ? match[1] : null
  }

  /**
   * Parse and normalize time metadata for a dataset
   */
  parseTimeMetadata(dataset: Dataset): TimeInfo {
    const timeInfo: TimeInfo = {
      hasTemporalData: false,
      displayMode: 'unknown'
    }

    if (!dataset.startTime && !dataset.endTime) {
      timeInfo.displayMode = 'static'
      return timeInfo
    }

    try {
      if (dataset.startTime) {
        timeInfo.startTime = new Date(dataset.startTime)
      }
      if (dataset.endTime) {
        timeInfo.endTime = new Date(dataset.endTime)
      }
      if (dataset.period) {
        const parsed = parseISO8601Duration(dataset.period)
        if (!(parsed instanceof Date)) {
          timeInfo.period = parsed as TimeInfo['period']
        }
      }

      if (timeInfo.startTime && timeInfo.endTime && dataset.period) {
        timeInfo.displayMode = 'temporal'
        timeInfo.hasTemporalData = true
      } else if (dataset.format === 'video/mp4' && (timeInfo.startTime || timeInfo.endTime)) {
        timeInfo.displayMode = 'temporal'
        timeInfo.hasTemporalData = true
      } else {
        timeInfo.displayMode = 'static'
      }
    } catch (error) {
      logger.warn(`[DataService] Failed to parse time metadata for ${dataset.id}:`, error)
      timeInfo.displayMode = 'unknown'
    }

    return timeInfo
  }

  /** Check whether a dataset's format is one we can render (video, image, or tour). */
  isSupportedDataset(dataset: Dataset): boolean {
    return this.isVideoDataset(dataset) || this.isImageDataset(dataset) || this.isTourDataset(dataset)
  }

  /** True if the dataset format is `video/mp4`. */
  isVideoDataset(dataset: Dataset): boolean {
    return dataset.format === 'video/mp4'
  }

  /**
   * True if the dataset format is a supported image type. The set
   * mirrors the publisher API's `FORMAT_VALUES` allow-list
   * (`functions/api/v1/_lib/validators.ts`) so anything a
   * publisher can upload, the SPA can render:
   *
   *   - `image/png`
   *   - `image/jpeg` — the standard MIME and what the publisher
   *     API canonicalises to
   *   - `image/webp` — accepted by the validator since 1c; no
   *     catalog rows use it today, but keeping the gate in sync
   *     with the validator means a future publisher uploading
   *     WebP doesn't get silently dropped from the browse list
   *     (Phase 1f/M)
   *   - `image/jpg` / `images/jpg` — legacy SOS-catalog typos.
   *     Normalised to `image/jpeg` at the source-fetch boundary
   *     by `normaliseSourceFormat` (Phase 1f/L); the renderer
   *     tolerance is defense-in-depth in case a fork bypasses
   *     the normaliser.
   *
   * Pre-Phase-1f-cleanup this function only accepted the legacy
   * typo'd values, which silently dropped every imported JPEG
   * row from the browse list — visible to operators as "the
   * catalog suddenly shrank by ~30 datasets after the cutover"
   * (1f/K).
   */
  isImageDataset(dataset: Dataset): boolean {
    return (
      dataset.format === 'image/png' ||
      dataset.format === 'image/jpeg' ||
      dataset.format === 'image/webp' ||
      dataset.format === 'image/jpg' ||
      dataset.format === 'images/jpg'
    )
  }

  /** True if the dataset format is a guided tour. */
  isTourDataset(dataset: Dataset): boolean {
    return dataset.format === 'tour/json'
  }

  /** Invalidate the dataset cache, forcing a fresh fetch on the next call. */
  clearCache(): void {
    this.cache = null
    this.cacheTime = 0
    this.enrichedMap = null
    this.rawAvailableForMap = null
  }

  /**
   * Fetch a draft (or any other unpublished) dataset via the
   * token-gated preview endpoint and map it into the frontend's
   * `Dataset` shape. The endpoint returns the same `WireDataset`
   * shape `/api/v1/catalog` does, with `dataLink` already
   * rewritten to the token-gated manifest sibling, so the rest of
   * the loader (HLS / image) consumes it unchanged.
   *
   * Throws `PreviewFetchError` for any non-2xx response so the
   * boot path can surface a typed error overlay instead of a
   * generic "failed to load".
   */
  async fetchPreviewDataset(datasetId: string, token: string): Promise<Dataset> {
    const url = `/api/v1/datasets/${encodeURIComponent(datasetId)}/preview/${encodeURIComponent(token)}`
    const res = await apiFetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) {
      let code = `http_${res.status}`
      let message = res.statusText || 'Preview fetch failed'
      try {
        const errBody = (await res.json()) as { error?: string; message?: string }
        if (errBody && typeof errBody.error === 'string') code = errBody.error
        if (errBody && typeof errBody.message === 'string') message = errBody.message
      } catch {
        // Non-JSON body — keep the http_<status> code + statusText.
      }
      throw new PreviewFetchError(code, message)
    }
    const body = (await res.json()) as { dataset: WireDataset }
    if (!body?.dataset) {
      throw new PreviewFetchError('invalid_body', 'Preview response missing dataset.')
    }
    return normaliseSourceFormat(wireToDataset(body.dataset))
  }

  /**
   * Add a dataset to the cache so subsequent `getDatasetById`
   * lookups (and the dataset loader) find it. Used by the
   * `?preview=` boot path to surface a draft alongside the
   * regular catalog without baking preview-mode awareness into
   * the loader. If a dataset with the same id is already cached,
   * it's replaced — the preview row is fresher than whatever the
   * catalog snapshot held.
   *
   * Non-mutating: we swap `this.cache.datasets` for a freshly
   * constructed array rather than `unshift`/index-assigning into
   * the existing one. `fetchDatasets` returns the cache's array
   * by reference, and `main.ts:loadDatasets` stores that reference
   * on `appState.datasets`; mutating in-place would leak the
   * draft into the public-catalog snapshot the browse panel reads.
   */
  injectDataset(dataset: Dataset): void {
    if (!this.cache) {
      this.cache = { datasets: [dataset] }
      return
    }
    const idx = this.cache.datasets.findIndex(d => d.id === dataset.id)
    if (idx >= 0) {
      const next = this.cache.datasets.slice()
      next[idx] = dataset
      this.cache.datasets = next
    } else {
      this.cache.datasets = [dataset, ...this.cache.datasets]
    }
  }
}

export const dataService = new DataService()
