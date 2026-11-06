# Pipeline reference

The proven five-stage data-encoded shape, plus the placeholder grammar, palette
specs, metadata rules, and cadence. Copy
`assets/model-cycle-data-encoded.template.yaml` and adapt.

## Table of contents
1. Stage-by-stage
2. Placeholder grammar (and what it can't express)
3. Palettes + `cmap_inline`
4. Metadata template
5. Cadence / fps
6. Validator bounds

---

## 1. Stage-by-stage

**1. `process convert-format`** — fetch remote GRIB2 + subset one record + →
GeoTIFF (or NetCDF).
- `format: geotiff`
- `pattern: '<idx regex>'` — `.idx`-based subsetting; range-GETs only the
  matching record off S3 (efficient). Quote it (colons/spaces).
- `inputs: [ <templated S3 URL per forecast hour> ]` — `convert-format` fetches
  each URL directly; no `acquire` stage needed.
- `output_dir: /work/tif`
- `output_names: [ '{{valid_compact:...:OFFSET}}.tif', … ]` — name frames by
  **valid time** so `scan-frames` can recover the range and `compose-video`
  orders them. One `--var` (regex) is an alternative to `--pattern` for
  multi-var files, but `--pattern` is the efficient S3 path.

**2. `process reproject`** — 0–360 global grid → ±180 equirectangular, and
(optionally) regrid to the SOS frame size.
- `inputs:` / `output_dir: /work/wrapped` / `output_names:`
- `dst_bounds: [-180, -90, 180, 90]`
- `width: 4096` / `height: 2048` — **this** is where you upsize for data-encoded
  (resampling the data, not the luma). Omit to keep native 0.25° (1440×720),
  which is honest and lighter.

**3. `visualize heatmap`** — the data-encoded render (see the contract).
- `data_encoded: true`
- `color_scale_file: /work/color-scale.json` — **OUTPUT**; heatmap writes the
  sidecar here (stops/vmin/vmax/units/transparentRange).
- `cmap_inline: '<palette JSON>'` (preferred) **or** `cmap_file: <url/path>`.
- `units: "kg m-2"` — carried into the sidecar → shown in the hover readout.
- `vmin: 0`, `vmax: <p99.9>`.
- **No** `width`/`height`, **no** `basemap`. Renders at the (already-reprojected)
  native grid.

**4. `process scan-frames`** — derive the time range from valid-time frame names.
- `frames_dir: /work/images/frames`
- `datetime_format: "%Y%m%dT%H%M%S"` — matches `valid_compact`.
- `period_seconds: <cadence>` (e.g. `10800` for 3-hourly).
- `output: /work/frames-meta.json` — feeds the metadata template's `{{data_*}}`.
- Optional: skip it and date the metadata via `{{valid_iso:...}}` instead.

**5. `visualize compose-video`** — frames → MP4.
- `frames: /work/images/frames`
- `glob: "[0-9]*.png"` — matches valid-time-named frames; excludes stragglers.
- `output: /work/output/dataset.mp4` — must equal `WORKFLOW_OUTPUT_PATH`.
- `fps: 2` (say) — sets loop duration = frames/fps. **No `preset: sos`** (it
  rescales luma). `size: 4096x2048` is OK only if it *matches* the frame size
  (no-op); otherwise omit.

## 2. Placeholder grammar

Interpolated by the runner just before writing `pipeline.json`
(`src/types/zyra-pipeline-args.ts`). An **unresolved placeholder is a hard
failure** (a URL with a missing date would fetch garbage).

- `{{run_date}}` → `YYYY-MM-DD`; `{{run_id}}` → the run ULID.
- `{{cycle_date:INTERVAL:LAG}}` → `YYYYMMDD` of the latest available cycle;
  `{{cycle_hour:INTERVAL:LAG}}` → `HH`; `{{cycle_month:INTERVAL:LAG}}` →
  `YYYYMM` (for month-filed archives, e.g. NOAA OISST's
  `.../avhrr/YYYYMM/oisst-avhrr-v02r01.YYYYMMDD_preliminary.nc`). cycle =
  `floor((now−LAG)/INTERVAL)·INTERVAL`, epoch-anchored. INTERVAL/LAG are
  ISO-8601 durations. Give paired placeholders the same INTERVAL and LAG.
- **Look-back windows** (observations, not forecasts): vary the LAG per frame
  instead of using an offset. Offsets are forward-only.
  - `{{cycle_date:P1D:P3DT10H}}` … `{{cycle_date:P1D:P92DT10H}}` is the last
    90 UTC days.
  - Put the archive's posting hour into the LAG (`T10H` here). A run's hour
    can't be pinned (schedule phase follows save time, plus GHA jitter, plus
    "Run now"), so a bare `P3D` asks for a file that may not have posted yet.
  - Generate the per-frame lists, and check that `inputs[i]`, `output_names[i]`
    and every downstream `inputs[i]` render the same date.
  - `cycle_month` gives the month of a day; `P1M` is not accepted.
- `{{valid_iso:INTERVAL:LAG[:OFFSET]}}` → ISO valid time of a forecast hour
  (cycle + OFFSET). `{{valid_compact:…}}` → `YYYYMMDDTHHMMSS` (filename-safe;
  pairs with `--output-names` + `scan-frames --datetime-format %Y%m%dT%H%M%S`).
- `{{data_start}}`/`{{data_end}}`/`{{data_period}}` — metadata-only, from
  `frames-meta.json` (so they need a `scan-frames` stage).

**What it CANNOT express:** there is no day-of-year or 2-digit-year formatter.
Filenames like GSL THREDDS's `<YYDDDHHmm><FFF>` (year + day-of-year + hour +
minute + forecast hour) **cannot be templated** — which, combined with
Cloudflare, is why that source is a dead end. Use date-pathed S3 sources whose
names fit `{{cycle_date}}`/`{{cycle_hour}}`/`{{cycle_month}}`.

## 3. Palettes + `cmap_inline`

The `heatmap` data-encoded path colors *only* from a `--cmap-file` palette spec
(`--cmap` is ignored). Two spec shapes (`load_palette_spec`):

**Continuous** (smooth ramp from a named matplotlib colormap):
```json
{ "type": "continuous", "base": "YlOrBr", "transparent_range": 12, "blend_range": 48, "overall_alpha": 0.95 }
```
- `base`: any matplotlib colormap name. Pick a **light-starting** one
  (YlOrBr, Oranges, YlOrRd, Wistia) so faint values read on the black globe;
  dark-starting maps (copper, viridis) hide low values.
- `transparent_range`: entries (of 256) forced fully transparent — `12` (≈4.7%)
  is the aerosol convention (clear air drops out, plumes show).
- `blend_range`: entries fading alpha 0→1 after the transparent band.
- Convention: smoke `YlOrBr`, dust `Oranges`, keep species visually distinct.

**Classified** (discrete bands, e.g. operational dust categories):
```json
{ "type": "classified", "entries": [ {"Color":[R,G,B,A], "Upper Bound": n}, … ] }
```
≥2 entries, strictly increasing bounds, RGBA 0–255.

**`cmap_inline` (this repo)** — avoids hosting a palette file per dataset. Put
the palette JSON as a **string** arg on the heatmap stage:
```yaml
      cmap_inline: '{"type":"continuous","base":"Oranges","transparent_range":12,"blend_range":48,"overall_alpha":0.95}'
```
The runner (`materializeInlinePalettes` in `cli/zyra-publish-from-dispatch.ts`,
`--phase=fetch`) writes it to `/work/cmap-<stageIndex>.json` (the zero-based index of the stage
in `stages[]`), repoints `cmap_file`, and drops `cmap_inline` before `zyra run`.
It must sit on a `heatmap` stage — anywhere else is a hard error, since no other
command reads a palette file. It's a scalar string (passes the
validator), rides in `pipeline_json`, and hard-fails on invalid JSON. Bounded by
`MAX_PIPELINE_ARG_LENGTH` (2 KB). **Requires the deployed runner build to
include the materialize step** — before that, use a hosted `cmap_file` URL. (A
future publisher-form `palette_json` field can write into the same path.)

Hosting alternative: bundle palettes at `public/assets/palettes/*.json` →
served at `https://<node>/assets/palettes/<name>.json` → `cmap_file` that URL.

## 4. Metadata template

A JSON object; interpolated per run. **Allowed fields only:** `title`,
`abstract`, `categories`, `keywords`, `start_time`, `end_time`, `period`,
`license_spdx`, `license_url`, `license_statement`, `attribution_text`,
`organization`, `website_link`. **Allowed variables:** `run_date`, `run_id`,
`data_start/end/period`, `valid_iso`, `valid_compact`.

- Write a **plain-language** title/abstract (it shows on the globe) — no
  `COLMD`/`a2d_0p25`/jargon; put the technical attribution in
  `organization`/`attribution_text`.
- Self-updating dates without a `scan-frames` stage: `start_time:
  {{valid_iso:PT6H:PT9H}}`, `end_time: {{valid_iso:PT6H:PT9H:PTxxH}}` (last
  frame's offset), `period: PT3H`. (`data_*` need `scan-frames`; unresolved
  `data_*` drop with a warning rather than failing.)
- The dates render as ISO timestamps — that's the only date mechanism.

## 5. Cadence / fps

Frames = forecast hours you list (e.g. 3-hourly to f120 = 41). Bounded by
`MAX_PIPELINE_ARG_LIST_ITEMS` (128). `compose-video fps` sets the loop duration
(`frames / fps`); the downstream HLS transcode forces `-r 30` by **duplicating**
frames (duration preserved, luma untouched — safe for data-encoded). So a low
`fps` (2–6) gives a watchable multi-second loop; a high fps just makes a fast
blip. A `WARN: frame rate N ≠ 30 fps` in the log is advisory.

## 6. Validator bounds (functions/api/v1/_lib/workflow-validators)

Stage/command pairs must be on `ZYRA_STAGE_ALLOWLIST`
(`src/types/zyra-workflow-constants.ts` — note `thredds`/`sos` are **not**
allowlisted). Arg values must be scalars or bounded arrays of scalars (so a
palette must be a *string*, not a nested object). At least one arg must equal
`WORKFLOW_OUTPUT_PATH` (`/work/output/dataset.mp4`) or declare the frames dir.
Bounds: `MAX_PIPELINE_STAGES` 12, `MAX_PIPELINE_JSON_BYTES` 64 KiB,
`MAX_PIPELINE_ARG_LENGTH` 2 KB, `MAX_PIPELINE_ARG_LIST_ITEMS` 128.
