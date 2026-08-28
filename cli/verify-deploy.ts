// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `terraviz verify-deploy` — operator-friendly post-deploy
 * smoke-test command.
 *
 * Walks every check in `lib/verify-checks.ts`, prints a per-check
 * pass / fail / skip table, and exits with the right code:
 *
 *   0 — everything passed (skipped rows are not failures).
 *   1 — at least one check failed.
 *
 * (Argv-parsing usage errors are caught upstream in
 * `cli/terraviz.ts` before this command runs, and surface as
 * exit code 2 from the dispatcher.)
 *
 * Per the Phase 1f decision list (#4), the command supports both
 * public-only and full modes. Without a service token, the
 * publisher-API checks render as SKIP rather than fail (so a
 * deploy can be verified before the token is minted). With
 * --skip-publish-checks, the same SKIP behaviour is forced even if
 * a token is configured. With a service token and no
 * --skip-publish-checks flag, every check runs.
 *
 * Usage:
 *
 *   # Public-surface only:
 *   terraviz verify-deploy --server https://your-domain
 *
 *   # Full audit (requires TERRAVIZ_ACCESS_CLIENT_ID +
 *   # TERRAVIZ_ACCESS_CLIENT_SECRET, or --client-id / --client-secret):
 *   terraviz verify-deploy --server https://your-domain
 *
 *   # Force public-only when a token is configured:
 *   terraviz verify-deploy --skip-publish-checks
 */

import type { CommandContext } from './commands'
import { authHeaders, type CliConfig } from './lib/config'
import { getBool } from './lib/args'
import {
  formatCheckTable,
  runChecks,
  VERIFY_CHECKS,
  type CheckRow,
  type VerifyCheck,
} from './lib/verify-checks'

export interface VerifyDeployDeps {
  /** Resolved CLI config (server URL + service token state). */
  config: CliConfig
  /** Test injection point — defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Test injection point — defaults to VERIFY_CHECKS. */
  checks?: VerifyCheck[]
}

export async function runVerifyDeploy(
  ctx: CommandContext,
  deps: VerifyDeployDeps,
): Promise<number> {
  const skipPublishChecks = getBool(ctx.args.options, 'skip-publish-checks')
  const headers = authHeaders(deps.config)
  const hasServiceToken = Boolean(headers['Cf-Access-Client-Id'])

  const checks = deps.checks ?? VERIFY_CHECKS
  const fetchImpl = deps.fetchImpl ?? fetch

  ctx.stdout.write(`Verifying ${deps.config.server}...\n\n`)

  const rows = await runChecks(
    checks,
    {
      serverUrl: deps.config.server,
      authHeaders: headers,
      hasServiceToken,
      fetchImpl,
    },
    { skipPublishChecks },
  )

  ctx.stdout.write(formatCheckTable(rows) + '\n')
  ctx.stdout.write('\n' + summarise(rows, hasServiceToken, skipPublishChecks) + '\n')
  return rows.some(r => r.status === 'fail') ? 1 : 0
}

function summarise(
  rows: CheckRow[],
  hasServiceToken: boolean,
  skipPublishChecks: boolean,
): string {
  const counts = rows.reduce(
    (acc, r) => {
      acc[r.status]++
      return acc
    },
    { pass: 0, fail: 0, skip: 0 } as Record<CheckRow['status'], number>,
  )
  const lines = [`${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped.`]
  if (counts.skip > 0 && !hasServiceToken && !skipPublishChecks) {
    lines.push(
      'Run with TERRAVIZ_ACCESS_CLIENT_ID + TERRAVIZ_ACCESS_CLIENT_SECRET (or',
      '--client-id / --client-secret) to include the publisher-API checks.',
    )
  }
  if (counts.fail > 0) {
    lines.push('See CATALOG_BACKEND_DEVELOPMENT.md "Production deployment checklist".')
  }
  return lines.join('\n')
}
