#!/usr/bin/env tsx
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Generates `public/setup.html` — the guided install console served
 * at `/setup`, alongside `/privacy` and `/design-preview`.
 *
 * Run modes, matching `build-privacy-page.ts`:
 *
 *   npm run build:setup-page              write the file
 *   npm run build:setup-page -- --check   fail if it is out of date
 *
 * `--check` runs in CI. It regenerates in memory and diffs, so a
 * change to `content.ts`, to the setup tool's modules, or to the
 * design tokens without a matching rebuild fails the build instead of
 * shipping a page that disagrees with the code.
 *
 * ## Why this page is generated rather than written
 *
 * A hand-written install page drifts. Not dramatically — a binding
 * gets added to the audit and the table keeps its old nine rows, a
 * prerequisite becomes auto-detected and the checklist still tells
 * you to verify it by hand. Each drift is small and none of them
 * announce themselves. They surface at 2am, on someone else's
 * install, as "the docs lied".
 *
 * So everything factual here is imported from the modules the tool
 * uses. `crossCheck()` in `render.ts` turns each known drift mode
 * into a build error.
 *
 * ## Why tokens are inlined rather than linked
 *
 * `/setup` is read while the deploy is broken. Linking the SPA's
 * stylesheet would make the page fail in exactly the situation it
 * exists for. Inlining at build time keeps it self-contained *and*
 * tracking the palette — the frozen-copy approach in
 * `build-privacy-page.ts` only gets the first half.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderSetupPage, ContentDriftError } from './setup-page/render'
import { WORKSHEET } from './setup-page/content'
import {
  applyShell,
  assertSelfContained,
  assertValidatorsImplemented,
  repairSummary,
  resolveDocsUrl,
  TOKEN_ALIASES,
} from './setup-page/shell'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const TOKENS = resolve(ROOT, 'src/styles/tokens.css')
const OUT = resolve(ROOT, 'public/setup.html')

function loadTokens(): string {
  if (!existsSync(TOKENS)) {
    // Not fatal: the aliases carry literal fallbacks, so the page
    // still renders. Say so loudly rather than shipping a silently
    // unthemed page.
    process.stderr.write(
      `warning: ${TOKENS} not found — using literal fallbacks for every token.\n`,
    )
    return TOKEN_ALIASES
  }
  return `${readFileSync(TOKENS, 'utf8').trim()}\n${TOKEN_ALIASES}`
}

/**
 * The generated-at stamp would make every build differ, so `--check`
 * compares with it normalised out. A rebuild that changes nothing but
 * the date is not a failure.
 */
const STAMP = /Produced by scripts\/build-setup-page\.ts on [^.]*\./
const normalise = (s: string): string =>
  s.replace(STAMP, 'Produced by scripts/build-setup-page.ts on <date>.')

function main(): void {
  const check = process.argv.includes('--check')

  let html: string
  try {
    html = renderSetupPage({
      tokensCss: loadTokens(),
      generatedAt: new Date().toISOString().slice(0, 10),
    })
  } catch (error) {
    if (error instanceof ContentDriftError) {
      process.stderr.write(`\n${error.message}\n`)
      process.exit(1)
    }
    throw error
  }

  // render.ts and content.ts are replaced wholesale by each design
  // export, so anything fixed there is lost on the next one. The
  // shell restores what an export drops, then verifies the result —
  // see the header of scripts/setup-page/shell.ts.
  const shell = applyShell(html, { docsUrl: resolveDocsUrl(process.env) })
  html = shell.html
  try {
    assertSelfContained(html)
    assertValidatorsImplemented(WORKSHEET, html)
  } catch (error) {
    process.stderr.write(`\n${(error as Error).message}\n`)
    process.exit(1)
  }

  const docsUrl = resolveDocsUrl(process.env)
  if (process.env.TERRAVIZ_DOCS_URL) {
    process.stdout.write(`Doc links (${shell.docLinks}) point at ${docsUrl}\n`)
  }

  const repaired = repairSummary(shell.repairs)
  if (repaired.length) {
    process.stdout.write(
      `Restored from shell.ts (an export had dropped it): ${repaired.join(', ')}\n`,
    )
  }

  if (check) {
    if (!existsSync(OUT)) {
      process.stderr.write(
        'public/setup.html is missing. Run `npm run build:setup-page`.\n',
      )
      process.exit(1)
    }
    const current = readFileSync(OUT, 'utf8')
    if (normalise(current) !== normalise(html)) {
      process.stderr.write(
        'public/setup.html is out of date.\n' +
          'Something changed in scripts/setup-page/, in the setup tool modules it\n' +
          'imports, or in src/styles/tokens.css.\n\n' +
          'Run `npm run build:setup-page` and commit the result.\n',
      )
      process.exit(1)
    }
    process.stdout.write('public/setup.html is up to date.\n')
    return
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, html, 'utf8')
  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)
  process.stdout.write(`Wrote public/setup.html (${kb} KB)\n`)
}

main()
