# Catalog Backend & Federation Plan

A first-class, Cloudflare-native backend for Terraviz: the catalog,
the asset store, the video pipeline, and a federation protocol that
lets independent Terraviz instances discover and subscribe to each
other while keeping data at home.

**Status: draft for review.** No code, no migrations, no bindings
have been added yet. This document exists to align on architecture
and phasing before anything ships.

---

## Goals

- Replace the two external dependencies that anchor the current data
  path — the public S3 metadata bucket and the Vimeo proxy — with a
  Cloudflare-native backend owned by the Terraviz instance.
- Make every Terraviz deployment a self-contained "node": its own
  catalog, its own assets, its own publishing surface, its own URL.
- Define a federation protocol so a node can subscribe to other nodes
  and present a merged catalog to its users without copying data.
- Keep data sovereign by default: an item published on node A is
  served from node A's storage; subscribers get metadata + a pointer,
  not a copy.
- Lay groundwork for per-dataset access control so a publisher can
  share specific items with specific peers (and revoke).
- Give publishers the tools they need to actually use the system:
  dataset entry forms, asset upload, a tour creator, a preview that
  shows their work on the globe before they hit publish.
- Design the data layer behind interfaces so a future deploy on AWS,
  GCP, or a self-managed stack is a swap, not a rewrite.

## Non-goals

- A general-purpose CMS. The publisher portal is scoped to the kinds
  of artefacts Terraviz renders: datasets, tours, dataset thumbnails,
  legends, captions, supporting media.
- A peer-to-peer mesh. Federation is HTTP pull from named, opt-in
  peers — no DHT, no gossip, no anonymous discovery.
- A new identity system. Auth piggybacks on Cloudflare Access for
  staff, and (Phase 3+) email-link or OIDC for community publishers.
  We will not run a password store.
- Cross-instance comments, ratings, or social features. Out of scope;
  re-evaluate after federation is real.
- Replacing GIBS tile delivery or the Workers AI Orbit proxy. Both
  already work and are out of scope for this plan.

---

## Constraints found during exploration

### 1. The current data path has two single points of failure

Today `dataService.ts` fetches the entire catalog from
`https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/dataset.json`
and `hlsService.ts` resolves video via
`https://video-proxy.zyra-project.org/video/{vimeoId}`. Either
endpoint going dark takes the whole app with it, and neither is
controlled by an instance operator. A self-hosted fork inherits the
same coupling unless it edits source.

### 2. The catalog shape is a known good starting point

The `Dataset` interface in `src/types/index.ts` and the merge logic
in `dataService.ts` (`abstractTxt` + `enriched.description`,
normalized-title join against `sos_dataset_metadata.json`) describe
roughly what a dataset *is*. The new backend should accept this
shape as v1 of the wire format with minimal changes — the migration
is "where it comes from," not "what it looks like." Schema evolution
goes through an explicit `schema_version` field.

### 3. Cloudflare Pages bindings are dashboard-managed

`wrangler.toml` is documentation in this project, not deployment
configuration — Pages reads bindings from the dashboard. Any new
binding (R2, Stream, Queues, Durable Objects) must be added to both
the file (for source-of-truth and future Workers migration) and the
Pages Settings → Bindings UI. The plan assumes this two-step in
every phase.

### 4. The desktop build cannot assume the backend is reachable

The Tauri app runs offline via `download_manager.rs` and an
IndexedDB-style cache. The new catalog API has to support a
"snapshot for offline" mode (signed, dated, content-addressed JSON
that the desktop app can pin) so existing offline behaviour keeps
working when datasets move from S3 to D1.

### 5. Federation is the hard part — design it first

Replacing Vimeo and S3 is mechanically straightforward. The
federation protocol is what makes this plan worth doing, and it
has to survive contact with: clock skew, half-revoked grants, peers
disappearing, schema drift between versions, abuse from a hostile
peer, and the desktop app pulling the catalog from an offline cache
six months stale. Sections "Federation model" and "Authorization"
go through these deliberately.

---

## Architecture overview

A Terraviz **node** is one Cloudflare Pages deployment plus the
storage and compute primitives bound to it. Every node has the same
shape; deployments differ only in which datasets and tours they own
and which peers they subscribe to.

```
                      ┌─────────────────────────────────────────┐
                      │            Terraviz node                │
                      │                                         │
   browser / Tauri ───▶│ Pages (static SPA + Functions /api/v1) │
                      │   │                                     │
                      │   ├── D1   (catalog: datasets, tours,   │
                      │   │         peers, grants, audit)       │
                      │   ├── R2   (assets: thumbs, legends,    │
                      │   │         tour json, image datasets)  │
                      │   ├── Stream (video originals + HLS)    │
                      │   ├── KV   (hot catalog snapshot,       │
                      │   │         federation cache, rate lim.)│
                      │   ├── Queues (transcode, federation     │
                      │   │           sync, audit dispatch)     │
                      │   ├── DO   (per-peer sync coordinator)  │
                      │   └── AE   (existing telemetry)         │
                      │                                         │
                      └────────┬────────────────────┬───────────┘
                               │ /.well-known/      │ signed
                               │ terraviz.json      │ playback URL
                               ▼                    ▼
                       peer Terraviz nodes       browser <video>
```

The frontend keeps its current shape — `dataService.ts` still
returns `Dataset[]`, `hlsService.ts` still consumes an HLS manifest
URL — but every external dependency is replaced by an endpoint on
the same origin.

### Cloudflare service mapping

| Concern | Service | Notes |
|---|---|---|
| Static SPA + API | **Pages + Pages Functions** | Same project we have today. New routes under `functions/api/v1/**`. |
| Catalog metadata | **D1** | Authoritative store. Same DB instance as `FEEDBACK_DB`, separate tables. |
| Object assets | **R2** | Thumbnails, legends, image-format datasets, captions, tour JSON, tour overlay media. Public bucket for `visibility=public` items, signed-URL bucket for the rest. |
| Video originals + HLS | **Cloudflare Stream** | Replaces Vimeo. HLS + DASH out of the box, signed playback tokens, per-video analytics, transcoding included. |
| Image optimization | **Cloudflare Images** | Optional. Serves the `_4096 / _2048 / _1024` progressive resolution pattern from one canonical upload. |
| Hot catalog cache | **KV** | Pre-rendered `/api/v1/catalog` snapshot keyed by ETag. Cuts D1 reads on the hot path; rebuilt on publish. |
| Federation peer cache | **KV** | Last-known-good catalog from each subscribed peer, TTL'd. |
| Background work | **Queues** | Transcode-status polling, federation pulls, large-import pipelines, webhook fan-out. |
| Per-peer state | **Durable Objects** | Single coordinator object per peer subscription — owns the sync cursor, retry timer, and circuit breaker so two Pages workers don't double-pull. Optional in Phase 4; can start with cron + KV. |
| Auth (admin) | **Cloudflare Access** | Already wired for `/api/feedback-admin`. Reused for the publisher portal initially. |
| Auth (federation) | **HMAC + Ed25519** | Per-peer shared secret for request signing; per-node Ed25519 keypair for catalog signatures. No Access dependency between peers. |
| Telemetry | **Analytics Engine** | Existing `terraviz_events`. New event types for catalog publish / federation sync / publisher actions land in the same stream behind the Tier A/B gate. |

### What stays the same

- The `Dataset` shape on the wire. Internally the catalog is richer
  (categories as a relation, audit log, visibility flag), but the
  shape returned to `dataService.ts` is the existing one plus a
  small additive set (`origin_node`, `node_url`, `visibility`,
  `schema_version`).
- Tour JSON. The tour engine in `src/services/tourEngine.ts` already
  consumes a stable schema; tours in R2 are byte-identical to tours
  in `public/assets/` today.
- The frontend's offline contract. The desktop app continues to
  download dataset bundles via `download_manager.rs`; the only change
  is that the bundle's source URL points to a Stream / R2 path
  instead of Vimeo / NOAA.
- Telemetry, Orbit chat, and the GIBS tile proxy. All untouched.

### What changes

- `src/services/dataService.ts` reads from `/api/v1/catalog` instead
  of S3, with the legacy URL kept behind a build flag for the public
  reference deployment until cutover.
- `src/services/hlsService.ts` resolves a dataset to an HLS URL via
  `/api/v1/datasets/{id}/manifest` instead of the Vimeo proxy.
- A new `src/services/federationService.ts` (small) tracks which
  peers the node is subscribed to and merges their catalogs into the
  browse UI with origin badges.
- A new `src/ui/publisher/**` tree houses the dataset editor, tour
  creator, and asset uploader. Loaded only when `/publish` is
  navigated to, lazy-imported (same pattern as Three.js for VR).

### STAC alignment

A catalog protocol that ignores the existing scientific-data
ecosystem will be siloed by default. The relevant standards:

- **STAC** (SpatioTemporal Asset Catalog) — the de facto JSON
  schema for spatial-temporal datasets. Has Items, Collections,
  Catalogs, plus standard extensions for projection, scientific
  citation, and versioning. Static-catalog mode is essentially
  what the federation feed already does.
- **DCAT** — W3C dataset metadata vocabulary, RDF-flavoured.
  Reasonable for publishing alongside STAC; not a primary fit.
- **schema.org/Dataset** — what Google Dataset Search consumes.
  Trivial to emit as JSON-LD on dataset pages; ~30 lines.

**Decision: Terraviz's wire `Dataset` is a STAC Item profile.** Not
strict STAC (we keep our existing fields users already depend on)
but a valid STAC Item when projected through a small mapping.
Concretely:

- Required STAC fields are populated or computed:
  - `type: "Feature"`, `stac_version: "1.0.0"`
  - `id`, `bbox`, `geometry` (default global bbox for
    full-globe equirectangular datasets)
  - `properties.datetime` from `start_time` (or
    `start_datetime` / `end_datetime` for ranges)
  - `assets[]` from the existing `data_ref` / `thumbnail_ref` /
    `legend_ref` / `caption_ref` / `sphere_thumbnail_ref` set
  - `links[]` with `self`, `parent` (the catalog),
    `derived_from` (federation: the origin node)
- Terraviz-specific fields live under a namespaced extension:
  `properties.terraviz:weight`, `properties.terraviz:run_tour_on_load`,
  `properties.terraviz:has_alpha`, etc. STAC's extension model
  encourages this.
- The catalog response (`/api/v1/catalog`) is also valid STAC: a
  Collection with `links[]` pointing to each Item. Federation
  feed responses are signed STAC Collections.
- A `schema.org/Dataset` JSON-LD block ships in the
  publisher-portal-rendered dataset detail page (cheap SEO win,
  enables Google Dataset Search indexing).

**Tradeoff accepted:** the wire shape gains some required fields
(`type`, `stac_version`, `bbox`, `geometry`, `properties.datetime`,
`assets`, `links`). The frontend currently consumes a flat shape;
the plan keeps the flat shape available via a mapping layer
(`stacToTerravizDataset()`) so `dataService.ts` doesn't need
restructuring on day one. New consumers (federation peers, third-
party tools) can read STAC directly.

**What this buys us:**
- Out-of-the-box interoperability with PySTAC, stac-fastapi, QGIS,
  and the broader earth-observation tooling ecosystem.
- A real answer to "how does my dataset show up in Google Dataset
  Search."
- The federation protocol becomes a STAC API extension rather than
  a bespoke thing — easier to explain, easier to onboard peers.

**What we are not doing:**
- Full STAC API conformance (search, filter, transactions). The
  read endpoints will be STAC-shaped; the publisher API stays
  Terraviz-native.
- Adopting STAC's `Collection` hierarchy as the *primary* model.
  Datasets are flat; "collections" are a derived view (categories,
  tour groupings).

---

## Data model (D1)

The schema below is the Phase-1 floor. Everything else in the plan
either reads from these tables or adds rows to them.

### Conventions

- Primary keys are ULIDs (lexicographically sortable, URL-safe). The
  string format keeps D1 happy and makes log lines greppable.
- All timestamps are ISO 8601 UTC strings. SQLite has no native
  timestamp type and we need to be JSON-friendly anyway.
- Every catalog-bearing table has a `schema_version INTEGER` column.
  The `/api/v1/catalog` response stamps the highest schema_version
  in the payload so consumers can refuse what they can't parse.
- `origin_node` is denormalized onto every catalog row — even rows
  this node owns — so a federated mirror table can be the same
  schema with a different `origin_node` value.

### Core tables

```sql
-- Identity of this node. Single row.
CREATE TABLE node_identity (
  node_id            TEXT PRIMARY KEY,        -- ULID, generated at install
  display_name       TEXT NOT NULL,
  base_url           TEXT NOT NULL,           -- https://terraviz.example.org
  description        TEXT,
  contact_email      TEXT,
  public_key         TEXT NOT NULL,           -- Ed25519, base64
  created_at         TEXT NOT NULL
);

-- Datasets owned by this node.
CREATE TABLE datasets (
  id                 TEXT PRIMARY KEY,        -- ULID
  slug               TEXT NOT NULL UNIQUE,    -- url-safe, human-typed
  origin_node        TEXT NOT NULL,           -- always = node_identity.node_id
  title              TEXT NOT NULL,
  abstract           TEXT,
  organization       TEXT,
  format             TEXT NOT NULL,           -- video/mp4, image/png, tour/json, ...
  data_ref           TEXT NOT NULL,           -- internal handle: stream:<uid>, r2:<key>, url:<url>
  thumbnail_ref           TEXT,                -- flat 16:9 / 4:3 card image
  sphere_thumbnail_ref    TEXT,                -- 2:1 equirectangular for mini-globe rendering
  sphere_thumbnail_ref_lg TEXT,                -- optional 1024x512 for hero use
  legend_ref         TEXT,
  caption_ref        TEXT,
  website_link       TEXT,
  start_time         TEXT,                    -- ISO 8601
  end_time           TEXT,
  period             TEXT,                    -- ISO 8601 duration
  weight             INTEGER NOT NULL DEFAULT 0,
  visibility         TEXT NOT NULL DEFAULT 'public',
                                              -- public | federated | restricted | private
  is_hidden          INTEGER NOT NULL DEFAULT 0,
  run_tour_on_load   TEXT,                    -- tour id

  -- Media intrinsics. Populated at upload time from probe; null for
  -- legacy `vimeo:` and `url:` refs until backfilled. The frontend
  -- uses these to pick a rendition and drive the shader; see
  -- "Beyond 4K, HDR, and transparency" in the asset pipeline section.
  width              INTEGER,                 -- pixels (encoded)
  height             INTEGER,                 -- pixels (encoded)
  render_width       INTEGER,                 -- logical (== width unless packed-alpha)
  render_height      INTEGER,                 -- logical (== height unless packed-alpha)
  color_space        TEXT,                    -- rec709 | rec2020-pq | rec2020-hlg | p3 | srgb
  bit_depth          INTEGER,                 -- 8 | 10 | 12
  hdr_transfer       TEXT,                    -- null | pq | hlg
  has_alpha          INTEGER NOT NULL DEFAULT 0,
  alpha_encoding     TEXT,                    -- null | native_vp9 | native_hevc | packed_below | packed_right
  primary_codec      TEXT,                    -- h264 | hevc | vp9 | av1 — informational; renditions are the source of truth

  -- License & attribution. SPDX identifier for machine-readable
  -- terms; free-text statement for licenses without an SPDX entry
  -- (most government data falls here). Attribution propagates
  -- through federation — a peer mirroring this dataset is bound
  -- by the same terms and must surface attribution_text to its users.
  license_spdx       TEXT,                    -- SPDX identifier (e.g., "CC-BY-4.0", "CC0-1.0")
  license_url        TEXT,                    -- canonical license URL
  license_statement  TEXT,                    -- free-text fallback (NOAA, "U.S. Government Work", etc.)
  attribution_text   TEXT,                    -- one-line credit shown next to the dataset
  rights_holder      TEXT,                    -- copyright holder; null for public-domain works
  doi                TEXT,                    -- optional persistent identifier
  citation_text      TEXT,                    -- optional preformatted citation (BibTeX-friendly)

  schema_version     INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  published_at       TEXT,
  retracted_at       TEXT,
  publisher_id       TEXT,
  FOREIGN KEY (publisher_id) REFERENCES publishers(id)
);

CREATE INDEX idx_datasets_visibility ON datasets(visibility, is_hidden, retracted_at);
CREATE INDEX idx_datasets_updated_at ON datasets(updated_at);
CREATE INDEX idx_datasets_publisher  ON datasets(publisher_id);

-- Many-to-many decoration. Categories collapse to an array on the wire.
CREATE TABLE dataset_tags (
  dataset_id  TEXT NOT NULL,
  tag         TEXT NOT NULL,
  PRIMARY KEY (dataset_id, tag),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
);

CREATE TABLE dataset_categories (
  dataset_id  TEXT NOT NULL,
  facet       TEXT NOT NULL,                  -- e.g., "Theme", "Region"
  value       TEXT NOT NULL,
  PRIMARY KEY (dataset_id, facet, value),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
);

CREATE TABLE dataset_keywords (
  dataset_id  TEXT NOT NULL,
  keyword     TEXT NOT NULL,
  PRIMARY KEY (dataset_id, keyword),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
);

CREATE TABLE dataset_developers (
  dataset_id      TEXT NOT NULL,
  role            TEXT NOT NULL,              -- 'data' | 'visualization'
  name            TEXT NOT NULL,
  affiliation_url TEXT,
  PRIMARY KEY (dataset_id, role, name),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
);

-- One row per encoded rendition. Populated by the upload + transcode
-- pipeline (Stream callback in Phase 2; ffmpeg-CI for >4K and packed-
-- alpha variants in the Phase 4-5 "Layered visualisation" follow-on).
CREATE TABLE dataset_renditions (
  dataset_id     TEXT NOT NULL,
  rendition_id   TEXT NOT NULL,               -- ULID
  codec          TEXT NOT NULL,               -- h264 | hevc | vp9 | av1
  color_space    TEXT NOT NULL,
  bit_depth      INTEGER NOT NULL,
  has_alpha      INTEGER NOT NULL DEFAULT 0,
  alpha_encoding TEXT,
  width          INTEGER NOT NULL,            -- encoded width
  height         INTEGER NOT NULL,            -- encoded height
  bitrate_kbps   INTEGER,
  ref            TEXT NOT NULL,               -- stream:<uid>/profile or r2-hls:<key>
  mime_type      TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (dataset_id, rendition_id),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
);

CREATE INDEX idx_renditions_dataset ON dataset_renditions(dataset_id);

CREATE TABLE dataset_related (
  dataset_id     TEXT NOT NULL,
  related_title  TEXT NOT NULL,
  related_url    TEXT NOT NULL,
  PRIMARY KEY (dataset_id, related_url),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
);

-- Tours owned by this node.
CREATE TABLE tours (
  id                 TEXT PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,
  origin_node        TEXT NOT NULL,
  title              TEXT NOT NULL,
  description        TEXT,
  tour_json_ref      TEXT NOT NULL,           -- r2:<key>
  thumbnail_ref      TEXT,
  visibility         TEXT NOT NULL DEFAULT 'public',
  schema_version     INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  published_at       TEXT,
  publisher_id       TEXT,
  FOREIGN KEY (publisher_id) REFERENCES publishers(id)
);

-- Datasets a tour depends on, so a subscriber can resolve ahead of play.
CREATE TABLE tour_dataset_refs (
  tour_id    TEXT NOT NULL,
  dataset_id TEXT NOT NULL,                   -- may be a remote id like "peer:<peer_id>:<id>"
  PRIMARY KEY (tour_id, dataset_id),
  FOREIGN KEY (tour_id) REFERENCES tours(id) ON DELETE CASCADE
);
```

### Federation tables

```sql
-- Outbound: peers this node has subscribed to.
CREATE TABLE federation_peers (
  id                 TEXT PRIMARY KEY,        -- remote node_id
  base_url           TEXT NOT NULL UNIQUE,
  display_name       TEXT,
  public_key         TEXT NOT NULL,           -- pinned at handshake
  shared_secret      TEXT,                    -- HMAC, encrypted at rest
  status             TEXT NOT NULL,           -- pending | active | paused | blocked
  policy             TEXT NOT NULL DEFAULT 'mirror_public',
                                              -- mirror_public | mirror_granted | mirror_all
  last_sync_at       TEXT,
  last_sync_cursor   TEXT,
  last_sync_error    TEXT,
  created_at         TEXT NOT NULL
);

-- Frozen snapshots of remote datasets. Same shape as `datasets` minus
-- publisher_id. Foreign-key isolation from local tables is intentional —
-- no joins between local and federated, ever.
CREATE TABLE federated_datasets (
  peer_id        TEXT NOT NULL,
  remote_id      TEXT NOT NULL,
  origin_node    TEXT NOT NULL,
  payload_json   TEXT NOT NULL,               -- full Dataset object as fetched
  signature      TEXT NOT NULL,               -- Ed25519 over payload_json
  fetched_at     TEXT NOT NULL,
  expires_at     TEXT,
  PRIMARY KEY (peer_id, remote_id),
  FOREIGN KEY (peer_id) REFERENCES federation_peers(id) ON DELETE CASCADE
);

CREATE TABLE federated_tours (
  peer_id        TEXT NOT NULL,
  remote_id      TEXT NOT NULL,
  origin_node    TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  signature      TEXT NOT NULL,
  fetched_at     TEXT NOT NULL,
  expires_at     TEXT,
  PRIMARY KEY (peer_id, remote_id),
  FOREIGN KEY (peer_id) REFERENCES federation_peers(id) ON DELETE CASCADE
);

-- Inbound: peers that have subscribed to *us*.
-- Used to enforce per-dataset grants and to fan out invalidations.
CREATE TABLE federation_subscribers (
  id                 TEXT PRIMARY KEY,
  base_url           TEXT NOT NULL UNIQUE,
  display_name       TEXT,
  public_key         TEXT NOT NULL,
  shared_secret      TEXT,
  status             TEXT NOT NULL,           -- pending | active | paused | blocked
  approved_at        TEXT,
  created_at         TEXT NOT NULL
);
```

### Publishing & access tables

```sql
-- Publisher accounts. Identified by Cloudflare Access email today;
-- (Phase 3+) extend with an OIDC subject for community publishers.
CREATE TABLE publishers (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  affiliation     TEXT,
  role            TEXT NOT NULL,              -- staff | community | readonly
  status          TEXT NOT NULL,              -- pending | active | suspended
  created_at      TEXT NOT NULL
);

-- Per-dataset, per-peer share grants. Phase 3.
-- A row here means: grantee X is allowed to see dataset Y.
CREATE TABLE dataset_grants (
  dataset_id   TEXT NOT NULL,
  grantee_kind TEXT NOT NULL,                 -- 'peer' | 'all_federated' | 'public'
  grantee_id   TEXT,                          -- federation_subscribers.id, or NULL
  expires_at   TEXT,
  granted_by   TEXT NOT NULL,                 -- publishers.id
  granted_at   TEXT NOT NULL,
  PRIMARY KEY (dataset_id, grantee_kind, grantee_id),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
);

-- Append-only audit log. Every publish, retract, grant, revoke,
-- subscription accept, and ingest webhook lands here.
CREATE TABLE audit_events (
  id              TEXT PRIMARY KEY,           -- ULID
  actor_kind      TEXT NOT NULL,              -- publisher | peer | system
  actor_id        TEXT,
  action          TEXT NOT NULL,
  subject_kind   TEXT NOT NULL,               -- dataset | tour | peer | grant
  subject_id     TEXT,
  metadata_json  TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_audit_subject ON audit_events(subject_kind, subject_id, created_at);
```

### Migration from the existing public catalog

A Phase-1 importer reads
`https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/dataset.json`
plus `public/assets/sos_dataset_metadata.json`, runs the same merge
that `dataService.ts` does today, and inserts every record as a
`datasets` row owned by the deploying node with `visibility='public'`.
Vimeo links are preserved verbatim in `data_ref` as `vimeo:<id>` and
resolved by the manifest endpoint (see "Asset & video pipeline"), so
cutover doesn't require uploading anything to Stream on day one.

---

## API surface

All routes live under `functions/api/v1/**`. The `/v1/` prefix is
load-bearing: the federation protocol pins it, and we will add `/v2/`
side-by-side rather than mutate `/v1/` once peers start consuming it.

### Public read API (anonymous)

| Method & path | Purpose |
|---|---|
| `GET /api/v1/catalog` | Full dataset list. Returns `{ schema_version, generated_at, etag, datasets: Dataset[] }`. Cache-Control via KV, ETag-driven 304s. |
| `GET /api/v1/catalog?since={cursor}` | Incremental sync. `cursor` is an opaque `updated_at` watermark; response includes `tombstones` (retracted/deleted ids) and a new `cursor`. |
| `GET /api/v1/datasets/{id}` | Single dataset, fully expanded (categories, keywords, developers). |
| `GET /api/v1/datasets/{id}/manifest` | Resolves `data_ref` to a playable URL (HLS for video, image URL with progressive-resolution variants, or tour JSON URL). Issues short-lived signed URLs for restricted content. |
| `GET /api/v1/tours` | Tour list (id, title, description, dataset refs). |
| `GET /api/v1/tours/{id}` | Tour JSON, inlined or via signed R2 URL. |
| `GET /api/v1/tours/{id}/assets/{key}` | Tour overlay assets (images, audio) — proxied/signed from R2. |
| `GET /api/v1/search?q=...` | Optional. Full-text against title/abstract/keywords. Phase 1 uses D1 LIKE; Phase 4 swaps in Vectorize for semantic search. |
| `GET /.well-known/terraviz.json` | Service discovery. Returns node identity, public key, supported `/v1/` endpoints, federation policy. |

`Dataset` on the wire is the existing TypeScript shape plus a small
additive set:

```jsonc
{
  "id": "01HX...",
  "title": "...",
  "format": "video/mp4",
  "dataLink": "/api/v1/datasets/01HX.../manifest",
  // ...all existing fields...
  "originNode": "01HW...",                // node id
  "originNodeUrl": "https://terraviz.example.org",
  "originDisplayName": "Example Org",
  "visibility": "public",
  "schemaVersion": 1,
  "signature": "ed25519:..."              // present on federation responses
}
```

`dataLink` becoming an internal `/manifest` URL means the frontend
no longer needs special cases for Vimeo vs. direct image; the
backend abstracts that away. The legacy public-S3 deployment can
keep `dataLink` as the original NOAA/Vimeo URL during cutover.

### Federation API (peer-to-peer, signed)

All federation endpoints require an HMAC signature in
`X-Terraviz-Signature` over `(timestamp, method, path, body_sha256)`
using the per-peer `shared_secret`. Stale timestamps (>5 min) are
rejected. Replay protection via a small rolling KV nonce window.

| Method & path | Purpose |
|---|---|
| `POST /api/v1/federation/handshake` | Subscriber-initiated. Body: `{ base_url, display_name, public_key }`. Response: `{ subscription_id, status: "pending"\|"active", node_identity }`. Auto-active when peer is on an allow-list; otherwise sits at "pending" for an admin to approve. |
| `GET  /api/v1/federation/feed` | Authenticated catalog read. Same shape as `/api/v1/catalog?since=...` but filtered to what the calling peer is allowed to see (public + grants applicable to that peer). Response is signed. |
| `GET  /api/v1/federation/feed/datasets/{id}` | Single signed dataset. |
| `GET  /api/v1/federation/feed/manifest/{dataset_id}` | Signed playback URL for the calling peer. May be a Stream signed token, an R2 presigned URL, or a redirect. |
| `POST /api/v1/federation/webhook` | Optional push. Peer announces "I changed; please pull soon." Receiver enqueues a pull, returns 202. |
| `DELETE /api/v1/federation/subscription` | Either side can tear down a subscription. |

### Publisher API (authenticated)

Cloudflare Access-protected (Phase 1 staff-only). Same Access policy
the existing `/api/feedback-admin` route uses. Phase 3 adds OIDC for
community publishers.

| Method & path | Purpose |
|---|---|
| `GET    /api/v1/publish/me` | Returns the calling publisher's profile + role. |
| `POST   /api/v1/publish/datasets` | Create dataset. Body validated against a JSON schema; returns `{ id, slug, upload_targets }`. |
| `PUT    /api/v1/publish/datasets/{id}` | Edit metadata. Idempotent. |
| `POST   /api/v1/publish/datasets/{id}/publish` | Flip from draft to public. Stamps `published_at`, invalidates KV catalog snapshot, fans out federation webhooks. |
| `POST   /api/v1/publish/datasets/{id}/retract` | Soft delete. Stamps `retracted_at`; row stays for the audit trail and so subscribers see a tombstone. |
| `POST   /api/v1/publish/datasets/{id}/asset` | Initiate an asset upload. Returns either a Stream direct-upload URL (video) or an R2 presigned PUT (everything else). Body declares `kind` (data \| thumbnail \| legend \| caption). |
| `POST   /api/v1/publish/datasets/{id}/asset/{upload_id}/complete` | Finalizes the upload, runs validation, swaps `data_ref` (or `thumbnail_ref`, etc.). |
| `POST   /api/v1/publish/tours` | Create tour. |
| `PUT    /api/v1/publish/tours/{id}` | Edit. |
| `POST   /api/v1/publish/tours/{id}/preview` | Returns a short-lived signed URL that loads the SPA in preview mode against this draft. |
| `POST   /api/v1/publish/grants` | Phase 3. Add a per-dataset grant. |
| `DELETE /api/v1/publish/grants/{id}` | Revoke grant. |
| `GET    /api/v1/publish/peers` | List subscribed peers (outbound + inbound). |
| `POST   /api/v1/publish/peers/{id}/approve` | Approve a pending inbound subscription. |

### Versioning & deprecation

- The route prefix is the version. Breaking changes ship at
  `/api/v2/`; `/v1/` keeps responding with the v1 shape until every
  declared peer has moved.
- `schema_version` inside the payload is the *content* version. The
  v1 route can return `schema_version=1` or `schema_version=2`
  documents; consumers introspect the field and adapt or refuse.
- The well-known document advertises the highest supported
  `schema_version` so peers can negotiate before a sync.

### Rate limiting & abuse

- Per-IP token bucket on read routes (KV-backed; same pattern as
  `functions/api/ingest.ts`).
- Per-peer rate limit on federation routes, scaled by status:
  `pending` peers get 1 rps, `active` peers get 10 rps, `blocked`
  peers get 410.
- Publisher routes are gated by Access; no extra rate limit until we
  see misuse.

---

## Asset & video pipeline

The catalog stores *references*, not bytes. A `data_ref` value is one
of:

| Scheme | Example | Resolved by `/manifest` to |
|---|---|---|
| `stream:` | `stream:abcdef0123` | Cloudflare Stream HLS URL (signed if non-public) |
| `r2:` | `r2:datasets/01HX.../map.png` | Cloudflare Images variant URL or signed R2 URL |
| `vimeo:` | `vimeo:123456789` | Existing video-proxy.zyra-project.org URL (cutover bridge only) |
| `url:` | `url:https://noaa.example/...` | Pass-through to external URL (legacy NOAA imagery) |
| `peer:` | `peer:01HW.../01HX...` | Federated. Resolves via the peer's `/api/v1/federation/feed/manifest/{id}` |

The reference scheme keeps the catalog row stable while assets move
between backends. A dataset uploaded as a Vimeo link, later
re-encoded into Stream, swaps `data_ref` from `vimeo:...` to
`stream:...` without any client-visible change.

### Video pipeline (Cloudflare Stream)

Stream replaces every Vimeo responsibility we currently rely on:

| Need | Vimeo today | Stream replacement |
|---|---|---|
| Upload | Manual via Vimeo UI | `POST /api/v1/publish/datasets/{id}/asset` returns a Stream direct-upload URL; browser uploads straight to Stream. |
| Transcoding | Vimeo internal | Stream auto-transcodes to HLS + DASH ladder. |
| Playback URL | Vimeo proxy | `https://customer-<id>.cloudflarestream.com/<uid>/manifest/video.m3u8` for public; signed JWT for restricted. |
| ABR bitrate ladder | Vimeo presets | Stream presets (matches our existing 360p/720p/1080p tiers). |
| Captions | Existing `closedCaptionLink` | Stream native VTT track upload, or keep external VTT in R2 (the `caption_ref` column accepts either). |
| Thumbnails | Manual | Stream auto-thumbnail at 0s; publisher can override via UI. |

`hlsService.ts` is unchanged — it still consumes an HLS manifest URL
and an optional MP4 fallback. `datasetLoader.ts` swaps its current
`fetch('https://video-proxy.zyra-project.org/...')` for
`fetch('/api/v1/datasets/{id}/manifest')`. Same JSON shape minus
`dash` (we don't use it) and minus `files[]` for restricted videos
where signed-URL semantics make a long-lived MP4 link a leak.

#### Cutover bridge

For Phase 1 a `vimeo:` `data_ref` resolves through the existing
proxy unchanged, so cutover is a one-line frontend change with no
asset re-uploads. Phase 2 ships the publisher-portal upload path
and a backfill job that pulls each Vimeo source into Stream and
flips the `data_ref`.

### Beyond 4K, HDR, and transparency

The Vimeo-era catalog standardised on 1080p / Rec.709 / 8-bit / no
alpha. That was a Vimeo limit, not a scientific one. Several SOS
datasets are produced at 8K equirectangular and stepped down for
delivery; HDR-graded climate visualisations exist; and "lay one
data layer on top of another" is something the multi-globe layout
already wants to do but can't without alpha. The new pipeline
should accommodate all three.

#### Resolution tiers

| Tier | Path | Notes |
|---|---|---|
| ≤ 1080p | Stream | Default for legacy Vimeo backfill. |
| ≤ 2160p (4K) | Stream | Stream's documented input ceiling for HLS output ladders. |
| 4K → 8K | R2-hosted HLS | Encode out-of-band (CI job or local ffmpeg), upload the segments + manifest to R2, serve through Stream's playback API as an "external" source or directly via R2 + signed URL. The frontend's `hlsService.ts` doesn't care where the manifest came from. |
| > 8K (e.g., 16384×8192 SOS originals) | Tiled imagery, not video | Past ~8K, video codecs stop being the right tool — bandwidth and decode cost dominate. The right answer is GIBS-style tiled raster (XYZ tiles in R2 fronted by `/api/v1/tiles/...`) and let the globe sample the tiles instead of a video texture. Out of scope for Phase 2 but the schema reserves space (`format: 'tiles/raster'`). |

The dataset row stores intrinsic dimensions (`width`, `height`) so
the frontend knows ahead of time which tier to expect and can
choose between video texture and tiled sampler at load time.
`data_ref` distinguishes the two paths: `stream:<uid>` vs.
`r2-hls:<key>` vs. `tiles:<prefix>`.

#### Codec matrix

The pipeline emits multiple codec variants per asset and the
manifest endpoint picks the best one the caller can play, the
same way Stream does for HLS bitrate ladders.

| Codec | Profile | Where it shines | Where it fails |
|---|---|---|---|
| **H.264** | High @ L5.1 | Universal baseline; every browser, every Tauri webview. | 8-bit only in practice; no alpha; size-inefficient at 4K+. |
| **H.265 / HEVC** | Main10 | Half the bitrate of H.264 at 4K; supports 10-bit and Rec.2020. Native HDR on Safari and Edge; hardware decode on Apple Silicon, recent Intel/AMD. | Patent-licensed; Chrome-on-desktop only added support recently and inconsistently. |
| **VP9** | Profile 2 | 10-bit, Rec.2020, alpha-channel via WebM. Universal in Chromium. | Safari support spotty; software decode is heavy at 4K. |
| **AV1** | Main 10 | Best compression; 10-bit + HDR + alpha (in AVIF cousin); royalty-free. Stream supports AV1 output. | Hardware decode needs a modern GPU; software decode is brutal on mobile. |

The plan's recommendation: encode H.264 universally as the
fallback, plus H.265 for HDR/10-bit datasets, plus VP9-with-alpha
for transparent datasets. AV1 is opt-in per dataset and primarily
for the high-res tier where its compression matters.

The catalog row carries the *intent* (`color_space`, `has_alpha`,
`hdr_transfer`); the manifest endpoint picks the right rendition
at request time based on `Accept` headers and a small client-side
capability probe.

#### Color accuracy (HDR / 10-bit / wide gamut)

Scientific data benefits directly from wider color: a precipitation
anomaly map in Rec.2020 + 10-bit can resolve gradients that
Rec.709 + 8-bit crushes into banding. The constraints:

- **Stream HDR.** Cloudflare Stream supports HDR ingest and emits
  HEVC + AV1 HLS ladders with HDR metadata preserved
  (PQ / HLG transfer functions). Frontend playback works in
  Safari out of the box; Chrome needs the right codec preference
  in the manifest.
- **Browser surface.** A `<video>` element on a properly tagged
  HLS playlist will render HDR on supporting hardware. The
  WebGL2 globe sampling that video as a texture is the awkward
  part — the default sampler returns sRGB-tagged values, which
  loses the wider gamut. The globe shader needs a tone-mapping
  step (linear → display gamut) when the source is HDR.
  `mapRenderer.ts` already has a tone-mapping path for the
  photoreal Earth diffuse layer; the change is to thread an
  `is_hdr` flag from the dataset metadata through to the layer.
- **Authoring.** Publishers need a way to declare "this asset is
  HDR" so the manifest endpoint sets the right tags and the
  frontend takes the HDR code path. That's a publisher-portal
  field (`color_space`, `bit_depth`, `hdr_transfer`) plus a
  validation step that checks the upload's actual codec metadata
  against the declared values.

#### Transparent video (alpha layering)

This is the most interesting of the three because it unlocks a
new capability for the globe, not just a fidelity improvement.
Today the multi-globe layout shows N independent data layers in
N adjacent globes. With alpha, a single globe can composite
multiple layers — temperature anomaly over precipitation, sea
surface temperature over ice extent — with proper transparency.

There's no universally supported transparent-video codec on the
web. The plan supports three encodings and the manifest endpoint
picks one per caller:

| Encoding | Pros | Cons |
|---|---|---|
| **VP9 with alpha (WebM)** | Native alpha; great in Chromium. | No Safari, no Tauri webview on Linux. |
| **HEVC with alpha** | Native alpha on Safari (the "transparent video" Apple uses for Memoji etc.). | Apple platforms only. |
| **Packed alpha (RGB+A side-by-side or stacked H.264)** | Universal. Standard H.264 video carrying RGB on top half and alpha on the bottom half (or left/right); a tiny WebGL shader splits them at sample time. | Doubles the video dimensions (a 2K alpha layer is encoded as a 2Kx4K video); decoder cost scales accordingly. |

Recommendation: **packed alpha is the default** because it works
everywhere with a single H.264/H.265 pipeline and only requires a
shader change. VP9-WebM is the optimisation when the caller is
Chromium and the dataset is heavy.

The globe rendering path needs:

- A new layer compositing model in `mapRenderer.ts`. Today a
  dataset is "the" texture for the globe; with alpha, layers are
  ordered, blended, and individually opacity-controllable. This
  is a real change — not invasive, but new.
- A shader variant that takes a packed-alpha video texture and
  splits RGB / A at sample time.
- UI: a layer panel in the dataset info pane that shows the
  current stack and lets the user reorder, hide, or adjust per-
  layer opacity. The Tools popover already has a "view toggles"
  pattern; layer controls slot in next to it.

Schema additions for a transparent dataset:

- `has_alpha = true`
- `alpha_encoding ∈ {'native_vp9', 'native_hevc', 'packed_below', 'packed_right'}`
- For packed encodings, the video's "logical" dimensions
  (`render_width`, `render_height`) are half the encoded
  dimensions on the packed axis. The frontend uses logical
  dimensions for camera framing and packed dimensions for the
  sampler.

#### Manifest response, extended

`/api/v1/datasets/{id}/manifest` for video grows from "one URL"
to a small selection structure:

```jsonc
{
  "kind": "video",
  "intrinsic": {
    "width": 4096,
    "height": 2048,
    "color_space": "rec2020-pq",
    "bit_depth": 10,
    "has_alpha": true,
    "alpha_encoding": "packed_below"
  },
  "renditions": [
    { "codec": "av1",  "color": "rec2020-pq", "alpha": "packed_below",
      "url": "...", "type": "application/vnd.apple.mpegurl" },
    { "codec": "hevc", "color": "rec2020-pq", "alpha": "packed_below",
      "url": "...", "type": "application/vnd.apple.mpegurl" },
    { "codec": "h264", "color": "rec709",     "alpha": "packed_below",
      "url": "...", "type": "application/vnd.apple.mpegurl" }
  ],
  "captions": [...],
  "download_url": "..."
}
```

The frontend picks the first rendition whose `(codec, color)`
combination it can play, falls back, and uses the `intrinsic`
block to drive the shader. Packed alpha is uniform across
renditions (the encoding choice is made at upload time, not at
playback) so the shader doesn't have to branch.

#### Phasing of these capabilities

To avoid over-scoping Phase 2:

- **Phase 2 (asset hosting):** ship the manifest shape above, but
  only the H.264 / Rec.709 / no-alpha rendition path. The schema
  fields exist; the renderer changes don't.
- **Phase 4–5 follow-on:** add packed-alpha encoding in the
  upload pipeline, the layer compositor in `mapRenderer.ts`,
  and the HDR path in the globe shader. This is its own piece
  of work — call it "Layered visualisation" — and it should get
  its own short plan rather than ride on this one.

The catalog backend's job is to *not preclude* these capabilities.
Reserving the schema fields, the manifest structure, and the
`data_ref` scheme namespaces in Phase 2 means the renderer work
in Phase 4–5 is purely client-side.

### Image datasets (R2 + Cloudflare Images)

Most "image" datasets are huge equirectangular PNGs (4096+ wide).
The current pattern is a manual `_4096`/`_2048`/`_1024` suffix that
the client probes in order. That works but bakes assumptions into
the dataset URL.

The new flow:

1. Publisher uploads a single high-res original to R2 via a presigned
   PUT.
2. The asset-complete handler optionally registers the image with
   Cloudflare Images, which serves resolution variants on demand.
3. `/api/v1/datasets/{id}/manifest` returns a JSON object describing
   the variants:
   ```jsonc
   {
     "kind": "image",
     "variants": [
       { "width": 4096, "url": "..." },
       { "width": 2048, "url": "..." },
       { "width": 1024, "url": "..." }
     ],
     "fallback": "..."
   }
   ```
4. The frontend keeps its existing "try larger first, back off on
   failure" behaviour but reads from `variants` instead of
   string-mangling the URL.

For self-hosted nodes that don't enable Cloudflare Images, the
manifest endpoint can fall back to serving the original from R2 and
omit the variants array; the frontend handles that case by using
the fallback URL.

### Sphere thumbnails (2:1 equirectangular)

A flat thumbnail card is the obvious choice for a 2D browse list,
but a Terraviz dataset is fundamentally spherical — a 16:9 still
flattens away the property that makes it interesting. The plan
ships a second thumbnail variant alongside the flat one: a small
2:1 equirectangular texture that can be wrapped onto a low-cost
mini-globe in the UI.

Use cases this unlocks:

- **Rotating sphere on each browse card.** Hover (or auto-rotate)
  spins a small globe with the dataset's actual texture, so the
  card preview reads as "the dataset," not "a screenshot of a
  globe." Fits the existing `browseUI.ts` card layout with no
  layout change.
- **Network graph of datasets.** A force-directed layout where
  each dataset is a small sphere and edges are shared categories
  / keywords / tours. Acts as a visual table of contents for the
  catalog and works well as a federation explorer ("see how peer
  X's datasets connect to yours").
- **Federated peer overview.** A peer's well-known endpoint
  could surface a "constellation" of its datasets at a glance
  without pulling the full catalog.
- **Tour preview ribbons.** A horizontal strip of mini-globes,
  one per dataset the tour visits, rendered in playback order.
- **Empty-state and loading hero.** A slowly rotating sphere of
  a curated dataset is a much warmer placeholder than a spinner.

#### Asset shape

| Property | Value |
|---|---|
| Aspect | 2:1 equirectangular (matches Terraviz's full-globe textures) |
| Default size | 512 × 256 (≈40 KB WebP, ≈100 KB JPEG) |
| Optional larger | 1024 × 512 for hero use, opt-in per dataset |
| Format | WebP primary, JPEG fallback for older webviews |
| Color | sRGB / 8-bit always (HDR is wasted on a thumbnail) |
| No alpha | Even for transparent datasets, the sphere thumbnail composites against the dataset's natural background |

#### Generation pipeline

Generated at upload time, never by the publisher manually:

| Source | Method |
|---|---|
| Video dataset | First-frame extract via Stream's thumbnail API at t = duration / 4 (avoids title cards), downscaled to 512×256, WebP+JPEG. |
| Image dataset | Downsample the canonical original through Cloudflare Images to 512×256 with `fit=fill` (the image is already 2:1 in practice for SOS data; assert and warn otherwise). |
| Tour | Sphere-thumb of the tour's first `loadDataset` target, with a small "play" badge composited corner. |
| Tiled raster | Composite the lowest-zoom-level tiles into a single 512×256 image at ingest. |

The asset-complete handler runs the generation as part of the
existing transcode/upload finalization step — no separate publisher
action required. A "regenerate sphere thumbnail" button in the
publisher portal handles the rare case where the auto-pick frame
is unrepresentative (mid-fade, all-black, etc.).

#### Storage & serving

Lives at a predictable R2 key alongside the flat thumbnail:

```
datasets/{id}/sphere-thumbnail.webp
datasets/{id}/sphere-thumbnail.jpg
datasets/{id}/sphere-thumbnail-1024.webp   (optional larger)
```

Public-visibility datasets serve through R2's public URL +
Cloudflare cache (long-TTL, immutable filename via content hash on
upload — the row stores the full key). Restricted datasets serve
via a presigned URL from the manifest endpoint, same pattern as
the rest of the asset stack.

#### Catalog response

A new field on `Dataset` on the wire:

```jsonc
{
  "thumbnailLink": ".../thumbnail.jpg",          // existing flat
  "sphereThumbnailLink": ".../sphere-thumbnail.webp",
  "sphereThumbnailLinkLarge": null               // present only if generated
}
```

The flat `thumbnailLink` stays the default for any caller that
doesn't ask for the spherical one, so existing federation peers
running an older client see no change.

#### Frontend rendering

A `MiniSphere` component lives in `src/ui/miniSphere.ts`, built on
the existing photoreal-Earth factory in
`src/services/photorealEarth.ts` but stripped to:

- One sphere geometry (shared instance across all mini-spheres on
  a page).
- One material per sphere with the equirectangular thumb as a
  texture.
- Optional auto-rotate (`y` axis, slow constant rate).
- Optional pointer-driven rotate while the cursor is over the card.
- No atmosphere, no clouds, no day/night shader, no sun.

Three.js is already lazy-loaded for VR; the same chunk powers
mini-spheres. The chunk is loaded the first time a view that
contains mini-spheres is rendered — browse cards, network graph,
or tour ribbon — and stays warm afterwards.

#### Performance budget

Naïve "one WebGL canvas per card" doesn't scale past a few dozen
spheres. The plan's strategy:

- **Browse list (≤ ~30 visible at once):** one shared
  `WebGLRenderer` rendering into a single canvas that overlays
  the card grid via absolute positioning, with per-sphere
  scissor regions. Same renderer, N sub-viewports, vastly fewer
  GPU contexts than N canvases.
- **Network graph (50–500 nodes):** instanced rendering of one
  sphere geometry, with the per-sphere texture either:
  - sampled from a CSS-style "texture atlas" (a single 4Kx4K
    WebP with each dataset's 256x128 thumb tiled in), or
  - a `THREE.DataArrayTexture` of equirectangular tiles indexed
    per instance. The atlas approach is the simpler default.
- **Off-viewport / paused tab:** rAF stops when the tab is
  hidden (the page already does this for the main globe);
  mini-spheres inherit the pause for free.
- **Low-end fallback:** devices without WebGL2, or those that
  fail the existing capability probe, render the flat thumbnail
  unchanged. The component never crashes a browse view.

The overall rule: a hundred mini-spheres should cost less than
the main globe. If they don't, drop to the atlas billboard mode
(pre-render each sphere to a 256x256 canvas once and treat it as
a regular `<img>`) — visually similar at small sizes, almost free
to render in bulk.

#### Network-graph view (defer the *design*, enable the *capability*)

The catalog backend's job here is to make the asset cheaply
available; the actual graph view is a separate piece of UI work
worth its own short plan. What the catalog provides:

- The `sphereThumbnailLink` field, populated for every dataset.
- An optional `/api/v1/catalog/graph` endpoint (Phase 4) that
  returns a slim payload — `{ id, sphereThumbnailLink, edges: [...] }`
  with edges derived from shared keywords, categories, and tour
  co-occurrence. Pre-computed on publish, cached in KV. Lets a
  client render a graph without pulling full catalog records for
  every node.
- Federation: a peer's mini-spheres come along for the ride in
  the federated catalog response. A network graph that spans
  peers visualises the federation itself — which is exactly the
  "constellation of nodes" mental model the user asked for.

The graph view's own design (layout algorithm, interaction model,
which edge predicates are exposed as filters) can land later
without re-touching the backend.

### Thumbnails, legends, captions

All small assets land in a single R2 bucket (`terraviz-assets`)
under predictable keys:

- `datasets/{id}/thumbnail.{ext}`
- `datasets/{id}/legend.{ext}`
- `datasets/{id}/caption.vtt`
- `tours/{id}/tour.json`
- `tours/{id}/overlays/{key}`

Public-visibility datasets serve thumbnails through the bucket's
public URL plus Cloudflare cache. Restricted datasets serve through
the `/manifest` endpoint, which issues short-lived presigned URLs.

### Tour assets

Tour JSON is stored in R2 and referenced by `tours.tour_json_ref`.
The tour creator (see "Publishing tools") writes a draft to a
`drafts/{tour_id}/tour.json` key; publishing copies to the canonical
`tours/{id}/tour.json` and updates the row. Overlay images / audio
referenced by `showImage` / `playAudio` tour tasks live alongside
under `tours/{id}/overlays/`.

### Asset lifecycle

| State | Lives where | Cleaned up by |
|---|---|---|
| Draft (publisher portal) | R2 under `drafts/{publisher}/{id}/...` | Cron purges drafts older than 30 days. |
| Published | R2 under `datasets/{id}/...` or Stream | Lives until retracted. |
| Retracted | R2 path stays; Stream video stays; row marked retracted | After 90-day grace, a cron deletes assets and sets `data_ref` to `null` (catalog row remains as a tombstone for federation). |
| Federated mirror | Not stored locally — only metadata | Naturally expires via `expires_at`; refreshed by sync. |

### Offline (Tauri) compatibility

`download_manager.rs` already negotiates direct downloads. The
manifest endpoint adds an explicit `download_url` field for video
(an MP4 rendition URL from Stream) and image datasets so the desktop
app gets a single canonical URL per resolution tier. Existing
download flow keeps working; it just reads from a single
`/manifest` JSON instead of two endpoints.

---

## Federation model

A node is **discoverable** if it serves a `/.well-known/terraviz.json`
document. A node is **subscribable** if it accepts handshakes at
`/api/v1/federation/handshake`. Subscriptions are explicit, named,
and persisted; there is no implicit fan-out. A user-facing node
operator can add or remove peers from the publisher portal.

### The well-known document

```jsonc
{
  "node_id": "01HW...",
  "display_name": "NOAA SOS",
  "base_url": "https://sos.noaa.example",
  "public_key": "ed25519:...",
  "schema_versions_supported": [1],
  "endpoints": {
    "catalog":   "/api/v1/catalog",
    "feed":      "/api/v1/federation/feed",
    "handshake": "/api/v1/federation/handshake"
  },
  "policy": {
    "open_subscription": false,
    "auto_approve": false,
    "max_request_rate_per_minute": 600
  },
  "contact": "ops@noaa.example"
}
```

`open_subscription: false` means handshakes go to "pending" and an
operator approves them via the publisher portal. `auto_approve` is
the soft default for friendly networks (e.g., a constellation of
science museums that trust each other); flipping it on is one
checkbox in the portal.

### Subscription handshake

Out-of-band exchange of base URLs is fine — it's a low-stakes
operation. Cryptographic identity is inline:

```
Subscriber A                                Publisher B
     │  GET https://B/.well-known/terraviz.json
     ├─────────────────────────────────────────────►
     │                                              │ returns identity + public key
     │◄─────────────────────────────────────────────┤
     │                                              │
     │  POST /api/v1/federation/handshake           │
     │  Body: { base_url, display_name,             │
     │          public_key }                        │
     │  Signed: HMAC-SHA256 with bootstrap secret   │
     │          (out-of-band shared one-time code)  │
     ├─────────────────────────────────────────────►│
     │                                              │ inserts federation_subscribers row,
     │                                              │ status=pending; signs response
     │◄─────────────────────────────────────────────┤
     │  { subscription_id, status: "pending",       │
     │    shared_secret: "<HMAC base64>",           │
     │    node_identity: { ... } }                  │
     │                                              │
     │  ── operator clicks Approve in B's portal ──│
     │                                              │
     │  GET /api/v1/federation/feed                 │
     │  X-Terraviz-Signature: HMAC over request    │
     ├─────────────────────────────────────────────►│
     │                                              │
```

The bootstrap secret is a one-time code the subscribing operator
pastes into a form during the handshake; after that, the
server-issued `shared_secret` is used for all future requests. This
keeps the protocol self-contained — no external CA, no separate
identity service.

### Sync protocol

Pull-based, cursor-driven. The subscriber does:

1. `GET /api/v1/federation/feed?since={cursor}` (signed).
2. Verify the response signature against the pinned peer public key.
3. For each dataset / tour in the response, upsert into
   `federated_datasets` / `federated_tours` keyed by
   `(peer_id, remote_id)`.
4. For each tombstone, delete or mark expired.
5. Save the new cursor.

Cadence is configurable per peer (default: every 15 minutes via
Cloudflare Cron). Peers can also call
`POST /api/v1/federation/webhook` to nudge the subscriber to pull
sooner; the receiver enqueues a Queue message and the worker drains
it.

A Durable Object per peer (Phase 4+) can replace the cron + queue
combo with a single coordinator that owns cursor + retry timer +
circuit breaker. Phase 4 starts with cron because it's simpler;
move to DOs only if we hit coordination problems.

### Catalog signing

Every federation response is signed:

```
Signature-Input: ed25519, key_id="<node_id>", timestamp=...
Body: { schema_version, generated_at, datasets: [...], tombstones: [...] }
Signature: <Ed25519 over canonicalized body + headers>
```

Subscribers verify on every fetch. A failed signature halts that
sync and surfaces an alert in the publisher portal. Pinning happens
at handshake — a peer that rotates its key has to either advertise
the new key in the well-known doc with a grace overlap or the
subscriber has to re-handshake.

### Merging into the browse UI

`browseUI.ts` today renders `state.datasets`. With federation, the
state becomes:

```ts
state.datasets = [
  ...localDatasets,        // origin_node === this node
  ...federatedDatasets,    // origin_node !== this node, fetched from peers
];
```

UI affordances:

- An origin badge on each card (own node logo / peer name + favicon).
- A peer filter chip: "All sources / This node / Peer X / Peer Y".
- Federated datasets that are unreachable (peer down, signature
  failure) are dimmed and labelled "temporarily unavailable" rather
  than removed, so a flapping peer doesn't blink datasets in and out.

### Tours that span peers

A tour can `loadDataset` on a federated dataset (id like
`peer:<peer_id>:<remote_id>`). The tour engine resolves the id via
the local federated cache, then calls the peer's
`/api/v1/federation/feed/manifest/{id}` to get a playback URL,
*not* the local node's. Data stays at home; the subscriber just
points its player at the peer's signed URL.

### License & attribution propagation

A dataset's license follows it across federation. The
`federated_datasets.payload_json` cache stores the full Dataset
including `license_spdx`, `license_url`, `license_statement`,
`attribution_text`, `rights_holder`, `doi`, and `citation_text`.
A subscriber:

- Renders the attribution next to the dataset in browse cards,
  the info panel, and any tour playback view (no exceptions —
  this is what makes the system safe to use for CC-BY content).
- Refuses to display datasets without a license declaration when
  the operator's policy is "require licenses" (a federation
  setting). Default policy is "permissive" — show with an
  "unspecified license" warning — to ease migration.
- Surfaces `license_spdx` and `attribution_text` in the embed
  snippet and citation export so attribution survives the dataset
  leaving the application.

Per-peer policy (`federation_peers.policy`) extends with
`require_license` and `allowed_license_spdx` (allowlist of
acceptable SPDX IDs). A peer publishing CC-BY content can subscribe
to peers that publish public-domain content without inheriting
license-incompatibility headaches.

For datasets without an SPDX-listed license (most U.S. government
work — "U.S. Government Work" isn't an SPDX identifier),
`license_statement` carries the human-readable terms and
`license_spdx` is null. The frontend treats null SPDX as "see
license_statement" and shows the statement verbatim.

### Failure modes the protocol has to survive

| Failure | Behaviour |
|---|---|
| Peer offline | Sync fails, last-good `federated_datasets` rows remain, UI dims items, operator alert via audit log + (optionally) Slack webhook. |
| Peer rotates key without overlap | All future syncs fail signature check. Operator re-handshakes from the portal. |
| Peer revokes a grant | On next sync, the previously-visible item disappears and a tombstone arrives. UI shows it as "unavailable" until the local cache evicts. |
| Schema drift (peer ships v2) | Subscriber refuses items with `schema_version` higher than supported, logs once per sync, keeps known-good items. |
| Hostile peer floods with bogus datasets | Per-peer item-count cap (configurable, default 10k). Beyond it, syncs degrade to error and require operator unblock. |
| Subscriber's clock is skewed | Signed timestamps + 5-minute window; persistent failure surfaces a "check your clock" alert. |
| Peer transcripts a dataset to a private grant after publishing | Tombstone delivered next sync; subscriber removes it. The window where a stale subscriber still has the metadata is bounded by sync cadence. |

### Why not ActivityPub / Atom / OAI-PMH?

We considered all three:

- **ActivityPub** is overkill — the inbox/outbox model is built
  around social posts and assumes an identity layer (Webfinger) we
  don't need.
- **Atom / RSS** has no signature story and no good cursor model
  for "deletes since."
- **OAI-PMH** is the closest fit conceptually (verbs like
  `ListRecords` with a resumption token), but it's XML-only, has no
  signed payloads, and the auth story is nonexistent.

A small JSON-over-HTTP protocol with Ed25519 signatures and HMAC
auth is the smallest thing that handles the requirements and stays
within the Cloudflare runtime without a third-party dependency.

---

## Docent integration

The docent (Orbit) is a frontend feature, but its integration with
the catalog backend is shaped enough to be worth pinning down here.
The implementation today bakes the entire catalog into the system
prompt on every turn (see `src/services/docentContext.ts`). That
doesn't survive federation, where the merged catalog can be ten
times the local one. The Phase 1b refactor moves discovery from
prompt-stuffing to function calling against a vector index.

### Tool surface

Three tools the LLM is given:

- **`load_dataset(id, world_index?)`** — Already exists. Loads a
  dataset onto the globe (or a specific globe slot in multi-globe
  layout). The inline `<<LOAD:...>>` marker syntax is preserved as
  a fallback for providers that don't support function calling.
- **`search_datasets(query, filters?, limit?)`** — New. Vector
  similarity search over the catalog index. Returns
  `[{ id, title, abstract_snippet, categories, peer_id }]`.
  Filters cover category, peer (`'local'` or a peer ID), and
  time range. The LLM calls this whenever it needs to find
  datasets matching the user's intent.
- **`list_featured_datasets(limit?)`** — New. Returns a small
  operator-curated list, used for cold-start "what should I look
  at?" conversations where the user has not yet expressed intent.
  Curation lives in a `featured_datasets` table maintained by
  the publisher portal; no algorithmic guessing.

### Vector index

- **Backend.** Cloudflare Vectorize, a managed vector DB on the
  same Cloudflare account. No external dependency.
- **Embedding model.** `@cf/baai/bge-base-en-v1.5` from Workers
  AI — 768-dim, English-tuned, free quota for in-account use.
  Larger models (`bge-large-en-v1.5`, 1024-dim) are available if
  retrieval quality testing argues for them; storage and embed
  cost scale linearly with dimensions.
- **Document shape.** Each dataset embeds
  `title + abstract + categories.join(' ') + keywords.join(' ')`
  as a single document. Re-embedded whenever any of those fields
  changes; the dataset row carries an `embedding_version INTEGER`
  column tracking model version, so a cron can re-embed
  everything on a model upgrade.
- **Index keys.** `dataset_id` (ULID) is the Vectorize key.
- **Index metadata.** `{ peer_id, category, time_range_start,
  time_range_end, visibility, schema_version }` — used for
  filtering at query time without round-tripping to D1.

### Indexing pipeline

A Queue consumer drives embedding work. Triggers:

- **Publish.** Asset-complete handler enqueues an embed job after
  successful publication.
- **Update.** Patch handler enqueues an embed job if any of the
  embedded fields changed.
- **Retract.** Retraction handler enqueues a vector-delete job.
- **Hard delete.** Same shape as retract; vector deletion is
  permanent.
- **Federation sync.** Federated datasets ingested by the sync
  cron enqueue embed jobs on the local node. Their `peer_id`
  metadata makes them filterable / excludable at query time.

The job runs idempotently — three updates in a minute queue
three jobs but the index ends up consistent with the latest
state. Failed embeds retry with exponential backoff; a stuck
dataset surfaces in the publisher-portal history view as an
`embed_failed` audit event.

### Per-peer inclusion in the docent

Federated datasets are embedded into the local Vectorize index by
default at sync time, but the search-tool handler filters them
out unless the operator has flipped
`federation_peers.include_in_docent` to `1`. The default is `0` —
operators must explicitly opt a peer in before that peer's content
reaches the docent's recommendations.

This matches the `asset_proxy_policy` precedent: be conservative
about including someone else's content in operator-controlled
surfaces, and surface a clear knob for the operator to flip when
they trust the peer's curation.

### What changes in the frontend

`docentContext.buildSystemPromptForTurn()` simplifies dramatically.
The turn-aware logic for "full catalog turn 0, compact turn ≥1"
goes away entirely. The system prompt becomes a stable static
thing: docent persona + tool descriptions + light instruction on
when to call which tool.

Per-turn token cost on the LLM drops from "a few KB of catalog"
to "a kilobyte of tool descriptions" — a material saving on
every conversation, regardless of catalog size.

The local engine fallback (`docentEngine.ts`) is unchanged — it's
keyword-based, doesn't need embeddings, and remains the
offline / LLM-disabled path.

---

## Publishing tools

The publisher portal lives behind Cloudflare Access at `/publish`
and is lazy-loaded the same way Three.js is — the main bundle is
unchanged for non-publisher visitors. Code lives under
`src/ui/publisher/**`.

### Dataset entry page

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

### Tour creator

This is the larger subproject. Goal: a publisher records a
sequence of camera positions, dataset loads, overlay shows, and
narration without writing JSON.

#### Capture mode

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

#### Persistence

Drafts auto-save every 30 seconds to
`drafts/{publisher}/{tour_id}/tour.json` in R2 plus a `tours` row
with `published_at IS NULL`. Publishing copies to
`tours/{id}/tour.json`, sets `published_at`, and triggers federation
fan-out.

#### Existing tour engine compatibility

Output is identical to the current `tour/json` format consumed by
`src/services/tourEngine.ts`. No engine changes are required for
Phase 1; Phase 5 adds a `tour_schema_version` field so the engine
can refuse a tour newer than it understands.

### Asset uploader

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

### Preview pipeline

Drafts are unlisted but loadable by id with a short-lived signed
token issued by `POST /api/v1/publish/datasets/{id}/preview`. The
token allows exactly one dataset (or one tour) and expires in 30
minutes. The frontend reads it from a `?preview=...` query param,
calls `/api/v1/publish/datasets/{id}` (rather than the public route)
to fetch the draft, and renders normally.

### Other tools that round out the experience

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

---

## Authorization & per-dataset sharing

This section covers the **read side**: who can see a dataset's
metadata, resolve a playable manifest, and have it surfaced through
federation. The complementary **write side** — who can author,
edit, submit, approve, retract, or hard-delete a dataset — lives in
[`CATALOG_PUBLISHING_TOOLS.md`](CATALOG_PUBLISHING_TOOLS.md) under
"Publisher identity & roles" and the capability matrix there. The
two read-side and write-side grant tables are deliberately
distinct: `dataset_grants` (here) controls viewing,
`dataset_collaborators` (in
[`CATALOG_DATA_MODEL.md`](CATALOG_DATA_MODEL.md)) controls editing.
Conflating them would couple federation peer access to publisher
identity, which we explicitly do not want.

Visibility is a property of the dataset row plus a set of grants.
The combination determines who can see metadata, who can resolve a
playable manifest, and what the federation feed exposes to a given
peer.

### Visibility levels

| Value | Anonymous web | Federated peers (default) | With grant | Notes |
|---|---|---|---|---|
| `public` | Yes | Yes | n/a | Default for the seeded SOS catalog. |
| `federated` | No | Yes | n/a | Visible to any active peer; not on the public web of this node. Useful for "share with our network but not the open internet." |
| `restricted` | No | No | Visible to grantees only | The dataset-by-dataset case the user asked about. |
| `private` | No | No | Visible only to the owning publisher | Drafts and internal-only assets. |

### Grant resolution

When a peer requests `/api/v1/federation/feed`, the route runs:

```
SELECT id, ... FROM datasets
WHERE retracted_at IS NULL
  AND is_hidden = 0
  AND (
    visibility = 'public'
    OR visibility = 'federated' AND :peer_status = 'active'
    OR visibility = 'restricted' AND id IN (
        SELECT dataset_id FROM dataset_grants
        WHERE (grantee_kind = 'all_federated')
           OR (grantee_kind = 'peer' AND grantee_id = :peer_id)
        AND (expires_at IS NULL OR expires_at > :now)
    )
  )
ORDER BY updated_at;
```

Tombstone rows (rows where the peer used to qualify but no longer
does) are computed by diffing against the peer's last cursor — the
sync route is the natural place to compute "what disappeared since
your cursor" because it already has both states in scope.

### Manifest authorization

`/api/v1/datasets/{id}/manifest` is the asset gatekeeper. For a
restricted dataset:

1. Identify the caller (Access cookie for staff, federation HMAC
   for peers, anonymous otherwise).
2. Check that the caller is permitted (publisher of record, granted
   peer, or holder of a preview token).
3. Mint a short-lived URL:
   - **Stream:** programmatically-signed JWT with `exp = now + 5m`
     and `nbf = now − 30s`. The 30-second `nbf` (not-before) claim
     absorbs minor client clock skew so a client whose clock is a
     few seconds fast doesn't get a token Stream rejects as
     "issued in the future." We deliberately do **not** use Stream's
     auto-issued `/token` endpoint, which defaults to a 1-hour TTL
     and is too long-lived for restricted content.
   - **R2:** presigned GET with `exp = now + 5m`.

   Both URLs are minted fresh per manifest request; the manifest
   endpoint itself is not cached for restricted content.
4. Return the URL plus expiry so the frontend can refresh before
   it expires (rare in practice; typical playback completes
   inside the window).

The manifest never returns a long-lived public URL for restricted
content. The frontend re-fetches the manifest on session resume.

The 5-minute TTL was researched against Cloudflare's docs: there
is no documented hard minimum below this for programmatic
JWT-signed Stream tokens, so the value is policy rather than
platform-imposed. If the clock-skew warning shows up in the
production-debugging playbook (see
[`CATALOG_BACKEND_DEVELOPMENT.md`](CATALOG_BACKEND_DEVELOPMENT.md))
more than once a quarter, widen the `nbf` window before
shortening the `exp` window.

### Audit trail

Every grant, revoke, manifest issuance for restricted content,
publish, retract, peer subscribe, and peer block writes a row to
`audit_events`. The publisher portal exposes a per-dataset history
view. This is the tool a publisher uses to answer "did peer X get
this dataset before I retracted it?" — the answer is in the audit
log.

### Revocation latency

Revocation is eventually consistent, bounded by:

- **Catalog visibility:** subscriber's next sync interval (default
  15 min) for the row to become a tombstone in their cache.
- **Asset playback:** signed URL TTL (5 min) for outstanding URLs
  to expire.
- **Edge cache:** Cache-Control on the manifest endpoint is
  `private, max-age=60` so a CDN won't serve a stale URL beyond a
  minute.

For "I need to revoke immediately" cases, an admin can also rotate
the per-peer shared secret and invalidate all in-flight signed
URLs server-side (Stream key revocation). Phase 5 ships a
"hard-revoke" button that does both.

### Federation policy presets

The publisher portal exposes three presets to the operator that
roll up to common cases:

- **Open:** every public dataset is federated by default. Pick this
  when the node is a public good.
- **Allowlist:** only datasets explicitly marked `federated` (or
  granted) leave this node. Pick this for institutional deployments
  with content-sharing agreements.
- **Restricted:** nothing federates without a per-peer grant. Pick
  this for sensitive collections.

The preset is a UI shortcut over the per-dataset visibility flag;
the backend has no notion of "policy" beyond what each row says.

### What this plan does *not* solve

- **DRM.** A grantee with playback access can record their screen.
  Restricting access ≠ preventing copying. We are not building a
  DRM system; "restricted" means "not findable / not enumerable,"
  not "uncopyable."
- **End-to-end encryption.** The manifest issues plaintext signed
  URLs to authorized callers; the bytes themselves are not
  encrypted at rest beyond R2's transparent encryption. Adding
  per-grant encryption keys is a Phase 6+ concern if regulators
  require it.
- **Identity federation.** Per-dataset grants are *peer-scoped*,
  not *user-scoped*. Sharing "with a specific researcher on peer
  X" is the peer's responsibility — they expose the dataset to
  whoever they expose all federated datasets to. A finer-grained
  user-scoped grant is possible but doubles the protocol surface
  and is out of scope.

---

## Threat model & secrets management

The plan introduces three new identities that didn't exist before
(node, peer, publisher) and three new privileged surfaces (publisher
API, federation API, asset upload). Each is a place a careful
review will probe; spelling out the threats and mitigations now
keeps Phase 1 from shipping with surprises.

### Actors & trust boundaries

| Actor | Authenticates as | Trust level |
|---|---|---|
| Anonymous web visitor | Nothing | Read-only access to `visibility=public` content. |
| Federation peer | HMAC over per-peer `shared_secret` | Reads what its grants allow. May not write. |
| Publisher (staff) | Cloudflare Access cookie | Writes to own datasets / tours; reads audit log. |
| Publisher (community, Phase 6) | OIDC subject | Same as staff but moderation-gated. |
| Node operator | Wrangler / Pages dashboard | Full DB + binding access. Out of band. |
| Cloudflare | Platform | Unconditionally trusted; if Cloudflare is compromised, so is everything. |

### Threats and mitigations

#### Server-side request forgery via publisher input

Publisher-supplied URLs (`websiteLink`, `dataset_related.related_url`,
`legend_ref` if scheme is `url:`) flow into server-side fetches
during enrichment, asset probing, and the legend-image proxy at
`/api/legend`. Without validation an attacker can pivot to internal
services.

**Mitigations:** every server-side fetch passes through a single
`safeFetch()` helper that:
- Resolves the hostname before the request and rejects RFC-1918,
  loopback, link-local, and `0.0.0.0/8` ranges (the existing
  `/api/legend` does this; codify it).
- Rejects redirects to such ranges (re-resolve on each hop).
- Caps response size and timeout.
- Has no access to D1/KV/R2 bindings — runs in a subworker or via
  `fetch()` with the bindings stripped.

#### Cross-site scripting via publisher markdown

Dataset abstracts and tour overlay HTML accept user input that the
frontend renders. The current app already renders some HTML in
tour `popupHTML` and `addPlacemark` — the plan widens the input
surface.

**Mitigations:** `abstract` is rendered as Markdown through a
sanitizer (DOMPurify or equivalent) with a small allowlist
(headings, paragraphs, links, code, images). `popupHTML` /
`tourOverlayHTML` go through the same sanitizer. Raw HTML upload
in tours is forbidden in Phase 1 — only the sanitised path. Phase
3+ may add a `trusted: true` flag on staff-published tours that
relaxes the sanitizer; it does not relax for community publishers.

#### Replay & clock-skew attacks on federation

The 5-minute timestamp window narrows but does not eliminate
replay. A peer can re-send a captured request inside the window
and re-trigger any non-idempotent operation.

**Mitigations:** every signed request carries a `nonce` (random
ULID); the receiver stores `(peer_id, nonce)` in KV with a
6-minute TTL and rejects duplicates. Federation reads are
idempotent by construction; the nonce primarily defends webhook
endpoints.

#### Compromised peer secret

A peer's `shared_secret` could leak from their D1 backup, their
ops repo, or their browser if mis-handled.

**Mitigations:** secrets are HMAC keys, not signing keys — losing
one lets the attacker read what the peer could read, not write to
us. Per-peer `last_sync_at` and request-rate metrics surface
anomalies; an "unusually heavy sync" alert surfaces in the
operator UI. The `POST /api/v1/publish/peers/{id}/rotate-secret`
endpoint lets an operator invalidate the old secret without
tearing down the subscription.

#### Hostile peer floods catalog with bogus datasets

An accepted peer can return a million-item feed.

**Mitigations:** per-peer item-count cap (default 10k), enforced at
sync time; beyond the cap, the sync errors and requires operator
unblock. Per-peer storage cap on `federated_datasets`. A "block
peer + purge cache" admin action.

#### Compromised publisher account

An attacker who phishes a publisher's Access session can publish,
retract, or grant.

**Mitigations:** every privileged action writes to `audit_events`
with the actor email; per-publisher rate limit (Phase 3) on
publish/grant operations; a "review recent activity" page in the
publisher portal so a real publisher notices unauthorized changes;
publisher portal sessions inherit Access's idle-timeout. Hard
revoke is available via the operator workflow described in
Authorization.

#### Restricted-asset URL leakage

A signed Stream / R2 URL handed to one user could be shared.

**Mitigations:** TTL is short (5 min); URLs are minted per-request
not cached; `Cache-Control: private, no-store` on manifest
responses; for high-sensitivity datasets a per-session token can
be required (Phase 5+).

#### Federation tombstone forgery

A peer who can MITM the connection could forge a tombstone for a
dataset they want suppressed.

**Mitigations:** every federation response is Ed25519-signed by
the peer's pinned public key; tombstones are only honoured when
the signature verifies. TLS provides transport confidentiality on
top.

### Secrets management

Where each secret lives and how it rotates:

| Secret | Stored where | Rotation |
|---|---|---|
| Node Ed25519 private key | Wrangler secret (`NODE_SIGNING_KEY`); never in D1 | Manual; advertise overlap window in well-known doc; subscribers re-pin on next handshake. |
| Per-peer `shared_secret` (us → them) | D1 `federation_peers.shared_secret`, encrypted with `PEER_SECRET_KEK` (Wrangler secret) | `POST /api/v1/publish/peers/{id}/rotate-secret`; old + new accepted for a short window. |
| Per-peer `shared_secret` (them → us) | D1 `federation_subscribers.shared_secret`, same KEK | Same. |
| Stream signing key | Wrangler secret (`STREAM_SIGNING_KEY`) | Cloudflare-managed rotation; we accept the new key. |
| R2 access key (for presigning) | Wrangler secret (`R2_ACCESS_KEY` / `R2_SECRET`) | Manual; rotate quarterly. |
| LLM API key | Already-existing pattern (Wrangler secret server-side, OS keychain on Tauri) | Out of scope here. |
| Bootstrap handshake codes | KV with 10-min TTL | One-time use. |

The "encrypt at rest in D1 with a KEK" pattern is the only
non-obvious bit: D1 contents are visible to anyone with binding
access (which is anyone who can deploy a Pages Function). A KEK in
Wrangler secrets means a rogue PR adding a `console.log` doesn't
exfiltrate every peer's HMAC key. The KEK itself rotates by
re-encrypting the column.

### Abuse, moderation, and takedowns

Federation + community publishing is a content-distribution system.
Without a moderation story it will eventually be used for things
nobody wants distributed.

- Every well-known doc carries an `abuse_contact` email. Required
  field; deployments without one do not federate.
- Per-publisher rate limit on publish actions (Phase 3) — a stolen
  account can't dump 10,000 datasets in an hour.
- Per-peer rate limit on federation reads — a hostile subscriber
  can't scrape the catalog for free indefinitely.
- The operator UI in the publisher portal exposes:
  - "Block peer" (status → blocked, purge `federated_datasets`).
  - "Retract dataset" (soft delete, tombstone propagates).
  - "Suspend publisher" (sessions invalidated, drafts kept).
  - "Audit recent activity" (filter `audit_events`).
- Phase 6 community publishing requires a written content policy
  and a moderation queue: drafts from non-staff publishers land
  in `status='pending'` and a staff member approves before the
  row becomes federation-visible.
- DMCA-style takedowns: an operator-facing form that records the
  notice, retracts the dataset, and writes an audit row; the
  retraction propagates through normal federation tombstones. The
  abuse_contact endpoint is the inbound channel.

### What this section deliberately does not solve

- **Sybil resistance among peers.** A bad actor can spin up 10
  nodes, subscribe to each other, and create a federation echo
  chamber. We rely on operator vetting at handshake-approval
  time.
- **End-to-end encryption.** Restricted assets are accessible to
  Cloudflare and to the operator's ops team. Anyone whose threat
  model excludes the platform needs a different system.
- **Provable deletion.** "Retract" propagates via tombstones, but
  a hostile peer can refuse to evict its cache. Detection is
  possible (re-fetch and confirm the row is gone); enforcement is
  not.

---

## Cloud-portability layer

Cloudflare is the target for v1. The plan stays portable by routing
every cloud-specific call through a small interface and supplying a
Cloudflare implementation as the v1 default. Other clouds get
implementations later; the API and data shapes don't change.

Code lives in `functions/api/v1/_lib/`:

```
_lib/
  storage/
    objectStore.ts        // interface
    r2.ts                 // Cloudflare implementation
    s3.ts                 // (future) AWS / MinIO / B2
    gcs.ts                // (future) GCP
  catalog/
    catalogStore.ts       // interface (D1 read/write)
    d1.ts                 // Cloudflare implementation
    postgres.ts           // (future) Supabase / RDS / self-hosted
  kv/
    kvStore.ts            // interface
    cf-kv.ts              // Cloudflare KV
    redis.ts              // (future)
  video/
    videoService.ts       // interface (upload, transcode, sign URL)
    cf-stream.ts          // Cloudflare Stream
    mux.ts                // (future)
    aws-mediaconvert.ts   // (future)
  auth/
    authProvider.ts       // interface (who is calling?)
    cf-access.ts          // Cloudflare Access
    oidc.ts               // (future, Phase 3)
  queue/
    jobQueue.ts           // interface
    cf-queues.ts          // Cloudflare Queues
    sqs.ts                // (future)
```

The interfaces are intentionally narrow. `objectStore` is roughly
`get / put / presignGet / presignPut / delete / list`. `videoService`
is `requestUpload / pollStatus / signPlayback / getDownloadUrl`. The
route handlers depend only on the interfaces, never on the concrete
binding.

### What stays Cloudflare-specific

- The `wrangler.toml` and Pages Functions runtime entry points.
- `event.platform.env` binding lookups (these live only in
  `functions/api/v1/_route.ts` thin wrappers that build the
  interface implementations and hand them to the handlers).
- The well-known JSON's `endpoints.*` paths.

### What is portable

- All SQL (D1 is SQLite-compatible; Postgres dialect mapping is
  small and there is one prior art project per major dialect).
- All HTTP route logic.
- The federation protocol (signed JSON over HTTP — runtime-agnostic).
- The wire `Dataset` shape, `tour/json`, the `/.well-known` document.
- The frontend (no Cloudflare assumptions in client code beyond
  same-origin routes; the desktop app already proxies these).

### Reference deploy targets to keep in mind

| Target | Catalog | Object | Video | KV | Auth |
|---|---|---|---|---|---|
| Cloudflare (v1) | D1 | R2 | Stream | KV | Access |
| AWS | RDS Postgres | S3 | MediaConvert + S3 + CloudFront | DynamoDB | Cognito / SAML |
| GCP | Cloud SQL | GCS | Transcoder API + GCS | Memorystore | IAP |
| Self-hosted | Postgres | MinIO | self-hosted ffmpeg + nginx-rtmp | Redis | Keycloak / OIDC |

The plan does not commit to building any of these. It commits to
not painting the codebase into a Cloudflare-only corner.

### Things that won't survive a port and what to do about them

- **Workers Analytics Engine** has no obvious peer on AWS/GCP.
  Analytics already has a Phase 2 path to R2 / Iceberg in
  `ANALYTICS_IMPLEMENTATION_PLAN.md`; portable analytics inherits
  that work.
- **Cloudflare Stream** is uniquely cheap and uniquely simple. On
  AWS, replacing it is real work (MediaConvert + S3 + signed
  CloudFront + a transcode-orchestration Lambda). The
  `videoService` interface is small enough that the port is
  bounded; the operator just signs up for a longer infra setup.
- **Durable Objects** are special. The plan only uses them in
  Phase 4+ and only for federation coordination; non-CF deploys
  can use a single coordinator process with a Postgres advisory
  lock instead.

---

## Free-tier viability

The plan as written assumes a few Cloudflare services that are not
on the free plan, and several that are free-but-tight. A
self-hoster on the free plan can take Phase 1 all the way to
production without paying anything; later phases force a paid
tier in specific, predictable places. This section spells out
exactly where the cliffs are so the choice is informed.

### What is not free at all

| Service | Free? | Plan uses it for | Minimum cost |
|---|---|---|---|
| **Cloudflare Stream** | No. **No free tier, no trial, no sandbox.** | Vimeo replacement (Phase 2). | $5 / 1000 min stored, billed up in 1000-min increments + $1 / 1000 min delivered. Storing 1 minute = $5/mo. |
| **Cloudflare Images** | No. | Image variants (Phase 2 optional). | $5/mo minimum. Skippable — encode variants at upload to R2 instead. |
| **Queues** | No — requires Workers Paid. | Federation sync, transcode polling (Phase 4). | Bundled in Workers Paid ($5/mo). |
| **Durable Objects** | No — requires Workers Paid. | Per-peer sync coordinator (Phase 4 nice-to-have). | Bundled in Workers Paid ($5/mo). |
| **Workers Paid plan** | No (it is the paid plan). | Prerequisite for Queues / DOs / Stream and raises every quota below. | $5/mo. |

### Free-tier limits to watch

| Service | Free quota | Concern |
|---|---|---|
| **Pages Functions** | 100k requests/day | The catalog API is the hot path. Without KV-snapshot caching, every browse-page load pierces this within the day. With KV caching, a small deployment fits comfortably. |
| **D1** | 5M row reads/day, 100k writes/day, 5 GB | A single `SELECT * FROM datasets WHERE visibility='public'` returning 600 rows costs 600 reads. KV snapshot caching is **not optional** if you want to stay free — it is how the math works. |
| **R2** | 10 GB storage, 1M Class A ops/mo (writes), 10M Class B ops/mo (reads), **zero egress** | Generous for metadata, thumbnails, sphere-thumbs, tour JSON, captions. Tight for video originals — one 4K video is several GB. The zero-egress rule is the unique-to-CF win and the reason the plan keeps `r2-hls:` as a first-class `data_ref`. |
| **KV** | 100k reads/day, 1k writes/day, 1k deletes/day, 1 GB, 25 MB / value | Plenty for the catalog snapshot pattern (one read per request, one write per publish). The 1k writes/day is the trap — never cache something that changes on every request. |
| **Workers AI** | ~10k neurons/day | Already shared with Orbit chat. Adding ML enrichment to publish flow (auto-keywords, abstract summarisation) competes with the docent's budget. Measure before adding. |
| **Cloudflare Access** | First 50 seats free, then $3/seat/mo | Fine for staff publishing in Phase 3. Phase 6 community publishers should arrive via OIDC instead, not as Access seats. |
| **Analytics Engine** | 10M datapoints/mo write | Already in use for telemetry. New catalog/publisher events add to the same bucket — verify there is room. |
| **Vectorize** (semantic search, optional) | 30M queried dims/mo, 5M stored | Comfortable for ~600 datasets with 768-dim embeddings. |
| **Cron Triggers** | 3 per Worker on free, more on paid | Phase 4 federation can run on cron alone (one trigger iterating peers). Beyond ~20 peers a per-peer cron stops fitting. |

### The Stream gotcha, specifically

Stream is the single largest cost surprise in the plan and warrants
its own callout:

- No free tier. No trial. No sandbox. Pricing the moment a video
  exists.
- Storage is billed in 1000-minute increments rounded up — storing
  *one minute* is $5/mo, storing *1001 minutes* is $10/mo.
- Delivery is $1 per 1000 minutes streamed; small-audience
  deployments pay pennies, public-traffic deployments can climb.
- Workers Paid ($5/mo) is a prerequisite for enabling Stream at all.
- **Realistic minimum entry cost: ~$10/mo** ($5 Workers Paid +
  $5 Stream) regardless of how little video is involved.

For the SOS catalog (~600 datasets averaging ~5 min each = ~3000
min), storage runs ~$15/mo before any delivery — modest, but
non-zero.

#### Testing without paying for Stream

The plan was already designed so the entire catalog / manifest /
federation pipeline can be validated without ever provisioning
Stream:

1. **Stay on `vimeo:` refs through Phase 2.** The cutover bridge
   is exactly this case — keep the existing Vimeo proxy as the
   asset backend while D1, the manifest endpoint, federation, and
   the publisher portal land. Stream becomes a *later* asset-host
   choice, not a Phase 2 prerequisite.
2. **Self-host HLS in R2.** Encode locally with ffmpeg, upload the
   `.m3u8` + `.ts` segments to R2, register the asset as
   `r2-hls:<key>`. Free up to 10 GB. Doubles as the "beyond 4K"
   path the plan already requires.
3. **Use a third-party trial as a `data_ref` scheme.** Mux's free
   tier (100 hours encoding / 100 GB streaming for new accounts),
   Bunny Stream's startup credits, etc. — fit behind the same
   `videoService` interface in the portability section. Useful for
   side-by-side cost comparison.
4. **One-month one-video integration test.** When the integration
   itself needs validating (signed playback, HDR rendition
   selection, packed-alpha pipeline), provision Stream for one
   month with one representative video. ~$10 total.

The data model already namespaces `data_ref` schemes
(`vimeo:` / `r2-hls:` / `stream:` / `tiles:` / `url:`) so a node
can mix backends per-dataset. There is no "Stream cutover" gate; a
node can serve a permanent mix.

### Phase-by-phase cost reality

| Phase | Free-tier viable? | What forces a paid step |
|---|---|---|
| **1 — Catalog backbone** | Yes, fully. | Nothing. D1 + KV + Pages Functions all sit inside free quotas with KV-snapshot caching. |
| **2 — Asset hosting** | Conditional. R2 free up to 10 GB. **Stream costs from minute one.** Cloudflare Images costs from minute one (skippable). | Stream usage. Mitigation: keep `vimeo:` refs and add `r2-hls:` for any new uploads — Stream becomes opt-in per dataset. |
| **3 — Publisher portal** | Yes. | Nothing — Access is free for the first 50 seats, which covers staff publishing comfortably. |
| **4 — Federation** | Yes with caveat. | Queues + DOs both require Workers Paid ($5/mo). **Workaround:** pull-only federation via a Cron Trigger iterating peers, with cursor in KV. Works for ≤ ~20 peers; revisit when peer count outgrows it. |
| **5 — Per-dataset auth** | Yes. | Nothing extra. Signed URLs are a feature of services already in use (Stream / R2). |
| **6 — Community publishing & portability** | Conditional. | Access seats become a real cost beyond 50 users. Mitigation: bring-your-own OIDC (self-hosted Keycloak, Clerk's free tier, Auth0's free tier). |

### Practical recommendations

1. **Pay the $5/mo for Workers Paid the day Phase 1 ships, even
   though Phase 1 doesn't strictly need it.** The free Pages
   Functions limit (100k req/day) is the first quota that bites,
   and Workers Paid also raises D1 row-read limits, KV write
   limits, and unlocks Queues / DOs / Stream for later phases. $5
   is cheaper than the engineering cost of designing around
   every free-tier wall.

2. **Defer Stream as long as possible.** The plan's `vimeo:`
   `data_ref` cutover bridge is specifically designed so a node
   can validate the entire backend without provisioning Stream.
   A self-hosted reference deployment can ride the existing
   Vimeo proxy indefinitely and still be a fully-functional
   federation peer — Stream is an asset-host choice, not a
   protocol requirement.

3. **Skip Cloudflare Images unless HDR variants are essential.**
   The image-variants pipeline can run entirely on R2 by
   encoding the variants at upload time (ffmpeg / sharp in a CI
   job, or a one-off Worker action) instead of resizing on
   demand. Cloudflare Images is convenience, not necessity.

4. **Federation cron-only path until peer count justifies
   Queues.** A single Cron Trigger every 15 minutes that loops
   `federation_peers` and does a sync per peer fits inside free
   Workers up to roughly 20 peers (each peer's sync needs to
   complete inside the Cron CPU budget). Promote to Queues when
   the cron run starts overrunning.

5. **R2 storage triage.** Reserve R2 for metadata, sphere-thumbs,
   flat thumbnails, legends, captions, tour JSON, and the
   delivery tier of image datasets. *Original*-quality video
   does not have to live in R2 if it lives in Stream (or a
   third-party host). With this discipline the 10 GB free tier
   is comfortable for hundreds of datasets.

6. **Watch the D1 row-read budget like a hawk.** A misconfigured
   route that reads `datasets` on every request will burn 5M/day
   well before users notice anything is wrong. The KV snapshot
   pattern (one D1 read per publish, then served from KV until
   invalidated) is the load-bearing assumption. Add a Grafana
   panel for `d1_reads_per_minute` early; do not wait for the
   bill.

7. **Don't run Workers AI for catalog enrichment.** Auto-keywords
   and abstract summarisation are tempting but eat into Orbit's
   ~10k neurons/day. If publisher-side ML helpers add real
   value, gate them behind an explicit "Enhance with AI" button
   so the cost is per-publish, not per-request.

8. **Treat the `$10/mo Stream test` as a budgeted experiment, not
   ongoing infrastructure.** Provision Stream for one month with
   a single representative video to validate signed playback,
   HDR rendition selection, and the packed-alpha pipeline; then
   turn it off until there is a dataset that justifies it
   permanently. The data model accommodates the on/off pattern.

The cumulative result: **a self-hosted Terraviz node can run
Phases 1, 3, 4, 5 entirely on Workers Paid ($5/mo) with no
Stream, no Cloudflare Images, and no Access seats over 50.**
Phase 2 is where money starts mattering, and only when the node
has its own video assets to host.

---

## Local development

The plan is unbuildable without an answer to "how do I run the
catalog backend on my laptop." Cloudflare Pages Functions, D1,
KV, R2, Stream, and Queues all have local-emulation stories of
varying maturity; the plan picks one path and commits to it.

### Stack

- **Wrangler** (`wrangler pages dev`) is the runner. It loads the
  Pages config, spins up a local Miniflare instance, and serves
  Functions at `localhost:8788`.
- **D1 local mode** (`wrangler d1 ... --local`) gives a real
  SQLite file under `.wrangler/`. The same migration files apply
  to local and remote.
- **KV local** is in-memory in Miniflare; ephemeral by design,
  fine for development.
- **R2 local** is on-disk under `.wrangler/`; persists across
  restarts.
- **Stream** has no local emulation. Local dev uses a static
  `.m3u8` served from R2 (or `public/`) and a `MOCK_STREAM=true`
  flag that makes the manifest endpoint return a fixed URL
  instead of a Stream signed playback URL.
- **Queues** also has no production-quality local emulation; the
  job-queue interface ships an `InMemoryJobQueue` for dev that
  runs jobs synchronously in the same Worker. Federation sync
  in dev is a manual `npm run sync-peers` invocation rather
  than a scheduled cron.
- **Workers AI** in dev: the Cloudflare AI binding works against
  the production endpoint with a free quota; tests stub it.

### Repo layout for the new code

```
functions/api/v1/
  catalog.ts
  datasets/[id].ts
  datasets/[id]/manifest.ts
  federation/...
  publish/...
  _lib/                          # the portability interfaces
  _routes/                       # thin wrappers binding env to handlers

migrations/
  catalog/
    0001_init.sql
    0002_renditions.sql
    ...

scripts/
  seed-catalog.ts                # imports SOS catalog → local D1
  generate-fixtures.ts           # canned dataset rows for tests
  sync-peers.ts                  # manual federation pull (dev only)
  rotate-peer-secret.ts          # ops helper

src/services/
  ...                            # frontend-only, unchanged
```

### Contributor entry points

```bash
npm run dev:backend     # wrangler pages dev with all local bindings
npm run dev             # vite dev server (existing) — proxies /api/* to :8788
npm run db:migrate      # wrangler d1 migrations apply terraviz --local
npm run db:seed         # node scripts/seed-catalog.ts (writes to local D1)
npm run db:reset        # rm .wrangler/state/v3/d1/* && db:migrate && db:seed
npm run test            # vitest run (existing, plus new backend tests)
npm run test:federation # contract tests — spins up two Wranglers, peers them
```

The frontend dev workflow stays as it is today (`npm run dev` →
Vite dev server). Vite proxies `/api/*` to the local Wrangler at
`:8788` via a `vite.config.ts` proxy entry; production resolves
the same paths to Pages Functions on the same origin. The desktop
app uses `localhost:8788` during dev and the deployed origin in
production.

### Seed data

`scripts/seed-catalog.ts` is the same importer described in the
data model section, restricted to a configurable subset (default:
20 representative datasets across video, image, and tour types).
Subset keeps `db:seed` fast and avoids hammering the public S3 in
CI. A `--full` flag pulls the entire ~600-item catalog when a
contributor needs realistic load.

`scripts/generate-fixtures.ts` produces deterministic test data:
fixed ULIDs, fixed timestamps, fixed signatures. Used by federation
contract tests and unit tests.

### Testing strategy

- **Unit** — Vitest, colocated `*.test.ts`. Pure logic
  (canonicalization, signature verification, manifest assembly,
  visibility resolution).
- **Integration** — Vitest with Miniflare. A handler is invoked
  with a real local D1, real local KV, real local R2; assertions
  check both the response and the side effects in storage.
- **Contract (federation)** — `npm run test:federation` boots two
  Miniflare instances on different ports, runs a handshake, runs
  a sync, asserts that catalog state on the subscriber matches a
  golden snapshot. This is the test that catches protocol
  regressions across versions.
- **End-to-end** — Playwright against the running stack: publish a
  dataset, browse the catalog, load the dataset on the globe.
  Only for high-value flows; not a replacement for integration
  tests.
- **Load** — `k6` script targeting the local `/api/v1/catalog`
  with a seeded ~600-dataset DB; verifies p95 latency budget
  before merging changes that touch the hot path.

### CI/CD

- **Per-PR.** Lint, type-check, unit + integration, build the
  frontend bundle, run migrations against an ephemeral local D1
  to catch SQL errors. Federation contract test runs on PRs that
  touch `functions/api/v1/federation/**`.
- **Preview deploys.** Pages already creates a preview URL per
  PR. Migrations applied to a preview D1 (per-branch DB) so a
  schema change can be exercised against real Cloudflare runtime
  before merge.
- **Production.** On merge to `main`, migrations apply to the
  production D1 *before* the new Pages build is promoted, so a
  rollback can revert the bundle without leaving D1 mid-migration.
  Migrations are forward-only; rollbacks are forward-fix migrations.

### Conventions

- One commit per migration, with the migration file in the same
  commit as the code that depends on it.
- `schema_version` bumps in a separate commit so its diff is the
  one place to audit shape changes.
- Federation protocol changes go through a separate `protocol/`
  changelog file (in addition to git history) so peer operators
  can subscribe to it.

---

## Phasing

Each phase ships independently and leaves the app in a working
state. Federation does not block on the publisher portal; the
publisher portal does not block on Stream cutover. The order
below is the recommended sequence, not a dependency chain.

Phase 1 is split into **1a** and **1b**. The split is internal to
implementation cadence — both halves ship together as the Phase 1
milestone — but 1a is independently demoable, so it functions as
an early checkpoint if the Stream / asset-upload work in 1b hits
a surprise. The "Phase 2" number is intentionally retired: the
work formerly tracked as Phase 2 (asset hosting) is now Phase 1b.
Existing "Phase 2" references throughout the docs continue to
refer to that same body of work, sequenced earlier. Phase 3
onward is unchanged.

### Phase 1a — Catalog backbone + minimal publisher API

**Replaces:** S3 metadata bucket fetch.
**Enables:** scheduled metadata-only CLI publishing — update,
retract, re-tag, re-link to existing assets — for partner
workflows (e.g., Zyra pipelines that maintain catalog metadata
against externally-hosted assets).

- D1 migration with the core schema (`node_identity`, `datasets`,
  decoration tables, `tours`, `publishers`, `audit_events`).
- `functions/api/v1/catalog.ts` and `/datasets/{id}.ts` reading
  from D1, writing through KV snapshot.
- `functions/api/v1/datasets/{id}/manifest.ts` that resolves
  `vimeo:` and `url:` `data_ref` schemes (no Stream yet).
- Publisher API surface (metadata-only):
  `POST /api/v1/publish/datasets`, `PATCH .../{id}`,
  `POST .../{id}/publish`, `POST .../{id}/retract`,
  `GET .../{id}` (own draft).
- Cloudflare Access protects `/api/v1/publish/**`; Access
  service-token flow validated for non-browser callers; JIT
  `publishers` row provisioning on first call.
- Validation rules from
  [`CATALOG_PUBLISHING_TOOLS.md`](CATALOG_PUBLISHING_TOOLS.md)
  enforced server-side; 400 error envelope formalized.
- Audit-log writes for publish / edit / retract.
- CLI (`terraviz` binary) shipping with metadata-only commands:
  `publish`, `update`, `retract`, `list`, `get`. Reads YAML or
  JSON; service-token auth for scheduled jobs.
- Seed importer reimplemented as `terraviz publish --bulk`
  against the new API (replaces the standalone
  `scripts/seed-catalog.ts`).
- Frontend `dataService.ts` reads from `/api/v1/catalog` behind
  a build flag (`VITE_CATALOG_SOURCE=node|legacy`).
- `/.well-known/terraviz.json` published.
- Self-hosting doc updated with the new D1 / R2 / Access binding
  setup.

**Exit criteria:** the public deployment serves its catalog from
D1, rendering identically to today; `terraviz publish` updates
catalog metadata against the production node from a scheduled
job; offline desktop app still works via the legacy URL behind
the build flag.

### Phase 1b — Asset hosting + CLI uploads

**Replaces:** Vimeo proxy and the manual image-resolution suffix
pattern. (This is the work formerly tracked as Phase 2.)
**Enables:** scheduled end-to-end CLI publishing of new assets —
the "Zyra pipeline produces a visualization → CLI uploads →
catalog publishes" pattern works without human intervention.

- R2 bucket (`terraviz-assets`) created, presigned PUT/GET wired.
- Stream binding added; manifest endpoint resolves `stream:` refs.
- Asset-complete handler with `content_digest` verification (see
  "Asset integrity & verification" in
  [`CATALOG_ASSETS_PIPELINE.md`](CATALOG_ASSETS_PIPELINE.md)).
- Backfill job that pulls each Vimeo source into Stream and flips
  `data_ref` from `vimeo:` to `stream:`. Runs as a Queue
  consumer; idempotent.
- Image pipeline: optional Cloudflare Images, falls back to R2.
- Sphere-thumbnail generation pipeline.
- Manifest endpoint returns the new variants shape with
  per-rendition `content_digest` claims.
- Frontend `hlsService.ts` and `datasetLoader.ts` read manifests
  from `/api/v1/datasets/{id}/manifest`.
- Tauri `download_manager.rs` consumes the new `download_url`
  field with optional digest verification.
- CLI gains asset-upload commands: `terraviz publish` against a
  YAML that references a local file uploads the asset (R2 or
  Stream as appropriate), polls for transcode/processing
  completion, computes and confirms the content digest, then
  submits the publish request.

**Exit criteria:** Vimeo proxy can be turned off without
breaking the public deployment; desktop downloads continue to
function; a Zyra-style scheduled pipeline can run
`terraviz publish dataset.yaml`, upload a new visualization,
and have it appear in the public catalog without human
intervention.

### Phase 2 — *Retired number*

Originally Phase 2 covered asset hosting (Stream, R2, image
pipeline, manifest, backfill). That work is now Phase 1b. The
number is intentionally retired so existing in-tree references
to "Phase 2" continue to read correctly — they refer to the same
body of work, sequenced earlier.

### Phase 3 — Publisher portal (staff)

**Adds:** a UI for the publisher API that Phases 1a/1b already
exposed.

- Cloudflare Access policy on `/publish/**` extends the API-only
  policy from Phase 1a to cover the browser flow.
- Dataset entry page (form + asset uploader + preview), bound to
  the existing publisher API.
- Tour creator (capture mode + reorder + preview).
- Bulk import CSV/JSON for migrating existing collections (the
  same import the CLI already handles, with a UI for
  non-technical publishers).
- Audit log surfaced as a per-dataset history view.
- Webhook fan-out scaffolding (no peers yet, but the queue is in
  place).

**Exit criteria:** a staff user can publish a new dataset and a
new tour end-to-end through the browser without touching the CLI
or D1 / R2 manually.

### Phase 4 — Federation

**Adds:** discovery, subscription, and merged catalog.

- `/.well-known/terraviz.json` upgraded to advertise federation.
- Handshake, feed, and webhook routes.
- `federated_datasets` / `federated_tours` mirror tables.
- Cron-driven sync (15-min default) with per-peer cursor.
- Browse UI shows merged catalog with origin badges and a peer
  filter chip.
- Tour engine resolves `peer:` dataset references via the federated
  cache.
- Operator UI in the publisher portal: list peers, approve, pause,
  block, view sync status.

**Exit criteria:** two Terraviz instances, set up independently,
can subscribe to each other and render each other's datasets
without copying assets.

### Phase 5 — Per-dataset authorization

**Adds:** restricted/private visibility and grants.

- `dataset_grants` table active.
- Manifest endpoint enforces grants and issues short-lived signed
  URLs for restricted assets.
- Federation feed filters by per-peer grants.
- Tombstone-on-revocation logic in the sync route.
- Hard-revoke button (rotate Stream keys + per-peer secret).
- Publisher portal grants UI.

**Exit criteria:** a publisher can mark a dataset restricted, grant
peer X, observe the dataset appear on peer X only, revoke, observe
it disappear.

### Phase 6 — Community publishing & portability

**Adds:** OIDC publisher accounts and the cloud-abstraction layer.

- OIDC provider integration for non-Access publishers.
- Role-based moderation queue (community drafts → staff approval).
- Storage interfaces extracted to `_lib/`.
- One non-Cloudflare reference deploy documented (likely
  Postgres + S3 + Mux on AWS) to prove the abstractions hold.

### Indicative scope (rough order of magnitude)

| Phase | Scope | Risk |
|---|---|---|
| 1a | ~10 read routes + ~6 publisher routes, 1 D1 migration, Access service-token auth, CLI metadata commands, frontend swap | Low-medium — read paths well-understood; service-token auth is new |
| 1b | Stream binding, R2 presigned uploads, image variants, sphere thumbnails, manifest with integrity, Vimeo backfill, CLI asset upload | Medium — Stream is new; backfill bandwidth costs need a budget |
| 3 | Publisher portal UI on top of an already-working API | Low-medium — long form work, but the API contract is fixed before this phase starts |
| 4 | Federation protocol + sync + UI | Medium-high — protocol design has compounding consequences |
| 5 | Grants, signed URLs, revocation | Medium — security-sensitive; needs review |
| 6 | OIDC + portability | Low-medium — mostly mechanical once the interfaces exist |

These are deliberately not week counts. Sizing happens when a phase
becomes a tracking issue.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Stream costs scale with catalog size in ways Vimeo's static link did not. | Phase 2 backfill estimates total minutes before commit; budget review gates the cutover. Public deployment can keep `vimeo:` refs as long as needed. See "Free-tier viability." |
| Self-hoster on the free plan hits an unexpected paywall partway through implementation. | The "Free-tier viability" section enumerates every paid-only service and quota the plan touches, with mitigations per phase. Phase 1 is fully free; later phases force Workers Paid ($5/mo) at known points. |
| D1 catalog query latency at full SOS scale (~600 datasets) | Hot path served from KV snapshot; D1 only on cache miss. KV invalidation on publish. Benchmarked in Phase 1 with the seeded catalog. |
| Federation cursor drift between peers running different versions | `schema_version` field on every payload; subscribers refuse unknown versions; well-known doc advertises supported range. |
| A pending peer DOS-es the handshake endpoint | Bootstrap secret is one-time and short-lived; per-IP rate limit on handshake; pending state doesn't grant feed access. |
| Restricted-asset signed URLs leak via referrer or browser caching | `Cache-Control: private, no-store` on manifest responses; Stream/R2 URLs themselves are short-lived. |
| Schema migration across 100s of deployed nodes | All migrations are additive in v1. Breaking changes ship at `/api/v2/`; v1 endpoints stay live during overlap. |
| Tauri offline cache becomes stale relative to the live catalog | Existing download manager already tracks per-dataset state; the new manifest's `updated_at` field lets the desktop app surface "newer version available" cues. |
| Publisher portal is a security boundary; getting it wrong leaks restricted data | Access enforces the staff perimeter; in Phase 6, OIDC adds a community perimeter with explicit moderation. Audit log is mandatory, not optional. |

---

## Open questions

These need answers before Phase 1 starts coding. Items resolved
in the course of writing this plan have been removed; the git
history under `docs/CATALOG_*` captures the resolutions for
anyone who wants to see the path the decisions took.

1. **Where does Orbit (the LLM docent) sit relative to
   federated catalogs?** The system prompt builder currently
   assumes a flat catalog; including federated items expands the
   prompt. Cap by relevance, rotate per turn, or expose a
   per-peer "include in docent" toggle?
2. **Out-of-Stream encoding host.** Beyond-4K HLS and
   packed-alpha variants need an encoder Stream won't run for
   us. Options: GitHub Actions ffmpeg job, a long-running
   self-hosted runner, or a separate Worker calling out to a
   transcoding API (Mux / Coconut / Bitmovin). The data model is
   the same in every case; the operator burden differs a lot.
3. **Default codec ladder per dataset.** Always emit
   H.264 + HEVC + AV1, or only H.264 by default and let the
   publisher opt into the heavier codecs? Storage cost vs.
   playback quality tradeoff; needs a number from a few
   representative datasets before deciding.
4. **Layer compositor scope.** Transparent video makes single-
   globe layering feasible, but the multi-globe layout already
   solves "compare two datasets." Is layered compositing a
   *replacement* for multi-globe (one globe, N stacked layers)
   or an *additional* mode (still N globes, but each can stack)?
   The renderer change is simpler if it's the latter.

---

## What this plan does not commit to

- Any timeline.
- A specific peer onboarding order. The first two peers should be
  internal so the protocol gets battle-tested before external
  partners.
- Whether a federated catalog should be visible to anonymous
  visitors of the receiving node, or only to authenticated ones.
  Default in this draft is "yes, anonymous can see federated
  public datasets," because hiding them defeats the point. Open
  for debate.
- Whether to ship `/api/v2/` or amend `/api/v1/` for the first
  schema break. Default: fresh prefix, but the call is held until
  the break is concrete.

---

## References

- `src/services/dataService.ts` — current catalog fetch + merge
- `src/services/hlsService.ts` — HLS player wrapper
- `src/services/datasetLoader.ts` — dataset → globe loader
- `src/services/tourEngine.ts` — tour playback
- `src/types/index.ts` — `Dataset`, `EnrichedMetadata`, `TourTaskDef`
- `functions/api/ingest.ts` — Pages Function pattern + Analytics Engine binding
- `docs/SELF_HOSTING.md` — current Cloudflare bindings setup
- `docs/ANALYTICS_IMPLEMENTATION_PLAN.md` — prior art for a multi-phase backend plan in this codebase
- `docs/TOURS_IMPLEMENTATION_PLAN.md` — tour engine design

