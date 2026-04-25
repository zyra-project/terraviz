# Grafana dashboards — Terraviz analytics

Three dashboards visualize the telemetry stream landed in Cloudflare
Workers Analytics Engine by `functions/api/ingest.ts`:

- **`product-health.json`** — sessions, layer load times, error
  rates, perf samples, VR session funnels, tour completion. Tier A
  signal only (works regardless of user opt-in).
- **`spatial-attention.json`** — `camera_settled` and `map_click`
  heatmaps, dataset-scoped attention bins, projection split (2D
  globe vs VR/AR). Tier A.
- **`research.json`** — Tier B / opt-in. Hashed search queries,
  panel dwell, VR interaction mix, Orbit follow-through and
  correction signals. Empty until at least one user opts into
  Research mode under Tools → Privacy.

The dashboards target the [Infinity datasource](https://grafana.com/grafana/plugins/yesoreyeram-infinity-datasource/)
plugin, which can call any HTTP API (no native AE plugin exists for
Grafana). Each panel is a `POST /sql` to the Cloudflare AE SQL API
with the SQL query in the body.

## One-time setup

> Total time: ~10 minutes.

### 1. Cloudflare API token

1. https://dash.cloudflare.com/profile/api-tokens
2. **Create Custom Token** → name e.g. `terraviz-grafana-ae`
3. **Permissions**: `Account` → `Account Analytics` → `Read`
4. **Account Resources**: `Include` → your specific account
5. (Optional) restrict to Grafana's egress IPs and set a TTL
6. **Create** → copy the token immediately (shown once)

### 2. Install the Infinity plugin

In Grafana:
- **Connections → Add new connection → Infinity**
- Click **Install**

### 3. Add the Infinity datasource

- **Connections → Data sources → Add data source → Infinity**
- **Name**: `Cloudflare AE` (or whatever you like)
- **URL** (under Authentication → Allowed hosts, expand the URL panel):
  ```
  https://api.cloudflare.com/client/v4/accounts/<YOUR_ACCOUNT_ID>/analytics_engine
  ```
  Find your account ID in the right sidebar of the Cloudflare
  dashboard. The dashboards reference `/sql` relative to this base.
- **Authentication**: select **Bearer Token**, paste the token from
  step 1.
- **Allowed hosts**: leave default (Infinity allows all by default;
  tighten to `https://api.cloudflare.com` for defence-in-depth).
- Click **Save & test**.

### 4. Import the dashboards

For each of the three JSON files (`product-health.json`,
`spatial-attention.json`, `research.json`):

- **Dashboards → New → Import → Upload JSON file**
- Select **Cloudflare AE** for the `DS_INFINITY` placeholder when
  prompted
- **Import**

Each panel makes its own POST. The first time a panel renders, you
should see a network request to
`https://api.cloudflare.com/client/v4/accounts/.../analytics_engine/sql`
with the SQL query as the request body. If you see requests to
`jsonplaceholder.typicode.com` instead, the URL on the datasource
is wrong — go back to step 3.

## Variables

All three dashboards expect:

| Variable | Default | Description |
|---|---|---|
| `$environment` | `production` | Filters `blob2 = $environment`. Switch to `preview` to verify staging. |
| `$internal` | `false` | Filters `blob4 = $internal` (set to `true` to see staff sessions). Tier B dashboard hard-codes `false` since Research mode is opt-in by external users only. |
| `$timeRange` | dashboard-specific | Built-in Grafana time range, applied to `WHERE timestamp > toDateTime(intDiv($__from, 1000))`. |

> ⚠️ **AE timestamp comparison gotcha.** Grafana's `$__from` macro
> expands to a Unix epoch in milliseconds (e.g. `1776485031962`).
> Cloudflare AE's `timestamp` column is a `DateTime` — comparing
> `timestamp > <millisecond-int>` directly returns **422
> Unprocessable Entity** because AE rejects the type mismatch.
>
> Cloudflare AE supports a *subset* of ClickHouse's SQL functions —
> `fromUnixTimestamp64Milli` is NOT in the subset (returns
> `unknown function call`). The portable construction is:
>
> ```sql
> WHERE timestamp > toDateTime(intDiv($__from, 1000))
> ```
>
> `intDiv($__from, 1000)` converts ms → seconds (integer division),
> then `toDateTime(seconds)` produces a `DateTime` value
> comparable to `timestamp`. Both functions are documented in CF
> AE's supported function list.
>
> Literal `NOW() - INTERVAL '7' DAY` style queries (used in
> `ANALYTICS_QUERIES.md` examples) don't have this issue —
> only Grafana panels using `$__from` do.

Spatial attention adds a `$projection` (multi: globe / mercator /
vr / ar) and a `$layer_id` placeholder that defaults to `All`.
After data is flowing, convert `$layer_id` to a query variable
in-Grafana for dynamic dataset discovery — the SQL is in the
variable's description.

## Query panel format (for adding new panels)

Every target uses Infinity's POST-JSON shape:

```json
{
  "refId": "A",
  "datasource": { "type": "yesoreyeram-infinity-datasource", "uid": "${DS_INFINITY}" },
  "type": "json",
  "source": "url",
  "format": "table",
  "url": "/sql",
  "url_options": {
    "method": "POST",
    "data": "<SQL goes here, can reference $environment / $internal / toDateTime(intDiv($__from, 1000))>",
    "headers": [{ "key": "Content-Type", "value": "text/plain" }]
  },
  "parser": "backend",
  "root_selector": "data"
}
```

Cloudflare AE returns `{ data: [{...}, ...], meta: [...], rows: N }`,
so `root_selector: "data"` extracts the row array; the backend parser
introspects column types. Sample SQL for every Tier A and Tier B
event lives in [`docs/ANALYTICS_QUERIES.md`](../docs/ANALYTICS_QUERIES.md).

## Polish workflow

The committed JSONs are starting templates — every panel ships with
working SQL but bare-bones layout/colors. The intent:

1. Import the dashboard
2. Polish panels in-Grafana (panel types, color ramps, axis units,
   legend positioning, geomap tile servers for `spatial-attention`)
3. **Dashboard settings → JSON Model** → copy the polished JSON
4. Replace the file under `grafana/dashboards/` and commit

The repo stays the source of truth so a fresh deploy produces the
same dashboards.

## Maintenance

- **Refresh interval ≥ 60 s.** AE has a few-second ingestion lag;
  faster refresh just hits cached results.
- **Sampling.** Use `sum(_sample_interval)` for volume questions
  (event totals); use `count(DISTINCT index1)` for cardinality
  questions (unique sessions). See `docs/ANALYTICS_QUERIES.md`
  "Sampling" notes.
- **Schema drift.** When `src/types/index.ts` adds an event field,
  the alphabetical-blob ordering shifts. Re-check the affected
  dashboard panels and update any positional queries.
- **Tier B panels** (research dashboard) only show data when at
  least one user has opted into Research mode. Empty panels in a
  fresh deployment are expected.

## Alternative: Cloudflare Worker proxy

If you'd rather not give Grafana a Cloudflare API token with
Account Analytics scope (broader than just AE), you can run a
small Cloudflare Worker that:
1. Accepts the dashboard's JSON requests
2. Forwards them to AE SQL with a server-side token
3. Returns the response

This scopes Grafana's effective permissions to "query
`terraviz_events` only" instead of "read all account analytics."
Out of scope for this commit; raise a follow-up issue if needed.
