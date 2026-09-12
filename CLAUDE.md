# CLAUDE.md

## Git

- All commits must be DCO signed-off. Use `git commit -s` (or `--signoff`) on every commit.

---

## Working in this repo

The general "one logical change per turn, committed before the
next" rule from `~/.claude/CLAUDE.md` applies here especially:

- The `docs/CATALOG_*` plan documents are sprawling (the main plan
  alone exceeds 2000 lines, plus five companion docs). Editing
  them via `Write` is unsafe — always use `Edit` for additions,
  reserve `Write` for new files.
- When adding sections to the catalog plan, commit each section
  before starting the next. The split into `CATALOG_BACKEND_PLAN`,
  `CATALOG_DATA_MODEL`, `CATALOG_FEDERATION_PROTOCOL`,
  `CATALOG_ASSETS_PIPELINE`, `CATALOG_PUBLISHING_TOOLS`, and
  `CATALOG_BACKEND_DEVELOPMENT` exists specifically to keep edits
  bounded.
- For multi-section work in the catalog plan, use TodoWrite. A
  failed chunk should not lose previous chunks' work.
- The catalog plan files cross-reference each other; when adding
  a section that another doc points at, update the cross-link in
  the same commit.
- Many of the existing `docs/*_PLAN.md` files follow a consistent
  voice: substantive prose, "Status: draft for review" markers,
  named phases, explicit non-goals, tables for comparisons,
  honest tradeoffs. New plan content should match.

### LLM integration convention

Any change that touches an LLM call — Orbit, voice, enrichment,
workflow tooling, anything new — must follow
[CONTRIBUTING.md](CONTRIBUTING.md) §LLM Integrations: speak
through an existing contract, availability-gate with a working
fallback (quota exhaustion included), no vendor LLM SDK in
`dependencies`, and external content in model input is data,
never instructions. Verdicts on specific agentic proposals
(embedded Agent SDK: rejected; run-failure diagnosis:
conditionally approved; others parked behind named triggers) are
in [`docs/AGENT_SDK_EVALUATION.md`](docs/AGENT_SDK_EVALUATION.md)
— check it before proposing or building an agentic feature, and
add new value ideas to
[`docs/LLM_INTEGRATION_OPPORTUNITIES.md`](docs/LLM_INTEGRATION_OPPORTUNITIES.md)
rather than building them ad hoc.

### Federation planning artifact

Federation work — Phase 4 routes (handshake / feed / signing),
federation tables, peer subscription, the lightweight peer
appliance, the publisher CLI launch — follows
[`docs/architecture/federation-scoping.md`](docs/architecture/federation-scoping.md).
Before designing or implementing federation-related code, read
**§7** (Phase 4 implementation directives) and **§8** (resolved
planning decisions). The scoping doc supersedes Phase 4
sequencing in `docs/CATALOG_BACKEND_PLAN.md` where they conflict.

**Freshness check.** The scoping doc carries a "Last reviewed"
date and a "Revisit when" trigger list at the top. Before
applying its directives, verify the doc is still current — if
the last-reviewed date is more than ~6 months old, or any
"Revisit when" trigger has been hit (Phase 4 shipped, the
publisher-CLI pilot revealed auth-flow issues, a non-Cloudflare
funded partner emerged, the Phase 4 ETA slipped past two
quarters, any §8 decision changed), surface that to the user
before proceeding rather than silently applying potentially
stale guidance. Once the doc's "Supersedes when" condition is
met, defer to `CATALOG_BACKEND_PLAN.md` and `ROADMAP.md` as the
active source of truth.

`npm run check:doc-freshness` reports the date half of this for
every doc carrying a `Last reviewed:` marker — the scoping doc is
not the only one. The colon is required: prose that merely cites
another doc's date (`**Last reviewed 2026-05-04**`) is not a
marker. It is **advisory** and deliberately absent from
the `type-check` chain — a date threshold that gated CI would
break a build with no code change, on whichever unrelated PR is
open the day a doc ages out. `--strict` exits non-zero for anyone
who wants it as a gate; a SessionStart hook runs it `--quiet` and
stays silent until something crosses a threshold. A fresh date is
necessary but not sufficient: the "Revisit when" triggers are
prose and still need judgement.

---

## Codebase Overview

TypeScript SPA built with Vite and MapLibre GL JS. Deployed on Cloudflare Pages (web) and packaged as a native desktop app with Tauri v2 (Windows, macOS, Linux). No runtime framework — vanilla TS with a few focused libraries (MapLibre GL JS, HLS.js).

> Forking to deploy your own instance? See
> [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md) for the
> end-to-end Cloudflare setup walkthrough (Pages, D1, AE, KV,
> Access, optional Grafana). Most of it is automated by
> `npm run setup` (`scripts/setup-node.ts` +
> `scripts/lib/setup/`); start with `npm run setup -- --manual`
> for the parts no API can do.

### Key commands

```bash
npm run dev          # dev server (localhost:5173)
npm run build        # tokens + tsc + vite build
npm run type-check   # tsc --noEmit (must pass before committing)
npm run check:license -- --fix   # insert the SPDX header into new files
npm run test         # vitest run
npm run tokens       # regenerate src/styles/tokens.css from tokens/*.json
npm run setup        # provision a self-hosted node (plan by default)
npm run setup -- --interactive   # guided, with instructions + validation
npm run setup -- --manual        # the prerequisites no API can do for you

npm run dev:desktop  # Tauri dev mode (requires Rust)
npm run build:desktop # tsc + vite build + tauri build

# Visual testing & reporting (run against a dev server on :4173)
npm run screenshots:report  # capture every scene × viewport → report-out/index.html
npm run screenshots:diff -- --baseline <dir>  # pixel-diff vs a baseline
npm run screenshots:smoke   # gating interaction tests (search, Orbit, nav)
```

> **Note:** `src/styles/tokens.css` is a generated build artifact
> (gitignored). It is created automatically by `postinstall` after
> `npm install`, and by `npm run build`. Run `npm run tokens` manually
> if you edit any file under `tokens/`.

> **Note:** `public/assets/basemaps/` is committed — 18.5 MB of
> Earth textures stored as ordinary git blobs and served same-origin
> from the deploy. They carry a `.gitattributes` exemption from the
> `*.jpg` / `*.png` LFS catch-all, which is deliberate and explained
> in the comment there: LFS bills the **parent** repository for every
> fork's checkout, and a clone without `git lfs pull` yields text
> files wearing `.jpg` names that build and deploy green. Plain blobs
> arrive with the clone and work air-gapped. Setting
> `VITE_EARTH_ASSET_BASE` serves them from a CDN instead.

### Module map

| File | Responsibility |
|---|---|
| `src/main.ts` | App entry — boots MapLibre renderer, orchestrates dataset loading Also the multi-output **publish** side (rung 7): `bindOperatorCamera` hooks the primary map's `move` — once per rendered frame, which is the rate step 15's ≤30 ms lag asks for, and free when the globe is still since the aggregator drops an identical patch — rebound on promotion because a listener left on a demoted panel keeps driving the outputs from a globe nobody is using, and fired once immediately since promotion changes the camera without moving it. `publishPlaybackMirror` runs from the same `onTick` as `correctSiblingDrift` but deliberately **beside** it, not inside: that method returns early while the primary is paused, and a paused primary is exactly the state an output needs told about. Unload publishes `playback: null` with the dataset, because the playback loop is stopped by then and would never say it. `display` is published from the colorbar's `onChange` — the one place the value changes — and deliberately **not** republished on a dataset load: the transform is app-wide and outlives the dataset it was set on, exactly as it does across the control globes, and a picture dataset ignores it anyway since `paletteTexture` builds no LUT without a `colorScale`. `layers` has no publisher because it has no source: `PanelState` holds one dataset, and the plan's own table names the source for `layers[]` as a *new* `layerStack` state in `main.ts` that was never built — so wiring one would publish an empty array forever (plan smoke step 14a) |
| `src/types/index.ts` | All shared types (`Dataset`, `ChatMessage`, `AppState`, `DocentConfig`…) |
| `src/output/layerStack.ts` | The output's dataset overlay and multi-shell layer stack — bbox clipping, the `lonOrigin` shift, `isFlippedInY`, and the data-encoded palette LUT, composed onto `equirectRtt`'s ray-march by `buildOutputFragmentShader`. The maths is deliberately **not** new: it mirrors `photorealEarth`'s `map_fragment` override, whose own comments record a US bbox landing over the South Pacific, and the tests pin it against `datasetProbe.latLonToTexelUv` — the canonical TS mirror of that same shader — rather than importing it, so the output bundle stays clear of the i18n runtime. Note V here is **shader space** (`v = 1` is the image's top row, since THREE uploads with `flipY`), the opposite of `datasetProbe`'s. Layers composite in array order inside one fragment shader, so the plan's stacked-shell radii and its z-fighting open question do not arise on this path. Slots are unrolled at build time because GLSL ES 1.00 has no dynamic sampler indexing, and capped at `MAX_OUTPUT_LAYERS` because WebGL guarantees only 8 fragment texture units — now **2**, since rung 12c spends two more on the decoration (`3 + 2n <= 8`); it was 4 on arithmetic that was already one past the guarantee and on reasoning that conflated a 4-globe *layout* with four *layers*, and lowering it costs nothing that exists because `layers` has no producer at all. Rung 12c also adds the **Earth decoration** — `nightFactor` (the terminator, from `dot(hit, sunDir)`, since a ray-march's landing point on the unit sphere *is* the normal) and `decorateEarth` (darken, then lights additively, then clouds over), each a pure function with `EARTH_DECORATION_GLSL` as its hand-transcription. The cloud curve — luminance through `CLOUD_ALPHA_GAMMA` then `CLOUD_OPACITY` — lives **here** rather than in whoever loaded the texture, so the gamma and the opacity stay one calibration; taking `photorealEarth`'s pre-baked alpha (gamma 0.55, which lifts haze) into this opacity (tuned against `earthTileLayer`'s 1.8, which suppresses it) is what greyed out an entire day side and clamped the night to black on hardware. Order is `earthTileLayer`'s pass order and load-bearing: darkening multiplies and lights add, so inverting them would darken the city glow to ~1% of itself by the pass that made room for it. The four constants are **copied** from `earthTileLayer` rather than imported, because importing it would pull MapLibre into a bundle that renders one quad — a weaker guard than the overlay maths gets, and the docstring says so. The **Earth treatment is idle-only**, gated on the slot count at build time, and that is a correction of what shipped. It used to composite the decoration *under* the layers, on the reasoning that under-compositing meant day/night could never tint a dataset — true of opaque global coverage and false of everything else. A data-encoded overlay is translucent by construction (its alpha *is* the measurement), so the terminator showed straight through the night-side smoke plume that argument used as its own example; and outside a bbox the output was decorated while the control globe was not. `earthTileLayer` gates its whole pass chain on `datasetActive` and returns before pass 0 — "no earth effects when dataset is active" — so a control globe showing a dataset is unlit *and* ungraded, and a bbox dataset `discard`s to raw Blue Marble tiles outside its box. The output now matches by construction: no layers means the full treatment, any layer means the raw sample and nothing on top. Gating on the slot count costs nothing at runtime because the shader text is already a function of it, and `main.ts` fills a slot only when the mirror holds *decoded* media, which makes this a tighter test than the control side's — `datasetActive` is set when the dataset is assigned, this when its pixels exist. Found on hardware, rung 9 step 13. The **cloud zoom fade** is `earthTileLayer`'s curve on `earthTileLayer`'s anchors (full cover at zoom 3, none at 6) applied **per fragment**, off the ray-march's own hit distance `t`: the projection's zoom is a warp, so one frame holds the focus magnified and the antipode compressed, and a single uniform would either keep the fuzzy wash over the magnified part or strip clouds off three-quarters of a sphere that never zoomed. `localZoomAt` is `cameraOffsetForCamera`'s mapping inverted — `z = 1/t - 1` — so the focus reports the operator's actual zoom and the two surfaces agree there by construction rather than by two hand-matched numbers. It ignores the warp's anisotropy (~27% of a magnification factor mid-frame, nothing at either pole) and bottoms out at ~11% cover because `MAX_CAMERA_OFFSET` caps the reachable zoom at ~5.67 — which is not a shortfall but agreement, since that is the control globe's value at 5.67 too; rescaling the curve to end at the cap is the tempting fix and would put a second calibration in the repo. The fade multiplies the **boosted** alpha, where the raster path applies it, so the 2.5x night boost cannot partly undo it |
| `src/output/main.ts` | Output-window entry point — resolves the canvas, builds the scene, attaches the link, drives the rAF loop. Thin on purpose, the shape `orbitMain.ts` has over `orbitCharacter/`, so the testable logic lives in `outputScene.ts` / `outputLink.ts` / `datasetMirror.ts` / `outputSync.ts` and needs no page to run. Two decisions live only here. **The link is optional; the page is not** — `output.html` is also the static fixture rungs 2-4 render in an ordinary browser, so the link attaches on desktop only and its failure costs the link rather than the render loop; a correct idle Earth beats a black window. **Playback is steered per frame, not per message** — a diff says where the primary *was* when it was sent and both clocks keep running between diffs, so steering only on arrival sawtooths; `outputSync` is idempotent inside the hard-seek threshold (it trims the rate rather than seeking), which is what makes per-frame calling correct. The composite is rebuilt from the **mirror**, never from the link: the link's `dataset` is what the control window says and the mirror's is what this window has actually decoded, so compositing the former would put an incoming dataset's bbox and palette over the outgoing dataset's pixels for the length of a load Rung 11 adds the HUD's composition: the overlay is mounted **unconditionally and hidden** (a hidden `refresh` reads nothing, so it costs one no-op timer callback and buys an instant toggle), the fps meter is ticked on **drawn** frames rather than rAF callbacks (the question is whether this output is painting, and for static content the honest answer is the 1 Hz floor) and sampled from the loop rather than from the HUD's reader (so the window stays ~500 ms while drawing at 1 Hz, and the reader stays pure — `sample()` resets the window, so a hidden HUD would otherwise open on an average of however long it was hidden), and the renderer string is queried once behind an `undefined`-means-unasked marker so a driver that *refuses* is not re-asked twice a second forever. `link.renderConfig()` is read once after subscribing, not merely defensively: the manager answers `output_ready` with a config that can land while `connectOutputLink` is still awaiting its own emit. A diff flags the scene dirty only when it `changesPicture`, because the alternative — anything that changed is worth a frame — meant the playhead keys, which arrive at the control window's frame rate, drove this loop past the 30 fps cap for exactly the content the cap exists to bound. |
| `src/output/outputScene.ts` | The output window's scene and render loop — the 2:1 equirectangular framebuffer (widths snapped **down** to a supported rung, because overshooting spends GPU memory on hardware that reported less), the fullscreen quad carrying `equirectRtt`'s pass — now **composited** with `layerStack`'s unrolled overlay slots, so a mirrored dataset actually reaches the sphere. The material is rebuilt only when the slot *count* changes, because GLSL ES 1.00 has no dynamic sampler indexing and the shader text is therefore a function of the count; everything else about a layer (texture, bbox, palette) is a uniform write, so an operator nudging a palette costs an upload rather than a compile. The **same** uniforms object survives a rebuild — fresh ones would snap every output back to a centred camera whenever a layer appeared. A slot's map texture is reused when the element is identical, since rebuilding a `VideoTexture` restarts the upload path for a change the decoder never saw, while the 1 KB palette is rebuilt every time; slots that go away are disposed **and their uniform entries nulled** — disposing is only half of it, since `uniforms` is long-lived and keyed by slot name and a Three texture holds its `image`, so a left-behind reference pins one decoded video element per removed slot for the life of the window even though the rebuilt shader no longer samples it. `OutputLayerInput` carries `kind` rather than sniffing `instanceof HTMLVideoElement`, which would make the video path the one path no test could reach. And the draw decision, via `contentKindFor`: 30 fps for a video **that is actually advancing**, 1 Hz for anything static, and immediately whenever something changed. Read off the element rather than latched from the dataset — an output whose operator paused, or whose date fell outside the dataset's span, holds one frame, and pacing that at 30 fps is 30× the GPU for an identical picture on hardware that may drive sixteen of these; off the *element* rather than the sync outcome, because a dataset with no time axis is left looping by design and pacing that off the outcome would judder it. The 1 Hz floor is not an optimisation to remove — an output that never redraws cannot tell a dropped upload or a lost context from a correct frame. Lazy-loads Three behind the same `loadThree` seam `globeThumbnail` uses, and `photorealEarth` behind a matching `createEarth` one — consumed as a **texture provider** (its progressive 2K→4K→8K base diffuse, swapped in on `onBaseDiffuseChange` and flagged dirty so the upgrade does not wait out the 1 Hz floor) rather than as a mesh to render, because the equirect pass *is* the renderer; every mesh-only effect is switched off at construction. The sampler is bound to `baseEarthTexture` from the first frame and **never** to `null`: black on an output is indistinguishable from a dropped upload or a lost context, which is the one failure the 1 Hz floor exists to surface, and it shipped that way once. Rung 12c wires the decoration the plan's §"What the equirect path does to the Earth decoration" says crosses. **The sun is derived, never borrowed:** `uSunDir` is `latLonToDirection(getSunPosition(now))` — the same function `cameraOffsetForCamera` uses — recomputed on every **drawn** frame, unthrottled because that is pure arithmetic. It first *copied* `earth.sunDir`, on the reasoning that sharing `getSunPosition` stops the two globes disagreeing; that was true of the source and false of the **frame**, since `photorealEarth.sunDirectionFromLatLng` negates Z for the globe *mesh*, so the borrowed vector arrived longitude-mirrored and lit the opposite hemisphere. Sharing the frame is the property that matters, and deriving it here makes that true by construction. **Clouds are loaded here, not through the Earth handle** (`loadCloudImage`, defaulting to `getCloudTextureUrl()`): this composite needs the raw asset because that module bakes luminance to alpha at a gamma tuned for a lit shell seen from outside, and splicing it in washed the day side grey and clamped the night side to black. A failed load costs the clouds and nothing else. The two decoration samplers are bound to `baseEarthTexture` from the first frame and gated by `uHasNightLights` / `uHasCloud`, the same never-bind-null rule the sphere sampler follows, and each arrival flags the scene dirty so it does not wait out the 1 Hz floor. Deliberately **no** dirty flag for the sun: it moves ~0.004° a second, and flagging that would hold a static output at the render rate forever to animate something invisible `setFramebufferWidth` resizes the **drawing buffer, never the window** — `setSize(w, h, false)` leaves the CSS size alone, which is what makes a rung below the monitor's pixel count scale up rather than shrink into a corner — and no-ops on an unchanged snapped size so re-picking the current rung does not reallocate 128 MiB. `rendererName()` reads `WEBGL_debug_renderer_info` for the HUD and returns `null` rather than throwing when a driver refuses. **Every texture this shader samples is put into display space** by `useDisplaySpace`, and that is a correction rather than a preference: `photorealEarth` tags its diffuse and night lights `SRGBColorSpace`, so Three uploads them with an sRGB internal format and the *sampler* decodes to linear — right for that module's lighting pipeline, wrong here, where one quad renders straight to the default framebuffer with no `colorspace_fragment` chunk to re-encode, and where every `layerStack` constant is copied from `earthTileLayer`, which grades in sRGB **display** space off the MapLibre framebuffer. Measured cost of the mismatch: lit land `rgb(181, 150, 103)` reached the framebuffer as `rgb(112, 68, 30)`, and dark vegetation `rgb(27, 47, 19)` as `rgb(2, 5, 17)` — **byte-identical to ocean**, so forest and sea were one colour. It predates the colour grade; rung 12c's decoration inherited it too. The decode is *removed* rather than compensated for, which makes every copied constant correct by construction, and brings the base and lights into line with the cloud texture, built here by `new Texture(img)` and therefore always at Three's default `NoColorSpace`. Retagging another module's texture is safe because `createPhotorealEarth` builds them per call and this window owns its instance; it is applied again in each change callback because a 2K→4K→8K tier upgrade hands over a texture this module has never seen — retagging only at construction would look fixed for the first seconds of every launch and be wrong after |
| `src/output/equirectRtt.ts` | The equirectangular render-to-texture pass for a multi-monitor output (`docs/MULTI_MONITOR_PLAN.md` §3) — for each pixel of a 2:1 framebuffer, the direction it represents is ray-marched from a configurable camera position against the unit sphere and the sphere texture sampled at the hit. One pass; the cubemap-and-convert route is rejected outright and must not be built. A centred camera is the identity; moving it off-centre magnifies the hemisphere it moved toward and compresses the antipode, and **that warp is the zoom** — the primary v1 mode, matching SOS behaviour. Because the camera is strictly inside the sphere every ray hits, so the shader has no miss branch and the far side shrinks rather than clipping. Everything but the GLSL strings is a pure TS mirror of the shader, so the projection is unit-testable with no GL context (same split as `datasetProbe.ts`); no Three.js import — commit 3 builds the material around it. `uRotationOffsetRad` (commit 14) and layer compositing (`layerStack.ts`) are deliberately absent |
| `src/output/atmosphereNadir.ts` | Atmospheric scattering for the output, reduced to a **one-dimensional lookup**. Exists because Blue Marble's blue is not in Blue Marble: `earth_diffuse_*` and the control globe's GIBS `BlueMarble_NextGeneration` tiles are the same product with the same near-black `rgb(2, 5, 20)` ocean, and the blue comes from `earthTileLayer`'s pass 5 — a shell at ~1.0157 radii that covers the whole **disc**, not a limb ring, compositing `scattered + bg x viewTransmittance` with a Rayleigh beta that scatters blue ~5.7x harder than red. Without it an output shows a black sea beside a blue one, which is what "the main application window is much more blue" was reporting. The plan's decoration table rules out atmosphere shells; that is right about the limb and wrong about the disc tint. **Pinning the view to nadir collapses the integral to one variable:** with the ray from the top of atmosphere at `-P`, `normalize(samplePos)` is `P` at every step, so the sun-transmittance lookup's `mu` is `dot(P, sunDir)` *constant down the column*, the view optical depths depend only on altitude, and both phase functions key on the same scalar negated. Exact rather than approximate, because the shared ray-march is single-scatter with no ground-albedo coupling. So it is a 256x1 RGBA LUT (RGB = in-scatter, **A = transmittance**, so the shader is one line) indexed by the value `earthNightFactor` is already handed — not 8.4M per-fragment columns. Constants and the transmittance LUT are **imported**, not copied like `layerStack`'s four decoration scalars: `atmosphereConstants` imports nothing at all and `atmosphereLut` only from it, so sharing costs the output bundle nothing. The nadir test is also what keeps specular, ground shadow and the sun sprite out on a *sharper* rule than "depends on a viewer" — ask what each becomes at nadir: scattering becomes a smooth global function of sun angle, specular becomes a fixed bright spot at the subsolar point, which is the glare artifact the plan rules out reached by another route. Two limits are honest rather than hidden: single-scatter reads dark at high sun-zenith (the control globe shares that, which is the point), and nadir is a *choice* — the control globe shows one viewer's scattering, so the two agree near the sub-viewer point and diverge toward its limb |
| `src/output/outputSync.ts` | The output's playback-sync decision layer (`docs/MULTI_MONITOR_PLAN.md` §3) — the control law itself is `computeSiblingSyncCorrection` in `src/utils/time.ts`, already measured and tested, because **an output is just another sibling viewport** and runs the same law a second globe in a 2-up layout does rather than a simplified one. What lives here is the layer around it: the gates deciding whether a correction can be computed (`readyState`, a positive duration, a parseable instant, a dataset that *has* a time axis) and, when it cannot, `syncByRatio` — the second steering path, which mirrors the primary's transport and its position *in the clip* rather than standing down. Standing down was the shipped behaviour and it never started the element at all, so every SOS looping animation held its first decoded frame on every output for the life of the window; on a 24-hour animation that reads as a **longitude** error, since the terminator and any burnt-in clock end up half a day from the operator's globe, which is how it was reported from hardware. It takes no rate trim, because both elements run the same clip at the same mirrored rate and one seek leaves a constant offset rather than a growing one, and it seeks *before* it plays, since `play()` on an element at its end rewinds to zero and would undo the seek and the translation from a correction into element writes. Split from the composition for the reason `playbackSettle` and `voiceVad` are — this is where the wrong answers live and it has no business needing a DOM; `SyncTarget` is five properties and two methods that `HTMLVideoElement` satisfies structurally, so every branch is reachable from an object literal. `SIBLING_HARD_SEEK_THRESHOLD_S` / `SIBLING_MIN_READY_STATE` / `SIBLING_SEEK_EPS_S` are **imported, never restated**: an earlier plan draft proposed 2000 ms for the threshold, 13× the shipped 0.15 and 4× above a value already measured and rejected, which is twelve-plus seconds of staggered globes after every scrub. An ISO instant that will not parse returns `not-ready` rather than propagating `NaN` into a `currentTime` write. Two rules exist because **a seek is not instant**, and the debug HUD caught what happens when that is forgotten — a steady `sync -166 ms` against a 150 ms threshold, seeking once per rAF, visibly choppy. A seek stalls the element and the primary plays on throughout, so the moment one lands the output is behind again by however long it took; if that exceeds the threshold the correction manufactures the error it is correcting, and an output that ever falls outside can never get back in (which is why it was choppy only sometimes). So a **seeking element is never steered** — mid-seek, `currentTime` reads the target while the glass still shows the old frame, and any error computed from it is fiction — and for `OUTPUT_SEEK_SETTLE_MS` after a seek the threshold is **raised** rather than the seek vetoed, so the control law picks its own trim and hands back the trimmed rate instead of this module inventing a second one. The raised bound is derived from `SYNC_MAX_RATE_TRIM`, the most error the trim can absorb in that window, so a scrub still seeks. The threshold itself is still imported unmodified: this is an *output* problem, not a sibling-panel one — two globes in one window share a process and a clock, and the 150 ms was measured there, while an output is a second window, a second decoder and an IPC hop. `createPlayheadSync` holds the one fact a pure function cannot (when it last seeked) and reads its clock through an injected `nowMs`, the pure-machine-plus-thin-composition split `playbackSettle` uses. `playbackRate` is never assumed to be 1 — a tour's `frameRate` task sets the primary's rate alone, and an output assuming 1 against a 0.167× primary runs ~6× fast for the whole tour (terraviz#229). Returns the drift rather than only acting on it, since that is the number rung 11's debug overlay reports and recomputing it there would be a second implementation free to disagree with the one steering. A third rule exists because **a seek is not free either**, and it is the one the settle window could not reach: `seekCostFloorS` raises the threshold to the cost of the *last* seek — measured off the element rather than assumed, scaled by the primary's rate because that is how far the target moves during the stall, and by a margin because the loop re-arms on a single under-estimate while an over-estimate costs only a slower convergence the trim still completes. A seek that takes 1.2 s leaves the output 1.2 s behind the moment it lands, so seeking to correct anything smaller is arithmetically guaranteed to end further out than it started. The settle window is a **timeout** and expires whether or not the seek it covered has been paid for; the floor is a standing property of that asset on that machine and does not, which is exactly the case the window missed. Simulated at 60 Hz against an element that stalls for its seek: 20 ms and 200 ms are unchanged (one seek, then the trim), 300 ms seeks 20 times in 20 s, and 500 ms spends **97% of frames mid-seek** — which is both the stutter reported from the first hardware pass and the permanent `—` in the HUD, since a seeking element has no honest drift to report and every sample lands on one. With the floor each of those is a single seek. The measurement belongs to **one element** and is dropped when `datasetMirror` swaps it, or a seek left outstanding on a disposed element is closed against the arrival of its replacement and the length of a dataset load is recorded as the cost of a seek. **Neither raised bound applies while the primary is paused**, and that is the premise rather than an exception: both exist because the target keeps moving during a stall, and against a *stationary* target a seek lands exactly where it aimed and manufactures nothing — while there is no rate to trim, so a declined seek is never converged by anything. Raising the bound there strands the sphere on a frame up to a floor's width from the operator's until they press play, which on a forecast is an hour of model time, silently, in front of an audience. Nor can the plain threshold thrash on a target that is not moving: the seek lands, the next call measures ~0, done. Caught in review on the PR that added the floor |
| `src/output/datasetMirror.ts` | The output's media half — a `MirroredDataset` in, something the scene can upload out. `outputLink` decides *what* to show and `outputSync` *when* within a clip; this owns the element between them, and the three rules that come with owning it. **Reload only when the pixels would differ:** a `dataset` diff is not a reload, because the bundle carries an overlay (`lonOrigin`, `boundingBox`, `isFlippedInY`, `colorScale`) that the *shader* consumes and the decoder does not — an operator changing a palette produces a `dataset` change at an identical `url`, and rebuilding hls.js for it stutters a sphere in front of an audience for no picture change, so the test is `url` and `kind` alone. **Load first, swap second:** the outgoing source is disposed only once the new one is ready, because disposing first gives a black flash on every switch, which on a projector reads as a fault — and it is what makes the failure path sane, since a load that rejects then leaves the last good picture up rather than blanking. **A slow load must not win:** every `apply` takes a generation and a stale result is disposed on arrival, or an operator clicking through the catalog lands on whichever dataset loaded slowest. `apply` never rejects — an output has no way to report one. It also owns the `createPlayheadSync` controller, because the seek-settle memory belongs with whoever owns the element it is remembering. `MediaLoader` is the whole DOM/network surface so those rules test with no element, no hls.js and no network; the default loader imports `HLSService` **dynamically**, so an output showing only images never pays for hls.js, and `isHlsManifest` strips query and fragment first because a signed CDN manifest routinely ends `…m3u8?token=…` |
| `src/output/debugOverlay.ts` | The output window's debug HUD (`docs/MULTI_MONITOR_PLAN.md` rung 11) — five fields in a corner for an operator standing in front of a sphere with no other way to ask it anything: there is no console on a projector and no devtools on a kiosk, and the control window cannot see what its outputs are doing. **dataset** comes from `datasetMirror`, not the link, because during a load those differ and the useful answer is what is on the glass. **sync** is the drift `outputSync` measured, signed and in ms — the value that actually steered, never recomputed here, since a second implementation would be free to disagree with the one doing the work; rounded to whole ms because the hard-seek threshold is 150 ms. When there is no number the field names the reason beside the dash, because the reasons are not equivalent: `not-ready` on a still image is the correct answer, and `seeking` on every sample is a correction fighting itself. A bare dash is what the first hardware pass had to report — "sync just shows a dash" — against a dataset that turned out to be in a seek loop, with nothing on the glass to separate the two. **fps** is a wall-clock delta, never a total: the decoder-budget spike found a cumulative count taken a fixed time after playback starts folds in startup latency and showed a spurious ⅓ drop that vanished once two samples were differenced. **gpu** is the unmasked WebGL renderer string, and the entire mitigation for a risk the app cannot fix — a spike found the webview silently on the iGPU of a machine with a 4090, `powerPreference` is inert, and neither wry nor tauri reads an override, so an installation can run at a fraction of its provisioned capacity undiagnosable from logs. **buffer** is the framebuffer's own size, deliberately not the window's, which is how the resolution picker is confirmed and which keeps "the frame and the monitor are two rectangles" true on screen. Refreshed on its own ~2 Hz timer rather than from the render loop, which drops to 1 Hz for static content — driving it from there would freeze the fps readout at exactly the moment someone asks why nothing is moving. Deliberately **not** i18n'd: field names and machine values for an operator, the same category as `scripts/screenshots/`'s report strings, and `check:i18n-strings` scans `src/ui/` rather than `src/output/`; the Outputs panel's toggle, which a curator sees, is translated |
| `src/output/outputLink.ts` | The output window's side of the control ↔ output link (`docs/MULTI_MONITOR_PLAN.md` §3) — everything the manager broadcast was, until this landed, broadcast at nobody: no output emitted `output_ready`, so `readyRecords()` was always empty and the whole send path was dead code in a real launch. Two rules carry the correctness. **A diff applies only if newer; a snapshot applies always** — the output coalesces most-recent-wins so a late diff would show the wrong frame, hence `seq`; but `full()` deliberately does not advance `seq`, and gating snapshots on it would break the idle heartbeat's resync (a full at the *same* seq) silently and a manager restart (a full at a *lower* one) permanently. It assumes in-order delivery, which Tauri's channel gives. **A snapshot is not "everything changed"** — the heartbeat sends one every second, so reporting every key on each would rebuild the HLS instance once a second on a projector; only genuinely-differing keys are reported, compared through `stateEquality`'s `sameValue`, the same function the aggregator sends by. The listener is installed **before** `output_ready` is emitted, since the manager answers that event with the first snapshot immediately. `OUTPUT_MODE` is a constant and deliberately not adopted from the first `view.mode` seen — an output that took its mode from the wire could never disagree with it, which makes the mismatch check vacuous; a disagreeing view is dropped while the rest of the message still applies, because the other keys are geometry-independent. `outputInitialState` reuses `equirectRtt`'s `IDENTITY_PARAMS`, the structural identity with `MirroredEquirectParams` paying off at its first call site. `OutputLinkHost` is the whole platform surface, so the link tests with no Tauri and no second monitor. Rung 13 adds `onCloseRequested`, whose whole job is to emit `output_closing` before the window goes: that announcement is the *only* thing separating an operator's Alt+F4 from a crash, since a killed process cannot report its own death — without it every deliberate close is logged as a crash and three in a minute blocklist a working monitor. It deliberately does not veto the close (a hook that could block is a hook that can strand an undecorated window) and the emit is fired rather than awaited (the window is going; there is no later point at which awaiting helps). Optional, and its absence degrades exactly that far — the static fixture page has no such notion and still connects Rung 11 adds the second channel: `OUTPUT_RENDER_CONFIG_EVENT` carries this window's **render config** (framebuffer width, debug HUD), held as `renderConfig()` and pushed to `onRenderConfig` listeners. Unlike state it is **not** diffed — nothing repeats on it unasked, so a second message means the operator did something twice — and it carries no `seq`, because a setting whose latest value is the only one that matters has no ordering hazard. Its listener is installed alongside the state one, **both** before `output_ready`: the manager answers that event with the config *and* the first snapshot, so a listener installed after would lose the window's resolution until the operator next changed it. Also holds `PICTURE_KEYS` / `PLAYHEAD_KEYS` and `changesPicture` — a compile-time partition of `StateKey` into what can put a different pixel on the glass and what only the playhead correction reads. `playback` and `primary` are the latter, and they are not un-wired keys waiting to matter: they describe where the *control window's* video is, they change on every frame the operator's globe plays, and redrawing a 4096×2048 ray-marched sphere on each one doubled an output's GPU load for an identical picture — on a machine whose webview may be on the iGPU and whose control window is decoding the same video in the next process. What this output shows moves when its own decoder advances, which `contentKindFor` already paces at 30 fps, or when the correction seeks, which the render loop catches by comparing `currentTime` across the steer. The partition is two `Exclude`/`Extract` proofs rather than one list, so a key added to the schema cannot be left unclassified *or* claimed by both |
| `src/services/multiOutput/protocol.ts` | Control ↔ output IPC contract for the multi-monitor output windows (`docs/MULTI_MONITOR_PLAN.md` §3) — the mirrored globe-state schema, the two event channels, the `output-*` window-label grammar the Tauri capability glob depends on, and the three timings both sides must agree on. Types, names and numbers only: imported by both bundles, so it holds no DOM, no Tauri import and no behaviour. Deliberately does **not** re-declare the sync constants (`SIBLING_*` live in `src/utils/time.ts`, and a copy is a copy that drifts) or the decoder budget. Playback crosses as an **ISO date plus `positionRatio` and `playbackRate`**, never a raw `currentTime`: a playhead in seconds is meaningful only against one media element and `hlsService` resolves a rendition per instance, while a ratio survives that; an assumed rate of 1 is terraviz#229 in a second window. `date` is **nullable** and the record is published anyway for a dataset with no time axis — withholding it left the output with no position, no rate and no play/pause to mirror, and therefore no reason to ever call `play()`. The view is **two types**, because the control window and an output hold different things: `SharedView` is `{ dayNight, camera: OperatorCamera }` — one globe's facts, no geometry — and `MirroredView` is a **union discriminated on `OutputMode`**, one arm per geometry, shaped `{ mode, dayNight, params }`. `OperatorCamera` is MapLibre's own lat/lon/zoom unconverted, which is what leaves no geometry privileged: each mode derives its own parameters from those three numbers rather than through another mode's answer (storing `sos-equirect`'s `cameraOffset` as the shared value shipped briefly and was wrong for exactly that reason — it is also clamped by `MAX_CAMERA_OFFSET`, so a zoom past the cap is not recoverable from it). Each arm's `params` **is** that arm's renderer parameter object: `MirroredEquirectParams` is declared structurally identical to `equirectRtt`'s `EquirectParams`, what `setParams` already takes, so a narrowed output passes `view.params` straight to the shader; a both-directions assignability proof in `protocol.test.ts` keeps them identical, held there rather than by an import since a contract must not depend on one of its consumers. `GlobeState<V>` and `GlobeStateMessage<S>` are generic over which view they carry, so `MirroredGlobeState` / `OutputGlobeState` and `SharedStateMessage` / `OutputStateMessage` are one structure rather than two copies that drift. The discriminant is also checkable: an output announces its mode in `OutputReadyEvent`, so a `view.mode` that disagrees is a window booted as one geometry being driven as another. Two `Exclude`-based constraints tie the union to `OutputMode` in both directions — a mode with no arm would ship as some other mode's shape, an arm with no mode could never be selected Rung 11 adds `OutputRenderConfig` and `OUTPUT_RENDER_CONFIG_EVENT` — how a window renders, as opposed to what it renders — deliberately a **separate channel** from state: folding a framebuffer size and a debug flag into `GlobeState` would put window settings inside the structure the aggregator diffs and sequences, paying coalescing and `seq` for values that are last-write-wins by nature, and would make a per-output setting part of a type whose whole point is that it describes one globe. `defaultRenderConfig()` is the one **function** here and the documented exception to "names and numbers only": both ends need the same defaults — the manager to seed a record, the output to have something to render during the handshake — and two copies of a two-field literal is the drift a shared contract exists to prevent; it builds a fresh object rather than exporting a shared one, for the aliasing reason `outputInitialState` copies `IDENTITY_PARAMS`. |
| `src/services/multiOutput/manager.ts` | `MultiOutputManager` — the control window's side of the multi-monitor output feature: enumerates monitors, spawns and tears down `output-*` windows, and broadcasts one ordered state stream to every live output. Everything platform-specific sits behind the injectable `MultiOutputHost` (`createTauriHost()` is the only Tauri importer), because the one thing a hardware spike actually caught a bug in — the spawn sequence — is ordering and arithmetic, and the seam is what makes it testable on a one-monitor runner. That sequence is spawn-hidden → `setPosition` → `setSize` → `setFullscreen` → `show`, and each step earns itself: `fullscreen` at construction lands on whichever monitor the window happened to appear on; `WindowOptions.x/y` are **logical** pixels while `availableMonitors()` reports **physical** ones, so passing the monitor's own numbers through the physical-only setters is what removes the `scaleFactor` bug rather than solving it; origins are **signed** (the spike's primary-left monitor sat at `x = −1680`); and `show()` last is why §6 grants `core:window:allow-show`. Diffs go only to outputs that have announced `output_ready` — one still booting would apply a diff against a state it never held. The per-second `tick()` is a **heartbeat**, not a change notification: `IPC_STALE_MS` is measured against that cadence, so it must put something on the wire whether or not anything changed, and when idle it sends a full snapshot rather than an empty ping — same round trip, and an output that missed a diff resyncs within a second. A half-spawned window is closed rather than leaked (it would otherwise be unreachable, `closeAll()` included), a rejecting `close()` is absorbed so one stuck window cannot strand the rest, and `start()` guards re-entry **before** it awaits. Also owns **persistence** (rung 10), because it owns `records` — which is exactly what gets persisted, so any other owner would have to be told when one changes and every call site that forgot would be a config that silently stopped tracking reality. `addOutput` and `restoreOutputs` share one private `spawn()`, since the sequence's *order* is its correctness and a second copy is a second place for it to drift; `spawn()` takes a label rather than minting one so a restore can reuse the label an output had last launch. `restoreOutputs()` returns before enumerating a monitor or opening the link unless the operator opted in and something is configured, starts the link before the first spawn, fails per-output rather than wholesale, paces spawns by `OUTPUT_RESTORE_STAGGER_MS`, advances the label counter past what came back, and rewrites the config with what actually did. The rest of failure recovery is a later rung; output events are recorded, not yet acted on `setOutputRenderConfig` (rung 11) mirrors `setOutputView` and is deliberately **not** routed through it: it emits on the config channel with no `seq`, persists before the ready gate (the operator's choice is theirs whether or not the window has announced itself), and merges rather than replaces, so ticking a debug box cannot drop an installation's 8K output to the default. On `output_ready` the config is sent **before** the first snapshot — a restored 8K output that got its state first would render at the default and then reallocate, a resolution pop on a projector at every launch caused by nothing but ordering. `framebufferWidths()` exists only so the panel can ask: `outputUI` is eagerly loaded and may not import the protocol at runtime, and the manager is the one thing on that path that is already loaded. Rung 11c adds the **cross-window decoder budget**: `decoderBudget()` (the operator's pinned number, else `maxVideoPanels()` — falling back rather than storing keeps an unpinned budget tracking the machine), `decoderLoad()` and the refusal inside `spawn()`, so a *restore* is held to the same rule as an Add and a machine whose budget was lowered does not bring back every window it was configured with. The count is **windows that can hold a decoder** — every control panel plus every spawned output — not decoders currently decoding, and that departs from the plan's original table on purpose: outputs mirror the primary, so each flips from free to costing a decoder the instant a video loads, and a dataset load is not a place a refusal can happen. Counting windows puts the refusal on Add, where there is a control to disable. The control window's share arrives through an injected `controlPanels()` because the manager must not know what a viewport is; `machineDecoderBudget` is injected for the same reason (`maxVideoPanels()` reads `window`) and because a test that inherited it would depend on the environment's viewport size. **Not** enforced at layout change yet. `primaryMonitor()` is passed straight through from the host rather than folded into `listMonitors()`, because `OutputMonitor` is **persisted** on every `OutputRecord`: a field added to it is a field written into an operator's stored config, where a stale "this one was primary last launch" is worse than no answer — so the panel asks for both and joins them on `monitorKey`. Rung 13 makes the manager finally *act* on a window that went away: `OutputWindowHandle.onDestroyed` (required, not optional — a host that could not report a destroy would leave the manager broadcasting to a dead window and holding its decoder slot, and an optional method is how that ends up quietly unimplemented), `handleDeparture` classifying through `outputHealth`, and the crash-storm guard consulted in `spawn()` beside the decoder refusal so a **restore** is held to it too. A departure is persisted **only when it was deliberate**: a hand-close rewrites the config without that output, a *crash* leaves it in. The operator still wants a crashed output — the display took it away — and dropping it turns a four-projector installation into a three-projector one with nothing on any screen to say which went, which is the invisible failure this module is written against; it also bounds what an ordinary quit can cost, since `quit_app` is `app.exit(0)` rather than a per-window close, so if Tauri delivers the destroys here first they all read as crashes (unverified either way on hardware) and without the split every shutdown would wipe the restore config. Three orderings carry it: `departing` is set *before* `close()` because the destroy can land while the close is still being awaited; a departure with no record left is the manager's own close finishing normally and is ignored; and `announcedClosing` is its own field rather than a read of `lastEvent`, because a health-check ping can land between the announcement and the destroy and overwrite the one fact that separates a hand-close from a crash. `onOutputsChanged` exists because the panel paints from `outputs()` and would otherwise not notice a crash until reopened — the plan asks for a toast there and the app has no toast primitive, so this is the honest half and the toast is a later change rather than one invented in passing Rung 13b makes it *report*: `spawn()`, `removeOutput` and `handleDeparture` call `outputTelemetry`'s three reporters, which is why `spawn()` now takes a monitor **index** as well as a monitor — the wire carries the index, never the display name. Emitting from `spawn()` rather than `addOutput` is what makes a launch-time restore report like an operator's Add, by construction rather than by someone remembering a second call site |
| `src/services/multiOutput/stateAggregator.ts` | The mirrored-state accumulator — facts arrive from a different place on a different schedule (a dataset load, a palette change, a playback tick, a camera move) and leave as one ordered stream of `OutputStateMessage`s. Pure: no DOM, no Tauri, no timers, no subscriptions; `apply()` takes a patch and *returns* the diff, so the whole diff/sequence contract is testable without a window or a second monitor. `full()` deliberately does **not** advance `seq` — a snapshot restates a point the sequence already reached, and bumping it would let a late joiner out-rank a diff the other outputs correctly applied. The view is held once and **projected** per output at the send boundary (`projectState`), because only `split` originates per output; the camera is held once as the operator's own lat/lon/zoom and **derived** into each arm's parameters at the send boundary, so N outputs share one fact rather than N copies of one derivation. `projectView` is the only place that conversion happens; it takes the output's `OutputMode` as an argument, and the shared view has no mode at all, which is what makes driving an output as the wrong geometry impossible rather than merely unlikely. Its `switch` is the third exhaustiveness guard (the `default` narrows to `never`), and it rebuilds each arm field-by-field rather than spreading, so a field added later cannot pass through without someone deciding whether it is shared or per-output. `DEFAULT_OPERATOR_CAMERA` is `zoom: 0`, which derives to `CENTRED_CAMERA` exactly (`1 − 1/(0+1)`), so a freshly-booted output still opens on a uniform unwrap without that identity being written twice. This is also the one module where the control side imports from `src/output/` — `cameraOffsetForCamera`, taken deliberately so `MAX_CAMERA_OFFSET` stays with the shader mirror that holds it; Rollup gives `equirectRtt` its own chunk shared by `manager` and the output bundle, and the web entry chunk only names it in the dynamic-import preload map (as it already does `manager` and `publisher`) — check markers like `uCameraOffset`, never chunk filenames. `OutputViewSettings` stays flat by contrast: only `split` is equirect-only there, and the type is persisted, so regrouping it would be a schema change that resets every operator's saved outputs. A patch whose value is structurally identical is dropped rather than forwarded, so an output that rebuilds an HLS instance on `dataset` can trust that a `dataset` in a diff means a different one — and values are stored as **copies**, because holding the caller's object lets a later in-place mutation compare equal to itself and vanish. `STATE_KEYS` carries a compile-time exhaustiveness proof (a constraint, not an annotated empty array, which checks nothing) so a key added to the schema cannot be silently left undiffed |
| `src/services/multiOutput/stateEquality.ts` | Deep structural equality over mirrored-state values, shared by **both** ends of the link — `stateAggregator.apply` asks "did this change, and is it worth sending?", `outputLink`'s store asks "did this change, and is it worth acting on?", and those must be the same question. Its own module rather than a copy each side, because the manager's idle heartbeat sends a **full snapshot every second**: an output whose equality is even slightly stricter than the control window's would rebuild its HLS instance once per second, on a projector, for the life of the session. Not in `protocol.ts`, whose functions are grammar (`outputLabel`) and narrowing (`isFullState`) rather than logic a caller could get a different answer from. `JSON.stringify` would be shorter and wrong — key-order sensitive, so two objects built by different call sites with the same fields compare unequal and re-broadcast forever. Pure, no imports, and loaded by both bundles |
| `src/services/multiOutput/globeStateEvents.ts` | The control window's publish side of the mirrored globe state (`docs/MULTI_MONITOR_PLAN.md` §3) — `main.ts` knows *when* a globe fact changes, `MultiOutputManager` knows *who* to tell, and this module is the seam so neither imports the other. That is what keeps the backout honest: remove the manager and the app still publishes, into an empty listener set. Payloads are **`Partial<MirroredGlobeState>` patches**, not a `{ type: 'dataset:loaded' }` union — a domain vocabulary would need a translation table, and the only place to put it is the subscriber, where it could disagree with the publisher about what an event implies without either side failing to compile. Publishing the wire shape itself means a field added to the schema is a field both ends already agree on. Coalescing, diffing and `seq` belong to `stateAggregator` (a publisher that also diffed would swallow a patch the aggregator needed, and two holders of "current state" is the bug its copy-on-store rule prevents); per-output projection belongs to the manager. Listeners are isolated — a thrown listener must not unwind into the dataset load that published, since a broken output link is not a reason for the control window's load to fail — and there is no replay on subscribe, because a patch is a *change* and a late joiner is caught up by the aggregator's `full()` snapshot. Pure: no DOM, no Tauri, no timers |
| `src/services/multiOutput/outputPersistence.ts` | Persisted multi-monitor output configuration (`docs/MULTI_MONITOR_PLAN.md` §3 "Persistence", rung 10) — the versioned `localStorage['sos-multi-output-config']` schema, a fail-closed parse, and the monitor-matching rule. **A name-only match is not a match:** Windows display names are assigned *positionally* and reassigned across an unplug, replug or driver update, so matching on the name alone can restore an output onto a physically different monitor while looking like it worked — a projector showing the wrong thing with nothing on screen to say so. A match requires the name **and** the signed physical origin; anything less is a monitor the manager does not recognise, skipped and logged, because restoring nothing beats restoring the wrong monitor. Origins are stored signed and as reported, since a logically-converted value cannot be compared against a fresh `Monitor.position` on a HiDPI desk. A version field exists where the plan's shape had none — without one a future incompatible change cannot tell an old blob from a corrupt one or from a newer build the user downgraded off, and this blob spawns *windows* on a machine nobody may be sitting at; a mismatch resets rather than half-applying. Malformed *entries* are dropped individually though, so one schema slip does not cost an installation its other three outputs. Storage sits behind a `StorageLike` seam and degrades to an inert store where `localStorage` is unavailable (private-mode Safari has the object and throws on use), costing persistence rather than the feature Rung 11 adds `framebufferWidth` and `debugOverlay` **without bumping the version**: both are read with a default when absent, so a config written before rung 11 restores unchanged — a bump would have reset every operator's outputs to buy nothing. `debugOverlay` persists like every other operator choice; the case against (a HUD greeting an audience after a relaunch) is answered by it being *self-announcing* — it is drawn on the sphere, so it cannot be silently on — and one setting that quietly does not come back is the worse surprise. `toPersistedOutput` takes the record itself through a `Pick`, so a renamed field fails to compile instead of persisting `undefined`. A stored `framebufferWidth` is narrowed to a real rung on parse rather than merely to a finite number: the scene would snap a stray 3000 to 2048 while the panel's picker had no option to show for it, leaving the operator with two numbers and no way to tell which the window is running. `concurrentDecoderBudget` (rung 11c) is machine-scoped and sits on the *config*, not on an output: one GPU and one media stack are shared by every window on the box, which is exactly what `maxVideoPanels()` — answering per window — cannot see. `null` means "nobody has measured this machine" rather than a stored default, so an unpinned budget keeps asking; `parseDecoderBudget` floors to a whole number and rejects anything below 1, since a budget of 0 refuses every output *and* every control panel and reads as a broken app rather than as a setting. |
| `src/services/multiOutput/outputHealth.ts` | Why an output window went away, and when to stop putting new ones on a monitor (`docs/MULTI_MONITOR_PLAN.md` §3 "Failure recovery", rung 13). Until this landed the manager *recorded* output events and acted on none: `lastEvent` was written and read by nobody, so a crashed output stayed in `records` forever, kept receiving diffs it could not apply, and still counted against the decoder budget — and an operator who closed one by hand got the same. Pure, and split from the manager for the reason `stateAggregator` is: the decisions have wrong answers and none needs a window to reach. **Absence is the signal, and it errs one way on purpose** — a killed process sends nothing by definition, so a crash is a destroy that was preceded by nothing, and any lost or late `output_closing` reads as a crash. That asymmetry is chosen: a crash misread as a close is *invisible* (the record vanishes, the operator is told nothing, a dying installation looks tidy), while a close misread as a crash costs one wrong line and one telemetry `reason`. `managerInitiated` is checked **before** `sawClosing` because both are true for the same departure when the operator uses Remove — the panel's close fires the output's own close-requested handler — and the manager's intent is the fact that is not in doubt. The crash-storm guard keeps **two durations apart**, which is the easy thing to conflate: `CRASH_STORM_WINDOW_MS` decides whether three crashes were *a storm* (three across an afternoon are three incidents), while the block it trips does **not** expire, because nothing observed since suggests the hardware improved and an expiring block returns the operator to the retry loop it exists to break. Never persisted — a block written to disk outlives the reseated cable that fixed it, and relaunching is a reset an operator reaches without being told. Keyed on `monitorKey`, not index, since a replug renumbers the enumeration and would move the block to whichever display took the index |
| `src/services/multiOutput/outputTelemetry.ts` | The three Tier A events the control window ships about its outputs (`docs/MULTI_MONITOR_PLAN.md` §3, Open Question 3 — decided; rung 13), and the projections that shape them. **The outputs themselves emit nothing, ever** — §3.6 keeps them capture-clean because the common installation pattern is an HDMI capture card taking a monitor as input, and an output phoning home would be that leak one layer down; it also buys nothing, since the two failures an output could report about itself (a crash, an IPC silence) are precisely the two it cannot. Tier A rather than Research because the motivation is *installation* health: an event that only shipped for the fraction of users who opted in would answer "how often do outputs crash?" with a number nobody could act on, and no field here is free text, a coordinate or a device string, so none of the hashing/sanitising/rounding invariants apply. The one field that could have identified hardware does not — the monitor is an **index into the enumeration**, never the OS-reported display name (a user-set string on macOS, a panel model number on plenty of Windows boxes) — and the framebuffer is a **rung name**, snapped *down* like `outputScene.setFramebufferWidth` does, so a `4k` bucket can never mean a window rendering 8K; `BUCKET_FOR_RUNG` is typed `Record<FramebufferWidth, …>` so adding a rung to the ladder fails to compile here rather than reporting the new one as a neighbour. `removalReasonFor` collapses `removed` and `closed` to one `operator-close`: the manager has to keep them apart (one is its own `close()` completing and must not touch `records`) but publishing that distinction would put its bookkeeping in the schema, where the split that matters — deliberate versus not — is already there. Split from the manager for `outputHealth`'s reason, and paired with it: that one decides *what happened*, this one *what to say about it*, which is what keeps the classification free of any opinion about a wire format. A crash emits **two** events, not one — the removal answers how many outputs stopped and why, the failure answers how healthy the installation is, and a dashboard asks those separately. A spawn the storm guard refuses reports `rejected-by-storm-guard`, which reads odd for a window that never existed and is right for the case it is for: on a *restore*, the config said four outputs and three came back. A spawn the **decoder budget** refuses reports nothing, because the panel already shows "N of M in use" and disables Add — an affordance the operator can see beats a report after the fact. `retries` and `recovered` have no defaults on purpose, so a detector that does not attempt recovery says `0` and `false` rather than inheriting them. Every emit goes through a swallowing `report()` for the reason `notifyChange` isolates its listeners: the reporters are called from the middle of the manager's bookkeeping, `emit` reaches `loadConfig()` (localStorage, which private-mode Safari has and throws on) and a transport once a batch fills, and a throw between deleting a record and persisting it would leave an output gone from memory, still in the config, and back on the next launch |
| `src/services/multiOutput/mirrorState.ts` | Pure projections from the control window's app types into the protocol's mirrored shapes (`docs/MULTI_MONITOR_PLAN.md` §3) — the translation layer `main.ts` would otherwise carry inline, moved out because the derivations have correctness content worth testing and `main.ts` is four thousand lines with nowhere to test them. `overlayForMirror` fills the gap between `overlayOptionsFromDataset`, which returns `undefined` for the common global/prime-meridian/unflipped Earth picture to keep the renderer's fast path, and the wire format, which requires a bundle: the fallback is identity-only, because the reason `overlay` is required is `datasetId` / `datasetTitle` — identity travels with the geometry so a frame can say what it is without asking app state and hoping the two agree, and that does not weaken for a dataset whose geometry happens to be the default. `toMirroredDataset` returns **null** for an absent URL rather than a record carrying `''`: an output handed an empty URL fetches its own document and decodes the HTML as a texture, failing far from the cause, and `null` is the value the schema already defines as nothing loaded. Takes plain values rather than a `PanelState`, so a test needs no `HTMLImageElement` and no `HLSService`. Also `panelMirrorState`, the three-way `empty` / `ready` / `unsettled` decision behind whether a panel can be mirrored at all: a panel's `dataset` is assigned *before* its load is attempted and stays set when one fails, while one is in flight, and for a `tour/json` row that paints nothing — so the row and the pixels can describe different datasets, and mirroring from the row alone puts one dataset's texture under another's bbox, `lonOrigin`, flip and palette with the wrong title. `unsettled` publishes **nothing** rather than `null`, because blanking the sphere while the operator still sees the old dataset is its own wrong answer. It lives here rather than in `main.ts` because it is the one part of that wiring with a wrong answer available, and `main.ts` has no exports to test through Rung 7's other half landed here after the first hardware session found the outputs frozen: `operatorCameraFrom`, `playbackFrom`, `primaryFrom` and `sharedViewFrom`. The camera one exists because **MapLibre does not wrap `getCenter().lng`** — drag east around the globe three times and it reads 900-odd, and `cameraOffsetForCamera` builds a *direction* from it, so an un-normalised value aims the output somewhere the operator is not and gets further wrong the longer they pan; the antimeridian resolves to `180` rather than `-180` so a parked camera does not alternate and re-broadcast forever, zoom floors at 0 because `1 − 1/(z+1)` inverts the warp below it, and a non-finite value falls back to centred rather than reaching the shader as a `NaN` offset that makes every ray miss. `playbackFrom` returns `null` only when there is no playhead to describe at all — no media, or a duration or position that has not firmed up. A paused primary still has a position an output must hold, so `paused` is carried rather than treated as an absence, and **a missing time axis is not an absence either**: it yields `date: null` inside a published record rather than a withheld one, with `positionRatio` carrying the position that survives having no clock — and it goes through `videoTimeToDate`, the same function the control window's own time label uses, since a second derivation could disagree with what the operator is reading. `sharedViewFrom` builds the whole `SharedView` because the aggregator diffs whole keys; its `dayNight` is a constant, not a plumbed value, as nothing on the control side toggles it yet. `displayForMirror` collapses the identity transform to **`null`** rather than sending `DEFAULT_DISPLAY`: `null` is already what the aggregator holds before the operator touches anything and what `outputScene.paletteTexture` reads as "the dataset's own ramp", so publishing the identity object would put a second encoding of the same fact on the wire, reaching the shader through `buildDisplayLut` with identity parameters instead of `buildColorScaleLut` — two paths that then have to agree byte for byte, and which the aggregator's structural equality cannot collapse because the values genuinely differ. The visible half is the reset: try magma, go back to source, and every output returns to the state a freshly-booted one is in. `isDefaultDisplay` is imported rather than re-derived, since a second copy of "what counts as no transform" could disagree with the control window's own reset control |
| `src/services/multiOutput/bootMultiOutput.ts` | Boot-side composition of the multi-monitor output feature (`docs/MULTI_MONITOR_PLAN.md` §3) — the only module that knows about both the publisher (`globeStateEvents`) and the consumer (`MultiOutputManager.applyState`), because none of the three alternatives work: `main.ts` exports nothing and boots on import so wiring there is unreachable from a test, `globeStateEvents` must not learn what an output is, and `manager.ts` importing the publisher would close the seam from the other side and stop the manager being constructible without the app. `start()` is **never** called here — it opens the IPC listener and the 1 Hz heartbeat, and an app with no outputs must not pay for a link nobody is on; `outputUI` calls it on the operator's first add and `restoreOutputs()` on a restore, both awaited before the spawn. `restoreOutputs()` *is* called here, unconditionally and un-awaited: cheap by construction (it returns before enumerating a monitor unless the opt-in and a stored set both hold), and testing that flag here instead would put a second reader on it, free to disagree with the manager's — while awaiting it would drag the restore stagger onto the boot path it exists to stay off. Also exposes `available`, the synchronous desktop gate the Tools menu reads while building its markup to decide whether to render an Outputs entry at all — it reports the gate this module already applied rather than letting a call site re-test `window.__TAURI__`, and it stays `true` on a failed host, since that is the panel's story to tell and the failure path releases the sentinel so a retry can succeed. Subscription is **synchronous** while the host is not: `createTauriHost()` awaits three dynamic imports and `subscribeGlobeState` has no replay, so patches are queued until the manager exists — without that the first dataset load, which lands inside that window, is lost for good, and the loss only surfaces at rung 9 as an output receiving a `full()` snapshot for a dataset the aggregator never saw. A module-level sentinel makes a second call return the same handle rather than attaching a second listener (module-scoped set → every patch forwarded twice). Desktop gate lives here rather than at the call site, so the web build pays one call returning a shared inert handle — which holds only because `import('./manager')` is **dynamic**: a static import pulls `manager` + `stateAggregator` + `protocol` (~1,200 lines the web build cannot reach) into the entry chunk, un-tree-shakeable since the manager is constructed at runtime. That regression is invisible to the plugin-literal grep that polices Tauri leakage — it shipped once for that reason — so check `sos-equirect` is absent from `dist/assets/main-*.js` and present in a `manager-*.js` chunk Also passes `controlPanels` through to the manager (rung 11c): the decoder budget needs the control window's panel count, the manager must not learn what a viewport is, `viewportManager` must not learn what an output is, and this module is already the seam where `main.ts` legitimately joins the two. |
| `src/services/mapRenderer.ts` | MapLibre GL JS globe — GIBS tiles, navigation, markers, terrain |
| `src/services/viewportManager.ts` | Multi-globe orchestrator — 1/2/4 synchronised MapRenderer instances in a CSS grid, camera lockstep, panel promotion |
| `src/services/earthTileLayer.ts` | CustomLayerInterface — day/night blend, clouds, specular, sun, skybox |
| `src/services/dataService.ts` | Fetches SOS catalog, merges enriched metadata, 1-hour cache |
| `src/services/datasetLoader.ts` | Loads a dataset onto the globe (HLS or image); manages info panel |
| `src/services/hlsService.ts` | HLS.js wrapper — adaptive bitrate streaming via Vimeo proxy. Also holds a rendition for short looping assets: hls.js's ABR cannot converge on a 2-3 s loop of one or two fragments (its sampler floors every measurement window at 50 ms, so a 0.2 s leading fragment can never *measure* a fast link; and its fetch-duration test weighs a level's ~1.2 s average fragment against the 0.2 s actually buffered, so every rung fails and ABR steps down a rung per playlist load). Once the asset is fully buffered nothing requests another fragment, so the floor stuck for the instance's lifetime — a 4096x2048 source played at 1440x720 on gigabit with the asset cached. `measuredBandwidthBps` reads the true transfer rate off the throwaway probe fragment and `selectRendition` picks the best rung that fits it under `autoLevelCapping`; long assets are left to ABR |
| `src/services/docentService.ts` | Orbit orchestrator — hybrid LLM + local engine |
| `src/services/docentContext.ts` | LLM system prompt builder, history compression, tool definition |
| `src/services/docentEngine.ts` | Local keyword-based fallback engine |
| `src/services/docentAnalysisTools.ts` | The executors behind Orbit's answers about values (`docs/DATA_ANALYSIS_PLAN.md` §A6) — `probe_value` / `summarize_region` / `find_extremum` over the displayed frame, via a registered `DocentAnalysisSource`. Synchronous and local: no network, no endpoint. `isAnalysisAvailable()` is the gate the tool array is built from — it asks the source for a frame, which is false for a picture dataset, a browser without WebGL2, or a dataset mid-load, so absent either the tools are never offered and Orbit is unchanged. Every result carries a quantisation note, and low coverage carries a prose caveat |
| `src/services/llmProvider.ts` | OpenAI-compatible SSE streaming client + `/models` fetch |
| `src/services/downloadService.ts` | Offline dataset download manager (desktop only, Tauri commands) |
| `src/services/tilePreloader.ts` | Eagerly fetches low-zoom GIBS tiles into cache on startup |
| `src/services/catalogSource.ts` | Build-time switch for where `dataService` / `datasetLoader` source catalog data (SOS snapshot vs node catalog), plus `sampleToursEnabled()` — the `VITE_SAMPLE_TOURS=false` opt-out that stops the two bundled sample tours being injected into the catalog on a node that never held the SOS datasets they drive |
| `src/services/relatedDatasets.ts` | Algorithmic (lexical) related-dataset recommendations — the offline fallback |
| `src/services/relatedDatasetsService.ts` | Client for the semantic "more like this" endpoint (`GET /api/v1/datasets/:id/related`); the info panel renders the lexical list, then progressively enhances it with this. Degrades to `null` (keep lexical) on any failure |
| `src/services/visitMemory.ts` | Local-only log of which datasets the user has opened (localStorage) |
| `src/services/qaService.ts` | Loads / queries the preprocessed Q&A knowledge base (local docent path) |
| `src/services/deepLinkService.ts` | Deep-link handler — `zyra://` URLs and `/dataset/…` links |
| `src/services/shareService.ts` | Share datasets via the Web Share API or clipboard |
| `src/services/screenshotService.ts` | Captures the globe canvas (+ optional UI) as a compressed JPEG data URL |
| `src/services/globeThumbnail.ts` | Renders a 2:1 equirectangular data frame onto a sphere (lazy Three.js, in-browser) and captures a square globe thumbnail — the publisher-portal generator for `thumbnail_ref` |
| `src/services/zipDownloadService.ts` | Web-only "package a dataset as a `.zip`" entry point |
| `src/services/heroService.ts` | Picks the single "Right now" hero candidate for the catalog landing surface |
| `src/services/generalFeedbackService.ts` | Posts app-level feedback (bug / feature / other) to `/api/general-feedback` |
| `src/services/playlistService.ts` | CRUD over user-curated dataset sequences (localStorage) |
| `src/services/playlistPlayback.ts` | "Active playlist" state machine |
| `src/services/datasetFilter.ts` | Catalog filter predicate engine — shared by the chip rail and the Graph / Map / Timeline views |
| `src/services/catalogGraph.ts` | Catalog **Graph** view — pure transform from a filtered catalog to a cytoscape node/edge graph (facet/keyword co-occurrence) |
| `src/services/catalogMap.ts` | Catalog **Map** view — pure transform to one bbox overlay per dataset (geographic coverage) |
| `src/services/catalogTimeline.ts` | Catalog **Timeline** view — pure transform to one row per dataset on a shared time axis |
| `src/services/catalogEvents.ts` | Catalog **events overlay** — pure transform from public approved events + the visible dataset set to event overlays for the Map/Timeline views (`docs/CURRENT_EVENTS_PLAN.md` §6.3) |
| `src/services/eventsService.ts` | Client for the public approved-events reads — the catalog list (`GET /api/v1/events`) and the per-dataset "In the news" list (`fetchEventsForDataset` → `GET /api/v1/datasets/:id/events`); shared fetch + sanitize (http(s) source-url guard) + 60s cache |
| `src/services/datasetProbe.ts` | Hover value readout for data-encoded datasets — pure lat/lon → texel UV (mirrors the shader maths, image-space V), the `LumaSampler` seam, and the mapping from luma back to a physical value (`docs/DATA_ENCODED_VIDEO_PLAN.md` §Part 4) |
| `src/services/glLumaSampler.ts` | The shipped `LumaSampler` — reads one texel through a WebGL2 context (`texImage2D` → 1×1 draw → `readPixels`), the configuration `scripts/luma-range-check` measured correct on every browser. Replaces a 1×1 `drawImage` into a 2D canvas, which Safari (macOS + iOS) colour-transforms; no 2D fallback, deliberately. One page-shared instance via `getSharedLumaSampler()` — per-renderer instances put a 4-globe layout at eight contexts. Also `snapshot()` → `LumaSnapshot`, the whole frame's luma plane read once into a `Uint8Array` through a lazily-built R8 framebuffer (RGBA fallback when the driver won't read RED back), cached per frame — the user-initiated read the statistics reducers consume, never a pointer path (`docs/DATA_ANALYSIS_PLAN.md` §A2) |
| `src/services/datasetStats.ts` | Pure statistics over a `LumaSnapshot` — area-weighted 256-bin histogram (the bins *are* the source values), region summary (min/max/mean/median/p10/p90/σ/coverage/km²), area-above-threshold, extremum location, great-circle transect sampling, zonal-mean profile, and the lat/lon-box → texel-window mapping. Weights by true spherical cell area and excludes the no-data band; no DOM, no GL, no fetch (`docs/DATA_ANALYSIS_PLAN.md` §A2) |
| `src/services/datasetContours.ts` | Pure isolines over a `LumaSnapshot` — marching squares at a *set* of physical levels (one cell walk, every level tested inside it, since the shipped frames are ~8.4M texels and per-level passes would stall) → lat/lon polylines → a GeoJSON `FeatureCollection` carrying each level's value and colour, so MapLibre paints every line from its own level. A cell touching absent data emits nothing (tracing the no-data footprint is the `vmin` mistake in another form), values come from a 256-entry table built *through* `lumaToValue` rather than an inverse of it, saddles resolve by the cell mean, and a line that jumps the antimeridian is cut rather than drawn across the globe (`docs/DATA_ANALYSIS_PLAN.md` §A5) |
| `src/services/datasetOverlayOptions.ts` | Pure helpers for the dataset-overlay rendering path (Phase 3e) |
| `src/services/playbackSettle.ts` | The playback→panel seam — when has the playhead stopped moving? A pure `PlaybackSettleDetector` (paused, not seeking, and still for `quietMs` → one signal per settled position) plus `createPlaybackSettleWatcher`, which returns a `tick` to ride `playbackController`'s existing rAF loop rather than starting a second one. Lets a surface that describes *one* frame recompute when the viewer pauses or finishes a scrub, instead of only dropping its result. Deliberately silent during playback at **any** rate: `currentTime` is a clock rather than a frame counter, so it never holds still and no epsilon separates slow playback from normal — tracking a slowly-playing video is a periodic-recompute mechanism, not this one. Mirrors `voiceVad`'s pure-machine-plus-thin-composition shape; no DOM, no rAF, no timers |
| `src/services/colorScaleDisplay.ts` | Pure display transforms over a data-encoded palette — palette swap (viridis / magma / turbo / grayscale), contrast stretch, value threshold — all expressed as a rebuilt 256×1 LUT via `buildDisplayLut`, plus colorbar ticks at round numbers and CSS gradient stops sampled from that same LUT. Alpha always comes from the dataset's own ramp, and **a display transform never changes a reported value** (`docs/DATA_ANALYSIS_PLAN.md` §A1) |
| `src/services/markdownRenderer.ts` | Markdown → safe HTML renderer (Orbit messages, doc content) |
| `src/services/docentDegradedState.ts` | Session-scoped degraded-mode state for the docent |
| `src/services/appleIntelligenceProvider.ts` | On-device LLM Orbit backend via Apple's Foundation Models framework (macOS) |
| `src/services/voiceService.ts` | Orbit voice foundation — STT/TTS capability detection, provider registry + resolver (`auto` = on-device → browser; `cloud` opt-in only) incl. the Phase 3 realtime streaming-STT registry/resolver, per-locale capability matrix, recognition-language options, spoken-form projection + sentence chunking (`docs/ORBIT_VOICE_PLAN.md`) |
| `src/services/voiceBrowserEngines.ts` | Browser Web Speech engines registered against `voiceService`'s resolver — Phase 1 push-to-talk `SpeechRecognition` STT + `speechSynthesis` TTS, plus the Phase 3 **continuous** streaming STT engine (zero-dependency hands-free path) |
| `src/services/voiceCloudEngines.ts` | Cloudflare-edge voice engines — push-to-talk STT + Phase 3 **streaming** STT (`/api/voice/transcribe`, Whisper, one VAD-bounded utterance per turn; or the realtime WS engine when `VITE_VOICE_WS_STREAMING` is on) + TTS (`/api/voice/synthesize`, MeloTTS/Aura); opt-in `cloud` provider, web-only, honours the `KILL_VOICE` cooldown |
| `src/services/voicePcm.ts` | Pure PCM helpers for the realtime WS STT path — downsample to 16 kHz, pack linear16 (little-endian), parse Deepgram `{channel.alternatives[].transcript, is_final}` messages (`docs/ORBIT_VOICE_PLAN.md` §10.1) |
| `src/services/voiceWsStreaming.ts` | Phase 3 realtime **WebSocket** streaming STT engine — live interim transcripts over the `/api/voice/stream` proxy → Cloudflare Deepgram Nova-3/Flux; streams linear16 PCM, emits `onPartial`/`onTurn`; injectable socket + Web Audio capture seams |
| `src/services/voiceVad.ts` | Phase 3 local voice-activity detection — pure `EnergyVad` energy-threshold state machine (attack/release hysteresis) + thin `startMicVad` Web Audio capture loop; gates mic audio locally before any realtime streaming (`docs/ORBIT_VOICE_PLAN.md` §9.1) |
| `src/services/voiceWakeWord.ts` | Phase 3.5 wake-word — pure `WakeWordDetector` score→wake state machine (threshold / debounce / cooldown) + `startWakeWord` composition over a `WakeWordScorer` seam; selects the ONNX backend when `modelBaseUrl` is set (`docs/ORBIT_VOICE_PLAN.md` §8 decision 5) |
| `src/services/voiceWakeWordOnnx.ts` | Phase 3.5 openWakeWord ONNX scorer — on-device melspectrogram → embedding → wake-model pipeline producing per-frame scores; lazy-imports onnxruntime-web from a configurable CDN (no npm dep), models loaded from `modelBaseUrl` (`docs/ORBIT_WAKEWORD.md`) |
| `src/services/voiceRealtimeSession.ts` | Phase 3 hands-free session controller — composes the streaming STT engine + local VAD gate into one turn cycle; drives both the `open-mic` (VAD-gated) and `push-to-talk` (caller-driven) interaction models; mic/VAD seams injectable for tests (`docs/ORBIT_VOICE_PLAN.md` §9.1) |
| `src/services/windowChrome.ts` | Fullscreen, decorations and the idle cursor for **both** windows (`docs/MULTI_MONITOR_PLAN.md` §3.6, rung 12) — all of it for one reason: a title bar leaks into the signal, because the common installation pattern is an HDMI capture card taking a monitor as input, and everything the OS draws around the window arrives on the sphere with the picture. Outputs already spawn fullscreen and decorationless; this is the same treatment for the control window plus the escape hatch that makes an undecorated window recoverable. **Fullscreen and decorations move together** — `setFullscreen(true)` alone leaves the title bar on some window managers and removes it on others, so they are one operation here and no call site can do half of it; decorations follow rather than lead, since a window that dropped its title bar and then failed to go fullscreen cannot be moved, resized or closed. `isFullscreenHotkey` is pure and every clause is a bug someone has shipped: `repeat` (holding F11 strobes the window between states), modifiers (Shift/Ctrl+F11 are bound by desktop environments and devtools), and `defaultPrevented` (one press, two actions). The controller holds its own state because two of three platforms cannot be asked synchronously, but corrects it from whatever the host *can* report — the browser exits fullscreen on Escape without telling whoever asked, so `fullscreenchange` is listened for rather than trusted away. `restoreOnLaunch` is desktop-only and not for tidiness: `requestFullscreen` needs a user gesture, so restoring on the web throws on every launch and changes nothing. The web host's `setDecorations` is a deliberate no-op rather than a rejection — there is no title bar in a tab, so the operation already succeeded. The idle cursor is a **class** rather than an inline style so the rule can live in CSS where the `*` selector it needs is expressible (a `cursor: none` on the root alone loses to every button's own `cursor: pointer`), re-checks `active` at fire time so leaving fullscreen mid-countdown cannot hide a windowed app's pointer, and listens on passive `pointermove` so a pen counts and scroll is never blocked. Shared by `main.ts` and `src/output/main.ts` deliberately: F11 means the same thing in both, and a second copy is a second place for the decorations half to be forgotten. Also `isQuitHotkey` / `createQuitHotkey` — **Ctrl+Q**, which rung 9 step 29 asserted "exits cleanly" as if it existed and nothing bound. It is the kiosk launch that needs it: `--kiosk` leaves no close button, no title bar to right-click and no menu bar, and Alt+F4 answers that on Windows and nothing answers it portably. **Ctrl only, never Cmd** — macOS already quits on Cmd+Q through the standard application menu, so binding it here would put two handlers on one keystroke, which is why `metaKey` is an explicit no rather than an omission. `repeat` matters more here than on a toggle: holding F11 strobes a window, holding this queues a second exit behind the one already tearing the process down. The host's `quit` is **optional and its absence is the web build's safety** — a tab cannot close itself and Ctrl+Q is Firefox's own quit, so the DOM host implements none and the binder is inert without a second platform test, claiming nothing and swallowing nothing. Wired in the control window alone; an output keeps F11 (recover the title bar, close the one window), because ending the installation from the projector is not what an operator at the sphere means, and the capability split enforces the same a layer down since `output.json` has no `core:default` and therefore no `invoke` at all |
| `src/services/uiScaleService.ts` | Runtime side of the `--ui-scale` token (§7.1) |
| `src/services/shaderSettingsService.ts` | Runtime side of the globe-shader uniforms (§7.2) |
| `src/services/atmosphereConstants.ts` | Atmospheric-scattering constants + GLSL snippets shared by `earthTileLayer` and the VR/Orbit Earth |
| `src/services/atmosphereLut.ts` | Transmittance look-up table (LUT) for atmospheric scattering |
| `src/services/vrBorders.ts` | VR country / coastline borders overlay — thin transparent shell outside the globe surface |
| `src/services/vrBrowse.ts` | In-VR dataset browse panel (CanvasTexture) — switch datasets without exiting immersive mode |
| `src/services/vrTimeLabel.ts` | In-VR dataset time label — billboarded floating panel above the globe |
| `src/services/vrTourControls.ts` | In-VR tour control strip — prev / play-pause / next / stop + step counter |
| `src/services/vrTourOverlay.ts` | In-VR tour overlay manager — CanvasTexture + VideoTexture panels replacing the 2D `tourUI` surface |
| `src/ui/chatUI.ts` | Orbit chat panel — rendering, settings, trigger positioning; the §A6 `show-analysis` chip that opens Analyze on a region Orbit just measured (display-only, never deferred, and absent unless the host wires `onShowAnalysis`) |
| `src/ui/voiceHandsFree.ts` | Phase 3 hands-free wiring — `HandsFreeController` bridges `RealtimeVoiceSession` to the chat input/send path (partials→input, turn→send, suspend during think/speak), drives open-mic mute, push-to-talk press, and the **wake-word** model (an on-device wake phrase — built-in default "Hey Jarvis" — arms a single turn via `startWakeWord`; `isWakeWordConfigured()` gates it on `VITE_VOICE_WAKEWORD_MODEL_URL`); inert until opted in and a streaming engine resolves (`docs/ORBIT_VOICE_PLAN.md` §9.1, `docs/ORBIT_WAKEWORD.md`) |
| `src/ui/analyzeUI.ts` | The Analyze panel (Tools → Analyze) — region picker (whole dataset / current view / a named region via `resolveRegion`), area-weighted statistics over one snapshot of the displayed frame, the palette-coloured histogram, coverage, the quantisation-step caveat, and CSV export (`docs/DATA_ANALYSIS_PLAN.md` §A3); plus the **transect** section (§A4) — two-point pick through the injected `TransectPicker` seam, a profile re-sampled live as an endpoint drags, and its own CSV — the **zonal profile** (§A8's spatial half) — the field's shape against latitude over the same window the statistics cover, shown unprompted because the axis it reduces along is chosen by the region rather than by the user, with the peak band and its own CSV — and the **region outline** through the injected `RegionOutline` seam, which draws the picked box on the globe (outline only, never a fill: a wash would tint the values being measured). Reads through an injected `AnalyzeSource` rather than a renderer singleton; one frame is held per refresh so a drag never triggers a second readback |
| `src/ui/analyzeCharts.ts` | Hand-rolled SVG for the Analyze panel — the histogram painted from the same display LUT the shader samples (square-root height scale, because these fields are far too skewed for a linear one) plus the stat tile. Bars aggregate `HISTOGRAM_BUCKET` luma codes over the exact 256-bin model: the untagged limited-range round trip leaves ~1 code in 7 unreachable, so one bar per code draws the transport's lattice as a comb (`docs/DATA_ANALYSIS_PLAN.md` §The transport lattice). Also `renderTransectChart` — the value profile along a line, stroked per segment from the same LUT over a colour strip of what the line crosses, scaled to the transect's own range and deliberately **not** filled (a baseline that isn't zero makes an area that encodes nothing); gaps break both the stroke and the strip. And `renderZonalChart` — the same treatment turned ninety degrees, latitude descending the vertical axis so the profile lines up with the globe beside it, positioned by each row's own latitude rather than by its index. Mirrors `publisher/analytics-charts.ts` without importing across the portal boundary |
| `src/ui/analyzeExport.ts` | CSV serialisation for the Analyze panel — pure `buildCsvText` (header block naming dataset / region / units / quantisation step, the summary, then the full occupied distribution at full precision) and `buildTransectCsvText` (the same header plus length / sample spacing, then one row per sample — gaps kept as valueless rows so the file cannot close a hole the chart broke) and `buildZonalCsvText` (one row per latitude band, carrying the per-band texel count because a mean over four texels does not deserve the weight of one over four thousand), plus the browser download trigger |
| `src/ui/colorbarUI.ts` | The floating colorbar drawn from a dataset's `ColorScale` (replacing the uploaded legend image for data-encoded rows) and the palette / range / threshold controls it opens; every control writes through immediately, since the whole point is that a transform costs one LUT upload |
| `src/ui/browseUI.ts` | Dataset browse/search overlay |
| `src/ui/downloadUI.ts` | Download manager panel — view/delete cached datasets (desktop only) |
| `src/ui/outputUI.ts` | The Outputs panel (Tools → Outputs) — the multi-monitor feature's first user-reachable surface (`docs/MULTI_MONITOR_PLAN.md` rung 9), and the only caller of `addOutput`: it enumerates monitors, spawns an output on the chosen one, lists the live ones and tears them down. Every `multiOutput/` import is **type-only and must stay so** — `main.ts` imports this eagerly, so a runtime import would pull the manager cluster back into the web entry chunk that `c8df3380` moved it out of; the manager arrives through the injected `OutputPanelSource`, which is also what lets a test drive this without Tauri. That seam is a *structural* subset rather than `MultiOutputManager` itself, because a class with private fields is typed nominally and no fake could satisfy it without a real host. `manager.start()` is called on the first add rather than on open — nothing is on the link until an output exists — and **awaited before the spawn**, since the output emits `output_ready` over that link as it boots and a listener installed after would race it. Nothing calls `stop()` when the last output goes: one whose `close()` rejected is still out there, and cutting the heartbeat strands it on its last frame. The occupied-monitor guard lives here because `addOutput` accepts any index, and two fullscreen windows on one monitor means one is invisible with no way to tell which; it keys on name **and** signed origin, the same identity rung 10's restore matching uses. Also carries the "Restore outputs on launch" opt-in (rung 10), off by default — an operator who added an output once, on a laptop later taken home, should not have a window try to open on a projector that is not there, and off is what keeps "an install that never enabled outputs pays nothing" true Rung 11 adds the **Debug overlay** switch, which writes through `setOutputRenderConfig` onto the config channel rather than `setOutputView` — to the operator it is the same kind of switch, but routing it through the view would put a checkbox inside the sequence the aggregator diffs. Its label says the HUD is drawn *on the output*, since that is the part someone about to run a show needs to know. `buildToggle` now takes the commit as a callback rather than a settings key: the part worth having once is not the field name but the disable-while-in-flight, put-the-box-back-on-failure, never-refresh behaviour around it. Rung 11b adds the **framebuffer picker**, and it is where the type-only rule above bites: the ladder is read through `mgr.framebufferWidths()` rather than imported from `protocol.ts`, because a runtime import here puts `sos-equirect` and the rest of the contract into the web entry graph — the regression `c8df3380` removed. The control is called *Framebuffer*, never Resolution: the head line already carries the monitor's own pixel count, so the two sit one above the other and the distinction the plan's "two rectangles" section exists to keep needs no sentence. The whole ladder is offered rather than the rungs at or below the monitor, since 1024 (preview a sphere on a desk monitor) and 8192 (drive a sphere from a 1080p preview) are the two cases the picker is most for. A width that is not one of the offered rungs is *shown* rather than rounded to a neighbour the output is not running at. Rung 11c adds the **decoder budget** field and its "N of M video decoders in use" readout under Add, and disables Add with a message naming what to close when the budget is spent — the manager refuses this too and would throw, so the disabling is the affordance rather than the invariant. It is the one control here that repaints the panel on change, because the number gates the button and the warning beside it. Rung 9 step 5 failed on hardware — "I don't see a positions diagram… I don't see anything about primary" — so the picker now carries both. **Primary is asked, never inferred:** `primaryMonitor()` is a second host call joined on `monitorKey`, because the obvious inference is wrong often enough to matter (the origin on Windows by definition, usually on macOS, and on X11 whatever `xrandr --primary` marks, which can sit anywhere) — a guess that is usually right and silently wrong is the failure the name-only monitor match was rejected for. It is marked in the **option text**, in four keys rather than one template plus composed fragments, since "(primary, already in use)" is one phrase in English and two clauses joined differently elsewhere; that is also what makes it survive a screen reader and a monochrome preview. The **position diagram** is `monitorLayout`, pure and exported for the same reason `monitorKey` is: signed origins are its whole difficulty (the spike's secondary sat at `x = -1680`, which an assumed non-negative origin draws off the left edge of its own container), it returns fractions rather than pixels because only the browser knows the element's size, and it returns `null` rather than an empty layout since a framed empty box reads as a fault. One undrawable monitor is dropped and the rest still placed, the per-entry tolerance rung 10's persistence parse uses, with `index` still pointing into the array passed in so a box ties back to its option. The boxes are placed with **physical** `left` / `top` from TypeScript, and that is the point rather than an oversight: this is a picture of a desk, so it is the one part of the app that must not mirror under `dir="rtl"` — which is exactly what the logical properties everything else uses would do to it. The diagram is `aria-hidden` and presentational, because every fact it draws is in the option text beneath it and a second *control* for one value is two tab stops over a grid of unlabelled rectangles |
| `src/ui/mapControlsUI.ts` | Map controls positioning helper — keeps the Tools bar above the playback transport |
| `src/ui/playbackController.ts` | Playback transport controls + portrait-mobile positioning |
| `src/ui/toolsMenuUI.ts` | Tools popover — Browse button, view toggles (labels, borders, terrain, auto-rotate, info, legend), layout picker, Orbit settings entry point, Meet Orbit link (web only) Its fullscreen button (from §3.3) is upgraded at rung 12 to go through `windowChrome`'s `FullscreenController` when a host wires one: the raw `document.requestFullscreen` it used before fullscreens the *webview* and leaves the native title bar and border in the captured signal, and it read its own label off `document.fullscreenElement`, which stays **null** when the native window goes fullscreen — so on desktop it offered "Enter fullscreen" over a window already in it. The controller is module-scoped rather than threaded through because `syncFullscreenButton` is called from a document-level `fullscreenchange` listener registered once for the life of the page, and re-registering that on every re-init to give it a closure would be worse. With no controller the old DOM path stands, which is what the web build uses. |
| `src/ui/vrButton.ts` | Enter AR / Enter VR button — feature-gated (hidden on non-WebXR browsers), lazy-loads Three.js on tap |
| `src/ui/vrZoomOverlay.ts` | DOM zoom slider mounted on screen-tap AR sessions (phone via ARCore Chrome). Drives `globe.scale` through a callback; log-mapped so each unit of slider travel is a constant multiplicative zoom. Lives under `src/ui/` so the i18n string lint covers it. |
| `src/services/vrSession.ts` | WebXR session lifecycle — requests `immersive-ar` or `immersive-vr`, wires renderer.xr, drives the per-frame loop, handles anchor persistence, falls back to `local` reference space if `local-floor` is unsupported |
| `src/services/vrScene.ts` | VR scene framing — background (space blue vs transparent passthrough) + globe placement; delegates the Earth stack to `photorealEarth.ts` |
| `src/services/photorealEarth.ts` | Reusable photoreal Earth factory — diffuse / night lights / specular / atmosphere / clouds / sun / ground shadow with day/night shading; shared by VR view and Orbit character page. Also the **texture provider** for the multi-monitor output (rung 12c), which has no mesh to hang a material on: `nightLightsTexture` / `onNightLightsChange` mirrors the `baseDiffuseTexture` / `onBaseDiffuseChange` pair, so a consumer compositing for itself tracks every tier this stack loads instead of running a second loader against the same CDN. **Clouds deliberately have no such pair.** This module's cloud loader bakes luminance to alpha on a canvas at a gamma below 1, which *lifts* thin cover — right for a lit shell seen from outside, wrong for anything compositing on a flat unwrap, and consuming it there greyed out a whole day side. A consumer that needs clouds takes the raw asset from `getCloudTextureUrl()` and brings its own curve. Two more properties are frame-specific and must not be borrowed across: `sunDir` and `globe`'s orientation use `sunDirectionFromLatLng`, which negates Z relative to `equirectRtt`'s `latLonToDirection` |
| `src/services/vrInteraction.ts` | Controller input — surface-pinned drag, two-hand pinch+rotate, thumbstick zoom, flick-to-spin inertia, raycast hit routing |
| `src/services/vrHud.ts` | In-VR floating HUD — dataset title + play/pause + exit-VR as a CanvasTexture panel with UV hit regions |
| `src/services/vrPlacement.ts` | AR spatial placement — reticle + Place button; WebXR hit-test to anchor the globe on a real surface |
| `src/services/vrLoading.ts` | 3D loading scene — orbiting rings, progress bar, status text; fades out when dataset is ready |
| `src/utils/vrCapability.ts` | Feature detection — `navigator.xr`, `immersive-vr`, `immersive-ar` support — plus `getInputArchetype()` (controller / screen / transient) and `classifyXrDevice(ua, mode)` (UA-based bucket for `vr_session_started.device_class`) |
| `src/utils/vrPersistence.ts` | WebXR anchor persistent-handle save/load (localStorage) for cross-session placement stability |
| `src/utils/viewPreferences.ts` | Persists Dataset info + Legend toggle state to localStorage |
| `src/analytics/index.ts` | Telemetry public surface — call sites import `emit()` / `flush()` only from this barrel |
| `src/analytics/emitter.ts` | Telemetry queue + tier gate + batched dispatch + pagehide beacon flush |
| `src/analytics/transport.ts` | `fetch()` + `sendBeacon()` transport with response classification (ok/retry/permanent) |
| `src/analytics/config.ts` | `TelemetryTier` persistence (`sos-telemetry-config`); compile-time `TELEMETRY_BUILD_ENABLED` / `TELEMETRY_CONSOLE_MODE` flags |
| `src/analytics/session.ts` | `session_start` / `session_end` — platform / OS / viewport / aspect / screen / build channel detection |
| `src/analytics/dwell.ts` | Multi-handle dwell tracker — visibility-paused, pagehide-flushed; called by chat / browse / info / tools UI |
| `src/analytics/camera.ts` | Shared `emitCameraSettled` with per-minute throttle; called by 2D map renderer + VR/AR session |
| `src/analytics/perfSampler.ts` | 60s rAF FPS sampler — `perf_sample` event with WebGL renderer hash, p50/p95 frame time, JS heap |
| `src/analytics/errorCapture.ts` | `window.onerror` + `unhandledrejection` + Tauri `native_panic` listener; sanitizes messages and (Tier B) stacks |
| `src/analytics/hash.ts` | 12-hex SHA-256 helper for free-text fields (search queries, error stack signatures) |
| `src/ui/privacyUI.ts` | Tools → Privacy panel — tier picker (off / essential / research), session-id display, what-we-collect explainer |
| `src/ui/disclosureBanner.ts` | First-launch privacy disclosure banner — shown once per install, dismisses to default Essential tier |
| `src/orbitMain.ts` | Entry point for the Orbit standalone character page (`/orbit`) |
| `src/config/endpoints.ts` | Externally-hosted endpoint configuration (catalog / proxy / NOAA / NASA base URLs) |
| `src/types/image-sequence-constants.ts` | Constants shared by the publisher API (`functions/`), the GHA runner (`cli/`), and the portal (`src/`) for the image-sequence upload pipeline |
| `src/types/zyra-workflow-constants.ts` | Constants shared by the publisher API (`functions/`), the GHA runner (`cli/`), and the portal (`src/`) for the Zyra workflow pipeline — stage/command allowlist, template fields, run statuses (`docs/ZYRA_INTEGRATION_PLAN.md`) |
| `src/types/zyra-pipeline-args.ts` | Pipeline-arg placeholder contract shared by the validator (`functions/`) and the runner (`cli/`) — `{{run_date}}` / `{{run_id}}` / `{{cycle_date:INTERVAL:LAG}}` / `{{cycle_hour:INTERVAL:LAG}}` parsing, validation, and cycle-floored rendering; unresolved pipeline placeholders hard-fail the run (`docs/ZYRA_INTEGRATION_PLAN.md` §Pipeline arg placeholders) |
| `src/types/color-scale.ts` | Data-encoded video sidecar shared by the publisher API (`functions/`), the SPA renderers, and the portal — `ColorScale` / `RenderEncoding`, fail-closed `parseColorScale`, `buildColorScaleLut` (the 256×1 RGBA LUT the shaders sample), and `lumaToValue` / `isTransparentLuma` for the hover readout (`docs/DATA_ENCODED_VIDEO_PLAN.md`) |
| `src/types/unit-scale.ts` | Readable units for a data-encoded scale — the pure SI-prefix arithmetic behind `toDisplayUnits`, which restates a `ColorScale` so `0` to `2e-7 kg m-3` reads as `0` to `200 µg m-3`. A change of unit, not of measurement: `vmin`/`vmax` and the label move together and `stops` / `transparentRange` / `dataMinLuma` (all luma-space) do not, so every surface deriving values through `lumaToValue` is correct with no change of its own. Applied at one seam, `dataService.dataEncodingFromWire`, and never written back — the catalog keeps the publisher's own numbers, and `sourceUnits` carries them into the CSV. Bases are an allowlist matched whole-token-first, so `mol` is a mole rather than a milli-`ol` and `min` is left alone; a leading factor with an exponent (`m2 s-1`) is refused rather than guessed at |
| `src/types/node-features.ts` | Per-node feature-toggle constants shared by the publisher API (`functions/`) and the portal + public SPA — `FEATURE_KEYS` / `FeatureMap`, all-on defaults, fail-open normalization (missing/unknown keys resolve to enabled) |
| `src/types/publisher-roles.ts` | Publisher role → capability matrix shared by the publisher API (`functions/`) and the portal — `CAPABILITIES` / `ROLES` / `ROLE_CAPABILITIES`, `roleCan` / `capabilitiesForRole`, legacy-string `normalizeRole` (fail-closed to `reviewer`). The single source of truth for authorization (`docs/PUBLISHER_ROLES_PLAN.md`) |
| `src/data/regions.ts` | Common region bounding boxes for name-based region resolution |
| `src/services/orbitCharacter/index.ts` | `OrbitController` — public API for the Orbit character (owns the Three.js scene, rAF loop, state machine) |
| `src/services/orbitCharacter/orbitScene.ts` | Three.js scene + per-frame update for the Orbit character |
| `src/services/orbitCharacter/orbitMaterials.ts` | Materials + shaders for the Orbit character |
| `src/services/orbitCharacter/orbitStates.ts` | Persistent-state vocabulary (STATES table) for the Orbit character |
| `src/services/orbitCharacter/orbitGestures.ts` | Transient gesture overlays that play over the active state, then yield control back |
| `src/services/orbitCharacter/orbitFlight.ts` | Flight system + scale presets for the Orbit character |
| `src/services/orbitCharacter/orbitTrails.ts` | Sub-sphere distance-based sparkle-wake trails |
| `src/services/orbitCharacter/orbitTypes.ts` | Shared types for the Orbit character |
| `src/ui/catalogTabsUI.ts` | Catalog ↔ Sphere segmented control |
| `src/ui/catalogGraphUI.ts` | Catalog Graph view — UI mount + cytoscape.js wiring (consumes `catalogGraph.ts`) |
| `src/ui/catalogMapUI.ts` | Catalog Map view — UI mount + MapLibre wiring (consumes `catalogMap.ts`) |
| `src/ui/catalogTimelineUI.ts` | Catalog Timeline view — UI mount + SVG wiring (consumes `catalogTimeline.ts`) |
| `src/ui/playlistUI.ts` | Playlist manager panel + the "Add to playlist" popover from browse cards / info panel |
| `src/ui/tourUI.ts` | 2D tour control bar + overlay types (VR equivalent is `vrTourOverlay.ts`) |
| `src/ui/helpUI.ts` | Help panel — Guide tab + Feedback form |
| `src/ui/creditsPanel.ts` | Credits panel (Tools → Credits) |
| `src/ui/heroPanelUI.ts` | "Right now" hero panel UI (Phase 7 §9.1 of `docs/WEB_CATALOG_FEATURES_PLAN.md`) |
| `src/ui/downloadDialogUI.ts` | Web-only zip-download panel (§8.2) |
| `src/ui/shaderTunerUI.ts` | Dev-only shader-tuner floating panel (§7.2) |
| `src/ui/orbitDebugPanel.ts` | Debug panel for the Orbit standalone page |
| `src/ui/orbitPerfHud.ts` | Perf HUD for the Orbit standalone page |
| `src/ui/orbitPostMessageBridge.ts` | postMessage bridge between the host SPA and the embedded Orbit page |
| `src/ui/domUtils.ts` | Small DOM helpers shared across UI modules |
| `src/ui/sanitizeHtml.ts` | Allowlist-based HTML sanitizer for untrusted input |
| `src/ui/blog/index.ts` | Public blog surface — lazy-booted on `/blog` + `/blog/:slug` (same chunk gate as the portal): published-post cards, the sanitized-markdown post page, per-dataset `/dataset/:id` deep links, and the approved-event source citation (`docs/CURRENT_EVENTS_PLAN.md` §7) |
| `src/ui/publisher/index.ts` | Publisher portal entry point — lazy-loaded on `/publish/*`; mounts the History-API router + pages |
| `src/ui/publisher/router.ts` | Tiny History-API router for the publisher portal |
| `src/ui/publisher/api.ts` | Shared HTTP client for the publisher portal |
| `src/ui/publisher/features.ts` | Portal-side feature-toggle helpers — module-cached `fetchFeatures()` over the authed no-store `publish/node-settings` read (fresh after every save; fail-open to all-enabled) + the org-name read off the public node-profile payload + the shared "feature turned off" card gated pages render instead of their content |
| `src/ui/publisher/types.ts` | Wire types for portal-bound publisher API responses |
| `src/ui/publisher/analytics-charts.ts` | Hand-rolled SVG chart helpers (bar series with Y-axis, mix bars, stat tiles) + CSV export helpers for the analytics tab — no charting library |
| `src/ui/publisher/components/dataset-form.ts` | Shared dataset create / edit form |
| `src/ui/publisher/components/asset-uploader.ts` | Asset uploader component (Phase 3pd image-sequence pipeline) |
| `src/ui/publisher/components/mp4-frame-rate.ts` | Reads a video's frame rate out of its MP4 container — `moov → trak(vide) → mdia/mdhd` for the timescale and `.../stbl/stts` for the sample deltas — without decoding it. Exists because publishing a data-encoded video *as uploaded* skips the transcode that normally forces 30 fps, which `tourEngine`'s `requestedFps / 30` assumes. Walks top-level boxes by header so a multi-gigabyte `mdat` before the `moov` costs a few tiny reads rather than a full load; pure `frameRateFromMoov` carries the logic, and every failure path returns `null` because the caller's warning is advisory |
| `src/ui/publisher/components/chip-input.ts` | Chip-input control — entries become removable chips as the user types |
| `src/ui/publisher/components/markdown-toolbar.ts` | GitHub-issue-style markdown toolbar over a `<textarea>` |
| `src/ui/publisher/components/sidebar.ts` | Glass-surface left sidebar — grouped section nav (Catalog / Newsroom / Insights / Settings) with a standalone Overview entry, an Events count badge, and a user-identity footer (signed-in user's avatar + name + role + Sign out) |
| `src/ui/publisher/components/error-card.ts` | Shared error-card renderer used by every portal page |
| `src/ui/publisher/components/events/match-badge.ts` | Events-tab **Match Badge** primitive — Topic/Time/Geo facet tags + composite %, threshold-toned (`docs/events-tab-handoff/EVENTS_TAB_IMPLEMENTATION_BRIEF.md` §5) |
| `src/ui/publisher/components/events/events-model.ts` | Events-tab wire types + pure helpers (`AUTO_PAIR_THRESHOLD`, `autoPairTargets`, `compositePercent`, `locatorPoint`, `primaryCategory`, `scenarioFamily`) shared by the queue/detail components. `autoPairTargets` pairs at most one scenario variant per family — `scenarioFamily` strips a trailing `SSP2 (Moderate)` / `RCP8.5` so three projections of one field cannot be approved by a single click, while a titled series (`Tsunami Historical Series: Chile - 1960`) is deliberately never grouped |
| `src/ui/publisher/components/events/dataset-search.ts` | Shared catalog-search helpers for the Events-tab pairing UIs (`loadPublishedDatasets` paginated fetch + `filterDatasetsByTitle`) — used by the new-event drawer's pair pane and the detail pane's "+ Add dataset" control |
| `src/ui/publisher/components/events/event-queue.ts` | Events-tab Direction A **left master list** — one row per event (status dot + title + `source · N datasets to review`), selection-highlighted |
| `src/ui/publisher/components/events/media-suggest.ts` | Events-tab **media suggestions** — image-candidate builders for imageless events: the pure NASA Worldview Snapshots source (keyless, public-domain satellite imagery for the event's bbox + date) and the fetched Wikimedia Commons nearby-photos source (geosearch, kept only when public-domain/CC0 — the stored `image_url` carries no attribution field), and the hazard-gated USGS ShakeMap (fdsnws two-step, earthquake events) + NHC forecast-cone (CurrentStorms via the same-origin proxy, storm-name match) sources + the agency-YouTube VIDEO source (via the key-gated `youtube-search` proxy → curator-picked nocookie embed stored on `video_embed_url`, framed by the generated tour); the detail pane's "Use as event image" writes the pick through the review endpoint's `edits.imageUrl` |
| `src/ui/publisher/components/events/event-detail.ts` | Events-tab Direction A **right detail pane** — two-level approval (heavy event Approve/Reject + light per-dataset ✓/✕ + Approve-all-≥90%), meta strip, Match Badge rows, locator slot |
| `src/ui/publisher/components/events/event-locator-map.ts` | Events-tab detail **locator** — lazy MapLibre mini-map (GIBS Blue Marble raster + accent marker) centred on the event; web-only, disposed on detail swap |
| `src/ui/publisher/components/events/new-event-drawer.ts` | Events-tab Direction D **"+ New event" slide-in drawer** — compose-the-event fields (left) + search/pair published datasets (right); posts the compose body plus hand-picked `datasetIds` to the create endpoint (seeded as proposed links); focus-trapped, Escape/backdrop close |
| `src/ui/publisher/pages/overview.ts` | `/publish` + `/publish/overview` — command-center landing: Needs-you attention cards, At-a-glance 7-day stats, newsroom pipeline, recent activity + latest feedback; composes per-feature reads client-side (no overview endpoint), degrades for non-privileged callers |
| `src/ui/publisher/pages/datasets.ts` | `/publish/datasets` — dataset list visible to the caller |
| `src/ui/publisher/pages/dataset-detail.ts` | `/publish/datasets/:id` — read-only dataset detail |
| `src/ui/publisher/pages/dataset-edit.ts` | `/publish/datasets/:id/edit` — edit an existing draft |
| `src/ui/publisher/pages/dataset-new.ts` | `/publish/datasets/new` — wrapper around the shared dataset form |
| `src/ui/publisher/pages/import.ts` | `/publish/import` — bulk manifest import: method chooser (manifest / remote node / CLI), drag-drop CSV/JSON upload with real client-side parsing + per-row validation preview (ready/warning/error), default-visibility + attach-workflow controls. Submit is disabled pending the server-side bulk-import endpoint; parsing/validation helpers are pure and unit-tested |
| `src/ui/publisher/pages/tours.ts` | `/publish/tours` — tour-creator landing page |
| `src/ui/publisher/workflows-api.ts` | Typed API wrappers for the Zyra workflow surface (Phase Z2 of `docs/ZYRA_INTEGRATION_PLAN.md`) |
| `src/ui/publisher/workflow-templates.ts` | Curated workflow templates + insert-stage snippets for guided authoring (Phase Z3) |
| `src/ui/publisher/feed-presets.ts` | Curated feed-preset catalog for the feeds console — reputable suggested feeds grouped by category (hazards / science news / general news), one-click addable (`docs/CURRENT_EVENTS_PLAN.md` §9) |
| `src/ui/publisher/pages/workflows.ts` | `/publish/workflows` — Zyra workflow list |
| `src/ui/publisher/pages/workflow-detail.ts` | `/publish/workflows/:id` — workflow summary + run history + Run now |
| `src/ui/publisher/pages/workflow-edit.ts` | `/publish/workflows/new` + `…/:id/edit` — workflow form (YAML→JSON client-side, server-side Validate) |
| `src/ui/publisher/pages/featured-hero.ts` | `/publish/featured-hero` — set the "Right now" hero override (`hero.manage`: editors / admins); callers without it get a read-only view of the current pin (`docs/HERO_ADMIN_SCOPING.md`) |
| `src/ui/publisher/pages/node-profile.ts` | `/publish/node-profile` — edit the node / host-organization profile (org name, mission, about, region focus, tone, links) — the "about the host" context Phase 3d AI drafts ground themselves in |
| `src/ui/publisher/pages/blog.ts` | `/publish/blog` — blog authoring list (drafts + published, status badges, New post) |
| `src/ui/publisher/pages/blog-edit.ts` | `/publish/blog/new` + `…/:id/edit` — tabbed blog editor (Content / Sources / Media / AI draft): dataset/event grounding pickers, the **Media** tab (reuses the Events-tab `media-suggest` engine — Worldview / Commons / ShakeMap / NHC / agency YouTube + the cited event's story image — to insert imagery into the body or set the post's cover image), the AI Generate panel (tone/length/companion-tour → `POST /publish/blog/generate`), markdown body with the shared toolbar + sanitized Preview, Save/Publish/Unpublish |
| `src/ui/publisher/pages/feeds.ts` | `/publish/feeds` — the current-events feed console: registered connectors (pause/resume/remove, Run now, last-run status), the curated preset gallery, and the bring-your-own RSS/Atom form (`docs/CURRENT_EVENTS_PLAN.md` §9) |
| `src/ui/publisher/pages/events.ts` | `/publish/events` — current-events review queue: curator approve/reject of proposed events + their dataset links (`docs/CURRENT_EVENTS_PLAN.md` §5) |
| `src/ui/publisher/pages/analytics.ts` | `/publish/analytics` — read-only analytics dashboard over the D1 rollups (open to any active publisher), incl. the MapLibre spatial-attention heatmap (Phase B of `docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md`) |
| `src/ui/publisher/pages/feedback.ts` | `/publish/feedback` — read-only feedback review (AI thumbs + bug/feature reports; open to any active publisher) over the D1 feedback tables; replaces the feedback-admin HTML dashboard (Phase C of `docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md`) |
| `src/ui/publisher/pages/me.ts` | `/publish/me` — current-user identity + role display |
| `src/ui/publisher/pages/users.ts` | `/publish/users` — admin-only Users tab: approve / reject / suspend / reactivate publishers and change roles (admin / publisher / readonly) |
| `src/ui/tourAuthoring/index.ts` | Tour-authoring public surface — detects `?tourEdit=` and mounts the dock |
| `src/ui/tourAuthoring/dock.ts` | Floating tour-authoring dock — attaches to SPA chrome on `/?tourEdit=<id>` (or `=new`) |
| `src/ui/tourAuthoring/state.ts` | In-memory tour-authoring state — dock reads/writes here; `autosave.ts` flushes it |
| `src/ui/tourAuthoring/autosave.ts` | Debounced autosave for the tour-authoring dock |
| `src/ui/tourAuthoring/mediaCapture.ts` | Pure capture helpers for the dock's Media group — positionless `showImage`/`showVideo` builders (→ the player's responsive media rail), `media{N}` ID minting, and the hide-latest pairing walk |
| `src/ui/tourAuthoring/api.ts` | Publisher-side API client for the tour-authoring dock |
| `src/utils/logger.ts` | Log-level gating so production builds stay silent |
| `src/utils/debounce.ts` | Debounced-function wrapper |
| `src/utils/time.ts` | Time parsing / formatting utilities |
| `src/utils/frames.ts` | Frame-query resolution shared by Orbit (marker parsing) + the dataset loader |
| `src/utils/deviceCapability.ts` | Device-capability detection for adaptive performance tuning |
| `src/utils/fetchProgress.ts` | Fetch a URL as a Blob with byte-level progress reporting |
| `src/utils/captionProxy.ts` | Caption-URL proxying helper |
| `src/utils/catalogFilters.ts` | URL round-trip for catalog filter state |
| `src/utils/catalogMode.ts` | Catalog mode — `?catalog=true` URL routing |
| `src/utils/embedMode.ts` | Embed mode — `?embed=1` minimal-chrome URL routing for iframe hosting (`docs/EMBED_URL_GRAMMAR.md`) |
| `src/utils/posterDeepLinks.ts` | Poster deep-link handlers |
| `src/utils/datasetUrl.ts` | Dataset URL grammar — the canonical `/dataset/<slug>` path form, the slug/ULID/legacy-id reference resolution `dataService.getDatasetById` delegates to, and the builders that swap a dataset in or out of the address bar while preserving `?catalog=`/`?embed=`/`?layout=` |
| `functions/api/ingest.ts` | Cloudflare Pages Function — receives telemetry batches, stamps `event_type` / `environment` / `country` / `internal` server-side, writes to Workers Analytics Engine |

> **Note:** the table above is the **SPA** module map. It is
> linted for completeness by `npm run check:doc-coverage` (see
> _Module-map coverage_ below): every module under `src/` and
> `src-tauri/src/` must appear here. When you add a module, add its
> row in the same PR.

### Backend subsystems (`functions/` + `cli/`)

The Cloudflare Pages Functions backend and the publisher CLI have
their own per-module map in
[`docs/BACKEND_MODULES.md`](docs/BACKEND_MODULES.md) (one row per
file, enforced by `check:doc-coverage`) and their design rationale
in the `docs/CATALOG_*` plan docs. The major clusters, for
orientation:

| Subsystem | Where | What |
|---|---|---|
| Semantic search & embeddings | `functions/api/v1/_lib/{embeddings,vectorize-store,embed-dataset-job,search-datasets}.ts` | Vector embeddings + Vectorize-backed semantic dataset search. Authoritative plan: `docs/CATALOG_BACKEND_PLAN.md`. |
| Publisher | `cli/`, `src/ui/publisher/`, `functions/api/v1/` (`dataset-mutations`, `tour-mutations`, `publisher-store`) | Authoring/publishing datasets & tours into the node catalog. See `docs/CATALOG_PUBLISHING_TOOLS.md`. |
| R2 asset/tour migration | `cli/` + `functions/api/v1/_lib/` (`migrate-r2-*`, `rollback-r2-*`) | One-off migrations of assets/tours into R2. See `docs/CATALOG_ASSETS_PIPELINE.md`. |

### Module-map coverage

`npm run check:doc-coverage` (in the `type-check` chain) fails CI
if any module under `src/` (SPA map) or `src-tauri/src/` (Rust map)
is missing from CLAUDE.md. When you add a module, add its row in
the same PR. For one that genuinely warrants no row (throwaway
shim, obvious from a documented sibling), add `// doc-exempt:
<reason>` to its source — the reason is mandatory, same convention
as `i18n-exempt:`.

**Scope** (an explicit manifest in `scripts/check-doc-coverage.ts`):

- **Covered:** all of `src/` and `src-tauri/src/` against this file,
  recursively; all of `functions/` and `cli/` against
  [`docs/BACKEND_MODULES.md`](docs/BACKEND_MODULES.md) (the backend
  map — helper-dense and route-shaped, kept out of CLAUDE.md and
  next to the `docs/CATALOG_*` plan docs); `scripts/lib/` against
  [`docs/SCRIPTS_MODULES.md`](docs/SCRIPTS_MODULES.md) (the shared
  library behind the build, provisioning and audit scripts).
- **Uncovered by design:** the one-shot CLI entry points at the top of
  `scripts/` — their filenames are the documentation — and
  `scripts/screenshots/`, which _Visual testing & reporting_ above
  already documents in prose. Every covered root points at a
  documentation home that exists; that is the rule the manifest
  encodes, and it is why a directory with no map is not simply added.
- **Excluded:** generated code (`messages*.ts` i18n codegen),
  `*.d.ts`, `*.test.ts`, and `test-setup.ts`.
- Matching is on the **full repo-relative path**, because the
  backend's route layout repeats basenames across directories
  (multiple `[id].ts`, `manifest.ts`, `publish.ts`).

### Licence headers

Every source file opens with a two-line SPDX header, below any line
that must come first:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project
```

`npm run check:license` (in the `type-check` chain) fails CI on a file
without one. **Never hand-write these across a batch of files** —
`npm run check:license -- --fix` writes the header in the right comment
syntax for each kind (`//`, `/* */`, `#`, `<!-- -->`, `--`) and places
it below a shebang, a doctype, an XML declaration, a PEP 263 coding
line, or Package.swift's `// swift-tools-version:`. Re-running is safe:
it repairs a wrong header in place rather than stacking a second one.

Three properties are load-bearing and easy to break by "simplifying"
the tool:

- **Position, not search.** The two lines are matched at the exact index
  a prologue leaves free. A check that merely scans the top of a file
  for the strings passes any file that *talks* about them — which is
  exactly `scripts/check-license-headers.ts` and its test, the two files
  a lost header would be least visible in.
- **The year moves, the holder does not.** `2026-2027` passes; a
  different holder fails. Loosening the holder makes the check useless
  for the only drift worth catching.
- **Untracked files are scanned.** `git ls-files` alone would let a file
  you have written but not `git add`ed pass locally and fail in CI.

Coverage is every text source kind with a comment syntax. `.json` (no
comments), `.md` (prose) and `.yml`/`.toml` (configuration — their
`license` field is checked instead) are out by decision; the reasoning
is in the tool's header comment, which is the place to read before
widening or narrowing the set.

The `COPYRIGHT` constant in `scripts/check-license-headers.ts` is the
single source of truth. The same check verifies `LICENSE`, `NOTICE`,
`package.json`, `CITATION.cff` and both Cargo manifests still name it,
so changing the holder is one edit plus a `--fix` rather than a sweep
nothing verifies. Three generated-and-committed files
(`public/privacy.html`, `public/setup.html`,
`schema/catalog-schema.sql`) import `headerFor()` so their generators
emit the same constant — a literal copy in a generator would re-emit
the stale header on every run.

Copyright holder and citation credit are separate fields: `CITATION.cff`
credits the author, `NOTICE` and the headers record the holder. Don't
collapse them.

### Architecture graph (`/graphify`)

A vendored [graphify](https://github.com/safishamsi/graphify) skill
lives at `.claude/skills/graphify/` (see its `VENDORED.md`). It
turns the repo into a queryable knowledge graph — community
detection, "god nodes" (most-connected abstractions), and
`query` / `path` / `explain` over the structure. It's how the
module-map drift above was found, and it spans SPA + `functions/`
+ `cli/` + Rust in one graph (surfacing cross-tier coupling the
per-section docs don't).

**Two passes, very different cost:**

- **Structural** (tree-sitter AST + Leiden clustering) — free,
  deterministic, seconds. `graphify update <path> --no-cluster`.
  This is what backs the doc-coverage check and catches drift.
- **Semantic** (LLM concept/relationship extraction over docs +
  code) — **~1M tokens** on this repo, counted against your Claude
  Code usage. Run it **deliberately** (before a large refactor, or
  periodically), never in CI.

Run it via `/graphify <paths>` in a Claude Code session (e.g.
`/graphify src functions cli src-tauri docs` skips the generated
`locales/` + `tokens/` JSON). Outputs land in `graphify-out/`
(gitignored). The CLI is pre-installed by the SessionStart hook;
no API key is used — the semantic pass runs on the host session.

---

## Waiting in tests

**Wait for a signal, never for a number of event-loop turns.** Use
`until()` from [`src/test-utils.ts`](src/test-utils.ts):

```ts
await until(() => fetchFn.mock.calls.length >= 2, 'the /asset mint')
```

`npm run check:tick-drain` (in the `type-check` chain) fails on the
banned shape — a loop whose body awaits a timer:

```ts
for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0))
```

The count is a guess about how long an async chain takes. It holds on
an idle machine and fails on a loaded CI runner, against whichever
unrelated PR is open that day — which teaches people to re-run rather
than read. Raising it moves the threshold instead of removing it.

Two things to get right when converting one:

- **Anchor on a signal weaker than the assertion.** Waiting for
  exactly what you are about to assert makes the assertion vacuous and
  turns a useful diff into a timeout. Wait for the chain to *finish*
  (a callback fired, an element present), then assert the specifics.
- **A negative assertion needs a positive anchor.** `expect(x).not
  .toHaveBeenCalled()` after a wait only means something if the wait
  proves the chain reached its end state.

A single un-looped `await new Promise(r => setTimeout(r, 0))` is
allowed and not flagged — yielding one turn to let resolved microtasks
settle is bounded, unlike guessing a count. For a test that genuinely
must bound elapsed time, `// tick-drain-exempt: <reason>` on the same
line, reason mandatory — same convention as `i18n-exempt:`.

---

## Visual testing & reporting

A Playwright-driven tool captures the real UI to catch visual and
interaction regressions. It started as the Weblate translator-screenshot
pipeline and now shares one capture core
(`scripts/screenshots/core/`) across several consumers. Authoritative
design: [`docs/VISUAL_REPORT_PLAN.md`](docs/VISUAL_REPORT_PLAN.md).

| Command | What it does |
|---|---|
| `npm run screenshots:report` | Captures every scene × viewport (desktop + mobile) into a self-contained `report-out/index.html` gallery with per-scene problem badges (console/page errors, failed requests, optional `VISUAL_AXE` a11y). The local visual-debug surface. Add `-- --scene <name>[,<name>]` (or `VISUAL_ONLY=`) to capture just one surface while iterating on it — reuses the scene's maintained navigation/fixtures/masks instead of an ad-hoc script. |
| `npm run screenshots:diff -- --baseline <dir>` | Pixel-diffs the current `report-out/` against a baseline PNG dir (masked regions excluded); advisory. |
| `npm run screenshots:smoke` | Gating interaction tests — search, Orbit's local engine, navigation, a fixture-backed publisher page. |
| `npm run screenshots:capture` | The Weblate translator-screenshot capture (separate output + uploader). |

All capture commands run against a dev server on `:4173`
(`npm run dev -- --port 4173`). CI is
[`.github/workflows/visual-report.yml`](.github/workflows/visual-report.yml):
PRs get an advisory `visual-report` artifact + comment (diffed against
the latest `main` baseline) and a gating smoke job; `main` publishes the
baseline and deploys the report. The Weblate sync
(`sync-weblate-screenshots.yml`) is deliberately separate.

- **Scenes** are the one human-maintained list:
  [`scripts/screenshots/scenes.ts`](scripts/screenshots/scenes.ts)
  (`{ name, description, setup(page), masks?, fixtures? }`). `masks`
  excludes non-deterministic regions (globe / MapLibre / graph) from the
  diff; `fixtures` route-stubs `/api/**` so data-backed pages render
  populated (see
  [`scripts/screenshots/fixtures/`](scripts/screenshots/fixtures/),
  typed against `src/ui/publisher/types.ts`).
- **Convention (mirrors the module-map coverage rule):** when you add a
  UI route or surface under `src/ui/`, add a `Scene` for it in the same
  PR — and a smoke assertion if it is interactive. Report strings are
  dev/CI output and are intentionally **not** routed through i18n.

---

## Orbit — Digital Docent

Orbit is the AI chat assistant. Understanding its architecture is essential for working on the chat feature.

### Hybrid architecture

`docentService.processMessage()` runs two paths concurrently:

1. **Local engine** (`docentEngine.ts`) — instant keyword/intent matching, no network required, always available
2. **LLM stream** (`llmProvider.ts` → `docentContext.ts`) — streams from any OpenAI-compatible endpoint

If the LLM errors or is disabled, the local engine result is used as the response. When the LLM succeeds it is the sole source of dataset recommendations.

### Dataset loading from chat

The LLM is prompted to embed `<<LOAD:DATASET_ID>>` markers inline with its text. `docentService.extractActionsFromText()` parses these (plus bare `INTERNAL_...` IDs as a fallback for LLMs that ignore the marker instructions) into `action` stream chunks. `chatUI.ts` renders each action as an inline load button inside the message bubble — the `<<LOAD:...>>` syntax is never shown to the user.

The `load_dataset` function-calling tool is also supported for providers that prefer tool calls over inline markers.

### System prompt

`docentContext.buildSystemPromptForTurn()` is turn-aware:
- **Turn 0**: full catalog (ID | Title [Categories]) — more tokens, best for opening recommendations
- **Turn ≥1**: compact catalog (ID | Title only) to reduce per-turn cost

History is compressed: the last 3 exchanges are sent verbatim; older messages are summarised.

### LLM configuration

Stored in `localStorage` under `sos-docent-config`. Defaults:
- `apiUrl`: `/api` (Cloudflare proxy in production; override to a direct URL for local dev)
- `model`: `llama-3.1-70b` (populated from `/models` endpoint dropdown)
- `apiKey`: empty
- `enabled`: true

> On localhost the Cloudflare `/api` proxy is unavailable. The docent falls back to local engine automatically if the LLM is unreachable.

> **Desktop (Tauri)**: API keys are stored in the OS keychain via `keychain.rs`, not localStorage. `saveConfig()` accepts a `persistApiKey` flag — pass `true` only from the settings form save handler to avoid erasing the keychain on unrelated config changes. The Tauri HTTP plugin (`@tauri-apps/plugin-http`) is used for all LLM requests to bypass webview CORS restrictions when connecting to local servers (Ollama, LM Studio, etc.).

### Stream chunk types

`DocentStreamChunk` union (from `docentService.ts`):
- `delta` — text fragment to append to the current message
- `action` — load a dataset (renders as an inline button)
- `auto-load` — auto-loaded dataset with alternatives
- `done` — stream complete; `fallback: true` if local engine was used

---

## VR / AR — Immersive mode

The app ships an optional WebXR immersive mode for Meta Quest (and
any other WebXR-capable headset). Entirely feature-gated — browsers
without `navigator.xr` never load the Three.js chunk and see no UI
change. Design doc: [`docs/VR_INVESTIGATION_PLAN.md`](docs/VR_INVESTIGATION_PLAN.md).

### Key architectural points

- **Two renderers, one DOM.** The 2D app's MapLibre canvas is untouched
  by VR. When the user taps Enter AR / Enter VR, `vrSession.ts` creates
  a parallel Three.js `WebGLRenderer` attached to its own canvas,
  calls `renderer.xr.setSession(session)`, and drives a separate XR
  render loop. MapLibre keeps running behind the scenes and takes
  over again on session-end.

- **Lazy-loaded Three.js.** `import('three')` only fires on the
  first Enter AR/VR tap — same lazy-import pattern used for Tauri
  plugins in `llmProvider.ts` / `downloadService.ts`. Three.js
  chunks separately at ~183 KB gzipped; the main bundle is unchanged
  for non-VR users. `XRControllerModelFactory` chunks alongside at
  ~16 KB gzipped.

- **AR-first button.** `vrButton.ts` prefers `immersive-ar` when the
  device supports it (Quest 2/3/Pro all do), falls back to
  `immersive-vr` on PCVR, hides entirely on non-XR browsers.

- **Dataset texture reuse.** Video datasets reuse the existing HLS
  `<video>` element directly via `THREE.VideoTexture`. Image datasets
  reuse the already-decoded `HTMLImageElement` stored in
  `panelStates[slot].image` (set by `loadImageDataset`). Zero
  re-fetches.

- **Earth-as-planet vs. data-as-surface modes.** When no dataset is
  loaded, `photorealEarth.ts` (wired up by `vrScene.ts`) renders the
  full photoreal Earth stack (diffuse + night lights + specular +
  atmosphere + clouds + sun + ground shadow + day/night shader gated
  by real UTC sun position). When a dataset is loaded, all
  Earth-specific decoration is hidden so the data reads uniformly
  across the sphere.

- **Spatial placement (AR only).** `vrPlacement.ts` uses WebXR
  `hit-test` to let the user point at a real-world surface and tap
  to anchor the globe there. `vrPersistence.ts` stores the anchor's
  persistent-handle UUID in localStorage so the globe stays in the
  same physical spot across sessions (Quest's Meta Anchors extension).

### Session-start ordering is subtle

`vrSession.enterImmersive()` has a specific async ordering that
matters for correctness:

1. `loadThree()` — Three.js chunk
2. **`import XRControllerModelFactory`** — must finish before
   `setTexture` fires its synchronous `onReady`, otherwise the
   loading-scene fade-out race loses (see commit 90279c5)
3. Build renderer + camera, request session, `setSession`
4. AR: set up hit-test source + restore persistent anchor
5. Build `scene`, `hud`, `loading`; hide globe + HUD; show loading
6. `setTexture` → fires `onReady` → schedules 250 ms → fade-out
7. Build `interaction`, assign `active`, start animation loop

### Per-frame ordering in the render loop

1. Hit-test (placement, AR only)
2. Anchor-pose sync (AR only — writes into `globe.position`)
3. Dataset texture swap (idempotent no-op in steady state)
4. HUD state update (debounced)
5. Interaction update (rotation, zoom, inertia)
6. Scene update (shadow, atmosphere, sun — tracked to `globe.position`)
7. HUD + Place button position sync (follows globe)
8. Loading-scene animation (rings spin, fade)
9. `renderer.render(scene, camera)`

---

## UI Layout & Panel Coordination

The UI is floating glass-surface overlays on a full-viewport WebGL canvas. See [STYLE_GUIDE.md](STYLE_GUIDE.md) for visual design rules.

### Panel mutual exclusion

- Expanding the **info panel** (dataset metadata) closes the chat panel via `closeChat()` in `datasetLoader.ts`
- Opening the **chat panel** collapses the info panel via DOM manipulation in `chatUI.openChat()`

### ResizeObserver-driven positioning

Two elements track the info panel height as it animates open:

- **Chat trigger** (`#chat-trigger`) — managed in `chatUI.updateTriggerForInfoPanel()`, wired in `wireEvents()`
- **Playback controls** (`#playback-controls`) — managed in `playbackController.initPlaybackPositioning()`, called from `main.ts`. Portrait mobile only (≤600px + portrait orientation). Resets to `'0.75rem'` (not `''`) because the element uses an inline style with no CSS fallback.

### Responsive breakpoints

| Breakpoint | Behaviour |
|---|---|
| `> 768px` | Desktop |
| `≤ 768px` | Mobile — panels slide from edges |
| `≤ 600px` + portrait | Portrait phone — browse card titles on own line; playback controls lift above info panel |

---

## Localization

The app ships in multiple languages. **Every new user-facing
string must go through the i18n layer; never hard-code English
in source.** A static check (`npm run check:i18n-strings`) runs
in the type-check chain and fails CI if it finds a hard-coded
label in `src/ui/` or `src/services/docent*.ts`.

### i18n runtime modules

The `src/i18n/` layer (these are the runtime modules; the
`src/i18n/messages*.ts` files are generated codegen output and are
not individually documented):

| File | Responsibility |
|---|---|
| `src/i18n/index.ts` | Public runtime API — `t()`, `plural()`, `interpolate()`, locale switching, `<html dir>` wiring |
| `src/i18n/bootstrap.ts` | Shared i18n bootstrap for entry points (`main.ts`, `orbitMain.ts`, future entries) |
| `src/i18n/detect.ts` | Initial-locale detection (query param → storage → `navigator.languages`) |
| `src/i18n/persistence.ts` | Locale-preference persistence — mirrors `src/utils/viewPreferences.ts` |
| `src/i18n/format.ts` | Locale-aware formatting helpers (numbers, dates, lists) |
| `src/i18n/applyI18nAttributes.ts` | DOM walker that translates static markup carrying `data-i18n` attributes |
| `src/i18n/rtl.ts` | RTL locale set + `<html dir>` resolution |
| `src/i18n/screenshotTrace.ts` | Build-flag-gated (`VITE_I18N_TRACE`) recorder — `t()` mirrors every resolved key onto `window.__i18nTrace` for the Weblate screenshot-capture pipeline (`docs/WEBLATE_SCREENSHOT_SYNC_PLAN.md`); tree-shakes out of normal builds |

### When you add a new UI string

1. Add the key to `locales/en.json` (sorted; the codegen will
   canonicalize on the next `npm run locales`).
2. Reference it via `t('your.key.here')` from
   [`src/i18n/index.ts`](src/i18n/index.ts).
3. Run `npm run locales` (or `npm run check:locales`) — the
   codegen builds a TypeScript `MessageKey` union from
   `en.json`, so any unresolved key fails type-check.
4. If the key is ambiguous out of context (placeholders to
   preserve, ARIA semantics, special markers like
   `<<LOAD:DATASET_ID>>`), add a one-line entry to
   [`locales/_explanations.json`](locales/_explanations.json).
   It auto-syncs to Weblate's per-string Explanation field via
   the `sync-weblate.yml` workflow.

For a string that genuinely shouldn't be translated (debug
HUD, technical identifier, machine-only output), add
`// i18n-exempt: <reason>` to the same line. The reason is
mandatory — it's how a future reader knows the omission was
deliberate.

### When you add CSS

Use **logical inline-axis properties** so the layout flips
correctly when an RTL locale is active (`<html dir>` is set
automatically by [`src/i18n/index.ts`](src/i18n/index.ts) via
[`src/i18n/rtl.ts`](src/i18n/rtl.ts)):

| Use this | Not this |
|---|---|
| `padding-inline-start` / `padding-inline-end` | `padding-left` / `padding-right` |
| `margin-inline-start` / `margin-inline-end` | `margin-left` / `margin-right` |
| `border-inline-start` / `border-inline-end` | `border-left` / `border-right` |
| `inset-inline-start` / `inset-inline-end` | `left` / `right` |
| `text-align: start` / `text-align: end` | `text-align: left` / `text-align: right` |

Two patterns are intentionally physical: classic centering
(`top: 50%; left: 50%; transform: translate(-50%, -50%)` —
`inset-inline-start: 50%` doesn't center in RTL) and
direction-sensitive `transform: translateX(±100%)` slides (pair
with a `:root[dir="rtl"]` override that flips the sign — see
[`src/styles/browse.css`](src/styles/browse.css)
`#browse-overlay.collapsed`). Full guide:
[`docs/CSS_ARCHITECTURE_PLAN.md`](docs/CSS_ARCHITECTURE_PLAN.md)
§RTL safety.

`npm run check:css-logical` enforces this in the `type-check`
chain, over `src/**/*.css`. Classic centering is exempt
automatically (a `left`/`right` of exactly `50%`) and transforms
are never inspected, so both intentional patterns above pass
untouched. Anything else that genuinely must stay physical takes
an inline `/* rtl-exempt: <reason> */` on the same line — reason
mandatory, same convention as `i18n-exempt:` and `doc-exempt:`.
`poster/` is out of scope: it is a separate single-language
static site with its own deploy workflow, deliberately isolated
from SPA CI.

### Commands

| Command | What it does |
|---|---|
| `npm run locales` | Regenerates the TS message modules + canonicalizes the locale JSON. Idempotent. |
| `npm run check:locales` | Drift-check (CI). Fails if generated TS or canonicalized JSON differs from a fresh render. |
| `npm run check:i18n-strings` | Scans `src/ui/` + `src/services/docent*.ts` for hard-coded user-visible strings. Runs in the `type-check` chain. |
| `npm run sync:weblate` | Pushes `locales/_explanations.json` to Weblate's per-string Explanation field. Token via `WEBLATE_TOKEN` env var. Auto-runs in CI on push to main. |

### Don't hand-edit non-source locales

Translator changes flow in via Weblate PRs. The codegen
canonicalizes every `locales/*.json` on every run so Weblate's
PRs against `main` never produce whitespace-only diffs.
Hand-editing `locales/es.json` (or `kab.json`, `ar.json`, etc.)
is fine for one-off fixes but the canonical surface is Weblate.

### Doc references

- [`docs/I18N_PLAN.md`](docs/I18N_PLAN.md) — full plan, phase
  table (L1 / L1.5 shipped; L2-L4 blocked on catalog backend),
  runtime API.
- [`CONTRIBUTING-TRANSLATIONS.md`](CONTRIBUTING-TRANSLATIONS.md)
  — translator workflow, glossary conventions, DCO setup.
- [`docs/CSS_ARCHITECTURE_PLAN.md`](docs/CSS_ARCHITECTURE_PLAN.md)
  — §RTL safety section with the use-this-not-that table and
  centering exceptions.

---

## Tours

The tour engine (`src/services/tourEngine.ts`) plays back SOS-format tour JSON files. Each tour is a sequence of tasks executed in order. The following tour tasks are relevant to the multi-globe feature:

| Task | Behaviour |
|---|---|
| `setEnvView` | `callbacks.setEnvView()` — switches layout (1globe/2globes/4globes) |
| `unloadDataset` | `callbacks.unloadDatasetAt()` — unloads a specific dataset by tour handle |
| `worldIndex` on `loadDataset` | Routes dataset load to a specific panel slot (1-indexed) |
| `setTime` | `callbacks.setTime()` — seeks the loaded (video) dataset to an ISO time (`seekToDate`); best-effort no-op when unseekable / out of range. Added for the auto-generated current-events tours (`docs/CURRENT_EVENTS_PLAN.md` §7) |

---

## Analytics

Privacy-first product telemetry. Two-tier consent model with the
client emitter in `src/analytics/`, server stamping at
`functions/api/ingest.ts`, storage in Cloudflare Workers Analytics
Engine, Grafana dashboards under `grafana/dashboards/`.

**Authoritative reference: [`docs/ANALYTICS.md`](docs/ANALYTICS.md).**
The query/schema reference is [`docs/ANALYTICS_QUERIES.md`](docs/ANALYTICS_QUERIES.md);
the user-facing privacy policy is [`docs/PRIVACY.md`](docs/PRIVACY.md)
(generated to `public/privacy.html` by `scripts/build-privacy-page.ts` —
`npm run build:privacy-page` rebuilds it; `npm run check:privacy-page`
guards the diff in CI).

### Two tiers

| Tier | Default | Examples |
|---|---|---|
| `essential` (Tier A) | on | `session_*`, `layer_*`, `camera_settled`, `map_click`, `playback_action`, `tour_*`, `vr_session_*`, `perf_sample`, `error`, `feedback` |
| `research` (Tier B) | opt-in | `dwell`, `orbit_*`, `browse_search` (hashed), `vr_interaction` (per gesture, throttled), `error_detail` (sanitized stacks), `tour_question_answered` |

User-controlled in **Tools → Privacy** (`src/ui/privacyUI.ts`).
First-launch banner in `src/ui/disclosureBanner.ts`. The
`TIER_B_EVENT_TYPES` tuple in `src/types/index.ts` is the runtime
gate; adding an event there is the single point that promotes it to
Research-only.

### Adding a new event

The full walkthrough + reviewer checklist lives in
[`docs/ANALYTICS_CONTRIBUTING.md`](docs/ANALYTICS_CONTRIBUTING.md).
Headlines:

1. Add an interface to `src/types/index.ts`, append to
   `TelemetryEvent` union, decide tier (`TIER_B_EVENT_TYPES`).
2. `import { emit } from '../analytics'` and call from the call site.
3. Throttle if it can fire more than ~30/min — pattern lives in
   `src/analytics/camera.ts` and `src/services/vrInteraction.ts`.
4. Hash any free-text via `src/analytics/hash.ts` (12-hex SHA-256).
5. Add a row to the catalog in `ANALYTICS.md`, a positional layout
   in `ANALYTICS_QUERIES.md`, a panel in `grafana/dashboards/`, and
   a test (`*.test.ts` next to the call site).

### Reviewing analytics changes

When reviewing a PR (your own or someone else's) that touches
`src/analytics/**`, `functions/api/ingest.ts`, the `TelemetryEvent`
union in `src/types/index.ts`, or any `emit({ event_type: ... })`
call site, run through the **Reviewer checklist** section of
[`docs/ANALYTICS_CONTRIBUTING.md`](docs/ANALYTICS_CONTRIBUTING.md)
explicitly. The checklist covers schema, tier choice, the eight
privacy invariants, throttling, tests, and documentation. Flag
any item you can't positively confirm; block on missing tier-gate
or missing hashing/sanitization of free-text fields.

### Privacy invariants

- No IP storage (only `CF-IPCountry` for country).
- No User-Agent storage (only bucketed OS / viewport / aspect /
  screen enums from `src/analytics/session.ts`).
- Search queries hashed before emit; error messages sanitized
  (`src/analytics/errorCapture.ts:sanitizeMessage()`).
- Lat/lon rounded to 3 decimals (~111 m) by
  `src/analytics/camera.ts` before emit.
- Session id is in-memory only — rotates every launch, never
  persisted.
- Server-side `KILL_TELEMETRY=1` env returns 410 → client cools
  down for the rest of the session.

### Local dev

- `VITE_TELEMETRY_CONSOLE=true` — log batches to console instead
  of POSTing.
- `VITE_TELEMETRY_ENABLED=false` — compile out the emitter
  entirely (call sites tree-shake).

---

## Deployment

### Web
Cloudflare Pages. Orbit's default LLM path is Cloudflare Workers AI: `functions/api/chat/completions.ts` runs the `AI` binding edge-side and streams an OpenAI-shaped SSE response (no external API key in the client bundle), with `functions/api/models.ts` backing the "Test Connection" button. External OpenAI-compatible providers are configured client-side only (Tools → Orbit Settings; localStorage / desktop keychain) — there is no server-side `LLM_PROVIDER_*` proxy.

### Desktop
Tauri v2. Three CI/CD workflows:
- `desktop.yml` — CI build on push/PR (signed on push, compile-only on PRs from forks)
- `release.yml` — tag-triggered or manual dispatch; builds all platforms, signs with Tauri updater key, creates draft GitHub Release with `latest.json` for auto-updates
- Manual release: Actions → "Release Desktop App" → enter version, pick branch

---

## Desktop App (Tauri v2)

The desktop app shares 100% of the TypeScript source. Desktop-only behaviour is gated at runtime via `window.__TAURI__`. The `src-tauri/` directory contains the Rust backend.

> **In progress — multi-monitor / LED-sphere output.** A second Tauri
> webview rendering a projection-correct equirectangular view of the
> live globe state, for Science On a Sphere installations, domes and
> projector arrays. Design doc:
> [`docs/MULTI_MONITOR_PLAN.md`](docs/MULTI_MONITOR_PLAN.md); the
> delivery ladder there is the map of what exists.
>
> **Rungs 1-12 have landed, and so has the link between them** — the
> protocol, the equirect RTT pass, the output bundle and its layer
> stack, both capability files, the manager and state aggregator, the
> publish seam, the boot wiring, the Tools → Outputs panel,
> persistence, rung 11's three controls (render-config channel and
> debug HUD, framebuffer picker, decoder budget), and rung 12's window
> chrome (fullscreen paired with decorations, F11 on every window, the
> idle cursor, and the `--kiosk` launch flag). The ladder never assigned the output's *receive* side —
> rungs 3-4 say "no IPC" and 5-15 never wire it — so until
> `outputLink` / `datasetMirror` / `outputSync` landed, every broadcast
> the manager made went to nobody: no output emitted `output_ready`,
> `readyRecords()` was empty on every real launch, and an operator who
> added an output got a window showing a static Earth. The output now
> announces itself, folds snapshots and diffs, loads the mirrored
> dataset's media, steers its playhead, and **composites it onto the
> sphere** through `layerStack`'s unrolled overlay slots. So the path is
> now end to end in code: an operator loading a dataset on the control
> window should see it on the output, at the right longitude, in the
> right palette, in step. **It has now run on a second monitor once** —
> a Windows pass of rung 9's smoke checklist on 2026-09-11, logged in
> `docs/MULTI_MONITOR_PLAN.md` Appendix B under "Results: first pass".
> Twenty-eight steps passed and five failed; all five are fixed in code
> and **none of the fixes is confirmed on hardware**. That pass is
> **step 46 parity, not the qualification** — Appendix B gates on a
> dual-monitor Linux workstation and that run has not happened, so the
> gate is still open. So the modules above are description,
> not intent, and the feature is reachable: on desktop an operator can
> add an output on a chosen monitor, toggle its camera tracking and
> sphere split, pick its framebuffer resolution, put a debug HUD on it,
> set the machine's decoder budget, remove it, and have the set come
> back next launch — and bring the whole app up fullscreen and
> decorationless, by toggle, by F11, or straight from a `.desktop`
> autostart entry.
>
> Boot still does not call `manager.start()`. Two things do, both only
> once there is an output to talk to: `outputUI` on the operator's first
> Add, and `restoreOutputs()` when a previous launch left outputs
> configured **and** the operator opted in. So an install that never
> enabled outputs still opens no IPC link and enumerates no monitor —
> the property to preserve, and why neither call sits in boot.
>
> Rung 12c has since landed too: an output now carries the **Earth
> decoration** the equirect path can — day/night terminator, night
> lights, clouds — plus the atmosphere's **disc tint**, which the plan
> first ruled out and later found crosses. The effects that genuinely
> do not cross (specular, atmosphere *shells* as a mesh with a limb,
> ground shadow, sun sprite) are **not** deferred: they depend on a
> viewer or a silhouette, an unwrap has neither, and baking one in
> paints a fixed glare spot or limb ring onto a physical sphere in a
> place correct from exactly one vantage point. Don't add them.
>
> The atmosphere is the one row that table got half right, and the
> distinction is worth keeping straight: the *shell* is a mesh whose
> whole point is its silhouette, and an unwrap has no silhouette — but
> that shell covers the visible **disc**, and pinned to nadir its
> integral collapses to a function of sun angle alone, meaningful at
> every point of an unwrap. That disc tint is `atmosphereNadir.ts`, and
> it is why the output's ocean is not black. Removing it on the
> strength of the "atmosphere → meaningless" row would reintroduce the
> bug it was written to fix.
>
> What rungs 9-12 deliberately leave for later, so don't read their
> absence as oversight: per-output **rename** (unassigned — the persisted
> schema has no name field and `OutputRecord` no name, so it is a
> schema change, not a UI one), enforcing the decoder budget at
> **layout change** as well as at spawn (a control window growing from
> 1 globe to 4 while outputs are up can still cross it; that needs
> `viewportManager` to consult the manager, which is cross-cutting and
> its own commit), calibration (14), and the rest of rung 13 — health
> badges, the IPC-silence watchdog, the monitor-unplug poll, the single
> HLS rebuild, GPU context loss, and the orphan boot scan. Rung 13's
> first two slices *have* landed: the manager now notices a window that
> went away and tells a crash from a hand-close (13a), and it reports
> `output_added` / `output_removed` / `output_failure` as Tier A
> telemetry (13b) — so each remaining failure-recovery case adds one
> `emit()` rather than re-opening the analytics reviewer checklist. The
> plan's toast is still missing, and still for the same reason: the app
> has no toast primitive. **One hardware pass has
> happened and the Linux gate is still open** — see the Appendix B
> results log. The debug HUD (rung 11) is what made that pass
> answerable, and it earned itself: step 12b's `-1 ms to -30 ms at
> 30 fps, buffer 4096x2048` is the baseline the next pass compares
> against, and the *absence* of a reason beside a dashed sync field is
> what left "sync just shows a dash" ambiguous for a week — which is
> why the field now names why it has no number. Rung 12's kiosk flag has a narrower gap:
> it **compiles** — `desktop.yml` builds `src-tauri/` on macOS, Windows
> and Ubuntu on every PR, and CodeQL analyses the Rust — and its
> argument and environment *parsing* is unit-tested, but `apply_kiosk`'s
> calls into the window API have never run. So `--kiosk` is untested end
> to end, which is a launch to try rather than code to re-read.
>
> Two things bind on work you might do first. The window and webview
> grants the manager needs **are** now in `default.json`, and
> `output.json` scopes the `output-*` windows — read §6 before adding
> any window or webview permission, since the ACL is checked against the
> *calling* window, not the target, which is why the manager's grants
> live in `default.json` rather than with the outputs they act on. And
> §3 delegates playback sync to `computeSiblingSyncCorrection` and the
> sibling constants in `src/utils/time.ts` rather than restating them,
> so changing those changes the plan.

### Rust module map

| File | Responsibility |
|---|---|
| `src-tauri/src/main.rs` | Entry point — plugin registration, Tauri state setup |
| `src-tauri/src/tile_cache.rs` | SHA-256 flat-file cache for GIBS map tiles |
| `src-tauri/src/keychain.rs` | OS keychain read/write for LLM API key |
| `src-tauri/src/download_manager.rs` | Dataset download with progress events, cancellation, JSON index |
| `src-tauri/src/download_commands.rs` | Tauri commands exposing download operations to the frontend |
| `src-tauri/src/lib.rs` | Shared app entry (`run()`) for desktop **and** mobile — module wiring, plugin/builder setup, `native_panic` hook; `main.rs` calls it on desktop, the `mobile_entry_point` macro on iOS/Android. Also the **kiosk launch** flag (`docs/MULTI_MONITOR_PLAN.md` §3.6, rung 12b): `--kiosk` or `TERRAVIZ_KIOSK=1` applies fullscreen + decorationless to the main window in `setup()`. Two paths because they serve different launchers — a `.desktop` autostart entry or systemd unit sets an environment variable naturally, a wrapper script passes a flag — and neither can drive a runtime keystroke, which is why this is read at startup rather than left to F11. **A set variable is not a true one:** `TERRAVIZ_KIOSK=0` and an empty value both mean off, because a deployment templating one unit file across several machines sets it explicitly to disable kiosk, and a presence test would hand those a decorationless fullscreen window; the value is matched against an allowlist. `kiosk_requested` takes its inputs rather than reading the process, so the rules are unit-tested without spawning a binary. Decorations are dropped only *after* fullscreen succeeds — the same ordering rule `windowChrome.ts` follows, since the reverse leaves an undecorated windowed app the operator cannot move or close — and every failure is logged and swallowed, because an unattended installation that refuses to boot is worse than one with a title bar. All of it `#[cfg(desktop)]`-gated: this file compiles into the iOS/Android cdylib too, where argv flags mean nothing. Also `quit_app`, the command behind `windowChrome`'s Ctrl+Q: a command rather than `tauri-plugin-process` because that plugin would be pulled in for this one call, and rather than a menu accelerator because a window with no menu bar — which is what kiosk mode is — does not reliably fire one. It is **not** `close()` on the control window: Tauri exits when the *last* window closes, so with outputs up that would leave the app running with its operator surface gone. Who may call it is already settled by the capability split rather than by a check inside it — `invoke` needs `core:default`, granted in `default.json` and withheld in `output.json` |

### Key configuration files

| File | Purpose |
|---|---|
| `src-tauri/tauri.conf.json` | Window config, updater (pubkey + endpoint), asset protocol scope, bundle targets |
| `src-tauri/capabilities/default.json` | Permission policies for the main window, which is also the multi-output manager — HTTP allowlist (localhost, Ollama/LM Studio/llama.cpp ports, HTTPS), updater, window controls, and the webview/window grants that let it spawn, place, reveal and tear down `output-*` windows |
| `src-tauri/capabilities/output.json` | Narrow capability scoped to the `output-*` window glob — IPC listen/emit, the window getters and setters an output drives **on itself**, and HTTPS fetch with localhost explicitly denied. No `core:default`, so no Tauri command `invoke` at all. It is defence in depth against a compromised output, **not** a restraint on the manager: Tauri checks window commands against the *calling* window, so putting the manager's grants here instead would deny every manager-initiated operation on an output |
| `src-tauri/Cargo.toml` | Rust dependencies — tauri, reqwest, keyring, tauri-plugin-http, tauri-plugin-updater |

### Tauri patterns used in the frontend

All Tauri imports are **lazy-loaded** behind `IS_TAURI` checks so the web build is never affected:

```typescript
// Pattern used in llmProvider.ts, downloadService.ts, datasetLoader.ts, etc.
const tauriFetchReady: Promise<typeof fetch | null> = IS_TAURI
  ? import('@tauri-apps/plugin-http').then(m => m.fetch).catch(() => null)
  : Promise.resolve(null)
```

- `@tauri-apps/api/core` — `invoke()` for IPC commands, `convertFileSrc()` for local file URLs
- `@tauri-apps/api/event` — `listen()` for download progress/complete/error events
- `@tauri-apps/plugin-http` — CORS-free `fetch()` for LLM requests and image resolution probes
- `@tauri-apps/plugin-updater` — auto-update check on launch

### Offline dataset downloads

- Downloads are managed by `download_manager.rs` with files stored under `{app_data}/datasets/{dataset_id}/`
- A JSON index (`index.json`) tracks all downloaded datasets
- `downloadService.ts` resolves assets: videos via Vimeo proxy (highest quality MP4), images via HEAD probes (4096 → 2048 → original)
- `datasetLoader.ts` checks for local cache first via `getDownload()` / `getDownloadPath()` before hitting the network
- Local files are served to the webview via `convertFileSrc()` → `http://asset.localhost/` URLs
- The asset protocol scope is restricted to `$APPDATA/**` and `$APPLOCALDATA/**`

### HTTP plugin allowed origins

The Tauri HTTP plugin capability (`capabilities/default.json`) restricts outbound HTTP:
- `http://localhost:*` and `http://127.0.0.1:*` — any port on loopback
- `http://*:11434` (Ollama), `http://*:1234` (LM Studio), `http://*:8080` (llama.cpp/vLLM)
- `https://*` — any HTTPS endpoint (OpenAI, video proxy, NOAA, NASA GIBS, etc.)
