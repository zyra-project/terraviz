# Interactive Sphere — Proof of Concept

[![Live Demo](https://img.shields.io/badge/Live_Demo-sphere.zyra--project.org-4da6ff)](https://sphere.zyra-project.org)

A WebGL-based globe that streams environmental data from the [Science On a Sphere](https://sos.noaa.gov/) project.

![SOS Explorer interface showing the Earth globe with the dataset browse panel](initial-interface.jpg)

## ✨ Features

- Searchable, filterable dataset browser with category and sub-category navigation, expandable cards, and thumbnails
- Interactive 3D sphere with Three.js (rotation, zoom, inertia on desktop and mobile)
- Enhanced Earth materials (normal maps, specular highlights, night lights, sun lighting, real-time cloud overlay, atmosphere)
- Static image datasets with resolution fallback (4096/2048/1024) and download progress
- HLS video streaming via Vimeo proxy with adaptive bitrate, playback controls, and audio
- Time synchronization with ISO 8601 parsing and scrubber
- Collapsible browse panel (desktop sidebar with toggle)
- Accessible controls (ARIA labels, keyboard navigation)
- Frosted-glass UI design language (see [STYLE_GUIDE.md](STYLE_GUIDE.md))

## 🏗️ How It Works

The app is a single-page application built with TypeScript, Three.js, and Vite. Here's how the pieces fit together:

**`main.ts`** is the conductor. It boots the app, fetches datasets, reads the URL to decide what to show, and wires up all the UI controls (play/pause, scrubber, mute, keyboard shortcuts). When a user picks a dataset, `main.ts` coordinates the handoff between the old content and the new.

**`sphereRenderer.ts`** owns the 3D scene — the camera, the WebGL renderer, and the animation loop. It creates the sphere, loads the starfield skybox, and delegates specialized work to three helpers:

- **`earthMaterials.ts`** handles everything that makes the default Earth look realistic: the diffuse texture, normal and specular maps, night-side city lights, a cloud layer fetched from NOAA, an atmospheric glow shell, and sun lighting positioned to match the real sun.
- **`inputHandler.ts`** turns mouse drags and touch gestures into sphere rotation with momentum and damping. It also tracks where the cursor hits the sphere to show latitude/longitude coordinates.
- **`datasetLoader.ts`** takes a dataset and figures out how to display it. For images, it tries progressively lower resolutions until one loads. For videos, it sets up HLS streaming through the proxy, waits for the first frame to decode, and attaches the video as a live texture on the sphere.

**`dataService.ts`** is the data layer. It fetches the NOAA dataset catalog from S3 and a local enriched metadata file in parallel, then cross-references them by title to merge in descriptions, categories, keywords, and related datasets. Results are cached for an hour.

**`hlsService.ts`** manages video streaming. It fetches a manifest from the Vimeo proxy, sets up HLS.js with adaptive bitrate selection, and falls back to direct MP4 if HLS fails. It also detects whether the stream has an audio track.

**`browseUI.ts`** builds the dataset browser panel — the search box, category chips, sub-category filters, sorting, and the scrollable list of expandable dataset cards. When a user selects a dataset, it calls back to `main.ts` to load it.

**`playbackController.ts`** manages video playback state: play/pause toggling, frame stepping, scrubber synchronization, and closed caption loading.

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
│   │   ├── sphereRenderer.ts    # Three.js scene, sphere, skybox
│   │   ├── earthMaterials.ts    # Earth textures, atmosphere, sun lighting, clouds
│   │   ├── inputHandler.ts      # Mouse/touch controls, rotation, zoom, inertia
│   │   ├── datasetLoader.ts     # Dataset loading and texture application
│   │   ├── dataService.ts       # SOS metadata fetching & cross-reference caching
│   │   ├── hlsService.ts        # HLS.js video streaming with adaptive bitrate
│   │   └── videoFrameExtractor.ts # Video frame extraction to sphere texture
│   ├── ui/
│   │   ├── browseUI.ts          # Dataset browser, search, category filtering
│   │   └── playbackController.ts # Video playback state and controls
│   └── utils/
│       ├── time.ts              # ISO 8601 parsing, date formatting
│       └── fetchProgress.ts     # Fetch with byte-level progress reporting
├── public/
│   └── assets/
│       ├── Earth_Diffuse_6K.jpg         # Default Earth texture
│       ├── Earth_Normal_2K.jpg          # Normal map for surface detail
│       ├── Earth_Specular_2K.jpg        # Specular map for ocean reflections
│       ├── Earth_Lights_6K.jpg          # Night-side city lights
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
- Check DevTools console for Three.js errors
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
- **src/services/sphereRenderer.ts** - Three.js scene orchestration

## 🐛 Reporting Issues

When you find issues, note:
1. Browser and OS
2. Console errors (if any)
3. Steps to reproduce
4. Expected vs actual behavior
5. Network tab insights (if data-related)

## 📝 Notes

- **CORS**: All external APIs (S3, Vimeo proxy) require CORS headers. Tests locally with `npm run dev`.
- **Performance**: LOD (level of detail) settings in `sphereRenderer.ts` can be adjusted for slower devices.
- **Mobile**: The UI is responsive, but best tested on actual devices, not just browser DevTools.
- **Time Data**: Some datasets lack startTime/endTime. Graceful fallback to "Static Image" or "Frame X of Y".

## 🔗 Resources

- **SOS Project**: https://sos.noaa.gov/
- **Dataset Metadata**: https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/dataset.json
- **Video Proxy**: https://video-proxy.zyra-project.org/video/{VIMEO_ID}
- **Three.js Docs**: https://threejs.org/docs/
- **HLS.js Docs**: https://hlsjs.readthedocs.io/

---

**Created**: March 20, 2026
