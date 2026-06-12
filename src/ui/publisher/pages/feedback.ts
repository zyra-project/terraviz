/**
 * /publish/feedback — feedback review inside the portal (Phase C of
 * `docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md`).
 *
 * Replaces the hand-rolled HTML dashboard the legacy
 * `/api/feedback-admin` endpoint served (its `?action=` CSV/JSONL
 * machine exports survive and are linked from here). Privileged-only,
 * same client gate as featured-hero/analytics; data comes from
 * `GET /api/v1/publish/feedback`, which fronts the same
 * `_feedback-helpers` data layer the old dashboard used.
 *
 * Two views, switched by tabs:
 *   - AI feedback   — Orbit thumbs ratings: totals + satisfaction,
 *                     per-day series, top tags, recent table with a
 *                     detail overlay (full conversation context).
 *   - General       — bug / feature / other reports: totals,
 *                     per-day series, recent table with a detail
 *                     overlay; screenshots fetched on demand (never
 *                     inlined in list payloads).
 *
 * Feedback is stored indefinitely in D1, so unlike the analytics tab
 * there's no rollup lag and no estimated-counts framing — these are
 * exact rows.
 */

import { t } from '../../../i18n'
import { formatDate, formatNumber } from '../../../i18n/format'
import { publisherGet, handleSessionError, type PublisherApiResult } from '../api'
import { buildErrorCard } from '../components/error-card'
import { ROUTE_CHANGE_START_EVENT } from '../router'
import { renderBarSeries, renderStatTile } from '../analytics-charts'

const ME_ENDPOINT = '/api/v1/publish/me'
const FEEDBACK_ENDPOINT = '/api/v1/publish/feedback'
const AI_EXPORT_URL = '/api/feedback-admin?action=ai-export&include_prompt=true'
const GENERAL_EXPORT_URL = '/api/feedback-admin?action=general-export'
const RANGE_CHOICES = [7, 30, 90, 365] as const

interface MeResponse {
  role: string
  is_admin: boolean
}

interface AiRow {
  rating: string
  comment: string
  tags: string[]
  user_message: string
  assistant_message: string
  dataset_id: string | null
  modelConfig: { model?: string; readingLevel?: string }
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
}

interface GeneralData {
  totalCount: number
  bugCount: number
  featureCount: number
  otherCount: number
  byDay: Array<{ date: string; bugs: number; features: number; other: number }>
  recentFeedback: GeneralRow[]
}

interface Envelope<T> {
  view: string
  days: number
  data: T
}

export interface FeedbackPageOptions {
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
}

function clientIsPrivileged(me: MeResponse): boolean {
  return me.is_admin === true || me.role === 'staff' || me.role === 'service'
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  children: (HTMLElement | SVGElement | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  Object.assign(node, props)
  for (const c of children) node.append(c)
  return node
}

function shell(...children: HTMLElement[]): HTMLElement {
  const main = el('main', { className: 'publisher-shell publisher-feedback' })
  main.append(...children)
  return main
}

function formatWhen(iso: string): string {
  if (!iso) return '—'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  return formatDate(new Date(ms), { dateStyle: 'medium', timeStyle: 'short' })
}

export async function renderFeedbackPage(
  mount: HTMLElement,
  options: FeedbackPageOptions = {},
): Promise<void> {
  const fetchFn = options.fetchFn
  mount.replaceChildren(
    shell(el('p', { className: 'publisher-loading', textContent: t('publisher.feedback.loading') })),
  )

  const meRes = await publisherGet<MeResponse>(ME_ENDPOINT, { fetchFn })
  if (!meRes.ok) {
    if (meRes.kind === 'session') {
      if (handleSessionError({ navigate: options.navigate }) === 'navigating') return
      mount.replaceChildren(shell(buildErrorCard('session')))
      return
    }
    const details = meRes.kind === 'server' ? { status: meRes.status, body: meRes.body } : {}
    mount.replaceChildren(shell(buildErrorCard(meRes.kind, details)))
    return
  }
  if (!clientIsPrivileged(meRes.data)) {
    mount.replaceChildren(
      shell(
        el('h1', { textContent: t('publisher.feedback.title') }),
        el('p', {
          className: 'publisher-hero-restricted',
          textContent: t('publisher.feedback.restricted'),
        }),
      ),
    )
    return
  }

  const state = { view: 'ai' as 'ai' | 'general', days: 30 as (typeof RANGE_CHOICES)[number] }
  const contentHost = el('section', { className: 'publisher-feedback-content' })

  let disposed = false
  const onRouteChange = (): void => {
    disposed = true
    window.removeEventListener(ROUTE_CHANGE_START_EVENT, onRouteChange)
    closeOverlay()
  }
  window.addEventListener(ROUTE_CHANGE_START_EVENT, onRouteChange)

  const header = buildHeader(state, () => void load())
  mount.replaceChildren(shell(header, contentHost))
  void load()

  async function load(): Promise<void> {
    contentHost.replaceChildren(
      el('p', { className: 'publisher-loading', textContent: t('publisher.feedback.loading') }),
    )
    const res: PublisherApiResult<Envelope<AiData | GeneralData>> = await publisherGet(
      `${FEEDBACK_ENDPOINT}?view=${state.view}&days=${state.days}&recent=100`,
      { fetchFn },
    )
    if (disposed) return
    if (!res.ok) {
      if (res.kind === 'session') {
        if (handleSessionError({ navigate: options.navigate }) === 'navigating') return
      }
      const details = res.kind === 'server' ? { status: res.status, body: res.body } : {}
      contentHost.replaceChildren(buildErrorCard(res.kind, details))
      return
    }
    if (state.view === 'ai') renderAi(res.data.data as AiData)
    else renderGeneral(res.data.data as GeneralData)
  }

  function renderAi(data: AiData): void {
    const satisfaction =
      data.totalCount > 0 ? Math.round((data.thumbsUpCount / data.totalCount) * 100) : 0
    const tiles = el('div', { className: 'publisher-analytics-stats' }, [
      renderStatTile(t('publisher.feedback.ai.total'), formatNumber(data.totalCount)),
      renderStatTile(t('publisher.feedback.ai.positive'), formatNumber(data.thumbsUpCount)),
      renderStatTile(t('publisher.feedback.ai.negative'), formatNumber(data.thumbsDownCount)),
      renderStatTile(
        t('publisher.feedback.ai.satisfaction'),
        formatNumber(satisfaction / 100, { style: 'percent' }),
      ),
    ])

    const children: HTMLElement[] = [tiles]
    const byDay = [...data.byDay].reverse()
    if (byDay.length > 0) {
      children.push(
        el('div', { className: 'publisher-analytics-funnel' }, [
          seriesBlock(t('publisher.feedback.ai.positivePerDay'), byDay.map(d => ({ label: d.date, value: d.up }))),
          seriesBlock(t('publisher.feedback.ai.negativePerDay'), byDay.map(d => ({ label: d.date, value: d.down }))),
        ]),
      )
    }
    if (data.topTags.length > 0) {
      children.push(
        el('h3', { className: 'publisher-analytics-subheading', textContent: t('publisher.feedback.ai.topTags') }),
        el(
          'ul',
          { className: 'publisher-feedback-tags' },
          data.topTags.map(tag =>
            // Tag values are the fixed thumbs-feedback vocabulary,
            // shown verbatim. i18n-exempt: technical identifier
            el('li', { textContent: `${tag.tag} · ${formatNumber(tag.count)}` }),
          ),
        ),
      )
    }
    children.push(aiTable(data.recentFeedback))
    children.push(exportLink(AI_EXPORT_URL, t('publisher.feedback.exportJsonl')))
    contentHost.replaceChildren(...children)
  }

  function renderGeneral(data: GeneralData): void {
    const tiles = el('div', { className: 'publisher-analytics-stats' }, [
      renderStatTile(t('publisher.feedback.general.total'), formatNumber(data.totalCount)),
      renderStatTile(t('publisher.feedback.general.bugs'), formatNumber(data.bugCount)),
      renderStatTile(t('publisher.feedback.general.features'), formatNumber(data.featureCount)),
      renderStatTile(t('publisher.feedback.general.other'), formatNumber(data.otherCount)),
    ])
    const children: HTMLElement[] = [tiles]
    const byDay = [...data.byDay].reverse()
    if (byDay.length > 0) {
      children.push(
        el('div', { className: 'publisher-analytics-funnel' }, [
          seriesBlock(t('publisher.feedback.general.bugsPerDay'), byDay.map(d => ({ label: d.date, value: d.bugs }))),
          seriesBlock(t('publisher.feedback.general.featuresPerDay'), byDay.map(d => ({ label: d.date, value: d.features }))),
          seriesBlock(t('publisher.feedback.general.otherPerDay'), byDay.map(d => ({ label: d.date, value: d.other }))),
        ]),
      )
    }
    children.push(generalTable(data.recentFeedback))
    children.push(exportLink(GENERAL_EXPORT_URL, t('publisher.feedback.exportCsv')))
    contentHost.replaceChildren(...children)
  }

  function seriesBlock(label: string, points: Array<{ label: string; value: number }>): HTMLElement {
    return el('div', { className: 'publisher-analytics-funnel-block' }, [
      el('h3', { className: 'publisher-analytics-subheading', textContent: label }),
      renderBarSeries(points, { height: 56, ariaLabel: label }),
    ])
  }

  function exportLink(href: string, label: string): HTMLElement {
    const a = el('a', { className: 'publisher-feedback-export', textContent: label })
    a.href = href
    a.target = '_blank'
    a.rel = 'noopener'
    return el('p', {}, [a])
  }

  function aiTable(rows: AiRow[]): HTMLElement {
    if (rows.length === 0) {
      return el('p', { className: 'publisher-analytics-empty', textContent: t('publisher.feedback.empty') })
    }
    const table = el('table', { className: 'publisher-analytics-table' })
    table.append(
      el('thead', {}, [
        el('tr', {}, [
          el('th', { textContent: t('publisher.feedback.ai.rating') }),
          el('th', { textContent: t('publisher.feedback.ai.comment') }),
          el('th', { textContent: t('publisher.feedback.ai.userMessage') }),
          el('th', { textContent: t('publisher.feedback.dataset') }),
          el('th', { textContent: t('publisher.feedback.date') }),
        ]),
      ]),
    )
    const body = el('tbody')
    for (const row of rows) {
      const up = row.rating === 'thumbs-up'
      const tr = el('tr', { className: 'publisher-feedback-row' }, [
        el('td', {
          className: up ? 'publisher-feedback-up' : 'publisher-feedback-down',
          textContent: up ? '👍' : '👎', // i18n-exempt: pictographic rating icon
        }),
        clippedCell(row.comment),
        clippedCell(row.user_message),
        el('td', { textContent: row.dataset_id || '—' }),
        el('td', { className: 'publisher-feedback-when', textContent: formatWhen(row.created_at) }),
      ])
      tr.addEventListener('click', () => showAiDetail(row))
      body.append(tr)
    }
    table.append(body)
    return table
  }

  function generalTable(rows: GeneralRow[]): HTMLElement {
    if (rows.length === 0) {
      return el('p', { className: 'publisher-analytics-empty', textContent: t('publisher.feedback.empty') })
    }
    const table = el('table', { className: 'publisher-analytics-table' })
    table.append(
      el('thead', {}, [
        el('tr', {}, [
          el('th', { textContent: t('publisher.feedback.general.kind') }),
          el('th', { textContent: t('publisher.feedback.general.message') }),
          el('th', { textContent: t('publisher.feedback.general.contact') }),
          el('th', { textContent: t('publisher.feedback.general.screenshot') }),
          el('th', { textContent: t('publisher.feedback.date') }),
        ]),
      ]),
    )
    const body = el('tbody')
    for (const row of rows) {
      const tr = el('tr', { className: 'publisher-feedback-row' }, [
        el('td', {}, [kindPill(row.kind)]),
        clippedCell(row.message),
        clippedCell(row.contact || '—'),
        el('td', { textContent: row.hasScreenshot ? '📷' : '' }), // i18n-exempt: pictographic indicator
        el('td', { className: 'publisher-feedback-when', textContent: formatWhen(row.created_at) }),
      ])
      tr.addEventListener('click', () => showGeneralDetail(row))
      body.append(tr)
    }
    table.append(body)
    return table
  }

  function showAiDetail(row: AiRow): void {
    const fields: Array<[string, string]> = [
      [t('publisher.feedback.date'), formatWhen(row.created_at)],
      [t('publisher.feedback.detail.model'), row.modelConfig.model || '—'],
      [t('publisher.feedback.dataset'), row.dataset_id || '—'],
      [
        t('publisher.feedback.detail.source'),
        row.isFallback ? t('publisher.feedback.detail.localEngine') : t('publisher.feedback.detail.llm'),
      ],
    ]
    if (row.comment) fields.push([t('publisher.feedback.ai.comment'), row.comment])
    // Tag values shown verbatim. i18n-exempt: technical identifier
    if (row.tags.length > 0) fields.push([t('publisher.feedback.ai.topTags'), row.tags.join(', ')])
    fields.push([t('publisher.feedback.ai.userMessage'), row.user_message || '—'])
    fields.push([t('publisher.feedback.detail.assistantResponse'), row.assistant_message || '—'])
    openOverlay(row.rating === 'thumbs-up' ? '👍' : '👎', fields) // i18n-exempt: pictographic rating icon
  }

  function showGeneralDetail(row: GeneralRow): void {
    const fields: Array<[string, string]> = [
      [t('publisher.feedback.date'), formatWhen(row.created_at)],
      [t('publisher.feedback.detail.platform'), row.platform || '—'],
      [t('publisher.feedback.dataset'), row.dataset_id || '—'],
      [t('publisher.feedback.general.message'), row.message],
    ]
    if (row.contact) fields.push([t('publisher.feedback.general.contact'), row.contact])
    if (row.url) fields.push([t('publisher.feedback.detail.url'), row.url])
    if (row.app_version) fields.push([t('publisher.feedback.detail.appVersion'), row.app_version])
    const panel = openOverlay(row.kind, fields, kindPill(row.kind))

    if (row.hasScreenshot) {
      const slot = el('div', { className: 'publisher-feedback-detail-field' }, [
        el('div', { className: 'publisher-feedback-detail-label', textContent: t('publisher.feedback.general.screenshotLabel') }),
        el('p', { className: 'publisher-loading', textContent: t('publisher.feedback.loading') }),
      ])
      panel.append(slot)
      void publisherGet<{ screenshot: string }>(
        `${FEEDBACK_ENDPOINT}?view=screenshot&id=${row.id}`,
        { fetchFn },
      ).then(res => {
        if (disposed || !slot.isConnected) return
        if (!res.ok || !res.data.screenshot || !res.data.screenshot.startsWith('data:image/')) {
          slot.replaceChildren(
            el('p', { className: 'publisher-analytics-empty', textContent: t('publisher.feedback.general.screenshotFailed') }),
          )
          return
        }
        const img = el('img', { className: 'publisher-feedback-screenshot' })
        img.src = res.data.screenshot
        img.alt = t('publisher.feedback.general.screenshotAlt')
        slot.replaceChildren(
          el('div', { className: 'publisher-feedback-detail-label', textContent: t('publisher.feedback.general.screenshotLabel') }),
          img,
        )
      })
    }
  }

  /** Build + mount the detail overlay; returns the panel so callers
   * can append extra content (the lazy screenshot). */
  function openOverlay(titleText: string, fields: Array<[string, string]>, titleNode?: HTMLElement): HTMLElement {
    closeOverlay()
    const overlay = el('div', { className: 'publisher-feedback-overlay' })
    overlay.id = 'publisher-feedback-overlay'
    const panel = el('div', { className: 'publisher-feedback-panel publisher-glass' })
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'true')

    const close = el('button', { className: 'publisher-feedback-close', textContent: '×' }) // i18n-exempt: multiplication-sign close glyph
    close.setAttribute('aria-label', t('publisher.feedback.detail.close'))
    close.addEventListener('click', closeOverlay)
    panel.append(el('h2', {}, [titleNode ?? titleText, close]))

    for (const [label, value] of fields) {
      panel.append(
        el('div', { className: 'publisher-feedback-detail-field' }, [
          el('div', { className: 'publisher-feedback-detail-label', textContent: label }),
          el('div', { className: 'publisher-feedback-detail-value', textContent: value }),
        ]),
      )
    }

    overlay.append(panel)
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeOverlay()
    })
    overlay.addEventListener('keydown', e => {
      if ((e as KeyboardEvent).key === 'Escape') closeOverlay()
    })
    document.body.append(overlay)
    close.focus()
    return panel
  }
}

function closeOverlay(): void {
  document.getElementById('publisher-feedback-overlay')?.remove()
}

function kindPill(kind: string): HTMLElement {
  const pill = document.createElement('span')
  pill.className = `publisher-feedback-kind publisher-feedback-kind-${kind}`
  // Kind values are the fixed bug|feature|other enum, shown
  // verbatim. i18n-exempt: technical identifier
  pill.textContent = kind
  return pill
}

function buildHeader(
  state: { view: 'ai' | 'general'; days: number },
  onChange: () => void,
): HTMLElement {
  const heading = document.createElement('h1')
  heading.textContent = t('publisher.feedback.title')

  const tabs = document.createElement('div')
  tabs.className = 'publisher-feedback-tabs'
  tabs.setAttribute('role', 'tablist')
  const defs: Array<['ai' | 'general', string]> = [
    ['ai', t('publisher.feedback.tab.ai')],
    ['general', t('publisher.feedback.tab.general')],
  ]
  for (const [view, label] of defs) {
    const button = document.createElement('button')
    button.className = 'publisher-feedback-tab'
    button.setAttribute('role', 'tab')
    button.textContent = label
    const sync = (): void => {
      const selected = state.view === view
      button.classList.toggle('publisher-feedback-tab-active', selected)
      button.setAttribute('aria-selected', String(selected))
    }
    sync()
    button.addEventListener('click', () => {
      if (state.view === view) return
      state.view = view
      tabs.querySelectorAll('.publisher-feedback-tab').forEach(b => {
        b.classList.remove('publisher-feedback-tab-active')
        b.setAttribute('aria-selected', 'false')
      })
      sync()
      onChange()
    })
    tabs.append(button)
  }

  const range = document.createElement('label')
  range.className = 'publisher-analytics-control'
  range.append(el('span', { textContent: t('publisher.analytics.controls.range') }))
  const select = document.createElement('select')
  for (const days of RANGE_CHOICES) {
    const option = document.createElement('option')
    option.value = String(days)
    option.textContent = t('publisher.analytics.controls.rangeDays', { days: String(days) })
    if (days === state.days) option.selected = true
    select.append(option)
  }
  select.addEventListener('change', () => {
    state.days = parseInt(select.value, 10)
    onChange()
  })
  range.append(select)

  const controls = el('div', { className: 'publisher-analytics-controls' }, [tabs, range])
  const header = document.createElement('header')
  header.className = 'publisher-feedback-header'
  header.append(heading, controls)
  return header
}

function clippedCell(text: string): HTMLElement {
  const td = document.createElement('td')
  td.className = 'publisher-feedback-clip'
  td.textContent = text || '—'
  td.title = text
  return td
}
