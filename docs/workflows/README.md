# Zyra workflow definitions

Status: reference copies, not a deploy artifact.

Zyra workflows live in the node's D1, authored through the publisher
portal at `/publish/workflows`. Nothing in this directory is read at
build or run time. The files here are **reviewable copies** of pipelines
that are hard to reconstruct from the portal alone — long templated URL
lists, calibration constants, and the reasoning behind both — so a
change to a live workflow can be diffed, discussed and reverted like any
other change.

To apply one: open the workflow in the portal, paste the
`*.pipeline.yaml` into the pipeline field (the form converts YAML → JSON
client-side), paste the matching `*.metadata.json` into the metadata
template field, and **Validate** before saving. Validation there runs the
same `validatePipeline` / `validateMetadataTemplate` these files were
checked against.

---

## Status

**Ready to run; not yet run.** All six pipelines validate, and every
input URL, `.idx` sidecar and record pattern was verified against the
live operational bucket at the *current* cycle on 2026-08-14 — details in
[Verification](#verification). What has not happened is an end-to-end run
against a real runner.

| File | Dataset | Frames | Refresh |
|---|---|---|---|
| `rrfs-smoke-column-north-america.*` | `north-america-smoke` — "Wildfire Smoke Overhead" | 85 × PT1H | 4×/day |
| `rrfs-smoke-near-surface-north-america.*` | `rrfs-smoke-near-surface-north-america` — "RRFS Smoke — Near-Surface, North America" | 85 × PT1H | 4×/day |
| `rrfs-smoke-column-conus.*` | `wildfire-smoke-forecast-transparent-united-states-rrfs` — "Wildfire Smoke Forecast (Transparent) — United States (RRFS)" | 85 × PT1H | 4×/day |
| `rrfs-smoke-near-surface-conus.*` | **new** — "RRFS Smoke — Near-Surface, United States" | 85 × PT1H | 4×/day |
| `rrfs-wildfire-potential-conus.*` | `wildfire-potential-hourly-forecast-united-states-rrfs` — "Wildfire Potential — Hourly Forecast, United States (RRFS)" | 85 × PT1H | 4×/day |
| `rrfs-radar-reflectivity-conus.*` | **new** — see [Radar reflectivity](#radar-reflectivity-conus-15-minute) | 72 × PT15M | hourly |

Four attach to dataset rows that already exist. The two marked **new**
need rows created in the portal first.

The four smoke pipelines form two matched pairs — whole-column and
near-surface, on the NA and CONUS domains — so any domain can be read
against the other quantity, and any quantity against the other domain.

---

## Source: `noaa-rrfs-ops-pds`

All six read the operational NODD bucket:

```
https://noaa-rrfs-ops-pds.s3.amazonaws.com/rrfs.YYYYMMDD/CC/rrfs.tCCz.<product>.f<FFF>.<domain>.grib2
```

Date prefixes sit at the bucket root — there is no `rrfs_public/`-style
wrapper. Every object has an `.idx` sidecar (922/922 on a synoptic
cycle), which is what makes single-record extraction possible.

### How this got here

Worth one paragraph, because two earlier answers were wrong and the
wrong ones are the plausible-looking ones.

RRFS moved from the pre-operational RRFS-A stream to operational
**RRFS v1.0**. The three published smoke rows were fed from RRFS-A paths
on `noaa-rrfs-pds`, which per
[SCN 26-48](https://www.weather.gov/media/notification/pdf_2026/scn26-048_RRFS_and_REFS_Implementation.aab.pdf)
carried the **prototype** feed and stopped updating on 2026-08-11 —
a retirement, not the outage it first looked like. NOMADS carries the
same v1.0 product but publishes no `.idx`, and
[zyra cannot select a record without one](#why-not-nomads). The
operational bucket above resolves both problems, and does it better than
the prototype mirror did: it carries the 13 km NA product **hourly**
where the mirror only carried it 3-hourly, so the NA datasets keep the
85 frames and `PT1H` period of the rows they replace.

### What changed versus RRFS-A

```
                    RRFS-A (old)                RRFS v1.0 (new)
bucket              noaa-rrfs-pds (retired)     noaa-rrfs-ops-pds
key prefix          rrfs_a/rrfs.DATE/CC/        rrfs.DATE/CC/
NA domain product   2dfld.3km.fNNN.na.grib2     2dfld.13km.fNNN.na.grib2
NA resolution       3 km   (4881 x 2961)        13 km  (1127 x 683)
NA cadence          hourly, f000..f084 (85)     hourly, f000..f084 (85)
CONUS product       2dfld.3km.fNNN.conus.grib2  unchanged
CONUS resolution    3 km   (1799 x 1059)        unchanged
CONUS cadence       hourly, f000..f084 (85)     unchanged
full-length cycles  every hour                  00/06/12/18z only
GRIB2 records       COLMD / MASSDEN             unchanged
domain extents      —                           unchanged
```

**The North America domain was not retired.** It survives at 13 km on
the same rotated lat/lon grid as the 3 km domain it replaces — identical
geographic extent, one quarter the linear resolution. So `dst_bounds`,
the dataset bounding boxes and the frame geometry all carry over
untouched.

The **record patterns are unchanged**, which is why this ended up a
path-and-cadence edit rather than a rewrite:

- column smoke — `COLMD:entire atmosphere.*Particulate organic matter dry` (kg m⁻²)
- near-surface smoke — `MASSDEN:8 m above ground.*Particulate organic matter dry` (kg m⁻³)
- reflectivity — `REFC:entire atmosphere.*` plus an explicit minute
- wildfire potential — `(WFIREPOT|parmcat=4 parm=26):surface` (unitless index)

The single real loss is **NA resolution, 3 km → 13 km**. That is a NOAA
product decision — v1.0 distributes 3 km only as the CONUS/AK/HI/PR
subsets — not something a pipeline can recover.

### Cycle structure (three different answers, all load-bearing)

RRFS v1.0 does not publish everything on the same schedule, and the
six pipelines land in three different buckets of that schedule:

| Product | Cycles it runs on | Forecast length |
|---|---|---|
| `2dfld.13km.…na` | **00/06/12/18z only** | 84 h, hourly (85 frames) |
| `2dfld.3km.…conus` (hourly) | **3-hourly** — 00/03/06/09/12/15/18/21z | 84 h at synoptic; f018 at 03/09/15/21z |
| `2dfld.3km.subh.…conus` | **all 24 cycle hours** | f001..f018 |

Consequences:

- The four smoke datasets and wildfire potential need `PT6H`, so they
  refresh **4× a day** with the same 84-hour outlook as before.
- The radar dataset reads only `subh`, so it can refresh **hourly**.
- The radar dataset **cannot include a t+0 analysis frame**: that instant
  lives only in the hourly product, which is missing two hours out of
  every three. Verified across all 24 cycles of 2026-08-13 —
  `2dfld.3km.f000.conus.grib2` is present at 8 and 404s at the other 16.

**Sub-hourly is not an option for smoke.** `subh` carries **no aerosol
records at all** — its 156 records are precipitation, reflectivity and
surface weather (`APCP`, `REFC`, `VIL`, `GUST`, `VIS`, `TMP`, …), with no
`MASSDEN`, `COLMD` or `AOTK`. RRFS writes chemistry output on an hourly
cadence regardless of the dynamics sub-steps.

### Lag

`PT5H` for the five hourly-product pipelines, `PT4H` for radar. Measured real-time
envelopes on 2026-08-14:

| | first object | last object |
|---|---|---|
| Synoptic cycle, whole run | +1.27 h | +3.59 h |
| `subh` CONUS, synoptic cycles | +1.37 h | +2.37 h |
| `subh` CONUS, off-synoptic | +1.32 h | +2.15 h |

<a name="why-not-nomads"></a>

### Why not NOMADS

NOMADS carries the same v1.0 product and is the tree the layout change
was mapped from, so this deserves an answer rather than an assertion.

`convert-format --pattern` extracts one GRIB2 record by range-GETting
the bytes an `.idx` sidecar points at. NOMADS publishes no `.idx` —
absent under four naming variants — has no GRIB-filter service for RRFS
(not among the 74 wired `gribfilter.php` datasets; `?ds=rrfs` renders
site chrome with no form), and serves 154 MB (NA) / 360 MB (CONUS) per
forecast hour. It honours HTTP Range, but with no index there is no byte
range to ask for.

And zyra has no fallback. Read out of **v0.1.52**, the version behind
the runner digest in `.github/workflows/zyra-run.yml`:

- `zyra/utils/io_utils.py::read_bytes_any` reaches the whole-file read
  (`fetch_bytes`) **only** when `idx_pattern` is falsy. With a pattern
  set it calls `get_idx_lines`, which `raise_for_status()`es inside
  `with_retries(max_attempts=3)`; the 404 is raised, rewrapped as
  `RuntimeError`, and `cmd_convert_format` returns 2. The stage fails.
- The `--var` alternative *does* download the whole file, but matches a
  regex against cfgrib `data_vars` or pygrib `shortName`/`name` — and
  every field these pipelines need reports `shortName = name = unknown`,
  `paramId = 0`: `REFC`, all five `MASSDEN` records, all four `COLMD`
  records. That is specific to these fields rather than to the file (21
  of 27 sampled records name cleanly). They collide on one string, so no
  regex separates organic-matter `COLMD` from dust `COLMD`. Worse,
  `extract_variable` returns `matches[0]`, so an ambiguous selection
  yields a plausible GeoTIFF of the **wrong field** rather than an error.
- `wgrib2` ships in the image and its `-match` reads the inventory line,
  which does carry the discriminating text — but the only path using it
  is `extract-variable`, gated on `--stdout` with netcdf/grib2 output
  rather than geotiff, single-input, and reading through `read_bytes_any`
  first, so a URL dies on the missing `.idx` before wgrib2 runs.

So the discriminating information lives only in the `.idx`/inventory
line. Re-scoping to fewer frames from NOMADS would not help — the
blocker is naming, not volume.

> That gap is real beyond this migration: any origin serving GRIB2
> without a sidecar strands a pipeline the same way. An issue is drafted
> at [`UPSTREAM_ZYRA_ISSUE_DRAFT.md`](UPSTREAM_ZYRA_ISSUE_DRAFT.md) and
> **not filed**. The operational bucket removes the urgency, so filing is
> now a judgement call rather than a blocker.

---

## The rotated NA grid needs `s_srs` and inverted `bounds`

If a run logs this, it is **not cosmetic**:

```
rasterio/__init__.py: NotGeoreferencedWarning: The given matrix is equal to
Affine.identity or its flipped counterpart.
```

It means `convert-format` wrote a GeoTIFF with **no CRS and an identity
transform**, and for the NA pipelines the next stage then fails outright:

```
ReprojectError: source raster has no embedded CRS; pass --s-srs (and --bounds for plain images)
```

**Cause.** zyra's `_grib_georeference` (`processing/grib_utils.py`)
derives a CRS and transform from the GRIB metadata for exactly two grid
types — `regular_ll` and `lambert` — and returns `None` for anything
else. The NA 13 km product is **`rotated_ll`** (rotated pole at 35°N /
247°E), which nothing in zyra handles; there is no `rotated` anywhere in
the source. It falls through to a rioxarray path that writes no
georeferencing at all.

CONUS is `lambert`, so both CONUS pipelines take the supported path and
need none of this.

**Fix, entirely inside the pipeline.** The NA reproject stage carries:

```yaml
s_srs: '+proj=ob_tran +o_proj=longlat +o_lat_p=35 +o_lon_p=0 +lon_0=247
  +R=6371229 +to_meter=0.0174532925199433 +no_defs'
bounds: [-61.05415, 36.98445, 60.99995, -36.98445]
```

The projection string matches the GRIB exactly: southern pole
(−35.0, 247.0) → `o_lat_p=35`, `lon_0=247`, sphere `R=6371229`
(`shapeOfTheEarth=6`), `to_meter` converting the grid's degree units.

**`bounds` has north and south deliberately swapped.** The GRIB scans
south-first (`jScansPositively=1`). The *georeferenced* path in
`convert-format` normalizes that to north-up; the ungeoreferenced
fallback this grid takes does **not**, so the array arrives upside down
and `bounds` is the only lever left. Passing north in the `south` slot
makes rasterio's `from_bounds` emit a positive y-step transform, which
un-mirrors it. The edges are grid-point centres ± d/2 with d = 0.1083°
— note these are the **13 km** grid's own extent, not the retired 3 km
grid's `±61.0125 / ±37.0125`.

**Verified against the GRIB's own `latitudes`/`longitudes` arrays**, by
reprojecting a real record and comparing:

| | argmax offset | corr(source, reprojected) | control¹ |
|---|---|---|---|
| NA 13 km smoke, normal `bounds` | **2708 km** | — | — |
| NA 13 km smoke, swapped `bounds` | 1.6 km | 0.998 | 0.923 |
| CONUS 3 km smoke (lambert) | 1.2 km | — | — |
| CONUS `subh` REFC (lambert) | 99.7 km² | 0.979 | 0.572 |

¹ correlation if the source is deliberately sampled 0.5° off — the
number a genuinely misregistered raster would score.
² argmax instability, not misregistration: reflectivity is spiky with
many near-ties, so the single hottest pixel moves under resampling. The
correlation is the trustworthy metric here.

> The same trap applies to the retired 3 km NA grid, which also scanned
> south-first. A reproject stage using `bounds: [-61.0125, -37.0125,
> 61.0125, 37.0125]` in normal order puts that grid's maximum **1123 km**
> from truth under zyra v0.1.52 — worth checking against any older NA
> workflow still in the node, since a vertical mirror in rotated space is
> subtle enough to survive a glance at a thumbnail.

`dst_nodata: 'nan'` is set on all six so the area outside a model's
footprint reads as *absent* rather than as a measured zero — it is
quoted so it survives YAML → JSON as a string and reaches argparse's
`type=float` as `nan` (an unquoted YAML `nan` risks becoming JSON
`null`).

### The dataset bbox comes from `dst_bounds`, never from `bounds`

The portal's Geography card takes four numbers (N / S / W / E, all
required together, `n >= s`). They describe **where the published frames
sit on the globe**, which is the reprojection *target*:

| Dataset | `dst_bounds` (W, S, E, N) | Portal bbox |
|---|---|---|
| Both NA smoke rows | `[-175, 5, -20, 85]` | **N 85, S 5, W −175, E −20** |
| Both CONUS smoke rows, wildfire potential, CONUS radar | `[-135, 21, -60, 53]` | **N 53, S 21, W −135, E −60** |

All four existing rows already carry exactly these, so nothing needs
changing there — only the two new rows need the CONUS box entered.

**Do not put `bounds` in the bbox fields.** `bounds` is the *source*
grid's extent in the rotated-pole CRS's own degree units, and its north
and south are deliberately inverted. Read as geography, `[-61.05415,
36.98445, 60.99995, -36.98445]` would place a North America dataset
across the Atlantic and equatorial Africa, and would fail the `n >= s`
check on the way in. The two arguments are unrelated coordinate systems
that happen to share a unit name.

---

## `categories` cannot go in a metadata template

If a run reaches the publish step and dies with:

```
[zyra-run] FAIL: dataset PATCH → 400 http_error
```

…and the template sets `categories`, that is why. (`http_error` is the
CLI's fallback when the envelope carries no top-level `error` code — the
real per-field reason is in a `details` array it does not print, so the
message is unhelpfully generic.)

Two validators disagree about the shape, and no value satisfies both:

| | Accepts | Source |
|---|---|---|
| `validateMetadataTemplate` (saving the workflow) | strings and **string arrays** only | `workflow-validators.ts` |
| `validateDraftUpdate` (the dataset PATCH) | `categories` must be **an object** of facet→values; arrays are `invalid_type` | `validators.ts:601` |

So a flat `["Atmosphere", "Air Quality"]` saves fine and then 400s at
publish, and the correct `{"Atmosphere": ["Air Quality"]}` is rejected
when the workflow is saved. `categories` is in
`METADATA_TEMPLATE_ALLOWED_FIELDS`, but it is **not usable there**.

**These templates therefore omit `categories` entirely.** That is not
just a workaround — it is also the safer behaviour: the PATCH only
touches categories `if (body.categories !== undefined)`, so omitting the
field leaves whatever the dataset row already has intact instead of
deleting and rewriting it on every run. Set categories once on the row
in the portal, where the form can send the object shape.

The house convention, for when you do: the **key is the theme and the
values are sub-topics** — `{"Atmosphere": ["Air Quality", "Wildfire
Smoke"]}`. The SPA renders `Object.keys(categories)` on browse cards, so
the key is what a user sees.

> Worth fixing upstream in this repo: either drop `categories` from
> `METADATA_TEMPLATE_ALLOWED_FIELDS`, or teach the template validator to
> accept an object for that one field. Leaving both as they are means the
> field advertises support it does not have, and fails late — after a
> full pipeline run — with a message that names no field.

For the record, the colour scale is **not** implicated: the sidecar these
pipelines emit is ~9.9–11.7 k chars against a `COLOR_SCALE_MAX_CHARS` of
16,384.

---

## Schedule (and why enable-time matters)

The portal's **Schedule** field is an ISO-8601 *duration*, not a cron
expression — an interval between runs, bounded to PT15M–P90D.

| Workflow | Schedule | Runs/day |
|---|---|---|
| `rrfs-smoke-column-north-america` | `PT6H` | 4 |
| `rrfs-smoke-near-surface-north-america` | `PT6H` | 4 |
| `rrfs-smoke-column-conus` | `PT6H` | 4 |
| `rrfs-smoke-near-surface-conus` | `PT6H` | 4 |
| `rrfs-wildfire-potential-conus` | `PT6H` | 4 |
| `rrfs-radar-reflectivity-conus` | `PT1H` | 24 |

Each matches its pipeline's cycle interval, so every run picks up a
cycle the previous run did not — no repeated work, nothing skipped.

### The `PT6H` ones must be enabled in the right half-hour

There is no wall-clock anchor. `computeNextRunAt` sets the first due
time to **now + interval** when you enable the workflow, and
`advanceNextRunAt` then advances by whole periods from the stored due
time — deliberately, so dispatch jitter stays per-run instead of
ratcheting the phase around the clock. The consequence: **whatever
moment you enable a `PT6H` workflow becomes its phase, permanently.**

Those pipelines use `PT6H` cycles with a `PT5H` lag, so
`{{cycle_date}}`/`{{cycle_hour}}` flip to a newly-available cycle at:

```
05:00   11:00   17:00   23:00   UTC
```

The first scheduled run happens one full interval after you enable, so
to land runs just after each flip, **enable during 05:00–05:30,
11:00–11:30, 17:00–17:30 or 23:00–23:30 UTC**. Every later run inherits
that offset.

Enable at, say, 04:00 UTC instead and the runs sit at 10:00 / 16:00 /
22:00 / 04:00 — each an hour *before* the flip, so each one fetches the
cycle before the one it could have had, forever. Not broken; the data is
just up to six hours staler than necessary. The fix is to disable and
re-enable inside one of the windows above.

Use **Run now** for an immediate first publish rather than waiting out
the first interval.

`PT1H` on the radar workflow needs none of this care — its cycle
interval is also an hour, so a new cycle is available at every flip and
the phase cannot be wrong. If you would rather not time the enable on
the smoke workflows, `PT1H` works there too and is always within an hour
of the flip, but five runs in six then re-fetch, re-render and re-upload
85 frames that did not change. Not recommended.

---

## Calibration

`vmin`/`vmax` for the smoke rows are **unchanged** from the published
datasets, so hover values and legends stay comparable across the
migration. Sampled 2026-08-13 from `rrfs.20260811/18` f024:

| Field | p99.9 | p99.99 | max | shipped `vmax` |
|---|---|---|---|---|
| NA 13 km column smoke (kg m⁻²) | 1.11e-4 | 2.82e-4 | 1.74e-3 | 5e-4 |
| NA 13 km near-surface smoke (kg m⁻³) | 4.18e-8 | 1.27e-7 | 3.54e-6 | 2e-7 |
| CONUS 3 km column smoke (kg m⁻²) | 2.17e-4 | 6.19e-4 | 2.26e-3 | 5e-4 |
| CONUS 3 km near-surface smoke (kg m⁻³) | 1.63e-8 | 1.12e-7 | 9.88e-7 | 2e-7 |

Each pair shares a `vmax` deliberately — both column rows at 5e-4, both
near-surface rows at 2e-7. Two datasets showing the same quantity on
adjacent domains have to share a scale, or hovering one and then the
other reports numbers that cannot be compared. The column CONUS figure
sits between p99.9 and p99.99, which is where the data-encoded
contract wants it. The two NA figures sit above p99.99 — the NA domain
averages in a lot of clean ocean, which drags its percentiles below the
CONUS ones for the same field. Lowering NA `vmax` toward ~3e-4 would
brighten faint plumes, at the cost of clipping the densest cores and of
no longer matching the CONUS row's scale.

**Wildfire potential is the one exception.** Its published row carries
`vmax = 120`, and the field does not come close: measured across four
forecast hours of `rrfs.20260814/12`, the maximum runs 27–45 with p99.99
at 21–23. 120 pushes everything real into the bottom quarter of the
ramp — the dark-globe symptom. That pipeline therefore ships **`vmax =
50`**, clearing the largest observed value with headroom while keeping
the high end distinguishable rather than clipped. Unlike the smoke rows,
where the published value was generous but defensible, this one is
simply wrong; reverting is a one-line change if continuity matters more.

Frame geometry is unchanged from the published rows: **4030 × 2080** for
NA (26 px/deg over `[-175, 5, -20, 85]`) and **2250 × 960** for CONUS
(30 px/deg over `[-135, 21, -60, 53]`). The NA frames now oversample
their 13 km source ~3×; 1240 × 640 would match native resolution if
lighter frames are ever wanted.

---

## Radar reflectivity, CONUS, 15-minute

A **new** dataset, added because mapping the v1.0 inventory turned up the
sub-hourly product — the one place RRFS publishes faster than hourly.

| | |
|---|---|
| Source | `2dfld.3km.subh.fNNN.conus.grib2`, f001..f018 |
| Field | `REFC` — composite reflectivity, entire atmosphere, dBZ |
| Frames | 72 at 15-minute spacing, t+15m → t+18 h |
| Cycles | **every hour** |
| Geometry | 2250 × 960 over `[-135, 21, -60, 53]` — identical to the CONUS smoke row, so the two overlay exactly |

### Why four `convert-format` stages

Each `subh.fNNN` holds **four** REFC records — the three 15-minute
sub-steps plus the on-the-hour instant — so f001..f018 alone yields all
72 frames with no second pass over the 4× larger hourly files.
`pattern` selects one record per file and is a single stage-level
argument, so each slot needs its own stage. The sub-step times are
absolute minutes from cycle time (`subh.f006` holds 315/330/345, not
15/30/45), so each pattern lists its 18 possible values explicitly.

### Why `vmin` is 5 dBZ and `vmax` is 75

`vmin` is not a cosmetic floor on this path. `lumaToValue` anchors the
visible ramp at `dataMinLuma` (`= ceil(transparentRange × 255)`), so
everything below `vmin` lands in the transparent band and reads as
*absent* rather than as a measured value. That is exactly what the field
wants: its floor is a flat **−20 dBZ fill covering more than half the
domain** (the median of the whole grid is −20). `vmin: 5` makes "no echo"
mean "below the first detectable echo".

`vmax: 75` deliberately departs from the contract's usual
`vmax ≈ p99.9`. Measured 2026-08-13 on `rrfs.20260811/18`:

| | min | p99.9 | p99.99 | max |
|---|---|---|---|---|
| subh f006 (315 min) | −20.0 | 55.8 | 63.4 | 66.6 |
| subh f012 (705 min) | −20.0 | 46.7 | 60.6 | 67.4 |

dBZ is a standard scale with conventional breakpoints — 20 light, 35
moderate, 45 heavy, 50+ hail — and clipping at ~56 would flatten
precisely the severe cores the dataset exists to show. 75 dBZ across 243
visible codes still quantises at 0.29 dBZ, finer than the 0.5 dBZ steps
operational radar products typically ship.

The palette is `turbo` rather than one of the light-starting maps the
aerosol rows use. It runs dark blue → cyan → green → yellow → red, the
ordering radar users read fluently; faint echo being dim against the dark
globe is the intended reading rather than a defect.

Set `playback_fps` on the row — 72 frames at the default 30 fps plays in
about 2.4 s. Around 8 fps gives a ~9 s loop.

A full run moves ~80 MB: one REFC record is ~1.1 MB through an `.idx`
range-GET, against 360 MB for the file that contains it.

AK publishes a `subh` product too, if a second domain is ever wanted;
HI and PR publish theirs at 2.5 km.

---

## Verification

Each pipeline was checked with the recipe in
`.claude/skills/terraviz-data-video/references/verification.md`.

Static, all six:

- `validatePipeline` + `validateMetadataTemplate` — OK
- the rendered metadata sidecar plus `render_encoding` and a real
  256-stop `color_scale`, run through `validateDraftUpdate` — no 400
- placeholder interpolation — no unresolved `{{` left
- `materializeInlinePalettes` — palette materializes, `data_encoded: true`,
  `color_scale_file` present, no `width`/`height`/`basemap` on the heatmap stage

Live, against `noaa-rrfs-ops-pds` at the **current** cycle
(2026-08-14 17:16Z → `rrfs.20260814/12z` for the smoke pipelines,
`/13z` for radar):

| Pipeline | Files | Frames | Unreachable | `.idx` | Pattern checks not matching exactly one | Frame spacing |
|---|---|---|---|---|---|---|
| NA column smoke | 85 | 85 | 0 | 85/85 | 0 of 85 | one gap, 3600 s |
| NA near-surface smoke | 85 | 85 | 0 | 85/85 | 0 of 85 | one gap, 3600 s |
| CONUS column smoke | 85 | 85 | 0 | 85/85 | 0 of 85 | one gap, 3600 s |
| CONUS near-surface smoke | 85 | 85 | 0 | 85/85 | 0 of 85 | one gap, 3600 s |
| CONUS wildfire potential | 85 | 85 | 0 | 85/85 | 0 of 85 | one gap, 3600 s |
| CONUS radar 15-min | 18 | 72 | 0 | 18/18 | 0 of 72 | one gap, 900 s |

Frame names are unique in every case, and each series has exactly one
distinct inter-frame gap — so no duplicates and no holes.

**Not done: an end-to-end run.** The first run of each still wants a look
at the publish log for `render_encoding, color_scale` among the updated
fields.
