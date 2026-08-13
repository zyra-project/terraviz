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

## The RRFS v1.0 migration (2026-08-13)

RRFS moved from the pre-operational RRFS-A stream to operational
**RRFS v1.0**. The three published smoke datasets were all fed from
RRFS-A paths, so all three pipelines needed revising.

| File | Replaces the pipeline behind |
|---|---|
| `rrfs-smoke-column-north-america.*` | `north-america-smoke` — "Wildfire Smoke Overhead" |
| `rrfs-smoke-near-surface-north-america.*` | `rrfs-smoke-near-surface-north-america` — "RRFS Smoke — Near-Surface, North America" |
| `rrfs-smoke-column-conus.*` | `wildfire-smoke-forecast-transparent-united-states-rrfs` — "Wildfire Smoke Forecast (Transparent) — United States (RRFS)" |

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

**The NA datasets drop from 85 frames to 29.** The 13 km NA product is
published 3-hourly, so `period` moves `PT1H` → `PT3H` and the frame
count moves 85 → 29 across the same 84-hour outlook. If you set
`playback_fps` on those rows, retune it — 29 frames at the old value
plays roughly a third as long.

### Why these read S3 and not the NOMADS path

The NOMADS tree is the authority for the new layout and is fresher, but
it is not fetchable at this scale: **NOMADS publishes no `.idx`
sidecars**, and `convert-format --pattern` needs one to range-GET a
single record. Without it the pipeline pulls whole files — 151 MB per NA
forecast hour, 360 MB per CONUS hour, i.e. ~4.4 GB and ~30 GB per run.

NOAA Open Data Dissemination mirrors the same v1.0 product to
`noaa-rrfs-pds/rrfs_public/` **with** `.idx` sidecars, so one record
costs ~0.4 MB instead of 151 MB. That is also the source the published
rows already credit ("distributed via NOAA Open Data Dissemination on
AWS"), so this keeps the attribution honest.

The one cost is freshness. The mirror normally lands a cycle 1.3–3.9 h
after cycle time (measured across four cycles), which is what the `PT5H`
lag in these pipelines is sized against.

> **Open at time of writing:** the NODD mirror stalled after
> `rrfs.20260812/11z` (last object written 2026-08-12T12:28Z) and had
> published nothing new as of 2026-08-13T15:50Z. Both `rrfs_public/`
> and `rrfs_a/` stopped at the same moment, so this looks like a mirror
> outage rather than anything about RRFS itself. **Confirm the mirror
> has caught up before running these** — a stalled mirror makes every
> input 404. If it turns out to be permanent rather than an outage, the
> honest fallback is a smaller frame count from NOMADS, not whole-file
> downloads.

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

### Verification

Each pipeline was checked with the recipe in
`.claude/skills/terraviz-data-video/references/verification.md`:

- `validatePipeline` + `validateMetadataTemplate` — OK for all three
- placeholder interpolation — no unresolved `{{` left
- `materializeInlinePalettes` — palette materializes, `data_encoded: true`,
  `color_scale_file` present, no `width`/`height`/`basemap` on the heatmap stage
- every rendered input URL **and** its `.idx` HEAD-checked against a
  complete cycle (`rrfs.20260811/18`) — 29/29 and 85/85 resolve
- both record patterns confirmed to match exactly one GRIB2 record

Not yet done: an end-to-end run. These have not been executed against a
live runner, so the first run of each still wants a look at the publish
log for `render_encoding, color_scale` among the updated fields.
