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

  content.replaceChildren(buildShell(result.tours, navigate, createDraft, del, confirmFn))
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
  confirmFn: (message: string) => boolean,
): HTMLElement {
  const shell = document.createElement('main')
  shell.className = 'publisher-shell'

  const header = document.createElement('div')
  header.className = 'publisher-tour-list-header'

  const h2 = document.createElement('h2')
  h2.textContent = t('publisher.tours.heading')
  header.appendChild(h2)

  const newBtn = document.createElement('button')
  newBtn.type = 'button'
  newBtn.className = 'publisher-tab publisher-tab-active publisher-tour-new-btn'
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

  const intro = document.createElement('p')
  intro.className = 'publisher-tour-intro'
  intro.textContent = t('publisher.tours.intro')
  shell.appendChild(intro)

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

  shell.appendChild(buildTable(tours, navigate, del, confirmFn))
  return shell
}

function buildTable(
  tours: TourListItem[],
  navigate: (url: string) => void,
  del: typeof deleteTour,
  confirmFn: (message: string) => boolean,
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'publisher-table-wrap publisher-glass'
  const table = document.createElement('table')
  table.className = 'publisher-table'

  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const key of [
    'publisher.tours.col.title',
    'publisher.tours.col.status',
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
    tbody.appendChild(buildRow(tour, navigate, del, confirmFn))
  }
  table.appendChild(tbody)

  wrap.appendChild(table)
  return wrap
}

function buildRow(
  tour: TourListItem,
  navigate: (url: string) => void,
  del: typeof deleteTour,
  confirmFn: (message: string) => boolean,
): HTMLElement {
  const tr = document.createElement('tr')

  const titleCell = document.createElement('td')
  const titleLink = document.createElement('a')
  titleLink.className = 'publisher-row-link'
  titleLink.href = `/?tourEdit=${encodeURIComponent(tour.id)}`
  titleLink.textContent = tour.title
  titleLink.addEventListener('click', e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(`/?tourEdit=${encodeURIComponent(tour.id)}`)
  })
  titleCell.appendChild(titleLink)
  tr.appendChild(titleCell)

  const statusCell = document.createElement('td')
  const badge = document.createElement('span')
  badge.className = `publisher-badge publisher-badge-status publisher-badge-${tour.published_at ? 'published' : 'draft'}`
  badge.textContent = t(
    tour.published_at ? 'publisher.tours.status.published' : 'publisher.tours.status.draft',
  )
  statusCell.appendChild(badge)
  tr.appendChild(statusCell)

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

  // Phase 3pt/G — Delete (×) button. Confirms first; on
  // success removes the row from the DOM rather than re-
  // rendering the whole list. Server-side errors land in an
  // inline status next to the actions.
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
