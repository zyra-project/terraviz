# Interactive Sphere — Proof of Concept

[![Live Demo](https://img.shields.io/badge/Live_Demo-sphere.zyra--project.org-4da6ff)](https://sphere.zyra-project.org)

A WebGL-based globe that streams environmental data from the [Science On a Sphere](https://sos.noaa.gov/) project.

![SOS Explorer interface showing the Earth globe with the dataset browse panel](initial-interface.jpg)

## ✨ Features

- Searchable, filterable dataset browser with category and sub-category navigation, expandable cards, and thumbnails
- Interactive 3D globe with MapLibre GL JS (rotation, zoom, inertia on desktop and mobile, geographic labels, boundaries, 3D terrain)
- NASA GIBS tile-based Earth (Blue Marble day, Black Marble night lights with progressive zoom detail, specular highlights, sun lighting, real-time cloud overlay, atmosphere)
- Static image datasets with resolution fallback (4096/2048/1024) and download progress
- HLS video streaming via Vimeo proxy with adaptive bitrate, playback controls, and audio
- Time synchronization with ISO 8601 parsing and scrubber
- **Orbit** — an AI digital docent that answers questions, explains datasets, and loads them onto the globe by conversation (hybrid LLM + local keyword engine, configurable to any OpenAI-compatible provider)
- Collapsible browse panel (desktop sidebar with toggle)
- Accessible controls (ARIA labels, keyboard navigation)
- Frosted-glass UI design language (see [STYLE_GUIDE.md](STYLE_GUIDE.md))

## 🏗️ How It Works

The app is a single-page application built with TypeScript, MapLibre GL JS, and Vite. Here's how the pieces fit together:

**`main.ts`** is the conductor. It boots the app, fetches datasets, reads the URL to decide what to show, and wires up all the UI controls (play/pause, scrubber, mute, keyboard shortcuts). When a user picks a dataset, `main.ts` coordinates the handoff between the old content and the new.

**`mapRenderer.ts`** owns the globe — it initializes MapLibre GL JS with globe projection, loads NASA GIBS Blue Marble and Black Marble raster tile sources, and manages navigation, markers, labels, boundaries, terrain, and region highlighting. It delegates visual effects to:

- **`earthTileLayer.ts`** is a MapLibre `CustomLayerInterface` that composites day/night shading, city lights (from Black Marble tiles via framebuffer capture), specular sun glint, clouds, and a starfield skybox using multi-pass WebGL2 shaders.
- **`datasetLoader.ts`** takes a dataset and figures out how to display it. For images, it tries progressively lower resolutions until one loads. For videos, it sets up HLS streaming through the proxy, waits for the first frame to decode, and attaches the video as a live texture on the globe.

**`dataService.ts`** is the data layer. It fetches the NOAA dataset catalog from S3 and a local enriched metadata file in parallel, then cross-references them by title to merge in descriptions, categories, keywords, and related datasets. Results are cached for an hour.

**`hlsService.ts`** manages video streaming. It fetches a manifest from the Vimeo proxy, sets up HLS.js with adaptive bitrate selection, and falls back to direct MP4 if HLS fails. It also detects whether the stream has an audio track.

**`browseUI.ts`** builds the dataset browser panel — the search box, category chips, sub-category filters, sorting, and the scrollable list of expandable dataset cards. When a user selects a dataset, it calls back to `main.ts` to load it.

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

### Build for Production

```bash
npm run build
npm run preview
```

## 📁 Project Structure

```
interactive-sphere/
├── src/
│   ├── index.html               # Single-page app shell
│   ├── main.ts                  # App entry point, dataset loading orchestration
│   ├── types/
│   │   └── index.ts             # TypeScript interfaces and type definitions
│   ├── services/
│   │   ├── mapRenderer.ts       # MapLibre GL JS globe, navigation, markers, terrain
│   │   ├── earthTileLayer.ts    # Day/night blend, clouds, specular, sun, skybox
│   │   ├── datasetLoader.ts     # Dataset loading and texture application
│   │   ├── dataService.ts       # SOS metadata fetching & cross-reference caching
│   │   ├── hlsService.ts        # HLS.js video streaming with adaptive bitrate
│   │   ├── docentService.ts     # Orbit orchestrator — hybrid LLM + local engine
│   │   ├── docentContext.ts     # LLM system prompt, history compression
│   │   ├── docentEngine.ts      # Local keyword-based fallback engine
│   │   └── llmProvider.ts       # OpenAI-compatible SSE streaming client
│   ├── ui/
│   │   ├── chatUI.ts            # Orbit chat panel — rendering, settings, events
│   │   ├── browseUI.ts          # Dataset browser, search, category filtering
│   │   ├── mapControlsUI.ts     # Map controls — labels, boundaries, terrain toggles
│   │   └── playbackController.ts # Video playback transport + portrait positioning
│   ├── data/
│   │   └── regions.ts           # Region name → bounding box resolution
│   └── utils/
│       ├── time.ts              # ISO 8601 parsing, date formatting
│       └── fetchProgress.ts     # Fetch with byte-level progress reporting
├── public/
│   └── assets/
│       ├── Earth_Specular_2K.jpg        # Specular map for ocean reflections
│       ├── sos_dataset_metadata.json    # Enriched metadata (520+ datasets)
│       └── skybox/                      # Milky Way cube map (6 faces)
├── .devcontainer/          # Docker dev container config
├── vite.config.ts          # Vite configuration
├── vitest.config.ts        # Test configuration
├── tsconfig.json           # TypeScript configuration
├── package.json            # Dependencies and scripts
├── Dockerfile              # Container image definition
├── docker-compose.yml      # Container orchestration
└── README.md               # This file
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

> **Local dev**: The Cloudflare `/api` proxy is unavailable on localhost. Set a direct API URL in Orbit settings, or disable LLM to use the local keyword engine only.

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

See **[ROADMAP.md](ROADMAP.md)** for the full prioritized roadmap. Key remaining items:

### Reach More People
- Screen reader support (beyond current ARIA labels)

### Keep Them Engaged
- Persistent error messages (stay visible until dismissed)

### Code Health
- Log level control for production builds
- Debounce the window resize handler

### Longer Term
- Offline and low-connectivity support for classrooms
- Embeddable iframe mode for educators

## 📚 Key Files to Review

- **[ROADMAP.md](ROADMAP.md)** - Prioritized roadmap
- **[STYLE_GUIDE.md](STYLE_GUIDE.md)** - UI design language (colors, surfaces, components)
- **[MISSION.md](MISSION.md)** - Project mission
- **src/types/index.ts** - TypeScript type definitions
- **src/services/dataService.ts** - Dataset fetching and cross-reference caching
- **src/services/mapRenderer.ts** - MapLibre globe renderer

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
