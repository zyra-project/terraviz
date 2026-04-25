/**
 * Tests for the privacy-page generator.
 *
 * Covers two concerns:
 *   1. the renderer's output shape — still self-contained, still
 *      obeys the CSP promise, still contains every section heading
 *      from the Markdown
 *   2. drift detection — the committed `public/privacy.html` must
 *      match what the renderer produces from the current
 *      `docs/PRIVACY.md`. Same guarantee as the old
 *      privacyParity.test.ts but checked from the single source
 *      instead of two hand-maintained files.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderPrivacyPage, stripInternalBlocks } from './build-privacy-page'

// `package.json` declares `"type": "module"`, so `__dirname` is not a
// runtime global. Vitest happens to inject a compat shim today, but
// the underlying script (`build-privacy-page.ts`) uses the ESM
// idiom — match it here so the test works under any runner.
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const MD_PATH = resolve(REPO_ROOT, 'docs/PRIVACY.md')
const HTML_PATH = resolve(REPO_ROOT, 'public/privacy.html')

describe('stripInternalBlocks', () => {
  it('removes content wrapped in internal-only comments', () => {
    const md = [
      '# Title',
      '',
      '<!-- internal-only -->',
      'secret note',
      '<!-- /internal-only -->',
      '',
      'public body',
    ].join('\n')
    const out = stripInternalBlocks(md)
    expect(out).not.toContain('secret note')
    expect(out).toContain('public body')
    expect(out).toContain('# Title')
  })

  it('tolerates variant whitespace inside the comment marker', () => {
    const md = '<!--internal-only-->hidden<!--/internal-only-->visible'
    expect(stripInternalBlocks(md)).toBe('visible')
  })

  it('is a no-op when no internal block is present', () => {
    const md = '# Title\n\nbody'
    expect(stripInternalBlocks(md)).toBe(md)
  })

  it('strips multiple blocks independently', () => {
    const md = [
      '<!-- internal-only -->A<!-- /internal-only -->',
      'visible',
      '<!-- internal-only -->B<!-- /internal-only -->',
    ].join('\n')
    const out = stripInternalBlocks(md)
    expect(out).not.toContain('A')
    expect(out).not.toContain('B')
    expect(out).toContain('visible')
  })
})

describe('renderPrivacyPage — output shape', () => {
  const md = readFileSync(MD_PATH, 'utf-8')
  const html = renderPrivacyPage(md)

  it('produces a complete HTML document', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toMatch(/<html[^>]+lang="en"/)
    expect(html.endsWith('</html>\n')).toBe(true)
  })

  it('ships zero <script> tags', () => {
    expect(html).not.toMatch(/<script\b/i)
  })

  it('declares the strict Content-Security-Policy from the plan', () => {
    expect(html).toMatch(
      /<meta[^>]+http-equiv="Content-Security-Policy"[^>]+content="[^"]*default-src 'self'[^"]*script-src 'none'[^"]*"/,
    )
  })

  it('includes the skip-link and main landmark', () => {
    expect(html).toContain('class="skip-link"')
    expect(html).toMatch(/<main id="main"[^>]*tabindex="-1"/)
  })

  it('includes the Back link pointing home', () => {
    expect(html).toMatch(/<a href="\/"[^>]*class="back-link"/)
  })

  it('includes an @media print stylesheet', () => {
    expect(html).toMatch(/@media print\s*\{/)
  })

  it('contains every ## heading from the Markdown source', () => {
    const headings = Array.from(md.matchAll(/^##\s+(.+?)\s*$/gm)).map(
      (m) => m[1],
    )
    expect(headings.length).toBeGreaterThanOrEqual(12)
    // Marked HTML-escapes apostrophes / ampersands / quotes. Decode
    // the common entities in the rendered output so a substring
    // check against the raw Markdown text works.
    const decoded = html
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
    for (const heading of headings) {
      expect(decoded).toContain(heading)
    }
  })

  it('does not leak content wrapped in internal-only blocks', () => {
    // The real MD wraps its draft preamble in <!-- internal-only -->
    // so its contents must not appear in the rendered body. Look at
    // the inner <main> only, not the generator's self-referential
    // header comment.
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/)
    expect(mainMatch).not.toBeNull()
    const mainBody = mainMatch![1]
    expect(mainBody).not.toContain('Draft for review')
    expect(mainBody).not.toContain('edit the Markdown, not the HTML')
  })

  it('renders the canonical GitHub source URL in the footer', () => {
    expect(html).toContain('github.com/zyra-project/terraviz')
  })

  it('is deterministic — identical input produces identical output', () => {
    const a = renderPrivacyPage(md)
    const b = renderPrivacyPage(md)
    expect(a).toBe(b)
  })
})

describe('privacy.html — drift detection', () => {
  it('the committed HTML matches what the current generator produces', () => {
    const md = readFileSync(MD_PATH, 'utf-8')
    const expected = renderPrivacyPage(md)
    const current = readFileSync(HTML_PATH, 'utf-8')
    if (current !== expected) {
      throw new Error(
        'public/privacy.html is stale relative to docs/PRIVACY.md.\n' +
          '  Run `npm run build:privacy-page` and commit the regenerated file.',
      )
    }
  })
})
