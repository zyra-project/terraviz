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

import { fetchFeatures, renderFeatureDisabledCard } from '../features'
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
  /** Fire the best-effort per-lifecycle count probe that fills the
   *  tab labels. Default true; tests that assert exact fetch call
   *  counts set it false to keep the probe out of the way. */
  fetchCounts?: boolean
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
  // Request the server's max page size (200) so a publisher's whole tab
  // loads in one request in the common case — the client-side search
  // box then filters the full set instantly. Catalogs beyond 200 still
  // paginate via the cursor + Load more.
  params.set('limit', '200')
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
  counts?: Partial<Record<DatasetLifecycle, number>> | null,
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
    a.appendChild(document.createTextNode(t(status.labelKey)))
    // Fold the deck's lifecycle counts into the tab labels once the
    // best-effort count probe resolves.
    const n = counts?.[status.value]
    if (typeof n === 'number') {
      const badge = document.createElement('span')
      badge.className = 'publisher-tab-count'
      badge.textContent = String(n)
      a.appendChild(badge)
    }
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
  // Deck layout (no standalone Status column) — the lifecycle badge
  // sits under the title in the Title cell.
  const headerKeys: ReadonlyArray<TableHeaderKey> = [
    'publisher.datasets.col.thumbnail',
    'publisher.datasets.col.title',
    'publisher.datasets.col.slug',
    'publisher.datasets.col.format',
    'publisher.datasets.col.updated',
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
    // Haystack for the client-side search box (title + slug, lowered).
    tr.dataset.search = `${d.title} ${d.slug}`.toLowerCase()

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
    // Title + lifecycle badge stacked (deck layout — the badge lives
    // under the title rather than in a standalone Status column).
    const titleStack = document.createElement('div')
    titleStack.className = 'publisher-cell-title'
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
    titleStack.appendChild(titleLink)

    const status = lifecycleOf(d)
    const statusBadge = document.createElement('span')
    statusBadge.className = 'publisher-badge publisher-badge-status'
    statusBadge.dataset.status =
      status === 'draft' ? 'pending' : status === 'retracted' ? 'suspended' : 'active'
    statusBadge.textContent =
      status === 'draft'
        ? t('publisher.datasets.status.draft')
        : status === 'published'
          ? t('publisher.datasets.status.published')
          : t('publisher.datasets.status.retracted')
    titleStack.appendChild(statusBadge)

    titleCell.appendChild(titleStack)
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

    // Actions: Edit (all rows) + Retract (published) / Delete
    // (drafts & retracted). Live rows must be retracted before they
    // can be deleted, which the API enforces with a 409 regardless
    // of what the UI shows.
    const actionsCell = document.createElement('td')
    actionsCell.className = 'publisher-cell-actions'
    const statusSpan = document.createElement('span')
    statusSpan.className = 'publisher-row-action-status'

    const editHref = `/publish/datasets/${encodeURIComponent(d.id)}/edit`
    const editLink = document.createElement('a')
    editLink.href = editHref
    editLink.className = 'publisher-row-action publisher-row-edit'
    editLink.textContent = t('publisher.datasets.action.edit')
    editLink.setAttribute('aria-label', t('publisher.datasets.action.edit.aria', { title: d.title }))
    if (routerNavigate) {
      editLink.addEventListener('click', event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        routerNavigate(editHref)
      })
    }
    actionsCell.appendChild(editLink)

    if (status === 'published') {
      const retractBtn = document.createElement('button')
      retractBtn.type = 'button'
      retractBtn.className = 'publisher-row-action publisher-row-retract'
      retractBtn.textContent = t('publisher.datasets.action.retract')
      retractBtn.setAttribute('aria-label', t('publisher.datasets.action.retract.aria', { title: d.title }))
      retractBtn.addEventListener('click', () => {
        if (!confirmFn(t('publisher.datasets.retract.confirm', { title: d.title }))) return
        retractBtn.disabled = true
        statusSpan.textContent = ''
        // Clear any error styling from a prior failed attempt so a
        // retry doesn't inherit the red status text.
        statusSpan.classList.remove('publisher-row-action-status-error')
        void publisherSend<{ dataset: unknown }>(
          `/api/v1/publish/datasets/${encodeURIComponent(d.id)}/retract`,
          {},
          { method: 'POST', fetchFn },
        ).then(result => {
          if (!result.ok) {
            retractBtn.disabled = false
            statusSpan.textContent = t('publisher.datasets.retract.failed')
            statusSpan.classList.add('publisher-row-action-status-error')
            return
          }
          // No longer published — drop it from the Published tab.
          tr.remove()
        })
      })
      actionsCell.appendChild(retractBtn)
    } else {
      const deleteBtn = document.createElement('button')
      deleteBtn.type = 'button'
      deleteBtn.className = 'publisher-row-action publisher-row-delete'
      deleteBtn.textContent = t('publisher.datasets.action.delete')
      deleteBtn.setAttribute('aria-label', t('publisher.datasets.action.delete.aria', { title: d.title }))
      deleteBtn.addEventListener('click', () => {
        if (!confirmFn(t('publisher.datasets.delete.confirm', { title: d.title }))) return
        deleteBtn.disabled = true
        statusSpan.textContent = ''
        // Clear any error styling from a prior failed attempt so a
        // retry doesn't inherit the red status text.
        statusSpan.classList.remove('publisher-row-action-status-error')
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
    }
    actionsCell.appendChild(statusSpan)
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
  /** Per-lifecycle totals shown in the tab labels; null until the
   *  best-effort count probe resolves. A status with more rows than the
   *  server max is omitted (count unknowable), so this is partial. */
  counts: Partial<Record<DatasetLifecycle, number>> | null
  /** Client-side search query — filters the loaded rows by title/slug.
   *  Persisted on the state so it survives Load-more / tab re-renders. */
  search: string
}

function renderHeader(routerNavigate: (path: string) => void): HTMLElement {
  const header = document.createElement('header')
  header.className = 'publisher-page-header'

  const titles = document.createElement('div')
  titles.className = 'publisher-page-titles'
  const h1 = document.createElement('h1')
  h1.className = 'publisher-page-title'
  h1.textContent = t('publisher.datasets.title')
  const sub = document.createElement('p')
  sub.className = 'publisher-page-subtitle'
  sub.textContent = t('publisher.datasets.subtitle')
  titles.append(h1, sub)
  header.appendChild(titles)

  const newButton = document.createElement('a')
  newButton.href = '/publish/datasets/new'
  newButton.className = 'publisher-button publisher-button-primary'
  newButton.textContent = t('publisher.datasets.newDraft')
  newButton.addEventListener('click', e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    routerNavigate('/publish/datasets/new')
  })
  header.appendChild(newButton)
  return header
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

  shell.appendChild(renderHeader(options.routerNavigate))
  shell.appendChild(
    renderTabs(
      state.status,
      status => {
        options.routerNavigate(`/publish/datasets?status=${status}`)
      },
      state.counts,
    ),
  )

  if (state.datasets.length === 0) {
    shell.appendChild(renderEmpty(state.status))
    content.replaceChildren(shell)
    return
  }

  // Search box — filters the loaded rows client-side by title/slug so a
  // large tab (150+ datasets) is quick to navigate.
  const searchWrap = document.createElement('div')
  searchWrap.className = 'publisher-datasets-search-wrap'
  const search = document.createElement('input')
  search.type = 'search'
  search.className = 'publisher-datasets-search'
  search.placeholder = t('publisher.datasets.search.placeholder')
  search.setAttribute('aria-label', t('publisher.datasets.search.aria'))
  search.value = state.search
  searchWrap.appendChild(search)
  shell.appendChild(searchWrap)

  const count = renderCount(state.datasets.length)
  shell.appendChild(count)

  const table = renderTable(state.datasets, options.routerNavigate, options.fetchFn, options.confirm)
  shell.appendChild(table)

  const noMatch = document.createElement('p')
  noMatch.className = 'publisher-empty-message publisher-datasets-nomatch'
  noMatch.hidden = true
  shell.appendChild(noMatch)

  // Apply the (persisted) query: hide non-matching rows, update the
  // count, and swap in a no-match message when nothing matches. Runs on
  // every keystroke without re-rendering the shell, so focus is kept.
  const applyFilter = (): void => {
    const q = state.search.trim().toLowerCase()
    const rows = Array.from(table.querySelectorAll<HTMLElement>('tbody tr'))
    let shown = 0
    for (const row of rows) {
      const match = !q || (row.dataset.search ?? '').includes(q)
      row.hidden = !match
      if (match) shown++
    }
    count.textContent = q
      ? t('publisher.datasets.count.filtered', { shown: String(shown), total: String(rows.length) })
      : plural(
          rows.length,
          { one: 'publisher.datasets.count.one', other: 'publisher.datasets.count.other' },
          { count: rows.length },
        )
    const empty = q.length > 0 && shown === 0
    table.hidden = empty
    noMatch.hidden = !empty
    if (empty) noMatch.textContent = t('publisher.datasets.search.noMatch', { query: state.search.trim() })
  }
  search.addEventListener('input', () => {
    state.search = search.value
    applyFilter()
  })
  applyFilter()

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
  if (!(await fetchFeatures()).datasets) {
    renderFeatureDisabledCard(content, 'datasets')
    return
  }
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
    counts: null,
    search: '',
  }
  const shellOptions = {
    confirm: options.confirm,
    fetchFn: options.fetchFn ?? globalThis.fetch,
    sleep: options.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms))),
    navigate:
      options.navigate ??
      ((url: string) => {
        window.location.href = url
      }),
    routerNavigate:
      options.routerNavigate ??
      ((path: string) => {
        window.location.href = path
      }),
  }
  renderListShell(content, state, shellOptions)

  // Best-effort per-lifecycle counts for the tab labels. Fired after
  // the first paint so the list never blocks on them; re-renders the
  // shell in place when they resolve.
  if (options.fetchCounts !== false) {
    void fetchLifecycleCounts(shellOptions.fetchFn).then(counts => {
      if (!counts) return
      state.counts = counts
      renderListShell(content, state, shellOptions)
    })
  }
}

/**
 * Fetch per-lifecycle totals (draft / published / retracted) for the
 * tab labels. Each status is one capped list read whose length is the
 * count — but only when the page wasn't truncated: a `next_cursor`
 * means the status has more rows than the server's 200 max, so the
 * length would undercount. Such a status is omitted (its label stays
 * count-less) rather than shown wrong. Returns null if any read fails.
 */
async function fetchLifecycleCounts(
  fetchFn: typeof fetch,
): Promise<Partial<Record<DatasetLifecycle, number>> | null> {
  const statuses: DatasetLifecycle[] = ['draft', 'published', 'retracted']
  const results = await Promise.all(
    // 200 = the server's max page size (see buildListUrl); asking for
    // more just gets clamped.
    statuses.map(s =>
      publisherGet<ListDatasetsResponse>(`${DATASETS_ENDPOINT}?status=${s}&limit=200`, { fetchFn }),
    ),
  )
  if (results.some(r => !r.ok)) return null
  const counts: Partial<Record<DatasetLifecycle, number>> = {}
  statuses.forEach((s, i) => {
    const r = results[i]
    // Only a full (untruncated) page gives a true count.
    if (r.ok && !r.data.next_cursor) counts[s] = r.data.datasets.length
  })
  return counts
}
