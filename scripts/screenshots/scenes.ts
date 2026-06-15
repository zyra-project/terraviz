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
 * Keep scenes coarse — one per meaningful UI surface, ~15–30 total
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
import { analyticsFixtures, feedbackFixtures } from './fixtures/admin'
import { publisherFixtures } from './fixtures/publisher'

export interface Scene {
  /** Stable id — used as the screenshot filename and Weblate name. */
  name: string
  /** Human-readable note for the manifest reviewer. */
  description: string
  /** Drive the app to the state to capture. */
  setup: (page: Page) => Promise<void>
  /**
   * Optional selector for a single element to *additionally* capture as
   * a tightly-cropped PNG (`<scene>-<viewport>-crop.png`), alongside the
   * full-viewport shot. Use it to make a component the focus of the
   * report — a panel / popover / form — when the full viewport is mostly
   * context. The report capturer crops to this element's bounding box;
   * the Weblate capturer ignores it. The full shot is always captured.
   */
  crop?: string
  /**
   * Opt this scene out of the Weblate string-screenshot capturer
   * (`capture.ts`) — it is still captured by the report capturer.
   *
   * Use for scenes whose heavy WebGL rendering (the globe) destabilizes
   * the Weblate capturer's long-lived shared browser: that capturer
   * takes *full-page* screenshots, and the globe's GPU pressure makes
   * the *following* scenes' captures fail with Chromium's "Unable to
   * capture screenshot". The report capturer is unaffected — it takes
   * viewport screenshots and masks the globe (`#map-grid`).
   */
  skipWeblate?: boolean
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
  /**
   * This scene's state is *forced* by fixtures (an empty list, a 500
   * error) and cannot be reproduced against a real backend. The report
   * capturer skips it when fixtures are disabled (the authenticated live
   * deploy-report run), where it would otherwise hang waiting for a state
   * the live data never reaches. The Weblate capturer always runs it (it
   * is always local + stubbed).
   */
  requiresFixtures?: boolean
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

/**
 * Open the globe (Sphere) view with no dataset loaded.
 *
 * The desktop landing auto-opens the Browse overlay over the globe once
 * the catalog data renders (a few seconds in); narrow viewports land on
 * the globe with the overlay closed. We dismiss it on desktop so the
 * Tools bar (and the playback transport / info panel) behind it is
 * reachable. We deliberately do *not* load a dataset: dataset imagery is
 * fetched from external tile/video hosts that aren't reachable in the
 * offline CI capture, so the info-panel / playback surfaces (which only
 * appear once a dataset loads) are out of scope here and would hang. The
 * chrome that renders without a dataset — the Tools bar and its popover
 * — is the target.
 */
async function openGlobe(page: Page): Promise<void> {
  await gotoApp(page, '/')
  const overlay = page.locator('#browse-overlay')
  const close = page.locator('#browse-close')
  // Only the desktop landing auto-opens the overlay (mirrors the app's
  // 769px breakpoint used by the Graph/Timeline scenes' `minWidth`). On
  // desktop, wait for it to open, then click close until it reports
  // hidden — its close handler can wire a beat after the button paints,
  // so a single early click sometimes misses, leaving the overlay
  // intercepting clicks on the Tools bar behind it (`.hidden` =>
  // display:none).
  const viewportWidth = page.viewportSize()?.width ?? 0
  if (viewportWidth >= 769) {
    await overlay.waitFor({ state: 'visible', timeout: 15000 })
    for (let i = 0; i < 8; i++) {
      await close.click().catch(() => {})
      try {
        await overlay.waitFor({ state: 'hidden', timeout: 750 })
        break
      } catch {
        // Not hidden yet — retry.
      }
    }
  }
  await page.locator('#tools-menu-toggle').waitFor({ state: 'visible' })
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

  // ── Globe / immersive UI surfaces ─────────────────────────────
  // The chrome that overlays the WebGL globe. No dataset is loaded
  // (dataset imagery is network-gated and unreachable in offline
  // capture — see openGlobe()), so these capture the surfaces that
  // render without one.
  {
    name: 'tools-menu',
    description:
      'Globe view — Tools popover (view toggles, layout picker, Orbit settings entry)',
    // The WebGL globe renders behind the popover and is
    // non-deterministic (rotation, tiles) — mask it out of the diff.
    masks: ['#map-grid'],
    // The popover is the focus; emit a tight crop of it alongside the
    // full-viewport shot.
    crop: '#tools-menu-popover',
    // The full globe renders behind the popover. In the Weblate
    // capturer (long-lived shared browser, full-page screenshots) that
    // GPU load makes the *following* scenes' captures fail, so opt this
    // scene out there — it still runs in the report capturer.
    skipWeblate: true,
    async setup(page) {
      await openGlobe(page)
      await page.locator('#tools-menu-toggle').click()
      await page.locator('#tools-menu-popover:not(.hidden)').waitFor()
    },
  },
  {
    name: 'orbit-settings',
    description:
      'Orbit chat — settings form (LLM endpoint, model, reading level)',
    async setup(page) {
      await openCatalog(page)
      await page.locator('#browse-chat-btn').click()
      await page.locator('#chat-panel').waitFor({ state: 'visible' })
      await page.locator('#chat-settings-btn').click()
      await page.locator('#chat-settings').waitFor({ state: 'visible' })
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
  // Privileged tabs, populated with an admin identity + the analytics /
  // feedback rollup fixtures so the dashboards render their real charts,
  // tables and stat tiles (synthetic, no-PII data). See fixtures/admin.ts.
  {
    name: 'admin-analytics',
    description: 'Admin — analytics dashboard (populated charts/tables via fixtures)',
    fixtures: [...publisherFixtures({ admin: true }), ...analyticsFixtures()],
    // The spatial-attention heatmap is a non-deterministic MapLibre
    // canvas — mask it out of the diff.
    masks: ['.publisher-analytics-map'],
    async setup(page) {
      await openPublish(page, '/publish/analytics')
      await page.locator('.publisher-analytics-table').first().waitFor()
    },
  },
  {
    name: 'admin-feedback',
    description: 'Admin — feedback review, AI thumbs tab (populated via fixtures)',
    fixtures: [...publisherFixtures({ admin: true }), ...feedbackFixtures()],
    async setup(page) {
      await openPublish(page, '/publish/feedback')
      await page.locator('.publisher-analytics-table').first().waitFor()
    },
  },
  {
    name: 'admin-feedback-general',
    description: 'Admin — feedback review, general (bug/feature) tab',
    fixtures: [...publisherFixtures({ admin: true }), ...feedbackFixtures()],
    async setup(page) {
      await openPublish(page, '/publish/feedback')
      // Second tab = general; the AI tab is the default.
      await page.locator('.publisher-feedback-tab').nth(1).click()
      await page.locator('.publisher-analytics-table').first().waitFor()
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

  // ── Empty / error state variants ──────────────────────────────
  // These force the empty-list and server-error responses so the
  // capture surfaces the empty-state and shared error-card strings
  // (publisher.*.empty.*, publisher.me.error.*, publisher.error.*) that
  // the always-populated fixtures above never reach. High-value for
  // translators; cheap to maintain.
  {
    name: 'publish-datasets-empty',
    description: 'Publisher portal — datasets list, empty state',
    fixtures: publisherFixtures({ datasets: 'empty' }),
    requiresFixtures: true,
    async setup(page) {
      await openPublish(page, '/publish/datasets')
      await page.locator('.publisher-empty-message').first().waitFor()
    },
  },
  {
    name: 'publish-datasets-error',
    description: 'Publisher portal — datasets list, server-error card',
    fixtures: publisherFixtures({ datasets: 'error' }),
    requiresFixtures: true,
    async setup(page) {
      await openPublish(page, '/publish/datasets')
      await page.locator('.publisher-error').first().waitFor()
    },
  },
  {
    name: 'publish-workflows-empty',
    description: 'Publisher portal — workflows list, empty state',
    fixtures: publisherFixtures({ workflows: 'empty' }),
    requiresFixtures: true,
    async setup(page) {
      await openPublish(page, '/publish/workflows')
      await page.locator('.publisher-empty-message').first().waitFor()
    },
  },
  {
    name: 'admin-users-empty',
    description: 'Admin — Users tab, empty state',
    fixtures: publisherFixtures({ admin: true, publishers: 'empty' }),
    requiresFixtures: true,
    async setup(page) {
      await openPublish(page, '/publish/users')
      await page.locator('.publisher-empty').first().waitFor()
    },
  },
]
