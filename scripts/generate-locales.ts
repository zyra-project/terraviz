/**
 * Generate `src/i18n/messages.ts` (+ one `messages.<locale>.ts` per
 * non-source locale) from `locales/*.json`, AND rewrite each
 * `locales/*.json` in canonical form on every run.
 *
 * Mirrors `scripts/build-privacy-page.ts`:
 *   - Validates each locale against the project's flat-string schema
 *     (key regex `^[a-z][a-zA-Z0-9.]*$`, value must be a string,
 *     forbidden-pattern gate for script-class HTML). This codegen
 *     is the canonical validator — there is no separate
 *     JSON-Schema file to keep in sync.
 *   - Diffs every non-source locale against `en.json`. Missing-in-
 *     target = warn. Extra-in-target = fail. Missing-in-source = fail.
 *   - Canonicalizes each `locales/*.json` to the exact format
 *     Weblate's GitHub bridge writes (2-space indent, LF, trailing
 *     newline, no interior blank lines, keys sorted alphabetically,
 *     literal Unicode). This makes the codegen the canonical
 *     formatter: predev/prebuild normalize whatever a developer
 *     typed, so Weblate's PR against main never has whitespace-only
 *     drift, and `--check` mode in CI catches anyone who edits a
 *     locale without running the codegen.
 *   - Emits deterministic TypeScript so `--check` mode (CI) can byte-
 *     compare on-disk generated files against a fresh render.
 *
 * Runs in `postinstall`, `predev`, `prebuild`, and `type-check`. The
 * generated TS files are gitignored next to `src/styles/tokens.css`;
 * the canonicalized JSON files ARE checked in.
 *
 * See `docs/I18N_PLAN.md`.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, basename, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const REPO_ROOT = resolve(HERE, '..')
const LOCALES_DIR = resolve(REPO_ROOT, 'locales')
const OUTPUT_DIR = resolve(REPO_ROOT, 'src/i18n')
const SOURCE_LOCALE = 'en'
const KEY_RE = /^[a-z][a-zA-Z0-9.]*$/

/** Native names for the language picker. Edit when adding a locale. */
const NATIVE_NAMES: Readonly<Record<string, string>> = {
  en: 'English',
  es: 'Español',
  kab: 'Taqbaylit',
  ar: 'العربية',
  et: 'Eesti',
}

/** Coverage threshold for picker visibility. Locales below this
 *  fraction translated stay reachable via `?lang=<code>` for
 *  testing but are hidden from the public language picker so
 *  visitors don't land on a half-empty UI by browser auto-detect.
 *  Matches the ≥80% gate documented in `docs/I18N_PLAN.md`. */
const PICKER_COVERAGE_THRESHOLD = 0.8

interface LocaleFile {
  readonly locale: string
  readonly path: string
  readonly messages: Readonly<Record<string, string>>
}

interface RenderResult {
  readonly path: string
  readonly contents: string
}

interface BuildOutput {
  readonly files: readonly RenderResult[]
  readonly warnings: readonly string[]
}

class LocaleBuildError extends Error {}

// ---- Pure functions (exported for testing) ─────────────────────────

/** Patterns that must not appear in any locale value. Translator
 *  input arrives via Weblate (untrusted) and gets injected into
 *  innerHTML in a few places (notably the help-guide section
 *  blobs). The runtime sanitizer in `src/ui/sanitizeHtml.ts` is
 *  the primary defense; this is a build-time tripwire that fails
 *  CI on the obvious script-class hostile substrings before they
 *  ever ship. Pairs with `validateLocale` so any drift in the
 *  threat model gets caught here, with a clear error message
 *  pointing at the offending key. */
const FORBIDDEN_VALUE_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: '<script>', re: /<\s*script\b/i },
  { name: '<iframe>', re: /<\s*iframe\b/i },
  { name: '<object>', re: /<\s*object\b/i },
  { name: '<embed>', re: /<\s*embed\b/i },
  { name: '<form>', re: /<\s*form\b/i },
  { name: '<style>', re: /<\s*style\b/i },
  { name: 'inline event handler (onfoo=)', re: /\son[a-z]+\s*=/i },
  { name: 'javascript: URL', re: /javascript\s*:/i },
  { name: 'vbscript: URL', re: /vbscript\s*:/i },
  // data: URLs can carry text/html — block in locale strings (the
  // app uses base64 image data URIs at the dataset layer, not in
  // copy). If a future locale needs to embed an image, it should
  // use a normal http(s) URL through the runtime sanitizer.
  { name: 'data: URL', re: /\bdata\s*:[a-z/+]*[;,]/i },
]

/**
 * Validate one parsed locale object against the schema rules. Throws
 * `LocaleBuildError` on the first violation; the message names the
 * locale and the offending key.
 */
export function validateLocale(
  locale: string,
  parsed: unknown,
): asserts parsed is Record<string, string> {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    // Spell out `null` separately because `typeof null === 'object'`,
    // which would otherwise produce a misleading `got object` message.
    const got = parsed === null
      ? 'null'
      : Array.isArray(parsed)
        ? 'array'
        : typeof parsed
    throw new LocaleBuildError(
      `[locales] ${locale}.json must be a JSON object, got ${got}`,
    )
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!KEY_RE.test(key)) {
      throw new LocaleBuildError(
        `[locales] ${locale}.json: key "${key}" violates ${KEY_RE.source}`,
      )
    }
    if (typeof value !== 'string') {
      throw new LocaleBuildError(
        `[locales] ${locale}.json: value for "${key}" must be a string, got ${typeof value}`,
      )
    }
    for (const { name, re } of FORBIDDEN_VALUE_PATTERNS) {
      if (re.test(value)) {
        throw new LocaleBuildError(
          `[locales] ${locale}.json: value for "${key}" contains forbidden pattern (${name}). ` +
          `Translator input flows into innerHTML in a few places; script-class HTML is rejected at build time.`,
        )
      }
    }
  }
}

/**
 * Diff a non-source locale against the source. Missing in target =
 * warning (translation pending). Extra in target = error (orphan
 * key). Missing in source via this locale = error (handled separately
 * by re-checking each locale against the union of all keys).
 */
export function diffAgainstSource(
  locale: string,
  source: Readonly<Record<string, string>>,
  target: Readonly<Record<string, string>>,
): { warnings: string[]; errors: string[] } {
  const warnings: string[] = []
  const errors: string[] = []
  const sourceKeys = new Set(Object.keys(source))
  const targetKeys = new Set(Object.keys(target))
  for (const key of sourceKeys) {
    if (!targetKeys.has(key)) {
      warnings.push(`[locales] ${locale}.json: missing translation for "${key}"`)
    }
  }
  for (const key of targetKeys) {
    if (!sourceKeys.has(key)) {
      errors.push(
        `[locales] ${locale}.json: orphan key "${key}" not in en.json — add it to en.json first`,
      )
    }
  }
  return { warnings, errors }
}

/**
 * Canonicalize a locale JSON file. Exported so tests can lock the
 * exact format. Matches Weblate's GitHub-bridge output verbatim:
 *
 *   - 2-space indent
 *   - LF line endings, trailing newline
 *   - No interior blank lines (Weblate strips them on round-trip,
 *     which is the source of every whitespace-churn diff we've
 *     seen against main)
 *   - Keys sorted alphabetically to match Weblate's "Sort JSON
 *     keys" component setting
 *   - Literal Unicode for BMP characters (`JSON.stringify` only
 *     escapes control chars and unpaired surrogates, which matches
 *     Weblate)
 */
export function renderLocaleJson(
  messages: Readonly<Record<string, unknown>>,
): string {
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(messages).sort()) {
    sorted[k] = messages[k]
  }
  return JSON.stringify(sorted, null, 2) + '\n'
}

/** Render the per-locale `messages.<locale>.ts` file. */
export function renderLocaleModule(
  locale: string,
  messages: Readonly<Record<string, string>>,
): string {
  const sortedEntries = Object.keys(messages)
    .sort()
    .map((k) => [k, messages[k]] as const)
  const lines = [
    '// AUTO-GENERATED by scripts/generate-locales.ts. Do not edit directly.',
    `// Source: locales/${locale}.json`,
    '',
    'const messages = {',
    ...sortedEntries.map(
      ([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`,
    ),
    '} as const',
    '',
    'export default messages',
    '',
  ]
  return lines.join('\n')
}

/**
 * Render the entry `messages.ts` — re-exports English statically,
 * provides lazy loaders for all non-source locales, and emits the
 * `MessageKey` type derived from English.
 *
 * When `en.json` is empty, `MessageKey` widens to `string` so callers
 * (including tests) aren't blocked. Once Wave 1 starts populating
 * keys, the type narrows automatically.
 */
export function renderEntryModule(
  locales: readonly string[],
  source: Readonly<Record<string, string>>,
  coverage: Readonly<Record<string, number>> = {},
): string {
  const sortedLocales = [...locales].sort()
  const sortedEntries = Object.keys(source)
    .sort()
    .map((k) => [k, source[k]] as const)

  const localeUnion = sortedLocales.map((l) => JSON.stringify(l)).join(' | ')
  const localeArrayLiteral = sortedLocales
    .map((l) => `  ${JSON.stringify(l)},`)
    .join('\n')
  const nativeNamesEntries = sortedLocales
    .map((l) => `  ${JSON.stringify(l)}: ${JSON.stringify(NATIVE_NAMES[l] ?? l)},`)
    .join('\n')
  const coverageEntries = sortedLocales
    .map((l) => `  ${JSON.stringify(l)}: ${(coverage[l] ?? (l === SOURCE_LOCALE ? 1 : 0)).toFixed(4)},`)
    .join('\n')
  const pickerLocales = sortedLocales.filter(
    (l) => l === SOURCE_LOCALE || (coverage[l] ?? 0) >= PICKER_COVERAGE_THRESHOLD,
  )
  const pickerArrayLiteral = pickerLocales
    .map((l) => `  ${JSON.stringify(l)},`)
    .join('\n')
  const loaderEntries = sortedLocales
    .map((l) =>
      l === SOURCE_LOCALE
        ? `  ${JSON.stringify(l)}: async () => enMessages,`
        : `  ${JSON.stringify(l)}: () => import('./messages.${l}').then((m) => m.default),`,
    )
    .join('\n')

  const lines = [
    '// AUTO-GENERATED by scripts/generate-locales.ts. Do not edit directly.',
    '',
    `export type Locale = ${localeUnion || "''"}`,
    '',
    `export const SOURCE_LOCALE: Locale = ${JSON.stringify(SOURCE_LOCALE)}`,
    '',
    'export const SUPPORTED_LOCALES: readonly Locale[] = [',
    localeArrayLiteral,
    '] as const',
    '',
    'export const NATIVE_NAMES: Readonly<Record<Locale, string>> = {',
    nativeNamesEntries,
    '}',
    '',
    '/**',
    ' * Per-locale translation coverage (fraction of source keys',
    ' * translated, 0..1). Source locale is always 1.0. Computed at',
    ` * codegen time; gate for the public picker is ${PICKER_COVERAGE_THRESHOLD}.`,
    ' */',
    'export const LOCALE_COVERAGE: Readonly<Record<Locale, number>> = {',
    coverageEntries,
    '}',
    '',
    '/**',
    ' * Subset of SUPPORTED_LOCALES that meets the picker visibility',
    ` * threshold (\`coverage >= ${PICKER_COVERAGE_THRESHOLD}\`). Below-threshold locales stay`,
    ' * reachable via `?lang=<code>` for testing; they only disappear',
    ' * from the public language picker. Source locale is always',
    ' * included regardless of coverage.',
    ' */',
    'export const PICKER_LOCALES: readonly Locale[] = [',
    pickerArrayLiteral,
    '] as const',
    '',
    '/** English source bundle — always available synchronously. */',
    'const enLiteral = {',
    ...sortedEntries.map(
      ([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`,
    ),
    '} as const',
    '',
    'export const enMessages: Readonly<Record<string, string>> = enLiteral',
    '',
    '/**',
    ' * Literal-key union when entries exist; widens to `string` while',
    ' * `en.json` is empty so callers aren\'t blocked.',
    ' */',
    'export type MessageKey = keyof typeof enLiteral extends never',
    '  ? string',
    '  : keyof typeof enLiteral',
    '',
    '/** Lazy loaders, one per locale. English resolves synchronously. */',
    'export const localeLoaders: Readonly<',
    '  Record<Locale, () => Promise<Readonly<Record<string, string>>>>',
    '> = {',
    loaderEntries,
    '}',
    '',
  ]
  return lines.join('\n')
}

/** Read every `locales/<bcp47>.json`. Files prefixed with `_`
 *  (e.g. `_explanations.json`) are sidecar metadata, not locales —
 *  they're skipped here and consumed separately. Weblate's Language
 *  filter regex (`^[a-zA-Z]{2,3}…`) rejects underscore-prefixed
 *  filenames for the same reason: they are not language codes. */
export function readLocales(localesDir: string = LOCALES_DIR): LocaleFile[] {
  const files = readdirSync(localesDir)
    .filter((name) => name.endsWith('.json') && !name.startsWith('_'))
    .sort()
  return files.map((name) => {
    const path = resolve(localesDir, name)
    const locale = basename(name, '.json')
    const fileText = readFileSync(path, 'utf-8')
    let parsed: unknown
    try {
      parsed = JSON.parse(fileText)
    } catch (err) {
      throw new LocaleBuildError(
        `[locales] ${name}: invalid JSON — ${(err as Error).message}`,
      )
    }
    validateLocale(locale, parsed)
    return { locale, path, messages: parsed }
  })
}

/**
 * Read and validate `locales/_explanations.json` (optional sidecar).
 * Returns the parsed map, or `null` if the file doesn't exist. Throws
 * `LocaleBuildError` on shape violations or stale keys.
 *
 * Explanations are per-string developer notes pushed to Weblate via
 * `scripts/sync-weblate-metadata.ts` to populate the per-string
 * "Explanation" field translators see in the editor. Maintained in
 * the repo (so context is reviewable in PRs) and synced one-way out.
 *
 * Validation rules:
 *   - Object of `string → string`.
 *   - Every key must exist in `en.json` (catches stale explanations
 *     when an English key is renamed or removed).
 *   - Empty values fail loudly — an empty explanation is worse than
 *     no explanation because Weblate will overwrite a translator's
 *     prior context with empty text.
 */
export function readExplanations(
  localesDir: string = LOCALES_DIR,
  sourceKeys: ReadonlySet<string>,
): Readonly<Record<string, string>> | null {
  const path = resolve(localesDir, '_explanations.json')
  let fileText: string
  try {
    fileText = readFileSync(path, 'utf-8')
  } catch (err) {
    // Missing file is the documented "no sidecar" path. Anything
    // else (permission denied, IO error, EISDIR, etc.) is a real
    // failure that would otherwise be silently treated as
    // "no explanations" and skip the entire sync — surface it.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new LocaleBuildError(
      `[locales] _explanations.json: failed to read — ${(err as Error).message}`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(fileText)
  } catch (err) {
    throw new LocaleBuildError(
      `[locales] _explanations.json: invalid JSON — ${(err as Error).message}`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const got = parsed === null
      ? 'null'
      : Array.isArray(parsed)
        ? 'array'
        : typeof parsed
    throw new LocaleBuildError(
      `[locales] _explanations.json must be a JSON object, got ${got}`,
    )
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new LocaleBuildError(
        `[locales] _explanations.json: value for "${key}" must be a string, got ${typeof value}`,
      )
    }
    if (value.trim() === '') {
      throw new LocaleBuildError(
        `[locales] _explanations.json: explanation for "${key}" is empty — remove the entry instead of leaving a blank string (an empty value would overwrite any prior context in Weblate).`,
      )
    }
    if (!sourceKeys.has(key)) {
      throw new LocaleBuildError(
        `[locales] _explanations.json: key "${key}" is not in en.json — remove the stale explanation or add the key to en.json first.`,
      )
    }
    out[key] = value
  }
  return out
}

/**
 * Validate + render. Returns the list of files to write and any
 * warnings. Throws `LocaleBuildError` on any hard failure.
 */
export function build(localesDir: string = LOCALES_DIR): BuildOutput {
  const locales = readLocales(localesDir)
  if (locales.length === 0) {
    throw new LocaleBuildError(
      `[locales] no locale files found in ${localesDir}`,
    )
  }
  const source = locales.find((l) => l.locale === SOURCE_LOCALE)
  if (!source) {
    throw new LocaleBuildError(
      `[locales] source locale "${SOURCE_LOCALE}.json" missing`,
    )
  }

  const warnings: string[] = []
  const errors: string[] = []
  for (const loc of locales) {
    if (loc.locale === SOURCE_LOCALE) continue
    const diff = diffAgainstSource(loc.locale, source.messages, loc.messages)
    warnings.push(...diff.warnings)
    errors.push(...diff.errors)
  }
  if (errors.length > 0) {
    throw new LocaleBuildError(errors.join('\n'))
  }

  // Validate the optional explanations sidecar against the source key
  // set. Doesn't affect generated output (explanations are pushed to
  // Weblate by `scripts/sync-weblate-metadata.ts`, not bundled into
  // the runtime), but the build is the right place to catch a stale
  // entry referencing a key that no longer exists in en.json.
  readExplanations(localesDir, new Set(Object.keys(source.messages)))

  const files: RenderResult[] = []
  // Canonicalized JSON for every input locale comes first. The
  // codegen is the canonical formatter: predev/prebuild rewrite
  // whatever a developer typed, and `--check` mode in CI fails any
  // PR that drifts. Combined with Weblate's matching format
  // settings, this closes the whitespace-churn loop.
  for (const loc of locales) {
    files.push({
      path: loc.path,
      contents: renderLocaleJson(loc.messages),
    })
  }
  // Coverage: per-locale fraction of source keys translated to a
  // non-empty value. Source locale is 1.0 by construction. Drives
  // the picker-visibility gate emitted as PICKER_LOCALES in the
  // generated entry module — locales below 0.8 hide from the
  // public picker but stay reachable via `?lang=<code>`.
  const sourceKeyList = Object.keys(source.messages)
  const coverage: Record<string, number> = {}
  for (const loc of locales) {
    if (loc.locale === SOURCE_LOCALE) {
      coverage[loc.locale] = 1
      continue
    }
    if (sourceKeyList.length === 0) {
      // Degenerate empty-source case (Wave 0 state): trivially
      // covered, picker shows everything.
      coverage[loc.locale] = 1
      continue
    }
    let translated = 0
    for (const k of sourceKeyList) {
      const v = loc.messages[k]
      if (typeof v === 'string' && v !== '') translated++
    }
    coverage[loc.locale] = translated / sourceKeyList.length
  }

  files.push({
    path: resolve(OUTPUT_DIR, 'messages.ts'),
    contents: renderEntryModule(
      locales.map((l) => l.locale),
      source.messages,
      coverage,
    ),
  })
  for (const loc of locales) {
    if (loc.locale === SOURCE_LOCALE) continue
    files.push({
      path: resolve(OUTPUT_DIR, `messages.${loc.locale}.ts`),
      contents: renderLocaleModule(loc.locale, loc.messages),
    })
  }
  return { files, warnings }
}

// ---- CLI entry point ────────────────────────────────────────────────

/**
 * Print build warnings. The per-key "missing translation" warnings are
 * collapsed to one count per locale by default — across many
 * partially-translated locales the per-key list floods CI logs and
 * Weblate is the real source of truth for coverage. `--verbose` restores
 * the full per-key list. Any other warning kind is always printed.
 */
function emitWarnings(warnings: readonly string[], verbose: boolean): void {
  /* eslint-disable no-console */
  if (warnings.length === 0) return
  if (verbose) {
    for (const w of warnings) console.warn(w)
    return
  }
  const missingByFile = new Map<string, number>()
  const other: string[] = []
  for (const w of warnings) {
    const m = /^\[locales\] (\S+): missing translation for /.exec(w)
    if (m) missingByFile.set(m[1], (missingByFile.get(m[1]) ?? 0) + 1)
    else other.push(w)
  }
  for (const [file, count] of missingByFile) {
    console.warn(
      `[locales] ${file}: ${count} missing translation(s) ` +
        '(run `npm run locales -- --verbose` to list)',
    )
  }
  for (const w of other) console.warn(w)
  /* eslint-enable no-console */
}

function run(): void {
  const checkMode = process.argv.includes('--check')
  let output: BuildOutput
  try {
    output = build()
  } catch (err) {
    if (err instanceof LocaleBuildError) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  }

  emitWarnings(output.warnings, process.argv.includes('--verbose'))

  if (checkMode) {
    let stale = false
    for (const file of output.files) {
      let current = ''
      try {
        current = readFileSync(file.path, 'utf-8')
      } catch {
        // missing file — definitely stale
      }
      if (current !== file.contents) {
        // Two drift classes share this gate:
        //   - JSON locale files (checked in): a developer edited
        //     `locales/<bcp47>.json` without running the codegen,
        //     leaving a non-canonical file. Fix: `npm run locales`,
        //     then commit the normalized file.
        //   - Generated TS modules (gitignored): a developer added
        //     a key to en.json but didn't regenerate, so the
        //     `MessageKey` union is stale. Fix: `npm run locales`;
        //     no commit needed because the output is gitignored.
        const isLocaleSource = file.path.endsWith('.json')
        const fixHint = isLocaleSource
          ? `Run \`npm run locales\` to canonicalize, then commit the change.`
          : `Run \`npm run locales\` to regenerate. (Output is gitignored — no commit needed.)`
        console.error(`✗ ${file.path} is stale.\n  ${fixHint}`)
        stale = true
      }
    }
    if (stale) process.exit(1)
    // eslint-disable-next-line no-console
    console.log(`✓ ${output.files.length} locale artifact(s) up to date`)
    return
  }

  for (const file of output.files) {
    let current = ''
    try {
      current = readFileSync(file.path, 'utf-8')
    } catch {
      // missing — write it
    }
    if (current === file.contents) continue
    // Some outputs (TS modules) live under OUTPUT_DIR; others
    // (canonicalized JSON) live in `locales/`. mkdir per file's
    // own parent so adding new output paths later doesn't need
    // a special case here.
    mkdirSync(dirname(file.path), { recursive: true })
    writeFileSync(file.path, file.contents, 'utf-8')
    // eslint-disable-next-line no-console
    console.log(`✓ Wrote ${file.path} (${file.contents.length} bytes)`)
  }
}

// CLI-mode detection — `pathToFileURL` normalizes `process.argv[1]`
// across platforms (Windows backslashes + drive letter, POSIX slashes)
// so the comparison matches `import.meta.url`. The naive
// `file://${process.argv[1]}` template silently misses on Windows
// runners, leaving `run()` un-invoked and the codegen producing no
// output — which then fails the downstream vite build with an
// unresolved-import error pointing at `./messages`.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run()
}

export { LocaleBuildError, NATIVE_NAMES, SOURCE_LOCALE }
