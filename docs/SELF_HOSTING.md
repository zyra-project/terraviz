# Self-hosting Terraviz

End-to-end walkthrough for deploying your own Terraviz instance on
Cloudflare Pages with a custom domain, the analytics pipeline, the
admin endpoints, and (optionally) Grafana dashboards. Plan ~60–90
minutes for a clean run-through; less if you already have a
Cloudflare-managed domain.

This doc is the "fork it, run it yourself" path. If you're a
contributor working on the upstream repo, see
[`ANALYTICS_CONTRIBUTING.md`](ANALYTICS_CONTRIBUTING.md) instead.

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
