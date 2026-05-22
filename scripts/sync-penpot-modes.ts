/**
 * scripts/sync-penpot-modes.ts — Penpot mode-override seeder.
 *
 * Third script in the Penpot bootstrap series, alongside
 * `sync-penpot-global.ts` and `sync-penpot-components.ts`. Reads
 * every W3C token in `tokens/global.json` + `tokens/components/*.json`
 * and emits the `com.tokens-studio.modes` overrides as additional
 * Penpot token sets, plus themes that activate the right set
 * combinations.
 *
 * Penpot has no native "mode" primitive on tokens — the convention
 * (Tokens Studio's, which Penpot's import format follows) is:
 *
 *   1. The base set holds the default value of every token.
 *   2. One additional set per non-default mode, holding **only**
 *      the tokens that have an override for that mode.
 *   3. A Theme that activates [base sets..., mode-override set] —
 *      since later sets in the active list win on name collision,
 *      the override values shadow the base values for tokens that
 *      have one.
 *
 * Modes seen in the JSON today:
 *   - `mobile-native`   (global only — radius.lg, radius.xl, touch.min)
 *   - `tablet`          (chat, playback, tools-menu)
 *   - `phone-portrait`  (browse, chat)
 *
 * Output sets:
 *   `Modes/Mobile-Native`, `Modes/Tablet`, `Modes/Phone-Portrait`
 *
 * Output themes (group "Default"):
 *   - "Default"        → Global + Components/*
 *   - "Tablet"         → above + Modes/Tablet
 *   - "Phone Portrait" → above + Modes/Tablet + Modes/Phone-Portrait
 *                        (mirrors the CSS cascade — phone-portrait
 *                        media query inherits any tablet-tier rule
 *                        unless explicitly overridden)
 *   - "Mobile Native"  → Global + Components/* + Modes/Mobile-Native
 *                        (separate axis from viewport modes — no
 *                        composition with tablet / phone-portrait)
 *
 * Type / value handling matches the components script:
 *   - W3C color/dimension/fontWeight → Penpot color/dimension/fontWeights
 *   - W3C number is skipped (no Penpot equivalent)
 *   - calc(...) values are skipped (Penpot's addToken rejects them)
 *
 * CLI:
 *   npx tsx scripts/sync-penpot-modes.ts            # print plugin code
 *   npx tsx scripts/sync-penpot-modes.ts --list     # print plan as JSON
 */

import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isInvokedAsScript } from './lib/cli.ts'

export type PenpotTokenType = 'color' | 'dimension' | 'fontWeights'

export interface ModeOverrideSpec {
  name: string
  type: PenpotTokenType
  value: string
}

export interface SkippedOverride {
  mode: string
  name: string
  reason: string
  file: string
}

export interface ModeSetPlan {
  /** Penpot set name, e.g. `Modes/Tablet`. */
  name: string
  /** Source mode key as it appears in the JSON, e.g. `tablet`. */
  modeKey: string
  specs: ModeOverrideSpec[]
}

export interface ThemePlan {
  /** Theme group — Penpot expects a string (may be empty). */
  group: string
  /** Theme name, e.g. `Default`, `Tablet`, `Phone Portrait`. */
  name: string
  /** Sets activated by this theme, in precedence order (later wins). */
  sets: string[]
}

export interface BuildModesResult {
  modeSets: ModeSetPlan[]
  themes: ThemePlan[]
  /** Names of base sets the themes assume already exist in Penpot. */
  baseSets: string[]
  skipped: SkippedOverride[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const GLOBAL_TOKENS_PATH = resolve(REPO_ROOT, 'tokens/global.json')
const COMPONENTS_DIR = resolve(REPO_ROOT, 'tokens/components')

const W3C_TO_PENPOT: Record<string, PenpotTokenType> = {
  color: 'color',
  dimension: 'dimension',
  fontWeight: 'fontWeights',
}

const TOKENS_STUDIO_MODES_KEY = 'com.tokens-studio.modes'

/** Theme group used in Penpot when adding the modes themes. */
export const THEME_GROUP = 'Default'

/**
 * Composition rules between modes — designers expect the Phone
 * Portrait theme to inherit any Tablet-tier override that isn't
 * itself overridden at the phone-portrait tier, mirroring the CSS
 * media-query cascade. Mobile Native is a separate axis (Tauri
 * mobile, not viewport breakpoint) and does not compose.
 *
 * Order matters — later entries win when a token is overridden in
 * more than one ancestor mode. The mode's own set always comes last.
 */
const MODE_COMPOSITION: Record<string, string[]> = {
  tablet: [],
  'phone-portrait': ['tablet'],
  'mobile-native': [],
}

const MODE_THEME_NAME: Record<string, string> = {
  tablet: 'Tablet',
  'phone-portrait': 'Phone Portrait',
  'mobile-native': 'Mobile Native',
}

const BASE_SETS = [
  'Global',
  'Components/Browse',
  'Components/Chat',
  'Components/Playback',
  'Components/Tools-Menu',
] as const

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

export function listSourceFiles(): string[] {
  const componentFiles = readdirSync(COMPONENTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => resolve(COMPONENTS_DIR, f))
  return [GLOBAL_TOKENS_PATH, ...componentFiles]
}

export function buildModeOverrides(files: string[] = listSourceFiles()): BuildModesResult {
  const overridesByMode = new Map<string, ModeOverrideSpec[]>()
  const skipped: SkippedOverride[] = []
  for (const file of files) {
    const json = readJson(file)
    walk(json, [], file, overridesByMode, skipped)
  }
  const modeSets: ModeSetPlan[] = [...overridesByMode.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([modeKey, specs]) => ({
      name: `Modes/${titleCaseModeKey(modeKey)}`,
      modeKey,
      specs: dedupeByName(specs),
    }))
  const themes = buildThemes(modeSets)
  return { modeSets, themes, baseSets: [...BASE_SETS], skipped }
}

function dedupeByName(specs: ModeOverrideSpec[]): ModeOverrideSpec[] {
  const seen = new Map<string, ModeOverrideSpec>()
  for (const s of specs) seen.set(s.name, s)
  return [...seen.values()]
}

function buildThemes(modeSets: ModeSetPlan[]): ThemePlan[] {
  const setNameByMode = new Map(modeSets.map((s) => [s.modeKey, s.name]))
  const themes: ThemePlan[] = [
    { group: THEME_GROUP, name: 'Default', sets: [...BASE_SETS] },
  ]
  for (const ms of modeSets) {
    const inheritedModes = MODE_COMPOSITION[ms.modeKey] ?? []
    const inheritedSets = inheritedModes
      .map((m) => setNameByMode.get(m))
      .filter((name): name is string => Boolean(name))
    themes.push({
      group: THEME_GROUP,
      name: MODE_THEME_NAME[ms.modeKey] ?? titleCaseModeKey(ms.modeKey),
      sets: [...BASE_SETS, ...inheritedSets, ms.name],
    })
  }
  return themes
}

function titleCaseModeKey(modeKey: string): string {
  return modeKey
    .split('-')
    .map((part) => (part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join('-')
}

interface W3CTokenLike {
  $value: unknown
  $type: unknown
  $extensions?: unknown
}

function walk(
  node: unknown,
  path: string[],
  file: string,
  overridesByMode: Map<string, ModeOverrideSpec[]>,
  skipped: SkippedOverride[],
) {
  if (!isPlainObject(node)) return
  if (looksLikeW3CToken(node)) {
    const joined = path.join('.')
    const w3cType = node.$type
    if (typeof w3cType !== 'string') return
    const penpotType = W3C_TO_PENPOT[w3cType]
    const modes = readModesExtension(node.$extensions)
    if (!modes) return
    for (const [modeKey, rawValue] of Object.entries(modes)) {
      if (modeKey === 'default') continue
      if (!penpotType) {
        skipped.push({ mode: modeKey, name: joined, reason: `unsupported $type "${w3cType}"`, file })
        continue
      }
      const value = typeof rawValue === 'number' ? String(rawValue) : rawValue
      if (typeof value !== 'string') {
        skipped.push({ mode: modeKey, name: joined, reason: 'non-string override value', file })
        continue
      }
      if (value.includes('calc(')) {
        skipped.push({
          mode: modeKey,
          name: joined,
          reason: `calc() expression not accepted by Penpot addToken (value=${value})`,
          file,
        })
        continue
      }
      const list = overridesByMode.get(modeKey) ?? []
      list.push({ name: joined, type: penpotType, value })
      overridesByMode.set(modeKey, list)
    }
    return
  }
  for (const key of Object.keys(node)) {
    walk(node[key], [...path, key], file, overridesByMode, skipped)
  }
}

function readModesExtension(ext: unknown): Record<string, unknown> | null {
  if (!isPlainObject(ext)) return null
  const modes = ext[TOKENS_STUDIO_MODES_KEY]
  return isPlainObject(modes) ? modes : null
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function looksLikeW3CToken(node: Record<string, unknown>): node is W3CTokenLike & Record<string, unknown> {
  return '$value' in node && '$type' in node
}

export function buildPluginCode(plan: BuildModesResult): string {
  const payload = JSON.stringify(
    { modeSets: plan.modeSets, themes: plan.themes, baseSets: plan.baseSets },
    null,
    2,
  )
  return `// Generated by scripts/sync-penpot-modes.ts — idempotent seed for the
// Penpot mode-override sets and themes. Run via the MCP execute_code tool
// against the TerraViz - Design System file.
const PLAN = ${payload};
const tokens = penpot.library.local.tokens;

const missingBaseSets = PLAN.baseSets.filter(name => !tokens.sets.find(s => s.name === name));
if (missingBaseSets.length > 0) {
  return { error: 'missing base sets — run sync-penpot-global and sync-penpot-components first', missingBaseSets };
}

// 1) Upsert mode-override sets. These are intentionally NOT toggled
//    active — Penpot themes will activate them. (Toggling a set's
//    active state directly puts Penpot into manual mode, disabling
//    all themes — see TokenTheme API doc.)
const setSummary = [];
for (const plan of PLAN.modeSets) {
  let set = tokens.sets.find(s => s.name === plan.name);
  if (!set) set = tokens.addSet({ name: plan.name });
  const existing = new Map(set.tokens.map(t => [t.name, t]));
  const created = [], updated = [], unchanged = [], typeMismatches = [];
  for (const spec of plan.specs) {
    let token;
    const prev = existing.get(spec.name);
    if (!prev) {
      token = set.addToken({ type: spec.type, name: spec.name, value: spec.value });
      created.push(spec.name);
    } else if (prev.type !== spec.type) {
      typeMismatches.push({ name: spec.name, want: spec.type, got: prev.type });
      continue;
    } else {
      token = prev;
      if (token.value !== spec.value) {
        token.value = spec.value;
        updated.push(spec.name);
      } else {
        unchanged.push(spec.name);
      }
    }
  }
  const specNames = new Set(plan.specs.map(s => s.name));
  const orphans = set.tokens.filter(t => !specNames.has(t.name)).map(t => t.name);
  setSummary.push({
    setName: plan.name,
    totals: {
      specs: plan.specs.length,
      created: created.length,
      updated: updated.length,
      unchanged: unchanged.length,
      orphans: orphans.length,
      typeMismatches: typeMismatches.length,
    },
    created, updated, unchanged, orphans, typeMismatches,
  });
}

// 2) Upsert themes. The Penpot plugin API on this Penpot version
//    accepts the full set list at theme-creation time
//    (\`addTheme({ group, name, sets: [name, ...] })\`) but rejects
//    every shape passed to \`theme.addSet(...)\` / \`theme.removeSet(...)\`
//    on already-existing themes (returns \"Field message is invalid\"
//    regardless of whether the argument is a TokenSet, an id, a name,
//    or a wrapper object). Until that mutator works, the idempotent
//    path is: if an existing theme's activeSets list doesn't match
//    the target, remove it and recreate from scratch with the right
//    sets array. Themes have no external references (designers pick
//    them by name in the Tokens panel), so recreate is observably
//    identical to in-place mutation.
const themeSummary = [];
const allSetNames = new Set(tokens.sets.map(s => s.name));
for (const t of PLAN.themes) {
  const missing = t.sets.filter(name => !allSetNames.has(name));
  if (missing.length > 0) {
    themeSummary.push({ themeName: \`\${t.group}/\${t.name}\`, action: 'skip', missing });
    continue;
  }
  const existing = tokens.themes.find(x => x.group === t.group && x.name === t.name);
  if (existing) {
    const current = existing.activeSets.map(s => s.name);
    const matches =
      current.length === t.sets.length &&
      current.every((n, i) => n === t.sets[i]);
    if (matches) {
      themeSummary.push({ themeName: \`\${t.group}/\${t.name}\`, action: 'unchanged', sets: t.sets });
      continue;
    }
    existing.remove();
  }
  tokens.addTheme({ group: t.group, name: t.name, sets: t.sets });
  themeSummary.push({
    themeName: \`\${t.group}/\${t.name}\`,
    action: existing ? 'recreated' : 'created',
    sets: t.sets,
  });
}

// 3) Activate the "Default" theme so the file has a coherent
//    designer-facing state. Toggling a theme active will deactivate
//    any other theme in the same group automatically. Skipped if
//    Default is already active or doesn't exist.
const defaultTheme = tokens.themes.find(t => t.group === 'Default' && t.name === 'Default');
const defaultActivated = !!(defaultTheme && !defaultTheme.active && (defaultTheme.toggleActive(), true));

return { setSummary, themeSummary, defaultActivated };
`
}

if (isInvokedAsScript(import.meta.url)) {
  const arg = process.argv[2]
  const result = buildModeOverrides()
  for (const s of result.skipped) {
    process.stderr.write(
      `[sync-penpot-modes] skipped ${basename(s.file)}:${s.name} (${s.mode}): ${s.reason}\n`,
    )
  }
  if (arg === '--list') {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } else if (arg && arg !== '--code') {
    process.stderr.write(`unknown arg: ${arg}\nusage: sync-penpot-modes.ts [--code | --list]\n`)
    process.exit(2)
  } else {
    process.stdout.write(buildPluginCode(result))
  }
}
