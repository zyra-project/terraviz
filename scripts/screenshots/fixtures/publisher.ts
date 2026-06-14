/**
 * Publisher / admin portal API fixtures.
 *
 * Minimal, typed responses for the `/api/v1/publish/**` endpoints the
 * portal boots and renders from. Typed against the SPA's own wire types
 * (`src/ui/publisher/types.ts`, `workflows-api.ts`) so a server-side
 * shape change that drifts from these is caught at `type-check`.
 *
 * Consumed by scenes via `Scene.fixtures` and installed by the
 * capturer/report before the scene navigates. See
 * `docs/VISUAL_REPORT_PLAN.md` (Phase V7).
 */

import type { FixtureRule } from '../core/fixtures'
// Type-only imports — erased at runtime, so this pulls no SPA runtime
// code (i18n, logger) into the node capture scripts.
import type { PublisherWorkflow } from '../../../src/ui/publisher/workflows-api'
import type {
  DatasetDetailResponse,
  ListDatasetsResponse,
  ListPublishersResponse,
  PublisherDataset,
  PublisherDatasetDetail,
  PublisherSummary,
} from '../../../src/ui/publisher/types'

/** The `/api/v1/publish/me` identity shape (mirrors the page-local
 *  PublisherMeResponse; superset also satisfies the boot's
 *  `{ role, is_admin }`). */
interface MeResponse {
  id: string
  email: string
  display_name: string
  affiliation: string | null
  role: string
  is_admin: boolean
  status: string
  created_at: string
}

const me = (admin: boolean): MeResponse => ({
  id: 'PUB_DEMO',
  email: 'demo@example.org',
  display_name: 'Demo Publisher',
  affiliation: 'Example Organization',
  role: admin ? 'admin' : 'publisher',
  is_admin: admin,
  status: 'active',
  created_at: '2026-01-02T09:00:00.000Z',
})

const dataset = (over: Partial<PublisherDataset> = {}): PublisherDataset => ({
  id: '01HEXAMPLEDATASET00000001',
  slug: 'global-sea-surface-temperature',
  title: 'Global Sea Surface Temperature',
  abstract: 'Daily blended SST anomalies from satellite and in-situ sources.',
  organization: 'NOAA',
  format: 'video/mp4',
  visibility: 'public',
  created_at: '2026-02-01T12:00:00.000Z',
  updated_at: '2026-03-15T08:30:00.000Z',
  published_at: '2026-03-16T10:00:00.000Z',
  retracted_at: null,
  publisher_id: 'PUB_DEMO',
  legacy_id: null,
  ...over,
})

const datasets: ListDatasetsResponse = {
  datasets: [
    dataset(),
    dataset({
      id: '01HEXAMPLEDATASET00000002',
      slug: 'arctic-sea-ice-extent',
      title: 'Arctic Sea Ice Extent',
      abstract: 'Monthly sea-ice concentration and extent.',
      published_at: null, // draft
      updated_at: '2026-04-02T14:10:00.000Z',
    }),
    dataset({
      id: '01HEXAMPLEDATASET00000003',
      slug: 'global-precipitation',
      title: 'Global Precipitation (IMERG)',
      organization: 'NASA',
      abstract: 'Half-hourly precipitation estimates.',
      updated_at: '2026-04-20T06:45:00.000Z',
    }),
  ],
  next_cursor: null,
}

const datasetDetail: DatasetDetailResponse = {
  dataset: {
    ...dataset(),
    data_ref: 'r2://datasets/01HEXAMPLEDATASET00000001/master.m3u8',
    thumbnail_ref: null,
    legend_ref: null,
    caption_ref: null,
    website_link: 'https://www.ncei.noaa.gov/',
    start_time: '2026-01-01T00:00:00.000Z',
    end_time: '2026-03-31T00:00:00.000Z',
    period: 'P1D',
    run_tour_on_load: null,
    license_spdx: 'CC-BY-4.0',
    license_url: 'https://creativecommons.org/licenses/by/4.0/',
    license_statement: null,
    attribution_text: 'NOAA Coral Reef Watch',
    rights_holder: 'NOAA',
    doi: null,
    citation_text: null,
  } satisfies PublisherDatasetDetail,
  keywords: ['ocean', 'temperature', 'climate'],
  tags: ['featured'],
}

const workflow = (over: Partial<PublisherWorkflow> = {}): PublisherWorkflow => ({
  id: '01HEXAMPLEWORKFLOW0000001',
  publisher_id: 'PUB_DEMO',
  name: 'Daily SST refresh',
  description: 'Fetch, transcode and republish the SST mosaic each day.',
  pipeline_json: '{"stages":[]}',
  metadata_template: '{}',
  schedule: '0 6 * * *',
  enabled: true,
  target_dataset_id: '01HEXAMPLEDATASET00000001',
  update_mode: 'replace',
  last_run_at: '2026-04-20T06:05:00.000Z',
  next_run_at: '2026-04-21T06:00:00.000Z',
  created_at: '2026-02-01T12:00:00.000Z',
  updated_at: '2026-04-20T06:05:00.000Z',
  ...over,
})

const workflows: { workflows: PublisherWorkflow[] } = {
  workflows: [
    workflow(),
    workflow({
      id: '01HEXAMPLEWORKFLOW0000002',
      name: 'Weekly ice-extent rollup',
      schedule: '0 7 * * 1',
      enabled: false,
      next_run_at: null,
    }),
  ],
}

const publisher = (over: Partial<PublisherSummary> = {}): PublisherSummary => ({
  id: 'PUB_DEMO',
  email: 'demo@example.org',
  display_name: 'Demo Publisher',
  affiliation: 'Example Organization',
  role: 'publisher',
  is_admin: 0,
  status: 'active',
  created_at: '2026-01-02T09:00:00.000Z',
  ...over,
})

const publishers: ListPublishersResponse = {
  publishers: [
    publisher({ id: 'PUB_ADMIN', display_name: 'Site Admin', role: 'admin', is_admin: 1 }),
    publisher(),
    publisher({
      id: 'PUB_PENDING',
      email: 'newbie@example.org',
      display_name: 'Pending Applicant',
      status: 'pending',
    }),
  ],
  next_cursor: null,
}

/**
 * Fixtures for the publisher portal. `admin: true` returns an admin
 * identity so the privileged tabs (Users / Analytics / Feedback) render.
 * Rules are ordered specific → general (detail before list).
 */
export function publisherFixtures(opts: { admin?: boolean } = {}): FixtureRule[] {
  return [
    { url: '/api/v1/publish/me', json: me(opts.admin ?? false) },
    // Detail before list (both share the `/datasets` prefix).
    { url: /\/publish\/datasets\/[^/?]+(\?|$)/, json: datasetDetail },
    { url: '/api/v1/publish/datasets', json: datasets },
    { url: '/api/v1/publish/workflows', json: workflows },
    { url: '/api/v1/publish/publishers', json: publishers },
  ]
}
