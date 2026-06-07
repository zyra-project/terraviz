import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { findUndocumentedModules, formatReport, CheckError } from './check-doc-coverage'

/** Build a throwaway repo root with a CLAUDE.md and service files. */
function fixtureRepo(doc: string, services: Record<string, string>): string {
  const root = mkdtempSync(resolve(tmpdir(), 'terraviz-doc-cov-'))
  writeFileSync(resolve(root, 'CLAUDE.md'), doc, 'utf-8')
  const dir = resolve(root, 'src/services')
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(services)) {
    writeFileSync(resolve(dir, name), body, 'utf-8')
  }
  return root
}

describe('check-doc-coverage · findUndocumentedModules', () => {
  it('passes when every service is named in the doc', () => {
    const root = fixtureRepo(
      '| `src/services/alpha.ts` | A | \n| `src/services/beta.ts` | B |\n',
      { 'alpha.ts': 'export const a = 1\n', 'beta.ts': 'export const b = 2\n' },
    )
    expect(findUndocumentedModules(root)).toEqual([])
  })

  it('flags a service absent from the doc', () => {
    const root = fixtureRepo(
      '| `src/services/alpha.ts` | A |\n',
      { 'alpha.ts': 'export const a = 1\n', 'gamma.ts': 'export const g = 3\n' },
    )
    const missing = findUndocumentedModules(root)
    expect(missing.map(m => m.basename)).toEqual(['gamma.ts'])
  })

  it('ignores *.test.ts files', () => {
    const root = fixtureRepo('| `src/services/alpha.ts` | A |\n', {
      'alpha.ts': 'export const a = 1\n',
      'alpha.test.ts': 'import { a } from "./alpha"\n',
    })
    expect(findUndocumentedModules(root)).toEqual([])
  })

  it('honours a // doc-exempt: marker with a reason', () => {
    const root = fixtureRepo('(empty map)\n', {
      'shim.ts': '// doc-exempt: throwaway re-export, obvious from barrel\nexport * from "./x"\n',
    })
    expect(findUndocumentedModules(root)).toEqual([])
  })

  it('does NOT honour a bare doc-exempt with no reason', () => {
    const root = fixtureRepo('(empty map)\n', {
      'shim.ts': '// doc-exempt:\nexport const x = 1\n',
    })
    expect(findUndocumentedModules(root).map(m => m.basename)).toEqual(['shim.ts'])
  })

  it('throws CheckError when CLAUDE.md is missing', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'terraviz-doc-cov-nodoc-'))
    mkdirSync(resolve(root, 'src/services'), { recursive: true })
    expect(() => findUndocumentedModules(root)).toThrow(CheckError)
  })
})

describe('check-doc-coverage · formatReport', () => {
  it('returns empty string when nothing is missing', () => {
    expect(formatReport([])).toBe('')
  })

  it('lists each missing module path', () => {
    const report = formatReport([{ file: 'src/services/gamma.ts', basename: 'gamma.ts' }])
    expect(report).toContain('src/services/gamma.ts')
    expect(report).toContain('1 service module missing')
  })
})
