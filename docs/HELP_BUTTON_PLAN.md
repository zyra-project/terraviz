# Help Button & Feedback Implementation Plan

Adds a "?" help button that opens a floating panel with two tabs: a **Guide** (how to use the app) and a **Feedback** form (bug reports / feature requests). Feedback is persisted to a new Cloudflare D1 table alongside the existing AI-response feedback.

**Branch**: `claude/add-help-button-XJum0`

---

## 1. Goals

1. Surface a discoverable entry point for first-time users to learn what the app does and how to navigate it.
2. Give users a lightweight channel to report bugs and request features without leaving the app.
3. Persist submissions in a queryable store so the team can triage and export them.
4. Match existing UI conventions exactly — glass-surface panel, ARIA patterns, responsive breakpoints, mutual exclusion with other panels.

---

## 2. Why a new D1 table (not the existing `feedback` table)

The existing `feedback` table is tightly coupled to rating AI responses:

- `CHECK (rating IN ('thumbs-up', 'thumbs-down'))` — can't store a bug/feature kind without relaxing the constraint (SQLite requires a table rebuild to drop a CHECK).
- Rows assume an AI message context: `message_id`, `conversation`, `system_prompt`, `turn_index`, `action_clicks`, `assistant_message`. Overloading bug reports would leave ~10 columns permanently null.
- Analytics queries on the AI dataset would need to filter out non-AI rows everywhere.

A sibling table keeps both datasets clean while reusing the existing `FEEDBACK_DB` D1 binding, rate limiter, and CORS logic. Mental model stays obvious: `feedback` = AI response ratings; `general_feedback` = app-level user reports.

### New migration — `migrations/0006_create_general_feedback_table.sql`

```sql
CREATE TABLE IF NOT EXISTS general_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('bug', 'feature', 'other')),
    message TEXT NOT NULL,
    contact TEXT NOT NULL DEFAULT '',      -- optional email/handle
    url TEXT NOT NULL DEFAULT '',          -- window.location at submit time
    user_agent TEXT NOT NULL DEFAULT '',
    app_version TEXT NOT NULL DEFAULT '',  -- from package.json / build env
    platform TEXT NOT NULL DEFAULT '',     -- 'web' | 'desktop'
    dataset_id TEXT,                       -- active dataset, if any
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_general_feedback_kind ON general_feedback (kind);
CREATE INDEX IF NOT EXISTS idx_general_feedback_created_at ON general_feedback (created_at);
```

---

## 3. Files to add / change

### Backend — new Cloudflare Function

| File | Responsibility |
|---|---|
| `functions/api/general-feedback.ts` | POST handler modelled on `functions/api/feedback.ts`. Reuses CORS allowlist, in-memory rate limiter (tightened to 5/min because content is higher-effort and spam risk is higher), validation style. Uses the existing `FEEDBACK_DB` binding. Accepts `{ kind, message, contact?, url?, datasetId? }`, server-fills `user_agent` and `platform`. |

### Types

| File | Change |
|---|---|
| `src/types/index.ts` | Add `GeneralFeedbackKind = 'bug' \| 'feature' \| 'other'` and `GeneralFeedbackPayload` interface alongside existing `FeedbackPayload` types. |

### Frontend service

| File | Responsibility |
|---|---|
| `src/services/generalFeedbackService.ts` | Thin module exporting `submitGeneralFeedback(payload)`. POSTs to `/api/general-feedback`. Uses the Tauri HTTP plugin lazy-loaded behind `IS_TAURI` (pattern from `llmProvider.ts`) so desktop builds bypass webview CORS. |

### UI — new module

| File | Responsibility |
|---|---|
| `src/ui/helpUI.ts` | Exports `initHelpUI()`, `openHelp()`, `closeHelp()`, `toggleHelp()`. Structure mirrors `src/ui/chatUI.ts`. Two tabs (Guide / Feedback) using `role="tablist"` + `aria-selected`. Escape closes. Click-outside closes (pattern from `downloadUI.ts:50-57`). Focus moves to panel on open; returns to trigger on close. |

### HTML + CSS

| File | Change |
|---|---|
| `src/index.html` | Add `<button id="help-trigger">` and `<div id="help-panel">` inside `<div id="ui">`. Add scoped CSS rules in the existing `<style>` block for `#help-trigger`, `#help-panel`, `.help-tab`, `.help-tabpanel`, `.help-form-*`. Reuse existing glass-surface tokens. |

### Wiring

| File | Change |
|---|---|
| `src/main.ts` | Import and call `initHelpUI()` in `initialize()` alongside `initMapControls()` / `initDownloadUI()`. |

### Tests

| File | Responsibility |
|---|---|
| `src/ui/helpUI.test.ts` | Vitest + jsdom. Covers: panel toggles on trigger click, Escape closes, tab switching updates `aria-selected`, form validation (empty message rejected, overlong message rejected), submit calls `generalFeedbackService` with correct payload. |

---

## 4. Guide tab content

Short, scannable sections (2–4 bullets each):

1. **Navigating the globe** — drag to rotate, scroll/pinch to zoom, double-click to focus
2. **Exploring datasets** — browse button, search, categories, tours
3. **Talking to Orbit** — what the AI docent can do, opening chat, inline load buttons, thumbs up/down
4. **Map controls** — labels, boundaries, terrain toggles
5. **Offline downloads** *(desktop only, gated on `IS_TAURI`)* — how to download, where files live, how to delete
6. **Keyboard shortcuts** — Escape closes panels, Enter sends chat
7. **Privacy note** — what data is sent with feedback (explicit, short)

Desktop-only sections are conditionally rendered based on `window.__TAURI__`.

---

## 5. Responsive layout

The panel adapts across the three breakpoint tiers already used by the codebase.

### Tier 1 — Desktop (`> 768px`)

- **Trigger** `#help-trigger` — top-right, `top: 0.75rem; right: 0.75rem;`. Pill-shaped like `#chat-trigger`: `?` glyph + "Help" label, ~36px tall.
- **Panel** `#help-panel` — floats down from trigger: `top: 3.5rem; right: 0.75rem;`. Width `380px` (matches chat), `max-height: calc(100vh - 5rem)`, scrollable body. Tabs in a horizontal row at top.
- Click-outside closes.

### Tier 2 — Mobile landscape / tablet (`≤ 768px`)

Mirrors `#chat-panel`'s mobile styles (`index.html:2078-2109`):

- **Trigger** collapses to a 48×48px circle with just the `?` glyph; label hidden via `display: none`.
- **Panel** stretches: `width: calc(100vw - 1.5rem); max-height: 70vh; top: 3.5rem; right: 0.75rem;`.
- Tab row stays horizontal; Guide sections become single-column.
- Form inputs get `min-height: 44px` touch targets, matching `#chat-send`.

### Tier 3 — Portrait phone (`≤ 600px` + `orientation: portrait`)

The top-right floating panel pattern fights this viewport: barely any horizontal room, and the on-screen keyboard eats the bottom half when the feedback textarea is focused. Four changes:

#### a. Panel becomes a full-screen sheet using `100dvh`

```css
@media (max-width: 600px) and (orientation: portrait) {
  #help-panel {
    top: 0; left: 0; right: 0; bottom: 0;
    width: 100vw;
    max-height: none;
    height: 100dvh;           /* dynamic vh — shrinks when keyboard opens */
    border-radius: 0;
    border: none;
    display: flex;
    flex-direction: column;
  }
}
```

`100dvh` avoids the classic iOS Safari "submit button hidden behind the keyboard" bug that `100vh` causes.

#### b. Visible close button in the panel header

Desktop/tablet users can tap outside to dismiss. On a full-screen sheet there is no "outside" — so the header gets a visible `×` close button (44×44px touch target), always rendered but only *visible* at this breakpoint via CSS.

#### c. Scroll the form, not the panel; sticky submit

The tabpanel gets `flex: 1; overflow-y: auto;` and the submit button lives in a `position: sticky; bottom: 0;` footer with the glass background, so it stays reachable as the textarea grows. Same trick the chat panel uses for its composer.

#### d. Trigger position & size

Moves closer to the edge and shrinks to 40px (matching `.browse-chat-btn` at this breakpoint, `index.html:2093-2098`):

```css
@media (max-width: 600px) and (orientation: portrait) {
  #help-trigger {
    top: 0.5rem;
    right: 0.5rem;
    width: 40px;
    height: 40px;
  }
}
```

### Panel coordination at portrait breakpoint

Because the help sheet fully covers the map and other panels in Tier 3, mutual-exclusion rules change:

- Opening help on portrait mobile **closes the chat panel** (otherwise chat is invisible but still holding focus, confusing screen readers).
- Opening help on desktop/tablet does **not** close chat — they coexist in opposite corners.
- This branches on `window.matchMedia('(max-width: 600px) and (orientation: portrait)').matches` inside `openHelp()`.

No ResizeObserver coordination is needed (unlike `chatUI.updateTriggerForInfoPanel()`) because the help panel either floats in its own corner or fully overlays everything.

### Summary table

| Breakpoint | Help panel treatment |
|---|---|
| `> 768px` | Floating 380px panel, top-right, label on trigger |
| `≤ 768px` | Panel widens to `calc(100vw - 1.5rem)`, trigger collapses to 48px circle |
| `≤ 600px` + portrait | Full-screen sheet (`100dvh`), sticky-footer submit, in-panel close button, 40px trigger at `0.5rem` inset |

---

## 6. Accessibility & edge cases

- Panel is `role="dialog"` with `aria-modal="false"` on desktop/tablet (non-blocking — matches chat pattern). On portrait mobile it's still `aria-modal="false"` since the user can close it via the visible × button.
- All icon-only buttons get `aria-label`.
- Tab list supports arrow-key navigation (Left/Right switch tabs).
- Form errors announced via `aria-live="polite"` status region.
- Submit button shows loading state and is disabled while in-flight.
- On network failure: inline error with retry; user's typed text is preserved.
- 429 rate-limit response surfaces a clear message.
- Contact field is optional; placeholder clarifies it's only used for follow-up.

---

## 7. Security & abuse

- Server-side length caps: message 2000 chars, contact 200, url 500, UA 500 — mirrors existing feedback endpoint.
- Rate limit: **5 submissions per IP per minute** (stricter than AI feedback's 10/min because content is higher-effort).
- Always render submitted text as text, never HTML.
- CORS allowlist identical to `feedback.ts`.
- No PII stored beyond what the user voluntarily types into the contact field.
- CSRF posture: same-origin POST + CORS check (matches existing endpoint).

---

## 8. Commit order

1. `feat(db): add general_feedback D1 table migration`
2. `feat(api): add /api/general-feedback Cloudflare Function`
3. `feat(types): add GeneralFeedbackPayload types`
4. `feat(ui): add help panel with guide and feedback tabs` (biggest commit — new `helpUI.ts`, HTML, CSS, main.ts wiring, service)
5. `test(ui): cover help panel toggle, tabs, and form validation`

All commits DCO-signed (`-s`) per `CLAUDE.md`.

---

## 9. Out of scope (flagged for discussion)

- **Screenshots attached to bug reports** — adds significant scope (canvas capture, upload storage, privacy review). Defer to follow-up.
- **GitHub Issues auto-filing** — requires secrets management and opens abuse vectors. D1 storage first; triage/export tooling later.
- **Guide content as Markdown files** — keeping it as static HTML in `helpUI.ts` is simpler; no Markdown pipeline exists today. Revisit if the guide grows.
- **Analytics on help button usage** — no analytics system exists; won't add one for this.

---

## 10. Open questions

1. **Trigger placement** — top-right corner, or folded into the existing map controls toolbar (top-left)? Top-right keeps it discoverable and avoids conflict with any current element.
2. **New D1 table vs. overloading `feedback`** — confirm the sibling-table approach.
3. **Screenshots in bug reports** — in or out of v1? (Recommend out.)
4. **GitHub Issues auto-filing** — in or out? (Recommend out.)
5. **Guide topic emphasis** — any sections in §4 to expand, drop, or reorder?
