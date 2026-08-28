// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * scripts/sync-penpot-components.ts — Penpot component token-set seeder.
 *
 * Sibling to `sync-penpot-global.ts` for the per-component JSONs in
 * `tokens/components/`. Reads each file, walks the W3C tree, and
 * emits a single self-contained JS string ready for the Penpot MCP
 * `execute_code` tool. Running it idempotently upserts one token
 * set per component file:
 *
 *   tokens/components/browse.json     → set "Components/Browse"
 *   tokens/components/chat.json       → set "Components/Chat"
 *   tokens/components/playback.json   → set "Components/Playback"
 *   tokens/components/tools-menu.json → set "Components/Tools-Menu"
 *
 * Token names mirror the JSON path (e.g. `component.browse.panel-width`)
 * to line up with the CSS custom-property suffix Style Dictionary
 * already emits (`--component-browse-panel-width`).
 *
 * Type mapping (W3C $type → Penpot TokenType):
 *   color       → color
 *   dimension   → dimension
 *   fontWeight  → fontWeights
 *   number      → SKIPPED with stderr warning. Penpot's TokenType
 *                 enum has no unitless-number / line-height variant
 *                 (see Penpot API docs for `addToken`); the only such
 *                 token in the JSON is
 *                 `component.chat.msg-line-height = 1.55`.
 *
 * Value caveat: Penpot's `addToken` rejects CSS `calc(...)` expressions
 * with "Value not valid" — verified empirically against the design
 * system file. Such tokens are skipped with the same stderr warning.
 * The only calc value in the JSON is
 * `component.chat.panel-max-height = calc(100vh - 8rem)`; designers
 * can override it manually if needed, and the JSON keeps the canonical
 * value for Style Dictionary.
 *
 * Like the Global script, this pass intentionally seeds the default
 * `$value` only — `com.tokens-studio.modes` overrides are deferred
 * to a follow-up that wires Penpot themes.
 *
 * CLI:
 *   npx tsx scripts/sync-penpot-components.ts            # print plugin code
 *   npx tsx scripts/sync-penpot-components.ts --list     # print specs as JSON
 */

import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isInvokedAsScript } from './lib/cli.ts'

export type PenpotTokenType =
  | 'color'
  | 'dimension'
  | 'fontWeights'

export interface TokenSpec {
  name: string
  type: PenpotTokenType
  value: string
  description?: string
}

export interface TokenSetPlan {
  name: string
  specs: TokenSpec[]
}

export interface SkippedToken {
  file: string
  path: string
  reason: string
}

export interface BuildPlansResult {
  plans: TokenSetPlan[]
  skipped: SkippedToken[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const COMPONENTS_DIR = resolve(REPO_ROOT, 'tokens/components')

const W3C_TO_PENPOT: Record<string, PenpotTokenType> = {
  color: 'color',
  dimension: 'dimension',
  fontWeight: 'fontWeights',
}

export function listComponentFiles(dir: string = COMPONENTS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => resolve(dir, f))
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

export function buildComponentTokenSets(
  files: string[] = listComponentFiles(),
): BuildPlansResult {
  const plans: TokenSetPlan[] = []
  const skipped: SkippedToken[] = []
  for (const file of files) {
    const json = readJson(file)
    const stem = basename(file, '.json')
    const setName = componentSetName(stem)
    const specs: TokenSpec[] = []
    walk(json, [], specs, skipped, file)
    plans.push({ name: setName, specs })
  }
  return { plans, skipped }
}

function componentSetName(stem: string): string {
  const titled = stem
    .split('-')
    .map((part) => (part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join('-')
  return `Components/${titled}`
}

interface W3CTokenLike {
  $value: unknown
  $type: unknown
  $description?: unknown
}

function walk(
  node: unknown,
  path: string[],
  specs: TokenSpec[],
  skipped: SkippedToken[],
  file: string,
) {
  if (!isPlainObject(node)) return
  if (looksLikeW3CToken(node)) {
    const joined = path.join('.')
    const w3cType = node.$type
    if (typeof w3cType !== 'string') {
      skipped.push({ file, path: joined, reason: 'missing $type' })
      return
    }
    const penpotType = W3C_TO_PENPOT[w3cType]
    if (!penpotType) {
      skipped.push({ file, path: joined, reason: `unsupported $type "${w3cType}"` })
      return
    }
    const rawValue = node.$value
    const value = typeof rawValue === 'number' ? String(rawValue) : rawValue
    if (typeof value !== 'string') {
      skipped.push({ file, path: joined, reason: 'non-string $value' })
      return
    }
    if (value.includes('calc(')) {
      skipped.push({ file, path: joined, reason: `calc() expression not accepted by Penpot addToken (value=${value})` })
      return
    }
    const spec: TokenSpec = { name: joined, type: penpotType, value }
    if (typeof node.$description === 'string' && node.$description.length > 0) {
      spec.description = node.$description
    }
    specs.push(spec)
    return
  }
  for (const key of Object.keys(node)) {
    walk(node[key], [...path, key], specs, skipped, file)
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function looksLikeW3CToken(node: Record<string, unknown>): node is W3CTokenLike & Record<string, unknown> {
  return '$value' in node && '$type' in node
}

export function buildPluginCode(plans: TokenSetPlan[]): string {
  const payload = JSON.stringify({ plans }, null, 2)
  return `// Generated by scripts/sync-penpot-components.ts — idempotent seed for the
// Penpot "Components/*" token sets. Run via the MCP execute_code tool against
// the TerraViz - Design System file.
const PLAN = ${payload};
const tokens = penpot.library.local.tokens;
const summary = [];
for (const plan of PLAN.plans) {
  let set = tokens.sets.find(s => s.name === plan.name);
  if (!set) set = tokens.addSet({ name: plan.name });
  if (!set.active) set.toggleActive();
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
    const desc = spec.description || '';
    if ((token.description || '') !== desc) token.description = desc;
  }
  const specNames = new Set(plan.specs.map(s => s.name));
  const orphans = set.tokens.filter(t => !specNames.has(t.name)).map(t => t.name);
  summary.push({
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
return summary;
`
}

if (isInvokedAsScript(import.meta.url)) {
  const arg = process.argv[2]
  const { plans, skipped } = buildComponentTokenSets()
  for (const s of skipped) {
    process.stderr.write(
      `[sync-penpot-components] skipped ${basename(s.file)}:${s.path}: ${s.reason}\n`,
    )
  }
  if (arg === '--list') {
    process.stdout.write(JSON.stringify(plans, null, 2) + '\n')
  } else if (arg && arg !== '--code') {
    process.stderr.write(`unknown arg: ${arg}\nusage: sync-penpot-components.ts [--code | --list]\n`)
    process.exit(2)
  } else {
    process.stdout.write(buildPluginCode(plans))
  }
}
