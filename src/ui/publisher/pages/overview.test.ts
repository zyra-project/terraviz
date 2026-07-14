import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  renderOverviewPage,
  isPrivileged,
  daysUntil,
  satisfactionPercent,
  deriveActivity,
} from './overview'
import { fetchFeatures, resetFeaturesCache } from '../features'
import type { PublisherDataset } from '../types'

const NOW = new Date('2026-07-08T12:00:00Z')

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json' },
  })
}

function dataset(overrides: Partial<PublisherDataset> = {}): PublisherDataset {
  return {
    id: 'ds-1',
    slug: 'ds-1',
    title: 'Sea Surface Temp',
    abstract: null,
    organization: null,
    format: 'video/mp4',
    visibility: 'public',
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-08T10:00:00Z',
    published_at: '2026-07-08T10:00:00Z',
    retracted_at: null,
    publisher_id: null,
    legacy_id: null,
    ...overrides,
  } as PublisherDataset
}

/** Route a fetch by URL to a fixture; unmatched URLs 404. Admin
 *  fixture covers every read the Overview fans out to. */
function adminFetch(overrides: Record<string, unknown> = {}): typeof fetch {
  const routes: Array<[string, unknown]> = [
    ['/api/v1/publish/me', { email: 'a@b.c', display_name: 'Admin', role: 'admin', is_admin: true }],
    ['/api/v1/node-profile', { profile: { orgName: 'The Zyra Project' } }],
    [
      '/api/v1/publish/datasets?status=published',
      { datasets: Array.from({ length: 3 }, (_, i) => dataset({ id: `p${i}` })), next_cursor: null },
    ],
    [
      '/api/v1/publish/datasets?limit=8',
      { datasets: [dataset({ id: 'p0', title: 'Sea Surface Temp' })], next_cursor: null },
    ],
    [
      '/api/v1/featured-hero',
      {
        hero: {
          datasetId: 'p0',
          window: { start: '2026-07-01T00:00:00Z', end: '2026-07-10T00:00:00Z' },
          headline: 'Far-Flung Filaments of Fungi',
        },
      },
    ],
    [
      '/api/v1/publish/events?status=proposed',
      {
        events: [
          {
            id: 'e1',
            title: 'Snake River Wildfire',
            status: 'proposed',
            source: { name: 'NASA EONET', publishedAt: '2026-07-05T00:00:00Z' },
            createdAt: '2026-07-05T00:00:00Z',
            links: [{ datasetId: 'x' }, { datasetId: 'y' }],
          },
        ],
      },
    ],
    [
      '/api/v1/publish/events?status=approved',
      {
        events: [
          { id: 'a1', title: 'Approved', status: 'approved', reviewedAt: '2026-07-07T00:00:00Z' },
        ],
      },
    ],
    ['/api/v1/publish/feeds', { feeds: [{ enabled: true }, { enabled: true }, { enabled: false }] }],
    [
      '/api/v1/publish/feedback',
      {
        data: {
          byDay: [{ up: 9, down: 1 }],
          recentFeedback: [
            { rating: 'thumbs-up', comment: 'Great', dataset_id: 'p0', created_at: '2026-07-08T09:00:00Z' },
            { rating: 'thumbs-down', comment: 'Broken', created_at: '2026-07-08T06:00:00Z' },
          ],
        },
      },
    ],
    ['/api/v1/publish/analytics', { data: { totals: { sessions: 44200 } } }],
    ['/api/v1/publish/workflows', { workflows: [{ id: 'w1', name: 'Daily SST refresh', enabled: true, last_run_at: '2026-07-06T02:14:00Z' }] }],
    [
      '/api/v1/publish/workflows/w1/runs',
      { runs: [{ status: 'failed', created_at: '2026-07-06T02:14:00Z', finished_at: '2026-07-06T02:15:00Z', error_summary: 'exit code 1' }] },
    ],
  ]
  // Longest needle first so `/workflows/w1/runs` wins over `/workflows`.
  routes.sort((a, b) => b[0].length - a[0].length)
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    for (const [needle, body] of routes) {
      if (url.includes(needle)) {
        if (needle in overrides) return jsonResponse(overrides[needle])
        return jsonResponse(body)
      }
    }
    return jsonResponse({}, { status: 404 })
  }) as unknown as typeof fetch
}

describe('overview pure helpers', () => {
  it('isPrivileged accepts admin/service, rejects publisher/readonly', () => {
    expect(isPrivileged({ is_admin: true, role: 'publisher' })).toBe(true)
    expect(isPrivileged({ is_admin: false, role: 'admin' })).toBe(true)
    expect(isPrivileged({ is_admin: false, role: 'service' })).toBe(true)
    expect(isPrivileged({ is_admin: false, role: 'publisher' })).toBe(false)
    expect(isPrivileged({ is_admin: false, role: 'readonly' })).toBe(false)
  })

  it('daysUntil rounds up whole days and goes negative once past', () => {
    expect(daysUntil('2026-07-10T00:00:00Z', NOW)).toBe(2)
    expect(daysUntil('2026-07-06T00:00:00Z', NOW)).toBe(-2)
    expect(Number.isNaN(daysUntil('not-a-date', NOW))).toBe(true)
  })

  it('satisfactionPercent sums the window and returns null with no ratings', () => {
    expect(satisfactionPercent([{ up: 9, down: 1 }])).toBe(90)
    expect(satisfactionPercent([{ up: 0, down: 0 }])).toBeNull()
    expect(satisfactionPercent([])).toBeNull()
    expect(satisfactionPercent(undefined)).toBeNull()
  })

  it('deriveActivity merges sources newest-first and marks a failed workflow warn', () => {
    const entries = deriveActivity(
      {
        recentDatasets: [dataset({ id: 'p0', title: 'SST', published_at: '2026-07-08T10:00:00Z' })],
        proposedEvents: [{ id: 'e1', title: 'Fire', status: 'proposed', createdAt: '2026-07-08T08:00:00Z' }],
        failedWorkflow: { id: 'w1', name: 'Daily SST refresh', when: '2026-07-08T05:00:00Z' },
        feedback: [{ rating: 'thumbs-up', comment: 'Hi', dataset_id: 'p0', created_at: '2026-07-08T02:00:00Z' }],
      },
      NOW,
    )
    expect(entries.length).toBe(4)
    // Newest first: the 10:00 dataset publish.
    expect(entries[0].label).toContain('SST')
    const warn = entries.find(e => e.tone === 'warn')
    expect(warn?.label).toContain('Daily SST refresh')
  })
})

describe('renderOverviewPage', () => {
  let mount: HTMLDivElement

  beforeEach(() => {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    sessionStorage.clear()
  })

  it('renders the full admin dashboard', async () => {
    await renderOverviewPage(mount, { fetchFn: adminFetch(), now: () => NOW })

    expect(mount.querySelector('.publisher-overview')).not.toBeNull()
    expect(mount.textContent).toContain('Overview')
    // Org-aware subtitle.
    expect(mount.textContent).toContain('The Zyra Project')
    // Needs-you cards.
    expect(mount.textContent).toContain('1 event awaiting review')
    expect(mount.textContent).toContain('Workflow failed')
    expect(mount.textContent).toContain('Hero expires')
    // At-a-glance privileged tiles present.
    expect(mount.textContent).toContain('Globe views')
    expect(mount.textContent).toContain('AI satisfaction')
    expect(mount.textContent).toContain('90%')
    // Pipeline + feedback column.
    expect(mount.querySelector('.publisher-overview-pipeline')).not.toBeNull()
    expect(mount.querySelector('.publisher-overview-feedback')).not.toBeNull()
    expect(mount.textContent).toContain('Great')
  })

  it('hides privileged sections for a non-admin publisher', async () => {
    const fetchFn = adminFetch({
      '/api/v1/publish/me': { email: 'p@b.c', display_name: 'Pub', role: 'publisher', is_admin: false },
    })
    await renderOverviewPage(mount, { fetchFn, now: () => NOW })

    expect(mount.querySelector('.publisher-overview')).not.toBeNull()
    // Published-datasets tile always shows.
    expect(mount.textContent).toContain('Published datasets')
    // Privileged surfaces are gone.
    expect(mount.querySelector('.publisher-overview-pipeline')).toBeNull()
    expect(mount.querySelector('.publisher-overview-feedback')).toBeNull()
    expect(mount.textContent).not.toContain('AI satisfaction')
    expect(mount.textContent).not.toContain('New event')
  })

  it('hides toggled-off feature panels and skips their reads', async () => {
    resetFeaturesCache()
    try {
      // Prime the module-cached toggle map: newsroom + insights off.
      await fetchFeatures({
        fetchFn: vi.fn().mockResolvedValue(
          jsonResponse({
            profile: null,
            features: { events: false, hero: false, feedback: false, analytics: false },
          }),
        ) as unknown as typeof fetch,
      })
      const fetchFn = adminFetch() as unknown as ReturnType<typeof vi.fn>
      await renderOverviewPage(mount, { fetchFn: fetchFn as unknown as typeof fetch, now: () => NOW })

      expect(mount.querySelector('.publisher-overview')).not.toBeNull()
      // Datasets tile stays; the gated tiles, pipeline, feedback
      // column, needs-you event/hero cards, and New event action go.
      expect(mount.textContent).toContain('Published datasets')
      expect(mount.textContent).not.toContain('Globe views')
      expect(mount.textContent).not.toContain('AI satisfaction')
      expect(mount.textContent).not.toContain('event awaiting review')
      expect(mount.textContent).not.toContain('Hero expires')
      expect(mount.textContent).not.toContain('New event')
      expect(mount.querySelector('.publisher-overview-pipeline')).toBeNull()
      expect(mount.querySelector('.publisher-overview-feedback')).toBeNull()

      // The gated reads were never fetched.
      const urls = fetchFn.mock.calls.map(c => String(c[0]))
      expect(urls.some(u => u.includes('/publish/events'))).toBe(false)
      expect(urls.some(u => u.includes('/publish/feeds'))).toBe(false)
      expect(urls.some(u => u.includes('/publish/feedback'))).toBe(false)
      expect(urls.some(u => u.includes('/publish/analytics'))).toBe(false)
      expect(urls.some(u => u.includes('/featured-hero'))).toBe(false)
    } finally {
      resetFeaturesCache()
    }
  })

  it('renders a session error card when the warmup was already attempted', async () => {
    sessionStorage.setItem('publisher_warmup_attempted', '1')
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ error: 'unauthorized' }, { status: 401 }),
    ) as unknown as typeof fetch

    await renderOverviewPage(mount, { fetchFn, now: () => NOW })

    expect(mount.querySelector('.publisher-overview')).toBeNull()
    expect(mount.querySelector('.publisher-error, .publisher-error-card')).not.toBeNull()
  })

  it('shows a loading state before data resolves', () => {
    let resolve: (r: Response) => void = () => {}
    const fetchFn = vi.fn().mockReturnValue(
      new Promise<Response>(r => {
        resolve = r
      }),
    ) as unknown as typeof fetch

    void renderOverviewPage(mount, { fetchFn, now: () => NOW })
    expect(mount.querySelector('.publisher-loading')).not.toBeNull()
    resolve(jsonResponse({}, { status: 404 }))
  })
})
