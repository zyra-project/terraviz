# MapLibre GL JS Globe Migration Plan

## Executive Summary

Replace the custom Three.js sphere renderer with MapLibre GL JS v5+ as the primary globe engine. The default Earth view uses **NASA GIBS raster tiles** (Blue Marble for daytime, Black Marble for night lights) blended in a custom shader layer based on sun position — reconstructing the current day/night aesthetic with tile-based infinite zoom detail. Three.js remains for the custom shader layer via MapLibre's `CustomLayerInterface`. This gives us real geographic infrastructure (tiles, labels, coordinates, terrain) without sacrificing visual quality.

**Decision: Network-required.** MapLibre requires tile server access at runtime. We will *not* maintain a parallel Three.js offline fallback — the app already requires network for dataset fetches and LLM streaming. A bundled low-res raster tileset will serve as the degraded-network experience.

**Decision: Feature-flagged.** The migration ships behind a `rendererBackend: 'threejs' | 'maplibre'` toggle (localStorage + URL param) so both renderers can coexist during development and we can A/B test quality and performance.

**Decision: NASA GIBS tiles for Earth base.** Blue Marble (`BlueMarble_NextGeneration`) and Black Marble (`BlackMarble_2016`) served as raster tiles from NASA GIBS (WMTS). Day/night blending via a custom shader layer using sun position — same approach as current `earthMaterials.ts` but reading from tiles instead of a single 6K texture.

**Decision: Keep equirectangular cloud texture.** The current live cloud overlay (~8K, updated every 10 minutes) has no equivalent tile service. Clouds continue to be loaded as a single equirectangular texture rendered on a custom layer sphere, same as today. This is compatible with the MapLibre architecture — it's just another `CustomLayerInterface` mesh.

---

## Motivation & Gains

### What we gain

| Capability | Current (Three.js) | With MapLibre GL JS |
|---|---|---|
| Base map | Single 6K equirectangular texture | NASA GIBS raster tiles with infinite zoom detail |
| Day/night | Custom shader on single texture | Same shader, tile-fed — zoom into city lights |
| Clouds | Equirectangular texture, live updates | Same — no tile equivalent exists for live clouds |
| Geographic awareness | Manual raycasting for lat/lng | Native coordinate system, built-in geocoding |
| Projections | Sphere geometry only | Globe <-> Mercator seamless transition (~zoom 12) |
| Atmosphere | Custom dual-layer shaders | Built-in `atmosphere-blend` + custom layers |
| Raster overlays | Full sphere texture replacement | Layered raster sources with opacity/compositing |
| Video overlays | Full sphere texture replacement | `VideoSource` with geographic bounds |
| Labels & boundaries | None | Vector tile labels, borders, cities, POIs |
| 3D terrain | Flat sphere | DEM-based terrain elevation |
| Navigation | Custom fly-to (2.5s lerp) | Built-in `flyTo()`, `easeTo()`, `fitBounds()` |
| Markers & popups | None | Native markers, popups, GeoJSON layers |
| Touch/mobile | Custom touch handler | Battle-tested gesture handling |
| Accessibility | Manual ARIA attributes | Built-in keyboard navigation, ARIA support |

### New LLM tool opportunities

- **`fit_bounds(bbox)`** — navigate to bounding boxes ("show me the Amazon basin")
- **`add_overlay(geojson)`** — LLM can highlight regions, draw paths, place markers
- **`toggle_layer(id)`** — show/hide labels, boundaries, terrain alongside datasets
- **`geocode(place_name)`** — resolve place names to coordinates natively
- **`get_visible_features()`** — query what geographic features are in the current view for richer context

---

## Architecture: Hybrid Approach

```
+--------------------------------------------------+
|                   MapLibre GL JS                  |
|                 (Primary Map Engine)              |
|                                                   |
|  +--------------------------------------------+  |
|  |     NASA GIBS Raster Tile Sources           |  |
|  |  +------------------+ +------------------+ |  |
|  |  | Blue Marble (day)| | Black Marble     | |  |
|  |  | MODIS tiles      | | (night) VIIRS    | |  |
|  |  +------------------+ +------------------+ |  |
|  +--------------------------------------------+  |
|                                                   |
|  +--------------------------------------------+  |
|  |     CustomLayerInterface (Three.js)         |  |
|  |  +----------+ +--------+ +--------------+  |  |
|  |  |Day/Night | | Clouds | | Sun + Atmos.  | |  |
|  |  |Blend     | | (live  | |               | |  |
|  |  |Shader    | | 8K tex)| |               | |  |
|  |  +----------+ +--------+ +--------------+  |  |
|  +--------------------------------------------+  |
|                                                   |
|  +-------------+  +-------------+  +----------+  |
|  | Vector Tiles |  | Dataset     |  |  Labels  |  |
|  | (opt. base)  |  | Overlays    |  | Borders  |  |
|  +-------------+  +-------------+  +----------+  |
+--------------------------------------------------+
```

**Key principle**: MapLibre owns the WebGL context, camera, and input. NASA GIBS provides the Earth imagery as tiles. A Three.js custom layer samples both Blue Marble and Black Marble tile textures and blends them using the same `sunDir`/`NdotL` shader logic from the current `earthMaterials.ts`. Clouds remain a separate equirectangular texture on a custom layer sphere mesh, loaded from the live 10-minute update feed.

### Day/Night tile blending approach

The current `earthMaterials.ts` uses:
- `Earth_Diffuse_6K.jpg` as the diffuse map (Blue Marble equivalent)
- `Earth_Lights_6K.jpg` as the emissive map (Black Marble equivalent)
- A patched MeshPhong shader with `smoothstep(0.0, -0.2, vNdotL)` to blend night lights on the unlit side

The MapLibre approach replaces the single textures with tile sources:
1. MapLibre loads Blue Marble and Black Marble as two `raster` sources from NASA GIBS
2. A `CustomLayerInterface` reads the rendered tile pixels from both layers
3. The custom layer's fragment shader blends them using the same `sunDir` uniform and `smoothstep` terminator logic
4. Result: identical visual output, but with tile-level zoom detail — you can zoom into individual city lights

### Cloud overlay approach (unchanged)

The live cloud overlay remains an equirectangular texture (~8K, updated every 10 minutes from an external feed). No tile equivalent exists for near-real-time global cloud cover at this resolution. The cloud mesh renders as a `CustomLayerInterface` sphere at `radius = 1.005` with:
- Luminance-to-alpha processing (gamma 0.55)
- Night-side darkening via `smoothstep(0.0, -0.2, vCloudNdotL)` -> `vec3(0.08)`
- This is the same approach as current `earthMaterials.ts`, just hosted in MapLibre's render loop

### Renderer abstraction

During migration, both renderers coexist behind a common interface:

```typescript
interface GlobeRenderer {
  init(container: HTMLElement): void;
  loadDataset(source: DatasetSource): void;
  flyTo(lat: number, lon: number, zoom?: number): void;
  captureViewContext(): ViewContext;
  destroy(): void;
}
```

A `rendererBackend` setting (localStorage key `sos-renderer-backend`, URL param `?renderer=maplibre`) selects the active implementation. This lets us ship incremental progress, A/B test, and roll back instantly.

---

## NASA GIBS Tile Configuration

### Tile endpoints

NASA GIBS serves tiles via WMTS. MapLibre can consume these as `raster` sources:

```json
{
  "blue-marble": {
    "type": "raster",
    "tiles": [
      "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_NextGeneration/default/2004-08/250m/{z}/{y}/{x}.jpg"
    ],
    "tileSize": 256,
    "maxzoom": 8
  },
  "black-marble": {
    "type": "raster",
    "tiles": [
      "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlackMarble_2016/default/2016-01-01/500m/{z}/{y}/{x}.png"
    ],
    "tileSize": 256,
    "maxzoom": 8
  }
}
```

### Key considerations

- **EPSG:4326 vs EPSG:3857**: GIBS serves EPSG:4326 (geographic) tiles. MapLibre's globe mode uses its own internal projection. Need to verify that MapLibre can consume 4326 tiles directly or if we need the EPSG:3857 variants.
- **Tile format**: Blue Marble is JPEG (no alpha), Black Marble is PNG (needed for the shader blend). Verify PNG availability for both or handle in the shader.
- **Rate limits**: NASA GIBS has usage guidelines but no hard API key requirement. High-traffic production use should register at [Earthdata](https://urs.earthdata.nasa.gov/).
- **Zoom levels**: Blue Marble goes to 250m/px (~zoom 8), Black Marble to 500m/px (~zoom 7). Beyond that, tiles repeat at max resolution — still far better than the current single 6K texture.
- **Caching**: Tiles are static imagery (not live data) so aggressive cache headers apply. Configure MapLibre's `maxTileCacheSize` and consider a Cloudflare cache layer.

---

## Phase Breakdown

### Phase 0: Validation Spikes (Parallel)

**Goal**: Validate the three highest-risk assumptions before committing to the full migration.

**Spike A — Globe + GIBS tiles** (~1-2 days):
1. Add `maplibre-gl` dependency (v5+)
2. Create `src/services/mapRenderer.ts` — minimal MapLibre wrapper
   - Initialize map with `projection: { type: 'globe' }`
   - Load Blue Marble and Black Marble as two `raster` sources from NASA GIBS
   - Verify GIBS EPSG:4326 tiles work with MapLibre globe, or switch to 3857 variants
   - Verify tiles load, render, and cover the full globe (including poles)
3. Verify Vite build works, measure bundle size (target: < 250KB gzipped for maplibre-gl)
4. Implement `rendererBackend` toggle so both renderers can coexist

**Spike B — Equirectangular dataset overlay on globe** (~1 day, run in parallel):
1. Standalone test: load a SOS equirectangular image via `ImageSource` with world bounds on globe projection
2. Test with bounds `[[-180,85],[180,85],[180,-85],[-180,-85]]` — note this clips at +/-85deg (Mercator limits), so check for visible polar gaps on the globe
3. Test with `[[-180,90],[180,90],[180,-90],[-180,-90]]` to see if globe projection accepts true pole bounds
4. Test a `VideoSource` with an HLS-fed `<video>` element — measure per-frame reprojection cost
5. Document results: distortion quality, pole gaps, performance

**Spike C — Day/night blend via CustomLayerInterface** (~1-2 days, can overlap):
1. Implement a `CustomLayerInterface` that reads the rendered Blue Marble and Black Marble tile layers
2. Port the day/night blend shader from `earthMaterials.ts`:
   - `sunDir` uniform for sun direction
   - `smoothstep(0.0, -0.2, NdotL)` for terminator blending
   - Night lights (Black Marble) on the dark side, Blue Marble on the lit side
3. Validate matrix synchronization between MapLibre's projection and the custom layer
4. Compare visual output side-by-side with current Three.js renderer
5. Test with `maplibre-three-plugin` if manual sync is problematic

**Acceptance criteria**:
- Spike A: Globe renders with GIBS tiles, `map.getCenter()` returns valid coords, bundle < 250KB gzipped, toggle switches renderers, tiles cover poles
- Spike B: Equirectangular image covers globe without visible seams or >5% distortion at zoom 1-5; video updates at >24fps
- Spike C: Day/night blend matches current visual quality, terminator position correct, no z-fighting, camera sync stays correct during zoom/pan/rotate

**Go/no-go gate**: If Spike C fails (custom layer unusable on globe), abort — the day/night blend is core to the visual identity. If Spike B fails (ImageSource unusable), dataset overlays render via Three.js custom layer instead; MapLibre provides base map + navigation + geographic features.

---

### Phase 1: Earth Visuals (Day/Night, Clouds, Atmosphere)

**Goal**: Fully reconstruct the current Earth visual experience using GIBS tiles and custom layers.

**Why this is Phase 1 (not later)**: With the GIBS tile approach, the day/night custom layer *is* the base Earth rendering — it's not a cosmetic enhancement bolted on later. The globe looks wrong without it.

**Tasks**:
1. **Day/night blend layer** (from Spike C, productionize):
   - Create `src/services/earthTileLayer.ts` implementing `CustomLayerInterface`
   - Sample Blue Marble and Black Marble raster layers
   - Blend using `sunDir` uniform with `smoothstep(0.0, -0.2, NdotL)` terminator
   - Night light emissive strength matching current `NIGHT_LIGHT_STRENGTH = 0.5`
2. **Cloud overlay layer** (port from current `earthMaterials.ts`):
   - Keep the existing live cloud texture feed (~8K equirectangular, 10-minute updates)
   - Port cloud mesh as `CustomLayerInterface` sphere at `radius = 1.005`
   - Luminance-to-alpha processing (gamma 0.55) — same `CLOUD_ALPHA_GAMMA` constant
   - Night-side darkening shader: `smoothstep(0.0, -0.2, vCloudNdotL)` -> `vec3(0.08)`
   - `CLOUD_OPACITY = 0.9` with `depthWrite: false`
3. **Atmosphere**:
   - Evaluate MapLibre's built-in `atmosphere` / `sky` layer against current custom Rayleigh/Mie shaders
   - If built-in is sufficient: use it, delete custom atmosphere code
   - If not: port inner (rim + Rayleigh + sunset) and outer (Fresnel + Mie phase + sunset) atmosphere shells as custom layers
4. **Sun visual**:
   - Port sun sprite (core + glow) as custom layer billboard
   - `enableSunLighting(lat, lng)` -> update `sunDir` uniform + sprite position
   - Integrate with MapLibre's light source for consistent shadow direction on any future 3D terrain
5. **Sun position API**:
   - Port `enableSunLighting` / `disableSunLighting` to update custom layer uniforms
   - `updateSunFrame()` per-frame update for sun sprite position and directional light

**Tests to update**: `earthMaterials.test.ts` -> rewrite as `earthTileLayer.test.ts`.

**Acceptance criteria**:
- Day/night terminator position matches sun calculation within 1deg
- Night lights visible when zoomed in (tile detail > current 6K texture at zoom 4+)
- Cloud layer renders with correct transparency and night-side darkening
- Cloud texture updates every 10 minutes as it does today
- Atmosphere glow matches current look (inner rim + outer scatter)
- FPS within 10% of current Three.js renderer on reference device
- Screenshot comparison: side-by-side with current renderer shows equivalent or better visual quality

---

### Phase 2: Input & Navigation Migration

**Goal**: Replace `inputHandler.ts` with MapLibre's native controls.

**Tasks**:
1. Map current controls to MapLibre equivalents:
   - Auto-rotation -> custom `IControl` using `map.easeTo({ bearing, duration })` with long durations (avoid `rotateTo` in a rAF loop — it fights MapLibre's gesture system and causes jank)
   - Inertia/damping -> MapLibre has built-in inertia
   - Zoom limits -> `map.setMinZoom()` / `map.setMaxZoom()`
   - Double-click reset -> `map.on('dblclick', () => map.flyTo(defaultView))`
   - Fly-to animation -> `map.flyTo({ center, zoom, duration })`
2. Lat/lng tracking: replace raycaster with `map.on('mousemove', e => e.lngLat)`
3. Port `fly-to` action handler to use `map.flyTo()` with `center: [lon, lat]`
4. Expose camera state (center, zoom, bearing, pitch) for LLM vision context
5. Port `captureViewContext()` — replace `sphereRenderer` canvas capture with `map.getCanvas().toDataURL()`, ensure timing matches MapLibre's render cycle (capture in `map.on('idle')` or after `map.once('render')`)
6. Deprecate `inputHandler.ts` once parity is confirmed

**Tests to update**: `inputHandler.test.ts`, `inputHandler.flyTo.test.ts` — rewrite against new MapLibre-backed API.

**Acceptance criteria**:
- All existing user interactions work through MapLibre
- Fly-to actions from LLM work
- `captureViewContext()` returns valid canvas data
- Auto-rotation is smooth with no jank when user interacts

---

### Phase 3: Dataset Overlay System

**Goal**: Display equirectangular image and video datasets on the MapLibre globe.

**Implementation path depends on Phase 0 spike results:**

#### Path A: MapLibre-native sources (if Spike B passed)

1. **Image datasets**: Use MapLibre `ImageSource` with world bounds
   - Use whichever bounds worked best in Spike B
   - Handle resolution fallback chain (4096 -> 2048 -> 1024)
   - Layer ordering: dataset above base map, below labels
   - When a dataset is active, the day/night blend layer fades out (or hides) so the dataset is shown with neutral lighting
2. **Video datasets**: Use MapLibre `VideoSource`
   - Wire HLS.js -> `<video>` element -> VideoSource
   - Port playback controls (play/pause/seek/rate)
   - If per-frame reprojection cost is too high (Spike B benchmark), use Path B for video only
3. **Layer management**:
   - `addSource()` / `removeSource()` for dataset swapping
   - Opacity control for dataset layers
   - Generation counter pattern to prevent race conditions (port from current code)

#### Path B: Three.js custom layer (if Spike B failed, or for video)

1. Render equirectangular textures on a sphere mesh inside `CustomLayerInterface`
2. This is architecturally close to the current approach, just hosted in MapLibre's render loop
3. Still get all MapLibre benefits (navigation, labels, geographic features) — just not native source compositing

**Tests to update**: `datasetLoader.test.ts`, `sphereRenderer.test.ts` — rewrite against new overlay API.

**Acceptance criteria**:
- 3 reference datasets render correctly: static image, palette-cycled image, HLS video
- No visible pole distortion at zoom levels 1-5
- Dataset swap completes in <500ms (excluding network)
- Playback controls (play/pause/seek/rate) work for video datasets
- No race conditions when rapidly switching datasets
- Day/night blend layer correctly hides/shows when dataset is active/inactive

---

### Phase 4: Enhanced Geographic Features

**Goal**: Leverage MapLibre's native capabilities that Three.js couldn't provide.

**Note**: This phase is independent of Phase 3 and can run in parallel.

**Tasks**:
1. **Labels & boundaries layer**: Add optional vector tile layers for:
   - Country/state boundaries
   - City labels
   - Ocean/sea labels
   - Toggle-able from UI and LLM
   - Requires a vector tile source (see Deployment Considerations)
2. **Markers & popups**: Enable the LLM to place geographic markers
   - Render `<<MARKER:lat,lon,label>>` actions as MapLibre markers
   - Click markers to show popup with info
3. **GeoJSON overlay**: Enable the LLM to highlight regions
   - New action: `<<REGION:geojson_or_id>>` for feature highlighting
   - Support common regions (countries, continents) by name
4. **Terrain**: Optional 3D terrain toggle
   - DEM tile source for elevation
   - Useful for topography/geology datasets
5. **Enhanced fly-to**:
   - `fitBounds()` for bounding-box navigation
   - Pitch/bearing control for cinematic views
   - LLM action: `<<VIEW:lat,lon,zoom,pitch,bearing>>`

**Acceptance criteria**:
- Labels render above dataset overlays, toggle on/off without flicker
- LLM-placed markers appear at correct coordinates, popups display on click
- `fitBounds` navigates to correct region with appropriate zoom

---

### Phase 5: LLM Context Enrichment

**Goal**: Use MapLibre's geographic awareness to give the LLM richer context.

**Note**: This phase is independent of Phases 3-4 and can start as soon as Phase 2 is complete.

**Tasks**:
1. **Visible features query**: On each LLM turn, include what countries/regions are visible in the current view via `map.queryRenderedFeatures()`
2. **Bounding box context**: Report current viewport bounds to LLM system prompt
3. **New tools**:
   - `fit_bounds` — navigate to named region or bbox
   - `add_marker` — place labeled marker on globe
   - `highlight_region` — highlight a GeoJSON feature
   - `toggle_labels` — show/hide geographic labels
   - `get_view_context` — return what's visible
4. **Geocoding integration**: Resolve place names in fly-to commands
5. **Update system prompt**: Document new capabilities in `docentContext.ts`

**Tests to update**: `docentContext.test.ts`, `docentService.test.ts` — add tests for new tools and view context.

**Acceptance criteria**:
- `get_view_context` returns accurate list of visible countries/features
- LLM can successfully invoke all new tools in a conversation
- System prompt token count stays within budget (measure turn-0 vs turn-1 sizes)

---

### Phase 6: Cleanup & Optimization

**Goal**: Remove legacy code, optimize bundle, ensure performance parity.

**Tasks**:
1. Remove `sphereRenderer.ts` (replaced by `mapRenderer.ts`)
2. Remove `inputHandler.ts` (replaced by MapLibre controls)
3. Remove renderer toggle infrastructure (lock to MapLibre)
4. Refactor `earthMaterials.ts` -> `earthTileLayer.ts` (tile-based day/night + cloud overlay, no single-texture Earth code)
5. Update `three` dependency — may be able to use a lighter build (only what custom layers need)
6. Performance profiling:
   - Compare FPS on mobile (target: 60fps on mid-range phones)
   - Compare memory usage (tile cache vs single 6K texture)
   - Compare initial load time (tile cold start vs single texture fetch)
   - Compare zoom-in detail (tiles should be dramatically better at zoom 4+)
7. Bundle analysis — ensure maplibre-gl tree-shakes properly with Vite
8. Update all remaining tests
9. Update CLAUDE.md module map
10. **Deployment**: Add CSP headers for NASA GIBS domains, configure tile caching

**Acceptance criteria**:
- No references to `sphereRenderer`, `inputHandler`, or renderer toggle remain
- Bundle size delta documented
- FPS >= 55 on mid-range mobile
- All tests pass
- CLAUDE.md module map reflects new architecture

---

## Dependency Graph & Parallelization

```
Phase 0 (Spikes A+B+C)      ~2-3 days
  |
  +---> Go/No-Go Gate
  |
  v
Phase 1 (Earth Visuals)      ~3-4 days  <- day/night tiles, clouds, atmosphere
  |
  v
Phase 2 (Navigation)         ~1-2 days
  |
  v
Phase 3 (Dataset Overlays)   ~3-4 days
  |
  +----------+----------+
  |          |          |
  v          v          v
Phase 4    Phase 5
(Geo)      (LLM)
~2-3 days  ~2-3 days
  |          |
  +----------+
  |
  v
Phase 6 (Cleanup)             ~2-3 days
```

**Phases 4 and 5 are independent and can run in parallel.**

**Critical path**: Phase 0 -> Phase 1 -> Phase 2 -> Phase 3 -> Phase 6 (~14-18 days).

**Key change from earlier drafts**: Phase 1 (Earth Visuals) is early because the GIBS tile day/night blend *is* the base rendering — the globe looks incomplete without it. This is foundational, not cosmetic.

---

## File Impact Map

| Current File | Migration Impact |
|---|---|
| `src/services/sphereRenderer.ts` | **Replace** -> `src/services/mapRenderer.ts` |
| `src/services/sphereRenderer.test.ts` | **Replace** -> `src/services/mapRenderer.test.ts` |
| `src/services/earthMaterials.ts` | **Replace** -> `src/services/earthTileLayer.ts` (tile day/night + cloud overlay) |
| `src/services/earthMaterials.test.ts` | **Replace** -> `src/services/earthTileLayer.test.ts` |
| `src/services/inputHandler.ts` | **Remove** — MapLibre handles all input |
| `src/services/inputHandler.test.ts` | **Remove** |
| `src/services/inputHandler.flyTo.test.ts` | **Remove** — fly-to tested via mapRenderer |
| `src/services/datasetLoader.ts` | **Modify** — use MapLibre sources instead of Three.js textures |
| `src/services/datasetLoader.test.ts` | **Modify** — update mocks for new overlay API |
| `src/services/hlsService.ts` | **Keep** — still needed for HLS streaming to `<video>` element |
| `src/services/docentContext.ts` | **Modify** — add new tools, update view context |
| `src/services/docentContext.test.ts` | **Modify** — test new tools and view context |
| `src/services/docentService.ts` | **Modify** — handle new action types |
| `src/services/docentService.test.ts` | **Modify** — test new action types |
| `src/ui/chatUI.ts` | **Minor** — render new action button types |
| `src/ui/playbackController.ts` | **Minor** — adapt positioning to MapLibre container |
| `src/main.ts` | **Modify** — boot MapLibre instead of Three.js, renderer toggle |
| `src/main.test.ts` | **Modify** — update boot sequence tests |
| `src/types/index.ts` | **Modify** — add new action types, map config types, renderer types |

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| GIBS EPSG:4326 tiles incompatible with MapLibre globe | Medium | High | Test in Spike A; fall back to 3857 variants or reproject client-side |
| Day/night custom layer shader can't read tile textures | Medium | High | Spike C validates; alternative: render both raster layers with opacity controlled by a GeoJSON "night polygon" updated per frame |
| Equirectangular dataset images distort on globe | Medium | High | Spike B validates; fallback to custom layer sphere rendering (Path B) |
| VideoSource per-frame reprojection too expensive | Medium-High | Medium | Benchmark in Spike B; fallback to Three.js custom layer for video only |
| MapLibre v5 globe bugs/limitations | Low-Medium | Medium | Pin version, monitor GitHub issues, custom layer fallbacks |
| Custom layer matrix sync issues | Medium | High | Spike C validates early; use `maplibre-three-plugin`; test with simple geometry first |
| Bundle size increase | Low | Low | Target < 250KB gzipped for maplibre-gl; tree-shake Three.js to custom layer needs only |
| Mobile performance regression | Medium | Medium | Profile early; tile LOD may actually improve mobile perf vs 6K texture |
| NASA GIBS rate limits / availability | Low | Medium | Static tiles cache well; add Cloudflare cache layer; register Earthdata account for production |
| Polar gap at +/-85deg bounds (dataset overlays) | Medium | Low | Test +/-90 in Spike B; if gap visible, use custom layer for pole caps |
| Auto-rotation jank with MapLibre gestures | Low-Medium | Low | Use `easeTo` with long duration; implement as custom `IControl` |

---

## Deployment Considerations

- **CSP headers**: Cloudflare Pages `_headers` file needs `gibs.earthdata.nasa.gov` added to `img-src` and `connect-src`
- **Tile caching**: NASA GIBS tiles are static imagery — configure aggressive Cloudflare caching and MapLibre's `maxTileCacheSize`
- **Vector tiles** (Phase 4): Labels/boundaries need a separate vector tile source. Options: MapTiler free tier, Protomaps on R2, or OpenFreeMap. Not needed until Phase 4.
- **Cold start**: First load fetches tiles instead of a single 6K JPEG. May feel faster (progressive tile loading) or slower (more HTTP requests). Profile and tune `maxTileCacheSize`.
- **NASA GIBS registration**: Free, no API key required for moderate use. Register at [Earthdata](https://urs.earthdata.nasa.gov/) for production traffic monitoring.
- **Cloud texture**: The live cloud overlay URL remains unchanged — it's fetched as a single image, not through the tile system.

---

## Open Questions

1. **GIBS tile projection**: Will MapLibre globe mode consume EPSG:4326 WMTS tiles directly, or do we need the EPSG:3857 variants? (Resolve in Spike A)
2. **Custom layer tile texture access**: Can a `CustomLayerInterface` shader sample the pixels from MapLibre's raster tile layers, or do we need to load the tiles independently into the custom layer? (Resolve in Spike C)
3. **Tile server for labels** (Phase 4): Self-host vector tiles or use a provider? (Defer — not needed until Phase 4)
4. **Skybox**: MapLibre's globe has a sky/atmosphere but no starfield cubemap. Add stars as a custom layer or accept the simpler look? (Test in Spike A)
