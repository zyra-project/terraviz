# DRAFT — upstream issue for `NOAA-GSL/zyra` (georeferencing)

**Not filed.** Prepared text awaiting a decision to open it. Filing is
public and outward-facing, so it needs a human to send it. Delete this
file once the issue is opened and replace the reference in
[`README.md`](README.md) with the issue number.

This is a **separate** issue from
[`UPSTREAM_ZYRA_ISSUE_DRAFT.md`](UPSTREAM_ZYRA_ISSUE_DRAFT.md), which
concerns record *selection*. This one concerns where the selected record
lands on Earth. Different function, different symptom, different fix —
they should not be combined.

Suggested title:

> `_grib_georeference` covers only `regular_ll` and `lambert`: `mercator` grids fail outright, `rotated_ll` and `polar_stereographic` need caller workarounds

---

## Summary

`convert_to_format(..., "geotiff")` georeferences a GRIB2 record from its
own metadata for two grid types, and falls back to rioxarray for
everything else. That fallback has two failure modes, and one of them is
fatal:

- **`mercator`** — cfgrib does not expose these grids as 2-D, so the
  fallback raises and the record cannot be converted at all.
- **`rotated_ll`, `polar_stereographic`** — the fallback produces a
  GeoTIFF with no CRS and an identity transform, *and* without the
  north-up row normalisation that the georeferenced path applies. A
  caller can recover both, but the second is silent: the output is
  vertically mirrored, and nothing says so.

All four grid types are in routine NCEP output. RRFS v1.0 alone
publishes all four.

## Environment

zyra **v0.1.52** (`ghcr.io/noaa-gsl/zyra@sha256:0f335b9d…`,
`org.opencontainers.image.revision = 78e8c6225b362801634a347c28611a0b85d4d7d8`).

## What each grid type does today

Measured against `noaa-rrfs-ops-pds`, cycle `rrfs.20260814/12`:

| Domain | `GRIB_gridType` | cfgrib dims | `convert-format geotiff` |
|---|---|---|---|
| RRFS CONUS 3 km | `lambert` | `(y, x)` | georeferenced — correct |
| RRFS NA 13 km | `rotated_ll` | `(y, x)` | identity transform, no CRS, **not row-flipped** |
| RRFS AK 3 km | `polar_stereographic` | `(y, x)` | identity transform, no CRS |
| RRFS HI 2.5 km | `mercator` | **`(values,)`** | **raises** |
| RRFS PR 2.5 km | `mercator` | **`(values,)`** | **raises** |

## 1. `mercator` cannot be converted at all

`_grib_georeference` (`grib_utils.py:233`) returns `None` for any grid
type other than `regular_ll` (`:268`) or `lambert` (`:278`), falling
through to `data_array.rio.to_raster(...)` at `:538`. For these grids
cfgrib returns a **1-D** array with a single `values` dimension, so
rioxarray cannot infer spatial dims:

```
rioxarray.exceptions.MissingSpatialDimensionError: y dimension not found.
'rio.set_spatial_dims()' or using 'rename()' to change the dimension name
to 'y' can address this. Data variable: unknown
```

which `grib_utils.py:544` re-raises as:

```
ValueError: GeoTIFF conversion requires rioxarray/rasterio and georeferencing
```

Note that fixing the grid-type coverage alone would not be enough: the
georeferenced branch requires `values.ndim == 2` (`:512`), and the array
is 1-D before it gets there. Both the CRS and a reshape are needed.

## 2. `rotated_ll` / `polar_stereographic` silently lose the row order

These do reach rioxarray successfully, producing a GeoTIFF with an
identity transform and no CRS. A caller can supply `--s-srs` and
`--bounds` to `process reproject` and recover the georeferencing — that
is what we do today.

What is not recoverable from the arguments is the **scan order**. The
georeferenced branch flips rows to north-up when `jScansPositively=1`
(the `flip` element of `_grib_georeference`'s return). The rioxarray
fallback does not, so the array arrives upside down with nothing
indicating it. Measured on the RRFS 13 km NA grid, against the file's own
`latitudes`/`longitudes` arrays:

| `--bounds` order | field maximum lands |
|---|---|
| `west south east north` (the natural reading) | **2708 km** from truth |
| `west north east south` (south/north inverted) | 1.6 km from truth |

The workaround — passing north in the `south` slot so `from_bounds`
emits a positive y-step — works, but it reads like a typo in a pipeline
file and there is no way to discover it except by measuring.

## 3. The fix is small, and works

Verified rather than proposed. Reshaping cfgrib's 1-D array to
`(Nj, Ni)`, flipping for `jScansPositively`, and attaching a Mercator CRS
built from `LaDInDegrees` — the same shape of work the `lambert` branch
at `:278` already does — reprojects the RRFS Hawaii domain correctly:

| | correlation vs source |
|---|---|
| reshape + flip + `mercator` CRS | **0.986** |
| control: source sampled 0.5° off | 0.224 |

(4000 random points, nearest-neighbour against the GRIB's own coordinate
arrays.)

The projection parameters all come from keys already read elsewhere in
the function: `LaDInDegrees` → `lat_ts`, the first/last grid points for
the extent, `Ni`/`Nj` for the shape, `jScansPositively` for the flip,
and the GRIB2 sphere radius the `lambert` branch already assumes.
`polar_stereographic` needs `LaDInDegrees` plus
`orientationOfTheGridInDegrees` and is the same shape of change;
`rotated_ll` needs the rotated pole from
`latitudeOfSouthernPoleInDegrees` / `longitudeOfSouthernPoleInDegrees`.

## Reproduction

```bash
BASE=https://noaa-rrfs-ops-pds.s3.amazonaws.com/rrfs.20260814/12

# mercator — raises
zyra process convert-format \
  "$BASE/rrfs.t12z.2dfld.2p5km.subh.f006.hi.grib2" geotiff \
  --pattern 'REFC:entire atmosphere.*:315 min fcst' -o hi.tif

# lambert — works, for contrast
zyra process convert-format \
  "$BASE/rrfs.t12z.2dfld.3km.subh.f006.conus.grib2" geotiff \
  --pattern 'REFC:entire atmosphere.*:315 min fcst' -o conus.tif

# rotated_ll — "works", but the GeoTIFF has no CRS, an identity
# transform, and rows in source (south-first) order
zyra process convert-format \
  "$BASE/rrfs.t12z.2dfld.13km.f024.na.grib2" geotiff \
  --pattern 'COLMD:entire atmosphere.*Particulate organic matter dry' -o na.tif
```

## Possible shapes for a fix

**A. Extend `_grib_georeference` to the remaining grid types**, and
reshape when cfgrib hands back a 1-D `values` array. Highest value:
`mercator` becomes usable at all, and `rotated_ll` /
`polar_stereographic` stop needing caller-side `--s-srs` + `--bounds`,
which also removes the silent mirror. All the metadata needed is already
being read.

**B. If the full set is too much, `mercator` alone** would unblock the
cases that currently cannot be done by any means. The other two have a
workaround, however unobvious.

**C. Failing either, warn on the fallback path** when
`jScansPositively=1` — something along the lines of "no georeferencing
derived for grid type X; rows are in source scan order and the output is
not north-up". That does not fix anything, but it converts a silent
wrong answer into a visible one, which is the part that cost us the most
time.

## What this is not asking for

- Not a change to the `lambert` or `regular_ll` paths; both are correct.
- Not vector or non-raster support.
- Nothing about record *selection* — that is a separate concern, and if
  it is filed it will be its own issue.

Happy to test a branch against the RRFS files above, or to contribute
the `mercator` branch in **A** if that shape seems right.
