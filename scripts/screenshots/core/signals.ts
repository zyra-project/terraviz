/**
 * Per-scene problem-signal collection.
 *
 * While a scene is driven, we attach Playwright listeners and record the
 * things that make a UI "wrong" even when it screenshots fine: console
 * errors/warnings, uncaught page errors, failed and 4xx/5xx network
 * requests (broken images, missing tiles, dead APIs), and — optionally —
 * accessibility violations from an axe-core scan. These render as
 * per-scene problem badges in the visual report and feed the deploy
 * health view.
 *
 * The aggregation is factored as pure handler methods on a collector so
 * it is unit-testable by calling the handlers directly with fake
 * message/request/response objects — no browser, no fake emitter.
 * `attachSignalCollectors()` is the thin wiring that points a real
 * Playwright page's events at those handlers.
 *
 * See `docs/VISUAL_REPORT_PLAN.md`.
 */

import type { Page } from 'playwright'

export interface FailedRequest {
  url: string
  method: string
  /** Playwright's failure text, e.g. `net::ERR_FAILED`. */
  failure: string
}

export interface BadResponse {
  url: string
  status: number
}

export interface AxeViolation {
  id: string
  /** axe severity: 'minor' | 'moderate' | 'serious' | 'critical' | null. */
  impact: string | null
  /** How many DOM nodes triggered the rule. */
  nodes: number
  /** axe rule documentation URL (Deque University) — the report links
   *  the rule id here. Optional so an older persisted `report.json`
   *  (captured before this field existed) still parses + renders. */
  helpUrl?: string
  /** CSS selector path(s) of the failing node(s), capped, so the report
   *  can point at the offending element(s). Optional for the same
   *  backward-compatibility reason as `helpUrl`. */
  targets?: string[]
}

/** Flatten one axe node `target` (a CSS path, possibly nested for
 *  iframes/shadow DOM) to a single selector string. */
function targetToSelector(target: unknown): string {
  if (Array.isArray(target)) {
    return target.map((t) => (Array.isArray(t) ? t.join(' ') : String(t))).join(' ')
  }
  return String(target)
}

/** Everything observed while a single scene was on screen. */
export interface SceneSignals {
  consoleErrors: string[]
  consoleWarnings: string[]
  pageErrors: string[]
  failedRequests: FailedRequest[]
  badResponses: BadResponse[]
  /** Present only when an axe scan ran (gated by `VISUAL_AXE`). */
  axeViolations?: AxeViolation[]
}

/** Minimal structural views of the Playwright objects we read, so the
 *  handlers can be exercised with plain fakes in tests. */
export interface ConsoleMessageLike {
  type(): string
  text(): string
}
export interface RequestLike {
  url(): string
  method(): string
  failure(): { errorText: string } | null
}
export interface ResponseLike {
  url(): string
  status(): number
}

export interface SignalCollector {
  readonly signals: SceneSignals
  handleConsole(msg: ConsoleMessageLike): void
  handlePageError(err: Error): void
  handleRequestFailed(req: RequestLike): void
  handleResponse(res: ResponseLike): void
}

/**
 * A fresh, page-less collector. The four `handle*` methods are pure
 * aggregation over the structural views above.
 */
export function createSignalCollector(): SignalCollector {
  const signals: SceneSignals = {
    consoleErrors: [],
    consoleWarnings: [],
    pageErrors: [],
    failedRequests: [],
    badResponses: [],
  }

  return {
    signals,
    handleConsole(msg) {
      const type = msg.type()
      if (type === 'error') signals.consoleErrors.push(msg.text())
      else if (type === 'warning') signals.consoleWarnings.push(msg.text())
    },
    handlePageError(err) {
      signals.pageErrors.push(err.message)
    },
    handleRequestFailed(req) {
      signals.failedRequests.push({
        url: req.url(),
        method: req.method(),
        failure: req.failure()?.errorText ?? 'unknown',
      })
    },
    handleResponse(res) {
      const status = res.status()
      // Only client/server errors are problems; 2xx/3xx are normal.
      if (status >= 400) signals.badResponses.push({ url: res.url(), status })
    },
  }
}

/**
 * Attach a collector to a live page. Returns the collector so the caller
 * can read `.signals` after the scene settles.
 */
export function attachSignalCollectors(page: Page): SignalCollector {
  const collector = createSignalCollector()
  page.on('console', (msg) => collector.handleConsole(msg))
  page.on('pageerror', (err) => collector.handlePageError(err))
  page.on('requestfailed', (req) => collector.handleRequestFailed(req))
  page.on('response', (res) => collector.handleResponse(res))
  return collector
}

/** True when an axe scan is requested for this run (`VISUAL_AXE=1`/`true`). */
export function axeEnabled(): boolean {
  const v = process.env.VISUAL_AXE
  return v === '1' || v === 'true'
}

/**
 * Run an axe-core accessibility scan against the current page and
 * summarize violations (id, impact, node count). The dependency is
 * imported lazily so a run with `VISUAL_AXE` off never loads it.
 * Best-effort: a scan failure returns an empty list rather than failing
 * the scene.
 */
export async function runAxe(page: Page): Promise<AxeViolation[]> {
  try {
    const { default: AxeBuilder } = await import('@axe-core/playwright')
    const results = await new AxeBuilder({ page }).analyze()
    return results.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? null,
      nodes: v.nodes.length,
      helpUrl: v.helpUrl,
      // Cap at 5 selectors so a rule failing on many nodes stays compact.
      targets: v.nodes.slice(0, 5).map((n) => targetToSelector(n.target)),
    }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // eslint-disable-next-line no-console
    console.warn(`  axe scan skipped: ${msg}`)
    return []
  }
}
