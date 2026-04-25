/**
 * Generate `public/privacy.html` from `docs/PRIVACY.md`.
 *
 * The privacy policy is a legal deliverable, so it ships as a
 * self-contained static page with no scripts and no external
 * assets — see the "/privacy endpoint" section of
 * `docs/ANALYTICS_IMPLEMENTATION_PLAN.md` for the full spec.
 *
 * The Markdown source is the single source of truth. This script:
 *   1. reads `docs/PRIVACY.md`
 *   2. renders it through `marked` (GFM-on)
 *   3. wraps the result in an HTML shell that carries the inline
 *      design-token CSS, tight CSP, print stylesheet, skip-link,
 *      and footer link
 *   4. writes `public/privacy.html`
 *
 * Runs automatically from `predev` / `prebuild` npm hooks so the
 * HTML is always in sync with the Markdown without anyone having
 * to remember. `--check` mode compares the on-disk HTML to a
 * freshly-generated copy — CI uses this to fail the build if a
 * contributor edited the HTML directly or changed the Markdown
 * without regenerating.
 *
 * The rendering is deterministic: the same Markdown input +
 * template always produces byte-identical HTML output.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const REPO_ROOT = resolve(HERE, '..')
const SOURCE = resolve(REPO_ROOT, 'docs/PRIVACY.md')
const OUTPUT = resolve(REPO_ROOT, 'public/privacy.html')

/** Inline design-token CSS + typography + print stylesheet. Kept in
 * this file because the privacy page is self-contained — it cannot
 * `@import` `src/styles/tokens.css` and still work when the SPA
 * bundle is broken. The tokens are a frozen snapshot of the dark
 * palette; updates to the live app's tokens don't auto-propagate
 * here, and that's intentional (legal page stability > aesthetic
 * coupling to the rest of the app). */
const TEMPLATE_CSS = `
:root {
  --color-accent: #4da6ff;
  --color-accent-hover: #6ab8ff;
  --color-accent-dark: #0066cc;
  --color-bg: #0d0d12;
  --color-surface: rgba(255, 255, 255, 0.04);
  --color-surface-border: rgba(255, 255, 255, 0.1);
  --color-text: #e8eaf0;
  --color-text-secondary: #bbb;
  --color-text-muted: #999;
  --radius-md: 6px;
  --radius-lg: 8px;
}

*, *::before, *::after { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 16px;
  line-height: 1.6;
}

.skip-link {
  position: absolute;
  top: -100%;
  left: 1rem;
  z-index: 10000;
  padding: 0.5rem 1rem;
  background: var(--color-accent-dark);
  color: var(--color-text);
  border-radius: 0 0 6px 6px;
  text-decoration: none;
  font-size: 0.875rem;
  transition: top 0.2s;
}
.skip-link:focus { top: 0; }

:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.page {
  max-width: 720px;
  margin: 0 auto;
  padding: 2.5rem 1.25rem 4rem;
}

.back-link {
  display: inline-block;
  margin-bottom: 1.25rem;
  font-size: 0.95rem;
}

main h1 {
  font-size: 1.85rem;
  line-height: 1.25;
  margin: 0 0 0.5rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  border-bottom: 1px solid var(--color-surface-border);
  padding-bottom: 1.25rem;
  margin-bottom: 2rem;
}

main h2 {
  font-size: 1.3rem;
  line-height: 1.3;
  margin: 2.25rem 0 0.75rem;
  font-weight: 600;
  letter-spacing: -0.005em;
}

main h3 {
  font-size: 1.05rem;
  line-height: 1.35;
  margin: 1.5rem 0 0.5rem;
  font-weight: 600;
  color: var(--color-text);
}

main p,
main li {
  margin: 0 0 0.85rem;
}

main ul {
  padding-left: 1.35rem;
  margin: 0 0 1rem;
}

main li { margin-bottom: 0.4rem; }

main a {
  color: var(--color-accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}
main a:hover { color: var(--color-accent-hover); }

main strong { color: var(--color-text); font-weight: 600; }

main em { color: var(--color-text-secondary); }

main code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--color-surface);
  border: 1px solid var(--color-surface-border);
  border-radius: var(--radius-md);
  padding: 0.05rem 0.35rem;
  font-size: 0.9em;
}

main hr {
  border: 0;
  border-top: 1px solid var(--color-surface-border);
  margin: 2.25rem 0;
}

footer.site-footer {
  margin-top: 3rem;
  padding-top: 1.25rem;
  border-top: 1px solid var(--color-surface-border);
  color: var(--color-text-muted);
  font-size: 0.9rem;
}

@media print {
  body {
    background: #fff;
    color: #000;
    font-family: "Times New Roman", Times, Georgia, serif;
    font-size: 11pt;
    line-height: 1.5;
  }
  .skip-link, .back-link, footer.site-footer { display: none; }
  main a { color: #000; text-decoration: underline; }
  main code {
    background: transparent;
    border: 1px solid #999;
    color: #000;
  }
  main h1, main h2, main h3, main strong { color: #000; }
  main em { color: #333; }
  main hr { border-top-color: #999; }
  .page { max-width: none; padding: 0; }
}
`.trim()

/** Strict CSP for the privacy page — exactly matches the plan's
 * "/privacy endpoint" section. No scripts anywhere, no external
 * sources of anything. */
const CSP = [
  "default-src 'self'",
  "style-src 'unsafe-inline'",
  "script-src 'none'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

/** Footer — added by the template, not part of the Markdown. */
const FOOTER_HTML =
  `<p>Source: <a href="https://github.com/zyra-project/terraviz">github.com/zyra-project/terraviz</a>. This page intentionally ships no scripts and no third-party assets.</p>`

/**
 * Strip any `<!-- internal-only -->…<!-- /internal-only -->` blocks
 * from the Markdown before rendering. Lets the source file keep
 * internal notes (draft status, cross-refs to the plan doc, TODO
 * comments for legal review) without shipping them to the public
 * page. Non-greedy, multi-line — nested blocks are not supported.
 */
export function stripInternalBlocks(markdown: string): string {
  return markdown.replace(
    /<!--\s*internal-only\s*-->[\s\S]*?<!--\s*\/internal-only\s*-->\s*/g,
    '',
  )
}

/**
 * Render `docs/PRIVACY.md` content into the final HTML document.
 * Exported for unit tests; the CLI path below wraps it with fs I/O.
 */
export function renderPrivacyPage(markdown: string): string {
  const stripped = stripInternalBlocks(markdown)
  const body = marked.parse(stripped, { gfm: true, async: false })
  if (typeof body !== 'string') {
    throw new Error('marked.parse returned a Promise (expected sync mode)')
  }
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `  <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
    '  <meta name="robots" content="index, follow" />',
    '  <meta name="color-scheme" content="dark light" />',
    '  <title>Privacy Policy — Terraviz</title>',
    '  <link rel="icon" href="/favicon.ico" sizes="48x48" />',
    '  <!-- Generated from docs/PRIVACY.md by scripts/build-privacy-page.ts. Do not edit this file directly. -->',
    '  <style>',
    TEMPLATE_CSS,
    '  </style>',
    '</head>',
    '<body>',
    '  <a href="#main" class="skip-link">Skip to main content</a>',
    '  <div class="page">',
    '    <a href="/" class="back-link">&larr; Back to Terraviz</a>',
    '    <main id="main" tabindex="-1">',
    indent(body.trim(), '      '),
    '    </main>',
    '    <footer class="site-footer">',
    `      ${FOOTER_HTML}`,
    '    </footer>',
    '  </div>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? '' : prefix + line))
    .join('\n')
}

// ---- CLI entry point ----

function readSource(): string {
  return readFileSync(SOURCE, 'utf-8')
}

function run(): void {
  const md = readSource()
  const html = renderPrivacyPage(md)

  if (process.argv.includes('--check')) {
    let current: string
    try {
      current = readFileSync(OUTPUT, 'utf-8')
    } catch {
      console.error(
        `✗ ${OUTPUT} does not exist. Run \`npm run build:privacy-page\`.`,
      )
      process.exit(1)
    }
    if (current !== html) {
      console.error(
        `✗ ${OUTPUT} is stale relative to ${SOURCE}.\n  Run \`npm run build:privacy-page\` and commit the regenerated file.`,
      )
      process.exit(1)
    }
    // eslint-disable-next-line no-console
    console.log(`✓ ${OUTPUT} is up to date`)
    return
  }

  writeFileSync(OUTPUT, html, 'utf-8')
  // eslint-disable-next-line no-console
  console.log(`✓ Generated ${OUTPUT} (${html.length} bytes)`)
}

// Only run the CLI when invoked as a script, not when imported by
// the unit test.
if (
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] ?? '')
) {
  run()
}
