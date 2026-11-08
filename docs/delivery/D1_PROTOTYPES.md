# D1 — Prototypes by hand

**Status: in progress, draft for review.** Phase D1 of
[`DATA_DELIVERY_PLAN.md`](../DATA_DELIVERY_PLAN.md) (§9.3): take real
datasets through every format the plan proposes, measure, and write
down what is true. No code entered the tree. Every script, pyramid and
encode lives outside the repository, in a scratch directory or a
throwaway Worker project. The only repository changes are this
document and the plan amendments it records in §9.2.

**Last reviewed:** 2026-11-08 (started the same day).

**Revisit when any of the following becomes true:**

- A row recorded below as "not run" or "kit handed over" comes back
  with results. Each one changes a section of the plan.
- D2a or D3a starts. They are built on these measurements, so a
  measurement that turns out wrong in a build is corrected here first.
- A client named here ships a release that changes the behaviour
  recorded (GDAL, QGIS, CesiumJS, MapLibre, Leaflet, OpenSpace, ArcGIS
  Map Viewer, a Second Life viewer).
- One of the datasets below is retracted, relicensed, or found to carry
  terms other than those recorded in §1.

**How to read it.** §1 records which datasets were used and on what
terms, before anything was produced from them. §2 records the machine.
§3 has one section per row of the plan's D1 table, plus the §11
questions D1 was asked to answer that the table does not list. Each
section gives the question, the method, what was measured, the answer,
and which plan sections and §11 questions it settles. A row that could
not be run says so, with the reason and what would unblock it. A row
that needs a person or a place this session cannot reach is turned
into a kit (§4) and marked "kit handed over" until its results come
back.

---

## 1. Datasets and their terms

D1 hands its outputs to other organisations: the OpenSpace
collaborators, an SOS contact, an ArcGIS test organisation and a
Second Life sphere (§6.5, §11 q22). So the datasets were chosen first,
for terms that allow it, and recorded here before any tile, encode or
bundle was made from them.

### 1.1 The datasets

Each was snapshotted from the production node
(`https://terraviz.pages.dev`) on 2026-11-08 through
`GET /api/v1/datasets/{id}/frames`, every frame fetched from the
digest path that route lists and checked against its `contentDigest`.
The **selection digest** is the SHA-256 of the selected frames'
`contentDigest` strings, joined by newlines in index order, so a later
reader can tell whether a re-fetch is the same set. The node's own
`framesDigest` hashes the upload's source-filenames blob, which a
consumer cannot recompute from the listing, so both are given.

| Role | Dataset | Frames used | Source frame | Terms on record | Credit |
|---|---|---|---|---|---|
| **Image sequence** | `drought-risk-weekly`, "Drought Risk – Real-time" (`01KTSK42PJZAXRRQXY2WH62CQC`) | All 51, weekly, 2025-11-13 to 2026-10-29, at 00:00Z | 4096×2048 RGB PNG, about 6.6 MB | "Public domain / US Government" | NOAA |
| **Data-encoded**, and the **regional** dataset | `wildfire-smoke-forecast-transparent-united-states-rrfs`, "Wildfire Smoke Forecast (Transparent) — United States (RRFS)" (`01KYJDXB4909JWG8DP257D3D0Z`) | All 85, hourly, 2026-08-06T00Z to 2026-08-09T12Z | 2250×960 8-bit grey PNG over 21–53°N, 135–60°W | Public domain, a U.S. Government work | NOAA Global Systems Laboratory, Rapid Refresh Forecast System (RRFS) |
| **Data-encoded, global, wider than 4096** | `mpas-reflectivity-test`, "MPAS Reflectivity Test" (`01M0151BAFM1PV238D967NJFE7`) | All 20, six-hourly, 2025-07-27T06Z to 2025-08-01T00Z | 7200×3600 8-bit grey PNG | Public domain, a U.S. Government work, per the maintainer (2026-11-08); the catalog record says otherwise (§1.2) | NOAA Global Systems Laboratory |
| **Keyframe test only** | `clouds-real-time`, "Clouds – Real-Time" (`01KVRFD8B8JC7BCJHE8VJ2HMC2`) | 1,008 contiguous frames, indices 3300–4307, every 10 minutes, 2026-11-01T12:30Z to 2026-11-08T12:20Z | 4096×2048 JPEG, about 1.1 MB | "Public domain / US Government" | NOAA |

| Dataset | Node `framesDigest` | Selection digest (first 16 hex) | Bytes kept |
|---|---|---|---|
| `drought-risk-weekly` | `sha256:830af641…66d4` | `983c9ce0439d5511` | 339.1 MB |
| `wildfire-smoke-…-rrfs` | `sha256:c4d37e57…97fa2` | `6871010c9cdb1fc0` | 16.1 MB |
| `mpas-reflectivity-test` | none on the record | `c01c2b7b251dda33` | 223.8 MB |
| `clouds-real-time` | `sha256:747bcd73…f5fd` (whole 4,314-frame window) | `50a2b8059b8823b6` | 1,088.0 MB |

**Why these.** The drought frames are lossless and their colours are
classes, so they exercise `colour-mapped` (§7.1), which most of the
legacy SOS catalog defaults to, and their weekly dates cross month
boundaries, which OpenSpace's Folder mode test needs (§11 q10). The
RRFS frames are lossless codes whose palette fades in alpha (0, 5, 10,
… at the low end), which is the partial-transparency case §7.3 asks
GDAL about, and their box puts them at an effective global width of
10,800 pixels, so they exercise §5.5's regional placement and a native
level of 4. MPAS is the catalog's one global data-encoded dataset
stored as frames, and the one at 7200×3600: the width that is not
1024 × 2ⁿ, which §7.1's fractional-overlap rule and §7.4's 7200→4096
case are about. Its published video is HEVC Main at 7200×3600
(`ffprobe`: 20 frames at 2 fps, full range, no colour tags), which is
the only one in the catalog above 4K. The clouds slice is there
because 51 weekly frames are too short for a comparison of 1-second
and 6-second keyframe intervals to mean anything; it is used for that
test and nothing else.

**Rows that need only a time axis.** The calendar-snapping rows (§3.3)
use the time axes of four legacy SOS rows, with synthetic "date card"
frames that print their own index and date, so a screenshot shows
which frame a client was given. None of these datasets' imagery is
used or handed on, so their terms do not arise.

| Case | Row | Axis on record |
|---|---|---|
| Monthly | SOS 491, `surface-temperature` | `P1M`, 2009-01-01 to 2009-12-31 |
| Yearly from 1 January | SOS 420, `temperature-anomaly-yearly-noaa-1850-present` | `P1Y`, 1850-01-01 to 2024-12-01 |
| Yearly from 31 December | The nine SSP climate-model rows (`INTERNAL_SOS_SSP_*`) | `P1Y`, 2015-12-31 to 2100-12-31 |
| Daily at 12:00Z | SOS 643, `earthquakes-2001-2015` | `P1D`, 2001-01-01T12:00Z to 2015-12-02T12:00Z |

**Rows that need geometry, not data.** No dataset in the catalog has a
box that crosses the antimeridian, and checking "the right way up, at
the right longitude" by eye on a real field is imprecise. So those
checks use a synthetic **test pattern**: a 2:1 frame whose every
pixel's colour encodes its own latitude and longitude, with a labelled
graticule drawn over it, plus a regional variant whose box crosses
180°. It is made here and carries no third-party terms.

### 1.2 What the records do not say

- **MPAS's licence record is wrong.** The catalog row carries
  `licenseSpdx: CC-BY-SA-4.0` and no organisation, credit or rights
  holder. The maintainer stated on 2026-11-08 that GSL created it and
  that it is in the public domain. D1 uses it on that statement, with
  credit to NOAA GSL. Either licence would allow handing outputs on,
  but the record is what every delivery channel will read (§6.5), so
  the row needs correcting in the portal: a public-domain statement, an
  organisation and a credit. Its `endTime` (2025-08-01T06:00Z) is also
  one period past its last frame (2025-08-01T00:00Z).
- **The RRFS row has a `transparentRange` and no `dataMinLuma`.** §7.1
  asks the producer to record, before tiles are cut, whether the band
  below the cutoff means zero or absent. D1 treats it as **zero**: the
  field is a column mass of smoke, where a low code is a measurement of
  little or none, not a gap. That is the maintainer's provisional
  answer (2026-11-08), recorded here as an assumption for D1's
  prototypes, not as the producer's decision.
- **Two of the four are rolling windows.** `clouds-real-time` keeps
  about 30 days of 10-minute frames and was updated minutes before the
  snapshot; `drought-risk-weekly` was last updated 2026-11-06. Being
  real time does not matter to D1, which measures a snapshot pinned by
  digest. It matters to §7.2's rule that a rolling layer's time
  dimension has a moving start, which D1 does not test.
- **None of the four has its terms in an SPDX field.** Three carry a
  free-text public-domain statement; MPAS carries the wrong identifier.
  §6.5's eligibility check reads a licence on record, so all four would
  need curating before a delivery channel served them. That is D2a's
  work, not D1's.

---

## 2. Environment

Everything in §3 that is not a kit ran in one Claude Code cloud
container on 2026-11-08: Ubuntu 24.04, 4 vCPU, 16 GB of memory, the
same shape as a GitHub `ubuntu-latest` runner. Cut times are therefore
a fair proxy for the runner the plan names (§5.6), not a measurement on
one. The scratch directory held about 7 GB of frames, tiles and
encodes, none of it in the repository.

| Tool | Version | Used for |
|---|---|---|
| GDAL | 3.8.4 (Ubuntu package) | The WMTS and WMS/TMS drivers, `gdal_translate`, palette expansion |
| QGIS | 3.34.4 (Ubuntu package), driven headless through PyQGIS | §3.1–§3.4, §3.7 |
| ffmpeg | 6.1.1 (Ubuntu package), libx264, libx265, `mpeg4` | §3.9 |
| Chromium and Playwright | as installed in the container | The browser clients |
| CesiumJS | 1.146.0 | Lat/lon at 512 and 256, time |
| MapLibre GL JS | 6.15.0 | Mercator at 512 and 256 |
| Leaflet | 1.9.4 | Mercator at 256 and 512 |
| numpy 1.26, scipy 1.11, Pillow 10.2 | Ubuntu packages | The scratch cutter |

**The scratch cutter.** The pyramids were cut by a short numpy script
rather than `gdal2tiles`, because `gdal2tiles` builds each level from
the one below, which §7.1 rejects. Every level is computed straight
from the source with exact overlap weights in longitude and in
sin(latitude), so a cell's weight is its true area. Native and finer
levels are taken by nearest neighbour. `mean` re-quantises to the
code grid under the half-area rule. `max` takes the largest valid code
over every overlapping source cell. `picture` averages in linear light.
Mercator is taken by nearest neighbour from the lat/lon level of the
same width (§7.1). Data tiles are 8-bit indexed PNG whose palette and
`tRNS` chunks are the dataset's own LUT, built by the repository's
`buildColorScaleLut`; picture tiles are JPEG at quality 85 (Pillow's
default 4:2:0). It is a prototype for measuring, not D3a's cutter.

**The tile server.** A small Python server, also scratch, serves those
tiles under §5.2's URL grammar, generates WMTS capabilities in every
variant compared below, snaps time by §5.3 with calendar arithmetic and
§5.2's reduced-precision rule, sends `Access-Control-Allow-Origin: *`,
answers a missing tile with a 404, and logs every request, with the
time each client asked for and the frame it got. Each variant is a path
prefix, so every client configuration hits distinct addresses:
`crs84` or `urn` (or a deliberately mismatched corner) for the lat/lon
CRS, `limits` (one shared set with `TileMatrixSetLimits`) or
`perdepth` (a set per depth, GIBS's `_LevelN` pattern), `512` or `256`,
and `ms` for times advertised with milliseconds.

---

## 3. Results by row

Each subsection is filled as its results arrive. Until then it reads
"pending".

### 3.1 Do the grids load, the right way up, at the right longitude?

**Question.** Does each client read both grids correctly with the
lat/lon CRS declared both ways (CRS84, and the EPSG URN), the depth
declared both ways (one shared set with `TileMatrixSetLimits`, and a
set per depth), and tiles of 512 and 256 pixels (§5.1, §11 q1)?

**Method.** The geometry test pattern (§1.1), served in every variant
of §2. Each client drew it, and the colour at known points was decoded
back to a source texel and compared with the texel the repository's
own probe, `latLonToTexelUv`, puts there. A point is right when the two
agree to within the level's sampling (one source pixel at the native
level).

- **GDAL**: the WMTS driver opening each capabilities document, and the
  GDAL WMS XML with the TMS service, which is the path OpenSpace takes
  (§5.7).
- **QGIS**: its own WMTS provider (not GDAL's), rendering at twice the
  native resolution.
- **CesiumJS**: `WebMapTileServiceImageryProvider` with a 2×1
  `GeographicTilingScheme`, in 2D. It reads no capabilities document,
  so the CRS and depth variants do not apply to it.
- **MapLibre and Leaflet**: the Mercator grid through an XYZ template.

Also tried, as deliberate mistakes: each CRS declaration with the
other axis order's corner.

**What was measured.**

| Client | Declaration | Result |
|---|---|---|
| GDAL WMTS | CRS84, corner `-180 90` | Right (10 of 10 points) |
| GDAL WMTS | EPSG URN, corner `90 -180` | Right |
| GDAL WMTS | Short `EPSG:4326`, corner `-180 90` | Right: GDAL does not swap for the short form, as §5.1 says |
| GDAL WMTS | Any of the three with the other corner | Wrong at every point, with no error or warning |
| GDAL WMTS | One shared set with limits | Reads the deepest level of the **set** as full resolution, past the layer's last level, and gets 404s |
| GDAL WMTS | A set per depth | Right |
| GDAL TMS XML | 512 and 256 | Right |
| QGIS 3.34 | CRS84 and EPSG URN, per-depth, 512 and 256 | Right (every point) |
| QGIS 3.34 | One shared set with limits | Asks for the level that suits its view, past the layer's last level: 560 requests, all 404, for one 512-pixel render (1,872 at 256, 4,032 on Mercator). A blank map |
| QGIS 3.34 | Mercator, per-depth | Right |
| CesiumJS 1.146 | Lat/lon at 512 and 256 | Right (10 of 10) |
| MapLibre 6.15 | Mercator 256 with `tileSize: 256` | Right, asks for zoom 3 at display zoom 2 |
| MapLibre 6.15 | Mercator 256 with no `tileSize` | Right place, half the resolution: it assumes 512 and asks for zoom 2 |
| MapLibre 6.15 | Mercator 512 with `tileSize: 512` | Right, 6 requests where 256 took 20 |
| Leaflet 1.9.4 | Mercator 256 | Right |
| Leaflet 1.9.4 | Mercator 512, `tileSize: 512` and `zoomOffset: -1` | Right |
| Leaflet 1.9.4 | Mercator 512 without `zoomOffset` | Wrong: up to 2,044 source pixels out |

Two more things the clients showed:

- **GDAL makes a Mercator layer 12 times too tall** if its
  `WGS84BoundingBox` runs to ±90°: 4096×49,577 pixels for a 4096-wide
  pyramid, mostly empty. Clipped to ±85.0511°, it reads 4096×4096 and
  right.
- **QGIS used KVP `GetTile` for every request**, never the REST
  template, because the capabilities advertised both (§5.2). The KVP
  route is not optional.

**The answer.**

- **Declare a tile matrix set per depth, as GIBS does.** A shared set
  with `TileMatrixSetLimits` fails in both GDAL and QGIS, the two
  clients that read limits at all. Each takes the deepest matrix in
  the *set* as the layer's, so it asks past the layer's last level and
  draws nothing. §5.1 left this to D1; the per-depth form is the one
  that works.
- **Both CRS declarations work, provided the corner follows the CRS's
  axis order.** The danger is the mismatch, which GDAL reads wrong
  without complaint. §5.1's choice of CRS84 with `-180 90` stands; the
  EPSG URN with `90 -180` is equally safe in GDAL and QGIS.
- **512 pixels (q1) holds for every client tested here.** Each read
  512 correctly when told, and asked for a quarter as many tiles (QGIS
  32 against 96; CesiumJS 2 against 10; MapLibre 6 against 20). Each
  also needs telling: CesiumJS `tileWidth`, MapLibre `tileSize`, and
  Leaflet `tileSize` plus `zoomOffset: -1`, which the companions and
  the docs must spell out. ArcGIS and OpenSpace, the two that decide
  q1, are in the kits (§3.5, §4).
- **Clip a Mercator layer's `WGS84BoundingBox` to ±85.0511°**, which
  §5.7 does not say.

**Settles.** §5.1's depth question (a set per depth) and its CRS
declaration (confirmed); §5.2's KVP encoding (needed, for QGIS); §5.7's
TileJSON `tileSize` (confirmed) and two additions: the Mercator bound
and Leaflet's `zoomOffset`. q1 is confirmed for GDAL, QGIS, CesiumJS,
MapLibre and Leaflet; **still open** for ArcGIS Map Viewer and
OpenSpace.

### 3.2 Does each client snap time as §5.3 assumes?

Pending.

### 3.3 Do calendar periods and dates snap right?

Pending.

### 3.4 Do regional frames land in place, and does palette transparency survive?

Pending.

### 3.5 Does ArcGIS stretch past the deepest level or go blank? (q2)

Pending.

### 3.6 Is Esri's "WGS 1984 Version 2" scheme the lat/lon layout? (q3)

Pending.

### 3.7 Is WMS axis order right?

Pending.

### 3.8 What does a `GetMap` cost? (q26)

Pending.

### 3.9 What does a time step cost OpenSpace? Video variants and keyframes

Pending.

### 3.10 Does OpenSpace's Folder mode read the dates right? (q10)

Pending.

### 3.11 Do redirects survive a real session?

Pending.

### 3.12 Does an SOS site accept the directory? (q9)

Pending.

### 3.13 Does a plain MP4 play on a Second Life sphere?

Pending.

### 3.14 Does Hub's DCAT feed list WMS or WMTS items? (q11)

Pending.

### 3.15 What does a pyramid cost?

**Question.** Bytes, object count, upload count and cut time per frame,
as loose tiles and as one pack per frame (§5.6, §5.8, D3a's sizing).

**Method.** Every frame of the drought (51), RRFS (85) and MPAS (20)
sets, and five frames of the clouds slice, cut into all four tile sets:
lat/lon at 512 (`ll512`, the primary grid) and 256 (`ll256`, the
registered WorldCRS84Quad), and Web Mercator at 256 (`wm256`, the
secondary grid) and 512 (`wm512`, for MapLibre). Five drought frames
were also cut as PNG with nearest-neighbour levels (`drought-cm`), the
`colour-mapped` treatment, and one MPAS frame with `mean` as well as
`max`. Timings are single-threaded wall time per frame on §2's machine:
reading the source, building every level, and encoding all four sets.
A pack is a header, a 16-byte index entry per tile and the tiles
concatenated, the shape of a PMTiles archive without its compressed
directory.

**What was measured.** Means per frame:

| Dataset, source, method | Native level | `ll512` tiles / MB | `ll256` tiles / MB | `wm256` tiles / MB | `wm512` tiles / MB | MB `ll512` ÷ source | Cut, all four sets |
|---|---|---|---|---|---|---|---|
| Drought, 4096×2048 RGB PNG, `picture`, JPEG | 2 (4096) | 42 / 1.79 | 170 / 1.90 | 341 / 3.39 | 85 / 3.21 | 0.27 | 5.0 s |
| Drought, same, nearest, PNG | 2 | 42 / 8.87 | 170 / 9.04 | 341 / 8.95 | 85 / 8.83 | 1.33 | 6.2 s |
| Clouds, 4096×2048 JPEG, `picture`, JPEG | 2 | 42 / 2.00 | 170 / 2.12 | 341 / 3.19 | 85 / 3.01 | 1.85 | 4.8 s |
| MPAS, 7200×3600 grey PNG, `max`, indexed PNG | 3 (8192) | 170 / 21.10 | 682 / 21.90 | 1,365 / 22.96 | 341 / 21.77 | 1.89 | 10.5 s |
| MPAS, same, `mean` (one frame) | 3 | 170 / 18.65 | 682 / 19.43 | 1,365 / 20.43 | 341 / 19.24 | 1.67 | 11.7 s |
| RRFS, 2250×960 grey PNG over 75°×32°, `mean`, indexed PNG | 4 (16384) | 47 / 0.59 | 145 / 0.68 | 181 / 0.74 | 55 / 0.62 | 3.11 | 1.5 s |

All 167 frames, cut four at a time on four cores, took 173 s of wall
time.

The pack adds 8 bytes plus 16 per tile: under 22 KB for MPAS's 1,365
Mercator tiles, against 23 MB of tiles. A frame's upload count is its
object count loose (383 for a 4096-wide frame on the two grids the
plan serves, 1,535 for MPAS, 228 for RRFS) and one per grid packed.
**Upload time to R2 was not measured**: that needs the scratch bucket,
and is the first thing to run once credentials are set up (§3.8).

Per 1,000 frames on the two grids the plan serves (`ll512` + `wm256`):
5.2 GB and 383,000 objects for the drought pictures, 1.3 GB and 228,000
objects for RRFS, and 44 GB and 1.5 million objects for MPAS.

**The answer.**

- **§5.1 and §5.8's counts hold.** 42 lat/lon tiles and 341 Mercator
  tiles for a 4096-wide frame, 383 objects per frame, and Mercator at
  eight times the objects and about twice the bytes (1.9×) of the
  lat/lon set. Cut time is seconds per frame, as estimated.
- **"About 1.3× the frame per lat/lon grid" is right only for a source
  1024 × 2ⁿ wide.** The pyramid's levels add a third, but the cut to
  the native level adds its own factor: the square of (native width ÷
  effective source width). MPAS's 7200 columns become 8192, so its
  pyramid is 1.9× its PNGs, not 1.3×. RRFS's box puts it at an
  effective 10,800 wide, cut at 16,384, so its pyramid is 3.1× its
  frames. A regional or odd-width dataset costs storage that §5.8's
  estimate does not show, and the estimate should say so.
- **Data-encoded datasets are the expensive ones.** Indexed PNG of a
  noisy field compresses about as well as its source and no better, so
  MPAS stores 44 GB per 1,000 frames where a JPEG picture stores 5. The
  plan's "tens of GB" is true of data, not of pictures.
- **A colour-mapped picture costs five times its JPEG as PNG.** The
  drought frames are class speckles over Blue Marble. Pillow's default
  JPEG (quality 85, 4:2:0) lost 36% of the speckle pixels at the native
  level, by a colour threshold, which is §7.1's warning about chroma
  bleeding, measured. 4:4:4 JPEG at quality 85 kept all of them at
  2.15 MB a frame, against 1.37 MB for 4:2:0 and 6.66 MB for PNG. That
  is the format to suggest for `colour-mapped` pictures where PNG's
  cost matters.
- **`mean` and `max` cost about the same to cut.** Packed or loose is
  a question of object count and upload time, not of cut time; packing
  added under 0.1 s a frame here.

**A finding about §7.1's Mercator rule.** Taking Mercator level *z* by
nearest neighbour from the lat/lon level of the same width, as §7.1
proposes, makes every Mercator level but the native one visibly blocky
toward the poles. A lat/lon row is 360/W degrees tall; a Mercator row
at latitude φ is cos φ of that, so each lat/lon row fills 1 ÷ cos φ
Mercator rows: 2 at 60°, 2.9 at 70°, 5.8 at 80° and 11.5 at 85°. At
level 2 of the drought set, Antarctica and Greenland show stair-steps
several pixels tall. At the native level that is honest, because the
source has no more rows; at coarser levels a finer lat/lon level does
have them. Choosing, per Mercator row, the coarsest lat/lon level whose
rows are no taller than that Mercator row would keep §7.1's rule (no
averaging across rows in the warp) without the blocks, at the cost of
sampling columns from a finer level than the row's width. That is a
choice for D3a, recorded here so the rule is not built as written
without it.

**Settles.** §5.8's table (counts confirmed; the bytes row needs the
native-level factor); D3a's sizing, except upload time. **Still open:**
R2 upload time, loose against packed, with the scratch bucket.

---

## 4. Kits

Pending.
