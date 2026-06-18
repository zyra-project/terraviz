import { describe, it, expect } from 'vitest'
import { buildReaderCode, DESIGN_FILE_NAME } from './read-penpot.ts'

describe('read-penpot reader code', () => {
  it('is read-only — performs no token graph mutations', () => {
    const code = buildReaderCode()
    for (const mutator of ['addSet', 'addToken', 'toggleActive', 'addTheme', '.remove(', '.value =']) {
      expect(code, `must not call ${mutator}`).not.toContain(mutator)
    }
  })

  it('reads sets, tokens, and themes from the local token graph', () => {
    const code = buildReaderCode()
    expect(code).toContain('penpot.library.local.tokens')
    expect(code).toContain('tokens.sets.map')
    expect(code).toContain('tokens.themes.map')
    expect(code).toContain('activeSets.map')
  })

  it('emits the PenpotGraph shape the reconcile step consumes', () => {
    const code = buildReaderCode()
    // returns { file, sets, themes }; tokens carry name/type/value/description
    expect(code).toMatch(/return\s*{[\s\S]*file:[\s\S]*sets,[\s\S]*themes,[\s\S]*}/)
    for (const field of ['name:', 'type:', 'value:', 'description:']) {
      expect(code).toContain(field)
    }
  })

  it('guards on the focused file by default and surfaces a mismatch', () => {
    const code = buildReaderCode()
    expect(code).toContain(JSON.stringify(DESIGN_FILE_NAME))
    expect(code).toContain("error: 'wrong focused file'")
    expect(code).toContain('penpot.currentFile')
  })

  it('omits the guard when expectedFile is null', () => {
    const code = buildReaderCode(null)
    expect(code).not.toContain("error: 'wrong focused file'")
    // still reports the focused file name in the payload
    expect(code).toContain('file: penpot.currentFile')
  })
})
