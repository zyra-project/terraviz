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
 *   SCREENSHOT_BASE_URL   default http://localhost:4173
 *   SCREENSHOT_OUT_DIR    default <repo>/screenshots-out
 *   SCREENSHOT_VIEWPORT   default 1440x900   (desktop; mobile is S6)
 *
 * See `docs/WEBLATE_SCREENSHOT_SYNC_PLAN.md`.
 */

import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { chromium, type Browser } from 'playwright'

import { scenes, type Scene } from './scenes'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const REPO_ROOT = resolve(HERE, '..', '..')

const BASE_URL = process.env.SCREENSHOT_BASE_URL ?? 'http://localhost:4173'
const OUT_DIR =
  process.env.SCREENSHOT_OUT_DIR ?? resolve(REPO_ROOT, 'screenshots-out')

function parseViewport(): { width: number; height: number } {
  const raw = process.env.SCREENSHOT_VIEWPORT ?? '1440x900'
  const m = /^(\d+)x(\d+)$/.exec(raw.trim())
  if (!m) {
    throw new Error(
      `SCREENSHOT_VIEWPORT must look like "1440x900", got "${raw}".`,
    )
  }
  return { width: Number(m[1]), height: Number(m[2]) }
}

/** Shape the app publishes on `window.__i18nTrace` (see
 *  `src/i18n/screenshotTrace.ts`). Declared locally because that
 *  global augmentation lives under `src/` and isn't visible to this
 *  node script; the evaluate callbacks run in the browser anyway. */
interface I18nTraceHandle {
  seen: Set<string>
  reset(): void
}
type TracedWindow = Window & { __i18nTrace?: I18nTraceHandle }

/** One entry in `screenshots.json`. */
export interface CapturedScene {
  name: string
  description: string
  file: string
  sha256: string
  keys: string[]
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

async function captureScene(
  browser: Browser,
  scene: Scene,
  viewport: { width: number; height: number },
): Promise<CapturedScene> {
  const context = await browser.newContext({ viewport, baseURL: BASE_URL })
  const page = await context.newPage()
  try {
    // Fresh trace per scene. Reset before setup in case the first
    // navigation already happened; the hook re-publishes the handle
    // on the next resolved key regardless.
    await page.addInitScript(() => {
      ;(window as TracedWindow).__i18nTrace?.reset()
    })
    await scene.setup(page)
    const keys = await readTracedKeys(page)
    const file = `${scene.name}.png`
    const png = await page.screenshot({ path: resolve(OUT_DIR, file) })
    return {
      name: scene.name,
      description: scene.description,
      file,
      sha256: sha256(png),
      keys,
    }
  } finally {
    await context.close()
  }
}

async function run(): Promise<void> {
  const viewport = parseViewport()

  // Clean slate so a removed/renamed scene doesn't leave a stale PNG.
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })

  // eslint-disable-next-line no-console
  console.log(
    `Capturing ${scenes.length} scene(s) from ${BASE_URL} ` +
      `at ${viewport.width}x${viewport.height} → ${OUT_DIR}`,
  )

  const browser = await chromium.launch()
  const captured: CapturedScene[] = []
  let failed = 0
  try {
    // Serial: scenes are cheap and serial keeps the log readable and
    // the trace unambiguous (one page in flight at a time).
    for (const scene of scenes) {
      try {
        const result = await captureScene(browser, scene, viewport)
        captured.push(result)
        // eslint-disable-next-line no-console
        console.log(`✓ ${scene.name} (${result.keys.length} keys)`)
      } catch (err) {
        failed++
        const msg = err instanceof Error ? err.message : String(err)
        // eslint-disable-next-line no-console
        console.error(`✗ ${scene.name}: ${msg}`)
      }
    }
  } finally {
    await browser.close()
  }

  await writeFile(
    resolve(OUT_DIR, 'screenshots.json'),
    JSON.stringify(captured, null, 2) + '\n',
  )

  // eslint-disable-next-line no-console
  console.log(
    `\nDone. ${captured.length} captured, ${failed} failed → ` +
      `${resolve(OUT_DIR, 'screenshots.json')}`,
  )

  // A broken scene (stale selector) must fail the job loudly rather
  // than silently shrinking the screenshot set.
  if (failed > 0) process.exitCode = 1
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
