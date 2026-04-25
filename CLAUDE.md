# CLAUDE.md

## Git

- All commits must be DCO signed-off. Use `git commit -s` (or `--signoff`) on every commit.

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
npm run build        # tsc + vite build
npm run type-check   # tsc --noEmit (must pass before committing)
npm run test         # vitest run
npm run dev:desktop  # Tauri dev mode (requires Rust)
npm run build:desktop # tsc + vite build + tauri build
```

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
| `src/ui/chatUI.ts` | Orbit chat panel — rendering, settings, trigger positioning |
| `src/ui/browseUI.ts` | Dataset browse/search overlay |
| `src/ui/downloadUI.ts` | Download manager panel — view/delete cached datasets (desktop only) |
| `src/ui/mapControlsUI.ts` | Map controls positioning helper — keeps the Tools bar above the playback transport |
| `src/ui/playbackController.ts` | Playback transport controls + portrait-mobile positioning |
| `src/ui/toolsMenuUI.ts` | Tools popover — Browse button, view toggles (labels, borders, terrain, auto-rotate, info, legend), layout picker, Orbit settings entry point, Meet Orbit link (web only) |
| `src/ui/vrButton.ts` | Enter AR / Enter VR button — feature-gated (hidden on non-WebXR browsers), lazy-loads Three.js on tap |
| `src/services/vrSession.ts` | WebXR session lifecycle — requests `immersive-ar` or `immersive-vr`, wires renderer.xr, drives the per-frame loop, handles anchor persistence |
| `src/services/vrScene.ts` | VR scene framing — background (space blue vs transparent passthrough) + globe placement; delegates the Earth stack to `photorealEarth.ts` |
| `src/services/photorealEarth.ts` | Reusable photoreal Earth factory — diffuse / night lights / specular / atmosphere / clouds / sun / ground shadow with day/night shading; shared by VR view and Orbit character page |
| `src/services/vrInteraction.ts` | Controller input — surface-pinned drag, two-hand pinch+rotate, thumbstick zoom, flick-to-spin inertia, raycast hit routing |
| `src/services/vrHud.ts` | In-VR floating HUD — dataset title + play/pause + exit-VR as a CanvasTexture panel with UV hit regions |
| `src/services/vrPlacement.ts` | AR spatial placement — reticle + Place button; WebXR hit-test to anchor the globe on a real surface |
| `src/services/vrLoading.ts` | 3D loading scene — orbiting rings, progress bar, status text; fades out when dataset is ready |
| `src/utils/vrCapability.ts` | Feature detection — `navigator.xr`, `immersive-vr`, `immersive-ar` support |
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
Cloudflare Pages. `functions/api/[[route]].ts` is a Cloudflare Function that proxies LLM API requests server-side so the API key is never in the client bundle.

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
