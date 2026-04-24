# Styles

This directory contains all CSS for the Terraviz application.
The monolithic `<style>` block that previously lived in `index.html`
(~2,700 lines) has been decomposed into modular component files with a
shared design token system.

## How it works

**One entry point**: `index.css` imports every component stylesheet in
dependency order. It's imported once in `src/main.ts`:

```ts
import './styles/index.css'
```

Vite bundles all `@import`'d files into a single CSS output linked via
`<link>` in the HTML `<head>`. Source-level modularity, zero runtime
cost.

## File map

| File | What it styles | ~Lines |
|---|---|---|
| **tokens.css** | Design tokens — CSS custom properties for colors, spacing, radii, glass effects, safe areas | 95 |
| **base.css** | Reset, body, `.hidden` utility, global `button`, `#app`, `#container`, globe overlays, `#map-grid` | 255 |
| **loading.css** | Loading splash screen — globe animation, progress bar, ring spin, status text | 125 |
| **info-panel.css** | Collapsible dataset info drawer — header, title, toggle, body, legend thumbnail/modal | 225 |
| **playback.css** | Transport controls — play/pause/prev/next buttons, time label, home button | 75 |
| **tour.css** | Tour controls bar, text-box overlays, question buttons, `.tour-glass` overlay class, legend float | 215 |
| **browse.css** | Browse overlay — dataset cards, category/subcategory chip bars, search input, sort/count toolbar, grid | 485 |
| **accessibility.css** | Skip link, focus indicators, closed caption overlay, responsive chip bar scrolling | 160 |
| **download.css** | Download button + manager panel (desktop/Tauri only) | 125 |
| **tools-menu.css** | Tools menu bar, popover panel, view toggles, layout picker | 280 |
| **chat.css** | Orbit chat panel — trigger button, messages, action cards, feedback, settings, vision toggle, input | 680 |
| **help.css** | Help panel — modal (desktop), bottom sheet (mobile), tabs, keyboard shortcuts, feedback form | 445 |

## Design tokens

`tokens.css` defines CSS custom properties that every other file
references via `var(--token-name)`. Changing a value here propagates
everywhere — no find-and-replace across thousands of lines.

**Categories:**

- **Accent colors**: `--color-accent`, `--color-accent-hover`, plus 12
  opacity levels (`--accent-o05` through `--accent-o70`)
- **Surfaces**: `--color-surface`, `--color-surface-hover`,
  `--color-surface-border`
- **Text**: `--color-text`, `--color-text-muted`, `--color-text-dim`,
  `--color-text-faint`
- **Semantic**: `--color-success`, `--color-error`, `--color-warning`
- **Glass effect**: `--glass-bg`, `--glass-blur`, `--glass-border`
- **Radii**: `--radius-xs` (3px) through `--radius-pill` (999px)
- **Safe area** (Phase 5): `--safe-top`, `--safe-bottom`, etc. via
  `env(safe-area-inset-*)`
- **Touch targets** (Phase 5): `--touch-min` (44px)

**Example — change brand color:**
```css
/* tokens.css */
--color-accent: #4da6ff;  /* change this one line */
```
Every button, link, focus ring, and accent border updates automatically.

## Responsive breakpoints

Two tiers, consistent across all component files:

| Breakpoint | Targets | Usage |
|---|---|---|
| `max-width: 768px` | Tablet + mobile | Larger touch targets, layout adjustments |
| `max-width: 600px` + `orientation: portrait` | Phone portrait | Full-screen sheets, stacked layouts |

Components own their own responsive overrides inside `@media` queries
in their respective files.

## Adding a new component

1. Create `src/styles/my-component.css`
2. Reference tokens: `background: var(--glass-bg);`
3. Add `@import './my-component.css';` to `index.css`
4. Done — Vite picks it up automatically

## Platform adaptation (Phase 5)

The token system is designed for platform overrides. When mobile-native
adaptations are needed:

```css
/* In tokens.css */
@media (max-width: 600px) and (orientation: portrait) {
  :root {
    --touch-min: 48px;
    --chat-panel-width: 100vw;
  }
}

/* Or via a platform class set by JS */
.mobile-native {
  --touch-min: 48px;
}
```

Components adapt automatically because they reference tokens.

## References

- `docs/CSS_ARCHITECTURE_PLAN.md` — full refactoring rationale and
  execution history
- `docs/STYLE_GUIDE.md` — visual design rules (glass surfaces, color
  palette, spacing conventions)
