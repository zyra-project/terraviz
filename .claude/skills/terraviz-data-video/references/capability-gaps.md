# Capability gaps: triage and escalation

When a request can't be built, the useful next step depends on *where* the wall
is. Three tiers, and they route to different places. Establish the tier before
proposing a fix — "zyra can't do it" and "terraviz won't allow it" look
identical from a failed run but need opposite work.

## The three tiers

### Tier 1 — TerraViz allowlist gap (zyra can, terraviz won't validate)
`ZYRA_STAGE_ALLOWLIST` in `src/types/zyra-workflow-constants.ts` is narrower
than zyra's actual command surface. A pipeline using an unlisted command fails
`/validate` with `stage_not_allowed` even though the container would run it.

Verified inventory (zyra `main` vs the allowlist):

| Stage | zyra provides | terraviz allows | **Blocked** |
|---|---|---|---|
| `acquire` | api, http, ftp, s3, thredds, vimeo | http, ftp, s3 | **thredds, api, vimeo** |
| `visualize` | animate, compose-video, contour, heatmap, interactive, sos, timeseries, vector | heatmap, contour, animate, compose-video | **sos, vector, timeseries, interactive** |
| `process` | convert-format, decode-grib2, extract-variable, reproject, metadata, scan-frames, pad-missing, api-json, enrich-*, update-dataset-json, audio/video-transcode | decode-grib2, extract-variable, convert-format, reproject, metadata, scan-frames, pad-missing | the non-raster ones |
| `export` | local, s3, ftp, post, vimeo | local | the rest (deliberate — publishing goes through the API) |

Notable consequences:
- **`acquire thredds`** is blocked, so a THREDDS `catalog.xml` source can't be
  used even though zyra has a purpose-built connector with `--sync-dir`,
  `--pattern`, and recursive catalog traversal.
- **`visualize sos`** is blocked — zyra's own SOS preset renderer (4096×2048
  PlateCarree, fixed vmin/vmax) that the FV3-Chem sample pipeline uses.
- **`visualize vector`** is blocked, so wind barbs / streamlines are off the
  table on the workflow path.

**Fix shape:** add the entry to the allowlist. The list is deliberately coupled
to the pinned runner container digest in `.github/workflows/zyra-run.yml` — so
the change is "add the command **and** confirm the pinned zyra version has it,"
bumping both together. File in the node's terraviz fork.

### Tier 2 — zyra capability gap (nobody can)
The command does not exist upstream. Three confirmed, all of which come up in
practice:

- **Arithmetic on values.** No `process` command multiplies a variable by a
  constant, sums two records, or subtracts a climatology. Readability is no
  longer the reason to want it: the client restates SI prefixes at display
  time (`src/types/unit-scale.ts`), so `3e-4 kg m-2` reads as `300 mg m-2`.
  What still can't be done is a real change of quantity: a unit change that
  isn't a prefix (kelvin to °C), smoke as organic matter + black carbon, or an
  anomaly against a baseline the node chose. Workarounds: pick a variable the
  producer already publishes in the form you want (AOD, a producer-computed
  anomaly), or accept the native one. Real upstream candidate.
- **NetCDF input to `convert-format`.** `convert-format` routes every input
  through the GRIB-only `grib_decode`, so a NetCDF source such as OISST v2.1
  (`references/data-sources.md`) can't enter the pipeline, even from an open
  bucket.
- **Vector / shapefile / GeoJSON geometry.** Nothing in `process` reads vector
  geometry; the toolkit is raster-only (GRIB2 / NetCDF / imagery). A request
  for "overlay these shapefile boundaries" or "render this GeoJSON as a layer"
  has no zyra path today.

**Fix shape:** an issue at `NOAA-GSL/zyra`. Precedent exists — `process
reproject` was added upstream (NOAA-GSL/zyra#295/#306) exactly this way and
then allowlisted here once the release landed.

### Tier 3 — TerraViz client/render gap (the pipeline could, the globe can't)
The data could be produced but nothing consumes it. Examples:
- **Diverging-aware display transforms.** The colorbar's palette swap
  (`src/services/colorScaleDisplay.ts`) offers only sequential ramps (Viridis,
  Magma, Turbo, Grayscale), so a viewer who swaps an anomaly's palette loses
  its zero, and the range stretch has no way to stay symmetric about zero. The
  publisher's own diverging ramp ("Original") is unaffected. Recorded as the
  unbuilt anomaly and difference display modes in
  `docs/DATA_ENCODED_VIDEO_PLAN.md` and `docs/DATA_ANALYSIS_PLAN.md`.
- **The color scale in a download.** The web zip's `manifest.json` carries no
  `color_scale`, so a downloaded data-encoded dataset is grayscale luma with no
  calibration. An open item in `docs/DATA_ENCODED_VIDEO_PLAN.md`.
- **Non-equirectangular sources** — the sphere shader, `photorealEarth`, and the
  thumbnail generator all assume 2:1 EPSG:4326. Reprojection is deliberately a
  zyra responsibility, never in-browser (`docs/ZYRA_INTEGRATION_PLAN.md`
  §Reprojection lives in Zyra).
- **Vector-field animation on the sphere** — even if `visualize vector` were
  allowlisted, the globe renders raster textures; animated particle/barb layers
  are a client feature, not a pipeline output.

**Fix shape:** an issue in the terraviz fork, usually against a plan doc.

## Triage checklist

1. Name the exact zyra command that would be needed. Check it against the table
   above (or re-read the capability JSON — see `references/data-sources.md` for
   the fetch pattern; those files are the source of truth and move).
2. If it exists upstream but isn't allowlisted → **Tier 1**.
3. If it doesn't exist upstream → **Tier 2**.
4. If the pipeline could emit it but the globe can't show it → **Tier 3**.
5. Say which tier, what the fix costs, and what the user can do *today* instead.
   A blocked request usually has a decent workaround (a different variable, a
   raster rendering of the same idea, a static asset) — offer it alongside the
   escalation rather than only reporting the wall.

## Filing the issue

Get explicit approval before opening anything — an issue is public and
outward-facing.

- **Terraviz fork** (`zyra-project/terraviz` or the node's own): reachable with
  the GitHub tools in a normal session. Reference the concrete pipeline that
  failed, the exact validator error, and the allowlist line to change.
- **Upstream** (`NOAA-GSL/zyra`): a different owner, so it may not be in the
  session's repo scope; if not, either start a session with it as a source or
  hand the user a ready-to-paste issue body. Include: the zyra version, the
  command you wish existed, the concrete dataset/use case, and what you did
  instead — upstream maintainers can act on a specific unmet need far better
  than on "please add vector support".

Good issue content, in both places: the real pipeline YAML (trimmed), the
verbatim error, the data source URL, and the user-visible consequence ("the
daily SST anomaly can't go on the globe at all, because its only reachable
source is NetCDF") — the consequence is what motivates a fix.
