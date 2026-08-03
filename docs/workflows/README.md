# Ready-to-run Zyra workflows

Status: draft for review

Workflow pipelines validated against this repo's own validators, with
their sources confirmed reachable and correctly georeferenced, but not
curated into the publisher portal. Each entry is a pair:

| File | Role |
|---|---|
| `<name>.yaml` | the `pipeline_json` body — paste into **Publish → Workflows → New**, or `POST /api/v1/publish/workflows` |
| `<name>.metadata.json` | the metadata sidecar for the same workflow |

These are deliberately *not* in
[`src/ui/publisher/workflow-templates.ts`](../../src/ui/publisher/workflow-templates.ts).
That file is the curated in-product palette, is covered by
`cli/lib/workflow-templates.test.ts`, and carries an i18n label per
entry. A recipe lands here first; promoting one is a separate change.

The authoring contract these follow — the data-encoded rules, the
palette format, the placeholder grammar — is the `terraviz-data-video`
skill at [`.claude/skills/terraviz-data-video/`](../../.claude/skills/terraviz-data-video/),
with the surrounding design in [`ZYRA_INTEGRATION_PLAN.md`](../ZYRA_INTEGRATION_PLAN.md)
and [`DATA_ENCODED_VIDEO_PLAN.md`](../DATA_ENCODED_VIDEO_PLAN.md).

---

## `emodnet-cargo-vessel-density` — Cargo Ships at Sea

Ninety-six monthly frames of cargo-vessel density, January 2017 through
December 2024, rendered data-encoded so the globe recolours it
client-side and hovering reports a real number.

### What it shows

Each pixel is the number of ship-hours cargo vessels spent in that
square kilometre during the month, derived from AIS — the transponder
broadcast every large ship carries. The result is the shipping network
drawn by the ships themselves, with the chokepoints standing out as the
brightest knots: Gibraltar, the Dover Strait, the Bosphorus, the
approaches to Rotterdam and Hamburg.

### Source

| | |
|---|---|
| Service | EMODnet Human Activities WCS, `emodnet__vesseldensity_09` (*"Vessel Density Monthly totals - Cargo"*) |
| Endpoint | `https://ows.emodnet-humanactivities.eu/geoserver/wcs` |
| Units | hours per km² per month |
| Native grid | 1×1 km, EPSG:3857 |
| Time domain | 2017-01-01 → 2024-12-01, monthly |
| Licence | CC-BY 4.0 — *"This data was downloaded from the EMODnet Portal. The data originator is Cogea Srl."* |
| Upstream AIS | purchased from CLS and ORBCOMM |

No credentials, plain HTTPS GET, answers fine from a datacenter IP —
the Cloudflare-403 problem that killed the GSL FV3-Chem attempt does
not apply. The service also reprojects server-side, so frames arrive
already in EPSG:4326.

### Coverage is European, and that is the main tradeoff

`DescribeCoverage` advertises an envelope of roughly 87°W–98°E,
15°N–87°N. **That envelope is misleading** — it is the bounding box of
the EPSG:3857 mosaic footprint reprojected to EPSG:4326, not where
data exists. Probing the actual raster, non-zero cells span only
**41°W–68°E, 25°N–79°N**, and the useful mass is narrower still.

Confirmed present: the North Sea, Channel, Irish Sea, Baltic, Biscay,
the whole Mediterranean, the Black Sea, the Norwegian and Barents
Seas, the Atlantic approaches out past the Azores, and the Canaries.

Confirmed **absent** — these return nodata, not zero: the Red Sea and
Suez transit, the Arabian Sea and India, Malacca and Singapore, Panama,
the western Atlantic seaboard, and the entire Pacific. After
reprojection onto the global frame, **5.5% of the globe carries data
and 94.5% is transparent nodata.** On the sphere this reads as a
bright European region, not a worldwide layer. Anything framed as
"global shipping lanes" is not this dataset.

The alternative considered was the World Bank / IMF
[Global Shipping Traffic Density](https://datacatalog.worldbank.org/search/dataset/0037580/global-shipping-traffic-density)
(CC-BY 4.0), which genuinely is global and is the familiar worldwide
lane map. It was rejected here because it ships only as ~480 MB ZIP
archives — zyra has no decompression stage — and because it is a
single static 2015–2021 aggregate, so it animates nothing. Publishing
it means a one-time offline prep (unzip, downsample from 72000×36000,
host the result) rather than a workflow. It remains a good companion
dataset; it just isn't this one.

### Non-goals

- **Individual vessel tracks.** Routes as lines, or ships as moving
  points, are not buildable on the workflow path. Three separate walls:
  zyra reads no vector geometry (raster-only), `visualize vector` is
  not on `ZYRA_STAGE_ALLOWLIST`, and the globe renders raster textures
  rather than animated vector layers. See
  [`capability-gaps.md`](../../.claude/skills/terraviz-data-video/references/capability-gaps.md).
- **Live traffic.** A fixed historical archive. EMODnet republishes
  annually, so there is no cycle arithmetic to template and this is a
  one-shot build, not a scheduled refresh.

### Calibration, and what it costs

`vmin: 0`, `vmax: 10`. Measured on the frames the pipeline actually
produces (2728×1214 requests, ~0.088°/px):

| Month | p90 | p99 | max | % of non-zero cells clipped at vmax=10 |
|---|---|---|---|---|
| 2017-01 | 0.45 | 5.68 | 3874 | 0.5% |
| 2018-07 | 0.56 | 6.06 | 3335 | 0.6% |
| 2020-04 | 0.51 | 5.92 | 2792 | 0.6% |
| 2022-03 | 0.63 | 7.64 | 4320 | 0.8% |
| 2024-12 | 0.76 | 8.50 | 5103 | 0.8% |

The skill's usual rule is `vmax ≈ p99.9`, which here is ~106 and would
render the lane network essentially black. That rule assumes a roughly
normal field; this one is strongly log-normal, with port basins three
orders of magnitude above the median (pooled p50 = 0.065). zyra has no
log transform — a confirmed Tier-2 gap — so the encoder is linear and
something has to give.

`vmax: 10` spends the ramp on the lanes and clips under 1% of non-zero
cells. **That clipping is a real cost, stated plainly: above
10 h/km²/month the hover readout under-reports, so a busy port basin
reads "10" rather than its true value.** Lanes are the subject here;
ports clip.

`transparent_range: 2` (rather than the aerosol convention of 12) is
the other choice. At vmax=10 it hides values below 0.078, keeping ~45%
of non-zero cells visible; 12 would keep ~12% and erase most of the
network. True zero-density water and the −9999 nodata fill both land
on luma 0 and stay transparent either way.

### Four things in the pipeline that look wrong and aren't

All four are commented in the YAML, and each was verified against
zyra's source or the live service rather than assumed.

1. **The fetch is `acquire http --inputs`, not `process
   convert-format`.** Every other data-encoded pipeline here opens with
   `convert-format` fed remote URLs. That works for GRIB2 because
   `convert-format` runs its bytes through `grib_decode()`
   unconditionally — it has a NetCDF pass-through and nothing else, so
   handing it a GeoTIFF fails. `acquire http` takes `--inputs` plus
   `--output-dir` and is the correct multi-URL fetch.

2. **Every URL ends in `&name=/<frame>.tif`.** `acquire http --inputs`
   names each download `Path(url).name`, which for a bare WCS request
   is the entire query string — 200-odd unusable characters. GeoServer
   ignores the unknown `name` parameter (verified: byte-identical
   response with and without it), and adding it moves the URL's last
   `/` to just before the filename we want. Every frame lands as
   `/work/tif/YYYYMMDDT000000.tif`, which the downstream stages and the
   frame ordering both depend on.

3. **The quotes in `subset=time(%22…%22)` must stay percent-encoded.**
   A raw `"` makes Tomcat reject the request target with a bare HTTP
   400 before GeoServer ever sees it.

4. **`url:` is the bare endpoint and is never fetched.** It is the
   required argparse positional for `acquire http`; in `--inputs` mode
   `_cmd_http` returns before reading it.

### Why WCS 2.0.1 rather than the shorter 1.0.0 request

WCS 1.0.0 takes a `BBOX` + `CRS` + `WIDTH`/`HEIGHT` request that is
~100 characters shorter per frame. **It is silently wrong on this
server.** It returns a raster tagged with the bounds you asked for but
filled from the wrong window of the mosaic — a request framed on the
Mediterranean came back holding Baltic pixels, with the Channel,
Gibraltar and Biscay all empty. Nothing about the response signals the
error; only probing known chokepoints against known land surfaces it.

WCS 2.0.1 with `outputCrs=EPSG:4326` georeferences correctly, verified
by probing Gibraltar, the Dover Strait, the Bosphorus, Rotterdam and
Port Said (all carry traffic) against the Sahara, the Alps and inland
Ukraine (all nodata). The compact spellings `outputCrs=EPSG:4326` and
`scaleSize=i(2728),j(1214)` return byte-identical responses to the full
OGC URI forms, so the short forms are used.

Spatial subsetting is ignored by this server however it is asked — in
native `X`/`Y`, or as `Lat`/`Long` with `subsettingCrs`. Rather than
fight it, the request takes the server's full 2728×1214 window (stable
across all months at −117.26,−16.72 → 122.53,90.0) and lets `reproject`
crop and pad it onto the global frame from each frame's own embedded
transform. That also makes per-frame extent drift a non-issue.

The request size is chosen to match: 2728×1214 over that window is
0.0879°/px, within rounding of the 4096×2048 global grid's
0.087890625°/px. With `resampling: nearest` the warp is close to a
paste — a local simulation of the reproject stage carried all 57 743
non-zero values of the 2024-12 frame through unchanged.

### Output, and the one manual step after publishing

The pipeline ends on the frame set at `/work/images/frames` rather than
an MP4. `/validate` accepts that in place of `WORKFLOW_OUTPUT_PATH`,
and it avoids a second lossy generation over pixels whose luma carries
the data.

The cost is that **`playback_fps` must be set on the dataset row by
hand**, or 96 frames play in about three seconds. Around `8` gives a
twelve-second loop.

There is also no automatic gradient legend on `main`, so one is
committed alongside the workflow:
[`emodnet-cargo-vessel-density.legend.png`](emodnet-cargo-vessel-density.legend.png)
(1350×330, opaque RGB). Attach it as the dataset's `legend_ref` via
Publish → Media. It carries the clipping caveat on its face — the high
end is labelled *"busiest lanes · 10+ clips"* — so the legend does not
imply a precision the encoding cannot deliver.

It was generated by the skill's `scripts/make_legend.py`:

```bash
python3 .claude/skills/terraviz-data-video/scripts/make_legend.py \
  --title "Cargo Ships at Sea" \
  --subtitle "Cargo-vessel density from AIS (EMODnet Human Activities)" \
  --cmap cool --vmin 0 --vmax 10 --units "hours per km² per month" \
  --low "quiet water" --high "busiest lanes · 10+ clips" \
  --out docs/workflows/emodnet-cargo-vessel-density.legend.png
```

Regenerate it if `vmax` or the palette `base` ever change — a legend
that disagrees with the globe is worse than none. The `color_scale`
sidecar drives the hover readout either way.

### Runtime budget

Each WCS request takes **~26 s**, dominated by server-side mosaic
reprojection rather than transfer — a half-size request costs the same
26 s, which is why the frames are requested at full resolution. Ninety-
six frames is therefore **~42 minutes of fetching** and ~1.5 GB
downloaded, against `zyra-run.yml`'s 120-minute `timeout-minutes` on
`ubuntu-22.04`. Reproject and heatmap have not been timed.

Intermediates are the other pressure: 96 frames at 4096×2048 float32 is
~3.2 GB in `/work/wrapped` on top of the 1.5 GB of source.

If a run times out or runs out of disk, **cut frames from the front** —
dropping 2017–2018 leaves 72 frames and about a third off both numbers,
and the recent years carry more of the interest.

### Verification already run

| Check | Result |
|---|---|
| `validatePipeline` (the same code `/validate` runs) | OK |
| `validateMetadataTemplate` | OK |
| Placeholder interpolation | no unresolved `{{` |
| `materializeInlinePalettes` | writes `cmap-2.json`, repoints `cmap_file` |
| Data-encoded contract | `data_encoded: true`, no `width`/`height`, no `basemap` |
| Pipeline size | 3 stages, 96 items/list, 33 632 B (51% of the 64 KiB bound) |
| Source reachability | sampled frames across 2017–2024 all HTTP 200, `image/tiff`, stable 2728×1214 extent |
| Georeferencing | chokepoints carry traffic, land and out-of-coverage ocean are nodata |
| Reproject simulation | local rasterio warp to 4096×2048 preserves every non-zero value |

**Not yet run: the workflow itself.** It has never executed end to end
on a runner, so the stage arguments are validated but not *proven*.
Run it once against a node before trusting the output.

### Extending it to new years

EMODnet adds a year at a time. To pick up 2025, append twelve entries to
each of the three `inputs` lists following the existing pattern —
`subset=time(%222025-MM-01T00:00:00.000Z%22)` and
`&name=/2025MM01T000000.tif` — and move `end_time` in the metadata
sidecar. Lists cap at 128 items (`MAX_PIPELINE_ARG_LIST_ITEMS`), so
there is room for two and a half more years before the frame count
rather than the byte budget binds. Confirm the months exist first:

```bash
curl -s "https://ows.emodnet-humanactivities.eu/geoserver/wcs?service=WCS&version=2.0.1\
&request=DescribeCoverage&coverageId=emodnet__vesseldensity_09" | grep -o 'timePosition>[^<]*' | tail -5
```

Other ship types are the same coverage with a different two-digit code
(`01` fishing, `08` passenger, `09` cargo, `10` tanker, `all`), so a
tanker-traffic variant is a search-and-replace on `vesseldensity_09`
plus fresh `vmin`/`vmax` sampling.
