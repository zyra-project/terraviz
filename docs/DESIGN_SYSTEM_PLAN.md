# Design System — Implementation Plan

Establish a two-way sync pipeline between the CSS design system and
the design tool across two layers:

1. **Global tokens** — colors, radii, glass effects, touch targets
2. **Component tokens** — per-component dimensions, typography, spacing
   with responsive/platform overrides

## Architecture

```
tokens/
  ├── global.json         ← global design tokens (colors, radii, glass)
  ├── components/
  │   ├── browse.json     ← browse panel component tokens
  │   ├── chat.json       ← chat panel component tokens
  │   ├── playback.json   ← playback controls component tokens
  │   └── tools-menu.json ← tools menu component tokens
  └── style-dictionary.config.mjs

          │                                    ▲
          ▼                                    │
  Style Dictionary build                  Penpot
  (npm run tokens)                  (native JSON import/export)
          │                                    │
          ▼                                    │
  src/styles/tokens.css  ◄─── generated ───►  Penpot Tokens
  (gitignored build artifact;                & Components
   global + component custom properties)
```

**Round-trip flow:**

- **Designer edits in Penpot** → exports the updated tokens JSON →
  commits the diff to `tokens/*.json` → CI (or local `npm run tokens`)
  regenerates `tokens.css`
- **Developer edits token JSON** → runs `npm run tokens` to regenerate
  CSS → designer imports the updated JSON into Penpot on next sync

**Gitignore strategy:** `tokens.css` is a generated build artifact and
is gitignored. A `postinstall` hook runs `npm run tokens` automatically
after `npm install`, so contributors never encounter a missing file:

```json
"postinstall": "npm run tokens"
```

## Scope

### Layer 1: Global tokens (sync'd via global.json)

| Category | Examples | Token type |
|---|---|---|
| Accent colors | `--color-accent`, `--color-accent-hover` | `color` |
| Surface colors | `--color-surface`, `--glass-bg` | `color` |
| Text colors | `--color-text`, `--color-text-muted` | `color` |
| Semantic colors | `--color-success`, `--color-error`, `--color-warning` | `color` |
| Opacity scales | `--accent-o05`…`--accent-o70`, `--white-o05`…`--white-o70` | `color` |
| Glass effect | `--glass-bg`, `--glass-bg-light`, `--glass-blur` | `color` / `dimension` |
| Border radii | `--radius-xs` through `--radius-pill` | `dimension` |
| Touch targets | `--touch-min` | `dimension` |
| Safe area insets | `--safe-top`, `--safe-bottom`, etc. | `dimension` |
| Spacing scale | `--space-xs` through `--space-3xl` | `dimension` |
| Platform overrides | `.mobile-native` token values | Modes |

### Layer 2: Component tokens (sync'd via components/*.json)

Design values that are specific to a component and vary across
responsive breakpoints or platform modes. Components are tiered by
how likely they are to benefit from design iteration:

**Tier 1 — tokenize now** (active design surface, responsive overrides):

| Component | Key synced values | Modes |
|---|---|---|
| **Browse panel** | width (420px / 100%), card thumbnail size (64px / 96px), grid column min (260px), card padding, chip sizes | desktop, phone-portrait |
| **Chat panel** | width (380px / 100vw / 100%), max-height (calc / 60vh / 75vh), trigger height (44px / 48px), message font-size, input min-height | desktop, tablet, phone-portrait |
| **Playback** | transport-btn min-width (28px / 40px), font-size (0.7rem / 1rem), home-btn min size (36px / 44px) | desktop, tablet |
| **Tools menu** | btn min-height (34px / 38px), popover min-width (240px / 260px), item padding/font-size | desktop, tablet |

**Tier 2 — tokenize later** (moderate complexity, some overrides):

| Component | Key synced values | Modes |
|---|---|---|
| **Info panel** | max-width (340px / 100vw-1.5rem), expanded max-height (60vh / 40vh), body padding | desktop, tablet |
| **Help panel** | width (640px / 100vw-1.5rem / 100vw), max-height (80vh / 70vh / 100dvh), trigger size (36px / 48px / 40px) | desktop, tablet, phone-portrait |

**Tier 3 — skip** (stable, rarely redesigned, few/no overrides):

- Loading screen, download manager, tour overlay — values stay
  hardcoded. Can be promoted to tokens in future iterations if needed.

### Out of scope (stays in CSS / code only)

- Layout logic (grid templates, flex direction, position)
- Animation / transition definitions (`transform 0.3s ease`, keyframes)
- JS-driven state classes (`.collapsed`, `.is-primary`, `.out-of-range`)
- `@media` block structure (breakpoint *values* are tokens; the rules
  and any structural overrides stay in CSS)
- Structural CSS (display, overflow, z-index, pointer-events)
- `accessibility.css` (responsive overrides are structural, not design values)
- Spacing scale activation (`--space-*` tokens are commented out in the
  current `tokens.css` — activating them is a separate migration)

## Platform Modes

Token files use **modes** to represent platform variants. Style
Dictionary generates the appropriate CSS selectors for each mode.

### Global modes (global.json)

| Mode | CSS Output | Trigger |
|---|---|---|
| `default` | `:root { ... }` | Base — desktop browser |
| `mobile-native` | `.mobile-native { ... }` | Tauri mobile sets class on `<body>` |

### Component modes (components/*.json)

Component tokens can define up to four modes. Not every component
uses every mode — only declare modes where values actually differ.

| Mode | CSS Output | Trigger |
|---|---|---|
| `default` | `:root { ... }` | Desktop (>768px) |
| `tablet` | `@media (max-width: 768px) { :root { ... } }` | Tablet + mobile |
| `phone-portrait` | `@media (max-width: 600px) and (orientation: portrait) { :root { ... } }` | Phone portrait |
| `mobile-native` | `.mobile-native { ... }` | Tauri mobile native app |

Style Dictionary maps each mode to its CSS output. Component CSS
files then reference the custom properties — they adapt automatically
when the mode activates. This replaces scattered hardcoded overrides
inside `@media` blocks with token references.

## Implementation Phases

### Phase 1a: Global token extraction (global.json)

Convert the existing `tokens.css` custom properties into a W3C Design
Tokens JSON file.

**File:** `tokens/global.json`

**Structure:**

```jsonc
{
  "color": {
    "accent": {
      "$value": "#4da6ff",
      "$type": "color",
      "$description": "Primary accent — links, active states, focus rings"
    },
    "accent-hover": { "$value": "#6ab8ff", "$type": "color" },
    "accent-dark": { "$value": "#0066cc", "$type": "color" },
    "accent-darker": { "$value": "#0052a3", "$type": "color" },
    "bg": { "$value": "#0d0d12", "$type": "color" },
    "surface": { "$value": "rgba(255, 255, 255, 0.06)", "$type": "color" }
    // ... all color tokens
  },
  "radius": {
    "xs": { "$value": "3px", "$type": "dimension" },
    "sm": { "$value": "4px", "$type": "dimension" },
    "md": { "$value": "6px", "$type": "dimension" },
    "lg": {
      "$value": "8px",
      "$type": "dimension",
      "$extensions": {
        "com.tokens-studio.modes": {
          "default": "8px",
          "mobile-native": "10px"
        }
      }
    }
    // ...
  },
  "space": {
    "xs":  { "$value": "4px",  "$type": "dimension" },
    "sm":  { "$value": "8px",  "$type": "dimension" },
    "md":  { "$value": "12px", "$type": "dimension" },
    "lg":  { "$value": "16px", "$type": "dimension" },
    "xl":  { "$value": "20px", "$type": "dimension" },
    "2xl": { "$value": "24px", "$type": "dimension" },
    "3xl": { "$value": "32px", "$type": "dimension" }
  },
  "touch": {
    "min": {
      "$value": "44px",
      "$type": "dimension",
      "$extensions": {
        "com.tokens-studio.modes": {
          "default": "44px",
          "mobile-native": "48px"
        }
      }
    }
  },
  "glass": {
    "bg":       { "$value": "rgba(13, 13, 18, 0.92)", "$type": "color" },
    "bg-light": { "$value": "rgba(13, 13, 18, 0.88)", "$type": "color" },
    "blur":     { "$value": "12px", "$type": "dimension" }
  }
}
```

**Tasks:**
- [ ] Create `tokens/` directory at project root
- [ ] Write `tokens/global.json` covering all custom properties from `tokens.css`
- [ ] Include mode extensions for `.mobile-native` overrides
- [ ] Validate JSON against W3C Design Tokens Community Group spec
- [ ] Create `tokens/README.md` — contributor guide explaining the
      workflow (`npm run tokens`, how to add/edit tokens, design tool
      setup link)

### Phase 1b: Component token extraction (components/*.json)

Extract hardcoded design values from the Tier 1 component CSS files
into per-component token files. Only values that a designer would
reasonably adjust belong here — not structural CSS.

**Criteria for inclusion:** A value is a component token if it:
- Defines a visual dimension a designer iterates on (width, padding,
  font-size, border-radius, thumbnail size)
- Has a responsive or platform override (different at 768px, 600px
  portrait, or `.mobile-native`)
- Is referenced in STYLE_GUIDE.md as a documented design decision
- Is a **single-value** property (`dimension`, `color`, `fontWeight`).
  Shorthand values like `padding: 0.12rem 0.35rem` should be split
  into separate x/y tokens or omitted — the W3C `dimension` type
  expects a single number+unit.

**File:** `tokens/components/browse.json` (example)

```jsonc
{
  "component": {
    "browse": {
      "panel-width": {
        "$value": "420px",
        "$type": "dimension",
        "$extensions": {
          "com.tokens-studio.modes": {
            "default": "420px",
            "phone-portrait": "100%"
          }
        }
      },
      "card-padding":   { "$value": "0.875rem", "$type": "dimension" },
      "card-radius":    { "$value": "{radius.lg}", "$type": "dimension" },
      "card-gap":       { "$value": "0.75rem", "$type": "dimension" },
      "thumb-size": {
        "$value": "64px",
        "$type": "dimension",
        "$description": "Collapsed thumbnail; expanded is thumb-size-expanded"
      },
      "thumb-size-expanded": { "$value": "96px", "$type": "dimension" },
      "thumb-radius":   { "$value": "{radius.sm}", "$type": "dimension" },
      "grid-col-min":   { "$value": "260px", "$type": "dimension" },
      "grid-gap":       { "$value": "0.75rem", "$type": "dimension" },
      "title-size":     { "$value": "0.8rem", "$type": "dimension" },
      "title-weight":   { "$value": "600", "$type": "fontWeight" },
      "desc-size":      { "$value": "0.7rem", "$type": "dimension" },
      "keyword-size":   { "$value": "0.58rem", "$type": "dimension" },
      "keyword-radius": { "$value": "{radius.xs}", "$type": "dimension" },
      "chip-size":      { "$value": "0.7rem", "$type": "dimension" },
      "chip-radius":    { "$value": "{radius.pill}", "$type": "dimension" },
      "search-size":    { "$value": "0.875rem", "$type": "dimension" },
      "search-radius":  { "$value": "{radius.md}", "$type": "dimension" }
    }
  }
}
```

**Tier 1 component token files:**

| File | Key values (with responsive modes where applicable) |
|---|---|
| `browse.json` | panel width (420px→100%), card thumb (64→96px), grid-col-min, title/desc/keyword/chip sizes, card padding/radius |
| `chat.json` | panel width (380px→100vw→100%), max-height (calc→60vh→75vh), trigger height (44→48px), msg font-size, input sizes, send-btn min-size (34→44px) |
| `playback.json` | transport-btn min-width (28→40px), font-size (0.7→1rem), home-btn min-size (36→44px), time-label font-size |
| `tools-menu.json` | btn min-height (34→38px), popover min-width (240→260px), item font-size (0.75→0.82rem), layout-btn min-height (30→36px) |

Tier 2 (info-panel, help) can be added in a follow-up once the
pipeline is proven. Tier 3 (loading, download, tour) stays hardcoded.

**Tasks:**
- [ ] Create `tokens/components/` directory
- [ ] Write each Tier 1 component JSON file with values extracted from
      the corresponding CSS file
- [ ] Use `{token.reference}` syntax where component values should
      reference global tokens (e.g., `{radius.lg}` instead of `8px`)
- [ ] Add mode extensions for every value that has a responsive or
      platform override
- [ ] Split or omit shorthand values — use single-value tokens only
- [ ] Cross-reference against STYLE_GUIDE.md to ensure all documented
      Tier 1 component specs are captured

### Phase 2: Style Dictionary build pipeline

Install Style Dictionary and configure it to generate `src/styles/tokens.css`
from both `tokens/global.json` and `tokens/components/*.json`.

**Files:**
- `tokens/style-dictionary.config.mjs` — build configuration
- `tokens/formats/` — custom format for multi-mode CSS output

**Config outline:**

```js
// tokens/style-dictionary.config.mjs
export default {
  source: [
    'tokens/global.json',
    'tokens/components/*.json'
  ],
  platforms: {
    css: {
      transformGroup: 'css',
      buildPath: 'src/styles/',
      files: [
        {
          destination: 'tokens.css',
          format: 'custom/multi-mode-css',
          options: {
            outputReferences: true,
            modes: {
              'default':         ':root',
              'mobile-native':   '.mobile-native',
              'tablet':          '@media (max-width: 768px) { :root',
              'phone-portrait':  '@media (max-width: 600px) and (orientation: portrait) { :root'
            }
          }
        }
      ]
    }
  }
}
```

The custom `multi-mode-css` format outputs:
1. `:root { }` — all default-mode tokens (global + component)
2. `.mobile-native { }` — only tokens with mobile-native overrides
3. `@media (max-width: 768px) { :root { } }` — tablet overrides
4. `@media (max-width: 600px) and (orientation: portrait) { :root { } }` — phone overrides

Component CSS files then replace hardcoded values with
`var(--component-browse-panel-width)` etc. and can remove their
`@media` overrides for values now handled by the token modes.

**Before writing custom code:** investigate the
[`@tokens-studio/sd-transforms`](https://github.com/tokens-studio/sd-transforms)
package for its token **transforms** (color conversion, dimension
handling, etc.). However, its multi-mode output generates **separate
CSS files per mode** (e.g., `desktop.css`, `tablet.css`) — it does
not output a single file with `:root`, `.mobile-native`, and `@media`
blocks. A custom Style Dictionary format (`custom/multi-mode-css`) is
required for our single-file architecture.

> **Note:** The latest `sd-transforms` requires Style Dictionary v5
> (not v4). Use `style-dictionary@^5.0.0`.

**Tasks:**
- [ ] Install `style-dictionary@^5.0.0` as a devDependency
- [ ] Install `@tokens-studio/sd-transforms` for token transforms
      (color, dimension, fontWeight handling)
- [ ] Write the `custom/multi-mode-css` format that reads
      `com.tokens-studio.modes` extensions and generates `:root`,
      `.mobile-native`, and `@media` blocks in a single CSS file
- [ ] Create `tokens/style-dictionary.config.mjs`
- [ ] Handle composite tokens: `--glass-border` is
      `1px solid var(--color-surface-border-subtle)` — needs a custom
      transform or manual override
- [ ] Handle `env()` safe-area tokens — these are runtime-only and
      can't come from the JSON; keep them as static entries appended
      to the generated file
- [ ] Add scripts to `package.json`:
      - `"tokens": "style-dictionary build --config tokens/style-dictionary.config.mjs"`
      - `"postinstall": "npm run tokens"` — ensures `tokens.css`
        exists immediately after `npm install`, before any other
        command. Eliminates all contributor friction from the gitignore.
- [ ] Verify generated `tokens.css` matches current file (diff should
      be zero meaningful changes for the global section; component
      tokens will be net-new custom properties)

### Phase 3: Penpot configuration

Configure the design-tool side of the pipeline. We use
[Penpot](https://penpot.app/), an open-source design tool with native
W3C Design Tokens support (MPL 2.0). Penpot reads and writes the same
token JSON format Style Dictionary consumes, so **no plugin, no
Personal Access Token, and no third-party Git integration are
required**. Designers import the JSON directly; round-trip happens by
exporting JSON back out and committing the diff.

**Why Penpot instead of Figma + Tokens Studio:**

- Native W3C Design Tokens JSON import/export — no plugin install,
  no marketplace dependency
- Free tier supports themes and modes (Figma's native variable modes
  are gated behind the Professional plan)
- Open source (MPL 2.0) — self-hostable; no per-seat lock-in
- No Personal Access Token, no GitHub integration to maintain — token
  files are dragged in or downloaded out of the Penpot tokens panel

**Tasks:**

- [ ] Create a free account at [design.penpot.app](https://design.penpot.app)
      (or self-host)
- [ ] Create the project file and import `tokens/global.json` and
      each `tokens/components/*.json` via Penpot's Tokens panel
      (File → Tokens → Import)
- [ ] Verify all global and component values appear with the correct
      types (color, dimension, fontWeight)
- [ ] Set up themes/modes in Penpot's Tokens panel:
      - Global: "Default", "Mobile Native"
      - Components: "Default", "Tablet", "Phone Portrait",
        "Mobile Native" (only where modes are defined in the JSON
        `$extensions`)
- [ ] Test round-trip: edit a color in Penpot → export tokens JSON →
      diff against `tokens/global.json` → commit changes → run
      `npm run tokens` → verify CSS output
- [ ] Test component round-trip: change browse panel width in
      Penpot → export → diff component JSON → regenerate CSS → verify
      `--component-browse-panel-width` value

#### Bootstrap tooling: `scripts/sync-penpot-global.ts`

The Penpot "Tokens panel → Import" path works for one-off JSON
imports, but it is a manual click-through and easy to drift from
when seeding a fresh file or refreshing tokens after edits. To make
the JSON-source-of-truth → Penpot direction reliable and repeatable,
bootstrapping the **Global** token set is automated by
[`scripts/sync-penpot-global.ts`](../scripts/sync-penpot-global.ts).

The script reads `tokens/global.json`, walks the W3C token tree, and
emits two outputs:

| Output | Flag | Use |
|---|---|---|
| Plugin code (default) | `--code` (default) | A self-contained JS string ready to send through the Penpot MCP `execute_code` tool |
| Spec list | `--list` | Flat JSON dump of `{ name, type, value, description? }` for inspection or piping to other tools |

The emitted code performs an idempotent upsert against a single set
named **Global**:

- creates the set if it does not exist
- creates each token if missing
- updates `value` only when it differs from the JSON
- leaves matching tokens untouched
- logs (does not delete) any tokens already in the set with no JSON
  counterpart, so renames surface as a warning rather than data loss
- preserves `$description` from the JSON onto the Penpot token

**Token naming.** Names mirror the JSON path with a literal dot,
matching the CSS custom-property suffix:

| JSON path | CSS variable | Penpot token name |
|---|---|---|
| `color.accent` | `--color-accent` | `color.accent` |
| `radius.md` | `--radius-md` | `radius.md` |
| `accent-opacity.o05` | `--accent-o05` | `accent-opacity.o05` |
| `glass.blur` | `--glass-blur` | `glass.blur` |

**Initial seed (May 2026).** The first run of this script against
the empty TerraViz - Design System file created 53 tokens — 44
`color`, 9 `dimension` — covering every leaf in `tokens/global.json`
that is a `color` or `dimension`. Every subsequent run with no JSON
edits is a no-op (`0 created / 0 updated / 53 unchanged`).

**Out of scope for this script** (covered separately or deferred):

- Component token sets sourced from `tokens/components/*.json` —
  handled by the sibling `scripts/sync-penpot-components.ts`
  (see below).
- Mode overrides (`com.tokens-studio.modes`) — `default` `$value`
  only for now; modes will be wired through Penpot themes once the
  Global set is stable.
- Library typographies and component scaffolding (Glass Surface,
  Transport Button, etc.).
- Round-trip in the other direction (Penpot → JSON export). The
  designer-side export-and-commit flow described above remains the
  canonical channel for now; a future script will diff Penpot's
  exported JSON against `tokens/*.json` to streamline review.

**Operating note.** The MCP plugin operates on whichever Penpot file
the plugin tab has focused. Verify with
`penpot.currentFile?.name` / `penpotUtils.getPages()` before any
write — if the plugin is attached to the wrong file, every
`addToken` call lands in the wrong library.

#### Bootstrap tooling: `scripts/sync-penpot-components.ts`

Sibling script to the Global seeder for the per-component JSONs in
`tokens/components/`. Same CLI surface (`--code` default, `--list`
flag) and the same idempotent upsert semantics — but emits a
multi-set plan, one Penpot set per component file:

| File | Penpot set |
|---|---|
| `tokens/components/browse.json` | `Components/Browse` |
| `tokens/components/chat.json` | `Components/Chat` |
| `tokens/components/playback.json` | `Components/Playback` |
| `tokens/components/tools-menu.json` | `Components/Tools-Menu` |

Token names mirror the full JSON path so they line up with Style
Dictionary's emitted CSS variables:

| JSON path | CSS variable | Penpot token name |
|---|---|---|
| `component.browse.panel-width` | `--component-browse-panel-width` | `component.browse.panel-width` |
| `component.chat.send-btn-min-size` | `--component-chat-send-btn-min-size` | `component.chat.send-btn-min-size` |
| `component.tools-menu.section-title-weight` | `--component-tools-menu-section-title-weight` | `component.tools-menu.section-title-weight` |

**Type mapping** (W3C `$type` → Penpot `TokenType`):

| W3C | Penpot | Notes |
|---|---|---|
| `color` | `color` | — |
| `dimension` | `dimension` | px, rem, vh, %, unitless all accepted |
| `fontWeight` | `fontWeights` | string value (e.g. `"600"`) |
| `number` | — | **skipped with stderr warning** — Penpot's `addToken` enum has no unitless-number/line-height variant. The only such token in the JSON is `component.chat.msg-line-height = 1.55` |

**Value caveat: `calc(...)` is skipped.** Penpot's `addToken`
rejects CSS `calc()` expressions on `dimension` tokens with
`Value not valid` (verified empirically — every other unit
including `100vh`, `88%`, and unitless values is fine). The script
detects `calc(` substrings during the walk and skips with a stderr
warning. The only calc value in the JSON is
`component.chat.panel-max-height = calc(100vh - 8rem)`. Style
Dictionary keeps the canonical value for `tokens.css`; designers
can override it inside Penpot if needed without affecting the
JSON source of truth.

**Initial seed (May 2026).** Seeded 62 tokens across 4 sets:

| Set | tokens | dimension | fontWeights |
|---|---:|---:|---:|
| Components/Browse | 20 | 19 | 1 |
| Components/Chat | 20 | 18 | 2 |
| Components/Playback | 9 | 8 | 1 |
| Components/Tools-Menu | 13 | 12 | 1 |

Two tokens skipped (1 `number`-typed line-height,
1 `calc()`-valued max-height); both surface as stderr warnings
on every run. Idempotent re-run is `0 created / 0 updated / 62
unchanged`.

**Out of scope for this pass** (deferred to follow-up branches):

- Mode overrides (`com.tokens-studio.modes`) — handled by the
  sibling `scripts/sync-penpot-modes.ts` (see below).
- A second-pass script to land `calc()`/`number` tokens via a
  different Penpot mechanism (manual override at the shape level,
  or as plain library values rather than design tokens) if a
  designer needs to interact with them.

#### Bootstrap tooling: `scripts/sync-penpot-modes.ts`

Third script in the seeding series, after the Global and Components
scripts have populated their base sets. Reads every
`$extensions["com.tokens-studio.modes"]` block in `tokens/global.json`
and `tokens/components/*.json`, groups overrides by mode key, and
emits two layers of plugin code:

1. **One Penpot set per non-default mode**, holding only the tokens
   that have an override for that mode. The set is intentionally
   **not toggled active** — themes manage activation. (Toggling a
   set's `active` directly puts Penpot into "manual" mode and
   disables every theme; see the `TokenTheme` API doc.)

| File | Penpot set | tokens |
|---|---|---:|
| `tokens/global.json` `mobile-native` overrides | `Modes/Mobile-Native` | 3 |
| Tablet overrides across `chat`/`playback`/`tools-menu`/`browse` | `Modes/Tablet` | 18 |
| Phone-portrait overrides across `browse`/`chat` | `Modes/Phone-Portrait` | 4 |

2. **One Penpot theme per mode**, in group `Default` (Penpot makes
   themes within a group mutually exclusive at activation time).
   Each theme's set list reflects the CSS-cascade Phone-Portrait
   inherits Tablet's overrides:

| Theme | Activated sets (later wins on collision) |
|---|---|
| Default | Global + Components/* |
| Tablet | + Modes/Tablet |
| Phone Portrait | + Modes/Tablet + Modes/Phone-Portrait |
| Mobile Native | + Modes/Mobile-Native |

After seeding, the script activates the **Default** theme so the
file leaves the "manual mode" state that the Global / Components
scripts left behind (those scripts toggled their base sets active
directly, which Penpot interprets as a custom theme).

**API caveat — `theme.addSet(...)` is broken on this Penpot
version.** Every argument shape (`TokenSet`, `id`, `name`,
`{id}`, `{name}`, array) returns a generic `Value not valid:
Field message is invalid` error. The `TokenTheme.addSet`/
`removeSet` mutators on already-existing themes therefore can't be
used right now. The script works around this by passing the full
set list to `addTheme({ group, name, sets: [name, ...] })` at
**creation** time (which is the only shape Penpot accepts) and, if
an existing theme's `activeSets` doesn't match the target list,
removes it and re-creates from scratch. Themes have no external
references, so recreate is observably identical to in-place
mutation. If a future Penpot release fixes `addSet`, switch to
in-place updates without losing the existing theme rows.

**Value caveat — same as the Components script.** `calc(...)`
mode-override values are skipped with stderr warning. The current
JSON has one such case: `component.chat.panel-width` `tablet`
override = `calc(100vw - 1.5rem)`. Phone-portrait and default
both override this token to plain values, so designers still see
`100%` (Phone Portrait theme) and the JSON-only default in CSS.

**Initial seed (May 2026).** 25 mode tokens across 3 sets + 4
themes; idempotent re-run is `0 created / 0 updated / 25 unchanged`
plus all themes `unchanged`. The Default theme is left active.

**Out of scope for this pass:**

- The other direction (Penpot → JSON export of mode overrides) —
  same staged plan as for the base scripts.
- Composite themes for the Tauri-mobile-on-phone scenario
  (Mobile Native + Phone Portrait). Mobile Native overrides only
  global tokens (radius/touch) and Phone Portrait overrides only
  component tokens, so they don't actually collide; a designer
  who needs the union today can manually toggle both sets active
  in the Tokens panel. Adding it as a fifth theme is mechanical
  if it turns out to be useful.

### Phase 4: CI and contributor setup

Since `tokens.css` is gitignored, CI must generate it before building.
The `postinstall` hook (added in Phase 2) handles this automatically
— `npm ci` triggers `postinstall` which runs `npm run tokens`.

**Tasks:**
- [ ] Verify CI passes end-to-end: `npm ci` (triggers postinstall →
      tokens) → `npm run build`
- [ ] Update `CLAUDE.md` key commands section to document `npm run tokens`
- [ ] Update `src/styles/README.md` to note that `tokens.css` is
      generated and should not be edited directly

### Phase 5: Component CSS migration

Migrate Tier 1 component CSS files to reference the new component
token custom properties, replacing hardcoded values. This is the step
where the sync pipeline actually takes effect in the running app.

**Approach:** Replace hardcoded values with `var(--component-{name}-{property})`
references **within the existing `@media` structure**. Do NOT try to
remove `@media` blocks — most blocks mix token-eligible values with
structural overrides (flex-direction changes, display toggling, etc.)
that must stay. Keeping the `@media` structure intact makes the
migration straightforward and avoids regressions.

**Example migration (browse.css):**

```css
/* Before */
#browse-overlay {
  width: 420px;
}
@media (max-width: 600px) and (orientation: portrait) {
  #browse-overlay {
    width: 100%;
    border-left: none;      /* structural — stays hardcoded */
    border-top: 1px solid;  /* structural — stays hardcoded */
  }
}

/* After */
#browse-overlay {
  width: var(--component-browse-panel-width);
}
@media (max-width: 600px) and (orientation: portrait) {
  #browse-overlay {
    width: var(--component-browse-panel-width);  /* token mode sets this to 100% */
    border-left: none;
    border-top: 1px solid;
  }
}
```

> The `@media` block for `width` is technically redundant (the token
> mode already changes the value) but keeping it is harmless and
> preserves the CSS structure. It can be cleaned up later once the
> pipeline is stable.

**Tasks:**
- [ ] Migrate `browse.css` — replace ~15 hardcoded values with token vars
- [ ] Migrate `chat.css` — replace ~20 hardcoded values
- [ ] Migrate `playback.css` — replace ~6 values (transport-btn sizes,
      home-btn, time-label)
- [ ] Migrate `tools-menu.css` — replace ~12 values
- [ ] After each file: run `npm run type-check` and `npm run test`
- [ ] Visual regression check: compare dev server rendering before
      and after migration (should be pixel-identical)

### Phase 6: STYLE_GUIDE.md auto-generated sections

Keep STYLE_GUIDE.md as the human-readable design reference, but inject
token-derived tables so it stays in sync with the source of truth
automatically.

**Approach:** A Node script reads the token JSON files and writes
markdown tables between marker comments in STYLE_GUIDE.md. Hand-written
prose outside the markers is preserved.

**Marker format:**

```markdown
## Color Palette

<!-- tokens:auto:colors -->
| Token | Value | Usage |
|---|---|---|
| `--color-accent` | `#4da6ff` | Active states, links, highlights |
...
<!-- /tokens:auto:colors -->
```

**Auto-generated sections:**

| Section | Source | Content |
|---|---|---|
| Color Palette | `global.json` → `color.*` | Table of token name, value, `$description` |
| Spacing Scale | `global.json` → `space.*` | Table of `--space-*` tokens |
| Border Radii | `global.json` → `radius.*` | Table with default + mobile-native values |
| Glass Surface | `global.json` → `glass.*` | Background, blur, border values |
| Component Catalog (each) | `components/*.json` | Table of key dimensions per mode |

**Hand-written sections (preserved as-is):**

- Design Principles
- Typography (prose + font stack — values can reference tokens)
- Interactive Buttons (prose describing states)
- Animations
- Accessibility (Section 508 / WCAG 2.1 AA)
- Mobile Adaptations (prose; dimension tables auto-generated)

**Script:** `tokens/scripts/update-style-guide.mjs`

```js
// Reads tokens/global.json + tokens/components/*.json
// Finds <!-- tokens:auto:{section} --> markers in STYLE_GUIDE.md
// Replaces content between markers with generated tables
// Preserves everything outside markers
```

**Tasks:**
- [ ] Add marker comments to STYLE_GUIDE.md for each auto-generated
      section
- [ ] Write `tokens/scripts/update-style-guide.mjs`
- [ ] Add `"docs:tokens": "node tokens/scripts/update-style-guide.mjs"`
      to `package.json`
- [ ] Run `npm run docs:tokens` after `npm run tokens` in CI so the
      style guide is always current in PRs
- [ ] Verify hand-written prose is untouched after running the script

## File Changes Summary

| Action | Path | Description |
|---|---|---|
| Create | `tokens/global.json` | W3C Design Tokens — all values from `tokens.css` |
| Create | `tokens/components/*.json` (4 files) | Tier 1 per-component design values with responsive modes |
| Create | `tokens/style-dictionary.config.mjs` | Style Dictionary build config |
| Create | `tokens/README.md` | Contributor guide for the token workflow |
| Create | `tokens/scripts/update-style-guide.mjs` | Script to inject token tables into STYLE_GUIDE.md |
| Delete | `src/styles/tokens.css` | Removed from git — now a **generated** build artifact (gitignored) |
| Modify | `.gitignore` | Add `src/styles/tokens.css` |
| Modify | `src/styles/browse.css` | Replace hardcoded values with `var()` token references |
| Modify | `src/styles/chat.css` | Replace hardcoded values with `var()` token references |
| Modify | `src/styles/playback.css` | Replace hardcoded values with `var()` token references |
| Modify | `src/styles/tools-menu.css` | Replace hardcoded values with `var()` token references |
| Modify | `STYLE_GUIDE.md` | Add marker comments for auto-generated sections |
| Modify | `package.json` | Add devDeps + `tokens` / `postinstall` / `docs:tokens` scripts |

## Dependencies

| Package | Version | Purpose | Cost |
|---|---|---|---|
| `style-dictionary` | `^5.0.0` | Token → CSS build | Free (Apache 2.0) |
| `@tokens-studio/sd-transforms` | latest | Token transforms (color, dimension, etc.) | Free (open source) |
| Penpot | Latest | Design tool — native W3C Design Tokens JSON import/export | Free (MPL 2.0, open source) |

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Generated `tokens.css` drifts from hand-edited version | Broken styles | Phase 2 validation: diff generated vs. current before switching over |
| `rgba()` values don't round-trip perfectly through the design tool | Slight color shifts | Pin exact values in JSON; Penpot preserves raw values from import |
| Composite tokens (`--glass-border`) can't be expressed in W3C format | Manual maintenance | Keep composites as a hand-written appendix in the generated file, or use Style Dictionary references |
| `env()` safe-area tokens are runtime-only | Can't be in JSON | Append as static lines via a custom Style Dictionary format |
| Developer edits `tokens.css` directly instead of JSON | Changes lost on next build | File is gitignored so direct edits are never committed; contributors learn the workflow naturally |
| Component CSS migration introduces visual regressions | Broken UI | Migrate one file at a time with visual regression check; keep `@media` structure intact |
| Token naming collisions between components | Conflicting custom properties | Namespace all component tokens: `--component-{name}-{property}` |
| `postinstall` adds time to `npm install` | Slower install | Token build is fast (~1s); acceptable tradeoff for zero-friction contributor experience |

## Phasing & Sequencing

Phases can be executed incrementally. Each phase produces a working
state.

```
Phase 1a (global tokens)
    └──▶ Phase 2 (build pipeline + postinstall) ──▶ Phase 4 (CI)
Phase 1b (Tier 1 component tokens) ─────────────────┘
    └──▶ Phase 5 (CSS migration)
Phase 3 (Penpot) — can start after Phase 1a
Phase 6 (STYLE_GUIDE auto-update) — after Phase 1a + 1b
```

**Recommended order:**
1. Phase 1a + Phase 2 — get global tokens building, `tokens.css`
   gitignored, `postinstall` hook working
2. Phase 4 — verify CI passes, update docs
3. Phase 3 — verify Penpot round-trip works with global tokens
4. Phase 1b — add Tier 1 component tokens
5. Phase 5 — migrate Tier 1 component CSS to use token vars
6. Phase 6 — add auto-generated sections to STYLE_GUIDE.md

## Decisions

1. **`tokens.css` is gitignored.** A `postinstall` hook runs
   `npm run tokens` after every `npm install`, so `tokens.css` exists
   before any other command runs. Contributors never see a missing
   file. Drift is impossible because the file is never committed.

2. **Token naming convention:** `--component-{name}-{property}`. The
   `component-` prefix avoids collisions with global tokens.

3. **Penpot is the design tool.** [Penpot](https://penpot.app/) is
   open-source (MPL 2.0) and ships native W3C Design Tokens support —
   including free-tier theming and modes. No plugin, no Personal
   Access Token, no per-seat costs, and self-hostable. Keeps the
   entire pipeline at $0/mo and removes the Figma + Tokens Studio
   plugin / GitHub PAT chain that would otherwise be required for an
   open-source contributor workflow.

4. **Granularity threshold:** tokenize values documented in
   STYLE_GUIDE.md and values with responsive/platform overrides.
   One-off internal values stay hardcoded. Single-value tokens only —
   shorthand properties are split or omitted.

5. **STYLE_GUIDE.md stays as a human-readable document** with
   auto-generated token tables injected between marker comments.
   Prose sections stay hand-written. See Phase 6.

6. **Component tiers.** Tokenize Tier 1 (browse, chat, playback,
   tools-menu) first. Tier 2 (info-panel, help) follows once the
   pipeline is proven. Tier 3 (loading, download, tour) stays
   hardcoded.

7. **CSS migration preserves `@media` structure.** Replace hardcoded
   values with `var()` references within the existing `@media` blocks.
   Do not remove `@media` blocks — they contain a mix of token-eligible
   values and structural overrides.

8. **Spacing scale is a separate effort.** The commented-out
   `--space-*` tokens in `tokens.css` are not activated as part of this
   work. Activating them would require migrating raw `rem` values
   across all CSS files — a separate task.

## Future Work (not part of this plan)

These items depend on prerequisites that don't exist yet:

- **Penpot component library** — Build the Tier 1 component frames
  (browse panel, chat panel, playback controls, tools menu) in Penpot
  using the imported tokens. Penpot stores components and tokens in
  the same file, so designers can iterate on dimensions and have the
  changes flow back through `tokens/*.json` → `tokens.css`. Requires
  the Tier 1 token JSON files to be imported (Phase 3) first.

- **Layout configuration system** — JSON-driven layout configs that
  let installations target specific display contexts: kiosk (single
  touchscreen), video wall (high-resolution, large viewing distance),
  planetarium (dome projection), multi-monitor (synchronized
  viewports), and spherical display (Science On a Sphere globe).
  Each context needs its own typography scale, touch target sizing,
  spacing density, and panel positioning rules — all expressible as
  token modes layered on top of the responsive modes already in
  place. Requires: design exploration in Penpot per context, mode
  extensions to the `multi-mode-css` format if more than the current
  four modes are needed.

- **Tier 2 component tokens** — info-panel, help panel. Add after
  Tier 1 pipeline is stable.

- **Spacing scale activation** — uncomment `--space-*` tokens, migrate
  raw `rem` values across all CSS files.

- **`@media` block cleanup** — once token modes are stable, redundant
  responsive overrides in `@media` blocks can be removed. Low priority.
