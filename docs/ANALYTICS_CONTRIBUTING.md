# Adding analytics events — contributor + reviewer guide

This is the practical "I want to add a new analytics event" guide,
plus the privacy review checklist a human or AI reviewer should
run through before approving the change. Pair with
[`ANALYTICS.md`](ANALYTICS.md) (architecture + schema reference)
and [`PRIVACY.md`](PRIVACY.md) (the user-facing policy that the
posture must match).

> **For AI reviewers (Claude / Copilot / similar):** when reviewing
> a PR that touches `src/analytics/**`, `functions/api/ingest.ts`,
> `src/types/index.ts` (the `TelemetryEvent` union), or any
> `emit({ event_type: ... })` call site, run through the
> "Reviewer checklist" section below explicitly. Flag any item
> you can't positively confirm. If the PR adds a new event,
> require the contributor checklist to be visible in the
> description; reject the PR (or block-comment) if it isn't.

---

## TL;DR contributor checklist

```
[ ] 1. Define an interface in src/types/index.ts that extends
       TelemetryEventBase, append to the TelemetryEvent union.
[ ] 2. Decide tier. Add to TIER_B_EVENT_TYPES if anything in the
       payload could surprise a privacy-sensitive user; default A.
[ ] 3. import { emit } from '../analytics' and call from the
       call site. Don't reach for the queue/batch internals.
[ ] 4. Throttle if the event can fire more than ~30/min per user.
       Pattern: src/analytics/camera.ts:emitCameraSettled.
[ ] 5. Hash any free text via src/analytics/hash.ts.
       Sanitize any error/exception message via
       src/analytics/errorCapture.ts:sanitizeMessage.
       Round any lat/lon to 3 decimals.
[ ] 6. Update docs/ANALYTICS.md (catalog row) and
       docs/ANALYTICS_QUERIES.md (positional layout).
[ ] 7. Update docs/PRIVACY.md if the new event captures any new
       category of signal not already disclosed.
[ ] 8. Add a unit test alongside the call site:
        - happy path
        - tier-gating (Essential drops Tier B)
        - idempotency under double-stop / repeat-emit
[ ] 9. Add a Grafana panel under the appropriate dashboard
       (product-health.json for Tier A, research.json for Tier B).
```

If your PR can't tick every box, explain why in the PR description.

---

## Privacy invariants (read before adding *anything*)

These are non-negotiable and enforced at the emit boundary, the
ingest function, or both. If your event would violate any of them,
the answer is **don't ship that field** — find a privacy-preserving
proxy instead.

### 1. No raw IP addresses

The function reads `CF-Connecting-IP` only for rate-limiting and
discards it. Country comes from Cloudflare's edge GeoIP via
`CF-IPCountry`. **Never add a field that captures a client IP, a
public-facing hostname for the user's network, or anything derived
from the IP beyond country.**

✅ `country: 'US'` (server-stamped, two-letter ISO)
❌ `client_ip: '192.0.2.1'`
❌ `network_owner: 'Comcast'`
❌ `subnet: '192.0.2.0/24'`

### 2. No User-Agent strings

Bucketed signals only. The `src/analytics/session.ts` module
classifies into ≤6-value enums for OS, viewport, aspect, screen.

✅ `os: 'macos'`, `viewport_class: 'wide'`
❌ `user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)...'`
❌ `gpu_renderer: 'Apple M2 Pro / Metal' ` (use the hashed
  `webgl_renderer_hash` instead)

### 3. Free text gets hashed, never sent raw

If your event needs to know whether two users searched for the
same thing, capture a 12-hex SHA-256 prefix. The same input
always hashes the same way; the hash can't be reversed.

✅ `query_hash: '3fb312f8c4f8'` (via `hashQuery()` in
   `src/analytics/hash.ts`)
❌ `query: 'hurricane'`
❌ `chat_message: 'How does Antarctic sea ice work?'`

The corollary: **the analyst can frequency-rank, dictionary-lookup
known candidates, or cross-reference against unhashed metadata —
they cannot read what users typed.** Design events with that
toolset in mind.

### 4. Errors get sanitized, stacks too (if Tier B)

Error messages route through
`src/analytics/errorCapture.ts:sanitizeMessage()`, which strips
URLs, emails, UUIDs, digit runs, and file paths. Tier B
`error_detail` events also include sanitized stack frames —
function names only, no URLs, no line numbers, max 10 frames.

✅ `message_class: 'fetch failed: 504 Gateway Timeout'`
✅ `frames_json: '["fetch","handleLoad","onClick"]'`
❌ `message: 'fetch failed at https://api.example.com/users/12345 with auth=Bearer abc...'`
❌ `stack: 'Error: ...\n  at handleLoad (file:///app/src/handler.ts:42:7)'`

### 5. Lat/lon rounded to 3 decimals (~111 m)

Enough for "what region was the user looking at"; not enough to
geolocate any individual. Done at the emit boundary in
`src/analytics/camera.ts:emitCameraSettled`.

✅ `lat: 37.785, lon: -122.406` (3 decimals)
❌ `lat: 37.78495121, lon: -122.40621843` (full precision = ~1 cm)

### 6. Session ID is in-memory only

Generated at app boot, rotated on every launch, never persisted.
Tier-A consent does not imply persistent identification. If your
event needs to correlate something across sessions, **stop and
discuss in an issue first** — you may be inadvertently building a
re-identification primitive.

✅ Same `session_id` joins events within a single visit
❌ A persisted user ID
❌ A device fingerprint
❌ Localstorage-stored cohort key without the user opting in

### 7. Server stamping is immutable

`blob1..blob4` (`event_type`, `environment`, `country`, `internal`)
are stamped by the Pages Function in `functions/api/ingest.ts:toDataPoint()`.
Clients cannot influence them. Filter on these for trustworthy
slicing in dashboards.

If you find yourself wanting to send `internal: true` from the
client, you've misunderstood the model. Internal-vs-external is
proven via Cloudflare Access SSO at the edge, not declared by the
client.

### 8. Schema additions are append-only

Adding a field is non-breaking. Renaming, narrowing a type, or
changing a bucket boundary IS breaking — bump
`TELEMETRY_SCHEMA_VERSION` in `src/analytics/config.ts` and update
any dashboard query that indexes positionally. The alphabetical
blob/double layout means a new field that sorts earlier than
existing ones shifts every later position.

---

## Choosing a tier

| Question | If yes, it's Tier B (Research, opt-in) |
|---|---|
| Does the event capture *anything* the user typed, said, or chose? | Yes |
| Does it record per-message detail of an Orbit chat exchange? | Yes |
| Does it expose how long the user dwelled on something? | Yes |
| Is it per-frame / per-gesture / sub-second-resolution? | Yes |
| Does the value distribution itself reveal sensitive content? | Yes |
| Is it a sanitized stack trace (vs. just an error category)? | Yes |
| Is it none of the above — a coarse operational counter? | **Tier A** |

When in doubt, default to Tier B. Promoting B → A later is a
schema decision (still ok), but accidentally shipping a
sensitive event as Tier A means it leaked from every user who
didn't opt out. Opt-out is not the right model for sensitive
data.

To make an event Tier B, add its `event_type` to
`TIER_B_EVENT_TYPES` in `src/types/index.ts`. That single edit
gates the event at the runtime emit boundary —
`src/analytics/emitter.ts:tierGate()` reads it as a Set and
short-circuits before queueing.

---

## Throttling

Anything that can fire faster than ~30 events/minute per user
needs a throttle. Two reasons: bandwidth (a queue full of
duplicates wastes the user's bytes) and signal quality (1000
samples of the same gesture aren't 1000x more informative than
30).

Three reference implementations, in increasing complexity:

| Use case | File | Pattern |
|---|---|---|
| Cap one event-type globally | `src/analytics/camera.ts` | One sliding-window array of timestamps; reject if length ≥ cap |
| Cap per-bucket (e.g. per-gesture) | `src/services/vrInteraction.ts` | `Map<bucket, number[]>`; otherwise same as above |
| Sample over a rolling window | `src/analytics/perfSampler.ts` | rAF loop pushes per-frame samples into a window; emit on a separate `setInterval` |

Throttle constants should be exported (`MAX_PER_MINUTE`) so
dashboards know the ceiling. If you set the cap below 30, document
why — the user-perceptible event in question must justify being
rarer than camera-settles.

---

## Worked examples

### ✅ Acceptable: `tour_question_answered`

```ts
export interface TourQuestionAnsweredEvent extends TelemetryEventBase {
  event_type: 'tour_question_answered'
  tour_id: string                  // author-set, not user input
  question_id: string              // author-set, not user input
  task_index: number
  choice_count: number             // 2-4
  chosen_index: number             // which button (0..N-1)
  correct_index: number            // author-set
  was_correct: boolean             // derived
  response_ms: number              // discrete timing
}
```

Tier B because timing-on-question is a reasoning-quality signal
the user might not expect to be measured. All free-text content
(the actual question, the actual answer choices) is image-based
and authored into the tour JSON; we never emit the rendered pixels
or any free-form text.

### ❌ Unacceptable as Tier A: a hypothetical `chat_message_typed`

```ts
// DO NOT SHIP
export interface ChatMessageTypedEvent extends TelemetryEventBase {
  event_type: 'chat_message_typed'
  message: string                  // <-- raw user text, never
  length: number
  contains_question: boolean       // derived from raw text
}
```

Three problems:
1. `message` is raw user text. Even Tier B should not emit raw
   text — hash it.
2. `contains_question` is derived from text the server is now
   privy to via the rendered server-side blob. Even though the
   raw text isn't stored as a column, the derived flag leaks
   information about message *content*.
3. Tier A is wrong; this is exactly the kind of signal Research
   mode exists to gate.

The right shape (if we wanted this signal at all):
```ts
export interface OrbitInteractionEvent extends TelemetryEventBase {
  event_type: 'orbit_interaction'
  interaction: 'message_sent'      // discrete enum, not content
  // ...
  // Content length implicitly bucketed by interaction type;
  // never the message itself.
}
```

### ✅ Acceptable: `vr_interaction` per gesture

```ts
export interface VrInteractionEvent extends TelemetryEventBase {
  event_type: 'vr_interaction'
  gesture: 'drag' | 'pinch' | 'thumbstick_zoom' | 'flick_spin' | 'hud_tap'
  magnitude: number                // rad/s for rotation, log2 for zoom
}
```

Tier B because per-gesture telemetry could fingerprint individual
motor patterns across sessions if combined with timing. Throttled
30/minute per gesture-type. `magnitude` is an aggregate — log2 of
a scale ratio over the gesture, not a per-frame stream. Could not
be reconstructed into a head-pose trajectory.

### ❌ Unacceptable: a hypothetical `head_pose_sample`

```ts
// DO NOT SHIP
export interface HeadPoseSampleEvent extends TelemetryEventBase {
  event_type: 'head_pose_sample'
  yaw: number                      // raw radians
  pitch: number
  roll: number
  position_x: number
  position_y: number
  position_z: number
}
```

Even at Tier B, even throttled — 6-DoF head pose at any
non-trivial sample rate is biometric data that uniquely identifies
individuals. The mitigation isn't "sample rarer", it's "don't
collect this." If we want to know "how often did the user look
around", a counter (`head_movements_per_minute_bucket: 'low' | 'high'`)
gives the same product signal without the biometric leak.

---

## Reviewer checklist

For human reviewers and AI assistants reviewing a PR that touches
analytics. Run through these explicitly; if you can't positively
confirm any item, leave a comment requesting clarification.

### Schema

- [ ] New event has an interface in `src/types/index.ts` extending
      `TelemetryEventBase`, with a string-literal `event_type`.
- [ ] Added to the `TelemetryEvent` discriminated union (so
      type-checking exhaustively covers the new variant).
- [ ] Field names are lowercase + snake_case (the alphabetical
      blob/double layout depends on this).
- [ ] No object or array fields in the payload. The ingest
      function rejects those at validation; any nested data should
      be flattened or hashed at the call site.
- [ ] Schema version bumped if any existing field changed
      semantics (rename, narrow type, change bucket boundaries).

### Tier choice

- [ ] If the event captures user-typed text, per-message timing,
      sub-gesture detail, or anything not in the "coarse
      operational counter" bucket → it's in `TIER_B_EVENT_TYPES`.
- [ ] If Tier B, the disclosure language in `docs/PRIVACY.md`
      covers it. If not, the PR also updates `PRIVACY.md` and
      regenerates `public/privacy.html`.

### Privacy invariants

- [ ] No fields capture IP addresses, hostnames, or anything
      derived from network identity beyond country.
- [ ] No fields capture User-Agent strings or unbucketed
      device-identifying details.
- [ ] Any free-text input is run through
      `src/analytics/hash.ts:hashQuery()` before emission.
- [ ] Any error message / stack trace is run through
      `src/analytics/errorCapture.ts:sanitizeMessage()` before
      emission. Stacks only included in Tier B `error_detail`,
      never Tier A `error`.
- [ ] Any lat/lon coordinates are rounded to 3 decimals.
- [ ] No new persistent identifier (localStorage, IndexedDB,
      cookie) was added that would let events correlate across
      sessions.
- [ ] No client-stamped `internal` / `environment` / `country` /
      `event_type` (those are server-stamped at
      `functions/api/ingest.ts:toDataPoint()`; the function
      strips client-supplied versions).

### Throttling

- [ ] If the event can fire more than ~30/minute per user, it's
      throttled. The throttle constant is exported.
- [ ] If the throttle is per-bucket, the bucket key is bounded
      (e.g. an enum, not user-supplied free text). A user-controlled
      bucket key would let an attacker grow the throttle map without
      bound.

### Tests

- [ ] Happy path — event emits with the expected shape.
- [ ] Tier gating — Essential mode drops Tier B events; Off mode
      drops everything.
- [ ] Idempotency / no double-emit — repeat calls to the same
      lifecycle method don't produce duplicate events.
- [ ] Throttle — exceeding the cap drops without crashing.

### Documentation

- [ ] `docs/ANALYTICS.md` event catalog has a row for the new
      event and its call site file.
- [ ] `docs/ANALYTICS_QUERIES.md` has the positional layout
      (`blob5 = ...`, `double1 = ...`).
- [ ] `docs/PRIVACY.md` mentions the new signal if it captures
      something not already disclosed (and `public/privacy.html`
      regenerated via `npm run build:privacy-page`).
- [ ] At least one Grafana panel surfaces the new event under
      the appropriate dashboard.

### Smoke check

- [ ] Did you actually load the app, trigger the event, and see
      a row land in AE on a preview deploy? "It type-checks" is
      not the same as "it works on the wire."

---

## When to escalate

If your PR introduces any of the following, it's not a regular
review — it's an architectural change that needs explicit sign-off
from project leads:

- A new persistent identifier (anything stored beyond the
  in-memory session ID).
- A new field that captures content the user typed, said, drew,
  or spoke — even if you intend to hash it.
- A new ingest endpoint or a new server-side stamp.
- Anything that changes the meaning of `internal` (the
  staff-vs-public flag).
- A change to the kill switch, the rate limits, or the
  CORS allowlist.

Open a GitHub discussion before opening the PR. Ten minutes of
"is this even the right thing" up front saves a week of "we need
to revert and re-architect."

---

## When in doubt, ask

There is no penalty for asking "is this OK to capture?" before
shipping. There is significant penalty (legal, reputational,
trust) for shipping a sensitive signal and finding out only
because a user notices and complains. The asymmetry strongly
favours pausing.

For Anthropic-internal: ping the privacy-eng channel.
For external contributors: open a discussion on the repo. Tag the
maintainer team. Wait for a thumbs-up before merging.

---

## See also

- [`ANALYTICS.md`](ANALYTICS.md) — schema reference, pipeline
  overview, schema-evolution rules
- [`ANALYTICS_QUERIES.md`](ANALYTICS_QUERIES.md) — per-event
  positional layout + sample SQL
- [`PRIVACY.md`](PRIVACY.md) — the user-facing policy your event
  must not contradict
- [`SELF_HOSTING.md`](SELF_HOSTING.md) — for forks deploying
  their own instance
