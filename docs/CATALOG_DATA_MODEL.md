# Catalog Data Model

D1 schema reference for the catalog backend. Companion to
[`CATALOG_BACKEND_PLAN.md`](CATALOG_BACKEND_PLAN.md).

The schema below is the Phase-1 floor. Everything else in the plan
either reads from these tables or adds rows to them.

## Conventions

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

## Core tables

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

  -- Asset integrity. Multi-hash format ("sha256:<hex>"); null for
  -- legacy `vimeo:` and `url:` refs until backfilled. See
  -- "Asset integrity & verification" in CATALOG_ASSETS_PIPELINE.md.
  content_digest     TEXT,                    -- digest of the delivered asset (master HLS playlist for video, file bytes for image, canonical JSON for tour)
  source_digest      TEXT,                    -- pre-transcode source hash; for Stream-backed video, otherwise == content_digest
  auxiliary_digests  TEXT,                    -- JSON: { "thumbnail": "sha256:<hex>", "sphere_thumbnail": "sha256:<hex>", "legend": "sha256:<hex>", "caption": "sha256:<hex>" }

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
  -- "Beyond 4K, HDR, and transparency" in CATALOG_ASSETS_PIPELINE.md.
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

  -- Docent search index tracking (Phase 1b). Null until the
  -- embedding pipeline has run for this row. Updated by the
  -- queue consumer after a successful upsert to Vectorize. See
  -- "Docent integration" in CATALOG_BACKEND_PLAN.md.
  embedding_version  INTEGER,                 -- model version (1 = bge-base-en-v1.5, 768-dim)

  schema_version     INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,

  -- Review-queue lifecycle (Phase 6 only; all NULL in Phase 3).
  -- See "Review queue" in CATALOG_PUBLISHING_TOOLS.md.
  submitted_at       TEXT,                    -- stamped when a community publisher submits a draft for review
  approved_at        TEXT,                    -- stamped by reviewer; clears submitted_at on publish
  rejected_at        TEXT,                    -- stamped by reviewer; resets to draft state and clears submitted_at
  rejected_reason    TEXT,                    -- reviewer's free-text rejection reason

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
  content_digest TEXT,                         -- "sha256:<hex>" of the rendition's master playlist or asset; computed at first manifest serve and cached. See CATALOG_ASSETS_PIPELINE.md "Asset integrity & verification".
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

## Federation tables

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
                                              -- Catalog-side: which of the peer's datasets we mirror metadata for.
  asset_proxy_policy TEXT NOT NULL DEFAULT 'proxy_cached',
                                              -- metadata_only | proxy_lazy | proxy_cached | mirror_eager
                                              -- Asset-side: how desktop downloads of this peer's content are served.
                                              -- See "Offline (Tauri) compatibility" → "Federated datasets" in CATALOG_ASSETS_PIPELINE.md.
  include_in_docent  INTEGER NOT NULL DEFAULT 0,
                                              -- 0 = peer's datasets excluded from docent search results;
                                              -- 1 = included. Default off — operators must explicitly opt in.
                                              -- See "Docent integration" in CATALOG_BACKEND_PLAN.md.
  sync_interval_minutes INTEGER NOT NULL DEFAULT 15,
                                              -- subscriber-controlled pull cadence; see "Sync protocol" in CATALOG_FEDERATION_PROTOCOL.md
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
  webhook_url        TEXT,                    -- optional; if set, publisher POSTs nudge events here for this subscriber to pull on. Registered at handshake time.
  approved_at        TEXT,
  created_at         TEXT NOT NULL
);
```

## Publishing & access tables

```sql
-- Institutional groupings. Nullable on publishers in Phase 3
-- (single-org deploy, equivalent to "every Access user is admin");
-- populated from Phase 6 onward when community publishers from
-- multiple institutions can coexist. The require_review flag is
-- the per-org gate for the review-queue workflow described in
-- CATALOG_PUBLISHING_TOOLS.md.
CREATE TABLE orgs (
  id               TEXT PRIMARY KEY,           -- ULID
  name             TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  require_review   INTEGER NOT NULL DEFAULT 0, -- review-queue gate (Phase 6)
  created_at       TEXT NOT NULL
);

-- Publisher accounts. Identified by Cloudflare Access email in
-- Phase 3; (Phase 6) extend with an OIDC subject for community
-- publishers. is_admin is the gate for sensitive node-wide actions
-- (peer management, hard delete, node-wide audit log read).
-- See "Publisher identity & roles" in CATALOG_PUBLISHING_TOOLS.md.
CREATE TABLE publishers (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  affiliation     TEXT,
  org_id          TEXT,                       -- nullable in Phase 3; FK to orgs(id) from Phase 6
  role            TEXT NOT NULL,              -- staff | community | readonly
  is_admin        INTEGER NOT NULL DEFAULT 0, -- staff sub-role; first staff row on a fresh deploy is auto-promoted
  status          TEXT NOT NULL,              -- pending | active | suspended
  created_at      TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(id)
);

-- Per-dataset, per-peer share grants. Phase 5.
-- READ-side: a row here means grantee X is allowed to SEE dataset Y.
-- Distinct from dataset_collaborators (write-side) below.
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

-- Per-dataset write-side collaboration grants. Phase 6.
-- A row here means: publisher X may EDIT or REVIEW dataset Y.
-- Distinct from dataset_grants (read-side) above.
-- See "Cross-publisher collaboration" in CATALOG_PUBLISHING_TOOLS.md.
CREATE TABLE dataset_collaborators (
  dataset_id   TEXT NOT NULL,
  publisher_id TEXT NOT NULL,
  permission   TEXT NOT NULL,                 -- editor | reviewer
  invited_by   TEXT NOT NULL,                 -- publishers.id
  invited_at   TEXT NOT NULL,
  accepted_at  TEXT,                          -- null until invitee accepts
  revoked_at   TEXT,
  PRIMARY KEY (dataset_id, publisher_id),
  FOREIGN KEY (dataset_id)   REFERENCES datasets(id) ON DELETE CASCADE,
  FOREIGN KEY (publisher_id) REFERENCES publishers(id),
  FOREIGN KEY (invited_by)   REFERENCES publishers(id)
);

-- Review-queue comment thread per dataset. Append-only; comments
-- are not edited in place (mirrors audit_events). Phase 6.
CREATE TABLE dataset_review_comments (
  id           TEXT PRIMARY KEY,              -- ULID
  dataset_id   TEXT NOT NULL,
  reviewer_id  TEXT NOT NULL,                 -- publishers.id
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (dataset_id)  REFERENCES datasets(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewer_id) REFERENCES publishers(id)
);

CREATE INDEX idx_review_comments_dataset ON dataset_review_comments(dataset_id, created_at);

-- Append-only audit log. Every publish, retract, grant, revoke,
-- subscription accept, ingest webhook, and hard-delete lands here.
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

-- Permanent stub for hard-deleted datasets. Used for legal /
-- safety takedowns where the bytes need to be unreachable without
-- the 90-day retraction grace. The body of the dataset is
-- deliberately not retained — only ULID + who + when + why. The
-- corresponding audit_events row carries the cross-reference.
-- See "Retraction & deletion" in CATALOG_PUBLISHING_TOOLS.md.
CREATE TABLE deleted_datasets (
  id          TEXT PRIMARY KEY,               -- former datasets.id
  deleted_at  TEXT NOT NULL,
  deleted_by  TEXT NOT NULL,                  -- publishers.id
  reason      TEXT NOT NULL                   -- free text captured at deletion
);

-- Operator-curated cold-start list for the docent's
-- list_featured_datasets tool. The docent calls this when the
-- user has not yet expressed intent ("what should I look at?")
-- so it doesn't have a query for the vector index. Curation is
-- explicit — no algorithmic guessing, no popularity-from-analytics.
-- Phase 1b. See "Docent integration" in CATALOG_BACKEND_PLAN.md.
CREATE TABLE featured_datasets (
  dataset_id   TEXT PRIMARY KEY,
  position     INTEGER NOT NULL,              -- display order; lower = higher
  added_by     TEXT NOT NULL,                 -- publishers.id
  added_at     TEXT NOT NULL,
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE,
  FOREIGN KEY (added_by)   REFERENCES publishers(id)
);

CREATE INDEX idx_featured_datasets_position ON featured_datasets(position);
```

## Migration from the existing public catalog

A Phase-1 importer reads
`https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/dataset.json`
plus `public/assets/sos_dataset_metadata.json`, runs the same merge
that `dataService.ts` does today, and inserts every record as a
`datasets` row owned by the deploying node with `visibility='public'`.
Vimeo links are preserved verbatim in `data_ref` as `vimeo:<id>` and
resolved by the manifest endpoint (see
[`CATALOG_ASSETS_PIPELINE.md`](CATALOG_ASSETS_PIPELINE.md)), so
cutover doesn't require uploading anything to Stream on day one.

## Schema migration tooling

D1 ships its own migration runner; the question is how we wrap it
so a contributor can move forward and back safely, and so a
production rollout doesn't leave the schema in a half-applied
state.

### File layout

```
migrations/catalog/
  0001_init.sql                  -- node_identity, datasets (Phase-1 columns)
  0002_renditions.sql            -- dataset_renditions + indexes
  0003_federation.sql            -- federation_peers, federated_datasets, ...
  0004_publishers.sql            -- publishers, dataset_grants, audit_events
  0005_license_columns.sql       -- license_*, attribution_*, doi, citation_text
  0006_media_intrinsics.sql      -- width/height/color_space/.../alpha_encoding
  ...
```

Each migration is forward-only. Numeric prefix is monotonic and
gap-free; `wrangler d1 migrations apply` is the runner.

### Forward-only with paired down-migrations

D1 has no built-in down-migration story and the Cloudflare runtime
never runs them. The plan inverts the usual approach: every
backward-incompatible change ships as a *pair* of forward
migrations, with the old schema kept readable until consumers
migrate.

```
0010_add_thingy.sql              -- adds new column / table / index
0011_dual_write_thingy.sql       -- code starts dual-writing
... [N releases, code reads from new shape] ...
0023_drop_old_thingy.sql         -- removes legacy column / table
```

Rollbacks are *forward-fix migrations*, not reverts: if `0011`
breaks, you ship `0012_revert_thingy_dual_write.sql`. This
matches how every long-lived production database actually
handles schema change.

### CI gates

- **Per-PR.** A workflow spins up an ephemeral local D1, applies
  every migration in order, then applies the new migrations. Fails
  if any SQL is invalid or non-idempotent.
- **Schema diff.** A second workflow dumps the resulting schema
  and diffs against a checked-in `migrations/catalog/SCHEMA.sql`
  snapshot. Schema changes require updating the snapshot in the
  same PR — the diff is the review artefact.
- **Federation contract test** (in
  [`CATALOG_FEDERATION_PROTOCOL.md`](CATALOG_FEDERATION_PROTOCOL.md))
  runs the migrated schema against the previous protocol version
  to catch wire-shape regressions.

### Production rollout

Migrations apply to production D1 *before* the new Pages bundle
is promoted, so a bundle rollback can revert the code without
leaving D1 mid-migration. Concretely the deploy workflow is:

1. `wrangler d1 migrations apply terraviz` against production D1.
2. Pages bundle promotion (instant; serves new + old SQL).
3. (Verify.)
4. Subsequent migration that drops legacy columns, only after
   every running bundle has been the new one for > 24h.

The "old code reads new schema" invariant in step 2 is the
reason for the dual-write pattern in step 0010/0011 above.

## Dataset revisions

Reanalysis, model updates, and corrected datasets force a
question that a single `datasets` row can't answer: is this a new
dataset or version 2 of an existing one? Both choices have valid
use cases.

### Two revision modes

| Mode | Behaviour | When to use |
|---|---|---|
| **In-place edit** | `UPDATE datasets SET ... WHERE id = ?`. `updated_at` bumps; `published_at` unchanged. Subscribers re-fetch on next sync. | Typo fixes, abstract rewording, license corrections. |
| **Versioned revision** | New row with new `id`, same `lineage_id`, `revision_of` pointing at the previous row. Both rows visible until the older is retracted. | Reanalysis, methodology change, time-range extension, anything a citation should distinguish. |

The schema accommodates both:

```sql
ALTER TABLE datasets ADD COLUMN lineage_id   TEXT;  -- ULID, shared across revisions
ALTER TABLE datasets ADD COLUMN revision_of  TEXT;  -- previous datasets.id, nullable
ALTER TABLE datasets ADD COLUMN revision_num INTEGER NOT NULL DEFAULT 1;
ALTER TABLE datasets ADD COLUMN revision_note TEXT; -- short human-readable changelog
CREATE INDEX idx_datasets_lineage ON datasets(lineage_id, revision_num);
```

For an in-place edit, `lineage_id = id` and `revision_num = 1`
for the life of the row.

For a versioned revision, the publisher portal:
1. Clones the previous row (new ULID), copies fields.
2. Sets `lineage_id` to the previous row's `lineage_id`,
   `revision_of` to the previous row's `id`, increments
   `revision_num`.
3. Lets the publisher edit and re-upload assets.
4. On publish, optionally retracts the previous revision (the
   default for time-series data, opt-out for cases where past
   versions stay citable).

### Federation behaviour

- Subscribers receive each revision as its own dataset (different
  `id`). `lineage_id` and `revision_of` come along in the
  payload.
- Browse UI groups by `lineage_id` and shows only the latest
  non-retracted revision by default; an "older revisions" expander
  shows the rest.
- Tours pin to a specific `id`; if that `id` is retracted, the
  tour either upgrades to the latest revision (default) or refuses
  to play (opt-in stricter mode).
- The audit log records every clone-for-revision, so an external
  citation pointing at a retracted revision is still traceable.

### Citation implications

Versioned revisions are the right substrate for DOIs (next
section): each revision can carry its own DOI without conflating
"the dataset" with "the dataset as it existed in March 2026."

## Persistent identifiers

Local ULIDs are stable within a node but lose meaning if the
node moves, rebrands, or dies. Real scientific use needs
identifiers that survive infrastructure changes.

### Default: stable HTTPS URIs

The minimum-viable persistent identifier is the canonical URL of
the dataset on its origin node:

```
https://terraviz.example.org/datasets/{slug}
```

`slug` is publisher-chosen, unique, and not reused on retract.
The frontend serves a stable HTML page at this URL with
`schema.org/Dataset` JSON-LD embedded so search engines and
reference managers can resolve it.

This is enough for casual citation but breaks if the node moves.

### Tier 1 upgrade: DOIs via DataCite

For nodes that want real persistence, the publisher portal can
register a DOI per dataset (or per revision) through DataCite.
Cost: a DataCite membership ($) and an HTTPS URL that DataCite
can resolve to.

Schema is already in place: `datasets.doi` carries the DOI string
when one is registered. The publisher portal exposes a "Register
DOI" action that:

1. Builds the DataCite metadata payload from the dataset row +
   developers + license + lineage info.
2. Posts to DataCite's REST API.
3. Stores the returned DOI in `doi` and writes an audit row.

The DOI resolves to the canonical URL on the origin node;
moving the node means redirecting that URL or updating the
DataCite entry, both of which are operator actions that the DOI
machinery is designed for.

### Tier 2 upgrade: ARK identifiers

For institutions that prefer ARKs (free, no central registrar),
the same mechanism works against an ARK NAAN. The schema
accommodates this without change; the publisher portal grows a
second "Register ARK" action.

### Federation behaviour

Persistent identifiers travel with the dataset payload. A peer
mirroring a dataset displays the DOI / ARK alongside the local
node URL but never claims the identifier as its own; the
canonical URL points at the origin node, not the mirror.

## Backup & disaster recovery

A node losing its D1 is a real failure mode. R2 has versioning;
D1 has point-in-time recovery. The plan specifies what gets
turned on and what "recovery" actually means.

### What gets backed up

| Asset class | Backup mechanism | Retention |
|---|---|---|
| D1 catalog | Cloudflare D1 point-in-time recovery (Time Travel) | 30 days on Workers Paid (the default; matches the cost section). |
| D1 nightly export | `wrangler d1 export` to a versioned R2 key (`backups/d1/{date}.sql.gz`) | 90 days, automated cron. |
| R2 assets | R2 object versioning on the asset bucket | Infinite for currently-published rows; lifecycle rule deletes versions of retracted assets after 90 days. |
| R2 nightly index | A nightly `R2 ls` snapshot to `backups/r2-index/{date}.json.gz` | 90 days. |
| Stream videos | Cloudflare-managed (no per-video backup; loss is permanent if Stream loses it). For datasets that warrant bulletproof backup, the original is also kept in R2. | Indefinite at operator's discretion. |
| Wrangler secrets | Documented out-of-band in the operator's password manager | Operator responsibility. |

### Recovery scenarios

| Failure | Recovery |
|---|---|
| Bad migration corrupts a row | D1 Time Travel — restore the table to a point pre-migration; replay any non-corrupting writes from the audit log. |
| D1 database deleted | Restore from the most recent nightly `wrangler d1 export`; replay audit-log writes since the export. |
| R2 asset deleted | R2 versioning makes this idempotent: undelete the version. |
| R2 bucket deleted | Restore from R2 backup index + Stream + a re-import of any external originals. Some loss likely. |
| Cloudflare account compromise | Out of scope; operator must restore identity and revoke all tokens before any of the above. |
| Node permanently lost | Federated mirrors retain *metadata* for every public dataset they synced. They do not retain assets. A new node can re-bootstrap the catalog by inheriting from a federated mirror, but the asset bytes are gone unless the originals are still reachable. This is the strongest argument for keeping originals in R2 alongside Stream. |

### Recovery testing

Quarterly: an operator walks through a recovery drill against a
preview environment — restore D1 from last night's export, point
the preview Pages deploy at it, verify catalog reads, federation
sync, and one signed-asset playback. The drill writes an entry to
an `ops/recovery-drills.md` log so the procedure is exercised
before it is needed.

### What this section deliberately does not solve

- **Geographic redundancy beyond what Cloudflare provides.** D1
  is a single-region store with replicas managed by Cloudflare;
  R2 is multi-region by default. A multi-cloud DR setup (D1
  shadowing into Postgres + R2 shadowing into S3) is possible
  through the cloud-portability interfaces but is its own
  project.
- **Continuous off-platform replication.** The nightly snapshot
  is the floor; sub-day RPO requires a streaming replication
  setup that's out of scope for Phase 1.
