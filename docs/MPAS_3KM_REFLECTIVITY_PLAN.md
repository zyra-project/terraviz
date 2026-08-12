# MPAS 3-km global reflectivity — source scoping and pipeline

How the NSF NCAR MPAS 3-km global forecast would reach the globe as a
data-encoded reflectivity dataset, why it cannot today, and what ships
in the meantime. Companion to
[`ZYRA_INTEGRATION_PLAN.md`](ZYRA_INTEGRATION_PLAN.md) and the
`terraviz-data-video` skill's data-encoded contract.

> **Status: draft for review.** Two pipelines written and validated;
> the GFS one has been run end to end. Nothing published yet.
>
> **Last reviewed: 2026-08-12.**
> **Revisit when:** NSF NCAR posts gridded MPAS 3-km output at a
> fetchable URL; the 3-km global run restarts as a live real-time
> product; RRFS v2 (the MPAS-engine one) reaches NODD; the globe's
> frame budget moves off 4096×2048; or zyra lets a **classified**
> palette declare its own no-data band, which is what §5 is waiting on
> to swap back to the NWS ramp.

---

## 1. The finding: there is no underlying data to fetch

The [HWT 2025 page](https://www2.mmm.ucar.edu/projects/ncar_ensemble/hwt2025_mpas_3kmGlobal/index.php)
is a picture gallery. That is not an oversight in how it is linked —
it is the whole of what the project publishes. Checked on 2026-08-12:

| Where a gridded endpoint would be | What is actually there |
|---|---|
| The forecast page itself | `images.php?d=…&f=cref_mean&r=…` — per-region PNGs, no data links |
| Its own `data_access.php` | Describes the *legacy* WRF-based NCAR Ensemble on RDA `ds300.0`. For this product: **"For real-time data access, send us an email."** |
| AWS Registry of Open Data | No MPAS entry. NSF NCAR's presence there is ERA5, not forecasts |
| NCAR GDEX / RDA | No 3-km global forecast dataset |
| `project.mmm.ucar.edu/real-time-forecasts/` | The Fall 2025 successor. A Drupal page; no data links. Names two contacts for access |
| THREDDS | Nothing for this product — and `acquire thredds` is not on `ZYRA_STAGE_ALLOWLIST` anyway |

Two further facts matter as much as the absence of a URL:

- **The run is not live.** Spring 2025 ended 30 May 2025 (its own
  date-picker caps there); Fall 2025 is likewise an archive. A
  self-updating workflow needs a cycle that is still being produced.
- **A 3-km global forecast is a campaign, not a service.** It ran a
  single 60-hour forecast a day on Derecho for a field programme. Even
  restarted, its posting latency would need measuring rather than
  assuming.

So the request as literally stated — a workflow that fetches MPAS 3-km
reflectivity — cannot be satisfied by any pipeline, correct or
otherwise. This is a **source** gap, not one of the three capability
tiers: zyra and the allowlist would both handle it fine if the bytes
existed.

**The unblocking action is an email, not a code change.** The contacts
on the Fall 2025 page (Falko Judt, Ryan Johnson) are the people who can
say whether gridded output can be exposed. §3 lists exactly what to ask
them for, so the ask is answerable in one round trip.

## 2. What ships today, and what it is not

[`workflows/global-composite-reflectivity.pipeline.yaml`](workflows/global-composite-reflectivity.pipeline.yaml)
— GFS 0.25° composite reflectivity (`REFC`), from `noaa-gfs-bdp-pds`
on NODD. **Run end to end** (§7), not merely validated: it fetches,
reprojects, encodes, and produces a globe that reads correctly. Running
it is also what corrected three claims in this document — the palette
type (§5), the ramp's alphas (§5), and the grid (§6). None of the three
was catchable by reading the pipeline; two needed a render and one
needed the statistics computed.

It is the only **global** reflectivity field that a CI runner can
actually reach. The honest ranking of the alternatives:

| Source | Resolution | Coverage | Convection | Reachable |
|---|---|---|---|---|
| MPAS 3-km global | 3 km | Global | Explicit | **No — no data endpoint** |
| RRFS (`noaa-rrfs-pds`) | 3 km | North America | Explicit | Yes |
| GFS `REFC` (`noaa-gfs-bdp-pds`) | 0.25° (~28 km) | Global | Parameterised | Yes |

GFS is not a substitute for MPAS and the dataset copy says so. At 28 km
the model does not build storms; it estimates their aggregate effect,
so the field is a smooth precipitation shield rather than a field of
cells. The large-scale pattern is trustworthy and every hover reading
is a real dBZ number — but a single bright pixel is not a thunderstorm,
and captioning it as one would be the actual failure here.

If convection-permitting reflectivity matters more than global
coverage, RRFS is the swap: same pipeline, North American extent, and
it publishes to f084. That is a different dataset design (a regional
field on a globe), so it is noted rather than built.

## 3. The MPAS pipeline

[`workflows/mpas-3km-reflectivity.pipeline.yaml`](workflows/mpas-3km-reflectivity.pipeline.yaml)
is complete and passes `validatePipeline`, placeholder interpolation
and palette materialization. Its source host is
`REPLACE-WITH-MPAS-HOST.invalid` — the reserved TLD from RFC 2606, so
it can never accidentally resolve to somebody else's server.

Three properties of the eventual URL are hard requirements. They are
what to put in the email:

1. **A regular lat/lon grid.** MPAS's native output lives on an
   unstructured Voronoi mesh. zyra is raster-only and cannot read a
   mesh — this is a confirmed Tier-2 gap, not something a pipeline
   argument works around. NCAR must post an interpolated grid (their
   own plotting already produces one).
2. **A date-templatable path.** The placeholder grammar has
   `{{cycle_date}}` / `{{cycle_hour}}` and nothing else — no
   day-of-year, no two-digit year. A `<YYDDDHHmm>` filename, which is
   what some NCAR/GSL products use, cannot be expressed at all.
3. **No Cloudflare in front of it.** Many `*.ucar.edu` and
   `*.noaa.gov` hosts 403 datacenter IPs. This fails the fetch no
   matter how correct the pipeline is, and must be checked from a
   runner rather than a laptop.

A fourth question is worth asking in the same message: **how long after
cycle time is the last forecast hour on disk?** The cycle `LAG` must
cover the whole run posting, not just `f000`. The file carries `PT12H`
as an explicitly-marked guess.

## 4. Calibration: reflectivity breaks the p99.9 rule

The skill's standing advice is `vmax ≈ p99.9`. That is right for
aerosol fields, which are unbounded and long-tailed with no canonical
ceiling. Reflectivity is neither, and following the rule here would be
a mistake worth writing down.

Sampled from real GFS records (`REFC:entire atmosphere`, 2026-08-11
00Z, f006/f012/f024):

| | f006 | f012 | f024 |
|---|---|---|---|
| max | 51.3 | 50.8 | 51.8 |
| p99.99 | 43.0 | 42.9 | 45.0 |
| p99.9 | 37.4 | 37.4 | 38.1 |
| p50 | −20.0 | −20.0 | −20.0 |

A `vmax` of 37 would clip everything above it to full luma — and
everything above it is precisely the part a viewer cares about, the
40–50 dBZ convective cores. It would also make the hover readout wrong
exactly there. **Shipped: `vmin 0`, `vmax 55`** — clear of the observed
maximum, no clipping, and a quantisation step of 0.216 dBZ per luma
code, far finer than the field's own precision.

The median of −20 dBZ is the model's floor, not a measurement: most of
the planet has no precipitation at any moment. Everything at or below
`vmin` lands on luma 0, which the palette's first band renders fully
transparent, so clear air drops out and the globe shows through.

## 5. The palette: the no-data band is what picks it

The obvious choice for reflectivity is a **classified** palette, and
this shipped as one first. Reflectivity is read as absolute categories —
45 dBZ *is* orange to anyone who has seen a radar map — and zyra's
classified spec supports that exactly, walking bounds back through
vmin/vmax so a colour means a dBZ value at any range:

```python
# A classified palette is defined against DATA values, so walk
# back through vmin/vmax before applying the norm …
values = np.asarray(ts) * (vmax - vmin) + vmin
```

**It had to be given up, and not for a reason about colour.**

`normalize_to_luma` sends NaN and masked texels to luma 0 — the same
code as `vmin` — and says so plainly:

> NaN and masked entries become 0, which is both ``vmin`` and the
> "nothing measured here" code **the palette's transparent range
> covers**.

That range is `_transparent_range`, and it returns `None` for anything
whose `type` is not `"continuous"`. So a classified palette publishes a
sidecar with **no `transparentRange`** — and that field is the client's
only declaration that luma 0 is absence rather than a measurement.
Three consumers read it through `isTransparentLuma`:

| Consumer | With no `transparentRange` |
|---|---|
| `datasetStats` | every statistic averages in the ~78% of the frame that is clear air |
| `datasetContours` | isolines trace *through* the no-data footprint |
| `datasetProbe` | hovering open ocean reports `0.00 dBZ`, not no-data |

Measured on a real frame, the statistics half of that is not subtle:

| | mean | median | coverage |
|---|---|---|---|
| No `transparentRange` | 3.17 dBZ | **0.00** | 100.00% |
| Declared (shipped) | 13.70 dBZ | 12.29 | 22.10% |

A reported median global reflectivity of zero is not a rounding
problem, it is a wrong answer. `datasetStats`'s own header predicts it:
*"Counting it as `vmin` would drag every mean toward the bottom of the
scale in exact proportion to how much of the frame is empty."*

**Rendering is correct either way** — a classified palette carries its
alpha in the stops, so the globe looks right while every consumer that
asks "is this texel data?" is told yes. That is precisely why looking
at it does not catch this.

So both files ship a **continuous** turbo ramp with `transparent_range`
23 (GFS) / 17 (MPAS) — 5 dBZ in both cases — blending to solid at
25 dBZ. Verified through the pipeline's own sidecar:
`transparentRange: 0.089844`, `isTransparentLuma(0) === true`, first
data luma 23 = 4.96 dBZ.

### What that costs, and when to undo it

Continuous colours are pinned to palette **position**, not to value:
`_sample_palette`'s continuous branch samples `cmap(t)` with no
vmin/vmax walk-back, unlike its classified branch. So changing `vmax`
changes what every colour means, and the GFS (0–55) and MPAS (0–75)
files are **not** directly comparable by colour today. Pin both to one
range if they ever need to share a legend.

At 0–55 turbo lands close to convention by luck — green ~25 dBZ, yellow
~35, orange ~44, red ~49, within a couple of dBZ of the NWS ramp — so
the practical loss is smaller than the principle suggests.

**Undo this when zyra derives the transparent band from a classified
palette's leading zero-alpha entries.** The information is already in
the spec: the classified ramp's entry 0 was `[0,0,0,0]` with
`Upper Bound: 0`, i.e. "everything below 0 dBZ draws nothing". A few
lines in `_transparent_range` would let a classified palette declare
its own no-data band, at which point the NWS ramp is strictly better
and the swap is a one-line palette change with no re-encode.

### The ramp needed retuning for a lit globe

Rendering it settled a question that reasoning would not have. The
stock NWS ramp is drawn for a **white** radar background, and the globe
is neither white nor blank — a data-encoded dataset carries no basemap
precisely because the globe supplies Earth underneath. Composited over
`earth_diffuse_4096`, the stock ramp failed twice:

- **Two bands read as holes.** The 15–20 dBZ pure blue (`3,0,244`) and
  the 30–35 dBZ dark green (`0,142,0`) are darker than the ocean they
  sit on. Light-to-moderate precipitation *disappeared*, then
  reappeared as green above it — the field looked discontinuous where
  the data is smooth.
- **Every band at full alpha buried the map.** 20.75% of texels draw
  something in a typical frame, and at alpha 255 that is a solid cyan
  blanket over a fifth of the planet. Continents vanished under
  drizzle.

The fix keeps the convention where it matters and changes it where the
background forces it: **hue boundaries are untouched**, so it still
reads as a radar map and 45 dBZ is still orange. Alpha now ramps across
the light bands (70 → 120 → 175 → 215 → 245 → 255), so drizzle is a
wash the Earth shows through and only real precipitation goes solid,
and the two dark bands are lightened to clear the ocean. Near-opaque
coverage drops from 20.75% to 1.93% while total coverage is unchanged —
the same data, weighted so the eye reads intensity.

Alpha is display-only: `lumaToValue` never consults it, so every hover
reading is identical under either ramp.

## 6. Resolution honesty

The MPAS file reprojects to 4096×2048, and that number deserves a
caveat rather than a nod. 4096 columns over 360° is ~0.088°, about
9.8 km at the equator. **A true 3-km global frame would need ~13,333
columns.** The globe's frame budget, not the model, is the resolution
limit — MPAS at 4096 wide shows convection-permitting *structure*
resampled to ~10 km.

That is still a large gain over GFS's 28 km parameterised smear, and it
is the right trade for now. But it means "3-km" in the dataset title
would describe the model, not the pixels, and the copy is written
accordingly.

**Correction from the run.** An earlier draft of this section said the
GFS file kept its native 1440×721 by omitting the size. That was wrong
twice over. `zyra process reproject` defaults to `--width 4096`
(`raster_reproject.DEFAULT_WIDTH`), so omitting the size does not keep
native resolution — it upsizes silently, which the first run duly did.
And native would not have been the right choice anyway:
`cli/lib/sos-spec.ts` asserts 4096×2048 and flags anything else as "the
transcode upscales/downscales, check source quality", so a smaller
frame just moves the upscale downstream onto the *luma*. Doing it in
`reproject` resamples the **data**, which is the entire reason the
contract puts regridding on that stage.

Both files now state 4096×2048 explicitly. A size this load-bearing
should not be arriving from a default nobody looked up — which is
exactly how the wrong claim got written in the first place.

One caveat worth recording: reproject's default resampling is
**bilinear**, so the 2.84× upsample interpolates. Standard for a
continuous field, and dBZ is continuous — but dBZ is also logarithmic,
so a bilinear blend of two dBZ values is not the linear-average
reflectivity of the pair. The error is small and every radar display
makes it; it is noted so nobody rediscovers it as a bug.

## 7. Verification performed

Per the skill's §7, against the repo's real validators rather than by
eye. Both files: `validatePipeline` OK; no leftover `{{`;
`data_encoded: true` with `color_scale_file`; no `width`/`height` or
`basemap` on the heatmap stage; `cmap_inline` materialized to a
classified 16-entry palette; no `compose-video`; frame names unique and
strictly increasing.

- GFS rendered inputs resolve: `f000`, `f048` and the `.idx` sidecar
  all return 200.
- Cycle selection: at 2026-08-12T17:00Z with `LAG PT6H` the pipeline
  picks the 06Z cycle. Measured the same day, the 12Z cycle had `f048`
  posted by +5h09m, so `PT6H` selects a cycle already complete.
- The `REFC:entire atmosphere` pattern matches exactly one `.idx`
  record per file. It is lead-agnostic: at `f000` the record is
  labelled `:anl:` rather than `:0 hour fcst:`, and the pattern covers
  both.
- GFS filenames carry **no extension** (`gfs.t06z.pgrb2.0p25.f048`).
  Confirmed harmless: `ensure_idx_path` appends `.idx` regardless, and
  `read_bytes_any` writes fetched bytes to its own `.grib2` temp file,
  so nothing sniffs the URL suffix.

### The end-to-end run (2026-08-12)

`zyra run` over the full 49-frame GFS pipeline, cycle `20260812/06`:

| | |
|---|---|
| Result | exit 0, **49/49 frames**, no missing, no duplicates |
| Wall clock | **2m30s** (fetch ~40s, reproject ~60s, heatmap ~50s) |
| Peak disk | ~1.9 GB — 195 MB GeoTIFF, 1.6 GB reprojected, 75 MB frames |
| `scan-frames` | recovered 2026-08-12T06:00 → 2026-08-14T06:00, 3600 s |

The `.idx` subsetting does what it promises: 49 fetches of a ~500 MB
file each moved ~1 MB.

**Clipping, across the whole forecast** — the check that says whether
`vmax` was chosen right:

| Valid | max luma | max dBZ | clipped px |
|---|---|---|---|
| 08-12 06Z | 236 | 50.90 | 0 |
| 08-12 14Z | 246 | 53.06 | 0 |
| 08-12 18Z | 246 | 53.06 | 0 |
| 08-13 06Z | 241 | 51.98 | 0 |

**Zero clipped pixels anywhere**, peaking at 53.06 dBZ against a
ceiling of 55 — about 2 dBZ of headroom, tight but real. Note the peak
lands at 14Z and 18Z, i.e. afternoon convection, and runs ~1.3 dBZ
above what the three sampled records suggested. Sampling one cycle
gets you close; it does not get you the maximum. Had `vmax` been the
p99.9 of 37, roughly 0.1% of the globe would be clipped — and that 0.1%
is the storms.

### What it looks like

Frames were composited over `earth_diffuse_4096` through the client's
own `parseColorScale` → `buildColorScaleLut`, so the preview is the
globe's colouring rather than an impression of it. The sidecar parses
(so no grayscale fallback), luma 236 → 50.90 dBZ, and the shipped turbo
ramp lands close to radar convention: nothing below 5 dBZ, solid by 25,
green ~25, yellow ~35, orange ~44, red ~49.

It reads correctly. Mid-latitude frontal bands, the ITCZ, monsoon
convection over India and China, afternoon convection firing over land
and dying after dark across the 49-hour loop. Coverage is stable at
20–21% of texels per frame. Geography stays legible underneath.

It also confirms the caveat in §2 rather than softening it: the top
half of the ramp barely lights. Orange and red appear as specks, never
as the cores a radar loop would show, because GFS does not build storms
— it estimates them. The picture is honest, and it is visibly not a
convection-permitting product.

### Two deviations from what CI would run

Recorded because they bound the claim, not because either looks
material:

- **zyra 0.1.54 from PyPI in a venv, not the pinned container**
  (`ghcr.io/noaa-gsl/zyra@sha256:0f335b9d…`). The sandbox has a docker
  CLI but no daemon. Same pipeline code; not the same image.
- **numpy 2.4.6, where zyra pins `<2.0`.** Installed `--no-deps`
  because two unrelated core dependencies (`reverse-geocoder`,
  `PyVimeo`) will not build here. Nothing in the run touched them, and
  no numpy-2 incompatibility surfaced.

Still unverified: the real globe. This was an offline composite, not
the SPA — it does not exercise `earthTileLayer`'s shader, the HLS
transcode, or `playback_fps`. Publish once and look before making the
dataset public.

## 8. Extending to other fields

"To start, reflectivity" implies more. The pipeline shape is unchanged
per field; three arguments move. Ranges below are starting points to
sample, not calibrations:

| Field | `.idx` pattern | Units | vmin/vmax | Palette |
|---|---|---|---|---|
| Composite reflectivity | `REFC:entire atmosphere` | dBZ | 0 / 55 | classified NWS (shipped) |
| 1-km AGL reflectivity | `REFD:1000 m above ground` | dBZ | 0 / 55 | same — comparability is the point |
| 2-m temperature | `TMP:2 m above ground` | K | sample | continuous, diverging |
| Precipitable water | `PWAT:entire atmosphere` | kg m-2 | sample | continuous `YlGnBu` |
| CAPE | `CAPE:180-0 mb above ground` | J kg-1 | sample | continuous, light-starting |

Reflectivity siblings should keep the same palette *and* the same
`vmax`, so that switching layers compares like with like. Fields in
kelvin or `kg m-2` hover as physically correct but hard-to-read
numbers, and zyra has no unit-rescaling command (a confirmed Tier-2
gap) — so prefer a variable whose native units read well.

## 9. Non-goals

- **Adding these to `WORKFLOW_TEMPLATES`.** The curated portal picker
  is a product surface every node sees; putting a reflectivity pipeline
  there is a separate decision from having one. Revisit once the GFS
  build has run and been looked at.
- **A legend.** `main` has no color-scale-driven colorbar; the live one
  is on the unmerged `claude/data-driven-video-analytics` branch. Until
  it merges, `scripts/make_legend.py` → `legend_ref` is the stopgap.
  The `color_scale` already powers the hover readout, which is the live
  value surface.
- **Filing an upstream issue.** Nothing here is blocked on zyra. The
  mesh-reading limitation in §3 is real but only bites if NCAR posts
  native output, which is not yet a question.

## 10. Open questions

1. Will NSF NCAR expose gridded output at all? The product is a
   research campaign with no data-distribution mandate, and the answer
   may simply be no.
2. If they will, at what latency and on what grid? Both change the
   file; neither can be guessed.
3. Is ~10 km effective resolution (§6) enough to make the 3-km run
   worth the fetch cost? A 3-km global GRIB2 record is tens of MB, and
   61 of them is a materially heavier run than anything the scheduler
   does today. Worth a cost estimate before enabling a daily schedule.
4. Should the GFS dataset ship at all, or does a smooth global
   reflectivity field set the wrong expectation for a surface whose
   next version is convection-permitting? The copy manages this, but it
   is a judgement call and belongs to whoever owns the catalog.
