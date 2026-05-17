# Changelog

Operator-facing changelog for the Terraviz catalog backend roll-out.
Each phase corresponds to a single merged PR; the per-commit detail
lives in `git log` (commit messages follow the `catalog(<phase>/<letter>):`
convention) and the design docs in `docs/CATALOG_*`.

For the upstream catalog plan, see
[`docs/CATALOG_BACKEND_PLAN.md`](docs/CATALOG_BACKEND_PLAN.md).
For the developer onboarding,
[`docs/CATALOG_BACKEND_DEVELOPMENT.md`](docs/CATALOG_BACKEND_DEVELOPMENT.md).

This file documents Phase 1 onward. The pre-catalog history (analytics
pipeline, VR mode, tour engine, etc.) lives in the merged PRs
referenced in [`README.md`](README.md).

---

## Phase 3pd — Asset uploader + transcode pipeline (R2 + GHA)

**Branch:** `claude/catalog-publisher-portal-phase-3pd` (PR #112)
**Commits:** 3pd-pre through 3pd/F.

Fourth sub-phase of the publisher portal. 3pc made datasets editable;
3pd makes their **assets** uploadable. The Phase 1b asset_uploads
pipeline existed already but routed video data through Cloudflare
Stream. Live testing exposed Stream's standard-plan 1080p ceiling
(insufficient for 4K spherical content), and Phase 3 shipped a
CLI-driven R2 + ffmpeg replacement (`cli/migrate-r2-hls.ts`). 3pd
exposes the same pipeline through the portal: a publisher uploads
an MP4 in the browser, a GitHub Actions workflow runs ffmpeg
against the 4K / 1080p / 720p 2:1 spherical ladder, writes the
HLS bundle to a versioned R2 path
(`r2:videos/{dataset_id}/{upload_id}/master.m3u8`), and POSTs the
new `/api/v1/publish/datasets/{id}/transcode-complete` route on
the publisher API to flip `data_ref` and clear `transcoding`.
The per-upload-id segment is what keeps a re-upload to an
already-published row from clobbering the bundle the public
manifest is mid-playback against.

**3pd-pre — Doc refresh.** Banner at the top of
`CATALOG_ASSETS_PIPELINE.md` flagging Stream removal. Rewrites
§"Video pipeline" around the R2 + GHA reality — the actual ladder
(4096×2048 / 2160×1080 / 1440×720 at H.264 main, AAC 192kbps,
6-second VOD segments), the upload → presigned PUT →
repository_dispatch → workflow → row-PATCH sequence, the cost
model, and the rationale for GHA over Workers+WASM. `stream:`
data_ref prefix marked Deprecated. `CATALOG_PUBLISHING_TOOLS.md`
gains the 3pd sub-phase breakdown table; `CATALOG_BACKEND_PLAN.md`
3pd row rewritten.

**3pd/A — Server-side wiring + migrations 0011 and 0012.** The
substantial "already-shipped infrastructure now points at R2"
sub-phase. **Both migrations are required** for the pipeline —
0011 introduces the transcoding flag, 0012 introduces the
per-upload binding the overlap and stale-callback guards key
off. Apply them in order before deploying the publisher API.

- Migration 0011 adds `transcoding INTEGER` to `datasets`. Starts
  NULL, flipped to 1 while a transcode is in flight, cleared
  back to NULL by the workflow's PATCH.
- Migration 0012 adds `active_transcode_upload_id TEXT` to
  `datasets`. Set in lockstep with `transcoding=1` by the
  `/asset/.../complete` stamp; cleared in lockstep by
  `/transcode-complete` (or `revertTranscodingStamp` on
  dispatch failure). The `/asset/.../complete` overlap check
  and the `/transcode-complete` stale-callback check both
  refuse to apply when this column doesn't match the caller's
  `upload_id`, so a concurrent re-upload or a workflow run
  dispatched against a stale binding fails closed with a
  clear 409 instead of clobbering in-flight state.
- `chooseTarget()` in `asset.ts` collapses to "always R2." The
  Stream branch is now dead code waiting for a follow-up cleanup
  PR; the type union stays `'r2' | 'stream'` so the deletion can
  land incrementally.
- `r2-store.ts` gains `buildVideoSourceKey(datasetId, uploadId)` →
  `uploads/{dataset_id}/{upload_id}/source.mp4`. Per-upload
  prefix so a re-upload to a row that's already transcoding
  doesn't overwrite the source bytes the prior workflow may
  still be reading. The GHA workflow finds the bytes via the
  `client_payload.source_key` carried in the dispatch. Every
  other asset kind keeps the content-addressed
  `datasets/{id}/by-digest/sha256/{hex}/...` scheme.
- New `_lib/github-dispatch.ts` POSTs to
  `https://api.github.com/repos/{owner}/{repo}/dispatches` with
  `event_type: 'transcode-hls'` + a typed `client_payload`.
  Mock mode (`MOCK_GITHUB_DISPATCH=true`) for local dev, refused
  on non-loopback hosts. Errors map to the same typed
  `ConfigurationError` / `UpstreamError` classes the rest of
  the storage helpers use.
- `complete.ts` branches on `isVideoSourceKey()` after digest
  verification. Video-source uploads fire the dispatch, stamp
  `transcoding=1`, and mark the asset_upload completed.
  `data_ref` handling is **conditional**: cleared to empty
  string on draft rows (no public consumer to break), preserved
  verbatim on published rows so the public manifest endpoint
  keeps serving the prior HLS bundle while the new one
  transcodes. The eventual `/transcode-complete` callback
  atomically swaps `data_ref` to the new master.m3u8.
  Non-video uploads keep the existing `applyAssetAndMarkCompleted`
  path. On dispatch failure the dataset row is reverted via
  `revertTranscodingStamp` (no-op if a concurrent upload has
  already taken over the binding) and the upload stays
  `pending` so the publisher can retry after the operator
  fixes config.
- Four new env vars in `CatalogEnv`: `GITHUB_OWNER`,
  `GITHUB_REPO`, `GITHUB_DISPATCH_TOKEN` (production wiring for
  the GHA dispatch), plus `MOCK_GITHUB_DISPATCH` (the dev/test
  short-circuit). `MOCK_R2` and `MOCK_STREAM` already existed
  pre-3pd and stay unchanged — they're listed in
  `CatalogEnv` for completeness, but operators don't add them
  for this phase.

**3pd/A-fix — `POST /api/v1/publish/datasets/{id}/transcode-complete`.**
The endpoint the workflow POSTs back through to clear
`transcoding=1` and set `data_ref`. Restricted to `role='service'`
+ admin staff because the column is server-managed.
Belt-and-suspenders `source_digest` re-verify so a misrouted
workflow can't PATCH the wrong row. `dataset.update` audit_event
stamped with `metadata.reason = 'transcode_complete'`.

**3pd/B — GitHub Actions workflow + transcode runner.**
`.github/workflows/transcode-hls.yml` listens on
`repository_dispatch: types: [transcode-hls]` and invokes
`cli/transcode-from-dispatch.ts` — a single-dataset sibling of
`cli/migrate-r2-hls.ts`. The runner downloads the source MP4
from R2 (S3 API), re-verifies the digest, runs `encodeHls`
against the same `DEFAULT_RENDITIONS` ladder, calls
`uploadHlsBundle`, then POSTs the transcode-complete endpoint
with the Access service-token headers. Stage-specific exit codes
(1 arg / 2 download / 3 encode / 4 upload / 5 PATCH) so an
operator skimming the GHA UI sees which stage broke without
digging into the log. Per-dataset concurrency cap (the
`transcoding_in_progress` guard chain — pre-mint check in
/asset, JS overlap check + atomic SQL stamp in /complete,
active-upload-id binding in /transcode-complete) so a publisher
re-uploading the same video twice doesn't dispatch two
overlapping workflows. Each upload still gets its own R2
prefix (`videos/{dataset_id}/{upload_id}/`), so the encodes
themselves wouldn't actually race for object keys — the cap
prevents the duplicate work, the stale /transcode-complete
callback that follows it, and the wasted compute.

**3pd/C — Portal asset uploader.** New
`components/asset-uploader.ts` mounts alongside the 3pc/F-fix2
manual data_ref text input (in edit mode) so editors can still
swap to legacy `vimeo:` / `url:` references without re-uploading
bytes. Three-stage flow:

1. Hash the file with a chunked SHA-256 from `@noble/hashes`
   (3pd-review2/C — Web Crypto's `crypto.subtle.digest` has no
   streaming API, so 4K MP4 uploads would otherwise blow the
   browser tab's memory cap on `file.arrayBuffer()`).
2. POST `/asset` to mint a presigned R2 PUT URL.
3. XHR PUT to R2 (XHR not fetch — fetch doesn't surface request-
   body upload progress).
4. POST `/complete` to verify the digest server-side.

The component surfaces a status line + `<progress>` bar at every
step. Image uploads write `data_ref` synchronously and return
`{ mode: 'direct', dataRef }` to the parent. Video uploads stamp
`transcoding=1` and return `{ mode: 'transcoding' }` — the
detail page picks up from there (3pd/D). Mock mode bypasses the
XHR PUT (the `mock-r2.localhost` mint URL isn't reachable) and
trusts the publisher's claimed digest server-side.

In create mode the manual text input stays as a fallback for
`vimeo:` / external URLs where no upload is needed — the dataset
id doesn't exist yet, and `/asset` is scoped per-dataset.

**3pd/D — Transcoding badge + 5-second polling.** Detail page
gains a "Transcoding…" badge inline next to the lifecycle badge
whenever `transcoding=1`. Yellow tone with a subtle pulse
animation. Publish button is disabled while transcoding (with
a tooltip explaining why) — the publish-readiness validator
would reject anyway since data_ref is empty.

The polling loop:

- `paint()` is the single source of truth: every render starts
  (or restarts) the poll loop if `transcoding=1` and stops it
  otherwise.
- `WeakMap<HTMLElement, AbortController>` keeps the binding
  alive only while the mount is reachable, so a route change
  naturally drops the prior loop.
- Default cadence 5 s; overridable via `transcodePollIntervalMs`
  for tests.
- Transient errors don't tear down the page — they pause the
  poll for one cycle. Session errors hand to the shared
  `handleSessionError`.

**3pd/E — Preview button + share-link modal.** The
POST `.../preview` endpoint has shipped since Phase 1b but no
portal surface called it. 3pd/E wires a Preview button next to
Edit on the detail page that mints the 15-minute token and
surfaces the resulting URL in a lightweight modal — the
backend's anonymous-read URL
(`/api/v1/datasets/{id}/preview/{token}`), which returns the
dataset's metadata as JSON (`{ dataset: row }`). The publisher
can copy the link to share a draft for review without
publishing; reviewers with API access can fetch the metadata
directly. Note that the link is the metadata primitive, not a
visual preview — see the SPA consumer follow-up below.

Hidden while transcoding (data_ref is empty, nothing to
preview yet). The richer SPA-side `/?preview=<token>&dataset=<id>`
consumer (full globe context + playback controls) is a Phase
3pe deliverable; 3pd/E proves out the token-mint half + gives
the publisher a working metadata URL today.

**3pd/F — Operator-facing docs.** This CHANGELOG entry + the
SELF_HOSTING walkthrough for the new GHA secrets the workflow
needs (`GITHUB_DISPATCH_TOKEN` on Pages,
`R2_S3_ENDPOINT` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` /
`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` /
`TERRAVIZ_SERVER` as GitHub Actions repo secrets).

---

## Phase 3pc — Dataset create / edit / publish / retract

**Branch:** `claude/catalog-publisher-portal-phase-3` (same PR
that landed Phase 3-pre, 3pa, and 3pb)
**Commits:** 3pc/A through 3pc/F.

Third code sub-phase of the publisher portal. Where 3pb made the
catalog browsable, 3pc makes it editable: a staff or community
publisher can now create a new dataset, fill in the recommended
metadata, save as a draft, preview the row before flipping it
public, and publish or retract it — all without leaving the
browser. The CLI keeps working unchanged; the portal is an
alternative surface on the same write API.

**3pc/A — Shared markdown renderer.** Lifts the `marked` + custom
HTML sanitizer into `src/services/markdownRenderer.ts` so the
abstract preview (3pc/C1) and the read-only detail page share a
single pipeline. The sanitizer's tag allowlist
(`MARKDOWN_TAGS` in `src/ui/sanitizeHtml.ts`) is conservative —
headings, paragraphs, lists, emphasis, code, blockquotes, links,
horizontal rules. Anything else, including raw HTML attributes
the publisher could try to smuggle through, is stripped.

**3pc/B — `/publish/datasets/new` create form.** New page with
the required-field core (title, slug, format, visibility) and a
discriminated `PublisherSendResult<T>` on the API helper so the
page can render per-field validation errors without spelunking
response bodies. Auto-derives the slug from the title; locks the
auto-derive once the publisher edits the slug manually so a
later title change doesn't clobber their choice. POST success
SPA-navigates to the new row's detail page.

3pc/B caught two server-side gaps along the way:

- **3pc/B-fix** improves the portal's error card to expose
  status + body in a `<details>` disclosure, so a 500 reads as
  a debuggable surface instead of a generic "server error."
- **3pc/B-fix2** wraps the publish middleware in a try/catch
  returning `{error: 'unhandled_exception', message}` instead
  of letting a thrown exception bubble up as a Cloudflare
  Error 1101 (which strips any structured response).
- **3pc/B-fix3** then drops the stack trace from the wrapped
  response (CodeQL flagged stack-trace exposure); the trace
  still lands in `wrangler tail` via `console.error`.

**3pc/C1 — Abstract + live markdown preview.** A textarea with
the shared renderer powering a live preview pane. Reuses the
3pc/A pipeline so the same allowlist applies whether the
publisher is reading a draft they typed five seconds ago or a
production row that originated in the SOS importer.
**3pc/C1-tools** adds a GitHub-style toolbar over the textarea
(9 buttons — heading, bold, italic, code, link, list, quote,
hr, image alt). A future round-it-out captured in
`docs/CATALOG_PUBLISHING_TOOLS.md` will swap this for a Lexical
WYSIWYG.

**3pc/C2 — Organization + licensing fields.** Adds the
organization input, the SPDX license dropdown (with free-form
`license_url` and `license_statement` for non-SPDX terms),
attribution text, rights holder, DOI, and a citation block.

**3pc/C3a — Time range card.** `start_time` / `end_time` /
`period` with split Date + Time inputs side-by-side
(**3pc/C3a-fix** — the native `datetime-local` widget was
hiding the time portion on Firefox until the user clicked it).
`dateTimeToIso(date, time)` composes the two inputs into a
canonical ISO 8601 UTC string the server can store as-is.

**3pc/C3b — Categorization.** Reusable chip input component
(`components/chip-input.ts`) backing keyword + tag entry. Each
chip lives as a separate row in `dataset_keywords` /
`dataset_tags`; the chip-input's pure `appendChip` /
`removeChipAt` transforms are decoupled from the DOM render so
the same logic powers tests and the live form.

**3pc/D/A — Extract shared form into a component.** Moves the
~1200-line form machinery from `pages/dataset-new.ts` into
`components/dataset-form.ts` exporting
`renderDatasetForm(content, { mode: 'create' | 'edit', initial?,
initialKeywords?, initialTags? })`. `pages/dataset-new.ts`
becomes a ~25-line wrapper that calls the shared form in
`'create'` mode. Submit logic branches on mode for POST vs PUT,
endpoint, and post-save redirect target.

**3pc/D/B — Detail endpoint returns decorations.** The detail
GET now includes `keywords: string[]` and `tags: string[]`
alongside the dataset row, so the upcoming edit page can prefill
its chip inputs from the existing decoration rows. The
read-only detail page renders the two arrays as chips in a new
"Keywords & tags" card; the card hides itself when both arrays
are empty so unannotated drafts don't grow a stub.

**3pc/D/C — Edit page + route wiring.** New
`/publish/datasets/:id/edit` route: fetches the row +
decorations, hands the prefilled state to `renderDatasetForm`
with `mode: 'edit'`. The detail page grows an Edit button in
its title row — plain left-click is intercepted for SPA
navigation, modifier-clicks fall through so a cmd-click still
opens the edit form in a new tab.

**3pc/E — `audit_events` writes.** The `audit_events` table has
existed since 0005_publishers_audit but until now nothing was
writing into it for the publisher API. New `audit-store.ts`
helper wires into the four mutation routes
(`dataset.create` / `dataset.update` / `dataset.publish` /
`dataset.retract`) and records an append-only row per
privileged write. The helper is best-effort: a failed insert
logs via `console.error` (surfaces in `wrangler tail`) and
returns null but never throws, so a transient audit-table
hiccup can't reject a write that has already committed.

Action metadata is intentionally small:

- `dataset.create` → `{ slug, format, visibility }`
- `dataset.update` → `{ fields: [...sorted touched keys] }` —
  names only, not values; the row's own column history is the
  source of truth for what changed to what.
- `dataset.publish` / `dataset.retract` → `{ slug }`

**3pc/F — Publish + retract on the detail page.** Lifecycle-aware
action button next to Edit: Draft / Retracted → "Publish",
Published → "Retract". Every click runs through `window.confirm`
first; on confirm we POST to the existing /publish or /retract
route, then re-fetch the row so the displayed badge and
decorations match what the server now reports. The action
endpoints already do the heavy lifting from 3pc/E (audit row,
snapshot invalidate, embed enqueue); the portal just surfaces
the result.

Error handling tracks the established detail-page error model:
401 → shared session redirect; 400 validation → re-fetch + an
inline banner above the abstract (the badge stays consistent
with the server's view so a failed publish doesn't accidentally
appear to have succeeded); network / not_found → re-fetch +
inline banner, falling back to the static error card if even
the refetch fails.

---

## Phase 3pb — Read-only dataset list + detail

**Branch:** `claude/catalog-publisher-portal-phase-3` (same PR
that landed Phase 3-pre and 3pa)
**Commits:** 3pb/A through 3pb/D.

Second code sub-phase of the publisher portal. After 3pb, a
staff publisher can browse every dataset visible to them
(drafts, published, retracted) and drill into a single
dataset's full read-only detail view without leaving the
portal. No write surfaces yet — that's 3pc onward — but every
catalog row's data is now reachable through the browser instead
of only via the CLI.

**3pb/A — Extract publisher API client + session-error
helper.** Hoists the fetch + retry + opaqueredirect-recovery
logic that originated in /publish/me into a new
`src/ui/publisher/api.ts`. Exposes three things every portal
page now consumes:

- `publisherGet<T>(path, options)` — `redirect: 'manual'` fetch
  with the 100 ms retry-on-opaqueredirect from 3pa/L. Returns a
  discriminated result (`ok` | `session` | `server` | `network`
  — `not_found` added later in 3pb/C).
- `handleSessionError({ navigate? })` — page-level recovery:
  auto-navigates through the redirect-back endpoint on the
  fresh path, or returns `'show-error'` when the sessionStorage
  warmup flag is already set (genuine auth gap).
- `buildSignInUrl()` — same URL the manual Sign in button uses,
  so fallback and auto-recovery stay in lockstep.

The sessionStorage key migrates from `publisher_me_warmup_attempted`
to `publisher_warmup_attempted` — page-agnostic now that the
warmup is portal-wide. `pages/me.ts` shrinks from ~140 lines of
inlined auth machinery to a short pattern-match on the helper's
result.

**3pb/B — `/publish/datasets` list page with lifecycle tabs +
Load more.** Replaces the placeholder at /publish/datasets
with the read-only list:

- Three tabs (Drafts / Published / Retracted) backed by the
  `?status=` query param so the active filter is bookmarkable
  and shareable.
- `<table>` layout for density. Columns: Title (linked to the
  detail page) | Slug (monospace) | Format (monospace) |
  Updated (localized) | Status badge.
- "Load more" button paginates via the server's
  `next_cursor: string | null`. Appends rows in place; button
  hidden when no further pages; disabled "Loading…" state
  prevents double-click duplicate fetches.
- Empty states are tab-specific. Drafts empty mentions the
  CLI and references the 3pc sub-phase tag.
- Tab clicks call `router.navigate()` for SPA-style transitions;
  cmd/ctrl/middle-click falls through so power users can open
  a tab's URL in a new browser tab.

`src/ui/publisher/types.ts` declares the wire shape the portal
consumes (`PublisherDataset`, `ListDatasetsResponse`,
`lifecycleOf()` helper) — a narrow subset of the server's
`DatasetRow`, kept here rather than imported from
`functions/api/v1/_lib/catalog-store.ts` so the portal chunk
doesn't drag in server-tree dependencies.

22 new `publisher.datasets.*` i18n keys (columns, tabs, empty
states, count plural, status badges, Load more).

**3pb/C — `/publish/datasets/:id` read-only detail page.**
Replaces the placeholder at /publish/datasets/:id with a dense
admin view of the dataset row, grouped into four glass-surface
section cards plus a header:

- Back arrow link → /publish/datasets.
- Header: title (h1) + lifecycle status badge + slug (mono).
- Abstract card (rendered as plain text via `textContent` —
  the markdown sanitizer lands in 3pc).
- Identity card: ULID (mono), legacy SOS ID (mono), format,
  visibility, organization, publisher ULID.
- Lifecycle card: created/updated/published/retracted
  timestamps plus the dataset's own start_time / end_time /
  period.
- Assets card: data_ref, thumbnail/legend/caption refs,
  website link, run_tour_on_load.
- Licensing & attribution card: SPDX, license URL, statement,
  attribution text, rights holder, DOI, citation.

`renderFieldsCard` filters out null/empty values so empty
sections don't render empty card chrome.

404 handling: the API returns 404 for both missing rows and
rows the caller can't see (to avoid leaking other publishers'
draft IDs). The shared API helper's result type grew a new
`'not_found'` kind separate from `'server'`. The not-found
card has no Refresh button — the back link to the list is the
right recovery action. `me.ts` and `datasets.ts` collapse
`not_found` to `server` since neither route should ever 404 in
practice, but the union exhaustion forces an explicit decision.

35 new `publisher.datasetDetail.*` i18n keys.

**3pb/D — This file.**

### Operator-visible changes

- **New Pages routes:** /publish/datasets (with `?status=`
  filter and cursor pagination) and /publish/datasets/:id
  (read-only detail). The /publish/tours and /publish/import
  placeholders are unchanged — they ship in 3pe and 3pf
  respectively.
- **No new analytics events** in 3pb. The existing
  `publisher_portal_loaded` event fires for `route: 'datasets'`
  (via the routeForPath mapping from 3pa/E) on both the list
  and the detail page.
- **No new env vars or bindings.** 3pb reads from API endpoints
  Phase 1a already ships.

### What this sub-phase deliberately does not do

- **Write surfaces.** Drafts / publishes / retractions land in
  3pc (entry form) and 3pd (asset uploader). 3pb is strictly a
  reader.
- **Audit history panel.** The plan listed an audit panel for
  3pb, but the publisher API doesn't write to `audit_events`
  yet (the table exists since Phase 1a migration 0005, but no
  publish/retract handler records to it). Spinning up the
  panel against an empty table isn't useful; an audit-writes
  sub-phase (likely 3pb/audit or rolled into 3pc) precedes the
  panel.
- **Edit-from-detail.** Detail page renders every field but
  none are editable. 3pc adds the form.

### Sub-phase status

- 3pa — Portal shell + Access browser flow. ✓ Shipped.
- **3pb — Dataset list + detail (read-only).** ✓ Shipped.
- 3pc — Dataset entry form (metadata). Next.
- 3pd – 3pg — Future.

---

## Phase 3pa — Publisher portal shell + Access browser flow

**Branch:** `claude/catalog-publisher-portal-phase-3` (same PR
that landed Phase 3-pre)
**Commits:** 3pa/A through 3pa/H, plus a one-line 3pa/A-fix
addendum picked up against the live Pages preview.

First code sub-phase of the publisher portal. After 3pa, a staff
publisher visiting `/publish/me` on a deployed instance lands on
a glass-surface profile card showing their identity from the
already-shipped publisher API; the portal's lazy chunk, History
API router, top nav, i18n key skeleton, analytics events,
Grafana panel row, and Cloudflare Access walkthrough are all in
place. No write surface yet — that's 3pc onward — but every
foundation downstream sub-phases depend on now ships.

**3pa/A — Portal lazy chunk + History API router.** New module
tree under `src/ui/publisher/**`. The chunk loads via a single
dynamic `import('./ui/publisher')` from `src/main.ts`, gated on
`location.pathname.startsWith('/publish')`; non-publisher visits
never fetch the portal bytes. The router is a ~100-line History
API wrapper with one `:id` placeholder, popstate re-dispatch,
and an idempotent stop, matching the "vanilla TS with a few
focused libraries" stance documented in `CLAUDE.md`. Every route
mounts a placeholder page showing its section name and the
sub-phase letter that will replace it. 13 router tests cover
pattern matching, dispatch, navigate(), and popstate handling.

**3pa/A-fix — Hide the SPA loading splash on portal boot.**
Reported visually against the Pages preview: `/publish` showed
the SPA's rotating-globe loading screen instead of the
placeholder because the splash is `position: fixed; z-index:
1000; opacity: 1` and only fades out on the SPA's own boot path.
The portal route gate `return`s before that fades. One-line fix
in `ensureMount()` to hide the splash explicitly, mirrored in
`teardownPublisherPortal()` for test parity.

**3pa/B — i18n keys + safe DOM construction.** Replaces the
i18n-exempt scaffolding strings with `t()` calls under a new
`publisher.*` namespace (8 keys for placeholder + section
labels). Each key gets a translator-context entry in
`locales/_explanations.json`. While replacing the template-
literal `innerHTML`, also switches `renderPlaceholder` to
`createElement` + `textContent` + `replaceChildren` so the
`:id` URL segment cannot inject HTML by construction.

**3pa/C — /publish/me page with real profile data.** Replaces
the Profile placeholder with a glass-surface card that fetches
`GET /api/v1/publish/me` and renders email, role (with an Admin
badge when `is_admin` is true), affiliation (or "Not set"),
status (Active / Pending approval / Suspended, colour-coded via
a `data-status` attribute), and a localized "Member since" date.
Loading / error states (network / 401 session expired / 5xx /
JSON-parse failure) all share the same card chrome; a Refresh
button on every error state reloads the page so Cloudflare
Access can re-issue an identity token mid-session.
`renderMePage(mount, fetchFn?)` injects fetch for test
cleanliness — 11 tests with no `globalThis.fetch` stubbing. 20
new i18n keys under `publisher.me.*`.

**3pa/D — Glass-surface top bar with section nav.** Persistent
`position: sticky` topbar above every portal page with four
tabs (Profile / Datasets / Tours / Import) and a back arrow to
the SPA. Active-state tracking is decoupled from the router
via a new `publisher:routechange` CustomEvent — the router
fires it after every dispatch, the topbar listens and updates
its own DOM, neither holds a reference to the other. Sub-paths
count as active for the parent tab (so `/publish/datasets/abc`
keeps the Datasets tab highlighted). Plain left-clicks
short-circuit to `router.navigate()`; modified clicks
(cmd/ctrl/shift/middle) fall through so power users can open
sections in a new tab. 10 topbar tests + 6 new
`publisher.nav.*` i18n keys.

**3pa/E — Publisher portal analytics events.** Three new
`TelemetryEvent` types in `src/types/index.ts`:
`PublisherPortalLoadedEvent` (Tier A, fields: `route`),
`PublisherActionEvent` (Tier A, fields: `action`, hashed
`dataset_id`), and `PublisherValidationFailedEvent` (Tier B,
fields: `field`, `code`). Only `publisher_portal_loaded` is
emitted by 3pa code — fires once at portal boot with the
landing route. The other two are defined now so the emit-call
shapes are locked before 3pc / 3pd / 3pf call them. The three
new event-type strings land in `functions/api/ingest.ts` →
`KNOWN_EVENT_TYPES`. 13 new tests (route-mapping + emit-on-boot
across multiple paths + idempotency).

**3pa/F — Grafana "Publisher portal" row.** Three new panels
(ids 20–22) on the existing `Terraviz — Product Health`
dashboard at y=58: a daily-by-route timeseries, a total stat,
and a per-route table. Every panel pins
`blob1 = 'publisher_portal_loaded'` and uses `blob5 AS route`
(`PublisherPortalLoadedEvent`'s only own string field sorts to
the first user-blob slot). Dashboard version 9 → 10 so
operators re-import on upgrade and pick up the new row;
`product-health.test.ts` gains four new structural assertions
to keep the contract honest.

**3pa/G — SELF_HOSTING.md Access walkthrough for /publish/**.
New 8f subsection covering the second Cloudflare Access
application that gates the *browser* surface at `/publish/**`
(distinct from the existing 8a-8d setup for the API at
`/api/v1/publish/**`). Documents the path-mode subtlety
(`/publish` + `/publish/*` as two destinations), the
recommended 24-hour session, and the explicit safety note that
the in-between state (browser path reachable, API still 401s)
is safe — the API middleware is the load-bearing boundary, the
Access app is belt-and-suspenders.

**3pa/H — This file.**

### Operator-visible changes

- **New Pages route:** `/publish/me` (and `/publish/datasets`,
  `/publish/tours`, `/publish/import`, plus `/publish/datasets/:id`).
  All five render through the lazy portal chunk; only
  `/publish/me` exposes data today. The others render
  placeholders showing which sub-phase brings them online.
- **New analytics events:** `publisher_portal_loaded` (Tier A,
  emitted from 3pa onward); `publisher_action` and
  `publisher_validation_failed` (Tier A + B, types defined,
  emits land in 3pc–3pf).
- **New Grafana row:** Import `grafana/dashboards/product-health.json`
  version 10 to pick up the publisher row.
- **New Cloudflare Access application (optional):** see
  `docs/SELF_HOSTING.md` §8g. The portal works without it
  (the API is still gated), but operators wanting belt-and-
  suspenders should add the second Access app.

### What this sub-phase deliberately does not do

- **Write surfaces.** No edit form, no asset upload, no
  publish/retract from the browser. Those land in 3pc onward.
- **Tour creator.** 3pe.
- **Bulk import UI.** 3pf.
- **Webhook fan-out scaffolding.** 3pg.
- **Federation peer admin.** Phase 4.
- **OIDC / community publishers.** Phase 6.

### Sub-phase status

- **3pa — Portal shell + Access browser flow.** ✓ Shipped.
- **3pb — Dataset list + detail (read-only).** Next.
- 3pc – 3pg — Future.

---

## Phase 3-pre — Publisher portal prep

**Branch:** `claude/catalog-publisher-portal-phase-3`
**Commits:** 3-pre/A through 3-pre/C — three doc-only changes.

Sets the table for the BACKEND_PLAN's Phase 3 (publisher portal,
staff) without touching source code. The backend has been ready
since Phase 1f shipped — the publisher API at
`functions/api/v1/publish/**` exposes the full metadata + asset
+ tour + featured surface, the CLI binary at `cli/terraviz.ts`
drives it from a YAML, and the asset pipeline (R2 + HLS, R2
auxiliary assets, R2 tour.json) is live. What hasn't existed is
the browser-side portal under `src/ui/publisher/**`. This phase
prep closes the planning gaps before code starts.

**Why a prep phase at all.** Phase 3 in the backend plan is a
six-bullet list. Splitting it into shippable sub-phases up
front, and pinning the cross-cutting conventions (lazy-load
shape, i18n discipline, markdown sanitization, portal analytics,
Access browser policy) before the first form lands matches the
`CLAUDE.md` §"Working in this repo" "design firms up before
code" discipline and keeps each sub-phase PR bounded.

**3-pre/A — Sub-phase breakdown + portal conventions.**
`docs/CATALOG_BACKEND_PLAN.md` §Phase 3 gains a "Sub-phase
execution plan" table splitting the scope into seven
letter-suffixed sub-phases (3pa portal shell + Access browser
flow, 3pb read-only list + detail, 3pc dataset entry form, 3pd
asset uploader + preview pipeline, 3pe tour creator, 3pf bulk
import, 3pg webhook scaffolding + verify-deploy). Each
sub-phase ships as its own PR, is independently demoable, and
leaves the deploy in a working state so Phase 4 federation can
pull priority cleanly at any boundary.

`docs/CATALOG_PUBLISHING_TOOLS.md` gains a "Phase 3
implementation conventions" section covering the five gaps the
per-feature sections leave implicit:

- **Lazy-load shape** — single `import('./ui/publisher')` from
  `src/main.ts` gated on a `/publish` path prefix, History API
  routing, no framework. Mirrors the
  `src/ui/vrButton.ts` → `import('three')` pattern that already
  keeps Three.js out of the main bundle.
- **i18n discipline** — every string in `src/ui/publisher/**`
  flows through `t()`, ~100–150 new keys under a `publisher.*`
  namespace, picked up by the existing `check:i18n-strings`
  lint that already runs in the type-check chain.
- **Markdown sanitization** — `marked` (already a build-time dep
  used by `scripts/build-privacy-page.ts`) promoted to runtime
  at ~30 KB gzipped, plus a new `DOMPurify` runtime dep at ~25
  KB gzipped, with a strict tag/attr allow-list. Shared
  renderer at `src/services/markdownRenderer.ts` used by both
  the portal preview and the eventual public detail page so
  preview is byte-for-byte the public render. Both deps load
  through the lazy portal chunk; non-publisher visits pay
  nothing.
- **Portal analytics** — four new events
  (`publisher_portal_loaded`, `publisher_action` in Tier A;
  `publisher_validation_failed`, `publisher_dwell` in Tier B)
  matching the existing `ANALYTICS.md` shape. Server-side
  `audit_events` rows stay the source of truth for who-did-what;
  the Tier-A events power the operator dashboard without
  persisting publisher identity client-side. Grafana gains a
  "Publisher activity" row in 3pa.
- **Cloudflare Access browser policy** — extends the Phase 1a
  service-token application to cover `/publish/**` HTML in 3pa.
  `DEV_BYPASS_ACCESS=true` continues to work for local dev on
  the browser side.

The threat-model section "XSS via publisher markdown" in the
backend plan is the substrate; the new sanitizer subsection pins
the implementation.

**3-pre/B — Retag sub-phases as 3pa–3pg.** The original 3-pre/A
labelling used bare `3a`–`3g` sub-phase letters, which collide
with the merged R2 + HLS video-pipeline work that already
claimed `catalog(3a/...)` through `catalog(3h/...)` in the
CHANGELOG and `git log`. Tooling and humans both grep on the
commit-prefix substring, so reusing the bare letters would
conflate two unrelated bodies of work. 3-pre/B retags the portal
sub-phases as `3pa`–`3pg` in both docs and adds a short note in
each explaining why the `p` qualifier exists. The BACKEND_PLAN's
"Phase 3 — Publisher portal" designation stays intact at the
semantic level; only commit and CHANGELOG prefixes carry the
qualifier.

**3-pre/C — This file.**

### Operator-visible changes

None. Doc-only. No new env vars, no new bindings, no new
migrations.

### What this phase deliberately does not do

- **Ship any source code under `src/ui/publisher/**`.** That
  starts with 3pa.
- **Wire the Cloudflare Access browser policy.** The policy is
  dashboard-managed (see BACKEND_PLAN §"Constraints found during
  exploration" constraint 3); operator steps land in
  `docs/SELF_HOSTING.md` during 3pa.
- **Add the new dependencies (`marked` runtime, `DOMPurify`) to
  `package.json`.** They land with the renderer in 3pc.
- **Touch the federation phase plan.** Phase 4 is unchanged and
  unblocked by Phase 3.

### Sub-phase roadmap

The seven sub-phases ship in order. Pausing between any pair is
deliberately cheap:

| Sub-phase | Topic | Demoable result |
|---|---|---|
| 3pa | Portal shell + Access browser flow | `/publish/me` renders behind Access |
| 3pb | Dataset list + detail (read-only) | Browse drafts/published from the portal |
| 3pc | Dataset entry form (metadata) | Create + edit drafts without asset upload |
| 3pd | Asset uploader + preview pipeline | Upload a video or image and preview it on the live globe |
| 3pe | Tour creator (capture mode) | Author and play back a tour without writing JSON |
| 3pf | Bulk import UI | Drop a CSV and watch rows materialise |
| 3pg | Webhook fan-out + verify-deploy | Phase 4 federation hook ready; smoke-test green |

Exit criteria for Phase 3 as a whole match the existing backend
plan: a staff user can publish a new dataset and a new tour
end-to-end through the browser without touching the CLI or D1 /
R2 manually.

---

## Phase 3c — Tour JSON migration

**Branch:** `claude/tour-migration-phase-3c`
**Commits:** 3c/A through 3c/G — seven logical changes plus
three operator-side probe scripts (3c/A-probe / 3c/A-sweep /
3c/A-dump) and a parser extension (3c/A-extend).

Phase 3b finished migrating the auxiliary asset URLs onto R2;
this phase migrates the *tour.json* files (and their sibling
overlay images / narrated audio / 360-pano JPGs) the SOS catalog
references via the `run_tour_on_load` column. After 3c ships
the noaa.gov dependency for tour playback is gone — federation
peers can mirror tours without reaching back to NOAA's
CloudFront.

**Strict-relative policy.** Tour task fields that hold *relative*
references (sibling-of-tour.json filenames like `audio/intro.mp3`)
get migrated. *External* URLs (YouTube embeds, Vimeo, popup web
links) are left verbatim — the operator can't legally re-host
them and they're not migratable assets anyway. The parser
classifies every URL-bearing task field as relative /
absolute_external / absolute_sos_cdn so the dashboard can size
the residual external-CDN dependency.

**3c/A — `cli/lib/tour-json-parser.ts`.** Pure / deterministic /
no-I/O library that walks a parsed SOS tour file and produces a
catalog of `(rawValue, source, kind)` entries plus a list of
unknown task names. Covers playAudio / playVideo / showVideo /
showImage / showImg / question / showPopupHtml / addPlacemark
out of the gate; iteratively extended (3c/A-extend) to cover
addBubble / showInfoBtn / hideInfoBtn / loadTour / showLegend /
worldBorders after a full-catalog sweep flagged them in real
tour.json files. Final parser surface: zero unknown task types
across all 198 fetchable production tours.

Companion operator scripts (in `scripts/`):
  - `probe-tour-parser.ts` — fetch one tour.json + run the parser
  - `sweep-tour-parser.ts` — fetch all 199 + aggregate counts
  - `dump-unknown-tour-tasks.ts` — print the verbatim JSON of
    every blind-spot task so the parser extension is single-pass

**3c/B — `terraviz migrate-r2-tours`.** Per-row atomic pump.
Pipeline: GET row → fetch tour.json → parse → resolve every
relative sibling URL against the tour.json URL → fetch each
sibling (deduped by sibling-key) → upload tour.json + every
sibling to `tours/<id>/...` → PATCH `run_tour_on_load` to
`r2:tours/<id>/tour.json`. Any failure pre-PATCH leaves the row
on NOAA (no broken-tour hazard); a PATCH failure after uploads
succeeded leaves R2 orphans that the next migration run
clobbers on the re-PUT or that `rollback-r2-tours` cleans up.
Outcomes: `ok` / `dead_source` (NOAA 404 — intentionally not
counted as a failure) / `fetch_failed` / `parse_failed` /
`sibling_fetch_failed` / `upload_failed` / `patch_failed`. Flags
mirror 3b's: `--dry-run`, `--limit=N`, `--id=<dataset>`,
`--pace-ms=N`. Idempotent on `r2:`-prefixed rows.

**3c/C — `migration_r2_tours` Tier A event + ingest
registration.** Per-row event (vs 3b's per-asset) carrying
dataset_id, legacy_id, source_url, r2_key, source_bytes,
siblings_relative / _external / _sos_cdn / _migrated,
duration_ms, outcome. Added to `KNOWN_EVENT_TYPES` so AE
persists the events; same generic blob/double mapping the other
migration events use.

**3c/D — `terraviz rollback-r2-tours`.** Symmetric inverse —
single-row and bulk `--from-stdin` modes, same per-row pipeline:
verify `r2:`, recover original URL from SOS snapshot (or
`--to-url=<url>`), PATCH back, delete the `tours/<id>/` R2
prefix in one list+parallel-DELETE pass. Catalog-correct
exit-0 even if the R2 cleanup orphans, surfaced as
`delete_failed` in the summary. Defensive: refuses to roll
back a malformed `r2:no-slash-key` that could otherwise risk
deleting a wider prefix than intended.

**3c/E — Serializer wires `r2:` `run_tour_on_load` to a public
URL.** `serializeDataset` already passed thumbnail / legend /
caption / color_table through the `AssetRefResolver`; this
commit applies the same resolver to `runTourOnLoad` so a row
whose `run_tour_on_load` is `r2:tours/<id>/tour.json` resolves
to the `R2_PUBLIC_BASE`-rooted URL the SPA can actually fetch.
Bare https URLs (pre-3c rows still on NOAA) pass through
unchanged.

**3c/F — Tour-migration row on Product Health dashboard.** Three
panels at y=50 (just below 3b's asset row at y=42): events-per-
day-by-outcome timeseries, cumulative-ok stat, non-ok outcome
breakdown table. Pinned blob position: `blob7 AS outcome`
(distinct from migration_r2_assets's `blob8 AS outcome` — the
tour event has no `asset_type` field, so outcome lands one
position earlier). Dashboard version bump 8 → 9.

**3c/G — Docs.** This entry plus the new "Migrating tour.json
files to R2" runbook section in
`docs/CATALOG_BACKEND_DEVELOPMENT.md` (parallel to 3b's auxiliary
asset migration runbook).

**Operator quick-start.**

```sh
set -a; . ~/.terraviz/prod.env; set +a

npm run terraviz -- migrate-r2-tours --dry-run
npm run terraviz -- migrate-r2-tours --limit=5
npm run terraviz -- migrate-r2-tours

# Roll back one row:
npm run terraviz -- rollback-r2-tours <dataset_id>

# Bulk rollback from telemetry-filtered NDJSON:
... | npm run terraviz -- rollback-r2-tours --from-stdin
```

No new env vars, no new bindings. Same R2 token Phase 3 and 3b
used; same `R2_PUBLIC_BASE` custom domain.

**Migration size at 3c cut-over.**

  - **198 tour.json files** fetchable on NOAA's CDN (1 dead
    source: `INTERNAL_SOS_726_ONLINE` — already broken
    pre-migration; stays `dead_source` and the operator
    handles via row deletion / replacement separately).
  - **71 relative sibling assets** across ~30 rows. Most rows
    are pure-navigation tours with zero siblings; the
    sibling-bearing tours concentrate in a few rich ones
    (`ID_INTERNAL_pandemic` ×12, `ID_LJCOFJCSGH` ×9,
    `INTERNAL_SOS_687` ×9, `INTERNAL_SOS_HRRR_Smoke_Tour_Mobile`
    ×7).
  - **44 external URLs** (YouTube embeds, Vimeo, popup web
    links) — left verbatim per the strict-relative policy.
  - **0 absolute_sos_cdn** URLs — tour task fields don't
    reference noaa.gov absolutes; the SOS authoring convention
    uses sibling-relative paths consistently.

**Non-goals (deferred / out-of-scope).**

  - **Rewriting external links to local mirrors.** Policy 1 is
    relative-only. A future "policy 2" pass could mirror
    YouTube / Vimeo content to a local video store, but that's
    a separate licensing + storage decision.
  - **`absolute_sos_cdn` rewriting.** Zero rows hit this case at
    3c cut-over, so the parser surfaces the count but the pump
    doesn't act on it.
  - **Per-task-type SPA enhancements.** The parser surfaced six
    task names the SPA's tour engine silently ignores
    (addBubble / showInfoBtn / hideInfoBtn / loadTour /
    showLegend / worldBorders). Wiring them up is a separate
    SPA feature; this phase just makes sure the bytes migrate
    cleanly when they're referenced.

---

## Phase 3h — VR / Three.js parity for bbox projection

**Branch:** `claude/vr-bbox-non-earth-phase-3h`
**Commits:** 3h/A through 3h/C.

Phase 3e (below) shipped bbox projection and dateline-centered
rendering on the 2D `earthTileLayer.ts` WebGL custom layer, but
the immersive VR / AR view goes through a different code path —
`photorealEarth.ts` builds its own `THREE.MeshPhongMaterial` with
a day/night shader patch, atmosphere shells, sun sprite, clouds,
and progressive 2K → 4K → 8K diffuse tiers. Pre-3h, a regional
dataset loaded in VR stretched equirectangularly across the full
sphere; dateline-centered datasets wrapped with the prime
meridian in the wrong place. Phase 3h ports the 3e shader work
into the VR Phong material so the immersive view matches the 2D
behaviour on the primary globe.

**3h/A — Plumb `DatasetOverlayOptions` into `VrDatasetTexture`.**
The texture spec the VR session polls from the host gains an
optional `options` field carrying the same Phase 3d metadata the
2D renderer consumes. `main.ts`'s `getPanelTexture` populates it
from the loaded dataset via the existing
`overlayOptionsFromDataset` helper, so the VR side reuses the
2D's SOS-convention Earth-alias logic and "all defaults →
undefined" fast path. Pure plumbing; no rendering change yet.

**3h/B — Bbox / lonOrigin / flipY shader.** `onBeforeCompile`
on the Phong material gains a `<map_fragment>` replacement that
mirrors `earthTileLayer.ts`'s `datasetFragSrc` — same lat/lon
derivation, same antimeridian-crossing-bbox handling, same
`fract()` U-wrap for the lonOrigin path. Five new uniforms
(`uOverlayHasBbox`, `uOverlayBbox`, `uOverlayLonOrigin`,
`uOverlayFlipY`, `uOverlayHasBase`) plus a second sampler
(`uOverlayBaseMap`) for the "outside the bbox shows Earth"
case — needed because in VR there isn't a separate MapLibre
blue-marble layer underneath, so the shader has to sample two
textures and choose.

**Rule table (matches Phase 3e/C on the 2D side):**

| Case | Inside bbox | Outside bbox |
|---|---|---|
| Earth + no bbox     | dataset (full sphere) | n/a |
| Earth + bbox        | dataset | `uOverlayBaseMap` (progressive diffuse tier) |
| non-Earth + bbox    | dataset | `discard` |
| non-Earth + no bbox | dataset (full sphere) | n/a |

With every overlay uniform at its default the math collapses to
a pass-through and the shader output is bit-identical to the
pre-3h sample, so the planet-mode photoreal Earth and any legacy
global dataset render unchanged.

A small `applyOverlayOptions(options)` helper centralises the
uniform writes so the change-detect no-op path can re-apply the
uniforms if a dataset is re-loaded with new metadata (a tour
task patching a row mid-session, for example). The
`uOverlayBaseMap` binding tracks the progressive diffuse-tier
upgrade callback so the bbox+Earth view sharpens 2K → 4K → 8K
alongside planet mode.

**3h/C — This CHANGELOG entry.**

**Operator notes.**

- No new env vars, no new bindings, no schema changes —
  builds entirely on the 3d wire surface, same as the 2D 3e/3f
  port.
- After deploy, smoke-check on a WebXR device (Quest 2/3/Pro):
  - `INTERNAL_HRRR_SMOKE_SEPTEMBER_2017_VIDEO` — regional CONUS
    bbox, should render only over CONUS in immersive mode, with
    the Earth diffuse filling the rest of the globe (no longer
    stretched across the full sphere).
  - Any dateline-centered ocean dataset — Pacific should be the
    visible center, same as 2D.
  - A non-Earth row (e.g. `INTERNAL_SOS_215_ONLINE` Venus,
    `INTERNAL_SOS_220_ONLINE` Moon) — should still wrap the full
    sphere as before; the non-Earth + bbox combination doesn't
    appear in the catalog today but the `discard`-outside path
    is wired for when it does.
  - Any legacy global Earth dataset — should look bit-identical
    to pre-3h immersive view.
- WebGL output is browser/headset confirmed; unit tests cover
  plumbing via the existing `datasetOverlayOptions.test.ts`
  suite (14 tests, unchanged).

**Non-goals (deferred / out-of-scope).**

- **Secondary globe parity** (Phase 2.5 multi-panel layouts).
  Secondaries use a basic `MeshPhongMaterial` without the
  day/night shader patch; bbox treatment would mean duplicating
  the shader injection or extracting a shared builder. The
  primary-globe parity that ships here covers the common case
  (a regional dataset in slot 0); slot ≥ 1 with a regional
  dataset still stretches as today. Tracked separately as
  follow-up if a real layout combination needs it.
- **Per-body surface textures** — Phase 3g (issue #109). When
  3g lands, non-Earth + bbox should reveal that body's surface
  outside the bbox instead of `discard`-ing — the
  `uOverlayHasBase` + `uOverlayBaseMap` plumbing already added
  here is the hook.
- **Camera fly-to-bbox on dataset entry into VR** — same
  posture as the 2D non-goal in 3e.

---

## Phase 3f — Non-Earth body gating

**Branch:** `claude/non-global-rendering-phase-3e` (shipped together
with Phase 3e — same PR, same in-tree commit prefix `3e/D`; the
CHANGELOG split into two phases happened after the work was
already written, so the commit prefix and the section heading
disagree intentionally).
**Commits:** delivered as `3e/D` in-tree.

Phase 3e (below) bbox-projects regional and dateline-centered
datasets, but still draped Earth's blue/black marble behind any
non-Earth dataset (Mars / Moon / Sun / Jupiter / Saturn / Venus /
…). Phase 3f teaches the renderer to hide the Earth raster bases
when `celestialBody` says the dataset isn't Earth, so non-Earth
rows render over a clean sphere instead of a wrong-planet base.

20 SOS rows are affected today; any future publisher-portal
upload that sets a non-Earth `celestialBody` picks this up
automatically.

**Implementation.** The same `applyBaseLayerVisibility()` helper
introduced in 3e/C factors in `celestialBody`. The Earth 4-pass
effects shader (day/night terminator, lights, specular, clouds)
was already skipped for any dataset-active render via the existing
early return; nothing additional needed there. Non-Earth datasets
simply lose the Earth raster bases.

**Operator smoke-check.** Pick a non-Earth row (e.g.
`INTERNAL_SOS_215_ONLINE` Venus, `INTERNAL_SOS_220_ONLINE` Moon) —
the dataset should render over a clean sphere with no Earth base
visible.

**Non-goals (deferred / out-of-scope).**

- **Per-body surface textures** (Mars Viking mosaic, LRO Moon,
  Sun SDO mosaic, etc.) — Phase 3g. Asset-sourcing decision
  separate from the rendering pipeline; would inflate the SPA
  bundle by several MB.
- **`radiusMi` consumption** — also Phase 3g; pairs with per-body
  proportional sizing.
- **VR / Three.js parity** — Phase 3h. `photorealEarth.ts` has
  its own diffuse / night-lights / atmosphere stack; the non-Earth
  + bbox work needs porting separately.

---

## Phase 3e — Non-global bbox projection

**Branch:** `claude/non-global-rendering-phase-3e`
**Commits:** 3e/A through 3e/E (plus 3e/F Copilot review round).

Phase 3d landed `boundingBox` / `celestialBody` / `radiusMi` /
`lonOrigin` / `isFlippedInY` on the wire; nothing in the SPA
consumed them. This phase consumes the bbox-projection slice
(`boundingBox` + `lonOrigin` + `isFlippedInY`); Phase 3f (above)
consumes `celestialBody`. `radiusMi` remains unconsumed until
Phase 3g. The rendering changes are end-to-end visible:

- Regional datasets (today: `INTERNAL_HRRR_SMOKE_SEPTEMBER_2017_VIDEO`
  over CONUS; future: any publisher-portal upload with a bbox)
  wrap their texture to the bbox extent instead of being stretched
  equirectangularly across the whole sphere. The rest of the
  globe shows the GIBS blue/black marble base.
- Dateline-centered datasets (12 SOS rows with `lonOrigin: ±180`)
  rotate the texture so the Pacific reads as the visible center.

**3e/A — Plumb 3d metadata into the renderer.** New
`DatasetOverlayOptions` type in `src/types/index.ts`;
`GlobeRenderer.updateTexture` / `setVideoTexture` signatures
gain an optional `options` parameter. Two pure helpers in
`src/services/datasetOverlayOptions.ts`:

- `isEarthBody(name)` — SOS-convention "is this Earth?" check
  (null / "" / case-insensitive "earth" all qualify; everything
  else falls in the non-Earth bucket including "aurora" — the
  renderer trusts the catalog row, not the phenomenon's
  geography).
- `overlayOptionsFromDataset(dataset)` — builds the option
  bundle from a loaded `Dataset`, returning `undefined` when
  every field is at its default so legacy datasets stay on the
  pre-3e renderer fast path.

`datasetLoader.ts` calls the helper before handing the texture
to the renderer. `mapRenderer.ts` buffers options alongside the
pending texture/video for the race where dataset load fires
before MapLibre's `load` event; `earthTileLayer.ts` captures
them into module-scope state. No rendering change yet at this
commit — pure plumbing.

**3e/B — Dataset overlay shader.** The `datasetFragSrc` GLSL
grows from a one-line `texture(uDatasetTex, vUV)` passthrough
into a per-fragment bbox-aware projection:

- Computes geographic `lat`, `lon` from `vUV`.
- `uHasBbox` mode: clips fragments outside `[s, n]` lat or
  `[w, e]` lon (handling antimeridian-crossing boxes where
  `w > e` correctly). Inside, remaps UVs so the texture
  STRETCHES to the bbox extent.
- `!uHasBbox` mode: full-globe path with `uLonOrigin`
  shifting the U axis; `lonOrigin = 0` reduces to
  `vUV.x` passthrough so legacy datasets are bit-identical.
- `uFlipY` applies last in both paths.

Four new uniforms on the `DatasetProgram`. The render pass
sets them from `datasetOptions` per draw; defaults restore
pre-3e behavior.

**3e/C — Base raster reveal.** A new
`applyBaseLayerVisibility()` private helper on `MapRenderer`
replaces the previous "always hide blue + black marble on
dataset load" behavior. Rule table:

| Case | Base layer |
|---|---|
| Earth + no bbox      | hide (dataset covers full sphere) |
| Earth + bbox         | show (base fills outside the bbox) |
| non-Earth (any case) | hide (Earth tiles wrong for Mars / Moon / …) |

The dataset overlay shader's `discard` outside the bbox is
what lets the base layer show through underneath; without
3e/C the discarded fragments would have shown nothing.

**3e/D — Delivered as Phase 3f.** See §Phase 3f above. The work
sits under the `3e/D` commit prefix in git because it landed
before the CHANGELOG split, but its narrative belongs in the
non-Earth-gating phase.

**3e/E — Tests + docs.** 14 new tests on the helper module
(`datasetOverlayOptions.test.ts`) covering the SOS-convention
Earth aliases, the "all defaults → undefined" fast path,
populated-bundle round-trips, and defensive coverage of
non-finite `lonOrigin` values. Plus this CHANGELOG entry.
WebGL is integration-only — unit tests cover plumbing
(`overlayOptionsFromDataset` returns the right bundle, the
renderer accepts it) but the shader output itself is browser
/ headset confirmed.

**3e/F — Copilot review fixes.** Five doc / comment-only
adjustments from PR #108 review: Markdown table fix on the
base-layer rule table, JSDoc clarifications around the
unsupported bbox + non-zero `lonOrigin` combination and the
`celestialBody: ""` fast-path return, and reworded inline
comments on the bbox-interior opaque-not-translucent draw call
and the `datasetOptions` state-reset in `setDatasetTexture`.

**Operator notes.**

- No new env vars, no new bindings, no schema changes —
  builds entirely on the 3d wire surface.
- After deploy, smoke-check with:
  - `INTERNAL_HRRR_SMOKE_SEPTEMBER_2017_VIDEO` — regional CONUS
    box, should render only over CONUS with blue marble
    everywhere else.
  - Any dateline-centered ocean dataset — Pacific should be
    the visible center.
  - `INTERNAL_SOS_MARIA_360` (Hurricane Maria 360-pano tour) —
    treated as Earth, base layers hidden as before.

**Non-goals (deferred / out-of-scope).**

- **Non-Earth gating** — split out to Phase 3f (above).
- **Per-body surface textures** (Mars Viking mosaic, LRO Moon,
  Sun SDO mosaic, etc.) — Phase 3g. Asset-sourcing decision
  separate from the rendering pipeline.
- **VR / Three.js parity** — Phase 3h. `photorealEarth.ts`
  has its own diffuse / night-lights / atmosphere stack; the
  non-Earth + bbox work needs porting separately.
- **Camera fly-to-bbox on dataset load** — would be a nice UX
  affordance but the existing camera-position behavior is
  fine; defer until publisher feedback says otherwise.
- **R-tree spatial index for browse "datasets in this region"**
  — federation-era concern.

---

## Phase 3d — Non-global metadata foundation

**Branch:** `claude/non-global-metadata-phase-3d`
**Commits:** 3d/A through 3d/B — two logical changes (schema +
serializer surface, then docs).

Restores another piece of catalog data Phase 1d dropped on the
floor, and corrects a Phase 3b mislabel along the way.

**Strict back-end scope.** This phase only persists the metadata
+ surfaces it on the wire. The SPA-side rendering — wrapping
non-global data onto the correct portion of the globe, and
swapping the base texture for non-Earth bodies — is Phase 3e in
a separate PR, where the visual scrutiny + screenshot review
belongs.

**3d/A — Migration `0010` + typed metadata.**

- Promotes the legacy `bounding_variables` column from a JSON
  text blob to four typed REAL columns `bbox_n` / `bbox_s` /
  `bbox_w` / `bbox_e`. The 3b migration described the column as
  "per-variable data ranges"; production inspection showed every
  populated row actually held a geographic NSWE bounding box
  (`{n: "90", s: "-90", w: "-180", e: "180"}`). The mislabel
  made the column inert — no consumer parsed it. Typed columns
  let the publisher API validate lat/lon ranges, the wire surface
  a typed `boundingBox: { n, s, w, e }` object, and Phase 3e's
  shader project data to the correct sub-region of the sphere.
  In-line UPDATE backfills the typed columns from the existing
  JSON; the legacy column drops at the end of the migration.

- Adds four columns for SOS metadata previously deferred:
  `celestial_body` (20 rows ship a non-Earth value — Mars, Moon,
  Sun, Jupiter, Saturn, Mercury, Venus, Pluto, Neptune, Uranus,
  Io, Europa, Ganymede, Callisto, Enceladus, Titan, 67p, aurora,
  Trappist-1d, Kepler-10b), `radius_mi` (paired with
  `celestial_body`), `lon_origin` (12 rows use ±180 for
  dateline-centered datasets), `is_flipped_in_y` (image
  orientation flag; zero rows use it today but persisted for
  future publishers whose imagery uses inverted-Y conventions).

- Publisher API gains typed validation: `validateBoundingBox`
  (lat/lon ranges, `n >= s`, antimeridian-crossing `w > e`
  permitted); `validateRadiusMi` (positive finite, bounded
  loosely at 1e9); `validateLonOrigin` ([-180, 180]); plus
  inline type-checks on `celestial_body` /
  `is_flipped_in_y`. Each violation pinpoints the offending
  sub-field (e.g. `bounding_box.n` / `invalid_value`) so a
  publisher-portal client can highlight the wrong corner
  specifically.

- The importer's `--update-existing` backfill grows from 3
  columns to 7. Existing rows imported under 3b that already
  have `bounding_variables` populated get their bbox migrated
  automatically by the in-line UPDATE in migration 0010; rows
  without populated metadata stay clean.

**3d/B — Docs.** This CHANGELOG entry. No runbook section —
3d is schema-and-types only; operators don't run anything new
(the `import-snapshot --update-existing` flow from 3b is the
same flow with a wider column set).

**Operator notes.**

- The migration is additive (8 ADD COLUMN + 1 DROP COLUMN);
  the DROP COLUMN needs SQLite ≥ 3.35.0, which D1 satisfies.
- No new env vars, no new bindings.
- After deploy, re-run `terraviz import-snapshot --update-existing`
  to backfill the four new SOS fields onto existing rows.
  Idempotent — already-populated rows skip.

**Non-goals (deferred / out-of-scope).**

- **SPA rendering against the new fields** — Phase 3e. The
  bbox-bounded shader change, `lon_origin` / `is_flipped_in_y`
  plumbed into the UV math, and non-Earth base textures
  (Mars / Moon / Sun / …) all live there.
- **Spatial filtering in browse.** "Datasets in this region"
  would benefit from an R-tree index; the current row count
  makes a table scan over `WHERE bbox_n IS NOT NULL`
  essentially free, so the index is punted to a federation-era
  concern.
- **The other ~10 dropped SOS fields** — SOS-desktop UI flags
  (`assetBundleFilename`, `autoLoadFirstLayer`, …), VR-search
  filter (`isHiddenFromVRSearch`), KML overlay features
  (`kmlIconScaleFactor`, …). Still no web SPA equivalent.

---

## Phase 3b — Auxiliary asset migration + catalog data completeness

> **Phase 3d correction (2026-05):** the `bounding_variables`
> column described below was *not* "per-variable data ranges" —
> the actual content is the geographic NSWE bounding box
> `{ n, s, w, e }`. Phase 3d (above) promoted it to typed
> columns (`bbox_n` / `bbox_s` / `bbox_w` / `bbox_e`) and
> dropped the legacy column. The bbox data itself survives in
> the typed columns; only the wire surface (and the misleading
> name) changed.

**Branch:** `claude/auxiliary-asset-migration-phase-3b`
**Commits:** 3b/A through 3b/K — eleven logical changes.

Phase 3 migrated the video `data_ref`; Phase 3b migrates the
*auxiliary* asset URLs (thumbnail / legend / caption /
color-table) from NOAA's CloudFront onto R2 under
`datasets/{id}/...`. After 3b ships, the catalog is fully self-
hosted end-to-end — federation peers can mirror datasets without
reaching back to noaa.gov.

A side-effect of the audit work that motivated the expanded
scope: the Phase 1d import dropped several useful SOS fields on
the floor. 3b restores three of them.

**3b/A — Schema migration `0009`.** Three new columns on
`datasets`: `color_table_ref` (4th auxiliary asset URL distinct
from `legend_ref` in ~2 of 14 overlap rows), `probing_info`
(JSON-stringified pixel-coords → data-value mapping for the SOS
interactive-probe feature; 19 rows), `bounding_variables`
(JSON-stringified per-variable data ranges; 27 rows). Plumbed
through `DatasetRow` / `WireDataset` / `Dataset` /
`DatasetDraftBody` / `createDataset` / `updateDataset` /
`serializeDataset`. New `validateJsonStringField` enforces
JSON parseability + 4096-char cap on write. Backwards-compatible
additive only.

**3b/B — Importer reads the new fields + rescues 4 dropped rows.**
`cli/lib/snapshot-import.ts` reads `colorTableLink` /
`probingInfo` / `boundingVariables` from the SOS snapshot and
JSON-stringifies the structured pair for D1 storage. New
`pickDataLink(sos)` helper rescues 4 SOS rows (Venus, Moon,
Moon Topography, Pluto) that previously dropped as
`missing_data_link` due to an upstream `datalink` (lowercase l)
casing inconsistency.

**3b/C — `--update-existing` backfill flag on `import-snapshot`.**
Tight-scope PATCH: a constant `BACKFILL_FIELDS` tuple defines
exactly which columns get touched (the three new ones), so a
re-import never clobbers publisher-edited title / abstract /
etc. Reports `backfilled` / `backfill_noop` / `backfill_failed`
in the summary. `--dry-run` shows the per-row count without
issuing PATCHes.

**3b/D — `cli/lib/asset-fetch.ts`.** HTTP GET with 50 MiB default
size cap, two-step rejection (Content-Length pre-flight + mid-
stream cancel), URL-derived extension, Content-Type fallback
to a URL-extension lookup when the server returns
`application/octet-stream` (NOAA CloudFront's behavior for
`.srt` captions). Exports `extensionFromUrl`, `mimeForExtension`,
`resolveContentType` for downstream consumers.

**3b/E — `cli/lib/srt-to-vtt.ts`.** Small pure-function library.
Prepends `WEBVTT` header, swaps comma → period in cue timestamps
(anchored on the `-->` arrow so dialogue commas are untouched),
strips UTF-8 BOM, normalizes CRLF/CR to LF. Cue numbering
preserved (legal in WebVTT as cue identifiers).

**3b/F — `uploadR2Object` extension to `cli/lib/r2-upload.ts`.**
Single-file PUT companion to `uploadHlsBundle`. Same SigV4
signing, `R2UploadError` on failure.

**3b/G — `cli/migrate-r2-assets.ts` main pump.** Walks the
catalog, per-asset pipeline: read `*_ref` → skip if r2:- or
empty → fetchAsset → optional SRT→VTT inline → uploadR2Object →
single row-level PATCH covering every asset that succeeded.
One `migration_r2_assets` telemetry event per attempted asset.
A `patch_failed` row promotes every prior `ok` asset's event
to `patch_failed` so orphan R2 objects are visible in Grafana.
Per-asset failures don't abandon other assets on the row.

**3b/H — `migration_r2_assets` Tier A telemetry event.** New
`MigrationR2AssetsEvent` interface (+ `MigrationR2AssetsOutcome`
+ `MigrationR2AssetsType` unions) added to `TelemetryEvent`
union; `migration_r2_assets` registered in `KNOWN_EVENT_TYPES`
on the ingest endpoint. One event per (row, asset_type) pair,
not per row.

**3b/I — `cli/rollback-r2-assets.ts`.** Symmetric inverse of
3b/G. Per-row + bulk (`--from-stdin`) modes; single-row
supports `--types` and `--to-url` overrides. Original NOAA URL
recovered from the SOS snapshot by legacy_id; `--to-url=<url>`
overrides for non-SOS catalogs. PATCH then DELETE (single-key
via new `deleteR2Object` helper in `r2-upload.ts`). Delete
failures non-fatal — catalog correct, orphan R2 storage
operator-visible.

**3b/J — Grafana asset-migration row on Product Health.** Three
new panels at y=42 keyed off `migration_r2_assets`. Cumulative
ok grouped by asset_type, runs per day by outcome, failure
breakdown table. Dashboard version 7 → 8.

**3b/K — Docs.** This CHANGELOG entry, runbook section in
`CATALOG_BACKEND_DEVELOPMENT.md` covering the migrate → list →
rollback flow, and expected-bindings audit (no new env vars —
the migration uses the same `R2_PUBLIC_BASE` / `R2_S3_ENDPOINT`
/ `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` as Phase 3,
documented with the new asset-migration use case).

**Tests.** 95 new across the eleven commits — full suite
~2220 passing on completion. Per-module breakdown in the PR
description on PR #99.

**Operator-visible changes.**

```sh
# Backfill already-imported rows with the three new columns:
npm run terraviz -- import-snapshot --update-existing --dry-run
npm run terraviz -- import-snapshot --update-existing

# Migrate asset URLs to R2 (idempotent — re-runs safe):
npm run terraviz -- migrate-r2-assets --dry-run
npm run terraviz -- migrate-r2-assets --limit=5     # sanity batch
npm run terraviz -- migrate-r2-assets               # full run

# Per-type rollout (do thumbnails first, captions later):
npm run terraviz -- migrate-r2-assets --types=thumbnail

# Per-row rollback (snapshot recovers the NOAA URL):
npm run terraviz -- rollback-r2-assets <id> --types=thumbnail

# Bulk rollback from telemetry-filtered NDJSON:
... | npm run terraviz -- rollback-r2-assets --from-stdin
```

No new env vars. Schema migration 0009 is additive (three
nullable columns, no indexes) and reverts cleanly via
`ALTER TABLE … DROP COLUMN`.

**Non-goals (deferred to later phases).**

- **Tour JSON migration** — Phase 3c-shaped follow-up. ~199
  SOS rows reference tour JSON files but the `tours` table is
  empty.
- **SPA consumption of `probing_info`** — interactive hover-to-
  probe tooltips. Separate downstream feature; this PR just
  persists the data.
- **Non-Earth globe support** — `celestialBody` / `radiusMi` for
  Mars / Moon / Pluto. Phase 5+ feature.
- **The other 12 dropped SOS fields** — SOS-desktop UI flags /
  GIS-only / VR-search filters. No web SPA equivalent.

---

## Phase 3a — Real-time row guard for migrate-r2-hls

**Branch:** `claude/realtime-row-filtering`
**Commits:** 3a/A through 3a/C — three logical changes (one
forward-protection guard + two triage helpers).

Phase 3 was a one-shot encode (Vimeo source → R2-hosted HLS).
A handful of SOS rows (~40) are titled `… - Real-time` and have
their Vimeo IDs re-uploaded by NOAA's automation daily — the R2
copy goes stale within 24h. Without a guard, the bulk migration
would happily encode these and the SPA would serve yesterday's
data on the affected rows.

**3a/A — `--skip-realtime` flag for `migrate-r2-hls` (default on).**
Filters the migration plan by matching `/real[-\s]?time/i`
against the row title. The SOS catalog has no explicit
`update_cadence` field so the title is the only reliable signal;
the substring check is the same one the catalog UI uses
informally to label these rows. Plan summary surfaces the
skipped count + first 5 IDs so the operator can sanity-check
the heuristic. `--no-skip-realtime` opts back in for the bulk
path; `--id <row>` is treated as a deliberate override
(warning to stderr when the targeted row matches, but no skip).

**3a/B — `terraviz list-realtime-r2` triage helper.**
Read-only. Walks the catalog (`status=published`), filters to
rows with `data_ref` starting `r2:videos/` AND `format =
video/mp4` AND `isRealtimeTitle(title)`, joins each match
against `public/assets/sos-dataset-list.json` via the row's
`legacy_id` (1:1 with `entry.id` per the Phase 1d import
contract) to extract the original Vimeo id from `dataLink`.
Two output modes: NDJSON by default (one JSON object per line,
designed for piping into `rollback-r2-hls --from-stdin`), and
`--human` for a readable table with a rollback-pipe hint.
Rows whose snapshot lookup fails (legacy_id missing or dataLink
not a vimeo.com URL) emit to stderr with empty `vimeo_id` so
they don't pollute the NDJSON pipeline; operator recovers
those IDs from Grafana's `migration_r2_hls` events (`blob9`)
or the Vimeo dashboard.

**3a/C — `--from-stdin` bulk mode for `rollback-r2-hls`.**
Closes the loop: pipes NDJSON from `list-realtime-r2` (or any
NDJSON producer) into the rollback CLI, which runs the same
per-row pipeline (GET → PATCH-back-to-vimeo → DELETE-R2-prefix)
sequentially over each line. The single-row CLI shape is
preserved bit-for-bit — `--from-stdin` is mutually exclusive
with the positional dataset id and `--to-vimeo`. Hard failures
(`parse_failed`, `get_failed`, `wrong_scheme`, `patch_failed`,
`malformed_ref`) flip the exit code to 1 but don't abort the
loop; soft failure (`delete_failed` — PATCH succeeded but R2
DELETE threw) is reported separately as "ok (orphan R2 prefix)"
so the operator sees how much storage they need to clean up
later. Idiomatic invocation: `terraviz list-realtime-r2 |
terraviz rollback-r2-hls --from-stdin`.

**Tests.** 29 new across the three commits — 10 for 3a/A,
10 for 3a/B, 9 for 3a/C bulk-stdin (plus the 12 pre-existing
single-row rollback tests still pass against the refactor).
Full suite 2055/2055.

**Non-goals (deferred).** A recurring re-encode mechanism
(scheduled trigger → re-fetch → re-encode → idempotent overwrite)
that would let real-time rows live on R2 without staleness is a
much bigger lift — likely a Phase 3c follow-up. Until then the
correct answer for real-time rows is "stay on `vimeo:`".

---

## Phase 3 — R2 + HLS for 4K spherical video

**Branch:** `claude/r2-hls-migration-phase-3-x7Kpq`
**Commits:** 3/A through 3/H — eight logical changes.

Phase 2 attempted to migrate the legacy SOS Vimeo catalog to
Cloudflare Stream but hit the standard Stream plan's 1080p
rendition ceiling — unworkable for spherical content where
viewers zoom into features smaller than the equator. Phase 3
replaces that approach with a self-managed HLS pipeline on
Cloudflare R2:

1. **Operator-side FFmpeg** pre-encodes each source MP4 into a
   multi-rendition HLS bundle (4096x2048 + 2160x1080 + 1440x720
   at 2:1 spherical aspect, 6-second VOD segments).
2. **R2 upload** stores the bundle (master playlist + variant
   playlists + .ts segments) under `videos/<dataset_id>/` in
   the existing `terraviz-assets` bucket via the S3 API.
3. **R2 public-bucket + custom domain** serves the HLS files
   directly. No Worker needed for v1.
4. **Manifest endpoint extension** resolves video `r2:` data_refs
   to the HLS master playlist URL.
5. **`r2:videos/<dataset_id>/master.m3u8`** is the data_ref scheme.

Trade-offs vs. Phase 2's Stream approach:
- **More upfront work**: operator runs FFmpeg locally (hours, not
  minutes).
- **More storage**: ~30-50 GB R2 total (3 renditions × 140 min of
  content), but R2 storage is $0.015/GB/month → ~$0.50-0.75/month.
- **Zero egress cost**: R2 has no per-delivery charge regardless of
  viewer count. Stream's $5/mo flat is replaced by R2's
  pay-for-storage-only model that's cheaper at every catalog size.
- **True 4K renditions**: 4096x2048 spherical preserved.

| Commit | Summary |
|---|---|
| 3/A | `cli/lib/ffmpeg-hls.ts` — wraps the FFmpeg child process that produces a 3-rendition HLS bundle. `buildFfmpegArgs` is exported so tests can pin the exact command shape; `encodeHls` is the high-level API the migrate subcommand calls. Captures the last 4 KB of stderr for clear error attribution. |
| 3/B | `cli/lib/r2-upload.ts` — walks a local HLS bundle and uploads each file to R2 under a key prefix via the S3 API. SigV4 signing via `aws4fetch` (~2 KB, no transitive deps — much lighter than the full AWS SDK for what's effectively "PUT bytes with a signature"). Bounded parallelism (6 concurrent per bundle). Per-file Content-Type set correctly (`application/vnd.apple.mpegurl` for `.m3u8`, `video/mp2t` for `.ts`). Also exports `deleteR2Prefix` for the rollback path. |
| 3/C | `terraviz migrate-r2-hls` CLI subcommand. Orchestrates the per-row pipeline: resolve vimeo → encode HLS → upload to R2 → PATCH data_ref → emit telemetry → clean up workdir. Idempotent (rows already on `r2:` skipped at plan time). Includes `cli/lib/vimeo-source.ts` (slimmer than Phase 2's vimeo-fetch — just resolves the source URL since FFmpeg pulls it directly via `-i`) and `cli/lib/migration-telemetry.ts` (event-type-agnostic emitter with Phase 2/M's Origin-header fix carried forward). |
| 3/D | Manifest endpoint extension — `r2:<key>.m3u8` + video format returns a `kind: 'video'` manifest with `hls` set to the R2 public URL. The existing `r2:` + video path stays for non-`.m3u8` direct-MP4 refs (rare). Case-insensitive on the suffix. |
| 3/E | `migration_r2_hls` telemetry event. Tier A. Fields: `dataset_id`, `legacy_id`, `vimeo_id`, `r2_key`, `source_bytes`, `bundle_bytes`, `encode_duration_ms`, `upload_duration_ms`, `duration_ms`, `outcome`. Added to `KNOWN_EVENT_TYPES` in `functions/api/ingest.ts` so the events the migration CLI emits actually land in AE → Grafana. |
| 3/F | `terraviz rollback-r2-hls` subcommand + operator runbook + expected-bindings audit additions. Mirrors Phase 2's would-be rollback-stream: PATCH data_ref back to `vimeo:<id>` first (commit point), then delete the R2 prefix (cleanup; non-fatal). Runbook section in `CATALOG_BACKEND_DEVELOPMENT.md` covers Pages-side prereqs (custom domain, `R2_PUBLIC_BASE`, CORS), operator-side prereqs (FFmpeg + R2 S3 creds), pre-flight dry-run, live migration, failure modes, rollback, and the observation window. `R2_PUBLIC_BASE` + the R2 S3 credentials added to `expected-bindings.ts`. |
| 3/G | Grafana migration row on `Terraviz — Product Health`. Three panels at y=34: per-day runs by outcome, cumulative ok rows, failure breakdown. Pins `blob7 = outcome` based on `toDataPoint`'s alphabetical ordering of `MigrationR2HlsEvent`'s string fields (dataset_id, legacy_id, outcome, r2_key, vimeo_id at blob5..blob9). Dashboard version 6 → 7. |
| 3/H | This file. |

### Operator-visible changes

- **New CLI subcommands:**
  ```sh
  npm run terraviz -- migrate-r2-hls --dry-run             # plan + storage estimate
  npm run terraviz -- migrate-r2-hls --limit=5             # sanity batch
  npm run terraviz -- migrate-r2-hls                       # full run
  npm run terraviz -- rollback-r2-hls <id> --to-vimeo=<n>  # roll one row back
  ```
  Both require `R2_S3_ENDPOINT` + `R2_ACCESS_KEY_ID` +
  `R2_SECRET_ACCESS_KEY` in the operator's environment, plus
  `TERRAVIZ_ACCESS_*` for the publisher API.

- **New Pages env var (Production + Preview):** `R2_PUBLIC_BASE`
  set to your custom domain (e.g. `https://video.zyra-project.org`).
  Bind the domain in Cloudflare dashboard → R2 →
  `terraviz-assets` → Settings → Connect Domain. Configure a CORS
  policy on the bucket allowing GET from the SPA's origins.

- **Re-import the Grafana dashboard** (`grafana/dashboards/product-health.json`)
  to pick up version 7 with the migration row.

- **Operator prereq:** FFmpeg ≥ 6 on PATH (or pass `--ffmpeg-bin`).
  Apt: `apt-get install -y ffmpeg`. John Van Sickle static
  binaries work on any glibc Linux for slim base images.

### Phase 2 transition

Phase 2 shipped as a draft PR targeting Cloudflare Stream but
was abandoned after live testing revealed the standard Stream
plan caps rendition output at 1080p height — a UX regression
for spherical content under SPA zoom. The Phase 2 PR was
closed unmerged; this Phase 3 branch supersedes it, branching
fresh from `main` rather than off the Phase 2 work.

Some of the operator workflow patterns (custom domains for
asset serving, expected-bindings audit, runbook structure)
carry forward from Phase 2's design exploration. The actual
code surface is independent — Phase 2's `migrate-videos` and
`rollback-stream` subcommands never landed; Phase 3 ships
`migrate-r2-hls` + `rollback-r2-hls` as the production-going
shape.

### Storage cost calibration

136 rows × ~1 min average × ~244 MB/min for the 3-rendition
ladder ≈ ~33 GB total → ~$0.50/month flat at R2's $0.015/GB-month
rate. Egress is free. Compared to Phase 2's $5/mo Stream base
tier (which would have been needed regardless for 4K renditions
at an Enterprise tier), R2 is significantly cheaper at any
catalog size. Storage scales linearly with content duration;
egress doesn't scale with viewer count.

### No breaking changes

The manifest endpoint resolves all four schemes (`vimeo:`,
`url:`, `stream:`, `r2:`) — a row mid-migration plays through
whichever scheme its current `data_ref` references. The SPA's
HLS player handles both Vimeo-proxy HLS and R2-served HLS via
the same `hlsService.ts` code path. No frontend changes.

### Rollback

Per-row rollback via `terraviz rollback-r2-hls`:

```sh
npm run terraviz -- rollback-r2-hls <dataset_id> --to-vimeo=<original_id>
```

PATCHes data_ref back to `vimeo:` first (commit point), then
deletes the R2 bundle. If the DELETE fails the row is still
correctly back on `vimeo:`; orphan R2 prefix stays for manual
cleanup.

### Out of scope (deferred)

- **Server-side encoding pipeline.** Workers can't run FFmpeg;
  Cloudflare's Media Transformations binding only downscales.
  Phase 3 stays operator-side. If catalog growth makes one-shot
  operator runs painful, a Phase 3b can add a transcoding
  service (AWS MediaConvert, GCP Transcoder, or a dedicated
  VM with FFmpeg).
- **Signed URLs / access control.** R2 public-bucket serves
  everything publicly. Fine for the SOS catalog (all public
  datasets). For future private content, swap in a Worker
  in front of R2.
- **Live streaming.** Phase 3 is VOD-only.
- **Image r2: migration.** Phase 1d's import lands images as
  `url:` data_refs pointing at external CDNs. Migrating those
  to R2 is a separate phase.
- **Auxiliary asset migration (thumbnails, legends, SRT captions).**
  Phase 3 touches only the video `data_ref`. The thumbnail /
  legend / caption fields on each catalog row still point at
  NOAA-hosted URLs. Migrating those to
  `datasets/{id}/{thumbnail,legend,caption}.*` in the same R2
  bucket is a Phase 3b-shaped follow-up — needed before
  `/publish` can serve every dataset from a single origin and
  before federation peers can mirror without reaching back to
  noaa.gov. Shape sketched in
  [`docs/CATALOG_ASSETS_PIPELINE.md`](docs/CATALOG_ASSETS_PIPELINE.md)
  §"Legacy auxiliary-asset migration".
- **Vimeo proxy retirement.** Stays running until the migration
  is 100% complete AND has been observed for ≥1 month.
- **4K renditions of already-migrated rows.** The rendition
  decision is at encode time. Re-encoding a row requires
  `rollback-r2-hls` + re-running `migrate-r2-hls`.

---

## Phase 1f — Cutover stabilisation (PR #62)

**Released:** May 2026
**Branch:** `claude/cutover-stabilization-phase-1f-EwThP`
**Commits:** 1f/A through 1f/O — fifteen logical changes
(eight planned + seven follow-ons across review feedback and a
live-reported regression).

The Phase 1d cutover landed safely but the live deploy surfaced
operator-experience and cost-observability friction the plan didn't
predict. Phase 1f closes those gaps. Three Copilot review rounds
on top of the original plan caught a verify-deploy contract bug
that would have shipped broken (1f/M) and a JPEG renderer
mismatch that silently dropped ~30 datasets from the browse list
(1f/K, operator-reported, confirmed fixed live).

| Commit | Summary |
|---|---|
| 1f/A | Error-envelope audit across `functions/api/v1/publish/**`. Same `{error, message}` vs `{errors: [...]}` discipline 1d/O introduced for the reindex route, applied to publish.ts and retract.ts (404-race parity). |
| 1f/B | `scripts/check-pages-bindings.ts` — automated audit of the Pages project's bindings against an expected manifest. Catches the per-environment Production / Preview toggle gotcha 1d/AB documented but didn't enforce. |
| 1f/C | Per-session pre-search LRU cache wrapping `executeSearchDatasets`. 16-entry LRU, 5-minute TTL, query canonicalisation. Cuts Workers AI neuron burn for repeated queries within a session. |
| 1f/D | Workers AI 4006 quota guard rail. Server-side detection in `/api/chat/completions` and `/api/v1/search`; client-side session-scoped degraded state; "Reduced functionality" badge in the chat panel; transparent fallback through the local engine. |
| 1f/E | `grafana/dashboards/orbit-cost.json` — Grafana panels consuming 1d/Y's `turn_rounds` telemetry. Distribution, total LLM rounds, p95 duration split, top hashed query terms. |
| 1f/F | `terraviz verify-deploy` CLI subcommand. Per-check pass/fail/skip table for the post-deploy smoke-test from CATALOG_BACKEND_DEVELOPMENT.md. |
| 1f/G | `docs/SELF_HOSTING.md` Phase 8 walkthrough refresh. Catalog-stack bindings, Workers Paid recommendation, snapshot import, post-deploy verification. |
| 1f/H | This file. |
| 1f/I | Round-1 Copilot fixes: cache-key correctness, listener cleanup, badge wording, helper API tightening, doc drift. |
| 1f/J | Round-2 Copilot fixes: never cache degraded responses, cross-platform entrypoint detection, follow-on wording-drift sweeps. |
| 1f/K | **Regression fix.** Operator-reported: ~30 JPEG datasets (incl. "Age of the Seafloor") silently filtered from the browse list because the SPA's `isImageDataset` didn't recognise the publisher API's canonical `image/jpeg`. Confirmed fixed live by the operator. |
| 1f/L | Catalog-source `normaliseSourceFormat` collapses legacy SOS JPEG typos to canonical `image/jpeg`; `image/webp` added to `isImageDataset` to match the validator's `FORMAT_VALUES` surface. |
| 1f/M | Round-3 Copilot fixes: `verify-deploy` was built against an imagined `/api/v1/search` contract (used `hits`, expected 503 for degraded). Real route returns `datasets` and signals degraded via 200+`body.degraded`+`Warning` header. Tests + check + doc all corrected. |
| 1f/N | Round-4 Copilot fixes: drop "Capacity temporarily exceeded" pattern from the quota classifier (load-shedding ≠ quota); emit `wrong_type` from `diffBindings` so binding-name+wrong-bucket collisions surface as one row instead of two; add chat UI tests for the degraded badge (initial render, live updates, double-init guard). |
| 1f/O | Round-5 Copilot fixes: `wrong_type` now fails `check-pages-bindings` (was exit 0); search-side degraded short-circuits the LLM round and routes to the local engine instead of letting the chat call burn a second quota check on an ungrounded prompt; this changelog entry brought up to date. |

### Operator-visible changes

- **Quota guard rail:** When Workers AI returns 4006 / quota
  exhausted, the chat panel shows a "Reduced functionality —
  Workers AI quota reached" badge and the docent transparently
  routes through the local-engine fallback. Self-heals on the
  next successful LLM call. Reactive only — preemptive
  detection is parked until 1f/E's cost panel produces real
  per-turn data to calibrate against.
- **New operator commands:**
  - `npm run check:pages-bindings` — diff Pages bindings against
    the expected manifest (requires `CLOUDFLARE_API_TOKEN` +
    `CLOUDFLARE_ACCOUNT_ID`; project name defaults to `terraviz`,
    override via `CLOUDFLARE_PAGES_PROJECT_NAME`).
  - `npm run terraviz -- verify-deploy [--skip-publish-checks]`
    — post-deploy smoke-test against the configured server.
- **New Grafana dashboard:** `Terraviz — Orbit Cost`
  (uid `terraviz-orbit-cost`). Import from
  `grafana/dashboards/orbit-cost.json`.

### No breaking changes

Every API envelope shift is additive (`degraded: 'quota_exhausted'`
joins `'unconfigured'` rather than replacing it; the publish/retract
route shape changes only in the race-only 404 path that already
returns 404 just with a different envelope shape).

### Rollback recipes

- **Pre-search cache too aggressive:** revert 1f/C; the cache
  is purely client-side, no server impact.
- **Quota guard rail false-positive:** revert 1f/D's
  `functions/api/_lib/workers-ai-error.ts` patterns or the
  call sites in `chat/completions.ts` / `search-datasets.ts`.
  The badge UI in `chatUI.ts` is harmless if the state never
  flips.
- **Verify-deploy false-fail:** the command runs read-only HTTP
  probes — no rollback needed; reproduce locally with the same
  `--server` flag and add a stub case in `cli/lib/verify-checks.ts`.
- **JPEG renderer (1f/K, 1f/L):** revert the `image/jpeg` /
  `image/webp` additions to `DatasetFormat` and `isImageDataset`
  to fall back to the legacy typo'd MIME set. Will re-introduce
  the silent-drop bug; only useful if a different fork's
  catalog source has been hand-canonicalised to those legacy
  values.
- **Search-degraded short-circuit (1f/O):** revert the
  `if (needsPreSearch && preSearchResult.degraded)` block in
  `processMessage`. The badge still flips correctly via the
  state-update path; the chat call resumes burning quota on
  ungrounded prompts.

---

## Phase 1d — SOS bulk import + docent cutover (PR #60)

**Merged:** April 2026
**Branch:** `claude/docent-cutover-phase-1d-MmIqm`
**Commits:** 1d/A through 1d/AD — 30 logical changes.

The cutover phase: flipped the docent's primary discovery surface
from the legacy in-memory keyword scan to the Vectorize-backed
`search_datasets` tool, imported the SOS catalog into the new
publisher pipeline, and shipped the operator deploy walkthrough.

### Highlights

- **SOS bulk importer** (1d/A, 1d/B, 1d/C): `terraviz
  import-snapshot` walks the upstream SOS catalog snapshot,
  shapes rows for the publisher API, and uploads them with
  `legacy_id` idempotency.
- **Docent cutover** (1d/E, 1d/F, 1d/G): tool ordering flipped
  to `search_datasets` first; frontend default
  `VITE_CATALOG_SOURCE=node`.
- **`--reindex` flag** (1d/D): bulk re-embed for operators
  wiring Vectorize after publishing rows, and for future
  model-version bumps.
- **Vectorize-backed pre-search injection** (1d/AC): restored the
  `[RELEVANT DATASETS]` block in the user message, this time
  sourced from `search_datasets` instead of in-memory keyword
  scan. Closes the chip-render reliability regression that 1d/F
  introduced on mid-tier LLMs.
- **Production deployment checklist** (1d/AB): step-by-step
  walkthrough in `CATALOG_BACKEND_DEVELOPMENT.md` covering
  bindings, Access setup, snapshot import, smoke tests.
- **Tour engine legacy_id support** (1d/T, 1d/U, 1d/Z):
  case-insensitive `INTERNAL_*` matching with `legacyId`
  fallback so existing tour JSON keeps working post-cutover.
- **`turn_rounds` telemetry** (1d/Y): plumbed through to the
  `orbit_turn` analytics event; consumed by Phase 1f/E's
  Grafana panels.

### Breaking changes

- The default catalog source flipped from `legacy` to `node`. A
  fork that wants the old behaviour must set
  `VITE_CATALOG_SOURCE=legacy` explicitly.

### Rollback recipe

Set `VITE_CATALOG_SOURCE=legacy` and redeploy. The legacy
`search_catalog` tool stays in the docent's tool list as the
fallback — a deploy without Vectorize wired works without
intervention. Full rollback recipe in
`CATALOG_BACKEND_DEVELOPMENT.md` "Cutover rollback recipe".

---

## Phase 1c — Vectorize semantic search (PR #59)

**Merged:** March 2026
**Branch:** `claude/docent-search-phase-1c-QSBRE`
**Commits:** 1c/A through 1c/P.

Plumbed the embed pipeline end-to-end: Workers AI generates
768-dim vectors from canonical dataset text, Vectorize stores them
under metadata-indexed keys (peer_id / category / visibility), and
the new `/api/v1/search?q=` endpoint hydrates hits back through
D1. The docent gained a `search_datasets` LLM tool that calls the
public endpoint and shapes the result for the LLM.

### Highlights

- **Vectorize integration** (1c/A): `vectorize-store.ts` helpers
  + an in-memory mock for local dev.
- **Embeddings** (1c/B, 1c/C): canonical dataset text + Workers
  AI call + the embed-dataset-job pipeline, queued from
  publish/update/retract.
- **Search route** (1c/E): `GET /api/v1/search?q=` with KV
  snapshot caching; degrades to `{datasets: [], degraded:
  'unconfigured'}` when AI/Vectorize aren't wired.
- **Featured-list endpoint + tool** (1c/F): operator-curated
  cold-start list for "what should I look at?" prompts.
- **Frontend docent refactor** (1c/G): the system prompt is
  static again; the tool list (search_datasets,
  list_featured_datasets, search_catalog) is the single
  source of grounded IDs.
- **Cutover deferred** (1c/L): `search_catalog` stayed primary
  in this phase to avoid a mid-deploy regression on
  unwired-Vectorize forks; Phase 1d landed the actual flip.

### Mock-mode parity

`MOCK_VECTORIZE=true` + `MOCK_AI=true` in `.dev.vars` (defaults
in `.dev.vars.example`) makes the entire pipeline work offline.
Cosine similarity in the mock is feature-hashed against the
vocabulary, so multi-step "publish three datasets, search for
the closest" walks behave like real embeddings at a coarse level.

---

## Phase 1b — Asset upload pipeline (PR #58)

**Merged:** February 2026
**Branch:** `claude/catalog-backend-phase-1b-97irR`
**Commits:** 1b/A through 1b/P.

Direct upload pipeline for dataset assets — Stream for video,
R2 for images / legends / captions / tour JSON. Two-phase flow
(`POST .../asset` mints a presigned URL, `POST .../asset/{id}/complete`
verifies the digest and flips the row's `*_ref` column).

### Highlights

- **R2 + Stream bindings** (1b/A, 1b/B): helpers + tests for the
  S3-compatible presigned PUT path and the Stream direct-upload
  flow.
- **Asset init / complete endpoints** (1b/C, 1b/D): publisher
  API gains `POST .../asset` (mints upload URL) and `POST
  .../asset/{upload_id}/complete` (verifies digest, flips row).
- **Sphere-thumbnail pipeline** (1b/E): operator-side image
  resize via Cloudflare Images URL transformations.
- **Featured-datasets endpoints** (1b/F): operator curation
  surface for the cold-start list (consumed by 1c/F's tool).
- **CLI `upload` command** (1b/G): `terraviz upload <id> <kind>
  <path>`, polls Stream transcode for `data` kind videos
  before completing.
- **Manifest endpoint resolves `r2:` and `stream:` refs** (1b/N):
  the public manifest API hands the SPA a real playback URL
  even for newly-uploaded rows.

### Mock mode

`MOCK_R2=true` + `MOCK_STREAM=true` (defaults in
`.dev.vars.example`) returns deterministic stub URLs; the
`/complete` route trusts the publisher's claimed digest as
ground truth. Refused on non-loopback hostnames so a production
misconfig can't accept forged claims.

---

## Phase 1a — Catalog backend foundation (PR #57)

**Merged:** January 2026
**Branch:** `claude/catalog-backend-phase-1a-TUYq3`
**Commits:** 1a/A through 1a/I.

The bones of the catalog backend: D1 schema, the public read
API, the Cloudflare Access middleware, the publisher API metadata
endpoints, the well-known doc, the CLI skeleton, and the frontend
catalog-source switch.

### Highlights

- **D1 migrations + seed pipeline** (1a/A): catalog schema lives
  under `migrations/catalog/` with a separate `CATALOG_DB`
  binding so it can be applied independently of the existing
  feedback DB.
- **Catalog read API + KV cache** (1a/B): `GET /api/v1/catalog`
  with a hot-path snapshot keyed by ETag; invalidated on every
  publish/retract.
- **Manifest endpoint** (1a/C): `GET /api/v1/manifest/{id}`
  resolves `vimeo:` and `url:` data_refs into HLS playback URLs.
- **`gen:node-key` script + well-known doc** (1a/D): every node
  has an Ed25519 keypair signed with `npm run gen:node-key`;
  advertised via `/.well-known/terraviz.json` for the federation
  story (Phase 4).
- **Cloudflare Access middleware** (1a/E): JIT-provisions a
  publisher row keyed off the Access JWT's email; `DEV_BYPASS_ACCESS=true`
  is the localhost-only escape hatch.
- **Publisher API metadata** (1a/F): list / get / create /
  update / publish / retract / preview endpoints over D1.
- **`terraviz` CLI skeleton** (1a/G): subcommands for me, list,
  get, publish, update, retract, preview, with `Cf-Access-Client-Id`
  / `-Secret` headers for service-token auth.
- **`VITE_CATALOG_SOURCE`** (1a/H): build-time switch flipping
  the SPA between the legacy SOS S3 fetch and the new node-API
  read. Default stayed `legacy` for 1a/1b/1c; flipped to `node`
  in 1d/G.
- **Onboarding** (1a/I): `.dev.vars.example`, devcontainer fixes,
  README polish.

### Out of scope (deferred to later phases)

- Asset uploads (R2 / Stream) — Phase 1b.
- Vectorize semantic search — Phase 1c.
- SOS bulk import + cutover — Phase 1d.
- Cost observability + quota guard rail — Phase 1f.
- Legacy retirement (`search_catalog` tool, `VITE_CATALOG_SOURCE=legacy`,
  SOS S3 fetch path) — Phase 1e, observation-gated.

---

## Earlier phases

Pre-catalog history is documented in PR descriptions and the
design docs under `docs/`. See in particular:

- [`docs/ANALYTICS.md`](docs/ANALYTICS.md) — telemetry pipeline
  (PR #51, #54).
- [`docs/VR_INVESTIGATION_PLAN.md`](docs/VR_INVESTIGATION_PLAN.md)
  — WebXR mode.
- [`docs/TOURS_IMPLEMENTATION_PLAN.md`](docs/TOURS_IMPLEMENTATION_PLAN.md)
  — SOS tour playback.
- The merged PR list in `git log --grep="Merge pull request"`.
