# Multi-Monitor Output Plan — installation-grade displays

Feasibility plan for driving one or more secondary display
surfaces from Terraviz: a control window on the operator's
primary monitor and one or more borderless fullscreen output
windows on adjacent monitors, each rendering an equirectangular
projection of the live globe state suitable for an LED sphere or
similar 2:1-input device.

Status: **draft for review.** Nothing implemented; this document
exists to align scope and architecture before any code lands.

The motivating use cases are concrete and somewhat narrow:

1. **Science On a Sphere–style LED globe.** The control window
   shows the normal interactive UI; a second window outputs the
   currently-loaded globe state as a 2:1 equirectangular image,
   designed to be re-wrapped around the physical sphere's pixel
   grid.
2. **Planetarium domes.** Multiple projectors, each fed by a
   slice of the data — typically fisheye or pre-warped
   rectilinear sub-frames.
3. **Lecture / kiosk dual-display.** A presenter drives the
   control window on a podium screen while the audience sees a
   mirrored output on a wall-sized TV.

Use case (1) is the v1 target. Use cases (2) and (3) are
designed-for-but-deferred — the window-management plumbing built
for v1 admits both as additive phases with no rework of v1 code.

---

## Goal

Let an operator running Terraviz desktop on a workstation with
multiple monitors:

- Pick a target monitor and click **"Add output"**.
- Choose an output mode (v1: equirectangular SOS).
- See a borderless fullscreen window appear on that monitor
  that mirrors the *composited globe state* of the control
  window's primary panel — including the active dataset, any
  stacked data layers, the day/night base Earth, and the live
  playback position.
- Have that output stay synchronized as the operator switches
  datasets, plays/pauses, scrubs, or runs a tour.
- Tear down the output cleanly without affecting the control
  window or any other output.

The control window's UX is **untouched**. Operators who never
open Tools → Outputs see no behavioural change.

## Constraints found during exploration

### 1. The source asset is not the right thing to display

A first-pass design considered shipping the dataset's raw
2:1 equirectangular asset (`<img>` or `<video>`) full-frame to
the output window — the SOS catalog is *almost* entirely
authored in 2:1 equirectangular, and `mapRenderer.updateTexture`
(line 856) and `setVideoTexture` (line 875) confirm the
expected projection. The shortcut works for the trivially-easy
case but breaks for everything realistic:

- **Non-global datasets.** Datasets with a CONUS or other
  regional bounding box are not 2:1 — they're a strip that the
  globe places at a specific lat/lon range. Shipped raw, the
  output sphere shows the strip stretched across its entire
  surface in the wrong place.
- **Composited overlays.** Country borders, gridlines, place
  markers, multi-globe sync indicators — none of these exist
  in the source asset. They exist only as a composite in the
  control window's render output.
- **Multi-layer stacks.** When an operator loads a base layer
  (e.g. SST) plus a foreground layer (e.g. cyclone tracks), the
  output needs the composite, not just the base.

**Implication:** the output window must produce its own
equirectangular composite. The source asset alone is
insufficient.

### 2. MapLibre cannot natively render an equirectangular projection

MapLibre owns its WebGL context, projection matrices, and tile
rendering pipeline. Its globe projection is a Mercator
derivative deformed to a sphere on the GPU; it does not expose
"render this scene to a 2:1 equirectangular framebuffer" as an
operation. Three rejected alternatives:

| Approach | Why rejected |
|---|---|
| **Capture the control window's WebGL canvas + inverse-warp** | Operator's camera only sees one hemisphere at a time. The far side of the globe is unrecoverable from the capture. Fundamental. |
| **Run six MapLibre instances at cubemap angles, then convert** | MapLibre is heavy; six concurrent instances will not fit in workstation GPU memory at LED-sphere resolutions, and MapLibre's globe projection still distorts each face. |
| **Server-side render via headless Chrome / Cloudflare** | Latency-incompatible with live video playback; doubles the rendering cost on shared infrastructure; doesn't solve the projection problem either. |

The accepted approach is to run a **parallel headless Three.js
scene** in the output window itself, mirroring the control
window's globe state, and render that scene directly to a 2:1
equirectangular framebuffer via a single fragment-shader pass.

Three.js was already chosen for the VR system (`vrSession.ts`
+ `vrScene.ts`), and the `photorealEarth.ts` factory already
produces a fully composited Earth sphere (diffuse, night
lights, specular, atmosphere, clouds, sun) used by both VR and
the Orbit character page. The output system reuses that
factory directly. We add:

- A dataset-texture overlay layer (already done by `vrScene.ts`
  on top of `photorealEarth`).
- A multi-layer stack support for overlapping datasets (new —
  semi-transparent sphere shells at radii 1.000, 1.001, 1.002,
  …).
- An equirectangular render-to-texture pass (new — single
  fragment shader; ~80 LOC).

### 3. Equirectangular RTT is one shader pass, not a cubemap

The naive "360 camera at the center" framing translates to two
flavors:

- **Cubemap-from-center → equi convert.** Render six cube faces
  from a camera at the globe's center looking outward at the
  inside surface, then sample the cubemap at every (lon, lat)
  to produce equirectangular. Two passes, six render-target
  switches, pole stretching artifacts where cubemap pixels are
  smeared.
- **Direct equirectangular RTT.** Skip the cubemap entirely.
  For each output pixel `(u,v) ∈ [0,1]²`, compute the world
  direction `(lon, lat) = (u·2π − π, v·π − π/2)`, raycast that
  direction *from a configurable camera position* (default
  `(0,0,0)` — the sphere center) against the sphere stack,
  sample each layer's composited texture at the hit point. One
  pass, native 2:1 output, no pole artifacts. The camera
  position is a shader uniform; v1 pins it to the origin but
  Phase 2+ uses a non-zero offset to implement zoom — see
  §3.5.

Direct RTT wins on every axis. The shader is well-known
(equirectangular projections are textbook) and only ~80 LOC of
GLSL. We commit to direct RTT for v1 and never build the
cubemap path.

### 4. The shared `<video>` element trick from VR doesn't carry over

In VR, the same `HLSService.video` element is consumed by both
MapLibre's `VideoTexture` and Three.js's `VideoTexture` —
identical decoder, perfect sync, zero extra bandwidth. That
pattern works because both consumers share the same DOM
document.

A second Tauri webview window has its **own DOM, own JS
context, own decoder, and own video element**. We cannot
literally pass the primary's `<video>` to the output window.

For v1: the output window receives the dataset URL from the
control window via Tauri events, creates its own `HLSService`,
and decodes independently. The control window broadcasts
`currentTime` and `paused` once per second; the output runs a
three-region correction algorithm (tolerance / soft `playbackRate`
nudge / hard seek with hysteresis) — see §3 "Playback sync
algorithm" for the exact thresholds, transitions, and edge
cases. Drift is typically <100 ms in practice — imperceptible
on an LED sphere where each pixel covers a non-trivial physical
area.

A future Phase 5 polish (see Roadmap) could introduce a shared
GPU texture handle to eliminate the second decoder. We don't
need it for v1.

### 5. Tauri capabilities are scoped to the main window today

`src-tauri/capabilities/default.json` declares:

```json
"windows": ["main"],
```

Output windows are new labels — `output-1`, `output-2`, etc. —
and won't inherit `default`'s permissions unless we either:

- Broaden `windows` to `["main", "output-*"]` (glob supported in
  Tauri capabilities), or
- Author a separate, narrower capability file
  (`capabilities/output.json`) that grants only what the output
  window actually needs (window controls, http for HLS, no
  filesystem, no keychain).

The narrower capability is the right choice — output windows
have no reason to read the keychain or invoke download
commands, and giving them no surface area limits the blast
radius if a malicious dataset URL ever exploits the output
webview. See §5 ("MVP scope") for the exact permission set.

### 6. Tauri's window-creation API is JS-side

Tauri v2 exposes `WebviewWindow.new(label, options)` from
`@tauri-apps/api/webviewWindow`. We don't need to touch Rust at
all to create output windows in v1 — the control window's TS
service spawns and tears them down via this API, and IPC events
flow via `getCurrent().emit(...)` (JS side, window-to-window).

Already-granted Tauri permissions cover the required ops:

- `core:window:default` — create / destroy / show / hide
- `core:window:allow-set-fullscreen` — borderless fullscreen
- `core:window:allow-set-size` — explicit size for non-fullscreen
- `core:window:allow-set-position` — pin to monitor X/Y
- `core:window:allow-available-monitors` — enumerate monitors
- `core:window:allow-current-monitor` — detect which monitor

### 7. Vite multi-entry build

The output window loads a separate HTML page (`output.html`)
so its JS bundle is decoupled from the heavy main app — no
MapLibre, no UI shell, no Orbit, no analytics emitter (until
we decide what to do about telemetry, see Open Questions).
Vite supports this via `rollupOptions.input` with multiple
entries.

The output bundle's runtime dependency is **Three.js** (lazy-
loaded, same chunk that VR already pulls — HTTP-cached from
the user's first VR session if any). Estimated bundle:

- Output entry shell (HTML, CSS, protocol handler): ~10 KB gz
- Three.js core: ~150 KB gz (already lazy-chunked for VR)
- `photorealEarth.ts` + new equirect shader: ~30 KB gz
- HLS.js (lazy-loaded only for video datasets): ~80 KB gz

For an SOS install that only ever shows video datasets, the
output process holds ~270 KB of JS resident. Workstation-class
hardware, completely fine.

### 8. Web fallback is constrained but nice-to-have

`window.open()` in a browser is subject to popup blockers,
the Fullscreen API on a popped window has historically been
flaky across browsers, and `BroadcastChannel` is the pragmatic
IPC channel between same-origin browser windows.

V1 ships **desktop-only**. The architecture is designed so a
web implementation could replace the Tauri window/IPC layer
with `window.open()` + `BroadcastChannel` later without
touching the output rendering code. See Phase 5.

---

## Architecture

```
┌────────────────────────────────────────┐    ┌──────────────────────────────────┐
│ Control window (existing main app)     │    │ Output window (output.html)      │
│                                        │    │                                  │
│ MapLibre canvas + DOM UI               │    │ Three.js WebGLRenderer (headless)│
│  └─ ViewportManager (1/2/4 globes)     │    │  ┌────────────────────────────┐  │
│  └─ datasetLoader.{loadImage,loadVideo}│    │  │ photorealEarth sphere      │  │
│                                        │    │  │  + dataset texture overlay │  │
│ + new MultiOutputManager service       │    │  │  + multi-layer shells      │  │
│  ├─ enumerate monitors                 │ ──>│  └────────────────────────────┘  │
│  ├─ spawn/destroy WebviewWindow        │evt │             │                    │
│  ├─ broadcast globe state diff         │    │             ▼                    │
│  └─ persist last-used config           │    │  ┌────────────────────────────┐  │
│                                        │    │  │ Equirect RTT shader pass   │  │
│ + new outputUI panel in Tools menu     │    │  │  (single fragment shader,  │  │
│                                        │    │  │   2:1 framebuffer)         │  │
│                                        │    │  └────────────────────────────┘  │
│                                        │    │             │                    │
│                                        │    │             ▼                    │
│                                        │    │  Full-bleed <canvas> at 2:1      │
└────────────────────────────────────────┘    └──────────────────────────────────┘
                  │                                          ▲
                  └──── Tauri events (window→window) ────────┘
                       (state diffs, ~1 msg per state change)
```

### Globe state — what gets mirrored

The control window's `MultiOutputManager` maintains a
serialisable snapshot of "what the primary panel is showing,"
broadcast as a diff whenever it changes. v1 captures:

| Field | Source | Update trigger |
|---|---|---|
| `dataset.id`, `dataset.url` | `datasetLoader` | dataset load / unload |
| `dataset.kind` (image / video) | `datasetLoader` | dataset load |
| `dataset.bbox` (or `null` for global) | enriched dataset metadata | dataset load |
| `playback.currentTime` | `playbackController` | per-second tick (video only) |
| `playback.paused` | `playbackController` | play / pause action |
| `layers[]` (stacked-layer ids and z-order) | new `layerStack` state in `main.ts` | layer add / remove / reorder |
| `time.simulationDate` | playback engine | date label tick |
| `view.dayNight` (toggle on/off) | Tools menu | toggle change |
| `view.cameraOffset` (Vector3) | Manager (computed from MapLibre camera) | default-on for SOS LED sphere outputs in v1; can be disabled per output. Pinned to `(0,0,0)` when tracking is off, which produces a uniform 1:1 equirectangular unwrap. See §3.5. |
| `view.split` (boolean) | Outputs panel toggle | per-output flag. When on, the area of focus is mirrored to the opposite hemisphere of the physical LED sphere — matches existing SOS sphere-split behavior. See §3.5. |

The SOS output **does** track the operator's MapLibre camera
by default in v1: zooming in the control window concentrates
pixels around the area of focus on the LED sphere, the rest
of the globe compresses on the antipodal side. This is the
expected operator workflow on existing SOS installations and
visitors read it intuitively — see §3.5 for the math and the
per-mode defaults table. An operator who wants the LED sphere
to remain a 1:1 representation regardless of where they pan
the control window flips the per-output "Track operator
camera" toggle off; the cameraOffset pins to zero and the
output renders a uniform equirect.

The control window keeps its own independent MapLibre camera
as today — `cameraOffset` is a derived broadcast, not a
two-way binding.

### New modules

| File | Responsibility |
|---|---|
| `src/services/multiOutput/manager.ts` | `MultiOutputManager` — singleton: enumerates monitors, spawns/destroys output windows, builds and broadcasts globe-state diffs, persists config, monitors output health (crash detection, IPC heartbeats, monitor-unplug 2 s poll, boot scan for orphaned `output-*` windows after a control-window crash — see "Failure recovery") |
| `src/services/multiOutput/protocol.ts` | Shared TS types for control↔output IPC events. Imported by both bundles. Single source of truth for the state schema above. |
| `src/services/multiOutput/stateAggregator.ts` | Subscribes to dataset / playback / layer / time / view events, builds the state snapshot, emits diffs |
| `src/ui/outputUI.ts` | Tools → Outputs panel — list current outputs, "Add output" button, per-output config menu (monitor, mode, "Track operator camera" toggle, "Split sphere" toggle, debug overlay), per-output health badge (healthy / stale / stalled / monitor-missing — see "Failure recovery") |
| `output/main.ts` | Output window entry. Creates Three.js renderer, builds `photorealEarth` scene + dataset overlay + layer stack, runs equirect RTT each frame, displays to a full-bleed canvas. Wires `webglcontextlost` / `webglcontextrestored` listeners and an IPC-silence watchdog (5 s tolerance, stale state thereafter — see "Failure recovery") |
| `output/equirectRtt.ts` | Equirectangular render-to-texture pass — single fragment shader. Raycasts from a configurable camera offset (`uCameraOffset`, derived from the operator's MapLibre camera by default; see §3.5) at every (lon, lat) of the output framebuffer. Supports split mode (`uSplit`) that mirrors the area of focus to the antipodal hemisphere of the LED sphere. |
| `output/datasetMirror.ts` | Output-side companion to control-window `datasetLoader` — given a `dataset.url` + `dataset.kind` + `dataset.bbox`, builds a Three.js texture (image or HLS-driven VideoTexture) and a UV transform. Owns the playback sync state machine (see "Playback sync algorithm") and the HLS fatal-error retry loop (3× exponential backoff, freeze last good frame during retry — see "Failure recovery") |
| `output/layerStack.ts` | Builds and updates the multi-shell sphere stack from the layers state diff |
| `output/output.html` + `output/output.css` | Output window markup and styling — black body, no cursor, full-bleed canvas |
| `src-tauri/capabilities/output.json` | Narrow capability set scoped to `output-*` window labels: HTTP for HLS / image fetch, window controls, no filesystem, no keychain, no IPC commands |

### Modified modules

| File | Change |
|---|---|
| `src/main.ts` | Boot `MultiOutputManager`; wire it to dataset / playback / layer / **camera** events |
| `src/services/datasetLoader.ts` | Emit a `dataset:loaded` event the manager subscribes to |
| `src/services/mapRenderer.ts` | Emit a debounced `camera:moved` event with `{ lng, lat, zoom }` so the manager can derive `view.cameraOffset` for outputs that track operator camera |
| `src/ui/playbackController.ts` | Forward play / pause / scrubber events to the state aggregator |
| `src/analytics/errorCapture.ts` | Add a sanitized `output_failure` Tier A event path consumed by the manager — `{ label, kind, retries }` per occurrence (see "Failure recovery" §3) |
| `src/ui/toolsMenuUI.ts` | Add "Outputs" entry that opens the new Outputs panel; add a "Fullscreen" toggle that calls `getCurrentWindow().setFullscreen()` + `setDecorations()` and persists to localStorage (see §3.6) |
| `src-tauri/src/main.rs` | Parse `--kiosk` argv flag and `TERRAVIZ_KIOSK=1` env var in `setup()`; apply fullscreen + decorationless before first paint when set (see §3.6) |
| `src-tauri/capabilities/default.json` | Add `core:window:allow-set-decorations` (`core:window:allow-set-fullscreen` is already granted; `set-decorations` is not in the default set and is required so the runtime fullscreen toggle can also drop the title bar) |
| `vite.config.ts` | Add `rollupOptions.input` with `main` and `output` entries |
| `package.json` | No new runtime deps for v1 (Three.js already a runtime dep for VR) |

### Boot flow (v1, SOS equirectangular mode)

1. Control window boots normally. `MultiOutputManager.init()`
   reads `localStorage.sos-multi-output-config`. If empty (first
   launch, or user has never enabled outputs), it does nothing —
   no monitor enumeration, no IPC, zero overhead.
2. User opens **Tools → Outputs → Add output**. The panel calls
   `monitor.availableMonitors()` and presents a picker (label +
   resolution + position diagram). User picks a monitor and a
   mode (v1: only "SOS Equirectangular" available).
3. Manager calls `WebviewWindow.new('output-1', {...})` with
   `decorations: false`, `fullscreen: true`,
   `position: { x, y }` (the chosen monitor's top-left), and a
   navigation URL pointing at the bundled `output.html`. Tauri
   creates the window on the target monitor.
4. Output window boots `output/main.ts`. Page renders a black
   background. Lazy-imports Three.js. Builds `photorealEarth`
   into a hidden scene. Allocates a 2:1 framebuffer at the
   target resolution (e.g. 4096×2048 for an 8K LED sphere).
5. Output emits `output_ready` so the manager knows it's
   listening. Manager replies with a full state snapshot.
6. Output applies the snapshot: loads the dataset texture via
   `datasetMirror`, builds the layer stack via `layerStack`,
   sets playback to the broadcast `currentTime`. Begins
   rendering the equirect RTT each frame and presenting it
   to the canvas.
7. Done.

### Per-state-change flow

State diffs are broadcast on change, not on a polling clock:

- **Dataset load** → manager broadcasts `{ dataset: { id,
  url, kind, bbox } }`. Output's `datasetMirror` swaps the
  sphere overlay texture; for video, it tears down the old
  HLS instance and starts a new one.
- **Layer add / remove / reorder** → manager broadcasts the
  full ordered `layers[]` array (small enough that diffing
  is overkill). Output's `layerStack` rebuilds the shell
  stack accordingly.
- **Play / pause / seek** → manager broadcasts the discrete
  event. Output's video element pipes through.
- **Per-second timecode** → manager broadcasts
  `{ playback: { currentTime, paused } }`. Output applies
  the drift-correction algorithm — see "Playback sync
  algorithm" below.
- **Day/night toggle** → manager broadcasts the new state.
  Output flips the photoreal Earth's day/night shader uniform.
- **Output close** → output emits `output_closed` (or the
  manager observes the WebviewWindow close event). Manager
  drops the record.

The output **does not** request state on its own initiative
after `output_ready`. The control window is the single source
of truth.

### Per-frame flow inside the output window

1. Read latest state snapshot (most-recent-wins; older queued
   diffs are coalesced).
2. If `dataset.kind === 'video'` and a video element exists,
   call `videoTexture.needsUpdate = true`.
3. Update the photoreal Earth's sun position from
   `time.simulationDate` (uses existing `getSunPosition()`
   helper from `utils/time.ts`).
4. Render the sphere stack to the equirectangular framebuffer
   with the current `uCameraOffset` uniform (derived from the
   operator's MapLibre camera when "Track operator camera" is
   on for this output; `vec3(0)` when off) and `uSplit` flag.
5. Blit the framebuffer to the visible canvas (single
   `gl.blitFramebuffer` call, GPU-local — no CPU readback).

Frame rate target: 30 fps for video datasets, 1 Hz for static
images (don't redraw what hasn't changed). The render loop is
a `requestAnimationFrame` driver that early-outs on a
"nothing changed" check.

### Playback sync algorithm

The output's local `<video>` element drives the texture and
decodes independently of the control window's video (see
"§1 constraint #4" above — separate webview, separate DOM,
separate decoder). We
have to keep it within ~200 ms of the broadcast `currentTime`
without making the correction itself perceptible. A hard
`videoEl.currentTime = ...` reseek every second would jitter
the texture; an unbounded soft `playbackRate` adjustment would
take minutes to converge from a multi-second drift.

The compromise is a three-region algorithm with hysteresis,
applied each time a `{ playback: { currentTime, paused } }`
diff arrives (~1 Hz):

```ts
// Pseudocode in output/datasetMirror.ts, called per playback diff.
const local = videoEl.currentTime
const drift = local - broadcast.currentTime  // +ahead, -behind
const abs = Math.abs(drift)

if (paused) {
  if (!videoEl.paused) videoEl.pause()
  return                               // suspend correction while paused
}
if (videoEl.paused) videoEl.play()     // unpause if needed

if (abs >= HARD_SEEK_THRESHOLD) {       // 2.0 s
  videoEl.currentTime = broadcast.currentTime
  videoEl.playbackRate = 1.0
  state.correcting = false
  return
}

if (state.correcting) {
  // Inner band: drift converged; release the rate adjustment.
  if (abs < INNER_HYSTERESIS) {        // 50 ms
    videoEl.playbackRate = 1.0
    state.correcting = false
  }
  return
}

if (abs >= OUTER_HYSTERESIS) {          // 100 ms
  // Soft nudge: 5 % rate change in the catch-up direction.
  videoEl.playbackRate = drift > 0 ? 0.95 : 1.05
  state.correcting = true
}
```

Three regions:

| Region | Drift | Action |
|---|---|---|
| **Tolerance** | < 100 ms | No action — within decoder jitter and below perceptual threshold |
| **Soft nudge** | 100 ms – 2 s | `playbackRate = 0.95` (ahead) / `1.05` (behind). Held until drift drops below 50 ms (inner hysteresis), then `playbackRate = 1.0` |
| **Hard seek** | ≥ 2 s | `videoEl.currentTime = broadcast.currentTime`. Visible jump but the alternative (soft catch-up at 5 %/s for >40 s) is worse |

The hysteresis pair (100 ms enter, 50 ms exit) prevents
flapping between the tolerance band and soft-nudge region. The
5 % rate cap is below the perceptual threshold for most
viewers — speech intelligibility is the most sensitive cue and
typically tolerates ±6-10 %; video alone tolerates more.
Convergence time scales with starting drift: 100 ms → 2 s,
1 s → 20 s, both well under the 2 s hard-seek threshold.

**State changes that bypass the algorithm:**

- **Operator pauses** (`paused` flips to true) → `videoEl.pause()`
  immediately. Drift correction suspended until unpause.
- **Operator seeks** (the playback diff carries a discontinuity
  in `currentTime` — detected as `|local - broadcast| > 5 s`
  while operator was already in the tolerance band on the
  previous tick) → hard seek to broadcast `currentTime`,
  reset rate.
- **Dataset change** → tear down the HLS instance, start a
  new one; sync to broadcast `currentTime` once `'canplay'`
  fires.
- **HLS buffering / stall** (`videoEl.readyState < 3`) →
  freeze drift state; resume correction once `readyState >= 3`.
  Avoids spurious "behind" drift readings during stalls.

**What's not the algorithm's job:**

- A/V sync within a single decoder — the browser's `<video>`
  handles that. We only correct between decoders.
- Cross-output coherence — outputs A and B both sync to the
  control window, not to each other. Worst case they're each
  100 ms off the control window in opposite directions, so
  200 ms apart. Acceptable on physically-separated outputs;
  if it ever isn't (twin-LED-sphere installation), Phase 5's
  shared-GPU-texture work eliminates the second decoder.

Constants live in `output/datasetMirror.ts` as named
exports for tests:

```ts
export const TOLERANCE_MS = 100
export const HARD_SEEK_THRESHOLD_MS = 2000
export const INNER_HYSTERESIS_MS = 50
export const SOFT_NUDGE_RATE = 0.05  // ±5 %
```

### Failure recovery

Multi-window installations run for hours in production. The
plan must define what happens when something goes wrong —
otherwise an LED-sphere installation degrades silently the
first time a network blip or driver hiccup occurs.

Six failure modes are designed for in v1. Common pattern:
**preserve the last good visible state, surface the failure
in the Outputs panel, never auto-recover beyond bounded
retries.** Auto-respawn is rejected as a default — it masks
recurring crashes and obscures installation health.

#### 1. Output webview crashes

**Detection.** Manager listens for `WebviewWindow` close
events. A crash arrives as a `WindowEvent::Destroyed`
without a corresponding `output_closing` graceful-shutdown
ping; the absence of the ping distinguishes crashes from
operator-initiated close.

**Recovery.** Manager removes the output record, logs the
crash with timestamp and last-known dataset, and shows a
toast in the control window: "Output {label} crashed —
removed." Operator can manually re-add via Tools → Outputs.
**No auto-respawn in v1.**

**Crash storm guard.** If the same monitor sees 3 crashes
within 60 s, manager refuses to spawn outputs on that
monitor for the rest of the session and logs a hardware /
driver suspicion. Counter resets at next launch.

#### 2. HLS stream errors

**Detection.** HLS.js fires `Hls.Events.ERROR` with
`fatal: true`. The output's `datasetMirror` listens.

**Recovery.** Tear down the HLS instance, wait
exponential backoff (1 s, 2 s, 4 s), rebuild from the
same URL. Up to 3 attempts. **The texture freezes on the
last good frame during retry** — the LED sphere shows the
most recent imagery rather than going black.

After 3 failures: keep the texture frozen, emit
`output_dataset_stalled` to the manager. Manager surfaces
a status badge on that output in the Outputs panel.
Operator must manually reload the dataset (which triggers
a fresh HLS instance via the normal dataset-change path).

Non-fatal HLS errors (single-segment 404, transient 5xx)
are handled by HLS.js itself and never reach this layer.

#### 3. IPC channel goes silent

**Detection.** Output expects a state diff at least every
2 s during normal operation (the per-second timecode is
the floor). 5 s with no message → output enters **stale
state**.

**Recovery.** Output keeps rendering from its last known
state. The audience sees the last good content, frozen at
that moment. The Outputs panel shows a "stale" badge so
the operator knows the link is degraded.

If silence persists for 60 s with no manager response to
the output's `output_health_check` pings, the output
considers itself orphaned. **It does not self-destruct —
the LED sphere keeps showing content for any visitor
mid-session.** It just stops trying to phone home and waits.

When the manager comes back (reload, control-window
relaunch, network restored), the manager finds existing
`output-*` windows via `WebviewWindow.getAll()` at boot,
re-establishes IPC with each, and sends a fresh state
snapshot. Output exits stale state on receipt and resumes
normal rendering.

#### 4. Monitor unplugged mid-session

**Detection.** Manager polls `monitor.availableMonitors()`
at 2 s intervals (Tauri's monitor-change event API isn't
universal across platforms). A monitor disappearing while
an output is bound to it triggers the recovery path.

**Recovery.** Don't auto-destroy. The OS handles where the
window goes (macOS auto-moves to the remaining display;
Windows leaves the window attached to the phantom display
until reconnect; Linux is compositor-dependent — see Open
Question 1). Manager logs the event and shows a toast:
"Monitor {name} disconnected. Output {label}'s display is
unavailable."

After 60 s gone, manager surfaces a confirmation in the
Outputs panel: "Output {label}'s monitor is gone. Close
output?" — manual action only. On reconnect, manager
detects the monitor reappearing, moves the window back to
the persisted `{ x, y }` of that monitor (matched by
`monitorName`), and clears the toast.

#### 5. GPU context loss

**Detection.** Output's canvas listens for
`webglcontextlost` and `webglcontextrestored`. Triggers
include driver crash, OS sleep / wake, GPU hot-reset
under memory pressure.

**Recovery.** On `webglcontextlost`:
`event.preventDefault()` to allow restoration; mark
output state as `gpu_context_lost`. The texture and
framebuffer are gone; output renders nothing until
restored.

On `webglcontextrestored`: rebuild the Three.js scene
from scratch (textures, framebuffer, sphere stack) using
the fresh state snapshot the manager re-pushes. Same code
path as boot, just without recreating the window. Output
emits `output_gpu_recovered` to the manager for
installation logging.

If `webglcontextrestored` doesn't fire within 30 s (some
drivers don't recover): log + remove the output record;
operator manually re-adds.

#### 6. Manager / control window crash with outputs alive

**Detection.** Outputs detect this via case 3 (IPC
silence). When the operator relaunches, the manager runs
its boot scan path.

**Recovery (manager side at boot).** Before normal init
finishes, manager calls `WebviewWindow.getAll()` and finds
any `output-*` labeled windows that survived the control
window's death. For each:

- Send `output_reattach_ping`. If response within 5 s:
  re-establish IPC, send fresh snapshot, output exits
  stale state.
- If no response: assume dead, destroy via `webview.close()`,
  remove any orphaned record.

This makes control-window restart non-destructive for the
LED-sphere audience: the imagery stays on screen, refreshes
once the operator's relaunch completes.

#### Summary

| Failure | Detection | Auto-recovery | Audience-visible? | Operator-visible? |
|---|---|---|---|---|
| Output crash | Window destroy w/o graceful close | None | Output goes black | Toast + log; can re-add manually |
| HLS stream error | `Hls.Events.ERROR fatal:true` | 3× backoff retry (1, 2, 4 s) | Frozen last good frame during retry | Status badge; manual reload after retries exhausted |
| IPC silence | 5 s no diff | Render from last state indefinitely | Last good content stays visible | Stale badge in Outputs panel |
| Monitor unplug | 2 s `availableMonitors()` poll | None (OS handles window placement) | OS-dependent (auto-move or phantom) | Toast; close prompt after 60 s |
| GPU context loss | `webglcontextlost` event | Rebuild scene on restore (30 s timeout) | Black until restore | Recovery event logged |
| Manager crash w/ outputs alive | Output IPC silence + manager boot scan | Reattach via `getAll()` boot scan | Last good content stays visible | Toast on reconnect |

#### Policy summary

- **Bounded auto-recovery only.** 3 retries / 30-60 s
  timeouts. Beyond that, escalate to the operator. Avoids
  flapping installations that mask deeper issues.
- **Audience-visible vs operator-visible separation.** The
  audience never sees a manager- or IPC-side failure —
  only output-side failures (crash, GPU loss) affect the
  LED sphere directly. Manager and IPC failures preserve
  last good state.
- **All failures route through `errorCapture.ts`** with a
  stable signature so installation health can be tracked.
  Hashed for privacy where stack traces are involved (Tier
  B if Open Question 3 closes that way).
- **One control-window telemetry event per failure**:
  `output_failure` Tier A with `{ label, kind, retries }`.
  Output windows themselves emit nothing (matches §10
  default and §3.6 capture-clean policy — no hidden
  network from the LED-sphere surface).

### LED sphere zoom + split (matches existing SOS behavior)

The naive equirect RTT shader puts the conceptual "360 camera"
at the exact center of the sphere — every (u, v) of the output
maps to a unique unit-direction, every direction hits the sphere
at one point, and the result is a uniform equirectangular
projection. That's the **unzoomed** state: the operator's
control camera at default zoom, full Earth wrapped 1:1 around
the LED sphere.

If we move the camera to an offset position `o` (with `|o| < 1`
so it stays inside the sphere), the mapping becomes non-uniform.
For each output pixel, we ray-march from `o` along
`dir(u, v)` until the unit sphere is hit, then sample at the
hit point. Surface points on the side the camera moved toward
subtend larger angles → they take up more of the 2:1 frame.
The result is a continuously-warped equirectangular,
perceptually equivalent to "zooming into" the region the
camera moved toward. The far hemisphere shrinks but does not
clip — it just gets smaller.

**This is the expected behavior on the LED sphere**, and it
matches what the existing SOS ecosystem has done for over a
decade: when the operator zooms in on a hurricane, the area
of interest fills more of the physical sphere while the
antipode compresses. Visitors walking around the sphere read
it intuitively — the "interesting bit" is bigger because the
camera moved closer to it.

This makes off-center camera the **primary** mode for v1, not a
forward-compat hook. The shader takes a `uniform vec3
uCameraOffset`, the manager derives it from the operator's
MapLibre camera, and the Outputs panel exposes a "Track operator
camera" toggle that defaults **on** for SOS LED sphere outputs.

```ts
// V1 mapping — manager → output state, evaluated each frame the
// operator's MapLibre camera changes (debounced ~30 ms).
const lat = camera.center.lat
const lon = camera.center.lng
const zoomFactor = Math.min(1 - 1 / (camera.zoom + 1), 0.85)
const dir = sphericalToCartesian(lat, lon)
state.view.cameraOffset = dir.multiplyScalar(zoomFactor)
```

The 0.85 cap prevents the camera from approaching the sphere
surface, where the warp becomes degenerate (a single source
texel would smear across most of the LED sphere).

**Split mode.** Existing SOS spheres also expose a "split"
option that mirrors the zoomed area of focus to the opposite
hemisphere of the physical sphere — visitors standing on either
side of the LED sphere see the same hurricane, weather pattern,
or feature without having to walk around it. We match that.

Conceptually: render the off-center equirect at half longitudinal
width, then tile it twice across the output frame so the area of
focus ends up at U=0.25 and U=0.75 of the equirect, which the LED
sphere wraps to two longitudes 180° apart on its physical surface.

Implementation: one extra `uniform bool uSplit`. In the fragment
shader, when split is on, fold the input U coordinate via
`u_fold = fract(u * 2.0)` and feed `u_fold` into the same
ray-march. ~6 lines of GLSL on top of the off-center camera.

```ts
// Protocol additions to view state (see §3 'what gets mirrored').
view: {
  dayNight: boolean
  // Operator-camera tracking. Default on for sos-equirect mode
  // in v1; can be disabled per output for "always-1:1 globe"
  // idle displays.
  cameraOffset: { x: number; y: number; z: number }   // |o| ≤ 0.85
  // Mirror the area of focus to the antipodal hemisphere of the
  // LED sphere. Default off; toggled per output in the Outputs
  // panel.
  split: boolean
}
```

Per-mode defaults:

| Mode | Track operator camera | Split available | Notes |
|---|---|---|---|
| **SOS LED sphere** (v1) | Default **on** | Yes | Matches existing SOS sphere behavior. Operator can disable tracking for "always-1:1 globe" idle displays. |
| **Dome / fisheye** (Phase 2) | Default on | N/A (single-audience surface) | Smoothing filter added in Phase 2 to avoid jitter as the operator pans. |
| **Presenter / mirrored** (Phase 4) | Always on | No | Audience sees exactly what the presenter is looking at; split would confuse a flat-screen audience. |

### Fullscreen, decorationless, and kiosk modes

The application title bar and window border leak into any signal
that captures a monitor as input — a common installation pattern
where the operator's machine drives an SOS sphere, projector, or
LED wall over an HDMI capture card. v1 ships four mechanisms so
every window can present a clean fullscreen surface:

1. **Output windows: always fullscreen + decorationless.**
   Spawned with `WebviewWindow.new('output-N', { decorations:
   false, fullscreen: true, ... })` (see §3 boot flow step 3).
   No non-fullscreen output mode exists. The cursor is hidden
   after a brief idle (already in §5 MVP). This is the primary
   capture-source surface; nothing further needs to change to
   feed an external display system.

2. **Control window: optional fullscreen toggle.**
   `Tools → Display → Fullscreen` in `toolsMenuUI.ts`, plus an
   F11 keyboard shortcut on the control window itself. Calls
   `getCurrentWindow().setFullscreen(next)` and
   `getCurrentWindow().setDecorations(!next)` together so the
   title bar disappears with the chrome. Persists to
   `localStorage['sos-control-fullscreen']` so the state
   survives relaunch — a one-time toggle for an operator who
   uses the control display itself as a capture source.

3. **Kiosk-launch flag.** `--kiosk` CLI argument parsed in
   `src-tauri/src/main.rs` and an equivalent
   `TERRAVIZ_KIOSK=1` environment variable. Either path causes
   `tauri::Builder::default().setup()` to apply
   `set_fullscreen(true)` + `set_decorations(false)` on the
   main window before the first paint. Useful for unattended
   installations: drop a `.desktop` autostart entry, the app
   launches straight into the final state on boot. Exit via
   Cmd/Ctrl+Q (already wired) or by SIGTERM from the
   installation's process supervisor.

4. **F11 on every window.** Both control and output windows
   wire a global keydown handler that intercepts F11 and
   toggles `getCurrentWindow().setFullscreen(...)`. Output
   windows already start fullscreen, so F11 there is the
   "show me the title bar so I can drag the window" escape
   hatch operators sometimes need during calibration. Web
   build (no Tauri) falls back to the standard Fullscreen API
   (`document.documentElement.requestFullscreen()`), which
   covers the same use case for browser-based deployments
   where the user is using browser-source capture (OBS,
   vMix) rather than a hardware HDMI capture.

**Cursor handling in fullscreen:** the control window adds a
3-second idle-then-hide rule when it goes fullscreen (CSS
`cursor: none` after `setTimeout`, restored on `mousemove`).
Output windows already hide the cursor entirely per §5. This
matters for capture: a stationary cursor in the corner of the
captured signal is exactly the kind of artifact operators are
trying to avoid.

**Why not just rely on OS-level fullscreen (`F11` on the
browser, "Use as Display" on macOS, etc.)?** Two reasons.
First, the Tauri webview on Linux doesn't always honor the
browser-style `requestFullscreen` cleanly — explicit
`setFullscreen(true)` from Rust is more reliable across
distros. Second, kiosk-launch from a `.desktop` autostart
entry can't drive a runtime keystroke; it needs a flag the
binary reads at startup. The four mechanisms above cover the
union of operator workflows we've seen.

### Asset resolution rules (control window picks the URL)

The control window's `datasetLoader` already understands
variant ladders for both image (`_4096`, `_2048`, `_1024`
suffixes or manifest envelopes) and video (HLS manifest from
`/api/v1/datasets/{id}/manifest` or the Vimeo proxy). The
output's URL is chosen by the *output window* given its
target monitor's resolution:

| Output framebuffer | Image variant | Video variant |
|---|---|---|
| ≥ 8192 wide | manifest top, fallback 4096 | 4K HLS level |
| 4096–8191 | 4096 | 4K HLS level |
| 2048–4095 | 2048 | 1080p HLS level |
| < 2048 wide | 1024 | 720p HLS level |

The output framebuffer is independent of the operator's
monitor — a 1080p preview monitor can host an output rendered
at 4096×2048 and downsampled to display, useful for "preview
what an SOS sphere will see" workflows.

### Persistence

`localStorage['sos-multi-output-config']` (control window only):

```ts
interface PersistedOutputConfig {
  outputs: Array<{
    label: string             // 'output-1' | 'output-2' | …
    monitorName: string       // OS-reported name; matched on next boot
    mode: 'sos-equirect'      // future: 'fisheye' | 'mirrored' | …
    framebufferSize: { width: number; height: number } // e.g. 4096×2048
    trackOperatorCamera: boolean // default true; see §3.5
    split: boolean              // default false; see §3.5
    debugOverlay: boolean
  }>
  autoRestoreOnLaunch: boolean // default false; opt-in
}
```

On launch, if `autoRestoreOnLaunch === true`, the manager waits
for the OS to report monitors (~50 ms after boot), tries to
match each persisted output to a current monitor by name, and
recreates the windows. If the monitor is gone (laptop unplugged
from a kiosk dock), the entry is logged and the window is
skipped — not silently moved to a different monitor.

---

## MVP scope (v1, this branch)

What must work:

- **Tools → Outputs panel** with a monitor picker and an "Add
  output" button. One mode available: SOS Equirectangular.
- **Borderless fullscreen output windows** on user-chosen
  monitors. Multiple simultaneous outputs supported (each on a
  distinct monitor; cap at 4).
- **Equirectangular composite render.** Output runs a parallel
  Three.js scene with `photorealEarth` + the active dataset
  overlay + the multi-layer stack, renders to a 2:1
  framebuffer at the configured resolution.
- **Multi-layer stack support.** When the operator stacks
  multiple datasets in the control window's primary panel,
  the output mirrors the same z-ordered shell stack. (v1
  reuses the control window's existing layer state — adding
  per-layer opacity controls is out of scope; we surface what
  the operator already configured.)
- **Sync.** Output swaps when control window changes dataset.
  Output's video transport stays within ~200 ms of the control
  window's via periodic broadcast. Play/pause/seek are
  honored.
- **Per-output config in the Tools panel:** rename, change
  framebuffer resolution (1024² / 2048² / 4096² / 8192²),
  toggle "Track operator camera" (default on; off pins the
  output to a uniform 1:1 equirect — see §3.5), toggle "Split
  sphere" (default off; mirrors the area of focus to the
  antipodal LED-sphere hemisphere — see §3.5), toggle debug
  overlay (shows current dataset id, sync delta, fps in the
  corner — useful for installation calibration), close.
- **Optional persistence.** A "Restore outputs on launch"
  checkbox. Off by default.
- **Clean teardown.** Closing an output disposes the Three.js
  scene, the HLS instance, and the framebuffer; manager
  removes the record.
- **Audio is muted on every output window.** The control
  window is the single audio source.
- **Cursor hidden** on the output webview after a brief idle.
- **Fullscreen + kiosk surfaces.** Output windows always
  launch fullscreen + decorationless. The control window
  gains a Tools → Fullscreen toggle (persisted to
  localStorage), an F11 shortcut on every window, and a
  `--kiosk` CLI flag (also `TERRAVIZ_KIOSK=1`) that boots the
  control window fullscreen + decorationless before the
  first paint. Cursor auto-hides after 3 s of idle in
  fullscreen. See §3.6.

Explicitly out of scope for v1 (→ Phase 2+):

- **Country borders / political lines on the output.** Vector-
  layer rendering on the sphere is its own design problem
  (line geometry on a sphere shell, fed from MapLibre's vector
  tile sources or a static GeoJSON). Phase 2 polish.
- **Place labels** on the output (Phase 2; harder than borders
  because text-along-curve sprite atlasing is real work).
- **Pass-through fast-path** for trivially-global single-asset
  cases. Always render through the Three.js scene in v1; one
  code path is easier to test. Add only if profiling
  identifies it as worth the second code path (Phase 5).
- Fisheye / dome projection (Phase 2; reuses the same scene,
  changes only the projection shader).
- Multi-projector edge-blended array (Phase 3).
- Mirrored / cloned mode that captures the control window's
  rendered globe (Phase 4).
- Web fallback via `window.open()` / `BroadcastChannel`
  (Phase 5).
- Color-management / ICC profile awareness (Phase 5).
- Shared-GPU texture for sub-frame video sync (Phase 5).
- Output-window analytics. v1 emits no telemetry from the
  output window. Existing control-window events
  (`layer_loaded`, `playback_action`) are sufficient. See
  Open Questions §3.
- Per-output panel routing in multi-globe layouts. The MVP
  wires every output to whichever panel is currently primary.
  Promote-to-primary in the control window swaps what the
  output shows. Per-output fixed-slot binding is Phase 3.

---

## Delivery plan

A multi-window feature is hard to debug from a single repo
checkout — the operator may not realize an output is
misbehaving until they're standing in front of the LED sphere.
So MVP lands as a sequence of small commits, each independently
type-checked and tested, with the user-reachable wiring last.
That keeps `git bisect` useful and lets specific pieces revert
without rolling the whole feature back.

| # | Commit | What lands | User-reachable? |
|---|---|---|---|
| 1 | `multi-output: scaffold plan + protocol types` | This doc, `multiOutput/protocol.ts` | No |
| 2 | `multi-output: equirect RTT shader (unit tests + visual fixture)` | `output/equirectRtt.ts` and a tiny test page that loads a known sphere texture and verifies the shader produces the expected equirectangular pixels. Lands as a standalone module; not yet wired up. | No |
| 3 | `multi-output: output window entry + Three.js scene scaffold` | `output/main.ts`, `output/datasetMirror.ts`, `output/output.html`, `output/output.css`, Vite multi-entry config. Output bundle builds; loadable as a static page; renders a default photoreal Earth with no dataset, no IPC. | No |
| 4 | `multi-output: layer stack + dataset overlay` | `output/layerStack.ts`. Static fixture page can now load a fake dataset + fake layer stack and render it. Still no IPC. | No |
| 5 | `multi-output: narrow Tauri capability for output-* windows` | `capabilities/output.json` granting only http + window controls. | No |
| 6 | `multi-output: state aggregator + protocol implementation` | `multiOutput/manager.ts`, `multiOutput/stateAggregator.ts`. Manager constructible but not yet instantiated. | No |
| 7 | `multi-output: emit dataset:loaded + layer events from main.ts` | Refactor of `datasetLoader` and `main.ts` to fire events the aggregator can subscribe to. Today's `panelStates` consumers keep working. | No |
| 8 | `multi-output: wire MultiOutputManager into main.ts boot` | Manager instantiated; subscribes to events. No UI to spawn windows yet, so still invisible. | No |
| 9 | `multi-output: add Tools → Outputs panel` | `outputUI.ts`, Tools menu entry. **First user-reachable commit.** Operator can add and remove SOS equirectangular outputs. | **Yes** |
| 10 | `multi-output: persist + restore outputs across launches` | localStorage config, opt-in restore on boot, monitor-name matching. | Yes (additive) |
| 11 | `multi-output: per-output debug overlay + framebuffer resolution picker` | Resolution picker in panel, debug HUD with dataset id, sync delta, and fps. | Yes (additive) |
| 12 | `multi-output: fullscreen toggle + kiosk launch + F11 on every window` | `Tools → Fullscreen` toggle in `toolsMenuUI.ts` (persisted), F11 keydown handler on control + output windows, `--kiosk` argv parse and `TERRAVIZ_KIOSK=1` env var read in `src-tauri/src/main.rs` applying fullscreen + decorationless before first paint, `core:window:allow-set-decorations` added to `capabilities/default.json`, 3-second idle cursor-hide on the control window when fullscreen. See §3.6. | Yes (additive) |
| 13 | `multi-output: failure recovery — crashes, stalls, GPU loss, monitor unplug` | Manager gains crash detection (no-graceful-close window destroy → toast + record removal), 3-strikes-per-monitor crash storm guard, 2 s `availableMonitors()` poll for unplug detection, `getAll()` boot scan to reattach orphaned `output-*` windows after a control-window crash. Output gains `webglcontextlost` / `webglcontextrestored` listeners with full scene rebuild, IPC-silence watchdog (5 s → stale state, 60 s → orphan), HLS fatal-error retry (3× backoff with frozen last-good-frame). Outputs panel renders per-output health badges (healthy / stale / stalled / monitor-missing). `errorCapture.ts` gains an `output_failure` Tier A event. See §3 "Failure recovery". | Yes (additive) |

**Backout plan.** Reverting commit 9 leaves all the plumbing in
place (manager, output bundle, capability) but removes the
operator's ability to spawn windows. Control window behaviour
is unchanged from pre-feature. Reverting commits 6-8 removes
the manager itself — everything else still type-checks because
nothing on the hot path imports from `multiOutput/`. Reverting
commits 2-4 removes the output bundle — the unused build
artifacts disappear; nothing else changes. Reverting commit 12
removes the control-window fullscreen toggle, F11 handler, and
kiosk flag; output windows remain fullscreen + decorationless
because that's wired in commit 3 — the LED-sphere capture path
is not affected. Reverting commit 13 takes the install back to
"happy-path only": failures fall through to default browser /
Tauri behavior (output goes black on HLS fatal, a crashed
output leaves a stale record, GPU context loss freezes the
canvas). Acceptable to ship without if a hard deadline forces
it; not acceptable for an unattended installation. The basic
state-mirroring path (commits 1–12) keeps working.

**Acceptance for each commit:**

- `npm run type-check` passes.
- `npm run test` passes. New unit tests for `equirectRtt`
  (visual fixture comparing output pixels to a known-good
  reference at low resolution), `stateAggregator` (event
  → diff), `layerStack` (state → scene-graph mutation), and
  `datasetMirror` sync-correction state machine (each region
  transition, each hysteresis bound, pause/unpause, and the
  hard-seek discontinuity case — see §3 "Playback sync
  algorithm").
- `npm run build` produces both `dist/index.html` and
  `dist/output.html`.
- For commit 9, manual smoke on a dual-monitor Linux box:
  add an output, load a CONUS-bbox dataset to verify the
  bbox UV mapping is correct, load a video dataset to verify
  HLS sync.
- For commit 10, additionally verify persistence by quitting
  and relaunching with restore enabled.

---

## Roadmap after MVP

### Phase 2 — fisheye / dome projection + vector overlays + dome camera-tracking polish

The Three.js scene built for v1 already contains a fully
composited sphere. Producing fisheye output is a one-shader
change — swap `equirectRtt.ts` for `fisheyeRtt.ts` with a
different `(u,v) → direction` mapping. ~50 LOC, no architecture
change.

The off-center camera plumbing (§3.5) already exists from v1
— the LED sphere uses it as its primary mode — so the dome
gets it for free. Phase 2's add is a **smoothing filter** on
the dome's `cameraOffset` so it doesn't jitter as the operator
pans (the LED sphere's physical inertia hides this; a flat
dome doesn't). Likely a 200 ms critically-damped spring on
the lat/lon target, with a configurable cap on angular
velocity. ~30 LOC.

In the same phase, country borders + gridlines on the sphere.
Committed approach: pull the existing MapLibre vector borders
source, build a Three.js `LineSegments` mesh from the resulting
GeoJSON-equivalent line geometry, drape it on a sphere shell at
radius 1.0005, render alongside the photoreal Earth. ~300 LOC.

Rejected alternative: pre-rendering borders to an equirectangular
raster overlay PNG. Cheaper at runtime but doesn't support
zoom-aware label thinning, dynamic styling, or per-dataset
highlight overlays — all of which become natural extensions
once line geometry is in place.

Place labels (text-along-curve) is harder; ship-conditional on
demand.

Estimated effort: ~700 LOC across fisheye shader + vector
overlay layer + per-output mode picker UI + dome smoothing
filter.

### Phase 3 — multi-projector array (edge-blended walls / domes)

Drives N output windows, each rendering a distinct sub-region
of a larger virtual canvas, with optional edge blending in
overlap zones. Used by:

- Multi-projector planetarium domes (each projector covers
  ~60° of the sky)
- Video walls (rectangular grid of monitors)
- Curved LED installations beyond the SOS sphere format

Architecture additions:

- **Per-output sub-region** — extend the output config with
  `{ srcRect, dstRect, blendMask }`.
- **Per-output fixed-slot binding** — opt out of "follow
  primary" and pin to a specific multi-globe slot. (The MVP
  manager already knows the slot index; this just exposes it
  in the UI.)
- **Blend mask authoring tool** — small calibration page
  where the operator drags blend curves on each output until
  the seam disappears. Saved per-monitor.
- **Per-output color correction** — 1D LUT per output for
  projector gamma matching.

This is genuinely ambitious and overlaps with what purpose-
built planetarium drivers do. **Gated on real-world demand**,
not a speculative build.

### Phase 4 — mirrored / cloned mode

Captures the control window's currently-rendered globe
(whatever the operator is looking at — pan, zoom, multi-globe,
tour state) and shows it on a secondary monitor. Useful for
lectures.

Two implementations, picked by the operator:

- **`captureStream` mode.** `canvas.captureStream()` from
  MapLibre's WebGL canvas; output renders the resulting
  `MediaStreamTrack` via a `<video>` element. Pixel-perfect
  match to the operator's view including all DOM-overlay
  chrome (info panel, browse panel, etc.) — which is great
  for "pure mirror" lectures and bad for "show the data
  cleanly to the audience."
- **Parallel-render mode.** Reuses the v1 Three.js scene
  with `view.cameraOffset` already following the operator's
  MapLibre pan/zoom (same mechanism the LED sphere uses in
  v1 — see §3.5). The audience sees the same Earth region
  and zoom level the operator sees, but cleanly rendered
  without UI chrome. Phase 4's add over v1 is just the
  flat-screen projection (replace the sphere unwrap with a
  perspective camera) plus a config-time setting that pins
  `split = false` regardless of operator preference.

`output.html` switches on the `mode` field; both modes coexist
and reuse the v1 plumbing.

### Phase 5 — polish + web fallback

- **Web `window.open()` fallback.** Replace `WebviewWindow.new`
  with `window.open()` and Tauri events with `BroadcastChannel`
  for the web build. Output rendering code is unchanged.
- **Per-output audio.** Allow exactly one output to be the
  audio source instead of forcing the control window. Useful
  for kiosks where the LED sphere has speakers.
- **Color management.** ICC profile per output, simple 1D
  LUTs.
- **Shared-GPU texture for sub-frame sync.** Custom Tauri
  plugin if field experience demands it.
- **Pass-through fast-path** for trivially-global cases.
  Worth implementing if profiling shows the Three.js render
  is the bottleneck.
- **Telemetry.** Decide what (if anything) the output window
  emits.
- **Output-side dataset overlay.** Optional title card / data
  attribution shown briefly on dataset change, like SOS does
  natively.

---

## Tradeoffs and rejected alternatives

### Why not just use OS-level monitor mirroring?

OSes already mirror displays. For the dual-monitor lecture
case (Phase 4), the operator could just set "duplicate
displays" in the OS and skip Terraviz entirely. We're not
solving that case in v1.

For SOS, OS mirroring fails for two reasons:

- It mirrors the **rendered control UI**, not the globe state.
  The LED sphere driver gets the chrome, info panel, browse
  panel, Orbit chat, etc.
- It can't produce a 2:1 equirectangular projection of the
  globe. The signal is whatever projection MapLibre is
  rendering.

Output windows produce a clean equirectangular composite of
the globe state alone. That is the entire reason for the
feature.

### Why a parallel renderer instead of capturing the control window?

Two reasons:

- **The far hemisphere is unrecoverable from a capture.** The
  operator's MapLibre camera shows one face of the globe at a
  time. An LED sphere needs the whole surface. A capture-and-
  inverse-warp pipeline would only ever fill half the output;
  the other half would be undefined or interpolated garbage.
- **MapLibre's globe projection is Mercator-derived.** Even if
  we had the full sphere visible, inverting "what would
  equirectangular look like at every (lon, lat)?" from a
  Mercator-deformed render is sampling-noisy and pole-broken.

A parallel scene that renders the **same data** in the
**right projection** is straightforward by comparison.

### Why one HLS decoder per output instead of one shared?

The browser's `<video>` element is the cheapest, most battle-
tested way to drive an HLS stream. Two `<video>` elements in
two webviews each holding their own decoder is *fine*. The
cost is bandwidth duplication (mitigated by HTTP cache on
manifest + segment URLs) and double GPU decode pressure
(mitigated by the workstation-class GPU target).

We considered exposing the primary decoder's frames via
`MediaStreamTrack` from `captureStream()` and sending that to
the output window. That would halve decode cost. But it
introduces a frame-rate negotiation problem (which window's
rAF wins?), a pixel-format question (what color space?), and
a stream-lifecycle problem (what happens if the source video
re-loads mid-stream?). For v1 — where SOS sync at 200 ms is
fine — independent decoders are simpler and reliable.

Phase 5 may revisit this with a custom Tauri plugin that
exposes a true shared GPU texture handle, eliminating the
second decode entirely.

### Why a separate output bundle vs. reusing the main bundle?

Three reasons:

- **Bundle size.** The main bundle is ~600 KB gzipped
  (MapLibre alone is most of that). The output window does
  not need MapLibre, the UI shell, Orbit, deep-link, or
  analytics. Shipping the same bundle twice doubles the
  webview memory footprint per output.
- **Lifecycle simplicity.** The main bundle has a lot of
  globally-stateful initialization (analytics, deep-link,
  tile preloader). Re-running all of that in the output
  window is pointless and surfaces test-only init paths.
- **Capability narrowing.** A separate bundle with no `invoke`
  calls except the ones it actually uses lets us declare a
  much narrower Tauri capability for `output-*` windows.

The cost is having two TS entry points and a small amount of
code shared between them (`multiOutput/protocol.ts` is the
only shared module). Acceptable.

### Why direct equirect RTT instead of cubemap-and-convert?

Both produce equivalent output for our use case. Direct RTT
wins on:

- **Pole quality.** Cubemap pole pixels are stretched across
  thousands of equirect pixels at the top and bottom rows;
  direct RTT samples the sphere at the actual pole each time.
- **GPU work.** One render pass to one framebuffer vs. six
  passes to six render targets followed by a conversion pass.
- **Code volume.** ~80 LOC of shader vs. ~200 LOC for cubemap
  setup + per-face camera matrices + conversion shader.

The only argument for cubemap is "we already have a cubemap
renderer somewhere" — which we don't. Direct RTT.

---

## Non-goals

- **Live screen capture for streaming** (Twitch / OBS / Zoom).
  Different problem space; users already have OBS for that.
- **Remote-display / screen-sharing protocols** (RDP, VNC).
  We're driving local monitors connected to the workstation.
- **Multi-machine distributed rendering.** A planetarium with
  one workstation per projector, networked via NTP. Different
  architecture. Phase 3 multi-projector array assumes all
  outputs on one workstation.
- **Hot-plug detection.** If the operator unplugs a monitor
  while an output is showing on it, Tauri / OS will close the
  window. We catch the close event and update the panel; we
  don't try to "follow" the output to another monitor. Don't
  do clever auto-reroute.
- **Live editing of the asset on its way to the output**
  (e.g. "show only the equator band" or "rotate by 30°").
  Future work.
- **Country borders, gridlines, or labels in v1.** They live
  in MapLibre's vector layer pipeline and need a parallel
  implementation in Three.js. Phase 2.
- **Smoothing on the broadcast cameraOffset.** v1 debounces
  the operator's MapLibre camera at ~30 ms but doesn't
  critically-damp the trajectory — visible mainly on flat
  dome / projector outputs (Phase 2 polish, see §7). The LED
  sphere's physical surface and visitor viewing distance
  conceal it.

---

## Open questions

1. **Tauri window stacking on Linux.** Some compositors
   (sway, certain GNOME setups) treat fullscreen popups
   differently than Windows / macOS. Need to test on at
   least one Wayland and one X11 setup before declaring v1
   done. The monitor-unplug failure case (§3 "Failure
   recovery", case 4) also varies by compositor — pin down
   the actual behavior on the target install platforms as
   part of the same test pass.
2. **What to do when the operator opens an output but no
   dataset is loaded?** Default: render the photoreal Earth
   with day/night and atmosphere — a "live Earth" idle state.
   The same scene is already running; just don't add a
   dataset overlay. Free.
3. **Telemetry.** Does the output window emit `output_opened`,
   `output_closed`, `output_sync_drift_p95`, `output_fps_p50`
   events for installation health monitoring? Tier A or
   Tier B? Needs a separate analytics pass — see
   `docs/ANALYTICS_CONTRIBUTING.md`'s reviewer checklist.
   **Default until decided: emit nothing from the output
   window. Emit `output_added` / `output_removed` from the
   control window only, Tier A.**
4. **Input on the output window.** Today, mouse/keyboard go
   to whichever window has focus. Should clicks on the
   output window pass through to the control window, eat the
   event silently, or do something else? v1 default: eat all
   input silently.
5. **Screen-saver / display-sleep prevention.** SOS
   installations expect to run for hours; OS screen savers
   should not kick in. Tauri has no cross-platform "wake
   lock" API today; we'd either need a per-OS Rust shim or
   document that the operator should disable screen savers
   in their OS settings. Defer to Phase 5.
6. **Tour integration depth.** Tours fire `setEnvView` to
   change the control window's layout. Should tours be able
   to fire `setOutput` to add or remove output windows?
   Powerful for museum kiosks but a larger surface area. v1
   says no — tours don't touch outputs.
7. **CONUS-bbox UV transform exactness.** The MapLibre globe
   places non-global rasters using a known UV transform that
   accounts for the dataset's projection (typically EPSG:4326
   or EPSG:3857). The Three.js output must match exactly or
   the output sphere shows the data shifted relative to what
   the operator sees on screen. Acceptance criterion:
   side-by-side a CONUS-bbox dataset on the control globe
   and on the output, verify alignment to ≤1 px at 4K. The
   test fixture for commit 2 should include a CONUS-bbox
   reference rendering.
8. **Multi-layer z-fighting.** Stacked sphere shells at radii
   1.000 / 1.001 / 1.002 may z-fight on some GPUs at 4K+
   render targets. Mitigation: render order + `depthWrite:
   false` on overlays. Verify on at least one Intel iGPU and
   one AMD discrete GPU.

---

## Risks

- **Driver-specific quirks.** SOS LED spheres ship with
  proprietary drivers that may expect a specific signal
  format. We're producing standard HDMI / DisplayPort
  borderless fullscreen at the chosen resolution. Should be
  compatible with anything that takes a 2:1 input, but the
  first real installation will surface edge cases we can't
  predict from the lab.
- **Tauri webview process limits.** Tauri spins up a webview
  process per window. On Windows with WebView2, each window
  is its own process; macOS with WKWebView may share. Memory
  scales linearly. Realistic ceiling: 4-6 outputs per
  workstation. We cap at 4 in v1.
- **GPU memory pressure.** Each output holds: a 4K sphere
  texture (or two for multi-layer), a 4K equirect
  framebuffer, plus Three.js scene resources. At 4 outputs
  that's ~1 GB of GPU memory. Workstation GPUs handle it;
  the cap matters.
- **HLS decode pressure.** 4 simultaneous 4K HLS decodes is a
  lot. Most discrete GPUs handle it; integrated GPUs might
  not. The Tools panel should warn if the user adds a 4th
  output, citing hardware requirements.
- **Operator confusion.** "Where did my video go?" is a real
  question if a user accidentally triggers fullscreen on the
  primary monitor. Borderless fullscreen output windows must
  always go to a *non-primary* monitor and refuse to spawn
  if only one monitor is connected. The Add Output button is
  hidden in single-monitor mode.
- **Silent installation degradation.** A long-running install
  that hits a network blip, driver hiccup, or monitor-cable
  jiggle could degrade silently if failure paths aren't
  designed in. Mitigated by §3 "Failure recovery" — bounded
  retries, last-good-frame freezing during HLS retry, IPC
  staleness surfacing, GPU context loss recovery, control-
  window crash reattachment via boot scan. Risk remaining:
  a class of failure we haven't anticipated reaches the
  audience as a black or stale screen with no operator
  notification. Mitigation: every failure path emits an
  `output_failure` Tier A telemetry event, observable in
  Grafana dashboards for installation operators.

---

## Cross-references

- `docs/VR_INVESTIGATION_PLAN.md` — voice / structure
  reference; also the canonical home of the photoreal Earth
  factory, equirectangular base Earth texture hosting
  strategy, and the Three.js lazy-load pattern. The output
  bundle reuses the same Three.js chunk and the same
  `photorealEarth.ts` factory.
- `docs/DESKTOP_APP_PLAN.md` — Tauri capabilities, plugin
  patterns, and lazy-load conventions.
- `docs/SETVIEW_IMPLEMENTATION_PLAN.md` — multi-globe layout
  state model; informs how output panels can later route to
  non-primary slots (Phase 3).
- `docs/ANALYTICS_CONTRIBUTING.md` — must-read before adding
  any output-window events (Open Questions §3).

---

## Appendix: example output config

```ts
const outputs: PersistedOutputConfig = {
  outputs: [
    {
      label: 'output-1',
      monitorName: 'DELL-SOS-DRIVER',
      mode: 'sos-equirect',
      framebufferSize: { width: 4096, height: 2048 },
      debugOverlay: false,
    },
  ],
  autoRestoreOnLaunch: true,
}
```

A multi-projector planetarium would extend the schema
post-Phase 3 with a `srcRect` / `dstRect` / `blendMask` triple
per output. The v1 schema is forward-compatible: new modes
add new fields; the parser ignores unknown fields.
