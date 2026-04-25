# Privacy Analysis — Terraviz Telemetry Pipeline

> **Audience.** Privacy researchers, external auditors, and
> security-skeptical reviewers who want to verify the claims in
> [`PRIVACY.md`](PRIVACY.md) against the implementation. This document
> is an *analysis*, not a policy: where the design holds, it explains
> *why* in quantitative terms; where it falls short, it says so
> plainly. The user-facing policy is the deliverable; this file is the
> footnote stack behind it.
>
> **Scope.** Only the automatic telemetry stream — the Tier A
> ("Essential") and Tier B ("Research") events emitted by
> `src/analytics/` and ingested by `functions/api/ingest.ts`. The
> separately-consented surfaces (Orbit chat, feedback submissions,
> crash reports) are governed by `PRIVACY.md` §4–§5 and are out of
> scope here.
>
> **Authoritative sources.** The schema lives in
> `src/types/index.ts` (the `TelemetryEvent` discriminated union,
> lines 596–1067). The runtime gate lives in
> `src/analytics/emitter.ts:tierGate()`. The server-side stamping
> lives in `functions/api/ingest.ts:onRequestPost()`. Where this
> document and any other doc disagree, the source code wins.

---

## 1. Threat model

A privacy claim is meaningless without a stated adversary. We
analyse three concrete scenarios. The pipeline's design choices
should be evaluated against each.

### 1a. External observer of the public dataset

**Capability.** Read-only access to whatever subset of the
Workers Analytics Engine (AE) dataset Zyra-Project chooses to
publish — for example, an aggregate dashboard, a CSV export
attached to a research paper, or a leaked snapshot. No knowledge
of who any particular `index1` (session id) belongs to.

**Goal.** Re-identify users, profile individuals, or recover
free-text inputs (search queries, error messages).

**What this adversary has.**

- The full row-level event stream, including every
  `session_start` enrichment, every rounded lat/lon, every
  hashed search query, every sanitised error message.
- The ability to join rows by `index1` within a session.
- Public knowledge: census-style demographic distributions,
  English / multi-lingual dictionaries, web-search trend lists,
  known dataset and tour IDs from the public catalogue.

**What this adversary does not have.** Cloudflare logs (no
IPs), session-id-to-identity mappings (none exist), feedback /
chat content (separate D1 database, separate consent),
client-side storage (`localStorage` lives on the user's device).

This is the most realistic threat. Sections §2–§5 quantify
what they could recover.

### 1b. Cloudflare insider with full edge access

**Capability.** A compromised or malicious Cloudflare employee
with read access to edge logs (CF-Connecting-IP, raw User-Agent,
Cloudflare Access SSO logs) plus everything Adversary 1a has.

**Goal.** Identify a specific Terraviz user from real-world
attributes (IP, geographic precision, login email).

**What changes.** The `session_id ↔ IP` mapping is recoverable
from edge logs even though we do not write IPs to AE
(`functions/api/ingest.ts:361` reads `CF-Connecting-IP` for
rate-limiting and discards it; the rate-limit map is
in-memory per-isolate, but Cloudflare's own access logs are
their own product). With the IP, an insider can subpoena an
ISP, correlate with other Cloudflare-fronted properties, or
look up the request in Cloudflare Access logs to recover the
authenticated email when `internal=true`.

This adversary defeats almost any privacy property we can
unilaterally provide. We acknowledge this in §9 ("Cloudflare
itself is a trusted party"); the only mitigations available to
us are policy (Cloudflare's own Article 28 controls) and
running a self-hosted instance (see [`SELF_HOSTING.md`](SELF_HOSTING.md)).

### 1c. Targeted re-identification — "does Alice use Terraviz?"

**Capability.** Adversary 1a's data plus side-channel knowledge
of Alice — her country, approximate device class (e.g.
"she has a 4K Mac"), browser locale, and possibly a known
window of activity ("she demoed Terraviz at a meeting on
2026-04-15 14:00 UTC").

**Goal.** Confirm or deny whether Alice's session is in the
dataset, and if so, recover what she looked at.

This is the hardest test: not "can I de-anonymise everyone?"
but "given a known person, can I confirm their participation?"
Section §3 (quasi-identifier analysis) addresses this case in
detail.

---

## 2. Field-by-field entropy budget

We use Panopticlick / EFF browser-fingerprinting methodology:
every field is scored in *bits of identifying information*
relative to the overall population of users. A field with `k`
equally-likely buckets contributes `log₂(k)` bits at maximum;
real-world distributions are skewed, so *effective* entropy
(the Shannon entropy of the empirical distribution) is
typically lower. The classic threshold for individual
identification on the public web is ~33 bits (Eckersley, 2010);
below that, a record sits in a non-trivial anonymity set.

### 2a. `session_start` — the worst-case event

This event carries the densest concentration of fingerprintable
fields in the entire schema (`src/types/index.ts:688–716`).
Per-field budget:

| Field | Bucket count | Max bits (`log₂ k`) | Effective bits (skewed) | Source line |
|---|---|---|---|---|
| `platform` | 3 (web/desktop/mobile) | 1.58 | ~0.8 (web dominates) | types.ts:639 |
| `os` | 6 | 2.58 | ~2.0 | types.ts:640, session.ts:148 |
| `locale` | ~200 BCP-47 tags | ~7.6 | ~4.0 (en-US ~50%) | session.ts:181 |
| `viewport_class` | 5 (xs–xl) | 2.32 | ~2.0 | types.ts:641, session.ts:187 |
| `aspect_class` | 6 | 2.58 | ~2.2 | types.ts:646, session.ts:201 |
| `screen_class` | 5 | 2.32 | ~2.0 | types.ts:649, session.ts:218 |
| `vr_capable` | 4 | 2.0 | ~0.5 (`none` ≈ 95%) | types.ts:656 |
| `build_channel` | 3 | 1.58 | ~0.05 (`public` ≫ rest) | types.ts:655 |
| `app_version` | ~5–10 active | ~2.5 | ~2.0 | session.ts:121 |
| `schema_version` | 1–2 active | ~1.0 | ~0.2 | session.ts:66 |
| **server-stamped `country`** | 250 ISO codes | ~7.96 | ~5.5 (US/EU skew) | ingest.ts:206 |
| **server-stamped `internal`** | 2 | 1.0 | ~0.05 (rare) | ingest.ts:232 |
| **server-stamped `environment`** | 3 | 1.58 | ~0.0 (filtered to prod) | ingest.ts:195 |

**Sum, effective.** ≈ **20.8 bits** for a typical session.

**Per Eckersley.** ~33 bits singles out a user globally. ~20.8
bits puts a session in an anonymity set of order
2^(33−20.8) ≈ 2^12 ≈ 4,700 users *of the same configuration in
the same country*. That is, an external observer cannot
single out an individual from `session_start` alone unless
the population of Terraviz users in that anonymity bucket
is small.

**Compared with raw fingerprinting.** A typical browser leaks
~18 bits via raw User-Agent alone (Eckersley 2010, Table 3),
plus another ~10 bits from raw screen resolution + window size,
plus ~5 from time zone. Terraviz's session_start replaces
those with bucketed equivalents and never reads time zone,
exact resolution, or User-Agent into storage
(`session.ts:147` consults `navigator.userAgentData.platform`
where available, otherwise pattern-matches a substring; the
raw UA never leaves the function). The budget gap is real:
the same browser on raw fingerprinting leaks ~33 bits; via
this pipeline it leaks ~21.

### 2b. Other Tier A events — incremental entropy

After `session_start`, every subsequent event in the same
session re-emits the session id (`index1`) but no new
fingerprintable identity fields. It does add behavioural
entropy. Per-event:

| Event | Identifying fields beyond `session_id` | Notes |
|---|---|---|
| `session_end` | `exit_reason` (3 vals), `duration_ms`, `event_count` | Behavioural; ~5–10 bits over the session |
| `layer_loaded` / `layer_unloaded` | `layer_id` (~50 datasets), `trigger`/`reason` | ~6 bits per load; **sequence** is the main fingerprint |
| `camera_settled` | rounded lat/lon (~3 decimals), zoom, bearing, pitch | See §2c — the high-volume event |
| `map_click` | rounded lat/lon, `hit_kind`, `hit_id` | Same lat/lon precision as camera |
| `viewport_focus` / `layout_changed` | `layout` (3 vals), `slot_index` | <2 bits each |
| `playback_action` | `action` (4 vals), `playback_time_s`, `playback_rate` | Trajectory data |
| `settings_changed` | `key`, `value_class` | Free-form `key` namespace; finite at call sites |
| `browse_opened` / `browse_filter` | `source` (3), `category`, `result_count_bucket` | <6 bits |
| `tour_*` | `tour_id`, `task_index`, `task_dwell_ms` | Funnel data; ~5 bits per tour |
| `vr_session_started` / `_ended` / `_placement` | `mode`, `device_class`, `entry_load_ms`, `mean_fps` | `device_class` is a free string — see §9 |
| `perf_sample` | `surface`, `webgl_renderer_hash` (8 hex) | See §2d for the GPU hash |
| `error` | `category`, `code`, sanitised `message_class` (≤80 chars) | See §2e |
| `feedback` | `kind`, `rating`, `status` | <3 bits |

### 2c. The lat/lon volume problem

`camera_settled` is the densest spatial event:
`src/analytics/camera.ts:92–93` rounds lat/lon to 3 decimals.
The throttle (`CAMERA_SETTLED_MAX_PER_MINUTE = 30`,
`camera.ts:26`) caps emission at **30 events / rolling
minute / session**, shared across 2D + VR.

A 60-minute session can therefore generate up to 1,800
`camera_settled` rows. Each row carries ~36 bits of *raw*
spatial information (`log₂(360 000 × 180 000)` lat/lon cells
at 3-decimal precision). Empirical lat/lon distributions are
heavily clumped (users spend most of their attention on a
handful of regions), so per-row *effective* entropy is closer
to 12–15 bits — but the **trajectory** (the ordered
sequence) is a strong behavioural fingerprint even when each
single point is not.

This is the most important honest finding in this document.
A single rounded lat/lon does not geolocate the user (the
camera points to wherever they navigated, which is not where
they are), but a 1,800-row session-scoped *trajectory* is
distinctive enough to act as a session-fingerprint across
subsequent visits if the same user repeats characteristic
exploration patterns. See §3 and §9.

### 2d. `webgl_renderer_hash`

`perf_sample.webgl_renderer_hash` is the first 8 hex chars
(32 bits) of SHA-256 over the `WEBGL_debug_renderer_info`
string (`types.ts:929`). The pre-image is a finite, well-known
set: there are perhaps a few hundred distinct GPU strings in
common circulation. 32 bits of hash space is ample to separate
them, and an adversary with the AE dataset and a list of
candidate GPU strings can fully invert this hash. We do not
treat it as cryptographic; it is a stable bucketing key for
"which GPU class are we measuring FPS on?" The privacy
contribution is ~6–8 effective bits (GPU model is *correlated*
with platform/screen, not independent).

### 2e. Error fields

`error.message_class` is sanitised by `sanitizeMessage()`
(`errorCapture.ts:232–281`) and capped at 80 chars
(`MESSAGE_CLASS_MAX = 80`, line 42). The sanitiser strips
URLs, emails, UUIDs, file paths, and digit runs of length ≥ 6
before truncation. Effective entropy depends on how many
distinct sanitised classes exist in production; observationally
this is ~10–100 (~3–7 bits). The Tier B `error_detail` event
adds `frames_json` — a list of up to 10 function names from
our own code only (`errorCapture.ts:336`, `MAX_FRAMES = 10`).
Function-name entropy is bounded by the size of the codebase,
~10–20 bits per stack signature.

### 2f. Bucketed enums vs continuous values

A recurring design choice across `session.ts` is to bucket
*before* emit rather than emit the raw value. `viewport_class`
is 5 buckets (`xs/sm/md/lg/xl`) instead of `window.innerWidth`
because the raw width on, say, a power user's 1437×892 window
is *uniquely identifying among Terraviz sessions*, while the
bucket `md` is shared with millions of users. This is a
straight Shannon-entropy reduction: the raw value carries
~10 bits; the bucket carries ~2.

The same logic applies to `aspect_class`, `screen_class`,
`os` (family only, never version), `country` (ISO-2 instead
of city), and lat/lon (3 decimals instead of 6). Each of
these is a deliberate decision to **trade analytic
resolution for k-anonymity**.

---

## 3. Quasi-identifier analysis

Per §2a, no single field is a direct identifier. The classical
re-identification literature (Sweeney 2002; Narayanan and
Shmatikov 2008) repeatedly shows the danger comes from
*combinations* of weak quasi-identifiers, not from any one
field. We examine three combinations that the AE schema
permits.

### 3a. `session_start` quasi-identifier set

Take the seven enrichment fields plus server-stamped country:

```
{ platform, os, locale, viewport_class, aspect_class,
  screen_class, vr_capable, country }
```

Worst-case Cartesian product:
3 × 6 × 200 × 5 × 6 × 5 × 4 × 250 ≈ 5.4 × 10⁹ unique tuples.

But the empirical distribution is *not* uniform. The dominant
bucket is plausibly something like
`(web, windows, en-US, lg, landscape, 1080p, none, US)` —
that bucket alone contains millions of equivalent users in
the broader web. For Terraviz specifically, with a smaller
user population, the *effective* anonymity-set size for a
typical record is roughly 10²–10⁴ (computed against the
anonymity tables from Eckersley 2010, scaled by an assumed
~10⁵ active users).

For users in **rare buckets** the picture changes. A user
with `(desktop, linux, lt-LT, xl, ultrawide, 4k+, both, LT)`
is plausibly *the only such user in the dataset* — `k = 1`.
This is the classic critique of demographic-bucket anonymity:
the median user is safe; the tail is not.

### 3b. Adding behavioural events

Joining `session_start` with **N** subsequent events of the
same `index1` raises the effective entropy. A well-studied
result for camera-trajectory data (Krumm 2007 on raw GPS
traces; the result transfers to coarsened lat/lon) is that
**4 spatio-temporal points uniquely identify ~95% of
individuals** in a metropolitan area with 15-minute / 1km
resolution. Our resolution is 3-decimal-degrees lat/lon
(~111 m) plus event timestamp (server-side, sub-second) — much
finer than the 1km / 15-min benchmark.

The countervailing factor is that camera lat/lon ≠ user lat/lon.
The user is wherever they are; the camera points wherever they
clicked or panned. So the trajectory does not directly
geolocate the user. What it *does* identify is a session: a
pattern of "always opens the IPCC dataset, always pans to
South Asia, always zooms to z=4" is a behavioural fingerprint
that survives the in-memory session id rotation and could
link sessions belonging to the same user across launches. This
is the main observed weakness — see §9 (gap analysis).

### 3c. The "Alice" attack (Adversary 1c)

Concretely: if the adversary knows
- Alice is in Iceland (population ~370,000)
- Alice has a 4K Mac
- Alice opened Terraviz between 14:00 and 14:15 UTC on a given day

… then they query the AE dataset:

```sql
SELECT index1 FROM terraviz_events
WHERE blob1 = 'session_start'
  AND blob3 = 'IS'        -- country
  AND blob9 = 'mac'       -- os
  AND blob13 = '4k+'      -- screen_class
  AND timestamp BETWEEN '2026-04-15 14:00:00'
                    AND '2026-04-15 14:15:00'
```

The Iceland-Mac-4K cohort during a 15-minute window is
plausibly a single session. From that `index1`, the adversary
recovers every Tier A event Alice fired: layers loaded,
camera trajectory, errors. Tier B (research mode) on top of
that recovers `dwell` and `browse_search`.

This attack succeeds. It is the worst case, but it is not
hypothetical, and §9 enumerates the only structural
mitigations available: aggressive country bucketing for
small-population countries, dropping or further-bucketing
`screen_class` outside dominant buckets, or k-anonymity-style
post-hoc filtering at the query layer (see §10).

### 3d. The internal-staff slice

`internal=true` (server-stamped from Cloudflare Access SSO
presence; `ingest.ts:222–238`) is a *very* small subset of
traffic. A query filtered to `blob4='true'` gives the
dogfood-only slice, where every record belongs to a member
of the Zyra-Project team. This is intentional — it keeps
internal usage out of public dashboards — but it also means
"the internal slice" is highly re-identifiable to anyone
who knows the team's roster. We accept this: staff dogfood
implicitly consents to being identifiable to the team.

---

## 4. Cryptographic argument for `hashQuery`

`browse_search.query_hash` is the most-cited privacy
mechanism in the policy. The implementation
(`src/analytics/hash.ts:33–48`) is:

```ts
const HASH_LENGTH_HEX = 12   // line 17 — 48 bits
const normalized = input.trim().toLowerCase()
const digest = await crypto.subtle.digest('SHA-256', bytes)
return hex.slice(0, HASH_LENGTH_HEX)
```

Three properties matter: collision resistance, irreversibility,
and identifier stability.

### 4a. Collision resistance (birthday bound)

48 bits of hash space ⇒ 2⁴⁸ ≈ 2.81 × 10¹⁴ buckets. The
birthday-collision probability for `n` distinct queries is
`P(collision) ≈ 1 − e^(−n²/(2·2⁴⁸))`.

Solving for the 1% threshold:

```
n² / (2·2⁴⁸) ≈ 0.01
n² ≈ 5.63 × 10¹²
n ≈ 2.37 × 10⁶
```

So we expect **~1% collision probability at ~2.4 million
distinct queries**. The comment at `hash.ts:9–10` states
"~10⁷ distinct queries before birthday-collision risk hits
~1%" — this is **slightly optimistic by ~4× ** (10⁷ queries
yields ~16% collision probability, not 1%). For the realistic
cardinality of a niche Earth-science dataset viewer
(plausibly 10³–10⁴ distinct queries before the long tail) the
collision probability is < 10⁻⁵, well within tolerance for the
"common search aggregation" use case the field exists to
support. Recommend correcting the comment (see §11).

### 4b. Irreversibility — and the dictionary attack

This is where the design's honest limit lives. SHA-256 is a
one-way function in the cryptographic sense, but truncation
to 48 bits **does not** add cryptographic privacy: an
adversary who controls candidate-input space can simply hash
each candidate and look up matches in our dataset.

Concretely, for an adversary with a copy of the `browse_search`
table:

1. Take an English-language wordlist (Oxford ≈ 170 k headwords;
   add common dataset names, place names, NOAA layer titles —
   call it 5 × 10⁵ candidates total).
2. Compute SHA-256 over each, truncate to 12 hex.
3. Join against our `query_hash` column.

Modern GPUs hash ~10¹⁰ SHA-256/sec. Five hundred thousand
candidates completes in under a millisecond. False-positive
rate per dictionary entry is `5 × 10⁵ / 2⁴⁸ ≈ 1.8 × 10⁻⁹` —
i.e. essentially zero. **The truncation provides no defence
against this attack for queries that are dictionary words or
common phrases.**

What the truncation *does* defend against:

- **Casual / accidental disclosure.** Anyone reading a
  dashboard cell sees `4f8e2d61c0a9`, not `hurricane katrina`.
  This eliminates the "low-effort grep" failure mode.
- **Long-tail queries.** A query that is unique to a single
  user (e.g. their own surname mistyped into the search box)
  is still recoverable by an adversary who *guesses* the
  pre-image, but they have to guess. There is no rainbow
  table for unindexed strings.
- **Adversaries without dataset access.** The truncation is
  irrelevant to them; they have nothing to invert.

So the honest framing is: `hashQuery` is **a serialisation
choice**, not a cryptographic privacy primitive. It removes
plaintext from the storage layer, which is meaningful against
casual access; it does not defeat a determined adversary with
candidate generation. See §9.

### 4c. Identifier-stability concern

A 48-bit truncation is *just barely* short enough that the
hash itself is not a stable cross-session identifier of the
*query* (collisions become non-trivial at population scale).
But the design's privacy property does not actually require
collision resistance — quite the opposite, occasional
collisions help anonymity. The 48-bit length was chosen to
balance "small enough that it can't be used as a persistent
identifier" against "large enough to count distinct queries
in dashboards" (`hash.ts:6–10`). That balance is correct in
principle; the comment's collision-rate quote is the only
thing wrong with it.

---

## 5. Spatial precision argument for lat/lon rounding

`camera.ts:92–93` rounds `center_lat` and `center_lon` to 3
decimal places before emit; `mapRenderer.ts:444–445` does the
same for `map_click`. At the equator:

| Decimals | Cell size (≈) | Notional resolution |
|---|---|---|
| 6 | 0.11 m | sub-floor-tile |
| 5 | 1.1 m | desk |
| 4 | 11 m | building footprint |
| **3** | **111 m** | city block |
| 2 | 1.11 km | neighbourhood |
| 1 | 11 km | suburb |
| 0 | 111 km | metropolitan area |

Three decimals sits **above** building-level (~10 m),
**above** block-level (~50 m), and **at** the upper end of
neighbourhood-level (~500 m). It is enough to say "the user
was looking at Manhattan", not enough to say "the user was
looking at the lobby of the Empire State Building".

### 5a. What a single point reveals

If the policy claim were "we record where the user *is*" then
3-decimal lat/lon would be a problem — 111 m readily
geolocates a residence in low-density suburbs. But the
field documents **where the camera points on the globe**,
not where the user sits. We do not request
`navigator.geolocation`, do not read GPS, and do not infer
location from IP at the level of lat/lon — only the 2-letter
country code from `CF-IPCountry` (`ingest.ts:206`).

A single rounded lat/lon therefore reveals **what region of
Earth the user wanted to look at**, which is the entire
analytic value of the data ("Hurricane Katrina view counts
by Gulf-coast longitude"). It does not reveal where the user
is.

### 5b. What an aggregated trajectory reveals

The policy claim is more vulnerable when one user's session
trajectory is examined in aggregate. As established in §3b,
4–10 ordered camera points at 111 m resolution are enough
to fingerprint a session distinctively. So the aggregate
*does* leak more than each point individually: **a user's
exploration habits are a behavioural signature**.

Concretely:
- A teacher who consistently demos
  `(latitude=29.95, longitude=-90.07, zoom=8)` from the same
  school is a distinct heatmap pattern.
- A researcher who always centres on their study region
  ("user X always looks at Greenland between z=5 and z=7")
  is recoverable as the dominant session-cluster for that
  bounding box.

Mitigation today: we do not provide a session-trajectory
join in any public-facing dashboard, and the AE dataset is
not currently exported externally. If that changes —
particularly for the open-research data export referenced in
`PRIVACY.md` §7 — section 11 lists hardenings to consider.

### 5c. Cross-checking the throttle budget

`CAMERA_SETTLED_MAX_PER_MINUTE = 30` (`camera.ts:26`) caps
emit rate. A 60-minute session ⇒ 1,800 max points. A
24-hour active session ⇒ 43,200 max points (well past the
4–10-point uniqueness threshold). The throttle is a network
/ storage budget, not a privacy budget; the trajectory is
identifying long before the throttle bites.

---

## 6. The session-ID design decision

`generateSessionId()` (`config.ts:79–86`) produces a UUID v4
via `crypto.randomUUID()` (122 bits of randomness; falls back
to a Math.random-based UUIDv4 for environments without
`crypto`). It is **in-memory only** — never written to
`localStorage`, `IndexedDB`, cookies, the keychain, or any
other persistence (`emitter.ts:121`, comment at lines 76–86 of
`config.ts`). It is regenerated at every module load.

### 6a. Alternatives considered

| Design | Privacy property | Why rejected |
|---|---|---|
| Cookie-based session id | Persists across launches; can be tied to other cookies | Legally a "tracker"; triggers consent banners; defeats the no-cookies promise in `PRIVACY.md` §3 |
| First-party browser fingerprint | Stable across launches without cookies | Even harder to disclose / opt out; classic Panopticlick attack vector |
| Hashed-IP id | Server-side, no client storage | Collides on shared NAT; ties identity to address; Cloudflare insider can invert |
| **In-memory UUID v4 (chosen)** | Only links events within one launch | Loses returning-user analytics |

### 6b. The analytic cost

We cannot answer:
- "How many users are returning vs new?" — every launch is a
  fresh `index1`.
- "Day-7 retention." — same.
- "Funnel attribution across sessions." — same.

We *can* answer:
- "How many sessions today?" (≈ daily active sessions, not
  users)
- "How many sessions per platform / country / dataset?"
- "What is the dropout funnel within a single session?"

This is a deliberate trade. The product question "are people
coming back?" is answered approximately via session-rate
trends rather than literal cohort retention. For most product
decisions (do layers load, are tours completed, are datasets
discoverable) within-session funnels are sufficient.

### 6c. Privacy gain

In-memory rotation gives three concrete properties:

1. **No cross-session linkage in our data.** Two visits by
   the same user appear as two unrelated `index1` rows.
   Adversary 1a cannot join.
2. **No persistent tracker on the device.** Power loss,
   reload, or even a JS module re-import rotates the id.
   No "supercookie" risk.
3. **Right-to-erasure becomes near-trivial.** Anonymous
   data outside any user-controlled identifier is, under most
   regulatory frameworks (§10), not personal data at all —
   so deletion requests reduce to "delete the
   feedback/Orbit-rating row keyed by your text", not
   "find every event you ever fired".

The privacy gain is meaningful and structural. The analytic
loss is real but tolerable for a viewer-style product. Given
that retention-style metrics are not in the product roadmap
and Tier A is intended for *health* signals (does the build
work) rather than *engagement* signals (do users come back),
we judge the trade correct.

---

## 7. Tier A vs Tier B — is the partition principled?

`TIER_B_EVENT_TYPES` (`src/types/index.ts:623–634`):

```ts
export const TIER_B_EVENT_TYPES = [
  'dwell',
  'orbit_interaction', 'orbit_turn', 'orbit_tool_call',
  'orbit_load_followed', 'orbit_correction',
  'browse_search',
  'vr_interaction',
  'error_detail',
  'tour_question_answered',
] as const
```

Walking each:

- **`dwell`** (Tier B). Carries `view_target` + `duration_ms`.
  Knowing how long someone stared at the chat panel vs the
  browse panel is a *behavioural intensity* signal — useful
  for UX research, intrusive enough to warrant opt-in.
  Particularly because dwell ticks fire frequently and the
  combined sequence can fingerprint sessions. **Correctly
  Tier B.**

- **`orbit_interaction` / `orbit_turn` / `orbit_tool_call` /
  `orbit_load_followed` / `orbit_correction`** (Tier B). Even
  though the chat *content* is never part of telemetry,
  per-message metadata (timing, tokens, finish_reason,
  reading_level, model) is per-message. The user is having a
  back-and-forth with an AI; their pacing, retry behaviour,
  and rephrasing habits are inherently personal. The opt-in
  bar matches the policy promise that Orbit metadata is
  research-grade only. **Correctly Tier B.**

- **`browse_search`** (Tier B). Even after hashing (§4), it
  is search-input data. Hashing protects against casual
  disclosure but not determined adversaries; placing it
  behind opt-in adds defence-in-depth. **Correctly Tier B.**

- **`vr_interaction`** (Tier B). Per-gesture, throttled.
  Magnitudes of pinch / flick / drag are biomechanical
  signals; while not literally identifying, they fall into the
  "behavioural-fingerprint surface" we want users to
  knowingly opt into. **Correctly Tier B.**

- **`error_detail`** (Tier B). Adds sanitised stack frames on
  top of `error`. Stack frames are sanitised
  (`errorCapture.ts:368–386`) — function names from our own
  code only, no URLs, no line numbers — but a stack
  fingerprint can identify *which version of which library*
  the user is running, which is incremental fingerprinting
  signal. **Correctly Tier B.**

- **`tour_question_answered`** (Tier B). Author-set
  `question_id`, `chosen_index`, `correct_index`, `was_correct`,
  `response_ms`. The *quiz answers* themselves are not
  personally identifying, but the policy treats *educational
  performance data* with extra care because of children's-
  education contexts (`PRIVACY.md` §9). **Correctly Tier B.**

### 7a. Are any Tier A events arguably Tier B?

Two candidates we examined:

- **`map_click`** carries lat/lon at the same precision as
  `camera_settled` and is plausibly more discretionary (a
  click is a deliberate engagement). It is currently Tier A.
  Because it is bursty rather than continuous, the
  trajectory-fingerprint risk is lower than for
  `camera_settled`. Reasonable to leave at Tier A; flagging
  for future review if click volume per session grows.

- **`feedback`** (Tier A) records `kind` (`bug` / `feature` /
  `other` / `thumbs_up` / `thumbs_down`) and `rating`. It
  contains no free text and no identifying material; the
  *content* of a feedback submission lands in a separate D1
  table under the consented-feedback flow (`PRIVACY.md` §5).
  The Tier A telemetry record is just an aggregate count.
  **Correctly Tier A.**

### 7b. Are any Tier B events arguably Tier A?

`tour_question_answered` is borderline — it carries no
identifying material on its own and the analytic value
(spotting bad / confusing quiz questions) is high. We accept
the conservative classification on the grounds that
educational-performance analytics deserve explicit consent
even when the underlying record is benign.

The partition is principled. It maps to the underlying
question "did the user opt into being studied as a *behaviour*
rather than just counted as a *crash-free session*?" — Tier B
is "studied behaviourally", Tier A is "counted operationally".

---

## 8. Server-side stamping integrity

Four blob positions are stamped at the edge by
`functions/api/ingest.ts:onRequestPost()`, never accepted
from the client:

| Field | Position | Source | Rationale |
|---|---|---|---|
| `event_type` | `blob1` | client → re-emitted at `toDataPoint()` | Strictly speaking the client supplies it, but it is validated against `KNOWN_EVENT_TYPES` (`ingest.ts:65–76`) — unknown types are rejected before write. |
| `environment` | `blob2` | `environmentOf(env)` reads `CF_PAGES_BRANCH` | A client cannot impersonate `production` to flood prod dashboards. |
| `country` | `blob3` | `CF-IPCountry` header from Cloudflare edge | A client cannot supply a forged country. The raw IP is read for rate-limiting and immediately discarded; `CF-IPCountry` is the only geo-derived field that lands in storage. |
| `internal` | `blob4` | `isInternalRequest()` checks Cloudflare Access SSO headers | A client cannot claim staff identity. The email itself (`cf-access-authenticated-user-email`) is read for *presence only* — we never write its value (`ingest.ts:222–238`). |

### 8a. What attacks does client stamping enable?

If `country` were client-supplied:

1. A vandal could bulk-fire events with `country='US'` to
   pollute the US slice of dashboards, manufacturing a
   false-spike during a release window.
2. An attacker pretending to be in a small-population
   country (`country='LI'`, Liechtenstein) could shrink the
   effective k-anonymity bucket of legitimate users in that
   country (because their fake events crowd the same
   bucket — actually this *increases* k, slightly defending,
   but the attack pattern is real for opposite reasons:
   filtering out the staff.)
3. An adversary could supply mismatched `country` /
   `environment` to evade the default
   `WHERE blob2='production' AND blob4='false'` filter
   used in every public-facing query
   (`ANALYTICS_QUERIES.md` §"Default filters").

Server stamping defeats all three. Trustworthy edge headers
(Cloudflare strips client-supplied versions of
`CF-Connecting-IP`, `CF-IPCountry`, and Cloudflare Access
headers before they reach the function) are the foundation of
the integrity story. If we ever migrated to a non-Cloudflare
edge, this entire integrity argument would need re-derivation.

### 8b. Trust boundary for the integrity argument

The boundary is precisely Cloudflare's edge. Inside that
boundary the headers are trusted; outside it (including any
hop within Cloudflare's *own* infrastructure to which a
malicious insider has access) the trust does not extend. This
is a deliberate scope choice. See §1b for the insider-threat
discussion.

---

## 9. Honest gap analysis

The design is solid against Adversary 1a (external observer)
in the median case. The honest gaps:

### 9a. `browse_search` is dictionary-recoverable

Per §4b, an adversary with full dataset access plus a
candidate-input list can recover almost any
dictionary-pre-image search query. The 12-hex truncation
defends against casual disclosure but not active inversion.
**Severity: medium.** Mitigated by the dataset never being
externally exported in raw form, but listed here because the
gap is structural — no matter the truncation length, *any*
deterministic hash with public candidate space is invertible.
Actual cryptographic privacy here would require keyed HMAC
with per-day rotating keys (so historical data becomes
irrecoverable when the key rolls), or differential privacy.

### 9b. Behavioural fingerprinting via camera trajectory

Per §3b and §5b, a 1,800-point-per-hour
`camera_settled` trajectory is distinctive enough to act as
a session-identifier even without `index1`. Two sessions
from the same user that share characteristic trajectory
patterns (always opens IPCC, always pans to a teaching
region) can be linked by an adversary willing to do the
analysis. **Severity: medium.** No mitigation today; possible
hardenings in §11.

### 9c. Quasi-identifier risk for low-population countries

Per §3c, the `(country, os, screen_class, ...)` tuple gives
`k=1` for outliers in small-population countries.
**Severity: low–medium**, depending on Terraviz's actual
distribution; if usage is dominantly US/EU the long tail is
small, but the gap is real for the rare user.

### 9d. The error sanitiser is regex-based

`sanitizeMessage()` (`errorCapture.ts:232–281`) strips URLs,
emails, UUIDs, paths, and digit runs ≥ 6 — all via regex. A
determined leak (e.g. an error message that embeds a
base64-encoded payload, a hex-encoded UUID without dashes, a
non-ASCII path or Cyrillic identifier, a query-string
parameter embedded inside an unrelated string) can slip past
the patterns. The `MESSAGE_CLASS_MAX = 80` truncation is the
backstop, but it is a length cap, not a content filter.
**Severity: low** in practice — the universe of error
messages we generate is small and reviewable — but the gap
is structural to regex sanitisation. A test suite that fires
known-leaky strings through `sanitizeMessage` and asserts
they come out clean would help; we do not have one
specifically for adversarial inputs.

### 9e. In-memory session ids do not stop behavioural linkage

Per §6 and §9b, rotating `index1` per launch does not stop a
determined re-identification attempt that uses *behaviour*
as the linking key. The session id is a *user-side*
mitigation, not a *content-side* one. The privacy claim
"sessions are unlinked" is true at the data-store level,
true at the routine-query level, *defeasible* with
behavioural analysis.

### 9f. Cloudflare is a trusted party

§1b. We rely on Cloudflare's edge to honestly strip forged
headers, geolocate IPs, gatekeep Access SSO, and not log
analytics traffic in ways that would re-link IP to session.
A Cloudflare compromise — at the edge or at the AE storage
layer — defeats all of our privacy properties simultaneously.
We accept this; self-hosting is documented as the path for
parties unwilling to extend that trust.

### 9g. `device_class` on VR session events is a free string

`VrSessionStartedEvent.device_class` (`types.ts:894`) is
typed as `string`, not an enum. The intent at the call site
is to bucket — "Quest 3", "Vision Pro", etc. — but the type
does not enforce a closed list. A future call site that
emits the raw `XRSystem` model identifier would emit a
high-entropy fingerprint string. **Severity: low** today
(the string set is small and known); **structural risk:
medium** because there is no compile-time gate against
expanding it.

### 9h. `webgl_renderer_hash` is invertible

§2d. 32-bit truncation of a finite (~hundreds of GPUs)
input space is fully recoverable. The privacy claim is "GPU
bucket" not "GPU obfuscation"; this is documented in the
schema comment but worth re-stating: the hash is *not*
cryptographic.

### 9i. `app_version`, `schema_version`, and release timing

A user who ran a canary build during the canary window is
identifiable as a canary tester. Combined with `country`
this can be `k=1` if the canary cohort is small. The
`build_channel` enum is the right shape; the gap is purely
that very-small build channels (~10 canary testers) are
trivially singling-out.

### 9j. `settings_changed.key` is open-namespace

`SettingsChangedEvent.key` is a string (`types.ts:805`). The
call sites use a fixed enum in practice but the type does
not enforce it. A future call site that passes user input
into `key` would emit free text. Same shape of risk as 9g.

---

## 10. Comparison to formal frameworks

### 10a. k-anonymity

Sweeney's k-anonymity holds when each record's
quasi-identifier tuple appears in at least `k` other
records. Treating
`(platform, os, locale, viewport_class, aspect_class,
screen_class, vr_capable, country)` as the QI set:

- **Median case: k ≫ 100.** Most users share their bucket
  with thousands of others on the public web; within
  Terraviz's narrower population k is plausibly 10²–10³.
- **Tail case: k = 1.** Per §3c, a user with a rare bucket
  combination in a small-population country is unique.

We do not enforce k-anonymity at write time; the dataset is
recorded raw and is k-anonymous *probabilistically* for the
median user, *not* for the tail. A hardening (§11) would
filter dashboards to `k ≥ 5` cohorts, dropping the long tail
from public output.

### 10b. Differential privacy

We do **not** add noise — neither at the client nor at the
server. The schema is plaintext-aggregation. This is a
deliberate decision driven by analytic utility (a
`camera_settled` heatmap is much less useful with Laplace
noise added to each lat/lon) and operational simplicity
(Workers Analytics Engine has no DP primitive).

The implication: the dataset offers no formal privacy
guarantee against an adaptive adversary that can issue
arbitrary queries. A k-anonymity-style filter at the query
layer is the closest we get to formal control. For research
use that publishes aggregates externally, applying a
differentially-private aggregator (e.g. Google's
[differential-privacy](https://github.com/google/differential-privacy)
library) over the AE export *before* publication would close
this gap; that is a §11 recommendation, not a current
property.

### 10c. GDPR — anonymous vs pseudonymous

GDPR Recital 26: "personal data which has undergone
*pseudonymisation*, which could be attributed to a natural
person by the use of additional information, should be
considered to be information on an identifiable natural
person." vs anonymous data, which is "information which does
not relate to an identified or identifiable natural person".

By that standard, the AE dataset is **pseudonymous, not
anonymous**, for two reasons:

1. The session id, while in-memory and not persisted by us,
   is still a uniform identifier that joins all events in
   one session. GDPR treats joinable identifiers as
   pseudonymisation, not anonymisation, even when the
   linking party (us) does not hold the linkage to identity.
2. Per §3c and §9b, the combination of quasi-identifiers and
   behavioural traces can re-identify outlier users with
   reasonable additional information.

This means GDPR's data-subject rights formally apply to the
telemetry stream. In practice we have no mechanism to honour
"please delete my events" because we have no way to identify
which events are an individual's. We acknowledge this in
`PRIVACY.md` §10. This is not a unique problem to Terraviz —
it is the standard tension between behavioural analytics and
right-to-erasure — but pretending the stream is fully
anonymous would be wrong.

### 10d. Article 29 Working Party — three criteria

WP29 Opinion 05/2014 on Anonymisation Techniques scores
techniques against:

1. **Singling-out.** "Is it possible to isolate some or all
   records identifying an individual?" — *yes*, for outliers
   (§3c). The pipeline does not robustly prevent
   singling-out for the tail.
2. **Linkability.** "Can two records concerning the same
   data subject be linked?" — *within a session*, yes
   (`index1`). *Across sessions*, only via behavioural
   fingerprinting (§9b), which is non-trivial but possible.
3. **Inference.** "Can the value of an attribute be inferred
   from a set of other attributes?" — partial. We do not
   collect attributes that drive sensitive inference (no
   precise location, no identity), but the trajectory data
   in §3b can support inference about user role
   (educator / researcher / hobbyist) and topic interest.

The WP29 reading is consistent with the GDPR analysis above:
**pseudonymous, not anonymous**, with the most actionable
gaps being singling-out for tail users and cross-session
behavioural linkability.

---

## 11. Recommended hardenings

Ranked by impact / effort. We list these for triage, not as
prescriptions; each has a cost.

### High impact, low effort

1. **Correct the `hash.ts` collision-rate comment** to
   ~2.4 M queries at 1% collision (§4a). One-line edit.

2. **Tighten `device_class` and `settings_changed.key` to
   closed enums** (§9g, §9j). Compile-time guard against an
   accidentally-introduced free-text emit. ~30 LOC.

3. **Add an adversarial-input test for `sanitizeMessage`**
   that fires base64-encoded payloads, undashed UUIDs,
   non-ASCII paths, and embedded query strings, asserting
   the output contains none of the input bytes (§9d). One
   test file.

### Medium impact, medium effort

4. **Replace the static-hash `browse_search` with a
   per-day-rotating HMAC.** Server-side: maintain a daily
   rotating key in KV; client fetches a salt at session
   start and uses HMAC-SHA-256 instead of plain SHA-256.
   Within-day aggregation still works ("how many distinct
   queries today?"); cross-day inversion becomes
   computationally infeasible after the key rolls. Closes
   §9a almost completely. ~100 LOC + KV plumbing.

5. **Add a `k ≥ 5` anonymity filter to public Grafana
   dashboards.** Apply
   `HAVING count(DISTINCT index1) >= 5` to every grouped
   query that surfaces externally. Drops singling-out
   risk (§3c, §10a) at the cost of hiding small-cohort
   data. ~20 dashboard JSONs to amend.

### Higher effort

6. **Coarsen `country` to region for low-population
   countries.** Map `(IS, MT, LI, ...)` to a regional
   bucket (`'EU-N'`, `'EU-S'`, etc.) at ingest time. Closes
   the tail-country quasi-identifier risk (§3c). Requires
   a country-to-region table baked into the Pages function
   and a schema-version bump.

7. **Differentially-private aggregation for any external
   research export.** Apply a DP aggregator over AE rows
   *before* the data leaves Cloudflare for any third-party
   research recipient. Closes §10b for that specific use
   case without affecting internal dashboards.

8. **Throttle `camera_settled` more aggressively or drop
   sequence ordering on export.** The 30/min budget is
   generous given the 4–10-point uniqueness threshold in
   §3b. Reducing to 6/min or stripping per-event timestamps
   from research exports (keeping only the lat/lon
   distribution) would defang the trajectory-fingerprint
   risk at significant analytic cost. Recommended *only*
   if and when behavioural-linkage is observed in practice.

### Out-of-scope but worth noting

9. **Self-hosting documentation already exists**
   (`docs/SELF_HOSTING.md`). For users unwilling to extend
   trust to Cloudflare (§1b, §9f), this is the structural
   answer; no hardening to the public deployment can
   address the insider-threat scenario.

---

## Closing

The Terraviz telemetry pipeline is not formally anonymous —
no behavioural analytics pipeline reasonably can be — but it
is a careful, defensible *pseudonymous* design that makes
re-identification expensive for the median user and
acknowledges its weaknesses for the tail. The largest
unresolved structural gaps are (a) `browse_search`
dictionary-recovery (§9a) and (b) camera-trajectory
behavioural fingerprinting (§9b). Both are addressable with
the medium-effort hardenings in §11; neither is fatal to the
"we count what users do without ever identifying who they
are" claim *for the median user*; both are honest costs of
the design that should be visible to reviewers.

The user-facing policy at `PRIVACY.md` describes this design
in plain language. This document exists so a privacy
researcher can verify, line by line and bit by bit, that the
implementation matches what the policy promises — and where
the policy promises more than the implementation can prove,
say so out loud.

