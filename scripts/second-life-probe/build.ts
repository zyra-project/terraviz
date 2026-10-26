// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Embeds `probe.html` into `probe.template.lsl`, producing
 * `terraviz-probe.lsl` — the script someone pastes into a prim.
 *
 * LSL has no way to read a file at run time, so the page has to travel
 * inside the script as string constants. Each line of the page becomes
 * one `s += "...\n";` statement, which keeps the generated script
 * readable and line-for-line comparable with the page it came from.
 *
 * The page is embedded **verbatim**, never escaped. A page that needed
 * escaping would no longer be byte-for-byte the page that was tested in
 * a browser, and the point of generating the script is that it is. So
 * `unembeddable` refuses the two characters an LSL string literal would
 * need escaped (`"` and `\`) and anything outside printable ASCII, and
 * the page is written to need none of them — `String.fromCharCode(34)`
 * where it needs a quote, `String.fromCharCode(10)` for a newline.
 *
 * Pure: strings in, strings out. The command-line wrapper in `index.ts`
 * owns the files.
 */

/** The line in the template that the page replaces. */
export const PAGE_MARKER = '//@@PAGE@@'

const STATEMENT = /^ {4}s \+= "(.*)\\n";$/gm

/** The characters the script carries for the page, past which a page
 *  edit risks the script running out of memory while it builds the page
 *  (a Stack-Heap Collision in-world). The version run in-world embedded
 *  up to 7,347 in a script that also took the node check's 16 KB
 *  replies, and stayed up — but nothing measured its peak while building
 *  the page. The probe now reports that peak on every page it serves:
 *  raise this with a reading from it, not by guessing. */
export const MAX_EMBEDDED_CHARACTERS = 8192

/** Windows line endings, and a byte-order mark an editor may have saved. */
function normalize(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

/** Every character the page could not carry into an LSL string literal. */
export function unembeddable(page: string): { line: number; char: string }[] {
  const found: { line: number; char: string }[] = []
  normalize(page).split('\n').forEach((text, i) => {
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0
      if (char === '"' || char === '\\' || code < 32 || code > 126) found.push({ line: i + 1, char })
    }
  })
  return found
}

/** The page as the script carries it: trimmed lines, blank ones dropped. */
export function embeddedLines(page: string): string[] {
  return normalize(page).split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

export function buildProbeScript(page: string, template: string): string {
  const bad = unembeddable(page)
  if (bad.length > 0) {
    // As a code point, since several of these are invisible when printed.
    const sample = bad.slice(0, 5).map((b) => `line ${b.line} U+${(b.char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`).join(', ')
    throw new Error(`probe.html has characters an LSL string literal would need escaped: ${sample}`)
  }
  const tpl = normalize(template)
  if (tpl.split(PAGE_MARKER).length !== 2) {
    throw new Error(`probe.template.lsl must contain ${PAGE_MARKER} exactly once`)
  }
  const body = embeddedLines(page).map((line) => `    s += "${line}\\n";`).join('\n')
  // A function, because a replacement *string* reads `$&`, `$'` and the
  // rest as patterns, and the page is code that must arrive as written.
  return tpl.replace(PAGE_MARKER, () => body)
}

/** The page a generated script would serve, reassembled from its statements. */
export function servedPage(script: string): string {
  return [...normalize(script).matchAll(STATEMENT)].map((m) => `${m[1]}\n`).join('')
}
