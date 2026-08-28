// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdownRenderer'

describe('renderMarkdown — empty input handling', () => {
  it.each<[string | null | undefined, string]>([
    [null, ''],
    [undefined, ''],
    ['', ''],
  ])('returns empty string for %j input', (input, expected) => {
    expect(renderMarkdown(input)).toBe(expected)
  })
})

describe('renderMarkdown — happy-path markdown', () => {
  it('renders **bold** as <strong>', () => {
    expect(renderMarkdown('This is **bold** text.')).toContain('<strong>bold</strong>')
  })

  it('renders *italic* as <em>', () => {
    expect(renderMarkdown('This is *italic* text.')).toContain('<em>italic</em>')
  })

  it('renders # heading as <h2> (or higher) within the allowlist', () => {
    // marked maps `# ` to h1 by default, but our allowlist
    // doesn't include H1 — the sanitizer unwraps it. Two-#
    // headings (`## `) → h2 which IS allowed.
    expect(renderMarkdown('## Section')).toContain('<h2>Section</h2>')
    expect(renderMarkdown('### Sub')).toContain('<h3>Sub</h3>')
    expect(renderMarkdown('#### Sub-sub')).toContain('<h4>Sub-sub</h4>')
  })

  it('unwraps h1 (allowlist starts at h2)', () => {
    const html = renderMarkdown('# Big')
    expect(html).not.toContain('<h1')
    expect(html).toContain('Big')
  })

  it('renders bullet lists', () => {
    const html = renderMarkdown('- one\n- two\n- three')
    expect(html).toContain('<ul>')
    expect(html).toMatch(/<li>\s*one\s*<\/li>/)
    expect(html).toMatch(/<li>\s*three\s*<\/li>/)
  })

  it('renders ordered lists', () => {
    const html = renderMarkdown('1. first\n2. second')
    expect(html).toContain('<ol>')
  })

  it('renders blockquotes', () => {
    expect(renderMarkdown('> quoted text')).toContain('<blockquote>')
  })

  it('renders fenced code blocks', () => {
    const html = renderMarkdown('```\nconst x = 1\n```')
    expect(html).toContain('<pre>')
    expect(html).toContain('const x = 1')
  })

  it('renders inline code', () => {
    expect(renderMarkdown('this is `inline` code')).toContain('<code>inline</code>')
  })

  it('renders a horizontal rule', () => {
    expect(renderMarkdown('above\n\n---\n\nbelow')).toContain('<hr>')
  })

  it('renders markdown links with safe http scheme', () => {
    const html = renderMarkdown('[example](https://example.org)')
    expect(html).toContain('href="https://example.org"')
    expect(html).toContain('>example</a>')
  })
})

describe('renderMarkdown — sanitisation', () => {
  it('strips a raw <script> tag (leaves its text content as inert text)', () => {
    // The sanitizer's allowlist policy is "unwrap rather than
    // delete": the <script> wrapper is removed, but the text
    // inside is preserved. That's harmless — text-only "alert(1)"
    // in the DOM cannot execute. The hostile element is gone.
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('</script>')
  })

  it('strips inline event handlers', () => {
    // marked doesn't typically generate these, but a publisher
    // could write raw HTML inside their markdown. Verify the
    // sanitizer catches it.
    const html = renderMarkdown('<a href="https://x.org" onclick="hack()">x</a>')
    expect(html).not.toContain('onclick')
  })

  it('strips javascript: hrefs', () => {
    const html = renderMarkdown('[click](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
  })

  it('strips data: hrefs', () => {
    const html = renderMarkdown('[click](data:text/html,<h1>pwn</h1>)')
    expect(html).not.toContain('data:')
  })

  it('strips a tag that is not in the markdown allowlist (e.g., <img>)', () => {
    const html = renderMarkdown('inline <img src="x" onerror="hack()"> image')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('onerror')
  })

  it('unwraps a disallowed tag while keeping its text', () => {
    const html = renderMarkdown('<details><summary>title</summary>body</details>')
    expect(html).not.toContain('<details')
    expect(html).not.toContain('<summary')
    expect(html).toContain('title')
    expect(html).toContain('body')
  })

  it('forces noopener noreferrer on target=_blank anchors', () => {
    const html = renderMarkdown(
      '<a href="https://example.org" target="_blank">x</a>',
    )
    expect(html).toContain('target="_blank"')
    expect(html).toMatch(/rel="(noopener noreferrer|noreferrer noopener)"/)
  })

  it('leaves a link without target untouched (no rel injection)', () => {
    const html = renderMarkdown('[plain](https://example.org)')
    expect(html).not.toContain('rel=')
  })
})
