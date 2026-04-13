# SOS Explorer — UI Style Guide

This documents the visual design language used across all UI components. All overlay elements share a consistent frosted-glass aesthetic that lets the globe remain the visual focus.

## Design Principles

1. **Globe first** — UI elements are translucent overlays, never opaque. The globe should always be partially visible through panels.
2. **Minimal chrome** — Subtle borders and muted colors. Interactive elements highlight on hover/active, not at rest.
3. **Consistent surfaces** — Every floating UI element uses the same glass material (background + blur + border).

## Glass Surface (Foundation)

Every panel, button group, label, and overlay uses this base treatment:

<!-- tokens:auto:glass -->
```css
background: rgba(13, 13, 18, 0.92);
backdrop-filter: blur(12px);
-webkit-backdrop-filter: blur(12px);
border: 1px solid rgba(255, 255, 255, 0.08); /* --color-surface-border-subtle */
border-radius: 6px;               /* --radius-md; 8px (--radius-lg) for larger panels */
```
<!-- /tokens:auto:glass -->

- **Background**: near-black with 88–92% opacity — dark enough for legibility, transparent enough to show the globe
- **Blur**: backdrop blur creates the frosted-glass depth
- **Border**: very subtle white at 8% opacity — just enough to define edges without drawing attention
- **Radius**: 6px for small elements (buttons, labels), 8px for panels (info, playback, browse)

## Color Palette

> Source of truth: `tokens/global.json`

<!-- tokens:auto:colors -->
| Token | Value | Usage |
|---|---|---|
| `--color-accent` | `#4da6ff` | Primary accent — links, active states, focus rings |
| `--color-accent-hover` | `#6ab8ff` | Accent hover state |
| `--color-accent-dark` | `#0066cc` | Primary action buttons |
| `--color-accent-darker` | `#0052a3` | Primary button hover |
| `--color-bg` | `#0d0d12` | Page background |
| `--color-surface` | `rgba(255, 255, 255, 0.06)` | Panel/element backgrounds |
| `--color-surface-alt` | `rgba(255, 255, 255, 0.04)` | Alternate surface (cards) |
| `--color-surface-hover` | `rgba(255, 255, 255, 0.12)` | Surface hover state |
| `--color-surface-active` | `rgba(255, 255, 255, 0.15)` | Surface active/pressed state |
| `--color-surface-border` | `rgba(255, 255, 255, 0.1)` | Default surface borders |
| `--color-surface-border-subtle` | `rgba(255, 255, 255, 0.08)` | Subtle borders — glass panels |
| `--color-text` | `#e8eaf0` | Primary text — titles, headings |
| `--color-text-secondary` | `#bbb` | Body text, labels |
| `--color-text-muted` | `#999` | Metadata, timestamps (min 4.5:1 contrast) |
| `--color-text-dim` | `#888` | Counts, status text (min 4.5:1 contrast) |
| `--color-text-faint` | `#666` | Decorative/disabled text |
| `--color-success` | `#22c55e` | Success state |
| `--color-success-soft` | `#6dc96d` | Success state — softer variant |
| `--color-error` | `#ef4444` | Error state |
| `--color-error-soft` | `#ff6b6b` | Error state — softer variant |
| `--color-warning` | `#ffcc66` | Warning state |
| `--glass-bg` | `rgba(13, 13, 18, 0.92)` | Glass panel background — dark |
| `--glass-bg-light` | `rgba(13, 13, 18, 0.88)` | Glass panel background — lighter variant |
| `--glass-blur` | `12px` | Backdrop blur radius for frosted-glass effect |
<!-- /tokens:auto:colors -->

## Typography

- **Font stack**: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif`
- **Titles**: `font-weight: 300`, `letter-spacing: 0.15em`, `text-transform: uppercase`, color `#e8eaf0`
- **Body text**: `0.7rem–0.8rem`, color `#bbb`–`#ddd`
- **Metadata labels**: `0.65rem`, color `#888`, bold label in `#aaa`
- **Tabular data** (lat/lng, time): `font-variant-numeric: tabular-nums`, `letter-spacing: 0.03em`

## Interactive Buttons

### Transport buttons (playback, rotate, mute)

```css
min-width: 28px;
padding: 0.3rem 0.4rem;
font-size: 0.7rem;
background: rgba(255, 255, 255, 0.06);
border: 1px solid rgba(255, 255, 255, 0.1);
color: #ccc;
border-radius: 6px;
```

**Hover state:**
```css
background: rgba(255, 255, 255, 0.12);
color: #fff;
border-color: rgba(77, 166, 255, 0.4);
```

**Active/toggled state:**
```css
color: #4da6ff;
border-color: #4da6ff;
```

### Primary action buttons (Load Dataset)

```css
background: #0066cc;
color: white;
border-radius: 6px;
```

### Tags / Keywords

```css
background: rgba(77, 166, 255, 0.12);
color: #6ab8ff;
padding: 0.12rem 0.35rem;
border-radius: 3px;
font-size: 0.58rem–0.6rem;
```

## Component Catalog

> Source of truth: `tokens/components/*.json`. The tables below are
> auto-generated from the token JSON files.

<!-- tokens:auto:components -->
### Browse

| Token | Default | Tablet (≤768px) | Phone Portrait |
|---|---|---|---|
| `--component-browse-panel-width` | `420px` | `—` | `100%` |
| `--component-browse-panel-max-height` | `none` | `—` | `70vh` |
| `--component-browse-card-padding` | `0.875rem` | `—` | `—` |
| `--component-browse-card-radius` | `8px` | `—` | `—` |
| `--component-browse-card-gap` | `0.75rem` | `—` | `—` |
| `--component-browse-thumb-size` | `64px` | `—` | `—` |
| `--component-browse-thumb-size-expanded` | `96px` | `—` | `—` |
| `--component-browse-thumb-radius` | `4px` | `—` | `—` |
| `--component-browse-grid-col-min` | `260px` | `—` | `—` |
| `--component-browse-grid-gap` | `0.75rem` | `—` | `—` |
| `--component-browse-title-size` | `0.8rem` | `—` | `—` |
| `--component-browse-title-weight` | `600` | `—` | `—` |
| `--component-browse-desc-size` | `0.7rem` | `—` | `—` |
| `--component-browse-keyword-size` | `0.58rem` | `—` | `—` |
| `--component-browse-keyword-radius` | `3px` | `—` | `—` |
| `--component-browse-chip-size` | `0.7rem` | `—` | `—` |
| `--component-browse-chip-radius` | `999px` | `—` | `—` |
| `--component-browse-search-size` | `0.875rem` | `—` | `—` |
| `--component-browse-search-radius` | `6px` | `—` | `—` |
| `--component-browse-chat-btn-size` | `36px` | `40px` | `—` |

### Chat

| Token | Default | Tablet (≤768px) | Phone Portrait |
|---|---|---|---|
| `--component-chat-panel-width` | `380px` | `calc(100vw - 1.5rem)` | `100%` |
| `--component-chat-panel-max-height` | `calc(100vh - 8rem)` | `60vh` | `75vh` |
| `--component-chat-panel-radius` | `10px` | `—` | `—` |
| `--component-chat-trigger-height` | `44px` | `48px` | `—` |
| `--component-chat-trigger-width-collapsed` | `44px` | `48px` | `—` |
| `--component-chat-msg-font-size` | `0.73rem` | `—` | `—` |
| `--component-chat-msg-line-height` | `1.55` | `—` | `—` |
| `--component-chat-msg-radius` | `8px` | `—` | `—` |
| `--component-chat-msg-max-width` | `88%` | `—` | `—` |
| `--component-chat-input-font-size` | `0.78rem` | `—` | `—` |
| `--component-chat-input-radius` | `6px` | `—` | `—` |
| `--component-chat-input-min-height` | `1.8rem` | `—` | `—` |
| `--component-chat-input-max-height` | `6rem` | `—` | `—` |
| `--component-chat-send-btn-min-size` | `34px` | `44px` | `—` |
| `--component-chat-send-btn-radius` | `6px` | `—` | `—` |
| `--component-chat-header-title-size` | `0.75rem` | `—` | `—` |
| `--component-chat-header-title-weight` | `600` | `—` | `—` |
| `--component-chat-suggestion-size` | `0.65rem` | `—` | `—` |
| `--component-chat-suggestion-radius` | `999px` | `—` | `—` |
| `--component-chat-action-title-size` | `0.68rem` | `—` | `—` |
| `--component-chat-action-title-weight` | `600` | `—` | `—` |
| `--component-chat-action-btn-radius` | `6px` | `—` | `—` |

### Playback

| Token | Default | Tablet (≤768px) |
|---|---|---|
| `--component-playback-transport-btn-min-width` | `28px` | `40px` |
| `--component-playback-transport-btn-font-size` | `0.7rem` | `1rem` |
| `--component-playback-home-btn-min-width` | `36px` | `44px` |
| `--component-playback-home-btn-min-height` | `36px` | `44px` |
| `--component-playback-home-btn-font-size` | `0.85rem` | `1rem` |
| `--component-playback-time-label-font-size` | `0.8rem` | `—` |
| `--component-playback-time-label-font-weight` | `500` | `—` |
| `--component-playback-time-label-radius` | `6px` | `—` |
| `--component-playback-range-height` | `20px` | `28px` |

### Tools Menu

| Token | Default | Tablet (≤768px) |
|---|---|---|
| `--component-tools-menu-btn-min-height` | `34px` | `38px` |
| `--component-tools-menu-btn-font-size` | `0.72rem` | `0.78rem` |
| `--component-tools-menu-btn-radius` | `999px` | `—` |
| `--component-tools-menu-toggle-min-width` | `34px` | `38px` |
| `--component-tools-menu-popover-min-width` | `240px` | `260px` |
| `--component-tools-menu-popover-radius` | `10px` | `—` |
| `--component-tools-menu-item-font-size` | `0.75rem` | `0.82rem` |
| `--component-tools-menu-item-radius` | `6px` | `—` |
| `--component-tools-menu-layout-btn-min-height` | `30px` | `36px` |
| `--component-tools-menu-layout-btn-font-size` | `0.7rem` | `0.78rem` |
| `--component-tools-menu-layout-btn-radius` | `5px` | `—` |
| `--component-tools-menu-section-title-size` | `0.6rem` | `—` |
| `--component-tools-menu-section-title-weight` | `600` | `—` |
<!-- /tokens:auto:components -->

### Info Panel (bottom-left)
- Collapsible drawer with click-to-expand header
- Max-width: `340px`
- Expanded body: `max-height: 60vh` with overflow scroll

### Lat/Lng Display (top-left, next to home button)
- Glass surface, tabular-nums, no pointer events

## Border Radii

> Source of truth: `tokens/global.json`

<!-- tokens:auto:radii -->
| Token | Default | Mobile Native |
|---|---|---|
| `--radius-xs` | `3px` | `—` |
| `--radius-sm` | `4px` | `—` |
| `--radius-md` | `6px` | `—` |
| `--radius-lg` | `8px` | `10px` |
| `--radius-xl` | `10px` | `14px` |
| `--radius-2xl` | `12px` | `—` |
| `--radius-pill` | `999px` | `—` |
<!-- /tokens:auto:radii -->

## Spacing

- Consistent `0.75rem` edge margin from viewport edges
- `0.4rem–0.5rem` internal padding on panels
- `0.2rem` gap between transport buttons, `0.25rem` before utility buttons (mute, rotate)

## Mobile Adaptations (≤768px)

Responsive overrides are managed via token modes. See the tablet
column in the component tables above for exact values.

- Browse panel: full-width bottom sheet on phone portrait
- Transport buttons grow for touch targets
- Home button grows for touch targets
- Tools menu buttons and popover scale up

## Animations

- Panel transitions: `transform 0.3s ease`
- Hover transitions: `background 0.15s`, `color 0.15s`, `border-color 0.15s`
- Drawer expand: `max-height 0.3s ease`
- Loading screen fade: `opacity 0.8s ease`

## Accessibility (Section 508 / WCAG 2.1 AA)

### Color Contrast
- All text must meet WCAG 2.1 AA contrast ratios: **4.5:1** for normal text, **3:1** for large text (18px+ or 14px bold)
- Minimum muted text color on dark panels (`~#161619`): `#999` (~4.6:1 ratio)
- Never use `#555`, `#666`, or `#777` for text — these fail AA contrast on dark backgrounds

### Focus Indicators
Focus indicators use the accent blue in a glow style that matches the frosted-glass design:

```css
:focus-visible {
  outline: 2px solid rgba(77, 166, 255, 0.7);
  outline-offset: 2px;
  box-shadow: 0 0 8px rgba(77, 166, 255, 0.4);
}
```

- Browse cards use border highlight instead of outline (since they already have visible borders)
- Never add `outline: none` to interactive elements without providing an alternative focus style

### ARIA Patterns
- All emoji-only buttons must have `aria-label` (screen readers cannot interpret emoji)
- Dynamic state changes (play/pause, mute/unmute, panel open/close) must update `aria-label`
- Use `aria-expanded` on collapsible headers and toggle buttons
- Use `aria-pressed` on toggle filter chips
- Use `role="alert"` for error messages, `aria-live="polite"` for status updates
- Use a hidden announcer (`#a11y-announcer`) for transient status — never put `aria-live` on rapidly updating elements (e.g., time display at 60fps)
