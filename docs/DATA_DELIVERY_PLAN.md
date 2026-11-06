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
consumer; §9's phased implementation and §9.14's usage metrics added
the same day.)

**Decisions recorded:** twenty, all 2026-11-06 by the maintainer,
logged in §9.2: rasters for analysis carry the producer's own values on
the producer's own grid, before any regridding (§9.11); use is measured
per platform and per method (§9.14); five choices about how that
measuring works (§11 q17–q21); the five D0 blockers (§11 q1, q4, q7,
q13, q14); and eight more from an interview the same day (§11 q5, q6,
q8, q9, q10, q12, q15, and counting embedded views). **D0 is
complete**; D1 is next. Open: q2, q3, q10's date parsing and q11, all
tested in D1.

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
in that document, in a follow-up, not here; the maintainer asked for
that follow-up on 2026-11-06.

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

The embed and the output page exist. Two small follow-ups: a StoryMaps
embed under a node's `list` embedding policy needs
`https://storymaps.arcgis.com` in the list, which admits every StoryMap
author, so the portal's help should say so; and the embedding
validator's list of shared hosts (`src/types/node-embedding.ts:123`)
should refuse `*.hub.arcgis.com`, which would admit every Hub site.
The maintainer asked for the second as its own change on 2026-11-06.

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
identifier.

| Level | Tiles across × down | Image width it fills exactly |
|---|---|---|
| 0 | 2 × 1 | 1024 |
| 1 | 4 × 2 | 2048 |
| 2 | 8 × 4 | 4096 |
| 3 | 16 × 8 | 8192 |

A W×W/2 frame fills level *n* exactly when W = 1024 × 2ⁿ, so the
catalog's 4096×2048 frames stop at level 2: **42 tiles per frame**
(2 + 8 + 32), and an 8192×4096 frame 170. Every tile edge falls on a
pixel boundary of the source image at its native level, which is why
cutting needs no resampling at the deepest level and only 2×2
decimation above it. Frames at other widths — a 0.1° science grid is
3600 wide, a 0.25° one 1440 — are handled in §7.1.

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
every client and free to reverse it.

**Secondary: WebMercatorQuad** (`GoogleMapsCompatible`, the standard
256-pixel set), for clients
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
           /api/v1/wmts/1.0.0/WMTSCapabilities.xml
```

- `{datasetId}` is the catalog ULID, which is stable; slugs can change.
- `{style}` is `default` in v1 (§5.4).
- `{ext}` is `png` (alpha) or `jpg` (opaque); WebP is not offered,
  because GDAL builds and GIS clients do not uniformly read it.
- `{time}` accepts any ISO 8601 UTC form a client is likely to build —
  a date (`2026-05-16`), a date and time with or without seconds, with
  or without `Z` — because OpenSpace formats the time from a
  per-layer picture string the producer writes, and a strict parser
  would turn every mismatch into a 404.
- KVP `GetTile` requests are accepted and mapped onto the same handler,
  since some clients only issue KVP. Time must be in the *path* for
  OpenSpace regardless: GDAL's WMTS driver has no time option, so
  OpenSpace reaches time-varying tiles only through a URL template read
  by GDAL's TMS driver (§2.2).

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
  resolved by changing the existing one (decided, §11 q4).
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
  small next to the storage, but it is not zero. Tiles are served only
  this way, never straight from the bucket, so every tile passes the
  same checks (decided, §11 q12).
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
| Tiles per 4096×2048 frame, WorldCRS84Quad layout at 512 px | 42 |
| Tiles per frame, WebMercatorQuad at 256 px to level 4 | 341 |
| Bytes per frame, all levels | ~1.3× the frame itself; a few MB as JPEG, more as PNG |
| Per 1,000 frames, one grid | a few GB to ~15 GB |
| Runner time per frame | seconds; dominated by PNG encoding |

R2 charges for storage and operations but not for egress, so a popular
layer costs requests and Function invocations, not bandwidth. The costs
that grow with the catalog are
runner minutes and object counts on long animations, which is why
§9 tiles datasets that have frames already, and leaves the legacy video
catalog to a later, opt-in phase.

### 5.9 WMS with time

ArcGIS's time slider follows only WMS time (§2.1), QGIS has animated
it longest, WorldWide Telescope's Windows client and OpenSpace's v0.22
server panel read WMS, and GIBS still recommends WMS for time in GIS
clients. So a WMS 1.3.0 endpoint with a `TIME` dimension is in scope,
built after the WMTS because it is served from the WMTS's pyramids.

- **Served from the pyramid, never from source frames.** A `GetMap`
  for a box, a size and a time picks the pyramid level nearest the
  requested resolution in the matching grid — the lat/lon pyramid for
  `CRS:84` and `EPSG:4326`, the Mercator pyramid for `EPSG:3857` —
  stitches the tiles covering the box, and scales the result to the
  requested size. Nothing is reprojected per request, and those three
  are the only CRSs offered.
- **Bounded.** `MaxWidth` and `MaxHeight` are 2048, ArcGIS's own
  default, which bounds the tiles any one request stitches. Whether
  that fits a Pages Function's CPU budget is a measurement, not an
  assumption; Phase D1 makes it.
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
  a tile client shows a gap. This copies that.

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
| `h264-4096` | H.264, 4096×2048, 8-bit 4:2:0, constant frame rate, a keyframe at least every second, `faststart` | OpenSpace, spherical displays, Digistar, web developers' globe materials, Second Life's video-player path |
| `h264-2048` | The same at 2048×1024 | Smaller domes and spheres, Second Life faces at 2048, StoryMaps clips |
| `h264-1024` | The same at 1024×512, about 1.5–2 Mbit/s | Second Life's default face and slow links — the rendition `SECOND_LIFE_COMPAT.md` §7 already plans |
| `sos-mpeg4` | MPEG-4 Part 2, at least 25 Mbit/s, 2048×1024 (4096×2048 on request) | Science On a Sphere, whose guidelines rule out H.264 (§2.4) |

- **One video frame per data frame.** Frame *i* of the file is frame *i*
  of the dataset, so a player that maps a start and end time linearly
  onto the file's duration — OpenSpace does exactly that — lands on the
  right date. A series whose frames are not evenly spaced in time is
  not offered as a time-synced video; it goes out as frames (§6.4),
  which carry their own dates. The frame rate sets only how fast the
  file plays by itself, and defaults to 30 fps, the catalog's encode
  rate and SOS's recommendation.
- **Keyframes at least every second** because OpenSpace's time-synced
  playback seeks on every step, and a seek decodes from the keyframe
  before it.
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
average codes and then colour the averages.

Where values must survive, frames are the format. A data-encoded frame
is a lossless 8-bit PNG whose codes map one to one onto the palette, so
a frame zip plus the palette as a lookup image carries the dataset
exactly. OpenSpace can apply that lookup itself (`Colormap`, with
`Interpolation` on, §2.2), and it blends neighbouring time steps
*before* colouring — a blend of values, which is the right kind,
except across the no-data band, where a blend invents values for the
length of a step. That caveat belongs in the asset's description.

For TerraViz's own output page in Second Life, which can apply the
palette (§2.3), smaller data-encoded renditions — 2048 and 1024 wide —
built from value-space-decimated frames would end the 25 Mbit/s worst
case. They must be **pinned, not adapted**: chosen once for the face
and held, never switched by bandwidth mid-session, which is the form
`DATA_ENCODED_VIDEO_PLAN.md` (§Why the frame is 4096×2048) already
names as workable, because a rung switch changes the value under the
cursor.

### 6.3 Dates travel with the file

Every video and frame set carries a JSON manifest: dataset id, title,
credit and licence, variant, size, frame rate, frame count, the date of
each frame (or start, period and count when regular, computed exactly
as `/frames` computes them: `start_time + period × index`), the loop
period, and links to the palette and legend. Each group's own form is
derived from it:

- **SOS:** `labels.txt`, one line per frame.
- **OpenSpace video:** the start and end times the asset passes to
  `VideoTileProvider`.
- **OpenSpace frames:** dated filenames, `<id>_YYYYmmdd_HHMM.png`, for
  `TemporalTileProvider`'s Folder mode. Its filename date parsing
  looked off by one day in OpenSpace's source, so the exact form is
  settled by a Phase D1 test, not by reading (§11).
- **KML:** a `TimeSpan` per overlay, from its frame's date to the next.

### 6.4 Bundles per group

| Bundle | Contents | For |
|---|---|---|
| OpenSpace asset | A `.asset` file whose `UrlSynchronization` fetches, from R2, either a dated frame zip (Folder mode; greyscale plus palette for data-encoded datasets) or an `h264-4096` MP4 (`VideoTileProvider`, mapped to simulation time), plus the legend as a screen-space image | OpenSpace — on the pattern of the 243 SOS assets it already ships |
| SOS directory | `playlist.sos`, `labels.txt`, 2048×1024 frames (4096 on request), the `sos-mpeg4` movie, the legend | Science On a Sphere sites |
| Frame zip | 2:1 JPEG (pictures) or PNG (data) frames at 2048 and 4096, plus the manifest | Spherical displays, Digistar, WorldWide Telescope, anyone |
| KMZ | One GroundOverlay per frame, at most 2048×1024, each with a TimeSpan | Google Earth Pro; Google Earth on the web without animation |

### 6.5 Where files live, and their addresses

- **Built by the runner** that already encodes the HLS ladder, at
  publish time, and stored in R2 beside it. A bundle is built for a
  dataset when the publisher turns it on, not for every dataset by
  default: frame zips duplicate frames, and the legacy catalog is
  large.
- **Stable addresses.** `GET /api/v1/datasets/{id}/files/{name}`
  answers with a redirect to the current object, so a republished
  dataset changes the object and not the address a dome's asset file
  holds. For a legacy SOS video hosted on Vimeo, the same address
  mints a fresh signed link each time, so a configuration does not
  break every hour. Whether OpenSpace's `UrlSynchronization` and Second
  Life's video plugin follow redirects is a Phase D1 check; if either
  does not, the Function serves the bytes.
- **Range requests, `Content-Type: video/mp4`, open CORS.** Players
  outside a browser ignore CORS, but a web developer's globe material
  needs it — and today the video host allows only the node's own
  origin (`SECOND_LIFE_COMPAT.md` §4.4). Decided (§11 q7): the files
  route answers with `Access-Control-Allow-Origin: *`; the existing
  streaming host is unchanged, so the app's own video keeps its
  narrower policy.
- **Only what may be redistributed.** The same eligibility as STAC
  (public, published, a curated licence); every file carries the
  credit and licence in its manifest. The SOS datasets are NOAA public
  domain and may be re-shared (decided, §11 q8); what remains for them
  is bookkeeping, not permission — the importer records a cautious
  originating-organisation statement rather than a licence identifier
  (`docs/metadata/README.md`, "Generic licensing"), and the files need
  the curated one.

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
the one client still to check (§11).

**Every level above native is a 2×2 decimation of the one below.**
Because WorldCRS84Quad's blocks align with the source pixel grid and
with the antimeridian, no block straddles the seam, and the pyramid can
be built in one pass with no reprojection.

**How a 2×2 block becomes one pixel is a property of the data.** One
method for everything is the default in every tiling tool and is wrong
for some of the catalog. Proposed: a per-dataset `decimation` value,
set by the publisher, defaulted from the dataset's kind, and stated in
the capabilities abstract (decided, §11 q6):

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
  pixel survives the zoom-out. The half-area threshold was decided
  (§11 q5).
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
  client could invert. ArcGIS reads palette PNGs (Esri's own tile
  caches use them), GIBS serves its colour-mapped layers that way, and
  GDAL — so OpenSpace and QGIS — expands them on read; D1 confirms the
  transparency chunk survives in each.
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
transcoded down from the 4K video (§6.2).

### 7.5 What each tool actually uses

The targets the rules above are aimed at, from §2. "Stretches" means
the tool upscales past a layer's deepest level by itself, so cutting
deeper than the source would only spend storage.

| Tool | Space | Time | Format |
|---|---|---|---|
| OpenSpace | 4096×2048 for 4K domes, 8192×4096 for 8K; stretches | Steps of whole years; months 1–4 or 6; days 1–28; hours 1–4, 6 or 12; minutes 15 or 30. Finer data reaches it through server-side snapping (§5.3) or Folder mode | 8-bit; PNG for data frames with a palette image; H.264, constant rate, keyframe ≤ 1 s |
| Science On a Sphere | 2048×1024 for series, 4096×2048 for stills | 30 fps, 10–15 for coarse data | MPEG-4 Part 2 ≥ 25 Mbit/s; JPEG or PNG frames |
| Spherical displays, Digistar | 2048 or 4096 wide | 30 fps | H.264 (assumed; confirm per vendor) |
| Second Life | The face width: 1024 by default, 2048 for close viewing | Shared clock in the output page; a plain MP4 loops on its own | H.264; the 1024 rendition at 1.5–2 Mbit/s |
| ArcGIS Online | `GetMap` ≤ 2048; Web Mercator native at level 4 for 4096 sources; zooming past the deepest level unknown | WMS time, as an interval or a list | PNG with a palette, or JPEG; CRF with LERC for analysis |
| QGIS | Stretches | Rounds down to the period | Any |
| CesiumJS | Stretches | The interval containing its clock, no blending, prefetches the next | Any |
| Google Earth | ≤ 2048 a side on the web | One TimeSpan per frame (Pro only) | JPEG or PNG |

---

## 8. Contract and governance

- **A separate projection, like STAC.** Tiles, WMS and files are new
  routes over the canonical D1 catalog. Nothing is added to
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
  gains an additive field naming the capabilities and file roots,
  present only when the service is on — the pattern `federation.feed`
  already follows (`functions/.well-known/terraviz.json.ts`).
- **Vendor-neutral by construction.** Every node-side channel is an
  open standard or a plain file, which keeps
  `architecture/federation-scoping.md` Goal 2 ("no required vendors")
  true. The ArcGIS Image adapter and the Hub registration script are
  operator tools, run with the operator's credentials and credits,
  outside the node's contract and out of its dependencies.
- **Same eligibility as STAC.** Public, published, not retracted, with
  a curated licence (`functions/api/v1/_lib/metadata-readiness.ts`);
  every file names its credit and licence.
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

- **Every phase merges dark.** Each surface sits behind its own
  environment flag and answers 404 until an operator sets it, the way
  `STAC_ENABLED` does (`functions/api/v1/_lib/stac-http.ts:45`).
  Merging a phase changes nothing on any node; turning it on is a
  per-node decision, and turning it off withdraws it without a
  deploy. The flags proposed here are `FILES_ENABLED`,
  `TILES_ENABLED` and `WMS_ENABLED`.
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
| **D2a** Video files | The §6.1 variants, manifests, the files route | D1 | `FILES_ENABLED` | A variant plays time-synced in OpenSpace | M |
| **D2b** Bundles | OpenSpace asset, SOS directory, frame zip, KMZ | D2a | `FILES_ENABLED` | Each loads unmodified in its tool | M |
| **D2c** Publisher controls | Portal section for delivery settings and build status | D2a | — | A publisher turns a bundle on and sees it build | S |
| **D3a** Pyramids | Tile cutting in the runner, with the §7 methods | D1 | `TILES_ENABLED` | Parity and reduction tests pass on D1's datasets | M |
| **D3b** WMTS | Tile route, capabilities, TileJSON, GDAL XML, colour maps | D3a | `TILES_ENABLED` | OGC validator passes; four clients load it | M |
| **D3c** Discovery and contract | STAC links, `.well-known` field, `docs/protocol` entry | D3b | as D3b | Federation review: additive-safe | S |
| **D4** WMS with time | `GetMap` served from the pyramids | D3b, CPU gate | `WMS_ENABLED` | CPU within budget; ArcGIS time slider animates | M |
| **D5a** Analysis rasters | A COG per time step from the Zyra runner, as STAC assets | D1 | as STAC | QGIS opens one from STAC; values match the source | M |
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
| 2026-11-06 | The maintainer | The SOS datasets are NOAA public domain and may be re-shared | §9.13, q8 |
| 2026-11-06 | The maintainer | SOS still needs MPEG-4 Part 2 movies | §6.1, q9 |
| 2026-11-06 | The maintainer | OpenSpace users download TerraViz assets from TerraViz | §6.4, q10 |
| 2026-11-06 | The maintainer | Every tile goes through the Function; none straight from the bucket | §5.6, q12 |
| 2026-11-06 | The maintainer | A WebAssembly image codec may be added for WMS if the CPU test passes | §9.10, q15 |
| 2026-11-06 | The maintainer | Count embedded views, as a separate change to the app's analytics | §9.14 |

### 9.3 D1 — Prove it by hand

No code enters the tree. With GDAL and ffmpeg on a laptop, a scratch R2
bucket and a throwaway Worker, take one image-sequence dataset and one
data-encoded dataset through every format this plan proposes, and
measure.

| Question | How | Decides |
|---|---|---|
| Do the grids load, the right way up, at the right longitude? | Cut both pyramids; load in OpenSpace (GDAL XML), QGIS, CesiumJS and ArcGIS Map Viewer | §5.1, §11 q1–q3 |
| Does each client snap time as §5.3 assumes? | Request off-frame times from each client; read the server log | §5.3, §11 q4 |
| Does ArcGIS stretch past the deepest level or go blank? | Zoom past level 2 in Map Viewer | §11 q2 |
| What does a `GetMap` cost? | Stitch-and-scale in the Worker; read Cloudflare's CPU time, not elapsed time | D4's go / no-go |
| What does a time step cost OpenSpace? | `h264-4096` at keyframe intervals of 1 s and 6 s (today's encode, `cli/lib/ffmpeg-hls.ts:352-357`), time-mapped, on the collaborators' dome | §6.1's keyframe rule |
| Does OpenSpace's Folder mode read the dates right? | Dated frame names across a month boundary | §6.3, §11 q10 |
| Do redirects survive? | Point OpenSpace's `UrlSynchronization` and Second Life's video plugin at a 302 | §6.5 |
| Does an SOS site accept the directory? | Hand one to an SOS site or the SOS team | §6.4, §11 q9 |
| Does a plain MP4 play on a Second Life sphere? | `h264-1024` through the video plugin, in Firestorm and Linden Lab's viewer | §2.3, §4 |
| What does a pyramid cost? | Bytes, object count and cut time per frame on a GitHub runner | §5.8, D3a sizing |

The output is `docs/delivery/D1_PROTOTYPES.md`: the measurements, the
answers, and an amendment to every section of this plan they
contradict.

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
  a redirect to the current object; for a legacy Vimeo-hosted video, a
  freshly signed link through the proxy `manifest.ts` already uses;
  404 unless `FILES_ENABLED`.
- **Counting** (§9.14): the three-layer platform classifier and the
  Analytics Engine writer as a pure module, the delivery dataset's
  binding in `wrangler.toml`, the files route's counts, the nightly
  rollup into D1, the "unknown clients" report with its list of likely
  names, and the Delivery panel in `/publish/analytics`.

**Tests.** Pure tests for the encoder arguments and the manifest; a
runner smoke test that checks the result with `ffprobe` (constant
rate, keyframe spacing, frame count equal to the dataset's); a parity
test that a palette-applied frame's colour at a texel is the LUT's
entry for that texel's luma; route tests for the redirect, the flag
and an ineligible dataset.

**Gate.** An `h264-4096` file plays time-synced in OpenSpace on the
collaborators' setup, and the route serves on a preview deploy.

**Reviewers.** The Video Streaming Engineer for the encode and the
workflow change, with the `terraviz-data-video` skill and
`npm run check:luma-range` for data-encoded output; the Scientific
Visualization Reviewer for palette application and reduction; the
API Platform Engineer for the route's shape; the Application Security
Engineer for headers and CORS; and, because a D1 migration is one of
`GOVERNANCE.md`'s high-scrutiny areas, the Code Reviewer migration
first, with the PR saying whether a person outside the loop has
reviewed it. The counting adds the `analytics-reviewer`, run before
any other, and the Privacy Engineer (§9.14).

**Rollback.** Unset `FILES_ENABLED`. The table is additive and the R2
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
with links. Beside it, for admins, a list of registered partner tags
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
  lenient time parsing and the §5.3 snap.
- **The cutter** (`cli/lib/tile-cutter.ts`): normalise each frame
  (§5.5), place it at the native level, reduce level by level with the
  dataset's method (§7.1) — in TypeScript, because GDAL's overview
  builder averages palette codes, not values, and knows nothing of the
  no-data band — then write indexed PNG for data-encoded layers and
  JPEG for opaque pictures, under a prefix keyed by the frame's digest.
- **The Web Mercator set** warped by `gdalwarp` from a floating-point
  raster of *values* at the native level, with the dataset's method
  and its no-data value, and coloured afterwards — warping coloured
  pixels would average colours, the §7.1 failure. GDAL is installed in
  the runner from apt, the way ffmpeg already is
  (`.github/workflows/transcode-hls.yml:146`).
- **A per-dataset index** in R2 from frame time to frame digest, which
  the serving route reads to snap a time.

**Tests.** The cutter is tested against the probe the hover readout
uses: for random points, a native-level tile pixel equals the source
texel `latLonToTexelUv` names (`src/services/datasetProbe.ts:45`),
after normalisation — a regional bounding box included, since that is
where a US box once landed over the South Pacific. `mean` equals the
area-weighted mean `datasetStats.ts` computes over the same cells;
`mode` breaks ties the same way every run; `max` keeps a single valid
pixel through every level; no block straddles the antimeridian; an
indexed PNG's palette is byte for byte the dataset's LUT.

**Gate.** Those tests pass on D1's two datasets, and a 1,000-frame
pyramid builds inside the runner time D1 measured.

**Reviewers.** The Scientific Visualization Reviewer for the reduction
methods and colouring; the Video Streaming Engineer for the workflow
change; the Code Reviewer.

### 9.8 D3b — WMTS

**Builds.** `functions/api/v1/wmts/[[path]].ts` with helpers in
`functions/api/v1/_lib/`: RESTful and KVP `GetTile`; a capabilities
document generated from D1 under the STAC projection's eligibility
rules; snapping through the shared module, 404 for gaps, `default` the
latest frame; edge caching; open CORS. Beside it, per layer: TileJSON,
a GDAL WMS XML, and for data-encoded layers a GIBS ColorMap v1.3 file
with SVG and PNG legends generated from the dataset's `color_scale`.
Capabilities documents and layer configurations are counted, tiles are
not, and a tag on a capabilities request is carried into the tile
addresses it advertises (§9.14).

**Tests.** The capabilities document against OGC's WMTS 1.0 schemas,
and OGC's own WMTS test suite in a CI job that runs only when asked,
as `.github/workflows/stac-api.yml` runs the STAC validators. Client
tests that run only when their tools are present, on the pattern of
the QGIS check in `functions/api/v1/stac/clients.test.ts:31`: QGIS
animates a layer, `gdalinfo` opens the GDAL XML, CesiumJS in headless
Chromium draws a tile at a known time.

**Gate.** The OGC suite passes for everything the capabilities
advertise; QGIS, CesiumJS, OpenSpace and ArcGIS Map Viewer each load a
layer on a preview deploy; CPU per tile request is measured there.

**Reviewers.** The API Platform Engineer and the TerraViz Federation
Reviewer for a new published contract; the Scientific Visualization
Reviewer for colour maps and legends; the Application Security
Engineer for CORS and routing (`public/_routes.json`); the Code
Reviewer.

### 9.9 D3c — Discovery and the contract

**Builds.** STAC items gain web-map-links to their WMTS layers
(`functions/api/v1/_lib/stac-builders.ts`); `/.well-known/terraviz.json`
gains an additive field naming the tile root, present only when
`TILES_ENABLED` is set; `docs/protocol/` gains the delivery contract
and a changelog entry; `docs/SELF_HOSTING.md` says how an operator
turns each flag on; `docs/BACKEND_MODULES.md` gains its rows; STAC
reads are counted (§9.14).

**Gate.** The TerraViz Federation Reviewer classes the `.well-known`
and STAC changes as additive-safe, and the existing STAC validators
still pass.

**Reviewers.** The TerraViz Federation Reviewer; the API Platform
Engineer for the STAC shape; the Scientific Data Steward for the STAC
metadata; the Technical Writer for `SELF_HOSTING.md`.

### 9.10 D4 — WMS with time

**Builds.** `functions/api/v1/wms.ts`: capabilities with a `TIME`
dimension per layer, and `GetMap` in `CRS:84`, `EPSG:4326` and
`EPSG:3857`, stitched from the pyramids and scaled, at most 2048 a
side, nearest neighbour for data layers, a transparent image for a gap
(§5.9). Capabilities are counted; maps are not (§9.14).

**The CPU gate comes first.** Before any route lands, the worst-case
`GetMap` — 2048×2048, in each CRS, a data layer and a picture layer —
is measured on an isolated preview deployment against its CPU limit,
by the protocol the STAC rollout gate uses
(`docs/metadata/PHASE4_IMPLEMENTATION.md` §Rollout Gate). Decoding and
encoding images inside a Worker means a WebAssembly codec, which is a
new dependency, accepted if the CPU test passes (decided, §11 q15). If
the measurement
fails, D4 stops there: ArcGIS users get one WMTS layer per frame with
time-based visibility (§2.1), which works for short series and not for
long ones, and the plan says so.

**Tests.** OGC's WMS 1.3 test suite in the same opt-in CI job; the
stitching tested against the tiles it came from.

**Gate.** ArcGIS Map Viewer's time slider animates a layer from a
preview deploy, and QGIS's Temporal Controller does the same.

**Reviewers.** As D3b.

### 9.11 D5a — Analysis rasters

**Builds.** A Cloud-Optimised GeoTIFF per time step, made by the Zyra
runner from the field before it is rendered, floating point, stored in
R2 by digest and listed as a STAC asset with the projection and raster
extension fields.

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

**Builds.** Frame extraction for video-only datasets: decode, drop
duplicates (exact duplicates only for data-encoded video, `mpdecimate`
for pictures, §7.2), assign dates, and refuse a dataset whose
de-duplicated frames do not fit its span evenly. Off by default and
turned on per dataset.

**The gate is a person, not a test.** Before a dataset's tiles or
files go public, someone with the authority to say so records that it
may be redistributed in these forms, saying who decided, on what, and
when, as `CLAUDE.md` asks wherever a person rather than an agent owns a
decision. For the SOS catalogue that record exists: the maintainer
stated on 2026-11-06 that the SOS datasets are NOAA public domain and
may be re-shared (§11 q8). Each still needs its licence curated in the
catalog, so its files can say so (§6.5); datasets from other sources
need their own record.

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
STAC — but not each tile or map (decided, q17). Not the TerraViz app, which already has its own consent-gated
telemetry, and not the output page, whose reporting is opt-in per
globe by design (`src/output/webTelemetry.ts`) and must not gain a
second, ungated path.

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
  summarised by month in the rollup (decided, q19).
- **The platform's version, as `major.minor`**, for platforms on the
  curated list only, and only on a layer load or a download — never on
  anything finer. It answers support questions such as whether to rely
  on WMTS time (QGIS 3.28 and later) or video layers (OpenSpace 0.19
  and later). It sits in its own field, so it can be dropped without
  disturbing the rest (decided, q20).

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
   reused, so old counts keep their meaning.
3. **Discovery: for the platforms nobody told us about.** A request
   with no recognised tag is classified from what every client already
   sends: the User-Agent's first product token (`QGIS`, `GDAL`, `VLC`,
   `curl` — RFC 9110's `name/version` form, version dropped) and, for a
   browser request, the registrable domain of its `Origin` header
   (`arcgis.com`, `cesium.com`, a museum's site). Names on a curated
   list are stored as themselves. Anything else is stored as `other`
   plus a 12-hex hash of the normalised token or domain — invariant 3's
   treatment of free text — kept only in Analytics Engine's 30–90-day
   window and never rolled up. Hashing uses the app's own helper
   (`src/analytics/hash.ts`), so the repository has one rule for it
   (decided, q21). An "unknown clients" report ranks those hashes by
   frequency and matches them automatically against a list of likely
   names — HTTP clients, GIS and visualisation tools, well-known science
   and museum sites — so anything on that list shows by name and only
   the truly unknown stay hashes. This works for software and sites as
   it would not for search terms, because their names are public and
   easy to list: the dictionary lookup `docs/ANALYTICS_CONTRIBUTING.md`
   describes, done ahead of time. Once identified, a platform is
   promoted: onto the curated list (a code change, and append-only
   under invariant 8) or as a partner tag (a row).

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

**What is never recorded:** an IP address, a raw User-Agent, or any
identifier that would link one request to another — no session id at
all. That is stricter than the app's telemetry needs to be, and
deliberately: the people using these tools never saw TerraViz's
disclosure banner, so nothing about them is kept beyond a count.
Generated bundles never report anything themselves; only the requests
they make are counted.

**Two exceptions.**

- **Virtual-world viewers are counted without a country.** The output
  page's reporting was designed around a venue that logs avatar
  arrivals learning a visitor's real-world attributes, and accepts a
  country only inside its first minute (`PRIVACY_ANALYSIS.md` §9k). A
  plain MP4 on a Second Life sphere would otherwise hand that venue a
  country and a time for every arrival, so a request classified as a
  virtual-world viewer or its video player keeps no country.
- **`KILL_TELEMETRY` stops these writes too**, as it stops the
  ingest function's.

**Counting uses, not bytes.** A file counts once per download: a
request with no `Range` header, or one starting at byte 0, not the
dozens of range requests a player makes after it. A capabilities
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
rollup, and these counts have no session id to sample on. The cost is
one more binding in `wrangler.toml` and one more step for an operator
setting up a node. From there they go through
the nightly rollup into D1 that the publisher portal's analytics tab
already reads (`docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md` Phase A), so
per-platform and per-method numbers appear in `/publish/analytics` and
outlive Analytics Engine's 30–90 days. A Delivery panel there shows
uses by platform, by method, by dataset and by month.

**The embed is the one method this does not reach.** An embedded
TerraViz is the app itself, counted by its own telemetry where the
visitor allows it — but `session_start` does not say whether it is
running embedded (`src/analytics/session.ts` has no such field), so
"how many people saw a TerraViz globe inside a StoryMap" needs one
append-only Tier A field there (invariant 8). That is a small change
of its own, through the `add-analytics-event` checklist; the
maintainer asked for it on 2026-11-06.

**Which phase adds what.** D2a builds the classifier and the writer as
a pure module, counts the files route, and adds the rollup and the
Delivery panel; D2b writes the tag into every bundle; D3b counts
capabilities documents and layer configurations and carries the tag
into advertised tile addresses; D3c counts STAC reads; D4 counts WMS
capabilities; D5b's registration script tags the items it creates. Every one of them runs the `analytics-reviewer`
first and the Privacy Engineer, updates `docs/ANALYTICS.md`,
`docs/ANALYTICS_QUERIES.md`, a Grafana panel and `docs/PRIVACY.md`
(rebuilding `public/privacy.html`), and — the analytics ingest path
being one of `GOVERNANCE.md`'s high-scrutiny areas — the Code Reviewer
as well, with the PR saying whether a person outside the loop has
reviewed it.

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
- **Editing `SECOND_LIFE_COMPAT.md` here.** The corrections in §2.3
  belong in their own change.

---

## 11. Open questions

1. *Decided provisionally 2026-11-06 by the maintainer:* 512 pixels for
   the lat/lon grid; D1 loads both 512 and 256 in every client and may
   reverse it (§5.1).
2. **Does ArcGIS stretch WMTS tiles past the deepest level, or go
   blank?** If blank, cut one or two upsampled levels in the Web
   Mercator set only.
3. **Is Esri's "WGS 1984 Version 2" scheme the same as the lat/lon
   layout?** It decides whether ArcGIS Scene Viewer can use the lat/lon
   pyramid.
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
8. *Decided 2026-11-06 by the maintainer:* the SOS datasets are NOAA
   public domain and may be re-shared. Their licences still need
   curating in the catalog so each file says so; datasets from other
   sources need their own record (§6.5, §9.13).
9. *Decided 2026-11-06 by the maintainer:* SOS's MPEG-4 Part 2 guidance is
   still current; the `sos-mpeg4` movie stays (§6.1).
10. *Decided 2026-11-06 by the maintainer:* OpenSpace users download
    TerraViz assets from TerraViz rather than from OpenSpace's own
    library. Still open, and tested in D1: whether Folder mode's date
    parsing is off by one day.
11. **Does Hub's DCAT feed include WMS and WMTS items?** Tested in D1,
    in the maintainer's ArcGIS organisation, before promising data.gov
    reach.
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
    resolves them against a list of likely names (§9.14).

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
