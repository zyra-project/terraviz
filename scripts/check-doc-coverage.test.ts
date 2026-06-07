import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { findUndocumentedModules, formatReport, CheckError } from './check-doc-coverage'

/**
 * Build a throwaway repo root. `files` maps a repo-relative path to
 * its contents; CLAUDE.md is written from `doc`.
 */
function fixtureRepo(doc: string, files: Record<string, string>): string {
  const root = mkdtempSync(resolve(tmpdir(), 'terraviz-doc-cov-'))
  writeFileSync(resolve(root, 'CLAUDE.md'), doc, 'utf-8')
  for (const [rel, body] of Object.entries(files)) {
    const full = resolve(root, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body, 'utf-8')
  }
  return root
}

describe('check-doc-coverage · findUndocumentedModules', () => {
  it('passes when every module is named in the doc', () => {
    const root = fixtureRepo(
      '| `src/services/alpha.ts` | A |\n| `src/ui/beta.ts` | B |\n',
      { 'src/services/alpha.ts': 'export const a = 1\n', 'src/ui/beta.ts': 'export const b = 2\n' },
    )
    expect(findUndocumentedModules(root)).toEqual([])
  })

  it('flags a module absent from the doc, anywhere under src/', () => {
    const root = fixtureRepo('| `src/services/alpha.ts` | A |\n', {
      'src/services/alpha.ts': 'export const a = 1\n',
      'src/ui/publisher/pages/gamma.ts': 'export const g = 3\n',
    })
    const missing = findUndocumentedModules(root)
    expect(missing.map(m => m.basename)).toEqual(['gamma.ts'])
  })

  it('checks src-tauri/src Rust modules too', () => {
    const root = fixtureRepo('| `src-tauri/src/main.rs` | entry |\n', {
      'src-tauri/src/main.rs': 'fn main() {}\n',
      'src-tauri/src/lib.rs': 'pub fn x() {}\n',
    })
    expect(findUndocumentedModules(root).map(m => m.basename)).toEqual(['lib.rs'])
  })

  it('ignores tests, .d.ts, generated messages, and test-setup', () => {
    const root = fixtureRepo('(empty map)\n', {
      'src/services/alpha.test.ts': 'test\n',
      'src/types/foo.d.ts': 'declare const x: number\n',
      'src/i18n/messages.ts': 'export const m = {}\n',
      'src/i18n/messages.es.ts': 'export const m = {}\n',
      'src/test-setup.ts': 'import "x"\n',
    })
    expect(findUndocumentedModules(root)).toEqual([])
  })

  it('does not let a longer path cover a shorter basename (me.ts vs time.ts)', () => {
    const root = fixtureRepo('| `src/utils/time.ts` | time utils |\n', {
      'src/utils/time.ts': 'export const t = 1\n',
      'src/ui/publisher/pages/me.ts': 'export const me = 1\n',
    })
    expect(findUndocumentedModules(root).map(m => m.basename)).toEqual(['me.ts'])
  })

  it('checks functions/ against docs/BACKEND_MODULES.md, by full path', () => {
    // Two route handlers share a basename across dirs (the backend's
    // shape) — documenting one must NOT cover the other.
    const root = fixtureRepo('', {
      'functions/a/[id].ts': 'export const a = 1\n',
      'functions/b/[id].ts': 'export const b = 2\n',
      'docs/BACKEND_MODULES.md': '| `functions/a/[id].ts` | A |\n',
    })
    const missing = findUndocumentedModules(root)
    expect(missing.map(m => m.file)).toEqual(['functions/b/[id].ts'])
    expect(missing[0]?.doc).toBe('docs/BACKEND_MODULES.md')
  })

  it('checks cli/ against docs/BACKEND_MODULES.md', () => {
    const root = fixtureRepo('', {
      'cli/terraviz.ts': 'export const t = 1\n',
      'docs/BACKEND_MODULES.md': '(empty)\n',
    })
    expect(findUndocumentedModules(root).map(m => m.file)).toEqual(['cli/terraviz.ts'])
  })

  it('honours a // doc-exempt: marker with a reason', () => {
    const root = fixtureRepo('(empty map)\n', {
      'src/ui/shim.ts': '// doc-exempt: throwaway re-export, obvious from barrel\nexport * from "./x"\n',
    })
    expect(findUndocumentedModules(root)).toEqual([])
  })

  it('does NOT honour a bare doc-exempt with no reason', () => {
    const root = fixtureRepo('(empty map)\n', {
      'src/ui/shim.ts': '// doc-exempt:\nexport const x = 1\n',
    })
    expect(findUndocumentedModules(root).map(m => m.basename)).toEqual(['shim.ts'])
  })

  it('tolerates a missing coverage root (no src-tauri in fixture)', () => {
    const root = fixtureRepo('| `src/services/alpha.ts` | A |\n', {
      'src/services/alpha.ts': 'export const a = 1\n',
    })
    expect(findUndocumentedModules(root)).toEqual([])
  })

  it('throws CheckError when CLAUDE.md is missing', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'terraviz-doc-cov-nodoc-'))
    mkdirSync(resolve(root, 'src/services'), { recursive: true })
    writeFileSync(resolve(root, 'src/services/alpha.ts'), 'export const a = 1\n', 'utf-8')
    expect(() => findUndocumentedModules(root)).toThrow(CheckError)
  })
})

describe('check-doc-coverage · formatReport', () => {
  it('returns empty string when nothing is missing', () => {
    expect(formatReport([])).toBe('')
  })

  it('lists each missing module path and its doc home', () => {
    const report = formatReport([
      { file: 'src/ui/gamma.ts', basename: 'gamma.ts', doc: 'CLAUDE.md' },
    ])
    expect(report).toContain('src/ui/gamma.ts')
    expect(report).toContain('CLAUDE.md')
    expect(report).toContain('1 module missing')
  })
})
