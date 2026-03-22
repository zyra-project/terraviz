# Interactive Sphere — Agent Guide

## Project Overview

WebGL globe (Three.js + Vite + TypeScript) that renders NOAA Science On a Sphere datasets on a 3D sphere with a Milky Way skybox. Supports both static image datasets and HLS video streaming from Vimeo.

## Architecture

```
src/
  index.html          — Single-page app shell, minimal UI overlays
  main.ts             — App entry point, dataset loading, playback controls
  types/index.ts      — All TypeScript interfaces
  services/
    sphereRenderer.ts — Three.js scene, sphere, skybox, cloud overlay, controls
    dataService.ts    — Fetches & cross-references SOS metadata, caches datasets
    hlsService.ts     — HLS.js video streaming, manifest fetching, playback
    videoFrameExtractor.ts — Extracts video frames to canvas for sphere texture
  utils/
    time.ts           — ISO 8601 parsing, date formatting, video-to-date mapping
public/
  assets/
    Earth_Diffuse_6K.jpg         — Default Earth texture
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

## Key Conventions

- Vite root is `./src`, public dir is `../public`
- Three.js 0.160, use `colorSpace` not `encoding`
- Sphere rotation uses inertia/damping physics (not mechanical)
- Skybox is a BoxGeometry mesh (not scene.background) so it rotates with the globe
- Cloud overlay uses non-linear alpha curve (power 0.55) for fine detail
- The `_work/` directory contains planning docs, screenshots, and working files — not served
- All screenshots, scratch files, and temporary outputs go in `_work/`, never the project root

## Working Files

All scratch files, planning docs, and source assets go in `_work/`, not the project root.
