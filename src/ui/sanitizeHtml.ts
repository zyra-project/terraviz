// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Allowlist-based HTML sanitizer for untrusted input.
 *
 * Two call sites today:
 *
 * 1. Help-guide section blobs (`help.guide.section.*`) — inline
 *    HTML in locale strings that translators may edit via Weblate.
 *    Without sanitization a translation containing
 *    `<img onerror=...>` or `<script>` would execute when the panel
 *    opens. Defense in depth pairs with `forbiddenPatterns()` in
 *    `scripts/generate-locales.ts`, which fails CI if a locale
 *    string carries an obviously hostile substring.
 * 2. Publisher portal abstract markdown (3pc/A onward) — the
 *    publisher's markdown is parsed by `marked` and the resulting
 *    HTML is sanitized through `sanitizeMarkdownHtml` before
 *    landing in the DOM. Same allowlist pattern, slightly wider
 *    tag set to cover markdown's full output.
 *
 * The allowlists are intentionally small — exactly the tags + attrs
 * each call site actually uses. Anything outside is unwrapped (text
 * content kept, tag dropped) so a typo or unrecognised construct
 * doesn't blank the surrounding block. `href` values are
 * additionally restricted to safe schemes.
 */

/** Tags + attrs allowed in the translator-supplied help-guide
 *  blobs. Narrow surface (the help guide uses these and only
 *  these). */
const GUIDE_TAGS = new Set([
  'SECTION', 'H3', 'H4', 'P', 'UL', 'OL', 'LI',
  'STRONG', 'EM', 'KBD', 'CODE', 'A', 'BR', 'SPAN',
])

/** Tags allowed in markdown-derived HTML (output of `marked`).
 *  Strict superset of the guide set: adds H2, BLOCKQUOTE, PRE, HR,
 *  plus the inline emphasis classes markdown leans on. */
const MARKDOWN_TAGS = new Set([
  'P', 'BR', 'HR',
  'H2', 'H3', 'H4',
  'STRONG', 'EM', 'CODE', 'PRE',
  'UL', 'OL', 'LI',
  'BLOCKQUOTE',
  'A',
])

const ALLOWED_ATTRS_BY_TAG: Readonly<Record<string, ReadonlyArray<string>>> = {
  A: ['href', 'target', 'rel'],
}

/** href schemes we'll accept on `<a>`: http(s), mailto, and same-origin
 *  relative paths. `javascript:`, `data:`, `vbscript:`, etc. fall
 *  through to attribute removal. */
const SAFE_HREF = /^(https?:\/\/|mailto:|\/|#)/i

/**
 * Sanitize a translator-supplied HTML blob against the guide
 * allowlist. Output is safe to set as `innerHTML`. Idempotent.
 *
 * Implementation note: parses via `<template>.innerHTML` rather
 * than `DOMParser` — `<template>` is the
 * <https://developer.mozilla.org/docs/Web/HTML/Element/template>
 * inert-fragment idiom and avoids resource fetches (no `<img src>`
 * load, no script execution) during parsing. The walker then
 * mutates the fragment in place before we read its
 * `innerHTML` back out.
 */
export function sanitizeGuideHtml(html: string): string {
  return sanitizeWith(html, GUIDE_TAGS)
}

/**
 * Sanitize the HTML produced by `marked.parse()` against the
 * markdown allowlist. Used by `src/services/markdownRenderer.ts`
 * for the publisher portal's abstract preview.
 *
 * The publisher's input is untrusted (a community publisher may
 * eventually author a malicious abstract), so the `marked` ->
 * sanitize pipeline is what stands between them and a DOM-side XSS.
 */
export function sanitizeMarkdownHtml(html: string): string {
  return sanitizeWith(html, MARKDOWN_TAGS)
}

function sanitizeWith(html: string, allowedTags: ReadonlySet<string>): string {
  if (typeof document === 'undefined') return ''
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  walkAndSanitize(tpl.content, allowedTags)
  return tpl.innerHTML
}

function walkAndSanitize(node: ParentNode, allowedTags: ReadonlySet<string>): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType !== 1 /* ELEMENT_NODE */) continue
    const el = child as Element
    const tag = el.tagName

    if (!allowedTags.has(tag)) {
      // Unwrap rather than delete — preserves visible text so a
      // translator typo (or an unexpected markdown construct)
      // doesn't blank the surrounding block.
      const text = document.createTextNode(el.textContent ?? '')
      el.replaceWith(text)
      continue
    }

    const allowed = ALLOWED_ATTRS_BY_TAG[tag] ?? []
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (!allowed.includes(name)) {
        el.removeAttribute(attr.name)
        continue
      }
      if (name === 'href' && !SAFE_HREF.test(attr.value.trim())) {
        el.removeAttribute(attr.name)
      }
    }

    // Reverse-tabnabbing defense: any <a target="_blank"> must
    // carry rel="noopener noreferrer". A translator (or marked's
    // output) might write a link without rel at all, or omit one
    // of the two tokens — forcibly merge them in. Leaves any
    // other rel tokens legitimately set (e.g. nofollow, ugc)
    // intact.
    if (tag === 'A' && el.getAttribute('target')?.toLowerCase() === '_blank') {
      const existing = (el.getAttribute('rel') ?? '').split(/\s+/).filter(Boolean)
      const lower = new Set(existing.map(token => token.toLowerCase()))
      if (!lower.has('noopener')) existing.push('noopener')
      if (!lower.has('noreferrer')) existing.push('noreferrer')
      el.setAttribute('rel', existing.join(' '))
    }

    walkAndSanitize(el, allowedTags)
  }
}
