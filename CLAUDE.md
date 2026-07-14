# CLAUDE.md

## Git

- All commits must be DCO signed-off. Use `git commit -s` (or `--signoff`) on every commit.

---

## Working in this repo

The general "one logical change per turn, committed before the
next" rule from `~/.claude/CLAUDE.md` applies here especially:

- The `docs/CATALOG_*` plan documents are sprawling (the main plan
  alone exceeds 2000 lines, plus five companion docs). Editing
  them via `Write` is unsafe — always use `Edit` for additions,
  reserve `Write` for new files.
- When adding sections to the catalog plan, commit each section
  before starting the next. The split into `CATALOG_BACKEND_PLAN`,
  `CATALOG_DATA_MODEL`, `CATALOG_FEDERATION_PROTOCOL`,
  `CATALOG_ASSETS_PIPELINE`, `CATALOG_PUBLISHING_TOOLS`, and
  `CATALOG_BACKEND_DEVELOPMENT` exists specifically to keep edits
  bounded.
- For multi-section work in the catalog plan, use TodoWrite. A
  failed chunk should not lose previous chunks' work.
- The catalog plan files cross-reference each other; when adding
  a section that another doc points at, update the cross-link in
  the same commit.
- Many of the existing `docs/*_PLAN.md` files follow a consistent
  voice: substantive prose, "Status: draft for review" markers,
  named phases, explicit non-goals, tables for comparisons,
  honest tradeoffs. New plan content should match.

### Federation planning artifact

Federation work — Phase 4 routes (handshake / feed / signing),
federation tables, peer subscription, the lightweight peer
appliance, the publisher CLI launch — follows
[`docs/architecture/federation-scoping.md`](docs/architecture/federation-scoping.md).
Before designing or implementing federation-related code, read
**§7** (Phase 4 implementation directives) and **§8** (resolved
planning decisions). The scoping doc supersedes Phase 4
sequencing in `docs/CATALOG_BACKEND_PLAN.md` where they conflict.

**Freshness check.** The scoping doc carries a "Last reviewed"
date and a "Revisit when" trigger list at the top. Before
applying its directives, verify the doc is still current — if
the last-reviewed date is more than ~6 months old, or any
"Revisit when" trigger has been hit (Phase 4 shipped, the
publisher-CLI pilot revealed auth-flow issues, a non-Cloudflare
funded partner emerged, the Phase 4 ETA slipped past two
quarters, any §8 decision changed), surface that to the user
before proceeding rather than silently applying potentially
stale guidance. Once the doc's "Supersedes when" condition is
met, defer to `CATALOG_BACKEND_PLAN.md` and `ROADMAP.md` as the
active source of truth.

---

## Codebase Overview

TypeScript SPA built with Vite and MapLibre GL JS. Deployed on Cloudflare Pages (web) and packaged as a native desktop app with Tauri v2 (Windows, macOS, Linux). No runtime framework — vanilla TS with a few focused libraries (MapLibre GL JS, HLS.js).

> Forking to deploy your own instance? See
> [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md) for the
> end-to-end Cloudflare setup walkthrough (Pages, D1, AE, KV,
> Access, optional Grafana).

### Key commands

```bash
npm run dev          # dev server (localhost:5173)
npm run build        # tokens + tsc + vite build
npm run type-check   # tsc --noEmit (must pass before committing)
npm run test         # vitest run
npm run tokens       # regenerate src/styles/tokens.css from tokens/*.json
npm run dev:desktop  # Tauri dev mode (requires Rust)
npm run build:desktop # tsc + vite build + tauri build

# Visual testing & reporting (run against a dev server on :4173)
npm run screenshots:report  # capture every scene × viewport → report-out/index.html
npm run screenshots:diff -- --baseline <dir>  # pixel-diff vs a baseline
npm run screenshots:smoke   # gating interaction tests (search, Orbit, nav)
```

> **Note:** `src/styles/tokens.css` is a generated build artifact
> (gitignored). It is created automatically by `postinstall` after
> `npm install`, and by `npm run build`. Run `npm run tokens` manually
> if you edit any file under `tokens/`.

### Module map

| File | Responsibility |
|---|---|
| `src/main.ts` | App entry — boots MapLibre renderer, orchestrates dataset loading |
| `src/types/index.ts` | All shared types (`Dataset`, `ChatMessage`, `AppState`, `DocentConfig`…) |
| `src/services/mapRenderer.ts` | MapLibre GL JS globe — GIBS tiles, navigation, markers, terrain |
| `src/services/viewportManager.ts` | Multi-globe orchestrator — 1/2/4 synchronised MapRenderer instances in a CSS grid, camera lockstep, panel promotion |
| `src/services/earthTileLayer.ts` | CustomLayerInterface — day/night blend, clouds, specular, sun, skybox |
| `src/services/dataService.ts` | Fetches SOS catalog, merges enriched metadata, 1-hour cache |
| `src/services/datasetLoader.ts` | Loads a dataset onto the globe (HLS or image); manages info panel |
| `src/services/hlsService.ts` | HLS.js wrapper — adaptive bitrate streaming via Vimeo proxy |
| `src/services/docentService.ts` | Orbit orchestrator — hybrid LLM + local engine |
| `src/services/docentContext.ts` | LLM system prompt builder, history compression, tool definition |
| `src/services/docentEngine.ts` | Local keyword-based fallback engine |
| `src/services/llmProvider.ts` | OpenAI-compatible SSE streaming client + `/models` fetch |
| `src/services/downloadService.ts` | Offline dataset download manager (desktop only, Tauri commands) |
| `src/services/tilePreloader.ts` | Eagerly fetches low-zoom GIBS tiles into cache on startup |
| `src/services/catalogSource.ts` | Build-time switch for where `dataService` / `datasetLoader` source catalog data (SOS snapshot vs node catalog) |
| `src/services/relatedDatasets.ts` | Algorithmic (lexical) related-dataset recommendations — the offline fallback |
| `src/services/relatedDatasetsService.ts` | Client for the semantic "more like this" endpoint (`GET /api/v1/datasets/:id/related`); the info panel renders the lexical list, then progressively enhances it with this. Degrades to `null` (keep lexical) on any failure |
| `src/services/visitMemory.ts` | Local-only log of which datasets the user has opened (localStorage) |
| `src/services/qaService.ts` | Loads / queries the preprocessed Q&A knowledge base (local docent path) |
| `src/services/deepLinkService.ts` | Deep-link handler — `zyra://` URLs and `/dataset/…` links |
| `src/services/shareService.ts` | Share datasets via the Web Share API or clipboard |
| `src/services/screenshotService.ts` | Captures the globe canvas (+ optional UI) as a compressed JPEG data URL |
| `src/services/globeThumbnail.ts` | Renders a 2:1 equirectangular data frame onto a sphere (lazy Three.js, in-browser) and captures a square globe thumbnail — the publisher-portal generator for `thumbnail_ref` |
| `src/services/zipDownloadService.ts` | Web-only "package a dataset as a `.zip`" entry point |
| `src/services/heroService.ts` | Picks the single "Right now" hero candidate for the catalog landing surface |
| `src/services/generalFeedbackService.ts` | Posts app-level feedback (bug / feature / other) to `/api/general-feedback` |
| `src/services/playlistService.ts` | CRUD over user-curated dataset sequences (localStorage) |
| `src/services/playlistPlayback.ts` | "Active playlist" state machine |
| `src/services/datasetFilter.ts` | Catalog filter predicate engine — shared by the chip rail and the Graph / Map / Timeline views |
| `src/services/catalogGraph.ts` | Catalog **Graph** view — pure transform from a filtered catalog to a cytoscape node/edge graph (facet/keyword co-occurrence) |
| `src/services/catalogMap.ts` | Catalog **Map** view — pure transform to one bbox overlay per dataset (geographic coverage) |
| `src/services/catalogTimeline.ts` | Catalog **Timeline** view — pure transform to one row per dataset on a shared time axis |
| `src/services/catalogEvents.ts` | Catalog **events overlay** — pure transform from public approved events + the visible dataset set to event overlays for the Map/Timeline views (`docs/CURRENT_EVENTS_PLAN.md` §6.3) |
| `src/services/eventsService.ts` | Client for the public approved-events reads — the catalog list (`GET /api/v1/events`) and the per-dataset "In the news" list (`fetchEventsForDataset` → `GET /api/v1/datasets/:id/events`); shared fetch + sanitize (http(s) source-url guard) + 60s cache |
| `src/services/datasetOverlayOptions.ts` | Pure helpers for the dataset-overlay rendering path (Phase 3e) |
| `src/services/markdownRenderer.ts` | Markdown → safe HTML renderer (Orbit messages, doc content) |
| `src/services/docentDegradedState.ts` | Session-scoped degraded-mode state for the docent |
| `src/services/appleIntelligenceProvider.ts` | On-device LLM Orbit backend via Apple's Foundation Models framework (macOS) |
| `src/services/voiceService.ts` | Orbit voice foundation — STT/TTS capability detection, provider registry + resolver (`auto` = on-device → browser; `cloud` opt-in only) incl. the Phase 3 realtime streaming-STT registry/resolver, per-locale capability matrix, recognition-language options, spoken-form projection + sentence chunking (`docs/ORBIT_VOICE_PLAN.md`) |
| `src/services/voiceBrowserEngines.ts` | Browser Web Speech engines registered against `voiceService`'s resolver — Phase 1 push-to-talk `SpeechRecognition` STT + `speechSynthesis` TTS, plus the Phase 3 **continuous** streaming STT engine (zero-dependency hands-free path) |
| `src/services/voiceCloudEngines.ts` | Cloudflare-edge voice engines — push-to-talk STT + Phase 3 **streaming** STT (`/api/voice/transcribe`, Whisper, one VAD-bounded utterance per turn; or the realtime WS engine when `VITE_VOICE_WS_STREAMING` is on) + TTS (`/api/voice/synthesize`, MeloTTS/Aura); opt-in `cloud` provider, web-only, honours the `KILL_VOICE` cooldown |
| `src/services/voicePcm.ts` | Pure PCM helpers for the realtime WS STT path — downsample to 16 kHz, pack linear16 (little-endian), parse Deepgram `{channel.alternatives[].transcript, is_final}` messages (`docs/ORBIT_VOICE_PLAN.md` §10.1) |
| `src/services/voiceWsStreaming.ts` | Phase 3 realtime **WebSocket** streaming STT engine — live interim transcripts over the `/api/voice/stream` proxy → Cloudflare Deepgram Nova-3/Flux; streams linear16 PCM, emits `onPartial`/`onTurn`; injectable socket + Web Audio capture seams |
| `src/services/voiceVad.ts` | Phase 3 local voice-activity detection — pure `EnergyVad` energy-threshold state machine (attack/release hysteresis) + thin `startMicVad` Web Audio capture loop; gates mic audio locally before any realtime streaming (`docs/ORBIT_VOICE_PLAN.md` §9.1) |
| `src/services/voiceWakeWord.ts` | Phase 3.5 wake-word — pure `WakeWordDetector` score→wake state machine (threshold / debounce / cooldown) + `startWakeWord` composition over a `WakeWordScorer` seam; selects the ONNX backend when `modelBaseUrl` is set (`docs/ORBIT_VOICE_PLAN.md` §8 decision 5) |
| `src/services/voiceWakeWordOnnx.ts` | Phase 3.5 openWakeWord ONNX scorer — on-device melspectrogram → embedding → wake-model pipeline producing per-frame scores; lazy-imports onnxruntime-web from a configurable CDN (no npm dep), models loaded from `modelBaseUrl` (`docs/ORBIT_WAKEWORD.md`) |
| `src/services/voiceRealtimeSession.ts` | Phase 3 hands-free session controller — composes the streaming STT engine + local VAD gate into one turn cycle; drives both the `open-mic` (VAD-gated) and `push-to-talk` (caller-driven) interaction models; mic/VAD seams injectable for tests (`docs/ORBIT_VOICE_PLAN.md` §9.1) |
| `src/services/uiScaleService.ts` | Runtime side of the `--ui-scale` token (§7.1) |
| `src/services/shaderSettingsService.ts` | Runtime side of the globe-shader uniforms (§7.2) |
| `src/services/atmosphereConstants.ts` | Atmospheric-scattering constants + GLSL snippets shared by `earthTileLayer` and the VR/Orbit Earth |
| `src/services/atmosphereLut.ts` | Transmittance look-up table (LUT) for atmospheric scattering |
| `src/services/vrBorders.ts` | VR country / coastline borders overlay — thin transparent shell outside the globe surface |
| `src/services/vrBrowse.ts` | In-VR dataset browse panel (CanvasTexture) — switch datasets without exiting immersive mode |
| `src/services/vrTimeLabel.ts` | In-VR dataset time label — billboarded floating panel above the globe |
| `src/services/vrTourControls.ts` | In-VR tour control strip — prev / play-pause / next / stop + step counter |
| `src/services/vrTourOverlay.ts` | In-VR tour overlay manager — CanvasTexture + VideoTexture panels replacing the 2D `tourUI` surface |
| `src/ui/chatUI.ts` | Orbit chat panel — rendering, settings, trigger positioning |
| `src/ui/voiceHandsFree.ts` | Phase 3 hands-free wiring — `HandsFreeController` bridges `RealtimeVoiceSession` to the chat input/send path (partials→input, turn→send, suspend during think/speak), drives open-mic mute, push-to-talk press, and the **wake-word** model (an on-device wake phrase — built-in default "Hey Jarvis" — arms a single turn via `startWakeWord`; `isWakeWordConfigured()` gates it on `VITE_VOICE_WAKEWORD_MODEL_URL`); inert until opted in and a streaming engine resolves (`docs/ORBIT_VOICE_PLAN.md` §9.1, `docs/ORBIT_WAKEWORD.md`) |
| `src/ui/browseUI.ts` | Dataset browse/search overlay |
| `src/ui/downloadUI.ts` | Download manager panel — view/delete cached datasets (desktop only) |
| `src/ui/mapControlsUI.ts` | Map controls positioning helper — keeps the Tools bar above the playback transport |
| `src/ui/playbackController.ts` | Playback transport controls + portrait-mobile positioning |
| `src/ui/toolsMenuUI.ts` | Tools popover — Browse button, view toggles (labels, borders, terrain, auto-rotate, info, legend), layout picker, Orbit settings entry point, Meet Orbit link (web only) |
| `src/ui/vrButton.ts` | Enter AR / Enter VR button — feature-gated (hidden on non-WebXR browsers), lazy-loads Three.js on tap |
| `src/ui/vrZoomOverlay.ts` | DOM zoom slider mounted on screen-tap AR sessions (phone via ARCore Chrome). Drives `globe.scale` through a callback; log-mapped so each unit of slider travel is a constant multiplicative zoom. Lives under `src/ui/` so the i18n string lint covers it. |
| `src/services/vrSession.ts` | WebXR session lifecycle — requests `immersive-ar` or `immersive-vr`, wires renderer.xr, drives the per-frame loop, handles anchor persistence, falls back to `local` reference space if `local-floor` is unsupported |
| `src/services/vrScene.ts` | VR scene framing — background (space blue vs transparent passthrough) + globe placement; delegates the Earth stack to `photorealEarth.ts` |
| `src/services/photorealEarth.ts` | Reusable photoreal Earth factory — diffuse / night lights / specular / atmosphere / clouds / sun / ground shadow with day/night shading; shared by VR view and Orbit character page |
| `src/services/vrInteraction.ts` | Controller input — surface-pinned drag, two-hand pinch+rotate, thumbstick zoom, flick-to-spin inertia, raycast hit routing |
| `src/services/vrHud.ts` | In-VR floating HUD — dataset title + play/pause + exit-VR as a CanvasTexture panel with UV hit regions |
| `src/services/vrPlacement.ts` | AR spatial placement — reticle + Place button; WebXR hit-test to anchor the globe on a real surface |
| `src/services/vrLoading.ts` | 3D loading scene — orbiting rings, progress bar, status text; fades out when dataset is ready |
| `src/utils/vrCapability.ts` | Feature detection — `navigator.xr`, `immersive-vr`, `immersive-ar` support — plus `getInputArchetype()` (controller / screen / transient) and `classifyXrDevice(ua, mode)` (UA-based bucket for `vr_session_started.device_class`) |
| `src/utils/vrPersistence.ts` | WebXR anchor persistent-handle save/load (localStorage) for cross-session placement stability |
| `src/utils/viewPreferences.ts` | Persists Dataset info + Legend toggle state to localStorage |
| `src/analytics/index.ts` | Telemetry public surface — call sites import `emit()` / `flush()` only from this barrel |
| `src/analytics/emitter.ts` | Telemetry queue + tier gate + batched dispatch + pagehide beacon flush |
| `src/analytics/transport.ts` | `fetch()` + `sendBeacon()` transport with response classification (ok/retry/permanent) |
| `src/analytics/config.ts` | `TelemetryTier` persistence (`sos-telemetry-config`); compile-time `TELEMETRY_BUILD_ENABLED` / `TELEMETRY_CONSOLE_MODE` flags |
| `src/analytics/session.ts` | `session_start` / `session_end` — platform / OS / viewport / aspect / screen / build channel detection |
| `src/analytics/dwell.ts` | Multi-handle dwell tracker — visibility-paused, pagehide-flushed; called by chat / browse / info / tools UI |
| `src/analytics/camera.ts` | Shared `emitCameraSettled` with per-minute throttle; called by 2D map renderer + VR/AR session |
| `src/analytics/perfSampler.ts` | 60s rAF FPS sampler — `perf_sample` event with WebGL renderer hash, p50/p95 frame time, JS heap |
| `src/analytics/errorCapture.ts` | `window.onerror` + `unhandledrejection` + Tauri `native_panic` listener; sanitizes messages and (Tier B) stacks |
| `src/analytics/hash.ts` | 12-hex SHA-256 helper for free-text fields (search queries, error stack signatures) |
| `src/ui/privacyUI.ts` | Tools → Privacy panel — tier picker (off / essential / research), session-id display, what-we-collect explainer |
| `src/ui/disclosureBanner.ts` | First-launch privacy disclosure banner — shown once per install, dismisses to default Essential tier |
| `src/orbitMain.ts` | Entry point for the Orbit standalone character page (`/orbit`) |
| `src/config/endpoints.ts` | Externally-hosted endpoint configuration (catalog / proxy / NOAA / NASA base URLs) |
| `src/types/image-sequence-constants.ts` | Constants shared by the publisher API (`functions/`), the GHA runner (`cli/`), and the portal (`src/`) for the image-sequence upload pipeline |
| `src/types/zyra-workflow-constants.ts` | Constants shared by the publisher API (`functions/`), the GHA runner (`cli/`), and the portal (`src/`) for the Zyra workflow pipeline — stage/command allowlist, template fields, run statuses (`docs/ZYRA_INTEGRATION_PLAN.md`) |
| `src/types/node-features.ts` | Per-node feature-toggle constants shared by the publisher API (`functions/`) and the portal + public SPA — `FEATURE_KEYS` / `FeatureMap`, all-on defaults, fail-open normalization (missing/unknown keys resolve to enabled) |
| `src/data/regions.ts` | Common region bounding boxes for name-based region resolution |
| `src/services/orbitCharacter/index.ts` | `OrbitController` — public API for the Orbit character (owns the Three.js scene, rAF loop, state machine) |
| `src/services/orbitCharacter/orbitScene.ts` | Three.js scene + per-frame update for the Orbit character |
| `src/services/orbitCharacter/orbitMaterials.ts` | Materials + shaders for the Orbit character |
| `src/services/orbitCharacter/orbitStates.ts` | Persistent-state vocabulary (STATES table) for the Orbit character |
| `src/services/orbitCharacter/orbitGestures.ts` | Transient gesture overlays that play over the active state, then yield control back |
| `src/services/orbitCharacter/orbitFlight.ts` | Flight system + scale presets for the Orbit character |
| `src/services/orbitCharacter/orbitTrails.ts` | Sub-sphere distance-based sparkle-wake trails |
| `src/services/orbitCharacter/orbitTypes.ts` | Shared types for the Orbit character |
| `src/ui/catalogTabsUI.ts` | Catalog ↔ Sphere segmented control |
| `src/ui/catalogGraphUI.ts` | Catalog Graph view — UI mount + cytoscape.js wiring (consumes `catalogGraph.ts`) |
| `src/ui/catalogMapUI.ts` | Catalog Map view — UI mount + MapLibre wiring (consumes `catalogMap.ts`) |
| `src/ui/catalogTimelineUI.ts` | Catalog Timeline view — UI mount + SVG wiring (consumes `catalogTimeline.ts`) |
| `src/ui/playlistUI.ts` | Playlist manager panel + the "Add to playlist" popover from browse cards / info panel |
| `src/ui/tourUI.ts` | 2D tour control bar + overlay types (VR equivalent is `vrTourOverlay.ts`) |
| `src/ui/helpUI.ts` | Help panel — Guide tab + Feedback form |
| `src/ui/creditsPanel.ts` | Credits panel (Tools → Credits) |
| `src/ui/heroPanelUI.ts` | "Right now" hero panel UI (Phase 7 §9.1 of `docs/WEB_CATALOG_FEATURES_PLAN.md`) |
| `src/ui/downloadDialogUI.ts` | Web-only zip-download panel (§8.2) |
| `src/ui/shaderTunerUI.ts` | Dev-only shader-tuner floating panel (§7.2) |
| `src/ui/orbitDebugPanel.ts` | Debug panel for the Orbit standalone page |
| `src/ui/orbitPerfHud.ts` | Perf HUD for the Orbit standalone page |
| `src/ui/orbitPostMessageBridge.ts` | postMessage bridge between the host SPA and the embedded Orbit page |
| `src/ui/domUtils.ts` | Small DOM helpers shared across UI modules |
| `src/ui/sanitizeHtml.ts` | Allowlist-based HTML sanitizer for untrusted input |
| `src/ui/blog/index.ts` | Public blog surface — lazy-booted on `/blog` + `/blog/:slug` (same chunk gate as the portal): published-post cards, the sanitized-markdown post page, per-dataset `/dataset/:id` deep links, and the approved-event source citation (`docs/CURRENT_EVENTS_PLAN.md` §7) |
| `src/ui/publisher/index.ts` | Publisher portal entry point — lazy-loaded on `/publish/*`; mounts the History-API router + pages |
| `src/ui/publisher/router.ts` | Tiny History-API router for the publisher portal |
| `src/ui/publisher/api.ts` | Shared HTTP client for the publisher portal |
| `src/ui/publisher/features.ts` | Portal-side feature-toggle helpers — module-cached `fetchFeatures()` over the authed no-store `publish/node-settings` read (fresh after every save; fail-open to all-enabled) + the org-name read off the public node-profile payload + the shared "feature turned off" card gated pages render instead of their content |
| `src/ui/publisher/types.ts` | Wire types for portal-bound publisher API responses |
| `src/ui/publisher/analytics-charts.ts` | Hand-rolled SVG chart helpers (bar series with Y-axis, mix bars, stat tiles) + CSV export helpers for the analytics tab — no charting library |
| `src/ui/publisher/components/dataset-form.ts` | Shared dataset create / edit form |
| `src/ui/publisher/components/asset-uploader.ts` | Asset uploader component (Phase 3pd image-sequence pipeline) |
| `src/ui/publisher/components/chip-input.ts` | Chip-input control — entries become removable chips as the user types |
| `src/ui/publisher/components/markdown-toolbar.ts` | GitHub-issue-style markdown toolbar over a `<textarea>` |
| `src/ui/publisher/components/sidebar.ts` | Glass-surface left sidebar — grouped section nav (Catalog / Newsroom / Insights / Settings) with a standalone Overview entry, an Events count badge, and a user-identity footer (signed-in user's avatar + name + role + Sign out) |
| `src/ui/publisher/components/error-card.ts` | Shared error-card renderer used by every portal page |
| `src/ui/publisher/components/events/match-badge.ts` | Events-tab **Match Badge** primitive — Topic/Time/Geo facet tags + composite %, threshold-toned (`docs/events-tab-handoff/EVENTS_TAB_IMPLEMENTATION_BRIEF.md` §5) |
| `src/ui/publisher/components/events/events-model.ts` | Events-tab wire types + pure helpers (`AUTO_PAIR_THRESHOLD`, `autoPairTargets`, `compositePercent`, `locatorPoint`, `primaryCategory`) shared by the queue/detail components |
| `src/ui/publisher/components/events/dataset-search.ts` | Shared catalog-search helpers for the Events-tab pairing UIs (`loadPublishedDatasets` paginated fetch + `filterDatasetsByTitle`) — used by the new-event drawer's pair pane and the detail pane's "+ Add dataset" control |
| `src/ui/publisher/components/events/event-queue.ts` | Events-tab Direction A **left master list** — one row per event (status dot + title + `source · N datasets to review`), selection-highlighted |
| `src/ui/publisher/components/events/media-suggest.ts` | Events-tab **media suggestions** — image-candidate builders for imageless events: the pure NASA Worldview Snapshots source (keyless, public-domain satellite imagery for the event's bbox + date) and the fetched Wikimedia Commons nearby-photos source (geosearch, kept only when public-domain/CC0 — the stored `image_url` carries no attribution field), and the hazard-gated USGS ShakeMap (fdsnws two-step, earthquake events) + NHC forecast-cone (CurrentStorms via the same-origin proxy, storm-name match) sources + the agency-YouTube VIDEO source (via the key-gated `youtube-search` proxy → curator-picked nocookie embed stored on `video_embed_url`, framed by the generated tour); the detail pane's "Use as event image" writes the pick through the review endpoint's `edits.imageUrl` |
| `src/ui/publisher/components/events/event-detail.ts` | Events-tab Direction A **right detail pane** — two-level approval (heavy event Approve/Reject + light per-dataset ✓/✕ + Approve-all-≥90%), meta strip, Match Badge rows, locator slot |
| `src/ui/publisher/components/events/event-locator-map.ts` | Events-tab detail **locator** — lazy MapLibre mini-map (GIBS Blue Marble raster + accent marker) centred on the event; web-only, disposed on detail swap |
| `src/ui/publisher/components/events/new-event-drawer.ts` | Events-tab Direction D **"+ New event" slide-in drawer** — compose-the-event fields (left) + search/pair published datasets (right); posts the compose body plus hand-picked `datasetIds` to the create endpoint (seeded as proposed links); focus-trapped, Escape/backdrop close |
| `src/ui/publisher/pages/overview.ts` | `/publish` + `/publish/overview` — command-center landing: Needs-you attention cards, At-a-glance 7-day stats, newsroom pipeline, recent activity + latest feedback; composes per-feature reads client-side (no overview endpoint), degrades for non-privileged callers |
| `src/ui/publisher/pages/datasets.ts` | `/publish/datasets` — dataset list visible to the caller |
| `src/ui/publisher/pages/dataset-detail.ts` | `/publish/datasets/:id` — read-only dataset detail |
| `src/ui/publisher/pages/dataset-edit.ts` | `/publish/datasets/:id/edit` — edit an existing draft |
| `src/ui/publisher/pages/dataset-new.ts` | `/publish/datasets/new` — wrapper around the shared dataset form |
| `src/ui/publisher/pages/import.ts` | `/publish/import` — bulk manifest import: method chooser (manifest / remote node / CLI), drag-drop CSV/JSON upload with real client-side parsing + per-row validation preview (ready/warning/error), default-visibility + attach-workflow controls. Submit is disabled pending the server-side bulk-import endpoint; parsing/validation helpers are pure and unit-tested |
| `src/ui/publisher/pages/tours.ts` | `/publish/tours` — tour-creator landing page |
| `src/ui/publisher/workflows-api.ts` | Typed API wrappers for the Zyra workflow surface (Phase Z2 of `docs/ZYRA_INTEGRATION_PLAN.md`) |
| `src/ui/publisher/workflow-templates.ts` | Curated workflow templates + insert-stage snippets for guided authoring (Phase Z3) |
| `src/ui/publisher/feed-presets.ts` | Curated feed-preset catalog for the feeds console — reputable suggested feeds grouped by category (hazards / science news / general news), one-click addable (`docs/CURRENT_EVENTS_PLAN.md` §9) |
| `src/ui/publisher/pages/workflows.ts` | `/publish/workflows` — Zyra workflow list |
| `src/ui/publisher/pages/workflow-detail.ts` | `/publish/workflows/:id` — workflow summary + run history + Run now |
| `src/ui/publisher/pages/workflow-edit.ts` | `/publish/workflows/new` + `…/:id/edit` — workflow form (YAML→JSON client-side, server-side Validate) |
| `src/ui/publisher/pages/featured-hero.ts` | `/publish/featured-hero` — set the "Right now" hero override (`docs/HERO_ADMIN_SCOPING.md`) |
| `src/ui/publisher/pages/node-profile.ts` | `/publish/node-profile` — edit the node / host-organization profile (org name, mission, about, region focus, tone, links) — the "about the host" context Phase 3d AI drafts ground themselves in |
| `src/ui/publisher/pages/blog.ts` | `/publish/blog` — blog authoring list (drafts + published, status badges, New post) |
| `src/ui/publisher/pages/blog-edit.ts` | `/publish/blog/new` + `…/:id/edit` — tabbed blog editor (Content / Sources / Media / AI draft): dataset/event grounding pickers, the **Media** tab (reuses the Events-tab `media-suggest` engine — Worldview / Commons / ShakeMap / NHC / agency YouTube + the cited event's story image — to insert imagery into the body or set the post's cover image), the AI Generate panel (tone/length/companion-tour → `POST /publish/blog/generate`), markdown body with the shared toolbar + sanitized Preview, Save/Publish/Unpublish |
| `src/ui/publisher/pages/feeds.ts` | `/publish/feeds` — the current-events feed console: registered connectors (pause/resume/remove, Run now, last-run status), the curated preset gallery, and the bring-your-own RSS/Atom form (`docs/CURRENT_EVENTS_PLAN.md` §9) |
| `src/ui/publisher/pages/events.ts` | `/publish/events` — current-events review queue: curator approve/reject of proposed events + their dataset links (`docs/CURRENT_EVENTS_PLAN.md` §5) |
| `src/ui/publisher/pages/analytics.ts` | `/publish/analytics` — privileged analytics dashboard over the D1 rollups, incl. the MapLibre spatial-attention heatmap (Phase B of `docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md`) |
| `src/ui/publisher/pages/feedback.ts` | `/publish/feedback` — privileged feedback review (AI thumbs + bug/feature reports) over the D1 feedback tables; replaces the feedback-admin HTML dashboard (Phase C of `docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md`) |
| `src/ui/publisher/pages/me.ts` | `/publish/me` — current-user identity + role display |
| `src/ui/publisher/pages/users.ts` | `/publish/users` — admin-only Users tab: approve / reject / suspend / reactivate publishers and change roles (admin / publisher / readonly) |
| `src/ui/tourAuthoring/index.ts` | Tour-authoring public surface — detects `?tourEdit=` and mounts the dock |
| `src/ui/tourAuthoring/dock.ts` | Floating tour-authoring dock — attaches to SPA chrome on `/?tourEdit=<id>` (or `=new`) |
| `src/ui/tourAuthoring/state.ts` | In-memory tour-authoring state — dock reads/writes here; `autosave.ts` flushes it |
| `src/ui/tourAuthoring/autosave.ts` | Debounced autosave for the tour-authoring dock |
| `src/ui/tourAuthoring/mediaCapture.ts` | Pure capture helpers for the dock's Media group — positionless `showImage`/`showVideo` builders (→ the player's responsive media rail), `media{N}` ID minting, and the hide-latest pairing walk |
| `src/ui/tourAuthoring/api.ts` | Publisher-side API client for the tour-authoring dock |
| `src/utils/logger.ts` | Log-level gating so production builds stay silent |
| `src/utils/debounce.ts` | Debounced-function wrapper |
| `src/utils/time.ts` | Time parsing / formatting utilities |
| `src/utils/frames.ts` | Frame-query resolution shared by Orbit (marker parsing) + the dataset loader |
| `src/utils/deviceCapability.ts` | Device-capability detection for adaptive performance tuning |
| `src/utils/fetchProgress.ts` | Fetch a URL as a Blob with byte-level progress reporting |
| `src/utils/captionProxy.ts` | Caption-URL proxying helper |
| `src/utils/catalogFilters.ts` | URL round-trip for catalog filter state |
| `src/utils/catalogMode.ts` | Catalog mode — `?catalog=true` URL routing |
| `src/utils/embedMode.ts` | Embed mode — `?embed=1` minimal-chrome URL routing for iframe hosting (`docs/EMBED_URL_GRAMMAR.md`) |
| `src/utils/posterDeepLinks.ts` | Poster deep-link handlers |
| `functions/api/ingest.ts` | Cloudflare Pages Function — receives telemetry batches, stamps `event_type` / `environment` / `country` / `internal` server-side, writes to Workers Analytics Engine |

> **Note:** the table above is the **SPA** module map. It is
> linted for completeness by `npm run check:doc-coverage` (see
> _Module-map coverage_ below): every module under `src/` and
> `src-tauri/src/` must appear here. When you add a module, add its
> row in the same PR.

### Backend subsystems (`functions/` + `cli/`)

The Cloudflare Pages Functions backend and the publisher CLI have
their own per-module map in
[`docs/BACKEND_MODULES.md`](docs/BACKEND_MODULES.md) (one row per
file, enforced by `check:doc-coverage`) and their design rationale
in the `docs/CATALOG_*` plan docs. The major clusters, for
orientation:

| Subsystem | Where | What |
|---|---|---|
| Semantic search & embeddings | `functions/api/v1/_lib/{embeddings,vectorize-store,embed-dataset-job,search-datasets}.ts` | Vector embeddings + Vectorize-backed semantic dataset search. Authoritative plan: `docs/CATALOG_BACKEND_PLAN.md`. |
| Publisher | `cli/`, `src/ui/publisher/`, `functions/api/v1/` (`dataset-mutations`, `tour-mutations`, `publisher-store`) | Authoring/publishing datasets & tours into the node catalog. See `docs/CATALOG_PUBLISHING_TOOLS.md`. |
| R2 asset/tour migration | `cli/` + `functions/api/v1/_lib/` (`migrate-r2-*`, `rollback-r2-*`) | One-off migrations of assets/tours into R2. See `docs/CATALOG_ASSETS_PIPELINE.md`. |

### Module-map coverage

`npm run check:doc-coverage` (in the `type-check` chain) fails CI
if any module under `src/` (SPA map) or `src-tauri/src/` (Rust map)
is missing from CLAUDE.md. When you add a module, add its row in
the same PR. For one that genuinely warrants no row (throwaway
shim, obvious from a documented sibling), add `// doc-exempt:
<reason>` to its source — the reason is mandatory, same convention
as `i18n-exempt:`.

**Scope** (an explicit manifest in `scripts/check-doc-coverage.ts`):

- **Covered:** all of `src/` and `src-tauri/src/` against this file,
  recursively; all of `functions/` and `cli/` against
  [`docs/BACKEND_MODULES.md`](docs/BACKEND_MODULES.md) (the backend
  map — helper-dense and route-shaped, kept out of CLAUDE.md and
  next to the `docs/CATALOG_*` plan docs).
- **Excluded:** generated code (`messages*.ts` i18n codegen),
  `*.d.ts`, `*.test.ts`, and `test-setup.ts`.
- Matching is on the **full repo-relative path**, because the
  backend's route layout repeats basenames across directories
  (multiple `[id].ts`, `manifest.ts`, `publish.ts`).

### Architecture graph (`/graphify`)

A vendored [graphify](https://github.com/safishamsi/graphify) skill
lives at `.claude/skills/graphify/` (see its `VENDORED.md`). It
turns the repo into a queryable knowledge graph — community
detection, "god nodes" (most-connected abstractions), and
`query` / `path` / `explain` over the structure. It's how the
module-map drift above was found, and it spans SPA + `functions/`
+ `cli/` + Rust in one graph (surfacing cross-tier coupling the
per-section docs don't).

**Two passes, very different cost:**

- **Structural** (tree-sitter AST + Leiden clustering) — free,
  deterministic, seconds. `graphify update <path> --no-cluster`.
  This is what backs the doc-coverage check and catches drift.
- **Semantic** (LLM concept/relationship extraction over docs +
  code) — **~1M tokens** on this repo, counted against your Claude
  Code usage. Run it **deliberately** (before a large refactor, or
  periodically), never in CI.

Run it via `/graphify <paths>` in a Claude Code session (e.g.
`/graphify src functions cli src-tauri docs` skips the generated
`locales/` + `tokens/` JSON). Outputs land in `graphify-out/`
(gitignored). The CLI is pre-installed by the SessionStart hook;
no API key is used — the semantic pass runs on the host session.

---

## Visual testing & reporting

A Playwright-driven tool captures the real UI to catch visual and
interaction regressions. It started as the Weblate translator-screenshot
pipeline and now shares one capture core
(`scripts/screenshots/core/`) across several consumers. Authoritative
design: [`docs/VISUAL_REPORT_PLAN.md`](docs/VISUAL_REPORT_PLAN.md).

| Command | What it does |
|---|---|
| `npm run screenshots:report` | Captures every scene × viewport (desktop + mobile) into a self-contained `report-out/index.html` gallery with per-scene problem badges (console/page errors, failed requests, optional `VISUAL_AXE` a11y). The local visual-debug surface. Add `-- --scene <name>[,<name>]` (or `VISUAL_ONLY=`) to capture just one surface while iterating on it — reuses the scene's maintained navigation/fixtures/masks instead of an ad-hoc script. |
| `npm run screenshots:diff -- --baseline <dir>` | Pixel-diffs the current `report-out/` against a baseline PNG dir (masked regions excluded); advisory. |
| `npm run screenshots:smoke` | Gating interaction tests — search, Orbit's local engine, navigation, a fixture-backed publisher page. |
| `npm run screenshots:capture` | The Weblate translator-screenshot capture (separate output + uploader). |

All capture commands run against a dev server on `:4173`
(`npm run dev -- --port 4173`). CI is
[`.github/workflows/visual-report.yml`](.github/workflows/visual-report.yml):
PRs get an advisory `visual-report` artifact + comment (diffed against
the latest `main` baseline) and a gating smoke job; `main` publishes the
baseline and deploys the report. The Weblate sync
(`sync-weblate-screenshots.yml`) is deliberately separate.

- **Scenes** are the one human-maintained list:
  [`scripts/screenshots/scenes.ts`](scripts/screenshots/scenes.ts)
  (`{ name, description, setup(page), masks?, fixtures? }`). `masks`
  excludes non-deterministic regions (globe / MapLibre / graph) from the
  diff; `fixtures` route-stubs `/api/**` so data-backed pages render
  populated (see
  [`scripts/screenshots/fixtures/`](scripts/screenshots/fixtures/),
  typed against `src/ui/publisher/types.ts`).
- **Convention (mirrors the module-map coverage rule):** when you add a
  UI route or surface under `src/ui/`, add a `Scene` for it in the same
  PR — and a smoke assertion if it is interactive. Report strings are
  dev/CI output and are intentionally **not** routed through i18n.

---

## Orbit — Digital Docent

Orbit is the AI chat assistant. Understanding its architecture is essential for working on the chat feature.

### Hybrid architecture

`docentService.processMessage()` runs two paths concurrently:

1. **Local engine** (`docentEngine.ts`) — instant keyword/intent matching, no network required, always available
2. **LLM stream** (`llmProvider.ts` → `docentContext.ts`) — streams from any OpenAI-compatible endpoint

If the LLM errors or is disabled, the local engine result is used as the response. When the LLM succeeds it is the sole source of dataset recommendations.

### Dataset loading from chat

The LLM is prompted to embed `<<LOAD:DATASET_ID>>` markers inline with its text. `docentService.extractActionsFromText()` parses these (plus bare `INTERNAL_...` IDs as a fallback for LLMs that ignore the marker instructions) into `action` stream chunks. `chatUI.ts` renders each action as an inline load button inside the message bubble — the `<<LOAD:...>>` syntax is never shown to the user.

The `load_dataset` function-calling tool is also supported for providers that prefer tool calls over inline markers.

### System prompt

`docentContext.buildSystemPromptForTurn()` is turn-aware:
- **Turn 0**: full catalog (ID | Title [Categories]) — more tokens, best for opening recommendations
- **Turn ≥1**: compact catalog (ID | Title only) to reduce per-turn cost

History is compressed: the last 3 exchanges are sent verbatim; older messages are summarised.

### LLM configuration

Stored in `localStorage` under `sos-docent-config`. Defaults:
- `apiUrl`: `/api` (Cloudflare proxy in production; override to a direct URL for local dev)
- `model`: `llama-3.1-70b` (populated from `/models` endpoint dropdown)
- `apiKey`: empty
- `enabled`: true

> On localhost the Cloudflare `/api` proxy is unavailable. The docent falls back to local engine automatically if the LLM is unreachable.

> **Desktop (Tauri)**: API keys are stored in the OS keychain via `keychain.rs`, not localStorage. `saveConfig()` accepts a `persistApiKey` flag — pass `true` only from the settings form save handler to avoid erasing the keychain on unrelated config changes. The Tauri HTTP plugin (`@tauri-apps/plugin-http`) is used for all LLM requests to bypass webview CORS restrictions when connecting to local servers (Ollama, LM Studio, etc.).

### Stream chunk types

`DocentStreamChunk` union (from `docentService.ts`):
- `delta` — text fragment to append to the current message
- `action` — load a dataset (renders as an inline button)
- `auto-load` — auto-loaded dataset with alternatives
- `done` — stream complete; `fallback: true` if local engine was used

---

## VR / AR — Immersive mode

The app ships an optional WebXR immersive mode for Meta Quest (and
any other WebXR-capable headset). Entirely feature-gated — browsers
without `navigator.xr` never load the Three.js chunk and see no UI
change. Design doc: [`docs/VR_INVESTIGATION_PLAN.md`](docs/VR_INVESTIGATION_PLAN.md).

### Key architectural points

- **Two renderers, one DOM.** The 2D app's MapLibre canvas is untouched
  by VR. When the user taps Enter AR / Enter VR, `vrSession.ts` creates
  a parallel Three.js `WebGLRenderer` attached to its own canvas,
  calls `renderer.xr.setSession(session)`, and drives a separate XR
  render loop. MapLibre keeps running behind the scenes and takes
  over again on session-end.

- **Lazy-loaded Three.js.** `import('three')` only fires on the
  first Enter AR/VR tap — same lazy-import pattern used for Tauri
  plugins in `llmProvider.ts` / `downloadService.ts`. Three.js
  chunks separately at ~183 KB gzipped; the main bundle is unchanged
  for non-VR users. `XRControllerModelFactory` chunks alongside at
  ~16 KB gzipped.

- **AR-first button.** `vrButton.ts` prefers `immersive-ar` when the
  device supports it (Quest 2/3/Pro all do), falls back to
  `immersive-vr` on PCVR, hides entirely on non-XR browsers.

- **Dataset texture reuse.** Video datasets reuse the existing HLS
  `<video>` element directly via `THREE.VideoTexture`. Image datasets
  reuse the already-decoded `HTMLImageElement` stored in
  `panelStates[slot].image` (set by `loadImageDataset`). Zero
  re-fetches.

- **Earth-as-planet vs. data-as-surface modes.** When no dataset is
  loaded, `photorealEarth.ts` (wired up by `vrScene.ts`) renders the
  full photoreal Earth stack (diffuse + night lights + specular +
  atmosphere + clouds + sun + ground shadow + day/night shader gated
  by real UTC sun position). When a dataset is loaded, all
  Earth-specific decoration is hidden so the data reads uniformly
  across the sphere.

- **Spatial placement (AR only).** `vrPlacement.ts` uses WebXR
  `hit-test` to let the user point at a real-world surface and tap
  to anchor the globe there. `vrPersistence.ts` stores the anchor's
  persistent-handle UUID in localStorage so the globe stays in the
  same physical spot across sessions (Quest's Meta Anchors extension).

### Session-start ordering is subtle

`vrSession.enterImmersive()` has a specific async ordering that
matters for correctness:

1. `loadThree()` — Three.js chunk
2. **`import XRControllerModelFactory`** — must finish before
   `setTexture` fires its synchronous `onReady`, otherwise the
   loading-scene fade-out race loses (see commit 90279c5)
3. Build renderer + camera, request session, `setSession`
4. AR: set up hit-test source + restore persistent anchor
5. Build `scene`, `hud`, `loading`; hide globe + HUD; show loading
6. `setTexture` → fires `onReady` → schedules 250 ms → fade-out
7. Build `interaction`, assign `active`, start animation loop

### Per-frame ordering in the render loop

1. Hit-test (placement, AR only)
2. Anchor-pose sync (AR only — writes into `globe.position`)
3. Dataset texture swap (idempotent no-op in steady state)
4. HUD state update (debounced)
5. Interaction update (rotation, zoom, inertia)
6. Scene update (shadow, atmosphere, sun — tracked to `globe.position`)
7. HUD + Place button position sync (follows globe)
8. Loading-scene animation (rings spin, fade)
9. `renderer.render(scene, camera)`

---

## UI Layout & Panel Coordination

The UI is floating glass-surface overlays on a full-viewport WebGL canvas. See [STYLE_GUIDE.md](STYLE_GUIDE.md) for visual design rules.

### Panel mutual exclusion

- Expanding the **info panel** (dataset metadata) closes the chat panel via `closeChat()` in `datasetLoader.ts`
- Opening the **chat panel** collapses the info panel via DOM manipulation in `chatUI.openChat()`

### ResizeObserver-driven positioning

Two elements track the info panel height as it animates open:

- **Chat trigger** (`#chat-trigger`) — managed in `chatUI.updateTriggerForInfoPanel()`, wired in `wireEvents()`
- **Playback controls** (`#playback-controls`) — managed in `playbackController.initPlaybackPositioning()`, called from `main.ts`. Portrait mobile only (≤600px + portrait orientation). Resets to `'0.75rem'` (not `''`) because the element uses an inline style with no CSS fallback.

### Responsive breakpoints

| Breakpoint | Behaviour |
|---|---|
| `> 768px` | Desktop |
| `≤ 768px` | Mobile — panels slide from edges |
| `≤ 600px` + portrait | Portrait phone — browse card titles on own line; playback controls lift above info panel |

---

## Localization

The app ships in multiple languages. **Every new user-facing
string must go through the i18n layer; never hard-code English
in source.** A static check (`npm run check:i18n-strings`) runs
in the type-check chain and fails CI if it finds a hard-coded
label in `src/ui/` or `src/services/docent*.ts`.

### i18n runtime modules

The `src/i18n/` layer (these are the runtime modules; the
`src/i18n/messages*.ts` files are generated codegen output and are
not individually documented):

| File | Responsibility |
|---|---|
| `src/i18n/index.ts` | Public runtime API — `t()`, `plural()`, `interpolate()`, locale switching, `<html dir>` wiring |
| `src/i18n/bootstrap.ts` | Shared i18n bootstrap for entry points (`main.ts`, `orbitMain.ts`, future entries) |
| `src/i18n/detect.ts` | Initial-locale detection (query param → storage → `navigator.languages`) |
| `src/i18n/persistence.ts` | Locale-preference persistence — mirrors `src/utils/viewPreferences.ts` |
| `src/i18n/format.ts` | Locale-aware formatting helpers (numbers, dates, lists) |
| `src/i18n/applyI18nAttributes.ts` | DOM walker that translates static markup carrying `data-i18n` attributes |
| `src/i18n/rtl.ts` | RTL locale set + `<html dir>` resolution |
| `src/i18n/screenshotTrace.ts` | Build-flag-gated (`VITE_I18N_TRACE`) recorder — `t()` mirrors every resolved key onto `window.__i18nTrace` for the Weblate screenshot-capture pipeline (`docs/WEBLATE_SCREENSHOT_SYNC_PLAN.md`); tree-shakes out of normal builds |

### When you add a new UI string

1. Add the key to `locales/en.json` (sorted; the codegen will
   canonicalize on the next `npm run locales`).
2. Reference it via `t('your.key.here')` from
   [`src/i18n/index.ts`](src/i18n/index.ts).
3. Run `npm run locales` (or `npm run check:locales`) — the
   codegen builds a TypeScript `MessageKey` union from
   `en.json`, so any unresolved key fails type-check.
4. If the key is ambiguous out of context (placeholders to
   preserve, ARIA semantics, special markers like
   `<<LOAD:DATASET_ID>>`), add a one-line entry to
   [`locales/_explanations.json`](locales/_explanations.json).
   It auto-syncs to Weblate's per-string Explanation field via
   the `sync-weblate.yml` workflow.

For a string that genuinely shouldn't be translated (debug
HUD, technical identifier, machine-only output), add
`// i18n-exempt: <reason>` to the same line. The reason is
mandatory — it's how a future reader knows the omission was
deliberate.

### When you add CSS

Use **logical inline-axis properties** so the layout flips
correctly when an RTL locale is active (`<html dir>` is set
automatically by [`src/i18n/index.ts`](src/i18n/index.ts) via
[`src/i18n/rtl.ts`](src/i18n/rtl.ts)):

| Use this | Not this |
|---|---|
| `padding-inline-start` / `padding-inline-end` | `padding-left` / `padding-right` |
| `margin-inline-start` / `margin-inline-end` | `margin-left` / `margin-right` |
| `border-inline-start` / `border-inline-end` | `border-left` / `border-right` |
| `inset-inline-start` / `inset-inline-end` | `left` / `right` |
| `text-align: start` / `text-align: end` | `text-align: left` / `text-align: right` |

Two patterns are intentionally physical: classic centering
(`top: 50%; left: 50%; transform: translate(-50%, -50%)` —
`inset-inline-start: 50%` doesn't center in RTL) and
direction-sensitive `transform: translateX(±100%)` slides (pair
with a `:root[dir="rtl"]` override that flips the sign — see
[`src/styles/browse.css`](src/styles/browse.css)
`#browse-overlay.collapsed`). Full guide:
[`docs/CSS_ARCHITECTURE_PLAN.md`](docs/CSS_ARCHITECTURE_PLAN.md)
§RTL safety.

### Commands

| Command | What it does |
|---|---|
| `npm run locales` | Regenerates the TS message modules + canonicalizes the locale JSON. Idempotent. |
| `npm run check:locales` | Drift-check (CI). Fails if generated TS or canonicalized JSON differs from a fresh render. |
| `npm run check:i18n-strings` | Scans `src/ui/` + `src/services/docent*.ts` for hard-coded user-visible strings. Runs in the `type-check` chain. |
| `npm run sync:weblate` | Pushes `locales/_explanations.json` to Weblate's per-string Explanation field. Token via `WEBLATE_TOKEN` env var. Auto-runs in CI on push to main. |

### Don't hand-edit non-source locales

Translator changes flow in via Weblate PRs. The codegen
canonicalizes every `locales/*.json` on every run so Weblate's
PRs against `main` never produce whitespace-only diffs.
Hand-editing `locales/es.json` (or `kab.json`, `ar.json`, etc.)
is fine for one-off fixes but the canonical surface is Weblate.

### Doc references

- [`docs/I18N_PLAN.md`](docs/I18N_PLAN.md) — full plan, phase
  table (L1 / L1.5 shipped; L2-L4 blocked on catalog backend),
  runtime API.
- [`CONTRIBUTING-TRANSLATIONS.md`](CONTRIBUTING-TRANSLATIONS.md)
  — translator workflow, glossary conventions, DCO setup.
- [`docs/CSS_ARCHITECTURE_PLAN.md`](docs/CSS_ARCHITECTURE_PLAN.md)
  — §RTL safety section with the use-this-not-that table and
  centering exceptions.

---

## Tours

The tour engine (`src/services/tourEngine.ts`) plays back SOS-format tour JSON files. Each tour is a sequence of tasks executed in order. The following tour tasks are relevant to the multi-globe feature:

| Task | Behaviour |
|---|---|
| `setEnvView` | `callbacks.setEnvView()` — switches layout (1globe/2globes/4globes) |
| `unloadDataset` | `callbacks.unloadDatasetAt()` — unloads a specific dataset by tour handle |
| `worldIndex` on `loadDataset` | Routes dataset load to a specific panel slot (1-indexed) |
| `setTime` | `callbacks.setTime()` — seeks the loaded (video) dataset to an ISO time (`seekToDate`); best-effort no-op when unseekable / out of range. Added for the auto-generated current-events tours (`docs/CURRENT_EVENTS_PLAN.md` §7) |

---

## Analytics

Privacy-first product telemetry. Two-tier consent model with the
client emitter in `src/analytics/`, server stamping at
`functions/api/ingest.ts`, storage in Cloudflare Workers Analytics
Engine, Grafana dashboards under `grafana/dashboards/`.

**Authoritative reference: [`docs/ANALYTICS.md`](docs/ANALYTICS.md).**
The query/schema reference is [`docs/ANALYTICS_QUERIES.md`](docs/ANALYTICS_QUERIES.md);
the user-facing privacy policy is [`docs/PRIVACY.md`](docs/PRIVACY.md)
(generated to `public/privacy.html` by `scripts/build-privacy-page.ts` —
`npm run build:privacy-page` rebuilds it; `npm run check:privacy-page`
guards the diff in CI).

### Two tiers

| Tier | Default | Examples |
|---|---|---|
| `essential` (Tier A) | on | `session_*`, `layer_*`, `camera_settled`, `map_click`, `playback_action`, `tour_*`, `vr_session_*`, `perf_sample`, `error`, `feedback` |
| `research` (Tier B) | opt-in | `dwell`, `orbit_*`, `browse_search` (hashed), `vr_interaction` (per gesture, throttled), `error_detail` (sanitized stacks), `tour_question_answered` |

User-controlled in **Tools → Privacy** (`src/ui/privacyUI.ts`).
First-launch banner in `src/ui/disclosureBanner.ts`. The
`TIER_B_EVENT_TYPES` tuple in `src/types/index.ts` is the runtime
gate; adding an event there is the single point that promotes it to
Research-only.

### Adding a new event

The full walkthrough + reviewer checklist lives in
[`docs/ANALYTICS_CONTRIBUTING.md`](docs/ANALYTICS_CONTRIBUTING.md).
Headlines:

1. Add an interface to `src/types/index.ts`, append to
   `TelemetryEvent` union, decide tier (`TIER_B_EVENT_TYPES`).
2. `import { emit } from '../analytics'` and call from the call site.
3. Throttle if it can fire more than ~30/min — pattern lives in
   `src/analytics/camera.ts` and `src/services/vrInteraction.ts`.
4. Hash any free-text via `src/analytics/hash.ts` (12-hex SHA-256).
5. Add a row to the catalog in `ANALYTICS.md`, a positional layout
   in `ANALYTICS_QUERIES.md`, a panel in `grafana/dashboards/`, and
   a test (`*.test.ts` next to the call site).

### Reviewing analytics changes

When reviewing a PR (your own or someone else's) that touches
`src/analytics/**`, `functions/api/ingest.ts`, the `TelemetryEvent`
union in `src/types/index.ts`, or any `emit({ event_type: ... })`
call site, run through the **Reviewer checklist** section of
[`docs/ANALYTICS_CONTRIBUTING.md`](docs/ANALYTICS_CONTRIBUTING.md)
explicitly. The checklist covers schema, tier choice, the eight
privacy invariants, throttling, tests, and documentation. Flag
any item you can't positively confirm; block on missing tier-gate
or missing hashing/sanitization of free-text fields.

### Privacy invariants

- No IP storage (only `CF-IPCountry` for country).
- No User-Agent storage (only bucketed OS / viewport / aspect /
  screen enums from `src/analytics/session.ts`).
- Search queries hashed before emit; error messages sanitized
  (`src/analytics/errorCapture.ts:sanitizeMessage()`).
- Lat/lon rounded to 3 decimals (~111 m) by
  `src/analytics/camera.ts` before emit.
- Session id is in-memory only — rotates every launch, never
  persisted.
- Server-side `KILL_TELEMETRY=1` env returns 410 → client cools
  down for the rest of the session.

### Local dev

- `VITE_TELEMETRY_CONSOLE=true` — log batches to console instead
  of POSTing.
- `VITE_TELEMETRY_ENABLED=false` — compile out the emitter
  entirely (call sites tree-shake).

---

## Deployment

### Web
Cloudflare Pages. Orbit's default LLM path is Cloudflare Workers AI: `functions/api/chat/completions.ts` runs the `AI` binding edge-side and streams an OpenAI-shaped SSE response (no external API key in the client bundle), with `functions/api/models.ts` backing the "Test Connection" button. External OpenAI-compatible providers are configured client-side only (Tools → Orbit Settings; localStorage / desktop keychain) — there is no server-side `LLM_PROVIDER_*` proxy.

### Desktop
Tauri v2. Three CI/CD workflows:
- `desktop.yml` — CI build on push/PR (signed on push, compile-only on PRs from forks)
- `release.yml` — tag-triggered or manual dispatch; builds all platforms, signs with Tauri updater key, creates draft GitHub Release with `latest.json` for auto-updates
- Manual release: Actions → "Release Desktop App" → enter version, pick branch

---

## Desktop App (Tauri v2)

The desktop app shares 100% of the TypeScript source. Desktop-only behaviour is gated at runtime via `window.__TAURI__`. The `src-tauri/` directory contains the Rust backend.

### Rust module map

| File | Responsibility |
|---|---|
| `src-tauri/src/main.rs` | Entry point — plugin registration, Tauri state setup |
| `src-tauri/src/tile_cache.rs` | SHA-256 flat-file cache for GIBS map tiles |
| `src-tauri/src/keychain.rs` | OS keychain read/write for LLM API key |
| `src-tauri/src/download_manager.rs` | Dataset download with progress events, cancellation, JSON index |
| `src-tauri/src/download_commands.rs` | Tauri commands exposing download operations to the frontend |
| `src-tauri/src/lib.rs` | Shared app entry (`run()`) for desktop **and** mobile — module wiring, plugin/builder setup, `native_panic` hook; `main.rs` calls it on desktop, the `mobile_entry_point` macro on iOS/Android |

### Key configuration files

| File | Purpose |
|---|---|
| `src-tauri/tauri.conf.json` | Window config, updater (pubkey + endpoint), asset protocol scope, bundle targets |
| `src-tauri/capabilities/default.json` | Permission policies — HTTP allowlist (localhost, Ollama/LM Studio/llama.cpp ports, HTTPS), updater, window controls |
| `src-tauri/Cargo.toml` | Rust dependencies — tauri, reqwest, keyring, tauri-plugin-http, tauri-plugin-updater |

### Tauri patterns used in the frontend

All Tauri imports are **lazy-loaded** behind `IS_TAURI` checks so the web build is never affected:

```typescript
// Pattern used in llmProvider.ts, downloadService.ts, datasetLoader.ts, etc.
const tauriFetchReady: Promise<typeof fetch | null> = IS_TAURI
  ? import('@tauri-apps/plugin-http').then(m => m.fetch).catch(() => null)
  : Promise.resolve(null)
```

- `@tauri-apps/api/core` — `invoke()` for IPC commands, `convertFileSrc()` for local file URLs
- `@tauri-apps/api/event` — `listen()` for download progress/complete/error events
- `@tauri-apps/plugin-http` — CORS-free `fetch()` for LLM requests and image resolution probes
- `@tauri-apps/plugin-updater` — auto-update check on launch

### Offline dataset downloads

- Downloads are managed by `download_manager.rs` with files stored under `{app_data}/datasets/{dataset_id}/`
- A JSON index (`index.json`) tracks all downloaded datasets
- `downloadService.ts` resolves assets: videos via Vimeo proxy (highest quality MP4), images via HEAD probes (4096 → 2048 → original)
- `datasetLoader.ts` checks for local cache first via `getDownload()` / `getDownloadPath()` before hitting the network
- Local files are served to the webview via `convertFileSrc()` → `http://asset.localhost/` URLs
- The asset protocol scope is restricted to `$APPDATA/**` and `$APPLOCALDATA/**`

### HTTP plugin allowed origins

The Tauri HTTP plugin capability (`capabilities/default.json`) restricts outbound HTTP:
- `http://localhost:*` and `http://127.0.0.1:*` — any port on loopback
- `http://*:11434` (Ollama), `http://*:1234` (LM Studio), `http://*:8080` (llama.cpp/vLLM)
- `https://*` — any HTTPS endpoint (OpenAI, video proxy, NOAA, NASA GIBS, etc.)
