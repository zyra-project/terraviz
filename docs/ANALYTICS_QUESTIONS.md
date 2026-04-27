# Analytics Questions — what we should ask of the data

> **Status:** Draft for review (2026-04-27). This document is a
> strategic counterpart to the catalog in
> [`ANALYTICS.md`](ANALYTICS.md) and the query reference in
> [`ANALYTICS_QUERIES.md`](ANALYTICS_QUERIES.md). Those describe
> *what we collect* and *how to read it*; this one proposes *what
> questions are worth asking* and *which audiences each question
> serves*. Comments and edits welcome via PR review.

## Audiences and data sources

Terraviz serves three constituencies:

- **General public visitors** — explore the globe, watch
  animations, learn Earth science.
- **Developers / forkers** — clone the repo, run the desktop app,
  contribute or self-host (see
  [`SELF_HOSTING.md`](SELF_HOSTING.md)).
- **Partners (NOAA / SOS curators)** — care about whether their
  datasets reach an audience and how those datasets are used.

We have four data sources to draw on:

1. **Cloudflare Analytics Engine** — the `terraviz_events`
   dataset; typed product events documented in
   [`ANALYTICS.md`](ANALYTICS.md).
2. **Feedback database** — structured `feedback` events in AE
   plus free-text feedback rows behind the admin UI.
3. **Orbit / LLM data** — `orbit_*` events in AE (Tier B), plus
   any conversation transcripts stored separately.
4. **Cloudflare-native telemetry** — Workers Analytics, Pages
   Analytics, Web Analytics RUM, Access logs, Cache Analytics.
   Mostly auto-collected; no code changes required.

## Priority legend

- **P0** — must-answer / existential (adoption trend,
  reliability).
- **P1** — drives roadmap (engagement depth, content fit, Orbit
  ROI, discoverability).
- **P2** — quality / operations (performance, VR/AR validation,
  spatial attention).
- **P3** — nice-to-have (feedback loop hygiene, telemetry meta).

Sample queries assume the standard
`WHERE blob2 = 'production' AND blob4 = 'false'` boilerplate plus
a time filter — omitted here for readability. Blob/double
positions follow the canonical alphabetical layout documented in
[`ANALYTICS_QUERIES.md`](ANALYTICS_QUERIES.md).

---

## P0 — Adoption: are we growing, and who are we reaching?

**Audience:** general public + partners. **Source:** AE
`session_start` + Cloudflare Web Analytics.

Cloudflare Web Analytics gives uncached pageviews, top referrers,
top countries, and bot share with zero work — turn it on
(Pages → project → Web Analytics → Enable) if it isn't already.
AE's `session_start` events tell you *engaged* sessions
specifically (someone got past the loading screen).

| Question | Where | Sample |
|---|---|---|
| Daily active sessions trend | AE | `SELECT toStartOfDay(timestamp), count(DISTINCT index1) FROM terraviz_events WHERE blob1='session_start' GROUP BY 1` |
| Web vs desktop vs mobile mix | AE | `SELECT blob10 AS platform, count(DISTINCT index1) FROM terraviz_events WHERE blob1='session_start' GROUP BY platform` |
| Geographic reach | AE | `SELECT blob3 AS country, count(DISTINCT index1) FROM terraviz_events WHERE blob1='session_start' AND blob3 != 'XX' GROUP BY country` (already in product-health Panel 10) |
| Where do referrals come from? | CF Web Analytics → Top Referrers | UI |
| Bot vs human ratio | CF Web Analytics | UI |

**Action:** if Web Analytics isn't enabled, do that first — it
answers "are we growing" better than AE alone.

---

## P0 — Reliability: is the app crashing for users?

**Audience:** developers + partners. **Source:** AE `error` +
Cloudflare Workers / Pages logs.

| Question | Sample |
|---|---|
| Errors per session, last 24h | Already have it (product-health Panel 5) |
| Worst error categories | `SELECT blob5 AS category, count() FROM terraviz_events WHERE blob1='error' GROUP BY category ORDER BY 2 DESC` |
| Are errors regressing after a release? | `SELECT toStartOfDay(timestamp), count() FROM terraviz_events WHERE blob1='error' GROUP BY 1` overlaid with deploy markers |
| Pages Function 5xx rate | CF Pages → Functions → Real-time logs / metrics |
| `/api/ingest` rejection rate (400 / 410 / 429) | Workers Analytics → terraviz-pages → Requests by Status |

**Action:** add a "deployments" annotation track to the errors
timeseries panel so regressions are visually obvious. The
Cloudflare Pages deploy webhook can post to a Grafana annotation
API.

---

## P1 — Engagement depth: is the app interesting?

**Audience:** general public; informs what to build next.

The single most diagnostic number is **median session duration**
broken out by **was-Orbit-used / wasn't**. If Orbit users stay
3× longer, Orbit is your engagement engine. If they leave
faster, Orbit is friction.

| Question | Sample |
|---|---|
| Session duration distribution | `SELECT quantile(0.5)(double2), quantile(0.95)(double2) FROM terraviz_events WHERE blob1='session_end'` |
| Datasets loaded per session | `SELECT quantile(0.5)(n), quantile(0.95)(n) FROM (SELECT count() AS n FROM terraviz_events WHERE blob1='layer_loaded' GROUP BY index1)` |
| Tours started vs completed | Already have it (product-health Panel 9) |
| 1-globe vs 2-globe vs 4-globe usage | `SELECT blob5 AS layout, count() FROM terraviz_events WHERE blob1='layout_changed' GROUP BY layout` |
| Zero-engagement sessions (`session_start` with no `layer_loaded`) | CTE: count `session_start` whose `index1` doesn't appear in `layer_loaded` |

**Action:** create a new dashboard "Engagement Funnel" with:
visit → load any dataset → load >1 dataset → complete a tour →
use Orbit. That's the canonical product funnel.

---

## P1 — Content performance: which datasets and tours work?

**Audience:** NOAA / SOS partners (which datasets earn their
place), product team (which to feature).

| Question | Sample |
|---|---|
| Top loaded datasets | `SELECT blob5 AS layer_id, count() AS loads FROM terraviz_events WHERE blob1='layer_loaded' GROUP BY layer_id ORDER BY loads DESC LIMIT 25` |
| Stickiest datasets (long dwell) | `SELECT blob5 AS layer_id, quantile(0.5)(double2) AS p50_dwell_ms FROM terraviz_events WHERE blob1='layer_unloaded' GROUP BY layer_id ORDER BY p50_dwell_ms DESC` |
| "Bounce" datasets (loaded then unloaded < 5s) | `SELECT blob5 AS layer_id, count() FROM terraviz_events WHERE blob1='layer_unloaded' AND double2 < 5000 GROUP BY layer_id ORDER BY 2 DESC` |
| Worst-answered tour quiz questions | Already have it (research Panel 2) |
| Tour drop-off — which task index loses people? | `SELECT blob5 AS task_type, double3 AS task_index, count() FROM terraviz_events WHERE blob1='tour_task_fired' GROUP BY task_type, task_index` |

**Action:** add a "Hidden gems" panel — datasets with high p50
dwell but low total load count. Those are content the
recommendation surface (Browse / Orbit) should push more
aggressively.

---

## P1 — Educational value: are people learning?

**Audience:** NOAA / SOS partners and educators (the mission
question), product team (validates the docent + tour
investments). For partners specifically, this is arguably **P0**:
engagement and adoption are necessary but not sufficient if no
learning happens.

We can't measure long-term retention or attitudinal change
without breaking the session-scoped privacy posture (no
cross-session identity tracking, session id rotates per launch).
What we *can* measure are **within-session learning signals**:
did behavior or quiz performance change between the start and
end of a single visit?

### What's already measurable today

| Question | Sample |
|---|---|
| Within-session pre/post — same `question_id` answered correctly more often the second time? | `WITH q AS (SELECT index1 AS session_id, blob5 AS question_id, blob6 AS tour_id, blob7 AS was_correct, timestamp, row_number() OVER (PARTITION BY index1, blob5 ORDER BY timestamp) AS attempt_n FROM terraviz_events WHERE blob1='tour_question_answered') SELECT question_id, tour_id, sum(if(attempt_n=1 AND was_correct='true',1,0))/sum(if(attempt_n=1,1,0)) AS pre_correct, sum(if(attempt_n=2 AND was_correct='true',1,0))/sum(if(attempt_n=2,1,0)) AS post_correct FROM q GROUP BY question_id, tour_id HAVING sum(if(attempt_n=2,1,0)) > 5` |
| Time-to-correct (learning curve within a session) | `SELECT blob5 AS question_id, attempt_n, avg(double5) AS avg_response_ms, sum(if(blob7='true',1,0))/count() AS correct_rate FROM (SELECT *, row_number() OVER (PARTITION BY index1, blob5 ORDER BY timestamp) AS attempt_n FROM terraviz_events WHERE blob1='tour_question_answered') GROUP BY question_id, attempt_n ORDER BY question_id, attempt_n` |
| Active vs passive — clicks per camera-settle | `SELECT index1, count_if(blob1='map_click') AS clicks, count_if(blob1='camera_settled') AS settles, count_if(blob1='map_click') / nullif(count_if(blob1='camera_settled'),0) AS click_per_settle FROM terraviz_events WHERE blob1 IN ('map_click','camera_settled') GROUP BY index1`. Higher click-per-settle indicates investigative behavior (probing features) rather than scenic viewing. |
| Concept breadth × depth — "productive sessions" | `SELECT index1, count(DISTINCT blob5) AS distinct_datasets, sum(double2) AS total_dwell_ms FROM terraviz_events WHERE blob1='layer_unloaded' GROUP BY index1`. Sessions with both ≥3 distinct datasets and ≥5 min total dwell are candidates for "deep learning sessions". |
| Tour completion → independent exploration funnel | CTE: distinct sessions that fired `tour_ended` with `blob5='completed'`, joined to subsequent `layer_loaded` events with `blob8='manual'` (not tour-triggered). A high conversion rate suggests the tour primed curiosity that survived past the scripted experience. |
| Orbit-then-load — does asking the docent precede a dataset load? | CTE on `index1`: pairs of `orbit_interaction(message_sent)` followed within N minutes by `layer_loaded`. The `orbit_load_followed` event already captures the deliberate version (clicked-suggestion); this query catches the looser "user asked, then explored on their own" pattern. |
| Orbit turn depth — multi-turn conversations are dialogue, not single-shot lookup | `SELECT quantile(0.5)(turns), quantile(0.95)(turns) FROM (SELECT index1, count() AS turns FROM terraviz_events WHERE blob1='orbit_turn' AND blob8='user' GROUP BY index1)` |
| Reading-level fit | `SELECT blob7 AS reading_level, sum(if(blob5='length',1,0))/count() AS truncate_rate, avg(double2) AS avg_content_length FROM terraviz_events WHERE blob1='orbit_turn' AND blob8='assistant' GROUP BY reading_level`. If `kid` reading level has a high `length` finish rate but low post-turn `layer_loaded`, the responses may be too long for the audience. |

**Authoring convention to enable pre/post:** the existing
`tour_question_answered` schema already supports within-session
delta — tour authors just need to **place the same
`question_id` near the start and end of a tour**. That makes
the first sample query above actually meaningful. Worth
documenting in the tour-authoring guide as a recommended
pattern.

### What would unlock more — small additions

These are bounded changes that significantly extend the learning
measurement surface:

- **`confidence_check` event** — a 1–5 self-rated picker that
  appears at the start and end of a tour with the same prompt
  ("How comfortable are you with hurricane formation?"). Compare
  pre/post per `tour_id`. Tier A (it's a deliberate user
  interaction, not passive observation). Schema would mirror
  `feedback` with a `confidence: 1|2|3|4|5` and a
  `prompt_id: string`.
- **Concept tags on dataset metadata** (no new events) — tag
  each dataset with one or more learning concepts (`hurricane`,
  `sea-ice`, `aerosols`, `ocean-currents`). Then dashboards can
  ask: "did the user explore a coherent concept cluster (depth
  on hurricanes) or scatter randomly (one of everything)?"
  Concentration is a learning signal; scatter might be casual
  browsing. Lives in `dataService.ts` enriched metadata, no
  schema change.
- **End-of-session "what did you learn" prompt** — reuse the
  existing `feedback` event with a new `context: 'session_end'`
  + `kind: 'free_text'` value. The free text lives in the
  feedback DB (not AE), so no schema change there either; it's
  a UI prompt + a routing tweak.
- **Pre/post designation on tour tasks** — add an optional
  `pre_post: 'pre' | 'post'` field to `tour_task_fired` so
  dashboards can identify the learning-design intent without
  having to infer it from question position. Backwards
  compatible if we make the field always present (`'none'` /
  empty for tasks not part of a pre/post pair).

### What's out of scope for the privacy posture

- **Long-term retention** — the canonical educational research
  question ("did they remember a week later?") requires linking
  sessions across visits. Terraviz's session id rotates per
  launch by design (see [`PRIVACY.md`](PRIVACY.md)), so this
  isn't measurable without a deliberate, opt-in account flow.
  Worth noting as a tradeoff: stronger privacy, weaker
  longitudinal learning research.
- **Demographics / classroom context** — would help interpret
  results but conflicts with the
  no-User-Agent-no-IP-no-account stance.

### Sample dashboard layout

A new "Learning Signals" dashboard would naturally have:

1. Pre/post correctness delta per `question_id` (P1)
2. Time-to-correct curve per `question_id` (P1)
3. Productive-session rate (% of sessions hitting breadth+depth
   threshold) trend over time (P1)
4. Tour → independent-exploration conversion rate (P2)
5. Orbit-precedes-load funnel (P2)
6. Multi-turn rate distribution (P2)
7. *(after instrumentation)* Confidence pre/post per tour (P1)

**Action:** the no-code-change wins are (a) document the "same
`question_id` at start and end" tour-authoring convention,
(b) ship the "Learning Signals" dashboard with the existing
queries above, and (c) add a Hidden Gems / productive-sessions
stat panel. The instrumentation additions
(`confidence_check`, `pre_post` discriminator, concept tags) are
each ~half-day pieces of work and unlock substantially better
analysis — sequence them after the no-code dashboard reveals
which signals are worth investing more in.

---

## P1 — Orbit value validation: does the LLM docent earn its keep?

**Audience:** product team. Orbit is the most expensive feature
because LLM tokens cost real money.

The cost question is sharp: **dollars per loaded dataset that
came via Orbit**. If Orbit costs $X / day and yields N dataset
loads via `orbit_load_followed`, you can compute cost per
assisted exploration.

| Question | Sample |
|---|---|
| Orbit adoption — what fraction of sessions open chat? | `count(DISTINCT index1) WHERE blob1='orbit_interaction'` ÷ total `session_start` |
| Orbit follow-through — did they load what was suggested? | Already have it (research Panel 7) |
| Quality red flags (corrections) | Already have it (research Panel 8) |
| Tokens per session | `SELECT sum(double4 + double5) AS tokens FROM terraviz_events WHERE blob1='orbit_turn' AND double4 > 0 GROUP BY index1` — **note:** `llmProvider` does not yet surface `usage` data from the SSE stream, so `input_tokens` / `output_tokens` are currently always `0`. Plumbing those through is a small follow-up that would make this query (and the "$ per assisted-load" panel below) actually return data. |
| Model comparison — finish_reason mix | Already have it (research Panel 10) |
| `length` truncation rate per model — token budget regressions | `SELECT blob6 AS model, sum(if(blob5='length',1,0))/count() AS truncate_rate FROM terraviz_events WHERE blob1='orbit_turn' GROUP BY model` |

**Outside AE:** if Orbit transcripts are stored in a feedback DB
or D1, the highest-value ad-hoc query is **"show me the 50 most
recent thumbs-down conversations end-to-end"** for qualitative
review. Better as a small admin page or weekly export than a
Grafana panel.

**Action:** add a single stat panel "$ per assisted-load this
week" — pulls token totals × model price, divides by
`orbit_load_followed` count. Forces the cost conversation onto
the dashboard.

---

## P1 — Search & discoverability gap: what do users want?

**Audience:** product + partners (catalog gap analysis).

Research Panel 4 already shows zero-result hashed queries. The
hash is opaque by design, but co-occurrence patterns reveal a
lot.

| Question | Sample |
|---|---|
| Most-frequent zero-result hash | Already have it (research Panel 4) |
| Sessions that searched then *didn't* load anything | CTE: sessions with `browse_search` but no later `layer_loaded` |
| How do successful loads happen — Browse vs Orbit vs deeplink? | `SELECT blob8 AS trigger, count() FROM terraviz_events WHERE blob1='layer_loaded' GROUP BY trigger` |

**Action:** since hashes can't be reversed, either (a) capture
short non-PII categories alongside (e.g. detected entities like
"hurricane", "ice", "fire" via a small client-side classifier),
or (b) accept zero-result hashes as a frequency signal and pair
with manual catalog review.

---

## P2 — Performance under stress

**Audience:** developers; informs optimization priorities.

| Question | Sample |
|---|---|
| Per-GPU FPS regressions | Already have it (product-health Panel 7) |
| JS heap pressure by viewport class | JOIN `perf_sample` with `session_start` on `index1`; filter `double4 > 0` (jsheap_mb) |
| Layer load p95 by dataset | Already have it (product-health Panel 3) |
| Mobile vs desktop FPS gap | FPS query JOINed with `session_start.platform` |

**Action:** alerting — set a Grafana threshold alert on p95
layer-load > 8 s or median FPS < 30 to catch regressions before
users complain.

---

## P2 — VR / AR investment validation

**Audience:** product team. Is the VR build worth the
maintenance cost?

| Question | Sample |
|---|---|
| VR sessions per week | `SELECT toStartOfWeek(timestamp), count(DISTINCT index1) FROM terraviz_events WHERE blob1='vr_session_started'` |
| VR vs 2D session length comparison | JOIN `session_start` with `vr_session_*` |
| Spatial anchor reuse | `SELECT sum(if(blob6='true',1,0))/count() AS persist_rate FROM terraviz_events WHERE blob1='vr_placement'` |
| VR exit reasons | `SELECT blob5 AS exit_reason, count() FROM terraviz_events WHERE blob1='vr_session_ended' GROUP BY exit_reason` |
| Crashes specific to VR | `SELECT count() FROM terraviz_events WHERE blob1='error' AND blob8='vr'` (verify enum values for `source`) |

**Action:** if "VR sessions per week" stays in single digits
across a quarter, that's a discontinuation conversation —
surface it as a stat panel so it can't be ignored.

---

## P2 — Spatial attention

**Audience:** product + content team. The
[spatial-attention dashboard](../grafana/dashboards/spatial-attention.json)
is now correctly wired (see fix on this branch). Once a few
weeks of data accumulate, the interesting derived questions are:

- **Self-region bias.** Do US visitors look at North America
  80 % of the time, or do they explore globally? JOIN
  `camera_settled` with `session_start.country` and compare the
  centroid country of dwell vs the visitor's country. A
  gravity-well is a curation insight.
- **Per-dataset attention fingerprint.** Hurricane datasets
  should heatmap on the Atlantic basin; if they don't, users may
  be confused about what they're looking at.
- **2D vs VR/AR same dataset.** Already have a panel for this
  in spatial-attention; needs more data.

---

## P3 — Feedback loop effectiveness

**Audience:** partners + maintainers.

The structured `feedback` event is in AE; the gold is in the
free-text behind the admin UI.

| Question | Where |
|---|---|
| Submission rate per session | AE: `count(feedback) / count(session_start)` |
| Sentiment trend (rating −1 / 0 / +1) | AE: `SELECT toStartOfDay(timestamp), avg(double2) FROM terraviz_events WHERE blob1='feedback'` |
| Feedback by `context` (which surface triggered it) | `SELECT blob5 AS context, blob6 AS kind, blob7 AS status, avg(double2) FROM terraviz_events WHERE blob1='feedback' GROUP BY 1,2,3` |
| Recent free-text feedback | Feedback DB (admin UI) — not Grafana |

**Action:** a weekly digest job that pulls top-N free-text
feedback into a Slack / email digest is more useful than a
dashboard for this content.

---

## P3 — Telemetry health (meta)

**Audience:** developers — keeps the analytics system itself
honest.

| Question | Source |
|---|---|
| Tier B opt-in rate | AE: `count(distinct index1 with any tier-B event) / count(distinct index1)` |
| Ingest rejection rate (validation 400s, kill-switch 410s) | Workers Analytics |
| AE write volume → cost | Cloudflare billing dashboard |
| Schema version distribution | `SELECT blobN AS schema_version, count(DISTINCT index1) FROM terraviz_events WHERE blob1='session_start'` (position depends on `resumed?` presence) |

---

## Suggested sequencing

If we did nothing else for the next sprint:

1. **Engagement Funnel dashboard** (P0 / P1) — visit → load →
   multi-load → tour → Orbit. Single canonical "are users
   actually engaging" view.
2. **Learning Signals dashboard** (P1, partner-facing) — the
   no-code-change panels listed in the Educational Value
   section. Highest payoff per hour of work because the data
   already exists.
3. **Orbit cost panel** ($ per assisted-load) on the existing
   research dashboard.
4. **Web Analytics enabled** if not already, then a single panel
   embedding pageviews × engaged sessions to see the conversion
   gap.
5. **Deploy annotations** on the errors timeseries.
6. **Feedback digest job** — weekly free-text export to email.
7. **Tour-authoring guide update** — document the
   "same `question_id` at start and end" pre/post convention
   so the pre/post-delta query starts returning data.

Items 1–4 are 30–60 min each in Grafana. Item 5 is a small
Cloudflare webhook → Grafana annotation API. Item 6 needs
whatever the feedback DB exposes (D1 query → Worker cron → email
API). Item 7 is a doc-only change.

## Open questions for review

- Are there audiences this doc misses? Funders and press are
  candidates that aren't currently surfaced. Educators are now
  called out under "Educational value" — is the framing right,
  or would educators want different signals (e.g.
  classroom-cohort filtering, which would conflict with the
  privacy posture)?
- Are the priority assignments right — would partners flip the
  order of "content performance" and "adoption", or promote
  "Educational value" to P0 outright? The P1 designation is the
  product-team default; partners reading this might disagree.
- Is there a privacy concern with any of the JOIN patterns
  proposed (`session_start.country` × `camera_settled` lat/lon,
  or any of the within-session learning-signal CTEs)? All
  fields are already collected and the joins happen in Grafana,
  but the resulting view can be more identifying than either
  input.
- Should Tier B (research-mode) opt-in rate become a
  user-visible stat ("X % of users help us improve Terraviz")
  or stay internal?
- For the proposed `confidence_check` event (Educational Value
  section): Tier A (essential, per-feature) or Tier B (research
  mode only)? It's a deliberate user interaction tied to a
  specific UI element, which argues for Tier A — but it's
  arguably more useful for research than for product
  operations, which argues for Tier B.
