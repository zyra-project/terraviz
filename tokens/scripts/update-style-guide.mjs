#!/usr/bin/env node

/**
 * update-style-guide.mjs
 *
 * Reads tokens/global.json and tokens/components/*.json, generates
 * markdown tables, and injects them between marker comments in
 * STYLE_GUIDE.md. Everything outside the markers is preserved.
 *
 * Marker format:
 *   <!-- tokens:auto:{section} -->
 *   ...generated content...
 *   <!-- /tokens:auto:{section} -->
 *
 * Usage: node tokens/scripts/update-style-guide.mjs
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';

const ROOT = join(import.meta.dirname, '..', '..');
const STYLE_GUIDE = join(ROOT, 'STYLE_GUIDE.md');
const GLOBAL_TOKENS = join(ROOT, 'tokens', 'global.json');
const COMPONENTS_DIR = join(ROOT, 'tokens', 'components');

// ── Helpers ─────────────────────────────────────────────────────────

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/** Flatten a nested token object into [path, token] pairs. */
function flattenTokens(obj, prefix = []) {
  const entries = [];
  for (const [key, val] of Object.entries(obj)) {
    if (val.$value !== undefined || val.$type !== undefined) {
      entries.push([prefix.concat(key), val]);
    } else if (typeof val === 'object' && val !== null) {
      entries.push(...flattenTokens(val, prefix.concat(key)));
    }
  }
  return entries;
}

/** Get the default mode value for display. */
function displayValue(token) {
  return token.$value;
}

/** Get a mode override value, or '—' if none. */
function modeValue(token, mode) {
  const modes = token.$extensions?.['com.tokens-studio.modes'];
  if (!modes || modes[mode] === undefined) return '—';
  return modes[mode];
}

/** Check if any token in a list has a given mode. */
function hasMode(tokens, mode) {
  return tokens.some(([, t]) => {
    const modes = t.$extensions?.['com.tokens-studio.modes'];
    return modes && modes[mode] !== undefined;
  });
}

// ── Section Generators ──────────────────────────────────────────────

function generateGlass(global) {
  const glass = global.glass;
  const lines = [
    '```css',
    `background: ${glass.bg.$value};`,
    `backdrop-filter: blur(${glass.blur.$value});`,
    `-webkit-backdrop-filter: blur(${glass.blur.$value});`,
    `border: 1px solid rgba(255, 255, 255, 0.08); /* --color-surface-border-subtle */`,
    `border-radius: 6px;               /* --radius-md; 8px (--radius-lg) for larger panels */`,
    '```',
  ];
  return lines.join('\n');
}

function generateColors(global) {
  const lines = [
    '| Token | Value | Usage |',
    '|---|---|---|',
  ];

  // Color tokens
  const colorTokens = flattenTokens({ color: global.color });
  for (const [path, token] of colorTokens) {
    const name = `\`--${path.join('-')}\``;
    const val = `\`${displayValue(token)}\``;
    const desc = token.$description || '';
    lines.push(`| ${name} | ${val} | ${desc} |`);
  }

  // Glass tokens
  lines.push(`| \`--glass-bg\` | \`${global.glass.bg.$value}\` | ${global.glass.bg.$description || 'Glass panel background'} |`);
  lines.push(`| \`--glass-bg-light\` | \`${global.glass['bg-light'].$value}\` | ${global.glass['bg-light'].$description || 'Glass panel background — lighter'} |`);
  lines.push(`| \`--glass-blur\` | \`${global.glass.blur.$value}\` | ${global.glass.blur.$description || 'Backdrop blur radius'} |`);

  return lines.join('\n');
}

function generateRadii(global) {
  const radii = flattenTokens({ radius: global.radius });
  const hasMobile = hasMode(radii, 'mobile-native');

  const header = hasMobile
    ? '| Token | Default | Mobile Native |\n|---|---|---|'
    : '| Token | Value |\n|---|---|';

  const lines = [header];
  for (const [path, token] of radii) {
    const name = `\`--${path.join('-')}\``;
    const val = `\`${displayValue(token)}\``;
    if (hasMobile) {
      const mobile = `\`${modeValue(token, 'mobile-native')}\``;
      lines.push(`| ${name} | ${val} | ${mobile} |`);
    } else {
      lines.push(`| ${name} | ${val} |`);
    }
  }
  return lines.join('\n');
}

function generateComponents() {
  let files;
  try {
    files = readdirSync(COMPONENTS_DIR).filter(f => f.endsWith('.json')).sort();
  } catch {
    return '*No component token files found.*';
  }

  if (files.length === 0) return '*No component token files found.*';

  const sections = [];

  for (const file of files) {
    const data = readJSON(join(COMPONENTS_DIR, file));
    const compName = basename(file, '.json');
    const tokens = flattenTokens(data);

    if (tokens.length === 0) continue;

    // Determine which modes exist for this component
    const modes = ['tablet', 'phone-portrait', 'mobile-native'];
    const activeModes = modes.filter(m => hasMode(tokens, m));

    // Build header
    const headerCols = ['Token', 'Default', ...activeModes.map(m =>
      m === 'tablet' ? 'Tablet (≤768px)' :
      m === 'phone-portrait' ? 'Phone Portrait' :
      'Mobile Native'
    )];

    const lines = [
      `### ${compName.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}`,
      '',
      `| ${headerCols.join(' | ')} |`,
      `|${headerCols.map(() => '---').join('|')}|`,
    ];

    for (const [path, token] of tokens) {
      // Skip the 'component.{name}' prefix for display
      const propName = path.slice(2).join('-');
      const name = `\`--component-${compName}-${propName}\``;
      const val = `\`${displayValue(token)}\``;
      const modeCols = activeModes.map(m => `\`${modeValue(token, m)}\``);
      lines.push(`| ${name} | ${val} | ${modeCols.join(' | ')} |`);
    }

    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}

// ── Injection ───────────────────────────────────────────────────────

const generators = {
  glass: () => generateGlass(readJSON(GLOBAL_TOKENS)),
  colors: () => generateColors(readJSON(GLOBAL_TOKENS)),
  radii: () => generateRadii(readJSON(GLOBAL_TOKENS)),
  components: () => generateComponents(),
};

let content = readFileSync(STYLE_GUIDE, 'utf-8');
let replacements = 0;

for (const [section, generate] of Object.entries(generators)) {
  const open = `<!-- tokens:auto:${section} -->`;
  const close = `<!-- /tokens:auto:${section} -->`;
  const openIdx = content.indexOf(open);
  const closeIdx = content.indexOf(close);

  if (openIdx === -1 || closeIdx === -1) {
    console.warn(`Warning: markers for "${section}" not found in STYLE_GUIDE.md — skipping`);
    continue;
  }

  const before = content.slice(0, openIdx + open.length);
  const after = content.slice(closeIdx);
  const generated = generate();

  content = before + '\n' + generated + '\n' + after;
  replacements++;
}

writeFileSync(STYLE_GUIDE, content, 'utf-8');
console.log(`Updated ${replacements} section(s) in STYLE_GUIDE.md`);
