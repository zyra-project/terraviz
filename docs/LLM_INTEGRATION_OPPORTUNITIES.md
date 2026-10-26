# LLM Integration Opportunities — Value Register

> **Status: idea register, not a plan.** Where
> [`AGENT_SDK_EVALUATION.md`](AGENT_SDK_EVALUATION.md) records what
> agentic integration must *not* do, this doc records what the
> LLM machinery is *for*: the concrete ways it could add value for
> TerraViz consumers and publishers, captured before they scatter.
> Nothing here is committed work. Every entry rides existing
> structured data through an existing contract behind an existing
> gate — the [`CONTRIBUTING.md`](../CONTRIBUTING.md) §LLM
> Integrations convention (including rule 4's untrusted-input
> cage) applies to all of them, and each names its gate. Promote
> an entry by writing it a plan section, not by starting to code.

The common shape, and why these stay small: the deterministic
layers already built — `frames-meta` timestamps, the frame recall
store, workflow run rows, the preset catalog, curator review
queues, the provider-agnostic Orbit client with tool-call support —
mean every idea below is *existing structured data + one narrow
model call + an existing gate*. None requires a new agent surface,
a vendor SDK, or a new write path. #10 is the one exception to the
shape: it needs a new endpoint, because its caller is a script that
can't use the browser's contract, and it says why.

## For consumers

### 1. Time-and-place-aware Orbit

Orbit explains datasets from static metadata; the workflow layer
now produces `frames-meta` with real per-frame timestamps, and the
SPA knows the visible frame and camera region. Injected as a
context block — the exact pattern `buildReturningUserBlock`
established (PR #172) — "what am I looking at?" becomes "this is
the July 12 composite; that warm tongue off Peru is this year's
developing La Niña signature."
**Rides:** frames-meta + docent context contract. **Gate:** none
needed — read-only context, answers stream to the visitor like any
chat turn. **Effort:** smallest on this list; highest
magic-per-line.

### 2. Orbit as comparison author

The frame recall store (`/frames`, per-date access) plus the
existing multi-globe comparison engine: "show sea ice now versus
last winter" → Orbit composes a camera-locked 2-globe layout, same
dataset, two dates. Nobody hand-authors that today; the recall
store makes it addressable.
**Rides:** `/frames` + viewport manager + the `<<LOAD:…>>` marker
pattern. **Gate:** load actions surface as tappable chips (the
existing docent pattern), visitor confirms by tapping.

### 3. Event-to-data weaving

The events pipeline already ingests NHC / USGS / EONET into a
curator queue. The model's job is matching: event → preset-catalog
dataset → region → time window, producing a one-tap "watch it on
the globe" card. News becomes a doorway into live data.
**Rides:** events queue + `DATASET_SOURCE_PRESETS_DRAFT.md`
entries + embed/URL grammar. **Gate:** curator approval — the
queue's existing `proposed` state.

### 4. "This Week on Earth"

Daily runs already know what changed (range advances; the SST
anomaly product surfaces extremes). A weekly auto-*drafted* tour —
a few stops, narrated — lands in the review queue for human
approval, exactly as the Narrate pre-condition in the decision
record requires.
**Rides:** frames-meta diffs + tour engine + review queue.
**Gate:** the Narrate free-text review gate, by construction.

### 5. Described globes

Vision-capable narration of the current view for blind and
low-vision visitors, and native-language floor narration for
museums. The provider contract already carries image parts
(`LLMImagePart` in `llmProvider.ts`); the voice stack already
speaks.
**Rides:** frame capture + provider contract + TTS. **Gate:**
availability-gated like all Orbit features; degrade to legend +
metadata text.

## For publishers

### 6. Visual sanity check in the Verify preflight

ffprobe catches wrong dimensions; it cannot catch the all-black
frame, the half-rendered mosaic, the colorbar-only render. "Does
this look like a plausible SST map?" is a genuinely
unknowable-flowchart question — the decision record's test *passes*
— and the verdict flows through the existing run-status contract as
a failed preflight with a reason. The Verify stage's first
non-trivial implementation, protecting the public catalog from the
embarrassing failure class.
**Rides:** runner preflight + run-status callback. **Gate:** the
model can only fail a run (safe direction); it cannot publish.

### 7. Run digests instead of run rows

Deterministic diff of consecutive frames-meta (range advanced,
frames padded, source lag growing) plus one completion: a weekly
operator digest — "SST advanced 6 days; ozone's lag grew from 10
to 14 days — worth a look." The gentle on-ramp to the
conditionally-approved failure-triage hook: same inputs, zero
risk, immediate value.
**Rides:** run rows + frames-meta history. **Gate:** inert text in
the portal; nothing acts on it.

### 8. Feedback triage

Cluster and summarize visitor feedback (text + screenshots,
already collected into dashboards) into themes: "12 reports this
month mention the time scrubber on mobile."
**Rides:** feedback store. **Gate:** summary is read by a human;
rule 4 applies (feedback text is untrusted input — it summarizes,
never instructs).

### 9. Metadata lint

Abstract readability, missing attribution, keyword gaps — surfaced
as accept-or-ignore suggestions inside the dataset form, where the
review gate is the human already sitting there.
**Rides:** dataset form + PATCH surface. **Gate:** every
suggestion is a click the author makes; nothing lands unattended.

## For in-world exhibits

### 10. Orbit at an in-world globe

A visitor at a Second Life globe asks a question, and the globe answers
and switches dataset for everyone standing at it. The plan is
[`SECOND_LIFE_COMPAT.md`](SECOND_LIFE_COMPAT.md); its §8 says why
today's chat endpoint can't serve a script: the prompt is built in the
browser, the endpoint requires an allowed `Origin`, and its rate limit
is per IP, while every script on a simulator host shares one. So this
is the one entry here that needs a new endpoint. The model call behind
it is the one Orbit's chat already makes. The visitor-facing version
that needs nothing is already available: the full app with `chat=1` on
a flat panel (that doc's Option E), where each conversation is private.
**Rides:** the node's own catalog + the Workers AI path in
`functions/api/chat/completions.ts` + Phase 2's in-world controller.
**Contract:** the script sends a question and the current dataset id.
The node builds Orbit's prompt itself and returns a short answer and at
most one dataset id. It checks that id against its catalog: images and
videos only, never a tour or a URL.
**Gate:** the node's Orbit toggle and an exhausted model quota both
fall back to what Phase 2 already gives a visitor: the dataset menu,
the notecard and the abstract in chat.
**Untrusted input:** a visitor's question never reaches the globe. Only
a checked dataset id does, and it obeys the same presenter-list and
short-hold rules as a touch, so a question during a talk can't change
the picture.
**Privacy:** a question comes in only explicitly, by touching "Ask
Orbit" and typing into a text box. The script never listens to nearby
chat, since Second Life's rules restrict relaying people's chat
without consent. Avatar names stay out of what is sent. It needs an
in-world disclosure, and `PRIVACY.md` would have to cover visitor
questions going to Workers AI.
**Abuse and cost:** an endpoint with no `Origin` check is a free model
for anyone on the internet, not only in Second Life. It needs
credentials per globe and a cap per globe. The AI-Generated Code
Security Auditor and the Privacy Engineer review it.
**Form:** one completion call with a fixed flowchart, so no agent. It
is the shape [`AGENT_SDK_EVALUATION.md`](AGENT_SDK_EVALUATION.md)
settles for Orbit.
**Effort:** a plan section first, then one endpoint and the
controller's "Ask Orbit" menu entry. It waits on Phase 2, whose touch,
presenter and hold rules it uses.

## Sequencing lean

First **#1** (smallest diff, precedent-shaped, biggest visitor
magic), then **#6** (real operational protection; gives Zyra's
skeleton Verify stage its first working muscle). The list splits
cleanly on the delight-visitors versus scale-publishers axis — the
node's next milestone should pick the order, not this doc.

## Non-goals

- Nothing here weakens a verdict in `AGENT_SDK_EVALUATION.md`;
  entries that would (auto-published free text, agent side
  effects beyond validated contracts) don't get promoted, they get
  redesigned.
- No entry is promoted to work without a plan section that names
  its contract, gate, and fallback — the same bar the authoring
  plan's phases met.
