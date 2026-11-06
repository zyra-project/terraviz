# Sea Surface Temperature Anomaly as a data-encoded dataset

**Status: draft for review.** Nothing here is built. The source is
verified, the data has been sampled, and the gaps standing between
it and a self-updating workflow are named with the code they live in.

Last reviewed: 2026-11-06

Revisit when: the zyra NetCDF-input gap (G1) closes or is refused
upstream; the `cycle_month` placeholder (G2) lands; zyra emits a
reserved no-data band (G3); the node's science reviewer decides the
baseline question (D1); NCEI changes the OISST v2.1 bucket layout or
stops keeping `_preliminary` files after the final ones land.

## Why this dataset, and why not the pictures we already have

The tropical Pacific is in a very strong El Niño. CPC's weekly
OISST index for the week centred on 28 October 2026 reads **+3.4 °C
in Niño 3.4** and **+5.4 °C in Niño 1+2**, against a 1991–2020 base
(`cpc.ncep.noaa.gov/data/indices/wksst9120.for`, read 2026-11-06).
Visitors will ask what the ocean is doing, and docents will want to
point at a number.

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
**−8 to +8 °C** range on a diverging palette with land masked. It is
the analysis CPC's weekly ENSO monitoring is built on. It reaches a CI
runner (open S3), posts about two days after the fact rather than ten,
and is 1.5 MB a day. Two things in our own toolchain block it today,
both small and named below (G1 in zyra, G2 in TerraViz's placeholder
grammar). One science decision needs a person: the anomaly baseline (D1).

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
25–31 Oct. CPC's week centred on 28 Oct reads **+3.4 °C**. The
difference is the baseline (D1), not an error in either.

## Decisions for review

### D1. Which baseline the anomaly is against (needs a person)

Both NCEI's `anom` and PSL's daily anomaly file say in their own
metadata: *"Anomaly is based on 1971-2000 OI.v2 SST."* The numbers
agree. Subtracting PSL's 1991–2020 day-of-year climatology from the same
day's `sst` gives Niño 3.4 = **+3.32 °C**, against +3.53 °C from `anom`.

The offset (1971–2000 anomaly minus 1991–2020 anomaly) on 2026-11-04:

| region | offset |
|---|---|
| Niño 3.4 | +0.21 °C |
| North Atlantic, 0–60°N | +0.30 °C |
| Northeast Pacific, 30–60°N | +0.15 °C |
| global, area-weighted | +0.04 °C |
| cell-by-cell, 5th–95th percentile | −0.54 to +0.54 °C |

So the older baseline is **not a uniform warm shift**. It is
regionally patterned and goes both ways. The 1971–2000 climatology was
built from the earlier OI.v2 analysis, so the difference likely mixes
the warming between the two periods with differences between the
analyses. A climatologist should read that, not this doc.

Options:

- **(a) Ship NCEI's own `anom`, baseline named in the description.**
  The value on screen is one the producer published, so the node
  derives nothing. Cost: Niño 3.4 on the globe reads ~0.2 °C warmer
  than CPC's official index, and anyone comparing will notice.
- **(b) Rebaseline to 1991–2020**, the period CPC's ENSO monitoring
  uses. This needs `sst − climatology(day of year)`, which zyra cannot
  compute (G5). It is also exactly the case `CLAUDE.md` §When a person
  decides names: *"the node derives a value its producer never
  published (an anomaly against a baseline the node chose)"*.

**Recommendation: (a) for the first release, with the baseline in the
abstract.** (b) is a later phase with a named human sign-off, not a
default. This is a recommendation for the node's science reviewer to
accept or overturn.

### D2. Color limits: symmetric, ±8 °C, not p99.9

The data-encoded rule of thumb, `vmax ≈ p99.9`, would give about +6.5.
For this field that is wrong in a way the rule can't see. It is
calibrated for "the rare tail is noise", and here the rare tail is the
El Niño. At +6, between 16% and 48% of Niño 1+2 cells clamp to full
luma. Clamped cells also *read back* as +6.0 under the cursor, so the
hover understates the event at the place visitors will point.

- **Symmetric**, so zero sits mid-scale and equal colors on either
  side mean equal magnitudes. An asymmetric range moves the palette's
  neutral point off zero, and the globe then shows "normal" ocean as
  slightly warm or cool.
- **±8 °C** covers every Niño 1+2 cell sampled (max +7.93) and all
  but a handful of cells globally (max +8.16, min −10.62, the cold
  extremes near the ice edge). One luma code is 16/255 =
  **0.063 °C**, finer than OISST's own analysis error.
- Re-sample over the whole 90-day window before enabling. If the event
  strengthens past +8 in the east, widen the range. Don't let it clamp.

With `vmin −8, vmax 8`, zero lands at code 128, which reads back as
+0.03 °C. That is below one code and below anything the source
resolves.

### D3. Palette: diverging, nothing faded

```json
{"type":"continuous","base":"RdBu_r","transparent_range":1,"blend_range":0,"overall_alpha":1.0}
```

- **`RdBu_r`**: blue (cool) → white → red (warm). A ColorBrewer
  diverging map that ships with matplotlib, so `cmap_inline` can name
  it. `coolwarm` is the softer alternative. Which reads better on a
  black globe is a question for the Scientific Visualization Reviewer.
- **`transparent_range: 1`, `blend_range: 0`.** **Do not reuse the
  aerosol default** (`12` / `48`). On a ±8 range it would make every
  anomaly below about −7.3 °C transparent and fade everything up to
  about −4.2 °C. La Niña, upwelling and cold eddies would half-vanish,
  and the asymmetry would read as "the ocean is only warming". With
  `1`/`0`, only code 0 is hidden. That is the land workaround in D4.
- **`overall_alpha: 1.0`**: an ocean-covering field should be opaque.
  The 0.95 aerosol value exists so faint plumes don't hide the Earth.

### D4. Land, ice and the no-data code

zyra's luma writer maps NaN to code 0, and code 0 is also `vmin`
(`luma_writer.normalize_to_luma`: *"NaN and masked entries become 0,
which is both vmin and the 'nothing measured here' code"*). That
equivalence held for every field published before. A diverging field
breaks it: land would read as −8 °C and draw deep blue.

**v1 workaround:** `transparent_range: 1` hides exactly code 0
(`transparentRange` = 1/256, and the client hides `luma/255 <
transparentRange`). Land goes transparent and the globe's own Earth
shows through. The cost: a real anomaly at or below about −7.97 °C also
reads as "no data". On the sampled days that is fewer than 0.005% of
ocean cells, all in the far cold tail.

**Proper fix (G3):** zyra writes data into codes 1–255 and emits
`dataMinLuma: 1` in the sidecar. The client already honours it
(`src/types/color-scale.ts`). Then the workaround comes out.

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
  cell widths (1440 → 4096 is ×2.84). Native 1440×720 is the lighter,
  equally honest alternative. 4096 matches the house frame size.
- **Units `"°C"`**, or `"degC"` if the runner mangles non-ASCII.
  Neither is in `unit-scale.ts`'s prefix allowlist, which is correct:
  an anomaly must never be restated as "m°C".

## Gaps, by tier

| # | Gap | Tier | Where | What fixes it |
|---|---|---|---|---|
| **G1** | `convert-format` cannot read NetCDF. `cmd_convert_format` sends every input through `grib_decode`, which is GRIB-only. The `--format netcdf` passthrough fetches the file, but `heatmap`'s NetCDF reader returns `ds[var].values` unsqueezed, `(1, 1, 720, 1440)`, and `normalize_to_luma` raises *"Data must be a 2-D grid (got 4-D)"*. Even squeezed, it would write south-up, 0–360 frames. | 2 (zyra) | `NOAA-GSL/zyra` `processing/__init__.py`, `processing/grib_utils.py`, `visualization/cli_utils.py` | NetCDF input to `convert-format --format geotiff --var`: open with xarray, CF-decode (`scale_factor`, `_FillValue` → NaN), squeeze singleton dims, write north-up with nodata tagged. The rest of the existing chain then works unchanged. Issue body in Appendix A. **Blocking.** |
| **G2** | No `YYYYMM` placeholder. The S3 key has a month directory, and the grammar formats only `YYYYMMDD`, `HH`, ISO and compact instants. | TerraViz grammar | `src/types/zyra-pipeline-args.ts` (shared by the validator and the runner) | Add `{{cycle_month:INTERVAL:LAG}}` → `YYYYMM`. A look-back window then needs no negative offsets: frame *k* uses LAG `P{k}D`, and the cycle maths (`floor((now − LAG) / P1D)`) lands on day *k* before today. Small change with tests. Routes to the Zyra Workflow Author and the Code Reviewer. **Blocking.** |
| **G3** | No reserved no-data band: NaN shares code 0 with `vmin`. | 2 (zyra) | `luma_writer.normalize_to_luma`, `build_color_scale` | Write data into codes 1–255 and emit `dataMinLuma: 1`. Workaround in D4. **Not blocking.** |
| **G4** | Display transforms are not diverging-aware. The palette swap offers viridis, magma, turbo and grayscale, so an anomaly loses its zero. A contrast stretch can move zero off-centre. | 3 (client) | `src/services/colorScaleDisplay.ts`, `src/ui/colorbarUI.ts` | The "anomaly and difference display modes" follow-up in `DATA_ENCODED_VIDEO_PLAN.md`: offer a diverging palette, and keep a stretch symmetric about zero when the scale says it is diverging. **Not blocking.** |
| **G5** | No arithmetic. Rebaselining (D1 b) needs `sst − climatology`. | 2 (zyra) | No `process` command | The same upstream ask as unit rescaling (`capability-gaps.md`). Plus a hosted 1991–2020 day-of-year climatology, and a person's sign-off. **Only if D1 (b) is chosen.** |

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

## The target pipeline (after G1 and G2)

Not paste-ready: G1 and G2 don't exist yet, and the lists are shown
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
        - https://noaa-cdr-sea-surface-temp-optimum-interpolation-pds.s3.amazonaws.com/data/v2.1/avhrr/{{cycle_month:P1D:P92D}}/oisst-avhrr-v02r01.{{cycle_date:P1D:P92D}}_preliminary.nc   # G2
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
      cmap_inline: '{"type":"continuous","base":"RdBu_r","transparent_range":1,"blend_range":0,"overall_alpha":1.0}'
      vmin: -8                                    # D2: symmetric
      vmax: 8
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
  "abstract": "How much warmer (red) or cooler (blue) the ocean surface is than its average for the same day of the year, over the last 90 days. The average is for 1971-2000. Point at the ocean to read the anomaly in degrees Celsius. A broad warm band along the equatorial Pacific is the ocean signature of El Nino; a cool band there marks La Nina. From NOAA's daily Optimum Interpolation Sea Surface Temperature analysis (OISST v2.1), which blends satellite, ship and buoy measurements on a quarter-degree grid. The most recent two weeks are preliminary and may be revised. Updated daily. Current data range: {{data_start}} to {{data_end}}.",
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
3. **Hover against source**, three points, each within ±0.07 °C (one
   code plus rounding) of the same day's NetCDF:
   - mid Niño 3.4 (0°, 150°W);
   - a coastal Niño 1+2 cell;
   - a cold-side cell.
4. **Land reads no data**, not +0.00 °C (the D4 reproject trap). Check
   a coast, an inland lake, and Antarctica's edge.
5. **Orientation**: north up, the date line where it belongs, the
   Niño 1+2 warmth hugging South America and not Africa (0–360 → ±180
   wrap).
6. **Analyze → Niño 3.4 box** matches the area-weighted mean computed
   from the source within a code. This is the single best end-to-end
   check that values, geometry and weighting all survived.
7. Colorbar: on `main` it is drawn from `color_scale`
   (`src/ui/colorbarUI.ts`), so no `legend_ref` PNG is needed. The
   skill's §8 still says otherwise; that note predates the colorbar.
8. Set `playback_fps` on the row.

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
  decision with its date. If D1 (b) is ever taken, that same person
  signs off on the derived values.

## Phases

| Phase | What | Blocked on |
|---|---|---|
| 0 | This plan. Decide D1. File the G1 (and G3) zyra issues. | Approval to file; they are public |
| 1 | G2: `cycle_month` in `zyra-pipeline-args.ts`, with tests | Nothing |
| 2 | G1 lands in a zyra release → bump the pinned image digest in `.github/workflows/zyra-run.yml` → author the workflow as a disabled draft → smoke run → verification → reviews → enable | G1 upstream |
| 3 | G3: zyra emits `dataMinLuma` → re-run, remove the `transparent_range: 1` workaround | G3 upstream |
| 4 | *Optional.* Rebaseline to 1991–2020 | G5 upstream, and a person's sign-off |
| — | Diverging-aware display transforms (G4) | Its own plan item |

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

## Appendix A — upstream zyra issue body (G1), not filed

> **convert-format: accept NetCDF input for `--format geotiff --var`**
>
> *Use case:* a data-encoded daily SST anomaly globe from NOAA OISST
> v2.1 on NODD
> (`s3://noaa-cdr-sea-surface-temp-optimum-interpolation-pds/data/v2.1/avhrr/YYYYMM/oisst-avhrr-v02r01.YYYYMMDD_preliminary.nc`).
> The files are CF NetCDF4: `anom(time=1, zlev=1, lat=720, lon=1440)`,
> `int16`, `scale_factor 0.01`, `_FillValue -999`, latitude south to
> north, longitude 0–360.
>
> *What happens:* `cmd_convert_format` passes every input to
> `grib_decode`. cfgrib fails, pygrib finds no messages, and the stage
> exits with "no GRIB messages found in input". `--format netcdf`
> passes the bytes through. But `visualize heatmap --data-encoded --var
> anom` reads `ds[var].values` unsqueezed, and `normalize_to_luma`
> raises "Data must be a 2-D grid for luma output (got 4-D)".
>
> *Ask:* when the input bytes are NetCDF and the target is GeoTIFF,
> open with xarray instead of `grib_decode`. Apply CF decoding (scale,
> offset, fill → NaN), select `--var`, squeeze singleton dims (refuse
> if more than two remain), and write a north-up GeoTIFF with nodata
> tagged. `process reproject` and `heatmap` downstream then work
> unchanged. A squeeze in `cli_utils.load_data_array` would help the
> direct `.nc` → heatmap path too.
>
> *Related (G3):* `luma_writer.normalize_to_luma` maps NaN to code 0,
> which is also `vmin`. For a diverging field such as an anomaly, that
> makes land read as the coldest value. TerraViz's sidecar already
> supports `dataMinLuma`, a reserved low band. Writing data into codes
> 1–255 and emitting `dataMinLuma: 1` would close it.
>
> *Workaround in use:* none for G1. For G3, a one-code
> `transparent_range`, which costs anomalies at the very bottom of the
> range.

## Appendix B — how the numbers were made

- **Listings:** S3 `ListObjectsV2` on
  `data/v2.1/avhrr/2026{09,10,11}/`, without credentials.
- **Field statistics:** the 2026-10-25…31 and 2026-11-04 preliminary
  files, read with `netCDF4`, ocean cells only. Regional means are
  cos(latitude)-weighted.
- **Baseline offset:** `sst − ltm(day 307)` from PSL's
  `sst.day.mean.ltm.1991-2020.nc` (byte-range reads), compared
  cell-by-cell with the same day's `anom`.
- **PSL equivalence:** PSL's `sst.day.anom.2026.nc` for 2026-11-04
  minus NCEI's `anom`: zero everywhere.
- **CPC reference:** `wksst9120.for`, week of 28 Oct 2026.
- **zyra behaviour:** read from `NOAA-GSL/zyra` `main` at `70cb06b`
  (16 Oct 2026). The runner pins
  `ghcr.io/noaa-gsl/zyra@sha256:0f335b9d…`, so re-check G1 against the
  pinned image's version before filing.
