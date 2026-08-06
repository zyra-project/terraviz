# Catalog Backend Development

How a contributor runs the catalog backend on their laptop, what
the repo looks like, how tests are layered, and what CI/CD does
on the way to production. Companion to
[`CATALOG_BACKEND_PLAN.md`](CATALOG_BACKEND_PLAN.md); schema
referenced from
[`CATALOG_DATA_MODEL.md`](CATALOG_DATA_MODEL.md); the
federation conformance test runs against the protocol described
in
[`CATALOG_FEDERATION_PROTOCOL.md`](CATALOG_FEDERATION_PROTOCOL.md).

The plan is unbuildable without an answer to "how do I run the
catalog backend on my laptop." Cloudflare Pages Functions, D1,
KV, R2, Stream, and Queues all have local-emulation stories of
varying maturity; the plan picks one path and commits to it.

## Onboarding

A from-zero checklist for a new contributor. The goal is: from a
fresh clone, you can run the catalog backend, hit
`/api/v1/catalog`, and see seeded data in under thirty minutes.
If any step takes substantially longer than that, please open an
issue — the checklist is a contract, not a wish.

### Prerequisites

- **Cloudflare account.** Free plan is sufficient for local
  development. Workers Paid ($5/mo) is required for the production
  deploy story (see "Free-tier viability" in
  [`CATALOG_BACKEND_PLAN.md`](CATALOG_BACKEND_PLAN.md));
  contributors do not need it.
- **Node.js ≥ 22.** What `package.json` `engines` requires; Wrangler 4+ needs at least 20.10.
- **A POSIX-y shell.** The dev scripts assume bash/zsh; PowerShell
  works but the npm scripts hard-code forward slashes.
- **Rust toolchain** is only required if you will touch the
  desktop app — unrelated to the catalog backend, but flagged
  because the repo contains both.

### Day-zero checklist

```bash
# 1. Clone and install.
git clone https://github.com/zyra-project/terraviz
cd terraviz
npm install

# 2. Generate the node-identity keypair. Writes the private half to
#    .dev.vars (created if missing) and updates node_identity once
#    the local DB is seeded in step 3.
npm run gen:node-key

# 3. Reset the local D1: applies migrations, seeds ~20 SOS rows
#    (use `db:reset --full` to import the entire upstream catalog).
npm run db:reset

# 4. Configure the dev-bypass for the publisher API. Skips Access
#    verification for localhost-only runs.
cp .dev.vars.example .dev.vars
# Open .dev.vars and ensure DEV_BYPASS_ACCESS=true is uncommented.

# 5. Run the backend.
npm run dev:functions     # pane 1 — Wrangler at :8788 with --ip 0.0.0.0
npm run dev               # pane 2 — Vite at :5173
# Dev-container contributors: set VITE_HOST=0.0.0.0 in .env.local
# so the host browser can reach Vite. See "Dev-container caveats"
# below.

# 6. Verify.
curl http://localhost:8788/api/v1/catalog | jq '.datasets | length'
# → 20 (the seed importer's default subset)

curl http://localhost:8788/.well-known/terraviz.json | jq .public_key
# → "ed25519:<base64>" matching node-public-key.txt

curl http://localhost:8788/api/v1/publish/me | jq .role
# → "staff" (DEV_BYPASS_ACCESS is honoring the loopback hostname)
```

If steps 6's three calls all return the expected shape, you have
a working backend. To run the SPA against this local node instead
of the SOS-S3 source:

```bash
cp .env.example .env.local
# Open .env.local and uncomment:
#   VITE_CATALOG_SOURCE=node
#   VITE_DEV_API_TARGET=http://localhost:8788
# Restart `npm run dev` so Vite re-reads the env file.
```

The browse panel should then show the seeded ~20 datasets pulled
from `/api/v1/catalog` instead of the upstream SOS catalog.

### Dev-container caveats

If you are running inside a Docker / VS Code dev container, three
extra knobs make the browser-from-host story work:

| Symptom | Setting | Where |
|---|---|---|
| Curl times out from inside the container despite "Ready on http://localhost:8788" | `npm run dev:functions` already sets `--ip 0.0.0.0` | scripts |
| Browser at `http://localhost:5173` spins / can't connect | `VITE_HOST=0.0.0.0` | `.env.local` |
| HMR WebSocket fails repeatedly with `[vite] connecting...` | `VITE_HMR_CLIENT_PORT=5173` (or the host-side forwarded port) | `.env.local` |

### Required dev vars

`.dev.vars` is a Wrangler-format file (`KEY=value`, one per line)
that provides secrets to local Pages Functions. It is gitignored.
The template (`.dev.vars.example`) lists the keys; actual values
come from these sources:

| Key | Where to get it | Needed in |
|---|---|---|
| `NODE_ID_PRIVATE_KEY_PEM` | Generate with `npm run gen:node-key`; writes both `.dev.vars` and `node-public-key.txt`. Updates `node_identity.public_key` in the local D1 in the same step. | Phase 1a |
| `DEV_BYPASS_ACCESS` | Set to `true` for local dev. Skips Cloudflare Access verification for `/api/v1/publish/**` and JIT-mints a staff publisher row keyed off `DEV_PUBLISHER_EMAIL`. Refused on non-loopback hostnames. | Phase 1a |
| `DEV_PUBLISHER_EMAIL` | Whatever email you want the dev-bypass publisher row to carry. Defaults to `dev@localhost`. | Phase 1a |
| `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` | Cloudflare dashboard → Zero Trust → Access → Applications. Only needed when `DEV_BYPASS_ACCESS` is unset; production deploys must set both. | Phase 1a (prod) |
| `PREVIEW_SIGNING_KEY` | HMAC-SHA-256 secret for preview tokens. **Required in production** — the preview endpoints fail closed (503 `preview_unconfigured`) when this is unset. A deterministic dev fallback exists, but it requires *both* `DEV_BYPASS_ACCESS=true` *and* `ALLOW_DEV_PREVIEW_FALLBACK=true` to activate (the doubled gate keeps a production misconfig from accepting forged tokens via the anonymous preview consumer, which lives outside the publish middleware). Set the real value via `npx wrangler pages secret put PREVIEW_SIGNING_KEY` on the production deployment. | Phase 1a (prod) |
| `ALLOW_DEV_PREVIEW_FALLBACK` | `true` to opt into the deterministic dev preview-signing secret. Only honored when `DEV_BYPASS_ACCESS=true` is also set. | Phase 1a (dev only) |
| `VIDEO_PROXY_BASE` | Override the upstream Vimeo proxy. Defaults to the production proxy when unset. | Phase 1a |
| `MOCK_STREAM` | `.dev.vars.example` sets this to `true` by default. The asset-init handler returns deterministic stub Stream upload URLs, and the transcode-status helper reports `ready` immediately, so the contributor walkthrough works without a Cloudflare Stream subscription. | Phase 1b |
| `STREAM_ACCOUNT_ID` / `STREAM_API_TOKEN` | Cloudflare dashboard → Stream. Only needed when `MOCK_STREAM` is unset. The token requires `Stream: Edit` permission. | Phase 1b (prod) |
| `STREAM_CUSTOMER_SUBDOMAIN` | The `customer-<id>.cloudflarestream.com` hostname the dashboard prints. Used to build the public HLS playback URL the manifest endpoint serves. Mock mode falls back to `customer-mock.cloudflarestream.com` when this is unset. | Phase 1b (prod) |
| `MOCK_R2` | `.dev.vars.example` sets this to `true` by default. The asset-init handler returns deterministic `https://mock-r2.localhost/...` URLs instead of real presigned ones. Because no bytes are uploaded to that mock URL, `/asset/{upload_id}/complete` skips the binding-based digest verification and trusts the publisher's claimed digest. Refused on non-loopback hostnames so a production misconfig can't accept forged claims. | Phase 1b |
| `R2_S3_ENDPOINT` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Cloudflare dashboard → R2 → Manage API tokens. Only needed when `MOCK_R2` is unset. The presigning helper signs against the S3-compatible endpoint Cloudflare prints on the bucket page; access keys live as Wrangler secrets in production. | Phase 1b (prod) |
| `R2_PUBLIC_BASE` | Public-readable origin the manifest endpoint emits for `r2:` data_refs (custom-domain mapping like `https://assets.terraviz.example.com` or the bucket's native public URL). Without this, the manifest falls back to `MOCK_R2` (dev) or the S3 endpoint (public buckets only); restricted-bucket presigned-GET semantics are a Phase 4 follow-on. | Phase 1b (prod) |
| `CATALOG_R2_BUCKET` | Bucket name override; defaults to `terraviz-assets` to match `wrangler.toml`. Only set this if a fork picks a different name. | Phase 1b |
| `CF_IMAGES_RESIZE_BASE` | Origin used by the sphere-thumbnail pipeline to resize R2 image sources via Cloudflare Images URL transformations. When unset, the job falls back to fetching the source bytes directly. The publisher portal's "regenerate sphere thumbnail" button (Phase 3) lets a publisher provide a hand-cropped version manually. | Phase 1b |
| `MOCK_VECTORIZE` | `.dev.vars.example` sets this to `true` by default. Swaps the Vectorize binding for an in-memory store keyed off the env object; the mock implements cosine similarity + the docent's filter operator subset (`$eq` / `$ne` / `$in` / `$nin`), so a multi-step "publish three datasets, search for the closest one" walk works without a real Vectorize index. Helpers raise `ConfigurationError` on a deploy with neither real binding nor mock flag. | Phase 1c |
| `MOCK_AI` | `.dev.vars.example` sets this to `true` by default. The embedding helper returns a deterministic 768-dim feature-hashed vector instead of calling Workers AI; vocabulary overlap drives cosine similarity so the mock walks behave like real embeddings at a coarse level. Same fail-closed surface as `MOCK_VECTORIZE`. | Phase 1c |
| `KILL_TELEMETRY` | Set `1` to disable analytics ingestion locally — almost always what you want during dev. | n/a |

Phase-1a contributors realistically only need `NODE_ID_PRIVATE_KEY_PEM`,
`DEV_BYPASS_ACCESS=true`, and `KILL_TELEMETRY=1`. Phase 1b adds
`MOCK_STREAM=true` + `MOCK_R2=true` (both set by the example
template), nothing else. Phase 1c adds `MOCK_VECTORIZE=true` +
`MOCK_AI=true` (also set by the example template). The real
`STREAM_*` / `R2_*` env vars and the real Vectorize / Workers AI
bindings stay unset locally because the contributor walkthrough is
mock-mode-only — production deploys configure them via
`wrangler pages secret put` and the dashboard's Bindings UI.

### What "good" looks like

After the checklist runs clean, you should be able to:

- Run `npm run test` and see the suite pass — including the
  catalog-backend tests under `functions/api/v1/**` and the CLI
  tests under `cli/**` (1100+ tests as of Phase 1a).
- Run `npm run db:reset` and have the seed re-apply cleanly (no
  schema drift between migrations and `.wrangler/state`).
- Open `http://localhost:8788/.well-known/terraviz.json` and see
  the node-identity document carrying the public key you minted in
  step 2.
- See a Wrangler startup line that reads
  `Ready on http://localhost:8788` with `CATALOG_DB`, `CATALOG_KV`,
  `CATALOG_R2`, `FEEDBACK_DB`, and the analytics + AI bindings all
  listed (Stream is mock-only — there's no Stream binding to print).
- Round-trip a draft via the CLI:
  ```bash
  echo '{"title":"From CLI","format":"video/mp4",
        "data_ref":"vimeo:1107911993","license_spdx":"CC-BY-4.0"}' \
    > /tmp/m.json
  npm run terraviz -- --server http://localhost:8788 \
    --insecure-local publish /tmp/m.json
  ```
  → "Created draft …" then "Published … (timestamp)".
- (Phase 1b) Round-trip an asset upload end-to-end using the mock
  pipeline. Pick any small file lying around — `MOCK_STREAM` /
  `MOCK_R2` make the byte path a no-op; only the catalog rows
  flow:
  ```bash
  # Create a draft to attach the asset to.
  echo '{"title":"Asset roundtrip","format":"image/png"}' \
    > /tmp/asset-draft.json
  ID=$(npm run --silent terraviz -- publish /tmp/asset-draft.json \
        --draft-only --server http://localhost:8788 --insecure-local \
        | awk '/Created draft/ {print $3}')
  # Upload a thumbnail. The CLI hashes the file, calls /asset to mint
  # a (mock) presigned URL, sees the response's `mock: true` flag,
  # and skips the byte PUT entirely. /complete then trusts the
  # publisher's claimed digest (no bytes were uploaded to verify
  # against), flips `thumbnail_ref`, and enqueues a sphere-thumbnail
  # job against the in-memory queue shim.
  npm run terraviz -- upload "$ID" thumbnail ./public/favicon.svg \
    --mime=image/png --server http://localhost:8788 --insecure-local
  ```
  → "completed", then `terraviz get $ID` shows `thumbnail_ref`
  populated with `r2:datasets/<id>/by-digest/sha256/.../thumbnail.png`.
- (Phase 1c) Round-trip the docent's search path end-to-end against
  the mocked Vectorize + Workers AI bindings. Publish a few topical
  drafts, then hit the public search endpoint and verify the
  closest one ranks first:
  ```bash
  # Publish three drafts with distinguishing keywords. The
  # publisher route's WaitUntilJobQueue runs the embed_dataset job
  # against MOCK_AI / MOCK_VECTORIZE on the same isolate, so the
  # vectors land before the next request.
  for topic in hurricane volcano ocean; do
    cat > /tmp/${topic}.json <<EOF
  {"title":"${topic^} Demo","format":"video/mp4",
   "data_ref":"vimeo:1","license_spdx":"CC-BY-4.0",
   "abstract":"A short demo dataset about ${topic}s.",
   "keywords":["${topic}","demo"]}
  EOF
    npm run terraviz -- --server http://localhost:8788 \
      --insecure-local publish /tmp/${topic}.json
  done

  # Semantic search. The mock embedder is bag-of-words-ish, so a
  # query sharing tokens with the publisher's text scores highest.
  curl -s 'http://localhost:8788/api/v1/search?q=hurricane&limit=3' \
    | jq '.datasets[] | {id, title, score}'
  ```
  → the "Hurricane Demo" row leads, with the other two trailing.
  The response includes `id`, `title`, `abstract_snippet`,
  `categories`, `peer_id` (`"local"` for own-node rows), and the
  cosine `score`.
- (Phase 1c) Featured-list endpoint:
  ```bash
  # Curl the public read — empty until you curate via the publisher
  # API.
  curl -s http://localhost:8788/api/v1/featured | jq

  # Pin one of the rows to the featured list (staff-only mutation,
  # dev-bypass mints a staff session).
  curl -s -X POST -H 'Content-Type: application/json' \
    -d "{\"dataset_id\":\"$ID\",\"position\":0}" \
    http://localhost:8788/api/v1/publish/featured | jq

  # Re-curl — the dataset now appears in the docent-shaped payload
  # (id, title, abstract_snippet, thumbnail_url, categories,
  # position).
  curl -s http://localhost:8788/api/v1/featured | jq
  ```
- (Phase 1c) Verify the docent path end-to-end against the mocked
  backend:
  ```bash
  # Open the dev frontend.
  npm run dev
  ```
  Open `http://localhost:5173`, click the Orbit chat trigger, ask
  "Show me datasets about hurricanes." The chat panel's network
  tab should show a request to `/api/v1/search?q=hurricane` (the
  docent's `search_datasets` tool); the response feeds back into
  the LLM round which then proposes the seeded dataset with a
  `<<LOAD:...>>` marker. Asking "What's interesting?" with no
  topic triggers `list_featured_datasets` against
  `/api/v1/featured` instead.
- (Phase 1d) Bulk-import the legacy SOS catalog and verify the
  docent answers from real datasets. This is the cutover step —
  with the catalog populated, `search_datasets` (the post-1d
  default tool) finds real rows and the frontend's
  `VITE_CATALOG_SOURCE=node` default points at the same backend.
  Always walk the dry-run first so you can see what will land:
  ```bash
  # Plan only — no writes. Prints a per-reason skip breakdown
  # (unsupported_format for KML / DDS / TLE rows, duplicate_id
  # for the upstream catalog's repeated SOS ids).
  npm run terraviz -- --server http://localhost:8788 \
    --insecure-local import-snapshot --dry-run

  # Apply. Each row goes through POST /publish/datasets +
  # POST /publish/datasets/{id}/publish; the Phase 1c/D embed
  # enqueue fires per publish, so by the end the Vectorize
  # index covers the catalog. Paced at ~5 rows/sec to stay under
  # Workers AI quota; ~600 rows takes a few minutes.
  npm run terraviz -- --server http://localhost:8788 \
    --insecure-local import-snapshot

  # Re-running is a no-op except for new snapshot rows — the
  # legacy_id column on `datasets` is the idempotency key.
  npm run terraviz -- --server http://localhost:8788 \
    --insecure-local import-snapshot
  ```
  → first dry-run reports `new rows to publish: <N>`; first apply
  reports `imported: <N>`; the second apply reports
  `already imported: <N>` and `imported: 0`.

  Then verify the docent answers from the real catalog:
  ```bash
  npm run dev
  ```
  Open `http://localhost:5173`, ask "Show me datasets about
  hurricanes". The chat panel's network tab shows
  `/api/v1/search?q=hurricane`; the response feeds the LLM,
  which proposes a real SOS row by title with a `<<LOAD:...>>`
  marker. Click the chip — the dataset loads via
  `/api/v1/datasets/{id}/manifest`, exercising the importer's
  `vimeo:` / `url:` data_ref pass-through end-to-end.

- (Phase 1d, operator) Backfill the Vectorize index for a catalog
  that was already populated before Vectorize was wired up, or
  roll out a future model-version bump:
  ```bash
  # Plan only — prints the count of published rows that would be
  # re-enqueued.
  npm run terraviz -- --server http://localhost:8788 \
    --insecure-local import-snapshot --reindex --dry-run

  # Apply.
  npm run terraviz -- --server http://localhost:8788 \
    --insecure-local import-snapshot --reindex
  ```
  Each row hits `POST /publish/datasets/{id}/reindex`, paced at
  the same ~5 rows/sec. The route returns 503
  `embed_unconfigured` if Workers AI / Vectorize bindings are
  missing — fix the bindings before re-running.

#### Cutover rollback recipe

The Phase 1d cutover (commits 1d/E, 1d/F, 1d/G) is reversible
without schema or data changes. If a regression surfaces in
production:

- **Frontend regression** (browse UI / docent UI broken under the
  node catalog) — set `VITE_CATALOG_SOURCE=legacy` in the Pages
  build env and redeploy. The SPA falls back to the SOS S3 path
  immediately; the catalog backend keeps running for
  CLI / API consumers.
- **Docent regression** (LLM stops returning chips, or invents
  dataset titles) — `git revert` the cutover commits in their own
  PR. The three commits are independent reverts: 1d/E (tool
  ordering), 1d/F (pre-search injection), 1d/G (frontend default).
  Reverting just F restores the `[RELEVANT DATASETS]` injection;
  reverting just E flips the tool list back to search_catalog-first.
- **Catalog data regression** — the imported rows stay published
  through any of the above rollbacks. To remove them, retract via
  `terraviz retract <id>` (per row) or wipe the catalog tables
  via `npm run db:reset`. The `legacy_id` column means a future
  re-import is a clean no-op against rows that are still
  published.

If any of these fail, the troubleshooting matrix in "Local
debugging" below lists the common causes.

#### Docent troubleshooting — "chat works but Load chips don't render"

The docent's response path depends on three behaviours from the
configured LLM:
  1. Calling `search_datasets` (or `search_catalog` as fallback)
     when the user expresses a discovery intent.
  2. Copying the resulting `id` strings verbatim into
     `<<LOAD:...>>` markers.
  3. Not narrating internal reasoning ("Silently…", "Step 1…",
     etc.) into the user-visible reply.

When chips don't render despite the chat working, the LLM is
breaking one of those rules. The `validateAndCleanText` safety
net (1c/M) strips hallucinated IDs and logs them to the console as
`[Docent] Stripped hallucinated dataset IDs: [...]` — that log is
the first place to look.

Diagnostic order:

1. **Check the configured model**
   (Orbit panel → ⚙ Settings → Model). Any Llama 3.x or 4.x
   variant exposed by Workers AI supports OpenAI-compatible tool
   calling. Specific behaviour varies by model and changes across
   Cloudflare's deploy schedule, so model-by-model verdicts in this
   doc would rot quickly. Test empirically: ask a clear discovery
   question ("show me datasets about hurricanes") and watch the
   browser network tab for the `/api/v1/search?q=...` call. If the
   call fires and returns real results but the marker IDs come
   back as hallucinations, suspect the prompt before the model.

2. **Check the system prompt** — `src/services/docentContext.ts`
   `buildSystemPrompt`. The cutover history (1d/S, 1d/W) is full
   of cases where a confidently-capable model failed because the
   prompt example contained narrate-able annotations or a
   real-looking ID prefix the model would mimic. The prompt itself
   is the most common cause of "model can't copy IDs" symptoms;
   it's much more often the bug than model size.

3. **Check the search result shape**. Hit
   `/api/v1/search?q=hurricane` directly via curl. If it returns
   `{datasets: [], degraded: 'unconfigured'}`, the embed pipeline
   isn't wired (Workers AI / Vectorize bindings missing); if it
   returns real ULIDs, the LLM has what it needs and the issue is
   prompt-side.

The intuition "smaller models hallucinate more" is broadly true,
but during cutover the prompt was responsible for confabulation
patterns that affected every model. Don't assume the model is the
floor without verifying the prompt isn't.

#### Cost model — what changed at the cutover

The cutover went through two iterations on this question:

**1d/F (initial cutover)** removed the `[RELEVANT DATASETS]`
injection from the docent's user-message build entirely, on the
assumption that the LLM would tool-call `search_datasets` itself
when it needed grounded IDs. Live testing on llama-4-scout (and
sometimes llama-3.1-70b) showed mid-tier models confabulate
id-shaped strings rather than reliably calling the tool, which
the validator strips — chips silently disappeared.

**1d/AC (corrected)** restored the per-turn injection, this time
sourced from the Vectorize-backed `search_datasets` instead of
the legacy in-memory keyword scan. The injection runs server-side
before the LLM call for discovery-intent queries; the LLM sees
real ULIDs in `[RELEVANT DATASETS]` and produces chips reliably
without needing to tool-call.

| Turn shape | Pre-1d cost | Post-1d/AC cost | Δ |
|---|---|---|---|
| User asks a knowledge question (`hello`, `explain this`) | inject 500–1000 tokens for non-discovery? Actually no — the gate skipped these | nothing extra, 1 round | **same** |
| User asks a discovery question, LLM uses [RELEVANT DATASETS] without tool-calling | inject 500–1000 tokens (in-memory keyword scan), 1 LLM round | inject 1000–1500 tokens (Vectorize results, slightly richer with abstract_snippet), 1 LLM round | **+~500 tokens, no extra round** |
| User asks a follow-up the [RELEVANT DATASETS] block doesn't cover, LLM tool-calls `search_datasets` | inject 500–1000 + tool round-trip 1000–1500, 2 rounds | inject 1000–1500 + tool round-trip 1000–1500, 2 rounds | **+~500 tokens for the same round count** |

So 1d/AC is modestly more expensive per discovery-intent turn
than the pre-cutover regime (Vectorize results carry abstract
snippets the in-memory scan didn't), but the architectural shift
to a single Vectorize-backed search source of truth is preserved
and the docent's chip-render reliability matches pre-cutover.

`MAX_TOOL_CALL_ROUNDS` in `src/services/docentService.ts` caps
tool-call chains at 5 per turn so a runaway model can't burn
unbounded rounds. The `turn_rounds` analytics field (1d/Y)
records the actual round count per turn for empirical
measurement; operators investigating quota burn can compare
`turn_rounds` distributions in Grafana against the cap to spot
chains that hit the ceiling.

Phase 1d/Y plumbs `turn_rounds` through to the `orbit_turn`
analytics event. Grafana panel filters can compare pre/post
distributions and answer "what fraction of turns are
tool-calling now?" empirically. Field positions:
[`docs/ANALYTICS_QUERIES.md` § `orbit_turn`](ANALYTICS_QUERIES.md#orbit_turn).

Phase 1f/E ships the dashboard that consumes those fields:
**[Terraviz — Orbit Cost](../grafana/dashboards/orbit-cost.json)**.
Panels:

- **Turn rounds distribution** — direct (`turn_rounds=1`) vs
  tool-calling (`≥2`) per day, stacked. The ratio is the leading
  indicator of per-turn cost; a sustained shift toward
  tool-calling means more neurons burned per turn.
- **Total LLM rounds per day** — `sum(turn_rounds)` across all
  assistant turns. The raw cost driver for free-tier neuron
  exhaustion.
- **Turn duration p95** — split by direct / tool-calling. A
  widening gap suggests the LLM is taking more rounds to answer,
  an early signal of regression in the system prompt or grounding
  payload.
- **Top 10 hashed query terms (browse search)** — frequency
  ranking via `browse_search.query_hash`. The docent's per-turn
  text is not hashed at emit time (raw user prompts would defeat
  the privacy contract), so the panel uses browse-side as a proxy
  for "topics users are exploring".

### Account-level setup (production-leaning)

Most contributors never touch this. You only need it if you are
preparing a deploy environment, not running locally:

- A D1 database. The reference deploy reuses the existing
  `sphere-feedback` D1 (same `database_id`, separate tables) and
  binds it twice — `FEEDBACK_DB` for the existing rows and
  `CATALOG_DB` for the catalog tables — so the catalog and feedback
  share one D1 quota. A fork that prefers a clean separation can
  `wrangler d1 create terraviz-catalog` and point only the
  `CATALOG_DB` binding at the new database. Either way, copy the
  `database_id` into `wrangler.toml`'s `[[d1_databases]]` block for
  `CATALOG_DB`.
- A KV namespace and an R2 bucket — same dashboard / CLI flow,
  bindings declared in `wrangler.toml`. Phase 1b ships the
  `CATALOG_R2` binding (bucket: `terraviz-assets`); the bucket can
  be created with `wrangler r2 bucket create terraviz-assets`. R2
  S3 access keys live under "Manage API tokens"; mint a
  Read+Write token scoped to the bucket and stash the access-key
  pair as `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` Wrangler
  secrets.
- A Stream account on the same Cloudflare account if you will
  exercise asset uploads in a non-mock environment (Phase 1b
  onward). Mint an API token with `Stream: Edit` permission;
  store as `STREAM_API_TOKEN`. The customer subdomain
  (`customer-<id>.cloudflarestream.com`) goes in
  `STREAM_CUSTOMER_SUBDOMAIN` so the manifest endpoint can build
  HLS playback URLs without a runtime Stream API call.
- Cloudflare Access enabled on `/api/v1/publish/**` from Phase 1a
  onward — both the CLI service-token flow and (from Phase 3) the
  browser portal flow attach to the same policy. Local dev does
  not need Access; the publisher API has a `DEV_BYPASS_ACCESS=true`
  flag that mints a fake `staff` publisher row keyed off the
  local user's email, and the CLI accepts a
  `TERRAVIZ_INSECURE_LOCAL=1` flag that skips service-token
  validation when targeting `localhost:8788`.
- (Phase 1c) A Cloudflare Vectorize index for the docent search
  surface. Provision once per deploy:
  ```bash
  wrangler vectorize create terraviz-datasets \
    --dimensions=768 --metric=cosine
  wrangler vectorize create-metadata-index terraviz-datasets \
    --property-name=peer_id --type=string
  wrangler vectorize create-metadata-index terraviz-datasets \
    --property-name=category --type=string
  wrangler vectorize create-metadata-index terraviz-datasets \
    --property-name=visibility --type=string
  ```
  Then bind it under Settings → Bindings → Vectorize → variable
  name `CATALOG_VECTORIZE` → index `terraviz-datasets`. The dim
  count + metric must match the `@cf/baai/bge-base-en-v1.5` model
  the embedding pipeline uses (768-dim, cosine); see
  `_lib/embeddings.ts` for the `EMBEDDING_MODEL_VERSION` constant
  that pins the (model × text shape × pooling) tuple. The
  Workers AI binding (`AI`) is already provisioned for the
  analytics + chat path; the embedding pipeline reuses it.
- (Phase 1d) Import the legacy SOS catalog so the deployment has
  rows to surface. With Vectorize bound and the publisher API
  reachable, run the bulk importer once per fresh deploy:
  ```bash
  # Always dry-run first.
  npm run terraviz -- --server https://terraviz.example.org \
    --client-id "$CF_ACCESS_CLIENT_ID" \
    --client-secret "$CF_ACCESS_CLIENT_SECRET" \
    import-snapshot --dry-run

  # Apply. The embed pipeline fires per publish, so by the end
  # the Vectorize index covers the catalog and the docent's
  # search_datasets tool returns useful results.
  npm run terraviz -- --server https://terraviz.example.org \
    --client-id "$CF_ACCESS_CLIENT_ID" \
    --client-secret "$CF_ACCESS_CLIENT_SECRET" \
    import-snapshot
  ```
  The importer is idempotent — re-running is a no-op on rows
  already imported (the `legacy_id` column on `datasets` is the
  key). For an existing catalog where Vectorize was bound after
  the rows were published, the same CLI binary handles the
  backfill via `--reindex`. The "What good looks like" section
  has the per-step verification.

The self-hosting walkthrough at
[`docs/SELF_HOSTING.md`](SELF_HOSTING.md) is the more thorough
reference for the full deploy story; the section above is the
minimum a contributor needs to know.

### Production deployment checklist — first-deploy walkthrough

The Account-level setup above is a topical reference. This
subsection is the same material organised as a sequence, because
the order matters and several steps don't take effect until later
ones run. Working through it in order from a fresh fork avoids the
recurring "503 binding_missing on the production hostname even
though everything looks configured" gotcha.

#### Step 1 — Apply catalog migrations to the production D1

The `migrations/catalog/` files create the `datasets`,
`publishers`, `node_identity`, `featured_datasets`,
`asset_uploads`, `audit_events`, and decoration tables. Until they
run against the production D1, every catalog endpoint 5xx's.

Two paths:

- **Wrangler CLI**:
  ```
  wrangler d1 migrations apply CATALOG_DB --remote
  ```
  Requires `wrangler login` to have completed against an account
  that owns the D1.
- **Cloudflare dashboard → Workers & Pages → D1 → `sphere-feedback`
  → Console**: paste each migration file's contents in order
  (`0001_init.sql` through `0008_legacy_id.sql` as of Phase 1d).
  Slower but works when CLI auth fails.

Verify with:
```sql
SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;
```
The catalog tables (`datasets`, `dataset_categories`, etc.) plus
the existing feedback tables should be present.

#### Step 2 — Provision `node_identity`

The catalog backend needs exactly one `node_identity` row before
any read or write endpoint will serve. The `gen-node-key` script
generates a keypair locally and writes to local D1 only; the
production row has to be inserted manually.

1. Run `npm run gen:node-key` locally — produces
   `node-public-key.txt` (wire-format `ed25519:<base64>`) and
   writes the private half to `.dev.vars`.
2. Set the private half as a Wrangler/Pages secret:
   `npx wrangler pages secret put NODE_ID_PRIVATE_KEY_PEM`, OR via
   dashboard env vars (mark as Secret).
3. Insert the public-half row via the D1 console:
   ```sql
   INSERT INTO node_identity
     (node_id, display_name, base_url, contact_email, public_key, created_at)
   VALUES
     ('NODE-YOUR-PROD-001', 'Your Node', 'https://your-domain',
      'you@example.com', 'ed25519:<paste from node-public-key.txt>',
      '2026-01-01T00:00:00.000Z');
   ```
4. Verify: `curl https://your-domain/.well-known/terraviz.json`
   should return your real `node_id`, `display_name`, and
   `public_key`.

#### Step 3 — Configure Cloudflare Access for the publisher API

`/api/v1/publish/**` is gated by Cloudflare Access. Without an
Access app, the middleware refuses with `503 access_unconfigured`.

1. **Zero Trust → Access → Applications → Add → Self-hosted**
2. Application name: `Terraviz Publisher API`
3. Destinations covering every hostname the API will be reached on:
   `*.your-pages-domain.pages.dev/api/v1/publish/*`,
   `your-domain/api/v1/publish/*`, etc. The wildcard subdomain
   covers all preview branches.
4. Two policies, in this order:
   - `Service Token` policy, **Action: Service Auth**, Include →
     Service Token → the token you'll create next. (`Service Auth`
     is a distinct action from `Allow`; only Service Auth bypasses
     interactive SSO for token-only callers.)
   - `Staff` policy, **Action: Allow**, Include → Emails ending
     in → your-org.org. (Use the suffix matcher, not the
     exact-match selector.)
5. **Service Auth → Service Tokens → Create Service Token** named
   `terraviz-cli`. Copy the Client ID + Client Secret immediately
   — the secret is shown once.
6. From the Access app's Overview tab, copy the **Application
   Audience (AUD) Tag** (64-char hex).

#### Step 4 — Set Pages env vars and bindings (Production AND Preview)

Both environments need separate toggles in the dashboard. The
publisher middleware fail-closes when either of `ACCESS_TEAM_DOMAIN`
/ `ACCESS_AUD` is missing, and the catalog endpoint 503s when
`CATALOG_DB` is missing — same shape as forgetting to copy the
config.

**Cloudflare dashboard → Workers & Pages → terraviz → Settings →
Variables and Bindings**:

| Type | Name | Value |
|---|---|---|
| Plaintext | `ACCESS_TEAM_DOMAIN` | `your-team.cloudflareaccess.com` (no protocol) |
| Plaintext | `ACCESS_AUD` | the AUD tag from Step 3 |
| Secret | `NODE_ID_PRIVATE_KEY_PEM` | the base64 PKCS8 from Step 2 |
| Binding (D1) | `CATALOG_DB` | `sphere-feedback` (or your DB) |
| Binding (KV) | `CATALOG_KV` | namespace created via `wrangler kv namespace create CATALOG_KV` |
| Binding (R2) | `CATALOG_R2` | `terraviz-assets` bucket |
| Binding (Workers AI) | `AI` | (auto-detected) |
| Binding (Vectorize) | `CATALOG_VECTORIZE` | `terraviz-datasets` index |

**For each row, verify the Environment column shows "Production,
Preview"** — the dashboard offers a separate toggle per
environment and forgetting either one is the most common cause of
"works on preview, breaks on production" reports.

#### Step 5 — Trigger a production redeploy

Adding bindings via the dashboard does **not** retro-fit them onto
running deployments. Either:

- Push a commit to the production branch (`main` by default), which
  triggers an auto-build with current bindings in scope.
- **Deployments tab → most recent Production row → ⋯ → Retry
  deployment** to rebuild the same commit with current bindings.

The redeploy is what activates Steps 1-4's configuration. Until
this happens, the running production deployment carries whatever
binding set existed at its original deploy time.

#### Step 6 — Smoke test the publisher API

```
curl -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
     -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
     https://your-domain/api/v1/publish/me
```

Expected: 200 with the JIT-provisioned publisher row keyed off
`<client-id>.access@service.local`. If the response 401s with
`Invalid or expired Access assertion`, the JWT verification path
isn't satisfied — usually `ACCESS_AUD` mismatch or the deployment
didn't pick up the env vars (re-run Step 5).

#### Step 7 — Run the snapshot import

```
npm run terraviz -- import-snapshot \
  --server https://your-domain \
  --client-id $CF_ACCESS_CLIENT_ID \
  --client-secret $CF_ACCESS_CLIENT_SECRET \
  --dry-run
```

Inspect the plan, then drop `--dry-run` to land 192 rows
(approximate; varies with snapshot revisions). The import is
idempotent via the `legacy_id` column — re-running is a no-op on
rows already imported.

#### Step 8 — Verify the public surface

```
curl https://your-domain/api/v1/catalog | jq '.datasets | length'
```
Expected: ~167 (192 imported minus ~25 with `is_hidden=1`).

```
curl 'https://your-domain/api/v1/search?q=hurricane' | jq '.datasets[0]'
```
Expected: a real dataset hit with a ULID `id` and a relevance
`score`.

#### Account context — Workers AI billing pitfall

Workers AI usage is billed against the account that **owns the
Pages project**, not the account whose dashboard a user is
currently viewing. In a multi-account org this leads to a
confusing sequence:

1. Run `terraviz import-snapshot` against production.
2. Get a `502 4006: you have used up your daily free allocation
   of 10,000 neurons` error.
3. Check the Workers AI dashboard, see "Neurons used today: 0/10k"
   and assume Cloudflare is broken.

The dashboard shown is for the currently-selected account
(top-left dropdown). The Pages project's neuron usage is on the
owning account's counter, which may be a different account. Switch
the dropdown to the account that contains the `terraviz` Pages
project; that's the counter the enforcer is honouring.

#### Free-tier quota awareness

Workers AI free tier is 10,000 neurons per UTC day. Tool-calling
turns in the docent are 2 LLM rounds (one to call the tool, one to
consume the result), so an aggressive testing day can exhaust the
quota faster than expected. **Workers Paid ($5/month base, plus
~$0.011 per 1k neurons)** is the realistic plan for any deploy
that's exercising the chat surface beyond a smoke test.

The Pages-owning account's subscription is what counts; upgrading
a personal account doesn't help if the Pages project lives under
an org. Settings → Billing → Subscriptions on the right account.

### Migrating legacy Vimeo data refs to R2/HLS

Phase 1d's bulk import of the legacy SOS catalog landed ~136
video rows with `data_ref: vimeo:<id>` — playback proxied through
`video-proxy.zyra-project.org`. Phase 3
(`terraviz migrate-r2-hls`) walks those rows, FFmpeg-encodes each
source into a multi-rendition HLS bundle (4K + 1080p + 720p at
2:1 spherical aspect, 6-second segments), uploads the bundle to
R2 under `videos/<dataset_id>/`, and PATCHes `data_ref` to
`r2:videos/<dataset_id>/master.m3u8`. After the migration,
playback runs through R2's edge serving via your custom domain;
egress is free.

**One-time, operator-driven.** This is not a CI job. Run it from
your laptop (or a container with the catalog repo checked out)
against the production deploy with a service-token configured.
Encoding takes minutes per row, so plan an overnight session for
a full ~136-row run.

(Phase 2 originally targeted Cloudflare Stream for this
migration. The standard Stream plan caps rendition output at
1080p, which is a UX regression for spherical content where
viewers zoom into features smaller than the equator. Phase 3
ships the R2 + HLS alternative that preserves 4K renditions.
See the Phase 2 → 3 transition note in `CHANGELOG.md`.)

#### Pages-side prerequisites (do this BEFORE the first run)

Three things need to be in place before the migration's PATCH
step lands a working `r2:` data_ref:

1. **A custom domain bound to the R2 bucket.** Cloudflare
   dashboard → R2 → `terraviz-assets` → Settings → Connect Domain.
   The reference deploy uses `video.zyra-project.org`. DNS
   propagation can take a few minutes.

2. **`R2_PUBLIC_BASE` env var on the Pages project**, set to the
   custom domain's URL (e.g. `https://video.zyra-project.org`).
   Set it on **both Production and Preview**. Redeploy after
   saving so the manifest endpoint picks it up.

3. **CORS policy on the R2 bucket**, allowing GET from every
   origin the SPA actually runs from. Cloudflare dashboard → R2
   → `terraviz-assets` → Settings → CORS Policy:
   ```json
   [{
     "AllowedOrigins": [
       "https://terraviz.zyra-project.org",
       "https://*.terraviz.pages.dev",
       "tauri://localhost",
       "http://tauri.localhost",
       "https://tauri.localhost"
     ],
     "AllowedMethods": ["GET"],
     "AllowedHeaders": ["*"],
     "MaxAgeSeconds": 3600
   }]
   ```
   The three `tauri.localhost` entries cover the Tauri desktop
   webview: macOS uses the custom scheme `tauri://localhost` and
   Windows/Linux use `http(s)://tauri.localhost`. Mirrors the
   allowlist already accepted by `functions/api/ingest.ts`.
   Without these, HLS.js's internal XHR manifest fetch from the
   desktop build fails with `manifestLoadError` and the playlist
   request shows `Origin tauri://localhost is not allowed by
   Access-Control-Allow-Origin` in the console — see the
   "Tauri webview is not a CORS-free zone" troubleshooting note
   below. Without CORS entirely (the original baseline before
   any allowed origins), the SPA's HLS player can't load the
   playlist cross-origin and playback fails with a console error
   rather than a clear network error.

Then verify the binding state:

```sh
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
  npm run check:pages-bindings
```

`R2_PUBLIC_BASE` should show as present in both environments
before the migration is safe to run.

#### Operator-side prerequisites

- **FFmpeg ≥ 6** on `PATH` (or pass `--ffmpeg-bin=<path>`).
  Apt: `apt-get update && apt-get install -y ffmpeg`. Static
  binaries from John Van Sickle work on any glibc Linux without
  apt dependencies.
- **R2 S3-API credentials in your shell:** `R2_S3_ENDPOINT`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (same trio Phase 2's
  audit added to `expected-bindings.ts`). Mint at Cloudflare
  dashboard → R2 → Manage R2 API Tokens → Read+Write scoped to
  the bucket.
- **TERRAVIZ_ACCESS_CLIENT_ID / SECRET** for the publisher API
  PATCH step (same service token used for `import-snapshot` /
  `verify-deploy`).
- **At least 256 MB free disk per concurrent row** for the
  encode workdir (default `/tmp/terraviz-hls/<dataset_id>/`).
  Migration is sequential, so peak usage is bounded to one row at
  a time.

#### Pre-flight (always run dry-run first)

The migration is idempotent — re-runs skip rows already on
`r2:videos/`. The first thing to verify is the storage estimate:

```sh
set -a; . ~/.terraviz/prod.env; set +a
npm run terraviz -- migrate-r2-hls --dry-run
```

The dry-run output prints:

- The migration plan (number of `vimeo:` rows + the first 5 by id).
- The number of rows skipped by the **real-time guard** (default-on)
  — see below.
- A storage estimate computed by summing source durations from the
  video-proxy metadata and multiplying by an ~244 MB/min ladder
  constant calibrated to the 4K + 1080p + 720p renditions.
  Order-of-magnitude only — actual bundle sizes vary with
  content complexity (motion, scene cuts).
- A monthly storage cost in $ at R2's $0.015/GB-month rate. The
  ~136-row catalog typically estimates around 30-50 GB total →
  ~$0.50/month flat; R2 egress is free so delivery costs nothing.

#### Real-time row guard

A handful of SOS rows are titled e.g. `Sea Surface Temperature -
Real-time` — NOAA's automation re-uploads these to the same
Vimeo IDs daily. Phase 3 is a one-shot encode, so the R2 copy
goes stale within 24h for these rows. The migrator filters them
out at plan time by default, matching the literal substring
`real-time` (case-insensitive, hyphen / space / joined variants
all caught) against the row title — the SOS catalog has no
explicit `update_cadence` field so the title is the only
reliable signal.

The plan summary surfaces the skipped count + first 5 IDs so
you can sanity-check the heuristic before the live run:

```
Migration plan:
  vimeo: rows on video/mp4:   136
  skipped (real-time guard):  42 (Vimeo source is updated daily; one-shot R2 copy would go stale)
  will migrate this run:      94
  Skipped real-time rows (--no-skip-realtime to override):
    • DSXXXX...  vimeo:111  Sea Surface Temperature - Real-time
    • ...
```

To migrate a real-time row anyway (e.g. you accept the staleness
or are shipping a known-stale snapshot), pass
`--no-skip-realtime` for the bulk path or `--id <row>` for
single-row mode (the `--id` override prints a stderr warning
when the targeted row matches the heuristic, so a slip-of-the-finger
is still visible). A proper recurring-refresh mechanism is
deferred to a Phase 3c follow-up.

##### Triaging real-time rows that are already on r2:

For rows that were migrated *before* the `--skip-realtime` guard
landed (i.e. they're already serving a 24h-stale snapshot from
R2), use `terraviz list-realtime-r2` to identify them and
recover the original Vimeo id needed for rollback:

```sh
# NDJSON output — one row per match, ready to pipe.
npm run terraviz -- list-realtime-r2

# Human-readable inspection:
npm run terraviz -- list-realtime-r2 --human
```

The lookup walks the catalog (`status=published`), filters to
`r2:videos/` + `video/mp4` + the same title heuristic, and joins
each match against `public/assets/sos-dataset-list.json` via
`legacy_id` → `entry.id` to extract the Vimeo id from
`dataLink`. Rows whose `legacy_id` isn't in the snapshot — or
whose `dataLink` isn't a `vimeo.com` URL — surface to stderr
without polluting the NDJSON stream; recover those IDs from
Grafana's `migration_r2_hls` events (the `vimeo_id` is on
`blob9`) or the Vimeo dashboard, then call `rollback-r2-hls`
manually.

To bulk-roll-back the matched rows:

```sh
npm run terraviz -- list-realtime-r2 \
  | npm run terraviz -- rollback-r2-hls --from-stdin
```

See the `rollback-r2-hls` runbook below for the per-row
rollback semantics (PATCH-then-DELETE, commit-point ordering).

#### Live migration

Once the dry-run looks right:

```sh
# Sanity batch — migrate 1 row, verify playback in the SPA, then continue.
npm run terraviz -- migrate-r2-hls --limit=1

# Small batch — 5 more rows; watch the Grafana migration row populate.
npm run terraviz -- migrate-r2-hls --limit=5

# Full run — sequential, paced 1 s between rows. ~5-15 minutes
# of encode time per row × 130 remaining ≈ many hours.
npm run terraviz -- migrate-r2-hls
```

Per-row stdout shows `[<dataset_id>] vimeo:<vimeo_id> →
r2:<key> (<bytes>, encode <ms>, upload <ms>, total <ms>)`.
Failures go to stderr with the outcome (`vimeo_fetch_failed`,
`encode_failed`, `r2_upload_failed`, `data_ref_patch_failed`).

The telemetry session id printed at the start of each run lets
you correlate per-row events on the Grafana migration row.

#### What the commit point is

The `data_ref` PATCH (step 4 of each row) is the migration's
commit point. Before it: the row stays on `vimeo:` and playback
runs through the proxy unchanged. After it: the SPA's manifest
endpoint resolves `r2:videos/<id>/master.m3u8` to your custom
domain's URL and HLS playback engages.

Failure modes:

- `vimeo_fetch_failed` — source URL not resolvable (deleted from
  Vimeo, proxy down). Row unchanged. No encode / upload attempted.
- `encode_failed` — FFmpeg crashed. Workdir retained at
  `/tmp/terraviz-hls/<dataset_id>/` for operator inspection.
  Row unchanged.
- `r2_upload_failed` — at least one R2 PUT failed mid-bundle.
  Some segments may already be on R2 as an orphan partial
  upload; the next migration retry overwrites them.
- `data_ref_patch_failed` — bundle fully uploaded but the
  publisher API rejected the PATCH. The orphan R2 prefix is
  captured in the `migration_r2_hls.r2_key` telemetry field
  for `terraviz rollback-r2-hls` cleanup.

#### Recovery from partial failures

Re-running `terraviz migrate-r2-hls` is the recovery path.
The plan-time filter skips rows already on `r2:` so already-
migrated rows are no-ops. Failed rows attempt fresh.

For `r2_upload_failed` rows specifically: the next attempt
overwrites any partial uploads under the same prefix, so the
state converges naturally.

#### Memory + disk ceilings

The encode workdir holds 4K + 1080p + 720p segment files for one
row at a time. Typical legacy SOS row: 200-400 MB of segments per
encode. The `--workdir=<path>` flag overrides the default
`/tmp/terraviz-hls`; `--keep-workdir` skips cleanup on success
(failed rows always retain their workdir for inspection).

#### Rollback

Single-row rollback is automated via `terraviz rollback-r2-hls`:

```sh
npm run terraviz -- rollback-r2-hls <dataset_id> --to-vimeo=<original_id> --dry-run
npm run terraviz -- rollback-r2-hls <dataset_id> --to-vimeo=<original_id>
```

The tool PATCHes `data_ref` back to `vimeo:<id>` first (commit
point — once it lands, the SPA resolves through the proxy
again), then deletes the R2 bundle (cleanup; non-fatal).
If the DELETE fails, the row is still correctly back on
`vimeo:` and only an orphan R2 prefix is left for manual
cleanup.

The operator provides the original `vimeo:<id>` explicitly. To
find it: grep the migration's stdout log, look up the
dataset's `legacy_id` in `public/assets/sos-dataset-list.json`,
or query Grafana's `migration_r2_hls` events (the `vimeo_id`
is on `blob9`).

For bulk rollback (e.g. cleaning up the real-time rows
identified by `terraviz list-realtime-r2`), pipe NDJSON in via
`--from-stdin`:

```sh
# Bulk rollback every real-time row currently on r2:
npm run terraviz -- list-realtime-r2 \
  | npm run terraviz -- rollback-r2-hls --from-stdin

# Confirm first with a dry-run:
npm run terraviz -- list-realtime-r2 \
  | npm run terraviz -- rollback-r2-hls --from-stdin --dry-run

# Roll back an arbitrary set that the operator curated by hand:
cat my-rollback-list.ndjson \
  | npm run terraviz -- rollback-r2-hls --from-stdin
```

Each NDJSON line must be a JSON object with `dataset_id` and
`vimeo_id` fields (extra fields like `title` and `legacy_id`
are tolerated, so the `list-realtime-r2` output pipes
through directly). The bulk path runs the same per-row
pipeline as the single-row mode (GET → PATCH → DELETE),
continues past per-row failures rather than aborting on
the first one, and prints an aggregate summary at the end:

```
Bulk rollback complete:
  ok:                       18
  ok (orphan R2 prefix):    1     ← PATCH committed, R2 DELETE failed or was skipped (creds unset)
  patch_failed:             1
```

Exit code: 0 when every row's PATCH succeeded (orphan R2
prefixes are non-fatal — the catalog is correct, just storage
to clean up later), 1 if any row had a hard failure
(`parse_failed`, `get_failed`, `wrong_scheme`, `patch_failed`,
or `malformed_ref`).

#### Observation window

The Vimeo proxy stays running until the migration is 100%
complete AND has been observed for ≥1 month. The Grafana
migration row (commit 3/G — three panels under "Product Health")
is the headline observation surface — "% video/mp4 rows still
on `vimeo:`" should be 0 by the end of the run and remain 0 in
steady state. A non-zero reading after the fact means a stray
legacy row was re-imported (re-run the migration) or the
manifest endpoint regressed somehow.

### Migrating auxiliary asset URLs to R2

Phase 3b extends the asset-hosting story to the per-row
auxiliary asset columns: `thumbnail_ref`, `legend_ref`,
`caption_ref`, and the new `color_table_ref`. Each row's
`<asset>_ref` flips from a NOAA CloudFront URL (e.g.
`https://d3sik7mbbzunjo.cloudfront.net/atmosphere/.../thumb.jpg`)
to an R2 reference (`r2:datasets/<id>/<asset>.<ext>`). After
3b ships, the catalog is fully self-hosted and federation peers
can mirror without reaching back to noaa.gov.

The runbook mirrors the Phase 3 video migration's shape, but
the per-row pipeline is one PATCH covering up to four asset
columns and one telemetry event per (row, asset_type) pair.

#### Prerequisites

Same R2 credentials as Phase 3 (`R2_S3_ENDPOINT` /
`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` in the operator's
shell), same `R2_PUBLIC_BASE` on Pages — used by the publisher
API's dataset serializer (`functions/api/v1/_lib/dataset-serializer.ts`,
through the `resolveAssetRef` callback) to flip the `r2:<key>`
values that 3b writes into the `*_ref` columns back to the
public HTTPS form the SPA renders. (Note: the manifest
endpoint at `/api/v1/datasets/<id>/manifest` only resolves
`data_ref` for video / image playback — the auxiliary asset
columns are surfaced via the row's serializer, not the
manifest, so it's the regular dataset GET path that needs
`R2_PUBLIC_BASE` to do the right thing for thumbnails,
legends, captions, and color tables.) The migration uses the
same custom-domain origin Phase 3 set up — no new env vars,
no new Cloudflare configuration.

One prerequisite specific to 3b: **back-fill the three new
catalog columns** (`color_table_ref`, `probing_info`,
`bounding_variables`) onto rows that were imported under
Phase 1d. Without the back-fill, `color_table_ref` will be
NULL on every row even though the SOS snapshot has the data.

```sh
# Confirm the plan — should report `rows to backfill: N`.
set -a; . ~/.terraviz/prod.env; set +a
npm run terraviz -- import-snapshot --update-existing --dry-run

# Run for real (writes the three new columns; never touches
# title / abstract / publisher-edited fields).
npm run terraviz -- import-snapshot --update-existing
```

The flag is idempotent — re-running on already-backfilled
rows reports them under `backfill_noop` and issues no PATCH.

#### Pre-flight dry-run

```sh
npm run terraviz -- migrate-r2-assets --dry-run
```

Sample output:

```
Asset migration plan:
  rows scanned:                  204
  rows with at least one asset:  152
  will migrate this run:         152
  total asset uploads:           372
  types: thumbnail, legend, caption, color_table
    thumbnail      135
    legend         119
    caption        35
    color-table    15

  • DSXXXX...  thumbnail+legend+caption  Sea Surface Salinity
  • …
```

Per-type counts confirm the four-class breakdown; the per-row
sample lists which assets are eligible on each row (skipping
columns already on `r2:` or null). The migration is idempotent:
re-running picks up only rows whose `<asset>_ref` is still on a
NOAA URL.

#### Live migration

```sh
# Sanity batch — migrate 5 rows, verify in Grafana / SPA.
npm run terraviz -- migrate-r2-assets --limit=5

# Full run — sequential, paced 200 ms between rows. Each row
# processes up to 4 asset uploads + 1 PATCH. Captions
# auto-convert SRT → VTT inline so every caption in R2 ends
# up as `.vtt` regardless of upstream format.
npm run terraviz -- migrate-r2-assets

# Per-type rollout — do thumbnails first to verify the
# end-to-end pipeline on the most-trafficked asset class
# before broadening:
npm run terraviz -- migrate-r2-assets --types=thumbnail
npm run terraviz -- migrate-r2-assets --types=legend,color_table
npm run terraviz -- migrate-r2-assets --types=caption
```

Per-asset stdout shows `[<dataset_id>] <type> ok (<bytes>, <ms>)
→ <r2_key>`. Failures go to stderr with the outcome
(`fetch_failed` / `upload_failed` / `patch_failed`).

The telemetry session id printed at the start of each run lets
you correlate per-asset events on the Grafana asset-migration
row (Phase 3b commit J — three panels alongside the video
migration row at y=42).

#### What the commit point is

The per-row PATCH (step 7 of `migrateOne`) is the migration's
commit point. Failures before the PATCH leave the row's
`<asset>_ref` columns unchanged (the SPA keeps fetching from
NOAA). A PATCH that fails AFTER R2 PUTs succeeded promotes
every successful asset's telemetry from `ok` to `patch_failed`
so the orphan R2 objects show up in the Grafana failure
breakdown — operator cleans up via `rollback-r2-assets`.

Re-running `migrate-r2-assets` after any failure is the
recovery path. Already-migrated assets skip (idempotency);
failed assets retry. The R2 PUT is overwrite-on-key, so a
partial upload from a previous run is safely clobbered.

#### Rollback

Per-row rollback (single asset):

```sh
npm run terraviz -- rollback-r2-assets <dataset_id> \
  --types=thumbnail --dry-run
npm run terraviz -- rollback-r2-assets <dataset_id> --types=thumbnail
```

The tool recovers the original NOAA URL by indexing the row's
`legacy_id` against the SOS snapshot's matching link field
(`thumbnailLink` / `legendLink` / `closedCaptionLink` /
`colorTableLink`). If the row has no `legacy_id` (publisher-
portal row, not SOS-imported), pass `--to-url=<url>` to name
the target explicitly:

```sh
npm run terraviz -- rollback-r2-assets <dataset_id> \
  --types=thumbnail --to-url=https://example.org/thumb.png
```

For bulk rollback (e.g. backing out a botched asset_type after
a Grafana review), pipe NDJSON in via `--from-stdin`. Each
line is `{ "dataset_id": "...", "asset_type": "..." }` — the
same shape `migration_r2_assets` events carry, so a
telemetry-filtered subset pipes through directly:

```sh
# Roll back every patch_failed thumbnail in this hour. The
# Grafana datasource → "view data" → "Export CSV" path lets
# you derive the NDJSON for the failed subset.
cat patch-failed.ndjson \
  | npm run terraviz -- rollback-r2-assets --from-stdin --dry-run
cat patch-failed.ndjson \
  | npm run terraviz -- rollback-r2-assets --from-stdin
```

Per-asset pipeline: PATCH `<asset>_ref` back to the recovered
URL (commit point), then DELETE the R2 object (cleanup;
non-fatal — orphan storage left on DELETE failure is
operator-visible as "ok (orphan R2 object)" in the bulk summary).

#### Observation window

Same shape as the video migration: the Phase 3b Grafana row
(commit 3b/J) shows "cumulative ok by asset_type" — after a
complete run the four rows should land near (thumbnail: ~135,
legend: ~119, caption: ~35, color_table: ~15). The exact
numbers depend on how many rows have each asset populated in
the snapshot; the dry-run plan summary is authoritative for
the targets.

A clean migration is signalled by the failure-breakdown table
going empty. NOAA CloudFront URLs serve indefinitely so
there's no hard deadline to flip the `*_ref` columns — but
the federation work (peer mirroring) and `/publish` endpoint's
single-origin guarantee depend on this being done.

### Migrating tour.json files to R2

Phase 3c migrates the per-row `run_tour_on_load` column and the
sibling overlay / audio / 360-pano assets each tour.json
references. Each row's `run_tour_on_load` flips from a NOAA
CloudFront URL to an R2 reference (`r2:tours/<id>/tour.json`);
the siblings the parser surfaces as `relative` get fetched from
NOAA and uploaded to `tours/<id>/<sibling-path>` under the same
prefix. External URLs in the tour file (YouTube embeds, Vimeo,
popup web links) are left verbatim — the operator can't legally
re-host them and they're not migratable assets anyway.

The runbook mirrors the Phase 3b shape with one key shift: the
3c pipeline is **per-row atomic**, not per-asset. A row's
tour.json is only PATCHed onto R2 after every sibling has
uploaded successfully — so a partial 3c run never leaves a tour
playing 404s at runtime.

#### Prerequisites

Same R2 credentials as Phase 3 / 3b (`R2_S3_ENDPOINT` /
`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` in the operator's
shell), same `R2_PUBLIC_BASE` on Pages — used by the dataset
serializer (`functions/api/v1/_lib/dataset-serializer.ts`,
through `resolveAssetRefStrict`) to flip `r2:tours/<id>/tour.json`
into the public HTTPS form the SPA's tour engine actually
fetches. No new env vars, no new Cloudflare configuration.

One optional prerequisite: run the parser sweep against
production tour.json files first to catch any task-type
blind spots that a future SOS authoring change might have
introduced since 3c shipped. The sweep is read-only and only
takes ~30 s:

```sh
npx tsx scripts/sweep-tour-parser.ts
```

Expected output: "No unknown task types across the sweep —
parser covers every task name seen." If a new unknown task
shows up, file an issue before running the migration — the
sweep is the canary for SOS author-side changes that would
silently drop URLs.

#### Pre-flight dry-run

```sh
npm run terraviz -- migrate-r2-tours --dry-run
```

Sample output:

```
Tour migration plan:
  rows scanned:                          195
  rows with run_tour_on_load:            193
  already on r2: (will skip):            0
  eligible (NOAA / external URLs):       193
  will migrate this run:                 193
  • 01KQG610X12B1DMN7YEYDRM9WS  Drought Risk - 2015-2020
      https://d3sik7mbbzunjo.cloudfront.net/land/drought_2015-2020/tour.json
  • …
```

The migration is idempotent: re-running picks up only rows whose
`run_tour_on_load` is still on a NOAA URL. Rows already on
`r2:` skip from the eligible set.

#### Live migration

```sh
# Sanity batch — migrate 5 rows, verify in Grafana / SPA.
npm run terraviz -- migrate-r2-tours --limit=5

# Full run — sequential, paced 200 ms between rows.
npm run terraviz -- migrate-r2-tours

# Single-row mode for surgical migration / re-try:
npm run terraviz -- migrate-r2-tours --id=<dataset_id>
```

Per-row stdout shows `[<dataset_id>] ok (tour.json + N siblings,
<bytes>, <ms>) → tours/<id>/tour.json`. Failures go to stderr
with the outcome:

  - **`dead_source`** — NOAA returned 404 on the tour.json URL
    itself. The row was already broken pre-migration; migration
    leaves it untouched and exits 0 for this row. Operator
    decides whether to delete the catalog row or replace the
    tour.
  - **`fetch_failed`** — transient network failure on the
    tour.json fetch. Re-run; idempotent.
  - **`parse_failed`** — tour.json bytes didn't decode as JSON.
    Investigate the source manually; rare.
  - **`sibling_fetch_failed`** — at least one relative sibling
    failed to fetch. The row's tour.json is NOT uploaded
    (atomic per row), so the row stays on NOAA. Re-run after
    investigating the failing sibling URL in the error message.
  - **`upload_failed`** — an R2 PUT failed. Partial uploads
    are R2 orphans; the row still works via NOAA because the
    PATCH never ran. Re-run is the cheapest recovery (R2 PUTs
    are overwrite-on-key, so the same bytes clobber cleanly).
  - **`patch_failed`** — every R2 PUT succeeded but the D1
    PATCH on `run_tour_on_load` failed. Worst case: every R2
    object from this row is an orphan AND the row still points
    at NOAA. Recovery: re-run the migration (idempotent — the
    same bytes hash to the same keys, so the next PATCH attempt
    just retries against an already-correct R2 state).
    Alternatively `rollback-r2-tours <id>` cleans up the orphan
    and leaves the row on NOAA.

The telemetry session id printed at the start of each run lets
you correlate per-row events on the Grafana tour-migration row
(3c/F — three panels alongside the 3b asset-migration row at
y=50).

#### What the commit point is

The per-row PATCH (step 6 of `migrateOne`) is the migration's
commit point. Failures before the PATCH leave the row's
`run_tour_on_load` unchanged (the SPA keeps fetching the tour
from NOAA). The atomic per-row design is deliberate: a tour is
a single addressable resource, so a "tour.json on R2 but
siblings still on NOAA" intermediate state would 404 in the
browser. By only PATCHing after every upload succeeds, the
operator's worst case is "row still on NOAA + a few R2 orphans"
— never "row on R2 + missing siblings."

Re-running `migrate-r2-tours` after any failure is the
recovery path. Already-migrated rows skip (idempotency on the
`r2:` prefix). The R2 PUT is overwrite-on-key, so a partial
upload from a previous run is safely clobbered.

#### Rollback

Per-row rollback (single dataset):

```sh
npm run terraviz -- rollback-r2-tours <dataset_id> --dry-run
npm run terraviz -- rollback-r2-tours <dataset_id>
```

The tool recovers the original NOAA URL by indexing the row's
`legacy_id` against the SOS snapshot's `runTourOnLoad` field.
If the row has no `legacy_id` (publisher-portal row, not
SOS-imported), pass `--to-url=<url>` to name the target
explicitly:

```sh
npm run terraviz -- rollback-r2-tours <dataset_id> \
  --to-url=https://example.org/my-tour.json
```

For bulk rollback (e.g. backing out a botched window after a
Grafana review), pipe NDJSON in via `--from-stdin`. Each line
is `{ "dataset_id": "..." }` — simpler than 3b's per-asset
shape because tours are atomic per row:

```sh
# Roll back every patch_failed row in this hour. The Grafana
# datasource → "view data" → "Export CSV" path lets you derive
# the NDJSON for the failed subset.
cat patch-failed.ndjson \
  | npm run terraviz -- rollback-r2-tours --from-stdin --dry-run
cat patch-failed.ndjson \
  | npm run terraviz -- rollback-r2-tours --from-stdin
```

Per-row pipeline: PATCH `run_tour_on_load` back to the
recovered URL (commit point), then DELETE the entire
`tours/<id>/` R2 prefix in one list+parallel-DELETE pass.
The DELETE step is non-fatal — a `delete_failed` outcome means
the catalog is correct (row back on NOAA) but the R2 prefix is
orphaned; clean up via the Cloudflare dashboard if needed.
Bulk-summary output surfaces this as "ok (orphan R2 prefix)".

#### Observation window

The Phase 3c Grafana row (commit 3c/F) shows "cumulative ok
rows" — after a complete run this should approach the
planner's dry-run eligible count (~198 at cut-over; 1 row
stays `dead_source` so ok caps just below the total).
A clean migration is signalled by the non-ok outcome
breakdown table going empty.

NOAA CloudFront URLs serve indefinitely so there's no hard
deadline to flip `run_tour_on_load` — but the federation work
(peer mirroring) depends on this being done, just like 3b's
auxiliary asset migration.

## Stack

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
  the production endpoint with a free quota; tests stub it. Used
  for docent search embeddings from Phase 1b onward
  (`@cf/baai/bge-base-en-v1.5`).
- **Vectorize** (Phase 1b onward) has no local emulation. Dev
  uses an `InMemoryVectorIndex` shim that does cosine similarity
  in TypeScript over the seeded dataset embeddings; quality is
  identical to the production index for the small seeded corpus,
  it's just slow at scale. Tests run against the shim. Set
  `MOCK_VECTORIZE=true` in `.dev.vars` to opt out and target the
  remote Vectorize index instead (rare; the shim covers the
  contributor case).

## Repo layout for the new code

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
    0002_decoration.sql
    0003_renditions.sql
    0004_tours.sql
    0005_publishers_audit.sql
    ...

schema/
  catalog-schema.sql             # post-migration snapshot, regenerated by
                                 #   `npm run db:dump-schema`. Outside
                                 #   migrations/ entirely — it used to sit in
                                 #   migrations/, which is FEEDBACK_DB's
                                 #   migrations_dir, and wrangler queued it.

scripts/
  seed-catalog.ts                # imports SOS catalog → local D1
  refresh-sos-snapshot.ts        # re-pulls public/assets/sos-dataset-list.json
  dump-catalog-schema.ts         # regenerates schema/catalog-schema.sql
  lib/d1-local.ts                # locates the local D1 sqlite file
  generate-fixtures.ts           # canned dataset rows for tests
  sync-peers.ts                  # manual federation pull (dev only)
  rotate-peer-secret.ts          # ops helper

src/services/
  ...                            # frontend-only, unchanged
```

## Contributor entry points

```bash
npm run dev:functions          # wrangler pages dev with all local bindings
npm run dev                  # vite dev server (existing) — proxies /api/* to :8788
npm run db:migrate           # wrangler d1 migrations apply CATALOG_DB --local
npm run db:seed              # tsx scripts/seed-catalog.ts (writes to local D1)
npm run db:reset             # rm .wrangler/state/v3/d1 && db:migrate && db:seed
npm run db:dump-schema       # regenerate schema/catalog-schema.sql snapshot
npm run refresh:sos-snapshot # re-pull public/assets/sos-dataset-list.json from upstream S3
npm run test                 # vitest run (existing, plus new backend tests)
npm run test:federation      # contract tests — spins up two Wranglers, peers them
```

The frontend dev workflow stays as it is today (`npm run dev` →
Vite dev server). Vite proxies `/api/*` to the local Wrangler at
`:8788` via a `vite.config.ts` proxy entry; production resolves
the same paths to Pages Functions on the same origin. The desktop
app uses `localhost:8788` during dev and the deployed origin in
production.

## Seed data

`scripts/seed-catalog.ts` is the same importer described in the
data model section, restricted to a configurable subset (default:
20 representative datasets across video, image, and tour types).
Subset keeps `db:seed` fast and avoids hammering the public S3 in
CI. A `--full` flag pulls the entire ~600-item catalog when a
contributor needs realistic load.

`scripts/generate-fixtures.ts` produces deterministic test data:
fixed ULIDs, fixed timestamps, fixed signatures. Used by federation
contract tests and unit tests.

## Local debugging

The dev stack runs in Miniflare; debugging mostly means knowing
where to look and which Wrangler subcommand surfaces what.

### Logs

- **Miniflare console output.** The `npm run dev:functions` terminal
  prints request lines, `console.log` output, and binding-level
  errors. This is the first place to look for any non-trivial
  issue.
- **`wrangler pages deployment tail --local`.** Tail-style streaming
  of the same logs in a more grep-able shape. Useful when the dev
  terminal is busy and you want a clean filterable stream in
  another window.
- **Frontend → backend correlation.** Every Pages Function
  response carries an `X-Request-Id` header (ULID); the frontend
  exposes the most recent one as `window.__lastRequestId` in the
  browser console. Pasting that into the Miniflare log finds the
  matching server-side line.

### Inspecting local state

| Resource | Inspect with | Notes |
|---|---|---|
| **D1** | `npx wrangler d1 execute CATALOG_DB --local --command "SELECT ..."` | Operates on the same `.wrangler/state/v3/d1/` file `db:migrate` and `db:seed` use. |
| **KV** | `npx wrangler kv key list --binding=CATALOG_KV --local` (and `... key get`) | KV is in-memory in Miniflare — restart the stack and KV is empty. |
| **R2** | `npx wrangler r2 object list terraviz-assets --local` (and `... object get`) | R2 lives on disk under `.wrangler/state/v3/r2/` and persists across restarts. |
| **Queues** | None directly | The `InMemoryJobQueue` interface dumps queued jobs to stderr at shutdown; for ad-hoc inspection, set `JOB_QUEUE_LOG=true` in `.dev.vars` to get a per-enqueue log line. |

A common pattern: a request fails with a 500. Find the request id
in the response, grep the Miniflare log for the matching line,
note the failed query, run that query directly against the local
D1 to reproduce. Faster than a debugger most of the time.

### Attaching a debugger

Miniflare runs Workers in a node-compatible context; Wrangler
supports `--inspect` to expose a Chrome DevTools / Node inspector
port:

```bash
npm run dev:functions -- --inspect=9229
```

Open `chrome://inspect` (or use the VS Code "Attach to Node"
launch target) and connect. Breakpoints in the TypeScript sources
work once Wrangler's source-map mode is on (default). The
`functions/api/v1/_lib/` directory is the most useful place to
break — every route delegates the actual logic there, so a single
breakpoint on the appropriate handler catches the request no
matter which route surfaced it.

### Common gotchas

- **Port 8788 already in use.** Wrangler refuses to start;
  another Wrangler instance from a different repo is the usual
  culprit. Either kill the other one or pass `--port=8789` to
  `npm run dev:functions`. The Vite proxy hardcodes 8788; if you
  change the port, also set `VITE_BACKEND_PORT=8789` for the Vite
  process.
- **Schema drift after `git pull`.** A migration arrived with the
  pull but `.wrangler/state` still holds the old schema. Symptom
  is queries failing on missing columns. Fix is `npm run db:reset`.
- **CORS in local mode.** The Pages Function returns
  `Access-Control-Allow-Origin: http://localhost:5173` for the
  Vite dev server. Serve the frontend on a different port and
  you must set `FRONTEND_ORIGIN` in `.dev.vars`. For the Tauri
  desktop build, `apiFetch` (`src/services/catalogSource.ts`)
  routes `/api/*` calls through the Tauri HTTP plugin so the
  Rust side issues the request and webview CORS doesn't apply —
  desktop dev never sees CORS errors *on Pages Function calls*.
- **Tauri webview is not a CORS-free zone.** The bypass above
  only covers paths that explicitly use the Tauri HTTP plugin
  (`apiFetch`, `llmProvider`, `downloadService`). Everything
  else — `fetch()` calls in services, `<img>`/`<video>` element
  loads, HLS.js's internal XHR loader for `.m3u8` and `.ts`
  segments — runs inside the webview and *is* subject to
  standard CORS. If a Tauri build fails with `Origin
  tauri://localhost is not allowed by Access-Control-Allow-Origin`,
  the fix is on the origin server: add `tauri://localhost`,
  `http://tauri.localhost`, and `https://tauri.localhost` to its
  CORS allowlist (the R2 bucket section above is the canonical
  example).
- **`MOCK_STREAM` flips silently.** Setting `MOCK_STREAM=true`
  requires a Wrangler restart to pick up; the binding is read
  once at startup. Symptom is a manifest endpoint returning real
  Stream URLs locally despite the mock flag being set in `.dev.vars`.
- **D1 file locking.** Running two `wrangler` commands against the
  same local D1 simultaneously can produce `SQLITE_BUSY`. Wait
  for the dev server to finish a request before running ad-hoc
  queries, or use a separate scratch DB for exploration.
- **Stale `.wrangler/state` between branches.** Switching branches
  with different schemas without resetting state leaves you in
  an undefined hybrid. `npm run db:reset` is cheap; do it on
  branch switches.

### Local federation testing

`npm run sync-peers` runs the same logic the production cron does,
but synchronously and on demand — useful when you have one local
node and want to pull from a peer at will. The two-instance
"contract test" pattern (two Wranglers on different ports,
peered, syncing, asserting state) lives in Testing strategy
below as a worked example.

## Testing strategy

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

### Federation contract test — worked example

The bullet above promises a contract test that "spins up two
Wranglers, peers them, asserts state matches a golden snapshot."
What that actually looks like in practice:

```ts
// federation/contract.test.ts
import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import { spawnNode, peerNodes, signFixture } from './harness'

describe('federation contract — protocol v1, schema v1', () => {
  let publisher, subscriber

  beforeAll(async () => {
    publisher  = await spawnNode({ port: 8801 })
    subscriber = await spawnNode({ port: 8802 })

    // Seed publisher with deterministic fixtures.
    await publisher.exec(
      'INSERT INTO datasets (id, slug, ...) VALUES (?, ?, ...)',
      signFixture.dataset_one,
    )

    // Handshake.
    await peerNodes(publisher, subscriber, {
      protocol_version: 1,
      schema_versions:  [1],
    })

    // Trigger a sync.
    await subscriber.invoke('cron:federation-sync')
  })

  afterAll(async () => {
    await publisher.stop()
    await subscriber.stop()
  })

  it('subscriber mirrors the publisher\'s public datasets', async () => {
    const { datasets } = await subscriber.fetch('/api/v1/catalog').json()
    expect(datasets).toMatchSnapshot('catalog-after-sync')
  })

  it('subscriber surfaces tombstones for retracted rows', async () => {
    await publisher.invoke('retractDataset', { id: signFixture.dataset_one.id })
    await subscriber.invoke('cron:federation-sync')

    const { tombstones } = await subscriber
      .fetch('/api/v1/federation/feed?cursor=' + lastCursor)
      .json()
    expect(tombstones).toContainEqual(
      expect.objectContaining({ id: signFixture.dataset_one.id })
    )
  })

  it('rejects a mirror whose content_digest does not match the bytes', async () => {
    // Drives the integrity-failure path described in
    // CATALOG_ASSETS_PIPELINE.md → "Federation: peers verifying
    // mirrored bytes". Asserts a federation_integrity_failure
    // event is emitted and the mirror is not stored.
  })
})
```

The harness (`federation/harness.ts`) is a small wrapper around
Wrangler's `unstable_dev` testing API that hides the boilerplate
of starting a Miniflare instance, applying migrations to its
in-memory D1, and giving you `.fetch()` / `.exec()` / `.invoke()`
helpers. Each `describe` block runs against fresh state;
per-test isolation falls out of the in-memory D1.

#### Adding a new protocol field

A change like "add a `content_digest` field to the federation
feed payload" is the canonical scenario this test catches. The
PR-shaped flow:

1. **Schema bump.** Add a migration that introduces
   `content_digest TEXT` on `datasets`; update
   [`CATALOG_DATA_MODEL.md`](CATALOG_DATA_MODEL.md) in the same
   commit.
2. **Feed serializer change.** Update the federation feed
   handler to emit the field on outbound payloads. Bump
   `schema_version` if the field is required; leave it at the
   current version if absence means "not verified" (the legacy
   path described in
   [`CATALOG_ASSETS_PIPELINE.md`](CATALOG_ASSETS_PIPELINE.md)).
3. **Update the support matrix.** The contract test
   parameterises over `(protocol_version, schema_version)`
   combinations. Add a new entry to the matrix in
   `federation/contract.support-matrix.ts`:
   ```ts
   export const SUPPORTED = [
     { protocol: 1, schema: 1 },
     { protocol: 1, schema: 2 },  // ← new row
   ]
   ```
   The test runs every entry; CI fails if any combination
   breaks.
4. **Positive test.** Show that with both nodes on
   `(protocol: 1, schema: 2)` the digest field round-trips and
   the subscriber stores it.
5. **Negative test.** Show that with the publisher on
   `(protocol: 1, schema: 2)` and the subscriber on
   `(protocol: 1, schema: 1)`, the subscriber gracefully ignores
   the unknown field — it should not error, should still ingest
   the rest of the row, and should log a `schema_version_skew`
   event so an operator can notice the drift.

A change that violates one of these invariants — a required
field a v1 subscriber cannot tolerate, a serialization shape
that breaks parsers, a schema version that wasn't bumped — fails
the contract test on the negative case before merge. That is the
test's job, and it does it cheaply because the harness boots two
Miniflare instances in under a second.

#### What the contract test deliberately doesn't cover

- **Real Cloudflare behaviour.** Miniflare emulates D1 / KV / R2
  / Queues but not Stream and not the production edge cache.
  Stream-touching paths use `MOCK_STREAM`; edge-cache behaviour
  is exercised at the preview-deploy level.
- **Long-tail latency.** The harness is in-memory and
  sub-second; it doesn't tell you whether sync at 600-dataset
  scale stays inside the p95 budget. That is the load test's
  job.
- **Auth.** The handshake mocks Access; real-world Access
  integration is exercised in the e2e Playwright suite, not here.

## CI/CD

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

## Production debugging

Production runs on Cloudflare's edge; debugging is mostly knowing
which dashboard or CLI surfaces what, plus a small set of
playbooks for the failure modes that actually happen.

### Logs and metrics

- **`wrangler pages deployment tail` against production.**
  Real-time streaming of Pages Function logs; same shape as the
  local tail but pulling from the deployed worker. Filter with
  `--format=pretty` and `--search=...` for ad-hoc queries. Tail
  is best for "is something happening right now" — for
  retrospective questions, use Workers Logs.
- **Workers Logs (Cloudflare dashboard → Pages → terraviz →
  Logs).** Persistent log retention (Workers Paid: 7 days; free:
  none, so production must be Workers Paid — see "Free-tier
  viability" in [`CATALOG_BACKEND_PLAN.md`](CATALOG_BACKEND_PLAN.md)).
  Filter by status code, route, or arbitrary header. The
  `X-Request-Id` from the client side is the fastest way to
  find the matching log line for a user-reported issue.
- **Analytics Engine.** The catalog backend writes its own
  operational metrics (request rate, p50/p95 latency by route,
  D1 query duration distribution) to Workers AE alongside the
  user-facing telemetry. Grafana dashboards under
  `grafana/dashboards/catalog-backend-*` query them.

### Inspecting production state

| Resource | Inspect with | Notes |
|---|---|---|
| **D1** | `npx wrangler d1 execute CATALOG_DB --remote --command "..."` | Read-only queries are safe; never run schema-mutating SQL ad-hoc — use a migration. |
| **KV** | `npx wrangler kv key list --binding=CATALOG_KV --remote` (and `... key get`) | KV reads are billed per call; an audit script that lists every key is fine, fetching every value isn't. |
| **R2** | `npx wrangler r2 object list terraviz-assets --remote` (and `... object get`) | Free reads up to standard tier limits; bulk download via wrangler is rate-limited and expensive. |
| **Stream** | Cloudflare dashboard → Stream → list videos | The `uid` from the dataset row's `data_ref` is searchable directly. |
| **Audit log** | `wrangler d1 execute CATALOG_DB --remote 'SELECT * FROM audit_events WHERE subject_id = ? ORDER BY id DESC LIMIT 50'` | The subject-keyed timeline is the answer to most "what happened to dataset X" incidents. |

The `audit_events` table is the centrepiece of production
incident response. Every meaningful state change (publish,
retract, grant, revoke, `integrity_failure`, hard delete,
`schema_version_skew`, federation subscribe / sync) writes a row;
ULID ordering means the timeline is queryable without a separate
index. Most playbooks below boil down to "find the relevant
audit_events rows."

### Incident playbooks

- **A peer subscriber claims they aren't receiving updates.**
  Query `audit_events` filtered by `subject_id = <peer_id>`;
  expect to see `federation_handshake_accepted` followed by
  periodic `federation_sync_completed` rows. If syncs stopped,
  the peer's well-known endpoint may be unreachable or the
  signature is failing. Workers Logs filtered by the peer's
  `node_id` surface the actual error.
- **A user reports a 500 on a specific dataset.** Pull
  `X-Request-Id` from their browser if they can read it; if
  not, narrow Workers Logs to the dataset's slug or id over
  the relevant time window. Common 500 causes: missing
  rendition for the codec the caller advertised (manifest
  endpoint can't satisfy the request), Stream signed-URL
  signing-key rotation in flight, or a D1 prepared-statement
  cache eviction storm (rare; recovers on its own).
- **An integrity-failure event surfaces in the publisher
  portal.** The `audit_events` row carries
  `(peer_id, dataset_id, expected_digest, actual_digest)` in
  its `metadata_json`. First investigation step: did the
  publisher re-upload between the peer's mirror fetch and the
  failure? Any retraction or update event for the same dataset
  between those two timestamps explains the mismatch benignly;
  if not, treat it as a real signal and pause that mirror until
  reviewed.
- **D1 latency spikes.** Workers AE's `db_query_duration`
  distribution shows whether it's a specific query or a global
  slowdown. Specific query: pull the EXPLAIN plan via
  `wrangler d1 execute CATALOG_DB --remote 'EXPLAIN QUERY PLAN ...'` and
  look for missing indexes (the catalog hot path is heavily
  index-driven; a missing index after a schema change is the
  most common cause). Global slowdown: check Cloudflare's D1
  status page; this happens occasionally and resolves on its
  own.
- **Stream playback failures.** Stream signed URLs have a
  5-minute TTL; a clock-skewed client can request a URL that
  is already expired by the time it reaches Stream. The fix is
  small client-side clock-skew detection (compare the `Date`
  header from the manifest response to the client's clock;
  warn if drift exceeds ~30s) — a Phase-2 hardening if it
  shows up.

### Things you should not do in production debugging

- Run schema-mutating SQL ad-hoc against `--remote` D1. Always
  use migrations; the audit trail and CI gates exist for a
  reason.
- Delete R2 objects directly. Asset cleanup goes through the
  retraction or hard-delete paths so the audit log captures it.
- Rotate the node-identity Ed25519 keypair without a peer-grace
  overlap (see "Pinning happens at handshake" in
  [`CATALOG_FEDERATION_PROTOCOL.md`](CATALOG_FEDERATION_PROTOCOL.md)).
  Doing so silently breaks every peer's signature verification;
  recovery requires re-handshaking each peer.
- Restart workers expecting in-memory state to be fresh.
  Cloudflare Workers don't have persistent in-memory state
  across invocations; if a bug appears to depend on cold-start
  behaviour, instrument the cold path rather than trying to
  force restarts.

## Conventions

- One commit per migration, with the migration file in the same
  commit as the code that depends on it.
- `schema_version` bumps in a separate commit so its diff is the
  one place to audit shape changes.
- Federation protocol changes go through a separate `protocol/`
  changelog file (in addition to git history) so peer operators
  can subscribe to it.
