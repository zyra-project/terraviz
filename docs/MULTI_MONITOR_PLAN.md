# Multi-Monitor Output Plan — installation-grade displays

Feasibility plan for driving one or more secondary display
surfaces from Terraviz: a control window on the operator's
primary monitor and one or more borderless fullscreen output
windows on adjacent monitors, each rendering an equirectangular
projection of the live globe state suitable for an LED sphere or
similar 2:1-input device.

Status: **draft for review.** Nothing implemented; this document
exists to align scope and architecture before any code lands.

**Last reviewed:** 2026-09-03 (amended from a throwaway platform
spike — see "What has actually been executed" below. The `src/`
citations were verified against `main` @ `965d231` on 2026-08-28
and have not been re-verified since).

> **The line numbers in this doc are pinned to `965d231` and will
> drift.** They already have once: in the nine commits between #395
> and #404, `SIBLING_HARD_SEEK_THRESHOLD_S` changed file *and* value
> while every other citation moved between +3 and +40 lines. A pass
> that trusted stale line numbers drew two confidently wrong
> conclusions. Re-verify against the tip before acting on any
> citation here; the symbol names have been stable, the lines have
> not.

**Revisit when any of the following becomes true:**

- Any ladder commit lands. Once code exists, this doc's claims about
  `src/` are checkable against it rather than asserted, and the
  sections describing what "must be added" become history.
- Open Question 1 comes back negative **on Linux**. Windows is
  answered; the Linux half was always the risky one. If borderless
  fullscreen on a non-primary monitor does not work on a target
  compositor, the ladder's shape changes, not just its timeline.
- `computeSiblingSyncCorrection`, `SIBLING_MIN_READY_STATE`,
  `SIBLING_HARD_SEEK_THRESHOLD_S` or `SIBLING_SEEK_EPS_S` change
  signature or value. §3 delegates to all four rather than
  restating them, so a change upstream silently changes this plan.
- `globeThumbnail.ts` changes shape. The "Prior art" section and the
  rescoping of delivery steps 2-4 both rest on it.
- Tauri's capability model changes across a major version, or the
  permissions §6 asks for stop being the right set.
- Six months pass with no implementation started. The `src/`
  citations drift with every release whether or not anyone is
  reading them.

### What has actually been executed

Until 2026-09-03 this document had been rewritten twice without
a single one of its platform assumptions being run. A throwaway
spike (Windows 11, Intel Raptor Lake-S + RTX 4090 Laptop, three
monitors, packaged build) executed the load-bearing ones. It
shared no code with `src/services`, was wired into nothing, and
is not part of the delivery ladder.

| Assumption | Where | Verdict |
|---|---|---|
| The proposed capability grants are sufficient to spawn a window | §6 | **Confirmed** for the four the spike ran. A fifth (`allow-show`) was added afterwards, from a code reading, and is **untested** |
| The narrow output capability is sufficient for what an output self-drives | §3 "Output capability spec" | **Confirmed** |
| `core:window:default` carries no `set-*` and no `allow-close` | §6 | **Confirmed** against Tauri 2.11.2's own tables |
| Borderless fullscreen lands on a non-primary monitor | Open Question 1 | **Confirmed on Windows.** Linux and macOS untested |
| Multiple WebGL2 contexts + decoders survive | §3 "Cross-window decoder budget" | **Confirmed, and the budget was wrong** — 16 outputs at 8192×4096 ran at full rate |
| Logical / physical coordinates place the window correctly | "Monitor geometry and placement" | **Untested** — every monitor was `scaleFactor: 1` |

Four things the spike found that the plan did not predict are
folded into the sections above: signed monitor origins, GPU
selection being a driver-level decision the app cannot make,
an ACL denial presenting as "datasets don't load" (in a window
running the main app bundle — **not** in v1's outputs, which
run `datasetMirror` and invoke no commands), and video datasets
being unloadable in `dev:desktop` at all.

**Everything measured came from one 4090 laptop.** A museum is
likelier to deploy an Intel-iGPU NUC. Numbers here bound what is
*possible*, not what is *portable*.

---

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
factory as a **texture provider** — its progressive 2K → 4K →
8K base diffuse, and the loader behind it — rather than
rendering its mesh, because on this path the fragment shader
*is* the renderer. Which of its effects survive that, and why
the ones that don't are incoherent on an LED sphere rather
than merely unported, is "What the equirect path does to the
Earth decoration" below. We add:

- A dataset-texture overlay layer (`vrScene.ts` does the
  equivalent on top of `photorealEarth`'s mesh; here it is one
  more sampler in the composite).
- Multi-layer stack support for overlapping datasets (new —
  layers composite in array order inside the single fragment
  shader, so there are no stacked shells and no depth buffer
  to fight over).
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
  `(0,0,0)` — the sphere center) against the unit sphere,
  sample every layer at the hit point and composite them in
  order. One
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
and decodes independently. The control window broadcasts the
primary's **date**, duration, range, `playbackRate` and paused
flag; the output feeds those to
`computeSiblingSyncCorrection()` (`src/utils/time.ts:334-390`)
— the same pure control law multi-globe sibling sync already
uses — and applies the rate trim or seek it returns. See §3
"Playback sync algorithm" for the call, the `readyState` gate,
and the read-back verification layer that sits beside it.

An output is, to that function, just another sibling viewport;
the only thing genuinely new here is that it lives in a second
window.

A future Phase 5 polish (see Roadmap) could introduce a shared
GPU texture handle to eliminate the second decoder. We don't
need it for v1.

### 5. Tauri capabilities are scoped to the main window today

`src-tauri/capabilities/default.json` declares:

```json
"windows": ["main"],
```

Output windows are new labels — `output-1`, `output-2`, etc. —
and won't inherit `default`'s permissions. Two separate
problems follow, and v1 has to solve **both**:

1. **The manager needs new grants.** Creating, closing and
   decorating an output window are permissions the main window
   does not currently hold. Because cross-window commands are
   ACL-checked against the *caller*, these go in
   `default.json`. See §6 for the exact list and the mechanism.
2. **The outputs need their own, narrower capability.** A new
   `capabilities/output.json` scoped to `["output-*"]` grants
   the output only what it self-drives. Output windows have no
   reason to read the keychain or invoke download commands, so
   giving them no surface area limits the blast radius if a
   malicious dataset URL ever exploits the output webview.

The glob assumption holds: `tauri-utils`' capability schema
documents `windows` as *"List of windows that are affected by
this capability. Can be a glob pattern."* (`acl/capability.rs`),
so `"windows": ["output-*"]` is valid.

The exact permission set is in §3 "Output capability spec".

### 6. Tauri's window-creation API is JS-side

Tauri v2 exposes `WebviewWindow.new(label, options)` from
`@tauri-apps/api/webviewWindow`. We don't need to touch Rust at
all to create output windows in v1 — the control window's TS
service spawns and tears them down via this API, and IPC events
flow via `getCurrent().emit(...)` (JS side, window-to-window).

**The permissions to do that are not granted today.** Two
corrections to an earlier draft of this section, both verified
against `origin/main`:

**Window creation is a `webview` permission, not a `window`
one.** `WebviewWindow.new()` invokes
`plugin:webview|create_webview_window`, which requires
`core:webview:allow-create-webview-window`. That string appears
in no capability file in the repo.

**`core:window:default` is read-only.** It contains getters plus
`allow-current-monitor` / `allow-available-monitors` /
`allow-primary-monitor`. It does **not** contain `allow-close`,
`allow-destroy`, `allow-show`, `allow-hide`, or any `set-*`.
Likewise `core:webview:default` is only
`allow-get-all-webviews`, `allow-webview-position`,
`allow-webview-size`, `allow-internal-toggle-devtools`.

What `capabilities/default.json` grants today (lines 7-27):
`core:default`, `core:window:default`,
`core:window:allow-set-fullscreen`, `allow-set-size`,
`allow-set-position`, `allow-available-monitors`,
`allow-current-monitor`, `updater:default`, and a scoped
`http:default`. Note that `core:default` already expands to
`{plugin}:default` for all nine core plugins, so the explicit
`core:window:default` / `allow-available-monitors` /
`allow-current-monitor` lines are redundant — worth removing
while editing the file.

So v1 must **add** five permissions to
`capabilities/default.json`:

| Permission | Needed for |
|---|---|
| `core:webview:allow-create-webview-window` | `WebviewWindow.new()` — spawn an output |
| `core:window:allow-close` | Graceful teardown of an output |
| `core:window:allow-destroy` | Forced teardown after a crash or GPU-loss timeout |
| `core:window:allow-set-decorations` | Drop the title bar (§3.6 fullscreen toggle) |
| `core:window:allow-show` | Reveal an output after it has been placed. Outputs are spawned `visible: false` and positioned through the physical setters before being shown, because `WindowOptions` has no physical placement option — see "Monitor geometry and placement" |

`allow-set-fullscreen`, `allow-set-size`, `allow-set-position`,
`allow-available-monitors`, and `allow-current-monitor` are
already present and sufficient. They are also currently **dead
grants** — nothing in `src/` calls any window or monitor API
today (see §"Modified modules").

**These grants belong to the *caller*, not the target.** Tauri's
window commands are `fn $cmd(window: Window<R>, label:
Option<String>)` → `get_window(window, label)`
(`tauri/src/window/plugin.rs:13-37`). The `label` argument
retargets the acted-on window with **no ACL check against the
target's capability**; the check runs entirely against the
capability set of the window making the call. A narrow
`output.json` therefore does nothing to restrain the manager,
and — more importantly — putting `close` / `set-fullscreen` /
`set-decorations` *only* in `output.json` would cause every
manager-initiated operation on `output-N` to be **denied**.

The split that actually works:

- **`default.json` (the manager)** — gains the permissions
  in the table above. This is what makes cross-window control
  possible at all.
- **`output.json` (the outputs)** — stays narrow, and is about
  limiting what a *compromised output* can reach, not about
  restraining the manager. It grants the output only what it
  self-drives: F11 fullscreen on itself, its own graceful
  close, IPC, and HTTPS fetch. See §3 "Output capability spec".

**All of the above is now verified, not just reasoned.** A
throwaway spike ran it on Windows 11: `WebviewWindow.new()`
succeeded with the four grants the spike carried and no ACL
error, and the narrow
output capability was sufficient for everything an output
self-drives — every window getter returned a real value and
`emitTo('main')` reached the control page. All 28 `core:`
identifiers across both files exist in Tauri 2.11.2's own
permission tables, which removes a whole class of false
negative: a spawn failure on someone's machine is not a
misspelled permission name.

The fifth grant, `core:window:allow-show`, is **not** covered by
that result — it was added after the spike, from a reading of
Tauri's `WindowOptions` type, and nothing has executed it. It is
the one line of §6 still in the state the rest of the section
was in before the spike ran.

That check also settled the `core:window:default` reading
against the shipped tables rather than against a code reading.
Of the twelve `core:window:*` permissions the output file
enumerates, exactly **one** — `allow-close` — reaches beyond
the `default` bundle; the other eleven are getters already
inside it. Keep the enumeration anyway rather than collapsing
it to the bundle: the point of that file is reviewability, so a
future Tauri release quietly widening `default` cannot widen
this file along with it.

**Capabilities are compiled into the binary.** `tauri-build`
does emit `cargo:rerun-if-changed=capabilities`
(`tauri-build-2.6.2/src/acl.rs:427`), but that only fires when
cargo actually runs — so a `dev:desktop` session started
*before* a capability edit keeps enforcing the old ACL, and the
edit looks like it did nothing. **Restart `dev:desktop` after
touching any capability file.** This cost real debugging time
in the spike, twice.

**A missing grant does not announce itself. It looks like a
data bug.** `datasetLoader` awaits `getDownload(dataset.id)` as
the *first* step of both the image and the video load path
(`src/services/datasetLoader.ts:126`, `:272`). That helper
guards on `IS_TAURI` but does not catch a rejected invoke
(`downloadService.ts:719-722`). In any Tauri window whose
capability is not in effect, `IS_TAURI` is still true, the
invoke is ACL-denied, the promise rejects, and `loadDataset`
throws before doing anything else — so the symptom is "datasets
don't load", with no mention of permissions anywhere in it.

**v1's own outputs do not hit this**, and an earlier draft of
this section wrongly implied they do. Outputs run
`src/output/datasetMirror.ts`, not `datasetLoader`, and
§"Output capability spec" grants them no Tauri commands at all —
they fetch over the network by design. So the hazard is not
"this feature walks into it". It is narrower and still worth
writing down: **any window running the main app bundle walks
into it**, which is what the spike's own `spike-app-*` preflight
windows were, and what a Phase 4 mirrored mode reusing the main
bundle would be.

To be exact about the evidence: this is a code reading, not an
observed failure. The spike's own "the spawned window won't
load datasets" turned out to be a dead `VITE_DEV_API_TARGET`
proxy, and a preflight window proved its capability was live.

The fix landed separately, on `main`, because the bug is not
multi-window-specific and is reachable today: the read commands
resolve to their no-downloads value and log the denial once
rather than rejecting. Three surfaces were affected, not one —
`datasetLoader`'s two load paths, `downloadUI`'s `renderPanel`
(which left the panel blank), and `browseUI`'s badge loop. The
mutating commands still reject, deliberately.

That fix catches every rejection, not only ACL-shaped ones,
which does mean a genuine index or I/O failure now degrades and
logs rather than throwing. The trade is deliberate: the caller
is asking "is there a local copy?", "I cannot tell" is
operationally the same answer as "no", and the alternative is
matching on Tauri's denial string, which is not a stable
contract.

### 7. Vite multi-entry build

The output window loads a separate HTML page (`output.html`)
so its JS bundle is decoupled from the heavy main app — no
MapLibre, no UI shell, no Orbit, no analytics emitter (until
we decide what to do about telemetry, see Open Questions).

**The build is already multi-entry** — `vite.config.ts:49-54`
declares two inputs today:

```js
rollupOptions: { input: {
  main:  path.resolve(__dirname, 'src/index.html'),
  orbit: path.resolve(__dirname, 'src/orbit.html'),
} }
```

So this is an **addition to the existing object**, not a new
`rollupOptions.input` block. Writing one from scratch would
silently drop the `orbit` entry and break the Orbit character
page.

Two consequences of the existing config:

- **`root: './src'`** (`vite.config.ts:41`) means every entry
  HTML must live under `src/`. The output page is therefore
  `src/output/output.html`, not `output/output.html` at repo
  root — and its module tag is a root-relative
  `<script type="module" src="./main.ts">`, matching how
  `src/index.html:291` references `src/main.ts`.
- Because the bundle now lives under `src/`, it falls inside
  **`check:doc-coverage`** scope — every module needs a
  CLAUDE.md row in the same commit that adds it. See
  "Acceptance for each commit".

`src/orbit.html` is the working precedent to copy. Note it
carries the SPDX header (lines 2-3), a
`<link rel="manifest" … crossorigin="use-credentials">`
(line 14), and `<meta name="robots" content="noindex">`
(line 17) — an output page wants all three.

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
│  └─ datasetLoader.{loadImage,loadVideo}│    │  │ photorealEarth base texture│  │
│                                        │    │  │  + dataset texture overlay │  │
│ + new MultiOutputManager service       │    │  │  + layer composite, max 4  │  │
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

### Prior art: `globeThumbnail.ts`

Read `src/services/globeThumbnail.ts` before writing any of the
output-side rendering. It already ships this plan's core move,
in production, for the publisher portal's `thumbnail_ref`
generator — and it was written after this plan was first
drafted, so none of the design below was able to account for it.

What it does, and what the output window needs, are the same
sequence:

| `globeThumbnail.ts` | Output window |
|---|---|
| Lazy-imports Three.js behind a `loadThree` seam (`:198-200`), mirroring the VR / Orbit pattern so the portal bundle is unchanged until used | Same lazy import, same reason — see §7 |
| Builds `createPhotorealEarth` **in dataset mode**: data lit uniformly, no day/night terminator | Same, for a loaded dataset |
| Wraps a 2:1 equirectangular frame onto a sphere from an `HTMLImageElement`, `HTMLCanvasElement` or `ImageBitmap` | Same, from a `VideoTexture` or decoded image |
| Honours `lonOrigin`, `isFlippedInY`, `boundingBox` (regional data clipped over a base Earth) and non-Earth bodies via `isEarthBody` (`:323`) | Exactly the overlay contract above |
| Renders to an offscreen target and reads the result out | Renders to the 2:1 framebuffer the equirect pass consumes |

The one thing it does *not* share is the projection: it frames
the sphere with an orthographic camera to get a round globe,
where an output ray-marches every (lon, lat) of a 2:1
framebuffer. That difference is genuinely this plan's work. The
scene assembly in front of it is not.

Concretely, this is most of delivery steps 2-4 already written
and already tested. Treat those steps as "extract and reuse the
`globeThumbnail` scene-building path behind a shared helper,
then add the equirect pass" rather than as a from-scratch build,
and prefer widening the existing seams (`loadThree`,
`createPhotorealEarth`) over introducing parallel ones. The
risk this retires is the boring, expensive kind: UV orientation,
flip handling, bbox clipping and body-specific shading are all
places where an independent re-derivation would look right and
be subtly wrong on a subset of the catalog.

### What the equirect path does to the Earth decoration

> **Asked for, at the first hardware session (2026-09):** "at some
> point I would want the Earth as realistic as possible." The outputs
> were showing base diffuse and nothing else.
>
> This section is the answer to *how* realistic is coherent: the table
> below sorts every effect by what it depends on, and the split is not
> a matter of effort. Three more cross the boundary; four cannot cross
> at all, because they are properties of *looking at* a sphere from
> outside and nobody looks at an LED sphere from outside.
>
> **Rung 12c has since built all three that cross.** The four that do
> not are ruled out permanently rather than deferred — the table says
> why, and it is a statement about the surface, not about the backlog.

Constraint 3 has a consequence the rest of this plan was written
without. If the equirect pass ray-marches an analytic sphere and
samples layer textures at the hit point, then **the fragment
shader is the renderer** — there is no rasterised mesh, no scene
camera, and no depth buffer. `photorealEarth` is therefore
consumed as a *texture provider* (its progressive 2K → 4K → 8K
base diffuse, and the loader that fetches it) rather than as a
sphere to draw.

That reads at first like a porting cost: reimplement
`photorealEarth`'s material inside the equirect shader, which is
exactly the re-derivation the Prior-art section forbids. Sorting
its effects by *what each one actually depends on* shows it is
not a porting question at all.

| Effect | Depends on | On an equirect output |
|---|---|---|
| Base diffuse | an equirect texture | **Crosses.** Already the sampled layer. |
| Night lights | an equirect texture, gated by the terminator | **Crosses.** A second sampler and a multiply. |
| Day/night terminator | `dot(surfaceNormal, sunDir)` | **Crosses, in one line.** In a ray-march the hit point on the unit sphere *is* the normal, so `vNdotL` (`photorealEarth.ts:566`) is `dot(hit, uSunDir)`. |
| Clouds | an equirect texture on a shell at 1.005 | **Crosses.** Another layer in the composite. |
| Specular ocean | the **viewer's** position — `rayDir = normalize(fragKm - camKm)` (`:870`) | **Meaningless.** |
| Atmosphere shells | the **silhouette** — the shell exists "so the shell's silhouette is the limb of the atmosphere proper" (`:148-151`) | **Meaningless as a shell; the disc tint crosses.** The mesh and its limb do not survive an unwrap. But the shell covers the whole visible *disc*, not a ring, and pinned to nadir its integral collapses to a function of sun angle alone — which is meaningful at every point of an unwrap. See §"One real gap this turned up" and `src/output/atmosphereNadir.ts`. Do not read this row as licence to remove that pass. |
| Ground shadow | a scene to cast onto | **Meaningless.** |
| Sun sprite | a billboard in world space | **Meaningless.** |

**Two traps this path sets, both sprung on the first build.**

*The sun's frame, not its source.* `photorealEarth`'s
`sunDirectionFromLatLng` builds its vector for the globe **mesh**,
and negates Z relative to `equirectRtt`'s `latLonToDirection`.
Borrowing that handle's `sunDir` therefore mirrors the sun in
longitude and lights the opposite hemisphere — the Americas went
dark while the control globe had them in daylight. Sharing
`getSunPosition` does not fix it and never could; what matters is
that the sun and the camera are derived through the *same*
lat/lon-to-direction function, which makes the frames agree by
construction rather than by coincidence.

*One module's calibration, end to end.* The cloud asset is shared
but the curve that turns it into coverage is not.
`earthTileLayer` computes alpha in-shader with a gamma of **1.8**,
which suppresses haze; `photorealEarth` bakes it onto a canvas at
**0.55**, which lifts haze, because it is feeding a lit shell seen
from outside. Splicing that texture into the other's opacity turned
a light haze into a ~30% white wash over the whole day side, greyed
the oceans, and — once the night-side alpha boost multiplied it —
clamped the night to solid black. Take the raw asset and bring the
whole curve, or take neither.

**One effect crosses, but not as a uniform: the cloud zoom fade.**
The control globe dissolves its clouds on the way in — full cover
at zoom 3, none at zoom 6 — because the cloud asset is a single
global texture and magnifying a patch of it magnifies its blur,
leaving a fuzzy grey wash over basemap detail that is genuinely
sharper underneath. Asked for at the second hardware session
(2026-09): *"clouds should only vanish in the zoomed portion. In
other words based on camera altitude."*

The qualifier is the whole design. On the control globe the
viewport is at one zoom, so the fade is one scalar. On an output
the zoom **is** the warp: the focus is magnified and the antipode
compressed *in the same frame*, and there is no single number that
is right for both. A uniform copied across would either keep the
wash over the magnified part it exists to clear, or strip clouds
off the three-quarters of the sphere that never zoomed at all.

So it is per fragment, and the quantity is already on hand. The
ray-march computes a hit distance `t` for every pixel; with the
camera at `|o| = f` that runs from `1 − f` at the focus to `1 + f`
at the antipode, and the linear magnification relative to a centred
camera is `1 / t`. Inverting `cameraOffsetForCamera`'s own mapping
(`f = 1 − 1/(z+1)`) turns that into a zoom level:

```
localZoom = 1/t − 1
```

**Exact at the focus** — the centre of the operator's area of
interest reports the operator's actual zoom — so feeding it through
`earthTileLayer`'s *unmodified* curve makes the two surfaces agree
there by construction, rather than by a second pair of hand-tuned
anchors. Two imprecisions are deliberate and worth stating rather
than discovering: the warp is anisotropic (the true linear scale is
`√(cos θ)/t`, and dropping `cos θ` costs at most ~27% of a
magnification factor mid-frame, nothing at either pole), and
`MAX_CAMERA_OFFSET = 0.85` caps the reachable local zoom at ~5.67,
so clouds bottom out at ~11% of their alpha instead of at zero.
That residual is **agreement, not a shortfall**: 11% is what the
control globe has left at zoom 5.67, which is the zoom a capped
output is in fact showing. Rescaling the curve to end at the cap
is the tempting fix, and it would put a second cloud calibration in
the repo — the trap immediately above, in a new place.

**The decoration is idle-only — found on hardware, rung 9 step 13.**
The first Windows pass reported that a regional dataset rendered
correctly placed but wrongly lit: *"once a dataset loads the globe
should revert to a diffuse unlit globe … however, on the generated 2:1
outputs the data is still shown with day night lighting."* That is
right, and the control globe already does it — `earthTileLayer` gates
its entire pass chain on `datasetActive` and returns before pass 0,
with the comment "no earth effects when dataset is active". So a
control globe showing a dataset is unlit **and ungraded**, and a
bbox-clipped dataset `discard`s to raw Blue Marble tiles outside its
box.

This path had composited the decoration *under* the layers instead, on
the reasoning recorded in §"What the equirect path does to the Earth
decoration": under-compositing was supposed to mean day/night could
never tint a dataset. **That holds only for opaque global coverage.**
A data-encoded overlay is translucent by construction — its alpha *is*
the measurement — so the terminator showed through the night-side
smoke plume the argument used as its own example, and outside the bbox
the two globes disagreed outright.

The gate is the slot count, decided at build time because the shader
text is already a function of it: no layers means the idle Earth and
its full treatment, any layer means the raw sample and nothing on top.
It costs nothing at runtime, and it is a *tighter* test than the
control side's — `main.ts` fills a slot only when the mirror holds
decoded media, whereas `datasetActive` is set when the dataset is
assigned. Measured through the real composed shader: a lit land sample
`rgb(181, 150, 103)` renders `rgb(172, 139, 96)` on an idle output and
`rgb(181, 150, 103)` — byte-identical to the raw tile — once a layer
exists.

**Verified on a real GL implementation (2026-09-11).** The decoration
GLSL is a hand transcription of tested TypeScript, which is the
weakest guard in this module — a transcription error compiles fine and
fails only on a GPU. It has now been rendered headless in Chromium
over ANGLE/SwiftShader and the numbers measured back out of the
pixels. Two harnesses, and the difference between them is worth
keeping: the first drives `outputScene.setParams` through
`output.html`, which exercises the real scene and therefore reads
through the equirect camera's pixel→lat/lon mapping; the second
compiles `buildOutputFragmentShader` against a **uniform** base
texture in a bare WebGL context, which removes that mapping from the
comparison entirely. The second exists because the first produced an
unresolvable reading on the atmosphere — a lit band that would not
line up with the subsolar longitude — and the way out was to stop
measuring two things at once rather than to keep staring at the one
number.

| Check | Method | Result |
|---|---|---|
| Terminator position | render at four frozen UTC instants, divide by the same frame with `dayNight` off to cancel albedo, least-squares fit the subsolar point | fitted longitude within **1.5°** of `getSunPosition`'s at 00/06/12/18 UTC, tracking −15°/h in the correct direction |
| Terminator frame | 06:00 and 18:00 specifically | fitted **+91°** and **−91°**; the borrowed-vector bug mirrors longitude, so it would read −90 and +90 here — and would agree at 00:00/12:00, which is why it hid at those two hours |
| Cloud zoom fade | flat cloud field, alpha recovered from a paired render with clouds off, compared against the ray length's own prediction | worst deviation **0.0020** over the frame at zoom 0 and zoom 5 — 8-bit quantisation |
| Grade + atmosphere | the composed shader compiled against a *uniform* base texture, so the pixel→lat/lon mapping drops out of the comparison, then every sampled fragment checked against `gradeEarthBase`/`decorateEarth`/`applyAtmosphere` run in TypeScript | worst deviation **0.499 of one byte**, mean 0.046, over 176 fragments spanning the whole sun sweep — rounding and nothing else. The measured ocean: raw `rgb(2, 5, 20)` → graded `rgb(0, 0, 12)` → `rgb(2, 5, 29)` at the subsolar point, the +18 blue matching `SUN_INTENSITY`'s own docstring calibration |

**A second gap, found in review: the whole Earth was too dark.** The
base texture arrives from `photorealEarth` tagged `SRGBColorSpace`,
which is right for *that* module's material — Three uploads it with an
sRGB internal format so the sampler decodes to linear for the lighting
pipeline downstream. This path has no such pipeline: one quad, a
hand-written `ShaderMaterial`, straight to the default framebuffer with
no `colorspace_fragment` chunk to re-encode on the way out. And every
constant in `layerStack` is copied from `earthTileLayer`, which grades
and composites in sRGB **display** space because it reads the MapLibre
framebuffer. Decoded-linear input under display-space constants is not
a subtlety — measured through the real composed shader:

| Base (sRGB) | Decoded-linear (as shipped) | Display space (fixed) |
|---|---|---|
| Ocean `rgb(2, 5, 20)` | `rgb(2, 5, 17)` | `rgb(2, 5, 28)` |
| Land `rgb(181, 150, 103)` | `rgb(112, 68, 30)` | `rgb(172, 139, 96)` |
| Sahara `rgb(213, 174, 131)` | `rgb(166, 96, 50)` | `rgb(205, 162, 124)` |
| Vegetation `rgb(27, 47, 19)` | **`rgb(2, 5, 17)`** | `rgb(15, 41, 21)` |

The vegetation row is the one that settles it: dark green land reached
the framebuffer **byte-identical to ocean**, so forest and sea were the
same colour on the sphere. Contrast-around-0.5 in linear space treats
anything below mid-grey as far-below-midtone and crushes it, which is
the failure `photorealEarth`'s own contrast knob carries a paragraph
about avoiding.

**It predates the colour grade.** Rung 12c's decoration inherited it
the same way — its four constants are `earthTileLayer`'s too. The fix
removes the decode rather than compensating for it (`useDisplaySpace`
in `outputScene`), so every copied constant is correct by construction
instead of correct after an offsetting transform, and the cloud
texture — built here by `new Texture(img)` and left at Three's default
`NoColorSpace` — stops being the only one that was already right.
Retagging is safe because `createPhotorealEarth` builds these per call
and an output window holds its own instance.

**One real gap this turned up: the ocean — and the first diagnosis of
it was wrong twice.** The output's day-side sea read near-black beside
a blue one, which is what "the main application window is much more
blue" was reporting. It was first attributed to scattering, then
"corrected" to a claim that the control globe's GIBS
`BlueMarble_NextGeneration` tiles "carry their own blue water" and
that scattering therefore had nothing to do with it. Measured rather
than asserted, a BMNG tile's ocean is `rgb(2, 5, 20)` and
`earth_diffuse_2048.jpg`'s is `rgb(2, 5, 20)` — **byte-identical, the
same product.** Blue Marble's blue is not in Blue Marble. The second
claim was the wrong one, and the original instinct was right.

The blue comes from two passes the output was not running, both of
which cross to an unwrap:

- **Pass 0, the colour grade.** Contrast 1.10 ("a slight S-curve to
  deepen ocean blues") and saturation 1.20 ("push the Blue Marble
  greens/blues a touch"), applied to the raw tiles before anything
  composites on them. Purely per-pixel: no geometry, no viewer, no
  silhouette, nothing for an unwrap to reinterpret. On the real ocean
  value it clips red and green to black and leaves blue standing.
- **Pass 5, atmospheric scattering.** The shell sits at
  `ATMOSPHERE_RADIUS_FACTOR` (~1.0157), so it covers the whole visible
  **disc**, not a limb ring, compositing
  `scattered + background x viewTransmittance`. Rayleigh beta scatters
  blue ~5.7x harder than red, so over a near-black ocean the
  in-scattered term *is* the water's colour.

**The table's "atmosphere shells → meaningless" row was right about
the limb and wrong about the disc tint.** Pin the view to nadir —
the one choice an unwrap can make without inventing a viewer — and
every term of `computeAtmosphereScattering` collapses onto a single
scalar: with the ray from the top of atmosphere at `-P`,
`normalize(samplePos)` is `P` at every step, so the sun-transmittance
lookup's `mu` is `dot(P, sunDir)` *constant down the column*; the
view-side optical depths depend only on altitude; and both phase
functions key on that same scalar negated. Exact rather than
approximate, because the shared ray-march is single-scatter with no
ground-albedo coupling. So it is a **256x1 RGBA LUT** — RGB the
in-scatter, alpha the transmittance — indexed by the value
`earthNightFactor` is already handed, and it is *static*: the sun's
position never enters the table, only its cosine, which the shader
derives per fragment. Built once, never rebuilt. `src/output/
atmosphereNadir.ts`.

**This sharpens the table's rule rather than breaking it.** The test
is not "does the effect depend on a viewer" but *what does it become
at nadir*: scattering becomes a smooth global function of sun angle,
meaningful everywhere; specular becomes a fixed bright spot at the
subsolar point, which is the glare artifact this section rules out,
reached by another route. Specular, ground shadow and the sun sprite
stay out on that sharper test, and now for a stated reason rather than
by category.

Two limits are stated rather than hidden. It is **single-scatter**, so
it reads dark at high sun-zenith angles — the control globe shares
that limitation, which is the point: the two agree because they share
these constants, not because either is right. And **nadir is a
choice**: the control globe shows one viewer's scattering, so the two
match near its sub-viewer point and diverge toward its limb. An unwrap
has no viewer to match. The same reasoning keeps the shared 16-step
tier even though this table is built once on the CPU and could afford
any step count — integrating more finely would render an ocean
measurably bluer than the globe it exists to agree with.

The four that do not cross are not blocked; they are
**incoherent on this surface**. An equirectangular unwrap shows
every point of the sphere at once, so it has no limb and no
silhouette — the "edge" of an LED sphere is wherever a visitor
happens to be standing, and it moves as they walk. Likewise
there is no single viewer to compute a specular highlight for.
Baking either in would paint a fixed ring or glare spot onto the
physical surface, in a place that is only correct from one
vantage point. That is worse than omitting them: it is a
rendering artifact that reads as a data feature.

So the split is not three-cross-four-lose. It is: **everything
that is a property of the sphere's surface crosses, and
everything that is a property of looking at a sphere from
outside does not, because nobody looks at an LED sphere from
outside.**

Two consequences.

**Open Question 2 is decided by it.** It had the no-dataset
default rendering "the photoreal Earth with day/night and
atmosphere — the same scene is already running; just don't add
a dataset overlay. Free." The scene is not already running as a
mesh, so it is not free — but what it costs is one dot product
and two extra samplers, and what it drops, atmosphere, should
not have been there. The idle state is diffuse + night lights +
clouds + terminator, and that is the correct picture rather
than a degraded one. OQ2 is marked DECIDED accordingly.

**Vector overlays are the real constraint this path imposes**,
and they are not on this list. Borders, graticules and labels
(Phase 2) are *geometry*, not raster: nothing about them is
addressable by lat/lon lookup. On the equirect path they must
either be rasterised into an equirect texture first, or drawn
analytically in the shader — feasible for a graticule, not for
coastlines. That is a genuine cost of choosing direct RTT, and
it is worth naming here rather than discovering it in Phase 2.


### Globe state — what gets mirrored

The control window's `MultiOutputManager` maintains a
serialisable snapshot of "what the primary panel is showing,"
broadcast as a diff whenever it changes. v1 captures:

| Field | Source | Update trigger |
|---|---|---|
| `dataset.id`, `dataset.url` | `datasetLoader` | dataset load / unload |
| `dataset.kind` (image / video) | `datasetLoader` | dataset load |
| `dataset.overlay` (the whole `DatasetOverlayOptions`) | `overlayOptionsFromDataset()` | dataset load — see "Carry the overlay bundle" below |
| `dataset.duration` (seconds) / `dataset.rangeMs` | `datasetLoader` + enriched metadata | dataset load — inputs to `computeSiblingSyncCorrection`, see §3 "Playback sync algorithm" |
| `display` (the `ColorScaleDisplay` POJO) | `colorbarUI` → `mapRenderer.setColorScaleDisplay()` | palette / stretch / threshold change |
| `playback.date` (ISO 8601) | `playbackController` | per-second tick (video only) |
| `playback.paused` | `playbackController` | play / pause action |
| `playback.playbackRate` | `playbackController` (set by `tourEngine`'s `frameRate` task) | rate change — **not** assumed 1.0, see §3 |
| `layers[]` (stacked-layer ids and z-order) | new `layerStack` state in `main.ts` | layer add / remove / reorder |
| `time.simulationDate` | playback engine | date label tick |
| `view.dayNight` (toggle on/off) | Tools menu | toggle change |
| `view.cameraOffset` (Vector3) | Manager (computed from MapLibre camera) | default-on for SOS LED sphere outputs in v1; can be disabled per output. Points at the sphere's front, in the sphere's frame, with the operator's zoom. Pinned to `(0,0,0)` when tracking is off, which produces a uniform 1:1 equirectangular unwrap. See §3.5. |
| `view.orientation` (3×3 rotation) | Manager (computed from MapLibre centre and bearing) | The turn that brings the operator's centre round to the sphere's front, their way up. Identity when tracking is off. See §3.5 "Following the operator". |
| `view.split` (boolean) | Outputs panel toggle | per-output flag. When on, the area of focus is mirrored to the opposite hemisphere of the physical LED sphere — matches existing SOS sphere-split behavior. See §3.5. |

#### Carry the overlay bundle, don't re-derive it

An earlier draft of this plan carried a bare `dataset.bbox`.
`main` has a richer contract for exactly this handoff:
`DatasetOverlayOptions` (`src/types/index.ts:372-395`) is
`boundingBox` + `lonOrigin` + `isFlippedInY` + `celestialBody` +
`colorScale` + `datasetId` / `datasetTitle`, built once by
`overlayOptionsFromDataset()`
(`src/services/datasetOverlayOptions.ts:67`) and handed to every
render surface the app has. Broadcast the whole object.

This is not tidiness. Each field it carries is a UV or shading
decision the output would otherwise have to re-derive from the
catalog row and get wrong independently:

- `lonOrigin` — datasets whose texture does not start at −180°.
- `isFlippedInY` — datasets stored bottom-up.
- `boundingBox` — regional data clipped over a base Earth
  rather than stretched across the sphere. This is most of
  Open Question 7 (CONUS-bbox exactness to ≤1 px): the maths
  is already written and already agrees with the live globe,
  so an output that reuses the bundle inherits the answer
  instead of re-litigating it.
- `datasetId` / `datasetTitle` — so a *frame* can say what it
  is. The debug overlay and any failure report should
  attribute themselves to the dataset the texture actually
  came from, not to whatever app state currently says.

#### Data-encoded video

Data-encoded datasets were absent from this plan entirely, and
they are the primary use case for a value-carrying LED sphere.

For a data-encoded dataset the texture's luma *is* the
normalised value rather than a colour, and `colorScale` is
documented as *"the field that carries data-encoded mode to all
four render surfaces"* (`src/types/index.ts:377-383`). It rides
along inside `DatasetOverlayOptions` above, so the output gets
it for free — but the **display transform on top of it does
not**, and that is a separate broadcast field.

`mapRenderer.setColorScaleDisplay()` (`src/services/mapRenderer.ts:1090`) applies the operator's
palette swap, contrast stretch and value threshold by rebuilding
the 256×1 LUT the shader samples. Without mirroring it, an
operator who switches the control globe to magma leaves the LED
sphere on viridis — the two surfaces disagree about what the
same data looks like, in front of an audience, with no
indication which one is "right".

`ColorScaleDisplay` is a flat POJO —
`{ palette, stretch: { lo, hi }, threshold: { min, max } }`
(`src/services/colorScaleDisplay.ts:49-57`) — so it serialises
as-is with no conversion, and the output rebuilds its own LUT
through the same `buildDisplayLut`
(`src/services/colorScaleDisplay.ts:133`) the control window uses. Two
properties carry over and both matter on a sphere:

- Alpha always comes from the dataset's own ramp, so a
  thresholded region reads as absent rather than as a colour.
- **A display transform never changes a reported value.** The
  sphere may be recoloured; the numbers behind it are the same
  ones the control window is reporting.

#### Non-Earth bodies

The "idle state renders the photoreal Earth" default now needs
a caveat: `celestialBody` exists, and `isEarthBody()`
(`src/services/datasetOverlayOptions.ts:38`) is the gate the
render surfaces check. `photorealEarth.ts` already consults it
in two places (`:1260`, `:1275`), and `mapRenderer` at `:1458`.

So for a Mars or Moon dataset the output must suppress the
Earth-specific decoration the same way the existing surfaces do
— night lights, specular ocean, clouds, and the day/night
terminator are all wrong on another body, and a bbox-clipped
overlay must not reveal a base *Earth* underneath. The idle
state (no dataset loaded) stays photoreal Earth; it is only the
loaded-dataset path that has to ask. `globeThumbnail.ts:323`
shows the exact predicate to copy:
`!!overlay?.boundingBox && isEarthBody(overlay.celestialBody)`.

The SOS output **does** track the operator's MapLibre camera
by default in v1: panning the control window turns the sphere
so the area of focus faces its front, and zooming concentrates
pixels around it there while the rest of the globe compresses
on the antipodal side (§3.5, "Following the operator"). This is the
expected operator workflow on existing SOS installations and
visitors read it intuitively — see §3.5 for the math and the
per-mode defaults table. An operator who wants the LED sphere
to remain a 1:1 representation regardless of where they pan
the control window flips the per-output "Track operator
camera" toggle off; the cameraOffset pins to zero, the turn
to the identity, and the output renders a uniform equirect.

The control window keeps its own independent MapLibre camera
as today — `cameraOffset` is a derived broadcast, not a
two-way binding.

### New modules

| File | Responsibility |
|---|---|
| `src/services/multiOutput/manager.ts` | `MultiOutputManager` — singleton: enumerates monitors, spawns/destroys output windows, builds and broadcasts globe-state diffs, persists config, monitors output health (crash detection, IPC heartbeats, monitor-unplug 2 s poll, boot scan adopting orphaned `output-*` windows after a control-window **reload** — see "Failure recovery", case 6, which corrects the "crash" framing) |
| `src/services/multiOutput/protocol.ts` | Shared TS types for control↔output IPC events. Imported by both bundles. Single source of truth for the state schema above. |
| `src/services/multiOutput/stateAggregator.ts` | Subscribes to dataset / playback / layer / time / view events, builds the state snapshot, emits diffs |
| `src/ui/outputUI.ts` | Tools → Outputs panel — list current outputs, "Add output" button, per-output config menu (monitor, mode, "Track operator camera" toggle, "Split sphere" toggle, "Rotation offset (°)" numeric + slider, "Calibration" submenu with test-pattern selector, debug overlay), per-output health badge (healthy / stale / stalled / monitor-missing — see "Failure recovery") |
| `src/output/main.ts` | Output window entry. Creates Three.js renderer, builds `photorealEarth` scene + dataset overlay + layer stack, runs equirect RTT each frame, displays to a full-bleed canvas. Wires `webglcontextlost` / `webglcontextrestored` listeners and an IPC-silence watchdog (5 s tolerance, stale state thereafter — see "Failure recovery") |
| `src/output/equirectRtt.ts` | Equirectangular render-to-texture pass — single fragment shader. Applies the per-output `uRotationOffsetRad` longitude rotation first (see "Calibration tooling"), then raycasts from a configurable camera offset (`uCameraOffset`, derived from the operator's MapLibre camera by default; see §3.5) at every (lon, lat) of the output framebuffer, then turns the landing point by `uOrientation`, which brings the operator's centre to the front (§3.5, "Following the operator"). Supports split mode (`uSplit`) that mirrors the area of focus to the antipodal hemisphere of the LED sphere. |
| `src/output/datasetMirror.ts` | Output-side companion to control-window `datasetLoader` — given a `dataset.url` + `dataset.kind` + `dataset.bbox`, builds a Three.js texture (image or HLS-driven VideoTexture) and a UV transform. Owns the playback sync seam (feeds `computeSiblingSyncCorrection` and the read-back verification layer — see "Playback sync algorithm") and the single stream rebuild on a `loadStream()` rejection, freezing the last good frame throughout (see "Failure recovery"; there is deliberately no retry ladder here — `hlsService` owns that). ~~Recognises the `__terraviz_calibration__` sentinel dataset id and renders a procedural test pattern (~80 lines of GLSL) instead of fetching content~~ — superseded: the test pattern is `src/output/calibrationPattern.ts`, a canvas on the render-config channel, and this module knows nothing about it (see "Calibration tooling") |
| `src/output/calibrationPattern.ts` | The calibration test pattern (rung 14b) — a 2:1 canvas of graticule, colour bars, grayscale ramp, anchor crosshairs, longitude scale, pole letters and a live framebuffer readout, installed in an ordinary overlay slot so it travels the same sampling path a dataset does. Pure geometry in normalised image-space UV plus a thin painter; pinned against `datasetProbe.latLonToTexelUv` (see "Calibration tooling") |
| `src/output/layerStack.ts` | Builds the dataset overlay and layer stack the equirect pass composites — bbox clipping, the `lonOrigin` shift, `isFlippedInY`, and the data-encoded palette LUT, folded into `equirectRtt`'s fragment shader by `buildOutputFragmentShader`. Layers composite in array order inside that one shader, so there is no shell stack and no depth buffer. Slots are unrolled at build time (GLSL ES 1.00 has no dynamic sampler indexing) and capped at `MAX_OUTPUT_LAYERS` |
| `src/output/output.html` + `src/output/output.css` | Output window markup and styling — black body, no cursor, full-bleed canvas |
| `src-tauri/capabilities/output.json` | Narrow capability scoped to `output-*` window labels. Allows: event listen / unlisten / emit / emit-to (IPC with manager); window current-monitor / is-decorated / is-fullscreen / set-fullscreen / set-decorations / close; HTTP fetch on `https://*` only with localhost explicitly denied. Excludes: `core:default`, `core:window:default`, window creation, updater, filesystem, asset protocol, shell, dialog, clipboard, all Tauri command `invoke`. Full enumeration + rationale in §3 "Output capability spec". |

### Modified modules

| File | Change |
|---|---|
| `src/main.ts` | Boot `MultiOutputManager`; wire it to dataset / playback / layer / **camera** events |
| `src/services/datasetLoader.ts` | Emit a `dataset:loaded` event the manager subscribes to |
| `src/services/downloadService.ts` | **Already landed on `main`, separately from this ladder** — the read commands resolve to their no-downloads value and log a denial once instead of rejecting, so a window without the download grants degrades rather than throwing out of `loadDataset`. Listed here because §6 explains why it matters to multi-window work, not because this feature has to do it. See §6 |
| `src/services/mapRenderer.ts` | Emit a debounced `camera:moved` event with `{ lng, lat, zoom }` so the manager can derive `view.cameraOffset` for outputs that track operator camera |
| `src/ui/playbackController.ts` | Forward play / pause / scrubber events to the state aggregator |
| `src/types/index.ts` | Add `OutputAddedEvent` / `OutputRemovedEvent` / `OutputFailureEvent` interfaces; append to the `TelemetryEvent` union; tier choice is essential — none belong in `TIER_B_EVENT_TYPES` (see "Telemetry" decision in Open Questions §3) |
| `src/analytics/perfSampler.ts` | When outputs are active, extend the existing 60 s `perf_sample` event with `output_count` and `sync_delta_p95_ms` fields (no new event type) |
| `src/ui/toolsMenuUI.ts` | Add "Outputs" entry that opens the new Outputs panel; add a "Fullscreen" toggle that calls `getCurrentWindow().setFullscreen()` + `setDecorations()` and persists to localStorage (see §3.6) |
| `src-tauri/src/lib.rs` | Parse the `--kiosk` argv flag and `TERRAVIZ_KIOSK=1` env var in `setup()`; apply fullscreen + decorationless before first paint when set (see §3.6). **Not `main.rs`** — that is now a 12-line shim (`fn main() { terraviz_lib::run() }`) and all builder/setup logic lives in `lib.rs` so mobile can share it. Must be `#[cfg(desktop)]`-gated so it does not compile into the iOS/Android cdylib |
| `src-tauri/capabilities/default.json` | Add `core:webview:allow-create-webview-window`, `core:window:allow-close`, `core:window:allow-destroy`, `core:window:allow-set-decorations`, `core:window:allow-show`. The first three are what make spawning and tearing down an output possible at all; the fourth lets the fullscreen toggle drop the title bar; the fifth reveals an output once it has been placed, since placement cannot be expressed at construction time. Optionally drop the redundant `core:window:default` / `allow-available-monitors` / `allow-current-monitor` lines already implied by `core:default`. See §6 |
| `src-tauri/capabilities/mobile.json` | **No change** — multi-output is desktop-only and must not widen the mobile surface |
| `vite.config.ts` | **Add** an `output` entry to the existing `rollupOptions.input` object (which already declares `main` and `orbit`) pointing at `src/output/output.html`. Do not author a fresh `rollupOptions.input` — that would drop `orbit`. See §7 |
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
   `decorations: false`, **`visible: false`**, and a navigation
   URL pointing at the bundled `output.html` — then places it
   with `setPosition(new PhysicalPosition(...))` +
   `setSize(new PhysicalSize(...))`, calls `setFullscreen(true)`,
   and only then `show()`. Neither position nor fullscreen is a
   constructor option here, and the order matters: see "Monitor
   geometry and placement" for why, and for the fifth capability
   grant it costs.
4. Output window boots `src/output/main.ts`. Page renders a black
   background. Lazy-imports Three.js. Asks `photorealEarth`
   for its base diffuse texture (progressive 2K → 4K → 8K)
   rather than for a sphere to draw — see "What the equirect
   path does to the Earth decoration". Allocates a 2:1
   framebuffer at the target resolution (e.g. 4096×2048 for an
   8K LED sphere).
5. Output emits `output_ready` so the manager knows it's
   listening. Manager replies with a full state snapshot.
6. Output applies the snapshot: loads the dataset texture via
   `datasetMirror` (with the broadcast `DatasetOverlayOptions`
   and `ColorScaleDisplay`), builds the layer stack via
   `layerStack`, and takes its first correction from
   `computeSiblingSyncCorrection` against the broadcast date
   once metadata is in. Begins rendering the equirect RTT each
   frame and presenting it to the canvas.
7. Done.

### Monitor geometry and placement

Step 3 above says "the chosen monitor's top-left" as though
that were a single unambiguous number. A throwaway spike that
spawned real windows across a three-monitor Windows 11 desk
found two ways it is not.

**Monitor origins are signed.** `\\.\DISPLAY1` on the test
machine sits at **x = −1680** — the primary is 0,0 and anything
to its left is negative. That is an ordinary desk, not an edge
case. Placement itself worked: `outerPosition` came back
`−1680,383` and `2560,381`, matching both non-primary monitors
exactly. What it constrains is narrower and easier to get
wrong — placement arithmetic must not assume a non-negative
origin, the persisted config must store `x`/`y` **signed**, and
the picker's position diagram has to translate the whole
virtual-desktop rectangle rather than treating the primary
monitor as its own origin.

**`Monitor` positions are physical; window options are
logical.** `availableMonitors()` reports `position` and `size`
in **physical** pixels, while `WebviewWindow.new`'s `x` / `y` /
`width` / `height` are **logical**; the two differ by that
monitor's `scaleFactor`. On a uniform-scale desk they coincide
and the obvious code works. On a HiDPI monitor — or, worse, a
mixed-DPI desk where the scale factor differs *between*
monitors — passing a physical origin into a logical option puts
the output window on the wrong monitor, which reads as "the
feature is broken" rather than as a units bug.

**There is no physical option at construction.** `WindowOptions`
types `x` / `y` / `width` / `height` as bare `number`, documented
as logical pixels; only `setPosition` / `setSize` accept
`PhysicalPosition` / `PhysicalSize`
(`@tauri-apps/api/window.d.ts`). So the placement cannot be
expressed in one call, and boot-flow step 3 spawns the window
and then corrects it:

1. `WebviewWindow.new('output-N', { …, visible: false })` —
   **hidden**, and without `fullscreen: true`, since fullscreen
   before placement fullscreens onto whichever monitor the
   window happened to land on.
2. `setPosition(new PhysicalPosition(mon.position.x,
   mon.position.y))` then `setSize(new PhysicalSize(…))` — both
   already granted (§6), and both take the monitor's numbers
   unconverted, which is the point: no `scaleFactor` arithmetic
   means no `scaleFactor` bug.
3. `setFullscreen(true)`, then `show()`.

That ordering needs a **fifth** capability grant that the table
in §6 did not have: `core:window:allow-show`. `visible: false`
is a constructor option and free, but bringing the window back
is a command, and `core:window:default` is getters only — its
28 identifiers include `allow-is-visible` but no `allow-show`.
Verified against Tauri 2.11.2's own permission table.

Creating the window visible and letting it jump is the
alternative, and it costs the grant but shows the operator a
window sliding across the desk on every spawn — on a capture
feed, that is a visible artifact at exactly the moment an
installation is being set up.

The spike could not test that second case: all three monitors
reported `scaleFactor: 1`, so the two coordinate spaces were
numerically identical and a wrong conversion would have passed
unnoticed. **Mixed-DPI placement is unverified**, and it is the
likeliest placement bug in v1. It is cheap to get right up
front and expensive to find later, since the failure needs
hardware the developer may not have.

Two placement results did come back clean and are worth
recording, because both were open:

- **Borderless fullscreen lands correctly on a non-primary
  monitor** — `isDecorated: false`, `isFullscreen: true` on
  both secondary displays. This is Open Question 1, answered
  for Windows.
- **Fullscreen escapes the taskbar.** The primary monitor's
  `workArea` is 2560×**1392** against a `outerSize` of
  2560×**1440**: the window covers the taskbar rather than
  being confined below it, which is exactly what a
  capture-clean output surface needs.

### Per-state-change flow

State diffs are broadcast on change, not on a polling clock:

- **Dataset load** → manager broadcasts `{ dataset: { id,
  url, kind, bbox } }`. Output's `datasetMirror` swaps the
  overlay texture the composite samples; for video, it tears
  down the old HLS instance and starts a new one.
- **Layer add / remove / reorder** → manager broadcasts the
  full ordered `layers[]` array (small enough that diffing
  is overkill). Output's `layerStack` rebuilds the shader's
  slot bindings accordingly.
- **Play / pause / seek** → manager broadcasts the discrete
  event. Output's video element pipes through.
- **Per-second timecode** → manager broadcasts
  `{ playback: { currentTime, paused } }`. Output applies
  the drift-correction algorithm — see "Playback sync
  algorithm" below.
- **Day/night toggle** → manager broadcasts the new state.
  Output flips the terminator term in the equirect shader —
  the one line of `photorealEarth`'s day/night shading that
  survives the unwrap (see "What the equirect path does to the
  Earth decoration").
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
3. Update the equirect shader's `uSunDir` from
   `time.simulationDate` (uses the existing `getSunPosition()`
   helper at `utils/time.ts:646`, the same one
   `photorealEarth` calls). No mesh normal is needed: the
   ray-march's hit point on the unit sphere *is* the normal,
   so the terminator is one dot product against it.
4. Render the layer composite to the equirect framebuffer
   with the current `uCameraOffset` and `uOrientation` uniforms
   (derived from the operator's MapLibre camera when "Track
   operator camera" is on for this output; `vec3(0)` and the
   identity when off) and `uSplit` flag.
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
separate decoder). Keeping the two within a couple of frames
of each other, without the correction itself becoming visible,
is the whole problem.

**`main` already solves it, and already solves it as a pure
function.** `computeSiblingSyncCorrection()`
(`src/utils/time.ts:334-390`) was extracted from multi-globe
sibling drift correction (terraviz#132) precisely so the
control law could be unit-tested away from the DOM. It takes
plain numbers and `Date`s, returns
`{ position, targetTime, rate, shouldSeek }`, and touches no
renderer, no video element, and no app state. An output window
in a second webview can import and call it unchanged — it is a
sibling viewport in every sense that matters to the maths, just
one that happens to live in another window.

So this section specifies **what to feed it and what to do with
its answer**. It does not restate a control law. An earlier
draft of this plan re-derived one — a three-region
tolerance / soft-nudge / hard-seek scheme with its own
hysteresis pair and its own constants — and that is deleted. It
was worse than the shipped function in four specific ways, each
of which reuse fixes for free:

| The re-derived scheme | `computeSiblingSyncCorrection` |
|---|---|
| Synced raw `currentTime` | Syncs a real-world **date**, so it still works when the two elements have different durations or different temporal ranges |
| Hard-wrote `playbackRate = 1.0` on every correction | Takes `primaryPlaybackRate` and scales the pacing ratio by it — the tour-rate race below |
| Fixed ±5 % nudge behind a 100 ms / 50 ms hysteresis pair | Proportional rate trim (gain 0.5, capped at ±25 %), so there is no hysteresis state to flap and no band to tune |
| Hard-seeked at 2000 ms | Uses `SIBLING_HARD_SEEK_THRESHOLD_S` = 0.15 s, a measured value — 13× smaller, and 4× below a number already tried and rejected as too high |
| Froze correction below `readyState` 3 | Steers from `HAVE_METADATA` (1) — see "The `readyState` gate" below |

#### What the broadcast carries

Not `currentTime`. The `playback` block of the mirrored state
becomes the four things the function needs about the primary,
plus the pause flag:

| Field | Type | Why |
|---|---|---|
| `playback.date` | ISO 8601 string | The real-world instant the primary is showing. This is the sync target; the output deserialises it to a `Date`. |
| `playback.paused` | boolean | Unchanged. |
| `playback.playbackRate` | number | The primary's **current** rate, not an assumed `1.0`. See below. |
| `primary.duration` | seconds | The primary video's duration. |
| `primary.rangeMs` | number | The primary dataset's temporal span, `end - start` in ms. |

The output supplies the other half of the call from what it
already knows locally — its own `videoEl.currentTime`, its own
`duration`, and its own dataset's `start` / `end`.

Sending a date rather than a playhead is what makes the
broadcast **self-describing**. A `currentTime` is only
meaningful against one specific element: if the output rebuilt
its HLS instance, landed on a different rendition, or is a diff
behind on a dataset change, applying a raw playhead silently
shows the wrong moment with no way to notice. A date is
checkable — and it is exactly what the read-back layer below
needs. In the common mirroring case the two ranges are
identical and the pacing ratio is 1; that is the degenerate
case of the general one, not a different code path.

**`playbackRate` is not optional, and its absence is a bug we
have already shipped once.** The tour engine's `frameRate` task
computes `rate = requestedFps / datasetFps`, clamped to
`[0.03, 4]` (`src/services/tourEngine.ts:949-960`) and applies
it to the primary alone — a 5 fps request against a 30 fps
dataset is 0.167×. An output that assumes 1.0 runs ~6× fast,
races ahead, hard-seeks back, and repeats, for the whole tour.
That is terraviz#229 reproduced in a second window, and it
collides head-on with this plan's own tour-integration section.
The function's `primaryPlaybackRate` parameter exists for
exactly this and defaults to 1 only for callers that genuinely
have no rate to report.

#### The call

```ts
// src/output/datasetMirror.ts — on each playback diff, and per
// rAF while playing.
import {
  computeSiblingSyncCorrection,
  SIBLING_MIN_READY_STATE,
  SIBLING_HARD_SEEK_THRESHOLD_S,
} from '../utils/time'

if (!videoEl || videoEl.readyState < SIBLING_MIN_READY_STATE) return
if (!(videoEl.duration > 0)) return

const { position, targetTime, rate, shouldSeek } = computeSiblingSyncCorrection({
  date: new Date(state.playback.date),
  sibCurrentTime: videoEl.currentTime,
  sibDuration: videoEl.duration,
  sibStart, sibEnd,                        // this output's own range
  primaryDuration: state.primary.duration,
  primaryRangeMs: state.primary.rangeMs,
  hardSeekThresholdS: SIBLING_HARD_SEEK_THRESHOLD_S,
  primaryPlaybackRate: state.playback.playbackRate,
})

if (position !== 'inside' || state.playback.paused) {
  if (!videoEl.paused) videoEl.pause()
  if (shouldSeek) videoEl.currentTime = targetTime
  return
}
if (videoEl.paused) void videoEl.play()
videoEl.playbackRate = rate
if (shouldSeek) videoEl.currentTime = targetTime
```

The three state changes the earlier draft handled with special
cases — operator pause, operator seek, re-entry from
out-of-range — are not special cases here. A pause is the
`paused` branch; a seek is simply a large `error` that trips
`shouldSeek`; an out-of-range date returns
`position !== 'inside'` and pins the output to its nearest
boundary frame. Only a dataset change still needs its own path
(tear down the HLS instance, build a new one, then let the
first correction land once metadata is in).

`hardSeekThresholdS` is a call parameter, but the **value is
not the output's to choose**. Import
`SIBLING_HARD_SEEK_THRESHOLD_S` from `time.ts:259` — it is
`0.15`, and its docstring says outright that it lives beside the
control law rather than in `main.ts` "so the value can be tested
against those two numbers directly". Two browser measurements
from a 4-globe session fix it:

| Measurement | Value | What it constrains |
|---|---|---|
| Steady-state drift under the rate trim | ≈ 0.026 s | The threshold must sit well **above** this or it seeks continuously — the terraviz#229 flicker |
| Post-stall offset after a scrub | ≈ 0.35 s | The threshold must sit **below** this so it snaps out in one frame instead of being trimmed away |

At 0.15 s the margins are ~5.8× and ~2.3×. The previous **0.5 s**
cleared the first but sat above the second, leaving a post-scrub
offset to the trim — which closes 0.35 s at ~0.029 s/s, or
about twelve seconds of visibly staggered globes after every
scrub.

This is worth dwelling on, because the earlier draft of this
plan proposed **2000 ms** — 13× the shipped value, and 4× above
a number already measured and rejected for being too high. On a
control window that is twelve-plus seconds of staggered panels
per scrub; on an 8K LED sphere in a gallery it is the same
error, larger, with nobody able to explain it. Mirroring the
constant locally would let the two drift apart silently, so
import it.

The out-of-range boundary pin uses `SIBLING_SEEK_EPS_S = 0.02`
(`time.ts:296`) for the same reason — its docstring records a
capture where a fifth-of-a-frame seek left three siblings at
`HAVE_METADATA` for five seconds. Import that too rather than
inventing an epsilon.

#### A seek is not free — found on hardware, rung 9 step 13

The threshold above is the *right* number for a sibling panel,
and it is not sufficient on its own for an output. A seek stalls
the element while the primary plays on, so a seek that takes
`C` seconds of wall clock leaves the output roughly `C x rate`
behind **the moment it lands**. Seeking to correct an error
smaller than that is arithmetically guaranteed to end further
from the target than it started — and the correction runs once
per rendered frame, so it does it again, and again.

`OUTPUT_SEEK_SETTLE_MS` was the first answer to this and it
covers only the case it assumed: a seek that finishes inside a
second and leaves less than `SETTLING_SEEK_THRESHOLD_S` (0.40 s)
behind. It is a **timeout**, and it expires whether or not the
seek it was covering has been paid for. A slower seek outlives
it, the threshold drops back to 150 ms while the error is still
measured in seconds, and the loop closes.

Simulated at 60 Hz against an element that stalls for the length
of its seek, twenty seconds per run, starting five seconds out:

| Seek cost | Seeks, settle window only | Frames mid-seek | Seeks, with the floor |
|---|---|---|---|
| 20 ms | 1 | 0% | 1 |
| 200 ms | 1 | 1% | 1 |
| 300 ms | 20 | 29% | 1 |
| 500 ms | 40 | **97%** | 1 |
| 1200 ms | 17 | **99%** | 1 |
| 3000 ms | 7 | **99%** | 1 |

Two things to read off that table. The loop starts at any cost
above the 150 ms threshold, not at 400 ms — 300 ms just produces
a tidier one-seek-per-second version of it. And above ~400 ms
the element is mid-seek on essentially every frame, which is a
decoder flushing and re-decoding from a keyframe continuously
rather than playing. That is the "playback seems to struggle"
of the first hardware pass; it is also why the debug HUD read a
permanent dash, since a seeking element has no honest drift to
report and every 2 Hz sample landed on one.

The fix is to **measure the seek rather than assume it**.
`createPlayheadSync` already holds when it last seeked; it now
also notices when `seeking` goes false and records what that
cost, and `seekCostFloorS` raises the threshold to that cost
times the primary's rate times a margin. Unlike the settle
window this floor does not expire, because the cost is a
standing property of the asset, the decoder and the machine
rather than an event. It is inert where seeks are cheap: a
20 ms seek yields a floor below 0.15 s and `Math.max` discards
it, which is the whole table's first two rows.

The margin exists because the loop re-arms on a single
under-estimate — one seek running slightly long puts the output
back outside the threshold and earns another — while an
over-estimate costs only a slower convergence that the rate trim
still completes. 1.5 covers ordinary variance between two seeks
on the same asset.

**Both bounds are lifted while the primary is paused**, and the
reason is the premise they share rather than a special case.
Each exists because the target keeps moving during the stall:
the floor because a seek costing `C` leaves the output `C x rate`
behind by the time it lands, the settle window because the trim
needs time to close what the last seek left. Against a
*stationary* target neither holds — a seek lands exactly where it
aimed and manufactures no error — and the sentence about the trim
is worse than unnecessary, because a paused element has no rate
to trim at all. So a raised bound there is not conservative, it
is terminal: the paused branch declines the seek, nothing
converges it, and the sphere holds a frame up to a floor's width
from the operator's until someone presses play. On a forecast
that is an hour of model time on the wrong frame, silently, in
front of an audience.

The thrash that motivated both bounds cannot happen on a
stationary target either: the seek lands where it aimed, the next
call measures ~0, and nothing more is issued. One seek,
converged. This was caught in review rather than on hardware,
which is worth recording — the floor's own justification names
the moving target in its first sentence, and the paused path
still read the value it produced.

The field case was a bbox data-encoded forecast
(`north-america-smoke`, RRFS smoke over North America).
Data-encoded video is published **as uploaded** rather than
transcoded — that is why
`src/ui/publisher/components/mp4-frame-rate.ts` exists — so
these assets carry whatever keyframe spacing the producer wrote,
and every seek decodes from a distant one. Nothing about that is
wrong; it is simply an asset class whose seeks are expensive,
and the correction has to be robust to it rather than assume it
away.

#### A playhead diff is not a frame

Related, and found reading the same report. The output's loop
paces itself: 30 fps while its own video is advancing, 1 Hz for
anything static, and immediately whenever something changed.
`applyState` marked *every* state diff as a change.

`playback` and `primary` change on every frame the operator's
globe plays, so an output redrew a 4096x2048 ray-marched sphere
at the control window's frame rate instead of 30 fps — double
the GPU for an identical picture, on a machine whose webview may
be on the iGPU (see Risks) and whose control window is decoding
the same video in the next process. Neither key changes a pixel
here: the output's own frame advance is what `contentKindFor`
paces, and a seek is caught by the render loop comparing
`currentTime` across the steer.

`PICTURE_KEYS` / `PLAYHEAD_KEYS` in `outputLink.ts` partition
`StateKey` between the two, with compile-time proofs that every
key is classified and none is classified twice. Keys that are
composited but not yet published — `layers`, `simulationDate` —
stay on the picture side, so the 1 Hz floor never holds one back
once it is wired.

#### The `readyState` gate

Steer from `readyState >= SIBLING_MIN_READY_STATE`, importing
the constant rather than re-declaring the number.

The earlier draft froze correction below `readyState` 3
(`HAVE_FUTURE_DATA`) to avoid "spurious behind-drift readings
during stalls". That gate is **stricter than the value `main`
documents as a bug**, and on a looping installation asset it is
the difference between a sphere that wraps and a sphere that
stops. `SIBLING_MIN_READY_STATE = 1`
(`src/utils/time.ts:231`) carries a standing warning against
raising it (`time.ts:203-230`):

> **Do not raise this to `HAVE_CURRENT_DATA` (2).** That is
> where it sat until it caused the loop-wrap stall.

The mechanism: the auto-loop pauses the primary just short of
`duration`, which parks every sibling at that same near-end
position, and a MediaSource-backed element seeked to within
roughly one segment of its buffered end sits at `HAVE_METADATA`
indefinitely. The gate then skips exactly the element that is
stuck, at exactly the moment it needs seeking home. Measured in
Chromium, a `currentTime` write recovers such an element in
≤16 ms; skipping it strands the panel until the browser
re-buffers on its own.

A draft gate of 3 is two steps past the value that broke, so it
fails in the same way and sooner. It would strand a looping
output at *every* wrap — which, for a 30-second SOS loop
running unattended in a gallery, means a black or frozen sphere
within the first minute and no operator watching to notice.
`HAVE_NOTHING` (0) stays excluded, because `duration` is `NaN`
there and would poison the mapping.

#### Read-back verification

`currentTime` is valid for *steering* and invalid for
*asserting that a panel shows the right frame*. `main` learned
this the hard way and carries a separate layer for it;
an output needs the same one, and needs it more, because
nobody is looking at the sphere.

`shownFrameTime()` (`src/utils/time.ts:438`) documents the two
ways the element's clock lies about the picture: a seek reads
back its target instantly while the element is still buffering,
and a surface whose repaint chain has broken keeps advancing
its clock over a texture that stopped updating. Both report
perfect alignment from `currentTime` while showing a stale
frame. The second is not hypothetical here — it is precisely
what this plan's own "early-out when nothing changed" render
loop (see "Per-frame flow inside the output window") produces
if the early-out and the texture upload ever disagree.

So the output carries a second, independent layer:

1. Record `uploadedFrameTime` — the playhead at the moment a
   frame was actually written into the Three.js texture, not
   the moment it was requested.
2. Once per second (not per frame), call `verifySiblingTime()`
   (`src/utils/time.ts:482`) with
   `sibFrameTime: shownFrameTime(uploadedFrameTime, videoEl.currentTime)`
   and the broadcast date as `labelDate`.
3. `alignment: 'aligned'` → nothing. `'uncovered'` → nothing;
   the date is outside this output's range and the pinned
   boundary frame is correct. `'off'` → force a texture upload
   (repaint repair), and if it is still `'off'` on three
   consecutive checks, report `output_frame_stale` to the
   manager, which renders a health badge in the Outputs panel.

**This layer never seeks.** `verifySiblingTime`'s docstring is
explicit that it is a verification and not a correction, because
re-seeking from here would fight the sync controller for
ownership of the playhead. It reports; the controller steers.

#### Cross-window decoder budget

Every decoder cap in the codebase today is **per window**, and
outputs are the first thing that breaks that assumption.

`maxVideoPanelsForViewport()`
(`src/utils/deviceCapability.ts:81`) is the live one: pure,
order-independent, returning `MAX_VIDEO_PANELS_PHONE = 2`
(`:70`) when the viewport's *shorter* edge is ≤ 600 px and
`UNCAPPED_VIDEO_PANELS = 4` (`:73`) otherwise.
`maxVideoPanels()` (`:88`) applies it to
`window.innerWidth / innerHeight` — **the calling window's own
viewport**, which is precisely the blind spot. An output on a
4K monitor answers "4" no matter what the control window is
already holding. (`MAX_PANELS = 4` in
`src/services/vrScene.ts:83` is a separate VR-side cap with the
same shape.)

Its docstring (`deviceCapability.ts:57-69`) is worth reading
before designing around it. Measured on an iPhone 16 against
the Climate Futures tour: four globes with no datasets is fine,
four with *image* datasets is fine, and video dies somewhere
between the second and third decoder — **while still loading,
before anything animates**. The conclusion it draws is the one
that governs here:

> the ceiling is on video decoders *existing*, not on playback,
> panel count, or WebGL contexts, and there is no window in
> which to intervene once the layout has asked for four.
> See terraviz#230.

So four control panels plus four outputs is up to **eight
concurrent decoders on one machine**.

##### What a throwaway spike measured, and what it changed

An earlier draft of this section reasoned from the phone
measurement to a fixed cross-window budget of 4, and described
the failure as a hard crash boundary on any machine. A
throwaway spike (Windows 11, Intel Raptor Lake-S + **RTX 4090
Laptop**, three monitors, packaged desktop build, real
`HLSService` → hls.js → MSE playback) tested that directly.
Both runs used 8192×4096 render targets — 128 MiB apiece, the
top rung of the resolution picker — with only the output count
differing:

| Live outputs | Render targets held | Steady fps | Δframes / 3 s | Dropped | Media clock |
|---|---|---|---|---|---|
| 8 | 1 GB | 30.7 | +92 | 0 | 1.00× realtime |
| 16 | **2 GB** | **30.7** | **+92** | **0** | **1.00× realtime** |

Sixteen outputs, each holding a WebGL2 context, a 128 MiB
render target and a live decoder, at **full source frame rate,
exactly realtime, nothing dropped** — and *identical* to the
eight-output case, not merely close. Four times the budget this
section proposed, at four times the default pixels, with no
measurable sustained cost.

Three corrections follow, and they matter more than the number:

- **A fixed budget of 4 is wrong on this class of hardware.**
  It is at least 4× too conservative. The phone measurement is
  sound *about a phone*; it does not transfer.
- **The failure shape is hardware-dependent, not just the
  threshold.** The crash-boundary framing above is inherited
  from a phone. This machine was never taken close enough to
  find its limit, so whether it fails as a cliff or a gradient
  is **unknown** here — an honest gap, not a resolved one. A
  design that assumes a cliff will watch for the wrong symptom
  on desktop hardware.
- **The real cost is at spawn time, not in steady state.**
  Sixteen outputs took ~160 ms longer to reach full rate than
  eight (five cumulative frames). Every window still got there.
  A budget sized for sustained capacity solves a problem this
  hardware does not have.

Two methodological notes worth keeping, because both changed a
conclusion:

- **A cumulative frame count cannot measure throughput.** A
  single reading taken a fixed interval after playback *starts*
  folds in startup latency; it showed a spurious ⅓ drop that
  vanished once two samples were differenced. Steady-state fps
  must come from a delta over wall-clock, not from a total.
- **`droppedVideoFrames` is not a sufficient health signal.**
  It was 0 in every run, including the one that looked
  degraded. Frame *production rate* and a media-clock-vs-wall
  ratio are what actually move.

**These numbers are from one 4090 laptop.** A museum is far
likelier to deploy an Intel-iGPU NUC, and on that hardware the
cliff this section originally described may well be real.
Treating 16 as a new constant would repeat the original mistake
with a different number.

##### The budget v1 actually ships

v1 gives the manager a single budget spanning every window it
has spawned. The **mechanism below survives the spike
unchanged; only its value and its health signal move.**

| | |
|---|---|
| **Budget** | `DEFAULT_CONCURRENT_DECODERS`, seeded from the control window's own `maxVideoPanels()` and **raised on hardware that demonstrates headroom**, rather than fixed in source. A constant either cripples a 4090 or crashes an NUC. |
| **Counted** | ~~one per video dataset in the control window's panels, plus one per output currently showing a video dataset~~ — **revised at rung 11c, when it was implemented.** One per *window that can hold a decoder*: every control-window panel, plus every spawned output. The original rule is true about the present and wrong about the moment that matters. Outputs mirror the primary, so every output flips from free to costing a decoder the instant a video is loaded — and a dataset load is not a place a refusal can happen: it is deep inside a loader, with no control to disable and nothing for the operator to undo. Under the original rule an operator adds eight outputs while an image is up, loads a video, and takes the installation down with the budget never once consulted. Counting windows puts the refusal on **Add Output**, where there is a button to disable and a number to show. The spike above is explicit that the failure *shape* on desktop is unknown; under that uncertainty the enforcement point has to be the one the operator can still act on. The cost is the one the section already names below, and the budget field is its answer. |
| **Enforced** | at both spawn time and layout change — whichever action would cross the budget is refused, with a message naming what to close first. Enforced *before* the decoder is built, since after is too late. |
| **Health signal** | steady-state frame rate and media-clock-vs-wall ratio, sampled as a delta. **Not** a dropped-frame counter, which stayed at 0 through every condition the spike could produce. |
| **Spawn pacing** | outputs restored on boot, or added in a batch, are staggered rather than created simultaneously. Startup contention is the one cost the spike could actually measure. |
| **Not enforced** | by an output asking `maxVideoPanels()` itself. That reads the output's own viewport and would answer 4 on any monitor worth attaching, which is the bug. The manager owns the count; outputs are told. |
| **Not enforced** | by killing an existing decoder. Silently tearing down a running output to make room for a control-window layout change is the worse failure. |

The honest cost, on a machine whose budget really is 4: an
operator running 4 globes cannot also add a video output. That
is a real restriction and it will be the first thing anyone
hits on constrained hardware. It is still the right trade —
a refused layout change is recoverable in one click, and a
decoder-ceiling crash takes the installation down mid-session
with no recovery at all. Phase 5's shared-GPU-texture work is
what actually lifts the ceiling rather than rationing under it.

#### What's not the algorithm's job

- A/V sync within a single decoder — the browser's `<video>`
  handles that. We only correct between decoders.
- Cross-output coherence — outputs A and B both sync to the
  control window's date, not to each other. Because they share
  a target rather than chaining, their worst-case separation is
  bounded by twice the hard-seek threshold rather than
  compounding. Acceptable on physically-separated outputs; if it
  ever isn't (twin-LED-sphere installation), Phase 5's
  shared-GPU-texture work eliminates the second decoder.
- Re-deriving any part of the control law. If the sync
  behaviour needs to change, it changes in
  `computeSiblingSyncCorrection` and both the control window and
  every output inherit it — that single-source property is the
  main reason for this rewrite.

Constants live in `src/output/datasetMirror.ts` as named
exports for tests. The list is short on purpose — note what is
*not* here: no tolerance band, no hysteresis pair, no nudge
magnitude, no `readyState` number, and **no threshold**. Every
one of those is a tuned value in `time.ts` with measurements
behind it, and a local copy is a copy that drifts.

```ts
// Imported, never re-declared — see "The call" above.
import {
  SIBLING_MIN_READY_STATE,
  SIBLING_HARD_SEEK_THRESHOLD_S,
  SIBLING_SEEK_EPS_S,
} from '../utils/time'

/** Read-back cadence. Once per second, never per frame. */
export const VERIFY_INTERVAL_MS = 1000
/** Consecutive `'off'` verdicts before reporting a stale frame. */
export const STALE_FRAME_STRIKES = 3
/**
 * Cross-window ceiling — see "Cross-window decoder budget".
 * A conservative *seed*, not a measured limit: one 4090 laptop ran
 * sixteen 8192x4096 outputs at full rate. Raised per-machine from the
 * Outputs panel and persisted with the layout, because a constant here
 * either cripples that machine or crashes an iGPU NUC.
 */
export const DEFAULT_CONCURRENT_DECODERS = 4
```

Only the last three are genuinely this feature's to own, and
that is the right ratio: the sync behaviour is inherited, and
what an output adds is a read-back cadence and a budget that no
single window could have needed.

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

> **Landed.** `outputHealth.ts` (classification + crash-storm
> guard), `OutputWindowHandle.onDestroyed`, the manager's
> `handleDeparture`, and the output's `output_closing`
> announcement. What is *not* here yet is the toast — the app has
> no toast primitive, so the panel learns through
> `onOutputsChanged` and an open panel repaints; a toast is its
> own change. The `output_failure` / `output_removed` telemetry
> below **has** since landed (`outputTelemetry.ts`), so step 31's
> telemetry half is now checkable: a crash fires exactly one
> `output_removed` with `reason: 'crash'` and one `output_failure`
> with `kind: 'crash'`, `retries: 0`, `recovered: false` — zero and
> false because this case's own row in the summary table gives a
> crash no auto-recovery at all.
>
> One rule this case needs that the plan did not state: a
> departure is persisted **only when it was deliberate**. A
> hand-close rewrites the stored config without that output; a
> crash leaves it in. The operator still wants a crashed output —
> the display or the driver took it away — so dropping it would
> turn a four-projector installation into a three-projector one
> at the next launch, silently. It also bounds what an ordinary
> quit can cost: `quit_app` is `app.exit(0)`, not a per-window
> close, so if Tauri delivers each output's destroy to the
> control window before the process goes, every one reads as a
> crash (no `output_closing` precedes them). Unverified either
> way on hardware — **worth a step in the next Appendix B pass:
> quit with three outputs up, relaunch, confirm all three come
> back.** With the split the worst that costs is some telemetry.
>
> One thing the build clarified about the detection rule. The
> plan says the absence of a graceful ping distinguishes a crash
> from an operator close, which is right, but it leaves out that
> **the manager's own close produces both signals at once**:
> Remove in the panel calls `close()`, which fires the output's
> close-requested handler, which emits `output_closing`. So the
> manager's intent has to be checked *before* the announcement,
> not after, or every removal is logged as a hand-close.

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

**Detection.** The output builds its video through the same
`HLSService` the control window uses, so a fatal error
surfaces as a **rejection from `loadStream()`** — not as a
raw `Hls.Events.ERROR` the output subscribes to itself.

**There is no retry ladder here, deliberately.** An earlier
draft of this plan specified 3 attempts at 1 s / 2 s / 4 s
backoff. That layer was both redundant and inert, because
`hlsService` already retries internally before it ever
rejects (`src/services/hlsService.ts:47, 431`):

| Error type | What `hlsService` already does | Budget |
|---|---|---|
| `NETWORK_ERROR` | `startLoad()` | `MAX_ERROR_RETRIES = 3` |
| `MEDIA_ERROR` | caps `autoLevelCapping` one rung below the failing level, then `recoverMediaError()` | `MAX_ERROR_RETRIES = 3` |
| other fatal | rejects immediately | — |

The promise rejects only *after* that budget is spent. So a
retry in `datasetMirror` would re-run a torn instance whose
recovery paths are already exhausted — it changes nothing
except latency. Stacked, the two ladders would give up to
nine load attempts and ~7 s of added silence before the
sphere is told anything is wrong.

**Recovery.** One rebuild, not a ladder: `destroy()` the
`HLSService` and call `loadStream` fresh. That is the only
action that differs from what already failed — it buys a new
`Hls` instance with a reset ABR cap and a re-fetched
manifest. If the rebuild also rejects, stop.

**The texture freezes on the last good frame throughout** —
the LED sphere shows the most recent imagery rather than
going black. Then emit `output_dataset_stalled` to the
manager, which surfaces a status badge on that output in the
Outputs panel. The operator reloads the dataset manually,
which takes the normal dataset-change path.

Non-fatal HLS errors (single-segment 404, transient 5xx) are
handled inside hls.js and never reach either layer.

#### 3. IPC channel goes silent

> **Landed** (`src/output/linkWatchdog.ts`, the composition in
> `outputLink`, the manager's resync reply, and a `link` field on
> the debug HUD). The constants below were already in
> `protocol.ts` and the `output_health_check` event already in the
> schema — only the detector was missing, so nothing on either
> side had ever measured silence.
>
> Four things the build settled that this section leaves open.
> The watchdog's clock **starts at connect**, so an output nobody
> ever broadcasts to goes stale — that is the case most worth
> catching and a detector armed by the first message never fires
> in it. **Orphaned is not terminal**: any message returns the
> link to live, which is what makes the recovery paragraph below
> work at all. Both thresholds measure from the **last message**
> rather than from each other, so orphan is 60 s of quiet rather
> than 65. And the manager answers a ping through the *same* path
> as `output_ready` — which also means a ping is how an output
> recovers when its announcement was lost.
>
> The **stale badge** has since landed too, and finding out how
> it should work moved a constant: `LINK_PING_INTERVAL_MS` was in
> `linkWatchdog.ts` on the argument that only the output sends
> pings, so no shared timing was implied. That was wrong. Deciding
> an output has *stopped* complaining means knowing how long a
> silence must be before the last complaint is out of date — which
> is the ping cadence — so it now sits with the other agreed
> timings in `protocol.ts`. The badge itself draws nothing for a
> healthy output: a row of green chips trains an operator to skip
> the row that matters. Wiring it also revealed that
> `onOutputsChanged` had been fired since 13a with **no
> subscriber**, so a crash stayed on screen until the panel was
> reopened.
>
> Still missing: the **boot scan** the recovery paragraph depends
> on is case 6 and unbuilt — so today an orphaned output recovers
> only if the same manager comes back, not a relaunched one.

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
the persisted `{ x, y }` of that monitor (matched on
`monitorName` **and** `monitorOrigin` — see §3 "Persistence";
a reconnect is exactly the event that reshuffles Windows
display names), and clears the toast.

#### 5. GPU context loss

> **Detection has landed for the output; the two paragraphs
> below are kept because they are the record of how this was
> mis-scoped twice, in opposite directions.**
>
> An earlier draft listed this case beside the other five as
> though it were extending something, and was corrected to:
> *"there is no `webglcontextlost` or `webglcontextrestored`
> handling anywhere in `src/` today — zero matches across the
> whole tree. Nothing in the app has ever survived a lost
> context. Scope commit 13 accordingly, and expect the
> recovery path to need its own tests and its own manual
> verification (a forced context loss via
> `WEBGL_lose_context`), because there is no existing
> behaviour to regress against."*
>
> **That is now false twice over, and the second one was
> always false.** #403 added the control window's listeners in
> `mapRenderer.ts`. And the grep was over `src/`, which was
> the wrong place to look for the output: Three's
> `WebGLRenderer` has always registered both listeners itself,
> **inside its constructor** — before the context exists, so
> it catches a creation-time loss — calls the
> `event.preventDefault()` the Recovery section below
> prescribes, sets the flag that makes `render()` return
> immediately, and on restore runs `initGLContext()`, which
> builds a fresh `WebGLProperties` and with it fresh
> `textures`, `geometries`, `programCache` and
> `bindingStates`. Every GL handle is therefore re-uploaded
> lazily on the next draw.
>
> **So for the output the rebuild is largely already there,
> and for a reason worth stating rather than relying on:**
> `outputScene` holds no raw GL handles at all — no
> `WebGLRenderTarget`, no `createTexture`, and the "2:1
> framebuffer" is the renderer's own drawing buffer via
> `setSize(w, h, false)`. That is exactly what
> `earthTileLayer` is not, and its closure-held `datasetTex`
> is the handle #403 found could never come back. The
> conclusion follows from Three's source, **not** from having
> watched a sphere recover — which is why what landed is the
> observation and not a claim about the picture.
>
> **Do not write a parallel restore path for the output on
> the strength of the Recovery section below.** Read
> `outputScene`'s `gpuState` block first, and check what
> Three's `initGLContext` leaves undone before adding to it.

That absence matters more with outputs than without, because
outputs push against a ceiling the app is already close to.
Context-creating sites on `main` today: one per MapLibre
`MapRenderer` (up to 4 in a 4-globe layout), plus
`vrSession.ts:532`, `globeThumbnail.ts:272`,
`orbitCharacter/index.ts:157`, `glLumaSampler.ts:134` (one
page-shared instance via `getSharedLumaSampler()`), and
`perfSampler.ts:271`. Each output window adds one more. Browsers
cap live contexts per process and **silently evict the oldest**
when the cap is crossed — so the first symptom of "too many
contexts" is a context-lost event on a surface nobody touched,
which is exactly the path with no handling.

**Where that cap actually binds is narrower than it reads**,
and a spike measured the difference. The cap is *per process*.
On Windows, WebView2 gives every Tauri window its own process,
so sixteen output windows are sixteen separate context budgets
of one each — the spike ran exactly that, sixteen live WebGL2
contexts holding a 128 MiB render target apiece, with no
eviction. Adding outputs does **not** push the control window
toward its own cap on that platform.

What does push it is the control window's own list above: four
`MapRenderer`s plus Orbit plus the shared luma sampler plus the
perf sampler, all in one process. That is the crowded surface,
and it is crowded whether or not any output exists. macOS is
the case to watch, because WKWebView may share a process across
windows and would then put outputs back inside the control
window's budget; it is untested. So keep the recovery path —
eviction is real — but stop attributing it to output count on
Windows.

**Detection. Landed.** `outputScene` listens on the canvas
for `webglcontextlost` / `webglcontextrestored` and exposes
`gpuState()` (`live` / `lost` / `restored`) plus
`onGpuStateChange`. Triggers include driver crash, OS sleep /
wake, GPU hot-reset under memory pressure, and eviction as
above. Three states rather than a healthy/broken pair,
because the two things worth telling apart on a projector are
"there was a GPU event and it is still out" and "there was
one and it came back" — and because neither is a claim that
the sphere is correct, which this layer cannot see.

Two consequences carry the value, and the second is the one
that was actually broken. The debug HUD names the state
beside the renderer string, drawn only when it is not `live`.
And the render loop **declines to draw while the context is
lost** — not because `render()` is unsafe (Three returns from
it immediately) but because the bookkeeping around it was
lying: ticking the fps meter, clearing `dirty` and advancing
`lastFrame` for a frame that reached no pixels made the HUD
report a healthy 30 fps over a black projector.

`dispose()` unhooks its listeners **before**
`renderer.forceContextLoss()`, because that call fires the
same event a driver crash does; unhook after it and closing
four outputs at the end of a show reports four crashes.

**Recovery. Mostly already Three's — read the box above
before building this.** `event.preventDefault()` is called by
Three's own listener, so writing a second one buys nothing;
`render()` is already a no-op while lost; and
`initGLContext()` is the scene rebuild, running on the same
objects the boot path built rather than beside them, which is
the scoping note below satisfied by construction.

~~On `webglcontextrestored`: rebuild the Three.js scene from
scratch (textures, framebuffer, layer composite) using the fresh
state snapshot the manager re-pushes. Same code path as boot,
just without recreating the window.~~ **Superseded — do not
build this.** It is what the box above is warning against, left
struck through rather than deleted so the instruction is not
re-derived from a summary. `initGLContext()` already discards
every cached GL handle, and the scene owns none of its own, so
the rebuild happens lazily on the next draw and the manager
re-pushes nothing. What the output does on restore is flag the
next frame dirty, so the first good frame does not wait out the
1 Hz static floor.

The output does emit `output_gpu_recovered` to the manager for
installation logging.

If `webglcontextrestored` doesn't fire within 30 s (some
drivers don't recover): log + remove the output record;
operator manually re-adds.

Two scoping notes for whoever builds this:

- The rebuild must go through the *same* boot path the
  window already uses, not a parallel "restore" path.
  A second code path that only runs after a rare event is a
  path that silently rots.
- ~~Work on context-loss detection for the control window is
  in flight separately. If it lands first, this case becomes
  a consumer of that infrastructure rather than the place it
  is invented — check before building, and prefer sharing the
  detection seam over duplicating it.~~ **Resolved, and the
  answer was no.** #403 landed, and its seam does not cross:
  `onContextLost` is an option on `MapRenderer` fired from
  MapLibre's own event, and an output has no MapLibre — it is
  a Three renderer on a raw canvas. What crosses is the
  *policy*, and it is what the detection above follows:
  report without repairing, never let a restore claim
  recovery, log above the production filter, and keep the
  reporting surface out of WebGL.

**Reporting. Landed.** The output tells the manager over the
shared event channel — `output_gpu_lost` (new) and
`output_gpu_recovered` (declared from commit 1; §6's capability
table listed only the recovery until this rung, which is the
shape of half-list an allowlist tightened against would silence
the loss and keep the recovery — it names the whole union now)
— and this is
the one report that travels *because* the link is healthy. Every
other failure the manager detects is an **absence**: a destroy
with no `output_closing`, a window that never answers a poke. A
lost context defeats all of them, because the window stays up,
the channel works, the heartbeat is answered, and the sphere is
black.

The manager latches it on the record, badges it **Display lost**
in the Outputs panel, and emits the Tier A `output_failure` with
the `gpu-loss` kind rung 13b had already declared — no schema
change, the second case to cash that. A **latch, not a
timestamp**: a stale-link complaint expires because the output
stops pinging when it recovers, and silence is how the manager
learns that, but a lost context is announced once and never
mentioned again, so the same TTL would call a black projector
healthy five seconds later. Only the matching recovery clears
it, and `gpu-lost` outranks every other badge — not for urgency,
but because the others are inferences drawn from silence and
this one is the output saying so outright.

**Still to build**, and deliberately not in the detection
commit: the 30 s no-restore timeout and the
`gpu-loss-timeout` removal it triggers. Both are the
manager's, both auto-close a window on a projector, and
neither should be written before a forced
`WEBGL_lose_context` on real hardware has said whether a
restore actually arrives — the reporting above is what makes
that question answerable.

#### 6. Manager / control window crash with outputs alive

**Landed.** `MultiOutputManager.adoptOrphanedOutputs()`,
`OUTPUT_REATTACH_EVENT`, and the listener that answers it in
`outputLink`. Chained ahead of `restoreOutputs()` in
`bootMultiOutput`. Not exercised on hardware.

**What actually survives, which is not what this section
first said.** The heading and the smoke step below describe
killing the control window's *process*. That cannot produce
the state this case is about: every window belongs to one
Tauri process, so killing it takes the outputs with it. What
leaves `output-*` windows alive with a manager that has never
heard of them is a reload of the control window's **page** —
a dev reload, a renderer the OS recycled, a webview crash the
app survived. The recovery is the same either way; only the
way to reach it differs, and smoke step 35 is wrong as
written.

**Detection.** Outputs detect their side via case 3 (IPC
silence). The manager detects its side by looking, because it
has nothing to detect *with* — an empty `records` map is
indistinguishable from a first launch.

**Recovery (manager side at boot).** `existingOutputs()`
wraps `getAllWebviewWindows()`, filtered by the `output-*`
grammar — the same predicate the capability glob encodes. For
each survivor:

- Match it to a persisted entry by label, and that entry's
  monitor to a live one. A record is registered **before**
  the poke, since the reply is an `output_ready` and
  `handleOutputEvent` drops one whose label has no record.
- Emit `OUTPUT_REATTACH_EVENT`. Within
  `OUTPUT_REATTACH_TIMEOUT_MS` the output re-announces, and
  the *existing* serve path sends its config and then a full
  snapshot — no second copy of that ordering.
- No answer: close it, `output_removed` with `crash`,
  `output_failure` with `ipc-silence`.

**Three things get closed rather than adopted**, and it is
one judgement three times: the manager will not put a row in
the panel it cannot describe truthfully. A label with no
persisted entry (nothing to build a record from, and no
`mode` to even report a removal with); a monitor no longer
enumerated (`monitor-gone`, the same rule the restore
applies); a window that does not answer.

**The poke exists because of `IPC_ORPHAN_MS`.** Inside 60 s a
disconnected output is still pinging, and a fresh manager
hears it the moment a record exists — no poke needed. Past
it the output has stopped talking by design, so nothing would
ever arrive again unless the manager spoke first.

**Ordering against the restore is load-bearing.** A survivor
holds its label and the restore spawns from the same
persisted entries by label, so a restore that ran first would
ask for a second `output-1` on a monitor that already has
one. The scan claims those labels into `records`; the restore
skips them. Unlike the restore it is **not** gated on the
operator's opt-in — that flag governs whether the manager
*spawns* windows, and a window already on a projector exists
regardless.

This makes a control-window reload non-destructive for the
LED-sphere audience: the imagery stays on screen and
refreshes once the page is back.

**Telemetry.** A reattached output reports
`output_failure { kind: 'ipc-silence', retries: 1,
recovered: true }` and **no** `output_added` — no window was
created, and counting a reload as new outputs would inflate
that metric every time a developer saves a file.

#### Summary

| Failure | Detection | Auto-recovery | Audience-visible? | Operator-visible? |
|---|---|---|---|---|
| Output crash | Window destroy w/o graceful close | None | Output goes black | Toast + log; can re-add manually |
| HLS stream error | `loadStream()` rejects (after `hlsService`'s own 3 retries) | One `destroy()` + fresh `loadStream` | Frozen last good frame throughout | Status badge; manual reload if the rebuild also fails |
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
- **One control-window Tier A telemetry event per failure**:
  `output_failure` with `{ kind, retries, recovered }` —
  fired via `src/analytics/emitter.ts`, **not** through
  `errorCapture.ts` (no stack trace, no free text, no
  sanitisation needed). Categorical fields only. Bounded
  retry attempts collapse into a single event. Output
  windows themselves emit nothing — matches §3.6
  capture-clean policy. See Open Question 3 (decided) for
  the full schema.
- **Unhandled errors** thrown inside the output window
  (a Three.js bug, a thrown promise rejection) hit the
  output's local console only — `errorCapture.ts` is not
  installed in output bundles. Operators debugging an
  installation issue use F12 on the affected output to
  read the console; aggregated installation health rolls
  up to the control window's `output_failure` events.

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

The zoom factor and the cap are as shipped. The *direction* is not:
the camera now points at the sphere's front, and a turn brings the
operator's centre there — see "Following the operator" below.

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

#### Following the operator: the centre comes to the front

**Status: landed with rung 16; supersedes the camera's direction in
the V1 mapping above.** The mapping aimed the camera at the
operator's centre wherever it lay, so the zoom magnified that place
*where it already was* on the sphere. The rotation offset turns
longitude only, so nothing could move latitude: a pole was only ever
magnified at the top or bottom of the sphere. A dome's audience does
not look there, an SOS sphere's top is seen at a glancing angle from
below, and on a projector rig with a polar mask (Boulder's) it may
be lit by nobody. The first projector-rig session found exactly
that: the control globe zoomed onto Antarctica, and none of P1–P4
showed it.

SOS answers this with its remote. Pitch, yaw and roll turn the globe
about a "user position" until the place of interest faces the
audience. Here the control globe is that remote. With **Track
operator camera** on, an output turns its content so the point the
control globe is centred on faces the sphere's **front**, with the
control globe's way up — MapLibre's bearing, which a right-drag or a
two-finger twist changes. The zoom then magnifies the front. Pitch is
not taken: it tilts a viewer, and a sphere is seen from every side.

The turn is one rotation matrix `M` applied to the ray-march's
landing point, after the march and before the texel:

```
hit = M · (o + t·dir)        // o, dir and t all in the sphere's frame
M   = B_centre · B_frontᵀ    // B = [position | up | right] at a point
```

`B_front` is the identity's own axes. The front is latitude 0 on the
meridian the rotation offset names, and its frame is
(`x` position, `y` north, `z` east). `B_centre` is the operator's
centre, with up as the compass direction `bearing` and right a
quarter-turn clockwise from it. Building it from frames rather than
angles leaves neither pole a special case. Both bases are the same
embedding's own (position, north, east), so `M` is a rotation by
construction. That matters because `latLonToDirection` is the mirror
image of a right-handed Earth, and a hand-written turn can silently
come out with determinant −1: every coastline backwards, plausibly
enough that nobody in the room is sure.

Three consequences are deliberate:

- **The camera offset lives in the sphere's frame** and points at the
  front, `cameraOffsetForCamera(0, 0, zoom)`. A pan changes only the
  turn, and the zoom can never magnify a place nobody is facing. The
  turn and the zoom come from one call, `followCamera`, because they
  are one invariant: the zoom must magnify the point the turn put at
  the front.
- **The rotation offset now says where the front is.** It is still
  the same uniform, applied the same way. With tracking off it puts
  the content's prime meridian at that meridian, as before. With
  tracking on it puts the operator's centre there. In both cases it
  says where on the physical sphere the content's reference point
  lands, so an installation's calibration means the same thing either
  way. Split puts the area of focus at exactly U = 0.25 and 0.75 (plus
  the offset), wherever the operator is, where it used to be true
  only at longitude 0.
- **The calibration pattern follows like a dataset** (step 41): it
  travels the dataset's path, the turn included. To set the front,
  centre the control globe on a pattern anchor — (0°, 0°), north up,
  is the natural one — and turn the rotation offset until that anchor
  faces the audience.

The default camera, (0°, 0°) at zoom 0 with bearing 0, derives to the
identity turn and a centred camera *exactly*, so a freshly booted
output still opens on the uniform unwrap. `projector-warp` takes the
same parameters, so the turn runs behind its meshes unchanged.

Verified on real WebGL (SwiftShader, the real `outputScene`) with
content whose every texel's colour encodes its own direction, so the
colour each output pixel should carry follows analytically from
`equirectSourceUv`. Five followed cameras were checked: Antarctica,
the control globe's default view with a 30° offset, a split frame
with the bearing at −120°, the north pole, and 45°S 179°W near the
zoom cap.

- On all five, the median error is 0.4/255 and the 99.9th percentile
  at most 1.2/255.
- The turn uploaded transposed puts the median at 183/255, and
  mirrored at 58/255.
- The warp, compared with the equirect frame under the same turn as
  the original harness compared them with none, covers the same
  195,374 px, with 0 lit where the mirror predicts nothing.

The outliers sit in a disc round each content pole that the turn
brings into the frame, where the fetch chose its mip level from a
longitude that spins a whole turn in a few pixels. That was not
introduced here: the old zoom-only path is worse, at 3,404 px off by
more than 2/255 against at most 1,198. It is the fetch's fault, not
the turn's, and is fixed with the dateline's hairline in rung 16's
convention 1, "The same at a pole".

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

3. **Kiosk-launch flag.** `--kiosk` CLI argument and an
   equivalent `TERRAVIZ_KIOSK=1` environment variable, parsed
   in **`src-tauri/src/lib.rs`** — not `main.rs`, which is now
   a 12-line shim (`fn main() { terraviz_lib::run() }`) with
   all builder and `setup()` logic moved into `lib.rs` so the
   mobile entry point can share it. Either path causes
   `setup()` to apply `set_fullscreen(true)` +
   `set_decorations(false)` on the main window before the
   first paint.

   The parse and the calls must sit behind `#[cfg(desktop)]`.
   `lib.rs` compiles into the iOS/Android cdylib as well, and
   neither argv flags nor a decorationless fullscreen toggle
   mean anything there — an ungated version would be dead
   weight at best and a build break at worst.

   Useful for unattended installations: drop a `.desktop`
   autostart entry and the app launches straight into the
   final state on boot. Exit via Cmd/Ctrl+Q (already wired)
   or by SIGTERM from the installation's process supervisor.

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
    monitorName: string       // OS-reported name; matched WITH monitorOrigin, never alone
    monitorOrigin: { x: number; y: number } // physical, SIGNED — see "Monitor geometry"
    mode: 'sos-equirect'      // future: 'fisheye' | 'mirrored' | …
    framebufferSize: { width: number; height: number } // e.g. 4096×2048
    trackOperatorCamera: boolean // default true; see §3.5
    split: boolean              // default false; see §3.5
    rotationOffsetDeg: number   // default 0; longitude offset for sphere alignment, see "Calibration"
    debugOverlay: boolean
  }>
  autoRestoreOnLaunch: boolean // default false; opt-in
  /**
   * This machine's decoder ceiling. Seeded from
   * DEFAULT_CONCURRENT_DECODERS and raised by the operator once
   * they have measured the machine — see "Cross-window decoder
   * budget". Machine-scoped rather than per-output, because it
   * is a property of the hardware, not of any one window; it is
   * therefore the one field here that must NOT be copied when a
   * config is moved between machines.
   */
  concurrentDecoderBudget: number
}
```

On launch, if `autoRestoreOnLaunch === true`, the manager waits
for the OS to report monitors (~50 ms after boot), tries to
match each persisted output to a current monitor on **both**
`monitorName` and `monitorOrigin`, and recreates the windows. If
no monitor matches on both — it is gone (laptop unplugged from a
kiosk dock), or only the name matches — the entry is logged and
the window is skipped, not silently moved to a different
monitor.

**Monitor names are less stable than that reads.** Windows
reports `\\.\DISPLAY1`, `\\.\DISPLAY2`, `\\.\DISPLAY3` — names that
are *positional*, assigned by the OS and reassignable across an
unplug/replug or a driver update. Matching on the name alone
can therefore restore an output onto a different physical
monitor while looking like it worked, which is the failure this
paragraph was written to avoid. `monitorOrigin` is stored
alongside the name so a restore can require **both** to agree,
and treat a name-only match as a monitor it does not recognise:
skip it, log it, and let the operator re-pick. Restoring the
wrong monitor silently is worse than restoring nothing.

Store the origin **signed** and as reported — physical pixels,
negative x included, exactly as `availableMonitors()` gave them.
A value that has been through a logical conversion cannot be
compared against a fresh `Monitor.position` on a HiDPI desk, and
per "Monitor geometry and placement" nothing in the placement
path needs the converted form anyway.

Restores are also **staggered, not simultaneous** — the one
cost the decoder-budget spike could actually measure was
startup contention. See "Cross-window decoder budget".

### Output capability spec

`src-tauri/capabilities/output.json` is a new capability file
scoped to the `output-*` window label glob. Its purpose is
defense in depth: even if the output window is compromised
(an XSS via a malicious dataset URL, a Three.js shader bug,
a webview vulnerability), the blast radius is bounded to
network fetch + minimal window controls. No filesystem,
no keychain, no Tauri commands, no ability to spawn more
windows.

**What this file does *not* do is restrain the manager.**
Tauri checks a cross-window command against the **caller's**
capability, not the target's (§6). So the permissions the
manager needs to spawn, close, and decorate `output-N` live
in `default.json`; the grants below cover only what the
output window invokes **on itself** — F11 fullscreen, its
own graceful close, IPC, and HTTPS fetch. Reading this file
as the security boundary for manager→output operations is a
mistake; it is the boundary for output→everything-else.

Full enumeration:

```json
{
  "$schema": "https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-utils/schema.json",
  "identifier": "output",
  "description": "Capability scoped to output-* windows. Narrowed for security: network fetch for streaming + minimal window controls + IPC listen/emit only. No filesystem, no keychain, no window creation, no shell, no updater, no localhost HTTP.",
  "platforms": ["macOS", "windows", "linux"],
  "windows": ["output-*"],
  "permissions": [
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "core:event:allow-emit",
    "core:event:allow-emit-to",

    "core:window:allow-current-monitor",
    "core:window:allow-is-decorated",
    "core:window:allow-is-fullscreen",
    "core:window:allow-set-fullscreen",
    "core:window:allow-set-decorations",
    "core:window:allow-close",

    {
      "identifier": "http:default",
      "allow": [
        { "url": "https://*" }
      ],
      "deny": [
        { "url": "http://localhost:*" },
        { "url": "http://127.0.0.1:*" }
      ]
    }
  ]
}
```

**What's allowed and why:**

| Permission | Why the output needs it |
|---|---|
| `core:event:allow-listen` / `unlisten` | Receive state diffs from the manager |
| `core:event:allow-emit` / `emit-to` | Send `output_ready`, `output_health_check`, `output_dataset_stalled`, `output_frame_stale`, `output_gpu_lost`, `output_gpu_recovered`, `output_closing` back to the manager — the whole `OutputEvent` union, kept complete here on purpose: the grant is not per-event, so this row is what anyone tightening it would read, and a half-list would silence the failure reports while keeping the recoveries |
| `core:window:allow-current-monitor` | Output reports its monitor identity at boot so the manager can match it to the persisted config |
| `core:window:allow-is-decorated` / `is-fullscreen` | F11 toggle reads current state to decide direction |
| `core:window:allow-set-fullscreen` / `set-decorations` | F11 toggle (per §3.6) writes new state |
| `core:window:allow-close` | Output participates in graceful shutdown — emits `output_closing` then closes itself |
| `http:default` with `https://*` | HLS manifest + segment fetch, image variant fetch from CDN/proxy origins |

**What's deliberately *excluded* and why:**

| Excluded | Reason |
|---|---|
| `core:default` | Excluded, but **it is not the boundary this table used to claim**. Tauri's ACL gates *plugin* commands (`plugin:window\|…`, `plugin:http\|…`) and app-defined `#[tauri::command]`s only when the app ships a permission manifest of its own — a `src-tauri/permissions/` directory or `AppManifest::commands` in `build.rs`. This app ships neither, so `has_app_acl_manifest` is false and `tauri::webview`'s gate (`plugin_command.is_some() \|\| has_app_acl_manifest \|\| !is_local`) never fires for a local caller. An output can therefore invoke `quit_app`, `keychain::get_api_key` and the download commands today. Pre-existing, unrelated to multi-monitor, and **open** — see *App commands are not ACL-gated* below. What excluding `core:default` does still buy is the plugin half: no asset protocol, no `plugin:fs`, no `plugin:updater`. |
| `core:window:default` | Not because it is dangerous — it is read-only (getters + monitor queries), so including it would be harmless. Excluded for reviewability: enumerating the four getters the output actually uses makes the intent auditable, and keeps a future Tauri release quietly widening the `default` bundle from widening this file with it. |
| `core:webview:allow-create-webview-window` | Output cannot spawn more windows. Only the manager (in the main window) creates output windows. |
| `updater:default` | Auto-update is a main-window concern — Tauri restarts the app on update, taking outputs down with it. |
| `core:fs:*`, `core:path:*` | Output streams from the network. No need to read local files — the bundled `output.html` is loaded from the asset protocol scope of the main bundle, not via fs APIs. |
| `core:shell:*`, `core:dialog:*`, `core:clipboard:*` | None apply to a render-only surface. |
| Asset protocol scope (`asset.localhost`) | Output doesn't need to load locally-cached datasets. The control window does (offline downloads → output via the asset protocol on the main window only). For an output window to render a downloaded dataset, the manager broadcasts the `asset.localhost` URL and the output fetches it via HTTP — denied by the explicit deny on localhost below. **Implication: offline downloads are control-window-only in v1; outputs require network.** Phase 5 polish if installations need it. |
| `http://localhost:*`, `http://127.0.0.1:*` | Explicit deny. The only legitimate localhost use case in `default.json` is local LLM servers (Ollama, LM Studio, llama.cpp), which the output never talks to. The deny is documentation-as-code for security review: outputs cannot phone home to anything on the operator's machine. |

**How an output closes itself.** `core:window:allow-destroy` is
**not** granted here, and getting to that took two tries worth
recording, because the first one shipped.

Registering `onCloseRequested` moves completion of the close out of
Rust and into JS: `@tauri-apps/api`'s helper awaits the handler and
then calls `destroy()` on the window unless the handler called
`preventDefault()`. That `destroy()` is ACL-checked against the
**output**, so granting `allow-close` alone made every output
unclosable — the manager's Remove, the operator's Alt+F4, all of it —
with the denial happening inside Tauri's own listener callback, where
nothing in this repo can observe it: `handle.close()` resolves
normally on the manager side and `discard()` goes on to drop the
record, so the panel row disappears and the window stays on the
projector. Task manager, or nothing. Found on hardware.

Granting `allow-destroy` fixed that and gave away more than it fixed.
Neither `close` nor `destroy` is scoped to the calling window —
`windows: ["output-*"]` restricts *callers*, not *targets* — so a
compromised output could tear down the control window or a sibling.
And `destroy` skips the target's own `onCloseRequested`, so no
`output_closing` is emitted, so `classifyDeparture` reads absence and
calls it a **crash**: three of those blocklist a working monitor for
the session, which makes "quietly disable the rig's displays one at a
time" a reachable outcome. Raised in review on the PR that shipped it.

What the output does instead is `preventDefault()` and invoke
`close_self`, an app command in `lib.rs` that destroys the window
Tauri hands it:

```rust
#[tauri::command]
fn close_self<R: tauri::Runtime>(window: tauri::Window<R>) { /* window.destroy() */ }
```

There is no target parameter to forge, so an output can only ever
destroy itself, and the generic grant comes back out of this file.
`acl_tests` in `lib.rs` pins both halves against the real capability
files through `tauri::test`'s `MockRuntime`: an `output-1` window can
invoke `close_self`, cannot invoke `plugin:window|destroy`, and the
control window has not lost it.

**Open: app commands are not ACL-gated.** `close_self` needs no
permission entry, and the reason is a hole rather than a convenience.
Tauri's ACL covers plugin commands; an app-defined
`#[tauri::command]` is checked only when the app ships a permission
manifest of its own — a `src-tauri/permissions/` directory, or
`AppManifest::commands` in `build.rs`. This app ships neither
(`build.rs` is a bare `tauri_build::build()`), so `has_app_acl_manifest`
is false and the gate in `tauri::webview`,

```rust
if (plugin_command.is_some() || has_app_acl_manifest || !is_local)
  && invoke.acl.is_none() { /* reject */ }
```

is false for every local caller. So an output window can invoke
`quit_app`, `keychain::get_api_key` / `set_api_key`, `get_tile` and the
eight download commands, today — the exposure that matters is the OS
keychain entry holding the LLM API key, and ending an installation
mid-show.

This predates multi-monitor and is not caused by it; what multi-monitor
added is a *second, less trusted* webview that inherits it. Closing it
means giving the app a manifest and then granting each command
explicitly — `default.json` gains the full set, `output.json` gains
`close_self` and nothing else. That is a change whose failure mode is
every command in the app silently refusing, so it wants a desktop run
rather than a build-green, and it is deliberately **not** bundled with
the fix above.

**IPC event direction.** The manager-→output direction uses
`emit_to('output-N', ...)` from the main window. The
output→manager direction uses `emit('output_event', ...)`
which the main window listens for. Both directions are
covered by the permissions above. The output **cannot**
emit-to another output window — doing so requires a window
label match against the capability's `windows: ["output-*"]`,
which only matches the emitter's own window or
broadcasts to all listeners. Inter-output IPC is not a
v1 requirement (per the failure-recovery non-goal "cross-
output coherence" — outputs sync independently to control).

**Existing Rust events fan out to every window.** Four call
sites use `AppHandle::emit`, which broadcasts to all webviews
rather than targeting one: `native_panic` (`lib.rs:121`),
`download-progress` (`download_manager.rs:291`),
`download-complete` (`download_manager.rs:321`), and
`download-error` (`download_commands.rs:69`). An output window
will receive all four. None is harmful — the output simply has
no listener registered for them — but it means the output's
event surface is wider than this capability file suggests, and
a future Rust-side event carrying sensitive payload would reach
outputs by default. Two consequences:

- The manager's own state sync must use `emitTo(label, …)`,
  not `emit(…)`, so the control window does not receive its
  own broadcasts back. `core:event:allow-emit-to` is already
  implied by `core:default` on the main window.
- Worth a follow-up (not v1-blocking) to narrow those four
  Rust sites to `emit_to("main", …)`, since all four are
  addressed to the control window in practice.

**Asset protocol scope on the main bundle is unchanged.**
The existing `tauri.conf.json` scope of `$APPDATA/**` and
`$APPLOCALDATA/**` for downloaded datasets stays — the
control window's `datasetLoader` continues to use it. The
output window doesn't have access to the asset protocol at
all (no `core:default`, no explicit scope grant), so any
attempt to load `asset.localhost/...` URLs from the output
fails closed.

**Security review checklist for `output.json` (PR-time):**

- [ ] No `core:default` (broad; would grant `invoke`)
- [ ] No `core:window:default` (read-only, but enumerate explicitly so a future widening of the bundle doesn't widen this file)
- [ ] No `*:allow-create-webview-window` (output cannot spawn windows)
- [ ] No `updater:*` (main-window concern)
- [ ] No `core:fs:*` / `core:path:*` (output streams from network only)
- [ ] No `core:shell:*` / `core:dialog:*` / `core:clipboard:*`
- [ ] HTTP allow is `https://*` only — no `http://*`, no localhost
- [ ] Localhost is in `deny`, not just absent from `allow`
- [ ] `windows: ["output-*"]` glob is exact — not `["*"]`
- [ ] Each event name in the protocol is symmetric: if the
      manager emits it, the output's listen call uses the same
      string; if the output emits it, the manager's listen
      uses the same string. No emit-without-listen wildcards.

### Calibration tooling

Commissioning an LED-sphere installation requires more than
"point output at monitor and hope." Two calibration
primitives ship in v1.

#### 1. Test pattern pseudo-dataset — **landed, and built differently**

**Two things below are superseded and struck through where
they appear: the shader implementation, and the sentinel
dataset id.** Both are recorded here rather than rewritten
away, so the reasoning is not re-derived from a summary.
What shipped is `src/output/calibrationPattern.ts`.

**It is a 2:1 canvas, not GLSL,** and the reason is what is
being calibrated rather than convenience. A pattern drawn
inside the fragment shader bypasses `layerStack`'s sampling
entirely — the bbox clipping, the `lonOrigin` shift,
`isFlippedInY`, the whole path a real dataset's pixels
travel — so it could land perfectly while the dataset path
was wrong, which is the one failure a calibration pattern
exists to rule out. Installed in an ordinary overlay slot
it travels that path exactly, so a pattern that lands right
proves a dataset will. Its geometry is pinned in tests
against `datasetProbe.latLonToTexelUv`, the canonical TS
mirror of the shader maths. The convenience is real too,
and the "~80 LOC GLSL" estimate below half-predicted it:
the pole letters, anchor names, longitude scale and
resolution readout are **glyphs**.

**It is a per-output switch on the render-config channel,
not a dataset,** which is the second correction. Calibration
is done one sphere at a time — a rig with four outputs is
four differently-mounted spheres — and `dataset` is *shared*
state, so a sentinel id would have put the pattern on every
output at once and replaced the control window's own globe,
which is where the operator is reading the rotation they are
turning. `OutputRenderConfig.calibration` is per-output and
last-write-wins, exactly like `debugOverlay` beside it.

It **replaces** the mirrored dataset rather than compositing
over it: a graticule on top of data leaves neither legible,
and what is being checked is geometry. The mirror is
untouched underneath — the decoder keeps running and keeps
being steered — so turning calibration off puts the dataset
back *in step* rather than reloading it.

Three details the section below does not cover, each of
which is a wrong answer avoided:

- **The southern colour bars are reversed.** Two identical
  bands are invariant under a vertical flip, which is the
  one orientation error this pattern most needs to expose.
  The N/S letters say it too; two independent statements of
  the same fact are cheap here.
- **The antimeridian is drawn at both edges** and gets its
  own third colour. An equirectangular image cuts that
  meridian in half and on a sphere the halves are the same
  mark — the join an operator is checking for a seam — and
  a seam artefact and a mis-set rotation look identical if
  both edges are painted like the grid.
- **The canvas is capped at 4096 whatever the framebuffer.**
  8192 is 134 MB of backing store plus as much again once
  uploaded, on hardware §3 already found can land silently
  on an iGPU, and it buys nothing: what is calibrated is
  *where* a line falls, and a bilinear-sampled 4096 pattern
  places every line within half a framebuffer pixel of its
  true position at 8192. The readout still names the
  framebuffer, which is the number the operator is
  confirming.

**The rotation value is deliberately not in the readout.**
It would make the pattern a function of a value that changes
continuously — the panel's slider commits on `input`, so one
drag is dozens of 4096×2048 redraws — and it is redundant
and worse than what is already there: the longitude scale
turns *with* the sphere, so the operator reads the rotation
off whichever label has reached the physical mark they are
aligning to.

**And it does not persist**, unlike every other operator
choice in the panel. The rule is that what you calibrate
persists and the act of calibrating does not:
`rotationOffsetDeg` is a property of the room,
`calibration` is a property of the afternoon. It is worth
separating from `debugOverlay`, which does persist — that is
an overlay *on* the content, so an installation restoring
with it on still shows its data, while this replaces the
content, and an installation restoring with it on shows
none.

The original design follows.

~~Selectable from the per-output config menu under a
"Calibration" submenu, alongside the regular dataset list.~~
**Not a fetched asset** — built locally so it works
identically on every output regardless of network state.

The pattern is a single multi-purpose target rendered into
the equirect framebuffer:

- **8-step grayscale ramp** along the equator (0 % to 100 %
  in 12.5 % increments) — for brightness / contrast / gamma
  calibration. Each step is a 22.5°-wide longitudinal band.
- **RGB color bars** at lat = ±30° — saturated red, green,
  blue, cyan, magenta, yellow at 100 % — for white-point
  and gamut spot-check.
- **Lat / lon graticule** at 30° intervals, with the equator
  and prime meridian rendered 2 px wide and color-coded
  (equator yellow, prime meridian cyan) for orientation.
- **Crosshair markers** at (0, 0), (±90, 0), (180, 0),
  (0, ±90) — eight named anchor points operators can
  reference when calling out alignment errors.
- **Label strings** at each pole reading "N" and "S" — for
  detecting a sphere wired upside-down.
- **Resolution counter** in the upper-right of the equirect
  frame: dynamically rendered text showing current
  `framebufferSize` (e.g. "4096 × 2048"). Shifts with
  framebuffer changes — confirms that the resolution
  picker actually applied.

Operator workflow: pick Calibration → Test Pattern. The
output replaces dataset content with the pattern. Track-
operator-camera + split + rotation offset all still apply,
so the operator can verify those primitives by zooming in
on the control globe and watching how the pattern
distributes across the LED sphere.

~~Implementation: `src/output/datasetMirror.ts` recognises a
sentinel dataset id (`__terraviz_calibration__`). When that
id arrives in a state diff, the mirror builds a procedural
texture in a Three.js `WebGLRenderTarget` driven by a single
fragment shader (~80 lines of GLSL).~~ **Superseded — see
the correction at the top of this section.** The sentinel id
survives as `CALIBRATION_OVERLAY.datasetId`, which is what
the debug HUD reports when the pattern is what is on the
glass; nothing routes on it. No `<video>`, no HLS, no
network, and the pattern still recomputes only when the
framebuffer rung changes.

#### 2. Per-output rotation offset — **landed**

LED spheres are physical objects. Some installations
mechanically rotate the sphere relative to canonical 0°
prime meridian — the sphere's "north pole pin" doesn't
align with celestial north, or the operator wants the
prime meridian to face the museum's main entrance.

`rotationOffsetDeg`: a per-output float in `[0, 360)` (in
the persisted config, see "Persistence") that's added to
every longitude lookup in the equirect RTT shader before
the camera-offset math runs. Operationally:

```glsl
// In equirectRtt.frag — after the split fold, before the ray-march.
float u   = uSplit ? fract(vUv.x * 2.0) : vUv.x;
float lon = (u - 0.5) * TWO_PI - uRotationOffsetRad;
// ...continue with the normal cameraOffset ray-march from lon, lat
```

**Two corrections to the snippet this replaces**, both found building
it:

- It rotated `uv.x` **before** the split fold. `foldSplitU` is periodic
  in U with period ½, so a 180° offset would have been a *no-op* — on
  exactly the installations most likely to be running split mode. The
  rotation goes on the longitude the fold produced, which turns both
  copies together.
- It ended `mod(lon + offset, TWO_PI)`. That is dead arithmetic: the
  only consumers are `cos` and `sin`, and the offset is bounded to one
  turn, so there is no range to normalise and no precision to protect.
  Dropped, so the GLSL and its TypeScript mirror stay one line each.

UI: a numeric input + slider in the per-output config menu,
labelled "Rotation offset (°)". 0.1° granularity. Defaults
to 0; persisted with the rest of the output config.

Operator workflow: load the test pattern. Note where the
prime meridian lands on the physical sphere. Adjust
`rotationOffsetDeg` until the prime meridian aligns with
the desired physical reference (e.g. the museum entrance).
Save. Once calibrated, leave it alone — it's a per-
installation constant, not per-session.

It is a per-output flag, not a globally-broadcast view field —
different outputs on different spheres need different
offsets — and that part shipped as designed.

**Where it shipped differs from this section in one way.**
The protocol carries `rotationOffsetRad`, not the
`view.rotationOffsetDeg` written above: `MirroredEquirectParams`
*is* `equirectRtt`'s `EquirectParams`, the object a narrowed
output hands straight to `setParams`, so degrees on the wire
would need a second conversion inside the output — free to
disagree with the first. Degrees live where the operator meets
them, in `OutputViewSettings` and the persisted config, and
`projectView` is the single conversion. That is the shape
`camera` → `cameraOffset` already had, and this section predates
the shared/mirrored view split that introduced it.

A stored value is **wrapped, not rejected**: 370° aims the sphere
exactly where 10° does, so discarding it would silently
un-calibrate an installation whose operator nudged past a full
turn. That is the opposite of the framebuffer rung's rule, and
deliberately so — a width off the ladder is meaningless, a
rotation past 360 is not.

### Tour engine interaction

Tours (`src/services/tourEngine.ts`) operate on the control
window's globe state — datasets, layouts, view, time. Each
tour task fires a callback that mutates control-window
state, which the state aggregator picks up and broadcasts to
outputs via the normal state-diff path. **Outputs require
no tour-aware code.**

Concretely:

- `setEnvView` swaps the multi-globe layout (1 / 2 / 4
  globes). The state aggregator detects the primary panel
  changing, broadcasts the new dataset / layers / view to
  outputs. The output's `datasetMirror` swaps texture; the
  layer stack rebuilds. ~1 s visible transition on the LED
  sphere.
- `unloadDatasetAt(slot)` clears a panel. If the cleared
  panel was primary, outputs receive a dataset-unload diff
  and revert to the photoreal Earth idle state.
- `loadDataset` with a `worldIndex` routes the load to a
  specific panel slot. If that slot is primary, outputs
  pick up the new dataset; if not, outputs are unaffected
  (panel routing in v1 is "follow primary" — see §5).

**No `setOutput` tour task in v1.** Tours don't directly
spawn / close / configure output windows. That's a Phase 4
feature gated on real demand from museum installations
that want choreographed multi-display sequences. Until
then, tours and outputs are decoupled by design — outputs
mirror the operator's primary panel, whether that panel
is being driven by the operator manually or by a tour.

**Rapid layout swaps.** If a tour fires `setEnvView`
multiple times within a few seconds (a "stress test" tour
for QA, or a poorly-authored tour), the manager's
broadcast debouncing (~30 ms) coalesces; outputs see the
final state, not every intermediate step. No flicker on
the LED sphere from tour churn.

### VR / AR coexistence

The output windows and the WebXR immersive mode (§ "VR / AR"
in CLAUDE.md) are independent paths. Both use Three.js but
in entirely separate scenes:

- **VR session** (`vrSession.ts`) creates a Three.js renderer
  on the control window's DOM, attached to `renderer.xr`.
  Lifecycle bound to the WebXR session.
- **Each output window** has its own DOM, own Three.js
  renderer, own scene built from `photorealEarth.ts`.

There's no shared GL context, no shared scene graph, no
event coupling. Three.js loads as a single lazy chunk that
both code paths reuse — bundle is unaffected.

If the operator enters VR while outputs are running:
outputs continue rendering on their own windows, the VR
session takes over the control window. MapLibre keeps
running too (per §VR architecture, "Two renderers, one
DOM"). All three paths run concurrently.

The shared-`<video>`-element trick from VR (see §1
constraint #4) does not extend to outputs. Each output
runs its own decoder (per §3 "Playback sync algorithm").
A future Phase 5 shared-GPU-texture path could unify all
three consumers, but it's not a v1 concern.

---

## MVP scope (v1, this branch)

What must work:

- **Tools → Outputs panel** with a monitor picker and an "Add
  output" button. One mode available: SOS Equirectangular.
- **Borderless fullscreen output windows** on user-chosen
  monitors. Multiple simultaneous outputs supported, each on a
  distinct monitor — so the practical v1 ceiling is however
  many monitors the workstation has, bounded by the decoder
  budget rather than by a constant of 4.
- **Equirectangular composite render.** Output runs a parallel
  Three.js renderer whose one fragment-shader pass composites
  `photorealEarth`'s base texture, the active dataset overlay
  and the layer stack straight into a 2:1 framebuffer at the
  configured resolution.
- **Multi-layer stack support.** When the operator stacks
  multiple datasets in the control window's primary panel,
  the output composites them in the same order. (v1
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
- **Decoder budget (machine-scoped).** A numeric field showing
  the current ceiling, seeded from `DEFAULT_CONCURRENT_DECODERS`,
  with the count in use beside it ("3 of 4 decoders"). Raising it
  is how an operator who has measured their machine stops being
  rationed at a constant sized for a phone; the field carries the
  debug overlay's steady-fps reading as the thing to watch while
  doing so. Persisted per machine, never exported with a config.
  See "Cross-window decoder budget".
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
| 2 | `multi-output: equirect RTT shader (unit tests + visual fixture)` | `src/output/equirectRtt.ts` and a tiny test page that loads a known sphere texture and verifies the shader produces the expected equirectangular pixels. Lands as a standalone module; not yet wired up. | No |
| 3 | `multi-output: output window entry + Three.js scene scaffold` | `src/output/main.ts`, `src/output/datasetMirror.ts`, `src/output/output.html`, `src/output/output.css`, Vite multi-entry config. Output bundle builds; loadable as a static page; renders a default photoreal Earth with no dataset, no IPC. **Start from `globeThumbnail.ts`'s scene-building path** rather than a fresh assembly — see "Prior art". | No |
| 4 | `multi-output: layer stack + dataset overlay` | `src/output/layerStack.ts`. Static fixture page can now load a fake dataset + fake layer stack and render it. The overlay path consumes a whole `DatasetOverlayOptions` (`lonOrigin` / `isFlippedInY` / `boundingBox` / `celestialBody` / `colorScale`) plus a `ColorScaleDisplay`, reusing `globeThumbnail.ts`'s handling rather than re-deriving the UV maths. Still no IPC. | No |
| 5 | `multi-output: Tauri capabilities for multi-window` | Two halves. **`capabilities/default.json`** gains `core:webview:allow-create-webview-window`, `core:window:allow-close`, `allow-destroy`, `allow-set-decorations`, `allow-show` — without these the manager cannot spawn, place, reveal or tear down an output at all (see §6). **`capabilities/output.json`** is new, scoped to `output-*`, granting only IPC + self-driven window controls + HTTPS fetch. `mobile.json` untouched. | No |
| 6 | `multi-output: state aggregator + protocol implementation` | `multiOutput/manager.ts`, `multiOutput/stateAggregator.ts`. Manager constructible but not yet instantiated. | No |
| 7 | `multi-output: emit dataset:loaded + layer events from main.ts` | Refactor of `datasetLoader` and `main.ts` to fire events the aggregator can subscribe to. Today's `panelStates` consumers keep working. | No |
| 8 | `multi-output: wire MultiOutputManager into main.ts boot` | Manager instantiated; subscribes to events. No UI to spawn windows yet, so still invisible. | No |
| 9 | `multi-output: add Tools → Outputs panel` | **Landed.** `outputUI.ts`, Tools menu entry. **First user-reachable commit.** Operator can add and remove SOS equirectangular outputs, and set each one's "Track operator camera" / "Split sphere". Mode is *shown*, not picked — v1 has one, and a one-option select is dead UI. The occupied-monitor guard lives in the panel because `addOutput` accepts any index; it keys on name **and** signed origin so rung 10's restore matching reuses the same identity. `manager.start()` is called on the first add and awaited before the spawn (the output emits `output_ready` as it boots), and never stopped on removal. Deferred to their own rungs: rename and persistence (10), framebuffer resolution / decoder budget / debug overlay (11), health badges and reacting to an output the operator closed by hand (13). | **Yes** |
| 10 | `multi-output: persist + restore outputs across launches` | **Landed.** `outputPersistence.ts` (versioned localStorage config, fail-closed parse, the match rule), `manager.restoreOutputs()`, boot wiring, and the panel's opt-in checkbox. Monitor matching is on **both** name and signed physical origin — a name-only match is a monitor the manager does not recognise, skipped and logged, because Windows display names are positional and reassignable (see §3 "Persistence"). Restore is per-output-fail-safe (a gone monitor or a refused window loses one output, not the set), paced by `OUTPUT_RESTORE_STAGGER_MS` between spawns, starts the IPC link before the first one, reuses persisted labels and advances the counter past them, then rewrites the config with what actually came up. Two departures from the schema above: a `version` field, because without one a future incompatible change cannot tell an old blob from a corrupt one and this blob spawns windows; and `framebufferSize` / `rotationOffsetDeg` / `debugOverlay` / `concurrentDecoderBudget` are **absent** until the rungs that read them (11, 14) — inventing defaults now would guess at what those rungs want. | Yes (additive) |
| 10.5 | `multi-output: the output's receive side` | **Landed, and it was missing from this ladder.** Rung 3 says "no IPC", rung 4 says "still no IPC", and rungs 5-15 never assign it — so every rung from 5 to 10 built the control window's half of a link whose other end did not exist. No output emitted `output_ready`, `readyRecords()` was empty on every real launch, and an operator who added an output got a window showing a static Earth with nothing to say why. Four pieces: `MirroredDataset` gains `startTime` / `endTime`, without which `computeSiblingSyncCorrection` cannot place a date (`primary.rangeMs` gives the span's length, not its start); `stateEquality.ts` extracts `sameValue` so both ends answer "did this change?" identically, because the idle heartbeat sends a **full snapshot every second** and an output that read one as "everything changed" would rebuild its HLS instance once a second; `outputLink.ts` announces the window and folds messages (a diff applies only if newer, a snapshot applies always — gating snapshots on `seq` breaks the heartbeat resync silently and a manager restart permanently); `outputSync.ts` runs the *same* control law a sibling globe does, with `SIBLING_*` imported rather than restated; `datasetMirror.ts` owns the element, reloading only when `url`/`kind` differ (an overlay change is a palette, not a decoder), swapping load-then-dispose so a projector never flashes black, and generation-guarding so a slow load cannot win. And `outputScene` composites it: the material is rebuilt only when the slot *count* changes (GLSL ES 1.00 has no dynamic sampler indexing, so the shader text is a function of the count), across the **same** uniforms object so the operator's camera survives a rebuild, reusing a slot's map texture when the element is unchanged and disposing the slots that go away. The composite is built from the **mirror** rather than the link, so an incoming dataset's bbox and palette are never drawn over the outgoing dataset's pixels during a load. | Yes |
| 11 | `multi-output: per-output debug overlay + framebuffer + decoder-budget controls` | **Split into three commits**, because the three controls it names share only a panel section: the config channel and the HUD (11a), the resolution picker (11b), and the decoder budget (11c). Together: resolution picker in panel, the machine-scoped **decoder-budget field** (seeded from `DEFAULT_CONCURRENT_DECODERS`, persisted, shown as "N of M decoders") that makes the per-machine budget in §3 actually settable — without it the budget is a constant wearing a different name — debug HUD with dataset id, sync delta, fps, and the WebGL **renderer string** — the last so an operator can see which GPU the webview actually got, which on a hybrid-graphics machine is decided by the driver rather than by the app (see Risks). | Yes (additive) |
| 11a | `multi-output: output render config channel + debug overlay` | **Landed.** `src/output/debugOverlay.ts` (the HUD), `OutputRenderConfig` + `OUTPUT_RENDER_CONFIG_EVENT` in `protocol.ts`, the output's `onRenderConfig` half, `manager.setOutputRenderConfig`, two more persisted fields, and the panel's "Debug overlay" switch. The channel is **separate from state** and carries no `seq`: a framebuffer size and a debug flag are last-write-wins window settings, and folding them into `GlobeState` would pay coalescing and sequencing for values that need neither, inside a type whose whole point is that it describes one globe. The config is sent **before** the first snapshot on `output_ready`, so a restored 8K output does not render at the default and then reallocate. The HUD is five fields (dataset, signed sync delta in ms, fps, framebuffer, renderer string), refreshed on its own ~2 Hz timer rather than from the render loop — which drops to 1 Hz for static content and would freeze the fps readout exactly when someone asks why nothing is moving. Persistence gained `framebufferWidth` / `debugOverlay` **without** a version bump, both defaulted when absent, so an existing config restores unchanged. `framebufferWidth` travels and applies end-to-end here; only its *picker* waits for 11b. | Yes (additive) |
| 11b | `multi-output: framebuffer resolution picker` | **Landed.** The per-output picker in the Outputs panel, over the ladder 11a already carried end to end. Called **Framebuffer**, never Resolution — the row's head line already shows the monitor's own pixel count, so the two read one above the other and step 24's "the picker changes the framebuffer, never the window" needs no explaining. The whole ladder is offered rather than the rungs at or below the monitor, because 1024 (preview a sphere on a desk monitor) and 8192 (drive a sphere from a 1080p preview window) are the two cases it is most for. The ladder reaches the panel through `manager.framebufferWidths()` rather than an import: `outputUI` is eagerly loaded by `main.ts`, so a runtime `multiOutput/` import there would put the IPC contract back into the web entry graph. A persisted width is narrowed to a real rung on parse, so the picker and the window can never be showing two different numbers. | Yes (additive) |
| 11c | `multi-output: machine-scoped decoder budget` | **Landed.** `PersistedOutputConfig.concurrentDecoderBudget` (machine-scoped, `null` = "nobody has measured this machine, ask it"), `manager.decoderBudget()` / `setDecoderBudget()` / `decoderLoad()`, the refusal inside `spawn()` — so a restore is held to the same rule as an Add — and the panel's number field, "N of M video decoders in use" readout, and disabled Add with a message naming what to close. The count is **windows that can hold a decoder**, not decoders currently decoding; see the revised "Counted" row above for why, since it departs from what this section originally said. The control window's contribution reaches the manager through an injected `controlPanels()` — `main.ts` owns both `viewportManager` and `bootMultiOutput`, and neither of those should learn what the other is. Unset falls back to `maxVideoPanels()` rather than storing it, so an unpinned budget keeps tracking the machine. **Still not enforced at layout change** (plan: "at both spawn time and layout change") — a control window that grows from 1 globe to 4 while outputs are up can still cross the budget. That needs `viewportManager` to consult the manager, which is a cross-cutting change and its own commit. | Yes (additive) |
| 12a | `multi-output: window chrome — fullscreen, decorations, F11, idle cursor` | **Landed.** `src/services/windowChrome.ts` (shared by both windows), the F11 handler, the idle-cursor rule in `base.css`, and the upgrade of the Tools bar's existing fullscreen button. Two findings worth recording. First, §3.6 mechanism 2 was **already half-built**: a fullscreen button has shipped since §3.3, driving `document.requestFullscreen` directly — which is the whole answer in a browser and half of it in a packaged app, since it fullscreens the *webview* while leaving the native title bar and border in the captured signal. The button was upgraded rather than joined by a second one. Second, that same button read its label off `document.fullscreenElement`, which stays **null** when the native window goes fullscreen — so on desktop it would have offered "Enter fullscreen" over a window already in it, and F11 changes the state without `fullscreenchange` firing at all; the controller is now what it reads. Fullscreen and decorations are one operation because `setFullscreen(true)` alone leaves the title bar on some window managers and removes it on others, and decorations follow rather than lead so a failed fullscreen cannot strand an operator with an unmovable undecorated window. The desktop host is built **synchronously** and imports Tauri on first use, because the Tools menu reads the state while laying out its markup. F11 on an output passes `initial: true` and persists nothing — an output is fullscreen by construction and a title bar borrowed for calibration must not come back next launch. | Yes (additive) |
| 12b | `multi-output: kiosk launch flag` | **Landed.** `--kiosk` and `TERRAVIZ_KIOSK=1` parsed in `src-tauri/src/lib.rs` (`main.rs` was already the 12-line shim this section predicted), applied in `setup()` behind `#[cfg(desktop)]`. "Before first paint" is **best-effort**, not guaranteed: `setup()` is the earliest point an `AppHandle` exists, and the static alternative in `tauri.conf.json` cannot be conditional on a flag. `TERRAVIZ_KIOSK=0` and an empty value mean *off* — a deployment templating one unit file across several machines sets the variable explicitly to disable kiosk, so the value is matched against an allowlist rather than tested for presence. The flag beats a falsy environment, since an operator adding it to one launch is deciding now while the environment is the installation's default. Decorations drop only after fullscreen succeeds, and every failure is logged and swallowed. One thing this rung had to add on the **TypeScript** side: the kiosk flag makes the native window fullscreen without the JS controller knowing, so `WindowChromeHost` gained an async `queryFullscreen()` seeded once at construction — without it the Tools button offers "Enter fullscreen" over a kiosk window and the first press is a no-op. That needs `core:window:allow-is-fullscreen`, added to `default.json` (`output.json` already had it). | Yes (additive) |
| 12c | `multi-output: the Earth decoration the equirect path can carry` | The three effects §"What the equirect path does to the Earth decoration" says **cross** — day/night terminator, night lights, clouds — wired into `layerStack`'s fragment shader. **Landed.** Specified here first, then built exactly as specified, which is why the first hardware session's flat diffuse Earth is now day/night-shaded with city lights and cloud cover. Not a research question: the terminator is `dot(hit, uSunDir)` (the ray-march's hit point on the unit sphere *is* the normal), night lights are a second sampler gated by it, clouds are one more layer in a composite that already unrolls slots. The sun direction comes from `getSunPosition` in `src/utils/time.ts`, which the control globe already uses, so the two cannot disagree about where the sun is. **The four that do not cross stay out** — specular, atmosphere *shells*, ground shadow, sun sprite are not deferred, they are incoherent on this surface, and baking one in paints a fixed glare spot or limb ring onto a physical sphere in a place correct from exactly one vantage point. That is a rendering artifact that reads as a data feature, which is worse than its absence. So "as realistic as possible" on a sphere **is** diffuse + night lights + clouds + terminator; this rung is the whole of it. **Amended after this rung shipped:** the atmosphere's *shell* stays out for the reason above, but its **disc tint** was later found to cross — pinned to nadir the scattering integral is a function of sun angle alone, with no silhouette to be wrong about. That is what made the output's ocean black beside a blue one. It is not a fifth effect sneaking back in; it is the sharper test (what does this become at nadir?) applied to a row this table got half right. | Yes (additive) |
| 13 | `multi-output: failure recovery — crashes, stalls, GPU loss, monitor unplug` | Manager gains crash detection (no-graceful-close window destroy → toast + record removal), 3-strikes-per-monitor crash storm guard, 2 s `availableMonitors()` poll for unplug detection, `getAll()` boot scan to reattach orphaned `output-*` windows after a control-window **page reload or webview failure** — not a crash of the process, which takes every window with it; see case 6, which corrects this. Output gains `webglcontextlost` / `webglcontextrestored` listeners with full scene rebuild, IPC-silence watchdog (5 s → stale state, 60 s → orphan), one HLS stream rebuild on a `loadStream()` rejection with frozen last-good-frame (no retry ladder — `hlsService` already spends a 3× budget before rejecting). Outputs panel renders per-output health badges (healthy / stale / stalled / monitor-missing). New Tier A `output_failure` event fired from manager via `analytics/emitter.ts` with `{ kind, retries, recovered }` (Open Question 3 decided). See §3 "Failure recovery". **Landed so far: 13a** (crash-vs-hand-close classification, the storm guard, record removal, `onOutputsChanged` for the panel), **13b** (all three Tier A events, `outputTelemetry.ts`), **case 3** (the output's `linkWatchdog`, the manager's `output_health_check` resync, the panel's stale badge and its announcement) and **case 6** (`adoptOrphanedOutputs`, `OUTPUT_REATTACH_EVENT`, chained ahead of the restore at boot) and **case 5's detection and reporting** (`outputScene.gpuState()`, `output_gpu_lost` / `output_gpu_recovered`, the `gpu-lost` badge and the `gpu-loss` Tier A failure — much smaller than this row implied, because Three's `WebGLRenderer` already does the `preventDefault()` and the GL rebuild; see case 5). Still open: the unplug poll, the single HLS rebuild, case 5's 30 s no-restore timeout and its `gpu-loss-timeout` removal, the toast (no toast primitive exists), and the `perf_sample` extension (needs an `OutputEvent` arm carrying drift — see Open Question 3). | Yes (additive) |
| 14 | `multi-output: calibration tooling — test pattern + rotation offset` | `src/output/datasetMirror.ts` recognises the `__terraviz_calibration__` sentinel id and renders a procedural test pattern (8-step grayscale ramp at the equator, RGB color bars at lat ±30°, lat/lon graticule with color-coded equator + prime meridian, named anchor crosshairs, N/S pole labels, live resolution counter — ~80 LOC GLSL). `src/output/equirectRtt.ts` adds the `uRotationOffsetRad` longitude rotation applied before the camera-offset ray-march. `outputUI.ts` adds the per-output "Rotation offset (°)" numeric + slider and a "Calibration" submenu. Persisted config gains `rotationOffsetDeg`. See §3 "Calibration tooling". **Landed, in two slices, and the second is built differently from this row.** **14a** is the rotation offset end to end: `uRotationOffsetRad` and its TS mirror, `rotationOffsetDeg` through `OutputViewSettings` and the persisted config, the degrees→radians conversion in `projectView`, and the panel's slider-plus-number. **14b** is the test pattern, as `src/output/calibrationPattern.ts` — a **2:1 canvas installed in an ordinary overlay slot**, not the ~80 LOC of GLSL this row specifies, and a **per-output switch on the render-config channel**, not the `__terraviz_calibration__` sentinel dataset. Both departures are argued at the top of §3 "Calibration tooling": a shader pattern would bypass the very sampling path it is meant to prove, and a sentinel dataset would put the pattern on every output at once — plus on the control window's own globe, which is where the operator is reading the rotation they are turning. There is no "Calibration submenu"; it is one toggle sitting directly above the rotation control it is used with. The pattern is the one operator choice in the panel that deliberately does **not** persist. | Yes (additive) |
| 15 | `multi-output: operator runbook` | **Landed** — [`docs/MULTI_MONITOR_OPERATIONS.md`](MULTI_MONITOR_OPERATIONS.md), the deployment half this plan had deferred, and which a spike showed is not optional. It covers everything below and four things the ladder could not have predicted, all of them from hardware and all of them **silent** failures: the **gpu** field being unreadable on Linux (so §1.1's check moves outside the app, on the platform SOS installations most often run), the output monitor's **refresh rate** as a hard ceiling on its frame rate with a dock as the usual cause, and two Linux package prerequisites — GStreamer codecs, without which no HLS dataset plays, and fonts in two classes, without which every control renders as an empty box. Originally scoped as: Covers: **checking which GPU the webview actually got** (the renderer string surfaced by commit 11's debug overlay) and the per-OS override for a hybrid-graphics machine, since the app's own `powerPreference` is inert and a silent landing on the iGPU is undiagnosable from logs; **measuring this machine's decoder budget** rather than trusting a constant, and entering it in the Outputs panel's budget field (commit 11); disabling screen savers and display sleep (Open Question 5's documented half); the kiosk autostart entry from §3.6; and what each Outputs-panel health badge means in front of an audience. No code. | **Yes** (docs) |
| 16 | `multi-output: projector-warp mode (sphere-sim warp import)` | **In progress** — the pure module landed 2026-09-29 (`src/output/projectorWarp.ts`: fail-closed parse, geometry build, blend, SOS's quadrant table, the whole-set check, and a parity fixture from sphere-sim's own tracer), and the import with it (`storedZip`, `warpImport`: a store-only ZIP reader that takes only the root's `warp/<id>.data`, since a bundle's restore point keeps the previous calibration under the same name), `projector-warp` as an `OutputMode` through protocol, aggregator, persistence and the spawn URL, and the set on the render-config channel with a key of its own per set (`warpStorage`, deleted only when the operator lets go of it), the scene that draws it — verified against the TypeScript mirror on SwiftShader — the panel's import, layout question, blend gamma and content-rotation label, and the runbook's section on spanning and importing (`MULTI_MONITOR_OPERATIONS.md` §3.6); a hardware pass on a sphere remains. Specified in §"Rung 16 — a sphere-sim warp bundle on one output", which opens roadmap Phase 3's sphere half now that its demand gate is met. One output on the spanned display carries a sphere-sim bundle's Bourke meshes, each placed in its viewport of the one framebuffer and drawn in one pass, so the projectors share one decoder and one swap and cannot drift apart at the seams. A new `projector-warp` mode rather than a flag, so a build without this rung refuses to spawn one instead of throwing an unwarped equirect across calibrated projectors. The ray-march runs per fragment — no render target, no second resample — at a unit direction the mesh interpolates in place of `(u, v)`, which takes the texture seam and the poles without a special case and, measured against sphere-sim's own tracer, matches `(u, v)` interpolation wherever that works. Three conventions that fail silently were measured against sphere-sim's own export and are specified there: the seam and the poles, a linear-light blend weight arriving at a display-space renderer, and a sphere rig's rotation already baked into the mesh, which is why rung 14a's offset becomes a content rotation under a warp and is never seeded from the rig. Not SOS-specific: any rig sphere-sim calibrates arrives in the same shape, on the sphere or on any surface unwrapped equirectangularly — a dome, an ellipsoid; only a model whose UV set is an atlas is out, and so is a mesh addressing a fisheye frame, which no file can tell from an equirect one: refused where a layout declares it, asked about where nothing does (§"Which surfaces", corrected 2026-10-02, which also records that a dome's audience, sitting inside it, sees the picture mirrored). A mesh is never placed by its projector id alone, because sphere-sim's placed rigs reuse SOS's ids in other places: the layout comes from the bundle, or from the operator explicitly choosing SOS's quadrants, or the import refuses. So an SOS rig was unblocked upstream from the start, and any other rig needed [zyra-project/sphere-sim#49](https://github.com/zyra-project/sphere-sim/issues/49) (the layout in the bundle). sphere-sim#52 answered it on 2026-09-29, and this build reads its `layout.json` — so a placed rig imports by its own layout once sphere-sim's page exports one. [zyra-project/sphere-sim#50](https://github.com/zyra-project/sphere-sim/issues/50) (the blend convention stated in `warp.ts`) is still open and makes every rig safer. | Yes (additive) |

**Backout plan.** Reverting commit 9 leaves all the plumbing in
place (manager, output bundle, capability) but removes the
operator's ability to spawn windows. Control window behaviour
is unchanged from pre-feature. Reverting commit 8 alone removes
the manager's only caller: `main.ts` loses one import, one field,
one call and one `dispose()` line, and `bootMultiOutput.ts`
disappears with nothing else referencing it. A full 6-8 revert
has one more step than this paragraph originally claimed — it
must also remove rung 7's publish calls, because `main.ts` now
imports `globeStateEvents` and `mirrorState` and calls
`publishMirroredDataset()` from three sites. The rest still
type-checks. Reverting
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
state-mirroring path (commits 1–12) keeps working. Reverting
commit 14 takes calibration off the table — operators
commissioning a new LED sphere lose the test-pattern
calibration aid and the per-installation rotation offset
goes unread by the shader. The persisted `rotationOffsetDeg`
field stays in localStorage as inert data; if commit 14
lands again later, existing values are picked up
automatically. The basic state-mirroring path is unaffected.

**Acceptance for each commit:**

- `npm run type-check` passes. **This is no longer just `tsc`** —
  it chains eight repo gates before the four compiler passes:

  ```
  locales → check:i18n-strings → check:migrations
  → check:doc-coverage → check:css-logical → check:tick-drain
  → check:license → check:protocol-schemas → 4× tsc
  ```

  Four of those bind directly on this feature and are easy to
  trip late:

  | Gate | What it means here |
  |---|---|
  | `check:i18n-strings` | Gates `src/ui/` for hard-coded user-facing text. Every string in the Outputs panel — the health badges, "Rotation offset (°)", the crash / monitor-disconnect toasts, the close prompt — must route through `t()` with locale entries added in the same commit. This plan was written with no i18n awareness; treat every quoted UI string in it as pseudocode. |
  | `check:doc-coverage` | Every module under `src/` must appear in CLAUDE.md by full repo-relative path. Because the output bundle now lives at `src/output/…` (§7), each commit that adds a module must add its CLAUDE.md row in the *same* commit or CI goes red. |
  | `check:license` | SPDX + copyright header required on every `.ts`, `.rs`, `.css`, `.html`, `.js`, matched positionally. So `src/output/output.html`, `output.css`, and every new `.ts` need one. `capabilities/output.json` does not — `.json` is exempt. |
  | `check:css-logical` | Bans physical inline-axis properties. `output.css` must use logical properties (`inline-start`, `block-end`, …). |

  `check:tick-drain` additionally bans turn-counting waits in
  tests — the async tests below must use `until()` from
  `src/test-utils.ts` rather than fixed tick counts.

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
- For commits 9, 10, 11, 12, and 13, run the manual
  qualification steps from **Appendix B: smoke-test
  checklist** end-to-end on the dual-monitor Linux
  workstation. Acceptance gate per commit is the section
  bearing that commit's number; subsequent commits inherit
  the prior commit's coverage and add their own steps.

---

## Driving other display geometries

**Status: study, no code. Written after rung 10 shipped, and after
reading the sister project.** Nothing here changes v1, and none of it
is scheduled — Phases 2 and 3 below are where it would land, and both
are amended against it.

The question this answers is one a reader of the delivery ladder will
have: **is equirectangular assumed?** Partly. It is worth being precise
about which layers assume it, because the answer decides how much any
other geometry costs.

| Layer | Equirect-specific? |
|---|---|
| `protocol.ts` — `MirroredGlobeState` | **No.** Dataset, playback, palette, layers, date: what the globe *shows*, not how it is projected. `OutputMode` is already a field on `OutputReadyEvent` |
| `manager.ts` | **No.** Stores `mode`, persists it, passes it to `spawn()`, never branches on it. Every output gets the same `output.html` |
| `outputPersistence.ts` | **No**, beyond refusing an unrecognised `mode` — deliberately, so a newer build's mode is not spawned as an equirect |
| `outputUI.ts` | **No.** The mode picker is absent only because a one-option select is dead UI |
| `layerStack.ts` | **No.** Composites base Earth + overlay + layers to a colour at a surface point. Projection-independent |
| `outputScene.ts` + `equirectRtt.ts` | **Yes, hard-wired.** Unconditional 2:1 framebuffer, fullscreen quad, ray-march. The scene never reads `mode` — it *reports* one and nothing routes on it inbound |
| `output.css` — how the frame reaches the monitor | **Yes, by consequence.** The drawing buffer is 2:1; the window is whatever the display is. `object-fit: contain` reconciles them by letterboxing, which is a decision rather than a formatting detail — see the next subsection |

So `OutputMode` is a real extension point that is plumbed everywhere
except the renderer. The seam is already in the right place:
`equirectRtt` answers "which surface point is this pixel", `layerStack`
answers "what colour is that point". Another geometry replaces the
first and keeps the second.

### Not every monitor is 2:1, and today every framebuffer is

The frame and the monitor are two different rectangles, and everything
above names only one of them.

**What v1 actually does.** `resolveFramebufferSize` has exactly one
caller, and that caller passes nothing — `options.framebufferWidth` is
never supplied, so every output allocates 4096×2048 regardless of the
display it landed on. Nothing anywhere reads `Monitor.size`. That
buffer is then presented into a fullscreen window of the monitor's own
aspect by `output.css`'s `object-fit: contain`, which letterboxes: on a
16:9 output the signal carries a 1920×960 image with 60 rows of black
above it and 60 below.

**`contain` is the right default and the wrong thing to leave
unexamined.** It is correct for a preview on a desk monitor, and
correct for any downstream device that expects a 2:1 image *inside* a
frame and finds its own edges. It is wrong for a device that expects
the whole signal to **be** the equirect: there the bars are not
padding, and every latitude sits 1.125× closer to the equator than the
device places it. That error is smooth, symmetric and largest at the
poles — on a sphere it reads as the map being slightly off rather than
as a scaling bug, which is the same failure shape as the bottom-left
origin below. Which behaviour an SOS driver, a warping appliance or a
projector's own geometry engine has is not known here, and rung 9's
smoke checklist is the first thing that could find out.

Three ways out, and they are not interchangeable: letterbox (today),
stretch to the monitor, or size the drawing buffer to the monitor's own
pixel count. The third is unavailable *in this mode* — an
equirectangular frame that is not 2:1 is not equirectangular, which is
why `FRAMEBUFFER_WIDTHS` derives height instead of offering it. The
choice between the first two belongs to the output, not to the CSS, and
is therefore a per-output setting nobody has written yet.

**What that constrains for rung 11.** Its resolution picker is framed
as one ladder. It should be **per mode**: 2:1 rungs are a property of
this projection, not of outputs in general. Rung 11 is also the first
thing with a reason to read the monitor's size at all — the
snap-**down** rule exists precisely for a caller that passes hardware's
own number, and that caller has never existed.

### Geometry is a per-output configuration, not an enum value

> **Confirmed by the first hardware session (three monitors,
> 2026-09).** The operator who owns the deployment named the
> four-projector SOS system as a real target, not a hypothetical: each
> projector takes a *slice* of the sphere, so its framebuffer is not
> 2:1 and its content is not an equirectangular frame. That is the case
> this section was written against — "a warp mesh measured against four
> projectors in one room" — so nothing below changes. What changes is
> its status: the mode-plus-geometry-reference shape is now load-bearing
> for a named deployment rather than insurance against one.
>
> Two things follow for whoever builds it. **The framebuffer ladder is
> `sos-equirect`'s, not the app's.** `FRAMEBUFFER_WIDTHS` keeps height
> at exactly half the width because an equirectangular frame that is not
> 2:1 is not equirectangular; a slice mode brings its own rungs, matched
> to a projector's native resolution, rather than widening these (see
> §"Not every monitor is 2:1" and smoke step 24a). ~~**And the four
> projectors are four outputs, not one.**~~ Each needs its own geometry
> payload — position on the sphere, lens warp, edge-blend zones — which
> is per-output configuration the manager already spawns and persists
> per output; what does not exist is the payload's schema or the
> calibration UI that produces it. Rung 14 is where that starts.
>
> **Superseded by rung 16 (2026-09-26).** The four projectors are *one*
> output carrying four meshes. The struck sentence was inferred from
> the shape rungs 9-10 built; sphere-sim's PARAMETERS.md §3.4 — the
> source this chapter cites — gives SOS as one framebuffer split 2×2,
> and four windows would put their drift on the seams. Each projector
> still needs its own payload, as above, but as a viewport and a mesh
> inside one output's configuration; a Bourke mesh carries position,
> lens warp and blend in one file. The payload's schema is rung 16's.

`OutputMode` being a one-value union makes "widen the enum" look like
the whole extension story. For the flat case below, it is. For
projection mapping it is not, and the distinction is cheaper to make
now than after a second value exists.

A **mode** is something the build knows: `sos-equirect`, or a
hypothetical `flat-perspective`, are shaders this repo ships. A
**projection mapping** is something the *site* knows — a warp mesh
measured against four projectors in one room, a normalized viewport
rect into a shared framebuffer, an arbitrary model's UV layout. That is
a payload an operator supplies, not a variant a `switch` enumerates. So
the shape that survives contact with an installation is `mode` plus an
optional geometry *reference*, and both rules already in the code keep
working unchanged:

- rung 10's fail-closed parse still refuses a `mode` it does not
  recognise, so a downgraded build declines to spawn rather than
  putting a plain equirect on a projector that was calibrated for a
  warp;
- the mesh stays out of `localStorage`, per the typed-array finding
  below — the persisted config holds a path, not a blob. *Narrowed by
  rung 16* to the subject it was written about: sphere-sim's 5–40 MB
  **surface** mesh. A Bourke **warp** mesh is ~80 KB of text, and a
  path to one is something a webview can neither learn nor later read,
  so rung 16 keeps an app-owned copy under its own `localStorage` key
  and the persisted config holds a reference to that copy.

**`MirroredView` was mode-specific without saying so, and is now a
union keyed on `OutputMode` — and the shared view is mode-free.**
`cameraOffset` is bounded by `MAX_CAMERA_OFFSET` because the camera
must stay inside the sphere; `split` folds U across an equirectangular
frame. Both were flat fields beside `dayNight`, which *is*
projection-independent, and all three went to every output with nothing
in the type marking two of them conditional.

There are now two view types, because the control window and an output
genuinely hold different things:

| | Holds | Shape |
|---|---|---|
| `SharedView` | one globe's facts | `{ dayNight, camera: OperatorCamera }` |
| `MirroredView` | one output's geometry | `{ mode, dayNight, params }`, one arm per `OutputMode` |

`OperatorCamera` is MapLibre's own lat/lon/zoom, unconverted, and that
is what makes no geometry privileged: `sos-equirect` turns those three
numbers into a ray-march origin, a perspective mode would turn the same
three into an eye position and a field of view, a warped rig would feed
them to a mesh. Storing `sos-equirect`'s `cameraOffset` as the shared
value worked and was briefly what shipped, but it made one geometry's
encoding the thing every other geometry had to derive *through* — and
that encoding is lossy at the top of its range, since `MAX_CAMERA_OFFSET`
clamps it, so a zoom past the cap is not recoverable from it at all.

Each arm's payload is `params`, uniformly, because that is what the
arm's renderer takes. `sos-equirect`'s is `MirroredEquirectParams`,
declared structurally identical to `equirectRtt`'s own `EquirectParams`
— what `outputScene.setParams` already accepts — so a narrowed output
hands `view.params` to the shader with no adapter, and
`protocol.test.ts` holds the two assignable in both directions.

`GlobeState<V>` and `GlobeStateMessage<S>` are generic over which of
the two they carry, so `MirroredGlobeState` / `OutputGlobeState` and
`SharedStateMessage` / `OutputStateMessage` share one structure rather
than being two hand-written copies that drift on the next added field.
`MultiOutputManager.broadcast` **is** the boundary: shared in, output
out.

The discriminant earns itself twice. An output can no longer be handed
settings it has no meaning for — the type's job now, rather than
prose's. And because an output already announces its own mode in
`OutputReadyEvent`, a `view.mode` that disagrees is a detectable fault:
a window that booted as one geometry being driven as another, which
before would simply have rendered wrongly.

Three compile-time guards, each verified by making the mistake it
catches. Two `Exclude` constraints tie the union to `OutputMode` in
both directions — a mode with no arm would ship as some other mode's
shape, an arm with no mode could never be selected — and `projectView`'s
`switch` has a `default` that narrows to `never`. Adding a second mode
fails at `protocol.ts` and `stateAggregator.ts` together.

`projectView` is the only place the operator's camera becomes a
geometry's camera, and it takes the output's mode as an argument. The
shared view has no mode at all now, which is what makes driving an
output as the wrong geometry impossible rather than merely unlikely.
The one continuity property worth stating: `DEFAULT_OPERATOR_CAMERA` is
`zoom: 0`, and `1 − 1/(0 + 1)` is exactly `0`, so a freshly-booted
output still gets the uniform 1:1 unwrap without that identity being
written down twice.

The cost is one import edge from the control side into
`src/output/equirectRtt`, for `cameraOffsetForCamera`. It is taken
deliberately: that module is pure TS by construction — no Three, no GL,
no DOM — and the alternative is extracting the derivation and the
`MAX_CAMERA_OFFSET` it clamps against into a third module, splitting the
shader's invariant away from the shader mirror that exists to hold it.
In practice Rollup gives `equirectRtt` its own chunk, shared by the
`manager` chunk and the output bundle — one copy, fetched only by
whoever actually imports it. The web entry chunk is unaffected: it names
that chunk in its dynamic-import preload map, exactly as it already
names `manager`, `publisher` and `three.module`, and never fires the
import. Check the **markers**, not the filenames — `sos-equirect` and
`uCameraOffset` are both absent from `dist/assets/main-*.js`; a chunk
name appearing in the preload list is what a lazily-loaded chunk is
supposed to look like.

`OutputViewSettings` — the operator's per-output toggles — stays flat
on purpose. Only `split` is equirect-only there (`trackCamera` is
wanted by a flat mode too), and that type is **persisted**: regrouping
it is a storage-schema change, and rung 10's version field resets a
mismatched blob rather than migrating it. One boolean's tidier home is
not worth every operator's saved outputs.

### The flat case: N monitors each showing the globe

A video wall where one window is one monitor, each showing the ordinary
globe — a cloned or side-by-side view rather than a projection surface.

**Do not ray-march for this.** The ray-march exists because
equirectangular is not a projection any rasteriser can do natively. A
perspective view *is*, so this mode uses Three's normal pipeline with a
camera per output, and the inside/outside question below never arises.
That means reversing one v1 decision locally: `outputScene` consumes
`photorealEarth` as a **texture provider** with every mesh-only effect
switched off at construction, because the equirect pass is the renderer.
A perspective mode wants the mesh and those effects back, so that
switch becomes conditional on mode.

Also: `resolveFramebufferSize` snaps to 2:1 rungs, and this is the mode
that actually wants the monitor's own aspect end to end — buffer,
window and signal all the same rectangle, so none of the reconciliation
above applies and there is nothing to letterbox.

Cost: widen `OutputMode`, a per-output camera azimuth, a branch in
`outputScene`, the two changes above. Manager, protocol, persistence,
panel and sync are untouched. This is the cheapest non-equirect mode by
a wide margin and it is **not** what an SOS installation needs.

### The projector case, and the invariant it breaks

A real Science On a Sphere rig is four projectors *outside* the sphere,
each with a fisheye lens, overlapping and edge-blended.

`equirectRtt` cannot be pointed at that by changing a parameter.
`MAX_CAMERA_OFFSET = 0.85` exists to keep the camera strictly **inside**
the sphere, and the shader has no miss branch *because* every ray then
hits. A projector two or three radii away has rays that miss entirely,
and rays that hit have two intersections where the near one is wanted.
That is a change to the module the plan calls "the maths", and it is the
one place where "swap the projection shader" understates the work.

Related: rung 14's `uRotationOffsetRad` is a longitude offset. A
projector needs full position, orientation and a lens model.

### The interchange that avoids all of it

v1 already emits equirectangular frames, and **equirectangular is what
the SOS ecosystem ingests** — it is why this repo's catalog is 2:1 and
why `layerStack` and `datasetProbe` do equirect UV maths. So the
existing output can feed SOS software, a warping appliance, or a
projector's own geometry-correction and edge-blend engine with no new
code at all. For a real installation that is the first thing to try,
because per-projector warp is a solved problem sitting in hardware a
site is likely already buying.

The sister project [`zyra-project/sphere-sim`](https://github.com/zyra-project/sphere-sim)
makes a second option real: `packages/sim/src/warp.ts` writes Paul
Bourke warp-and-blend files — per projector, per node `(x, y, u, v, i)`,
where `u,v` is the texel that belongs at that node and `i` is the blend
multiplier. Geometry and blend in one file, deliberately. For a sphere
those `u,v` are equirectangular coordinates, so **the two projects
already meet at the frame v1 produces.**

Consuming one is small: parse the text format, build a cols×rows mesh
(positions from `x,y`, ~~UVs from `u,v`~~, intensity as a vertex
attribute), ~~draw it with the equirect frame as texture, skip nodes
written `-1 -1 -1`~~. terraviz never models the projector, so the
miss-branch problem above does not arise — the trace happened offline.

**Superseded by rung 16 — three corrections and an understatement.**
There is no texture: the ray-march runs per fragment, which saves a
pass, a render target and a second resample. What the mesh
interpolates is a *direction* built from each node's `u,v`, not `u,v`
itself, so the texture seam and the poles need no special case. And
what gets dropped is every *triangle* touching a `-1 -1 -1` node — a
node cannot be skipped on its own, only the cells it anchors. "Small"
also hid three conventions that fail silently: the seam and the poles,
a blend weight in linear light, and a rotation already baked into the
mesh. All three are measured there.

The layering also composes: `cameraOffset` and `split` act on the
equirect **content**, the warp acts on the rig **geometry**. Orthogonal,
so operator zoom keeps working through a warped output.

**Two findings from reading sphere-sim that a naive integration would
get wrong:**

1. **SOS is one framebuffer, not N windows.** `RigCalibration` carries a
   single shared `framebuffer`, and each projector holds a *normalized
   viewport rect* into it — "SOS drives all projectors from one X screen
   split 2x2. Origin is bottom-left". Rungs 9-10 built the opposite:
   N independent fullscreen windows. ~~Both are legitimate and ours is
   arguably better on a modern OS, but a calibration file is expressed
   in theirs, so consuming one means mapping viewport rects onto
   windows.~~ Getting it wrong silently mis-crops every projector — a
   failure that reads as "calibration is slightly off" rather than "we
   misread the file". And bottom-left origin against our top-left is one
   sign from a vertically mirrored rig.

   **Superseded by rung 16.** For projected SOS theirs is the better
   shape, not merely a legitimate one: it is what keeps the projectors
   from drifting apart at the seams. So the rects are placed *inside
   one window*, not onto several — and in GL clip space, whose origin
   is bottom-left too. The sign hazard is real in screen and canvas
   coordinates, which is where sphere-sim's emitter meets it, and does
   not arise in clip space.
2. **An arbitrary surface arrives as a binary sidecar, not more JSON.**
   `packages/calibration/src/mesh.ts` (`sphere-sim/surface-mesh@1`) sits
   *beside* the sphere field rather than replacing it, and is
   deliberately typed arrays: a 100k-triangle model is ~5 MB as
   `Float64Array` and ~40 MB as JSON text. Rung 10 persists config as
   JSON in `localStorage`, which is the wrong home for that. A rig
   config would need a file reference, not an embedded blob.

Note also that a warp file for a **non-sphere** carries the model's own
UV layout, and `buildWarpExport` refuses a mesh with no UV set. ~~So
"drop a GLB and drive it from terraviz" additionally requires rendering
into that model's UV space, which is a different job from what the
output does today. The sphere path has no such gap.~~

**Corrected by rung 16: the line is the UV layout, not the sphere.**
sphere-sim carries a mesh's UV through the same equirectangular
convention the sphere's coordinates use — `uvToCoord`, which it
documents as "what lets a dome unwrapped equirectangularly show the
same map a sphere would". So a dome or an ellipsoid with an
equirectangular unwrap arrives as a warp this output's frame already
fills. Only a model whose UV set is an atlas of islands needs content
rendered into that atlas, and that is still a different job.

### The risk to design around

Both halves are currently validated against themselves rather than
against hardware. sphere-sim's recovery figures are solver-vs-simulator
with injected noise; its `validation/` directory is explicitly
"plausibility only — no metric, no gate, no score". And nothing in this
plan has run on a second monitor. Composing two unvalidated halves
makes a first-light failure hard to attribute between them.

The cheap mitigation is to make an output able to display a warp file's
own test pattern, so the warp can be judged before the globe is in it —
which is also what rung 14's calibration tooling wants anyway.

**Interchange, not a code dependency.** sphere-sim's architecture is a
boundary lint whose whole purpose is stopping two models from sharing
implementation; importing it would drag a research instrument into a
display app's render path. The warp file is what it is for. Consuming a
standard format also keeps terraviz able to take warps from other
tools — and MPCDI, which `warp.ts` names as the right second target,
becomes additive rather than a rewrite.

### Rung 16 — a sphere-sim warp bundle on one output

**Status: built in code, with its runbook section (2026-09-29); a
hardware pass is not done.** Every piece below exists: the pure
module, the import, the mode, the render-config channel, the storage,
the scene and the panel. The geometry build, fail-closed
parse and blend are `src/output/projectorWarp.ts`, held to sphere-sim's
own tracer by a parity fixture (§"Verification"); the ZIP reader and the
set's assembly are `storedZip` and `warpImport` (§"Where the meshes
live"); `projector-warp` is an `OutputMode` end to end (§"A new mode,
not a render-config flag"); the set rides the render config and lives
under a key of its own (`warpStorage`); the output draws it
(§"The quad is already a mesh"); and the Outputs panel imports a bundle,
placing it by its own `layout.json` when it carries one (sphere-sim#52,
read since 2026-09-29) and asking the layout question when it does not
(§"Prerequisites", §"Upstream requests"). The operator's side,
spanning included, is `MULTI_MONITOR_OPERATIONS.md` §3.6. Appendix B's
W steps on a sphere are what remain.
Written 2026-09-26 against sphere-sim
`main` at `40a51dd`, after the operator who owns the deployment asked
for it by name — which is the gate roadmap Phase 3 set, so this rung
opens Phase 3's sphere half. Every number below was **measured**, by
generating meshes with sphere-sim's own exporter — the Boulder
preset's, and placed rigs with a pole in view — and checking them
against its own tracer, not read off its documentation. It is written
for any rig sphere-sim calibrates, not SOS's alone: sphere-sim now
places any count of projectors on a sphere or a mesh, and SOS's four
quadrants are the one case with no upstream prerequisite, not the only
case. Several findings correct what this chapter said before them;
those statements are amended in place and point here.

#### What arrives

sphere-sim's export is one ZIP: `warp/<id>.data`, one Bourke type-2
mesh per lit projector; `alignment/<id>.alignment`, the same
correction squeezed into SOS's nine-point format; the patched
`local_sos_config.json`, only when the operator loaded one to patch;
a README; and `restore/`, a restore point. Only the first concerns
this rung. The alignment files
are lossy by sphere-sim's own account — no blend column, nine control
points — and describe a residual against SOS's renderer rather than a
content map.

**The restore point is a trap for a careless reader** — corrected
2026-09-29, since this section first listed four kinds of entry and
the ZIP holds five. `restore/` keeps, byte for byte, each file the
install would overwrite that the operator loaded into the page, and
that can include `restore/warp/<id>.data`: the *previous* calibration,
in the same format and under the same file name, one directory down. A
reader matching on the file name, or on any path ending `.data`,
imports the old calibration as the new one, or refuses the pair as
duplicates, depending on entry order. So the import reads
`warp/<id>.data` **at the archive's root** and nothing else.

A mesh is `2`, then `cols rows`, then one `x y u v i` line per node,
row-major. `x` spans ±the projector's aspect and `y` spans ±1, y up;
`(u, v)` is the equirect texel that belongs at the node, v up; `i` is
its blend weight; `-1 -1 -1` marks a node whose ray misses the surface.
The default is 41×41: 1,681 nodes and 80,293 bytes of text per
projector on the Boulder rig, of which 681 nodes land on the sphere.

#### Which surfaces: the line is the UV layout

sphere-sim writes this same file whatever the rig — SOS's four
projectors on the analytic sphere, a placed rig of any count, or either
on a mesh surface — and what a mesh changes is what `(u, v)` means. On
the sphere it is the equirectangular texel. On a mesh it is the model's
own UV, carried through the same convention (`uvToCoord`), which
sphere-sim documents as "what lets a dome unwrapped equirectangularly
show the same map a sphere would". So the line falls at the **UV
layout, not the shape**. A dome, a hemisphere or an ellipsoid unwrapped
equirectangularly arrives as a warp this output already fills, and is
in scope with nothing the sphere does not need — its zenith is the pole
case convention 1 handles. A model whose UV set is an atlas of islands
arrives as a warp into that atlas, which only content authored for it
can fill, and stays out.

The file cannot say which it is: both are numbers in [0, 1].
~~The failure is at least a loud one — Earth in fragments across the
model, not a plausible globe slightly off — which is why this rung
notes the limit rather than guarding it.~~ **Corrected 2026-10-02:
that holds for an atlas, not for a fisheye layout.**

- **Why an atlas is loud.** Its islands sit apart in the texture, so a
  cell straddling two of them has corners that are neighbours on the
  model and strangers in the texture. Convention 1's width bound drops
  that cell.
- **A fisheye layout has no islands, and is the quiet case.** Bourke's
  format says only that `(u, v)` refer to the original input image. The
  leading `2` is the mesh's topology (rectangular, against polar), not a
  projection. So a mesh made for a dome or a mirror addresses a
  **fisheye** frame and arrives in exactly the same shape. That includes
  meshmapper's, the commonest Bourke meshes there are.
- **Read as equirect, the disc becomes the whole world.** Its centre
  lands at (0°, 0°), and its rim at the poles and the antimeridian.
  Neighbouring texels are still neighbouring directions all the way
  round, so no triangle stands out as wide and the bound drops
  nothing.
- **Measured.** A synthetic one, 16:9 at 41×23, an angular fisheye of a
  180° hemisphere, parses and places, loose under SOS's quadrants and
  in a bundle alike (`warpImport.test.ts`). It builds 1,780 triangles,
  and the width bound drops none of them. The result is a smooth,
  plausible globe that is wrong.

So the quiet case is guarded, by the only thing that can know, a
declaration:

- **In a bundle.** A `layout.json` that states what `(u, v)` address
  must say `equirectangular`, and is refused for anything else. sphere-sim
  writes no such field yet; sphere-sim#57 asks for it (see "Upstream
  requests"). One that states nothing reads as before. That leaves one
  route open: a sphere-sim bundle for a model whose own UV set is a
  fisheye, as a domemaster dome's is. It stays open until sphere-sim
  states the frame.
- **For anything without a layout,** the operator's answer to the
  question states the frame as well as the place.

**"Nothing the sphere does not need" holds for the mesh maths, not for
where the audience sits** (corrected 2026-10-02). A sphere's audience
stands outside it and a dome's sits inside, and a picture seen from the
other side is its mirror image. Content authored like a globe has east
to the right of north when seen from outside. From inside, east is to
the left, so on a dome the coastlines read mirror-reversed east to
west, and so does anything burnt into the picture, a title or a date
stamp. The warp is right either way, since it says where each projector
pixel lands. Which way the picture should read depends on where the
audience is, and the mesh does not record that. This rung does not
handle it. Under convention 3's rule that rotation is content, a
viewing-side flip would be a terraviz **content** setting beside the
content rotation, never a property of the mesh. Phase 2's dome, whose
camera sits at the centre, inherits the same question.

Two of sphere-sim's behaviours are sphere-only, both keyed on
`blendModelApplies`:

- it masks the polar caps into `i`, which changes nothing here, since
  `i` is applied as it arrives;
- it bakes the rig's rotation into `u`, which changes convention 3.

#### One output carrying the set, not one output per mesh

SOS drives **one framebuffer split 2×2** — sphere-sim's PARAMETERS.md
§3.4, `set projectorInfo(viewport) { 0,0,0.5,0.5  0.5,0,0.5,0.5 … }`,
"two T1000s spanned into one X screen". P1 is bottom-left, P2
bottom-right, P3 top-left, P4 top-right, origin bottom-left. The same
section names this plan: the multi-window architecture "is the wrong
shape for projected SOS. Drift is zero by construction when there is
one decoder and one swap."

That is right, and the reason is where drift would land. Every overlap
is two projectors drawing the same content, which is exactly where the
blend makes both images visible at once. Two windows each steered
independently towards the control window's playhead can sit a frame
apart — a doubled coastline along every seam — and a camera drag
reaches them in two separate IPC deliveries, so the seams tear while
the operator moves. One window draws every viewport in one pass
from one set of uniforms, off one decoder, and holds one slot of rung
11c's budget rather than one per projector.

None of this is particular to SOS. sphere-sim's generalization to
placed rigs of any count kept the single framebuffer on purpose —
`gridViewports` is documented with "six projectors on a wall are still
driven from one framebuffer, just one split six ways instead of four" —
so an arbitrary rig arrives in the same shape, with its viewports
packed differently. What does not generalize is knowing *where* each
mesh goes, which §"Prerequisites" takes up.

So the unit is **one output on the spanned display, carrying the set**.
This supersedes the hardware-session note above that "the four
projectors are four outputs, not one": that was inferred from the shape
rungs 9-10 happened to build, and the source this chapter cites says
the opposite. The control ↔ output link is unchanged. It is the
*projectors* that should not become separate windows.

The N-window shape is not forbidden, only no longer the default. A set
of one mesh whose viewport is the whole window is the degenerate case,
for a rig that genuinely exposes each projector as its own display. It
carries the drift above, and an operator choosing it should know that.

#### The quad is already a mesh

The output draws `PlaneGeometry(2, 2)` through `EQUIRECT_VERTEX_SHADER`,
whose whole body is `vUv = uv; gl_Position = position`. **That is a 2×2
Bourke mesh with the identity mapping.** A warp replaces the geometry
and one line of the contract: its vertex stage hands the fragment a
**direction** rather than a texel, and the fragment turns that back
into `(u, v)` before anything else runs (convention 1 below says why).
Everything after that line is the shader as it stands, because the two
projects already agree on every convention it touches:

| | sphere-sim writes | The shader reads |
|---|---|---|
| `u` origin | `(lon + 180) / 360` (`coordToUv`) | `lon = (u − 0.5)·2π` |
| `v` direction | up, north at `v = 1` (`1 − tex.v`) | `lat = (v − 0.5)·π`, north at `v = 1` |
| Viewport origin | bottom-left (`projectorInfo`) | GL clip space, bottom-left |

The last row is the convention that lines up for free: sphere-sim's
emitter must flip `projectorInfo` rects to draw on a 2-D canvas, and
GL needs no flip. Nothing in this rung flips `y`.

**Per-fragment, not render-to-texture.** This corrects the sketch in
§"The interchange that avoids all of it", which draws the mesh "with
the equirect frame as texture". That costs a pass, a render target, and
a second bilinear resample of an image that was already one. It would
also be the first render target this scene owns, and case 5's account
of a clean context restore is written for a scene that holds none.
Evaluating the ray-march at the direction the mesh interpolates costs
none of those. Everything downstream composes unchanged: the camera offset
that is operator zoom, split, `layerStack`'s overlays and palettes, the
Earth decoration — and rung 14b's calibration pattern, which travels
through the warp like any dataset. The check §"The risk to design
around" asks for, judging the warp before the globe is in it, needs
nothing new.

The drawing buffer becomes the **window's native resolution**, and that
takes a sizing path of its own, not a hidden picker:
`resolveFramebufferSize` snaps every request onto the 2:1 ladder, so no
`framebufferWidth` can produce 3840×2160. In this mode the scene sizes
the buffer from its own canvas — client size times `devicePixelRatio`,
tracked with a `ResizeObserver` — and `framebufferWidth` is never read.
(It is still stored, since every persisted output carries one; a warp
window ignores it.) Nothing crosses the wire and nothing is replayed on
boot, because a fullscreen window's own size *is* its monitor's.
Reading it from the window rather than from the manager also means a
boot that races the spawn sequence's `setFullscreen` corrects itself on
the first resize instead of rendering at a stale size. The ladder and
its picker stay `sos-equirect`'s, as the hardware note already says.

**The scene is built, 2026-09-29.**
- **Geometry.** `setWarp` swaps the quad for the set's triangles and
  rebuilds them only when the set's content id changes. A set the warp
  check refuses draws nothing, and the HUD's new `warp` line says which
  refusal.
- **Shader.** The material takes the warp stages, which differ from
  the plain pass in two lines: the prologue and the blend.
- **Sizing.** The buffer follows the canvas, and `setFramebufferWidth`
  does nothing in this mode.
- **Calibration.** The pattern still travels through the warp as a
  dataset would. Its readout names the display the window spans,
  since there is no rung to name.

**Verified on real WebGL, with SwiftShader standing in for a GPU.** A
differential harness in headless Chromium drew the same content — a
field periodic in `u`, so a band sweeping through the whole texture
could not hide — through `sos-equirect` and through the warp, with
Boulder's P3 and the pole-facing placed projector as two viewports of
one 1280×720 window. It then compared each warp pixel with the equirect
frame at the texel `sampleWarpGeometry` predicts, times the blend
factor.
- **Coverage.** 180,864 covered pixels, all within 1.4/255 (median
  0.2). None was lit where the mirror predicts nothing.
- **Mutations.** Three deliberate breakages each failed it by
  thousands of pixels:
  - the blend removed;
  - the longitude mirrored;
  - an encoded multiply in place of the linear-light one.

As with the dateline fix, that is SwiftShader's word, and a GPU should
agree; W1–W3 carry it to hardware.

A 3840×2160 spanned display is about the pixel count of today's
4096×2048 frame. A mesh's cells are equal in raster space, so on
Boulder, where only 620 of each mesh's 1,600 cells reach the sphere,
the fragment shader runs on 39% of each raster — well under half the
pixels it does now.

The geometry build is a **pure module**, and nearly all of this rung's
correctness lives in it:

- non-indexed triangles, two per cell;
- any triangle touching a no-data node is dropped, not clamped — a
  `-1` node interpolated towards its neighbours smears texel `(0, 0)`
  across the cell;
- each node's `(u, v)` turned into a unit direction in the shader's own
  frame, through `equirectRtt`'s `latLonToDirection` rather than a
  restatement of it, and interpolated in place of `uv` (below);
- a triangle wider than any real cell dropped and counted (below);
- `x` divided by the file's own aspect, then each mesh mapped into its
  viewport's clip-space rect;
- `i` a per-vertex attribute, interpolated like the direction;
- a mesh that would draw nothing refused at the parse (added
  2026-09-29, from review): one whose drawable nodes never meet three
  to a cell, and one whose complete triangles all weigh 0. Both used to
  parse and draw black, which reads on the sphere as a dead lamp rather
  than a refused file. The parse asks the question of the triangles the
  build keeps, through the same cell split.

It needs no GL, no DOM and no Three, so every rule above is a unit
test.

#### A new mode, not a render-config flag

`projector-warp` joins `OutputMode`. It is named for what it does, not
for SOS, because an SOS sphere is one rig among the several sphere-sim
now calibrates — any count of projectors, placed anywhere, on a sphere
or a mesh. `sos-equirect` keeps its name: it is a persisted string, and
renaming it would reset every operator's saved outputs to buy nothing.
The `sos-` prefix on the storage key below is the app's own key
namespace (`sos-docent-config`, `sos-telemetry-config`), not a claim
about the rig.

This is the chapter's own "mode plus an optional geometry reference"
shape, adopted for the reason given there: rung 10's parse refuses a
`mode` it does not recognise, so a build without this rung **declines
to spawn** a warped output instead of throwing a plain equirect across
projectors calibrated for a warp. A render-config flag would restore as
`sos-equirect` on that build and look as though it had worked.

**The window learns its mode from its spawn URL**,
`output/output.html?mode=projector-warp`, and from nowhere else. Before
this rung `OUTPUT_MODE` was a constant precisely so that an output never
adopted its geometry from the wire: one that did could never disagree
with it, and the mismatch check would be vacuous. The URL keeps that
property.
The mode is fixed before the window hears anything, so a view arm for
the other geometry is still a mismatch it can see. A URL with no mode
is `sos-equirect`, which is every window a build before this rung
spawns.

Its `MirroredView` arm carries the same parameters as `sos-equirect`'s,
**`split` included**. Split is SOS's own option for mirroring the area
of focus onto the opposite hemisphere (§"LED sphere zoom + split"), and
it composes: the `u` the fragment recovers from the mesh's direction
*is* the physical surface's texture coordinate, so the shader's existing
`fract(u · 2)` folds it exactly as it does for an LED sphere. The two
modes differ in how an arm becomes pixels, not in what it holds. The
three exhaustiveness guards turn the new arm into a compile-time
checklist, which is what they were built for.

**Built, 2026-09-29.**
- **The mode list.** `OUTPUT_MODES` is the one list, and `OutputMode`
  is derived from it. `isOutputMode` is the narrowing that both the
  persisted config and the URL use.
- **The URL.** `outputModeQuery` spawns `sos-equirect` bare, and
  `outputModeFromQuery` reads a URL naming no mode as `sos-equirect`.
  A URL naming a mode this build does not know reads as `null`, never
  as a fallback, and the window draws nothing and logs why.
  `OUTPUT_MODE` the constant is gone: the mode is now an argument, read
  by `src/output/main.ts` from the URL.
- **The guards.** Each was checked by deleting the new arm's case and
  watching the compile fail. Telemetry's bucket switch is a fourth
  guard of the same kind.
- **Two things the chapter did not ask for.**
  - A window announcing a different geometry from its record's is
    closed rather than driven. Until there were two modes the manager
    had nothing to compare. This first shipped as logged and still
    served, and review caught it: a projector-warp output driven as
    `sos-equirect` puts an unwarped globe across the projectors, and
    not serving it is not enough, since an undriven output draws its
    own idle Earth. A ping carries no mode, so one from a window that
    has never announced now gets the reattach poke rather than a serve.
    The close keeps the configuration and reports no removal.
  - `output_added` reports a `projector-warp` window's framebuffer as
    `native`. That window draws projector rasters rather than an
    equirect frame, so no rung on the ladder describes it, and
    bucketing its stored width would name a 2:1 frame it does not
    draw.
- **No set yet.** Until the geometry lands, a `projector-warp` window
  hides the quad and clears its rasters to black. That is this
  section's "holding no set" state, with the stated reason still to
  come.

The mesh set rides the **render-config channel**: per window,
last-write-wins, sent before the first snapshot on `output_ready`,
never in the 1 Hz heartbeat. A health-check resync resends it, so the
output compares a content hash and rebuilds geometry only on a change.
A `projector-warp` output holding no set draws nothing into the projector
rasters and says why, on the HUD and in the panel row. An unwarped
image across calibrated projectors is worse than black, and black with
a stated reason is not the silent kind.

#### Where the meshes live

**Content, not a path — another correction**, this time of the "holds
a path, not a blob" line under §"Geometry is a per-output
configuration". That rule was sized for sphere-sim's typed-array
*surface* mesh, 5–40 MB; a Bourke mesh is three orders smaller. And a
path is not available anyway. `<input type="file">` never tells a
webview where a file lives; reading one back later needs
`plugin-dialog`, `plugin-fs` and a filesystem capability this app does
not grant; and a calibration commonly arrives on a laptop or USB stick
that leaves the building after the import.

So each mesh's **original text** is kept, with its id, viewport and
source filename, and re-parsed on restore by the same fail-closed
parser that accepted it: one parser, one set of refusals. A set lives
under **a key of its own**, `sos-multi-output-warp:<warpId>`, where
the id is a hash of its meshes and their placement. About 80 KB per
projector at 41×41, so 320 KB for SOS's four — the largest thing the
app keeps there. A webview's per-origin quota is a few megabytes, and a
finer export of a many-projector rig can reach it, so the write is
checked and a set that does not fit is refused whole rather than kept
in part.

One key per set, and none shared with the main config, for three
reasons. The main config is rewritten on every toggle and should not
carry the meshes each time. A corrupt set then costs the outputs that
use it their warp and nothing else, because no parse ever reads two
sets at once — which a single shared value would make impossible,
since one bad byte in it fails the parse of every set. And replacing a
set is one `setItem`, so a write cut short cannot leave half a set or
damage another. ~~A set no output references any more is deleted with
the last reference.~~ **Corrected 2026-09-29:** a set is deleted when
the operator lets go of it — Remove, a hand close, Clear, or an import
that replaces it — and only then, and only if no other output still
names it. A reference can vanish by accident. A restore drops an
output whose monitor was not enumerated at boot, such as a projector
array still powered off, and a clean-up keyed on references would
delete that rig's calibration with it, from a laptop that may have
left the building. A set a failure leaves behind costs space instead,
and rarely even that: re-importing the same files lands under the same
content id.

```ts
// Sketch. The persisted output gains a reference, never the blob.
interface PersistedOutput { /* … */ warpId?: string; blendGamma?: number }

// localStorage['sos-multi-output-warp:' + warpId] — one key per set
interface PersistedWarpSet {
  version: 1
  importedAt: string
  layoutFrom: 'bundle' | 'sos-quadrants'  // never inferred from an id
  // What u addresses, as layout.json states it; null when nothing did.
  texture: { surface: 'sphere'; rotationOffsetDeg: number }
         | { surface: 'mesh'; rotationOffsetDeg: null } | null
  meshes: {
    id: string          // from the filename, warp/<id>.data
    viewport: { x: number; y: number; w: number; h: number } // bottom-left
    sourceName: string
    text: string        // the file as imported
  }[]
}
```

Parsing happens in the **manager**, which the panel reaches the way it
reaches `framebufferWidths()`: every `multiOutput/` import in
`outputUI` is type-only, and a runtime parser import there would pull
the contract back into the web entry graph. The import accepts the ZIP
as sphere-sim writes it — store-only, so the reader is a page of code
and no dependency — or a multi-select of `.data` files.

**Built, 2026-09-29**: `storedZip` reads the container and
`warpImport` turns what was picked into a set, in two steps because
the panel asks its layout question between them. The reader checks
every entry's CRC-32 rather than trusting it, since a byte flipped
inside a coordinate still parses. It refuses a *compressed* entry per
entry and on read, rather than refusing the whole archive: an operator
who re-zipped the extracted bundle gets deflate everywhere and is told
to pick the `.data` files instead, while a recompressed README cannot
make the meshes beside it unreadable. A mix of archive and loose
meshes is refused, not settled by whichever the reader saw first. Ids
are compared for duplicates case-insensitively, since `P1` and `p1`
are one file on the disks they are extracted to. The set's check —
ids, viewports inside the framebuffer and sharing no pixels, every
mesh through the one parse — is `projectorWarp.placeWarpSet`, which
the restore and the output's receipt call too. The set's id is 64 bits
of FNV-1a and CRC-32 over the meshes and their placement, in id order,
and it is synchronous because it keys storage. Without `crypto.subtle`,
the app's other hash degrades to a shared placeholder. The fixture is
a real bundle from sphere-sim's own `bundleEntries` and `buildZip`,
restore point included.

**The storage and the channel are built, 2026-09-29.**
- **Storage.** `warpStorage` keeps one key per set.
  - Every read re-parses the meshes through `placeWarpSet` and
    recomputes the content id. A set changed since it was written reads
    `altered` and does not draw.
  - The write is checked: a quota error reads `no-room`, anything else
    `unavailable`.
- **The render config.** It carries `warp` (the id and each mesh's
  own text and viewport) and `blendGamma`, whose default moved into the
  protocol because both ends need it.
- **The manager's three operations.**
  - `readWarpFiles` refuses an oversized pick by its size before
    reading a byte.
  - `importWarpSet` stores the set before pointing the output at it, so
    a refused write leaves the output with the set it had.
  - `clearOutputWarp` takes the set away.
- **The reference is kept apart from the loaded set.** A record's
  `warpRef` is what is persisted; `render.warp` is the set as loaded.
  They differ exactly when a stored set could not be read, and then the
  output draws nothing while the reference is kept. A set a later
  build's parser refuses is still the operator's calibration, and
  dropping its reference would let a later removal delete it.

#### Three conventions that fail silently

Each produces a picture that is plainly a picture, and none announces
itself as a parsing mistake.

1. **The seam and the poles.** `u` is wrapped to [0, 1) at every node,
   so a projector whose raster crosses the texture's ±180° meridian has
   cells whose corners jump from about 1 to about 0. On the Boulder rig
   that is P3: **38 of its 620 cells**, with `u` spanning
   [0.012, 1.000]. Interpolated as written, each of those cells sweeps
   backwards through the whole texture — a band of compressed world
   one cell wide. Unwrapping `u` per triangle mends that band and fails
   at a pole, where a triangle's corners go all the way round and no
   shift of `u` can interpolate them. An SOS rig never has a pole in
   view, since its poles sit exactly 90° from every projector
   (PARAMETERS.md §4.2); a dome's zenith, or any placed projector aimed
   high, does.

   So the build interpolates **directions**. Each node becomes a unit
   vector, the vertex stage interpolates those, and the fragment
   normalizes and recovers `(u, v)` with `atan` and `asin`. Neighbours
   on the sphere are neighbours in direction whichever side of the
   seam or the pole they sit on, so both become one rule with no
   special case. Measured against sphere-sim's own tracer, at five
   points in every drawn triangle, it matches `(u, v)` interpolation
   where that works: on the Boulder rig the two are a wash, 1.0 px
   against 0.9 at the median and 14.0 against 14.7 at the 99th
   percentile. Those tails are the 41×41 grid's own limit and sit in
   the ring of cells beside the silhouette; one ring in, the worst is
   about 4 px. Where `(u, v)` does not work, the difference is the
   point: on two placed projectors with the north pole in view, the
   triangles round it land 19–77 px out under unwrapped `(u, v)` and
   within 2 px under directions.

   What is still dropped is a triangle wider than any real cell —
   eight times the mesh's own median width, where the widest measured
   on Boulder or on either placed rig is 3.6 times it. On a sphere
   nothing reaches that. On a mesh surface it catches a cell straddling
   two UV islands, whose corners are neighbours on the model and
   strangers in the texture, though not a cut whose two sides happen to
   sit close in the texture. It does not catch a fisheye layout at all,
   since that has no cut (§"Which surfaces"). Each drop is counted on
   the HUD, so a rig that trips the bound shows a number rather than a
   hole.

   **The fetch has a seam of its own**, and interpolation does not
   reach it. The shader takes the hit point's longitude with `atan`,
   which jumps a whole turn at the antimeridian, and every texture
   lookup picks its mip level from the screen-space derivative of that
   coordinate. A 2×2 pixel quad straddling the jump sees the texture's
   whole width per pixel and samples the smallest mip: a hairline of
   the texture's average colour along the content's dateline. Video
   escapes it, since Three builds a `VideoTexture` without mipmaps; the
   Earth, the clouds, image datasets and the calibration pattern do
   not, because `new Texture()` defaults to trilinear. It is **latent
   in `sos-equirect` already**. With the camera centred the dateline
   sits on the frame's edge, where no quad straddles it, but tracking
   the operator moves it inside: zoomed fully towards (0°, 90°E) it
   runs about 40° in from the frame's edge on the equator. A warp makes
   it permanent wherever a raster covers the dateline — P3, on Boulder.

   **Reproduced in `sos-equirect`, 2026-09-27**, with the real
   `outputScene` in headless Chromium and its network loaders stubbed.
   The layer was an image, white within 36° of the dateline and black
   elsewhere. With the camera centred, no pixel in the white band was
   wrong. Zoomed fully towards (0°, 90°E), 501 were, across 251 rows,
   every one within 1% of the dateline and each reading 51 — the whole
   texture's average, which is its smallest mip. The idle Earth showed
   the same 501; a video layer carrying the same picture showed none.
   The line is dashed rather than continuous, because it appears only
   in rows where the jump falls inside a quad. SwiftShader drew it, a
   software renderer, but choosing a level from quad derivatives is
   what every GPU does, so hardware should agree; that is still to be
   seen.
   The fix is a few lines in the fetch: take the level from whichever
   of `u` and `fract(u + ½)` is continuous at that pixel (Tarini's
   method) and sample with explicit gradients. It belongs in its own
   commit ahead of this rung, since it is not the warp's.

   **Fixed, 2026-09-27**, in `layerStack`'s `EQUIRECT_GRADIENT_GLSL`:
   gradients taken once, right after `sphereUv`, and every fetch of an
   equirect texture samples with them. The same headless harness now
   reads 0 wrong pixels in every case it measured, idle Earth and image
   layer included. That is SwiftShader's word, as the reproduction was;
   smoke steps 41 and 43 now carry the check on a GPU. A warp's
   direction prologue inherits the fix, provided the gradients are
   still taken from the recovered `sphereUv` before any branch.

   **Wider than described above, found the same day.** The dateline
   does not need camera tracking to enter the frame: the shader
   subtracts the rotation offset from the longitude, so any offset
   puts it on a column of a centred frame. The same harness, camera
   centred and rotated 90.13°, drew a solid line two pixels wide down
   all 614 rows it checked, on the idle Earth and the image layer
   alike. At exactly 90° it drew nothing, because the jump then falls
   between 2×2 quads rather than inside one — as it does for every
   multiple of 45° at every width on the ladder, which is why smoke
   steps 43 and 44, at 90° and 45°, could not have caught it. About
   half of the panel's 0.1° slider positions do show it, so a drag
   makes it blink. The same fix clears both: 0 wrong pixels.

   **The same at a pole, found 2026-10-01.** A pole inside the frame
   is the seam's pathology without the seam. Every row of an
   equirectangular texture spans the whole turn, so round a pole
   longitude sweeps 360° in a few pixels, and a fetch that read `u`'s
   gradient raw took those pixels for ones covering hundreds of
   texels. It chose the pyramid's coarsest levels, and a level is a
   box in *both* directions, so whole bands of latitude averaged into
   a dot on the pole. The follow turn (§3.5) brings a pole to the
   front, where it is looked at, and that is how it was found. It
   was there before that: tracking a high latitude put the content's
   pole inside the frame without any turn, and so does a placed
   projector aimed at a pole. The measurement used content whose
   colour encodes each texel's own direction, checked against the TS
   mirror. Followed onto Antarctica at zoom 2, the worst pixel on the
   pole read the colour of 35°S, 48 levels off, and 170 pixels were
   off by more than 8. The old zoom-only path onto the same place was
   off by up to 107, with 776 pixels past 8.

   **Fixed** in the same function: after the seam choice, `u`'s
   gradient is scaled by the row's length at that latitude, cos(lat)
   (`rowScaledGradientU`), so a level is chosen for the distance the
   pixel covers on the sphere. Nothing finer is lost, because a row
   near a pole is a few degrees of circle stretched across the whole
   texture width. An unturned frame changes no level at all.

   | Case | Worst, before → after | Pixels > 8 off, before → after |
   |---|---|---|
   | Followed onto Antarctica, zoom 2 | 48 → 3.2 | 170 → 0 |
   | 45°S 179°W, near the zoom cap | 96 → 4.1 | 154 → 0 |
   | The north pole at the front | 24 → 0.9 | 144 → 0 |
   | Old zoom-only path, onto Antarctica | 107 → 5.1 | 776 → 0 |
   | The warp, against the frame under the same turn | p99.9 8.9 → 1.8 | 208 → 32 |

   The warp's 32 are the triangle-edge pixels its harness always
   showed (36 before the turn existed).
2. **Blend gamma.** sphere-sim's weight multiplies radiance **in linear
   light** and is encoded afterwards (its conventions.ts §B, clause 4,
   restated in `blend.ts`). This scene writes display-space values —
   that is what `useDisplaySpace` is for. A player that multiplies the
   encoded pixel by `i`, as most Bourke players do, leaves two
   half-weight projectors emitting 0.5^2.2 ≈ 22% each: a band at 44% of
   target along every seam. Apply it in linear light — decode,
   multiply, encode — with γ a per-output field, default 2.2 and
   persisted, because sphere-sim classes its photometry PROVISIONAL and
   its own notes leave open which job SOS's blend gamma of 0.8 does.
   It is per output rather than per projector because one rig's
   projectors are normally one model; a rig that mixes models needs
   per-projector colour matching, a non-goal below.
3. **Double rotation.** On the sphere, nominal or placed, sphere-sim
   bakes the rig's mechanical rotation into `u`
   (`worldLonToTextureLon`); on a mesh it bakes none, because the
   model's UV unwrap anchors the texture instead. Either way the
   alignment rung 14a's `uRotationOffsetRad` exists to supply is
   already in the warp. Under a warp the offset is therefore a
   **content rotation** — a turn of the picture about its own polar
   axis, on top of whatever the warp maps — and the panel labels it
   so. It is never seeded from the rig: not from an SOS config, whose
   rotation is the one the warp already holds, and not from anything
   the bundle says. It starts at 0 on a new output and an import
   leaves it alone, since it is the operator's choice rather than the
   rig's. The warp's own rotation is shown beside it, read-only — the
   operator needs both numbers to know which one turned the picture.
   A Bourke file has nowhere to state it, and the manifest
   [zyra-project/sphere-sim#49](https://github.com/zyra-project/sphere-sim/issues/49)
   proposes does not carry it as filed. A follow-up comment there
   (2026-09-27) requests it as an addition: the baked
   `rotationOffsetDeg` for a sphere rig, and an explicit none for a
   mesh. ~~Until a bundle states it — and so for every bundle today —
   the panel shows the warp's rotation as unknown.~~ **sphere-sim#52
   states it (2026-09-29)**, and the row now shows what `layout.json`
   says: the sphere's baked rotation in degrees, or none for a model.
   It says "unknown" only where nothing says, meaning loose files or a
   bundle from before #52. The Boulder
   preset's rotation is 0, which is exactly why a fixture made from it
   cannot catch this: the test needs a rig with a non-zero one.
   **Pinned, 2026-09-29,** with SOS's nominal rig turned 30°. With
   nothing applied, its mesh lands within 0.21° of sphere-sim's tracer.
   With the rig's rotation applied again as a content rotation, it
   lands 26–30° out.

#### Prerequisites, one of them upstream

- **The bundle carries no layout, and a filename cannot supply one.**
  *Met upstream 2026-09-29: sphere-sim#52 writes `layout.json`, and
  this build reads it. See "Upstream requests" below for what the
  reader enforces.* The rest of this item stands for everything that
  has no layout — loose files, and bundles from before #52 — which is
  why the question is kept.
  `bundle.ts` does not write the viewports, so a mesh pairs with its
  place in the framebuffer only through the projector id in its
  filename — and an id does not determine a place. `nominalRig` names
  a projector after its SOS slot, so `P3` is the top-left quadrant
  whether the rig has four projectors or two. `placedRig` names them
  `P1` to `Pn` in placement order and lays them out with
  `gridViewports`, whose column count is the caller's: four placed
  projectors in one row carry SOS's four ids and none of SOS's places.
  Its defaults diverge too. Two placed projectors split the framebuffer
  into halves, so `P2` is the right half at full height, and a lone
  placed `P1` is the whole framebuffer where a lone nominal `P1` is a
  quadrant. So the import **never places a mesh by its id alone**. It
  uses the layout the bundle states, which sphere-sim does not write
  yet — [zyra-project/sphere-sim#49](https://github.com/zyra-project/sphere-sim/issues/49),
  a **prerequisite for any rig that is not SOS's quadrants**. Without
  one, the panel offers SOS's quadrants as an explicit choice, diagram
  and all, and refuses the bundle if the operator declines or it holds
  an id the quadrants cannot place. There is no silent default.
  sphere-sim's emitter calls a viewport in the wrong place silent and
  "the expensive one", because the picture still looks right and every
  frame is filed under the wrong projector. The raster-shape check
  below is a partial backstop: it compares shapes, so it catches a
  layout of the wrong shape and never a right-shaped one with two
  projectors swapped.
- **The projector heads must enumerate as one monitor** — NVIDIA
  Mosaic, AMD Eyefinity, or `xrandr --setmonitor`. An output fullscreens onto
  exactly one monitor, and this rung does not place a window across
  several. A span placement is a follow-up only if a site cannot span
  at the OS level. How to span is the runbook's §3.6.
- **The raster must be the shape the mesh was solved for.** The file's
  `x` span states it: ±1.778 is 16:9. On SOS's quadrants a 3840×2160
  screen gives 1920×1080 viewports and agrees. A 4096×2160 one gives
  2048×1080, where a mesh solved for 16:9 still fills its viewport and
  the picture is quietly stretched by 7%. The panel warns on a mismatch
  rather than refusing, since the operator may know the lens
  compensates.

**The panel is built, 2026-09-29** (`outputWarpUI`).
- **The output type.** Add now asks what the output is. The default
  is an LED sphere or a dome, since a projector rig draws nothing
  until it has a warp.
- **What a `projector-warp` row shows.**
  - Its status: what it draws, "nothing imported", or "a stored set
    could not be read" — the last two call for different actions.
  - An import button and a clear button.
  - The blend gamma.
  - The display's native size, where the framebuffer ladder would be.
  - The rotation, labelled **content rotation**, beside a note that
    the warp's own rotation is unknown.
- **The import.**
  - A bundle that has been read shows what arrived. It then draws SOS's
    quadrants with each mesh in the place it would take, and waits for
    the choice; declining imports nothing.
  - The raster-shape check above is a warning shown before the choice.
  - Every refusal the manager can return has a sentence. The specific
    code is carried raw beside it, since that is what an operator with
    the file open can act on.
- **No screenshot scene.** The Outputs panel has never had one: the
  capture tool runs the web build, and the panel mounts only under
  Tauri.

#### What the operator will see

**The edge is reconstructed, not staircased.** A node whose ray misses
the surface has no texel, so a compliant player drops every triangle
touching one, and each projector's image stops up to one cell short of
its silhouette: 96×54 px on Boulder's 3840×2160 rasters at 41×41, in
a staircase. Most of that edge carries no light, but the polar ends of
each disc do: the last node before the edge still carries weight there,
and the staircase cut it off bright. The first import of a sphere-sim
bundle showed exactly that. sphere-sim's own preview has none because
it traces every pixel.

The grid holds enough to do better, and `projectorWarp` does
(`edgeBand`). Near a smooth silhouette the angle a ray sweeps grows
like the square root of its distance from the edge, so the ratio of
the last two steps along a grid line says how far past the last node
the edge lies. On Boulder that places 464 of the 496 crossings a
median 1.1 px from sphere-sim's trace, p90 9 px, worst 15. The other
32 are where a grid line runs along the edge, whose steps are all
alike and say nothing; those go halfway, and the edge actually lies a
median 0.7 of a cell out. Each cell the silhouette crosses is drawn
out to its crossings, in strips whose corners follow the same law, so
the band reads the texels sphere-sim's rays would: across Boulder's
edge cells, p90 1.0° from the trace, as close as the grid's own
triangles there.

The weight across that band is an estimate, and the one real choice
here. A blend handing over to another projector falls into the edge,
while a projector lighting its edge alone holds its weight to it.
Fading to zero across the whole band is right for the first and halves
the light at a lone rim; holding is right for the second and paints a
rim where sphere-sim's polar mask has none, since the mask's zero can
fall past the last node where no trend can see it. So the band follows
the nodes' own trend, never above the last node's weight, and fades to
zero over its last quarter, where the light arrives edge-on anyway.
Measured per pixel against sphere-sim's trace over seven rigs — Boulder
as designed and as built, SOS's nominal rig with four, three and two
projectors, a placed pair and a lone placed projector — that rule was
within 1.5 times of the best alternative on each of SOS's nominal rigs
and 4 to 18 times better than the staircase on all seven, on the
squared weight error weighted by incidence, which is how an error
shows on the sphere. Boulder is where it gives something up. Its blend
hands each side over before the edge, and fading to zero across the
band scores better there: 1.10 against 1.30 as designed and 1.07
against 1.81 as built, with the zero line below applied to both, where
the staircase scores 6.35 and 8.04. On the other five rigs fading is
1.6 to 4.5 times worse.

**The blend's own zero line is reconstructed too.** On a rig like
Boulder the silhouette is not the edge anyone sees. Its blend gives
each projector a longitude sector, crossfaded over 20°, and masks both
poles, so each projector's weight reaches zero well inside its disc:
up to about 30 px inside the silhouette on a 1680×1050 desk monitor. A
node past that line is written 0, and interpolated from those the
picture ends at a node, so the visible edge follows the grid's
columns. The second hardware import, after the silhouette work, still
showed a staircase down each side of each disc for exactly that
reason: one column held for 150 px of height, then a jump of about
20. So a node written 0 beside a lit one draws with the value its lit
neighbours' trend reaches there, which is below zero, and the shader
clamps it (`drawnWeight`). The picture then ends where the trend
crosses zero:

- On Boulder's P3 that line lands a median 6 px of its 3840×2160
  raster from sphere-sim's traced one (p90 11, worst 14). The
  staircase put it a median 33 px out, and up to 88.
- Over Boulder's four projectors, the light drawn where the blend has
  none falls from 17k px·w to 0.11k. On the same rig as built it falls
  from 16k to 0.43k.
- The band past the silhouette carries the value on, so a strip beside
  it crosses zero where the grid's cells do, not at its outer edge.
- On the lone placed projector the zero line is its polar mask, whose
  fall ends in a quadratic tail. There the trend lands a median 15 px
  inside the traced line, where the staircase landed 13 outside. That
  costs the tail's faint light and halves the light drawn past the
  mask.
- The other four rigs write no 0 beside a lit node, and draw as
  before.

What is left for the operator to see:

- a short step where a grid line runs along the edge, at the top,
  bottom and sides of each disc;
- an edge a few pixels off true, occasionally fifteen;
- the ring of cells just inside the edge, which is the grid's least
  accurate: there content lands a median 5.6 px from where it belongs
  and up to 28, where one ring further in the worst is 4;
- and, where a polar mask falls between the last node and the
  silhouette in less than a cell, a rim that stays bright to the edge.
  Boulder's does, at the top and bottom of each disc: on a 1680×1050
  monitor the fall takes about 14 px against a 13 px cell, and on the
  top row the band draws 0.76 where sphere-sim's trace has 0.07. No
  node says the mask falls there, so no trend can find it, and fading
  every band to zero instead would halve a lone projector's rim.

All four shrink with a finer export, which `buildWarpExport` already
takes as `cols` / `rows`. The exporter, which knows the silhouette
exactly, could put it in the file for every player, and
[zyra-project/sphere-sim#55](https://github.com/zyra-project/sphere-sim/issues/55)
asks it to. Its snapped ring would carry the mask's zero at the edge.
Neither is code here. Nor is the black floor in the overlaps, where
two projectors' black levels add: a warp file has nowhere to put it.

A desktop monitor exaggerates all of these. It shows each projector's
picture alone and gamma-encoded, so a stray weight of 0.03 reads as a
20% grey. On the sphere the neighbouring projector fills in, and the
same error adds 3% to its light. Judge an edge on the sphere.

#### Non-goals

MPCDI, which stays additive for later. A model whose UV set is an atlas
rather than an equirectangular unwrap: its warp addresses that atlas,
which only content authored for it can fill — a different job, as
§"Which surfaces" records. **Meshes whose `(u, v)` address a fisheye
frame**, the output of dome and mirror tools, meshmapper's among them,
are a non-goal **until a layout can declare the frame**. Today a
fisheye mesh is indistinguishable from an equirect one. When a layout
does declare one, it is refused rather than decoded. Surfaces are not
otherwise a non-goal: a dome or an ellipsoid unwrapped
equirectangularly is in scope and needs nothing the sphere does not *in
the mesh maths*. A dome's audience sits inside, which mirrors the
picture, and that is unhandled (§"Which surfaces"). Per-projector
colour and black-level matching. Authoring or editing a warp in
terraviz, which is sphere-sim's job. Placing one window across several
monitors. SOS's nine-point alignment files.

#### Verification, and what cannot be verified here

The pure module is testable end to end: the fail-closed parse, the
direction interpolation against P3's mesh and against a placed
projector aimed at a pole, both triangle drops, placement in clip
space, and the linear-light blend. Past that, a **parity fixture**:
sphere-sim's meshes plus a handful of pixel-to-texel answers from its
own tracer (`pixelToRay`, the intersection, `coordToUv`), checked
against this module's interpolation within the mesh's own
interpolation error. That error is not one number — about a pixel or
less in a raster's interior, 4 px one ring in from the silhouette, 28
in the ring beside it — so that last ring takes a tolerance of its own
rather than setting everyone's. There is no simulator round trip —
sphere-sim's page takes 2:1 content, not a pre-warped raster — so
everything past the fixture is Appendix B's W steps, on a sphere.

**Built, 2026-09-29**, as `src/output/projectorWarp.ts`, with the
fixture under `src/output/fixtures/projectorWarp/`: Boulder's P3 and a
placed projector at (2.5, 0, 2.0) with the north pole in view, as
sphere-sim `d46515d` writes them (its warp code is unchanged since
`40a51dd`), plus 818 texels its tracer puts inside them.
`scripts/generate-warp-parity-fixtures.ts` regenerates all of it
against a checkout. The figures above were centroids. Measured again
over every triangle at five points each, by the generator's own
arithmetic rather than the module's, the worst is **2.8 px** in the
interior (median 0.7), **5.2 px** one ring in and **28.4 px** beside
the silhouette, so the test's tolerances are 3, 6 and 30. Round the
pole, directions hold to 1.7 px where unwrapped `(u, v)` lands up to
66 px out, and the widest triangle on either mesh is 3.6 times its
median, as above. Seven deliberate breakages of the module — a
mirrored frame, one no-data marker, a flipped viewport, an encoded
multiply, no winding fix, a tight width bound, `(u, v)` interpolated
in place of directions — each fail at least one test.

**Upstream requests**, filed on sphere-sim 2026-09-26:
[zyra-project/sphere-sim#49](https://github.com/zyra-project/sphere-sim/issues/49)
asks for the viewport layout in the bundle — a prerequisite for any
rig that is not SOS's quadrants, and a safeguard for one that is — and
[zyra-project/sphere-sim#50](https://github.com/zyra-project/sphere-sim/issues/50)
for `warp.ts` to state that `i` is a linear-light weight. The second
would change no byte of output. It moves a fact from `blend.ts` into
the file every consumer actually reads. The first was filed before two
findings above, and a follow-up comment on it (2026-09-27) withdraws
the default by id it describes and requests the warp's baked rotation
as an addition to its manifest (convention 3).

**The first has landed: sphere-sim#52, merged 2026-09-29**, with the
rotation in it. Its bundles carry a root `layout.json`,
`sphere-sim/projector-layout@1`, with these fields:

- the framebuffer in pixels;
- `origin: "bottom-left"`, said out loud;
- `surface` and `rotationOffsetDeg` as a pair: a sphere with the
  rotation already taken off `u`, or a model with `null`;
- one entry per mesh, `{ id, mesh, viewport }`, where `mesh` is the
  archive path to pair by.

**This build reads it, the same day** (`warpImport.parseBundleLayout`):

- **Fail-closed, field by field.**
  - The format must match exactly, and a newer one is refused by name.
  - Every mesh must be paired by its `mesh` path. An entry naming a
    mesh the archive lacks is refused, and so is one naming
    `restore/warp/…`. So is a mesh listed twice or not at all, or an
    `id` that is not its own mesh's.
  - The viewports go through `placeWarpSet` before the panel draws
    them.
- **A layout this build cannot use is a refusal, never a fallback to
  the question.** The bundle said where its meshes go, and guessing
  there would be the misplacement the file exists to end.
- **With a layout, nothing is asked.** The panel shows the display with
  each mesh in its own place, the rotation already in them, and the
  display they were solved for against this one. One click imports.
- **The question is kept** for what has no layout: loose `.data`
  files, whose `layout.json` sits beside `warp/` rather than in it, and
  bundles exported before #52.
- **The texture rides the set.** It is stored with it and shown in the
  row as the warp's rotation. It is not part of the content id, since it
  changes no pixel, so one set placed either way is one set.
- **What `(u, v)` address, where the layout says so** (`uv`, added
  2026-10-02): `equirectangular`, or the import is refused.
  - sphere-sim writes no such field yet.
    [zyra-project/sphere-sim#57](https://github.com/zyra-project/sphere-sim/issues/57),
    filed the same day, asks for it under this name: `equirectangular`
    for the analytic sphere, and `model` for a `.glb`'s own UV set.
  - This build reads it ahead of its writer. It is the one field inside
    `@1` not ignored when unknown, because ignoring it is the misreading.
  - A layout without it reads as before (§"Which surfaces").
- **Fixtures.** They are regenerated at `cc44237` and cover three
  bundles: the SOS one with its layout, the same without, and a placed
  pair, which sphere-sim lays out as halves at full height. The meshes
  came out byte-identical.

The sphere-sim page still exports from the install rig, so every
bundle it writes today places SOS's quadrants. Nothing here waits on
that, but a placed rig's bundle will not come from the page until it
does. #50 is still open.

**A third request, filed 2026-09-30:**
[zyra-project/sphere-sim#55](https://github.com/zyra-project/sphere-sim/issues/55)
asks the exporter to snap its outer ring of nodes onto the silhouette.
Each snapped node would carry the weight just inside the edge: 0 where
a neighbour or the polar mask has taken over, and the full weight where
one projector lights its edge alone. It also asks `layout.json` to say
the ring is snapped. That would make the reconstructed edge
(§"What the operator will see") unnecessary for sphere-sim's bundles,
and put a polar mask's zero on the silhouette, where no node can show
it today. The flag is how this build would know to leave a snapped ring
alone rather than extend past it. It ignores fields it does not know
inside `@1`, so until it reads the flag it would try to.

**Cost:** about rung 14's. The pure warp module and the ZIP reader; the
`projector-warp` arm through protocol, aggregator and persistence; the
render-config field; the mode on the spawn URL; the manager's import
and per-set warp keys; the scene's geometry swap, direction prologue,
native sizing and blend; the HUD's count of dropped triangles; the
panel's import, layout question, viewport diagram, γ field, rotation
labels and clear control; locale strings, CLAUDE.md rows, Appendix B's
W steps, and the runbook section on spanning. The fetch's own seam is
not in it: that fix is `sos-equirect`'s as much as this mode's, and it
has already landed on its own.

---

## Roadmap after MVP

### Phase 2 — fisheye / dome projection + vector overlays + dome camera-tracking polish

The Three.js scene built for v1 already contains a fully
composited sphere. Producing fisheye output is a one-shader
change — swap `equirectRtt.ts` for `fisheyeRtt.ts` with a
different `(u,v) → direction` mapping. ~50 LOC, no architecture
change.

**That estimate holds for a dome and not for a projector**, and the
distinction was missing when it was written. A dome camera sits at the
sphere's centre like the equirect one, so it inherits `equirectRtt`'s
standing assumption — the camera is strictly inside, therefore every
ray hits, therefore the shader has no miss branch. A projector sits
*outside*: its rays can miss, and the ones that hit have two
intersections where the near one is wanted. `MAX_CAMERA_OFFSET = 0.85`
exists to hold that invariant, so a projector mode changes the module
rather than parameterising it. See §"Driving other display geometries".

**And for a real rig, prefer consuming a warp file to writing the
shader at all.** The same section records why: v1's equirect output is
already what the SOS ecosystem ingests, and `zyra-project/sphere-sim`
emits Bourke warp-and-blend files whose `u,v` are equirect coordinates.
That path skips the fisheye maths, the calibration and the blending
together, and is what the effort estimate below should be weighed
against.

**A dome's audience sits inside, and this phase inherits what that
does to the picture** (2026-10-02). A camera at the sphere's centre
renders each direction's texel as seen from inside. Content authored
like a globe therefore reads mirror-reversed east to west on the dome,
coastlines and any burnt-in text alike. Rung 16's warp has the same
property for the same reason (§"Which surfaces"). Fixing it is a
content setting, a viewing-side flip beside the content rotation, and
one setting should serve both.

The off-center camera plumbing (§3.5) already exists from v1
— the LED sphere uses it as its primary mode — so the dome
gets it for free. Phase 2's add is a **smoothing filter** on
the dome's `cameraOffset` so it doesn't jitter as the operator
pans (the LED sphere's physical inertia hides this; a flat
dome doesn't). Likely a 200 ms critically-damped spring on
the lat/lon target, with a configurable cap on angular
velocity. ~30 LOC.

In the same phase, country borders + gridlines on the sphere.
The approach recorded here was: pull the existing MapLibre
vector borders source, build a Three.js `LineSegments` mesh
from the resulting GeoJSON-equivalent line geometry, drape it
on a sphere shell at radius 1.0005, render alongside the
photoreal Earth. ~300 LOC. Its rejected alternative was
pre-rendering borders to an equirectangular raster overlay PNG
— cheaper at runtime but without zoom-aware label thinning,
dynamic styling, or per-dataset highlight overlays.

**That comparison assumed a mesh, and §3 removed it.** There is
no shell at radius 1.0005 to drape geometry on and nothing to
render "alongside": the equirect pass composites raster samples
in one fragment shader. So the two options are not as scored
above. Raster-first is now the *cheap* option rather than the
compromised one, because an equirect PNG is simply another
sampler; and keeping line geometry means either rasterising it
into an equirect texture each time the styling changes, or
drawing it analytically in the shader — tractable for a
graticule, not for coastlines. This is the constraint named in
"What the equirect path does to the Earth decoration", and it
is the one place in the plan where choosing direct RTT costs
something real. Phase 2 re-decides it on those terms; v1 is
unaffected, since borders were already out of scope.

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

**Most of the above is now a file format rather than a feature.** A
Bourke warp mesh carries geometry *and* blend per projector, which
subsumes `srcRect` / `dstRect` / `blendMask` and removes the reason to
build a blend-mask authoring tool — the calibration solver in
`zyra-project/sphere-sim` produces the mesh from camera images, which
is a better answer than dragging blend curves by hand. What survives
from the list above is per-output fixed-slot binding (unrelated to
geometry) and per-output colour correction (a projector-gamma problem a
warp file does not address).

Two things this rung would have to get right, recorded in §"Driving
other display geometries" and repeated here because this is where they
would bite:

- A calibration describes **one shared framebuffer with normalized
  per-projector viewport rects, bottom-left origin**. ~~Rungs 9-10 spawn
  N independent windows. Mapping between the two is small and silent
  when wrong — every projector mis-cropped, reading as a calibration
  error rather than a parsing one.~~ **Superseded by rung 16:** the
  rects are placed inside *one* output rather than mapped onto N
  windows. A projector mis-cropped or filed under the wrong viewport is
  still the silent hazard, which is why its import never places a mesh
  by its id alone — a placed rig reuses SOS's ids in other places.
- An arbitrary **surface mesh is a typed-array sidecar**, not JSON.
  Rung 10's persisted config lives in `localStorage`; a 5 MB mesh does
  not go there. A rig config needs a file reference. This is about
  surface meshes only — a Bourke warp is ~80 KB of text, and rung 16
  keeps an app-owned copy.

The honest gate remains real-world demand, but the *shape* of the work
has changed from "build a projector driver" to "consume an interchange
format and get two coordinate conventions right".

**Gate met for the sphere, 2026-09-26.** The operator who owns the
deployment asked for sphere-sim's warps on a real output, so this
phase's sphere half is rung 16. Specifying it changed the shape once
more: one output carrying every mesh rather than N windows, and three
conventions that fail silently rather than two coordinate ones. It
also reaches further than the sphere at no extra cost — any rig
sphere-sim calibrates, on any surface whose UV layout is
equirectangular, a dome among them. What stays gated is what a warp
file does not carry, per-projector colour and black-level matching,
and content for a model whose UV set is an atlas.

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

- **Mobile (iOS / Android).** Since this plan was first
  drafted, mobile became a shipped target: `bundle.iOS` /
  `bundle.android` in `tauri.conf.json`, a `deep-link` plugin,
  a separate `capabilities/mobile.json`, target-gated Cargo
  dependencies, and a `mobile.yml` workflow. Multi-output is
  **desktop-only and must not widen the mobile surface**.
  Concretely: `mobile.json` gains no permissions; the kiosk
  argv/env parse in `lib.rs` sits behind `#[cfg(desktop)]`;
  and the Outputs entry in the Tools menu stays gated on the
  existing desktop check, since `availableMonitors()` and
  `WebviewWindow.new()` have no meaning on a phone.
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

1. **Tauri window stacking on Linux — narrowed to Linux.**
   *Windows is answered.* A spike put borderless fullscreen
   output windows on both non-primary monitors of a
   three-monitor Windows 11 desk: `isDecorated: false`,
   `isFullscreen: true`, exact placement including a negative
   origin, and coverage over the taskbar rather than
   confinement to the work area. See "Monitor geometry and
   placement".

   That says nothing about Linux, which was always the risky
   half. Some compositors (sway, certain GNOME setups) treat
   fullscreen popups differently from Windows / macOS. Still
   need at least one Wayland and one X11 setup before
   declaring v1 done. The monitor-unplug failure case (§3
   "Failure recovery", case 4) also varies by compositor —
   pin down the actual behavior on the target install
   platforms as part of the same test pass. macOS is
   untested too.
2. **What to do when the operator opens an output but no
   dataset is loaded? — DECIDED.** Default: a "live Earth"
   idle state of base diffuse + night lights + clouds +
   terminator, which is what survives the unwrap. Not
   atmosphere: an equirectangular image has no limb for an
   atmosphere shell to be the silhouette of, so painting one
   in would put a fixed ring on the physical sphere. Nor is
   it free — the scene is not already running as a mesh — but
   the cost is one dot product and two extra samplers over
   the pass that has to run anyway. See "What the equirect
   path does to the Earth decoration".
3. **Telemetry — DECIDED, and landed** (rung 13b:
   `src/services/multiOutput/outputTelemetry.ts`, wired from the
   manager; positional layouts in `docs/ANALYTICS_QUERIES.md`,
   panels in `grafana/dashboards/product-health.json`). The
   schema below shipped as written, with three notes the build
   added rather than changed. `output_added` is emitted from the
   manager's private `spawn()` rather than from `addOutput`, so a
   launch-time **restore** reports exactly as an operator's Add
   does — the event describes an output existing, not a gesture,
   and one call site is what makes that true by construction.
   `framebuffer_bucket` snaps **down** to a rung, matching what
   `outputScene` actually renders, so a `4k` bucket can never
   stand for a window running 8K. And the reason enum's
   `rejected-by-storm-guard` is emitted where it reads oddest and
   means most — a spawn the guard refuses — because on a restore
   that *is* a configured output that never came back. A spawn
   the **decoder budget** refuses is deliberately not reported:
   the panel already shows "N of M in use" and disables Add, and
   an affordance the operator can see beats a report after the
   fact. Only `kind: 'crash'` has a detector today; the other
   four arrive with cases 2-5, one `emit()` each.

   > **Re-identification, considered and accepted.** Review
   > raised the one thing here that is not settled by the
   > per-field invariants. `monitor_index` and
   > `framebuffer_bucket` are each low-entropy and correctly
   > bucketed, but on a *restore* they are read out of the
   > persisted config and re-emitted **identically at every
   > launch** — the output count, their indices and their rungs
   > form a launch-stable tuple, on a population of
   > multi-monitor desktop installs that is small. No new
   > persistent identifier was added, so no escalation trigger
   > in `ANALYTICS_CONTRIBUTING.md` fires, and the rotating
   > in-memory session id is unchanged. The decision is that
   > this is proportionate: it describes an *installation*
   > rather than a person, and it adds a couple of bits over
   > `os` / `screen_class` / `country`, which are already
   > stable across launches for the same machine. Recorded here
   > rather than left to be inferred from a module header,
   > because the next person to add a field to these events
   > should be adding it to a tuple whose shape someone has
   > already looked at.
   >
   > **Rung 16 adds one bit to it and nothing else.** `mode` now
   > has two values, so it says whether an installation drives a
   > projector rig. `native` carries nothing beyond that bit,
   > because it is fully determined by `mode`. The obvious
   > alternative was rejected on this ground: bucketing a warp
   > window's real, spanned display size (7680×1200 across four
   > projectors, say) would fingerprint a specific rig. Nothing
   > from the warp set itself — its content id, a mesh count, the
   > blend gamma — is on any event. Adding any of them would put a
   > stable, installation-unique value on the wire, which is an
   > escalation trigger.
   The output window itself emits
   nothing. Telemetry from a capture-clean LED-sphere
   surface would also be a capture-clean policy violation
   (§3.6) — outputs phone nothing home. Three new events
   ship from the **control window**, all Tier A:

   - `output_added` — fields: `mode` (`'sos-equirect'`, and
     since rung 16 `'projector-warp'`),
     `framebuffer_bucket` (`'1k' | '2k' | '4k' | '8k'`
     bucketed to avoid identifying exact resolutions, or
     `'native'` for a `projector-warp` window, which draws
     projector rasters rather than an equirect frame, so no
     rung describes it),
     `monitor_index` (the position in the monitor
     enumeration — never the OS-reported monitor name).
     **Corrected from "0 = primary, 1+ = secondaries",
     which is not what shipped and would mislead an
     analyst.** Index 0 is the first display
     `availableMonitors()` returns, which is the primary on
     Windows by definition and usually on macOS, but on X11
     is whatever the enumeration happens to list first —
     `xrandr --primary` can mark any of them. `outputUI`
     asks the platform which is primary rather than
     inferring it, for exactly that reason, and no
     telemetry field carries the answer: a "primary vs
     secondary" slice over this field would be quietly
     wrong on the installations most likely to be running
     a sphere.
   - `output_removed` — fields: `mode`, `reason`
     (`'operator-close' | 'crash' | 'monitor-gone' |
     'gpu-loss-timeout' | 'rejected-by-storm-guard'`).
   - `output_failure` — fields: `kind`
     (`'crash' | 'hls-stalled' | 'ipc-silence' | 'gpu-loss' |
     'monitor-unplug'`), `retries` (number of recovery
     attempts before this event fired), `recovered` (boolean
     — true if the output continued, false if escalated to
     operator). One event per occurrence; bounded retry
     attempts collapse into a single event with `retries`
     populated.

   Plus a per-minute extension to the existing `perf_sample`
   on the control window: when outputs are active, the
   sample includes `output_count` and `sync_delta_p95_ms`
   (95th percentile of `local - broadcast` over the sample
   window). No new event type, just additional fields on a
   tier-A event that already ships.

   > **Not landed with 13b, and it needs a decision first.**
   > `output_count` is a read off `records`. `sync_delta_p95_ms`
   > is not: the drift is measured *in the output*, by
   > `outputSync` against its own decoder's `currentTime`, and
   > there is no path back — every `OutputEvent` variant reports
   > a state change, none carries a measurement. The control
   > window cannot derive it either, since only the output knows
   > where its own video is. So this needs a new `OutputEvent`
   > arm carrying the drift `outputSync` already returns and
   > rung 11's HUD already shows. That is a protocol change and
   > its own commit, and it does **not** breach "outputs phone
   > nothing home": the report goes to the manager over IPC, and
   > the manager is what talks to the network. Landing it with
   > case 3 (IPC silence) is the natural pairing — that case
   > adds output→manager traffic anyway. Per
   `docs/ANALYTICS_CONTRIBUTING.md`'s reviewer checklist:
   none of these new fields require hashing (no free-text)
   or sanitisation; tier choice is essential because
   installation health is the primary motivation; throttling
   is built into the event semantics (one per discrete
   action, no continuous emit).
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
6. **Tour integration depth — DECIDED.** Tours mutate the
   control window's globe state; outputs mirror that state
   via the normal state-diff path. **No tour-aware code in
   outputs.** The full reasoning + behavior matrix lives in
   §3 "Tour engine interaction" — tldr: `setEnvView` /
   `unloadDatasetAt` / `loadDataset(worldIndex)` reach outputs
   indirectly because they change which dataset / layers /
   view the primary panel is showing. Direct tour-→output
   tasks (a hypothetical `setOutput`) are deferred to Phase 4
   gated on real museum-kiosk demand.
7. **CONUS-bbox UV transform exactness.** *Largely resolved
   upstream since this was written.* The transform is no
   longer something the output has to match by
   re-derivation: `DatasetOverlayOptions` carries
   `boundingBox` / `lonOrigin` / `isFlippedInY` to every
   render surface, and `globeThumbnail.ts` already applies
   that bundle to a Three.js sphere off the same data —
   which is the output's exact problem, minus the
   projection. Carry the bundle and reuse that path (see
   "Prior art") and the question mostly answers itself.

   What remains open is verification rather than design, and
   it is still worth doing: side-by-side a CONUS-bbox
   dataset on the control globe and on the output, verify
   alignment to ≤1 px at 4K. The test fixture for commit 2
   should include a CONUS-bbox reference rendering.
8. **Multi-layer z-fighting — DISSOLVED.** The worry was that
   stacked sphere shells at radii 1.000 / 1.001 / 1.002 would
   z-fight on some GPUs at 4K+ render targets. There are no
   shells. The equirect pass has no mesh and no depth buffer,
   so layers composite in array order inside the single
   fragment shader (see "What the equirect path does to the
   Earth decoration") — an array index is not something a
   driver can disagree about, and there is nothing to verify
   per-GPU.

   What replaces it as the real ceiling is sampler count.
   WebGL guarantees only 8 fragment texture units, and the
   base map plus each layer's texture and its palette LUT all
   want one; hence `MAX_OUTPUT_LAYERS = 4`, which also happens
   to match the control window's own 4-globe ceiling.

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
  scales linearly. An earlier draft put the realistic ceiling
  at 4-6 outputs per workstation; a spike ran **sixteen** on a
  4090 laptop with no measurable sustained cost, so the number
  was a guess and is withdrawn rather than replaced. The risk
  that remains is real but different: the ceiling is
  **hardware-specific and unknown until measured on the
  deployment machine**, which is a provisioning question, not
  a constant. See "Cross-window decoder budget".
- **GPU memory pressure.** Each output holds a sphere texture
  (or two for multi-layer), an equirect framebuffer, and
  Three.js scene resources. Sixteen outputs at 8192×4096 held
  2 GB of render targets alone and stayed at full rate — on a
  4090. A museum NUC has an order of magnitude less to give,
  and the resolution picker multiplies it: the same sixteen
  outputs at 2048×1024 would be 128 MB. Resolution, not output
  count, is the lever operators should reach for first.
- **HLS decode pressure.** Sixteen simultaneous decodes ran at
  30.7 fps, 1.00× realtime, zero dropped — so "4 is a lot" was
  wrong on that hardware and may still be right on an iGPU.
  The Tools panel warning therefore cannot key off a fixed
  count. Warn against the machine's own budget, and surface
  the health signal that actually moves under load —
  steady-state frame rate and media-clock drift, **not** a
  dropped-frame counter, which stayed at 0 through every
  condition the spike could produce.
- **Which GPU the app lands on is not the app's to decide.** A
  spike on a hybrid-graphics laptop first reported
  `ANGLE (Intel, Intel(R) UHD Graphics …)` on a machine with an
  RTX 4090 — a completely different budget for both the
  equirect render targets and the video decoders (Quick Sync vs
  NVDEC), which is this section's whole subject. It moved to
  the 4090 only when the operator changed the NVIDIA Control
  Panel's preferred adapter.

  `probeGpuSelection()` then settled the confound inside a
  single run: `high-performance` and `low-power` returned the
  **same** adapter, `powerPreferenceWorks: false`. The app's
  request is inert on that machine — the driver decides above
  it. An earlier note in the spike proposing
  `additional_browser_args` with `--force-high-performance-gpu`
  is superseded by that measurement and should **not** be
  written into this plan as a fix; there is no
  environment-variable escape hatch either, as neither wry nor
  tauri reads one.

  The risk this leaves is a deployment one: an unattended
  installation can silently land on the iGPU, run at a fraction
  of the capacity it was provisioned for, and be undiagnosable
  from logs. Mitigations are to surface the renderer string in
  the Outputs panel's debug overlay so an operator can *see*
  which GPU is in use, and to document the per-OS override in
  the runbook (commit 15).
- **Operator confusion.** "Where did my video go?" is a real
  question if a user accidentally triggers fullscreen on the
  primary monitor. Borderless fullscreen output windows must
  always go to a *non-primary* monitor and refuse to spawn
  if only one monitor is connected. The Add Output button is
  hidden in single-monitor mode.
- **Silent installation degradation.** A long-running install
  that hits a network blip, driver hiccup, or monitor-cable
  jiggle could degrade silently if failure paths aren't
  designed in. Mitigated by §3 "Failure recovery" — a bounded
  stream rebuild over `hlsService`'s own retry budget,
  last-good-frame freezing throughout, IPC
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
- `docs/DATA_ENCODED_VIDEO_PLAN.md` — the `ColorScale` /
  `RenderEncoding` sidecar contract behind the `colorScale`
  field the mirrored state now carries.
- `docs/DATA_ANALYSIS_PLAN.md` §A1 — the display-transform
  model (`ColorScaleDisplay`, `buildDisplayLut`) the output
  mirrors, including the rule that a display transform never
  changes a reported value.

**Source to read before implementing**, in the order it will
be needed:

| File | Why |
|---|---|
| `src/services/globeThumbnail.ts` | Prior art for the whole output-side scene build — see "Prior art" above. Substantially delivery steps 2-4. |
| `src/utils/time.ts:334-390` | `computeSiblingSyncCorrection` — the playback control law, called not restated. `:231` for the `readyState` gate, `:259` for the hard-seek threshold, `:438` / `:482` for the read-back layer. |
| `src/services/datasetOverlayOptions.ts` | `overlayOptionsFromDataset` and `isEarthBody` — the overlay bundle the broadcast carries. |
| `src/services/colorScaleDisplay.ts` | `ColorScaleDisplay` and `buildDisplayLut` — the mirrored display transform. |
| `src/services/hlsService.ts:47,431` | The retry budget that already exists, so the output does not add a second one. |
| `src/utils/deviceCapability.ts:57-90` | `maxVideoPanels` and the terraviz#230 measurement behind it — the per-window cap the cross-window budget has to replace. |

---

## Appendix A: example output config

```ts
const outputs: PersistedOutputConfig = {
  outputs: [
    {
      label: 'output-1',
      monitorName: 'DELL-SOS-DRIVER',
      monitorOrigin: { x: -1680, y: 383 },  // physical, signed
      mode: 'sos-equirect',
      framebufferSize: { width: 4096, height: 2048 },
      trackOperatorCamera: true,   // see §3.5
      split: false,                // see §3.5
      rotationOffsetDeg: 0,        // see §3 "Calibration tooling"
      debugOverlay: false,
    },
  ],
  autoRestoreOnLaunch: true,
  concurrentDecoderBudget: 4,  // seeded; raised per machine
}
```

A multi-projector planetarium would extend the schema
post-Phase 3 with a `srcRect` / `dstRect` / `blendMask` triple
per output. The v1 schema is forward-compatible: new modes
add new fields; the parser ignores unknown fields.

---

## Appendix B: smoke-test checklist

Manual qualification steps for the user-reachable commits.
Runs on a dual-monitor Linux workstation (primary 1080p, the
operator's main display; secondary 4096×2048 or simulated via
RandR / Wayland output, the LED-sphere stand-in). Cross-
platform parity should also be checked on Windows and macOS
before declaring v1 release-ready, but Linux is the install
target so it gates the qualification.

Acceptance: every numbered step passes. No errors in the
manager log. Sync delta p95 < 200 ms (read off the debug
overlay added in commit 11). Failure-recovery actions emit
exactly one `output_failure` Tier A telemetry event per
occurrence (verify via `VITE_TELEMETRY_CONSOLE=true`).

> **Any step involving a video dataset needs
> `npm run build:desktop`, not `npm run dev:desktop`.** A spike
> hit this and spent real time on it. The CDN serving the HLS
> assets applies an origin allowlist, and it carries
> `tauri.localhost` (the packaged build's origin) but **not**
> `http://localhost:5173` (the dev server's). The shipped path
> is `HLSService` → hls.js → MSE, which fetches the manifest and
> every segment over XHR and is therefore fully CORS-gated, so
> in `dev:desktop` a video dataset cannot load *at all* — not in
> the control window, not in an output.
>
> Two corollaries. **Image datasets do work in dev**, and they
> cost a WebGL context while creating no decoder, so the dev
> loop still answers the context half of any ceiling question.
> And a plain `<video src=…>` pointed at the same URL **will**
> play in dev, because media elements are not CORS-gated unless
> `crossOrigin` is set — which makes it a trap, not a
> workaround: it proves nothing about the pipeline
> `datasetMirror` actually uses. Nothing client-side changes
> either fact.

### Results: first pass — Windows, 2026-09-11

**This is not the qualification.** The preamble above says a
dual-monitor Linux workstation gates it; this pass ran on
Windows, which is **step 46**, parity. It happened first
because that is the hardware that existed, which is a
reasonable thing to do and a bad thing to forget: the Linux
gate is still open, and nothing below should be read as
clearing it.

Setup, from step 1: control window on display 3, output
3840x2160 on display 2, rendered 2:1. Telemetry on Essential.
Devtools reachable with F12.

**What ran.** Numbered steps 1-4, 7-8, 10-13a, 15-20 and 22-30,
plus supplementary S1, S2, S6 and S7. Twenty-eight of those
passed. Five failed: **5**, **13**, **29**, **S1** and **S2**.

**Not run, and why.** Step 6 and step 21 both need the
secondary physically disconnected, which the session did not
do. Step 9's health badge and S4's stale-frame reporting are
rung 13, which is not built. Step 14 is blocked on a control
window that can stack datasets at all (see 14a). S3, S5 and
S5b were not reached.

**Measurements worth keeping.** Step 12b read a sync delta
ranging -1 ms to about -30 ms at 30 fps against a 4096x2048
framebuffer, on a global video over sixty seconds — comfortably
inside the 200 ms p95 the acceptance criteria ask for, and the
number to compare the next pass against. Step 12a passed, so
`syncByRatio` carries a dataset with no time axis on real
hardware. Step 13a passed, so a bbox lands where it should:
the failure in step 13 was lighting and playback, not
placement.

**The five failures, and what came of them.** All are fixed in
code and **none is confirmed on hardware** — that is what the
next pass is for.

| Step | Reported | Cause | Fixed by |
|---|---|---|---|
| 5 | No position diagram; nothing marked primary | Never built; the step described an intent | `880ba315` — the diagram, and primary asked of the platform rather than inferred |
| 13 | Dataset still lit with day/night on the output | The decoration composited *under* the layers, which only hides it for opaque global coverage | `64256a1c` — the Earth treatment is idle-only |
| 13 | "Playback seems to struggle", sync mostly a dash | Seek loop: a seek slower than the settle window earns another, and the element is mid-seek on ~99% of frames | `fa7a29ee` + `d5516a3e` — the seek-cost floor, and the bounds lifted while paused. **Not closed** — the second pass found the field still cycling dash ↔ thousands of ms, so the loop persists at a slower cadence; see that entry |
| 18 | Closing the output restored normal playback on the **control** window | Same loop, plus a playhead diff forcing a redraw at the control window's frame rate | `fa7a29ee`, `9c139d22` |
| 29 | Ctrl+Q did nothing | Never bound; the step asserted it as if it existed | `e7b021db` |
| S1, S2 | "Sync seems to break" / shows a dash | The same seek loop, seen through a HUD that could not say why | `fa7a29ee`, plus the HUD naming the reason beside the dash |

Step 18 is worth reading twice. It is recorded as a *pass* —
the output closed cleanly — and the sentence that matters is
the aside about the control window recovering. A checklist step
passing while its note describes a defect is the shape of thing
to watch for in the next pass.

**S7 and step 13 are the same bug from two sides,** which is
the most useful thing this pass produced. S7 passed: a Mars
dataset showed no terminator, no night lights, no clouds. It
passed for exactly the reason step 13 failed — under-composited
decoration *is* invisible beneath an opaque global texture, and
a Mars dataset is one. The rule only broke for the translucent
bbox overlay in step 13. A pass and a failure agreeing on the
mechanism is stronger evidence than either alone, and it is why
`64256a1c` gates on the slot count rather than tuning the
blend.

**What the next pass has to cover**, beyond re-running 5, 13,
18, 29, S1 and S2 against the fixes: the steps this one did not
reach (6, 21, S3), and then the Linux run that actually
qualifies. Steps 12c and 13b were added afterwards to make the
sync field and the bbox-video case answerable rather than
ambiguous; 5a was added because "nothing marked primary" is a
pass on X11 and a failure on the other two.

### Results: second pass — Windows, 2026-09-15

Not a checklist run: two targeted checks against fixes that
landed since the first pass, one of which came back negative
and is the more useful of the two. Same machine, same caveat —
Windows is step 46, parity. The Linux gate is still open and
nothing here touches it.

**Closing an output is confirmed on hardware.** Remove tears
the window down. That is `7d3cb393` and its replacement
`f9aa1475` — a self-only `close_self` command, after review
found a blanket `core:window:allow-destroy` reaches every
window rather than the calling one — and it is the one question
`acl_tests` cannot answer: `tauri::test`'s `MockRuntime`
settles whether the ACL permits the invoke, never whether the
window goes away. It does.

**The framebuffer hypothesis is dead.** The first pass left an
output at 8192x4096 running 18 fps and falling into
seek-recovery on a regional data-encoded video, and the
diagnosis recorded on PR #439 was fill rate, on the arithmetic
that 8192x4096 is 33.5M fragments against 4096x2048's 8.4M.
Re-running the same content one rung down:

| | framebuffer | fps | sync | link |
|---|---|---|---|---|
| first pass | 8192x4096 | 18 | seek-recovery, several thousand ms | not read |
| this pass | 4096x2048 | 16.9 | +7557 ms | live |

A 4x cut in fragments bought nothing, and the second number is
marginally *worse*. Whatever holds this loop at ~17 fps — about
59 ms a frame — does not scale with the framebuffer, so it is
not the ray-march. The #439 diagnosis was wrong; this is the
entry that says so, and the next pass should not spend the
framebuffer picker on it again.

**The `gpu` field paid for itself by ruling something out.**
The readout is `ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Laptop
GPU (0x00002717) Direct3D11 vs_5_0 ps_5_0, D3D11)` — the
discrete 4090, not the iGPU. That is precisely the failure
rung 11 added the field for, since a spike had found a webview
silently on the integrated part of a machine with a 4090 and
undiagnosable from logs. A ~17 fps ceiling on a 4090 is a much
sharper finding than the same number on an unknown adapter.

**The sync field cycles; it is not a standing offset.** The
`+7557 ms` above is one sample. Across both passes the field
alternates between a dash and a figure in the thousands, which
means the element is repeatedly entering and leaving a seek —
so the seek loop is **not** fixed, and an earlier draft of this
entry claiming the seek-cost floor had stopped it was wrong.
The first pass's table below calls it "a permanent dash"; that
is the same imprecision and the same behaviour.

What the floor plausibly changed is the *cadence*. The
simulation behind `fa7a29ee` had the element mid-seek on ~99%
of frames; a cycle measured in tens of seconds is a different
duty cycle of the same shape. The mechanism that fits: the
output plays slower than the primary, drift accumulates past
the threshold, a hard seek fires (dash), the seek lands, and
the drift begins accumulating again from ~0. At 16.9 fps
against a 30 fps source the output sheds ~0.44 s of content a
second, which reaches 7.5 s in about seventeen — the right
order for what the HUD shows.

**The consequence is the important part: no sync policy can fix
this.** `outputSync` can seek or decline to seek; seeking gives
the oscillation observed, declining gives a standing offset,
and neither is in step, because the content is not being played
at the primary's rate. `SYNC_MAX_RATE_TRIM` is 0.25, so the
correction can ask for at most 1.25x — and 1.25x of a rate the
pipeline cannot reach is still a rate it cannot reach. Anything
done in that module is rearranging which wrong answer is shown.

**A likely cause, and it is structural rather than a mystery.**
Data-encoded datasets ship **one** rendition. `DATA_ENCODED_RENDITIONS`
in `cli/lib/ffmpeg-hls.ts` is a single rung at 4096x2048, with
the reasoning already written there: the ABR ladder trades
picture quality for bandwidth and that trade is incoherent when
luma *is* the measurement, since the 1080p and 720p rungs would
hand a client averaged values nobody measured. Ordinary RGB
datasets get the full `DEFAULT_RENDITIONS` ladder — 4096x2048,
2160x1080, 1440x720 — and `hlsService.selectRendition` picks by
measured bandwidth.

So an ordinary dataset on a desk monitor is very often decoding
1.5M or 1.0M pixels a frame, and a data-encoded one is decoding
**8.4M, always, on every window, with nothing to fall back to**.
That cost is indifferent to the framebuffer, which is exactly
the signature this pass measured. It is not that the video is
greyscale — the transport is ordinary H.264 and flat chroma
compresses *better* — it is that "data-encoded" means full
resolution by design.

Two costs follow from the frame size, and the two HUD numbers
point at different ones:

- **Decode** is what the *sync* figure implicates. A slow render
  loop does not move a `<video>`'s playhead — the element
  advances on its own clock — so a drift this large means the
  element itself is stalling.
- **The per-frame texture upload** is what the *fps* figure
  implicates: `VideoTexture` re-uploads the decoded frame on
  every draw, ~8.4M texels here, in a second webview while the
  control window decodes the same asset in the first.

They may share one main-thread cause; nothing here separates
them.

**Two checks, both one click, neither needing code:**

1. **Load an ordinary RGB video dataset on the same output.**
   If fps goes to 30 and sync settles, the ceiling tracks
   rendition size and the single-rung ladder is what puts
   data-encoded content over it. This is the sharpest test and
   it directly answers "is this a data-driven video problem".
2. **Read the control window's own fps on the same
   data-encoded asset.** Also near 17 means the ceiling is
   decode and both windows share it; a steady 30 means it is
   something the output does that the control window does not.

(The first pass's "watch sync for 30-60 s" is answered: it
oscillates.)

**If check 1 comes back as expected this is a capability
ceiling, not a bug** — and it lands on precisely the content an
SOS installation runs, since data-encoded video is the reason
the feature exists. That makes it a Phase 5 design question
rather than something to tune, with two shapes worth weighing:
a mirrored rendition for outputs that is *explicitly* a display
copy and never a measurement (the values would still be read
off the control window, which keeps `DATA_ENCODED_RENDITIONS`'
premise intact), or `outputScene` uploading on decoder advance
rather than on every draw. Neither is established; recorded so
the next pass starts from the right question.

from here.

#### Addendum — the RGB comparison, same session

Check 1 came back, and it splits the problem in two. An ordinary
RGB dataset on the same output, same framebuffer:

| | dataset | fps | sync |
|---|---|---|---|
| data-encoded | 4096x2048 single rung | 16.9 | cycles dash ↔ thousands of ms |
| ordinary RGB | full ABR ladder | 18.8 | **-24 ms** |

**The sync half is content-specific.** −24 ms is comfortably
inside the 150 ms hard-seek threshold — the correction is doing
its job, on the same machine, the same window and the same
framebuffer that cannot hold sync on data-encoded video. So the
drift is not a property of the output as such.

**The fps half is not**, and that correction matters more than
the entry above gives it room for. 18.8 against 16.9 is the same
number, so the ceiling is **general to video on an output**, and
the paragraph above explaining it by the single-rung ladder is
wrong as stated. The likelier reading is that the ladder never
engages here at all: `selectRendition` picks the best rung the
measured bandwidth allows, and on a fast local link with the
asset cached — exactly the case `hlsService`'s own docstring
describes — that is the top rung for *both*. So both are
probably decoding 4096x2048, and `DATA_ENCODED_RENDITIONS`
explains why data-encoded content can never drop *below* that,
not why RGB is equally slow.

**What is left to explain the two halves separately:**

- **fps**, common to both: a cost paid per drawn frame that does
  not depend on the content. 18.8 fps is ~53 ms a frame, which
  at 60 Hz is landing on every third or fourth callback — the
  loop is a plain rAF gated at `VIDEO_FRAME_MS` (33.3 ms), so
  hitting 30 only needs each frame under ~16.7 ms. Tens of
  milliseconds for a ray-march at this size on a 4090 is far
  more than the shader should cost, which points at the
  per-frame `VideoTexture` upload — a 4096x2048 YUV→RGB
  transfer through ANGLE/D3D11, a path that is fast when it is
  zero-copy and very slow when it is not.
- **sync**, data-encoded only: decode, and the mechanism that
  fits at equal resolution *and* equal CRF is **entropy**. A
  data-encoded frame is a noise-like gradient field with poor
  inter-frame prediction; an SOS RGB animation is a largely
  static basemap with smooth overlay motion. At the same quality
  target the first carries far more residual per frame and costs
  more to decode. Hypothesis, not measured.

**Also reported and unexplained:** RGB datasets *sometimes*
freeze too. Not reproduced here, no HUD capture of one, and
nothing above predicts it — recorded so it is not lost.

**The next check isolates the fps half and takes one drag.**
Unload the dataset, then drag the control globe continuously and
read the output's fps. `shouldRenderFrame` returns true whenever
`dirty` is set, bypassing the frame cap, so a moving camera makes
the output redraw on **every** rAF callback with the full
ray-march and Earth decoration and **no video upload at all**.
Near 60 there means the shader is cheap and the upload is the
whole cost; near 18 means it is the shader, and neither a
rendition change nor a decode change will help.

> **Superseded — the check ran and the dichotomy was wrong.** A
> moving camera makes the output redraw on every callback, but the
> callbacks that set `dirty` arrive at the *control window's*
> render rate, so the reading is bounded by that and not only by
> this window. See the next addendum.

#### Addendum — the idle drag, same session

Check 2 came back: **~30 fps while dragging the control globe with
no dataset loaded, and 0 the moment the drag stopped.** Two
findings, and the first is that the check does not measure what the
entry above said it measures.

**The drag test is confounded, and the dichotomy above is false.**
`bindOperatorCamera` hooks the primary map's `move`, which fires
**once per rendered frame of the control globe** — so the output's
`dirty` flag is set at the *primary's* render rate, not at its own.
What the output reports while dragging is therefore `min(its own
draw capacity, the control window's render rate)`, and 30 fps
cannot tell those apart: a control globe painting MapLibre plus
`earthTileLayer`'s whole pass chain at 30 would produce exactly
this reading on an output capable of two hundred. "Near 60 means
the shader is cheap; near 18 means it is the shader" assumed the
output was the only thing being measured. It was not.

**What the reading does establish** is a floor: the idle path —
full ray-march, Earth decoration, atmosphere LUT, no layer —
sustains **at least** 30 fps, so it costs **at most** ~33 ms a
frame. That is a bound, not a measurement of it.

**Combined with a measurement already in hand, it is still enough
to move the fps question.** The 8192 → 4096 comparison above left
fps at ~17 either way. 8192 is four times the fragments of 4096, so
a shader-bound loop would have run roughly four times slower there;
it did not move at all. Fill rate is therefore not what holds the
loaded loop at ~53 ms a frame, which makes the drag test's 30 far
more likely to be the publish-rate ceiling than a shader cost. The
remaining candidate is unchanged and better supported: **a
per-frame cost proportional to the video's own resolution rather
than the framebuffer's** — the `VideoTexture` upload (4096x2048
YUV→RGB through ANGLE/D3D11), or the decode feeding it.

**Second finding: the HUD reads `fps 0.0` for a correctly idling
output**, which is a defect in the instrument, not in the output.
With no dataset `contentKindFor` returns static, the loop draws at
the 1 Hz floor, and `createFpsMeter` averaged over the ~500 ms
window between samples — so roughly every other window held no
drawn frame at all and divided zero by its own length. That
collapses the one distinction the floor exists to preserve: an
output that never redraws cannot tell a dropped upload or a lost
context from a correct frame, which is also the reading case 5
deliberately produces by skipping the frame rather than
drawing-and-counting it. Fixed: the window is now held open until
it contains a frame, and what is reported meanwhile is the bound
the silence implies (`1000 / elapsed`, minimum'd with the last
reading), so a stall still collapses toward zero — continuously
instead of by flicker — while an idle output holds near 1.

**And the instrument the last three checks were missing has been
added rather than worked around.** Every frame number on this HUD
was a *pacing* measurement, bounded by something other than the
draw — capped at 30 by the frame gate, floored at 1 Hz by the
static rung, ceilinged by the publisher during a drag — so none of
them could ever isolate capacity, and three hardware readings were
spent discovering that one at a time. The HUD now carries **draw**,
the mean wall-clock time inside `scene.render()` over the frames
since the last reading, directly under **fps**. It answers "can
this window keep up" on any content, with no drag and no second
window involved.

**So the next pass reads one pair of numbers rather than running an
experiment.** With a data-encoded video loaded and playing, read
**fps** and **draw** together:

| draw | means |
|---|---|
| ~50 ms | the draw is the whole cost. Since the framebuffer does not matter (8192 ≈ 4096), that is the texture upload, and the fix is upstream of this repo's shader — a smaller decode, or a path that does not round-trip YUV→RGB per frame |
| ~4 ms | the draw is nearly free and the loop is being *paced* into 19 fps by something outside it: the steer, the seek loop, or rAF itself being throttled |

> **Answered, and the table is only half right.** `draw` came back
> **under a millisecond** on both a data-encoded video and an idle
> globe — well past the second row. But the first row's reasoning
> does not simply invert, because a sub-millisecond draw does not
> exonerate the GPU. See the next addendum.

Then unload the dataset and read **draw** again with nothing
loaded. That is the idle shader's true per-frame cost, with no
publish rate in the way — the number the drag was reaching for.

#### Addendum — the draw cost, 2026-09-17

**`draw` reads under a millisecond — with a data-encoded video
loaded, and with nothing loaded at all.** Both cases, always.

**The good half:** the render is not CPU-bound. Uniform writes, the
per-frame sun, the draw-call submission and whatever `texImage2D`
costs the CPU are together under 1 ms, at 4096x2048, with a video
layer composited. Nothing else on the per-callback path can absorb
the missing 35 ms a frame either — `link.state()` returns a held
reference rather than a copy, `mirror.sync` is arithmetic over the
element, `checkHealth` is an integer compare.

**The half that retracts the entry above.** That entry's table said
a small `draw` would mean "the loop is being *paced* into 19 fps by
something outside it", and the field's own docstring said an
overrunning GPU would still show up in a window's mean, "charged to
whichever later call blocks on the queue". **Both are wrong for a
browser.** `render()` *submits*; the GPU executes afterwards. When
GPU work overruns the budget the CPU does not block inside
`render()` — it blocks at buffer swap, which the compositor owns
and which happens **between** rAF callbacks, inside nothing this
code times. So a GPU-bound output reads under a millisecond here,
exactly like a fast one. The field rules out CPU cost in the draw
and is blind to the GPU; the docstring and the module-map row now
say so.

That is the third hypothesis this log has retracted on the fps
question — fill rate, then the single-rung ladder, now the texture
upload as a *CPU* cost — and the pattern in all three is the same:
a reading was treated as a measurement of the output's capacity
when it was bounded by something else.

**So the instrument gained the denominator it was missing.** The
HUD's fps line now carries **raf** beside **fps**: how often the
browser *offered* a callback against how often the loop *took* one.
Ticked first thing in the callback, before any work. It is the fork
every reading so far has been missing, and it has an action on each
side:

| reading | means | what to do |
|---|---|---|
| `raf` ~60, `fps` ~19 | the callbacks are arriving and this loop is declining to draw on them | a bug in `shouldRenderFrame` or in what `contentKindFor` reports — ours to fix, in this repo |
| `raf` ~19, `fps` ~19 | the loop draws on essentially every callback it gets; the browser is only offering 19 | the cost is outside this JS — GPU execution, compositing a 4096x2048 canvas, or present. Then the 8192 ≈ 4096 invariance matters again: it says the cost does not scale with *our* fragment count, which points at the video upload or decode rather than the raster |

> **Answered, by a third shape neither row predicted: `raf` 30.0,
> `fps` ~22.** The loop is offered 30 callbacks a second and takes 22
> of them — so it is the first row in kind (ours to fix) at a rate
> the second row's reasoning never considered. See the next addendum.

One reading already leans: the idle drag sustained ~30 fps, which
needs at least 30 callbacks a second, so whatever throttles the
video case is not a fixed cap on the window. **Read `raf` in three
states** — a data-encoded video playing, an ordinary RGB video
playing, and idle while dragging the control globe — and the fork
resolves for both content kinds at once.

#### Addendum — the callback rate, 2026-09-17

| state | `raf` | `fps` |
|---|---|---|
| idle, no dataset | 30.0 | 1.0 |
| data-encoded video | 30.0 | ~22 |
| ordinary RGB video | 30.0 | ~22 |

**The idle row is the control and it is correct**: 30 callbacks
offered, one drawn, which is the static floor doing exactly its job
— and reading `1.0` rather than the `0.0` it reported two days ago.

**The video rows are a bug in this repo, and the gate is where it
lives.** The browser offers callbacks 33.33 ms apart. `VIDEO_FRAME_MS`
is 33.33 ms. So `sinceLastFrameMs >= frameIntervalMs` came down to
jitter in the last decimal, and every callback that fell short waited
a whole further one — a 33 ms frame becoming a 67 ms frame. Mixed,
that is ~22 fps against 30 offered, which is the number on the glass.

**This is what three passes of content-specific hypotheses were
chasing.** Fill rate, the single-rung rendition ladder, the
`VideoTexture` upload — each was proposed to explain a ceiling that
turns out to have no content term in it at all, which is why RGB and
data-encoded read the same 22 every time they were compared. The
mechanism is arithmetic between two constants.

Fixed by asking the right question: not *has the interval elapsed*
but **is this callback closer to the target than the next one will
be** — `sinceLastFrame + offered/2 >= target`. No tolerance constant,
since the offered interval is the scale the comparison belongs at,
and it resolves at every refresh rate.

**But `raf` 30.0 is itself a finding, and it is not ours.** A browser
schedules rAF on the compositor's frame clock, so 30.0 — flat, in all
three states, independent of load — is the **display** saying 30, not
the GPU struggling. The usual cause is a 4K monitor negotiating 30 Hz
over HDMI 1.4. Two consequences:

- **The output can never exceed 30 fps on that monitor**, which is
  the target anyway — but it means **zero headroom**: with the gate
  fixed, every single callback must now draw a 4096x2048 ray-march.
  If the picture stutters after this fix, that is the first thing it
  means.
- **Check the output monitor's refresh rate before blaming the app.**
  This belongs in rung 15's runbook beside the GPU-selection check,
  for the same reason: an installation can run at half its provisioned
  frame rate with nothing on screen to say so.

**What this does not explain is sync**, now reported bad on *both*
content kinds where RGB previously held −24 ms. Draw rate and playhead
drift are independent — `currentTime` advances on the wall clock
however often the sphere is painted — so the gate fix is not expected
to move it, and the entry above still stands: an output that cannot
play the asset at the primary's rate regenerates the drift whatever
`outputSync`'s threshold policy does. **The next reading is the sync
field on both kinds after this fix**, with the refresh rate of the
output monitor noted alongside it.

> **Half wrong, and the next addendum says how.** *Draw* rate and
> drift are independent; **callback** rate is not. `steer()` runs once
> per rAF callback on the output, and `publishPlaybackMirror` rides
> the primary's own loop on the control window — so the callback rate
> sets both how often the correction is applied and how stale the
> target it aims at is.

#### Addendum — 60 Hz, and sync in the healthy regime

First reading after the frame-gate fix, with the **output on the
4K Dell (Display 3, the primary) and the control window moved to a
different monitor**:

| state | `raf` | `sync` |
|---|---|---|
| idle, no dataset | 60 | — |
| ordinary RGB video | 60 | consistently **< 50 ms** |
| data-encoded video | 60 | consistently **< 50 ms** |

**Sync is in the regime it is supposed to be in.** Under 50 ms is
comfortably inside `SIBLING_HARD_SEEK_THRESHOLD_S` (150 ms), which
means the correction is converging on **rate trim and never
seeking** — the end of the seek loop that three entries above chased
through a settle window, a cost floor, and two content-specific
hypotheses. It is worse than the first pass's −1 to −30 ms and
better than anything since; at a 30 fps output, 50 ms is about one
and a half frames of offset.

**And it corrects the entry above.** That entry said the gate fix
was not expected to move sync, because "draw rate and playhead drift
are independent". Draw rate is. **Callback rate is not**, and two
paths carry it:

- On the output, `steer()` runs once per rAF callback — so the
  correction is computed and applied twice as often at 60 Hz as at
  30, and the control law's rate trim converges proportionally
  faster.
- On the control window, `publishPlaybackMirror` runs from the
  primary's own playback loop, which is rAF-driven. A control window
  at 60 Hz publishes the playhead every ~16.7 ms instead of every
  ~33.3 ms, so the target the output steers toward is half as stale
  before it is even sent.

Both windows moved from 30 Hz to 60 in this reading, so both
mechanisms fired at once. That is the fourth correction this log has
had to make on the frame-rate question, and the shape is familiar:
a claim about one variable stated as though it covered the whole
loop.

**Two things this reading does not establish, and both matter for
the runbook.**

- **`fps` was not reported**, and it is the number that confirms the
  gate fix rather than merely being consistent with it. At `raf` 60
  the gate should hold `fps` at **30** — the cap working, drawing on
  every other callback. Outstanding.

  A later review pass found this reading would have confirmed less
  than it looked: 60 Hz is an exact multiple of the cap, and so were
  the only other rates the gate was measured or tested at. A sweep in
  simulation put the nearest-deadline version at 25 fps on a 75 Hz
  display, 24 and 25 on 48 and 50, and *over* the cap on 33/35/40/100
  — because it measured from the last draw rather than from a carried
  deadline, which throws the phase away every frame. Fixed properly
  there; the consequence for hardware is that **a frame-rate reading
  taken at 30, 60 or 120 Hz does not generalise**, and a box running
  48, 50 or 75 is worth a reading of its own.
- **Two changes were made at once**: the display went to 60 Hz *and*
  the output moved onto it while the control window moved off. So
  this cannot separate "a window is paced by its own monitor" from
  "Chromium paces every window off the primary's vsync". The
  practical guidance is therefore the conservative one: **check the
  refresh rate of the output's monitor and of the primary**, because
  which one binds is unresolved.

**A note on resolution, since the 60 Hz mode costs some.** It costs
nothing on the sphere: the framebuffer is set by the Outputs panel's
own picker and `setSize(w, h, false)` leaves the window alone, so a
4096x2048 projection renders at 4096x2048 whatever the desktop is
running at — `output.css` letterboxes with `object-fit: contain`.
Refresh rate is worth more than desktop pixels on an output.

**And the link this was reached through is a finding of its own.**
The display is attached through a **Dell dock over USB-C**, which
Windows reports as *Connected to Intel(R) UHD Graphics* while the
HUD's `gpu` field reads a discrete 4090. Both are true: the 4090
renders and the integrated GPU scans out, with a cross-adapter copy
per frame in between — in exactly the region a sub-millisecond
`draw` cannot see into. A dock is also a shared DisplayPort
bandwidth budget that renegotiates modes when another monitor is
plugged in, which is how a 4K panel ends up at 30 Hz with nothing on
screen to say so. **Rung 15's runbook gets this beside the
GPU-selection check: an output monitor wants a direct cable from the
discrete GPU, not a dock.**

#### Addendum — confirmed on the glass, 2026-09-18

Three HUD captures, output on the 4K display at 60 Hz, control
window on another monitor:

| state | `data` | `sync` | `fps` (raf) | `draw` |
|---|---|---|---|---|
| idle, no dataset | — | — not-ready | **1.0** (60.0) | 0.2 ms |
| data-encoded video | `01KYK82V…` | **+0 ms** | **30.0** (60.0) | 0.3 ms |
| ordinary RGB video | `01KQG62X…` | **−9 ms** | **29.0** (60.0) | 0.4 ms |

`gpu` reads `ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Laptop GPU
(0x00002717) Direct3D11 vs_5_0 ps_5_0, D3D11)` on all three.

**The frame gate is confirmed, not merely consistent.** 30 of 60 is
the video cap drawing on every other callback; 1 of 60 is the static
floor drawing once a second. Both are now what the arithmetic says
rather than what the jitter allowed — the reading that was 22 of 30
two entries ago. The RGB row's 29.0 is one draw shy inside a 500 ms
sample window, which is the window boundary rather than a miss.

**The sync loop is closed on both content kinds.** `+0 ms` and
`−9 ms` are better than the "under 50" reported from the same
session and comparable to the very first hardware pass's −1 to
−30 ms — on the data-encoded asset that was cycling dash ↔ several
thousand ms two passes ago, and that three separate mechanisms were
built to chase (the seek-settle window, the seek-cost floor, and the
`syncByRatio` path). None of those was the cause. The cause was a
frame gate aliasing against a 30 Hz display, and a control window
publishing the playhead at 30 Hz into it.

**`draw` is 0.2–0.4 ms in every state**, including with a 4096x2048
video composited. The render was never the cost, which is what the
field was added to establish and what it now says three times over.

**And the two adapters are both confirmed, separately.** The
*render* adapter is the discrete 4090 through ANGLE/D3D11 — so the
plan's §Risks iGPU hazard did not fire here. The *scanout* adapter
is the Intel UHD Windows named on the display page, because the
panel hangs off a USB-C dock. Both true at once; the cross-adapter
copy between them is the per-frame cost `draw` structurally cannot
see, and it evidently is not binding at this resolution.

**What this does not settle.**

- **The Linux gate is still open.** This is a fourth Windows sitting;
  Appendix B qualifies on a dual-monitor Linux workstation and that
  run has not happened.
- **Which of the two 30→60 changes carried sync** — the gate fix on
  the output, or the control window publishing twice as often — is
  still entangled, and is no longer worth separating now that the
  outcome is right.
- **One sitting, not a soak.** Nothing here says what an hour of
  continuous playback in front of an audience does.

With that, the frame-rate thread that has run through five
consecutive addenda is closed, and the open items revert to the ones
it displaced: rung 15's runbook, the §6 app-command ACL, rung 13's
remaining failure-recovery slices, and the Linux qualification.

#### Open — second-window abort under WSL, 2026-09-18

**Not a qualifying run, and recorded anyway because of what it
might mean.** The Linux build was exercised under WSL2 + WSLg to
check that it compiles and boots at all. It does: the control
window renders, the catalog populates, the browse overlay and
chips lay out correctly. Adding an **output** aborted the process:

```
[xcb] Unknown sequence number while processing queue
[xcb] Most likely this is a multi-threaded client and XInitThreads has not been called
[xcb] Aborting, sorry about that.
terraviz: ../../src/xcb_io.c:278: poll_for_event:
  Assertion `!xcb_xlib_threads_sequence_lost' failed.
```

The output window appeared **white** first, then the abort — so it
was created and mapped, its webview never painted, and the process
died around the placement calls. Launched with `GDK_BACKEND=x11`,
which was itself needed to get the control window to appear
reliably.

**Three candidates, unseparated:**

1. **XWayland under WSLg.** Not a normal X server, and the control
   window needed a `wsl --shutdown` and a forced backend before it
   would map at all.
2. **Tauri/GTK multi-window on X11 generally.** GTK3 requires GDK
   calls on the main thread and Tauri marshals window creation
   across IPC to get there; anything touching X off-thread aborts
   exactly like this. **This one would be a real Linux bug.**
3. **`setFullscreen` specifically.** The spawn sequence is
   create-hidden → `setPosition` → `setSize` → `setFullscreen` →
   `show`, and WSLg's RAIL mode has no notion of a fullscreen
   display, making that the least well-defined of the five calls
   under this compositor.

**No fix is proposed and none should be written yet.** The obvious
one — `XInitThreads()` at startup in `lib.rs` — means adding an X11
dependency to work around a crash whose cause is unattributed, in
an environment that cannot qualify anything. That is the shape of
mistake this appendix has spent five entries recording.

**What it changes is the order of the Linux pass.** If candidate 2
holds, the feature does not work on Linux at all: the app dies the
moment an operator adds an output, on the platform SOS
installations run. So on the dual-monitor Linux workstation, **add
one output before anything else** — before the smoke checklist,
before any frame-rate reading. Three outcomes:

| on real Linux | means |
|---|---|
| no abort | WSLg's X path. Delete this entry, proceed with the checklist |
| aborts on X11, not on Wayland | backend-specific; worth a real fix, and `GDK_BACKEND` becomes a runbook line |
| aborts on both | candidate 2. The feature is blocked on Linux until it is fixed, and that outranks every other open item |

> **Answered under WSL, and it is the middle row.** Relaunched on
> the **Wayland** backend, the output window spawned with no abort.
> So **candidate 2 is out** — Tauri/GTK multi-window is not broken
> on Linux, which was the outcome that would have blocked the whole
> feature. What remains is X11-path-specific, between candidates 1
> and 3, and still worth separating on real hardware since plenty of
> SOS machines run X11 sessions. The immediate consequence is a
> runbook line rather than a code change: **launch under Wayland**,
> and if an installation must run X11, this is the first thing to
> re-test.

**Also worth carrying:** WSLg presents one virtual display, so
nothing about monitor enumeration, placement, signed origins or the
occupied-monitor guard was exercised. A **VM with two virtual
displays** would reach all of those and is the cheaper intermediate
target this detour should have used — real window manager, real
multi-monitor logic, no useful performance numbers.

#### Finding — the `gpu` field does not work on Linux, 2026-09-18

The same WSL launch read:

```
gpu   Apple GPU
```

on a Windows laptop with a discrete RTX 4090 and no Apple hardware
within a hundred miles. There is no route by which that names real
silicon. **WebKit sanitises `WEBGL_debug_renderer_info`** for
fingerprinting resistance and returns a generic string — Safari
reports "Apple GPU", and WebKitGTK inherits it from shared WebCore.

**This defeats the field's entire purpose on the platform that
matters most.** Rung 11's `gpu` row exists as *the* mitigation for a
risk the app cannot fix: a spike found the webview silently on the
iGPU of a machine with a 4090, `powerPreference` is inert, and
neither wry nor tauri reads an override — so an installation can run
at a fraction of its provisioned capacity, undiagnosable from logs.
On Windows it did its job and ruled that risk out. **On Linux it
will read "Apple GPU" on every machine**, and the SOS installations
this feature is for are Linux.

No code change is proposed: the field reports what WebGL gives it,
and there is nothing better to read from inside the webview.
What changes is **rung 15's runbook**, which must carry the Linux
procedure explicitly rather than pointing at the HUD:

| platform | how to check which GPU the webview got |
|---|---|
| Windows | the HUD's `gpu` field — names the adapter (`ANGLE (NVIDIA, … Direct3D11)`) |
| Linux | **from outside the app**: `glxinfo \| grep -i renderer`, or `nvidia-smi` while it runs to see whether the process is on the discrete card |

Worth keeping beside the dock finding, which is the same shape: a
diagnostic that reads one thing while the signal path does another.

#### Finding — no HLS on a default Linux install, 2026-09-18

Loading an HLS dataset (air traffic) on the same WSL build:

```
[App] HLS failed, falling back to direct MP4: Error: HLS is not supported in this browser
Uncaught: No playable video source found
```

**The second error is a consequence, not a second fault.**
`loadStream` reaches its `else` branch — `Hls.isSupported()` false
*and* `canPlayType('application/vnd.apple.mpegurl')` false — and
throws `hlsUnsupported`. `datasetLoader` catches it and asks
`pickDirectFile(manifest.files)` for a progressive file; this
dataset is HLS-only through the Vimeo proxy and has none, so the
fallback has nothing to offer and throws. The fallback behaved
correctly; it was handed an empty cupboard.

**The real fault is `Hls.isSupported()`, and the likely cause is
packaging rather than the engine.** hls.js requires MSE *and* that
`isTypeSupported` answer true for H.264/AAC. WebKitGTK answers that
through **GStreamer**, and a default Ubuntu install ships neither
`gstreamer1.0-libav` nor the bad/ugly plugin sets that carry H.264.
So the first thing to try is one apt line:

```
gstreamer1.0-plugins-good gstreamer1.0-plugins-bad
gstreamer1.0-plugins-ugly gstreamer1.0-libav
```

**Unlike the two findings above, this one has nothing to do with
WSL** — MSE availability and GStreamer codecs are properties of the
WebKitGTK build and the installed packages. It will reproduce on
bare-metal Linux with a default install.

**Two outcomes, very different in weight:**

| after installing the codec set | means |
|---|---|
| HLS plays | a **prerequisite**, not a defect. Rung 15's runbook gains a package list, and so does any `.deb` dependency declaration |
| `Hls.isSupported()` still false | MSE is off in that WebKitGTK build, and **every HLS dataset is unplayable on Linux** — including on every output, since `datasetMirror` loads the same way. That is larger than this feature and would need answering before any SOS deployment |

Worth stating plainly either way: **the desktop app's primary
dataset format did not play on a freshly provisioned Linux
machine**, and nothing in the repo told anyone it needed to.

**Addendum — the codecs fixed support, not playback.** With the
GStreamer sets installed the error moved:

```
[App] Error: Video took too long to load — check your connection and try again
  … enqueueJob / datasetLoader.ts:350
```

That line is the 20 s `canplay` timeout, and **where it is not**
carries most of the information. `loadStream` settles on
`MANIFEST_PARSED`, so reaching a wait for `canplay` at all means
`Hls.isSupported()` now answers true, hls.js initialised, attached
the media element, and parsed the manifest. The fallback warning
(`HLS failed, falling back to direct MP4`) is gone from the
console, and so is the `[HLS] Fatal error:` line that every fatal
hls.js error logs. So the escalation row above is **ruled out** —
MSE is on in that WebKitGTK build, and the codec set is the
prerequisite the first row predicted. Rung 15's runbook gains the
package list either way.

What is left is narrower and still open: the element never reaches
`readyState >= 3` inside 20 s, with hls.js reporting no fatal
error. Three candidates, in the order worth testing:

- **The compositing workaround.** `WEBKIT_DISABLE_COMPOSITING_MODE=1`
  was exported to get the window on screen under X11, and video on
  WebKitGTK renders through the accelerated compositing path. It is
  the one thing in that environment present by accident rather than
  by design, and the Wayland backend that fixed the window may not
  need it.
- **A fragment that never arrives.** A network failure *after*
  `MANIFEST_PARSED` cannot reach the MP4 fallback — the promise has
  settled, so `fail()` routes it to `reportFatal` instead of
  rejecting — and surfaces as exactly this timeout and nothing else.
  It would still log a fatal line, which the console does not show,
  so this is the weakest of the three.
- **Software decode of a 4096x2048 stream**, with no hardware
  decoder under WSLg. Slow rather than broken, and 20 s is a lot of
  slow.

One console line separates a feed problem from a decode one, run
after the error card appears:

```js
const v = document.querySelector('video')
console.log(v.readyState, v.networkState, v.error,
            v.buffered.length ? [v.buffered.start(0), v.buffered.end(0)] : 'nothing buffered')
```

`readyState 0` with nothing buffered is a feed problem; data
buffered with `readyState` stuck at 1 (`HAVE_METADATA`) is a decode
problem. Only the third candidate is WSL-specific, which is what
makes this worth carrying to the dual-monitor Linux box rather than
closing here.

**It read as the decode case, and all three candidates above are
retired.** From the console, on the failing load:

```
readyState 1   networkState 2   error null   buffered [5.999999, 94.099999]
duration 94.1  currentTime 0
```

Eighty-eight seconds of media appended cleanly, `duration` known,
no error, hls.js reporting nothing fatal. So MSE works in that
build, GStreamer parsed the init segment, fragments arrive and
appends succeed — which rules out the compositing workaround, the
fragment that never arrives, and decode being merely *slow*. It is
also why `buffered` is the reading worth taking first on any future
report of this: the error message names the connection, and the
connection is fine.

Two facts then separate. `duration` is **94.1** and the buffer ends
at 94.1, so the timeline is not shifted — the first six seconds
simply never appended, and the element sits at 0 in that hole.
`readyState` is defined at the *current playback position*, so a
hole at the playhead pins it at `HAVE_METADATA` however much is
buffered further on: **`canplay` cannot fire, and the 20 s timeout
was never going to be beaten by waiting longer.** Not slow, stuck.
The wait at `datasetLoader.ts` tests `readyState >= 3` and listens
for `canplay`, both position-relative, with nothing that notices a
buffered range the playhead is outside of.

But the hole is not the whole fault. Seeking to 10 — well inside
the buffered range — still read `readyState 1` half a second later,
so data at the playhead is not sufficient either. Both facts point
at the same place: WebKit computes `buffered` from *parsed samples*,
not from decodability, so a pipeline that parses and never prerolls
fills a buffer and holds `HAVE_METADATA` exactly like this. What
`isTypeSupported` answered true for is `avc1.42E01E` — Baseline
Level 3.0 — while the asset is 4096x2048, which is High profile at
Level 5.1 or 5.2. A codec registry more optimistic than the
installed decoder set would produce precisely this pair of
readings.

The hole has its own candidate worth keeping separate: `buffered`
on the element is the browser's **intersection** across source
buffers, so an audio track starting at a different time from the
video track offsets it. That is also the reason a missing AAC
decoder would present as a video problem.

**Resolved: WebKitGTK does not preroll until `play()`.** Calling
`play()` by hand on the stalled element:

```
readyState 4   paused false   size 2160x1080   decoded 579
```

Decodable, playing, frames coming out. Nothing is wrong with the
codecs, the profile, the resolution or the position — the pipeline
sat at `HAVE_METADATA` because **nothing had asked it to start**,
and `loadVideoDataset`'s ordering makes that unrecoverable: the wait
for `canplay` runs *before* the `video.play()` a few lines below it,
so on an engine that prerolls only on demand each waits for the
other. Chrome, Firefox and Safari preroll as soon as data is
appended, which is why one engine deadlocks and three do not, and
why it presents as a connection failure.

Fixed by extracting `waitForDecodableFrame` and having it **nudge**:
muted playback is started and left running, since the caller plays
the element immediately afterwards anyway to capture a first frame.
`readyState >= 3` still short-circuits, so an element still warm
from a previous dataset is not played. A rejected `play()` costs the
nudge and nothing else — an autoplay policy strict enough to refuse
a muted element belongs to an engine that prerolls on its own. The
regression test is the deadlock itself: a fake element that emits
`canplay` only in response to being played, which hangs the old
shape until the timeout.

**Two things this did not settle**, and both should be read off the
same box rather than assumed:

- **The six-second hole is still unexplained.** `buffered` began at
  6.0 against a `duration` of 94.1 before any seek, and the element
  now plays past it because the nudge starts it, but an element
  parked at 0 in a hole is a second latent failure. `buffered` on
  the element is the browser's **intersection** across source
  buffers, so an audio track starting at a different time from the
  video offsets it — the first thing to check, and worth comparing
  against the same dataset on Windows.
- **Nothing about 4096x2048 was exercised.** The element reported
  `2160x1080`: hls.js's ABR picked a lower rung, as it is left to do
  for any asset past `SHORT_ASSET_MAX_DURATION`. `isTypeSupported`
  answers for `avc1.42E01E` (Baseline 3.0) whatever the stream is,
  so a High-profile Level 5.x ceiling on WebKitGTK remains untested
  — and it is exactly the case with no fallback, since
  `DATA_ENCODED_RENDITIONS` is a **single** rung at 4096x2048 by
  design. Load a data-encoded dataset on the Linux box before
  concluding that HLS works there.

#### Finding — the iGPU hazard fired, on Linux, invisibly, 2026-09-18

Four HUD readings from one sitting, with the frame-gate fix in:

| State | sync | draw | fps / raf |
|---|---|---|---|
| Idle, no data | not-ready | **0.0 ms** | 1.0 / 58.7 |
| Smoke, seeking | seeking | **0.4 ms** | 12.4 / 12.4 |
| Air Traffic playing (2160x1080) | +69 ms | **57.5 ms** | 14.0 / 14.0 |
| Smoke playing (4096x2048) | -1267 ms | **302 ms** | 2.9 / 2.9 |

**`fps == raf` in all four**, so the frame gate is innocent here —
it takes every callback offered. That is the Windows bug ruled out
on a second platform rather than assumed fixed.

**The cost is the per-frame video texture upload, not the
ray-march**, and idle is what proves it: an idle output draws the
*full* Earth decoration — terminator, night lights, clouds,
atmosphere LUT — over the same 4096x2048 framebuffer, and reads
**0.0 ms**. Draw is ~0 whenever no new video frame exists (idle, or
seeking) and large exactly when one is advancing, scaling with the
**source** resolution: 4096x2048 is 3.6x the pixels of 2160x1080,
and 302/57.5 is 5.3x.

**`draw` is more informative on Linux than on Windows, and the
module map's claim about it was ANGLE-specific.** It said a
GPU-bound output reads under a millisecond because `render()`
submits and the block lands at buffer swap between callbacks. True
of ANGLE/D3D11; false on WebKitGTK, where the path is synchronous
and 302 of a 345 ms callback interval sits *inside* `scene.render()`.
Corrected in CLAUDE.md.

**And `glxinfo` caught what the app cannot see:**

```
OpenGL renderer string: D3D12 (Intel(R) UHD Graphics)
```

Not llvmpipe — hardware, through WSLg's D3D12 gallium translation
— but the **integrated** GPU, on a machine with an RTX 4090. This
is §Risks' iGPU hazard firing, and firing *silently*: the `gpu`
field exists precisely to catch it, and on WebKitGTK it reads
`Apple GPU` and names nothing. So the one in-app mitigation for
this risk is blind on the platform SOS installations run, and the
check must be `glxinfo -B` outside the app. That upgrades the
earlier "gpu field does not work on Linux" entry from a cosmetic
gap to a **missed detection of the exact failure it was written
for**.

Two things stay unseparated and should not be conflated when this
is re-run on real hardware: the adapter (iGPU vs discrete) and the
transport (WSLg's D3D12 layer, plus `WEBKIT_DISABLE_DMABUF_RENDERER=1`
if it is still exported from the X11 window workaround, which
forces frames through a CPU copy instead of a shared buffer).
`MESA_D3D12_DEFAULT_ADAPTER_NAME=NVIDIA` selects the discrete card
under WSLg and isolates the first.

**None of these numbers qualifies anything.** A dual-monitor Linux
workstation remains the gate. What this sitting establishes is
narrower and still worth having: the frame gate is correct on a
second engine, the expensive thing is the upload rather than the
shader, and the iGPU risk is real and undetectable from inside the
app on Linux.

**Addendum — the discrete GPU is unreachable here, and WSL is out
of road.** `MESA_D3D12_DEFAULT_ADAPTER_NAME=NVIDIA` does select the
discrete card at the Mesa level:

```
OpenGL renderer string: D3D12 (NVIDIA GeForce RTX 4090 Laptop GPU)
```

`glxinfo` is content on it. **TerraViz dies at launch**:

```
double free or corruption (!prev)
```

Controlled: same shell, `WEBKIT_DISABLE_DMABUF_RENDERER` and
`WEBKIT_DISABLE_COMPOSITING_MODE` both confirmed empty so the
`env -u` in the first attempt was a no-op, and the identical
command without the adapter override runs fine. One variable. The
first attempt bundled three changes and proved nothing; that is
recorded because it is the same mistake the fill-rate, rendition
and texture-upload hypotheses each made, and it is apparently easy
to repeat.

The asymmetry is the interesting part — a trivial single-context
GLX client is fine on that adapter and a multi-context,
multi-threaded webview heap-corrupts on it — which points at Mesa's
d3d12 driver or WSLg rather than at this repo. Unproven: nobody has
taken a backtrace (`gdb -batch -ex run -ex bt --args …`), and it is
not worth an hour here, because of what follows.

**Three configurations, none both stable and representative:**

| Config | Result |
|---|---|
| X11 | aborts on the second window (`xcb_xlib_threads_sequence_lost`) |
| Wayland + iGPU | runs; 302 ms draw, wrong GPU, no second display |
| Wayland + discrete | heap corruption at launch |

So the 302 ms can no longer be decomposed into *adapter* versus
*transport* in this environment at all: the experiment that would
separate them is the one that crashes. Every further hour here buys
numbers attributable to the translation layer rather than to the
app.

**Stop here.** A VM with two virtual displays has been the right
intermediate target since the first WSL entry, and this is the
point where it stops being a nice-to-have: the remaining Linux
questions — does an output place correctly on a second monitor,
does the frame gate hold, what does `draw` read on a real GPU —
each need a real window manager and a real second display, and none
of them needs WSL. What WSL *did* earn: the codec prerequisite, the
preroll deadlock and its fix, the font prerequisite, the frame gate
confirmed on a second engine, and the iGPU hazard shown to be
undetectable from inside the app.

#### Finding — every icon in the app is tofu on Linux, 2026-09-18

With the codec set installed and the two `datasetLoader` fixes in,
a dataset loads on Linux — and the transport bar renders as a row
of empty boxes. Browse, play, step, rewind, fast-forward, mute: all
tofu. The text beside them ("Browse", "CC", the colorbar numbers)
renders correctly, so a font is resolving; it just has none of
these glyphs.

**The app ships no font and no icon set.** Every control is a
Unicode symbol written as an HTML entity in `src/index.html` —
`&#x23EE;` rewind, `&#x25B6;` play, `&#x23E9;` step forward,
`&#x1F507;` mute, twenty-one in all, each followed by `&#xFE0E;`
(variation selector 15) to ask for the monochrome text glyph rather
than the emoji one. There is no `@font-face`, no bundled `.woff`,
no Google Fonts link anywhere in `src/`. The stack is
`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen,
Ubuntu, Cantarell, sans-serif`, so whether an icon appears is
entirely a property of the operating system's installed fonts.

That works by accident on the two platforms it was developed on.
macOS resolves these through Apple Symbols, Windows through Segoe
UI Symbol. A minimal Ubuntu has neither, and the media-control
block (U+23E9-U+23EE) lives in **Noto Sans Symbols 2**, which is
not in a default install; U+1F507 needs an emoji font on top of
that.

**On the box the prerequisite is an apt line**, beside the GStreamer
one — but it took two passes to get right, and the second half is
the part nobody would derive from the symptom:

```
fonts-noto-core fonts-noto-color-emoji fonts-dejavu-core fonts-symbola
```

The twenty-one codepoints split into **two dependency classes**, and
installing for the first leaves the second still broken:

| Class | Codepoints | Needs |
|---|---|---|
| BMP symbols | `21E5` `23E9`-`23EE` `23F8` `23F9` `25B6` `2699` `2715` `27A4` | DejaVu Sans / Noto Sans Symbols 2 — ordinary font packages |
| Astral-plane emoji | `1F4AC` chat, `1F507` mute, `1F5D1` delete, `1F97D` VR | a **monochrome** emoji font |

After the first three packages the transport bar came back and the
four above U+FFFF were still tofu. The reason is the variation
selector: every icon is written `&#x1F4AC;&#xFE0E;`, and `FE0E` is
**VS15**, which asks for the *text* presentation. `fonts-noto-color-emoji`
supplies the **colour** glyph, so WebKit — honouring VS15 by
preferring a text-presentation font — can decline it and fall
through to tofu. An emoji font installed, and still no glyph.
`fc-list :charset=1F4AC family` tells you which case a box is in.

Worth recording because the obvious fix is wrong: **dropping the
`&#xFE0E;` would also make the glyph appear**, and would give
macOS and Windows colour emoji where they currently render
restrained monochrome glyphs matching the rest of the chrome. A
cartoon speech balloon in an operator UI is a regression, not a
repair.

**As a product matter it is larger than that, and it lands on the
platform SOS installations run.** A projector rig provisioned from
a minimal image shows an operator a transport bar of empty
rectangles — every control unlabelled, with no error and nothing on
screen to explain it. Three ways out, in increasing order of cost
and correctness:

| Approach | Cost | Verdict |
|---|---|---|
| Document the font packages as a Linux prerequisite | one line in rung 15's runbook | necessary now, insufficient alone — it fails silently on any box that missed it |
| Add `'Noto Sans Symbols 2', 'DejaVu Sans'` to the stack | one line of CSS | **does nothing** on a box that lacks them, and fontconfig already falls back across whatever *is* installed; it buys the appearance of a fix |
| Replace the entities with inline SVG | a UI change across ~21 controls | the actual answer — no font dependency, scales crisply, themes with `currentColor`, and it is what the rest of the app's chrome already does |

The SVG migration is **not** multi-monitor work and should not be
folded into this plan's ladder; it is recorded here because this is
where it was found and because rung 15's runbook needs the apt line
either way. The same reasoning as the GStreamer codecs one entry
up: a prerequisite is worth writing down, and is not a substitute
for the app not needing it.

### Commit 9 — Tools → Outputs panel (first user-reachable)

**Pre-flight:**

1. Both monitors connected; `npm run build:desktop` artifact
   launched. `npm run dev:desktop` is fine for iterating on
   window management and image datasets, but **not** for any
   video step — see the note above.
2. Telemetry tier set to Essential (default).
3. Console open via F12 on the control window for log inspection.

**Panel basics:**

4. Tools menu shows an "Outputs" entry.
5. Outputs panel opens; lists both monitors with name,
   resolution, position diagram. Primary clearly marked.
   Check all four: the picker's option text carries the name,
   the pixel size, and `(primary)` on exactly one display; the
   diagram above it draws one rectangle per display, to scale
   and in the arrangement the desk has them. Changing the
   picker must move the diagram's highlight — that is the
   confirmation the step is really for, since an output opens
   fullscreen and an operator has one chance to notice it is
   about to land on the wrong display.
5a. **Nothing marked primary is a pass, on X11.** The primary
   is asked of the platform rather than inferred, and X11 can
   leave no display marked at all; the panel then marks none
   rather than guessing at the one nearest the origin. On
   Windows and macOS a missing marker *is* a failure. If the
   arrangement is primary-left — the spike's secondary sat at
   `x = -1680` — check the diagram is not drawn with a display
   hanging off its left edge, which is what an assumed
   non-negative origin looks like.
6. **Single-monitor guard.** Disconnect the secondary monitor.
   Add Output button is hidden / disabled. Reconnect:
   the button reappears.

**Spawning an output:**

7. Click Add Output → pick the secondary → Confirm. The output
   window appears within ~1 s, fullscreen on the secondary,
   black until ready. No title bar, no menu bar, no cursor.
7a. **Aspect.** On a secondary that is not 2:1 the frame is
    letterboxed — a 2:1 image with equal black bands top and
    bottom, each `(1 - aspect / 2) / 2` of the height, where
    `aspect` is the *monitor's* own width over height. That is
    ~5.6% on 16:9 and ~10% on 16:10, so it is not a constant
    and the number to check against is the one that formula
    gives for the panel in front of you. Confirm that is what
    the display shows, and photograph it. This is the first
    hardware contact with the frame/monitor mismatch in "Not
    every monitor is 2:1"; whether the bands are correct
    depends on what the downstream device expects, so record
    the behaviour rather than judging it here. Bands of *unequal*
    height, or a full-height image, is a bug — the first says
    the window is not where the manager put it, the second
    that something is stretching the projection.
8. Output renders the photoreal Earth idle state (no dataset
   loaded yet): base diffuse, re-projected, **with** the
   day/night terminator, night lights and clouds rung 12c
   wired. Specular, atmosphere, sun and ground shadow never
   cross to an unwrap at all, so their absence is the pass
   condition rather than a gap. A black sphere is a failure;
   so, now, is a flat evenly-lit one — that was the pass
   condition before 12c and it means the decoration did not
   reach the shader. The lit hemisphere should match the
   control globe's, since both read one `getSunPosition`.
9. The Outputs panel lists the new output with health badge:
   healthy.

**Global video dataset:**

10. In the control window, load a global HLS video dataset
    (e.g. SST). The output mirrors within ~1 s of the load
    completing on control.
11. Play / pause / scrub on the control window: each action
    propagates to the output within 200 ms p95 (verify via
    debug overlay sync delta in commit 11; for commit 9 just
    eyeball that play/pause feels synchronous).
12. Let the video play for 60 s. Open the output's debug
    overlay (commit 11) — sync delta should remain ≤ 200 ms
    p95 with no visible drift on the LED-sphere mock.
12b. **Read the sync field for the sign of a seek loop.** A
    number parked just past the hard-seek threshold — the field
    case was a steady `-166 ms` against 150 ms — with visibly
    choppy playback is not a slow output; it is the correction
    fighting itself. A seek stalls the element while the
    primary plays on, so a seek that takes longer than the
    threshold leaves the output far enough behind to earn
    another one, once per rendered frame. `outputSync` closes
    that loop three ways: it does not steer a seeking element,
    it raises the threshold for `OUTPUT_SEEK_SETTLE_MS` after
    each seek so the trim gets a chance to converge, and it
    holds the threshold at the *measured* cost of the last seek
    for as long as that measurement stands (see "A seek is not
    free"). If the field still parks above the threshold once it
    is *smooth*, that is a real measurement of an output's floor
    — a second window, a second decoder, an IPC hop — and the
    case for an output-specific threshold, which does not exist
    yet and should not be invented without it.
12c. **A dash is a reading too.** With no number, the sync field
    prints why. `— not-ready` against a still image is the
    correct answer and needs nothing. `— seeking` on most
    samples is the loop above: the element is mid-seek almost
    every frame, which is a decoder re-decoding from a keyframe
    rather than playing, and it reads on the sphere as playback
    that struggles. Record which one you see — the first pass
    could only report "sync just shows a dash", and the two want
    opposite responses.
12a. **A dataset with no time axis.** Load one of the SOS
    looping animations — Air Traffic is the canonical case:
    global video, no `startTime`/`endTime`, a 24-hour loop
    with the clock and the terminator burnt into the frames.
    It has to be its own step because it takes its own
    steering path (`outputSync`'s `syncByRatio`): there is no
    real-world instant to place, so the output is steered on
    its position *within the clip*. Press play — the output
    must start, and the burnt-in clock must read the same
    number the control globe's does. A frozen output here is
    the bug this step exists to catch, and its symptom is
    deceptive: frame zero of a 24-hour animation is a world
    lit twelve hours away from the operator's, which reads as
    a **projection** error rather than a playback one. It was
    first reported from hardware as "the outputs are 180° off
    in longitude".

**CONUS-bbox image dataset (Open Question 7):**

13. Load a CONUS-bbox image dataset (e.g. a NEXRAD radar
    composite or a hurricane snapshot). The bbox overlay on
    the control globe and on the output sphere align to ≤1 px
    at 4K — verify by visual side-by-side using the test
    fixture from commit 2.
13a. **Read it with camera tracking off.** A domain wider than
    CONUS substitutes fine, and is the harder test rather than
    the easier one — it reaches the latitudes where an
    equirect's row spacing is most stretched. But *any* bbox
    check has to be judged with the output's "Track operator
    camera" toggle off, which hands that output `CENTRED_CAMERA`
    and makes the unwrap the identity. There a column is
    longitude linearly (`lon = (x / W) * 360 - 180`) and a bbox
    error is a rigid shift with a number on it. Under a tracked
    camera the offset warp magnifies one hemisphere and
    compresses the antipode, so the same error is many pixels
    near the centre of focus and almost none at the edges —
    enough to catch gross misplacement, never enough to support
    the ≤1 px claim above.

13b. **A bbox *video*, which is the harder case.** Step 13 asks
    for an image because the bbox alignment is easier to judge
    on a still. Run a bbox video as well — a data-encoded
    forecast is the canonical one, since those are published as
    uploaded rather than transcoded and so carry whatever
    keyframe spacing the producer wrote. That makes their seeks
    expensive, which is what the seek-cost floor exists for, and
    it is what the first hardware pass hit
    (`north-america-smoke`). Watch for three things together:
    the picture stuttering rather than playing, the sync field
    reading `— seeking`, and the **control** window's own
    playback slowing while the output is up. Those are one
    symptom, not three.

**Multi-layer:**

14. With the SST base loaded, add a foreground layer (e.g.
    cyclone tracks). Output renders both with the correct
    z-order (cyclone tracks sit on top).
14a. **Not runnable yet, and not because of the output.** The
    output half of this is built: `layerStack` unrolls
    `MAX_OUTPUT_LAYERS` slots that composite in array order
    inside one fragment shader, and `outputScene.setLayers`
    binds them. What is missing is the *control* half — the
    app has no stacked-dataset concept to mirror. `PanelState`
    holds exactly one `dataset`, and the "what gets mirrored"
    table above names the source for `layers[]` as a **new**
    `layerStack` state in `main.ts`, which was never built. So
    `layers` is not a publisher waiting to be wired: wiring one
    today would publish an empty array forever. Building it is
    a control-window feature (stack two datasets on one globe,
    with an order the operator can change), and this step is
    blocked on that rather than on anything under
    `src/output/`. Skip it until then rather than recording a
    failure.

**Camera tracking + split:**

15. **Track operator camera ON (default).** In the control
    window, zoom in on a hurricane (~zoom level 5). The
    sphere turns the hurricane to its front — on the
    equator, at the meridian the rotation offset names —
    and the AOI fills more of the sphere there; the
    antipode should compress visibly. Pan around — the
    sphere should turn with ≤30 ms lag. Pan to Antarctica:
    the pole comes round to the front, as it sits on the
    control globe. Right-drag to twist the control globe:
    the picture at the front twists with it. **Failure
    signature:** the AOI magnified where it lies rather than
    at the front — the pole at the bottom of the sphere —
    which is a build without the turn.
16. **Track operator camera OFF.** Toggle off in the per-
    output config. The output snaps back to a uniform 1:1
    equirect, unturned, regardless of where the operator
    pans.
17. **Split sphere ON.** Toggle on. The current AOI now
    appears at U=0.25 and U=0.75 of the equirect (visible
    as two copies of the area of focus, each facing its
    own front, 180° apart). Toggle off: returns to single
    AOI.

**Teardown:**

18. Close the output via the panel's close button. Window
    destroys cleanly within ~500 ms; record removed from
    the panel; no orphans visible in the console (no
    "WebviewWindow already exists" errors on next spawn).

### Commit 10 — persistence

19. With one output running, opt in to "Restore outputs
    on launch" in the panel.
20. Quit the app. Relaunch. The output spawns on the same
    monitor at the same `{x, y}` with the same `mode`,
    `framebufferSize`, `trackOperatorCamera`, `split`,
    `debugOverlay` settings.
21. Disconnect the secondary monitor. Quit. Relaunch. The
    persisted output is logged as "monitor not found" and
    skipped — not silently moved to the primary. Outputs
    panel shows the entry as "disconnected" / re-spawnable
    once the monitor returns.

### Commit 11 — debug overlay + framebuffer resolution picker

22. Toggle "Debug overlay" on for the running output. HUD
    appears in a corner showing dataset id, sync delta (ms),
    fps, and the WebGL renderer string. Numbers update at
    ~2 Hz. On a hybrid-graphics machine, check the renderer
    string names the discrete GPU — a spike found the webview
    silently on the iGPU of a machine with a 4090, and the
    app cannot choose for itself (see Risks).
23. Change the output's framebuffer resolution from
    4096×2048 to 8192×4096 via the panel. The output rebuilds
    its framebuffer; debug overlay reports the new
    resolution; fps may drop (expected on the secondary's
    GPU).
24. Change back to 1024×512 — for "preview the LED sphere
    on a 1080p monitor" workflow. Note the buffer is now
    *smaller* than the window, so this scales up, not down:
    the expected result is a soft 1920×960 image with the
    same bands as step 7a, not a small image in the middle
    of the screen. The picker changes the framebuffer, never
    the window.
24a. **The ladder is this mode's, not every mode's.** Both
    rungs above keep height at exactly half the width,
    because an equirectangular frame that is not 2:1 is not
    equirectangular. Whoever adds a second `OutputMode` gives
    it its own rungs rather than widening these — see
    "Geometry is a per-output configuration".

### Commit 12 — fullscreen + kiosk

25. Tools → Fullscreen on the control window. Title bar
    disappears, window goes fullscreen on the primary. Tools
    menu still accessible. Toggle off — title bar returns.
26. Quit, relaunch — control window remembers its previous
    fullscreen state.
27. F11 on the control window: same toggle behaviour.
28. F11 on an output window: title bar appears (escape
    hatch). F11 again: title bar disappears.
29. **Kiosk launch.** Quit. Launch with `--kiosk` (or
    `TERRAVIZ_KIOSK=1` env). Control window is fullscreen +
    decorationless from first paint. Ctrl+Q exits cleanly (Cmd+Q
    on macOS, which the system menu already provides — Ctrl+Q is
    bound on all three platforms and Cmd+Q is deliberately left
    to the OS rather than handled twice). The first pass recorded
    this as a failure — "Ctrl-Q doesn't seem to do anything,
    Alt-F4 does" — and it was right: the step asserted the
    shortcut as if it existed and nothing bound it. Alt+F4 is the
    Windows answer and there is no portable one, which is why a
    kiosk window with no close button, no title bar and no menu
    bar needed this.
    Then open Tools: the fullscreen button must already read
    "Exit fullscreen" — that is `queryFullscreen()` seeding the
    controller from a window Rust made fullscreen before any of
    the TypeScript ran. **This step is the only thing that
    exercises `apply_kiosk`.** CI compiles `src-tauri/` on all
    three desktop platforms and the flag's parsing is
    unit-tested, but nothing has ever *run* those window calls;
    a launch is the test, not another reading of the code.
29a. **A set variable is not a true one.** Launch with
    `TERRAVIZ_KIOSK=0`. The window must come up ordinary —
    windowed and decorated. This is the case a presence test
    would get wrong, and the one a deployment templating a
    single unit file across several machines actually hits.
30. **Cursor auto-hide.** With control window fullscreen,
    leave the mouse stationary for 3 s (`CURSOR_IDLE_MS`).
    Cursor disappears — over the panels as well as the globe,
    which is what the `*` selector in `base.css` is for. Move
    the mouse — cursor reappears immediately. Leave fullscreen
    with the cursor hidden: it comes straight back, rather than
    stranding an operator with an invisible pointer over a
    windowed app. *(This step said 4 s while §3.6 and the
    ladder row both said 3; the code follows §3.6.)*

### Commit 13 — failure recovery

For each case, verify exactly one `output_failure` Tier A
telemetry event fires (visible in the console batch when
`VITE_TELEMETRY_CONSOLE=true`).

31. **Output crash.** Kill the output's webview process via
    OS task manager / `kill -9 <pid>`. Control window shows
    toast "Output {label} crashed — removed" within ~2 s.
    Record gone from the Outputs panel. Telemetry event
    `kind: 'crash'` fired.
32. **Crash storm guard.** Spawn an output, kill its process,
    re-add, kill again, re-add, kill again — all within
    60 s. The 4th Add Output attempt for that monitor is
    refused with a toast "Monitor {name} unstable; not
    re-adding this session." Counter resets after relaunch.
33. **HLS stream failure.** Block the HLS endpoint via
    `iptables` or pull the network cable mid-playback. The
    output's texture freezes on the last good frame within
    ~1 s. Status badge transitions: healthy → retrying (after
    1st backoff) → stalled (after 3 retries, ~7 s). Restore
    the connection. Operator manually reloads the dataset:
    output recovers; badge clears.
34. **IPC silence (manager pause).** Pause the control
    window's main JS thread via Chrome devtools' debugger
    "Pause" button for 10 s. Output enters stale state
    after 5 s (no audience-visible change; last good content
    keeps rendering). Outputs panel shows the stale badge.
    Resume the debugger: stale badge clears within 5 s.
35. **Control-window reload + reattach.** With an output
    running, reload the control window's page (Ctrl+R in dev,
    or `location.reload()` from a console). The output keeps
    rendering throughout. The reloaded manager's boot scan
    finds it, pokes it with `OUTPUT_REATTACH_EVENT`, and the
    output re-announces; the panel lists it again and its
    badge returns to healthy within a second or two. The
    audience sees no interruption.
    **Not `kill -9` on the control window's PID**, which this
    step used to say: every window is in that one process, so
    killing it takes the outputs with it and there is nothing
    left to reattach to. See case 6.
36. **GPU context loss.** Open Chromium devtools on the
    output (F12 in dev mode), Performance → Settings →
    enable "Disable WebGL". The canvas goes black; output
    state shows `gpu_context_lost`. Re-enable WebGL: scene
    rebuilds within ~3 s (texture re-fetch + shader
    re-compile). For platform-driver tests, use
    `chrome://gpu` → "Force GPU restart" instead of the
    devtools toggle.
37. **GPU loss timeout.** Disable WebGL and leave it
    disabled for 35 s. After 30 s, output records itself as
    unrecoverable; manager removes it. Operator manually
    re-adds.
38. **Monitor unplug.** With an output running on the
    secondary, disconnect the cable. Toast appears within
    ~2 s ("Monitor {name} disconnected"). Wait 60 s. Outputs
    panel shows close prompt. Reconnect: monitor returns,
    output position restored to persisted `{x, y}`,
    close-prompt cleared.

### Commit 14 — calibration tooling

39. **Test pattern.** Open the per-output config →
    Calibration → Test Pattern. Output replaces dataset
    content with the calibration pattern. Verify visually:
    grayscale ramp at the equator (8 distinct steps,
    monotonically increasing brightness), RGB color bars at
    lat ±30°, lat/lon graticule with yellow equator + cyan
    prime meridian, named anchor crosshairs at
    (0,0)/(±90,0)/(180,0)/(0,±90), N/S labels at the poles,
    resolution counter in the upper-right corner showing
    the current `framebufferSize`.
40. **Pattern + framebuffer change.** With the pattern
    active, switch framebuffer resolution from 4096×2048
    to 2048×1024 via the resolution picker. The resolution
    counter updates within ~500 ms. Pattern remains
    visually correct (no broken text, no z-fighting).
41. **Pattern + camera tracking.** With the pattern
    active and Track Operator Camera ON, zoom in on the
    control globe at lon=0/lat=0. The center crosshair
    fills more of the LED-sphere mock; the antipodal "
    180,0" crosshair compresses on the other side. Confirms
    that camera tracking applies to the pattern just like
    a regular dataset. Then zoom in at lon=90°E/lat=0
    instead: the 90°E crosshair turns to the front, and the
    antimeridian, which the lon=0 view leaves on the frame's
    edge, now runs through the frame a quarter-turn east of
    it. Its anchor line should be unbroken. **Failure
    signature:** a dashed line of one flat colour along it,
    the pattern's average — the fetch choosing its mip
    level across the `atan` jump. Reproduced and fixed
    off-hardware on 2026-09-27 (rung 16, convention 1), so
    seeing it on a GPU means the fix does not hold there.
42. **Pattern + split.** Toggle Split Sphere ON. The
    crosshair at (0,0) appears twice on the equirect
    (U=0.25 and U=0.75), confirming split mode applies.
43. **Rotation offset.** With the pattern still active,
    set Rotation offset to 90°. The prime meridian (cyan
    line) shifts 90° westward on the LED-sphere mock —
    the line that previously sat at U=0.5 now sits at
    U=0.25. Confirms the longitudinal rotation is applied
    correctly. Then drag the slider slowly through a few
    degrees either side of 90°: the antimeridian anchor
    moves with it and stays unbroken. **Failure
    signature:** a line of one flat colour down the whole
    frame at the antimeridian that blinks on and off
    through the drag — the fetch choosing its mip level
    across the `atan` jump. 90° itself hides it, since
    every multiple of 45° puts the jump between 2×2 quads;
    reproduced and fixed off-hardware on 2026-09-27 (rung
    16, convention 1). Reset to 0°.
44. **Rotation offset persistence.** Set offset to 45°,
    quit, relaunch with auto-restore on. Output spawns
    with offset already at 45°; pattern reflects it
    immediately at first paint (no flash of unrotated
    state).
45. **Pattern off.** Pick a real dataset from the
    Calibration → Off (or pick any normal dataset).
    Output reverts to the dataset; pattern shader is
    unloaded. No memory leak (verify GPU memory is at the
    same level as before commit 14's pattern was loaded
    via `chrome://gpu` on the output's webview).

### Playback sync + data-encoded (commits 3, 9, 13)

These carry an `S` prefix rather than continuing the run of
numbers above, so that adding them does not renumber the
thirty-odd steps other sections cross-reference by number.
Each one exists because §3's rewrite makes a claim that is
cheap to assert and easy to get wrong.

**S1. Tour playback rate.** Start a tour whose step carries a
`frameRate` task (`5 fps` against a 30 fps dataset → 0.167×).
The output must slow with the control window and stay locked
for the whole step. **Failure signature to watch for:** the
output racing ahead, snapping back, and repeating — that is
`playbackRate` missing from the broadcast, i.e. terraviz#229
reproduced in a second window.

**S2. Loop wrap, unattended.** Load a short looping asset
(≤30 s) and let it wrap at least twenty times with nobody
touching the control window. Every wrap must carry the output
around with it. **Failure signature:** the output freezing at
or near the end of the loop and never coming back — the
`readyState` gate set above `SIBLING_MIN_READY_STATE`.

**S3. Differing ranges.** With the output mirroring a dataset
whose temporal range and duration differ from the primary's,
scrub the control window across the range. The output tracks
by date, not by playhead. Out-of-range dates leave it pinned
to its nearest boundary frame rather than jumping to 0.

**S4. Read-back honesty.** With playback paused mid-range,
compare the frame on the sphere against the control window's
label. Then force a texture-upload stall (throttle the
output's network, or pause its rAF via devtools) and confirm
the output reports `output_frame_stale` and shows a health
badge — rather than reporting itself aligned because
`currentTime` kept advancing.

**S5. Decoder budget.** With the control window in the
4-globe layout and all four panels on video datasets, attempt
to add a video output. It must be refused with a message
naming what to close, **not** crash and **not** silently tear
down a panel. Then close two panels and confirm the output
spawns. Repeat in the other order (output live, then switch to
4 globes) — the layout change is the thing refused that time.

**S5b. A raised budget is honoured.** Everything in S5 exercises
the seeded value of 4, which a constant would also pass — so it
does not test that the budget is settable at all. In the Outputs
panel raise the decoder budget to 6, then repeat S5's first
half: the 4-globe video layout must now accept two video
outputs rather than refusing the first. Quit and relaunch; the
budget is still 6 and the same two outputs still spawn. Lower it
back to 4 with those outputs live — the existing ones are
**not** torn down (§3 forbids killing a running decoder to make
room), and the next spawn is refused.

**S6. Palette mirroring.** On a data-encoded dataset, change
the palette (source → magma), then the contrast stretch, then
a value threshold. Each must reach the sphere. Confirm the
thresholded region reads as absent rather than as a colour,
and that the hover readout on the control window reports the
same physical value before and after — a display transform
never changes a reported value.

**S7. Non-Earth body.** Load a Mars or Moon dataset. The
output must not paint night lights, specular ocean, clouds, or
a day/night terminator, and a bbox-clipped overlay must not
reveal a base Earth underneath.

### Projector warp import (rung 16)

**Built in code 2026-09-29; none of these has run on hardware.**
The steps below were amended that day to describe the panel as
built rather than as planned. The operator's side of the same
ground is `MULTI_MONITOR_OPERATIONS.md` §3.6.
These carry a `W` prefix for the reason the S steps do. Every
one targets a failure that still produces a plausible picture —
a way the warp can be wrong while the sphere shows a globe. The
maths underneath is the pure module's unit tests; do not re-test
it here. These steps need the calibrated rig — a sphere, or
whatever surface the site's warps were solved for — except
where a step says it does not.

Pre-flight: the site's own sphere-sim export (the Boulder
preset's bundle is fine for checking that a bundle loads, and
wrong on any rig but Boulder's); the projector heads spanned
into one display at the OS level, per the runbook; the output's
debug HUD on.

**W1. One monitor, one output.** The Outputs panel lists the
spanned display as a single monitor at the full framebuffer
size — 3840×2160 for SOS's four 1920×1080 projectors. Add an
output there with **Output type** set to the projector rig.
Before any import, the row says it has no warp set, the HUD
reads `warp  none`, and the projectors are black — never an
unwarped globe. Import the bundle. One exported since
sphere-sim#52 carries its layout, so the panel lists the meshes
it read and says the bundle places them. It draws the display
with each mesh in its own place (P1 bottom-left through P4
top-right, for SOS), states the rotation already in them, and
imports on *Import*. It also compares the display the bundle was
solved for with this one, and a different shape is a warning.
Once imported, the row reads *Drawing 4 meshes: P1, P2, P3, P4*
with the warp's rotation beside the content rotation, and the
HUD's `warp` line gives the set's id and the same count.
**Failure signature:** several monitors listed instead of one.
The heads are not spanned at the OS level, and this rung cannot
place a window across them. A mesh whose aspect differs from
the part of the display it fills must be flagged before the
click, as a stretch warning with a percentage, rather than
stretched in silence.

**W2. Viewport placement.** (a) Turn on the calibration
pattern. The graticule runs continuously across every seam, the
equator is one unbroken line, and the prime meridian sits where
the site's calibration put it. **Failure signature:** one
projector's share of the graticule on the wrong part of the
sphere, or upside down — a mesh filed under the wrong viewport,
or a viewport flipped in `y`. It is still plainly a graticule,
which is why this step exists. (b) **A rig that is not SOS's
quadrants** — this half needs no sphere. Import a bundle for a
placed rig of two projectors, which sphere-sim lays out as two
halves side by side at full height. It imports without asking,
and the diagram shows the halves. sphere-sim's page does not
export a placed rig yet, so use `sphere-sim-placed-bundle.zip`
from `src/output/fixtures/projectorWarp/`: sphere-sim's own
builders applied to one. Then pick the same two meshes as loose
`.data` files, which carry no layout. Now the import asks: *Use
SOS quadrants* or *Cancel*, with nothing chosen for the operator.
The diagram puts P1 and P2 in the bottom two quadrants — the
wrong place for this rig, which is the point — and *Cancel*
imports nothing. **Failure signature:** the loose files placed
without a question, or with the quadrants pre-selected — the
silent id default this rung exists not to have. Or the bundle
placed anywhere but its own halves. Two projectors are the case
to use because both ids are ones the quadrants *can* place, so
nothing but the rule catches it.

**W3. The seam and a pole.** (a) With the pattern on, find the
antimeridian anchor. The mesh cells around it render the
graticule like any other region, and the anchor's own colour
runs through the join unbroken. **Failure signature:** a band
one mesh cell wide holding a squeezed, backwards copy of the
whole map — texels interpolated across the seam instead of
directions — or a dashed hairline of flat colour along the
anchor, which is the fetch choosing its mip level across the
`atan` jump (reproduced and fixed off-hardware; see
convention 1). (b)
**A pole in view.** An SOS rig never has one, so this
half needs a rig that does: a dome's zenith, or a placed
projector aimed high. Pattern on, find the pole: the parallels
close into rings round it and the meridians converge on one
point. **Failure signature:** a wedge or a fan of smeared
texture round the pole, or the pole's cells missing — a build
that interpolates `(u, v)` and either smears those triangles or
drops them. A soft dot of averaged colour on the pole itself is a
different fault: the fetch choosing its level from longitude
(convention 1, "The same at a pole"). On a site with only an SOS rig, record this half as
not run rather than passed.

**W4. Overlap brightness.** The flat grey comes from the
calibration pattern: its grayscale ramp runs round the equator
in eight flat steps, 45° of longitude each, so every seam
crosses it. In a darkened room, use the content rotation to
bring a mid-grey step onto each seam in turn. Within the step,
the overlap matches the single-projector regions on either
side. **Failure signature:**
a dark band along every seam, near 44% brightness — the blend
applied to display-space values instead of in linear light. A
faint band either way is γ not matching the projectors; adjust
the row's *Blend gamma* and look again.

**W5. No double rotation.** On a new `projector-warp` output the
rotation reads 0, labelled as a content rotation, with the
warp's own rotation beside it once a set is imported. That note
gives the figure the bundle's `layout.json` states (sphere-sim#52),
says none for a model, and says "unknown" only for loose files or
a bundle from before #52. The prime
meridian sits where sphere-sim placed it. Set the content
rotation to 90°: the whole picture turns by 90°, continuously
across the seams. Re-import the same bundle and it is still 90°.
Set it back. **Failure signature:** the meridian displaced by
the rig's own rotation at import — sphere-sim's rotation applied
a second time, by an import that seeded the content rotation
from the rig — or the operator's rotation reset by a re-import.
On a rig whose rotation is 0°, and on any mesh surface, the
first of those passes vacuously; say so in the log.

**W6. Zoom and split through the warp.** Pattern on, Track
operator camera on. Zoom the control globe in on (0°, 0°): the
centre crosshair grows on the sphere, the antipode compresses,
and the scale is continuous across every seam. Then toggle
split: the (0°, 0°) crosshair appears twice, 180° apart on the
physical sphere. Toggle it off and pan to (−80°, 0°): Antarctica
turns to the front with its pole just below, the parallels
closing into rings round it, sharp to the pole itself. **Failure
signature:** the zoom's scale jumping at a seam, which one window
drawing every viewport from one set of uniforms should make
impossible. A soft dot of averaged colour on the pole is the
fetch choosing its level from longitude (convention 1). If the pan
does not turn the sphere at all, read the HUD's `link` before
blaming the warp: an output that is not hearing the control window
cannot follow it.

**W7. Motion across a seam.** Play a moving video dataset —
clouds, or an SST animation — and watch one seam for a minute.
**Failure signature:** doubled or ghosted features along the
seam: two viewports showing different frames. With one window
this should be impossible; if it appears, the geometry is not
being drawn in the single pass rung 16 specifies.

**W8. The silhouette edge.** With the pattern on, look at each
projector's silhouette edge, above all at the polar ends of each
disc, where it carries light. It should follow the disc's curve and
fade out, the graticule running into the fade unbroken. Where a
crossfade hands the side of a disc to a neighbour, that projector's
picture should end on a smooth curve inside its silhouette, where its
blend reaches zero. Expected residue: a short step where a grid line
runs along the edge — at the top, bottom and sides of each disc, half
a mesh cell at most — and an edge a few pixels off the true
silhouette. On a rig whose blend masks the poles, as Boulder's does,
the top and bottom of each disc stay bright to the edge where the mask
should have faded them, because the mask falls inside the last cell.
That is expected until sphere-sim#55 or a finer export. Judge the
edges on the sphere: a desk monitor shows each projector's picture
alone, where a weight of 0.03 reads as a 20% grey. **Failure
signature:** a staircase along the whole edge, up to a mesh cell deep
(96×54 px on a 3840×2160 raster at 41×41): the reconstruction is not
running, and every mesh is drawn as a stock player would. Steps up to
a mesh cell wide down the sides of a disc, where its crossfade hands
over, mean the blend's zero line is not being reconstructed. A bright
rim well past the silhouette, on the wall behind the sphere, is the
band's weight gone wrong; a faint sliver a few pixels wide is an
overshooting estimate, and expected. Separately, the ring of cells
just inside the edge can put the graticule several pixels off across
an overlap, up to 28 on Boulder's meshes, which is the grid's own
error there; if that is objectionable, re-export from sphere-sim at a
finer `cols` / `rows`.

**W9. Restore, a missing warp, and a downgrade.** (a) Quit and
relaunch with restore on: the `projector-warp` output comes back on
its monitor with its meshes and its content rotation, and the
pattern off. (b) Corrupt that output's set,
`localStorage['sos-multi-output-warp:<warpId>']`, with `warpId`
read off the output's entry in `sos-multi-output-config`: the
output spawns and draws nothing into the projector rasters. The
panel row says the set could not be read and asks for it again;
the HUD reads `warp  none`, since the output was handed no set;
and the control window's log names the reason (`altered`,
`unreadable` or `refused`). Every output not using that set
restores untouched. (c) Launch a build without rung 16 against
the same config: it declines to spawn the `projector-warp`
output rather than restoring it as `sos-equirect`. It also
drops that entry the next time it writes the config — at once,
if it restores any other output — so going back to a build with
the rung may not bring the output back. Re-add it and re-import
the bundle, which lands on the set still stored under the same
id. **Failure signature:** an unwarped equirect
across the projectors at any point in this step. (b) has a
manager-level test, since what it asserts — one bad warp costs
one output — needs no sphere: `manager.test.ts`, "costs a
damaged set the one output using it".

### Cross-platform parity

46. Repeat steps 4–18 (basic happy path) on a Windows
    workstation. Same outcomes. Particular attention to
    WebView2's separate-process model under crash storm.
47. Repeat steps 4–18 on macOS. Particular attention to
    WKWebView's process-sharing model and macOS auto-move
    on monitor unplug.

### Notes on automation

Steps 4–24 (happy-path commits 9–11) and steps 39–45
(commit 14 calibration) are good candidates for
Playwright-driven automation against the Tauri test
harness once the panel ships. Failure-recovery cases
(31–38) involve OS-level kills and network manipulation —
keep them manual for v1.

Of the sync steps, S1, S3 and S6 automate cleanly. S2 needs
real elapsed time and is better run as a soak. S5 is worth
automating at the manager level even though the crash it
guards against cannot itself be asserted — the point is that
the refusal fires, not that the ceiling is reached.

Note that the control law underneath S1–S3 is already unit-
tested on `main` as `computeSiblingSyncCorrection`, so these
steps are integration checks on the *wiring* — the broadcast
carrying the right fields, the gate at the right threshold —
not on the maths. Do not re-test the maths here; extend
`time.ts`'s own tests if the law itself needs to change.

Per CLAUDE.md's "Waiting in tests", any async assertion in
this set must anchor on a signal via `until()` from
`src/test-utils.ts` rather than a fixed number of event-loop
turns — `check:tick-drain` fails the build otherwise.
