# Backend module map (`functions/` + `cli/`)

This is the **backend** counterpart to the SPA + Rust module maps in
[`CLAUDE.md`](../CLAUDE.md): one row per non-test module under
`functions/` (Cloudflare Pages Functions) and `cli/` (the `terraviz`
publisher CLI). It lives here rather than in CLAUDE.md because the
backend is helper-dense and route-shaped, and sits alongside the
design rationale in the `docs/CATALOG_*` plan docs.

> **Enforced.** `npm run check:doc-coverage` (in the `type-check`
> chain) fails CI if a module under `functions/` or `cli/` is missing
> from this file. Add a row in the same PR; for a module that
> genuinely needs none (throwaway shim), add `// doc-exempt: <reason>`
> to its source. For the deeper *why* behind each subsystem, follow
> the `docs/CATALOG_*` references in CLAUDE.md's _Backend subsystems_.


## Publisher CLI (`cli/`)

| File | Responsibility |
|---|---|
| `cli/commands.ts` | Command implementations for the `terraviz` CLI |
| `cli/import-snapshot.ts` | `terraviz import-snapshot` — one-shot bulk importer for the legacy SOS catalog snapshot |
| `cli/init-node.ts` | `terraviz init-node` — provision (or update) this node's identity |
| `cli/lib/args.ts` | Hand-rolled argv parser for the `terraviz` CLI |
| `cli/lib/asset-fetch.ts` | HTTP fetch helper for the Phase 3b asset migration |
| `cli/lib/client.ts` | Thin HTTP client wrapping fetch + the Access auth headers |
| `cli/lib/config.ts` | Resolve the CLI's runtime configuration: server URL + auth |
| `cli/lib/ffmpeg-hls.ts` | FFmpeg HLS encoder wrapper — multi-rendition equirectangular |
| `cli/lib/migration-telemetry.ts` | Operator-side telemetry emitter for the migration CLIs |
| `cli/lib/r2-upload.ts` | R2 S3-API bulk uploader for HLS bundles |
| `cli/lib/realtime-title.ts` | Heuristic to detect "real-time" SOS rows by title — the rows whose Vimeo source is re-uploaded on a recurring (typically daily) cadence by NOAA's automation |
| `cli/lib/snapshot-import.ts` | Pure row-mapping helpers for the SOS catalog snapshot importer |
| `cli/lib/srt-to-vtt.ts` | SRT → WebVTT converter |
| `cli/lib/tour-json-parser.ts` | SOS tour.json parser — discovers every URL-bearing field in a tour file and classifies it for migration |
| `cli/lib/verify-checks.ts` | Production-deploy verification checks for `terraviz verify-deploy` |
| `cli/lib/vimeo-source.ts` | Resolve a `vimeo:<id>` reference to a source MP4 download URL |
| `cli/list-realtime-r2.ts` | `terraviz list-realtime-r2` — find migrated rows whose Vimeo source is on a daily re-upload cadence, and recover the original Vimeo id so they can be rolled back |
| `cli/migrate-r2-assets.ts` | `terraviz migrate-r2-assets` — migrate auxiliary asset URLs (thumbnail / legend / caption / color-table) from NOAA-hosted CloudFront URLs to R2-hosted URLs under `dataset |
| `cli/migrate-r2-hls.ts` | `terraviz migrate-r2-hls` — migrate legacy `vimeo:<id>` data_refs to R2-hosted HLS bundles for 4K spherical streaming |
| `cli/migrate-r2-tours.ts` | `terraviz migrate-r2-tours` — migrate SOS tour.json files (and their sibling assets: overlay images, narrated audio, 360-pano JPGs) from NOAA-hosted CloudFront URLs to R2 |
| `cli/rollback-r2-assets.ts` | `terraviz rollback-r2-assets` — undo migrated auxiliary assets |
| `cli/rollback-r2-hls.ts` | `terraviz rollback-r2-hls` — undo migrated dataset(s) |
| `cli/rollback-r2-tours.ts` | `terraviz rollback-r2-tours` — undo a migrated tour |
| `cli/terraviz.ts` | `terraviz` CLI entry point |
| `cli/transcode-from-dispatch.ts` | `transcode-from-dispatch` — invoked by the `transcode-hls` GitHub Actions workflow when the publisher portal fires a `repository_dispatch` after a video upload lands in R |
| `cli/verify-deploy.ts` | `terraviz verify-deploy` — operator-friendly post-deploy smoke-test command |

## Platform & feedback Pages Functions (`functions/api/`)

| File | Responsibility |
|---|---|
| `functions/.well-known/terraviz.json.ts` | Route: GET /.well-known/terraviz.json |
| `functions/api/_feedback-helpers.ts` | Cloudflare Pages Function helpers — feedback admin data layer |
| `functions/api/chat/completions.ts` | Route: /api/chat/completions |
| `functions/api/feedback-admin.ts` | Route: /api/feedback-admin |
| `functions/api/feedback-dashboard.ts` | Route: /api/feedback-dashboard |
| `functions/api/feedback-export.ts` | Route: /api/feedback-export |
| `functions/api/feedback.ts` | Route: /api/feedback |
| `functions/api/general-feedback-dashboard.ts` | Route: /api/general-feedback-dashboard |
| `functions/api/general-feedback-export.ts` | Route: /api/general-feedback-export |
| `functions/api/general-feedback-screenshot.ts` | Route: /api/general-feedback-screenshot |
| `functions/api/general-feedback.ts` | Route: /api/general-feedback |
| `functions/api/ingest.ts` | Route: /api/ingest |
| `functions/api/legend.ts` | Route: /api/legend |
| `functions/api/models.ts` | Route: /api/models |
| `functions/api/tile/[[path]].ts` | Route: /api/tile/[...path] |

## Catalog read API (`functions/api/v1/`)

| File | Responsibility |
|---|---|
| `functions/api/v1/catalog.ts` | Route: GET /api/v1/catalog |
| `functions/api/v1/datasets/[id].ts` | Route: GET /api/v1/datasets/{id} |
| `functions/api/v1/datasets/[id]/frames.ts` | Route: GET /api/v1/datasets/{id}/frames |
| `functions/api/v1/datasets/[id]/frames/[frameIndex].ts` | Route: `/api/v1/datasets/{id}/frames/{frameIndex}` |
| `functions/api/v1/datasets/[id]/manifest.ts` | Route: GET /api/v1/datasets/{id}/manifest |
| `functions/api/v1/datasets/[id]/preview/[token].ts` | GET /api/v1/datasets/{id}/preview/{token} |
| `functions/api/v1/datasets/[id]/preview/[token]/manifest.ts` | GET /api/v1/datasets/{id}/preview/{token}/manifest |
| `functions/api/v1/featured-hero.ts` | Route: GET /api/v1/featured-hero |
| `functions/api/v1/featured.ts` | Route: GET /api/v1/featured |
| `functions/api/v1/logout.ts` | GET /api/v1/logout |
| `functions/api/v1/search.ts` | Route: GET /api/v1/search?q=.. |
| `functions/api/v1/tours.ts` | GET /api/v1/tours |

## Publisher write API (`functions/api/v1/publish/`)

| File | Responsibility |
|---|---|
| `functions/api/v1/publish/_middleware.ts` | Auth middleware for /api/v1/publish/ |
| `functions/api/v1/publish/datasets.ts` | /api/v1/publish/datasets |
| `functions/api/v1/publish/datasets/[id].ts` | /api/v1/publish/datasets/{id} |
| `functions/api/v1/publish/datasets/[id]/asset.ts` | POST /api/v1/publish/datasets/{id}/asset |
| `functions/api/v1/publish/datasets/[id]/asset/[upload_id]/complete.ts` | POST /api/v1/publish/datasets/{id}/asset/{upload_id}/complete |
| `functions/api/v1/publish/datasets/[id]/preview.ts` | POST /api/v1/publish/datasets/{id}/preview |
| `functions/api/v1/publish/datasets/[id]/publish.ts` | POST /api/v1/publish/datasets/{id}/publish |
| `functions/api/v1/publish/datasets/[id]/reindex.ts` | POST /api/v1/publish/datasets/{id}/reindex |
| `functions/api/v1/publish/datasets/[id]/retract.ts` | POST /api/v1/publish/datasets/{id}/retract |
| `functions/api/v1/publish/datasets/[id]/transcode-complete.ts` | POST /api/v1/publish/datasets/{id}/transcode-complete |
| `functions/api/v1/publish/featured-hero.ts` | /api/v1/publish/featured-hero — the "Right now" hero admin write API (Phase B of `docs/HERO_ADMIN_SCOPING.md`) |
| `functions/api/v1/publish/featured.ts` | /api/v1/publish/featured |
| `functions/api/v1/publish/featured/[dataset_id].ts` | /api/v1/publish/featured/{dataset_id} |
| `functions/api/v1/publish/me.ts` | GET /api/v1/publish/me — return the calling publisher's profile |
| `functions/api/v1/publish/node-identity.ts` | /api/v1/publish/node-identity — read / provision this node's identity |
| `functions/api/v1/publish/redirect-back.ts` | GET /api/v1/publish/redirect-back?to=<path> |
| `functions/api/v1/publish/tours.ts` | /api/v1/publish/tours — tour collection endpoint |
| `functions/api/v1/publish/tours/[id].ts` | /api/v1/publish/tours/{id} |
| `functions/api/v1/publish/tours/[id]/json.ts` | /api/v1/publish/tours/{id}/json |
| `functions/api/v1/publish/tours/[id]/preview.ts` | POST /api/v1/publish/tours/{id}/preview |
| `functions/api/v1/publish/tours/[id]/publish.ts` | POST /api/v1/publish/tours/{id}/publish |
| `functions/api/v1/publish/tours/[id]/retract.ts` | POST /api/v1/publish/tours/{id}/retract |
| `functions/api/v1/publish/tours/draft.ts` | POST /api/v1/publish/tours/draft |

## Backend shared library (`_lib/`)

| File | Responsibility |
|---|---|
| `functions/api/_lib/workers-ai-error.ts` | Workers AI error classification helper for Phase 1f/D's quota guard rail |
| `functions/api/v1/_lib/access-auth.ts` | Cloudflare Access JWT verification |
| `functions/api/v1/_lib/asset-uploads.ts` | `asset_uploads` row-level helpers + per-kind validation rules |
| `functions/api/v1/_lib/audit-store.ts` | Append-only writes to the `audit_events` table |
| `functions/api/v1/_lib/bounded-pool.ts` | Tiny bounded-concurrency helper for parallelizable async work that can't safely fan-out to N at once |
| `functions/api/v1/_lib/catalog-store.ts` | D1 reader functions for the catalog tables |
| `functions/api/v1/_lib/data-ref-resolver.ts` | Build the {@link DataRefResolver} the catalog read-paths pass into {@link serializeDataset} so tour rows can surface a fetchable `tourJsonUrl` alongside the manifest `dat |
| `functions/api/v1/_lib/data-ref.ts` | Shared `data_ref` parser |
| `functions/api/v1/_lib/dataset-mutations.ts` | Publisher-API write paths for the `datasets` table |
| `functions/api/v1/_lib/dataset-serializer.ts` | Maps `DatasetRow` + `DecorationRows` to the wire `Dataset` shape that frontend consumers expect |
| `functions/api/v1/_lib/embed-dataset-job.ts` | Embedding pipeline job — Phase 1c |
| `functions/api/v1/_lib/embeddings.ts` | Workers AI embedding helpers — Phase 1c |
| `functions/api/v1/_lib/env.ts` | Shared `Env` type for catalog-backend Pages Functions |
| `functions/api/v1/_lib/errors.ts` | Typed errors used by the storage helpers (`r2-store.ts`, `stream-store.ts`) so the route handlers can distinguish "operator forgot to set credentials" from "the upstream  |
| `functions/api/v1/_lib/featured-datasets.ts` | `featured_datasets` row helpers |
| `functions/api/v1/_lib/frames-manifest.ts` | Helpers shared by the Phase 3pg/B `/frames` endpoints |
| `functions/api/v1/_lib/github-dispatch.ts` | GitHub repository_dispatch helper — Phase 3pd |
| `functions/api/v1/_lib/hero-override-store.ts` | `hero_override` singleton row helpers |
| `functions/api/v1/_lib/iso-duration.ts` | Minimal ISO 8601 duration parser scoped to the shapes the catalog's `period` column carries |
| `functions/api/v1/_lib/job-queue.ts` | Asynchronous job queue interface — Phase 1b |
| `functions/api/v1/_lib/loopback.ts` | Loopback hostname check — shared by the publish middleware's `DEV_BYPASS_ACCESS=true` gate and the asset-complete handler's `MOCK_R2=true` gate |
| `functions/api/v1/_lib/preview-token.ts` | Short-lived signed preview tokens for unpublished datasets and tours |
| `functions/api/v1/_lib/publisher-store.ts` | D1 reader / writer for the `publishers` table |
| `functions/api/v1/_lib/r2-public-url.ts` | Build a publicly-readable URL for an R2 object key |
| `functions/api/v1/_lib/r2-store.ts` | R2 storage helpers — Phase 1b |
| `functions/api/v1/_lib/search-datasets.ts` | Vector search over the dataset catalog — Phase 1c |
| `functions/api/v1/_lib/snapshot.ts` | KV-backed snapshot cache for the public catalog response |
| `functions/api/v1/_lib/sphere-thumbnail-job.ts` | Sphere-thumbnail generation job — Phase 1b |
| `functions/api/v1/_lib/stream-store.ts` | Cloudflare Stream helpers — Phase 1b |
| `functions/api/v1/_lib/test-helpers.ts` | Test helpers — adapters that let Vitest exercise the catalog route handlers against real SQL (better-sqlite3) and an in-memory KV map |
| `functions/api/v1/_lib/tour-mutations.ts` | Publisher-API write paths for the `tours` table |
| `functions/api/v1/_lib/ulid.ts` | Single source of truth for ULID minting on the publisher write paths |
| `functions/api/v1/_lib/validators.ts` | Field-level validators for the publisher-API write paths |
| `functions/api/v1/_lib/vectorize-store.ts` | Vectorize helpers — Phase 1c |

