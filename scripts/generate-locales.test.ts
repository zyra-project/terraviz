// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import {
  build,
  diffAgainstSource,
  LocaleBuildError,
  readExplanations,
  renderEntryModule,
  renderLocaleJson,
  renderLocaleModule,
  validateLocale,
} from './generate-locales'

function tmpLocalesDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'terraviz-locales-'))
  mkdirSync(dir, { recursive: true })
  for (const [name, contents] of Object.entries(files)) {
    const value =
      typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2)
    writeFileSync(resolve(dir, name), value, 'utf-8')
  }
  return dir
}

describe('validateLocale', () => {
  it('accepts a flat object of string keys matching the regex', () => {
    expect(() =>
      validateLocale('en', { 'app.title': 'Terraviz', 'browse.search.placeholder': 'Search…' }),
    ).not.toThrow()
  })

  it('rejects arrays', () => {
    expect(() => validateLocale('en', ['nope'])).toThrow(LocaleBuildError)
  })

  it('rejects non-string values', () => {
    expect(() => validateLocale('en', { 'app.title': 42 })).toThrow(/must be a string/)
  })

  it('rejects keys that fail the regex', () => {
    expect(() => validateLocale('en', { 'App.Title': 'x' })).toThrow(/violates/)
    expect(() => validateLocale('en', { '0bad': 'x' })).toThrow(/violates/)
    expect(() => validateLocale('en', { 'has space': 'x' })).toThrow(/violates/)
  })

  it('accepts an empty object', () => {
    expect(() => validateLocale('en', {})).not.toThrow()
  })

  it('rejects values that contain script-class HTML', () => {
    // Translator input flows into innerHTML in a few places (notably
    // help-guide section blobs). The runtime sanitizer in
    // src/ui/sanitizeHtml.ts is the primary defense; the codegen
    // tripwire below catches the obvious classes at build time so
    // hostile substrings can't ship at all.
    expect(() => validateLocale('en', { 'help.foo': '<script>x</script>' })).toThrow(/forbidden/)
    expect(() => validateLocale('en', { 'help.foo': '<iframe src=x>' })).toThrow(/forbidden/)
    expect(() => validateLocale('en', { 'help.foo': '<a onclick="alert(1)">x</a>' })).toThrow(/forbidden/)
    expect(() => validateLocale('en', { 'help.foo': 'click <a href="javascript:1">here</a>' })).toThrow(/forbidden/)
    expect(() => validateLocale('en', { 'help.foo': '<a href="data:text/html,foo">x</a>' })).toThrow(/forbidden/)
  })

  it('keeps benign HTML intact (the help-guide blobs use it)', () => {
    expect(() => validateLocale('en', {
      'help.guide.section.x': '<h3>Title</h3><ul><li><strong>Bold</strong></li></ul>',
    })).not.toThrow()
    expect(() => validateLocale('en', {
      'help.foo': 'Press <kbd>Esc</kbd> to close',
    })).not.toThrow()
    expect(() => validateLocale('en', {
      'help.foo': 'See <a href="/privacy" target="_blank">policy</a>',
    })).not.toThrow()
  })
})

describe('diffAgainstSource', () => {
  it('reports missing-in-target as warnings', () => {
    const { warnings, errors } = diffAgainstSource(
      'es',
      { 'app.title': 'Terraviz', 'browse.search': 'Search' },
      { 'app.title': 'Terraviz' },
    )
    expect(warnings).toEqual([
      '[locales] es.json: missing translation for "browse.search"',
    ])
    expect(errors).toEqual([])
  })

  it('reports orphan keys as errors', () => {
    const { warnings, errors } = diffAgainstSource(
      'es',
      { 'app.title': 'Terraviz' },
      { 'app.title': 'Terraviz', 'orphan.key': 'oops' },
    )
    expect(warnings).toEqual([])
    expect(errors[0]).toMatch(/orphan key "orphan\.key"/)
  })

  it('returns clean output when keys match', () => {
    const { warnings, errors } = diffAgainstSource(
      'es',
      { 'app.title': 'Terraviz' },
      { 'app.title': 'Terraviz' },
    )
    expect(warnings).toEqual([])
    expect(errors).toEqual([])
  })
})

describe('renderEntryModule', () => {
  it('emits deterministic output with sorted locales and sorted entries', () => {
    const a = renderEntryModule(['es', 'en'], { 'b.key': 'B', 'a.key': 'A' })
    const b = renderEntryModule(['en', 'es'], { 'a.key': 'A', 'b.key': 'B' })
    expect(a).toEqual(b)
    expect(a).toContain('"a.key": "A"')
    expect(a.indexOf('"a.key"')).toBeLessThan(a.indexOf('"b.key"'))
  })

  it('includes the lazy import line for non-source locales', () => {
    const out = renderEntryModule(['en', 'es'], {})
    expect(out).toMatch(/import\(['"]\.\/messages\.es['"]\)/)
    expect(out).toMatch(/async \(\) => enMessages/) // English is sync
  })

  it('emits MessageKey conditional that widens to string when source is empty', () => {
    const out = renderEntryModule(['en'], {})
    expect(out).toMatch(/keyof typeof enLiteral extends never/)
    expect(out).toMatch(/\? string/)
  })

  it('produces compilable TS shape (smoke check via simple regex)', () => {
    const out = renderEntryModule(['en', 'es'], { 'app.title': 'Terraviz' })
    expect(out).toContain('export type Locale = "en" | "es"')
    expect(out).toContain('export const SOURCE_LOCALE: Locale = "en"')
    expect(out).toContain('export const enMessages')
  })

  it('emits LOCALE_COVERAGE with the supplied per-locale fractions', () => {
    const out = renderEntryModule(
      ['en', 'es', 'ar'],
      { 'app.title': 'Terraviz' },
      { en: 1, es: 1, ar: 0 },
    )
    expect(out).toMatch(/"ar":\s*0\.0000/)
    expect(out).toMatch(/"en":\s*1\.0000/)
    expect(out).toMatch(/"es":\s*1\.0000/)
  })

  it('PICKER_LOCALES drops below-threshold locales but always keeps the source', () => {
    const out = renderEntryModule(
      ['en', 'es', 'ar', 'kab'],
      { 'app.title': 'Terraviz' },
      { en: 1, es: 1, ar: 0, kab: 0.027 },
    )
    // Extract the literal between `PICKER_LOCALES: readonly Locale[] = [` and `] as const`
    const m = out.match(/PICKER_LOCALES:\s*readonly Locale\[\] = \[([\s\S]*?)\] as const/)
    expect(m).not.toBeNull()
    const body = m![1]!
    expect(body).toContain('"en"')
    expect(body).toContain('"es"')
    expect(body).not.toContain('"ar"')
    expect(body).not.toContain('"kab"')
  })

  it('PICKER_LOCALES includes locales exactly at the 0.8 threshold', () => {
    const out = renderEntryModule(
      ['en', 'fr'],
      { 'app.title': 'Terraviz' },
      { en: 1, fr: 0.8 },
    )
    expect(out).toMatch(/PICKER_LOCALES[\s\S]*"fr"/)
  })

  it('PICKER_LOCALES keeps the source locale even when its coverage is missing', () => {
    // Defensive: a degenerate coverage map without the source key
    // should still include the source in the picker (`en` is the
    // app's universal fallback, never gated).
    const out = renderEntryModule(['en', 'es'], { 'app.title': 'Terraviz' }, {})
    const m = out.match(/PICKER_LOCALES:\s*readonly Locale\[\] = \[([\s\S]*?)\] as const/)
    expect(m![1]).toContain('"en"')
  })
})

describe('renderLocaleJson', () => {
  it('emits 2-space indent, trailing newline, no interior blank lines', () => {
    const out = renderLocaleJson({ 'app.title': 'Terraviz', 'browse.search': 'Search' })
    expect(out).toBe(
      '{\n  "app.title": "Terraviz",\n  "browse.search": "Search"\n}\n',
    )
  })

  it('sorts keys alphabetically (matches Weblate "Sort JSON keys")', () => {
    const out = renderLocaleJson({ 'z.last': 'Z', 'a.first': 'A' })
    expect(out.indexOf('"a.first"')).toBeLessThan(out.indexOf('"z.last"'))
  })

  it('uses literal Unicode for BMP characters (no \\uXXXX escapes)', () => {
    const out = renderLocaleJson({ greeting: '¡Hola, Mundo! — “quotes”' })
    expect(out).toContain('¡Hola, Mundo! — “quotes”')
    expect(out).not.toMatch(/\\u[0-9a-f]{4}/)
  })

  it('is idempotent — re-running on canonical output yields identical bytes', () => {
    const obj = {
      'app.title': 'Terraviz',
      'browse.search': 'Search',
    }
    const a = renderLocaleJson(obj)
    const b = renderLocaleJson(JSON.parse(a))
    expect(a).toBe(b)
  })
})

describe('build → JSON canonicalization', () => {
  it('emits canonicalized JSON for every input locale, written back to its source path', () => {
    const dir = tmpLocalesDir({
      'en.json': { 'app.title': 'Terraviz' },
      'es.json': { 'app.title': 'Terraviz' },
    })
    const out = build(dir)
    const enFile = out.files.find((f) => f.path.endsWith('en.json'))
    const esFile = out.files.find((f) => f.path.endsWith('es.json'))
    expect(enFile).toBeTruthy()
    expect(esFile).toBeTruthy()
    expect(enFile!.path).toBe(resolve(dir, 'en.json'))
    expect(enFile!.contents).toBe('{\n  "app.title": "Terraviz"\n}\n')
  })

  it('strips blank-line drift from a developer-typed locale (closes the Weblate churn loop)', () => {
    // Simulate the en.json shape that landed before this PR: section
    // breaks between thematic groups. The canonicalizer must strip
    // them so Weblate (which strips them too) never produces a
    // whitespace-only diff against main.
    const dir = mkdtempSync(resolve(tmpdir(), 'terraviz-locales-'))
    writeFileSync(
      resolve(dir, 'en.json'),
      '{\n  "app.title": "Terraviz",\n\n  "browse.search": "Search"\n}\n',
      'utf-8',
    )
    const out = build(dir)
    const enFile = out.files.find((f) => f.path.endsWith('en.json'))!
    expect(enFile.contents).not.toMatch(/\n\n/)
    expect(enFile.contents).toBe(
      '{\n  "app.title": "Terraviz",\n  "browse.search": "Search"\n}\n',
    )
  })

  it('canonicalizes a target locale even when keys arrive in non-source order', () => {
    // Weblate's per-translator queue presents keys in priority order
    // (see PR #81's kab.json — keys appear roughly random). The
    // canonicalizer sorts so on every round-trip the file matches
    // the same order regardless of who saved last.
    const dir = tmpLocalesDir({
      'en.json': { 'a.one': 'A', 'b.two': 'B', 'c.three': 'C' },
      'es.json': { 'c.three': 'C-es', 'a.one': 'A-es', 'b.two': 'B-es' },
    })
    const out = build(dir)
    const esFile = out.files.find((f) => f.path.endsWith('es.json'))!
    expect(esFile.contents.indexOf('"a.one"')).toBeLessThan(
      esFile.contents.indexOf('"b.two"'),
    )
    expect(esFile.contents.indexOf('"b.two"')).toBeLessThan(
      esFile.contents.indexOf('"c.three"'),
    )
  })
})

describe('renderLocaleModule', () => {
  it('emits a default-export const object frozen via `as const`', () => {
    const out = renderLocaleModule('es', { 'app.title': 'Terraviz' })
    expect(out).toContain('export default messages')
    expect(out).toContain('as const')
    expect(out).toContain('"app.title": "Terraviz"')
  })

  it('is deterministic across input ordering', () => {
    const a = renderLocaleModule('es', { 'b.key': 'B', 'a.key': 'A' })
    const b = renderLocaleModule('es', { 'a.key': 'A', 'b.key': 'B' })
    expect(a).toEqual(b)
  })
})

describe('build', () => {
  it('renders canonicalized JSON + entry + non-source locale files', () => {
    const dir = tmpLocalesDir({
      'en.json': { 'app.title': 'Terraviz' },
      'es.json': { 'app.title': 'Terraviz' },
    })
    const out = build(dir)
    expect(out.files.map((f) => basename(f.path))).toEqual([
      'en.json',
      'es.json',
      'messages.ts',
      'messages.es.ts',
    ])
    expect(out.warnings).toEqual([])
  })

  it('warns on missing-in-target keys but still renders', () => {
    const dir = tmpLocalesDir({
      'en.json': { 'app.title': 'Terraviz', 'browse.search': 'Search' },
      'es.json': { 'app.title': 'Terraviz' },
    })
    const out = build(dir)
    expect(out.warnings.length).toBeGreaterThan(0)
    // 2 canonicalized JSON inputs + 1 entry module + 1 non-source locale
    expect(out.files.length).toBe(4)
  })

  it('throws on orphan key in non-source locale', () => {
    const dir = tmpLocalesDir({
      'en.json': { 'app.title': 'Terraviz' },
      'es.json': { 'orphan': 'oops' },
    })
    expect(() => build(dir)).toThrow(LocaleBuildError)
  })

  it('throws when en.json is missing', () => {
    const dir = tmpLocalesDir({
      'es.json': { 'app.title': 'Terraviz' },
    })
    expect(() => build(dir)).toThrow(/source locale/)
  })

  it('throws on invalid JSON', () => {
    const dir = tmpLocalesDir({
      'en.json': '{not json',
    })
    expect(() => build(dir)).toThrow(/invalid JSON/)
  })

  it('produces byte-identical output across runs (drift detection)', () => {
    const dir = tmpLocalesDir({
      'en.json': { 'app.title': 'Terraviz', 'browse.search': 'Search' },
      'es.json': { 'app.title': 'Terraviz' },
    })
    const a = build(dir).files.map((f) => f.contents).join('\n---\n')
    const b = build(dir).files.map((f) => f.contents).join('\n---\n')
    expect(a).toEqual(b)
  })

  it('rejects any $-prefixed key (including would-be meta keys) via KEY_RE', () => {
    // The codegen used to allowlist `$schema` / `$comment` for editor
    // JSON-Schema integration. After dropping that affordance (Weblate
    // is the canonical translator UI; editor autocomplete on en.json
    // matters less than a clean translator surface), every `$`-prefixed
    // key now fails KEY_RE — including typos like `$app.title`.
    // Value is irrelevant here — KEY_RE rejects on the key shape, not
    // the value. Empty string keeps the test self-contained instead of
    // hinting at a schema file path that no longer exists.
    const dir = tmpLocalesDir({
      'en.json': { '$schema': '' },
    })
    expect(() => build(dir)).toThrow(/violates/)
  })

  it('skips files prefixed with `_` so sidecar metadata never gets treated as a locale', () => {
    // `_explanations.json` carries per-string developer notes pushed
    // to Weblate's "Explanation" field. It must not be ingested as a
    // translation. Mirrors Weblate's own Language filter regex which
    // rejects underscore-prefixed filenames.
    const dir = tmpLocalesDir({
      'en.json': { 'app.title': 'Terraviz' },
      'es.json': { 'app.title': 'Terraviz' },
      '_explanations.json': { 'app.title': 'Brand name; do not translate.' },
    })
    const out = build(dir)
    // 2 locale JSONs (en, es) + entry module + es module — no entry
    // for _explanations.
    expect(out.files.map((f) => basename(f.path))).toEqual([
      'en.json',
      'es.json',
      'messages.ts',
      'messages.es.ts',
    ])
    expect(out.warnings).toEqual([])
  })
})

describe('readExplanations', () => {
  it('returns null when the sidecar file does not exist', () => {
    const dir = tmpLocalesDir({ 'en.json': { 'app.title': 'Terraviz' } })
    const result = readExplanations(dir, new Set(['app.title']))
    expect(result).toBeNull()
  })

  it('returns the parsed map when valid and every key exists in source', () => {
    const dir = tmpLocalesDir({
      'en.json': { 'app.title': 'Terraviz', 'browse.search': 'Search' },
      '_explanations.json': {
        'app.title': 'Brand name; do not translate.',
        'browse.search': 'Search bar placeholder.',
      },
    })
    const result = readExplanations(
      dir,
      new Set(['app.title', 'browse.search']),
    )
    expect(result).toEqual({
      'app.title': 'Brand name; do not translate.',
      'browse.search': 'Search bar placeholder.',
    })
  })

  it('throws on a stale key that no longer exists in en.json', () => {
    const dir = tmpLocalesDir({
      'en.json': { 'app.title': 'Terraviz' },
      '_explanations.json': {
        'app.title': 'Brand name.',
        'browse.removed': 'This key was renamed and never cleaned up here.',
      },
    })
    expect(() =>
      readExplanations(dir, new Set(['app.title'])),
    ).toThrow(/not in en\.json/)
  })

  it('throws on an empty explanation (would overwrite Weblate context)', () => {
    const dir = tmpLocalesDir({
      'en.json': { 'app.title': 'Terraviz' },
      '_explanations.json': { 'app.title': '' },
    })
    expect(() =>
      readExplanations(dir, new Set(['app.title'])),
    ).toThrow(/empty/)
  })

  it('throws when the value is not a string', () => {
    const dir = tmpLocalesDir({
      'en.json': { 'app.title': 'Terraviz' },
      '_explanations.json': { 'app.title': 42 },
    })
    expect(() =>
      readExplanations(dir, new Set(['app.title'])),
    ).toThrow(/must be a string/)
  })

  it('throws on a stale explanation when invoked through build()', () => {
    // Smoke-check the wiring — build() should fail loudly if the
    // sidecar references a key the source no longer has.
    const dir = tmpLocalesDir({
      'en.json': { 'app.title': 'Terraviz' },
      'es.json': { 'app.title': 'Terraviz' },
      '_explanations.json': { 'gone.key': 'Explanation for a key that does not exist.' },
    })
    expect(() => build(dir)).toThrow(/not in en\.json/)
  })
})
