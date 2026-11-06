# Sea Surface Temperature Anomaly as a data-encoded dataset

**Status: draft for review.** Nothing here is built. The source is
verified, the data has been sampled, and the gaps standing between
it and a self-updating workflow are named with the code they live in.
The Climatologist and Scientific Visualization Reviewer agents have
reviewed it, and their findings are folded in (§Review record). No
person has reviewed it yet.

Last reviewed: 2026-11-06

Revisit when: the zyra NetCDF-input gap (G1) closes or is refused
upstream; zyra emits a reserved no-data band (G3); the node's science reviewer decides the
baseline question (D1); NCEI changes the OISST v2.1 bucket layout or
stops keeping `_preliminary` files after the final ones land; CPC's
ENSO status changes from what §Why quotes.

## Why this dataset, and why not the pictures we already have

CPC is under an El Niño Advisory. Its 8 October 2026 discussion
expects a **"strong-to-very strong El Niño likely through
January–March 2027"** and puts the odds of a historic event at better
than even. Re-check after the next discussion on 12 November.

CPC now states event strength with **relative** indices:
- the 3-month RONI;
- monthly relative Niño indices, each the regional anomaly minus the
  tropical mean.

October 2026 reads **+2.47 °C in Niño 3.4** and **+4.43 °C in
Niño 1+2** (`cpc.ncep.noaa.gov/data/indices/rel_mthsst9120.txt`).

CPC's traditional weekly OISST indices are larger, because they keep
the tropics' overall warmth. The week centred on 28 October reads
+3.4 °C and +5.4 °C (`wksst9120.for`, 1991–2020 base). Weekly values
are also noisier than the 3-month index CPC classifies with.

Both files were read on 2026-11-06. Visitors will ask what the ocean
is doing, and docents will want to point at a number. Which number the
globe shows, and how it relates to CPC's, is D1.

Every SST anomaly product a node can show today is a **picture**:

- NOAA View's `globaldata.html#SSTA` serves RGB tiles.
- The node's existing *Sea Surface Temperature Anomaly - Real-time*
  workflow ([`DATASET_SOURCE_PRESETS_DRAFT.md`](DATASET_SOURCE_PRESETS_DRAFT.md)
  §Worked example) syncs pre-rendered Coral Reef Watch PNGs from
  `ftp://public.sos.noaa.gov/rt/sst/nesdis/sst_anom/4096/`, with a lag
  of about 9–10 days.

A picture has no values under the cursor, can't be recolored, and
can't feed the Analyze panel. That rules out "what is the anomaly off
Peru right now?" and "what's the Niño 3.4 mean in this frame?".
A **data-encoded** dataset ([`DATA_ENCODED_VIDEO_PLAN.md`](DATA_ENCODED_VIDEO_PLAN.md))
puts the measured anomaly in each pixel's luma and carries the palette
as a sidecar, so the globe recolors it and hover, Analyze and Orbit's
`probe_value` all read the real number.

It is also the first **diverging** field anyone would publish this way.
Zero is mid-scale and both tails are data. The data-encoded plan's
follow-ups say exactly this has been designed and never had a publisher.
That makes this dataset a test of the scheme as well as a dataset.

## Recommendation in one paragraph

Use **NOAA's Daily Optimum Interpolation SST v2.1 (OISST)** from the
NOAA Open Data Dissemination bucket on S3. Take its own `anom`
variable, the latest 90 days of `_preliminary` files, at a symmetric
**−10 to +10 °C** range on a diverging palette with land masked. It is
the analysis behind CPC's weekly Niño indices. It reaches a CI
runner (open S3), posts about two days after the fact rather than ten,
and is 1.5 MB a day. One gap in our toolchain still blocks it: G1,
in zyra, named below. The other, G2 in TerraViz's placeholder grammar,
is now built. One science decision needs a person: the anomaly baseline
(D1).

## Sources considered

| Source | Form | Lag | Anomaly baseline | Reachable from CI | Verdict |
|---|---|---|---|---|---|
| **OISST v2.1 on NODD**, `noaa-cdr-sea-surface-temp-optimum-interpolation-pds` | NetCDF4, one file per day, 0.25° (1440×720), carries `sst`, `anom`, `err`, `ice` | preliminary ~D+2, final ~D+16 | 1971–2000 (see D1) | Yes. Open S3, listed and downloaded 2026-11-06 | **Recommended** |
| PSL `sst.day.anom.<YYYY>.nc` (`downloads.psl.noaa.gov`) | One NetCDF per **year**, 484 MB and growing | ~D+1 | 1971–2000. Byte-identical to NCEI's `anom` on 2026-11-04 | Yes (nginx, range requests honoured) | Rejected. A year-long time series per file means a ~0.5 GB download per run, a year placeholder the grammar lacks, and a 3-D array the heatmap rejects. No better baseline either |
| PSL `sst.day.mean.ltm.1991-2020.nc` | Day-of-year climatology, 1.4 GB | static | is the 1991–2020 climatology | Yes | Needed only for the D1 rebaseline option, not as a frame source |
| CoastWatch ERDDAP `ncdcOisst21Agg_LonPM180` | Server-side subset (`[last]` indexing, `.geotif` output) | **final only**: last time step 2026-10-22, two weeks behind | 1971–2000 (same field) | Intermittent. `.das` returned 503 during the probe | Rejected. Two weeks staler than NODD, and a 503 on a public server is a failed run |
| Coral Reef Watch CoralTemp SSTA 5 km | NetCDF, 0.05° (7200×3600) | ~D+1 | CRW's own 1985–2012 climatology | Not probed | Not pursued. Non-standard baseline for ENSO, and the existing picture feed already uses it |
| GFS / GEFS / RTOFS on NODD | GRIB2, the format the pipeline is native to | hours | **none**: no anomaly field | Yes | Rejected. Needs a climatology subtraction zyra can't do (see G5) |

## The data, measured

All numbers are from files downloaded on 2026-11-06. The script
outline is in Appendix B.

**Layout.** Keys are
`data/v2.1/avhrr/{YYYYMM}/oisst-avhrr-v02r01.{YYYYMMDD}_preliminary.nc`,
with the final file dropping the `_preliminary` suffix. `anom` is
`int16` with `scale_factor 0.01`, `_FillValue −999` over land, units
`Celsius`, dims `(time=1, zlev=1, lat=720, lon=1440)`. Latitude runs
**south to north** (−89.875 … 89.875) and longitude **0.125 … 359.875**.

**Latency.** Preliminary files for 28 Sep – 4 Nov 2026 posted between
**D+1 14:30Z and D+3 08:31Z**, most at D+2 ~08:30Z. Finals posted
D+15 to D+17. Preliminary files **stay in the bucket after the final
lands**: both versions are present for every September and October day.
That is observed, not documented.

**Distribution, 2026-11-04, ocean cells only:**

| p0.01 | p0.1 | p1 | p50 | p99 | p99.9 | p99.99 | min | max |
|---|---|---|---|---|---|---|---|---|
| −5.23 | −2.84 | −1.50 | +0.49 | +4.85 | +6.54 | +7.16 | −10.62 | +8.16 |

**The tail is the story.** In the Niño 1+2 box (0–10°S, 90–80°W),
the share of 0.25° cells above a candidate `vmax`:

| day | box mean | > +6 °C | > +7 °C | max |
|---|---|---|---|---|
| 2026-10-25 | +5.60 | 36.2% | 1.6% | +7.71 |
| 2026-10-27 | +5.36 | 21.9% | 0.8% | +7.70 |
| 2026-10-29 | +5.25 | 16.5% | 0.9% | +7.47 |
| 2026-10-31 | +5.56 | 32.6% | 4.1% | +7.66 |
| 2026-11-04 | +5.78 | 47.7% | 8.9% | +7.90 |

Pooled over those eight days, the global |anom| p99.9 is 6.41.

**Niño 3.4 cross-check.** Area-weighted (5°S–5°N, 170–120°W) from the
`anom` field: **+3.53 °C** on 2026-11-04 and **+3.60 °C** averaged over
25–31 Oct. CPC's traditional weekly index for the week centred on
28 Oct reads **+3.4 °C**. The 0.2 °C gap is the baseline (D1), not an
error in either. CPC's relative index for October is **+2.47 °C**, a
different quantity that the globe does not show.

## Decisions for review

### D1. Which baseline the anomaly is against (needs a person)

Each file states its baseline in its own metadata:
- the NCEI file's `references` attribute: *"Climatology is based on
  1971-2000 OI.v2 SST."*;
- PSL's daily anomaly file's `comment`: *"Anomaly is based on
  1971-2000 OI.v2 SST."*

The two fields are identical cell for cell. Subtracting PSL's
1991–2020 day-of-year climatology from the same day's `sst` gives
Niño 3.4 = **+3.32 °C**, against +3.53 °C from `anom`.

The offset (1971–2000 anomaly minus 1991–2020 anomaly) on 2026-11-04,
area-weighted:

| region | offset |
|---|---|
| Niño 3.4 | +0.21 °C |
| \|lat\| 0–10° | +0.17 °C |
| \|lat\| 10–40° | +0.06 to +0.08 °C |
| \|lat\| 40–70° | −0.01 to −0.19 °C |
| North Atlantic, 0–60°N | +0.30 °C |
| 60°S–60°N, ice-free | +0.07 °C |
| global | +0.04 °C |
| cell by cell, 5th–95th percentile | −0.54 to +0.54 °C |

So the older baseline is **not a uniform warm shift**. It is
regionally patterned, and negative across the mid-to-high latitudes. A
plain warming between the two 30-year periods would make it positive
almost everywhere, by more than this global mean. OI.v2 data only
begin in late 1981, so the 1971–2000 climatology cannot be built from
OI.v2 alone. The difference therefore likely mixes that warming with
differences in how the two climatologies were built: resolution, and
version changes, which would give opposite signs across fronts and
along the ice edge. This is **one day**, and the seasonal behaviour is
unmeasured. Settling it means mapping the offset across a year, which
is a job for a climatologist with the climatology files.

**What the globe will not match.** CPC states event strength with
relative indices, as §Why explains. Its 3-month ONI and RONI are
computed from ERSST.v5, a coarser monthly analysis, not OISST. So no
baseline choice here makes the globe agree with CPC's headline number:
- Niño 3.4 on the globe currently reads about **1 °C above** CPC's
  relative index;
- option (b) below would only match CPC's traditional weekly file.

That gap needs a docent note, not a fix. **An Analyze box mean over
Niño 3.4 is never "the Niño 3.4 index"**, and nothing the node
publishes should call it that.

Options:

- **(a) Ship NCEI's own `anom`, baseline named in the description.**
  The value on screen is one the producer published, so the node
  derives nothing. Cost: Niño 3.4 on the globe reads ~0.2 °C above
  CPC's traditional weekly index and ~1 °C above its relative index.
  Even in a neutral year, the equatorial Pacific reads slightly warm
  on this baseline.
- **(b) Rebaseline to 1991–2020**, the period CPC's traditional
  indices use. This needs `sst − climatology(day of year)`, which zyra
  cannot compute (G5). It is also exactly the case `CLAUDE.md` §When a
  person decides names: *"the node derives a value its producer never
  published (an anomaly against a baseline the node chose)"*.
- **(c) A relative anomaly map**: each cell minus the tropical-mean
  anomaly, CPC's newer framing. It needs the same arithmetic plus an
  area mean, and it is a different dataset with a different
  description. Noted, not proposed.

**Recommendation: (a) for the first release, with the baseline in the
abstract and a docent note on how its numbers relate to CPC's.**
(b) is a later phase with a named human sign-off, not a default.
This is a recommendation for the node's science reviewer to accept
or overturn. Any **exact** figure for the gap that the node publishes
is a value the node computed, so that is theirs to sign off too.

### D2. Color limits: symmetric, ±10 °C, not p99.9

The data-encoded rule of thumb, `vmax ≈ p99.9`, would give about +6.5.
For this field that is wrong in a way the rule can't see. It is
calibrated for "the rare tail is noise", and here the rare tail is the
El Niño. At +6, between 16% and 48% of Niño 1+2 cells clamp to full
luma. A clamped cell *reads back* as exactly the limit, because the
hover has no "at least" form (G6). So the readout would understate the
event at the place visitors will point, and nothing would say so.

- **Symmetric**, so zero sits mid-scale and equal colors on either
  side mean equal magnitudes. An asymmetric range moves the palette's
  neutral point off zero, and the globe then shows "normal" ocean as
  slightly warm or cool.
- **±10 °C, not ±8.** The highest Niño 1+2 cell sampled was +7.93
  (8 days pooled), and the global extremes on 2026-11-04 were +8.16
  and −10.62, the cold one near the ice edge. A ±8 range would leave
  one or two codes of headroom, while the share of Niño 1+2 cells
  above +7 rose from 0.8% to 8.9% in ten days. The limits are fixed for
  the life of a self-updating row, so headroom is chosen once, now, and
  not widened mid-event.
- **Precision.** One code is 20/255 = **0.078 °C**, which is the
  quantisation step alone. The single H.264 encode adds about one code
  RMSE (`DATA_ANALYSIS_PLAN.md` §Honest tradeoffs), correlated within
  blocks and worse at edges. So expect about **±0.1 °C** off the coast
  and more along it. That is within OISST's own analysis error, but it
  sets the verification tolerances below.
- **Watch for clamping on every run while the event lasts:** any ocean
  cell at code 255 means a limit has been reached. Nothing in the
  runner checks this today. A saturation warning in the publish log is
  part of G6.

The cost of the wide range is **contrast for ordinary anomalies**. On a
linear ramp across ±10, a +1 °C marine heatwave gets a tenth of the red
side. Most of the ocean (p1–p99: −1.5 to +4.9 °C) draws in pale tints,
which understates everything outside the eastern Pacific. The fix is
not narrower limits, because those are about the values. It is the
palette (D3) or a display stretch (G4). The encoding stays ±10 either
way, so hover reads the same.

Zero falls between codes 127 and 128 (which one depends on zyra's
rounding) and reads back within 0.04 °C of zero. That is below one
code and below the codec's noise.

### D3. Palette: diverging, nothing faded

```json
{"type":"continuous","base":"RdBu_r","transparent_range":6,"blend_range":0,"overall_alpha":1.0}
```

- **`RdBu_r`**: blue (cool) → white → red (warm). A ColorBrewer
  diverging map that ships with matplotlib, so `cmap_inline` can name
  it.
  - **Lightness:** it rises steadily toward white on both sides
    (L\* about 20 → 97 → 20).
  - **Colour-vision deficiency:** warm and cool stay distinct. At
    ±1 °C, ΔE is about 16 for normal vision, 15 for deuteranopia and
    12 for protanopia.
  - **Against `coolwarm`:** coolwarm's lightness spans only L\* about
    38–88, so ±1–2 °C anomalies would look fainter.
  - **Against a CPC-style 0.5 °C classed palette:** across ±10 that
    needs 40 classes. And the ocean median (+0.49 °C) sits on a class
    edge, so the most common values would speckle across a boundary.
  - The figures above are from the Scientific Visualization review's
    approximate CIELAB and colour-vision calculation.
- **Two costs to check on the sphere.**
  - Near-zero ocean is white, a few ΔE from the ice-sheet white of the
    globe's own land. Antarctic and Greenland coasts may dissolve, and
    "normal" polar ocean could be read as ice.
  - The darkest red (+8 to +10 °C, L\* 20–32) has low contrast against
    black space at the limb. Under protanopia it turns olive, close to
    the Ecuador coast's green.

  If either fails, add coastlines, or use a hosted `cmap_file` palette
  that reaches strong colour by about ±5 °C within the ±10 range. That
  gives ordinary anomalies contrast (D2's cost) while hover stays exact.
  A custom ramp of that length exceeds `cmap_inline`'s 2 KB cap, so it
  must be a hosted file.
- **`transparent_range: 6`, `blend_range: 0`.** **Do not reuse the
  aerosol default** (`12` / `48`). It would make the cold tail
  transparent and fade everything up to about −5 °C. La Niña, upwelling
  and cold eddies would half-vanish, and the asymmetry would read as
  "the ocean is only warming". Six codes is the land band from D4. It
  hides anomalies below about −9.6 °C, which is the price of absorbing
  codec noise along every coast. Size it from the measurement D4 asks
  for, not from this guess.
- **`overall_alpha: 1.0`**: an ocean-covering field should be opaque.
  The 0.95 aerosol value exists so faint plumes don't hide the Earth.

### D4. Land, ice and the no-data code

zyra's luma writer maps NaN to code 0, and code 0 is also `vmin`
(`luma_writer.normalize_to_luma`: *"NaN and masked entries become 0,
which is both vmin and the 'nothing measured here' code"*). That
equivalence held for every field published before. A diverging field
breaks it: land would read as −10 °C and draw deep blue.

**Why one hidden code is not enough.** Hiding only code 0 is exact on
the PNG and wrong on the globe, for two reasons.

- **The video encode rings at coasts.** Land at code 0 next to
  near-zero ocean is a step of about 128 codes, and the one H.264
  encode the transcode makes is noisiest at exactly such edges. Land
  pixels lifted to codes 1–N would draw as opaque −9.9 °C deep blue: a
  fringe along every coast, Peru's included. `transparentRange` exists
  to absorb this kind of noise, and one code absorbs nothing.
- **The palette lookup sits half a code off.** Every client path
  samples the 256×1 LUT at `code / 255`, with no texel-centre
  correction:
  - `earthTileLayer.ts:968`, which filters LINEAR (`:1152`);
  - `layerStack.ts:738`;
  - `photorealEarth.ts:755`.

  So code 1 blends about half and half with code 0, and draws at
  roughly 50% alpha.

**v1 workaround:** a wider transparent band. Start at
`transparent_range: 6` (codes 0–5; `transparentRange` = 6/256, and the
client hides `luma/255 < transparentRange`). Then **measure on the
transcoded HLS, not the PNG**: zoom on Peru, Indonesia and Norway,
count land texels at codes 1–8, and set the band to cover them. The
hover treats hidden codes as "no data", so a fringe that is hidden
also reads correctly.

The cost is that anomalies below the band read as no data: below about
−9.6 °C at six codes. On the sampled days that was a handful of cells,
all at the ice edge.

**Proper fix (G3):** zyra reserves a low band for NaN, writes data
above it, and emits `dataMinLuma` in the sidecar. The client already
honours it (`src/types/color-scale.ts`). Size that band from the same
HLS measurement: 4–8 codes, not 1, or G3 inherits this section's flaw.
Then the workaround comes out.

**Must verify, not assume:** `reproject` falls back to filling with
**0** when the source carries no nodata (`raster_reproject.py`:
*"otherwise those pixels fill with 0"*). For this field 0 means
"normal". Land that loses its nodata tag would hover as +0.00 °C and
draw white, which looks plausible and is wrong. Hovering over land must
say no data.

Ice-covered cells are an open question (below).

### D5. Window, cadence and frame size

- **90 daily frames**, newest first back three months. That covers the
  event's growth from late summer and stays under
  `MAX_PIPELINE_ARG_LIST_ITEMS` (128). Measured against
  `MAX_PIPELINE_JSON_BYTES`, 90 frames' templated URL lists come to
  roughly 25 KB of 64 KiB.
- **Daily schedule; newest frame at LAG `P3D`** if the run can be
  pinned after ~10:00Z, otherwise **`P4D`**. Posting has run as late as
  D+3 08:31Z, and a missing input fails the run.
- **All `_preliminary` for v1.** One filename shape, and the files
  persist (observed). The tradeoff: frames older than ~16 days show
  preliminary values where a final exists. A deterministic refinement
  is final names for frames ≥ 18 days old, since each frame's lag is
  fixed. Deferred because one late final would fail the whole run.
- **End on the frame set, not `compose-video`.** This is the
  data-encoded guidance: publishing frames avoids a second lossy encode
  over value-bearing luma. Set `playback_fps` on the row (≈ 10 gives a
  9 s loop).
- **`reproject` to −180…180 at 4096×2048 with `resampling: nearest`.**
  Nearest keeps every value one the analysis produced; the default,
  bilinear, invents values between cells. The cost is slightly uneven
  cell widths (1440 → 4096 is ×2.84). The client samples the dataset
  texture NEAREST too, so nothing downstream blends cells back
  together.

  Native 1440×720 is **not** a lighter alternative.
  `DATA_ENCODED_RENDITIONS` publishes one 2048-high rung, scaled with
  `flags=neighbor` (`cli/lib/ffmpeg-hls.ts`). Native frames would only
  move the same ×2.84 upscale from GDAL to ffmpeg.
- **Units `"°C"`**, or `"degC"` if the runner mangles non-ASCII.
  Neither is in `unit-scale.ts`'s prefix allowlist, which is correct:
  an anomaly must never be restated as "m°C".

## Gaps, by tier

| # | Gap | Tier | Where | What fixes it |
|---|---|---|---|---|
| **G1** | `convert-format` cannot read NetCDF. `cmd_convert_format` sends every input through `grib_decode`, which is GRIB-only. The `--format netcdf` passthrough fetches the file, but `heatmap`'s NetCDF reader returns `ds[var].values` unsqueezed, `(1, 1, 720, 1440)`, and `normalize_to_luma` raises *"Data must be a 2-D grid (got 4-D)"*. Even squeezed, it would write south-up, 0–360 frames. | 2 (zyra) | `NOAA-GSL/zyra` `processing/__init__.py`, `processing/grib_utils.py`, `visualization/cli_utils.py` | NetCDF input to `convert-format --format geotiff --var`: open with xarray, CF-decode (`scale_factor`, `_FillValue` → NaN), squeeze singleton dims, write north-up with nodata tagged. The rest of the existing chain then works unchanged. Issue body in Appendix A. **Blocking.** |
| **G2** | No `YYYYMM` placeholder. The S3 key has a month directory, and the grammar formats only `YYYYMMDD`, `HH`, ISO and compact instants. | TerraViz grammar | `src/types/zyra-pipeline-args.ts` (shared by the validator and the runner) | Add `{{cycle_month:INTERVAL:LAG}}` → `YYYYMM`. A look-back window then needs no negative offsets: frame *k* uses LAG `P{k}D`, and the cycle maths (`floor((now − LAG) / P1D)`) lands on day *k* before today. **Built** (`cycle_month`, with tests in `zyra-pipeline-args.test.ts` and `workflow-validators.test.ts`; grammar documented in `ZYRA_INTEGRATION_PLAN.md` §Pipeline arg placeholders). |
| **G3** | No reserved no-data band: NaN shares code 0 with `vmin`. | 2 (zyra) | `luma_writer.normalize_to_luma`, `build_color_scale` | Reserve a low band for NaN, sized from the HLS coast measurement in D4 (4–8 codes, not 1). Write data above it and emit the matching `dataMinLuma`. Workaround in D4. **Not blocking.** |
| **G4** | Display transforms are not diverging-aware, and on this field that is a **known defect**, not just a missing nicety. **Stretch:** the handles move by data quantile (`colorbarUI.ts`), so on a warm-skewed field an even drag puts white near +0.5 °C, and cells from 0 to +0.5 °C turn **blue**, a sign flip. **Palette swap:** the choices are viridis, magma, turbo and grayscale, so an anomaly loses its zero. **Threshold:** it keeps one band only, so "\|anomaly\| > 1 °C" can't be shown. | 3 (client) **and the sidecar contract** | `src/services/colorScaleDisplay.ts`, `src/ui/colorbarUI.ts`, `src/types/color-scale.ts`, zyra `build_color_scale` | `ColorScale` has no field saying a scale is diverging or where its centre is. The fix therefore starts as a **contract change**: a centre field, written by zyra and parsed by the client, which routes to the TerraViz Federation Reviewer. The client then offers a diverging palette, keeps a stretch symmetric about the centre, and allows a two-sided threshold. This is the "anomaly and difference display modes" follow-up in `DATA_ENCODED_VIDEO_PLAN.md`, and this dataset is its first user. **Not blocking the default view, but schedule it:** any visitor can tap the colorbar. |
| **G5** | No arithmetic. Rebaselining (D1 b) needs `sst − climatology`. | 2 (zyra) | No `process` command | The same upstream ask as unit rescaling (`capability-gaps.md`). Plus a hosted 1991–2020 day-of-year climatology, and a person's sign-off. **Only if D1 (b) is chosen.** |
| **G6** | Clamping is silent. A cell at code 255 hovers as exactly `vmax` (`formatProbeReading`, `datasetProbe.ts`), the colorbar has no extend markers, and the runner never warns that a frame reached a limit. | 3 (client) + runner | `src/services/datasetProbe.ts`, `src/ui/colorbarUI.ts`, `cli/zyra-publish-from-dispatch.ts` | Hover reads "≥ +10 °C" at the top code (and "≤" at the lowest data code). The colorbar draws extend arrows. The publish log warns when any frame has data at the top or bottom code. **Not blocking**, but D2's headroom is the only defence until it lands. |
| **G7** | The LUT is sampled at `code / 255` with LINEAR filtering and no texel-centre correction, so every code's colour is blended up to half with its neighbour. It is invisible on a smooth ramp, but it makes a transparent band's edge soft (D4). It applies to **every** data-encoded dataset, not just this one. | 3 (client) | `earthTileLayer.ts:968`, `layerStack.ts:738`, `photorealEarth.ts:755` | Sample at `(code + 0.5) / 256`. That is a rendering change to every data-encoded dataset, so the Scientific Visualization Reviewer should check it, and so should the existing luma-check harness. **Not blocking.** |

Considered and rejected as a G1 workaround: pointing `reproject` at a
GDAL subdataset path (`NETCDF:/work/nc/x.nc:anom`). GDAL hands back the
raw `int16` without applying `scale_factor`, so values arrive in
hundredths of a degree. Nothing in zyra rescales them, and the readout
would say 353 where it means 3.53.

### What can ship before G1

There is no clean interim path through the workflow runner. If the
El Niño's timing matters more than automation, the publisher form
already accepts a data-encoded row with a pasted `color_scale` sidecar
(`dataset-form.ts`; `validateRenderEncoding` server-side). A one-off
frame set made outside the runner can be published that way. It would
not update itself, and it has to be redone each time. The existing
picture-path SST anomaly feed keeps running either way. This plan adds
to it and does not replace it until the data-encoded one has proven out.

## The target pipeline (after G1)

Not paste-ready: G1 doesn't exist yet, and the lists are shown
with three of their 90 entries. Every list runs **oldest first**, LAG
`P92D` → `P3D`. Generate the lists rather than typing them.

```yaml
stages:
  - stage: process
    command: convert-format
    args:
      format: geotiff
      var: anom                                   # G1
      output_dir: /work/tif
      inputs:
        - https://noaa-cdr-sea-surface-temp-optimum-interpolation-pds.s3.amazonaws.com/data/v2.1/avhrr/{{cycle_month:P1D:P92D}}/oisst-avhrr-v02r01.{{cycle_date:P1D:P92D}}_preliminary.nc   # G2 (built)
        # … P91D … P4D …
        - https://noaa-cdr-sea-surface-temp-optimum-interpolation-pds.s3.amazonaws.com/data/v2.1/avhrr/{{cycle_month:P1D:P3D}}/oisst-avhrr-v02r01.{{cycle_date:P1D:P3D}}_preliminary.nc
      output_names:
        - "{{valid_compact:P1D:P92D}}.tif"
        # …
        - "{{valid_compact:P1D:P3D}}.tif"
  - stage: process
    command: reproject
    args:
      inputs:
        - /work/tif/{{valid_compact:P1D:P92D}}.tif
        # …
        - /work/tif/{{valid_compact:P1D:P3D}}.tif
      output_dir: /work/wrapped
      dst_bounds: [-180, -90, 180, 90]
      width: 4096
      height: 2048
      resampling: nearest                         # D5: keep measured values
  - stage: visualize
    command: heatmap
    args:
      inputs:
        - /work/wrapped/{{valid_compact:P1D:P92D}}.tif
        # …
        - /work/wrapped/{{valid_compact:P1D:P3D}}.tif
      output_dir: /work/images/frames
      data_encoded: true
      color_scale_file: /work/color-scale.json
      units: "°C"
      cmap_inline: '{"type":"continuous","base":"RdBu_r","transparent_range":6,"blend_range":0,"overall_alpha":1.0}'   # D3/D4: size the band from the HLS check
      vmin: -10                                   # D2: symmetric, headroom chosen once
      vmax: 10
      # NO width/height, NO basemap (data-encoded contract)
  - stage: process
    command: scan-frames
    args:
      frames_dir: /work/images/frames
      datetime_format: "%Y%m%dT%H%M%S"
      period_seconds: 86400
      output: /work/frames-meta.json
  # Ends on the frame set: no compose-video (D5).
```

### Metadata template (draft — goes to review, see below)

```json
{
  "title": "Sea Surface Temperature Anomaly - Last 90 Days",
  "abstract": "How much warmer (red) or cooler (blue) the ocean surface is than its average for the same day of the year, over the last 90 days. The average is for 1971-2000; measured against the newer 1991-2020 average, which many NOAA products use, values can differ by a few tenths of a degree. Point at the ocean to read the anomaly in degrees Celsius. Unusually warm water across the central and eastern equatorial Pacific, lasting for months, is the ocean part of El Nino; unusually cool water there is the ocean part of La Nina. NOAA's Climate Prediction Center determines when either is under way. From NOAA's daily Optimum Interpolation Sea Surface Temperature analysis (OISST v2.1), which blends satellite, ship and buoy measurements on a quarter-degree grid. Every day shown uses NOAA's preliminary daily analysis; the final analysis, issued about two weeks later, can differ slightly and is not used here. Updated daily. Current data range: {{data_start}} to {{data_end}}.",
  "categories": ["Water"],
  "keywords": ["sst anomaly", "sea surface temperature", "ocean", "el nino", "la nina", "enso", "oisst", "real-time"],
  "start_time": "{{data_start}}",
  "end_time": "{{data_end}}",
  "period": "{{data_period}}",
  "organization": "NOAA National Centers for Environmental Information",
  "attribution_text": "NOAA NCEI Daily OISST v2.1 (Huang et al., 2021, doi:10.1175/JCLI-D-20-0166.1), via NOAA Open Data Dissemination",
  "website_link": "https://www.ncei.noaa.gov/products/optimum-interpolation-sst"
}
```

The abstract deliberately says nothing about the *current* ENSO state.
It is self-updating, and any sentence about "this year's El Niño" goes
stale on its own. Current-state claims belong in a blog post or an
event pairing, each of which is reviewed when it goes live. The title
is chosen not to collide with the existing picture-path *Sea Surface
Temperature Anomaly - Real-time*.

## Verification before enabling

1. Validate the YAML against the repo's validators and placeholder
   renderer (`.claude/skills/terraviz-data-video/references/verification.md`).
   Render every input URL for today and check each returns 200.
2. Smoke run as a **disabled draft**. The publish log must show
   `render_encoding, color_scale` attached. A `WARN: … publishing as a
   picture` is a failure.
3. **Values against source, at two stages.** The two stages test
   different things, so they get different tolerances.
   - **PNG frames:** within **±0.04 °C** of the same day's NetCDF (half
     a code). This tests the encode.
   - **Hover on the published HLS:** within **±0.25 °C** (about 3σ of
     the codec residual, D2). A tighter tolerance fails a working
     pipeline on roughly a third of point checks.

   Check three points:
   - mid Niño 3.4 (0°, 150°W);
   - a Niño 1+2 cell at least two cells offshore;
   - a cold-side cell.
4. **Land reads no data**, not +0.00 °C (the D4 reproject trap). Check
   a coast, an inland lake, and Antarctica's edge.
5. **No coastal fringe, measured on the HLS** (D4). Zoom on Peru,
   Indonesia and Norway, count land texels at codes 1–8, and set
   `transparent_range` to cover them.
6. **Orientation**: north up, the date line where it belongs, the
   Niño 1+2 warmth hugging South America and not Africa (0–360 → ±180
   wrap).
7. **Analyze → Niño 3.4 box** matches the area-weighted mean computed
   from the source within the codec tolerance. This is the single best
   end-to-end check that values, geometry and weighting all survived.
   It is a box mean on this dataset's baseline, **not "the Niño 3.4
   index"** (D1).
8. **On the sphere** (D3): polar coasts are distinguishable from
   near-zero ocean, the +8 to +10 °C end reads against black at the
   limb, and a protanopia simulation keeps the warm pool distinct from
   the Ecuador coast.
9. **No clamping**: no ocean cell at the top code (255) or at the
   lowest visible code on any frame (D2). Repeat on each of the first
   runs while G6 is unbuilt.
10. Colorbar: on `main` it is drawn from `color_scale`
    (`src/ui/colorbarUI.ts`), so no `legend_ref` PNG is needed. The
    skill's §8 still says otherwise; that note predates the colorbar.
    **Known defect at launch: G4.** A stretch drag can turn
    slightly-warm ocean blue. Say so in the docent note until G4 lands.
11. Set `playback_fps` on the row.

## Reviews and sign-off

- **Pipeline:** Zyra Workflow Author, then the Code Reviewer for G2's
  grammar change. G2 touches `src/types/zyra-pipeline-args.ts`, which
  the review table routes to both.
- **Science:** Climatologist on D1, D2, D3 and the abstract. This is an
  anomaly dataset's baseline, palette and description, which is that
  row exactly. Scientific Visualization Reviewer on D2, D3 and D5's
  resampling.
- **Public text:** Communications Clearance Officer on the title and
  abstract before the row goes live. On a NOAA node it speaks for the
  agency.
- **Person:** the node's science reviewer decides D1 and records the
  decision with its date. The same person signs off on any exact
  figure the node publishes for the gap to CPC's indices, and on the
  derived values if D1 (b) is ever taken.

### Review record

| Date | Reviewer | Scope | Outcome |
|---|---|---|---|
| 2026-11-06 | Climatologist (agent) | D1, D2, D3, §Why, abstract | Two failures, both fixed in this revision. (1) The abstract's "preliminary and may be revised" was false for an all-preliminary pipeline. (2) The gap to CPC's *official* (relative) indices is ~1 °C, not ~0.2 °C. Also adopted: CPC's own words for the event, exact baseline quotes, the abstract's ENSO wording, and option (c) noted. Measured and kept: the agent expected a +0.2 to +0.3 °C global baseline offset from general knowledge, but re-measurement by latitude band gives +0.04 globally (+0.07 °C over ice-free ocean, 60°S–60°N) and negative at 40–70°. D1 now reports that and leaves the explanation open. |
| 2026-11-06 | Scientific Visualization Reviewer (agent) | D2, D3, D4, D5, G4 | "Fix before ship", now addressed. ±8 → ±10 for headroom. The one-code land band is defeated by codec ringing and the half-code LUT offset → `transparent_range: 6`, sized on the HLS (D4, G7). Verification tolerances split between PNG and HLS. G4 restated as a sign-flip defect needing a sidecar contract change. G6 added (silent clamping). Native 1440×720 dropped as an option. RdBu_r kept, with two sphere checks. |

Agent review is the partial measure `GOVERNANCE.md` describes, not a
sign-off. No person has reviewed this plan yet.

## Phases

| Phase | What | Blocked on |
|---|---|---|
| 0 | This plan. Decide D1. File the G1 (and G3) zyra issues; drafts in Appendix A. | Approval to file; they are public |
| 1 | G2: `cycle_month` in `zyra-pipeline-args.ts`, with tests | **Done** |
| 2 | G1 lands in a zyra release → move the runner to it: the `ZYRA_SCHEDULER_IMAGE` repo variable, and the committed `ZYRA_IMAGE_DEFAULT` in `.github/workflows/zyra-run.yml`, which is still v0.1.52 and predates data-encoded output altogether → author the workflow as a disabled draft → smoke run → verification → reviews → enable | G1 upstream |
| 3 | G3: zyra emits `dataMinLuma` → re-run, remove the `transparent_range` workaround | G3 upstream |
| 4 | *Optional.* Rebaseline to 1991–2020 | G5 upstream, and a person's sign-off |
| — | Diverging-aware display transforms (G4), which start with a `ColorScale` contract change | Its own plan item; schedule it, because this dataset is its first user |
| — | Saturation markers in hover and colorbar, plus a runner warning (G6) | Its own change |
| — | LUT texel-centre correction (G7) | Its own change; touches every data-encoded dataset |

## Non-goals

- **ENSO forecasts or a Niño-index time series.** CPC publishes those;
  a globe frame is not a substitute.
- **Replacing the picture-path SST anomaly feed** until this one has
  run unattended for a few weeks.
- **Coral bleaching heat stress.** That is Coral Reef Watch's product,
  on its own baseline.
- **Weekly or monthly composites.** Daily frames match the source;
  smoothing them is a different dataset.

## Open questions

- **Ice-covered cells.** OISST derives SST under sea ice from ice
  concentration. Whether `anom` is defined there or filled, and whether
  the −10.6 °C minimum on 2026-11-04 sits at the ice edge, is
  unchecked. It decides whether polar ice reads as an anomaly or as no
  data.
- **Do preliminary files persist by policy or by accident?** If NCEI
  starts pruning them, older frames need the final name. That is the
  D5 refinement, promoted from optional.
- **Can a workflow's schedule pin the time of day?** That decides
  `P3D` against `P4D`.
- **Does the runner pass a non-ASCII `units` string through intact?**

## Appendix A — upstream zyra issue drafts (not filed)

Two issues for `NOAA-GSL/zyra`, ready to paste: G1 blocks this dataset
and G3 makes it honest. Filing is outward-facing, so nobody files them
without the maintainer's go-ahead. Both failures were reproduced on
2026-11-06 against **zyra 0.1.56** from PyPI (`zyra[processing]`),
which is also `main` at `70cb06b` for every file involved.

Context the issues don't need to say but a filer should know: the
runner's committed default image is v0.1.52
(`ZYRA_IMAGE_DEFAULT` in `.github/workflows/zyra-run.yml`). That
predates the data-encoded heatmap, which arrived in v0.1.53. So any
node running data-encoded workflows is already on a newer image through
the `ZYRA_SCHEDULER_IMAGE` repo variable. Check which one before
filing, and cite it if it is not 0.1.56.

### Issue 1 (G1) — blocking

**Title:** `process convert-format: accept NetCDF input for geotiff output (CF decode, --var, squeeze)`

````markdown
### Summary

`process convert-format` decodes every input as GRIB2, so a CF NetCDF
source cannot be turned into a GeoTIFF. `visualize heatmap
--data-encoded` can read `.nc` directly, but it rejects the singleton
`time`/`zlev` dims that most daily NetCDF products carry. Together these
leave a NetCDF-only daily product with no way into the
`convert-format → reproject → heatmap --data-encoded` chain.

### Use case

A data-encoded daily sea surface temperature anomaly globe, from NOAA
OISST v2.1 on NOAA Open Data:

```
s3://noaa-cdr-sea-surface-temp-optimum-interpolation-pds/data/v2.1/avhrr/YYYYMM/oisst-avhrr-v02r01.YYYYMMDD_preliminary.nc
```

- Public and unsigned, about 1.5 MB a day. There is no GRIB2 version.
- Variables `sst`, `anom`, `err` and `ice`: all `int16`,
  `scale_factor 0.01`, `_FillValue -999`.
- Dims `(time=1, zlev=1, lat=720, lon=1440)`. Latitude runs south to
  north; longitude runs 0.125–359.875.

### Reproduction (zyra 0.1.56, `pip install "zyra[processing]==0.1.56"`)

```bash
URL=https://noaa-cdr-sea-surface-temp-optimum-interpolation-pds.s3.amazonaws.com/data/v2.1/avhrr/202611/oisst-avhrr-v02r01.20261104_preliminary.nc

# 1. NetCDF -> GeoTIFF
zyra process convert-format geotiff --var anom \
  --output-dir tif --output-names 20261104T000000.tif --inputs "$URL"
```

```
  File ".../zyra/processing/grib_utils.py", line 159, in grib_decode
RuntimeError: Failed to decode GRIB2: no GRIB messages found in input
```

The batch path sends each input to `grib_decode`. The only NetCDF
handling is the passthrough when the target is `netcdf` and no `--var`
is given.

```bash
# 2. The passthrough fetches the file; heatmap cannot read it
zyra process convert-format netcdf \
  --output-dir nc --output-names 20261104T000000.nc --inputs "$URL"   # OK
zyra visualize heatmap --data-encoded --var anom --vmin -10 --vmax 10 \
  --units degC --cmap-file pal.json --color-scale-file cs.json \
  --input nc/20261104T000000.nc --output frames/20261104T000000.png
```

```
ERROR: Data must be a 2-D grid for luma output (got 4-D)
```

`visualization/cli_utils.load_data_array` returns `ds[var].values`
unsqueezed. Squeezing the file by hand does produce a frame, but it is
south-up (the top 40 rows are Antarctica's no-data band) and starts at
0°E. The `.nc` path writes the array in file order and carries no
georeferencing. That is why the GeoTIFF route through `process
reproject` is the one we want.

### Ask

In `convert-format`, when the input bytes are NetCDF and the target is
`geotiff`:

1. Open with xarray, with CF decoding on (scale and offset applied,
   `_FillValue` → NaN), instead of `grib_decode`.
2. Select `--var`, required as now when there is more than one data
   variable.
3. Squeeze singleton dims. If more than two dims remain, refuse with an
   error naming them rather than picking a slice.
4. Write a **north-up** GeoTIFF with an EPSG:4326 transform from the
   1-D lat/lon coords and **nodata tagged** (NaN for float data). Then
   `process reproject` can do the 0–360 → ±180 wrap and the regrid, and
   `heatmap --data-encoded` reads the result as it does today.

Nodata tagging matters for this field in particular. `reproject` fills
with 0 where the source carries no nodata, and 0 means "normal" for an
anomaly, so untagged land would read as a plausible and wrong +0.00.

A smaller, independent change would also help: squeeze singleton dims
in `load_data_array`, with the same refusal past two dims. The direct
`.nc` → heatmap path would then either work or fail with a clear
message, rather than on shape.

### Today

Nothing automates around it. The dataset waits on this.
````

### Issue 2 (G3) — not blocking, makes diverging fields honest

**Title:** `heatmap --data-encoded: reserve a no-data band so NaN does not share vmin's code`

````markdown
### Summary

`luma_writer.normalize_to_luma` maps NaN to code 0, which is also the
code for `vmin`. That is harmless for a field whose minimum means
"nothing here" (aerosol mass). It is wrong for a **diverging** field
(an anomaly or a difference), where `vmin` is a real reading: masked
cells, such as land, read as the most negative value.

### Reproduction (zyra 0.1.56)

Take the OISST v2.1 `anom` field from the G1 issue, squeezed to 2-D,
and render it with `heatmap --data-encoded --vmin -10 --vmax 10`.
Every land cell is code 0, the same code as −10 °C. The sidecar
carries `transparentRange` but no reserved band, so a consumer cannot
tell "−10 °C" from "no data" except by hiding real readings with it.

### Ask

An option, for example `--nodata-band N`, defaulting to `0` (today's
behaviour):

- write NaN and masked cells as code 0;
- scale data into codes `N..255`, so `vmin` is code `N` and `vmax` is
  code 255;
- emit `"dataMinLuma": N` in the colour-scale sidecar;
- leave the palette's stops below `N` transparent.

TerraViz already reads `dataMinLuma`, an integer from 0 to 254:
- codes below it are no data;
- a value is `vmin + (code − N) / (255 − N) · (vmax − vmin)`;
- a sidecar carrying `transparentRange` as well must agree, with
  `ceil(transparentRange · 255) == dataMinLuma`. zyra's
  `transparent_range: N` (written as `N/256`) satisfies that for every
  N from 1 to 255.

**Why N is more than 1:** the frames go through one H.264 encode. At
every coastline, land beside ocean is a step of about 128 codes, and
the encode rings into codes 1–N. A one-code band absorbs none of that.
We will measure N on the transcoded stream before asking for a default;
it is likely 4–8.
````

## Appendix B — how the numbers were made

- **Listings:** S3 `ListObjectsV2` on
  `data/v2.1/avhrr/2026{09,10,11}/`, without credentials.
- **Field statistics:** the 2026-10-25…31 and 2026-11-04 preliminary
  files, read with `netCDF4`, ocean cells only. Regional means are
  cos(latitude)-weighted.
- **Baseline offset:** `sst − ltm` from PSL's
  `sst.day.mean.ltm.1991-2020.nc` (byte-range reads), compared
  cell by cell with the same day's `anom`. The climatology step was
  chosen by matching month and day (4 Nov). That is zero-based index
  307, i.e. day of year 308 in a non-leap year. Latitude bands and
  the ice-free mask use the same file's `ice` field.
- **PSL equivalence:** PSL's `sst.day.anom.2026.nc` for 2026-11-04
  minus NCEI's `anom`: zero everywhere.
- **CPC reference:**
  - `wksst9120.for`, week of 28 Oct 2026 (traditional weekly);
  - `rel_mthsst9120.txt`, October 2026 (relative monthly);
  - the ENSO diagnostic discussion of 8 Oct 2026 (status wording).
- **zyra behaviour:** read from `NOAA-GSL/zyra` `main` at `70cb06b`
  (16 Oct 2026, identical to v0.1.56 in every file involved). Then both
  G1 failures and the G3 behaviour were reproduced against **zyra
  0.1.56 from PyPI** (`zyra[processing]`; the `visualization` extra's
  cartopy would not build in the scratch environment, and the
  data-encoded path does not need it). The runner's committed default
  image is v0.1.52, from the image's own OCI labels, revision
  `78e8c62`. That release predates `luma_writer.py`, which first ships
  in v0.1.53.
