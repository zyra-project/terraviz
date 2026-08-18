# [Workflow Gap] Dimension selection on the existing NetCDF input path

> **FILED:** [zyra-project/zyra#300](https://github.com/zyra-project/zyra/issues/300),
> labelled `relay-upstream`.
>
> `NOAA-GSL/zyra` is the original; `zyra-project/zyra` is a downstream mirror
> with a documented relay for downstream-originated issues (its
> `.github/workflows/README.md` names AI-agent sessions as a case). Applying
> `relay-upstream` is what creates the upstream twin, so the label is the
> filing, not a shortcut around it. Filed downstream because this session was
> scoped to `zyra-project/*` and cross-owner attach is unsupported.
>
> **Check the twin actually appeared** at `NOAA-GSL/zyra`. The relay needs
> `SYNC_PAT_ORG` to hold upstream write access; without it the label is inert
> and the issue needs pasting upstream by hand. This copy is the paste source.
>
> Body verified against zyra `main` @ v0.1.54. Every claim about what already
> works cites the file and line it was read from.

## Summary

Zyra can already open a NetCDF variable, including over OPeNDAP. What it cannot
do is pick a slice out of it. Any source whose variable is 3-D or 4-D — model
history output, which is most research model output — therefore cannot be
rendered, because the whole variable arrives and nothing reduces it to the 2-D
field the renderer needs.

## Current State

**Available commands used:** `process convert-format`, `process reproject`,
`visualize heatmap`, `process scan-frames`.

**What already works**, verified against `main` (v0.1.54) — worth stating
plainly so this is not re-implemented:

- `visualize heatmap --input` accepts `.nc` / `.nc4` and takes that branch on
  filename extension, so a THREDDS `dodsC` URL (which ends in `.nc`) matches.
- It passes the path straight to `xarray.open_dataset`
  (`heatmap_manager.py:74`), and `netCDF4-python` links `netcdf-c`, which has
  DAP2/DAP4 built in. **OPeNDAP support is already present, transitively.**
- `--var` selects the variable. `--xarray-engine` selects the engine.

**The gap**, one line:

```python
# src/zyra/visualization/heatmap_manager.py, _resolve_data()
arr = ds[var].values      # whole variable — no dimension selection
```

For a variable shaped `(time=1, level=64, lat=192, lon=384)` this returns a 4-D
array that the renderer cannot use, and pulls all 64 levels over the wire when
one was wanted.

There is no `--isel`, `--sel`, `--level`, or squeeze option on `heatmap`, and
`process extract-variable` is GRIB2-only ("Extract a variable from GRIB2 by
regex pattern"), so nothing upstream of it can reduce the field either.

## Desired Behaviour

Positional dimension selection, applied lazily so only the requested slice
crosses the network.

**Preferred home: `process convert-format`.** Putting it on `heatmap` alone
would render a slice but leave two problems unsolved — see *Why not just
heatmap* below. On `convert-format` it restores the standard chain:

```bash
zyra process convert-format \
  --inputs "https://<host>/thredds/dodsC/<path>/gfs.t00z.atmf000.nc" \
  --var o3 \
  --isel "time=0,level=-1" \
  --format geotiff \
  --output-dir /work/tif
```

and then `reproject` → `heatmap --data-encoded` → `scan-frames` works unchanged.

Useful properties, roughly in priority order:

- **Positional selection (`--isel`), not only coordinate selection.** See the
  CF note below — positional is often the only option available.
- **Negative indices** (`level=-1`), since "the surface" is the last level in
  some conventions and the first in others.
- **Lazy application** — select before `.values`, so the slice is what
  transfers. This is what turns a 2.21 GB file into ~0.3 MB.
- **`--sel` too**, for sources that are CF-clean.

### Implementation note 1: TDS OPeNDAP views are often not CF-compliant

Easy to miss, and it produces confusing failures. A THREDDS `dodsC` view of
these files gives variables with **anonymous dimensions**, unassociated with the
coordinate variables:

```
o3        (o3_0, o3_1, o3_2, o3_3)   float32     # 1 x 64 x 192 x 384
pfull     (pfull)   float64                      # 0.3792 ... 997.3 hPa
grid_xt   (grid_xt) float64                      # 0 ... 359.1
grid_yt   (grid_yt) float64                      # 89.28 ... -89.28
```

So `.sel(pfull=...)` and `.isel(pfull=...)` both fail — selection has to be by
axis position (`arr[0, 63]`). Also note `pfull` **ascends** toward the ground,
so the surface is the *last* index, not the first.

### Implementation note 2: irregular latitude and a GeoTIFF geotransform

`grid_yt` above is a **Gaussian** axis — unevenly spaced. A GeoTIFF
geotransform cannot express that; it assumes regular spacing. Writing those
rows as if regular misplaces data by up to half a cell near the poles, which
matters here because these frames are used for value readout, not just
pictures. A `--format geotiff` path from such a source needs a real regrid (or
to refuse, loudly, rather than write a subtly wrong raster).

### Why not just `heatmap`

Adding `--isel` only to `heatmap` would render a slice, but the source is
0–360 longitude on a Gaussian grid, and `heatmap` has no roll and no regrid —
`--extent` labels an extent, it does not transform one. `reproject` does both,
but takes rasters, so something must produce a GeoTIFF first. Hence
`convert-format`. Adding `--isel` to `heatmap` as well is still useful for
already-regular 3-D sources.

## Implementation Plan (Proposal)

- [ ] `--isel` / `--sel` on `process convert-format`, applied before
      materialising values
- [ ] NetCDF (incl. DAP URL) → GeoTIFF conversion, with coordinates attached
- [ ] Regrid, or an explicit error, when a coordinate axis is irregular
- [ ] Optionally the same `--isel` on `visualize heatmap`
- [ ] Tests: anonymous-dimension selection; negative indices;
      descending-vs-ascending vertical coordinate; Gaussian → regular;
      and that only the requested slice is fetched
- [ ] Docstrings for the auto-generated docs
- [ ] Example in `samples/pipelines/`

## Context

**The concrete case.** NOAA GSL publishes UFS-Chem at
`data/ufs-chem_csl/<YYYYMMDD>/gfs.t{HH}z.atmf{FFF}.nc` — 121 hourly files per
cycle, ~2.21 GB each, ~267 GB total. Each is a 3-D history file on a 384×192
Gaussian grid, 64 levels, 148 variables. A five-day surface-ozone animation
needs one level of one variable per file:

| | |
|---|---|
| Whole files, one cycle | **~267 GB** |
| One surface level × 121 frames | **~36 MB** |
| Ratio | **~7,482×** |

**The saving is already demonstrable** with the libraries Zyra ships. Measured
against a public THREDDS server, opening a `dodsC` endpoint with xarray and
pulling one 2-D slice from a 4-D variable:

| | |
|---|---|
| Open dataset over DAP | 1.2 s |
| Full variable | 32,181 MB |
| One time × one level | **4.15 MB in 0.5 s** |
| Transferred | **0.0129%** |

**Who benefits.** Any workflow whose source is model history output rather than
post-processed GRIB2 — UFS, MPAS, WRF-as-NetCDF — and the many agency THREDDS
servers that expose OPeNDAP but publish no `.idx` sidecars. Today those sources
are out of reach unless the whole file is moved.

**Current workaround.** A standalone Python script does the subset outside
Zyra and hands the pipeline georeferenced frames. It works, and it has run in
CI, but it means a bespoke pre-step per such dataset, which does not fit a
platform where pipelines are declarative rows in a database.

**Precedent.** `process reproject` was added upstream
(NOAA-GSL/zyra#295, #306) for a comparable gap and adopted downstream once
released. Same shape.

**Not an allowlist issue.** For readers coming from TerraViz: `convert-format`
and `extract-variable` are both already on `ZYRA_STAGE_ALLOWLIST`. No
downstream change would help; the capability has to exist upstream.
