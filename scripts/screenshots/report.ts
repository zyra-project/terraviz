/**
 * Visual report capturer (Phase V3).
 *
 * Drives every scene in `./scenes.ts` across a viewport matrix (desktop
 * + mobile by default) with a headless Chromium, collecting for each
 * shot a PNG and the problem signals observed while it was on screen
 * (console errors, page errors, failed/4xx-5xx requests, and — with
 * `VISUAL_AXE` on — accessibility violations). Emits:
 *
 *   report-out/report.json   the manifest (`ReportManifest`)
 *   report-out/<scene>-<vp>.png
 *   report-out/index.html    a self-contained browsable report
 *
 * This is the developer-facing visual-debug surface and the basis for
 * the CI regression diff + deploy report. It is independent of the
 * Weblate capturer (`./capture.ts`) — different output dir, no i18n
 * trace — but shares the capture core.
 *
 * Prerequisite: a running server. The simplest path:
 *     npm run dev -- --port 4173 &
 *     npm run screenshots:report
 *
 * Config (env):
 *   SCREENSHOT_BASE_URL   default http://localhost:4173
 *   SCREENSHOT_OUT_DIR    default <repo>/report-out
 *   VISUAL_VIEWPORTS      default "desktop=1440x900,mobile=390x844"
 *   VISUAL_AXE            "1"/"true" → run an axe-core a11y scan per shot
 *
 * See `docs/VISUAL_REPORT_PLAN.md`.
 */

import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Browser } from 'playwright'

import {
  REPO_ROOT,
  assertSafeOutDir,
  launchBrowser,
  parseViewport,
  screenshotWithRetry,
  withScenePage,
} from './core/browser'
import { installFixtures } from './core/fixtures'
import { attachSignalCollectors, axeEnabled, runAxe } from './core/signals'
import type { Viewport } from './core/types'
import { renderReportHtml } from './report/render'
import { summarizeSignals } from './report/render'
import type { ReportManifest, ReportShot } from './report/types'
import { scenes, type Scene } from './scenes'

const BASE_URL = process.env.SCREENSHOT_BASE_URL ?? 'http://localhost:4173'
const OUT_DIR = resolve(
  process.env.SCREENSHOT_OUT_DIR ?? resolve(REPO_ROOT, 'report-out'),
)
const DEFAULT_VIEWPORTS = 'desktop=1440x900,mobile=390x844'

interface ViewportPass {
  label: string
  viewport: Viewport
}

const sha256 = (buf: Buffer): string =>
  createHash('sha256').update(buf).digest('hex')

/**
 * Parse the `label=WIDTHxHEIGHT,…` viewport matrix. Exported for tests.
 */
export function parseViewportMatrix(
  raw: string = process.env.VISUAL_VIEWPORTS ?? DEFAULT_VIEWPORTS,
): ViewportPass[] {
  const passes = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=')
      if (eq === -1) {
        throw new Error(
          `VISUAL_VIEWPORTS entry must be "label=WIDTHxHEIGHT", got "${part}".`,
        )
      }
      const label = part.slice(0, eq).trim()
      if (!label) throw new Error(`VISUAL_VIEWPORTS entry has an empty label: "${part}".`)
      // The label becomes part of the screenshot filename
      // (`<scene>-<label>.png`), so restrict it to a filesystem-safe
      // charset — no slashes or dots — to prevent path traversal out of
      // the output directory.
      if (!/^[a-z0-9_-]+$/i.test(label)) {
        throw new Error(
          `VISUAL_VIEWPORTS label "${label}" must be alphanumeric, dash, ` +
            'or underscore only (it is used as a filename).',
        )
      }
      return { label, viewport: parseViewport(part.slice(eq + 1)) }
    })
  if (passes.length === 0) throw new Error('VISUAL_VIEWPORTS resolved to no viewports.')
  return passes
}

async function captureShot(
  browser: Browser,
  scene: Scene,
  pass: ViewportPass,
): Promise<ReportShot> {
  return withScenePage(
    browser,
    { viewport: pass.viewport, baseURL: BASE_URL },
    async (page) => {
      const collector = attachSignalCollectors(page)
      if (scene.fixtures) await installFixtures(page, scene.fixtures)
      await scene.setup(page)
      if (axeEnabled()) {
        collector.signals.axeViolations = await runAxe(page)
      }
      const file = `${scene.name}-${pass.label}.png`
      const mask = (scene.masks ?? []).map((sel) => page.locator(sel))
      const png = await screenshotWithRetry(page, resolve(OUT_DIR, file), { mask })
      return {
        scene: scene.name,
        description: scene.description,
        viewport: pass.label,
        width: pass.viewport.width,
        height: pass.viewport.height,
        file,
        sha256: sha256(png),
        signals: collector.signals,
      }
    },
  )
}

async function run(): Promise<void> {
  const passes = parseViewportMatrix()

  assertSafeOutDir(OUT_DIR)
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })

  // eslint-disable-next-line no-console
  console.log(
    `Capturing ${scenes.length} scene(s) × ${passes.length} viewport(s) ` +
      `from ${BASE_URL} → ${OUT_DIR}`,
  )

  const browser = await launchBrowser()
  const shots: ReportShot[] = []
  let failed = 0
  try {
    for (const pass of passes) {
      for (const scene of scenes) {
        // Skip surfaces the product hides below their min width (e.g.
        // Graph / Timeline on portrait phones) — a skip, not a failure.
        if (scene.minWidth && pass.viewport.width < scene.minWidth) {
          // eslint-disable-next-line no-console
          console.log(
            `↷ ${scene.name} @ ${pass.label} (needs ≥${scene.minWidth}px)`,
          )
          continue
        }
        try {
          const shot = await captureShot(browser, scene, pass)
          shots.push(shot)
          const { total } = summarizeSignals(shot.signals)
          // eslint-disable-next-line no-console
          console.log(
            `✓ ${scene.name} @ ${pass.label}` +
              (total > 0 ? ` (${total} problem(s))` : ''),
          )
        } catch (err) {
          failed++
          const msg = err instanceof Error ? err.message : String(err)
          // eslint-disable-next-line no-console
          console.error(`✗ ${scene.name} @ ${pass.label}: ${msg}`)
        }
      }
    }
  } finally {
    await browser.close()
  }

  const manifest: ReportManifest = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    viewports: passes.map((p) => p.label),
    shots,
  }
  await writeFile(
    resolve(OUT_DIR, 'report.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  )
  await writeFile(resolve(OUT_DIR, 'index.html'), renderReportHtml(manifest))

  const problems = shots.reduce((n, s) => n + summarizeSignals(s.signals).total, 0)
  // eslint-disable-next-line no-console
  console.log(
    `\nDone. ${shots.length} shot(s), ${problems} problem(s), ${failed} failed → ` +
      `${resolve(OUT_DIR, 'index.html')}`,
  )

  // A broken scene (stale selector) must fail the job loudly rather than
  // silently shrinking the report.
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
