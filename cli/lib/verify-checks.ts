// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Production-deploy verification checks for `terraviz verify-deploy`.
 *
 * Each step from `CATALOG_BACKEND_DEVELOPMENT.md` "Step 6 — Smoke
 * test the publisher API" / "Step 8 — Verify the public surface"
 * lands as a discrete check object: a name, an auth requirement,
 * and a `run` function that returns pass / fail / skip with a
 * human-readable detail line. The runner walks the list and prints
 * a table; the operator gets a per-check verdict instead of a
 * single 500-line curl-fest.
 *
 * Per the Phase 1f decision list (#4 — verify-deploy authentication),
 * checks declare `requires: 'service-token'` when they need
 * publisher-API auth. `--skip-publish-checks` (or absence of a
 * service token) makes those rows render as `SKIP` rather than
 * fail, so an operator running the command early in the deploy
 * cycle (before minting a token) gets a clean public-surface read.
 *
 * The check list is exported as data so the test suite can drive
 * each one against a fake fetch independently.
 */

export type CheckStatus = 'pass' | 'fail' | 'skip'

export interface CheckOutcome {
  status: CheckStatus
  detail: string
}

export interface CheckDeps {
  /** Resolved server base URL (no trailing slash). */
  serverUrl: string
  /** Headers carrying the Access service-token, when configured. */
  authHeaders: Record<string, string>
  /** Whether a service token is available (drives `requires` skips). */
  hasServiceToken: boolean
  /** Test-friendly fetch override. */
  fetchImpl: typeof fetch
}

export interface VerifyCheck {
  name: string
  description: string
  requires?: 'service-token'
  run: (deps: CheckDeps) => Promise<CheckOutcome>
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown; rawText: string }> {
  const res = await fetchImpl(url, init)
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* swallow — leave body=null, rawText carries the bytes */
  }
  return { status: res.status, body, rawText: text }
}

// ── Public-surface checks ────────────────────────────────────────

const wellKnownNodeIdentity: VerifyCheck = {
  name: 'node-identity',
  description: 'GET /.well-known/terraviz.json — node_id + public_key advertised',
  async run({ serverUrl, fetchImpl }) {
    try {
      const { status, body } = await fetchJson(
        fetchImpl,
        `${serverUrl}/.well-known/terraviz.json`,
      )
      if (status !== 200) {
        return { status: 'fail', detail: `unexpected status ${status}` }
      }
      const b = (body ?? {}) as { node_id?: unknown; public_key?: unknown }
      if (typeof b.node_id !== 'string' || !b.node_id) {
        return {
          status: 'fail',
          detail:
            'response missing node_id — the node_identity row is not provisioned; ' +
            'run `terraviz init-node`',
        }
      }
      if (typeof b.public_key !== 'string' || !b.public_key.startsWith('ed25519:')) {
        return {
          status: 'fail',
          detail: 'response missing or malformed public_key',
        }
      }
      return { status: 'pass', detail: `node_id=${b.node_id}` }
    } catch (e) {
      return { status: 'fail', detail: networkError(e) }
    }
  },
}

const catalogReachable: VerifyCheck = {
  name: 'catalog-reachable',
  description: 'GET /api/v1/catalog — schema applied, route returns 200 + datasets[]',
  async run({ serverUrl, fetchImpl }) {
    try {
      const { status, body } = await fetchJson(
        fetchImpl,
        `${serverUrl}/api/v1/catalog`,
      )
      if (status !== 200) {
        return {
          status: 'fail',
          detail: `unexpected status ${status} — migrations may not be applied`,
        }
      }
      const b = (body ?? {}) as { datasets?: unknown }
      if (!Array.isArray(b.datasets)) {
        return { status: 'fail', detail: 'response missing datasets[] array' }
      }
      return {
        status: 'pass',
        detail: `${b.datasets.length} datasets in public catalog`,
      }
    } catch (e) {
      return { status: 'fail', detail: networkError(e) }
    }
  },
}

const catalogPopulated: VerifyCheck = {
  name: 'catalog-populated',
  description: 'GET /api/v1/catalog — at least one published dataset (run import-snapshot)',
  async run({ serverUrl, fetchImpl }) {
    try {
      const { status, body } = await fetchJson(
        fetchImpl,
        `${serverUrl}/api/v1/catalog`,
      )
      if (status !== 200) {
        return { status: 'fail', detail: `unexpected status ${status}` }
      }
      const b = (body ?? {}) as { datasets?: unknown[] }
      const count = Array.isArray(b.datasets) ? b.datasets.length : 0
      if (count === 0) {
        return {
          status: 'fail',
          detail: 'catalog is empty — run `terraviz import-snapshot` to seed',
        }
      }
      return { status: 'pass', detail: `${count} datasets published` }
    } catch (e) {
      return { status: 'fail', detail: networkError(e) }
    }
  },
}

const searchReachable: VerifyCheck = {
  name: 'search-reachable',
  description:
    'GET /api/v1/search?q=test — Vectorize + Workers AI responsive (or graceful degraded)',
  async run({ serverUrl, fetchImpl }) {
    try {
      const { status, body } = await fetchJson(
        fetchImpl,
        `${serverUrl}/api/v1/search?q=test`,
      )
      // The route ALWAYS returns 200 — degraded states (bindings
      // missing, Workers AI quota exhausted) are signalled via the
      // body's `degraded` field plus a `Warning` response header
      // (see `functions/api/v1/search.ts` ~line 220–230). A non-200
      // here means the route itself is sick (5xx upstream / 4xx
      // bad query) — surface it as a hard failure.
      if (status !== 200) {
        return { status: 'fail', detail: `unexpected status ${status}` }
      }
      const b = (body ?? {}) as { datasets?: unknown; degraded?: string }
      if (!Array.isArray(b.datasets)) {
        return { status: 'fail', detail: 'response missing datasets[] array' }
      }
      // Distinguish the two documented degraded reasons. Both are
      // operator-actionable failures, but the hint differs.
      if (b.degraded === 'unconfigured') {
        return {
          status: 'fail',
          detail:
            'Workers AI / Vectorize bindings missing — see Step 4 of the deploy checklist',
        }
      }
      if (b.degraded === 'quota_exhausted') {
        return {
          status: 'fail',
          detail:
            'Workers AI quota exhausted — wait for reset or move to Workers Paid (1f/D)',
        }
      }
      if (b.degraded) {
        return { status: 'fail', detail: `degraded: ${b.degraded}` }
      }
      return { status: 'pass', detail: `${b.datasets.length} hit(s)` }
    } catch (e) {
      return { status: 'fail', detail: networkError(e) }
    }
  },
}

// ── Auth-gated checks ────────────────────────────────────────────

const accessResponsive: VerifyCheck = {
  name: 'access-me',
  description: 'GET /api/v1/publish/me — Access service token resolves to a publisher',
  requires: 'service-token',
  async run({ serverUrl, authHeaders, fetchImpl }) {
    try {
      const { status, body } = await fetchJson(
        fetchImpl,
        `${serverUrl}/api/v1/publish/me`,
        { headers: { ...authHeaders, Accept: 'application/json' } },
      )
      if (status === 401) {
        const b = (body ?? {}) as { error?: string; message?: string }
        return {
          status: 'fail',
          detail: `Access rejected the token: ${b.message ?? b.error ?? '401'}`,
        }
      }
      if (status === 503) {
        const b = (body ?? {}) as { error?: string }
        if (b.error === 'access_unconfigured') {
          return {
            status: 'fail',
            detail:
              'ACCESS_TEAM_DOMAIN / ACCESS_AUD missing — see Step 4 of the deploy checklist',
          }
        }
      }
      if (status !== 200) {
        return { status: 'fail', detail: `unexpected status ${status}` }
      }
      const b = (body ?? {}) as { email?: unknown; role?: unknown }
      if (typeof b.email !== 'string' || typeof b.role !== 'string') {
        return { status: 'fail', detail: 'response missing email/role' }
      }
      return { status: 'pass', detail: `${b.email} (${b.role})` }
    } catch (e) {
      return { status: 'fail', detail: networkError(e) }
    }
  },
}

const publisherListReadable: VerifyCheck = {
  name: 'publisher-list',
  description: 'GET /api/v1/publish/datasets?limit=1 — publisher view reads cleanly',
  requires: 'service-token',
  async run({ serverUrl, authHeaders, fetchImpl }) {
    try {
      const { status, body } = await fetchJson(
        fetchImpl,
        `${serverUrl}/api/v1/publish/datasets?limit=1`,
        { headers: { ...authHeaders, Accept: 'application/json' } },
      )
      if (status !== 200) return { status: 'fail', detail: `unexpected status ${status}` }
      const b = (body ?? {}) as { datasets?: unknown }
      if (!Array.isArray(b.datasets)) {
        return { status: 'fail', detail: 'response missing datasets[] array' }
      }
      return {
        status: 'pass',
        detail: `${b.datasets.length} dataset(s) visible to caller`,
      }
    } catch (e) {
      return { status: 'fail', detail: networkError(e) }
    }
  },
}

// ── Public list ──────────────────────────────────────────────────

export const VERIFY_CHECKS: VerifyCheck[] = [
  wellKnownNodeIdentity,
  catalogReachable,
  catalogPopulated,
  searchReachable,
  accessResponsive,
  publisherListReadable,
]

export interface RunChecksOptions {
  /** When false, all `requires: 'service-token'` checks SKIP regardless of header presence. */
  skipPublishChecks?: boolean
}

export interface CheckRow {
  name: string
  description: string
  status: CheckStatus
  detail: string
}

export async function runChecks(
  checks: VerifyCheck[],
  deps: CheckDeps,
  options: RunChecksOptions = {},
): Promise<CheckRow[]> {
  const rows: CheckRow[] = []
  for (const check of checks) {
    if (check.requires === 'service-token') {
      if (options.skipPublishChecks || !deps.hasServiceToken) {
        rows.push({
          name: check.name,
          description: check.description,
          status: 'skip',
          detail: deps.hasServiceToken
            ? 'skipped (--skip-publish-checks)'
            : 'skipped (no service token configured)',
        })
        continue
      }
    }
    const outcome = await check.run(deps)
    rows.push({
      name: check.name,
      description: check.description,
      status: outcome.status,
      detail: outcome.detail,
    })
  }
  return rows
}

export function formatCheckTable(rows: CheckRow[]): string {
  const widths = {
    glyph: 4,
    name: Math.max(4, ...rows.map(r => r.name.length)),
    description: Math.max(11, ...rows.map(r => r.description.length)),
  }
  const lines: string[] = []
  lines.push(
    pad('', widths.glyph) +
      '  ' +
      pad('Name', widths.name) +
      '  ' +
      pad('Description', widths.description) +
      '  Detail',
  )
  lines.push(
    pad('', widths.glyph) +
      '  ' +
      pad('----', widths.name) +
      '  ' +
      pad('-----------', widths.description) +
      '  ------',
  )
  for (const r of rows) {
    lines.push(
      pad(glyphFor(r.status), widths.glyph) +
        '  ' +
        pad(r.name, widths.name) +
        '  ' +
        pad(r.description, widths.description) +
        '  ' +
        r.detail,
    )
  }
  return lines.join('\n')
}

function glyphFor(s: CheckStatus): string {
  switch (s) {
    case 'pass':
      return ' OK '
    case 'fail':
      return 'FAIL'
    case 'skip':
      return 'SKIP'
  }
}

function pad(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - s.length))
}

function networkError(e: unknown): string {
  return `network error: ${e instanceof Error ? e.message : String(e)}`
}
