# Data Delivery Plan — Getting TerraViz Datasets to Other User Groups in Efficient Formats

**Status: draft for review.** Nothing in this document has been built.
Today a TerraViz dataset reaches people one way: through TerraViz
itself, or a TerraViz page embedded somewhere else. This plan asks how
to get the same data to the groups who work in other tools — GIS
analysts in ArcGIS and QGIS, planetarium and dome producers in
OpenSpace, Science On a Sphere sites and spherical-display owners,
educators in Second Life, web developers building their own globes —
in the format that is efficient for each. Sometimes that is map tiles,
sometimes a georeferenced raster, and for anything that plays a whole
globe as an animation it is usually video. The research behind it is
desk research (vendor documentation, source code and release notes,
cited in the sources section), not hands-on testing, except where a
sibling document already records a test.

**Last reviewed:** 2026-11-06 (first draft, from desk research on each
consumer.)

**Revisit when any of the following becomes true:**

- A consumer in §2 ships a capability this plan assumes it lacks, or
  drops one it assumes it has: the ArcGIS Map Viewer time slider for
  WMTS layers, the OpenSpace video layer, OGC API Tiles support in
  ArcGIS or OpenSpace.
- Phase D1 of §9 (the hand-built prototypes) has run: tiles against
  OpenSpace and QGIS, a packaged video on a dome or sphere. Its results
  decide most of §5 and §6.
- The STAC API (`docs/metadata/PHASE4_IMPLEMENTATION.md`) clears its
  rollout gate, or is withdrawn. §4.3 leans on it.
- A funded partner names a user group this plan does not cover.

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

**There is no single efficient format.** What is efficient depends on
what the group does with the data:

| What the user does | Efficient format | Why |
|---|---|---|
| Plays a whole-globe animation: a dome show, a sphere, a virtual world, a presentation | **Video** | Compression across frames. The catalog's 4096×2048 rung is capped at 25 Mbit/s (`cli/lib/ffmpeg-hls.ts:91`), about 100 KB a frame at 30 fps; the same frame as a still image is one to several megabytes. One file, one request, and every player on every platform reads H.264. |
| Browses a map, zooms into a region, steps through time at their own pace | **Tiles** | Fetches only the part of the globe on screen, at the zoom shown, for any time in any order. Video cannot serve a region, and reaching one frame means decoding from the keyframe before it. |
| Analyses values: statistics, overlays with their own data | **Georeferenced raster** (COG, NetCDF) | Real numbers, with the placement in the file. Neither video nor coloured tiles carry them. |
| Looks for datasets | **Catalog** (STAC, OGC API Features, DCAT) | Metadata, not pixels. |
| Wants the TerraViz experience itself in their page | **Embed or output page** | Already built. |

The temptation is to answer each request with a bespoke export — an
ArcGIS publishing script here, an OpenSpace asset there. This plan
argues for the opposite: a small number of **channels**, each built on
a format and standard that several groups already read, so that one
piece of work serves many tools. It surveys the groups (§2), compares
what each reads (§3), recommends a channel per group (§4), and designs
the two channels that need new work: a **tile service** (§5) and
**video packaged for players other than TerraViz's own** (§6). Today
a video reaches another player only through TerraViz's manifest
(`functions/api/v1/datasets/[id]/manifest.ts`: an HLS playlist for a
published upload, a signed MP4 link that expires in about an hour for
the legacy SOS catalog) or through a person's by-hand zip download.
There is no stable file URL a dome or a sphere can be pointed at, and
no per-frame record of dates a player could sync to.

**Making smaller versions honestly** is the part that can quietly go
wrong in every channel. Every group asks for less than the node holds:
a lower zoom level, a coarser time step, a smaller video, fewer
colours. How the node makes "less" decides whether a smoke plume
survives the zoom-out, whether a diverging palette keeps its meaning,
and whether an hourly field stepped daily shows the same hour of the
day forever. §7 sets those rules. A wrong URL fails loudly; a wrong
reduction draws a plausible picture of something the data never said.

Every channel serves from the node; none pushes data into another
organisation's system without that organisation pulling it, with one
deliberate exception (§4.2's ArcGIS Image adapter, which an operator
runs with their own credentials).

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

---

## 2. The user groups, and what their tools read

Each subsection says what the group's tools can read, what that means
for the format TerraViz should serve them, and what size, pace and
precision those tools actually use. Claims about third-party tools were
checked against vendor documentation or source code on 2026-11-06 and
link to it inline. Where the documentation is silent, the text says so
rather than guessing. The two most consequential findings are that
**ArcGIS's time slider follows WMS time but ignores WMTS time**, and
that **Second Life plays an MP4 URL through a video player with no
browser at all** — both change what §4 recommends.

### 2.1 ArcGIS users: analysts, Hub sites, StoryMaps authors

**What ArcGIS Online reads.**

- **Map Viewer adds OGC services by URL**: OGC API Features, WMS, WMTS,
  WFS 2.0 (GeoJSON output only) and WCS. Servers must allow CORS and
  token-secured services are not supported. A WMS or WMTS layer must
  use the basemap's coordinate system, and a WMTS layer's tiling scheme
  must match the basemap's
  ([OGC layers](https://doc.arcgis.com/en/arcgis-online/reference/ogc.htm)).
  Most basemaps are Web Mercator.
- **Time: WMS-T yes, WMTS no.** Map Viewer is built on the ArcGIS Maps
  SDK for JavaScript, whose `WMSLayer` reads a time dimension and
  follows the time slider
  ([WMSLayer](https://developers.arcgis.com/javascript/latest/references/core/layers/WMSLayer/)),
  while `WMTSLayer` has no time property at all
  ([WMTSLayer](https://developers.arcgis.com/javascript/latest/references/core/layers/WMTSLayer/));
  Esri staff say only a WMTS dimension's default value is used
  ([Esri Community](https://community.esri.com/t5/arcgis-online-questions/wmts-time-dimension-support/m-p/741619)).
  Since February 2026 any layer can be given a start and end date that
  the slider uses to switch it on and off
  ([Esri blog](https://www.esri.com/arcgis-blog/products/arcgis-online/mapping/make-time-for-time-based-layer-visibility-in-map-viewer)),
  so one WMTS layer per frame would animate — workable for a handful of
  frames, not for a year of days.
- **XYZ tile layers** from a URL template are Web Mercator only, with
  no time
  ([add layers from URL](https://doc.arcgis.com/en/arcgis-online/create-maps/add-layers-from-url.htm)).
- **KML**: GroundOverlay, KMZ and NetworkLink display; files over
  10 MB cannot be added; time is not mentioned
  ([KML](https://doc.arcgis.com/en/arcgis-online/reference/kml.htm)).
- **Scene Viewer** global scenes take WMS and WMTS with 256- or
  512-pixel tiles in Web Mercator or Esri's "WGS 1984 Geographic
  Coordinate System, Version 2" scheme
  ([global and local scenes](https://doc.arcgis.com/en/arcgis-online/create-maps/choose-global-local-scene.htm)).
  Whether that scheme is the same as WorldCRS84Quad is not documented.
- **Zooming past the deepest level** is undocumented for WMTS; the
  SDK's `TileLayer` stops requesting tiles past a service's deepest
  level by design
  ([Esri bug 000133378](https://support.esri.com/en-us/bug/the-tilelayer-does-not-dynamically-load-tiles-in-after-bug-000133378)).
  If WMTS behaves the same, §7.1's rule of stopping at the native level
  leaves ArcGIS users with blank maps when they zoom in. Phase D1 tests
  it (§11).
- **ArcGIS Image for ArcGIS Online**, which the TerraViz operator's
  organisation licenses, creates hosted imagery layers from uploaded
  files, converted to Esri's CRF format; inputs include GRIB, HDF,
  NetCDF and any raster ArcGIS Pro reads, multidimensional included
  ([publish imagery layers](https://doc.arcgis.com/en/arcgis-online/manage-data/publish-imagery-layers.htm)).
  **Tiled** imagery layers can be shared publicly; **dynamic** ones
  cannot. A multidimensional layer gets a time slider, one slice at a
  time
  ([multidimensional](https://doc.arcgis.com/en/arcgis-online/create-maps/configure-multidimensional.htm));
  a temporal mean is a separate analysis run that writes a new layer
  ([aggregate](https://doc.arcgis.com/en/arcgis-online/analyze/aggregate-multidimensional-raster-mv-ra.htm)).
  No documented way was found for ArcGIS Online to read data in place
  from S3-compatible storage such as R2, so the data is *copied* into
  Esri's store. Storage is 1.2 credits per GB per month and tile
  generation 1 credit per 10,000 tiles
  ([credits](https://doc.arcgis.com/en/arcgis-online/administer/credits.htm)).
- **ArcGIS Pro** browses STAC APIs (Explore STAC, Pro 3.2 and later) and
  reads Zarr ([Explore STAC](https://doc.esri.com/en/arcgis-pro/latest/help/data/imagery/explore-stac.html)).
  Which asset formats it can place on a map is undocumented; the safe
  assumption is that an asset must carry its own georeferencing (COG,
  GeoTIFF, NetCDF), so today's PNG frames would not be placed.
- **Hub** shows items from its organisation; no feature for harvesting
  an outside catalog was found. Items that point at a URL — WMS, WMTS,
  OGC Feature Server, WCS, KML, Media Layer, Web Mapping Application —
  can be created through the REST API's `addItem`
  ([item types](https://developers.arcgis.com/rest/users-groups-and-items/items-and-item-types/)),
  and Hub lists WMS and WMTS items with map previews
  ([supported content](https://doc.esri.com/en/arcgis-hub/latest/build/supported-content.html)).
  Hub's DCAT feed carries only public data items; whether WMS and WMTS
  items are among them is untested
  ([federate data](https://doc.esri.com/en/arcgis-hub/latest/build/federate-data.html)).
- **Video.** Map Viewer's media layer takes only JPEG or PNG uploaded
  from the user's device
  ([media layers](https://doc.arcgis.com/en/arcgis-online/create-maps/add-media-layers.htm)).
  The web map format allows a video media layer by URL and the SDK plays
  one ([mediaLayer](https://developers.arcgis.com/web-map-specification/objects/mediaLayer/)),
  but whether Map Viewer plays one saved into a web map is unverified.
  StoryMaps take uploaded video up to 50 MB, not georeferenced, and
  HTTPS embeds
  ([StoryMaps FAQ](https://doc.esri.com/en/arcgis-storymaps/latest/reference/faq.html)).

**What this means.** For browsing with a time slider, ArcGIS needs
**WMS-T in Web Mercator**; WMTS in plain latitude/longitude is of
little use to it. For analysis, it needs the source fields as
multidimensional rasters, uploaded as a public tiled imagery layer. For
Hub, it needs items registered that point at those services and at the
embed page. For storytelling, the embed page, plus short MP4 clips.

**Size, pace, precision.** WMS `GetMap` requests are capped at 2048
pixels by default. A 4096×2048 source reaches its native resolution at
level 4 of Web Mercator. Analysis rasters go up as CRF with LERC
compression, whose maximum error should be set below the field's
meaningful precision.

<!-- §2.2 planetarium and dome producers: filled from research -->

### 2.3 Virtual-world educators: Second Life and OpenSimulator

**Already built, and documented elsewhere.**
[`SECOND_LIFE_COMPAT.md`](SECOND_LIFE_COMPAT.md) records in-world tests
(Firestorm 7.2.4, Chromium 139: WebGL 2, H.264, AAC, VP9, AV1 and hls.js
work; native HLS does not; media is capped at 2048 a side) and two
built routes: the full app on a flat panel, and the output page's web
mode as a sphere's texture, steered by a shared clock in its address.
Video must come from the node's own origin, because the video host's
CORS allows only that origin (§4.4 there). This plan does not repeat
any of it.

**What the viewer source adds** (checked against Linden Lab's and
Firestorm's repositories):

- **Every loaded globe renders at its full media size.** The viewer
  shrinks low-priority media only for plugins that opt in with
  `allow_downsample`, and the web-page plugin never does
  ([`llpluginclassmedia.cpp`](https://github.com/secondlife/viewer/blob/develop/indra/llplugin/llpluginclassmedia.cpp),
  [`media_plugin_cef.cpp`](https://github.com/secondlife/viewer/blob/develop/indra/media_plugins/cef/media_plugin_cef.cpp)).
  The page's `width` is the only lever on what a visitor's GPU and
  connection pay for.
- **An MP4 address plays without a browser.** An address served as
  `video/mp4` goes to the viewer's LibVLC video plugin, not the web
  page plugin
  ([`mime_types.xml`](https://github.com/secondlife/viewer/blob/develop/indra/newview/skins/default/xui/en/mime_types.xml)).
  A plain equirectangular MP4 on a sphere is therefore a globe that
  needs no WebGL — and has no shared clock. Untested in-world.
- **Firestorm does not auto-play shared media by default.**
  `ParcelMediaAutoPlayEnable` is 1 in Linden Lab's viewer and 0 in
  Firestorm
  ([official settings](https://github.com/secondlife/viewer/blob/develop/indra/newview/app_settings/settings.xml),
  [Firestorm settings](https://github.com/FirestormViewer/phoenix-firestorm/blob/master/indra/newview/app_settings/settings.xml)),
  so a Firestorm visitor sees nothing until they press play.
- **An address is at most 1,024 characters**, and each
  `llSetPrimMediaParams` call sleeps the script for a second
  ([LSL wiki](https://wiki.secondlife.com/wiki/LlSetPrimMediaParams)).
- **The browser is moving.** Linden Lab's viewer 26.2 runs CEF 139;
  Firestorm's main branch pins CEF 152, not yet in a release checked
  ([Firestorm `autobuild.xml`](https://github.com/FirestormViewer/phoenix-firestorm/blob/master/autobuild.xml)).

The last four correct or extend `SECOND_LIFE_COMPAT.md` (its §10
question 13 assumes low-priority media are scaled down). They belong
in that document, in a follow-up, not here.

**Other virtual worlds**, briefly: VRChat shows video, not web pages,
from allowlisted hosts, at most one new URL per five seconds
([VRChat](https://creators.vrchat.com/worlds/udon/video-players/www-whitelist));
Overte shows web pages but lists only open codecs, so H.264 would not
play ([Overte](https://docs.overte.org/en/latest/create/entities/web-entity-media.html));
Microsoft Mesh was retired in December 2025. None changes §4; VRChat
is one more reason for a plain MP4.

**Size, pace, precision.** Because the page always renders at full
size, the face width is the whole budget. A 2:1 texture W pixels wide
is the limiting factor only when the sphere spans more than about W/π
pixels on screen: about 650 at 2048, about 330 at 1024. A 4 m sphere
seen from 15 m on a 1080p screen spans about 270 pixels, so 1024 is
enough beyond about 7 m. That supports the output page's
`defaultWebFramebufferWidth` and `capLevelForWidth` caps, a 1024
default for exhibits, and the low-bitrate 1024×512 rendition
`SECOND_LIFE_COMPAT.md` §7 already plans. Data-encoded video, at one
4096×2048 rung of up to 25 Mbit/s per visitor, is the worst case;
§6.3 proposes smaller renditions made the honest way.

<!-- §2.4 Science On a Sphere sites and spherical displays: filled from research -->

### 2.5 Desktop GIS users and web developers

- **QGIS** animates WMS-T with its Temporal Controller (since 3.14)
  and WMTS time (since 3.28)
  ([3.28 changelog](https://changelog.qgis.org/en/version/3.28)),
  rounds a requested time down to the period step, and resamples the
  deepest tile level when zoomed past it
  ([`qgswmsprovider.cpp`](https://github.com/qgis/QGIS/blob/master/src/providers/wms/qgswmsprovider.cpp)).
  It opens COGs over HTTP through GDAL and browses STAC since 3.40
  ([3.40 changelog](https://qgis.org/project/visual-changelogs/visualchangelog340/)).
  No video.
- **CesiumJS** animates WMTS through a `{Time}` URL template with a
  `times` list and a `clock`, and WMS the same way
  ([WMTS provider](https://cesium.com/learn/cesiumjs/ref-doc/WebMapTileServiceImageryProvider.html)).
  Its `GeographicTilingScheme` (2×1 at the root) matches
  WorldCRS84Quad. It shows the interval containing its clock with no
  blending, prefetches the next interval when it is under five seconds
  away, and stretches the deepest level past its maximum
  ([`TimeDynamicImagery.js`](https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Scene/TimeDynamicImagery.js)).
  It can also play a video on an ellipsoid as a material, from any
  source the browser plays, including HLS through hls.js — if the video
  is served with CORS
  ([ImageMaterialProperty](https://cesium.com/learn/cesiumjs/ref-doc/ImageMaterialProperty.html)).
- **Cesium for Unreal and Unity** take WMTS, WMS and TMS overlays but
  have no time property, so no animated imagery
  ([Unreal WMTS overlay](https://cesium.com/learn/cesium-unreal/ref-doc/classUCesiumWebMapTileServiceRasterOverlay.html)).
- **Google Earth Pro** animates KML GroundOverlays with TimeSpans on its
  time slider ([KML time](https://developers.google.com/kml/documentation/time))
  and adds WMS without time. **Google Earth on the web** takes image
  overlays up to 2048×2048 and no time animation was found
  ([KML import guide](https://support.google.com/earth/community-guide/307322063/google-earth-kml-import-guide?hl=en)).
  Neither plays video on the globe.
- **Web map libraries** read TileJSON and XYZ (MapLibre, Mapbox GL,
  OpenLayers). OGC API Tiles is native only in OpenLayers among
  viewers, ArcGIS Pro reads its map-tiles type, and QGIS reaches it
  partly through GDAL
  ([implementations](https://github.com/opengeospatial/ogcapi-tiles/blob/master/implementations.adoc)).
  Raster PMTiles works in web libraries but not yet in GDAL or QGIS.
  GeoZarr is a draft. None of these is worth leading with in 2026.

**What this means.** Desktop GIS users are served by WMS-T and WMTS for
viewing and by COGs for analysis; Google Earth Pro users by a KML of
time-stamped overlays at most 2048×1024 each; web developers by WMTS
with `{Time}`, TileJSON, and CORS-enabled H.264 video they can put on
a Cesium or three.js globe.

<!-- §3 capability matrix: filled from research -->

<!-- §4 strategy: filled from research -->

---

## 5. The tile service

The one channel that does not exist yet in any form, and the one most
consumers share. This section is a design sketch for review, not a
specification; Phase D1 (§9) exists to test it before anything is
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
1440 — are handled in §7.1.

**Secondary: WebMercatorQuad** (`GoogleMapsCompatible`), for clients
whose basemaps are Web Mercator and which require the tile grid to
match the basemap (ArcGIS Map Viewer in 2D; most XYZ web maps). This
grid *does* need reprojection, and it cannot show latitudes beyond
about ±85.05°, so every polar dataset loses its poles in it. That is a
property of the projection, not of the implementation, and the
capabilities document should say so in each layer's abstract.

**Not adopted: GIBS's own geographic tile matrix sets.** GIBS's
EPSG:4326 sets are padded: 512-pixel tiles, level 0 two tiles at
0.5625° a pixel covering 576°×288°, and column counts of 2, 3, 5, 10,
20, 40 by level rather than powers of two (verified against GIBS's live
capabilities document, 2026-11-06). They are sized to GIBS's native
product resolutions, not to a 2:1 image, so copying them would mean
resampling every frame, and CesiumJS's own GIBS example avoids them by
using GIBS's Web Mercator endpoint. WorldCRS84Quad is what CesiumJS's
`GeographicTilingScheme` (2×1 at the root) and QGIS read directly.
Copying GIBS's *URL grammar and time rules* (§5.2, §5.3) while using
the standard grid keeps most of the familiarity; GDAL-based clients
such as OpenSpace need a data window that says so (§2.2).

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
pinned in `docs/protocol/` the way STAC's is (§8).

### 5.3 Time

- **The dimension is `Time`, in ISO 8601 UTC**, declared per layer in
  the capabilities document. Because frame times are computed as
  `start_time + period × index`, most layers can declare a compact
  `start/end/period` interval rather than listing every frame; a
  dataset with irregular frames lists them.
- **A requested time snaps down to the frame whose period contains
  it**, and a time outside the dataset's span, or in a gap between
  irregular frames, is a 404. That is GIBS's behaviour, checked with
  live requests (a mid-June date returns the June tile byte for byte; a
  date in a gap returns 404 over WMTS). It is also what the clients
  assume: QGIS rounds a request down to the period step, and CesiumJS
  shows the interval that contains its clock. Clients that animate on
  a fixed step — OpenSpace rounds simulation time to a configured
  resolution — will ask for times that are not frame times and must
  get the frame they are inside, not an error.
- **This deliberately differs from `/frames?at=`**, which returns the
  *closest* frame. A closest-frame rule shows a frame up to half a
  period before its own time, which for a forecast is showing the
  future. The difference is documented on both routes rather than
  resolved by changing the existing one.
- **`default` is the latest frame**, matching GIBS, so a client that
  sends no time gets the most recent picture. GIBS does not accept a
  `current` keyword, and neither should this.
- **Long time lists are capped.** GIBS's capabilities document carries
  only the latest 100 periods per layer and answers a `DescribeDomains`
  request for the rest; its 4326 document is 5.3 MB for 1,332 layers.
  Regular series here declare one `start/end/period` interval and need
  no cap; irregular ones copy GIBS's.
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
  set per dataset by what the data is (§7.1), because the same field
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
  requests, CORS and visibility checks possible. CORS has to be open:
  CesiumJS, MapLibre and OpenLayers draw tiles with WebGL, which refuses
  a cross-origin image without `Access-Control-Allow-Origin`. Its cost is one Worker
  invocation per tile request; at Cloudflare's request pricing that is
  small next to the storage, but it is not zero, and §11 asks whether
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
- **A colour map and legend** per data-encoded layer, in GIBS's
  ColorMap v1.3 XML (source value ranges to colours, no-data flagged,
  each entry classed as classification, continuous or discrete) with
  SVG and PNG legends — generated from the dataset's `color_scale`, so
  a client that already reads GIBS colour maps reads TerraViz's.
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
§9 tiles datasets that have frames already, and leaves the legacy video
catalog to a later, opt-in phase.

---

## 7. Making smaller versions: decimation

Every consumer reaches its view by asking for less than the node
holds, along four axes: space (a zoom level), time (a step), bit depth
(a format) and, for the consumers that play video, frame size and rate.
The node decides how "less" is made. The rule that runs through this
section is short: **decimate values, not colours; choose time samples
on purpose; never present more precision than the source had.**

### 7.1 Space: building the pyramid

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
  call (§11).
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

### 7.2 Time: choosing samples

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

### 7.3 Bit depth and format

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

### 7.4 Video, for consumers that play it

The HLS ladder already decimates display video by rung, and the web
output caps the rung at its own frame width (`capLevelForWidth`,
`src/services/hlsService.ts:196`), which is how a Second Life face
avoids streaming 4K into a 1024-pixel texture. Data-encoded video is
pinned to one 4096×2048 rung on purpose: lower rungs "would resample a
data raster to a quarter scale" (`cli/lib/ffmpeg-hls.ts:102`;
`DATA_ENCODED_VIDEO_PLAN.md` §Why the frame is 4096×2048), and an
encoder's scaler averages luma codes — the
§7.1 failure again. So any consumer that needs a smaller data-encoded
video gets one built from decimated *frames* in value space, never one
transcoded down from the 4K video.

<!-- §6.5 per-consumer targets, §7 contract, §8 phases, §9 non-goals, §10 open questions, §11 sources: filled after research -->
