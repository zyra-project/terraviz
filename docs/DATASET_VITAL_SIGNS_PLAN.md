# Dataset Vital Signs

**Status: draft for review.** No code, no migrations, no bindings. Scopes a
per-cycle statistical reading for datasets that update, what it may and may not
be used to say, and the guards that keep it honest.

Referenced from [`TOUR_DIRECTION_PLAN.md`](TOUR_DIRECTION_PLAN.md) §4 as **D2a**.

---

## 1. Problem

A node can hold two hundred datasets. A visitor arriving at the catalog has no
way to know which one is worth looking at *today*. `heroService` answers a
version of this question already, but it answers it from metadata: recency,
tags, a curator's pin. None of that knows whether the field is doing anything.

The same gap shows up in three other places. A generated tour orders its stops
by match score, not by which dataset is actually interesting right now. The
newsroom queue only ever hears about the world through RSS, so an event visible
in our own data but absent from the wires is invisible to us. And nobody
watching a real-time dataset finds out when it does something unusual unless
they happen to be looking.

All four want the same missing input: **a number, per dataset, per cycle,
saying how far today's field sits from that dataset's own normal.**

## 2. Provenance

The underlying idea — keep a compact numeric descriptor per item and use it to
choose what to show — is adapted from tubeviz. That adaptation, and the
licensing position that governs it, is recorded in
[`TOUR_DIRECTION_PLAN.md`](TOUR_DIRECTION_PLAN.md) §2 and §3 and is not repeated
here. **The vital-sign reframing is TerraViz's own**: tubeviz's fingerprint is
an aesthetic descriptor used for shot variety, computed once per scene and never
revisited. Recomputing per cycle and reading the *deviation* as signal is a
different feature with different failure modes, and nothing in tubeviz informs
the design below.

## 3. What a vital sign is here, and what it is not

A vital sign is a **measurement**: a small set of statistics over one cycle of
one dataset, plus that reading's position in the dataset's own distribution.

It is not an interpretation. This distinction is the spine of the whole plan,
so it is worth stating in the sharpest possible form:

| | Example | May be published unattended |
|---|---|---|
| Measurement | "AOD over this region is at the 98th percentile of its last five Augusts" | **Yes** |
| Interpretation | "Notable smoke event over the Front Range" | **No** |

The first is a fact about our own data, and it is falsifiable by anyone who
downloads the file. The second is a claim about the world. On a NOAA-adjacent
site, a member of the public reads an automated claim as an official statement,
and there is no disclaimer that undoes that. So interpretation goes through a
human, and §7 says which one.

**A vital sign is also not a warning product.** It has no relationship to NWS
watches, warnings or advisories, it carries no lead time, and it must never
appear in a form that could be mistaken for any of those. See §9.

## 4. Where it is computed

**From the source grid, in the Zyra pipeline. Not from the video, and not in
the browser.**

The data-encoded video is a lossy 8-bit luma quantization of the field. The
untagged limited-range round trip leaves roughly one code in seven unreachable,
which is why [`analyzeCharts.ts`](../src/ui/analyzeCharts.ts) aggregates
histogram buckets rather than drawing one bar per code
(`DATA_ANALYSIS_PLAN.md` §The transport lattice). Statistics taken from the
video therefore carry the transport's lattice as well as the weather. That is
tolerable for an interactive readout the user asked for; it is not tolerable as
the basis of an anomaly score compared across months.

The pipeline already holds the float grid. Computing there gives exact values in
physical units, off an array in memory, at effectively zero marginal cost.

| Candidate home | Verdict |
|---|---|
| Browser, via `glLumaSampler.snapshot()` | **No.** Deliberately a user-initiated whole-frame GPU readback, never a background path; would sample only datasets someone opened |
| Cloudflare Worker | **No.** Cannot decode video frames; CPU-time bounded |
| Zyra stage, source grid | **Yes.** Exact, physical units, already in memory |

### The stage

A new allowlisted command under `process` (or `transform`) in
[`ZYRA_STAGE_ALLOWLIST`](../src/types/zyra-workflow-constants.ts), alongside the
existing `metadata` and `scan-frames`. It reduces the grid it was handed and
writes a small JSON sidecar next to the run's other outputs.

The precedent to follow is `WORKFLOW_OUTPUT_PATH`: `/validate` already requires
a registered pipeline to declare an output path so it cannot silently produce
nothing the publish leg can find. A stats sidecar gets the same treatment — a
declared path, validated at registration — so "the stage ran but wrote nowhere"
is a registration-time error rather than a silent gap in a time series.

### What it computes

The vocabulary already exists in [`datasetStats.ts`](../src/services/datasetStats.ts)
as pure reducers over a `LumaSnapshot`: `summarize`, `buildHistogram`,
`weightedQuantile`, `areaAboveKm2`, `findExtremum`, `zonalMeans`, and
`rowAreasKm2` for true spherical cell weighting. The Zyra stage computes the
same quantities on the float grid instead. Keeping the two definitions aligned
matters: a user who opens Analyze and reads a mean should get the number the
vital sign was computed from, modulo quantization.

A reading is roughly: min, max, mean, median, p10, p90, sigma, coverage
fraction, area above the dataset's configured thresholds, extremum location, and
the area-weighted histogram. Small — a few hundred bytes.

## 5. Baseline and score

**Per dataset, never a shared threshold.** A fire-detection field is always
spiky; a sea-surface-temperature field is always smooth. There is no
cross-dataset value of "high" that means anything, so every score is expressed
relative to that dataset's own history.

**Seasonal, not trailing.** A trailing mean over recent cycles quietly absorbs
exactly the slow signal the feature exists to catch: a field that has been
climbing for six weeks reads as normal against its own last six weeks. The
baseline should be a day-of-year window across years — same calendar window,
prior years — with the trailing window kept only as the cold-start fallback
described below.

**The score is a percentile, not a sigma.** These fields are heavily skewed;
`analyzeCharts` already paints histograms on a square-root height scale for that
reason. A z-score on a skewed distribution overstates the tail. Percentile
against the seasonal window is honest and needs no distributional assumption.

### The cold-start problem, stated plainly

A seasonal baseline needs years of history, and on day one there is none. This
is the weakest part of the plan and should not be papered over:

- **Option A: wait.** The feature is descriptive-only and weak for roughly a
  year, then becomes good. Cheap, honest, slow.
- **Option B: backfill.** Where the source publishes an archive (NOAA Open Data
  on S3 / NODD does, for many products), run the same stage over historical
  cycles to build the baseline before launch. Real work per dataset, but it is
  the same stage over the same code path, and it is the only route to a useful
  seasonal baseline at launch.
- **Option C: ship the short-window reading first.** "This cycle differs from
  the last N cycles by X" is computable immediately, is genuinely useful for
  catching fast-moving change, and is honest about what it measures as long as
  the label says *recent*, not *normal*.

C then B is the recommended path. C is useful on its own and its output is not
thrown away when B lands; the two answer different questions and both are worth
having.

## 6. Guards — what suppresses a reading

**The largest anomalies this system will ever produce are pipeline failures.** A
missing tile, a truncated cycle, a changed fill value, a units change upstream:
all four look enormous and none of them are weather. A design that does not
treat this as the primary case will spend its credibility in the first month.

The rule is that these **suppress** a reading rather than becoming one:

| Condition | Response |
|---|---|
| Coverage moved materially from the dataset's own norm | Suppress. `datasetStats` already tracks coverage and excludes the no-data band, so the concept exists |
| The run did not reach `succeeded` | No reading. `WORKFLOW_RUN_STATUSES` is the gate |
| Value range implies a units or fill-value change | Suppress, and flag for a human. This is an ops event, not a data event |
| Fewer than the configured minimum baseline samples | Reading stored, score withheld |

A suppressed reading is still written, marked suppressed and with its reason.
Deleting it would hide exactly the operational history someone will want when
asking why a dataset went quiet for a week.

## 7. The two surfaces

### 7a. Descriptive — direct to the viewer

A per-dataset reading and its percentile, shown as a compact indicator plus a
sparkline of recent cycles. No approval, because nothing is being claimed.

The first consumer is [`heroService`](../src/services/heroService.ts). It
already asks "what is worth showing right now" and already identifies the
applicable subset through `REAL_TIME_TAG`; a percentile is a better answer to
its own question than a tag is. `pickAutoDerived` gains an input, not a rewrite.

Second consumer is **D1** in the tour plan: given several matched datasets,
prefer the one that is actually doing something, and use the reading as a
tiebreak against the variety score.

### 7b. Interpretive — through the queue that already exists

An anomaly that looks like a story becomes a **proposed event**, not a
publication.

The events pipeline is already auto-propose then curator-approve
(`CURRENT_EVENTS_PLAN.md` §4, §5), and the schema needs nothing new:
[`CurrentEventRow`](../functions/api/v1/_lib/events-store.ts) carries generic
`source_name` / `source_url` / `published_at` provenance, a nullable `feed_id`
discriminator, an `inferred_fields` JSON array already used to mark
machine-filled fields, and a `status` of `proposed | approved | rejected |
expired`. `EventDatasetLinkRow` carries `match_score` and `signals_json`.

So a data-derived proposal is **another proposer alongside the RSS
connectors**: its own `feed_id`, `source_name` naming the dataset and the
pipeline, `signals_json` carrying the reading that triggered it, and a `status`
of `proposed`. It lands in the same review queue, wears the same Match Badge,
and inherits the same audit trail (`reviewed_by`, `owner_id`).

Two things this buys that a bespoke path would not. The curator sees the data
reading and any related headline **side by side**, which is a better review than
either alone. And an approved event already knows how to become a blog draft and
a generated tour, so the data proposal reaches the same surfaces as a wire story
with no new plumbing.

## 8. Phasing

| Phase | Contents | Gate |
|---|---|---|
| V1 | The Zyra stage + sidecar; readings stored; nothing rendered | Stage allowlisted, output path validated, reducers agree with `datasetStats` on a fixture |
| V2 | Short-window score (§5 option C) + the descriptive indicator | Reading visible on the dataset surface; no claims made |
| V3 | `heroService` and D1 consume the score | Hero picks measurably less repetitive across a week |
| V4 | Seasonal baseline via archive backfill (§5 option B) | Baseline sample counts met per dataset before any dataset's score is labelled *normal* |
| V5 | Anomaly proposer into the events queue | Curator precision acceptable on a shadow run before it writes real rows |

V1 through V3 stand alone and are worth shipping even if V4 and V5 never happen.
V5 should not start until V4 has produced a baseline someone has looked at.

**Shadow first.** V5 should run for a full seasonal cycle writing proposals
nowhere, or into a curator-only view, before it can create rows. The metric that
decides whether it graduates is curator precision: of the proposals it makes,
how many does a human approve? If that number is low, the feature is generating
work rather than saving it, and it should stay off.

## 9. Non-goals

- **Not a warning, watch, advisory, or forecast.** No lead time, no
  probabilities, no thresholds presented as operationally meaningful. Nothing in
  this feature may be styled, worded, or positioned so it could be mistaken for
  an official product. This is a hard constraint, not a preference.
- **Not a QC system for the upstream provider.** Suppression guards exist to
  protect our readings, not to assert that someone else's data is wrong.
- **Not per-user alerting.** No subscriptions, no notifications, no push. The
  reading is a property of the catalog, not a channel.
- **Not applicable to static datasets.** A dataset that does not update has no
  time series. Its descriptor is the static path in `TOUR_DIRECTION_PLAN.md` D2.
- **Not an LLM feature.** The reading is arithmetic. If a model is ever used to
  phrase a proposed event's summary, it goes through the existing contract and
  availability gate in [CONTRIBUTING.md](../CONTRIBUTING.md) §LLM Integrations,
  and the number it describes is still computed here.

## 10. Storage and cost

One row per dataset per cycle. A real-time dataset on a 15-minute cadence
produces 96 rows a day; a hundred such datasets is roughly 3.5M rows a year at a
few hundred bytes each. That is comfortable for D1, but it needs a stated
retention policy rather than an accidental one:

- Raw per-cycle readings: keep a bounded recent window.
- Daily aggregates: keep indefinitely. These are what the seasonal baseline
  reads, and they are small.

The aggregate is the durable artifact. Deciding this before V1 avoids a
migration once the table is large.

## 11. Open questions

1. **One Zyra stage or two?** D3 in the tour plan wants a per-frame temporal
   profile; this wants a per-cycle statistics row. Both reduce the same grid.
   One stage emitting both, or two stages, decided before either is built to
   avoid a second pass over the data.
2. **Does a federated peer exchange vital signs?** A peer publishing readings is
   asserting something about its own data quality, and a reading is only
   meaningful against the baseline that produced it. Likely answer is that
   readings stay node-local and only the descriptive indicator federates, but
   this needs a decision against
   [`federation-scoping.md`](architecture/federation-scoping.md) §8.
3. **A new `FEATURE_KEYS` entry, or ride on `datasets` / `events`?** The
   descriptive surface is arguably part of `datasets`; the proposer is clearly
   part of `events`. A separate key would let a node run the measurement without
   the proposer, which is probably worth having.
4. **Who configures thresholds?** `areaAboveKm2` needs a threshold per dataset
   to be meaningful. Publisher-set field, derived from the color scale's
   `vmin`/`vmax`, or both?

## 12. Conventions any implementation must follow

- Pure reducers, no DOM and no fetch, mirroring
  [`datasetStats.ts`](../src/services/datasetStats.ts).
- A module-map row in `CLAUDE.md` or [`BACKEND_MODULES.md`](BACKEND_MODULES.md)
  in the same PR; `npm run check:doc-coverage` enforces it.
- Every user-facing string through i18n; a `Scene` in
  `scripts/screenshots/scenes.ts` for any new UI surface.
- DCO sign-off on every commit.
