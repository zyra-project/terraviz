# VR Investigation Plan — Meta Quest / WebXR

Feasibility investigation for running Interactive Sphere as an immersive
web experience on Meta Quest (and other WebXR-capable) headsets.

Status: **MVP + Phase 2 + Phase 2.1/2.2 + Phase 2.5 + Phase 3 shipped.** Feature-gated
"Enter AR" / "Enter VR" button opens an immersive WebXR session
that renders the currently-loaded dataset (or a photoreal
day/night Earth with atmosphere, clouds, night lights, specular,
and a tracked sun when no dataset is loaded) on a globe. Full
spatial placement on real-world surfaces via hit-test, with
cross-session persistence via WebXR anchors. Controller
interaction (surface-pinned drag, two-hand pinch+rotate, thumbstick
zoom, flick-to-spin inertia), floating HUD, animated 3D loading
scene. The 2D experience is unchanged when WebXR is absent.

Remaining phases not yet built: VR tours (3.5), 2D↔VR camera sync
(4), voice docent + hand tracking (5), AR-native enhancements
(spatial audio, annotations, capture/share, real-time data,
co-presence, layered datasets). 4-globe support is a Phase 2.5
stretch (2-globe shipped; 4 gates on Quest decoder-budget
testing). Free-text dataset search is a Phase 3 stretch (category
chips shipped; keyboard/voice search pending).

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
- Tours in VR (Phase 3.5; the killer app for the museum use case)
- Orbit chat in VR (Phase 5)

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
| 3 | `vr: add vrHud — floating play/pause + title panel` ✅ | `vrHud.ts` (CanvasTexture panel, hit regions) | No |
| 4 | `vr: add vrInteraction — controller raycast + trigger handling` ✅ | `vrInteraction.ts` (XRInputSource events) | No |
| 5 | `vr: add vrSession — lazy-load Three.js + XR lifecycle` ✅ | `vrSession.ts` (renderer.xr session management) | No |
| 6 | `vr: wire Enter VR button into main.ts` ✅ | `vrButton.ts`, `vr.css`, `main.ts` + `index.html` edits | **Yes** |

All 6 MVP commits landed, plus ~50 follow-up commits for Phase 2
(visual polish: photoreal Earth, atmosphere, clouds, sun sprite,
loading scene, ground shadow), Phase 2.1 (AR passthrough, spatial
placement with WebXR anchors + cross-session persistence), Phase
2.2 (controller tooltips), and on-headset-iteration fixes
(rotation feel, inertia tuning, sun-orbits-with-globe semantics,
HUD follows placed globe, zoom-aware lift offsets, Copilot review
round 1 + 2).

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

### Phase 2 — visual polish, loading gate & tile support ✅ *(loading gate, day/night shader, atmosphere, clouds, sun sprite, ground shadow shipped; GIBS tile pyramid deferred)*

**VR loading gate.** ✅ Shipped. The 3D loading scene
(src/services/vrLoading.ts) replaces the "brief flash of base
Earth" workaround with a proper gated entry — rings spin + progress
bar fills while the dataset texture decodes, then fades out to
reveal the real globe. Visual language matches the 2D loading
screen (src/styles/loading.css).

**Visual polish — port the pre-MapLibre Three.js shader.**

The project previously had a full photorealistic day/night Earth
shader in `src/services/earthMaterials.ts` (564 LOC), removed in
commit `3911300` when the app locked to MapLibre. That shader is
**directly portable** back into `vrScene.ts` — it's already
Three.js-native and covers day/night/clouds/specular/atmosphere via
`MeshPhongMaterial.onBeforeCompile` patches.

| Feature | Approach |
|---|---|
| Diffuse (day Earth) | Equirectangular JPG + MeshPhongMaterial.map |
| Night lights | Emissive map + shader patch: `smoothstep(0.0, -0.2, N·L)` gates lights to the dark side only |
| Specular (ocean glint) | Standard Phong specular using `Earth_Specular_2K.jpg` (already in the repo) |
| Clouds | Separate sphere mesh at radius 1.005, shader patch dims clouds on night side |
| Atmosphere | Inner + outer rim-fresnel spheres at 1.003 / 1.012 |
| Sun lighting | DirectionalLight + sun sprite at `getSunPosition()` longitude/latitude |
| Normal map | Skipped (was historically 224 KB; removed in the LFS cleanup; visual gain marginal over specular) |

Port effort: ~300-400 LOC of adaptation to vrScene.ts — mostly
copy-paste from the old `earthMaterials.ts` with structural
changes for the functional scene-handle style (no class).

**Texture hosting — external CDN, not LFS.**

Commits `34167f2` + `e79276f` document the **explicit decision to
remove the Earth textures from LFS** — the zyra-project account
was hitting 9 GB / 10 GB LFS bandwidth per month, with
`Earth_Diffuse_6K.jpg` (7.9 MB) as the leading contributor. Two
textures removed from LFS at that time:

- `Earth_Diffuse_6K.jpg` — 7.9 MB, removed
- `Earth_Normal_2K.jpg` — 224 KB, removed (was in precache but
  referenced by no shader)

The night lights were separately replaced in 2D by a GIBS Black
Marble framebuffer-capture approach (commit `fd004e4`), which is
MapLibre-specific and not portable to Three.js.

**Strategy: host Earth textures on the existing external CDN.**

There's already a precedent in `src/utils/deviceCapability.ts`:

```ts
const CLOUD_TEXTURE_BASE = 'https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov'
// getCloudTextureUrl() → clouds_4096.jpg or clouds_8192.jpg
```

The cloud texture lives on S3, not in the repo, not in LFS. Same
pattern for Earth:

- Host `Earth_Diffuse_2K.jpg` (or `4K`) + `Earth_Lights_2K.jpg` on
  the same bucket.
- Fetch at runtime via `fetchImageWithProgress`.
- Browser HTTP cache deduplicates across sessions.
- Zero LFS bandwidth, zero repo size impact.

Why 2K and not 6K: at the VR globe's visible FOV (~40° fills the
view at arm's length), 2K is perceptually equivalent to 6K. Storage
/ download savings are ~9× (1 MB instead of 8).

**Tile pyramid — de-prioritized.**

The original Phase 2 bullet "UV-reproject Mercator in-shader vs.
pre-stitch equirectangular per dataset" can be deferred. With the
static equirectangular Blue Marble as the base Earth, the dataset
VideoTexture / ImageTexture overlay already covers the per-dataset
variant case (the existing MVP code). GIBS tiles are only needed
if we want tile-level zoom detail on the base Earth beyond 2K,
which is a much later polish concern.

### Phase 2.1 — AR passthrough mode (virtual SOS in your room) ✅ *(basic passthrough, spatial placement via hit-test, WebXR anchors with cross-session persistent handles, ground shadow shipped; lighting estimation aspirational)*

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

**Spatial placement — putting the globe on your table.**

This is the polish item that turns AR mode from "globe floats in
front of me" into "SOS sphere sitting on my kitchen table." The
WebXR `hit-test` feature ray-casts from the controller into the
real-world geometry the headset has detected and returns a 3D pose
where the ray meets a surface. We use that to place the globe.

| WebXR feature | Quest 2 | Quest 3 / Pro | What it gives us |
|---|---|---|---|
| `hit-test` | ✅ | ✅ | Ray hits the room — get position + orientation on a real surface |
| `anchors` | ✅ | ✅ | Persistent reference points that survive across sessions |
| `plane-detection` | partial | ✅ | Auto-detected horizontal/vertical surfaces (tables, walls) |
| `mesh-detection` | ❌ | ✅ | Full room mesh from depth sensors |

For "globe on a table," **`hit-test` alone is enough**. The other
three are progressive enhancements.

**UX options — a real design call:**

1. **Explicit "Place" mode** (most predictable). Tap a Place
   button on the HUD → reticle appears and follows the controller
   ray onto room surfaces → trigger places the globe there → HUD
   reverts to normal with a "Re-place" button available. Best for
   museum-style use where a visitor places once and then explores.
2. **Drag-to-translate** (uses existing input). Hold trigger on
   the globe → translate with controller motion. Combined with
   the existing two-hand pinch+rotate, gives full 6-DoF
   manipulation. Fluid for individual users but easier to bump
   out of place by accident.
3. **Hybrid.** Drag-to-translate for fine adjustments, Place mode
   for bulk repositioning across the room.

Recommend **Option 1** for the first cut — predictable, no input-
mode confusion, and matches how visitors naturally approach a
new physical exhibit (place it, then explore).

**Implementation sketch:**

```ts
// Request hit-test alongside local-floor on AR session entry
const session = await navigator.xr.requestSession('immersive-ar', {
  requiredFeatures: ['local-floor', 'hit-test'],
  optionalFeatures: ['anchors'],
})
const viewerSpace = await session.requestReferenceSpace('viewer')
const hitTestSource = await session.requestHitTestSource({ space: viewerSpace })

// Per frame in placement mode:
const hits = frame.getHitTestResults(hitTestSource)
if (hits.length > 0) {
  reticle.position.copy(hits[0].getPose(refSpace).transform.position)
  reticle.visible = true
}
// On user trigger in placement mode:
globe.position.copy(reticle.position)
globe.position.y += 0.05  // lift slightly so globe rests on top
```

**Globe placement details:**
- Lift the globe by ~5 cm above the hit point so it visually rests
  on top of the surface instead of intersecting it.
- HUD stays user-anchored (gaze-relative) so controls are always
  accessible regardless of where the globe sits in the room.
- Default position when not placed = current `(0, 1.3, -1.5)` — fine
  for VR mode and for AR before first placement.

**Persistent anchors:**
After placement, `await hit.createAnchor()` creates a persistent
anchor the system tracks across frames and (with the right scope)
across sessions. The globe stays on your table when you exit and
re-enter VR — exit at lunch, come back after dinner, globe is
still there. Quest's tracking is good enough that this works
reliably in well-lit rooms. First version: in-session memory
only. Persistence is a clean follow-up commit.

**Effort:**

| Piece | LOC est. |
|---|---|
| Hit-test request + per-frame reticle | ~80 |
| "Place" mode via HUD button + state machine | ~50 |
| Lift offset + landing animation | ~30 |
| Persistent anchors (cross-session) | ~80 |
| Plane detection (Quest 3 — snap to detected table surfaces) | ~100 |

Basic placement (place mode + reticle, no persistence) is one
focused ~160-LOC commit.

**Other polish items:**

- **Ground shadow.** A subtle transparent plane with a radial
  gradient beneath the globe — helps it feel spatially anchored
  in the room rather than pasted on. Especially useful before
  placement is done. ~30 LOC.
- **Lighting estimation.** WebXR's `lighting-estimation` feature
  can match virtual lighting to room lighting so the globe's
  shading responds to the real environment. Optional feature,
  not widely supported yet — treat as aspirational.

### Phase 2.2 — controller tooltips (button affordance hints) ✅ *(basic always-on labels shipped; fade-on-idle + HUD toggle + cross-device XR Input Profiles positioning still polish backlog)*

Polished VR apps overlay short text labels next to controller buttons
to teach the input model — "Trigger: rotate", "Grip: exit". For a
museum-style experience like this one (many users will be picking up
a Quest for the first time), these labels are the difference between
"how do I use this?" and "I get it."

**Approach:** floating sprites attached to the controller grip
space. Sprites always face the camera so text stays readable from
any angle. Hand-tuned position offsets for Quest Touch buttons
ship first; programmatic positioning via the XR Input Profiles
mesh names follows if we want to support PSVR2 / Vision Pro /
Index controllers without per-device code.

**Labels to ship:**

| Label | Position | Notes |
|---|---|---|
| Trigger: rotate | Near trigger | Most common action |
| Grip: exit | Near grip | Less obvious; worth the hint |
| Thumbstick: zoom | Near thumbstick | Optional — less critical |
| Both triggers: pinch | Below grip | Discoverability hint for two-hand |

**Show / hide strategy** — first-session-and-on-idle pattern:

- New users see hints immediately on session start
- Hints fade out after ~10-15 s of activity
- Hints reappear after ~5 s of zero input (idle help)
- HUD toggle for "Show hints" gives experienced users explicit
  control to keep them off entirely

**Effort:**

| Piece | LOC est. |
|---|---|
| Always-on labels (Quest Touch hand-tuned positions) | ~80-100 |
| Fade in/out on activity / idle | +50 |
| HUD "Show hints" toggle | +30 |
| Programmatic positioning via XR Input Profiles (cross-device) | +50 |

Basic version (always-on labels + Quest Touch) is one small commit.
Polish (fade + toggle + cross-device) follows as separate commits.

### Phase 2.5 — multi-globe layout (parity with 2D viewport manager) ✅ *(2-globe arc shipped: per-frame layout sync, lockstep grab-rotate across all globes, HUD panel-indicator strip. Promote-to-primary on non-primary tap was prototyped then ripped out — it caused a ping-pong loop (promote → textures swap under the user's ray → re-promote) — a replacement UX (long-press / HUD-dot taps / Phase 3 browse-panel routing) is future work. 4-globe is a stretch post on-device Quest decoder-budget validation.)*

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

**Commit sequence (branch: `claude/vr-multi-globe-phase-2.5`):**

Decisions baked in before the first code change:

- **Layout: arc** — matches the 2D side-by-side grid's spiritual
  model and is the path of least surprise for users who already
  use the 2-globe view in 2D. Diorama / primary+companions
  remain as future-polish alternatives.
- **Sync model: independent rotate + shared time** — each globe
  can be grabbed and rotated independently, but playback state
  (play/pause/scrub) affects all. Feels more natural in VR where
  you can physically look at one globe without the other spinning.
- **Ship 2-globe first.** 4-globe is documented above as
  aspirational pending Quest decoder-budget testing; first
  release validates the architecture at 2 before attempting 4.

Commit breakdown:

| # | Commit | Scope |
|---|---|---|
| 1 | Plan doc: Phase 2.5 commit breakdown | This table |
| 2 | `vrScene: support N globes internally` | Internal refactor — single globe → array of globes. All existing code paths use index 0 as primary. No user-visible change when panelCount is 1. |
| 3 | `VrSessionContext: multi-panel getters` | `getPanelCount()`, `getPrimaryIndex()`, `getPanelTexture(slot)`, `getPanelTitle(slot)` — main.ts wires to existing `viewports` + `panelStates` |
| 4 | `vrSession: arc layout + per-slot texture sync` | Per-frame poll of panel count + textures. Arc spacing is `GLOBE_RADIUS * 2 + 0.2 = 1.2 m` center-to-center (0.5 m-radius spheres, 0.2 m gap). Primary keeps its current world position (preserves AR anchor); secondaries fan to its right — e.g. panelCount=2 puts the secondary at primary + `(1.2, 0, 0)`. No inward yaw. Centering the arc about the primary is future polish. |
| 5 | `vrInteraction: lockstep grab-rotate across all globes` | Trigger on any globe starts a surface-pinned rotation; secondaries copy the primary's quaternion each frame so all globes spin together. (The plan originally had tap-to-promote here, but it created a ping-pong loop — tap a secondary → it becomes primary → user's ray now hits the NEW secondary → re-promote on next tap — so the path was ripped out in `cead66d`. A replacement UX goes in a later phase.) |
| 6 | `vrHud: primary-aware panel indicator strip` | Small dot strip showing panel count with primary highlighted; dataset title reflects primary |

Commits 2-4 are the "visible 2-globe arc" milestone. 5-6 add
interaction + UI polish. 4-globe is a stretch commit 7 after
on-device validation.

### Phase 3 — in-VR dataset switching ✅ *(shipped: floating CanvasTexture panel at 0.8 × 0.6 m, scrollable card list, controller-raycast card selection, HUD Browse button toggles visibility, single-row category chip filter. Virtual-keyboard free-text search was deferred in favor of chips per the recommendation below; voice search can come with Phase 5.)*

The single biggest UX gap after MVP: the user must exit VR, pick a
dataset in the 2D browse panel, then re-enter VR. Phase 3 brings a
floating browse panel into the VR scene so dataset switching happens
without leaving the headset.

**Design:**

A CanvasTexture panel (~0.8 m × 0.6 m) floating to the right of
the globe at a comfortable reading distance (~1.2 m from the user).
The panel renders the dataset catalog in a scrollable list with
category chips, search, and thumbnails — a simplified mirror of the
2D `browseUI.ts`.

Controller interaction mirrors the HUD: raycast → UV hit-test →
semantic actions (scroll, select category, select dataset). Trigger-
click on a dataset card calls `loadDataset()` through the session
context, which swaps the globe texture without ending the XR session.

The panel is toggled by a new "Browse" button on the HUD (same UV
hit-region approach as play/pause and exit). When hidden, no
CanvasTexture redraws run — zero cost in the steady state.

**Why CanvasTexture (not DOM overlay):**

Quest Browser supports DOM overlay (`optionalFeatures: ['dom-overlay']`)
which would let us reuse the existing `browseUI.ts` HTML directly.
Tempting, but:

- DOM overlay is a single flat layer composited on top of the XR
  content — it doesn't sit in 3D space, can't be pointed at with a
  controller ray, and can't be spatially placed. It's a HUD, not a
  panel.
- The same CanvasTexture infrastructure built here is reused by
  Phase 3.5 (tour overlays) and Phase 4 (Orbit speech bubbles).
  Building it once for browse pays for itself immediately.

**New modules:**

| Module | Est. LOC | Responsibility |
|---|---|---|
| `src/services/vrBrowse.ts` | ~400 | CanvasTexture panel: catalog rendering, scroll, category filter, search, dataset card tap → load callback |
| Extensions to `vrHud.ts` | ~30 | "Browse" button region + hit-test |
| Extensions to `vrInteraction.ts` | ~60 | Browse panel as raycast target, scroll via thumbstick-X when pointing at panel |
| Extensions to `vrSession.ts` | ~40 | Wire browse panel lifecycle, toggle visibility, pass dataset-load callback |
| `VrSessionContext` additions | ~20 | `getDatasets()`, `loadDataset(id)` — read from dataService, trigger load via main.ts |

**Commit sequence (~6 commits):**

| # | Commit | Scope |
|---|---|---|
| 1 | Plan doc: Phase 3 breakdown | This section |
| 2 | `vrBrowse: CanvasTexture panel scaffold` | Panel mesh, canvas drawing (title bar, placeholder list), show/hide. No data, no interaction. |
| 3 | `vrBrowse: dataset catalog rendering` | Wire `getDatasets()` from context, render cards with title + category chip + thumbnail placeholder. Scrollable viewport via canvas clip. |
| 4 | `vrBrowse: controller interaction` | Add browse panel to raycast targets. UV hit-test for card tap → `loadDataset(id)`. Thumbstick-X scrolls when ray is on the panel. |
| 5 | `vrHud: Browse button` | New HUD region toggles browse panel visibility. Icon + label. |
| 6 | `vrBrowse: search + category filter` | Text input via virtual keyboard or predefined category chips. Filter the rendered list. |

Commits 2-4 reach the "functional in-VR browse" milestone. 5 adds
discoverability (currently user would need to know the browse is
there). 6 is polish — the full catalog is browsable without
filtering, just slower.

**Virtual keyboard for search (commit 6):**

Quest Browser provides a system keyboard when an `<input>` is
focused, but that's DOM-level — we're in CanvasTexture land. Two
options:

1. **Built-in canvas keyboard** — draw a QWERTY layout on the
   bottom of the browse panel. Controller raycast types letters.
   ~200 LOC, self-contained, no platform dependencies.
2. **Category chips only** — skip free-text search entirely. The
   2D browse has 12 categories; rendering them as tappable chips
   is simpler and covers 90 % of the "find a dataset" use case.
   Full-text search can come later via voice input (Phase 5).

Recommend **option 2** for the initial release — category chips +
scrollable full catalog covers the use case without the complexity
of a VR keyboard.

**Thumbnail loading:**

Dataset thumbnails are small JPEG URLs from the enriched metadata.
Loading them into the CanvasTexture requires `Image()` → `drawImage()`
on the canvas after `onload`. Thumbnails load asynchronously and the
canvas redraws as each arrives — same progressive-render pattern as
a web page loading images. Failed thumbnails show a placeholder
icon (globe emoji or category color swatch).

### Phase 3.5 — VR tours (the museum experience) *(in progress on `claude/vr-tours-phase-3.5`)*

Tours are the killer app for VR Science On a Sphere. A real museum
SOS installation runs curated, narrated dataset sequences with
contextual graphics and the occasional interactive question — that
is _exactly_ the existing tour engine, just rendered on a virtual
sphere instead of a physical one. Bringing tours to VR turns the
app from "cool tech demo" into "actual SOS exhibit you can take
home."

**The good news:** the tour engine is already transport-agnostic.
`src/services/tourEngine.ts` plays SOS-format JSON files as a
sequence of tasks, calling back into the host for `loadDataset`,
`unloadDataset`, `setEnvView`, `togglePlayPause`, `setPlaybackRate`,
`announce`, and `resolveMediaUrl`. The intelligence is all there —
VR just needs to satisfy the callbacks and provide VR-equivalent
overlays for the parts that currently render to DOM.

**Module port matrix:**

| 2D module / behaviour | VR equivalent | Effort |
|---|---|---|
| `tourEngine.ts` task loop | Reuse unchanged | 0 |
| Tour text overlays (`tourUI.ts`) | CanvasTexture panels in 3D space | ~150 LOC |
| Tour image overlays | Plane mesh + image texture | ~50 LOC |
| Tour video overlays | Plane mesh + VideoTexture | ~50 LOC |
| Tour popup overlays | Floating CanvasTexture near globe | ~50 LOC |
| Interactive question overlays | CanvasTexture + controller raycast | ~150 LOC |
| Tour controls (play/pause/prev/next/stop) | Extend `vrHud.ts` | ~80 LOC |
| `setEnvView` (multi-globe) | Routes through Phase 2.5 multi-globe | reused |
| `worldIndex` routing | Per-panel `setTexture()` from Phase 2.5 | reused |
| Audio narration | `<audio>` element survives session lifecycle | ~30 LOC |

Total estimate: ~600 LOC for the new VR overlay surfaces +
plumbing. Substantially smaller than the MVP itself because the
heavy lifting (engine, dataset loading, sync) is reused.

**Dependencies:**

- **Phase 2.5 (multi-globe) is required**, not optional. Several
  tours use `setEnvView` to compare datasets across panels. Without
  multi-globe support, those tours break partway through. Tours
  without `setEnvView` would work earlier, but the experience is
  incomplete.
- Phase 3 (in-VR dataset switching) is **not** required — tours
  drive their own dataset loads through the engine, not through
  user-initiated browse. But the CanvasTexture infrastructure built
  for Phase 3's browse panel is directly reusable, so doing them
  in sequence is efficient.

**Overlay placement — locked in:** hybrid. World-anchored by
default (overlays float at fixed positions in the room — above
the globe, to the right at chest height) with an optional
gaze-follow toggle on the HUD that keeps overlays subtitle-style
in front of the user. Tours can also specify an anchor in the
tour JSON for specific spatial layouts (e.g. "this graphic
should appear to the left of the Atlantic"); the per-overlay
JSON hint wins when present. Ship world-anchor + gaze-follow
together from day one so the UX is validated end-to-end on device
rather than retrofitted after the fact.

**Interactive questions:**

Tour questions in 2D show a panel with multiple-choice answers and
buttons. In VR: same panel as a CanvasTexture, with controller
raycast for selection. Hit-test logic mirrors the HUD's `hitTest(uv)`
pattern from `vrHud.ts`. Single trigger-press + release on an answer
fires the selection.

**Audio narration:**

Tour narration is `<audio>` playback. The `<audio>` element is
DOM-level and continues playing across the WebXR session boundary
unchanged — no session-specific handling needed. Volume balance
might want a HUD slider eventually (museum environments vary in
ambient noise) but a fixed level is fine for v1.

**Commit sequence (branch: `claude/vr-tours-phase-3.5`):**

Decisions baked in before the first code change:

- **Overlay placement:** world-anchored default + gaze-follow
  HUD toggle, both shipping together (see above). Per-overlay
  tour-JSON anchor hint wins when present.
- **All work lands on one branch,** with mid-cycle pauses after
  commits 3 / 4 / 6 / 7 for on-device Quest validation before
  the next commit starts.
- **Fixtures already in-tree:** `/assets/test-tour.json` (Climate
  Connections — single-globe, text + image + popup tasks),
  `/assets/climate-futures-tour.json` (multi-globe `setEnvView`
  / `worldIndex` coverage), `/assets/test-setenvview-tour.json`
  (minimal `setEnvView` fixture). No S3 dependency.

Commit breakdown:

| # | Commit | Scope | Test pause? |
|---|---|---|---|
| 1 | Plan doc: lock Phase 3.5 decisions + commit breakdown | This section | — |
| 2 | `vrTourOverlay: CanvasTexture panel scaffold` | Panel mesh + canvas drawing (title, body text, close affordance), show/hide, world-anchor + gaze-follow pose modes. No engine wiring. | — |
| 3 | `vrTourControls + state plumbing` | New `vrTourControls.ts` module — a small floating strip below the main HUD with prev / play-pause / next / stop buttons + a step counter. Shown only while a tour is active. `VrSessionContext` gains `getTourState()` + tour control callbacks wired to `tourEngine` via main.ts. Kept as a separate mesh (not a vrHud extension) so the dataset HUD's geometry stays untouched. | **Pause** — strip should drive `test-tour.json` from VR even before overlays render |
| 4 | `vrTourOverlay: text + popup overlays via tourEngine callbacks` | Wire `tourUI`-equivalent callbacks into `tourEngine` host. World-anchor default, gaze-follow when toggled. | **Pause** — `test-tour.json` plays end-to-end with text |
| 5 | `vrTourOverlay: image + video overlays` | Plane mesh + image/video texture variants driven by overlay task payload. Reuse `fetchImageWithProgress` + HLS plumbing where applicable. | — |
| 6 | `vrTourOverlay: interactive questions` | CanvasTexture question panel with multiple-choice answer regions; controller raycast + UV hit-test mirrors `vrHud.hitTest(uv)` pattern. Selection fires tour-engine callback. | **Pause** — single-panel tours feature-complete |
| 7 | `vrTours: multi-globe routing (setEnvView + worldIndex)` | Route `setEnvView` through existing Phase 2.5 panel-count plumbing; `worldIndex` on `loadDataset` targets the right VR panel slot. | **Pause** — `climate-futures-tour.json` runs across the 2-globe arc |
| 8 | `vrHud: gaze-follow toggle + tour-JSON anchor override` | Hint-chip toggle on the HUD, persisted to localStorage; per-overlay `anchor` field in tour JSON wins over the global mode when present. | — |

Commits 2-4 reach the "tour plays with text overlays" milestone.
5-6 cover the remaining overlay surfaces for single-panel tours.
7 lifts the work to multi-globe. 8 is UX polish on anchoring.

### Phase 4 — Orbit Avatar (the docent gets a body)

The chat assistant "Orbit" is currently a text panel. This phase
gives it a physical presence: a small animated robot character that
orbits the Earth, flies up to the user when chatting, and zooms off
to point-of-interest locations on the globe. The avatar reinforces
the "museum docent" metaphor and — critically — teaches scale: Orbit
is a friendly companion at arm's length, then becomes a tiny speck
circling a continent, making the user *feel* how big Earth is.

**Character design constraints:**

- Small, friendly, non-humanoid (avoids uncanny valley).
- Satellite / probe / robot aesthetic — thematic with "orbiting
  Earth" and the name "Orbit".
- Low poly count (Quest GPU budget) — under 5K triangles.
- Rigged with a humanoid-compatible skeleton (or simple bone rig)
  so Mixamo / custom animations work.
- glTF 2.0 format (Three.js native).

**Model sources (free, animation-ready):**

| Source | License | Notes |
|---|---|---|
| Kenney robot pack | CC0 | Simple low-poly bots, perfect aesthetic |
| Ready Player Me stylized | MIT | Customizable, rigged for Mixamo |
| Mixamo animation library | Free (Adobe) | Hundreds of animations: hover, fly, wave, point, talk idle |
| Sketchfab CC-BY robots | CC-BY 4.0 | Several mascot/assistant-style models |
| Custom satellite/probe | — | Most thematic; ~1 day of Blender work |

**Behaviour state machine:**

```
                    ┌──────────────────────┐
                    │     ORBITING         │
                    │ (idle circuit around │
                    │  the globe, small)   │
                    └──────┬───────────────┘
                           │ user opens chat
                           ▼
                    ┌──────────────────────┐
                    │     APPROACHING      │
                    │ (flies toward user,  │
                    │  grows in perspec-   │
                    │  tive as it nears)   │
                    └──────┬───────────────┘
                           │ arrives ~1m from face
                           ▼
                    ┌──────────────────────┐
                    │     CHATTING         │
                    │ (hovers at arm's     │
                    │  length, talk anim,  │
                    │  eye contact)        │
                    └──────┬───────────────┘
                           │ LLM mentions a region /
                           │ user taps "show me"
                           ▼
                    ┌──────────────────────┐
                    │     PRESENTING       │
                    │ (flies to lat/lng,   │
                    │  shrinks as it       │
                    │  recedes, orbits     │
                    │  the POI, spotlight) │
                    └──────┬───────────────┘
                           │ user taps "follow me" →
                           │ globe auto-rotates to
                           │ track Orbit's position
                           │
                           │ user sends another
                           │ message / taps Orbit
                           ▼
                    ┌──────────────────────┐
                    │     RETURNING        │
                    │ (flies back to user, │
                    │  grows again — the   │
                    │  scale lesson        │
                    │  repeats every trip) │
                    └──────────────────────┘
```

**Scale design — the key insight:**

The user said: "use Orbit to emphasize the relative size of the
planet." The scale contrast is the entire point. Design targets:

- **Chatting:** Orbit hovers ~1 m from the user's face, apparent
  size ~15-20 cm (a third of the 0.5 m globe radius). It feels like
  a companion — something you could reach out and touch.
- **Presenting:** Orbit flies to a point on the globe surface. At
  the globe's scale (0.5 m radius), the flight path is ~1-2 m. Orbit
  doesn't need to artificially shrink — real perspective handles it.
  A 15 cm object at 2 m distance subtends ~4.3° vs. ~8.6° at 1 m.
  The user watches their "companion" become a tiny dot on a
  continent, and viscerally understands: *that whole landmass is the
  size of my friend's face.*
- **Follow me:** A floating button (or Orbit waves a "come look!"
  gesture) triggers a smooth globe auto-rotate to bring Orbit's
  current position front-and-center. The user doesn't have to
  manually search for where Orbit went.

**Flight path math:**

The flight path is a cubic Bézier from camera-relative coords to a
lat/lng point on the globe surface:

```
P0 = Orbit's current position (near user)
P1 = P0 + forward * 0.3  (ease out from user)
P2 = target + normal * 0.5  (ease into globe surface tangentially)
P3 = target (lat/lng → 3D point on globe surface)
```

`getSunPosition` already converts lat/lng → 3D direction; the same
`sunDirectionFromLatLng` utility gives us the target point.
`docentContext.ts` has dataset category/location metadata that can
drive where Orbit flies.

**Integration with existing chat:**

- `docentService` already emits `action` chunks with dataset IDs.
  Extend to emit `location` hints (lat/lng from enriched metadata)
  that the avatar system consumes.
- The LLM system prompt (`docentContext.ts`) can be extended with a
  `fly_to_location` tool alongside the existing `load_dataset` tool.
- Chat panel stays as-is (2D overlay or VR CanvasTexture from
  Phase 5); the avatar is an additive layer, not a replacement.

**2D mode (future, not in initial scope):**

A simplified version could work in 2D: a small animated sprite or
CSS-animated character that sits near the chat panel, flies across
the MapLibre canvas to a location, and returns. The 3D model could
be rendered to a small WebGL overlay or pre-rendered to a sprite
sheet. Deferred until the VR version proves the concept.

**New modules:**

| Module | Est. LOC | Responsibility |
|---|---|---|
| `src/services/vrAvatar.ts` | ~400 | glTF loader, animation mixer, state machine, flight path, scale management |
| `src/services/vrAvatarAssets.ts` | ~100 | Model URL constants, animation clip names, preload |
| Extensions to `docentService.ts` | ~50 | Emit location hints from LLM response metadata |
| Extensions to `docentContext.ts` | ~30 | `fly_to_location` tool definition for the LLM |
| Extensions to `vrSession.ts` | ~50 | Wire avatar into render loop + chat open/close callbacks |

**Commit sequence (~8 commits):**

| # | Commit | Scope |
|---|---|---|
| 1 | Plan doc: Phase 4 breakdown | This section |
| 2 | `vrAvatar: model loader + idle orbit` | Load glTF, attach to scene, circular orbit path around globe. No interaction yet. |
| 3 | `vrAvatar: animation mixer` | Idle hover / fly / talk animations via `AnimationMixer`. Crossfade on state change. |
| 4 | `vrAvatar: approach + return flight` | Bézier flight from orbit → user (chat open) and user → orbit (chat close). |
| 5 | `vrAvatar: presenting flight` | Fly to lat/lng on globe surface. Globe auto-rotate to track. "Follow me" button. |
| 6 | `docentService: location hints` | Emit lat/lng from dataset enriched metadata. Avatar consumes in presenting state. |
| 7 | `vrAvatar: spotlight + gesture` | Subtle glow on globe surface at POI. Point/wave animation at presenting target. |
| 8 | `vrAvatar: polish + tuning` | Flight speed curves, idle orbit radius, approach distance, animation blend times. |

Commits 2-4 reach the "avatar flies to user and back" milestone.
5-6 add the "show me" → "follow me" loop. 7-8 are polish.

**Dependencies:**

- Phase 2.5 (multi-globe) should be landed — avatar needs to know
  which globe to orbit (primary).
- Phase 5 (voice) is independent — the avatar works with text chat.
  Voice input is a natural follow-on that makes the avatar feel
  alive ("talk to Orbit" vs. "type to Orbit"), but the avatar's
  state machine doesn't depend on it.

**Open questions:**

1. Should Orbit have a speech bubble in 3D space (CanvasTexture
   floating near its head) in addition to / instead of the chat
   panel? Adds personality but is harder to read for long responses.
2. Does Orbit need lip-sync or a simple "mouth open/close" cycle
   during talk animation? Lip-sync from TTS is possible but complex.
3. Should Orbit's orbit path respond to the current dataset — e.g.
   orbiting along the equator for ocean datasets, circling the poles
   for ice datasets? Cool but potentially distracting.
4. Model selection: custom satellite probe (most thematic, most
   work) vs. off-the-shelf Kenney robot (fastest to prototype)?
   Recommend: prototype with Kenney, swap for a custom model later.

### Phase 5 — richer interaction, voice-driven Orbit & camera sync

**Orbit as a VR docent.** Typing is impractical in VR; voice is
the natural replacement. The Quest browser is Chromium-based and
exposes the standard Web Speech API — both `SpeechRecognition`
(speech-to-text, cloud-based via Google STT) and `SpeechSynthesis`
(text-to-speech, works offline with built-in voices). Neither is
blocked by an active WebXR session.

The interaction loop:

```
User holds "talk" button → speaks question
  → SpeechRecognition → transcript text
  → docentService.processMessage(transcript)  [existing, unchanged]
  → LLM streams response chunks                [existing, unchanged]
  → VR chat panel renders text (CanvasTexture)  [new]
  → SpeechSynthesis reads response aloud        [new, optional]
  → <<LOAD:...>> markers swap globe texture     [new, small]
```

Most of Orbit's backend is transport-agnostic already:
`docentService`, `docentContext`, `docentEngine`, `llmProvider` all
take a string in and stream chunks out — none are DOM-specific.
Only `chatUI.ts` (the DOM rendering layer) is 2D-only. VR needs a
parallel rendering surface, not a rewrite of the intelligence.

**New modules (~450 LOC total):**

| Component | LOC est. | Notes |
|---|---|---|
| Voice input | ~100-150 | `SpeechRecognition` + push-to-talk (controller button or HUD mic icon). Visual: recording indicator, live transcript on the chat panel. |
| VR chat panel | ~200-300 | CanvasTexture panel (larger than the HUD — subtitle-panel sized, floating near the globe). Word-wrap, auto-scroll, streaming text append. |
| Voice output | ~50 | `SpeechSynthesis` reads Orbit's response. Strip `<<LOAD:...>>` markers before speaking. Toggle on/off via HUD. |
| Dataset actions | ~50 | `<<LOAD:DATASET_ID>>` markers trigger `vrScene.setTexture()` directly — partial delivery of Phase 3 without the browse panel. |
| Feature detection | ~20 | `'SpeechRecognition' in window` — hide voice features if unavailable. |

**End-to-end latency:** ~1 s for speech recognition + 2-3 s for
LLM first token. Comparable to asking a museum docent a question
and waiting for them to think — feels natural in a spatial context.

**Caveats:**
- `SpeechRecognition` requires network (Google cloud STT). The
  local docent engine (`docentEngine.ts`) still works as a fallback
  if the LLM is unreachable, but the voice INPUT itself needs
  connectivity.
- Quest microphone picks up room audio; recognition accuracy may
  vary in noisy environments.
- Long Orbit responses need careful typography on the VR chat panel
  (font size, line height, scroll behaviour on a CanvasTexture).

**Hand tracking — bat the globe with your hands.**

Quest 2/3/Pro all support the WebXR `hand-tracking` optional feature,
which exposes 25 joint positions per hand each frame. Three.js wraps
this via `XRHandModelFactory` + `OculusHandModel` (realistic Quest
hand renders) for visuals, plus raw joint access for interaction.

The interaction goal is physical: just wave your hand at the globe
and it spins, like batting a beach ball. Implementation:

1. Track key joint positions each frame — index fingertip, middle
   fingertip, palm centre.
2. Detect when a joint enters the globe's bounding sphere (cheap
   sphere-vs-point test against the scaled GLOBE_RADIUS).
3. On contact, compute the hand's velocity at the contact point
   (current position − previous position, divided by deltaSeconds).
4. Apply that velocity as an angular impulse to the globe — feeds
   directly into the existing `inertia` mode in `vrInteraction.ts`
   (`{ kind: 'inertia', velocity }`). The flick-to-spin physics
   already handles decay; hand contact is just a new input source.

Effort: ~150-200 LOC for functional hand tracking + bat physics.
Another ~100 LOC for polish (visual contact flash on the globe
surface, palm-grab vs. finger-flick distinction, optional haptic
feedback if the user is also holding controllers as backup).

Bundle impact: `XRHandModelFactory` + `OculusHandModel` are addon
modules (similar size to `XRControllerModelFactory`, ~15-20 KB
gzipped). Lazy-load alongside Three.js. Hand mesh assets fetch
from a CDN at runtime.

**Quest hardware:** All Quest models support hand tracking, but it
needs to be enabled in the system settings (Settings → Movement
Tracking → Hand and Body Tracking). The WebXR feature request is
optional, so users without it gracefully fall back to controllers.

**Other Phase 5 items:**
- **Camera sync:** entering VR inherits the current MapLibre view
  (lat/lng/zoom → initial globe quaternion); exiting VR writes the
  last globe orientation back so the 2D view resumes where the user
  left off.
- Other gesture interactions beyond bat (pinch-and-place, two-handed
  pinch-zoom replicating the controller version)

---

## AR-native enhancements — beyond mode-agnostic features

The phases above are mostly mode-agnostic — they work in VR and AR
identically because they're just Three.js scene content. The features
in this section are different: each one **does something AR does
better than any other medium**, and several do something AR can do
that 2D genuinely can't.

Framing question: after the MVP + Phase 2.1 (spatial placement), the
app is a "VR app that happens to support passthrough". This section
is what turns it into "a killer AR app that takes advantage of the
unique platform."

### What makes AR uniquely powerful for SOS

**1. The globe is a physical object in your space.**
Spatial placement + persistence (Phase 2.1) gets us "globe on my
kitchen table." What builds on top:

| Enhancement | Status | Why it's killer |
|---|---|---|
| Spatial placement on a real surface | Planned (Phase 2.1) | The "this is real to me" moment |
| Persistent anchors across sessions | Planned (Phase 2.1) | Same globe waiting for you tomorrow |
| Walk around it | Free (once placed) | Physical perspective change is impossible in 2D |
| **Scale flexibility — palm-sized to room-sized** | Partial (zoom only) | "Hold the Earth in your hand" → "stand inside a planetarium" — a uniquely AR/VR continuum |
| Multi-globe in physical space | Planned (Phase 2.5) | Three spheres on your table, walk between them to compare |

**2. The interaction is your body, not a UI.**

| Enhancement | Status | Why it's killer |
|---|---|---|
| Hand tracking + bat physics | Planned (Phase 5) | "Throw" the globe to spin it — uniquely physical |
| Voice docent (Orbit in VR) | Planned (Phase 5) | Ask out loud, get spatial response — like a museum guide |
| **Touch-to-highlight regions** | Not planned | Literally point a finger at the Atlantic to learn about it |
| **Two-handed time control** | Not planned | One hand grabs the globe, other hand "pulls" time forward |
| **Reach-into-globe gestures** | Not planned | Pinch through the surface to peel back a data layer |

**3. The output uses all the sensors.**

| Enhancement | Status | Why it's killer |
|---|---|---|
| **Spatial audio narration** | Not planned | Hurricane wind from the storm's direction; docent voice from the HUD's position. Adds a sense. |
| **Real-time data streaming** | Not planned | "Here's where Hurricane X IS, right now, on your table" |
| **Capture / share** | Not planned | Record video of the globe in your room → social marketing for SOS itself |

---

### Killer features missing from the current plan

Ranked by impact-per-effort for an AR-first product.

#### 🥇 Spatial audio (~150 LOC)

Three.js has `PositionalAudio` built in. Attach narration to the
docent panel, weather sounds to the globe surface, ambient ocean
sounds to the oceans-visible side of the sphere. Adds an entire
perceptual dimension that 2D literally can't deliver.

Phase 5 mentions Orbit voice output (`SpeechSynthesis`) but doesn't
cover positional audio specifically. The enhancement: pipe the
`SpeechSynthesis` output through `THREE.PositionalAudio` attached to
the docent panel node. The voice comes from where the panel is,
spatially. Same for dataset-specific ambient audio tracks.

#### 🥇 Spatial annotations / bookmarks (~250 LOC)

Plant virtual labels in space: "Hurricane Katrina, August 28 2005"
floating above the Gulf, anchored persistently. Authoring (drop pins
via raycast) + viewing (read the label) + persistence (save anchors
per dataset, restored on next load). Educationally enormous for the
museum mission — turns the globe from "thing I look at" into "thing I
work with."

Depends on Phase 2.1's anchor infrastructure; natural follow-on.

#### 🥈 Capture / share (~100 LOC)

The Quest browser's canvas supports `MediaRecorder` for video
capture. "Look at the storm on my kitchen table" → 30-second clip
→ posted to social. Free marketing for both the app and for NOAA
SOS the program. Low effort, very on-brand.

Implementation: hook `MediaRecorder` up to the renderer canvas's
captureStream(), save the resulting WebM via a Blob URL, expose a
"Share" HUD button that triggers a 15-30 s recording.

#### 🥈 Real-time data streaming (~300 LOC + backend)

Many SOS datasets are historical animations. But some — current
weather, current storm position, current solar activity — could be
near-real-time. Especially powerful in AR because the present-tense
framing ("this is happening RIGHT NOW and it's on my table")
intensifies the spatial presence.

Needs a backend feed or a partnership with NOAA's real-time data
services. Frontend work is small once the data pipe exists:
the existing `VrDatasetTexture` image variant already handles
arbitrary image sources.

#### 🥉 Co-presence / multi-user AR (~600+ LOC, plus backend)

**The biggest, hardest, most transformational enhancement.** Two
people in the same physical room, both wearing Quests, both seeing
the same globe at the same anchor position. They can point,
discuss, interact together. Huge for classrooms, family museum
visits, guided tours, research collaboration.

Quest supports this via shared spatial anchors — either
cloud-anchored (via Meta Spatial Anchors API) or locally-beamed
between devices on the same network. Requires:

- Shared anchor primitive (Meta's API, or a custom solution via
  local networking + marker-based alignment).
- State sync for globe rotation, zoom, dataset, playback position
  — WebRTC data channel or websocket.
- Participant presence (see the other person's controller or hand
  avatars in your view).

High effort, but the payoff is a whole new category of use case.
Worth a dedicated phase eventually — probably after voice + hand
tracking land, because those give us more natural collaboration
primitives to sync.

#### 🥉 Layered datasets (~400 LOC)

Show two datasets simultaneously on the same globe (e.g. sea
surface temperature with cloud cover overlay), each with its own
opacity slider. Multi-globe (Phase 2.5) gives side-by-side; layered
gives superimposed. AR's lean-in-to-inspect physicality rewards
the information density.

Requires:
- Material multi-map support in `vrScene.ts` (two texture slots +
  a fragment shader blending them).
- Per-layer opacity controls in the HUD.
- Per-layer time-scrubbing if the datasets have different temporal
  ranges (they usually do).

### Honorable mentions

- **Active tours with spatial cues** — a tour saying "look at the
  Atlantic" rotates the globe + fires a spatial audio chime from
  that direction. Polish layer on Phase 3.5; minimal code delta.
- **Touch-to-highlight via hand tracking** — point your finger at a
  region, contextual info appears. Phase 5 + hand tracking enables
  this naturally.
- **Globe-as-planetarium ceiling** — when scaled large enough, the
  atmosphere wraps around you. Stretch goal; big wow factor.

---

### The killer-app arc

The minimum set of enhancements that make this **feel like a killer
AR app** rather than a "VR app with passthrough":

1. **Spatial placement + persistence** (Phase 2.1) — the "this is real to me" moment.
2. **Spatial audio** — adds the dimension that makes virtual content feel embodied.
3. **Voice docent + hand tracking** (Phase 5) — natural-modal interaction without needing controllers.
4. **Annotations / bookmarks** — turns the globe from "thing I look at" into "thing I work with."

Get those four right and the app stops being a neat tech demo and
becomes an actual SOS exhibit you carry in your headset.

Co-presence is a separate axis — social/educational rather than
solo-immersive — and worth a dedicated phase eventually. But it's
complex enough not to be on the critical path for "ship something
amazing soon."

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
