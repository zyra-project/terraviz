# Federation On-Ramp Scoping — Self-Hosted Fork vs. Install Package

**Status: draft for review.** Scopes the question of how a partner
organisation joins a federated Terraviz network: by forking the
repo (Path A), by installing a versioned runtime artifact (Path B),
or by a hybrid. Evidence is drawn from the repository at `main`
commit `3cff1c4`. Companion to
[`../CATALOG_BACKEND_PLAN.md`](../CATALOG_BACKEND_PLAN.md) and
[`../CATALOG_FEDERATION_PROTOCOL.md`](../CATALOG_FEDERATION_PROTOCOL.md).

**Last reviewed:** 2026-05-04 (initial scoping interview with Eric;
§8 decisions captured in commit `c98bfc1`).

**Decision amended:** 2026-09-04 (the §8-change revisit trigger fired;
§7 Directive 3 and §8 decision 5 were revised by the
[metadata and STAC audit](../metadata/README.md). This amendment reviewed
only the STAC direction; all other §8 decisions retain the review date above.)

**Revisit when any of the following becomes true:**

- Phase 4 federation ships in production. At that point this doc
  transitions from "directive" to "history" — defer to
  `CATALOG_BACKEND_PLAN.md`.
- The publisher-CLI pilot (§6 first step) reveals auth-flow
  problems that invalidate the service-token assumption in
  decision 4.
- A non-Cloudflare partner with funding for engineering work
  emerges, changing the calculus on decision 3.
- The Phase 4 ETA slips past two quarters from the last-reviewed
  date, triggering re-evaluation of the §6 sequence.
- Any of §8's resolved decisions changes — particularly which
  cohort federation prioritises (decision 1) or how restrictive
  the trademark policy is (decision 8).

**Supersedes when:** the §8 "Cross-doc updates implied by these
decisions" subsection has been fully applied to the operational
docs (`CATALOG_BACKEND_PLAN.md`, `CATALOG_FEDERATION_PROTOCOL.md`,
`ROADMAP.md`, the §3 Path A polish entries). At that point this
doc remains as the historical record of *how* those changes were
decided; the catalog plan and roadmap become the active source of
truth.

---

## Reframing — fork-vs-package is the wrong first question

Before getting to the comparison: the framing in the original brief
deserves pushback.

Federation is **fully designed in markdown but not in code.** The
plan documents in `docs/CATALOG_*.md` lay out a 6-phase backend
roadmap with the federation protocol as Phase 4. What ships today
in `functions/api/v1/**` is Phase 1a–1d: the catalog read API,
publisher write API, asset uploads, and a docent search index. The
single piece of federation code that exists is the well-known
discovery document at `functions/.well-known/terraviz.json.ts:88-92`,
which advertises `feed` and `handshake` endpoints that **do not yet
exist as routes** — there is no `functions/api/v1/federation/`
directory, no handler files, no middleware. Other matches for
`federation/feed` / `federation/handshake` in the repo are confined
to comments, the well-known document itself, and its test fixture
(`functions/.well-known/terraviz.json.test.ts`). No
`federation_peers`, `federation_subscribers`, `federated_datasets`,
or `federated_tours` tables exist in `migrations/catalog/` (verified
— the latest migration is `0008_legacy_id.sql`, none mention these).

So the operative question is **not** "which packaging path do we
ship Terraviz nodes through" — it is "what does a Terraviz node
have to be before the packaging question is answerable?" The answer
shapes A and B differently:

- If a node is "a Cloudflare Pages deployment with our specific
  bindings" — which is what it is today — then Path A is the only
  realistic path. Path B is a 6-phase port that doesn't exist.
- If a node is "anything that speaks the federation protocol on
  HTTP" — which is what `CATALOG_FEDERATION_PROTOCOL.md` describes —
  then Path B is plausible, **and so is "any partner can write a
  node in any language."** That changes the question.

This document treats the second framing as load-bearing and
addresses fork-vs-package within it. Section 5 — Hybrid Options —
is where the most likely answer lives.

---

## Design goals

Three goals scope every decision in this document. They are
user-stated intent, not derived from the codebase; the rest of
the doc should be read as "how does this serve (or fail) them."

### Goal 1 — Scale to many partners, not just the first one

The architecture supports a network of nodes from the start, not
a hub-and-spoke between Zyra and one early adopter. Per-partner
adapters (an AWS reference because Amazon showed up, a GCP
reference for the next partner, …) fail at N=2: each adapter is
a long-term maintenance commitment we'd rather not own. Investment
goes into the **protocol and the conformance contract**, not into
adapters Zyra maintains.

### Goal 2 — Maximise partner choice; minimise required vendors

A partner can join the catalog network without being forced into
a commercial relationship with any specific vendor — including
Cloudflare (the canonical node's vendor) and Zyra. Concretely:

- **No required language.** JSON-over-HTTP, JSON Schema published.
- **No required cloud.** Protocol is implementable on any HTTP server.
- **No required identity provider.** HMAC + Ed25519 are sufficient
  for federation; richer auth is partner choice.
- **No required hosting model.** Container, fork, serverless, or
  bare-metal all viable.

This rules out "Zyra builds and maintains AWS adapters as a
deliverable." It also rules out picking any single partner's cloud
as a second reference implementation. The spec is the reference;
the runtime is whatever the partner chooses.

### Goal 3 — Reduce the technical burden of joining to its smallest form

A partner pays only the cost matching what they actually want.
Tiered on-ramps:

| Tier | Partner does | Burden |
|---|---|---|
| **0 — Publisher** | `terraviz publish dataset.yaml` on a schedule against the canonical node. No node hosted; data appears in the canonical catalog. | Minutes — same shape as a CI deploy step. |
| **1 — Read-only peer** | Subscribe to a canonical node's feed; mirror catalog metadata; serve locally. No publishing. | Hours; single config file + container or fork. |
| **2 — Full peer** | Publish own data, host assets, federate bidirectionally. | Days; scales with how much custom infra the partner brings. |
| **3 — Custom implementation** | Write own node in any language from the published spec. | Weeks. The conformance suite is the contract. |

Tier 0 should work *as soon as the first partner pilot validates
the auth flow* — the publisher CLI in `cli/` is the hand-it-over
moment, gated on (a) shipping it to npm and (b) §8 decision 4's
pilot, which is the discovery exercise that confirms whether
Cloudflare Access service tokens are a workable onboarding step
for partners or whether the auth model needs reshaping first.
Tier 1 is the focus of the post-Phase-4 work and the lowest-burden
generic on-ramp for partners who want operational control without
running a full publishing stack. Tier 2 follows once Phase 4 lands.
Tier 3 is gated only by publishing the spec + conformance, not by
Zyra shipping anything specific to that partner.

### What these goals change about the rest of this document

- **Path B-as-runtime-artifact does not survive Goal 2.** Path B
  assumed Zyra would maintain a portable runtime artifact for
  partners. Goal 2 says the spec is the artifact; the runtime is
  the partner's choice. The thing Path B *was trying to deliver*
  — easy joining for non-Cloudflare partners — is delivered by
  Tier 1 + Tier 3 read against the published spec, with no
  Zyra-maintained non-Cloudflare runtime.
- **§7 Directive 2 (publish JSON Schema + protocol CHANGELOG) is
  promoted from "important" to load-bearing.** It is the only
  thing that makes Goals 1 and 2 real. Without a published spec,
  partners depend on us; with one, they don't.
- **§5 Hybrid 3 (lightweight peer appliance) is promoted from
  footnote to first-class.** A small reference container that
  serves the well-known doc + federation feed only — runnable
  anywhere, in any language — is Tier 1's reference
  implementation. Roughly a weekend's work post-Phase-4 if §7
  Directives 1 and 2 are in place.
- **Amazon (or any non-Cloudflare partner) is steered toward
  Tier 3, not toward asking us to build their tier.** They are
  the partner type that can implement against the spec; Zyra's
  role is to make the spec implementable, not to write their
  node for them.

The remainder of this document was drafted before these goals
were stated. Where §5 and §6 read as if Path B's runtime artifact
were a real option, the goals above supersede them. The
Recommendation in §6 and the directives in §7 align with these
goals already; this section makes the alignment explicit so the
trade-offs aren't re-litigated later.

---

## 1. Current State Assessment

### What Terraviz actually is, today

A TypeScript single-page app (Vite + MapLibre GL JS, vanilla TS, no
framework) that visualises NOAA Science On a Sphere datasets on a
3D globe. Two distribution targets exist today:

1. **Web app on Cloudflare Pages.** Source at `src/**`, Pages
   Functions at `functions/**`, deployed at
   `terraviz.zyra-project.org`. This is the "production" deployment.
2. **Tauri v2 desktop app** for Windows / macOS / Linux. Source at
   `src-tauri/**`, signed and shipped via GitHub Releases by
   `.github/workflows/release.yml`. Adds offline dataset cache,
   local LLM support, and OS-keychain API key storage.

A third channel — a publisher CLI (`bin/terraviz.cjs`,
`cli/terraviz.ts`) — exists for headless dataset publish/update/
retract against the catalog API (`package.json:6` declares
`"bin": { "terraviz": "./bin/terraviz.cjs" }`). It speaks
HTTP+Cloudflare Access service tokens to whichever node is its
target. It is not yet released to npm (no `@zyra/terraviz-cli` on
the registry; the publishing model is documented but unimplemented
in `docs/CATALOG_PUBLISHING_TOOLS.md:328-389`).

There is no Python, no Helm chart, no container image targeting
production deploys. `Dockerfile` at the repo root is a
**developer-environment** image (sets up Node + Rust + Tauri
prereqs and runs `npm run dev`) — not a runtime artifact. There is
no `pyproject.toml`, no `setup.py`, no `Chart.yaml`, no `values.yaml`
(`find . -name 'pyproject.toml' -o -name 'Chart.yaml'` returns
nothing).

### What "self-hosting" means today

[`docs/SELF_HOSTING.md`](../SELF_HOSTING.md) is the canonical
operator path. It describes:

1. Forking the GitHub repo.
2. Connecting the fork to Cloudflare Pages via the dashboard.
3. Manually wiring six bindings in the Cloudflare dashboard
   (D1×2, KV×2, R2, Vectorize, Workers AI, Analytics Engine).
4. Setting Cloudflare Access policies for staff endpoints.
5. Setting build-time `VITE_*` env vars in the Pages dashboard.
6. Running migrations against the production D1.

That is Path A in flight already. It works — `terraviz.zyra-project.org`
is one such instance. But it has three properties that matter
here:

- **It is Cloudflare-only.** Every binding above is a Cloudflare
  primitive. The `wrangler.toml` is documentation; Pages reads
  bindings from the dashboard, not the file (`wrangler.toml:60-63`,
  `docs/SELF_HOSTING.md:83-88` both call this out explicitly).
- **It requires editing source for some operator decisions.**
  `src/services/hlsService.ts:27` and
  `src/services/downloadService.ts:13` hardcode
  `VIDEO_PROXY_BASE = 'https://video-proxy.zyra-project.org/video'`
  — a fork operator using their own video proxy edits source.
  Same with `EARTH_TEXTURE_BASE` (`src/services/photorealEarth.ts:90`)
  and `METADATA_URL` (`src/services/dataService.ts:12`, only
  reachable on the legacy `VITE_CATALOG_SOURCE=legacy` path).
- **It expects the operator to read 6800+ lines of plan markdown.**
  `docs/CATALOG_BACKEND_PLAN.md` (2965 lines), companion docs
  (3844 more lines), plus `SELF_HOSTING.md` (411 lines) and
  `CATALOG_BACKEND_DEVELOPMENT.md` (1199 lines). A domain
  scientist at NOAA won't read this. A platform engineer at a
  partner science museum might.

### What federation looks like in the codebase right now

| Artifact | Status | Evidence |
|---|---|---|
| Federation protocol design | **Complete** (399 lines of spec) | `docs/CATALOG_FEDERATION_PROTOCOL.md` |
| `/.well-known/terraviz.json` route | **Live** | `functions/.well-known/terraviz.json.ts` |
| `node_identity` D1 table | **Live** | `migrations/catalog/0001_init.sql:22-30` |
| `npm run gen:node-key` (Ed25519 keypair) | **Live** | `scripts/gen-node-key.ts` |
| `visibility` column on `datasets` | **Live** (`'public'\|'federated'\|'restricted'\|'private'`) | `migrations/catalog/0001_init.sql:57-58` |
| `data_ref` supports `peer:<node>/<id>` scheme | **Schema-ready, code rejects it** | `migrations/catalog/0001_init.sql:40` lists it; `functions/api/v1/datasets/[id]/manifest.ts:320` says "Phase 4". |
| `/api/v1/federation/feed` route | **Missing** | No file exists. |
| `/api/v1/federation/handshake` route | **Missing** | No file exists. |
| `federation_peers` table | **Missing** | Not in `schema/catalog-schema.sql`. |
| `federated_datasets` mirror table | **Missing** | Not in `schema/catalog-schema.sql`. |
| Catalog signing (Ed25519 over response body) | **Missing** | `NODE_ID_PRIVATE_KEY_PEM` is wired through `CatalogEnv` but unused (`functions/api/v1/_lib/env.ts:36`). |
| Frontend "origin badge" / peer filter chip | **Missing** | `src/ui/browseUI.ts` has no peer-aware code. |
| STAC alignment (the wire shape would need to be a STAC Item profile per the plan) | **Missing** | `grep -n "stac\|STAC" functions/api/v1/_lib/dataset-serializer.ts` returns nothing. |

The single architectural piece that does exist for federation —
`/.well-known/terraviz.json` — works as a forward-compatible
placeholder. Federation subscribers can probe a node and read its
identity; the placeholder advertises endpoints that will exist in
Phase 4 (`functions/.well-known/terraviz.json.ts:88-99`, including
the comment "federation goes live in Phase 4").

### Architecture diagram (current and planned)

```
┌──────────────────────── TODAY ────────────────────────┐
│                                                       │
│  Cloudflare Pages deployment                          │
│  ├── /api/v1/catalog       (D1 + KV snapshot)         │
│  ├── /api/v1/datasets/{id}/manifest                   │
│  ├── /api/v1/publish/**    (Cloudflare Access)        │
│  ├── /api/v1/search        (Vectorize)                │
│  └── /.well-known/terraviz.json   ← only "federation" │
│         (advertises feed + handshake endpoints that   │
│          do not exist as routes yet)                  │
│                                                       │
│  Operator path: fork → Cloudflare Pages dashboard →   │
│  six bindings → Access policies → npm run gen:node-key│
└───────────────────────────────────────────────────────┘

┌──────────────────── PLANNED (Phase 4+) ───────────────┐
│                                                       │
│  Node A ──── /.well-known/terraviz.json ────► Node B  │
│                                                       │
│  Node A ──── POST /api/v1/federation/handshake ────►  │
│                                                       │
│  Node A ◄─── GET /api/v1/federation/feed ───── Node B │
│              (signed STAC-like Collection,            │
│               cursor-driven pull, polite cadence)     │
│                                                       │
│  Tables added: federation_peers, federated_datasets,  │
│  federated_tours, dataset_grants                      │
│                                                       │
│  Frontend: origin badge per browse card, peer filter  │
│  chip, "temporarily unavailable" dimming              │
└───────────────────────────────────────────────────────┘
```

### The actual seams in the codebase

- **Wire Dataset shape:** declared in
  `functions/api/v1/_lib/dataset-serializer.ts` (the `WireDataset`
  interface). One source of truth, additive evolution. Already
  carries `origin_node`, `visibility`, `schema_version` columns.
  This is the seam a federation feed would serialise through.
- **Catalog read path:** `functions/api/v1/_lib/catalog-store.ts`
  exposes `listPublicDatasets()` with comments calling out that the
  federation-feed visibility predicate is the same code with one
  line different (`functions/api/v1/_lib/catalog-store.ts:96-109`).
- **Cloud-portability layer:** *planned* under
  `functions/api/v1/_lib/{storage,catalog,kv,video,auth,queue}/`
  per `CATALOG_BACKEND_PLAN.md:2125-2168`, but **not extracted
  today.** Code today calls D1/R2/Stream/KV bindings directly
  through `CatalogEnv`. A future port to Postgres/S3 is bounded
  but not free.
- **CLI:** the `cli/` tree is the closest thing to a portable
  surface in the repo. It speaks plain HTTP+JSON and does not
  depend on Cloudflare primitives at the transport layer. Auth is
  *not yet* portable: `cli/lib/client.ts` only knows how to send
  Cloudflare Access service-token headers (or `--insecure-local`
  for dev); a non-Cloudflare node would require corresponding CLI
  changes (bearer tokens, OIDC) before it could authenticate. So
  the CLI is portable in *shape* but not in *auth* today, and
  decision 4 in §8 makes the auth-flow viability an open
  pilot-validation question rather than a settled property.

### Mission/roadmap mismatch

[`MISSION.md`](../../MISSION.md) defines the audience as students,
educators, communities, "anyone who wants to understand the planet"
— end-users, not operators or partners. [`ROADMAP.md`](../../ROADMAP.md)
is structured around "reach more people / keep them engaged / code
health" and does not mention federation, catalog backend, or
publishers anywhere (`grep -i "federation\|catalog\|publisher"
ROADMAP.md` returns nothing).

The federation work is documented in `docs/CATALOG_*.md` as a
planning artifact — substantively sized, drafted with care, marked
"Status: draft for review" — but it has not been adopted into the
public roadmap. **This is worth surfacing to Eric explicitly: who
is federation for, and why is it not in `ROADMAP.md`?** The answer
shapes everything below.

---

## 2. Documentation Gap Inventory

| Doc that should exist for federation to be operable | Currently exists? | Location or "missing" | Priority |
|---|---|---|---|
| Federation protocol spec (wire format, signing, handshake, sync) | **Yes — comprehensive** | `docs/CATALOG_FEDERATION_PROTOCOL.md` (399 lines) | P0 done |
| Node operator guide (Cloudflare path) | Partial — covers feedback + telemetry, not catalog or federation | `docs/SELF_HOSTING.md` covers Phases 1–7 of the *original* SPA deploy; the catalog backend's operator section is split into `docs/CATALOG_BACKEND_DEVELOPMENT.md:520-689` ("Production deployment checklist"). | P0 — merge or cross-link |
| Node operator guide (non-Cloudflare path) | **Missing** | Cloud-portability layer is planned in `CATALOG_BACKEND_PLAN.md:2125-2215` as Phase 6 work | P1 if Path B is committed |
| Contributor / development guide | **Yes** | `docs/CATALOG_BACKEND_DEVELOPMENT.md` (1199 lines, walkthrough + CI) | P0 done |
| OpenAPI / JSON Schema for the wire `Dataset` and federation feed | **Missing** | No `*.openapi.*` / `*.schema.json` files. Wire shape lives in TypeScript at `functions/api/v1/_lib/dataset-serializer.ts:WireDataset` and prose in `docs/CATALOG_DATA_MODEL.md`. | P0 — required for any non-TS node |
| Schema reference for `Dataset` / `Tour` | **Yes** | `docs/CATALOG_DATA_MODEL.md` (682 lines) | P0 done |
| STAC mapping document (the plan commits to STAC Item profile) | **Missing** | Promised in `CATALOG_BACKEND_PLAN.md:264-309`; no concrete mapping exists in code or docs | P1 |
| Security & threat model | **Yes** | `CATALOG_BACKEND_PLAN.md:1942-2123` ("Threat model & secrets management") | P0 done |
| Asset pipeline / integrity (`content_digest`) | **Yes** | `docs/CATALOG_ASSETS_PIPELINE.md` (882 lines) | P0 done |
| Publisher CLI reference | **Yes** | `docs/CATALOG_PUBLISHING_TOOLS.md:169-425` | P0 done |
| Upgrade / migration guide between catalog versions | Partial — schema-version evolution is described, but there's no operator-facing "how do I upgrade my fork" doc | `CATALOG_FEDERATION_PROTOCOL.md:326-399`, `CATALOG_DATA_MODEL.md:429-520` ("Schema migration tooling") | P1 |
| Conformance test suite for third-party node implementations | Designed, not built | `CATALOG_BACKEND_DEVELOPMENT.md` references `npm run test:federation` but the script is not in `package.json` | P0 if we want third-party nodes |
| Public CHANGELOG for protocol bumps | **Missing** | Promised at `docs/protocol/CHANGELOG.md` (`CATALOG_FEDERATION_PROTOCOL.md:387-390`); does not exist | P1 |
| `/.well-known/terraviz.json` schema doc | Partial — described in plan, not formalised | `CATALOG_FEDERATION_PROTOCOL.md:15-44`; no JSON Schema file | P1 |

The plan documents are unusually thorough. The gaps are
predominantly around **machine-consumable** specs (OpenAPI, JSON
Schema, STAC mapping, conformance suite) rather than around
prose. That gap is the one Path B has to close to be more than
aspirational.

---

## 3. Path A — Self-Hosted Fork: Scoped Plan

### Required documentation changes

| Change | File | Effort |
|---|---|---|
| Promote federation to the public roadmap or explicitly defer it | `ROADMAP.md` | S |
| Split `SELF_HOSTING.md` into "operator" (run a node) and "fork contributor" (modify and submit upstream) sections; cross-link `CATALOG_BACKEND_DEVELOPMENT.md` for the catalog half | `docs/SELF_HOSTING.md`, `docs/CATALOG_BACKEND_DEVELOPMENT.md` | M |
| Write a `docs/UPSTREAM_MERGE.md` that documents how an operator pulls upstream without losing local config | new doc | M |
| Document the "what to change in your fork" surface explicitly — every hardcoded URL, every dashboard binding, every Access policy. Today the operator finds these by grepping. | new doc, e.g. `docs/FORK_CONFIG.md` | M |
| Federation operator section: `gen:node-key`, well-known doc, future handshake flow when Phase 4 ships | `docs/SELF_HOSTING.md` extension | S |

### Required code changes to make forking sustainable

| Change | File | Effort | Why |
|---|---|---|---|
| Lift hardcoded `VIDEO_PROXY_BASE` into a build-time env var (e.g. `VITE_VIDEO_PROXY_BASE`) with the current default | `src/services/hlsService.ts:27`, `src/services/downloadService.ts:13`, `src/ui/playbackController.ts:241` | S | Today every fork that points at its own proxy must edit source. Same problem as `CATALOG_BACKEND_PLAN.md` constraint #1. |
| Lift `EARTH_TEXTURE_BASE` likewise | `src/services/photorealEarth.ts:90` | S | Same reasoning. |
| Lift `METADATA_URL` (legacy path) likewise or document it as deprecated | `src/services/dataService.ts:12` | S | Mostly dead code post-1d, but a fork operator on `VITE_CATALOG_SOURCE=legacy` still inherits the SOS S3 URL. |
| Surface every binding name as a documented constant or env var with a single grep-able prefix (`TERRAVIZ_*` / `VITE_TERRAVIZ_*`) | various | M | Right now binding names are scattered; an operator who renames `CATALOG_DB` has to grep across `functions/`, `scripts/`, and tests. |
| Wrap the "default upstream" identifiers in `package.json` (`name`, `bin`) so a fork running `npm pack` doesn't accidentally ship as `terraviz` | `package.json` | S | A fork that publishes a CLI package needs its own scope; today there's no story for this. |
| Add `npm run check:fork-config` that fails CI if any of the above defaults are still set on a non-zyra-project deployment | new script | M | Catches "operator forgot to flip a switch" before prod. |

### Estimated effort summary (Path A, doc + code)

| Item | Effort |
|---|---|
| Doc reshuffles (operator vs contributor split, fork-config doc) | M |
| Hardcoded-URL lift to env vars | S |
| Binding-name consolidation | M |
| Fork-config CI check | M |
| Federation operator section (when Phase 4 is implemented) | M |

Total: ~one engineer-fortnight of doc + small refactor work, not
counting Phase 4 federation implementation itself.

### Failure modes for Path A

- **Drift.** A partner forks at `v0.3.1`, customises, then the
  upstream catalog backend ships Phase 1d cutover, Phase 4 federation,
  Phase 5 grants. Each merge gets harder. Partners with shallow
  TypeScript skill abandon their fork at the first conflict.
- **Security patch propagation.** A vuln in `dataService.ts` or in
  the publish middleware is fixed upstream. Forks that haven't
  pulled in three months are exposed. There is no "phone home"
  mechanism — `terraviz.zyra-project.org` does not get a list of
  who is running which fork at which commit, and we wouldn't want
  it to.
- **Schema drift.** A fork that runs Phase 1a + Phase 4-fork-of-the-week
  but missed the migration sequence breaks the conformance test in
  ways its operator cannot diagnose.
- **Cloudflare lock-in.** Forking helps a partner who is
  Cloudflare-friendly. A partner whose IT will not approve a
  Cloudflare account at all (US Federal compliance, EU data residency
  requirements, internal-only deployment) cannot use a fork without
  also doing the entire Phase 6 cloud-portability port. That is
  many person-months of work.
- **Operational expertise required.** Wiring six dashboard bindings,
  setting up Cloudflare Access policies in the right order
  (`SELF_HOSTING.md:241-260` is non-trivial), running D1 migrations
  — this is platform-engineer work. A domain scientist at a partner
  agency cannot do it without staff support.

### Honest assessment of who Path A serves

| Partner type | Path A fit? |
|---|---|
| Zyra Project / first-party operators | **Excellent** — they wrote the plan, they're already on Cloudflare, they want full control. |
| A partner science museum with a software engineer on staff who is comfortable on Cloudflare | **Good** — the SELF_HOSTING.md walkthrough works for them. |
| A NASA / NOAA / academic partner whose IT mandates a non-Cloudflare cloud | **Bad** — they cannot. Phase 6 portability is the prerequisite. |
| A partner who wants to run a node but does not want to maintain code | **Bad** — they can't. Forking *is* the operator path; "no code maintenance" is not on offer. |
| A partner who only wants to *publish* (not host a node) | **Excellent — but via the CLI, not a fork.** The publisher CLI is already the right shape for this audience. |

The last row is significant. The CLI in `cli/terraviz.ts` already
provides the publishing-without-hosting path for partners who want
their data in the catalog but don't care about running a node.
Federation is for partners who want both.

---

## 4. Path B — Install Package: Scoped Plan

### Recommended packaging strategy

The repo today has no Python and no Helm chart. The realistic
artifacts are:

1. **A signed container image** of the Pages Functions runtime,
   targeting a node operator who runs `docker compose up` against
   a Postgres/MinIO/Mux backend. This is the `aws-mediaconvert.ts`
   /  `postgres.ts` / `s3.ts` reference deploy contemplated in
   `CATALOG_BACKEND_PLAN.md:2188-2199`.
2. **An npm package** (`@zyra/terraviz-cli`) for the publisher CLI,
   already designed in `CATALOG_PUBLISHING_TOOLS.md:328-389`. This
   is shippable now with modest effort and **decouples publishing
   from hosting** — a strictly smaller problem than full federation.
3. **A "Cloudflare template"** — a one-click GitHub-template fork
   that a partner can use to provision a Cloudflare deployment from
   a wizard. Bridges Path A and Path B for the Cloudflare-friendly
   case.

Helm/pip are not the right answer because there is nothing Pythonic
in the codebase and the only "process" that needs Helm is the
hypothetical containerised node. A container image alone is enough;
Helm is value-add only for partners who already run Kubernetes.

### Required code refactors to expose a stable surface

| Refactor | Where | Effort |
|---|---|---|
| Extract storage / catalog / kv / video / auth / queue interfaces under `functions/api/v1/_lib/{storage,catalog,kv,video,auth,queue}/` per `CATALOG_BACKEND_PLAN.md:2125-2168` | new | **L** |
| Implement Postgres + S3 + (Mux or self-hosted ffmpeg) reference adapters | new | **L** |
| Replace the Cloudflare Access dependency with an interface (`auth/authProvider.ts`) so a non-CF node can plug in OIDC or bearer tokens | new | M |
| Make every URL a configurable env var (covers Path A's code changes too) | various | S |
| Replace Workers Analytics Engine writes with a portable analytics adapter — or document AE-portability as a non-goal for non-CF nodes | `functions/api/ingest.ts` and call sites | M |
| Rewrite `wrangler.toml`-bound entry points as a runtime-agnostic Hono / Fastify server, then provide a Pages Functions wrapper | new entry point, retain `functions/` for CF | **L** |
| Provide a `docker-compose.yml` that brings up Postgres + MinIO + the new entry point against a seeded catalog | new | M |
| Pin the wire `Dataset` shape in JSON Schema, generated from the TypeScript types (`json-schema-to-typescript`/`zod`) | new build step | M |
| Pin the federation feed shape in JSON Schema | new | M |
| Generate an OpenAPI 3.1 spec from the route handlers | new build step | M |

### Required protocol/spec work

| Item | Effort | Note |
|---|---|---|
| Implement Phase 4 federation (handshake / feed / webhook routes, `federation_peers`/`federated_datasets` migrations, signing) | **L** | This is the prerequisite — no federation = no nodes to package. |
| Land STAC Item profile mapping in `dataset-serializer.ts` | M | Promised in `CATALOG_BACKEND_PLAN.md:279-309`; not done. |
| Build the conformance test harness (`npm run test:federation`) | M | Two-Wrangler-instance handshake test described in `CATALOG_BACKEND_DEVELOPMENT.md`. |
| Publish JSON Schema + OpenAPI to a versioned URL (e.g. `https://terraviz.org/schema/v1/`) so independent implementers can write a node in any language | M | The "anyone in any language" win that makes Path B genuinely federation-shaped. |
| Create `docs/protocol/CHANGELOG.md` and the version-bump discipline | S | Promised in `CATALOG_FEDERATION_PROTOCOL.md:387-390`. |

### Required release infrastructure

- **Container image build & sign in CI.** Probably reuse the
  existing `release.yml` pattern (Tauri release uses signed
  artifacts; same model fits OCI signing via cosign).
- **Container registry choice.** GHCR is the obvious default — the
  desktop release already uses GitHub Releases. Alternative is
  Docker Hub, but GHCR keeps the trust root in the same place.
- **Versioning + deprecation policy.** Already specified in
  `CATALOG_BACKEND_PLAN.md:744-862` ("Versioning & deprecation").
  Discipline, not new code.
- **Release notes per migration.** Required because operators
  upgrading a node will need to know which migrations apply.

### Effort summary (Path B)

| Item | Effort |
|---|---|
| Phase 4 federation implementation | L |
| Cloud-portability layer extraction | L |
| Postgres / S3 / Mux reference adapters | L |
| Auth provider interface + OIDC / bearer adapter | M |
| Portable analytics adapter (or scoped non-goal) | M |
| Container image + compose file + reference deploy | M |
| OpenAPI / JSON Schema generation + publication | M |
| STAC profile mapping | M |
| Conformance test harness | M |
| npm package for the publisher CLI | S |

Total: many person-months. The plan implicitly acknowledges this —
"Cloud-portability layer" is *Phase 6*, after federation, after
auth, after publisher portal. The portable container image is not
an early shippable.

### Minimum viable node config example

What an operator's `terraviz-node.yaml` might look like under Path B.
The shape below is *unverified* — it does not match anything in the
current repo (today's config surface is `.dev.vars`/wrangler bindings,
not a single YAML). I'm sketching what it *should* be if Path B is
serious, derived from `CatalogEnv` (`functions/api/v1/_lib/env.ts`)
+ the federation protocol's well-known doc:

```yaml
# terraviz-node.yaml — operator config for a self-installed node
node:
  display_name: "Mars Climate Center"
  base_url:     https://terraviz.marsclimate.org
  contact:      ops@marsclimate.org
  abuse_contact: abuse@marsclimate.org

# Generated once via `terraviz node init`. Stored as a single
# base64-DER PKCS8 line — the gen-node-key tool already produces
# this shape (scripts/gen-node-key.ts).
identity:
  ed25519_private_key_file: /etc/terraviz/node-private.key

# Storage — concrete adapters chosen per-deployment.
catalog:
  driver:   postgres
  url:      postgres://terraviz@db:5432/catalog
storage:
  driver:   s3
  endpoint: https://minio.internal
  bucket:   terraviz-assets
  access_key_id_file:     /run/secrets/s3_access_key
  secret_access_key_file: /run/secrets/s3_secret_key
video:
  driver:   mux                 # or stream | self-hosted-ffmpeg
  api_token_file: /run/secrets/mux_token
auth:
  driver:   oidc                # or cf-access | bearer
  issuer:   https://sso.marsclimate.org
  audience: terraviz-node

# Federation — fully optional. A node with no peers is just a
# self-hosted catalog.
federation:
  enabled: true
  peers:
    - base_url:  https://sos.noaa.example
      cadence_minutes: 30
      asset_proxy_policy: proxy_lazy
```

That is **31 lines** including blanks and comments — flagging,
per the brief, that 20 was the suggested cap. The drivers
(`catalog.driver`, `storage.driver`, `video.driver`, `auth.driver`)
are what makes it longer than 20. I think those four lines are
load-bearing and I would not collapse them. If a single node is
constrained to one driver per role and the driver is implicit in
the container image, the YAML drops to ~22 lines. Either way, the
shape is **flat, non-nested-deeply, and grep-able**, which is the
property that matters.

---

## 5. Hybrid Options

### Hybrid 1 — Container reference + open protocol spec

**The idea.** Ship the Cloudflare deployment as the canonical
implementation (Path A for first-party + Cloudflare-friendly
partners). Ship the federation protocol as a versioned, conformance-
tested open spec (`/schema/v1/`, `docs/protocol/CHANGELOG.md`,
JSON Schema + OpenAPI). Anyone — partner, third party, future fork —
can implement a node in any language as long as they pass the
conformance suite. We do not commit to building a container image
ourselves; we commit to making it *possible* for someone else to.

**Win.** Decouples "who builds nodes" from "who maintains the
canonical implementation." The hard work is the spec + conformance
suite, both of which are already partially designed in
`CATALOG_FEDERATION_PROTOCOL.md` and `CATALOG_BACKEND_DEVELOPMENT.md`.
Partners with non-Cloudflare constraints can write their own node
without us porting.

**Cost.** A spec is a contract. Once published, breaking it costs
more than today, and the protocol-versioning discipline in
`CATALOG_FEDERATION_PROTOCOL.md:326-399` becomes load-bearing.
Conformance suite has to be maintained. We are explicitly
not promising a container image — partners with no engineering
capacity at all are still left out.

### Hybrid 2 — Publisher decoupling, defer hosting decision

**The idea.** Ship the publisher CLI to npm and as signed binaries
*now* (`@zyra/terraviz-cli`, plus the per-platform standalone
binaries already designed in `CATALOG_PUBLISHING_TOOLS.md:353-389`).
Decouple "publish to a Terraviz catalog" from "host a Terraviz
catalog." A partner agency that just wants their data visible
publishes via the CLI against the canonical
`terraviz.zyra-project.org` node; they don't run a node at all.

**Win.** Solves the most common partner case (a partner agency with
data) without solving federation. Ships in weeks, not quarters.
Tests one piece of the API surface — the publisher API — under
real third-party load before federation. Most partners *will* turn
out to want this, not federation.

**Cost.** Doesn't solve the federation case at all — partners who
do need to run a node, for sovereignty or audience reasons, still
wait for Path B. Centralises moderation responsibility on the Zyra
operator until proper federation lands.

### Hybrid 3 — Fork-the-monorepo + opt-in container reference

A third option to keep on the table: keep Path A as the primary
operator path, but ship a *minimal* containerised version of the
catalog backend (no Stream, no Vectorize — just the `/api/v1/catalog`
read API, federation feed, and well-known doc) as a "lightweight
peer" appliance. Partners who only need to *serve* a small catalog
and *consume* federated data, without running their own publisher
portal or asset pipeline, get a small box. Partners who need the
full thing fork.

This trades scope for shippability. The full Cloudflare deployment
remains canonical; the container is a federation-only peer.

---

## 6. Recommendation

**Adopt Hybrid 2 first, then Hybrid 1, then Hybrid 3 as the
Tier 1 reference implementation; do not adopt Path B as
originally designed.**

> **Refined by §8 resolutions (2026-05-04 interview).** This
> recommendation was originally written before the scoping
> interview as "Hybrid 2 → Hybrid 1, never anything else." §8
> Decision 2 ("both fork and low-burden install paths matter")
> and Decision 3 ("Cloudflare-canonical for full nodes,
> runtime-agnostic for the lightweight peer") together promote
> Hybrid 3 from "third option to keep on the table" to a
> first-class committed deliverable — the Tier 1 read-only peer
> appliance with no Cloudflare dependencies.
>
> **The "do not adopt Path B" line still holds for the original
> Path B shape**: a Zyra-maintained Cloud-portability layer with
> AWS / GCP / Postgres reference adapters. The Tier 1 lightweight
> peer is not that — it is a single small artifact with a narrow
> surface (well-known + feed consumption + read-only catalog API),
> not a full-node alternate-cloud port. The original §6 reasoning
> below is preserved as the historical rationale; the resolved
> sequence is **Hybrid 2 (CLI to npm) → Hybrid 1 (publish protocol
> + conformance with Phase 4) → Hybrid 3 (Tier 1 peer container,
> near-term post-Phase-4)**.

### Why

1. **Federation is not yet code.** Path B as a packaging decision
   ahead of Phase 4 is sequenced wrong. There is no node to
   package.
2. **Most partners are publishers, not operators.** The MISSION
   audience is end-users; the partner audience that the
   `CATALOG_*` plans actually contemplate (NOAA / Zyra pipelines,
   partner research orgs running scheduled visualisation jobs) is
   *publisher-shaped*, not operator-shaped. The CLI already exists
   for this. Shipping the CLI to npm + signed binaries solves the
   partner-on-ramp question for the largest realistic cohort.
3. **The federation protocol design is good enough to publish as a
   spec, but not yet implemented.** The right next step for the
   federation question is to finish Phase 4 against the
   *Cloudflare reference implementation* and **publish the
   protocol with conformance tests**. That is Hybrid 1. Anyone
   who needs to run a non-Cloudflare node can then implement
   against the spec; we don't have to port to Postgres ourselves
   ahead of demand.
4. **Path B-as-designed (Cloud-portability layer + reference
   adapters) is Phase 6 work.** That is honest in the existing
   plan. Promoting it ahead of where it is is many person-months
   for no proven partner request.
5. **Path A is what we have.** Self-hosting a fork on Cloudflare
   already works. Putting effort into making Path A *cleaner*
   (lift hardcoded URLs to env vars, split operator vs contributor
   docs, add a fork-config CI check) is the cheap win that retires
   most of the "fork is awkward" complaints without committing to
   Path B.

### The smallest first step — what could ship in two weeks

1. Pick **one real partner** that wants to publish data to
   Terraviz but does not want to host a node. Internal pilot is
   fine — Zyra-internal pipeline counts.
2. Ship the publisher CLI to npm as `@zyra/terraviz-cli` with
   signed releases per `CATALOG_PUBLISHING_TOOLS.md:328-389`.
   The CLI works against the canonical
   `terraviz.zyra-project.org` node today.
3. Have that partner's pipeline run `terraviz publish dataset.yaml`
   on a schedule. Treat the resulting friction (auth ergonomics,
   schema validation errors, asset upload edge cases) as the
   feature work that gates the next decision.
4. **Decide** whether to invest further in federation (Phase 4)
   or in publisher portal polish (Phase 3) based on what that one
   partner actually asks for next.

This validates "publisher" is the right partner cohort without
committing to anything heavier. If the pilot partner asks for
their own node, that's the federation green light. If they don't,
Path A + the published CLI is the delivery vehicle for years.

---

## 7. How this scoping should shape the Phase 4 implementation

The recommendation above is "Hybrid 2 first, then Hybrid 1, never
Path B-as-designed." The corollary is that **Phase 4 itself should
not be built as a Cloudflare-only feature that we later try to
generalise.** It should be built, on day one, as a *reference
implementation of an open protocol*. Those are different design
briefs. This section captures what the difference looks like at
the code level, so the next engineer to pick up Phase 4 has a
checklist instead of a retrofit.

The cost of working this way is real but bounded: a slightly
slower first PR, a bit more interface plumbing per route, and the
discipline of writing the JSON Schema in the same commit as the
TypeScript. The benefit is that Hybrid 1 ships *as a side-effect*
of finishing Phase 4 — no separate "now go publish the spec" sprint
later — and Path B becomes a question of building adapters against
already-stable interfaces instead of refactoring the whole catalog
backend.

### Directive 1 — Extract the portability interfaces *during* Phase 4, not after

`CATALOG_BACKEND_PLAN.md:2125-2168` parks the cloud-portability
layer at Phase 6. That ordering made sense when Phase 4 was just
a Cloudflare feature; it's the wrong ordering once we accept that
Phase 4 is the protocol implementation. New federation code should
depend on interfaces, not bindings, from the first commit.

| Interface | File (per the existing plan) | What Phase 4 federation code consumes |
|---|---|---|
| `catalogStore` | `functions/api/v1/_lib/catalog/catalogStore.ts` | `listFederatedRows(since, peer_id, visibility_predicate)`, `upsertFederatedRow`, `tombstone(...)` |
| `objectStore` | `functions/api/v1/_lib/storage/objectStore.ts` | `presignGet` for federated asset proxy |
| `authProvider` | `functions/api/v1/_lib/auth/authProvider.ts` | `verifyHmac(signature, body, peer_secret)`, `verifyEd25519(signature, body, peer_pubkey)` |
| `jobQueue` | `functions/api/v1/_lib/queue/jobQueue.ts` | Federation pull jobs, webhook fan-out |

The Cloudflare implementations (`d1.ts`, `r2.ts`, `cf-access.ts`,
`cf-queues.ts`) ship alongside in the same PR, but the route
handler in `functions/api/v1/federation/feed.ts` should never
import a Cloudflare type directly. This is the single biggest
architectural lever — once a federation route mentions
`env.CATALOG_DB.prepare(...)`, the lock-in cost climbs steeply.

The catalog read path (`functions/api/v1/_lib/catalog-store.ts`)
already has an awkward shape: SQL inline, D1-typed, comments
acknowledging the federation predicate will diverge by one line
(`catalog-store.ts:96-109`). Phase 4 is the right moment to lift
that file behind the interface and make `listPublicDatasets` /
`listFederatedRows` two predicates over the same store call.

### Directive 2 — Pin the wire format and protocol publicly *as Phase 4 ships*

The federation protocol is the contract third parties will
implement against. If we write Phase 4 without machine-readable
specs, the spec gets retrofitted from the implementation later —
which means whatever the Cloudflare implementation happened to do
becomes the spec, including the accidents.

In the same PR(s) that land the federation routes:

| Artifact | Where | What it does |
|---|---|---|
| `scripts/build-protocol-schemas.ts` | new | Generates JSON Schema from the `WireDataset`, `FederationFeed`, and `WellKnownDoc` TypeScript types (use `ts-json-schema-generator` or equivalent — no new runtime dep). |
| `docs/protocol/v1/feed.schema.json` | new | Generated, committed, served at a stable URL (`https://terraviz.zyra-project.org/schema/v1/feed.json`). |
| `docs/protocol/v1/well-known.schema.json` | new | Same treatment for `/.well-known/terraviz.json`. |
| `docs/protocol/v1/dataset.schema.json` | new | Same treatment for `WireDataset` (with the STAC profile mapping baked in — see Directive 3). |
| `docs/protocol/CHANGELOG.md` | new | Opens with the Phase 4 entry. Promised at `CATALOG_FEDERATION_PROTOCOL.md:387-390`; create the file with the first entry rather than as a follow-up. |
| `npm run check:protocol-schemas` | new | CI job that regenerates the schemas and fails the build if they drift from the committed copy. Same pattern as `check:privacy-page` (`package.json:21`). |
| Optional: OpenAPI 3.1 spec | `docs/protocol/v1/openapi.yaml` | Generated from the route handlers via `tsoa` or hand-written; less critical than the JSON Schemas but a meaningful win for non-TS implementers. |

The pinning has to happen in the same commit as the route, not as
a follow-up. The discipline this enforces — "if the wire format
changes, the schema regenerates and CI tells me" — is what keeps
the protocol honest as the implementation evolves.

### Directive 3 — Land STAC alignment in the wire serializer, not as a follow-up

> **Superseded 2026-09-04.** The
> [metadata and STAC audit](../metadata/README.md#relationship-to-earlier-decisions)
> replaces this native-wire mechanism with a separate D1-backed STAC Core
> 1.1.0 projection. The text below is retained as decision history and as the
> rationale for avoiding a post-launch federation schema break; it is no
> longer implementation guidance. Current direction is recorded in §8
> decision 5.

`CATALOG_BACKEND_PLAN.md:264-309` commits to the wire `Dataset`
being a valid STAC Item profile. Today
`functions/api/v1/_lib/dataset-serializer.ts` emits none of the
required STAC fields (`grep "stac\|STAC"` returns nothing in that
file). Adding STAC fields to a federation feed *after* third-party
nodes have started consuming it is a schema break; doing it in the
Phase 4 PR is additive.

Concretely, the federation feed serializer needs:

- `type: "Feature"`, `stac_version: "1.0.0"` on every Item
- `bbox`, `geometry` (default to global for full-globe datasets)
- `properties.datetime` from `start_time` (or
  `start_datetime`/`end_datetime` for ranges)
- `assets[]` from existing `data_ref` / `thumbnail_ref` / etc.
- `links[]` with `self`, `parent`, `derived_from` (origin node)
- Terraviz extensions namespaced under `properties.terraviz:*`

The catalog response `/api/v1/catalog` should also be valid STAC
(a Collection with `links[]` pointing to each Item). This is
zero-cost-extra once the per-Item shape is right.

### Directive 4 — Build the conformance harness next to the routes

`CATALOG_BACKEND_DEVELOPMENT.md` references
`npm run test:federation` as a "two-Wrangler-instance handshake
test." That script is not yet in `package.json:9-43`. Phase 4
should ship it.

Concretely:

| File | Purpose |
|---|---|
| `scripts/test-federation.ts` | Spins up two Wrangler instances on different ports, generates two node identities, runs the handshake → feed → tombstone → re-handshake cycle, asserts signature verification. |
| `tests/federation/conformance.test.ts` | The actual assertions. Imported from a future external runner so a third-party node implementer can run the same assertions against their own node. |
| `package.json` script: `test:federation` | Wired alongside `test`. CI runs it on every PR that touches `functions/api/v1/federation/**`. |

Designed this way, the conformance suite is *the same code* a
third-party node implementer downloads to validate their node.
That is what makes Hybrid 1 real rather than aspirational.

### Directive 5 — Ship the publisher CLI to npm before federation merges

The two-week first step in §6 is: publish `@zyra/terraviz-cli` and
let one real partner exercise it. The reason this comes *before*
Phase 4 federation, not as a parallel track, is that the CLI uses
the same publisher API surface (`/api/v1/publish/**`) that
federation will lean on for catalog signing, peer-grant minting,
and audit trails. Real third-party load on the publish API
surfaces the same auth ergonomics, error envelope, and validation
gaps that federation will hit — but in a smaller blast radius and
without a protocol freeze hanging on it.

Concrete sequence:

1. CLI to npm + signed binaries (per
   `CATALOG_PUBLISHING_TOOLS.md:328-389`). One partner pilot.
2. Iterate on whatever the pilot reveals — auth flow, error
   envelope, schema validation, asset-upload edge cases — in the
   publisher API.
3. Begin Phase 4 federation against the now-stabilised publisher
   API and the interfaces from Directive 1.

If the CLI surfaces something architectural (e.g., service-token
ergonomics are unworkable for partners and we need OIDC), it's
much cheaper to fix before Phase 4 commits the federation routes
to the same auth model.

### What this changes about the PR/commit cadence

| Phase 4 PR (per the existing plan) | Phase 4 PR (with these directives) |
|---|---|
| Add federation routes against `env.CATALOG_DB` directly | Add federation routes against `catalogStore` interface; ship `cf-d1.ts` adapter alongside |
| Wire format defined in TypeScript only | Wire format defined in TypeScript *and* JSON Schema, generated in CI |
| STAC profile deferred to a follow-up | STAC profile lands in the Phase 4 serializer |
| Conformance test "to be added later" | `npm run test:federation` ships in the same PR |
| Publisher CLI ships when convenient | Publisher CLI ships *before* Phase 4 begins coding |

The total work isn't dramatically larger. It's reordered, and the
discipline is enforced by CI (schema drift check, conformance test)
rather than by hope.

### What this scoping does *not* tell Phase 4 to do

- Build a Postgres or S3 adapter. The interfaces exist, the
  Cloudflare implementations ship, but a non-Cloudflare adapter
  waits for proven demand. This is not Phase 6 by accident.
- Ship a directory service. The discovery directory described in
  `CATALOG_FEDERATION_PROTOCOL.md:255-294` is explicitly opt-in
  and ecosystem-driven. We don't run one until we have to.
- Solve restricted/private grants. That's Phase 5. Phase 4 ships
  with `visibility='public'` and `'federated'` only.
- Commit to running multiple `/api/v*` major versions. The plan
  reserves the right (`CATALOG_BACKEND_PLAN.md:744-862`); Phase 4
  ships with `/api/v1/` and a clear deprecation policy, nothing
  else.

---

## 8. Resolved planning decisions

Captured during a scoping interview with Eric on 2026-05-04.
Each item replaces the corresponding "open question" the draft
originally listed. Cross-doc updates implied by these decisions
are summarised at the end of the section.

### 1. Who is federation actually for?

**A + B, focus on B.** Federation serves both partner agencies
(NOAA, NASA, university research orgs) publishing their own data
*and* institutional operators (science museums, planetariums,
visitor centers like Amazon's two SOS-equipped sites) hosting
their own nodes. **B is the harder problem and the priority** —
museums and visitor centers typically lack platform engineering,
so the architecture has to make low-burden node hosting realistic.
Cohort A is mostly served by the publisher CLI (Tier 0); cohort B
is served by Tiers 1–3 and is the cohort that justifies the
investment in Tier 1.

### 2. Is "fork the monorepo" still acceptable?

**Both paths matter; we accept the maintenance cost of supporting
both.** Partners with platform-engineering capacity fork the
canonical Cloudflare implementation (Tier 2/3). Partners without
it use the low-burden install (Tier 1, the read-only peer
appliance). This makes Tier 1 a first-class committed deliverable,
not an optional follow-on.

### 3. Cloudflare lock-in tolerance

**Cloudflare-canonical for full nodes; runtime-agnostic for the
lightweight peer.** Zyra's full-node reference implementation is
and stays Cloudflare-only. The Tier 1 read-only peer appliance is
deliberately built without Cloudflare dependencies — small
container, runnable anywhere, in any common stack. Zyra builds
zero non-Cloudflare adapters for full nodes; partners that need
non-Cloudflare full-node deployment write their own implementation
against the published spec (Tier 3). The "must not depend on
Cloudflare" constraint on the Tier 1 appliance is the same
discipline §7 advocates anyway, just enforced by a second build
target rather than by review discipline alone.

### 4. Is the publisher CLI shippable today?

**Pre-launch — no external user yet, still in development.**
Shipping `@zyra/terraviz-cli` to npm and running the first
partner pilot is genuinely first-contact discovery, not polish.
The viability of the Cloudflare Access service-token flow as the
partner-onboarding step is **unanswered until a real partner
tries it**. If service tokens prove to be a bottleneck during
the pilot, alternative auth (OIDC, magic-link signup, bearer
tokens) becomes a Phase 4 prerequisite rather than a future
nice-to-have. Treat the CLI launch as a discovery exercise that
informs subsequent design — not as a delivery milestone with a
known-good shape.

### 5. STAC alignment status

**Revised 2026-09-04 — decoupled from Phase 4.** The
[metadata and STAC audit](../metadata/README.md#relationship-to-earlier-decisions)
supersedes §7 Directive 3's native-wire mechanism. `WireDataset`,
`/api/v1/catalog`, and signed federation feeds remain native; a separate
D1-backed STAC Core 1.1.0 projection publishes Collections and eligible
Items. Because that projection does not change the federation feed, shipping
it later cannot create the peer schema break that the original directive was
designed to prevent.

### 6. Headcount and ETA for Phase 4 federation

**Targeting ~1 quarter out.** This keeps §6's "ship CLI now,
Phase 4 follows naturally, Tier 1 lightweight peer is a near-term
follow-on" sequence valid as written. If Phase 4 slips past two
quarters, the recommendation should be revisited — Tier 1 may
need to be brought forward as the only on-ramp shipping in the
near-to-mid term.

### 7. Directory story

**No Zyra-run directory.** NOAA SOS already serves as the de
facto dataset directory for the SOS-pedigreed subset of cohort A,
which covers most current discovery needs. **Node discovery** —
a separate, narrower question that only matters once cohort B
starts running their own nodes — is deferred at launch:
peer-of-peer browsing handles the first wave. If demand emerges,
a partner consortium (NOAA SOS itself, a museum network, a
university consortium) operates a node directory using the
published directory-format spec; Zyra never runs one. Worth
distinguishing in the doc:

| Type of discovery | Status | Who runs it |
|---|---|---|
| **Dataset discovery** (find a dataset to load) | Solved today | NOAA SOS |
| **Node discovery** (find a peer to subscribe to) | Deferred at launch; partner-consortium-operable post-Phase-4 | Not Zyra |

### 8. Trademark and identity for forks

**Mozilla/Firefox model: free code, restrictive trademark.**
Forks may freely rebrand at any time — Path A polish includes an
`npm run fork:rename` (or `terraviz fork init --name=...`) script
that flips package name, binary name, and desktop bundle ID in
one shot (S effort). Forks that *keep* the "Terraviz" name agree
to a published trademark policy (`docs/TRADEMARK_POLICY.md`,
P1 doc work, drafted by Zyra leadership) with disqualifying
clauses: no hate content, no adult content, no malware
distribution, must retain protocol compatibility, must attribute
upstream. Enforcement is legal/social via the trademark, not
technical via the code. Worst-case scenario (a fork running
disallowed content under the Terraviz name) is handled by a
takedown notice on the *name* use — the code keeps running, just
not under the Terraviz brand.

### 9. Restricted federation: needed before Phase 5?

**Defer.** Phase 4 ships public-only federation
(`visibility='public'` + `'federated'`); restricted and private
visibility wait for Phase 5 as currently planned. If a real
cohort B partner blocks on restricted-sharing during onboarding,
accelerate Phase 5 at that point. We do not pull restricted into
Phase 4 speculatively.

### Cross-doc updates implied by these decisions

The resolutions above tighten the recommendation but also imply
small follow-up edits to other sections of this doc and to
adjacent planning docs. Captured here for the next pass; not yet
applied:

- **§3 Path A — required code changes** gains: `npm run fork:rename`
  script (S). From decision 8.
- **§3 Path A — required documentation changes** gains:
  `docs/TRADEMARK_POLICY.md` (P1, drafted by Zyra leadership, not
  engineering work). From decision 8.
- **§5 Hybrid 3 ("lightweight peer appliance")** gets promoted
  from "third option to keep on the table" to "the committed Tier 1
  reference implementation per resolved decision 3." Build target:
  small container, no Cloudflare deps, well-known + feed
  consumption + read-only catalog API only.
- **`docs/CATALOG_BACKEND_PLAN.md` Phasing table** needs updating
  per §7 Directives 1–4 (portability interfaces in Phase 4, JSON
  Schema + CHANGELOG in Phase 4 exit criteria, conformance suite
  in Phase 4). The Cloud-portability layer section needs reframing
  per Goal 2 (the spec is the portable artifact, not adapters
  Zyra maintains).
- **`ROADMAP.md`** needs a federation row (or an explicit
  "intentionally deferred" note) — currently mentions nothing
  about catalog backend or federation despite Phase 4 being a
  near-term target.
- **`docs/CATALOG_FEDERATION_PROTOCOL.md`** node-discovery section
  should be updated to reflect decision 7 — call out that NOAA SOS
  is the dataset-directory equivalent today, distinguish from
  node directories, drop the "we might run a directory" framing.

These edits should ride on a follow-up PR rather than this one.
This doc is the *scoping* artifact; the catalog plan updates are
the *operational* changes that flow from it.

---

## Appendix — Evidence Index

Files cited or read for this scoping:

- `package.json` — distribution manifest, scripts, deps
- `wrangler.toml` — Cloudflare bindings (documentation only)
- `Dockerfile`, `docker-compose.yml` — dev-environment image, not runtime
- `bin/terraviz.cjs`, `cli/terraviz.ts`, `cli/commands.ts`, `cli/lib/*` — publisher CLI
- `functions/.well-known/terraviz.json.ts` — federation discovery (only fed code that exists)
- `functions/api/v1/catalog.ts`, `functions/api/v1/_lib/env.ts`, `_lib/dataset-serializer.ts`, `_lib/catalog-store.ts` — catalog read API
- `functions/api/v1/datasets/[id]/manifest.ts` — manifest endpoint, hardcodes Phase 4 deferrals
- `functions/api/v1/publish/**` — publisher API
- `migrations/catalog/0001_init.sql`–`0008_legacy_id.sql`, `schema/catalog-schema.sql` — schema as actually applied
- `scripts/gen-node-key.ts`, `scripts/seed-catalog.ts` — node setup tooling
- `src/services/dataService.ts:12`, `hlsService.ts:27`, `downloadService.ts:13`, `photorealEarth.ts:90` — hardcoded URL surfaces
- `src/services/catalogSource.ts` — `VITE_CATALOG_SOURCE` switch
- `.env.example`, `.dev.vars.example` — current operator config surface
- `docs/CATALOG_BACKEND_PLAN.md` (2965 lines), `CATALOG_FEDERATION_PROTOCOL.md` (399), `CATALOG_DATA_MODEL.md` (682), `CATALOG_ASSETS_PIPELINE.md` (882), `CATALOG_PUBLISHING_TOOLS.md` (682), `CATALOG_BACKEND_DEVELOPMENT.md` (1199)
- `docs/SELF_HOSTING.md` (411 lines) — current operator path
- `MISSION.md`, `ROADMAP.md`, `AGENTS.md`, `CLAUDE.md`
- `.github/workflows/ci.yml`, `release.yml` — CI/CD (no container build step exists)
