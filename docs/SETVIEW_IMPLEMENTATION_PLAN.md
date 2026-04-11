# setView Implementation Plan

The legacy SOS Explorer `setView` tour task switches the display between a single globe and multi-panel layouts. The legacy app supported multi-globe views (2 or 4 synchronised globes) but did **not** support multi-map views — the `FLAT_*` view names referred to a single flat map, not a grid of flat maps. Multi-panel meant multi-globe.

**This plan treats `setView` as "how many synchronised globes are on screen".** We're skipping flat projection entirely: MapLibre GL JS only offers `mercator` and `globe` as built-in projections, and mercator is actively wrong for a polar-heavy Earth-science dataset (it literally cannot display latitudes above ~85°). A true equirectangular or polar-stereographic render would require writing a second custom WebGL render path; that's out of scope here and tracked as a follow-up under "Future extensions" below.

Primary user value: **load different datasets into 2 or 4 synchronised globe panels to compare them side-by-side** — restoring legacy parity with the multi-globe feature. Legacy `FLAT_*` tour strings (which meant single flat map) get remapped to single-globe with a deprecation log note.

**Reference**: [Tour Task Reference Guide — setView](https://sos.noaa.gov/support/sosx/manuals/tour-builder-guide-complete/tour-task-reference-guide/)

---

## Goals

1. **Multi-viewport layout** — support 1/2/4 synchronised globe panels in a CSS grid.
2. **Camera lockstep** — dragging, zooming, or flying any panel moves all of them together.
3. **Per-panel datasets** — each panel can show a different dataset, animated in sync.
4. **Tour task `setView`** — so existing SOS tour JSON plays through the engine with no authoring changes.
5. **User-visible UI toggle** — a layout picker in the map controls, usable outside a tour.
6. **No regression to the default single-globe experience.**

## Non-goals

- Flat / 2D projection of any kind. Legacy `FLAT_*` strings collapse to single-globe.
- Per-viewport camera (divergent views). Lockstep only.
- Comparison sliders / A-B swipe UI. Separate feature.
- Independent tour playback per viewport. One tour engine, one transport.
- Frame-accurate video sync across panels. Close-enough is fine; SOS legacy was similar.

---

## Legacy semantics & compatibility mapping

The legacy SOS `setView` task accepts a view name. Two categories existed:

- **Single-surface views** — `GLOBE` / `SPHERE` for the 3D globe, and `FLAT` / `FLAT_1` (possibly others) for the single flat map. Only one dataset visible at a time.
- **Multi-globe views** — 2 or 4 synchronised globes, each potentially showing a different dataset. This is the capability we're restoring.

The exact legacy tour-string values for the multi-globe views are **not yet verified** — they need to be confirmed against a reference tour JSON or the SOS docs before we finalise the parser lookup table. Candidate strings seen in the wild include things like `DUAL_GLOBE`, `QUAD_GLOBE`, `GLOBE_2`, `GLOBE_4`; we'll be liberal in what we accept and log a warning on unknown values.

| Legacy string | Internal layout | Notes |
|---|---|---|
| `GLOBE` / `SPHERE` | `1` | Default, no-op if already single |
| `FLAT` / `FLAT_1` / any other `FLAT_*` | `1` | Flat projection not supported — falls back to single-globe with a one-time deprecation log note |
| *multi-globe strings (TBD)* | `2h` or `4` | Verified before Phase 3 lands |

New tours can pass `{layout}` directly via an extended task param shape. The legacy string is stored verbatim on the task object for round-tripping.

Each panel binds to loaded datasets in load order: panel `N` shows the `N`-th loaded dataset. Extra datasets beyond the panel count are hidden. Missing datasets leave the panel showing the base earth layer only.

---

## Current architecture constraints

From a walk of `mapRenderer.ts`, `main.ts`, `datasetLoader.ts`, `earthTileLayer.ts`, and `index.html`:

| Assumption | Location | Severity |
|---|---|---|
| A single `MapRenderer` instance on `InteractiveSphere` | `src/main.ts:66` (`private renderer: MapRenderer \| null`) | **High** — must become a collection |
| Module-level `activeRenderer` singleton used by screenshot service | `src/services/mapRenderer.ts:284` | Medium — needs "primary viewport" concept |
| `MapRenderer` dynamically creates and owns `<div id="maplibre-container">` | `src/services/mapRenderer.ts:339` | Medium — must accept a parent container |
| `currentDataset` is singular on `AppState` | `src/types/index.ts:97-106` | High — must become an ordered list |
| `datasetLoader.ts` pokes DOM by id (`#scrubber`, `#mute-btn`) | `src/services/datasetLoader.ts:212` | Medium — fine if we rule "panel 0 drives playback" |
| Info panel + chat trigger positioning assume one map | `src/ui/chatUI.ts`, `src/ui/playbackController.ts` | Low — panels remain global, pinned to window |
| `earthTileLayer.ts` state is closure-scoped | `src/services/earthTileLayer.ts` `createEarthTileLayer()` | **Good** — already per-instance, no refactor needed |

The earth tile layer being closure-scoped is the single biggest win: we can instantiate it per-map without touching it. Since we're also sticking with globe projection everywhere, the skybox / sun sprite passes don't need any conditional logic — they just work per-instance.

---

## Phased delivery

Each phase is independently landable and leaves the app in a shippable state.

### Phase 1 — Multi-viewport scaffolding

Introduce the *viewport* concept without yet letting panels diverge on content. Goal: render N identical globes in a CSS grid with synced cameras.

**New concepts**

```
ViewportManager
├─ viewports: Viewport[]           // length 1, 2, or 4
├─ layout: '1' | '2h' | '2v' | '4'
├─ primaryIndex: 0                 // drives playback, screenshots, info panel
└─ syncLock: boolean               // re-entrancy guard for camera mirroring

Viewport
├─ container: HTMLDivElement       // one grid cell
├─ renderer: MapRenderer           // its own MapLibre instance
├─ dataset: Dataset | null         // what it's showing (Phase 2)
└─ id: string                      // stable key
```

**Changes**

1. `src/services/viewportManager.ts` (new)
   - `setLayout(layout)` — tears down / creates renderers to match the target count, reuses existing ones when possible, rebuilds the CSS grid on `#container`.
   - `syncCameras(sourceIdx)` — on `move` from any viewport, mirrors `center/zoom/bearing/pitch` to siblings using `jumpTo` (not `easeTo`) so sibling maps don't animate. `syncLock` prevents ping-pong.
   - `primary()` — returns the primary `MapRenderer`.
   - `dispose()` — cleans up all renderers.
2. `src/services/mapRenderer.ts`
   - `init(container: HTMLElement)` stops creating `<div id="maplibre-container">`; takes a caller-provided container element. The internal container ID becomes optional and unique per instance (`maplibre-container-${idx}`).
   - Remove the module-level `activeRenderer` singleton. Screenshot service gets the primary renderer injected instead of importing the singleton.
3. `src/main.ts`
   - Replace `private renderer: MapRenderer | null` with `private viewports: ViewportManager`.
   - Existing call sites that reach for `this.renderer` go through `viewports.primary()`.
4. `index.html`
   - `#container` gains CSS grid support. Default template is one cell. Layouts:
     - `'1'`: `"a" / 1fr`
     - `'2h'`: `"a b" / 1fr 1fr` (side-by-side)
     - `'2v'`: `"a" "b" / 1fr 1fr` (stacked)
     - `'4'`: `"a b" "c d" / 1fr 1fr`
   - Thin 1px gutters between panels.
5. UI panels (chat, info, playback, tour controls) stay pinned to the window, not per-viewport. The chat trigger's ResizeObserver work is unaffected — it tracks the info panel, which stays singular.
6. `src/ui/mapControlsUI.ts`
   - Add a layout picker button (1 / 2h / 2v / 4). Hidden behind `?setview=1` query flag until Phase 2 lands so we don't ship a half-feature.
7. Tests
   - Unit: `viewportManager.test.ts` covers `setLayout` transitions and `syncCameras` re-entrancy (calling `jumpTo` on a sibling should not re-enter `syncCameras` for that sibling).
   - Manual smoke: `?setview=4` shows four identical globes; dragging any one rotates all four in lockstep.

**Exit criteria**: with `?setview=4` the user sees four identical globes in a 2×2 grid that all rotate together when any one is dragged. Default single-view mode is bit-identical to today.

### Phase 2 — Per-viewport datasets

Let each panel show a different dataset while playback stays synchronised.

**Design decisions**

1. **`AppState` gains an ordered list** of currently-loaded datasets:
   ```ts
   interface AppState {
     datasets: Dataset[]              // catalog (unchanged)
     loadedDatasets: Dataset[]        // NEW — ordered, length == viewport count
     primaryDataset: Dataset | null   // NEW — alias for loadedDatasets[primaryIndex]
     // currentDataset stays as a deprecated getter for back-compat
     ...
   }
   ```
2. **Assignment rule**: datasets are assigned to viewports by load order. Loading a new dataset fills the first empty slot; if all slots are full, it replaces the primary slot. A click-to-assign affordance is a follow-up, not a Phase 2 requirement.
3. **Playback sync**:
   - Video datasets share a single master transport (the primary's playback controller). Each non-primary viewport gets its own `<video>` element that's seeked to the primary's `currentTime` on `timeupdate`. HLS.js instances are per-video.
   - Image datasets have nothing to sync.
   - Scrubber + time cursor remain singular, driven by the primary.
4. **`datasetLoader.ts` gets a target renderer param** — it already accepts a renderer, so this is mostly wiring. Playback-controller wiring is guarded on `isPrimary` so non-primary panels don't try to install scrubbers or mute buttons.
5. **Info panel** shows primary viewport's dataset. Clicking a non-primary panel promotes it to primary (updates `primaryIndex`, re-syncs playback transport, updates info panel).

**Changes**

1. `src/services/viewportManager.ts` — `loadDataset(dataset, slot?)`, `promoteToPrimary(idx)`, `getPanelDataset(idx)`, `nextLoadSlot` cursor (used by tours).
2. `src/services/datasetLoader.ts` — drop any lingering single-renderer assumptions; playback-controller wiring guarded on `isPrimary`.
3. `src/ui/playbackController.ts` — emit `timeupdate` that ViewportManager fans out to non-primary video elements.
4. `src/ui/chatUI.ts` — Orbit's "Load this dataset" button calls `viewports.loadDataset(id)`; Orbit's prompt stays single-view-aware, the viewport manager handles assignment silently.
5. Visual cue: subtle border highlight on the primary panel.

**Exit criteria**: in the 4-panel layout, the user can load four different datasets, they animate in sync, dragging any panel moves all four, and clicking a panel promotes it to primary.

### Phase 3 — `setView` tour task

With the machinery in place, the tour task is a thin executor.

**Changes**

1. **Before coding**: verify the exact legacy tour-string values used for multi-globe views. Source a reference tour JSON or the SOS docs and finalise the parser lookup table. Phase 3 shouldn't land with a table built on guesses.
2. `src/types/index.ts`
   - Add to the `TourTaskDef` union:
     ```ts
     | { setView: SetViewTaskParams }
     ```
     ```ts
     export interface SetViewTaskParams {
       /** Legacy view name — GLOBE/SPHERE, FLAT_*, and the multi-globe strings (verified in step 1) */
       view: string
     }
     ```
3. `src/services/tourEngine.ts`
   - `executeSetView(params)`:
     - Parse legacy string → `ViewLayout` via the lookup from step 1. Log a one-time deprecation note when falling back on `FLAT_*` → single-globe. Log a warning on an unknown view name and default to single-globe.
     - Call `callbacks.setView({ layout })`.
     - Reset the `nextLoadSlot` cursor to 0 so subsequent `loadDataset` tasks fill panels in order.
     - Await `moveend` so subsequent `flyTo` tasks see the new camera.
4. `TourCallbacks` — add `setView(opts: { layout: ViewLayout }): Promise<void>`.
5. `src/main.ts` — implement the callback against `ViewportManager.setLayout(...)`.
6. Fixture: `test-setview-tour.json` exercising a single-globe → multi-globe → single-globe sequence with 4 datasets, verifying lockstep camera motion and panel assignment order. Exact transitions depend on the verified multi-globe view names.

**Exit criteria**: a legacy SOS tour JSON file containing `setView` tasks plays through the engine without authoring changes, and four datasets loaded after a 4-panel `setView` land in panels 0–3 rather than clobbering each other.

---

## Settled decisions

- **No flat / mercator projection.** All panels render as globes. Polar data stays correct.
- **MapLibre 5.21.1 supports runtime `setProjection`** — noted in case we ever want it, but this plan doesn't use it.
- **4-panel layout gated to viewport width ≥ 1024px.** Four live MapLibre instances + up to four HLS streams is too heavy for mobile. Below the threshold, the layout picker offers only 1 / 2h / 2v.
- **Layout state is not persisted.** Reloads reset to single-globe. Layout is intentionally a tour/session-scoped choice; persisting it would surprise users who loaded the app expecting a globe and got a 2×2 grid from last week.
- **Orbit stays single-view-aware.** The system prompt doesn't mention panels; `viewports.loadDataset()` handles assignment silently. Revisit if users complain Orbit is loading into the "wrong" slot.
- **Multi-globe defaults to side-by-side (`2h`) for the 2-panel layout.** New tours can specify `2v` directly if they need stacked.
- **Exact legacy multi-globe tour strings need verification before Phase 3.** Placeholder in the plan until confirmed against a reference tour or SOS docs.

---

## Risks

- **Camera sync feedback loop.** MapLibre fires `move` even on `jumpTo`. The `syncLock` re-entrancy guard must be airtight or we recurse. Covered by a unit test that asserts `syncCameras` doesn't re-trigger during an in-flight sync.
- **4× tile + video bandwidth.** Four instances means 4× GIBS tile requests and up to 4× HLS streams. Tile preloader cache helps for base layers but not dataset textures. Mobile gate mitigates the worst case. Worth a Tauri desktop smoke test — multiple WebGL contexts in one webview should work, but confirm before shipping.
- **Playback drift.** HLS.js instances aren't frame-accurate. We seek non-primary videos to the primary's `currentTime` on `timeupdate`, which is ~4/sec — visible drift on fast-moving datasets. Acceptable for parity with legacy SOS. Noted in release notes.
- **Layout churn during tours.** `map.resize()` + instance construction is not free. Rapid `setView` toggles could cause visible reflow. Mitigation: reuse existing renderer instances across `setLayout` calls where the count doesn't change, only restyling the grid; when adding panels, create them hidden and reveal only once initialised.
- **Screenshot scope.** `captureScreenshot` currently grabs one canvas. In multi-view the default is primary-only; a `composite: true` option to grab all panels into one image is a future extension.

---

## Future extensions (not in this plan)

- **True equirectangular flat mode via a second `CustomLayerInterface`.** Would render the dataset + GIBS base tiles onto a full-screen equirectangular quad, bypassing MapLibre's projection pipeline. Significant work — a second render path with its own tile sampling logic, day/night/clouds/specular rebuilt in equirectangular space. Warranted only if users specifically ask for "see the whole world in one frame."
- **Composite screenshot** — stitch all panels into one image.
- **Click-to-assign** — let the user drag a dataset from the browse panel onto a specific panel slot.
- **Per-panel camera offsets** — allow each panel a small offset from the lockstep camera (e.g. "all four follow the same fly-to, but panel 2 is rotated 90° so you can see the opposite hemisphere").

---

## File-level change summary

**New files**
- `src/services/viewportManager.ts` — viewport orchestration
- `test/viewportManager.test.ts` — layout transitions + sync re-entrancy
- `public/tours/test-setview-tour.json` — fixture (location TBD per existing fixture conventions)

**Modified files**
- `src/services/mapRenderer.ts` — accept caller-provided container, drop module-level singleton
- `src/services/datasetLoader.ts` — remove primary-only assumptions, guard playback wiring on `isPrimary`
- `src/services/screenshotService.ts` — take renderer as an argument instead of reading the singleton
- `src/services/tourEngine.ts` — `setView` task executor, `nextLoadSlot` cursor handling
- `src/ui/mapControlsUI.ts` — layout picker button
- `src/ui/playbackController.ts` — fan-out `timeupdate` events to sibling viewports
- `src/main.ts` — `ViewportManager` wiring, `setView` tour callback
- `src/types/index.ts` — `ViewLayout`, `SetViewTaskParams`, extend `AppState`, extend `TourCallbacks`
- `src/index.html` — grid CSS for `#container`, layout picker button wiring
