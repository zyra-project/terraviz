# Tile Caching Architecture

NASA GIBS tiles (Blue Marble, Black Marble) are static imagery that never changes, making them ideal for aggressive, multi-layer caching. This document describes the caching strategies used to minimize tile loading latency during globe rotation.

## Caching Layers

Requests flow through up to three cache layers before hitting the GIBS origin:

```
Browser ──> Service Worker ──> Cloudflare Edge ──> GIBS Origin
            (Cache API)        (CF cache, 1yr)     (gibs.earthdata.nasa.gov)
```

### 1. Service Worker (client-side, persistent)

**File:** `public/sw.js`

A cache-first service worker intercepts tile requests and serves them from the browser's Cache API. On cache miss, it fetches from the network and stores the response for future use.

**What it caches:**
- `/api/tile/*` — proxied GIBS tile requests (same-origin)
- `gibs.earthdata.nasa.gov/wmts/epsg3857/best/*` — direct GIBS requests (if any)
- `s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/*` — cloud texture
- `/assets/skybox/*`, `/assets/Earth_Specular_2K.jpg`, `/assets/Earth_Normal_2K.jpg`

**Cache name:** `gibs-tiles-v1` (old versions are cleaned up on activate)

**Registration:** `src/main.ts` registers the SW before `DOMContentLoaded`. The SW uses `skipWaiting()` and `clients.claim()` to activate immediately.

**Error handling:** `request.clone()` is used for every `fetch()` call. `cache.put()` failures (e.g., quota exceeded) are caught silently — the response is still returned to the caller.

**Headers:** `public/_headers` sets `Cache-Control: no-cache` on `/sw.js` so the browser always checks for SW updates.

### 2. Cloudflare Edge Proxy

**File:** `functions/api/tile/[[path]].ts`

A Cloudflare Pages Function proxies tile requests to GIBS and caches them at the nearest Cloudflare PoP. This reduces first-visit latency from ~200ms (GIBS origin) to ~20ms (edge).

**URL mapping:**
```
/api/tile/BlueMarble_NextGeneration/default/2004-08/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg
  --> https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/...
```

**Cache behavior:**
- Cloudflare edge: `cf.cacheEverything: true, cf.cacheTtl: 31536000` (1 year)
- Browser: `Cache-Control: public, max-age=31536000, immutable`

**Security:**
- Only `BlueMarble_NextGeneration/` and `VIIRS_Black_Marble/` prefixes are allowed (prevents open-proxy abuse)
- Path traversal (`..`, `.`, `/`, `\`) is rejected
- Malformed percent-encoding returns 400
- No CORS headers (same-origin only)

### 3. MapLibre In-Memory Tile Cache

**File:** `src/services/mapRenderer.ts`

MapLibre's built-in tile cache is increased from the default (~512 tiles) to reduce re-fetching during interactive rotation within a single session.

| Device  | `maxTileCacheSize` |
|---------|--------------------|
| Desktop | 2000               |
| Mobile  | 750                |

## Tile Preloader

**File:** `src/services/tilePreloader.ts`

After the map loads, low-zoom tiles (z0-z3) are eagerly fetched in the background. This is only 170 tiles (~5-6 MB) covering the entire globe at the default view zoom.

| Setting            | Desktop                  | Mobile                            |
|--------------------|--------------------------|-----------------------------------|
| Concurrency        | 6 parallel fetches       | 2 parallel fetches                |
| Trigger            | After map `load` event   | After map `idle` event            |
| Slow network (2g)  | Always preloads          | Skipped entirely                  |

The preloader populates both the SW cache (via the fetch event handler) and the Cloudflare edge cache.

## Device Capability Detection

**File:** `src/utils/deviceCapability.ts`

Exports:
- `isMobile()` — true when viewport is narrow (<=768px) or device has touch input
- `isSlowNetwork()` — true when Network Information API reports 2g/slow-2g
- `getCloudTextureUrl()` — returns 4K cloud texture URL on mobile, 8K on desktop

## Deferred Texture Loading

**File:** `src/services/earthTileLayer.ts`

Non-critical textures are loaded via `requestIdleCallback` (with timeout fallbacks) so they don't compete with tile bandwidth during initial load:

| Texture       | Defer method                                    |
|---------------|-------------------------------------------------|
| Skybox faces  | `requestIdleCallback` with `{ timeout: 2000 }`  |
| Specular map  | `requestIdleCallback` with `{ timeout: 1000 }`  |
| Cloud texture | Loaded eagerly (visible on the globe immediately)|

All texture `onload`/`onerror` handlers check a `disposed` flag to prevent WebGL calls on deleted resources if the layer is removed before loading completes.

## Tile Sources

Both tile layers use GIBS WMTS endpoints via the Cloudflare edge proxy:

| Layer         | Format | Max Zoom | Tiles at z0-z3 |
|---------------|--------|----------|----------------|
| Blue Marble   | JPG    | 8        | 85             |
| Black Marble  | PNG    | 8        | 85             |

**Total preloaded:** 170 tiles across both layers.
