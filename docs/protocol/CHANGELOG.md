# Protocol Schema Changelog

Versioned history of the public wire-contract schemas under
`public/schema/v1/` (served at `https://<node>/schema/v1/`). See
[`README.md`](README.md) for what these are and the versioning
policy. Promised at
[`CATALOG_FEDERATION_PROTOCOL.md`](../CATALOG_FEDERATION_PROTOCOL.md)
and federation-scoping.md §7 Directive 2.

Additive changes (new optional field, new enum value) stay under the
current major and get an entry here. Breaking changes mint a new
major (`/schema/v2/`) and an entry with a migration note.

## v1 (additive) — 2026-10-27

- **`feed.schema.json`** — `FederationFeedBody`
  (`functions/api/v1/_lib/federation-feed.ts`). One page of
  `GET /api/v1/federation/feed`: `schema_version`, `node_id`,
  `generated_at`, `cursor`, `has_more`, `datasets[]` (each the full
  `WireDataset`, inlined) and `tombstones[]` (ids). New file; no
  existing schema changes. The route is off unless the node sets
  `FEDERATION_ENABLED=true`, and every page is signed in the
  `Terraviz-Signature` header. The signature, cursor and tombstone
  rules are in [`README.md`](README.md) §The federation feed.

## v1 — 2026-07-04

Initial published contract. Pins the wire shapes that exist today,
generated from the authoritative TypeScript interfaces:

- **`dataset.schema.json`** — `WireDataset`
  (`functions/api/v1/_lib/dataset-serializer.ts`). The per-dataset
  shape served by `GET /api/v1/datasets/:id` and carried in each
  entry of the catalog list.
- **`catalog.schema.json`** — `CatalogResponseBody`
  (`functions/api/v1/catalog.ts`). The `GET /api/v1/catalog`
  envelope (`schema_version`, `generated_at`, `etag`, `cursor`,
  `datasets[]`, `tombstones[]`), self-containing the inlined dataset
  shape.
- **`well-known.schema.json`** — `WellKnownDoc`
  (`functions/.well-known/terraviz.json.ts`). The node discovery
  document at `/.well-known/terraviz.json`.

Notes:

- `additionalProperties` is left open so the contract is
  forward-compatible with additive field growth.
- **Deferred:** the federation `feed.schema.json` — its serializer
  does not exist yet (Phase 4). STAC Core 1.1.0 uses the separate
  routes and schemas defined by the
  [metadata and STAC audit](../metadata/README.md); it does not add
  fields to the native dataset or federation-feed shapes.
