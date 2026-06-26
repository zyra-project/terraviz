/**
 * /publish/events — the current-events review queue
 * (`docs/CURRENT_EVENTS_PLAN.md` §5).
 *
 * Privileged-only (admin / service). Fetches the caller's role
 * (`/api/v1/publish/me`) and the proposed events
 * (`GET /api/v1/publish/events`), then renders one card per event: its
 * source citation, summary, status, and the proposed event→dataset
 * links with their match score + per-signal breakdown. The curator
 * vets the event itself (Approve / Reject) and each dataset link
 * independently; both post to `POST /api/v1/publish/events/:id`.
 *
 * The queue header also carries two authoring actions: "Refresh feed"
 * pulls the node's configured feed on demand
 * (`POST /api/v1/publish/events/refresh`) instead of waiting for the
 * cron, and "New event" reveals an inline form that hand-authors a
 * one-off event (`POST /api/v1/publish/events`, no feed) for a breaking
 * story no feed carries.
 *
 * Non-privileged callers get a restricted card (the API also enforces
 * 403, but gating here avoids a fetch-then-reject round-trip).
 */

import { t } from '../../../i18n'
import { publisherGet, publisherSend, handleSessionError } from '../api'
import { buildErrorCard } from '../components/error-card'

interface MeResponse {
  role: string
  is_admin: boolean
}

type EventStatus = 'proposed' | 'approved' | 'rejected' | 'expired'
type LinkStatus = 'proposed' | 'approved' | 'rejected'

interface ReviewLink {
  datasetId: string
  datasetTitle: string | null
  score: number | null
  signals: { geo?: number | null; temporal?: number | null; semantic?: number | null } | null
  status: LinkStatus
}

interface ReviewEvent {
  id: string
  title: string
  summary?: string
  source: { name: string; url: string; publishedAt?: string }
  occurredStart?: string
  occurredEnd?: string
  status: EventStatus
  links: ReviewLink[]
}

interface EventsResponse {
  events: ReviewEvent[]
}

const ME_ENDPOINT = '/api/v1/publish/me'
const EVENTS_ENDPOINT = '/api/v1/publish/events'
const REFRESH_ENDPOINT = '/api/v1/publish/events/refresh'

interface RefreshResult {
  created: number
  refreshed: number
  failed: number
}

/** The queue's status filter — the four real statuses plus `all`
 *  (every status), so a curator can find + manage already-reviewed
 *  events, not just the `proposed` review backlog. */
type QueueFilter = EventStatus | 'all'
const QUEUE_FILTERS: readonly QueueFilter[] = ['proposed', 'approved', 'rejected', 'expired', 'all']

export interface EventsPageOptions {
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
}

function clientIsPrivileged(me: MeResponse): boolean {
  return me.is_admin === true || me.role === 'admin' || me.role === 'service'
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  children: (HTMLElement | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  Object.assign(node, props)
  for (const c of children) node.append(c)
  return node
}

function shell(...children: HTMLElement[]): HTMLElement {
  const m = el('main', { className: 'publisher-shell' })
  for (const c of children) m.append(c)
  return m
}

function card(...children: HTMLElement[]): HTMLElement {
  const c = el('section', { className: 'publisher-card publisher-glass' })
  for (const child of children) c.append(child)
  return c
}

function heading(text: string): HTMLElement {
  return el('h2', { className: 'publisher-card-heading', textContent: text })
}

export async function renderEventsPage(
  mount: HTMLElement,
  options: EventsPageOptions = {},
): Promise<void> {
  const fetchFn = options.fetchFn
  mount.replaceChildren(shell(el('p', { className: 'publisher-loading', textContent: t('publisher.events.loading') })))

  // Resolve identity + gate BEFORE fetching the events queue: the events
  // endpoint 403s a non-privileged caller, which would otherwise surface
  // as a generic server-error card instead of the intended restricted
  // card.
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
        card(
          heading(t('publisher.events.title')),
          el('p', { className: 'publisher-events-restricted', textContent: t('publisher.events.restricted') }),
        ),
      ),
    )
    return
  }

  await loadAndRenderQueue(mount, { fetchFn, navigate: options.navigate })
}

/** Fetch the queue and (re)render it. Reused by the initial load and by
 *  the Refresh / New-event actions, which want the freshly-pulled state.
 *  An optional `notice` is surfaced in the header's status line so a
 *  message ("Imported 3 new…") survives the re-render. */
async function loadAndRenderQueue(
  mount: HTMLElement,
  state: EventsPageOptions,
  notice?: string,
  status: QueueFilter = 'proposed',
): Promise<void> {
  const eventsRes = await publisherGet<EventsResponse>(`${EVENTS_ENDPOINT}?status=${status}`, { fetchFn: state.fetchFn })
  if (!eventsRes.ok) {
    if (eventsRes.kind === 'session') {
      if (handleSessionError({ navigate: state.navigate }) === 'navigating') return
      mount.replaceChildren(shell(buildErrorCard('session')))
      return
    }
    const details = eventsRes.kind === 'server' ? { status: eventsRes.status, body: eventsRes.body } : {}
    mount.replaceChildren(shell(buildErrorCard(eventsRes.kind, details)))
    return
  }
  renderQueue(mount, eventsRes.data.events, state, notice, status)
}

function renderQueue(
  mount: HTMLElement,
  events: ReviewEvent[],
  state: EventsPageOptions,
  notice?: string,
  status: QueueFilter = 'proposed',
): void {
  const header = renderHeader(mount, state, notice, status)

  if (events.length === 0) {
    mount.replaceChildren(shell(header, el('p', { className: 'publisher-empty-message', textContent: t('publisher.events.empty') })))
    return
  }

  const list = el('div', { className: 'publisher-events-list' })
  for (const event of events) list.append(renderEventCard(mount, event, state, status))
  mount.replaceChildren(shell(header, list))
}

/** The queue header card: title, intro, the status filter, the Refresh /
 *  New-event actions, a status line, and a host slot the inline form
 *  mounts into. `filter` is the active status view. */
function renderHeader(mount: HTMLElement, state: EventsPageOptions, notice?: string, filter: QueueFilter = 'proposed'): HTMLElement {
  const status = el('p', { className: 'publisher-events-actions-status', role: 'status' })
  if (notice) status.textContent = notice
  const formHost = el('div', { className: 'publisher-events-form-host' })

  const refreshBtn = el('button', { type: 'button', className: 'publisher-btn', textContent: t('publisher.events.refresh') })
  const newBtn = el('button', { type: 'button', className: 'publisher-btn publisher-btn-primary', textContent: t('publisher.events.new') })

  refreshBtn.addEventListener('click', () => {
    refreshBtn.disabled = true
    status.classList.remove('publisher-events-status-error')
    status.textContent = t('publisher.events.refreshing')
    void publisherSend<RefreshResult>(REFRESH_ENDPOINT, {}, { method: 'POST', fetchFn: state.fetchFn }).then(res => {
      if (res.ok) {
        // Re-render the freshly-pulled queue, preserving the active
        // filter and carrying the result summary into the status line.
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

  newBtn.addEventListener('click', () => {
    if (formHost.childElementCount > 0) {
      formHost.replaceChildren() // toggle closed
      return
    }
    formHost.replaceChildren(renderNewEventForm(mount, state, formHost, filter))
  })

  const actions = el('div', { className: 'publisher-events-toolbar' }, [refreshBtn, newBtn])
  return card(
    heading(t('publisher.events.title')),
    el('p', { className: 'publisher-events-intro', textContent: t('publisher.events.intro') }),
    renderFilterBar(mount, state, filter),
    actions,
    status,
    formHost,
  )
}

/** Translated label for a queue filter (reuses the per-status labels). */
function filterLabel(f: QueueFilter): string {
  return f === 'all' ? t('publisher.events.filter.all') : statusLabel(f)
}

/** The status filter row. Switching filter re-fetches the queue at that
 *  status — this is how a curator reaches approved events to remove them
 *  (Reject), since the default view is the `proposed` backlog. */
function renderFilterBar(mount: HTMLElement, state: EventsPageOptions, active: QueueFilter): HTMLElement {
  const bar = el('div', { className: 'publisher-events-filters', role: 'group' })
  bar.setAttribute('aria-label', t('publisher.events.filter.label'))
  for (const f of QUEUE_FILTERS) {
    const btn = el('button', {
      type: 'button',
      className: `publisher-events-filter${f === active ? ' publisher-events-filter-active' : ''}`,
      textContent: filterLabel(f),
    })
    // Toggle semantics: set the pressed state explicitly on every button.
    btn.setAttribute('aria-pressed', f === active ? 'true' : 'false')
    btn.addEventListener('click', () => {
      if (f !== active) void loadAndRenderQueue(mount, state, undefined, f)
    })
    bar.append(btn)
  }
  return bar
}

/** A labelled form control. */
function field(labelText: string, control: HTMLElement): HTMLElement {
  return el('label', { className: 'publisher-events-field' }, [
    el('span', { className: 'publisher-field-label', textContent: labelText }),
    control,
  ])
}

/** The inline hand-authoring form. Posts to the create endpoint with no
 *  feed key (a manual event); on success it reloads the queue. */
function renderNewEventForm(
  mount: HTMLElement,
  state: EventsPageOptions,
  formHost: HTMLElement,
  filter: QueueFilter = 'proposed',
): HTMLElement {
  const titleInput = el('input', { type: 'text', required: true, className: 'publisher-form-input' })
  const summaryInput = el('textarea', { className: 'publisher-form-textarea', rows: 2 })
  const sourceNameInput = el('input', { type: 'text', required: true, className: 'publisher-form-input' })
  const sourceUrlInput = el('input', { type: 'url', required: true, className: 'publisher-form-input', placeholder: 'https://' })
  const startInput = el('input', { type: 'text', className: 'publisher-form-input', placeholder: '2026-06-26T12:00:00Z' })
  const endInput = el('input', { type: 'text', className: 'publisher-form-input' })
  const regionInput = el('input', { type: 'text', className: 'publisher-form-input' })
  const keywordsInput = el('input', { type: 'text', className: 'publisher-form-input' })

  const status = el('p', { className: 'publisher-events-form-status', role: 'status' })
  const submitBtn = el('button', { type: 'submit', className: 'publisher-btn publisher-btn-primary', textContent: t('publisher.events.form.submit') })
  const cancelBtn = el('button', { type: 'button', className: 'publisher-btn', textContent: t('publisher.events.form.cancel') })
  cancelBtn.addEventListener('click', () => formHost.replaceChildren())

  const form = el('form', { className: 'publisher-events-form' }, [
    el('h3', { className: 'publisher-events-form-heading', textContent: t('publisher.events.form.heading') }),
    field(t('publisher.events.form.title'), titleInput),
    field(t('publisher.events.form.summary'), summaryInput),
    field(t('publisher.events.form.sourceName'), sourceNameInput),
    field(t('publisher.events.form.sourceUrl'), sourceUrlInput),
    field(t('publisher.events.form.occurredStart'), startInput),
    field(t('publisher.events.form.occurredEnd'), endInput),
    field(t('publisher.events.form.region'), regionInput),
    field(t('publisher.events.form.keywords'), keywordsInput),
    el('div', { className: 'publisher-events-form-actions' }, [submitBtn, cancelBtn]),
    status,
  ])

  form.addEventListener('submit', ev => {
    ev.preventDefault()
    const trimmed = (v: string): string | undefined => {
      const s = v.trim()
      return s.length > 0 ? s : undefined
    }
    const region = trimmed(regionInput.value)
    const keywords = keywordsInput.value
      .split(',')
      .map(k => k.trim())
      .filter(k => k.length > 0)
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
      status.textContent =
        res.kind === 'validation' && res.errors.length > 0 ? res.errors[0].message : t('publisher.events.form.error')
      status.classList.add('publisher-events-status-error')
    })
  })

  return form
}

/** Translated status label (literal keys so the MessageKey union
 *  verifies each one). */
function statusLabel(status: EventStatus | LinkStatus): string {
  switch (status) {
    case 'proposed':
      return t('publisher.events.status.proposed')
    case 'approved':
      return t('publisher.events.status.approved')
    case 'rejected':
      return t('publisher.events.status.rejected')
    case 'expired':
      return t('publisher.events.status.expired')
  }
}

/** A translated status badge for an event or link. */
function badge(status: EventStatus | LinkStatus): HTMLElement {
  return el('span', {
    className: `publisher-events-badge publisher-events-badge-${status}`,
    textContent: statusLabel(status),
  })
}

function formatScore(score: number | null): string {
  if (score == null) return '—'
  return `${Math.round(score * 100)}%`
}

function renderEventCard(mount: HTMLElement, event: ReviewEvent, state: EventsPageOptions, filter: QueueFilter): HTMLElement {
  const statusEl = el('div', { className: 'publisher-events-status', role: 'status' })
  const badgeEl = badge(event.status)

  const setBusy = (busy: boolean, buttons: HTMLButtonElement[]): void => {
    for (const b of buttons) b.disabled = busy
  }

  // ----- Event-level Approve / Reject -----
  const approveBtn = el('button', { type: 'button', className: 'publisher-btn publisher-btn-primary', textContent: t('publisher.events.approve') })
  const rejectBtn = el('button', { type: 'button', className: 'publisher-btn', textContent: t('publisher.events.reject') })
  const eventButtons = [approveBtn, rejectBtn]

  const submitEvent = (decision: 'approve' | 'reject'): void => {
    statusEl.textContent = ''
    statusEl.classList.remove('publisher-events-status-error')
    setBusy(true, eventButtons)
    void publisherSend<{ event: { status: EventStatus } | null }>(
      `${EVENTS_ENDPOINT}/${event.id}`,
      { event: decision },
      { method: 'POST', fetchFn: state.fetchFn },
    ).then(res => {
      setBusy(false, eventButtons)
      if (res.ok) {
        const next: EventStatus = res.data.event?.status ?? (decision === 'approve' ? 'approved' : 'rejected')
        // If the event no longer matches the active filter, reload so it
        // leaves the view (e.g. a Reject in the Approved view) and the
        // empty state shows if it was the last one. In the `all` view —
        // or when the status still matches — reflect it in place.
        if (filter !== 'all' && next !== filter) {
          void loadAndRenderQueue(mount, state, t('publisher.events.saved'), filter)
          return
        }
        badgeEl.className = `publisher-events-badge publisher-events-badge-${next}`
        badgeEl.textContent = statusLabel(next)
        statusEl.textContent = t('publisher.events.saved')
        return
      }
      handleWriteError(res, statusEl, state.navigate)
    })
  }
  approveBtn.addEventListener('click', () => submitEvent('approve'))
  rejectBtn.addEventListener('click', () => submitEvent('reject'))

  // ----- Source citation -----
  const source = el('p', { className: 'publisher-events-source' }, [
    el('span', { className: 'publisher-field-label', textContent: t('publisher.events.source') + ': ' }),
    el('a', { className: 'publisher-events-source-link', href: event.source.url, target: '_blank', rel: 'noopener noreferrer', textContent: event.source.name }),
  ])
  if (event.source.publishedAt) {
    source.append(el('span', { className: 'publisher-events-published', textContent: ` · ${event.source.publishedAt}` }))
  }

  const headerRow = el('div', { className: 'publisher-events-header' }, [
    el('h3', { className: 'publisher-events-event-title', textContent: event.title }),
    badgeEl,
  ])

  const meta: HTMLElement[] = [headerRow, source]
  if (event.summary) meta.push(el('p', { className: 'publisher-events-summary', textContent: event.summary }))
  if (event.occurredStart) {
    const when = event.occurredEnd ? `${event.occurredStart} → ${event.occurredEnd}` : event.occurredStart
    meta.push(el('p', { className: 'publisher-events-when' }, [
      el('span', { className: 'publisher-field-label', textContent: t('publisher.events.occurred') + ': ' }),
      when,
    ]))
  }

  const eventActions = el('div', { className: 'publisher-events-actions' }, [approveBtn, rejectBtn])

  return el('article', { className: 'publisher-events-card publisher-glass' }, [
    ...meta,
    eventActions,
    renderLinks(event, state),
    statusEl,
  ])
}

function renderLinks(event: ReviewEvent, state: EventsPageOptions): HTMLElement {
  const wrap = el('div', { className: 'publisher-events-links' })
  wrap.append(el('h4', { className: 'publisher-events-links-heading', textContent: t('publisher.events.links') }))

  if (event.links.length === 0) {
    wrap.append(el('p', { className: 'publisher-events-nolinks', textContent: t('publisher.events.noLinks') }))
    return wrap
  }

  for (const link of event.links) wrap.append(renderLinkRow(event.id, link, state))
  return wrap
}

function renderLinkRow(eventId: string, link: ReviewLink, state: EventsPageOptions): HTMLElement {
  const linkBadge = badge(link.status)
  const rowStatus = el('span', { className: 'publisher-events-link-status', role: 'status' })

  const approveBtn = el('button', { type: 'button', className: 'publisher-btn publisher-btn-small publisher-btn-primary', textContent: t('publisher.events.approve') })
  const rejectBtn = el('button', { type: 'button', className: 'publisher-btn publisher-btn-small', textContent: t('publisher.events.reject') })
  const buttons = [approveBtn, rejectBtn]

  const submit = (decision: 'approve' | 'reject'): void => {
    rowStatus.textContent = ''
    for (const b of buttons) b.disabled = true
    void publisherSend<unknown>(
      `${EVENTS_ENDPOINT}/${eventId}`,
      { links: [{ datasetId: link.datasetId, decision }] },
      { method: 'POST', fetchFn: state.fetchFn },
    ).then(res => {
      for (const b of buttons) b.disabled = false
      if (res.ok) {
        const next: LinkStatus = decision === 'approve' ? 'approved' : 'rejected'
        linkBadge.className = `publisher-events-badge publisher-events-badge-${next}`
        linkBadge.textContent = statusLabel(next)
        return
      }
      handleWriteError(res, rowStatus, state.navigate)
    })
  }
  approveBtn.addEventListener('click', () => submit('approve'))
  rejectBtn.addEventListener('click', () => submit('reject'))

  const signals = el('span', { className: 'publisher-events-signals' }, [
    signalChip('geo', link.signals?.geo),
    signalChip('temporal', link.signals?.temporal),
  ])

  return el('div', { className: 'publisher-events-link' }, [
    el('span', { className: 'publisher-events-link-title', textContent: link.datasetTitle ?? link.datasetId }),
    el('span', { className: 'publisher-events-link-score', textContent: `${t('publisher.events.match')} ${formatScore(link.score)}` }),
    signals,
    linkBadge,
    el('span', { className: 'publisher-events-link-actions' }, [approveBtn, rejectBtn]),
    rowStatus,
  ])
}

function signalChip(kind: 'geo' | 'temporal', value: number | null | undefined): HTMLElement {
  const label = kind === 'geo' ? t('publisher.events.signal.geo') : t('publisher.events.signal.temporal')
  const v = value == null ? '—' : `${Math.round(value * 100)}%`
  return el('span', { className: 'publisher-events-chip', textContent: `${label} ${v}` })
}

function handleWriteError(
  res: { ok: false; kind: string; errors?: Array<{ message: string }> },
  status: HTMLElement,
  navigate?: (url: string) => void,
): void {
  if (res.kind === 'session') {
    if (handleSessionError({ navigate }) === 'navigating') return
    status.textContent = t('publisher.events.error.session')
    status.classList.add('publisher-events-status-error')
    return
  }
  if (res.kind === 'validation' && res.errors && res.errors.length > 0) {
    status.textContent = res.errors[0].message
    status.classList.add('publisher-events-status-error')
    return
  }
  status.textContent = t('publisher.events.error.generic')
  status.classList.add('publisher-events-status-error')
}
