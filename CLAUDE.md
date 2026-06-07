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
| `src/services/relatedDatasets.ts` | Algorithmic related-dataset recommendations |
| `src/services/visitMemory.ts` | Local-only log of which datasets the user has opened (localStorage) |
| `src/services/qaService.ts` | Loads / queries the preprocessed Q&A knowledge base (local docent path) |
| `src/services/deepLinkService.ts` | Deep-link handler — `zyra://` URLs and `/dataset/…` links |
| `src/services/shareService.ts` | Share datasets via the Web Share API or clipboard |
| `src/services/screenshotService.ts` | Captures the globe canvas (+ optional UI) as a compressed JPEG data URL |
| `src/services/zipDownloadService.ts` | Web-only "package a dataset as a `.zip`" entry point |
| `src/services/heroService.ts` | Picks the single "Right now" hero candidate for the catalog landing surface |
| `src/services/generalFeedbackService.ts` | Posts app-level feedback (bug / feature / other) to `/api/general-feedback` |
| `src/services/playlistService.ts` | CRUD over user-curated dataset sequences (localStorage) |
| `src/services/playlistPlayback.ts` | "Active playlist" state machine |
| `src/services/datasetFilter.ts` | Catalog filter predicate engine — shared by the chip rail and the Graph / Map / Timeline views |
| `src/services/catalogGraph.ts` | Catalog **Graph** view — pure transform from a filtered catalog to a cytoscape node/edge graph (facet/keyword co-occurrence) |
| `src/services/catalogMap.ts` | Catalog **Map** view — pure transform to one bbox overlay per dataset (geographic coverage) |
| `src/services/catalogTimeline.ts` | Catalog **Timeline** view — pure transform to one row per dataset on a shared time axis |
| `src/services/datasetOverlayOptions.ts` | Pure helpers for the dataset-overlay rendering path (Phase 3e) |
| `src/services/markdownRenderer.ts` | Markdown → safe HTML renderer (Orbit messages, doc content) |
| `src/services/docentDegradedState.ts` | Session-scoped degraded-mode state for the docent |
| `src/services/appleIntelligenceProvider.ts` | On-device LLM Orbit backend via Apple's Foundation Models framework (macOS) |
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
| `functions/api/ingest.ts` | Cloudflare Pages Function — receives telemetry batches, stamps `event_type` / `environment` / `country` / `internal` server-side, writes to Workers Analytics Engine |

> **Note:** the table above is the **SPA** module map. It is
> linted for completeness against `src/services/` by
> `npm run check:doc-coverage` (see _Module-map coverage_ below).
> The `src/ui/` layer is large and only partially listed here;
> add a row when you introduce a non-obvious panel.

### Backend subsystems (`functions/` + `cli/`)

The Cloudflare Pages Functions backend and the publisher CLI are
**not** in the SPA module map above — they have their own plan
docs under `docs/CATALOG_*`. The major clusters, for orientation:

| Subsystem | Where | What |
|---|---|---|
| Semantic search & embeddings | `functions/api/v1/_lib/{embeddings,vectorize-store,embed-dataset-job,search-datasets}.ts` | Vector embeddings + Vectorize-backed semantic dataset search. Authoritative plan: `docs/CATALOG_BACKEND_PLAN.md`. |
| Publisher | `cli/`, `src/ui/publisher/`, `functions/api/v1/` (`dataset-mutations`, `tour-mutations`, `publisher-store`) | Authoring/publishing datasets & tours into the node catalog. See `docs/CATALOG_PUBLISHING_TOOLS.md`. |
| R2 asset/tour migration | `cli/` + `functions/api/v1/_lib/` (`migrate-r2-*`, `rollback-r2-*`) | One-off migrations of assets/tours into R2. See `docs/CATALOG_ASSETS_PIPELINE.md`. |

### Module-map coverage

`npm run check:doc-coverage` (in the `type-check` chain) fails CI
if a top-level `src/services/*.ts` module is missing from the
module-map table above. When you add a service, add its row in the
same PR. For a module that genuinely warrants no row (throwaway
shim, obvious from a documented sibling), add `// doc-exempt:
<reason>` to its source — the reason is mandatory, same convention
as `i18n-exempt:`. The check covers `src/services/` only; `src/ui/`
and the `functions/` + `cli/` backend are intentionally out of
scope (the backend has its own `docs/CATALOG_*` plan docs).

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
