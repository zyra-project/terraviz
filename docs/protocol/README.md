# Terraviz Protocol Schemas

Machine-readable JSON Schema for the **public wire contract** — the
shapes a non-TypeScript consumer needs to read a Terraviz node
without reading the TypeScript source. This is
[`architecture/federation-scoping.md`](../architecture/federation-scoping.md)
§7 Directive 2 ("pin the wire format publicly") and Phase 0 of
[`WORDPRESS_INTEGRATION_PLAN.md`](../WORDPRESS_INTEGRATION_PLAN.md)
— the WordPress plugin's PHP server-side blocks generate their types
from these instead of hand-rolling them and drifting.

## Where they live and how they're served

The generated schemas are committed under **`public/schema/v1/`**, so
Cloudflare Pages serves them at the stable URL:

```
https://terraviz.zyra-project.org/schema/v1/<file>
```

Committing a generated, served artifact and guarding it with a
drift-check is the same idiom this repo already uses for
`public/privacy.html` (`check:privacy-page`). The canonical location
for **all** protocol schemas, the federation feed's included, is
`public/schema/v1/`.

## The schemas (v1)

| File | Describes | API surface |
|---|---|---|
| [`dataset.schema.json`](../../public/schema/v1/dataset.schema.json) | `WireDataset` — one catalog dataset | `GET /api/v1/datasets/:id`, and each entry of the catalog list |
| [`catalog.schema.json`](../../public/schema/v1/catalog.schema.json) | `CatalogResponseBody` — the catalog envelope | `GET /api/v1/catalog` |
| [`well-known.schema.json`](../../public/schema/v1/well-known.schema.json) | `WellKnownDoc` — node discovery document | `/.well-known/terraviz.json` |
| [`feed.schema.json`](../../public/schema/v1/feed.schema.json) | `FederationFeedBody` — one signed page of the federation feed | `GET /api/v1/federation/feed` |

`catalog.schema.json` and `feed.schema.json` each self-contain the
dataset shape (each `datasets[]` item is the full `WireDataset`
inlined), so every file is independently usable — a consumer needs
only the one it validates against, no cross-file `$ref` resolution.

## How they're generated

Generated from the authoritative TypeScript interfaces by
[`scripts/build-protocol-schemas.ts`](../../scripts/build-protocol-schemas.ts)
(via the `ts-json-schema-generator` **devDependency** — build-time
only, nothing new ships to the runtime):

```bash
npm run gen:protocol-schemas     # regenerate + commit the JSON
npm run check:protocol-schemas   # CI drift guard (in the type-check chain)
```

`check:protocol-schemas` runs in the `type-check` chain and fails if
the committed schemas drift from the types — so the wire format and
its published contract can never silently diverge. If you change
`WireDataset`, `CatalogResponseBody`, `WellKnownDoc`, or
`FederationFeedBody`, regenerate and commit in the same change (and
add a CHANGELOG entry).

**Forks / non-canonical nodes:** each schema's `$id` base defaults to
the canonical origin (`https://terraviz.zyra-project.org/schema/v1`),
which is what the committed files carry. A fork, staging, or partner
node that serves these from its own origin can regenerate with a
matching `$id` by setting the base:

```bash
SCHEMA_BASE_URL=https://terraviz.example.org/schema/v1 npm run gen:protocol-schemas
```

## Design choices

- **`additionalProperties` is left open (defaults to `true`).** The
  wire format evolves **additively** — a consumer validating a
  response against v1 must not reject a payload that carries a newer,
  unknown field. Strict `additionalProperties: false` would make
  every additive field a breaking change for existing consumers.
- **No prose descriptions in the schema (`jsDoc: 'none'`).** The
  schema is the machine contract — field names, types, required-ness.
  Field *semantics* live in
  [`CATALOG_DATA_MODEL.md`](../CATALOG_DATA_MODEL.md); keeping them out
  of the JSON keeps the artifact small and stable (a comment edit
  doesn't churn the contract).
- **Deterministic output (`sortProps`)** so the drift diff is stable.
  That orders the *schema's* properties, not the wire's.
- **Key order, whitespace and byte offsets on the wire are not part of
  the contract.** A consumer parses the JSON; a producer that orders
  keys differently is conformant. Promising an order would make every
  new field a contract decision for every producer. Three LSL scripts
  in Second Life are **not conformant readers**, and are supported only
  against a node running this codebase's serializer: they can afford
  only the start of a record, so they read by position. The probe
  kit's globe script reads `id`, `slug`, `title` and `format` from the
  first 1,024 bytes (2,048 in its earliest copies, as in the exhibit's
  globe script's, which no longer reads at all). Copies of the exhibit's
  info script from before it read the exhibit's card (below) read
  twelve text and time fields from before `createdAt`, within the first
  9,000 bytes in the earliest copies and 3,072 in later ones, and a
  video manifest's `duration` and, in all but the earliest, its `id`,
  trusting the duration only when that id is the dataset's, which a
  Vimeo row's manifest replaces with Vimeo's. Those reads are of the
  manifest's first 1,024 to 4,096 bytes. Pointed at a node that orders
  keys differently, they can miss fields. They read under `/api/v1/`,
  so they will meet that prefix's 410 one day whatever is pinned.
  [`dataset-serializer.test.ts`](../../functions/api/v1/_lib/dataset-serializer.test.ts)
  and
  [`exhibit.test.ts`](../../scripts/second-life-exhibit/exhibit.test.ts)
  pin the record's order, and
  [`manifest.test.ts`](../../functions/api/v1/datasets/[id]/manifest.test.ts)
  the manifest's leading keys and a Vimeo manifest's own id, so a
  reorder fails a test rather than a globe. Copies once rezzed can't be updated remotely, so these pins
  stay while old copies may still read this way.
- **The exhibit reads are where an LSL script should read instead:**
  `GET /api/exhibit/v1/datasets/{id}`, `GET /api/exhibit/v1/datasets`
  and `GET /api/exhibit/v1/tags`, small replies within byte budgets
  they state, with their own contract for scripts already rezzed:
  additive only, no field changes meaning, a breaking change gets a
  new path, `/api/exhibit/v2/`, and `/api/exhibit/v1/` stays. Their
  version is their own, outside
  `/api/v1/`, so the 410 this protocol's `/api/v1/` answers once a
  later major version has run its window never reaches a script that
  can't be updated ([`exhibit-reads.ts`](../../functions/api/v1/_lib/exhibit-reads.ts),
  [`SECOND_LIFE_COMPAT.md`](../SECOND_LIFE_COMPAT.md) §9 Phase 2). They
  are convenience reads of nodes running this codebase from October
  2026 on, not part of the federation protocol, and not in
  `public/schema/v1/`. A node without them answers their paths with
  the app's page and a 200, which a script has to tell from a reply.

## Versioning

- **`v1`** is the current major. The path (`/schema/v1/`) and each
  `$id` carry the version.
- **Additive changes** (new optional field, new enum value) ship
  under `v1` without a path bump; note them in
  [`CHANGELOG.md`](CHANGELOG.md).
- **Breaking changes** (rename/remove a field, change a type or an
  existing value's meaning) mint `/schema/v2/` and a CHANGELOG entry
  with a migration note.

## The federation feed

`GET /api/v1/federation/feed` serves a node's **public** catalog to
other nodes, one page at a time. The schema pins the body; the rest of
the contract is here, because a schema cannot carry it.

- **Off unless the node turns it on.** The route answers 404
  `{"error":"not_found"}` unless `FEDERATION_ENABLED` is exactly
  `true`, so a node that never opted in looks like one that predates
  the route.
- **Open, and signed.** Anyone may read it; there is no handshake.
  Every 200 carries a detached Ed25519 signature in
  `Terraviz-Signature: v=1, keyid=<node_id>, created=<unix seconds>,
  sig=<base64url>`. The body is RFC 8785 canonical JSON, and the
  signature covers a domain string, `keyid`, `created`, the request
  target (path and query, exactly as sent) and the SHA-256 of the
  body, so a page cannot be replayed as the answer to another cursor.
  A reader verifies against the `public_key` in the node's
  `/.well-known/terraviz.json`, pinned at subscription, and rejects a
  signature older than five minutes or more than a minute ahead.
  [`federation-signature.ts`](../../functions/api/v1/_lib/federation-signature.ts)
  is the reference.
- **Paged by an opaque cursor.** `?since=<cursor>` resumes after the
  last page; `?limit=` takes 1 to 250 (default 100). Any other
  parameter, a repeated one, a malformed cursor or an out-of-range
  limit is a 400, because the target is signed and two spellings of
  one request would be two signatures. A reader stores `cursor` and
  sends it back unchanged; its encoding is not part of the contract.
- **Settled, not live.** A page holds rows changed up to
  `generated_at`, which trails the clock by 30 seconds so a row
  written as the page is read cannot slip behind the cursor. Keep
  asking while `has_more` is true; after that, ask again later with
  the last cursor.
- **Tombstones are ids only.** A public row that is hidden or retracted
  arrives as its id in `tombstones[]`, and a reader drops its copy.
  Rows that were never public do not appear at all. A row deleted
  outright, or moved from public to another visibility, leaves no
  trace in the feed, so a reader should resync from an empty cursor
  periodically (daily is plenty) and drop what that pass no longer
  lists.
- **Errors** are `{error, message?}` with `Cache-Control: no-store`:
  400 `unknown_parameter` / `duplicate_parameter` / `invalid_cursor` /
  `invalid_limit`, and 503 `binding_missing` / `identity_missing` /
  `signing_key_unavailable` for a node not yet set up to sign.

## Deferred

- **The federation handshake** (peer registration, shared secrets,
  request signing by the subscriber). The open signed feed above needs
  none of it, and inventing it before a second operator asks would
  bake in accidents — what Directive 2 warns against.
- **STAC projection.** The repository-grounded
  [metadata and STAC audit](../metadata/README.md) supersedes Directive 3's
  earlier native-wire plan. `WireDataset`, `/api/v1/catalog`, signed
  federation feeds, and their `schema/v1` contracts remain native. Separate
  STAC 1.1.0 routes and schemas project eligible D1 records as explicit
  Collections and Items, so `dataset.schema.json` does not gain STAC fields.

## See also

- [`CATALOG_DATA_MODEL.md`](../CATALOG_DATA_MODEL.md) — field semantics for the dataset shape
- [`EMBED_URL_GRAMMAR.md`](../EMBED_URL_GRAMMAR.md) — the sibling contract (URL grammar) the embed blocks consume
- [`architecture/federation-scoping.md`](../architecture/federation-scoping.md) §7 — the directives this implements
- [`WORDPRESS_INTEGRATION_PLAN.md`](../WORDPRESS_INTEGRATION_PLAN.md) §7 — the plugin consumer
