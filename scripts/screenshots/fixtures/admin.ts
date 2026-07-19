/**
 * Admin analytics + feedback dashboard fixtures.
 *
 * Synthetic, no-PII responses for the `/api/v1/publish/analytics` and
 * `/api/v1/publish/feedback` endpoints so the admin dashboards render
 * their real charts/tables/stat-tiles for translators (and the visual
 * report) instead of an error/empty surface.
 *
 * The response shapes mirror the authoritative server types — analytics
 * sections from `functions/api/v1/_lib/analytics-query.ts`, feedback from
 * `functions/api/_feedback-helpers.ts` — the same way the page
 * (`src/ui/publisher/pages/{analytics,feedback}.ts`) inlines them. They
 * are kept type-correct via `satisfies` against the local mirrors below.
 *
 * No real data: dataset titles are the demo catalog's, "queries" are
 * opaque hashes, feedback messages are invented. See
 * `docs/VISUAL_REPORT_PLAN.md` (Phase V7).
 */

import type { FixtureRule } from '../core/fixtures'

// ── Mirrored analytics types (authoritative: analytics-query.ts) ──
interface OverviewData {
  days: Array<{ day: string; sessions: number; events: number; errors: number; view_ms: number }>
  platforms: Record<string, number>
  operatingSystems: Record<string, number>
  countries: Array<{ country: string; sessions: number }>
  totals: { sessions: number; events: number; errors: number; view_ms: number }
}
interface DatasetsData {
  datasets: Array<{
    layer_id: string
    title: string | null
    loads: number
    trigger_mix: Record<string, number>
    source_mix: Record<string, number>
    load_ms_p50: number | null
    load_ms_p95: number | null
    dwell_ms_sum: number
  }>
}
interface SpatialData {
  layers: Array<{ id: string; title: string | null }>
  bins: Array<{ lat: number; lon: number; hits: number }>
  hitKinds: Record<string, number>
}
interface FunnelData {
  days: Array<{ day: string; tours_started: number; tours_ended: number; vr_started: number; orbit_turns: number }>
  outcomes: { tour_ended: Record<string, number>; vr_session_started: Record<string, number> }
  toursStartedBySource: Record<string, number>
}
interface PerfData {
  rows: Array<{
    surface: string
    renderer: string
    samples: number
    avg_fps: number
    avg_frame_p95_ms: number
    avg_jsheap_mb: number | null
  }>
}
interface OrbitData {
  models: Array<{ model: string; turns: number; rounds: number; input_tokens: number; output_tokens: number }>
  days: Array<{ day: string; rounds: number; turns: number }>
  totals: { turns: number; rounds: number; input_tokens: number; output_tokens: number }
}
interface ResearchData {
  topSearches: Array<{ key: string; count: number; avg_length: number }>
  zeroSearches: Array<{ key: string; count: number }>
  dwell: Array<{ key: string; count: number; avg_ms: number }>
  gestures: Array<{ key: string; count: number; avg_magnitude: number }>
  corrections: Array<{ key: string; count: number }>
  followThrough: Array<{ key: string; count: number; avg_latency_ms: number }>
  worstQuestions: Array<{ tour_id: string; question_id: string; answered: number; correct_rate: number }>
}
interface ErrorsData {
  errors: Array<{ category: string; source: string; code: string; message_class: string; count: number }>
}

/** The `/api/v1/publish/analytics` response envelope. */
const envelope = <T>(section: string, data: T) => ({
  section,
  since_day: '2026-04-01',
  through_day: '2026-04-30',
  environment: 'production',
  data,
})

const DATASET_A = '01HEXAMPLEDATASET00000001'
const DATASET_B = '01HEXAMPLEDATASET00000003'

const overview = {
  days: [
    { day: '2026-04-01', sessions: 118, events: 4200, errors: 3, view_ms: 5_400_000 },
    { day: '2026-04-02', sessions: 142, events: 4810, errors: 1, view_ms: 6_120_000 },
    { day: '2026-04-03', sessions: 131, events: 4490, errors: 2, view_ms: 5_870_000 },
    { day: '2026-04-04', sessions: 156, events: 5230, errors: 0, view_ms: 6_640_000 },
    { day: '2026-04-05', sessions: 149, events: 5010, errors: 4, view_ms: 6_310_000 },
  ],
  platforms: { web: 540, ios: 128, android: 62, desktop: 41 },
  operatingSystems: { macos: 214, windows: 246, linux: 88, ios: 128, android: 62 },
  countries: [
    { country: 'US', sessions: 318 },
    { country: 'GB', sessions: 94 },
    { country: 'DE', sessions: 71 },
    { country: 'JP', sessions: 58 },
    { country: 'BR', sessions: 39 },
  ],
  totals: { sessions: 696, events: 23_740, errors: 10, view_ms: 30_340_000 },
} satisfies OverviewData

const datasets = {
  datasets: [
    {
      layer_id: DATASET_A,
      title: 'Global Sea Surface Temperature',
      loads: 412,
      trigger_mix: { user: 300, tour: 90, deep_link: 22 },
      source_mix: { browse: 360, orbit: 40, share: 12 },
      load_ms_p50: 840,
      load_ms_p95: 2310,
      dwell_ms_sum: 18_600_000,
    },
    {
      layer_id: DATASET_B,
      title: 'Global Precipitation (IMERG)',
      loads: 268,
      trigger_mix: { user: 210, tour: 58 },
      source_mix: { browse: 240, orbit: 28 },
      load_ms_p50: 720,
      load_ms_p95: 1980,
      dwell_ms_sum: 9_400_000,
    },
    {
      layer_id: 'INTERNAL_SOS_512',
      title: null, // unresolved id → page shows the raw id
      loads: 73,
      trigger_mix: { user: 73 },
      source_mix: { browse: 73 },
      load_ms_p50: null,
      load_ms_p95: null,
      dwell_ms_sum: 1_120_000,
    },
  ],
} satisfies DatasetsData

const spatial = {
  layers: [
    { id: '', title: null },
    { id: DATASET_A, title: 'Global Sea Surface Temperature' },
  ],
  // A handful of bins so the heatmap renders (the canvas is masked).
  bins: [
    { lat: 40, lon: -100, hits: 52 },
    { lat: 51, lon: 0, hits: 41 },
    { lat: 35, lon: 139, hits: 33 },
    { lat: -23, lon: -46, hits: 21 },
    { lat: 1, lon: 103, hits: 18 },
    { lat: 52, lon: 13, hits: 27 },
    { lat: 19, lon: 72, hits: 24 },
    { lat: -33, lon: 151, hits: 15 },
  ],
  hitKinds: { surface: 120, marker: 44, feature: 22, region: 9 },
} satisfies SpatialData

const funnel = {
  days: [
    { day: '2026-04-01', tours_started: 28, tours_ended: 22, vr_started: 6, orbit_turns: 41 },
    { day: '2026-04-02', tours_started: 34, tours_ended: 27, vr_started: 9, orbit_turns: 52 },
    { day: '2026-04-03', tours_started: 31, tours_ended: 25, vr_started: 7, orbit_turns: 48 },
    { day: '2026-04-04', tours_started: 39, tours_ended: 33, vr_started: 11, orbit_turns: 60 },
  ],
  outcomes: {
    tour_ended: { completed: 84, abandoned: 19, error: 4 },
    vr_session_started: { vr: 22, ar: 11 },
  },
  toursStartedBySource: { browse: 96, orbit: 24, auto: 11 },
} satisfies FunnelData

const perf = {
  rows: [
    { surface: 'globe', renderer: 'maplibre-gl', samples: 1240, avg_fps: 58.4, avg_frame_p95_ms: 22.1, avg_jsheap_mb: 184.2 },
    { surface: 'mercator', renderer: 'maplibre-gl', samples: 612, avg_fps: 59.6, avg_frame_p95_ms: 18.7, avg_jsheap_mb: 142.0 },
    { surface: 'vr', renderer: 'three', samples: 88, avg_fps: 71.2, avg_frame_p95_ms: 13.9, avg_jsheap_mb: null },
  ],
} satisfies PerfData

const orbit = {
  models: [
    { model: 'llama-3.1-70b', turns: 320, rounds: 486, input_tokens: 184_000, output_tokens: 71_500 },
    { model: 'llama-4-scout', turns: 142, rounds: 205, input_tokens: 78_300, output_tokens: 31_200 },
  ],
  days: [
    { day: '2026-04-01', rounds: 40, turns: 28 },
    { day: '2026-04-02', rounds: 52, turns: 35 },
    { day: '2026-04-03', rounds: 48, turns: 31 },
  ],
  totals: { turns: 462, rounds: 691, input_tokens: 262_300, output_tokens: 102_700 },
} satisfies OrbitData

const research = {
  topSearches: [
    { key: 'a1b2c3d4e5f6', count: 84, avg_length: 12.4 },
    { key: 'f6e5d4c3b2a1', count: 51, avg_length: 8.1 },
  ],
  zeroSearches: [{ key: '0f0e0d0c0b0a', count: 17 }],
  dwell: [
    { key: 'browse', count: 240, avg_ms: 18_400 },
    { key: 'info', count: 96, avg_ms: 9_200 },
  ],
  gestures: [
    { key: 'pinch_zoom', count: 132, avg_magnitude: 1.8 },
    { key: 'two_hand_rotate', count: 47, avg_magnitude: 0.9 },
  ],
  corrections: [{ key: 'retry', count: 22 }],
  followThrough: [{ key: 'load_after_recommend', count: 58, avg_latency_ms: 4200 }],
  worstQuestions: [
    { tour_id: 'climate-101', question_id: 'q3', answered: 140, correct_rate: 0.42 },
    { tour_id: 'oceans', question_id: 'q1', answered: 96, correct_rate: 0.61 },
  ],
} satisfies ResearchData

const errors = {
  errors: [
    { category: 'runtime', source: 'mapRenderer', code: 'webgl_context_lost', message_class: 'a1b2c3', count: 6 },
    { category: 'network', source: 'datasetLoader', code: 'tile_timeout', message_class: 'd4e5f6', count: 3 },
  ],
} satisfies ErrorsData

/**
 * Analytics fixtures — one rule per dashboard section (matched on the
 * `section=` query param). Compose with `publisherFixtures({ admin: true })`
 * so the `/me` gate returns an admin identity.
 */
export function analyticsFixtures(): FixtureRule[] {
  return [
    { url: 'section=overview', json: envelope('overview', overview) },
    { url: 'section=datasets', json: envelope('datasets', datasets) },
    { url: 'section=spatial', json: envelope('spatial', spatial) },
    { url: 'section=funnel', json: envelope('funnel', funnel) },
    { url: 'section=perf', json: envelope('perf', perf) },
    { url: 'section=orbit', json: envelope('orbit', orbit) },
    { url: 'section=research', json: envelope('research', research) },
    { url: 'section=errors', json: envelope('errors', errors) },
  ]
}

// ── Feedback (authoritative: _feedback-helpers.ts + page AiRow/GeneralRow) ──
interface AiRow {
  rating: string
  comment: string
  tags: string[]
  user_message: string
  assistant_message: string
  dataset_id: string | null
  modelConfig: Record<string, unknown>
  isFallback: boolean
  turn_index: number | null
  system_prompt: string
  created_at: string
}
interface AiData {
  totalCount: number
  thumbsUpCount: number
  thumbsDownCount: number
  byDay: Array<{ date: string; up: number; down: number }>
  topTags: Array<{ tag: string; count: number }>
  recentFeedback: AiRow[]
}
interface GeneralRow {
  id: number
  kind: string
  message: string
  contact: string
  url: string
  user_agent: string
  app_version: string
  platform: string
  dataset_id: string | null
  created_at: string
  hasScreenshot: boolean
  screenshotIsFile: boolean
  source: string
  rating: number | null
  reporter_name: string
  status: string
  country: string
  meta: Record<string, unknown> | null
}
interface GeneralData {
  totalCount: number
  bugCount: number
  featureCount: number
  otherCount: number
  ideaCount: number
  contentCount: number
  byDay: Array<{ date: string; bugs: number; features: number; other: number; ideas: number; content: number }>
  recentFeedback: GeneralRow[]
}

const feedbackWrapper = <T>(view: 'ai' | 'general', data: T) => ({ view, days: 30, data })

const aiData = {
  totalCount: 146,
  thumbsUpCount: 118,
  thumbsDownCount: 28,
  byDay: [
    { date: '2026-04-01', up: 22, down: 5 },
    { date: '2026-04-02', up: 26, down: 4 },
    { date: '2026-04-03', up: 24, down: 7 },
  ],
  topTags: [
    { tag: 'helpful', count: 64 },
    { tag: 'accurate', count: 41 },
    { tag: 'too-long', count: 12 },
  ],
  recentFeedback: [
    {
      rating: 'thumbs-up',
      comment: 'Clear explanation of the sea-surface temperature anomaly.',
      tags: ['helpful', 'accurate'],
      user_message: 'What am I looking at on this globe?',
      assistant_message: 'This layer shows daily sea-surface temperature anomalies…',
      dataset_id: DATASET_A,
      modelConfig: { model: 'llama-3.1-70b', readingLevel: 'general' },
      isFallback: false,
      turn_index: 1,
      system_prompt: '(demo system prompt)',
      created_at: '2026-04-03T14:22:00.000Z',
    },
    {
      rating: 'thumbs-down',
      comment: 'Answer was a bit too long.',
      tags: ['too-long'],
      user_message: 'Show me precipitation data',
      assistant_message: 'Here are several precipitation datasets…',
      dataset_id: DATASET_B,
      modelConfig: { model: 'llama-4-scout', readingLevel: 'general' },
      isFallback: true,
      turn_index: 2,
      system_prompt: '(demo system prompt)',
      created_at: '2026-04-02T09:10:00.000Z',
    },
  ],
} satisfies AiData

const generalData = {
  totalCount: 38,
  bugCount: 14,
  featureCount: 18,
  otherCount: 5,
  ideaCount: 1,
  contentCount: 0,
  byDay: [
    { date: '2026-04-01', bugs: 3, features: 4, other: 1, ideas: 0, content: 0 },
    { date: '2026-04-02', bugs: 5, features: 6, other: 2, ideas: 1, content: 0 },
  ],
  recentFeedback: [
    {
      id: 101,
      kind: 'bug',
      message: 'Globe rotation stutters when zooming on iOS.',
      contact: '',
      url: 'https://example.org/?dataset=INTERNAL_SOS_1',
      user_agent: '(redacted)',
      app_version: '0.5.0',
      platform: 'ios',
      dataset_id: DATASET_A,
      created_at: '2026-04-02T11:30:00.000Z',
      hasScreenshot: true,
      screenshotIsFile: false,
      source: '',
      rating: null,
      reporter_name: '',
      status: 'new',
      country: '',
      meta: null,
    },
    {
      id: 102,
      kind: 'feature',
      message: 'Please add a compare-two-datasets side-by-side mode.',
      contact: '',
      url: '',
      user_agent: '(redacted)',
      app_version: '0.5.0',
      platform: 'web',
      dataset_id: null,
      created_at: '2026-04-01T16:05:00.000Z',
      hasScreenshot: false,
      screenshotIsFile: false,
      source: '',
      rating: null,
      reporter_name: '',
      status: 'new',
      country: '',
      meta: null,
    },
    {
      id: 103,
      kind: 'idea',
      message: 'A lightning-strike layer would pair well with the storm tours.',
      contact: 'ada@example.com',
      url: '',
      user_agent: '(redacted)',
      app_version: '',
      platform: '',
      dataset_id: 'Sea Surface Temperature (sst-anomaly)',
      created_at: '2026-04-02T18:03:00.000Z',
      hasScreenshot: false,
      screenshotIsFile: false,
      source: 'terraviz-standalone',
      rating: 4,
      reporter_name: 'Ada',
      status: 'new',
      country: 'US',
      meta: { when: '2026-04-02T18:03:00.000Z', viewport: '1920×1080', dpr: 2, uiScale: 1.5, device: 'desktop' },
    },
  ],
} satisfies GeneralData

/**
 * Feedback fixtures — the AI + general dashboard views (matched on the
 * `view=` query param) and the on-demand screenshot endpoint. Compose
 * with `publisherFixtures({ admin: true })` for the `/me` gate.
 */
export function feedbackFixtures(): FixtureRule[] {
  return [
    { url: 'view=screenshot', json: { id: 101, screenshot: '' } },
    { url: 'view=ai', json: feedbackWrapper('ai', aiData) },
    { url: 'view=general', json: feedbackWrapper('general', generalData) },
  ]
}
