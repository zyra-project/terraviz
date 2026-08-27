// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Reports Git LFS files that are still pointer stubs in the working tree.
 *
 * ## The failure this exists for
 *
 * The repo tracks the skybox faces and the Earth specular map with Git
 * LFS. `git clone` does not fetch them unless git-lfs is installed and
 * `git lfs install` has been run, and when it has not, what lands on
 * disk is a 131-byte text file still named `.jpg`:
 *
 *     version https://git-lfs.github.com/spec/v1
 *     oid sha256:37c533d38ee7e1385236a79a49895c58be10d7c2b507ff419…
 *     size 414140
 *
 * Nothing reports this. Vite copies `public/` verbatim without looking
 * inside it, so `npm run build` finishes with zero errors and the
 * pointers ride into `dist/` under their image names. The deploy is
 * green. The globe comes up with no stars, and there is no error
 * anywhere connecting that to a clone made twenty minutes earlier.
 *
 * That is the whole argument for this file: the failure is silent, and a
 * silent failure is the kind worth spending a check on.
 *
 * ## Why it is advisory, and not in the `type-check` chain
 *
 * Mirrors `check-doc-freshness.ts`, for a related reason. `desktop.yml`
 * and `mobile.yml` check out **without** LFS on pull requests, on
 * purpose — their comment says the textures are not needed for `--debug`
 * validation, and skipping the fetch is faster. Those jobs then run a
 * build. A hard gate in `prebuild` would break them for doing the right
 * thing, and the fix people reach for when a guard is wrong is to delete
 * the guard.
 *
 * So: reports by default and exits 0. `--strict` exits non-zero, and is
 * wired into the one job where a pointer would actually reach the
 * public — `ci.yml`'s deploy, which already passes `lfs: true`.
 *
 * ## Why content and not attributes
 *
 * 34 tracked files match a `filter=lfs` pattern; only 22 are pointers.
 * The other 12 — the `luma-check` fixtures, the events-tab handoff
 * screenshots — were committed as ordinary blobs before or around the
 * pattern being added, and are real bytes on disk. Reporting anything
 * that merely *matches* the attribute would flag all 12 every run, and a
 * check that cries wolf every run gets muted. So the attribute picks the
 * candidates and the file's own first bytes decide.
 *
 * `git check-attr` does the matching rather than a hand-rolled glob:
 * `.gitattributes` here has three negation lines (`public/*.png`,
 * `src-tauri/icons/*.png`, `src-tauri/gen/**\/*.png` are `-filter`), and
 * reimplementing precedence between those and the `*.png` catch-all
 * above them is a bug waiting to happen. git already knows.
 */

import { closeSync, openSync, readSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** First line of every pointer file, fixed by the LFS v1 spec. */
export const POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1'

/** Enough to see the prefix. A whole pointer is ~130 bytes; a real
 *  asset may be hundreds of MB, so never read one to find out. */
const HEAD_BYTES = 64

/**
 * Paths whose contents ship to users, and therefore turn a pointer into
 * a broken deploy rather than a broken README image. Reported separately
 * because the two deserve different urgency.
 */
const SHIPPED_PREFIXES = ['public/', 'poster/'] as const

export interface Pointer {
  readonly file: string
  /** True when this file is served to users, not just read in the repo. */
  readonly shipped: boolean
}

export function isPointer(head: string): boolean {
  return head.startsWith(POINTER_PREFIX)
}

export function isShipped(file: string): boolean {
  return SHIPPED_PREFIXES.some(p => file.startsWith(p))
}

/**
 * Pull the `filter=lfs` paths out of `git check-attr --stdin -z filter`.
 *
 * The stream is flat NUL-separated triples — path, attribute, value —
 * with no record terminator, which is why this walks in threes rather
 * than splitting on something.
 */
export function parseCheckAttr(stdout: string): string[] {
  const parts = stdout.split('\0')
  const files: string[] = []
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if (parts[i + 2] === 'lfs') files.push(parts[i])
  }
  return files
}

/** First bytes of a file, or `null` if it cannot be read. */
export function readHead(file: string): string | null {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const read = readSync(fd, buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, read).toString('utf8')
  } catch {
    // A tracked file can be legitimately absent from the working tree
    // (sparse checkout, or mid-rebase). Not this check's business.
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function findPointers(
  files: readonly string[],
  read: (file: string) => string | null = readHead,
): Pointer[] {
  return files
    .filter(f => {
      const head = read(f)
      return head !== null && isPointer(head)
    })
    .map(f => ({ file: f, shipped: isShipped(f) }))
}

/** Empty string when there is nothing to report. */
export function formatReport(pointers: readonly Pointer[]): string {
  if (pointers.length === 0) return ''

  const shipped = pointers.filter(p => p.shipped)
  const rest = pointers.filter(p => !p.shipped)
  const lines: string[] = [
    '',
    `${pointers.length} Git LFS file(s) are pointer stubs, not their real contents.`,
    '',
  ]

  if (shipped.length > 0) {
    lines.push(
      `These ${shipped.length} are served to users. A build made now succeeds,`,
      'and deploys text files under image names:',
      '',
      ...shipped.map(p => `  ${p.file}`),
      '',
    )
  }
  if (rest.length > 0) {
    lines.push(
      `And ${rest.length} more, in the repo but not shipped:`,
      '',
      ...rest.map(p => `  ${p.file}`),
      '',
    )
  }

  lines.push(
    'Fix:',
    '',
    '  git lfs install    # once per machine; installs the hooks',
    '  git lfs pull       # fetches the real contents',
    '',
    'If `git lfs` is an unknown command, install it first — git-lfs.com,',
    'or `brew install git-lfs` / `apt install git-lfs`. Git for Windows',
    'bundles it, but `git lfs install` is still required once.',
    '',
    'See docs/SELF_HOSTING.md §0.3.',
  )
  return lines.join('\n')
}

/**
 * What asking git produced.
 *
 * `absent` and `failed` both mean "no file list", and collapsing them
 * into one `null` was a real bug rather than a naming quibble: every
 * error became "no git, or not a repository" and exited 0, so a
 * transient git failure in the deploy job would bypass `--strict`
 * while printing a cause that was not the cause. A gate that answers
 * "skipped, on purpose" to something it never diagnosed is the exact
 * silent pass this script exists to catch.
 */
export type LfsListing =
  | { kind: 'ok'; files: string[] }
  /** No git binary, or not a repository. Both are legitimate. */
  | { kind: 'absent'; why: string }
  /** git ran and something else went wrong. Not a skip. */
  | { kind: 'failed'; reason: string }

export interface CheckDeps {
  /** Tracked paths carrying `filter=lfs`. */
  listLfsFiles?: () => LfsListing
  read?: (file: string) => string | null
  log?: (message: string) => void
  warn?: (message: string) => void
  fail?: () => void
}

/**
 * Ask git which tracked files carry `filter=lfs`.
 *
 * Returns `null` rather than throwing when git is unavailable or this is
 * not a repository — a source tarball has no `.git`, and refusing to run
 * there would make this check a reason not to ship tarballs.
 */
export function listLfsFiles(): LfsListing {
  const opts = { encoding: 'utf8' as const, maxBuffer: 32 * 1024 * 1024 }
  try {
    // stderr is captured rather than inherited so git's own "fatal: not
    // a git repository" cannot print above the line explaining the
    // skip — but it is captured rather than discarded, because it is
    // what distinguishes a legitimate skip from a real failure.
    const tracked = execFileSync('git', ['ls-files', '-z'], {
      ...opts,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const attrs = execFileSync('git', ['check-attr', '--stdin', '-z', 'filter'], {
      ...opts,
      input: tracked,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { kind: 'ok', files: parseCheckAttr(attrs) }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string }
    if (e.code === 'ENOENT') {
      return { kind: 'absent', why: 'git is not installed' }
    }
    const stderr = String(e.stderr ?? '')
    if (/not a git repository/i.test(stderr)) {
      return { kind: 'absent', why: 'not a git repository' }
    }
    // Anything else: a broken index, a permissions problem, git killed
    // mid-run. Report it rather than calling it a skip.
    const first = stderr.trim().split('\n')[0] || e.message || 'unknown error'
    return { kind: 'failed', reason: first }
  }
}

export function run(argv: readonly string[] = process.argv.slice(2), deps: CheckDeps = {}): void {
  const strict = argv.includes('--strict')
  // Suppresses the success line so a hook can run this every boot and
  // stay silent until something is actually wrong.
  const quiet = argv.includes('--quiet')

  const list = deps.listLfsFiles ?? listLfsFiles
  const read = deps.read ?? readHead
  // eslint-disable-next-line no-console
  const log = deps.log ?? ((m: string) => console.log(m))
  const warn = deps.warn ?? ((m: string) => console.error(m))
  const fail = deps.fail ?? (() => process.exit(1))

  const listing = list()
  if (listing.kind === 'absent') {
    // A source tarball has no .git, and a check that made tarballs
    // unshippable would be a worse bug than the one it detects.
    if (!quiet) log(`\u00b7 Git LFS check skipped \u2014 ${listing.why}.`)
    return
  }
  if (listing.kind === 'failed') {
    warn(
      `Git LFS check could not run: ${listing.reason}\n` +
        'This is not a clean skip — git was present and the command failed, ' +
        'so nothing was verified.',
    )
    if (strict) fail()
    return
  }

  const files = listing.files
  const pointers = findPointers(files, read)
  const report = formatReport(pointers)
  if (report) {
    warn(report)
    if (strict) fail()
    return
  }
  if (quiet) return
  log(`✓ ${files.length} Git LFS-tracked file(s) present as real content.`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
