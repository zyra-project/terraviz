# UFS-Chem surface ozone — inventory, transfer, and workflow design

**Status: draft for review.**
**Last reviewed: 2026-08-18.**
**Revisit when:** the inventory in §2 is filled in from a real catalog read;
GSL changes the Cloudflare policy on `gsl.noaa.gov`; `acquire thredds` is
allowlisted; the retro collection moves to NODD/S3.

Source under evaluation:
`https://gsl.noaa.gov/thredds/catalog/retro/ufs_chem_sfc_ozone/catalog.html`

Goal: put UFS-Chem global surface ozone on the TerraViz globe as a
**data-encoded** dataset — hover reports a real value in real units, and the
palette is a client-side transform rather than baked-in colour.

## 1. Summary

The pipeline shape for this dataset is well-understood and is not the hard
part. Three things stand between us and a running workflow, and only the first
is genuinely blocking:

| # | Blocker | Status | Severity |
|---|---|---|---|
| B1 | `gsl.noaa.gov` Cloudflare policy 403s datacenter/CI egress | **Verified, blocking** | Must be solved before any workflow runs |
| B2 | `acquire thredds` is not on the TerraViz stage allowlist | Verified | **Not blocking** — NCSS routes around it (§3.3) |
| B3 | Placeholder grammar can't express GSL's day-of-year filenames | Verified | **Not blocking for retro** — fixed dates need no templating (§4.1) |
| B4 | Zyra cannot rescale units; ozone may be stored as mole fraction | Conditional on §2 | Cosmetic but material — decides hover readability |
| B5 | Frame count vs `MAX_PIPELINE_ARG_LIST_ITEMS` (128) | Measured, §4.4 | Minor — 5 days hourly fits at 121 |

**B1 is the whole story.** Everything downstream is designed and ready; it
cannot be exercised until a machine that runs the workflow can read the files.

## 2. Inventory — what is actually in these files

**Not yet established.** This section is deliberately empty rather than
guessed. The catalog could not be read from the environment this design was
written in (§3.1), and inventing a variable list would be worse than leaving a
hole: every calibration decision below (`vmin`/`vmax`, `units`, the palette,
the frame cadence) depends on the real answer.

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

### 3.2 What THREDDS offers, and what Zyra can use

A TDS instance exposes the same files through several services. They differ
enormously in bytes moved:

| Service | Mechanism | Bytes moved | Usable from a Zyra pipeline? |
|---|---|---|---|
| `HTTPServer` (`fileServer`) | whole file | **All variables, all levels, all times** | Yes — `acquire http`, or URLs straight into `convert-format --inputs` |
| `NetcdfSubset` (`ncss`) | server-side subset by variable / bbox / time | **Only what you ask for** | **Yes** — it is a plain GET with query params (§3.3) |
| `OPeNDAP` (`dodsC`) | index hyperslab | Only the slab | No — nothing in Zyra speaks DAP |
| `WMS` / `WCS` | rendered tiles / coverages | Tiny | No — WMS returns *pictures*, which defeats data-encoding entirely |
| `CdmRemote` | ncstream binary | Only the slab | No client |
| `catalog.xml` crawl | listing | Tiny | `acquire thredds` is **not allowlisted** (B2) |

Two entries deserve emphasis. **WMS is a trap**: it is the cheapest thing on
the list and it is useless here, because a rendered image has already thrown
away the values that make the dataset queryable. And **OPeNDAP is the best
mechanism nobody can use** — it is exactly the right tool for "give me one
surface variable out of a 3-D history file", and there is no Zyra command that
speaks it. It remains the right tool for the *inventory* step, which is why
`scripts/inventory-thredds.py` uses it.

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

## 4. Workflow design

### 4.1 Retro data does not need the placeholder grammar

The documented reason GSL THREDDS is a dead end for *self-updating* workflows
is that its filenames encode `<YYDDDHHmm><FFF>` — year, day-of-year, hour,
minute, forecast hour — and the placeholder grammar has no day-of-year or
2-digit-year formatter.

That constraint does not apply here. This is a **retrospective** collection:
the dates are fixed and known, so the URLs are written out literally and no
templating is involved. B3 is real, and it is simply not in the path for a
retro dataset. It returns the moment anyone wants a live UFS-Chem feed.

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
| `vmax` | p99.9 | **p99.9 of the real field** | From §2; a too-high `vmax` gives the classic near-black globe |

On `vmin`: raising it to a clean-air floor (~10–20 ppb, once units are known)
would sharpen contrast considerably, because the mid-palette would no longer be
spent on air nobody is interested in. The cost is that everything below the
floor **clamps** — remote-ocean hover would read the floor value rather than
the truth. For a dataset whose selling point is "hover gives you the real
number", that is the wrong trade. Keep `vmin: 0` and let the palette's low end
carry the background.

**B4, units.** If the inventory reports ozone as a mole fraction in `mol mol-1`
or `kg kg-1`, hover will read `0.0000000452` — technically correct, practically
unreadable. Zyra has no unit-rescaling command (a confirmed upstream gap), so
there are only three honest options: accept the exponent; ask whoever generates
the retro files to also write a ppbv field; or rescale during the mirror step
in §3.1 option 1, which is the neatest fix if we are mirroring anyway. If the
files already carry ppbv, none of this applies — hence the dependency on §2.

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

- **A live/operational UFS-Chem feed.** Retro only. A live feed reopens B3 and
  needs a source whose filenames fit the placeholder grammar.
- **Vertical ozone structure.** The globe renders a 2-D raster; surface only.
- **Changing the Cloudflare policy from inside this repo.** B1 is resolved by
  GSL/IT or by mirroring, not by pipeline code.
- **Adding `acquire thredds` to the allowlist.** §3.3 makes it unnecessary for
  this dataset. If it is added later it should be for its own reasons, coupled
  to a runner-container bump as the allowlist comment requires.
- **A dynamic colorbar legend.** Not on `main`; attach a `legend_ref` PNG.

## 6. Next steps

1. Run `scripts/inventory-thredds.py` from a NOAA-allowed network; paste or
   commit the JSON. **Everything else is blocked on this.**
2. Fill in §2, then settle `--var`, `vmax`, `units`, cadence, and the palette.
3. Decide B1: mirror to S3 (preferred), allowlist a self-hosted runner, or
   hand-stage a one-shot.
4. Relay the §3.1 evidence to IT — specifically that the UA fix does not cover
   CI egress, which is the case that matters for automation.
5. Validate the YAML against the real validators, then dispatch a run.
