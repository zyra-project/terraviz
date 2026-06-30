/**
 * /publish/events — the current-events review queue, redesigned as
 * **Direction A: a master–detail triage queue**
 * (`docs/events-tab-handoff/EVENTS_TAB_IMPLEMENTATION_BRIEF.md`).
 *
 * Privileged-only (admin / service). Fetches the caller's role
 * (`/api/v1/publish/me`) and the events queue (`GET
 * /api/v1/publish/events`), then renders a top bar (heading + status
 * filter pills + Refresh / New-event actions) over a two-pane body: the
 * **event queue** on the left (`event-queue.ts`) and the selected
 * event's **detail** on the right (`event-detail.ts`) with the two-level
 * approval model. Both review actions post to
 * `POST /api/v1/publish/events/:id`.
 *
 * Non-privileged callers get a restricted card (the API also enforces
 * 403; gating here avoids a fetch-then-reject round-trip).
 */

import { t } from '../../../i18n'
import { publisherGet, publisherSend, handleSessionError } from '../api'
import { buildErrorCard } from '../components/error-card'
import { renderEventQueue } from '../components/events/event-queue'
import { renderEventDetail } from '../components/events/event-detail'
import type { EventStatus, EventsResponse, ReviewEvent } from '../components/events/events-model'

interface MeResponse {
  role: string
  is_admin: boolean
}

const ME_ENDPOINT = '/api/v1/publish/me'
const EVENTS_ENDPOINT = '/api/v1/publish/events'
const REFRESH_ENDPOINT = '/api/v1/publish/events/refresh'

interface RefreshResult {
  created: number
  refreshed: number
  failed: number
}

/** The queue's status filter — the four statuses plus `all`. */
type QueueFilter = EventStatus | 'all'
const QUEUE_FILTERS: readonly QueueFilter[] = ['proposed', 'approved', 'rejected', 'expired', 'all']

export interface EventsPageOptions {
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
}

function clientIsPrivileged(me: MeResponse): boolean {
  return me.is_admin === true || me.role === 'admin' || me.role === 'service'
}

function el(tag: string, className: string, children: (HTMLElement | string)[] = []): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  for (const c of children) node.append(c)
  return node
}

function shell(...children: HTMLElement[]): HTMLElement {
  return el('main', 'publisher-shell', children)
}

function card(...children: HTMLElement[]): HTMLElement {
  return el('section', 'publisher-card', children)
}

export async function renderEventsPage(mount: HTMLElement, options: EventsPageOptions = {}): Promise<void> {
  const fetchFn = options.fetchFn
  mount.replaceChildren(shell(el('p', 'publisher-loading', [t('publisher.events.loading')])))

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
      shell(card(
        el('h2', 'publisher-card-heading', [t('publisher.events.title')]),
        el('p', 'publisher-events-restricted', [t('publisher.events.restricted')]),
      )),
    )
    return
  }

  await loadAndRenderQueue(mount, { fetchFn, navigate: options.navigate })
}

/** Fetch the queue at `status` and render the triage view. */
async function loadAndRenderQueue(
  mount: HTMLElement,
  state: EventsPageOptions,
  notice?: string,
  status: QueueFilter = 'proposed',
): Promise<void> {
  const res = await publisherGet<EventsResponse>(`${EVENTS_ENDPOINT}?status=${status}`, { fetchFn: state.fetchFn })
  if (!res.ok) {
    if (res.kind === 'session') {
      if (handleSessionError({ navigate: state.navigate }) === 'navigating') return
      mount.replaceChildren(shell(buildErrorCard('session')))
      return
    }
    const details = res.kind === 'server' ? { status: res.status, body: res.body } : {}
    mount.replaceChildren(shell(buildErrorCard(res.kind, details)))
    return
  }
  renderTriage(mount, res.data.events, state, notice, status)
}

/** The master–detail triage view: top bar + (queue | detail). */
function renderTriage(
  mount: HTMLElement,
  events: ReviewEvent[],
  state: EventsPageOptions,
  notice: string | undefined,
  filter: QueueFilter,
): void {
  let selectedId: string | null = events[0]?.id ?? null

  const topbar = renderTopbar(mount, state, notice, filter)

  // The body rebuilds queue + detail together so selection + in-place
  // status changes (which mutate `events`) stay in sync.
  const body = el('div', 'publisher-events-body')
  const rebuildBody = (): void => {
    body.replaceChildren()
    if (events.length === 0) {
      body.append(el('p', 'publisher-empty-message', [t('publisher.events.empty')]))
      return
    }
    const queue = renderEventQueue(events, selectedId, {
      onSelect: id => {
        selectedId = id
        rebuildBody()
      },
    })
    const selected = events.find(e => e.id === selectedId) ?? events[0]
    const detail = renderEventDetail(selected, {
      fetchFn: state.fetchFn,
      navigate: state.navigate,
      onEventStatusChange: (_id, next) => {
        // If the event no longer matches the active filter, reload so it
        // leaves the queue; otherwise just refresh the body so the queue
        // dot reflects the new status.
        if (filter !== 'all' && next !== filter) {
          void loadAndRenderQueue(mount, state, t('publisher.events.saved'), filter)
          return
        }
        rebuildBody()
      },
    })
    body.append(queue, detail)
  }
  rebuildBody()

  mount.replaceChildren(shell(topbar, card(body)))
}

/** Top bar: heading, status-filter pills, Refresh / New-event actions,
 *  a status line, and a host the inline new-event form mounts into. */
function renderTopbar(
  mount: HTMLElement,
  state: EventsPageOptions,
  notice: string | undefined,
  filter: QueueFilter,
): HTMLElement {
  const status = el('p', 'publisher-events-actions-status', notice ? [notice] : [])
  status.setAttribute('role', 'status')
  const formHost = el('div', 'publisher-events-form-host')

  const refreshBtn = document.createElement('button')
  refreshBtn.type = 'button'
  refreshBtn.className = 'publisher-btn'
  refreshBtn.textContent = t('publisher.events.refresh')
  refreshBtn.addEventListener('click', () => {
    refreshBtn.disabled = true
    status.classList.remove('publisher-events-status-error')
    status.textContent = t('publisher.events.refreshing')
    void publisherSend<RefreshResult>(REFRESH_ENDPOINT, {}, { method: 'POST', fetchFn: state.fetchFn }).then(res => {
      if (res.ok) {
        void loadAndRenderQueue(
          mount,
          state,
          t('publisher.events.refreshResult', {
            created: String(res.data.created),
            refreshed: String(res.data.refreshed),
            failed: String(res.data.failed),
          }),
          filter,
        )
        return
      }
      refreshBtn.disabled = false
      if (res.kind === 'session' && handleSessionError({ navigate: state.navigate }) === 'navigating') return
      status.textContent = t('publisher.events.refreshError')
      status.classList.add('publisher-events-status-error')
    })
  })

  const newBtn = document.createElement('button')
  newBtn.type = 'button'
  newBtn.className = 'publisher-btn publisher-btn-primary'
  newBtn.textContent = t('publisher.events.new')
  newBtn.addEventListener('click', () => {
    if (formHost.childElementCount > 0) {
      formHost.replaceChildren()
      return
    }
    formHost.replaceChildren(renderNewEventForm(mount, state, formHost, filter))
  })

  const filters = el('div', 'publisher-events-filters')
  filters.setAttribute('role', 'group')
  filters.setAttribute('aria-label', t('publisher.events.filter.label'))
  for (const f of QUEUE_FILTERS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `publisher-events-filter${f === filter ? ' publisher-events-filter-active' : ''}`
    btn.textContent = f === 'all' ? t('publisher.events.filter.all') : statusLabel(f)
    btn.setAttribute('aria-pressed', f === filter ? 'true' : 'false')
    btn.addEventListener('click', () => {
      if (f !== filter) void loadAndRenderQueue(mount, state, undefined, f)
    })
    filters.append(btn)
  }

  const bar = el('div', 'publisher-events-topbar', [
    el('div', 'publisher-events-topbar-head', [
      el('h2', 'publisher-card-heading', [t('publisher.events.title')]),
      el('div', 'publisher-events-toolbar', [refreshBtn, newBtn]),
    ]),
    filters,
    status,
    formHost,
  ])
  return card(bar)
}

function statusLabel(status: EventStatus): string {
  switch (status) {
    case 'proposed': return t('publisher.events.status.proposed')
    case 'approved': return t('publisher.events.status.approved')
    case 'rejected': return t('publisher.events.status.rejected')
    case 'expired': return t('publisher.events.status.expired')
  }
}

function field(labelText: string, control: HTMLElement): HTMLElement {
  return el('label', 'publisher-events-field', [
    el('span', 'publisher-field-label', [labelText]),
    control,
  ])
}

/** The inline hand-authoring form (replaced by a drawer in a later
 *  slice). Posts to the create endpoint with no feed key; reloads the
 *  queue on success. */
function renderNewEventForm(
  mount: HTMLElement,
  state: EventsPageOptions,
  formHost: HTMLElement,
  filter: QueueFilter,
): HTMLElement {
  const titleInput = Object.assign(document.createElement('input'), { type: 'text', required: true, className: 'publisher-form-input' })
  const summaryInput = Object.assign(document.createElement('textarea'), { className: 'publisher-form-textarea', rows: 2 })
  const sourceNameInput = Object.assign(document.createElement('input'), { type: 'text', required: true, className: 'publisher-form-input' })
  const sourceUrlInput = Object.assign(document.createElement('input'), { type: 'url', required: true, className: 'publisher-form-input', placeholder: 'https://' })
  const startInput = Object.assign(document.createElement('input'), { type: 'text', className: 'publisher-form-input', placeholder: '2026-06-26T12:00:00Z' })
  const endInput = Object.assign(document.createElement('input'), { type: 'text', className: 'publisher-form-input' })
  const regionInput = Object.assign(document.createElement('input'), { type: 'text', className: 'publisher-form-input' })
  const keywordsInput = Object.assign(document.createElement('input'), { type: 'text', className: 'publisher-form-input' })

  const status = el('p', 'publisher-events-form-status', [])
  status.setAttribute('role', 'status')
  const submitBtn = Object.assign(document.createElement('button'), { type: 'submit', className: 'publisher-btn publisher-btn-primary', textContent: t('publisher.events.form.submit') })
  const cancelBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'publisher-btn', textContent: t('publisher.events.form.cancel') })
  cancelBtn.addEventListener('click', () => formHost.replaceChildren())

  const form = el('form', 'publisher-events-form', [
    el('h3', 'publisher-events-form-heading', [t('publisher.events.form.heading')]),
    field(t('publisher.events.form.title'), titleInput),
    field(t('publisher.events.form.summary'), summaryInput),
    field(t('publisher.events.form.sourceName'), sourceNameInput),
    field(t('publisher.events.form.sourceUrl'), sourceUrlInput),
    field(t('publisher.events.form.occurredStart'), startInput),
    field(t('publisher.events.form.occurredEnd'), endInput),
    field(t('publisher.events.form.region'), regionInput),
    field(t('publisher.events.form.keywords'), keywordsInput),
    el('div', 'publisher-events-form-actions', [submitBtn, cancelBtn]),
    status,
  ]) as HTMLFormElement

  form.addEventListener('submit', ev => {
    ev.preventDefault()
    const trimmed = (v: string): string | undefined => {
      const s = v.trim()
      return s.length > 0 ? s : undefined
    }
    const region = trimmed(regionInput.value)
    const keywords = keywordsInput.value.split(',').map(k => k.trim()).filter(k => k.length > 0)
    const body = {
      title: titleInput.value.trim(),
      summary: trimmed(summaryInput.value),
      source: { name: sourceNameInput.value.trim(), url: sourceUrlInput.value.trim() },
      occurredStart: trimmed(startInput.value),
      occurredEnd: trimmed(endInput.value),
      geometry: region ? { regionName: region } : undefined,
      keywords: keywords.length > 0 ? keywords : undefined,
    }
    status.classList.remove('publisher-events-status-error')
    submitBtn.disabled = true
    void publisherSend<unknown>(EVENTS_ENDPOINT, body, { method: 'POST', fetchFn: state.fetchFn }).then(res => {
      submitBtn.disabled = false
      if (res.ok) {
        void loadAndRenderQueue(mount, state, t('publisher.events.form.created'), filter)
        return
      }
      if (res.kind === 'session' && handleSessionError({ navigate: state.navigate }) === 'navigating') return
      status.textContent = res.kind === 'validation' && res.errors.length > 0 ? res.errors[0].message : t('publisher.events.form.error')
      status.classList.add('publisher-events-status-error')
    })
  })

  return form
}
