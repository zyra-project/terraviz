# Zyra Workflow Integration — Real-Time Dataset Pipelines

How the publisher portal grows a **workflows** section: scheduled
[Zyra](https://github.com/NOAA-GSL/zyra) pipelines that render
sphere-ready MP4s (or frame sequences) and publish them into the
node catalog on a cadence — hourly GOES imagery, daily sea-ice
extent, weekly drought monitors — without an operator touching the
upload form. Companion to
[`CATALOG_PUBLISHING_TOOLS.md`](CATALOG_PUBLISHING_TOOLS.md)
(portal conventions),
[`CATALOG_ASSETS_PIPELINE.md`](CATALOG_ASSETS_PIPELINE.md) (asset
flow the workflows feed into), and
[`CATALOG_IMAGE_SEQUENCE_PLAN.md`](CATALOG_IMAGE_SEQUENCE_PLAN.md)
(whose deferred Phase 2 "real-time append" this plan partially
answers); schema referenced from
[`CATALOG_DATA_MODEL.md`](CATALOG_DATA_MODEL.md).

> **Status: draft for review.** No code, no migrations, no new
> workflows yet. This doc scopes the integration, reviews Zyra's
> eight workflow stages against what TerraViz needs, and sequences
> the work into phases Z1–Z4. Decisions already made: workflow
> definitions live in D1 and are managed from the publish
> dashboard (not a separate repo — forked nodes must stay
> self-contained); the authoring UI is form-based vanilla TS (no
> React / zyra-editor embed); scheduled runs overwrite their
> target dataset in place.

---

## What Zyra is

Zyra (NOAA Global Systems Laboratory; canonical repo
[`NOAA-GSL/zyra`](https://github.com/NOAA-GSL/zyra) — the
`zyra-project/zyra` repo is a downstream mirror) is a Python
framework for reproducible data workflows: fetch scientific data,
decode and reshape it, render frames and videos, and push the
results somewhere. Pipelines are YAML files executed with
`zyra run pipeline.yaml`; each entry names a stage, a subcommand,
and its arguments, and stages stream bytes into each other.

```yaml
stages:
  - stage: acquire
    command: http
    args:
      url: https://example.com/model-output.grib2
      output: "-"
  - stage: process
    command: convert-format
    args:
      input: "-"
      format: netcdf
  - stage: visualize
    command: compose-video
    args:
      frames: ./frames
      output: dataset.mp4
```

Runtime overrides (`--set visualize.cmap=viridis`), `--dry-run`,
and `--continue-on-error` are built in; a DAG mode (`zyra swarm
--plan`) handles fan-out with `depends_on`. There is **no built-in
scheduler** — Zyra expects an external orchestrator, which is the
hole this plan fills with the node's own GitHub Actions.

Zyra also ships a FastAPI service (`zyra.api`) and a companion
visual editor ([`zyra-editor`](https://github.com/zyra-project/zyra-editor):
React 18 + XYFlow node graphs serialized to `pipeline.yaml`, with
per-node status badges and WebSocket log streaming). We borrow the
editor's *concepts* — stage palette, dry-run validation, run-status
badges — but not its stack; see §Non-goals.

### Prior art: zyra-scheduler

[`NOAA-GSL/zyra-scheduler`](https://github.com/NOAA-GSL/zyra-scheduler)
is a production template repo that already runs the core loop this
plan needs: GitHub Actions cron → Zyra acquire (FTP frame pulls) →
validate (a `frames-meta.json` integrity step) → `compose-video`
MP4 → upload (Vimeo / S3), with **twelve pre-configured real
datasets** (drought, SST, SST anomaly, fire, ozone, land
temperature, snow/ice, clouds, precipitation, …) — very likely the
automation behind the daily Vimeo re-uploads that
`cli/lib/realtime-title.ts` detects today. It proves the
render-on-schedule half of this plan in production and supplies
two design inputs adopted below: a published runner container
(`ghcr.io/noaa-gsl/zyra-scheduler`, pinned by digest) instead of
ad-hoc `pip install`, and a worked example of per-dataset
config (its `datasets/*.env` + per-dataset workflow wrappers are
the static-file equivalent of our D1-resident definitions). What
it does *not* cover is the TerraViz leg — metadata sidecar,
publish-API upload, run reporting — which is exactly the scope
Phase Z0 reduces to.

### The eight workflow stages

Zyra organizes every pipeline around eight named stages. Half are
implemented today, half are roadmap. The table below is the
stage-by-stage review of what TerraViz can use as-is, and where a
gap needs a tool on our side (or an upstream contribution).

| # | Stage (aliases) | Status upstream | Use for TerraViz | Gap / suggested tooling |
|---|---|---|---|---|
| 1 | **Import** (acquire, ingest) | Implemented — `zyra acquire http\|s3\|ftp\|vimeo` | Fetch source data: model output, satellite imagery, observation feeds | None blocking. THREDDS/OPeNDAP connectors would widen the NOAA catalog reach — note for upstream, not a prerequisite. |
| 2 | **Process** (transform) | Implemented — `decode-grib2`, `extract-variable`, `convert-format` | Decode GRIB2/NetCDF, subset variables, reproject | None blocking. |
| 3 | **Simulate** | Conceptual (no CLI) | — | Not needed; skip. |
| 4 | **Decide** (optimize) | Conceptual | — | Not needed for v1. Future: automatic colormap / contour-level selection for unattended renders. |
| 5 | **Visualize** (render) | Implemented — `heatmap\|contour\|timeseries\|vector\|animate\|compose-video\|interactive` | Render frames; `compose-video` produces the MP4 | **SOS preset.** Nothing enforces the sphere spec (4096×2048 equirectangular, 30 fps, H.264). v1: bake the constraints into our curated templates' ffmpeg args. Upstream candidate: a `--preset sos` for `compose-video`. **Thumbnail + legend.** No poster/legend output; v1 derives the thumbnail via an ffmpeg frame-grab in the runner, legend stays a template-supplied static asset. |
| 6 | **Narrate** | Conceptual (LLM captions/reports) | Dataset metadata: title, abstract, attribution | **Biggest gap.** TerraViz needs a metadata sidecar per run (see §Metadata sidecar). v1 generates it by template interpolation from the workflow config — no LLM in the loop. When upstream Narrate lands, LLM-drafted abstracts can slot in behind the same sidecar contract. |
| 7 | **Verify** | Conceptual (checksums, schema validation, provenance) | Pre-upload QA | v1 implements the preflight in our runner CLI: ffprobe dimensions / codec / fps / duration against the SOS spec, SHA-256 digests (the publish API requires them anyway), frame-count match for sequences. Track upstream Verify for provenance manifests later. |
| 8 | **Export** (disseminate, decimate) | Implemented — `zyra export local\|s3\|ftp\|post\|vimeo` | Hand off to TerraViz | **Deliberately unused for the upload.** Zyra exports to the runner's local disk; our publish CLI carries the bytes the rest of the way (rationale in §Integration principle). Upstream candidate once the contract is stable: a `zyra export terraviz` connector wrapping the same API flow. |

### Reprojection lives in Zyra, not the portal

**Decision.** The globe + thumbnail render stack assumes
**equirectangular** (plate carrée, EPSG:4326) imagery — the sphere
shader, `photorealEarth`, and the globe-thumbnail generator all map a
2:1 equirectangular texture onto the sphere. Reprojecting data from
other CRSs (polar-stereographic sea ice, geostationary full-disk,
Mercator, …) into that form is a **Zyra responsibility, not a
TerraViz one** — and explicitly *not* an in-browser feature nor a
bespoke step in our own runner.

Two cases, only one of which is a gap:

- **Native scientific data** (GRIB2 / NetCDF carrying its own grid /
  CRS). Already covered: Zyra's **Process** stage subsets + reprojects
  and **Visualize** renders equirectangular frames (rows 2 & 5 above).
  This is Zyra's core competency; nothing new is needed on our side.
- **An already-rendered raster in a non-equirectangular projection**
  (e.g. a polar-stereographic PNG someone produced offline). This is
  the genuinely missing capability — a `process` `reproject`
  (warp-to-EPSG:4326) command. It belongs **upstream in
  `NOAA-GSL/zyra`**, where the Python geospatial stack (GDAL / pyproj /
  rasterio) already lives, so every Zyra consumer benefits and it's
  maintained once rather than reinvented per node.

**TerraViz's footprint is an allowlist entry + a curated template,**
once that command lands: add the subcommand to `ZYRA_STAGE_ALLOWLIST`
(`src/types/zyra-workflow-constants.ts`) and ship a
"reproject → visualize → publish" template. We **deliberately do not
whitelist it yet** — the allowlist is coupled to a pinned Zyra runner
container digest, so the entry waits until the upstream command set
has solidified.

**Manual-upload boundary.** The one-off asset/upload form has no Zyra
in the loop, so it can't reproject. Source imagery there must already
be equirectangular (EPSG:4326); the form says so and points at
`gdalwarp -t_srs EPSG:4326`. Supporting arbitrary projections on the
manual path would require a server-side warp step — out of scope and
demand-gated.

### Integration principle: everything through the publish API

Zyra's S3 export could conceivably write into R2 directly (R2 is
S3-API-compatible and `cli/transcode-from-dispatch.ts` already
drives it that way), and a sufficiently privileged job could write
D1 rows. **Neither happens in this design.** All catalog mutations
go through the existing publisher API — that's where digest
verification, the append-only audit log, the `transcoding` overlap
guard, and transcode orchestration live — and asset bytes travel
over the presigned-PUT URLs the API hands out. A workflow run is,
from the backend's point of view, indistinguishable from a very
punctual service-token publisher. No new write paths into D1 or
the catalog R2 prefixes are introduced.

---

## Architecture

### Workflows live in D1; execution lives in the node's own GHA

A self-hosted node already carries everything a runner needs: the
repo fork (with `.github/workflows/transcode-hls.yml`), repo
secrets (`R2_*`, `CF_ACCESS_CLIENT_ID/SECRET`), and a Cloudflare
Access service token. The fork **is** the runner repo. Workflow
*definitions* — the pipeline YAML, the schedule, the metadata
template, the target dataset — live in D1 next to the datasets
they maintain, managed entirely from the portal. Forking a node
forks its automation capability with zero extra repositories.

```
            ┌─ portal /publish/workflows (CRUD, run-now, history)
            ▼
   D1: workflows, workflow_runs
            ▲      │
   GET /due │      │ repository_dispatch (zyra-run)
            │      ▼
   zyra-scheduler.yml (cron :15) ──► zyra-run.yml
                                       │ pip install zyra + ffmpeg
                                       │ zyra run pipeline.json → MP4/frames + sidecar
                                       ▼
                                     cli/zyra-publish-from-dispatch.ts
                                       │ verify → PATCH metadata → asset init
                                       │ → presigned PUTs → complete
                                       ▼
                          existing transcode-hls pipeline → HLS in R2
```

### Data model

One migration under `migrations/catalog/`, two tables:

```sql
-- A registered, schedulable Zyra pipeline.
CREATE TABLE workflows (
  id                 TEXT PRIMARY KEY,   -- ULID
  publisher_id       TEXT NOT NULL REFERENCES publishers(id),
  name               TEXT NOT NULL,
  description        TEXT,
  pipeline_json      TEXT NOT NULL,      -- the Zyra pipeline, canonical JSON (authored as YAML in the portal, converted client-side)
  metadata_template  TEXT NOT NULL,      -- sidecar template JSON (§Metadata sidecar)
  schedule           TEXT NOT NULL,      -- ISO-8601 duration (PT1H, P1D) — same vocabulary as datasets.period
  enabled            INTEGER NOT NULL DEFAULT 0,
  target_dataset_id  TEXT NOT NULL REFERENCES datasets(id),
  update_mode        TEXT NOT NULL DEFAULT 'overwrite',  -- only mode in v1
  last_run_at        TEXT,
  next_run_at        TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- One row per execution; append-only apart from status transitions.
CREATE TABLE workflow_runs (
  id            TEXT PRIMARY KEY,        -- ULID
  workflow_id   TEXT NOT NULL REFERENCES workflows(id),
  status        TEXT NOT NULL,           -- queued | running | succeeded | failed | canceled
  started_at    TEXT,
  finished_at   TEXT,
  gha_run_id    TEXT,                    -- link target for the portal's log button
  upload_id     TEXT,                    -- asset_uploads row the run produced, if it got that far
  error_summary TEXT
);
```

`schedule` reuses the ISO-8601 duration vocabulary of
`datasets.period` rather than cron syntax: the portal offers
period presets, the values round-trip into the dataset's own
`period` field, and nobody has to validate five-field cron
strings. `next_run_at` is computed server-side on save and after
each run.

The pipeline is **stored as canonical JSON, not YAML**. Zyra
accepts JSON manifests natively, the portal converts the YAML
authoring surface to JSON client-side, and the Worker then
validates plain JSON — keeping a YAML parser out of the Pages
Functions bundle entirely.

### API surface

New routes under `functions/api/v1/publish/workflows/**`, behind
the same Access middleware as the rest of `/publish`:

| Method + path | Caller | What |
|---|---|---|
| `GET /api/v1/publish/workflows` | portal | List visible workflows (role-aware, like datasets). |
| `POST /api/v1/publish/workflows` | portal | Create. Validates pipeline JSON + template + schedule; computes `next_run_at`. |
| `GET /api/v1/publish/workflows/{id}` | portal | Detail. |
| `PATCH /api/v1/publish/workflows/{id}` | portal | Edit; re-validates; recomputes `next_run_at`. |
| `POST /api/v1/publish/workflows/{id}/validate` | portal | Static validation only — stage/command allowlist, arg shape, template fields. The deeper `zyra run --dry-run` happens in the runner, not the Worker (no Python at the edge). |
| `POST /api/v1/publish/workflows/{id}/run` | portal | Manual "Run now": inserts a `queued` run, fires `repository_dispatch` (reusing `functions/api/v1/_lib/github-dispatch.ts`). |
| `GET /api/v1/publish/workflows/due` | scheduler (service token) | Workflows with `enabled=1 AND next_run_at <= now` and no run currently `queued`/`running`. |
| `GET /api/v1/publish/workflows/{id}/runs` | portal | Paginated run history. |
| `POST /api/v1/publish/workflows/{id}/runs/{run_id}/status` | runner (service token) | Lifecycle callbacks: running → succeeded/failed (+ `gha_run_id`, `upload_id`, `error_summary`). |

### Scheduler

`.github/workflows/zyra-scheduler.yml`: a `schedule:` cron firing
every 15 minutes that calls `GET /workflows/due` with the service
token, then POSTs `/workflows/{id}/run` (`{"trigger":"schedule"}`)
per due workflow. The **Worker** owns run-row creation and fires
the `zyra-run` `repository_dispatch` itself, with the
`GITHUB_DISPATCH_TOKEN` it already holds for transcode dispatches —
the scheduler job needs no GitHub credentials beyond the keepalive
step's own `GITHUB_TOKEN`. The dispatch payload carries only
identifiers (`workflow_id`, `run_id`) — the runner fetches the
pipeline definition from the API, so a stale dispatch can never
execute a stale pipeline.

GHA cron granularity is 5 minutes and real-world jitter is
minutes-scale under load. For the hourly-and-slower cadences this
plan targets, that is acceptable; the green "real-time" marker in
the catalog already tolerates a 24-hour window. If a future
dataset genuinely needs tight timing, the named alternative is a
minimal Cloudflare Worker with a Cron Trigger calling the same
`/due` → dispatch sequence — Pages Functions themselves cannot
have scheduled handlers, so this would be the project's first
standalone Worker and is deliberately deferred until something
needs it.

Two GitHub-imposed gotchas around scheduled workflows, both with
mitigations the scheduler must ship with:

- **The 60-day inactivity disable.** In public repositories,
  scheduled workflows are automatically disabled after 60 days
  without repository *activity* (commits — workflow runs don't
  count). The timer resets whenever the workflow is re-enabled via
  the API, so the scheduler keeps itself alive: a final step calls
  the [enable-workflow endpoint](https://docs.github.com/en/rest/actions/workflows#enable-a-workflow)
  (`PUT /repos/{owner}/{repo}/actions/workflows/{id}/enable`) with
  its own `GITHUB_TOKEN` (`permissions: actions: write`) — the
  pattern the marketplace
  [keepalive-workflow](https://github.com/marketplace/actions/keepalive-workflow)
  action wraps in API mode, with no dummy commits. Limitation: a
  workflow that has already been disabled for a full cycle never
  runs the step that would revive it, so a long-dormant node still
  needs one manual re-enable.
- **Forks start disabled.** Scheduled workflows in a forked
  repository are disabled by default, and `GITHUB_TOKEN` cannot
  bootstrap a workflow that has never run. `docs/SELF_HOSTING.md`
  must include the one-time "enable the scheduler in the Actions
  tab" step.

The Worker Cron Trigger alternative is immune to both, which is a
second argument for it beyond timing precision if either
mitigation proves annoying in practice.

### Runner

`.github/workflows/zyra-run.yml`, triggered by the `zyra-run`
dispatch, structured like `transcode-hls.yml`:

The job declares a GHA `concurrency:` group keyed on
`workflow_id`, a third layer of overlap protection behind the
`/due` skip and the `transcoding` guard.

1. **Validate payload** — `workflow_id` + `run_id` present.
2. **Checkout + toolchain** — Node 22 (`npm ci`) for the publish
   CLI; Zyra runs in the
   [`ghcr.io/noaa-gsl/zyra-scheduler`](https://github.com/NOAA-GSL/zyra-scheduler)
   container **pinned by digest** (the digest is the Zyra version
   pin — the `/validate` stage/command allowlist is coupled to it
   and both are bumped together, deliberately). Fallback if the
   image ever stops being published: `pip install zyra==X.Y.Z`,
   pinned, + `apt-get install ffmpeg`.
3. **Fetch definition** — `GET /workflows/{id}` with the service
   token; write `pipeline.json` and the metadata template to the
   workdir; POST `running` status.
4. **Execute** — `zyra run pipeline.json`. The pipeline's final
   stage exports to the local workdir: `dataset.mp4` (or a
   `frames/` directory) plus whatever intermediates it wants.
5. **Sidecar** — render `terraviz-dataset.json` from the template
   (§Metadata sidecar).
6. **Publish** — `npx tsx cli/zyra-publish-from-dispatch.ts`, a
   sibling of `transcode-from-dispatch.ts` following its
   conventions (env vars, `--cleanup-on-failure`, small numbered
   exit codes):
   - *Preflight (Verify-stage stand-in):* ffprobe the MP4 —
     dimensions, codec, fps, duration — against the SOS spec;
     compute SHA-256 digests; for frame sequences, check count and
     naming.
   - *Metadata:* `PATCH /publish/datasets/{target}` with the
     sidecar fields (title, abstract, `start_time`, `end_time`,
     `period`, …).
   - *Asset:* `POST .../asset` (single MP4 or `frames[]` payload)
     → presigned PUTs → `POST .../asset/{upload_id}/complete`.
     From here the existing transcode pipeline takes over and
     `transcode-complete` flips `data_ref` exactly as it does for
     portal uploads.
   - *Report:* POST `succeeded` (with `upload_id`) or `failed`
     (with a truncated, secret-free `error_summary`).

### Update model: overwrite in place

Each run re-publishes to the **same** `target_dataset_id` under a
fresh `upload_id`. This is the pattern the backend was already
built to make safe: R2 keys are versioned per upload
(`uploads/{dataset}/{upload}/…`, `videos/{dataset}/{upload}/…`),
`data_ref` swaps atomically on `transcode-complete`, and the
`transcoding` / `active_transcode_upload_id` guards reject an
overlapping upload — a run that fires while the previous encode is
in flight fails fast and reports, rather than racing. The catalog
keeps one stable entry per real-time product, so deep links,
playlists, and visit memory stay valid. Old upload prefixes become
garbage to collect — an operator concern noted in §Open questions,
not a correctness one.

This is also the honest v1 answer to
[`CATALOG_IMAGE_SEQUENCE_PLAN.md`](CATALOG_IMAGE_SEQUENCE_PLAN.md)
§Phase 2's deferred "real-time append": scheduled full re-upload
is that doc's option A, automated. If publisher usage ever
justifies option B (segment append), it slots in behind
`update_mode` without touching the workflow contract.

---

## Metadata sidecar — `terraviz-dataset.json`

The contract between a pipeline run and the publish step. v1 is a
template stored on the workflow row and interpolated by the runner
— no LLM, no new dependencies:

```jsonc
{
  "title": "GOES-West GeoColor — {{run_date}}",
  "abstract": "Latest full-disk GeoColor imagery, updated hourly…",
  "categories": ["Atmosphere"],
  "keywords": ["goes", "satellite", "real-time"],
  "start_time": "{{data_start}}",   // resolved by the runner from pipeline output
  "end_time": "{{data_end}}",
  "period": "PT1H",                  // mirrors workflows.schedule
  "license_spdx": "CC-BY-4.0",
  "attribution_text": "NOAA / NESDIS"
}
```

Template variables come from the run context (`run_date`,
`run_id`) and from pipeline output where derivable (`data_start` /
`data_end` from frame timestamps). Fields map 1:1 onto the
existing dataset PATCH surface — the sidecar invents no new
metadata vocabulary. When Zyra's Narrate stage ships, an
LLM-drafted abstract can replace the static template string behind
the same file format.

---

## Portal UI — `/publish/workflows`

Form-based vanilla TS, per the conventions in
[`CATALOG_PUBLISHING_TOOLS.md`](CATALOG_PUBLISHING_TOOLS.md)
(lazy-loaded chunk, History-API router, `publisher.workflows.*`
i18n keys, logical CSS properties). Three pages, reusing the
existing `dataset-form` patterns, `chip-input`, `error-card`, and
`topbar` components:

- **List** (`/publish/workflows`) — name, schedule, target
  dataset, enabled toggle, last-run status badge
  (queued / running / succeeded / failed — the zyra-editor badge
  vocabulary).
- **New / edit** (`/publish/workflows/new`, `…/{id}/edit`) —
  metadata-template fields, schedule preset picker, target-dataset
  selector, and the pipeline itself: seeded from **curated
  templates** ("GRIB2 → heatmap frames → SOS MP4", "image URL list
  → frame sequence") with an advanced raw-YAML textarea for
  everything else. A **Validate** button calls `/validate`; **Run
  now** calls `/run`.
- **Run history** (`/publish/workflows/{id}`) — per-run status,
  timestamps, `error_summary`, and a link out to the GHA run via
  `gha_run_id`.

What this deliberately is *not*: a node-graph editor. zyra-editor
exists for users who want that; its exported `pipeline.yaml`
pastes straight into the raw-YAML textarea, which is the entire
interop story and costs nothing to maintain.

---

## Security model

Pipeline YAML is user-supplied execution config that runs inside
the node's GitHub Actions with repo secrets in scope. Containment,
in order of importance:

1. **Who can author.** Workflow CRUD gates on the
   `workflows.manage` capability — `editor`, `admin`, and
   `service` in the five-role matrix. (This doc originally said
   "staff", a pre-five-role term that never existed as a role;
   issue #305 resolved the mismatch in favor of editor as the
   trusted human role.) Community publishers don't get the
   surface. Relaxing this is a §Open questions item, not a v1
   feature.
2. **What can run.** `/validate` — enforced again at dispatch
   time, not just at save — checks every stage/command pair
   against a server-side allowlist (the implemented Zyra stages
   and their documented subcommands) and rejects unknown keys.
   Zyra stages are declarative, not shell, which keeps the
   allowlist meaningful.
3. **What the run can reach.** The runner job gets the same secret
   set the transcode job already has; Zyra itself receives
   **none** of them — it reads public data sources and writes to
   the local workdir. Only `cli/zyra-publish-from-dispatch.ts`
   touches the service token and presigned URLs.
4. **What comes back.** `error_summary` is truncated and stripped
   of anything env-shaped before the status callback, mirroring
   the sanitization stance in `src/analytics/errorCapture.ts`.

---

## Phases

| Phase | Scope | Demoable state |
|---|---|---|
| **Z0 — spike** | Adapt one [`zyra-scheduler`](https://github.com/NOAA-GSL/zyra-scheduler) dataset (e.g. drought): run its pipeline in a manually-triggered GHA workflow, swap the Vimeo/S3 upload leg for a hand-rolled publish-API sequence against a dev node, ffprobe-assert the MP4 against the SOS spec, record real per-run minutes. Also settles open question 2 (`zyra export s3` vs R2) empirically. No schema, no portal, throwaway code allowed. **Artifacts landed:** `.github/workflows/zyra-spike.yml` + `cli/zyra-spike-publish.ts` — trigger via Actions → "Zyra Spike (Z0)". | A real NOAA real-time dataset lands in a dev catalog from a button press; the Z1 contract is built on observed behaviour, not docs. |
| **Z1 — contract + runner** | Migration (`workflows`, `workflow_runs`); CRUD + `due` + `run` + status routes; `zyra-scheduler.yml` + `zyra-run.yml`; `cli/zyra-publish-from-dispatch.ts` with the Verify preflight; sidecar template spec. Authoring via API / raw YAML only. **Artifacts landed:** `migrations/catalog/0018_workflows.sql`; `functions/api/v1/publish/workflows/**` + the `_lib/workflow-{store,schedule,validators}.ts` trio; `src/types/zyra-workflow-constants.ts` (the shared stage allowlist); both GHA workflows; the runner CLI with `cli/lib/sos-spec.ts` + `cli/lib/workflow-sidecar.ts`. Surfaces marked `Z0-pending` in source (allowlist contents, runner-image pin, frames-meta shape) get re-verified against the spike run before Z1 merges. | An operator registers a pipeline with `curl`, and an hourly dataset updates itself end-to-end. |
| **Z2 — portal UI** | `/publish/workflows` list / new / edit / history pages; enable toggle; Run now; status badges. | A staff publisher manages workflows without leaving the dashboard. |
| **Z3 — guided authoring** | Curated pipeline templates; stage-form builder over the allowlist; richer validation surfacing; log links; a "Create draft dataset" button beside the target field that POSTs a minimal draft (workflow name + video/mp4) and fills the id in place — the new-workflow flow never leaves the page (gap confirmed in production: the form's hint sends the publisher off to do something the form can do itself). | A publisher who has never read Zyra docs ships a working hourly pipeline. |
| **Z4 — real-time UX + upstream** | SPA consumes `period` for freshness (the §7.4 marker driven by data, targeted catalog-cache bypass for due datasets); upstream proposals to NOAA-GSL/zyra (`--preset sos`, `export terraviz`, Narrate/Verify input); alignment with federation Tier 0 once Phase 4 ships. | The catalog visibly knows which datasets are live, and the Zyra-side ergonomics stop being our fork's problem. |

Authoring beyond Z3 — a source probe with pattern induction,
curated dataset-source presets, one-click upstream gap issues,
and an evidence-gated Orbit authoring mode — is scoped separately
in [`WORKFLOW_AUTHORING_PLAN.md`](WORKFLOW_AUTHORING_PLAN.md).

### Implementation conventions (Z1/Z2 checklist)

Repo table stakes, listed so no phase improvises them mid-flight:

- **Module maps.** Every new `functions/` / `cli/` module gets its
  row in [`BACKEND_MODULES.md`](BACKEND_MODULES.md); portal modules
  get CLAUDE.md rows. `check:doc-coverage` enforces both.
- **Tests.** Vitest coverage for the pure logic: `next_run_at`
  computation, the stage/command allowlist validator, sidecar
  template interpolation, run-status transitions.
- **Local dev.** The runner CLI is exercised exactly like the
  transcode CLI: run `cli/zyra-publish-from-dispatch.ts` directly
  against a `DEV_BYPASS_ACCESS` dev server, with the asset API's
  existing mock mode standing in for presigned R2.
- **Analytics.** New portal pages emit events per
  [`ANALYTICS_CONTRIBUTING.md`](ANALYTICS_CONTRIBUTING.md)
  (tier choice, throttling, reviewer checklist).
- **i18n.** All strings via `publisher.workflows.*` keys; logical
  CSS properties.
- **Z2 UX → owned by Z3.** Workflows reference an existing
  `target_dataset_id`; the "create draft dataset from the workflow
  form" affordance ships in Phase Z3 (see the phase table).

### Non-goals

- **Embedding zyra-editor.** React 18 + XYFlow inside a
  deliberately framework-free SPA fails the "vanilla TS with a few
  focused libraries" test; an iframe + postMessage embed (the
  `orbitPostMessageBridge.ts` precedent) additionally requires
  operating a FastAPI service per node. Paste-the-YAML is the
  interop.
- **Direct D1 / catalog-R2 writes from Zyra.** See §Integration
  principle.
- **Running Zyra at the edge.** Python + ffmpeg don't run on
  Workers; the runner is GHA by design.
- **A standalone scheduler service.** GHA cron is good enough for
  the target cadences; the Worker Cron Trigger alternative is
  named, costed, and deferred.
- **Community-publisher workflow authoring** in v1.
- **Append-based updates** in v1 — `update_mode` reserves the
  slot; `CATALOG_IMAGE_SEQUENCE_PLAN.md` Phase 2 owns the design.

### Relationship to federation

[`docs/architecture/federation-scoping.md`](architecture/federation-scoping.md)'s
Tier 0 is "a partner runs `terraviz publish dataset.yaml` on a
schedule against the canonical node." A Zyra workflow is the same
trust shape — a service-token publisher on a cadence — with the
node, not the partner, owning the schedule. When Phase 4 lands,
nothing here changes: workflow-maintained datasets federate like
any other rows. The one thing to keep aligned is the service-token
role vocabulary (`service` today; Tier 0 may refine it).

### Cost notes

Actions minutes are **free and unlimited for public repositories**
on standard GitHub-hosted runners (confirmed against the
[2026 pricing changes](https://resources.github.com/actions/2026-pricing-changes-for-github-actions/),
which keep public-repo usage free) — so on the canonical node,
hourly Zyra pipelines cost nothing in compute. The limits that do
apply to public repos are concurrency (20 jobs on the Free plan —
the scheduler should cap per-tick dispatch fan-out below that) and
the 6-hour job ceiling (irrelevant at this plan's render sizes).

The 2,000 min/month quota applies to **private** forks only. There,
an hourly workflow spending 4 minutes per run consumes ~2,900
min/month on its own — over the quota before transcode minutes —
while daily cadences are comfortable (~120 min/month each). The
portal should surface estimated monthly minutes next to the
schedule picker so a private-fork operator sees the math; hourly
cadences on a private fork mean a paid Actions plan or a
self-hosted runner.

Storage-side, overwrite-in-place leaks old `uploads/` and
`videos/` prefixes in R2 at one bundle per run until cleanup
exists (§Open questions).

---

## Real-time frame store: cache + recall

**Status: draft for review.** Closes two gaps between the v1 runner
and the scheduler's GitLab pipeline: a cross-run **frame cache** (so
a re-run doesn't re-fetch the whole window from FTP — the concern
that grows with frame count) and **frame recall** (the acquired and
padded frames exposed for individual download). They share one R2
footprint but answer to different lifecycles, so the design keeps
them as two prefixes, not one.

### Why R2, not the Actions cache

| | `actions/cache` | R2 frame store |
|---|---|---|
| Size | 10 GB per-repo, evicted after 7 days idle | effectively uncapped, durable |
| "A lot of files" | tars the whole set each run | sync only the delta |
| Mutability | keys immutable; needs rolling-key hacks to update | overwrite / prune in place |
| Individual recall | no — opaque archive | yes — each frame its own object |
| Padded→real replacement | awkward | natural (re-enables `--prefer-remote-if-meta-newer`) |

The cache fights you on exactly the datasets this is for (many
files), and can't deliver recall — so the store is R2, doubling as
cache and durable archive.

### Two prefixes, two lifecycles

| Concern | R2 prefix | Lifecycle | Read by |
|---|---|---|---|
| **Cache** (working set) | `workflow-frames/{dataset_id}/` (mutable) | restored at run start, saved at run end, **pruned to the active window** | the runner only (private) |
| **Recall** (published snapshot) | `uploads/{dataset_id}/{upload_id}/frames/{NNNNN}.{ext}` (immutable) | one snapshot per run, GC'd by the upload-retention rule (§Open questions #1) | public `/frames` + `/frames/{index}` |

Recall is **not a new surface.** The image-sequence asset path
(Phase 3pf/3pg) already uploads a frame sequence, transcodes it to
the playable HLS bundle **and** sets the row's `frame_count` /
`frame_extension` / `frame_source_filenames_ref` columns that
`/frames` serves. So a real-time workflow gets recall by publishing
its run's padded frames through the frames `asset` flow — the same
flow a portal frame-upload uses — rather than a pre-composed MP4.
`renderFrameDisplayName` reconstructs each frame's timestamp from
`start_time + period × index`, which stays correct run-to-run
precisely because `pad-missing` guarantees a contiguous,
cadence-complete sequence to re-index against.

### Cache: restore → acquire-delta → save → prune

The runner gains two phases on either side of `zyra run`, siblings
of the existing publish phases and reusing `cli/lib/r2-upload.ts`
(`AwsClient`, `parseListKeys`, `uploadR2Object`, `deleteR2Object`)
with the `R2_S3_ENDPOINT` / `R2_ACCESS_KEY_ID` /
`R2_SECRET_ACCESS_KEY` secrets `transcode-from-dispatch.ts` already
consumes:

- `--phase=restore-frames` — list `workflow-frames/{dataset_id}/`,
  download into the workdir's frames dir **before** the container
  runs. `acquire --sync-dir` then only pulls FTP deltas.
- `--phase=save-frames` — upload new/changed frames back **after**
  compose, then **prune**: delete any cache object whose timestamp
  falls outside the active window (`since-period` back from the
  run — the same span the video shows). The cache is bounded by
  cadence × window, never by how long the workflow has run.

Persisting frames across runs is also what makes
**padded→real freshening** possible — the capability the scheduler
gets from `acquire --prefer-remote-if-meta-newer`. We do it
runner-side rather than via that static flag (a static pipeline
can't condition the flag on a frames-meta that doesn't exist on the
first, cold-cache run), and more simply than a restore-side marker:
**synthetic frames are kept out of the cache.** `save-frames` reads
the `pad-missing` report's `created_files`, excludes those frames
from the upload, and prunes any stale synthetic copy already in the
cache. So the next run restores only real frames, `acquire
--sync-dir` re-fetches a frame that has since landed upstream, and
`pad-missing` re-creates the ones still genuinely missing.

This is the *enabler* of replacement, not a removal from the
dataset — and the distinction matters for TerraViz, where a frame
sequence must have **no time gaps** or the playback time label
desyncs. Two invariants make that safe:

- **The published output is always the full, contiguous post-pad
  set.** `pad-missing` runs inside the pipeline, and the publish
  step reads `/work/images/frames` *after* it; `save-frames` only
  reads that directory and writes the R2 cache, never mutating the
  local frames the publish step uploads. Padded frames are always in
  the published dataset.
- **Caching a padded frame would *block* its replacement.** A padded
  frame occupies the exact filename (timestamp) the real frame would
  have, and `acquire --sync-dir` skips filenames already present —
  so a cached padding would be skipped forever. Keeping it out of
  the cache is what lets `acquire` fetch the real frame the first run
  it exists.

No marker, no restore-side change — a refinement on top of the plain
cache, sequenced after it.

### Non-goals

- **No new public route** — recall reuses `/frames`; the only new
  HTTP work is the runner publishing frames instead of an MP4.
- **No second bucket** — both prefixes live in `terraviz-assets`.
- **Not a general object cache** — frames only, keyed per dataset.
- Restricted-row presigned frame GETs stay a Phase 4 concern.

### Staging

1. **Cache + prune** (runner-only; no API/DB change) — the R2 frame
   sync helper (`cli/lib/r2-frames.ts`), the two runner phases
   (`restore-frames` / `save-frames`), the `zyra-run.yml` wiring,
   window-prune to keep only the active window. Best-effort: a cache
   miss or R2 hiccup logs a warning and the run proceeds, so the
   cache can never break a workflow.
2. **Padded→real freshening** — `save-frames` keeps the
   `pad-missing` report's synthetic frames out of the cache, so the
   next run's acquire can replace them with the real frames once
   they land (runner-side, no zyra flag — see above).
3. **Recall** — publish the run's padded frames via the
   image-sequence asset path so `/frames` lights up. The one
   behavioural shift to confirm at this step: a recall-enabled
   workflow publishes a **frame sequence** (which transcodes to the
   same HLS video) rather than a pre-composed MP4 — `compose-video`
   becomes redundant in those templates.

---

## Open questions

1. **Stale upload garbage collection.** Each run strands the
   previous `uploads/{id}/{upload}/` and `videos/{id}/{upload}/`
   prefixes. A retention rule (keep last N, delete older on
   `transcode-complete`) wants to live in the existing pipeline,
   not the workflow layer — but it changes behaviour for manual
   re-uploads too. Decide there. (This is the **recall snapshot**
   retention; the **frame cache**'s window-prune is separate and
   runner-local — see §Real-time frame store.)
2. **`zyra export s3` against R2.** Unverified whether Zyra's S3
   connector honors a custom endpoint URL. Moot for v1 (the
   publish CLI carries the bytes) but worth confirming upstream
   before proposing `export terraviz`.
3. **Failure escalation.** A workflow that fails every hour fills
   `workflow_runs` and nobody notices. Minimum viable: auto-disable
   after N consecutive failures + a status banner in the portal.
   Email/webhook fan-out belongs to the deferred 3pj work. An
   agent-assisted *diagnosis* hook for these failures (headless,
   behind the run-status contract) is conditionally approved in
   [`AGENT_SDK_EVALUATION.md`](AGENT_SDK_EVALUATION.md), gated on
   this table's observed non-transient failure rate.
4. **Community publishers.** The v1 staff-only restriction is a
   trust decision, not a technical one. Revisit alongside the
   Phase 6 review-queue (`submitted_at` / `approved_at`) — a
   review-gated workflow registration could reuse it.
5. **Concurrent runs of one workflow.** `/due` skips workflows
   with an active run, and the `transcoding` guard backstops the
   upload; is that enough, or does `workflow_runs` need a hard
   uniqueness constraint on (workflow_id, active-status)?
6. **Where curated templates live.** Hard-coded in the portal
   chunk (versioned with the app) vs. rows in D1 (editable per
   node without a deploy). v1 leans hard-coded; revisit when a
   second node wants different templates.
