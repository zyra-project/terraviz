# Interactive Sphere - POC Setup

[![Live Demo](https://img.shields.io/badge/Live_Demo-sphere.zyra--project.org-4da6ff)](https://sphere.zyra-project.org)

This is the proof-of-concept for Interactive Sphere, a WebGL-based globe that streams environmental data from the [Science On a Sphere](https://sos.noaa.gov/) project.

![SOS Explorer interface showing the Earth globe with the dataset browse panel](initial-interface.jpg)

## ✨ POC Scope

What's been built:
- ✅ Fetch and filter datasets from SOS metadata API (image/video only)
- ✅ Render interactive 3D sphere with Three.js
- ✅ Enhanced Earth materials (normal maps, specular, night lights, sun lighting, clouds, atmosphere)
- ✅ Load and display static images with resolution fallback (4096/2048/1024)
- ✅ HLS video streaming via Vimeo proxy with playback controls
- ✅ Time synchronization with ISO 8601 parsing and scrubber
- ✅ Dataset browser with search, category filtering, expandable cards with thumbnails
- ✅ Collapsible browse panel (desktop sidebar with toggle)
- ✅ Touch controls (rotation, zoom, inertia) on mobile and desktop
- ✅ Frosted-glass UI design language (see [STYLE_GUIDE.md](STYLE_GUIDE.md))
- ✅ Audio mute/unmute for video datasets

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
│   ├── index.html          # Single-page app shell, minimal UI overlays
│   ├── main.ts             # App entry point, dataset loading, playback controls
│   ├── types/
│   │   └── index.ts        # TypeScript interfaces and type definitions
│   ├── services/
│   │   ├── sphereRenderer.ts    # Three.js scene, sphere, skybox, cloud overlay
│   │   ├── dataService.ts       # SOS metadata fetching & cross-reference caching
│   │   ├── hlsService.ts        # HLS.js video streaming and manifests
│   │   └── videoFrameExtractor.ts # Extract video frames to sphere texture
│   └── utils/
│       └── time.ts         # ISO 8601 parsing, date formatting, video-to-date mapping
├── public/
│   └── assets/
│       ├── Earth_Diffuse_6K.jpg         # Default Earth texture
│       ├── sos_dataset_metadata.json    # Enriched metadata (520+ datasets)
│       └── skybox/                      # Milky Way cube map (6 faces)
├── .devcontainer/          # Docker dev container config
├── vite.config.ts          # Vite configuration
├── tsconfig.json           # TypeScript configuration
├── package.json            # Dependencies and scripts
├── Dockerfile              # Container image definition
├── docker-compose.yml      # Container orchestration
└── README.md               # This file
```

## 🎮 Using the POC

1. **Open the app** - A 3D globe will load with default material
2. **Select a dataset** - Choose from 160+ videos and images (grouped by type)
3. **Click "Load Selected Dataset"**
   - Images: Will display on the sphere immediately
   - Videos: Will show a placeholder (full HLS streaming in Phase 2)
4. **Interact with the globe**
   - **Desktop**: Click-drag to rotate, scroll to zoom, double-click to reset
   - **Mobile/Tablet**: Single-finger drag to rotate, two-finger pinch to zoom

## 🧪 Testing Checklist

### Data Loading ✅
- [ ] Metadata loads successfully (check DevTools console)
- [ ] Dataset list populates with 600+ items
- [ ] Can filter by video/image types
- [ ] Dataset info displays correctly

### Image Datasets
- [ ] Select an image dataset (e.g., "Plate Boundaries")
- [ ] Image loads on sphere without errors
- [ ] Image displays equirectangular (wrapped around sphere)
- [ ] Can rotate/zoom sphere

### Video Placeholder
- [ ] Select a video dataset (e.g., "Hurricane Season 2024")
- [ ] Placeholder image shows on sphere
- [ ] Playback controls appear

### Globe Interaction
- [ ] **Desktop**: Drag rotates, scroll zooms, double-click resets
- [ ] **Mobile**: Single drag rotates, pinch zooms
- [ ] **Orientation**: Works in portrait and landscape

### Performance
- Load time < 3 seconds on desktop
- Smooth 60fps rotating sphere
- No console errors

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

## 📊 Performance Targets (Phase 1)

| Metric | Target | Current |
|--------|--------|---------|
| Initial load | < 3s | TBD |
| First paint | < 1s | TBD |
| Frame rate | 60fps | TBD |
| Mobile load | < 5s | TBD |

## 🎯 What's Next

See **[ROADMAP.md](ROADMAP.md)** for the full prioritized roadmap. Key remaining items:

### Reach More People
- Accessibility overhaul (ARIA labels, keyboard navigation, screen reader support)
- Mobile HLS adaptive quality (match stream quality to actual bandwidth)

### Keep Them Engaged
- Smoother dataset transitions and loading states
- Persistent error messages (stay visible until dismissed)

### Code Health
- Break up large files (`sphereRenderer.ts`, `main.ts`)
- Test coverage for orchestration logic in `main.ts`
- Replace magic numbers with named constants
- Log level control for production builds

### Longer Term
- Offline and low-connectivity support for classrooms
- Embeddable iframe mode for educators

## 📚 Key Files to Review

- **[PROJECT_PLAN.md](PROJECT_PLAN.md)** - Complete architecture and specifications
- **[PRE_DEVELOPMENT_CHECKLIST.md](PRE_DEVELOPMENT_CHECKLIST.md)** - Design decisions and considerations
- **[STYLE_GUIDE.md](STYLE_GUIDE.md)** - UI design language (colors, surfaces, components)
- **src/services/dataService.ts** - How we fetch and manage datasets
- **src/services/sphereRenderer.ts** - Three.js sphere implementation
- **src/types/index.ts** - TypeScript type definitions (read first!)

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
**Status**: Proof of Concept
