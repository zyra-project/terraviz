# SOS Explorer — UI Style Guide

This documents the visual design language used across all UI components. All overlay elements share a consistent frosted-glass aesthetic that lets the globe remain the visual focus.

## Design Principles

1. **Globe first** — UI elements are translucent overlays, never opaque. The globe should always be partially visible through panels.
2. **Minimal chrome** — Subtle borders and muted colors. Interactive elements highlight on hover/active, not at rest.
3. **Consistent surfaces** — Every floating UI element uses the same glass material (background + blur + border).

## Glass Surface (Foundation)

Every panel, button group, label, and overlay uses this base treatment:

```css
background: rgba(13, 13, 18, 0.88);
backdrop-filter: blur(12px);
-webkit-backdrop-filter: blur(12px);
border: 1px solid rgba(255, 255, 255, 0.08);
border-radius: 6px;               /* 8px for larger panels */
```

- **Background**: near-black with 88% opacity — dark enough for legibility, transparent enough to show the globe
- **Blur**: 12px backdrop blur creates the frosted-glass depth
- **Border**: very subtle white at 8% opacity — just enough to define edges without drawing attention
- **Radius**: 6px for small elements (buttons, labels), 8px for panels (info, playback, browse)

## Color Palette

| Token             | Value                          | Usage                              |
|--------------------|--------------------------------|------------------------------------|
| `--surface`        | `rgba(13, 13, 18, 0.88)`      | Panel/element backgrounds          |
| `--border`         | `rgba(255, 255, 255, 0.08)`   | Default borders                    |
| `--border-hover`   | `rgba(77, 166, 255, 0.4)`     | Hover/active borders               |
| `--text-primary`   | `#e8eaf0`                     | Titles, headings                   |
| `--text-secondary` | `#bbb` / `#ccc`               | Body text, labels                  |
| `--text-muted`     | `#888` / `#aaa`               | Metadata, timestamps               |
| `--text-dim`       | `#555`                         | Counts, status text                |
| `--accent`         | `#4da6ff`                      | Active states, links, highlights   |
| `--accent-bg`      | `rgba(77, 166, 255, 0.12)`    | Keyword/tag backgrounds            |
| `--accent-text`    | `#6ab8ff`                      | Keyword/tag text                   |
| `--btn-primary`    | `#0066cc`                      | Primary action buttons (Load)      |
| `--btn-hover`      | `#0052a3`                      | Primary button hover               |

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

### Browse Panel (right sidebar)
- Width: `420px` on desktop, `100%` on mobile
- Collapsible via toggle tab on left edge
- `.collapsed` state: `transform: translateX(100%)`
- Inner content uses `overflow: hidden` (not the panel itself, to allow toggle tab overflow)

### Info Panel (bottom-left)
- Collapsible drawer with click-to-expand header
- Max-width: `340px`
- Expanded body: `max-height: 60vh` with overflow scroll

### Playback Controls (bottom-right)
- `ui-panel` class for glass surface
- Inline flex layout, transport buttons in a row
- Scrubber (range input) below buttons

### Time Label (top-right)
- Glass surface, `0.8rem` font, `font-weight: 500`

### Lat/Lng Display (top-left, next to home button)
- Glass surface, tabular-nums, no pointer events

### Home Button (top-left corner)
- Glass surface with house glyph (`⌂`)
- `min-width: 36px`, `min-height: 36px`

## Cards (Browse Grid)

```css
/* Base card */
background: rgba(255, 255, 255, 0.04);
border: 1px solid rgba(255, 255, 255, 0.08);
border-radius: 8px;
display: flex;                    /* thumbnail left, body right */
gap: 0.75rem;

/* Hover */
background: rgba(255, 255, 255, 0.08);
border-color: rgba(77, 166, 255, 0.4);
transform: translateY(-1px);

/* Expanded */
border-color: rgba(77, 166, 255, 0.5);
grid-column: 1 / -1;             /* span full width */
```

- **Thumbnail**: `64×64` collapsed, `96×96` expanded, `border-radius: 4px`, `object-fit: cover`
- **Title**: `0.8rem`, `font-weight: 600`, 2-line clamp (unclamp when expanded)
- **Categories**: inline tags, `0.6rem`, `rgba(255,255,255,0.06)` bg
- **Description**: `0.7rem`, 2-line clamp collapsed, full text expanded

## Spacing

- Consistent `0.75rem` edge margin from viewport edges
- `0.4rem–0.5rem` internal padding on panels
- `0.2rem` gap between transport buttons, `0.25rem` before utility buttons (mute, rotate)

## Mobile Adaptations (≤768px)

- Browse panel: full-width, no left border
- Transport buttons: `min-width: 40px`, `min-height: 40px`, `font-size: 1rem`
- Home button: `min-width: 44px`, `min-height: 44px`
- Browse grid: `minmax(150px, 1fr)` columns

## Animations

- Panel transitions: `transform 0.3s ease`
- Hover transitions: `background 0.15s`, `color 0.15s`, `border-color 0.15s`
- Drawer expand: `max-height 0.3s ease`
- Loading screen fade: `opacity 0.8s ease`
