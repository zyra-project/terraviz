# Phase 2: Browsable Core Resources

**Status:** Implemented; deployment opt-in required
**Last reviewed:** 2026-09-18
**Revisit when:** Public profile snapshots, custom registry storage or immutable history ships.

| Step | Implementation |
|---|---|
| 1 | Opt-in core routes, independent content-addressed KV/ETags, public schema and notices |
| 2 | Atomic primary-backed public read, strict readiness and bounded asset verification |
| 3 | Authenticated no-store operator report including excluded non-public rows |
| 4 | Persisted-row route/schema, pagination, media and cache invalidation regressions |
| 5 | Offline CI traversal tests and opt-in scheduled live reachability audit |

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
   Set `STAC_ASSET_ORIGINS` to a comma-separated list of trusted exact HTTPS
   origins for direct assets, license text and branding. The configured public
   R2 origin is also trusted. Only name public hosts you control or explicitly
   trust; this is an outbound-network allowlist, not a client-supplied filter.
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

The public snapshot is one transactional D1 batch in a `first-primary` session,
including identity, all decorations/media, workflow ownership and public
branding. It uses the exact native public/published/not-hidden/not-retracted
predicate. A write committed before that batch is visible immediately; a write
concurrent with it is reflected on the next revalidation. This is snapshot
consistency, not an impossible promise to revoke bytes already in flight.

On a cache miss assets must pass anonymous HEAD with a real Content-Type.
Only explicit HTTPS origins are probed, with no redirects or cookies, a
three-second per-request timeout, a fifteen-second build deadline and a maximum of 40 distinct URL probes per
snapshot build. Unverified assets (including budget overflow and HEAD-unsupported
servers) are withheld, not advertised speculatively. Verification is retained
with the five-minute snapshot; later external outages are caught by the audit
or the next rebuild, not treated as a permanent availability guarantee. Large
catalogs needing more probes require a separately reviewed persisted verification
worker; this release deliberately fails closed at its bounded request budget.

The initial resolver supports durable direct URLs and configured public R2
assets. Unsupported/unresolved delivery schemes are withheld rather than
replaced with a playback-manifest JSON URL mislabeled as media. The native
playback manifest is a separate metadata Asset. Origin links are not guessed.
Sequences and recurring outputs remain withheld until Phase 3 persists their
immutable identities. Richer profile/extension/vocabulary mappings stay
disabled until their storage, permissions and publication tests exist.

## Operator Report

`GET /api/v1/publish/stac-report` uses the existing Cloudflare Access publisher
middleware and additionally requires an active admin or service operator. It
works with public STAC disabled, so remediation can precede opt-in. The response
is versioned JSON: `schema_version`, `publication_enabled`, `totals` and sorted
`records` with immutable `id`, `included` and machine-readable `reasons`.
Non-public rows receive `not_public`; their assets are never probed. Scientific
readiness reasons are preserved. Unresolved primary assets also carry concrete
verification reasons such as `asset_origin_untrusted`, `asset_http_403`,
`asset_probe_failed` or `asset_probe_budget_exceeded`.

This endpoint is always `private, no-store`, never reads or writes the public
KV snapshot, and does not return private titles, source URLs, draft prose or
review identities. It evaluates current state rather than claiming that every
excluded row can be automatically repaired.

## Regression Coverage

Route tests compose persisted valid ULIDs, migrated SQLite, the atomic D1
adapter, asset verification, builders and HTTP responses. They cover media
types, canonical absolute links, standalone resources, bounded pagination,
collection membership, unsupported API paths, weak/list/wildcard conditional
GET, node-description changes, logo replacement/removal, private draft
non-dependencies, dataset/decorations/renditions/delivery changes, deployment
R2 changes, visibility withdrawal with warm KV, and KV/D1 failure behavior.
The pinned official core and extension validator also validates actual HTTP
output, not only hand-built projection fixtures. Richer mapping invalidation
tests remain deferred together with those disabled mappings.

## Reachability Audit

Run `npm run audit:stac` with `STAC_AUDIT_ROOT` set to the enabled HTTPS root.
Set `STAC_AUDIT_ORIGINS` to comma-separated trusted asset and contextual-link
origins. The root origin and the project/adopted-extension schema origins are
included automatically. No credentials are read or forwarded. These variables
are operator configuration, never copied from an untrusted dataset.

The audit traverses same-root resource and pagination links, checks declared
media types and self links, fetches declared schemas and verifies their IDs,
compares the Terraviz schema with the reviewed local document, and performs
anonymous HEAD checks for Assets and supporting links. Redirects are failures,
not silently followed. Requests have a ten-second deadline; JSON is bounded to
2 MiB; traversal is capped at 1000 documents, 1000 assets and 32 schemas.
Exhausting a cap is a failed audit, not a successful truncated report. Output
is machine-readable JSON and any issue exits nonzero. This is a core-resource
health audit, not an STAC API conformance test or proof of scientific accuracy.

The normal CI Vitest suite runs `scripts/audit-stac.test.ts` against real local
route handlers and controlled failures, without network dependence. The
`STAC Resource Audit` workflow also supports weekly/manual live runs. Configure
repository variables `STAC_AUDIT_ROOT` and `STAC_AUDIT_ORIGINS` only after
publication is enabled. Without a root it is explicitly skipped. Each run
retains its JSON report for 30 days; a failed audit is a failing Actions job.
No deployment flag, repository variable or production data is changed by this
implementation PR. The first live audit remains an operator rollout task.