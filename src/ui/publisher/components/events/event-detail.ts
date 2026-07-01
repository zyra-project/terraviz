/**
 * Direction A — the **right detail pane** of the Events triage queue
 * (`docs/events-tab-handoff/EVENTS_TAB_IMPLEMENTATION_BRIEF.md` §6 A).
 *
 * The two-level approval model lives here, visually separated:
 *   - **Event level** (the heavy decision): "Surface this event?" with a
 *     primary **Approve** + danger **Reject** — the most prominent block.
 *   - **Dataset level** (lighter): per-pairing ✓ / ✕ icon buttons, plus a
 *     **"Approve all ≥90%"** bulk action over the auto-pair set.
 *
 * Both post to `POST /api/v1/publish/events/:id` (`{ event }` /
 * `{ links: [...] }`). A live MapLibre locator mounts into the
 * `data-events-locator` slot (filled by `event-locator-map.ts`); until
 * then the coordinates render as text. Framework-free.
 */

import { t } from '../../../../i18n'
import { publisherSend, handleSessionError } from '../../api'
import { renderMatchBadge, toDisplayScore } from './match-badge'
import { loadPublishedDatasets, filterDatasetsByTitle } from './dataset-search'
import type { PublisherDataset } from '../../types'
import {
  autoPairTargets,
  locatorPoint,
  type EventStatus,
  type LinkStatus,
  type ReviewEvent,
  type ReviewLink,
} from './events-model'

/** Cap on candidate rows shown in the "+ Add dataset" search. */
const ADD_CANDIDATE_ROWS = 20

const EVENTS_ENDPOINT = '/api/v1/publish/events'

export interface EventDetailCallbacks {
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
  /** Fired after the event's own status changes so the orchestrator can
   *  reload the queue (status left the active filter) or update in place. */
  onEventStatusChange: (eventId: string, next: EventStatus) => void
  /** Fired after a per-link / bulk decision mutates `event.links` in place,
   *  so the orchestrator can refresh the queue's "N to review" count. */
  onLinksChanged?: () => void
  /** Mount the live locator into the given slot for the given point.
   *  Injected by the orchestrator so this module needn't import MapLibre. */
  mountLocator?: (slot: HTMLElement, point: { lat: number; lon: number }) => void
}

function el(tag: string, className: string, children: (HTMLElement | string)[] = []): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  for (const c of children) node.append(c)
  return node
}

function statusLabel(status: EventStatus | LinkStatus): string {
  switch (status) {
    case 'proposed': return t('publisher.events.status.proposed')
    case 'approved': return t('publisher.events.status.approved')
    case 'rejected': return t('publisher.events.status.rejected')
    case 'expired': return t('publisher.events.status.expired')
  }
}

function badge(status: EventStatus | LinkStatus): HTMLElement {
  const b = el('span', `publisher-events-badge publisher-events-badge-${status}`)
  b.textContent = statusLabel(status)
  return b
}

function metaField(label: string, value: HTMLElement | string): HTMLElement {
  return el('div', 'publisher-events-meta-field', [
    el('span', 'publisher-events-eyebrow', [label]),
    typeof value === 'string' ? el('span', 'publisher-events-meta-value', [value]) : value,
  ])
}

function handleWriteError(
  res: { ok: false; kind: string; errors?: Array<{ message: string }> },
  status: HTMLElement,
  navigate?: (url: string) => void,
): void {
  if (res.kind === 'session') {
    if (handleSessionError({ navigate }) === 'navigating') return
    status.textContent = t('publisher.events.error.session')
  } else if (res.kind === 'validation' && res.errors && res.errors.length > 0) {
    status.textContent = res.errors[0].message
  } else {
    status.textContent = t('publisher.events.error.generic')
  }
  status.classList.add('publisher-events-status-error')
}

/** One dataset pairing row: name · Match Badge · ✓ / ✕ icon buttons. */
function renderLinkRow(eventId: string, link: ReviewLink, cb: EventDetailCallbacks): HTMLElement {
  const row = el('div', `publisher-events-pairing publisher-events-pairing-${link.status}`)
  const name = el('span', 'publisher-events-pairing-name')
  name.textContent = link.datasetTitle ?? link.datasetId
  name.title = link.datasetTitle ?? link.datasetId

  const badgeEl = renderMatchBadge({
    topic: toDisplayScore(link.signals?.lexical),
    time: toDisplayScore(link.signals?.temporal),
    geo: toDisplayScore(link.signals?.geo),
    composite: toDisplayScore(link.score),
  })

  const rowStatus = el('span', 'publisher-events-pairing-status')
  rowStatus.setAttribute('role', 'status')

  const setPaired = (next: LinkStatus): void => {
    link.status = next
    row.className = `publisher-events-pairing publisher-events-pairing-${next}`
  }

  const iconBtn = (decision: 'approve' | 'reject'): HTMLButtonElement => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `publisher-events-icon-btn publisher-events-icon-btn-${decision}`
    btn.textContent = decision === 'approve' ? '✓' : '✕'
    btn.setAttribute(
      'aria-label',
      t(decision === 'approve' ? 'publisher.events.pairing.approveAria' : 'publisher.events.pairing.rejectAria', {
        title: link.datasetTitle ?? link.datasetId,
      }),
    )
    btn.addEventListener('click', () => {
      rowStatus.textContent = ''
      rowStatus.classList.remove('publisher-events-status-error')
      approveBtn.disabled = true
      rejectBtn.disabled = true
      void publisherSend<unknown>(
        `${EVENTS_ENDPOINT}/${eventId}`,
        { links: [{ datasetId: link.datasetId, decision }] },
        { method: 'POST', fetchFn: cb.fetchFn },
      ).then(res => {
        approveBtn.disabled = false
        rejectBtn.disabled = false
        if (res.ok) {
          setPaired(decision === 'approve' ? 'approved' : 'rejected')
          cb.onLinksChanged?.()
          return
        }
        handleWriteError(res, rowStatus, cb.navigate)
      })
    })
    return btn
  }
  const approveBtn = iconBtn('approve')
  const rejectBtn = iconBtn('reject')

  row.append(
    name,
    badgeEl,
    el('span', 'publisher-events-pairing-actions', [approveBtn, rejectBtn]),
    rowStatus,
  )
  return row
}

/** Build the detail pane for `event`. */
export function renderEventDetail(event: ReviewEvent, cb: EventDetailCallbacks): HTMLElement {
  const pane = el('div', 'publisher-events-detail')

  // --- Header: title + status badge ---
  const badgeEl = badge(event.status)
  pane.append(
    el('div', 'publisher-events-detail-header', [
      el('h3', 'publisher-events-detail-title', [event.title]),
      badgeEl,
    ]),
  )

  // --- Meta strip: source / first observed / detail ---
  const sourceLink = document.createElement('a')
  sourceLink.className = 'publisher-events-source-link'
  sourceLink.href = event.source.url
  sourceLink.target = '_blank'
  sourceLink.rel = 'noopener noreferrer'
  sourceLink.textContent = `${event.source.name} ↗`
  const meta = el('div', 'publisher-events-meta')
  meta.append(metaField(t('publisher.events.source'), sourceLink))
  if (event.source.publishedAt ?? event.occurredStart) {
    meta.append(metaField(t('publisher.events.occurred'), event.occurredStart ?? event.source.publishedAt ?? ''))
  }
  if (event.summary) meta.append(metaField(t('publisher.events.detailLabel'), event.summary))
  pane.append(meta)

  // --- Locator: live map slot, coordinates as text fallback ---
  const point = locatorPoint(event.geometry)
  if (point) {
    const slot = el('div', 'publisher-events-detail-map')
    slot.setAttribute('data-events-locator', '')
    const coords = el('span', 'publisher-events-detail-coords')
    coords.textContent = `${Math.abs(point.lat).toFixed(1)}°${point.lat >= 0 ? 'N' : 'S'}, ${Math.abs(point.lon).toFixed(1)}°${point.lon >= 0 ? 'E' : 'W'}`
    slot.append(coords)
    pane.append(slot)
    if (cb.mountLocator) cb.mountLocator(slot, point)
  }

  // --- Event-level decision (the heavy tier) ---
  const decisionStatus = el('span', 'publisher-events-decision-status')
  decisionStatus.setAttribute('role', 'status')
  const approveEvent = document.createElement('button')
  approveEvent.type = 'button'
  approveEvent.className = 'publisher-btn publisher-btn-primary publisher-events-decision-approve'
  approveEvent.textContent = t('publisher.events.approve')
  const rejectEvent = document.createElement('button')
  rejectEvent.type = 'button'
  rejectEvent.className = 'publisher-btn publisher-btn-danger publisher-events-decision-reject'
  rejectEvent.textContent = t('publisher.events.reject')

  const submitEvent = (decision: 'approve' | 'reject'): void => {
    decisionStatus.textContent = ''
    decisionStatus.classList.remove('publisher-events-status-error')
    approveEvent.disabled = true
    rejectEvent.disabled = true
    void publisherSend<{ event: { status: EventStatus } | null }>(
      `${EVENTS_ENDPOINT}/${event.id}`,
      { event: decision },
      { method: 'POST', fetchFn: cb.fetchFn },
    ).then(res => {
      approveEvent.disabled = false
      rejectEvent.disabled = false
      if (res.ok) {
        const next: EventStatus = res.data.event?.status ?? (decision === 'approve' ? 'approved' : 'rejected')
        event.status = next
        badgeEl.className = `publisher-events-badge publisher-events-badge-${next}`
        badgeEl.textContent = statusLabel(next)
        cb.onEventStatusChange(event.id, next)
        return
      }
      handleWriteError(res, decisionStatus, cb.navigate)
    })
  }
  approveEvent.addEventListener('click', () => submitEvent('approve'))
  rejectEvent.addEventListener('click', () => submitEvent('reject'))

  pane.append(
    el('div', 'publisher-events-decision', [
      el('p', 'publisher-events-decision-prompt', [t('publisher.events.decision.prompt')]),
      el('div', 'publisher-events-decision-actions', [approveEvent, rejectEvent]),
      decisionStatus,
    ]),
  )

  // --- Dataset pairings ---
  const pairings = el('div', 'publisher-events-pairings')
  const head = el('div', 'publisher-events-pairings-head')
  const eyebrow = el('p', 'publisher-events-eyebrow', [t('publisher.events.links') + ` · ${event.links.length}`])
  const updateCount = (): void => {
    eyebrow.textContent = t('publisher.events.links') + ` · ${event.links.length}`
  }
  head.append(eyebrow)
  const headActions = el('div', 'publisher-events-pairings-actions')
  head.append(headActions)

  const bulkStatus = el('span', 'publisher-events-bulk-status')
  bulkStatus.setAttribute('role', 'status')
  const targets = autoPairTargets(event)
  if (targets.length > 0) {
    const bulkBtn = document.createElement('button')
    bulkBtn.type = 'button'
    bulkBtn.className = 'publisher-btn publisher-btn-small publisher-events-bulk-btn'
    bulkBtn.textContent = t('publisher.events.bulkApprove', { count: String(targets.length) })
    bulkBtn.addEventListener('click', () => {
      // Recompute against the live link statuses: a curator may have
      // rejected a ≥90% link since render, and that decision must win.
      const current = autoPairTargets(event)
      if (current.length === 0) {
        bulkBtn.remove()
        return
      }
      bulkBtn.disabled = true
      bulkStatus.textContent = ''
      bulkStatus.classList.remove('publisher-events-status-error')
      void publisherSend<unknown>(
        `${EVENTS_ENDPOINT}/${event.id}`,
        { links: current.map(datasetId => ({ datasetId, decision: 'approve' as const })) },
        { method: 'POST', fetchFn: cb.fetchFn },
      ).then(res => {
        if (res.ok) {
          // Re-render the pairings so each approved row reflects its new state.
          const approved = new Set(current)
          for (const link of event.links) {
            if (approved.has(link.datasetId)) link.status = 'approved'
          }
          rebuildRows()
          bulkBtn.remove()
          bulkStatus.textContent = t('publisher.events.bulkApproved', { count: String(current.length) })
          cb.onLinksChanged?.()
          return
        }
        bulkBtn.disabled = false
        handleWriteError(res, bulkStatus, cb.navigate)
      })
    })
    headActions.append(bulkBtn)
  }

  // "+ Add dataset" — pair a dataset the matcher never suggested. A
  // toggle in the head reveals an inline catalog search; picking a
  // candidate POSTs `addDatasetIds` and appends a fresh proposed row.
  const addBtn = document.createElement('button')
  addBtn.type = 'button'
  addBtn.className = 'publisher-btn publisher-btn-small publisher-events-add-btn'
  addBtn.textContent = t('publisher.events.addDataset')
  addBtn.setAttribute('aria-expanded', 'false')
  headActions.append(addBtn)

  pairings.append(head, bulkStatus)

  const rowsHost = el('div', 'publisher-events-pairings-list')
  const rebuildRows = (): void => {
    rowsHost.replaceChildren()
    if (event.links.length === 0) {
      rowsHost.append(el('p', 'publisher-events-nolinks', [t('publisher.events.noLinks')]))
      return
    }
    for (const link of event.links) rowsHost.append(renderLinkRow(event.id, link, cb))
  }
  rebuildRows()

  // --- Add-dataset inline search panel (lazy, hidden until toggled) ---
  const addPanel = el('div', 'publisher-events-add-panel')
  addPanel.hidden = true
  const addSearch = document.createElement('input')
  addSearch.type = 'search'
  addSearch.className = 'publisher-form-input'
  addSearch.placeholder = t('publisher.events.drawer.searchPlaceholder')
  addSearch.setAttribute('aria-label', t('publisher.events.drawer.searchAria'))
  addSearch.disabled = true
  const addStatus = el('span', 'publisher-events-add-status')
  addStatus.setAttribute('role', 'status')
  const addCandidates = el('div', 'publisher-events-add-candidates')
  addPanel.append(addSearch, addCandidates, addStatus)

  let addDatasets: PublisherDataset[] = []
  let addLoaded = false

  const linkedIds = (): Set<string> => new Set(event.links.map(l => l.datasetId))

  const addOne = (ds: PublisherDataset): void => {
    addStatus.textContent = ''
    addStatus.classList.remove('publisher-events-status-error')
    void publisherSend<unknown>(
      `${EVENTS_ENDPOINT}/${event.id}`,
      { addDatasetIds: [ds.id] },
      { method: 'POST', fetchFn: cb.fetchFn },
    ).then(res => {
      if (res.ok) {
        event.links.push({ datasetId: ds.id, datasetTitle: ds.title, score: null, signals: null, status: 'proposed' })
        rebuildRows()
        updateCount()
        cb.onLinksChanged?.()
        renderAddCandidates()
        return
      }
      handleWriteError(res, addStatus, cb.navigate)
    })
  }

  const renderAddCandidates = (): void => {
    addCandidates.replaceChildren()
    const q = addSearch.value.trim()
    if (q.length === 0) {
      addCandidates.append(el('p', 'publisher-events-add-hint', [t('publisher.events.drawer.searchHint')]))
      return
    }
    const matches = filterDatasetsByTitle(addDatasets, q, linkedIds(), ADD_CANDIDATE_ROWS)
    if (matches.length === 0) {
      addCandidates.append(el('p', 'publisher-events-add-hint', [t('publisher.events.drawer.noResults')]))
      return
    }
    for (const ds of matches) {
      const row = el('div', 'publisher-events-add-candidate')
      const name = el('span', 'publisher-events-add-candidate-name')
      name.textContent = ds.title
      name.title = ds.title
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'publisher-events-icon-btn publisher-events-icon-btn-approve'
      btn.textContent = '+'
      btn.setAttribute('aria-label', t('publisher.events.drawer.addAria', { title: ds.title }))
      btn.addEventListener('click', () => addOne(ds))
      row.append(name, btn)
      addCandidates.append(row)
    }
  }
  addSearch.addEventListener('input', renderAddCandidates)

  addBtn.addEventListener('click', () => {
    const open = addPanel.hidden
    addPanel.hidden = !open
    addBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
    if (!open) return
    renderAddCandidates()
    addSearch.focus()
    if (addLoaded) return
    addLoaded = true
    void loadPublishedDatasets(cb.fetchFn, cb.navigate).then(list => {
      if (list === null) return
      addDatasets = list
      addSearch.disabled = false
      renderAddCandidates()
    })
  })

  pairings.append(addPanel, rowsHost)
  pane.append(pairings)

  return pane
}
