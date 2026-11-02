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

## v1 (additive, plus one behaviour change) — 2026-10-27

- **Review corrections:** signed feeds authenticate received bytes
  before parsing and require canonical-byte equality; the README pins
  the statement, target normalization, version rules and independent
  UTF-8/float vector. Hidden ids are not emitted. Discovery readiness
  includes usable matching keys. Native STAC links are source-metadata
  `via` links, with the dataset schema profile, not alternates.
- **`feed.schema.json`** gains optional `held`: the ids of public,
  non-hidden rows on a page that the node could not serialize. A page
  with none omits it, so its signed bytes are unchanged. A reader that
  ignores it sees those rows as missing, and a full sync's sweep could
  then drop them. The README says how a subscriber keeps held rows and
  guards its sweep, and when a repaired row reaches it: only if the
  repair moves the row's `updated_at`, or at the next full sync. This
  is additive, not a change to withdrawal semantics: a tombstone, and a
  row's absence from a full sync, mean what they meant, and no
  withdrawn row can be held. Rows a reader once lost silently are now
  named; ignoring `held` gives the old outcome.
- **Reference subscriber, no wire change:** the sweep guard judges the
  counts a full sync finished with as well as those when its sweep comes
  due. A refused sweep is latched until a new full sync completes and
  replaces it. Until then it runs only when an admin accepts it, by its
  `sweep_id`, through `POST /api/v1/publish/federation/sync`
  (§Subscriber Operations), or once it would delete nothing. Peer
  operators who script that route should stop on `sweep_refused`
  rather than retry.
- **Subscriber guidance, no wire change:** README §Showing Mirrored
  Rows. A peer's `weight` must not rank its rows against another
  node's. A peer's text is untrusted input, and media is outside the
  signature. Removing a peer removes its rows.
- **`dataset.schema.json`, `catalog.schema.json`, `feed.schema.json`:**
  optional `enriched.datasetDevelopers` and `visDevelopers` arrays
  preserve every producer credit. They list producers by name, in
  byte order (case-sensitive, so `Zeta` sorts before `alpha`, and
  accented names after unaccented ones): the catalog stores no credit
  order. Singular fields keep their legacy value, the last producer in
  that order, for existing readers. Older readers ignore the arrays;
  this is additive, not a new identity or signature version. The order
  is now set by the query rather than left to the database's plan, so
  a node whose database returned another order before sees producers,
  and its catalog ETag, change once.
- **Behaviour change, not additive:** top-level `probingInfo` is now
  omitted when it holds a non-finite number or nests deeper than 60
  levels, on `/api/v1/catalog` and `/api/v1/datasets/:id` as on the
  feed. Those two used to render a non-finite number as `null` inside
  an otherwise intact object, and to serve deep nesting as stored. The
  field was already optional, so a reader that handles its absence is
  unaffected.
- **After deploying the serializer changes above:** they do not
  restamp existing rows. A subscriber needs a one-time full resync to
  receive previously stored producer credits and the new `probingInfo`
  rule without waiting for another dataset edit. And the no-cursor
  `/api/v1/catalog` keeps serving its cached KV snapshot
  (`catalog:snapshot:v1`) until the next publisher write, so either
  make one or delete that key after deploying.

- **`feed.schema.json`** — `FederationFeedBody`
  (`functions/api/v1/_lib/federation-feed.ts`). One page of
  `GET /api/v1/federation/feed`: `schema_version`, `node_id`,
  `generated_at`, `cursor`, `has_more`, `datasets[]` (each the full
  `WireDataset`, inlined) and `tombstones[]` (ids). New file; no
  existing schema changes. The route is off unless the node sets
  `FEDERATION_ENABLED=true`, and every page is signed in the
  `Terraviz-Signature` header. The signature, cursor and tombstone
  rules are in [`README.md`](README.md) §The federation feed.
- **`well-known.schema.json`** gains two optional fields:
  `abuse_contact` (string or null — the node's
  `FEDERATION_ABUSE_CONTACT`, null when unset or unusable) and
  `federation` (`{feed: boolean}` — true only when the feed answers
  200). A reader that ignores them is unaffected; a document without
  `federation` means no feed. The feed refuses to go live without an
  abuse contact (503 `abuse_contact_missing`).

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
