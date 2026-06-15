# Design Sync — Reverse Direction & Scaling Plan

**Status: draft for review.** No code is built by this plan and no
`tokens/*.json` file is changed as part of authoring it. This document
designs the **reverse** half of the design-system sync (Penpot → repo)
and sketches how the pipeline could scale to complete panels and
full-screen layouts. It is the companion to
[`DESIGN_SYSTEM_PLAN.md`](DESIGN_SYSTEM_PLAN.md), which remains the
architecture-of-record for the forward direction (repo → Penpot) and
the token model. Where the two overlap, `DESIGN_SYSTEM_PLAN.md` owns
the token schema and build; **this doc owns the round-trip**.

---

## Context

The forward direction is shipped. `tokens/global.json` +
`tokens/components/*.json` (W3C Design Tokens) build through Style
Dictionary into the gitignored `src/styles/tokens.css`, and three
**seeder** scripts push those tokens *into* Penpot through the Penpot
MCP `execute_code` tool:

| Seeder | Seeds | Penpot target |
|---|---|---|
| `scripts/sync-penpot-global.ts` | `tokens/global.json` (color + dimension) | `Global` set |
| `scripts/sync-penpot-components.ts` | `tokens/components/*.json` | `Components/{Browse,Chat,Playback,Tools-Menu}` sets |
| `scripts/sync-penpot-modes.ts` | `com.tokens-studio.modes` blocks | `Modes/*` sets + `Default`/`Tablet`/`Phone Portrait`/`Mobile Native` themes |

The **reverse** direction — a designer changing a value, panel, or
layout in Penpot and that change flowing back into `tokens/*.json` as a
reviewed PR — does **not** exist. `DESIGN_SYSTEM_PLAN.md` defers it
explicitly:

> Round-trip in the other direction (Penpot → JSON export). The
> designer-side export-and-commit flow described above remains the
> canonical channel for now; a future script will diff Penpot's
> exported JSON against `tokens/*.json` to streamline review.

That manual "export-and-commit" flow is the only reverse channel today,
and it is the friction this plan removes. The long-term ambition is a
low-friction two-way sync covering **complete panels and full-screen
layouts across desktop, tablet, phone-portrait, and the Tauri
mobile-native axis** — but that ambition has a worth-it ceiling, drawn
honestly in §3.

---

## §1 Current-state audit

### The live MCP tool surface is four tools

The Penpot MCP server (pre-beta, wired at account level + local
`.mcp.json`) exposes exactly four tools:

| Tool | Purpose | Direction |
|---|---|---|
| `high_level_overview` | Usage instructions for the Penpot API | read |
| `penpot_api_info` | API-doc introspection for a type/member | read |
| `execute_code` | Run arbitrary JS in the Penpot plugin context | read **and** write |
| `export_shape` | Render a shape to PNG/SVG | read (raster/vector) |

There are **no** granular typed token / component / layout MCP tools.
Every capability — read or write — funnels through `execute_code`
against the `penpot.library.local.tokens` object graph (`tokens.sets`,
`set.tokens`, `token.value`, `tokens.themes`, `theme.activeSets`). This
is the single most important audit finding: the MCP is a **code-execution
bridge**, not a typed API, so the reverse path is not blocked on any
missing tool — it is the *same bridge* the seeders already use, run in
the read direction.

> **Live probe is a prerequisite, not done here.** This audit was
> assembled from the loaded MCP tool schemas and the seeders' proven
> read patterns. The empirical read-only probe (enumerate the live
> sets / tokens / themes, confirm data shapes) is **blocked under plan
> mode** — every `mcp__penpot__*` call returns "requires approval" with
> no interactive prompt. It is the gating first task of Phase R0 (§4),
> to be run in a normal session against the focused Penpot file.

### What the MCP can and can't do

| Capability | Status | Notes |
|---|---|---|
| Read all token sets + values | ✅ via `execute_code` | Seeders already do this for idempotency |
| Read themes + active-set composition | ⚠️ verify live | `theme.activeSets` read path unverified; see risk below |
| Write/upsert tokens | ✅ proven | The three seeders |
| Read component frames / boards geometry | ⚠️ unverified | Needed only for §3 scaling; probe in R4 |
| Export a board image | ✅ `export_shape` | Useful for visual diffing, not token data |
| Typed token CRUD without JS | ❌ | No such tool; everything is `execute_code` |

### The reverse path is a mirror of the seeders

The seeders already *read* the token graph (find an existing set, read
`token.value`, compare for idempotent upsert). An exporter inverts the
write step: read the same graph, emit it as JSON, reconcile it to the
repo shape. Same files, same naming map, opposite direction. Concretely,
the JSON-path ↔ Penpot-token-name map the seeders apply forward
(`component.browse.panel-width` ↔ Penpot token `component.browse.panel-width`
↔ CSS `--component-browse-panel-width`) is the exact map the exporter
applies in reverse.

### Round-trip-hostile tokens (repo stays authoritative)

Some tokens **cannot faithfully round-trip** through Penpot because the
seeders deliberately skip them — Penpot's `addToken` rejects the value.
The repo must remain the source of truth for these, and the exporter
must restore them from the existing repo file rather than trust Penpot:

| Hostile class | Example | Why |
|---|---|---|
| `calc(...)` dimensions | `component.chat.panel-max-height = calc(100vh - 8rem)` | Penpot `addToken` → "Value not valid" |
| `number` / fractional weight | `component.chat.msg-line-height = 1.55`; `ui.scale = 1` | No unitless-number token variant in Penpot |
| Composite (hand-maintained) | `--glass-border: 1px solid var(--color-surface-border-subtle)` | Lives in `multi-mode-css.mjs`, never a token |

A second, subtler hazard: the CSS **build** wraps values in
`calc(... * var(--ui-scale))` and floors touch targets with
`max(44px, …)` — but that wrapping lives in `tokens/multi-mode-css.mjs`,
**not** in the tokens. It never reaches Penpot, so it must never appear
in exported JSON. The exporter reads raw token values; the reconcile
step must assert no `var(--ui-scale)` / `max(` artifacts leak in.

### Mode/theme inversion

`sync-penpot-modes.ts` *flattens* each token's
`$extensions["com.tokens-studio.modes"]` block into separate `Modes/*`
override sets plus composing themes. The exporter must do the inverse:
read the `Modes/Tablet` / `Modes/Phone-Portrait` / `Modes/Mobile-Native`
sets and **re-nest** their overrides back under each base token's
`$extensions["com.tokens-studio.modes"]`, with `default` taken from the
base set. The theme composition (which set wins where — phone-portrait
inherits tablet) is the rule that tells the exporter which mode key an
override belongs to.

---

## §2 Reverse-sync design  *(priority — the core of this plan)*

### Source of truth, per artifact

The round-trip is not symmetric ownership. Different artifacts have
different owners, and the reconcile step enforces this:

| Artifact | Source of truth | On conflict |
|---|---|---|
| Designer-facing visual values (colors, radii, panel dims, font weights) | **Penpot** (designer-owned) | Take Penpot; surface in PR diff |
| `calc(...)` / `number` / composite tokens | **Repo** (engineer-owned) | Keep repo; warn that Penpot can't express it |
| UI-scale / touch-floor wrapping | **Build** (`multi-mode-css.mjs`) | Never a token; strip if seen |
| Token *structure* (which tokens exist, naming) | **Repo** (the schema) | New token in Penpot → flag, don't auto-add silently |
| Layout / DOM / animation / structural CSS | **Code** (non-goal to sync) | Out of scope (see §3) |

### Two channels, one reconcile

Per the approved direction, the plan supports **both** a primary
MCP-driven channel and a no-agent fallback. Crucially they converge on a
**single reconcile + diff + PR step** — designers never hand-edit repo
JSON, and there is exactly one place that knows the repo shape.

```
(A) MCP exporter ──┐
                   ├──► reconcile ──► three-way diff ──► PR
(B) Native export ─┘    (normalize)
```

**Channel A — MCP exporter (primary).** For each seeder, a mirror
`read-penpot-*.ts` (or a `--read` mode on the existing script) emits
**reader** plugin JS. An agent (a Claude Code session) runs it through
`execute_code`, receives the token/set/theme graph as JSON, hands it to
the reconcile step, writes `tokens/*.json`, runs `npm run tokens`, and
opens a PR. Lowest designer friction — the designer says "sync my Penpot
changes" and reviews a PR — at the cost of an agent in the loop.

**Channel B — Native export (fallback).** The designer uses Penpot's
built-in Tokens → Export JSON, drops the file(s) in a watched path, and
a script feeds them to the *same* reconcile step. No agent or MCP
dependency, but a manual export click and a slightly different input
shape to normalize.

| | A: MCP exporter | B: Native export |
|---|---|---|
| Designer friction | Lowest ("sync it") | One manual export step |
| Dependencies | Agent + live MCP (pre-beta) | None beyond Penpot |
| Input shape | Plugin-graph JSON (we control) | Penpot's export format (we don't) |
| Failure mode | MCP instability / wrong focused file | Stale/partial export, human error |
| Role | **Primary** | Fallback / no-agent path |

### Normalization (the one reconcile step)

Both channels produce *some* Tokens-Studio-shaped JSON; the reconcile
module maps it to the canonical repo shape:

1. **Re-nest modes** — fold `Modes/*` overrides back under each token's
   `$extensions["com.tokens-studio.modes"]` (the §1 inversion).
2. **Restore the hostile set** — copy `calc`/`number`/composite tokens
   verbatim from the current repo file; never accept a Penpot value for
   them.
3. **Strip build artifacts** — reject any `var(--ui-scale)` / `max(` /
   `blur(` wrapping that leaked from CSS rather than tokens.
4. **Canonical sort + format** — match the existing JSON ordering so a
   no-op sync produces an empty diff (the same canonicalization
   discipline the locale codegen uses, so Weblate-style whitespace
   churn doesn't appear).

### Drift / conflict handling

A two-way "designer wins" overwrite silently loses concurrent engineer
edits. The plan uses a **three-way** model:

- **Base** = current `tokens/*.json` in the repo.
- **Incoming** = the Penpot export (channel A or B).
- **Ancestor** = a last-synced snapshot (a `tokens/.penpot-snapshot/`
  copy written on every successful sync — *pending open question 3*).

Resolution:

- Token changed only in Penpot → take Penpot.
- Token changed only in repo since last sync → keep repo, don't clobber.
- Changed in both → real conflict: keep repo for hostile tokens (warn),
  otherwise take Penpot but **flag it loudly in the PR body** for human
  review.
- Token present in Penpot but absent from repo schema → flag, do not
  auto-add (schema is repo-owned).

If open question 3 resolves toward "no ancestor", the model degrades to
two-way (designer-wins on visual tokens, repo-wins on hostile) — simpler,
but blind to concurrent engineer edits.

### Round-trip fidelity verification (the acceptance gate)

The exporter is correct iff it is the exact inverse of the seeder on the
round-trippable set. The gate:

```
seed (repo → Penpot) → export (Penpot → JSON) → normalize → diff vs repo
```

must produce an **empty diff** for round-trippable tokens, and must
assert the hostile set is **byte-identical** to the repo (proving the
exporter restored rather than dropped them). This is the symmetric twin
of the seeders' idempotency check (0 created / 0 updated on re-run), and
it is the merge gate for every reverse-sync change.

---

## §3 Scaling architecture *(sketch, not a full spec)*

The token round-trip above is the tractable core. "Complete panels and
full-screen layouts across multiple dimensions" is the ambition — this
section sketches how it *could* map, and draws the line where it stops
being worth it.

### What maps cleanly

| App concept | Penpot concept | Sync direction |
|---|---|---|
| Dimensional/visual token | Token in a set | Two-way (this plan) |
| Responsive breakpoint *value* | Token mode | Two-way (this plan) |
| Desktop/tablet/phone/native axis | Theme (`Default`/`Tablet`/…) | Two-way (this plan) |
| Panel *visual spec* (a complete panel's tokens) | A component + its token set | Two-way (extends Tier-2, R2) |
| Board-level breakpoint geometry (panel size at a breakpoint) | A board / variant per dimension | One-way Penpot→tokens at best |

The multi-dimension axis already has a home: Penpot **themes** ↔ CSS
`@media` / `.mobile-native`. Adding the Tauri mobile-native axis is more
of the same — it is already a seeded theme. Complete *panels* are a
quantitative extension of Tier-1: more component sets, same machinery.

### What stays in code (and why)

`DESIGN_SYSTEM_PLAN.md` already declares these out of scope, and this
plan keeps them there:

- Layout logic (grid templates, flex direction, absolute positioning).
- Animation / transition definitions.
- JS-driven state classes and structural CSS (display, overflow,
  z-index, pointer-events).
- The `@media` block *structure* itself (only breakpoint values are
  tokens).

The app is vanilla TS with floating glass overlays positioned by
hand-tuned CSS and ResizeObserver coordination (see CLAUDE.md "UI Layout
& Panel Coordination"). That positioning logic is behavioural, not
declarative, and does not have a faithful Penpot representation.

### Where this stops being worth it (honest non-goals)

- **Generating DOM/layout from Penpot boards.** A Penpot board is a
  frozen rectangle; the app's panels are reactive, breakpoint-aware, and
  ResizeObserver-driven. Round-tripping geometry would mean either
  dumbing the app down to static frames or building a board→CSS compiler
  that re-derives the reactive behaviour — neither pays for itself.
- **Pixel-exact board ↔ CSS reconciliation.** Sub-pixel and
  `calc()`/`env()` realities (safe-area insets, `dvh`, UI-scale) have no
  Penpot equivalent. Chasing pixel parity fights the build's own
  intentional wrapping.
- **Tier-3 surfaces** (loading, download, tour) — stable, rarely
  redesigned; not worth tokenizing or syncing.

The defensible ceiling: **tokens and breakpoint geometry live in Penpot;
layout logic lives in code.** Panels scale as token sets; full-screen
*layout* does not become a Penpot artifact.

---

## §4 Sequencing

A phased, low-risk rollout. Each phase has a definition of done; nothing
generalizes before the round-trip is proven on one slice.

| Phase | Scope | Done when |
|---|---|---|
| **R0 — validation slice** | Live MCP probe; hand-run reverse of **`Components/Playback`** through `execute_code`; manual reconcile | `seed → export → diff` is empty for Playback's round-trippable tokens; hostile set unchanged; live theme/`activeSets` read confirmed |
| **R1 — generalize** | `read-penpot-*.ts` mirrors for all seeded sets; the shared reconcile module; fidelity test wired as **advisory** CI | Reverse sync runs for global + all Tier-1 + modes; fidelity gate green; one channel (A or B) end-to-end |
| **R2 — Tier-2** | info-panel + help: extend seeders **and** exporter together | Tier-2 tokens round-trip with the same fidelity gate |
| **R3 — spacing scale** | Activate `--space-*`, migrate raw `rem` (independent of reverse sync) | `--space-*` live in CSS; tokens round-trip |
| **R4 — layout sketch → spike** | Probe board/variant read; decide build-vs-non-goal per §3 | A written go/no-go; likely **no-go** on layout generation |

**Dependencies.** R1 depends on R0 (don't generalize an unproven
inverse). R2 depends on R1 (stable pipeline). R3 is independent and may
be pulled earlier (*open question 5*). R4 is gated on R1–R3 and may be
declared not-worth-it outright.

**The concrete first slice is `Components/Playback`** — a full component
set that exercises dimension modes (tablet overrides) but, unlike chat,
carries no `calc`/`number` hostile tokens, so it isolates the reverse
mechanism from the restore-from-repo path. It is the smallest honest
proof that the reverse direction works against the live MCP.

---

## §5 Decisions

- **Reverse sync is a mirror of the seeders**, not a new subsystem —
  same files, same naming map, inverted direction.
- **Both channels, one reconcile** — MCP exporter primary, native export
  fallback, converging on a single normalize + three-way-diff + PR step.
- **Repo is authoritative for the hostile set** (`calc`/`number`/
  composite) and for token *structure*; the exporter restores rather
  than trusts Penpot for these.
- **Empty round-trip diff is the acceptance gate** — the symmetric twin
  of the seeders' idempotency check.
- **Scaling stops at tokens + breakpoint geometry in Penpot**; layout,
  animation, and structural CSS stay in code.

---

## §6 Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Pre-beta MCP instability / API drift | Exporter breaks silently | Fallback channel B; pin the probed API surface in R0; advisory (not gating) CI |
| `theme.activeSets` read unreliable (cf. `addSet` was broken on the seeded version) | Wrong mode inversion | Verify in R0 before trusting theme composition; fall back to reading `Modes/*` sets by name |
| Wrong focused Penpot file | Export reads the wrong library | Guard on `penpot.currentFile?.name` before any read (same operating note the seeders use) |
| Designer value silently overwrites engineer edit | Lost work | Three-way diff with snapshot ancestor; loud PR flagging |
| Build-wrapping leaks into JSON | `var(--ui-scale)`/`max(` in tokens | Reconcile step strips + asserts; fidelity gate catches |
| Scope creep into layout generation | Unbounded effort | §3 non-goals; R4 is a go/no-go spike, not a build |

---

## §7 Open questions

1. **Agent-in-the-loop for the primary channel** — is it acceptable that
   the low-friction reverse path *requires* a Claude Code session, or
   must the primary path be designer-runnable with no agent (which would
   make native export co-equal rather than fallback)?
2. **PR mechanics** — open a real PR per sync, or write the JSON diff to
   a branch for a human to PR? Any branch-naming / reviewer convention to
   bake in?
3. **Last-synced snapshot** — store a `tokens/.penpot-snapshot/`
   ancestor for three-way conflict detection, or accept simpler two-way
   "designer-wins-on-visual / repo-wins-on-hostile" with no ancestor?
4. **Scope ceiling for §3** — stop at "tokens + breakpoint geometry in
   Penpot, layout in code", or seriously scope Penpot-board → CSS layout
   generation (with the non-goal argued either way)?
5. **Tier-2 + spacing ordering** — confirm R1→R4, or pull spacing-scale
   activation (R3) earlier since it is independent of the reverse sync?

---

## References

- [`DESIGN_SYSTEM_PLAN.md`](DESIGN_SYSTEM_PLAN.md) — forward direction,
  token model, build pipeline (architecture-of-record).
- [`COMPONENT_BRIEF.md`](COMPONENT_BRIEF.md) — token-to-property mapping.
- [`DESIGN_TOOL_GETTING_STARTED.md`](DESIGN_TOOL_GETTING_STARTED.md) —
  Penpot setup.
- [`../tokens/README.md`](../tokens/README.md) — developer token
  workflow.
- Seeders: [`../scripts/sync-penpot-global.ts`](../scripts/sync-penpot-global.ts),
  [`sync-penpot-components.ts`](../scripts/sync-penpot-components.ts),
  [`sync-penpot-modes.ts`](../scripts/sync-penpot-modes.ts).
- Build: [`../tokens/style-dictionary.config.mjs`](../tokens/style-dictionary.config.mjs),
  [`../tokens/multi-mode-css.mjs`](../tokens/multi-mode-css.mjs).
