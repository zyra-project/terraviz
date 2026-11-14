# Data sources: reach, lineage, and the `.idx` recipe

## Cloudflare vs open S3 — pick a source a CI runner can fetch

The pipeline runs on a GitHub Actions runner (a datacenter IP). Many
`*.noaa.gov` sites — including `gsl.noaa.gov`'s THREDDS — sit behind Cloudflare
that **403s datacenter/bot IPs**. The failure looks like:
```
GET https://gsl.noaa.gov/thredds/fileServer/.../<file>  →  403
```
with `server: cloudflare` + a `cf-ray` header. This is **not** a pipeline bug —
no arg, retry, or acquire-method fixes it; the request is refused before THREDDS
sees it. (A browser User-Agent may or may not help depending on IP reputation;
don't rely on it.)

**Open S3 buckets (`*.s3.amazonaws.com`) have no such block.** NOAA Open Data
Dissemination (NODD) publishes many models to public buckets that fetch fine
from CI. Always check for an S3/NODD mirror before fighting Cloudflare.

Also note: zyra's `acquire http` fetches a **single URL** (no `--sync-dir`; that
is `acquire ftp`/`acquire thredds`). Model pipelines skip `acquire` entirely and
feed remote URLs straight into `convert-format --inputs` (which fetches them).

## GEFS-Aerosols = FV3-Chem, on open S3

NOAA's global FV3-Chem became **GEFS-Aerosols** when it went operational (2020),
and it's on the open bucket **`noaa-gefs-pds`**. So if someone points you at a
Cloudflare-walled GSL FV3-Chem product, GEFS-Aerosols on S3 is usually the same
family, reachable, and 0.25° GRIB2.

**Path grammar (0.25° chemistry product):**
```
https://noaa-gefs-pds.s3.amazonaws.com/gefs.{YYYYMMDD}/{HH}/chem/pgrb2ap25/gefs.chem.t{HH}z.a2d_0p25.f{NNN}.grib2
```
- Cycles: `00/06/12/18` UTC (6-hourly). Templatable with `{{cycle_date:PT6H:PT7H}}`
  / `{{cycle_hour:PT6H:PT7H}}` (LAG ~PT7H; bump to ~PT9H if late forecast hours
  404 before the full run posts).
- Forecast hours: **3-hourly to f120** (41 frames), `fNNN` zero-padded 3-digit.
- Also `pgrb2ap5/` (0.5°) alongside `pgrb2ap25/` (0.25°).

## Variable inventory: read the `.idx`

Every GRIB2 on S3 has a `<url>.idx` text sidecar — one line per record:
```
31:22682864:d=2026073106:COLMD:entire atmosphere:anl:aerosol=Particulate organic matter dry:aerosol_size <4.24e-08:
```
Fields: `record:byteOffset:date:VAR:level:fcst:aerosol=SPECIES:size:`. Fetch it
with a plain GET (no auth), find your field, and build a `convert-format
--pattern` regex that matches **exactly one** record.

**GEFS-Aerosols `a2d_0p25` fields that matter:**

| Want | `--pattern` regex | Notes |
|---|---|---|
| Column smoke | `COLMD:entire atmosphere:.*Particulate organic matter dry` | organic matter = dominant smoke mass. Add Black carbon for total carbonaceous (needs a sum step). |
| Column dust | `COLMD:entire atmosphere:.*Dust dry` | |
| Column sulfate | `COLMD:entire atmosphere:.*Sulphate dry` | |
| Column sea salt | `COLMD:entire atmosphere:.*Sea salt dry` | |
| Total column aerosol | `COLMD:entire atmosphere:.*Total aerosol` | includes all species; two size bins (<10µm, <2.5µm) — disambiguate on size |
| Aerosol Optical Depth | `AOTK:.*Total aerosol.*5.45e-07` | 550 nm total AOD; also per-species/wavelength |
| Surface PM2.5 / PM10 | `PMTF:surface` / `PMTC:surface` | near-surface, per species |

**Important:** GEFS-Aerosols has **no single "smoke" tracer and no `MASSDEN`**.
Smoke = carbonaceous aerosol = organic matter + black carbon. (`MASSDEN` on an
"entire atmosphere" level is the *RRFS-Smoke* encoding — a different, regional
model with a dedicated smoke tracer.) Don't blindly reuse a `MASSDEN` pattern
from an RRFS pipeline against GEFS.

Regex tip: don't hardcode the forecast-hour token (`anl` vs `12 hour fcst`) in
the pattern — it varies per file. Match on `VAR:level:.*SPECIES`.

## Confirming the record + value range

Run `scripts/sample_grib_range.py <s3-grib2-url> "<idx-regex>"`. It confirms the
regex matches one record and prints min/max/mean/percentiles. Use it to set
`vmax ≈ p99.9`. Observed GEFS column aerosols (kg m⁻²) run ~1e-6 background to
~7e-4 in heavy plumes; p99.9 is typically ~2–3e-4.

## Sea surface temperature: OISST v2.1 on NODD (NetCDF, not pipeline-ready)

NOAA's daily Optimum Interpolation SST v2.1 is on the open bucket
**`noaa-cdr-sea-surface-temp-optimum-interpolation-pds`**, which fetches from
CI like any NODD bucket:
```
https://noaa-cdr-sea-surface-temp-optimum-interpolation-pds.s3.amazonaws.com/data/v2.1/avhrr/{YYYYMM}/oisst-avhrr-v02r01.{YYYYMMDD}_preliminary.nc
```
- **NetCDF4**, one file per day, 0.25° (1440×720), carrying `sst`, `anom`,
  `err` and `ice`. `anom` is `int16` with `scale_factor 0.01` and
  `_FillValue −999` over land, units `Celsius`. Latitude runs south to north
  and longitude 0–360, so it needs the same `reproject` to ±180 as GEFS.
- **Preliminary ~D+2, final ~D+16.** The final drops the `_preliminary`
  suffix. In November 2026 preliminary files were still in the bucket after
  their finals landed; that is observed, not documented, so check before
  relying on it.
- `anom` is a **diverging** field: don't calibrate it with p99.9 or the
  aerosol palette defaults (SKILL.md §3 and §5,
  `references/data-encoded-contract.md` §5). The NODD file's own attributes
  don't name the anomaly's baseline period (checked November 2026), so confirm
  it from the producer's documentation before writing the description: every
  value on the globe is relative to it.

Two gaps stop a workflow from using it today:

- **zyra's `convert-format` cannot read NetCDF.** It routes every input
  through the GRIB-only `grib_decode`, so there is no NetCDF equivalent of the
  `.idx` `--pattern` path. A Tier 2 gap (`references/capability-gaps.md`).
  Neither obvious workaround works: `--format netcdf` passes the file through,
  but `heatmap` then receives a 4-D `(time, zlev, lat, lon)` array and refuses
  it; and pointing `reproject` at a GDAL subdataset (`NETCDF:<file>:anom`)
  returns the raw `int16` without `scale_factor`, so a +3.53 °C anomaly would
  hover as 353.
- **The placeholder grammar has no `YYYYMM` formatter.** The key's month
  directory can't be templated: `{{cycle_date}}` gives `YYYYMMDD`,
  `{{cycle_hour}}` gives `HH`, and the `valid_*` forms give whole instants
  (`src/types/zyra-pipeline-args.ts`). Adding one is a TerraViz change to that
  shared file, not a zyra one.
