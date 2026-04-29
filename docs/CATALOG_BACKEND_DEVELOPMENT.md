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
- **Node.js ≥ 20.10.** Wrangler 4+ requires it.
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
| `PREVIEW_SIGNING_KEY` | HMAC-SHA-256 secret for preview tokens. **Required in production** — the preview endpoints fail closed (503 `preview_unconfigured`) when this is unset, rather than falling back to a guessable constant. A deterministic dev secret applies only when `DEV_BYPASS_ACCESS=true` (which is itself refused on non-loopback hostnames). Set the real value via `npx wrangler pages secret put PREVIEW_SIGNING_KEY` on the production deployment. | Phase 1a (prod) |
| `VIDEO_PROXY_BASE` | Override the upstream Vimeo proxy. Defaults to the production proxy when unset. | Phase 1a |
| `MOCK_STREAM` | Set `true` for development; bypasses Stream's playback URL signing so you do not need a Stream account locally. | Phase 1b+ |
| `STREAM_ACCOUNT_ID` / `STREAM_API_TOKEN` | Cloudflare dashboard → Stream. Only needed for Phase 1b+ asset uploads. | Phase 1b |
| `KILL_TELEMETRY` | Set `1` to disable analytics ingestion locally — almost always what you want during dev. | n/a |

Phase-1a contributors realistically only need `NODE_ID_PRIVATE_KEY_PEM`,
`DEV_BYPASS_ACCESS=true`, and `KILL_TELEMETRY=1`. Everything else
stays unset until the corresponding feature lands.

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
  `FEEDBACK_DB`, and the analytics + AI bindings all listed
  (Stream prints `MOCK_STREAM` instead of a real binding when
  mocked, which is expected through Phase 1b).
- Round-trip a draft via the CLI:
  ```bash
  echo '{"title":"From CLI","format":"video/mp4",
        "data_ref":"vimeo:1107911993","license_spdx":"CC-BY-4.0"}' \
    > /tmp/m.json
  npm run terraviz -- --server http://localhost:8788 \
    --insecure-local publish /tmp/m.json
  ```
  → "Created draft …" then "Published … (timestamp)".

If any of these fail, the troubleshooting matrix in "Local
debugging" below lists the common causes.

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
  bindings declared in `wrangler.toml`.
- A Stream account on the same Cloudflare account if you will
  exercise asset uploads in a non-mock environment (Phase 1b
  onward).
- Cloudflare Access enabled on `/api/v1/publish/**` from Phase 1a
  onward — both the CLI service-token flow and (from Phase 3) the
  browser portal flow attach to the same policy. Local dev does
  not need Access; the publisher API has a `DEV_BYPASS_ACCESS=true`
  flag that mints a fake `staff` publisher row keyed off the
  local user's email, and the CLI accepts a
  `TERRAVIZ_INSECURE_LOCAL=1` flag that skips service-token
  validation when targeting `localhost:8788`.

The self-hosting walkthrough at
[`docs/SELF_HOSTING.md`](SELF_HOSTING.md) is the more thorough
reference for the full deploy story; the section above is the
minimum a contributor needs to know.

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
  catalog-schema.sql             # post-migration snapshot, regenerated by
                                 #   `npm run db:dump-schema`. Sits one level
                                 #   above migrations/catalog/ so wrangler does
                                 #   not pick it up as a migration.

scripts/
  seed-catalog.ts                # imports SOS catalog → local D1
  refresh-sos-snapshot.ts        # re-pulls public/assets/sos-dataset-list.json
  dump-catalog-schema.ts         # regenerates migrations/catalog-schema.sql
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
npm run db:dump-schema       # regenerate migrations/catalog-schema.sql snapshot
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
  you must set `FRONTEND_ORIGIN` in `.dev.vars`. Tauri webviews
  bypass CORS entirely — desktop dev never sees this.
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
