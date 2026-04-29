# Terraviz

[![Live Demo](https://img.shields.io/badge/Live_Demo-terraviz.zyra--project.org-4da6ff)](https://terraviz.zyra-project.org)
[![Windows](https://img.shields.io/badge/Download-Windows-0078D4?logo=windows&logoColor=white)](https://github.com/zyra-project/terraviz/releases/latest/download/Terraviz-latest-x64.msi)
[![macOS](https://img.shields.io/badge/Download-macOS-000000?logo=apple&logoColor=white)](https://github.com/zyra-project/terraviz/releases/latest/download/Terraviz-latest-aarch64.dmg)
[![Linux](https://img.shields.io/badge/Download-Linux-FCC624?logo=linux&logoColor=black)](https://github.com/zyra-project/terraviz/releases/latest/download/Terraviz-latest-x64.AppImage)
[![Privacy](https://img.shields.io/badge/privacy-policy-blue)](docs/PRIVACY.md)

A WebGL-based globe that streams environmental data from the [Science On a Sphere](https://sos.noaa.gov/) project. Available as a [web app](https://terraviz.zyra-project.org) and a native desktop application for Windows, macOS, and Linux.

![Terraviz interface showing the Earth globe with the dataset browse panel](initial-interface.jpg)

## ✨ Features

- Searchable, filterable dataset browser with category and sub-category navigation, expandable cards, and thumbnails
- Interactive 3D globe with MapLibre GL JS (rotation, zoom, inertia on desktop and mobile, geographic labels, boundaries, 3D terrain)
- NASA GIBS tile-based Earth (Blue Marble day, Black Marble night lights with progressive zoom detail, specular highlights, sun lighting, real-time cloud overlay, atmosphere)
- Static image datasets with resolution fallback (4096/2048/1024) and download progress
- HLS video streaming via Vimeo proxy with adaptive bitrate, playback controls, and audio
- Time synchronization with ISO 8601 parsing and scrubber
- **Orbit** — an AI digital docent that answers questions, explains datasets, and loads them onto the globe by conversation (hybrid LLM + local keyword engine, configurable to any OpenAI-compatible provider)
- **Multi-globe comparison** — View 2 or 4 synchronised globes side-by-side, each showing a different dataset. Camera motion locks across panels; time-series animations sync by real-world date. Switch layouts from the Tools menu.
- **Climate Futures tour** — A built-in guided tour comparing SSP1/SSP2/SSP5 climate scenarios across air temperature, precipitation, sea surface temperature, and sea ice concentration using 1, 2, and 4-globe layouts.
- Collapsible browse panel (desktop sidebar with toggle)
- Accessible controls (ARIA labels, keyboard navigation)
- Frosted-glass UI design language (see [STYLE_GUIDE.md](STYLE_GUIDE.md))

### Desktop App (Tauri)

The desktop app includes everything above, plus:

- **Offline dataset downloads** — save any dataset (video or image) for use without an internet connection, with a download manager to view and manage cached data
- **Local tile cache** — map tiles are cached to disk for faster rendering; low-zoom tiles are preloaded on startup
- **Local LLM support** — connect Orbit to Ollama, LM Studio, or any OpenAI-compatible server on your local network
- **Secure API key storage** — keys stored in the OS keychain (Windows Credential Manager / macOS Keychain) instead of localStorage
- **Auto-updates** — the app checks for new versions on launch and prompts to update

## 🏗️ How It Works

The app is a single-page application built with TypeScript, MapLibre GL JS, and Vite. Here's how the pieces fit together:

**`main.ts`** is the conductor. It boots the app, fetches datasets, reads the URL to decide what to show, and wires up all the UI controls (play/pause, scrubber, mute, keyboard shortcuts). When a user picks a dataset, `main.ts` coordinates the handoff between the old content and the new.

**`mapRenderer.ts`** owns the globe — it initializes MapLibre GL JS with globe projection, loads NASA GIBS Blue Marble and Black Marble raster tile sources, and manages navigation, markers, labels, boundaries, terrain, and region highlighting. It delegates visual effects to:

- **`earthTileLayer.ts`** is a MapLibre `CustomLayerInterface` that composites day/night shading, city lights (from Black Marble tiles via framebuffer capture), specular sun glint, clouds, and a starfield skybox using multi-pass WebGL2 shaders.
- **`datasetLoader.ts`** takes a dataset and figures out how to display it. For images, it tries progressively lower resolutions until one loads. For videos, it sets up HLS streaming through the proxy, waits for the first frame to decode, and attaches the video as a live texture on the globe.

**`dataService.ts`** is the data layer. It fetches the NOAA dataset catalog from S3 and a local enriched metadata file in parallel, then cross-references them by title to merge in descriptions, categories, keywords, and related datasets. Results are cached for an hour.

**`hlsService.ts`** manages video streaming. It fetches a manifest from the Vimeo proxy, sets up HLS.js with adaptive bitrate selection, and falls back to direct MP4 if HLS fails. It also detects whether the stream has an audio track.

**`browseUI.ts`** builds the dataset browser panel — the search box, category chips, sub-category filters, sorting, and the scrollable list of expandable dataset cards. When a user selects a dataset, it calls back to `main.ts` to load it.

A collapsible **Tools** menu (wrench icon) provides access to map overlays (labels, borders, terrain), globe layout selection, dataset info/legend toggles, and Orbit AI settings — all in one place.

**`playbackController.ts`** manages video playback state: play/pause toggling, frame stepping, scrubber synchronization, and closed caption loading.

**`docentService.ts`** orchestrates Orbit, the digital docent. It runs a local keyword engine instantly (always available, no network required), then streams a richer response from an LLM in parallel. If the LLM is unavailable it falls back to the local engine transparently. The LLM is instructed to embed `<<LOAD:DATASET_ID>>` markers in its response; the service parses these into load actions that appear as inline buttons in the chat panel.

**`time.ts`** and **`fetchProgress.ts`** are small utilities — one parses ISO 8601 durations and maps video playback time to real-world dates, the other wraps `fetch` to report download progress as a percentage.

## 🚀 Quick Start

### Prerequisites
- Modern browser (Chrome 90+, Firefox 88+, Safari 15+, Edge 90+)

### Option 1: Docker (Recommended)
The project includes a Docker dev container with all dependencies pre-configured.

```bash
# Start the development container
# (VS Code Dev Containers extension will prompt you)
# Or manually:
docker-compose up

# The app will open at http://localhost:5173
```

### Option 2: Local Development
If you prefer to run locally:

**Prerequisites:**
- Node.js 18+ and npm/pnpm
- Git

```bash
# Install dependencies
npm install
# or
pnpm install

# Start dev server
npm run dev
# or
pnpm dev

# The app will open at http://localhost:5173
```

### Option 3: Desktop App Development

Requires everything from Option 2, plus [Rust](https://rustup.rs/).

```bash
# Install Rust (if not already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Run the desktop app in dev mode (hot reload)
npm run dev:desktop

# Build for release
npm run build:desktop
```

See [docs/DESKTOP_APP_PLAN.md](docs/DESKTOP_APP_PLAN.md) for the full desktop architecture and build details.

### Build for Production

```bash
# Web
npm run build
npm run preview

# Desktop (requires Rust)
npm run build:desktop
```

### Option 4: Catalog backend (Phase 1a)

The same repo also ships a node-hosted catalog backend that the
SPA can read from instead of the SOS S3 source. Designed for forks
that want to operate their own dataset catalog. Self-contained — no
extra services required for local development.

```bash
# 1. Generate the node identity keypair (one-time per clone).
npm run gen:node-key

# 2. Reset the local D1 (apply migrations + seed ~20 SOS rows).
npm run db:reset

# 3. Configure the publisher-API dev bypass.
cp .dev.vars.example .dev.vars
# Edit .dev.vars to keep DEV_BYPASS_ACCESS=true.

# 4. Start the Pages Functions runtime in pane 1.
npm run dev:functions
# → Ready on http://localhost:8788

# 5. (Optional) Run the SPA against the local backend.
cp .env.example .env.local
# Edit .env.local to enable VITE_CATALOG_SOURCE=node and
# VITE_DEV_API_TARGET=http://localhost:8788. Dev-container
# contributors should also set VITE_HOST=0.0.0.0.
npm run dev    # in pane 2

# 6. Verify.
curl http://localhost:8788/api/v1/catalog | jq '.datasets | length'
# → 20
```

The full developer walkthrough — bindings, data model, and the
publishing CLI — lives in
[docs/CATALOG_BACKEND_DEVELOPMENT.md](docs/CATALOG_BACKEND_DEVELOPMENT.md);
the architectural plan is
[docs/CATALOG_BACKEND_PLAN.md](docs/CATALOG_BACKEND_PLAN.md).

## 📁 Project Structure

```
terraviz/
├── src/                         # Web app (shared by web + desktop)
│   ├── index.html               #   Single-page app shell
│   ├── main.ts                  #   App entry point, dataset loading orchestration
│   ├── services/
│   │   ├── mapRenderer.ts       #   MapLibre GL JS globe, navigation, markers, terrain
│   │   ├── earthTileLayer.ts    #   Day/night blend, clouds, specular, sun, skybox
│   │   ├── datasetLoader.ts     #   Dataset loading (network + offline cache)
│   │   ├── dataService.ts       #   SOS metadata fetching & cross-reference caching
│   │   ├── hlsService.ts        #   HLS.js video streaming with adaptive bitrate
│   │   ├── downloadService.ts   #   Offline dataset download manager (desktop only)
│   │   ├── docentService.ts     #   Orbit orchestrator — hybrid LLM + local engine
│   │   ├── docentContext.ts     #   LLM system prompt, history compression
│   │   ├── docentEngine.ts      #   Local keyword-based fallback engine
│   │   └── llmProvider.ts       #   OpenAI-compatible SSE streaming client
│   ├── ui/
│   │   ├── chatUI.ts            #   Orbit chat panel — rendering, settings, events
│   │   ├── browseUI.ts          #   Dataset browser, search, category filtering
│   │   ├── downloadUI.ts        #   Download manager panel (desktop only)
│   │   ├── mapControlsUI.ts     #   Map controls — labels, boundaries, terrain toggles
│   │   └── playbackController.ts #  Video playback transport + portrait positioning
│   ├── types/
│   │   └── index.ts             #   TypeScript interfaces and type definitions
│   ├── data/
│   │   └── regions.ts           #   Region name → bounding box resolution
│   └── utils/
│       ├── time.ts              #   ISO 8601 parsing, date formatting
│       └── fetchProgress.ts     #   Fetch with byte-level progress reporting
├── src-tauri/                   # Desktop app (Tauri v2)
│   ├── tauri.conf.json          #   Window config, app metadata, updater, security
│   ├── capabilities/            #   Permission policies (network, filesystem)
│   ├── Cargo.toml               #   Rust dependencies
│   └── src/
│       ├── main.rs              #   Entry point — plugin registration, state setup
│       ├── tile_cache.rs        #   SHA-256 flat-file tile cache (GIBS tiles)
│       ├── keychain.rs          #   OS keychain for API key storage
│       ├── download_manager.rs  #   Dataset download with progress + cancellation
│       └── download_commands.rs #   Tauri commands for download operations
├── public/assets/               # Static assets (specular map, metadata, skybox)
├── functions/                   # Cloudflare Functions (web deploy only)
├── .github/workflows/           # CI/CD — web deploy, desktop build, release
├── docs/                        # Architecture docs and plans
├── vite.config.ts               # Shared Vite configuration
└── package.json                 # Dependencies and scripts
```

## 🎮 Usage

1. **Open the app** — a 3D globe loads with the default Earth view
2. **Browse datasets** — search by keyword or filter by category in the sidebar
3. **Select a dataset** — click a card to expand it, then load
   - **Images**: display on the sphere with a progress indicator
   - **Videos**: stream via HLS with playback controls and scrubber
4. **Interact with the globe**
   - **Desktop**: click-drag to rotate, scroll to zoom, double-click to reset
   - **Mobile/Tablet**: single-finger drag to rotate, two-finger pinch to zoom
5. **Deep-link** — share a specific dataset via `?dataset=INTERNAL_SOS_768`


## 🤖 Orbit — Digital Docent

Orbit is a conversational AI guide embedded in the globe. Click **Ask Orbit** to open the chat panel.

### Capabilities

- Explains datasets in plain language
- Recommends relevant datasets for a given topic
- Loads a dataset directly onto the globe from the conversation
- Cross-links to the browse panel for deeper exploration

### Architecture

`docentService.processMessage()` uses a **hybrid approach**:

1. **Local engine** (`docentEngine.ts`) — instant keyword matching, always available offline
2. **LLM stream** (`llmProvider.ts`) — richer conversational responses via any OpenAI-compatible API

If the LLM is unavailable or returns an error the local engine handles the response automatically.

### Dataset loading from chat

The LLM embeds `<<LOAD:DATASET_ID>>` markers inline with its response text. `docentService.ts` parses these (and bare `INTERNAL_...` IDs as a fallback) into `action` chunks. `chatUI.ts` converts each action into an inline load button rendered inside the message bubble.

### LLM configuration

Any OpenAI-compatible endpoint works: OpenAI, Ollama, LM Studio, Cloudflare AI Gateway, llama.cpp, vLLM. Configure in the Orbit settings panel (gear icon). Settings are persisted in `localStorage` under `sos-docent-config`.

> **Desktop app**: API keys are stored in the OS keychain (Windows Credential Manager / macOS Keychain) instead of localStorage. The Tauri HTTP plugin bypasses webview CORS, so you can connect directly to local LLM servers on your network.

> **Local dev (web)**: The Cloudflare `/api` proxy is unavailable on localhost. Set a direct API URL in Orbit settings, or disable LLM to use the local keyword engine only.

| Setting | Default | Notes |
|---|---|---|
| API URL | `/api` | Cloudflare proxy in production |
| Model | `llama-3.1-70b` | Dropdown populated from `/models` endpoint |
| API Key | _(empty)_ | Optional Bearer token |
| Enabled | on | Toggle LLM; falls back to local engine |

---

## 🔍 Debugging

### Browser Console
```javascript
// Access the app instance
window.app

// Check loaded datasets
window.app.appState.datasets.length

// Check current dataset
window.app.appState.currentDataset
```

### Remote-debugging WebXR on Meta Quest

The immersive AR/VR mode only runs on a real headset, so the browser console
output has to come from the headset itself. Chrome on the PC can attach to the
Meta Quest Browser over USB:

1. **Enable Developer Mode on the Quest** — Meta account → Devices → pair the
   headset → toggle Developer Mode on.
2. **Install adb + the Quest USB driver** — macOS: `brew install android-platform-tools`,
   Linux: `apt install android-tools-adb`, Windows: Meta Quest ADB driver.
3. **Plug the Quest into the PC via USB-C**. Put on the headset and accept the
   "Allow USB debugging" prompt.
4. **Verify the device is visible:**
   ```bash
   adb devices
   ```
5. **Reverse-forward the dev server port** so the Quest can reach it as localhost:
   ```bash
   adb reverse tcp:5173 tcp:5173
   ```
   (WebXR requires HTTPS or localhost; reverse forwarding keeps you on localhost.)
6. **Start the dev server** on the PC: `npm run dev`.
7. **In the Quest browser**, navigate to `http://localhost:5173`.
8. **On the PC**, open Chrome and visit `chrome://inspect#devices`. Under
   **Remote Target → Quest**, click **inspect** next to your app's tab.
9. In the DevTools Console, open the **Default levels** dropdown and check
   **Verbose** so `logger.debug` lines show up.
10. Put the headset back on, tap **Enter AR** / **Enter VR**, and return to the
    PC DevTools Console — the `[VR]` logs will be there.

If you unplug the headset at any point the port forward drops and needs to be
re-run (step 5). `adb reverse --list` shows active forwards.

### Common Issues

**"Failed to fetch datasets"**
- Check internet connection
- Verify CORS isn't blocking S3 requests
- Try refreshing page

**"Failed to load image"**
- Check image URL is accessible
- Some S3 images might have CORS restrictions
- Open the URL directly in browser to verify

**Sphere not rendering**
- Check WebGL support (most modern browsers)
- Check DevTools console for WebGL/MapLibre errors
- Try a different browser

**Touch controls not working**
- Ensure device supports touch events
- Check browser DevTools touch simulation

## 🎯 What's Next

See **[ROADMAP.md](ROADMAP.md)** for the web app roadmap and **[docs/DESKTOP_APP_PLAN.md](docs/DESKTOP_APP_PLAN.md)** for the desktop roadmap.

### Desktop (Phase 5 — ongoing)
- Kiosk mode for museum/exhibit deployments
- Local LLM via Ollama sidecar (fully offline Orbit)
- Multi-monitor exhibit mode
- Offline video pre-loading for curated collections
- Deep linking protocol (`sos://dataset/INTERNAL_SOS_768`)

### Web
- Screen reader support (beyond current ARIA labels)
- Embeddable iframe mode for educators

## 📚 Key Files to Review

- **[ROADMAP.md](ROADMAP.md)** - Prioritized web app roadmap
- **[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)** - Deploy your own Terraviz instance on Cloudflare Pages (Pages, D1, AE, KV, Access, Grafana)
- **[docs/ANALYTICS.md](docs/ANALYTICS.md)** - Analytics pipeline reference (schema, privacy posture, how to add events)
- **[docs/ANALYTICS_CONTRIBUTING.md](docs/ANALYTICS_CONTRIBUTING.md)** - Contributor + reviewer guide for analytics changes (privacy invariants, review checklist)
- **[docs/PRIVACY.md](docs/PRIVACY.md)** - User-facing privacy policy
- **[docs/DESKTOP_APP_PLAN.md](docs/DESKTOP_APP_PLAN.md)** - Desktop app architecture and phases
- **[STYLE_GUIDE.md](STYLE_GUIDE.md)** - UI design language (colors, surfaces, components)
- **[CLAUDE.md](CLAUDE.md)** - Codebase instructions for AI-assisted development
- **[MISSION.md](MISSION.md)** - Project mission
- **src/types/index.ts** - TypeScript type definitions
- **src/services/dataService.ts** - Dataset fetching and cross-reference caching
- **src/services/mapRenderer.ts** - MapLibre globe renderer
- **src-tauri/tauri.conf.json** - Desktop app configuration

## 🐛 Reporting Issues

When you find issues, note:
1. Browser and OS
2. Console errors (if any)
3. Steps to reproduce
4. Expected vs actual behavior
5. Network tab insights (if data-related)

## 📝 Notes

- **CORS**: All external APIs (S3, Vimeo proxy) require CORS headers. Tests locally with `npm run dev`.
- **Performance**: MapLibre tile cache and zoom limits are configured in `mapRenderer.ts`.
- **Mobile**: The UI is responsive, but best tested on actual devices, not just browser DevTools.
- **Time Data**: Some datasets lack startTime/endTime. Graceful fallback to "Static Image" or "Frame X of Y".

## 🔗 Resources

- **SOS Project**: https://sos.noaa.gov/
- **Dataset Metadata**: https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/dataset.json
- **Video Proxy**: https://video-proxy.zyra-project.org/video/{VIMEO_ID}
- **MapLibre GL JS Docs**: https://maplibre.org/maplibre-gl-js/docs/
- **NASA GIBS**: https://nasa-gibs.github.io/gibs-api-docs/
- **HLS.js Docs**: https://hlsjs.readthedocs.io/

---

**Created**: March 20, 2026
