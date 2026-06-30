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
import { mountEventLocator } from '../components/events/event-locator-map'
import { openNewEventDrawer } from '../components/events/new-event-drawer'
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

/** Fetch the queue at `status` and render the triage view. `selectId`
 *  prefers a specific event for the initial selection (e.g. a just-created
 *  one) when it's present in the returned list. */
async function loadAndRenderQueue(
  mount: HTMLElement,
  state: EventsPageOptions,
  notice?: string,
  status: QueueFilter = 'proposed',
  selectId?: string,
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
  renderTriage(mount, res.data.events, state, notice, status, selectId)
}

/** The master–detail triage view: top bar + (queue | detail). */
function renderTriage(
  mount: HTMLElement,
  events: ReviewEvent[],
  state: EventsPageOptions,
  notice: string | undefined,
  filter: QueueFilter,
  selectId?: string,
): void {
  let selectedId: string | null =
    (selectId && events.some(e => e.id === selectId) ? selectId : events[0]?.id) ?? null

  const topbar = renderTopbar(mount, state, notice, filter)

  // The body rebuilds queue + detail together so selection + in-place
  // status changes (which mutate `events`) stay in sync. The active
  // locator map is disposed before each rebuild so its WebGL context
  // doesn't leak across selections.
  const body = el('div', 'publisher-events-body')
  let locatorDispose: (() => void) | null = null
  const rebuildBody = (): void => {
    locatorDispose?.()
    locatorDispose = null
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
      mountLocator: (slot, point) => {
        locatorDispose = mountEventLocator(slot, point)
      },
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
    openNewEventDrawer({
      fetchFn: state.fetchFn,
      navigate: state.navigate,
      // Reload preserving the active filter; prefer-select the new event
      // (lands `proposed`) so its manual + matched links are ready to vet.
      onCreated: newId => {
        void loadAndRenderQueue(mount, state, t('publisher.events.form.created'), filter, newId)
      },
    })
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

