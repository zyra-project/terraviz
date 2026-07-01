/**
 * Direction A — the **left master list** of the Events triage queue
 * (`docs/events-tab-handoff/EVENTS_TAB_IMPLEMENTATION_BRIEF.md` §6 A).
 * One row per event: a status dot, the title (ellipsis on overflow),
 * and a `{source} · {n} datasets to review` sub-line. The selected row
 * is highlighted; clicking a row asks the orchestrator to swap the
 * detail pane. Framework-free.
 */

import { t } from '../../../../i18n'
import { primaryCategory, type ReviewEvent } from './events-model'

export interface EventQueueCallbacks {
  onSelect: (eventId: string) => void
}

function sourceLabel(event: ReviewEvent): string {
  // The source name as the feed label (e.g. "NASA EONET"); a manual
  // event with no feed still carries its cited source name.
  return event.source.name
}

function renderRow(event: ReviewEvent, selected: boolean, cb: EventQueueCallbacks): HTMLElement {
  const dot = document.createElement('span')
  dot.className = `publisher-events-queue-dot publisher-events-queue-dot-${event.status}`
  dot.setAttribute('aria-hidden', 'true')

  const title = document.createElement('span')
  title.className = 'publisher-events-queue-title'
  title.textContent = event.title

  const sub = document.createElement('span')
  sub.className = 'publisher-events-queue-sub'
  // "…datasets to review" counts only the pairings still awaiting a
  // decision, so it shrinks as the curator resolves them.
  const count = event.links.filter(l => l.status === 'proposed').length
  sub.textContent = `${sourceLabel(event)} · ${t('publisher.events.queue.toReview', { count: String(count) })}`

  const row = document.createElement('button')
  row.type = 'button'
  row.className = `publisher-events-queue-row${selected ? ' publisher-events-queue-row-selected' : ''}`
  row.setAttribute('aria-pressed', selected ? 'true' : 'false')
  const cat = primaryCategory(event)
  row.setAttribute(
    'aria-label',
    t('publisher.events.queue.rowAria', {
      title: event.title,
      category: cat ?? t('publisher.events.queue.uncategorized'),
      count: String(count),
    }),
  )
  row.append(dot, el('span', 'publisher-events-queue-text', [title, sub]))
  row.addEventListener('click', () => cb.onSelect(event.id))
  return row
}

function el(tag: string, className: string, children: HTMLElement[]): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  for (const c of children) node.append(c)
  return node
}

/** Build the left queue list for `events`, highlighting `selectedId`.
 *  `eyebrowText` labels the list for the active filter (the queue is
 *  reused across Proposed / Approved / … / All views); it defaults to the
 *  generic "events" label. */
export function renderEventQueue(
  events: readonly ReviewEvent[],
  selectedId: string | null,
  cb: EventQueueCallbacks,
  eyebrowText?: string,
): HTMLElement {
  const nav = document.createElement('nav')
  nav.className = 'publisher-events-queue'
  nav.setAttribute('aria-label', t('publisher.events.queue.aria'))

  const eyebrow = document.createElement('p')
  eyebrow.className = 'publisher-events-eyebrow'
  eyebrow.textContent = eyebrowText ?? t('publisher.events.queue.eyebrow')
  nav.append(eyebrow)

  const list = document.createElement('div')
  list.className = 'publisher-events-queue-list'
  for (const event of events) list.append(renderRow(event, event.id === selectedId, cb))
  nav.append(list)
  return nav
}
