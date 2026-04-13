# Design System Figma Sync — Implementation Plan

Establish a two-way sync pipeline between the CSS design system and
Figma across three layers:

1. **Global tokens** — colors, radii, glass effects, touch targets
2. **Component tokens** — per-component dimensions, typography, spacing
   with responsive/platform overrides
3. **Component documentation** — linking Figma component frames to their
   CSS source files via Figma Code Connect

## Architecture

```
tokens/
  ├── global.json         ← global design tokens (colors, radii, glass)
  ├── components/
  │   ├── browse.json     ← browse panel component tokens
  │   ├── chat.json       ← chat panel component tokens
  │   ├── info-panel.json ← info panel component tokens
  │   ├── playback.json   ← playback controls component tokens
  │   ├── tools-menu.json ← tools menu component tokens
  │   ├── help.json       ← help panel component tokens
  │   ├── tour.json       ← tour overlay component tokens
  │   ├── download.json   ← download manager component tokens
  │   └── loading.json    ← loading screen component tokens
  ├── style-dictionary.config.mjs
  ├── $metadata.json      ← Tokens Studio metadata
  └── $themes.json        ← Tokens Studio theme definitions

          │                                    ▲
          ▼                                    │
  Style Dictionary build                Tokens Studio
  (npm run tokens)                    (Figma plugin, Git sync)
          │                                    │
          ▼                                    │
  src/styles/tokens.css  ◄─── generated ───►  Figma Variables
  (gitignored build artifact;                & Components
   global + component custom properties)
```

**Round-trip flow:**

- **Designer edits in Figma** → Tokens Studio pushes a commit updating
  token JSON files → CI (or local `npm run tokens`) regenerates
  `tokens.css`
- **Developer edits token JSON** → runs `npm run tokens` to regenerate
  CSS → Tokens Studio pulls changes into Figma on next sync
- **Component documentation** flows one-way: Code Connect config in the
  repo tells Figma which source file implements each component

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
responsive breakpoints or platform modes. Each component file defines
the values a designer can adjust in Figma and see reflected in code.

| Component | Key synced values | Modes |
|---|---|---|
| **Browse panel** | width (420px / 100%), card thumbnail size (64px / 96px), grid column min (260px), card padding, chip sizes | desktop, phone-portrait |
| **Chat panel** | width (380px / 100vw / 100%), max-height (calc / 60vh / 75vh), trigger height (44px / 48px), message font-size, input min-height | desktop, tablet, phone-portrait |
| **Info panel** | max-width (340px / 100vw-1.5rem), expanded max-height (60vh / 40vh), body padding | desktop, tablet |
| **Playback** | transport-btn min-width (28px / 40px), font-size (0.7rem / 1rem), home-btn min size (36px / 44px) | desktop, tablet |
| **Tools menu** | btn min-height (34px / 38px), popover min-width (240px / 260px), item padding/font-size | desktop, tablet |
| **Help panel** | width (640px / 100vw-1.5rem / 100vw), max-height (80vh / 70vh / 100dvh), trigger size (36px / 48px / 40px), border-radius (8px / 0) | desktop, tablet, phone-portrait |
| **Tour** | transport-btn min-size (32px / 40px), question-btn min-size (44px), caption font-size | desktop, tablet |
| **Download mgr** | panel width (320px), thumb size (36px), item gap | desktop only |
| **Loading** | globe size (88px), ring size (88px/72px), progress-track width (180px), title font-size (1.4rem) | desktop only |

### Layer 3: Component documentation (Figma Code Connect)

One-way link from code to Figma. Each Figma component frame is
annotated with its source CSS file so designers can jump to the
implementation.

| Figma component | Source file |
|---|---|
| Browse Panel | `src/styles/browse.css` |
| Browse Card | `src/styles/browse.css` |
| Chat Panel | `src/styles/chat.css` |
| Chat Trigger | `src/styles/chat.css` |
| Chat Message | `src/styles/chat.css` |
| Info Panel | `src/styles/info-panel.css` |
| Playback Controls | `src/styles/playback.css` |
| Tools Menu | `src/styles/tools-menu.css` |
| Help Panel | `src/styles/help.css` |
| Tour Controls | `src/styles/tour.css` |
| Download Manager | `src/styles/download.css` |
| Loading Screen | `src/styles/loading.css` |
| Glass Surface | `src/styles/tokens.css` (base token) |
| Transport Button | `src/styles/playback.css` |

### Out of scope (stays in CSS / code only)

- Layout logic (grid templates, flex direction, position)
- Animation / transition definitions (`transform 0.3s ease`, keyframes)
- JS-driven state classes (`.collapsed`, `.is-primary`, `.out-of-range`)
- Media query selectors (breakpoint *values* are tokens; the `@media`
  rules stay in CSS)
- Structural CSS (display, overflow, z-index, pointer-events)

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
- [ ] Activate the currently commented-out spacing scale (`--space-*`)
- [ ] Include mode extensions for `.mobile-native` overrides
- [ ] Validate JSON against W3C Design Tokens Community Group spec

### Phase 1b: Component token extraction (components/*.json)

Extract hardcoded design values from each component CSS file into
per-component token files. Only values that a designer would
reasonably adjust belong here — not structural CSS.

**Criteria for inclusion:** A value is a component token if it:
- Defines a visual dimension a designer iterates on (width, padding,
  font-size, border-radius, thumbnail size)
- Has a responsive or platform override (different at 768px, 600px
  portrait, or `.mobile-native`)
- Is referenced in STYLE_GUIDE.md as a documented design decision

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
      "keyword-padding": { "$value": "0.12rem 0.35rem", "$type": "dimension" },
      "keyword-radius": { "$value": "{radius.xs}", "$type": "dimension" },
      "chip-size":      { "$value": "0.7rem", "$type": "dimension" },
      "chip-padding":   { "$value": "0.3rem 0.75rem", "$type": "dimension" },
      "chip-radius":    { "$value": "{radius.pill}", "$type": "dimension" },
      "search-size":    { "$value": "0.875rem", "$type": "dimension" },
      "search-radius":  { "$value": "{radius.md}", "$type": "dimension" }
    }
  }
}
```

**All component token files to create:**

| File | Key values (with responsive modes where applicable) |
|---|---|
| `browse.json` | panel width (420px→100%), card thumb (64→96px), grid-col-min, chip/keyword/title sizes, card padding/radius |
| `chat.json` | panel width (380px→100vw→100%), max-height (calc→60vh→75vh), trigger height (44→48px), msg font-size, input sizes, send-btn min-size (34→44px) |
| `info-panel.json` | max-width (340px→100vw-1.5rem), expanded max-height (60vh→40vh), title/desc/meta font-sizes, keyword sizes, legend-thumb max-height |
| `playback.json` | transport-btn min-width (28→40px), font-size (0.7→1rem), padding (0.3rem→0.4rem), home-btn min-size (36→44px), time-label font-size/padding |
| `tools-menu.json` | btn min-height (34→38px), btn padding/font-size, popover min-width (240→260px), item padding (0.5rem→0.6rem), item font-size (0.75→0.82rem), layout-btn min-height (30→36px) |
| `help.json` | panel width (640px→100vw-1.5rem→100vw), max-height (80vh→70vh→100dvh), border-radius (8px→0), trigger min-height (36→48→40px), tab/form font-sizes |
| `tour.json` | transport-btn min-size (32→40px), question-btn size (44px), textbox-close size, caption/legend sizes |
| `download.json` | panel width (320px), max-height (400px), thumb size (36px), item gap, title/meta font-sizes |
| `loading.json` | globe size (88px), ring sizes, progress-track width (180px), title font-size (1.4rem), subtitle size |

**Tasks:**
- [ ] Create `tokens/components/` directory
- [ ] Write each component JSON file with values extracted from the
      corresponding CSS file
- [ ] Use `{token.reference}` syntax where component values should
      reference global tokens (e.g., `{radius.lg}` instead of `8px`)
- [ ] Add mode extensions for every value that has a responsive or
      platform override
- [ ] Cross-reference against STYLE_GUIDE.md to ensure all documented
      component specs are captured

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

**Tasks:**
- [ ] Install `style-dictionary` as a devDependency
- [ ] Create `tokens/style-dictionary.config.mjs`
- [ ] Write the `custom/multi-mode-css` format that reads
      `com.tokens-studio.modes` extensions and generates the correct
      CSS blocks per mode
- [ ] Handle composite tokens: `--glass-border` is
      `1px solid var(--color-surface-border-subtle)` — needs a custom
      transform or manual override
- [ ] Handle `env()` safe-area tokens — these are runtime-only and
      can't come from the JSON; keep them as static entries appended
      to the generated file
- [ ] Add `"tokens": "style-dictionary build --config tokens/style-dictionary.config.mjs"`
      to `package.json` scripts
- [ ] Verify generated `tokens.css` matches current file (diff should
      be zero meaningful changes for the global section; component
      tokens will be net-new custom properties)
- [ ] Add `tokens` step to the `build` script or document as a
      prerequisite

### Phase 3: Tokens Studio configuration

Configure the Figma-side integration so the Tokens Studio plugin can
read/write the token JSON files in this repository.

**Tasks:**
- [ ] Add `tokens/$metadata.json` and `tokens/$themes.json` files
      (Tokens Studio uses these to store mode/theme mappings and
      multi-file token set references)
- [ ] Configure `$metadata.json` with token set order:
      `["global", "components/browse", "components/chat", ...]`
- [ ] Document Tokens Studio setup steps in this plan (below)
- [ ] Test round-trip: edit a color in Figma → push → verify JSON
      change → run `npm run tokens` → verify CSS output
- [ ] Test component round-trip: change browse panel width in Figma →
      push → verify component JSON → regenerate CSS → verify
      `--component-browse-panel-width` value

**Tokens Studio setup (manual, in Figma):**

1. Install the [Tokens Studio](https://www.figma.com/community/plugin/843461159747178978)
   plugin in Figma
2. Open plugin → Settings → Add new sync provider → **GitHub**
3. Configure:
   - Repository: `zyra-project/interactive-sphere`
   - Branch: `main` (or feature branch for testing)
   - File path: `tokens` (Tokens Studio reads `$metadata.json` to
     discover all token files in the directory)
   - Personal access token: (a GitHub PAT with `repo` scope)
4. Pull tokens → verify all global and component values appear
5. Create Figma variable collections:
   - **Global** collection → colors, radii, spacing, glass, touch
   - **Components** collection → per-component design values
6. Set up modes using **Tokens Studio's mode UI** (not native Figma
   variable modes — those require Figma Professional):
   - Global: "Default", "Mobile Native"
   - Components: "Default", "Tablet", "Phone Portrait", "Mobile Native"
     (only where modes are defined in the JSON)
   - Designers switch modes in the Tokens Studio plugin panel to
     preview platform variants

### Phase 4: CI build prerequisite

Since `tokens.css` is gitignored, CI must generate it before building
the app. This replaces the old "drift detection" approach — there is
no file to drift because it's not in the repo.

**Tasks:**
- [ ] Update the CI build workflow to run `npm run tokens` before
      `npm run build` (or add `tokens` as a `prebuild` script in
      `package.json`)
- [ ] Update `CLAUDE.md` key commands section to document that
      `npm run tokens` is required before `npm run dev`
- [ ] Add a `"predev": "npm run tokens"` script so `npm run dev`
      auto-generates tokens before starting Vite
- [ ] Verify CI passes end-to-end: `npm ci → npm run tokens → npm run build`

### Phase 5: Figma Code Connect

Link Figma component frames to their CSS source files so designers
can navigate directly from a Figma component to its implementation.

**Tool:** [Figma Code Connect](https://github.com/figma/code-connect)
(open source, free, framework-agnostic)

Code Connect uses a config file + per-component `.figma.ts` files
that map Figma node URLs to source file paths. Since this project
uses vanilla CSS (not React/Vue components), the mappings are
lightweight documentation pointers.

**File:** `figma.config.json` (project root)

```json
{
  "codeConnect": {
    "parser": "custom",
    "include": ["figma/**/*.figma.ts"]
  }
}
```

**File:** `figma/browse.figma.ts` (example)

```ts
import figma from '@figma/code-connect'

figma.connect('https://figma.com/file/XXXX/node-id=...', {
  example: () => `/* Browse Panel — src/styles/browse.css */
.browse-overlay {
  width: var(--component-browse-panel-width);
  /* Card grid */
  grid-template-columns: repeat(auto-fill, minmax(var(--component-browse-grid-col-min), 1fr));
  gap: var(--component-browse-grid-gap);
}`,
})
```

**Tasks:**
- [ ] Install `@figma/code-connect` as a devDependency
- [ ] Create `figma.config.json`
- [ ] Create `figma/` directory with one `.figma.ts` per component
      (browse, chat, info-panel, playback, tools-menu, help, tour,
      download, loading)
- [ ] Each file maps the Figma component URL to a CSS usage example
      showing the token custom properties in context
- [ ] Run `npx figma connect publish` to push the mappings to Figma
- [ ] Document the Figma node URLs once the Figma file is created
      (these are placeholder until the design file exists)

> **Note:** Code Connect is one-way (code → Figma). It doesn't sync
> values — it provides "View code" links in Figma's inspect panel.
> The actual value sync is handled by Tokens Studio (Phase 3).

### Phase 6: Component CSS migration

Migrate component CSS files to reference the new component token
custom properties, replacing hardcoded values. This is the step
where the sync pipeline actually takes effect in the running app.

**Approach:** For each component CSS file, replace hardcoded values
with `var(--component-{name}-{property})` references and remove
`@media` overrides for values now handled by token modes.

**Example migration (browse.css):**

```css
/* Before */
#browse-overlay {
  width: 420px;
}
@media (max-width: 600px) and (orientation: portrait) {
  #browse-overlay { width: 100%; }
}

/* After */
#browse-overlay {
  width: var(--component-browse-panel-width);
}
/* @media override removed — token mode handles it */
```

**Tasks:**
- [ ] Migrate `browse.css` — replace ~15 hardcoded values with token
      vars, remove responsive overrides now handled by modes
- [ ] Migrate `chat.css` — replace ~20 hardcoded values, remove
      tablet/phone-portrait `@media` overrides for token-backed values
- [ ] Migrate `info-panel.css` — replace ~10 values
- [ ] Migrate `playback.css` — replace ~6 values (transport-btn sizes,
      home-btn, time-label)
- [ ] Migrate `tools-menu.css` — replace ~12 values
- [ ] Migrate `help.css` — replace ~15 values (most responsive
      overrides across 3 breakpoints)
- [ ] Migrate `tour.css` — replace ~6 values
- [ ] Migrate `download.css` — replace ~8 values (no responsive
      overrides)
- [ ] Migrate `loading.css` — replace ~10 values (no responsive
      overrides)
- [ ] After each file: run `npm run type-check` and `npm run test`
- [ ] Visual regression check: compare dev server rendering before
      and after migration (should be pixel-identical)

### Phase 7: STYLE_GUIDE.md auto-generated sections

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
| Create | `tokens/components/*.json` (9 files) | Per-component design values with responsive modes |
| Create | `tokens/style-dictionary.config.mjs` | Style Dictionary build config |
| Create | `tokens/formats/multi-mode-css.mjs` | Custom format for mode-aware CSS output |
| Create | `tokens/$metadata.json` | Tokens Studio metadata (token set order) |
| Create | `tokens/$themes.json` | Tokens Studio theme definitions |
| Create | `tokens/scripts/update-style-guide.mjs` | Script to inject token tables into STYLE_GUIDE.md |
| Create | `figma.config.json` | Figma Code Connect configuration |
| Create | `figma/*.figma.ts` (9 files) | Per-component Figma ↔ source file mappings |
| Delete | `src/styles/tokens.css` | Removed from git — now a **generated** build artifact (gitignored) |
| Modify | `.gitignore` | Add `src/styles/tokens.css` |
| Modify | `src/styles/browse.css` | Replace hardcoded values with `var()` token references |
| Modify | `src/styles/chat.css` | Replace hardcoded values with `var()` token references |
| Modify | `src/styles/info-panel.css` | Replace hardcoded values with `var()` token references |
| Modify | `src/styles/playback.css` | Replace hardcoded values with `var()` token references |
| Modify | `src/styles/tools-menu.css` | Replace hardcoded values with `var()` token references |
| Modify | `src/styles/help.css` | Replace hardcoded values with `var()` token references |
| Modify | `src/styles/tour.css` | Replace hardcoded values with `var()` token references |
| Modify | `src/styles/download.css` | Replace hardcoded values with `var()` token references |
| Modify | `src/styles/loading.css` | Replace hardcoded values with `var()` token references |
| Modify | `STYLE_GUIDE.md` | Add marker comments for auto-generated sections |
| Modify | `package.json` | Add devDeps + `tokens` / `docs:tokens` scripts |

## Dependencies

| Package | Version | Purpose | Cost |
|---|---|---|---|
| `style-dictionary` | `^4.0.0` | Token → CSS build | Free (Apache 2.0) |
| `@figma/code-connect` | `^1.0.0` | Component ↔ source file links | Free (open source) |
| Tokens Studio plugin | latest | Figma ↔ Git sync | Free tier |
| Figma | Free plan | Design tool | $0 — modes managed via Tokens Studio UI |

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Generated `tokens.css` drifts from hand-edited version | Broken styles | Phase 2 validation: diff generated vs. current before switching over |
| `rgba()` values don't round-trip perfectly through Figma | Slight color shifts | Pin exact values in JSON; Tokens Studio preserves raw values |
| Composite tokens (`--glass-border`) can't be expressed in W3C format | Manual maintenance | Keep composites as a hand-written appendix in the generated file, or use Style Dictionary references |
| `env()` safe-area tokens are runtime-only | Can't be in JSON | Append as static lines via a custom Style Dictionary format |
| Developer edits `tokens.css` directly instead of JSON | Changes lost on next build | File is gitignored so direct edits are never committed; contributors learn the workflow naturally |
| Too many component custom properties bloat CSS | Larger stylesheet | Only tokenize values that are designer-facing or have responsive overrides (~100 component properties total; negligible impact) |
| Component CSS migration introduces visual regressions | Broken UI | Migrate one file at a time with visual regression check before and after |
| Code Connect node URLs unknown until Figma file exists | Placeholder URLs | Phase 5 files use placeholder URLs; update them once the Figma component library is created |
| Token naming collisions between components | Conflicting custom properties | Namespace all component tokens: `--component-{name}-{property}` |

## Phasing & Sequencing

Phases can be executed incrementally. Each phase produces a
working state — no phase depends on all previous phases being
complete.

```
Phase 1a (global tokens)
    └──▶ Phase 2 (build pipeline) ──▶ Phase 4 (CI prereq)
Phase 1b (component tokens) ─────────┘
    └──▶ Phase 6 (CSS migration)
Phase 3 (Tokens Studio) — can start after Phase 1a
Phase 5 (Code Connect) — independent, can start anytime
Phase 7 (STYLE_GUIDE auto-update) — after Phase 1a + 1b
```

**Recommended order:**
1. Phase 1a + Phase 2 — get global tokens building, `tokens.css`
   gitignored, `npm run tokens` working
2. Phase 4 — wire up CI/predev scripts so builds don't break
3. Phase 3 — verify Figma round-trip works with global tokens
4. Phase 1b — add component tokens
5. Phase 6 — migrate component CSS to use token vars
6. Phase 7 — add auto-generated sections to STYLE_GUIDE.md
7. Phase 5 — add Code Connect last (it needs a Figma file to exist)

## Decisions

The following questions have been resolved:

1. **`tokens.css` is gitignored.** It is a build artifact generated by
   `npm run tokens`. Contributors must run `npm run tokens` (or
   `npm run build`, which includes it) before the dev server will work.
   The `npm run tokens` step is documented in CLAUDE.md and README.
   Phase 4 CI runs `npm run tokens` as a build prerequisite rather than
   a drift check.

2. **Token naming convention:** `--component-{name}-{property}`. The
   `component-` prefix avoids collisions with global tokens and makes
   it clear when inspecting CSS that a property comes from the component
   token layer vs. the global layer.

3. **Figma free plan.** All modes are managed in Tokens Studio's own
   mode UI (free tier), not Figma's native variable modes. This keeps
   the entire pipeline at $0/mo — important for contributor adoption on
   an open-source project. If a future contributor has Figma Pro, the
   modes can optionally be promoted to native Figma variable modes, but
   it is not required.

4. **Granularity threshold:** tokenize values documented in
   STYLE_GUIDE.md and values with responsive/platform overrides.
   One-off internal values (a single `0.2rem` gap with no override) stay
   hardcoded. Additional values can be promoted to tokens in future
   iterations as needed.

5. **STYLE_GUIDE.md stays as a human-readable document** but is updated
   to reference the token JSON as the source of truth. Sections that
   can be auto-generated (color palette table, spacing scale, component
   dimension tables) are generated by a script (`npm run docs:tokens`)
   and injected between marker comments. Prose sections (design
   principles, accessibility guidelines, animation philosophy) stay
   hand-written. See Phase 7.
