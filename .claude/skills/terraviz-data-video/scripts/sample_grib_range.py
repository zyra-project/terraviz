#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Zyra Project

"""Sample the value distribution of one GRIB2 record from an open S3 URL.

Confirms a `convert-format --pattern` regex matches exactly one record, and
prints the value distribution so you can set a data-encoded `vmax` (use ~p99.9).

Usage:
    python3 sample_grib_range.py <grib2-url> "<idx-regex>"

Example:
    python3 sample_grib_range.py \
      https://noaa-gefs-pds.s3.amazonaws.com/gefs.20260731/06/chem/pgrb2ap25/gefs.chem.t06z.a2d_0p25.f000.grib2 \
      "COLMD:entire atmosphere:.*Dust dry"

Needs: pip install eccodes numpy   (eccodes wheels bundle the C library)

The trick: a GRIB2 message is self-contained, so we read the `.idx` sidecar,
range-GET only the matching record's bytes over HTTP, and decode that slice —
no need to download the whole (often 20+ MB) file.
"""
import re
import sys
import urllib.request

import numpy as np

try:
    import eccodes as ec
except ImportError:
    sys.exit("eccodes not installed — run: pip install eccodes numpy")


def get(url, byte_range=None):
    req = urllib.request.Request(url)
    if byte_range:
        req.add_header("Range", f"bytes={byte_range}")
    return urllib.request.urlopen(req, timeout=90).read()


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    url, pattern = sys.argv[1], sys.argv[2]
    rx = re.compile(pattern)

    idx = get(url + ".idx").decode().splitlines()
    recs = [(int(l.split(":")[0]), int(l.split(":")[1]), l) for l in idx]

    matches = [(i, off, l) for i, (_n, off, l) in enumerate(recs) if rx.search(l)]
    if not matches:
        sys.exit(f"No .idx record matches /{pattern}/. First lines:\n" +
                 "\n".join(l for *_x, l in recs[:8]))
    if len(matches) > 1:
        print(f"WARNING: {len(matches)} records match — a pattern must select ONE:")
        for _i, _o, l in matches:
            print("  ", l)
        print("Refine the regex (e.g. add the aerosol species / size).\n")

    i, start, line = matches[0]
    end = recs[i + 1][1] - 1 if i + 1 < len(recs) else ""
    print("record:", line)
    data = get(url, f"{start}-{end}")
    print(f"downloaded {len(data)} bytes (range-GET of one record)\n")

    h = ec.codes_new_from_message(data)
    vals = np.array(ec.codes_get_values(h), dtype=float)
    miss = ec.codes_get(h, "missingValue")
    units = ec.codes_get(h, "units") if ec.codes_is_defined(h, "units") else "?"
    ec.codes_release(h)
    v = vals[np.isfinite(vals)]
    v = v[v != miss]

    print(f"units (from grib): {units!r}   npoints: {v.size}")
    print("min=%.3e  max=%.3e  mean=%.3e" % (v.min(), v.max(), v.mean()))
    for p in (50, 90, 95, 99, 99.9, 99.99):
        print(f"  p{p:<6}= {np.percentile(v, p):.3e}")
    print(f"\nSuggested vmin: 0   vmax: {np.percentile(v, 99.9):.1e}  "
          f"(p99.9; use p99.99={np.percentile(v, 99.99):.1e} to keep the "
          f"most intense cores from clipping)")


if __name__ == "__main__":
    main()
