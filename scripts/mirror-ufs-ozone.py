#!/usr/bin/env python3
"""Mirror UFS-Chem surface ozone out of GSL THREDDS as small globe-ready frames.

This is the NOAA-side half of the architecture in
`docs/UFS_CHEM_SFC_OZONE_PLAN.md`. It exists because of an unusually lopsided
ratio: one forecast cycle is **121 files of ~2.21 GB = ~267 GB**, and the
surface-ozone animation hiding inside it is **~36 MB** — 0.013% of the bytes.
Pulling whole files to use one model level is a 7,482x waste, and the machine
that runs the Zyra workflow (a CI runner) cannot reach `gsl.noaa.gov` at all,
because Cloudflare 403s datacenter egress.

So: run this where GSL *is* reachable. For each forecast hour it opens the
OPeNDAP endpoint, takes one 2-D level of one variable (~0.3 MB over the wire),
and writes a small georeferenced frame. Publish the output where CI can read
it and point the workflow there.

Why this cannot be a Zyra stage
-------------------------------
Asked directly, and checked against zyra `main`:

* `process extract-variable` is **GRIB2-only** ("Extract a variable from GRIB2
  by regex pattern") and has no level selector.
* `process convert-format` reads through `read_bytes_any()`, which returns
  **whole-file bytes**; its only subsetting mechanism is GRIB `.idx` byte
  ranges. A NetCDF input is either copied verbatim (when `--format netcdf`) or
  handed to `grib_decode`, so **NetCDF -> GeoTIFF is not a supported path**.
* Zyra's I/O model is "fetch bytes, then decode", which is structurally
  incompatible with OPeNDAP's "open lazily, request slices" — the very thing
  that makes 267 GB into 36 MB.

Closing that gap needs an upstream `NOAA-GSL/zyra` change (a NetCDF/OPeNDAP
reader with level selection), not an allowlist edit.

What this repairs on the way through
------------------------------------
* **Anonymous dimensions.** The DAP view exposes `o3(o3_0, o3_1, o3_2, o3_3)`
  with no tie to `pfull` / `grid_xt` / `grid_yt`, so nothing downstream can
  infer where the data sits. Selection is positional and coordinates are
  re-attached here.
* **Surface level.** `pfull` ascends toward the ground, so the surface is the
  LAST index. Auto-detected, not hardcoded.
* **Gaussian latitudes.** `grid_yt` is unevenly spaced, and a GeoTIFF
  geotransform cannot express that — it assumes a regular grid. Writing the
  Gaussian rows as if they were regular would misplace data by up to half a
  cell near the poles, which is exactly the kind of quiet lie a hover readout
  must not tell. So the GeoTIFF path resamples onto a regular grid once, with
  the true Gaussian coordinates as input.
* **0-360 longitudes**, rolled to -180..180 (an index roll, not a resample).

This means the GeoTIFF path does the reprojection that would normally be Zyra's
job (`docs/ZYRA_INTEGRATION_PLAN.md` §Reprojection lives in Zyra). That is a
deliberate, documented deviation: Zyra cannot read this source at all, and
doing it here costs **one** resampling instead of two.

Usage:
    # globe-ready GeoTIFF frames, 3-hourly, ppbv  (what the pipeline consumes)
    python3 scripts/mirror-ufs-ozone.py --date 20260817 --step 3 --to-ppbv \\
        --out ./ozone-frames

    # faithful native-grid NetCDF instead (archival; NOT pipeline-consumable)
    python3 scripts/mirror-ufs-ozone.py --date 20260817 --format netcdf \\
        --out ./ozone-nc

Units: `o3` is stored in **ppm** (`o3mr` is kg/kg and reads far worse). ppm
hovers as `0.0221`; ppbv hovers as `22.1`, matching how air quality is quoted
and how the NAAQS 8-hour standard (70 ppbv) is stated. `--to-ppbv` multiplies
by 1000 and relabels. It is **off by default** so the mirror never silently
transforms data; the plan recommends turning it on, since Zyra cannot rescale.

Needs `pip install xarray netcdf4` (+ `rasterio` for the default GeoTIFF path).
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

URL_TEMPLATE = (
    "https://gsl.noaa.gov/thredds/dodsC/data/ufs-chem_csl/"
    "{date}/gfs.t{cycle:02d}z.atmf{fhr:03d}.nc"
)
PPM_TO_PPB = 1000.0
DEFAULT_GRID = "1440x720"


def build_url(date: str, cycle: int, fhr: int) -> str:
    return URL_TEMPLATE.format(date=date, cycle=cycle, fhr=fhr)


def surface_index(ds) -> int:
    """The surface is the last level when pfull ascends toward 1000 hPa."""
    if "pfull" not in ds.coords:
        return -1
    pfull = ds["pfull"].values
    return int(len(pfull) - 1) if pfull[-1] > pfull[0] else 0


def to_regular_grid(values, lat, lon, width: int, height: int):
    """Resample a Gaussian 0-360 field onto a regular -180..180 grid.

    Separable linear interpolation with numpy only (no scipy): longitude is
    already evenly spaced, so it is rolled by index and then interpolated to
    the target count; latitude is the uneven axis and is interpolated against
    its true Gaussian coordinates.

    Returns (grid, west, south, east, north) with the grid north-up.
    """
    import numpy as np

    # --- longitude: 0-360 -> -180..180 by index roll (no resampling) ---
    lon = np.asarray(lon, dtype="float64")
    shifted = ((lon + 180.0) % 360.0) - 180.0
    order = np.argsort(shifted)
    lon_sorted = shifted[order]
    vals = np.asarray(values, dtype="float64")[:, order]

    # --- latitude: ensure ascending for np.interp, then interpolate ---
    lat = np.asarray(lat, dtype="float64")
    if lat[0] > lat[-1]:
        lat = lat[::-1]
        vals = vals[::-1, :]

    # Target cell centres.
    dy, dx = 180.0 / height, 360.0 / width
    tlat = np.linspace(-90.0 + dy / 2, 90.0 - dy / 2, height)   # ascending
    tlon = np.linspace(-180.0 + dx / 2, 180.0 - dx / 2, width)

    stage = np.empty((height, vals.shape[1]), dtype="float64")
    for j in range(vals.shape[1]):
        stage[:, j] = np.interp(tlat, lat, vals[:, j])

    out = np.empty((height, width), dtype="float32")
    for i in range(height):
        # period=360 wraps the seam so the antimeridian interpolates correctly
        out[i, :] = np.interp(tlon, lon_sorted, stage[i, :], period=360.0)

    return out[::-1, :], -180.0, -90.0, 180.0, 90.0   # flip to north-up


def write_geotiff(path: Path, grid, bounds, units: str, tags: dict) -> None:
    import rasterio
    from rasterio.transform import from_bounds

    west, south, east, north = bounds
    height, width = grid.shape
    with rasterio.open(
        path, "w", driver="GTiff", height=height, width=width, count=1,
        dtype="float32", crs="EPSG:4326",
        transform=from_bounds(west, south, east, north, width, height),
        nodata=float("nan"), compress="deflate",
    ) as dst:
        dst.write(grid, 1)
        dst.update_tags(units=units, **{k: str(v) for k, v in tags.items()})
        dst.set_band_description(1, f"surface ozone ({units})")


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--date", required=True, help="cycle date, YYYYMMDD (e.g. 20260817)")
    ap.add_argument("--cycle", type=int, default=0, help="cycle hour (default 0 - only 00z is published)")
    ap.add_argument("--var", default="o3", help="variable to extract (default o3, which is in ppm)")
    ap.add_argument("--fhr-max", type=int, default=120, help="last forecast hour (default 120)")
    ap.add_argument("--step", type=int, default=1, help="forecast-hour stride (default 1 = hourly)")
    ap.add_argument("--out", default="./ozone-frames", help="output directory")
    ap.add_argument("--format", choices=("geotiff", "netcdf"), default="geotiff",
                    help="geotiff = globe-ready regular grid (default); netcdf = faithful native Gaussian grid")
    ap.add_argument("--grid", default=DEFAULT_GRID, help=f"GeoTIFF target grid WxH (default {DEFAULT_GRID})")
    ap.add_argument("--to-ppbv", action="store_true", help="multiply ppm by 1000 and relabel as ppbv")
    ap.add_argument("--overwrite", action="store_true", help="rewrite frames that already exist")
    args = ap.parse_args()

    try:
        import numpy as np
        import xarray as xr
    except ImportError as exc:
        print(f"needs xarray + netcdf4: pip install xarray netcdf4  ({exc})", file=sys.stderr)
        return 2
    if args.format == "geotiff":
        try:
            import rasterio  # noqa: F401
        except ImportError:
            print("geotiff output needs rasterio: pip install rasterio "
                  "(or use --format netcdf)", file=sys.stderr)
            return 2

    try:
        width, height = (int(x) for x in args.grid.lower().split("x"))
    except ValueError:
        print(f"--grid must look like 1440x720, got {args.grid!r}", file=sys.stderr)
        return 2

    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)

    try:
        cycle_start = datetime.strptime(args.date, "%Y%m%d").replace(
            hour=args.cycle, tzinfo=timezone.utc
        )
    except ValueError:
        print(f"--date must be YYYYMMDD, got {args.date!r}", file=sys.stderr)
        return 2

    ext = ".tif" if args.format == "geotiff" else ".nc"
    hours = list(range(0, args.fhr_max + 1, args.step))
    print(f"mirroring {args.var} surface level, {len(hours)} frames, "
          f"cycle {args.date} t{args.cycle:02d}z, format {args.format}"
          + (f" @ {width}x{height}" if args.format == "geotiff" else ""))
    print(f"  -> {outdir}")

    written = skipped = failed = 0
    total_bytes = 0

    for fhr in hours:
        valid = cycle_start + timedelta(hours=fhr)
        dest = outdir / (valid.strftime("%Y%m%dT%H%M%S") + ext)

        if dest.exists() and not args.overwrite:
            skipped += 1
            continue

        url = build_url(args.date, args.cycle, fhr)
        try:
            with xr.open_dataset(url) as ds:
                if args.var not in ds.variables:
                    raise KeyError(f"{args.var} not in dataset")

                lev = surface_index(ds)
                # Positional on purpose: the DAP view's dims are anonymous, so
                # neither .sel(pfull=...) nor .isel(pfull=...) works here.
                values = np.asarray(ds[args.var][0, lev].values, dtype="float32")
                lat = np.asarray(ds["grid_yt"].values, dtype="float64")
                lon = np.asarray(ds["grid_xt"].values, dtype="float64")

                units = ds[args.var].attrs.get("units", "ppm")
                if args.to_ppbv:
                    if units.lower() not in ("ppm", "ppmv"):
                        raise ValueError(f"--to-ppbv expects ppm, found units={units!r}")
                    values = values * PPM_TO_PPB
                    units = "ppbv"

                tags = {
                    "source": "NOAA GSL UFS-Chem (CSL), via THREDDS OPeNDAP",
                    "source_url": url,
                    "source_variable": args.var,
                    "model_level_index": lev,
                    "cycle": cycle_start.isoformat(),
                    "forecast_hour": fhr,
                    "valid_time": valid.isoformat(),
                }

                if args.format == "geotiff":
                    grid, *bounds = to_regular_grid(values, lat, lon, width, height)
                    write_geotiff(dest, grid, bounds, units, tags)
                else:
                    xr.Dataset(
                        {"sfc_ozone": (("lat", "lon"), values, {
                            "units": units,
                            "long_name": "surface ozone mixing ratio",
                            "standard_name": "mole_fraction_of_ozone_in_air",
                        })},
                        coords={
                            "lat": ("lat", lat, {"units": "degrees_north", "standard_name": "latitude", "axis": "Y"}),
                            "lon": ("lon", lon, {"units": "degrees_east", "standard_name": "longitude", "axis": "X"}),
                        },
                        attrs={**tags, "Conventions": "CF-1.8", "title": "UFS-Chem surface ozone",
                               "comment": "Native Gaussian grid, 0-360 longitudes, as published."},
                    ).to_netcdf(dest)

            size = dest.stat().st_size
            total_bytes += size
            written += 1
            print(f"  f{fhr:03d} -> {dest.name}  ({size / 1e6:.2f} MB)")

        except Exception as exc:  # noqa: BLE001 - one bad hour must not kill the run
            failed += 1
            print(f"  f{fhr:03d} FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)

    print(f"\nwrote {written}, skipped {skipped}, failed {failed}")
    if written:
        print(f"total {total_bytes / 1e6:.1f} MB "
              f"(whole-file equivalent would be ~{len(hours) * 2.21:.0f} GB)")
    return 1 if failed and not written else 0


if __name__ == "__main__":
    raise SystemExit(main())
