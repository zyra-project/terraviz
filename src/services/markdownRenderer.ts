// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Markdown → safe HTML renderer.
 *
 * Two-stage pipeline:
 *
 *   1. `marked.parse` turns the publisher's markdown source into
 *      HTML. We enable GFM (autolinks, fenced code) but the
 *      output is then filtered against the
 *      `MARKDOWN_TAGS` allowlist in `src/ui/sanitizeHtml.ts`,
 *      which intentionally omits tables — GFM `|---|` syntax
 *      will parse but the resulting `<table>` is stripped at
 *      sanitize time. Publisher abstracts don't realistically
 *      use tables, and admitting them would force a styling
 *      surface and a wider attribute allowlist for marginal
 *      value. `breaks: false` keeps the paragraph model
 *      markdown-standard (`\n\n` separates) rather than
 *      GitHub-comment-style.
 *
 *   2. `sanitizeMarkdownHtml` walks the result against the
 *      tag/attr allowlist. Anything outside it —
 *      `<img onerror=…>`, `<script>`, inline event handlers,
 *      `javascript:` hrefs — is unwrapped or stripped. Same
 *      defense in depth the help-guide renderer uses;
 *      publisher input is at least as untrusted as translator
 *      input.
 *
 * Used by the publisher portal's abstract preview (3pc onward) and
 * — once the public dataset detail page surfaces the rendered
 * abstract — by that page too, so what the publisher sees in the
 * portal preview matches the published page byte-for-byte.
 */

import { marked } from 'marked'
import { sanitizeMarkdownHtml } from '../ui/sanitizeHtml'

// `marked` is configured once at module load so every call site
// gets the same options. GFM extensions cover what publishers
// realistically write; breaks: false keeps the paragraph model
// markdown standard rather than GitHub-comment-style.
marked.setOptions({
  gfm: true,
  breaks: false,
})

/**
 * Render a markdown source string to sanitized HTML.
 *
 * Returns an empty string for null / undefined / empty input
 * rather than throwing — call sites typically render the result
 * into the DOM and "no content" should produce no DOM, not an
 * error.
 */
export function renderMarkdown(source: string | null | undefined): string {
  if (!source) return ''
  // `marked.parse` is synchronous when no async extensions are
  // registered. The type union is `string | Promise<string>` to
  // accommodate async tokenizers; we don't use any, so the cast
  // is safe.
  const html = marked.parse(source) as string
  return sanitizeMarkdownHtml(html)
}
