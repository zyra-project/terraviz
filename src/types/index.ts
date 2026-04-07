/**
 * Type definitions for Interactive Sphere project
 */

/**
 * Supported dataset formats
 */
export type DatasetFormat = 'video/mp4' | 'image/png' | 'image/jpg' | 'images/jpg' | 'tour/json'

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
 * Structured map view context passed to the LLM system prompt.
 */
export interface MapViewContext {
  center: { lat: number; lng: number }
  zoom: number
  bearing: number
  pitch: number
  bounds: { west: number; south: number; east: number; north: number }
  visibleCountries: string[]
  visibleOceans: string[]
}

/**
 * Lightweight handle for a video texture, used by the playback controller
 * to flag manual updates and clean up resources.
 */
export interface VideoTextureHandle {
  needsUpdate: boolean
  dispose(): void
}

/**
 * Globe renderer interface used by modules like datasetLoader that interact
 * with the MapLibre-based globe.
 */
export interface GlobeRenderer {
  updateTexture(texture: HTMLCanvasElement | HTMLImageElement): void
  setVideoTexture(video: HTMLVideoElement): VideoTextureHandle
  flyTo(lat: number, lon: number, altitude?: number): void | Promise<void>
  toggleAutoRotate(): boolean
  setLatLngCallbacks(
    onUpdate: (lat: number, lng: number) => void,
    onClear: () => void,
  ): void
  setCanvasDescription(text: string): void
  loadDefaultEarthMaterials(onProgress?: (fraction: number) => void): Promise<void>
  removeNightLights(): void
  enableSunLighting(lat: number, lng: number): void
  disableSunLighting(): void
  loadCloudOverlay(url: string, onProgress?: (fraction: number) => void): Promise<void>
  removeCloudOverlay(): void
  dispose(): void

  // Tour-specific methods (optional — checked at runtime)
  toggleLabels?(visible?: boolean): boolean
  toggleBoundaries?(visible?: boolean): boolean
  addMarker?(lat: number, lng: number, label?: string): unknown
  clearMarkers?(): void
  setRotationRate?(rate: number): void
}

/**
 * Chat message roles
 */
export type ChatRole = 'user' | 'docent'

/**
 * An action the docent can embed in a message (e.g. "Load this dataset")
 */
export type ChatAction =
  | { type: 'load-dataset'; datasetId: string; datasetTitle: string }
  | { type: 'fly-to'; lat: number; lon: number; altitude?: number }
  | { type: 'set-time'; isoDate: string }
  | { type: 'fit-bounds'; bounds: [number, number, number, number]; label?: string }
  | { type: 'add-marker'; lat: number; lng: number; label?: string }
  | { type: 'toggle-labels'; visible: boolean }
  | { type: 'highlight-region'; geojson: GeoJSON.GeoJSON; label?: string }

/**
 * Snapshot of the LLM context used to generate an AI response.
 * Attached to each docent message for RLHF / training data extraction.
 */
export interface LLMContextSnapshot {
  systemPrompt: string
  model: string
  readingLevel: ReadingLevel
  visionEnabled: boolean
  fallback: boolean
  historyCompressed: boolean
}

/**
 * A single chat message
 */
export interface ChatMessage {
  id: string
  role: ChatRole
  text: string
  actions?: ChatAction[]
  timestamp: number
  /** LLM context that produced this response (docent messages only, in-memory only) */
  llmContext?: LLMContextSnapshot
}

/**
 * Persisted chat session state (stored in sessionStorage)
 */
export interface ChatSession {
  messages: ChatMessage[]
}

/**
 * Thumbs-up or thumbs-down rating for an AI response
 */
export type FeedbackRating = 'thumbs-up' | 'thumbs-down'

/**
 * Payload submitted to the server when a user rates an AI response
 */
export interface FeedbackPayload {
  rating: FeedbackRating
  comment: string
  messageId: string
  messages: ChatMessage[]
  datasetId: string | null
  timestamp: number
  /** System prompt used for the rated message */
  systemPrompt?: string
  /** Model config at the time of the rated response */
  modelConfig?: {
    model: string
    readingLevel: ReadingLevel
    visionEnabled: boolean
  }
  /** True if the rated message came from the local engine, not the LLM */
  isFallback?: boolean
  /** The user message that prompted the rated AI response */
  userMessage?: string
  /** Zero-based index of this docent message among all docent messages */
  turnIndex?: number
  /** Whether conversation history was compressed for this turn */
  historyCompressed?: boolean
  /** Dataset IDs the user clicked to load from this message (implicit positive signal) */
  actionClicks?: string[]
  /** Quick-select feedback tags (e.g. "Wrong dataset", "Too long") */
  tags?: string[]
}

/**
 * LLM provider configuration (stored in localStorage)
 */
export type ReadingLevel = 'young-learner' | 'general' | 'in-depth' | 'expert'

export interface DocentConfig {
  apiUrl: string         // default: '/api'
  apiKey: string         // default: '' (empty = no auth, for Ollama)
  model: string          // default: 'llama-3.1-70b'
  enabled: boolean       // default: true
  readingLevel: ReadingLevel  // default: 'general'
  visionEnabled: boolean // default: false — captures globe screenshot as context
  debugPrompt?: boolean  // default: false — log full system prompt to console
}

/**
 * A single Q&A entry from the preprocessed HuggingFace knowledge base.
 * Short field names keep the JSON payload compact.
 */
export interface QAEntry {
  q: string   // prompt / question
  c: string   // completion / answer
  d?: string  // difficulty level
}

/** Title-keyed index of Q&A entries, loaded from /assets/sos_qa_pairs.json */
export type QAIndex = Record<string, QAEntry[]>

// --- Tour types ---

/** Raw tour JSON file structure */
export interface TourFile {
  tourTasks: TourTaskDef[]
}

/**
 * A single task definition from a tour JSON file.
 * Discriminated by which key is present — each object has exactly one task key.
 */
export type TourTaskDef =
  | { flyTo: FlyToTaskParams }
  | { tiltRotateCamera: TiltRotateCameraTaskParams }
  | { resetCameraZoomOut: string }
  | { resetCameraAndZoomOut: string }
  | { showRect: ShowRectTaskParams }
  | { hideRect: string }
  | { pauseForInput: string }
  | { pauseSeconds: number }
  | { pauseSec: number }
  | { loadDataset: LoadDatasetTaskParams }
  | { unloadAllDatasets: string }
  | { datasetAnimation: DatasetAnimationTaskParams }
  | { envShowDayNightLighting: 'on' | 'off' }
  | { envShowClouds: 'on' | 'off' }
  | { envShowStars: 'on' | 'off' }
  | { envShowWorldBorder: 'on' | 'off' }
  | { worldBorder: WorldBorderTaskParams }
  | { setGlobeRotationRate: number }
  | { loopToBeginning: string }
  | { enableTourPlayer: 'on' | 'off' }
  | { tourPlayerWindow: 'on' | 'off' }
  | { question: QuestionTaskParams }
  | { playAudio: PlayAudioTaskParams }
  | { stopAudio: string }
  | { playVideo: PlayVideoTaskParams }
  | { hideVideo: string }
  | { showImage: ShowImageTaskParams }
  | { hideImage: string }
  | { showPopupHtml: ShowPopupHtmlTaskParams }
  | { hidePopupHtml: string }
  | { addPlacemark: AddPlacemarkTaskParams }
  | { hidePlacemark: string }

export interface FlyToTaskParams {
  lat: number
  lon: number
  altmi: number
  animated: boolean
}

export interface ShowRectTaskParams {
  rectID: string
  caption: string
  captionPos?: 'center' | 'left' | 'right' | 'top' | 'bottom'
  captionBestFit?: boolean
  fontSize?: number
  fontColor?: string
  isClosable?: boolean
  xPct: number
  yPct: number
  widthPct: number
  heightPct: number
  showBorder?: boolean
}

export interface LoadDatasetTaskParams {
  id: string
  /** Additional SOS fields passed through but not required for the web player */
  [key: string]: unknown
}

export interface DatasetAnimationTaskParams {
  animation: 'on' | 'off'
  frameRate?: string  // e.g. "15 fps"
}

export interface QuestionTaskParams {
  id: string
  imgQuestionFilename: string
  numberOfAnswers: number
  correctAnswerIndex: number
  imgAnswerFilename: string
  xPct?: number
  yPct?: number
  widthPct?: number
  heightPct?: number
}

export interface WorldBorderTaskParams {
  worldBorders: 'on' | 'off'
  worldBorderColor?: string
}

export interface TiltRotateCameraTaskParams {
  tilt: number
  rotate: number
  animated: boolean
}

export interface PlayAudioTaskParams {
  filename: string
  asynchronous?: boolean
}

export interface PlayVideoTaskParams {
  filename: string
  xPct?: number
  yPct?: number
  sizePct?: number
  showControls?: boolean
}

export interface ShowImageTaskParams {
  imageID: string
  filename: string
  xPct?: number
  yPct?: number
  widthPct?: number
  heightPct?: number
  isAspectRatioLocked?: boolean
  isDraggable?: boolean
  isClosable?: boolean
  isResizable?: boolean
  caption?: string
  captionPos?: 'center' | 'left' | 'right' | 'top' | 'bottom'
  fontSize?: number
  fontColor?: string
}

export interface ShowPopupHtmlTaskParams {
  popupID: string
  url?: string
  html?: string
  xPct?: number
  yPct?: number
  widthPct?: number
  heightPct?: number
}

export interface AddPlacemarkTaskParams {
  placemarkID: string
  lat: number
  lon: number
  name?: string
  popupHTML?: string
  iconFilename?: string
  scale?: number
}

/** Playback state of the tour engine */
export type TourState = 'stopped' | 'playing' | 'paused'

/** Callbacks the tour engine uses to drive the app — avoids circular imports */
export interface TourCallbacks {
  loadDataset(id: string): Promise<void>
  unloadAllDatasets(): Promise<void>
  getRenderer(): GlobeRenderer
  togglePlayPause(): void
  isPlaying(): boolean
  onTourEnd(): void
  announce(message: string): void
  /** Resolve a media filename relative to the tour's base URL */
  resolveMediaUrl(filename: string): string
}

/**
 * In-memory cache for the active dataset's legend image and LLM-generated text description.
 * Populated by initLegendForDataset(); cleared by clearLegendCache() on dataset change.
 */
export interface LegendCache {
  legendBase64: string | null        // full data URL (data:<mime>;base64,...)
  legendMimeType: string | null
  legendDescription: string | null   // LLM-generated text description (non-vision fallback)
  legendDescriptionForDatasetId: string | null
}
