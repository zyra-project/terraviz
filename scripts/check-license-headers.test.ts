// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the per-file licence-header check.
 *
 * This file is one of the two the check is most likely to get wrong, and the
 * reason is visible below: it quotes `SPDX-License-Identifier` and `Copyright`
 * dozens of times in fixtures. A check that SEARCHED the top of a file for
 * those strings would pass this file with its real header deleted — the check
 * written to notice a missing header, blind to one missing from itself. So the
 * first group below pins the property that prevents it: the header is matched
 * at a position, not found anywhere.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  COPYRIGHT,
  LICENSE_ID,
  SPDX,
  addHeader,
  check,
  commentStyle,
  hasHeader,
  headerLines,
  metadataDrift,
  prologueLines,
  sourceFiles,
} from './check-license-headers'

const slash = commentStyle('a.ts')!
const markup = commentStyle('a.html')!
const hash = commentStyle('a.py')!
const block = commentStyle('a.css')!
const dash = commentStyle('a.sql')!

/** The correct two-line header for a file kind, without the trailing blank. */
const header = (file: string): string =>
  headerLines(commentStyle(file)!).slice(0, 2).join('\n')

const temps: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'license-header-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('matched by position, not searched for', () => {
  it('accepts the header at the top', () => {
    expect(hasHeader('a.ts', `${header('a.ts')}\n\nexport const x = 1\n`, slash)).toBe(true)
  })

  it('REJECTS a file that merely talks about the header', () => {
    // The shape of this test file and of the tool itself. A "does the top of
    // the file contain these strings" check passes this; that is the bug.
    const text = [
      '/**',
      ` * Explains why every file carries ${SPDX}`,
      ` * and a line reading ${COPYRIGHT}.`,
      ' */',
      'export const documented = true',
    ].join('\n')
    expect(hasHeader('a.ts', text, slash)).toBe(false)
  })

  it('REJECTS a header pushed down by one line when nothing must come first', () => {
    const text = `\n${header('a.ts')}\n\nexport const x = 1\n`
    expect(hasHeader('a.ts', text, slash)).toBe(false)
  })

  it('REJECTS the two lines in the wrong order', () => {
    const text = `// ${COPYRIGHT}\n// ${SPDX}\n\nexport const x = 1\n`
    expect(hasHeader('a.ts', text, slash)).toBe(false)
  })

  it('REJECTS the SPDX line alone', () => {
    expect(hasHeader('a.ts', `// ${SPDX}\n\nexport const x = 1\n`, slash)).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('prologues — lines that must stay first', () => {
  const cases: Array<[name: string, file: string, text: string, expected: number]> = [
    ['shebang in a shell script', 'x.sh', '#!/usr/bin/env bash\nset -e\n', 1],
    ['shebang in a node script', 'x.mjs', '#!/usr/bin/env node\nimport x from "y"\n', 1],
    ['shebang in a TypeScript script', 'x.ts', '#!/usr/bin/env tsx\nexport {}\n', 1],
    ['shebang in python', 'x.py', '#!/usr/bin/env python3\nimport sys\n', 1],
    ['shebang then PEP 263 coding line', 'x.py', '#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\nimport sys\n', 2],
    ['PEP 263 coding line alone', 'x.py', '# -*- coding: utf-8 -*-\nimport sys\n', 1],
    ['uppercase DOCTYPE', 'x.html', '<!DOCTYPE html>\n<html>\n', 1],
    ['lowercase doctype', 'x.html', '<!doctype html>\n<html>\n', 1],
    ['XML declaration then doctype', 'x.html', '<?xml version="1.0"?>\n<!DOCTYPE html>\n<html>\n', 2],
    ['swift-tools-version', 'Package.swift', '// swift-tools-version:5.9\nimport PackageDescription\n', 1],
    ['no prologue at all', 'x.ts', 'export const x = 1\n', 0],
    ['an ordinary doc comment is not a prologue', 'x.ts', '/**\n * What this file is for.\n */\n', 0],
    ['an ordinary // comment is not a prologue', 'x.ts', '// a note\nexport const x = 1\n', 0],
    ['an HTML comment is not a prologue', 'x.html', '<!-- a note -->\n<div></div>\n', 0],
    ['a plain # comment in shell is not a prologue', 'x.sh', '# a note\nset -e\n', 0],
  ]

  for (const [name, file, text, expected] of cases) {
    it(`${name} → skip ${expected}`, () => {
      expect(prologueLines(file, text)).toBe(expected)
    })
  }

  it('does not treat a coding line further down as a prologue', () => {
    // PEP 263 is honoured on line 1 or 2 only. Lower than that it is a comment,
    // and treating it as a prologue would bury the header mid-file.
    expect(prologueLines('x.py', 'import sys\nimport os\n# -*- coding: utf-8 -*-\n')).toBe(0)
  })

  it('does not treat a swift-tools-version comment further down as a prologue', () => {
    expect(prologueLines('Package.swift', 'import PackageDescription\n// swift-tools-version:5.9\n')).toBe(0)
  })

  it('does not treat a doctype-looking line in a code file as a prologue', () => {
    expect(prologueLines('x.ts', 'const s = "<!doctype html>"\n')).toBe(0)
  })

  for (const [name, file, text] of cases.filter(c => c[3] > 0)) {
    it(`keeps ${name} first after a fix`, () => {
      const style = commentStyle(file)!
      const fixed = addHeader(file, text, style)
      expect(fixed.split('\n')[0]).toBe(text.split('\n')[0])
      expect(hasHeader(file, fixed, style)).toBe(true)
    })
  }

  it('puts the header BELOW a doctype, not above it', () => {
    const fixed = addHeader('x.html', '<!DOCTYPE html>\n<html lang="en">\n', markup)
    const lines = fixed.split('\n')
    expect(lines[0]).toBe('<!DOCTYPE html>')
    expect(lines[1]).toBe(`<!-- ${SPDX} -->`)
  })

  it('puts the header BELOW a shebang, not above it', () => {
    const fixed = addHeader('x.sh', '#!/usr/bin/env bash\nset -e\n', hash)
    const lines = fixed.split('\n')
    expect(lines[0]).toBe('#!/usr/bin/env bash')
    expect(lines[1]).toBe(`# ${SPDX}`)
  })
})

// ---------------------------------------------------------------------------

describe('comment syntax matches the file kind', () => {
  it('picks the right style per extension', () => {
    expect(commentStyle('a.ts')).toEqual({ open: '// ', close: '' })
    expect(commentStyle('a.rs')).toEqual({ open: '// ', close: '' })
    expect(commentStyle('a.swift')).toEqual({ open: '// ', close: '' })
    expect(commentStyle('a.mjs')).toEqual({ open: '// ', close: '' })
    expect(commentStyle('a.cjs')).toEqual({ open: '// ', close: '' })
    expect(commentStyle('a.css')).toEqual({ open: '/* ', close: ' */' })
    expect(commentStyle('a.py')).toEqual({ open: '# ', close: '' })
    expect(commentStyle('a.sh')).toEqual({ open: '# ', close: '' })
    expect(commentStyle('a.html')).toEqual({ open: '<!-- ', close: ' -->' })
    expect(commentStyle('a.sql')).toEqual({ open: '-- ', close: '' })
  })

  it('covers nothing it has no comment syntax for', () => {
    for (const f of ['a.json', 'a.md', 'a.yml', 'a.toml', 'a.png', 'a.svg', 'Makefile']) {
      expect(commentStyle(f)).toBeNull()
    }
  })

  it('writes each kind in its own syntax', () => {
    expect(addHeader('a.ts', 'x\n', slash).split('\n')[0]).toBe(`// ${SPDX}`)
    expect(addHeader('a.css', 'x\n', block).split('\n')[0]).toBe(`/* ${SPDX} */`)
    expect(addHeader('a.py', 'x\n', hash).split('\n')[0]).toBe(`# ${SPDX}`)
    expect(addHeader('a.html', 'x\n', markup).split('\n')[0]).toBe(`<!-- ${SPDX} -->`)
    expect(addHeader('a.sql', 'x\n', dash).split('\n')[0]).toBe(`-- ${SPDX}`)
  })

  // Both directions. A markup header in a code file is a syntax error; a code
  // header in a markup file renders as visible text on the page.
  it('REJECTS a markup-style header in a code file', () => {
    const text = `<!-- ${SPDX} -->\n<!-- ${COPYRIGHT} -->\n\nexport const x = 1\n`
    expect(hasHeader('a.ts', text, slash)).toBe(false)
  })

  it('REJECTS a code-style header in a markup file', () => {
    const text = `// ${SPDX}\n// ${COPYRIGHT}\n\n<div></div>\n`
    expect(hasHeader('a.html', text, markup)).toBe(false)
  })

  it('REJECTS an unterminated block comment in CSS', () => {
    const text = `/* ${SPDX}\n/* ${COPYRIGHT}\n\nbody { color: red }\n`
    expect(hasHeader('a.css', text, block)).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('the year may move; the holder may not', () => {
  const withCopyright = (line: string): string => `// ${SPDX}\n// ${line}\n\nexport const x = 1\n`

  it('accepts the current year', () => {
    expect(hasHeader('a.ts', withCopyright('Copyright 2026 The Zyra Project'), slash)).toBe(true)
  })

  it('accepts a widened range', () => {
    expect(hasHeader('a.ts', withCopyright('Copyright 2026-2027 The Zyra Project'), slash)).toBe(true)
  })

  it('accepts a later year', () => {
    expect(hasHeader('a.ts', withCopyright('Copyright 2031 The Zyra Project'), slash)).toBe(true)
  })

  it('REJECTS a different holder', () => {
    expect(hasHeader('a.ts', withCopyright('Copyright 2026 Somebody Else'), slash)).toBe(false)
  })

  it('REJECTS a holder with something appended', () => {
    expect(hasHeader('a.ts', withCopyright('Copyright 2026 The Zyra Project, Inc.'), slash)).toBe(false)
  })

  it('REJECTS a holder with something prepended', () => {
    expect(hasHeader('a.ts', withCopyright('Copyright 2026 Not The Zyra Project'), slash)).toBe(false)
  })

  it('REJECTS a missing year', () => {
    expect(hasHeader('a.ts', withCopyright('Copyright The Zyra Project'), slash)).toBe(false)
  })

  it('REJECTS a two-digit year', () => {
    expect(hasHeader('a.ts', withCopyright('Copyright 26 The Zyra Project'), slash)).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('discovery covers untracked files and skips ignored ones', () => {
  function repo(): string {
    const dir = tempDir()
    execFileSync('git', ['init', '-q'], { cwd: dir })
    writeFileSync(join(dir, '.gitignore'), 'ignored/\nnode_modules/\ngenerated.ts\n')

    writeFileSync(join(dir, 'tracked.ts'), 'export const a = 1\n')
    execFileSync('git', ['add', 'tracked.ts'], { cwd: dir })

    // Written but not yet `git add`ed — the file whose header CI would catch
    // and a tracked-only check would not.
    writeFileSync(join(dir, 'untracked.ts'), 'export const b = 2\n')

    writeFileSync(join(dir, 'generated.ts'), 'export const c = 3\n')
    mkdirSync(join(dir, 'ignored'), { recursive: true })
    writeFileSync(join(dir, 'ignored', 'thing.ts'), 'export const d = 4\n')
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.ts'), 'export const e = 5\n')
    writeFileSync(join(dir, 'notes.md'), '# not source\n')
    writeFileSync(join(dir, 'data.json'), '{}\n')
    return dir
  }

  it('lists tracked AND untracked source, and nothing ignored', () => {
    expect(sourceFiles(repo())).toEqual(['tracked.ts', 'untracked.ts'])
  })

  it('flags an untracked file before it is ever staged', () => {
    const { missing } = check(repo(), false)
    expect(missing).toContain('untracked.ts')
  })

  it('never flags a file it does not cover', () => {
    const { missing } = check(repo(), false)
    expect(missing).not.toContain('notes.md')
    expect(missing).not.toContain('data.json')
  })
})

// ---------------------------------------------------------------------------

describe('--fix is idempotent and repairs rather than stacks', () => {
  it('produces the same text when applied twice', () => {
    const once = addHeader('a.ts', 'export const x = 1\n', slash)
    expect(addHeader('a.ts', once, slash)).toBe(once)
  })

  it('leaves exactly one SPDX line after repeated fixes', () => {
    let text = 'export const x = 1\n'
    for (let i = 0; i < 3; i++) text = addHeader('a.ts', text, slash)
    expect(text.split('\n').filter(l => l.includes(SPDX))).toHaveLength(1)
  })

  it('repairs an SPDX line with no copyright line under it', () => {
    // The real shape of two files in this repository before the sweep.
    const before = `// ${SPDX}\n/**\n * What this file is for.\n */\nexport const x = 1\n`
    const after = addHeader('a.ts', before, slash)
    expect(after.split('\n').filter(l => l.includes(SPDX))).toHaveLength(1)
    expect(hasHeader('a.ts', after, slash)).toBe(true)
    expect(after).toContain(' * What this file is for.')
  })

  it('repairs a header written without the space after the comment marker', () => {
    // Found in review. The repair used to match `style.open` verbatim, trailing
    // space included, so a header one space short was invisible to it and
    // `--fix` prepended a second one above the first.
    const before = `//${SPDX}\n//${COPYRIGHT}\n\nexport const x = 1\n`
    const after = addHeader('a.ts', before, slash)
    expect(after.split('\n').filter(l => l.includes(SPDX))).toHaveLength(1)
    expect(hasHeader('a.ts', after, slash)).toBe(true)
  })

  it('repairs a marker-without-space header in EVERY comment style', () => {
    // The bug was in the shared code path, so one style passing proves nothing.
    const cases: Array<[string, string]> = [
      ['a.ts', `//${SPDX}\n//${COPYRIGHT}\n\nexport const x = 1\n`],
      ['a.css', `/*${SPDX}*/\n/*${COPYRIGHT}*/\n\nbody { color: red }\n`],
      ['a.py', `#${SPDX}\n#${COPYRIGHT}\n\nimport sys\n`],
      ['a.html', `<!--${SPDX}-->\n<!--${COPYRIGHT}-->\n\n<div></div>\n`],
      ['a.sql', `--${SPDX}\n--${COPYRIGHT}\n\nSELECT 1;\n`],
    ]
    for (const [file, before] of cases) {
      const style = commentStyle(file)!
      const after = addHeader(file, before, style)
      expect(after.split('\n').filter(l => l.includes(SPDX)), file).toHaveLength(1)
      expect(hasHeader(file, after, style), file).toBe(true)
    }
  })

  it('repairs a header written with extra spaces after the marker', () => {
    const before = `//   ${SPDX}\n//   ${COPYRIGHT}\n\nexport const x = 1\n`
    const after = addHeader('a.ts', before, slash)
    expect(after.split('\n').filter(l => l.includes(SPDX))).toHaveLength(1)
    expect(hasHeader('a.ts', after, slash)).toBe(true)
  })

  it('does NOT consume a bare copyright line that is not ours', () => {
    // A copyright with no SPDX line above it is somebody else's notice, and
    // quietly overwriting it with our holder is worse than a missing header.
    // Such files belong in EXEMPT; the repair must not eat the line meanwhile.
    const before = `// Copyright 2019 Some Other Author\n\nexport const x = 1\n`
    const after = addHeader('a.ts', before, slash)
    expect(after).toContain('Copyright 2019 Some Other Author')
  })

  it('repairs a stale holder instead of stacking a second header above it', () => {
    const before = `// ${SPDX}\n// Copyright 2024 Somebody Else\n\nexport const x = 1\n`
    const after = addHeader('a.ts', before, slash)
    expect(after.split('\n').filter(l => l.includes(SPDX))).toHaveLength(1)
    expect(after).not.toContain('Somebody Else')
    expect(hasHeader('a.ts', after, slash)).toBe(true)
  })

  it('leaves exactly one blank line between the header and the body', () => {
    const after = addHeader('a.ts', '\n\n\nexport const x = 1\n', slash)
    expect(after).toBe(`// ${SPDX}\n// ${COPYRIGHT}\n\nexport const x = 1\n`)
  })

  it('does not disturb the rest of the file', () => {
    const body = 'export const x = 1\n\nexport function f(): void {}\n'
    expect(addHeader('a.ts', body, slash).endsWith(body)).toBe(true)
  })

  it('writes headers to disk and then reports a clean tree', () => {
    const dir = tempDir()
    execFileSync('git', ['init', '-q'], { cwd: dir })
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(dir, 'b.html'), '<!DOCTYPE html>\n<html></html>\n')
    writeFileSync(join(dir, 'c.sh'), '#!/usr/bin/env bash\nset -e\n')
    execFileSync('git', ['add', '.'], { cwd: dir })

    expect(check(dir, true).missing).toHaveLength(3)
    expect(check(dir, false).missing).toHaveLength(0)
    // Re-running --fix on a clean tree changes nothing.
    expect(check(dir, true).missing).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------

describe('one source of truth for the holder', () => {
  function manifests(dir: string, over: Record<string, string> = {}): void {
    const files: Record<string, string> = {
      LICENSE: `Apache License\n\n   ${COPYRIGHT}\n`,
      NOTICE: `TerraViz\n${COPYRIGHT}\n`,
      'package.json': JSON.stringify({ name: 'x', license: LICENSE_ID }, null, 2),
      'CITATION.cff': `cff-version: 1.2.0\ntitle: X\nlicense: ${LICENSE_ID}\n`,
      ...over,
    }
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  }

  it('is quiet when every manifest agrees', () => {
    const dir = tempDir()
    manifests(dir)
    expect(metadataDrift(dir)).toEqual([])
  })

  it('catches a NOTICE that has drifted from the header constant', () => {
    const dir = tempDir()
    manifests(dir, { NOTICE: 'TerraViz\nCopyright 2026 Somebody Else\n' })
    expect(metadataDrift(dir).join('\n')).toContain('NOTICE')
  })

  it('catches a LICENSE that has drifted', () => {
    const dir = tempDir()
    manifests(dir, { LICENSE: 'Apache License\n\n   Copyright 2024 Somebody Else\n' })
    expect(metadataDrift(dir).join('\n')).toContain('LICENSE')
  })

  it('catches a package.json with no license field', () => {
    // The state this repository was actually in: a manifest declaring `bin`,
    // so npm would have published it recorded as unlicensed.
    const dir = tempDir()
    manifests(dir, { 'package.json': JSON.stringify({ name: 'x' }) })
    expect(metadataDrift(dir).join('\n')).toContain('package.json')
  })

  it('catches a package.json naming a different licence', () => {
    const dir = tempDir()
    manifests(dir, { 'package.json': JSON.stringify({ name: 'x', license: 'MIT' }) })
    expect(metadataDrift(dir).join('\n')).toContain('"MIT"')
  })

  it('catches a CITATION.cff naming a different licence', () => {
    const dir = tempDir()
    manifests(dir, { 'CITATION.cff': 'cff-version: 1.2.0\nlicense: MIT\n' })
    expect(metadataDrift(dir).join('\n')).toContain('CITATION.cff')
  })

  it('catches a Cargo manifest naming a different licence', () => {
    const dir = tempDir()
    manifests(dir)
    mkdirSync(join(dir, 'src-tauri'), { recursive: true })
    writeFileSync(join(dir, 'src-tauri', 'Cargo.toml'), '[package]\nname = "x"\nlicense = "MIT"\n')
    expect(metadataDrift(dir).join('\n')).toContain('src-tauri/Cargo.toml')
  })

  it('reports a missing NOTICE rather than passing silently', () => {
    const dir = tempDir()
    manifests(dir)
    rmSync(join(dir, 'NOTICE'))
    expect(metadataDrift(dir).join('\n')).toContain('NOTICE is missing')
  })
})
