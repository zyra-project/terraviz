# CSS Architecture Refactor — Implementation Plan

## Problem

All ~3,000 lines of CSS live in a single `<style>` block in `index.html`.
There are zero external CSS files, zero design tokens (CSS custom
properties), and the tour overlay system builds its styles as string
concatenation in JavaScript (`cssText +=`). Hardcoded color values
(`#4da6ff`, `rgba(255,255,255,0.06)`, etc.) appear 50+ times across the
monolithic block.

This architecture is fragile for the project's current multi-platform
trajectory (web, desktop, iOS, Android):

- **Changing a brand color** requires 50+ manual edits in one 3,000-line file
- **Adding mobile-native adaptations** (safe-area insets, touch targets,
  bottom sheets) means scattering more responsive overrides across JS files
  and the monolithic style block
- **Tour overlays** are the worst offender: 25 `.style.cssText` assignments
  in `tourUI.ts` build CSS as template literal strings, making them
  impossible to inspect in devtools and hard to override per-platform
- **No component isolation** — every style is global, every selector competes
  in one namespace

## Current State

### Where CSS lives today

| Location | Lines | What it styles |
|---|---|---|
| `index.html` `<style>` block | ~2,980 | Everything: chat, browse, playback, tools, info panel, help, download, viewport grid, tour controls, loading screen |
| `src/ui/tourUI.ts` (inline `cssText`) | ~200+ across 25 assignments | Tour overlays, legends, images, videos, popups, questions |
| `src/main.ts` (inline `.style`) | ~19 assignments | Loading screen progress bar |
| `src/ui/playbackController.ts` | ~10 assignments | Button states, dynamic positioning |
| `src/ui/chatUI.ts` | ~7 assignments | Textarea height calculations |
| `src/ui/mapControlsUI.ts` | 2 assignments | Bottom positioning |

### Breakpoints (consistent, which is good)

| Breakpoint | Use case | Count |
|---|---|---|
| `768px` | Desktop ↔ tablet/mobile split | 11 media queries |
| `600px` + portrait | Phone portrait mode | 5 media queries |
| `prefers-reduced-motion` | Accessibility | 2 queries |

### Design palette (hardcoded, which is bad)

| Token | Value | Occurrences |
|---|---|---|
| Primary accent | `#4da6ff` | 42 |
| Surface | `rgba(255,255,255,0.06)` | 30 |
| Surface hover | `rgba(255,255,255,0.12)` | 20 |
| Glass background | `rgba(13,13,18,0.85)` | ~15 |
| Glass blur | `blur(18px)` | ~10 |
| Text primary | `#e8eaf0` | ~10 |
| Text muted | `#888` / `#999` | ~20 |
| Success | `#6dc96d` / `#22c55e` | ~5 |
| Error | `#ef4444` / `#ff6b6b` | ~5 |

## Target Architecture

```
src/styles/
  tokens.css          ← CSS custom properties (colors, spacing, radii, glass effects)
  base.css            ← Reset, body, scrollbar, focus-visible, global typography, #globe-container, canvas, coordinate overlay
  chat.css            ← Chat panel, messages, settings, feedback thumbs
  browse.css          ← Browse overlay, dataset cards, category chips, search
  playback.css        ← Playback controls, transport buttons, range slider
  tour.css            ← Tour controls bar, text-boxes, questions, overlay base classes
  tools-menu.css      ← Tools popover, toggle switches, layout picker
  info-panel.css      ← Dataset info drawer, collapsible sections
  help.css            ← Help modal (desktop) / sheet (mobile)
  download.css        ← Download manager (desktop only)
  loading.css         ← Loading screen, progress bar, splash
```

The individual stylesheet files are aggregated via `src/styles/index.css`,
which is imported once from `src/main.ts`. Vite then bundles everything
into a single CSS output — zero runtime cost, with source-level
modularity preserved through the split files.

## Execution Plan

### Step 1: Design Tokens (`tokens.css`)

Create `src/styles/tokens.css` with CSS custom properties for every
repeated design value. Then do a mechanical find-replace across the
`index.html` `<style>` block to swap hardcoded values for `var(--token)`.

```css
:root {
  /* Colors — accent */
  --color-accent: #4da6ff;
  --color-accent-dim: rgba(77, 166, 255, 0.15);
  --color-accent-ring: rgba(77, 166, 255, 0.5);

  /* Colors — surfaces */
  --color-surface: rgba(255, 255, 255, 0.06);
  --color-surface-hover: rgba(255, 255, 255, 0.12);
  --color-surface-border: rgba(255, 255, 255, 0.1);

  /* Colors — glass effect */
  --glass-bg: rgba(13, 13, 18, 0.85);
  --glass-blur: blur(18px);
  --glass-border: 1px solid rgba(255, 255, 255, 0.08);

  /* Colors — text */
  --color-text: #e8eaf0;
  --color-text-muted: #888;
  --color-text-dim: #666;

  /* Colors — semantic */
  --color-success: #22c55e;
  --color-error: #ef4444;
  --color-warning: #ffcc66;

  /* Spacing */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-xl: 18px;
  --radius-pill: 999px;

  /* Touch targets (Phase 5 — mobile minimum) */
  --touch-min: 44px;

  /* Safe area (Phase 5 — notched devices) */
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --safe-left: env(safe-area-inset-left, 0px);
  --safe-right: env(safe-area-inset-right, 0px);
}
```

**Risk**: Low — mechanical find-replace, no behavioral change.
**Verification**: Visual diff on the preview deployment.

### Step 2: Tour Style Extraction (`tour.css` + `tourUI.ts` refactor)

This is the core of issue #23.

**2a.** Move the ~140 lines of static tour CSS from `index.html` into
`src/styles/tour.css`, replacing hardcoded values with tokens.

**2b.** Extract common inline style patterns from `tourUI.ts` into CSS
classes in `tour.css`:

| Current (JS string) | New (CSS class) |
|---|---|
| `glassStyles()` helper (~19 lines per call) | `.tour-glass` |
| Overlay container positioning | `.tour-overlay` |
| Phone-portrait bottom-sheet layout | `.tour-overlay--phone` |
| Desktop/tablet positioned layout | `.tour-overlay--desktop` |
| Legend float thumbnail | `.tour-legend` |
| Image responsive sizing | `.tour-image` |
| Video responsive sizing | `.tour-video` |
| Caption text | `.tour-caption` |

**2c.** Refactor `tourUI.ts` to use `el.classList.add(...)` for common
styles and reserve `.style.property = value` for truly dynamic values
only (coordinates from tour JSON, runtime color overrides, computed
font sizes).

**Risk**: Medium — need visual verification that tours render identically.
**Verification**: Load a tour on the preview, check every overlay type.

### Step 3: Split Remaining CSS into Component Files

Move sections of the `index.html` `<style>` block into per-component
CSS files, one at a time. Each component's UI module imports its own
CSS file. The `<style>` block in `index.html` shrinks to zero (or near
zero for any truly global rules that don't belong to a component).

Order (by independence — components that don't reference each other):

1. `loading.css` (~80 lines, standalone)
2. `globe.css` (~50 lines, standalone)
3. `viewport.css` (~150 lines, references globe)
4. `info-panel.css` (~200 lines)
5. `browse.css` (~600 lines, largest single component)
6. `playback.css` (~200 lines)
7. `tools-menu.css` (~250 lines)
8. `chat.css` (~500 lines)
9. `help.css` (~400 lines)
10. `download.css` (~150 lines, desktop-only)
11. `base.css` (remainder — scrollbar, focus, typography)

Each extraction is a commit, each commit is visually verifiable.

**Risk**: Low per file — just moving code. Vite handles the import
bundling. The `<style>` block shrinks line by line.

### Step 4: Platform Adaptation Layer (Phase 5 readiness)

With tokens and component files in place, mobile-native adaptations
become clean CSS overrides:

```css
/* In tokens.css — responsive token overrides */
@media (max-width: 768px) {
  :root {
    --panel-radius: var(--radius-lg) var(--radius-lg) 0 0;
  }
}

@media (max-width: 600px) and (orientation: portrait) {
  :root {
    --chat-panel-width: 100vw;
    --browse-card-columns: 1;
  }
}

/* Platform class set by JS when IS_MOBILE_NATIVE is true */
.mobile-native {
  --touch-min: 48px;
  /* Additional mobile-native overrides */
}
```

Components automatically adapt because they reference tokens. A new
platform (e.g., Android tablet in landscape) requires adding a media
query or class override in `tokens.css`, not editing 12 JS files.

**Risk**: Low — additive only, doesn't change existing behavior.

## PR Strategy

| PR | Scope | Commits | Closes |
|---|---|---|---|
| **PR A** | Steps 1 + 2 (tokens + tour extraction) | ~5 commits | Issue #23 |
| **PR B** | Step 3 (component CSS split) | ~11 commits (1 per component) | — |
| **PR C** | Step 4 (platform layer) | ~2 commits | Part of Phase 5 |

PR A is the highest-leverage deliverable — it establishes the design
token system AND resolves issue #23. PRs B and C follow incrementally.

## What This Enables

Once this architecture is in place:

- **Change brand color**: edit one line in `tokens.css`
- **Add safe-area insets for iPhone**: add `padding-bottom: var(--safe-bottom)` to relevant components
- **Add a mobile-native bottom sheet**: create a `.mobile-native .chat-panel` override in `chat.css`
- **Adjust touch targets for tablets**: override `--touch-min` in a media query
- **Debug a tour overlay**: inspect the `.tour-glass` class in devtools instead of a 20-line `cssText` string
- **Add a new component**: create one CSS file, import it, use tokens

## References

- Issue #23: https://github.com/zyra-project/interactive-sphere/issues/23
- `docs/MOBILE_APP_PLAN.md` Phase 5 (mobile UX polish)
- `STYLE_GUIDE.md` (existing visual design rules)
