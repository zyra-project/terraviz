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

**tubeviz is upstream and stays upstream.** Nothing in this plan asks anything
of that project, and no issues have been or should be filed there on the
strength of this document.

## 3. Licensing — what we may and may not take

**tubeviz publishes no LICENSE file.** Default copyright therefore applies: all
rights reserved. That is not an oversight we can route around, and it is
decisive here.

TerraViz is Apache-2.0, and [`CONTRIBUTING.md`](../CONTRIBUTING.md) is explicit:

> Do not contribute code or assets you don't have rights to. If you include
> third-party code, data, or media, ensure it is compatible with the Apache
> License, Version 2.0 and include proper attribution as required by the
> original license.

Unlicensed code is not Apache-2.0 compatible. There is nothing to comply with,
because no permission was granted. Our DCO sign-off is a certification that we
have the right to submit the work — copying here would make that attestation
false.

| | Allowed | Why |
|---|---|---|
| Copy source files, functions, or shaders | **No** | No licence grant exists |
| Vendor a module, even with attribution | **No** | Attribution is not a substitute for permission |
| Port a file line-by-line to TypeScript | **No** | A translation is a derivative work |
| Build a feature from the same *idea* | **Yes** | Copyright covers expression, not ideas or methods |
| Implement a published algorithm | **Yes** | Sobel, RDP, Chaikin, Delaunay, block-matching and marching squares are classical and independently documented — we already implement marching squares in [`datasetContours.ts`](../src/services/datasetContours.ts) |
| Credit tubeviz as the inspiration | **Yes, and we will** | Courtesy and honesty; see below |

### How we implement, concretely

- **Specify behaviour, not structure.** Each feature below is written as what
  TerraViz should do, in TerraViz's own architecture. None of them mirror
  tubeviz's module layout, type names, or call graph.
- **A caveat worth stating plainly.** This plan was written after reading
  tubeviz's source, so it is *inspired by*, not clean-room in the strict sense
  (spec writer and implementer independent). The exposure was architectural
  rather than algorithmic, the target language and domain differ, and nothing
  below depends on a specific implementation of anything. If a feature ever
  narrows to "do the exact thing tubeviz does in the exact way", stop and
  reconsider.
- **Do not launder it through a model.** Putting tubeviz source into an LLM
  context and asking for a reimplementation is not clean-room, whatever the
  output looks like. It is out of bounds under
  [CONTRIBUTING.md §LLM Integrations](../CONTRIBUTING.md) and under §3 generally.
- **Credit lands in three places:** this document, a one-line header comment in
  each module that grew from a tubeviz idea, and the PR description. Credit
  names the project and its author, and must not imply endorsement or suggest
  tubeviz is licensed for reuse.

### If we ever want the actual code

The unlock is one small ask: that tubeviz add a licence. MIT or Apache-2.0 would
let us vendor specific algorithms with a NOTICE entry — Apache-2.0 matching ours
and carrying a patent grant. That is a courteous request to make of an upstream
maintainer, not a demand, and this plan does not depend on the answer. Every
feature below is buildable with no code from tubeviz at all.

## 4. Candidate features

### D1 — Shot sequencing for generated tours

**What.** A pure `orderTourStops(candidates, opts)` that chooses the *order* of
matched datasets rather than accepting the matcher's ranking: penalise a stop
that shares a category, keyword cluster or bounding box with the one before it;
reward the strongest match at the opening; keep a strong stop in reserve for the
close.

**Where.** Alongside [`event-tour.ts`](../functions/api/v1/_lib/event-tour.ts),
consumed by `buildEventTourTasks` before the `slice(0, MAX_TOUR_STOPS)`. Pure
transform, no I/O — the shape [`catalogEvents.ts`](../src/services/catalogEvents.ts)
and [`catalogGraph.ts`](../src/services/catalogGraph.ts) already follow, and
directly unit-testable on literal candidates.

**Cost.** Low. Metadata only: no GPU, no new storage, no migration. The match
score already exists.

**Recommendation.** Build first. It is the cheapest of the four and fixes the
most visible problem.

### D2 — Dataset visual fingerprint

**What.** A small persisted numeric descriptor per dataset — value distribution,
spatial complexity, coverage, dominant character — computed once at publish
time and stored on the dataset record.

**Uses.** Gives D1 a real variety signal instead of category proxies; lets
[`heroService.ts`](../src/services/heroService.ts) avoid picking visually
similar heroes on consecutive days; adds a visual axis to the lexical
[`relatedDatasets.ts`](../src/services/relatedDatasets.ts) alongside the
semantic [`relatedDatasetsService.ts`](../src/services/relatedDatasetsService.ts).

**Where.** Publisher-side, next to
[`globeThumbnail.ts`](../src/services/globeThumbnail.ts) — which already decodes
and renders a frame at publish time, so the fingerprint rides along on a read we
already pay for.

**The constraint that decides this.** It must *not* be a client-side catalog
sweep. [`glLumaSampler.snapshot()`](../src/services/glLumaSampler.ts) is
deliberately a user-initiated whole-frame GPU readback, never a background or
pointer path, and [`datasetStats.ts`](../src/services/datasetStats.ts) reduces
one snapshot at a time. Fingerprinting the catalog through that path would
invert a deliberate design decision. Publish-time is the only correct home.

**Cost.** Medium: a stored field, a migration, and publisher-pipeline work.

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
| 1 | **D1** shot sequencing | Pure transform + tests; no schema change |
| 2 | **D4** usable range | Migration + portal control + three clamps |
| 3 | **D2** fingerprint | Depends on D4 for accuracy; publish-time only |
| 4 | **D3** data-driven pacing | Parked; needs a Zyra temporal-profile stage |

Each phase is independently shippable and independently reversible.

## 6. Non-goals

- **Not importing tubeviz code.** See §3. This is a constraint, not a phase.
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

1. Does D1 belong server-side (in `event-tour.ts`, so every consumer of a
   generated tour gets it) or in a shared module the SPA can also call for
   ad-hoc sequences?
2. Should the D2 fingerprint be a dataset column or a sidecar, given federation
   will need to decide whether peers exchange it?
3. Is D4's usable range a publisher-only field, or something a federated peer
   should honour on an imported dataset?
