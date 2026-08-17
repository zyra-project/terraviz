# Data-encoded video: transparency + value readout

**Status: built end-to-end** (on branches, not yet merged). The browser
range check, zyra's luma writer, the encoder, the row + transport, all
four render surfaces, the 2D and VR readouts, and the publish plumbing
that activates the mode are implemented. A pipeline declaring
`visualize heatmap --data-encoded --color-scale-file` now reaches the
globe as data.

Not yet done: the zyra release + `ZYRA_SCHEDULER_IMAGE` bump, so no
deployed runner can produce these frames yet, and the manual
first-slice confirmation under §Verification. Downloads remain the
recorded follow-up.

Backwards compatibility holds at every boundary a dataset crosses — the
encoder argv, the row serializer, the overlay bundle, and the publish
scraper — each pinned by a test asserting the legacy path is unchanged
when the mode is absent.

Resolves the transparency half of
[#326](https://github.com/zyra-project/terraviz/issues/326) and supersedes the
`uOverlayAlphaMode` approach recommended in that issue's body — see
[Evidence](#evidence) for the measurements that changed the recommendation.
Spans this repo and [zyra](https://github.com/NOAA-GSL/zyra). Companion to
[`ZYRA_INTEGRATION_PLAN.md`](ZYRA_INTEGRATION_PLAN.md) (how workflow runs reach
the catalog) and [`INCREMENTAL_HLS_PLAN.md`](INCREMENTAL_HLS_PLAN.md) (the
segment cache whose invalidation key this changes).

## Context

Every dataset terraviz publishes is a **picture**. zyra colorizes data through a
matplotlib colormap, composites it over a basemap, and hands ffmpeg RGB frames.
That throws the numbers away at render time and costs two things:

1. **No transparency.** H.264 has no alpha plane, so "no data" carries whatever
   was underneath at render time — currently NOAA terrain, because the published
   smoke pipeline passes `basemap: fv3-chem-basemap.jpg`. The globe's own base
   map can never show through.
2. **No values.** Nothing downstream can say what the number is.

The fix: stop encoding the picture, encode the **data**. Render frames as
grayscale where luma *is* the normalised value (black = `vmin`/no data, white =
`vmax`), and carry the palette + scale as a sidecar the shader applies at
display time. (Black means both `vmin` and "no data" only because the two
coincide for every field published so far; a sidecar may now set
`dataMinLuma` to reserve a band of low codes for absence and put `vmin` at the
first code above it.) This makes transparency exact, makes datasets repalettable
without re-encoding, and makes the values readable on the globe.

From terraviz#326. **Backwards compatibility is a hard requirement:** every
existing colorized MP4 must keep playing untouched, and publishers must still be
able to upload traditionally-colored video. The new mode is opt-in per dataset;
absent means legacy.

### Decisions taken

- **Scope:** transparency **and** value readout.
- **Sidecar location:** inline on the dataset row.
- **Authoring:** zyra emits it from the pipeline's own `--cmap-file`/`--vmin`/`--vmax`.
- **Surfaces:** all four — 2D globe, VR globe, publisher thumbnail, secondary VR globes.
- **One canonical copy** per dataset (no parallel colorized rendition). Eric's
  note: *"the download capability may need to be revisited to allow people to
  customize."* Captured as follow-up, not in this scope.

### Evidence

Measured on a real RRFS smoke frame with the real palette, through terraviz's
exact ladder settings (`-profile:v main -pix_fmt yuv420p -preset slow -crf 18`):

- **21.3%** of the frame is partially transparent (75.0% clear, 3.7% near-opaque).
  Any binary key discards it — which is why a sentinel-color chroma key fails: a
  pixel that is 10% smoke over hot pink arrives 90% pink.
- Alpha error, mean by band:

  | method | a=0 | 0–.25 | .25–.6 | .6–.9 | ≥.9 |
  |---|---|---|---|---|---|
  | chroma key on a sentinel colour | 0.000 | 0.105 | **0.504** | 0.263 | 0.053 |
  | luminance over white | 0.000 | 0.064 | 0.293 | 0.541 | **0.585** |
  | luminance over black | 0.000 | 0.010 | 0.028 | 0.067 | **0.201** |
  | palette inversion | 0.000 | 0.0072 | 0.0103 | 0.0118 | 0.0047 |
  | **data-as-luma + sidecar** | 0.000 | 0.0141 | 0.0183 | 0.0224 | **0.0027** |

  **Read this honestly: palette inversion wins on alpha error in three of
  the five bands**, and is within a rounding error in a fourth. Alpha
  fidelity is not why data-as-luma was chosen. It was chosen because it
  also carries the *values* — which makes the readout possible, makes a
  dataset repalettable with no re-encode, and is the only option whose
  correctness can be asserted by a test rather than eyeballed. Palette
  inversion buys transparency alone and, being a lossy inverse of a
  colourisation, degrades as the palette gets less injective. Anyone
  revisiting this should know it was a close-run thing on the axis the
  issue originally framed.
- Value fidelity: **MAE 0.0024** on normalised `t` ≈ 0.6 of one 8-bit level.
  In RRFS smoke units, **1.96 mg m⁻² RMSE against a 1.96 mg m⁻² quantisation
  step** — encoder noise is already one LSB.
- 8-bit suffices: compression residual RMSE (0.003927) is **3.5×** the 8-bit
  quantisation floor (0.001133); even CRF 6 stays 2.3× above it.
- Files shrink: 34,153 B vs 50,543 B at identical CRF (flat chroma planes).

---

## Part 1 — zyra: a value-exact luma writer

**This cannot reuse the `visualize heatmap` figure pipeline.** `HeatmapManager.render`
(`src/zyra/visualization/heatmap_manager.py:96-216`) builds a cartopy axes and
saves with `bbox_inches="tight"`; cartopy refits the extent to the axes aspect
and the rasteriser resamples. Measured: requesting exactly the source grid
(1799×1059) returned **1799×899**. Resampling is fine for a picture and fatal
for a value encoding.

Add a **separate short write path** that never touches matplotlib:

1. load via the existing loaders — `cli_utils.load_geotiff_array` and the `.nc`
   branch of `HeatmapManager._resolve_data:55-94`
2. normalise to 0..1 against `vmin`/`vmax`, **required, never autoscaled** — a
   per-frame autoscale makes luma mean something different every frame
3. NaN / nodata → 0
4. optional **nearest-neighbour** resize only
5. write 8-bit grayscale PNG directly

Reuse unchanged: `resolve_batch_output_names`
(`src/zyra/utils/cli_helpers.py:127-188`) for `--inputs`/`--output-names`, and
the ValueError→exit-2 contract in `cli_heatmap.handle_heatmap`.

**Sidecar emission.** Same invocation writes JSON from `load_palette_spec`
(`cli_utils.py:111-211`) plus `vmin`/`vmax`/`units`. The palette half is already
validated there.

**Legend still comes from `write_legend`** (`cli_utils.py:262-313`) — unchanged,
and still needed since the frames themselves are now unreadable by eye.

**Four parity surfaces must move together** or the flag is silently dropped over
the API:
- parser: `src/zyra/visualization/cli_register.py` (heatmap block only — the
  duplicate registrar in `visualization/__init__.py` delegates and is guarded by
  `tests/visualization/test_geotiff_input.py:132-149`)
- handler: `src/zyra/visualization/cli_heatmap.py`, both batch and single branches
- API model: `VisualizeHeatmapArgs` in `src/zyra/api/schemas/domain_args.py:75-128`.
  **It already omits `vmin`/`vmax`**, and Pydantic `extra="ignore"` drops them
  silently. The sidecar depends on those values, so close that gap here.
- regenerated artifacts: `zyra generate-manifest` (pre-commit hook fires on
  `cli_register.py`) and the OpenAPI snapshots (`tests/snapshots/openapi_*`),
  which change whenever `domain_args.py` does.

Tests follow `tests/visualization/test_palette_legend.py`: parser-level namespace
assertions, pure-function `pytest.raises` tables, an API-schema parity test in the
same file, subprocess exit-code checks, and PIL pixel assertions. The critical new
test is **round-trip value fidelity** — write luma, read it back, assert MAE within
one 8-bit step.

---

## Part 2 — encode and transport

### Encoder

`cli/lib/ffmpeg-hls.ts:206-333` is the single argv builder for all three encode
call sites (MP4 full, frames full, frames incremental chunk). Three changes for
data-encoded datasets:

- **Set colour range explicitly — but set the *conversion*, not just the
  tag.** ~~ffmpeg emits limited range (16–235) with unspecified VUI, so add
  `-color_range pc`.~~ **Corrected by measurement** (`npm run
  check:luma-range`, Chrome 150, sampled through both a WebGL texture and
  the 1×1 `drawImage` readout path):

  | setting | 0→ | 255→ | fitted gain | verdict |
  |---|---|---|---|---|
  | today (no colour flags) | 0 | 255 | 1.0005 | survives, but untagged |
  | `-color_range pc` alone | **16** | **235** | **0.859** | **breaks** |
  | `-color_range tv` + matching conversion | 0 | 255 | 1.0005 | survives, 219 levels |
  | `scale=in_range=full:out_range=full` + `pc` | 0 | 255 | 1.0000 | **256/256 exact** |

  Two things were wrong in the original reasoning. Today's argv does *not*
  corrupt the data — with a grayscale PNG source it stores full-swing luma
  and Chrome returns it unchanged, so the round trip already works, just
  with an unspecified VUI that leaves every decoder free to guess. And
  `-color_range pc` on its own does not fix that; it retags the stream and
  flips ffmpeg's assumption about the *input* without changing what
  swscale writes, so samples arrive compressed into 16–235 under a tag
  claiming full range. That is exactly the ≈0.063 shift this bullet set
  out to prevent, manufactured by the fix. The conversion has to be made
  explicit alongside the tag, via `scale=in_range=full:out_range=full`.
  `-x264-params` is not needed; the ffmpeg-level flags suffice.

  **iOS Safari agrees with Chrome to the digit** (Safari 26.6 / iOS
  18.7, measured 2026-08-13 through the WebGL path). Every row of the
  table above reproduces: today's settings and `tv`+conversion both fit
  gain 1.0005, `-color_range pc` alone breaks identically at gain
  0.8589 / offset 15.99, and the recommended
  `scale=in_range=full:out_range=full` + `pc` is 256/256 exact. The
  second decoder family does not change the recommendation.

  **Measured on five browser/platform pairs, which do not agree.** Two
  variants past that table were added to narrow *why* the
  recommendation works. Running everything on three further pairs found
  two separate things, and the honest summary is a table rather than a
  rule (values are the WebGL path, the one the globe uses):

  | setting | iOS Safari 26.6 | macOS Safari 26.5.2 | Chrome 150 / Win 11 | Chrome 151 / macOS M2 | Quest 3 / OculusBrowser 149 |
  |---|---|---|---|---|---|
  | today (no colour flags) | 220/256 | 220/256 | 220/256 | 220/256 | 214/256 |
  | `-color_range pc` alone | **fail** 0.859 | **fail** 0.859 | **fail** 0.859 | **fail** 0.859 | **fail** 0.859 |
  | `tv` + matching conversion | 220/256 | 220/256 | 220/256 | 220/256 | — |
  | full conversion + `pc` (recommended) | **256/256** | **256/256** | **256/256** | 220/256 | **256/256** |
  | conversion + range tag only | **256/256** | **256/256** | **256/256** | 220/256 | **256/256** |
  | recommended minus `-color_trc` | **256/256** | **256/256** | **fail** 1.130 | 220/256 | **fail** 1.129 |

  (The Quest `tv`+conversion render row was lost in transit off the
  headset; its readout row was 220/256 and the setting is not in
  question on any pair.)

  **A partial tag set is worse than no tags at all, and this is a Blink
  behaviour rather than one browser's quirk.** Dropping only
  `-color_trc` — leaving conversion, range tag, primaries and matrix —
  breaks on *both* Chromium pairs that honour the range tag at all:
  Windows Chrome at gain 1.1295 / offset −14.52, and the Quest's
  OculusBrowser at 1.1291 / −14.54. Two independently built Chromiums
  on entirely unrelated hardware, agreeing to three decimal places.
  Both WebKit pairs return the same file clean at 256/256. macOS Chrome
  is not a counterexample: it ignores the range tag on every variant,
  so it has nothing to half-apply.

  That matters for how seriously to take the rule. A single failing
  browser invites working around it; a reproducible Blink behaviour is
  most of the web, and the argv is the only place it can be fixed. The
  transfer tag is not required in the
  abstract — the range-only variant omits transfer, primaries and
  matrix together and is never worse than the recommendation anywhere.
  What breaks is naming *some* colour tags and leaving transfer
  unspecified, which gives a decoder enough to commit to a colour space
  and nothing to interpret it with. The error's shape supports that
  reading (8 exact values with max|e| 20 is a curve, where the range
  failure above is close to affine), though the check fits a straight
  line and cannot prove a mechanism. **Tag everything, or tag only the
  range — never something in between.**

  **And the recommendation's payoff is not universal — one pair does
  not honour it.** macOS Chrome returns the recommended setting at
  220/256, gain 1.0007: identical to the untagged path rather than the
  256/256 the other three give. Nothing is wrong with those values —
  they pass, within one code, exactly as today's settings do. What is
  missing is the reason to prefer the setting at all. Full-range
  tagging was chosen for *occupancy*, 256 reachable codes rather than
  256 squeezed through 219, and on that pair the benefit does not
  arrive. It is Chrome-on-macOS specifically, and four of the five
  pairs measured — including a second Chromium, on the Quest — return
  the recommended setting at 256/256. Safari on the same Mac returns
  256/256 too, so this is neither an engine nor an OS property but the
  one combination.

  The recommendation still stands, because it is never worse than the
  alternatives: exact on four pairs, equal to untagged on the fifth,
  failing nowhere. But nothing downstream may assume a full 256-level
  lattice. The occupancy loss described in the next bullet is a live
  possibility on a *correctly tagged* stream rather than only on a
  legacy untagged one, and the Analyze histogram will comb on that pair
  either way.

  This corrects an earlier entry here which read two variants passing
  on iOS Safari as evidence that the non-range colour tags were
  documentation rather than mechanism. That was one platform's result
  stated as a general conclusion: the second platform falsified the
  claim about `-color_trc`, and the third falsified the assumption that
  the recommended setting delivers 256/256 everywhere.

  Still unverified: Firefox. macOS Safari 26.5.2 is in the table above
  and analysed below, so the only engine left unmeasured on this
  question is Gecko. Every preview deploy
  serves the check at `/luma-check/page.html`, which is the practical
  way to reach a phone or a headset; `npm run check:luma-range --
  --serve` prints a LAN URL for a machine on the same network.

  **The 2D-canvas readout cannot be rescued, and this measured it.**
  On the same device all three `readout*` diagnostics fail identically
  on every variant — gain ≈1.003, offset ≈+6, up to 11 codes of error,
  endpoints intact. Pinning `colorSpace: 'srgb'` on both the context
  and the `getImageData` call changes nothing, and neither does one
  full-size blit instead of per-texel 1×1 draws. Those two variants
  existed to isolate the cause so a fix could be chosen by measurement;
  the measurement says there is no arrangement of the 2D path that
  avoids the transform. macOS Safari reproduces the iOS numbers exactly
  (gain 1.0033, offset +6.10, 12/256), which is the first measurement
  of the macOS half of that claim rather than an assertion about it.
  And the controls now isolate it on a single machine: **Chrome on that
  same Mac passes all three readout paths** and matches its WebGL path,
  as does Chrome on Windows. Same hardware, same VideoToolbox, one
  engine transforms and the other does not — so this is WebKit's doing,
  not a property of 2D canvases and not Apple's colour management. This
  is what
  [`glLumaSampler`](../src/services/glLumaSampler.ts) shipping without
  a 2D fallback buys, and it is now measured on the platform that
  motivated it rather than assumed.

  **On Adreno the two paths disagree by a code, in the other
  direction.** The Quest is the only device measured where the WebGL
  and 2D readings are not identical, and there the GL path is the
  marginally noisier one: 214/256 against the readout's 220/256 on the
  untagged settings, 220/256 against 217/256 on the 8K frame. Every
  reading stays within `max|e|` 1 and passes, and one code is well
  under the quantisation step any physical value carries anyway
  (`docs/DATA_ANALYSIS_PLAN.md` §A2), so this changes nothing about
  what the hover readout may claim. Recorded so that a ±1 discrepancy
  seen on Adreno later is recognised as texture-sampling rounding
  rather than chased as a decode bug.

  **The untagged round trip preserves values, not occupancy.** Shipped
  untagged, the encoder contracts to limited range and both decoders
  expand back; the two cancel to within one luma step, which is what the
  table above measures. What they cannot cancel is *which* codes arrive:
  256 source levels squeeze through 219 and stretch back, leaving about
  one code in seven unreachable. On the published `north-america-smoke`
  frame 40 the source PNG leaves 1 code of 244 empty and the decoded
  frame leaves 35. This is invisible to `check:luma-range`, which fits a
  gain and checks the endpoints — both of which a contract-then-expand
  round trip preserves exactly — and it stayed invisible until the
  Analyze panel's histogram drew per-code occupancy for the first time.
  Consequences for anything reading the distribution rather than a value
  are in [`DATA_ANALYSIS_PLAN.md`](DATA_ANALYSIS_PLAN.md) §The transport
  lattice.
- **`scale` must be `flags=neighbor`** for this path. The filter graph is
  currently `[s${i}]scale=${width}:${r.height}[v${i}]` with default bicubic, which
  interpolates across the nodata/data boundary and invents values that were never
  measured.
- **Single rendition.** The 720p rung would resample a data raster to a quarter
  scale. Data-encoded datasets should publish the 4096×2048 rung only.
  **Revisited 2026-08-16:** "the 4096×2048 rung" and "the source rung" were the
  same number while every dataset was 4096×2048, and a 7200×3600 source
  separates them — the constant now decimates by a non-integer factor above it
  and upscales beneath it. See §The ladder as a relative shape in
  [`DATA_ENCODED_RESOLUTION_PLAN.md`](DATA_ENCODED_RESOLUTION_PLAN.md).

**`segmentDescriptorHash` in `cli/lib/hls-incremental.ts:212-224` must have its
`v: 1` bumped.** Its own docstring warns that ladder-wide codec settings are not
per-rendition fields, so without the bump, segments cached under the old settings
get silently recycled into a bundle whose other segments carry the new ones.

### The row

**Reuse the existing colour columns rather than inventing new ones.**
`migrations/catalog/0009_auxiliary_assets.sql:51-53` already added
`color_table_ref` and `probing_info`, and the migration comment states the intent
almost exactly: *"The color table is the canonical color ramp used for
interactive probing"* and `probing_info` *"maps pixel coordinates on the color
table image to data values, so the SPA can implement hover-to-probe."*
`ProbingInfo` already carries `units`, `minVal`, `maxVal`.

Add **one** new column, `render_encoding` (`null` | `'data-luma'`), and store the
palette + scale in an inline JSON column beside it. `probing_info` is validated
only as "JSON-parseable ≤4096 chars", so tightening it is a small, contained
change; do **not** overload its SOS-specific `minPos`/`maxPos` shape.

**As built this is two new columns**, `render_encoding` and `color_scale`
(`migrations/catalog/0042_render_encoding.sql`). Neither existing colour
column can hold the palette: `color_table_ref` is a URL to a ramp *image*,
which would mean a second fetch and a decode before the first frame could
be coloured, and `probing_info`'s `units`/`minVal`/`maxVal` describe the
SOS snapshot rather than the encode — the two disagree for any dataset
carrying both. `color_scale` is validated far more strictly than
`probing_info`'s parseability check, because it decides what colour every
pixel is and what number the globe reports.

Follow `lon_origin` (Phase 3d) as the precedent — it crosses 16 layers:
migration `migrations/catalog/0042_*.sql` (next free number), `npm run
db:dump-schema`, `catalog-store.ts` row type, `validators.ts`,
`dataset-mutations.ts` insert + update, `dataset-serializer.ts`,
`public/schema/v1/dataset.schema.json`, `dataService.wireToDataset`,
`types/index.ts`, `DatasetOverlayOptions`, publisher form, i18n, docs. Three CI
gates enforce parts of it: `check:migrations` (additive-only),
`check:protocol-schemas`, `check:i18n-strings`.

**`wireToDataset` (`src/services/dataService.ts:327-361`) currently drops both
`colorTableLink` and `probingInfo`** — the server emits them and the client
discards them at the boundary. That has to be fixed for any of this to reach the
renderer.

**Getting the signal out of the run:** `cli/zyra-publish-from-dispatch.ts` already
scrapes the stored pipeline twice — `expectedOutputKind` (`:454-469`) and
`deriveFrameParams` (`:754-791`). A third scraper sits alongside them. Pipeline
arg *keys* are not allowlisted (`workflow-validators.ts:118-167` checks only
stage/command pairs, scalar/array shape, and lengths), so a new zyra stage arg
needs no validator change.

Dormant schema worth knowing about: `schema/catalog-schema.sql:301-311`
already declares `color_space`, `bit_depth`, `has_alpha`, `alpha_encoding`,
`primary_codec` plus a `dataset_renditions` table — **zero code references
anywhere**. They don't express "luma encodes data", so they don't replace
`render_encoding`, but don't add anything that collides with them either.

---

## Part 3 — terraviz render

**Four surfaces**, all reached through one chokepoint —
`DatasetOverlayOptions` (`src/types/index.ts:334-339`), built by
`overlayOptionsFromDataset` (`src/services/datasetOverlayOptions.ts:57-74`) and
`overlayFromRow` (`src/ui/publisher/components/dataset-form.ts:1590-1606`),
consumed at twelve sites. Add the mode there and it reaches everything:

| surface | file |
|---|---|
| 2D globe | `src/services/earthTileLayer.ts:877-941` |
| VR globe | `src/services/photorealEarth.ts:579-667` |
| publisher thumbnail | `src/services/globeThumbnail.ts:286-330` |
| secondary VR globes | `src/services/vrScene.ts:285-293` — **plain material, no shader patch today** |

Each shader gains a palette LUT (256×1 RGBA texture built client-side from the
sidecar) and samples `alpha` alongside colour.

**Alpha is inert today on both renderers — this was the open question in #326,
now answered.** The THREE material (`photorealEarth.ts:502-509`) is constructed
with no `transparent` key and never mutated, so it sits in the opaque pass. The
2D path calls `gl2.disable(gl2.BLEND)` (`earthTileLayer.ts:1748`) with a comment
at `:1769-1775` stating that alpha compositing "would require re-enabling BLEND
here and giving the shader an alpha source."

**Most of that is avoidable.** The VR shader already samples the base map
in-shader on the outside-bbox branch (`texture2D(uOverlayBaseMap, vMapUv)`); the
same sampler composites *inside* the box via `mix(base, palette, alpha)` — no
material change, no render-order change. Only the 2D path needs `BLEND` enabled
for the dataset pass, which is contained because that pass early-returns before
every Earth effect.

**Two traps:**
- The VR shader applies contrast/saturation to `sampledDiffuseColor` *after*
  sampling (`photorealEarth.ts:650-666`), mangling dataset pixels. Data-encoded
  mode must bypass it — luma is a measurement, not a look.
- Both renderers set `SRGBColorSpace` on the dataset texture. Luma must be read
  as a **linear code value**, or every value is gamma-shifted before the LUT.

**Backwards compatibility falls out by construction.** Every render decision
today branches on `dataset.format` via `dataService.isImageDataset` /
`isVideoDataset` / `isTourDataset`; nothing branches on a rendering hint. An
absent `render_encoding` means `overlayOptionsFromDataset` returns exactly what
it returns today and all four surfaces take their current path.

---

## Part 4 — value readout

**The 2D globe already has pointer → lat/lon and it is already wired.**
`mapRenderer.setLatLngCallbacks` (`src/services/mapRenderer.ts:905-918`) uses
MapLibre's `e.lngLat`; `src/main.ts:435-450` feeds `#latlng-display`. Extend that
callback rather than building picking from scratch. Known rough edges to fix
while there: it registers handlers without ever removing them (double-binds on a
second call), it listens for `mousemove` not `pointermove` (no touch), and it
returns a value even when the cursor is off the sphere.

**lat/lon → texel** mirrors the GLSL already in both shaders — bbox sub-rect,
dateline wrap via `fract((lon - uLonOrigin)/360 + 0.5)`, optional V flip. Note
the **V sign differs between renderers** (`0.5 - v` in 2D vs `v - 0.5` in THREE,
documented at `photorealEarth.ts:584-588`).

**texel → value:** there is no `readPixels` anywhere in the repo, and the single
`getImageData` (`photorealEarth.ts:987`, cloud preprocessing) is load-time only
with an explicit 200 MB allocation guard. Do **not** copy a full frame per
pointer event. Instead `drawImage(video, sx, sy, 1, 1, 0, 0, 1, 1)` into a 1×1
offscreen canvas and `getImageData(0,0,1,1)` — one texel, no full-frame copy.
Then luma → `t` → physical value via the sidecar's `vmin`/`vmax`.

**Display** follows the established cursor-follow tooltip pattern in
`src/ui/catalogMapUI.ts:284-319` and `:600-634` (`.hidden` toggle, logical-inset
positioning, edge clamping). Format with `formatNumber`
(`src/i18n/format.ts:50-62`); it already passes `Intl.NumberFormatOptions`
through, so `{ style: 'unit' }` works — nothing in the repo uses it yet. New i18n
keys are gated by `check:i18n-strings`.

**VR** reuses the ray→sphere→lat/lon block in
`vrSession.captureVrCameraState` (`:837-886`) — currently a closure, needs
extracting. `vrInteraction.pickHit`'s globe branch (`:629-637`) discards
`globeHits[0].uv`, which THREE populates for free; keeping it removes the need
for separate maths.

---

## Sequencing

The browser range test comes **first** — it is cheap, and a limited/full-range
mismatch is total failure rather than degradation. It could invalidate the
approach before anything is built on it.

1. **Range verification** in a real browser (video → WebGL texture → sampled
   luma) across Chrome, Safari, Firefox, iOS Safari.
2. **zyra** luma writer + sidecar + parity + tests → release → bump
   `ZYRA_SCHEDULER_IMAGE`.
3. **Encoder + row + transport** (range flags, `flags=neighbor`, single
   rendition, `v:` bump, migration, serializer, `wireToDataset` fix).
4. **Render** across all four surfaces.
5. **Readout**, 2D first, VR second.

Steps 2 and 3 can run in parallel once step 1 clears; 4 depends on both.

## Verification

- **zyra unit:** round-trip a known array through the luma writer and assert MAE
  within one 8-bit step; assert output dimensions exactly match `--width`/`--height`;
  assert nodata → 0; assert missing `--vmin`/`--vmax` is a hard error, not an autoscale.
- **zyra CLI:** subprocess exit-2 checks for the new failure modes, per
  `tests/visualization/test_palette_legend.py:328-358`.
- **zyra parity:** `zyra generate-manifest` clean, OpenAPI snapshot regenerated,
  `VisualizeHeatmapArgs` round-trips the new flag plus `vmin`/`vmax`.
- **End-to-end encode:** run the RRFS pipeline in luma mode, pull a frame back
  through ffmpeg, and assert recovered `t` matches the source GeoTIFF within one
  8-bit step — the same measurement that produced the MAE 0.0024 figure above.
- **terraviz shader:** follow `src/services/photorealEarthBbox.test.ts` — parse
  comment-stripped shader source with anchored regexes, assert both the correct
  form and the absence of the wrong one, and cross-guard the other renderer so a
  fix to one is not copied to the other.
- **terraviz unit:** `datasetOverlayOptions.test.ts`-style table tests for the new
  field, including that an absent `render_encoding` still returns the `undefined`
  fast path (this is the backwards-compat guarantee).
- **terraviz backend:** `validators.test.ts` / `dataset-serializer.test.ts` /
  `dataset-mutations.test.ts` for the new column, per the Phase-3d precedent.
- **Gates:** `npm run type-check` (runs `check:migrations`,
  `check:protocol-schemas`, `check:i18n-strings`, three `tsc` passes) and
  `npm run test`.
- **Manual:** publish one data-encoded dataset and confirm — transparency over
  the real base map, correct colours, a plausible hover value, a correct
  publisher thumbnail, and **an existing colorized dataset rendering byte-identically
  to before**.

## Follow-ups (out of scope)

- **Downloads need revisiting** so people can customise output — a data-encoded
  MP4 downloads as grayscale. Options include client-side colorized export or
  shipping the sidecar in the zip. Eric flagged this explicitly.
- Diverging-field datasets (temperature anomaly) where zero is mid-scale, not
  no-data. The original scheme assumed the two coincide. The sentinel half of
  that is now built — `ColorScale.dataMinLuma` reserves a band of low codes as
  "no data" and moves `vmin` to the first code above it, so a field whose
  minimum is a real measurement is expressible. What is still missing is a
  publisher: no pipeline emits a diverging field yet, so the anomaly and
  difference display modes stay designed rather than built.
- `dataset_renditions` and the dormant colour columns.
- **Analysis beyond one pixel.** §Part 4 stops at the value under the cursor,
  but the frames carry a whole gridded field. Statistics, transects, contours,
  time series at a pinned point, and Orbit answering numeric questions from
  tool results are surveyed in
  [`DATA_ANALYSIS_PLAN.md`](DATA_ANALYSIS_PLAN.md), which also proposes the
  nodata sentinel the diverging-field item above needs.

### Why the chroma planes aren't spare precision

The obvious question about a scheme that encodes into luma is whether the
other two planes could carry low-order bits for 16- or 24-bit values.
**They can't usefully, and the reason is worth recording because the
question will recur:** this scheme is not bit-depth limited.

From the [Evidence](#evidence) above, the error budget decomposes as

| term | RMSE on normalised `t` |
|---|---|
| 8-bit quantisation floor | 0.001133 |
| compression residual | 0.003927 |
| **total** (quadrature) | **0.004087** |

Removing the quantisation term *entirely* — infinite bit depth — lands at
0.003927. That is a **4% reduction in total error** for 8 extra bits.
Roughly 96% of the budget is the encoder's own noise, and quality doesn't
buy an escape: even CRF 6 stays 2.3× above the quantisation floor.

Chroma is also the worst available place to put those bits:

- **Quarter resolution.** `-pix_fmt yuv420p` is forced, so U and V are
  4:2:0 — one chroma pair per 2×2 luma block. That is not extra precision
  per texel; it is a coarser second field.
- **4:4:4 isn't reachable.** `-profile:v main` rejects it, and the
  encoder comment already records that higher profiles "would break
  legacy Safari clients" — the exact constraint
  [#326](https://github.com/zyra-project/terraviz/issues/326) established.
- **Chroma is coded more lossily than luma**, so those bits would sit
  under a worse noise floor than the ones already in use.
- **The client receives RGB, not YUV.** Recovering U/V means inverting the
  bt709 matrix from 8-bit-rounded RGB, folding luma's error into the
  chroma readback. The 3→3 mapping is not lossless even at 4:4:4.
- Flat chroma is why files *shrink* (34,153 B vs 50,543 B at identical
  CRF). Signal there gives that back.

If a dataset genuinely needs more than ~8 effective bits, in order of
preference: **narrow `vmin`/`vmax`** (free, and usually the real answer —
8 bits over a tight range beats 16 over a range the data never occupies);
**two adjacent luma texels** as high/low byte (full resolution, no profile
change, but pointless without the next item); or a **lossless path**
(FFV1, or serving the PNG frame sequence directly), which is the only
option that moves the 0.003927 term at all, at the cost of HLS streaming.

A separate idea the chroma planes *could* legitimately serve — not more
precision, but a **second variable at quarter resolution** (wind U/V
alongside a scalar, say) where coarse spatial resolution is acceptable for
the secondary field. That warrants its own design if a dataset wants it.

### Why the frame is 4096×2048, and what more resolution would cost

The companion question to the one above — not "more bits per texel" but
"more texels" — and it recurs every time a source is finer than the grid.
A 4096-wide equirectangular frame is **9.78 km per texel at the equator**
(40,075 km ÷ 4096), so anything convection-permitting arrives already
finer than the globe can show. `cli/lib/sos-spec.ts` pins 4096×2048 as the
ladder top; deviating from it is a **warning**, not a failure, so nothing
mechanically stops a larger frame. What stops it is further downstream.

| target | grid (2:1) | megapixels | vs shipped | fits H.264/HEVC level 6.2 |
|---|---|---|---|---|
| 9.78 km — shipped | 4096×2048 | 8.4 | 1× | yes — measured, level 5.1 |
| 4.89 km | 8192×4096 | 33.6 | 4× | yes — measured, level **6.0** |
| 3.75 km | 10687×5343 | 57.1 | 6.8× | **no** |
| 3 km — MPAS mesh scale | 13358×6679 | 89.2 | 10.6× | **no** |

Both codecs cap a frame at **35,651,584 pixels** (8192×4352) at their
highest defined level. That is a spec ceiling, not a bitrate or flag
problem: everything past it is unencodable at any quality. Practical
decode limits sit lower still — plenty of hardware advertises a high
level and tops out at 4K.

The two "yes" rows are measured rather than inferred: an 8192×4096
encode through this repo's exact settings is accepted by x264 at Main
profile and stamps **level 6.0**, not 6.2. Levels 6.0/6.1/6.2 share one
139,264-macroblock frame ceiling and differ only in bitrate, and
8192×4096 is 131,072 macroblocks — so it clears the lowest of the three,
which is a better compatibility position than the ceiling figure alone
suggests. What that encode also showed is that the *frame size* is not
what bites: holding `maxBitrateKbps` at the shipped 25 000 while
quadrupling the pixels degrades the value round trip in the tail
(p99.9 error 2 → 7, worst texel 13 → 152), and the damage clusters in
high-frequency regions — the storm cores, for a reflectivity field.
At matched bits-per-pixel the 8K encode is indistinguishable from the
shipped rung. Full numbers, the device-decode probe that is still
outstanding, and what building this would take are in
[`DATA_ENCODED_RESOLUTION_PLAN.md`](DATA_ENCODED_RESOLUTION_PLAN.md).

Four routes past that ceiling get proposed. In rough order of how often:

- **A frame sequence instead of a video.** There is no client-side frame
  animation to fall back on. `src/utils/frames.ts` resolves a frame
  *query* to a single `ResolvedFrame` — one URL, one timestamp — for deep
  links and Orbit markers; it picks a frame rather than stepping through
  them, and `playbackController.ts` contains no reference to frames at
  all, driving one `hlsService.getVideo()`. Frames are an *upload* format:
  `cli/transcode-from-dispatch.ts` declares
  `SourceKind = 'video' | 'frames'` and feeds the frames branch through
  ffmpeg's `image2` demuxer into the same HLS ladder, capped at
  `MAX_IMAGE_SEQUENCE_FRAMES = 10_000`. So a frame set does not dodge the
  transport — it *becomes* it, with the same losses.
- **Tiles played in lockstep** (four 4K quadrants, say). The arithmetic
  disappoints first: each quadrant is 180°×90°, itself 2:1, so four
  4096×2048 tiles compose to 8192×4096 — 4.89 km, not 3.75. Reaching 3.75
  needs a 3×3 tiling and nine streams. Then the engineering: the 4-globe
  layout proves four concurrent decodes work, but `viewportManager` syncs
  **cameras only** (`syncCameras` / `jumpTo` / a `syncLock` re-entry
  guard) and nothing time-syncs panels. Drift is invisible across four
  *different* datasets and fatal across four tiles of *one* field —
  `currentTime` snaps to the nearest decodable point, each element keeps
  its own clock, and a one-frame skew means the values either side of a
  seam come from different timesteps. Seams are a data problem
  independently: bilinear filtering samples across tile edges, so edges
  need padding and deliberate clamping, and `datasetProbe`,
  `datasetStats`, and `glLumaSampler.snapshot()` all assume one frame in
  one context.
- **A resolution ladder with capability fallback.** The most promising of
  the four, because the machinery already exists and was deliberately
  switched off. `cli/lib/ffmpeg-hls.ts` carries a three-rung display
  ladder (4096×2048, 2160×1080, 1440×720) and a **separate single-rung
  ladder for data-encoded**, on the grounds recorded there: the lower
  rungs "would resample a data raster to a quarter scale." `hlsService.ts`
  already implements exactly the fallback such a scheme wants — mobile
  caps `autoLevelCapping` to the screen dimension, and a media error caps
  one level below "to prevent repeatedly hitting the same wall."
  The gap is that ABR switches on **bandwidth**, not only on capability.
  For display video those are one feature; here a bandwidth dip would swap
  the rung mid-session, changing the value under the cursor and making
  "the displayed frame" that Analyze reduces non-deterministic.
  **The workable form is to pin, not adapt:** publish both rungs, resolve
  capability once at load, then set `hls.currentLevel` (which locks a rung)
  rather than `autoLevelCapping` (which leaves ABR free beneath the cap),
  keeping the media-error handler as the escape hatch since a decode
  failure is real capability information. Two costs to price in — the
  downscale must be `flags=neighbor` per the Encoder section, and
  neighbour decimation means the rungs genuinely *disagree* about the
  value at a given lat/lon, so two viewers on different hardware read
  different numbers and the Analyze caveat line has to say so; and
  changing ladder settings requires bumping `v: 1` in
  `segmentDescriptorHash` (`cli/lib/hls-incremental.ts`) or segments
  cached under the old settings get recycled into a bundle carrying the
  new ones.
- **One larger single stream.** Unglamorous and the cheapest real gain:
  8192×4096 is under the codec ceiling, so it needs no new architecture at
  all — no sync, no seams, no rung selection, one decoder. It wants device
  testing rather than design work, and `sos-spec` will warn on the
  resolution. One caveat the encode measurement added: it is *not* purely
  a settings-free bump, because `DATA_ENCODED_RENDITIONS`' 25 Mbps cap
  corrupts values at four times the pixels and has to scale.
  [`DATA_ENCODED_RESOLUTION_PLAN.md`](DATA_ENCODED_RESOLUTION_PLAN.md)
  is the implementation plan.

Note what none of these move. Every route still runs the luma through
`yuv420p` and the limited-range round trip, so the ~219 distinguishable
levels of §Encoder are unchanged however finely space is subdivided.
**Tiling and laddering buy spatial resolution, never value precision** —
if a dataset's problem is fidelity rather than sharpness, this whole
section is the wrong axis and the preceding one is the right one.

So, in order of preference: **accept 9.78 km** (usually correct — the
globe is a browsable surface, not an analysis grid, and `datasetStats`
already weights by true cell area rather than pretending texels are
equal); **test one 8192×4096 stream** if a source genuinely warrants it;
**pin a two-rung ladder** if that stream proves undecodable somewhere it
matters; and past ~35 MP, stop trying to make video carry it — the
grain-aligned answer is a tiled pyramid with zoom-dependent LOD, the way
GIBS already serves the basemap, which is a different renderer path and
its own design.
