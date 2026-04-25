# Analytics

End-to-end reference for the Terraviz analytics pipeline. Read this if
you need to understand the data we collect, add a new event, query
production data, or audit the privacy posture.

> Companion docs:
> - [`PRIVACY.md`](PRIVACY.md) — the user-facing privacy policy. Single
>   source of truth for what we promise; everything in this file must
>   match it.
> - [`ANALYTICS_QUERIES.md`](ANALYTICS_QUERIES.md) — the full schema
>   reference (per-event blob/double positions) plus a library of
>   sample SQL for Grafana panels.
> - [`ANALYTICS_CONTRIBUTING.md`](ANALYTICS_CONTRIBUTING.md) — the
>   "I want to add a new event" walkthrough plus the privacy review
>   checklist. **Required reading before opening a PR that touches
>   `src/analytics/**` or any `emit({ event_type: ... })` call site.**
> - [`SELF_HOSTING.md`](SELF_HOSTING.md) — for forks deploying their
>   own Terraviz instance on Cloudflare Pages.
> - [`ANALYTICS_IMPLEMENTATION_PLAN.md`](ANALYTICS_IMPLEMENTATION_PLAN.md)
>   — the design history (14-commit rollout). Useful as historical
>   context; not authoritative for the current schema — that role
>   belongs to this file plus the type union in `src/types/index.ts`.

## Two-tier consent model

Telemetry is gated by a single user-controlled setting under
**Tools → Privacy**:

| Tier | Default | Emits |
|---|---|---|
| `off` | — | Nothing. Queue is drained and discarded. |
| `essential` | ✅ web + desktop | Tier A only — operational + product-health signals (sessions, layer loads, FPS samples, errors, tour funnel, VR/AR session lifecycle). |
| `research` | opt-in | Tier A + Tier B — additionally captures dwell, Orbit chat instrumentation, hashed search queries, per-gesture VR interaction, scrubbed error stacks, and tour-quiz outcomes. |

The tier value lives in `localStorage` under `sos-telemetry-config`.
The `TIER_B_EVENT_TYPES` tuple in `src/types/index.ts` is the
authoritative list of which events require Research mode; the runtime
gate in `src/analytics/emitter.ts:tierGate()` reads it as a Set and
short-circuits before queueing.

## Where the data goes

```
client (src/analytics/) ──POST batch──▶ Cloudflare Pages Function
                                        functions/api/ingest.ts
                                            │
                                            │  toDataPoint() — alphabetical
                                            ▼  blob/double layout
                                        Workers Analytics Engine
                                          dataset: terraviz_events
                                            │
                                            │  read-side AE SQL API
                                            ▼
                                        Grafana dashboards
                                          grafana/dashboards/*.json
```

- **Transport.** `src/analytics/transport.ts` — `fetch()` for live
  batches, `navigator.sendBeacon()` on `pagehide`. Tauri uses the
  HTTP plugin to bypass webview CORS.
- **Endpoint.** `/api/ingest` (Cloudflare Pages Function). Server-side
  it stamps `event_type`, `environment`, `country` (from
  `CF-IPCountry`) and `internal` (Cloudflare Access presence check)
  into `blob1..blob4`. Clients cannot influence these positions.
- **Storage.** Workers Analytics Engine — a columnar time-series
  store. Schema is positional (`blob1..blob20`, `double1..double20`,
  `index1` = session id) and clients place fields by alphabetical
  sort of the event payload keys. See
  [`ANALYTICS_QUERIES.md`](ANALYTICS_QUERIES.md) for per-event
  positions.
- **Querying.** Grafana with the Yesoreyeram Infinity datasource
  pointed at the AE SQL API. Dashboard JSON in `grafana/dashboards/`
  is the source of truth — polish in-Grafana, then export and
  re-commit.

## Privacy posture (summary)

The hard rules — enforced at the emit boundary, the ingest function,
or both:

- **No IPs stored.** `CF-Connecting-IP` is read for rate-limiting and
  immediately discarded. Country comes from Cloudflare's GeoIP
  (`CF-IPCountry`) so we never see the raw address.
- **No User-Agent stored.** OS and viewport are bucketed at the
  client (`src/analytics/session.ts`) into ≤6-value enums.
- **Free text is hashed or never sent.** Search queries → 12-hex
  SHA-256 prefix (`src/analytics/hash.ts`). Error messages →
  sanitized `message_class` only (URLs, emails, UUIDs, digit runs,
  file paths stripped at `src/analytics/errorCapture.ts`).
- **Lat/lon rounded to 3 decimals.** Camera-settled events
  (`src/analytics/camera.ts`) round before emit. ~111 m precision —
  enough for "what region was the user looking at", not enough to
  geolocate anyone.
- **Session id is in-memory only.** Generated at boot, rotated every
  app launch, never persisted. Tier-A telemetry consent does not
  imply persistent identification.
- **Kill switch.** `/api/ingest` honours a `KILL_TELEMETRY=1` env
  var; the function returns 410 and the client cools down for the
  rest of the session.

`PRIVACY.md` is the user-facing version of this list. If anything in
this doc drifts from `PRIVACY.md`, **`PRIVACY.md` wins** and this doc
must be corrected.

## Event catalog (overview)

| Event | Tier | Where it fires |
|---|---|---|
| `session_start` / `session_end` | A | `src/analytics/session.ts` |
| `layer_loaded` / `layer_unloaded` | A | `src/services/datasetLoader.ts` |
| `camera_settled` | A | `src/services/mapRenderer.ts` (2D) + `src/services/vrInteraction.ts` (VR/AR) |
| `map_click` | A | `src/services/mapRenderer.ts` |
| `viewport_focus` / `layout_changed` | A | `src/services/viewportManager.ts` |
| `playback_action` | A | `src/ui/playbackController.ts` |
| `settings_changed` | A | `src/ui/toolsMenuUI.ts`, `src/ui/privacyUI.ts` |
| `browse_opened` / `browse_filter` | A | `src/ui/browseUI.ts` |
| `tour_started` / `tour_task_fired` / `tour_paused` / `tour_resumed` / `tour_ended` | A | `src/services/tourEngine.ts` |
| `vr_session_started` / `vr_session_ended` / `vr_placement` | A | `src/services/vrSession.ts`, `src/services/vrPlacement.ts` |
| `perf_sample` | A | `src/analytics/perfSampler.ts` |
| `error` | A | `src/analytics/errorCapture.ts` |
| `feedback` | A | `src/ui/helpUI.ts` (in-app form) + `src/ui/chatUI.ts` (Orbit thumbs) |
| `dwell` | **B** | `src/analytics/dwell.ts` (panel + dataset dwell, called by chat / browse / info / tools UI) |
| `orbit_interaction` / `orbit_turn` / `orbit_tool_call` / `orbit_load_followed` / `orbit_correction` | **B** | `src/ui/chatUI.ts`, `src/services/docentService.ts`, `src/services/datasetLoader.ts` |
| `browse_search` | **B** | `src/ui/browseUI.ts` (debounced + hashed) |
| `vr_interaction` | **B** | `src/services/vrInteraction.ts` (per-gesture, throttled) |
| `error_detail` | **B** | `src/analytics/errorCapture.ts` (adds sanitized stack) |
| `tour_question_answered` | **B** | `src/services/tourEngine.ts` |

Per-event field documentation lives in the type definitions
(`src/types/index.ts` lines 685–1023) and the query reference
(`ANALYTICS_QUERIES.md`). The type union itself is the
authoritative schema.

## How to add a new event

> Five-minute checklist. Most steps are a single edit.

1. **Define the event type.** Add an interface to
   `src/types/index.ts` extending `TelemetryEventBase`, give it a
   string literal `event_type`, and add it to the `TelemetryEvent`
   union. Keep field names lowercase + snake_case so the
   alphabetical positional layout is predictable.
2. **Pick the tier.** If the event captures anything that wouldn't
   be appropriate to send by default (free-form user input,
   per-message Orbit data, dwell timing, gesture-level interaction),
   add the literal to `TIER_B_EVENT_TYPES` in the same file.
   Otherwise it defaults to Tier A.
3. **Emit it.** Import `emit` from `'../analytics'` and call it from
   the appropriate call site. The emitter handles tier gating,
   queueing, batching, and pagehide flush — call sites should not
   reach for any of that machinery.
4. **Throttle if it can fire often.** Free-running per-frame events
   (camera, perf, vr_interaction, dwell tick) need a throttle to
   keep the wire narrow. The pattern is:
   - keep a `Map<bucket, number[]>` of timestamps
   - drop entries older than the window
   - reject when length ≥ cap
   - `MAX_PER_MINUTE` constants are exported so dashboards know the
     ceiling
   See `src/analytics/camera.ts:emitCameraSettled()` or
   `src/services/vrInteraction.ts:emitVrInteraction()` for the
   reference implementations.
5. **Privacy review.** If the event carries any string the user
   typed, hashed it via `src/analytics/hash.ts` (12-hex SHA-256
   prefix). If it carries a stack trace or message, route it through
   `src/analytics/errorCapture.ts:sanitizeMessage()`. If it
   carries lat/lon, round to 3 decimals.
6. **Update the docs.** Add a row to the event-catalog table in this
   file, add a positional layout entry to `ANALYTICS_QUERIES.md`,
   and (if user-visible) add a line to `PRIVACY.md` describing
   what the new field captures and why.
7. **Test it.** Three cases minimum: happy path, tier-gating
   (Essential drops Tier B), and idempotency under
   double-stop/double-emit. See `src/analytics/dwell.test.ts` and
   `src/services/vrInteraction.test.ts` for templates.
8. **Add a Grafana panel.** Drop a query into the appropriate
   dashboard JSON (`product-health.json` for Tier A,
   `research.json` for Tier B) so the new event lights up a panel
   immediately. AE caps blob/double counts at 20 each — verify the
   schema doesn't exceed.

## Schema evolution

The positional layout is fragile by design — it's fast and cheap, but
adding a field that sorts alphabetically before an existing one
shifts every later position. Rules to keep dashboards stable:

- **Append, don't prepend.** New string fields should sort
  alphabetically *after* existing ones in the same event. If you
  must reuse a name, document it in the event interface and bump
  `TELEMETRY_SCHEMA_VERSION` in `src/analytics/config.ts` so
  dashboards can branch on it.
- **Optional fields shift later positions.** When `duration_ms` is
  null on `orbit_interaction`, what would be `double3` becomes
  `double2`. Queries that index past nullable fields should filter
  with `WHERE doubleN > 0` or pull the field by its semantic name
  via the schema reference, not by raw position.
- **Server-side blobs are immutable.** `blob1..blob4`
  (`event_type`, `environment`, `country`, `internal`) are stamped
  by the Pages function. Filter on these for trustworthy slicing —
  client-supplied values are never trusted for tier or environment.
- **Bump the schema version when fields change semantics.** Adding a
  field is non-breaking; renaming, narrowing a type, or changing a
  bucket boundary is. The semver in `TELEMETRY_SCHEMA_VERSION`
  surfaces in `session_start.schema_version` so historical data can
  be filtered out.

## Local development

- **Console mode.** Set `VITE_TELEMETRY_CONSOLE=true` (or pass the
  same to `npm run dev`). Events are logged to the browser console
  instead of POSTed; useful for verifying call-site behaviour
  without standing up Cloudflare.
- **Disabled mode.** Set `VITE_TELEMETRY_ENABLED=false` to compile
  out the entire emitter (`TELEMETRY_BUILD_ENABLED` becomes a
  const `false` and the call sites tree-shake).
- **Tier dev override.** The Tools → Privacy panel writes to
  `localStorage`; flipping it to Research mode lets local dev
  exercise Tier B paths.
- **Inspecting the queue.** `src/analytics/emitter.ts` exposes
  `__peek()` and `size()` for tests. Use them in unit tests; do not
  reach for them in production code.
