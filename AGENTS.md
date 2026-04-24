# Terraviz — Agent Guide

## Project Overview

WebGL globe (MapLibre GL JS + Vite + TypeScript) that renders NOAA Science On a Sphere datasets on an interactive 3D globe with NASA GIBS tiles, day/night lighting, and a Milky Way skybox. Supports both static image datasets and HLS video streaming from Vimeo.

## Architecture

```
src/
  index.html               — Single-page app shell
  main.ts                  — App entry point, dataset loading orchestration
  types/index.ts           — All TypeScript interfaces
  services/
    mapRenderer.ts         — MapLibre GL JS globe, GIBS tiles, navigation, markers, terrain
    earthTileLayer.ts      — Day/night blend, clouds, specular, sun, skybox (CustomLayerInterface)
    datasetLoader.ts       — Dataset loading and texture application
    dataService.ts         — Fetches & cross-references SOS metadata, caches datasets
    hlsService.ts          — HLS.js video streaming with adaptive bitrate
    docentService.ts       — Orbit orchestrator — hybrid LLM + local engine
    docentContext.ts       — LLM system prompt, tools, history compression
    docentEngine.ts        — Local keyword-based fallback engine
    llmProvider.ts         — OpenAI-compatible SSE streaming client
  ui/
    chatUI.ts              — Orbit chat panel — rendering, settings, events
    browseUI.ts            — Dataset browser, search, category/sub-category filtering
    mapControlsUI.ts       — Map controls — labels, boundaries, terrain toggles
    playbackController.ts  — Video playback state and controls
  data/
    regions.ts             — Region name → bounding box resolution
  utils/
    time.ts                — ISO 8601 parsing, date formatting, video-to-date mapping
    fetchProgress.ts       — Fetch with byte-level progress reporting
public/
  assets/
    Earth_Specular_2K.jpg        — Specular map for ocean reflections
    sos_dataset_metadata.json    — Enriched metadata (520 datasets from NOAA catalog)
    skybox/                      — Milky Way cube map (6 faces, 2048x2048 JPEG)
```

## How Datasets Load

Datasets are specified via URL query param: `?dataset=INTERNAL_SOS_768`

1. `dataService` fetches the S3 dataset.json and local enriched metadata in parallel
2. Cross-references by normalized title to merge rich descriptions, categories, keywords
3. `main.ts` reads the `?dataset=` param and calls `displayDataset(id)`
4. Image datasets load directly from CloudFront CDN
5. Video datasets: extract Vimeo ID → query proxy at `video-proxy.zyra-project.org` → stream HLS → extract frames to sphere texture

No dataset param = default Earth with real-time cloud overlay.

## Data Sources

- **S3 metadata**: `https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/dataset.json`
- **Video proxy**: `https://video-proxy.zyra-project.org/video/{VIMEO_ID}`
- **Cloud overlay**: `https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/clouds_8192.jpg`
- **Image CDN**: `https://d3sik7mbbzunjo.cloudfront.net/...`

## Development

### Docker (Recommended)
The project includes a `.devcontainer/` configuration for VS Code Dev Containers.

```bash
# Start the dev container
docker-compose up

# Inside the container:
npm run dev          # Vite dev server at http://localhost:5173
npm run type-check   # TypeScript check
npm run build        # Production build to dist/
```

### Local Development
```bash
npm install
npm run dev          # Vite dev server at http://localhost:5173
npm run type-check   # TypeScript check
npm run build        # Production build to dist/
```

## Repository

**Remote:** `https://gitlab.sos.noaa.gov/science-on-a-sphere/explorer/sandbox/interactive-sphere.git`

```bash
git remote -v  # Verify remote is set
git clone https://gitlab.sos.noaa.gov/science-on-a-sphere/explorer/sandbox/interactive-sphere.git
```

## UI Style Guide

See **[STYLE_GUIDE.md](STYLE_GUIDE.md)** for the complete visual design language — frosted-glass surfaces, color palette, typography, component specs, and mobile adaptations. All UI overlays must follow this guide for visual consistency.

## Key Conventions

- Vite root is `./src`, public dir is `../public`
- MapLibre GL JS 5.x with globe projection
- NASA GIBS tiles for Earth base (Blue Marble day, Black Marble night)
- Day/night blending via CustomLayerInterface with framebuffer capture
- Cloud overlay uses non-linear alpha curve (gamma 1.8) in WebGL2 shader
- Skybox rendered as a separate 3D custom layer with cubemap sampling
- Test files are co-located with source files (e.g., `main.test.ts`, `dataService.test.ts`)
