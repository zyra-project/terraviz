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

**Last reviewed:** 2026-11-08 (first draft 2026-11-06, from desk
research on each consumer; §9's phased implementation and §9.14's usage
metrics added the same day. On 2026-11-07 the four follow-ups this
plan spun off were merged and are marked done: the ArcGIS wildcard
guard, #521 (§4.5); the Second Life corrections, #522 (§2.3); the
embed field, #524 (§9.14); and the embed host controls, #526
(§9.14). The same day each channel was put behind a
switch in the portal (§8), and four specialist agents reviewed their
sections against client source code: the Web GIS Developer §5, the
Video Streaming Engineer §6, the Scientific Visualization Reviewer §7
and the Privacy Engineer §9.14. Their findings are applied. They are
AI review, not hands-on testing, and no person outside the drafting
loop has reviewed the plan. On 2026-11-08 the scope was drawn against
#528's licensed-access proposal: §8, §9.9 and §10. Later that day
Phase D1 began. Its machine-run rows (grids, client time, calendar
snapping, regional frames, pyramid cost, video encodes) are recorded in
[`delivery/D1_PROTOTYPES.md`](delivery/D1_PROTOTYPES.md). The sections
they contradicted or sharpened were amended and are logged in §9.2:
§5.1, §5.2, §5.3, §5.7, §5.8, §6.1, §6.3, §7.1, §7.3 and §11. Its rows
that need a person, a place or Cloudflare credentials are kits or
still to run.)

**Decisions recorded:** thirty, all by the maintainer and logged
in §9.2. Twenty-five were made on 2026-11-06: rasters for analysis carry the producer's own values on
the producer's own grid, before any regridding (§9.11); use is measured
per platform and per method (§9.14); five choices about how that
measuring works (§11 q17–q21); the five D0 blockers (§11 q1, q4, q7,
q13, q14); and eight more from an interview the same day (§11 q5, q6,
q8, q9, q10, q12, q15, and counting embedded views). **D0 is
complete**; D1 is next. q8 was corrected the same day: SOS datasets
carry varying Creative Commons licences, not public domain. SOS datasets
whose original terms cannot be traced go out under the SOS catalog's
published terms (q22). Four more came from the privacy review of the
embed field (§9.14). On 2026-11-07, each delivery channel was put
behind its own switch in the portal's Features card, on by default
(§8), and the specialist reviews of §5, §6, §7 and §9.14 led to three
more: WMS gets its own switch, off by default (q26); an unrecognised
site is counted as `other-origin`, unhashed (q21b); and a request
sending Global Privacy Control is counted with no country, version or
domain (q25). On 2026-11-08, licensed or gated access by a node was
put outside this plan's scope (§10, #528). Open: q2, q3, q10's date
parsing and q11, tested in D1;
and q23, now only for datasets whose known licence is No-Derivatives.
D1 has added four: q27 to q30.

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
  so one layer per frame would animate — workable for a handful of
  frames, not for a year of days. Those layers would be XYZ items with
  the time in the path rather than WMTS layers, since a WMTS layer
  shows only its default time and one shared capabilities document
  gives every layer the same default.
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

### 2.2 Planetarium and dome producers: OpenSpace, and others

**OpenSpace** (latest release v0.22.0, June 2026; checked against its
documentation and its source at `master`) is the collaboration that
prompted this plan, and it reads more of what TerraViz has than any
other tool here.

- **It already plays NOAA Science On a Sphere datasets.** OpenSpace
  ships 243 SOS datasets as assets
  (`data/assets/scene/solarsystem/planets/earth/noaa-sos/` in its
  repository; "image sequences available from NOAA's
  Science-on-a-Sphere datasets" since 0.18.0). All are zips of frames,
  in 4096 and 2048 folders; 60 use a time-linked layer with timestamped
  filenames, 78 a plain image sequence not linked to time, and none use
  video. TerraViz datasets packaged the same way would feel native.
- **Assets are Lua files that fetch their own data.** A `.asset` file's
  `UrlSynchronization` downloads any URL, unzipping if asked and
  re-checking on a schedule — the route a third party like TerraViz
  uses, pointing at R2. There is no third-party catalog; users drop
  asset files into a folder.
- **Video on a globe, synced to simulation time.** The
  `VideoTileProvider` (since 0.19.0) maps a whole 2:1 video onto a
  globe, decoded by libmpv, so any codec FFmpeg reads; the official
  example is an H.264 MP4
  ([VideoTileProvider](https://docs.openspaceproject.com/latest/reference/asset-components/TileProvider/VideoTileProvider.html)).
  In `MapToSimulationTime` mode, a start and end time map linearly onto
  the video's duration, so **frames must be evenly spaced in time**, and
  playback **seeks on every time step** — frame-accurate, at a cost
  that grows with the distance between keyframes. **Local files only**:
  a remote MP4 is downloaded once by `UrlSynchronization`; HLS is not
  an input.
- **Images and tiles through GDAL, in latitude/longitude only.** A
  layer is whatever GDAL opens; OpenSpace reads the geotransform as
  degrees and does no reprojection, so Web Mercator sources land in
  the wrong place. A raster with no geotransform is taken to cover the
  whole globe, so **a plain 2:1 PNG or JPEG works with no world file**
  ([readable datasets](https://docs.openspaceproject.com/releases-v0.22/building-content/globebrowsing/creation/readable-datasets.html)).
  Tiled sources are described by a GDAL XML file. OpenSpace's own GIBS
  helper sets a data window of −180, 90, 396, −198 to cope with GIBS's
  padded grid; the §5.1 layout needs the plain −180, 90, 180, −90.
- **Time in tiles has to be in the URL.** GDAL's WMTS driver has no
  time option
  ([GDAL WMTS](https://gdal.org/en/stable/drivers/raster/wmts.html)),
  so OpenSpace's `TemporalTileProvider` substitutes the time into a URL
  template read by GDAL's TMS driver. In its `Prototyped` mode the time
  is floored onto a grid anchored at a start time, with steps limited
  to whole years, months in {1, 2, 3, 4, 6}, days 1–28, hours in
  {1, 2, 3, 4, 6, 12} and minutes in {15, 30} — no seconds, no 5- or
  10-minute steps. A 404 renders as a transparent tile. Its `Folder`
  mode reads a *local* directory, parses each filename as a date, and
  handles irregular series; the day parsing looked off by one in the
  source and needs a test (§11).
- **No prefetch, so tiles do not suit shows.** Each new time step opens
  a new dataset and refetches every tile on screen. Only with
  `Interpolation` on does it preload neighbouring steps and blend them
  on the GPU; and only then does `Colormap` recolour a greyscale layer
  through a lookup table — which is how a data-encoded dataset's luma
  frames could reach OpenSpace with their palette applied by OpenSpace.
- **Detail is set by angle, not by output resolution.** OpenSpace picks
  a level from each chunk's apparent size times a scale factor, never
  deeper than the source holds (it stretches the deepest tile instead).
  By that formula, 4096×2048 gives about two dome pixels per texel on a
  4K fisheye at the default setting, and 8192×4096 about one on an 8K
  fisheye — the useful ceiling.
- **WMS servers can be added at runtime** through a panel new in v0.22
  ([0.22.0 changelog](https://docs.openspaceproject.com/releases-v0.22/about/releases/changelogs/0.22.0/index.html)).

**Other planetarium systems**, more briefly. **WorldWide Telescope**
takes planetary imagesets as equirectangular images or TOAST tiles,
and its Windows client loads WMS overlays with a time scrubber
([WWT WMS](https://docs.worldwidetelescope.org/layer-guide/1/web-mapping-service/)).
**Evans & Sutherland's Digistar** advertises SOS content (over 200
datasets and real-time feeds) in its product sheet, which implies it
reads SOS-format frames and movies; no public format specification was
found. **Uniview** has offered WMS globe layers since 2006 by one
conference abstract; **Sky-Skan DigitalSky** publishes nothing
findable. The common denominator for these is the one SOS already
established: 2:1 equirectangular frames and movies.

**What this means.** For dome *shows*, the efficient formats are frame
zips with dated filenames and evenly timed MP4s, packaged as ready-made
OpenSpace assets on the pattern OpenSpace already uses for SOS data.
Tiles serve the other OpenSpace use — flying in close to a region — and
must be latitude/longitude, with time in the path.

**Size, pace, precision.** 4096×2048 for 4K domes, 8192×4096 where a
dataset has it, for 8K. Every OpenSpace colour layer is 8-bit, and
video is 8-bit 4:2:0, so nothing wider is worth producing. An MP4 for
time-synced playback needs a constant frame rate, one video frame per
data frame, and a keyframe at least every second, because every time
step is a seek.

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
  Two settings bound what a visitor's GPU and connection pay for:
  the face's media size, which is the browser surface the viewer
  renders and uploads, and the address's `width`, which sets the
  page's own drawing buffer and caps the video it streams. Lowering
  `width` alone does not shrink the surface.
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

The first, third and fourth corrected or extended
`SECOND_LIFE_COMPAT.md`, whose §10 question 13 assumed low-priority
media are scaled down. **Done:** they are in that document now (#522,
merged 2026-11-07), with the media-size and `width` distinction above,
which that PR's review added. The MP4 point stays an option for this
plan (§6.1), not a correction there, and the browser change is a reason
to re-run that document's probe kit when CEF 152 ships.

**Other virtual worlds**, briefly: VRChat shows video, not web pages,
from allowlisted hosts, at most one new URL per five seconds
([VRChat](https://creators.vrchat.com/worlds/udon/video-players/www-whitelist));
Overte shows web pages but lists only open codecs, so H.264 would not
play ([Overte](https://docs.overte.org/en/latest/create/entities/web-entity-media.html));
Microsoft Mesh was retired in December 2025. None changes §4; VRChat
is one more reason for a plain MP4.

**Size, pace, precision.** Because the page always renders at full
size, the face's media size is the whole budget for the browser
surface, and the address's `width` for what the page draws and
streams. A 2:1 texture W pixels wide
is the limiting factor only when the sphere spans more than about W/π
pixels on screen: about 650 at 2048, about 330 at 1024. A 4 m sphere
seen from 15 m on a 1080p screen spans about 270 pixels, so 1024 is
enough beyond about 7 m. That supports the output page's
`defaultWebFramebufferWidth` and `capLevelForWidth` caps, a 1024
default for exhibits, and the low-bitrate 1024×512 rendition
`SECOND_LIFE_COMPAT.md` §7 already plans. Data-encoded video, at one
4096×2048 rung of up to 25 Mbit/s per visitor, is the worst case;
§6.2 proposes smaller renditions made the honest way.

### 2.4 Science On a Sphere sites and spherical displays

**Science On a Sphere** is where much of the catalog came from, and its
format is documented:

- **A dataset is a directory with a `playlist.sos`** naming its data —
  an image, an MP4, or a directory of frames — plus an optional
  `labels.txt` with one date label per frame and a default of 30 fps
  ([playlist format](https://sos.noaa.gov/support/sos/manuals/playlist-format/)).
  Remote URLs and WMS sources are allowed.
- **Its content guidelines are specific**
  ([guidelines](https://sos.noaa.gov/support/sos/manuals/content-creation-guidelines/all/)):
  2048×1024 for time series and 4096×2048 for still textures; 4096×2048
  movies work on 4K systems but may need a lower frame rate; 30 fps, or
  10–15 for coarse data; JPEG or PNG frames; labels kept outside the
  picture. And, notably: movies in **MPEG-4 Part 2 at 25 Mbit/s or
  more** — "The H.264 codec should not be used because it can cause
  errors in the SOS software."
- **Sites receive datasets by a weekly sync from NOAA's FTP server**,
  with real-time datasets refreshed by cron
  ([datasets](https://sos.noaa.gov/support/sos/manuals/datasets/all/)).
- **SOS Explorer**, the flat-screen and kiosk version, is different
  again: DDS image sequences, MPEG-4, OGV or WMV movies, up to 60 fps,
  and dates from an ISO 8601 period plus a filename mask
  ([SOSx guidelines](https://sos.noaa.gov/support/sosx/manuals/content-creation-guidelines/all/)).

**Spherical displays** — PufferSphere, OmniGlobe, Magic Planet — publish
no format specifications that were found. Institutional user guides
agree on 2:1 equirectangular images, JPEG or PNG sequences, and
ordinary video files
([one example](https://libguides.mines.edu/globe/formatglobedata)), and
Magic Planet's software warps the equirectangular frame through its
fisheye lens itself ([Bourke](https://paulbourke.net/dome/magicplanet)).
Codec limits should be checked with each vendor.

**What this means.** An SOS site needs an SOS dataset directory —
playlist, labels, 2048×1024 frames, an MPEG-4 Part 2 movie — not a
service. A spherical display needs a 2:1 MP4 and the frames. Neither
reads tiles, and neither applies a colour palette to anything, so a
data-encoded dataset must arrive with its palette already applied.

### 2.5 Desktop GIS users and web developers

- **QGIS** animates WMS-T with its Temporal Controller (since 3.14)
  and WMTS time (since 3.28)
  ([3.28 changelog](https://qgis.org/project/visual-changelogs/visualchangelog328/)),
  sends the Temporal Controller's frame start as it is rather than a
  listed time (for WMS-T by default, and for WMTS as far as the source
  reads), and resamples the deepest tile level when zoomed past it
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

---

## 3. What each tool reads, side by side

From §2. "time" means the tool animates that format against dates;
"?" means the documentation is silent and Phase D1 should find out.

| Tool | WMTS, lat/lon | WMTS, Web Mercator | WMS with time | XYZ / TileJSON | Raster (COG, NetCDF) | KML | MP4 file | HLS stream | Frames (folder or zip) | Web page / embed |
|---|---|---|---|---|---|---|---|---|---|---|
| ArcGIS Online (Map, Scene Viewer) | WGS84 scenes only, ? | yes, no time | **yes, time** | Web Mercator, no time | via ArcGIS Image upload | yes, no time | no (UI) | no | no | StoryMaps, Hub |
| ArcGIS Pro | yes | yes | ? | ? | yes, STAC | yes | no | no | no | no |
| OpenSpace | yes, time in URL | no (misplaced) | WMS panel; time ? | lat/lon only | COG, ? | no | **yes, time** (local) | no | **yes, time** (Folder) | no |
| Science On a Sphere | no | no | WMS source | no | no | no | MPEG-4 Part 2 | no | **yes**, dated labels | no |
| SOS Explorer | no | no | no | no | no | no | MPEG-4 / OGV / WMV | no | DDS only | no |
| Spherical displays, Digistar | no | no | no | no | no | no | yes (assumed) | no | yes | no |
| WorldWide Telescope | no | no | yes, time (Windows) | no | no | no | no | no | images | no |
| Second Life, OpenSimulator | no | no | no | no | no | no | yes, untested | inside a page | still images | **yes** (output page) |
| QGIS | yes, time (3.28+) | yes | **yes, time** (3.14+) | yes | yes, STAC (3.40+) | partial | no | no | no | no |
| CesiumJS | yes, time | yes, time | yes, time | yes | no | partial | as a material | as a material | images | host page |
| Cesium for Unreal / Unity | no time | no time | no time | Unity | no | no | engine's own | no | no | no |
| Google Earth Pro | no | no | no time | no | no | **yes, time** | no | no | via KML | no |
| Google Earth (web) | no | no | no | no | no | no time, ≤2048 | no | no | via KML | no |

Read down the columns and three things stand out. **No single format
reaches more than half the tools.** **The playing tools — domes, SOS,
spheres, virtual worlds — read files, not services**: frames and MP4s.
**The GIS tools read services**, and the one service every GIS tool here
animates is WMS with time, not WMTS.

---

## 4. Recommendation: one channel per kind of use

| Group | Primary format | Also |
|---|---|---|
| Dome and planetarium producers (OpenSpace) | Ready-made OpenSpace assets: dated frame zips, or an evenly timed MP4 (§6.4) | Lat/lon WMTS with time in the path, for flying in close (§5) |
| Science On a Sphere sites | An SOS dataset directory: playlist, labels, 2048×1024 frames, MPEG-4 Part 2 movie (§6.4) | — |
| Spherical displays, Digistar, other domes | 2:1 H.264 MP4 at 2048 and 4096, plus frames and a manifest (§6.1) | — |
| Virtual-world educators | The output page, as now, 1024 wide by default (`SECOND_LIFE_COMPAT.md`) | A plain MP4 for viewers without WebGL and for VRChat-style video players (§6.1) |
| ArcGIS users | WMS with time in Web Mercator, registered as Hub items (§5.9, §4.3) | ArcGIS Image layers for analysis (§4.2); StoryMaps embed and MP4 clips |
| Desktop GIS users | WMS with time and WMTS; COGs through STAC (§4.2) | A KMZ for Google Earth Pro (§6.4) |
| Web developers | WMTS with `{Time}`, TileJSON, and CORS-enabled H.264 MP4 and HLS for globe materials | Embed; STAC |

### 4.1 Tiles: WMTS in two grids, then WMS with time

The service in §5. It is the channel for *exploring* — panning, zooming,
stepping through time — in GIS tools, web maps and OpenSpace close-ups.
It is not the channel for *playing* a whole-globe animation; §2.2 shows
OpenSpace refetching every tile at every step, and a dome show would
stutter on it.

### 4.2 Rasters for analysis

For datasets whose real values exist — Zyra workflows read GRIB2 and
NetCDF before they render anything — publish those values, not the
pictures made from them:

- **A Cloud-Optimised GeoTIFF per time step**, written by the Zyra
  runner from the source field on the producer's own grid, before any
  regridding (§9.11), listed as an asset on its STAC item. QGIS,
  ArcGIS Pro and any GDAL-based tool read it over HTTP.
- **An ArcGIS Image adapter**: a script an operator runs with their own
  ArcGIS credentials that uploads the source fields as a
  multidimensional *tiled* imagery layer (the kind that can be public),
  which ArcGIS Online gives a time slider. It copies data into Esri's
  store — no in-place read from R2 was found (§2.1) — and spends the
  operator's credits, so it is the operator's tool, not part of the
  node.

Legacy SOS animations have no values to publish; they are pictures,
and they get tiles and video only.

### 4.3 Catalog

The STAC API the node already has, with each item gaining links to its
tiles, WMS layer and files under the STAC web-map-links extension (§5.7).
For ArcGIS, a second operator-run script registers public items in an
ArcGIS organisation — WMS, WMTS, OGC Feature Server and Web Mapping
Application items pointing at the node — so they appear in that
organisation's Hub site and, if Hub includes them, its DCAT feed (untested,
§11). No new catalog format on the node.

### 4.4 Files for players

The channel in §6: video variants, frame packages and per-group
bundles, each at a stable address. It is the cheapest channel to build
— the runner already encodes video and holds frames — and it serves the
groups that asked first.

### 4.5 Pages

The embed and the output page exist. Two small follow-ups came out of
this research:

- **Done:** the embedding validator's list of shared hosts
  (`SHARED_HOST_SUFFIXES`, `src/types/node-embedding.ts:125`) refuses
  wildcards over `arcgis.com`, `maps.arcgis.com`, `hub.arcgis.com` and
  `opendata.arcgis.com`, each of which would admit every tenant's site
  (#521, merged 2026-11-06). One tenant's own host and a wildcard under
  it still pass.
- **Still open:** a StoryMaps embed under a node's `list` embedding
  policy needs `https://storymaps.arcgis.com` in the list, which admits
  every StoryMap author, and `experience.arcgis.com` is the same. The
  validator accepts both, since nothing narrower can be said, so the
  portal's Embedding card should say what listing one admits.

---

## 5. The tile service

The channel for exploring (§4.1): GIS tools, web maps and OpenSpace
close-ups. This section is a design sketch for review, not a
specification; Phase D1 (§9) exists to test it before anything is
built.

### 5.1 Tile grids

**Primary: the WorldCRS84Quad layout at 512 pixels.** Plain
latitude/longitude, origin at (−180°, 90°), two 180°×180° tiles at
level 0, each level splitting every tile into four — the layout of the
OGC Two Dimensional Tile Matrix Set standard's WorldCRS84Quad
(OGC 17-083r4) — but with 512-pixel tiles rather than the registered
set's 256, declared in the capabilities document under its own
identifier. Its CRS is declared as `urn:ogc:def:crs:OGC:1.3:CRS84`
with a TopLeftCorner of `-180 90`, as GIBS's 4326 sets are. Not the
EPSG URN, which requires `90 -180`: GDAL swaps the axes for an EPSG
URN but not for the short form `EPSG:4326`, and QGIS swaps on the CRS's
axis order, so the `epsg4326` path name invites exactly the wrong
choice. D1 confirmed it. GDAL and QGIS read both CRS84 with `-180 90`
and the EPSG URN with `90 -180` correctly, and GDAL reads any
mismatched corner wrong without an error
(`delivery/D1_PROTOTYPES.md` §3.1). Level *n*'s scale denominator is 139770566.00717944 / 2ⁿ, which
equals the registered 256-pixel set's at level *n* + 1, a useful clue if
a client picks the wrong levels in D1. The set must not be named, or
declare the well-known scale set, `GoogleCRS84Quad`, which GDAL
special-cases.

| Level | Tiles across × down | Image width it fills exactly |
|---|---|---|
| 0 | 2 × 1 | 1024 |
| 1 | 4 × 2 | 2048 |
| 2 | 8 × 4 | 4096 |
| 3 | 16 × 8 | 8192 |

A W×W/2 frame fills level *n* exactly when W = 1024 × 2ⁿ, so the
catalog's 4096×2048 frames stop at level 2: **42 tiles per frame**
(2 + 8 + 32), and an 8192×4096 frame 170. For a global 2:1 frame every
tile edge falls on a pixel boundary of the source image at its native
level, so cutting needs no resampling there. A regional frame's pixels
never line up with the global grid, so placing one is a resample
(§5.5), and every coarser level summarises the source (§7.1). Frames at
other widths — a 0.1° science grid is 3600 wide, a 0.25° one 1440 — are
handled in §7.1, and a global frame that is not 2:1 (a 1440×721
pixel-is-point grid, which would land half a cell off) is refused.

**How deep each layer goes: a set per depth** (amended from D1's
evidence, 2026-11-08). GIBS declares a tile matrix set per depth
(`GoogleMapsCompatible_Level6` to `…_Level9`), a pattern ArcGIS reads,
and that is the form to use: each layer links to a set that ends at its
own native level, `CRS84Quad512_Level2`, `CRS84Quad512_Level3` and so
on, and `GoogleMapsCompatible_Level4` and so on for Mercator.
`TileMatrixSetLimits` stay only to bound a regional layer's extent. D1
tried the alternative, one shared set with limits saying where each
layer's levels stop. GDAL's WMTS driver and QGIS both take the
deepest matrix in the *set* as the layer's full resolution whatever the
limits say, so they ask for tiles past the layer's last level and draw
nothing (`delivery/D1_PROTOTYPES.md` §3.1). ArcGIS is still to be
checked (q2).

**Why 512 pixels.** A time step through tiles costs one request per
tile on screen, and OpenSpace refetches every tile at every step with
no prefetch (§2.2); a quarter as many requests per step is the
difference between an animation that keeps up and one that does not.
512 is also OpenSpace's default tile size, GIBS's tile size, and one of
the two sizes ArcGIS Scene Viewer accepts, and CesiumJS's geographic
scheme takes any tile width. It quarters the object count in R2 too.
The cost is that a client hard-coded to the registered 256-pixel
WorldCRS84Quad will not read it without the capabilities document.
Decided provisionally (§11 q1): 512, with D1 loading both sizes in
every client and free to reverse it. So far D1 has found nothing to
reverse it. GDAL, QGIS, CesiumJS, MapLibre and Leaflet each read 512
correctly and asked for a quarter as many tiles, though each must be
told the size (§5.7). ArcGIS and OpenSpace are still to report.

**Secondary: WebMercatorQuad** (declaring the `GoogleMapsCompatible`
well-known scale set, the standard 256-pixel set; MapLibre's default
tile size is 512 and Leaflet's 256, so D1 loads both), for clients
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
the standard layout keeps most of the familiarity; GDAL-based clients
such as OpenSpace need a data window that says so (§2.2).

### 5.2 URL grammar

RESTful, shaped like GIBS so that a configuration written for a GIBS
layer is adapted by changing the host, the layer and the tile matrix
set — not the structure:

```
GIBS:      /wmts/epsg4326/best/{Layer}/default/{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.{ext}
TerraViz:  /api/v1/wmts/epsg4326/{datasetId}/{style}/{time}/CRS84Quad512/{z}/{y}/{x}.{ext}
           /api/v1/wmts/epsg3857/{datasetId}/{style}/{time}/WebMercatorQuad/{z}/{y}/{x}.{ext}
           /api/v1/wmts/epsg4326/1.0.0/WMTSCapabilities.xml
           /api/v1/wmts/epsg3857/1.0.0/WMTSCapabilities.xml
           /api/v1/wmts/{projection}/1.0.0/{datasetId}/WMTSCapabilities.xml
```

**One capabilities document per projection, as GIBS has.** A WMTS
layer has one `ResourceURL` template per format, with no tie to a tile
matrix set, and these paths differ by prefix as well as by set name,
so a client picking WebMercatorQuad from a shared document would fill
in `/epsg4326/…/WebMercatorQuad/…`. Each document links each layer to
its one set. A per-dataset document beside them serves Hub items, and
§9.14, since a fetch of the whole document names no dataset. Each
layer advertises three `ResourceURL`s, as GIBS does: with `{Time}`,
without it, and with a literal `default`, for clients that ignore
dimensions.

- `{datasetId}` is the catalog ULID, which is stable; slugs can change.
- `{style}` is `default` in v1 (§5.4).
- `{ext}` is `png` (alpha) or `jpg` (opaque); WebP is not offered,
  because GDAL builds and GIS clients do not uniformly read it.
- `{time}` accepts any ISO 8601 UTC form a client is likely to build —
  a date (`2026-05-16`), a date and time with or without seconds or
  fractional seconds, with `Z`, `+00:00` or nothing, a colon sent as
  `%3A`, and in KVP a `+` that arrived as a space — because OpenSpace
  formats the time from a per-layer picture string the producer
  writes, `toISOString` and the ArcGIS SDK add milliseconds, and a
  strict parser would turn every mismatch into a 404. It also accepts
  ISO 8601's basic form (`20260516`, `20260516T120000Z`). D1 found that
  QGIS sends a basic-form date when a capabilities document lists its
  times with milliseconds (`delivery/D1_PROTOTYPES.md` §3.3), and that
  CesiumJS sends the colon as `%3A` (§3.2).
- **A reduced-precision time names an interval.** A date is that UTC
  day, and selects the first frame inside it; only when none does is
  §5.3's snap applied. Without the rule, daily frames stamped at 12:00Z
  would answer `2026-05-16` with the 15th's frame, and GIBS
  configurations, whose easy adaptation is the point of this grammar,
  send dates.
- KVP `GetTile` and `GetCapabilities` requests are accepted and mapped
  onto the same handlers, since some clients only issue KVP, and both
  encodings are advertised in `OperationsMetadata` (`GetEncoding`).
  QGIS 3.34 used KVP for every tile when both were advertised, never
  the REST template, so KVP is the encoding QGIS users depend on (D1
  §3.1).
  Extra query parameters on the REST capabilities address are ignored,
  since QGIS adds some and §9.14's `via` is one. Time must be in the
  *path* for OpenSpace regardless: GDAL's WMTS driver has no time
  option and fills each dimension with its `Default`, so OpenSpace
  reaches time-varying tiles only through a URL template read by
  GDAL's TMS driver (§2.2).
- **Errors are OGC's.** A tile outside the matrix or a malformed
  parameter is a 400 `ExceptionReport` (`TileOutOfRange`,
  `InvalidParameterValue`), which OGC's test suite expects; a time
  outside the dataset's span stays a 404.

Living under `/api/v1/` puts the service inside the node's existing
versioned surface: a breaking change is a `/v2/`, and the contract is
pinned in `docs/protocol/` the way STAC's is (§8).

### 5.3 Time

- **The dimension is `Time`, in ISO 8601 UTC**, declared per layer in
  the capabilities document. Because frame times are computed as
  `start_time + period × index`, a layer declares a compact
  `start/end/period` interval rather than listing every frame, with no
  milliseconds in any advertised time: QGIS's parser for listed values
  accepts `YYYY-MM-DDTHH:MM:SSZ`, a date or a year, and today's
  `frameTimestamp` emits `.000Z`. D1 narrowed the reason. QGIS 3.34's
  interval and WMS-T parsers take milliseconds. Its WMTS parser loads a
  millisecond list, then requests `Time=20260928`, a basic-form date
  that a parser accepting only the extended form answers with a 404
  (`delivery/D1_PROTOTYPES.md` §3.3; §5.2 now accepts it). **Irregular series are not tiled in
  v1**: frame times come only from start and period
  (`functions/api/v1/_lib/frames-manifest.ts`), so there is no source
  for a list.
- **Calendar periods use calendar arithmetic.** `iso-duration.ts`
  counts `P1M` as 30.44 days and `P1Y` as 365.24, which is harmless for
  `/frames?at=`'s nearest-frame rounding and wrong for rounding down: a
  monthly series starting 1 January stamps frame 2 at 1 March 20:58,
  so a request for 1 March floors to February, and a yearly series
  starting 2001 answers 2002, 2003 and 2004 a year early. Both periods
  are in the catalog. `tile-grid.ts` uses calendar arithmetic, a
  declared `start/end/P1M` matches it, and D2a fixes `frameTimestamp`
  at the source (§6.3). GIBS's check here used a mid-month date, which
  is exactly the case that hides this; D1 requests the 1st of each
  month. D1 measured it with the repository's own `frameTimestamp`.
  Floored on average durations, requests on the 1st are answered with
  the wrong frame for 10 of SOS 491's 12 months and 116 of SOS 420's
  175 years. A stamp can also fall in the previous calendar year
  (2005's frame at `2004-12-31T23:16:48Z`). QGIS steps months on the
  1st at 00:00Z, so calendar arithmetic is what makes it right (D1
  §3.3).
- **A requested time snaps down to the frame whose period contains
  it**, and a time outside the dataset's span is a 404. That is GIBS's
  behaviour, checked with live requests (a mid-June date returns the
  June tile byte for byte; a date in a gap returns 404 over WMTS).
  Clients need it: QGIS sends its temporal controller's frame start as
  it is, CesiumJS shows the interval that contains its clock, and
  clients that animate on a fixed step — OpenSpace rounds simulation
  time to a configured resolution — ask for times that are not frame
  times and must get the frame they are inside, not an error. D3a tests
  the round trip: for every advertised time tᵢ, the snap of tᵢ is frame
  *i* and the snap of tᵢ less a millisecond is frame *i* − 1. D1
  confirmed the clients' side. QGIS sends the start of its temporal
  range verbatim, whatever interval-handling method is set; GDAL sends
  the `Default`; CesiumJS asks for the start of the interval containing
  its clock. Every off-frame request QGIS made was answered right by
  this rule. One case it cannot fix is frames stamped mid-period, such
  as SOS 643's daily frames at 12:00Z. Stepping by day from midnight,
  QGIS gets the previous day's frame, and so does CesiumJS for any
  clock before noon, because it asks for an exact frame time (D1
  §3.2). Only the advertised time can fix that. **Decided 2026-11-08 by
  the maintainer (q27):** a frame that represents a period is advertised
  at the start of that period, 00:00Z for a frame standing for a day.
  This applies only where the dataset's record says what its frames
  represent; a frame with no such record is advertised as stamped. The
  record is the represented time Phase 0 of the metadata work persists
  (`metadata/PHASE0_IMPLEMENTATION.md` step 2).
- **This deliberately differs from `/frames?at=`**, which returns the
  *closest* frame. A closest-frame rule shows a frame up to half a
  period before its own time, which for a forecast is showing the
  future. The difference is documented on both routes rather than
  resolved by changing the existing one (decided, §11 q4).
- **`default` is the latest frame**, matching GIBS, so a client that
  sends no time gets the most recent picture. GIBS does not accept a
  `current` keyword, and neither should this.
- **Long time lists are capped.** GIBS's capabilities document carries
  only the latest 100 periods per layer and answers a `DescribeDomains`
  request for the rest; its 4326 document is 5.3 MB for 1,332 layers.
  Regular series here declare one `start/end/period` interval and need
  no cap. But QGIS 3.34 expands an interval into at most 1,000
  instants. At 1,001 it shows the layer as one undivided range with no
  frame list, though it still animates through the server's snapping;
  a list of values expands whatever its length (D1 §3.3). Clouds, at
  4,314 ten-minute frames, would collapse. **Decided 2026-11-08 by the
  maintainer (q29):** keep the compact interval past 1,000 steps. QGIS
  still animates such a layer through the server's snapping, and the
  capabilities documents stay small.
- **Datasets with no real time axis** — a looping diagram animation, a
  "typical year" climatology — are not tiled in v1. Exposing a frame
  index as a non-time dimension is valid WMTS, but almost no client
  animates anything but `Time`, so it would publish layers nobody can
  play.

### 5.4 Styles

- **`default`** — what the TerraViz globe shows. For an RGB dataset
  that is the frame. For a data-encoded dataset it is the frame with the
  dataset's own palette applied, through the same `buildColorScaleLut`
  the shaders sample (`src/types/color-scale.ts`), so one code maps to
  one colour on both, and the palette's alpha, its ramp and the no-data
  band, becomes the tile's (§7.3). A tile and the globe can still
  differ, and the abstract says how. Zoomed out, the globe point-samples
  (nearest, no mipmaps: `src/services/earthTileLayer.ts`) where a tile
  shows an area mean (§7.1). The globe shows the decoded H.264, about
  one code of noise plus the codes a video round trip never produces,
  where a tile cut from stored PNG frames has neither. And clients
  magnify tiles with their own filters.
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
(`src/types/index.ts:125-143`), in the order the probe applies it:

- **`isFlippedInY`** — flip to north-up.
- **`lonOrigin`** — rotate so the left edge is −180°. A `lonOrigin` that
  is not a whole number of source pixels needs a sub-pixel shift, and
  then §5.1's "no resampling at the native level" does not hold.
- **`boundingBox`** — a regional frame is placed into its box on a
  transparent full-globe canvas, or, cheaper, cut only for the tiles it
  touches, with the rest returning an empty tile. Placing it is a
  resample, nearest neighbour for data, since its pixels never line up
  with the global grid and need not be square in degrees: its width
  implies W × 360 / (east − west) across the globe and its height
  H × 180 / (north − south). Its native level comes from the finer of
  the two (§7.1), so a 4096-wide frame over 60° is cut at level 5, not
  level 2. A box crossing the antimeridian is split, which the probe
  already supports (`src/services/datasetProbe.ts:56-63`). A regional
  picture needs alpha, so it is PNG, not JPEG; GDAL fills a 3-band
  tile it could not fetch with black, which §5.7's `ZeroBlockHttpCodes`
  addresses.
- **Precedence.** `latLonToTexelUv` ignores `lonOrigin` when the
  bounding box is regional, and SOS rows carry ±180, so a cutter that
  applied all three independently would shift a regional frame 180°.
- **`celestialBody`** — a dataset of another body (`src/types/index.ts`)
  is excluded from both grids, or a Mars dataset is published on Earth.

These three are where an export most easily goes wrong. The renderers
record a US bounding box landing over the South Pacific once already
(`src/services/photorealEarth.ts:676`, `src/output/layerStack.ts:711`).
The cutter should be tested against the probe the hover readout uses
(`src/services/datasetProbe.ts:45`, `latLonToTexelUv`) rather than
against its own idea of where a texel lands, with a regional box and an
antimeridian-crossing one among the cases.

### 5.6 Where tiles are made and kept

- **Cut at publish time, in the GitHub Actions runner** that already
  transcodes uploads (`cli/transcode-from-dispatch.ts`,
  `.github/workflows/transcode-hls.yml`) and runs Zyra workflows
  (`cli/zyra-publish-from-dispatch.ts`), with GDAL. Not on request: a
  Pages Function decoding a 4096×2048 PNG per tile would spend the CPU
  budget the STAC rollout gate is already measuring.
- **Stored in R2** under a content-addressed prefix keyed by everything
  that changes a tile: the frame's digest, the palette's digest, the
  reduction method (which the publisher can change, q6), the
  normalisation, the grid and a cutter-recipe version. Keyed by the
  frame alone, a palette change would neither re-cut nor invalidate
  anything. A re-published dataset re-cuts only what changed. Unlike
  the earlier draft, this does not promise that a frame shared by two
  datasets is cut once: `cli/lib/frame-store.ts` keys frames per
  dataset (`videos/{datasetId}/frames/sha256/…`). An option D1 weighs:
  one object per frame per grid with an offset index, read by R2 range
  requests (the PMTiles-on-R2 pattern), which cuts the object count
  about 380 times and makes clean-up trivial, since every tile passes
  the Function anyway.
- **Served by a Pages Function** that resolves `{time}` to a frame,
  reads the tile from R2, and caches at the edge. A Function in front
  (rather than a public bucket URL) is what makes time snapping, KVP
  requests, CORS and visibility checks possible. Its cost is one Worker
  invocation per tile request, which on a free-plan node is the binding
  limit (§5.8). Tiles are served only this way, never straight from the
  bucket, so every tile passes the same checks (decided, §11 q12).
  - **Cache key**: the resolved digest after snapping, not the request
    address, since OpenSpace and QGIS send off-frame times and an
    address key would miss every time; `via` is stripped before the
    lookup. An `ETag` and a finite max-age, a short one for `default`.
  - **The time-to-frame index** is computed arithmetically for a
    regular series, or memoised per isolate, not read from R2 per tile.
  - **CORS** is `Access-Control-Allow-Origin: *` on every response:
    tiles, 404s, a `403 feature_disabled`, capabilities, TileJSON and
    the GDAL XML, with `OPTIONS` answered, since `public/_headers`
    rules do not reach a Function's responses. MapLibre needs it
    because it fetches tiles, and CesiumJS and OpenLayers' WebGL layer
    because WebGL refuses a cross-origin image without it; OpenLayers'
    default Canvas layer does not.
- **Visibility follows the catalog.** Only public, published,
  non-retracted datasets get tiles, the same predicate the STAC
  projection uses (`functions/api/v1/_lib/metadata-readiness.ts`). The
  tile route checks it per dataset before any cache, memoised per
  isolate for a short time, and a cold isolate that cannot read storage
  refuses rather than serves, because §8 relies on retraction to
  withdraw a dataset and to fail closed. A retraction removes the layer
  from the capabilities documents and stops its tiles at once; a
  clean-up job, built in D3a, deletes the objects later.

### 5.7 Capabilities and companions

Each projection's WMTS capabilities document (§5.2) is generated by a
Function from the catalog database: one layer per eligible dataset, its
time dimension, its one tile matrix set, the abstract, attribution and
licence from the catalog record. Two rules for its bounding boxes
come from D1 (`delivery/D1_PROTOTYPES.md` §3.1, §3.4):
- **A Mercator layer's `WGS84BoundingBox` stops at ±85.0511°.** Running
  it to ±90°, GDAL made a 4096-wide pyramid into a raster 49,577 pixels
  tall.
- **A layer whose box crosses the antimeridian declares −180 to 180.**
  Both GDAL and QGIS read a box from 150 to −150 as its 300°
  complement and draw nothing right. Its limits and tiles still cover
  only the box, and its abstract states the real bounds.

Beside it, cheap per-layer companions for clients that do not read
WMTS capabilities:

- **TileJSON** for MapLibre and other XYZ web maps, on the Mercator
  grid only, since MapLibre cannot draw the lat/lon one. It sets
  `"tileSize": 256`, or MapLibre assumes 512 and renders blurry. It has
  no time, so it bakes in `default`, or one is offered per time. Its
  `attribution` is escaped, since TileJSON 3.0 lets clients treat it as
  HTML and Leaflet and OpenLayers insert it as it is. D1 confirmed the
  `tileSize` rule: without it MapLibre asked for zoom 2 where it
  needed zoom 3, the right place at half the resolution. The docs that
  go with it also need two settings D1 found are needed:
  - Leaflet needs `zoomOffset: -1` beside `tileSize: 512`; without it
    the tiles landed up to 2,044 source pixels out.
  - A CesiumJS `TimeIntervalCollection` must include the last frame's
    interval (`trailingInterval`, or the stop included). A clock
    outside every interval sends a literal `{Time}`, which is a 404.
- **A GDAL WMS XML** per layer for GDAL-based tools, with
  `ZeroBlockHttpCodes` of `204,404` (the default is 204 alone, so a
  regional or gap 404 aborts the read), `BandsCount` 4 for PNG layers,
  `MaxConnections` raised from 2, and a `<Cache>`, both of which shape
  what a time step costs. A plain GDAL tool cannot follow time, so the
  generic XML uses `default`. D1 confirmed the first point. With the
  default, `gdal_translate` of a regional layer failed at the first
  tile outside its box; with `204,404` it read. GDAL's WMTS driver sets
  `204,404` for itself, and the XML does not. Partial palette alpha
  survives `BandsCount` 4 exactly (D1 §3.4).
- **An OpenSpace asset, not just the XML.** OpenSpace needs a `.asset`
  with a `Prototyped` table (start, end, `TemporalResolution`, a time
  format) and the XML inline as the prototype carrying
  `${OpenSpaceTimeId}` (`modules/globebrowsing/src/tileprovider/temporaltileprovider.cpp`).
  D1 tests that asset. What §4's table calls WMTS for OpenSpace is
  really GDAL's TMS driver over these tiles.
- **A colour map and legend** per data-encoded layer, in GIBS's
  ColorMap v1.3 XML (source value ranges to colours, no-data flagged,
  the first and last entries open-ended for clipping, §7.1), with SVG
  and PNG legends generated from the dataset's `color_scale`, so a
  client that already reads GIBS colour maps reads TerraViz's. In v1.3
  the classification, continuous or discrete type sits on each
  `<ColorMap>`'s `<Legend>`, not on its entries. It is linked as GIBS
  links it, an `ows:Metadata` with the `…/colormap/1.3` role plus a
  `Style/LegendURL`, PNG for WMS, which ArcGIS and QGIS show.
- **STAC links** — each item gains links under the STAC web-map-links
  extension, so a STAC client finds the tiles from the catalog it
  already reads (§4.3). A REST `wmts` link uses `uriTemplate` and
  `variables` (`wmts:dimensions` is for KVP only); an `xyz` link allows
  only `{x}`, `{y}`, `{z}` and `{s}`, so the time is baked in, which
  suits STAC items here being one per frame (`stac-history.ts`);
  `tilejson` and `wms` links are added too.

### 5.8 Cost, roughly

Measured in D1 (`delivery/D1_PROTOTYPES.md` §3.15) on a machine of a
GitHub runner's shape, except where a row says otherwise. The first
draft's estimates are kept in brackets where D1 changed them.

| Quantity | Measured |
|---|---|
| Tiles per 4096×2048 frame, WorldCRS84Quad layout at 512 px | 42 (as estimated) |
| Tiles per frame, WebMercatorQuad at 256 px to level 4 | 341, 1.9× the lat/lon set's bytes and 8× its objects (as estimated) |
| Bytes per frame, lat/lon grid at 512 | 1.8–2.0 MB for a 4096-wide picture as JPEG; 8.9 MB for the same as PNG; 21 MB for MPAS's 7200-wide data frame as indexed PNG; 0.6 MB for the RRFS regional frame. [Estimated ~1.3× the frame: true only of a source 1024 × 2ⁿ wide, since the cut to the native level multiplies by (native width ÷ effective source width)², 1.29× for 7200 → 8192 and 2.3× for RRFS's effective 10,800 → 16,384] |
| Per 1,000 frames, both grids | 5.2 GB and 383,000 objects for a 4096-wide JPEG picture; 44 GB and 1.5 million objects for MPAS; 1.3 GB and 228,000 objects for RRFS. [Estimated "tens of GB": true of data, not of pictures] |
| Cut time per frame, single core, all four tile sets | 1.5 s (RRFS), 5 s (4096-wide pictures), 10.5 s (MPAS); 167 frames in 173 s on four cores |
| Upload time per frame, loose against packed | **Not yet measured**: needs the scratch R2 bucket. Object counts per frame are 383 loose against 2 packed (one per grid) |

R2 charges for storage and operations but not for egress, so a popular
layer costs requests and Function invocations, not bandwidth. The costs
that grow with the catalog are
runner minutes and object counts on long animations, which is why
§9 tiles datasets that have frames already, and leaves the legacy video
catalog to a later, opt-in phase.

**The free plan has a cliff.** Every Functions request counts against
an account-wide 100,000 a day (`docs/SELF_HOSTING.md` §0.6). Past it, a
fail-open setup loses its API and a fail-closed one its whole site.
One OpenSpace show, which refetches every tile on screen at every step,
can spend tens of thousands of those in an evening. And a WMS `GetMap`
cannot fit the free plan's 10 ms of CPU, against 30 s by default on a
paid plan. So WMS has its own switch, `wms`, off by default (decided,
q26): `SELF_HOSTING.md` says to turn it on only on a plan tier where
D4's CPU gate passed, and states the daily request budget the `tiles`
switch's WMTS layers draw on. D4's gate names the plan it was measured
on.

### 5.9 WMS with time

ArcGIS's time slider follows only WMS time (§2.1), QGIS has animated
it longest, WorldWide Telescope's Windows client and OpenSpace's v0.22
server panel read WMS, and GIBS still recommends WMS for time in GIS
clients. So a WMS 1.3.0 endpoint with a `TIME` dimension is in scope,
built after the WMTS because it is served from the WMTS's pyramids.

- **Served from the pyramid, never from source frames.** A `GetMap`
  for a box, a size and a time picks the pyramid level at or finer than
  the requested resolution in the matching grid — the lat/lon pyramid
  for `CRS:84` and `EPSG:4326`, the Mercator pyramid for `EPSG:3857`,
  with `EPSG:102100` and `EPSG:900913` accepted as aliases — stitches
  the tiles covering the box, wrapping one that crosses the
  antimeridian, and scales the result to the requested size. Nothing is
  reprojected per request.
- **Axis order.** In WMS 1.3, `EPSG:4326` puts the BBOX and
  `BoundingBox` in latitude, longitude order while `CRS:84` uses
  longitude, latitude, and QGIS and GDAL send 1.3 order. D4's tests
  request a known asymmetric box in each, since stitching tested
  against its own tiles cannot catch a transposed map.
- **Versions.** Version negotiation, and 1.1.1 as well as 1.3.0: GDAL's
  WMS default is 1.1.1, which OpenSpace's panel uses, and Google Earth
  Pro is reported to speak only 1.1.1. 1.1.1 uses `SRS` and an `Extent`
  element.
- **Bounded.** `MaxWidth` and `MaxHeight` are 2048, ArcGIS's own
  client default, which bounds the tiles any one request stitches;
  QGIS splits its requests to fit. Whether that fits is a measurement,
  not an assumption. All Pages Functions are one Worker, whose 128 MB
  is per isolate and shared by concurrent requests and every route, so
  a `GetMap` that runs out of memory takes unrelated API calls with it,
  and R2 reads count toward six simultaneous connections, so 81 Mercator
  tiles arrive in about 14 waves. D1 measures memory and CPU under
  concurrency on both plan tiers, and a separate Worker for WMS is an
  option.
- **A cheap path for data layers.** Decode the indexed PNGs to their
  indices, scale by nearest neighbour, and re-encode with the same
  palette chunks: one byte a pixel and no colour arithmetic, which may
  decide the CPU gate.
- **The final scale follows §7.1.** A data layer is scaled by nearest
  neighbour, because its pyramid level already carries the dataset's
  own decimation and interpolating between palette colours would undo
  it; a picture layer may be scaled bilinearly. Cloudflare's image
  transformations could do the picture-layer scaling without Worker
  CPU, but their filters interpolate, so they cannot do the data
  layers. An option to evaluate, not a decision.
- **Time follows §5.3, with one difference.** GIBS answers a WMS
  request for a date in a gap with a blank transparent image rather
  than a 404 (checked live), because a WMS client shows an error where
  a tile client shows a gap. This copies that, in PNG, since a JPEG
  answer cannot be transparent. A `TIME=a/b` range, which QGIS offers
  as "whole range", is defined (the latest frame in it, say), and the
  dimension declares `nearestValue` and `multipleValues` as served.

---

## 6. Files for players: video and packages

For the groups whose job is to *play* a whole globe — dome shows,
Science On a Sphere sites, spherical displays, a sphere in a virtual
world, a clip in a story — the efficient format is a file: a video, or
a set of frames with dates. TerraViz already makes both (§1), for its
own player. This section makes them usable by other players: which
variants, how they carry time, how they are bundled for each group, and
where they live.

### 6.1 Video variants

| Variant | Encoding | For |
|---|---|---|
| `h264-4096` | H.264 High@5.1, 4096×2048, 8-bit 4:2:0, constant frame rate, a keyframe at least every second, `faststart` | OpenSpace, spherical displays, Digistar, web developers' globe materials |
| `h264-2048` | The same at 2048×1024 | Smaller domes and spheres, Second Life faces at 2048, StoryMaps clips |
| `h264-1024` | The same at 1024×512, about 1.5–2 Mbit/s | Second Life's default face and slow links. A plain MP4 for its video-player path; `SECOND_LIFE_COMPAT.md` §7's 1024 rendition is an HLS rung for the output page, a different file with a different GOP |
| `sos-mpeg4` | MPEG-4 Part 2 at a quantiser floor (`-q:v` 1–2), 2048×1024 (4096×2048 on request, at a proportionally higher rate) | Science On a Sphere, whose guidelines rule out H.264 and ask for at least 25 Mbit/s (§2.4) |

Second Life is not on the 4096 row: its media is capped at 2048, so
LibVLC would decode 4K and scale it in software for every visitor. A
bitrate target for `sos-mpeg4` undershoots on easy content (18 Mbit/s
measured at 2048×1024 against a 25 Mbit/s target), so the floor is a
quantiser, and ffmpeg's `mpeg4` encoder labels every stream Simple
Profile @ Level 1 whatever its size. Zyra's `compose-video` `sos`
preset rescales luma and is never used for data-encoded content.

D1 measured the SOS variant (`delivery/D1_PROTOTYPES.md` §3.12):
- **The label is confirmed:** Simple Profile, level 1, untagged, for a
  2048×1024 stream at 58 Mbit/s.
- **`-q:v 1` produced the same file as `-q:v 2`**, because ffmpeg's
  default `qmin` is 2. The encode passes `-qmin 1` with `-q:v 1`, or
  states its floor as 2.
- **The floor gives the encoder's best quality, not SOS's bitrate.**
  At `-q:v 2` a weekly drought series ran at 17 Mbit/s, under SOS's
  25, and 34 seconds of 10-minute clouds at 58.5 Mbit/s (245 MB). The
  bundle states the rate it reached; whether SOS accepts a movie under
  25 Mbit/s at the best quantiser is for the SOS contact (q9).

- **One video frame per data frame.** Frame *i* of the file is frame *i*
  of the dataset, so a player that maps a start and end time linearly
  onto the file's duration — OpenSpace does exactly that — lands on the
  right date. A series whose frames are not evenly spaced in time is
  not offered as a time-synced video; it goes out as frames (§6.4),
  which carry their own dates. The frame rate sets only how fast the
  file plays by itself, and is the dataset's own `playback_fps`, not
  30: the catalog's encode holds each frame across a 30 fps file
  (`cli/transcode-from-dispatch.ts`), but one frame per data frame at
  30 fps loops a 41-frame dataset in 1.4 s, which matters to every
  player that plays the file by itself. The SOS bundle writes the same
  rate as `playlist.sos`'s `fps`.
- **Keyframes at least every second** (`-g` of max(1, round(fps)))
  because OpenSpace's time-synced playback seeks on every step, and a
  seek decodes from the keyframe before it. OpenSpace uses hardware
  decoding and skips a seek while one is in flight, so a slow seek
  drops steps rather than stalling; D1 compares 1 s against shorter
  GOPs, and all-intra for short series, with hardware decoding on and
  off, and checks keyframe positions with `ffprobe` rather than trusting
  the flags. **D1 found the 1-second interval nearly free.**
  - Keyframes landed every second exactly.
  - At the 25 Mbit/s cap, 1,008 frames of clouds at 4096×2048 came out
    the same size at 1 s and 6 s, with luma PSNR 34.70 against 34.74
    dB.
  - With no cap, at the same CRF, the 1-second file was 2.5% larger.
  - For 51 weekly drought frames, which share little from one to the
    next, all-intra cost 3.5% more than a 1-second interval.
  
  What a seek costs on the dome's hardware decoder is the OpenSpace
  kit's question (D1 §3.9).
- **Everything else pinned.** `-profile:v high -level:v 5.1`, so a
  variant above 30 fps fails a test rather than quietly needing level
  5.2 (4096×2048 at 30 fps is exactly 5.1's macroblock rate). No audio
  (`-an`), since mpv's duration includes it and OpenSpace divides by the
  duration. Constant frame rate with the first timestamp at 0, and no
  B-frames (`-bf 0`) for the widest support. A bitrate or quality
  policy per size, set in D1, since a 1 s GOP costs bits against
  today's 6 s. An 8192×4096 variant would need H.264 level 6.0, beyond
  common hardware decoders, so it is HEVC or frames.
- **Colour tagged.** ffmpeg converts RGB to YUV with BT.601 and leaves
  the stream untagged, and mpv and VLC guess BT.709 for HD-sized video:
  RdBu's red (178, 24, 43) decodes as (190, 39, 40). Palette-applied
  and picture video is encoded with
  `scale=out_color_matrix=bt709:out_range=tv` and the full tag set,
  `DATA_ENCODED_VIDEO_PLAN.md`'s rule of tagging everything or only the
  range, never in between. SOS's own matrix is unknown, so D1's SOS
  test carries a palette swatch. Today's image-sequence HLS encodes are
  untagged BT.601 too, which is a separate fix.
- **H.264 for reach.** It is the one codec every player above decodes —
  libmpv, LibVLC, every browser, hardware decoders on modest machines.
  HEVC and AV1 are smaller and can be added as further variants; they
  are not the default. MPEG-4 Part 2 exists only because SOS asks for
  it.
- **HLS stays where it is**: TerraViz's own player, the output page in
  Second Life, and web developers who stream. OpenSpace and SOS cannot
  read it, so it is never the only video a dataset offers.

### 6.2 Data-encoded datasets

None of the players in §2 applies a colour palette to a video, so a
data-encoded dataset reaches them as **palette-applied RGB video**,
made by colouring the frames after decimating them in value space
(§7.1) — never by transcoding the luma video, whose encoder would
average codes and then colour the averages. It is a picture: 4:2:0 and
the DCT invent in-between colours at class boundaries, which is §7.3's
objection to JPEG, so a categorical (`mode`) dataset's OpenSpace asset
prefers frames.

**What shows where the palette is transparent.** The palette's alpha
is not all-or-nothing: 0 below `transparentRange`, and ramps elsewhere
(`src/types/color-scale.ts`), which TerraViz mixes over its own base
imagery. RGB video has no alpha, so a background is baked in, stated in
the manifest, and chosen not to lie on the palette: Blue Marble's ocean
is near-black (`rgb(2, 5, 20)`), as are many palettes' low ends, so a
black background would let no-data borrow a data colour. The legend
says what showing through means ("Earth visible: no data, or below
X"). The producer or the node's science reviewer chooses the
background, and D2a's parity test compares against the composited
colour, not the LUT entry. The same question applies to opaque SOS
frames.

**Where values must survive, frames are the format.** A data-encoded
frame is an 8-bit PNG whose codes map one to one onto the palette. It
is lossless only where the dataset was uploaded as frames; a
data-encoded MP4 upload has only its lossy video (§9.4). A lookup
image carries colours, not values, so with the frames go a manifest
embedding the full colour scale — `vmin`, `vmax`, units, `dataMinLuma`,
`transparentRange`, the code-to-value formula, and what clipping at
the ends means — the source resolution, the decimation method, and a
labelled legend, which data-encoded rows lack today because the
colorbar replaced the uploaded image (`src/ui/colorbarUI.ts`).

OpenSpace can apply the palette itself (`Colormap`, which requires
`Interpolation`, §2.2), but not faithfully:
- it blends neighbouring time steps *before* colouring, so a moving
  plume shows twice at half strength, and a blend across the no-data
  band invents values for the length of a step;
- its tile textures are always linear or mipmapped
  (`memoryawaretilecache.cpp`), so codes blend across no-data edges
  before colouring, the fringe TerraViz avoids with nearest sampling
  (`earthTileLayer.ts`);
- alpha comes from the greyscale frame, not the colormap
  (`interpolate_fs.glsl`), so a plain greyscale PNG paints the no-data
  band opaque, and frames would have to be grey plus alpha.

Palette-applied RGBA PNG frames, with interpolation off, may be the
more faithful default for public shows. D1 compares the two, and the
producer chooses; either way the asset's description states the
blending.

For TerraViz's own output page in Second Life, which can apply the
palette (§2.3), smaller data-encoded renditions — 2048 and 1024 wide —
built from value-space-decimated frames would end the 25 Mbit/s worst
case. They must be **pinned, not adapted**: chosen once for the face
and held, never switched by bandwidth mid-session, which is the form
`DATA_ENCODED_VIDEO_PLAN.md` (§Why the frame is 4096×2048) already
names as workable, because a rung switch changes the value under the
cursor. Pinning means holding `hls.currentLevel`, since
`capLevelForWidth` only caps and leaves the adaptive logic free
beneath it. These rungs depart from that plan's nearest-neighbour rule
for lower rungs (`flags=neighbor`), so it is updated with them: its
encoder rules kept, the bitrate scaled with the pixel count, each rung
added as a `check:luma-range` variant with an occupancy check, which
that check cannot see, and hover and Analyze kept on the full rung,
which `DATA_ANALYSIS_PLAN.md` calls load-bearing. They are output-page
work for `SECOND_LIFE_COMPAT.md`, not one of §9's phases.

### 6.3 Dates travel with the file

Every video and frame set carries a JSON manifest: dataset id, title,
credit and licence, variant, size, frame rate, frame count, the date of
each frame (or start, period and count when regular, computed exactly
as `/frames` computes them: `start_time + period × index`), the loop
period, and links to the palette and legend. For a calendar period
that computation is wrong today: `frameTimestamp` uses average months
and years (`functions/api/v1/_lib/iso-duration.ts`), which dates
frame 1 of a monthly series starting 1 January at 31 January 10:29.
D1 found the yearly form worse for a label: a series starting 2001
stamps 2005's frame `2004-12-31T23:16:48Z`, so `labels.txt` or a
filename cut to the date would call it 2004
(`delivery/D1_PROTOTYPES.md` §3.3). D2a fixes it at the source with
calendar arithmetic, so the route stays the one computation. Each
group's own form is derived from it:

- **SOS:** `labels.txt`, one line per frame.
- **OpenSpace video:** the start and end times the asset passes to
  `VideoTileProvider`, set half a mean step outside the first and last
  dates (start = t₀ − P̄/2, end = t₍N−1₎ + P̄/2), so each date lands
  mid-frame. OpenSpace floors the frame position
  (`modules/video/src/videoplayer.cpp`), and with the bounds on the
  dates themselves a monthly series shows the previous month on nearly
  every month-start step. D1 steps across month boundaries. D1's
  arithmetic adds a cost. Under the floor, bounds half a step out make
  the video show the **nearest** frame between frames, up to half a
  period ahead, which §5.3 rejects for tiles. A regular period snaps
  down exactly with bounds on the first frame and one period past the
  last; only a calendar period needs the half step, and even then a
  mid-month time shows the next month. **Decided 2026-11-08 by the
  maintainer (q30): video follows the tiles' rule.** Between frames it
  shows the earlier frame, never one ahead of its time. So a regular
  series' bounds are its first frame and one period past its last
  (start = t₀, end = t₍N−1₎ + P), which OpenSpace's floor turns into
  an exact snap down. A monthly or yearly series, which no linear
  mapping gets right, goes to OpenSpace as dated frames or as tiles,
  not as a time-locked video. The OpenSpace kit's step 5 confirms the
  floor on a dome (D1 §3.9).
- **OpenSpace frames:** dated filenames, `<id>_YYYYmmdd_HHMMSS.png`, for
  `TemporalTileProvider`'s Folder mode, seconds included so that a
  sub-minute cadence does not collide. Its filename date parsing
  looked off by one day in OpenSpace's source, so the exact form is
  settled by a Phase D1 test, not by reading (§11). D1 found the line.
  `TemporalTileProvider` hands SPICE `tm_mday + 1`, the day of the
  month plus one, so the 31st becomes day 32. The dome test, with date
  cards across three month ends, is in the OpenSpace kit (D1 §3.10).
- **OpenSpace sync:** `SecondsUntilResync` set for a dataset that
  updates, since the default caches forever and each resync downloads
  the whole file again, and `PlaybackMode = RealTimeLoop` for the 130
  of 204 snapshot rows that have no period.
- **KML:** a `TimeSpan` per overlay, from its frame's date to the next.

### 6.4 Bundles per group

| Bundle | Contents | For |
|---|---|---|
| OpenSpace asset | A `.asset` file whose `UrlSynchronization` fetches, through the files route (§6.5), either a dated frame zip (Folder mode; greyscale plus palette for data-encoded datasets) or an `h264-4096` MP4 (`VideoTileProvider`, mapped to simulation time), plus the legend as a screen-space image | OpenSpace — on the pattern of the 243 SOS assets it already ships |
| SOS directory | `playlist.sos`, `labels.txt`, 2048×1024 frames (4096 on request), the `sos-mpeg4` movie, the legend | Science On a Sphere sites |
| Frame zip | 2:1 JPEG (pictures) or PNG (data) frames at 2048 and 4096, plus the manifest | Spherical displays, Digistar, WorldWide Telescope, anyone |
| KMZ | One GroundOverlay per frame, at most 2048×1024, each with a TimeSpan | Google Earth Pro; Google Earth on the web without animation |

**Packaging rules.**
- `UrlSynchronization` names the local file after the address's last
  segment with `?` deleted, and unzips only names ending `.zip`
  (`modules/sync/syncs/urlsynchronization.cpp`). With D2b's `via` tag,
  `frames.zip?via=x` would become `frames.zipvia=x` and never unzip.
  So the asset sets `Filename` explicitly, and files-route names carry
  real extensions.
- OpenSpace refuses Zip64, and a 4096-wide zip of a long series can
  pass 4 GiB. So a zip holds one resolution, a long series is split,
  and the writer adds no Zip64 record it does not need.
- One 2048×1024 overlay per frame runs a long KMZ to hundreds of
  megabytes, so it caps its frame count, decimating in time with
  §7.2's caveat.
- Every dataset reaching a player that maps a whole 2:1 frame onto
  −180…180 is normalised first, by §5.5's rules: a dateline-centred
  frame is rolled, a regional one is placed on a global canvas (with
  the resolution loss stated) or sent only in forms that carry bounds
  (SOS `layernorth`/`south`/`east`/`west`, KML `LatLonBox`,
  georeferenced frames), and a non-Earth dataset goes to the right
  OpenSpace globe or is excluded.

### 6.5 Where files live, and their addresses

- **Built by the runner** that already encodes the HLS ladder, at
  publish time, and stored in R2 beside it. A bundle is built for a
  dataset when the publisher turns it on, not for every dataset by
  default: frame zips duplicate frames, and the legacy catalog is
  large.
- **Stable addresses, served by the node.**
  `GET /api/v1/datasets/{id}/files/{name}` answers with a redirect to
  an immutable, digest-named path on the same route, which the Function
  serves from the R2 binding with `Range`, `ETag`, `Accept-Ranges` and
  an explicit `HEAD` handler, checking the `files` switch on every
  request, the way `functions/api/v1/media/video-proxy.ts` already
  serves video. A republished dataset changes the digest path and not
  the address a dome's asset file holds, and a player's range requests
  keep hitting an object that never changes.
  - **Never a presigned or expiring link.** Second Life's LibVLC loops
    and reconnects against the redirected address, so a link that
    expires in minutes stops the globe on its first loop after expiry.
    A presigned link is signed for one method, so the viewer's `HEAD`
    probe for `video/mp4` fails. A cross-origin hop sends
    `Origin: null` to the second host. Serving both hops from the node
    avoids all three, and needs no storage credentials on the read path.
  - **Followed redirects are confirmed in source:** OpenSpace's
    `UrlSynchronization` uses libcurl with `CURLOPT_FOLLOWLOCATION`, and
    Second Life's `HEAD` probe follows redirects.
  - **A legacy SOS video hosted on Vimeo** is Vimeo's own rendition,
    not an `h264-4096` meeting §6.1, behind a signed link that lasts
    about an hour (`functions/api/v1/datasets/[id]/manifest.ts`). It gets
    its own name with no time-sync promise, or it is re-encoded (§9.13).
  - **Each kind has its own `Content-Type`**, the redirect included,
    plus `Content-Disposition` and
    `Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges`,
    as `video-proxy.ts` sends.
- **Range requests, open CORS.** Players
  outside a browser ignore CORS, but a web developer's globe material
  needs it — and today the video host allows only the node's own
  origin (`SECOND_LIFE_COMPAT.md` §4.4). Decided (§11 q7): the files
  route answers with `Access-Control-Allow-Origin: *`; the existing
  streaming host is unchanged, so the app's own video keeps its
  narrower policy.
- **Only what may be redistributed, and always with its terms.** The
  same eligibility as STAC: public, published, and a licence on record.
  For the SOS catalogue the record is thin. The snapshot carries no
  licence field, the importer gives every SOS row one statement
  deferring to "the originating organisation's terms"
  (`cli/lib/snapshot-import.ts:209`), and many datasets are old enough
  that their creators' original terms cannot be traced. What every
  contributor shares is the aim of teaching people about the Earth
  without payment (the maintainer, 2026-11-06), which is what the SOS
  catalog's own published terms say
  ([copyright](https://sos.noaa.gov/copyright/)): free educational,
  journalistic and personal use, credit to the sources, nothing
  implying NOAA's endorsement, commercial use possibly restricted. So
  (decided, §11 q22):
  - **Default terms.** An SOS dataset with no traceable licence is
    delivered under those published terms, stated as what they are —
    non-commercial educational use, with attribution — and never
    relabelled with a Creative Commons licence nobody granted. In the
    catalog that is a terms statement with `license_url` pointing at
    the SOS copyright page, which the STAC readiness check already
    accepts as `other` with a link
    (`functions/api/v1/_lib/metadata-readiness.ts:115-121`), so no new
    mechanism is needed.
  - **A known licence wins.** Where a dataset's own licence is known —
    the NASA and WHOI datasets under CC BY-NC-SA, say — it is recorded
    as an identifier and used instead, with its conditions (q23).
  - **Credit always travels**: the sources and owners named on the
    dataset's catalog page, in every form the dataset takes — the
    manifest, the STAC item, each tile and WMS layer's attribution,
    TileJSON's `attribution` field, the OpenSpace asset's `meta` block,
    the KML description, the SOS directory, and the MP4's copyright
    tag.
  - **Withdrawal on request.** Every manifest and capabilities document
    names the node's contact, and an owner who asks has the dataset
    withdrawn from delivery. Retraction already removes it from
    capabilities and STAC at once (§5.6).

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
⌈log₂(W / 1024)⌉ for a frame W pixels wide at 512-pixel tiles. Sources
whose width is not 1024 × 2ⁿ are resampled *up* to that level once, at cut time — by
nearest neighbour for data-encoded frames, so every source cell keeps
its exact value and no boundary moves by more than half a source
pixel, and by Lanczos for RGB pictures. The capabilities abstract
states the source resolution, so nobody mistakes the native level for
finer data. Nothing is cut below the native level: OpenSpace, QGIS and
CesiumJS all stretch the deepest level themselves (§2), and ArcGIS is
the one client still to check (§11). For a regional frame the width
that counts is its effective global width, W × 360 / (east − west), not
W: a 2048-wide box covering 30° of longitude needs level 5, not level
1 (§5.5).

**Every level above native summarises the source, not the level
below.** WorldCRS84Quad's blocks align with the source pixel grid and
with the antimeridian, so no block straddles the seam and no
reprojection is needed. But building each level from the 2×2 blocks of
the one below does not keep the rules that follow:
- under the half-area rule a pixel k levels up can survive with (½)ᵏ of
  its source area valid;
- a mean of means weights each child by its area, not its valid area;
- the mode of modes is not the mode: children whose modes are A, A, B,
  B can hide a source with six cells of B to four of A.

So every level carries a valid-area channel. `mean` and `picture`
weight by it and threshold on the accumulated source area; `mode` is
computed from native cells or from carried class areas; `max` is exact
under recursion. Where the source width is not 1024 × 2ⁿ, the coarse
levels are built from the source with fractional-overlap weights, not
from the upsampled native level, whose duplicated columns (about one in
seven at 3600→4096, 42% at 1440→2048) would weight some cells two to
four times others. The §9.7 test that a mean equals `datasetStats`' over
the same cells runs at every level against source cells, which catches
all of this.

**How a 2×2 block becomes one pixel is a property of the data.** One
method for everything is the default in every tiling tool and is wrong
for some of the catalog. Proposed: a per-dataset `decimation` value,
set by the publisher, defaulted from the dataset's kind, and stated in
the capabilities abstract (decided, §11 q6):

| Value | For | Rule | What it costs |
|---|---|---|---|
| `mean` | Continuous fields: temperature, aerosol optical depth, sea-surface height | Area-weighted mean of the valid cells | Smooths extremes away at coarse levels |
| `mode` | Categorical fields: land cover, hazard classes, any palette whose colours are classes | Most common valid class by area; ties broken by a stated rule, reproducible across runs | Small classes vanish at coarse levels; a tie rule favouring one corner moves class boundaries toward it at every level, so D3a picks one that does not |
| `max` | Sparse extremes a mean would erase: fire detections, lightning, precipitation maxima | Largest valid value | Overstates extent: one 9.78 km detection is drawn 39 km wide at level 0, 16 times its area |
| `picture` | Natural imagery with no palette: true-colour composites, photographs | Mean in linear light; Lanczos upsampling; JPEG | Softens fine detail |
| `colour-mapped` | RGB pictures painted through a palette with a legend, which is most of the legacy SOS catalog, and categorical maps delivered as pictures | Nearest or representative pixel, or snapped to the legend's colours; an upsample that does not ring; PNG or 4:4:4 JPEG | Aliasing, and small features that flicker between levels |

A linear-light mean across a palette boundary makes colours that are
not on the legend, red and blue averaging to a purple that means
nothing, and on a categorical map it invents classes; Lanczos rings on
those same edges, and 4:2:0 JPEG bleeds chroma across them. That is
why `colour-mapped` exists. A legacy row with a legend image defaults
to it, and the node's science reviewer confirms each dataset's method.

**`max` says so wherever its picture goes.** Almost nobody who sees the
picture sees a capabilities abstract: not a dome audience, a StoryMap
reader or a Second Life visitor. So one sentence travels in every
legend (§5.7's SVG and PNG, and every bundle's), the TileJSON
`description`, the OpenSpace asset's `meta`, the manifest and the KML
description, with the cell size at each level: for instance,
"Zoomed out, each cell shows the highest value inside it; features look
larger than they are." The §6 files at 2048 and 1024 carry the same
overstatement and the same sentence. **Coverage as opacity** is the
alternative to offer: colour the maximum, set alpha to the share of
the cell above the cutoff, so one detection still shows, faint, and
extent reads truthfully. The producer chooses between them, the
Science Communicator words the caption, and on a NOAA node the
Communications Clearance Officer clears it.

**What the four methods miss.** Low extremes (there is no `min`),
per-cell counts whose units change with level (they need `sum`, or a
rule that only intensive fields are tiled), and cyclic fields such as
direction or phase, where a mean is wrong. The producer says which a
dataset is, and one with no method that fits is not tiled.

**A coarse pixel is a value nobody published.** An area mean at level
0, like a daily mean (§7.2), is the node deriving a value its producer
never published, which `CLAUDE.md` §When a person decides sends to a
person. So each dataset's method, and its producer's or the node's
science reviewer's confirmation of it, is recorded in
`dataset_delivery`: who decided, on what exact text, and when.

Four rules apply whatever the method.

- **Values, then colour.** A data-encoded frame is decoded to values
  (`lumaToValue`, `src/types/color-scale.ts`), decimated, and only then
  coloured. Averaging *colours* of a diverging palette produces colours
  the palette does not contain. `lumaToValue` is affine, so a masked
  mean of codes equals the mean of values: what matters is the mask.
  But a `max` taken on codes is the minimum of values when `vmin` is
  greater than `vmax`, which the parser permits, so an implementation
  that works on codes keeps that guard.
- **Only declared absence stays out.** Cells below `dataMinLuma`, the
  band that declares absence, are excluded from every method.
  `transparentRange` is not absence: it hides a band that *is* data but
  too faint to be worth drawing (`src/types/color-scale.ts`), and on the
  live smoke rows code 0 is a real zero. So those cells are included as
  values, and the palette hides a mean that comes out faint. Excluding
  them would make `mean` mean "where smoke is visible": a block of
  codes 40, 40, 5, 5 under a cutoff of 12 would show 40 where its area
  mean is 22.5, and a thin plume would vanish. For a row with a
  `transparentRange` and no `dataMinLuma`, the producer records whether
  the band means zero or absent before its tiles are cut. For the RRFS
  smoke rows, the maintainer recorded **zero** on 2026-11-08: a column
  mass near zero is a measurement of little or no smoke. GSL, the
  producer, has not been asked (`delivery/D1_PROTOTYPES.md` §1.2).
  Whether the
  output pixel is itself no-data depends on the method: under `mean`
  and `mode` when less than half the source area is valid, under `max`
  only when none of it is, because the point of `max` is that one fire
  pixel survives the zoom-out. The half-area threshold was decided
  (§11 q5).
- **Area, not pixel count.** An equirectangular row's cells shrink
  toward the poles, so the two rows of a block weigh differently. The
  weights are the exact band areas `datasetStats.ts` already uses
  (`R² · Δλ · (sin φ₁ − sin φ₀)`, `src/services/datasetStats.ts:167-176`);
  the difference only shows within a few pixels of a pole, but the
  pyramid and the Analyze panel should not disagree about what a mean
  is. At exactly half, the area weights decide which row wins (the
  equatorward one), so a data region can move poleward by up to half a
  coarse pixel; D3a states that rule.
- **Clipped at the ends.** Zyra clips at `vmin` and `vmax`
  (`src/services/datasetStats.ts:148`), so the top code means "at least
  `vmax`". Legends carry extend markers, the first and last entries of
  the GIBS colour map are open-ended, and a mean that includes clipped
  cells is a lower bound, which the abstract says. Units are a delivery
  condition for a data-encoded row, as a licence is, or the legend
  prints "units not recorded"; the producer supplies any that are
  missing. Proposed: the delivered legend uses the display units the
  globe's colorbar shows (`src/types/unit-scale.ts`), so the two match.
- **Linear light for natural pictures.** Averaging sRGB-encoded values
  darkens every high-contrast edge — coastlines, city lights, a bright
  plume on a dark sea. Decode, average, re-encode; the projector blend
  does the same for the same reason (`src/output/projectorWarp.ts:961`).
  The video variants relax this rule (§9.4), so a tile and a video can
  differ at a coastline; that is known, not a bug.
- **Magnified, not interpolated.** Clients that stretch past the native
  level filter the expanded colours bilinearly by default (CesiumJS,
  and probably OpenSpace), interpolating where the globe samples
  nearest, so the companions TerraViz generates set nearest
  magnification (CesiumJS's `magnificationFilter: NEAREST`), and D1
  checks OpenSpace.

**WebMercatorQuad is taken by nearest neighbour from the lat/lon level
of the same width.** At the native Mercator level a Mercator row is
cos φ of a source row, so a warp upsamples in y at every latitude, not
only near ±85.05°, and `gdalwarp`'s `average` would blend adjacent rows
across most of the map (about 70% of rows at 45°). Its default no-data
rule is `max`'s, and its average weights planar overlap in degrees
rather than area. So Mercator level z is taken by nearest neighbour
from lat/lon level z − 2, which has the same width and whose rows are
never coarser than Mercator's there. The dataset's method is applied
once, in the lat/lon pyramid, and the warp never averages. Two coarser
lat/lon levels, 512 and 256 wide, feed Mercator levels 0 and 1, and a
parity test checks the two grids against each other.

**D1 found the rule blocky toward the poles** (`delivery/D1_PROTOTYPES.md`
§3.15). A lat/lon row of the same width fills 1 ÷ cos φ Mercator rows:
2 at 60°, 2.9 at 70°, 5.8 at 80°, 11.5 at 85°. So every Mercator level
but the native one shows stair-steps several pixels tall over
Antarctica and Greenland. At the native level that is honest, since
the source has no more rows; coarser, a finer lat/lon level does have
them. Taking each Mercator row from the coarsest lat/lon level whose
rows are no taller than it keeps the rule, with no averaging across
rows in the warp, without the blocks. The cost is sampling columns
from a level finer than the row's width. **Decided 2026-11-08 by the
maintainer: D3a builds the alternative.** Each Mercator row is taken by
nearest neighbour from the coarsest lat/lon level whose rows are no
taller than it, so no row is blended with another and the poles keep
the detail the pyramid already has.

**Pictures with palette classes over imagery are common**, and D1
measured one (§3.15). The drought frames are single-pixel class
speckles over Blue Marble. At the native level, 4:2:0 JPEG at quality
85 lost 36% of the speckle pixels by a colour threshold; 4:4:4 JPEG at
the same quality kept all of them, at 1.6 times the size of 4:2:0 and
a third of PNG's. That is now the default for `colour-mapped`
pictures (§7.3).

### 7.2 Time: choosing samples

**A client chooses times; the node chooses frames.** Snapping a
requested time to a frame (§5.3) is decimation by *selection*, and
selection aliases anything periodic. An hourly field stepped every
24 hours shows the same hour forever: the diurnal cycle disappears,
and for anything with a day–night signal — surface temperature,
infrared clouds — one hemisphere stays in night for the whole
animation. A 23-hour step crawls the cycle backwards across the globe.
A 25-hour step advances it in the true direction at 1/25 speed, which
is worse, because it looks like real diurnal motion. A 12-hour step,
which OpenSpace offers, swaps day and night every frame. The node
cannot stop a client from choosing its step, but it can do three
things.

- **Advertise the native cadence.** Each layer's time dimension states
  its period, so a client that lets its user set a step (OpenSpace sets
  one per layer, §2.2) can match it.
- **Offer aggregated layers.** For long series, separate layers holding
  temporal aggregates — a daily mean of an hourly field, a monthly max
  of a daily one — computed at publish time in value space with the
  dataset's own method. They are separate layers rather than a style,
  because they are different data on a different time axis. Off by
  default; turned on per dataset, since each one is another pyramid to
  store. An aggregate is a value its producer never published, so it
  needs the recorded sign-off §7.1 describes, and it states its
  time-coverage threshold, its window convention (the UTC day, say) and
  a title that says "daily mean". Pictures with lighting or a
  terminator baked in are never aggregated.
- **Say so.** A layer with a diurnal cycle says in its abstract and
  asset description that a step of a day or more shows one fixed hour.

**Frames from video must recover the source cadence.** Every upload is
re-encoded at 30 fps (`OUTPUT_FRAME_RATE`, `cli/lib/ffmpeg-hls.ts:129`),
holding frames to get there. Extracting at 30 fps would tile each
source frame several times over. The dataset records its rate
(`playbackFps`, `src/types/index.ts`), so the extractor selects one
frame in every 30/`playbackFps`, or better cuts from stored PNG frames
or the kept upload (§9.4). De-duplicating instead is unreliable on a
lossy encode: an IDR frame can fall inside a run of held frames,
B-frames need not decode bit-identical, de-duplication drops frames
that genuinely repeat, such as an SOS animation's held title and end
frames, and a wrong count that divides the span still passes a
divisibility check. Tiles cut from video carry the codec's error,
about one code RMS with 35 of 244 codes never produced
(`docs/DATA_ANALYSIS_PLAN.md`), and the abstract says so.

**Rolling windows follow the frames.** Real-time Zyra datasets keep
only a window of frames (`cli/lib/r2-frames.ts`); their tiles follow
the same window, so a layer's time dimension has a moving start, which
clients that cache capabilities need to tolerate.

### 7.3 Bit depth and format

- **JPEG** (quality around 85) for opaque natural pictures, as GIBS
  does for its opaque layers. **`colour-mapped` pictures default to
  4:4:4 JPEG at the same quality** (decided 2026-11-08 by the
  maintainer). D1 measured it keeping every class speckle that 4:2:0
  lost 36% of, at 1.6 times 4:2:0's size and a third of PNG's (§7.1).
  PNG stays for a picture that needs exact colours or transparency.
- **Indexed PNG for data-encoded layers.** A data-encoded dataset's
  palette is exactly 256 entries (`buildColorScaleLut`), so a decimated
  value, re-quantised to the nearest of the dataset's 256 codes, can be
  written as an 8-bit indexed PNG whose palette chunk *is* the LUT and
  whose transparency chunk carries the no-data band. That is lossless
  with respect to what the TerraViz globe shows, about a quarter the
  size of RGBA, and keeps an exact code-to-colour mapping a careful
  client could invert, by index rather than by colour, since colours
  repeat in flat palette segments. ArcGIS reads palette PNGs (Esri's
  own tile caches use them), GIBS serves its colour-mapped layers that
  way, and GDAL — so OpenSpace and QGIS — expands them on read. The
  transparency chunk carries the palette's full alpha ramp, not only
  the no-data band, and D1 confirms partial alpha, not only on and off,
  survives in each. Because the index is the code, such a tile is in
  effect a raw-code tile, so the colour map and abstract publish `vmin`,
  `vmax` and `dataMinLuma`, and a GDAL or QGIS user does not read a bare
  index as a measurement. **D1 confirmed it for GDAL and QGIS**
  (`delivery/D1_PROTOTYPES.md` §3.4). RRFS's LUT fades through 48 alpha
  values, and `gdal_translate -expand rgba`, the GDAL XML's
  `BandsCount` 4 and QGIS's render all reproduced them exactly. It also
  found a gap: a row with no `dataMinLuma` uses every index for a
  value, so outside a regional box the tile can only write index 0,
  which reads as a measured zero. **Decided 2026-11-08 by the
  maintainer (q28), for now:** such a layer's abstract and colour map
  state that index 0 outside the dataset's box is not a measurement.
  Reserving a code when frames are made remains the cleaner fix for new
  datasets, if a GIS user is ever misled.
- **Never JPEG for data.** JPEG ringing along palette boundaries invents
  colours the palette does not contain — the false-colour failure of
  averaging colours, arriving through compression instead.
- **Re-quantising puts a mean back on the code grid**, the 256 codes
  (not the "transport lattice" `DATA_ANALYSIS_PLAN.md` uses for the
  codes a video round trip never produces). The step between adjacent
  codes is the quantisation step the Analyze panel already reports,
  about 0.4% of full scale, with one code roughly the noise floor; the
  abstract states it.
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
`DATA_ENCODED_VIDEO_PLAN.md` §Why the frame is 4096×2048). The data
path's scaler is nearest neighbour (`cli/lib/ffmpeg-hls.ts:254`): it
selects rather than averages, so the trouble with a smaller rung is not
averaged codes but aliasing, rungs that disagree about a value, and
`max` losing three of every four fire pixels. So any consumer that
needs a smaller data-encoded video gets one built from decimated
*frames* in value space, never one transcoded down from the 4K video
(§6.2). §7.1's methods also need defining for non-integer ratios
(7200→4096, `DATA_ENCODED_RESOLUTION_PLAN.md`) and for a coarse grid
upsampled to the native level.

### 7.5 What each tool actually uses

The targets the rules above are aimed at, from §2. "Stretches" means
the tool upscales past a layer's deepest level by itself, so cutting
deeper than the source would only spend storage.

| Tool | Space | Time | Format |
|---|---|---|---|
| OpenSpace | 4096×2048 for 4K domes, 8192×4096 for 8K; stretches | Steps of whole years; months 1–4 or 6; days 1–28; hours 1–4, 6 or 12; minutes 15 or 30. Finer data reaches it through server-side snapping (§5.3) or Folder mode | 8-bit; PNG for data frames with a palette image; H.264, constant rate, keyframe ≤ 1 s |
| Science On a Sphere | 2048×1024 for series, 4096×2048 for stills | 30 fps, 10–15 for coarse data | MPEG-4 Part 2 ≥ 25 Mbit/s; JPEG or PNG frames |
| Spherical displays, Digistar | 2048 or 4096 wide | 30 fps | H.264 (assumed; confirm per vendor) |
| Second Life | The face's media width, with the address's `width` to match: 1024 by default, 2048 for close viewing | Shared clock in the output page; a plain MP4 loops on its own | H.264; the 1024 rendition at 1.5–2 Mbit/s |
| ArcGIS Online | `GetMap` ≤ 2048; Web Mercator native at level 4 for 4096 sources; zooming past the deepest level unknown | WMS time, as an interval or a list | PNG with a palette, or JPEG; CRF with LERC for analysis |
| QGIS | Stretches | Sends the frame start as it is; the server snaps (§5.3) | Any |
| CesiumJS | Stretches | The interval containing its clock, no blending, prefetches the next | Any |
| Google Earth | ≤ 2048 a side on the web | One TimeSpan per frame (Pro only) | JPEG or PNG |

---

## 8. Contract and governance

- **A separate projection, like STAC.** Tiles, WMS and files are new
  routes over the canonical catalog database (Cloudflare D1). Nothing is added to
  `WireDataset`, `/api/v1/catalog` or the signed federation feed —
  the boundary the metadata audit drew for STAC
  ([`metadata/README.md`](metadata/README.md) §Relationship to earlier
  decisions; `architecture/federation-scoping.md` §8 decision 5 as
  amended).
- **Pinned when it ships.** Each surface gets its contract in
  `docs/protocol/` and an entry in its changelog in the same change
  that adds the route, as `architecture/federation-scoping.md` §7
  Directive 2 asks of every public wire format.
- **Advertised only when it answers.** `/.well-known/terraviz.json`
  gains an additive field naming the capabilities and file roots, in
  the shape D3c settles, present only while the service answers, its rollout flag set (§9)
  and its switch on (next item) — the pattern `federation.feed`
  already follows (`functions/.well-known/terraviz.json.ts`).
- **Switched per node, in the portal** (decided 2026-11-07). Each
  channel has its own switch in the node's Features card
  (`/publish/node-profile`, `src/types/node-features.ts`), because
  their costs differ: a node can serve video files without paying to
  store tile pyramids.

  | Switch | Covers | Off |
  |---|---|---|
  | `files` | The files route: video variants and bundles (§6) | The files route answers `403 feature_disabled`; manifests, STAC items, OpenSpace assets, KMZs and SOS directories drop their file links; the publish dispatch builds no new variants or bundles |
  | `tiles` | WMTS, TileJSON, GDAL XML, OpenSpace assets, colour maps (§5) | Every tile-service route answers `403 feature_disabled`, as an OGC exception report on the WMTS route; STAC items drop their web-map links; no new pyramids are cut. WMS stops too, since it is served from the pyramids |
  | `wms` | WMS with time (§5.9). **Off by default** (q26) | The WMS route answers `403 feature_disabled` as an OGC exception report, and STAC items drop their `wms` links. Pyramids are still cut and served as tiles |
  | `rasters` | Analysis COGs (§4.2, §9.11) | The raster route answers `403 feature_disabled`; STAC items drop the COG assets; the runner writes no new COGs |

  They work as every other switch in that card does
  (`docs/FEATURE_TOGGLES_PLAN.md`):

  - **On by default, failing open, except `wms`.** A node that never
    saved them, or whose settings cannot be read, has every channel its
    release ships. `wms` is the one delivery switch that starts off and
    fails to off (q26), because one `GetMap` can exceed the free plan's
    CPU limit; `src/types/node-features.ts` treats every key as on when
    missing today, so D4 adds a per-key default. So a node that upgrades starts building a channel on the
    next publish of each eligible dataset — for tiles, every dataset
    with frames (§5.8) — and backfills nothing until someone asks for
    it (the delivery dispatch, §9.4). Cost grows with publishing, not
    all at once on the day of the upgrade. `SELF_HOSTING.md`'s upgrade
    notes say so, with the daily request budget a node on Cloudflare's
    free plan has for them (§5.8).
  - **Checked in the Function, before any cache**, with the Orbit
    gate's last-known-good memo (`functions/api/_lib/orbit-gate.ts`).
    A cached tile or capabilities document is never served while its
    channel is off, and a storage blip does not turn a channel back on
    in an isolate that has read the switch. Refusals are `no-store`. A
    client that already holds a tile or a file keeps it until its own
    cache lifetime ends.
  - **Off withdraws the bytes, not only the address.** That holds only
    if nothing can be fetched past the Function. So files and rasters
    follow the tiles rule (§5.6, q12): the Function serves the bytes
    from the R2 binding, at an immutable path on its own route (§6.5),
    and no delivery object sits under the bucket's public domain. Not a
    presigned link: it would outlive the switch for its lifetime, and
    an expiring one breaks players that loop or reconnect.
  - **Off stops building and deletes nothing.** Stored outputs stay,
    so turning a channel back on serves them again at once. Anything
    missing is built on each dataset's next publish or by a requested
    backfill. Deleting them is a separate, deliberate action, never a
    side effect of the switch.
  - **Not a licence control.** A dataset withdrawn at its owner's
    request, or found not to be redistributable, is withdrawn on its
    own (retraction, or delivery turned off for that dataset in its
    record), which fails closed. The node switches fail open by
    design, the toggles plan's accepted risk, so they are the wrong
    tool for a withdrawal that has to hold through an outage.
  - **What they don't cover.** The STAC API itself (`STAC_ENABLED`),
    the frames and manifest routes the app already reads, the embed
    and the output page (the Embedding card governs framing), and the
    operator scripts (§9.12), which run elsewhere and reach the node
    only through the routes these switches gate.
  - **Each switch lands with its channel's first phase**: `files` in
    D2a, `tiles` in D3a, `rasters` in D5a. That is while the rollout
    flag still keeps the channel dark, so the switch is in the Features
    card before any release serves the channel, and an operator who
    does not want it can turn it off ahead of time.
- **Vendor-neutral by construction.** Every node-side channel is an
  open standard or a plain file, which keeps
  `architecture/federation-scoping.md` Goal 2 ("no required vendors")
  true. The ArcGIS Image adapter and the Hub registration script are
  operator tools, run with the operator's credentials and credits,
  outside the node's contract and out of its dependencies.
- **Same eligibility as STAC.** Public, published, not retracted, with
  a curated licence (`functions/api/v1/_lib/metadata-readiness.ts`);
  every file names its credit and licence.
- **Only datasets this node publishes.** Rows mirrored from a peer
  (`federated_datasets`) are never cut into tiles, rasters or files. The
  node holds no licence to redistribute them, and the federation
  protocol has no relays (`docs/protocol/README.md`). So a peer's own
  terms, whatever they are, never reach these channels.
- **Reviewers, when it is built**, routed as `CLAUDE.md` §Review agents
  directs: the TerraViz Federation Reviewer and the API Platform
  Engineer for the routes, `.well-known` and `docs/protocol/`; the
  Video Streaming Engineer for the runner's encoding; the Scientific
  Visualization Reviewer for palette application, colour maps and the
  decimation methods (with the `terraviz-data-video` skill and
  `npm run check:luma-range` for data-encoded output); the Application
  Security Engineer for CORS and header changes; the Code Reviewer for
  the rest. This document, being a plan, needs none of them.

---

## 9. Phased implementation

The phases below take the plan from desk research to something each
group in §4 can use. They follow five rules, each borrowed from work
this repository has already done.

- **Every phase merges dark, and every channel ends behind a switch in
  the portal.** Two layers, with different owners:
  - **A rollout flag**, an environment variable, for the maintainer
    while a channel is being built: `FILES_ENABLED`, `TILES_ENABLED`
    and `WMS_ENABLED`. Unset, the channel's routes answer 404 and
    nothing is built, the way `STAC_ENABLED` does
    (`functions/api/v1/_lib/stac-http.ts:45`), so merging a phase
    changes nothing on any node. It is set on preview deploys to reach
    a phase's gate, and removed from the code in the release that
    ships the channel, once its last phase has passed its gate.
  - **A switch in the node's Features card**, for the operator, from
    then on: `files`, `tiles` and `rasters`, on by default, and `wms`,
    off by default (§8, decided 2026-11-07, q26). Turning one off withdraws the channel within
    minutes, with no deploy.
- **Rules with wrong answers land first, as pure modules with tests.**
  Grid arithmetic, URL parsing, time snapping and the reduction
  methods are each a pure function before any route or runner step
  calls them — the split `equirectRtt` and `projectorWarp` use, where
  the arithmetic is tested with no GL and no network.
- **A phase ends at a gate, not a date.** Each gate is a thing that
  must be true, checked by a named person or test, before the next
  phase that depends on it starts.
- **Each phase leaves a record.** What it measured and decided goes in
  an implementation note under `docs/delivery/`, the way the metadata
  work keeps `docs/metadata/PHASE0_IMPLEMENTATION.md` onwards, and
  this plan's `Last reviewed:` line moves with it.
- **Use is measured per platform and per method** (§9.14), on the
  server, with no identifiers. These surfaces are fetched by other
  people's software, whose users never saw TerraViz's privacy notice,
  so the counting keeps nothing but counts.

### 9.1 Overview

| Phase | Delivers | Needs | Flag | Gate to finish | Size |
|---|---|---|---|---|---|
| **D0** Decide | Answers to §11's blocking questions | This review | — | Decisions recorded in this document | — |
| **D1** Prove by hand | Measurements; the "?" cells in §3 answered | D0 | none — no code in the tree | `docs/delivery/D1_PROTOTYPES.md` merged | S |
| **D2a** Video files | The §6.1 variants, manifests, the files route | D1 | `FILES_ENABLED`; switch `files` | A variant plays time-synced in OpenSpace | M |
| **D2b** Bundles | OpenSpace asset, SOS directory, frame zip, KMZ | D2a | `FILES_ENABLED`; switch `files` | Each loads unmodified in its tool | M |
| **D2c** Publisher controls | Portal section for delivery settings and build status | D2a | — | A publisher turns a bundle on and sees it build | S |
| **D3a** Pyramids | Tile cutting in the runner, with the §7 methods | D1 | `TILES_ENABLED`; switch `tiles` | Parity and reduction tests pass on D1's datasets | M |
| **D3b** WMTS | Tile route, capabilities, TileJSON, GDAL XML, colour maps | D3a | `TILES_ENABLED`; switch `tiles` | OGC validator passes; four clients load it | M |
| **D3c** Discovery and contract | STAC links, `.well-known` field, `docs/protocol` entry | D3b | as D3b | Federation review: additive-safe | S |
| **D4** WMS with time | `GetMap` served from the pyramids | D3b, CPU gate | `WMS_ENABLED`; switch `wms` (off by default), and `tiles` | CPU within budget; ArcGIS time slider animates | M |
| **D5a** Analysis rasters | A COG per time step from the Zyra runner, as STAC assets | D1 | as STAC; switch `rasters` | QGIS opens one from STAC; values match the source | M |
| **D5b** Operator scripts | ArcGIS Image adapter; Hub registration | D4, D5a | — (scripts) | A test organisation shows both | S |
| **D6** Legacy video catalog | Frame extraction, licence record, opt-in | D2a, D3a | per dataset | A licence decision recorded for each dataset made public | L |

Sizes are relative — S a few days of work, M a few weeks, L dominated
by review rather than code — and are guesses until D1 has measured
the runner costs.

**What can run in parallel.** After D1, the files track (D2a → D2b,
D2c) and the tiles track (D3a → D3b → D3c → D4) share no code but the
pure modules and can proceed side by side. D5a depends only on D1.
The **critical path to a dome show** is D1 → D2a → D2b. The **critical
path to an ArcGIS time slider** is D1 → D3a → D3b → D4, and D4's CPU
gate is the step most likely to fail.

### 9.2 D0 — Decide

Settle the questions in §11 that change what D1 builds: tile size
(q1), the snap rule (q4), whether video CORS opens (q7), the D2/D3
order (q13), and who owns the operator scripts of D5b (q14). Each
decision is recorded here as a dated amendment naming who made it, the
way `architecture/federation-scoping.md` records its own.

**D0's gate is met:** all five were decided on 2026-11-06, so D1 can
start once its people and places are lined up — a dome session with
the OpenSpace collaborators, an SOS contact, a test ArcGIS organisation
and a Second Life sphere. The maintainer can line up all four.

**Decided so far:**

| Date | Who | Decision | Where |
|---|---|---|---|
| 2026-11-06 | The maintainer | Rasters for analysis carry the producer's own values on its own grid, before any regridding | §9.11 |
| 2026-11-06 | The maintainer | Measure use per platform and per method | §9.14 |
| 2026-11-06 | The maintainer | Don't count individual tiles or WMS maps at first | §9.14, q17 |
| 2026-11-06 | The maintainer | Delivery counts get their own Analytics Engine dataset | §9.14, q18 |
| 2026-11-06 | The maintainer | Keep country, by month, except for virtual-world viewers | §9.14, q19 |
| 2026-11-06 | The maintainer | Record `major.minor` versions of known platforms, on layer loads and downloads only | §9.14, q20 |
| 2026-11-06 | The maintainer | Hash unrecognised names and domains; resolve them against a list of likely names | §9.14, q21 |
| 2026-11-06 | The maintainer | **D0:** 512-pixel tiles for the lat/lon grid, provisionally; D1 loads both sizes and may reverse it | §5.1, q1 |
| 2026-11-06 | The maintainer | **D0:** tiles snap to the period containing the requested time; `/frames?at=` keeps returning the closest frame; the difference is documented on both routes | §5.3, q4 |
| 2026-11-06 | The maintainer | **D0:** open CORS on the new files route only; the existing streaming host is unchanged | §6.5, q7 |
| 2026-11-06 | The maintainer | **D0:** files (D2) before tiles (D3), the order §9 argues for; the two tracks may still run side by side after D1 | §9.1, q13 |
| 2026-11-06 | The maintainer | **D0:** the ArcGIS scripts are maintained in this repository and run by each organisation with its own credentials and credits | §9.12, q14 |
| 2026-11-06 | The maintainer | A zoomed-out pixel is no-data when more than half its area is (`mean`, `mode`); any value shows under `max` | §7.1, q5 |
| 2026-11-06 | The maintainer | The publisher chooses each dataset's reduction method, with a suggested default | §7.1, q6 |
| 2026-11-06 | The maintainer | SOS datasets carry the Creative Commons licence each provider agreed to, varying by dataset; re-shared under that licence once it is curated. *Corrects an earlier entry the same day that called them NOAA public domain.* | §6.5, q8 |
| 2026-11-06 | The maintainer | SOS still needs MPEG-4 Part 2 movies | §6.1, q9 |
| 2026-11-06 | The maintainer | OpenSpace users download TerraViz assets from TerraViz | §6.4, q10 |
| 2026-11-06 | The maintainer | Every tile goes through the Function; none straight from the bucket | §5.6, q12 |
| 2026-11-06 | The maintainer | A WebAssembly image codec may be added for WMS if the CPU test passes | §9.10, q15 |
| 2026-11-06 | The maintainer | Count embedded views, as a separate change to the app's analytics. *Done in #524 as `session_start.window_context`.* | §9.14 |
| 2026-11-06 | The maintainer | `window_context` stays Tier A | §9.14, `PRIVACY_ANALYSIS.md` §9l |
| 2026-11-06 | The maintainer | The privacy policy's "anything about other sites you visit" narrows to their addresses, with what can be inferred about an embedding page disclosed | §9.14, `PRIVACY.md` §2–3 |
| 2026-11-06 | The maintainer | A framed session's length is kept and disclosed, not bucketed or dropped | §9.14, `PRIVACY_ANALYSIS.md` §9l |
| 2026-11-06 | The maintainer | Embed host controls come next, as their own change: a main-app `telemetry=0`, Global Privacy Control where no notice is shown, and a note for embedders | §9.14 |
| 2026-11-06 | The maintainer | SOS datasets with no traceable licence are delivered under the SOS catalog's published terms (non-commercial educational use, attribution, no implied endorsement); a known licence wins; owners can have a dataset withdrawn | §6.5, q22, q24 |
| 2026-11-07 | The maintainer | Each delivery channel sits behind its own switch in the portal's Features card — `files`, `tiles` (WMTS and WMS), `rasters` — on by default and failing open like every other feature; the environment flags only keep a channel dark until it ships | §8, §9 |
| 2026-11-07 | The maintainer | WMS gets its own switch, `wms`, off by default and failing to off, since a `GetMap` cannot fit the free plan's CPU limit and the free plan's daily request budget is account-wide; `SELF_HOSTING.md` says to turn it on only on a plan tier where D4's CPU gate passed; WMTS stays under `tiles`, on by default | §5.8, §8, q26 |
| 2026-11-07 | The maintainer | An unrecognised `Origin` domain is stored as `other-origin` with no hash; new sites are found through partner tags and the curated list | §9.14, q21b |
| 2026-11-07 | The maintainer | A delivery request sending Global Privacy Control is counted with no country, version or domain | §9.14, q25 |
| 2026-11-08 | The maintainer | Licensed or gated access by a node is out of this plan's scope and continues in #528; the delivery channels serve only datasets the node publishes, never rows mirrored from a peer; D3c's discovery field waits on one capabilities and extensions convention (#529) | §8, §9.9, §10 |
| 2026-11-08 | The maintainer | A frame that represents a period (a day, a month) is advertised at that period's start, where the dataset's record says what it represents; otherwise as stamped | §5.3, q27 |
| 2026-11-08 | The maintainer | Time dimensions stay a compact `start/end/period` interval past QGIS's 1,000-step limit; QGIS animates them through the server's snapping | §5.3, q29 |
| 2026-11-08 | The maintainer | D3a takes each Mercator row from the coarsest lat/lon level whose rows are no taller than it, instead of the same-width level, so the poles are not blocky | §7.1 |
| 2026-11-08 | The maintainer | The RRFS smoke rows' codes below `transparentRange` are real zeros, not absence; GSL not yet asked | §7.1, `delivery/D1_PROTOTYPES.md` §1.2 |
| 2026-11-08 | The maintainer | For now, a data layer with no reserved code says in its abstract and colour map that index 0 outside its box is not a measurement | §7.3, q28 |
| 2026-11-08 | The maintainer | `colour-mapped` pictures default to 4:4:4 JPEG at quality 85; PNG where exact colours or transparency are needed | §7.3 |
| 2026-11-08 | The maintainer | A time-locked video shows the earlier frame between frames, as the tiles do: a regular series' bounds are its first frame and one period past its last; a monthly or yearly series goes to OpenSpace as frames or tiles, not as time-locked video | §6.3, q30 |

**Amended by D1's evidence.** Where a D1 measurement contradicted or
sharpened this plan, the section was amended and the change is logged
here, with the evidence in
[`delivery/D1_PROTOTYPES.md`](delivery/D1_PROTOTYPES.md). These are not
the maintainer's decisions. Where the evidence leaves a choice, it is a
new §11 question instead.

| Date | Evidence | Amendment | Where |
|---|---|---|---|
| 2026-11-08 | GDAL and QGIS each take the deepest matrix in a shared tile matrix set as the layer's, whatever its `TileMatrixSetLimits` say, and ask past its last level (D1 §3.1) | Each layer declares a tile matrix set per depth, GIBS's `_LevelN` pattern; CRS84 and the EPSG URN both confirmed, each with the corner in its own axis order | §5.1 |
| 2026-11-08 | QGIS sends ISO 8601's basic form when listed times carry milliseconds, and uses KVP for every tile (D1 §3.1, §3.3) | The time parser also accepts the basic form; KVP is noted as the encoding QGIS depends on | §5.2 |
| 2026-11-08 | Calendar floors measured wrong on 10 of 12 months and 116 of 175 years; QGIS sends its range start; noon-stamped daily frames show the previous day in QGIS and CesiumJS; QGIS expands at most 1,000 instants (D1 §3.2, §3.3) | Measurements added to the calendar, snap, milliseconds and long-list rules; two new questions | §5.3, q27, q29 |
| 2026-11-08 | Pyramids cut for 161 frames of four datasets on four tile sets (D1 §3.15) | The cost table's estimates replaced by measurements; the bytes estimate corrected for sources not 1024 × 2ⁿ wide; upload time still open | §5.8 |
| 2026-11-08 | `-q:v 1` equals `-q:v 2` without `-qmin 1`; the quantiser floor gave 17 Mbit/s on easy content; a 1-second keyframe interval cost 0.05 dB at the cap and 2.5% uncapped, all-intra 3.5% on a weekly series (D1 §3.9, §3.12) | Measurements added to the SOS variant and the keyframe rule | §6.1 |
| 2026-11-08 | `frameTimestamp` stamps a yearly frame in the previous calendar year; half-step video bounds give the nearest frame under OpenSpace's floor; Folder mode hands SPICE `tm_mday + 1` (D1 §3.3, §3.9, §3.10) | Notes on the manifest's dates, the video bounds and Folder mode; a new question on the bounds | §6.3, q30 |
| 2026-11-08 | Mercator taken from the same-width lat/lon level repeats each row up to 11.5 times near the poles; 4:2:0 JPEG lost 36% of a picture's class speckles, 4:4:4 none (D1 §3.15) | A note on the Mercator rule, with an alternative for D3a; the speckle measurement | §7.1 |
| 2026-11-08 | Partial palette alpha survives GDAL's expansion and QGIS exactly; a row with no reserved code has no index for absence (D1 §3.4) | Transparency confirmed; the gap noted, with a new question | §7.3, q28 |
| 2026-11-08 | Five clients read 512; Esri's published GCS v2 tile info; OpenSpace's Folder-mode source (D1 §3.1, §3.6, §3.10) | Status notes on q1, q2, q3, q10 and q11; none closed, since ArcGIS and OpenSpace are in the kits | §11 |
| 2026-11-08 | GDAL makes a Mercator layer bounded at ±90° 12 times too tall; GDAL and QGIS read an antimeridian-crossing box as its complement; Leaflet misplaces 512 tiles without `zoomOffset`; CesiumJS sends a literal `{Time}` outside its intervals; the GDAL XML aborts on 404 without `ZeroBlockHttpCodes` (D1 §3.1, §3.2, §3.4) | Two bounding-box rules for the capabilities; companion and documentation notes; `tileSize` and `ZeroBlockHttpCodes` confirmed | §5.7 |

### 9.3 D1 — Prove it by hand

No code enters the tree. With GDAL and ffmpeg on a laptop, a scratch R2
bucket and a throwaway Worker, take one image-sequence dataset and one
data-encoded dataset through every format this plan proposes, and
measure. Both are chosen from datasets whose terms allow it — the SOS
catalog's published terms or a known licence — since D1 hands its
outputs to other organisations (§6.5).

| Question | How | Decides |
|---|---|---|
| Do the grids load, the right way up, at the right longitude? | Cut both pyramids; load in OpenSpace (an `.asset` with the GDAL XML inline, `MaxConnections` and `<Cache>` varied), QGIS, CesiumJS, MapLibre and Leaflet (Mercator at 512 and 256) and ArcGIS Map Viewer; declare the lat/lon CRS both ways (CRS84, the EPSG URN) and the depth both ways (one set with limits, per-depth ids) | §5.1, §11 q1–q3 |
| Does each client snap time as §5.3 assumes? | Request off-frame times from each client; read the server log | §5.3, §11 q4 |
| Do calendar periods and dates snap right? | A monthly and a yearly dataset requested on the 1st of each month; 12:00Z frames requested by date alone; a capabilities document with milliseconds in its times, to confirm QGIS refuses it | §5.3 |
| Do regional frames land in place? | A regional dataset, and a pan across the antimeridian, in each client; whether a palette PNG's transparency survives GDAL's expansion to four bands | §5.5, §7.3 |
| Does ArcGIS stretch past the deepest level or go blank? | Zoom past level 2 in Map Viewer | §11 q2 |
| Is WMS axis order right? | QGIS `GetMap` in `EPSG:4326` and `CRS:84` over a known asymmetric box | §5.9 |
| What does a `GetMap` cost? | Stitch-and-scale in the Worker, alone and under concurrency, on a free and a paid plan; read Cloudflare's CPU time and memory, not elapsed time | D4's go / no-go, §11 q26 |
| What does a time step cost OpenSpace? | `h264-4096` at keyframe intervals of 1 s and 6 s (today's encode, `cli/lib/ffmpeg-hls.ts:352-357`), time-mapped, on the collaborators' dome | §6.1's keyframe rule |
| Does OpenSpace's Folder mode read the dates right? | Dated frame names across a month boundary | §6.3, §11 q10 |
| Do redirects survive a real session? | Point OpenSpace's `UrlSynchronization`, Second Life's video plugin and a browser globe material at a 302 to a digest path on the same route, and play longer than any cache lifetime, with a loop, a seek, a reconnect and a `HEAD` | §6.5, §8 |
| Does an SOS site accept the directory? | Hand one to an SOS site or the SOS team | §6.4, §11 q9 |
| Does a plain MP4 play on a Second Life sphere? | `h264-1024` through the video plugin, in Firestorm and Linden Lab's viewer | §2.3, §4 |
| What does a pyramid cost? | Bytes, object count, uploads and cut time per frame on a GitHub runner, as loose tiles and as one pack per frame | §5.6, §5.8, D3a sizing |

The output is `docs/delivery/D1_PROTOTYPES.md`: the measurements, the
answers, and an amendment to every section of this plan they
contradict.

**Status, 2026-11-08.** D1 has started, on the datasets and terms its
document records first (§1 there).

- **Run here.** Everything a machine could do: the grids in GDAL,
  QGIS, CesiumJS, MapLibre and Leaflet; what time each client sends;
  calendar periods and dates; regional frames and palette
  transparency; pyramid cost per frame; the video encodes. Their
  amendments are in §9.2.
- **Kits for people.** OpenSpace, ArcGIS (with Hub), an SOS site,
  Second Life and the redirect session are each a kit with a one-page
  checklist, for the maintainer to hand on.
- **Waiting on credentials.** The `GetMap` cost on each plan tier, the
  redirect route and R2 upload time need the scratch Worker and
  bucket.

D1's gate is its document merged, and these rows come back first.

### 9.4 D2a — Video files

**Builds.**

- **A runner step** (`cli/lib/delivery-video.ts`) that encodes the §6.1
  variants. The H.264 variants are constant frame rate with one video
  frame per data frame, a keyframe at least every second (`-g` and
  `-keyint_min` at the frame rate, `-sc_threshold 0`) and
  `+faststart`; `sos-mpeg4` uses FFmpeg's MPEG-4 Part 2 encoder at
  25 Mbit/s or more. Today's encodes are not reused: their keyframes
  sit six seconds apart, one per HLS segment, which costs OpenSpace up
  to six seconds of decoding on every step.
- **Palette-applied video** for data-encoded datasets, coloured from
  the frames through `buildColorScaleLut` (`src/types/color-scale.ts`);
  smaller variants are made from frames reduced in value space (§7.1),
  never by scaling the coloured video. Picture variants are scaled by
  FFmpeg's area filter, which averages encoded values rather than
  linear light; that departure from §7.1 stands unless D1 shows it
  visibly darkens coastlines or city lights.
- **A manifest per build** (§6.3). The runner reads each frame's date
  from the node's own `/frames` route rather than recomputing it, so
  `frameTimestamp` (`functions/api/v1/_lib/frames-manifest.ts:200`)
  stays the one computation.
- **A delivery dispatch.** A new `kind: 'delivery'` beside `video` and
  `frames` in `functions/api/v1/_lib/github-dispatch.ts`, so a build
  can run on a dataset without re-transcoding it — when a publisher
  turns a variant on later, or for a backfill.
- **Content-addressed storage** in R2, keyed by the input's digest and
  the variant's settings, so republishing an unchanged dataset builds
  nothing — the pattern `cli/lib/frame-store.ts` uses for frames.
- **A `dataset_delivery` table**: per dataset, the reduction method,
  which outputs are on, and the last build's digest, status and time.
  A new table rather than columns on `datasets`, so `WireDataset`, the
  native catalog and the federation feed are untouched (§8).
- **The files route**, `functions/api/v1/datasets/[id]/files/[name].ts`:
  a redirect to an immutable digest path on the same route, served
  from the R2 binding with `Range`, `ETag` and `HEAD` (§6.5); 404
  unless `FILES_ENABLED`, and `403 feature_disabled` while the `files`
  switch is off.
- **Frames for datasets that have none.** Data-encoded datasets
  published through `compose-video` or as an uploaded MP4, and the
  legacy SOS videos, have no frame set to colour from, and D6's
  extraction depends on this phase, so the order would be circular.
  D2a decodes the kept upload (`uploads/{id}/{upload}/source.mp4`, whose
  retention D1 confirms) at its own rate, or selects one frame in every
  30/`playbackFps` from the catalog's encode. Exact de-duplication does
  not work: decoded x264 output does not repeat held frames exactly (12
  source frames held to 30 fps came back as 84 to 89 distinct ones).
  Decoding luma video matches the browsers' limited-to-full expansion,
  which is where `check:luma-range` applies.
- **Content-addressed keys** include the palette's digest, the
  normalisation, the background and an encoder-recipe version (the
  `segmentDescriptorHash` `v:` lesson in `DATA_ENCODED_VIDEO_PLAN.md`),
  and a bundle that embeds dates or credits keys on them too. The MP4's
  copyright tag is written by ffmpeg, which drops a `license` tag
  without `+use_metadata_tags`; a credit edit is a remux with `-c copy`,
  not a re-encode.
- **The `files` switch** (§8): its key in `src/types/node-features.ts`,
  its row in the Features card, its check in the files route and in
  the publish dispatch, and its tests, in the same change as the route.
- **Counting** (§9.14): the three-layer platform classifier and the
  Analytics Engine writer as a pure module, the delivery dataset's
  binding in `wrangler.toml`, the files route's counts, the nightly
  rollup into the database, the "unknown clients" report with its list of likely
  names, and the Delivery panel in `/publish/analytics`.

**Tests.** Pure tests for the encoder arguments and the manifest; a
runner smoke test that checks the result with `ffprobe` (constant
rate, keyframe spacing, frame count equal to the dataset's, profile and
level, colour tags); a parity test that decodes the palette-applied
video through ffmpeg and compares each texel, within a stated
tolerance, with the LUT's entry for its luma composited over the
background; date tests across month and year boundaries; route tests
for the redirect, `Range`, `HEAD`, the flag, the switch and an
ineligible dataset.

**Gate.** An `h264-4096` file plays time-synced in OpenSpace on the
collaborators' setup, and the route serves on a preview deploy.

**Reviewers.** The Video Streaming Engineer for the encode and the
workflow change, with the `terraviz-data-video` skill and
`npm run check:luma-range` where luma video is read or written (the
pinned renditions, and decoding a data-encoded upload); palette-applied
RGB and PNG frames need a colour check instead; the Scientific
Visualization Reviewer for palette application and reduction; the
API Platform Engineer for the route's shape; the Application Security
Engineer for headers and CORS; and, because a database migration is one of
`GOVERNANCE.md`'s high-scrutiny areas, the Code Reviewer migration
first, with the PR saying whether a person outside the loop has
reviewed it. The counting adds the `analytics-reviewer`, run before
any other, and the Privacy Engineer (§9.14).

**Rollback.** Turn `files` off in the Features card, or before the
channel ships, unset `FILES_ENABLED`. The table is additive and the R2
objects inert.

### 9.5 D2b — Bundles

**Builds.** Generators in the runner (`cli/lib/delivery-bundles.ts`)
for the four §6.4 bundles: an OpenSpace `.asset` whose
`UrlSynchronization` points at the files route; an SOS directory with
`playlist.sos` and `labels.txt`; a frame zip with its manifest; a KMZ
of time-stamped overlays at most 2048×1024. The asset template is the
one D1 proved, not one written from documentation. Every address a
bundle contains carries its `via` tag (§9.14).

**Tests.** Snapshot tests of each generator against D1's hand-built
originals; the KML against the OGC KML 2.2 schema; `labels.txt` line
count equal to the frame count.

**Gate.** Each bundle loads unmodified in its tool: the OpenSpace
collaborators load an asset, an SOS site or the SOS team loads a
directory, Google Earth Pro animates a KMZ.

**Reviewers.** The Code Reviewer, and the Video Streaming Engineer for
the `sos-mpeg4` packaging.

### 9.6 D2c — Publisher controls

**Builds.** A Delivery section in the dataset form
(`src/ui/publisher/components/dataset-form.ts`): the reduction method,
defaulted by the dataset's kind and explained in one sentence each
from §7.1's table; which outputs to build; the last build's status
with links. A channel the node has switched off (§8) shows its
options disabled, with one line saying so and linking to the Features
card, rather than letting a publisher turn on a build that will not
run. Beside it, for admins, a list of registered partner tags
(§9.14), managed the way the Embedding card manages allowed sites.
Until D2c lands, D2a and D2b are turned on per dataset through the
publish API and the CLI, and partner tags are registered through the
API.

**Tests.** Unit tests for the form section; a scene in
`scripts/screenshots/scenes.ts` and a smoke assertion, as `CLAUDE.md`
asks of a new interactive surface.

**Gate.** A publisher turns a bundle on and sees its build land.

**Reviewers.** The Section 508 Accessibility Specialist; the Science
Communicator for the method descriptions, which tell a publisher what
each choice does to a reader's picture; the Application Security
Engineer and the Code Reviewer for the publish API change, a
high-scrutiny path; the Internationalization Engineer if the strings
need more than the usual `t()` keys.

### 9.7 D3a — Pyramids

**Builds.**

- **A shared pure module**, `src/types/tile-grid.ts`, used by the
  runner and the Functions alike, as `src/types/image-sequence-constants.ts`
  is: the two grids, tile bounds, the native level, the URL grammar,
  lenient time parsing and the §5.3 snap, with calendar arithmetic for
  `P1M` and `P1Y` and the rule for a time given by date alone. Today's
  `functions/api/v1/_lib/iso-duration.ts` counts a month as 30.44 days,
  which is fine for `/frames?at=`'s nearest frame and wrong for a floor:
  from 2020-01-01, a request for 2020-03-01 would land on February.
- **The cutter** (`cli/lib/tile-cutter.ts`): normalise each frame
  (§5.5), place it at the native level, and build each coarser level
  from the source with the dataset's method and a valid-area channel
  (§7.1) — in TypeScript, because GDAL's overview builder averages a
  palette image's colours and picks the nearest entry, never the values
  the codes stand for, and knows nothing of the no-data band — then
  write indexed PNG for data-encoded layers, JPEG for natural pictures
  and PNG for `colour-mapped` ones, under the key §5.6 lists. The
  indexed PNG's palette chunks are written directly: a general encoder
  in palette mode, libvips's included, re-quantises and reorders the
  palette, which would fail the byte-for-byte test below.
- **The Web Mercator set** taken by nearest neighbour from the lat/lon
  level of the same width, two coarser lat/lon levels (512 and 256
  wide) included, so the method is applied once and the warp never
  averages (§7.1). GDAL is installed in the runner from apt, the way
  ffmpeg already is (`.github/workflows/transcode-hls.yml:146`).
- **A per-dataset index** in R2 from frame time to frame digest, which
  the serving route memoises per isolate, or skips for a regular series
  whose index is arithmetic (§5.6).
- **Sharding.** A long series is cut across several jobs by frame
  range, since a GitHub-hosted job stops at six hours.
- **Clean-up.** A sweep that deletes the tiles of a dataset retracted,
  unpublished or re-cut, which §5.6 relies on.
- **The `tiles` switch** (§8): its key, its row in the Features card,
  and its check in the publish dispatch, so it is in place before any
  route serves a tile. D3b and D4 add the check to each route.

**Tests.** The cutter is tested against the probe the hover readout
uses: for random points, a native-level tile pixel equals the source
texel `latLonToTexelUv` names (`src/services/datasetProbe.ts:45`),
after normalisation — a regional bounding box included, since that is
where a US box once landed over the South Pacific, and one crossing the
antimeridian. For every advertised time tᵢ, snap(tᵢ) is frame i and
snap(tᵢ − 1 ms) is frame i − 1, on a monthly and a yearly series as
well as a daily one, and a time given by date alone selects the frame
on that date. At every level,
against source cells: `mean` equals the area-weighted mean
`datasetStats.ts` computes over the same cells, and a pixel is no-data
exactly when less than half its source area is valid; `mode` breaks
ties the same way every run; `max` keeps a single valid pixel through
every level; no block straddles the antimeridian; an indexed PNG's
palette is byte for byte the dataset's LUT, alpha ramp included;
Mercator matches lat/lon under nearest neighbour. A ramp-and-edge frame
(one stripe per code, a data/no-data edge, a diverging red|blue edge)
is loaded in every client at native and zoomed in, and no colour off
the palette appears at an edge.

**Gate.** Those tests pass on D1's two datasets, and the longest series
the catalog holds (3,650 frames, `docs/metadata/PHASE4_IMPLEMENTATION.md`)
builds both grids inside GitHub's six-hour job limit, sharded as built.
A gate measured against D1's own runner time would pass by
definition.

**Reviewers.** The Scientific Visualization Reviewer for the reduction
methods and colouring; the Video Streaming Engineer for the workflow
change; the Code Reviewer.

### 9.8 D3b — WMTS

**Builds.** `functions/api/v1/wmts/[[path]].ts` with helpers in
`functions/api/v1/_lib/`: RESTful and KVP `GetTile` and
`GetCapabilities`; one capabilities document per projection and one per
dataset (§5.2), generated from the catalog database under the STAC
projection's eligibility rules and checked per dataset before any cache
(§5.6); snapping through the shared module, 404 for times outside the
span and OGC exception reports for malformed requests, `default` the
latest frame; edge caching keyed by the resolved digest; CORS on every
response. Beside it, per layer: TileJSON, a GDAL WMS XML, an OpenSpace
asset, and for data-encoded layers a GIBS ColorMap v1.3 file with SVG
and PNG legends generated from the dataset's `color_scale` (§5.7).
Capabilities documents and layer configurations are counted, tiles are
not, and a tag on a capabilities request is carried into the tile
addresses it advertises (§9.14).

**Tests.** The capabilities document against OGC's WMTS 1.0 schemas,
and OGC's own WMTS test suite in a CI job that runs only when asked,
as `.github/workflows/stac-api.yml` runs the STAC validators. Client
tests that run only when their tools are present, on the pattern of
the QGIS check in `functions/api/v1/stac/clients.test.ts:31`: QGIS
animates a layer; `gdallocationinfo` reads the GDAL XML at known
points and matches `latLonToTexelUv` (`gdalinfo` alone fetches no
pixels); CesiumJS in headless Chromium draws a tile at a known time.
CORS headers are checked on a 200, a 404 and a `403 feature_disabled`.

**Gate.** The OGC suite passes for everything the capabilities
advertise; QGIS, CesiumJS, OpenSpace and ArcGIS Map Viewer each load a
layer on a preview deploy (Map Viewer the Mercator layer at its default
time, which is all it reads); CPU per tile request is measured there,
on the plan tier named (q26).

**Reviewers.** The API Platform Engineer and the TerraViz Federation
Reviewer for a new published contract; the Scientific Visualization
Reviewer for colour maps and legends; the Application Security
Engineer for CORS and routing (`public/_routes.json`); the Code
Reviewer.

### 9.9 D3c — Discovery and the contract

**Builds.** STAC items gain web-map-links to their WMTS layers
(`functions/api/v1/_lib/stac-builders.ts`); `/.well-known/terraviz.json`
gains an additive field naming the tile root, present only when
`TILES_ENABLED` is set and the `tiles` switch is on. Its shape waits on
one convention for capabilities and extensions in the discovery
document, decided before D3c starts (#529). Three designs want that slot: this
field, the `capabilities` array `CATALOG_FEDERATION_PROTOCOL.md`
documents but the code does not serve, and the discovery capability
proposed in #528. Beside it, `docs/protocol/` gains the delivery
contract and a changelog entry; `docs/SELF_HOSTING.md` gives each
delivery switch's default (on, except `wms`), what it costs, and how to
change it; `docs/BACKEND_MODULES.md` gains its rows; STAC
reads are counted (§9.14).

**Gate.** The TerraViz Federation Reviewer classes the `.well-known`
and STAC changes as additive-safe, and the existing STAC validators
still pass.

**Reviewers.** The TerraViz Federation Reviewer; the API Platform
Engineer for the STAC shape; the Scientific Data Steward for the STAC
metadata; the Technical Writer for `SELF_HOSTING.md`.

### 9.10 D4 — WMS with time

**Builds.** `functions/api/v1/wms.ts`: capabilities with a `TIME`
dimension per layer, in versions 1.3.0 and 1.1.1 with negotiation, and
`GetMap` in `CRS:84`, `EPSG:4326` and `EPSG:3857` (with its two
aliases), stitched from the pyramids and scaled, at most 2048 a side,
nearest neighbour for data layers, a transparent PNG for a gap (§5.9).
Capabilities are counted; maps are not (§9.14). The `wms` switch: its
key, off by default and failing to off, which `src/types/node-features.ts`
does not yet support per key, its row in the Features card saying what
it costs on a free plan, and its check in the route beside `tiles`'s
(§8, q26).

**The CPU gate comes first.** Before any route lands, the worst-case
`GetMap` — 2048×2048, in each CRS, a data layer and a picture layer —
is measured on an isolated preview deployment against its CPU limit,
with memory under concurrent requests, since every Pages Function
shares one Worker's isolates, and on both a free and a paid plan,
by the protocol the STAC rollout gate uses
(`docs/metadata/PHASE4_IMPLEMENTATION.md` §Rollout Gate). Decoding and
encoding images inside a Worker means a WebAssembly codec, which is a
new dependency, accepted if the CPU test passes (decided, §11 q15). If
the measurement
fails, D4 stops there: ArcGIS users get one XYZ item per frame, the
time in its path, with time-based visibility (§2.1), which works for
short series and not for long ones, and the plan says so. A WMTS layer
per frame does not work, since ArcGIS shows only a layer's default
time.

**Tests.** OGC's WMS 1.3 test suite in the same opt-in CI job; the
stitching tested against the tiles it came from; and a known asymmetric
box requested in `EPSG:4326` and `CRS:84`, in 1.3.0 and 1.1.1, since
stitching checked only against its own tiles cannot catch a transposed
map.

**Gate.** ArcGIS Map Viewer's time slider animates a layer from a
preview deploy, and QGIS's Temporal Controller does the same. The gate
names the plan tier it was measured on (q26).

**Reviewers.** As D3b.

### 9.11 D5a — Analysis rasters

**Builds.** A Cloud-Optimised GeoTIFF per time step, made by the Zyra
runner from the field before it is rendered, floating point, stored in
R2 by digest and listed as a STAC asset with the projection and raster
extension fields. It is served through a Function, as the files are
(§8), and the `rasters` switch lands with it: its key, its row in the
Features card, and its check in that route, the STAC builder and the
runner's COG step.

**What is already on the runner's disk** (checked against
`.github/workflows/zyra-run.yml` and Zyra v0.1.52, the release its
pinned image carries):

- **The files exist when the publish step runs.** The container's
  `/work` is the runner's `_work/` (`docker run -v "$PWD/_work:/work"`),
  the pipeline and the publish step run in one job, and nothing deletes
  `_work/` in between. Both shipped templates write the reprojected
  field to `/work/wrapped/` (`src/ui/publisher/workflow-templates.ts`,
  `.claude/skills/terraviz-data-video/assets/`), one GeoTIFF per time
  step, and Zyra's `reproject` keeps each input's filename, which
  `convert-format` set to the valid time. So the date is in the name.
- **But the location is a convention, not a rule.** The validator
  checks only that a pipeline writes the final MP4 or frames directory
  (`functions/api/v1/_lib/workflow-validators.ts:172`); a reproject
  stage may write anywhere, and image-only workflows have no field at
  all. The COG step reads `_work/pipeline.json`, finds the reproject
  stage's `output_dir`, and treats its absence as "no rasters for this
  dataset", never as an error.
- **They are plain GeoTIFFs, not COGs**: EPSG:4326 with a geotransform,
  but no tiling, compression or overviews (`raster_reproject.py`'s
  write profile). A `gdal_translate -of COG` pass is needed.
- **No no-data value is tagged.** Neither `convert-format`'s GeoTIFF
  writer nor `reproject` sets one when the source has none, so missing
  values travel as NaN in a floating-point raster. The COG step tags
  no-data explicitly.
- **Units are not in the file.** They are in the heatmap stage's
  arguments and the `color-scale.json` sidecar it writes; the COG step
  takes them from there.
- **They last one job.** Only the current run's steps are on disk;
  history accumulates in R2 only if each run uploads its own.

**Decided: the producer's grid** (the maintainer, 2026-11-06). In the
canonical template, `reproject` upsamples the 0.25° source to
4096×2048 *bilinearly*, making new values between the producer's grid
points. Those are right for the picture and are not what the producer
published, and publishing them as the data is the case `CLAUDE.md`
sends to a person: the node deriving a value its producer never
published. The decision, on the proposal as written here: the COGs
come from the pre-regrid files in `/work/tif/`, the producer's own
values on its own grid. What that means for the step:

- **The longitudes are rotated, not resampled.** Those files are on
  the 0–360° layout `reproject` exists to unwrap. Where 180° is a whole
  number of columns, as it is at 0.25°, the COG is the same columns
  rotated to ±180°, every cell keeping its value and its own position.
  Where it is not, the COG keeps the producer's 0–360° layout, which
  GDAL-based tools read, rather than shift a cell to make it fit.
- **The data grid and the picture grid differ, on purpose.** For the
  GEFS-Aerosols template the COG is 1440 columns wide where the frames
  are 4096; the tiles and videos are
  pictures (§4.1, §6) and keep the regridded field.
- **A workflow that already reprojects at native resolution**, with no
  `width` and `height` on its reproject stage, has no new values in
  `/work/wrapped/` and may publish from there.
- **Every COG says where its values came from**: the source file, the
  grid, and that no resampling was applied, in its STAC item.

**Tests.** Values at sample points equal the source field's within the
compression's stated error; the STAC validators pass with the new
assets.

**Gate.** QGIS opens a COG found through STAC, and the Scientific Data
Steward signs off the metadata.

**Reviewers.** The Zyra Workflow Author for the pipeline change, then
the Code Reviewer; the Scientific Data Steward; the API Platform
Engineer for the STAC asset shape.

### 9.12 D5b — Operator scripts

**Builds.** Two scripts under `scripts/`, maintained in this
repository and run by each organisation with its own ArcGIS credentials
and credits (decided, §11 q14) — the maintainer's organisation first.
Credentials come from the environment, are never stored by the node,
and the scripts are dry-run by default as `npm run setup` is:

- **The ArcGIS Image adapter** uploads D5a's rasters for a dataset as
  a multidimensional *tiled* imagery layer, the kind that can be public.
  Esri documents this route through ArcGIS Pro and its Python API. If
  a TypeScript script over the REST API cannot do the same, the adapter
  is a Python script run with pinned versions through `uv`, the way
  `functions/api/v1/stac/clients.test.ts` runs PySTAC — still with no
  Esri package in the node's dependencies.
- **The Hub registration script** creates public WMS, WMTS, OGC
  Feature Server and Web Mapping Application items pointing at the
  node, each address tagged `via=arcgis-hub` (§9.14).

**Gate.** Against a test ArcGIS organisation: a public imagery layer
with a working time slider, the registered items in its Hub site, and
an answer to whether Hub's DCAT feed includes them (§11 q11).

**Reviewers.** The Application Security Engineer for credential
handling; the Code Reviewer.

### 9.13 D6 — The legacy video catalog

**Builds.** Frame extraction for video-only datasets, by D2a's rule:
decode the kept upload at its own rate where there is one, otherwise
select one frame in every 30/`playbackFps` from the catalog's encode
(§7.2). Not by dropping duplicates: decoded x264 output does not repeat
held frames exactly, and an SOS animation's held title and end frames
are real repeats. Assign dates, and refuse a dataset whose frames do
not fit its span evenly; a wrong count that happens to divide the span
passes that check, so the count is checked against the source's own
rate as well. Off by default and turned on per dataset.

**The gate is a person, not a test.** Before a dataset's tiles or
files go public, someone with the authority to say so records that it
may be redistributed in these forms, saying who decided, on what, and
when, as `CLAUDE.md` asks wherever a person rather than an agent owns a
decision. For the SOS catalogue that record exists: the maintainer
decided on 2026-11-06 that a dataset with no traceable licence goes out
under the SOS catalog's published terms, a known licence winning where
there is one (§6.5, §11 q22). What remains per dataset is checking its
credits against its catalog page and recording any licence that is
known. Datasets from other sources need their own record.

**Reviewers.** The Video Streaming Engineer; the Scientific Data
Steward for the licence and provenance metadata.

### 9.14 Measuring use, per platform and per method

**Decided** (the maintainer, 2026-11-06: "It would be nice to have per
platform (or method) metrics"). This replaces the earlier rule that no
phase adds telemetry. What follows is the proposed design; its details
go through the `analytics-reviewer` and the Privacy Engineer when the
first phase builds it.

**What is counted.** Requests to the delivery surfaces, counted on the
server by the Functions that answer them: the files route, the tile
and WMS services' capabilities documents, TileJSON and GDAL XML, and
STAC — but not each tile or map (decided, q17), and not a `HEAD`
request. Not the TerraViz app, which already has its own consent-gated
telemetry, and not the output page, whose reporting is opt-in per
globe by design (`src/output/webTelemetry.ts`) and must not gain a
second, ungated path. The counter runs on the server and cannot see a
visitor's tier, Global Privacy Control or `telemetry=0`, so that
exclusion has to be a mechanism rather than an intention:

- A request carrying `Sec-Fetch-Site: same-origin` is not counted. A
  page cannot forge that header, and a non-browser that sends it only
  removes itself from the counts. It covers the app, its embeds and
  the output page, which are all served from the node's origin.
- The desktop app, whose requests come from Rust with no such header,
  sends a do-not-count header (`TerraViz-No-Count`).
- A test holds that nothing under `src/` builds a counted address.
- If the app ever links to a delivery file ("Download for OpenSpace",
  "Open in QGIS"), that use is measured by the app's own consent-gated
  event, never by the route.

**Each count carries:**

- **The method**, which the route itself knows: a video file, a bundle
  (and which kind — OpenSpace asset, SOS directory, frame zip, KMZ), a
  capabilities document, a layer configuration (TileJSON or GDAL XML),
  a STAC read. Individual tiles and WMS maps are not counted (below).
- **The platform**, worked out in three layers, most reliable first —
  see *How the platform vocabulary grows*, below.
- **The dataset** (its catalog id, as the app's `layer_loaded` already
  reports), the variant or format, and **the country**, from
  Cloudflare's edge as the ingest function stamps it (invariant 1),
  summarised by month in the rollup (decided, q19). That month is a
  fact about storage, not about display: Analytics Engine keeps each
  row, with its arrival time, for about three months, and when a month
  closes its rollup rows are recomputed from Analytics Engine, which
  still holds the whole month. No daily row carrying a country is kept
  in the database.
- **The platform's version, as `major.minor`**, for platforms on the
  curated list only, and only on a layer load or a download — never on
  anything finer. It answers support questions such as whether to rely
  on WMTS time (QGIS 3.28 and later) or video layers (OpenSpace 0.19
  and later). It sits in its own field, so it can be dropped without
  disturbing the rest (decided, q20). Browsers and browser engines,
  the Chromium engine inside a virtual-world viewer included, are kept
  off the versioned list, so `PRIVACY.md`'s promise never to collect a
  browser version stays true.

**How the platform vocabulary grows.** A fixed list undercounts
exactly the platforms nobody predicted. An open one lets any client
write any string into the node's analytics: a way to spam the counts,
and a way for personal data to land in a field that privacy invariant 3
says must never hold raw free text. So the vocabulary has three layers,
each open in a different way.

1. **Artifact tags: closed, but they grow with the code.** One value per
   kind of thing TerraViz generates — the OpenSpace asset, the GDAL XML,
   the KMZ, the SOS directory, the frame zip, the Hub item, the
   TileJSON. Each generator declares its own tag in a
   `satisfies Record<…>` table beside it, the pattern `outputUI` uses
   for its health badges, so a new generator cannot compile without one
   and the list never needs updating separately. These tags name
   TerraViz's outputs, not the world's platforms, which is why a closed
   list is right for them.
2. **Partner tags: open, but registered.** A node admin registers a tag
   in the portal — a lowercase slug and a sentence on who it is for —
   the way the Embedding card manages allowed sites. A partner who
   builds TerraViz links into their own product (a museum's kiosk
   software, the WordPress plugin, a planetarium vendor's catalog) asks
   for a tag and uses it. Registering one is a row, not a release. A
   `via` value nobody registered is counted as `unregistered`, so no
   one can mint a category by sending it, and a retired tag is never
   reused, so old counts keep their meaning. The form says what a tag
   is for: a product or integration used at many sites, not one site,
   classroom or person, with no personal name or contact detail in its
   sentence, and its counts held to the rollup's small-count rule
   (below).
3. **Discovery: for the platforms nobody told us about.** A request
   with no recognised tag is classified from what every client already
   sends.
   - **The User-Agent.** Known product tokens (`QGIS`, `GDAL`, `VLC`,
     `curl`, RFC 9110's `name/version` form, version dropped) are
     matched anywhere in the string, not only first, since every
     browser's User-Agent starts `Mozilla/5.0` and QGIS's own token
     comes later: QGIS sends `Mozilla/5.0 QGIS/34000/<OS>`
     (`src/core/network/qgsnetworkaccessmanager.cpp`), whose version
     is an integer to decode (34000 is 3.40) for the versions table.
     Only the curated name is stored. An unknown first
     token is accepted only if it is an RFC 9110 `token` with no `@`,
     at most 32 characters, and no run of six or more digits or eight
     or more hex characters (the `sanitizeMessage` rule); anything else
     is `other` with no hash, since a script told to put a contact
     address in its User-Agent, as the NWS API asks callers to, would
     otherwise have it hashed.
   - **The `Origin`, for a browser request.** Fixed buckets, never
     hashed, for what is not a site:
     - `ip`, for an address literal, whose hash would be reversed in
       seconds;
     - `local`, for a single-label host or one under `.local`, `.lan`,
       `.home.arpa` or `.internal`, by the rule
       `src/types/node-embedding.ts` already applies;
     - `extension`, for a browser extension's per-install origin, whose
       hash would be a stable per-browser id;
     - `null-origin`, `app-scheme:<scheme>`, and `browser-no-origin`
       for a browser that sends none.

     A site's registrable domain is cut at the shared hosts in
     `SHARED_HOST_SUFFIXES` (`src/types/node-embedding.ts`) before the
     Public Suffix List, so `alice.github.io` counts as `github.io`,
     not as a username, and `<org>.maps.arcgis.com` as ArcGIS. Only the
     domain is read, never the page.
   - **Names on a curated list are stored as themselves.** An unknown
     User-Agent token is stored as `other` plus a 12-hex hash of the
     normalised token, invariant 3's treatment of free text, kept only
     in Analytics Engine's window and never rolled up, using the app's
     own helper (`src/analytics/hash.ts`; decided, q21). An "unknown
     clients" report ranks those hashes and matches them against a list
     of likely names — HTTP clients, GIS and visualisation tools — so
     anything on that list shows by name and only the truly unknown
     stay hashes. An unknown `Origin` domain is stored as
     `other-origin`, with no hash (decided, q21b): the privacy review
     found that hashing one protects nothing, since registered domains
     are a public, listable space and every hash is one lookup from its
     name for anyone holding the rows. New sites are found through
     partner tags and the curated list instead.

   Once identified, a platform is promoted: onto the curated list (a
   code change, and append-only under invariant 8) or as a partner tag
   (a row).

**Carriers: a query parameter first, a header where a client can send
one.** The `via` parameter is the universal carrier because it survives
inside the configuration files and capabilities documents other tools
read. A header cannot be the main carrier. ArcGIS, QGIS, Second Life
and OpenSpace send their own headers with no way to add ours, and in a
browser a custom header turns every tile request into two, because it
forces a CORS preflight. So the node also accepts a registered tag in a
`TerraViz-Via` request header, for clients that can set one and are not
browsers — TerraViz's own CLI, a partner's server-side integration. And
the GDAL XML it generates sets GDAL's `<UserAgent>` element to a
product token naming the asset
([GDAL WMS](https://gdal.org/en/stable/drivers/raster/wms.html)), a
second signal that survives if a tool rewrites the address.

**What is never recorded:** an IP address, a raw User-Agent, the
`Referer` header, the page an `Origin` belongs to, or any identifier —
no session id at all. That is deliberate: the people using these tools
never saw TerraViz's disclosure banner, so nothing about them is kept
beyond a count. It does not make the rows unlinkable. On a quiet node,
the arrival time, dataset, variant, platform, version and country of
two rows can say they came from one tool, the qualification
`PRIVACY_ANALYSIS.md` §9e makes of the app's own sessions. Generated
bundles never report anything themselves; only the requests they make
are counted, and their generators are tested for it: a KMZ carries no
`NetworkLink`, no `viewRefreshMode` but `never`, and no `viewFormat`
or `httpQuery`, since Google Earth would otherwise append the viewer's
view to every request; the OpenSpace asset follows the same rule; and
the counter reads only `via`, never storing the address or its query.

**Two exceptions, and a third still open.**

- **Virtual-world viewers are counted without a country or a
  version.** The output page's reporting was designed around a venue
  that logs avatar arrivals learning a visitor's real-world
  attributes, and accepts a country only inside its first minute
  (`PRIVACY_ANALYSIS.md` §9k). A plain MP4 on a Second Life sphere would
  otherwise hand that venue a country and a time for every arrival, and
  in VRChat pressing play makes every player in the instance fetch the
  file at once. So:
  - The classification happens when the row is written, and the
    Analytics Engine row itself holds no country, not only the rollup.
  - Viewers are recognised by their tokens anywhere in the User-Agent
    (Second Life and Firestorm, OpenSimulator viewers, VRChat's video
    players), since their Chromium page plugin starts `Mozilla/5.0`
    like any browser.
  - It fails toward no country: any VLC- or LibVLC-class request, which
    a viewer's video plugin may send indistinguishably from desktop
    VLC, and any request for a variant made for virtual-world faces
    (`h264-1024`) also keeps none.
  - D1 records the real User-Agent of each path, the Chromium page, the
    LibVLC MP4 and VRChat, beside its redirect check.

  Once this writer exists, §9k's reason for keeping the output page's
  country, that removing it would change the ingest path, is weaker,
  and that residual can be revisited.
- **The telemetry kill switch stops these writes too**: the
  `TELEMETRY_KILL_SWITCH` namespace's `telemetry_enabled` key
  (`functions/api/ingest.ts`), not the `KILL_TELEMETRY` variable some
  docs name, which nothing reads. It skips the write and leaves the
  data response unchanged. Unlike the ingest function, which fails open
  when the switch cannot be read, a failed read here skips the write,
  since these people never agreed to anything.
- **Global Privacy Control** (decided, q25): a request sending
  `Sec-GPC: 1` is counted with no country, version or domain, a tally
  of a request the node serves anyway. Under GPC the app sends no
  telemetry on any page (#526); a delivery count is a different
  thing, since it records no visit and nothing about the person, and
  dropping it would leave every total a floor whose distance from the
  truth depends on GPC uptake.

**Counting uses, not bytes.** A file counts once per download: a
request with no `Range` header, or one starting at byte 0, not the
dozens of range requests a player makes after it. That rule has a
gap D1 has to measure: a player that loops by reopening the stream,
LibVLC with looping on or a `<video loop>` whose cache was evicted,
requests from byte 0 on every pass, and the series of rows would bound
how long one player had the file open, the signal §9k removed from the
output page. D1 records what VLC, the Second Life plugin and Chrome
send on loop and on seek, and the counter is designed from that. A capabilities
document, layer configuration or asset counts once per fetch, which is
the nearest thing to "someone added this layer". **Individual tiles and
WMS maps are not counted at first** (decided, q17). One person panning a
map fetches hundreds of tiles, so a tile count would be the largest
write volume the node has, and it answers "how much" rather than the
question asked, "who uses it", which the per-layer counts already
answer. Raw request volume per address is in Cloudflare's own
dashboard. A sampled tile count — one request in N, written with
weight N — is added later only if a question needs it, such as
planning costs.

**Where the numbers go.** Into a Workers Analytics Engine dataset of
their own, not the app's `terraviz_events` (decided, q18): that
dataset's positional layout is read by the dashboards and the nightly
rollup, and these counts have no session id to sample on. They are
indexed by dataset id, never by anything per client, and stamped
`internal` the way ingest stamps it (`functions/api/ingest.ts`), so
D1's own hand tests stay out of the numbers. The cost is one more
binding in `wrangler.toml` and one more step for an operator setting
up a node. Analytics Engine holds a row per counted request, with its
arrival time, for about three months; on a stock node, which
configures no Workers Logs, that is the most detailed per-request
record the operator has, so who holds the Analytics Engine SQL token
matters and `SELF_HOSTING.md` says so.

From there a monthly rollup writes to the catalog database, which the publisher portal's
analytics tab already reads (`docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md`
Phase A), as **separate tables, never one cross-table**, since a
single cell like (one dataset, frame zip, QGIS 3.34, one small country,
one month) = 1 singles out a person:

| Table | Grain |
|---|---|
| Uses by dataset | month, dataset, method, variant |
| Uses by platform | month, platform, method |
| Versions | month, platform, version — no country, no dataset |
| Countries | month, country, method — no dataset |

Any cell carrying a country, a version, a domain or a partner tag
below a minimum count *k*, set in D2a's privacy review, is merged into
`other` within the same table, so a total cannot reveal a hidden cell
by subtraction. No table crosses a dataset with a domain or a partner
tag below *k*, and no domain cell carries a country: a small site
crossed with a dataset is that page's audience, the reason
`window_context` stays out of per-dataset counts (below).

**Retention.** No raw delivery row is archived to R2, unlike the app's
own export (`ANALYTICS_STORAGE_AND_ADMIN_PLAN.md`), so anything kept
beyond Analytics Engine's window is one of the tables above. Each table
gets a stated retention in D2a; the versions table, for one, answers
questions about current releases and can go after two years. The
partner-tag registry keeps the tag, its sentence and when it was
registered and retired, nothing else. These counts never enter the
federation feed.

A Delivery panel in `/publish/analytics` shows the tables. That tab is
open to every active publisher (`functions/api/v1/publish/analytics.ts`),
so the "unknown clients" report and any split by country, version or
partner tag are admin-only.

**The embed is the one method this does not reach**, because an
embedded TerraViz is the app itself, counted by its own telemetry
where the visitor allows it. **Done:** `session_start` now carries
`window_context` (#524, merged 2026-11-07), one of `top`, `top-embed`,
`framed` or `framed-embed`: whether the app had its own window or sat
in another page's frame, and whether the address carried `?embed=1`.
It never reads the framing page's address. The nightly rollup writes
it as a dimension mix, and a Product Health panel shows it.

Its privacy review found more than the field itself, and
`PRIVACY_ANALYSIS.md` §9l records it:

- **No notice or switch in an embed.** An embedded view shows no
  first-run notice and no Tools menu. A mode chosen on the node's own
  site doesn't reach a frame on another site, because browsers
  partition its storage.
- **The page can often be inferred.** An embed usually pins a dataset,
  and the session's `layer_loaded` names it; a one-site embedding
  policy names the site outright.
- **A framed session's timing describes the host page.** Its
  `session_end` times say how long the host's page was open.

The maintainer decided four things on 2026-11-06 (§9.2):

- the field stays Tier A;
- the privacy policy's promise narrows from "anything about other
  sites" to their addresses, with the inference routes disclosed;
- framed-session timing is kept and disclosed;
- the host controls come next, as their own change:
  - a main-app `telemetry=0` an embed code can carry;
  - Global Privacy Control honoured where no notice is shown, widened
    on 2026-11-07 to every page and built in #526;
  - a note for embedders in `EMBED_URL_GRAMMAR.md`.

**One constraint binds this plan's own work.** The Delivery panel
must keep `window_context` out of per-dataset counts
(`analytics_dataset_daily`), since per-dataset counts of embedded
loads would be counts of one page's audience.

**Before D2a: a join analysis.** `PRIVACY_ANALYSIS.md` gains a §9m for
these counts, as §9k and §9l did for the globe page and embedded views,
because the common self-hosted case is one owner running the node, the
site and the venue. It covers what an operator learns by joining them
with:
- the node's own app telemetry, where arrival time, country and
  dataset can tie an app session to a delivery request seconds later
  (the mechanism above removes the direct path; the indirect one, a
  visitor opening the same dataset in QGIS, is disclosed);
- a venue's arrival log, which is why the virtual-world exception
  exists;
- a site's own access logs, which already hold addresses;
- a partner's logs, if per-tag counts are shared, which they are only
  as the tables above.

**What `docs/PRIVACY.md` gains**, in a section of its own, since these
people never see the app:
- whom it reaches: people using QGIS, ArcGIS, OpenSpace, Google Earth,
  VLC or a virtual-world viewer, or visiting a site that shows
  TerraViz layers;
- what is recorded: the route, dataset and variant, a platform from a
  closed list or a partner tag, a software version for curated
  platforms, a country (by month in long-term storage) and an arrival
  time in the three-month store, and for a browser request the
  requesting site's domain if it is on the curated list, and otherwise
  only that it came from another site, never the page;
- what is never recorded: an IP address, a raw User-Agent, `Referer`,
  or any identifier;
- that the person cannot switch it off, and that a request sending
  Global Privacy Control is counted with no country, version or domain
  (q25);
- the same-owner paragraph the globe and embed sections carry, since
  whoever runs both the site and the node can match records by time
  and country;
- section 6's additions: the Analytics Engine dataset, its retention,
  the database tables, and that nothing goes to R2;
- Vimeo, whose CDN sees the requester's address when the files route
  redirects a legacy video there, and which the policy does not
  mention today for the app either.

Three of its existing promises are reconciled in the same change: no
browser version or user-agent string (kept true by keeping browsers off
the versioned list), nothing about the addresses of other sites (the
counter reads a domain, not a page, and says so), and "anonymous and
carries no identifier" (a domain can name a person, so such rows are
pseudonymous, by `PRIVACY_ANALYSIS.md` §10c's own reasoning).

**Notice where these users look.** Beside the node's contact in every
manifest and capabilities document (§6.5), a link to the privacy
policy, in the WMTS and WMS `AccessConstraints` field and as a
manifest field: the only place a GIS analyst or a dome producer will
see anything.

**Which phase adds what.** D2a builds the classifier and the writer as
a pure module, counts the files route, and adds the rollup and the
Delivery panel; D2b writes the tag into every bundle; D3b counts
capabilities documents and layer configurations and carries the tag
into advertised tile addresses; D3c counts STAC reads; D4 counts WMS
capabilities; D5b's registration script tags the items it creates.
Every one of them runs the `analytics-reviewer` first and the Privacy
Engineer, updates `docs/ANALYTICS.md`, `docs/ANALYTICS_QUERIES.md`, a
Grafana panel and `docs/PRIVACY.md` (rebuilding `public/privacy.html`),
and — the analytics ingest path being one of `GOVERNANCE.md`'s
high-scrutiny areas — the Code Reviewer as well, with the PR saying
whether a person outside the loop has reviewed it. A new server-side
writer and a new use of the kill switch are both things
`docs/ANALYTICS_CONTRIBUTING.md` sends to the project lead before a PR;
§9.2's q17–q21 decisions are the start of that sign-off, and D2a's PR
records it.

### 9.15 When the plan is done

Each group in §4 has its primary format live on at least one node, and
someone from that group — not the people who built it — has used it:
a dome show from an OpenSpace asset, an SOS site playing a directory,
an ArcGIS map animating with the time slider, a QGIS user opening a
COG, a sphere in Second Life playing a file. Until then this document
stays a draft for review.

---

## 10. Non-goals

- **Pushing data into another organisation's system.** Everything is
  served for others to pull; the ArcGIS adapter is the operator's own
  tool, run in their own organisation.
- **GIBS's padded grids, polar projections, any CRS beyond lat/lon and
  Web Mercator.**
- **Raw luma tiles, 16-bit or floating-point tiles.** Values travel as
  rasters (§4.2) or lossless frames (§6.2).
- **OGC API Tiles, OGC API Maps, PMTiles, GeoZarr in v1.** §2.5 found
  too few of these tools reading them in 2026; each is a later addition
  to the same pyramids if that changes.
- **Tiling datasets with no real time axis.** Looping diagrams and
  climatologies go out as video and frames.
- **Restricted datasets.** Public datasets only, as STAC.
- **Knowing who uses a channel.** Counts by platform, method, dataset
  and country, never an IP, a raw User-Agent or anything that links
  one request to another (§9.14).
- **Changing `WireDataset`, the native catalog or the federation feed.**
- **Licensed or gated access.** Every channel openly serves what may be
  redistributed, under the dataset's own licence and credit (§6.5). A
  node that charges for, or gates, delivery of the bytes is a federation
  question, under discussion in #528 (the `ayni-access/1` proposal), and
  not part of this plan.
- **Editing `SECOND_LIFE_COMPAT.md` here.** The corrections in §2.3
  were made in their own change (#522).

---

## 11. Open questions

1. *Decided provisionally 2026-11-06 by the maintainer:* 512 pixels for
   the lat/lon grid; D1 loads both 512 and 256 in every client and may
   reverse it (§5.1). *D1, 2026-11-08:* nothing to reverse it in GDAL,
   QGIS, CesiumJS, MapLibre or Leaflet, each of which read 512
   correctly when told the size; ArcGIS and OpenSpace are in D1's kits
   (`delivery/D1_PROTOTYPES.md` §3.1).
2. **Does ArcGIS stretch WMTS tiles past the deepest level, or go
   blank?** If blank, cut one or two upsampled levels in the Web
   Mercator set only. *D1:* handed to the ArcGIS kit (D1 §3.5).
3. **Is Esri's "WGS 1984 Version 2" scheme the same as the lat/lon
   layout?** It decides whether ArcGIS Scene Viewer can use the lat/lon
   pyramid. From memory it is two tiles of 0.703125° pixels from −180,
   90, which is WorldCRS84Quad; Esri states scales at 96 DPI, so D1
   compares resolutions rather than scale denominators. *D1, 2026-11-08,
   in part:* not quite from memory. Esri's published tile info for its
   own basemap in that scheme has 512-pixel tiles from (−180, 90) at
   0.703125° a pixel at level 0. So Esri's level *n* + 1 is our level
   *n*, tile for tile, plus a 360°×360° level 0 we lack. Whether Scene
   Viewer accepts the layer is in the ArcGIS kit (D1 §3.6).
4. *Decided 2026-11-06 by the maintainer:* tiles snap to the containing
   period as GIBS does, `/frames?at=` keeps the closest frame, and the
   difference is documented on both routes (§5.3).
5. *Decided 2026-11-06 by the maintainer:* under `mean` and `mode`, a
   zoomed-out pixel is no-data when more than half its area is; under
   `max`, any single value shows (§7.1).
6. *Decided 2026-11-06 by the maintainer:* the publisher chooses the
   reduction method in the portal, with a default suggested from the
   dataset's kind (§7.1, §9.6).
7. *Decided 2026-11-06 by the maintainer:* open CORS on the new files
   route only; the existing streaming host is unchanged (§6.5).
8. *Corrected 2026-11-06 by the maintainer:* the SOS datasets are not
   necessarily public domain; to be listed in the SOS catalog, a
   provider agrees to a Creative Commons licence, which varies by
   dataset. That replaces the "NOAA public domain" answer recorded
   earlier the same day. Re-sharing is allowed under each dataset's
   own licence, once that licence is curated (§6.5, §9.13, q22).
9. *Decided 2026-11-06 by the maintainer:* SOS's MPEG-4 Part 2 guidance is
   still current; the `sos-mpeg4` movie stays (§6.1).
10. *Decided 2026-11-06 by the maintainer:* OpenSpace users download
    TerraViz assets from TerraViz rather than from OpenSpace's own
    library. Still open, and tested in D1: whether Folder mode's date
    parsing is off by one day. *D1, 2026-11-08:* the source hands SPICE
    `tm_mday + 1`, so the 31st becomes day 32; the dome test is in the
    OpenSpace kit (D1 §3.10).
11. **Does Hub's DCAT feed include WMS and WMTS items?** Tested in D1,
    in the maintainer's ArcGIS organisation, before promising data.gov
    reach. *D1:* handed to the ArcGIS kit (D1 §3.14).
12. *Decided 2026-11-06 by the maintainer:* no. Every tile goes through
    the Function, so every tile passes the same checks (§5.6).
13. *Decided 2026-11-06 by the maintainer:* files (D2) before tiles
    (D3), as §9 argues; the tracks may run side by side after D1.
14. *Decided 2026-11-06 by the maintainer:* the scripts are maintained
    in this repository and run by each organisation with its own
    credentials and credits (§9.12).
15. *Decided 2026-11-06 by the maintainer:* a WebAssembly image codec
    may be added for D4 if the CPU test passes (§9.10).
16. *Decided 2026-11-06 by the maintainer:* D5a's COGs carry the
    producer's own values on its own grid, taken before any regridding
    (§9.11). Kept here so the numbering of the others holds.
17. *Decided 2026-11-06 by the maintainer:* tiles and WMS maps are not
    counted at first; per-layer counts and downloads answer who uses
    what, and Cloudflare's dashboard has raw volume (§9.14).
18. *Decided 2026-11-06 by the maintainer:* delivery counts get their
    own Analytics Engine dataset, leaving `terraviz_events` untouched
    (§9.14).
19. *Decided 2026-11-06 by the maintainer:* country is kept, summarised
    by month, except for virtual-world viewers (§9.14).
20. *Decided 2026-11-06 by the maintainer:* `major.minor` versions for
    platforms on the curated list, on layer loads and downloads only,
    in their own field (§9.14).
21. *Decided 2026-11-06 by the maintainer:* unrecognised names and
    domains are hashed with `src/analytics/hash.ts`, and the report
    resolves them against a list of likely names (§9.14). The privacy
    review of 2026-11-07 found the premise holds for User-Agent tokens
    but not for domains, and reopened that half as q21b.
21b. *Decided 2026-11-07 by the maintainer:* as `other-origin`, with no
    hash; new sites are found through partner tags and the curated list
    (§9.14). The reasoning, kept as the record: hashing one is a storage
    choice, not privacy: registered domains are a public,
    listable space, a few hundred million names a GPU hashes in under
    a second, so every hash is one lookup from its name for anyone
    holding the rows, which on a self-hosted node is the operator, the
    adversary `PRIVACY_ANALYSIS.md` §9k names. The same document's §4b
    and §9a already say this of search queries. Not chosen: a keyed
    hash (HMAC with a Pages secret rotated monthly and discarded),
    which protects leaked rows and other readers but not the operator
    within the month.
22. **Where do the per-dataset licences come from?** The SOS snapshot
    TerraViz imported carries no licence field at all. What the public
    record says (checked 2026-11-06):
    - **Dataset pages state no licence**, only a bare "© Science On a
      Sphere" footer
      ([example](https://sos.noaa.gov/catalog/datasets/120-years-earthquakes-tsunamis/)).
    - **The SOS copyright page names no Creative Commons licence**
      ([copyright](https://sos.noaa.gov/copyright/)). NOAA-made media
      is "in general … not copyrighted", to be credited to NOAA and
      never used to imply NOAA's endorsement. Media owned by others is
      available "for educational, journalistic, and personal uses",
      with other uses, "such as commercial", possibly restricted. Each
      dataset's catalog page notes non-NOAA ownership in a table.
    - **Some partner datasets do carry Creative Commons licences.** A
      NASA dataset and a WHOI package found in search are both
      CC BY-NC-SA, which fits the maintainer's recollection that
      providers agree to a Creative Commons licence to be listed.

    *Decided 2026-11-06 by the maintainer:* tracing every creator's
    original terms is impossible for much of a catalogue built up over
    years, and in the maintainer's experience every contributor shares
    one aim — to teach people about the Earth without payment. So an
    SOS dataset with no traceable licence is delivered under the SOS
    catalog's published terms (non-commercial educational use, with
    attribution and nothing implying NOAA's endorsement), a known
    licence wins where there is one, and an owner can have a dataset
    withdrawn (§6.5). The evidence above stays as the record of why.
23. **No-Derivatives licences: narrowed by q22.** Under the default
    terms, derived forms — tiles, resized frames, palette-applied video,
    re-encoded movies — are delivered like any other. Still open, for
    the few datasets whose *known* licence is No-Derivatives: whether
    resizing and re-colouring are the technical changes Creative
    Commons 4.0 allows (§2(a)(4)). Until someone who advises on NOAA's
    licensing says so, those go out only in forms that change the
    format and nothing else — their own frames, at their own size and
    colours, and a re-encoded movie.
24. *Decided 2026-11-06 (follows q22):* the default terms are
    themselves non-commercial, so Non-Commercial datasets are delivered
    everywhere with their terms visible; whoever uses one, a planetarium
    charging for a show included, is bound by them.
25. *Decided 2026-11-07 by the maintainer:* counted, with no country,
    version or domain (§9.14). The question, kept as the record: a
    browser with Global Privacy Control on sends `Sec-GPC: 1` with
    every request, a TileJSON or capabilities fetch from someone else's
    page included, and since 2026-11-07 the app honours it on every
    page (#526). A visitor to a StoryMap who sends it will reasonably
    expect it to cover the node counting their browser. Not chosen: not
    counting it, which would make every delivery total a floor.
26. *Decided 2026-11-07 by the maintainer:* WMS has its own switch,
    `wms`, off by default and failing to off; `SELF_HOSTING.md` says to
    turn it on only on a plan tier where D4's CPU gate passed, and
    states the daily request budget WMTS draws on. `tiles` stays on by
    default. The reasons: every Functions request counts against an
    account-wide 100,000 a day on the free plan, one OpenSpace show can
    spend tens of thousands, and a `GetMap` cannot fit the free plan's
    10 ms of CPU (§5.8, §8). Not chosen: `tiles` off on free plans,
    which would need setup to record the plan tier, since a Function
    cannot see it.
27. *Decided 2026-11-08 by the maintainer:* at the start of the
    period it represents, where the dataset's record says what that is;
    otherwise as stamped (§5.3). The SSP producers' answer is still to
    be asked. The question, kept as the record: **How is a frame
    stamped mid-period advertised?** *Raised by D1, 2026-11-08.* SOS 643's daily frames are stamped 12:00Z. QGIS,
    stepping by day from midnight, gets the previous day's frame, and
    so does CesiumJS for any clock before noon, because it asks for
    the exact time it was given (`delivery/D1_PROTOTYPES.md` §3.2). One
    option is to advertise each frame at the start of the period it
    represents (00:00Z for a frame that stands for a day). That needs
    the dataset's represented time, which legacy rows do not record
    (`metadata/PHASE0_IMPLEMENTATION.md` step 2). A related question is
    for the producer: whether the SSP rows' frames, stamped 31
    December, represent that year or the next.
28. *Decided 2026-11-08 by the maintainer, for now:* the layer's
    abstract and colour map say that index 0 outside the box is not a
    measurement (§7.3). The question, kept as the record: **How does an
    indexed data tile say "absent" when every code is a value?**
    *Raised by D1, 2026-11-08.* A data-encoded row with no
    `dataMinLuma` has no index left over, so outside a regional box the
    tile carries index 0, which a GDAL user reads as code 0, a
    measurement of zero (D1 §3.4). The options:
    - reserve a code when the frames are made;
    - tile such rows as grey plus alpha, losing the palette;
    - serve a separate absence mask;
    - or state in the abstract and colour map that index 0 outside the
      box is not a measurement.
29. *Decided 2026-11-08 by the maintainer:* the compact interval,
    whatever the length (§5.3). The question, kept as the record:
    **Interval or list past 1,000 steps?** *Raised by D1, 2026-11-08.*
    QGIS 3.34 expands a `start/end/period` interval into at most 1,000
    instants and shows a longer one as a single range with no frame
    list; a list of values expands whatever its length (D1 §3.3). A
    list grows the capabilities document with the series; GIBS caps
    its lists at 100 and answers `DescribeDomains` for the rest.
30. *Decided 2026-11-08 by the maintainer:* the video follows the
    tiles' rule and shows the earlier frame. A regular series' bounds
    are its first frame and one period past its last; a monthly or
    yearly series goes to OpenSpace as frames or tiles, not as a
    time-locked video (§6.3). The question, kept as the record:
    **Where do an OpenSpace video's bounds go?** *Raised by D1,
    2026-11-08.* §6.3 sets them half a mean step outside the first and
    last dates, so each date lands mid-frame under OpenSpace's floor.
    That makes the video show the **nearest** frame between frames, up
    to half a period ahead, which is the behaviour §5.3 rejects for
    tiles. For a regular period, bounds on the first frame and one
    period past the last make the floor snap down exactly. For a
    calendar period no linear mapping is exact, which argues for frames
    or tiles there rather than video (D1 §3.9).

---

## 12. Sources

Links are inline where each claim is made, and were checked on
2026-11-06. Three desk-research passes produced them: ArcGIS (Esri's
product documentation, developer references and support articles);
OpenSpace and planetarium systems (OpenSpace's documentation and its
source at `master`, NOAA's SOS manuals, vendor product sheets);
and Second Life, Cesium, Google Earth, QGIS and GIBS (viewer and
library source code, product documentation, and live requests against
GIBS). Claims about TerraViz cite files in this repository. Nothing
here was tested hands-on; Phase D1 is where that starts.
