# Help Button & Feedback Implementation Plan

Adds a "?" help button that opens a floating panel with two tabs: a **Guide** (how to use the app) and a **Feedback** form (bug reports / feature requests). Feedback is persisted to a new Cloudflare D1 table alongside the existing AI-response feedback.

**Branch**: `claude/add-help-button-XJum0`

---

## Implementation notes (updates to the original plan)

A few things evolved during implementation and diverge from the responsive design sketched below. The code is the source of truth; this section records the deltas for anyone reading the plan as historical context.

- **Desktop is a centered modal, not a top-right flyout.** The original Tier 1 design was a 380px panel anchored to the top-right corner, mirroring the chat panel. Once shipped, that felt cramped for guide content on wide screens, so the desktop treatment was converted to a centered modal (up to 640px wide, `min(80vh, calc(100vh - 4rem))` tall) with a `rgba(0, 0, 0, 0.5)` backdrop. Tier 2 (tablet) and Tier 3 (portrait phone) are unchanged. See `src/index.html` for the final CSS.
- **Feedback screenshots are full-UI composites, not globe-only.** The original plan reused the existing `captureGlobeScreenshot()` helper. During testing it became clear that bug reports often depend on surrounding UI state (info panel content, chat state, etc.), so a new `captureFullScreen()` path was added that lazy-loads `html2canvas` and composites the globe onto the full viewport. The help panel itself, the backdrop, and both help triggers are excluded via `ignoreElements`. The Orbit vision flow continues to use `captureGlobeScreenshot()` — globe-only — per the product call.
- **Admin dashboard grew a lazy-loaded screenshot path.** Inlining 100-row-worth of data URLs in the dashboard list response could produce multi-megabyte payloads. The list response now returns `hasScreenshot` + `screenshotLength`; the screenshot itself is fetched on demand from a new `/api/general-feedback-screenshot?id=N` endpoint when the admin opens a detail panel.
- **Shared escape helpers live in `src/ui/domUtils.ts`.** `escapeHtml` and `escapeAttr` started life in `browseUI.ts`. Once `helpUI.ts` entered the picture, `browseUI → helpUI → chatUI → browseUI` became a circular import graph. The helpers were extracted to a neutral `domUtils.ts` module; `browseUI` still re-exports them for backward compatibility.
- **CSV export reports estimated decoded screenshot bytes.** The first draft exported `row.screenshot.length` which is character count of the data URL, not the actual image size. The export now emits an estimated decoded byte count derived from the base64 payload length (minus padding).

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
    screenshot TEXT NOT NULL DEFAULT '',   -- optional base64 JPEG data URL
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_general_feedback_kind ON general_feedback (kind);
CREATE INDEX IF NOT EXISTS idx_general_feedback_created_at ON general_feedback (created_at);
```

Screenshot is stored as an optional TEXT data URL. **Updated from the original plan**: the implemented feedback flow captures via a new `captureFullScreen()` helper rather than the older globe-only `captureGlobeScreenshot()`. The image is a full-UI composite (with the help UI and backdrop excluded via html2canvas's `ignoreElements`), scaled to at most 1280px on the longer edge and JPEG-compressed at 0.7 quality client-side. Payloads are materially larger than the old 10–30KB globe-only captures — typical full-UI composites land in the 50–150KB range — so the server enforces a 200KB cap to guard against pathological inputs while staying comfortably within D1 row limits. The globe-only `captureGlobeScreenshot()` path still exists and is used by the Orbit vision flow.

---

## 3. Files to add / change

### Backend — new Cloudflare Function

| File | Responsibility |
|---|---|
| `functions/api/general-feedback.ts` | POST handler modelled on `functions/api/feedback.ts`. Reuses CORS allowlist, in-memory rate limiter (tightened to 5/min because content is higher-effort and spam risk is higher), validation style. Uses the existing `FEEDBACK_DB` binding. Accepts `{ kind, message, contact?, url?, datasetId?, screenshot? }`, server-fills `user_agent` and `platform`. Caps screenshot at 200KB. |

### Types

| File | Change |
|---|---|
| `src/types/index.ts` | Add `GeneralFeedbackKind = 'bug' \| 'feature' \| 'other'` and `GeneralFeedbackPayload` interface (including optional `screenshot?: string`) alongside existing `FeedbackPayload` types. |

### Screenshot helper — extract existing function

The Orbit chatbot already has `captureGlobeScreenshot()` at `src/services/docentService.ts:36-56` — a clean standalone function that returns a JPEG data URL at 0.6 quality, downsampled to max 512px. The MapLibre canvas is already configured with `preserveDrawingBuffer: true` (`mapRenderer.ts:341`). Extraction is trivial.

| File | Change |
|---|---|
| `src/services/screenshotService.ts` | **New**. Houses `captureGlobeScreenshot()` and the `VISION_MAX_SIZE = 512` constant, moved verbatim from `docentService.ts`. No behavior change. |
| `src/services/docentService.ts` | Remove the local `captureGlobeScreenshot()` definition; import from `screenshotService`. Re-export if any external caller depends on the old import path (none found in this search, but worth double-checking during implementation). |
| `src/services/docentService.test.ts` | Update import paths in the existing tests (lines 589–641 per exploration). Coverage remains identical. |

### Frontend service

| File | Responsibility |
|---|---|
| `src/services/generalFeedbackService.ts` | Thin module exporting `submitGeneralFeedback(payload)`. POSTs to `/api/general-feedback` using the browser/webview **native `fetch`** — not the Tauri HTTP plugin. The endpoint is same-origin, so native fetch resolves the relative URL correctly and sends an `Origin` header that matches the server's CORS allowlist. This matches how `chatUI.submitInlineRating()` already hits `/api/feedback` on both web and desktop. (The original plan suggested the Tauri HTTP plugin, but that's only needed for cross-origin calls like local LLM servers where webview CORS blocks the webview's fetch; same-origin API routes don't need it.) |

### UI — new module

| File | Responsibility |
|---|---|
| `src/ui/helpUI.ts` | Exports `initHelpUI()`, `openHelp()`, `closeHelp()`, `toggleHelp()`. Structure mirrors `src/ui/chatUI.ts`. Two tabs (Guide / Feedback) using `role="tablist"` + `aria-selected`. Escape closes. Click-outside closes (pattern from `downloadUI.ts:50-57`). Focus moves to panel on open; returns to trigger on close. |

### HTML + CSS

| File | Change |
|---|---|
| `src/index.html` | Add `<button id="help-trigger">` (floating top-right) and `<div id="help-panel">` inside `<div id="ui">`. Add scoped CSS rules in the existing `<style>` block for `#help-trigger`, `#help-panel`, `.help-tab`, `.help-tabpanel`, `.help-form-*`. Reuse existing glass-surface tokens. |
| `src/ui/browseUI.ts` | Add a second small `?` trigger button (`#help-trigger-browse`) inside the browse overlay header. Wire it to the same `toggleHelp()` handler. Set/remove a `body.browse-open` class when the overlay opens/closes, so the floating trigger can hide itself via CSS. |

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
2. **Exploring datasets** — browse button, search, categories, filters
3. **Guided tours** — what tours are (camera moves + dataset swaps + narration), how to start one from the browse panel, using the tour transport controls to play/pause/skip, how Q&A pauses work, how to exit a tour
4. **Talking to Orbit** — what the AI docent can do (explain phenomena, recommend datasets), opening chat, inline load buttons, thumbs up/down feedback on answers
5. **Map controls** — labels, boundaries, terrain toggles
6. **Offline downloads** *(desktop only, gated on `IS_TAURI`)* — how to download, where files live, how to delete
7. **Keyboard shortcuts** — Escape closes panels, Enter sends chat, Space toggles playback
8. **Privacy note** — what data is sent with feedback (explicit, short; mentions optional screenshot)

Desktop-only sections are conditionally rendered based on `window.__TAURI__`.

---

## 5. Responsive layout

The panel adapts across the three breakpoint tiers already used by the codebase. Across all tiers there are **two triggers** sharing one `toggleHelp()` handler, coordinated via a `body.browse-open` class that `browseUI.ts` sets when the overlay is visible:

| Trigger | DOM location | Visible when |
|---|---|---|
| `#help-trigger` | Floating, top-right of viewport | Browse overlay is **closed** |
| `#help-trigger-browse` | Inside `#browse-header` | Browse overlay is **open** (inherits overlay visibility) |

CSS coordinates the floating one:

```css
body.browse-open #help-trigger { display: none; }
```

Net effect: exactly one visible help button at any time, always in the user's field of view, with no JS state to synchronize.

### Tier 1 — Desktop (`> 768px`)

- **Floating trigger** `#help-trigger` — top-right, `top: 0.75rem; right: 0.75rem;`. Pill-shaped like `#chat-trigger`: `?` glyph + "Help" label, ~36px tall.
- **In-header trigger** `#help-trigger-browse` — small `?` icon button, ~28px, placed at the right end of `#browse-header` next to any existing header controls.
- **Panel** `#help-panel` — floats down from the *floating* trigger location even when opened from the in-header button: `top: 3.5rem; right: 0.75rem;`. Width `380px` (matches chat), `max-height: calc(100vh - 5rem)`, scrollable body. Tabs in a horizontal row at top. The panel can overlay the browse overlay since it has a higher z-index.
- Click-outside closes.

### Tier 2 — Mobile landscape / tablet (`≤ 768px`)

Mirrors `#chat-panel`'s mobile styles (`index.html:2078-2109`):

- **Floating trigger** collapses to a 48×48px circle with just the `?` glyph; label hidden via `display: none`.
- **In-header trigger** stays the same shape (icon-only was already the desktop design); bumps to 40px to meet the touch-target minimum.
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

Floating trigger moves closer to the edge and shrinks to 40px (matching `.browse-chat-btn` at this breakpoint, `index.html:2093-2098`):

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

On portrait mobile the browse overlay is already full-width, so `body.browse-open` fully hides the floating trigger and the in-header `#help-trigger-browse` takes over. This is exactly when the dual-trigger design pays off: the help button is never hidden behind the dataset list.

### Panel coordination at portrait breakpoint

Because the help sheet fully covers the map and other panels in Tier 3, mutual-exclusion rules change:

- Opening help on portrait mobile **closes the chat panel** (otherwise chat is invisible but still holding focus, confusing screen readers).
- Opening help on desktop/tablet does **not** close chat — they coexist in opposite corners.
- This branches on `window.matchMedia('(max-width: 600px) and (orientation: portrait)').matches` inside `openHelp()`.

No ResizeObserver coordination is needed (unlike `chatUI.updateTriggerForInfoPanel()`) because the help panel either floats in its own corner or fully overlays everything.

### Summary table

| Breakpoint | Help panel treatment | Trigger state |
|---|---|---|
| `> 768px` | Floating 380px panel, top-right | Floating pill + in-header icon; one visible at a time via `body.browse-open` |
| `≤ 768px` | Panel widens to `calc(100vw - 1.5rem)` | Floating collapses to 48px circle; in-header at 40px for touch |
| `≤ 600px` + portrait | Full-screen sheet (`100dvh`), sticky-footer submit, in-panel close button | Floating at 40px / `0.5rem` inset; in-header is the one actually visible whenever browse is open (which on portrait is full-screen) |

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

1. `refactor(services): extract captureGlobeScreenshot into screenshotService` (moves the helper out of `docentService.ts`, updates tests; no behavior change)
2. `feat(db): add general_feedback D1 table migration`
3. `feat(api): add /api/general-feedback Cloudflare Function`
4. `feat(types): add GeneralFeedbackPayload types`
5. `feat(ui): add help panel with guide and feedback tabs` (biggest commit — new `helpUI.ts`, HTML, CSS, `main.ts` wiring, in-header trigger in `browseUI.ts`, feedback service, screenshot attach)
6. `test(ui): cover help panel toggle, tabs, and form validation`

All commits DCO-signed (`-s`) per `CLAUDE.md`.

---

## 9. Decisions (resolved from initial open questions)

- **Trigger placement** — two triggers, CSS-coordinated: a floating `#help-trigger` in the top-right visible when the browse overlay is closed, plus a small `#help-trigger-browse` icon inside the browse overlay header that takes over when the overlay is open. Both call the same `toggleHelp()` handler.
- **D1 table** — confirmed as a new sibling `general_feedback` table, separate from the AI `feedback` table.
- **Screenshots** — in scope for v1. Reuses the existing `captureGlobeScreenshot()` helper (currently in `docentService.ts:36-56`), extracted into a shared `src/services/screenshotService.ts`. Opt-in checkbox in the feedback form, default off for privacy.
- **GitHub Issues auto-filing** — out of scope. D1 storage is sufficient for now; triage tooling can come later.
- **Guide topics** — tours section added as a first-class item between "Exploring datasets" and "Talking to Orbit".

---

## 10. Still out of scope

- **Multiple screenshots or annotated screenshots** — v1 captures a single untouched screenshot via the existing helper. Cropping, drawing, or multi-image attachment can come later.
- **Uploading arbitrary files** (console logs, crash dumps) — no upload pipeline; sticking with text + optional screenshot only.
- **Guide content as Markdown files** — keeping it as static HTML in `helpUI.ts` is simpler; no Markdown pipeline exists today. Revisit if the guide grows significantly.
- **Analytics on help button usage** — no analytics system exists; won't add one for this feature.
