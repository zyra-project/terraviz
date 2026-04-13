# CLAUDE.md

## Git

- All commits must be DCO signed-off. Use `git commit -s` (or `--signoff`) on every commit.

---

## Codebase Overview

TypeScript SPA built with Vite and MapLibre GL JS. Deployed on Cloudflare Pages (web) and packaged as a native desktop app with Tauri v2 (Windows, macOS, Linux). No runtime framework — vanilla TS with a few focused libraries (MapLibre GL JS, HLS.js).

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
| `src/ui/chatUI.ts` | Orbit chat panel — rendering, settings, trigger positioning |
| `src/ui/browseUI.ts` | Dataset browse/search overlay |
| `src/ui/downloadUI.ts` | Download manager panel — view/delete cached datasets (desktop only) |
| `src/ui/mapControlsUI.ts` | Map controls positioning helper — keeps the Tools bar above the playback transport |
| `src/ui/playbackController.ts` | Playback transport controls + portrait-mobile positioning |
| `src/ui/toolsMenuUI.ts` | Tools popover — Browse button, view toggles (labels, borders, terrain, auto-rotate, info, legend), layout picker, Orbit settings entry point |
| `src/utils/viewPreferences.ts` | Persists Dataset info + Legend toggle state to localStorage |

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
