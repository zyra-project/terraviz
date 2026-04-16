# VR Investigation Plan — Meta Quest / WebXR

Feasibility investigation for running Interactive Sphere as an immersive
web experience on Meta Quest (and other WebXR-capable) headsets.

Status: **MVP in progress.** Feature-gated "Enter VR" button opens an
immersive session that renders the currently-loaded HLS video dataset
onto a globe, with controller-based rotate/zoom and in-VR play/pause.
The 2D experience is unchanged when WebXR is absent.

---

## Goal

Let a visitor on a Meta Quest browser tap **Enter VR** and stand in
front of the globe in room-scale, then watch NOAA SOS video datasets
play immersively with head + hand tracking. The existing 2D experience
is untouched.

## Constraints found during exploration

### 1. MapLibre's canvas cannot be reused in WebXR

MapLibre GL JS owns its WebGL context, its render loop, its projection
matrices, and its viewport. WebXR requires a context that has been made
XR-compatible and a draw loop driven by `XRSession.requestAnimationFrame`
reading per-eye `XRView`s from an `XRFrame`. None of those hook points
are exposed by MapLibre, and MapLibre's globe projection is a Mercator
derivative that does not map cleanly onto a unit sphere in world space.

**Implication:** VR mode renders in a *separate* WebGL canvas with its
own scene graph. The 2D MapLibre canvas is hidden while in VR and
restored on exit.

### 2. Three.js is the right engine, lazy-loaded on first VR entry

Initial scaffold used vanilla WebGL2 to avoid a dep. That was the right
call for "prove the pipeline works" but the wrong call for an MVP that
needs a live video texture, controller raycasting, and an interactive
floating HUD — writing all of that from scratch ran into 1500+ LOC.
Three.js provides every one of those primitives:

- `THREE.WebGLRenderer` has native WebXR support (`renderer.xr.enabled`)
- `THREE.VideoTexture` wraps an `HTMLVideoElement` directly
- `XRControllerModelFactory` + `THREE.Raycaster` for input
- `THREE.CanvasTexture` for rendering DOM UI into an in-VR panel

Bundle impact is kept off non-VR users via `import('three')` on user
tap of Enter VR (same lazy-import pattern used for Tauri plugins in
`src/services/llmProvider.ts`, `downloadService.ts`, `datasetLoader.ts`).
Only Quest / PCVR / Vision Pro browsers — the ones where feature
detection already returned `true` — ever fetch the chunk, and the
chunk is HTTP-cached for subsequent sessions.

### 3. Texture sources

- **HLS video textures** — `HLSService` produces a plain
  `HTMLVideoElement`. The existing element is reused (two consumers:
  the 2D `earthTileLayer` + the VR `VideoTexture`). The video element
  keeps playing across the enter/exit VR transition without tearing
  down the HLS stream.
- **Base Earth texture** — placeholder = `public/assets/Earth_Specular_2K.jpg`
  (already in the repo; monochrome but shows landmasses). A proper
  Blue Marble equirectangular is a Phase 2 polish item. When a video
  dataset is loaded, the video fills the whole sphere anyway and the
  base texture isn't visible — which is the main use case.
- **GIBS raster tiles** — deferred to Phase 2. The 2D app's tile
  pyramid doesn't port directly to a VR sphere (Mercator ≠ equirect-
  angular), and pre-stitching equirectangular per dataset is a real
  piece of work we decided to punt on for MVP.
- **Clouds / night lights / specular** — Phase 2. Visual polish, not
  MVP-critical.

### 4. Security / sandbox

- No CSP header blocks `navigator.xr`. The Cloudflare Function at
  `functions/api/[[route]].ts` only proxies API calls, so it has no
  effect on WebXR.
- Tauri desktop has `"csp": null` and no capability entry gates
  `navigator.xr` (the API is navigator-level, not a plugin). The
  desktop app will silently decline VR because the wry webview has no
  XR device; this is handled by the feature detector returning `false`.
- Service worker (`sw.js`) caches tile fetches and does not interfere
  with WebXR session setup.

---

## Architecture

```
┌──────────────────────────┐         ┌──────────────────────────────┐
│  2D experience (today)   │         │  VR experience (MVP)         │
│                          │         │                              │
│  MapLibre GL JS canvas   │         │  Three.js WebGLRenderer      │
│  ├─ GIBS raster tiles    │         │  ├─ Unit sphere mesh         │
│  ├─ earthTileLayer.ts    │ ◀── → ─▶│  ├─ VideoTexture (same HLS   │
│  ├─ HLS video texture    │ (shared │  │    <video> element)       │
│  └─ DOM UI overlays      │ <video>)│  ├─ Controller raycast →     │
│                          │         │  │    rotate globe, zoom     │
│                          │         │  └─ CanvasTexture HUD panel  │
└──────────────────────────┘         └──────────────────────────────┘
         ▲                                            ▲
         │                                            │
         └────── vrButton.ts: Enter VR / Exit VR ─────┘
```

### New modules

| File | Responsibility |
|---|---|
| `src/utils/vrCapability.ts` | Feature detect `navigator.xr` + `immersive-vr` (already landed) |
| `src/services/vrSession.ts` | Lazy-load Three.js, start/end `immersive-vr`, drive the render loop |
| `src/services/vrScene.ts` | Three.js scene: sphere + base texture + VideoTexture swap |
| `src/services/vrInteraction.ts` | Controller input — raycast, thumbstick rotate/zoom, trigger play/pause, grip exit |
| `src/services/vrHud.ts` | Floating HUD panel (CanvasTexture) — play/pause, dataset title, exit button |
| `src/ui/vrButton.ts` | DOM "Enter VR" button, feature-gated |
| `src/styles/vr.css` | Button styles, matches tokens.css glass surface |

### Modified modules

| File | Change |
|---|---|
| `src/index.html` | Add `#vr-enter-btn` host element |
| `src/main.ts` | Call `initVrButton()`; pass context (getVideo, getDataset, togglePlayPause) |
| `src/styles/index.css` | `@import './vr.css'` |
| `package.json` | Add `three` as a runtime dep (lazy-loaded) |

### Rendering pipeline

1. `vrButton.initVrButton()` runs during boot. It calls
   `isImmersiveVrSupported()`. If unsupported, the button stays hidden
   and `import('three')` is never scheduled — zero impact on
   desktop/Tauri/mobile bundle.
2. On first VR tap, `vrSession.enterVr(ctx)` dynamically imports
   Three.js, creates a `WebGLRenderer`, enables `renderer.xr`, and
   calls `renderer.xr.setSession(xrSession)` with a session requested
   from `navigator.xr.requestSession('immersive-vr', {...})` using
   `local-floor` as the required reference space.
3. `vrScene.create(ctx)` builds the scene: a unit sphere at `[0, 1.3,
   -1.5]` with a `VideoTexture` bound to `ctx.getVideo()`, plus a
   CanvasTexture HUD at `[0, 0.9, -1.2]`.
4. `vrInteraction.attach()` listens to `XRInputSource` events —
   trigger toggles play/pause via `ctx.togglePlayPause()`, grip exits
   VR, thumbstick on either hand rotates/zooms the globe.
5. On session end (user presses Quest button, or grip/Exit VR), the
   `end` event fires; we dispose scene resources, null the renderer,
   and restore the 2D DOM. The HLS video element keeps playing — the
   2D MapLibre layer is still bound to it.

---

## MVP scope (this branch)

What must work:

- Feature-gated Enter VR button (hidden on non-XR browsers)
- `immersive-vr` session start + exit (grip button, Quest home, or HUD)
- Stereo rendering at the headset's native resolution
- Unit sphere showing either the base Earth texture OR the currently
  loaded video dataset (VideoTexture fed by the same HLS stream as 2D)
- Controller raycast: point at globe → trigger-hold to rotate, thumb-
  stick to zoom
- In-VR HUD: dataset title, play/pause button, exit VR button
- Clean resource teardown on session end; HLS stream survives intact

Explicitly out of scope for MVP (→ Phase 2+):

- GIBS tile pyramid in VR (Phase 2)
- Day/night/cloud/specular composite shaders (Phase 2)
- Multi-globe / setview parity with 2D viewport manager (Phase 2.5)
- Browse panel in VR (Phase 3; switch datasets → exit to 2D for now)
- 2D ↔ VR camera sync (Phase 4; entering VR always starts from default pose)
- Orbit chat in VR (Phase 5)
- Tours in VR (Phase 5)

Note on multi-globe specifically: the MVP always renders one globe
bound to the primary panel, even if the 2D app is currently in 2- or
4-globe layout. Entering VR from a multi-globe 2D view falls back to
showing just the primary; other panels keep rendering in 2D behind
the scenes and are restored on VR exit.

---

## Delivery plan

VR is hard to debug without a headset in hand, so the MVP lands as a
sequence of small commits rather than one big drop. Each commit
type-checks and passes tests in isolation; only the final one makes
the feature reachable from the UI. That keeps blast radius small, makes
`git bisect` useful if something regresses, and lets individual pieces
be reverted without rolling back the whole feature.

| # | Commit | What lands | User-reachable? |
|---|---|---|---|
| 1 | `vr: scaffold WebXR investigation (Phase 1, not yet wired up)` ✅ | `vrCapability`, initial doc | No |
| 2 | `vr: revise plan to MVP scope and adopt Three.js (lazy-loaded)` ✅ | Revised plan, `vrScene`, deps | No |
| 3 | `vr: add vrHud — floating play/pause + title panel` | `vrHud.ts` (CanvasTexture panel, hit regions) | No |
| 4 | `vr: add vrInteraction — controller raycast + trigger handling` | `vrInteraction.ts` (XRInputSource events) | No |
| 5 | `vr: add vrSession — lazy-load Three.js + XR lifecycle` | `vrSession.ts` (renderer.xr session management) | No |
| 6 | `vr: wire Enter VR button into main.ts` | `vrButton.ts`, `vr.css`, `main.ts` + `index.html` edits | **Yes** |

Rationale for incremental over one-shot:

- **Debug triage.** If a Quest tester reports "globe missing" vs.
  "trigger doesn't fire" vs. "framerate tanks when HUD is visible",
  we know exactly which commit to suspect.
- **Revert blast radius.** A CanvasTexture bug that tanks Quest 2
  framerate can be reverted without losing the rest of the work.
- **Review surface.** Each module has a distinct concern (scene
  graph / input handling / UI rendering / lifecycle); reviewing them
  separately matches how you'd reason about them anyway.

If the final wiring commit introduces an integration issue that
can't be isolated to an earlier module, we can still revert just
commit 6 and leave the other modules in place — the app keeps
working exactly as it did pre-MVP because none of commits 3-5 are
imported by anything on the hot path.

---

## Roadmap after MVP

### Phase 2 — visual polish, loading gate & tile support

**VR loading gate.** The MVP has a pragmatic workaround for "no
decoded frame yet" (forced seek + base-Earth fallback). The real
answer is a proper loading state that gates VR entry:

1. User taps Enter VR → VR shows a loading environment (dark room +
   spinner, or base Earth with a loading overlay).
2. Gate clears when ALL of: Three.js initialized, XR session live,
   dataset texture has a decoded frame (video `readyState >= 2` or
   image element `.complete`).
3. Scene fades in / transition completes.

This also handles edge cases we haven't hit yet but will: slow
Three.js chunk download on first entry, HLS stream that hasn't
buffered, texture decode lag on lower-end Quest hardware.

**Visual polish:**
- Port `earthTileLayer.ts`'s day/night/cloud/specular composite into
  Three.js materials.
- Tile pyramid: either UV-reproject Mercator in-shader or pre-stitch
  equirectangular per dataset (open question below).
- Replace `Earth_Specular_2K.jpg` placeholder with a proper Blue
  Marble equirectangular base texture.

### Phase 2.1 — AR passthrough mode (virtual SOS in your room)

Video passthrough turns the VR experience into something very close
to visiting a physical Science On a Sphere installation: a virtual
globe floating in the user's actual room. Low effort, high
wow-factor, and thematically perfect for the SOS mission.

**Basic version (~1 commit, ~20-30 LOC delta):**

| Module | Change |
|---|---|
| `vrSession.ts` | Request `immersive-ar` instead of `immersive-vr` |
| `vrScene.ts` | Renderer `alpha: true`, remove `scene.background` (transparent pixels → passthrough shows through) |
| `vrCapability.ts` | Add `isImmersiveArSupported()` check |
| `vrButton.ts` | Offer both modes or a single button that prefers AR when available |

Everything else — globe mesh, VideoTexture, controller interaction,
HUD, inertia — stays identical. The globe just floats in the user's
room instead of a dark void.

**Quest hardware:**
- Quest 3 / 3S: color passthrough (room looks natural)
- Quest 2: grayscale passthrough (functional, less immersive)
- Quest Pro: color passthrough
- All use the same `immersive-ar` WebXR API

**Polish items (follow-up commits after basic passthrough):**

- **Ground shadow.** A subtle transparent plane with a radial
  gradient beneath the globe. Helps the globe feel spatially anchored
  in the room rather than pasted on.
- **Placement via hit-test.** Instead of a fixed position at
  `(0, 1.3, -1.5)`, let the user point at a spot in their room and
  "place" the globe there using the WebXR `hit-test` feature. Very
  SOS-like — pick where your virtual sphere goes.
- **Lighting estimation.** WebXR's `lighting-estimation` feature can
  match virtual lighting to room lighting so the globe's shading
  responds to the real environment. Optional feature, not widely
  supported yet — treat as aspirational.

### Phase 2.5 — multi-globe layout (parity with 2D viewport manager)

The 2D app already supports 1/2/4 synchronised globes via
`src/services/viewportManager.ts` — camera lockstep, a "primary"
designation that drives the playback transport, and sibling video
sync in `main.ts:attachPrimaryVideoSync`. Porting this to VR is
deferred from the MVP because of scope and a hardware unknown, but
the MVP modules are designed to extend cleanly.

**Candidate layouts** — pick before implementation:

1. **Arc** — N globes at eye height, ~30° apart. Closest spiritual
   port of the 2D side-by-side grid. A slight head-turn switches
   focus.
2. **Tabletop diorama** — smaller globes (~20 cm radius) arranged on
   a waist-height virtual surface in a 2×2 grid. User walks around
   or leans in. Feels more spatial, loses the "dashboard" metaphor.
3. **Primary + companions** — one full-size anchored globe with
   smaller companions beside it. Good for "focus + context".

Leaning **arc** for 2D parity, or **diorama** if we want VR to feel
distinct from the 2D experience.

**Sync model** — two options:

- **Full lockstep** (match 2D): grabbing one globe rotates all. In
  VR the user's head already is the camera, so this degrades to
  globe-orientation lockstep only.
- **Independent rotate, shared time**: each globe can be grabbed and
  rotated independently but scrubbing or pause/play affects all.
  Probably feels more natural in VR since you can physically move
  between globes rather than "aiming" a camera.

**Hardware constraint (important):** Quest 2 typically ships with
1–2 simultaneous H.264 hardware decoders. Four live HLS streams
→ four VideoTextures → four decoders may overflow and fall back to
software decode, which will tank framerate. The 2D app already
manages this on mobile; in VR it's a harder ceiling because stereo
rendering leaves less headroom. **Ship 2-globe support first; treat
4-globe as aspirational pending on-device testing.**

**Extension points already built into the MVP modules:**

| MVP module | Phase 2.5 extension |
|---|---|
| `vrScene.ts` | Grow a `setPanelCount(n)` + `setPanelVideo(slot, video)` API. Today it holds a single globe mesh; becomes an array keyed by slot index. |
| `vrSession.ts` | No change — scene creation is already parameterised. |
| `vrInteraction.ts` | Raycast hit → which slot? → promote to primary. New intent: "select primary panel". |
| `vrHud.ts` | Grows a panel-indicator strip (the 2D app does the same thing via the `info-selector` dropdown in `main.ts`). |

**Reuses from the 2D app unchanged:**

- `viewportManager` owns the concept of panel slots and the primary
  index. The VR scene consumes that state rather than reinventing it.
- `attachPrimaryVideoSync` — already does all the hard work of
  keeping sibling videos in time. The VR scene binds VideoTextures
  to already-synced videos, so VR doesn't need its own sync logic.

### Phase 3 — in-VR dataset switching
- Floating browse panel rendered as a CanvasTexture with dataset
  thumbnails.
- Controller raycast → select → triggers `loadDataset()` without
  exiting VR.

### Phase 4 — camera sync
- Entering VR inherits the current MapLibre view (lat/lng/zoom)
- Exiting VR writes the last VR camera pose back to MapLibre

### Phase 5 — richer interaction
- Pinch-gesture hand tracking as an alternative to controllers
- Orbit chat ("Ask Orbit") as a floating in-VR panel

---

## Open questions

1. **Projection**: UV-reproject Mercator in-shader (adds pole
   distortion handling) vs. ship a pre-stitched equirectangular per
   dataset. Answer before Phase 2.
2. **Comfort**: seated vs. standing default? Motion-sickness
   mitigation (fixed comfort grid, vignette on rotation)?
3. **Non-Quest headsets**: PCVR via SteamVR browser, PSVR2, Vision
   Pro's Safari. All support WebXR; the scaffold should work there
   unmodified but has not been tested.
4. **Base Earth texture**: ship a baked ~1 MB Blue Marble
   equirectangular as a static asset for Phase 2, or fetch from a
   NASA URL at runtime (would need to be CORS-friendly)?
5. **AR vs VR button UX** (Phase 2.1): two separate buttons
   ("Enter VR" / "Enter AR") or one smart button that prefers AR
   when available and falls back to VR? Single button is simpler
   but hides the choice; two buttons are noisier but let the user
   pick. A third option: one button with a small dropdown/toggle
   for the mode, defaulting to AR on devices that support it.

---

## Testing notes

- **Local dev**: `npm run dev`, open Chrome with the
  [WebXR API Emulator](https://chrome.google.com/webstore/detail/webxr-api-emulator/mjddjgeghkdijejnciaefnkjmkafnnje)
  extension. Click Enter VR, use the emulator panel to move the
  headset + controllers.
- **On-device**: `npm run build && npm run preview`, expose the host
  over the LAN, open the URL in the Quest browser (needs HTTPS or
  `localhost` — the Quest browser accepts self-signed certs with a
  warning). WebXR requires a secure context.
- **CI**: no automated VR tests yet. `vrCapability` is unit-testable
  against a mocked `navigator.xr`.
