# Workflow Authoring Integration — Probe, Presets, Orbit

How the `/publish/workflows` section closes the authoring-friction
gap: a source **probe** that mechanizes feed discovery, a curated
**source-preset** catalog, a one-click **gap-issue** path to
upstream Zyra, and — last and thinnest — an **Orbit authoring
mode**. Companion to
[`ZYRA_INTEGRATION_PLAN.md`](ZYRA_INTEGRATION_PLAN.md) (whose
Phase Z3 guided authoring this extends),
[`AGENT_SDK_EVALUATION.md`](AGENT_SDK_EVALUATION.md) (whose
escalation path this implements), and the LLM integration
convention in [`CONTRIBUTING.md`](../CONTRIBUTING.md).

> **Status: draft for review.** No code yet. Sequenced so every
> phase is useful without the ones after it, and so the LLM enters
> the loop last — after the deterministic layers have shrunk the
> problem to the part only judgment can do.

---

## Motivating case study: wiring the SST feed (2026-07-22)

The authoring-friction gate in `AGENT_SDK_EVALUATION.md` was
declared hit on operator report: one live workflow against
zyra-scheduler's twelve datasets, friction named as the reason.
The same day, wiring **Sea Surface Temperature — Real-time** end
to end (dev-edge, AI-assisted session) produced a time-and-motion
breakdown of where the friction actually lives:

| Step | Effort | Nature |
|---|---|---|
| Find the source (catalog page → FTP tree → `4096/` subdir) | High | Research; needed FTP reach the browser and Worker don't have |
| List the directory | Blocked until a GHA probe job was improvised | **Mechanical, given a runner** |
| Induce `pattern` / `date-format` / `period-seconds` from filenames | Trivial once the listing existed | **Deterministic** |
| Pipeline shape + arg gotchas | Copied from the curated template | Already solved by Z3 |
| Validation | `/validate` | Already solved by Z1 |
| Product caveats (9–10 day lag, batch updates, 7.7 GB at 4096) | Judgment | Editorial — belongs in a preset, not rediscovered per author |

Only the first and last rows involve judgment. Everything else is
a button that doesn't exist yet. That decomposition **is** this
plan: mechanize the middle rows first (Phases A1–A2), curate the
judgment once (A3), and only then decide whether a conversational
skin still adds anything (A4).

## Design principle

The flowchart test from `AGENT_SDK_EVALUATION.md`, applied inside
one feature: every sub-step whose control flow is drawable in
advance ships as deterministic code; the LLM is reserved for
intent that can't be reduced to selection. Concretely, the LLM is
*last* in the build order and *optional* at runtime — every layer
below it is fully operable from the form without a model
configured, which is what keeps the feature working on a
self-hosted node with no API key (per the convention: existing
contracts, availability-gated, no vendor SDK in `dependencies`).

---

## Phase A1 — Source probe + pattern induction

**The button that erases most of the case study.** On the
workflow form, next to the acquire-stage fields: **Probe source**.

Mechanics, reusing the Z1 machinery end to end:

1. Operator enters a source URL (`ftp://` or `https://`). The
   Worker validates scheme + a public-host sanity check, inserts a
   `probe` record, and fires a `repository_dispatch`
   (`functions/api/v1/_lib/github-dispatch.ts`) carrying only the
   probe id — the runner fetches the URL from the record, the
   same stale-dispatch defense as `zyra-run`.
2. `.github/workflows/source-probe.yml` — the productized version
   of the throwaway `claude/ftp-probe` spike — lists the
   directory (`curl` handles both schemes; FTP works from GHA
   where it can't from the edge), truncates to a bounded sample
   (first/last N names + count), and POSTs the result back via a
   service-token callback, mirroring the run-status route shape.
3. The portal shows the listing and runs **pattern induction**
   client-side: find the digit runs shared across names, diff
   consecutive dates to get the cadence, and propose
   `pattern`, `date-format`/`datetime-format`, `period-seconds`,
   and a `since-period` matching the server's own window. Pure
   function, table-driven Vitest tests, no model anywhere.
4. One click accepts the proposal into the acquire and
   scan-frames stage fields.

Induction from the case study's data:
`sst_20250710.png … sst_20260712.png × 365` →
`'^sst_[0-9]{8}\.png$'`, `%Y%m%d`, `86400`, `P1Y`. The algorithm
that produces that is an afternoon of code and removes the single
largest authoring blocker.

Probe security posture: the probe job runs in GHA with **no
secrets in scope** (the callback token enters only the callback
step, the same isolation the runner uses for Zyra itself); the
Worker never fetches operator-supplied URLs (no SSRF surface at
the edge); schemes are allowlisted to `ftp`/`http`/`https`; probe
results are bounded text, stored like `error_summary` with the
same sanitization stance.

## Phase A2 — Gap issues: a prefilled URL, not an integration

When `/validate` rejects a stage/command pair, or a probe shows a
source Zyra can't express, the error surface grows one action:
**File upstream issue**. It composes a
`github.com/NOAA-GSL/zyra/issues/new?title=…&body=…` URL with the
failing pipeline JSON and the exact validator/run error embedded
as a reproducer, and opens it in a new tab. The operator's own
GitHub session does the filing.

No token, no API client, no LLM, no new trust surface — the
portal only builds a URL. This closes the demand-signal loop from
`AGENT_SDK_EVALUATION.md` (§Upstream Zyra work): every "Zyra
can't do this yet" becomes a structured, reproducible upstream
issue instead of a shrug. When Orbit exists (A4) it can draft a
better body; the deterministic version ships first and is never
removed as the fallback.

## Phase A3 — Source presets: curate the judgment once

The portal already has the exact pattern:
[`feed-presets.ts`](../src/ui/publisher/feed-presets.ts) — an
editorial, versioned-in-code catalog of one-click feeds for the
events page. Workflows get the sibling:
`dataset-source-presets.ts`, one entry per SOS `rt/` product
family (~30 exist: drought, SST, SST anomaly, fire, ozone,
snow/ice, clouds, precipitation, …), each carrying the verified
path, induced pattern and cadence, resolution options, and the
per-product caveats that otherwise get rediscovered per author
(SST's 9–10 day lag and batch updates; drought's basemap
`MISSING_FRAME` fill; working-set sizes).

The initial catalog is generated, not typed: one probe sweep
(A1's job, pointed at the `rt/` tree) plus induction, then edited
into shape — **already done once**: the first generation (19 ready
entries, plus the flagged/excluded analysis, from a 2026-07-22
sweep of 152 directories) is checked in as
[`DATASET_SOURCE_PRESETS_DRAFT.md`](DATASET_SOURCE_PRESETS_DRAFT.md),
the copy-out seed for the real module. Presets prefill the whole
form — source, acquire and scan stages, metadata template,
schedule — reducing "wire a new SOS real-time dataset" to a
picker, a target dataset, and Run now. This lands on the same side
of `ZYRA_INTEGRATION_PLAN.md` §Open questions #6 as the curated
templates: versioned with the app, revisit if a second node wants
its own catalog.

## Phase A4 — Orbit authoring mode (decide with A1–A3 evidence)

The conversational layer, built **only if** the form still has
friction once probe + presets exist — the criterion is the
intent-versus-selection question: presets answer "the Coral Reef
Watch SST feed at 4096"; Orbit earns its place only if operators
genuinely arrive with "show ocean heat over the last year" and
need the mapping done for them.

Architecture is already paid for. `llmProvider.ts` parses
OpenAI-style `tool_calls`, and `docentService` runs the engine —
an authoring mode is a publisher-chunk Orbit instance with a
system prompt (allowlist, templates, gotchas, presets) and four
tools, each an existing surface:

| Tool | Backing surface |
|---|---|
| `probe_source` | A1 probe record + callback |
| `validate_pipeline` | `POST …/workflows/{id}/validate` (Z1) |
| `create_draft_dataset` | Z3 draft-dataset button's endpoint |
| `save_workflow_draft` | Z1 create/PATCH, saved **disabled** |

The loop — draft → validate → read errors → revise — is the
"owned loop over the OpenAI-compatible provider contract"
`AGENT_SDK_EVALUATION.md` reserved for exactly this surface. Per
the convention: provider-agnostic (works against Ollama on a
self-hosted node), availability-gated (no configured provider →
the mode simply isn't offered; the form is the fallback), no
vendor SDK. Containment is unchanged from Z1: staff-only, the
allowlist validates every draft, nothing is enabled or run
without a human click. Orbit **proposes**; the operator
**disposes**.

---

## Phases

| Phase | Scope | Demoable state |
|---|---|---|
| **A1 — probe** | `source-probe.yml`; probe record + dispatch + callback routes; pattern-induction module + tests; form integration | Paste an FTP URL, click Probe, watch the acquire/scan fields fill themselves with verified values. |
| **A2 — gap issues** | Prefilled-URL composer on validator and run errors | A rejected pipeline becomes a reproducer-bearing upstream issue in two clicks. |
| **A3 — presets** | Probe sweep of `rt/`; `dataset-source-presets.ts`; preset picker prefilling the form | A second real-time dataset ships from a picker in minutes, by someone who has never read Zyra docs — the Z3 goal, actually met. |
| **A4 — Orbit mode** | Decision point first (friction evidence from A1–A3), then the authoring instance + four tools | "Add sea surface temperature to the globe" produces a validated draft workflow awaiting a human Save. |

## Non-goals

- **No Agent SDK in product code** — settled in
  `AGENT_SDK_EVALUATION.md`; nothing here reopens it.
- **No autonomous execution.** Orbit-saved drafts are disabled
  until a human enables them; no layer runs a pipeline without a
  click.
- **No community authoring** — this plan changes who *can author
  easily*, not who *may author*; that stays Z1's staff/service
  restriction and `ZYRA_INTEGRATION_PLAN.md` §Open questions #4.
- **No probe fetches from the Worker.** Operator-supplied URLs
  are only ever fetched by the GHA probe job.
- **No LLM requirement.** Every phase through A3 is fully usable
  with no provider configured.

## Open questions

1. **Preset maintenance.** Upstream renames a product directory
   and a preset goes stale. Cheap answer: the probe job doubles
   as a preset checker on a slow cron, flagging drift in the
   portal rather than failing anything.
2. **HTTP directory sources.** A1's induction assumes
   listing-style sources (FTP, autoindex HTTP). Sources behind
   catalogs or APIs (THREDDS et al.) stay out of scope until the
   upstream connector exists — at which point they arrive as
   presets, not probe targets.
3. **Where A4's system prompt lives.** Versioned in the portal
   chunk like templates and presets, or a D1 row editable per
   node? Same trade as Open questions #6; lean code-versioned
   until a second node diverges.
