#!/usr/bin/env python3
"""Mirror UFS-Chem surface ozone out of GSL THREDDS as small CF files.

This is the NOAA-side half of the architecture in
`docs/UFS_CHEM_SFC_OZONE_PLAN.md`. It exists because of an unusually lopsided
ratio: one forecast cycle is **121 files of ~2.21 GB = ~267 GB**, and the
surface-ozone animation hiding inside it is **~36 MB** — 0.013% of the bytes.
Pulling whole files to use one model level is a 7,482x waste, and the machine
that runs the Zyra workflow (a CI runner) cannot reach `gsl.noaa.gov` at all,
because Cloudflare 403s datacenter egress.

So: run this where GSL *is* reachable. For each forecast hour it opens the
OPeNDAP endpoint, takes one 2-D level of one variable (~0.3 MB over the wire),
and writes a small CF-compliant NetCDF. Point the workflow at the output.

It also repairs two things that would otherwise break the pipeline downstream:

  * **Anonymous dimensions.** The DAP view exposes `o3(o3_0, o3_1, o3_2, o3_3)`
    with no tie to `pfull` / `grid_xt` / `grid_yt`, so nothing can infer where
    the data sits on the Earth. This re-attaches real `lat` / `lon` coordinates
    with CF attributes.
  * **Surface level.** `pfull` ascends toward the ground, so the surface is the
    LAST index, not the first. Auto-detected rather than hardcoded.

Deliberately NOT done here: the 0-360 -> +/-180 roll and the regrid to
equirectangular. Reprojection is Zyra's job (`docs/ZYRA_INTEGRATION_PLAN.md`
§Reprojection lives in Zyra), and this script stays a faithful subset.

Usage:
    # one cycle, hourly f000-f120, written as CF NetCDF named by valid time
    python3 scripts/mirror-ufs-ozone.py --date 20260817 --out ./ozone-frames

    # every 3rd hour, values converted to ppbv (recommended - see below)
    python3 scripts/mirror-ufs-ozone.py --date 20260817 --step 3 --to-ppbv \\
        --out ./ozone-frames

Units: `o3` is stored in **ppm** (`o3mr` is kg/kg and reads far worse). ppm
hovers as `0.0221`, which is legible; ppbv hovers as `22.1`, which matches how
air-quality values are normally quoted and how the NAAQS threshold (70 ppbv) is
stated. `--to-ppbv` multiplies by 1000 and relabels. It is **off by default**
so the mirror does not silently transform data; the plan recommends turning it
on, since Zyra itself cannot rescale units.

Needs `pip install xarray netcdf4`.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone

URL_TEMPLATE = (
    "https://gsl.noaa.gov/thredds/dodsC/data/ufs-chem_csl/"
    "{date}/gfs.t{cycle:02d}z.atmf{fhr:03d}.nc"
)
PPM_TO_PPB = 1000.0


def build_url(date: str, cycle: int, fhr: int) -> str:
    return URL_TEMPLATE.format(date=date, cycle=cycle, fhr=fhr)


def surface_index(ds) -> int:
    """The surface is the last level when pfull ascends toward 1000 hPa."""
    if "pfull" not in ds.coords:
        return -1
    pfull = ds["pfull"].values
    return int(len(pfull) - 1) if pfull[-1] > pfull[0] else 0


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
    ap.add_argument("--to-ppbv", action="store_true", help="multiply ppm by 1000 and relabel as ppbv")
    ap.add_argument("--overwrite", action="store_true", help="rewrite frames that already exist")
    args = ap.parse_args()

    try:
        import numpy as np
        import xarray as xr
    except ImportError as exc:
        print(f"needs xarray + netcdf4: pip install xarray netcdf4  ({exc})", file=sys.stderr)
        return 2

    from pathlib import Path

    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)

    try:
        cycle_start = datetime.strptime(args.date, "%Y%m%d").replace(
            hour=args.cycle, tzinfo=timezone.utc
        )
    except ValueError:
        print(f"--date must be YYYYMMDD, got {args.date!r}", file=sys.stderr)
        return 2

    hours = list(range(0, args.fhr_max + 1, args.step))
    print(f"mirroring {args.var} surface level, {len(hours)} frames, cycle {args.date} t{args.cycle:02d}z")
    print(f"  -> {outdir}")

    written = skipped = failed = 0
    total_bytes = 0

    for fhr in hours:
        valid = cycle_start + timedelta(hours=fhr)
        name = valid.strftime("%Y%m%dT%H%M%S") + ".nc"
        dest = outdir / name

        if dest.exists() and not args.overwrite:
            skipped += 1
            continue

        url = build_url(args.date, args.cycle, fhr)
        try:
            with xr.open_dataset(url) as ds:
                if args.var not in ds.variables:
                    raise KeyError(f"{args.var} not in dataset")

                lev = surface_index(ds)
                # Positional: the DAP view's dims are anonymous, so neither
                # .sel(pfull=...) nor .isel(pfull=...) works here.
                slab = ds[args.var][0, lev]
                values = np.asarray(slab.values, dtype="float32")

                lat = np.asarray(ds["grid_yt"].values, dtype="float64")
                lon = np.asarray(ds["grid_xt"].values, dtype="float64")

                units = ds[args.var].attrs.get("units", "ppm")
                if args.to_ppbv:
                    if units.lower() not in ("ppm", "ppmv"):
                        raise ValueError(f"--to-ppbv expects ppm, found units={units!r}")
                    values = values * PPM_TO_PPB
                    units = "ppbv"

                out = xr.Dataset(
                    {
                        "sfc_ozone": (
                            ("lat", "lon"),
                            values,
                            {
                                "units": units,
                                "long_name": "surface ozone mixing ratio",
                                "standard_name": "mole_fraction_of_ozone_in_air",
                                "source_variable": args.var,
                                "model_level_index": lev,
                            },
                        )
                    },
                    coords={
                        # Re-attached on purpose: this is what the DAP view drops.
                        "lat": ("lat", lat, {"units": "degrees_north", "standard_name": "latitude", "axis": "Y"}),
                        "lon": ("lon", lon, {"units": "degrees_east", "standard_name": "longitude", "axis": "X"}),
                    },
                    attrs={
                        "title": "UFS-Chem surface ozone",
                        "source": "NOAA GSL UFS-Chem (CSL), via THREDDS OPeNDAP",
                        "source_url": url,
                        "cycle": cycle_start.isoformat(),
                        "forecast_hour": fhr,
                        "valid_time": valid.isoformat(),
                        "Conventions": "CF-1.8",
                        "comment": (
                            "One model level subset from a 3-D atmf history file. "
                            "Longitudes are 0-360 as published; reprojection is left to Zyra."
                        ),
                    },
                )
                out.to_netcdf(dest)

            size = dest.stat().st_size
            total_bytes += size
            written += 1
            print(f"  f{fhr:03d} -> {name}  ({size / 1e6:.2f} MB)")

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
