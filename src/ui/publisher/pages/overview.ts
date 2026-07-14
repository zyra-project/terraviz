/**
 * /publish and /publish/overview — the portal's command-center
 * landing page.
 *
 * There is no server "overview" endpoint; this page fans out to the
 * per-feature reads and aggregates client-side (mirroring the
 * `Promise.all` composition in `pages/featured-hero.ts`). Every
 * secondary fetch is best-effort — a failed or forbidden read
 * degrades that one panel to empty rather than failing the page.
 * Only the primary `/publish/me` read routes through the shared
 * auth handling (session-error recovery); it also decides which
 * privileged panels (workflows / events / feeds / feedback /
 * analytics) render at all, via the same `is_admin || role ∈
 * {admin, service}` predicate the other privileged pages use.
 *
 * Layout follows the UI/UX review deck: a greeting header with
 * quick actions, a "Needs you" row of attention cards, an
 * "At a glance · last 7 days" stat row, the newsroom pipeline
 * flow, and a two-column Recent activity / Latest feedback footer.
 */

import { t, plural } from '../../../i18n'
import { formatNumber, formatRelative } from '../../../i18n/format'
import type { FeatureMap } from '../../../types/node-features'
import { clearWarmupFlag, handleSessionError, publisherGet } from '../api'
import { buildErrorCard, type ErrorCardDetails } from '../components/error-card'
import { fetchFeatures } from '../features'
import { renderStatTile } from '../analytics-charts'
import type { PublisherDataset, ListDatasetsResponse } from '../types'
import { lifecycleOf } from '../types'

export interface OverviewPageOptions {
  fetchFn?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  navigate?: (url: string) => void
  /** SPA router navigate for in-portal links. Falls back to a full
   *  navigation when absent (tests stub it). */
  routerNavigate?: (path: string) => void
  /** Injectable clock so the "expires in N days" / relative-time
   *  copy is deterministic under test. */
  now?: () => Date
}

// --- Wire shapes (narrow, only the fields this page reads) ---------

interface MeResponse {
  email: string
  display_name: string
  role: string
  is_admin: boolean
}

interface NodeProfileResponse {
  profile: { orgName?: string | null; logoUrl?: string | null } | null
}

interface HeroResponse {
  hero: {
    datasetId: string
    window: { start: string; end: string }
    headline?: string
  } | null
}

interface WorkflowRow {
  id: string
  name: string
  enabled: boolean
  last_run_at: string | null
}

interface WorkflowsResponse {
  workflows: WorkflowRow[]
}

interface WorkflowRun {
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  created_at: string
  finished_at: string | null
  error_summary: string | null
}

interface WorkflowRunsResponse {
  runs: WorkflowRun[]
}

interface EventLink {
  datasetId?: string
}

interface ReviewEventRow {
  id: string
  title: string
  status: string
  source?: { name?: string; publishedAt?: string }
  createdAt?: string
  reviewedAt?: string
  links?: EventLink[]
}

interface EventsResponse {
  events: ReviewEventRow[]
}

interface FeedRow {
  enabled: boolean
}

interface FeedsResponse {
  feeds: FeedRow[]
}

interface FeedbackItem {
  rating?: string
  comment?: string
  dataset_id?: string | null
  created_at?: string
}

interface FeedbackResponse {
  data?: {
    byDay?: Array<{ up: number; down: number }>
    recentFeedback?: FeedbackItem[]
  }
}

/** Aggregated, already-privilege-filtered data the render step draws. */
interface OverviewData {
  orgName: string | null
  publishedCount: number | null
  recentDatasets: PublisherDataset[]
  hero: HeroResponse['hero']
  heroTitle: string | null
  proposedEvents: ReviewEventRow[]
  approvedEvents: ReviewEventRow[]
  failedWorkflow: { id: string; name: string; when: string | null } | null
  activeFeeds: number | null
  feedback: FeedbackItem[]
  satisfactionPct: number | null
  globeViews: number | null
}

const MS_PER_DAY = 86_400_000

// --- Small DOM helpers --------------------------------------------

function el(
  tag: string,
  className?: string,
  text?: string,
): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

/** A "→" action link that navigates via the SPA router on a plain
 *  left-click but keeps a real href for open-in-new-tab. */
function actionLink(
  label: string,
  path: string,
  routerNavigate?: (p: string) => void,
): HTMLElement {
  const a = document.createElement('a')
  a.href = path
  a.className = 'publisher-overview-action-link'
  a.append(el('span', undefined, label), el('span', 'publisher-overview-arrow', '→'))
  a.addEventListener('click', e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    if (!routerNavigate) return
    e.preventDefault()
    routerNavigate(path)
  })
  return a
}

// --- Pure helpers (exported for tests) ----------------------------

export function isPrivileged(me: Pick<MeResponse, 'is_admin' | 'role'>): boolean {
  return me.is_admin === true || me.role === 'admin' || me.role === 'service'
}

/** Whole days from `now` until `iso` (negative once past). */
export function daysUntil(iso: string, now: Date): number {
  const target = Date.parse(iso)
  if (Number.isNaN(target)) return NaN
  return Math.ceil((target - now.getTime()) / MS_PER_DAY)
}

/** 7-day thumbs-up satisfaction as a 0–100 integer, or null when
 *  there were no ratings in the window (avoids a misleading 0%). */
export function satisfactionPercent(
  byDay: ReadonlyArray<{ up: number; down: number }> | undefined,
): number | null {
  if (!byDay || byDay.length === 0) return null
  let up = 0
  let down = 0
  for (const d of byDay) {
    up += d.up || 0
    down += d.down || 0
  }
  const total = up + down
  if (total === 0) return null
  return Math.round((up / total) * 100)
}

/** True when `iso` falls on/after the UTC-day boundary `since`. */
function isOnOrAfter(iso: string | undefined, since: number): boolean {
  if (!iso) return false
  const t = Date.parse(iso)
  return !Number.isNaN(t) && t >= since
}

export interface ActivityEntry {
  key: string
  label: string
  ts: number
  tone: 'default' | 'warn'
}

/**
 * Derive a best-effort activity feed from the real reads (there is
 * no activity endpoint). Merges recent dataset publishes/updates,
 * newly-proposed events, a failed workflow, and recent feedback,
 * newest-first.
 */
export function deriveActivity(
  data: Pick<
    OverviewData,
    'recentDatasets' | 'proposedEvents' | 'failedWorkflow' | 'feedback'
  >,
  now: Date,
): ActivityEntry[] {
  const out: ActivityEntry[] = []

  for (const d of data.recentDatasets.slice(0, 6)) {
    const published = lifecycleOf(d) === 'published'
    const iso = (published && d.published_at) || d.updated_at
    const ts = Date.parse(iso ?? '')
    if (Number.isNaN(ts)) continue
    out.push({
      key: `ds:${d.id}`,
      ts,
      tone: 'default',
      label: t(
        published ? 'publisher.overview.activity.published' : 'publisher.overview.activity.updated',
        { title: d.title },
      ),
    })
  }

  const dayAgo = now.getTime() - MS_PER_DAY
  const freshProposed = data.proposedEvents.filter(e => isOnOrAfter(e.createdAt, dayAgo))
  if (freshProposed.length > 0) {
    const newest = freshProposed.reduce(
      (max, e) => Math.max(max, Date.parse(e.createdAt ?? '') || 0),
      0,
    )
    out.push({
      key: 'events:new',
      ts: newest,
      tone: 'default',
      label: plural(
        freshProposed.length,
        {
          one: 'publisher.overview.activity.eventsProposed.one',
          other: 'publisher.overview.activity.eventsProposed.other',
        },
        { count: freshProposed.length },
      ),
    })
  }

  if (data.failedWorkflow) {
    const ts = data.failedWorkflow.when ? Date.parse(data.failedWorkflow.when) : now.getTime()
    out.push({
      key: `wf:${data.failedWorkflow.id}`,
      ts: Number.isNaN(ts) ? now.getTime() : ts,
      tone: 'warn',
      label: t('publisher.overview.activity.workflowFailed', { name: data.failedWorkflow.name }),
    })
  }

  const fb = data.feedback[0]
  if (fb) {
    const ts = Date.parse(fb.created_at ?? '')
    out.push({
      key: 'fb:latest',
      ts: Number.isNaN(ts) ? now.getTime() : ts,
      tone: 'default',
      label: fb.dataset_id
        ? t('publisher.overview.activity.feedbackDataset', { dataset: fb.dataset_id })
        : t('publisher.overview.activity.feedback'),
    })
  }

  return out.sort((a, b) => b.ts - a.ts).slice(0, 6)
}

// --- Data loading -------------------------------------------------

/** GET `path`, returning parsed data or null on any non-ok result.
 *  Used for every secondary (best-effort) read. */
async function getOrNull<T>(path: string, fetchFn: typeof fetch): Promise<T | null> {
  const res = await publisherGet<T>(path, { fetchFn })
  return res.ok ? res.data : null
}

/** Newest run of a workflow is a failure → surface it. Bounded to
 *  the first handful of enabled workflows to cap the fan-out. */
async function findFailedWorkflow(
  workflows: WorkflowRow[],
  fetchFn: typeof fetch,
): Promise<OverviewData['failedWorkflow']> {
  const candidates = workflows.filter(w => w.enabled).slice(0, 12)
  const results = await Promise.all(
    candidates.map(async w => {
      const runs = await getOrNull<WorkflowRunsResponse>(
        `/api/v1/publish/workflows/${encodeURIComponent(w.id)}/runs?limit=1`,
        fetchFn,
      )
      const newest = runs?.runs?.[0]
      if (newest && newest.status === 'failed') {
        return { id: w.id, name: w.name, when: newest.finished_at ?? newest.created_at }
      }
      return null
    }),
  )
  const failed = results.filter((r): r is NonNullable<typeof r> => r !== null)
  failed.sort((a, b) => (Date.parse(b.when ?? '') || 0) - (Date.parse(a.when ?? '') || 0))
  return failed[0] ?? null
}

async function loadOverview(
  fetchFn: typeof fetch,
  privileged: boolean,
  now: Date,
  features: FeatureMap,
): Promise<OverviewData> {
  const weekAgo = now.getTime() - 7 * MS_PER_DAY

  // Reads available to any authenticated publisher. Reads whose
  // feature is toggled off are skipped outright — their endpoints
  // would only answer 403/empty, and the panels degrade the same way
  // as a failed best-effort read.
  const none = Promise.resolve(null)
  const [profile, published, recent, hero] = await Promise.all([
    getOrNull<NodeProfileResponse>('/api/v1/node-profile', fetchFn),
    features.datasets
      ? getOrNull<ListDatasetsResponse>('/api/v1/publish/datasets?status=published&limit=500', fetchFn)
      : none,
    features.datasets ? getOrNull<ListDatasetsResponse>('/api/v1/publish/datasets?limit=8', fetchFn) : none,
    features.hero ? getOrNull<HeroResponse>('/api/v1/featured-hero', fetchFn) : none,
  ])

  const recentDatasets = recent?.datasets ?? []
  const heroTitle = hero?.hero
    ? published?.datasets.find(d => d.id === hero.hero?.datasetId)?.title ??
      recentDatasets.find(d => d.id === hero.hero?.datasetId)?.title ??
      null
    : null

  const data: OverviewData = {
    orgName: profile?.profile?.orgName ?? null,
    publishedCount: published ? published.datasets.length : null,
    recentDatasets,
    hero: hero?.hero ?? null,
    heroTitle,
    proposedEvents: [],
    approvedEvents: [],
    failedWorkflow: null,
    activeFeeds: null,
    feedback: [],
    satisfactionPct: null,
    globeViews: null,
  }

  if (!privileged) return data

  // Privileged reads — best-effort, in parallel; feature-gated reads
  // are skipped the same way as the base set.
  const [proposed, approved, feeds, feedback, analytics, workflows] = await Promise.all([
    features.events ? getOrNull<EventsResponse>('/api/v1/publish/events?status=proposed', fetchFn) : none,
    features.events ? getOrNull<EventsResponse>('/api/v1/publish/events?status=approved', fetchFn) : none,
    features.events ? getOrNull<FeedsResponse>('/api/v1/publish/feeds', fetchFn) : none,
    features.feedback
      ? getOrNull<FeedbackResponse>('/api/v1/publish/feedback?view=ai&days=7&recent=5', fetchFn)
      : none,
    features.analytics
      ? getOrNull<{ data?: { totals?: { sessions?: number } } }>(
          '/api/v1/publish/analytics?section=overview&days=7',
          fetchFn,
        )
      : none,
    features.workflows ? getOrNull<WorkflowsResponse>('/api/v1/publish/workflows', fetchFn) : none,
  ])

  data.proposedEvents = proposed?.events ?? []
  data.approvedEvents = (approved?.events ?? []).filter(e =>
    isOnOrAfter(e.reviewedAt ?? e.createdAt, weekAgo),
  )
  data.activeFeeds = feeds ? feeds.feeds.filter(f => f.enabled).length : null
  data.feedback = feedback?.data?.recentFeedback ?? []
  data.satisfactionPct = satisfactionPercent(feedback?.data?.byDay)
  data.globeViews = analytics?.data?.totals?.sessions ?? null
  data.failedWorkflow = workflows ? await findFailedWorkflow(workflows.workflows, fetchFn) : null

  return data
}

// --- Rendering ----------------------------------------------------

function renderLoading(mount: HTMLElement): void {
  const shell = el('main', 'publisher-shell')
  shell.setAttribute('aria-busy', 'true')
  const status = el('p', 'publisher-loading', t('publisher.overview.loading'))
  status.setAttribute('role', 'status')
  shell.appendChild(status)
  mount.replaceChildren(shell)
}

function renderError(
  mount: HTMLElement,
  kind: 'session' | 'server' | 'network' | 'not_found',
  details: ErrorCardDetails = {},
): void {
  const shell = el('main', 'publisher-shell')
  shell.appendChild(buildErrorCard(kind, details))
  mount.replaceChildren(shell)
}

function sectionLabel(text: string): HTMLElement {
  return el('h2', 'publisher-overview-section-label', text)
}

function primaryAction(
  label: string,
  path: string,
  routerNavigate?: (p: string) => void,
): HTMLElement {
  const a = document.createElement('a')
  a.href = path
  a.className = 'publisher-button publisher-button-primary'
  a.append(el('span', 'publisher-overview-plus', '+'), el('span', undefined, label))
  a.addEventListener('click', e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    if (!routerNavigate) return
    e.preventDefault()
    routerNavigate(path)
  })
  return a
}

function renderHeader(
  data: OverviewData,
  privileged: boolean,
  features: FeatureMap,
  routerNavigate?: (p: string) => void,
): HTMLElement {
  const header = el('header', 'publisher-overview-header')

  const titles = el('div', 'publisher-overview-titles')
  titles.appendChild(el('h1', 'publisher-overview-title', t('publisher.overview.title')))
  titles.appendChild(
    el(
      'p',
      'publisher-overview-subtitle',
      data.orgName
        ? t('publisher.overview.subtitle', { org: data.orgName })
        : t('publisher.overview.subtitleNoOrg'),
    ),
  )
  header.appendChild(titles)

  const actions = el('div', 'publisher-overview-header-actions')
  if (features.datasets) {
    actions.appendChild(
      primaryAction(t('publisher.overview.action.newDataset'), '/publish/datasets/new', routerNavigate),
    )
  }
  if (privileged && features.events) {
    actions.appendChild(
      primaryAction(t('publisher.overview.action.newEvent'), '/publish/events', routerNavigate),
    )
  }
  header.appendChild(actions)
  return header
}

function needCard(
  opts: {
    accent: string
    figure: string
    title: string
    detail: string
    actionLabel: string
    path: string
  },
  routerNavigate?: (p: string) => void,
): HTMLElement {
  const card = el('div', `publisher-overview-need-card publisher-overview-need-${opts.accent}`)
  card.appendChild(el('div', 'publisher-overview-need-figure', opts.figure))
  const body = el('div', 'publisher-overview-need-body')
  body.appendChild(el('div', 'publisher-overview-need-title', opts.title))
  body.appendChild(el('div', 'publisher-overview-need-detail', opts.detail))
  body.appendChild(actionLink(opts.actionLabel, opts.path, routerNavigate))
  card.appendChild(body)
  return card
}

function renderNeedsYou(
  data: OverviewData,
  now: Date,
  routerNavigate?: (p: string) => void,
): HTMLElement | null {
  const cards: HTMLElement[] = []

  if (data.proposedEvents.length > 0) {
    const oldest = data.proposedEvents
      .map(e => Date.parse(e.createdAt ?? e.source?.publishedAt ?? ''))
      .filter(n => !Number.isNaN(n))
      .sort((a, b) => a - b)[0]
    const source = data.proposedEvents.find(e => e.source?.name)?.source?.name
    const age = oldest ? formatRelative(new Date(oldest), now) : ''
    cards.push(
      needCard(
        {
          accent: 'events',
          figure: String(data.proposedEvents.length),
          title: plural(
            data.proposedEvents.length,
            {
              one: 'publisher.overview.needs.events.title.one',
              other: 'publisher.overview.needs.events.title.other',
            },
            { count: data.proposedEvents.length },
          ),
          detail:
            source && age
              ? t('publisher.overview.needs.events.detail', { source, age })
              : age
                ? t('publisher.overview.needs.events.detailNoSource', { age })
                : '',
          actionLabel: t('publisher.overview.needs.events.action'),
          path: '/publish/events',
        },
        routerNavigate,
      ),
    )
  }

  if (data.failedWorkflow) {
    const when = data.failedWorkflow.when
      ? formatRelative(new Date(data.failedWorkflow.when), now)
      : ''
    cards.push(
      needCard(
        {
          accent: 'workflow',
          figure: '!',
          title: t('publisher.overview.needs.workflow.title'),
          detail: t('publisher.overview.needs.workflow.detail', {
            name: data.failedWorkflow.name,
            when,
          }),
          actionLabel: t('publisher.overview.needs.workflow.action'),
          path: `/publish/workflows/${data.failedWorkflow.id}`,
        },
        routerNavigate,
      ),
    )
  }

  if (data.hero) {
    const days = daysUntil(data.hero.window.end, now)
    // Only nag when the pin is live and within a week of expiry.
    if (!Number.isNaN(days) && days >= 0 && days <= 7) {
      const when = formatRelative(new Date(data.hero.window.end), now)
      cards.push(
        needCard(
          {
            accent: 'hero',
            figure: '★',
            title: t('publisher.overview.needs.hero.title', { when }),
            detail: data.hero.headline || data.heroTitle || '',
            actionLabel: t('publisher.overview.needs.hero.action'),
            path: '/publish/featured-hero',
          },
          routerNavigate,
        ),
      )
    }
  }

  const section = el('section', 'publisher-overview-section')
  section.appendChild(sectionLabel(t('publisher.overview.needs.label')))
  if (cards.length === 0) {
    section.appendChild(
      el('p', 'publisher-overview-allclear', t('publisher.overview.needs.allClear')),
    )
    return section
  }
  const grid = el('div', 'publisher-overview-needs')
  for (const c of cards) grid.appendChild(c)
  section.appendChild(grid)
  return section
}

function renderGlance(data: OverviewData, privileged: boolean, features: FeatureMap): HTMLElement {
  const section = el('section', 'publisher-overview-section')
  section.appendChild(sectionLabel(t('publisher.overview.glance.label')))
  const grid = el('div', 'publisher-overview-stats')

  const num = (n: number): string => formatNumber(n, { notation: 'compact', maximumFractionDigits: 1 })

  grid.appendChild(
    renderStatTile(
      t('publisher.overview.glance.publishedDatasets'),
      data.publishedCount == null ? '—' : num(data.publishedCount),
    ),
  )
  if (privileged) {
    if (features.analytics) {
      grid.appendChild(
        renderStatTile(
          t('publisher.overview.glance.globeViews'),
          data.globeViews == null ? '—' : num(data.globeViews),
        ),
      )
    }
    if (features.events) {
      grid.appendChild(
        renderStatTile(
          t('publisher.overview.glance.eventsSurfaced'),
          num(data.approvedEvents.length),
        ),
      )
    }
    if (features.feedback) {
      grid.appendChild(
        renderStatTile(
          t('publisher.overview.glance.aiSatisfaction'),
          data.satisfactionPct == null ? '—' : `${data.satisfactionPct}%`,
        ),
      )
    }
  }
  section.appendChild(grid)
  return section
}

function pipelineStage(
  opts: { kicker: string; title: string; stat: string; sub: string; path: string },
  routerNavigate?: (p: string) => void,
): HTMLElement {
  const a = document.createElement('a')
  a.href = opts.path
  a.className = 'publisher-overview-stage'
  a.append(
    el('div', 'publisher-overview-stage-kicker', opts.kicker),
    el('div', 'publisher-overview-stage-title', opts.title),
    el('div', 'publisher-overview-stage-stat', opts.stat),
    el('div', 'publisher-overview-stage-sub', opts.sub),
  )
  a.addEventListener('click', e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    if (!routerNavigate) return
    e.preventDefault()
    routerNavigate(opts.path)
  })
  return a
}

function renderPipeline(
  data: OverviewData,
  now: Date,
  features: FeatureMap,
  routerNavigate?: (p: string) => void,
): HTMLElement {
  // "New items today" is derived from event ingest time (feeds have
  // no per-item count); midnight UTC boundary.
  const startOfDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  )
  const newToday =
    data.proposedEvents.filter(e => isOnOrAfter(e.createdAt, startOfDay)).length +
    data.approvedEvents.filter(e => isOnOrAfter(e.createdAt, startOfDay)).length

  const section = el('section', 'publisher-overview-section')
  section.appendChild(sectionLabel(t('publisher.overview.pipeline.label')))

  const flow = el('div', 'publisher-overview-pipeline')

  flow.appendChild(
    pipelineStage(
      {
        kicker: t('publisher.overview.pipeline.sources.kicker'),
        title: t('publisher.overview.pipeline.sources.title'),
        stat: plural(
          data.activeFeeds ?? 0,
          {
            one: 'publisher.overview.pipeline.sources.stat.one',
            other: 'publisher.overview.pipeline.sources.stat.other',
          },
          { count: data.activeFeeds ?? 0 },
        ),
        sub: plural(
          newToday,
          {
            one: 'publisher.overview.pipeline.sources.sub.one',
            other: 'publisher.overview.pipeline.sources.sub.other',
          },
          { count: newToday },
        ),
        path: '/publish/feeds',
      },
      routerNavigate,
    ),
  )
  flow.appendChild(el('div', 'publisher-overview-pipeline-arrow', '→'))
  flow.appendChild(
    pipelineStage(
      {
        kicker: t('publisher.overview.pipeline.curate.kicker'),
        title: t('publisher.overview.pipeline.curate.title'),
        stat: plural(
          data.proposedEvents.length,
          {
            one: 'publisher.overview.pipeline.curate.stat.one',
            other: 'publisher.overview.pipeline.curate.stat.other',
          },
          { count: data.proposedEvents.length },
        ),
        sub: plural(
          data.approvedEvents.length,
          {
            one: 'publisher.overview.pipeline.curate.sub.one',
            other: 'publisher.overview.pipeline.curate.sub.other',
          },
          { count: data.approvedEvents.length },
        ),
        path: '/publish/events',
      },
      routerNavigate,
    ),
  )
  // The final "feature it" stage rides the hero toggle — a node with
  // events on but the hero surface off still gets the sources→curate
  // flow, just without the third stage.
  if (features.hero) {
    flow.appendChild(el('div', 'publisher-overview-pipeline-arrow', '→'))
    const heroLive = data.hero != null
    const heroSub =
      heroLive && data.hero
        ? t('publisher.overview.pipeline.feature.sub', {
            when: formatRelative(new Date(data.hero.window.end), now),
          })
        : t('publisher.overview.pipeline.feature.subNone')
    flow.appendChild(
      pipelineStage(
        {
          kicker: t('publisher.overview.pipeline.feature.kicker'),
          title: t('publisher.overview.pipeline.feature.title'),
          stat: heroLive
            ? t('publisher.overview.pipeline.feature.stat.live')
            : t('publisher.overview.pipeline.feature.stat.none'),
          sub: heroSub,
          path: '/publish/featured-hero',
        },
        routerNavigate,
      ),
    )
  }

  section.appendChild(flow)
  section.appendChild(
    el('p', 'publisher-overview-pipeline-caption', t('publisher.overview.pipeline.caption')),
  )
  return section
}

function renderActivityColumn(data: OverviewData, now: Date): HTMLElement {
  const col = el('section', 'publisher-overview-col')
  col.appendChild(sectionLabel(t('publisher.overview.activity.label')))
  const entries = deriveActivity(data, now)
  if (entries.length === 0) {
    col.appendChild(el('p', 'publisher-overview-empty', t('publisher.overview.activity.empty')))
    return col
  }
  const list = el('ul', 'publisher-overview-activity')
  for (const entry of entries) {
    const li = el('li', `publisher-overview-activity-item publisher-overview-tone-${entry.tone}`)
    li.appendChild(el('span', 'publisher-overview-activity-dot'))
    li.appendChild(el('span', 'publisher-overview-activity-label', entry.label))
    li.appendChild(
      el('span', 'publisher-overview-activity-time', formatRelative(new Date(entry.ts), now)),
    )
    list.appendChild(li)
  }
  col.appendChild(list)
  return col
}

function renderFeedbackColumn(data: OverviewData, now: Date): HTMLElement {
  const col = el('section', 'publisher-overview-col')
  col.appendChild(sectionLabel(t('publisher.overview.feedback.label')))
  if (data.feedback.length === 0) {
    col.appendChild(el('p', 'publisher-overview-empty', t('publisher.overview.feedback.empty')))
    return col
  }
  const list = el('ul', 'publisher-overview-feedback')
  for (const fb of data.feedback.slice(0, 4)) {
    const positive = fb.rating !== 'thumbs-down'
    const li = el('li', 'publisher-overview-feedback-item')
    const glyph = el(
      'span',
      `publisher-overview-feedback-glyph publisher-overview-feedback-${positive ? 'up' : 'down'}`,
      positive ? '▲' : '▼',
    )
    glyph.setAttribute(
      'aria-label',
      positive
        ? t('publisher.overview.feedback.positive')
        : t('publisher.overview.feedback.negative'),
    )
    li.appendChild(glyph)
    li.appendChild(
      el('span', 'publisher-overview-feedback-comment', fb.comment?.trim() || '—'),
    )
    if (fb.created_at) {
      li.appendChild(
        el(
          'span',
          'publisher-overview-feedback-time',
          formatRelative(new Date(fb.created_at), now),
        ),
      )
    }
    list.appendChild(li)
  }
  col.appendChild(list)
  return col
}

function renderOverview(
  mount: HTMLElement,
  data: OverviewData,
  privileged: boolean,
  features: FeatureMap,
  now: Date,
  routerNavigate?: (p: string) => void,
): void {
  const shell = el('main', 'publisher-shell publisher-overview')
  shell.appendChild(renderHeader(data, privileged, features, routerNavigate))

  // Needs-you cards self-hide via the data: a disabled feature's
  // loads were skipped, so its card never has anything to show.
  const needs = renderNeedsYou(data, now, routerNavigate)
  if (needs) shell.appendChild(needs)

  shell.appendChild(renderGlance(data, privileged, features))

  // The newsroom pipeline is the feeds→events(→hero) flow.
  if (privileged && features.events) {
    shell.appendChild(renderPipeline(data, now, features, routerNavigate))
  }

  const columns = el('div', 'publisher-overview-columns')
  columns.appendChild(renderActivityColumn(data, now))
  if (privileged && features.feedback) columns.appendChild(renderFeedbackColumn(data, now))
  shell.appendChild(columns)

  mount.replaceChildren(shell)
}

/**
 * Boot the Overview page. Renders a loading state, resolves
 * identity (the one read whose auth errors are handled), then
 * aggregates the best-effort reads and renders. Idempotent.
 */
export async function renderOverviewPage(
  mount: HTMLElement,
  options: OverviewPageOptions = {},
): Promise<void> {
  renderLoading(mount)
  const fetchFn = options.fetchFn ?? globalThis.fetch
  const now = options.now?.() ?? new Date()
  const routerNavigate = options.routerNavigate

  const meResult = await publisherGet<MeResponse>('/api/v1/publish/me', {
    fetchFn,
    sleep: options.sleep,
  })
  if (!meResult.ok) {
    if (meResult.kind === 'session') {
      if (handleSessionError({ navigate: options.navigate }) === 'show-error') {
        renderError(mount, 'session')
      }
      return
    }
    if (meResult.kind === 'server') {
      renderError(mount, 'server', { status: meResult.status, body: meResult.body })
      return
    }
    renderError(mount, meResult.kind)
    return
  }
  clearWarmupFlag()

  const privileged = isPrivileged(meResult.data)
  // The node's feature toggles gate which reads run and which panels
  // render. Module-cached + fail-open (all-enabled) like every page.
  const features = await fetchFeatures()
  const data = await loadOverview(fetchFn, privileged, now, features)
  renderOverview(mount, data, privileged, features, now, routerNavigate)
}
