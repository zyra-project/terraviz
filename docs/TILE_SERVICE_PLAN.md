# Tile Service and Decimation Plan — Serving TerraViz Datasets to Outside Tools

**Status: draft for review.** Nothing in this document has been built.
It answers two linked questions. First, what would TerraViz have to
serve so that its datasets can be used *outside* TerraViz — in ArcGIS
Online and Hub, in the OpenSpace planetarium software, in Second Life,
on Science On a Sphere systems and spherical displays, and in desktop
and web GIS tools? Second, since each of those tools wants the data at
a different size, pace and precision, how should TerraViz *decimate*
it — reduce it in space, in time and in bit depth — so that what each
tool shows is still true to the data? The research behind it is desk
research (vendor documentation, source code and release notes, cited
in the sources section), not hands-on testing, except where a sibling
document already records a test.

**Last reviewed:** 2026-11-06 (first draft, from desk research on each
consumer.)

**Revisit when any of the following becomes true:**

- A consumer in §2 ships a capability this plan assumes it lacks, or
  drops one it assumes it has: the ArcGIS Map Viewer time slider for
  WMTS layers, the OpenSpace video layer, OGC API Tiles support in
  ArcGIS or OpenSpace.
- Phase D1 of §7 (the hand-built tile prototype) has run against
  OpenSpace and QGIS. Its result decides most of §5.
- The STAC API (`docs/metadata/PHASE4_IMPLEMENTATION.md`) clears its
  rollout gate, or is withdrawn. §4.3 leans on it.
- A funded partner names a consumer this plan does not cover.

**Companions.** [`metadata/README.md`](metadata/README.md) (the STAC
projection this plan's catalog channel builds on),
[`SECOND_LIFE_COMPAT.md`](SECOND_LIFE_COMPAT.md) (the in-world globe,
which this plan does not repeat),
[`EMBED_URL_GRAMMAR.md`](EMBED_URL_GRAMMAR.md) (the embed and output-page
URLs), [`CATALOG_IMAGE_SEQUENCE_PLAN.md`](CATALOG_IMAGE_SEQUENCE_PLAN.md)
(where frames come from), and
[`architecture/federation-scoping.md`](architecture/federation-scoping.md)
(the vendor-neutrality goal §3 adopts).

---

## Purpose

A partner who heard about TerraViz from an Esri representative, a
planetarium producer who runs OpenSpace, and a museum educator in
Second Life all ask the same thing: *can I show your datasets in my
tool?* Today the honest answer is "only by embedding TerraViz itself".
Each of those tools reads data in its own way, and TerraViz speaks
almost none of them.

The temptation is to answer each request with a bespoke export — an
ArcGIS publishing script here, an OpenSpace asset there. This plan
argues for the opposite: a small number of **channels**, each built on
an open standard that several consumers already read, so that one piece
of work serves many tools. It names the channels, says which consumer
each serves and how well, designs the one channel that does not exist
yet in any form (a tile service), and orders the work.

**Decimation is where that one piece of work can quietly go wrong.**
Every consumer asks for less than the node holds: a lower zoom level, a
coarser time step, a smaller video, fewer colours. How the node makes
"less" decides whether a smoke plume survives the zoom-out, whether a
diverging palette keeps its meaning, and whether an hourly field
stepped daily shows the same hour of the day forever. §6 sets those
rules. They matter more than the URL grammar, because a wrong URL fails
loudly and a wrong decimation draws a plausible picture of something
the data never said.

Every channel below serves from the node; none pushes data into
another organisation's system without that organisation pulling it,
with one deliberate exception (§4.2's ArcGIS Image adapter, which an
operator runs with their own credentials).

---

## 1. What TerraViz can offer today

A short inventory, because the gap analysis in §3 depends on it. Each
row says what exists and what it is good for outside TerraViz.

| Surface | Where | What an outside tool gets |
|---|---|---|
| **Frames** — full-globe 2:1 equirectangular images (PNG / JPEG / WebP) in plain latitude/longitude | R2; enumerated by `GET /api/v1/datasets/{id}/frames` (`functions/api/v1/datasets/[id]/frames.ts`) | Per-frame URL, timestamp (`start_time + period × index`) and digest, with `from`/`to` and closest-frame `at` queries. Image-sequence uploads keep their source frames in R2 permanently (`CATALOG_IMAGE_SEQUENCE_PLAN.md`), and Zyra workflow runs publish theirs through the same path (`cli/lib/frames-publish.ts`). These are the raw material for every channel below. |
| **Video** — MP4 and an HLS ladder, up to 4096×2048; data-encoded video is pinned to one 4096×2048 rung | `cli/lib/ffmpeg-hls.ts:109`, R2 `videos/{id}/…` | Playable equirectangular video. Usable directly by anything that maps a video onto a sphere; useless to GIS tools, which need georeferenced rasters or tiles. |
| **Data-encoded frames and video** — luma encodes a physical value; `color_scale` sidecar gives the mapping | `src/types/color-scale.ts` | Real values, but only to a reader that knows the encoding. Everyone else sees grey. Quantised to 256 levels by design. |
| **Overlay metadata** — `boundingBox`, `lonOrigin`, `isFlippedInY` | `src/types/index.ts:125-143` | How to place a frame that is not a standard full globe. Every export must apply these, or regional and shifted datasets land in the wrong place. |
| **STAC API 1.0.0** — collections and items over the published catalog, OGC API Features core + GeoJSON conformance, open CORS, no auth | `/api/v1/stac`; `functions/api/v1/_lib/stac-service.ts:7` | A standards-based catalog any STAC client or OGC API Features client can read. Tested against QGIS, PySTAC Client, STAC Browser (`functions/api/v1/stac/clients.test.ts`). Gated by `STAC_ENABLED` and waiting on its rollout gate (`docs/metadata/PHASE4_IMPLEMENTATION.md`). Assets are the frames and videos above — not georeferenced rasters. |
| **Native catalog and federation feed** | `/api/v1/catalog`, `/.well-known/terraviz.json` | TerraViz-to-TerraViz only. Out of scope here. |
| **Events** — approved current events with geometry and linked datasets | `GET /api/v1/events` (`functions/api/v1/events.ts`) | Custom JSON, not GeoJSON. A GIS tool cannot read it without a converter. |
| **Embed** — the whole app in an iframe, minimal chrome | `?embed=1` (`EMBED_URL_GRAMMAR.md`), governed by the node's embedding policy (`src/types/node-embedding.ts`) | The TerraViz experience inside another page: a Hub site, a StoryMap, a WordPress page. |
| **Output page, web mode** — a 2:1 equirectangular frame rendered for a sphere's texture, steered by URL | `output.html` (`src/output/webMode.ts`, `EMBED_URL_GRAMMAR.md` §The output page) | Built for Second Life media-on-a-prim (`SECOND_LIFE_COMPAT.md` §7). Any host that drapes a web page over a sphere can use it. |
| **Zip download** — a dataset's assets plus a `manifest.json` | `src/services/zipDownloadService.ts` (web only) | Offline copies for a person; not an API. |

Two facts from this table shape everything after it.

**The frames are already in the right shape for geographic tiling.**
A full-globe 2:1 image in plain latitude/longitude divides exactly into
the standard geographic tile grid (§5.1). Producing those tiles is
cutting and shrinking — no reprojection, no resampling across a seam.
The expensive part of a tile service is usually reprojection; TerraViz
mostly does not need it.

**Nothing TerraViz serves today is a georeferenced raster.** A frame is
a picture whose placement is described in metadata, not embedded in the
file. GIS tools need the placement in the file (a GeoTIFF) or in the
service (a tile grid). That is the gap.

<!-- §2 consumer survey: filled from research -->

<!-- §3 capability matrix: filled from research -->

<!-- §4 strategy: filled from research -->

---

## 5. The tile service

The one channel that does not exist yet in any form, and the one most
consumers share. This section is a design sketch for review, not a
specification; Phase D1 (§7) exists to test it before anything is
built.

### 5.1 Tile grids

**Primary: WorldCRS84Quad** (OGC Two Dimensional Tile Matrix Set
standard, OGC 17-083r4). Plain latitude/longitude, origin at
(−180°, 90°), two 180°×180° tiles at level 0, each level splitting every
tile into four, 256-pixel tiles.

| Level | Tiles across × down | Image width it fills exactly |
|---|---|---|
| 0 | 2 × 1 | 512 |
| 1 | 4 × 2 | 1024 |
| 2 | 8 × 4 | 2048 |
| 3 | 16 × 8 | 4096 |
| 4 | 32 × 16 | 8192 |

A W×W/2 frame fills level *n* exactly when W = 512 × 2ⁿ, so the
catalog's 4096×2048 frames stop at level 3: **170 tiles per frame**
(2 + 8 + 32 + 128). Every tile edge falls on a pixel boundary of the
source image at its native level, which is why cutting needs no
resampling at the deepest level and only 2×2 decimation above it.
Frames at other widths — a 0.1° science grid is 3600 wide, a 0.25° one
1440 — are handled in §6.1.

**Secondary: WebMercatorQuad** (`GoogleMapsCompatible`), for clients
whose basemaps are Web Mercator and which require the tile grid to
match the basemap (ArcGIS Map Viewer in 2D; most XYZ web maps). This
grid *does* need reprojection, and it cannot show latitudes beyond
about ±85.05°, so every polar dataset loses its poles in it. That is a
property of the projection, not of the implementation, and the
capabilities document should say so in each layer's abstract.

**Not adopted: GIBS's own geographic tile matrix sets.** GIBS's
EPSG:4326 sets are sized to its native product resolutions (250 m,
500 m, 2 km…) rather than to a 2:1 image, so their level-0 tiles do not
cover exactly 180°. Copying them would buy URL compatibility with
existing GIBS configurations at the cost of resampling every frame.
Copying GIBS's *URL grammar* (§5.2) while using the standard grid gets
most of the benefit; a client that reads the capabilities document, or
GDAL with an explicit data window, handles the difference. This is a
judgement call — §9 lists it as an open question.

### 5.2 URL grammar

RESTful, shaped like GIBS so that a configuration written for a GIBS
layer is adapted by changing the host, the layer and the tile matrix
set — not the structure:

```
GIBS:      /wmts/epsg4326/best/{Layer}/default/{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.{ext}
TerraViz:  /api/v1/wmts/epsg4326/{datasetId}/{style}/{time}/WorldCRS84Quad/{z}/{y}/{x}.{ext}
           /api/v1/wmts/epsg3857/{datasetId}/{style}/{time}/WebMercatorQuad/{z}/{y}/{x}.{ext}
           /api/v1/wmts/1.0.0/WMTSCapabilities.xml
```

- `{datasetId}` is the catalog ULID, which is stable; slugs can change.
- `{style}` is `default` in v1 (§5.4).
- `{ext}` is `png` (alpha) or `jpg` (opaque); WebP is not offered,
  because GDAL builds and GIS clients do not uniformly read it.
- KVP `GetTile` requests are accepted and mapped onto the same handler,
  since some clients only issue KVP.

Living under `/api/v1/` puts the service inside the node's existing
versioned surface: a breaking change is a `/v2/`, and the contract is
pinned in `docs/protocol/` the way STAC's is (§6).

### 5.3 Time

- **The dimension is `Time`, in ISO 8601 UTC**, declared per layer in
  the capabilities document. Because frame times are computed as
  `start_time + period × index`, most layers can declare a compact
  `start/end/period` interval rather than listing every frame; a
  dataset with irregular frames lists them.
- **A requested time snaps to a frame.** Clients that animate on a
  fixed step (OpenSpace's temporal layers round the simulation time to
  a configured resolution) will ask for times that are not frame times.
  A tile request for a time inside the dataset's span returns the
  frame at or before it, not a 404. The existing `/frames?at=` query
  returns the *closest* frame; the tile service should not silently
  differ from it, so which rule to use is open (§9).
- **`default` is the latest frame**, matching GIBS, so a client that
  sends no time gets the most recent picture.
- **Datasets with no real time axis** — a looping diagram animation, a
  "typical year" climatology — are not tiled in v1. Exposing a frame
  index as a non-time dimension is valid WMTS, but almost no client
  animates anything but `Time`, so it would publish layers nobody can
  play.

### 5.4 Styles

- **`default`** — what the TerraViz globe shows. For an RGB dataset
  that is the frame. For a data-encoded dataset it is the frame with the
  dataset's own palette applied, through the same `buildColorScaleLut`
  the shaders sample (`src/types/color-scale.ts`), so a tile and the
  globe cannot disagree about colour. `transparentRange` and the
  no-data band become alpha.
- **Raw luma tiles are not offered.** A grey tile with a sidecar is
  useful only to a client that knows TerraViz's encoding, and those
  clients are TerraViz. Analysis on values goes through §4.2's rasters,
  which carry real numbers rather than a 256-level code.
- **How a style's lower levels are made is not a style choice.** It is
  set per dataset by what the data is (§6.1), because the same field
  decimated two ways is two different claims about the world.

### 5.5 Normalising a frame before cutting

Every frame is brought to one canonical orientation before it is cut,
using the overlay metadata the renderers already honour
(`src/types/index.ts:125-143`):

- **`isFlippedInY`** — flip to north-up.
- **`lonOrigin`** — rotate so the left edge is −180°.
- **`boundingBox`** — a regional frame is placed into its box on a
  transparent full-globe canvas, or, cheaper, cut only for the tiles it
  touches, with the rest returning an empty tile.

These three are where an export most easily goes wrong. The renderers
record a US bounding box landing over the South Pacific once already
(`src/services/photorealEarth.ts:676`, `src/output/layerStack.ts:711`).
The cutter should be tested against the probe the hover readout uses
(`src/services/datasetProbe.ts:45`, `latLonToTexelUv`) rather than
against its own idea of where a texel lands.

### 5.6 Where tiles are made and kept

- **Cut at publish time, in the GitHub Actions runner** that already
  transcodes uploads (`cli/transcode-from-dispatch.ts`,
  `.github/workflows/transcode-hls.yml`) and runs Zyra workflows
  (`cli/zyra-publish-from-dispatch.ts`), with GDAL. Not on request: a
  Pages Function decoding a 4096×2048 PNG per tile would spend the CPU
  budget the STAC rollout gate is already measuring.
- **Stored in R2** under a content-addressed prefix keyed by the frame's
  digest, the pattern `cli/lib/frame-store.ts` uses for frames, so a
  re-published dataset re-cuts only frames that changed and a frame
  shared by two datasets is cut once.
- **Served by a Pages Function** that resolves `{time}` to a frame,
  reads the tile from R2, and caches at the edge. A Function in front
  (rather than a public bucket URL) is what makes time snapping, KVP
  requests, CORS and visibility checks possible. Its cost is one Worker
  invocation per tile request; at Cloudflare's request pricing that is
  small next to the storage, but it is not zero, and §9 asks whether
  exact-time tiles should also be reachable straight from the bucket.
- **Visibility follows the catalog.** Only public, published,
  non-retracted datasets get tiles, the same predicate the STAC
  projection uses (`functions/api/v1/_lib/metadata-readiness.ts`), and a retraction removes the
  layer from the capabilities document at once and the tiles at the
  next sweep.

### 5.7 Capabilities and companions

The WMTS capabilities document is generated by a Function from D1: one
layer per eligible dataset, its time dimension, both tile matrix sets,
the abstract, attribution and licence from the catalog record. Beside
it, cheap per-layer companions for clients that do not read WMTS
capabilities:

- **TileJSON** for MapLibre and other XYZ web maps.
- **A GDAL WMS XML** per layer, which is what OpenSpace and any
  GDAL-based tool loads (§2.2).
- **STAC links** — each item gains `wmts` / `xyz` links under the STAC
  web-map-links extension, so a STAC client finds the tiles from the
  catalog it already reads (§4.3).

### 5.8 Cost, roughly

Order-of-magnitude only; Phase D1 replaces these with measurements.

| Quantity | Estimate |
|---|---|
| Tiles per 4096×2048 frame, WorldCRS84Quad | 170 |
| Tiles per frame, WebMercatorQuad to level 4 | 341 |
| Bytes per frame, all levels | ~1.3× the frame itself; a few MB as JPEG, more as PNG |
| Per 1,000 frames, one grid | a few GB to ~15 GB |
| Runner time per frame | seconds; dominated by PNG encoding |

R2 charges for storage and operations, not for egress, so a popular
layer costs little more than an unpopular one. The costs that grow are
runner minutes and object counts on long animations, which is why
§7 tiles datasets that have frames already, and leaves the legacy video
catalog to a later, opt-in phase.

---

## 6. Decimation

Every consumer reaches its view by asking for less than the node
holds, along four axes: space (a zoom level), time (a step), bit depth
(a format) and, for the consumers that play video, frame size and rate.
The node decides how "less" is made. The rule that runs through this
section is short: **decimate values, not colours; choose time samples
on purpose; never present more precision than the source had.**

### 6.1 Space: building the pyramid

**The native level.** A dataset's deepest level is the smallest
WorldCRS84Quad level that holds its source frame without loss:
⌈log₂(W / 512)⌉ for a frame W pixels wide. Sources whose width is not
512 × 2ⁿ are resampled *up* to that level once, at cut time — by
nearest neighbour for data-encoded frames, so every source cell keeps
its exact value and no boundary moves by more than half a source
pixel, and by Lanczos for RGB pictures. The capabilities abstract
states the source resolution, so nobody mistakes the native level for
finer data. Nothing is cut below the native level; every client in §2
upscales past a layer's deepest level on its own, or should be
checked to.

**Every level above native is a 2×2 decimation of the one below.**
Because WorldCRS84Quad's blocks align with the source pixel grid and
with the antimeridian, no block straddles the seam, and the pyramid can
be built in one pass with no reprojection.

**How a 2×2 block becomes one pixel is a property of the data.** One
method for everything is the default in every tiling tool and is wrong
for some of the catalog. Proposed: a per-dataset `decimation` value,
set by the publisher, defaulted from the dataset's kind, and stated in
the capabilities abstract:

| Value | For | Rule | What it costs |
|---|---|---|---|
| `mean` | Continuous fields: temperature, aerosol optical depth, sea-surface height | Area-weighted mean of the valid cells | Smooths extremes away at coarse levels |
| `mode` | Categorical fields: land cover, hazard classes, any palette whose colours are classes | Most common valid class; ties broken by a fixed cell order so tiles are reproducible | Small classes vanish at coarse levels |
| `max` | Sparse extremes a mean would erase: fire detections, lightning, precipitation maxima | Largest valid value | Overstates the extent of the extreme at coarse levels — the abstract has to say so |
| `picture` | RGB imagery with no underlying values: composites, diagrams, legacy SOS animations | Mean in linear light | None worth naming |

Four rules apply whatever the method.

- **Values, then colour.** A data-encoded frame is decoded to values
  (`lumaToValue`, `src/types/color-scale.ts`), decimated, and only then
  coloured. Averaging *colours* of a diverging palette produces colours
  the palette does not contain — red and blue average to a purple that
  means nothing. Averaging *luma codes* is wrong for the same reason in
  another form: next to the no-data band, a valid code and a no-data
  code average to a code that reads as a real, wrong, value.
- **No-data stays out.** Cells inside `transparentRange` or below
  `dataMinLuma` are excluded from every method. Whether the output
  pixel is itself no-data depends on the method: under `mean` and
  `mode` when less than half the block's area is valid, under `max`
  only when none of it is, because the point of `max` is that one fire
  pixel survives the zoom-out. The half-area threshold is a judgement
  call (§9).
- **Area, not pixel count.** An equirectangular row's cells shrink
  toward the poles, so the two rows of a block weigh differently. The
  weights are the exact band areas `datasetStats.ts` already uses
  (`R² · Δλ · (sin φ₁ − sin φ₀)`, `src/services/datasetStats.ts:165`);
  the difference only shows within a few pixels of a pole, but the
  pyramid and the Analyze panel should not disagree about what a mean
  is.
- **Linear light for pictures.** Averaging sRGB-encoded values darkens
  every high-contrast edge — coastlines, city lights, a bright plume on
  a dark sea. Decode, average, re-encode; the projector blend does the
  same for the same reason (`src/output/projectorWarp.ts:961`).

**WebMercatorQuad is a reprojection, not a decimation.** Its tiles
are warped from the WorldCRS84Quad native level using the same method
(GDAL's `gdalwarp` has `average`, `mode` and `max` resampling). Toward
its ±85.05° edge Mercator *stretches* rows, so there the warp is
upsampling, and a data-encoded layer should use nearest neighbour
rather than interpolate values that were never measured.

### 6.2 Time: choosing samples

**A client chooses times; the node chooses frames.** Snapping a
requested time to a frame (§5.3) is decimation by *selection*, and
selection aliases anything periodic. An hourly field stepped every
24 hours shows the same hour forever: the diurnal cycle disappears,
and for anything with a day–night signal — surface temperature,
infrared clouds — one hemisphere stays in night for the whole
animation. A 25-hour step crawls the cycle backwards across the
globe instead. The node cannot stop a client from choosing its step,
but it can do two things.

- **Advertise the native cadence.** Each layer's time dimension states
  its period, so a client that lets its user set a step (OpenSpace sets
  one per layer, §2.2) can match it.
- **Offer aggregated layers.** For long series, separate layers holding
  temporal aggregates — a daily mean of an hourly field, a monthly max
  of a daily one — computed at publish time in value space with the
  dataset's own method. They are separate layers rather than a style,
  because they are different data on a different time axis. Off by
  default; turned on per dataset, since each one is another pyramid to
  store.

**Frames from video must recover the source cadence.** Every upload is
re-encoded at 30 fps (`OUTPUT_FRAME_RATE`, `cli/lib/ffmpeg-hls.ts:129`),
holding frames to get there. Extracting at 30 fps would tile each
source frame several times over. ffmpeg's `mpdecimate` filter drops
near-duplicate frames, but its threshold could also drop a genuinely
small change in a data-encoded field; for those, only exact duplicates
are dropped. A frame's time is then derived from the dataset's span and
the frame's index after de-duplication, which is right only when the
source had a regular cadence — the extractor should refuse, not guess,
when the de-duplicated count does not divide the span evenly.

**Rolling windows follow the frames.** Real-time Zyra datasets keep
only a window of frames (`cli/lib/r2-frames.ts`); their tiles follow
the same window, so a layer's time dimension has a moving start, which
clients that cache capabilities need to tolerate.

### 6.3 Bit depth and format

- **JPEG** (quality around 85) for opaque RGB pictures, as GIBS does
  for its opaque layers.
- **Indexed PNG for data-encoded layers.** A data-encoded dataset's
  palette is exactly 256 entries (`buildColorScaleLut`), so a decimated
  value, re-quantised to the nearest of the dataset's 256 codes, can be
  written as an 8-bit indexed PNG whose palette chunk *is* the LUT and
  whose transparency chunk carries the no-data band. That is lossless
  with respect to what the TerraViz globe shows, about a quarter the
  size of RGBA, and keeps an exact code-to-colour mapping a careful
  client could invert. Whether each consumer reads indexed PNG with
  transparency correctly is a §2 question.
- **Never JPEG for data.** JPEG ringing along palette boundaries invents
  colours the palette does not contain — the false-colour failure of
  averaging colours, arriving through compression instead.
- **Re-quantising puts a mean back on the transport lattice.** The
  step between adjacent codes is the quantisation step the Analyze
  panel already reports; the abstract states it.
- **No 16-bit or floating-point tiles in v1.** Real values travel
  through the raster channel (§4.2), which carries them without a
  256-level code.

### 6.4 Video, for consumers that play it

The HLS ladder already decimates display video by rung, and the web
output caps the rung at its own frame width (`capLevelForWidth`,
`src/services/hlsService.ts:196`), which is how a Second Life face
avoids streaming 4K into a 1024-pixel texture. Data-encoded video is
pinned to one 4096×2048 rung on purpose: lower rungs "would resample a
data raster to a quarter scale" (`cli/lib/ffmpeg-hls.ts:102`;
`DATA_ENCODED_VIDEO_PLAN.md` §Why the frame is 4096×2048), and an
encoder's scaler averages luma codes — the
§6.1 failure again. So any consumer that needs a smaller data-encoded
video gets one built from decimated *frames* in value space, never one
transcoded down from the 4K video.

<!-- §6.5 per-consumer targets, §7 contract, §8 phases, §9 non-goals, §10 open questions, §11 sources: filled after research -->
