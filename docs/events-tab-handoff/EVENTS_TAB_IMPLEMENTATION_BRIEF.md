# Events Tab — Implementation Brief (handoff to a coding session)

> **Purpose of this document.** The file `project/Events Tab Wireframes.dc.html` is a
> Claude Design canvas holding **four low-fidelity wireframe directions** for a new
> **Events** tab in the Terraviz **Publisher Portal**. This brief turns those wireframes
> into an implementation spec for a *separate* Claude Code session working inside the real
> Terraviz codebase (`zyra-project/terraviz`).
>
> It is **not** itself the implementation. It exists so the next session can build the
> screen **in high fidelity, in the dark Terraviz "app shell," in vanilla TypeScript**,
> without having to reverse-engineer intent from a low-fi mock.
>
> **Decisions already locked by the product owner:**
> - **Fidelity / styling:** High-fi **Terraviz app shell** (dark Publisher-Portal surfaces +
>   design-system tokens). The hand-lettered "Caveat" look, the light `#e9e9ee` canvas, the
>   sticky notes, and the "problem today" sketch are *wireframe scaffolding only* — **do not
>   port them.**
> - **Tech:** **Vanilla TypeScript** (the production app is vanilla TS + MapLibre GL JS +
>   Vite — *not* React). The design system's React components are **cosmetic references** for
>   look/markup/class names, not literal imports.

---

## 1. What this screen is for

Publishers integrate **current news / curated natural events** (today sourced from **NASA
EONET**) with **catalog datasets**. The Events tab is where a human **vets the queue**. The
work splits cleanly in two — the whole redesign hinges on keeping these two jobs visually and
interactionally separate:

1. **Triage the event** — *Is this real / worth surfacing?* → **Approve** or **Reject** the event.
2. **Confirm each dataset pairing** — *Does this dataset actually relate to the event?* →
   approve/reject **per dataset**.

A third, secondary job: **manually add an event** and search the catalog to pair datasets by
hand (and, in future, register new geo-aware feeds beyond EONET — USGS, arbitrary RSS, etc.).

### Why the current screen fails (the problems to fix)
The existing screen (see `project/uploads/pasted-*.png` and the "problem today" sketch in the
wireframe) has three concrete defects the new design must eliminate:
- **Cascading action buttons** — per-dataset Approve/Reject are absolutely positioned and drift
  diagonally off-screen.
- **No hierarchy between event-level and dataset-level actions** — they look identical, so users
  can't tell "surface this event" from "confirm this pairing."
- **Match scores mashed into one text run** — the Topic / Time / Geo signal is unreadable.

---

## 2. Recommended build order (the designer's "My take")

The wireframe presents four directions. They are **not** four screens to ship — they're one
product seen from four angles. Recommended path:

| Order | Direction | Role in the product |
|---|---|---|
| **1 — build first** | **A · Master–detail triage queue** | The **home view** of the Events tab. Clear two-level approve; scales to many events. |
| **2 — fold in** | **B · Keyboard triage inbox** | A **"focus mode"** toggle over the same data — clear the daily queue with the keyboard. |
| **3 — reuse** | **D · Matching workspace** | Its **right pane** *is* the **"+ New event"** flow (compose event → search & pair datasets). Its top **source switcher** is where future feeds register. |
| **4 — later** | **C · Expandable queue table** | The **upgrade path** once several feeds are being ingested — dense, sortable, bulk-select. Build when volume justifies it. |

All four share **one visual primitive: the compact match badge** (Topic / Time / Geo + composite
%). Build that primitive once (§5) and reuse it everywhere; it is the through-line that keeps the
four views coherent.

> If the next session only has budget for one thing: **build A**, with the **match badge** and the
> **two-level approval model** done properly. Everything else composes onto that.

---

## 3. Data model (derived from the wireframe's sample data)

Use this as the shape for fixtures and the eventual API. Sample values are taken directly from the
mock so the built screen matches the design's content.

```ts
type FeedSource = 'eonet' | 'usgs' | 'manual' | string; // open-ended: future RSS/geo feeds

type EventStatus = 'pending' | 'approved' | 'rejected';

interface CuratedEvent {
  id: string;
  title: string;              // "Snake River Wildfire"
  category?: string;          // "Wildfire" (drives the leading glyph, e.g. fire)
  source: FeedSource;         // 'eonet' today
  status: EventStatus;        // 'pending' by default
  location: {
    label: string;            // "Whitman, Washington"
    lat: number;              // 46.4   (render as 46.4°N)
    lon: number;              // -117.2 (render as 117.2°W)
    detail?: string;          // "5 mi NW of Clarkston, WA"
  };
  firstObservedUtc: string;   // ISO; display "2026-06-13 10:37 UTC", tabular-nums
  datasets: DatasetMatch[];   // sorted by composite desc
}

interface DatasetMatch {
  datasetId: string;
  name: string;               // "Temperature Anomaly: Yearly (NOAA)"
  scores: {
    topic: number | null;     // 0–100, null => not applicable ("—")
    time:  number | null;
    geo:   number | null;
  };
  composite: number;          // 0–100 overall match
  pairing: 'suggested' | 'paired' | 'rejected';
}
```

**Fixture data to reproduce (matches the mock):**

Proposed queue (8 pending; tab counts: Proposed · 8, plus Approved / Rejected / All):
- **Snake River Wildfire** — Whitman, Washington · 46.4°N, 117.2°W · EONET · first observed
  2026-06-13 10:37 UTC · detail "5 mi NW of Clarkston, WA" · **13 datasets** · Pending
- **Iceland Volcano — Reykjanes** · EONET · 06-18 04:12 · 6 datasets · Pending
- **Cyclone Mahina — Coral Sea** · EONET · 06-17 22:50 · 9 datasets · Approved
- **Sea Ice Minimum — Arctic** · **Manual** · 4 datasets · Pending
- *+4 more*

Snake River dataset matches (13 total; show top, then "10 more, sorted by match…"):
| Dataset | Topic | Time | Geo | Composite | Pairing |
|---|---|---|---|---|---|
| Temperature Anomaly: Yearly (NOAA) | 100 | 100 | — | **100%** | paired |
| Active Fires — VIIRS | 98 | 95 | 100 | **98%** | suggested |
| Drought Risk — Real-time | 90 | 100 | 83 | **91%** | suggested |
| Climate Model — Air Temp Change: SSP2 | 64 | 100 | 40 | **68%** | suggested |
| Precip SSP5 | — | — | — | **61%** | suggested |
| *(+8 low matches)* | | | | | |

---

## 4. Translating low-fi → Terraviz app shell (the global rules)

The wireframe is **light-on-white**. The product is **dark frosted "app shell."** Every surface,
color, and font in the mock maps to a design-system token. Load the system's CSS
(`_ds/.../styles.css`, which `@import`s `tokens/colors.css`, `tokens/typography.css`,
`tokens/spacing.css`) and **use the variables — never the raw hex from the mock.**

### 4.1 Surfaces & chrome
- **App-shell rule:** the Publisher Portal is the **flat, solid-bordered** surface family — *not*
  the frosted-glass globe overlay. Use `--color-surface-alt` / `--color-surface` fills with
  `--white-o08` / `--white-o10` borders. **Do not** apply `--glass-blur` here (blur is for panes
  floating over the globe; this is a full page of content).
- Page background: `--color-bg` (`#0d0d12`).
- Cards/panels: `background: var(--color-surface-alt)`, `border: 1px solid var(--white-o08)`,
  `border-radius: var(--radius-lg)` (8px).
- Dividers (the mock's `1px dashed #e2e2ea`): use a **solid** `1px solid var(--white-o08)`. Drop
  the dashed styling — it was wireframe shorthand.
- Top nav: reuse the **AppShell** pattern (`.tv-shell-nav`): brand on the left, nav links, active
  pill, sign-out. The Events tab is one nav entry in the portal.

### 4.2 Color mapping table
| Wireframe (light) | Meaning | Terraviz token (dark) |
|---|---|---|
| `#2b6fb0`, `#3a8bfd` text/links | accent | `--color-accent` (`#4da6ff`) |
| `#2b6fb0` button fill | primary action | `--color-accent-dark` (`#0066cc`); hover `--color-accent-darker` |
| `#eef4ff` / `#b9d3f6` chip | accent-soft fill/border | `--accent-o12` fill, `--accent-o30` border |
| `#3f8a5f`, `#e7f3ea` | success / strong match | `--color-success` text, `rgba(34,197,94,0.12)` fill, `rgba(34,197,94,0.25)` border |
| `#a87a16`, `#fbf2da`, `#e8b84b` | warning / mid match / pending | `--color-warning` text, `rgba(255,204,102,0.12)` fill, `rgba(255,204,102,0.28)` border |
| `#b8453c`, `#f6e6e4`, `#d9b3af` | reject / low match / error | `--color-error-soft` text, `rgba(239,68,68,0.12)` fill, `rgba(239,68,68,0.35)` border |
| `#2b2b33` titles | primary text | `--color-text` (`#e8eaf0`) |
| `#3a3a44` / `#6b6b75` body | body / labels | `--color-text-secondary` / `--color-text-muted` |
| `#8a8a94` / `#9a9aa4` meta | metadata / eyebrows | `--color-text-muted` / `--color-text-dim` |
| `#cdcdd6` empty checkbox | faint/disabled | `--color-text-faint` (decorative only) |
| `#c79320` status dot | pending marker | `--color-warning` |

### 4.3 Type
- **System font stack only** (`--font-sans`). The mock's `Caveat` hand-lettering is wireframe
  annotation — **delete it entirely.** Section headers like "Current events" become normal UI
  headings, not handwriting.
- **Section eyebrows** (the mock's tiny uppercase labels — "PROPOSED EVENTS", "SOURCE", "RELATED
  DATASETS"): `font-size: var(--text-2xs)`, `text-transform: uppercase`,
  `letter-spacing: var(--tracking-wider)` (0.08em), `font-weight: var(--weight-semibold)`,
  `color: var(--color-text-dim)`.
- **Coordinates, timestamps, counts, percentages:** `--font-mono` *or* `font-variant-numeric:
  tabular-nums` with `--tracking-normal`. Units use real glyphs and en-dashes: `46.4°N`,
  `117.2°W`, `2026-06-13 10:37 UTC`, `1982–present`.
- Type scale: card/event titles ≈ `--text-md`/`--text-lg`; body ≈ `--text-base`; meta ≈
  `--text-xs`/`--text-sm`. The UI runs deliberately small.

### 4.4 Status badges → `StatusBadge` (`.tv-status`)
Reuse the design-system tone logic. `tone` resolves from the label automatically:
`approved → positive` (green), `pending → pending` (amber), `rejected/retracted → negative` (red).
Classes: `.tv-status--positive | --pending | --negative | --neutral`. Don't hand-roll pill colors.

### 4.5 Buttons → `Button` (`.tv-btn`)
- **Event-level Approve** = `variant="primary"` (`.tv-btn--primary`, accent-dark fill). Make it
  visually the **heaviest** control on the detail pane — this is the high-order decision.
- **Event-level Reject** = `variant="danger"` (`.tv-btn--danger`, transparent + error border).
- **Per-dataset approve/reject** = small **icon buttons** (✓ / ✕), `--radius-md`, clearly
  **lighter weight** than the event-level pair so the two tiers read as different (this is the core
  fix for "event and dataset actions look identical").

### 4.6 Icons
Terraviz uses **monochrome Unicode symbol glyphs forced to text presentation** with the variation
selector `&#xFE0E;` (`U+FE0E`) so they inherit `currentColor`. **No emoji, no icon font, no
third-party icon lib.** Map the mock's emoji/symbols accordingly:
- 🔥 wildfire marker → a category glyph (or a small colored category dot); avoid the literal emoji.
- ✓ → `✓` / `✔`; ✕ reject → `✕` (`U+2715`); search → `⌕`; disclosure → `▸`/`▾`; external link → `↗`.
- **Every glyph-only button needs an `aria-label`** (e.g. "Approve event", "Reject Drought Risk
  pairing", "Expand row"). Toggling controls must update their label.

### 4.7 Spacing, radii, motion
- Radii: chips/pills `--radius-pill`, tags `--radius-xs`, inputs `--radius-sm`, buttons/badges
  `--radius-md`, cards `--radius-lg`.
- Gaps tight (`--space-xs`…`--space-md`); panel padding `--space-lg`…`--space-xl`.
- Motion: hover transitions `--transition-hover` (0.15s); any slide-in (focus-mode card, drawer)
  `--transition-panel` (0.3s ease). Respect `prefers-reduced-motion`. No bounces/spinners.

---

## 5. The shared primitive: the **Match Badge** (build once)

Every direction shows match quality the same way: **three per-facet chips (Topic / Time / Geo) +
one composite %.** This replaces the old "mashed text run." Implement it as a single reusable
vanilla-TS component/render-function and use it in A, B, C, and D.

**Anatomy** (compact row form, as in A and C):
- Three tags in order: `T <n>` (Topic), `Ti <n>` (Time), `G <n>` (Geo). `--radius-xs`,
  `--text-2xs`, `font-weight: 600`.
- One composite `NN%`, tabular-nums, bold, right-aligned, fixed width (~34px) so columns align.

**Color thresholds** (apply to *each* facet tag independently, and to the composite):

| Score | Tone | Token set |
|---|---|---|
| **≥ 85** | strong / success | `--color-success` on `rgba(34,197,94,0.12)` |
| **60–84** | mid / warning | `--color-warning` on `rgba(255,204,102,0.12)` |
| **< 60** | weak / error | `--color-error-soft` on `rgba(239,68,68,0.12)` |
| **`null` ("—")** | not applicable | neutral/warning muted (`--color-text-dim` on `--white-o05`); render the value as `—` |

(These thresholds reproduce the mock: 91% & 100% & 98% green; 68% & 61% amber; Geo 40 red; Geo "—".)

**Chip form** (B's pill summary): same color logic, pill shape (`--radius-pill`), with a leading
state glyph — `✓` for auto-paired (≥ threshold), `?` for "needs a human" (mid band). Example chips
from the mock: `✓ Drought Risk 91%` (green), `? SSP2 Air Temp 68%` (amber), `+8 low` (neutral
overflow chip).

**Auto-pair threshold:** datasets at **composite ≥ 90%** are auto-suggested as paired; the rest
need review. Surface this as a one-click bulk action ("**Approve all ≥ 90%**") and as the basis
for B's "8 auto-paired ≥ 90%" summary. Make the threshold a single named constant.

---

## 6. Per-direction specs

### A · Master–detail triage queue  *(build first — the home view)*

**Layout:** a bordered app-shell card containing:
- **Top bar:** heading "Current events" + **filter tabs as pills** — `Proposed · 8` (active),
  `Approved`, `Rejected`, `All` — pushed against a right-aligned **`+ New event`** primary button.
  (Use `Chip`/`Tabs` segmented variant for the filters.)
- **Two-pane body** (`min-height` ~520px):
  - **Left queue (~300px, fixed):** eyebrow "PROPOSED EVENTS", then event rows. Each row: a
    **status dot** (pending = `--color-warning`, inactive = faint), the **title** (ellipsis on
    overflow), and a sub-line `EONET · 13 datasets to review`. **Selected** row: `--accent-o08`
    background + a `3px solid var(--color-accent)` left border. Last row "+ 4 more…" at reduced
    opacity. Manual-sourced events read `Manual · …`.
  - **Right detail (flex):**
    1. **Event header:** title (`--text-lg`+, `--color-text`), sub-line `Whitman, Washington ·
       46.4°N, 117.2°W`, and a **`Pending` StatusBadge** top-right.
    2. **Meta strip** (bordered top+bottom): three fields — **Source** (`NASA EONET ↗`, accent
       link), **First observed** (`2026-06-13 10:37 UTC`, tabular), **Detail** (`5 mi NW of
       Clarkston, WA`).
    3. **Event-level decision** (the heavy tier): label "Surface this event?" + **Approve**
       (primary) + **Reject** (danger). This is the most prominent control block.
    4. **Dataset pairings:** section header `RELATED DATASETS · 13` with a right-aligned
       **`✓ Approve all ≥ 90%`** bulk action. Then **dataset rows**, each: name (ellipsis) ·
       **Match Badge** (T/Ti/G) · composite % · small **✓ / ✕ icon buttons**. A **paired** row gets
       a faint success tint + a `✓ Paired` micro-label. End with a muted "10 more, sorted by
       match…" affordance.

**Interactions:** selecting a left row swaps the right detail. Event Approve/Reject updates the
event's `StatusBadge` and (optionally) advances selection. Per-dataset ✓/✕ toggles
`pairing`. "Approve all ≥ 90%" bulk-sets all suggested rows above threshold to `paired`.

---

### B · Keyboard triage inbox  *(fold in as a "focus mode")*

A **toggle over the same queue** — one event in focus, full width, optimized for clearing the
queue by keyboard.

**Layout:**
- **Progress header:** `Proposed · 3 of 18`, a thin progress bar (`--color-success` fill on
  `--white-o10` track), and **keycap hints**: `A approve`, `R reject`, `J next` (render as bordered
  keycaps, `--radius-sm`).
- **Focused card** with a subtle "peek" of the next card behind it (a 14px stub bar above). Inside:
  - category eyebrow (`Wildfire · NASA EONET`), big title, meta line (`Whitman, WA · 46.4°N
    117.2°W · 2026-06-13 10:37 UTC`), and a **mini location map** (84×60) — see §7.
  - **Event decision** row: full-width **Approve event (A)** (primary/success) + **Reject (R)**
    (danger).
  - **Dataset summary, auto-decided:** `13 datasets matched · 8 auto-paired ≥ 90%` + `Review all ▸`.
    Then **Match Badge chips** (pill form): green `✓` chips for auto-paired, amber `?` chips for the
    mid-band ones that "need a human," a neutral `+8 low` overflow chip. Hint: *only the amber "?"
    ones need attention — Tab to them.*

**Keyboard model (implement explicitly, with visible focus + aria-live announcements):**
- `A` = approve current event, `R` = reject, `J` = next (skip). Tab moves focus through the amber
  "?" dataset chips so they can be individually resolved. Everything reachable by keyboard;
  announce state changes via an `aria-live="polite"` region. Honor `prefers-reduced-motion` for the
  card advance.

**Relationship to A:** same data, same Match Badge, same thresholds — B is a *mode switch*, not a
separate dataset.

---

### D · Matching workspace + add event  *(reuse the right pane as "+ New event")*

Two halves under a **source switcher**:
- **Source switcher (top):** pills — `⚡ NASA EONET` (active/amber), `USGS feed`, `✍ Manual`, and a
  dashed **`+ Add RSS / feed`** affordance. **This is the extensibility seam** — the place new
  geo-aware feeds/protocols register. Model sources as data (`FeedSource`), not hard-coded tabs.
- **Left — compose the event (~236px):** eyebrow "THE EVENT"; fields **Title**, **Location**
  (`46.4°N, 117.2°W ⌖`), a **mini map** for drop-a-pin / paste-coords, a **window from/to** date
  pair, and a **`Save & surface`** primary button. Use the design system's **FormField / TextField
  / SelectField** patterns (`.tv-field` family) styled for dark app shell.
- **Right — search & pair datasets (flex):** eyebrow "PAIR DATASETS"; a **SearchInput** ("search
  catalog…") with an **`auto-suggest ⚡`** accent affordance; sub-label "Ranked by match · drag or
  tap ✓"; then **candidate cards** — each card = dataset name + **Match Badge** (facet line) +
  composite % + an **add/✓ control**. Already-paired candidates get the success-tinted border;
  below-threshold candidates render dimmed. Footer note: "3 paired · low matches hidden below the
  fold."

**Reuse intent:** this right pane *is* the "+ New event" flow triggered from A's `+ New event`
button. Build it so A can open it (modal/drawer or routed sub-view).

---

### C · Expandable queue table  *(later — high-volume upgrade path)*

A dense **DataTable** (`.tv-table`) for triaging many events across many feeds.

- **Bulk toolbar:** select-all checkbox, "`3 selected`", bulk **Approve** / **Reject**, a
  **`Source: EONET ▾`** filter, and `+ New event`.
- **Columns:** `[checkbox] [disclosure] Event ↓ | Source | When | Datasets | Status | actions]`.
  Sortable headers (the `↓` shows sort). `When` and `Datasets` are tabular/right-aligned; `Source`
  is an accent link; `Status` is a **StatusBadge**; actions are ✓/✕ icon buttons.
- **Expandable row:** clicking the disclosure expands a **nested dataset sub-table** indented under
  the event — each pairing row = checkbox + dataset name + composite % badge + the compact facet
  string (`T100 · Ti100 · G—`), with "select to bulk-confirm." Collapsed rows show a `›`.
- Reuse `DataTable`'s custom-cell support; bulk-select drives the same pairing state as A/B/D.

---

## 7. The mini location map

The mocks fake the map with a radial-gradient blob + a pulsing pin. In production, use the app's
real mapping stack — **MapLibre GL JS** (already a Terraviz dependency) — to render a small static
locator: centered on the event's `lat/lon`, a single accent/error marker, non-interactive (or
lightly interactive for the "drop a pin" compose flow in D). Keep it small (≈84×60 in B, ≈full-width
×96 in D), `--radius-md`/`--radius-lg`, bordered. If a live map is too heavy for the queue context,
a static map image or a simple SVG locator is an acceptable first pass — just don't ship the
gradient placeholder.

---

## 8. Vanilla-TS implementation notes

- **Stack:** plain TS modules + Vite, MapLibre for maps. No React, no JSX. The DS React components
  are **reference only** — read their markup/class names (`.tv-btn`, `.tv-status`, `.tv-table`,
  `.tv-shell-*`, `.tv-chip`, `.tv-tabs`) and reproduce the same DOM + classes by hand, or port the
  styles into the app's existing CSS.
- **Tokens:** consume the existing token CSS variables (`--color-*`, `--space-*`, `--radius-*`,
  `--text-*`, `--tracking-*`). Do not introduce new raw hex.
- **Suggested module layout** (adapt to the repo's conventions — check `src/`):
  ```
  src/admin/events/
    EventsTab.ts          // tab shell + filter state + view switch (A ⇄ B focus mode)
    EventQueue.ts         // A: left master list
    EventDetail.ts        // A: right detail + two-level approval
    FocusInbox.ts         // B: keyboard triage mode
    EventTable.ts         // C: expandable table (later)
    NewEventWorkspace.ts  // D: compose + pair (also the "+ New event" flow)
    MatchBadge.ts         // §5 shared primitive (used by all of the above)
    eventsStore.ts        // state: events, pairings, filters, AUTO_PAIR_THRESHOLD = 90
    fixtures.ts           // §3 sample data
  ```
- **State:** a small store with the `CuratedEvent[]` plus current filter / selection / focus index.
  Approve/reject and pairing changes mutate it; views subscribe and re-render. Keep
  `AUTO_PAIR_THRESHOLD` and the facet color thresholds as named constants in one place.
- **Source-agnostic by construction:** treat `source` as data and the source switcher as a list —
  EONET is just the first entry. Don't bake "EONET" into types or UI strings beyond labels.

---

## 9. Content & accessibility (Terraviz voice)

- **Sentence case** for labels, buttons, body. The only uppercase is **section eyebrows** and
  display titles (wide 0.15em tracking).
- **Plain, warm, second-person, calm** microcopy. Counts read literally ("13 datasets to review",
  "3 of 18"). No emoji in product copy; symbols are icons only.
- **Numbers/units:** tabular figures, real units, en-dash ranges (`46.4°N`, `2026-06-13 10:37 UTC`,
  `06-13 → 06-20`).
- **A11y:** every glyph-only control gets an `aria-label`; toggles update it. Keyboard mode (B)
  needs visible focus, full keyboard reachability, and `aria-live` announcements for approve/reject/
  advance. Color is never the *only* signal — pair the Match Badge color with its number and (for
  chips) a `✓`/`?` glyph. Maintain AA contrast (the text ramp is designed for it; never use
  `--color-text-faint` for real body text).

---

## 10. Open questions for the product owner (resolve before/while building)

1. **Reject reasons / audit trail?** Should rejecting an event or a pairing capture a reason, and is
   the action reversible (the mock has an "All" filter implying history)?
2. **Auto-pair threshold — fixed at 90%?** Confirm 90 is the magic number, and whether publishers
   can tune it per feed.
3. **Approving an event with unreviewed pairings** — allowed (auto-accept ≥90% and defer the rest),
   or must all pairings be resolved first?
4. **Map fidelity in the queue** — live MapLibre locator everywhere, or static/SVG in dense lists
   and live only in the D compose flow?
5. **C now or later?** Confirm the table is deferred until multi-feed volume justifies it.
6. **"+ New event" surface** — modal, drawer, or routed sub-view off direction A?

---

### Appendix — what's in this handoff ZIP
- `EVENTS_TAB_IMPLEMENTATION_BRIEF.md` — this document.
- `images/01-current-screen-before.png` — the *current* (broken) admin screen. Note the
  Approve/Reject buttons cascading diagonally off-screen and the match scores mashed into one text
  run — the "before" the redesign must fix (§1).
- `images/02-wireframe-directions.png` — a capture of the low-fi wireframe canvas (directions A–D).
  Reference for *intent and layout only* — **do not** port its light background or hand-lettering;
  rebuild in the dark Terraviz app shell (§4).

### Appendix — source files in the original Claude Design export (not in this ZIP)
- `project/Events Tab Wireframes.dc.html` — the full four-direction wireframe canvas (the design).
- `project/uploads/pasted-*.png` — the *current* (broken) admin screen, for "before" context.
- `project/_ds/terraviz-design-system-.../` — the Terraviz design system: `README.md` (voice +
  foundations), `tokens/{colors,spacing,typography}.css` (the variables to use), `_ds_bundle.js`
  (cosmetic React component recreations + their `.tv-*` CSS, for reference).
- `chats/chat1.md` — the design conversation (intent + where the user landed).
- Real production code (if reachable): `zyra-project/terraviz` — see its `STYLE_GUIDE.md`,
  `tokens/global.json`, `src/styles/*`, `docs/COMPONENT_BRIEF.md`.
