# DRAFT — upstream issue for `NOAA-GSL/zyra`

**Not filed.** This is prepared text awaiting a decision to open it.
Filing is public and outward-facing, so it needs a human to send it.
Delete this file once the issue is opened, and replace the reference in
[`README.md`](README.md) with the issue number.

Suggested title:

> `convert-format`: a GRIB2 record is unselectable when the source has no `.idx` and `shortName` is `unknown`

---

## Summary

`process convert-format` offers two ways to pick a record out of a
multi-field GRIB2 file, and there is a real and growing class of source
where **neither works**: a file served without an `.idx` sidecar whose
fields carry no `shortName`. `--pattern` requires the sidecar;
`--var` matches variable names that in this case are all the literal
string `unknown`. The information needed to identify the record is
present in the GRIB2 itself, but nothing in the current selection
surface can reach it.

This is not a request to make the whole-file path faster. It is that a
correct selection cannot be expressed at all.

## Environment

- zyra **v0.1.52** (`ghcr.io/noaa-gsl/zyra@sha256:0f335b9d9b2f0eba6d7ef9407906b13eddb1ead43b984bc07c21b4507063b09b`,
  `org.opencontainers.image.revision = 78e8c6225b362801634a347c28611a0b85d4d7d8`)
- Backends available in that image: cfgrib, pygrib, and `wgrib2`
  (built with `WITH_WGRIB2=source` on amd64)

## Motivating case

NOAA's Rapid Refresh Forecast System moved to v1.0. Per
[SCN 26-48](https://www.weather.gov/media/notification/pdf_2026/scn26-048_RRFS_and_REFS_Implementation.aab.pdf),
the prototype feed on the `noaa-rrfs-pds` S3 bucket stopped updating on
2026-08-11, with production implementation on 2026-10-06. The live
pre-implementation data is on NOMADS
(`https://nomads.ncep.noaa.gov/pub/data/nccf/com/rrfs/para/`).

NOMADS publishes **no `.idx` sidecars** and has no GRIB-filter service
for RRFS, and the files are large — 154 MB for the 13 km North America
2-D field set, 360 MB for the 3 km CONUS one, per forecast hour.

The fields wanted are ordinary ones:

| Field | `.idx` line fragment |
|---|---|
| Column smoke | `COLMD:entire atmosphere (considered as a single layer):…:aerosol=Particulate organic matter dry:aerosol_size <2.5e-06` |
| Near-surface smoke | `MASSDEN:8 m above ground:…:aerosol=Particulate organic matter dry:aerosol_size <2.5e-06` |
| Composite reflectivity | `REFC:entire atmosphere (considered as a single layer):315 min fcst` |

## Why `--pattern` cannot be used

`--pattern` is documented as ".idx-based subsetting when using HTTP/S3"
(`src/zyra/processing/__init__.py:996`). In
`src/zyra/utils/io_utils.py::read_bytes_any` (line 66), the whole-file
read is reachable only when `idx_pattern` is falsy:

```python
if idx_pattern:                                          # :103
    lines  = http_backend.get_idx_lines(path_or_url)     # :104  GETs <url>.idx
    ranges = idx_to_byteranges(lines, idx_pattern)
    if not ranges:
        raise RuntimeError(f"No .idx lines matched pattern {idx_pattern!r} …")   # :110
    return http_backend.download_byteranges(path_or_url, ranges.keys())          # :112
return http_backend.fetch_bytes(path_or_url)             # :113  whole file
```

`get_idx_lines` (`src/zyra/connectors/backends/http.py:191`) calls
`raise_for_status()` inside `with_retries(...)`, so a 404 on the sidecar
is retried and then raised, rewrapped as `RuntimeError`, logged by
`cmd_convert_format`, and returned as exit 2. That is reasonable
behaviour on its own terms — the point is only that there is no path
from `--pattern` to a source without a sidecar.

## Why `--var` cannot be used either

Dropping `--pattern` does reach `fetch_bytes`, at the cost of the whole
file. But `--var` ("Variable name or regex for multi-var datasets",
`src/zyra/processing/__init__.py:994`) resolves through
`extract_variable` (`src/zyra/processing/grib_utils.py:175`), which
matches cfgrib `dataset.data_vars`, or pygrib `shortName` / `name`.

Every field needed here is nameless. Decoded with eccodes 2.48 from
`rrfs.t18z.2dfld.13km.f024.na.grib2`:

| Record | `shortName` | `name` | `paramId` | discipline / category / number |
|---|---|---|---|---|
| `REFC` (rec 1) | `unknown` | `unknown` | 0 | 0 / 16 / 5 |
| `MASSDEN` ×5 (recs 83–87) | `unknown` | `unknown` | 0 | 0 / 20 / 0 |
| `COLMD` ×4 (recs 148–151) | `unknown` | `unknown` | 0 | 0 / 20 / 1 |

This is specific to these fields rather than to the file: of 27 records
sampled evenly across the 318, 21 resolve cleanly (`st`, `tp`, `crain`,
`gh`, `u`, `cin`, `tcc`, `veg`, …) and the 6 that do not include every
one wanted here.

Because they collapse onto the single string `unknown`, no regex can
separate the organic-matter `COLMD` from the dust `COLMD`, or `REFC`'s
315-minute sub-step from its 330-minute one. And `extract_variable`
returns `matches[0]` (`grib_utils.py:206`), so an ambiguous selection
resolves to whichever record decoded first rather than raising. From a
caller's perspective the run succeeds and the output is a different
field than requested — which is the part that motivated filing this
rather than working around it.

## `wgrib2 -match` is close, but not reachable

`wgrib2 -match` matches the **inventory line**, which does carry the
discriminating text (`aerosol=Particulate organic matter dry`,
`315 min fcst`). zyra already shells out to it at
`src/zyra/processing/__init__.py:202` — but only inside
`cmd_extract_variable` (line 147), gated on `--stdout` with
`--format netcdf|grib2` rather than `geotiff`, single-input rather than
`--inputs`, and downstream of the same `read_bytes_any(idx_pattern=…)`
call, so a URL input fails on the missing sidecar before wgrib2 runs.

The capability is essentially already in the image. It just is not
wired to a path that can produce batch GeoTIFFs from a URL list.

## Reproduction

```bash
URL=https://nomads.ncep.noaa.gov/pub/data/nccf/com/rrfs/para/rrfs.20260813/06/rrfs.t06z.2dfld.13km.f006.na.grib2

# 1. --pattern: fails, no sidecar exists
zyra process convert-format "$URL" geotiff \
  --pattern 'COLMD:entire atmosphere.*Particulate organic matter dry' -o out.tif

# 2. --var: no name to match on; every candidate is "unknown"
zyra process convert-format "$URL" geotiff --var 'COLMD' -o out.tif

# For contrast, the same record on a sidecar-bearing source (the retired
# prototype bucket) selects correctly and transfers ~0.4 MB rather than 154 MB:
zyra process convert-format \
  https://noaa-rrfs-pds.s3.amazonaws.com/rrfs_public/rrfs.20260811/18/rrfs.t18z.2dfld.13km.f024.na.grib2 \
  geotiff --pattern 'COLMD:entire atmosphere.*Particulate organic matter dry' -o out.tif
```

## Possible shapes for a fix

Listed by how well they fit the existing surface; any one would unblock
this.

**A. Let `--pattern` fall back to a locally-computed inventory.** When
the `.idx` fetch 404s, fetch the file once and run the *same* regex
against an inventory generated locally (`wgrib2 -s`, or eccodes over the
messages). This adds no new vocabulary: one `--pattern` string keeps
working across sources, and only the transfer cost changes. Given that
cost is large, it probably wants to be opt-in — say
`--allow-full-fetch`, or a `--pattern-source auto|idx|local` — so nobody
silently pulls 360 MB per frame after a sidecar quietly disappears
upstream. This is the option we would find most useful, because it makes
existing pipelines portable between an S3 mirror and its origin without
being rewritten.

**B. Select on GRIB2 metadata directly.** Something like
`--grib-key discipline=0 --grib-key parameterCategory=20 --grib-key parameterNumber=1`
plus the qualifiers that actually disambiguate these records
(`typeOfLevel`, `level`, `forecastTime`, `aerosolType`). More precise
than regex-on-inventory-text and independent of local table coverage,
but it is a new selector surface to design and document.

**C. Give `convert-format`'s batch path a `wgrib2 -match` route.** Reuse
the existing block from `cmd_extract_variable` when wgrib2 is present,
the input is local (or has been fetched), and the output is GeoTIFF.
Narrowest change, but it leaves the URL case needing whichever of A or B
lands.

## What this is not asking for

- Not a change to `.idx` handling where a sidecar exists — that path
  works well and is why the pipelines were written against S3.
- Not unit rescaling or vector support (separate known gaps).
- Not a NOMADS-specific connector. The general shape is "an origin
  serves GRIB2 without a sidecar", which is common enough that a mirror
  going away shouldn't strand a pipeline.

Happy to test a branch against the RRFS files above, or to contribute
the fallback in **A** if that shape seems right.
