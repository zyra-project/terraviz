# Tour Direction — sequencing, pacing and visual variety for generated tours

**Status: draft for review.** No code, no migrations. Scopes four candidate
features for the generated-tour path, and records the provenance and licensing
position for the outside project whose design suggested them.

---

## 1. Problem

`buildEventTourTasks` turns an approved event plus its matched datasets into a
tour. It is deliberately simple, and its two simplifications are now the
limiting factor on how good a generated tour feels:

- **Order is inherited, not chosen.**
  [`event-tour.ts`](../functions/api/v1/_lib/event-tour.ts) takes
  `datasets.slice(0, MAX_TOUR_STOPS)` — whatever order the matcher produced,
  truncated to four. Nothing prevents four consecutive stops that share a
  category, a palette and a bounding box. A viewer reads that as "the same
  thing four times", which is the worst outcome for a surface whose job is to
  show breadth.
- **Pacing is a constant.** `STOP_HOLD_S = 10` for every stop, on every
  dataset, regardless of whether anything is happening in the frame. A field
  mid-event and a field at rest get the same ten seconds.

Both are the right first implementation. Neither is where we want to stop.

There is a third, smaller problem that shows up in the same places: a dataset
video's first seconds are often spin-up, blank, or a colour-bar frame, and
nothing currently stops a tour stop, a thumbnail, or a hero pick from landing
there.

## 2. Provenance — where these ideas come from

These four features are adapted from **[tubeviz](https://github.com/interrupt21h/tubeviz)**
by Scott Muller, an AI-directed music visualizer. It solves a structurally
identical problem in an unrelated domain: given a large pool of candidate
footage and a signal that varies over time, choose a *sequence* of excerpts that
does not repeat itself, and pace the cuts to what the signal is doing.

Its Visual Director scores each candidate on semantic relevance, novelty
pressure, reuse cooldown, and whether the moment calls for visual *continuity*
or *contrast* — then assigns each shot a narrative role across the arc. Its
library also stores a compact per-scene visual fingerprint (brightness,
saturation, dominant hue, palette, complexity, entropy, motion magnitude and
direction, internal cut rate) and a non-destructive usable-range marker so
title cards never enter a generated edit.

TerraViz has the same shape of problem — a catalog of candidates, a time-varying
driver (an event feed rather than a song), and a deterministic timeline played
by [`tourEngine.ts`](../src/services/tourEngine.ts) — and none of that
machinery. The ideas transfer; see §4 for what each becomes here.

Upstream moves fast: v0.24.0 to v0.34.0 in five days, adding LLM-assisted
direction, vision-model scene description, and a codec-glitch effect stack. The
descriptions above are of the parts this plan draws on, which have been stable
across that span. Anything here about tubeviz's internals should be re-checked
against its current HEAD before being relied on.

**tubeviz is upstream and stays upstream.** Nothing in this plan asks anything
of that project, and no issues have been or should be filed there on the
strength of this document.

## 3. Licensing — Apache-2.0 both sides

**Updated 2026-08-26.** tubeviz published no LICENSE when this plan was first
written, so an earlier revision of this section concluded that none of its code
could be imported. That is no longer true. tubeviz is now **Apache-2.0**
([`LICENSE`](https://github.com/interrupt21h/tubeviz/blob/dbe1518/LICENSE),
`license = "Apache-2.0"` in `pyproject.toml`, a `NOTICE` file, and an
`SPDX-License-Identifier: Apache-2.0` header on every source file). TerraViz is
Apache-2.0 too, so the licences are identical and reuse is straightforward.

### What is now permitted

Importing tubeviz code is allowed, subject to the ordinary Apache-2.0 §4
obligations, which are not onerous but are not optional either:

| Obligation | What it means here |
|---|---|
| Include the licence | Ship a copy of Apache-2.0 with any redistributed portion |
| Retain notices | Keep copyright, patent, trademark and attribution notices, including the `SPDX-License-Identifier` header on any file we take |
| State changes | Any modified file must carry a prominent notice that we changed it |
| Carry NOTICE | tubeviz's `NOTICE` ("tubeviz, Copyright 2026 tubeviz contributors") must be reproduced in our own NOTICE if we redistribute its work |

Concretely, that means a `NOTICE` file at the TerraViz root (we do not have one
yet) and a short attribution block naming tubeviz, its copyright line, and the
files taken. [`CONTRIBUTING.md`](../CONTRIBUTING.md) already requires exactly
this of third-party code, and Apache-2.0 is the compatible case it names.

### Why we still mostly won't import

Permission removes the legal question and leaves the engineering one, which
answers differently per target:

- **The TerraViz SPA is TypeScript.** tubeviz is Python and C++. Porting is a
  rewrite regardless of licence, and a rewrite in our own idiom is what §4
  describes anyway. Nothing in D1–D4 gets cheaper because the licence changed.
- **Zyra is Python, and that is genuinely new.** D2a and D3 both want a stage
  that reduces a grid and reasons about temporal structure. tubeviz's audio and
  visual-feature modules are Apache-2.0 Python that could be *used*, not
  reimplemented. Before doing that, confirm Zyra's own licence is compatible and
  that a new dependency (or a vendored module with attribution) is wanted there;
  vendoring a few pure functions with an SPDX header intact is usually cleaner
  than taking a dependency for them.
- **Ideas remain the main import.** Everything in §4 was scoped to need no
  tubeviz code at all, and that is still the safest default. The licence
  upgrades our options; it does not change the design.

### What still holds

- **Credit by name**, in this document, in a header comment on any module that
  grew from a tubeviz idea, and in the PR description. Now legally required for
  copied code, and still right for borrowed ideas.
- **Attribution is not endorsement.** Naming tubeviz must not imply its author
  endorses TerraViz or vice versa.
- **Don't launder code through a model.** Feeding source into an LLM to get a
  "reimplementation" produces a derivative work with the attribution stripped,
  which is now a licence violation rather than merely a bad practice. If we want
  the code, take it properly and keep the notices.
- **DCO sign-off** still attests we have the right to submit. With Apache-2.0
  upstream and correct attribution, we do.

## 4. Candidate features

### D1 — Shot sequencing for generated tours — **shipped**

**What.** A pure `orderTourStops(candidates, opts)` that chooses the *order* of
matched datasets rather than accepting the matcher's ranking: the strongest
match opens, and each stop after it is the candidate with the best blend of its
own score and its dissimilarity from what has already been shown (facet and
keyword Jaccard, bbox IoU, adjacency weighted above the whole selection).

**Where.** [`tour-stop-order.ts`](../functions/api/v1/_lib/tour-stop-order.ts),
consumed by `resolveStopDatasets` in
[`publish/events/[id]/tour.ts`](../functions/api/v1/publish/events/[id]/tour.ts).
Pure transform, no I/O — the shape
[`catalogEvents.ts`](../src/services/catalogEvents.ts) and
[`catalogGraph.ts`](../src/services/catalogGraph.ts) already follow, and
directly unit-testable on literal candidates.

**Two corrections found while building it.**

The truncation this was meant to improve is not the `slice(0, MAX_TOUR_STOPS)`
inside `buildEventTourTasks`, which only ever sees four candidates and is a
safety net. The real cap is in `resolveStopDatasets`, which walks a score-ordered
pool of up to 80 links and breaks at four. That is where ordering has to happen,
and doing it there means the sequencer sees the whole visible pool rather than a
pre-truncated four.

The blog companion tour is deliberately **not** sequenced. It runs over "the
curator's hand-picked datasets", so its order is already a human decision, and
re-ordering an explicit choice is not this function's business. D1 applies only
where the order was machine-chosen to begin with.

**Deliberately cut: the closer rule.** The original sketch said "keep a strong
stop in reserve for the close". It was dropped rather than built. It fights the
variety objective directly (holding a high-scoring stop back can put its twin
adjacent to the opener), and the notion of a *payoff* it borrows from tubeviz is
derived there from musical structure — a build and a drop. An event tour has no
equivalent signal, so the rule would have been a guess dressed as direction. If
a reason to end strong emerges later it can be added behind its own option.

**Cost.** Low. Metadata only: no GPU, no new storage, no migration. The match
score already exists.

**Recommendation.** Build first. It is the cheapest of the four and fixes the
most visible problem.

### D2 — Dataset descriptor, static and live

**What.** A small persisted numeric descriptor per dataset: value distribution,
spatial extent, coverage, and where the field is concentrated.

**Uses.** Gives D1 a real variety signal instead of category proxies; lets
[`heroService.ts`](../src/services/heroService.ts) avoid picking similar heroes
on consecutive days; adds a quantitative axis to the lexical
[`relatedDatasets.ts`](../src/services/relatedDatasets.ts) alongside the
semantic [`relatedDatasetsService.ts`](../src/services/relatedDatasetsService.ts).

**Two cadences, one descriptor.** For a static dataset this is computed once at
publish time, riding along on the frame
[`globeThumbnail.ts`](../src/services/globeThumbnail.ts) already decodes. For a
dataset that updates on a cycle, it should be recomputed **every cycle**, and
the descriptor becomes a time series rather than a column. The latest row is
what D1 and the hero picker read, so nothing downstream has to know which
cadence produced it.

**Compute it from the source grid, not the video.** For the live path this is
the decision that matters. The data-encoded video is a lossy 8-bit luma
quantization of the field, and the untagged limited-range round trip leaves
roughly one code in seven unreachable (see
[`analyzeCharts.ts`](../src/ui/analyzeCharts.ts) and `DATA_ANALYSIS_PLAN.md`
§The transport lattice). Measuring a field from the video when the Zyra pipeline
holds the float grid upstream measures the compression as much as the weather.
The right home is a Zyra stage emitting statistics alongside the video, next to
the existing `metadata` / `scan-frames` commands in
[`ZYRA_STAGE_ALLOWLIST`](../src/types/zyra-workflow-constants.ts). Values come
out in physical units, exact, off an array already in memory.

**What it must not be.** Not a client-side catalog sweep.
[`glLumaSampler.snapshot()`](../src/services/glLumaSampler.ts) is deliberately a
user-initiated whole-frame GPU readback, never a background path, and
[`datasetStats.ts`](../src/services/datasetStats.ts) reduces one snapshot at a
time. Sampling the catalog through that path would invert a deliberate design
decision and would only observe datasets someone happened to open.

**Cost.** Static path: a stored field and a migration. Live path: a Zyra stage,
a time-series table, and a retention policy. See §4a for where the live path
leads, which is a larger piece of work than this plan covers.

### D2a — Vital signs: the live descriptor as a signal

Tracked over time, a per-cycle descriptor stops being a similarity key and
becomes a vital sign: today's reading against this dataset's own history says
whether anything unusual is happening. That is a genuinely different and more
valuable feature than D2, and it needs its own plan. Four things decide whether
it works.

**Baseline per dataset, never a shared threshold.** A fire-detection field is
always spiky; a sea-surface-temperature field is always smooth. "Unusual" only
means anything relative to that dataset's own distribution, and it has to be
seasonally aware, so a day-of-year window across years rather than a trailing
mean that quietly absorbs the signal it is meant to catch.

**Coverage is the guard, not a metric.** The largest anomalies a system like
this will ever produce are pipeline failures: a missing tile, a failed cycle, a
changed fill value. All three look enormous. If coverage moved, it is an
operations problem until proven otherwise. `datasetStats.ts` already tracks
coverage and excludes the no-data band, so the concept exists; the rule is that
a coverage change suppresses the reading instead of becoming one.

**Describe, don't declare.** This is the line that decides how much trust
surface gets created. "This field is two standard deviations above its seasonal
normal" is a measurement, and it can go straight to a viewer. "Notable wildfire
event" is a claim, and on a NOAA-adjacent site a member of the public reads an
automated claim as an official statement. The measurement is publishable; the
interpretation is not.

**Route interpretation through the queue that already exists.** The current
events pipeline is already auto-propose then curator-approve
(`CURRENT_EVENTS_PLAN.md` §4, §5), and `CurrentEventRow` already carries generic
provenance plus a `feed_id` discriminator and a `status` gate
([`events-store.ts`](../functions/api/v1/_lib/events-store.ts)). A data-derived
anomaly should arrive as **another proposer alongside the RSS connectors**, into
the same review queue, with the same badge and the same audit trail. No new
approval semantics, no new trust surface, and a curator sees the reading and the
headline side by side.

The descriptive half needs none of that. A per-dataset "how unusual is this
right now" reading is a better answer to the question `heroService` already asks
than tags are, and `REAL_TIME_TAG` already identifies the subset it applies to.

**Scope.** Larger than D1 and D4 combined, spanning Zyra, the backend, storage
and UI. Scoped separately in
[`DATASET_VITAL_SIGNS_PLAN.md`](DATASET_VITAL_SIGNS_PLAN.md), which carries the
baseline design, the suppression guards, the phasing, and the hard non-goal that
none of it may resemble a warning product.
### D3 — Pacing from the data's own dynamics

**What.** Replace the constant `STOP_HOLD_S` with a hold derived from the
dataset: seek (via the existing `setTime` tour task) to the frame where the
field peaks inside the event window, and hold longer on stops where the field is
actually changing.

**The constraint.** This cannot be observed during playback.
[`playbackSettle.ts`](../src/services/playbackSettle.ts) is deliberately silent
while a video plays at any rate, because `currentTime` is a clock rather than a
frame counter. So the temporal profile must be **precomputed** — a per-frame
reduction over the video, which is Zyra-pipeline work, not browser work.

**Cost.** High, and the most speculative of the four. It also has the largest
payoff: nothing else on the roadmap makes a generated tour feel *directed*
rather than assembled.

**Recommendation.** Park behind D1 and D2. Revisit when the Zyra pipeline has a
natural place to emit a temporal profile alongside the video.

### D4 — Publisher "usable range" for dataset videos

**What.** Non-destructive `usable_start` / `usable_end` on a dataset, set in the
publisher portal, marking which part of the video is fit to show. Nothing is
re-encoded; the bounds only constrain what other surfaces may pick.

**Consumers.** Thumbnail generation, tour `setTime` seeks, hero frame choice —
each clamps to the usable range instead of trusting frame zero.

**Cost.** Low-to-medium and entirely self-contained: two nullable columns, a
small portal control, and clamping at three call sites.

**Recommendation.** Build second. It is small, it fixes an ugliness users
already see, and it makes D2 and D3 more accurate by keeping spin-up frames out
of both.

## 5. Phasing

| Phase | Contents | Gate |
|---|---|---|
| 1 | **D1** shot sequencing | **Shipped.** Pure transform + tests; no schema change |
| 2 | **D4** usable range | Migration + portal control + three clamps |
| 3 | **D2** descriptor, static path | Depends on D4 for accuracy; publish-time only |
| 4 | **D3** data-driven pacing | Parked; needs a Zyra temporal-profile stage |
| — | **D2a** vital signs | [Own plan doc](DATASET_VITAL_SIGNS_PLAN.md). Shares D3's Zyra stage; build them together or not at all |

Each phase is independently shippable and independently reversible.

## 6. Non-goals

- **Not importing tubeviz code into the SPA.** Permitted since the Apache-2.0
  relicense (§3), but a Python-to-TypeScript port is a rewrite either way. The
  Zyra-side question is open and tracked in §8.
- **Not music.** Nothing here adds audio analysis or an audio-driven tour.
  TerraViz's driver is an event feed, and stays one.
- **Not a generative visual-effects stack.** tubeviz's vector scene graph,
  contour tracing and motion transplantation are the right answer for a music
  video and the wrong one for a data globe. TerraViz's rule holds: a display
  transform never changes a reported value, and decoration that obscures the
  field is a regression, not a feature.
- **Not replacing curator judgement.** D1 orders what a curator already
  approved. It does not select datasets or approve events.

## 7. Conventions any implementation must follow

- Pure transform in `src/services/` or `functions/api/v1/_lib/`, thin wiring in
  `src/ui/` — the split `catalogGraph.ts` / `catalogGraphUI.ts` models.
- A module-map row in `CLAUDE.md` (or `docs/BACKEND_MODULES.md`) in the same PR;
  `npm run check:doc-coverage` enforces it.
- Every user-facing string through i18n; a `Scene` in
  `scripts/screenshots/scenes.ts` for any new UI surface.
- DCO sign-off on every commit.

## 8. Open questions

1. ~~Does D1 belong server-side or in a shared module the SPA can also call?~~
   **Resolved:** server-side, in `resolveStopDatasets`. It lives beside
   `event-tour.ts` rather than inside it because the truncation it corrects is
   in the resolver, not the task builder. A shared module for ad-hoc SPA
   sequences can wrap the same pure function if a use for one appears.
2. Should the D2 descriptor be a dataset column or a sidecar, given federation
   will need to decide whether peers exchange it? The live path forces the
   question: a time series is not a column, and a peer publishing vital signs is
   asserting something about its own data quality.
3. Is D4's usable range a publisher-only field, or something a federated peer
   should honour on an imported dataset?
4. Now that tubeviz is Apache-2.0, should Zyra *use* its audio and
   visual-feature modules rather than reimplement them? Needs a check of Zyra's
   own licence and a view on vendoring a few pure functions (SPDX header intact)
   versus taking a dependency.
5. D2a and D3 both want a Zyra stage that reduces the source grid per cycle.
   One stage emitting both a temporal profile and a statistics row, or two?
   Deciding this before either is built avoids a second pass over the data.
