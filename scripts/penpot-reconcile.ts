/**
 * scripts/penpot-reconcile.ts — the one reconcile / normalize step for
 * the reverse design-sync (Penpot → repo).
 *
 * This is the channel-agnostic core described in
 * `docs/DESIGN_SYNC_PLAN.md` §2 ("Two channels, one reconcile"). Both
 * the MCP exporter (channel A, `read-penpot.ts`) and Penpot's native
 * Tokens → Export (channel B) produce *some* Tokens-Studio-shaped token
 * graph; this module folds that graph back onto the canonical repo JSON
 * shape so a no-op sync produces an empty diff.
 *
 * Design choice — **overlay, don't reconstruct.** Token *structure*
 * (which tokens exist, their naming, their authored key order) is
 * repo-owned (§2 "Source of truth, per artifact"). So the reconcile
 * never rebuilds the W3C tree from a flat Penpot token list. It starts
 * from the current repo JSON as a template, deep-clones it, and overlays
 * only the round-trippable *values* read from Penpot. Three consequences
 * fall out for free:
 *
 *   1. Authored key order is preserved, so canonicalization is a no-op
 *      and the empty-diff acceptance gate (§2) is trivially correct.
 *   2. The round-trip-hostile set (`calc(...)`, `number`, composites)
 *      is *restored* rather than dropped — those values are simply never
 *      overlaid, so they keep their repo value (§1 "Round-trip-hostile
 *      tokens"). No special copy-back path is needed.
 *   3. Build-wrapping artifacts (`var(--ui-scale)`, `max(`, `blur(`)
 *      that live in `tokens/multi-mode-css.mjs` and never reach Penpot
 *      are asserted-against: if one appears in an exported value it is
 *      rejected with a warning instead of being written into a token.
 *
 * Mode inversion (§1 "Mode/theme inversion") is handled the same way:
 * a token's `$extensions["com.tokens-studio.modes"]` block is walked in
 * place, and each non-`default` override value is overlaid from the
 * matching `Modes/<TitleCase>` set. `default` mirrors the base `$value`.
 *
 * This module is pure (no fs, no git, no MCP) so it is unit-testable and
 * shared by both channels and by the advisory fidelity check
 * (`check-design-roundtrip.ts`).
 */

export interface PenpotToken {
  name: string
  type: string
  value: string
  description?: string
}

export interface PenpotSet {
  name: string
  tokens: PenpotToken[]
}

export interface PenpotTheme {
  group: string
  name: string
  activeSets: string[]
}

/** The shape `read-penpot.ts` returns from the live Penpot token graph. */
export interface PenpotGraph {
  file?: string | null
  sets: PenpotSet[]
  themes?: PenpotTheme[]
}

/** A repo token file paired with the Penpot base set it maps to. */
export interface RepoTokenFile {
  /** Human label / path, e.g. `tokens/components/playback.json`. */
  label: string
  /** Penpot base set name, e.g. `Global` or `Components/Playback`. */
  baseSetName: string
  /** Parsed W3C JSON — the structural template (repo-owned). */
  json: unknown
}

export interface ReconcileWarning {
  file: string
  /** Dotted token path, e.g. `component.chat.panel-width`. */
  path: string
  /** Mode key when the warning is about a mode override, else omitted. */
  mode?: string
  kind:
    | 'missing-in-export'
    | 'missing-mode-in-export'
    | 'build-artifact-rejected'
    | 'new-in-penpot'
  detail: string
}

export interface ReconcileFileResult {
  label: string
  baseSetName: string
  json: unknown
  warnings: ReconcileWarning[]
}

export interface ReconcileResult {
  files: ReconcileFileResult[]
  warnings: ReconcileWarning[]
}

export const MODES_EXT_KEY = 'com.tokens-studio.modes'

/** W3C `$type`s Penpot can faithfully store (and therefore round-trip). */
export const ROUND_TRIPPABLE_TYPES: ReadonlySet<string> = new Set([
  'color',
  'dimension',
  'fontWeight',
])

/**
 * CSS-build wrapping that lives in `tokens/multi-mode-css.mjs`, never in
 * a token, so it must never appear in an exported value. `calc(` is
 * intentionally *not* here — `calc` is a legitimate (if hostile) token
 * value handled by the round-trippable predicate; these three are pure
 * build artifacts.
 */
const BUILD_ARTIFACT_RE = /var\(\s*--ui-scale\s*\)|\bmax\s*\(|\bblur\s*\(/

export function isBuildArtifact(value: string): boolean {
  return BUILD_ARTIFACT_RE.test(value)
}

/**
 * A value round-trips iff its type is one Penpot stores AND the value is
 * not a `calc(...)` expression (Penpot's `addToken` rejects them) and is
 * not a leaked build artifact. `number` types (line-height, ui.scale)
 * fail the type check — Penpot has no unitless-number TokenType.
 */
export function isRoundTrippable(w3cType: unknown, value: unknown): boolean {
  if (typeof w3cType !== 'string' || !ROUND_TRIPPABLE_TYPES.has(w3cType)) return false
  if (typeof value !== 'string') return false
  if (value.includes('calc(')) return false
  if (isBuildArtifact(value)) return false
  return true
}

export function titleCaseHyphenated(key: string): string {
  return key
    .split('-')
    .map((part) => (part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join('-')
}

/** `tablet` → `Modes/Tablet`, mirroring `sync-penpot-modes.ts`. */
export function modeSetName(modeKey: string): string {
  return `Modes/${titleCaseHyphenated(modeKey)}`
}

interface W3CTokenLike {
  $value: unknown
  $type: unknown
  $extensions?: unknown
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function looksLikeW3CToken(node: Record<string, unknown>): node is W3CTokenLike & Record<string, unknown> {
  return '$value' in node && '$type' in node
}

/** Walk a W3C token tree, invoking `visit` on each leaf token node. */
function walkTokens(
  node: unknown,
  path: string[],
  visit: (node: W3CTokenLike & Record<string, unknown>, path: string[]) => void,
): void {
  if (!isPlainObject(node)) return
  if (looksLikeW3CToken(node)) {
    visit(node, path)
    return
  }
  for (const key of Object.keys(node)) {
    walkTokens(node[key], [...path, key], visit)
  }
}

/** Collect every dotted token name present in a repo file's tree. */
export function collectTokenNames(json: unknown): Set<string> {
  const names = new Set<string>()
  walkTokens(json, [], (_node, path) => names.add(path.join('.')))
  return names
}

/**
 * Reconcile one repo file against the Penpot graph: deep-clone the repo
 * JSON and overlay round-trippable values (base + mode overrides) read
 * from Penpot. Returns the reconciled JSON plus any warnings.
 */
export function reconcileFile(file: RepoTokenFile, graph: PenpotGraph): ReconcileFileResult {
  const warnings: ReconcileWarning[] = []
  const clone = structuredClone(file.json)
  const tokensBySet = new Map(
    graph.sets.map((s) => [s.name, new Map(s.tokens.map((t) => [t.name, t]))]),
  )
  const baseTokens = tokensBySet.get(file.baseSetName) ?? new Map<string, PenpotToken>()

  walkTokens(clone, [], (node, pathArr) => {
    const name = pathArr.join('.')
    const w3cType = node.$type

    // 1) Base $value overlay (only when round-trippable).
    if (isRoundTrippable(w3cType, node.$value)) {
      const exported = baseTokens.get(name)
      if (!exported) {
        warnings.push({
          file: file.label,
          path: name,
          kind: 'missing-in-export',
          detail: `token absent from Penpot set "${file.baseSetName}"; kept repo value`,
        })
      } else if (isBuildArtifact(exported.value)) {
        warnings.push({
          file: file.label,
          path: name,
          kind: 'build-artifact-rejected',
          detail: `exported value "${exported.value}" carries a build artifact; kept repo value`,
        })
      } else {
        node.$value = exported.value
      }
    }

    // 2) Mode overrides — re-overlay each non-default mode in place.
    const ext = node.$extensions
    if (isPlainObject(ext) && isPlainObject(ext[MODES_EXT_KEY])) {
      const modes = ext[MODES_EXT_KEY] as Record<string, unknown>
      for (const modeKey of Object.keys(modes)) {
        const repoVal = modes[modeKey]
        if (!isRoundTrippable(w3cType, repoVal)) continue // hostile mode value → keep repo
        if (modeKey === 'default') {
          // `default` mirrors the base value; overlay from the base set.
          const exported = baseTokens.get(name)
          if (exported && !isBuildArtifact(exported.value)) modes[modeKey] = exported.value
          continue
        }
        const setName = modeSetName(modeKey)
        const exported = tokensBySet.get(setName)?.get(name)
        if (!exported) {
          warnings.push({
            file: file.label,
            path: name,
            mode: modeKey,
            kind: 'missing-mode-in-export',
            detail: `override absent from Penpot set "${setName}"; kept repo value`,
          })
        } else if (isBuildArtifact(exported.value)) {
          warnings.push({
            file: file.label,
            path: name,
            mode: modeKey,
            kind: 'build-artifact-rejected',
            detail: `exported override "${exported.value}" carries a build artifact; kept repo value`,
          })
        } else {
          modes[modeKey] = exported.value
        }
      }
    }
  })

  return { label: file.label, baseSetName: file.baseSetName, json: clone, warnings }
}

/**
 * Reconcile the full set of repo files against the Penpot graph. Also
 * flags tokens present in Penpot but absent from the repo schema — the
 * schema is repo-owned, so a new Penpot token is surfaced, never
 * auto-added (§2 drift handling).
 */
export function reconcile(repoFiles: RepoTokenFile[], graph: PenpotGraph): ReconcileResult {
  const files = repoFiles.map((f) => reconcileFile(f, graph))
  const warnings: ReconcileWarning[] = files.flatMap((f) => f.warnings)

  // New-in-Penpot detection: any base/mode-set token whose name is in no
  // repo file is outside the repo schema. Mode sets legitimately repeat
  // base token names, so a single union of repo names is the right check.
  const repoNames = new Set<string>()
  for (const f of repoFiles) for (const n of collectTokenNames(f.json)) repoNames.add(n)

  const seenNew = new Set<string>()
  for (const set of graph.sets) {
    for (const tok of set.tokens) {
      if (repoNames.has(tok.name) || seenNew.has(tok.name)) continue
      seenNew.add(tok.name)
      warnings.push({
        file: '(schema)',
        path: tok.name,
        kind: 'new-in-penpot',
        detail: `token "${tok.name}" exists in Penpot set "${set.name}" but not in the repo schema; not auto-added`,
      })
    }
  }

  return { files, warnings: dedupeWarnings(warnings) }
}

function dedupeWarnings(warnings: ReconcileWarning[]): ReconcileWarning[] {
  const seen = new Set<string>()
  const out: ReconcileWarning[] = []
  for (const w of warnings) {
    const key = `${w.kind}|${w.file}|${w.path}|${w.mode ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(w)
  }
  return out
}
