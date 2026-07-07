/**
 * Custom Style Dictionary format: multi-mode-css
 *
 * Generates a single CSS file with:
 *   :root { }           — all default-mode tokens
 *   .mobile-native { }  — tokens with mobile-native overrides
 *
 * Reads `com.tokens-studio.modes` from each token's $extensions
 * to determine which modes a token participates in and what
 * override value to use.
 *
 * Also appends static entries that can't be expressed in JSON
 * (composite glass-border, env() safe-area insets, commented
 * spacing scale, and .mobile-native interactive element rules).
 */

/**
 * Map a token path like ['color', 'accent-hover'] to the CSS
 * custom property name used in the existing tokens.css.
 *
 * Naming rules (must match what the codebase already uses):
 *   color.*              → --color-{name}
 *   glass.*              → --glass-{name}
 *   radius.*             → --radius-{name}
 *   touch.*              → --touch-{name}
 *   accent-opacity.*     → --accent-{name}   (e.g. --accent-o05)
 *   white-opacity.*      → --white-{name}    (e.g. --white-o05)
 *   component.{c}.{p}   → --component-{c}-{p}
 */
function tokenToCSSName(token) {
  const path = token.path;

  if (path[0] === 'color') {
    return `--color-${path.slice(1).join('-')}`;
  }
  if (path[0] === 'glass') {
    return `--glass-${path.slice(1).join('-')}`;
  }
  if (path[0] === 'radius') {
    return `--radius-${path.slice(1).join('-')}`;
  }
  if (path[0] === 'touch') {
    return `--touch-${path.slice(1).join('-')}`;
  }
  if (path[0] === 'accent-opacity') {
    return `--accent-${path.slice(1).join('-')}`;
  }
  if (path[0] === 'white-opacity') {
    return `--white-${path.slice(1).join('-')}`;
  }
  if (path[0] === 'component') {
    return `--component-${path.slice(1).join('-')}`;
  }

  // Fallback
  return `--${path.join('-')}`;
}

/**
 * Get the value for a specific mode from a token, or null if
 * the token doesn't participate in that mode.
 */
function getModeValue(token, mode) {
  const modes = token.$extensions?.['com.tokens-studio.modes'];
  if (!modes) return null;
  return modes[mode] ?? null;
}

/**
 * The standard touch-target sizes (Apple HIG / WCAG). Tokens whose
 * value is one of these get a `max(BASE, calc(BASE * scale))`
 * wrapper instead of plain `calc(...)` so Compact (0.85) can't
 * shrink them below the accessibility minimum. Comfortable (1.5)
 * still grows them.
 */
const TOUCH_TARGET_PX = new Set([40, 44, 48]);

function isTouchTargetValue(value) {
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)px$/);
  if (!match) return false;
  return TOUCH_TARGET_PX.has(Number(match[1]));
}

/**
 * Wrap every Nrem / Npx number in a token value with
 * `calc(... * var(--ui-scale))` so every dimension token honours
 * the user-controlled UI-scale knob (§7.1). Numbers equal to zero
 * are skipped (0 * anything = 0). Decorative 1px / 2px hairlines
 * have no token-level escape today; if one is added later, opt it
 * out of this wrap explicitly.
 *
 * When `floor === true`, the wrap becomes `max(BASE, calc(BASE *
 * scale))` so the value cannot drop below the base — used for
 * touch-target tokens so Compact users still meet the 44 / 48 px
 * tap-target minimums.
 */
function wrapDimensionsWithUiScale(value, floor = false) {
  return String(value).replace(
    /(?<![\w.-])(-?\d+(?:\.\d+)?)(rem|px)\b/g,
    (match, num, unit) => {
      const n = Number(num);
      if (!Number.isFinite(n) || n === 0) return match;
      const scaled = `calc(${num}${unit} * var(--ui-scale))`;
      if (floor) return `max(${num}${unit}, ${scaled})`;
      return scaled;
    },
  );
}

/**
 * Format a CSS value. Special cases:
 *   - `--glass-blur` wraps the px value inside a blur() function
 *     filter, since the CSS custom property is consumed as the
 *     argument to backdrop-filter / filter.
 *   - `--ui-scale` is the scale knob itself; it must not wrap its
 *     own value (would self-reference) and stays unitless.
 *   - Touch-target tokens (names prefixed `--touch-`, or values
 *     equal to one of the WCAG touch sizes) get the floored
 *     wrapper so the accessibility minimum survives Compact.
 *   - Every other token routes rem/px values through the
 *     UI-scale calc wrapper so var(--component-foo) sites scale
 *     automatically.
 */
function formatCSSValue(name, value) {
  if (name === '--ui-scale') {
    return value;
  }
  const floor = name.startsWith('--touch-') || isTouchTargetValue(value);
  const scaled = wrapDimensionsWithUiScale(value, floor);
  if (name === '--glass-blur') {
    return `blur(${scaled})`;
  }
  return scaled;
}

export default {
  name: 'custom/multi-mode-css',
  format: ({ dictionary }) => {
    const allTokens = dictionary.allTokens;

    // Partition tokens into default values and mode overrides
    const defaultEntries = [];
    const mobileNativeEntries = [];
    const tabletEntries = [];
    const phonePortraitEntries = [];

    for (const token of allTokens) {
      const name = tokenToCSSName(token);
      const defaultValue = token.$value ?? token.value;

      defaultEntries.push({ name, value: formatCSSValue(name, defaultValue) });

      // Check for mode overrides
      const mobileValue = getModeValue(token, 'mobile-native');
      if (mobileValue != null) {
        mobileNativeEntries.push({ name, value: formatCSSValue(name, mobileValue) });
      }

      const tabletValue = getModeValue(token, 'tablet');
      if (tabletValue != null) {
        tabletEntries.push({ name, value: formatCSSValue(name, tabletValue) });
      }

      const phoneValue = getModeValue(token, 'phone-portrait');
      if (phoneValue != null) {
        phonePortraitEntries.push({ name, value: formatCSSValue(name, phoneValue) });
      }
    }

    // Build CSS output
    const lines = [];

    lines.push('/**');
    lines.push(' * Design Tokens — DO NOT EDIT');
    lines.push(' *');
    lines.push(' * Generated by Style Dictionary from tokens/*.json');
    lines.push(' * Run `npm run tokens` to regenerate.');
    lines.push(' *');
    lines.push(' * Usage: `color: var(--color-accent);` or `border-radius: var(--radius-md);`');
    lines.push(' */');
    lines.push('');

    // :root block
    lines.push(':root {');

    let prevCategory = '';
    for (const entry of defaultEntries) {
      const category = entry.name.replace(/^--/, '').split('-')[0];
      if (category !== prevCategory && prevCategory !== '') {
        lines.push('');
      }
      prevCategory = category;
      lines.push(`  ${entry.name}: ${entry.value};`);
    }

    // Composite tokens that can't be expressed in JSON
    lines.push('');
    lines.push('  /* ── Composite (hand-maintained) ───────────────────────────────── */');
    lines.push('  --glass-border: 1px solid var(--color-surface-border-subtle);');
    lines.push('');
    lines.push('  /* ── Typography (publisher redesign — sans chrome, mono data) ───── */');
    lines.push("  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;");
    lines.push("  --font-mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;");
    lines.push('');
    lines.push('  /* Type scale — dense, rem-based (base 0.75rem). */');
    lines.push('  --text-2xs:  0.6rem;');
    lines.push('  --text-xs:   0.65rem;');
    lines.push('  --text-sm:   0.7rem;');
    lines.push('  --text-base: 0.75rem;');
    lines.push('  --text-md:   0.8rem;');
    lines.push('  --text-lg:   0.875rem;');
    lines.push('  --text-xl:   1rem;');
    lines.push('  --text-2xl:  1.4rem;');
    lines.push('  --text-3xl:  2rem;');
    lines.push('');
    lines.push('  /* ── Spacing — dense, rem-based ─────────────────────────────────── */');
    lines.push('  --space-2xs:  0.2rem;');
    lines.push('  --space-xs:   0.25rem;');
    lines.push('  --space-sm:   0.4rem;');
    lines.push('  --space-md:   0.5rem;');
    lines.push('  --space-lg:   0.75rem;');
    lines.push('  --space-xl:   1rem;');
    lines.push('  --space-2xl:  1.5rem;');
    lines.push('  --space-edge: 0.75rem;');
    lines.push('');
    lines.push('  /* ── Safe Area (runtime-only — env() values) ────────────────────── */');
    lines.push('  --safe-top: env(safe-area-inset-top, 0px);');
    lines.push('  --safe-bottom: env(safe-area-inset-bottom, 0px);');
    lines.push('  --safe-left: env(safe-area-inset-left, 0px);');
    lines.push('  --safe-right: env(safe-area-inset-right, 0px);');

    lines.push('}');

    // .mobile-native overrides
    if (mobileNativeEntries.length > 0) {
      lines.push('');
      lines.push('/* ── Mobile-native overrides ──────────────────────────────────────── */');
      lines.push('/* Applied when the Tauri mobile app sets .mobile-native on <body>.');
      lines.push('   Bumps touch targets and adjusts spacing for finger-friendly UX. */');
      lines.push('');
      lines.push('.mobile-native {');
      for (const entry of mobileNativeEntries) {
        lines.push(`  ${entry.name}: ${entry.value};`);
      }
      lines.push('}');

      // Interactive element touch target rules
      lines.push('');
      lines.push('/* Apply touch target minimums to interactive elements on mobile */');
      lines.push('.mobile-native button,');
      lines.push('.mobile-native [role="button"],');
      lines.push('.mobile-native select,');
      lines.push('.mobile-native input[type="checkbox"],');
      lines.push('.mobile-native .transport-btn,');
      lines.push('.mobile-native .chat-action-btn {');
      lines.push('  min-width: var(--touch-min);');
      lines.push('  min-height: var(--touch-min);');
      lines.push('}');
    }

    // Tablet overrides
    if (tabletEntries.length > 0) {
      lines.push('');
      lines.push('/* ── Tablet overrides (≤768px) ────────────────────────────────────── */');
      lines.push('');
      lines.push('@media (max-width: 768px) {');
      lines.push('  :root {');
      for (const entry of tabletEntries) {
        lines.push(`    ${entry.name}: ${entry.value};`);
      }
      lines.push('  }');
      lines.push('}');
    }

    // Phone portrait overrides
    if (phonePortraitEntries.length > 0) {
      lines.push('');
      lines.push('/* ── Phone portrait overrides (≤600px + portrait) ──────────────────── */');
      lines.push('');
      lines.push('@media (max-width: 600px) and (orientation: portrait) {');
      lines.push('  :root {');
      for (const entry of phonePortraitEntries) {
        lines.push(`    ${entry.name}: ${entry.value};`);
      }
      lines.push('  }');
      lines.push('}');
    }

    lines.push('');

    return lines.join('\n');
  },
};
