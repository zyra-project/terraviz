/**
 * Data service - fetches and manages SOS dataset metadata
 */

import axios from 'axios'
import type { Dataset, DatasetMetadata, EnrichedMetadata, TimeInfo } from '../types'
import { parseISO8601Duration } from '../utils/time'
import { logger } from '../utils/logger'

const METADATA_URL = 'https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/dataset.json'
const ENRICHED_METADATA_URL = '/assets/sos_dataset_metadata.json'

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
   * Fetch all datasets from SOS metadata API and enrich with local metadata
   */
  async fetchDatasets(): Promise<Dataset[]> {
    try {
      const now = Date.now()
      if (this.cache && now - this.cacheTime < this.CACHE_DURATION) {
        logger.info('[DataService] Using cached datasets')
        return this.cache.datasets
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

      // Filter, sort, and enrich datasets
      const datasets = s3Response.data.datasets
        .filter(d => !d.isHidden && this.isSupportedDataset(d))
        .sort((a, b) => (b.weight || 0) - (a.weight || 0))
        .map(d => this.enrichDataset(d))

      this.cache = { datasets }
      this.cacheTime = now

      const enrichedCount = datasets.filter(d => d.enriched).length
      logger.info(`[DataService] Loaded ${datasets.length} datasets (${enrichedCount} enriched)`)
      return datasets
    } catch (error) {
      logger.error('[DataService] Failed to fetch datasets:', error)
      throw new Error(`Failed to fetch datasets: ${error instanceof Error ? error.message : 'Unknown error'}`)
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

  /** Check whether a dataset's format is one we can render (video or image). */
  isSupportedDataset(dataset: Dataset): boolean {
    return this.isVideoDataset(dataset) || this.isImageDataset(dataset)
  }

  /** True if the dataset format is `video/mp4`. */
  isVideoDataset(dataset: Dataset): boolean {
    return dataset.format === 'video/mp4'
  }

  /** True if the dataset format is a supported image type (PNG or JPEG). */
  isImageDataset(dataset: Dataset): boolean {
    return dataset.format === 'image/png' || dataset.format === 'image/jpg' || dataset.format === 'images/jpg'
  }

  /** Invalidate the dataset cache, forcing a fresh fetch on the next call. */
  clearCache(): void {
    this.cache = null
    this.cacheTime = 0
    this.enrichedMap = null
  }
}

export const dataService = new DataService()
