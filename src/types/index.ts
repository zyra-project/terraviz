/**
 * Type definitions for Terraviz project
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
  /**
   * Bulk-import provenance set by Phase 1d's `terraviz import-snapshot`
   * to the SOS snapshot's internal id (e.g. `INTERNAL_SOS_768`).
   * `getDatasetById` falls back to matching this field when a primary
   * `id` lookup misses, so tour files and other long-lived references
   * keyed off the legacy SOS IDs continue to resolve against
   * post-cutover ULID-keyed rows.
   */
  legacyId?: string
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
  getMap?(): unknown
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
 * Kind of general feedback — bug report, feature request, or other.
 */
export type GeneralFeedbackKind = 'bug' | 'feature' | 'other'

/**
 * Payload submitted to /api/general-feedback for app-level feedback
 * (bug reports, feature requests) — distinct from per-message AI
 * response ratings which use FeedbackPayload.
 */
export interface GeneralFeedbackPayload {
  kind: GeneralFeedbackKind
  /** User-written description (required, capped server-side at 2000 chars) */
  message: string
  /** Optional email or handle for follow-up */
  contact?: string
  /** window.location.href at submit time */
  url?: string
  /** App version from build metadata */
  appVersion?: string
  /** 'web' for browser, 'desktop' for Tauri */
  platform?: 'web' | 'desktop'
  /** Currently loaded dataset ID, if any */
  datasetId?: string | null
  /** Optional base64 JPEG data URL from screenshotService */
  screenshot?: string
}

/**
 * LLM provider configuration (stored in localStorage)
 */
export type ReadingLevel = 'young-learner' | 'general' | 'in-depth' | 'expert'

export interface DocentConfig {
  apiUrl: string         // default: '/api'
  apiKey: string         // default: '' (empty = no auth, for Ollama)
  model: string          // default: 'llama-4-scout'
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
  | { envShowEarth: 'on' | 'off' }
  | { playVideo: PlayVideoTaskParams }
  | { showVideo: PlayVideoTaskParams }
  | { hideVideo: string }
  | { hidePlayVideo: string }
  | { stopVideo: string }
  | { showImage: ShowImageTaskParams }
  | { showImg: ShowImageTaskParams }
  | { hideImage: string }
  | { hideImg: string }
  | { showPopupHtml: ShowPopupHtmlTaskParams }
  | { hidePopupHtml: string }
  | { addPlacemark: AddPlacemarkTaskParams }
  | { hidePlacemark: string }
  | { setEnvView: string }
  /**
   * Unload a specific dataset by its local tour handle (the
   * `datasetID` field on the loadDataset task that introduced it).
   * Distinct from `unloadAllDatasets`, which wipes every panel.
   */
  | { unloadDataset: string }

export interface FlyToTaskParams {
  lat: number
  lon: number
  altmi: number
  animated: boolean
}

/**
 * VR-specific placement override for a tour overlay task.
 *
 * Tour overlays default to "world-anchored" in VR — they float
 * near the globe and billboard toward the user. When the global
 * preference `gazeFollowOverlays` is set, the default flips to
 * "gaze-follow" — overlays ride in front of the user's head with
 * smoothed lerp, subtitle-style.
 *
 * This optional field on each overlay task lets a tour author
 * escape the global default for a specific overlay: pin the
 * opening title in gaze-follow mode so new visitors never miss
 * it, pin a region-specific caption world-anchored near a
 * landmark, or specify a custom offset in metres when the
 * default placement collides with other scene content. When
 * absent, the manager's current default is used.
 *
 * Interpretation of `offset` is mode-specific:
 * - `world`: metres in world axes, relative to the primary globe.
 *   `(0, 0.85, 0)` places the panel directly above the globe.
 * - `gaze`: metres in camera-local axes. `+x` right, `+y` up,
 *   `-z` forward (Three.js camera convention).
 */
export interface TourOverlayAnchor {
  mode: 'world' | 'gaze'
  offset?: { x: number; y: number; z: number }
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
  /** VR-only placement override. See {@link TourOverlayAnchor}. */
  anchor?: TourOverlayAnchor
}

export interface LoadDatasetTaskParams {
  /** Catalog dataset ID (e.g. `ID_OMGMDNKQFG`). */
  id: string
  /**
   * Local handle the tour uses to refer back to this loaded dataset
   * in later tasks — typically `unloadDataset`. Scoped to the tour
   * run, not the catalog. Example: `"dataset3"`. Optional; the tour
   * engine maintains a `handle → slot` map keyed on this.
   */
  datasetID?: string
  /**
   * 1-indexed target globe (panel slot). `1` = first globe, `2` =
   * second globe, etc. Translated to a 0-indexed `slot` when routing
   * to ViewportManager. Defaults to `1` (the first globe) if omitted
   * or out of range; out-of-range values are clamped to the last
   * active panel with a warning.
   */
  worldIndex?: number
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
  /** VR-only placement override. See {@link TourOverlayAnchor}. */
  anchor?: TourOverlayAnchor
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
  /** VR-only placement override. See {@link TourOverlayAnchor}. */
  anchor?: TourOverlayAnchor
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
  /** VR-only placement override. See {@link TourOverlayAnchor}. */
  anchor?: TourOverlayAnchor
}

export interface ShowPopupHtmlTaskParams {
  popupID: string
  url?: string
  html?: string
  xPct?: number
  yPct?: number
  widthPct?: number
  heightPct?: number
  /**
   * When a `url` is supplied, opt in to running JavaScript inside the
   * sandboxed iframe. Defaults to false — only enable for trusted origins.
   */
  allowScripts?: boolean
  /** VR-only placement override. See {@link TourOverlayAnchor}. */
  anchor?: TourOverlayAnchor
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

/**
 * Internal layout identifier used by the tour callbacks. Mirrors
 * `src/services/viewportManager.ts`'s `ViewLayout` — the duplication
 * keeps the types module free of a direct service-layer import.
 */
export type TourViewLayout = '1' | '2h' | '2v' | '4'

/** Callbacks the tour engine uses to drive the app — avoids circular imports */
export interface TourCallbacks {
  /**
   * Load a dataset, optionally into a specific panel slot. The `slot`
   * parameter is 0-indexed; when omitted, the tour engine targets
   * whichever panel is currently primary (matching the existing
   * single-viewport semantics).
   */
  loadDataset(id: string, opts?: { slot?: number }): Promise<void>
  unloadAllDatasets(): Promise<void>
  /**
   * Unload the dataset in a specific slot without touching any
   * others. Used by the tour engine's `unloadDataset` task after
   * resolving a local `datasetID` handle → slot.
   */
  unloadDatasetAt(slot: number): Promise<void>
  /**
   * Switch the multi-viewport layout. Called by the tour engine's
   * `setEnvView` task after parsing the legacy view-name string.
   */
  setEnvView(opts: { layout: TourViewLayout }): Promise<void>
  getRenderer(): GlobeRenderer
  /**
   * Get every active renderer (one per viewport panel). Used by
   * environment executors (day/night, clouds, borders) that need
   * to fan out across all panels, not just the primary.
   */
  getAllRenderers(): GlobeRenderer[]
  /**
   * Return the 0-indexed slot that currently owns playback + the
   * singular UI. Used by `execLoadDataset` so tours that omit
   * `worldIndex` honor the user's current promoted panel instead
   * of always clobbering slot 0 — the bug that caused a
   * `runTourOnLoad` chained load to overwrite panel 1's dataset
   * after the user had promoted panel 2.
   */
  getPrimarySlot(): number
  togglePlayPause(): void
  isPlaying(): boolean
  setPlaybackRate(rate: number): void
  onTourEnd(): void
  /** Called when the user clicks the stop button in tour controls */
  onStop(): void
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

// ─────────────────────────────────────────────────────────────────────
// Telemetry
//
// Shape of the analytics event stream. Shared between the client
// emitter (src/analytics/) and the Pages Function at
// functions/api/ingest.ts — both sides validate against the same
// discriminated union.
//
// Design, two-tier model, wiring, and privacy posture are documented
// in docs/ANALYTICS_IMPLEMENTATION_PLAN.md and docs/PRIVACY.md.
// ─────────────────────────────────────────────────────────────────────

/** Telemetry consent level. `off` emits nothing; `essential` emits
 * Tier A events only; `research` emits A + B. User-controllable via
 * the Tools → Privacy panel. */
export type TelemetryTier = 'off' | 'essential' | 'research'

/** Persisted telemetry preferences. Stored in localStorage under
 * `sos-telemetry-config`. `sessionId` is *not* part of this shape —
 * it lives in memory only and rotates on every launch. */
export interface TelemetryConfig {
  tier: TelemetryTier
}

/** Event types that require Tier B (research). Every other event type
 * is Tier A. Kept as a const tuple so the runtime Set and the
 * compile-time `TierBEventType` literal stay in sync. */
export const TIER_B_EVENT_TYPES = [
  'dwell',
  'orbit_interaction',
  'orbit_turn',
  'orbit_tool_call',
  'orbit_load_followed',
  'orbit_correction',
  'browse_search',
  'vr_interaction',
  'error_detail',
  'tour_question_answered',
] as const
export type TierBEventType = (typeof TIER_B_EVENT_TYPES)[number]

// --- Shared enums ---

export type Platform = 'web' | 'desktop' | 'mobile'
export type OsFamily = 'mac' | 'windows' | 'linux' | 'ios' | 'android' | 'unknown'
export type ViewportClass = 'xs' | 'sm' | 'md' | 'lg' | 'xl'
/** Aspect-ratio bucket derived from `window.innerWidth / window.innerHeight`.
 * Low cardinality on purpose — exact dimensions would be a
 * fingerprinting signal. See docs/ANALYTICS_IMPLEMENTATION_PLAN.md
 * "Privacy posture". */
export type AspectClass = 'portrait-tall' | 'portrait' | 'square' | 'landscape' | 'wide' | 'ultrawide'
/** Physical-display bucket derived from `screen.width` — independent
 * from the browser viewport (which is captured by `viewport_class`). */
export type ScreenClass = 'mobile' | 'tablet' | '1080p' | '2k' | '4k+'
/** Build lineage. Server-stamped `environment` (`production` /
 * `preview` / `local`) indicates *where* the app ran; `build_channel`
 * indicates *which audience* the bundle was shipped for. An internal
 * staff build deployed to production still reports
 * `environment='production'` but `build_channel='internal'`. */
export type BuildChannel = 'public' | 'internal' | 'canary'
export type VrCapability = 'none' | 'vr' | 'ar' | 'both'
export type LayerSource = 'network' | 'cache' | 'hls' | 'image'
export type LoadTrigger = 'browse' | 'orbit' | 'tour' | 'url' | 'default'
export type UnloadReason = 'replaced' | 'home' | 'tour' | 'manual'
export type FeedbackContext = 'general' | 'ai_response'
export type FeedbackKind = 'bug' | 'feature' | 'other' | 'thumbs_up' | 'thumbs_down'
export type FeedbackStatus = 'ok' | 'error'
export type DwellTarget = `dataset:${string}` | 'chat' | 'info_panel' | 'browse' | 'tools'
export type OrbitInteractionKind = 'message_sent' | 'response_complete' | 'action_executed' | 'settings_changed'
export type TourTaskType = string // closed enum of TourTaskDef.type values; enforced at call site
export type TourOutcome = 'completed' | 'abandoned' | 'error'
export type VrMode = 'ar' | 'vr'
export type VrExitReason = 'user' | 'error' | 'session_lost'
export type VrGesture = 'drag' | 'pinch' | 'thumbstick_zoom' | 'flick_spin' | 'hud_tap'
export type ErrorCategory =
  | 'tile' | 'hls' | 'llm' | 'download' | 'vr' | 'tour'
  | 'uncaught' | 'console' | 'native_panic'
export type ErrorSource =
  | 'caught' | 'window_error' | 'unhandledrejection'
  | 'console_error' | 'console_warn' | 'tauri_panic'

// --- Base event shape ---

/** Fields every event carries. `client_offset_ms` is stamped by the
 * emitter at enqueue time (not by call sites) and measures time from
 * session start in milliseconds. */
export interface TelemetryEventBase {
  client_offset_ms?: number
}

// --- Tier A events ---

export interface SessionStartEvent extends TelemetryEventBase {
  event_type: 'session_start'
  app_version: string
  /** Shell type — `'web'` in a browser tab, `'desktop'` in the
   * Tauri desktop app, `'mobile'` in the Tauri iOS/Android app. */
  platform: Platform
  /** OS family — never version. Bucketed to six values to avoid
   * fingerprinting. */
  os: OsFamily
  locale: string
  /** Browser viewport bucket (innerWidth-derived). */
  viewport_class: ViewportClass
  /** Browser viewport aspect ratio bucket. Captures orientation
   * alongside shape — portrait phone vs ultrawide monitor etc. */
  aspect_class: AspectClass
  /** Physical-display bucket (screen.width-derived). Independent
   * from viewport because a user on a 4K monitor may resize the
   * browser to a 1080p window. */
  screen_class: ScreenClass
  /** Build audience — `'public'` unless the bundle was produced
   * with `VITE_BUILD_CHANNEL=internal` (staff dogfood) or
   * `VITE_BUILD_CHANNEL=canary` (staged rollout). */
  build_channel: BuildChannel
  vr_capable: VrCapability
  schema_version: string
  /** True when this is a re-start after the user switched telemetry
   * back on mid-app-lifetime (not a fresh app boot). */
  resumed?: boolean
}

export interface SessionEndEvent extends TelemetryEventBase {
  event_type: 'session_end'
  exit_reason: 'pagehide' | 'visibilitychange' | 'clean'
  duration_ms: number
  event_count: number
}

export interface LayerLoadedEvent extends TelemetryEventBase {
  event_type: 'layer_loaded'
  layer_id: string
  layer_source: LayerSource
  slot_index: string
  trigger: LoadTrigger
  load_ms: number
}

export interface LayerUnloadedEvent extends TelemetryEventBase {
  event_type: 'layer_unloaded'
  layer_id: string
  slot_index: string
  reason: UnloadReason
  dwell_ms: number
}

export interface FeedbackEvent extends TelemetryEventBase {
  event_type: 'feedback'
  context: FeedbackContext
  kind: FeedbackKind
  status: FeedbackStatus
  /** −1 / 0 / +1 */
  rating: -1 | 0 | 1
}

export interface CameraSettledEvent extends TelemetryEventBase {
  event_type: 'camera_settled'
  slot_index: string
  /** Projection the user was viewing when the camera settled.
   * `globe` / `mercator` are MapLibre projections; `vr` is an
   * immersive-vr session; `ar` is an immersive-ar session. VR/AR
   * events report the lat/lon under the user's gaze ray onto the
   * globe and a scale-derived `zoom`; bearing/pitch describe the
   * head-to-globe orientation. */
  projection: 'globe' | 'mercator' | 'vr' | 'ar'
  center_lat: number
  center_lon: number
  zoom: number
  bearing: number
  pitch: number
  /** Dataset currently loaded in the slot at the moment the camera
   * settled. Empty string when the panel is showing the default
   * Earth. Required and non-null so blob positions stay stable in
   * Analytics Engine — see comment on `toDataPoint`. */
  layer_id: string
}

export interface MapClickEvent extends TelemetryEventBase {
  event_type: 'map_click'
  slot_index: string
  hit_kind: 'surface' | 'marker' | 'feature' | 'region'
  /** Empty string when the click landed on a bare surface with no
   * marker / feature / region id. See `toDataPoint` for why we
   * avoid `null` on the wire. */
  hit_id: string
  lat: number
  lon: number
  zoom: number
}

export interface ViewportFocusEvent extends TelemetryEventBase {
  event_type: 'viewport_focus'
  slot_index: string
  layout: '1globe' | '2globes' | '4globes'
}

export interface LayoutChangedEvent extends TelemetryEventBase {
  event_type: 'layout_changed'
  layout: '1globe' | '2globes' | '4globes'
  trigger: 'tools' | 'tour' | 'orbit'
}

export interface PlaybackActionEvent extends TelemetryEventBase {
  event_type: 'playback_action'
  layer_id: string
  action: 'play' | 'pause' | 'seek' | 'rate'
  playback_time_s: number
  playback_rate: number
}

export interface SettingsChangedEvent extends TelemetryEventBase {
  event_type: 'settings_changed'
  key: string
  value_class: string
}

export interface BrowseOpenedEvent extends TelemetryEventBase {
  event_type: 'browse_opened'
  source: 'tools' | 'orbit' | 'shortcut'
}

export interface BrowseFilterEvent extends TelemetryEventBase {
  event_type: 'browse_filter'
  category: string
  result_count_bucket: '0' | '1-10' | '11-50' | '50+'
}

export interface TourStartedEvent extends TelemetryEventBase {
  event_type: 'tour_started'
  tour_id: string
  tour_title: string
  source: 'browse' | 'orbit' | 'deeplink'
  task_count: number
}

export interface TourTaskFiredEvent extends TelemetryEventBase {
  event_type: 'tour_task_fired'
  tour_id: string
  task_type: TourTaskType
  task_index: number
  /** Dwell time spent on the *previous* task. 0 for the first task. */
  task_dwell_ms: number
}

export interface TourPausedEvent extends TelemetryEventBase {
  event_type: 'tour_paused'
  tour_id: string
  reason: 'user' | 'pauseForInput' | 'error'
  task_index: number
}

export interface TourResumedEvent extends TelemetryEventBase {
  event_type: 'tour_resumed'
  tour_id: string
  task_index: number
  pause_ms: number
}

export interface TourEndedEvent extends TelemetryEventBase {
  event_type: 'tour_ended'
  tour_id: string
  outcome: TourOutcome
  task_index: number
  duration_ms: number
}

/**
 * Tier B — emitted when the user answers a tour quiz question.
 * Skipped questions (user navigates next/prev/stop without picking
 * an answer) do not emit; the absence of this event for a
 * `tour_task_fired(task_type='question')` in the same session is
 * itself a usable "saw it, didn't engage" signal.
 *
 * Privacy: questions are presented as static images authored into
 * the tour JSON; this event carries only integers + a stable
 * author-set `question_id`. The image filenames, the rendered
 * question/answer pixels, and any free text are never emitted.
 */
export interface TourQuestionAnsweredEvent extends TelemetryEventBase {
  event_type: 'tour_question_answered'
  tour_id: string
  /** Author-set id from `QuestionTaskParams.id`. */
  question_id: string
  /** Same task_index space as `tour_task_fired`. */
  task_index: number
  /** `numberOfAnswers` from the task definition (typically 2–4). */
  choice_count: number
  /** 0..choice_count-1 — which answer button the user clicked. */
  chosen_index: number
  /** 0..choice_count-1 — the author-defined correct answer. */
  correct_index: number
  /** Derived. Convenience field so dashboards don't need to compare
   * `chosen_index === correct_index`. */
  was_correct: boolean
  /** Wall-clock ms from question shown to button click. */
  response_ms: number
}

export interface VrSessionStartedEvent extends TelemetryEventBase {
  event_type: 'vr_session_started'
  mode: VrMode
  device_class: string
  entry_load_ms: number
  /** Dataset loaded in the primary panel at the moment the user
   * entered VR. Empty string when entering with the default Earth
   * view. Snapshot — a load that happens later in the session is
   * captured separately by the next `layer_loaded` event. */
  layer_id: string
}

export interface VrSessionEndedEvent extends TelemetryEventBase {
  event_type: 'vr_session_ended'
  mode: VrMode
  exit_reason: VrExitReason
  duration_ms: number
  /** End-of-session arithmetic mean of FPS over the whole session
   * (`total frames / wall-clock duration`). For per-window medians
   * during the session, see `perf_sample.fps_median_10s`. `0` when
   * the session was too short for a meaningful sample (< 1 s) —
   * dashboards filter `mean_fps > 0` to exclude these. */
  mean_fps: number
  /** Dataset loaded in the primary panel at the moment the session
   * ended. May differ from `vr_session_started.layer_id` if the
   * user loaded a different dataset mid-session. Empty string
   * when the session ended on the default Earth view. */
  layer_id: string
}

export interface VrPlacementEvent extends TelemetryEventBase {
  event_type: 'vr_placement'
  /** Empty string when no dataset was loaded at placement time. */
  layer_id: string
  persisted: boolean
}

export interface PerfSampleEvent extends TelemetryEventBase {
  event_type: 'perf_sample'
  surface: 'map' | 'vr'
  /** SHA-256 of WEBGL_debug_renderer_info, first 8 hex chars. */
  webgl_renderer_hash: string
  fps_median_10s: number
  frame_time_p95_ms: number
  /** `0` when `performance.memory` is unavailable (non-Chromium).
   * Dashboards filter `jsheap_mb > 0` to exclude unsupported
   * browsers from the distribution. */
  jsheap_mb: number
}

export interface ErrorEvent extends TelemetryEventBase {
  event_type: 'error'
  category: ErrorCategory
  source: ErrorSource
  /** HTTP status or classified enum value. */
  code: string
  /** Sanitized first line of the error message, <= 80 chars. URLs,
   * emails, UUIDs, digit runs and file paths stripped at the
   * sanitizer before emission. */
  message_class: string
  /** For deduped repeats of the same signature within a batch. */
  count_in_batch: number
}

// --- Tier B events ---

export interface DwellEvent extends TelemetryEventBase {
  event_type: 'dwell'
  view_target: DwellTarget
  duration_ms: number
}

export interface OrbitInteractionEvent extends TelemetryEventBase {
  event_type: 'orbit_interaction'
  interaction: OrbitInteractionKind
  subtype: string
  model: string
  /** `0` when the interaction has no measurable duration (e.g.
   * synchronous click). Dashboards filter `duration_ms > 0` to
   * isolate timed interactions. */
  duration_ms: number
  /** `0` when token counts aren't reported by the LLM provider.
   * Dashboards filter `input_tokens > 0` to scope to billable
   * traffic. */
  input_tokens: number
  output_tokens: number
}

export interface OrbitTurnEvent extends TelemetryEventBase {
  event_type: 'orbit_turn'
  turn_role: 'user' | 'assistant'
  reading_level: string
  model: string
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'error'
  turn_index: number
  duration_ms: number
  /** `0` when token counts aren't reported by the LLM provider.
   * Dashboards filter `input_tokens > 0` to scope to billable
   * traffic. */
  input_tokens: number
  output_tokens: number
  content_length: number
}

export interface OrbitToolCallEvent extends TelemetryEventBase {
  event_type: 'orbit_tool_call'
  tool: string
  result: 'ok' | 'rejected' | 'error'
  turn_index: number
  position_in_turn: number
}

export interface OrbitLoadFollowedEvent extends TelemetryEventBase {
  event_type: 'orbit_load_followed'
  dataset_id: string
  path: 'marker' | 'tool_call' | 'button_click'
  latency_ms: number
}

export interface OrbitCorrectionEvent extends TelemetryEventBase {
  event_type: 'orbit_correction'
  signal: 'thumbs_down' | 'rephrased_same_turn' | 'abandoned_turn'
  turn_index: number
}

export interface BrowseSearchEvent extends TelemetryEventBase {
  event_type: 'browse_search'
  /** Client-side SHA-256 of the lowercased query, first 12 hex. */
  query_hash: string
  result_count_bucket: '0' | '1-10' | '11-50' | '50+'
  query_length: number
}

export interface VrInteractionEvent extends TelemetryEventBase {
  event_type: 'vr_interaction'
  gesture: VrGesture
  magnitude: number
}

export interface ErrorDetailEvent extends TelemetryEventBase {
  event_type: 'error_detail'
  category: ErrorCategory
  source: ErrorSource
  message_class: string
  /** SHA-256 of normalized stack, first 12 hex. */
  stack_signature: string
  /** Sanitized stack frames — function names only, no URLs or line
   * numbers. Max 10 frames. */
  frames_json: string
  count_in_batch: number
}

/** The full discriminated event union. Add new events here, add them
 * to `TIER_B_EVENT_TYPES` if Tier B, and update the wiring table in
 * `docs/ANALYTICS_IMPLEMENTATION_PLAN.md`. */
export type TelemetryEvent =
  // Tier A
  | SessionStartEvent
  | SessionEndEvent
  | LayerLoadedEvent
  | LayerUnloadedEvent
  | FeedbackEvent
  | CameraSettledEvent
  | MapClickEvent
  | ViewportFocusEvent
  | LayoutChangedEvent
  | PlaybackActionEvent
  | SettingsChangedEvent
  | BrowseOpenedEvent
  | BrowseFilterEvent
  | TourStartedEvent
  | TourTaskFiredEvent
  | TourPausedEvent
  | TourResumedEvent
  | TourEndedEvent
  | TourQuestionAnsweredEvent
  | VrSessionStartedEvent
  | VrSessionEndedEvent
  | VrPlacementEvent
  | PerfSampleEvent
  | ErrorEvent
  // Tier B
  | DwellEvent
  | OrbitInteractionEvent
  | OrbitTurnEvent
  | OrbitToolCallEvent
  | OrbitLoadFollowedEvent
  | OrbitCorrectionEvent
  | BrowseSearchEvent
  | VrInteractionEvent
  | ErrorDetailEvent
