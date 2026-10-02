# Phase 4: STAC API 1.0.0

Status: implementation and fixture-backed external validation; deployment
verification remains an operator responsibility.

## Step 1: Core and Features

The opt-in `/api/v1/stac` service preserves Phase 2/3 public eligibility,
fresh primary-backed reads, asset verification, and immutable frame/revision
identities. Collection Item lists accept inclusive WGS84 `bbox` and RFC3339
`datetime` predicates. Bounding boxes support four or six coordinates,
antimeridian crossings, and degenerate query boxes. Two-dimensional Items
have elevation zero for three-dimensional queries. Limits default to 50,
clamp to 100, and cannot be zero or negative. Next links retain the filters.

HTTP supports GET and HEAD, content negotiation, ETags, and read-only method
gates. An Item accessed through a collection has a self link to that route.
Public error bodies retain the existing `{ "error": "code" }` contract.

## Step 2: Service Resources

The landing page and `/conformance` expose the same conformance list.
`service-desc` points to `/api` (OpenAPI 3.0.3 JSON with the OpenAPI media
type); `service-doc` points to `/api.html`. No optional search extensions
(Filter, Query, Sort, Fields, Context, or Transaction) are advertised.
The OpenAPI document describes the service, but `oas30` is not advertised:
there has not been an independent OGC OpenAPI requirements-class run.

## Step 3: Indexed Item Search

GET and JSON POST `/search` support `bbox`, `datetime`, `intersects`, `ids`,
`collections`, `limit`, and the opaque `cursor` from next links. POST next
links contain their method and complete body. All GeoJSON geometry types are
supported, including bounded nested GeometryCollections; Turf evaluates
intersection against the published geometry. Bbox and intersects together
are rejected. Queries are bounded to 100 IDs/collections, a 64 KiB geometry,
and a 128 KiB POST body.

Migration 0057 adds geometry and normalized datetime indexes to current
datasets and immutable history. Search is read-only: primary-backed SQL
selects candidates, then intersects them with fresh verified publication
Items. An index row is never publication authorization. Hidden, private,
retracted, unverified, and stale history remain excluded. The indexes do
not eliminate the existing full publication build or its asset-probe budget;
this is not a claim of unbounded-catalog scalability.

Apply migration 0057 before deploying this worker. There is no new feature
flag beyond `STAC_ENABLED=true`; frame capture remains separately opt-in.

## Step 4: External Conformance

The pinned official `stac-api-validator==0.6.8` passed Core, Collections,
Features and Item Search with pagination enabled against the actual HTTP
handler and a freshly migrated SQLite fixture (120 immutable frame Items
plus a separate current Item). The final report is `Errors: none`.
Asset HEAD responses are controlled fixture responses, not production
origin verification. Schema validation fetches official STAC 1.1.0 and
extension schemas. This is STAC API 1.0.0 over STAC resource 1.1.0.

Warnings remain recommendations only: collection summaries, link titles,
large static Item link arrays and lowercase identifier style. Immutable
identifiers are not rewritten to silence stylistic recommendations.
The OGC Core and GeoJSON declarations are the requirements inherited by
the STAC Features implementation. A separate OGC TEAM Engine certification
run has not been performed; the STAC suite covers a subset of OGC behavior.

Run the opt-in test with `STAC_EXTERNAL=true` and:

```text
npm run test -- functions/api/v1/stac/external.test.ts
```

`uv` is required and supplies an isolated pinned validator environment.
The test waits on a bound ephemeral HTTP socket, enables UTF-8 Python
output on Windows, and closes the socket in all outcomes. The
`STAC API Conformance` workflow runs the same test on relevant PRs.

## Step 5: Client Interoperability

Fixture-backed executable results:

| Client | Check | Result |
| --- | --- | --- |
| PySTAC Client 0.9.0 | Collection discovery, GET/POST paging at 17 Items/page, exact datetime filter | Passed locally, 120 unique matching Items |
| STAC Browser 5.1.0 | Real built browser in Chromium; root, collection and Item navigation with successful HTTP responses, no page errors | Passed locally; Item screenshot retained by CI |
| STAC-GeoParquet 0.8.2 | Independent requests-based next-link traversal at 19 Items/page, index ingestion, Parquet round-trip | Passed locally; all 120 IDs and geometries retained |
| QGIS 3.34.4-Prizren OAPIF provider | Real offscreen PyQGIS layer, all 120 features, geographic CRS and nonempty geometry | Passed in Linux CI; not installed on the local Windows host |

Run `functions/api/v1/stac/clients.test.ts` with `STAC_CLIENTS=true`.
`STAC_BROWSER_DIST` must point to a separately built STAC Browser 5.1.0
distribution (`SB_historyMode=hash npm run build` in its checkout).
Set `STAC_QGIS_PYTHON` to the Python executable that can import `qgis.core`
to include the QGIS test. Missing tools are explicit skips in normal unit
tests, not claimed passes. The dedicated CI job sets all three variables.
These tools are test-only and do not enter the application's dependencies.

STAC-GeoParquet is an independent bulk indexing path, not a hosted registry
submission. No production node was submitted to a third-party service.
Fixture-backed success is not a substitute for checking the deployed
node's actual catalog, anonymous assets, CORS and canonical origin.