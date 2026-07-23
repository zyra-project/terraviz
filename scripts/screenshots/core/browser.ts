/**
 * Browser + filesystem primitives for the screenshot capture core.
 *
 * These were originally inlined in `../capture.ts` (the Weblate
 * capturer). They are extracted here unchanged so every consumer — the
 * Weblate capturer, the visual report, the regression differ, the smoke
 * runner — shares one implementation. `../capture.ts` re-exports the
 * pure helpers so its existing tests' import surface is preserved.
 *
 * See `docs/VISUAL_REPORT_PLAN.md`.
 */

import { dirname, parse, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, type Browser, type Locator, type Page } from 'playwright'

import type { Box, Viewport } from './types'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
// core/ → screenshots/ → scripts/ → repo root
export const REPO_ROOT = resolve(HERE, '..', '..', '..')

/** Filesystem-safe slug for a dotted message key. */
export function slugKey(key: string): string {
  return key.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')
}

/** Pad a box by `pad` px and clamp it to the viewport. */
export function padClip(box: Box, pad: number, vp: Viewport): Box {
  const x = Math.max(0, box.x - pad)
  const y = Math.max(0, box.y - pad)
  const right = Math.min(vp.width, box.x + box.width + pad)
  const bottom = Math.min(vp.height, box.y + box.height + pad)
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) }
}

/**
 * Parse a `WIDTHxHEIGHT` viewport string. Defaults to the
 * `SCREENSHOT_VIEWPORT` env var, then the desktop 1440x900 fallback, so
 * existing callers keep their behaviour; the general report passes
 * explicit strings to drive a multi-viewport matrix.
 */
export function parseViewport(
  raw: string = process.env.SCREENSHOT_VIEWPORT ?? '1440x900',
): Viewport {
  const m = /^(\d+)x(\d+)$/.exec(raw.trim())
  if (!m) {
    throw new Error(`viewport must look like "1440x900", got "${raw}".`)
  }
  return { width: Number(m[1]), height: Number(m[2]) }
}

/**
 * Refuse to `rm -rf` a path that is the filesystem root, the repo root,
 * or an ancestor of it. Consumers wipe their output directory for a
 * clean slate, so a mistyped output dir (`/`, empty → cwd, a parent
 * dir) must not nuke real files.
 */
export function assertSafeOutDir(dir: string): void {
  const root = parse(dir).root
  const isAncestorOfRepo = `${REPO_ROOT}${sep}`.startsWith(`${dir}${sep}`)
  if (dir === root || dir === REPO_ROOT || isAncestorOfRepo) {
    throw new Error(
      `Refusing to delete output dir "${dir}": it is the filesystem ` +
        'root, the repo root, or an ancestor of it. Point it at a ' +
        'dedicated output directory.',
    )
  }
}

/** Launch a headless Chromium for a capture run. `PLAYWRIGHT_CHROMIUM_PATH`
 *  overrides the browser binary — handy when a pre-installed Chromium's
 *  build number doesn't match the pinned Playwright package (so the run
 *  doesn't demand `npx playwright install`); left unset in CI, which
 *  installs the matching browser. */
export function launchBrowser(opts: { args?: string[] } = {}): Promise<Browser> {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined
  return chromium.launch({ args: opts.args, executablePath })
}

/**
 * Navigate to an app route, waiting only for `domcontentloaded` rather
 * than the full `load` event. The app is a long-lived WebGL surface that
 * keeps streaming external resources (GIBS map tiles, video) well after
 * it is interactive, so waiting for `load` flakily times out in CI.
 * Scenes and checks wait on their own readiness selectors after this.
 *
 * The catalog / globe routes are WebGL-heavy, and in a long-lived
 * capture browser (the Weblate capturer + the smoke suite both run many
 * scenes through one browser) accumulated GPU + dev-server pressure can
 * push the *initial* navigation past Playwright's default 30 s timeout —
 * an intermittent `page.goto: Timeout 30000ms exceeded` on
 * `/?catalog=true`. Use a longer ceiling and retry once: a stalled
 * first attempt almost always succeeds on a warm second try (module
 * transforms cached, transient contention passed).
 */
const GOTO_TIMEOUT_MS = 60_000

export async function gotoApp(page: Page, path: string): Promise<void> {
  try {
    await page.goto(path, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS })
  } catch (err) {
    if (!(err instanceof Error) || !/timeout/i.test(err.message)) throw err
    await page.goto(path, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS })
  }
}

/** True when `url` is on the same origin as `baseURL`. Used to scope
 *  injected auth headers to the first party. Malformed URLs → false. */
export function isSameOrigin(url: string, baseURL: string): boolean {
  try {
    return new URL(url).origin === new URL(baseURL).origin
  } catch {
    return false
  }
}

/**
 * Run `fn` against a fresh page in its own context, always closing the
 * context afterward. Centralizes the per-scene lifecycle so every
 * consumer gets the same isolation (cookies, storage, init scripts) per
 * scene.
 */
export async function withScenePage<T>(
  browser: Browser,
  opts: {
    viewport: Viewport
    baseURL: string
    /** Headers (e.g. a Cloudflare Access service token) added **only**
     *  to first-party requests — same origin as `baseURL`. Never sent to
     *  third parties (tiles / CDNs / external APIs), so the token cannot
     *  leak cross-origin. */
    extraHTTPHeaders?: Record<string, string>
  },
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({
    viewport: opts.viewport,
    baseURL: opts.baseURL,
  })
  const headers = opts.extraHTTPHeaders
  if (headers && Object.keys(headers).length > 0) {
    // Scope the headers to the baseURL origin. Passing them to
    // newContext() would attach them to *every* request — including the
    // external tile/CDN hosts the app loads — leaking the secret.
    await context.route('**/*', async (route) => {
      const req = route.request()
      if (isSameOrigin(req.url(), opts.baseURL)) {
        await route.continue({ headers: { ...req.headers(), ...headers } })
      } else {
        await route.continue()
      }
    })
  }
  const page = await context.newPage()
  try {
    return await fn(page)
  } finally {
    await context.close()
  }
}

/**
 * Like {@link withScenePage}, but records the whole session to a `.webm`
 * clip saved at `videoPath`. Playwright finalizes the recording on
 * context close, so we grab the `Video` handle, close the context, then
 * `saveAs` it to the named path and drop the random temp file Playwright
 * wrote alongside it. Used by the demo capturer (`../demo.ts`) to produce
 * a continuous clip of a scripted flow; the still-per-beat capture
 * happens inside `fn` via {@link screenshotWithRetry}.
 *
 * A recording failure (a wedged compositor, a missing clip) is
 * swallowed — a demo clip is best-effort and must not abort the run —
 * but an error thrown by `fn` itself propagates after the context is
 * cleaned up.
 */
export async function withVideoPage(
  browser: Browser,
  opts: { viewport: Viewport; baseURL: string; videoPath: string },
  fn: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({
    viewport: opts.viewport,
    baseURL: opts.baseURL,
    recordVideo: { dir: dirname(opts.videoPath), size: opts.viewport },
  })
  const page = await context.newPage()
  let fnErr: unknown
  try {
    await fn(page)
  } catch (err) {
    fnErr = err
  } finally {
    const video = page.video()
    await context.close() // flushes + finalizes the .webm
    if (video) {
      try {
        await video.saveAs(opts.videoPath)
        await video.delete() // remove the random-named temp clip
      } catch {
        // Best-effort: a missing clip shouldn't fail the whole demo run.
      }
    }
  }
  if (fnErr) throw fnErr
}

/**
 * Screenshot the page, retrying on failure.
 *
 * `animations: 'disabled'` freezes CSS animations/transitions so the
 * capture is stable. The retries absorb an intermittent compositor stall
 * — Playwright reports it as a misleading "waiting for fonts to load"
 * timeout even on pages with zero web fonts, and the same page
 * screenshots fine on the next attempt. It's most pronounced against a
 * live, continuously-rendering page (the WebGL globe's rAF loop + real
 * web fonts), so a *short* per-attempt timeout with *several* attempts
 * is faster than one long wait: a transient stall costs ~20s, not ~60s.
 * A transient-stall guard, not a correctness fix.
 *
 * `mask` paints the given locators with a solid colour so
 * non-deterministic regions (the WebGL globe, MapLibre tiles, a
 * force-directed graph) don't produce false positives in the regression
 * diff. Both baseline and current are masked identically, so the masked
 * area is byte-identical and contributes zero diff.
 */
export async function screenshotWithRetry(
  target: Page | Locator,
  path: string,
  extra: { mask?: Locator[] } = {},
): Promise<Buffer> {
  // Accepts a `Page` (full-viewport shot, supports `mask`) or a `Locator`
  // (element crop — `Locator.screenshot` has no `mask` option). Both get
  // the same animation-disable + retry treatment so crops are as stable
  // as full shots.
  const isPage = 'goto' in target
  const page = isPage ? target : target.page()
  const opts = isPage
    ? ({ path, animations: 'disabled', timeout: 20_000, ...extra } as const)
    : ({ path, animations: 'disabled', timeout: 20_000 } as const)
  // Escalating quiet-down before each retry. The short first pause
  // absorbs the common compositor stall; the later, longer waits ride
  // out a wedged renderer (`Protocol error (Page.captureScreenshot)`,
  // which CDP throws instantly, so no per-attempt timeout is paid) —
  // observed on CI to clear on its own within a few seconds, longer
  // than a run of short retries can span. Total retry window ≈ 9 s;
  // the happy path is unchanged.
  const RETRY_DELAYS_MS = [750, 2_500, 6_000] as const
  const attempts = RETRY_DELAYS_MS.length + 1
  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await page.waitForTimeout(RETRY_DELAYS_MS[attempt - 2])
    try {
      return await target.screenshot(opts)
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.warn(`  screenshot attempt ${attempt}/${attempts} failed: ${msg}`)
    }
  }
  throw lastErr
}
