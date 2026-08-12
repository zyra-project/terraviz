# MPAS 3-km global reflectivity — source scoping and pipeline

How the NSF NCAR MPAS 3-km global forecast would reach the globe as a
data-encoded reflectivity dataset, why it cannot today, and what ships
in the meantime. Companion to
[`ZYRA_INTEGRATION_PLAN.md`](ZYRA_INTEGRATION_PLAN.md) and the
`terraviz-data-video` skill's data-encoded contract.

> **Status: draft for review.** Two pipelines written and validated;
> one of them is runnable. Nothing published yet.
>
> **Last reviewed: 2026-08-12.**
> **Revisit when:** NSF NCAR posts gridded MPAS 3-km output at a
> fetchable URL; the 3-km global run restarts as a live real-time
> product; RRFS v2 (the MPAS-engine one) reaches NODD; or the globe's
> frame budget moves off 4096×2048.

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
on NODD. Validated, calibrated against sampled records, URLs confirmed
live. It can be registered and run now.

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

## 5. The palette: bounds in dBZ, not in palette position

Reflectivity is read as absolute categories — 45 dBZ *is* orange to
anyone who has looked at a radar map. zyra's **classified** palette
spec supports that directly, and its behaviour was confirmed by reading
`build_color_scale` rather than assumed:

```python
# A classified palette is defined against DATA values, so walk
# back through vmin/vmax before applying the norm …
values = np.asarray(ts) * (vmax - vmin) + vmin
```

So the shipped palette is the NWS/AWIPS ramp with `Upper Bound` values
in dBZ. The consequence is worth stating plainly: **changing `vmax`
changes the quantisation step and the clip ceiling, never a colour.**
45 dBZ is orange at `vmax` 55 and at `vmax` 75 alike. That is why the
GFS and MPAS files can carry different ranges and still be read against
the same legend.

Two edges of the spec that are easy to get wrong, both verified by
running the real builder:

- `BoundaryNorm(bounds, len(bounds) − 1)`: N entries define N−1 bins,
  and values *below* the first bound take the **under** colour, which
  is entry 0's. So entry 0 must be the transparent one — otherwise
  clear air paints cyan across the whole globe.
- A classified palette emits **no `transparentRange`** in the sidecar;
  transparency is per-band and rides in the stop alphas. That is fine
  for the client, which treats the field as optional, but it means the
  continuous-palette convention of `transparent_range: 12` has no
  equivalent here.

Verified output: 256 stops, first opaque code at luma 24 (5.18 dBZ),
band edges crisp, sidecar 11,146 chars against a 16,384 limit, palette
arg 702 chars against 2,000.

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

The GFS file deliberately does **not** upsize: its native 1440×721 is
the data, and a 4096-wide frame would only claim resolution the source
does not have.

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

Not verified, because it needs a runner: an end-to-end `zyra run`, and
therefore the actual appearance of the globe. The first run should be
checked against the skill's debugging map before the dataset is made
public.

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
