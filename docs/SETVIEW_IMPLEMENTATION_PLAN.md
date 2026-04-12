# setView Implementation Plan

> Colloquially called "setView" throughout this repo and our design conversations. The actual legacy SOS tour task is named **`setEnvView`** — the plan uses the real task name in code references and the colloquial name in prose.

> **Status: Complete.** All three phases shipped on the `claude/implement-setview-feature-tnv4k` branch (PR #28). The plan below is retained as a historical reference for the design decisions and architecture rationale.

The legacy SOS Explorer `setEnvView` tour task switches the display between a single globe and multi-globe layouts. The legacy app supported multi-globe views (2 or 4 synchronised globes) but did **not** support multi-map views — the `FLAT_*` view names referred to a single flat map, not a grid of flat maps. Multi-panel meant multi-globe.

**This plan treats setView as "how many synchronised globes are on screen".** We're skipping flat projection entirely: MapLibre GL JS only offers `mercator` and `globe` as built-in projections, and mercator is actively wrong for a polar-heavy Earth-science dataset (it literally cannot display latitudes above ~85°). A true equirectangular or polar-stereographic render would require writing a second custom WebGL render path; that's out of scope here and tracked as a follow-up under "Future extensions" below.

Primary user value: **load different datasets into 2 or 4 synchronised globe panels to compare them side-by-side** — restoring legacy parity with the multi-globe feature. Legacy `FLAT_*` tour strings (which meant single flat map) get remapped to single-globe with a deprecation log note.

**Reference**: [Tour Task Reference Guide](https://sos.noaa.gov/support/sosx/manuals/tour-builder-guide-complete/tour-task-reference-guide/)

---

## Goals

1. **Multi-viewport layout** — support 1/2/4 synchronised globe panels in a CSS grid.
2. **Camera lockstep** — dragging, zooming, or flying any panel moves all of them together.
3. **Per-panel datasets** — each panel can show a different dataset, animated in sync.
4. **Tour task `setEnvView`** (plus `worldIndex` routing on `loadDataset` and a new `unloadDataset` task) — so existing SOS tour JSON plays through the engine with no authoring changes.
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

The legacy SOS `setEnvView` task accepts a view-name string. Two categories exist:

- **Single-surface views** — `GLOBE` / `SPHERE` for the 3D globe, and `FLAT` / `FLAT_*` for single flat maps. Only one dataset visible at a time.
- **Multi-globe views** — 2 or 4 synchronised globes, each potentially showing a different dataset. This is the capability we're restoring.

Verified from a reference legacy tour JSON:

| Legacy string | Internal layout | Notes |
|---|---|---|
| `1globe` | `1` | Single globe — verified in reference tour |
| `2globes` | `2h` | Two synchronised globes side-by-side — verified in reference tour |
| `4globes` | `4` | Four globes in a 2×2 — inferred by extrapolation from `1globe` / `2globes`, not yet seen in a reference tour. Safe to guess; will be confirmed when we get a 4-globe reference tour |
| `GLOBE` / `SPHERE` | `1` | Alternate spelling accepted for compatibility |
| `FLAT` / `FLAT_*` | `1` | Flat projection not supported — falls back to single-globe with a one-time deprecation log note |

Parser policy: case-insensitive match, liberal on whitespace, log a warning on unknown values and default to single-globe. The legacy string is stored verbatim on the task object for round-tripping.

### Panel assignment: `worldIndex`

Panel assignment is **explicit, not load-order-based**. Every `loadDataset` task in a legacy tour carries a `worldIndex` field that specifies which globe it targets:

```json
{ "loadDataset": {
    "id": "ID_OMGMDNKQFG",
    "datasetID": "dataset3",
    "worldIndex": 1,
    ...
}}
```

- `worldIndex: 1` → first globe panel (index 0 in our array)
- `worldIndex: 2` → second globe panel
- etc. 1-indexed to match legacy convention

When the current layout is single-globe, any `worldIndex` value maps to the only panel. When the layout is `2globes`, `worldIndex: 3` or higher is clamped to the last panel with a warning.

### `datasetID` — local tour handles

Every `loadDataset` task also carries a `datasetID` field (e.g. `"dataset1"`, `"dataset3"`). This is a **local handle** the tour uses to refer back to that loaded dataset later — it's separate from the catalog `id`. Handles are scoped to the tour run, and the engine maintains a `Map<datasetID, {slot: number, catalogId: string}>`. The `unloadDataset` task takes a `datasetID` and removes that specific dataset from its slot. This replaces the "load order + nextLoadSlot cursor" fiction I had in earlier drafts.

Ignored legacy fields (stored but unused): `activeLayer`, `vizName`, `colorPaletteIndex`, `contourNbr`, `contourStartValue`, `contourInterval`, `barbSize`, `barbDensity`, `transparencyPct`, `imageMinValue`, `imageMaxValue`, `showLegend`, `legendxPct`, `legendyPct`, `legendWidthPct`, `legendHeightPct`, `initHeightWheel`, `filterIntervalHrs`, `displays`. We parse them off so tours don't error but we don't act on them — most map to SOS rendering pipeline knobs that don't translate to MapLibre.

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

1. **`AppState` gains a per-slot dataset array**:
   ```ts
   interface AppState {
     datasets: Dataset[]              // catalog (unchanged)
     loadedDatasets: (Dataset | null)[] // NEW — length == viewport count, nulls for empty slots
     primaryDataset: Dataset | null   // NEW — alias for loadedDatasets[primaryIndex]
     // currentDataset stays as a deprecated getter for back-compat
     ...
   }
   ```
2. **Explicit slot assignment, not load order**. The public API is `loadDataset(dataset, { slot })`:
   - Tour callers pass `slot = worldIndex - 1` (converting from legacy 1-indexed to our 0-indexed).
   - Non-tour callers (user clicking a dataset in the browse panel, Orbit loading a dataset) default `slot` to `primaryIndex`.
   - Out-of-range slots are clamped to the last panel with a console warning.
   - Loading into a slot that already has a dataset replaces it (legacy tours rely on this for overlays).
3. **`datasetID` handle map**. The tour engine maintains a per-run `Map<string, { slot: number, catalogId: string }>` from local handle → slot. `unloadDataset: "dataset1"` looks up the handle and clears its slot. `unloadAllDatasets` clears the map and all slots.
4. **Playback sync**:
   - Video datasets share a single master transport (the primary's playback controller). Each non-primary viewport gets its own `<video>` element that's seeked to the primary's `currentTime` on `timeupdate`. HLS.js instances are per-video.
   - Image datasets have nothing to sync.
   - Scrubber + time cursor remain singular, driven by the primary.
5. **`datasetLoader.ts` gets a target renderer param** — it already accepts a renderer, so this is mostly wiring. Playback-controller wiring is guarded on `isPrimary` so non-primary panels don't try to install scrubbers or mute buttons.
6. **Info panel** shows primary viewport's dataset. Clicking a non-primary panel promotes it to primary (updates `primaryIndex`, re-syncs playback transport, updates info panel).

**Changes**

1. `src/services/viewportManager.ts` — `loadDataset(dataset, opts: { slot?: number })`, `unloadDatasetAt(slot)`, `promoteToPrimary(idx)`, `getPanelDataset(idx)`.
2. `src/services/datasetLoader.ts` — drop any lingering single-renderer assumptions; playback-controller wiring guarded on `isPrimary`.
3. `src/ui/playbackController.ts` — emit `timeupdate` that ViewportManager fans out to non-primary video elements.
4. `src/ui/chatUI.ts` — Orbit's "Load this dataset" button calls `viewports.loadDataset(id)` without a slot, which defaults to the primary. Orbit's prompt stays single-view-aware.
5. Visual cue: subtle border highlight on the primary panel.

**Exit criteria**: in the 4-panel layout, the user can load four different datasets (via the browse panel or dev-tools calls with explicit slots), they animate in sync, dragging any panel moves all four, and clicking a panel promotes it to primary.

### Phase 3 — `setEnvView` tour task + `worldIndex` routing + `unloadDataset`

With the machinery in place, wiring the tour tasks is a thin executor. Three tour tasks need work in this phase: `setEnvView` (new), `loadDataset` (extend to route `worldIndex`), `unloadDataset` (new).

**Changes**

1. `src/types/index.ts`
   - Add `setEnvView` and `unloadDataset` to the `TourTaskDef` union:
     ```ts
     | { setEnvView: string }
     | { unloadDataset: string }   // value is the local datasetID handle
     ```
   - Extend `LoadDatasetTaskParams` with the fields we now act on:
     ```ts
     export interface LoadDatasetTaskParams {
       id: string              // catalog ID (e.g. ID_OMGMDNKQFG)
       datasetID?: string      // local tour handle (e.g. "dataset3")
       worldIndex?: number     // 1-indexed target globe; defaults to 1
       [key: string]: unknown  // preserve ignored legacy fields
     }
     ```
2. `src/services/tourEngine.ts`
   - `executeSetEnvView(view)`:
     - Normalise the string (lowercase, trim) and look up in the parser table above.
     - Log a one-time deprecation note when falling back on `flat*` → single-globe. Log a warning on an unknown view name and default to single-globe.
     - Call `callbacks.setEnvView({ layout })`.
     - Await `moveend` so subsequent `flyTo` tasks see the new camera.
   - Extend the existing `executeLoadDataset`:
     - Translate `worldIndex` (1-indexed, default 1) into `slot` (0-indexed).
     - If `datasetID` is provided, record `{ handle → { slot, catalogId } }` in a per-run map on the engine.
     - Call `callbacks.loadDataset(catalogId, { slot })`.
   - New `executeUnloadDataset(handle)`:
     - Look up `handle` in the map.
     - Call `callbacks.unloadDatasetAt(slot)`.
     - Delete the map entry.
   - `executeUnloadAllDatasets` clears the handle map.
3. `TourCallbacks` (in `types/index.ts`) — add:
   ```ts
   setEnvView(opts: { layout: ViewLayout }): Promise<void>
   unloadDatasetAt(slot: number): Promise<void>
   ```
   Extend existing `loadDataset(id, opts?: { slot?: number }): Promise<void>`.
4. `src/main.ts` — implement the callbacks against `ViewportManager`.
5. Fixture: use the user-provided reference tour as `public/tours/test-setenvview-tour.json` (stripped of SOS-specific image paths we can't resolve) — it exercises `1globe → 2globes → 1globe`, uses `worldIndex` routing, loads and unloads datasets by handle, and ends with a `flyTo`. Perfect smoke test. The tour references datasets that may not be in our catalog; either substitute real IDs from our catalog or accept "dataset not found" logs and focus on layout / routing behaviour.

**Exit criteria**: the reference tour JSON plays through the engine without authoring changes. `2globes` puts two globes on screen, `worldIndex: 1` and `worldIndex: 2` land in their correct panels, `unloadDataset: "dataset1"` unloads the right panel, and lockstep camera motion holds through a `flyTo`.

---

## Settled decisions

- **No flat / mercator projection.** All panels render as globes. Polar data stays correct.
- **MapLibre 5.21.1 supports runtime `setProjection`** — noted in case we ever want it, but this plan doesn't use it.
- **4-panel layout gated to viewport width ≥ 1024px.** Four live MapLibre instances + up to four HLS streams is too heavy for mobile. Below the threshold, the layout picker offers only 1 / 2h / 2v.
- **Layout state is not persisted.** Reloads reset to single-globe. Layout is intentionally a tour/session-scoped choice; persisting it would surprise users who loaded the app expecting a globe and got a 2×2 grid from last week.
- **Orbit stays single-view-aware.** The system prompt doesn't mention panels; `viewports.loadDataset()` handles assignment silently. Revisit if users complain Orbit is loading into the "wrong" slot.
- **Multi-globe defaults to side-by-side (`2h`) for the 2-panel layout.** New tours can specify `2v` directly if they need stacked.
- **Legacy task name is `setEnvView`**, not `setView`. Verified from a reference tour JSON. The `setView` naming survives colloquially (branch name, plan filename) because that's how we've been referring to the feature in conversation.
- **Legacy multi-globe strings verified: `1globe`, `2globes`.** `4globes` inferred but not yet seen in a reference tour — safe to implement.
- **Panel assignment is via `worldIndex`, not load order.** Verified in the reference tour. Each `loadDataset` task declares which globe it targets.

---

## Risks

- **Camera sync feedback loop.** MapLibre fires `move` even on `jumpTo`. The `syncLock` re-entrancy guard must be airtight or we recurse. Covered by a unit test that asserts `syncCameras` doesn't re-trigger during an in-flight sync.
- **4× tile + video bandwidth.** Four instances means 4× GIBS tile requests and up to 4× HLS streams. Tile preloader cache helps for base layers but not dataset textures. Mobile gate mitigates the worst case. Worth a Tauri desktop smoke test — multiple WebGL contexts in one webview should work, but confirm before shipping.
- **Playback drift.** HLS.js instances aren't frame-accurate. We seek non-primary videos to the primary's `currentTime` on `timeupdate`, which is ~4/sec — visible drift on fast-moving datasets. Acceptable for parity with legacy SOS. Noted in release notes.
- **Layout churn during tours.** `map.resize()` + instance construction is not free. Rapid `setEnvView` toggles could cause visible reflow. Mitigation: reuse existing renderer instances across `setLayout` calls where the count doesn't change, only restyling the grid; when adding panels, create them hidden and reveal only once initialised.
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
- `public/tours/test-setenvview-tour.json` — reference tour fixture (derived from the user-provided legacy tour JSON)

**Modified files**
- `src/services/mapRenderer.ts` — accept caller-provided container, drop module-level singleton
- `src/services/datasetLoader.ts` — remove primary-only assumptions, guard playback wiring on `isPrimary`
- `src/services/screenshotService.ts` — take renderer as an argument instead of reading the singleton
- `src/services/tourEngine.ts` — `setEnvView` + `unloadDataset` executors, extend `loadDataset` to route `worldIndex`, per-run `datasetID → slot` handle map
- `src/ui/mapControlsUI.ts` — layout picker button
- `src/ui/playbackController.ts` — fan-out `timeupdate` events to sibling viewports
- `src/main.ts` — `ViewportManager` wiring, `setEnvView` / `loadDataset` / `unloadDatasetAt` tour callbacks
- `src/types/index.ts` — `ViewLayout`, extend `TourTaskDef` with `setEnvView` + `unloadDataset`, extend `LoadDatasetTaskParams` with `datasetID` + `worldIndex`, extend `AppState`, extend `TourCallbacks`
- `src/index.html` — grid CSS for `#container`, layout picker button wiring
