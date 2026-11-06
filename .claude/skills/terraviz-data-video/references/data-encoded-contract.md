# The data-encoded contract (with code-level why)

A data-encoded dataset is an **all-or-nothing pair**: the dataset row must carry
both `render_encoding: 'data-luma'` **and** a parseable `color_scale`. Any break
in that chain falls back to displaying the raw grayscale luma video — which for
a value-encoded frame looks near-black — with no recolor and no hover readout.
This is a *fail-closed* design: a half-configured dataset shows as the picture
it visibly is rather than throwing.

## Table of contents
1. How a dataset becomes colored (client path)
2. How the color scale gets attached (publish path)
3. The palette: why `--cmap` doesn't work
4. Why width/height and preset:sos are forbidden
5. vmin/vmax (and diverging fields)
6. The colorbar (and why a legend image is now the wrong tool)
7. Complete debugging map

---

## 1. How a dataset becomes colored (client path)

The client (SPA) gates recolor on the pair. Key files on `main`:

- `src/types/color-scale.ts` — `RENDER_ENCODING_DATA_LUMA = 'data-luma'`;
  `parseColorScale()` is fail-closed (returns `null` on any malformed sidecar).
- `src/services/dataService.ts` `dataEncodingFromWire()` — drops the pair unless
  `renderEncoding === 'data-luma'` **and** `parseColorScale(colorScale)`
  succeeds. Either missing → the dataset renders as a picture.
- `src/services/datasetOverlayOptions.ts` `dataEncodedScale()` — only forwards
  `colorScale` to the renderer when `renderEncoding === 'data-luma'`.
- `src/services/earthTileLayer.ts` `syncColorLut()` — no `colorScale` ⇒ returns
  `null`; the shader's `uDataEncoded` goes false and it draws the **raw texture**
  (the near-black grayscale). With the scale, it recolors via a 256×1 LUT.
- The hover **readout** (`src/services/mapRenderer.ts probeValueAt` →
  `datasetProbe.ts`) is gated on the *same* `colorScale`. So **if hover works,
  the scale is attached** — a crucial diagnostic. The colorbar and the Analyze
  panel hang off the same pair (§6).

A valid `color_scale` sidecar (what `parseColorScale` accepts):
```json
{ "stops": [ {"t":0,"rgba":[0,0,0,0]}, {"t":1,"rgba":[255,0,0,255]} ],
  "vmin": 0, "vmax": 50, "units": "kg m-2", "transparentRange": 0.047 }
```
Requires ≥2 stops (`t∈[0,1]`, `rgba` 4×[0,255]) and **finite, distinct**
vmin/vmax. `vmin === vmax` fails validation → drops to grayscale.

## 2. How the color scale gets attached (publish path)

The Zyra publish runner (`cli/zyra-publish-from-dispatch.ts`) attaches the pair:

- `deriveColorScalePath()` walks the pipeline's `heatmap` stages looking for the
  `--data-encoded` flag **and** `--color-scale-file` (both kebab and snake
  spellings). It **NO-OPs** (→ picture) when:
  - the flag is on a non-`heatmap` stage (`if (stage.command !== 'heatmap') continue`),
  - no `--data-encoded` on any heatmap stage,
  - `--data-encoded` present but **no `--color-scale-file`** (logs
    `WARN: … --data-encoded with no --color-scale-file — publishing as a picture`).
- `readColorScaleFields()` reads + validates the sidecar file; returns `{}` (→
  picture) if unreadable, over `COLOR_SCALE_MAX_CHARS` (16384), or fails
  `parseColorScale`. On success it PATCHes exactly two row fields:
  `render_encoding: 'data-luma'` and `color_scale: <raw json>`.

There is **no `color_scale_url`** field — the sidecar's JSON body is inlined
into the `color_scale` column. Server-side `validateRenderEncoding`
(`functions/api/v1/_lib/validators.ts`) enforces all-or-nothing both directions
(data-luma without a sidecar, or a sidecar without data-luma, are both rejected).

**Consequence:** if you ran zyra by hand and uploaded the MP4 yourself, none of
this ran → no scale attached → grayscale. Publishing must go through the Zyra
dispatch path.

## 3. The palette: why `--cmap` doesn't work

In zyra's `src/zyra/visualization/cli_heatmap.py`, the data-encoded path builds
the palette from **`--cmap-file` only**:
```python
palette = None
if getattr(ns, "cmap_file", None):
    palette = load_palette_spec(cmap_file)
scale = build_color_scale(palette, vmin=..., vmax=..., units=...)
```
A named `--cmap` (e.g. `YlOrBr`) is **ignored** here. And
`build_color_scale(None, ...)` produces *"a plain black→white ramp"*
(`luma_writer.py`). So `--data-encoded --cmap YlOrBr` with no `--cmap-file`
yields a **grayscale** globe with correct hover values — the single most
confusing symptom, because everything *looks* wired up.

Fix: supply the palette via `--cmap-file` (path/URL/s3) or, in this repo, the
`cmap_inline` convention (see pipeline-reference.md). `--legend-file` similarly
must be requested to emit a legend PNG, though a data-encoded dataset doesn't
need one on a current node (§6).

## 4. Why width/height and preset:sos are forbidden

`--data-encoded` writes each frame at the **native source grid** on purpose:
resizing would average values that were never measured, corrupting the encoding.
zyra hard-errors on `--width`/`--height` with `--data-encoded`.

To get a larger frame (e.g. the 4096×2048 SOS spec), **regrid the DATA upstream**
in the `reproject` stage (`width`/`height`/`dst_bounds` there). Reprojection
resamples the data grid — a legitimate operation — whereas resizing a rendered
luma PNG averages luma.

The same trap at the video stage: `compose-video preset: sos` "pins 4096×2048"
and **rescales** the frames → averages luma → corrupts values, and does so
*silently* (no error, just subtly wrong hover values). Use `size: WxH` matching
the actual frame size, or omit it. (Frame *duplication* to hit 30 fps in the
downstream transcode is safe — it copies frames, doesn't blend — so a low
compose `fps` is fine and controls the loop duration.)

## 5. vmin/vmax

Required with `data_encoded`. A `vmax` far above the data's real maximum maps
nearly every pixel into the low/transparent end → a near-black globe with faint
detail. This is *distinct* from "scale not attached": here the scale IS attached
(hover works, the colorbar shows), the coverage is just wrong. For a one-sided
field, set `vmax ≈ p99.9` of the field (sample it —
`scripts/sample_grib_range.py`). The colorbar's range stretch confirms the
diagnosis quickly: pull the high end down and the field appears, with every
hover value unchanged.

### Diverging fields

p99.9 is calibrated for "the rare tail is noise". In a diverging field (an
anomaly, a difference, a tendency) zero is mid-scale, and the rare tail is
often the event. NOAA OISST v2.1 `anom` sampled on 2026-11-04 had a global
p99.9 of about +6.5 °C, while on the days sampled from 25 October to 4 November
16–48% of Niño 1+2 cells sat above +6 °C during a strong El Niño. A p99.9
`vmax` clamps those cells to full luma, and clamped cells read back as exactly
`vmax`: the hover understates the event where people point, and Analyze reports
its maximum as a plateau rather than a point.

- **Symmetric limits**, `vmin = −vmax`. Zero lands mid-scale and the palette's
  neutral color means "normal". An asymmetric range moves the neutral point off
  zero and paints normal ocean slightly warm or cool.
- **Sized to the region of interest's extremes** over the whole window being
  published, not to a global percentile. Re-sample before enabling and widen
  the limits if the event grows. One luma code is `(vmax − vmin) / 255`, so the
  cost of a wider range is resolution (±8 °C is 0.063 °C per code).
- **Not the aerosol palette defaults.** `transparent_range: 12` hides the bottom
  12 of 256 entries and `blend_range: 48` fades the next 48, nearly half the
  cold side of a symmetric scale. On ±8 °C that hides everything below about
  −7.3 °C and fades everything up to about −4.2 °C, so the strongest cold
  values drop out while the warm side shows in full and the field reads as
  one-sided. Use a diverging base
  (`RdBu_r`) with `transparent_range: 1`, `blend_range: 0`,
  `overall_alpha: 1.0`.
- **No-data shares code 0 with `vmin`.** zyra's luma writer maps NaN (land) to
  code 0. On a one-sided field that is harmless, because zero is both the floor
  and "nothing here". On a diverging field code 0 is the coldest anomaly, so
  land would draw deep blue and hover as `vmin`. `transparent_range: 1` hides
  exactly code 0, so land goes clear, at the cost of a real value at `vmin`
  also reading as no data. The proper fix is zyra writing data into codes
  1–255 and emitting `dataMinLuma: 1`, which the client already honours
  (`src/types/color-scale.ts`). Separately, check that `reproject` kept the
  nodata tag: a source without one is filled with 0, which on an anomaly means
  "normal", so land would hover as `+0.00` and draw in the neutral color.

## 6. The colorbar (and why a legend image is now the wrong tool)

The `color_scale` drives three surfaces in the 2D app, all gated on the same
pair (§1): the globe recolor, the hover readout, and a floating **colorbar**
(`src/ui/colorbarUI.ts`, placed per panel by `refreshPanelLegends` in
`src/main.ts`). The bar samples the same LUT the shader receives
(`displayGradientStops`), with ticks at round values and the units beneath, so
it cannot disagree with the globe. It shows whenever Tools → Legend is on (the
default), including in single view with the info panel open. VR and the
multi-monitor outputs draw none.

Tapping the bar opens the display transforms
(`src/services/colorScaleDisplay.ts`, `docs/DATA_ANALYSIS_PLAN.md` §A1):
**palette** (Original, which is the publisher's ramp, or Viridis, Magma, Turbo,
Grayscale), **stretch** (spread the ramp over a sub-range so a skewed field
shows structure) and **threshold** (hide values outside a band). Each is a
rebuilt 256×1 LUT: one texture upload, live on playing video, and **never a
change to a reported value**. A stretched globe still hovers to the same
number. Tools → Analyze… works from the same scale: area-weighted statistics,
a histogram, transects, a zonal profile and CSV export over the displayed frame
(`src/ui/analyzeUI.ts`).

So a workflow-published data-encoded dataset needs **no legend asset**. The
Zyra publish PATCH attaches none, and none should be attached by hand. On a
data-encoded row the colorbar replaces a `legend_ref` image on the floating
legend, but the image still appears as the info-panel thumbnail
(`src/services/datasetLoader.ts`), and Orbit still sends it to a vision model
to describe (`initLegendForDataset`), next to the exact range Orbit already
reads from `colorScale`. A static PNG can't follow a palette swap, a stretch or
a re-tuned `vmax`, so it ends up contradicting the live bar.

**Removing one left over from the stopgap:** the publisher form can't do it.
It leaves an empty `legend_ref` out of the save, and the update endpoint treats
an absent field as unchanged. Send `{"legend_ref": null}` in a
`PUT /api/v1/publish/datasets/<id>`, which clears the column.

`scripts/make_legend.py` remains for the narrow cases where something reads
`legend_ref` and not `color_scale`: a node built from `main` before the colorbar
landed there (September 2026), and the web zip download, whose `manifest.json`
carries no color scale (`src/services/zipDownloadService.ts`), so a downloaded
data-encoded dataset is raw grayscale luma and a legend PNG is the only place
its range and units travel. Weigh that against the costs above before using it.

## 7. Complete debugging map

| Symptom | Cause | Fix |
|---|---|---|
| Black globe, detail on zoom/stretch | `vmax` too high | sample range, `vmax ≈ p99.9` (one-sided fields) |
| Grayscale w/ detail, **hover works** | palette grayscale (`--cmap` ignored / none) | add `cmap_inline`/`cmap_file` |
| Grayscale, **no hover, no colorbar** | scale not attached | check publish `WARN`; ensure `data_encoded`+`color_scale_file`; ensure dispatch-path publish; check row `render_encoding`/`color_scale` |
| Color+hover OK, no colorbar | Tools → Legend off (it gates the colorbar too), or a surface that draws none (VR, multi-monitor outputs) | turn Legend on |
| Static legend in the info panel disagrees with the colorbar | a `legend_ref` PNG on a data-encoded row | clear it with `{"legend_ref": null}` (§6) |
| Anomaly's core one flat color, hovers exactly `vmax`, Analyze max is a plateau | p99.9 limits on a diverging field | symmetric limits sized to the region's extremes (§5) |
| Anomaly's strongest cold values faint or missing | aerosol `transparent_range`/`blend_range` reused | `transparent_range: 1`, `blend_range: 0` (§5) |
| Land drawn deep blue / hovers as `vmin` on an anomaly | no-data shares code 0 with `vmin` | `transparent_range: 1`; check `reproject` kept nodata (§5) |
| Slightly-wrong hover values | luma rescaled | remove `preset: sos`/`width`/`height`; regrid in reproject |
| `... cannot be used with --data-encoded` | width/height on heatmap | remove them; regrid upstream |
| `403 Forbidden` on fetch | Cloudflare blocks CI IP | use S3/NODD source |
| `unrecognized arguments: --X` | pinned zyra lacks the arg / runner build predates a convention | check zyra version; `cmap_inline` needs the materialize-runner deployed |
