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
import { blogPublicFixtures, publisherFixtures } from './fixtures/publisher'

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
    name: 'embed mode strips the app shell',
    fixtures: catalogFixtures(),
    async run(page) {
      // Baseline: this chrome is genuinely visible on a bare globe, so
      // asserting embed mode hides it is a real gate (not a no-op that
      // passes because the element was hidden for some other reason).
      await gotoApp(page, '/')
      for (const id of ['#map-controls', '#help-trigger']) {
        await page.locator(id).waitFor({ state: 'visible' })
      }
      // Embed mode hides it.
      await gotoApp(page, '/?embed=1')
      await page.locator('body.embed-mode').waitFor()
      for (const id of ['#map-controls', '#help-trigger']) {
        assert(!(await page.locator(id).isVisible()), `embed mode should hide ${id}`)
      }
      // The ?chat=1 sub-flag (body.embed-show-chat) must stop embed.css from
      // hiding the Orbit chat trigger. The app only adds `.visible` to the
      // trigger once a dataset loads (never in offline CI), so its live
      // visibility isn't observable here — assert the embed.css rule both
      // ways against the app's real "shown" class instead. A regression on
      // the `:not(.embed-show-chat)` selector flips one of these.
      const rule = await page.evaluate(() => {
        const el = document.getElementById('chat-trigger')
        if (!el) return { hiddenInEmbed: false, shownWithChatFlag: false }
        el.classList.add('visible') // simulate the app having shown the trigger
        const body = document.body
        body.classList.add('embed-mode')
        body.classList.remove('embed-show-chat')
        const hiddenInEmbed = getComputedStyle(el).display === 'none'
        body.classList.add('embed-show-chat')
        const shownWithChatFlag = getComputedStyle(el).display !== 'none'
        return { hiddenInEmbed, shownWithChatFlag }
      })
      assert(rule.hiddenInEmbed, 'embed mode should hide a shown #chat-trigger')
      assert(rule.shownWithChatFlag, '?chat=1 (embed-show-chat) should un-hide #chat-trigger')
    },
  },
  {
    name: 'catalog Timeline exposes the current-event legend',
    async run(page) {
      // The catalog Timeline ships an amber "current event" legend swatch
      // as the user-visible affordance for the event overlays. The swatch
      // is static markup, so asserting it is data-independent.
      //
      // The equivalent MAP-view assertion used to live here too, but the
      // map view lazy-loads the heavy MapLibre chunk before its toolbar
      // (legend) mounts, so on a cold CI runner it occasionally tailed
      // past the wait and flaked this gating check. The map legend swatch
      // is now covered deterministically by the catalogMapUI unit test
      // (`browse-map-legend-dot-event`), and the map view's *mount* is
      // already covered by the "view-mode navigation mounts each surface"
      // check — so the flaky live-map wait was pure redundancy.
      await gotoApp(page, '/?catalog=true')
      await page.locator('#browse-overlay').waitFor({ state: 'visible' })
      await page.locator('#browse-toolbar').waitFor({ state: 'visible' })

      await page.locator('#browse-view-mode [data-view-mode="timeline"]').click()
      await page.locator('#browse-timeline:not(.hidden)').waitFor()
      await page.locator('.browse-timeline-legend-dot-event').first().waitFor({ timeout: 30_000 })
    },
  },
  {
    name: 'publisher datasets page renders populated content',
    fixtures: publisherFixtures({ admin: true }),
    async run(page) {
      await gotoApp(page, '/publish/datasets')
      await page.locator('#publisher-root .publisher-sidebar').waitFor({ state: 'visible' })
      await page
        .locator('#publisher-root', { hasText: 'Global Sea Surface Temperature' })
        .waitFor({ timeout: 15_000 })
    },
  },
  {
    name: 'publisher events review queue renders proposed events + links',
    fixtures: publisherFixtures({ admin: true }),
    async run(page) {
      await gotoApp(page, '/publish/events')
      await page.locator('#publisher-root .publisher-sidebar').waitFor({ state: 'visible' })
      // Direction A master–detail: the queue (left) lists events; the
      // first auto-selects into the detail (right).
      await page.locator('.publisher-events-queue-list').first().waitFor({ timeout: 15_000 })
      await page
        .locator('.publisher-events-detail-title', { hasText: 'Hurricane Lena makes landfall' })
        .first()
        .waitFor()
      // The dataset pairing rows render in the detail, each with a Match Badge.
      const pairings = page.locator('.publisher-events-pairing')
      assert((await pairings.count()) >= 1, 'detail should render at least one dataset pairing')
      assert(
        (await page.locator('.publisher-events-match-badge').count()) >= 1,
        'each pairing should render a Match Badge',
      )
      // Selecting the AI-enriched fixture event surfaces the slice-C
      // "AI-inferred" provenance badge in the meta strip.
      await page
        .locator('.publisher-events-queue-row', { hasText: 'wildfire smoke' })
        .first()
        .click()
      await page.locator('.publisher-events-inferred-badge').first().waitFor({ timeout: 5_000 })
      // The pairings toolbar exposes the one-shot Generate-tour action
      // (event + vetted pairings → editable draft tour).
      await page.locator('.publisher-events-tour-btn').first().waitFor({ timeout: 5_000 })
      // The status filter row lets a curator reach reviewed events.
      const filters = page.locator('.publisher-events-filters button')
      assert((await filters.count()) >= 5, 'queue header should expose the status filter (incl. All)')
      // The authoring toolbar exposes Refresh + New event; clicking New
      // opens the Direction-D drawer (compose + search/pair datasets).
      const toolbarButtons = page.locator('.publisher-events-toolbar button')
      assert((await toolbarButtons.count()) >= 2, 'queue header should expose the Refresh + New-event actions')
      await toolbarButtons.nth(1).click()
      await page.locator('.publisher-events-drawer').first().waitFor({ timeout: 5_000 })
      await page.locator('.publisher-events-drawer-pair').first().waitFor({ timeout: 5_000 })
    },
  },
  {
    name: 'publisher node-profile form renders populated and pre-filled',
    fixtures: publisherFixtures({ admin: true }),
    async run(page) {
      await gotoApp(page, '/publish/node-profile')
      await page.locator('#publisher-root .publisher-sidebar').waitFor({ state: 'visible' })
      const org = page.locator('#nodeprofile-org')
      await org.waitFor({ timeout: 15_000 })
      assert(
        (await org.inputValue()) === 'Coastal Science Center',
        'org-name input should pre-fill from the stored profile',
      )
      assert(
        (await page.locator('.publisher-nodeprofile-link-row').count()) >= 1,
        'stored links should render as editable rows',
      )
    },
  },
  {
    name: 'blog editor renders grounding pickers + Generate; public post renders sanitized markdown',
    fixtures: [...publisherFixtures({ admin: true }), ...blogPublicFixtures()],
    async run(page) {
      // Authoring: the editor is a tabbed stepper (Content / Sources /
      // Media / AI draft). Content is the default tab; the picker,
      // Media grid, and Generate live behind their tabs, so open each
      // before asserting on it.
      await gotoApp(page, '/publish/blog/new')
      await page.locator('#publisher-root .publisher-sidebar').waitFor({ state: 'visible' })
      await page.locator('#blog-title').waitFor({ timeout: 15_000 })
      // Sources tab — the dataset picker enables once the catalog loads.
      await page.locator('.publisher-form-nav-link[data-section="blog-sources"]').click()
      await page.locator('#publisher-root input[type="search"]:not([disabled])').first().waitFor({ timeout: 10_000 })
      // Media tab — the cover picker + suggestion grid (empty until an
      // event is cited, so it shows the "cite an event" hint here).
      await page.locator('.publisher-form-nav-link[data-section="blog-media"]').click()
      await page.locator('.publisher-blog-media-grid').waitFor()
      // AI draft tab — the Generate control.
      await page.locator('.publisher-form-nav-link[data-section="blog-aidraft"]').click()
      await page.locator('.publisher-blog-generate-btn').waitFor()

      // Public: the post page renders the sanitized body, the dataset
      // deep link, and the event citation.
      await gotoApp(page, '/blog/city-lights-spread')
      await page.locator('.blog-post-body h2').waitFor({ timeout: 15_000 })
      const explore = page.locator('.blog-post-explore-list a').first()
      assert(
        (await explore.getAttribute('href')) === '/dataset/01HXDS0000000000000000000A',
        'cited dataset should deep-link into the globe',
      )
      await page.locator('.blog-post-citation a').waitFor()
    },
  },
  {
    name: 'publisher feeds console renders connectors + preset gallery',
    fixtures: publisherFixtures({ admin: true }),
    async run(page) {
      await gotoApp(page, '/publish/feeds')
      await page.locator('#publisher-root .publisher-sidebar').waitFor({ state: 'visible' })
      // The registered connectors render with state dots + bookkeeping.
      await page
        .locator('.publisher-feeds-row', { hasText: 'NASA EONET' })
        .first()
        .waitFor({ timeout: 15_000 })
      assert(
        (await page.locator('.publisher-feeds-dot-off').count()) >= 1,
        'the paused fixture connector should render a paused dot',
      )
      // The curated preset gallery renders grouped suggestions; the
      // already-registered EONET preset shows as added (disabled).
      const presets = page.locator('.publisher-feeds-preset')
      assert((await presets.count()) >= 10, 'the preset gallery should list the curated feeds')
      assert(
        (await page.locator('.publisher-feeds-preset button[disabled]').count()) >= 1,
        'an already-registered preset should show as added',
      )
      // The bring-your-own form is present.
      await page.locator('#feeds-custom-url').waitFor()
      // Preview dry-runs the feed and lists the latest mapped items
      // inline (fixture-backed `/feeds/preview` response).
      await page
        .locator('.publisher-feeds-row', { hasText: 'NASA EONET' })
        .locator('button[aria-expanded]')
        .first()
        .click()
      await page.locator('.publisher-feeds-preview-item').first().waitFor({ timeout: 5_000 })
      assert(
        (await page.locator('.publisher-feeds-preview-item').count()) >= 3,
        'the feed preview should list the fixture items',
      )
    },
  },
  {
    name: 'workflow template picker fills the drought recall pipeline',
    fixtures: publisherFixtures(),
    async run(page) {
      await gotoApp(page, '/publish/workflows/new')
      await page.locator('#publisher-root .publisher-sidebar').waitFor({ state: 'visible' })

      // Pick the curated drought template via the template <select>,
      // identified by its option value (the visible label is i18n).
      const templatePicker = page.locator('select', {
        has: page.locator('option[value="ftp-frames-sos"]'),
      })
      await templatePicker.waitFor({ state: 'visible' })
      await templatePicker.selectOption('ftp-frames-sos')

      // The pipeline textarea (first of the two) now holds the
      // recall-enabled drought pipeline: a basemap pad-missing stage
      // and NO compose-video (it publishes frames, not an MP4).
      const pipeline = page.locator('.publisher-form-textarea').first()
      const yaml = await pipeline.inputValue()
      assert(yaml.includes('command: pad-missing'), 'pipeline should include the pad-missing stage')
      assert(
        yaml.includes('fill-mode: basemap'),
        'drought pad-missing should fill gaps from the basemap',
      )
      assert(
        !yaml.includes('compose-video'),
        'recall-enabled drought template should not compose a video',
      )

      // The metadata template textarea (the second) is seeded too.
      const meta = page.locator('.publisher-form-textarea').nth(1)
      assert(
        (await meta.inputValue()).includes('{{data_start}}'),
        'metadata template should be seeded with the data-range placeholders',
      )
    },
  },
  {
    name: 'globe-thumbnail generator renders a preview and re-renders on rotation',
    fixtures: publisherFixtures(),
    async run(page) {
      await gotoApp(page, '/publish/datasets/01HEXAMPLEDATASET00000001/edit')
      await page.locator('#publisher-root .publisher-sidebar').waitFor({ state: 'visible' })
      // The dataset form is a stepper — open the Media section (where
      // the thumbnail uploader lives) before interacting with it.
      await page.locator('.publisher-form-nav-link[data-section="ds-section-media"]').click()
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
