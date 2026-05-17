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

## Phase 3 implementation conventions

A short collection of decisions that apply across every page of
the portal and are easiest to settle before the first piece of UI
code lands. Each item closes a gap the per-feature sections below
would otherwise leave implicit; each is inherited by every Phase 3
sub-phase (see [`CATALOG_BACKEND_PLAN.md`](CATALOG_BACKEND_PLAN.md)
§"Phase 3 — Publisher portal (staff)" → "Sub-phase execution
plan").

Phase 3 sub-phases are tagged `3pa`–`3pg` in commit prefixes,
CHANGELOG entries, and the table referenced above. The
`p`-qualified letters keep the portal work distinct from the
unrelated R2 + HLS video-pipeline sub-phases that already claimed
the bare `3a`–`3h` slots in `git log`. Prep work that ships
before the first sub-phase uses `3-pre/<letter>`. See the
backend-plan section for the full explanation.

### Lazy-load shape

The portal mounts at `/publish` and loads via a single dynamic
`import('./ui/publisher')` from `src/main.ts`, gated on
`location.pathname.startsWith('/publish')`. This mirrors the
lazy-import pattern `src/ui/vrButton.ts` uses to keep Three.js out
of the main bundle: non-publisher visits never fetch the portal
chunk, and the portal chunk lands as a single Vite-named entry
(`assets/publisher-[hash].js`) for easy identification in
`vite build --report` output.

Routing inside the portal uses the History API directly — no
framework. The handful of pages (`/publish/me`,
`/publish/datasets`, `/publish/datasets/{id}`, `/publish/tours`,
`/publish/import`) is small enough that a ~50-line router built
on `history.pushState` + `popstate` is cheaper than pulling in a
router library, and matches the "vanilla TS with a few focused
libraries" stance documented in `CLAUDE.md` §"Codebase Overview".

### i18n discipline

Every user-facing string in `src/ui/publisher/**` flows through
`t()` in [`../src/i18n/index.ts`](../src/i18n/index.ts) — the same
hard rule the rest of the UI follows (see `CLAUDE.md`
§"Localization"). Phase 3 will add ~100–150 new keys to
`locales/en.json` under a `publisher.*` namespace. Keys that need
translator context — interpolated field names in validation error
messages, ARIA labels, the `<<LOAD:DATASET_ID>>`-equivalent
marker syntax in tour previews — get a one-line entry in
`locales/_explanations.json` in the same commit.

`npm run check:i18n-strings` already covers `src/ui/`; the new
publisher tree is picked up automatically. Translators see new
keys through the existing Weblate workflow without any pipeline
changes.

### Markdown sanitization

The abstract field accepts markdown but the rendered HTML reaches
two surfaces — the portal preview and (eventually) the public
dataset detail page — both of which are XSS-sensitive. Phase 3pc/A
ships a single shared renderer in
`src/services/markdownRenderer.ts`:

1. Parse with `marked` (already a runtime dep — used today by
   `scripts/build-privacy-page.ts` for the privacy-page build,
   pulled into the SPA's lazy publisher chunk for this purpose).
   The existing `renderMarkdownLite` in `src/ui/chatUI.ts` stays
   as the chat-message renderer — it's deliberately scoped to
   **bold**, lists, and links, which is insufficient for dataset
   abstracts.
2. Sanitize the result with `sanitizeMarkdownHtml` from
   `src/ui/sanitizeHtml.ts` (the same in-house sanitizer the
   help-guide uses, with a `MARKDOWN_TAGS` allowlist that's a
   strict superset of the guide's: adds `h2`, `blockquote`,
   `pre`, `hr` alongside the existing inline tags).
   Reverse-tabnabbing defense (`target="_blank"` anchors get
   `rel="noopener noreferrer"` injected) already lives in the
   walker. No new runtime dep — DOMPurify was considered but
   `sanitizeHtml.ts` already implements the allowlist-based
   pattern we need.
3. Both the live preview in the portal and the eventual public
   detail page call `renderMarkdown(source)` from the same
   module, so the publisher's preview is byte-for-byte what users
   will see.

`marked` is imported by the publisher chunk (lazy-loaded for
non-publisher visits) and by the build-time privacy-page script;
no other runtime additions. The threat-model section "XSS via
publisher markdown" in
[`CATALOG_BACKEND_PLAN.md`](CATALOG_BACKEND_PLAN.md) is the
substrate; this section pins the implementation.

### Portal analytics

The portal emits the same shape of events the rest of the SPA
emits (see [`ANALYTICS.md`](ANALYTICS.md) and
[`ANALYTICS_CONTRIBUTING.md`](ANALYTICS_CONTRIBUTING.md)). Phase 3
adds the following event types to `TelemetryEvent` in
[`../src/types/index.ts`](../src/types/index.ts):

| Event | Tier | Fields | Notes |
|---|---|---|---|
| `publisher_portal_loaded` | A | `route` (`me` \| `datasets` \| `tours` \| `import`) | One per portal-chunk load. |
| `publisher_action` | A | `action` (`draft_saved` \| `published` \| `retracted` \| `preview_minted` \| `asset_uploaded` \| `bulk_imported`), `dataset_id` (hashed via `src/analytics/hash.ts`) | Server-side `audit_events` rows are the source of truth for *who* did *what*; this Tier-A event powers the operator dashboard without persisting publisher identity client-side. |
| `publisher_validation_failed` | B | `field`, `code` | Research-tier so we can size which validators trip publishers most without storing the offending free-text values. |
| `publisher_dwell` | B | `surface` (form section name), `duration_ms` | Existing multi-handle tracker in `src/analytics/dwell.ts`; standard ≤30/min throttle. |

`TIER_B_EVENT_TYPES` in `src/types/index.ts` gains the two
research-tier entries; no other change to the tier gate. Server-
side stamping in `functions/api/ingest.ts` lists the new event
types in `KNOWN_EVENT_TYPES`. Grafana gains a "Publisher activity"
row on the existing `Terraviz — Product Health` dashboard in 3pa.

### Cloudflare Access — browser policy

Phase 1a wired Access to protect `/api/v1/publish/**` for the
service-token / API flow. Phase 3pa extends the same Access
application to cover the browser flow at `/publish/**` so the
portal HTML and chunk respect the same auth boundary as the API.
The policy is dashboard-managed (see
[`CATALOG_BACKEND_PLAN.md`](CATALOG_BACKEND_PLAN.md) §"Constraints
found during exploration" constraint 3); operator steps land in
[`SELF_HOSTING.md`](SELF_HOSTING.md) during 3pa.

Local dev continues to use `DEV_BYPASS_ACCESS=true` for the API;
the portal reads the same bypass for the browser side so a
publisher can iterate against `wrangler pages dev` without an
Access session.

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
(see "Authoring CLI" below).

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
shape is consumed by the authoring CLI (see below).

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

A reusable component used by both the dataset and tour forms.
**Cloudflare Stream is no longer in the picture** — Phase 3 cut over
to a pure R2 + GitHub Actions pipeline; the full design lives in
[`CATALOG_ASSETS_PIPELINE.md`](CATALOG_ASSETS_PIPELINE.md) §"Video
pipeline (R2 + GitHub Actions — current)".

> **Future work — image-sequence input.** A planned sub-phase
> (3pe) extends this uploader to accept a stack of individual
> frames (PNG / JPEG / WebP) as the source for a video dataset,
> for the many cases where publishers have numbered frames on
> disk but no MP4. Design in
> [`CATALOG_IMAGE_SEQUENCE_PLAN.md`](CATALOG_IMAGE_SEQUENCE_PLAN.md);
> tracking issue
> [zyra-project/terraviz#114](https://github.com/zyra-project/terraviz/issues/114).

Behavior:

- Click-to-browse file input (no drag-drop wire-up shipped —
  the input is a standard `<input type="file">`; adding HTML5
  drag-drop listeners is a small follow-up tracked separately).
- Detects MIME type and picks the right target — **everything goes
  to R2**; the only thing the kind decides is what happens *after*
  the PUT.
- Shows progress (XHR upload events feed a `<progress>`) and emits
  a completion event with the final `data_ref`. Surfaces stage-
  specific errors (mint / upload / finalize) through an inline
  status line + a `<details>` disclosure for the raw API code;
  the publisher can retry by re-picking the file (no automatic
  retry loop today — that's a follow-up).
- **Image** (`image/png` / `image/jpeg` / `image/webp`): the
  presigned PUT lands the image at
  `r2:datasets/{id}/by-digest/sha256/{hex}/asset.{ext}`
  (content-addressed within the dataset's prefix — the digest
  in the path is the same value `content_digest` carries on
  the dataset row, so re-uploading byte-identical bytes to
  the same dataset lands the same R2 object instead of a
  duplicate. Cross-dataset dedup is NOT what this layout
  does — the dataset id is part of the key, so different
  datasets carry independent copies of identical bytes).
  The finalize step writes `data_ref` directly — no transcode.
  (A client-side downsample preview before upload — so the
  publisher sees roughly what the 2048-wide variant will look
  like — was an early sketch but isn't in the shipped uploader;
  candidate follow-up if publishers ask for it.)
- **Video** (`video/mp4`): the presigned PUT lands the MP4 at
  `r2:uploads/{id}/{upload_id}/source.mp4` (per-upload prefix
  so a re-upload to a still-transcoding row doesn't overwrite
  the source bytes the prior workflow may still be reading).
  The finalize step fires a
  GitHub `repository_dispatch` and stamps the row
  `transcoding=true`. The form returns control to the publisher
  immediately; the detail page polls every 5 s until `transcoding`
  flips back to false and `data_ref` resolves to
  `r2:videos/{id}/{upload_id}/master.m3u8` (versioned per upload
  so a re-upload to a published row doesn't overwrite the
  bundle the public manifest is still serving). Whole loop is
  1–10 minutes depending on source length.

### Sub-phase 3pd breakdown

Same `3p<letter>` convention 3pa–3pc used. Each sub-commit ships
something demoable on its own.

| Sub-phase | Demoable result | Notes |
|---|---|---|
| **3pd/A** — Presigned PUT + finalize endpoints | `POST /api/v1/publish/datasets/{id}/asset` (mint presigned URL) and `POST /api/v1/publish/datasets/{id}/asset/{upload_id}/complete` (verify + dispatch). The complete handler also stamps `transcoding=1` on the row and fires the GitHub `repository_dispatch`. A separate `POST /api/v1/publish/datasets/{id}/transcode-complete` route is what the GHA workflow calls back to clear `transcoding` and set `data_ref` to the new HLS bundle. Migration 0011 adds the `transcoding` boolean; migration 0012 adds `active_transcode_upload_id` to bind a transcoding row to the specific upload that started it (the overlap-rejection guard and the stale-callback guard both key off this column). No portal UI yet. | Worker side complete; tested via `curl` + a manual repository_dispatch. |
| **3pd/B** — GHA workflow | `.github/workflows/transcode-hls.yml` listens on `repository_dispatch: types: [transcode-hls]`, runs the existing `cli/lib/ffmpeg-hls.ts` + `cli/lib/r2-upload.ts` via `cli/transcode-from-dispatch.ts`, then POSTs `/transcode-complete` on the publisher API with the workflow's Access service-token headers. | Reuses the proven Phase 3 transcoder code path. New GHA repo secrets: `R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `TERRAVIZ_SERVER`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`. New Pages bindings: `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_DISPATCH_TOKEN`. |
| **3pd/C** — Portal uploader | Click-to-browse file picker in the dataset form, mounted alongside the 3pc/F-fix2 manual `data_ref` input. XHR upload-progress events drive an inline `<progress>` bar; stage-specific errors (mint / upload / finalize) surface in a status line + a `<details>` disclosure. Failed uploads keep the file picker enabled so the publisher can retry by re-picking the file. No transparent retry — every failure surfaces in the status line and the publisher has to re-pick the file to retry. | The manual ref input stays so legacy `vimeo:` / `url:` references can still be set without re-uploading bytes. Same FormState slot, two parallel input surfaces. |
| **3pd/D** — Transcoding status | Static "Transcoding…" badge on the detail page when `transcoding=true`. Detail-page polling every 5 s, stops when `transcoding=false`. (Elapsed-time display is a candidate follow-up, not currently shipped.) | Stops automatically when the row reaches a terminal state. Reuses the existing detail-page render loop. |
| **3pd/E** — Preview button | "Preview" button on the detail page mints a token via `POST .../preview`. The modal surfaces the backend's anonymous-read URL (`/api/v1/datasets/{id}/preview/{token}`), which returns the dataset's metadata as JSON (`{ dataset: row }`). Useful as a primitive for a reviewer who can fetch metadata directly; the SPA-side `/?preview=...` consumer that renders the globe with full playback context is a Phase 3pe deliverable. | Closes the read → upload → preview → publish loop for the publisher portal. |
| **3pd/F** — CHANGELOG + SELF_HOSTING walkthrough | Operator-facing summary of the new bindings, the GHA secrets, and the migration order. | Same pattern 3pc/G followed. |

## Preview pipeline

Drafts are unlisted but loadable by id with a short-lived signed
token issued by `POST /api/v1/publish/datasets/{id}/preview`. The
token allows exactly one dataset (or one tour) and expires in 30
minutes. The frontend reads it from a `?preview=...` query param,
calls `/api/v1/publish/datasets/{id}` (rather than the public route)
to fetch the draft, and renders normally.

## Authoring CLI

The publisher API has two clients: the portal (described in the
sections above) and a command-line tool (`terraviz`) that talks
to the same endpoints. Both go through the same validation, the
same audit log, and the same identity and authorization model.
The CLI exists because a meaningful class of publishers — partner
research orgs running scheduled visualization pipelines, CI jobs
that publish on data refresh, batch importers from other catalog
systems — never want to log into a UI.

The CLI ships in **Phase 1a** with metadata-only commands and
gains asset-upload commands in **Phase 1b**, matching the API
surface available at each milestone (see Phasing in
[`CATALOG_BACKEND_PLAN.md`](CATALOG_BACKEND_PLAN.md)).

### Command surface

```
terraviz publish dataset.yaml          # create or update from a file
terraviz publish ./datasets/           # bulk publish from a directory
terraviz update <id> --field=value     # patch specific fields
terraviz retract <id> [--reason="..."] # retract a published dataset
terraviz list [--status=draft|published|retracted]
terraviz get <id> [--format=yaml|json]
terraviz preview <id>                  # mint a preview token + open URL

terraviz --version                     # CLI version + protocol version it speaks
terraviz --node=<base_url> ...         # override the default node target
```

The `--node` flag lets a single CLI talk to multiple deployments
without reconfiguring; the default node is read from
`~/.config/terraviz/config.toml`. Service-token credentials come
from the `TERRAVIZ_SERVICE_TOKEN` env var (preferred for CI) or
the same config file (for interactive use).

### YAML / JSON input shape

Either format works; YAML is the recommended default because
comments survive review. The shape mirrors the dataset entry form
one-to-one:

```yaml
# dataset.yaml — produced by a Zyra pipeline
slug:        sst-anomaly-2026-04
title:       Sea Surface Temperature Anomaly — April 2026
abstract: |
  Monthly mean sea-surface temperature anomaly relative to the
  1991-2020 climatology. Generated by Zyra workflow
  `sst-anomaly-monthly`.
organization: NOAA/PMEL
format:      video/mp4
visibility:  public

asset:
  # Local file (uploads to R2 + triggers the HLS transcode)…
  file:       ./renders/sst-anomaly-2026-04.mp4
  # …or an existing data_ref the catalog should point at
  # (per-upload path: r2:videos/{dataset_id}/{upload_id}/master.m3u8):
  # ref:      r2:videos/01HX.../01YH.../master.m3u8

categories:  [Ocean, Climate]
keywords:    [sst, anomaly, monthly]
time_range:
  start:     2026-04-01
  end:       2026-04-30
period:      P1M

license:
  spdx:      CC0-1.0
  rights_holder: U.S. Government

developers:
  - name:    Jane Doe
    role:    data
    affiliation_url: https://www.pmel.noaa.gov
  - name:    Pipeline (sst-anomaly-monthly)
    role:    visualization
    affiliation_url: https://github.com/zyra-project/...
```

Running `terraviz publish dataset.yaml` produces exactly the same
row a publisher would create through the portal. Repeated
invocations with the same `slug` are idempotent: if no fields
changed, nothing happens; if fields changed, a single `update`
is issued; an explicit `terraviz retract <slug>` takes the
dataset down. The "publish on schedule from a Zyra pipeline"
pattern is a `cron` + `terraviz publish dataset.yaml` away.

### Authentication

The CLI authenticates via Cloudflare Access **service tokens**
(machine credentials, distinct from interactive Access cookies):

1. Operator creates a service token in the Cloudflare Access
   dashboard, scoped to the same `/api/v1/publish/**` policy
   the portal uses.
2. The token's `Client-ID` and `Client-Secret` are stored either
   in the CLI config file (interactive use) or in a secret
   manager (CI / scheduled-job use).
3. Each request carries `CF-Access-Client-Id` and
   `CF-Access-Client-Secret` headers; Access verifies them, the
   publisher API receives a JWT it reads to identify the
   publisher (JIT-provisioned on first call as described in
   "Publisher identity & roles" below).

Service tokens have explicit expiry; the CLI checks expiry
before each call and surfaces a clear error if the token is
within seven days of expiring. Rotation is the operator's
responsibility, mirroring how Cloudflare's other service-token
flows work.

### Asset uploads (Phase 1b)

When a dataset YAML references a local file via `asset.file`, the
CLI does the upload itself:

1. Hash the local file with SHA-256 — the digest the publisher
   API will verify against (see "Asset integrity & verification"
   in
   [`CATALOG_ASSETS_PIPELINE.md`](CATALOG_ASSETS_PIPELINE.md)).
2. Request an upload URL from `POST .../{id}/asset` (Stream
   direct-upload URL for video, R2 presigned PUT for image).
3. Stream the file upload, with a progress bar.
4. For video, poll the transcode-status endpoint until the asset
   is playable (typically 1-3 minutes for a 5-minute 1080p clip).
5. Send `POST .../{id}/asset/complete` with the claimed digest.
6. The handler verifies the digest server-side; on mismatch the
   CLI prints a clear "your file changed during upload — please
   re-run" error.

Resumability: the CLI writes upload progress to
`~/.cache/terraviz/uploads/{id}.json`, so a re-invocation after a
network failure picks up where it left off rather than restarting
the upload.

### Error envelope and exit codes

The publisher API's 400 error body —
`{ errors: [{ field, code, message }] }` — is exactly what the
CLI surfaces back to the user. Field paths use dot notation
(`developers.0.affiliation_url`). Each error gets its own line
in the CLI output with the field highlighted.

| Exit code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic / unexpected error |
| 2 | Validation error (400) — per-field detail printed |
| 3 | Authentication / authorization error (401, 403) |
| 4 | Conflict (409 — content-digest mismatch, slug collision) |
| 5 | Asset-upload failure — resumable on rerun |
| 6 | Server error (5xx) — CLI suggests checking Workers Logs |

Scripts and CI runners can branch on the exit code without
parsing stdout. The CLI also accepts `--json` to emit
machine-readable output for everything (success, validation
errors, exit metadata).

### Distribution and versioning

The CLI ships as:

- A signed standalone binary per platform (Linux x64/arm64,
  macOS x64/arm64, Windows x64) attached to the GitHub Releases
  page for each catalog backend version.
- An npm package (`@zyra/terraviz-cli`) for Node-friendly CI
  environments.

The CLI version is independent of the deploying node version,
but the CLI checks the node's `/.well-known/terraviz.json` on
first call to confirm protocol-version compatibility (the same
matrix the federation contract test exercises). A CLI talking
to an incompatible node fails fast with a clear message rather
than producing surprising results.

### Code signing and verification

A CLI that publishes datasets on a schedule from an unattended
runner is a real attack surface — a substituted binary is
indistinguishable from the real one until it starts ex-filtrating
service tokens. The plan treats signing as required, not
optional.

#### Standalone binaries

Per-platform binaries built and signed in the project's GitHub
Actions release workflow:

- **macOS** — Apple Developer ID Application certificate. The
  signing identity (`Developer ID Application: Zyra Project`) is
  enrolled with Apple via the org's developer account; the
  certificate itself lives in 1Password and is exported into the
  CI runner's keychain at signing time as a base64 secret. After
  signing, the binary is **notarized** through `notarytool`
  against an Apple-issued app-specific password also stored as a
  CI secret. The released zip embeds the staple ticket so the
  binary launches without an internet round-trip on first run.
- **Windows** — Authenticode signing using a code-signing
  certificate (EV CSC preferred for SmartScreen reputation).
  Same custody model: cert in 1Password, exported into CI as a
  PFX-blob secret, applied via `signtool` with timestamping
  against DigiCert's TSA so signatures remain valid past
  certificate expiry.
- **Linux** — Detached **GPG** signature distributed alongside
  each binary (`terraviz-linux-x64.tar.gz` +
  `terraviz-linux-x64.tar.gz.asc`). The signing key is an
  Ed25519 GPG key pinned by long-form fingerprint in the project
  README and the well-known directory listing. No central CA
  involvement; users verify with `gpg --verify`.

#### npm package

The `@zyra/terraviz-cli` npm package is signed via npm's
**Sigstore-backed package signing** (`npm publish --provenance`),
which produces a transparency-log attestation tied to the
GitHub Actions workflow that built the package. Consumers
verify with `npm audit signatures` or by checking the
provenance attestation against the public Sigstore log. No
separate signing key custody — the trust root is the GitHub
Actions OIDC token and the public Sigstore TUF tree.

#### Key custody and rotation

- **macOS / Windows certificates** rotate on the issuer's
  schedule (typically annually). A 30-day overlap window where
  the new cert signs new releases while the old cert's
  notarisation / timestamps keep prior releases valid is the
  norm; users running an older binary don't break when the cert
  rotates.
- **Linux GPG key** rotates on a 3-year schedule. New keys are
  cross-signed by the previous key, and the project README
  pins both the current and previous fingerprint so a user
  upgrading from a 4-year-old binary still sees a continuous
  chain of trust.
- **All signing material** is stored in 1Password under the
  Zyra project vault with quarterly access audits. CI runners
  receive material as ephemeral secrets; nothing persists on
  the runner past the job's lifetime.

#### How a downstream user verifies

The release page hosts a `SHA256SUMS` file alongside each
artifact, signed by the same GPG key as the Linux binaries.
A scripted install (`curl | sh` style) fetches both, verifies
the signature on the sums file, then verifies each artifact
against its sum. The walkthrough lives in
`docs/SELF_HOSTING.md` so the same instructions cover both
"install the CLI for personal use" and "install the CLI on a
fleet of CI runners."

For self-hosters forking the project, the signing infrastructure
is documented but not transferred — a fork that wants signed
releases sets up its own certs, GPG key, and npm package
namespace. The plan's signing model is not opinionated about
who runs Zyra-derived deployments.

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
- **True WYSIWYG abstract editor.** 3pc/C1 ships a markdown
  textarea + GitHub-style syntax-insertion toolbar + Edit /
  Preview toggle (`src/ui/publisher/components/markdown-toolbar.ts`).
  That gets a non-technical publisher 80 % of the way without
  bringing in a heavyweight editor. If publisher feedback says
  the remaining 20 % is critical — i.e. publishers find the
  markdown syntax visible in the textarea actively confusing —
  the upgrade path is to mount Lexical (Meta's open-source
  editor, ~60-80 KB gzipped) with its markdown-serialization
  extension over the same textarea. The wire format stays
  markdown so the CLI YAML workflow and federation peers are
  unaffected; the editor is purely an in-portal authoring
  affordance. Pre-conditions before committing: (a) measured
  publisher feedback that the toolbar isn't enough, (b) a
  short bundle-size budget review against the lazy publisher
  chunk, (c) paste-handling and accessibility audit on the
  Lexical default extensions. Lives outside any specific phase
  — pick it up whenever the toolbar's ceiling is hit.

(The CLI for non-portal authoring is now a first-class Phase 1a
feature — see "Authoring CLI" earlier in this document, not a
deferred round-it-out item.)
