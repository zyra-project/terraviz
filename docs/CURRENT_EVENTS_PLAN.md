# Current Events ↔ Real-Time Data Plan

A way for a Terraviz node to collect **reputable** current-events
information — news stories and authoritative-organisation reporting —
about things happening *right now* that relate to the node's real-time
datasets, and to use that information to **draw** visitors to notable
features and **guide** them from a headline into the data that explains
it.

> **Status: draft for review.** No code, no migrations, no bindings
> have been added yet. This document aligns on the idea, surveys prior
> art, and proposes an architecture grounded in existing Terraviz
> modules before anything ships. Scope of the "reputable data" in this
> plan is deliberately **news / authoritative organisations only** —
> social media is a separate, later question (see Non-goals). Companion
> to [`CATALOG_BACKEND_PLAN.md`](CATALOG_BACKEND_PLAN.md) and
> [`CATALOG_DATA_MODEL.md`](CATALOG_DATA_MODEL.md).

---

## 1. Problem & goals

Terraviz / Science on a Sphere ships real-time scientific datasets —
hurricane tracks, sea-surface temperature, active-fire detections, air
quality, sea ice, lightning. A visitor who just read a headline about a
hurricane, a wildfire, or a heat wave lands on a globe full of data with
**no bridge** between *what they read* and *the data that explains it*.
They have to already know which dataset is relevant, find it in the
catalog, load it, and seek to the right time. Most won't.

The goal is to build that bridge. Two distinct jobs:

- **Draw** — surface the notable current events happening *now* that the
  node has live data for, so the catalog landing experience answers
  "what's worth looking at today?" with something timely and real.
- **Guide** — once a visitor is curious about an event, walk them from
  the headline to the matching live dataset with an editor-vetted, cited
  explanation of how the two connect.

Success looks like: a visitor who read about Hurricane season lands on
the matching live satellite loop, positioned and time-seeked, beside a
one-line "why this matters" that links out to the reputable source it
came from.

### Design tenets

- **Reputable by construction.** Every user-visible item carries a
  source citation, and nothing reaches end-users without a curator
  approving it. Trust comes from source allow-listing plus a human in
  the loop — not from an algorithm's confidence.
- **Node-relative, not subject-specific.** What counts as a relevant
  "current event" is defined by *this node's own catalog*, never by a
  hardcoded subject area. A node about Earth science wires an
  Earth-science feed; a node about something else wires a feed that fits
  it, or none at all. There is no default feed baked into the product,
  and matching always runs against the node's own datasets — so the
  feature is meaningful on any node, not just a Science-on-a-Sphere one.
- **Annotate, don't replace.** A current event is a thin record that
  *points at* datasets. It never competes with the dataset as the unit
  of content; it is a timely doorway to it.
- **Reuse the chassis.** The matching, storage, search, and presentation
  primitives this needs already exist in the codebase. This plan adds a
  small amount of new surface and leans on what is there.
- **Graceful absence.** When nothing notable is happening, the surfaces
  quietly show nothing — exactly as `heroService.getHeroCandidate()`
  already returns `null` rather than inventing a hero.

---

## 2. Existing solutions & best practices

The "news event on a map of Earth data" problem is well-trodden. The
strongest precedents are all built on *authoritative, structured* feeds
rather than open social firehoses — which is also where we want to
start.

| System | What it does | What we borrow |
|---|---|---|
| **NASA EONET** (Earth Observatory Natural Event Tracker) | A curated, openly-licensed feed of natural events (storms, wildfires, volcanoes, icebergs) each tagged with geometry, time, category, and links to the satellite imagery layers that show it. | The canonical data model: an *event* object decoupled from the imagery, carrying geometry + time + category + source links. This is almost exactly the `CurrentEvent` shape below. |
| **NASA Worldview "Events" tab** | Plots EONET events on the map; clicking one flies the camera there and loads the relevant imagery layer at the right date. | The exact interaction we want on the catalog Map and in Orbit: *event marker → fly + load the matching dataset at the matching time.* |
| **GDELT Project** | An open, continuously-updated database of world events mined and geocoded from global news coverage. | A pattern (not a Phase-1 dependency) for turning *news articles* into geo/time-stamped, machine-readable event records — the automation path once structured feeds are proven. |
| **NWS / USGS / GDACS / Copernicus EMS** | Authoritative structured hazard feeds — CAP weather alerts, earthquake GeoJSON, disaster activations, fire/flood mapping. | High-precision, low-moderation-risk seed feeds. These are the lowest-risk way to bootstrap because they are already structured, sourced, and trustworthy. |
| **Wikipedia Current Events Portal** | A human-curated daily log of significant events, every entry citing its sources. | Editorial discipline: provenance, citation, and neutrality as non-negotiable per-item requirements. |
| **Google Crisis Map / Public Alerts** | Overlays authoritative alerts on a map during emergencies, each clearly badged with its issuing authority. | Freshness-and-decay UX and unambiguous source badging — the visitor always knows *who said this*. |

### Best-practice principles distilled

These recur across every system above and become hard requirements:

1. **Source allow-listing.** Ingest only from a vetted list of
   authoritative organisations. New sources are added deliberately, not
   discovered automatically.
2. **Provenance on every item.** Source name, source URL, and publish
   time are mandatory fields. An item with no citation cannot be stored.
3. **Freshness decay.** Events age out. A current-events surface that
   shows a week-old "breaking" item destroys its own credibility.
4. **Curator in the loop.** Automated matching *proposes*; a human
   *approves*. This is the single most important lever for keeping the
   "reputable" promise.
5. **No editorialising beyond the source.** The node summarises and
   links; it does not add claims the cited source didn't make, and it is
   explicitly **not** a fact-checking or misinformation-verdict engine.
6. **Graceful absence.** Better to show nothing than to manufacture
   relevance. Surfaces hide when there's no vetted, in-window event.
7. **Node-appropriate sourcing.** Which feed(s) a node ingests is
   configured per node to fit its catalog — not a built-in default. The
   pipeline (provenance, allow-listing, matching, curator gate) is
   source-agnostic and the connectors are pluggable; a node ingests
   nothing until an operator wires a feed appropriate to what it hosts.

---

## 3. Data model — the `CurrentEvent` object

A new first-class record that *annotates* datasets, mirroring EONET's
decoupling of events from imagery. It reuses the field conventions
already established for `Dataset` in `src/types/index.ts` — NSWE
`boundingBox`, ISO-8601 times, `categories`/`keywords` vocabulary — so
the matching and presentation code can treat events and datasets with
the same primitives.

```
CurrentEvent {
  id, title, summary,
  sourceUrl, sourceName, publishedAt,        // provenance — mandatory
  occurredStart, occurredEnd?,               // ISO 8601 — the event's own time span
  geometry: {                                 // at least one of:
    boundingBox?,                             //   NSWE, same shape as Dataset.boundingBox
    point?,                                   //   { lat, lon }
    regionName?,                              //   resolved via src/data/regions.ts
  },
  categories[], keywords[],                   // same vocabulary as enriched.categories/keywords
  relatedDatasetIds[],                        // the proposed / approved links to datasets
  status: 'proposed' | 'approved'            // curator gate — only 'approved' is user-visible
        | 'rejected' | 'expired',
  matchSignals: { geo, temporal, semantic },  // why the matcher proposed each link (for review)
}
```

### Storage

Maps onto the existing D1 catalog backend (`docs/CATALOG_DATA_MODEL.md`,
`migrations/catalog/`) with **no new infrastructure** — D1, R2 (for
event thumbnails), Vectorize, and the job queue all already exist:

- `current_events` — one row per event, columns mirroring the shape
  above; `status` drives visibility exactly as `datasets.visibility`
  does today.
- `event_dataset_links` — a join table `(event_id, dataset_id,
  match_score, signals_json, approved_at, approved_by)`. The reverse
  index (dataset → its approved events) powers the per-dataset "In the
  news" panel.

Both follow the established decoration-table pattern
(`dataset_tags` / `dataset_categories` / `dataset_keywords`) and the
audit conventions (`audit_events`) already in the schema.

---

## 4. Matching engine (hybrid: auto-propose → curator approve)

The matcher answers "which datasets does this event relate to?" with
three independently-scored signals, combined into a ranked proposal
list. Critically, its output is `status: 'proposed'` — **nothing is
shown to end-users until a curator approves it.**

- **Geographic** — overlap of the event's geometry with each dataset's
  `boundingBox`. Reuses `src/data/regions.ts` (`resolveRegion`,
  `boundsToGeoJSON`, ~120 named bounding boxes, antimeridian-aware) and
  the dataset bbox model. A named region in a headline ("the Gulf of
  Mexico") resolves to a bbox and intersects directly.
- **Temporal** — the event's time vs. each dataset's *liveness*, using
  the existing `isLiveCadence()` / freshness-window logic
  (`src/utils/time.ts`; `heroService.AUTO_DERIVE_WINDOW_MS`). A live
  hurricane loop updating every 15 minutes is a far better match for a
  current storm than a static decadal climatology — the temporal signal
  encodes that.
- **Semantic** — embed the event's `title` + `summary` with the *same*
  `@cf/baai/bge-base-en-v1.5` pipeline used for datasets
  (`functions/api/v1/_lib/embeddings.ts`) and query Vectorize
  (`vectorize-store.ts`, `search-datasets.ts`) for the nearest datasets.
  This reuses the existing job queue (`job-queue.ts`,
  `embed-dataset-job.ts`): an `embed_event` job is enqueued exactly as
  `embed_dataset` is on dataset publish.

The lexical component of scoring reuses the spirit of
`relatedDatasets.scoreRelatedness()` (categories weighted ×2 over
keywords). The three signals are surfaced individually in `matchSignals`
so the curator can see *why* a link was proposed when reviewing it.

---

## 5. Curator review surface

A new privileged page in the publisher portal (`src/ui/publisher/pages/`,
e.g. `events.ts`) — an **event review queue**. Each entry shows a
proposed event, its source citation, the datasets the matcher linked,
and the per-signal match scores, with **Approve / Edit / Reject**
controls. Editing lets a curator fix the summary, swap the matched
dataset, or adjust the time window before approving.

This reuses the portal's existing chassis wholesale: Cloudflare Access
auth and the `admin` / `publisher` roles, the `audit_events` log (every
approve/reject is recorded), and the portal scaffolding (router, shared
API client, `error-card`, `topbar`). It is the human-in-the-loop that
upholds the reputable promise, and it is the one genuinely new
end-to-end surface Phase 1 must build.

---

## 6. The four presentation surfaces

Where approved events reach visitors. Each names the existing module it
extends, to keep the work bounded.

1. **"Right now" hero feed** *(Draw)* — extend `HeroOverride` in
   `src/services/heroService.ts` with an optional `eventId`, so the
   freshest **approved** event can headline the catalog landing surface,
   pairing a one-line cited "why this matters" with the matching live
   dataset. Pinning flows through the existing `/api/v1/featured-hero`
   endpoint and the `featured-hero.ts` admin page — the curator queue
   can promote an approved event straight into the hero slot, and the
   existing window/expiry logic ages it out automatically.
2. **Orbit docent** *(Guide)* — add a `search_events` discovery tool to
   `src/services/docentContext.ts` (same JSON-Schema function-calling
   shape as `search_datasets`), inject approved in-window events into the
   `[RELEVANT DATASETS]` block, and add an `<<EVENT:ID>>` marker handled
   by `docentService.extractActionsFromText()` so Orbit can narrate a
   headline and one-tap load the dataset that explains it. This honours
   the existing anti-hallucination rule — Orbit may only name an event or
   dataset whose ID came from a tool result or an injected block — so the
   only events it can cite are curator-approved ones.
3. **Catalog Map + Timeline overlays** *(Draw + Guide)* — add events as a
   new facet group in the pure transforms `src/services/catalogMap.ts`
   (event footprints / points, click-through to the linked dataset) and
   `src/services/catalogTimeline.ts` (event rows on the shared time axis,
   styled like the existing real-time markers). This mirrors NASA
   Worldview's Events tab directly.
4. **Per-dataset "In the news" panel** *(Guide)* — when a dataset is
   loaded, show its approved related events (reverse lookup over
   `event_dataset_links`) in the info panel, each a cited card linking
   to the source. Reuses the info-panel surface owned by
   `src/services/datasetLoader.ts`.

---

## 7. Optional: auto-generated "current events tour" *(stretch)*

A `generateEventTour(event)` helper emitting standard `tourEngine.ts`
tasks — `flyTo` → `setTime` → `loadDataset` → caption — turns a breaking
event into a ~30-second guided explainer with zero authoring effort.
This composes the existing tour task vocabulary and playback state
machine; it is a natural Phase 3 payoff once events, matching, and the
in-app surfaces exist, and is explicitly **not** part of Phase 1.

---

## 8. Non-goals

- **No social media** (X / Bluesky / Reddit / etc.) in this plan. The
  ToS, cost, and content-moderation burden are a different class of
  problem; revisit only as a separate, clearly-caveated phase if the
  authoritative-source path proves valuable.
- **No fully-automated publishing.** Every user-visible event↔dataset
  link is curator-approved. The matcher only ever proposes.
- **No new storage infrastructure.** Reuse D1 / R2 / Vectorize / the
  job queue. If a design step seems to need a new binding, that's a
  signal to reconsider the design.
- **Not a misinformation or fact-checking engine.** Trustworthiness
  comes from source allow-listing and human review, not from automated
  truth verdicts. The node never adjudicates a claim.

---

## 9. Phasing

### Phase 1 — the slice to build first

Prove the entire **ingest → match → approve → surface** loop end-to-end
on the lowest-risk feed, with the smallest user-facing footprint:

- Wire **one authoritative structured feed appropriate to the node's
  catalog** as the first connector. For this reference deployment —
  Science on a Sphere, an Earth-science catalog — NASA **EONET** is the
  natural pick: geo- and time-tagged, openly licensed, no scraping or
  ToS risk, and its content (natural events on Earth) is the closest
  possible fit to SOS datasets. EONET is an *example connector*, not a
  product default — a node with a different catalog wires a different
  feed (or none) behind the same source-agnostic pipeline.
- Add the `current_events` + `event_dataset_links` D1 tables.
- Build the **geographic + temporal** matcher (defer semantic/Vectorize
  to Phase 2 — geo + time alone are strong for natural-hazard events).
- Build the **curator review queue** (the one new portal page).
- Light up **one** end-user surface: the **"Right now" hero feed**.

This is the minimum that demonstrates the full pipeline and the trust
model, on the safest source, before investing in breadth.

### Phase 2 — breadth

- Add the **semantic (Vectorize) matcher** for fuzzier topical matches.
- Light up the remaining surfaces: **Orbit**, **Map + Timeline
  overlays**, and the **per-dataset "In the news" panel**.
- Add **news-API / GDELT** ingestion behind the same allow-list +
  curator gate.

### Phase 3 — guided experiences & sharing

- **Auto-generated event tours** (§7).
- Multi-feed fusion and de-duplication across sources.
- **Federation-aware event sharing** between nodes — gated on Phase 4
  federation; see the freshness note below.

---

## 10. Federation note

Event-sharing *across* nodes (a peer subscribing to another node's
approved current events) overlaps the federation work. The governing
artifact is
[`architecture/federation-scoping.md`](architecture/federation-scoping.md),
**Last reviewed 2026-05-04** — within the ~6-month freshness window
defined in `CLAUDE.md`, and with none of its "Revisit when" triggers yet
hit (Phase 4 has not shipped; its ETA has not slipped two quarters past
the review date). Its directives are therefore **current**: any
cross-node event-sharing design (a Phase 3 concern) must follow §7 and §8
of that doc rather than inventing a parallel mechanism.

Current-events ingestion itself is designed to land **before**
federation, one-way into the canonical node, so Phase 1 and Phase 2 do
**not** block on Phase 4. Only the Phase 3 cross-node sharing piece
does. Re-verify the federation doc's freshness markers at the start of
that Phase 3 work.
