/**
 * /publish/import — bring many datasets into the catalog at once.
 *
 * The server-side bulk-import endpoint is still on the roadmap (see
 * `docs/CATALOG_PUBLISHING_TOOLS.md` — bulk import was deferred), so
 * this page is honest about that: the manifest parsing, per-row
 * validation, and the ready/warning/error preview all run
 * client-side and work today, while the final "Import as drafts"
 * submit is disabled with a note until the endpoint lands. The
 * Remote-node and CLI methods are informational for the same reason
 * (federation is Phase 4; the CLI is a separate tool).
 *
 * DOM is built with createElement + textContent — never innerHTML —
 * so manifest values (titles, slugs) can't carry markup into the
 * page.
 */

import { fetchFeatures, renderFeatureDisabledCard } from '../features'
import { t, type MessageKey } from '../../../i18n'
import { downloadCsv } from '../analytics-charts'

export interface ImportPageOptions {
  /** Injectable so the copy-to-clipboard button is testable. */
  clipboard?: { writeText: (s: string) => Promise<void> }
}

const MAX_ROWS = 500
const CLI_COMMAND = 'terraviz import ./datasets.csv --as-drafts'

type Visibility = 'public' | 'federated' | 'restricted' | 'private'
type RowStatus = 'ready' | 'warning' | 'error'

export interface ValidatedRow {
  title: string
  slug: string
  format: string
  status: RowStatus
  /** Human-readable first issue, if any. */
  message: string
}

// --- Manifest parsing (pure, exported for tests) ------------------

/**
 * Minimal RFC-4180 CSV parser → array of record objects keyed by the
 * (lower-cased, trimmed) header row. Handles quoted fields, escaped
 * quotes (`""`), and CRLF/LF line endings. Not a general CSV library
 * — just enough for a flat one-row-per-dataset manifest.
 */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }
    if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      // Skip blank lines.
      if (row.some(v => v.trim() !== '')) rows.push(row)
      row = []
    } else {
      field += c
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (row.some(v => v.trim() !== '')) rows.push(row)
  }
  if (rows.length === 0) return []
  const headers = rows[0].map(h => h.trim().toLowerCase())
  return rows.slice(1).map(cells => {
    const rec: Record<string, string> = {}
    headers.forEach((h, idx) => {
      rec[h] = (cells[idx] ?? '').trim()
    })
    return rec
  })
}

export interface ParsedManifest {
  records: Array<Record<string, string>>
  /** i18n key for a parse-level failure, if any. */
  errorKey?:
    | 'publisher.import.parse.empty'
    | 'publisher.import.parse.badJson'
    | 'publisher.import.parse.unknownCols'
}

/** Parse a manifest as JSON (array, or `{ datasets: [...] }`) or CSV. */
export function parseManifest(text: string): ParsedManifest {
  const trimmed = text.trim()
  if (trimmed === '') return { records: [], errorKey: 'publisher.import.parse.empty' }

  let records: Array<Record<string, string>>
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const arr = Array.isArray(parsed)
        ? parsed
        : (parsed as { datasets?: unknown }).datasets
      if (!Array.isArray(arr)) return { records: [], errorKey: 'publisher.import.parse.badJson' }
      records = arr.map(item => {
        const rec: Record<string, string> = {}
        if (item && typeof item === 'object') {
          for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
            rec[k.trim().toLowerCase()] = v == null ? '' : String(v).trim()
          }
        }
        return rec
      })
    } catch {
      return { records: [], errorKey: 'publisher.import.parse.badJson' }
    }
  } else {
    records = parseCsv(text)
  }

  if (records.length === 0) return { records: [], errorKey: 'publisher.import.parse.empty' }
  // A manifest with no title-ish column anywhere is unusable.
  if (!records.some(r => pick(r, ['title', 'name']) !== '')) {
    return { records: [], errorKey: 'publisher.import.parse.unknownCols' }
  }
  return { records }
}

/** First non-empty value among candidate keys (already lower-cased). */
function pick(rec: Record<string, string>, keys: string[]): string {
  for (const k of keys) {
    const v = rec[k]
    if (v != null && v.trim() !== '') return v.trim()
  }
  return ''
}

/** Lowercase, hyphenate, collapse — the slug the server would derive. */
export function deriveSlug(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Normalize a manifest format token to a short display format, or
 *  '' when unrecognized. */
export function normalizeFormat(raw: string): string {
  const v = raw.trim().toLowerCase()
  if (['mp4', 'video/mp4', 'video'].includes(v)) return 'mp4'
  if (['png', 'image/png'].includes(v)) return 'png'
  if (['jpeg', 'jpg', 'image/jpeg', 'image/jpg'].includes(v)) return 'jpeg'
  if (['webp', 'image/webp'].includes(v)) return 'webp'
  if (['tour', 'sos', 'sos json', 'tour (sos json)', 'application/json'].includes(v)) return 'tour'
  return ''
}

/**
 * Validate the parsed records into preview rows. Only structurally-
 * checkable rules run client-side (missing title / format / license /
 * data reference, bad slug, row cap) — reachability of a data
 * reference is a server concern and is deliberately not faked here.
 */
export function validateRows(records: Array<Record<string, string>>): ValidatedRow[] {
  return records.map((rec, idx) => {
    const title = pick(rec, ['title', 'name'])
    const rawFormat = pick(rec, ['format', 'media_type', 'mime', 'type'])
    const format = normalizeFormat(rawFormat)
    const rawSlug = pick(rec, ['slug'])
    const slug = rawSlug || deriveSlug(title)
    const dataRef = pick(rec, ['data_ref', 'dataref', 'data reference', 'url', 'href', 'vimeo_id', 'r2_path'])
    const license = pick(rec, ['license', 'license_spdx', 'spdx', 'license statement'])

    const errors: string[] = []
    const warnings: string[] = []

    if (idx >= MAX_ROWS) errors.push(t('publisher.import.issue.tooMany', { max: MAX_ROWS }))
    if (title === '') errors.push(t('publisher.import.issue.noTitle'))
    if (format === '') errors.push(t('publisher.import.issue.noFormat'))
    if (slug !== '' && !/^[a-z0-9-]+$/.test(slug)) warnings.push(t('publisher.import.issue.badSlug'))
    if (dataRef === '') warnings.push(t('publisher.import.issue.noDataRef'))
    if (license === '') warnings.push(t('publisher.import.issue.noLicense'))

    const status: RowStatus = errors.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'ready'
    const message = [...errors, ...warnings][0] ?? ''
    return { title: title || '—', slug: slug || '—', format: format || rawFormat || '—', status, message }
  })
}

export function countByStatus(rows: ValidatedRow[]): Record<RowStatus, number> {
  return rows.reduce(
    (acc, r) => {
      acc[r.status]++
      return acc
    },
    { ready: 0, warning: 0, error: 0 } as Record<RowStatus, number>,
  )
}

// --- Small DOM helpers --------------------------------------------

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

// --- Rendering ----------------------------------------------------

interface PageState {
  method: 'manifest' | 'remote' | 'cli'
  rows: ValidatedRow[] | null
  parseErrorKey: ParsedManifest['errorKey']
  fileName: string
}

function methodCard(
  state: PageState,
  method: PageState['method'],
  titleKey: MessageKey,
  descKey: MessageKey,
  onSelect: () => void,
): HTMLElement {
  const card = el('button', 'publisher-import-method')
  ;(card as HTMLButtonElement).type = 'button'
  if (state.method === method) card.classList.add('publisher-import-method-active')
  card.setAttribute('aria-pressed', state.method === method ? 'true' : 'false')
  card.appendChild(el('span', 'publisher-import-method-title', t(titleKey)))
  card.appendChild(el('span', 'publisher-import-method-desc', t(descKey)))
  card.addEventListener('click', onSelect)
  return card
}

function renderPreview(rows: ValidatedRow[]): HTMLElement {
  const wrap = el('section', 'publisher-import-preview')
  const counts = countByStatus(rows)

  const head = el('div', 'publisher-import-preview-head')
  head.appendChild(el('span', 'publisher-import-preview-heading', t('publisher.import.preview.heading')))
  const tally = el('div', 'publisher-import-tally')
  const chip = (status: RowStatus, key: MessageKey, n: number): HTMLElement => {
    const c = el('span', `publisher-import-chip publisher-import-chip-${status}`)
    c.appendChild(el('span', 'publisher-import-chip-dot'))
    c.appendChild(el('span', undefined, t(key, { count: n })))
    return c
  }
  tally.appendChild(chip('ready', 'publisher.import.preview.ready', counts.ready))
  tally.appendChild(chip('warning', 'publisher.import.preview.warning', counts.warning))
  tally.appendChild(chip('error', 'publisher.import.preview.error', counts.error))
  head.appendChild(tally)
  wrap.appendChild(head)

  const table = el('table', 'publisher-table publisher-import-table')
  const thead = el('thead')
  const trh = el('tr')
  const cols: MessageKey[] = [
    'publisher.import.col.title',
    'publisher.import.col.slug',
    'publisher.import.col.format',
    'publisher.import.col.status',
  ]
  for (const key of cols) {
    trh.appendChild(el('th', undefined, t(key)))
  }
  thead.appendChild(trh)
  table.appendChild(thead)

  const tbody = el('tbody')
  for (const r of rows) {
    const tr = el('tr')
    const titleCell = el('td')
    titleCell.appendChild(el('div', 'publisher-import-cell-title', r.title))
    if (r.message) titleCell.appendChild(el('div', 'publisher-import-cell-note', r.message))
    tr.appendChild(titleCell)
    tr.appendChild(el('td', 'publisher-import-cell-mono', r.slug))
    tr.appendChild(el('td', 'publisher-import-cell-mono', r.format))
    const statusCell = el('td')
    const statusKey: Record<RowStatus, MessageKey> = {
      ready: 'publisher.import.status.ready',
      warning: 'publisher.import.status.warning',
      error: 'publisher.import.status.error',
    }
    const badge = el(
      'span',
      `publisher-badge publisher-import-status publisher-import-status-${r.status}`,
      t(statusKey[r.status]),
    )
    statusCell.appendChild(badge)
    tr.appendChild(statusCell)
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)

  const scroll = el('div', 'publisher-import-table-scroll')
  scroll.appendChild(table)
  wrap.appendChild(scroll)
  return wrap
}

function renderControls(rows: ValidatedRow[]): HTMLElement {
  const controls = el('div', 'publisher-import-controls')

  const visField = el('div', 'publisher-import-field')
  const visLabel = el('label', 'publisher-import-field-label', t('publisher.import.defaultVisibility.label'))
  const visSelect = document.createElement('select')
  visSelect.className = 'publisher-form-input'
  const visLabels: Record<Visibility, MessageKey> = {
    public: 'publisher.import.visibility.public',
    federated: 'publisher.import.visibility.federated',
    restricted: 'publisher.import.visibility.restricted',
    private: 'publisher.import.visibility.private',
  }
  for (const v of ['public', 'federated', 'restricted', 'private'] as Visibility[]) {
    const opt = document.createElement('option')
    opt.value = v
    opt.textContent = t(visLabels[v])
    visSelect.appendChild(opt)
  }
  const visId = 'publisher-import-visibility'
  visSelect.id = visId
  visLabel.setAttribute('for', visId)
  visField.appendChild(visLabel)
  visField.appendChild(visSelect)
  visField.appendChild(el('p', 'publisher-import-field-hint', t('publisher.import.defaultVisibility.hint')))
  controls.appendChild(visField)

  const wfField = el('div', 'publisher-import-field')
  const wfLabel = el('label', 'publisher-import-field-label', t('publisher.import.attachWorkflow.label'))
  const wfSelect = document.createElement('select')
  wfSelect.className = 'publisher-form-input'
  const noneOpt = document.createElement('option')
  noneOpt.value = ''
  noneOpt.textContent = t('publisher.import.attachWorkflow.none')
  wfSelect.appendChild(noneOpt)
  const wfId = 'publisher-import-workflow'
  wfSelect.id = wfId
  wfLabel.setAttribute('for', wfId)
  wfField.appendChild(wfLabel)
  wfField.appendChild(wfSelect)
  wfField.appendChild(el('p', 'publisher-import-field-hint', t('publisher.import.attachWorkflow.hint')))
  controls.appendChild(wfField)

  // Submit — disabled until the bulk-import endpoint exists.
  const importable = rows.filter(r => r.status !== 'error').length
  const submit = el(
    'button',
    'publisher-button publisher-button-primary publisher-import-submit',
    importable > 0
      ? t('publisher.import.submit', { count: importable })
      : t('publisher.import.submit.zero'),
  ) as HTMLButtonElement
  submit.type = 'button'
  submit.disabled = true

  const submitWrap = el('div', 'publisher-import-submit-wrap')
  submitWrap.appendChild(submit)
  submitWrap.appendChild(el('p', 'publisher-import-pending-note', t('publisher.import.submit.pendingNote')))
  controls.appendChild(submitWrap)

  return controls
}

function renderManifestPanel(
  state: PageState,
  rerender: () => void,
  options: ImportPageOptions,
): HTMLElement {
  void options
  const panel = el('div', 'publisher-import-panel')

  const drop = el('div', 'publisher-import-dropzone')
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.csv,.json,text/csv,application/json'
  input.className = 'publisher-import-file-input'
  input.setAttribute('aria-label', t('publisher.import.drop.prompt'))

  const handleFile = (file: File | undefined): void => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result ?? '')
      const parsed = parseManifest(text)
      state.fileName = file.name
      state.parseErrorKey = parsed.errorKey
      state.rows = parsed.errorKey ? null : validateRows(parsed.records)
      rerender()
    }
    reader.readAsText(file)
  }

  drop.appendChild(el('div', 'publisher-import-drop-icon', '⬍'))
  drop.appendChild(el('div', 'publisher-import-drop-prompt', t('publisher.import.drop.prompt')))
  drop.appendChild(
    el('div', 'publisher-import-drop-hint', t('publisher.import.drop.hint', { max: MAX_ROWS })),
  )

  const actions = el('div', 'publisher-import-drop-actions')
  const browse = el('button', 'publisher-button publisher-import-browse', t('publisher.import.drop.browse')) as HTMLButtonElement
  browse.type = 'button'
  browse.addEventListener('click', () => input.click())
  const template = el('button', 'publisher-button publisher-import-template', t('publisher.import.drop.template')) as HTMLButtonElement
  template.type = 'button'
  template.addEventListener('click', () => {
    downloadCsv('publisher-datasets-template.csv', [
      ['title', 'slug', 'format', 'data_ref', 'license', 'visibility'],
      ['Sea Surface Temp — May 2026', 'sst-2026-05', 'mp4', 'https://example.org/sst.mp4', 'CC-BY-4.0', 'public'],
    ])
  })
  actions.appendChild(browse)
  actions.appendChild(template)
  drop.appendChild(actions)
  drop.appendChild(input)

  input.addEventListener('change', () => handleFile(input.files?.[0]))
  drop.addEventListener('dragover', e => {
    e.preventDefault()
    drop.classList.add('publisher-import-dropzone-over')
  })
  drop.addEventListener('dragleave', () => drop.classList.remove('publisher-import-dropzone-over'))
  drop.addEventListener('drop', e => {
    e.preventDefault()
    drop.classList.remove('publisher-import-dropzone-over')
    handleFile(e.dataTransfer?.files?.[0])
  })
  panel.appendChild(drop)

  if (state.parseErrorKey) {
    panel.appendChild(el('p', 'publisher-import-parse-error', t(state.parseErrorKey)))
  } else if (state.rows) {
    panel.appendChild(renderPreview(state.rows))
    panel.appendChild(renderControls(state.rows))
  }
  return panel
}

function renderRemotePanel(): HTMLElement {
  const panel = el('div', 'publisher-import-panel publisher-import-info')
  panel.appendChild(el('p', 'publisher-import-info-body', t('publisher.import.remote.body')))
  panel.appendChild(el('span', 'publisher-badge publisher-import-soon', t('publisher.import.remote.comingSoon')))
  return panel
}

function renderCliPanel(options: ImportPageOptions): HTMLElement {
  const panel = el('div', 'publisher-import-panel publisher-import-info')
  panel.appendChild(el('p', 'publisher-import-info-body', t('publisher.import.cli.body')))
  const codeRow = el('div', 'publisher-import-code-row')
  const code = el('code', 'publisher-import-code', CLI_COMMAND)
  const copy = el('button', 'publisher-button publisher-import-copy', t('publisher.import.cli.copy')) as HTMLButtonElement
  copy.type = 'button'
  copy.addEventListener('click', () => {
    const clip = options.clipboard ?? navigator.clipboard
    void clip?.writeText(CLI_COMMAND).then(
      () => {
        copy.textContent = t('publisher.import.cli.copied')
      },
      () => {
        /* clipboard denied — leave label as-is */
      },
    )
  })
  codeRow.appendChild(code)
  codeRow.appendChild(copy)
  panel.appendChild(codeRow)
  return panel
}

/**
 * Boot the /publish/import page. Synchronous — there is no initial
 * fetch; the whole surface renders immediately and re-renders in
 * place as the user picks a method or drops a manifest.
 */
export function renderImportPage(mount: HTMLElement, options: ImportPageOptions = {}): void {
  const state: PageState = { method: 'manifest', rows: null, parseErrorKey: undefined, fileName: '' }

  // Sync render first (this page has no loading state); swap in the
  // disabled card if the toggles resolve off. Fail-open on any error.
  void fetchFeatures().then(features => {
    if (!features.datasets) renderFeatureDisabledCard(mount, 'datasets')
  })

  const rerender = (): void => {
    const shell = el('main', 'publisher-shell publisher-import')

    const header = el('header', 'publisher-import-header')
    header.appendChild(el('h1', 'publisher-import-title', t('publisher.import.title')))
    header.appendChild(el('p', 'publisher-import-subtitle', t('publisher.import.subtitle')))
    shell.appendChild(header)

    const methods = el('div', 'publisher-import-methods')
    methods.appendChild(
      methodCard(state, 'manifest', 'publisher.import.method.manifest.title', 'publisher.import.method.manifest.desc', () => {
        state.method = 'manifest'
        rerender()
      }),
    )
    methods.appendChild(
      methodCard(state, 'remote', 'publisher.import.method.remote.title', 'publisher.import.method.remote.desc', () => {
        state.method = 'remote'
        rerender()
      }),
    )
    methods.appendChild(
      methodCard(state, 'cli', 'publisher.import.method.cli.title', 'publisher.import.method.cli.desc', () => {
        state.method = 'cli'
        rerender()
      }),
    )
    shell.appendChild(methods)

    if (state.method === 'manifest') shell.appendChild(renderManifestPanel(state, rerender, options))
    else if (state.method === 'remote') shell.appendChild(renderRemotePanel())
    else shell.appendChild(renderCliPanel(options))

    mount.replaceChildren(shell)
  }

  rerender()
}
