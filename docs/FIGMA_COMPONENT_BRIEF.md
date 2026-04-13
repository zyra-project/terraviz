# Figma Component Library — Design Brief

This document describes how to build the Figma component library for
Interactive Sphere using the synced design tokens. Every dimension,
color, and radius should reference a **Tokens Studio variable** rather
than a hardcoded value — this keeps the Figma file in sync with the
codebase.

## Prerequisites

- Tokens Studio plugin installed with GitHub sync pointed at
  `zyra-project/interactive-sphere` (branch `main` once merged)
- All token sets pulled and active (global, browse, chat, playback,
  tools-menu)

## How to Apply Tokens

In Figma, select a layer and use Tokens Studio's "Apply to selection"
to bind a property to a token. For example:

- Select a rectangle → apply `color > surface` to its fill
- Select a frame → apply `component > browse > card-padding` to its
  padding
- Select text → apply `component > browse > title-size` to its font
  size

Tokens Studio maps token types to Figma properties automatically:
`color` → fill/stroke, `dimension` → width/height/padding/gap,
`fontWeight` → font weight.

## Shared Foundation

### Glass Surface

Create a **component** called `.glass-surface` as the base for all
panels. Properties:

| Property | Token |
|---|---|
| Fill | `glass > bg-light` (0.88 opacity variant) |
| Stroke | `color > surface-border-subtle` |
| Stroke weight | 1px |
| Corner radius | `radius > lg` (8px — panels) |
| Effects | Background blur: `glass > blur` (12px) |

Variant: `.glass-surface-dark` uses `glass > bg` (0.92 opacity).

### Text Styles

Create text styles that reference tokens:

| Style name | Font size | Weight | Color token |
|---|---|---|---|
| Title | 1.4rem | 300 | `color > text` |
| Heading | 0.8rem | 600 | `color > text` |
| Body | 0.75rem | 400 | `color > text-secondary` |
| Caption | 0.65rem | 400 | `color > text-muted` |
| Label | 0.6rem | 600 | `color > text-dim` |

Font stack: `-apple-system, BlinkMacSystemFont, Segoe UI, Roboto` —
in Figma, use **Inter** or **SF Pro** as the closest match.

### Color Styles

Apply these as Figma color styles linked to tokens:

| Style | Token | Usage |
|---|---|---|
| Accent | `color > accent` | Links, active states |
| Accent Hover | `color > accent-hover` | Hover highlights |
| Accent Dark | `color > accent-dark` | Primary buttons |
| Surface | `color > surface` | Element backgrounds |
| Surface Alt | `color > surface-alt` | Card backgrounds |
| Success | `color > success` | Success states |
| Error | `color > error` | Error states |
| Warning | `color > warning` | Warning states |

---

## Components to Build

For each component, create a **desktop** frame (1440×900 viewport)
showing the default state. Responsive variants are documented but
don't need separate frames initially — the token modes handle the
value changes.

---

### 1. Browse Panel

**Layout:** Fixed right sidebar, full viewport height.

| Property | Token | Value |
|---|---|---|
| Width | `component > browse > panel-width` | 420px |
| Background | `glass > bg-light` | |
| Left border | `color > surface-border-subtle`, 1px | |

**Search bar:**

| Property | Token |
|---|---|
| Font size | `component > browse > search-size` |
| Corner radius | `component > browse > search-radius` |
| Background | `color > surface` |
| Border | `color > surface-border-subtle` |

**Category chips:**

| Property | Token |
|---|---|
| Font size | `component > browse > chip-size` |
| Corner radius | `component > browse > chip-radius` |
| Border | `white-opacity > o15` |
| Background | `white-opacity > o05` |

**Card grid:**

| Property | Token |
|---|---|
| Grid gap | `component > browse > grid-gap` |
| Column min width | `component > browse > grid-col-min` |

**Browse card (component with variants):**

| Property | Token |
|---|---|
| Padding | `component > browse > card-padding` |
| Corner radius | `component > browse > card-radius` |
| Gap (thumb ↔ body) | `component > browse > card-gap` |
| Background | `color > surface-alt` |
| Border | `white-opacity > o08` |

| Variant | State |
|---|---|
| Default | As above |
| Hover | Border → `accent-opacity > o40`, bg → `white-opacity > o08` |
| Expanded | Border → `accent-opacity > o50`, full-width, details visible |

**Thumbnail (nested component):**

| Property | Token (default) | Token (expanded) |
|---|---|---|
| Size | `component > browse > thumb-size` (64px) | `component > browse > thumb-size-expanded` (96px) |
| Corner radius | `component > browse > thumb-radius` | |

**Card text:**

| Element | Font size token | Weight token |
|---|---|---|
| Title | `component > browse > title-size` | `component > browse > title-weight` |
| Description | `component > browse > desc-size` | — (400) |
| Keywords | `component > browse > keyword-size` | — (400) |

**Keyword tag:**

| Property | Token |
|---|---|
| Font size | `component > browse > keyword-size` |
| Corner radius | `component > browse > keyword-radius` |
| Background | `accent-opacity > o12` |
| Text color | `color > accent-hover` |

**Docent button (in search bar):**

| Property | Token |
|---|---|
| Size (w × h) | `component > browse > chat-btn-size` |
| Corner radius | 50% (circle) |
| Background | `glass > bg` |

---

### 2. Chat Panel

**Layout:** Floating panel, bottom-left.

| Property | Token |
|---|---|
| Width | `component > chat > panel-width` |
| Max height | `component > chat > panel-max-height` |
| Corner radius | `component > chat > panel-radius` |
| Background | `glass > bg` |
| Border | `white-opacity > o08` |
| Shadow | `0 8px 32px rgba(0, 0, 0, 0.4)` |

**Chat trigger button:**

| Property | Token |
|---|---|
| Height | `component > chat > trigger-height` |
| Width (collapsed) | `component > chat > trigger-width-collapsed` |
| Corner radius | `radius > pill` (expanded), 50% (collapsed) |
| Background | `glass > bg` |
| Border | `white-opacity > o12` |

**Message bubble (component with variants: user / docent):**

| Property | Token |
|---|---|
| Font size | `component > chat > msg-font-size` |
| Line height | `component > chat > msg-line-height` |
| Corner radius | `component > chat > msg-radius` |
| Max width | `component > chat > msg-max-width` |

| Variant | Background | Border |
|---|---|---|
| User | `accent-opacity > o18` | `accent-opacity > o30` |
| Docent | `color > surface` | `white-opacity > o08` |

**Chat input area:**

| Property | Token |
|---|---|
| Font size | `component > chat > input-font-size` |
| Corner radius | `component > chat > input-radius` |
| Min height | `component > chat > input-min-height` |
| Max height | `component > chat > input-max-height` |

**Send button:**

| Property | Token |
|---|---|
| Min size (w & h) | `component > chat > send-btn-min-size` |
| Corner radius | `component > chat > send-btn-radius` |
| Background | `color > accent-dark` |

**Header:**

| Property | Token |
|---|---|
| Title font size | `component > chat > header-title-size` |
| Title weight | `component > chat > header-title-weight` |

**Suggestion chips:**

| Property | Token |
|---|---|
| Font size | `component > chat > suggestion-size` |
| Corner radius | `component > chat > suggestion-radius` |
| Background | `accent-opacity > o12` |
| Border | `accent-opacity > o25` |

**Action card (dataset suggestion):**

| Property | Token |
|---|---|
| Title font size | `component > chat > action-title-size` |
| Title weight | `component > chat > action-title-weight` |
| Corner radius | `component > chat > action-btn-radius` |
| Background | `color > surface-alt` |
| Border | `white-opacity > o08` |

---

### 3. Playback Controls

**Layout:** Bottom-right, inline flex row of transport buttons with
a scrubber (range input) below.

**Transport button (component with variants: default / hover / active):**

| Property | Token |
|---|---|
| Min width | `component > playback > transport-btn-min-width` |
| Font size | `component > playback > transport-btn-font-size` |
| Background | `color > surface` |
| Border | `white-opacity > o10` |
| Corner radius | `radius > md` |

| Variant | Border color | Text color |
|---|---|---|
| Default | `white-opacity > o10` | `#ccc` |
| Hover | `accent-opacity > o40` | `color > text` |
| Active | `color > accent` | `color > accent` |

**Home button:**

| Property | Token |
|---|---|
| Min width | `component > playback > home-btn-min-width` |
| Min height | `component > playback > home-btn-min-height` |
| Font size | `component > playback > home-btn-font-size` |
| Content | `⌂` glyph |

**Time label:**

| Property | Token |
|---|---|
| Font size | `component > playback > time-label-font-size` |
| Font weight | `component > playback > time-label-font-weight` |
| Corner radius | `component > playback > time-label-radius` |
| Background | `glass > bg-light` |

**Scrubber:**

| Property | Token |
|---|---|
| Height | `component > playback > range-height` |

---

### 4. Tools Menu

**Layout:** Bottom-right, two pill buttons ("Browse" + gear icon)
with a popover panel that opens above.

**Menu button (component with variants: default / hover / expanded):**

| Property | Token |
|---|---|
| Min height | `component > tools-menu > btn-min-height` |
| Font size | `component > tools-menu > btn-font-size` |
| Corner radius | `component > tools-menu > btn-radius` |
| Background | `glass > bg-light` |
| Border | `white-opacity > o12` |

**Gear toggle button:**

| Property | Token |
|---|---|
| Min width | `component > tools-menu > toggle-min-width` |
| (inherits other properties from menu button) | |

**Popover panel:**

| Property | Token |
|---|---|
| Min width | `component > tools-menu > popover-min-width` |
| Corner radius | `component > tools-menu > popover-radius` |
| Background | near-black 94% opacity |
| Border | `white-opacity > o12` |
| Shadow | `0 6px 32px rgba(0, 0, 0, 0.45)` |

**Menu item (component with variants: default / hover / active):**

| Property | Token |
|---|---|
| Font size | `component > tools-menu > item-font-size` |
| Corner radius | `component > tools-menu > item-radius` |

| Variant | Background | Text color |
|---|---|---|
| Default | transparent | `#ddd` |
| Hover | `color > surface` | `color > text` |
| Active | `accent-opacity > o08` | `color > accent` |

**Section title:**

| Property | Token |
|---|---|
| Font size | `component > tools-menu > section-title-size` |
| Font weight | `component > tools-menu > section-title-weight` |
| Text transform | uppercase |
| Letter spacing | 0.08em |

**Layout picker button (component with variants: default / hover / active):**

| Property | Token |
|---|---|
| Min height | `component > tools-menu > layout-btn-min-height` |
| Font size | `component > tools-menu > layout-btn-font-size` |
| Corner radius | `component > tools-menu > layout-btn-radius` |
| Background (default) | `color > surface-alt` |

---

## Responsive Variants (Optional)

If you want to show responsive states, create additional frames:

| Frame | Viewport | Notes |
|---|---|---|
| Desktop | 1440 × 900 | Default token values |
| Tablet | 768 × 1024 | Tablet mode values (larger touch targets, wider popovers) |
| Phone Portrait | 375 × 812 | Browse becomes bottom sheet, chat full-width |

The token values change automatically per mode in the build pipeline.
In Figma, you'd manually set the tablet/phone values on these frames
since Tokens Studio free tier doesn't support mode switching in the UI.

## Tips

- **Use auto-layout** for all components — it maps most closely to
  CSS flexbox which the app uses
- **Name layers** to match CSS class names (e.g., `.browse-card`,
  `.chat-msg-text`) — this helps when Code Connect is added later
- **Don't hardcode values** — if a dimension exists as a token, use
  "Apply to selection" in Tokens Studio rather than typing the number
- **Glass blur effect** — Figma's "Background blur" layer effect is
  the equivalent of CSS `backdrop-filter: blur()`
- **Opacity on fills, not layers** — the glass surface uses rgba
  colors with built-in opacity, not a layer opacity. Set the fill
  color to the token value (which includes opacity) and keep layer
  opacity at 100%
