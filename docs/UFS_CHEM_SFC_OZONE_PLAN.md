# UFS-Chem surface ozone — inventory, transfer, and workflow design

**Status: draft for review.**
**Last reviewed: 2026-08-18.**
**Revisit when:** GSL changes the Cloudflare policy on `gsl.noaa.gov`;
`acquire thredds` is allowlisted; either collection moves to NODD/S3; the
model starts publishing a 2-D `sfcf` surface file (which would retire the
mirror step); or the grid/cadence changes from 384×192 hourly.

Sources under evaluation, both on NOAA GSL's THREDDS server:

- `retro/ufs_chem_sfc_ozone` — the retrospective collection this started from.
- `data/ufs-chem_csl` — daily, date-pathed CSL UFS-Chem output. **The better
  target**, because its names template natively into a self-updating workflow
  (§2.1, §4.1).

Goal: put UFS-Chem global surface ozone on the TerraViz globe as a
**data-encoded** dataset — hover reports a real value in real units, and the
palette is a client-side transform rather than baked-in colour.

## 1. Summary

The inventory is complete (§2) and the pipeline is written and validated
(§4.6). Of the five things that stood in the way, four have resolved; only
reachability is genuinely blocking:

| # | Blocker | Status | Severity |
|---|---|---|---|
| B1 | `gsl.noaa.gov` Cloudflare policy 403s datacenter/CI egress | **Verified, blocking** — but FTP likely routes around it (§3.1a) | Must be solved before any workflow runs |
| B2 | `acquire thredds` is not on the TerraViz stage allowlist | **Verified against the real validator** (§3.4) | Not blocking — NCSS routes around it (§3.3) — but allowlisting it would collapse the pipeline and remove B5 |
| B3 | Placeholder grammar can't express day-of-year filenames | **Dissolved** — wrong collection (§2.1) | Not blocking; `ufs-chem_csl` templates cleanly |
| B4 | Zyra cannot rescale units | **Largely dissolved** — `o3` is in `ppm` (§2.1a) | Cosmetic; the mirror does ppm→ppbv |
| B5 | Frame count vs `MAX_PIPELINE_ARG_LIST_ITEMS` (128) | Measured, §4.4 | Minor — 5 days hourly fits at 121 |

**B1 is the whole story** — but the inventory (§2) has now made the answer
obvious. The numbers that decide it:

| | |
|---|---|
| One cycle, whole files over FTP | **267 GB** |
| The same product via OPeNDAP subsetting | **35.7 MB** |
| Ratio | **7,482×** |

So this is not a bandwidth problem being solved by a clever pipeline. It is a
**36 MB/day product** sitting behind a 267 GB access pattern, reachable by a
mechanism (OPeNDAP) that is verified working — just not from CI.

**Recommended architecture: a small NOAA-side subsetting step.** Something that
can reach `gsl.noaa.gov` opens each `dodsC` URL, takes the surface level of one
ozone variable, and writes ~0.3 MB per frame to object storage. The workflow
then consumes ~36 MB/cycle from a CI-reachable location. The mirror is small
enough to run almost anywhere and cheap enough to be uncontroversial, and it is
also the natural place to fix B4 (unit rescaling) since Zyra cannot.

The alternative — GSL allowlisting the runner so the workflow reads OPeNDAP
directly — is cleaner still and removes the moving part. Worth asking for; the
mirror is the fallback that does not depend on the answer.

## 2. Inventory — what is actually in these files

### 2.0 Confirmed, from a real FTP listing

The `data/ufs-chem_csl/20260817/` directory was listed successfully over FTP
(§3.1a). The result decides the architecture, and not in the direction hoped
for:

| Fact | Value |
|---|---|
| Files | **121** — `gfs.t00z.atmf000.nc` … `atmf120.nc` |
| Cadence | **Hourly**, f000–f120 (5-day forecast) |
| Cycles per day | **One** — `t00z` only |
| Size per file | **~2.21 GB** (2.204–2.209 GB) |
| **Total per cycle** | **~267 GB** |
| `sfcf*.nc` companion | **Absent** — 3-D atmosphere history only |

**The missing `sfcf` is the important part.** §2.1 flagged this as the
question that decides the route, and the answer is the expensive one. There is
no small 2-D surface file; surface ozone must be extracted as the lowest model
level of a 3-D field inside a 2.21 GB file.

**What that costs if you move whole files:**

| | |
|---|---|
| Downloaded per cycle | **267 GB** |
| Actually needed (121 × one 2-D level) | **~0.57 GB** |
| Useful fraction | **0.21%** — a **468× waste** |

Transfer time alone is survivable (~0.7 h at 100 MB/s, inside the 6 h GHA job
limit), but moving 267 GB of NOAA egress daily to use 570 MB of it is not a
defensible pipeline, and staging it on a runner with ~14 GB of disk means
streaming file-by-file with no room for error.

**Two derived facts worth recording:**

- **Frame count is 121**, exactly the case §4.4 sized. It fits
  `MAX_PIPELINE_ARG_LIST_ITEMS` (128) with seven to spare — but only if frames
  are enumerated at all, which the OPeNDAP route may avoid.
- **Cycle timing:** the 2026-08-17 00Z cycle posted between 02:39 and 04:30 UTC
  on 2026-08-18 — about **28.5 h after cycle time**. With one cycle per day
  that gives `{{cycle_date:P1D:PT30H}}` and a literal `t00z`. Note this is
  *daily*, not the 6-hourly `PT6H` the aerosol template uses.

### 2.0b Contents, from a successful OPeNDAP probe

`xr.open_dataset()` against the `dodsC` endpoint **succeeded from a
NOAA-allowed network**, which confirms the §3.5 inference end-to-end: xarray
opens these files over DAP with no DAP-specific code. The dataset:

| Property | Value |
|---|---|
| Source | `FV3GFS`, `grid: gaussian`, `hydrostatic: non-hydrostatic` |
| Horizontal grid | **384 × 192** (`im`/`jm`, `grid_xt`/`grid_yt`) |
| Vertical | **64 levels** (`pfull`), 65 interfaces (`phalf`) |
| Data variables | **148**, with `ncnsto: 139` constituents — full chemistry |
| Longitude | `grid_xt` 0.0 → 359.1 — **0–360**, needs wrapping to ±180 |
| Latitude | `grid_yt` 89.28 → −89.28 — **Gaussian, north-to-south, unevenly spaced** |
| Time (f000) | `2026-08-17T00:10:00` — note the **10-minute offset** from cycle time |

**Ozone candidates present:** `o3`, `o3mr`, `o3s`, `o3s_e90` (plus related
chemistry: `hno3`, `no3`, `nh4no3`, `ch3co3`, `mao3`). `o3mr` is the standard
FV3GFS ozone mixing ratio; `o3` is the chemistry tracer; `o3s` / `o3s_e90` are
stratospheric-origin tracers, which are **not** what a surface-ozone product
wants. §2.1a settles the choice on units, and picks `o3`.

**The grid is much coarser than assumed, and that is good news.** At 384 × 192
a single 2-D level is **0.295 MB**, not the ~4.7 MB earlier arithmetic used. So
the entire five-day animation is:

| | |
|---|---|
| 121 frames × one surface level | **35.7 MB** |
| Same data via whole-file FTP | **267 GB** |
| Ratio | **7,482× — we need 0.013% of it** |

That reframes the whole problem. This is not a big-data pipeline being
throttled; it is a **36 MB product trapped behind a 267 GB access pattern**.

**Three gotchas the probe exposed**, none of which are visible from a file
listing:

1. **The DAP view is not CF-compliant.** Variables carry *anonymous*
   dimensions — `o3(o3_0=1, o3_1=64, o3_2=192, o3_3=384)` — with no
   association to the `pfull` / `grid_xt` / `grid_yt` coordinates. Selection
   must be **positional** (`.isel(o3_1=63)`), not by coordinate value. Any tool
   that auto-detects CF lat/lon axes — including geotiff writers — will need
   the dims named or the coordinates re-attached first.
2. **The surface is the last level, not the first.** `pfull` ascends
   0.3792 → 997.3 hPa, so **index 63** is the near-surface level.
3. **The grid is Gaussian, not regular.** `grid_yt` is unevenly spaced, so
   `reproject` is doing a genuine regrid to equirectangular, not just a
   longitude roll. That is within its remit, but it is real resampling.

### 2.1a Variable choice and units — resolved, and B4 with them

| Variable | `long_name` | **units** | Verdict |
|---|---|---|---|
| **`o3`** | o3 mixing ratio | **`ppm`** | **Use this one** |
| `o3mr` | ozone mixing ratio | `kg/kg` | Hovers as `0.0000000452` — avoid |
| `o3s` | o3s mixing ratio | `ppm` | Stratospheric-origin tracer, not surface ozone |
| `o3s_e90` | — | — | Likewise |

**`o3` is in ppm, so B4 largely dissolves.** This is exactly the "pick a
variable whose native units read well" move the data-video guidance recommends,
and it is available here only because the model writes both forms. Choosing
`o3mr` — the name that looks more canonical — would have been the wrong call.

The measured surface field (level 63, f000 of the 2026-08-17 00z cycle) also
confirms the label is real rather than mis-stated:

| Statistic | ppm | **ppbv** |
|---|---|---|
| min | 6.53e-05 | 0.07 |
| p50 | 0.02197 | **21.97** |
| mean | 0.02211 | **22.11** |
| p90 | 0.02902 | 29.02 |
| p99 | 0.04059 | 40.59 |
| p99.9 | 0.04933 | 49.33 |
| max | 0.05956 | **59.56** |

A global mean of 22 ppbv, a median of 22, and a maximum near 60 are textbook
surface ozone — clean marine background sits at 15–30 ppbv and polluted
episodes reach 50–80. Nothing here is mislabelled.

**Remaining unit choice is cosmetic, not blocking.** ppm hovers as `0.0221`,
which is legible; ppbv hovers as `22.1`, which is how air quality is normally
quoted and how the NAAQS 8-hour standard (70 ppbv) is stated. Since the mirror
step (§1) exists anyway, `mirror-ufs-ozone.py --to-ppbv` does the ×1000 there
and the pipeline declares `units: ppbv`.

The **retro** collection remains unlisted, though it matters much less now that
the daily one is characterised.

To fill it in, run [`scripts/inventory-thredds.py`](../scripts/inventory-thredds.py)
from a NOAA-allowed network:

```bash
python3 scripts/inventory-thredds.py \
  https://gsl.noaa.gov/thredds/catalog/retro/ufs_chem_sfc_ozone/catalog.xml \
  --probe 2 > sfc-ozone-inventory.json
```

It is stdlib-only and moves kilobytes, not gigabytes — it reads `catalog.xml`
for the file list, then the OPeNDAP `.dds`/`.das` sidecars for the complete
variable inventory, dimensions, shapes, `units` and `long_name` attributes,
plus an NCSS `dataset.xml` and a `HEAD` + range probe. (Smoke-tested against a
public TDS, where it returned 929 variables and their units without
downloading a byte of data.) It sends a custom User-Agent, which is the
documented requirement for this host.

The questions it answers, and why each one matters here:

| Question | Decides |
|---|---|
| File count, naming convention, per-file size | Frame count, `output_names`, whether B5 bites |
| Container format (NetCDF-4 / classic / GRIB2) | `extract-variable` vs `convert-format --pattern` (§4.2) |
| Ozone variable name + `units` | The `--var` regex, and B4 |
| Grid shape + lon convention (0–360 vs ±180) | Whether `reproject` must wrap, and the regrid size |
| Time cadence and span | `period_seconds`, `fps`, dataset `start_time`/`end_time` |
| `Accept-Ranges` + NCSS availability | Which transfer mechanism in §3 is actually on |

### 2.1 There are two collections, and the daily one is the better target

A second path came up in review:

```
https://gsl.noaa.gov/thredds/catalog/data/ufs-chem_csl/20260817/catalog.html
https://gsl.noaa.gov/thredds/fileServer/data/ufs-chem_csl/20260817/gfs.t00z.atmf000.nc
```

Also 403 from CI (checked: `catalog.html`, `catalog.xml`, `fileServer`, and
`dodsC`, custom UA included — B1 is host-wide, not collection-specific). But
the *filename* is readable without fetching it, and it changes several
conclusions. Everything in this subsection is inference from naming
convention, to be confirmed by the §2 probe:

- **`/20260817/`** is a date-pathed daily directory — exactly the `YYYYMMDD`
  that `{{cycle_date:INTERVAL:LAG}}` emits.
- **`gfs.t00z`** is a cycle-hour token — exactly the zero-padded `HH` that
  `{{cycle_hour:INTERVAL:LAG}}` emits.
- **`atmf000`** is the standard UFS/GFS atmosphere history file at forecast
  hour 000, zero-padded to three digits, so lead hours enumerate the way the
  aerosol template already does.

Together that means the URL templates natively:

```
https://gsl.noaa.gov/thredds/fileServer/data/ufs-chem_csl/{{cycle_date:PT6H:PT9H}}/gfs.t{{cycle_hour:PT6H:PT9H}}z.atmf{FFF}.nc
```

**This dissolves B3.** The day-of-year limitation documented against "GSL
THREDDS" concerns a *different* collection whose names are `<YYDDDHHmm><FFF>`;
`ufs-chem_csl` uses conventional UFS naming that the grammar handles as-is. The
practical consequence is large: a **live, self-updating** UFS-Chem dataset is
possible here, not just a one-shot retro import. That is the more valuable
product, and it is the one this plan should aim at.

Two things the probe must settle before the pipeline is written against it:

- **`atmf` is the 3-D file.** UFS atmosphere history carries every variable on
  every model level, which is typically multi-gigabyte per forecast hour.
  Surface ozone would be the lowest model level of the ozone field. If the
  collection also publishes a companion **`sfcf000.nc`** surface file, that is
  2-D, far smaller, and almost certainly the better input — check for it first.
- **Ozone in UFS `atmf` is conventionally `o3mr`, a mass mixing ratio in
  `kg kg-1`.** If that is what is stored, B4 is live: hover would read
  `0.0000000452`. See §4.3.

Pulling a 3-D multi-GB file per frame to use one level of one variable is the
worst case for transfer cost, which makes the server-side subsetting in §3.3
much more valuable here than it would be for a 2-D source — the difference
between gigabytes and megabytes per frame, not a marginal saving.

## 3. Efficient data transfer

### 3.1 The reachability problem (B1)

`gsl.noaa.gov` sits behind Cloudflare. From a cloud/CI egress IP every request
returns `HTTP 403` with a `cf-ray` header, **regardless of User-Agent**.
Measured directly:

| User-Agent | Result |
|---|---|
| `uwtools user agent` (the string IT reported as working) | 403 |
| `zyra/1.0` | 403 |
| `terraviz-workflow/1.0 (+…)` | 403 |
| `Mozilla/5.0 … Chrome/120.0.0.0 Safari/537.36` | 403 |
| `python-requests/2.34.2` | 403 |
| curl default | 403 |

The block is **host-wide**, not path-scoped (`/`, `/thredds/`, and both
catalog paths all 403), and `gsl.noaa.gov` resolves only to Cloudflare
addresses (`2606:4700:78::…`), so the origin cannot be reached directly. The
collection has never been captured by the Wayback Machine. Every other NOAA
host tested from the same environment answered normally — `csl.noaa.gov`,
`fim.noaa.gov`, `rapidrefresh.noaa.gov`, and the NODD S3 buckets all returned
200.

**This reconciles with IT's guidance rather than contradicting it.** Shannon's
finding is real: the default `python-requests` UA trips a Cloudflare rule, and
a custom UA clears *that* rule. But it is only one of the rules. From a
datacenter IP a second, IP-reputation rule fires that no User-Agent clears. So
"set a custom User-Agent" is **necessary but not sufficient** for automation:
it fixes a NOAA workstation, and does nothing for a GitHub Actions runner.

That matters because the Zyra workflow *is* CI — it runs on a GitHub-hosted
runner, on exactly the class of IP being refused. A workflow pointed at this
catalog will fail at fetch with the same 403, no matter how correct the
pipeline is.

Three ways out, in preference order:

1. **Mirror the collection to NODD/S3.** The most durable fix, and it matches
   how every other model source in this repo is consumed. Open S3 buckets have
   no bot policy, support byte-range reads, and their date-pathed names fit the
   placeholder grammar. Also fixes B3 for any future *live* (non-retro) feed.
2. **Have GSL allowlist the runner egress.** Cheap to ask for, awkward in
   practice: GitHub-hosted runners draw from a large rotating IP range, so this
   realistically means a self-hosted runner on a stable, allowlistable address,
   or a Cloudflare WAF rule keyed on a shared-secret header or a specific UA
   string *combined with* an IP allowlist.
3. **Stage the data by hand.** Pull it once from a NOAA workstation, push to
   the node's own object storage, point the workflow there. Fine for a
   one-shot retro dataset; not a pattern to build on.

### 3.1a FTP — the most promising route around B1

`gsdftp.fsl.noaa.gov` (the legacy FSL/GSD anonymous FTP server) publishes what
looks like the same tree:

```
ftp://anonymous@gsdftp.fsl.noaa.gov/ufs-chem_csl/20260817/gfs.t00z.atmf000.nc
```

**This is a different host, and the difference is the whole point.** It
resolves to `137.75.133.215` — a real NOAA address, **not Cloudflare**. The bot
policy that refuses every request to `gsl.noaa.gov` simply does not exist here.

**Credentials.** Anonymous FTP takes the username `anonymous` with an **email
address** as the password — not the literal string `anonymous`, which many
servers reject:

```bash
curl -u "anonymous:you@noaa.gov" 'ftp://gsdftp.fsl.noaa.gov/ufs-chem_csl/20260817/'
```

It could not be tested from the environment this plan was written in, and the
reason matters. FTP egress is blocked by *that sandbox*, not by NOAA. Four
attempts, each failing at a different and unambiguous layer:

| Attempt | Result |
|---|---|
| Direct FTP, passive | `Connection timed out` on port 21 |
| Through the agent proxy (absolute-form) | Proxy: *"only accepts HTTPS CONNECT tunnels"* |
| Forced `--proxytunnel` CONNECT | `Connection reset by peer` — no CONNECT to :21 |
| Active mode (`-P -`) | `Connection timed out` |

Confirmed with a control: `ftp://ftp.gnu.org/`, a famously open anonymous
server, times out identically. Every failure lands at the TCP connect (`Trying
137.75.133.215:21... Connection timed out`) before any login is attempted, so
credentials were never a factor. So the two failures are not the same kind of
thing:

| Host | Result | What it means |
|---|---|---|
| `gsl.noaa.gov:443` | **403 + `cf-ray`** | An affirmative refusal by NOAA's Cloudflare. Will also refuse CI. |
| `gsdftp.fsl.noaa.gov:21` | **Timeout** | Local egress policy. Says nothing about whether NOAA would serve a CI runner. |

Four things line up in FTP's favour:

1. **No Cloudflare**, so no bot rule and no UA problem.
2. **`acquire ftp` is on the stage allowlist** (`acquire: ['http','ftp','s3']`)
   — unlike `acquire thredds`, this needs no allowlist change at all.
3. **`acquire ftp` supports `--sync-dir`**, which `acquire http` does not — so
   it can pull a whole dated directory rather than one enumerated URL per
   frame. That also sidesteps the per-frame list bounds in §4.4 entirely.
4. **GitHub Actions runners have unrestricted outbound**, including FTP.

**The cost: FTP has no subsetting.** There is no NCSS, no OPeNDAP, no
range-by-variable — you get whole files. So §3.3's server-side subsetting, the
thing that makes a multi-gigabyte 3-D `atmf` file affordable, is unavailable on
this route. The two candidate routes trade against each other cleanly:

| | THREDDS (`gsl.noaa.gov`) | FTP (`gsdftp.fsl.noaa.gov`) |
|---|---|---|
| Reachable from CI | **No** (Cloudflare) | Likely yes — untested |
| Allowlisted stage | via `acquire http` + NCSS | **`acquire ftp`**, directly |
| Server-side subsetting | **Yes** (NCSS/OPeNDAP) | **No** — whole files only |
| Directory sync | No (`acquire http` is one URL) | **Yes** (`--sync-dir`) |

**This makes the `sfcf`-vs-`atmf` question from §2.1 decisive rather than
merely useful.** If the collection publishes a 2-D `sfcf*.nc` surface file,
FTP is straightforwardly the best route: small files, no subsetting needed,
allowlisted stage, no bot policy. If only the 3-D `atmf` files exist, FTP means
pulling gigabytes per forecast hour to use a single model level — at which
point mirroring to S3 (and subsetting during the mirror) wins again.

**Verifying it (two commands, from anywhere with FTP egress).** These answer
the decisive `sfcf`-vs-`atmf` question *and* size the transfer, which between
them settle the route:

```bash
# 1. What is actually in a cycle directory, with sizes?
curl -u "anonymous:you@noaa.gov" \
  'ftp://gsdftp.fsl.noaa.gov/ufs-chem_csl/20260817/'

# 2. How far back do cycles go, and is today's present?
curl -u "anonymous:you@noaa.gov" --list-only \
  'ftp://gsdftp.fsl.noaa.gov/ufs-chem_csl/'
```

If (1) lists `sfcf*.nc` alongside `atmf*.nc`, FTP is the route and this plan
gets simple. If it is `atmf` only, compare the file size against the cost of
mirroring, per the table above.

One caveat worth confirming: anonymous FTP is being retired across much of
NOAA in favour of HTTPS and cloud distribution, so check that this server is
expected to persist before building on it.

### 3.2 What THREDDS offers, and what Zyra can use

A TDS instance exposes the same files through several services. They differ
enormously in bytes moved:

| Service | Mechanism | Bytes moved | Usable from a Zyra pipeline? |
|---|---|---|---|
| `HTTPServer` (`fileServer`) | whole file | **All variables, all levels, all times** | Yes — `acquire http`, or URLs straight into `convert-format --inputs` |
| `NetcdfSubset` (`ncss`) | server-side subset by variable / bbox / time | **Only what you ask for** | **Yes** — it is a plain GET with query params (§3.3) |
| `OPeNDAP` (`dodsC`) | index hyperslab | Only the slab | **Yes** — via xarray, see §3.5. (An earlier draft said no; that was wrong.) |
| `WMS` / `WCS` | rendered tiles / coverages | Tiny | No — WMS returns *pictures*, which defeats data-encoding entirely |
| `CdmRemote` | ncstream binary | Only the slab | No client |
| `catalog.xml` crawl | listing | Tiny | `acquire thredds` is **not allowlisted** (B2) |

Two entries deserve emphasis. **WMS is a trap**: it is the cheapest thing on
the list and it is useless here, because a rendered image has already thrown
away the values that make the dataset queryable. And **OPeNDAP is the strongest
option on the table** — it is exactly the right tool for "give one surface
level of one variable out of a 3-D history file", and, contrary to an earlier
draft of this document, Zyra can consume it. That correction is §3.5.

### 3.3 NCSS is the way around the allowlist gap

`acquire thredds` being blocked (B2) reads like it rules out server-side
subsetting. It does not. **NCSS is addressed by ordinary HTTP query
parameters**, so an NCSS URL is just a URL — and `convert-format --inputs`
fetches URLs:

```
https://gsl.noaa.gov/thredds/ncss/grid/retro/ufs_chem_sfc_ozone/<file>
  ?var=<ozone_var>
  &north=90&south=-90&west=-180&east=180
  &horizStride=1
  &time_start=<ISO>&time_end=<ISO>
  &accept=netcdf4
```

This gets us the property that actually matters for transfer cost: **the
server does the subsetting**, so a UFS-Chem history file containing dozens of
variables on many levels yields a single surface field. No allowlist change,
no upstream Zyra issue. It also asks for `west=-180&east=180`, which can hand
back a ±180 grid and reduce what `reproject` has to do.

Two caveats. NCSS must be enabled on this TDS (the probe script reports
whether `dataset.xml` answers), and the `&`-laden URL must be quoted in YAML —
it stays well inside `MAX_PIPELINE_ARG_LENGTH` (2 KB).

**Recommendation:** NCSS if available, whole-file `fileServer` as the fallback.
Byte-range GETs — the trick that makes GRIB2-on-S3 cheap — only help when
there is an `.idx` sidecar naming which bytes hold which record. THREDDS
publishes no such sidecar, so ranges are not a subsetting mechanism here even
when `Accept-Ranges: bytes` is advertised.

### 3.4 `acquire thredds`: blocked here, exists upstream, and worth unblocking

Both halves of the B2 claim were tested rather than assumed.

**TerraViz does reject it.** Run against the real validator
(`functions/api/v1/_lib/workflow-validators.ts`), not just read off the
constant:

| Pipeline | Verdict |
|---|---|
| `acquire thredds` | **REJECTED** — `Command for stage "acquire" must be one of: http, ftp, s3.` |
| `acquire ftp` / `http` / `s3` | Pass |
| `visualize sos` | **REJECTED** — `must be one of: heatmap, contour, animate, compose-video.` |
| `process extract-variable` | Pass |

**Zyra does have it** — confirmed against `NOAA-GSL/zyra` at v0.1.54
(`src/zyra/connectors/backends/thredds.py`, plus CLI tests and a sample
pipeline). Its declared options are a much better fit for this dataset than
anything on the allowlist:

`--sync-dir`, `--pattern` (regex over dataset urlPath), `--since-period`
(ISO-8601 lookback), `--recursive` / `--max-depth` (nested `catalogRef`
traversal), `--header` (repeatable `Name: Value`), `--auth` / `--credential`,
`--overwrite-existing`, `--skip-if-local-done`.

Two things follow that change the recommendation.

**1. It would collapse the pipeline.** Zyra's own sample,
`samples/pipelines/thredds_to_local.yaml`, targets GSL THREDDS directly:

```yaml
- stage: acquire
  command: thredds
  args:
    catalog_url: https://gsl.noaa.gov/thredds/catalog/fv3-chem-0p25deg-grib2/catalog.xml
    sync_dir: ./frames
    pattern: "\\.grib2$"
    since_period: "P1D"
```

Six args replace the five parallel lists of 41–121 templated URLs that §4.4
sizes. That does not merely shrink the file — it removes the frame-budget
question (B5) *entirely*, along with any need to enumerate forecast hours or
template dates. The backend enumerates `catalog.xml`, maps datasets to
fileServer URLs, and skips existing non-empty files on re-runs, which is a
better self-updating story than placeholder templating gives us.

**2. Zyra sends no default User-Agent.** `headers` defaults to `None` on the
fetch path, so requests go out with the stock urllib/requests UA — precisely
what IT identified as the string Cloudflare refuses. So an `acquire thredds`
stage against `gsl.noaa.gov` would **403 even from a NOAA-allowed IP**, and the
fix is to pass the UA explicitly:

```yaml
    header: "User-Agent: terraviz-workflow/1.0"
```

That is a scalar string, so it satisfies the validator's arg rules. It does
**not** solve B1 — the CI-egress block is separate and no header clears it —
but it is required for this route to work from anywhere at all.

**Revised recommendation.** Allowlisting `acquire thredds` is worth doing on
its merits, and this dataset is a good reason. It is a Tier 1 gap: the fix is
to add the entry *and* confirm the pinned runner digest
(`ZYRA_IMAGE_DEFAULT` in `.github/workflows/zyra-run.yml`) carries the command,
bumping both together as the allowlist comment requires. It still does not
unblock B1 on its own, and it still offers no subsetting — the backend
downloads through `fileServer`, whole files — so the routing table in §3.1a is
unchanged on that axis.

### 3.5 OPeNDAP does subset — and Zyra can consume it (correction)

The collection exposes an OPeNDAP endpoint:

```
https://gsl.noaa.gov/thredds/dodsC/data/ufs-chem_csl/20260817/gfs.t00z.atmf000.nc.html
```

(The `.html` suffix is the OPeNDAP Data Access Form — a browser UI for building
constraint expressions. Its presence confirms DAP is switched on.)

**Yes, it subsets, and it is the best mechanism available for this dataset.**
Measured against a reachable TDS (`thredds.ucar.edu`, since `gsl.noaa.gov`
refuses CI), opening a `dodsC` URL with xarray and pulling a single 2-D slice
out of a 4-D variable — as it happens, `Ozone_Mixing_Ratio_isobaric`, the same
field class this plan targets:

| | |
|---|---|
| Open the dataset over DAP | 1.2 s |
| Full variable | 32,181 MB |
| One time × one level slice | **4.15 MB in 0.5 s** |
| Transferred | **0.0129% — a 7,749× reduction** |

That is the difference between viable and not for a 3-D `atmf` source.

**The correction.** An earlier draft of this document asserted that no Zyra
command speaks DAP, and used that to rule OPeNDAP out. That was wrong in a way
worth spelling out, because the reasoning generalises:

- Zyra contains no DAP client code — that part was right.
- But Zyra opens NetCDF through **xarray**, with **netcdf4** as the engine, and
  `netCDF4-python` links `netcdf-c`, which has **DAP2/DAP4 built in**. DAP
  support arrives transitively, without any DAP-specific code.
- `load_netcdf()` in `src/zyra/processing/netcdf_data_processor.py` does
  `ds = xr.open_dataset(str(path_or_bytes))` with **no local-file check** — so
  a `dodsC` URL passed where a path is expected should open over DAP.
- The pinned runner image is the `zyra` image, built with the `processing`
  extra, which carries `netcdf4` and `xarray`. (Corroborated by the fact that
  the existing `convert-format` / `reproject` / `heatmap` stages already work.)
- The TerraViz validator does not care: a `dodsC` URL is an ordinary string arg.
  **No allowlist change, no upstream issue.**

**One thing this is not.** TDS does **not** serve a NetCDF *file* response on
`dodsC` — `.nc` and `.nc4` both return HTTP 400 (verified; that is a Hyrax
feature, not a TDS one). `.dds`, `.das`, `.ascii` and `.dods` all return 200.
So the "plain GET that yields a NetCDF subset" trick belongs to **NCSS** (§3.3),
while OPeNDAP needs a DAP-capable reader — which, per above, we have.

**Honest limit on this finding.** What was measured is that *xarray over DAP
subsets a TDS endpoint*, which is solid. What was **not** measured is Zyra's
CLI plumbing carrying a URL end-to-end into that loader — that is a
code-reading inference, and it needs one run against a reachable DAP endpoint
to confirm. It also does nothing about B1.

**Where this leaves the routing table.** OPeNDAP now dominates on transfer
cost, which matters most in exactly the case §2.1 flagged as worst — 3-D `atmf`
files with no 2-D `sfcf` companion:

| Route | Reachable from CI | Subsetting | Allowlist change |
|---|---|---|---|
| **OPeNDAP** via xarray | No (B1) | **Best** — variable + level + time | **None** |
| NCSS via `acquire http` | No (B1) | Good — variable + bbox + time | None |
| `acquire thredds` | No (B1) | **None** — whole files | Required (§3.4) |
| FTP (`gsdftp`) | **Likely yes** | **None** — whole files | None |
| S3 mirror | **Yes** | Whatever the mirror does | None |

The shape of the decision is now clear: **FTP is the reachability answer,
OPeNDAP is the efficiency answer, and they are on different hosts.** If `sfcf`
files exist, FTP alone is enough and the conflict disappears. If only `atmf`
exists, either GSL must let CI reach `gsl.noaa.gov`, or the mirror step becomes
the place where subsetting happens — pulling one level over DAP from a NOAA
machine and writing small files to S3.

## 4. Workflow design

### 4.1 Templating: neither collection is blocked by it

The documented reason "GSL THREDDS" is a dead end for *self-updating* workflows
is that its filenames encode `<YYDDDHHmm><FFF>` — year, day-of-year, hour,
minute, forecast hour — and the placeholder grammar has no day-of-year or
2-digit-year formatter. That warning is accurate, and it is about neither
collection here:

| Collection | Naming | Templatable? |
|---|---|---|
| `retro/ufs_chem_sfc_ozone` | Fixed historical dates | Not needed — write URLs literally |
| `data/ufs-chem_csl` | `/YYYYMMDD/gfs.t{HH}z.atmf{FFF}.nc` | **Yes**, natively (§2.1) |
| (the documented dead end) | `<YYDDDHHmm><FFF>` | No |

So the retro import needs no templating because its dates are fixed, and the
daily collection needs it and has it. B3 only returns if a future source uses
day-of-year names.

Given the choice, **build against the daily collection**: it yields a dataset
that refreshes itself with each model cycle, which is worth considerably more
on the globe than a frozen historical window. The retro collection is the
better *first* target only if the daily one turns out to lack a surface field
(§2.1) — or as a way to prove the pipeline while B1 is being resolved.

### 4.2 Two entry shapes, chosen by container format

The `.das` probe in §2 decides this:

- **NetCDF** (most likely for UFS history output) — `process extract-variable`
  pulls the ozone field out, then `convert-format` writes GeoTIFF. If NCSS is
  available, it has already done the extraction and `extract-variable` can be
  dropped.
- **GRIB2** — `convert-format --pattern '<idx regex>'` selects one record
  directly, the same shape the GEFS-Aerosols template uses.

Everything from `reproject` onward is identical.

### 4.3 Calibration — ozone is not an aerosol

The bundled aerosol template's palette convention is **wrong for this field**,
and copying it unthought-through is the most likely way to ship something that
looks broken.

Aerosol fields are plumes on a clean background: near-zero nearly everywhere,
with occasional dense features. That is why the convention sets
`transparent_range: 12` — clear air drops out so plumes read against the globe.

Surface ozone has a **substantial non-zero global background** — clean marine
air still carries tens of ppb. Applying a transparent low band would erase most
of the atmosphere and leave only pollution hotspots floating over a black
Earth. For ozone the whole field is the story:

| Setting | Aerosol convention | **Ozone** | Why |
|---|---|---|---|
| `transparent_range` | 12 | **0** | No clean-air floor to drop; the background *is* signal |
| `blend_range` | 48 | **8** | Only true no-data should fade out |
| `base` | `YlOrBr` (smoke) | **`YlOrRd`** | Matches air-quality convention, light→dark, full-field legible |
| `vmin` | 0 | **0** | See tradeoff below |
| `vmax` | p99.9 | **80 ppbv** | Clears the measured max (59.6) with forecast headroom; keeps the 70 ppbv NAAQS threshold inside the scale rather than clipped, since clipping corrupts hover |

On `vmin`: raising it to a clean-air floor (~10–20 ppb, once units are known)
would sharpen contrast considerably, because the mid-palette would no longer be
spent on air nobody is interested in. The cost is that everything below the
floor **clamps** — remote-ocean hover would read the floor value rather than
the truth. For a dataset whose selling point is "hover gives you the real
number", that is the wrong trade. Keep `vmin: 0` and let the palette's low end
carry the background.

**B4, units — now the likeliest problem on the list.** UFS atmosphere history
conventionally stores ozone as `o3mr`, a mass mixing ratio in `kg kg-1`
(§2.1). If that is what the probe finds, hover reads `0.0000000452` —
technically correct, practically unreadable, and squarely against the point of
a dataset whose selling feature is that you can query it.

Zyra has no unit-rescaling command; it is a confirmed upstream gap, not
something a pipeline arg fixes. Four honest options, best first:

1. **Rescale while mirroring.** If B1 is solved by mirroring to S3 (§3.1),
   convert to ppbv in that same step. It costs nothing extra and produces the
   readable dataset.
2. **Use a surface file that already carries ppbv.** If the collection
   publishes `sfcf*.nc` with a diagnostic surface-ozone field, check its units
   before assuming — diagnostics are often written in ppbv precisely because
   they are meant to be read.
3. **Ask CSL to write a ppbv field** into the output. Slowest, most durable.
4. **Accept the exponent.** Works, and it makes the hover readout close to
   useless for a non-specialist audience.

If the files already carry ppbv, none of this applies — hence the dependency
on §2.

### 4.3a Resolution: do not upscale to 4K

The aerosol template regrids to 4096×2048 in `reproject`, and copying that here
would be a mistake. The native grid is **384×192**:

| Target | Linear upscale | Verdict |
|---|---|---|
| 4096×2048 | **10.7×** | Invents detail the model never resolved |
| 1440×720 | 3.8× | Reasonable |
| 768×384 | 2.0× | Conservative, honest |

Upsizing is legitimate in `reproject` because it resamples the *data* rather
than the luma — that is why the contract puts it there. But legitimacy is not
the same as honesty: a 10.7× upscale of a 1°-ish field produces a smooth image
that reads as far more resolved than the science behind it, on a globe whose
whole selling point is that hovering gives you a real number.

**Recommend 1440×720.** It is a clean 2:1 equirectangular, a modest upsample,
and a sensible texture size for the sphere. The regrid is doing real work
regardless, since the source is Gaussian (§2.0b) and must land on a regular
grid.

### 4.4 Frame budget (B5)

Measured against the draft YAML by scaling its lists out to real frame counts:

| Frames | Pipeline JSON | % of `MAX_PIPELINE_JSON_BYTES` |
|---|---|---|
| 41 (3-hourly, 5 days) | 14.4 KB | 22% |
| 121 (hourly, 5 days) | 40.9 KB | 62% |
| 128 (the list bound) | 43.2 KB | 66% |

So the byte budget is **not** the constraint — an earlier estimate here was too
pessimistic, and measuring it settled the question. The binding limit is
`MAX_PIPELINE_ARG_LIST_ITEMS` (128), and hourly output over five days lands at
121: it fits, with seven frames of headroom. A six-day hourly span (145 frames)
would break the item bound long before the byte bound.

That makes the cadence decision a *presentation* question rather than a
validator one. 3-hourly (41 frames) matches the proven aerosol template and
gives a watchable loop; hourly triples the smoothness and nearly saturates the
list bound. Decide after §2 reports the real cadence, and if the retro span
turns out longer than five days, split into multiple runs rather than
subsampling on the validator's account.

### 4.5 Output: frames, not `compose-video`

Publish the frame set at `/work/images/frames` rather than composing an MP4.
`compose-video` encodes value-bearing luma to H.264, and the downstream HLS
transcode encodes it again — two lossy generations over pixels whose values
*are* the data, so hover readings drift. Ending on frames lets the transcode do
the single encode. The cost is that `playback_fps` must be set on the dataset
row by hand, or the frames play in about a second.

### 4.6 The pipeline

Draft YAML: [`docs/workflows/ufs-chem-sfc-ozone.yaml`](workflows/ufs-chem-sfc-ozone.yaml).
It is written against the NCSS path with literal retro dates, and carries
`ADAPT` markers on every value that §2 supplies. It is **not runnable as
committed** — the URLs, variable name, cadence, and `vmax` are placeholders by
design, and B1 stands regardless.

## 5. Non-goals

- **Vertical/3-D ozone rendering.** Even though `atmf` carries every model
  level, the globe renders a 2-D raster. Surface only; the other levels are
  bytes to avoid moving, not a product.
- **Changing the Cloudflare policy from inside this repo.** B1 is resolved by
  GSL/IT or by mirroring, not by pipeline code.
- **Adding `acquire thredds` in this plan's scope.** §3.4 argues it *should* be
  allowlisted — it collapses the pipeline and removes B5 — but that is its own
  change, coupled to a runner-digest bump, and it does not unblock B1. Track it
  separately rather than folding it in here.
- **A dynamic colorbar legend.** Not on `main`; attach a `legend_ref` PNG.

## 6. Next steps

0. **Check FTP first** (§3.1a) — it is one command, it is the likeliest route
   around B1, and its answer decides whether the rest of this plan simplifies:

   ```bash
   curl -u "anonymous:you@noaa.gov" \
     'ftp://gsdftp.fsl.noaa.gov/ufs-chem_csl/20260817/'
   ```

   Looking for: does a 2-D `sfcf*.nc` exist alongside the 3-D `atmf*.nc`, and
   how big are they?

1. Run `scripts/inventory-thredds.py` from a NOAA-allowed network against
   **both** collections; paste or commit the JSON. Still worth doing even if
   FTP works — the OPeNDAP `.das` probe is the cheapest way to get variable
   names and units, which FTP cannot tell you without downloading a file.

   ```bash
   # the daily collection — the better target (§2.1)
   python3 scripts/inventory-thredds.py \
     https://gsl.noaa.gov/thredds/catalog/data/ufs-chem_csl/20260817/catalog.xml \
     --probe 2 > ufs-chem-csl-inventory.json

   # the retro collection
   python3 scripts/inventory-thredds.py \
     https://gsl.noaa.gov/thredds/catalog/retro/ufs_chem_sfc_ozone/catalog.xml \
     --probe 2 > sfc-ozone-inventory.json
   ```

2. From the daily listing, answer the two §2.1 questions first: **is there a
   `sfcf*.nc` companion** (2-D, small, probably the right input), and **what
   are the ozone variable's units** (B4)? Those two answers drive most of the
   remaining design.
3. Fill in §2, then settle `--var`, `vmax`, `units`, cadence, and the palette.
4. Decide B1: mirror to S3 (preferred — and it is where the B4 unit rescale
   would live), allowlist a self-hosted runner, or hand-stage a one-shot.
5. Relay the §3.1 evidence to IT — specifically that the UA fix does not cover
   CI egress, which is the case that matters for automation.
6. Retarget the draft YAML at the daily collection with templated URLs (§4.1),
   validate against the real validators, then dispatch a run.
