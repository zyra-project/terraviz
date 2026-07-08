/**
 * `/publish/tours` — tour-creator landing page.
 *
 * Phase 3pt/G — fetches the publisher's tours via
 * `GET /api/v1/publish/tours` and renders them in a table
 * mirroring the dataset list. Each row links to the SPA's
 * authoring dock (`/?tourEdit=<id>`). Empty state stays put
 * for fresh publishers + a "New tour" button.
 */

import { t } from '../../../i18n'
import { clearWarmupFlag, handleSessionError } from '../api'
import {
  createDraftTour,
  deleteTour,
  listTours,
  retractTour,
  type TourListItem,
} from '../../tourAuthoring/api'

export interface ToursPageOptions {
  /** Host-supplied navigator. Tests stub this. Defaults to
   *  `window.location.assign` so the SPA-mode entry actually
   *  leaves the publisher portal. */
  navigate?: (url: string) => void
  /** Override the POST /draft API call — tests inject a stub. */
  createDraft?: typeof createDraftTour
  /** Override the GET /publish/tours API call — tests inject a stub. */
  listFn?: typeof listTours
  /** Override the DELETE /publish/tours/{id} API call — tests inject a stub. */
  deleteFn?: typeof deleteTour
  /** Override the POST /publish/tours/{id}/retract API call — tests inject a stub. */
  retractFn?: typeof retractTour
  /** Confirmation hook — defaults to `window.confirm`. Tests
   *  inject a stub that auto-accepts or auto-cancels. */
  confirm?: (message: string) => boolean
}

export async function renderToursPage(
  content: HTMLElement,
  options: ToursPageOptions = {},
): Promise<void> {
  const navigate = options.navigate ?? ((url: string) => {
    window.location.assign(url)
  })
  const createDraft = options.createDraft ?? createDraftTour
  const list = options.listFn ?? listTours
  const del = options.deleteFn ?? deleteTour
  const retract = options.retractFn ?? retractTour
  const confirmFn = options.confirm ?? ((msg: string) => window.confirm(msg))

  // Loading state first so the page doesn't blank-flash.
  content.replaceChildren(buildLoadingShell())

  const result = await list({ limit: 50 })
  if ('error' in result) {
    // Phase 3pt-review/H — mirror the datasets / dataset-detail
    // page pattern: a 401/403 session error either gets the
    // Access warmup redirect (`handleSessionError` returns
    // 'navigating' and we bail without re-rendering) or, when
    // warmup has already been tried, the explicit sign-in card
    // ('show-error'). Other failure kinds skip the helper and
    // render the generic error shell. Copilot
    // discussion_r3291171442 + r3291446477.
    if (result.kind === 'session') {
      if (handleSessionError({ navigate }) === 'navigating') return
      content.replaceChildren(buildErrorShell(result.error))
      return
    }
    content.replaceChildren(buildErrorShell(result.error))
    return
  }
  // Clear the warmup retry flag on first successful list — same
  // signal datasets.ts uses to short-circuit subsequent warmup
  // redirects within the session.
  clearWarmupFlag()

  content.replaceChildren(
    buildShell(result.tours, navigate, createDraft, del, retract, confirmFn),
  )
}

function buildLoadingShell(): HTMLElement {
  const shell = document.createElement('main')
  shell.className = 'publisher-shell'
  const loading = document.createElement('div')
  loading.className = 'publisher-loading'
  loading.textContent = t('publisher.tours.loading')
  shell.appendChild(loading)
  return shell
}

function buildErrorShell(message: string): HTMLElement {
  const shell = document.createElement('main')
  shell.className = 'publisher-shell'
  const card = document.createElement('section')
  card.className = 'publisher-card publisher-glass publisher-empty'
  const p = document.createElement('p')
  p.className = 'publisher-empty-message'
  p.textContent = t('publisher.tours.error', { detail: message })
  card.appendChild(p)
  shell.appendChild(card)
  return shell
}

function buildShell(
  tours: TourListItem[],
  navigate: (url: string) => void,
  createDraft: typeof createDraftTour,
  del: typeof deleteTour,
  retract: typeof retractTour,
  confirmFn: (message: string) => boolean,
): HTMLElement {
  const shell = document.createElement('main')
  shell.className = 'publisher-shell'

  // Page header mirrors the datasets/workflows lists (deck layout):
  // stacked title + subtitle on the start side, a primary action
  // button on the end side.
  const header = document.createElement('header')
  header.className = 'publisher-page-header'

  const titles = document.createElement('div')
  titles.className = 'publisher-page-titles'
  const h1 = document.createElement('h1')
  h1.className = 'publisher-page-title'
  h1.textContent = t('publisher.tours.heading')
  const sub = document.createElement('p')
  sub.className = 'publisher-page-subtitle'
  sub.textContent = t('publisher.tours.intro')
  titles.append(h1, sub)
  header.appendChild(titles)

  const newBtn = document.createElement('button')
  newBtn.type = 'button'
  newBtn.className = 'publisher-button publisher-button-primary publisher-tour-new-btn'
  newBtn.setAttribute('aria-label', t('publisher.tours.new.aria'))
  newBtn.textContent = t('publisher.tours.new')
  newBtn.addEventListener('click', () => {
    newBtn.disabled = true
    newBtn.textContent = t('publisher.tours.new.creating')
    void createDraft().then(result => {
      if ('error' in result) {
        newBtn.disabled = false
        newBtn.textContent = t('publisher.tours.new')
        let err = newBtn.parentElement?.querySelector(
          '.publisher-tour-new-error',
        ) as HTMLElement | null
        if (!err) {
          err = document.createElement('p')
          err.className = 'publisher-tour-new-error'
          newBtn.parentElement?.appendChild(err)
        }
        err.textContent = result.error
        return
      }
      navigate(`/?tourEdit=${encodeURIComponent(result.tour.id)}`)
    })
  })
  header.appendChild(newBtn)
  shell.appendChild(header)

  if (tours.length === 0) {
    const empty = document.createElement('section')
    empty.className = 'publisher-card publisher-glass publisher-empty'
    const emptyTitle = document.createElement('p')
    emptyTitle.className = 'publisher-empty-message'
    emptyTitle.textContent = t('publisher.tours.empty.title')
    empty.appendChild(emptyTitle)
    const emptyHint = document.createElement('p')
    emptyHint.className = 'publisher-tour-empty-hint'
    emptyHint.textContent = t('publisher.tours.empty.hint')
    empty.appendChild(emptyHint)
    shell.appendChild(empty)
    return shell
  }

  const table = buildTable(tours, navigate, del, retract, confirmFn)
  shell.appendChild(buildStatusFilter(tours, table))
  shell.appendChild(table)
  return shell
}

type TourStatus = 'draft' | 'published' | 'retracted'

function statusOf(tour: TourListItem): TourStatus {
  return tour.retracted_at ? 'retracted' : tour.published_at ? 'published' : 'draft'
}

/**
 * Status filter row with per-status counts (All / Draft / Published /
 * Retracted), matching the deck. Filters the already-loaded table's
 * rows in place by their `data-status` — no refetch.
 */
function buildStatusFilter(tours: TourListItem[], table: HTMLElement): HTMLElement {
  const counts: Record<'all' | TourStatus, number> = {
    all: tours.length,
    draft: 0,
    published: 0,
    retracted: 0,
  }
  for (const tour of tours) counts[statusOf(tour)]++

  const bar = document.createElement('div')
  bar.className = 'publisher-tabs publisher-tours-filter'
  bar.setAttribute('role', 'tablist')
  bar.setAttribute('aria-label', t('publisher.tours.filter.aria'))

  const entries: Array<['all' | TourStatus, 'publisher.tours.filter.all' | 'publisher.tours.filter.draft' | 'publisher.tours.filter.published' | 'publisher.tours.filter.retracted']> = [
    ['all', 'publisher.tours.filter.all'],
    ['draft', 'publisher.tours.filter.draft'],
    ['published', 'publisher.tours.filter.published'],
    ['retracted', 'publisher.tours.filter.retracted'],
  ]

  const apply = (value: 'all' | TourStatus): void => {
    for (const row of Array.from(table.querySelectorAll<HTMLElement>('tbody tr'))) {
      row.hidden = value !== 'all' && row.dataset.status !== value
    }
  }

  entries.forEach(([value, labelKey], i) => {
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.className = i === 0 ? 'publisher-tab publisher-tab-active' : 'publisher-tab'
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', i === 0 ? 'true' : 'false')
    tab.append(document.createTextNode(t(labelKey)))
    const badge = document.createElement('span')
    badge.className = 'publisher-tab-count'
    badge.textContent = String(counts[value])
    tab.append(badge)
    tab.addEventListener('click', () => {
      apply(value)
      for (const btn of Array.from(bar.children)) {
        const isThis = btn === tab
        btn.classList.toggle('publisher-tab-active', isThis)
        btn.setAttribute('aria-selected', isThis ? 'true' : 'false')
      }
    })
    bar.append(tab)
  })
  return bar
}

function buildTable(
  tours: TourListItem[],
  navigate: (url: string) => void,
  del: typeof deleteTour,
  retract: typeof retractTour,
  confirmFn: (message: string) => boolean,
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'publisher-table-wrap publisher-glass'
  const table = document.createElement('table')
  table.className = 'publisher-table'

  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  // Deck layout: no standalone Status column — the status badge sits
  // under the title (same fold as the datasets list).
  for (const key of [
    'publisher.tours.col.title',
    'publisher.tours.col.updated',
    'publisher.tours.col.actions',
  ] as const) {
    const th = document.createElement('th')
    // Phase 3pt-review/H — scope="col" so screen readers
    // announce the column header when navigating each row,
    // matching what /publish/datasets does. Copilot
    // discussion_r3291171458.
    th.scope = 'col'
    th.textContent = t(key)
    headRow.appendChild(th)
  }
  thead.appendChild(headRow)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  for (const tour of tours) {
    tbody.appendChild(buildRow(tour, navigate, del, retract, confirmFn))
  }
  table.appendChild(tbody)

  wrap.appendChild(table)
  return wrap
}

function buildRow(
  tour: TourListItem,
  navigate: (url: string) => void,
  del: typeof deleteTour,
  retract: typeof retractTour,
  confirmFn: (message: string) => boolean,
): HTMLElement {
  const tr = document.createElement('tr')

  // Phase 3pt/G follow-up — three-way status. A retracted row
  // keeps `published_at` set (history) and adds `retracted_at`;
  // it should read as "Retracted" in the list so the publisher
  // can tell at a glance that the row is not in the public
  // surface anymore.
  const statusKind: 'retracted' | 'published' | 'draft' = tour.retracted_at
    ? 'retracted'
    : tour.published_at
      ? 'published'
      : 'draft'
  tr.dataset.status = statusKind

  const titleCell = document.createElement('td')
  // Title link + status badge stacked (deck fold — no separate column).
  const titleStack = document.createElement('div')
  titleStack.className = 'publisher-cell-title'
  const titleLink = document.createElement('a')
  titleLink.className = 'publisher-row-link'
  titleLink.href = `/?tourEdit=${encodeURIComponent(tour.id)}`
  titleLink.textContent = tour.title
  titleLink.addEventListener('click', e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(`/?tourEdit=${encodeURIComponent(tour.id)}`)
  })
  titleStack.appendChild(titleLink)
  const badge = document.createElement('span')
  badge.className = `publisher-badge publisher-badge-status publisher-badge-${statusKind}`
  badge.textContent =
    statusKind === 'retracted'
      ? t('publisher.tours.status.retracted')
      : statusKind === 'published'
        ? t('publisher.tours.status.published')
        : t('publisher.tours.status.draft')
  titleStack.appendChild(badge)
  titleCell.appendChild(titleStack)
  tr.appendChild(titleCell)

  const updatedCell = document.createElement('td')
  updatedCell.className = 'publisher-cell-updated'
  updatedCell.textContent = formatDate(tour.updated_at)
  tr.appendChild(updatedCell)

  const actionsCell = document.createElement('td')
  const editLink = document.createElement('a')
  editLink.href = `/?tourEdit=${encodeURIComponent(tour.id)}`
  editLink.className = 'publisher-row-action'
  editLink.textContent = t('publisher.tours.action.edit')
  editLink.addEventListener('click', e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(`/?tourEdit=${encodeURIComponent(tour.id)}`)
  })
  actionsCell.appendChild(editLink)

  // Phase 3pt/G follow-up — Retract button. Only shown for
  // currently-published rows (published_at set, retracted_at
  // null). Re-publishing a retracted row brings it back, so
  // the Publish gesture itself (in the dock) is the inverse
  // — no separate "republish from list" affordance.
  if (tour.published_at && !tour.retracted_at) {
    const retractBtn = document.createElement('button')
    retractBtn.type = 'button'
    retractBtn.className = 'publisher-row-action publisher-row-retract'
    retractBtn.textContent = t('publisher.tours.action.retract')
    retractBtn.setAttribute(
      'aria-label',
      t('publisher.tours.action.retract.aria', { title: tour.title }),
    )
    const retractStatus = document.createElement('span')
    retractStatus.className = 'publisher-row-action-status'
    retractBtn.addEventListener('click', () => {
      const confirmed = confirmFn(
        t('publisher.tours.retract.confirm', { title: tour.title }),
      )
      if (!confirmed) return
      retractBtn.disabled = true
      retractStatus.textContent = ''
      void retract(tour.id).then(result => {
        if ('error' in result) {
          retractBtn.disabled = false
          retractStatus.textContent = result.error
          retractStatus.classList.add('publisher-row-action-status-error')
          return
        }
        // Replace the row in place — re-fetching the whole list
        // for one change is overkill, and the badge + button
        // visibility are the only DOM updates needed. Match the
        // delete-button pattern of inline mutation.
        badge.className = 'publisher-badge publisher-badge-status publisher-badge-retracted'
        badge.textContent = t('publisher.tours.status.retracted')
        retractBtn.remove()
        retractStatus.remove()
      })
    })
    actionsCell.appendChild(retractBtn)
    actionsCell.appendChild(retractStatus)
  }

  // Phase 3pt/G — Delete (×) button. Confirms first; on
  // success removes the row from the DOM rather than re-
  // rendering the whole list. Server-side errors land in an
  // inline status next to the actions.
  //
  // Only offered on rows that are NOT currently published (draft or
  // retracted) — a live row must be retracted before it can be
  // deleted (the API enforces this with a 409), and the deck shows
  // published rows with Edit + Retract only. This also keeps the
  // action set to two buttons so it doesn't wrap.
  if (statusKind !== 'published') {
    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.className = 'publisher-row-action publisher-row-delete'
    deleteBtn.textContent = t('publisher.tours.action.delete')
    deleteBtn.setAttribute(
      'aria-label',
      t('publisher.tours.action.delete.aria', { title: tour.title }),
    )
    const statusSpan = document.createElement('span')
    statusSpan.className = 'publisher-row-action-status'
    deleteBtn.addEventListener('click', () => {
      const confirmed = confirmFn(
        t('publisher.tours.delete.confirm', { title: tour.title }),
      )
      if (!confirmed) return
      deleteBtn.disabled = true
      statusSpan.textContent = ''
      statusSpan.classList.remove('publisher-row-action-status-error')
      void del(tour.id).then(result => {
        if ('error' in result) {
          deleteBtn.disabled = false
          statusSpan.textContent = result.error
          statusSpan.classList.add('publisher-row-action-status-error')
          return
        }
        tr.remove()
      })
    })
    actionsCell.appendChild(deleteBtn)
    actionsCell.appendChild(statusSpan)
  }
  tr.appendChild(actionsCell)

  return tr
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}
