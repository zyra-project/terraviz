# Agent SDK Evaluation — Where LLM Agents Do (and Don't) Belong

> **Status: decision record.** Last reviewed: 2026-07-22.
> Records the outcome of a planning review of Anthropic's Claude
> Agent SDK (and agentic LLM tooling generally) against the
> TerraViz + Zyra architecture. No code ships from this doc; it
> exists so the verdicts below aren't re-litigated from scratch
> each time a new SDK release or training course makes agentic
> integration look attractive.
>
> **Revisit when:** workflow authoring opens to community
> publishers ([`ZYRA_INTEGRATION_PLAN.md`](ZYRA_INTEGRATION_PLAN.md)
> §Open questions #4); authoring friction is observed suppressing
> dataset supply — **staff included** (hit 2026-07-22, see
> §Workflow authoring assistant); Zyra's upstream **Narrate** stage
> ships; the `workflow_runs` failure data shows a persistent
> non-transient failure rate; or a self-hosted node needs the edge
> functions to run against something other than Cloudflare's AI
> binding.

---

## Context

The Claude Agent SDK embeds the Claude Code engine — an agentic
loop with file, shell, and MCP tool access — as a library inside an
application. Anthropic's own decision guide places it at the far
end of a spectrum (hosted Routines → headless `claude -p` in CI →
the SDK in-product) with the advice to start at the cheap end and
"drop down the spectrum only when the job actually needs the extra
control."

TerraViz already occupies the cheap end deliberately:

- **Real-time dataset generation** is fully deterministic —
  scheduled Zyra pipelines, allowlisted commands, publish-API-only
  writes ([`ZYRA_INTEGRATION_PLAN.md`](ZYRA_INTEGRATION_PLAN.md)).
  The plan's metadata sidecar explicitly chose template
  interpolation over an LLM.
- **The conversational surface** is Orbit: a hybrid local keyword
  engine + OpenAI-compatible streaming client
  (`src/services/llmProvider.ts`), provider-configurable down to
  local models. A docent answering questions is a fixed control
  flow with one "generate text" node — the wire protocol covers it.

The evaluation question was therefore narrow: which remaining
surfaces have control flow that *cannot* be drawn in advance —
"figure out what's wrong," "figure out what's needed and build it"
— and of those, which justify an agent under the repo's LLM
integration convention (see
[`CONTRIBUTING.md`](../CONTRIBUTING.md) §LLM Integrations:
existing contract, availability gate + fallback, no vendor LLM SDK
in `dependencies`).

## The test applied

**Could the control flow be drawn as a flowchart before running
it?**

- Fixed flowchart, no language in the loop → deterministic code,
  no model. (Dataset refresh proved this.)
- Fixed flowchart, one "transform text" node → a plain
  OpenAI-compatible completion call behind the provider contract.
  (Orbit; future Narrate metadata.)
- Unknowable flowchart — diagnosis, open-ended authoring → an
  agent is defensible, *where* it runs decided by the convention.

## Verdicts

| Surface | Verdict | Form | Gate |
|---|---|---|---|
| Real-time dataset generation & refresh | **No LLM** — settled | Deterministic Zyra pipelines (shipped) | — |
| Conversational docent (Orbit) | **No agent** — settled | OpenAI-compatible provider contract (shipped) | — |
| Workflow run-failure diagnosis | **Conditionally approved** | Headless CLI step in GHA, behind the run-status contract | Failure-rate data first |
| Run metadata narration (abstracts, captions) | **Parked** | Single completion call behind the sidecar contract | Upstream Narrate stage ships |
| Workflow authoring assistant | **Parked** | Own loop over the provider contract — *not* the SDK | Community authoring opens (plan §OQ4) |
| Agent SDK embedded in product code | **Rejected** | — | — |
| Upstream Zyra development (Z4 gaps) | **Out of scope here** | Normal AI-assisted development in `NOAA-GSL/zyra` / the mirror | — |

### Run-failure diagnosis — conditionally approved

[`ZYRA_INTEGRATION_PLAN.md`](ZYRA_INTEGRATION_PLAN.md) §Open
questions #3 names the gap: "a workflow that fails every hour
fills `workflow_runs` and nobody notices." The planned minimum
(auto-disable + portal banner) handles *detection*; *diagnosis* —
FTP host change, renamed frame pattern, cadence shift, bad
template edit — is an unknowable-flowchart problem that currently
lands on a human reading GHA logs.

Approved form: a `zyra-run-failed` workflow step running a
headless agent CLI over the run log, the pipeline definition, and
the (public) source URL, attaching a diagnosis and optional
proposed `pipeline_json` patch for human approval. Conditions,
each load-bearing:

1. **Writes only through the existing run-status callback.** No
   new write path into D1 or R2 (§Integration principle). The
   diagnosis is data on the run row; a different engine — or a
   human — satisfies the same contract.
2. **Gated on secret presence.** A fork without the API key skips
   the step silently — the frame cache's best-effort stance. The
   feature is additive, never load-bearing.
3. **Prompt + output schema versioned in-repo** as the documented
   contract, so swapping engines is editing one workflow file.

Headless Claude is not LLM-agnostic; it sits in the ops layer
where agnosticism buys nothing and removal is deleting a file.

**Build gate:** query `workflow_runs` for the non-transient
failure rate first. If real failures are rare, auto-disable + a
banner + an occasional human look is the right amount of
engineering, and this stays unbuilt.

### Workflow authoring assistant — parked

Guided authoring (plan Phase Z3: curated templates, stage
snippets, `/validate`) covers staff needs. The known sharp edges —
e.g. the positional-arg gotcha documented in
`src/ui/publisher/workflow-templates.ts` — are real but low-volume
while authoring is staff-only.

If community authoring opens (plan §OQ4), "describe your source,
get a draft pipeline that passed `/validate` and a dry-run" is a
genuine agentic loop, and the allowlist + validation + review
queue is exactly the containment it needs. Because this is a
**product** surface (self-hosted nodes, local-model deployments),
it must be built as an owned loop over the OpenAI-compatible
provider contract — draft → validate → read errors → revise — not
as an embedded vendor SDK. That loop is simple enough to own;
that's what makes the agnostic form viable here.

**2026-07-22 update — gate partially hit, at staff level.** The
original gate ("community authoring opens") was mis-specified: the
real trigger is authoring friction suppressing dataset supply, and
the node operator reports exactly that — one live workflow against
zyra-scheduler's twelve production datasets, with wiring friction
named as the reason more don't exist. Suppressed supply never
shows up in `workflow_runs`, which is why this doc has to record
it. The escalation path stays deliberate:

1. **First response — dev-edge authoring, zero product surface.**
   Draft new pipelines in AI-assisted development sessions
   (validated via `/validate` + a manual run), and *log where the
   wiring hour actually goes*: source research, Zyra arg
   knowledge, the publish leg, or the fire-a-run-and-wait
   iteration loop. A drafted pipeline that collapses the time
   proves the friction was knowledge; time still lost to the GHA
   loop points at deterministic tooling (a faster validation
   surface), not an LLM.
2. **Only if dev-edge authoring proves insufficient** (volume, or
   non-staff authors) does the in-product owned-loop assistant
   above get built — still under the convention, still not the
   SDK.

### Agent SDK in product code — rejected

`@anthropic-ai/claude-agent-sdk` in `package.json` would be the
first vendor LLM SDK in the tree, and it cannot sit behind the
provider contract: its value (the agentic loop, tool harness,
permissioning) is precisely what the OpenAI-compatible interface
cannot express. It fails the convention, and — decisive — nothing
that survived the surface-by-surface review needed it. If a future
capability seems to, the burden is to show why an owned loop or a
headless CI step can't deliver it.

### Upstream Zyra work — proceeds regardless

The plan's stage-gap table already names the desired upstream
contributions: `process reproject` (warp to EPSG:4326),
`--preset sos` for `compose-video`, `export terraviz`,
THREDDS/OPeNDAP connectors, the Narrate stage itself. These are
well-scoped coding tasks in `NOAA-GSL/zyra` (via the
`zyra-project/zyra` mirror's `claude/*` → relay flow). AI-assisted
development there is a developer-tooling choice outside this
repo's runtime and outside this convention's scope. Each landed
command has a mechanical TerraViz follow-up: allowlist entry +
curated template, bumped together with the runner-image digest.

## Deferred decision

**A provider seam for `env.AI.run()`.** Server-side LLM calls
(Orbit chat proxy, current-events enrichment, voice) call the
Cloudflare Workers AI binding directly at each site, with
`functions/api/_lib/workers-ai-text.ts` normalizing reply
envelopes. The coupling is coextensive with the Pages/D1/R2
hosting decision, so extracting a seam now is speculative.
Decide at the next new Workers-AI call site, or when a
self-hosted node actually asks to point the edge at a different
backend — whichever comes first.

## Non-goals

- **No agentic runtime in the SPA or Pages Functions.** Rejected
  above; the convention enforces it.
- **No second scheduler or new write paths** for any agent hook —
  the run-status callback is the only mutation surface.
- **No speculative LLM features** ahead of the named gates
  (failure data, OQ4, upstream Narrate).
