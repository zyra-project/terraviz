/**
 * Smoke / interaction tests (Phase V8).
 *
 * Drives the live app through a handful of real interactions and
 * asserts on the result — reusing the same capture core, signal
 * collection and route-stub fixtures as the visual report. Unlike the
 * advisory visual diff, this check GATES: any failed assertion or
 * uncaught page error exits non-zero.
 *
 * Covered:
 *   - catalog search narrows the result grid;
 *   - Orbit's local engine answers a chat message (no network/API key —
 *     on a dev server Orbit auto-falls back to the local engine), with
 *     no raw `<<LOAD:…>>` marker leaking into the visible text;
 *   - view-mode navigation mounts each surface without uncaught errors;
 *   - a fixture-backed publisher page renders populated content.
 *
 * The assertion helpers are pure and unit-tested; this file is the thin
 * browser driver. See `docs/VISUAL_REPORT_PLAN.md`.
 */

import { pathToFileURL } from 'node:url'

import type { Browser, Page } from 'playwright'

import { gotoApp, launchBrowser, withScenePage } from './core/browser'
import { installFixtures, type FixtureRule } from './core/fixtures'
import { attachSignalCollectors } from './core/signals'
import { catalogFixtures } from './fixtures/catalog'
import { publisherFixtures } from './fixtures/publisher'

const BASE_URL = process.env.SCREENSHOT_BASE_URL ?? 'http://localhost:4173'
const VIEWPORT = { width: 1440, height: 900 }

/** Thrown by `assert` so a failed check is distinguishable from a crash. */
export class AssertionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssertionError'
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionError(message)
}

export interface SmokeResult {
  name: string
  ok: boolean
  error?: string
}

export interface SmokeSummary {
  passed: number
  failed: number
  ok: boolean
}

/** Aggregate results. Pure — exported for tests. */
export function summarizeSmoke(results: readonly SmokeResult[]): SmokeSummary {
  const failed = results.filter((r) => !r.ok).length
  return { passed: results.length - failed, failed, ok: failed === 0 }
}

interface Check {
  name: string
  fixtures?: FixtureRule[]
  run: (page: Page) => Promise<void>
}

const checks: Check[] = [
  {
    name: 'catalog search narrows the result grid',
    fixtures: catalogFixtures(),
    async run(page) {
      await gotoApp(page, '/?catalog=true')
      await page.locator('#browse-overlay').waitFor({ state: 'visible' })
      await page.locator('#browse-toolbar').waitFor({ state: 'visible' })
      const before = await page.locator('#browse-grid .browse-card').count()
      assert(before > 0, 'expected the catalog grid to render at least one card')

      await page.locator('#browse-search').fill('ocean')
      await page.locator('#browse-search-clear:not(.hidden)').waitFor()
      const after = await page.locator('#browse-grid .browse-card').count()
      // Strictly fewer — a no-op search (the bug this guards against)
      // would leave the count unchanged.
      assert(
        after < before,
        `search should narrow the grid (before=${before}, after=${after})`,
      )
    },
  },
  {
    name: 'Orbit local engine answers a chat message',
    fixtures: catalogFixtures(),
    async run(page) {
      await gotoApp(page, '/?catalog=true')
      await page.locator('#browse-overlay').waitFor({ state: 'visible' })
      await page.locator('#browse-chat-btn').click()
      await page.locator('#chat-panel').waitFor({ state: 'visible' })

      await page.locator('#chat-input').fill('Show me ocean datasets')
      await page.locator('#chat-send').click()

      // The local engine responds without any network. Wait for an
      // assistant (docent) bubble with non-empty text.
      const reply = page.locator('#chat-messages .chat-msg-docent').last()
      await reply.waitFor({ state: 'visible', timeout: 20_000 })
      const text = (await reply.locator('.chat-msg-text').innerText()).trim()
      assert(text.length > 0, 'assistant reply should have visible text')
      assert(
        !text.includes('<<LOAD:'),
        'raw <<LOAD:…>> marker must never leak into the visible reply',
      )
    },
  },
  {
    name: 'view-mode navigation mounts each surface',
    async run(page) {
      await gotoApp(page, '/?catalog=true')
      await page.locator('#browse-overlay').waitFor({ state: 'visible' })
      for (const [mode, panel] of [
        ['graph', '#browse-graph'],
        ['timeline', '#browse-timeline'],
        ['map', '#browse-map'],
      ] as const) {
        await page.locator(`#browse-view-mode [data-view-mode="${mode}"]`).click()
        await page.locator(`${panel}:not(.hidden)`).waitFor()
      }
    },
  },
  {
    name: 'publisher datasets page renders populated content',
    fixtures: publisherFixtures({ admin: true }),
    async run(page) {
      await gotoApp(page, '/publish/datasets')
      await page.locator('#publisher-root .publisher-topbar').waitFor({ state: 'visible' })
      await page
        .locator('#publisher-root', { hasText: 'Global Sea Surface Temperature' })
        .waitFor({ timeout: 15_000 })
    },
  },
  {
    name: 'globe-thumbnail generator renders a preview and re-renders on rotation',
    fixtures: publisherFixtures(),
    async run(page) {
      await gotoApp(page, '/publish/datasets/01HEXAMPLEDATASET00000001/edit')
      await page.locator('#publisher-root .publisher-topbar').waitFor({ state: 'visible' })
      // The thumbnail uploader's globe-thumbnail generator block.
      await page
        .locator('.publisher-asset-uploader-generate')
        .first()
        .waitFor({ timeout: 15_000 })
      // Pick a 2:1 equirectangular frame; the in-browser WebGL globe
      // render must produce a preview.
      await page
        .locator('input[type="file"][id^="dataset-asset-generate-"]')
        .first()
        .setInputFiles('scripts/screenshots/fixtures/equirect-sample.png')
      const preview = page.locator('.publisher-asset-uploader-generate-preview')
      await preview.waitFor({ state: 'visible', timeout: 20_000 })
      const before = await preview.getAttribute('src')
      assert(
        !!before && before.startsWith('blob:'),
        'generated preview should be a blob-URL image',
      )
      // Rotating must re-render: moving the longitude slider swaps the
      // preview to a freshly captured image (a new object URL).
      await page
        .locator('input[type="range"][id$="-lon"]')
        .evaluate((el: HTMLInputElement) => {
          el.value = '120'
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
        })
      await page.waitForFunction(
        (prev) => {
          const img = document.querySelector('.publisher-asset-uploader-generate-preview')
          return img instanceof HTMLImageElement && img.getAttribute('src') !== prev
        },
        before,
        { timeout: 20_000 },
      )
    },
  },
]

async function runCheck(browser: Browser, check: Check): Promise<SmokeResult> {
  try {
    await withScenePage(browser, { viewport: VIEWPORT, baseURL: BASE_URL }, async (page) => {
      const signals = attachSignalCollectors(page)
      if (check.fixtures) await installFixtures(page, check.fixtures)
      await check.run(page)
      // An uncaught page error (a real JS exception) fails the check even
      // when the assertions passed. We deliberately do NOT gate on
      // `console` errors: the browser logs every failed resource load
      // (map tiles, GIBS imagery, external CDNs) as a console error, so
      // gating on them would make this job flaky on transient
      // network/CDN/cert issues. Those are captured as failedRequests /
      // badResponses signals in the advisory report instead.
      assert(
        signals.signals.pageErrors.length === 0,
        `uncaught page error(s): ${signals.signals.pageErrors.join('; ')}`,
      )
    })
    return { name: check.name, ok: true }
  } catch (err) {
    return {
      name: check.name,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function run(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`Running ${checks.length} smoke check(s) against ${BASE_URL}`)
  const browser = await launchBrowser()
  const results: SmokeResult[] = []
  try {
    for (const check of checks) {
      const result = await runCheck(browser, check)
      results.push(result)
      // eslint-disable-next-line no-console
      console.log(
        result.ok ? `✓ ${result.name}` : `✗ ${result.name}\n    ${result.error}`,
      )
    }
  } finally {
    await browser.close()
  }

  const summary = summarizeSmoke(results)
  // eslint-disable-next-line no-console
  console.log(`\n${summary.passed} passed, ${summary.failed} failed.`)
  if (!summary.ok) process.exitCode = 1
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
