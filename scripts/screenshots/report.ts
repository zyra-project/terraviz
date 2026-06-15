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
 *   VISUAL_ACCESS_CLIENT_ID / VISUAL_ACCESS_CLIENT_SECRET
 *     a Cloudflare Access service token — when both are set the capture
 *     sends `CF-Access-Client-{Id,Secret}` on *first-party* requests
 *     (same origin as SCREENSHOT_BASE_URL; never to third-party
 *     tile/CDN/API hosts) so it can load routes behind Access (publisher
 *     / admin portal) against a live deploy, and serves *real* backend
 *     data (fixtures are disabled).
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

/**
 * Build the Cloudflare Access service-token headers from the environment,
 * or `undefined` when not configured. Exported for tests.
 *
 * When set, the capture sends these on *first-party* requests only (same
 * origin as the base URL; `withScenePage` scopes them so the token never
 * reaches third-party tile/CDN hosts) so it can load routes behind
 * Cloudflare Access (the publisher / admin portal) against a live deploy
 * — otherwise the headless browser hits the SSO login wall and those
 * scenes time out. Both halves must be present.
 */
export function accessHeadersFromEnv(
  id: string | undefined = process.env.VISUAL_ACCESS_CLIENT_ID,
  secret: string | undefined = process.env.VISUAL_ACCESS_CLIENT_SECRET,
): Record<string, string> | undefined {
  if (id && secret) {
    return { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret }
  }
  return undefined
}

const ACCESS_ID = process.env.VISUAL_ACCESS_CLIENT_ID
const ACCESS_SECRET = process.env.VISUAL_ACCESS_CLIENT_SECRET
const ACCESS_HEADERS = accessHeadersFromEnv(ACCESS_ID, ACCESS_SECRET)
// With an Access service token we are authenticating against a real
// backend, so we want the *real* data the portal renders — fixtures
// (which stub /api with demo data) are disabled in that mode. Without a
// token, fixtures populate the data-backed scenes against a local dev
// server that has no backend.
const USE_FIXTURES = ACCESS_HEADERS === undefined

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

/**
 * Resolve the scene filter from the CLI / environment, or `undefined`
 * for "all scenes". Accepts `--scene a,b`, `--scene=a,b`, `--only a`
 * (argv) or the `VISUAL_ONLY` env var; argv wins. Exported for tests.
 *
 * This is the single-panel fast path: capturing one surface reuses the
 * maintained scene navigation / fixtures / masks instead of an ad-hoc
 * throwaway script. Example:
 *     npm run screenshots:report -- --scene tools-menu
 */
export function resolveSceneFilter(
  argv: readonly string[] = process.argv.slice(2),
  env: string | undefined = process.env.VISUAL_ONLY,
): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--scene' || arg === '--only') return argv[i + 1]
    const m = /^--(?:scene|only)=(.*)$/.exec(arg)
    if (m) return m[1]
  }
  return env
}

/**
 * Narrow the scene list to a comma-separated set of names, preserving
 * the manifest order. Throws on an unknown name (with the available set)
 * so a typo fails loudly rather than silently capturing nothing.
 * A blank/undefined filter selects everything. Exported for tests.
 */
export function selectScenes(
  all: readonly Scene[],
  filter: string | undefined,
): Scene[] {
  const wanted = (filter ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (wanted.length === 0) return [...all]
  const byName = new Map(all.map((s) => [s.name, s]))
  const missing = wanted.filter((name) => !byName.has(name))
  if (missing.length > 0) {
    throw new Error(
      `Unknown scene(s): ${missing.join(', ')}. Available: ` +
        all.map((s) => s.name).join(', '),
    )
  }
  // De-dupe while preserving the order the names were requested in.
  return [...new Set(wanted)].map((name) => byName.get(name)!)
}

async function captureShot(
  browser: Browser,
  scene: Scene,
  pass: ViewportPass,
): Promise<ReportShot> {
  return withScenePage(
    browser,
    { viewport: pass.viewport, baseURL: BASE_URL, extraHTTPHeaders: ACCESS_HEADERS },
    async (page) => {
      const collector = attachSignalCollectors(page)
      if (USE_FIXTURES && scene.fixtures) await installFixtures(page, scene.fixtures)
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
  const selected = selectScenes(scenes, resolveSceneFilter())

  // Half-configured auth is almost always a mistake — warn (without
  // printing the values) so a one-secret CI/local run is easy to
  // diagnose rather than silently capturing the SSO wall.
  if (!ACCESS_HEADERS && (ACCESS_ID || ACCESS_SECRET)) {
    // eslint-disable-next-line no-console
    console.warn(
      'Only one of VISUAL_ACCESS_CLIENT_ID / VISUAL_ACCESS_CLIENT_SECRET ' +
        'is set — running unauthenticated; Access-gated scenes will time ' +
        'out. Set both or neither.',
    )
  }

  assertSafeOutDir(OUT_DIR)
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })

  // eslint-disable-next-line no-console
  console.log(
    `Capturing ${selected.length} scene(s) × ${passes.length} viewport(s) ` +
      `from ${BASE_URL} → ${OUT_DIR}` +
      (selected.length < scenes.length
        ? ` (filtered to: ${selected.map((s) => s.name).join(', ')})`
        : '') +
      (ACCESS_HEADERS
        ? ' (authenticated via CF Access service token; fixtures disabled)'
        : ''),
  )

  const browser = await launchBrowser()
  const shots: ReportShot[] = []
  let failed = 0
  try {
    for (const pass of passes) {
      for (const scene of selected) {
        // Skip surfaces the product hides below their min width (e.g.
        // Graph / Timeline on portrait phones) — a skip, not a failure.
        if (scene.minWidth && pass.viewport.width < scene.minWidth) {
          // eslint-disable-next-line no-console
          console.log(
            `↷ ${scene.name} @ ${pass.label} (needs ≥${scene.minWidth}px)`,
          )
          continue
        }
        // Forced-state scenes (empty list / 500) only exist with stubs;
        // against a real backend (authenticated live run, fixtures off)
        // they'd hang waiting for a state the live data never reaches.
        if (scene.requiresFixtures && !USE_FIXTURES) {
          // eslint-disable-next-line no-console
          console.log(`↷ ${scene.name} @ ${pass.label} (needs fixtures)`)
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
