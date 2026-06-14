/**
 * Route-stub fixture harness (Phase V7).
 *
 * Data-backed surfaces (the publisher / admin portal) render only a
 * "Loading…" state against a local dev server — there is no backend or
 * Cloudflare Access session. This harness intercepts `**​/api/**`
 * requests with `page.route` and serves typed JSON fixtures, so those
 * scenes capture *populated* views (and forced error/empty states) for
 * both the visual report and the smoke tests — no CI backend required.
 *
 * The matching is a pure function (`matchFixture`) so it is unit-tested
 * without a browser; `installFixtures` is the thin Playwright wiring.
 * Rules are tried in order, so list specific patterns (a detail route)
 * before general ones (the list route).
 *
 * See `docs/VISUAL_REPORT_PLAN.md`.
 */

import type { Page } from 'playwright'

export interface FixtureRule {
  /** Substring or RegExp the request URL must contain/match. */
  url: string | RegExp
  /** HTTP method to match; any method when omitted. */
  method?: string
  /** Response status; 200 when omitted. */
  status?: number
  /** JSON body (serialized for you); mutually exclusive with `body`. */
  json?: unknown
  /** Raw body string. */
  body?: string
  /** Content-Type; `application/json` when omitted. */
  contentType?: string
}

export interface FixtureResponse {
  status: number
  contentType: string
  body: string
}

/**
 * Resolve the first rule matching `url` + `method`, or null. Pure —
 * exported for tests.
 */
export function matchFixture(
  rules: readonly FixtureRule[],
  url: string,
  method: string,
): FixtureResponse | null {
  for (const r of rules) {
    if (r.method && r.method.toUpperCase() !== method.toUpperCase()) continue
    const matches =
      typeof r.url === 'string' ? url.includes(r.url) : r.url.test(url)
    if (!matches) continue
    return {
      status: r.status ?? 200,
      contentType: r.contentType ?? 'application/json',
      body: r.body ?? (r.json !== undefined ? JSON.stringify(r.json) : ''),
    }
  }
  return null
}

export interface InstallFixturesOptions {
  /** Status for an `/api` request that matches no rule (default 404, so
   *  pages render their not-found / error surface rather than hang). */
  unmatchedStatus?: number
  unmatchedBody?: unknown
}

/**
 * Intercept `**​/api/**` on the page and serve fixtures. Must be called
 * before the scene navigates (route handlers only affect later
 * requests). Non-API requests (catalog snapshot, tiles, assets) are
 * untouched.
 */
export async function installFixtures(
  page: Page,
  rules: readonly FixtureRule[],
  opts: InstallFixturesOptions = {},
): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const hit = matchFixture(rules, req.url(), req.method()) ?? {
      status: opts.unmatchedStatus ?? 404,
      contentType: 'application/json',
      body: JSON.stringify(opts.unmatchedBody ?? { error: 'no_fixture' }),
    }
    try {
      await route.fulfill(hit)
    } catch (err) {
      // The page/context can close mid-request (scene already done);
      // awaiting keeps this from surfacing as an unhandled rejection.
      const msg = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.warn(`  fixture fulfill skipped: ${msg}`)
    }
  })
}
