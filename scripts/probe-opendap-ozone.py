#!/usr/bin/env python3
"""Probe a UFS-Chem OPeNDAP endpoint for the surface-ozone calibration inputs.

Companion to `inventory-thredds.py`. That one reads a catalog cheaply over
plain HTTP; this one opens a single file over DAP and answers the two
questions the pipeline still needs:

  * Which ozone variable, and in what **units**? (decides whether the globe's
    hover readout says `45 ppbv` or `0.0000000452` — see
    docs/UFS_CHEM_SFC_OZONE_PLAN.md §4.3)
  * What is the value **distribution** at the surface? (`vmax` should be about
    the p99.9; too high gives the classic near-black globe)

It pulls exactly one 2-D level — ~0.3 MB on the 384x192 grid — rather than the
2.2 GB file, which is the whole point of the OPeNDAP route.

Run it from a NOAA-allowed network: `gsl.noaa.gov` sits behind a Cloudflare
policy that 403s datacenter/CI egress (plan §3.1).

Usage:
    python3 scripts/probe-opendap-ozone.py \\
        https://gsl.noaa.gov/thredds/dodsC/data/ufs-chem_csl/20260817/gfs.t00z.atmf000.nc

    # a different variable, or an explicit level index
    python3 scripts/probe-opendap-ozone.py <url> --vars o3 o3mr --level 63

Needs `pip install xarray netcdf4` — netCDF4-python links netcdf-c, which
carries the DAP support that makes this work with no DAP-specific code.
"""

from __future__ import annotations

import argparse
import sys

DEFAULT_VARS = ("o3", "o3mr", "o3s", "o3s_e90")


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("url", help="OPeNDAP (dodsC) URL of one atmf file")
    ap.add_argument("--vars", nargs="+", default=list(DEFAULT_VARS), help="variables to inspect")
    ap.add_argument(
        "--level",
        type=int,
        default=None,
        help="model level index to sample; default = the surface, auto-detected from pfull",
    )
    args = ap.parse_args()

    try:
        import numpy as np
        import xarray as xr
    except ImportError as exc:
        print(f"needs xarray + netcdf4: pip install xarray netcdf4  ({exc})", file=sys.stderr)
        return 2

    try:
        ds = xr.open_dataset(args.url)
    except Exception as exc:  # noqa: BLE001 - a probe reports, it does not raise
        print(f"could not open {args.url}\n  {type(exc).__name__}: {exc}", file=sys.stderr)
        print(
            "\nA 403 here means Cloudflare is refusing this network; run from a "
            "NOAA-allowed IP (plan §3.1).",
            file=sys.stderr,
        )
        return 1

    print(f"opened {args.url}")
    print(f"  source={ds.attrs.get('source')}  grid={ds.attrs.get('grid')}  "
          f"im={ds.attrs.get('im')} jm={ds.attrs.get('jm')}")

    # The surface is the LAST level: pfull ascends toward 1000 hPa. Detect it
    # rather than hardcode, since level counts differ between configurations.
    level = args.level
    if level is None and "pfull" in ds.coords:
        pfull = ds["pfull"].values
        level = int(len(pfull) - 1) if pfull[-1] > pfull[0] else 0
        print(f"  surface level = index {level}  ({pfull[level]:.1f} hPa of {len(pfull)})")
    elif level is None:
        level = -1
        print("  no pfull coordinate; sampling the last level")

    present = [v for v in args.vars if v in ds.variables]
    missing = [v for v in args.vars if v not in ds.variables]
    if missing:
        print(f"  not present: {', '.join(missing)}")

    for name in present:
        arr = ds[name]
        print(f"\n=== {name}  dims={arr.dims} shape={arr.shape}")
        print(f"    units     : {arr.attrs.get('units', '(none declared)')}")
        print(f"    long_name : {arr.attrs.get('long_name', '(none)')}")
        if arr.attrs:
            print(f"    attrs     : {arr.attrs}")

        if arr.ndim != 4:
            print("    (not 4-D (time, level, lat, lon); skipping the sample)")
            continue

        # Positional indexing on purpose: the DAP view gives variables
        # ANONYMOUS dims (o3_0..o3_3) with no tie to pfull/grid_xt/grid_yt,
        # so .sel()/.isel(pfull=...) does not work here (plan §2.0b).
        try:
            slab = arr[0, level].values
        except Exception as exc:  # noqa: BLE001
            print(f"    sample failed: {type(exc).__name__}: {exc}")
            continue

        finite = slab[np.isfinite(slab)]
        if finite.size == 0:
            print("    all values non-finite at this level")
            continue

        print(f"    sampled surface slice {slab.shape} ({slab.nbytes / 1e6:.2f} MB)")
        print(f"    min {finite.min():.6g}   max {finite.max():.6g}   mean {finite.mean():.6g}")
        for p in (50, 90, 99, 99.9, 99.99):
            print(f"      p{p:<6} {np.percentile(finite, p):.6g}")
        print(f"    => suggested vmin 0, vmax ~{np.percentile(finite, 99.9):.6g} "
              f"(p99.9; use p99.99 to keep the most intense cores unclipped)")

    ds.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
