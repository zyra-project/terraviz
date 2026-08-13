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

## ⚠ Status: the RRFS pipelines are blocked on a data source

**Do not run these yet.** Their structure, record patterns, calibration
and geometry are verified, but every `inputs:` URL points at
`noaa-rrfs-pds`, and that bucket was **retired on 2026-08-11** — it is
not an outage, and no new files will ever land there. Its last object
anywhere is `2026-08-12T12:58Z`.

Per [SCN 26-48](https://www.weather.gov/media/notification/pdf_2026/scn26-048_RRFS_and_REFS_Implementation.aab.pdf),
`noaa-rrfs-pds` carried the RRFS/REFS **prototype** feed, which stopped
when the pre-implementation parallel phase began on 2026-08-11. RRFS v1.0
implements 2026-10-06. There is **no S3 successor**: ten candidate NODD
bucket names 404, there is no GCP mirror, and the AWS registry entry
still describes the retired prototype.

That leaves NOMADS as the only live source, and NOMADS cannot serve a
single GRIB2 record — see [below](#why-these-read-s3-and-not-the-nomads-path).
The efficient fetch every one of these pipelines is built on has no
source at present. Resolving that is a decision about scope and about
what NCEP will publish, not an edit to these files — the open options
are in [What to do about it](#what-to-do-about-it).

---

## The RRFS v1.0 migration (2026-08-13)

RRFS moved from the pre-operational RRFS-A stream to operational
**RRFS v1.0**. The three published smoke datasets were all fed from
RRFS-A paths, so all three pipelines needed revising.

| File | Replaces the pipeline behind |
|---|---|
| `rrfs-smoke-column-north-america.*` | `north-america-smoke` — "Wildfire Smoke Overhead" |
| `rrfs-smoke-near-surface-north-america.*` | `rrfs-smoke-near-surface-north-america` — "RRFS Smoke — Near-Surface, North America" |
| `rrfs-smoke-column-conus.*` | `wildfire-smoke-forecast-transparent-united-states-rrfs` — "Wildfire Smoke Forecast (Transparent) — United States (RRFS)" |

`rrfs-radar-reflectivity-conus.*` is a **new** dataset rather than a
revision — see [Radar reflectivity](#radar-reflectivity-conus-15-minute)
below. It needs a dataset row created in the portal first; the other
three attach to rows that already exist.

### What actually changed

```
                    RRFS-A (old)                RRFS v1.0 (new)
S3 prefix           rrfs_a/                     rrfs_public/
NOMADS path         (not carried)               /pub/data/nccf/com/rrfs/v1.0/
NA domain product   2dfld.3km.fNNN.na.grib2     2dfld.13km.fNNN.na.grib2
NA resolution       3 km   (4881 x 2961)        13 km  (1127 x 683)
NA cadence          hourly, f000..f084 (85)     3-hourly, f000..f084 (29)
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
untouched; only the source path and the frame cadence move.

The **record patterns are unchanged**, which is the reason this is a
path-and-cadence edit rather than a rewrite:

- column smoke — `COLMD:entire atmosphere.*Particulate organic matter dry` (kg m⁻²)
- near-surface smoke — `MASSDEN:8 m above ground.*Particulate organic matter dry` (kg m⁻³)

Both still match exactly one record per file, verified with
`sample_grib_range.py`.

### Two changes worth knowing about

**Off-synoptic cycles are short now.** RRFS v1.0 runs its full 84-hour
forecast on 00/06/12/18z only; the intermediate hours run to f018 and
carry no North America domain at all. Every one of these pipelines
therefore uses a `PT6H` cycle interval. For the two NA datasets that is
no change in refresh rate (they gain frames per run, not runs per day).
For the CONUS dataset it is a real change: **it refreshes 4× a day
rather than hourly**, with the same 84-hour outlook and the same 85
hourly frames as before.

**Sub-hourly is not an option for smoke.** CONUS (and AK) also publish
a `2dfld.3km.subh.fNNN.<domain>.grib2` product covering f001–f018, which
holds the 15-minute sub-steps leading up to each forecast hour —
`subh.f006` carries 315/330/345 min, with the 360-minute instant in the
hourly `f006`. Union'd with the hourly files that would give 15-minute
resolution through the first 18 hours. But `subh` carries **no aerosol
records at all** — its 156 records are precipitation, reflectivity and
surface weather (`APCP`, `REFC`, `VIL`, `GUST`, `VIS`, `TMP`, …), with
no `MASSDEN`, `COLMD` or `AOTK`. RRFS writes chemistry output on an
hourly cadence regardless of the dynamics sub-steps, so the hourly
product is the only source for smoke; `subh` is the right file for a
15-minute radar or precipitation dataset.

**The NA datasets drop from 85 frames to 29.** The 13 km NA product is
published 3-hourly, so `period` moves `PT1H` → `PT3H` and the frame
count moves 85 → 29 across the same 84-hour outlook. If you set
`playback_fps` on those rows, retune it — 29 frames at the old value
plays roughly a third as long.

### Why these read S3 and not the NOMADS path

The obvious question, since NOMADS is where the v1.0 layout change is
announced and is where it was mapped from. **It is the same data** —
NODD mirrors NCEP's v1.0 product to `noaa-rrfs-pds/rrfs_public/` under
identical filenames. What differs is not the content but what each
endpoint lets you *ask for*.

`convert-format --pattern` extracts one GRIB2 record by range-GETting
the bytes an `.idx` sidecar points at. Measured against NOMADS on
2026-08-13:

| | NOMADS | NODD S3 |
|---|---|---|
| `.idx` sidecar | **absent** — `.idx`, `.inv`, `.index` and a bare `.idx` on the stem all 404/403 | present next to every GRIB2 |
| GRIB filter service | **none for RRFS** — not among the 74 wired `gribfilter.php` datasets; `?ds=rrfs` renders site chrome with no form and no `filter_*.pl` (compare `hrrr_2d` → `filter_hrrr_2d.pl`) | n/a |
| HTTP Range | honoured (`206`, `Accept-Ranges: bytes`) — but with no index there is no byte range to ask for | honoured, and the `.idx` says which |
| Cost of one record | the whole file: **154 MB** (NA 13 km), 360 MB (CONUS 3 km) | **~0.4–1.2 MB** |

So on NOMADS there is no mechanism to fetch a single field. Pulling
whole files instead would be ~4.5 GB per NA run and ~30 GB per CONUS
run — past the runner's disk in the CONUS case, and squarely the bulk
pattern NOMADS asks users to take to NODD instead. (Whether zyra falls
back to a whole-file download when no `.idx` is present, or simply
errors, is not something this migration verified — but neither outcome
is usable at that size.)

S3 is also the source the published rows already credit ("distributed
via NOAA Open Data Dissemination on AWS"), so it keeps the attribution
honest.

The one cost is freshness. The mirror normally lands a cycle 1.3–3.9 h
after cycle time (measured across four cycles), which is what the `PT5H`
lag in these pipelines is sized against.

> **This reasoning is now stranded.** It explains why S3 was the right
> source while `noaa-rrfs-pds` was alive. It is retired, so the trade it
> describes no longer has a side to land on: the endpoint that can serve
> one record does not receive data, and the endpoint that receives data
> cannot serve one record. Kept because it is the constraint any
> replacement source has to satisfy.

### What the retirement actually said

From [SCN 26-48](https://www.weather.gov/media/notification/pdf_2026/scn26-048_RRFS_and_REFS_Implementation.aab.pdf)
(NWS Headquarters, 2026-07-06) and the AWS registry entry:

- `noaa-rrfs-pds` carried the **prototype** RRFS/REFS feed. It stopped
  updating when the pre-implementation parallel phase began
  **2026-08-11**. Observed last write: `2026-08-12T12:58Z`.
- Pre-implementation data lives on NOMADS at
  `/pub/data/nccf/com/rrfs/para/`. The `/rrfs/v1.0/` path serves the
  **same files** (verified identical size, mtime and leading bytes).
- **Production implementation is 2026-10-06**, at which point the SCN
  names `/pub/data/nccf/com/rrfs/prod/` as the location.
  `/rrfs/prod/` is currently empty.
- The SCN's file list confirms `rrfs.tCCz.2dfld.13km.fFFF.na.grib2` is a
  standard product, and confirms 84 h at 00/06/12/18z with 18 h at the
  other hourly cycles — matching what this migration measured
  independently. The 3 km output is distributed only as the CONUS/AK/HI/PR
  subsets, which is why the NA domain is 13 km.
- The SCN names no AWS/NODD distribution at all.

> **Path stability is an open question.** These files currently use
> `/rrfs/v1.0/`, which works today and reads like the versioned
> production path. But the SCN names `para/` for now and `prod/` from
> October 6. Whichever source question gets resolved, the path wants
> confirming with NCEP dataflow rather than inferring — it is a
> one-line change but a silent breakage if missed.

### What was ruled out

| Candidate | Result |
|---|---|
| A successor NODD bucket | 10 name variants probed, all 404 |
| GCP / Azure mirror | `gs://rrfs-pds`, `gs://noaa-rrfs-pds` 404; Azure unreachable from here, unconfirmed |
| NOMADS `.idx` | absent under 4 naming variants |
| NOMADS GRIB filter | RRFS not among the 74 wired `gribfilter.php` datasets |
| NOMADS NOAAPORT feed (`/com/para/noaaport/rrfs/`) | carries a 3 km NA product, but **147 MB** per file and no index — no better |
| Smaller product carrying the same fields | `prslev` is larger (675 records) and has no aerosol records at all |

### What to do about it

Roughly in order of leverage. None of these is an edit to these files,
which is why the PR stops here rather than guessing.

1. **Ask NCEP whether v1.0 will be published to NODD, and whether
   NOMADS can carry `.idx` sidecars.** One answer restores the whole
   design unchanged. SCN contacts: `ncep.pmb.dataflow@noaa.gov` (NWS
   Central Operations dataflow) and `rrfs.feedback@noaa.gov`.
2. **Establish what zyra does when no `.idx` exists** — whether
   `convert-format --pattern` errors, downloads the whole file, or
   streams and stops at the matching record. This migration did not
   verify it, and the three outcomes have very different consequences.
   Worth knowing: the smoke records sit early in the file (`MASSDEN` is
   record 83 of 318, ~32 MB in; `COLMD` is 148, ~51 MB in), so a
   stream-and-stop reader would need a fifth to a third of each file
   rather than all of it.
3. **Re-scope to whatever NOMADS can honestly sustain**, if whole-file
   fetching is the only option. At 154 MB per NA forecast hour, a
   6-hourly NA set (15 frames) is ~2.3 GB per run; CONUS at 360 MB per
   hour does not fit a runner at any useful frame count. This is a real
   reduction in the datasets, not a transparent swap, and NOMADS asks
   bulk users to go to NODD precisely to avoid this pattern.
4. **Hold the published rows at their last good run until 2026-10-06**
   and revisit at implementation, when the production feed and its
   distribution are settled.

### Calibration

`vmin`/`vmax` are **unchanged** from the published rows, so hover values
and legends stay comparable with previous runs. Sampled 2026-08-13 from
`rrfs.20260811/18` f024 for reference, should anyone want to retune
deliberately:

| Field | p99.9 | p99.99 | max | shipped `vmax` |
|---|---|---|---|---|
| NA 13 km column smoke (kg m⁻²) | 1.11e-4 | 2.82e-4 | 1.74e-3 | 5e-4 |
| NA 13 km near-surface smoke (kg m⁻³) | 4.18e-8 | 1.27e-7 | 3.54e-6 | 2e-7 |
| CONUS 3 km column smoke (kg m⁻²) | 2.17e-4 | 6.19e-4 | 2.26e-3 | 5e-4 |

CONUS sits between p99.9 and p99.99, which is where the data-encoded
contract wants it. The two NA figures sit above p99.99 — the NA domain
averages in a lot of clean ocean, which drags its percentiles below the
CONUS ones for the same field. Lowering NA `vmax` toward ~3e-4 would
brighten faint plumes, at the cost of clipping the densest cores and of
no longer matching the CONUS row's scale.

---

## Radar reflectivity, CONUS, 15-minute

A **new** dataset, added alongside the migration because mapping the
v1.0 file inventory turned up the sub-hourly product and it is the one
place RRFS publishes something faster than hourly.

| | |
|---|---|
| Source | `2dfld.3km.subh.fNNN.conus.grib2` (+ the hourly `f000` for the analysis) |
| Field | `REFC` — composite reflectivity, entire atmosphere, dBZ |
| Frames | 73 at 15-minute spacing, t+0 → t+18 h |
| Cycles | **every hour** — subh is published at all 24 cycle hours |
| Geometry | 2250 × 960 over `[-135, 21, -60, 53]` — identical to the CONUS smoke row, so the two overlay exactly |

This is the only dataset here that refreshes hourly. The smoke rows are
tied to the four synoptic cycles because that is where the long forecast
lives; subh runs complete at every cycle hour, `+1.4–3.0 h` after cycle
time, so a `PT1H` interval with a `PT4H` lag is honest.

### Why five `convert-format` stages

Each `subh.fNNN` file holds **four** REFC records — the three 15-minute
sub-steps plus the on-the-hour instant. `pattern` selects one record per
file and is a single stage-level argument, so each slot needs its own
stage. The sub-step times are absolute minutes from cycle time
(`subh.f006` holds 315/330/345, not 15/30/45), so each pattern lists its
18 possible values explicitly rather than matching a suffix.

Verified against the real sidecars: 73 pattern/file checks, every one
matching exactly one record, and the four patterns partition a file's
four REFC records with no overlap and nothing left uncovered.

Only the analysis frame has to come from the hourly product — subh
starts at f001, so t+0 would otherwise be missing. It is also the most
trustworthy frame in the set, being the radar-assimilated initial state.

### Why `vmin` is 5 dBZ and `vmax` is 75

`vmin` is not a cosmetic floor on this path. `lumaToValue` anchors the
visible ramp at `dataMinLuma` (`= ceil(transparentRange × 255)`), so
everything below `vmin` lands in the transparent band and reads as
*absent* rather than as a measured value. That is exactly what the
field wants: its floor is a flat **−20 dBZ fill covering more than half
the domain** (the median of the whole grid is −20), and that fill should
disappear, not render as data. `vmin: 5` makes "no echo" mean "below the
first detectable echo".

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
ordering radar users read fluently; faint echo being dim against the
dark globe is the intended reading here rather than a defect.

Set `playback_fps` on the row — 73 frames at the default 30 fps plays in
about 2.4 s. Around 8 fps gives a ~9 s loop.

A full run moves ~80 MB: one REFC record is ~1.1 MB through an `.idx`
range-GET, against 360 MB for the file that contains it.

AK publishes a subh product too, if a second domain is ever wanted;
HI and PR publish theirs at 2.5 km.

---

## Verification

Each pipeline was checked with the recipe in
`.claude/skills/terraviz-data-video/references/verification.md`:

- `validatePipeline` + `validateMetadataTemplate` — OK for all four
- placeholder interpolation — no unresolved `{{` left
- `materializeInlinePalettes` — palette materializes, `data_encoded: true`,
  `color_scale_file` present, no `width`/`height`/`basemap` on the heatmap stage
- every rendered input URL **and** its `.idx` HEAD-checked against a
  complete cycle (`rrfs.20260811/18`) — 29/29, 85/85 and 19/19 resolve
- every record pattern confirmed to match **exactly one** GRIB2 record
  in every file it is pointed at — 73 pattern/file checks for the radar
  pipeline alone, plus its four patterns confirmed to partition each
  file's four REFC records with no overlap
- radar frame series confirmed unique and evenly spaced: 73 names, one
  distinct gap of 900 s, t+0 → t+18 h

Not yet done: an end-to-end run. None of these have been executed
against a live runner, so the first run of each still wants a look at
the publish log for `render_encoding, color_scale` among the updated
fields.
