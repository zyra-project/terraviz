# Phase 4: STAC API 1.0.0

**Status:** Implemented and fixture-validated; deployment verification pending
**Last reviewed:** 2026-10-06
**Revisit when:** Workers CPU/D1 quotas, catalog/history size, geometry limits, asset/origin policy, client versions, or publication retention changes.

## Step 1: Core and Features

The opt-in `/api/v1/stac` service preserves Phase 2/3 public eligibility,
fresh primary-backed reads, asset verification, and immutable frame/revision
identities. Collection Item lists accept inclusive WGS84 `bbox` and RFC3339
`datetime` predicates. Bounding boxes support four or six coordinates,
antimeridian crossings, and degenerate query boxes. Two-dimensional Items
have elevation zero for three-dimensional queries. Limits default to 50,
clamp to 100, and cannot be zero or negative. Next links retain the filters.
Temporal ranges match by inclusive overlap, not containment: an Item is kept
when its end is at or after the query start and its start is at or before the
query end. Comparisons use JavaScript timestamps at millisecond precision.

HTTP supports GET and HEAD, content negotiation, ETags, and read-only method
gates. `/items/{id}` is the canonical Item identity. An Item accessed through
a collection retains a self link to that route and adds `rel: canonical`
pointing to `/items/{id}`. Indexers should prefer `canonical` over `self`
when present; route representations and their ETags can differ without
creating a second canonical identity. Public errors add STAC `code` and a
fixed `description`, retaining `error` as a compatibility alias. Internal
exception messages are never used as public query error codes. Unsupported
methods reach the Pages catch-all and return the same JSON exception with 405.
Plain `Accept: application/json` also accepts GeoJSON and OpenAPI JSON;
responses retain their specific media types. Public responses, including
errors and 304s, allow credential-free cross-origin reads with
`Access-Control-Allow-Origin: *` and expose `ETag` and `Link`. OPTIONS permits
GET/HEAD, plus POST on `/search`, with `Content-Type` and `If-None-Match`.
Known route patterns permit preflight with `Access-Control-Max-Age: 600`;
unknown patterns return 404. Preflight does not verify resource IDs or build
or probe the publication; the STAC feature gate applies.
Conditional 304 handling applies only to GET and HEAD. POST search ignores
`If-None-Match`, returns 200 results, and uses `Cache-Control: no-store`.

## Step 2: Service Resources

The landing page and `/conformance` expose the same conformance list.
`service-desc` points to `/api` (OpenAPI 3.0.3 JSON with the OpenAPI media
type); `service-doc` points to `/api.html`. No optional search extensions
(Filter, Query, Sort, Fields, Context, or Transaction) are advertised.
The OpenAPI document describes the service, but `oas30` is not advertised:
there has not been an independent OGC OpenAPI requirements-class run.

## Step 3: Item Search

GET and JSON POST `/search` support `bbox`, `datetime`, `intersects`, `ids`,
`collections`, `limit`, and the opaque `cursor` from next links. Cursors are
nonempty and at most 256 characters. POST next
links contain their method and complete body. All GeoJSON geometry types are
supported, including bounded nested GeometryCollections. Bbox and intersects
together are rejected. Supplied ID/collection lists must contain 1-100
identifiers of at most 256 characters each. Queries are bounded to 256
positions and 32 GeometryCollection members in total, nesting depth 8,
64 KiB of geometry text, and a 128 KiB POST body. Supplied GeoJSON `bbox`
metadata is validated before being stripped, including nested members and
POST link bodies; query bounds are computed once from coordinates.
Polygon rings, including holes and nested MultiPolygon members, must be
closed with at least four positions; empty coordinate members are rejected.
Unexpected Turf geometry rejections return 400 `invalid_intersects`, not a
retryable publication failure. Bbox values use decimal numeric syntax (not
hex or binary), and datetime hours are 00-23 (not `24:00`). GET geometries
must also fit the host's URL limit; use POST for larger valid geometries.
Disjoint bounds and cheap ID/collection/time predicates reject Items before
Turf runs. Exact intersections have a per-request budget of 16,384
query-position tests across **distinct Item footprints**. Published geometry
is derived solely from bbox by `buildStacGeometry`, including antimeridian
splits. Both positive and negative results are cached by bbox within one
request, never across queries or requests. A 256-position query can evaluate
64 distinct overlapping footprints, while thousands of frames sharing one
footprint require one exact check.

The budget covers the **whole filtered result set before pagination**, and
every page request evaluates that set anew. `limit` cannot reduce the budget.
Excess work returns an uncached 400 `intersects_budget_exceeded`, never partial
results. Narrow `datetime` or `ids` first; `collections` can narrow across
datasets but cannot thin the frames within one collection. Multipart geometry
adds work within each exact check; the position/member caps bound that fan-out,
but the budget is not a uniform CPU cost model for every permitted shape.

Search filters the same fresh, verified publication that browse and the
operator report use. No second SQL eligibility filter can silently remove
saved history during a same-source re-transcode. Hidden, private, retracted,
unverified, and stale history remain excluded by that authoritative publication.
All listings use deterministic code-unit ID ordering and keyset pagination;
GET and POST next links remain usable even if the previously returned Item
disappeared. This includes `/items`, collection Item lists, and collection
lists; exhaustion returns an empty page. Cursors are opaque: clients
must use only values supplied by next links, not construct them from IDs.

Search has no independent SQL candidate/eligibility authority and adds no
geometry/datetime indexes. Phase 4 requires no migration beyond Phase 3's 0056.
The full publication build and asset-probe budget still apply;
this is not a claim of unbounded-catalog scalability. There is no new feature
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
CI pins uv 0.11.29. All Python validator/client invocations use the same
`--exclude-newer 2026-10-02T00:00:00Z` cutoff in addition to top-level
package versions, bounding transitive dependency resolution. The served
OpenAPI document also passes `openapi-spec-validator==0.7.1`; that check
is part of the opt-in external test, not a separate OGC `oas30` certification.
The test waits on a bound ephemeral HTTP socket, enables UTF-8 Python
output on Windows, and closes the socket in all outcomes. The
`STAC API Conformance` workflow runs the same test on relevant PRs.

## Step 5: Client Interoperability

Fixture-backed executable results:

| Client | Check | Result |
| --- | --- | --- |
| PySTAC Client 0.9.0 | Collection discovery, GET/POST paging at 17 Items/page, exact datetime filter | Passed locally, 120 unique matching Items |
| STAC Browser 5.1.0 | Real built browser in Chromium served from a second origin; root, collection and Item navigation, actual search-page submission, cross-origin GET/JSON POST search, readable errors and ETag, no page errors | Passed locally; Item and search screenshots retained by CI |
| STAC-GeoParquet 0.8.2 | Independent requests-based next-link traversal at 19 Items/page, index ingestion, Parquet round-trip | Passed locally; all 120 IDs and geometries retained |
| GDAL 3.12.4 OAPIF driver through Pyogrio | Direct collection connection with 17-Item pages, exact IDs, geographic CRS and nonempty geometry | Passed locally; 120 Items, independent of the QGIS provider |
| QGIS 3.34.4-Prizren OAPIF provider | Real offscreen PyQGIS layer, all 120 features, geographic CRS and nonempty geometry | Passed in Linux CI; not installed on the local Windows host |

GDAL and QGIS versions above are recorded observations, not CI pins. GDAL
comes from the resolved Pyogrio wheel; QGIS follows the runner's APT packages.
The client scripts report the actual installed versions on each run.

Run `functions/api/v1/stac/clients.test.ts` with `STAC_CLIENTS=true`.
`STAC_BROWSER_DIST` must point to a separately built STAC Browser 5.1.0
distribution (`SB_historyMode=hash npm run build` in its checkout).
CI fetches and checks exact Browser commit
`c78b78f3434fdd34d4192f7044194dae6a15172d`, rather than trusting a movable tag.
Browser installation disables npm lifecycle scripts; its build and actual
client checks pass with that restriction. Both CI checkouts disable persisted
credentials, and `setup-uv` is pinned to an immutable verified v6 commit.
Set `STAC_QGIS_PYTHON` to the Python executable that can import `qgis.core`
to include the QGIS test. Missing tools are explicit skips in normal unit
tests, not claimed passes. The dedicated CI job sets all three variables.
These tools are test-only and do not enter the application's dependencies.

STAC-GeoParquet is an independent bulk indexing path, not a hosted registry
submission. No production node was submitted to a third-party service.
Fixture-backed success is not a substitute for checking the deployed
node's actual catalog, anonymous assets, CORS and canonical origin.

## Security Contract

Both fixture servers bind ephemeral loopback ports and return fixed
`Internal Server Error` bodies; exception messages, stacks and paths remain
server-side diagnostics only. Real HTTP `TRACE` regressions exercise the
Fetch constructor failure path and assert the response and logging contract.
Loopback binding does not justify disclosing internal exceptions. Production
query errors likewise expose only allowlisted codes and fixed descriptions.

Fresh primary-backed publication reads remain the sole eligibility authority;
KV cannot authorize access. Any publication optimization must preserve immediate
private/retracted/stale-history exclusion, including during re-transcodes.

## Local Work-Budget Evidence

Measured 2026-10-06 on Windows, Node 24.18.0, Turf 7.4.0, using the actual
`parseStacQuery` and `searchStacItems` implementations. Each row is the median
and maximum of five warm local runs, excluding parsing, publication building,
network I/O and fixture allocation. These are wall-clock timings, **not Pages
CPU measurements**. The maximum polygon is a closed 256-position unit circle.
Disjoint Items are rectangles at `[10,10,10.1,10.1]`; bbox-overlapping but
non-intersecting Items are rectangles based on `[0.8,0.8,0.9,0.9]`, with distinct
western edges where indicated. The point query
is `[0.85,0.85]` against those latter rectangles. Synthetic IDs are sorted.

| Query and Items | Median / maximum local ms | Outcome |
| --- | --- | --- |
| Maximum polygon, 5,000 disjoint Items | 0.48 / 2.54 | Complete empty result; no Turf calls |
| Maximum polygon, 64 distinct overlapping footprints | 8.58 / 9.12 | Complete empty result; exact budget boundary |
| Maximum polygon, 65 distinct overlapping footprints | 7.11 / 7.41 | Explicit `intersects_budget_exceeded`; no partial result |
| Maximum polygon, 5,000 Items sharing one overlapping footprint | 1.19 / 1.71 | Complete empty result; one negative Turf result reused |
| Point, 5,000 Items sharing one overlapping footprint | 1.13 / 1.34 | Complete result; one positive Turf result reused |
| GeometryCollection of 32 two-part MultiPolygons, 64 distinct two-part antimeridian footprints | 13.30 / 13.55 | Complete empty result; all multipart comparisons, exact budget boundary |

The multipart query has 256 positions: each member contains a closed triangle
at positive longitude above the Items and another at negative longitude below
them. Combined bounds overlap every Item, but no part intersects, so exact
checks cannot stop at an early hit. Item western edges are distinct. The normal
query suite covers this shape and rejects a 65th footprint. Set
`STAC_BENCHMARKS=true` when running the query/search tests to reproduce the table.

A real published 3,650-frame sequence sharing one footprint also returns 200
for a maximum polygon with `limit=1`, with all 3,650 matches and a next link.
One local whole-handler observation was **3,243.73 ms**, including fresh
publication reads, verification and serialization. This is neither a Pages CPU
measurement nor a latency guarantee; publication construction dominates the
long-sequence request even after exact intersections are deduplicated.

The fixtures demonstrate the bbox fast path and aggregate guard, not a universal
worst-case guarantee for every permitted GeometryCollection or worker runtime.

## Rollout Gate: Pages CPU And D1 Measurement

**Outstanding; not measured on a real Pages deployment.** Local timings cannot
establish Workers CPU compliance or production rollout readiness.

Before rollout, the deployment operator must use an approved isolated Pages
preview running these fixes and record the following evidence here:

1. Preview revision, runtime, worker CPU limit, representative maximum eligible
	Item count, published geometry shapes, and GET/POST query payloads.
2. Cloudflare invocation CPU measurements, not HTTP elapsed time, for maximum
	accepted polygon and GeometryCollection complexity, including disjoint,
	bbox-overlapping/non-intersecting, touching and intersecting Items. Include
	cheap point queries and exact-budget/over-budget cases, cold and warm.
	Include 32 multipart GeometryCollection members against distinct two-part
	antimeridian footprints; the simple polygon table is not the worst case.
3. Full-handler cost including publication reads, verification and sorting,
	plus statuses and completeness; confirm over-budget requests return the
	documented error, and browse/search still agree during re-transcodes.
	Include real 1,000- and 3,650-frame sequences, repeated/global footprints,
	and superseded history. Record primary D1 rows read, query load and full
	publication build cost as well as distinct-footprint search work. Repeat
	with `limit=1` and subsequent pages, which rebuild the same publication.
4. The operator's accept/reject decision against that deployment's CPU limit.
	Tighten the bounds and repeat if needed. Never truncate the result to fit.

QGIS remains a Linux-CI check, not a local Windows result. This gate must be
completed by the deployment operator before enabling production rollout.