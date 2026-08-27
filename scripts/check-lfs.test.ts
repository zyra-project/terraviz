// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import {
  POINTER_PREFIX,
  findPointers,
  formatReport,
  isPointer,
  isShipped,
  parseCheckAttr,
  run,
} from './check-lfs'

/** A real pointer file, byte for byte, minus the trailing newline. */
const POINTER = `${POINTER_PREFIX}\noid sha256:37c533d38ee7e1385236a79a49895c58be10d7c2b507ff419fe36ca06ceadda2\nsize 414140\n`

/** What the first 64 bytes of a JPEG actually look like. */
const JPEG_HEAD = '\xFF\xD8\xFF\xE0\x00\x10JFIF\x00\x01\x01\x01\x00H\x00H\x00\x00'

describe('isPointer', () => {
  it('recognises a pointer by its spec line', () => {
    expect(isPointer(POINTER)).toBe(true)
  })

  it('does not mistake real image bytes for one', () => {
    expect(isPointer(JPEG_HEAD)).toBe(false)
    expect(isPointer('')).toBe(false)
  })

  // The check only ever reads the first 64 bytes, so a pointer must be
  // identifiable from a truncated read. It is: the spec line is 41 bytes.
  it('works on a truncated read', () => {
    expect(isPointer(POINTER.slice(0, 64))).toBe(true)
  })

  // Guards against relaxing this to `includes`. A file that merely
  // mentions the spec URL — this test file, for one — is not a pointer.
  it('requires the prefix at the start, not anywhere', () => {
    expect(isPointer(`# see ${POINTER_PREFIX} for details`)).toBe(false)
  })
})

describe('parseCheckAttr', () => {
  // git emits flat NUL-separated triples with no record terminator.
  const triples = (rows: [string, string][]): string =>
    rows.map(([f, v]) => `${f}\0filter\0${v}\0`).join('')

  it('keeps only the paths whose filter is lfs', () => {
    const out = triples([
      ['src/main.ts', 'unspecified'],
      ['public/assets/skybox/nx.jpg', 'lfs'],
      ['public/favicon.png', 'unset'],
      ['initial-interface.jpg', 'lfs'],
    ])
    expect(parseCheckAttr(out)).toEqual([
      'public/assets/skybox/nx.jpg',
      'initial-interface.jpg',
    ])
  })

  // `unset` is what the three negation lines in .gitattributes produce
  // (`public/*.png -filter`). Treating "has a filter attribute at all"
  // as LFS would re-flag every app icon the negations exist to exempt.
  it('does not treat unset or unspecified as lfs', () => {
    expect(parseCheckAttr(triples([['a.png', 'unset'], ['b.ts', 'unspecified']]))).toEqual([])
  })

  it('tolerates an empty or trailing-garbage stream', () => {
    expect(parseCheckAttr('')).toEqual([])
    expect(parseCheckAttr('incomplete\0filter\0')).toEqual([])
  })
})

describe('findPointers', () => {
  // The distinction the whole check turns on: an attribute match is a
  // candidate, the file's own bytes are the verdict. 12 files in this
  // repo carry filter=lfs and hold real bytes; flagging them every run
  // is how a check gets muted.
  it('reports pointers and ignores real bytes under the same attribute', () => {
    const heads: Record<string, string> = {
      'public/assets/skybox/nx.jpg': POINTER,
      'public/luma-check/out/A_today.mp4': JPEG_HEAD,
      'initial-interface.jpg': POINTER,
    }
    const found = findPointers(Object.keys(heads), f => heads[f] ?? null)
    expect(found.map(p => p.file)).toEqual([
      'public/assets/skybox/nx.jpg',
      'initial-interface.jpg',
    ])
  })

  it('marks shipped paths, which are the ones that reach users', () => {
    const found = findPointers(
      ['public/assets/skybox/nx.jpg', 'poster/assets/qr/github.png', 'initial-interface.jpg'],
      () => POINTER,
    )
    expect(found.map(p => p.shipped)).toEqual([true, true, false])
  })

  it('skips a file it cannot read rather than reporting it', () => {
    expect(findPointers(['gone.jpg'], () => null)).toEqual([])
  })
})

describe('isShipped', () => {
  it('covers the two trees whose contents are served', () => {
    expect(isShipped('public/assets/skybox/nx.jpg')).toBe(true)
    expect(isShipped('poster/assets/qr/github.png')).toBe(true)
    expect(isShipped('initial-interface.jpg')).toBe(false)
    expect(isShipped('docs/events-tab-handoff/images/01.png')).toBe(false)
  })
})

describe('formatReport', () => {
  it('is empty when everything is materialised', () => {
    expect(formatReport([])).toBe('')
  })

  it('names the files and the repair', () => {
    const report = formatReport([
      { file: 'public/assets/skybox/nx.jpg', shipped: true },
      { file: 'initial-interface.jpg', shipped: false },
    ])
    expect(report).toContain('public/assets/skybox/nx.jpg')
    expect(report).toContain('initial-interface.jpg')
    expect(report).toContain('git lfs install')
    expect(report).toContain('git lfs pull')
    // A reader who has never heard of LFS needs the install, not just
    // the two commands that assume it is present.
    expect(report).toContain('git-lfs.com')
    expect(report).toContain('docs/SELF_HOSTING.md')
  })

  it('separates shipped from not, because they are not equally urgent', () => {
    const shippedOnly = formatReport([{ file: 'public/a.jpg', shipped: true }])
    expect(shippedOnly).toContain('served to users')
    expect(shippedOnly).not.toContain('not shipped')

    const repoOnly = formatReport([{ file: 'initial-interface.jpg', shipped: false }])
    expect(repoOnly).toContain('not shipped')
    expect(repoOnly).not.toContain('served to users')
  })
})

describe('run', () => {
  const harness = (files: string[], head: (f: string) => string | null) => {
    const out: string[] = []
    const err: string[] = []
    let failed = false
    return {
      out,
      err,
      failed: () => failed,
      deps: {
        listLfsFiles: () => ({ kind: 'ok' as const, files }),
        read: head,
        log: (m: string) => out.push(m),
        warn: (m: string) => err.push(m),
        fail: () => {
          failed = true
        },
      },
    }
  }

  it('says so and exits clean when nothing is a pointer', () => {
    const h = harness(['public/a.jpg'], () => JPEG_HEAD)
    run([], h.deps)
    expect(h.out.join('\n')).toContain('real content')
    expect(h.err).toEqual([])
    expect(h.failed()).toBe(false)
  })

  // The load-bearing property: reports, but does not fail the build.
  // desktop.yml and mobile.yml check out without LFS on PRs on purpose
  // and then build; a default-strict check would break them for it.
  it('reports without failing by default', () => {
    const h = harness(['public/a.jpg'], () => POINTER)
    run([], h.deps)
    expect(h.err.join('\n')).toContain('pointer stubs')
    expect(h.failed()).toBe(false)
  })

  it('fails only under --strict', () => {
    const h = harness(['public/a.jpg'], () => POINTER)
    run(['--strict'], h.deps)
    expect(h.failed()).toBe(true)
  })

  it('--quiet stays silent when clean, and still speaks when not', () => {
    const clean = harness(['public/a.jpg'], () => JPEG_HEAD)
    run(['--quiet'], clean.deps)
    expect(clean.out).toEqual([])
    expect(clean.err).toEqual([])

    const broken = harness(['public/a.jpg'], () => POINTER)
    run(['--quiet'], broken.deps)
    expect(broken.err.join('\n')).toContain('pointer stubs')
  })

  // A source tarball has no .git. Refusing to run there would make this
  // check a reason not to ship tarballs.
  it('skips cleanly when there is no git or no repository', () => {
    for (const why of ['git is not installed', 'not a git repository']) {
      const out: string[] = []
      let failed = false
      run(['--strict'], {
        listLfsFiles: () => ({ kind: 'absent', why }),
        log: (m: string) => out.push(m),
        fail: () => {
          failed = true
        },
      })
      expect(out.join('\n')).toContain('skipped')
      expect(out.join('\n'), 'the skip should name its own cause').toContain(why)
      expect(failed, 'a tarball must stay shippable even under --strict').toBe(false)
    }
  })

  /**
   * The distinction Copilot asked for on #359, and it is not cosmetic.
   * Every git failure used to collapse into the same `null`, so a broken
   * index or a killed process printed "no git, or not a repository" and
   * exited 0 — under `--strict`, in the deploy job. The gate would have
   * reported a clean skip for something it never diagnosed, which is the
   * silent pass this whole script exists to catch.
   */
  it('a real git failure is not a skip, and fails under --strict', () => {
    const err: string[] = []
    let failed = false
    run(['--strict'], {
      listLfsFiles: () => ({ kind: 'failed', reason: 'fatal: index file corrupt' }),
      warn: (m: string) => err.push(m),
      fail: () => {
        failed = true
      },
    })
    const text = err.join('\n')
    expect(text, 'the reason git gave should survive to the operator').toContain(
      'index file corrupt',
    )
    expect(text, 'and it must not read as a deliberate skip').toContain('not a clean skip')
    expect(failed).toBe(true)
  })

  it('a real git failure still reports without --strict', () => {
    const err: string[] = []
    let failed = false
    run([], {
      listLfsFiles: () => ({ kind: 'failed', reason: 'fatal: index file corrupt' }),
      warn: (m: string) => err.push(m),
      fail: () => {
        failed = true
      },
    })
    expect(err.join('\n')).toContain('index file corrupt')
    expect(failed, 'advisory by default, same as every other path').toBe(false)
  })
})
