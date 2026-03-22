/**
 * Type definitions for Interactive Sphere project
 */

/**
 * Supported dataset formats
 */
export type DatasetFormat = 'video/mp4' | 'image/png' | 'image/jpg' | 'tour/json'

/**
 * Core dataset metadata from SOS API
 */
export interface Dataset {
  id: string
  title: string
  format: DatasetFormat
  dataLink: string
  organization?: string
  abstractTxt?: string
  thumbnailLink?: string
  legendLink?: string
  tags?: string[]
  
  // Temporal metadata
  startTime?: string  // ISO 8601
  endTime?: string    // ISO 8601
  period?: string     // ISO 8601 duration
  
  // Other metadata
  isHidden?: boolean
  weight?: number
  closedCaptionLink?: string
  websiteLink?: string
  runTourOnLoad?: string

  // Enriched metadata (from sos_dataset_metadata.json cross-reference)
  enriched?: EnrichedMetadata
}

/**
 * Rich metadata from the SOS catalog, cross-referenced by title
 */
export interface EnrichedMetadata {
  description?: string
  categories?: Record<string, string[]>
  keywords?: string[]
  relatedDatasets?: Array<{ title: string; url: string }>
  datasetDeveloper?: { name?: string; affiliationUrl?: string }
  visDeveloper?: { name?: string; affiliationUrl?: string }
  dateAdded?: string
  catalogUrl?: string
}

/**
 * Metadata for all available datasets
 */
export interface DatasetMetadata {
  datasets: Dataset[]
}

/**
 * Processed time information
 */
export interface TimeInfo {
  startTime?: Date
  endTime?: Date
  period?: {
    type: 'day' | 'week' | 'month' | 'year' | 'hour' | 'minute' | 'custom'
    days: number
  }
  hasTemporalData: boolean
  displayMode: 'temporal' | 'static' | 'unknown'
}

/**
 * Video proxy service response
 */
export interface VideoProxyResponse {
  id: string
  title: string
  duration: number
  hls: string
  dash: string
  files: Array<{
    quality: string
    width?: number
    height?: number
    size: number
    type: string
    link: string
  }>
}

/**
 * Application state
 */
export interface AppState {
  datasets: Dataset[]
  currentDataset: Dataset | null
  isLoading: boolean
  error: string | null
  timeLabel: string
  isPlaying: boolean
  currentFrame: number
  totalFrames: number
}

/**
 * Sphere rendering options
 */
export interface SphereOptions {
  radius: number
  widthSegments: number
  heightSegments: number
  texture?: HTMLCanvasElement | HTMLImageElement
}

/**
 * Controls state
 */
export interface ControlsState {
  isRotating: boolean
  autoRotate: boolean
  zoomLevel: number
}
