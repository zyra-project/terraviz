/**
 * Direction D — the **"+ New event" slide-in drawer**
 * (`docs/events-tab-handoff/EVENTS_TAB_IMPLEMENTATION_BRIEF.md` §D),
 * opened from the Events tab's top bar. Two panes:
 *
 *   - **Left — compose the event** ("THE EVENT"): the hand-authoring
 *     fields (title, summary, source, occurred window, region, keywords).
 *   - **Right — search & pair datasets** ("PAIR DATASETS"): a substring
 *     search over the node's published datasets (fetched once on open via
 *     `GET /api/v1/publish/datasets?status=published`, so it works without
 *     Vectorize), each candidate toggled into the pairing set.
 *
 * Save posts the compose body **plus `datasetIds`** to
 * `POST /api/v1/publish/events`; the backend seeds those as `proposed`
 * links alongside the matcher's output, so the new event arrives in the
 * detail pane with its pairings ready for per-link approval. Nothing is
 * surfaced until a curator approves — the event lands `proposed`.
 *
 * Framework-free; MapLibre is not used here. The drawer traps focus,
 * closes on Escape / backdrop click, and honours `prefers-reduced-motion`
 * via CSS.
 */

import { t } from '../../../../i18n'
import { publisherGet, publisherSend, handleSessionError, type PublisherApiResult } from '../../api'
import type { ListDatasetsResponse, PublisherDataset } from '../../types'

const EVENTS_ENDPOINT = '/api/v1/publish/events'
const DATASETS_ENDPOINT = '/api/v1/publish/datasets'

/** Cap on candidate rows rendered for a query — keeps the DOM bounded on
 *  a large catalog; the curator narrows with the search box. */
const MAX_CANDIDATE_ROWS = 40
/** Cap on dataset pages fetched into the in-memory pairing index. */
const MAX_DATASET_PAGES = 6

export interface NewEventDrawerOptions {
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
  /** Fired with the created event's id after a successful save so the
   *  orchestrator can reload the queue and select the new event. */
  onCreated: (eventId: string) => void
}

function el(tag: string, className: string, children: (HTMLElement | string)[] = []): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  for (const c of children) node.append(c)
  return node
}

function input(type: string, opts: { required?: boolean; placeholder?: string } = {}): HTMLInputElement {
  const node = document.createElement('input')
  node.type = type
  node.className = 'publisher-form-input'
  if (opts.required) node.required = true
  if (opts.placeholder) node.placeholder = opts.placeholder
  return node
}

function field(labelText: string, control: HTMLElement): HTMLElement {
  return el('label', 'publisher-events-field', [
    el('span', 'publisher-field-label', [labelText]),
    control,
  ])
}

/** Fetch published datasets into a flat `{id,title}` index (paginated,
 *  capped). Returns `null` on a session redirect (the caller bails). */
async function loadPublishedDatasets(
  fetchFn: typeof fetch | undefined,
  navigate: ((url: string) => void) | undefined,
): Promise<PublisherDataset[] | null> {
  const all: PublisherDataset[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_DATASET_PAGES; page++) {
    const listUrl: string = `${DATASETS_ENDPOINT}?status=published${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const res: PublisherApiResult<ListDatasetsResponse> = await publisherGet<ListDatasetsResponse>(listUrl, { fetchFn })
    if (!res.ok) {
      if (res.kind === 'session') handleSessionError({ navigate })
      // A partial list is still useful for pairing; stop on error.
      break
    }
    all.push(...res.data.datasets)
    cursor = res.data.next_cursor
    if (!cursor) break
  }
  return all
}

/**
 * Mount the new-event drawer onto `document.body`. Returns a disposer
 * that removes it (also called internally on close / successful save).
 */
export function openNewEventDrawer(options: NewEventDrawerOptions): () => void {
  const previouslyFocused = document.activeElement as HTMLElement | null

  // --- Compose fields (left) ---
  const titleInput = input('text', { required: true })
  const summaryInput = Object.assign(document.createElement('textarea'), { className: 'publisher-form-textarea', rows: 2 })
  const sourceNameInput = input('text', { required: true })
  const sourceUrlInput = input('url', { required: true, placeholder: 'https://' })
  const startInput = input('text', { placeholder: '2026-06-26T12:00:00Z' })
  const endInput = input('text')
  const regionInput = input('text')
  const keywordsInput = input('text')

  const compose = el('div', 'publisher-events-drawer-compose', [
    el('p', 'publisher-events-eyebrow', [t('publisher.events.drawer.eventEyebrow')]),
    field(t('publisher.events.form.title'), titleInput),
    field(t('publisher.events.form.summary'), summaryInput),
    field(t('publisher.events.form.sourceName'), sourceNameInput),
    field(t('publisher.events.form.sourceUrl'), sourceUrlInput),
    field(t('publisher.events.form.occurredStart'), startInput),
    field(t('publisher.events.form.occurredEnd'), endInput),
    field(t('publisher.events.form.region'), regionInput),
    field(t('publisher.events.form.keywords'), keywordsInput),
  ])

  // --- Pairing (right) ---
  const selected = new Map<string, string>() // datasetId -> title
  let datasets: PublisherDataset[] = []

  const searchInput = input('search', { placeholder: t('publisher.events.drawer.searchPlaceholder') })
  searchInput.setAttribute('aria-label', t('publisher.events.drawer.searchAria'))
  searchInput.disabled = true // enabled once the dataset index loads

  const pairedCount = el('span', 'publisher-events-drawer-paired')
  const candidates = el('div', 'publisher-events-drawer-candidates')

  const updatePairedCount = (): void => {
    pairedCount.textContent = t('publisher.events.drawer.pairedCount', { count: String(selected.size) })
  }

  const candidateRow = (ds: PublisherDataset): HTMLElement => {
    const isSelected = selected.has(ds.id)
    const row = el('div', `publisher-events-drawer-candidate${isSelected ? ' publisher-events-drawer-candidate-on' : ''}`)
    const name = el('span', 'publisher-events-drawer-candidate-name')
    name.textContent = ds.title
    name.title = ds.title
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'publisher-events-icon-btn publisher-events-icon-btn-approve'
    btn.textContent = isSelected ? '✓' : '+'
    btn.setAttribute(
      'aria-label',
      t(isSelected ? 'publisher.events.drawer.removeAria' : 'publisher.events.drawer.addAria', { title: ds.title }),
    )
    btn.addEventListener('click', () => {
      if (selected.has(ds.id)) selected.delete(ds.id)
      else selected.set(ds.id, ds.title)
      updatePairedCount()
      renderCandidates()
    })
    row.append(name, btn)
    return row
  }

  const renderCandidates = (): void => {
    const q = searchInput.value.trim().toLowerCase()
    candidates.replaceChildren()
    if (q.length === 0) {
      // No query: show what's already paired (so it's reviewable/removable).
      if (selected.size === 0) {
        candidates.append(el('p', 'publisher-events-drawer-hint', [t('publisher.events.drawer.searchHint')]))
        return
      }
      for (const [id, title] of selected) {
        candidates.append(candidateRow({ id, title } as PublisherDataset))
      }
      return
    }
    const matches = datasets.filter(d => d.title.toLowerCase().includes(q)).slice(0, MAX_CANDIDATE_ROWS)
    if (matches.length === 0) {
      candidates.append(el('p', 'publisher-events-drawer-hint', [t('publisher.events.drawer.noResults')]))
      return
    }
    for (const ds of matches) candidates.append(candidateRow(ds))
  }
  searchInput.addEventListener('input', renderCandidates)

  const pair = el('div', 'publisher-events-drawer-pair', [
    el('div', 'publisher-events-drawer-pair-head', [
      el('p', 'publisher-events-eyebrow', [t('publisher.events.drawer.pairEyebrow')]),
      pairedCount,
    ]),
    searchInput,
    candidates,
  ])

  // --- Footer: status + actions ---
  const status = el('p', 'publisher-events-drawer-status', [])
  status.setAttribute('role', 'status')
  const saveBtn = Object.assign(document.createElement('button'), {
    type: 'button', className: 'publisher-btn publisher-btn-primary', textContent: t('publisher.events.drawer.save'),
  })
  const cancelBtn = Object.assign(document.createElement('button'), {
    type: 'button', className: 'publisher-btn', textContent: t('publisher.events.form.cancel'),
  })

  // --- Shell ---
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'publisher-events-drawer-close'
  closeBtn.textContent = '✕'
  closeBtn.setAttribute('aria-label', t('publisher.events.drawer.close'))

  const panel = el('div', 'publisher-events-drawer', [
    el('div', 'publisher-events-drawer-header', [
      el('h2', 'publisher-card-heading', [t('publisher.events.drawer.heading')]),
      closeBtn,
    ]),
    el('div', 'publisher-events-drawer-body', [compose, pair]),
    el('div', 'publisher-events-drawer-footer', [status, el('div', 'publisher-events-drawer-actions', [cancelBtn, saveBtn])]),
  ])
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', t('publisher.events.drawer.heading'))

  const backdrop = el('div', 'publisher-events-drawer-backdrop', [panel])

  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    document.removeEventListener('keydown', onKeydown, true)
    backdrop.remove()
    previouslyFocused?.focus?.()
  }

  function onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      dispose()
      return
    }
    if (ev.key !== 'Tab') return
    // Focus trap: keep Tab within the panel's focusable elements.
    const focusables = panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement
    if (ev.shiftKey && active === first) {
      ev.preventDefault()
      last.focus()
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault()
      first.focus()
    }
  }

  backdrop.addEventListener('mousedown', ev => {
    if (ev.target === backdrop) dispose()
  })
  closeBtn.addEventListener('click', dispose)
  cancelBtn.addEventListener('click', dispose)

  saveBtn.addEventListener('click', () => {
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
      datasetIds: [...selected.keys()],
    }
    status.textContent = ''
    status.classList.remove('publisher-events-status-error')
    saveBtn.disabled = true
    void publisherSend<{ event: { id: string } | null }>(EVENTS_ENDPOINT, body, {
      method: 'POST', fetchFn: options.fetchFn,
    }).then(res => {
      saveBtn.disabled = false
      if (res.ok) {
        const newId = res.data.event?.id
        dispose()
        if (newId) options.onCreated(newId)
        return
      }
      if (res.kind === 'session' && handleSessionError({ navigate: options.navigate }) === 'navigating') return
      status.textContent = res.kind === 'validation' && res.errors.length > 0
        ? res.errors[0].message
        : t('publisher.events.form.error')
      status.classList.add('publisher-events-status-error')
    })
  })

  document.addEventListener('keydown', onKeydown, true)
  document.body.append(backdrop)
  updatePairedCount()
  renderCandidates()
  titleInput.focus()

  // Load the pairing index in the background; enable search when ready.
  void loadPublishedDatasets(options.fetchFn, options.navigate).then(list => {
    if (disposed || list === null) return
    datasets = list
    searchInput.disabled = false
    renderCandidates()
  })

  return dispose
}
