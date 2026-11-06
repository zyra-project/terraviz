# Dataset Dissemination Plan — Getting TerraViz Datasets Into Other Tools

**Status: draft for review.** Nothing in this document has been built.
It answers one question: what would TerraViz have to serve so that its
datasets can be used *outside* TerraViz — in ArcGIS Online and Hub, in
the OpenSpace planetarium software, in Second Life, on Science On a
Sphere systems and spherical displays, and in desktop and web GIS tools
— and in what order to build it. The research behind it is desk
research (vendor documentation, source code and release notes, cited in
§10), not hands-on testing, except where a sibling document already
records a test.

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

"Dissemination" here means making a dataset *usable* elsewhere, not
copying it elsewhere. Every channel below serves from the node; none
pushes data into another organisation's system without that
organisation pulling it, with one deliberate exception (§4.2's ArcGIS
Image adapter, which an operator runs with their own credentials).

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
resampling at the deepest level and only box-filter shrinking above it.
Frames at other widths are padded or resampled up to the next rung once,
at cut time.

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

<!-- §6 contract, §7 phases, §8 non-goals, §9 open questions, §10 sources: filled after research -->
