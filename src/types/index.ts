/**
 * Type definitions for Terraviz project
 */

/**
 * Supported dataset formats.
 *
 * The canonical set mirrors the publisher API's `FORMAT_VALUES`
 * allow-list (`functions/api/v1/_lib/validators.ts`):
 * `video/mp4`, `image/png`, `image/jpeg`, `image/webp`,
 * `tour/json`. Anything a publisher can upload, the SPA can
 * render.
 *
 * `image/jpg` and `images/jpg` are the legacy SOS-catalog typos
 * (preserved verbatim in the upstream JSON). They're normalised
 * to `image/jpeg` at the source-fetch boundary by
 * `dataService.normaliseSourceFormat` (Phase 1f/L), so post-
 * normalisation SPA code only ever sees `image/jpeg`. They stay
 * in the union as defensive types in case a fork bypasses the
 * normaliser; the renderer tolerates them too (Phase 1f/K).
 */
export type DatasetFormat =
  | 'video/mp4'
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/jpg'
  | 'images/jpg'
  | 'tour/json'

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
  /**
   * URL-safe slug (`sea-ice-extent`, `ssta`) — drives display naming
   * for the Phase 3pg image-sequence frame buttons. The catalog
   * always sets a slug; older SOS-source rows may omit it.
   */
  slug?: string
  title: string
  format: DatasetFormat
  dataLink: string
  /**
   * For `tour/json` rows: the resolved URL the tour engine fetches
   * the tour document from, bypassing the manifest endpoint
   * indirection (which only handles `video|image` manifests). Set
   * by the node-catalog serializer for tour-format rows; the
   * tour-load path prefers this field over `dataLink` when present
   * and falls back to `dataLink` for legacy SOS catalog responses
   * that don't surface it.
   */
  tourJsonUrl?: string
  organization?: string
  abstractTxt?: string
  thumbnailLink?: string
  legendLink?: string
  /** Color-ramp image used by interactive probing — distinct from
   * legendLink in ~2 of 14 rows where both are present (legendLink
   * is the UI-visible swatch, colorTableLink is the canonical
   * gradient). Phase 3b restored this from the SOS snapshot. */
  colorTableLink?: string
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

  /** Pixel-coords → data-value mapping for the color table, used
   * by SOS desktop's hover-to-probe feature. Stored as a JSON
   * object in D1 (`probing_info` column) and serialized verbatim;
   * SPA consumption is deferred to a later phase. */
  probingInfo?: ProbingInfo

  /** Geographic bounding box (NSWE in degrees) for the dataset's
   * spatial extent. Phase 3d promoted from `bounding_variables`
   * JSON to typed columns.
   *
   * **Defaults to worldwide at the SPA layer** when the wire
   * shape carries no bbox (see `wireToDataset` /
   * `synthesizeSosOnlyDatasets` in `dataService.ts`). Wire-side
   * the field is still optional — D1's `bbox_*` columns are
   * NULL for the majority of rows today — but every Dataset
   * record handed to UI code carries a populated bbox so the
   * Phase 4 §6.9 Map view can show every dataset's spatial
   * extent without a "missing" branch. Publishers should set
   * a regional bbox when applicable; the default acknowledges
   * that the SOS catalog is overwhelmingly global today.
   *
   * A worldwide box (`{n:90, s:-90, w:-180, e:180}`) is the
   * "global" sentinel the Map view's hide-globals toggle keys
   * off; the SPA's regional-projection feature also
   * short-circuits at render time when it sees worldwide. */
  boundingBox?: { n: number; s: number; w: number; e: number }

  /** Celestial body the dataset visualises. Omitted == Earth.
   * Non-Earth values (Mars / Moon / Sun / Jupiter / …) cue the
   * SPA's Phase 3e base-texture swap. */
  celestialBody?: string

  /** Radius of the celestial body in miles, when non-Earth. */
  radiusMi?: number

  /** Globe longitude rotation reference in degrees. Omitted == 0
   * (prime-meridian-centered). Non-zero values (±180 in the SOS
   * snapshot) are dateline-centered, useful for Pacific-focused
   * datasets. */
  lonOrigin?: number

  /** Image Y-axis flip flag for datasets whose imagery uses
   * inverted Y conventions. Omitted == false. */
  isFlippedInY?: boolean

  // Enriched metadata (from sos_dataset_metadata.json cross-reference)
  enriched?: EnrichedMetadata

  /**
   * Image-sequence frame envelope — set only for rows that were
   * transcoded from a frames upload (Phase 3pg/A). Carries the
   * frame count, a per-frame URL template (`{index}` is the token
   * consumers substitute with the zero-padded 5-digit frame
   * number), and the publisher-signed `framesDigest` of the
   * canonical source-filenames blob. Older clients ignore this
   * field; sequence rows still play as a regular HLS video via
   * `dataLink`.
   */
  frames?: DatasetFrames

  /**
   * Which SOS catalog surface(s) this dataset is published on.
   * Sourced from the enriched metadata's `available_for` array.
   * Phase 4 §6.4 from `docs/WEB_CATALOG_FEATURES_PLAN.md`.
   *
   * - `'Explorer'` — only in the SOSx subset (the live-catalog
   *   datasets TerraViz has always rendered).
   * - `'SOS'` — only in the broader SOS catalog. Synthesised by
   *   `dataService` from the enriched metadata file when there's
   *   no live-catalog entry to pair with; plays back at
   *   `movie_preview` quality rather than the SOSx Vimeo HLS.
   * - `'Both'` — listed on both surfaces. Live-catalog entry is
   *   the source of truth for the `dataLink`; enriched entry
   *   carries the rest.
   *
   * Set by `DataService.enrichDataset` on every live-catalog row,
   * defaulting to `'Explorer'` when no enriched match is found
   * (live catalog is SOSx-subset by definition). Synthesised SOS-
   * only rows set `'SOS'` themselves. The field is optional on the
   * type so wire-shape consumers (`WireDataset`) can elide it; in
   * the running app every row from `fetchDatasets()` has it set.
   */
  availableFor?: 'Explorer' | 'SOS' | 'Both'
}

/**
 * Image-sequence frame envelope on `Dataset` (Phase 3pg/A). Mirrors
 * `WireDatasetFrames` from `functions/api/v1/_lib/dataset-serializer.ts`.
 * Consumers compute frame N's timestamp as
 * `startTime + period × index` for time-series rows, and render
 * display names as `{slug}_{YYYYMMDDTHHMMSSZ}.{ext}` (time-series)
 * or `{slug}_frame_{NNNNN}.{ext}` (pure-sequence) — same
 * convention the `/api/v1/datasets/{id}/frames` endpoint
 * server-renders for `displayName`.
 */
export interface DatasetFrames {
  count: number
  urlTemplate: string
  framesDigest?: string
}

/** Probing metadata recovered from the SOS snapshot. Pixel
 * positions (`minPos` / `maxPos`) reference coordinates on the
 * color table image; sampling the rendered pixel and interpolating
 * between min and max gives the data value at that screen point.
 *
 * Stored on `datasets.probing_info` as a JSON-stringified blob.
 * Write-side validation (`validateJsonStringField` in
 * `functions/api/v1/_lib/validators.ts`) only confirms the value
 * is a JSON-parseable string under the 4096-char cap — it does
 * NOT enforce this specific object shape. The shape declared
 * here is documentation of the SOS snapshot's payload, not a
 * runtime contract on what consumers will see. A downstream
 * consumer should treat each field as optional and pick the
 * ones it needs.
 */
export interface ProbingInfo {
  units?: string
  minVal?: number
  maxVal?: number
  minPos?: { x?: number; y?: number; XUnits?: string; YUnits?: string }
  maxPos?: { x?: number; y?: number; XUnits?: string; YUnits?: string }
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
 * Per-dataset hints for the renderer's dataset-overlay pass. Phase
 * 3e plumbs these through from `Dataset` (which sources them from
 * the catalog row's Phase 3d metadata) into the WebGL shader so
 * regional / non-Earth / dateline-centered datasets project
 * correctly rather than stretching equirectangularly across the
 * whole sphere.
 *
 *   boundingBox    — when all four corners are present, the shader
 *                    clips the texture to this region and lets
 *                    base tiles show outside it. Omitted → full
 *                    equirectangular projection (legacy behavior).
 *   lonOrigin      — degrees offset for the U axis (default 0 →
 *                    prime-meridian centered; ±180 = dateline
 *                    centered). Applies to the full-globe path
 *                    only — see note below.
 *   isFlippedInY   — if true, the shader samples the texture with
 *                    a flipped V axis (datasets authored with
 *                    inverted-Y conventions).
 *   celestialBody  — non-Earth bodies cue the MapRenderer to swap
 *                    the base raster source and skip the Earth
 *                    4-pass effects (day/night terminator etc.,
 *                    which assume Earth's sun model).
 *
 * Every field is optional. Combinations honored: `bbox` alone,
 * `lonOrigin` alone, `isFlippedInY` with either, `celestialBody`
 * with any of the above. Combinations NOT honored: `bbox` +
 * non-zero `lonOrigin` — the shader's bbox path ignores
 * `uLonOrigin` because the texture is already remapped to the
 * bbox extent. No catalog row combines the two today; if a
 * future publisher needs both, the shader has to be extended
 * (apply `uLonOrigin` to `lon` before the bbox clip/remap)
 * rather than relying on this type to permit it. */
export interface DatasetOverlayOptions {
  boundingBox?: { n: number; s: number; w: number; e: number }
  lonOrigin?: number
  isFlippedInY?: boolean
  celestialBody?: string
}

/**
 * Globe renderer interface used by modules like datasetLoader that interact
 * with the MapLibre-based globe.
 */
export interface GlobeRenderer {
  updateTexture(texture: HTMLCanvasElement | HTMLImageElement, options?: DatasetOverlayOptions): void
  setVideoTexture(video: HTMLVideoElement, options?: DatasetOverlayOptions): VideoTextureHandle
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
  | {
      /** Seek the loaded time-enabled dataset to {@link isoDate}. */
      type: 'set-time'
      isoDate: string
      /**
       * Translated error message populated by an eager dry-check at
       * stream time — surfaces "no time-enabled dataset loaded",
       * "date out of range", etc. inline as soon as the action
       * arrives, instead of waiting for the deferred execution
       * after a load click. Renderer flips to the error styling
       * when set; otherwise shows the optimistic "Seeking to X"
       * status.
       */
      error?: string
    }
  | { type: 'fit-bounds'; bounds: [number, number, number, number]; label?: string }
  | { type: 'add-marker'; lat: number; lng: number; label?: string }
  | { type: 'toggle-labels'; visible: boolean }
  | { type: 'highlight-region'; geojson: GeoJSON.GeoJSON; label?: string }
  /**
   * Load a single frame from a Phase 3pg image-sequence dataset.
   * `frameQuery` is the verbatim payload from the LLM's
   * `<<LOAD_FRAME:DATASET_ID:query>>` marker — one of:
   *   - an ISO 8601 timestamp like `2026-05-16T12:00:00Z`,
   *   - `index=N` (zero-based, where N is in [0, frame_count)),
   *   - `latest` / `first` (resolved by the client against the
   *     dataset's `frame_count`).
   * `displayName` is the chat-UI-ready button label, derived using
   * the dataset's `slug` + the resolved frame timestamp / index.
   * Servers/clients render it consistently per the `/frames`
   * endpoint convention; clients can also compute it locally.
   */
  | {
      type: 'load-frame'
      datasetId: string
      datasetTitle: string
      frameQuery: string
      displayName: string
    }

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
  /**
   * Number of LLM round-trips this turn took. 1 for a direct
   * reply (no tool call); ≥2 when the LLM called search_datasets
   * / search_catalog / list_featured_datasets and the docent fed
   * the result back for a second round. Phase 1d/Y plumbed this
   * through so dashboards can see how often the cutover's
   * tool-calling path triggers and how that compares to the
   * pre-cutover single-round `[RELEVANT DATASETS]` injection
   * cost.
   */
  roundsCount?: number
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

/**
 * Where Orbit's voice (STT/TTS) is sourced from. `auto` resolves
 * **on-device → browser** at runtime; `cloud` is **opt-in only**
 * (deliberately excluded from `auto` because edge inference is
 * metered) and the explicit values pin a path for power users /
 * kiosk operators. See `docs/ORBIT_VOICE_PLAN.md` §4.4.
 */
export type VoiceProviderPreference = 'auto' | 'cloud' | 'local' | 'browser'

/**
 * A *concrete* voice engine backend — `VoiceProviderPreference`
 * minus the `'auto'` meta-preference. Engines declare one of these,
 * and resolved per-locale support reports one of these (or `null`).
 */
export type VoiceProvider = Exclude<VoiceProviderPreference, 'auto'>

/**
 * Realtime hands-free interaction model (Phase 3). `off` keeps the
 * Phase 1 single-tap mic; `push-to-talk` opens the mic while a control
 * is held; `open-mic` listens continuously with local VAD gating.
 * §9.1 has us ship both `push-to-talk` and `open-mic` so a real
 * install can pick. Default `off`.
 */
export type VoiceHandsFreeMode = 'off' | 'push-to-talk' | 'open-mic'

export interface DocentConfig {
  apiUrl: string         // default: '/api'
  apiKey: string         // default: '' (empty = no auth, for Ollama)
  model: string          // default: 'llama-4-scout'
  enabled: boolean       // default: true
  readingLevel: ReadingLevel  // default: 'general'
  visionEnabled: boolean // default: false — captures globe screenshot as context
  debugPrompt?: boolean  // default: false — log full system prompt to console
  // --- Voice (Orbit Voice Plan, Phase 1). All optional; auto-speak
  // defaults off so typed chat is byte-for-byte unchanged when unused.
  // Mic visibility is capability-gated (STT support for the active
  // locale), not a stored toggle. ---
  voiceAutoSpeak?: boolean          // auto-read replies via TTS; default false (§8 decision 1)
  voiceProvider?: VoiceProviderPreference // default 'auto'
  voiceLang?: string                // BCP-47 override; default = active UI locale
  voiceName?: string                // specific TTS voice id (provider-scoped)
  voiceRate?: number                // TTS speaking rate (0.5–2); default 1
  voiceHandsFree?: VoiceHandsFreeMode // realtime hands-free mode; default 'off' (Phase 3)
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

/**
 * A tour from the public discovery surface
 * (`GET /api/v1/tours`). Distinct from `Dataset` because tours
 * have less metadata (no temporal range, no organization, no
 * bounding box) and they launch into a different code path
 * (`tourEngine`) than dataset cards do.
 *
 * The Phase 1a workaround surfaced legacy SOS tours as datasets
 * with `format: 'tour/json'`. New-style tours (from the
 * publisher dock) flow through this type instead — the SPA
 * normalises both into the same browse card list at render
 * time.
 */
export interface Tour {
  id: string
  slug: string
  title: string
  description: string | null
  /** Resolved HTTPS URL the tour engine fetches. May be null
   * when the server can't render an R2 URL (R2_PUBLIC_BASE
   * unset on the deployment). The SPA's `dataService` filters
   * unresolvable tours out of the browse list — a launchable
   * card with no fetchable JSON is worse UX than no card. The
   * field stays nullable here because it reflects the wire
   * shape; consumers that synthesise a `Tour` from a known-
   * usable source can assert non-null. */
  tourJsonUrl: string | null
  thumbnailUrl: string | null
  visibility: string
  schemaVersion: number
  createdAt: string
  updatedAt: string
  publishedAt: string
  originNode: string
}

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
  'catalog_graph_node_clicked',
  'catalog_timeline_brush_applied',
  'catalog_map_region_drawn',
  'vr_interaction',
  'error_detail',
  'tour_question_answered',
  'publisher_validation_failed',
  'voice_interaction',
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
/** Specular-strength presets surfaced in Tools → Display (§7.2). */
export type SpecularPreset = 'none' | 'default' | 'comfortable'
export type ErrorCategory =
  | 'tile' | 'hls' | 'llm' | 'download' | 'vr' | 'tour' | 'caption'
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
  /** Page-visible wall-clock ms — the idle-tab-aware view time.
   * Accumulated across `visibilitychange` transitions, so a tab
   * opened in the background reports ~0 while `duration_ms` keeps
   * counting. Field name chosen to sort after `event_count`
   * alphabetically so existing AE double positions stay stable
   * (the ANALYTICS_CONTRIBUTING.md positional rule); rows from
   * clients predating this field read back as 0 = unknown. */
  visible_ms: number
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

/**
 * Catalog view-mode toggle (Phase 4 §6.7+). Fires when the user
 * switches the browse overlay between the card grid, the network
 * graph, the upcoming Timeline view (§6.8), and the upcoming Map
 * view (§6.9). Tier A — the choice is a pure UI preference and
 * carries no free-text payload. `from` records what the user just
 * came from so the dashboard can read both stickiness and
 * direction of pivots.
 */
export interface CatalogViewModeChangedEvent extends TelemetryEventBase {
  event_type: 'catalog_view_mode_changed'
  view_mode: 'cards' | 'graph' | 'timeline' | 'map'
  from: 'cards' | 'graph' | 'timeline' | 'map'
  /** Bucketed dataset count visible at the moment of toggle — useful
   *  for "did the user pivot to Graph because Cards was overwhelming?". */
  result_count_bucket: '0' | '1-10' | '11-50' | '50+'
}

export interface TourStartedEvent extends TelemetryEventBase {
  event_type: 'tour_started'
  tour_id: string
  tour_title: string
  /** `'auto'` marks tours auto-started by `dataset.runTourOnLoad`
   * (no user intent). Funnel/completion analytics exclude these so
   * the rate reflects deliberately-started tours only. */
  source: 'browse' | 'orbit' | 'deeplink' | 'auto'
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
  /** True when the matching `tour_started` was `source: 'auto'`
   * (a `runTourOnLoad` auto-tour). Lets the export job exclude
   * auto-tours from completion-rate rollups without joining back
   * to `tour_started`. Alphabetically last, so it appends to the
   * positional layout without shifting existing fields. */
  was_auto: boolean
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

/** Outcome of a single row in the `terraviz migrate-r2-hls`
 * pump. Mirrors the `MigrationOutcome` string-union type alias
 * exported from `cli/migrate-r2-hls.ts`; keep these in sync. */
export type MigrationR2HlsOutcome =
  | 'ok'
  | 'vimeo_fetch_failed'
  | 'encode_failed'
  | 'r2_upload_failed'
  | 'data_ref_patch_failed'

/**
 * Operator-facing migration progress event. Emitted once per
 * dataset row by `terraviz migrate-r2-hls` (Phase 3 commit C).
 * One-shot — migration runs are operator-driven, not user
 * sessions, so throttling is not needed.
 *
 * Consumed by the Grafana product-health migration row (commit
 * 3/G). Three panels: per-day runs by outcome, cumulative count
 * of `outcome='ok'` rows, and a failure breakdown table. The
 * operator already knows the original vimeo: row count (~136 at
 * Phase 3 cut-over) so the cumulative-ok stat is the headline —
 * it should land at the original total once the migration is
 * complete.
 *
 * No free-text fields — every field is a stable identifier or
 * scalar. `dataset_id` / `legacy_id` / `vimeo_id` / `r2_key`
 * are public catalog identifiers (the same values the catalog
 * manifest endpoint exposes), so no hashing is required.
 */
export interface MigrationR2HlsEvent extends TelemetryEventBase {
  event_type: 'migration_r2_hls'
  /** Catalog dataset id (`DS<ulid>`) the migration targeted. */
  dataset_id: string
  /** Idempotency key from the original SOS import (e.g.
   * `INTERNAL_SOS_768`); empty string when the row has no
   * legacy_id. */
  legacy_id: string
  /** Source Vimeo numeric id (the value half of `vimeo:<id>`). */
  vimeo_id: string
  /** Resulting R2 master playlist key (e.g.
   * `videos/<id>/master.m3u8`); empty string when the upload
   * didn't reach completion. Captured even on
   * `data_ref_patch_failed` so an orphan bundle is recoverable
   * from the telemetry log via `terraviz rollback-r2-hls`. */
  r2_key: string
  /** Advertised source MP4 size in bytes, or 0 if unknown. */
  source_bytes: number
  /** Total bytes uploaded to R2 across all files in the bundle;
   * 0 when the upload didn't complete. */
  bundle_bytes: number
  /** ffmpeg wall-clock encode duration in ms; 0 when the encode
   * didn't run. */
  encode_duration_ms: number
  /** R2 upload wall-clock duration in ms; 0 when the upload
   * didn't run. */
  upload_duration_ms: number
  /** Overall per-row wall-clock duration in ms (resolve +
   * encode + upload + patch). */
  duration_ms: number
  /** Per-row outcome. See `MigrationR2HlsOutcome`. */
  outcome: MigrationR2HlsOutcome
}

/** Outcome of a single asset migration in
 * `terraviz migrate-r2-assets`. Mirrors the `AssetOutcome`
 * string-union type alias exported from
 * `cli/migrate-r2-assets.ts`; keep these in sync. */
export type MigrationR2AssetsOutcome =
  | 'ok'
  | 'fetch_failed'
  | 'upload_failed'
  | 'patch_failed'

/** Which auxiliary asset the migration event describes. Mirrors
 * the `AssetType` string-union from `cli/migrate-r2-assets.ts`. */
export type MigrationR2AssetsType = 'thumbnail' | 'legend' | 'caption' | 'color_table'

/**
 * Operator-facing asset-migration progress event. Emitted once
 * per attempted asset migration by `terraviz migrate-r2-assets`
 * (Phase 3b commit G). One event per (row, asset_type) pair —
 * a row migrating thumbnail + legend produces two events.
 *
 * Distinguished from `migration_r2_hls` (Phase 3): that pump
 * handles the video `data_ref` (one event per row), this one
 * handles the auxiliary asset columns (one event per asset, up
 * to 4 per row).
 *
 * Consumed by a Grafana asset-migration row (Phase 3b commit J).
 *
 * No free-text fields — `dataset_id` / `legacy_id` / `r2_key` /
 * `source_url` are public catalog references; `asset_type` /
 * `outcome` are enums. No hashing required.
 */
export interface MigrationR2AssetsEvent extends TelemetryEventBase {
  event_type: 'migration_r2_assets'
  /** Catalog dataset id (`DS<ulid>`) the migration targeted. */
  dataset_id: string
  /** Idempotency key from the original SOS import (e.g.
   * `INTERNAL_SOS_768`); empty string when the row has no
   * legacy_id. */
  legacy_id: string
  /** Which asset column on the row this event describes. */
  asset_type: MigrationR2AssetsType
  /** Upstream URL the asset was fetched from (the value of the
   * row's `<asset>_ref` column at run time). Public catalog
   * data — same URLs the SPA renders today. */
  source_url: string
  /** Resulting R2 key (e.g. `datasets/<id>/thumbnail.png`).
   * Empty string when the migration didn't reach the PUT step.
   * Captured even on `patch_failed` so orphan objects are
   * recoverable via `terraviz rollback-r2-assets`. */
  r2_key: string
  /** Bytes received from the upstream fetch; 0 when the fetch
   * didn't complete. */
  source_bytes: number
  /** Per-asset wall-clock duration in ms (fetch + optional
   * SRT→VTT conversion + upload). Does NOT include the row-level
   * PATCH — that's tallied once per row even though it
   * influences every asset's final outcome. */
  duration_ms: number
  /** Per-asset outcome. See `MigrationR2AssetsOutcome`. */
  outcome: MigrationR2AssetsOutcome
}

/** Outcome of a single tour migration in
 * `terraviz migrate-r2-tours` (Phase 3c commit B). Mirrors the
 * `TourOutcome` string-union exported from
 * `cli/migrate-r2-tours.ts`; keep these in sync.
 *
 *   ok                   — tour.json + every sibling uploaded,
 *                          row PATCHed.
 *   dead_source          — upstream tour.json returned 404. The
 *                          row was already broken pre-migration;
 *                          NOT counted as a failure. (One known
 *                          case at the Phase 3c cut-over:
 *                          INTERNAL_SOS_726_ONLINE.)
 *   fetch_failed         — upstream tour.json fetch failed for
 *                          any reason other than 404.
 *   parse_failed         — tour.json bytes didn't decode as JSON.
 *   sibling_fetch_failed — at least one relative sibling asset
 *                          (audio/overlay/360-pano) failed to
 *                          fetch. The row's tour.json is NOT
 *                          uploaded in this case — atomic per
 *                          row.
 *   upload_failed        — an R2 PUT failed mid-row (tour.json
 *                          or sibling). Partial uploads are R2
 *                          orphans; the row still points at NOAA.
 *   patch_failed         — every R2 PUT succeeded but the D1
 *                          PATCH on `run_tour_on_load` failed.
 *                          Worst case: all R2 objects are
 *                          orphans AND the row still points at
 *                          NOAA. Recovery: re-run (idempotent —
 *                          same bytes, same keys). */
export type MigrationR2ToursOutcome =
  | 'ok'
  | 'dead_source'
  | 'fetch_failed'
  | 'parse_failed'
  | 'sibling_fetch_failed'
  | 'upload_failed'
  | 'patch_failed'

/**
 * Operator-facing tour-migration progress event. Emitted once
 * per row by `terraviz migrate-r2-tours` (Phase 3c commit B) —
 * one event per dataset whose `run_tour_on_load` was migrated
 * (or attempted). Distinct from `migration_r2_assets` (3b):
 * that one fires per (row, asset_type) pair because auxiliary
 * assets are independently consumable; a tour is a single
 * atomic resource (tour.json + sibling assets must all migrate
 * together to keep playback working), so the event roll-up is
 * per-row.
 *
 * Consumed by a Grafana tour-migration row (Phase 3c commit F).
 *
 * No free-text fields — `dataset_id` / `legacy_id` / `r2_key` /
 * `source_url` are public catalog references; `outcome` is an
 * enum. Sibling counts are integers. No hashing required.
 */
export interface MigrationR2ToursEvent extends TelemetryEventBase {
  event_type: 'migration_r2_tours'
  /** Catalog dataset id (`DS<ulid>`) the migration targeted. */
  dataset_id: string
  /** Idempotency key from the original SOS import (e.g.
   * `INTERNAL_SOS_MARIA_360`); empty string when the row has
   * no legacy_id. */
  legacy_id: string
  /** Upstream tour.json URL the migration fetched from (the
   * value of the row's `run_tour_on_load` column at run time).
   * Public catalog data — same URLs the SPA loads today. */
  source_url: string
  /** Resulting R2 key for tour.json (e.g.
   * `tours/<id>/tour.json`). Empty string when the migration
   * didn't reach the PUT step. */
  r2_key: string
  /** Bytes received from the upstream fetches — tour.json plus
   * every sibling actually fetched (including any fetched
   * before a partial-row failure). */
  source_bytes: number
  /** Count of `relative` siblings the parser discovered in this
   * tour.json. The migration target — these get fetched +
   * uploaded. */
  siblings_relative: number
  /** Count of `absolute_external` siblings (YouTube embeds,
   * Vimeo URLs, popup web links) the parser surfaced. Left
   * verbatim per Phase 3c policy 1; counted here so dashboards
   * can size the residual external-CDN dependency. */
  siblings_external: number
  /** Count of `absolute_sos_cdn` siblings (NOAA CloudFront /
   * s3.amazonaws.com URLs that bypassed the sibling-relative
   * convention). Left verbatim; counted as a residual noaa.gov
   * dependency signal. */
  siblings_sos_cdn: number
  /** Count of unique sibling-keys actually uploaded to R2 this
   * row. Equal to the dedupe'd count of `siblings_relative`
   * for an `ok` row; less on partial / failed rows. */
  siblings_migrated: number
  /** Per-row wall-clock duration in ms (tour.json fetch + every
   * sibling fetch + every R2 PUT + the row's D1 PATCH). */
  duration_ms: number
  /** Per-row outcome. See `MigrationR2ToursOutcome`. */
  outcome: MigrationR2ToursOutcome
}

/**
 * Publisher portal mounted at a route. One emit per portal-chunk
 * load — the publisher visits `/publish/*`, the lazy chunk
 * resolves, the router dispatches its first route, this fires.
 * Subsequent in-portal navigation is *not* counted as another
 * portal load (that's what `publisher_action` and the `dwell`
 * tracker on portal surfaces are for).
 *
 * Operator-facing metric: how often does anyone actually use the
 * portal? Useful for the "is this surface worth more
 * investment?" question once Phase 3 has shipped.
 */
export interface PublisherPortalLoadedEvent extends TelemetryEventBase {
  event_type: 'publisher_portal_loaded'
  /** Which section the publisher landed on. `unknown` covers
   * routes the publisher portal doesn't define (typo'd URLs,
   * stale bookmarks); the router's notFound handler still emits
   * this event because the visit counts toward portal usage. */
  route:
    | 'me'
    | 'datasets'
    | 'tours'
    | 'featured_hero'
    | 'import'
    | 'workflows'
    | 'analytics'
    | 'feedback'
    | 'users'
    | 'unknown'
}

/**
 * A publisher-initiated write action completed. The
 * server-side `audit_events` row remains the source of truth for
 * who-did-what-when; this Tier-A event powers the operator
 * dashboard ("how many drafts saved today?") without persisting
 * publisher identity client-side. The `dataset_id` is hashed via
 * `src/analytics/hash.ts` so the dashboard can count unique
 * datasets without storing their identifiers in Analytics
 * Engine.
 *
 * Most action kinds (`draft_saved`, `published`, `retracted`,
 * `preview_minted`, `asset_uploaded`, `bulk_imported`) land in
 * later sub-phases — 3pc through 3pf. The type is defined now so
 * the emit-call signature is locked before downstream code
 * starts calling it.
 */
export interface PublisherActionEvent extends TelemetryEventBase {
  event_type: 'publisher_action'
  action:
    | 'draft_saved'
    | 'published'
    | 'retracted'
    | 'preview_minted'
    | 'asset_uploaded'
    | 'bulk_imported'
  /** 12-hex SHA-256 of the dataset ULID (via `analytics/hash.ts`),
   * or `''` for actions where no specific dataset applies
   * (`bulk_imported` operates on many rows at once). */
  dataset_id: string
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
  /**
   * Number of LLM round-trips this turn took. 1 for a direct
   * reply (no tool call); ≥2 when discovery tools fired and the
   * docent fed results back for another round. Useful for
   * monitoring per-turn cost shifts (Phase 1d/F replaced the
   * single-round pre-search injection with a tool-calling path
   * that can take 2+ rounds for tool-using turns). 0 / unset on
   * the user-side `orbit_turn` and on assistant emits from
   * pre-1d/Y clients.
   *
   * Field name chosen so it sorts after `turn_index`
   * alphabetically, preserving the existing AE blob/double
   * positions per the ANALYTICS_CONTRIBUTING.md positional rule.
   */
  turn_rounds?: number
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

/**
 * Catalog Graph view node interaction (Phase 4 §6.7). Fires when
 * the user clicks a node in the Graph view. Tier B — node values
 * (Category names, keyword values, dataset IDs) are free-text by
 * the privacy posture's definition, so `value_hash` carries a
 * SHA-256 prefix rather than the value itself. Throttled to
 * ≤30/min via the same rolling-window pattern as `camera_settled`
 * so an aggressive panning session can't flood the queue.
 *
 * `node_kind` and `facet` are low-cardinality enums (3 × ~10
 * facets) so they're safe to emit verbatim — they tell the
 * dashboard "user clicked a Category facet-value node" without
 * revealing which one.
 */
export interface CatalogGraphNodeClickedEvent extends TelemetryEventBase {
  event_type: 'catalog_graph_node_clicked'
  node_kind: 'facet-value' | 'keyword' | 'dataset'
  /** Facet name for facet-value nodes; `'keyword'` for keyword
   *  nodes; `''` for dataset nodes. */
  facet: string
  /** First 12 hex of SHA-256 of the lowercased value (facet value /
   *  keyword / dataset id). Privacy-friendly count of distinct
   *  clicks without exposing the value itself. */
  value_hash: string
}

/**
 * Catalog Timeline view brush gesture (Phase 4 §6.8). Fires when
 * the user commits a brush selection on the time axis, which
 * writes a `dataCoverageYear` range predicate via the same
 * `setFacet` mutation path the chip rail's range inputs use.
 * Tier B because — like Graph node clicks — it captures a
 * filter-shaping signal that's deeper than the chip rail's
 * coarse "user filtered" event, and the dashboard's question
 * here is investigative ("which date ranges do users actually
 * brush?") rather than operator-critical.
 *
 * Throttled to ≤30 / minute per session by the rolling-window
 * pattern in `src/analytics/camera.ts`, same shared budget as
 * `catalog_graph_node_clicked`. Payload is integers only — the
 * brush carries no free text, so no `*_hash` field is needed.
 */
export interface CatalogTimelineBrushAppliedEvent extends TelemetryEventBase {
  event_type: 'catalog_timeline_brush_applied'
  /** Inclusive start year of the brushed range. */
  start_year: number
  /** Inclusive end year of the brushed range. */
  end_year: number
}

/**
 * Catalog Map view draw-rectangle gesture (Phase 4 §6.9). Fires
 * when the user commits a region selection on the mercator map,
 * which writes a `geographicRegion` bbox predicate via the same
 * `setFacet` mutation path the chip rail's range inputs and the
 * Timeline brush both use. Tier B because — like the Graph node
 * click and the Timeline brush — it captures a filter-shaping
 * signal deeper than the chip rail's coarse "user filtered" event,
 * and the dashboard's question here is investigative ("which
 * regions do users actually draw?") rather than operator-critical.
 *
 * Throttled to ≤30 / minute per session by the rolling-window
 * pattern in `src/analytics/camera.ts`, same shared budget as
 * `catalog_graph_node_clicked` and `catalog_timeline_brush_applied`.
 * Bounds round to 3 decimals (~111 m at the equator) — same
 * precision `camera.ts` uses for lat/lon — so the analytics
 * surface never leaks high-resolution drag positions.
 */
export interface CatalogMapRegionDrawnEvent extends TelemetryEventBase {
  event_type: 'catalog_map_region_drawn'
  /** Northernmost latitude of the drawn region, in degrees. */
  north: number
  /** Southernmost latitude of the drawn region, in degrees. */
  south: number
  /** Easternmost longitude of the drawn region, in degrees. */
  east: number
  /** Westernmost longitude of the drawn region, in degrees. */
  west: number
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

/**
 * A publisher hit a server-side validation error on a write
 * attempt. Tier B because the dashboard's question is "which
 * validators trip publishers most often?" — that's an investigative
 * signal, not an operator-critical one, and the free-text values
 * we'd want to inspect (slug, title, abstract) cannot ship to AE
 * under our privacy invariants.
 *
 * Wire-up lands in 3pc when the entry form first hits the
 * server-side validators. The type is defined here so the emit
 * shape is locked in advance.
 */
export interface PublisherValidationFailedEvent extends TelemetryEventBase {
  event_type: 'publisher_validation_failed'
  /** Dot-path of the field that failed (e.g., `slug`,
   * `developers.0.affiliation_url`). Server returns this in its
   * `{errors: [{field, code, message}]}` envelope. */
  field: string
  /** Machine-readable error code (e.g., `slug_too_short`,
   * `mime_not_allowed`). Server returns this; no free text. */
  code: string
}

/**
 * One voice (STT or TTS) interaction. Tier B: a research signal for
 * how Orbit's voice is used (provider / language / success / latency),
 * not an operator-critical metric. Privacy: **no transcript text and
 * no audio ever** — only the bucketed fields below; the spoken/heard
 * content never leaves the device through telemetry.
 * (docs/ORBIT_VOICE_PLAN.md §6)
 */
export interface VoiceInteractionEvent extends TelemetryEventBase {
  event_type: 'voice_interaction'
  /** Speech-to-text (mic input) or text-to-speech (spoken reply). */
  mode: 'stt' | 'tts'
  /** Which engine served it. */
  provider: VoiceProvider
  /** How it was initiated: push-to-talk mic, auto-speak, the per-message
   *  replay button, or a hands-free realtime turn (open-mic / push-to-talk
   *  — the §10.4 numbers that decide the exhibit interaction model). */
  trigger: 'mic' | 'autospeak' | 'replay' | 'open-mic' | 'push-to-talk'
  /** Recognition / synthesis wall-clock duration in ms; `0` when not measured (e.g. TTS start). */
  duration_ms: number
  /** BCP-47 base language (e.g. `en`, `es`). Low-cardinality, not free text. */
  lang: string
  /** Whether it completed successfully (STT produced a final transcript / TTS started). */
  success: boolean
  /** TTS only — the spoken reply was cut short by a hands-free barge-in
   *  (the user interrupted Orbit). Drives the barge-in-frequency metric (§10.4). */
  interrupted?: boolean
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
  | CatalogViewModeChangedEvent
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
  | MigrationR2HlsEvent
  | MigrationR2AssetsEvent
  | MigrationR2ToursEvent
  | PublisherPortalLoadedEvent
  | PublisherActionEvent
  // Tier B
  | DwellEvent
  | PublisherValidationFailedEvent
  | OrbitInteractionEvent
  | OrbitTurnEvent
  | OrbitToolCallEvent
  | OrbitLoadFollowedEvent
  | OrbitCorrectionEvent
  | BrowseSearchEvent
  | CatalogGraphNodeClickedEvent
  | CatalogTimelineBrushAppliedEvent
  | CatalogMapRegionDrawnEvent
  | VrInteractionEvent
  | ErrorDetailEvent
  | VoiceInteractionEvent
