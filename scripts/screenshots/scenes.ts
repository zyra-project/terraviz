/**
 * Scene manifest for the Weblate screenshot pipeline.
 *
 * This is the one artifact a human maintains. Each scene is a stable
 * name plus an async `setup()` that drives the running app to a state
 * worth screenshotting. The capturer
 * (`scripts/screenshots/capture.ts`) handles the rest: it resets the
 * key trace, runs `setup()`, reads which i18n keys the scene
 * rendered (`window.__i18nTrace`), and screenshots the viewport.
 *
 * Keep scenes coarse — one per meaningful UI surface, ~15–25 total
 * at full coverage. The string→screenshot association falls out of
 * the capture automatically (via the `VITE_I18N_TRACE` hook in
 * `src/i18n/screenshotTrace.ts`); you never list individual keys
 * here.
 *
 * Prefer stable `#id` / role / text selectors over brittle CSS so a
 * styling change doesn't silently break a scene — and when a
 * selector *does* go stale, the capture step fails loudly in CI
 * rather than uploading a blank image.
 *
 * This is the **starter** set (phase S3). Broaden it to the full
 * high-traffic surface in S6. See
 * `docs/WEBLATE_SCREENSHOT_SYNC_PLAN.md`.
 */

import type { Page } from 'playwright'

import { gotoApp } from './core/browser'
import type { FixtureRule } from './core/fixtures'
import { publisherFixtures } from './fixtures/publisher'

export interface Scene {
  /** Stable id — used as the screenshot filename and Weblate name. */
  name: string
  /** Human-readable note for the manifest reviewer. */
  description: string
  /** Drive the app to the state to capture. */
  setup: (page: Page) => Promise<void>
  /**
   * Selectors for non-deterministic regions to mask out of the visual
   * regression diff (the WebGL globe, MapLibre tiles, a force-directed
   * graph). Consumed by the report capturer's `screenshot({ mask })`;
   * the Weblate capturer ignores it (translators want to see the
   * content). See `docs/VISUAL_REPORT_PLAN.md`.
   */
  masks?: string[]
  /**
   * `/api/**` route-stub fixtures installed before `setup()` so
   * data-backed surfaces (publisher / admin) render populated views
   * instead of a "Loading…" state. See `core/fixtures.ts` and
   * `fixtures/publisher.ts` (Phase V7).
   */
  fixtures?: FixtureRule[]
  /**
   * Minimum viewport width (CSS px) this scene applies to. The report
   * capturer *skips* (does not fail) the scene at narrower viewports —
   * used for surfaces the product itself hides on small screens, e.g.
   * the Graph / Timeline views, whose toggles are absent under the app's
   * `(max-width: 768px) and (orientation: portrait)` gate. Omit to
   * capture at every viewport.
   */
  minWidth?: number
}

/** Open the catalog landing surface (the Browse overlay). */
async function openCatalog(page: Page): Promise<void> {
  await gotoApp(page, '/?catalog=true')
  await page.locator('#browse-overlay').waitFor({ state: 'visible' })
  // Let the filter rail / grid paint before keys are read.
  await page.locator('#browse-toolbar').waitFor({ state: 'visible' })
}

/**
 * Open a publisher-portal route.
 *
 * The portal lives behind Cloudflare Access with a Pages-Functions
 * API backend — neither exists against a local dev server. What
 * *does* render without a backend is the part translators most need
 * context for: the topbar + section tabs, page headings, and (for
 * the static-form pages) field labels/placeholders. Every page
 * mounts its chrome synchronously before fetching data.
 *
 * Scenes that set `fixtures` (Phase V7) stub `/api/**` with
 * `installFixtures` *before* this navigates, so the data-backed
 * list/detail/admin pages render *populated* views instead of the
 * "Loading…" state they show without a backend. Scenes without fixtures
 * still capture the chrome + nav strings (already more context than an
 * empty Weblate screenshot field).
 */
async function openPublish(page: Page, path: string): Promise<void> {
  await gotoApp(page, path)
  await page.locator('#publisher-root .publisher-topbar').waitFor({ state: 'visible' })
}

export const scenes: Scene[] = [
  {
    name: 'catalog-landing',
    description: 'Dataset browser as the catalog landing surface, no filters applied',
    // The "Right now" hero (heroService) re-rolls its dataset on each
    // fresh capture, so its thumbnail/title differ run-to-run — mask it
    // out of the diff (it's prominent on mobile and flapped the gate).
    masks: ['#hero-panel'],
    async setup(page) {
      await openCatalog(page)
    },
  },
  {
    name: 'browse-filters-open',
    description:
      'Browse overlay with the inline filter rail and an active facet filter applied',
    async setup(page) {
      await openCatalog(page)
      // At the capturer's 1440px desktop viewport the Cards view shows
      // the filter rail inline at every breakpoint; the small-screen
      // "Filters" drawer toggle (#browse-filters-btn) is display:none
      // here and only appears ≤1024px on the Graph/Timeline/Map views.
      // So drive the inline rail directly and activate the first facet
      // chip — that captures the rail plus the active-filter chrome.
      const rail = page.locator('#browse-filter-rail')
      await rail.waitFor({ state: 'visible' })
      await rail.locator('.browse-chip[data-facet]').first().click()
      await rail.locator('.browse-chip[aria-pressed="true"]').first().waitFor()
    },
  },
  {
    name: 'browse-search-active',
    description: 'Browse overlay with an active search query and the clear button shown',
    async setup(page) {
      await openCatalog(page)
      await page.locator('#browse-search').fill('ocean')
      // The clear button un-hides once the query is non-empty.
      await page.locator('#browse-search-clear:not(.hidden)').waitFor()
    },
  },
  {
    name: 'orbit-chat-open',
    description: 'Orbit (digital docent) chat panel opened from the browser',
    async setup(page) {
      await openCatalog(page)
      await page.locator('#browse-chat-btn').click()
      await page.locator('#chat-panel').waitFor({ state: 'visible' })
    },
  },
  {
    name: 'help-panel',
    description: 'Help & feedback panel (Guide tab + feedback form)',
    async setup(page) {
      await openCatalog(page)
      await page.locator('#help-trigger-browse').click()
      await page.locator('#help-panel').waitFor({ state: 'visible' })
    },
  },
  {
    name: 'browse-graph-view',
    description: 'Browse overlay switched to the Graph view',
    // The cytoscape force layout settles to slightly different pixel
    // positions per run; mask it so the diff doesn't flap.
    masks: ['#browse-graph'],
    // The Graph toggle is dropped on portrait phones (Cards + Map only),
    // so only capture this on wider viewports.
    minWidth: 769,
    async setup(page) {
      await openCatalog(page)
      await page.locator('#browse-view-mode [data-view-mode="graph"]').click()
      await page.locator('#browse-graph:not(.hidden)').waitFor()
    },
  },
  {
    name: 'browse-timeline-view',
    description: 'Browse overlay switched to the Timeline view',
    // Like Graph, the Timeline toggle is absent on portrait phones.
    minWidth: 769,
    async setup(page) {
      await openCatalog(page)
      await page.locator('#browse-view-mode [data-view-mode="timeline"]').click()
      await page.locator('#browse-timeline:not(.hidden)').waitFor()
    },
  },
  {
    name: 'browse-map-view',
    description: 'Browse overlay switched to the Map (geographic coverage) view',
    // MapLibre renders tiles asynchronously and non-deterministically;
    // mask the map canvas so only the surrounding chrome is diffed.
    masks: ['#browse-map'],
    async setup(page) {
      await openCatalog(page)
      await page.locator('#browse-view-mode [data-view-mode="map"]').click()
      await page.locator('#browse-map:not(.hidden)').waitFor()
    },
  },

  // ── Publisher portal ──────────────────────────────────────────
  // Populated via route-stub fixtures (Phase V7); see openPublish().
  {
    name: 'publish-datasets',
    description: 'Publisher portal — datasets list (populated via fixtures)',
    fixtures: publisherFixtures(),
    async setup(page) {
      await openPublish(page, '/publish/datasets')
    },
  },
  {
    name: 'publish-dataset-new',
    description: 'Publisher portal — new-dataset form (field labels & placeholders)',
    fixtures: publisherFixtures(),
    async setup(page) {
      await openPublish(page, '/publish/datasets/new')
    },
  },
  {
    name: 'publish-workflows',
    description: 'Publisher portal — Zyra workflows list (populated via fixtures)',
    fixtures: publisherFixtures(),
    async setup(page) {
      await openPublish(page, '/publish/workflows')
    },
  },
  {
    name: 'publish-workflow-new',
    description: 'Publisher portal — new-workflow form (YAML editor + validate)',
    fixtures: publisherFixtures(),
    async setup(page) {
      await openPublish(page, '/publish/workflows/new')
    },
  },
  {
    name: 'publish-tours',
    description: 'Publisher portal — tour-creator landing page',
    fixtures: publisherFixtures(),
    async setup(page) {
      await openPublish(page, '/publish/tours')
    },
  },
  {
    name: 'publish-import',
    description: 'Publisher portal — import page',
    fixtures: publisherFixtures(),
    async setup(page) {
      await openPublish(page, '/publish/import')
    },
  },
  {
    name: 'publish-featured-hero',
    description: 'Publisher portal — "Right now" featured-hero override',
    fixtures: publisherFixtures({ admin: true }),
    async setup(page) {
      await openPublish(page, '/publish/featured-hero')
    },
  },
  {
    name: 'publish-me',
    description: 'Publisher portal — current-user identity & role (populated)',
    fixtures: publisherFixtures(),
    async setup(page) {
      await openPublish(page, '/publish/me')
    },
  },

  // ── Admin-only surfaces ───────────────────────────────────────
  // Privileged tabs, populated with an admin identity via fixtures so
  // the tabs render. (Analytics/feedback rollup endpoints aren't stubbed
  // yet — those views fall back to their error/empty surface, a
  // representative state worth capturing.)
  {
    name: 'admin-analytics',
    description: 'Admin — analytics dashboard (admin identity via fixtures)',
    fixtures: publisherFixtures({ admin: true }),
    async setup(page) {
      await openPublish(page, '/publish/analytics')
    },
  },
  {
    name: 'admin-feedback',
    description: 'Admin — feedback review (admin identity via fixtures)',
    fixtures: publisherFixtures({ admin: true }),
    async setup(page) {
      await openPublish(page, '/publish/feedback')
    },
  },
  {
    name: 'admin-users',
    description: 'Admin — Users tab (populated via fixtures)',
    fixtures: publisherFixtures({ admin: true }),
    async setup(page) {
      await openPublish(page, '/publish/users')
    },
  },
]
