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

**Question.** What time does each client put in a tile request, and
does the server's snap-down rule (§5.3) give it the frame it means
(§11 q4)?

**Method.** Time-enabled layers on the prototype server, whose log
records the time each request asked for and the frame it was given:
the drought set (weekly at 00:00Z), and date-card layers on the time
axes of §1.1. QGIS was driven through its temporal controller's map
settings, with a fresh URL space for every request, because its tile
cache is keyed by URL and otherwise hides repeated times. CesiumJS was
given a `TimeIntervalCollection` built from the layer's
`start/end/period`, the way its own GIBS example builds one, and its
clock was set to times on and off the frames.

**What was measured.**

| Client | What it sends | Notes |
|---|---|---|
| GDAL WMTS | The dimension's `Default`, verbatim | No way to choose another time; `.000Z` passed through when the `Default` had it |
| QGIS 3.34, WMTS | The **start** of the temporal range, verbatim, as KVP `Time=`, without milliseconds | The same whichever interval-handling method is set; a week starting 28 September asked for `2026-09-28T00:00:00Z` and the server snapped it to the frame of 24 September, correctly |
| QGIS 3.34, WMS-T | The start of the range, as `TIME=` | Needs the layer built as QGIS's source dialog builds it (`type=wmst`) |
| CesiumJS 1.146 | The **start of the interval containing its clock**, so it snaps for itself | The colon is sent as `%3A`; a clock outside every interval sends a literal `{Time}` |
| MapLibre, Leaflet | Whatever is baked into the template | No time support |

Every off-frame time QGIS sent was answered with the frame whose
period contains it, as §5.3 intends.

**One case the rule cannot fix: frames stamped mid-period.** SOS 643's
daily frames are stamped 12:00Z.
- QGIS stepping a day at a time sends midnight, which snaps down to
  the *previous* day's noon frame: 2008-02-29 shows 28 February.
- CesiumJS, with intervals that start at noon, does the same for any
  clock before noon. It asks for the exact frame time, so no rule on
  the server can change its choice.

Only the advertised time can. If each frame were advertised at the
start of the period it represents (00:00Z for a frame that stands for
a day), both clients would land on the right day. That needs the
dataset's represented time, which the catalog does not hold for
legacy rows (`docs/metadata/PHASE0_IMPLEMENTATION.md` step 2,
"represented time"), so it is a decision, not a fix.

Prefetching of the next interval by CesiumJS, which §7.5 records, was
not observed with its clock paused, and was not tested animating.

**The answer.** §5.3's snap-down rule is needed, because QGIS sends
the start of its range verbatim and that is rarely a frame time, and
for every regular series tested it is enough. CesiumJS snaps for
itself and needs nothing from the server but a correct time list.
Daily frames stamped at noon are the exception: two of the three
clients that animate show the wrong day for half of each day. That is
§11's q4 decision holding, with one new question added in §3.3.

**Settles.** q4 confirmed against QGIS, GDAL and CesiumJS, and §5.2's
`%3A` case confirmed (CesiumJS). **New:** how a frame stamped
mid-period is advertised (§3.3). **Still open:** ArcGIS's time slider
over WMS (§3.5) and OpenSpace's step (§3.9), both kits.

### 3.3 Do calendar periods and dates snap right?

**Question.** Is a monthly or yearly series requested on the 1st
answered with that month's or year's frame; are 12:00Z frames
requested by date alone answered with that day's; and does QGIS refuse
a capabilities document with milliseconds in its times (§5.2, §5.3,
§6.3)?

**Method.** Three passes:

- **Arithmetic.** The repository's own `frameTimestamp` and
  `findClosestFrameIndex` (`functions/api/v1/_lib/frames-manifest.ts`),
  run from a scratch script against calendar arithmetic, over the time
  axes of §1.1. Every frame's own date was requested at 00:00Z.
- **Clients.** QGIS and CesiumJS against date-card layers on the same
  axes.
- **Milliseconds.** Capabilities with `.000Z` in their times, as an
  interval and as a list of values, through QGIS's WMTS and WMS-T
  parsers.

**What was measured: arithmetic.** The number of requests, one on each
frame's own date at 00:00Z, answered with the wrong frame:

| Axis | Frames | Stamped on the wrong UTC date by `frameTimestamp` | Floor on average durations | Floor on calendar arithmetic (§5.3) | Date taken as an interval (§5.2) | Closest frame (`/frames?at=`) |
|---|---|---|---|---|---|---|
| SOS 491, `P1M` from 2009-01-01 | 12 | 7 (up to 45 h out) | **10 wrong** | 0 | 0 | 0 |
| SOS 420, `P1Y` from 1850-01-01 | 175 | 62 (up to 26 h out) | **116 wrong** | 0 | 0 | 0 |
| SSP rows, `P1Y` from 2015-12-31 | 86 | 85 (on 30 December, 33 h out by 2100) | 0 | 0 | 0 | 0 |
| SOS 643, `P1D` from 2001-01-01T12Z | 5,449 | 0 | **all wrong** | **all wrong** | 0 | 0 |
| Drought, `P7D` | 51 | 0 | 0 | 0 | 0 | 0 |

The plan's yearly example is exact: a series starting 2001 answers 1
January 2002, 2003 and 2004 with the previous year's frame. One case it
does not mention is that a stamp can fall in the wrong calendar year.
Frame 4, which is 2005, is stamped `2004-12-31T23:16:48Z`, so a
`labels.txt` or a filename cut to the date would call it 2004.

**What was measured: clients.**

- **QGIS**, stepping by month from 1 January 2009, sent the 1st of each
  month at 00:00Z and got frames 0 to 11 in order. Floored on average
  months, ten of those twelve would have been wrong. Stepping by year
  from 1851 it got the right year each time.
- **CesiumJS** builds calendar intervals itself: a clock on 15 March
  2009 asked for the 1 March frame.
- **The prototype's parser** answered a bare date on the noon series
  (`2001-01-05`) with that day's noon frame. The same day written as a
  midnight date-time, in every spelling tried (`Z`, `%3A`, `.000Z`,
  `+00:00`), snapped to the day before.
- **Which year an SSP frame is.** On the SSP axis, `2050` selects the
  frame stamped 31 December 2050, and `2050-01-01` the one stamped 31
  December 2049.

**What was measured: milliseconds.**

| Parser | Times advertised | Result |
|---|---|---|
| QGIS WMTS | Interval, `start/end/period` with `.000Z` | Parsed (51 instants); requests carry no milliseconds |
| QGIS WMTS | List of values with `.000Z` | The layer loads with all 51 instants, then requests `Time=20260928`: ISO 8601's basic date, which the prototype, accepting only the extended form, answered with a 404 |
| QGIS WMTS | List of values without milliseconds | Parsed and requested correctly |
| QGIS WMS-T | Interval or list, with or without `.000Z` | Parsed (85 instants); `TIME` sent without milliseconds |

QGIS also turned out to **expand an interval into at most 1,000
instants**. At 1,001 or more it shows the layer as one undivided range.
Animating still works, because it sends a range start and the server
snaps, but the user sees no frame list. A list of values expands
whatever its length (5,449 for SOS 643). Clouds (4,314 frames) and SOS
643 would both collapse.

**The answer.**

- **Calendar arithmetic is required**, as §5.3 and §6.3 say, for the
  tile route and for `frameTimestamp`. The measured failure is worse
  than the plan's example: 116 of SOS 420's 175 years and 10 of SOS
  491's 12 months, every one on the 1st.
- **§5.2's reduced-precision rule is required, and works, for a date.**
  It does not help a client that sends a midnight date-time, which
  QGIS does. That is §3.2's question, how a frame stamped mid-period is
  advertised.
- **No milliseconds in advertised times stands, for a narrower
  reason.** QGIS's interval and WMS-T parsers take them. Its WMTS list
  parser loads them and then sends a basic-format date. The parser
  should also accept the basic format (`YYYYMMDD`, `YYYYMMDDTHHMMSSZ`),
  which is ISO 8601 and costs nothing.
- **An interval past 1,000 steps loses QGIS's frame list.** Advertising
  a list instead keeps it, at the cost of a capabilities document that
  grows with the series. That is GIBS's trade, which caps at 100 and
  offers `DescribeDomains`. D3b should choose, knowing the threshold.

**Found on the way, in the catalog.** SOS 420's `endTime`
(2024-12-01) is not on its `P1Y` grid, SOS 491's (2009-12-31) is not on
its `P1M` grid, and MPAS's is one period past its last frame. A route
that derived a frame count from `endTime` would disagree with the
frames. For uploaded frames the count is on record; for the legacy
rows it is not, and D6 will need one.

**Settles.** §5.3's calendar rule and §6.3's `frameTimestamp` defect
(confirmed and measured), §5.2's reduced-precision rule (needed, and
sufficient for dates), and the no-milliseconds rule (refined). **New
questions:** how a frame stamped mid-period is advertised (§3.2);
whether SSP frames stamped 31 December represent that year or the next,
a question for their producer; interval or list past 1,000 steps;
accepting basic-format times.

### 3.4 Do regional frames land in place, and does palette transparency survive?

**Question.** Does a regional dataset land on its box in each client;
does a pan across the antimeridian draw correctly; and does a palette
PNG's transparency, including partial alpha, survive GDAL's expansion
to four bands (§5.5, §7.3)?

**Method.** Three tests:

- **The regional box.** The RRFS frames, placed on the global grid by
  §5.5's rules and drawn by QGIS at the native level. 4,000 random
  points inside the box compared the colour and alpha drawn with the
  LUT entry of the code the probe puts there.
- **The antimeridian.** The test pattern's regional variant, a box
  from 150°E to 150°W, read by GDAL and QGIS. The global pattern
  panned across 180° in CesiumJS, MapLibre and Leaflet.
- **Transparency.** RRFS tiles, whose LUT fades in alpha (0, 5, 10, …)
  across its whole range, read by GDAL three ways: the PNG itself;
  `gdal_translate -expand rgba`; and the GDAL WMS XML with
  `BandsCount` 4, OpenSpace's path. Then QGIS's render.

**What was measured.**

- **The box lands in place.** In QGIS all 4,000 points match the LUT
  colour and alpha of the right code, 97 of them by the neighbouring
  source pixel. That is the native level's nearest-neighbour upsample
  (10,800 to 16,384 effective columns), not a shift.
- **A box that crosses the antimeridian is read as its complement.**
  GDAL and QGIS both take a `WGS84BoundingBox` from 150 to −150 as the
  300° from −150 to 150, and draw nothing right. GDAL's
  `EXTENDBEYONDDATELINE` option did not help, because it applies only
  to a `BoundingBox` in the set's own CRS. Declared from −180 to 180,
  the same layer read right in both (6 of 6 points). QGIS then draws
  the part east of 180° only in a view that includes −180, a property
  of QGIS rather than of the layer.
- **Panning across 180° works** in CesiumJS (187 of 187 sampled
  pixels right, across a view from 172°W to 178°E), MapLibre, and
  Leaflet, which asked for wrapped column indices 0–2 and 5–7 at zoom
  3.
- **GDAL's default `ZeroBlockHttpCodes` aborts a regional read.** With
  the WMS driver's default of 204 alone, `gdal_translate` of the RRFS
  layer failed at the first tile outside the box: `Unable to download
  block`, 404. With `204,404` it read the whole globe. The WMTS driver
  sets `204,404` for itself (`frmts/wmts/wmtsdataset.cpp`); the WMS and
  TMS XML does not.
- **Partial alpha survives.** GDAL reads the tile as one band with a
  256-entry colour table carrying the alpha. `-expand rgba` and the
  XML's `BandsCount` 4 both produced 48 distinct alpha values, equal to
  the LUT's for every pixel. QGIS drew all 607 sampled partial-alpha
  pixels at the LUT's alpha. Browsers decode `tRNS` natively and were
  not tested separately.

**One thing indexed PNG cannot say.** RRFS has no `dataMinLuma`, so
all 256 codes are values and the palette has no index left over for
"absent". Outside the model's box the prototype wrote index 0, which
is transparent, so the picture is right. But a GDAL or QGIS user who
reads the index, as §7.3 expects a careful client to, reads code 0
there: zero smoke where the model never ran. MPAS reserves codes 0–7,
so its index 0 is a true absence. A data-encoded row whose codes are
all values needs one of four answers:
- reserve a code when the frames are made;
- tile it as grey plus alpha, which drops the palette;
- serve absence as a separate mask;
- or say in the abstract and colour map that index 0 outside the box
  is not a measurement.

**The answer.**

- **Regional frames land in place** with §5.5's placement.
- **Declare an antimeridian-crossing layer's `WGS84BoundingBox` as −180
  to 180.** Its `TileMatrixSetLimits` and tiles still cover only the
  box, and the abstract states the real bounds. §5.5 covers the
  cutting; §5.7 should say this about the capabilities.
- **The GDAL XML must carry `ZeroBlockHttpCodes` of `204,404`**,
  confirmed: without it a regional layer cannot be read at all.
- **§7.3's indexed PNG keeps partial alpha** through GDAL's expansion
  and QGIS, confirmed.
- **New:** a data-encoded row with no reserved code has no way to say
  "absent" in an indexed tile; §7.3 should choose one of the four
  answers above.

**Settles.** §5.5 (placement confirmed), §5.7's `ZeroBlockHttpCodes`
(confirmed), §7.3's palette transparency (confirmed for GDAL and
QGIS). **New:** the antimeridian bounding box (§5.7) and absence in
an indexed tile (§7.3). **Still open:** ArcGIS and OpenSpace (kits).

### 3.5 Does ArcGIS stretch past the deepest level or go blank? (q2)

**Kit handed over** (§4, `arcgis/`, steps 2–4). Needs an ArcGIS
organisation, which this session does not have. The kit loads the
test pattern from the Mercator and lat/lon WMTS, in both the per-depth
and the shared-set forms, and zooms past each layer's deepest level.
For comparison, the other clients measured here behave this way at
the deepest level:
- QGIS, GDAL's TMS driver, CesiumJS, MapLibre (with `maxzoom` set) and
  Leaflet (with `maxNativeZoom` set) all stretch it (§3.1).
- QGIS and GDAL go blank under a shared set with limits.

**Unblocks it:** the scratch Worker serving the kit's addresses, and a
person in the test organisation.

### 3.6 Is Esri's "WGS 1984 Version 2" scheme the lat/lon layout? (q3)

**Partly answered by machine; the rest is in the ArcGIS kit (step 5).**

**Method.** The tile info Esri publishes for its own basemap in that
scheme, `World_Basemap_GCS_v2/VectorTileServer?f=json` on
`basemaps.arcgis.com`, read on 2026-11-08.

**What was measured.** The scheme as Esri publishes it:
- 512-pixel tiles, with the origin at (−180, 90) in `wkid` 4326;
- level 0 at 0.703125° a pixel, halving at each level;
- scales stated at 96 DPI: 295,828,763.80 at level 0.

**The answer.** The grid is the same as the plan's lat/lon layout,
one level apart. Esri's level *n* + 1 has our level *n*'s resolution,
origin and tile size, so its tiles are ours, tile for tile. Esri adds
a level 0 our layout lacks: one 512-pixel tile spanning 360°×360°,
whose lower half lies off the Earth. The scale denominators differ by
a constant 1.0583, the ratio of OGC's 0.28 mm pixel to Esri's 96 DPI,
which is why q3 said to compare resolutions. Whether Scene Viewer
matches a WMTS layer to that scheme with the levels shifted by one, or
needs a level 0 to exist, is the kit's question. This was a vector
tile service; a raster tile layer in the same scheme should be checked
in the kit too.

**Settles.** q3's arithmetic (yes, offset by one level); **still
open:** whether Scene Viewer accepts the layer.

### 3.7 Is WMS axis order right?

**Half run.** QGIS here; ArcGIS in the kit (§4, `arcgis/`, step 6).

**Method.** A WMS 1.3.0 stub serving the test pattern, read by QGIS in
`EPSG:4326` and `CRS:84` over an asymmetric box (120.4°W–60.2°W,
10.6°N–50.3°N). The stub's log records the `BBOX` as sent, and the
render was decoded at four points.

**What was measured.** QGIS sent `BBOX=10.6,-120.4,50.3,-60.2` for
`EPSG:4326` (latitude first) and `BBOX=-120.4,10.6,-60.2,50.3` for
`CRS:84` (longitude first). A server reading each by WMS 1.3's rule
drew every point right, four of four in both. QGIS used version 1.3.0
because the server offered it.

**The answer.** QGIS follows WMS 1.3's axis order exactly, so §5.9's
rule is the one to implement: swap for `EPSG:4326` in 1.3, never for
`CRS:84` or in 1.1.1. D4's test with a known asymmetric box is the
right test; this one is it in miniature.

**Settles.** §5.9's axis order, for QGIS. **Still open:** ArcGIS, and
version 1.1.1 (GDAL's default), which needs the Worker's WMS.

### 3.8 What does a `GetMap` cost? (q26)

**Not run yet: needs Cloudflare credentials.** The test is a
throwaway Worker that stitches and scales tiles from the cut pyramids
in R2, measured alone and under concurrency, reading Cloudflare's CPU
time and memory rather than elapsed time, on a free and a paid plan.
The pyramids it needs are cut (§3.15), and so is the WMS logic,
prototyped and checked against QGIS (§3.7). What it needs is a scratch
R2 bucket and the right to deploy a Worker on each plan tier. The same
Worker serves the kits' addresses, the redirect route of §3.11, and the
R2 upload timing §3.15 leaves open.

**One hypothesis already checked without credentials.** The brief
listed Wrangler 4 writing KV to local storage unless told `--remote`.
That is confirmed for Wrangler 4.153.0, the repository's minimum:
`wrangler kv key put --binding …` and `wrangler r2 object put …`, run
without `--remote`, printed `Resource location: local` and wrote to
`.wrangler/state/v3/` (Miniflare's store), touching nothing in the
account. Any D2–D4 runbook that seeds KV or R2 from the command line
must pass `--remote`.

**Unblocks it:** credentials for the scratch account(s), through the
session's credential flow.

### 3.9 What does a time step cost OpenSpace? Video variants and keyframes

**Question.** What do §6.1's variants weigh, and what does a keyframe
interval of 1 s cost against today's 6 s, in bytes, in quality, and in
the seek a time-synced OpenSpace step makes (§6.1's keyframe rule)?

**Method.** §6.1's encode settings with libx264:
- High@5.1, constant frame rate, no B-frames, `-sc_threshold 0`, BT.709
  conversion and tags, no audio;
- the catalog's own rate control: CRF 18 under a 25 Mbit/s cap at
  4096, CRF 20 under 8 at 2048, CRF 22 under 2 at 1024.

Two sources:
- the clouds slice, 1,008 frames at 30 fps;
- the drought set, 51 frames at 10 fps.

Quality is luma PSNR against the same frames converted the same way.
The seek is a proxy, not OpenSpace: the wall time for ffmpeg, in
software on four threads, to decode one exact frame after seeking to a
random time. Thirty targets per file. Seeking to a keyframe costs about
250 ms on its own, mostly process start, so that is the floor.

**What was measured.**

| File | Size | Rate | Keyframes (`ffprobe`) | Notes |
|---|---|---|---|---|
| Clouds `h264-4096`, 1 s GOP | 107.4 MB | 25.6 Mbit/s (at the cap) | Every 1.000 s | Luma PSNR 34.70 dB; 122 s to encode |
| Clouds `h264-4096`, 6 s GOP | 107.4 MB | 25.6 Mbit/s (at the cap) | Every 6.000 s | Luma PSNR 34.74 dB |
| Clouds `h264-4096`, no cap, 1 s / 6 s | 534.8 / 521.6 MB | 127 / 124 Mbit/s | — | The 1-second interval costs 2.5% |
| Clouds `h264-2048`, 1 s | 34.4 MB | 8.2 Mbit/s | Every second | — |
| Clouds `h264-1024`, 1 s | 8.6 MB | 2.0 Mbit/s | Every second | §6.1's 1.5–2 Mbit/s |
| Drought `h264-4096`, 1 s / 6 s / all-intra | 17.6 / 16.9 / 18.2 MB | 27.6 / 26.5 / 28.5 Mbit/s | As set | 5.1 s files: all-intra costs 3.5% over 1 s |
| Drought `h264-1024`, 1 s | 1.2 MB | 1.9 Mbit/s | Every second | — |
| Date-card `h264-4096` (for the OpenSpace kit), 1 s / 6 s | 52.7 / 52.3 MB | — | As set | — |

| File | Seek to a random frame: median | p90 | worst |
|---|---|---|---|
| Clouds 4096, 1 s GOP | 437 ms | 560 ms | 619 ms |
| Clouds 4096, 6 s GOP | 1,340 ms | 2,020 ms | 2,184 ms |
| Clouds 4096 uncapped, 1 s | 716 ms | 1,055 ms | 1,288 ms |
| Clouds 4096 uncapped, 6 s | 2,404 ms | 3,759 ms | 4,576 ms |

Every H.264 variant came out High@5.1, yuv420p, `tv` range, BT.709
throughout, at a constant frame rate.

**The answer.**

- **A 1-second keyframe interval costs almost nothing** at the
  catalog's cap: the same bytes, 0.05 dB of luma PSNR. Uncapped, it
  costs 2.5%.
- **It makes a random seek about five to six times cheaper.** Above
  the ~250 ms floor, the median was ~190 ms against ~1,090 ms at 6
  seconds, in line with decoding up to 30 frames against up to 180.
  §6.1's rule stands. On a dome stepping time faster than a second
  per step, the 6-second file would drop steps; the kit (§4,
  `openspace/`, steps 5–7) measures it on OpenSpace's own hardware
  decoder.
- **All-intra is worth offering for short series** whose frames share
  little, such as weekly composites, at a few percent more.
- **The 4096 picture is rate-capped, not quality-capped.** For noisy
  satellite infrared the uncapped encode at CRF 18 is five times the
  cap. A dome file at the cap is what the catalog already ships; a
  higher-rate variant for domes is a choice, not a need D1 found.

**Found on the way: §6.3's bounds give the nearest frame.** The kit's
time-mapped assets follow §6.3: bounds half a mean step outside the
first and last frames. Under OpenSpace's floor
(`modules/video/src/videoplayer.cpp`), the frame shown at clock *t* is
⌊(*t* − *t*₀ + P/2) ÷ P⌋. That is the **nearest** frame, which shows a
frame up to half a period before its own time, the behaviour §5.3
rejects for tiles. For a regular period, bounds on the first frame and
one period past the last give ⌊(*t* − *t*₀) ÷ P⌋, a snap down. For a
calendar period no linear mapping is exact: the half step avoids
showing the previous month on the 1st, but shows the next month from
mid-month. The kit's step 5 checks this on a dome; the choice is §11
q30.

**Settles.** §6.1's keyframe rule (confirmed, with its cost) and its
variant sizes. **Still open:** the time-step cost on OpenSpace's
hardware decoder, and q30.

### 3.10 Does OpenSpace's Folder mode read the dates right? (q10)

**Kit handed over** (§4, `openspace/`, step 8), with a finding from
OpenSpace's source that sharpens what the dome will look for.

**What the source says.** `TemporalTileProvider` in Folder mode reads
each filename with `std::get_time` and then formats the date it hands
to SPICE as `tm_year + 1900`, `tm_mon + 1`, **`tm_mday + 1`**
(`modules/globebrowsing/src/tileprovider/temporaltileprovider.cpp`,
`master`, read 2026-11-08). `tm_mday` is already the day of the month,
from 1 to 31, so every file is dated a day late. A file for the 31st is
handed to SPICE as day 32 of its month. Whether SPICE rolls that into
the 1st of the next month, refuses it, or does something else is what
the kit tests. The `%j` (day-of-year) branch does not add one.

**The kit.** 66 equirectangular date cards, each printing its own date
three times round the sphere, one a day at 00:00Z from 28 December 2025
to 3 March 2026, crossing three month ends and the end of a year. Their
names follow §6.3 (`d1datecards_YYYYmmdd_HHMMSS.png`). They arrive as a
zip through `UrlSynchronization` with an explicit `Filename`, as §6.4
specifies. The operator sets the clock to six dates either side of each
boundary and writes down the date the card shows.

**What it decides.**
- **If the source reading holds**, Folder mode's dates are a day late
  everywhere and possibly wrong at every month end.
- **For §6.3**, frames for Folder mode would then be named a day
  *early* to compensate, which would break the day OpenSpace fixes it.
- **The alternative** is time-mapped video or Prototyped tiles, which
  do not go through this code.

The maintainer should also consider reporting it upstream. That is
something for a person to send, and this phase sends nothing.

### 3.11 Do redirects survive a real session?

**Not run yet: needs the scratch Worker.** The kit is written (§4,
`redirect/`): a stable address that answers with a 302 to a
digest-named path on the same route, cacheable for 60 seconds, played
in a browser globe, Second Life and OpenSpace for longer than that,
with a loop, a seek, a reconnect and a `HEAD`.

**Found on the way.** The node's existing `/frames/{index}` route is a
live example of the pattern the plan rejects for files. It answers with
a 302 to `https://video.zyra-project.org/…/frames/sha256/<digest>.png`,
on the bucket's public domain, with `Cache-Control: public, max-age=60`.
That is a cross-origin second hop, the one §6.5 says sends
`Origin: null` and that §8's "off withdraws the bytes" cannot follow.
§8 already leaves the frames route outside the switches, so this is not
a defect in the plan. But it is the address a client would copy, and
D2a's files route should not be modelled on it.

### 3.12 Does an SOS site accept the directory? (q9)

**Kit handed over** (§4, `sos/`). The directory is built to the SOS
playlist reference (`sos.noaa.gov/support/sos/manuals/playlist-format/`,
read 2026-11-08). It holds:
- `playlist.sos` naming the movie, and `playlist_frames.sos` naming a
  folder of 51 frames, 2048×1024;
- `labels.txt` with one date per frame;
- the legend as a pip, at 10 fps.

Four colour squares of known value sit in both the movie and the
frames, so the site can compare SOS's decoding of the MPEG-4 movie with
its display of the frames. §6.1 says SOS's own colour matrix is
unknown.

**Measured here, for §6.1:**
- **ffmpeg labels the movie wrongly**, as §6.1 says: "Simple Profile",
  level 1, for a 2048×1024 stream, with no colour tags.
- **`-q:v 1` produced the same file as `-q:v 2`**, because ffmpeg's
  default `qmin` is 2. A quantiser of 1 needs `-qmin 1` as well.
- **The quantiser floor does not reach SOS's bitrate.** At `-q:v 2` the
  drought movie ran at 17.0 Mbit/s, under SOS's 25. The clouds movie
  ran at 58.5 Mbit/s, about 245 MB for 34 seconds. The floor gives the
  encoder's best quality; the bitrate it reaches is the content's. §6.1
  should say that 25 Mbit/s is SOS's guidance for difficult content,
  not something a quantiser floor guarantees. The SOS contact is the
  person to say whether a 17 Mbit/s movie at the encoder's best
  quantiser is acceptable.

### 3.13 Does a plain MP4 play on a Second Life sphere?

**Kit handed over** (§4, `secondlife/`). Two `h264-1024` files, both
High@5.1 with BT.709 tags, no audio and a 1-second keyframe interval:
- clouds: 1024×512, 30 fps, 33.6 s, 8.6 MB, about 2.0 Mbit/s;
- drought: 10 fps, 5.1 s, 1.2 MB.

Both are inside §6.1's 1.5–2 Mbit/s target. The checklist covers
Firestorm and Linden Lab's viewer, ten loops, walking out of media
range and back, and a second avatar.

### 3.14 Does Hub's DCAT feed list WMS or WMTS items? (q11)

**Kit handed over** (§4, `arcgis/`, step 8). Needs a Hub site in the
maintainer's organisation, with the WMS and WMTS registered as public
items, and the site's `/api/feed/dcat-us/1.1.json` read after indexing.

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

Each kit is a folder with a one-page checklist: what to load, the
exact steps, what to record, and what counts as a pass. They sit
outside the repository with the rest of D1's scratch, and the
maintainer hands them on; this phase sends nothing to anyone. Every
address in them reads `{{NODE}}` until the scratch Worker is deployed
(§3.8); a script replaces it, and the Worker serves the files and logs
every request, so a result can be matched to what the client actually
asked for.

| Kit | Who runs it | What it carries | Rows |
|---|---|---|---|
| `openspace/` | The OpenSpace collaborators, on a dome or a desktop | Eight assets: the test pattern at 512 and 256; drought tiles through time with `MaxConnections` 2 and 8 and `<Cache>` on and off, stepping 7 days and 1 day; RRFS tiles hourly; time-mapped `h264-4096` video at 1 s and 6 s keyframes, of clouds (for cost) and of date cards (for correctness); Folder-mode date cards across month ends; RRFS as palette-applied frames against grey frames with OpenSpace's own colormap | §3.1, §3.2, §3.9, §3.10, and §6.2's palette question |
| `arcgis/` | The maintainer's ArcGIS test organisation | The WMTS in each grid and depth form, the WMS, and a Hub step | §3.1 (q1), §3.5 (q2), §3.6 (q3), §3.7, §3.14 (q11), ArcGIS's time slider |
| `sos/` | An SOS site or the SOS team | A complete SOS directory: two playlists, frames, labels, legend, the `sos-mpeg4` movie, colour squares | §3.12 (q9), §6.1's colour matrix |
| `secondlife/` | The Second Life sphere | Two `h264-1024` MP4s | §3.13 |
| `redirect/` | The maintainer | A browser globe page, an OpenSpace asset, and `curl` checks against a 302 to a digest path | §3.11 |

Each kit's results come back as a short note: the version of the
client, what was recorded at each step, and any error text verbatim.
Each row above then moves from "kit handed over" to a result, and this
document's `Last reviewed:` line with it.
