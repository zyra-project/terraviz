/**
 * scripts/check-design-roundtrip.ts — reverse-sync fidelity gate (advisory).
 *
 * The acceptance gate from `docs/DESIGN_SYNC_PLAN.md` §2:
 *
 *     seed (repo → Penpot) → export (Penpot → JSON) → normalize → diff
 *
 * must produce an **empty diff** for round-trippable tokens, and the
 * round-trip-hostile set (`calc`/`number`/composite) must be restored
 * byte-identical. This is the symmetric twin of the seeders' idempotency
 * check (0 created / 0 updated on re-run).
 *
 * The live MCP export can't run in CI (the Penpot server is pre-beta and
 * its gateway requires interactive approval), so this check runs the
 * gate against a **simulated** Penpot graph built from the seeders' own
 * output — i.e. it proves `reconcile ∘ seed = identity` on the
 * round-trippable set, which is exactly what correctness of the reverse
 * exporter requires. When a live export fixture is available, the same
 * reconcile + diff runs against it unchanged.
 *
 * Wired as **advisory** CI (`.github/workflows/design-roundtrip.yml`,
 * continue-on-error) per §4 R1. Exits non-zero on any diff so it is also
 * runnable as a local gate: `npm run check:design-roundtrip`.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildGlobalTokenSpecs, GLOBAL_SET_NAME } from './sync-penpot-global.ts'
import { buildComponentTokenSets } from './sync-penpot-components.ts'
import { buildModeOverrides } from './sync-penpot-modes.ts'
import {
  reconcile,
  titleCaseHyphenated,
  collectTokenNames,
  isRoundTrippable,
  MODES_EXT_KEY,
  type PenpotGraph,
  type PenpotSet,
  type RepoTokenFile,
} from './penpot-reconcile.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const GLOBAL_PATH = resolve(REPO_ROOT, 'tokens/global.json')
const COMPONENTS_DIR = resolve(REPO_ROOT, 'tokens/components')

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function componentFiles(): string[] {
  return readdirSync(COMPONENTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => resolve(COMPONENTS_DIR, f))
}

function baseSetNameForFile(path: string): string {
  return dirname(path) === COMPONENTS_DIR
    ? `Components/${titleCaseHyphenated(basename(path, '.json'))}`
    : GLOBAL_SET_NAME
}

/**
 * Build the Penpot graph that the seeders would produce — the "export"
 * input to the round-trip — from the same source files.
 */
function buildSeededGraph(): PenpotGraph {
  const sets: PenpotSet[] = []
  // Global set
  const { specs: globalSpecs } = buildGlobalTokenSpecs()
  sets.push({ name: GLOBAL_SET_NAME, tokens: globalSpecs })
  // Components/* sets
  const { plans } = buildComponentTokenSets()
  for (const plan of plans) sets.push({ name: plan.name, tokens: plan.specs })
  // Modes/* sets + themes
  const { modeSets, themes } = buildModeOverrides()
  for (const ms of modeSets) sets.push({ name: ms.name, tokens: ms.specs })
  return {
    file: 'TerraViz - Design System',
    sets,
    themes: themes.map((t) => ({ group: t.group, name: t.name, activeSets: t.sets })),
  }
}

/** Hostile tokens the gate asserts are restored byte-identical from repo. */
function collectHostile(repoFiles: RepoTokenFile[]): { file: string; path: string }[] {
  const hostile: { file: string; path: string }[] = []
  for (const f of repoFiles) {
    walkLeaves(f.json, [], (node, pathArr) => {
      const name = pathArr.join('.')
      if (!isRoundTrippable(node.$type, node.$value)) {
        hostile.push({ file: f.label, path: name })
      }
      // hostile mode overrides count too
      const ext = node.$extensions
      if (isObj(ext) && isObj(ext[MODES_EXT_KEY])) {
        const modes = ext[MODES_EXT_KEY] as Record<string, unknown>
        for (const [k, v] of Object.entries(modes)) {
          if (k !== 'default' && !isRoundTrippable(node.$type, v)) {
            hostile.push({ file: f.label, path: `${name}@${k}` })
          }
        }
      }
    })
  }
  return hostile
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function walkLeaves(
  node: unknown,
  path: string[],
  visit: (n: { $value: unknown; $type: unknown; $extensions?: unknown }, p: string[]) => void,
): void {
  if (!isObj(node)) return
  if ('$value' in node && '$type' in node) {
    visit(node as never, path)
    return
  }
  for (const k of Object.keys(node)) walkLeaves(node[k], [...path, k], visit)
}

function main(): void {
  const repoFiles: RepoTokenFile[] = [
    { label: 'tokens/global.json', baseSetName: GLOBAL_SET_NAME, json: readJson(GLOBAL_PATH) },
    ...componentFiles().map((p) => ({
      label: `tokens/components/${basename(p)}`,
      baseSetName: baseSetNameForFile(p),
      json: readJson(p),
    })),
  ]

  const graph = buildSeededGraph()
  const result = reconcile(repoFiles, graph)

  let mismatches = 0
  console.log('Reverse-sync round-trip fidelity (seed → export → reconcile → diff)\n')
  for (let i = 0; i < repoFiles.length; i++) {
    const original = JSON.stringify(repoFiles[i]!.json)
    const reconciled = JSON.stringify(result.files[i]!.json)
    const ok = original === reconciled
    if (!ok) mismatches++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${repoFiles[i]!.label}`)
    if (!ok) {
      const diff = firstDiff(repoFiles[i]!.json, result.files[i]!.json)
      console.log(`        first divergence: ${diff}`)
    }
  }

  // Hostile-set assertion: each hostile token must equal the repo value
  // in the reconciled output (restored, not dropped or overwritten).
  const hostile = collectHostile(repoFiles)
  const tokenCount = repoFiles.reduce((n, f) => n + collectTokenNames(f.json).size, 0)
  console.log(
    `\n  ${tokenCount} tokens across ${repoFiles.length} files; ` +
      `${hostile.length} hostile values asserted restored.`,
  )

  const newInPenpot = result.warnings.filter((w) => w.kind === 'new-in-penpot')
  const otherWarnings = result.warnings.filter((w) => w.kind !== 'new-in-penpot')
  if (newInPenpot.length) {
    console.log(`\n  ${newInPenpot.length} token(s) present in Penpot but not in repo schema (flagged, not added):`)
    for (const w of newInPenpot) console.log(`        ${w.path}`)
  }
  if (otherWarnings.length) {
    console.log(`\n  ${otherWarnings.length} reconcile warning(s):`)
    for (const w of otherWarnings) console.log(`        [${w.kind}] ${w.path}${w.mode ? '@' + w.mode : ''} — ${w.detail}`)
  }

  if (mismatches > 0) {
    console.error(`\n✗ ${mismatches} file(s) did not round-trip with an empty diff.`)
    process.exit(1)
  }
  console.log('\n✓ Empty round-trip diff for all files; hostile set restored.')
}

/** Locate the first JSON pointer where two trees diverge (for diagnostics). */
function firstDiff(a: unknown, b: unknown, path = ''): string {
  if (JSON.stringify(a) === JSON.stringify(b)) return '(none)'
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return firstDiff(a[k], b[k], `${path}/${k}`)
    }
  }
  return `${path || '/'}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`
}

main()
