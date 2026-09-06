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
| Atmosphere shells | the **silhouette** — the shell exists "so the shell's silhouette is the limb of the atmosphere proper" (`:148-151`) | **Meaningless.** |
| Ground shadow | a scene to cast onto | **Meaningless.** |
| Sun sprite | a billboard in world space | **Meaningless.** |

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
| `view.cameraOffset` (Vector3) | Manager (computed from MapLibre camera) | default-on for SOS LED sphere outputs in v1; can be disabled per output. Pinned to `(0,0,0)` when tracking is off, which produces a uniform 1:1 equirectangular unwrap. See §3.5. |
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
| `src/ui/outputUI.ts` | Tools → Outputs panel — list current outputs, "Add output" button, per-output config menu (monitor, mode, "Track operator camera" toggle, "Split sphere" toggle, "Rotation offset (°)" numeric + slider, "Calibration" submenu with test-pattern selector, debug overlay), per-output health badge (healthy / stale / stalled / monitor-missing — see "Failure recovery") |
| `src/output/main.ts` | Output window entry. Creates Three.js renderer, builds `photorealEarth` scene + dataset overlay + layer stack, runs equirect RTT each frame, displays to a full-bleed canvas. Wires `webglcontextlost` / `webglcontextrestored` listeners and an IPC-silence watchdog (5 s tolerance, stale state thereafter — see "Failure recovery") |
| `src/output/equirectRtt.ts` | Equirectangular render-to-texture pass — single fragment shader. Applies the per-output `uRotationOffsetRad` longitude rotation first (see "Calibration tooling"), then raycasts from a configurable camera offset (`uCameraOffset`, derived from the operator's MapLibre camera by default; see §3.5) at every (lon, lat) of the output framebuffer. Supports split mode (`uSplit`) that mirrors the area of focus to the antipodal hemisphere of the LED sphere. |
| `src/output/datasetMirror.ts` | Output-side companion to control-window `datasetLoader` — given a `dataset.url` + `dataset.kind` + `dataset.bbox`, builds a Three.js texture (image or HLS-driven VideoTexture) and a UV transform. Owns the playback sync seam (feeds `computeSiblingSyncCorrection` and the read-back verification layer — see "Playback sync algorithm") and the single stream rebuild on a `loadStream()` rejection, freezing the last good frame throughout (see "Failure recovery"; there is deliberately no retry ladder here — `hlsService` owns that). Recognises the `__terraviz_calibration__` sentinel dataset id and renders a procedural test pattern (~80 lines of GLSL) instead of fetching content (see "Calibration tooling") |
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
| **Counted** | one per video dataset in the control window's panels, plus one per output currently showing a video dataset. Image datasets and the calibration pattern cost nothing — matching both measurements, which found image panels free and video panels the binding constraint. |
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

> **This case is net-new infrastructure, not an incremental
> addition.** An earlier draft of this plan listed it beside
> the other five as though it were extending something. There
> is **no `webglcontextlost` or `webglcontextrestored`
> handling anywhere in `src/` today** — zero matches across
> the whole tree. Nothing in the app has ever survived a lost
> context; it has only ever been a thing that happens and
> ends the session. Scope commit 13 accordingly, and expect
> the recovery path to need its own tests and its own manual
> verification (a forced context loss via
> `WEBGL_lose_context`), because there is no existing
> behaviour to regress against.

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

**Detection.** Output's canvas listens for
`webglcontextlost` and `webglcontextrestored`. Triggers
include driver crash, OS sleep / wake, GPU hot-reset
under memory pressure, and eviction as above.

**Recovery.** On `webglcontextlost`:
`event.preventDefault()` to allow restoration; mark
output state as `gpu_context_lost`. The texture and
framebuffer are gone; output renders nothing until
restored.

On `webglcontextrestored`: rebuild the Three.js scene
from scratch (textures, framebuffer, layer composite) using
the fresh state snapshot the manager re-pushes. Same code
path as boot, just without recreating the window. Output
emits `output_gpu_recovered` to the manager for
installation logging.

If `webglcontextrestored` doesn't fire within 30 s (some
drivers don't recover): log + remove the output record;
operator manually re-adds.

Two scoping notes for whoever builds this:

- The rebuild must go through the *same* boot path the
  window already uses, not a parallel "restore" path.
  A second code path that only runs after a rare event is a
  path that silently rots.
- Work on context-loss detection for the control window is in
  flight separately. If it lands first, this case becomes a
  consumer of that infrastructure rather than the place it is
  invented — check before building, and prefer sharing the
  detection seam over duplicating it.

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
| `core:event:allow-emit` / `emit-to` | Send `output_ready`, `output_health_check`, `output_dataset_stalled`, `output_gpu_recovered`, `output_closing` back to the manager |
| `core:window:allow-current-monitor` | Output reports its monitor identity at boot so the manager can match it to the persisted config |
| `core:window:allow-is-decorated` / `is-fullscreen` | F11 toggle reads current state to decide direction |
| `core:window:allow-set-fullscreen` / `set-decorations` | F11 toggle (per §3.6) writes new state |
| `core:window:allow-close` | Output participates in graceful shutdown — emits `output_closing` then closes itself |
| `http:default` with `https://*` | HLS manifest + segment fetch, image variant fetch from CDN/proxy origins |

**What's deliberately *excluded* and why:**

| Excluded | Reason |
|---|---|
| `core:default` | Grants `invoke` to all Tauri commands (download_manager, keychain, tile_cache, asset protocol). Output never invokes commands; all coordination flows through events. |
| `core:window:default` | Not because it is dangerous — it is read-only (getters + monitor queries), so including it would be harmless. Excluded for reviewability: enumerating the four getters the output actually uses makes the intent auditable, and keeps a future Tauri release quietly widening the `default` bundle from widening this file with it. |
| `core:webview:allow-create-webview-window` | Output cannot spawn more windows. Only the manager (in the main window) creates output windows. |
| `updater:default` | Auto-update is a main-window concern — Tauri restarts the app on update, taking outputs down with it. |
| `core:fs:*`, `core:path:*` | Output streams from the network. No need to read local files — the bundled `output.html` is loaded from the asset protocol scope of the main bundle, not via fs APIs. |
| `core:shell:*`, `core:dialog:*`, `core:clipboard:*` | None apply to a render-only surface. |
| Asset protocol scope (`asset.localhost`) | Output doesn't need to load locally-cached datasets. The control window does (offline downloads → output via the asset protocol on the main window only). For an output window to render a downloaded dataset, the manager broadcasts the `asset.localhost` URL and the output fetches it via HTTP — denied by the explicit deny on localhost below. **Implication: offline downloads are control-window-only in v1; outputs require network.** Phase 5 polish if installations need it. |
| `http://localhost:*`, `http://127.0.0.1:*` | Explicit deny. The only legitimate localhost use case in `default.json` is local LLM servers (Ollama, LM Studio, llama.cpp), which the output never talks to. The deny is documentation-as-code for security review: outputs cannot phone home to anything on the operator's machine. |

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

#### 1. Test pattern pseudo-dataset

Selectable from the per-output config menu under a
"Calibration" submenu, alongside the regular dataset list.
**Not a fetched asset** — rendered shader-side so it works
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

Implementation: `src/output/datasetMirror.ts` recognises a
sentinel dataset id (`__terraviz_calibration__`). When that
id arrives in a state diff, the mirror builds a procedural
texture in a Three.js `WebGLRenderTarget` driven by a single
fragment shader (~80 lines of GLSL). No `<video>`, no HLS,
no network. The pattern recomputes only when
`framebufferSize` changes.

#### 2. Per-output rotation offset

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
// In equirectRtt.frag — applied before the cameraOffset ray-march.
float lon = (uv.x - 0.5) * 6.2831853;          // [-π, π]
lon = mod(lon + uRotationOffsetRad, 6.2831853); // shift, wrap
// ...continue with normal cameraOffset ray-march from lon, lat
```

UI: a numeric input + slider in the per-output config menu,
labelled "Rotation offset (°)". 0.1° granularity. Defaults
to 0; persisted with the rest of the output config.

Operator workflow: load the test pattern. Note where the
prime meridian lands on the physical sphere. Adjust
`rotationOffsetDeg` until the prime meridian aligns with
the desired physical reference (e.g. the museum entrance).
Save. Once calibrated, leave it alone — it's a per-
installation constant, not per-session.

The protocol carries the offset in `view.rotationOffsetDeg`
alongside `cameraOffset` and `split`. It's a per-output
flag, not a globally-broadcast view field — different
outputs on different spheres need different offsets.

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
| 11 | `multi-output: per-output debug overlay + framebuffer + decoder-budget controls` | Resolution picker in panel, the machine-scoped **decoder-budget field** (seeded from `DEFAULT_CONCURRENT_DECODERS`, persisted, shown as "N of M decoders") that makes the per-machine budget in §3 actually settable — without it the budget is a constant wearing a different name — debug HUD with dataset id, sync delta, fps, and the WebGL **renderer string** — the last so an operator can see which GPU the webview actually got, which on a hybrid-graphics machine is decided by the driver rather than by the app (see Risks). | Yes (additive) |
| 12 | `multi-output: fullscreen toggle + kiosk launch + F11 on every window` | `Tools → Fullscreen` toggle in `toolsMenuUI.ts` (persisted), F11 keydown handler on control + output windows, `--kiosk` argv parse and `TERRAVIZ_KIOSK=1` env var read in `src-tauri/src/lib.rs` (**not** `main.rs`, now a 12-line shim) behind `#[cfg(desktop)]`, applying fullscreen + decorationless before first paint, 3-second idle cursor-hide on the control window when fullscreen. See §3.6. | Yes (additive) |
| 13 | `multi-output: failure recovery — crashes, stalls, GPU loss, monitor unplug` | Manager gains crash detection (no-graceful-close window destroy → toast + record removal), 3-strikes-per-monitor crash storm guard, 2 s `availableMonitors()` poll for unplug detection, `getAll()` boot scan to reattach orphaned `output-*` windows after a control-window crash. Output gains `webglcontextlost` / `webglcontextrestored` listeners with full scene rebuild, IPC-silence watchdog (5 s → stale state, 60 s → orphan), one HLS stream rebuild on a `loadStream()` rejection with frozen last-good-frame (no retry ladder — `hlsService` already spends a 3× budget before rejecting). Outputs panel renders per-output health badges (healthy / stale / stalled / monitor-missing). New Tier A `output_failure` event fired from manager via `analytics/emitter.ts` with `{ kind, retries, recovered }` (Open Question 3 decided). See §3 "Failure recovery". | Yes (additive) |
| 14 | `multi-output: calibration tooling — test pattern + rotation offset` | `src/output/datasetMirror.ts` recognises the `__terraviz_calibration__` sentinel id and renders a procedural test pattern (8-step grayscale ramp at the equator, RGB color bars at lat ±30°, lat/lon graticule with color-coded equator + prime meridian, named anchor crosshairs, N/S pole labels, live resolution counter — ~80 LOC GLSL). `src/output/equirectRtt.ts` adds the `uRotationOffsetRad` longitude rotation applied before the camera-offset ray-march. `outputUI.ts` adds the per-output "Rotation offset (°)" numeric + slider and a "Calibration" submenu. Persisted config gains `rotationOffsetDeg`. See §3 "Calibration tooling". | Yes (additive) |
| 15 | `multi-output: operator runbook` | `docs/MULTI_MONITOR_OPERATIONS.md` — the deployment half this plan has so far deferred, and which a spike showed is not optional. Covers: **checking which GPU the webview actually got** (the renderer string surfaced by commit 11's debug overlay) and the per-OS override for a hybrid-graphics machine, since the app's own `powerPreference` is inert and a silent landing on the iGPU is undiagnosable from logs; **measuring this machine's decoder budget** rather than trusting a constant, and entering it in the Outputs panel's budget field (commit 11); disabling screen savers and display sleep (Open Question 5's documented half); the kiosk autostart entry from §3.6; and what each Outputs-panel health badge means in front of an audience. No code. | **Yes** (docs) |

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
3. **Telemetry — DECIDED.** The output window itself emits
   nothing. Telemetry from a capture-clean LED-sphere
   surface would also be a capture-clean policy violation
   (§3.6) — outputs phone nothing home. Three new events
   ship from the **control window**, all Tier A:

   - `output_added` — fields: `mode` (`'sos-equirect'`),
     `framebuffer_bucket` (`'1k' | '2k' | '4k' | '8k'`
     bucketed to avoid identifying exact resolutions),
     `monitor_index` (0 = primary, 1+ = secondaries — never
     the OS-reported monitor name).
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
   tier-A event that already ships. Per
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
6. **Single-monitor guard.** Disconnect the secondary monitor.
   Add Output button is hidden / disabled. Reconnect:
   the button reappears.

**Spawning an output:**

7. Click Add Output → pick the secondary → Confirm. The output
   window appears within ~1 s, fullscreen on the secondary,
   black until ready. No title bar, no menu bar, no cursor.
8. Output renders the photoreal Earth idle state (no dataset
   loaded yet) with day/night and atmosphere.
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

**CONUS-bbox image dataset (Open Question 7):**

13. Load a CONUS-bbox image dataset (e.g. a NEXRAD radar
    composite or a hurricane snapshot). The bbox overlay on
    the control globe and on the output sphere align to ≤1 px
    at 4K — verify by visual side-by-side using the test
    fixture from commit 2.

**Multi-layer:**

14. With the SST base loaded, add a foreground layer (e.g.
    cyclone tracks). Output renders both with the correct
    z-order (cyclone tracks sit on top).

**Camera tracking + split:**

15. **Track operator camera ON (default).** In the control
    window, zoom in on a hurricane (~zoom level 5). The
    output's equirect should show the AOI filling more of
    the sphere; the antipode should compress visibly. Pan
    around — the tracking should follow with ≤30 ms lag.
16. **Track operator camera OFF.** Toggle off in the per-
    output config. The output snaps back to a uniform 1:1
    equirect regardless of where the operator pans.
17. **Split sphere ON.** Toggle on. The current AOI now
    appears at U=0.25 and U=0.75 of the equirect (visible
    as two copies of the area of focus). Toggle off:
    returns to single AOI.

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
    on a 1080p monitor" workflow. Output downsamples cleanly
    to the 1080p secondary.

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
    decorationless from first paint. Cmd/Ctrl+Q exits cleanly.
30. **Cursor auto-hide.** With control window fullscreen,
    leave the mouse stationary for 4 s. Cursor disappears.
    Move the mouse — cursor reappears immediately.

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
35. **Manager crash + reattach.** With an output running,
    `kill -9` the control window's PID. The output keeps
    rendering. Relaunch the control window: manager boot
    scan finds the orphan, reattaches via `output_reattach_
    ping`, sends fresh state snapshot. Output badge in the
    re-loaded panel returns to healthy. The audience sees
    no interruption.
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
    a regular dataset.
42. **Pattern + split.** Toggle Split Sphere ON. The
    crosshair at (0,0) appears twice on the equirect
    (U=0.25 and U=0.75), confirming split mode applies.
43. **Rotation offset.** With the pattern still active,
    set Rotation offset to 90°. The prime meridian (cyan
    line) shifts 90° westward on the LED-sphere mock —
    the line that previously sat at U=0.5 now sits at
    U=0.25. Confirms the longitudinal rotation is applied
    correctly. Reset to 0°.
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
