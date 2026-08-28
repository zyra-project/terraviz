// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * scripts/check-pages-bindings.ts — audit Pages bindings against
 * the expected manifest.
 *
 * The Phase 1d/AB walkthrough surfaced one foot-gun more than any
 * other: the dashboard's per-environment Production / Preview
 * toggle. Forgetting to mirror a binding into both environments
 * yields the silent-failure pattern "works on the preview deploy,
 * 503s on the prod URL" (or the reverse). This script makes that
 * automated: read the project's actual binding set from the
 * Cloudflare REST API, diff against `scripts/lib/expected-bindings.ts`,
 * print a table.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=... \
 *   CLOUDFLARE_ACCOUNT_ID=... \
 *   [CLOUDFLARE_PAGES_PROJECT_NAME=terraviz] \
 *   npx tsx scripts/check-pages-bindings.ts
 *
 * Exit codes:
 *   0 — every required binding present in every environment it
 *       declares (extras are informational, not a failure).
 *   1 — at least one required binding is missing somewhere.
 *   2 — usage / configuration error (missing env vars, bad token,
 *       network failure).
 *
 * Why REST and not Wrangler? Wrangler has `pages project list /
 * create / delete` but no `project info` for the deployment
 * configs that carry the binding-level data. The REST endpoint is
 * the same one the dashboard's "Variables and Bindings" tab reads
 * from — the script's view matches the dashboard's view.
 */

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXPECTED_BINDINGS } from './lib/expected-bindings.ts'
import {
  diffBindings,
  formatDiffTable,
  RestApiSource,
  type DiffEntry,
} from './lib/cf-pages-api.ts'

interface CliEnv {
  CLOUDFLARE_API_TOKEN?: string
  CLOUDFLARE_ACCOUNT_ID?: string
  CLOUDFLARE_PAGES_PROJECT_NAME?: string
}

export interface RunDeps {
  env: CliEnv
  stdout: { write: (s: string) => void }
  stderr: { write: (s: string) => void }
  fetchImpl?: typeof fetch
}

export async function runCheck(deps: RunDeps): Promise<number> {
  // Trimmed on read: a token exported from a file keeps the file's
  // newline, and Cloudflare answers the resulting Bearer header
  // with a 401 that reads like a permissions problem.
  const token = deps.env.CLOUDFLARE_API_TOKEN?.trim()
  const accountId = deps.env.CLOUDFLARE_ACCOUNT_ID?.trim()
  const projectName = deps.env.CLOUDFLARE_PAGES_PROJECT_NAME?.trim() || 'terraviz'

  if (!token || !accountId) {
    deps.stderr.write(
      'check-pages-bindings: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required.\n' +
        'Mint a read-only token at https://dash.cloudflare.com/profile/api-tokens\n' +
        '(scope: "Pages → Read"), and set CLOUDFLARE_ACCOUNT_ID to the owning account.\n',
    )
    return 2
  }

  const source = new RestApiSource({
    apiToken: token,
    accountId,
    projectName,
    fetchImpl: deps.fetchImpl,
  })
  let actual
  try {
    actual = await source.fetchProject()
  } catch (e) {
    deps.stderr.write(
      `check-pages-bindings: failed to fetch project "${projectName}": ${
        e instanceof Error ? e.message : String(e)
      }\n`,
    )
    return 2
  }

  const entries = diffBindings(EXPECTED_BINDINGS, actual)
  deps.stdout.write(`Pages bindings audit — project "${projectName}"\n\n`)
  deps.stdout.write(formatDiffTable(entries) + '\n')

  // Phase 1f/O — `wrong_type` is also a hard failure (the binding
  // exists under the wrong Pages binding type, so the route still
  // 503s at runtime — same operator-pain shape as `missing`).
  // Pre-1f/O the script counted only `missing`, so a wrong-type
  // misconfig would exit 0 + "All required bindings present" even
  // though the deploy is broken.
  const broken = entries.filter(
    e => e.status === 'missing' || e.status === 'wrong_type',
  )
  if (broken.length === 0) {
    deps.stdout.write(
      '\nAll required bindings present in both Production and Preview. ✓\n',
    )
    return 0
  }
  deps.stdout.write(`\n${summariseBroken(broken)}\n`)
  return 1
}

function summariseBroken(broken: DiffEntry[]): string {
  if (broken.length === 0) return ''
  const missing = broken.filter(e => e.status === 'missing')
  const wrongType = broken.filter(e => e.status === 'wrong_type')
  const byEnv = new Map<string, number>()
  for (const m of broken) byEnv.set(m.environment, (byEnv.get(m.environment) ?? 0) + 1)
  const parts = [...byEnv.entries()].map(([env, n]) => `${n} in ${env}`)
  const detail =
    wrongType.length > 0
      ? `${broken.length} required binding(s) broken (${missing.length} missing, ${wrongType.length} wrong type) — ${parts.join(', ')}.`
      : `${broken.length} required binding(s) missing — ${parts.join(', ')}.`
  return (
    `${detail}\n` +
    'Wire them in the dashboard under Settings → Variables and Bindings,\n' +
    'then trigger a redeploy (Step 5 of CATALOG_BACKEND_DEVELOPMENT.md).'
  )
}

// Detect "is this file the entry point" vs. "imported by a test".
// The naive `import.meta.url === \`file://${process.argv[1]}\`` form
// is broken on Windows (path separators, drive letters, file-URL
// percent-encoding) and on POSIX systems where either side might
// be reached via a symlink (e.g. an `npm link`-ed bin). Mirror
// `gen-node-key.ts` and canonicalise both sides via
// `realpathSync.native` so symlink indirection on either side
// doesn't suppress the run.
function isInvokedAsScript(): boolean {
  if (typeof process === 'undefined' || !process.argv?.[1]) return false
  try {
    const here = realpathSync.native(fileURLToPath(import.meta.url))
    const argv1 = realpathSync.native(resolve(process.argv[1]))
    return here === argv1
  } catch {
    return false
  }
}

if (isInvokedAsScript()) {
  void runCheck({
    env: process.env as CliEnv,
    stdout: process.stdout,
    stderr: process.stderr,
  }).then(code => {
    process.exit(code)
  })
}
