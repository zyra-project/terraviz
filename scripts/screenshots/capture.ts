/**
 * Weblate screenshot capturer (phase S3).
 *
 * Drives the running app through each scene in `./scenes.ts` with a
 * headless Chromium and, for every scene, records:
 *   - a PNG of the viewport, and
 *   - the set of i18n keys the scene rendered (read off
 *     `window.__i18nTrace`, populated by the `VITE_I18N_TRACE` hook
 *     in `src/i18n/screenshotTrace.ts`).
 *
 * Output lands in `screenshots-out/` (gitignored):
 *   - `<scene>.png` per scene
 *   - `screenshots.json` — the manifest the uploader consumes:
 *       [{ name, description, file, sha256, keys: [...] }]
 *   The sha256 is what makes the upload step idempotent — unchanged
 *   images are skipped on re-run.
 *
 * This phase does NOT touch Weblate; it only produces artifacts for
 * local/PR review. The uploader is phase S4.
 *
 * Prerequisite: a running server **built/served with the trace flag
 * on**. Vite inlines `import.meta.env.VITE_I18N_TRACE` at build time,
 * so the flag must be present when the bundle is produced — setting
 * it only at `preview` is too late. The dev server honours it at
 * serve time, which is the simplest path:
 *     VITE_I18N_TRACE=true npm run dev -- --port 4173 &
 *     npm run screenshots:capture
 * For a production-style bundle instead:
 *     VITE_I18N_TRACE=true npm run build
 *     npm run preview -- --port 4173 &
 *     npm run screenshots:capture
 *
 * Config (env):
 *   SCREENSHOT_BASE_URL     default http://localhost:4173
 *   SCREENSHOT_OUT_DIR      default <repo>/screenshots-out
 *   SCREENSHOT_VIEWPORT     default 1440x900 (desktop)
 *   SCREENSHOT_NAME_SUFFIX  default '' — appended to every scene's
 *     name/file. A mobile pass is then cheap: a second invocation
 *     with e.g. SCREENSHOT_VIEWPORT=390x844 SCREENSHOT_NAME_SUFFIX=-mobile
 *     SCREENSHOT_OUT_DIR=screenshots-out-mobile produces a distinct,
 *     non-colliding screenshot set (Weblate names stay unique).
 *
 * After capture, prints a non-failing coverage report (keys with a
 * screenshot / total `en.json` keys) and, in CI, writes it to
 * $GITHUB_STEP_SUMMARY. See `docs/WEBLATE_SCREENSHOT_SYNC_PLAN.md`.
 */

import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Browser } from 'playwright'

import {
  REPO_ROOT,
  assertSafeOutDir,
  launchBrowser,
  padClip,
  parseViewport,
  screenshotWithRetry,
  slugKey,
  withScenePage,
} from './core/browser'
import { installFixtures } from './core/fixtures'
import type { Box } from './core/types'
import {
  computeCoverage,
  formatCoverageLine,
  formatCoverageMarkdown,
} from './coverage'
import { scenes, type Scene } from './scenes'

// Re-exported so the existing helper tests (capture.helpers.test.ts) and
// any other importer keep resolving these from './capture'.
export { padClip, slugKey }

const BASE_URL = process.env.SCREENSHOT_BASE_URL ?? 'http://localhost:4173'
// Resolve to an absolute path so the safety guard and every
// `resolve(OUT_DIR, file)` below behave the same for a relative
// SCREENSHOT_OUT_DIR (e.g. the mobile-pass "screenshots-out-mobile").
const OUT_DIR = resolve(
  process.env.SCREENSHOT_OUT_DIR ?? resolve(REPO_ROOT, 'screenshots-out'),
)
const NAME_SUFFIX = process.env.SCREENSHOT_NAME_SUFFIX ?? ''

// Per-string close-up crops (phase S7). Weblate's only native
// per-string highlight is OCR-based and its REST API has no
// coordinate field, so instead of pushing highlight regions we
// upload a tight, padded crop of each string's own DOM element as
// that string's screenshot — the "pertinent section, zoomed" — next
// to the full-scene shot that gives context. Off via SCREENSHOT_CROPS=false.
const CROPS_ENABLED = process.env.SCREENSHOT_CROPS !== 'false'
// Context padding (CSS px) around the element in a crop.
const CROP_PAD = 24
// The i18n DOM attributes that name a message key (mirror of
// src/i18n/applyI18nAttributes.ts). Each maps an element → a key, so
// the element's box is exactly where that key renders.
const I18N_ATTRS = [
  'data-i18n',
  'data-i18n-aria-label',
  'data-i18n-title',
  'data-i18n-placeholder',
] as const

/** Shape the app publishes on `window.__i18nTrace` (see
 *  `src/i18n/screenshotTrace.ts`). Declared locally because that
 *  global augmentation lives under `src/` and isn't visible to this
 *  node script; the evaluate callbacks run in the browser anyway. */
interface I18nTraceHandle {
  seen: Set<string>
  reset(): void
}
type TracedWindow = Window & { __i18nTrace?: I18nTraceHandle }

/** One entry in `screenshots.json`. A full-scene shot (`kind:
 *  'scene'`, many keys) or a per-string close-up crop (`kind:
 *  'crop'`, exactly one key). The uploader treats both identically —
 *  create/replace image + associate `keys` — so crops need no special
 *  handling there. */
export interface CapturedScene {
  name: string
  description: string
  file: string
  sha256: string
  keys: string[]
  kind: 'scene' | 'crop'
}

const sha256 = (buf: Buffer): string =>
  createHash('sha256').update(buf).digest('hex')

/**
 * Read the keys a scene rendered. The page may navigate (full reload)
 * during `setup()`, which wipes `window.__i18nTrace`, so we read it
 * *after* setup and tolerate its absence (a scene that rendered no
 * `t()`-resolved string — unusual, but not an error here; the
 * uploader simply has nothing to associate).
 */
async function readTracedKeys(
  page: import('playwright').Page,
): Promise<string[]> {
  const keys = await page.evaluate(() => {
    const w = window as TracedWindow
    return w.__i18nTrace ? [...w.__i18nTrace.seen] : []
  })
  return keys.sort()
}

/**
 * Capture a padded close-up of every visible i18n-tagged element on
 * the current page, one per *distinct* key (first scene to render a
 * key wins — `croppedKeys` is shared across the run). Best-effort and
 * fully isolated: any element that can't be measured or shot is
 * skipped, never failing the scene.
 *
 * Only elements carrying a `data-i18n*` attribute are croppable,
 * because that attribute tells us the exact key at that exact box.
 * Strings set via `t()` in JS (dynamic cards, etc.) have no such
 * marker, so they rely on the full-scene shot — same boundary the
 * plan calls out for viewport precision.
 */
interface CropTarget {
  key: string
  box: Box
}

/**
 * Find every *visible* i18n-tagged element and its box in ONE
 * in-browser pass. Doing the visibility + geometry check client-side
 * (synchronous `getBoundingClientRect` / `getComputedStyle`) is
 * essential for speed: a per-element Playwright `boundingBox()` loop
 * blocks on hidden elements (collapsed panels) and re-probes them on
 * every scene, which is O(scenes × hidden-elements) and stalls the
 * run. Here hidden elements are filtered out instantly.
 *
 * Boxes are viewport coordinates (scenes don't scroll the window —
 * the panels are fixed/absolute overlays), which is what
 * `page.screenshot({ clip })` expects.
 */
async function collectCropTargets(
  page: import('playwright').Page,
): Promise<CropTarget[]> {
  return page.evaluate((attrs: string[]) => {
    const out: { key: string; box: Box }[] = []
    const seen = new Set<string>()
    for (const attr of attrs) {
      for (const el of Array.from(document.querySelectorAll(`[${attr}]`))) {
        const key = el.getAttribute(attr)
        if (!key || seen.has(key)) continue
        const r = el.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) continue
        // Off-screen → skip (only the viewport is captured anyway).
        if (
          r.bottom <= 0 ||
          r.right <= 0 ||
          r.top >= window.innerHeight ||
          r.left >= window.innerWidth
        ) {
          continue
        }
        const cs = window.getComputedStyle(el as HTMLElement)
        if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') {
          continue
        }
        seen.add(key)
        out.push({ key, box: { x: r.left, y: r.top, width: r.width, height: r.height } })
      }
    }
    return out
    // `Box` is structurally identical in the page context.
  }, [...I18N_ATTRS] as string[])
}

async function captureCrops(
  page: import('playwright').Page,
  scene: Scene,
  viewport: { width: number; height: number },
  croppedKeys: Set<string>,
): Promise<CapturedScene[]> {
  const crops: CapturedScene[] = []
  let targets: CropTarget[]
  try {
    targets = await collectCropTargets(page)
  } catch {
    return crops
  }
  for (const { key, box } of targets) {
    if (croppedKeys.has(key)) continue
    const clip = padClip(box, CROP_PAD, viewport)
    if (clip.width < 1 || clip.height < 1) continue
    const name = `crop:${key}${NAME_SUFFIX}`
    const file = `crop-${slugKey(key)}${NAME_SUFFIX}.png`
    let png: Buffer
    try {
      png = await page.screenshot({
        path: resolve(OUT_DIR, file),
        clip,
        animations: 'disabled',
        timeout: 15_000,
      })
    } catch {
      continue
    }
    croppedKeys.add(key)
    crops.push({
      name,
      description: `Close-up of "${key}" (on ${scene.name})`,
      file,
      sha256: sha256(png),
      keys: [key],
      kind: 'crop',
    })
  }
  return crops
}

async function captureScene(
  browser: Browser,
  scene: Scene,
  viewport: { width: number; height: number },
  croppedKeys: Set<string>,
): Promise<CapturedScene[]> {
  return withScenePage(browser, { viewport, baseURL: BASE_URL }, async (page) => {
    // Fresh trace per scene. Reset before setup in case the first
    // navigation already happened; the hook re-publishes the handle
    // on the next resolved key regardless.
    await page.addInitScript(() => {
      ;(window as TracedWindow).__i18nTrace?.reset()
    })
    // Populate data-backed surfaces so per-string crops capture real
    // content, not a "Loading…" state (Phase V7).
    if (scene.fixtures) await installFixtures(page, scene.fixtures)
    await scene.setup(page)
    const keys = await readTracedKeys(page)
    const name = `${scene.name}${NAME_SUFFIX}`
    const file = `${name}.png`
    const png = await screenshotWithRetry(page, resolve(OUT_DIR, file))
    const sceneShot: CapturedScene = {
      name,
      description: scene.description,
      file,
      sha256: sha256(png),
      keys,
      kind: 'scene',
    }
    const crops = CROPS_ENABLED
      ? await captureCrops(page, scene, viewport, croppedKeys)
      : []
    return [sceneShot, ...crops]
  })
}

/**
 * Scenes this (Weblate string-screenshot) capturer should run — every
 * scene except those opted out via `Scene.skipWeblate`. Heavy-WebGL
 * scenes (the globe) are opted out because this capturer reuses one
 * long-lived browser and takes full-page screenshots: the globe's GPU
 * pressure makes the following scenes' captures fail. Exported for tests.
 */
export function weblateScenes(all: readonly Scene[] = scenes): Scene[] {
  return all.filter((s) => !s.skipWeblate)
}

async function run(): Promise<void> {
  const viewport = parseViewport()

  // Clean slate so a removed/renamed scene doesn't leave a stale PNG.
  assertSafeOutDir(OUT_DIR)
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })

  const captureList = weblateScenes()

  // eslint-disable-next-line no-console
  console.log(
    `Capturing ${captureList.length} scene(s) from ${BASE_URL} ` +
      `at ${viewport.width}x${viewport.height} → ${OUT_DIR}`,
  )

  // Hardening for the long capture run: taking ~25 full-page
  // screenshots in one browser accumulates renderer resources
  // (notably /dev/shm in containerized CI, plus compositor memory)
  // until `Page.captureScreenshot` fails in a block of scenes, then
  // recovers once they're reclaimed. `--disable-dev-shm-usage` moves
  // that scratch space to /tmp, and we recycle the browser every few
  // scenes so nothing accumulates far enough to fail. Both are
  // render-neutral (no GPU/rendering flags). See PR #201.
  const BROWSER_ARGS = ['--disable-dev-shm-usage']
  // Recycle frequently: at every-5 a single scene still failed when its
  // batch followed ~4 WebGL-heavy scenes (browse-graph/timeline/map +
  // orbit-settings), just over the exhaustion threshold. Every-3 keeps
  // at most ~2 heavy scenes per browser, well under it.
  const RECYCLE_EVERY = 3

  let browser = await launchBrowser({ args: BROWSER_ARGS })
  const captured: CapturedScene[] = []
  // Shared across scenes so each distinct string is cropped once
  // (first scene that renders it visibly wins).
  const croppedKeys = new Set<string>()
  let failed = 0
  let sinceLaunch = 0
  try {
    // Serial: scenes are cheap and serial keeps the log readable and
    // the trace unambiguous (one page in flight at a time).
    for (const scene of captureList) {
      // Recycle the browser to release accumulated renderer resources
      // before they exhaust (see BROWSER_ARGS note above).
      if (sinceLaunch >= RECYCLE_EVERY) {
        await browser.close()
        browser = await launchBrowser({ args: BROWSER_ARGS })
        sinceLaunch = 0
      }
      try {
        const results = await captureScene(browser, scene, viewport, croppedKeys)
        captured.push(...results)
        const sceneShot = results[0]
        const crops = results.length - 1
        // eslint-disable-next-line no-console
        console.log(
          `✓ ${scene.name} (${sceneShot.keys.length} keys` +
            (crops > 0 ? `, +${crops} crops` : '') +
            ')',
        )
      } catch (err) {
        failed++
        const msg = err instanceof Error ? err.message : String(err)
        // eslint-disable-next-line no-console
        console.error(`✗ ${scene.name}: ${msg}`)
      }
      sinceLaunch++
    }
  } finally {
    await browser.close()
  }

  await writeFile(
    resolve(OUT_DIR, 'screenshots.json'),
    JSON.stringify(captured, null, 2) + '\n',
  )

  const sceneCount = captured.filter((c) => c.kind === 'scene').length
  const cropCount = captured.filter((c) => c.kind === 'crop').length
  // eslint-disable-next-line no-console
  console.log(
    `\nDone. ${sceneCount} scene(s) + ${cropCount} crop(s), ${failed} failed → ` +
      `${resolve(OUT_DIR, 'screenshots.json')}`,
  )

  await emitCoverage(captured, sceneCount, cropCount)

  // A broken scene (stale selector) must fail the job loudly rather
  // than silently shrinking the screenshot set.
  if (failed > 0) process.exitCode = 1
}

/**
 * Print a non-failing coverage report and, in CI, append it to the
 * job summary. Best-effort: a missing/unreadable `en.json` is logged
 * and skipped rather than failing the capture.
 */
async function emitCoverage(
  captured: CapturedScene[],
  sceneCount: number,
  cropCount: number,
): Promise<void> {
  let enKeys: Set<string>
  try {
    const raw = await readFile(resolve(REPO_ROOT, 'locales', 'en.json'), 'utf-8')
    enKeys = new Set(Object.keys(JSON.parse(raw) as Record<string, string>))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // eslint-disable-next-line no-console
    console.warn(`Coverage skipped — could not read locales/en.json: ${msg}`)
    return
  }

  const stats = computeCoverage(
    captured.map((c) => c.keys),
    enKeys,
  )
  // eslint-disable-next-line no-console
  console.log(formatCoverageLine(stats))
  if (stats.unknown.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `${stats.unknown.length} captured key(s) not in en.json (stale or dynamic).`,
    )
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    await appendFile(
      summaryPath,
      formatCoverageMarkdown(stats, sceneCount, cropCount),
    )
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run().catch((err) => {
    if (err instanceof Error) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  })
}

export { run }
