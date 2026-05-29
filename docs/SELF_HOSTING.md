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

## Phase 1.5 — Fork-specific code & config you must change

Most of the deployment is driven by Cloudflare dashboard bindings
and env vars (Phases 2–8). But a handful of values are **baked into
source** and point at the upstream project. None of them break a
web deploy's same-origin API calls — those use relative `/api/`
paths and resolve against your own domain automatically — but they
*do* leave your fork silently dependent on upstream infrastructure,
or (in the case of `wrangler.toml`) pointed at the **wrong
database**. Walk this list before your first production deploy.

### `wrangler.toml` carries upstream resource IDs ⚠️

`wrangler.toml` ships the upstream project's **real** D1 database ID
and KV namespace ID:

| Line | Binding | Value in repo | Action |
|---|---|---|---|
| `database_id` (FEEDBACK_DB) | D1 | `78fbe5c3-…` (upstream) | Replace with the ID from your own `wrangler d1 create` (Phase 3a). |
| `database_id` (CATALOG_DB) | D1 | `78fbe5c3-…` (upstream) | Same physical DB as FEEDBACK_DB — use the **same** new ID. |
| `id` (TELEMETRY_KILL_SWITCH) | KV | `9c022b12…` (upstream) | Replace with your `wrangler kv namespace create` ID (Phase 3d). |
| `id` (CATALOG_KV) | KV | `0000…0000` (placeholder) | Replace with your CATALOG_KV namespace ID (Phase 8a). |

This matters because the migration commands in **Phase 3a** and
**Phase 8b.5** run `wrangler d1 migrations apply sphere-feedback
--config wrangler.toml`, which resolves the target database through
the `database_id` in this file. **If you leave the upstream ID in
place, you are aiming your migrations at a database you don't own**
(it will fail on auth at best). Update `wrangler.toml` immediately
after `wrangler d1 create` in Phase 3a, before any
`migrations apply`. Pages reads its live bindings from the dashboard
regardless, but the wrangler CLI commands in this guide read
`wrangler.toml`.

The resource *names* (`sphere-feedback`, `terraviz_events`,
`terraviz-assets`, `terraviz-datasets`) are yours to keep or rename;
if you rename, keep the dashboard binding + the override env vars
(`CATALOG_R2_BUCKET`, etc.) in sync.

### Upstream-hosted services — when they matter for an independent node

A few runtime dependencies were historically hardcoded to the
upstream node's infrastructure. They are now resolved from
**build-time `VITE_*` env vars** (centralised in
[`src/config/endpoints.ts`](../src/config/endpoints.ts)), defaulting
to the upstream URLs so an unconfigured demo fork still works.

> **Most new nodes can ignore the two proxies entirely.** The video
> and caption proxies only serve **legacy SOS catalog data**
> (`vimeo:` data_refs and `sos.noaa.gov` captions). A node only ever
> has those refs if it deliberately runs `terraviz import-snapshot`
> to mirror the upstream SOS catalog. **Content you add through the
> publisher interface is transcoded to your own R2 / Cloudflare
> Stream** (`r2:` / `stream:` data_refs) and never touches either
> proxy. So a publisher-based node is independent of the proxies out
> of the box — leave the defaults; they simply never fire.

The one knob that *does* affect every node is the Earth basemap
texture host. Set these in Pages → Settings → Environment variables
(build):

| Env var | Default | What it is | When you need to change it |
|---|---|---|---|
| `VITE_EARTH_ASSET_BASE` | `https://d3sik7mbbzunjo.cloudfront.net/terraviz/basemaps` | Earth basemap textures (diffuse / night lights / normal / borders) for the photoreal Earth (VR + Orbit) and 2D globe overlays — loaded by **every** node. | **Recommended for any independent node.** Mirror the texture files (plain static `.jpg`/`.png`) to your own bucket/CDN and point this at it. |
| `VITE_VIDEO_PROXY_BASE` | `https://video-proxy.zyra-project.org/video` | Resolves **legacy SOS** `vimeo:` data_refs into HLS/MP4. | Only if you mirror the SOS catalog (`import-snapshot`) **and** want video independent of upstream. The proxy worker is not in this repo — you'd run your own. Not needed for publisher-based nodes. |
| `VITE_CAPTION_PROXY_BASE` | `https://video-proxy.zyra-project.org/captions` | CORS shim for **legacy SOS** `sos.noaa.gov` caption `.srt` files. | Same as above — SOS-mirror only. Publisher-uploaded captions live in your R2. |

If you mirror the SOS catalog and leave the proxy defaults, video
playback for those rows depends on upstream's uptime/bandwidth —
fine for a demo, not for a node meant to run independently. The
Earth textures depend on upstream's CDN for **every** node until you
set `VITE_EARTH_ASSET_BASE`.

The SOS catalog metadata snapshot
(`s3.…/metadata.sosexplorer.gov/dataset.json` in
`src/services/dataService.ts`), the cloud-texture bucket, and the
NASA GIBS tile base are third-party **public data sources** shared by
all nodes — not upstream-Terraviz infrastructure — so they stay
pointed at NOAA/NASA and need no change.

### Branding / identity references (cosmetic, change at leisure)

- `src/ui/creditsPanel.ts` and `docs/PRIVACY.md` link to
  `github.com/zyra-project/terraviz`. After editing `PRIVACY.md`,
  run `npm run build:privacy-page` to regenerate
  `public/privacy.html` (CI's `check:privacy-page` enforces the
  diff).
- **Deep links resolve automatically** — `parseDatasetFromUrl`
  recognises your node's own host (derived from `VITE_API_ORIGIN`)
  plus any `*.pages.dev` preview and `localhost`, so shared
  `/dataset/<id>` links work on your domain with no edit. (Set
  `VITE_API_ORIGIN` if you ship desktop builds — see Phase 9.)
- The `terraviz` **CLI** defaults its server to `https://terraviz.app`
  but is already independence-ready: override per-invocation with
  `--server`, the `TERRAVIZ_SERVER` env var, or a persisted
  `~/.terraviz/config.json`. No edit required.

### Desktop app (only if you ship Tauri builds)

If you build the desktop app, see the dedicated notes in
[Phase 9 below](#phase-9--desktop-app-fork-only-if-you-ship-it).
A web-only Cloudflare fork can ignore this.

---

## Phase 1.6 — CI/CD on your fork (GitHub Actions)

The `.github/workflows/*.yml` files travel with the code when you
fork, but **the things that make them run do not**. GitHub never
copies secrets, variables, or environments to a fork, and on a
fork created via the GitHub "Fork" button **Actions are disabled
until you turn them on**. Settle this before your first push so you
aren't debugging empty-secret failures.

### Three things GitHub does not carry over

1. **Workflow enablement.** Forked repos land with Actions disabled.
   Go to the **Actions** tab → enable workflows. Scheduled
   workflows (here, `codeql.yml` runs on a `schedule:`) stay off
   until you do. (If you instead created a *fresh* repo in your org
   and `git push`-ed the code, Actions are on by default — but the
   next two points still apply.)
2. **Secrets and variables.** Every `secrets.*` / `vars.*`
   reference is empty until you recreate it under **Settings →
   Secrets and variables → Actions**.
3. **Environments.** The deploy jobs reference the `production`,
   `preview`, `poster-production`, and `poster-preview`
   environments. Recreate them (Settings → Environments) or disable
   the jobs that use them.

> A PR opened *from* a fork never receives secrets (GitHub security
> policy), so fork-PR runs are compile-only by design. Pushes to
> your own `main` are what exercise the secret-gated jobs.

### What each workflow needs (and what's safe to drop)

| Workflow | Secrets / vars / env it needs | Disable / ignore if… |
|---|---|---|
| `ci.yml` — type-check / unit-tests / build | none (auto `GITHUB_TOKEN`) | **keep** — fork-safe, no setup |
| `ci.yml` — **deploy** job | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; optional `vars.VITE_DEFAULT_UI_SCALE`; envs `production`/`preview`; **+ rename the `--project-name terraviz`** | you deploy via the Pages dashboard Git integration (then delete this job — see Phase 2) |
| `poster.yml` | same Cloudflare secrets; envs `poster-production`/`poster-preview`; **+ rename `terraviz-poster`** | you don't ship the poster sub-site |
| `transcode-hls.yml` | `R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CATALOG_R2_BUCKET`, `TERRAVIZ_SERVER`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` (details in §8e) | you don't use publisher video uploads |
| `release.yml` / `desktop.yml` | `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`), 6× `APPLE_*` (Phase 9) | web-only fork |
| `sync-weblate.yml` | `WEBLATE_TOKEN` (Phase 9d) | you don't run your own translation pipeline |
| `codeql.yml`, `mobile.yml` | none | **keep** — fork-safe |

The per-workflow detail lives in the phases referenced above; this
table is the one-glance checklist so nothing is silently missing.
Minimum to get a green pipeline on a web-only fork: keep the
fork-safe jobs, set the two `CLOUDFLARE_*` secrets (or remove the
deploy job), and disable/delete `transcode-hls.yml`, `release.yml`,
`desktop.yml`, and `sync-weblate.yml` until you need them.

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

> ⚠️ **Pick one deploy path — dashboard Git integration *or* the
> `ci.yml` GitHub Action, not both.** The repo's
> `.github/workflows/ci.yml` has a `deploy` job that runs
> `wrangler pages deploy dist/ --project-name terraviz` on every
> push to `main`, and `poster.yml` does the same for
> `terraviz-poster`. On a fresh fork these jobs are wired for the
> upstream project and will either **fail** (no `CLOUDFLARE_API_TOKEN`
> / `CLOUDFLARE_ACCOUNT_ID` secret) or, with secrets present,
> deploy to the **wrong project name**. They also pin the
> production environment URL to `https://terraviz.zyra-project.org/`.
>
> If you use the dashboard "Connect to Git" auto-build above (the
> simplest path), **delete or disable the `deploy` job in `ci.yml`
> and `poster.yml`** so you don't get duplicate/competing deploys —
> keep the `type-check` / `unit-tests` / `build` jobs, which are
> fork-safe and need no secrets.
>
> If instead you prefer the GitHub Action to deploy (Direct Upload),
> keep the `deploy` job but: (a) set the `CLOUDFLARE_API_TOKEN` and
> `CLOUDFLARE_ACCOUNT_ID` repo secrets, (b) change every
> `--project-name terraviz` / `terraviz-poster` to your project
> names, and (c) update the hardcoded environment URL — then skip
> the dashboard Git connection so the two paths don't race the same
> project + commit hash.

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

## Phase 4 — Orbit chat (optional)

> **Corrected 2026-05.** Earlier revisions of this section described
> an `LLM_PROVIDER_URL` / `LLM_PROVIDER_KEY` server-side proxy at
> `functions/api/[[route]].ts`. **That proxy does not exist in the
> codebase** and those env vars are read by nothing. Orbit's default
> LLM path is Cloudflare Workers AI, wired through the `AI` binding —
> there is no external API key to inject. The accurate setup is
> below.

### 4a. Default path — Cloudflare Workers AI (recommended, zero extra config)

Orbit's chat backend is `functions/api/chat/completions.ts`, which
calls the **`AI`** (Workers AI) binding directly and streams an
OpenAI-shaped SSE response. `functions/api/models.ts` backs the
"Test Connection" button. Both rely only on the `AI` binding you
already wired in **Phase 3b** — once that's attached to Production
and Preview and you've redeployed, Orbit works with no further
configuration.

The SPA defaults its Orbit `apiUrl` to the relative `/api`, so on a
web deploy every chat request is same-origin against your own Pages
Functions. No API key reaches (or needs to reach) the browser
bundle, because the default model runs on Cloudflare's edge.

Model selection lives in `MODEL_MAP` inside
`functions/api/chat/completions.ts` (Llama 3.x / Llama 4 Scout
variants); the "Reduced functionality" quota guard described in
Phase 8b kicks in when the Workers AI free-tier neuron budget is
exhausted.

> AI Gateway note: the `AI.run()` call accepts a `gateway` option,
> but the current code does **not** pass one — routing Workers AI
> through an AI Gateway (for caching / analytics / rate limits) is a
> code change, not a binding or env var. Don't expect the gateway
> URL from older docs to do anything on its own.

### 4b. External OpenAI-compatible provider (per-client only)

There is **no server-side proxy** for third-party providers. To
point Orbit at OpenAI, an OpenAI-compatible gateway, or a hosted
model, set the **API URL + API key in the running app** under
Tools → Orbit Settings. On web this is stored in `localStorage`;
on the Tauri desktop app the key goes to the OS keychain.

Because the key lives in the client, this path is appropriate for a
single operator's own browser or a desktop install — **not** for a
shared public deployment, where every visitor would either need
their own key or share one embedded in their local storage. For a
public site, stay on the Workers AI path (4a).

### 4c. Local LLM (Ollama / LM Studio / llama.cpp)

Same client-side mechanism as 4b — Pages can't reach `localhost`,
so this is a dev / desktop convenience. Configure in the app via
Tools → Orbit Settings → API URL:
- Ollama: `http://localhost:11434/v1`
- LM Studio: `http://localhost:1234/v1`
- llama.cpp: `http://localhost:8080/v1`

The Tauri desktop app routes these through the Tauri HTTP plugin to
bypass webview CORS.

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
| `R2_PUBLIC_BASE` | Plaintext | Public origin for the catalog R2 bucket (e.g. `https://assets.terraviz.your-org.org`). The manifest endpoint and SPA build playable HLS / image / tour-asset URLs from this. Bind the domain under R2 → bucket → Settings → Connect Domain first. **Not optional for the audit** (see note below). | Serving any R2-hosted asset (Phase 3 onward). |
| `R2_S3_ENDPOINT` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Secret | R2 S3-API credentials for server-side presigned PUT minting and digest verification. Minted at R2 → Manage R2 API Tokens (Read+Write on the bucket). The same three values are also consumed shell-side by the migration CLIs and the transcode workflow. | Browser/CLI asset uploads. |
| `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_DISPATCH_TOKEN` | Plaintext / Plaintext / Secret | Point the video-transcode `repository_dispatch` at **your fork** (e.g. `your-org` / `terraviz`). Token is a PAT with `repo`/Contents:write on that repo. Without them video uploads 503 `github_dispatch_unconfigured`. | Video transcode (§8e). |

Every binding must be wired into **both Production and Preview
environments** in the dashboard. The most common cutover mistake
is "works on preview, breaks on production" (or vice versa) from
forgetting the per-environment toggle. The `npm run
check:pages-bindings` audit (Phase 1f/B) catches this
automatically — see step 8d below.

> **The audit's source of truth is
> [`scripts/lib/expected-bindings.ts`](../scripts/lib/expected-bindings.ts),
> not this table.** It also asserts the Phase 3 analytics/feedback
> bindings (`FEEDBACK_DB`, `ANALYTICS`, `TELEMETRY_KILL_SWITCH`) in
> both environments. So `check:pages-bindings` will report
> `R2_PUBLIC_BASE` and the R2 / GitHub-dispatch entries above as
> `MISSING` on a deploy that wired only the rows the older table
> listed — that's expected, not a false positive. Wire the full set
> (or, if you genuinely don't run uploads/transcode yet, prune the
> corresponding entries from `expected-bindings.ts` so the audit
> reflects your deploy's actual surface).

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

The authoritative "is everything applied?" check is the
`wrangler d1 migrations list` command above — it diffs the whole
`migrations/catalog/` directory against the remote tracker, so it
stays correct as the directory grows. **Don't hard-code "the latest
migration is NNNN" anywhere** — the count climbs every release (as
of this writing the directory runs through
`0016_node_identity_singleton.sql`).

A per-migration canary is whether that file's columns exist. For the
newest at time of writing (`0016`):

```sql
SELECT name FROM pragma_table_info('node_identity') WHERE name = 'singleton';
```

One row = `0016` is in; zero rows = it (and likely later files)
isn't. The same shape works for any migration — substitute the
table and column it adds.

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

### 8b.6. Provision the node identity row (remote) ⚠️ required before publishing

The migrations **create** the `node_identity` table but do not
populate it, and the seed paths are local-only:
`npm run db:seed` writes through `better-sqlite3` to the
`.wrangler/` SQLite file, and `npm run gen:node-key` only updates
the **local** D1's `public_key`. **Neither touches remote D1.** So
immediately after applying migrations to your production database,
`node_identity` is empty — and that breaks two things:

- `GET /.well-known/terraviz.json` returns **503
  `identity_missing`** (its error text says "Run
  `npm run gen:node-key`", which is misleading — that script doesn't
  write remote D1).
- **Every publish and `import-snapshot` row fails.** Dataset inserts
  set `origin_node` via `(SELECT node_id FROM node_identity LIMIT 1)`,
  and `datasets.origin_node` is `NOT NULL` — an empty identity table
  makes that subquery `NULL` and the insert aborts on the constraint.

So provision the row **once**, before §8c. Two ways:

**Recommended — `terraviz init-node`.** Writes the row through the
publisher API, so it needs only the Cloudflare Access service token
you already use for `import-snapshot` — no `wrangler` / direct D1
access, and it works on an empty table (the publisher middleware
only depends on the `publishers` table). It accepts an admin user or
a service token.

1. Generate the keypair and set the private-key secret:
   ```bash
   npm run gen:node-key
   # writes node-public-key.txt (the `ed25519:...` line) and prints
   # the `wrangler pages secret put NODE_ID_PRIVATE_KEY_PEM` step
   ```
   Set `NODE_ID_PRIVATE_KEY_PEM` as instructed (both Production and
   Preview).
2. Provision the identity with **your node's real values** (not the
   dev defaults `db:seed` uses — `'Terraviz (dev)'` /
   `http://localhost:8788`). `init-node` reads `node-public-key.txt`
   automatically:
   ```bash
   npm run terraviz -- init-node \
     --server https://your-domain \
     --client-id $CF_ACCESS_CLIENT_ID \
     --client-secret $CF_ACCESS_CLIENT_SECRET \
     --display-name "Terraviz — Your Org" \
     --base-url https://terraviz.your-org.org \
     --contact ops@your-org.org
   ```
   It's idempotent: re-running updates the row in place (preserving
   `node_id` so existing `origin_node` references stay valid) and
   keeps the existing key unless you pass a new `--public-key`.
3. Verify — hit `https://your-domain/.well-known/terraviz.json`; it
   should return 200 with your identity instead of 503. (`terraviz
   verify-deploy`'s node-identity check covers this too.)

**Fallback — raw D1 (`wrangler` only).** If you'd rather not mint a
service token yet, write the row directly:

```bash
wrangler d1 execute sphere-feedback --remote --config wrangler.toml \
  --command "INSERT INTO node_identity
    (node_id, display_name, base_url, description, contact_email, public_key, created_at)
    VALUES (
      lower(hex(randomblob(16))),
      'Terraviz — Your Org',
      'https://terraviz.your-org.org',
      'Your org''s Terraviz node.',
      'ops@your-org.org',
      'ed25519:PASTE_FROM_node-public-key.txt',
      strftime('%Y-%m-%dT%H:%M:%fZ','now')
    )"
```

> If you later rotate the key with `npm run gen:node-key`, push the
> new public key to remote D1 too — `npm run terraviz -- init-node
> … --public-key ed25519:…` (or the `wrangler d1 execute … UPDATE
> node_identity SET public_key=…` equivalent). The script only
> updates your local copy.

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

## Phase 9 — Desktop app fork (only if you ship it)

The web deploy above is self-contained. If you also intend to ship
the Tauri desktop app under your own brand, three upstream-pinned
values need changing — skip this entire phase for a web-only fork.

### 9a. Tauri updater endpoint + signing key

`src-tauri/tauri.conf.json` hardcodes the auto-update feed and the
public half of the upstream signing key:

```jsonc
"updater": {
  "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6…",          // upstream's key
  "endpoints": [
    "https://github.com/zyra-project/terraviz/releases/latest/download/latest.json"
  ]
}
```

A fork that builds desktop binaries must:

1. Generate its own key:
   `npm run tauri signer generate -- -w "<password>"`.
2. Paste the **public** key into `tauri.conf.json` `pubkey`.
3. Change `endpoints` to your fork's releases:
   `https://github.com/<your-org>/<repo>/releases/latest/download/latest.json`.
4. Set the repo secrets `TAURI_SIGNING_PRIVATE_KEY` and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (consumed by `release.yml`
   and `desktop.yml`).

If you leave the upstream pubkey/endpoint, your users' apps will
poll the **upstream** release feed and reject any update you sign
with a different key.

### 9b. macOS notarization (optional)

`release.yml` signs + notarizes macOS builds only when the six
`APPLE_*` secrets are present
(`APPLE_DEVELOPER_ID_CERTIFICATE_BASE64`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). Without them the
build still succeeds but ships unsigned — macOS users hit the
Gatekeeper "damaged" warning until they bypass it.

### 9c. `VITE_API_ORIGIN` for desktop API calls

Desktop builds can't serve relative `/api/` paths (the webview
origin is `tauri://localhost`), so `src/services/catalogSource.ts`
rewrites them to an absolute origin — defaulting to
`https://terraviz.zyra-project.org`. Set the **build-time** env var
`VITE_API_ORIGIN=https://terraviz.your-org.org` so your desktop app
talks to **your** backend instead of upstream's. (Web builds ignore
this for API routing — they're already same-origin.)

This same value also drives deep-link host recognition
(`parseDatasetFromUrl`), so setting it makes your node accept its
own `/dataset/<id>` links on both web and desktop.

### 9d. Weblate (translation sync)

`sync-weblate.yml` calls `npm run sync:weblate`, which defaults to
the upstream Weblate project (`hosted.weblate.org`, project
`terraviz`, component `app-locales`) and needs a `WEBLATE_TOKEN`
secret. A fork that doesn't run its own translation pipeline should
disable this workflow; otherwise it fails on every push to `main`
for lack of the token. To run your own, set `WEBLATE_TOKEN` and
override `WEBLATE_URL` / `WEBLATE_PROJECT` / `WEBLATE_COMPONENT` in
the workflow.

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

### `/.well-known/terraviz.json` 503s, or publishing fails on `origin_node`

The remote `node_identity` table is empty — you applied the
catalog migrations but never provisioned the identity row.
Symptoms: `/.well-known/terraviz.json` returns
503 `identity_missing`, and any publish / `import-snapshot` row
fails (the dataset insert's `origin_node` subquery returns `NULL`
against a `NOT NULL` column). The local `db:seed` / `gen:node-key`
paths do **not** write remote D1. Fix: provision the row per
**§8b.6** before importing. (The 503's "Run `npm run gen:node-key`"
hint is misleading — that script only updates your local copy.)

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
- **Add a Content-Security-Policy.** The app ships **no CSP** in the
  repo — `src/index.html` has no `<meta>` policy and `public/_headers`
  sets `X-Content-Type-Options` / `Referrer-Policy` /
  `Permissions-Policy` but no CSP. The upstream production deploy
  enforces a strict `connect-src` CSP **at the Cloudflare edge**
  (dashboard / Transform Rules), so it is **not inherited by a
  fork**. Your node functions without one, but you should add your
  own — either an edge rule or a `Content-Security-Policy` line in
  `public/_headers`. A working starting point needs to allow your
  own origin plus the external origins the app talks to:
  - `connect-src`: `'self'`, your video/caption proxy
    (`VITE_VIDEO_PROXY_BASE` host), `gibs.earthdata.nasa.gov`,
    `s3.dualstack.us-east-1.amazonaws.com` (SOS snapshot), and your
    R2 public host if set.
  - `img-src` / `media-src`: `'self'` `data:` `blob:`, your Earth-asset
    host (`VITE_EARTH_ASSET_BASE`), the SOS/CloudFront asset hosts,
    and your R2 public host.
  - Note the app uses `blob:` (preview tours, screenshots) — omitting
    it from `connect-src` reproduces the "may not load data from
    blob:" bug the code comments reference. Test playback, VR, and a
    tour before locking it down.

If you find something broken or under-documented, please open an
issue against the upstream repo — half of this doc was written
because someone hit a snag and it was worth capturing.
