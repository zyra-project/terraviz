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

import { parse, resolve, sep } from 'node:path'
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

/** Launch a headless Chromium for a capture run. */
export function launchBrowser(): Promise<Browser> {
  return chromium.launch()
}

/**
 * Navigate to an app route, waiting only for `domcontentloaded` rather
 * than the full `load` event. The app is a long-lived WebGL surface that
 * keeps streaming external resources (GIBS map tiles, video) well after
 * it is interactive, so waiting for `load` flakily times out in CI.
 * Scenes and checks wait on their own readiness selectors after this.
 */
export async function gotoApp(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' })
}

/**
 * Run `fn` against a fresh page in its own context, always closing the
 * context afterward. Centralizes the per-scene lifecycle so every
 * consumer gets the same isolation (cookies, storage, init scripts) per
 * scene.
 */
export async function withScenePage<T>(
  browser: Browser,
  opts: { viewport: Viewport; baseURL: string },
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({
    viewport: opts.viewport,
    baseURL: opts.baseURL,
  })
  const page = await context.newPage()
  try {
    return await fn(page)
  } finally {
    await context.close()
  }
}

/**
 * Screenshot the page, retrying once on failure.
 *
 * `animations: 'disabled'` freezes CSS animations/transitions so the
 * capture is stable. The retry absorbs an intermittent compositor stall
 * seen under resource pressure late in a long serial run — Playwright
 * reports it as a misleading "waiting for fonts to load" timeout even on
 * pages with zero web fonts, and the same page screenshots fine in
 * isolation. So this is a transient-stall guard, not a correctness fix.
 *
 * `mask` paints the given locators with a solid colour so
 * non-deterministic regions (the WebGL globe, MapLibre tiles, a
 * force-directed graph) don't produce false positives in the regression
 * diff. Both baseline and current are masked identically, so the masked
 * area is byte-identical and contributes zero diff.
 */
export async function screenshotWithRetry(
  page: Page,
  path: string,
  extra: { mask?: Locator[] } = {},
): Promise<Buffer> {
  const opts = { path, animations: 'disabled', timeout: 60_000, ...extra } as const
  try {
    return await page.screenshot(opts)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // eslint-disable-next-line no-console
    console.warn(`  retrying screenshot after: ${msg}`)
    return page.screenshot(opts)
  }
}
