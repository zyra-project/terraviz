/**
 * /publish/datasets — list of datasets visible to the caller.
 *
 * Read-only in 3pb. Three tabs filter by lifecycle (Drafts /
 * Published / Retracted), driven by a `?status=` query param so
 * the current tab is bookmarkable. A "Load more" button at the
 * bottom paginates via the server's cursor (the list endpoint
 * returns `next_cursor: string | null`; clicking the button
 * appends the next page in place).
 *
 * Empty states are tab-specific. Server errors / session errors
 * route through the shared `publisherGet` helper so the page
 * inherits the portal-wide auth handling without reimplementing
 * it (see `../api.ts` and the 3pb/A commit).
 */

import { t } from '../../../i18n'
import { plural } from '../../../i18n'
import { clearWarmupFlag, handleSessionError, publisherGet, publisherSend,
} from '../api'
import { buildErrorCard, type ErrorCardDetails } from '../components/error-card'
import type {
  DatasetLifecycle,
  ListDatasetsResponse,
  PublisherDataset,
} from '../types'
import { lifecycleOf } from '../types'

export interface DatasetsPageOptions {
  fetchFn?: typeof fetch
  /** Confirmation hook — defaults to `window.confirm`. Tests
   *  inject a stub (the tours-list convention). */
  confirm?: (message: string) => boolean
  sleep?: (ms: number) => Promise<void>
  navigate?: (url: string) => void
  /** History-API router-navigate fn the page uses to switch
   *  status tabs without a full page reload. Optional — when
   *  absent the tab anchors fall through to the browser's
   *  default navigation. Tests can stub it. */
  routerNavigate?: (path: string) => void
}

const DATASETS_ENDPOINT = '/api/v1/publish/datasets'
const STATUSES: ReadonlyArray<{ value: DatasetLifecycle; labelKey: TabLabelKey }> = [
  { value: 'draft', labelKey: 'publisher.datasets.tab.drafts' },
  { value: 'published', labelKey: 'publisher.datasets.tab.published' },
  { value: 'retracted', labelKey: 'publisher.datasets.tab.retracted' },
]

type TabLabelKey =
  | 'publisher.datasets.tab.drafts'
  | 'publisher.datasets.tab.published'
  | 'publisher.datasets.tab.retracted'

/** Read the `?status=` query param from the current URL and
 *  default to 'draft' on missing / invalid values. */
function currentStatus(): DatasetLifecycle {
  const raw = new URLSearchParams(window.location.search).get('status')
  if (raw === 'draft' || raw === 'published' || raw === 'retracted') return raw
  return 'draft'
}

function buildListUrl(status: DatasetLifecycle, cursor: string | null): string {
  const params = new URLSearchParams({ status })
  if (cursor) params.set('cursor', cursor)
  return `${DATASETS_ENDPOINT}?${params.toString()}`
}

function renderLoading(content: HTMLElement): void {
  const shell = document.createElement('main')
  shell.className = 'publisher-shell'
  shell.setAttribute('aria-busy', 'true')
  const status = document.createElement('p')
  status.className = 'publisher-loading'
  status.setAttribute('role', 'status')
  status.textContent = t('publisher.datasets.loading')
  shell.appendChild(status)
  content.replaceChildren(shell)
}

function renderError(
  content: HTMLElement,
  kind: 'session' | 'server' | 'network',
  details: ErrorCardDetails = {},
): void {
  const shell = document.createElement('main')
  shell.className = 'publisher-shell'
  shell.appendChild(buildErrorCard(kind, details))
  content.replaceChildren(shell)
}

function renderTabs(
  active: DatasetLifecycle,
  onSelect: (status: DatasetLifecycle) => void,
): HTMLElement {
  const tablist = document.createElement('div')
  tablist.className = 'publisher-tabs'
  tablist.setAttribute('role', 'tablist')
  tablist.setAttribute('aria-label', t('publisher.datasets.tabs.aria'))

  for (const status of STATUSES) {
    const a = document.createElement('a')
    a.href = `/publish/datasets?status=${status.value}`
    a.className = 'publisher-tab'
    a.setAttribute('role', 'tab')
    a.setAttribute('aria-selected', status.value === active ? 'true' : 'false')
    if (status.value === active) a.classList.add('publisher-tab-active')
    a.textContent = t(status.labelKey)
    a.addEventListener('click', e => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      e.preventDefault()
      onSelect(status.value)
    })
    tablist.appendChild(a)
  }
  return tablist
}

function renderEmpty(status: DatasetLifecycle): HTMLElement {
  const card = document.createElement('section')
  card.className = 'publisher-card publisher-glass publisher-empty'
  const msg = document.createElement('p')
  msg.className = 'publisher-empty-message'
  msg.textContent =
    status === 'draft'
      ? t('publisher.datasets.empty.drafts')
      : status === 'published'
        ? t('publisher.datasets.empty.published')
        : t('publisher.datasets.empty.retracted')
  card.appendChild(msg)
  return card
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

function renderTable(
  datasets: PublisherDataset[],
  routerNavigate: ((path: string) => void) | undefined,
  fetchFn?: typeof fetch,
  confirmFn: (message: string) => boolean = message => window.confirm(message),
): HTMLElement {
  const tableWrap = document.createElement('div')
  tableWrap.className = 'publisher-table-wrap publisher-glass'

  const table = document.createElement('table')
  table.className = 'publisher-table'

  const thead = document.createElement('thead')
  const headerRow = document.createElement('tr')
  const headerKeys: ReadonlyArray<TableHeaderKey> = [
    'publisher.datasets.col.thumbnail',
    'publisher.datasets.col.title',
    'publisher.datasets.col.slug',
    'publisher.datasets.col.format',
    'publisher.datasets.col.updated',
    'publisher.datasets.col.status',
    'publisher.datasets.col.actions',
  ]
  for (const key of headerKeys) {
    const th = document.createElement('th')
    th.scope = 'col'
    th.textContent = t(key)
    headerRow.appendChild(th)
  }
  thead.appendChild(headerRow)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  for (const d of datasets) {
    const tr = document.createElement('tr')

    // Thumbnail cell — a small preview when the row has a resolved
    // thumbnail, empty otherwise.
    const thumbCell = document.createElement('td')
    thumbCell.className = 'publisher-cell-thumb'
    if (d.thumbnail_url) {
      const img = document.createElement('img')
      img.className = 'publisher-table-thumb'
      img.src = d.thumbnail_url
      img.alt = '' // decorative — the title is in the adjacent cell
      img.loading = 'lazy'
      thumbCell.appendChild(img)
    }
    tr.appendChild(thumbCell)

    const titleCell = document.createElement('td')
    const titleLink = document.createElement('a')
    const detailHref = `/publish/datasets/${encodeURIComponent(d.id)}`
    titleLink.href = detailHref
    titleLink.className = 'publisher-row-link'
    titleLink.textContent = d.title
    if (routerNavigate) {
      // Plain left-click → SPA navigation through the portal
      // router (skips the lazy-chunk reload). Modifier-click and
      // middle-click fall through so cmd-click still opens a new
      // tab. Same pattern the Edit button on the detail page uses.
      titleLink.addEventListener('click', event => {
        if (
          event.button === 0 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault()
          routerNavigate(detailHref)
        }
      })
    }
    titleCell.appendChild(titleLink)
    tr.appendChild(titleCell)

    const slugCell = document.createElement('td')
    slugCell.className = 'publisher-cell-slug'
    slugCell.textContent = d.slug
    tr.appendChild(slugCell)

    const formatCell = document.createElement('td')
    formatCell.className = 'publisher-cell-format'
    formatCell.textContent = d.format
    tr.appendChild(formatCell)

    const updatedCell = document.createElement('td')
    updatedCell.className = 'publisher-cell-updated'
    updatedCell.textContent = formatDate(d.updated_at)
    tr.appendChild(updatedCell)

    const statusCell = document.createElement('td')
    const status = lifecycleOf(d)
    const statusBadge = document.createElement('span')
    statusBadge.className = 'publisher-badge publisher-badge-status'
    statusBadge.dataset.status = status === 'draft' ? 'pending' : status === 'retracted' ? 'suspended' : 'active'
    statusBadge.textContent =
      status === 'draft'
        ? t('publisher.datasets.status.draft')
        : status === 'published'
          ? t('publisher.datasets.status.published')
          : t('publisher.datasets.status.retracted')
    statusCell.appendChild(statusBadge)
    tr.appendChild(statusCell)

    // Delete (×) — non-published rows only (mirrors the tours-list
    // delete; live rows must be retracted first, which the API
    // enforces with a 409 regardless of what the UI shows).
    const actionsCell = document.createElement('td')
    if (status !== 'published') {
      const deleteBtn = document.createElement('button')
      deleteBtn.type = 'button'
      deleteBtn.className = 'publisher-row-action publisher-row-delete'
      deleteBtn.textContent = t('publisher.datasets.action.delete')
      deleteBtn.setAttribute(
        'aria-label',
        t('publisher.datasets.action.delete.aria', { title: d.title }),
      )
      const statusSpan = document.createElement('span')
      statusSpan.className = 'publisher-row-action-status'
      deleteBtn.addEventListener('click', () => {
        if (!confirmFn(t('publisher.datasets.delete.confirm', { title: d.title }))) return
        deleteBtn.disabled = true
        statusSpan.textContent = ''
        void publisherSend<{ deleted_id: string }>(
          `/api/v1/publish/datasets/${encodeURIComponent(d.id)}`,
          undefined,
          { method: 'DELETE', fetchFn },
        ).then(result => {
          if (!result.ok) {
            deleteBtn.disabled = false
            statusSpan.textContent = t('publisher.datasets.delete.failed')
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

    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  tableWrap.appendChild(table)
  return tableWrap
}

type TableHeaderKey =
  | 'publisher.datasets.col.thumbnail'
  | 'publisher.datasets.col.title'
  | 'publisher.datasets.col.slug'
  | 'publisher.datasets.col.format'
  | 'publisher.datasets.col.updated'
  | 'publisher.datasets.col.status'
  | 'publisher.datasets.col.actions'

function renderCount(n: number): HTMLElement {
  const el = document.createElement('p')
  el.className = 'publisher-list-count'
  el.setAttribute('aria-live', 'polite')
  el.textContent = plural(
    n,
    {
      one: 'publisher.datasets.count.one',
      other: 'publisher.datasets.count.other',
    },
    { count: n },
  )
  return el
}

function renderLoadMoreButton(
  onClick: () => void | Promise<void>,
  isLoading: boolean,
): HTMLElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'publisher-button publisher-load-more'
  btn.textContent = isLoading
    ? t('publisher.datasets.loadingMore')
    : t('publisher.datasets.loadMore')
  btn.disabled = isLoading
  btn.addEventListener('click', () => {
    void onClick()
  })
  return btn
}

/** Shared page state — tracks the currently-displayed datasets,
 *  the next cursor, and whether a Load-more fetch is in flight. */
interface PageState {
  status: DatasetLifecycle
  datasets: PublisherDataset[]
  nextCursor: string | null
  isLoadingMore: boolean
}

function renderActionBar(
  routerNavigate: (path: string) => void,
): HTMLElement {
  const bar = document.createElement('div')
  bar.className = 'publisher-list-actions'

  const newButton = document.createElement('a')
  newButton.href = '/publish/datasets/new'
  newButton.className = 'publisher-button publisher-button-primary'
  newButton.textContent = t('publisher.datasets.newDraft')
  newButton.addEventListener('click', e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    routerNavigate('/publish/datasets/new')
  })
  bar.appendChild(newButton)
  return bar
}

function renderListShell(
  content: HTMLElement,
  state: PageState,
  options: Required<Pick<DatasetsPageOptions, 'fetchFn' | 'sleep' | 'navigate'>> & {
    confirm?: (message: string) => boolean
    routerNavigate: (path: string) => void
  },
): void {
  const shell = document.createElement('main')
  shell.className = 'publisher-shell'

  shell.appendChild(renderActionBar(options.routerNavigate))
  shell.appendChild(
    renderTabs(state.status, status => {
      options.routerNavigate(`/publish/datasets?status=${status}`)
    }),
  )

  if (state.datasets.length === 0) {
    shell.appendChild(renderEmpty(state.status))
    content.replaceChildren(shell)
    return
  }

  shell.appendChild(renderCount(state.datasets.length))
  shell.appendChild(renderTable(state.datasets, options.routerNavigate, options.fetchFn, options.confirm))

  if (state.nextCursor) {
    shell.appendChild(
      renderLoadMoreButton(async () => {
        state.isLoadingMore = true
        renderListShell(content, state, options)
        const result = await publisherGet<ListDatasetsResponse>(
          buildListUrl(state.status, state.nextCursor),
          { fetchFn: options.fetchFn, sleep: options.sleep },
        )
        state.isLoadingMore = false
        if (result.ok) {
          state.datasets = state.datasets.concat(result.data.datasets)
          state.nextCursor = result.data.next_cursor
          renderListShell(content, state, options)
        } else if (result.kind === 'session') {
          if (handleSessionError({ navigate: options.navigate }) === 'show-error') {
            renderError(content, 'session')
          }
        } else if (result.kind === 'server') {
          renderError(content, 'server', {
            status: result.status,
            body: result.body,
          })
        } else if (result.kind === 'not_found') {
          // not_found can't happen on /api/v1/publish/datasets;
          // collapse to network so the user gets a Refresh option.
          renderError(content, 'network')
        } else {
          renderError(content, result.kind)
        }
      }, state.isLoadingMore),
    )
  }

  content.replaceChildren(shell)
}

/**
 * Boot the /publish/datasets page. Loads the first page for the
 * current `?status=` filter, swaps in the table or empty/error
 * state, and wires the Load more button to paginate via the
 * server's cursor.
 */
export async function renderDatasetsPage(
  content: HTMLElement,
  options: DatasetsPageOptions = {},
): Promise<void> {
  const status = currentStatus()
  renderLoading(content)

  const result = await publisherGet<ListDatasetsResponse>(buildListUrl(status, null), {
    fetchFn: options.fetchFn,
    sleep: options.sleep,
  })
  if (!result.ok) {
    if (result.kind === 'session') {
      if (handleSessionError({ navigate: options.navigate }) === 'show-error') {
        renderError(content, 'session')
      }
      return
    }
    if (result.kind === 'server') {
      renderError(content, 'server', { status: result.status, body: result.body })
      return
    }
    // not_found can't happen on /api/v1/publish/datasets; collapse
    // to network so the user gets a Refresh option.
    renderError(content, result.kind === 'not_found' ? 'network' : result.kind)
    return
  }
  clearWarmupFlag()

  const state: PageState = {
    status,
    datasets: result.data.datasets,
    nextCursor: result.data.next_cursor,
    isLoadingMore: false,
  }
  renderListShell(content, state, {
    confirm: options.confirm,
    fetchFn: options.fetchFn ?? globalThis.fetch,
    sleep: options.sleep ?? (ms => new Promise(r => setTimeout(r, ms))),
    navigate: options.navigate ?? (url => {
      window.location.href = url
    }),
    routerNavigate: options.routerNavigate ?? (path => {
      window.location.href = path
    }),
  })
}
