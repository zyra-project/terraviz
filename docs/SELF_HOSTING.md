# Self-hosting Terraviz

End-to-end walkthrough for deploying your own Terraviz instance on
Cloudflare Pages with a custom domain, the analytics pipeline, the
admin endpoints, the catalog backend (Phase 1 onward — datasets,
tours, publisher API, semantic search), and (optionally) Grafana
dashboards. Plan ~60–90 minutes for a clean run-through; add ~30
for the catalog stack if you want the publisher API + Vectorize-
backed search; less overall if you already have a Cloudflare-
managed domain.

This doc is the "fork it, run it yourself" path. If you're a
contributor working on the upstream repo, see
[`ANALYTICS_CONTRIBUTING.md`](ANALYTICS_CONTRIBUTING.md) instead.

> **Heads up on the catalog stack (Phase 8 below).** The
> click-by-click Cloudflare-dashboard instructions live in
> [`CATALOG_BACKEND_DEVELOPMENT.md` "Production deployment
> checklist"](CATALOG_BACKEND_DEVELOPMENT.md#production-deployment-checklist--first-deploy-walkthrough).
> This file gives the longer-form story — what each binding does,
> when you actually need it, and how the post-deploy verification
> (`terraviz verify-deploy`, `npm run check:pages-bindings`) closes
> the loop. Read both side-by-side: this doc for the why, that
> doc for the exact click sequence.

---

## Prerequisites

| Requirement | Why |
|---|---|
| **Cloudflare account on Workers Paid ($5/month)** | Analytics Engine isn't on the free plan. Without it the telemetry pipeline silently no-ops. |
| **A domain managed by Cloudflare DNS** | For your custom hostname (e.g. `terraviz.your-org.org`). Doesn't have to be a freshly registered one — moving DNS to Cloudflare is free. |
| **Node.js 20+** and **npm** | Build/test/deploy. |
| **`wrangler` CLI** | One-time KV namespace + key operations. `npm install -g wrangler && wrangler login` |
| **GitHub or GitLab account** | Cloudflare Pages connects to a Git remote for auto-deploys. |
| **An LLM API key or local LLM** *(optional)* | Only needed if you want the Orbit chat assistant working. Compatible with any OpenAI-style endpoint. |
| **A Grafana instance** *(optional)* | For visualizing analytics. Grafana Cloud free tier is fine. |

---

## Phase 1 — Local clone

```bash
git clone https://github.com/<you>/terraviz.git
cd terraviz
npm install
npm run dev          # http://localhost:5173
```

The app runs against public NASA GIBS tiles with no backend. The
chat panel will fall back to its local engine if no LLM is wired
up. Confirm the globe renders, you can browse datasets, and play a
video dataset before continuing.

---

## Phase 2 — Cloudflare Pages project

### 2a. Push your fork to GitHub

The Pages dashboard's git connector authenticates against
GitHub/GitLab and watches for pushes.

### 2b. Create the Pages project

1. **Cloudflare dashboard → Workers & Pages → Create application →
   Pages → Connect to Git**
2. Authorize, pick your fork
3. **Build settings**:
   - Framework preset: **None** (the repo's `vite.config.ts`
     already does the right thing)
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Root directory: leave empty
4. **Environment variables (build)** — set these *before* the
   first deploy so the build picks them up:
   - `VITE_BUILD_CHANNEL=public` (or `internal` for staff
     dogfood, `canary` for a staged rollout)
   - `VITE_TELEMETRY_ENABLED=true`
   - **Optional** `VITE_DEFAULT_UI_SCALE=1.5` — sets the
     first-launch UI size for visitors who have never picked
     a preset. The SOS deployment uses `1.5` to ship a
     comfortable size for its kiosk audience; default
     installs leave it unset and boot at `1.0`. Accepted
     values land in [0.5, 2.0]; anything outside that
     collapses to `1.0`. A visitor's later choice in
     Tools → Display always wins over the env default.
5. **Save and Deploy**

The first deploy will succeed but most backend features won't work
yet — that's normal. We wire them up in phases below.

### 2c. Custom domain

Pages → your project → **Custom domains → Set up a custom
domain** → enter your hostname (e.g. `terraviz.your-org.org`).
Cloudflare auto-creates the CNAME if your DNS is on Cloudflare.

---

## Phase 3 — Backend services

> ⚠️ **Cloudflare Pages does not auto-read `wrangler.toml` for
> bindings.** Every binding below must be added through the
> dashboard. The repo's `wrangler.toml` exists for documentation
> and for future migrations to a Workers deploy. The names below
> match what the function code expects — if you change them, you
> have to edit the function code too.

For each binding, attach it to **both Production and Preview
environments** (the environment selector is at the top of the
Bindings page). Otherwise preview deploys silently no-op the
write/read.

### 3a. D1 — Feedback database (required for the in-app feedback form)

```bash
wrangler d1 create sphere-feedback         # outputs an ID
```

Apply the schema:
```bash
wrangler d1 migrations apply sphere-feedback --remote
```

Pages → Settings → Bindings → Add binding → **D1**:
- Variable name: `FEEDBACK_DB`
- D1 database: select `sphere-feedback`

### 3b. Workers AI — Catalog enrichment + summarization

Pages → Settings → Bindings → Add binding → **Workers AI**:
- Variable name: `AI`

Free tier covers ~10k requests/day. Used by the dataset enrichment
service to summarize abstracts and generate keywords.

### 3c. Analytics Engine — Telemetry pipeline

Cloudflare dashboard → **Workers & Pages → Analytics Engine →
Create Dataset**:
- Dataset Name: `terraviz_events`
- Dataset Binding: leave empty (we set the binding at the project
  level, not the dataset level)

Then back in your Pages project → Settings → Bindings → Add
binding → **Analytics Engine**:
- Variable name: `ANALYTICS`
- Dataset: `terraviz_events`

### 3d. KV — Telemetry kill switch

```bash
wrangler kv namespace create TELEMETRY_KILL_SWITCH
# outputs an ID like 9c022b1295314939b76a28769fef6195
```

Pages → Settings → Bindings → Add binding → **KV**:
- Variable name: `TELEMETRY_KILL_SWITCH`
- KV namespace: select the one just created

The kill switch lets you flip telemetry off without redeploying:

```bash
# Stop accepting telemetry (clients receive 410 + Retry-After: 300)
wrangler kv key put telemetry_enabled disabled \
  --namespace-id=<id>

# Resume normal operation
wrangler kv key delete telemetry_enabled --namespace-id=<id>
```

You'll likely never use this, but the asymmetry is favourable: 5
minutes to set up, instant emergency lever forever after.

### 3e. Trigger a redeploy

Bindings only take effect on the next deployment. Either push a
trivial commit or hit **Deployments → ... → Retry deployment** on
the latest one. After the redeploy:

- The app should load at your custom domain
- The privacy disclosure banner should appear on first visit
- DevTools network tab should show 204 responses from
  `/api/ingest`

---

## Phase 4 — LLM proxy (optional, enables Orbit chat)

Two paths, depending on what LLM you want to use:

### 4a. Cloudflare AI Gateway (recommended)

1. Cloudflare dashboard → AI → AI Gateway → **Create Gateway**
2. Get your gateway URL: `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openai`
3. Pages → Settings → Environment variables (Production):
   - `LLM_PROVIDER_URL` = the gateway URL above
   - `LLM_PROVIDER_KEY` = your OpenAI/Anthropic/etc. API key
4. Redeploy

The `functions/api/[[route]].ts` proxy injects the key server-side
so it never reaches the browser bundle.

### 4b. Direct API (simpler but key-handling needs care)

Same as above without the gateway hop. Set `LLM_PROVIDER_URL` to
the provider's API endpoint directly.

### 4c. Local LLM (Ollama / LM Studio / llama.cpp)

For development only — Pages can't reach `localhost`. Configure in
the running app via Tools → Orbit Settings → API URL:
- Ollama: `http://localhost:11434/v1`
- LM Studio: `http://localhost:1234/v1`
- llama.cpp: `http://localhost:8080/v1`

The Tauri desktop app uses the same mechanism but routes through
the Tauri HTTP plugin to bypass webview CORS.

---

## Phase 5 — Cloudflare Access (admin endpoints + internal tagging)

Optional but recommended for any deployment with more than one
person. Without Access, admin endpoints fall back to a bearer token
(set via `FEEDBACK_ADMIN_TOKEN` env var); with it, your team SSOs
in via Google/Okta/etc.

### 5a. Set up Cloudflare Access

Zero Trust dashboard → **Access → Applications → Add an
application → Self-hosted**.

### 5b. Admin endpoints — Allow-only policy

Single application protecting the admin dashboard:
- **Application name**: `Terraviz Admin`
- **Destinations**: add `api/feedback-admin` to the
  `terraviz.pages.dev` domain AND your custom domain.
  The dashboard at this path also dispatches all dashboard /
  export / screenshot data through `?action=…` query parameters,
  so a single destination is enough to gate every admin
  operation.
- **Policies**: one policy, **Action: Allow**, **Include →
  Emails ending in → `your-org.org`** (or whatever pattern matches
  your team)

> The legacy stand-alone routes (`api/feedback-dashboard`,
> `api/feedback-export`, and the three `api/general-feedback-*`
> paths) still exist for direct scripting / break-glass under the
> `FEEDBACK_ADMIN_TOKEN` bearer fallback. If you also want them
> behind Access (so anyone hitting them in a browser is forced
> through SSO too), add them as destinations on the same app.
> Otherwise leave them off — the dashboard UI never touches them.

> ⚠️ **Use "Emails ending in", not "Emails".** The "Emails"
> selector requires exact-match against a single address. "Emails
> ending in" is the suffix match — what most teams want.

### 5c. Telemetry endpoint — Mixed-mode policy

Different from admin: this one passes public traffic through but
*tags* staff traffic as `internal=true` in the AE rows. Lets
dashboards filter staff dogfood out of metrics.

Single application:
- **Application name**: `Terraviz Telemetry`
- **Destinations**:
  - `terraviz.pages.dev/api/ingest`
  - `your-custom-domain.org/api/ingest`
- **Policies (in this exact order — the first match wins)**:
  1. Name: `Staff`, **Action: Allow**, **Include → Emails ending
     in → `your-org.org`**
  2. Name: `Public`, **Action: Bypass**, **Include → Everyone**

The Allow policy fires for staff (so the SSO header is added to
the request), then Bypass catches everyone else (so they pass
through without any SSO header). The function checks for the SSO
header presence; if present, stamp `internal=true`, else `false`.

### 5d. Verify the tagging works

Two PowerShell smoke tests after deploy:

```powershell
# Anonymous (Bypass path) — internal should be false
$body = @{
  session_id = "access-test-anon"
  events = @(@{
    event_type = "session_start"
    app_version = "0.0.0"; platform = "web"; os = "linux"
    locale = "en"; viewport_class = "medium"
    aspect_class = "landscape"; screen_class = "medium"
    build_channel = "public"; vr_capable = "none"
    schema_version = "1.0"
  })
} | ConvertTo-Json -Depth 4

Invoke-WebRequest -Uri https://your-domain/api/ingest `
  -Method POST -ContentType "application/json" -Body $body `
  -Headers @{ Origin = "https://your-domain" }
```

Then a logged-in browser visit (you, with `your-org.org` SSO
active). Wait ~60 s and query AE:

```sql
SELECT blob1 AS event_type, blob4 AS internal, count()
FROM terraviz_events
WHERE timestamp > NOW() - INTERVAL '5' MINUTE
GROUP BY event_type, internal
```

Expect at least one row each of `internal='false'` (anonymous) and
`internal='true'` (your staff session). If both work, Phase 5 is
done.

---

## Phase 6 — Smoke-test the full pipeline

After phases 2–5 are wired:

| What to check | How |
|---|---|
| Privacy disclosure banner appears | Open the site in Incognito. Banner should appear on first load. |
| Tier toggle persists | Tools → Privacy → switch to Research → reload → still Research |
| Tier A events fire | DevTools network tab → click around → see 204 POSTs to `/api/ingest`. Inspect bodies — events match what you did. |
| Server-side stamping | Query AE: `SELECT blob1, blob2, blob3, blob4, count() FROM terraviz_events WHERE timestamp > NOW() - INTERVAL '5' MINUTE GROUP BY 1,2,3,4`. Every row should have your environment + a country code + an internal tag. |
| Tier B opt-in works | In Research mode, search "test" in browse → wait 60s → query `SELECT * FROM terraviz_events WHERE blob1 = 'browse_search'`. The `query_hash` should be 12 hex chars (not the literal "test"). |
| Hashing is one-way | `node -e "import('./src/analytics/hash.ts').then(m => m.hashQuery('test').then(console.log))"` should output the same 12 hex chars you saw in AE. |
| Kill switch | `wrangler kv key put telemetry_enabled disabled --namespace-id=<id>` → next /api/ingest POST should return 410. Then delete the key, verify back to 204. |

---

## Phase 7 — Grafana (optional)

The repo ships three dashboard JSONs under `grafana/dashboards/`.
See [`grafana/README.md`](../grafana/README.md) for the setup
walkthrough — Cloudflare API token, Infinity plugin, datasource
config, dashboard import.

Quick mental model:
- Grafana doesn't have a native Cloudflare Analytics Engine plugin
- We use the Infinity plugin (HTTP-over-JSON) pointed at the AE
  SQL API
- Each panel POSTs SQL to
  `https://api.cloudflare.com/client/v4/accounts/<id>/analytics_engine/sql`
- The response shape is `{ data: [...], meta: [...] }`; Infinity's
  `root_selector: "data"` extracts the rows

The Phase 1f/E `Terraviz — Orbit Cost` dashboard
(`grafana/dashboards/orbit-cost.json`) is the consumer of the
`turn_rounds` telemetry the catalog cutover added. Import it
alongside the other three; the panels are leading indicators of
free-tier neuron exhaustion. See
[`grafana/README.md`](../grafana/README.md) for the import
walkthrough.

---

## Phase 8 — Catalog backend (Phase 1 onward)

Phase 1 of the upstream roadmap (datasets / tours / publisher API
/ semantic search) lands a second backend stack on top of the
analytics-only deploy described above. **You only need this phase
if you want a self-hosted publisher experience** — the public
viewer works fine without it (it falls back to fetching the
upstream SOS catalog snapshot). If you're running a "private
mirror with my own datasets" deploy, this is the phase that adds
that.

The click-by-click instructions are in
[`CATALOG_BACKEND_DEVELOPMENT.md` "Production deployment
checklist"](CATALOG_BACKEND_DEVELOPMENT.md#production-deployment-checklist--first-deploy-walkthrough)
— **do not duplicate them here**. This section gives the
conceptual framing and points operators at the right tools.

### 8a. The bindings the catalog stack adds

| Binding | Type | What it does | Required for |
|---|---|---|---|
| `CATALOG_DB` | D1 | Datasets, tours, publishers, audit_events. Same physical D1 instance as `FEEDBACK_DB`; separate migrations dir. | Everything in this phase. |
| `CATALOG_KV` | KV | Hot-path snapshot cache for `/api/v1/catalog`. Without it the public read burns ~5 D1 reads per browse-page load. | Public catalog reads. |
| `CATALOG_R2` | R2 | Sphere thumbnails, image data refs, legends, captions, tour JSON. Stream handles video uploads via its own API. | Asset uploads. |
| `AI` | Workers AI | Embedding generation for the docent's `search_datasets` tool and the public `/api/v1/search`. | Semantic search + the docent's chip-rendering reliability. |
| `CATALOG_VECTORIZE` | Vectorize | 768-dim embedding index over published datasets. Provisioned via `wrangler vectorize create terraviz-datasets --dimensions=768 --metric=cosine` plus three metadata indexes (peer_id / category / visibility). | Same as `AI`. |
| `NODE_ID_PRIVATE_KEY_PEM` | Secret | Ed25519 keypair for federation signing (Phase 4) and `/.well-known/terraviz.json` advertisement. Generated with `npm run gen:node-key`. | Publishing anything. |
| `PREVIEW_SIGNING_KEY` | Secret | HMAC-SHA-256 secret for preview-token signing. Without it the preview endpoints fail closed. | The CLI's `terraviz preview` command. |
| `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` | Plaintext | Cloudflare Access app credentials for `/api/v1/publish/**`. Without them the publisher middleware 503s with `access_unconfigured`. | Publisher API access. |
| `TRUSTED_PUBLISHER_DOMAINS` | Plaintext (optional) | Comma-separated email domains whose verified Access user logins JIT-provision as `staff/active/admin=1` instead of the default `community/pending`. Required for single-org deploys where the operator IS the publisher (otherwise SSO sign-in lands the operator at `pending` and locks them out of their own deploy). Match is exact, case-insensitive, no subdomain wildcarding. Service tokens are unaffected. | Single-org publisher portal access (Phase 3pa onward). |

Every binding must be wired into **both Production and Preview
environments** in the dashboard. The most common cutover mistake
is "works on preview, breaks on production" (or vice versa) from
forgetting the per-environment toggle. The `npm run
check:pages-bindings` audit (Phase 1f/B) catches this
automatically — see step 8d below.

### 8b. Workers Paid is recommended, not optional

The free tier of Workers AI gives ~10k neurons/day; a single
docent turn that tool-calls `search_datasets` burns ~50 neurons
across the embed + chat round-trip. A small operator deploy with
~50 active turns/day already starts brushing against that ceiling
during a demo week. Workers Paid raises the ceiling materially
and adds the per-request usage telemetry the
`Terraviz — Orbit Cost` Grafana dashboard plots.

If you stay on the free tier, the Phase 1f/D quota guard rail
(`/api/chat/completions` returns 503 `quota_exhausted` on 4006;
the SPA shows a "Reduced functionality" badge and routes through
the local-engine fallback) keeps the deploy usable when the
ceiling hits. But the experience degrades — chips stop rendering
through real search until quota recovers. Plan for Workers Paid
on any deploy that runs a public chat surface.

### 8b.5. Apply the catalog migrations (initial + on every update)

The `CATALOG_DB` binding points at the same physical D1 instance
as `FEEDBACK_DB`, but its migrations live in a separate directory
(`migrations/catalog/`) and have to be applied separately:

```bash
wrangler d1 migrations apply sphere-feedback \
  --remote \
  --config wrangler.toml
```

Run this **before the first deploy** to create the catalog
tables, and **again every time you pull a new release** if it
ships a new migration file. The repo follows a strict
"one migration per schema change" convention — every entry under
`migrations/catalog/` is a numbered file
(`0001_init.sql`, `0002_…`, … `0010_non_global_metadata.sql`,
…) and the runner records which ones have already applied, so
re-running is safe and only the unapplied files take effect.

> ⚠️ **Skipping this step is the #1 cause of post-deploy 500s
> in the publisher API.** Symptom: the portal's "Save draft"
> button surfaces a generic server error; the response body
> reads something like `D1_ERROR: table datasets has no column
> named bbox_n`. The §8d `verify-deploy` probe catches missing
> tables and missing columns on a smoke-test pass — if it's
> green and you're still seeing the error, double-check the
> Production / Preview environment toggle on the D1 binding.

**Verify which migrations have applied.** The cleanest check
is `wrangler d1 migrations list sphere-feedback --remote
--config wrangler.toml`, which diffs `migrations/catalog/`
against the tracker table on the remote and prints
applied-vs-pending. From the dashboard D1 console you can read
the tracker directly:

```sql
SELECT name, applied_at FROM d1_migrations ORDER BY id;
```

A canary for the most recent migration (`0010_non_global_metadata.sql`)
is whether the new columns exist:

```sql
SELECT name FROM pragma_table_info('datasets')
 WHERE name IN ('bbox_n', 'celestial_body', 'lon_origin');
```

Three rows = 0010 is in; zero rows = it isn't.

**Dashboard fallback for applying.** If `wrangler` isn't
installed where you're deploying from, you can paste each
migration file's SQL directly into the Cloudflare dashboard →
D1 → `sphere-feedback` → Console. Apply the files in numeric
order, skipping ones that have already been applied (the
dashboard has no already-applied check; pasting
`0005_publishers_audit.sql` twice will fail because the tables
already exist, which is the intended safety). After a manual
paste, also insert the corresponding row into `d1_migrations`
so a subsequent `wrangler d1 migrations apply` doesn't try to
re-run the same file:

```sql
INSERT INTO d1_migrations (name, applied_at)
VALUES ('0010_non_global_metadata.sql', CURRENT_TIMESTAMP);
```

### 8c. Run the snapshot import

Once the bindings are wired, the catalog tables are empty. Two
paths to seed:

```bash
# Pull the upstream SOS snapshot (mirrors what terraviz.app uses):
npx tsx scripts/refresh-sos-snapshot.ts

# Import the rows via the publisher API:
npm run terraviz -- import-snapshot \
  --server https://your-domain \
  --client-id $CF_ACCESS_CLIENT_ID \
  --client-secret $CF_ACCESS_CLIENT_SECRET \
  --dry-run        # ← always dry-run first

# Once the dry-run plan looks right:
npm run terraviz -- import-snapshot \
  --server https://your-domain \
  --client-id $CF_ACCESS_CLIENT_ID \
  --client-secret $CF_ACCESS_CLIENT_SECRET
```

The import is idempotent — re-running skips rows whose `legacy_id`
is already published. Walks the full SOS catalog (~600 rows) in
a few minutes; embed jobs run async in the background and back-
fill the Vectorize index over the next ~10 minutes.

### 8d. Verify the deploy

Two operator-friendly tools ship for post-deploy verification.
**Run both** before declaring the cutover done:

```bash
# Audit the dashboard's binding state — catches per-environment
# typos and missing toggles:
CLOUDFLARE_API_TOKEN=... \
CLOUDFLARE_ACCOUNT_ID=... \
npm run check:pages-bindings

# Smoke-test every step from the deploy checklist via HTTP probes:
TERRAVIZ_ACCESS_CLIENT_ID=... \
TERRAVIZ_ACCESS_CLIENT_SECRET=... \
npm run terraviz -- verify-deploy --server https://your-domain
```

`check:pages-bindings` reads the project's actual binding set
from the Cloudflare REST API and diffs it against
`scripts/lib/expected-bindings.ts`. Any binding missing in either
Production or Preview shows up as `MISSING` with an operator-
facing hint.

`verify-deploy` runs the post-deploy smoke-test checklist — node
identity advertised, catalog reachable, catalog populated, search
responsive, Access service token round-trips, publisher view
reads cleanly. Without a service token it skips the publisher-API
checks rather than failing them, so you can run it before
minting the token to verify the public surface in isolation.

Both commands target the production preview deploy as the
expected first run. The two commands read their target from
different env vars / flags:

- `check-pages-bindings` reads `CLOUDFLARE_PAGES_PROJECT_NAME`
  (default: `terraviz`); change it to audit a different Pages
  project's bindings.
- `verify-deploy` reads `--server` (or `TERRAVIZ_SERVER`); change
  it to point the HTTP smoke-test at a different deploy URL.

### 8e. Video transcode pipeline (R2 + GitHub Actions)

The publisher portal's video uploads (Phase 3pd, extended by
Phase 3pf to accept image-sequence sources) hand off to a GitHub
Actions workflow that runs ffmpeg against the 4K / 1080p / 720p
2:1 spherical HLS ladder. The workflow doesn't need a fork of the
repo or any commit access — it fires via the
`repository_dispatch` event, which is a pure event API.

Two source shapes feed the same pipeline:

- **MP4 source** (Phase 3pd). The publisher uploads one
  `source.mp4`; the workflow downloads it, re-verifies the
  digest, and runs ffmpeg.
- **Image-sequence source** (Phase 3pf). The publisher uploads N
  frames (PNG / JPEG / WebP, up to 10 000 per upload). The
  workflow downloads every frame in a bounded-concurrency pool,
  re-verifies the canonical source-filenames JSON's digest, and
  runs ffmpeg's image-sequence input mode against the same
  ladder. The portal exposes both shapes as tabs on the asset
  uploader for video-format datasets; everything else
  (transcode-complete callback, R2 bucket layout, recovery
  semantics) is identical.

Both source shapes encode to **30 fps output** regardless of
source frame rate (Phase 3pf forced this invariant via
`-r:v:N 30` on every rendition). The tour engine's `frameRate`
task hard-codes 30 fps as the assumed source rate when computing
playback rate, so the normalisation matters for tour playback to
work correctly across the catalog.

**R2 bucket CORS policy (REQUIRED for the browser uploader).**
The asset-uploader performs a cross-origin XHR PUT directly to
the presigned R2 URL with a `Content-Type` header. Without a CORS
policy permitting your portal origin for `PUT` and exposing the
`ETag` response header, browsers reject the upload before R2
sees it — the portal will spin on "Uploading…" then fail with an
opaque CORS error.

Configure on the bucket (Cloudflare dashboard → R2 → your
bucket → Settings → CORS policy). For a deploy at
`https://terraviz.your-org.org`:

```json
[
  {
    "AllowedOrigins": ["https://terraviz.your-org.org"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Add a second entry with `"AllowedOrigins": ["http://localhost:5173"]`
if you want the dev server to upload too. Public-read for assets
the SPA fetches at runtime (sphere thumbnails, image data_refs)
is a separate concern — that uses the public R2 URL via the
`r2.dev` subdomain or your zone, and CORS for those reads is
inherited from the bucket's public access settings.

The Pages-side wiring you need (Settings → Bindings):

| Binding | Value |
|---|---|
| `GITHUB_OWNER` | `zyra-project` (or your fork's owner) |
| `GITHUB_REPO` | `terraviz` (or your fork's name) |
| `GITHUB_DISPATCH_TOKEN` | GitHub PAT with `repo` scope on the repo above. Wrangler **secret**, not a plaintext env. |

The GitHub-side wiring (repo Settings → Secrets and variables →
Actions → Repository secrets):

| Secret | What it carries |
|---|---|
| `R2_S3_ENDPOINT` | Same value as the Pages `R2_S3_ENDPOINT` env. |
| `R2_ACCESS_KEY_ID` | R2 S3 access-key id with read+write on the assets bucket. Same key the publisher API uses for digest verification is fine. |
| `R2_SECRET_ACCESS_KEY` | The matching secret. |
| `CATALOG_R2_BUCKET` | Optional bucket-name override. Defaults to `terraviz-assets`. |
| `TERRAVIZ_SERVER` | Base URL of the Pages deploy (e.g. `https://terraviz.app`). The workflow POSTs `<server>/api/v1/publish/datasets/{id}/transcode-complete` at the end of the run; the route constructs `data_ref` server-side from the route id + the workflow-supplied `upload_id` and clears `transcoding`. |
| `CF_ACCESS_CLIENT_ID` | Cloudflare Access **service token** id. The token is provisioned via Zero Trust → Access → Service Auth. The publisher API JIT-provisions it as `role='service'` on first use; the `/transcode-complete` route accepts that role explicitly. |
| `CF_ACCESS_CLIENT_SECRET` | The matching secret. |

Both halves are required. A misconfigured deploy fails closed:

- Missing `GITHUB_DISPATCH_TOKEN` on Pages → `/asset/complete`
  returns 503 `github_dispatch_unconfigured` on a video upload.
  The publisher sees an inline error; the source bytes stay in
  R2 and the upload can be retried after you fix the binding.
- Missing R2 / Access secrets on GitHub → the workflow's
  pipeline step exits non-zero with a stage-specific code (2
  download, 3 encode, 4 upload, 5 PATCH). The dataset row
  stays flagged `transcoding=1` and bound to the original upload
  via `active_transcode_upload_id`. The "Transcoding…" badge
  in the portal stays visible — that's the operator's signal
  something needs attention.

  **Recovery is operator-only:** the `/asset/.../complete`
  route refuses a *different* upload while `transcoding=1` and
  the active-upload binding is still set (the
  `transcoding_in_progress` guard added in 3pd-followup/C), so
  the publisher cannot recover by re-uploading. Clear the row
  first via D1 — `UPDATE datasets SET transcoding = NULL,
  active_transcode_upload_id = NULL WHERE id = '…'` — and *then*
  the publisher can mint a fresh upload. Same operator
  intervention applies to the WAF-challenge case below: the
  bundle exists in R2 but the row is stuck, so either re-issue
  the transcode-complete POST by hand (with the right Access
  service-token headers) or clear the row and re-upload.

**WAF skip rule for the transcode-complete callback.** Cloudflare
Access service tokens (`CF-Access-Client-Id` /
`CF-Access-Client-Secret`) bypass Access but **not** Bot Fight
Mode, the Cloudflare Managed Ruleset, or any custom WAF rule. If
your zone has any of those active — Bot Fight Mode is on by
default on the Free plan and up — the GHA runner's final POST to
`/api/v1/publish/datasets/{id}/transcode-complete` gets served a
`Just a moment...` JS-challenge interstitial at the edge and
never reaches the publisher Worker. ffmpeg finishes, the HLS
bundle lands in R2, and then the runner exits non-zero at stage
5 (PATCH failure) with the challenge HTML in the body. The
dataset row stays flagged `transcoding=1`.

The fix is **two rules** that together cover both layers
Cloudflare runs at: a WAF Custom Rule for the WAF stack, and
(on Free plans, or any zone with plain Bot Fight Mode enabled)
a Configuration Rule that overrides the zone-wide Bot Fight Mode
toggle for this one path. Both are gated on the Access
service-token header so the exemption only fires for legitimate
service-token traffic.

**Step 1 — WAF Custom Rule (covers Managed Ruleset, custom rules,
Super Bot Fight Mode on Pro+, Browser Integrity Check, Security
Level):**

1. Security → WAF → Custom rules → Create rule.
2. Name it something like `transcode-complete service token skip`.
3. Field expression (use the Edit expression view):
   ```
   (starts_with(http.request.uri.path, "/api/v1/publish/")
     and ends_with(http.request.uri.path, "/transcode-complete")
     and len(http.request.headers["cf-access-client-id"][0]) > 0)
   ```
4. Action: **Skip**. Tick:
   - All remaining custom rules
   - All managed rules
   - All Super Bot Fight Mode Rules (Pro+; inert on Free)
   - Browser Integrity Check (under "More components to skip")
   - Security Level (under "More components to skip")
5. Deploy.

**Step 2 — Plain Bot Fight Mode on Free / Pro plans.**

The WAF Custom Rule's Skip action's "All Super Bot Fight Mode
Rules" covers SBFM (Pro+ feature) but NOT plain Bot Fight Mode,
which on Free / Pro runs as a zone-wide toggle at a different
layer. Cloudflare's per-path rule types — WAF Custom Rules,
Configuration Rules, Page Rules — none of them expose Bot
Fight Mode as a per-path override on Free. (Older Cloudflare
docs implied Configuration Rules could; current dashboard
reality is that Bot Fight Mode isn't in the override list on
Free zones.)

Three options:

1. **Disable Bot Fight Mode zone-wide.** Security → Bots →
   Configure → toggle Bot Fight Mode Off. Loses BFM protection
   across the zone, but for a small publisher portal where
   authenticated traffic dominates and the public SPA is
   served from cache, BFM adds little marginal protection over
   the layers already in place (Cloudflare Access for the
   portal, role-gated routes for service tokens, the WAF
   Custom Rule from Step 1 for the WAF stack). This is the
   recommended path for Free-plan deploys.

2. **Upgrade to Pro and rely on SBFM.** Pro replaces BFM with
   Super Bot Fight Mode, which IS skippable from the WAF
   Custom Rule in Step 1 (the "All Super Bot Fight Mode Rules"
   checkbox). Only worthwhile if you have other reasons to
   upgrade.

3. **Live with manual operator recovery.** Leave BFM on,
   accept that workflow callbacks will sometimes fail with
   the JS challenge interstitial, and have an operator
   manually trigger `/transcode-complete` from a browser
   session (which has a valid Access cookie and so isn't
   challenged) whenever it does. Tractable for low-volume
   deploys but bad ergonomics.

Whichever option you pick, the Step 1 WAF Custom Rule still
covers the rest of the security stack — Managed Ruleset, custom
rules, SBFM on Pro+, Browser Integrity Check, Security Level —
and is gated on the `cf-access-client-id` header so it only
applies to legitimate service-token traffic. Safe because (a)
only requests carrying a service-token id can match, (b)
Cloudflare Access still validates the token after the
exemption — a forged header without the matching secret can't
actually authenticate, and (c) the `/transcode-complete` route
handler enforces `role='service'` independently before mutating
the row.

**Verifying which rule is firing.** If the workflow still 403s
after deploying both, check Security → Events. The event row
names the specific check that fired. Match it back to the rule
layer:

| Event "Service" column says | Fixed by |
|---|---|
| `Bot fight mode` (Free/Pro plain BFM) | Step 2 (disable BFM zone-wide on Free; upgrade to Pro for SBFM; or live-with-manual-recovery) |
| `Managed challenge` from a Managed Ruleset rule | WAF Custom Rule (Step 1), "All managed rules" |
| `Super Bot Fight Mode` (Pro+) | WAF Custom Rule, "All Super Bot Fight Mode Rules" |
| `Browser Integrity Check` | WAF Custom Rule, "Browser Integrity Check" |
| `Security level` | WAF Custom Rule, "Security Level" |

The CLI emits a specific operator-actionable error when it
detects the challenge response, so a future occurrence of this
failure surfaces in the GHA log as a one-line pointer at this
section rather than as a 30-KB blob of obfuscated HTML.

**Mock mode for local development.** Set `MOCK_GITHUB_DISPATCH=true`
in `.dev.vars` to skip the dispatch call entirely; the dataset
row still gets stamped `transcoding=1` so you can exercise the
portal's polling surface without a real GHA workflow. The
publisher API refuses `MOCK_GITHUB_DISPATCH=true` on a
non-loopback hostname — same defense-in-depth pattern `MOCK_R2`
and `MOCK_STREAM` use.

**Cost model.** GitHub Actions free tier: 2000 CI-minutes/month
for public repos. A 5-minute 1080p source encodes in ~3 minutes
on the `ubuntu-22.04` runner. At 50 uploads/month with average
5-minute sources that's 150 CI-minutes — well under the ceiling.
R2 **storage** is the dominant ongoing R2 cost (egress is
zero-rated): at 4K @ ~25 Mbps the ladder lands ~250 MB per
minute of source content, billed monthly until manually
deleted. R2 also charges per-operation (class A / class B)
fees — a 50-MP4-per-month deploy is well below the
free-operation ceiling, so storage is what to watch.

### 8f. Next steps

- Wire up the orbit-cost dashboard alongside the existing three
  (Phase 7 above).
- Read [`CATALOG_BACKEND_DEVELOPMENT.md` "Cost
  model"](CATALOG_BACKEND_DEVELOPMENT.md#cost-model--what-changed-at-the-cutover)
  to calibrate expectations on neuron burn per turn.
- Watch the `Total LLM rounds per day` panel for the first week.
  A sustained drift toward ~7000 rounds/day is the
  free-tier ceiling for the typical Workers AI mix.
- For multi-publisher deploys, work through the Cloudflare Access
  setup so each publisher signs in via SSO. The publishers row
  is JIT-provisioned on first sign-in; an operator with admin
  flips `status='active'` to allow publishing.
- Enable the publisher portal browser flow (next subsection).

### 8g. Publisher portal browser flow (Phase 3pa onward)

Phase 1a wired Cloudflare Access to protect the publisher *API*
(`/api/v1/publish/**`) — that's the service-token / programmatic
surface the `terraviz` CLI uses. Phase 3pa adds a *browser*
surface on top of the same API: a small admin UI lazy-loaded at
`/publish/**` that lets staff publishers manage datasets and
tours without dropping to the CLI.

The browser path is *not yet* gated by Access by default — the
portal HTML and lazy chunk are served by the SPA fallback rule
in `public/_redirects` and reach anyone with the URL. Until you
add an Access application that covers `/publish/**`, treat the
preview deploy URLs as public. The portal placeholder pages
render with no API calls; the live `/publish/me` page is what
exposes data, and it 401s through the API middleware regardless.

To gate the browser path, add a second Access application that
mirrors the API policy:

- **Application name**: `Terraviz Publisher Portal`
- **Destinations**:
  - `terraviz.pages.dev/publish` (Cloudflare matches `/publish*`
    when you tick "Include subdomains" — actually for path-mode
    you want to list the prefix explicitly; see the Cloudflare
    docs for "self-hosted apps with subpath destinations"). For
    most teams the working incantation is two destinations on
    the same app: `terraviz.pages.dev/publish` and
    `terraviz.pages.dev/publish/*`. Add your custom domain
    alongside.
  - `your-custom-domain.org/publish`
  - `your-custom-domain.org/publish/*`
- **Policies**: same shape as the `/api/v1/publish/**` policy —
  one Allow policy, **Include → Emails ending in →
  `your-org.org`** for the staff cohort that should be able to
  publish.
- **Session duration**: 24 hours is a good default. Publishers
  typically need an editing session that doesn't time out
  mid-form; a daily SSO re-prompt is the right cadence.

The portal reads the resulting Access JWT cookie when it calls
`/api/v1/publish/me` — same JWT the existing API middleware
already verifies. No code changes when you flip the policy on;
the portal starts succeeding instead of showing the
session-expired error card.

Local dev continues to use `DEV_BYPASS_ACCESS=true` for the API,
and the portal honours it for the browser path too — so
`wrangler pages dev` against `.dev.vars` is the cheapest way to
iterate without going through Access for every refresh.

If you're not ready for the second Access app yet, the
intermediate state (portal HTML reachable, but every API call
hits Access on the way) is safe: an unauthenticated visitor
sees the "Your session has expired. Refresh to sign in again."
error card and cannot exercise any write surface. The Access app
is the right belt-and-suspenders, not a safety prerequisite.

**Trusted-domain auto-promotion.** Once §8g's Access app is
wired and you sign into the portal for the first time, the
publisher middleware JIT-provisions a row for your email. The
default classification for an Access user login is
`role=community, status=pending` — which a Phase 6 multi-org
review queue would later approve. For a Phase 3 single-org
deploy where you ARE the publisher, leave the queue out of the
picture by setting `TRUSTED_PUBLISHER_DOMAINS` to your
operator's email-domain pattern (see the bindings table in §8a):

```
TRUSTED_PUBLISHER_DOMAINS = noaa.gov,zyra-project.org
```

Set on both Production and Preview, then redeploy. Verified
user logins matching either domain provision as
`role=staff, status=active, is_admin=1` — full administrative
authority over the deploying node's catalog. Service tokens are
unaffected (they continue to provision as `role=service`).

**If you already signed in before setting this var.** Pages will
have JIT-provisioned a `community/pending` row already; the
`getOrCreatePublisher` path doesn't update existing rows.
Promote it once via the D1 console:

```sql
UPDATE publishers
SET role = 'staff', is_admin = 1, status = 'active'
WHERE email = 'you@your-org.org';
```

Subsequent sign-ins (and any other operator from a trusted
domain) will land at the right classification on first
provision.

**Why the "session expired" card and not a real sign-in flow.**
Cloudflare Access responds to unauthenticated requests with a
302 to its cross-origin login page. The portal's fetch is
configured with `redirect: 'manual'` so we can recognise this
explicitly — but the underlying response is opaque (we can't
read the login URL, can't auto-follow without CORS errors, can't
embed Access's login UI in our own page). So the portal can
*detect* the redirect and tell the user "you need to sign in,"
but it can't *complete* the sign-in itself.

The Refresh button on the error card is the working escape
hatch: once you've wired this §8g Access app, refreshing the
portal page triggers Access at top-level navigation time, the
user signs in, Access redirects back to `/publish/me`, the
portal loads with the cookie present, and the next fetch
succeeds without ever touching the error card. Until you wire
the app, refreshing just reproduces the same state — that's the
operator-config gap this section closes.

---

## Common failure modes

### `/api/ingest` returns 204 but nothing lands in AE

The Pages project doesn't have the `ANALYTICS` binding in the
environment that's serving traffic. Check Settings → Bindings,
both Production and Preview tabs. The function code at
`functions/api/ingest.ts:407` reads `context.env.ANALYTICS` and
silently skips the write if undefined.

### `/api/ingest` returns 403

The CORS gate at `functions/api/ingest.ts:88` rejected the request.
Either:
- The `Origin` header is missing (browsers always send it; curl
  and PowerShell don't unless you explicitly set `-H "Origin: ..."`)
- The origin isn't in the allowlist or doesn't match the
  request URL or end with `.pages.dev`

### Cloudflare Access blocks your `@your-org.org` Google account

The Access policy was set to **Emails** (exact match) instead of
**Emails ending in** (suffix match). Edit the policy → change the
selector → save.

### Grafana dashboard shows fake "Leanne Graham, Devops Engineer" data

Infinity plugin is using its bundled JSONPlaceholder demo URL
because the datasource isn't configured. The dashboards' panel
targets specify a *relative* URL (`/sql`); the datasource needs
the absolute base URL (`https://api.cloudflare.com/client/v4/accounts/<id>/analytics_engine`).
See `grafana/README.md` step 3.

### Privacy page is stale relative to `docs/PRIVACY.md`

```bash
npm run build:privacy-page
git add public/privacy.html
git commit -s -m "regenerate privacy page"
```

CI runs `npm run check:privacy-page` which fails if the HTML
drifts from the markdown.

### Tour quiz / VR session events not appearing in Tier A queries

`tour_question_answered` and `vr_interaction` are **Tier B** —
they only fire when the user has opted into Research mode under
Tools → Privacy. If your test users are on default Essential
mode, those events legitimately won't fire.

### `wrangler kv key put` says namespace not found

The `--namespace-id` flag wants the *raw* ID (32-character hex
string), not the namespace title. List with `wrangler kv namespace
list` to confirm.

### Publisher API returns 503 `access_unconfigured`

`ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is missing from the
deployment. Common cause: you set them on Production but forgot
the Preview tab (or vice versa). Confirm with `npm run
check:pages-bindings`; if the `MISSING` row says one environment
has them and the other doesn't, that's the per-environment
toggle gotcha from Phase 8a.

### Docent suggestions stop showing dataset chips after working briefly

You've hit Workers AI free-tier neuron exhaustion. The chat
panel shows a "Reduced functionality — Workers AI quota reached"
badge (Phase 1f/D); the deploy is healthy, just throttled. Two
mitigations:

1. **Wait it out** — quota resets daily; the badge clears the
   moment the next LLM call succeeds.
2. **Move to Workers Paid** — see Phase 8b above. The
   `Terraviz — Orbit Cost` Grafana dashboard's
   "Total LLM rounds per day" panel tells you whether you're
   sustainably under the ceiling or routinely brushing it.

### `terraviz import-snapshot` 409s on the second run

Working as designed — the importer's `legacy_id` idempotency
check (Phase 1d) recognises rows it already published and skips
them. Re-running is safe; if you genuinely want to re-import a
row, retract it via `terraviz retract <id>` and then re-run the
importer.

### `terraviz verify-deploy` shows SKIP for the publisher checks

Expected when no service token is configured. Mint one in
Cloudflare Zero Trust → Access → Service Auth → Service Tokens,
attach it to your Access app's policy as a Service Auth
include, and re-run with
`TERRAVIZ_ACCESS_CLIENT_ID=... TERRAVIZ_ACCESS_CLIENT_SECRET=...`.

### Publisher portal shows `role: service` for a real user

The publisher portal's profile card (or a raw `GET
/api/v1/publish/me`) shows `role: service` even though you
signed in interactively. This was a pre-3pa middleware bug —
the Access-JWT classifier read `claims.type === 'app'` as the
service-token signal, but Cloudflare stamps `type: 'app'` on
every application-level JWT (both users and service tokens).
Fixed in 3pa/J/A; any row JIT-provisioned before that fix
shipped still has the wrong classification.

One-shot D1 fix-up:

```sql
UPDATE publishers
SET role = 'staff', is_admin = 1, status = 'active'
WHERE email = 'you@your-org.org';
```

Then verify with `GET /api/v1/publish/me` — `role` should
report `staff` (or `community` / `pending` if your email
domain isn't in `TRUSTED_PUBLISHER_DOMAINS`; see §8g).

---

## What to do after a successful self-hosted launch

- Set the `KILL_TELEMETRY=1` env var as a known emergency option
  (or use the KV kill switch we wired up). Document who has access
  to flip it.
- Add a calendar reminder for your Cloudflare API token's
  expiration if you set a TTL. A silently expired token =
  silently broken Grafana.
- Watch the Errors-by-category Grafana panel for the first week.
  A flood of `network` errors usually means an asset CDN is
  rate-limiting; a flood of `auth` means an LLM key issue.
- Open a few `feedback` events yourself with the in-app form so
  you can confirm the admin dashboard at `/api/feedback-admin`
  actually loads behind Access.

If you find something broken or under-documented, please open an
issue against the upstream repo — half of this doc was written
because someone hit a snag and it was worth capturing.
