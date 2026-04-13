# Design System Figma Sync — Implementation Plan

Establish a two-way sync pipeline between the CSS design token system
(`src/styles/tokens.css`) and Figma, so that designers and developers
share a single source of truth for colors, spacing, radii, glass
effects, and platform-specific overrides.

## Architecture

```
tokens.json  (W3C Design Tokens format — canonical source of truth)
    │
    ├──▶ Style Dictionary build ──▶ src/styles/tokens.css
    │        (npm run tokens)          (generated, git-tracked)
    │
    └──◀ Tokens Studio (Figma plugin) ──◀ Figma Variables
              (push / pull via Git)
```

**Round-trip flow:**

- **Designer edits in Figma** → Tokens Studio pushes a commit updating
  `tokens.json` → CI (or local `npm run tokens`) regenerates
  `tokens.css`
- **Developer edits `tokens.json`** → runs `npm run tokens` to
  regenerate CSS → Tokens Studio pulls changes into Figma on next sync

## Scope

### In scope (sync'd via tokens.json)

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
| Platform overrides | `.mobile-native` token values | Modes |

### Out of scope (stays in CSS / code only)

- Layout logic (grid templates, flex direction)
- Animation / transition definitions
- JS-driven state classes (`.collapsed`, `.is-primary`)
- Media query selectors (breakpoint *values* are tokens; the `@media` rules stay in CSS)
- Component-level structural CSS (position, display, overflow)

## Platform Modes

The token file uses **modes** to represent platform variants. Style
Dictionary generates the appropriate CSS selectors for each mode.

| Mode | CSS Output | Trigger |
|---|---|---|
| `default` | `:root { ... }` | Base — desktop browser |
| `mobile-native` | `.mobile-native { ... }` | Tauri mobile sets class on `<body>` |

> Future modes (e.g., `tablet`, `phone-portrait`) can be added when
> component-level token overrides at those breakpoints are needed. For
> now, breakpoint-specific overrides live in component CSS files since
> they're structural rather than token-level.

## Implementation Phases

### Phase 1: Token extraction (tokens.json)

Convert the existing `tokens.css` custom properties into a W3C Design
Tokens JSON file.

**File:** `tokens/tokens.json`

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
    "surface": { "$value": "rgba(255, 255, 255, 0.06)", "$type": "color" },
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
    },
    // ...
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
    "bg": { "$value": "rgba(13, 13, 18, 0.92)", "$type": "color" },
    "bg-light": { "$value": "rgba(13, 13, 18, 0.88)", "$type": "color" },
    "blur": { "$value": "12px", "$type": "dimension" }
  }
}
```

**Tasks:**
- [ ] Create `tokens/` directory at project root
- [ ] Write `tokens/tokens.json` covering all custom properties from `tokens.css`
- [ ] Include mode extensions for `.mobile-native` overrides
- [ ] Validate JSON against W3C Design Tokens Community Group spec

### Phase 2: Style Dictionary build pipeline

Install Style Dictionary and configure it to generate `src/styles/tokens.css`
from `tokens/tokens.json`.

**Files:**
- `tokens/style-dictionary.config.mjs` — build configuration
- `tokens/transforms/` — custom transforms (if needed for glass-border shorthand, `env()` safe-area values)

**Config outline:**

```js
// tokens/style-dictionary.config.mjs
export default {
  source: ['tokens/tokens.json'],
  platforms: {
    css: {
      transformGroup: 'css',
      buildPath: 'src/styles/',
      files: [
        {
          destination: 'tokens.css',
          format: 'css/variables',
          options: {
            outputReferences: true  // preserve token references
            // Custom header comment preserved
          }
        }
      ]
    }
  }
}
```

**Tasks:**
- [ ] Install `style-dictionary` as a devDependency
- [ ] Create `tokens/style-dictionary.config.mjs`
- [ ] Write a custom format or use built-in `css/variables` to output
      `:root { }` and `.mobile-native { }` blocks
- [ ] Handle composite tokens: `--glass-border` is
      `1px solid var(--color-surface-border-subtle)` — needs a custom
      transform or manual override
- [ ] Handle `env()` safe-area tokens — these are runtime-only and
      can't come from the JSON; keep them as static entries appended
      to the generated file
- [ ] Add `"tokens": "style-dictionary build --config tokens/style-dictionary.config.mjs"`
      to `package.json` scripts
- [ ] Verify generated `tokens.css` matches current file exactly
      (diff should be zero meaningful changes)
- [ ] Add `tokens` step to the `build` script or document as a
      prerequisite

### Phase 3: Tokens Studio configuration

Configure the Figma-side integration so the Tokens Studio plugin can
read/write `tokens/tokens.json` in this repository.

**Tasks:**
- [ ] Add `tokens/$metadata.json` and `tokens/$themes.json` files
      (Tokens Studio uses these to store mode/theme mappings)
- [ ] Document Tokens Studio setup steps in this plan (below)
- [ ] Test round-trip: edit a color in Figma → push → verify JSON
      change → run `npm run tokens` → verify CSS output

**Tokens Studio setup (manual, in Figma):**

1. Install the [Tokens Studio](https://www.figma.com/community/plugin/843461159747178978)
   plugin in Figma
2. Open plugin → Settings → Add new sync provider → **GitHub**
3. Configure:
   - Repository: `zyra-project/interactive-sphere`
   - Branch: `main` (or feature branch for testing)
   - Token file path: `tokens/tokens.json`
   - Personal access token: (a GitHub PAT with `repo` scope)
4. Pull tokens → verify all values appear in the plugin
5. Create a Figma variable collection from the tokens (plugin can do
   this automatically)
6. Set up modes: "Default" and "Mobile Native"

### Phase 4: CI validation (optional)

Add a CI check that ensures `tokens.css` stays in sync with
`tokens.json`. This prevents drift if someone edits the CSS directly.

**Tasks:**
- [ ] Add a GitHub Actions step: run `npm run tokens`, then
      `git diff --exit-code src/styles/tokens.css`
- [ ] If the diff is non-empty, the check fails with a message:
      "tokens.css is out of sync — run `npm run tokens` and commit"

## File Changes Summary

| Action | Path | Description |
|---|---|---|
| Create | `tokens/tokens.json` | W3C Design Tokens — all values from `tokens.css` |
| Create | `tokens/style-dictionary.config.mjs` | Style Dictionary build config |
| Create | `tokens/$metadata.json` | Tokens Studio metadata (modes, collections) |
| Create | `tokens/$themes.json` | Tokens Studio theme definitions |
| Modify | `src/styles/tokens.css` | Now **generated** — add header comment noting this |
| Modify | `package.json` | Add `style-dictionary` devDep + `tokens` script |
| Modify | `.gitignore` | (no change — `tokens.css` stays tracked since it's the build output) |

## Dependencies

| Package | Version | Purpose | Cost |
|---|---|---|---|
| `style-dictionary` | `^4.0.0` | Token → CSS build | Free (Apache 2.0) |
| Tokens Studio plugin | latest | Figma ↔ Git sync | Free tier |
| Figma | Free or Pro | Design tool | Free for 1 mode; $15/mo/editor for 4 modes |

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Generated `tokens.css` drifts from hand-edited version | Broken styles | Phase 2 validation: diff generated vs. current before switching over |
| `rgba()` values don't round-trip perfectly through Figma | Slight color shifts | Pin exact values in `tokens.json`; Tokens Studio preserves raw values |
| Composite tokens (`--glass-border`) can't be expressed in W3C format | Manual maintenance | Keep composites as a hand-written appendix in the generated file, or use Style Dictionary references |
| `env()` safe-area tokens are runtime-only | Can't be in JSON | Append as static lines via a custom Style Dictionary format |
| Developer edits `tokens.css` directly instead of `tokens.json` | Changes overwritten on next build | CI check (Phase 4) catches this; header comment warns "DO NOT EDIT — generated from tokens.json" |

## Open Questions

1. **Should `tokens.css` be gitignored?** Keeping it tracked means the
   build works without running `npm run tokens` first (simpler for
   contributors). The CI check in Phase 4 prevents drift.
2. **Spacing tokens** — currently commented out in `tokens.css`. Should
   Phase 1 include them as active tokens or leave them reserved?
3. **Figma plan** — if the team needs all 4 platform modes as native
   Figma variable modes, the Professional plan ($15/mo/editor) is
   required. Otherwise, Tokens Studio's own mode UI works on free.
