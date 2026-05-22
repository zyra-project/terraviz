# Web Catalog Features Implementation Plan

> **Status: draft for review.** Synthesised from the Google Doc
> ["TerraViz (Zyra Sphere) > Web Catalog"](https://docs.google.com/document/d/1ohA6KRsiawDNYF2q8NJWwVLfLEJ5utsHUqxpBewqDgk/edit?usp=drivesdk)
> (last modified 2026-05-21), which collects feature requests
> from Adrian, Beth, and Hilary scoping TerraViz as a catalog
> replacement for the SOS website.
>
> Branch: `claude/web-catalog-features-plan`.

The Google Doc gathers 17 requests across three reviewers. This
plan triages each request against the current codebase, groups
the work into shippable phases, and flags the items that depend
on the in-flight `CATALOG_BACKEND_PLAN.md` work before they can
land.

The plan is intentionally **scoped to catalog features only** —
the source doc is explicit that this phase ignores non-catalog
work — and it deliberately favours small, independently
landable phases over a single multi-month branch.

---

## 1. Framing

### 1.1 What the requesters actually want

Reading the doc as a whole — not request-by-request — three
themes dominate:

1. **Catalog-first UX.** Adrian's "grid view", Hilary's
   "catalog and sphere tab", and Adrian's `?catalog=true`
   URL hint all describe the same thing: a mode where the
   *catalog* is the primary surface and the globe only
   appears once a dataset is selected. Today the browse UI
   is a glass overlay on top of an always-on globe; the ask
   is to invert that relationship for catalog visitors.
2. **Info panel completeness.** Beth and Hilary together
   list six fields the current SOS catalog exposes that
   TerraViz hides today (full description, credits,
   developer, contact, data-added date, downloadable
   thumbnail). The data model already has every one of
   these — the gap is purely presentational.
3. **Playback fidelity.** Both Beth and Hilary independently
   flagged the same time/frame bug — labels advance by one
   cadence while the imagery advances by another, so a
   yearly-frame climate dataset shows the same image for 12
   button-presses while the month label crawls forward.
   This is a real correctness bug, not a polish item.

The remaining items — full-screen, UI scaling, shader work,
playlists, zip downloads — are individually meritorious but
share less narrative weight in the doc. They should be
sequenced after the three core themes.

### 1.2 What's already in the codebase

A few requests are already partly built; the gap is exposure or
correctness, not net-new feature work:

| Request | What exists today | Gap |
|---|---|---|
| Grid view | [`src/ui/browseUI.ts`](../src/ui/browseUI.ts) is **already a card grid**, not a list. | The mental model of a list-first browse comes from the overlay+globe framing. The real ask is catalog-first routing (§3). |
| Related datasets | [`EnrichedMetadata.relatedDatasets`](../src/types/index.ts) rendered in info panel at [`datasetLoader.ts:387`](../src/services/datasetLoader.ts). | Exact-title matches only — no algorithmic recommendation. |
| Closed captions | SRT loader + parser at [`playbackController.ts:215`](../src/ui/playbackController.ts), proxied via `video-proxy.zyra-project.org/captions`. | CC button visibility and SRT presence aren't surfaced in the catalog or info panel. |
| Credits / source / data-added | All present in `EnrichedMetadata` (`datasetDeveloper`, `visDeveloper`, `dateAdded`, `catalogUrl`). | Not rendered in the info panel. |
| Thumbnails | `Dataset.thumbnailLink` shown in browse cards. | Not shown or downloadable in the info panel. |
| Download as zip | Desktop has [`downloadService.ts`](../src/services/downloadService.ts) (Tauri-only). | Web has no equivalent. |
| All SOS datasets | Catalog points to `metadata.sosexplorer.gov/dataset.json` (one snapshot — 204 datasets, 176 visible). | See §1.4 — the enriched metadata file in the repo already covers 415 additional datasets; surfacing them is UI work, not federation. |

This matters for sequencing: items in the "already exists,
expose it better" column belong in an early, low-risk phase;
items requiring a new subsystem (catalog routing, web downloads,
shader rewrite) belong later.

### 1.4 Data audit

Cross-referencing the live catalog against the enriched
metadata file in the repo gives sharper guidance on
sequencing — especially for Beth's "all SOS datasets" request
(#10) and the filter inventory (#15).

**Sources audited:**

- Live catalog: `https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/dataset.json` (the source `dataService.ts` fetches today).
- Enriched metadata: [`public/assets/sos_dataset_metadata.json`](../public/assets/sos_dataset_metadata.json), 1.8 MB, merged client-side.
- Authoritative catalog: <https://sos.noaa.gov/catalog/datasets/>.

**Counts:**

- Live catalog: **204 datasets, 176 visible, 28 hidden** (the SOSx subset TerraViz exposes today).
- Enriched metadata: **520 datasets** total. `available_for` field marks **499 SOS** and **176 Explorer** (overlapping sets — 415 of the 520 are not in the live catalog at all).

**Filter taxonomy (live catalog `tags` field — 11 distinct):**

| Tag | Count | Tag | Count |
|---|---|---|---|
| Water | 80 | Real-Time | 10 |
| People | 63 | Tours | 8 |
| Air | 56 | Snow and Ice | 7 |
| Land | 39 | Layers | 1 |
| Movies | 35 | Extras | 1 |
| Space | 34 | | |

This is the *baseline* filter chip set Phase 4 should ship —
it matches what the live catalog already labels datasets with.
The single-count tags (Layers, Extras) are edge cases and can
be de-emphasised or rolled into a default chip set.

**Asset availability for SOS-only datasets:** every entry in
the enriched file has a `movie_preview` URL; 501 of 520 also
have `ftp_download`. Surfacing the 415 SOS-only datasets is
therefore feasible without backend changes — the asset
quality is lower than the SOSx subset's Vimeo HLS streams,
which is the honest tradeoff to surface in the UI.

**What's missing.** The screenshot of the SOS catalog filter
panel (shared in review) shows additional facets we do **not**
have in either data source: **Theme** (separate from Keyword),
**Year** (data-coverage range, 500–2100), and a four-filter
**Next Generation Science Standards** bundle — Minimum Grade
Level, Maximum Grade Level, Cross-cutting Concepts, and
Disciplinary Core Ideas. None of these terms appear in
`metadata.sosexplorer.gov/dataset.json` or
`public/assets/sos_dataset_metadata.json`. Reaching parity
requires importing additional metadata from the SOS catalog
backend (likely a WordPress export, a direct database dump, or
a scrape of the dataset detail pages — open question for the
SOS team). §1.6 covers how this interacts with federation.

The screenshot also confirms one design point: **the SOS
catalog already has a "View My Playlist" button.** Adrian's
playlist request (§8.1) is therefore not a net-new feature
for SOS users — it's parity with existing functionality,
which raises the bar slightly on what "good" looks like.

### 1.6 Federation forward-compatibility for facets

The user's question on review — "in a federated catalog
environment how we might want to implement custom search
facets" — is genuinely unanswered today. Capturing the
tension here, with the design itself deferred to the
federation-scoping doc (per `CLAUDE.md`'s direction that
federation work follows
[`docs/architecture/federation-scoping.md`](architecture/federation-scoping.md)).

**What exists.**
[`docs/CATALOG_DATA_MODEL.md`](CATALOG_DATA_MODEL.md) (and
duplicated in `CATALOG_BACKEND_PLAN.md`) already defines a
`dataset_categories(dataset_id, facet, value)` table — a
flexible facet store where `facet` is free-text ("Theme",
"Region", and by extension "NGSS.MinGrade", "NGSS.CCC", etc.).
This is the right primitive. The data model is forward-compatible.

**What doesn't exist.** There is no mechanism for a federated
peer to **advertise** which facets it indexes, and no
guarantee that two peers use the same facet vocabulary. If
the SOS node exposes a `Theme` facet with one set of values,
and a partner node exposes `Theme` with completely different
values, the consumer UI has no way to know — chip filters
would either become incoherent (mixed vocabularies) or get
clamped to a hardcoded subset (defeating the federation
goal).

**Sketch for federation-scoping.md to absorb.** Three pieces
needed:

1. **Facet schema declaration.** Each peer's well-known
   document (`/.well-known/terraviz.json`) gains a
   `facet_schema` field — a list of `{ facet, label, type,
   values? }` entries declaring which facets the peer
   indexes. `type` distinguishes enumerated vocabularies
   (controlled list — Theme, NGSS grade level) from
   open-ended (free-text — keyword) from range (numeric or
   year). `values?` is provided when `type` is enumerated.
2. **Facet vocabulary alignment.** Reserve a well-known
   namespace (`sos:*`, `ngss:*`, `terraviz:*`) for shared
   vocabularies, with `local:*` for peer-specific extensions.
   A consumer can render `sos:theme` and `ngss:min_grade`
   filters confidently; `local:*` filters are surfaced only
   when the user has explicitly subscribed to that peer.
3. **Federated query degradation.** When a UI builds a query
   that includes a facet some peers don't advertise, that
   peer is queried without the filter (returning a superset).
   Results are tagged with which facets matched so the UI can
   indicate "results from peer X were not filtered by NGSS
   grade level".

**This plan's posture.** Phase 4 (§6.1) ships the **baseline**
facets that work today — tags, format, date_added, plus the
new SOS facets *once the SOS team provides the metadata*. The
client predicate engine (`src/services/datasetFilter.ts`,
new) is designed against a generic
`Record<facetName, FacetPredicate>` shape so the federation
extension lands without an API rewrite. The authoritative
federation facet design — schema declaration, vocabulary
alignment, query degradation — should be added to
`docs/architecture/federation-scoping.md` §8 as a new resolved
decision before Phase 4 federation work begins.

### 1.7 Non-goals

To keep the branch scoped, the following are explicitly **out**:

- Replacing or augmenting the existing tour engine — playlists
  are a sibling concept, not a tour extension.
- Backend work on the catalog node — this plan assumes the
  current `dataService.ts` data source is fixed for now.
  Federation-quality high-fidelity assets for the 415 SOS-only
  datasets remain on the federation track (§9.1).
- VR / AR changes — the doc is explicit that catalog work is
  the scope.
- Localisation of net-new strings is **not** a non-goal — every
  new user-facing string follows the i18n flow in `CLAUDE.md`
  (`t(...)` keys + `npm run check:i18n-strings`).

---

## 2. Triage table

Every request from the source doc, in source order, with a
feasibility verdict and the phase it lands in.

| # | Request (requester) | Verdict | Phase | Notes |
|---|---|---|---|---|
| 1 | Full-screen button — bottom right (Adrian) | **Yes** | 1 | Standard Fullscreen API; one button, ~50 lines + CSS. |
| 2 | Grid view as default in catalog mode; globe hidden until selection (Adrian) | **Yes — reframed** | 1 | Browse is already a grid. The real ask is a `?catalog=true` route where the globe is hidden until selection. |
| 3 | Playlists, local-storage scoped (Adrian) | **Yes** | 6 | Net-new feature; deferred until catalog UX has settled. |
| 4 | Download source data as zip (Adrian) | **Partial** | 6 | Image datasets feasible (JSZip); HLS videos require backend re-encoding to a single MP4 — covered partially by existing desktop downloads. |
| 5 | Increase UI size, ~150% default (Adrian) | **Yes** | 5 | Introduce `--ui-scale` token; settings option. Whole-app pass needed because spacing is currently hardcoded per-component. |
| 6 | Improve globe shader — contrast, saturation, less specular, normal maps (Adrian) | **Yes — partial** | 5 | In-shader saturation/contrast is straightforward; normal maps require sourcing a global normal map and either re-baking the GIBS tile shader or wiring it through `photorealEarth.ts`. |
| 7 | Frame-by-frame scrolling with labels matching (Beth) | **Yes — bug fix** | 3 | Real bug. `inferDisplayInterval` snaps to year boundaries; labels advance by month. Needs a frame-aware cadence. |
| 8 | Closed captions visible (Beth) | **Yes** | 3 | Loader exists; CC button visibility and SRT-presence indicator missing. |
| 9 | Related datasets at bottom of description (Beth) | **Yes** | 2 | Exact-title matches today; upgrade to category/keyword-based recommendation. |
| 10 | All SOS datasets, not just SOSx (Beth) | **Yes — partial** | 4 | Reframed after data audit (§1.4). 415 SOS-only datasets already live in the repo's enriched metadata file with `movie_preview` URLs — surfacing them is UI work, not federation work. High-fidelity assets remain federation-track. |
| 11 | Display full description + notable features (Beth) | **Yes** | 2 | Truncated at 600 chars on a sentence boundary. Add expand/collapse + scrollable variant. |
| 12 | Display credits and source (Beth) | **Yes** | 2 | Fields exist in `EnrichedMetadata`; just render them. |
| 13 | Data Added (Beth) | **Yes** | 2 | `enriched.dateAdded`, already in metadata; render. |
| 14 | Downloadable thumbnails (Beth) | **Yes** | 2 | `thumbnailLink` already in data; add download link to info panel. |
| 15 | All filters currently in the catalog (Beth) | **Yes** | 4 | Need an inventory of SOS catalog filters first — open question for the requesters. |
| 16 | Catalog ↔ sphere tab toggle (Hilary) | **Yes** | 1 | Same surface as #2. |
| 17 | Fix time and frame issue (Hilary) | **Yes — same as #7** | 3 | Duplicate of #7; tracked together. |

**Counts.** 15 feasible and in-plan; 2 partial (zip downloads,
all SOS — preview-quality only until federation lands); 1
duplicate of another (#17 = #7). That's 16 unique tracked
items across 6 phases.

---

## 3. Phase 1 — Catalog-first UX

**Theme.** Make TerraViz feel like a catalog by default. Adds a
new top-level mode where the globe is hidden until the user
selects a dataset, plus the full-screen affordance Adrian asked
for.

**Estimated size.** ~1–1.5 weeks of focused work. One PR per
sub-phase.

### 3.1 `?catalog=true` route + globe hide

The current entry path is "globe up immediately, dataset
optionally loaded via `?dataset=<id>`." The new entry path is:

1. `?catalog=true` (no dataset) → render the browse panel
   as a full-viewport surface, globe canvas hidden.
2. `?catalog=true&dataset=<id>` → render the browse panel
   collapsed, globe canvas visible, dataset loaded. Equivalent
   to today's default but with a persistent "back to catalog"
   affordance.
3. `?dataset=<id>` (no `catalog`) → today's behaviour
   unchanged. Direct globe entry for embeds and shared links.
4. `/` (no params) → **open question** for requesters:
   should the default landing experience be globe-first
   (today) or catalog-first (new)? See §10.

`deepLinkService.ts` already parses `?dataset=`. The same
pattern adds a `getCatalogMode()` reader; `main.ts` orchestrates
the visibility toggle.

### 3.2 Globe ↔ Catalog tab control

Hilary's "catalog and sphere tab so they can easily be flipped
back and forth" is the same UX as a two-state segmented
control pinned to the top of the viewport when `catalog=true`
is active:

```
┌─────────────────────────────────────────────┐
│  [ Catalog ] [ Sphere ]            ⛶ fullscreen │
└─────────────────────────────────────────────┘
```

`pushState` swaps the URL between `?catalog=true&dataset=X`
and `?dataset=X` without reloading. The two states share a
single mounted `MapRenderer` — we hide its container, not
unmount it, to avoid a full GIBS re-fetch on every tab flip.

### 3.3 Fullscreen button

Adrian's request: bottom-right. The Fullscreen API is
well-supported in evergreen browsers and in Tauri's webview.
Add a button to the existing `mapControlsUI.ts` cluster (already
right-aligned), wire to `document.documentElement.requestFullscreen()`,
listen for `fullscreenchange` to swap the icon. Accessible name
via `t('mapControls.fullscreen.enter')` / `.exit`.

### 3.4 Files touched

| File | Change |
|---|---|
| `src/services/deepLinkService.ts` | New `getCatalogMode()`, `setCatalogMode(on)` with `pushState`. |
| `src/main.ts` | On boot, branch on `getCatalogMode()`. Hide `#maplibre-container` (visibility: hidden, not display:none — keeps the canvas alive). |
| `src/ui/browseUI.ts` | Add a "full surface" rendering mode; today's overlay is the default. |
| `src/ui/catalogTabsUI.ts` | **New.** Segmented control at top of viewport, only visible in `catalog=true`. |
| `src/ui/mapControlsUI.ts` | Add fullscreen button to existing cluster. |
| `src/styles/browse.css` | Full-surface variant — opaque background, larger card grid, no max-width clamp. |
| `locales/en.json` | New keys: `catalogTabs.catalog`, `catalogTabs.sphere`, `mapControls.fullscreen.*`. |

### 3.5 Risks

- **Analytics impact.** New surface should emit a session-shape
  event (`catalog_mode_entered` or similar). Coordinate with
  `docs/ANALYTICS_CONTRIBUTING.md` before adding event types.
- **Deep-link compatibility.** Existing share links use
  `?dataset=X`; those must continue to land on globe-first.
  Tested explicitly.
- **Tour playback.** Tours assume globe is mounted. If a tour
  starts in catalog mode, it must implicitly flip to sphere
  mode. `tourEngine.ts` already calls `loadDataset`; we add a
  pre-call to clear catalog mode.

---

## 4. Phase 2 — Info panel completeness

**Theme.** Surface the metadata that already exists in the
data model but isn't rendered.

**Estimated size.** ~3–5 days. Single PR.

### 4.1 Field-by-field exposure

Audit of [`datasetLoader.ts:326–494`](../src/services/datasetLoader.ts)
against `EnrichedMetadata`:

| Field | In data? | Shown? | After this phase |
|---|---|---|---|
| Title | yes | yes | unchanged |
| Description (full) | yes | **truncated at 600 chars** | Expandable "show more" / scroll variant |
| Source organisation | yes | partial | Promote to a labelled "Source" row |
| Dataset developer | yes | partial (used as source fallback) | Dedicated "Developed by" row |
| Visualization developer | yes | **hidden** | Dedicated "Visualization by" row |
| Contact | yes | **hidden** | Optional contact link if present |
| Date added | yes | **hidden** | "Added on YYYY-MM-DD" line |
| Categories | yes | yes | unchanged |
| Keywords | yes | yes | unchanged |
| Thumbnail | yes | **hidden in info panel** | Render + download link |
| Legend | yes | yes (with modal) | unchanged |
| Related datasets | yes | yes (title match only) | See §4.2 |
| Catalog URL | yes | yes | unchanged |

### 4.2 Related-dataset recommendation

Today: `EnrichedMetadata.relatedDatasets` is a manual array
of `{ title, url }`. Off-catalog entries render as grayed-out
text.

Upgrade: when the manual array is short (< 3 entries) or
empty, augment with **algorithmic recommendations** based on
shared categories and overlapping keywords. Algorithm:

1. Score every other catalog dataset by:
   `category_overlap_count × 2 + keyword_overlap_count`.
2. Filter to score ≥ 2.
3. Sort descending; take top 5.
4. De-duplicate against manual entries.

This is a pure-client computation — no backend changes — and
runs in O(catalog_size) per info-panel open, which is fine for
the current catalog size (~300 datasets).

### 4.3 Thumbnail download

`thumbnailLink` is a URL on a public S3 or Vimeo CDN. A
right-click "Save image" works today but isn't discoverable;
add an explicit "Download thumbnail" link below the
thumbnail. On web, use an `<a download>` with the file URL;
on Tauri, route through the existing download service.

### 4.4 Files touched

| File | Change |
|---|---|
| `src/services/datasetLoader.ts` | Rewrite info-panel render to include new fields, expand/collapse description, related-dataset algorithm. |
| `src/services/relatedDatasets.ts` | **New.** Pure function: `recommendRelated(target, catalog) → Dataset[]`. |
| `src/services/datasetLoader.test.ts` (extend) | Add test for the related-dataset scorer. |
| `src/styles/info-panel.css` (or wherever info panel CSS lives) | New rows + expand/collapse styling. |
| `locales/en.json` | Keys for new labels: `infoPanel.developedBy`, `.visualizationBy`, `.dateAdded`, `.thumbnail.download`, `.description.showMore`, `.description.showLess`. |

### 4.5 Risks

- **Field availability.** Not every dataset has every field.
  Each row must be conditional — empty fields silently
  omitted.
- **Layout overflow.** Adding 4–6 rows to a panel that's
  already information-dense. May need a sectioned layout
  (Overview / Credits / Related) with collapsible sections.
- **Thumbnail download CORS.** Vimeo-hosted thumbnails may
  not honour `<a download>`. May need to route through
  `video-proxy.zyra-project.org` if `Content-Disposition`
  isn't set upstream.

---

## 5. Phase 3 — Playback fidelity

**Theme.** Fix the time/frame correctness bug Beth and Hilary
both reported, and surface the closed-caption infrastructure
that already exists.

**Estimated size.** ~1 week. The bug fix is small; the
captions work is mostly UI.

### 5.1 Frame ↔ label sync bug

**Diagnosis.** `inferDisplayInterval()` in `playbackController.ts`
picks a single cadence (hour / day / week / month / year) by
snapping the `(endTime − startTime) / frameCount` ratio to the
nearest preset. A 30-frame climate model spanning 30 years
snaps to **yearly**; one button-press = one year. But the
label is rendered against the timestamp, which still ticks
month-by-month for the **video-position-based** label. Result:
the label advances 12× faster than the imagery.

**Fix.** Make label cadence follow imagery cadence, not the
underlying video timecode. Concretely:

1. Compute `framesPerImageryStep` from the dataset metadata
   (the GIBS layer's update period, or the video's keyframe
   interval, or — once `CATALOG_IMAGE_SEQUENCE_PLAN.md`
   Phase 3pg lands — the catalog-provided frame count).
2. Quantise the label timestamp to the imagery step before
   rendering: `labelTime = startTime + floor(frame / framesPerImageryStep) × stepDuration`.
3. Disable label updates between imagery steps to avoid the
   "label crawls while image stays static" illusion.

**Catalog dependency.** A clean fix needs per-dataset
frame counts, which `CATALOG_IMAGE_SEQUENCE_PLAN.md`
Phase 3pg will provide. **Interim:** infer the imagery
cadence from the dataset's `period` field (already in the
data model — values like "monthly", "yearly", "daily") and
fall back to the snapped cadence today. Document the
interim approach clearly in `playbackController.ts` so the
deeper fix is obvious when 3pg lands.

### 5.2 Closed captions exposure

The infrastructure exists. The user-visible gap is:

1. **CC button not always visible.** Today the CC button
   renders only when a caption track loads successfully —
   silent failures look like "this dataset has no captions",
   making it ambiguous whether the dataset *lacks* captions
   or whether they *failed to load*. Add an explicit
   "Captions available" indicator in the info panel for
   datasets whose `closedCaptionLink` is non-empty.
2. **No caption styling control.** Default browser rendering
   varies wildly. Add a minimal style override — black
   background, white text, configurable size — matching the
   SOS native player.
3. **Caption-load failure surfacing.** Currently silent.
   Log to analytics (`error` event, Tier A) so we know how
   often Vimeo's caption proxy fails.

### 5.3 Files touched

| File | Change |
|---|---|
| `src/ui/playbackController.ts` | Quantise label time to imagery step. New `inferImageryCadence(dataset)` helper. CC button visible whenever `closedCaptionLink` is non-empty. |
| `src/services/datasetLoader.ts` | Surface "captions available" badge in info panel. |
| `src/styles/playback.css` | Caption styling (min-size, contrast, position). |
| `src/analytics/errorCapture.ts` (extend) | New `caption_load_failed` error subtype. |
| `src/ui/playbackController.test.ts` | Add tests for the new quantisation and the cadence inference helper. |

### 5.4 Risks

- **Period field reliability.** `Dataset.period` is a free-text
  field in places. Inference must be defensive and fall back
  to the existing snap behaviour on unknown values.
- **Bisecting the bug.** Beth and Hilary may have been
  describing different bugs that share symptoms. Worth
  asking for specific dataset IDs that exhibit the problem
  before designing the fix.

---

## 6. Phase 4 — Filters & search

**Theme.** Reach parity with the SOS catalog's filter surface,
plus two optional view-modes — **Graph** (§6.7) for
co-occurrence structure and **Timeline** (§6.8) for temporal
coverage — neither of which the chip rail can answer.

**Estimated size.** ~3 weeks. Splits into three coordinated
PRs — chip rail + predicate engine first (§6.1–§6.6), then
Graph view (§6.7), then Timeline view (§6.8), since both
view-modes consume the predicate engine. Graph and Timeline
share a facet-group colour palette so they read as one visual
system. Also delivers the "all SOS datasets" widening (#10) —
see §6.4.

### 6.1 Filter inventory

Two tiers. **Baseline filters** work from data we already
fetch. **SOS-parity filters** require metadata we don't have
today — the SOS team would need to provide it.

**Surfacing.** Filters render as **typed groups** in the left
rail — Category & content, Format & medium, Time, Quality &
availability — not a flat tag cloud. This mirrors the GSL
Depot Explorer pattern (Observation Type / Model / Domain /
Phenomenon / Instrument / Project shown as distinct,
color-coded facet sections) and matches the federation
`facet_schema` shape sketched in §1.6. Each group also seeds
one node cluster in the optional Graph view (§6.7); colour
per group is single-sourced from
[`tokens/global.json`](../tokens/global.json) so chips, graph
nodes, and (later) federated peer facets all share one
palette.

**Baseline (ships with Phase 4).** All entries are v1; effort
is Low unless flagged otherwise inline.

*Category & content.* Primary content axis.

| Filter | Driving field | Notes |
|---|---|---|
| Category — multi-select chips | `tags` | 11 chips: Water (80), People (63), Air (56), Land (39), Movies (35), Space (34), Real-Time (10), Tours (8), Snow and Ice (7), Layers (1), Extras (1). Upgrade today's single-select to AND-across-chips. |
| Keyword | `enriched.keywords` | Dropdown — 723 distinct values; expose as a searchable select to match the SOS UI's "Select a keyword". |

*Format & medium.*

| Filter | Driving field | Notes |
|---|---|---|
| Format | `format` (video/mp4, image/jpg, tour/json…) | Coarse buckets: Video, Image, Tour, Other. |

*Time.*

| Filter | Driving field | Notes |
|---|---|---|
| Date added | `enriched.date_added` (year) | Year-range slider, 2010–current. |
| Data-coverage year range | `startTime`, `endTime` | Numeric year-range matching SOS's "Allowed years 500–2100". Span of `startTime`/`endTime` already supports it — verified to year 0 / 1500 / 1800 in the audit. **Medium effort** (range-slider UI). |

*Quality & availability.*

| Filter | Driving field | Notes |
|---|---|---|
| Has closed captions | `closedCaptionLink` non-empty | Boolean toggle — addresses Beth's CC request indirectly. |
| Has tour | `runTourOnLoad` non-empty | Boolean toggle — surfaces the existing 11 tour-equipped datasets. |
| SOS source quality | `available_for` (`SOS` vs `Explorer`) | Boolean toggle: "include lower-fidelity SOS-only datasets". Off by default. See §6.4. |

**SOS-parity (blocked on additional metadata — see §1.6).** All
land in a new *Education & curation* group once the SOS team
provides the metadata.

| Filter | Required new metadata | Notes |
|---|---|---|
| Theme | `theme` (controlled vocabulary) | Visible in the SOS UI as a separate dropdown from Keyword; vocabulary unknown until the SOS team shares it. |
| NGSS — Minimum Grade Level | `ngss.min_grade` enum | K, 1, 2, … 12. |
| NGSS — Maximum Grade Level | `ngss.max_grade` enum | Same vocabulary as min. |
| NGSS — Cross-cutting Concepts (CCC) | `ngss.ccc[]` enum | NGSS-defined: Patterns, Cause and Effect, Scale Proportion and Quantity, Systems and System Models, Energy and Matter, Structure and Function, Stability and Change. |
| NGSS — Disciplinary Core Ideas (DCI) | `ngss.dci[]` enum | NGSS DCI codes (PS1-x, LS2-x, ESS3-x, etc.). |

NGSS metadata is **mandatory parity** for the SOS catalog
audience (educators) but **not available** in either JSON
source we currently load. Options:

1. **Ask the SOS team** for a JSON export of the NGSS
   annotations from their catalog backend — by far the
   cleanest path. Once received, ship as static enrichment
   alongside `sos_dataset_metadata.json`.
2. **Scrape the SOS dataset detail pages.** Each public
   dataset page on `sos.noaa.gov/catalog/datasets/<id>` likely
   exposes the NGSS tags; a one-off scrape script could
   populate a sidecar file. Brittle, but unblocks if option 1
   stalls.
3. **Hand-annotate the top N datasets.** Low quality, doesn't
   scale, but worth considering for the 50 most-viewed
   datasets if the other options are slow.

Recommended path: pursue option 1 first; only fall back to
option 2 if option 1 is materially slow.

**Stretch / deferred.**

| Filter | Driving field | Notes |
|---|---|---|
| Developer / organisation | `enriched.dataset_developer.name` | 78 distinct developers — likely too granular as chips; defer or expose as search prefix. |
| Region / bounding box | `boundingBox` | Map picker; conflicts with catalog-mode hidden globe. Phase 6 or later. |

A region/bounding-box filter is the most user-visible
geographic win but needs the most UI work (a map picker that
doesn't conflict with the catalog-mode hidden globe).
Recommend deferring it to Phase 6 or later.

**Implementation note — federation forward-compatibility.**
The `datasetFilter.ts` predicate engine is designed against a
generic `Record<facetName, FacetPredicate>` shape (§1.6).
Baseline facets are hardcoded keys in v1; SOS-parity facets
slot in by name once metadata lands; federated peer facets
become a runtime-discovered set once the federation
`facet_schema` declaration in §1.6 is specified and shipped.
No predicate-engine rewrite required at any tier transition.

### 6.2 Search semantics

Today: text-only substring match against title + description
+ keywords + category names, debounced 400 ms.

Upgrade: stay simple. Add **field-prefixed search syntax** —
`category:atmosphere`, `period:yearly`, `format:video` — to
let power users filter via the search box. This is cheap
because the same predicate can drive both chip filters and
prefixed search.

### 6.3 URL persistence

Filter and search state should round-trip through the URL so
links are shareable. Encode as compact query params:

```
?catalog=true&q=ocean&cat=atmosphere,land&fmt=video
```

`history.replaceState` (not `pushState`) on filter changes —
we don't want every keystroke clogging the back button.

### 6.4 Widening to the full SOS catalog (request #10)

Beth's request to surface all SOS datasets — not just the
SOSx subset — is partly tractable here, not deferred. The data
audit (§1.4) found 415 SOS-only datasets in the repo's enriched
metadata file, each with a `movie_preview` URL.

**Approach.**

1. Change `dataService.ts` to use the enriched file as the
   *primary* catalog source rather than a sidecar — merging
   the live 204-entry SOSx data on top for high-fidelity
   `dataLink` URLs where available.
2. For SOS-only datasets, synthesise a `Dataset` record from
   the enriched entry: title, description, keywords (as tags),
   `dataset_developer` (as organisation), `movie_preview` (as
   `dataLink`), `thumbnail_image` (as `thumbnailLink`).
3. Mark synthesised records with an `available_for: SOS`
   flag (mapped through to `Dataset`), and surface this in
   the UI as a subtle "lower-fidelity preview" badge so
   users understand the quality difference.
4. Default the chip filter "SOS source quality" toggle to
   show *only* `Explorer` (i.e., today's 204 SOSx subset) so
   existing users see no regression; flipping the toggle
   reveals all 520.

**Honest tradeoff.** SOS-only datasets play back at preview
quality, not the same Vimeo HLS adaptive bitrate the SOSx
subset enjoys. The federation track (§9.1) is the path to
first-class assets — this phase merely surfaces the
existence and metadata of the long tail.

### 6.5 Files touched

| File | Change |
|---|---|
| `src/ui/browseUI.ts` | Multi-select chips; new filter rail. |
| `src/services/datasetFilter.ts` | **New.** Pure predicate composition module. Drives both UI and prefixed-search. |
| `src/services/dataService.ts` | Restructure merge so enriched file is the union, live catalog is the high-fidelity overlay. New synthesis path for SOS-only entries. |
| `src/services/deepLinkService.ts` | Encode/decode filter state to URL. |
| `src/styles/browse.css` | Filter rail layout; SOS-only badge styling. |
| `src/types/index.ts` | Add `availableFor: 'SOS' \| 'Explorer' \| 'Both'` field to `Dataset`. |
| `locales/en.json` | Filter labels; SOS-only badge tooltip. |

### 6.6 Risks

- **Asset-link rot.** `movie_preview` URLs in the enriched
  file point at CloudFront origins that may 404 individually.
  Need a 404 fallback ("Preview unavailable") rather than a
  hard error.
- **Bundle size.** The 1.8 MB enriched file is already
  loaded today as a sidecar. Promoting it to primary doesn't
  grow the bundle but does affect cold-start time — measure
  before/after.
- **Catalog size.** Today's 204 datasets means filtering is
  effectively instant. The new 520-entry catalog is still
  small enough for client-side filtering with no indexing.

### 6.7 Graph view

**Theme.** A second browse view-mode — alongside the card
grid — that renders the catalog as a network of facet values
and keywords, with edges weighted by co-occurrence across
datasets. Inspired by the **GSL "Depot Explorer"** catalog
shared in review, which surfaces ~120 weather datasets as a
hub-and-spoke graph centred on a chosen facet (e.g.
*meteorology* with 50 matching datasets and 184 connections
fanning out to *severe weather*, *radar*, *high-resolution*,
*model output*, …).

**Why this is worth the extra surface.** A 520-dataset card
grid scrolls; a graph reveals **co-occurrence structure** —
which keywords cluster, which categories overlap, which
datasets sit at the intersection of two facets. That's a
genuinely new question the chip rail can't answer.

**Estimated size.** ~3–5 days on top of the chip filter work
in §6.5. Lands in Phase 4 as an opt-in view toggle, not a
default.

**Data model.** Three node types, two edge types:

| Element | Source |
|---|---|
| Facet-value node | `(facet, value)` from §6.1's grouped filters — e.g. `Category:Atmosphere`, `Format:Video`, `Theme:Climate` (once metadata lands). |
| Keyword node | `enriched.keywords` entries — only surfaced when the user expands a facet-value cluster (see *Scale management*). |
| Dataset node | One per row in the **current filter result set** — the graph reflects whatever the chip rail has narrowed to. |
| Membership edge | dataset ↔ facet-value / keyword. Drives the radial layout. |
| Co-occurrence edge | facet-value ↔ facet-value, weighted by how many datasets carry both. Drives the cluster proximity. |

**Interactions.**

- **Click facet-value node** → toggle that facet into the
  chip rail (same predicate engine — single source of truth
  for filter state).
- **Click dataset node** → open the info panel, exactly the
  same path the card grid uses.
- **Double-click facet-value node** → "centre" the graph on
  that node — the screenshot's hub-and-spoke layout, with the
  centred node enlarged and the rest of the graph
  redistributed around it.
- **Hover** → tooltip with dataset count and the top three
  co-occurring facets.
- **Search box** (top, reused from the card grid) → filters
  both views identically.

**Scale management.** At 520 datasets × 723 keywords the full
graph is too dense to read. The default cluster collapses
keywords into their parent facet-value node and shows only
facet-value ↔ facet-value edges; a node's expand control
unfurls the keyword children on demand. A "minimum edge
weight" slider (default 2) hides singleton co-occurrences. The
GSL screenshot shows ~120 datasets with this exact pattern —
the central hub plus radial keyword chips — and it stays
legible.

**Library choice.** Two realistic options:

| Library | Bundle (gzipped) | Rendering | Fit |
|---|---|---|---|
| [cytoscape.js](https://js.cytoscape.org/) | ~70 KB | SVG / Canvas | Native filter API, force-directed layouts, dataset-scale (520 nodes + ~1500 edges) is comfortable, broad browser support. **Recommended.** |
| [sigma.js](https://www.sigmajs.org/) | ~50 KB (+ graphology ~30 KB) | WebGL | Scales to 10k+ nodes; overkill for v1 but the right choice if the catalog grows past ~2k datasets. |

Recommend cytoscape.js for v1 with the same **lazy-import
pattern** Three.js uses in `vrSession.ts` — the library
chunks only when the user toggles into Graph view, so the
default-card-grid path pays nothing.

**Colour palette.** Each facet group from §6.1 owns one hue
(Category & content / Format & medium / Time / Quality &
availability / Education & curation). Nodes inherit the hue
of their parent facet; dataset nodes are neutral grey. The
palette lives in `tokens/global.json` so chips, graph nodes,
and federated peer facets (§1.6) share one source of truth.

**Mobile.** Falls back to the card grid below the existing
≤ 768px breakpoint. A 6-inch viewport with a force-directed
graph and pinch-zoom is unusable in practice. The view-mode
toggle is hidden in mobile layouts.

**Files touched.**

| File | Change |
|---|---|
| `src/ui/browseUI.ts` | Add `viewMode: 'cards' \| 'graph'` state + toggle control; lazy-mount the graph component on first toggle. |
| `src/ui/catalogGraphUI.ts` | **New.** Lazy-loaded entry; instantiates cytoscape.js, owns the canvas, wires click/hover handlers. |
| `src/services/catalogGraph.ts` | **New.** Pure transform — `buildGraph(datasets, filterState) → { nodes, edges }`. Reuses `datasetFilter.ts` predicates. |
| `src/services/datasetFilter.ts` | Export a `toggleFacet(state, facet, value)` helper so graph clicks and chip clicks share one mutation path. |
| `src/styles/browse.css` | View-mode toggle styling; graph container; tooltip. |
| `tokens/global.json` | New `--facet-color-*` tokens per group. |
| `locales/en.json` | View-mode labels (`browse.viewMode.cards`, `.graph`), tooltip labels, expand/collapse, edge-weight slider. |
| `package.json` | Add `cytoscape` as a dependency. |

**Analytics.** New events to coordinate with
[`docs/ANALYTICS_CONTRIBUTING.md`](ANALYTICS_CONTRIBUTING.md):
`catalog_view_mode_changed` (Tier A, fires on toggle),
`catalog_graph_node_clicked` (Tier B, free-text values
hashed). Throttle the latter to per-minute aggregates so a
panning session doesn't flood the queue.

**Risks.**

- **Library size.** ~70 KB gzipped for cytoscape.js. Lazy
  loading keeps it off the default path, but anyone who
  *uses* the graph pays that cost. Measure on cold-start
  via existing `perf_sample` before declaring done.
- **Touch / hover affordances.** Hover is a desktop
  primitive; mobile-tablet users on >768px viewports need
  a tap-to-tooltip variant. Worth a dedicated pass.
- **Accessibility.** A network graph is fundamentally
  visual. The card-grid view remains the canonical surface;
  the graph is augmentation, not replacement. Screen-reader
  users continue to use the card grid (which already meets
  the existing a11y baseline).
- **Federation extensibility.** When peer-advertised facets
  surface (§1.6), the palette must extend dynamically. Keep
  the colour-token map keyed by facet name, not hardcoded to
  the v1 group set.
- **Graph thrash on filter change.** Re-laying out a
  force-directed graph on every chip toggle is jarring.
  Use cytoscape's incremental-layout mode (animate node
  positions, don't re-seed the simulation) so the user
  retains spatial memory.

### 6.8 Timeline view

**Theme.** A third browse view-mode — alongside the card grid
and Graph (§6.7) — that renders each dataset as a horizontal
bar across a shared time axis, with a green dot at the right
end for datasets that update in real time. Inspired by the
**GSL Depot Explorer "Timeline" tab** shared in review, where
each row is a dataset and the bar extent is its temporal
coverage. The screenshot uses the same facet-group colours as
the Graph view, so Graph and Timeline read as one visual
system.

**Why a third view.** Cards answer *what's in the catalog*;
Graph answers *what relates to what*; Timeline answers *when*.
TerraViz's `startTime` / `endTime` audit (§1.4) confirms
populated coverage from year 0 through current for climate
reconstructions and into the future for forecast datasets —
the temporal span is a genuine axis worth its own surface.

**Estimated size.** ~3–5 days on top of the Graph view. Same
pattern: opt-in view toggle, lazy-loaded library, shares the
predicate engine.

**Data model.** One row per dataset in the current filter
result set:

| Element | Source |
|---|---|
| Row x-extent | `startTime` → `endTime` from the dataset row. Real-time datasets have `endTime` = "now" (rendered as an open-ended bar terminating at the right edge of the visible window). |
| Row colour | Inherits the primary facet group hue (§6.7 palette) — visual continuity with Graph view. |
| Real-time marker | Green dot on the trailing edge when `tags` includes `Real-Time` (10 datasets in the audit) **or** the dataset's `endTime` is within the last 24 h. The latter catches real-time datasets that aren't tagged. |
| Row label | Dataset title (left-aligned, fixed-width gutter). |

**Interactions.**

- **Click row** → open the info panel, same path the card
  grid uses.
- **Hover row** → tooltip with title, exact start/end dates,
  and the real-time status.
- **Brush a time range on the axis** → updates the
  `dataCoverageYearRange` filter via the same `toggleFacet`
  mutation Graph view uses. Two-way bound with the Time-group
  range slider in the chip rail — drag the brush, the slider
  follows; drag the slider, the brush follows.
- **Sort selector** (reused from card grid: Relevance / Size
  / Name / Newest / Oldest) → re-orders rows. Default: sort
  by `startTime` ascending (oldest at top) so the catalog's
  historical depth is the first thing the eye sees.

**Scale management.** 520 rows is fine with vertical scroll
(the screenshot shows ~30 at a time). Two affordances tame
density past that:

- **Row height** adapts to the result set: ~24 px when there
  are ≤ 100 rows, dense-pack 12 px when more. Labels truncate
  at the gutter; hover surfaces the full title.
- **Axis zoom**: scroll-wheel or pinch on the axis re-scales
  the time domain. Default span: tightest range that fits all
  visible rows.

**Library choice.** Two realistic paths, neither obvious:

| Library | Bundle (gzipped) | Fit |
|---|---|---|
| [vis-timeline](https://visjs.github.io/vis-timeline/) | ~150 KB | Drop-in horizontal timeline with brush, zoom, drag built-in. Heaviest option but ships the most behaviour out of the box. |
| Custom d3-axis + SVG rows | ~30 KB (`d3-scale` + `d3-axis` + `d3-brush`) | Same primitives the chip-rail year-range slider already needs; the actual row rendering is one `<rect>` per dataset. Slightly more code to maintain but a much smaller payload. **Recommended.** |

Recommend the **custom d3-axis path** — vis-timeline is a fine
library but pays a 5× bundle for behaviour we can write in
~150 lines. Same lazy-import pattern as Graph view; the
library only chunks when the user toggles into Timeline.

**Mobile.** Falls back to the card grid below the existing
≤ 768px breakpoint, same as Graph. A 6-inch portrait viewport
can't show enough horizontal range for the bars to be
informative; the view-mode toggle is hidden in that layout.

**Files touched.**

| File | Change |
|---|---|
| `src/ui/browseUI.ts` | Extend `viewMode` from `'cards' \| 'graph'` to `'cards' \| 'graph' \| 'timeline'`; toggle control adds a third segment. |
| `src/ui/catalogTimelineUI.ts` | **New.** Lazy-loaded entry; owns the SVG, axis, brush, row rendering. |
| `src/services/catalogTimeline.ts` | **New.** Pure transform — `buildTimeline(datasets, filterState) → { rows, domain }`. Reuses `datasetFilter.ts` predicates. |
| `src/services/datasetFilter.ts` | Already exports `toggleFacet` (added in §6.7); the brush handler reuses it for the `dataCoverageYearRange` mutation. |
| `src/styles/browse.css` | Timeline container, row hover, real-time marker. |
| `locales/en.json` | View-mode label (`browse.viewMode.timeline`), tooltip strings, real-time legend, brush instructions. |
| `package.json` | Add `d3-scale`, `d3-axis`, `d3-brush` (or vis-timeline if the custom path is rejected at review). |

**Analytics.** Mirror Graph view's events:
`catalog_view_mode_changed` already covers the toggle.
`catalog_timeline_brush_applied` (Tier B, throttled to
per-minute aggregates) captures the brush-as-filter
interaction since it's a genuinely new filter surface, not
just a representation of an existing one.

**Risks.**

- **Real-time detection.** The `Real-Time` tag is curated,
  not derived — so a dataset with current `endTime` but
  without the tag would miss the green dot. The 24 h
  fallback in the data-model row above is the mitigation;
  worth confirming with Beth / SOS whether the tag is
  authoritative.
- **Future-dated forecasts.** Some datasets have `endTime`
  in the future (model forecast horizons). The axis must
  extend past "now" to render them honestly; the green-dot
  rule keys off the *current real-time status*, not whether
  `endTime > now`.
- **Long historical bars.** Climate reconstructions span
  year 0 → present; severe-weather case studies span a few
  hours. Both should be readable on one axis. Solution:
  log-or-piecewise axis is **rejected** — it lies about
  duration. Use a linear axis with the recommended initial
  zoom range, and rely on user zoom for fine detail at the
  recent end.
- **Brush ↔ slider drift.** Two controls editing the same
  state need a single mutation path. The §6.7 contract —
  `toggleFacet(state, 'dataCoverageYearRange', [start, end])`
  — already covers this; both controls bind to the same
  reducer.

---

## 7. Phase 5 — UI polish & shader

**Theme.** Adrian's UI-scale and shader requests. Both are
medium-effort cross-cutting changes; bundled into one phase to
avoid two separate visual-quality PRs.

**Estimated size.** ~2 weeks, split into two independent PRs.

### 7.1 UI scale (`--ui-scale`)

Adrian's "150% default" is best implemented as a CSS variable
the user can tune in settings, not a hardcoded multiplier.

1. Introduce `--ui-scale: 1` at `:root` (defined in
   `tokens/global.json` so it flows through to the generated
   `src/styles/tokens.css`).
2. Audit every hardcoded `rem` / `px` size in the existing
   CSS files and wrap with `calc(... * var(--ui-scale))`.
   This is a mechanical-but-tedious pass — best done with a
   coordinated sweep across `src/styles/*.css`.
3. Add a "UI size" setting in the existing Tools menu →
   Settings, with three presets (Comfortable / Default /
   Compact → 1.5 / 1.0 / 0.85). Persist to localStorage.
4. The default ships as `1.0`. **We do not flip the default
   to 150% unilaterally** — that's a community decision, and
   shipping a 50% size jump as a forced default invalidates
   muscle memory across the existing user base. Adrian's
   stated default can be set on the SOS deployment via a
   build-time env var (`VITE_DEFAULT_UI_SCALE=1.5`).

### 7.2 Globe shader

Adrian's specific asks: improve contrast and saturation, reduce
specular, add normal maps if possible.

**Contrast / saturation.** Add a post-processing pass (or a
shader uniform on the existing earth tile layer) with two
uniforms: `u_saturation` (0.0–2.0, default 1.0) and
`u_contrast` (0.0–2.0, default 1.0). Tune the defaults until
they match the Blue Marble reference Adrian linked in the doc.
Implementation site: `earthTileLayer.ts` Pass 1 fragment shader
(currently does night darkening) — extend that pass.

**Reduce specular.** Currently `Earth_Specular_2K.jpg` is
sampled with a constant strength. Add a `u_specular_strength`
uniform exposed in the tools menu (Comfortable / Default /
None presets), defaulting to a value lower than today's.

**Normal maps.** This is the largest sub-task. Three options:

| Option | Pros | Cons |
|---|---|---|
| Bake into a precomputed normal-mapped Blue Marble texture | Simple shader, one extra texture | Adds ~8–16 MB to first paint; not GIBS-friendly |
| Per-pixel normal computation from a derivative of GIBS tiles | No extra asset | Subtle and slow; not what Adrian asked for |
| Add a global normal map texture as a separate sampler in the earthTileLayer | Cleanest | Need to source/license a 4K Earth normal map |

Recommend **option 3** with NASA's "World Topography" derived
normal map (CC-BY) or similar. Apply it only on the day side
(modulated by sun-direction) to add subtle terrain shading
without competing with city lights at night. Stay below
2K resolution to keep the bundle delta reasonable.

### 7.3 Files touched

UI scale:

| File | Change |
|---|---|
| `tokens/global.json` | Add `ui-scale` token (default 1). |
| All `src/styles/*.css` | Mechanical sweep wrapping sizes with `calc(... * var(--ui-scale))`. |
| `src/ui/toolsMenuUI.ts` | UI-size setting (radio group). |
| `src/services/uiScaleService.ts` | **New.** Persist + apply to `:root`. |

Shader:

| File | Change |
|---|---|
| `src/services/earthTileLayer.ts` | New uniforms; optional normal-map sampler. |
| `src/services/photorealEarth.ts` | Mirror the same uniforms in the VR Earth so the look is consistent. |
| `public/assets/earth_normal_2K.jpg` (new asset) | Sourced normal map. |
| `src/ui/toolsMenuUI.ts` | Specular slider preset. |

### 7.4 Risks

- **Performance.** Adding a normal-map sample to the
  fragment shader for every pixel on every frame is fine for
  desktop but warrants a check on low-end mobile. Gate
  behind a feature detection or a "low-detail" toggle if
  needed.
- **Visual regression.** Both the contrast/sat change and
  the normal map will shift the look of every screenshot
  ever taken of TerraViz. Worth flagging in release notes.
- **UI-scale sweep blast radius.** Touching every CSS file
  for the scale wrap is high-churn but low-risk. Should
  land as a single coordinated PR, reviewed for spacing
  consistency.

---

## 8. Phase 6 — Power features

**Theme.** Playlists and zip downloads. Both are genuinely
net-new features and arrive last because they layer on top of
the catalog UX from Phase 1.

**Estimated size.** ~3–4 weeks. Two distinct sub-features; each
could be its own branch if priorities shift.

### 8.1 Playlists

Adrian's spec: "stored as cookies in your local browser
session." That maps to localStorage (not actual cookies —
cookies are the wrong tool here; clarifying with Adrian is
trivial).

**Important context** (§1.4 data audit): the SOS catalog
already exposes a "View My Playlist" button. This is not a
net-new TerraViz feature — it's a parity feature. Worth
asking Adrian whether SOS's existing playlist behaviour
should be matched (button placement, interaction model,
persistence semantics) or improved on. The design below is
written from first principles; if SOS's existing playlist
UX is the target, the design should be adjusted before
build.

**Data model.**

```ts
interface Playlist {
  id: string;
  name: string;
  createdAt: string;
  datasets: Array<{ datasetId: string; durationSec?: number }>;
}
```

**Interactions.**

- "Add to playlist" affordance in info panel and browse cards.
- Playlist manager panel under Tools menu.
- Playback: when a playlist is active, advance to the next
  dataset after `durationSec` (default 30 s) using the same
  `loadDataset` flow tours use today.
- Export/import: JSON download/upload so a playlist can be
  shared across browsers, since localStorage is per-device.

**Persistence.** localStorage with a single key
`terraviz.playlists.v1` holding an array of `Playlist`.

**Relationship to tours.** Playlists are **not** tours.
Tours are author-curated, scripted, possibly include narration
and camera moves. Playlists are user-curated dataset
sequences. The two live side-by-side. If a playlist entry
points at a dataset that has a `runTourOnLoad`, the playlist
plays the tour and waits for it to finish before advancing.

### 8.2 Zip downloads

Adrian's spec: "download source data (images and videos) via
a zip file."

**Image datasets.** Straightforward. JSZip (already a peer
dependency in the desktop download path — verify) fetches each
asset (full-resolution image, legend, captions, thumbnail)
and packages them with a `manifest.json` describing the
contents. Trigger as a blob download.

**Video datasets.** Harder. HLS streams aren't a single file —
they're a manifest plus thousands of TS segments. Three
options:

| Option | Effort | UX |
|---|---|---|
| Download the highest-quality MP4 from the Vimeo proxy | Low | One file, ~good quality, but not the actual HLS source |
| Concatenate HLS segments client-side via ffmpeg.wasm | High | Slow, large bundle (~25 MB ffmpeg.wasm) |
| Server-side bundling job | Medium | Requires backend work — out of scope here |

Recommend **option 1** for video datasets — same path the
desktop downloader already uses. Honest about the tradeoff in
the UI ("HLS adaptive video; downloaded as best-quality MP4").

**Asset selection.** Let the user pick what to include:
[ ] Primary data, [ ] Legend, [ ] Captions, [ ] Thumbnail,
[ ] Metadata JSON. Default: all checked.

### 8.3 Files touched

Playlists:

| File | Change |
|---|---|
| `src/services/playlistService.ts` | **New.** CRUD + persistence. |
| `src/ui/playlistUI.ts` | **New.** Manager panel + "add to playlist" affordances. |
| `src/services/datasetLoader.ts` | Hook into playlist-advance flow. |
| `src/ui/playbackController.ts` | "Skip to next playlist item" control when playlist is active. |
| `locales/en.json` | New keys. |

Zip downloads:

| File | Change |
|---|---|
| `src/services/zipDownloadService.ts` | **New.** Web entry point. JSZip-based. |
| `src/services/downloadService.ts` | Refactor so desktop and web share asset-list logic. |
| `src/ui/downloadDialogUI.ts` | **New.** Asset-selection checkboxes + progress UI. |
| `package.json` | Add `jszip` if not already present. |

### 8.4 Risks

- **Browser memory limits.** A multi-GB video zip will OOM
  the tab. Cap downloads at ~1.5 GB and warn above that.
- **Cross-origin.** Some assets may not have CORS headers
  for direct fetch from the browser. May need to route
  through `video-proxy.zyra-project.org` for some sources.
- **Persistence loss.** Playlists in localStorage are lost
  on clear-data. JSON export/import is the mitigation, not a
  fix — flag this in the playlist UI.

---

## 9. Deferred / dependent

### 9.1 High-fidelity assets for SOS-only datasets

The 415 SOS-only datasets surfaced in Phase 4 (§6.4) play back
at `movie_preview` quality, not the Vimeo HLS adaptive bitrate
the SOSx subset enjoys. Upgrading those to first-class assets
remains gated on the federation track in
[`docs/CATALOG_BACKEND_PLAN.md`](CATALOG_BACKEND_PLAN.md) and
[`docs/architecture/federation-scoping.md`](architecture/federation-scoping.md).

Phase 4 surfaces the metadata; the catalog backend plan
surfaces the data. This plan owns the former and explicitly
defers the latter.

### 9.2 Region / bounding-box filter

Listed in §6.1 as deferred. The filter itself is feasible;
the UI surface conflicts with catalog mode's hidden-globe
default. A "show a small inline map for region picking"
component is realistic but warrants its own design pass.

### 9.3 Audio narration playback

Mentioned only obliquely in the doc (Beth's "notable
features"), but tours sometimes include narration. Out of
scope here; flag for future planning.

---

## 10. Open questions for the requesters

Before starting Phase 1, get answers to these — they affect
sequencing and avoid mid-phase rework.

1. **Default landing experience.** When a user opens
   `terraviz.zyra-project.org` with no query params, should
   they see the catalog or the globe? Adrian's wording
   ("catalog mode") and Hilary's wording ("default to our
   catalog as it is") both lean catalog-first, but this
   inverts the current behaviour and breaks every existing
   share link expectation. **Strong recommendation:** keep
   the current globe-first default; add `?catalog=true` as
   an opt-in entry, and make the SOS website link directly
   to `?catalog=true` for catalog visitors.

2. **Filter inventory (Beth).** **Mostly resolved by the
   data audit + SOS filter-panel screenshot (§1.4 / §6.1).**
   Baseline filters ship Phase 4. The four-filter NGSS bundle
   plus Theme are real SOS-parity items but require metadata
   we don't have — see Open Question #7.

3. **Frame/label bug datasets (Beth, Hilary).** Specific
   dataset IDs that exhibit the time/frame issue would let
   us reproduce reliably. Climate models that have yearly
   frames with monthly labels — which ones?

4. **UI scale (Adrian).** Hard-coded 150% default for the SOS
   deployment, or user-selectable with a sensible default? §7.1
   recommends the latter; confirm before implementing.

5. **Playlist semantics (Adrian).** When a playlist plays back,
   should each dataset play for a fixed duration, or follow
   the dataset's natural duration (full video / tour length)?
   Adrian's "cookies" wording suggests a casual feature, so
   per-dataset fixed duration with sensible defaults is likely
   the right answer — confirm.

6. **Globe shader reference (Adrian).** The doc has image
   placeholders for "SOSx blue marble" / "Google Maps" /
   "Actual photograph". If those images can be shared
   directly, the contrast/saturation defaults are easier to
   tune to match.

7. **NGSS / Theme metadata source (SOS team).** Where can we
   get the NGSS annotations (min/max grade level, Cross-cutting
   Concepts, Disciplinary Core Ideas) and Theme vocabulary
   from the SOS catalog backend? §6.1 outlines three options
   (JSON export, page scrape, hand-annotate top-N). Cleanest
   path: a JSON export from the SOS catalog database. Without
   this, Phase 4 ships baseline filters but not full SOS
   parity.

8. **Federation facet protocol (Eric / Zyra core).** §1.6
   sketches three pieces — facet schema declaration in the
   well-known doc, vocabulary namespacing (`sos:*`, `ngss:*`,
   `local:*`), and federated query degradation. These belong
   in
   [`docs/architecture/federation-scoping.md`](architecture/federation-scoping.md)
   §8 as a new resolved decision, not in this plan. Should
   that decision be made now (so Phase 4 can build against a
   stable contract) or deferred until the federation track
   restarts? Recommendation: lock the decision in
   federation-scoping.md now, even if the protocol itself
   doesn't ship for another quarter — it's much cheaper than
   retrofitting the predicate engine later.

---

## 11. Sequencing summary

| Phase | Title | Estimated size | Gate |
|---|---|---|---|
| 1 | Catalog-first UX | 1–1.5 weeks | Open question #1 |
| 2 | Info panel completeness | 3–5 days | none |
| 3 | Playback fidelity | ~1 week | Open question #3 |
| 4 | Filters & search + all-SOS widening + Graph + Timeline views | ~3 weeks (chip rail + predicate engine, then Graph §6.7, then Timeline §6.8) | Open question #7 (NGSS metadata) for SOS-parity facets; baseline + graph + timeline ship without it |
| 5 | UI polish & shader | ~2 weeks | Open question #4, #6 |
| 6 | Playlists + zip downloads | ~3–4 weeks | Open question #5 |
| — | High-fidelity assets for SOS-only datasets | — | Federation track (`CATALOG_BACKEND_PLAN.md`) |
| — | Federation facet protocol | — | Open question #8 → resolved decision in `federation-scoping.md` |

Phases 1, 2, and 3 are the highest leverage and can land in
roughly three weeks combined. They address every request from
Beth and Hilary except the filters work, and they address
Adrian's catalog-mode and fullscreen asks. Phase 4 then
delivers the baseline filter surface and the "all SOS
datasets" widening together (at preview quality); SOS-parity
filters (Theme + NGSS bundle) layer on top once Open Question
#7 is answered. Phases 5–6 layer on; each is independently
shippable.

---

## 12. Cross-references

- [`docs/CATALOG_BACKEND_PLAN.md`](CATALOG_BACKEND_PLAN.md)
  — federation track that gates request #10.
- [`docs/CATALOG_IMAGE_SEQUENCE_PLAN.md`](CATALOG_IMAGE_SEQUENCE_PLAN.md)
  — Phase 3pg will surface per-frame metadata, enabling a
  cleaner fix for the frame/label bug (Phase 3 here).
- [`docs/ANALYTICS_CONTRIBUTING.md`](ANALYTICS_CONTRIBUTING.md)
  — every new event added in this branch must follow the
  reviewer checklist.
- [`docs/CSS_ARCHITECTURE_PLAN.md`](CSS_ARCHITECTURE_PLAN.md)
  — RTL safety constraints for the new catalog-mode CSS.
- [`docs/I18N_PLAN.md`](I18N_PLAN.md) — all new strings
  pass through `t(...)` and `npm run check:i18n-strings`.
- [`STYLE_GUIDE.md`](../STYLE_GUIDE.md) — glass-surface
  visual conventions the new surfaces must respect.
