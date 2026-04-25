# Analytics queries — schema + sample SQL

Reference for querying the Cloudflare Workers Analytics Engine
dataset (`terraviz_events`) populated by `functions/api/ingest.ts`.
Use these patterns when wiring Grafana panels (`grafana/dashboards/*.json`),
ad-hoc spelunking via `wrangler analytics-engine sql`, or building
a notebook against the AE SQL HTTP API.

For event-shape details (which fields each event carries) see the
`TelemetryEvent` union in [`src/types/index.ts`](../src/types/index.ts)
and the catalog table in [`ANALYTICS_IMPLEMENTATION_PLAN.md`](ANALYTICS_IMPLEMENTATION_PLAN.md).
For the privacy posture see [`PRIVACY.md`](PRIVACY.md).

---

## Dataset name + connection

| Setting | Value |
|---|---|
| Dataset name | `terraviz_events` |
| Binding (in Pages function) | `ANALYTICS` |
| Wrangler config | `wrangler.toml` `[[analytics_engine_datasets]]` |
| SQL API endpoint | `https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql` |

Authentication: a Cloudflare API token with **Account Analytics
Read** permission. Token in `Authorization: Bearer <token>` header
on every request.

---

## Universal column layout

Every datapoint written by `toDataPoint()` lands with the same
positional schema. The first four `blobs[]` are server-stamped
(client cannot influence); event-specific fields follow in
**alphabetical order** of the field name.

| Position | Field | Type | Notes |
|---|---|---|---|
| `index1` | `session_id` | string | Sampling key. Random UUID per launch, never persisted |
| `blob1` | `event_type` | enum | One of the 30+ event types — see catalog below |
| `blob2` | `environment` | enum | `production` / `preview` / `local` (set from `CF_PAGES_BRANCH`) |
| `blob3` | `country` | string | 2-letter ISO from `CF-IPCountry`; `XX` when unknown / Tor |
| `blob4` | `internal` | string | `true` / `false` — Cloudflare Access staff identity present |
| `blob5+` | event-specific strings | string | Alphabetical by field name |
| `double1+` | event-specific numbers | float | Alphabetical by field name; includes `client_offset_ms` when stamped |
| `timestamp` | server-stamped | DateTime | When AE received the datapoint |

> **Important:** because event-specific blobs and doubles are
> alphabetical by field name, adding a new field shifts blob/double
> indexes. Pin queries to a known layout (i.e. write
> `WHERE blob1 = 'layer_loaded'` first, then read positionally
> within that filter) so a future schema addition doesn't silently
> change column meaning.

---

## Boilerplate

### Default filters

Every public-facing query should default to `production` traffic
and exclude internal staff dogfood:

```sql
SELECT count() FROM terraviz_events
WHERE blob2 = 'production'
  AND blob4 = 'false'
  AND timestamp > NOW() - INTERVAL '7' DAY
```

### Sampling

AE samples at write time. The `_sample_interval` column tells you
the sample weight. Multiply when summing:

```sql
SELECT sum(_sample_interval) AS estimated_events
FROM terraviz_events
WHERE blob2 = 'production'
```

Use `count()` for cardinality-style questions ("how many distinct
sessions"); use `sum(_sample_interval)` for volume-style questions
("how many events fired").

### Recommended Grafana variables

| Variable | Type | Query |
|---|---|---|
| `$environment` | dropdown | `SELECT DISTINCT blob2 FROM terraviz_events` (default `production`) |
| `$internal` | dropdown | `SELECT DISTINCT blob4 FROM terraviz_events` (default `false`) |
| `$country` | dropdown | `SELECT DISTINCT blob3 FROM terraviz_events ORDER BY blob3` (default `All`) |
| `$range` | time range | Built-in Grafana time range |

---

## Event catalog — blob / double positions

Each section lists the field at each `blob` / `double` index after
the four server-stamped blobs. Order is alphabetical by field name
(matches `toDataPoint()`'s sort).

### `session_start` (Tier A)

| Position | Field |
|---|---|
| `blob5` | `app_version` |
| `blob6` | `aspect_class` |
| `blob7` | `build_channel` |
| `blob8` | `locale` |
| `blob9` | `os` |
| `blob10` | `platform` |
| `blob11` | `resumed` (when present, `'true'`/`'false'`) |
| `blob12` | `schema_version` |
| `blob13` | `screen_class` |
| `blob14` | `viewport_class` |
| `blob15` | `vr_capable` |
| `double1` | `client_offset_ms` |

> The `resumed` slot is optional — when absent, fields shift up by
> one. In practice `resumed` only appears on re-starts after the
> user toggles telemetry back on; for production analytics filter
> on its presence rather than its position.

### `session_end` (Tier A)

| Position | Field |
|---|---|
| `blob5` | `exit_reason` (`pagehide` / `visibilitychange` / `clean`) |
| `double1` | `client_offset_ms` |
| `double2` | `duration_ms` |
| `double3` | `event_count` |

### `layer_loaded` (Tier A)

| Position | Field |
|---|---|
| `blob5` | `layer_id` |
| `blob6` | `layer_source` (`network` / `cache` / `hls` / `image`) |
| `blob7` | `slot_index` |
| `blob8` | `trigger` (`browse` / `orbit` / `tour` / `url` / `default`) |
| `double1` | `client_offset_ms` |
| `double2` | `load_ms` |

### `layer_unloaded` (Tier A)

| Position | Field |
|---|---|
| `blob5` | `layer_id` |
| `blob6` | `reason` (`replaced` / `home` / `tour` / `manual`) |
| `blob7` | `slot_index` |
| `double1` | `client_offset_ms` |
| `double2` | `dwell_ms` |

### `camera_settled` (Tier A)

| Position | Field |
|---|---|
| `blob5` | `layer_id` (nullable — empty string when no dataset loaded) |
| `blob6` | `projection` (`globe` / `mercator` / `vr` / `ar`) |
| `blob7` | `slot_index` |
| `double1` | `bearing` (degrees, integer-rounded) |
| `double2` | `center_lat` (3 decimals) |
| `double3` | `center_lon` (3 decimals) |
| `double4` | `client_offset_ms` |
| `double5` | `pitch` (degrees) |
| `double6` | `zoom` (2 decimals) |

### `map_click` (Tier A)

| Position | Field |
|---|---|
| `blob5` | `hit_id` (nullable) |
| `blob6` | `hit_kind` (`surface` / `marker` / `feature` / `region`) |
| `blob7` | `slot_index` |
| `double1` | `client_offset_ms` |
| `double2` | `lat` (3 decimals) |
| `double3` | `lon` (3 decimals) |
| `double4` | `zoom` |

### `viewport_focus` / `layout_changed` (Tier A)

| Position | Field (viewport_focus) | Field (layout_changed) |
|---|---|---|
| `blob5` | `layout` | `layout` |
| `blob6` | `slot_index` | `trigger` (`tools` / `tour` / `orbit`) |
| `double1` | `client_offset_ms` | `client_offset_ms` |

### `playback_action` (Tier A)

| Position | Field |
|---|---|
| `blob5` | `action` (`play` / `pause` / `seek` / `rate`) |
| `blob6` | `layer_id` |
| `double1` | `client_offset_ms` |
| `double2` | `playback_rate` |
| `double3` | `playback_time_s` |

### `settings_changed` (Tier A)

| Position | Field |
|---|---|
| `blob5` | `key` |
| `blob6` | `value_class` |
| `double1` | `client_offset_ms` |

### `browse_opened` / `browse_filter` (Tier A)

| Position | Field (browse_opened) | Field (browse_filter) |
|---|---|---|
| `blob5` | `source` | `category` |
| `blob6` | — | `result_count_bucket` |
| `double1` | `client_offset_ms` | `client_offset_ms` |

### `tour_started` (Tier A)

| Position | Field |
|---|---|
| `blob5` | `source` (`browse` / `orbit` / `deeplink`) |
| `blob6` | `tour_id` |
| `blob7` | `tour_title` |
| `double1` | `client_offset_ms` |
| `double2` | `task_count` |

### `tour_task_fired` (Tier A)

| Position | Field |
|---|---|
| `blob5` | `task_type` |
| `blob6` | `tour_id` |
| `double1` | `client_offset_ms` |
| `double2` | `task_dwell_ms` |
| `double3` | `task_index` |

### `tour_paused` / `tour_resumed` / `tour_ended` (Tier A)

Position | Paused | Resumed | Ended
---|---|---|---
`blob5` | `reason` | `tour_id` | `outcome`
`blob6` | `tour_id` | — | `tour_id`
`double1` | `client_offset_ms` | `client_offset_ms` | `client_offset_ms`
`double2` | `task_index` | `pause_ms` | `duration_ms`
`double3` | — | `task_index` | `task_index`

### `vr_session_started` / `vr_session_ended` (Tier A)

Position | Started | Ended
---|---|---
`blob5` | `device_class` | `exit_reason`
`blob6` | `layer_id` | `layer_id`
`blob7` | `mode` | `mode`
`double1` | `client_offset_ms` | `client_offset_ms`
`double2` | `entry_load_ms` | `duration_ms`
`double3` | — | `mean_fps` (nullable; arithmetic mean over the whole session)

### `vr_placement` (Tier A)

| Position | Field |
|---|---|
| `blob5` | `layer_id` (nullable) |
| `blob6` | `persisted` (`true` / `false`) |
| `double1` | `client_offset_ms` |

### `perf_sample` (Tier A)

| Position | Field |
|---|---|
| `blob5` | `surface` (`map` / `vr`) |
| `blob6` | `webgl_renderer_hash` (8 hex chars or `unknown`) |
| `double1` | `client_offset_ms` |
| `double2` | `fps_median_10s` |
| `double3` | `frame_time_p95_ms` |
| `double4` | `jsheap_mb` (nullable) |

### `error` (Tier A) / `error_detail` (Tier B)

| Position | Field |
|---|---|
| `blob5` | `category` |
| `blob6` | `code` |
| `blob7` | `message_class` (sanitized, ≤ 80 chars) |
| `blob8` | `source` |
| `double1` | `client_offset_ms` |
| `double2` | `count_in_batch` |

`error_detail` adds a `stack` blob at `blob9` (sanitized stack
frame list).

### Tier B catalog (research mode only)

Tier B events (`dwell`, `orbit_*`, `browse_search`, `vr_interaction`,
`tour_question_answered`, `error_detail`) follow the same
alphabetical layout. Per-event positions:

#### `dwell`

| Position | Field |
|---|---|
| `blob5` | `view_target` (`chat` / `info` / `browse` / `tools` / `dataset:<id>`) |
| `double1` | `client_offset_ms` |
| `double2` | `duration_ms` |

#### `vr_interaction`

| Position | Field |
|---|---|
| `blob5` | `gesture` (`drag` / `pinch` / `thumbstick_zoom` / `flick_spin` / `hud_tap`) |
| `double1` | `client_offset_ms` |
| `double2` | `magnitude` (rad/s for rotation, log2 for zoom, 1 for hud_tap) |

#### `browse_search`

| Position | Field |
|---|---|
| `blob5` | `query_hash` (12 hex chars of SHA-256) |
| `blob6` | `result_count_bucket` (`0` / `1-10` / `11-50` / `50+`) |
| `double1` | `client_offset_ms` |
| `double2` | `query_length` |

#### `orbit_interaction`

> Nullable `duration_ms` / `input_tokens` / `output_tokens` shift
> later doubles forward when omitted. Filter nullables in queries
> rather than positionally indexing past them.

| Position | Field |
|---|---|
| `blob5` | `interaction` (`message_sent` / `response_complete` / `action_executed` / `settings_changed`) |
| `blob6` | `model` |
| `blob7` | `subtype` |
| `double1` | `client_offset_ms` |
| `double2` | `duration_ms` (when present) |
| `double3` | `input_tokens` (when present) |
| `double4` | `output_tokens` (when present) |

#### `orbit_turn`

| Position | Field |
|---|---|
| `blob5` | `finish_reason` (`stop` / `length` / `tool_calls` / `error`) |
| `blob6` | `model` |
| `blob7` | `reading_level` |
| `blob8` | `turn_role` (`user` / `assistant`) |
| `double1` | `client_offset_ms` |
| `double2` | `content_length` |
| `double3` | `duration_ms` |
| `double4` | `input_tokens` (when present) |
| `double5` | `output_tokens` (when present) |
| `double6` | `turn_index` |

#### `orbit_tool_call`

| Position | Field |
|---|---|
| `blob5` | `result` (`ok` / `rejected` / `error`) |
| `blob6` | `tool` |
| `double1` | `client_offset_ms` |
| `double2` | `position_in_turn` |
| `double3` | `turn_index` |

#### `orbit_load_followed`

| Position | Field |
|---|---|
| `blob5` | `dataset_id` |
| `blob6` | `path` (`marker` / `tool_call` / `button_click`) |
| `double1` | `client_offset_ms` |
| `double2` | `latency_ms` |

#### `orbit_correction`

| Position | Field |
|---|---|
| `blob5` | `signal` (`thumbs_down` / `rephrased_same_turn` / `abandoned_turn`) |
| `double1` | `client_offset_ms` |
| `double2` | `turn_index` |

#### `tour_question_answered`

| Position | Field |
|---|---|
| `blob5` | `question_id` |
| `blob6` | `tour_id` |
| `blob7` | `was_correct` (`true` / `false`) |
| `double1` | `choice_count` |
| `double2` | `chosen_index` |
| `double3` | `client_offset_ms` |
| `double4` | `correct_index` |
| `double5` | `response_ms` |
| `double6` | `task_index` |

---

## Product Health queries

### Sessions per day

```sql
SELECT
  toStartOfDay(timestamp) AS day,
  count(DISTINCT index1) AS sessions
FROM terraviz_events
WHERE blob1 = 'session_start'
  AND blob2 = $environment
  AND blob4 = 'false'
  AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day
ORDER BY day
```

### Platform breakdown

```sql
SELECT
  blob10 AS platform,
  blob9 AS os,
  count(DISTINCT index1) AS sessions
FROM terraviz_events
WHERE blob1 = 'session_start'
  AND blob2 = 'production'
GROUP BY platform, os
ORDER BY sessions DESC
```

### Layer load p95 by dataset

```sql
SELECT
  blob5 AS layer_id,
  quantile(0.50)(double2) AS p50_ms,
  quantile(0.95)(double2) AS p95_ms,
  count() AS load_count
FROM terraviz_events
WHERE blob1 = 'layer_loaded'
  AND blob2 = 'production'
  AND blob6 != 'cache'  -- exclude local-cache hits
  AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY layer_id
HAVING load_count > 10
ORDER BY p95_ms DESC
LIMIT 25
```

### Layer load source mix (network vs cache vs hls vs image)

```sql
SELECT
  blob6 AS source,
  count() AS loads,
  quantile(0.50)(double2) AS p50_ms
FROM terraviz_events
WHERE blob1 = 'layer_loaded'
  AND blob2 = 'production'
GROUP BY source
ORDER BY loads DESC
```

### Error rate per session

```sql
WITH sessions AS (
  SELECT count(DISTINCT index1) AS n
  FROM terraviz_events
  WHERE blob1 = 'session_start' AND blob2 = 'production'
    AND timestamp > NOW() - INTERVAL '1' DAY
),
errors AS (
  SELECT count() AS n
  FROM terraviz_events
  WHERE blob1 = 'error' AND blob2 = 'production'
    AND timestamp > NOW() - INTERVAL '1' DAY
)
SELECT errors.n / sessions.n AS errors_per_session
FROM sessions, errors
```

### Errors by category

```sql
SELECT
  blob5 AS category,
  blob8 AS source,
  count() AS occurrences
FROM terraviz_events
WHERE blob1 = 'error'
  AND blob2 = 'production'
  AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY category, source
ORDER BY occurrences DESC
```

### Median FPS over time (2D map surface)

```sql
SELECT
  toStartOfHour(timestamp) AS hour,
  blob6 AS gpu_bucket,
  quantile(0.50)(double2) AS median_fps
FROM terraviz_events
WHERE blob1 = 'perf_sample'
  AND blob5 = 'map'
  AND blob2 = 'production'
GROUP BY hour, gpu_bucket
ORDER BY hour
```

### VR session funnel + mean FPS at session end

> `vr_session_ended.mean_fps` is the arithmetic mean of FPS over
> the whole session. Use it for end-of-session comparisons; for
> in-session medians, query `perf_sample` instead.

```sql
SELECT
  blob6 AS device_class,
  blob7 AS mode,
  count() AS sessions,
  avg(double2) AS avg_entry_load_ms,
  quantile(0.50)(double3) AS p50_session_mean_fps
FROM terraviz_events
WHERE blob1 = 'vr_session_ended'
  AND blob2 = 'production'
  AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY device_class, mode
ORDER BY sessions DESC
```

### Tour completion rate

```sql
WITH starts AS (
  SELECT blob6 AS tour_id, count() AS n
  FROM terraviz_events
  WHERE blob1 = 'tour_started' AND blob2 = 'production'
  GROUP BY tour_id
),
completes AS (
  SELECT blob6 AS tour_id, count() AS n
  FROM terraviz_events
  WHERE blob1 = 'tour_ended' AND blob5 = 'completed' AND blob2 = 'production'
  GROUP BY tour_id
)
SELECT
  starts.tour_id,
  starts.n AS starts,
  COALESCE(completes.n, 0) AS completes,
  COALESCE(completes.n, 0) / starts.n AS completion_rate
FROM starts
LEFT JOIN completes ON starts.tour_id = completes.tour_id
ORDER BY starts DESC
```

### Country breakdown (top 20)

```sql
SELECT
  blob3 AS country,
  count(DISTINCT index1) AS sessions
FROM terraviz_events
WHERE blob1 = 'session_start'
  AND blob2 = 'production'
  AND blob3 != 'XX'
GROUP BY country
ORDER BY sessions DESC
LIMIT 20
```

---

## Spatial Attention queries

### `camera_settled` heatmap (lat/lon hex bins)

Coordinates are pre-rounded to 3 decimals (~110 m). For coarser
hex bins:

```sql
SELECT
  round(double3, 1) AS lon_bin,   -- 0.1° ≈ 11 km
  round(double2, 1) AS lat_bin,
  count() AS settles
FROM terraviz_events
WHERE blob1 = 'camera_settled'
  AND blob6 = 'globe'             -- 2D globe only
  AND blob2 = 'production'
  AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY lat_bin, lon_bin
HAVING settles > 5
ORDER BY settles DESC
LIMIT 1000
```

### `camera_settled` heatmap, scoped to a single dataset

```sql
SELECT
  round(double3, 1) AS lon_bin,
  round(double2, 1) AS lat_bin,
  count() AS settles
FROM terraviz_events
WHERE blob1 = 'camera_settled'
  AND blob5 = 'INTERNAL_SOS_HURRICANE_KATRINA'
  AND blob2 = 'production'
GROUP BY lat_bin, lon_bin
ORDER BY settles DESC
```

### Map clicks split by hit kind

```sql
SELECT
  blob6 AS hit_kind,
  count() AS clicks
FROM terraviz_events
WHERE blob1 = 'map_click'
  AND blob2 = 'production'
GROUP BY hit_kind
ORDER BY clicks DESC
```

### VR vs 2D viewing — same dataset

```sql
SELECT
  blob6 AS projection,
  blob5 AS layer_id,
  count() AS settles
FROM terraviz_events
WHERE blob1 = 'camera_settled'
  AND blob5 != ''                 -- only when a dataset is loaded
  AND blob2 = 'production'
GROUP BY projection, layer_id
ORDER BY settles DESC
LIMIT 50
```

### Top viewed regions per dataset (camera + click joint)

```sql
SELECT
  blob5 AS layer_id,
  round(double3, 1) AS lon_bin,
  round(double2, 1) AS lat_bin,
  count() AS attention_events
FROM terraviz_events
WHERE blob1 IN ('camera_settled', 'map_click')
  AND blob2 = 'production'
  AND blob5 != ''
GROUP BY layer_id, lat_bin, lon_bin
HAVING attention_events > 10
ORDER BY attention_events DESC
LIMIT 200
```

---

## Tier B Research queries

These return data only from sessions where the user opted into
Research mode under Tools → Privacy.

### Tour quiz correctness rates

```sql
SELECT
  blob6 AS tour_id,
  blob5 AS question_id,
  count() AS attempts,
  sum(if(blob7 = 'true', 1, 0)) / count() AS correctness_rate,
  avg(double5) AS avg_response_ms
FROM terraviz_events
WHERE blob1 = 'tour_question_answered'
  AND blob2 = 'production'
GROUP BY tour_id, question_id
HAVING attempts > 5
ORDER BY correctness_rate ASC   -- worst-answered first
LIMIT 50
```

### Browse search top hashed queries

```sql
SELECT
  blob5 AS query_hash,
  count() AS searches,
  -- result_count_bucket is a string (`0` / `1-10` / `11-50` / `50+`),
  -- so we surface the most common bucket per query rather than an
  -- average.
  any(blob6) AS result_bucket,
  avg(double2) AS avg_query_length
FROM terraviz_events
WHERE blob1 = 'browse_search'
  AND blob2 = 'production'
GROUP BY query_hash
ORDER BY searches DESC
LIMIT 50
```

### Searches that return zero results

> Useful for finding gaps in the catalog — what people search for
> that we don't ship.

```sql
SELECT
  blob5 AS query_hash,
  count() AS searches
FROM terraviz_events
WHERE blob1 = 'browse_search'
  AND blob2 = 'production'
  AND blob6 = '0'
GROUP BY query_hash
ORDER BY searches DESC
LIMIT 50
```

### Panel dwell time distribution

```sql
SELECT
  blob5 AS view_target,
  quantile(0.50)(double2) AS p50_ms,
  quantile(0.95)(double2) AS p95_ms,
  count() AS samples
FROM terraviz_events
WHERE blob1 = 'dwell'
  AND blob2 = 'production'
GROUP BY view_target
ORDER BY samples DESC
```

### VR interaction mix per gesture

```sql
SELECT
  blob5 AS gesture,
  count() AS gestures,
  avg(double2) AS avg_magnitude,
  quantile(0.95)(double2) AS p95_magnitude
FROM terraviz_events
WHERE blob1 = 'vr_interaction'
  AND blob2 = 'production'
GROUP BY gesture
ORDER BY gestures DESC
```

### Orbit follow-through latency

> How long between Orbit recommending a dataset and the user
> actually loading it. p50 / p95.

```sql
SELECT
  blob6 AS path,
  quantile(0.50)(double2) AS p50_latency_ms,
  quantile(0.95)(double2) AS p95_latency_ms,
  count() AS loads
FROM terraviz_events
WHERE blob1 = 'orbit_load_followed'
  AND blob2 = 'production'
GROUP BY path
ORDER BY loads DESC
```

### Orbit correction signal mix

```sql
SELECT
  blob5 AS signal,
  count() AS occurrences
FROM terraviz_events
WHERE blob1 = 'orbit_correction'
  AND blob2 = 'production'
GROUP BY signal
ORDER BY occurrences DESC
```

### Orbit response timing per model

> `duration_ms` is nullable on `orbit_interaction`; filter early so
> the average doesn't include skipped rows.

```sql
SELECT
  blob6 AS model,
  count() AS responses,
  quantile(0.50)(double2) AS p50_response_ms,
  quantile(0.95)(double2) AS p95_response_ms
FROM terraviz_events
WHERE blob1 = 'orbit_interaction'
  AND blob5 = 'response_complete'
  AND blob2 = 'production'
  AND double2 > 0
GROUP BY model
ORDER BY responses DESC
```

---

## Maintenance + caveats

- **Eventual consistency.** AE has a multi-second ingestion lag
  before rows are queryable. Set Grafana refresh intervals to ≥ 60 s
  to stay above the lag window.
- **Sampling.** AE samples writes when volume spikes; multiply
  `count()` by `_sample_interval` (or `sum(_sample_interval)`)
  for volume questions. Use `count(DISTINCT index1)` for unique-
  session counts — sampling preserves index1 semantics.
- **Schema additions shift positions.** Adding a field that sorts
  alphabetically before an existing one shifts all later positions
  by one. The catalog above is current as of Commit 11; check for
  schema changes when queries return unexpected types.
- **Server-side blobs are immutable.** `blob1..blob4`
  (`event_type` / `environment` / `country` / `internal`) are
  stamped by the Pages function and clients cannot influence them.
  Filter on these for trustworthy slicing.
- **Country `XX`.** Treat as missing data (Tor, unknown geo, local
  dev). Excluded from production country dashboards by default.
