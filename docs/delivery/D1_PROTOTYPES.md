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

To be completed as the tools are used.

---

## 3. Results by row

Each subsection is filled as its results arrive. Until then it reads
"pending".

### 3.1 Do the grids load, the right way up, at the right longitude?

Pending.

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

Pending.

---

## 4. Kits

Pending.
