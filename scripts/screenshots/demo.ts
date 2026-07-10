/**
 * Demo capturer — scripted, deterministic walk-throughs of the publisher
 * portal for the training / pitch video (see
 * `docs/VIDEO_PRODUCTION_PLAN.md`).
 *
 * It reuses the exact route-stub fixtures the visual report uses
 * (`fixtures/publisher.ts`, `fixtures/admin.ts`), so every flow renders
 * fully populated against a plain `vite` dev server with **no backend**,
 * and is reproducible run to run. Each flow:
 *   - records one continuous `.webm` clip of the scripted interaction, and
 *   - writes a numbered still per "beat" into `demo-out/`,
 * plus a `manifest.json` mapping flows → narration cue → beat files (for
 * the editor and the runbook).
 *
 * Run (two shells):
 *   npm run dev -- --host 127.0.0.1 --port 4173
 *   SCREENSHOT_BASE_URL=http://127.0.0.1:4173 npm run screenshots:demo
 *
 * Filter to specific flows:
 *   npm run screenshots:demo -- --flow events,blog
 * Tune the per-beat hold (ms) for pacing the clip:
 *   DEMO_HOLD_MS=2200 npm run screenshots:demo
 *
 * This is dev-only tooling; it is not part of the product bundle and has
 * no bearing on CI gates. The portal-only flows below are deterministic;
 * the globe / tour / Orbit "payoff" b-roll (Act 2 of the film) is best
 * captured from a seeded live app — see the runbook.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { Page } from 'playwright'

import {
  assertSafeOutDir,
  gotoApp,
  launchBrowser,
  parseViewport,
  REPO_ROOT,
  screenshotWithRetry,
  withVideoPage,
} from './core/browser'
import { installFixtures, type FixtureRule } from './core/fixtures'
import { publisherFixtures } from './fixtures/publisher'
import { analyticsFixtures, feedbackFixtures } from './fixtures/admin'

/** A real equirectangular Earth frame (the globe-thumbnail sample),
 *  served as the Worldview snapshot so the blog Media tab shows a
 *  populated suggestion card instead of an empty state — deterministic,
 *  no live NASA fetch. */
const EARTH_FRAME = readFileSync(resolve(REPO_ROOT, 'scripts/screenshots/fixtures/equirect-sample.png'))

const BASE_URL = process.env.SCREENSHOT_BASE_URL ?? 'http://localhost:4173'
const OUT_DIR = resolve(REPO_ROOT, 'demo-out')
const VIEWPORT = parseViewport(process.env.SCREENSHOT_VIEWPORT ?? '1440x900')
/** How long each clip lingers on a beat after its still is captured, so
 *  the recorded video reads at a watchable pace (not a blur of clicks). */
const HOLD_MS = Number(process.env.DEMO_HOLD_MS ?? 1600)

// The Overview page fans out beyond publisherFixtures' coverage; these
// extra rules (workflow runs / hero / feedback / analytics totals / public
// node profile) precede the base set so the workflow-runs regex wins over
// the general `/publish/workflows` list rule. Mirrors the `publish-overview`
// scene in `scenes.ts`.
const overviewExtras: FixtureRule[] = [
  {
    url: /\/publish\/workflows\/[^/?]+\/runs/,
    json: { runs: [{ status: 'success', created_at: '2026-07-08T02:14:00Z', finished_at: '2026-07-08T02:15:00Z' }] },
  },
  {
    url: '/api/v1/featured-hero',
    json: {
      hero: {
        datasetId: 'ds-hero',
        window: { start: '2026-07-01T00:00:00Z', end: '2026-07-10T00:00:00Z' },
        headline: 'Watching the Gulf warm',
      },
    },
  },
  {
    url: '/api/v1/publish/feedback',
    json: {
      data: {
        byDay: [{ up: 22, down: 2 }],
        recentFeedback: [
          { rating: 'thumbs-up', comment: 'Orbit explained the temperature ramp perfectly.', dataset_id: 'sst-2026-04', created_at: '2026-07-08T09:00:00Z' },
          { rating: 'thumbs-down', comment: "Sea ice dataset wouldn't load on mobile.", created_at: '2026-07-08T06:00:00Z' },
        ],
      },
    },
  },
  { url: '/api/v1/publish/analytics', json: { data: { totals: { sessions: 44200 } } } },
  { url: '/api/v1/node-profile', json: { profile: { orgName: 'The Zyra Project', logoUrl: null } } },
]

/** The Events detail pane's suggested-media sources hit external hosts;
 *  stub them so the flow is deterministic and free of failed-request
 *  noise (mirrors the `publish-events` scene). */
async function stubEventMediaHosts(page: Page): Promise<void> {
  await page.route('https://wvs.earthdata.nasa.gov/**', r => r.fulfill({ status: 204, body: '' }))
  await page.route('https://commons.wikimedia.org/**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"query":{"pages":{}}}' }),
  )
  await page.route('https://earthquake.usgs.gov/**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"features":[]}' }),
  )
}

/** Blog Media-tab sources: serve a real Earth frame for the Worldview
 *  snapshot (so a card renders), and empty-but-valid bodies for the
 *  fetched sources (so they degrade quietly to their "not shown" notes).
 *  Keeps the beat populated AND deterministic. */
async function stubBlogMediaHosts(page: Page): Promise<void> {
  await page.route('https://wvs.earthdata.nasa.gov/**', r =>
    r.fulfill({ status: 200, contentType: 'image/png', body: EARTH_FRAME }),
  )
  await page.route('https://commons.wikimedia.org/**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"query":{"pages":{}}}' }),
  )
  await page.route('https://earthquake.usgs.gov/**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"features":[]}' }),
  )
}

/** Navigate to a portal route and wait for the shell to mount. */
async function openPublish(page: Page, path: string): Promise<void> {
  await gotoApp(page, path)
  await page.locator('#publisher-root .publisher-sidebar').waitFor({ state: 'visible' })
}

/** Draw a temporary accent ring around an element for a still. Tolerant:
 *  a missing selector is a no-op (the beat still captures). */
async function highlight(page: Page, selector: string): Promise<void> {
  await page
    .evaluate(sel => {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-demo-hl]'))) {
        el.removeAttribute('data-demo-hl')
        el.style.outline = ''
        el.style.outlineOffset = ''
      }
      const el = document.querySelector<HTMLElement>(sel)
      if (el) {
        el.setAttribute('data-demo-hl', '1')
        el.style.outline = '3px solid #4cc3ff'
        el.style.outlineOffset = '4px'
        el.scrollIntoView({ block: 'center' })
      }
    }, selector)
    .catch(() => {})
}

interface DemoContext {
  page: Page
  /** Capture a still for the current beat (auto-numbered per flow) and
   *  hold so the clip lingers. Optionally ring an element first. */
  beat: (label: string, opts?: { highlight?: string; hold?: number }) => Promise<void>
}

interface DemoFlow {
  name: string
  /** One-line narration cue — echoed to the console + the manifest so the
   *  script and the footage stay aligned. */
  narration: string
  fixtures: FixtureRule[]
  /** Extra page.route stubs beyond the /api fixtures (external hosts). */
  extraRoutes?: (page: Page) => Promise<void>
  run: (ctx: DemoContext) => Promise<void>
}

const flows: DemoFlow[] = [
  {
    name: 'overview',
    narration: 'Sign in and the portal opens on a command center — what needs you, at-a-glance stats, the newsroom pipeline, recent activity.',
    fixtures: [...overviewExtras, ...publisherFixtures({ admin: true })],
    async run({ page, beat }) {
      await openPublish(page, '/publish/overview')
      await page.locator('.publisher-overview').waitFor({ state: 'visible' })
      await beat('command-center')
      await beat('sidebar', { highlight: '.publisher-sidebar' })
    },
  },
  {
    name: 'node-profile',
    narration: "Your node profile is your public identity — and the voice every AI draft grounds itself in. Set the mission and tone once.",
    fixtures: publisherFixtures({ admin: true }),
    async run({ page, beat }) {
      await openPublish(page, '/publish/node-profile')
      await page.locator('#nodeprofile-org').waitFor()
      await beat('profile')
      await beat('voice', { highlight: '.publisher-nodeprofile-callout' })
    },
  },
  {
    name: 'dataset',
    narration: 'Create a dataset through a guided form — metadata, a rich description, tags, and asset uploads — then publish it to the globe.',
    fixtures: publisherFixtures(),
    async run({ page, beat }) {
      await openPublish(page, '/publish/datasets')
      await beat('catalog-list')
      await openPublish(page, '/publish/datasets/new')
      await page.locator('.publisher-form-nav-link').first().waitFor()
      await beat('form-start')
      const navs = page.locator('.publisher-form-nav-link')
      const count = await navs.count()
      for (let i = 1; i < count; i++) {
        await navs.nth(i).click()
        await beat(`form-section-${i}`)
      }
    },
  },
  {
    name: 'import',
    narration: 'Have a whole catalog? Drop in a CSV manifest and every row is validated up front — ready, warning, or error — before anything is created.',
    fixtures: publisherFixtures({ admin: true }),
    async run({ page, beat }) {
      await openPublish(page, '/publish/import')
      await beat('methods')
      const csv = [
        'title,slug,format,data_ref,license',
        'Sea Surface Temp — May 2026,sst-2026-05,mp4,https://example.org/sst.mp4,CC-BY-4.0',
        'Arctic Sea Ice Extent — 2026,sea-ice-2026,mp4,https://example.org/ice.mp4,CC0-1.0',
        'Global Nightlights 2026,nightlights-2026,png,https://example.org/nl.png,',
        'Drought Risk — Q2 2026,drought-q2-2026,,,',
        'CO2 Concentration 2026,co2-2026,png,https://example.org/co2.png,CC-BY-4.0',
      ].join('\n')
      await page.setInputFiles('.publisher-import-file-input', {
        name: 'publisher-datasets.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(csv, 'utf8'),
      })
      await page.locator('.publisher-import-row').first().waitFor()
      await beat('validated-preview')
    },
  },
  {
    name: 'events',
    narration: 'Feeds surface the headlines; the queue auto-pairs each event to matching datasets with a graded score. Approve everything above 90% in one click.',
    fixtures: publisherFixtures({ admin: true }),
    extraRoutes: stubEventMediaHosts,
    async run({ page, beat }) {
      await openPublish(page, '/publish/events')
      await page.locator('.publisher-events-detail-title').first().waitFor()
      await beat('triage-queue')
      await beat('match-detail', { highlight: '.publisher-events-detail-title' })
    },
  },
  {
    name: 'blog',
    narration: "Cite your datasets and an event, pull in suggested imagery, and generate a full post plus a playable companion tour — in your node's voice.",
    fixtures: publisherFixtures({ admin: true }),
    extraRoutes: stubBlogMediaHosts,
    async run({ page, beat }) {
      await openPublish(page, '/publish/blog/new')
      await page.locator('#blog-title').waitFor()
      await beat('content')

      // Sources — cite an event so the Media tab has something to
      // suggest from (the event's place + date drive the imagery).
      await page.locator('.publisher-form-nav-link[data-section="blog-sources"]').click()
      const evSelect = page.locator('.publisher-blog-event-select')
      await page.locator('.publisher-blog-event-select:not([disabled])').waitFor().catch(() => {})
      await evSelect.selectOption({ index: 1 }).catch(() => {})
      await beat('sources', { highlight: '.publisher-blog-event-select' })

      // Media — now seeded off the cited event (Worldview snapshot card).
      await page.locator('.publisher-form-nav-link[data-section="blog-media"]').click()
      await page
        .locator('.publisher-blog-media-card, .publisher-blog-media-notes')
        .first()
        .waitFor()
        .catch(() => {})
      await beat('media')

      // AI draft — tone / length / companion tour → one Generate.
      await page.locator('.publisher-form-nav-link[data-section="blog-aidraft"]').click()
      await beat('ai-draft')
    },
  },
  {
    name: 'workflows',
    narration: 'Automate dataset refresh with Zyra workflows — author a pipeline, schedule it, and run it on demand with live run history.',
    fixtures: publisherFixtures(),
    async run({ page, beat }) {
      await openPublish(page, '/publish/workflows')
      await page.locator('.publisher-workflows-new').first().waitFor().catch(() => {})
      await beat('list')
      await openPublish(page, '/publish/workflows/new')
      await page.locator('textarea').first().waitFor().catch(() => {})
      await beat('editor')
    },
  },
  {
    name: 'feedback',
    narration: 'Read the room — thumbs on Orbit answers and bug/feature reports, with per-day trends and exportable detail.',
    fixtures: [...publisherFixtures({ admin: true }), ...feedbackFixtures()],
    async run({ page, beat }) {
      await openPublish(page, '/publish/feedback')
      await page.locator('.publisher-analytics-table').first().waitFor()
      await beat('ai-thumbs')
      await page.locator('.publisher-feedback-tab').nth(1).click().catch(() => {})
      await page.locator('.publisher-analytics-table').first().waitFor()
      await beat('general')
    },
  },
  {
    name: 'analytics',
    narration: 'Measure the impact — sessions, dataset loads, load times, tour completion, and a spatial-attention heatmap of exactly where people looked.',
    fixtures: [...publisherFixtures({ admin: true }), ...analyticsFixtures()],
    async run({ page, beat }) {
      await openPublish(page, '/publish/analytics')
      await page.locator('.publisher-analytics-table').first().waitFor()
      await beat('overview')
      await beat('heatmap', { highlight: '.publisher-analytics-map' })
    },
  },
]

/** `--flow a,b` (or `DEMO_FLOW=a,b`) narrows the run. Empty = all. */
function parseFlowFilter(): Set<string> | null {
  const idx = process.argv.indexOf('--flow')
  const raw = idx >= 0 ? process.argv[idx + 1] : process.env.DEMO_FLOW
  if (!raw) return null
  const set = new Set(raw.split(',').map(s => s.trim()).filter(Boolean))
  return set.size > 0 ? set : null
}

async function main(): Promise<void> {
  const filter = parseFlowFilter()
  const selected = filter ? flows.filter(f => filter.has(f.name)) : flows
  if (selected.length === 0) {
    console.error(`No flows matched. Known flows: ${flows.map(f => f.name).join(', ')}`)
    process.exit(1)
  }

  assertSafeOutDir(OUT_DIR)
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })

  const manifest: Array<{ name: string; narration: string; clip: string; beats: string[] }> = []
  const browser = await launchBrowser()
  try {
    for (const flow of selected) {
      console.log(`▶ ${flow.name} — ${flow.narration}`)
      const beats: string[] = []
      await withVideoPage(
        browser,
        { viewport: VIEWPORT, baseURL: BASE_URL, videoPath: resolve(OUT_DIR, `${flow.name}.webm`) },
        async page => {
          await installFixtures(page, flow.fixtures)
          if (flow.extraRoutes) await flow.extraRoutes(page)
          let n = 0
          const beat = async (label: string, opts: { highlight?: string; hold?: number } = {}): Promise<void> => {
            n++
            if (opts.highlight) await highlight(page, opts.highlight)
            const slug = label.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()
            const file = `${flow.name}-${String(n).padStart(2, '0')}-${slug}.png`
            await screenshotWithRetry(page, resolve(OUT_DIR, file))
            beats.push(file)
            await page.waitForTimeout(opts.hold ?? HOLD_MS)
          }
          await flow.run({ page, beat })
        },
      )
      manifest.push({ name: flow.name, narration: flow.narration, clip: `${flow.name}.webm`, beats })
      console.log(`  ✓ ${flow.name}.webm  (+${beats.length} stills)`)
    }
  } finally {
    await browser.close()
  }

  writeFileSync(resolve(OUT_DIR, 'manifest.json'), JSON.stringify({ viewport: VIEWPORT, flows: manifest }, null, 2))
  console.log(`\nWrote ${manifest.length} flow(s) to demo-out/ (see manifest.json).`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
