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
for **all** protocol schemas — including the federation feed schema
when Phase 4 adds it — is `public/schema/v1/`.

## The schemas (v1)

| File | Describes | API surface |
|---|---|---|
| [`dataset.schema.json`](../../public/schema/v1/dataset.schema.json) | `WireDataset` — one catalog dataset | `GET /api/v1/datasets/:id`, and each entry of the catalog list |
| [`catalog.schema.json`](../../public/schema/v1/catalog.schema.json) | `CatalogResponseBody` — the catalog envelope | `GET /api/v1/catalog` |
| [`well-known.schema.json`](../../public/schema/v1/well-known.schema.json) | `WellKnownDoc` — node discovery document | `/.well-known/terraviz.json` |

`catalog.schema.json` self-contains the dataset shape (each
`datasets[]` item is the full `WireDataset` inlined), so every file is
independently usable — a consumer needs only the one it validates
against, no cross-file `$ref` resolution.

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
`WireDataset`, `CatalogResponseBody`, or `WellKnownDoc`, regenerate
and commit in the same change (and add a CHANGELOG entry).

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

## Versioning

- **`v1`** is the current major. The path (`/schema/v1/`) and each
  `$id` carry the version.
- **Additive changes** (new optional field, new enum value) ship
  under `v1` without a path bump; note them in
  [`CHANGELOG.md`](CHANGELOG.md).
- **Breaking changes** (rename/remove a field, change a type or an
  existing value's meaning) mint `/schema/v2/` and a CHANGELOG entry
  with a migration note.

## Deferred to Phase 4 (federation)

- **`feed.schema.json`** — the federation feed shape. Its serializer
  **does not exist yet** (there is no `functions/api/v1/federation/`).
  Pinning it now would invent a shape and bake in accidents — exactly
  what Directive 2 warns against. It joins this directory in the same
  PR that lands the federation feed routes (federation-scoping.md §7
  Directive 2).
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
