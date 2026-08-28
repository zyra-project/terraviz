// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import { sanitizeGuideHtml } from './sanitizeHtml'

describe('sanitizeGuideHtml', () => {
  it('preserves the allowlisted tags used by the help guide', () => {
    const html = '<h3>Title</h3><ul><li><strong>One</strong></li><li><kbd>Esc</kbd></li></ul><p>Body</p>'
    const out = sanitizeGuideHtml(html)
    expect(out).toContain('<h3>Title</h3>')
    expect(out).toContain('<strong>One</strong>')
    expect(out).toContain('<kbd>Esc</kbd>')
    expect(out).toContain('<p>Body</p>')
  })

  it('drops the <script> tag (its text content survives but is inert)', () => {
    // The walker unwraps disallowed tags, keeping their textContent
    // — for <script>"alert(1)"</script>, the surviving text is
    // exactly "alert(1)" as plain text inside the parent <p>. Plain
    // text is not executable; the browser only parses <script>
    // tags as code, and we've removed the tag. So the safety
    // guarantee holds even though the literal characters "alert(1)"
    // remain on the page as visible text.
    const out = sanitizeGuideHtml('<p>Hello <script>alert(1)</script> world</p>')
    expect(out).not.toMatch(/<\s*script/i)
    expect(out).toContain('Hello')
    expect(out).toContain('world')
  })

  it('strips inline event handlers from allowlisted tags', () => {
    const out = sanitizeGuideHtml('<a href="https://example.com" onclick="alert(1)">link</a>')
    expect(out).toContain('href="https://example.com"')
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('alert(1)')
  })

  it('rejects javascript: hrefs', () => {
    const out = sanitizeGuideHtml('<a href="javascript:alert(1)">click me</a>')
    expect(out).toContain('click me')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('href=')
  })

  it('rejects data: hrefs', () => {
    const out = sanitizeGuideHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>')
    expect(out).not.toContain('data:')
    expect(out).not.toContain('href=')
  })

  it('allows http/https/mailto/relative hrefs on <a>', () => {
    expect(sanitizeGuideHtml('<a href="https://example.com">x</a>')).toContain('href="https://example.com"')
    expect(sanitizeGuideHtml('<a href="http://example.com">x</a>')).toContain('href="http://example.com"')
    expect(sanitizeGuideHtml('<a href="mailto:hi@x.com">x</a>')).toContain('href="mailto:hi@x.com"')
    expect(sanitizeGuideHtml('<a href="/privacy">x</a>')).toContain('href="/privacy"')
    expect(sanitizeGuideHtml('<a href="#section">x</a>')).toContain('href="#section"')
  })

  it('unwraps disallowed tags but keeps their text', () => {
    // `<img>` isn't in the allowlist (and hostile via `onerror=`). The
    // tag is dropped; since <img> is void, there's no text to keep.
    const out = sanitizeGuideHtml('<p>Before <img src=x onerror="alert(1)"> after</p>')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('onerror')
    expect(out).toContain('Before')
    expect(out).toContain('after')
  })

  it('unwraps <iframe> tag (its src/attrs go away; text content survives but is inert)', () => {
    // Same shape as the <script> case above — the disallowed tag
    // is dropped, attributes (incl. the hostile `src`) drop with
    // it, and the textContent ("trapped") is unwrapped to a
    // sibling text node. That's just text, not an embedded frame.
    const out = sanitizeGuideHtml('<p>Hello</p><iframe src="https://evil.example">trapped</iframe>')
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('evil.example')
    expect(out).toContain('Hello')
  })

  it('returns empty string when document is undefined (SSR / non-DOM)', () => {
    // The SSR guard fires when `typeof document === 'undefined'`.
    // happy-dom always provides `document`, so we have to actually
    // unset the global to exercise the branch — otherwise this
    // test would pass even if the guard were removed, leaving a
    // future SSR migration silently emitting unsanitized HTML on
    // the server.
    type GlobalDoc = { document?: Document }
    const original = (globalThis as GlobalDoc).document
    ;(globalThis as GlobalDoc).document = undefined
    try {
      expect(sanitizeGuideHtml('<p>x</p>')).toBe('')
    } finally {
      ;(globalThis as GlobalDoc).document = original
    }
  })

  it('forces rel="noopener noreferrer" on <a target="_blank"> (reverse-tabnabbing defense)', () => {
    // A translator could write `<a target="_blank">link</a>` with
    // no rel at all. Without rel="noopener", window.opener leaks
    // to the destination tab — classic reverse-tabnabbing. The
    // sanitizer enforces both noopener and noreferrer for
    // _blank links regardless of what the translator typed.
    const out = sanitizeGuideHtml('<a href="https://example.com" target="_blank">link</a>')
    expect(out).toContain('rel="noopener noreferrer"')
  })

  it('merges rel tokens — preserves translator-set tokens AND adds noopener/noreferrer', () => {
    // Tokens like `nofollow` or `ugc` may be legitimate translator
    // intent (e.g. linking to a third-party glossary) — we must
    // not clobber them when adding the security tokens.
    const out = sanitizeGuideHtml('<a href="https://example.com" target="_blank" rel="nofollow">link</a>')
    expect(out).toContain('nofollow')
    expect(out).toContain('noopener')
    expect(out).toContain('noreferrer')
  })

  it('does not duplicate rel tokens already set by the translator', () => {
    const out = sanitizeGuideHtml('<a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a>')
    // Each token should appear exactly once.
    expect(out.match(/noopener/g)?.length).toBe(1)
    expect(out.match(/noreferrer/g)?.length).toBe(1)
  })

  it('leaves rel alone when target is not _blank', () => {
    // Same-tab links (no target, or target="_self") don't have
    // the reverse-tabnabbing risk and the sanitizer doesn't
    // pollute their rel attribute.
    const noTarget = sanitizeGuideHtml('<a href="https://example.com">link</a>')
    expect(noTarget).not.toContain('rel=')
    const selfTarget = sanitizeGuideHtml('<a href="https://example.com" target="_self">link</a>')
    expect(selfTarget).not.toContain('noopener')
  })

  it('is idempotent — sanitizing already-sanitized output yields the same result', () => {
    const html = '<h3>Title</h3><ul><li>One</li></ul>'
    expect(sanitizeGuideHtml(sanitizeGuideHtml(html))).toBe(sanitizeGuideHtml(html))
  })
})
