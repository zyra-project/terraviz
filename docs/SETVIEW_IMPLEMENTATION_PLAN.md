# setView Implementation Plan

The legacy SOS Explorer `setView` tour task switches the display between a 3D globe and one of several 2D layouts (`FLAT_1`, `FLAT_2`, `FLAT_4`). The 2D layouts show 1, 2, or 4 flat map viewports side-by-side. Camera motion is locked across all panels — when the user (or a tour) flies somewhere, every panel tracks — but each panel can render a **different dataset**, which is the whole point of the feature (e.g. show SST, wind, and clouds synchronised).

This plan covers porting `setView` to the Interactive Sphere web app.

**Reference**: [Tour Task Reference Guide — setView](https://sos.noaa.gov/support/sosx/manuals/tour-builder-guide-complete/tour-task-reference-guide/)

---

## Goals

1. Add a **projection toggle** — switch the renderer between MapLibre's `globe` and `mercator` projections at runtime.
2. Add a **multi-viewport layout** — support 1/2/4 synchronised maps in a grid.
3. Allow each viewport to **load a different dataset** while keeping camera state in lockstep.
4. Expose it as a new tour task `setView` plus a user-visible UI toggle so the feature is usable outside of a tour.
5. Keep the single-globe code path as the default — this feature must not regress the existing experience.

## Non-goals

- Per-viewport camera (divergent views). Lockstep only — matches legacy behaviour and keeps scope bounded.
- Comparison sliders / A-B swipe UI. That's a separate feature.
- Independent tour playback per viewport.
- Changing the tile source or styling — we reuse the existing GIBS/MapLibre style.

---

## Legacy semantics (best understood)

From the SOS tour reference, `setView` accepts a view name. The observed values in legacy tours are:

| Value | Meaning |
|---|---|
| `GLOBE` / `SPHERE` | 3D globe, single viewport (default) |
| `FLAT` / `FLAT_1` | 2D Mercator/equirect, single viewport |
| `FLAT_2` | 2D, two panels (top/bottom or side/side) |
| `FLAT_4` | 2D, four panels in a 2×2 grid |

The legacy app's flat layouts bind each panel to whatever datasets are currently loaded, in load order. We will match that ordering: panel `N` shows the `N`-th loaded dataset; extra datasets beyond the panel count are hidden; missing datasets leave the panel showing the base earth only.

We should store the **exact legacy string** on the tour task (`setView: "FLAT_4"`) for round-tripping, and parse it into a normalised internal shape.

---

## Current architecture constraints

From a walk of `mapRenderer.ts`, `main.ts`, `datasetLoader.ts`, `earthTileLayer.ts`, and `index.html`:

| Assumption | Location | Severity |
|---|---|---|
| Globe projection is hard-coded in the style | `src/services/mapRenderer.ts:93` (`createGlobeStyle`, `projection: { type: 'globe' }`) | **High** — must parameterise |
| A single `MapRenderer` instance on `InteractiveSphere` | `src/main.ts:66` (`private renderer: MapRenderer \| null`) | **High** — must become a collection |
| Module-level `activeRenderer` singleton used by screenshot service | `src/services/mapRenderer.ts:284` | Medium — needs "primary viewport" concept |
| `MapRenderer` dynamically creates and owns `<div id="maplibre-container">` | `src/services/mapRenderer.ts:339` | Medium — must accept a parent container |
| `currentDataset` is singular on `AppState` | `src/types/index.ts:97-106` | High — must become an ordered list for multi-view |
| `datasetLoader.ts` pokes DOM by id (`#scrubber`, `#mute-btn`) | `src/services/datasetLoader.ts:212` | Medium — single playback transport is fine if we rule "panel 0 drives playback" |
| Info panel + chat trigger positioning assume one map | `src/ui/chatUI.ts`, `src/ui/playbackController.ts` | Low — panels remain global, not per-viewport |
| `earthTileLayer.ts` state is closure-scoped | `src/services/earthTileLayer.ts` `createEarthTileLayer()` | **Good** — already per-instance, no refactor needed |
| Skybox layer assumes globe | `src/services/earthTileLayer.ts` skybox pass | Medium — needs to no-op under mercator |

The earth tile layer being closure-scoped is the single biggest win: we can instantiate it per-map without touching it.

---

## Phased delivery

Each phase is independently landable and leaves the app in a shippable state.

### Phase 1 — Projection toggle on a single map

The smallest useful slice: prove we can switch the existing single map between globe and mercator without tearing it down.

**Changes**

1. `mapRenderer.ts`
   - `createGlobeStyle(projection: 'globe' | 'mercator' = 'globe')` — takes projection and bakes it into the style.
   - `MapRenderer.setProjection(projection)` — calls `map.setProjection({ type })`. MapLibre ≥ 4.7 supports runtime projection swap; if the installed version doesn't, fall back to `map.setStyle(createGlobeStyle(projection), { diff: true })`.
   - Skip skybox + sun sprite rendering when projection is `mercator`. Done inside `earthTileLayer.ts` by checking the map's current projection in `render()` and short-circuiting the skybox/sun passes. Day/night darken + Black Marble lights still work in 2D and should keep running.
   - Clamp min zoom lower (e.g. `0` instead of `0.5`) under mercator so "world view" actually shows the whole world.
2. `types/index.ts`
   - Add `MapProjection = 'globe' | 'mercator'` and add it to `GlobeRenderer` as an optional `setProjection?(p: MapProjection): void`.
3. `src/ui/mapControlsUI.ts`
   - Add a "2D / 3D" toggle button alongside the existing labels/boundaries/terrain toggles. Hidden behind a query-string flag (`?setview=1`) until Phase 2 lands so we don't ship a half-feature.
4. Tests
   - Unit test: `createGlobeStyle('mercator')` produces a style object with `projection.type === 'mercator'`.
   - Manual smoke: rotate 3D → toggle flat → camera centre and zoom are preserved; no skybox artefacts under mercator.

**Exit criteria**: a dev can flip between globe and flat with no dataset or tour changes, and everything (labels, terrain toggle, screenshots, markers) keeps working.

### Phase 2 — Multi-viewport scaffolding

Introduce the concept of a *viewport* without yet letting it render a different dataset. Goal: render N identical copies of the current map with synced cameras.

**New concepts**

```
ViewportManager
├─ viewports: Viewport[]          // 1, 2, or 4
├─ layout: '1' | '2h' | '2v' | '4' // horizontal/vertical/grid
├─ projection: 'globe' | 'mercator'
├─ primaryIndex: 0                 // drives playback, screenshots
└─ syncLock: boolean               // re-entrancy guard for camera mirroring

Viewport
├─ container: HTMLDivElement       // one grid cell
├─ renderer: MapRenderer           // its own MapLibre instance
├─ dataset: Dataset | null         // what it's showing
└─ id: string                      // stable key
```

**Changes**

1. `src/services/viewportManager.ts` (new)
   - `setLayout(layout, projection)` — tears down / creates renderers to match the target count, reuses existing ones when possible, and rebuilds the CSS grid on `#container`.
   - `syncCameras(sourceIdx)` — on `move` from any viewport, mirrors `center/zoom/bearing/pitch` to the others. Uses `syncLock` to prevent infinite ping-pong. The mirror operation sets `jumpTo` (not `easeTo`) so sibling maps don't animate.
   - `dispose()` — cleans up all renderers.
2. `src/main.ts`
   - Replace `private renderer: MapRenderer | null` with `private viewports: ViewportManager`.
   - Existing callers that reach for `this.renderer` go through `viewports.primary()`.
   - Screenshot service binds to the primary renderer.
3. `src/services/mapRenderer.ts`
   - `init(container)` stops creating `#maplibre-container`; instead it takes a caller-provided container element. The ID becomes optional and unique (`maplibre-container-${idx}`).
   - Remove the module-level `activeRenderer` singleton; replaced by `viewports.primary()`. Screenshot service gets the primary renderer injected instead of importing the singleton.
4. `index.html`
   - `#container` gains CSS grid support. Default is `grid-template: "a" / 1fr;`. Layouts:
     - `'1'`: one cell
     - `'2h'`: `"a b" / 1fr 1fr` (side-by-side)
     - `'2v'`: `"a" "b" / 1fr 1fr` (stacked)
     - `'4'`: `"a b" "c d" / 1fr 1fr`
   - Thin 1px gutters between panels.
5. UI panel positioning (chat, info, playback, tour controls) stays pinned to the window, not to a viewport. The chat trigger's ResizeObserver work is unaffected — it tracks the info panel, which is still singular.

**Exit criteria**: with `?setview=4` the user sees four identical globes in a 2×2 grid that all rotate together when any one is dragged. No feature regressions in single-view mode.

### Phase 3 — Per-viewport datasets

Let each viewport show a different dataset while playback stays synchronised.

**Design decisions**

1. **AppState gains an ordered list** of currently-loaded datasets:
   ```ts
   interface AppState {
     datasets: Dataset[]              // catalog (unchanged)
     loadedDatasets: Dataset[]         // NEW — ordered, length == viewport count
     primaryDataset: Dataset | null    // NEW — alias for loadedDatasets[primaryIndex]
     // currentDataset stays as a deprecated getter for back-compat
     ...
   }
   ```
2. **Assignment rule**: datasets are assigned to viewports by load order. Loading a new dataset while in `FLAT_4` either:
   - Fills the first empty slot, or
   - Replaces the primary slot if all are full.
   A "panel assignment" affordance (click-to-assign) is a Phase 4 nice-to-have; for Phase 3 the simple rule is enough to hit tour parity.
3. **Playback sync**:
   - Video datasets share a single master transport (the primary's playback controller). Each viewport's `VideoTextureHandle` points at its own `<video>` element sourced from the same HLS.js instance where possible, or from independent instances seeked to the same time.
   - Image datasets have nothing to sync.
   - Time cursor + scrubber remain singular, driven by the primary.
4. **`datasetLoader.ts` gets a target renderer param** — already accepts a renderer parameter, so this is mostly wiring. It must not assume playback controls exist for non-primary panels.
5. **Info panel** shows primary viewport's dataset. Clicking a non-primary panel promotes it to primary (updates `primaryIndex`, re-syncs playback transport).

**Changes**

1. `viewportManager.ts` — `loadDataset(dataset, slot?)`, `promoteToPrimary(idx)`, `getPanelDataset(idx)`.
2. `datasetLoader.ts` — remove any lingering single-renderer assumptions; playback controller wiring is guarded on `isPrimary`.
3. `playbackController.ts` — emits `timeupdate` events that the viewport manager fans out to non-primary video handles.
4. `chatUI.ts` — the "Load this dataset" button from Orbit calls `viewports.loadDataset(id)` which routes via the current assignment rule. Orbit prompt is unchanged; it still thinks there's one map.
5. Visual cue: subtle border highlight on the primary panel.

**Exit criteria**: in `FLAT_4`, the user can load four different datasets, they animate in sync, dragging any panel moves all four, and clicking a panel promotes it to primary.

### Phase 4 — `setView` tour task

With the machinery in place, the tour task is a ~30-line executor.

**Changes**

1. `types/index.ts`
   - Add to the `TourTaskDef` union:
     ```ts
     | { setView: SetViewTaskParams }
     ```
     ```ts
     export interface SetViewTaskParams {
       /** Legacy value — 'GLOBE' | 'SPHERE' | 'FLAT' | 'FLAT_1' | 'FLAT_2' | 'FLAT_4' */
       view: string
     }
     ```
2. `tourEngine.ts`
   - New executor `executeSetView(params)`:
     - Parse legacy string → `{ layout, projection }` via a small lookup.
     - Call `callbacks.setView({ layout, projection })`.
     - Await `moveend` so subsequent `flyTo` tasks see the new camera.
3. `TourCallbacks` (in `types/index.ts`) — add `setView(opts): Promise<void>`.
4. `main.ts` — implement the callback against `ViewportManager.setLayout(...)`.
5. Fixture: extend `test-tour.json` (or add a new `test-setview-tour.json`) with a tour that exercises `GLOBE → FLAT_4 → FLAT_1 → GLOBE`, loads four datasets, and verifies lockstep camera motion.

**Exit criteria**: a legacy SOS tour JSON file containing `setView` tasks plays through the engine without authoring changes.

---

## Open questions

1. **Is the MapLibre version in use new enough for runtime `setProjection`?** If not, we need the `setStyle` workaround, which is slightly more expensive (re-creates the layer stack, which means re-adding the custom earth layer). Check `package.json` before starting Phase 1.
2. **Tile cost.** Four MapLibre instances = 4× the tile requests. The tile preloader cache helps for base layers, but dataset textures are per-map. For video datasets this is 4× the HLS bandwidth. Acceptable for desktop, potentially painful on mobile — consider gating `FLAT_4` behind a viewport-width check (`≥1024px`).
3. **Tauri desktop.** Multiple WebGL contexts in one webview should work, but it's worth a smoke test on the Tauri build. The tile cache and keychain code paths are unaffected.
4. **Primary selection during a tour.** Tours load datasets in order. We should special-case the first `loadDataset` after a `setView` to land in panel 0, the second in panel 1, etc., rather than using the "replace primary if full" rule — otherwise a 4-panel tour will clobber itself. Add a `nextLoadSlot` cursor that the tour engine can drive.
5. **Camera lockstep under mixed projections.** This plan assumes projection is global (all viewports share it). If a future feature wants per-viewport projection (e.g. one globe + three flats), `syncCameras` needs to translate between projections correctly — out of scope here, but the ViewportManager API should leave the door open.

---

## Risks

- **Layout churn.** `map.resize()` is fast but not free. Rapid `setView` toggles during a tour could cause a visible reflow. Mitigation: throttle relayouts and pre-create hidden panels when entering a multi-view layout so we're only toggling `display`, not constructing MapLibre instances mid-tour.
- **Camera sync feedback loop.** MapLibre fires `move` on `jumpTo`. The `syncLock` re-entrancy guard must be airtight or we get infinite recursion. Add a unit test that asserts `syncCameras` doesn't re-trigger when called during an already-syncing move.
- **Playback drift.** HLS.js instances are not frame-accurate across decoders. Acceptable for Phase 3 parity with legacy SOS, but worth documenting — users expecting frame-locked comparisons will be disappointed.
- **Screenshot scope.** `captureScreenshot` currently grabs one canvas. In multi-view, should it grab the primary only, or composite all panels? Phase 2 default: primary only. Phase 4 follow-up: add `composite: true` option.

---

## File-level change summary

**New files**
- `src/services/viewportManager.ts` — viewport orchestration
- `docs/SETVIEW_IMPLEMENTATION_PLAN.md` — this document

**Modified files**
- `src/services/mapRenderer.ts` — projection parameterisation, container injection, drop singleton
- `src/services/earthTileLayer.ts` — skybox/sun skip under mercator
- `src/services/datasetLoader.ts` — remove primary-only assumptions
- `src/services/tourEngine.ts` — `setView` task executor
- `src/services/screenshotService.ts` — take renderer as an argument instead of reading the singleton
- `src/ui/mapControlsUI.ts` — projection / layout toggle buttons
- `src/ui/playbackController.ts` — fan-out timeupdate events to non-primary viewports
- `src/main.ts` — ViewportManager wiring, `setView` callback
- `src/types/index.ts` — `MapProjection`, `ViewLayout`, `SetViewTaskParams`, extend `AppState`, extend `TourCallbacks`
- `src/index.html` — grid CSS for `#container`, new control buttons
- `test/` — `viewportManager.test.ts`, tour-engine test coverage for `setView`
