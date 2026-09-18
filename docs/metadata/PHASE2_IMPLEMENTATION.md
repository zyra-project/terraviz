# Phase 2: Browsable Core Resources

**Status:** Implementation in progress; deployment opt-in required
**Last reviewed:** 2026-09-18
**Revisit when:** Public profile snapshots, custom registry storage or immutable history ships.

## Rollout

1. Apply migrations through 0054. Keep `STAC_ENABLED` unset while deploying.
2. Review, replace or clear `node_identity.description` using the
   [existing-node instructions](../SELF_HOSTING.md#91-existing-nodes-review-descriptions-before-stac-publication).
   Enabling this release makes that description public. No per-profile approval
   is necessary, and no private mission/about/audit fields are read.
3. Deploy and verify `https://terraviz.zyra-project.org/schema/stac/terraviz/v1.0.0/schema.json`
   against the reviewed local schema. The versioned schema route is independent
   of the opt-in. A fork must retain the upstream schema identity and wait for
   that URI to be live; do not silently rewrite its meaning or URI.
4. Set `STAC_ENABLED=true` only after these prerequisites. HTTP `Link` discovery
   on the well-known response is enabled together with the resource routes.
   The well-known JSON and native protocol schemas remain unchanged.
5. Verify the root, traverse its links and audit asset reachability before
   announcing the surface to external consumers. Unset the flag to disable it.

## Routes

All paths are under `/api/v1/stac`: the root Catalog, `/collections`,
`/collections/:id`, `/collections/:id/items`,
`/collections/:id/items/:itemId`, `/items`, and `/items/:id`.
The standalone Item routes are necessary for truthful unknown-geometry Items.
Lists accept `limit` (1-100, default 50) and `cursor` (last emitted ID).
Malformed or unknown query parameters are rejected, including search filters;
no `/search`, `/conformance` or API conformance declarations are offered.

Canonical absolute URLs come from the stored node base URL, never the request
Host header. Collections/Catalogs use `application/json`; Items and
FeatureCollections use `application/geo+json`. Conditional GET supports weak
and comma-separated validators. Errors are `no-store`.

## Cache And Mapping

STAC uses `stac:publication:v1:<input-hash>` KV keys, separate from native
snapshots. Fresh D1 state is required on every request before any KV reuse;
HTTP responses require revalidation, never stale-while-revalidate. KV outages
are cache misses. Input hashing includes identity, all dataset inputs, public
branding and public R2 configuration. Old keys expire after five minutes and
are unreachable after an input change, even if KV deletion is delayed. This
trades D1 reads for immediate access/branding invalidation; it does not claim
the native catalog's KV-only hot-path performance.

The initial resolver supports durable direct URLs and configured public R2
assets. Unsupported/unresolved delivery schemes are withheld rather than
replaced with a playback-manifest JSON URL mislabeled as media. The native
playback manifest is a separate metadata Asset. Origin links are not guessed.
Sequences and recurring outputs remain withheld until Phase 3 persists their
immutable identities. Richer profile/extension/vocabulary mappings stay
disabled until their storage, permissions and publication tests exist.