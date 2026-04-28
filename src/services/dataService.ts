/**
 * Data service - fetches and manages SOS dataset metadata
 */

import axios from 'axios'
import type { Dataset, DatasetFormat, DatasetMetadata, EnrichedMetadata, TimeInfo } from '../types'
import { parseISO8601Duration } from '../utils/time'
import { logger } from '../utils/logger'
import { reportError } from '../analytics'
import { getCatalogSource } from './catalogSource'

const METADATA_URL = 'https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/dataset.json'
const ENRICHED_METADATA_URL = '/assets/sos_dataset_metadata.json'
const NODE_CATALOG_URL = '/api/v1/catalog'

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
}

/**
 * The wire shape served by `/api/v1/catalog`. Subset of the full
 * server-side `WireDataset` interface — we only declare the fields
 * we actually consume, so the frontend doesn't drift if the backend
 * adds federation-only fields later.
 */
interface WireDataset {
  id: string
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

  /**
   * Fetch all datasets. Branches on `VITE_CATALOG_SOURCE`:
   *   - `legacy`: pull from the upstream SOS S3 + enriched JSON
   *     (existing behaviour; default).
   *   - `node`: pull from this deployment's `/api/v1/catalog`.
   *
   * The two paths produce values of the same `Dataset[]` shape; the
   * sample-tour built-ins and the supported-format filter apply to
   * both so consumer code in `browseUI.ts` / `datasetLoader.ts` is
   * source-blind.
   */
  async fetchDatasets(): Promise<Dataset[]> {
    try {
      const now = Date.now()
      if (this.cache && now - this.cacheTime < this.CACHE_DURATION) {
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

      const rawDatasets = [...s3Response.data.datasets, ...sampleTourBuiltins()]

      // Filter, sort, and enrich datasets
      const datasets = rawDatasets
        .filter(d => !d.isHidden && !HIDDEN_TOUR_IDS.has(d.id) && this.isSupportedDataset(d))
        .sort((a, b) => (b.weight || 0) - (a.weight || 0))
        .map(d => this.enrichDataset(d))

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
    const res = await fetch(NODE_CATALOG_URL, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      throw new Error(`Node catalog fetch failed: ${res.status} ${res.statusText}`)
    }
    const body = (await res.json()) as { datasets: WireDataset[] }
    if (!body || !Array.isArray(body.datasets)) {
      throw new Error('Node catalog: unexpected response shape (missing datasets[]).')
    }

    const fromNode: Dataset[] = body.datasets.map(d => ({
      id: d.id,
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
    }))

    fromNode.push(...sampleTourBuiltins())

    return fromNode
      .filter(d => !d.isHidden && !HIDDEN_TOUR_IDS.has(d.id) && this.isSupportedDataset(d))
      .sort((a, b) => (b.weight || 0) - (a.weight || 0))
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
   * Build a lookup map from enriched metadata, keyed by normalized title
   */
  private buildEnrichedMap(entries: RawEnrichedEntry[]): Map<string, EnrichedMetadata> {
    const map = new Map<string, EnrichedMetadata>()

    for (const entry of entries) {
      if (!entry.title) continue

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

      const key = this.normalizeTitle(entry.title)
      map.set(key, enriched)
    }

    return map
  }

  /**
   * Try to find enriched metadata for a dataset by title matching
   */
  private enrichDataset(dataset: Dataset): Dataset {
    if (!this.enrichedMap) return dataset

    const normalized = this.normalizeTitle(dataset.title)
    const enriched = this.enrichedMap.get(normalized)

    if (enriched) {
      return { ...dataset, enriched }
    }

    return dataset
  }

  /**
   * Get a single dataset by ID
   */
  getDatasetById(id: string): Dataset | undefined {
    if (!this.cache) {
      return undefined
    }
    return this.cache.datasets.find(d => d.id === id)
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

  /** True if the dataset format is a supported image type (PNG or JPEG). */
  isImageDataset(dataset: Dataset): boolean {
    return dataset.format === 'image/png' || dataset.format === 'image/jpg' || dataset.format === 'images/jpg'
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
  }
}

export const dataService = new DataService()
