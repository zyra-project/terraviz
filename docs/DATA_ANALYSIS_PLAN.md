# Analysis on data-encoded datasets

> **Status: reviewed; phases not yet built.** No code, no migrations, no
> bindings have landed. This document surveys what the shipped data-encoded
> video work makes possible, proposes an architecture grounded in modules
> that already exist, and sequences it into independently shippable phases.
> The three questions it opened with — audience, the nodata contract, and
> its own scope — were settled on 2026-07-28 and are recorded under
> [Settled](#settled); the remaining open items are listed beside them.

Companion to [`DATA_ENCODED_VIDEO_PLAN.md`](DATA_ENCODED_VIDEO_PLAN.md) — the
substrate this depends on entirely, and whose §Follow-ups this partly answers.
Touches [`WEB_CATALOG_FEATURES_PLAN.md`](WEB_CATALOG_FEATURES_PLAN.md) §9.4
(compare mode, unbuilt) and §9.5 (the uncommitted-ideas register),
[`CATALOG_IMAGE_SEQUENCE_PLAN.md`](CATALOG_IMAGE_SEQUENCE_PLAN.md) (the
`?at=ISO` frame addressing a time series would ride), and — for the Orbit
phase, mandatory per [CLAUDE.md](../CLAUDE.md) §LLM integration convention —
[`AGENT_SDK_EVALUATION.md`](AGENT_SDK_EVALUATION.md) and
[`LLM_INTEGRATION_OPPORTUNITIES.md`](LLM_INTEGRATION_OPPORTUNITIES.md).

## Context

Every dataset terraviz published before this year was a picture. The
data-encoded work changed that for datasets that opt in: luma *is* the
normalised value, a `ColorScale` sidecar rides on the row, the shaders colour it
through a 256×1 LUT at display time, and `probeDatasetValue`
([`src/services/datasetProbe.ts:164`](../src/services/datasetProbe.ts)) reports
the physical value under the cursor with its units.

That readout exists to answer one question — *what is the number here?* But the
capability underneath it is much larger than the feature built on top:
**the client now holds the value of every texel of every frame**, on a known
grid, with an exact linear mapping back to physical units, already decoded and
already colour-managed correctly. That is not a video with a tooltip. It is a
gridded scientific dataset that happens to be spinning on a globe, sitting in
memory, with no server round-trip between the user and the numbers.

Nothing in the repo contemplates that generalization. §Part 4 of the parent plan
is scoped to one pixel under the cursor and says so. The word "transect" appears
nowhere in the codebase or the docs. There is no mean, median, percentile,
histogram, or time-series extraction over pixel values anywhere in `src/` —
`topCoOccurrences` in `catalogGraph.ts` is the only aggregate in the SPA, and it
counts catalog facets, not data.

This document is about the two directions the readout can grow: **across space**
within a frame, and **across time** between frames. Plus a third that is
arguably the most valuable and is nearly free: letting Orbit ask for the numbers
and answer from them.

### What exists today

| Capability | What exists | Gap |
|---|---|---|
| Value at a point | `probeDatasetValue`, `latLonToTexelUv`, `lumaToValue` — pure, unit-tested, correct across the antimeridian and both flip conventions | Single texel, single frame, pointer-driven only |
| Reading a texel | `glLumaSampler` — own WebGL2 context, `texImage2D` → 1×1 draw → `readPixels`, measured exact on iOS/Chrome/Firefox | 1×1 by deliberate design; no batch or block read |
| Texel → lat/lon | — | **Does not exist.** Needed by contours, extremum location, and area weighting |
| The palette | `ColorScale` on the row; `buildColorScaleLut` builds the 256×1 texture; both renderers sample it | Nothing draws a colorbar from it. Legends are still a publisher-uploaded PNG (`dataset.legendLink`), and `probingInfo` has no SPA consumer at all |
| Time addressing | `seekToDate` ([`src/ui/playbackController.ts:391`](../src/ui/playbackController.ts)) for HLS; the exact `Dataset.frames` `{count, start_time, period}` envelope via `resolveFrameQuery` ([`src/utils/frames.ts`](../src/utils/frames.ts)) for image-sequence rows | Nothing samples across frames |
| Orbit's view of a dataset | title, description, categories, keywords, org, time range, plus a free-text `Legend:` string transcribed from the legend *PNG* by a background vision call (`describeLegendAsync`) | The exact `colorScale`, `boundingBox` and `frames` are on the client and never reach the prompt. The prompt actively forbids numeric claims |
| Charting | `renderBarSeries` / `buildCsv` / `downloadCsv` / `csvExportButton` in [`src/ui/publisher/analytics-charts.ts`](../src/ui/publisher/analytics-charts.ts); `d3-scale`/`d3-axis`/`d3-brush` already in `dependencies` (used only by `catalogTimelineUI.ts`) | Nothing charts dataset *values* |

### What is actually live

Three data-encoded rows are published in the production catalog, measured
against `GET /api/v1/catalog` on 2026-07-28 (177 rows total):

| slug | units | range | frames | period |
|---|---|---|---|---|
| `north-america-smoke` | `kg m-2` | 0 → 5×10⁻⁴ | 85 | PT1H |
| `wildfire-smoke-forecast-transparent-united-states-rrfs` | `kg m-2` | 0 → 5×10⁻⁴ | 85 | PT1H |
| `rrfs-smoke-near-surface-north-america` | `kg m-3` | 0 → 2×10⁻⁷ | 85 | PT1H |

All three are RRFS smoke on the 3 km North America domain, all carry a
256-stop palette with `transparentRange` 0.046875 (= 12/256), and all are
**regional**: bbox `n:85 s:5 w:-175 e:-20`. That last detail is not
incidental — `cos(lat)` varies from 0.996 to 0.087 across those bounds, a
factor of eleven, so the area-weighting requirement below is load-bearing on
the very first dataset anyone will point this at rather than a theoretical
concern about polar grids.

Two consequences for sequencing. There is a real dataset to be wrong about
from day one, so no phase here is blocked on a release. And every one of the
three carries a **`frames` envelope** — `{ count: 85, urlTemplate,
framesDigest }` against `GET /api/v1/datasets/{id}/frames/{index}` — with an
exact `startTime` + `PT1H` period, which changes the time-axis architecture
materially (see below).

> The parent plan's header used to say the zyra release and
> `ZYRA_SCHEDULER_IMAGE` bump were outstanding and that no deployed runner
> could produce these frames. That was stale as of the rows above, and the
> header has since been refreshed (November 2026, when the runner's default
> image moved to zyra v0.1.56).

---

## The idea space

Grouped by cost, because cost here varies by two orders of magnitude and should
drive sequencing more than novelty does.

### Group A — Legibility

The LUT is rebuilt client-side from the sidecar on every dataset load
(`earthTileLayer.syncColorLut`, `photorealEarth.setOverlayColorScale`). Anything
expressible as *a different 256×1 LUT* costs one texture upload, works on video
in motion at full frame rate, and reads back zero pixels.

| Idea | What it is |
|---|---|
| **Colorbar from the `ColorScale`** | The palette stops, `vmin`/`vmax` and `units` are all on the client and nothing draws a colorbar. The cheapest high-value item in this document, and the one that makes every other item below legible. |
| **Re-palette at runtime** | The parent plan claims data-encoded datasets are "repalettable without re-encoding" and nothing exercises the claim. Offer viridis / magma / turbo / grayscale alongside the publisher's own. Accessibility follows for free: a colourblind-safe ramp on demand, for any dataset, with no publisher action. |
| **Contrast stretch** | Resample the palette across a `[lo, hi]` sub-range of `t`. Reveals structure in skewed fields where the interesting variation lives in the bottom 10% of the range. |
| **Threshold isolation** | Slide a threshold in physical units; the LUT zeroes alpha outside it. "Show me only smoke above 30 mg m⁻²" as a live, animating mask over the real base map. The highest wonder-per-line item here. |
| **Histogram-equalised palette** | Build the LUT from the current frame's cumulative distribution. Needs Group B's snapshot, but is a LUT swap once it has one. |

**Invariant for the whole group: display transforms must never touch the value
mapping.** A stretched or re-paletted globe still probes to the true value.
`lumaToValue` stays the single source of truth for what a number *is*; the LUT
only decides what it *looks like*.

### Group B — Space, within one frame

Each of these is a pure function over a luma array, the `ColorScale`, and the
`DatasetOverlayOptions` bbox — testable with no GL context, the same shape as
`datasetProbe.ts` and `catalogTimeline.ts` already are.

| Idea | Notes |
|---|---|
| **Region statistics** | A drawn box, the current view, or a named region through the existing `resolveRegion()` in [`src/data/regions.ts`](../src/data/regions.ts). Count, coverage fraction, min/max, mean, median, p10/p90, and area in km². |
| **Histogram** | Falls out exactly. There are precisely 256 distinct source values, so the natural histogram is a 256-bucket count of the luma array — no bin-width choice, no binning bias, and percentiles read off it are exact to within one luma step. Paint each bar with its own palette colour and the chart explains the globe. (The *chart* aggregates several codes per bar; the transport cannot populate all 256. See §The transport lattice.) |
| **Transect** | Click two points → great-circle interpolate N samples → `latLonToTexelUv` each → plot value against distance, re-rendering as the endpoints drag. The standard cross-section tool in every desktop met/ocean package, absent from every web globe we know of, and roughly forty lines on top of code that already exists. |
| **Contours** | Marching squares over the luma array at a chosen physical threshold → GeoJSON LineStrings → a MapLibre line source. Also yields **area above threshold** by counting texels weighted by their own cell area — "how many km² are above AQI 150" is a question a newsroom actually asks. |
| **Zonal mean profile** | Average each image row → one number per latitude → a sparkline down the globe's edge. A standard climate diagnostic, and nearly free once a snapshot exists. |

### Group C — Time, across frames

The axis nothing currently touches. The probe only ever sees the currently
decoded frame. Every product below has a cheap per-frame reduction, so none
needs to hold more than one frame at a time.

**Two transports, and the choice matters more than it first appears.** Every
live data-encoded row carries both a playing HLS video *and* a `frames`
envelope addressing 85 individual full-resolution frames by index, with exact
timestamps from `startTime` + `PT1H`.

| | Sample the decoded video | Fetch frames by index |
|---|---|---|
| Bytes | Free — already downloaded and decoding | A full 4096×2048 frame per timestep |
| Timestamps | Interpolated through `seekToDate`'s linear map across `video.duration` | Exact, from the envelope's own period |
| Latency | One decode per seek; smooth if simply played through | Parallelisable across frames, cacheable by `framesDigest` |
| Fidelity | The frame the user is looking at | The frame as published |

The default is **sample the decoded video**, because for a time series at a
pinned point the bytes are already in hand and fetching 85 full frames to read
85 texels is absurd. Play through once and sample per decoded frame; pin-and-plot
and the GPU composites both fall out of that with no extra network at all.

The frames endpoint earns its place where the whole grid is needed per timestep
anyway (a Hovmöller's zonal means), where exact published values matter more
than smoothness, or where a specific timestamp must be resolved without
scrubbing the transport — `resolveFrameQuery` already turns an ISO timestamp
into an index and a URL. Treat it as the precision path, not the default.

| Idea | Per-frame work |
|---|---|
| **Pin and plot** | Drop N pins, play or scrub, sample N texels per frame. Reuses today's 1×1 sampler completely untouched. Multiple pins become multiple series on one chart. The most legible time feature and the cheapest. |
| **Hovmöller diagram** | Time on one axis, latitude on the other, value as colour — one zonal-mean column per frame. The classic geoscience diagram, and it falls out of a data-encoded video almost for free. |
| **Temporal composites** | Max / mean / min over the played window. Accumulate on the GPU with a MAX blend into an R8 target: **zero readback**. "Peak smoke over the last 48 hours" as a single frame. |
| **Anomaly and difference** | Frame minus temporal mean, or frame minus a reference frame, on a diverging palette. **Blocked on A0** — the nodata band has to be expressible before a field whose zero is mid-scale can be summarised. |
| **Tendency** | d(value)/dt between adjacent frames. Same blocker. |

### Group D — Orbit answering from the data

**Yes, and most of the machinery already exists.** This was the surprise of the
investigation. `docentService.ts` runs a real round-trip tool loop —
`MAX_TOOL_CALL_ROUNDS = 5`, tool calls queue into `pendingSearchCalls`,
executors may be async and hit the network, results return as `role:'tool'`
messages, and the model continues its answer with the real values in context.
`search_datasets` already does exactly this against `/api/v1/search`, with
regression coverage under `describe('processMessage — backend tool round-trip')`.

Adding a data tool is three edits: a tool factory in `docentContext.ts`, the
tool's name in the round-trip condition, and an executor branch in the loop.

| Tool | Returns |
|---|---|
| `probe_value(lat, lon)` | value, units, `noData`, and the displayed frame's timestamp |
| `summarize_region(region_name \| bbox)` | the Group B statistics bundle plus an explicit precision note |
| `find_extremum(max\|min, region?)` | lat, lon, value — and Orbit then chains its **existing** `fly_to` and `add_marker` tools. *"Where is the smoke worst right now?"* → the globe flies there, drops a pin, and Orbit says the number. That is a demo, not a feature. |
| `sample_timeseries(lat, lon, n)` | `[{ t, value }]` for Orbit to describe the trend in prose |

Two things need care, and both are why this is a phase rather than a patch:

1. **Orbit sees no structured scale today.** `buildCurrentDatasetContext` emits
   metadata plus a free-text `Legend:` line transcribed from the legend *image*
   by a best-effort background vision call. The exact `colorScale` — the thing
   that would let Orbit state a range confidently — is on the client and never
   reaches the prompt.
2. **The prompt forbids numeric claims, correctly.** `docentContext.ts` carries
   "Do not invent data values, date ranges, or trends" and "never invent or
   estimate color scales or value ranges from general knowledge." Those rules
   must survive. The carve-out has to be narrow and explicit: *numbers that came
   back in a tool result are real and may be stated; numbers from anywhere else
   remain forbidden.* Widening it to "you may discuss values" would be a
   regression dressed as a feature.

Chat cannot render charts. `renderMarkdownLite` in `chatUI.ts` supports bold,
links and bullets and nothing else; `markdownRenderer.ts` isn't wired to chatUI
at all, and its sanitizer allowlist excludes tables and images deliberately. So
Orbit answers in **prose**, and a new action chip — the event-citation card is
the precedent — opens the Analyze panel with that region or transect
pre-loaded. No chart rendering gets invented inside a chat bubble.

### Group E — Named and parked

- **Cross-dataset differencing** in the 2/4-globe layout. Depends on §9.4
  Compare mode in `WEB_CATALOG_FEATURES_PLAN.md` (unbuilt) *and* on grid
  co-registration, which nothing checks today. Data-encoded video is what would
  make Compare mode numerically meaningful rather than merely visual — worth
  recording as a reason to build it.
- **Joint histograms / scatter** of two variables. Same dependency.
- **Vector fields.** The parent plan names the chroma planes as a legitimate
  home for "a second variable at quarter resolution" (wind U/V alongside a
  scalar) and says it "warrants its own design if a dataset wants it." Agreed;
  not this document.
- **Sonification.** Already in `WEB_CATALOG_FEATURES_PLAN.md` §9.5 as an
  uncommitted idea. A time series at a pin is literally a tone envelope, so
  Phase A7 would hand it its input for free. Cross-referenced, not claimed.

---

## Architecture

Two primitives make almost all of the above cheap, and both extend existing
seams rather than introducing new ones.

### 1. The frame snapshot

`glLumaSampler` reads one texel per call through a 1×1 viewport by deliberate
design; its docstring is emphatic that a full-frame read "on a `mousemove`
stream is not a slow path but a broken one." **That constraint is about
per-pointer-event reads, not about a one-shot**, and the honest resolution is to
say so out loud and add a second, separately named entry point rather than
quietly relaxing the first.

- Extend the sampler with `snapshot(source): Uint8Array | null` — render the
  already-uploaded texture into an **R8** framebuffer and `readPixels` once.
  R8 is colour-renderable in WebGL2 core, so this is ~8.4 MB at 4096×2048
  rather than the ~33.5 MB an RGBA readback costs. *Verify the format during
  implementation; fall back to RGBA if the probe fails rather than assuming.*
- Cache on the key the sampler already computes — source identity plus
  `video.currentTime` — so re-opening a panel on a paused frame is free.
- Reuse the *same* uploaded texture, the same
  `UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE`, the same NEAREST filtering. The
  number computed and the colour drawn still cannot disagree, which was the
  entire point of the GL path.
- **Never on a pointer handler.** Snapshots are user-initiated only, and that
  should be enforced by where the entry point is called from, not by convention.

Every Group B analytic then becomes a pure function over
`(Uint8Array, ColorScale, DatasetOverlayOptions)` in a new
`src/services/datasetStats.ts`.

### 2. Derived frames are just data frames

A temporal max composite, a mean composite, a difference field — each produces
an R8 texture carrying `ColorScale` semantics. Feed it back through the existing
`updateTexture` → `syncColorLut` → `probeValueAt` path and it renders, probes
and colourises through code that already exists and is already tested. No new
render path, no new probe path, and the derived frame is itself hoverable.

This is the same one-chokepoint discipline `DatasetOverlayOptions` already
enforces across four render surfaces, and it is why the composites in Group C
are cheap rather than a second rendering stack.

### 3. The inverse nobody has written

`latLonToTexelUv` exists; **texel → lat/lon does not.** Contours, extremum
location and area weighting all need it. It belongs next to its inverse in
`datasetProbe.ts`, with the V-sign hazard called out — that file's docstring
already records that getting the sign wrong "has happened twice in this
codebase" and "looks entirely plausible on screen." Both directions should be
pinned by round-trip tests.

## Resolved decisions

- **All computation is client-side.** No new API endpoint, no server-side
  statistics, no Worker. The bytes are already downloaded and already decoded;
  sending a region request to an edge function so it can re-fetch the same video
  would be slower and would put a per-user compute cost on the node operator.
  *Tradeoff:* nothing can be computed for a dataset the user hasn't loaded, and
  a 4-globe layout cannot cheaply analyse all four at once.

- **Statistics are pure functions over a byte array, not GL kernels.** GPU
  reduction is faster and much harder to test. The snapshot is one readback;
  everything after it is ordinary TypeScript.
  *Tradeoff:* a full-frame reduction in JS costs tens of milliseconds and a
  transient allocation, where a GPU reduction would cost neither. Accepted
  because these are user-initiated actions, not per-frame ones — with the one
  exception of temporal composites, which stay on the GPU precisely because they
  *are* per-frame.

- **The 256-bin histogram is the canonical distribution; the chart is not drawn
  at that resolution.** Bin edges are the 256 luma codes, so the model is exact
  rather than a choice, and the statistics and the CSV export both come from it.
  The chart aggregates four codes per bar, because the transport cannot populate
  256 codes — see §The transport lattice below, which corrects this bullet's
  original reasoning.
  *Tradeoff:* the exported distribution and the drawn one are now at different
  resolutions, so a reader comparing the CSV against the chart will find rows
  the chart has merged. Accepted: the alternative is a chart that renders a
  transport artifact as though it were a property of the field.

- **Display transforms never alter reported values.** Stretch and re-palette
  change the LUT only.
  *Tradeoff:* a stretched globe and its colorbar can disagree with a naive
  reading of the original palette, so the colorbar must always render the
  *active* transform, not the sidecar's.

- **Progressive disclosure, both audiences.** Colorbar, threshold isolation and
  Orbit's answers live in the main chrome; transects, histograms and region
  statistics live behind an explicit Analyze entry in the Tools popover,
  alongside Privacy and Credits.
  *Tradeoff:* one more panel to coordinate against the existing chat/info-panel
  mutual exclusion, and a design surface that has to read well at both ends —
  more work than committing to a single audience.

- **The nodata band becomes representable now; nothing migrates.** An optional
  `dataMinLuma` on the sidecar (phase A0) marks the lowest luma code carrying
  data. Absent means 0, which is exactly today's arithmetic, so the three live
  rows are untouched and nothing re-encodes. zyra sets it when the first
  diverging field is authored.
  *Tradeoff:* a second way to express "absent" now exists alongside
  `transparentRange`, and the relationship between them has to be documented at
  the contract rather than discovered at a call site.

- **A band, not a sentinel.** An exact reserved code cannot survive the encoder:
  the compression residual is ~1 luma code, so a pixel written as 0 can arrive
  as 2 or 3, and worse across a blocking edge. `dataMinLuma` therefore reserves
  a *range* below it, the same shape `transparentRange` already has.
  *Tradeoff:* the reserved band costs real value resolution — 12 codes out of
  256 in the shipped smoke palettes — where a single sentinel would cost one.
  Unavoidable given a lossy transport.

- **Orbit gets tools, not narration.** Numbers reach the model only as tool
  results, never as an invitation to estimate.
  *Tradeoff:* Orbit will sometimes say "let me check" and take a round-trip
  where a looser prompt would answer instantly and occasionally be wrong.

## Phases

Independently shippable and DCO-signed, one logical change each. Nothing here
is blocked on a release; all three live rows exercise every phase.

**Build order is A2 → A1 → A3 →** the rest. A2 has no UI, so nothing in it
needs redesigning if the audience question is ever revisited, and every phase
from A3 on depends on it. A1 stays first among the *visible* phases for the
reason it always did: the live rows report in `kg m-2` at 5×10⁻⁴ full scale,
which is a number no visitor has intuition for and no colourbar currently
explains. Legibility is what every later phase gets quoted against.

### A0 — The nodata band in the sidecar contract

Optional `dataMinLuma?: number` on `ColorScale` — the lowest luma code carrying
data. Absent means 0. Small enough to land whenever; independent of everything
else.

`lumaToValue` becomes `vmin + ((luma − lo) / (255 − lo)) × (vmax − vmin)` with
`lo = dataMinLuma ?? 0`, which is *identical* arithmetic when the field is
absent — the backwards-compatibility guarantee falls out of the algebra rather
than out of a branch. `isTransparentLuma` tests `luma < dataMinLuma` when set
and keeps the `transparentRange` test otherwise. `buildColorScaleLut` zeroes
alpha across the reserved band.

| File | Change |
|---|---|
| `src/types/color-scale.ts` | The field, the two function changes, validation (integer, 0..254, below the data range) |
| `functions/api/v1/_lib/validators.ts` | Accept and round-trip it; reject out-of-range |
| `public/schema/v1/*.json` | Regenerate via `gen:protocol-schemas` |

**Risks.** The interaction with `transparentRange` is the whole risk: with both
set they must not disagree about where data starts. Validate the relationship at
parse time and fail closed, the way `parseColorScale` already does everywhere
else.

### A1 — Legibility

Colorbar rendered from the active `ColorScale`; palette picker; contrast
stretch; threshold isolation. No readback, no statistics.

| File | Change |
|---|---|
| `src/services/colorScaleDisplay.ts` (new) | Pure: derive tick positions/labels from `ColorScale`; apply stretch and threshold to produce a display LUT |
| `src/types/color-scale.ts` | Reuse `buildColorScaleLut`; add a display-transform parameter rather than a parallel builder |
| `src/ui/colorbarUI.ts` (new) | The colorbar surface + controls |
| `src/services/earthTileLayer.ts`, `src/services/photorealEarth.ts` | Accept a display LUT override; no shader change |
| `src/ui/toolsMenuUI.ts` | Entry point, alongside the existing view toggles |
| `locales/en.json`, `CLAUDE.md` | New keys; module-map rows |

**Risks.** The stretch/threshold state has to live somewhere sane across panel
and dataset switches — `viewPreferences.ts` is the precedent. Getting it wrong
means a threshold from one dataset silently masking another.

### A2 — The snapshot and the reducers

`snapshot()`, `texelToLatLon()`, `datasetStats.ts`, and a generated fixture.
No UI.

| File | Change |
|---|---|
| `src/services/glLumaSampler.ts` | Add `snapshot()` + R8 FBO + cache; `sample()` untouched |
| `src/services/datasetProbe.ts` | Add `texelToLatLon()` beside its inverse |
| `src/services/datasetStats.ts` (new) | Pure reducers: histogram, weighted stats, extremum, transect sampling, zonal means, marching squares |
| `scripts/make-data-encoded-fixture.ts` (new) | Generate a small data-encoded asset with analytically known values, for tests that must not depend on the network |
| `CLAUDE.md` | Module-map rows |

The fixture is for determinism in unit tests, not for want of real data —
`north-america-smoke` is the ground truth to validate against, and its
85-frame envelope makes a specific published frame addressable by index for a
reproducible assertion.

**Risks.** R8 read format support; the fallback must be real, not theoretical.
The cache key must not repeat the stale-texture bug fixed in `fcd92df` — two
sources at `currentTime` 0 are a known collision and the existing code checks
identity separately for exactly that reason.

### A3 — The Analyze panel

Region selection, statistics card, histogram, CSV export.

| File | Change |
|---|---|
| `src/ui/analyzeUI.ts` (new) | Panel; region picker reusing `resolveRegion()`; stat tiles |
| `src/ui/analyzeCharts.ts` (new) | Palette-coloured histogram; extracted from the `analytics-charts.ts` pattern, not imported from it (that module is publisher-portal-scoped) |
| `src/ui/toolsMenuUI.ts` | Analyze entry |
| `scripts/screenshots/scenes.ts` | A scene + smoke assertion |

**Risks.** Area weighting is the correctness risk and deserves a test against an
analytically known field. Panel mutual exclusion with chat and info panel is
established but fiddly.

### A4 — Transect

Two clicks on the globe, then a profile of the field along the great circle
between them, re-sampled live as either endpoint drags. `sampleTransect` and the
slerp shipped with A2; A4 is the pick, the chart, and the line on the globe.

| File | Change |
|---|---|
| `src/services/datasetStats.ts` | `greatCirclePath` (extracted from `sampleTransect`, now shared with the map), `greatCircleKm`, `transectSampleCount`, `summarizeTransect` |
| `src/services/mapRenderer.ts` | `beginTransect` / `transectProgress` / `clearTransect` — click-to-place, draggable endpoints, the densified line |
| `src/ui/analyzeUI.ts` | The transect section and the `TransectPicker` seam |
| `src/ui/analyzeCharts.ts`, `src/ui/analyzeExport.ts` | `renderTransectChart`, `buildTransectCsvText` |

Four decisions worth recording, each of which had a plausible wrong answer:

- **Samples are placed one per grid cell crossed**, not at a fixed count. A
  fixed count over-resolves a short line — interpolating the same texels into a
  smoother curve and drawing structure the grid never measured, which is exactly
  the mistake §The transport lattice describes in the histogram. Cell size is
  taken at the transect's mean latitude, because an equirectangular cell's
  east-west extent shrinks with `cos(lat)` and these datasets reach 85°N.
  Clamped to 512.
- **Not an area chart.** The vertical axis is scaled to the transect's own range,
  because a full `[vmin, vmax]` axis flattens every profile on fields this
  skewed. Filling under a curve whose baseline is not zero draws an area that
  encodes nothing, so the profile is a stroke and a caption says the axis is
  relative.
- **The line on the globe is densified.** MapLibre renders a two-vertex
  LineString as a straight line in projected space, which is not the great
  circle the samples follow. It is subdivided through the same `greatCirclePath`
  the sampler uses, so the chart and the line are one path rather than two.
- **The mean along a line is unweighted**, unlike every other mean in
  `datasetStats`. The samples are evenly spaced in true distance, so each
  already represents an equal length; area weighting answers a question a line
  does not have.

**Risks.** A drag fires at pointer rate, and `frame()` on a playing video is a
full readback — so the panel holds one frame per refresh and a drag re-samples
that, which also makes the profile and the histogram describe the same instant.
Primary panel only, per the constraint below.

### A5 — Contours

Builds on A2's reducers plus A3's panel: marching squares, a MapLibre GeoJSON
line source, and the area-above-threshold readout.

### A6 — Orbit tools

Four round-trip tools, the structured scale in the prompt, the narrow carve-out,
and an action chip that opens Analyze pre-loaded.

| File | Change |
|---|---|
| `src/services/docentContext.ts` | Tool factories; structured `colorScale`/bbox in the dataset context; the carve-out |
| `src/services/docentService.ts` | Round-trip condition + executor branches calling into `datasetStats` |
| `src/types/index.ts`, `src/ui/chatUI.ts` | A `show-analysis` `ChatAction` + its chip |
| `docs/LLM_INTEGRATION_OPPORTUNITIES.md` | Register entry, per CLAUDE.md |

**Risks.** The availability gate is the whole safety story: tools are offered
only when the loaded dataset is data-encoded *and* WebGL2 resolved. Absent
either, the tools are not in the array and Orbit behaves exactly as it does
today — which is CONTRIBUTING §LLM Integrations rule 2, and must be asserted by
a test, not assumed.

### A7 — Time series and composites · A8 — Hovmöller

Pin-and-plot reuses the 1×1 sampler per frame. Composites accumulate on the GPU
and re-enter through the derived-frame path. Hovmöller is A7's zonal reduction
with a second axis.

---

## Non-goals

- **Not a GIS.** No reprojection, no regridding, no vector overlay analysis, no
  raster algebra language.
- **No server-side computation** and no new API endpoints.
- **Nothing for picture datasets.** A legacy colourised dataset has no numbers;
  these surfaces are simply absent for it, never greyed out or apologetic.
- **Not publication-grade statistics.** See below.
- **No new npm dependency.** `d3-scale`/`d3-axis` are already present and the
  hand-rolled SVG helpers in the publisher portal are the precedent.
- **Not multi-dataset analysis**, until Compare mode and grid co-registration
  exist.

## Honest tradeoffs, in one place

**Precision.** The parent plan measured the error budget on normalised `t`:

| term | RMSE |
|---|---|
| 8-bit quantisation floor | 0.001133 |
| compression residual | 0.003927 |
| **total** | **0.004087** |

That is ~0.4% of full scale, and ~96% of it is H.264 noise rather than bit
depth. On the live `north-america-smoke` row that is concrete: `vmax` is
5×10⁻⁴ kg m⁻², so one luma step is 1.96×10⁻⁶ kg m⁻² — 1.96 mg m⁻², which is
exactly the figure the parent plan measured the encoder's own RMSE at. **The
noise floor and the quantisation step are the same size.**

Two consequences the UI must respect. First, compression noise is spatially
correlated — block-structured — so a regional mean does **not** improve as
1/√N; averaging a million texels does not buy three more digits. Second, the
extremum is the single most noise-sensitive statistic available, and
`find_extremum` is the feature most likely to be quoted back. Keep the existing
three-significant-digit convention from `formatProbeReading`, and state the
uncertainty next to any headline number rather than in a footnote.

**The transport lattice.** Found by building the histogram — it is the first
surface in the repo that looks at *which* codes arrive rather than at what they
decode to. The data path ships untagged
([`cli/lib/ffmpeg-hls.ts`](../cli/lib/ffmpeg-hls.ts)), a decision the parent
plan reversed onto after measurement because `-color_range pc` breaks Firefox
and `tv` spends only 219 levels. Untagged works because "the encoder writes
limited-range samples by swscale's default and both decoders expand them back,
so the contraction and the expansion cancel." They cancel in **value** — max|e|
1 luma step, inside the budget above. They do not cancel in **occupancy**: 256
source codes squeeze through 219 and stretch back, so roughly one code in seven
is unreachable on arrival.

Measured on the published `north-america-smoke` frame 40, area-weighted over the
whole globe:

| | codes occupied above the nodata band | codes empty |
|---|---|---|
| source PNG | 243 | 1 |
| after the range round trip | 209 | 35 |

The 34 emptied codes sit about every 7. Drawn one bar per code that reads as a
comb, which is what prompted this section. Two things follow:

- `npm run check:luma-range` **cannot see this.** It fits a gain and checks the
  endpoints, and a contract-then-expand round trip preserves both exactly. The
  check verifies the property it was written to verify; occupancy is the residue
  it is structurally blind to.
- The round trip moves any given sample by at most one code, so aggregating a
  few codes per bar recovers the true shape. At four codes per bar the mean
  bar-to-bar ripple falls from 0.66 to 0.10, against 0.066 for the same field
  read losslessly — what is left is the field's own raggedness. That is why the
  chart draws 64 bars over a 256-bin model.

The honest framing for the UI: a bar is ~1.6% of full scale where the error
budget is ~0.4%, so the chart is coarser than the noise floor and finer than
anything worth concluding from, and the per-value precision is stated
separately. Fixing this at the encoder — `scale=in_range=full:out_range=full`
plus `-color_range pc`, which measured 256/256 exact in Chrome — remains
blocked on Firefox, and would not retroactively fix published rows.

**Area weighting.** Equirectangular rows are not equal-area. This is not a
polar-grid edge case here: the live RRFS rows span 5°N to 85°N, where `cos(lat)`
runs from 0.996 to 0.087 — a texel at the top of the domain covers about a
*ninth* of the area of one at the bottom. An unweighted mean over that box
would inflate the Canadian Arctic's contribution by an order of magnitude
relative to Mexico's. Every spatial aggregate weights by `cos(lat)` or it is
simply wrong, in the direction that makes high-latitude signals look continental.

**Nodata versus real zero.** `isTransparentLuma` is a `t < transparentRange`
threshold at the bottom of the range. For a field where zero is meaningful and
mid-scale — a temperature anomaly — that is not a rough edge, it is incorrect:
statistics would either drop real mid-range data or count absent data as `vmin`.
The parent plan already records diverging fields as an open follow-up. **This
blocks anomaly, difference and tendency modes**, and phase A0 is the answer:
an optional `dataMinLuma` reserving a band below the data range, because an
exact sentinel cannot survive an encoder whose residual is ~1 luma code.

The three live rows are not themselves affected: smoke is a one-sided field
where zero genuinely *is* both the floor and the absence, which is why
`transparentRange` 0.046875 works for them. The ambiguity arrives with the first
diverging field published. A0 makes it expressible without re-encoding anything,
which is the whole reason to land the contract before a dataset needs it rather
than after.

**Only the primary panel probes.** The readout in `main.ts` reads from `primary`
alone, and `probeValueAt` is a `MapRenderer` method rather than part of the
`GlobeRenderer` interface. Any multi-panel analysis needs it promoted first.

**WebGL2 is the gate.** `getSharedLumaSampler()` returns `null` without it and
there is deliberately no 2D-canvas fallback, because that path returns silently
wrong numbers on iOS Safari. Every surface here must be *absent* rather than
degraded when it returns null.

**One shared GL context.** Four `MapRenderer`s plus VR already crowd Chrome's
~16-context cap, and browsers drop the oldest live context rather than refusing
a new one. Extend the shared sampler; never allocate per panel.

**Reduced renditions do not exist here, and that is load-bearing.**
`DATA_ENCODED_RENDITIONS` is a single 4096×2048 rung precisely so no client ever
receives resampled values. Nothing in this plan may reintroduce averaging on the
way in — the snapshot reads native resolution or it reads nothing.

## Verification

- Table-driven unit tests for every reducer in `datasetStats.ts`, no GL context,
  including a synthetic field whose area-weighted mean is known analytically and
  a field whose unweighted mean differs from it materially.
- Round-trip: generate the fixture with known values → snapshot → assert
  recovered values within one 8-bit step. The same measurement that produced
  MAE 0.0024 in the parent plan.
- `texelToLatLon ∘ latLonToTexelUv = identity` across both hemispheres, both
  flip conventions, and the antimeridian — mirroring `datasetProbe.test.ts`.
- Shader-source regex assertions for the R8 pass, per the
  `dataEncodedShaders.test.ts` precedent: assert the correct form *and* the
  absence of the wrong one.
- A `Scene` in `scripts/screenshots/scenes.ts` for every new surface, plus a
  smoke assertion for each interactive one.
- Orbit: a test asserting the tools are absent from the array when
  `renderEncoding` is unset or the sampler is null, and that the round-trip
  produces a `role:'tool'` message carrying real numbers.
- Gates: `npm run type-check` (which runs `check:i18n-strings`,
  `check:doc-coverage`, `check:migrations`, `check:protocol-schemas`) and
  `npm run test`.
- Manual: one data-encoded dataset, hover a value, compute the same region's
  statistics, and confirm the hovered value falls inside the reported range —
  the cheapest end-to-end sanity check available, and the one that catches a
  flipped V.

## Settled

The three questions this document opened with, answered 2026-07-28.

1. **Audience — both, progressively disclosed.** Colorbar, threshold isolation
   and Orbit in the main chrome; charts and statistics behind an explicit
   Analyze entry in the Tools popover. Neither audience gets designed away, and
   the museum visitor never has to dismiss a statistics panel to see the globe.
2. **Nodata — representable now, migrated never.** `dataMinLuma` lands as an
   optional field (A0); absent reproduces today's arithmetic exactly, so no
   published row changes. The expensive part of this decision was always the
   contract, not the encoding, and the contract is now settled before anything
   depends on it.
3. **Scope — this document keeps the legibility work.** A1 is where the value
   mapping and the display transform get separated, and every later phase
   depends on that invariant holding. Planning it in the parent doc would put
   the invariant somewhere the analysis work doesn't cite.

## Still open

- **Whether Compare mode is worth pulling forward.** Cross-dataset differencing
  is parked behind `WEB_CATALOG_FEATURES_PLAN.md` §9.4, but data-encoded video
  is what would make that feature numerically meaningful rather than merely
  visual. It may deserve reprioritising on those grounds alone.
- **What the first diverging field actually is.** A0 makes it expressible; it
  does not say who publishes one or when. Until something concrete is planned,
  the anomaly and difference modes stay designed but unbuilt.
