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

## Publisher identity & roles

The publisher portal lives behind Cloudflare Access (Phase 3) and
later behind an OIDC provider as well (Phase 6). Both authentication
paths produce a `publisher_id` that is bound to every write through
the publisher API. The `publishers` table is the local mirror of
that identity; rows are JIT-provisioned on first login.

### Phase 3 — staff-only

In Phase 3 the only publishers are staff (administrators of the
deploying node):

- Cloudflare Access protects `/publish/**` and `/api/v1/publish/**`.
- On first login, the API handler reads the Access JWT, finds an
  existing `publishers` row by email, or creates one with
  `role='staff'` and `status='active'`.
- `affiliation` defaults to the deploying organisation's name (a
  Wrangler env var) and is editable in the portal's profile page.
- Every staff publisher can publish, edit any draft (including
  ones authored by other staff), and retract any dataset the
  deploying node owns. Equivalent to "every Access user is admin."

This is enough for the public reference deploy and any single-org
institutional deploy. It deliberately does not solve multi-publisher
coordination; that is Phase 6.

### Phase 6 — community publishers and finer roles

Phase 6 introduces external publishers (researchers, partner orgs,
citizen-science contributors) and the role granularity needed to
give them a useful but bounded portal:

- An OIDC provider (configurable per-deploy; sensible defaults for
  ORCID, GitHub, Google) issues identity claims that the publisher
  API exchanges for a session.
- The `publishers.role` column carries one of:
  - `staff` — full administrative authority over the deploying
    node's catalog.
  - `community` — can author their own datasets; can edit / retract
    only datasets they own or have been explicitly invited to.
  - `readonly` — sees the portal but cannot write. Used for
    auditors and reviewers in the review-queue flow.
- A new `org_id` column (nullable in Phase 3, populated for
  community publishers from Phase 6 onward) groups publishers
  into institutional units. Cross-org isolation is the default —
  a community publisher cannot see drafts authored by anyone in
  a different org.

### Capability matrix

The matrix below is the source of truth for the publisher API's
authorization checks. Phase 3 collapses to the `staff` column.

| Action | staff | community (own) | community (invited) | readonly |
|---|---|---|---|---|
| Create dataset draft | ✓ | ✓ | — | — |
| Edit own draft | ✓ | ✓ | n/a | — |
| Edit someone else's draft | ✓ | — | ✓ | — |
| Submit draft for review | ✓ | ✓ | ✓ | — |
| Approve a submitted draft | ✓ | — | — | ✓ if assigned |
| Publish (transition `published_at` → now) | ✓ | ✓ if no review queue | ✓ if no review queue | — |
| Retract a published dataset | ✓ | ✓ if owner | — | — |
| Hard-delete a dataset | ✓ admin only | — | — | — |
| Issue a read-side `dataset_grant` | ✓ | ✓ if owner | — | — |
| Manage federation peers | ✓ admin only | — | — | — |
| View audit log for a dataset | ✓ | ✓ if owner | ✓ | — |
| View audit log node-wide | ✓ admin only | — | — | — |

The "admin" sub-role within `staff` is a flag on the publisher row
(`is_admin INTEGER NOT NULL DEFAULT 0`); only admins can manage
peers, hard-delete, or read the node-wide audit log. The first
staff row created on a fresh deploy is auto-promoted to admin.

## Cross-publisher collaboration

Phase 6 adds the ability for a publisher to invite others —
including from a different org — to edit a specific draft. This is
distinct from the *read-side* `dataset_grants` table described in
the main backend plan: those control who can *view* a published
dataset; the table introduced here controls who can *write* a
draft or published row.

A new `dataset_collaborators` table holds the write-side grants:

```sql
CREATE TABLE dataset_collaborators (
  dataset_id   TEXT NOT NULL,
  publisher_id TEXT NOT NULL,
  permission   TEXT NOT NULL,             -- editor | reviewer
  invited_by   TEXT NOT NULL,             -- publishers.id
  invited_at   TEXT NOT NULL,
  accepted_at  TEXT,                      -- null until invitee accepts
  revoked_at   TEXT,
  PRIMARY KEY (dataset_id, publisher_id),
  FOREIGN KEY (dataset_id)   REFERENCES datasets(id) ON DELETE CASCADE,
  FOREIGN KEY (publisher_id) REFERENCES publishers(id),
  FOREIGN KEY (invited_by)   REFERENCES publishers(id)
);
```

Lifecycle:

- **Invite.** Owner clicks "Invite collaborator" in the dataset
  page; enters an email (community publisher already in the
  publishers table) or generates an invite link (signed token,
  10-day expiry, exchangeable for an OIDC login + JIT publisher
  provision).
- **Accept.** Invitee logs in, sees a "shared with you" banner;
  clicking accepts and stamps `accepted_at`. Until then the row
  exists but the invitee has no rights.
- **Revoke.** Owner or any admin clicks "Revoke"; `revoked_at` is
  stamped. Server-side checks read
  `accepted_at IS NOT NULL AND revoked_at IS NULL`.

The owner can demote themselves to editor (handing ownership to
another collaborator) but cannot leave a dataset with no owner.
The capability matrix above applies — invited editors get the
"community (invited)" column, invited reviewers get a subset
limited to read + comment + approve.

## Review queue (Phase 6)

An optional review-queue mode, configured per-org via a
`require_review BOOLEAN` flag on the orgs table. When the flag is
on:

- Community publishers' drafts can be saved freely but cannot
  transition to `published_at` directly.
- Submitting a draft stamps `submitted_at` on the dataset row and
  routes the dataset to a per-org review queue.
- A staff publisher (or an assigned reviewer) reviews, may
  comment, and either approves (stamps `approved_at`) or rejects
  (stamps `rejected_at` with a reason; resets to draft state and
  clears `submitted_at`).
- An approved draft can be published by the owner or any staff;
  publishing stamps `published_at` and clears `submitted_at`,
  `approved_at`, and `rejected_at`.

Three columns extend the `datasets` table for this flow:
`submitted_at`, `approved_at`, `rejected_at`. All three are NULL
in the Phase 3 staff-only flow; the review-queue logic is
purely additive — Phase 3 routes that read or write the
`datasets` table never touch the review columns.

The review queue is a UI surface in the portal: a "Pending
review" tab listing submitted drafts grouped by org, with filters
by submitter, submission date, and review state. Review comments
live in a `dataset_review_comments` table (id, dataset_id,
reviewer_id, body, created_at) — append-only; comments are not
edited in place, mirroring how audit events work.

Reviewers are assigned in two ways: org admins can pre-assign
specific publishers to review specific submitters' work
(typical institutional pattern), or a submission with no
assignment falls into the org's general queue and any
review-eligible publisher (staff or readonly) can pick it up.
Self-review is rejected — a publisher cannot approve a draft
they authored, even if they have the role to.

## Retraction & deletion

Retraction is a soft state: the row stays, `retracted_at` is
stamped, the federation feed emits a tombstone, and the asset
lifecycle table in
[`CATALOG_ASSETS_PIPELINE.md`](CATALOG_ASSETS_PIPELINE.md) takes
over (90-day grace, then asset cleanup, row stays as a
tombstone). Retraction is the typical action a publisher takes
when content is wrong, outdated, or otherwise needs to disappear.

Hard deletion is rare and reserved for legal / safety scenarios:
takedown notices, accidentally-published private data,
regulatory removal orders. Only admin staff can hard-delete; the
action is always logged with the requester's identity, the
requester's free-text reason captured at the time, and a small
permanent record in a `deleted_datasets` table holding only the
ULID, the deletion timestamp, the deleter, and the reason — the
row body is not retained, deliberately.

For federation: a hard-deleted row emits a tombstone like
retraction does, but the tombstone is permanent (no grace period,
no `data_ref` resolution). Peers receive the tombstone on next
sync and remove their mirror; the audit_events row at the
deleting node records what happened in case a federated peer
later asks why a dataset disappeared.

The "retract → 90-day grace → asset cleanup" path handles >99% of
real cases; the hard-delete path exists for the cases where
"the bytes need to be unreachable in 24 hours, not 90 days."
Both paths surface in the publisher portal's history panel
(see below) so a reviewer can verify what was done and when.

## Audit trail in the portal

The `audit_events` table described in the main backend plan is
the substrate; the portal renders it in two places:

- **Per-dataset history panel.** Inside each dataset's edit view,
  a collapsible panel shows the row's lifecycle: created, edited
  (with changed-fields summary derived from `metadata_json`),
  submitted, approved, published, granted, revoked, retracted.
  Filterable by actor and time range. This is the answer to
  "did peer X get this dataset before I retracted it?" — grant
  and retraction events are both there, ordered by ULID.
- **Node-wide activity feed (admin only).** A reverse-chronological
  feed of every audit event across the node, useful for "what's
  happening on my deploy?" and incident review. Backed by the
  same query, just unfiltered. Pagination via the
  `audit_events.id` (ULID) cursor.

The panel is the answer to several otherwise-awkward questions:
"who edited this title last week?" (edit events with
changed-fields), "did this review approval happen before or
after the integrity check failed?" (events are interleaved by
ULID, which is time-ordered), "did the right peer get notified
of a hard delete?" (federation-fanout events appear next to the
deletion event).

Phase 3 ships the per-dataset panel; Phase 6 adds the node-wide
feed once there are non-staff actors generating events worth
filtering across.

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
