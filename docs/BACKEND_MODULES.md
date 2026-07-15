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
| `cli/import-events.ts` | `terraviz import-events` — ingest current events from NASA EONET into the catalog as proposed events (`docs/CURRENT_EVENTS_PLAN.md` §9) |
| `cli/import-snapshot.ts` | `terraviz import-snapshot` — one-shot bulk importer for the legacy SOS catalog snapshot |
| `cli/init-node.ts` | `terraviz init-node` — provision (or update) this node's identity |
| `cli/lib/args.ts` | Hand-rolled argv parser for the `terraviz` CLI |
| `cli/lib/asset-fetch.ts` | HTTP fetch helper for the Phase 3b asset migration |
| `cli/lib/client.ts` | Thin HTTP client wrapping fetch + the Access auth headers |
| `cli/lib/config.ts` | Resolve the CLI's runtime configuration: server URL + auth |
| `cli/lib/eonet.ts` | Pure NASA EONET → current-event mapper for `terraviz import-events` + the refresh route. Synthesizes a readable summary (category + coords + time) when EONET gives none, and picks a public source page — falling back to a public NASA Worldview imagery deep-link when the only source is auth-walled (IRWIN/JTWC) (`docs/CURRENT_EVENTS_PLAN.md` §9) |
| `cli/lib/ffmpeg-hls.ts` | FFmpeg HLS encoder wrapper — multi-rendition equirectangular |
| `cli/lib/rss.ts` | Pure generic RSS 2.0 / Atom → current-event mapper — the bring-your-own-feed connector kind. Zero-dependency tolerant XML scan (Workers has no DOMParser); carries GeoRSS points through as event geometry; the connector's registry id namespaces the `(feed_id, external_id)` dedupe key (`docs/CURRENT_EVENTS_PLAN.md` §9) |
| `cli/lib/hls-incremental.ts` | Pure core of incremental HLS re-encoding — absolute-grid chunking, content-addressed segment hashing, reuse-vs-encode diff, playlist assembly (`docs/INCREMENTAL_HLS_PLAN.md`) |
| `cli/lib/hls-incremental-runner.ts` | Incremental transcode orchestration over an injectable I/O seam — load manifest → diff → encode changed chunks → recycle the rest → publish playlists → persist manifest → mark-and-sweep segment GC (`docs/INCREMENTAL_HLS_PLAN.md` Stages 2-3) |
| `cli/lib/migration-telemetry.ts` | Operator-side telemetry emitter for the migration CLIs |
| `cli/lib/frames-publish.ts` | Publish a runner's padded frame directory as an image-sequence asset (hash → init → PUT frames + `source_filenames.json` → complete) so the Zyra recall path reuses the existing `/frames` surface (`docs/ZYRA_INTEGRATION_PLAN.md` §Real-time frame store). HEAD-skips frames already in the content-addressed store when an `exists` gate is supplied (`docs/INCREMENTAL_FRAME_UPLOAD_PLAN.md`) |
| `cli/lib/frame-store.ts` | Runner-side content-addressed frame store helpers — `videos/{dataset}/frames/sha256/{hex}.{ext}` key/prefix builders + the pure mark-and-sweep orphan selection; shared by the transcode read path, the publish HEAD-skip, and the frame GC (`docs/INCREMENTAL_FRAME_UPLOAD_PLAN.md`) |
| `cli/lib/r2-frames.ts` | R2-backed frame cache for real-time Zyra workflow runs — restore/save a dataset's frames under `workflow-frames/{dataset_id}/` with window-only prune (`docs/ZYRA_INTEGRATION_PLAN.md` §Real-time frame store) |
| `cli/lib/r2-upload.ts` | R2 S3-API bulk uploader for HLS bundles |
| `cli/lib/realtime-title.ts` | Heuristic to detect "real-time" SOS rows by title — the rows whose Vimeo source is re-uploaded on a recurring (typically daily) cadence by NOAA's automation |
| `cli/lib/snapshot-import.ts` | Pure row-mapping helpers for the SOS catalog snapshot importer |
| `cli/lib/sos-spec.ts` | ffprobe wrapper + SOS-spec assertion (4096×2048 2:1, 30 fps, h264) shared by the Z0 spike and the Z1 runner |
| `cli/lib/srt-to-vtt.ts` | SRT → WebVTT converter |
| `cli/lib/tour-json-parser.ts` | SOS tour.json parser — discovers every URL-bearing field in a tour file and classifies it for migration |
| `cli/lib/verify-checks.ts` | Production-deploy verification checks for `terraviz verify-deploy` |
| `cli/lib/vimeo-source.ts` | Resolve a `vimeo:<id>` reference to a source MP4 download URL |
| `cli/lib/workflow-sidecar.ts` | Metadata-sidecar rendering for the Zyra runner — template interpolation, frames-meta range reader, error-summary sanitizer |
| `cli/lib/zyra-acquire-softpass.ts` | Pure soft-pass decision for a transient NOAA-FTP `acquire` failure in a scheduled Zyra run — classify the `zyra run` log (FTP/network transient vs real failure), assess published-bundle freshness, and decide soft-pass (no-op `succeeded`, GREEN) vs escalate (fail loudly). Consumed by `zyra-publish-from-dispatch.ts --phase=acquire-softpass` |
| `cli/list-realtime-r2.ts` | `terraviz list-realtime-r2` — find migrated rows whose Vimeo source is on a daily re-upload cadence, and recover the original Vimeo id so they can be rolled back |
| `cli/migrate-r2-assets.ts` | `terraviz migrate-r2-assets` — migrate auxiliary asset URLs (thumbnail / legend / caption / color-table) from NOAA-hosted CloudFront URLs to R2-hosted URLs under … |
| `cli/migrate-r2-hls.ts` | `terraviz migrate-r2-hls` — migrate legacy `vimeo:<id>` data_refs to R2-hosted HLS bundles for 4K spherical streaming |
| `cli/migrate-r2-tours.ts` | `terraviz migrate-r2-tours` — migrate SOS tour.json files (and their sibling assets: overlay images, narrated audio, 360-pano JPGs) from NOAA-hosted CloudFront URLs to R2-hosted … |
| `cli/rollback-r2-assets.ts` | `terraviz rollback-r2-assets` — undo migrated auxiliary assets |
| `cli/rollback-r2-hls.ts` | `terraviz rollback-r2-hls` — undo migrated dataset(s) |
| `cli/rollback-r2-tours.ts` | `terraviz rollback-r2-tours` — undo a migrated tour |
| `cli/terraviz.ts` | `terraviz` CLI entry point |
| `cli/transcode-from-dispatch.ts` | `transcode-from-dispatch` — invoked by the `transcode-hls` GitHub Actions workflow when the publisher portal fires a `repository_dispatch` after a video upload lands in R2 |
| `cli/report-transcode-failure.ts` | `report-transcode-failure` — the `transcode-hls` workflow's failure/cancellation step; POSTs `/transcode-failed` to release a dataset's stuck `transcoding` lock when the encode errors or the job times out (the timeout SIGKILLs the main runner before it can self-report) |
| `cli/verify-deploy.ts` | `terraviz verify-deploy` — operator-friendly post-deploy smoke-test command |
| `cli/zyra-publish-from-dispatch.ts` | `zyra-publish-from-dispatch` — Phase Z1 runner CLI (fetch / restore-frames / save-frames / publish / report-failure / acquire-softpass phases) invoked by the `zyra-run` GitHub Actions workflow |
| `cli/zyra-spike-publish.ts` | `zyra-spike-publish` — Phase Z0 spike (see `docs/ZYRA_INTEGRATION_PLAN.md`): ffprobe SOS-spec assertion + publish-API leg for an MP4 a Zyra pipeline rendered on the runner; invoked by the manual `zyra-spike` GitHub Actions workflow |

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
| `functions/api/voice/_voice-lib.ts` | Shared helpers for the voice Pages Functions — Workers AI model IDs, `KILL_VOICE` kill switch, CORS/origin, per-IP rate limiter, base64 (`docs/ORBIT_VOICE_PLAN.md` §7) |
| `functions/api/voice/synthesize.ts` | Route: POST /api/voice/synthesize — text-to-speech via Workers AI (MeloTTS default, Aura opt-in) |
| `functions/api/voice/transcribe.ts` | Route: POST /api/voice/transcribe — speech-to-text via Workers AI (Whisper large v3 turbo) |
| `functions/api/voice/stream.ts` | Route: WS /api/voice/stream — realtime STT proxy; pipes linear16 PCM to Cloudflare's AI Gateway realtime endpoint (Deepgram Nova-3/Flux) with the `cf-aig-authorization` secret, JSON transcripts back. Config: `CF_ACCOUNT_ID` / `CF_AI_GATEWAY` / `CF_AIG_TOKEN`. When unset, `KILL_VOICE` is on, or over the per-IP cap, it accepts the socket and sends a JSON error frame (`{type:"error",code}`) before closing — a browser WS can't read an HTTP status — so the client cools down and the streaming resolver falls back to batch Whisper (`docs/ORBIT_VOICE_PLAN.md` §3) |
| `functions/api/tile/[[path]].ts` | Route: /api/tile/[...path] |

## Catalog read API (`functions/api/v1/`)

| File | Responsibility |
|---|---|
| `functions/api/v1/catalog.ts` | Route: GET /api/v1/catalog |
| `functions/api/v1/datasets/[id].ts` | Route: GET /api/v1/datasets/{id} |
| `functions/api/v1/datasets/[id]/frames.ts` | Route: GET /api/v1/datasets/{id}/frames |
| `functions/api/v1/datasets/[id]/frames/[frameIndex].ts` | Route: `/api/v1/datasets/{id}/frames/{frameIndex}` |
| `functions/api/v1/datasets/[id]/manifest.ts` | Route: GET /api/v1/datasets/{id}/manifest |
| `functions/api/v1/datasets/[id]/related.ts` | Route: GET /api/v1/datasets/{id}/related — semantic "more like this" (Vectorize); lexical `relatedDatasets.ts` is the client fallback |
| `functions/api/v1/datasets/[id]/events.ts` | Route: GET /api/v1/datasets/{id}/events — public "In the news" list: the approved current events with an approved link to this dataset (`listApprovedEventsForDataset`); short `Cache-Control`, `{ events: [] }` graceful degradation (`docs/CURRENT_EVENTS_PLAN.md` §6) |
| `functions/api/v1/datasets/[id]/preview/[token].ts` | GET /api/v1/datasets/{id}/preview/{token} |
| `functions/api/v1/datasets/[id]/preview/[token]/manifest.ts` | GET /api/v1/datasets/{id}/preview/{token}/manifest |
| `functions/api/v1/featured-event.ts` | GET /api/v1/featured-event — public read of the current event that headlines the "Right now" hero (`docs/CURRENT_EVENTS_PLAN.md` §6.1) |
| `functions/api/v1/events.ts` | GET /api/v1/events — public list of approved current events (geometry + time + visible linked dataset ids) for the catalog Map/Timeline overlays; KV-cached, `{ events: [] }` graceful degradation (`docs/CURRENT_EVENTS_PLAN.md` §6.3) |
| `functions/api/v1/blog.ts` | GET /api/v1/blog — public list of published blog posts (lean card shape, KV-cached `blog:list:v1` 60 s, degrades to an empty list) (`docs/CURRENT_EVENTS_PLAN.md` §7) |
| `functions/api/v1/blog/[slug].ts` | GET /api/v1/blog/{slug} — one published post hydrated for the public page: full markdown body + visibility-filtered cited-dataset titles + the cited event's citation ONLY while approved; 404 for drafts and unknown slugs alike; KV-cached per slug |
| `functions/api/v1/node-profile.ts` | GET /api/v1/node-profile — lean public host-organization identity (`orgName` + resolved `logoUrl`) for the blog header and future about/footer surfaces; KV-cached `node-profile:v1` 300 s, degrades to `{ profile: null }` |
| `functions/api/v1/featured-hero.ts` | Route: GET /api/v1/featured-hero |
| `functions/api/v1/featured.ts` | Route: GET /api/v1/featured |
| `functions/api/v1/logout.ts` | GET /api/v1/logout |
| `functions/api/v1/search.ts` | Route: GET /api/v1/search?q=.. |
| `functions/api/v1/tours.ts` | GET /api/v1/tours |

## Publisher write API (`functions/api/v1/publish/`)

| File | Responsibility |
|---|---|
| `functions/api/v1/publish/_middleware.ts` | Auth middleware for /api/v1/publish/ |
| `functions/api/v1/publish/analytics-export.ts` | POST /api/v1/publish/analytics-export — nightly analytics export tick (bookmark walk + operator `?day=` backfill); privileged callers only, driven by `.github/workflows/analytics-export.yml` |
| `functions/api/v1/publish/analytics.ts` | GET /api/v1/publish/analytics — typed section facade over the D1 analytics rollups for the `/publish/analytics` tab (KV-cached ~5 min; privileged callers only) |
| `functions/api/v1/publish/datasets.ts` | /api/v1/publish/datasets |
| `functions/api/v1/publish/datasets/[id].ts` | /api/v1/publish/datasets/{id} |
| `functions/api/v1/publish/datasets/[id]/asset.ts` | POST /api/v1/publish/datasets/{id}/asset |
| `functions/api/v1/publish/datasets/[id]/asset/[upload_id]/complete.ts` | POST /api/v1/publish/datasets/{id}/asset/{upload_id}/complete |
| `functions/api/v1/publish/datasets/[id]/preview.ts` | POST /api/v1/publish/datasets/{id}/preview |
| `functions/api/v1/publish/datasets/[id]/publish.ts` | POST /api/v1/publish/datasets/{id}/publish |
| `functions/api/v1/publish/datasets/[id]/reindex.ts` | POST /api/v1/publish/datasets/{id}/reindex |
| `functions/api/v1/publish/datasets/[id]/retract.ts` | POST /api/v1/publish/datasets/{id}/retract |
| `functions/api/v1/publish/datasets/[id]/transcode-complete.ts` | POST /api/v1/publish/datasets/{id}/transcode-complete |
| `functions/api/v1/publish/datasets/[id]/transcode-failed.ts` | POST /api/v1/publish/datasets/{id}/transcode-failed — failure counterpart; releases the `transcoding` lock (leaves `data_ref` on the prior bundle) when the transcode job errors or times out |
| `functions/api/v1/publish/events.ts` | GET (privileged current-events review queue) + POST (privileged create / ingest: idempotent on `(feed_id, external_id)`, runs the matcher on create; `docs/CURRENT_EVENTS_PLAN.md` §5, §9) |
| `functions/api/v1/publish/events/[id].ts` | POST /api/v1/publish/events/{id} — curator review-submit (event + per-link approve/reject) |
| `functions/api/v1/publish/events/[id]/image.ts` | POST /api/v1/publish/events/{id}/image — privileged upload of the publisher's own photo as the event's story image (task: media suggestion engine): base64-in-JSON through the shared `image-upload.ts` validator (raster only, 4 MB cap, magic-byte check), content-addressed into CATALOG_R2, `image_url` set to the resolved public URL + optional curator `altText` → `image_alt`; audit-logged (`event.image_upload`), busts the public event caches |
| `functions/api/v1/_lib/youtube-channels.ts` | Vetted agency-YouTube channel allowlist (channelId → name; NASA/USGS/NOAA family — verified by id, operator-extensible) + `isAllowlistedChannel` / `channelName` / the `isNocookieEmbedUrl` embed-host guard (write + read validation) / `nocookieEmbedUrl` builder for the agency-YouTube media source |
| `functions/api/v1/publish/media/youtube-search.ts` | GET /api/v1/publish/media/youtube-search?q= — privileged same-origin proxy over the YouTube Data API (`YOUTUBE_API_KEY`, server-side only): one `search.list`, results kept only from allowlisted agency channels, trimmed to `{ videoId, title, channelId, channelName }`; key-absent/any-failure degrades to `{ videos: [] }`; KV-cached by query (`docs/YOUTUBE_API_KEY.md`) |
| `functions/api/v1/_lib/youtube-channels-store.ts` | D1 access for the operator-configurable YouTube channel allowlist (`youtube_channels`, migration 0035): list/add/remove custom channels + `resolveChannelUrl` (a `/channel/UC…` URL carries its id; a `@handle` / `/c/` / `/user/` URL resolves via the YouTube `channels.list` API using the server-side key) + `parseChannelUrl` / `isChannelId` |
| `functions/api/v1/publish/media/youtube-channels.ts` | GET/POST /api/v1/publish/media/youtube-channels — privileged: GET returns the effective allowlist (hardcoded agency defaults `builtin:true` + the node's custom channels `builtin:false`); POST adds a channel by pasted URL (resolved to a canonical id, audit `youtube_channel.add`) |
| `functions/api/v1/publish/media/youtube-channels/[id].ts` | DELETE /api/v1/publish/media/youtube-channels/{id} — privileged: removes one of the node's custom channels (built-in ids 404); audit `youtube_channel.remove` |
| `functions/api/v1/publish/media/nhc-storms.ts` | GET /api/v1/publish/media/nhc-storms — privileged same-origin proxy over NHC's `CurrentStorms.json` (nhc.noaa.gov serves no CORS headers): one fixed upstream URL, storms trimmed to `{ id, name }`, KV-cached 5 min (real answers only), every failure degrades to `{ activeStorms: [] }`; feeds the Events-tab forecast-cone suggestion (task: media suggestion engine) |
| `functions/api/v1/publish/events/[id]/tour.ts` | POST /api/v1/publish/events/{id}/tour — privileged one-shot: generate an editable draft tour from the event + its vetted dataset pairings via `event-tour.ts`, persisted through the normal draft-tour pipeline (`createDraftTour` + `writeTourDraftJson`); nothing auto-publishes (`docs/CURRENT_EVENTS_PLAN.md` §7) |
| `functions/api/v1/publish/events/refresh.ts` | POST /api/v1/publish/events/refresh — privileged on-demand ingestion pull: fetches the node's configured feed (EONET) server-side and runs the shared upsert+match path, so a curator can refresh the queue without waiting for the cron (`docs/CURRENT_EVENTS_PLAN.md` §9) |
| `functions/api/v1/publish/feeds.ts` | GET (privileged connector list for the portal feeds page) + POST (add a connector — a curated preset or a bring-your-own RSS/Atom URL; validated kind/label/http(s) url, audit-logged; `docs/CURRENT_EVENTS_PLAN.md` §9) |
| `functions/api/v1/publish/feeds/[id].ts` | POST (patch a connector — label/url/category/**enable-disable**) + DELETE (remove; already-ingested events untouched) — privileged, audit-logged (`docs/CURRENT_EVENTS_PLAN.md` §9) |
| `functions/api/v1/publish/feeds/preview.ts` | GET /api/v1/publish/feeds/preview?url=&kind= — privileged dry-run of a feed URL through the same pure mapper the refresh route uses; returns the first few mapped items (title/publishedAt/link) so an operator can see what a preset or pasted URL would ingest before adding it. Writes nothing (`docs/CURRENT_EVENTS_PLAN.md` §9) |
| `functions/api/v1/publish/featured-hero.ts` | /api/v1/publish/featured-hero — the "Right now" hero admin write API (Phase B of `docs/HERO_ADMIN_SCOPING.md`) |
| `functions/api/v1/publish/blog.ts` | GET (authoring list, drafts included, `?status=` filter) + POST (create a draft post — title/summary/markdown body/cited datasets/cited event; privileged, audit-logged `blog.create`) (`docs/CURRENT_EVENTS_PLAN.md` §7) |
| `functions/api/v1/publish/blog/[id].ts` | GET (one post incl. drafts) + PUT (update content — the slug never changes, published URLs stay stable) + POST `{action: publish\|unpublish}` (the curator-gated status transition) — privileged writes, audit-logged, busts the public blog caches |
| `functions/api/v1/publish/blog/generate.ts` | POST /api/v1/publish/blog/generate — AI-draft a post from the curator's selections (datasets + optional cited event + the node profile); the draft is returned, not persisted; `includeTour` additionally persists the §7 companion tour draft over the hand-picked datasets (best-effort — a tour failure never sinks the draft). Privileged, audit-logged (`blog.generate`) |
| `functions/api/v1/publish/node-profile.ts` | GET + PUT /api/v1/publish/node-profile — the singleton host-organization profile (org name, mission, about, region focus, tone, links); any publisher reads, privileged writes, audit-logged (`node_profile.update`) — the "about the host" context Phase 3d blog generation grounds itself in |
| `functions/api/v1/publish/node-settings.ts` | GET + PUT /api/v1/publish/node-settings — the per-node feature toggles; any publisher reads the effective map, **admin-only** writes (stricter than the profile's privileged gate — service tokens cannot flip features), audit-logged (`node_settings.update`), busts the features + public node-profile caches |
| `functions/api/v1/publish/node-profile/logo.ts` | POST + DELETE /api/v1/publish/node-profile/logo — org-logo upload (base64-in-JSON, png/jpeg/webp allowlist + magic-byte check, 512 KB cap, SVG excluded) stored content-addressed in R2 (`node/logo/sha256/…`), sets `logo_ref`, audits `node_profile.logo_update`, busts the public identity cache |
| `functions/api/v1/publish/featured.ts` | /api/v1/publish/featured |
| `functions/api/v1/publish/featured/[dataset_id].ts` | /api/v1/publish/featured/{dataset_id} |
| `functions/api/v1/publish/feedback.ts` | GET /api/v1/publish/feedback — privilege-gated facade over `_feedback-helpers` for the `/publish/feedback` tab (AI + general dashboards, on-demand screenshots; exports stay on `/api/feedback-admin?action=…`) |
| `functions/api/v1/publish/me.ts` | GET /api/v1/publish/me — return the calling publisher's profile |
| `functions/api/v1/publish/node-identity.ts` | /api/v1/publish/node-identity — read / provision this node's identity |
| `functions/api/v1/publish/publishers.ts` | GET /api/v1/publish/publishers — admin Users tab list (status/role/q filters, cursor pagination) |
| `functions/api/v1/publish/publishers/[id].ts` | GET / PATCH /api/v1/publish/publishers/{id} — admin approve / suspend / promote / edit-role |
| `functions/api/v1/publish/redirect-back.ts` | GET /api/v1/publish/redirect-back?to=<path> |
| `functions/api/v1/publish/tours.ts` | /api/v1/publish/tours — tour collection endpoint |
| `functions/api/v1/publish/tours/[id].ts` | /api/v1/publish/tours/{id} |
| `functions/api/v1/publish/tours/[id]/json.ts` | /api/v1/publish/tours/{id}/json |
| `functions/api/v1/publish/tours/[id]/media.ts` | POST /api/v1/publish/tours/{id}/media — media-rail image upload for the authoring dock (shared image validation, 4 MB cap, content-addressed `tours/{id}/media/sha256/…`, owner-gated); returns the public URL the `showImage` task references |
| `functions/api/v1/publish/tours/[id]/preview.ts` | POST /api/v1/publish/tours/{id}/preview |
| `functions/api/v1/publish/tours/[id]/publish.ts` | POST /api/v1/publish/tours/{id}/publish |
| `functions/api/v1/publish/tours/[id]/retract.ts` | POST /api/v1/publish/tours/{id}/retract |
| `functions/api/v1/publish/tours/draft.ts` | POST /api/v1/publish/tours/draft |
| `functions/api/v1/publish/workflows.ts` | /api/v1/publish/workflows — Zyra workflow collection (Phase Z1, `docs/ZYRA_INTEGRATION_PLAN.md`) |
| `functions/api/v1/publish/workflows/[id].ts` | /api/v1/publish/workflows/{id} — read (incl. the runner's definition fetch) + PATCH |
| `functions/api/v1/publish/workflows/[id]/run.ts` | POST /api/v1/publish/workflows/{id}/run — queue an execution + fire the `zyra-run` dispatch |
| `functions/api/v1/publish/workflows/[id]/runs.ts` | GET /api/v1/publish/workflows/{id}/runs — run history |
| `functions/api/v1/publish/workflows/[id]/runs/[run_id]/status.ts` | POST /api/v1/publish/workflows/{id}/runs/{run_id}/status — runner lifecycle callbacks |
| `functions/api/v1/publish/workflows/[id]/validate.ts` | POST /api/v1/publish/workflows/{id}/validate — static pipeline/template dry-run |
| `functions/api/v1/publish/workflows/due.ts` | GET /api/v1/publish/workflows/due — the scheduler tick's due list |

## Backend shared library (`_lib/`)

| File | Responsibility |
|---|---|
| `functions/api/_lib/workers-ai-error.ts` | Workers AI error classification helper for Phase 1f/D's quota guard rail |
| `functions/api/_lib/workers-ai-text.ts` | Workers AI reply-envelope extraction shared by every server-side `env.AI.run()` consumer (Orbit chat proxy, events enrichment, event-tour captions) — `extractModelText` / `extractModelToolCalls` tolerate both the classic `{ response, tool_calls }` shape and the OpenAI-compatible `{ choices: [{ message }] }` envelope newer models emit |
| `functions/api/v1/_lib/access-auth.ts` | Cloudflare Access JWT verification |
| `functions/api/v1/_lib/analytics-export.ts` | Analytics export job core — drains one UTC day from the AE SQL API into the R2 raw archive (`events/v1/…ndjson.gz`) + the D1 rollup tables (migration 0019); `docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md` Phase A |
| `functions/api/v1/_lib/analytics-layouts.ts` | Positional blob/double layout registry per telemetry event type + AE-row → named-fields decoder (decode side of `ingest.ts`'s `toDataPoint`; consumed by the analytics export job — `docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md` Phase A) |
| `functions/api/v1/_lib/analytics-query.ts` | Analytics dashboard query layer — shapes the D1 rollup tables into the `/publish/analytics` section payloads (overview / datasets / spatial / funnel; `docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md` Phase B) |
| `functions/api/v1/_lib/asset-uploads.ts` | `asset_uploads` row-level helpers + per-kind validation rules |
| `functions/api/v1/_lib/audit-store.ts` | Append-only writes to the `audit_events` table |
| `functions/api/v1/_lib/bounded-pool.ts` | Tiny bounded-concurrency helper for parallelizable async work that can't safely fan-out to N at once |
| `functions/api/v1/_lib/catalog-store.ts` | D1 reader functions for the catalog tables |
| `functions/api/v1/_lib/data-ref-resolver.ts` | Build the {@link DataRefResolver} the catalog read-paths pass into {@link serializeDataset} so tour rows can surface a fetchable `tourJsonUrl` alongside the manifest `dataLink` |
| `functions/api/v1/_lib/data-ref.ts` | Shared `data_ref` parser |
| `functions/api/v1/_lib/dataset-mutations.ts` | Publisher-API write paths for the `datasets` table |
| `functions/api/v1/_lib/dataset-serializer.ts` | Maps `DatasetRow` + `DecorationRows` to the wire `Dataset` shape that frontend consumers expect |
| `functions/api/v1/_lib/embed-dataset-job.ts` | Embedding pipeline job — Phase 1c |
| `functions/api/v1/_lib/embeddings.ts` | Workers AI embedding helpers — Phase 1c |
| `functions/api/v1/_lib/env.ts` | Shared `Env` type for catalog-backend Pages Functions |
| `functions/api/v1/_lib/errors.ts` | Typed errors used by the storage helpers (`r2-store.ts`, `stream-store.ts`) so the route handlers can distinguish "operator forgot to set credentials" from "the upstream service … |
| `functions/api/v1/_lib/events-enrich.ts` | Slice-C AI date/location enrichment — `enrichEventFields` asks Workers AI to extract the occurred day (anchored to the item's publish date) and a place constrained to the `regions.ts` vocabulary for events that arrive without them; confidence-gated, fills only missing fields, records provenance in `inferredFields`, degrades to a no-op when AI is unbound (`docs/CURRENT_EVENTS_PLAN.md` §9) |
| `functions/api/v1/_lib/og-image.ts` | og:image / twitter:image lead-image extraction for events whose feed item carried no enclosure (task: story media) — pure meta-tag parse + a bounded article fetch (5 s timeout, HTML-only, 256 KB read cap, injectable fetch); every failure degrades to null |
| `functions/api/v1/_lib/event-tour.ts` | Auto-generated current-events tour (`docs/CURRENT_EVENTS_PLAN.md` §7) — pure `buildEventTourTasks` (event geometry → `flyTo`, occurred time → `setTime`, paired datasets → captioned `loadDataset` stops in the existing `tourEngine.ts` task vocabulary) + `generateTourCaptions` (Workers-AI captions grounded in only the event's own text and real dataset titles, deterministic template fallback on any failure) |
| `functions/api/v1/_lib/events-ingest.ts` | Shared current-events ingestion core — `parseCreate` (source-agnostic create-body validation), `resolveOriginNode`, and the idempotent `ingestEvent` (upsert + matcher run, slice-C enrichment on create, inferred-field carry-over on re-ingest); reused by the create route and the refresh route (`docs/CURRENT_EVENTS_PLAN.md` §9) |
| `functions/api/v1/_lib/events-matcher.ts` | Topical + temporal + geo scoring for current events — pure signals (curated topic-expanded term overlap, liveness-overlap, bbox-IoU) where topical relevance drives ranking and real-time/liveness boosts; `runMatcherForEvent` proposing `event_dataset_links` (`docs/CURRENT_EVENTS_PLAN.md` §4) |
| `functions/api/v1/_lib/events-store.ts` | `current_events` + `event_dataset_links` data access — storage layer for the source-agnostic current-events feature (`docs/CURRENT_EVENTS_PLAN.md`) |
| `functions/api/v1/_lib/feed-connectors-store.ts` | `feed_connectors` data access — the node-configurable current-events feed registry (which feeds this node ingests, enabled/disabled, one-row-deep run bookkeeping); read by the refresh route / importer, CRUD'd by the portal feeds page (`docs/CURRENT_EVENTS_PLAN.md` §9) |
| `functions/api/v1/_lib/featured-datasets.ts` | `featured_datasets` row helpers |
| `functions/api/v1/_lib/frames-manifest.ts` | Helpers shared by the Phase 3pg/B `/frames` endpoints |
| `functions/api/v1/_lib/github-dispatch.ts` | GitHub repository_dispatch helper — Phase 3pd |
| `functions/api/v1/_lib/hero-override-store.ts` | `hero_override` singleton row helpers |
| `functions/api/v1/_lib/blog-store.ts` | `blog_posts` data access (Phase 3d) — draft-born rows, stable slugs (allocated once, dataset-slug rules with a `post` fallback), publish/unpublish transitions keeping the first publish time, body validation with bounded fields, and the public KV cache keys + bust helper |
| `functions/api/v1/_lib/blog-generate.ts` | AI blog-draft generation (Phase 3d) — grounded prompt builder over the node profile + cited event + dataset facts ('invent nothing beyond them'), Workers AI call with a 30 s timeout race via the shared reply-envelope extractor, JSON draft parsing with bounded fields; unbound AI / unusable replies are typed failures, not silent fallbacks |
| `functions/api/v1/_lib/node-profile-store.ts` | `node_profile` singleton row helpers — read/upsert + body validation (bounded prose fields, http(s)-only links) for the host-organization profile (Phase 3d) |
| `functions/api/v1/_lib/node-settings-store.ts` | `node_settings` singleton row helpers — the per-node feature toggles (`src/types/node-features.ts`): read/upsert + body validation, and the fail-open KV-cached `getEffectiveFeatures` hot-path read the `/publish` middleware gate and gated public handlers consume |
| `functions/api/v1/_lib/iso-duration.ts` | Minimal ISO 8601 duration parser scoped to the shapes the catalog's `period` column carries |
| `functions/api/v1/_lib/job-queue.ts` | Asynchronous job queue interface — Phase 1b |
| `functions/api/v1/_lib/loopback.ts` | Loopback hostname check — shared by the publish middleware's `DEV_BYPASS_ACCESS=true` gate and the asset-complete handler's `MOCK_R2=true` gate |
| `functions/api/v1/_lib/preview-token.ts` | Short-lived signed preview tokens for unpublished datasets and tours |
| `functions/api/v1/_lib/publisher-mutations.ts` | Admin user-administration store helper — list / get / update publishers, self-lockout + last-admin guardrails |
| `functions/api/v1/_lib/publisher-store.ts` | D1 reader / writer for the `publishers` table |
| `functions/api/v1/_lib/capabilities.ts` | Server-side capability check (`can` / `canOwnOrAny`) — thin adapter over the shared role→capability matrix (`src/types/publisher-roles.ts`); the authorization primitive routes/mutations gate on (`docs/PUBLISHER_ROLES_PLAN.md`) |
| `functions/api/v1/_lib/r2-public-url.ts` | Build a publicly-readable URL for an R2 object key |
| `functions/api/v1/_lib/image-upload.ts` | Shared validation for small direct image uploads (base64-in-JSON): png/jpeg/webp allowlist, magic-byte check against the claimed type, bounded decode, sha256 for content-addressed keys — used by the node-profile logo and tour-media routes |
| `functions/api/v1/_lib/r2-store.ts` | R2 storage helpers — Phase 1b |
| `functions/api/v1/_lib/search-datasets.ts` | Vector search over the dataset catalog — Phase 1c |
| `functions/api/v1/_lib/snapshot.ts` | KV-backed snapshot cache for the public catalog response |
| `functions/api/v1/_lib/sphere-thumbnail-job.ts` | Sphere-thumbnail generation job — Phase 1b |
| `functions/api/v1/_lib/stream-store.ts` | Cloudflare Stream helpers — Phase 1b |
| `functions/api/v1/_lib/test-helpers.ts` | Test helpers — adapters that let Vitest exercise the catalog route handlers against real SQL (better-sqlite3) and an in-memory KV map |
| `functions/api/v1/_lib/tour-mutations.ts` | Publisher-API write paths for the `tours` table |
| `functions/api/v1/_lib/ulid.ts` | Single source of truth for ULID minting on the publisher write paths |
| `functions/api/v1/_lib/validators.ts` | Field-level validators for the publisher-API write paths |
| `functions/api/v1/_lib/workflow-schedule.ts` | ISO-8601 duration parsing + `next_run_at` math for Zyra workflows |
| `functions/api/v1/_lib/workflow-store.ts` | D1 data layer for `workflows` + `workflow_runs` (incl. the due query and run-status transitions) |
| `functions/api/v1/_lib/workflow-validators.ts` | Workflow body validation — the stage/command allowlist boundary, metadata-template checks, run-status callbacks |
| `functions/api/v1/_lib/vectorize-store.ts` | Vectorize helpers — Phase 1c |

