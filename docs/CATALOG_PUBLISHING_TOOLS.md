# Catalog Publishing Tools

The publisher portal — dataset entry, tour creator, asset uploader,
preview pipeline, and the round-it-out tools that make Terraviz
feel finished. Companion to
[`CATALOG_BACKEND_PLAN.md`](CATALOG_BACKEND_PLAN.md); schema
referenced from
[`CATALOG_DATA_MODEL.md`](CATALOG_DATA_MODEL.md); asset flow
described in
[`CATALOG_ASSETS_PIPELINE.md`](CATALOG_ASSETS_PIPELINE.md).

The publisher portal lives behind Cloudflare Access at `/publish`
and is lazy-loaded the same way Three.js is — the main bundle is
unchanged for non-publisher visitors. Code lives under
`src/ui/publisher/**`.

## Dataset entry page

A single-form workflow with progressive disclosure. Required fields
first (title, format, asset upload), optional metadata expanded on
demand.

| Field | Source | Notes |
|---|---|---|
| Title | text | Required. |
| Slug | derived, editable | Auto from title; collision check against `datasets.slug`. |
| Abstract | textarea (markdown) | Renders preview. |
| Organization | text | Free text; autocompletes from prior values. |
| Format | radio | video / image / tour. Drives the upload widget. |
| Data asset | upload | Stream direct upload (video) or R2 presigned PUT (image). Shows transcode/upload progress. |
| Thumbnail | upload | Optional; auto-generated from video frame at 0s if missing. |
| Legend | upload | Image. |
| Closed captions | upload | VTT. Stream native or R2. |
| Categories / keywords / tags | chip input | Free text + suggestions from existing values. |
| Time range | start/end pickers | ISO 8601. Optional. |
| Period | duration picker | "P1D", "PT1H", etc. |
| Run tour on load | tour picker | Optional. |
| Visibility | radio | public / federated / restricted / private. |
| Developers | repeater | Name + affiliation URL, role = data \| visualization. |
| Related datasets | repeater | Title + URL. |

Bottom of form: **Save draft** | **Preview** | **Publish**.

The Preview button opens the SPA in a new tab with a query param
that loads the draft against the live globe. Same renderer, same
playback, same chat — the publisher sees exactly what users will
see, but the catalog row is still `published_at IS NULL`.

### Validation rules

The form validates client-side for fast feedback and re-validates
server-side as the source of truth — a CLI or any direct API
client can't be trusted to have run the browser checks, and the
plan deliberately leaves the door open to non-portal authoring
(the "Authoring API" bullet later in this document).

| Field | Server-side rule | Client-side hint |
|---|---|---|
| Title | 3 ≤ length ≤ 200 chars; trim whitespace; reject control characters | Live char counter; warn at 180. |
| Slug | regex `^[a-z][a-z0-9-]{2,63}$`; unique on `datasets.slug`; not in reserved-slug list (`api`, `publish`, `assets`, `tours`, `well-known`, `admin`) | Auto-derived from title with a debounced collision check; manual edit unlocks the field. |
| Abstract | length ≤ 8000 chars; markdown allow-list (no raw HTML, no script-equivalent tags) | Char counter; live render preview. |
| Organization | length ≤ 100 chars | Autocomplete from prior values across this org. |
| Format | enum (`video/mp4`, `image/png`, `image/jpeg`, `image/webp`, `tour/json`) | Set automatically by the asset uploader from MIME-sniff; manual override behind an "advanced" toggle. |
| Data asset | mime ∈ format allowlist; size ≤ 10 GB (Stream upload ceiling); for image, recorded into `width`/`height` | Pre-upload mime check; inline preview after upload. |
| Thumbnail | image/* with dimensions ≥ 256×256, ≤ 4096×4096; aspect ≈ 16:9 (warn if outside ±10%) | Crop tool offered when uploaded image's aspect is off. |
| Legend | image/* same dimension caps as thumbnail; aspect free | — |
| Closed captions | text/vtt only; size ≤ 1 MB; at least one cue parses | VTT parser runs in browser; surfaces line numbers on syntax error. |
| Categories | each ≤ 80 chars; max 6 per dataset | Chip removal at 6; suggest from existing values. |
| Keywords / tags | each ≤ 40 chars; lowercase normalized; max 20 per dataset | Suggest from existing values; warn on near-duplicate (Levenshtein ≤ 2). |
| Time range | ISO 8601 strings; `start_time ≤ end_time`; both-or-neither set | Date picker with range linkage. |
| Period | ISO 8601 duration (`P1D`, `PT1H`, …) | Picker emits the canonical form. |
| Run tour on load | `tours.id` exists; tour visibility ≤ dataset visibility (don't auto-load a private tour from a public dataset) | Picker filtered to compatible tours. |
| Visibility | enum (`public` \| `federated` \| `restricted` \| `private`) | Default is `public` for staff publishers; community publishers default to `private` and explicit-promote. |
| Developers | each: name ≤ 200 chars, role ∈ (`data` \| `visualization`), affiliation URL well-formed | At least one row required for a non-trivial publish. |
| Related datasets | URL well-formed; title ≤ 200 chars | — |
| License | Either `license_spdx` ∈ SPDX list or `license_statement` non-empty | Picker shows common licenses; advanced mode for free-text. |

Server enforcement runs in the publisher API handler *before* any
write to D1 or R2. Validation errors return a 400 with a JSON body
of `{ errors: [{ field, code, message }] }`; the form binds these
to the corresponding inputs and surfaces them inline. The same
shape is consumed by the (later) authoring CLI.

Two cross-cutting policies sit on top of the per-field rules:

- **Required-vs-recommended split.** Required fields block save
  entirely; recommended fields show a warning banner ("This
  dataset has no abstract — add one before publishing for better
  discoverability") but allow draft persistence. Phase 3 required:
  title, slug, format, data asset, visibility, license. Everything
  else is recommended.
- **No partial publishes.** A dataset row's `published_at` only
  flips non-NULL when *all* required fields validate AND the
  asset upload has completed AND the asset's `content_digest`
  matches the publisher's claimed digest (see "Asset integrity &
  verification" in
  [`CATALOG_ASSETS_PIPELINE.md`](CATALOG_ASSETS_PIPELINE.md)).
  Failure at any step keeps the row in draft state with no
  half-published intermediate.

## Tour creator

This is the larger subproject. Goal: a publisher records a
sequence of camera positions, dataset loads, overlay shows, and
narration without writing JSON.

### Capture mode

A floating dock attaches to the regular SPA chrome when in tour
authoring mode. The dock has:

- **Add camera step** — captures current `lat / lon / altmi` from
  `mapRenderer.ts`, inserts a `flyTo` task. Optional animation flag.
- **Load dataset** — opens the same browse UI as users, picks a
  dataset, inserts `loadDataset` (with `worldIndex` if multi-globe
  is active).
- **Unload dataset** — pick a previously loaded handle, insert
  `unloadDataset`.
- **Set layout** — 1/2/4 globes; inserts `setEnvView`.
- **Add overlay** — text rect, image, audio. Coordinate picker
  drags rect onto the live preview.
- **Add placemark** — click on globe, fill in name + popup HTML,
  inserts `addPlacemark`.
- **Pause / question** — text or pause-for-input.
- **Toggle environment** — clouds, day/night, stars, borders.

The dock keeps an ordered list of tasks below it (drag to reorder,
click to edit). A **Play from here** button runs the existing
`tourEngine.ts` from any step against the live globe for testing.

### Persistence

Drafts auto-save every 30 seconds to
`drafts/{publisher}/{tour_id}/tour.json` in R2 plus a `tours` row
with `published_at IS NULL`. Publishing copies to
`tours/{id}/tour.json`, sets `published_at`, and triggers federation
fan-out.

### Existing tour engine compatibility

Output is identical to the current `tour/json` format consumed by
`src/services/tourEngine.ts`. No engine changes are required for
Phase 1; Phase 5 adds a `tour_schema_version` field so the engine
can refuse a tour newer than it understands.

## Asset uploader

A reusable component used by both the dataset and tour forms:

- Drag-drop or click-to-browse.
- Detects MIME type, picks the right upload target (Stream vs. R2).
- Shows progress, retries on transient failure, emits a
  completion event with the final `data_ref`.
- For video: polls Stream's transcode-status endpoint; only flips
  to "ready" when HLS is playable.
- For image: optional client-side downsample preview before upload
  so a publisher knows roughly what the 2048-wide variant will
  look like.

## Preview pipeline

Drafts are unlisted but loadable by id with a short-lived signed
token issued by `POST /api/v1/publish/datasets/{id}/preview`. The
token allows exactly one dataset (or one tour) and expires in 30
minutes. The frontend reads it from a `?preview=...` query param,
calls `/api/v1/publish/datasets/{id}` (rather than the public route)
to fetch the draft, and renders normally.

## Other tools that round out the experience

The user asked what else makes Terraviz "complete." From the gaps
visible in the codebase today, the candidates are:

- **Dataset analytics dashboard.** Per-dataset views/dwells/loads
  pulled from Analytics Engine; useful for publishers to see what
  their work is actually doing. Phase 4 — needs the analytics
  schema extended with a `dataset_id` dimension.
- **Citations / DOI export.** "How do I cite this?" button that
  generates BibTeX / RIS from the publisher + developer fields.
  Cheap; ships with the dataset entry form.
- **Embed snippet.** A copy-to-clipboard `<iframe>` that loads the
  globe with one dataset preloaded. Phase 4.
- **Revision history.** Soft-versioning of dataset metadata so a
  publisher can roll back. Phase 4 — adds a `dataset_revisions`
  table that audit_events alone won't satisfy.
- **Bulk import.** CSV / JSON upload that creates many draft rows
  at once for organisations migrating from another catalog. Phase
  3, scoped to staff.
- **Comments / Q&A on a dataset.** Out of scope for now; revisit
  when federation is real.
- **Tour playlist / season.** Group tours into a series. Trivial
  schema (`tour_collections`); ship in Phase 4 if there's demand.
- **Catalog network-graph view.** Force-directed graph of
  datasets-as-mini-spheres connected by shared keywords,
  categories, and tour co-occurrence. Reads the
  `/api/v1/catalog/graph` endpoint described in the asset
  pipeline. Doubles as a federation explorer when the graph
  spans peers. Phase 4 — design lives in its own plan once the
  sphere-thumbnail asset is in place.
- **Authoring API for non-web tools.** The publisher API is REST
  already, so a CLI (`terraviz publish`) is straightforward.
  Useful for batch jobs and CI-driven dataset updates from
  scientific workflows.
