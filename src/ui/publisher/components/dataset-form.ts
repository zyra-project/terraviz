/**
 * Shared dataset create / edit form.
 *
 * Five glass-surface cards backed by a single `FormState` and a
 * mode-aware submit handler. Page modules wrap this with their
 * own routes:
 *
 *   - `pages/dataset-new.ts` calls with `mode: 'create'`, initial
 *     state blank, POSTs to /api/v1/publish/datasets, then SPA-
 *     navigates to the new row's detail page on success.
 *   - `pages/dataset-edit.ts` (3pc/D/C) fetches the existing row
 *     first, calls with `mode: 'edit'` + prefilled state, PUTs to
 *     /api/v1/publish/datasets/{id}, navigates back to the detail
 *     page on success.
 *
 * Field rendering, validation-error display, and the auth-error
 * branching (session / network / server) are identical across the
 * two modes — only the heading, HTTP method, endpoint, and post-
 * save redirect differ.
 */

import { t, type MessageKey } from '../../../i18n'
import {
  clearWarmupFlag,
  handleSessionError,
  publisherSend,
  type PublisherValidationError,
} from '../api'
import { buildErrorCard, type ErrorCardDetails } from './error-card'
import { attachToolbar, renderMarkdownToolbar } from './markdown-toolbar'
import { renderChipInput } from './chip-input'
import { renderAssetUploader, type AuxAssetKind } from './asset-uploader'
import { renderMarkdown } from '../../../services/markdownRenderer'
import type { PublisherDatasetDetail } from '../types'
import type { DatasetOverlayOptions } from '../../../types'
import { ROUTE_CHANGE_START_EVENT } from '../router'

export type DatasetFormMode = 'create' | 'edit'

export interface DatasetFormOptions {
  /** `'create'` posts to /api/v1/publish/datasets; `'edit'` puts
   *  to /api/v1/publish/datasets/{id}. */
  mode: DatasetFormMode
  /** Existing row to prefill from in edit mode. Required when
   *  `mode === 'edit'`; ignored in create. The full
   *  `PublisherDatasetDetail` shape (the detail page's wire type)
   *  carries every field the form reads. */
  initial?: PublisherDatasetDetail
  /** The dataset's `data_ref` resolved to a publicly-readable URL
   *  (edit mode). When the dataset is an image, this becomes the
   *  source for the globe-thumbnail generator's "Generate from this
   *  dataset's data" one-click path — so an already-uploaded image
   *  doesn't have to be re-uploaded. Null/absent → that affordance
   *  is hidden and the manual frame picker is the path. */
  dataUrl?: string | null
  /** Resolved public URLs of the dataset's current thumbnail /
   *  legend (edit mode), so the form can show an image preview of
   *  each alongside its uploader. Null/absent → no preview. */
  thumbnailUrl?: string | null
  legendUrl?: string | null
  /** Keyword chips to prefill in edit mode. Optional — server
   *  endpoints that don't yet ship keywords can pass an empty
   *  array and the chip input starts blank. */
  initialKeywords?: ReadonlyArray<string>
  /** Tag chips to prefill in edit mode. Same shape as keywords. */
  initialTags?: ReadonlyArray<string>
  fetchFn?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  navigate?: (url: string) => void
  /** History-API SPA navigation for the post-save redirect.
   *  Tests stub it to assert on the destination URL. */
  routerNavigate?: (path: string) => void
}

const CREATE_ENDPOINT = '/api/v1/publish/datasets'

function editEndpoint(id: string): string {
  return `/api/v1/publish/datasets/${encodeURIComponent(id)}`
}

interface FormState {
  title: string
  slug: string
  /** `true` when the user has manually edited the slug field;
   *  after that we stop auto-deriving from the title so we don't
   *  clobber their explicit choice. */
  slugLocked: boolean
  format: string
  visibility: string
  /** Asset reference — `vimeo:1234567`, `r2:videos/.../master.m3u8`,
   *  `r2:datasets/.../image.png`, or an absolute HTTPS URL.
   *  Required by `validateForPublish`; a draft can be saved
   *  with it empty. Stays as a manual text input until the
   *  3pd asset uploader replaces it with a guided upload flow. */
  dataRef: string
  /** Auxiliary-image references surfaced on the browse card +
   *  info panel. Same shape rules as `dataRef` (an `r2:` / absolute
   *  HTTPS ref); in edit mode the guided uploader writes them, and
   *  the manual input is the create-mode + external fallback. */
  thumbnailRef: string
  legendRef: string
  /** Resolved public URL of the dataset's own data (edit mode), used
   *  as the globe-thumbnail generator's auto source for image
   *  datasets. Empty when absent / unresolvable. */
  dataUrl: string
  /** The dataset's render hints (bbox / lonOrigin / flip / celestial
   *  body), forwarded to the globe-thumbnail generator so a
   *  generated thumbnail matches the live globe. Null in create mode
   *  (no row yet). */
  overlay: DatasetOverlayOptions | null
  /** Resolved URLs of the currently-saved thumbnail / legend images
   *  (edit mode), shown as a preview in the media card. */
  currentThumbnailUrl: string | null
  currentLegendUrl: string | null
  organization: string
  abstract: string
  /** Toggle between editing the abstract markdown source and
   *  rendering the sanitized preview. The same `renderMarkdown`
   *  function the public dataset detail page will use generates
   *  the preview, so what the publisher sees is byte-for-byte
   *  what the public will see. */
  abstractPreviewing: boolean
  // Licensing & attribution fields (3pc/C2). One of license_spdx
  // or license_statement is required before publish; both can be
  // blank during draft authoring.
  licenseSpdx: string
  licenseUrl: string
  licenseStatement: string
  /** Guided license-chooser UI state (persists across re-renders).
   *  `licenseAdapt`: '' | 'yes' | 'sharealike' | 'no';
   *  `licenseCommercial`: '' | 'yes' | 'no'. */
  licenseChooserOpen: boolean
  licenseAdapt: string
  licenseCommercial: string
  attributionText: string
  rightsHolder: string
  doi: string
  citationText: string
  // Time range fields. Split into explicit Date + Time inputs
  // (`<input type="date">` + `<input type="time">`) so the
  // publisher can see both halves of the picker; some browser
  // renderings of `datetime-local` collapse the time portion
  // into a hard-to-spot scrubber.
  //
  // startDate / endDate are `YYYY-MM-DD`; startTime / endTime
  // are `HH:MM` (24-hour). `dateTimeToIso` composes them into
  // the ISO 8601 UTC the server's `ISO_DATE_RE` validator
  // requires. An empty time defaults to `00:00` so a date-only
  // entry survives the round-trip with a sensible default.
  // `period` is an ISO 8601 duration string (`P1D`, `PT1H`, …)
  // and submits verbatim.
  startDate: string
  startTime: string
  endDate: string
  endTime: string
  period: string
  // Geography & projection (Phase 3d render hints). Bounding-box
  // corners are kept as raw input strings; the submit composes them
  // into the typed `bounding_box` object only when all four are
  // present (the validator requires the full set + n >= s). lonOrigin
  // / radiusMi are likewise raw strings parsed at submit; flippedInY
  // is a real boolean (checkbox); celestialBody is free text.
  bboxN: string
  bboxS: string
  bboxW: string
  bboxE: string
  lonOrigin: string
  isFlippedInY: boolean
  celestialBody: string
  radiusMi: string
  // Categorization (3pc/C3b). Both arrays cap at 20 entries
  // server-side; chip-input applies the same cap so the UI
  // matches the validator.
  keywords: ReadonlyArray<string>
  tags: ReadonlyArray<string>
  /** DOM id of the section card currently shown — the deck's form is
   *  a stepper, so only one section is visible at a time (the left-
   *  rail nav switches it). */
  activeSection: string
  isSaving: boolean
  errors: ReadonlyArray<PublisherValidationError>
  /** Non-validation top-level error (network / server / session
   *  / not_found). Rendered in an alert above the form when set. */
  topLevelError: 'server' | 'network' | 'session' | null
  /** Status + body captured for `server`-kind errors so the error
   *  card can disclose them. Operator-debugging affordance. */
  topLevelErrorDetails: ErrorCardDetails
}

const FORMATS: ReadonlyArray<{ value: string; labelKey: FormatLabelKey }> = [
  { value: 'video/mp4', labelKey: 'publisher.datasetForm.format.video' },
  { value: 'image/png', labelKey: 'publisher.datasetForm.format.imagePng' },
  { value: 'image/jpeg', labelKey: 'publisher.datasetForm.format.imageJpeg' },
  { value: 'image/webp', labelKey: 'publisher.datasetForm.format.imageWebp' },
  { value: 'tour/json', labelKey: 'publisher.datasetForm.format.tour' },
]

const VISIBILITIES: ReadonlyArray<{ value: string; labelKey: VisibilityLabelKey }> = [
  { value: 'public', labelKey: 'publisher.datasetForm.visibility.public' },
  { value: 'federated', labelKey: 'publisher.datasetForm.visibility.federated' },
  { value: 'restricted', labelKey: 'publisher.datasetForm.visibility.restricted' },
  { value: 'private', labelKey: 'publisher.datasetForm.visibility.private' },
]

type FormatLabelKey =
  | 'publisher.datasetForm.format.video'
  | 'publisher.datasetForm.format.imagePng'
  | 'publisher.datasetForm.format.imageJpeg'
  | 'publisher.datasetForm.format.imageWebp'
  | 'publisher.datasetForm.format.tour'

type VisibilityLabelKey =
  | 'publisher.datasetForm.visibility.public'
  | 'publisher.datasetForm.visibility.federated'
  | 'publisher.datasetForm.visibility.restricted'
  | 'publisher.datasetForm.visibility.private'

/**
 * Client-side slug derivation matching `deriveSlug` in
 * `functions/api/v1/_lib/validators.ts`. We mirror it so the live
 * preview matches what the server would persist if the publisher
 * leaves the slug blank.
 */
function deriveSlug(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/^-+|-+$/g, '')
  if (!base) return 'dataset'
  if (!/^[a-z]/.test(base)) {
    return `dataset-${base}`.slice(0, 64).replace(/-+$/, '')
  }
  return base
}

function findError(
  errors: ReadonlyArray<PublisherValidationError>,
  field: string,
): PublisherValidationError | null {
  return errors.find(e => e.field === field) ?? null
}

function backLink(): HTMLElement {
  const a = document.createElement('a')
  a.href = '/publish/datasets'
  a.className = 'publisher-back-link'
  a.textContent = `← ${t('publisher.datasetDetail.backToList')}`
  return a
}

/** Terse createElement helper for the form's chrome (nav / readiness). */
function el(tag: string, props: { className?: string; textContent?: string } = {}): HTMLElement {
  const node = document.createElement(tag)
  if (props.className) node.className = props.className
  if (props.textContent != null) node.textContent = props.textContent
  return node
}

/** DOM ids for the form's section cards — shared by the cards
 *  themselves and the left-rail section nav that jumps to them. */
const FORM_SECTIONS: ReadonlyArray<{
  id: string
  labelKey:
    | 'publisher.datasetForm.section.identity'
    | 'publisher.datasetForm.section.abstract'
    | 'publisher.datasetForm.section.media'
    | 'publisher.datasetForm.section.licensing'
    | 'publisher.datasetForm.section.timeSpace'
    | 'publisher.datasetForm.section.categorization'
}> = [
  { id: 'ds-section-identity', labelKey: 'publisher.datasetForm.section.identity' },
  { id: 'ds-section-abstract', labelKey: 'publisher.datasetForm.section.abstract' },
  { id: 'ds-section-media', labelKey: 'publisher.datasetForm.section.media' },
  { id: 'ds-section-licensing', labelKey: 'publisher.datasetForm.section.licensing' },
  { id: 'ds-section-timespace', labelKey: 'publisher.datasetForm.section.timeSpace' },
  { id: 'ds-section-categorization', labelKey: 'publisher.datasetForm.section.categorization' },
]

/** Map a server validation-error field to the section that holds it,
 *  so a failed save can jump the stepper to the offending field
 *  (otherwise an error in a hidden section is invisible). */
function sectionForField(field: string): string {
  if (field === 'abstract') return 'ds-section-abstract'
  if (field === 'thumbnail_ref' || field === 'legend_ref') return 'ds-section-media'
  if (field.startsWith('license') || field === 'attribution_text' || field === 'rights_holder' || field === 'doi' || field === 'citation_text') {
    return 'ds-section-licensing'
  }
  if (field === 'start_time' || field === 'end_time' || field === 'period' || field.startsWith('bounding_box') || field === 'lon_origin' || field === 'celestial_body' || field === 'radius_mi') {
    return 'ds-section-timespace'
  }
  if (field === 'keywords' || field === 'tags') return 'ds-section-categorization'
  // title / slug / format / visibility / data_ref / organization.
  return 'ds-section-identity'
}

/** Left-rail section nav. The form is a stepper — clicking a section
 *  shows only that section's card(s); the active one is highlighted. */
function buildSectionNav(activeSection: string, onSelect: (id: string) => void): HTMLElement {
  const nav = document.createElement('nav')
  nav.className = 'publisher-form-nav'
  nav.setAttribute('aria-label', t('publisher.datasetForm.nav.aria'))
  for (const section of FORM_SECTIONS) {
    const a = document.createElement('button')
    a.type = 'button'
    a.className =
      section.id === activeSection
        ? 'publisher-form-nav-link publisher-form-nav-link-active'
        : 'publisher-form-nav-link'
    if (section.id === activeSection) a.setAttribute('aria-current', 'step')
    a.dataset.section = section.id
    a.textContent = t(section.labelKey)
    a.addEventListener('click', () => onSelect(section.id))
    nav.appendChild(a)
  }
  return nav
}

/** The five publish-readiness requirements and whether the current
 *  form state satisfies each — the same fields `validateForPublish`
 *  enforces server-side, surfaced as a live checklist. */
function readinessItems(state: FormState): Array<{ labelKey: string; ready: boolean }> {
  return [
    { labelKey: 'publisher.datasetForm.readiness.title', ready: state.title.trim() !== '' },
    { labelKey: 'publisher.datasetForm.readiness.format', ready: state.format.trim() !== '' },
    { labelKey: 'publisher.datasetForm.readiness.abstract', ready: state.abstract.trim() !== '' },
    { labelKey: 'publisher.datasetForm.readiness.dataRef', ready: state.dataRef.trim() !== '' },
    {
      labelKey: 'publisher.datasetForm.readiness.license',
      ready: state.licenseSpdx.trim() !== '' || state.licenseStatement.trim() !== '',
    },
  ]
}

/** Left-rail "Publish readiness" checklist. */
function buildReadiness(state: FormState): HTMLElement {
  const items = readinessItems(state)
  const readyCount = items.filter(i => i.ready).length

  const panel = document.createElement('div')
  panel.className = 'publisher-form-readiness'
  panel.appendChild(
    el('div', {
      className: 'publisher-form-readiness-heading',
      textContent: t('publisher.datasetForm.readiness.heading'),
    }),
  )
  panel.appendChild(
    el('div', {
      className: 'publisher-form-readiness-count',
      textContent: t('publisher.datasetForm.readiness.count', {
        ready: String(readyCount),
        total: String(items.length),
      }),
    }),
  )
  const list = document.createElement('ul')
  list.className = 'publisher-form-readiness-list'
  for (const item of items) {
    const li = document.createElement('li')
    li.className = `publisher-form-readiness-item ${item.ready ? 'is-ready' : 'is-pending'}`
    const mark = el('span', {
      className: 'publisher-form-readiness-mark',
      textContent: item.ready ? '✓' : '○',
    })
    mark.setAttribute(
      'aria-label',
      item.ready
        ? t('publisher.datasetForm.readiness.readyAria')
        : t('publisher.datasetForm.readiness.notReadyAria'),
    )
    li.append(mark, el('span', { textContent: t(item.labelKey as 'publisher.datasetForm.readiness.title') }))
    list.appendChild(li)
  }
  panel.appendChild(list)
  return panel
}

function renderTopLevelError(
  kind: 'server' | 'network' | 'session',
  details: ErrorCardDetails,
): HTMLElement {
  return buildErrorCard(kind, details)
}

function abstractCard(
  state: FormState,
  rerender: () => void,
): HTMLElement {
  const card = document.createElement('section')
  card.className = 'publisher-card publisher-glass publisher-form-card'

  const heading = document.createElement('h2')
  heading.className = 'publisher-card-heading'
  heading.textContent = t('publisher.datasetForm.section.abstract')
  card.appendChild(heading)

  const wrap = document.createElement('div')
  wrap.className = 'publisher-form-field'

  const labelRow = document.createElement('div')
  labelRow.className = 'publisher-form-label-row'

  const label = document.createElement('label')
  label.className = 'publisher-form-label'
  label.htmlFor = 'dataset-abstract'
  label.textContent = t('publisher.datasetForm.field.abstract')
  labelRow.appendChild(label)

  // Edit ↔ Preview toggle. Plain button rather than tab pattern
  // because there are exactly two states and the textarea / preview
  // panes don't carry conceptual identity beyond "the abstract".
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'publisher-form-toggle'
  toggle.textContent = state.abstractPreviewing
    ? t('publisher.datasetForm.action.edit')
    : t('publisher.datasetForm.action.preview')
  toggle.addEventListener('click', () => {
    state.abstractPreviewing = !state.abstractPreviewing
    rerender()
  })
  labelRow.appendChild(toggle)

  wrap.appendChild(labelRow)

  if (state.abstractPreviewing) {
    const preview = document.createElement('div')
    preview.className = 'publisher-form-markdown-preview'
    if (state.abstract.trim().length === 0) {
      const empty = document.createElement('p')
      empty.className = 'publisher-form-markdown-empty'
      empty.textContent = t('publisher.datasetForm.preview.empty')
      preview.appendChild(empty)
    } else {
      // renderMarkdown runs `marked` then sanitizeMarkdownHtml.
      // The returned HTML is safe to set as innerHTML — XSS-tested
      // in src/services/markdownRenderer.test.ts.
      preview.innerHTML = renderMarkdown(state.abstract)
    }
    wrap.appendChild(preview)
  } else {
    // Toolbar above the textarea — GitHub-issue style. Buttons
    // mutate the textarea directly (no parent re-render), so
    // focus + selection stay intact across button presses.
    const toolbar = renderMarkdownToolbar()
    wrap.appendChild(toolbar)

    const textarea = document.createElement('textarea')
    textarea.id = 'dataset-abstract'
    textarea.className = 'publisher-form-textarea'
    textarea.rows = 8
    textarea.placeholder = t('publisher.datasetForm.placeholder.abstract')
    textarea.value = state.abstract
    textarea.addEventListener('input', () => {
      state.abstract = textarea.value
    })
    textarea.addEventListener('change', () => {
      state.abstract = textarea.value
    })
    wrap.appendChild(textarea)

    attachToolbar(toolbar, textarea, {
      onChange: v => {
        state.abstract = v
      },
    })
  }

  const help = document.createElement('p')
  help.className = 'publisher-form-help'
  help.textContent = t('publisher.datasetForm.help.abstract')
  wrap.appendChild(help)

  const error = findError(state.errors, 'abstract')
  if (error) {
    const err = document.createElement('p')
    err.className = 'publisher-form-error'
    err.setAttribute('role', 'alert')
    err.textContent = error.message
    wrap.appendChild(err)
  }

  card.appendChild(wrap)
  return card
}

function inputField(opts: {
  id: string
  labelKey: MessageKey
  required: boolean
  value: string
  placeholder?: string
  error: PublisherValidationError | null
  helpKey?: MessageKey
  /** Input type — `'text'` (default) or `'number'` for the
   *  lat/lon/radius fields. */
  type?: 'text' | 'number'
  onChange: (v: string) => void
  onInput?: (v: string) => void
}): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'publisher-form-field'

  const label = document.createElement('label')
  label.className = 'publisher-form-label'
  label.htmlFor = opts.id
  const labelText = document.createElement('span')
  labelText.textContent = t(opts.labelKey)
  label.appendChild(labelText)
  if (opts.required) {
    const req = document.createElement('span')
    req.className = 'publisher-form-required'
    req.setAttribute('aria-label', t('publisher.datasetForm.requiredAria'))
    req.textContent = '*'
    label.appendChild(req)
  }
  wrap.appendChild(label)

  const input = document.createElement('input')
  input.type = opts.type ?? 'text'
  input.id = opts.id
  input.className = 'publisher-form-input'
  input.value = opts.value
  if (opts.placeholder) input.placeholder = opts.placeholder
  if (opts.error) {
    input.setAttribute('aria-invalid', 'true')
    input.setAttribute('aria-describedby', `${opts.id}-err`)
  }
  input.addEventListener('input', () => {
    if (opts.onInput) opts.onInput(input.value)
  })
  input.addEventListener('change', () => opts.onChange(input.value))
  input.addEventListener('blur', () => opts.onChange(input.value))
  wrap.appendChild(input)

  if (opts.helpKey) {
    const help = document.createElement('p')
    help.className = 'publisher-form-help'
    help.textContent = t(opts.helpKey)
    wrap.appendChild(help)
  }

  if (opts.error) {
    const err = document.createElement('p')
    err.id = `${opts.id}-err`
    err.className = 'publisher-form-error'
    err.setAttribute('role', 'alert')
    err.textContent = opts.error.message
    wrap.appendChild(err)
  }
  return wrap
}

function radioGroup(opts: {
  legendKey: MessageKey
  name: string
  options: ReadonlyArray<{ value: string; label: string }>
  value: string
  required: boolean
  error: PublisherValidationError | null
  onChange: (v: string) => void
  /** Renders the fieldset with `disabled` set on every input so
   *  the user can't change the selection. Used by the format
   *  field while a transcode is in flight — the server-side
   *  guard would 409 the change anyway, and disabling here is a
   *  clearer signal than "submit-then-error". PR #112 followup. */
  disabled?: boolean
}): HTMLElement {
  const fieldset = document.createElement('fieldset')
  fieldset.className = 'publisher-form-fieldset'

  const legend = document.createElement('legend')
  legend.className = 'publisher-form-label'
  const legendText = document.createElement('span')
  legendText.textContent = t(opts.legendKey)
  legend.appendChild(legendText)
  if (opts.required) {
    const req = document.createElement('span')
    req.className = 'publisher-form-required'
    req.setAttribute('aria-label', t('publisher.datasetForm.requiredAria'))
    req.textContent = '*'
    legend.appendChild(req)
  }
  fieldset.appendChild(legend)

  for (const o of opts.options) {
    const id = `${opts.name}-${o.value.replace(/\W/g, '-')}`
    const wrap = document.createElement('label')
    wrap.className = 'publisher-form-radio'
    wrap.htmlFor = id

    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.id = id
    radio.name = opts.name
    radio.value = o.value
    radio.checked = o.value === opts.value
    if (opts.disabled) radio.disabled = true
    radio.addEventListener('change', () => opts.onChange(o.value))
    wrap.appendChild(radio)

    const span = document.createElement('span')
    span.textContent = o.label
    wrap.appendChild(span)

    fieldset.appendChild(wrap)
  }

  if (opts.error) {
    const err = document.createElement('p')
    err.className = 'publisher-form-error'
    err.setAttribute('role', 'alert')
    err.textContent = opts.error.message
    fieldset.appendChild(err)
  }

  return fieldset
}

function textareaField(opts: {
  id: string
  labelKey: MessageKey
  value: string
  placeholder?: string
  rows?: number
  error: PublisherValidationError | null
  onChange: (v: string) => void
}): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'publisher-form-field'

  const label = document.createElement('label')
  label.className = 'publisher-form-label'
  label.htmlFor = opts.id
  label.textContent = t(opts.labelKey)
  wrap.appendChild(label)

  const textarea = document.createElement('textarea')
  textarea.id = opts.id
  textarea.className = 'publisher-form-textarea'
  textarea.rows = opts.rows ?? 4
  if (opts.placeholder) textarea.placeholder = opts.placeholder
  textarea.value = opts.value
  if (opts.error) {
    textarea.setAttribute('aria-invalid', 'true')
    textarea.setAttribute('aria-describedby', `${opts.id}-err`)
  }
  textarea.addEventListener('input', () => opts.onChange(textarea.value))
  textarea.addEventListener('change', () => opts.onChange(textarea.value))
  wrap.appendChild(textarea)

  if (opts.error) {
    const err = document.createElement('p')
    err.id = `${opts.id}-err`
    err.className = 'publisher-form-error'
    err.setAttribute('role', 'alert')
    err.textContent = opts.error.message
    wrap.appendChild(err)
  }
  return wrap
}

/**
 * Compose a `<input type="date">` value (`YYYY-MM-DD`) and a
 * `<input type="time">` value (`HH:MM`) into an ISO 8601 UTC
 * string. `time` defaults to `00:00` when empty so a date-only
 * entry survives the round-trip.
 *
 * Returns '' for empty / unparseable date (no time without a
 * date — `period`-only ranges aren't a thing the validator
 * supports).
 */
export function dateTimeToIso(date: string, time: string): string {
  if (!date) return ''
  const t = time || '00:00'
  // `new Date('YYYY-MM-DDTHH:MM:00')` parses as local; serialise
  // to UTC with the Z suffix the server's `ISO_DATE_RE` requires.
  const d = new Date(`${date}T${t}:00`)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString()
}

function dateTimePairField(opts: {
  idPrefix: string
  labelKey: MessageKey
  dateValue: string
  timeValue: string
  dateError: PublisherValidationError | null
  timeError: PublisherValidationError | null
  onDateChange: (v: string) => void
  onTimeChange: (v: string) => void
}): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'publisher-form-field'

  const label = document.createElement('label')
  label.className = 'publisher-form-label'
  label.htmlFor = `${opts.idPrefix}-date`
  label.textContent = t(opts.labelKey)
  wrap.appendChild(label)

  const row = document.createElement('div')
  row.className = 'publisher-form-datetime-row'

  // Date half.
  const dateCol = document.createElement('div')
  dateCol.className = 'publisher-form-datetime-date'
  const dateInner = document.createElement('label')
  dateInner.className = 'publisher-form-datetime-sublabel'
  dateInner.htmlFor = `${opts.idPrefix}-date`
  dateInner.textContent = t('publisher.datasetForm.datetime.date')
  dateCol.appendChild(dateInner)
  const dateInput = document.createElement('input')
  dateInput.type = 'date'
  dateInput.id = `${opts.idPrefix}-date`
  dateInput.className = 'publisher-form-input'
  dateInput.value = opts.dateValue
  if (opts.dateError) {
    dateInput.setAttribute('aria-invalid', 'true')
    dateInput.setAttribute('aria-describedby', `${opts.idPrefix}-err`)
  }
  dateInput.addEventListener('input', () => opts.onDateChange(dateInput.value))
  dateInput.addEventListener('change', () => opts.onDateChange(dateInput.value))
  dateCol.appendChild(dateInput)
  row.appendChild(dateCol)

  // Time half. `step="60"` is the default but being explicit
  // nudges some browsers to a more useful UI.
  const timeCol = document.createElement('div')
  timeCol.className = 'publisher-form-datetime-time'
  const timeInner = document.createElement('label')
  timeInner.className = 'publisher-form-datetime-sublabel'
  timeInner.htmlFor = `${opts.idPrefix}-time`
  timeInner.textContent = t('publisher.datasetForm.datetime.time')
  timeCol.appendChild(timeInner)
  const timeInput = document.createElement('input')
  timeInput.type = 'time'
  timeInput.id = `${opts.idPrefix}-time`
  timeInput.className = 'publisher-form-input'
  timeInput.value = opts.timeValue
  timeInput.step = '60'
  if (opts.timeError) {
    timeInput.setAttribute('aria-invalid', 'true')
    timeInput.setAttribute('aria-describedby', `${opts.idPrefix}-err`)
  }
  timeInput.addEventListener('input', () => opts.onTimeChange(timeInput.value))
  timeInput.addEventListener('change', () => opts.onTimeChange(timeInput.value))
  timeCol.appendChild(timeInput)
  row.appendChild(timeCol)

  wrap.appendChild(row)

  const error = opts.dateError ?? opts.timeError
  if (error) {
    const err = document.createElement('p')
    err.id = `${opts.idPrefix}-err`
    err.className = 'publisher-form-error'
    err.setAttribute('role', 'alert')
    err.textContent = error.message
    wrap.appendChild(err)
  }
  return wrap
}

function timeRangeCard(state: FormState): HTMLElement {
  const card = document.createElement('section')
  card.className = 'publisher-card publisher-glass publisher-form-card'

  const heading = document.createElement('h2')
  heading.className = 'publisher-card-heading'
  heading.textContent = t('publisher.datasetForm.section.timeRange')
  card.appendChild(heading)

  card.appendChild(
    dateTimePairField({
      idPrefix: 'dataset-start',
      labelKey: 'publisher.datasetForm.field.startTime',
      dateValue: state.startDate,
      timeValue: state.startTime,
      dateError: findError(state.errors, 'start_time'),
      timeError: null,
      onDateChange: v => {
        state.startDate = v
      },
      onTimeChange: v => {
        state.startTime = v
      },
    }),
  )

  card.appendChild(
    dateTimePairField({
      idPrefix: 'dataset-end',
      labelKey: 'publisher.datasetForm.field.endTime',
      dateValue: state.endDate,
      timeValue: state.endTime,
      dateError: findError(state.errors, 'end_time'),
      timeError: null,
      onDateChange: v => {
        state.endDate = v
      },
      onTimeChange: v => {
        state.endTime = v
      },
    }),
  )

  card.appendChild(
    inputField({
      id: 'dataset-period',
      labelKey: 'publisher.datasetForm.field.period',
      required: false,
      value: state.period,
      placeholder: 'P1D',
      helpKey: 'publisher.datasetForm.help.period',
      error: findError(state.errors, 'period'),
      onChange: v => {
        state.period = v
      },
    }),
  )

  const hint = document.createElement('p')
  hint.className = 'publisher-form-help'
  hint.textContent = t('publisher.datasetForm.help.timeRange')
  card.appendChild(hint)

  return card
}

function checkboxField(opts: {
  id: string
  labelKey: MessageKey
  checked: boolean
  helpKey?: MessageKey
  onChange: (v: boolean) => void
}): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'publisher-form-field'

  const label = document.createElement('label')
  label.className = 'publisher-form-checkbox'
  label.htmlFor = opts.id

  const input = document.createElement('input')
  input.type = 'checkbox'
  input.id = opts.id
  input.checked = opts.checked
  input.addEventListener('change', () => opts.onChange(input.checked))
  label.appendChild(input)

  const span = document.createElement('span')
  span.textContent = t(opts.labelKey)
  label.appendChild(span)

  wrap.appendChild(label)

  if (opts.helpKey) {
    const help = document.createElement('p')
    help.className = 'publisher-form-help'
    help.textContent = t(opts.helpKey)
    wrap.appendChild(help)
  }
  return wrap
}

/**
 * Geography & projection card — the dataset's render hints (bounding
 * box, longitude origin, Y-flip, celestial body + radius). These tell
 * the globe how to project the data: a bounding box clips regional
 * data to its extent over a base Earth, `lonOrigin` re-centres the
 * dateline, `isFlippedInY` corrects inverted-Y imagery, and a
 * non-Earth `celestialBody` swaps the base body. The validator
 * requires all four bbox corners together (n >= s); the submit only
 * sends `bounding_box` when the full set is present.
 */
function geographyCard(state: FormState): HTMLElement {
  const card = document.createElement('section')
  card.className = 'publisher-card publisher-glass publisher-form-card'

  const heading = document.createElement('h2')
  heading.className = 'publisher-card-heading'
  heading.textContent = t('publisher.datasetForm.section.geography')
  card.appendChild(heading)

  // Projection expectation — the globe (and the generated thumbnail)
  // assume equirectangular imagery; reprojecting other CRSs is a
  // Zyra-workflow / offline step, not something this form does. See
  // docs/ZYRA_INTEGRATION_PLAN.md §"Reprojection lives in Zyra".
  const projectionNote = document.createElement('p')
  projectionNote.className = 'publisher-form-help'
  projectionNote.textContent = t('publisher.datasetForm.help.geography')
  card.appendChild(projectionNote)

  // Bounding box — four numeric corners in a row.
  const bboxWrap = document.createElement('div')
  bboxWrap.className = 'publisher-form-field'
  const bboxLabel = document.createElement('span')
  bboxLabel.className = 'publisher-form-label'
  bboxLabel.textContent = t('publisher.datasetForm.field.boundingBox')
  bboxWrap.appendChild(bboxLabel)

  const bboxRow = document.createElement('div')
  bboxRow.className = 'publisher-form-bbox-row'
  const corners: ReadonlyArray<{
    id: string
    labelKey: MessageKey
    value: string
    placeholder: string
    field: string
    set: (v: string) => void
  }> = [
    { id: 'dataset-bbox-n', labelKey: 'publisher.datasetForm.field.bboxN', value: state.bboxN, placeholder: '90', field: 'bounding_box.n', set: v => { state.bboxN = v } },
    { id: 'dataset-bbox-s', labelKey: 'publisher.datasetForm.field.bboxS', value: state.bboxS, placeholder: '-90', field: 'bounding_box.s', set: v => { state.bboxS = v } },
    { id: 'dataset-bbox-w', labelKey: 'publisher.datasetForm.field.bboxW', value: state.bboxW, placeholder: '-180', field: 'bounding_box.w', set: v => { state.bboxW = v } },
    { id: 'dataset-bbox-e', labelKey: 'publisher.datasetForm.field.bboxE', value: state.bboxE, placeholder: '180', field: 'bounding_box.e', set: v => { state.bboxE = v } },
  ]
  for (const c of corners) {
    const col = document.createElement('div')
    col.className = 'publisher-form-bbox-col'
    const lbl = document.createElement('label')
    lbl.className = 'publisher-form-datetime-sublabel'
    lbl.htmlFor = c.id
    lbl.textContent = t(c.labelKey)
    col.appendChild(lbl)
    const input = document.createElement('input')
    input.type = 'number'
    input.id = c.id
    input.className = 'publisher-form-input'
    input.value = c.value
    input.placeholder = c.placeholder
    const err = findError(state.errors, c.field)
    if (err) {
      input.setAttribute('aria-invalid', 'true')
      input.setAttribute('aria-describedby', `${c.id}-err`)
    }
    input.addEventListener('input', () => c.set(input.value))
    input.addEventListener('change', () => c.set(input.value))
    col.appendChild(input)
    // Surface the validator's actionable per-corner message (e.g.
    // "bounding_box.n must be in [-90, 90]") rather than just a red
    // input. PR #209 Copilot review.
    if (err) {
      const cornerErr = document.createElement('p')
      cornerErr.id = `${c.id}-err`
      cornerErr.className = 'publisher-form-error'
      cornerErr.setAttribute('role', 'alert')
      cornerErr.textContent = err.message
      col.appendChild(cornerErr)
    }
    bboxRow.appendChild(col)
  }
  bboxWrap.appendChild(bboxRow)

  const bboxHelp = document.createElement('p')
  bboxHelp.className = 'publisher-form-help'
  bboxHelp.textContent = t('publisher.datasetForm.help.boundingBox')
  bboxWrap.appendChild(bboxHelp)

  // Group-level bbox error (e.g. "n >= s", or "all four required").
  const bboxErr = findError(state.errors, 'bounding_box')
  if (bboxErr) {
    const e = document.createElement('p')
    e.className = 'publisher-form-error'
    e.setAttribute('role', 'alert')
    e.textContent = bboxErr.message
    bboxWrap.appendChild(e)
  }
  card.appendChild(bboxWrap)

  card.appendChild(
    inputField({
      id: 'dataset-lon-origin',
      labelKey: 'publisher.datasetForm.field.lonOrigin',
      required: false,
      value: state.lonOrigin,
      placeholder: '0',
      type: 'number',
      helpKey: 'publisher.datasetForm.help.lonOrigin',
      error: findError(state.errors, 'lon_origin'),
      onChange: v => {
        state.lonOrigin = v
      },
    }),
  )

  card.appendChild(
    checkboxField({
      id: 'dataset-flipped-y',
      labelKey: 'publisher.datasetForm.field.flippedInY',
      checked: state.isFlippedInY,
      helpKey: 'publisher.datasetForm.help.flippedInY',
      onChange: v => {
        state.isFlippedInY = v
      },
    }),
  )

  card.appendChild(
    inputField({
      id: 'dataset-celestial-body',
      labelKey: 'publisher.datasetForm.field.celestialBody',
      required: false,
      value: state.celestialBody,
      placeholder: 'Earth',
      helpKey: 'publisher.datasetForm.help.celestialBody',
      error: findError(state.errors, 'celestial_body'),
      onChange: v => {
        state.celestialBody = v
      },
    }),
  )

  card.appendChild(
    inputField({
      id: 'dataset-radius-mi',
      labelKey: 'publisher.datasetForm.field.radiusMi',
      required: false,
      value: state.radiusMi,
      placeholder: '2106',
      type: 'number',
      helpKey: 'publisher.datasetForm.help.radiusMi',
      error: findError(state.errors, 'radius_mi'),
      onChange: v => {
        state.radiusMi = v
      },
    }),
  )

  return card
}

function categorizationCard(state: FormState): HTMLElement {
  const card = document.createElement('section')
  card.className = 'publisher-card publisher-glass publisher-form-card'

  const heading = document.createElement('h2')
  heading.className = 'publisher-card-heading'
  heading.textContent = t('publisher.datasetForm.section.categorization')
  card.appendChild(heading)

  card.appendChild(
    renderChipInput({
      id: 'dataset-keywords',
      labelKey: 'publisher.datasetForm.field.keywords',
      values: state.keywords,
      placeholder: t('publisher.datasetForm.placeholder.keywords'),
      helpKey: 'publisher.datasetForm.help.keywords',
      max: 20,
      maxLength: 40,
      onChange: v => {
        state.keywords = v
      },
    }),
  )

  card.appendChild(
    renderChipInput({
      id: 'dataset-tags',
      labelKey: 'publisher.datasetForm.field.tags',
      values: state.tags,
      placeholder: t('publisher.datasetForm.placeholder.tags'),
      helpKey: 'publisher.datasetForm.help.tags',
      max: 20,
      maxLength: 40,
      onChange: v => {
        state.tags = v
      },
    }),
  )

  return card
}

/** Creative Commons 4.0 licenses keyed by `<adapt>|<commercial>`
 *  answers — the guided chooser's suggestion table. */
const CC_LICENSES: Record<string, { spdx: string; url: string }> = {
  'yes|yes': { spdx: 'CC-BY-4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
  'yes|no': { spdx: 'CC-BY-NC-4.0', url: 'https://creativecommons.org/licenses/by-nc/4.0/' },
  'sharealike|yes': { spdx: 'CC-BY-SA-4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
  'sharealike|no': { spdx: 'CC-BY-NC-SA-4.0', url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/' },
  'no|yes': { spdx: 'CC-BY-ND-4.0', url: 'https://creativecommons.org/licenses/by-nd/4.0/' },
  'no|no': { spdx: 'CC-BY-NC-ND-4.0', url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/' },
}

/** A few common licenses offered as one-click quick-picks. */
const COMMON_LICENSES: ReadonlyArray<{ spdx: string; url: string }> = [
  { spdx: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
  { spdx: 'CC-BY-4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
  { spdx: 'CC-BY-SA-4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
  { spdx: 'CC-BY-NC-4.0', url: 'https://creativecommons.org/licenses/by-nc/4.0/' },
]

/** Map the two chooser answers to a suggested license, or null until
 *  both are answered. Pure — exported for tests. */
export function suggestedLicense(
  adapt: string,
  commercial: string,
): { spdx: string; url: string } | null {
  if (!adapt || !commercial) return null
  return CC_LICENSES[`${adapt}|${commercial}`] ?? null
}

/** A labelled radio group for one chooser question. */
function chooserQuestion(
  labelKey: MessageKey,
  name: string,
  options: ReadonlyArray<{ value: string; labelKey: MessageKey }>,
  selected: string,
  onSelect: (value: string) => void,
): HTMLElement {
  const fieldset = document.createElement('fieldset')
  fieldset.className = 'publisher-license-chooser-question'
  const legend = document.createElement('legend')
  legend.className = 'publisher-license-chooser-legend'
  legend.textContent = t(labelKey)
  fieldset.appendChild(legend)
  const row = document.createElement('div')
  row.className = 'publisher-license-chooser-options'
  for (const opt of options) {
    const label = document.createElement('label')
    label.className = 'publisher-license-chooser-option'
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = name
    radio.value = opt.value
    radio.checked = selected === opt.value
    radio.addEventListener('change', () => onSelect(opt.value))
    label.append(radio, el('span', { textContent: t(opt.labelKey) }))
    row.appendChild(label)
  }
  fieldset.appendChild(row)
  return fieldset
}

/** The guided license chooser block (deck slide 5): a Quick-pick row
 *  of common licenses plus two questions that suggest a CC license,
 *  all of which fill the SPDX + URL fields below. */
function licenseChooser(state: FormState, update: () => void): HTMLElement {
  const applyLicense = (spdx: string, url: string): void => {
    state.licenseSpdx = spdx
    state.licenseUrl = url
    update()
  }

  const chooser = document.createElement('div')
  chooser.className = 'publisher-license-chooser'

  const head = document.createElement('div')
  head.className = 'publisher-license-chooser-head'
  head.appendChild(
    el('span', {
      className: 'publisher-license-chooser-title',
      textContent: t('publisher.datasetForm.chooser.quickPick'),
    }),
  )
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'publisher-license-chooser-toggle'
  toggle.textContent = state.licenseChooserOpen
    ? t('publisher.datasetForm.chooser.hide')
    : t('publisher.datasetForm.chooser.show')
  toggle.addEventListener('click', () => {
    state.licenseChooserOpen = !state.licenseChooserOpen
    update()
  })
  head.appendChild(toggle)
  chooser.appendChild(head)

  chooser.appendChild(
    el('p', {
      className: 'publisher-license-chooser-help',
      textContent: t('publisher.datasetForm.chooser.help'),
    }),
  )

  if (!state.licenseChooserOpen) return chooser

  const quick = document.createElement('div')
  quick.className = 'publisher-license-chooser-quick'
  for (const lic of COMMON_LICENSES) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'publisher-license-chooser-chip'
    btn.textContent = lic.spdx // i18n-exempt: SPDX identifier
    if (state.licenseSpdx === lic.spdx) btn.classList.add('is-selected')
    btn.addEventListener('click', () => applyLicense(lic.spdx, lic.url))
    quick.appendChild(btn)
  }
  chooser.appendChild(quick)

  chooser.appendChild(
    el('h4', {
      className: 'publisher-license-chooser-heading',
      textContent: t('publisher.datasetForm.chooser.heading'),
    }),
  )
  chooser.appendChild(
    chooserQuestion(
      'publisher.datasetForm.chooser.q1',
      'dataset-license-adapt',
      [
        { value: 'yes', labelKey: 'publisher.datasetForm.chooser.q1.yes' },
        { value: 'sharealike', labelKey: 'publisher.datasetForm.chooser.q1.sharealike' },
        { value: 'no', labelKey: 'publisher.datasetForm.chooser.q1.no' },
      ],
      state.licenseAdapt,
      v => {
        state.licenseAdapt = v
        update()
      },
    ),
  )
  chooser.appendChild(
    chooserQuestion(
      'publisher.datasetForm.chooser.q2',
      'dataset-license-commercial',
      [
        { value: 'yes', labelKey: 'publisher.datasetForm.chooser.q2.yes' },
        { value: 'no', labelKey: 'publisher.datasetForm.chooser.q2.no' },
      ],
      state.licenseCommercial,
      v => {
        state.licenseCommercial = v
        update()
      },
    ),
  )

  const suggestion = suggestedLicense(state.licenseAdapt, state.licenseCommercial)
  if (!suggestion) {
    chooser.appendChild(
      el('p', {
        className: 'publisher-license-chooser-prompt',
        textContent: t('publisher.datasetForm.chooser.prompt'),
      }),
    )
  } else {
    const row = document.createElement('div')
    row.className = 'publisher-license-chooser-suggestion'
    row.appendChild(
      el('span', {
        className: 'publisher-license-chooser-suggestion-label',
        textContent: `${t('publisher.datasetForm.chooser.suggested')}: ${suggestion.spdx}`,
      }),
    )
    const apply = document.createElement('button')
    apply.type = 'button'
    apply.className = 'publisher-button publisher-button-primary publisher-license-chooser-apply'
    const isApplied = state.licenseSpdx === suggestion.spdx
    apply.textContent = isApplied
      ? t('publisher.datasetForm.chooser.applied')
      : t('publisher.datasetForm.chooser.apply')
    apply.disabled = isApplied
    apply.addEventListener('click', () => applyLicense(suggestion.spdx, suggestion.url))
    row.appendChild(apply)
    chooser.appendChild(row)
  }

  return chooser
}

function licensingCard(state: FormState, update: () => void): HTMLElement {
  const card = document.createElement('section')
  card.className = 'publisher-card publisher-glass publisher-form-card'

  const heading = document.createElement('h2')
  heading.className = 'publisher-card-heading'
  heading.textContent = t('publisher.datasetForm.section.licensing')
  card.appendChild(heading)

  card.appendChild(licenseChooser(state, update))

  card.appendChild(
    inputField({
      id: 'dataset-license-spdx',
      labelKey: 'publisher.datasetForm.field.licenseSpdx',
      required: false,
      value: state.licenseSpdx,
      placeholder: 'CC0-1.0',
      helpKey: 'publisher.datasetForm.help.licenseSpdx',
      error: findError(state.errors, 'license_spdx'),
      onChange: v => {
        state.licenseSpdx = v
      },
    }),
  )

  card.appendChild(
    inputField({
      id: 'dataset-license-url',
      labelKey: 'publisher.datasetForm.field.licenseUrl',
      required: false,
      value: state.licenseUrl,
      placeholder: 'https://creativecommons.org/publicdomain/zero/1.0/',
      error: findError(state.errors, 'license_url'),
      onChange: v => {
        state.licenseUrl = v
      },
    }),
  )

  card.appendChild(
    textareaField({
      id: 'dataset-license-statement',
      labelKey: 'publisher.datasetForm.field.licenseStatement',
      value: state.licenseStatement,
      placeholder: t('publisher.datasetForm.placeholder.licenseStatement'),
      rows: 3,
      error: findError(state.errors, 'license_statement'),
      onChange: v => {
        state.licenseStatement = v
      },
    }),
  )

  card.appendChild(
    inputField({
      id: 'dataset-attribution-text',
      labelKey: 'publisher.datasetForm.field.attribution',
      required: false,
      value: state.attributionText,
      placeholder: 'Visualization by NOAA/PMEL',
      error: findError(state.errors, 'attribution_text'),
      onChange: v => {
        state.attributionText = v
      },
    }),
  )

  card.appendChild(
    inputField({
      id: 'dataset-rights-holder',
      labelKey: 'publisher.datasetForm.field.rightsHolder',
      required: false,
      value: state.rightsHolder,
      placeholder: 'U.S. Government',
      error: findError(state.errors, 'rights_holder'),
      onChange: v => {
        state.rightsHolder = v
      },
    }),
  )

  card.appendChild(
    inputField({
      id: 'dataset-doi',
      labelKey: 'publisher.datasetForm.field.doi',
      required: false,
      value: state.doi,
      placeholder: '10.5066/F7M906QJ',
      error: findError(state.errors, 'doi'),
      onChange: v => {
        state.doi = v
      },
    }),
  )

  card.appendChild(
    textareaField({
      id: 'dataset-citation',
      labelKey: 'publisher.datasetForm.field.citation',
      value: state.citationText,
      rows: 3,
      error: findError(state.errors, 'citation_text'),
      onChange: v => {
        state.citationText = v
      },
    }),
  )

  // Suppress the "unused parameter" while we don't yet branch on
  // anything inside this card. The `update` callback is in the
  // signature so future field types (radios, repeaters) can
  // request a re-render from this card.
  void update
  return card
}

interface RenderContext {
  mode: DatasetFormMode
  /** Existing dataset id (edit mode). Used to build the PUT URL
   *  and the post-save back-navigation target. */
  datasetId: string | null
  /** True when the row is currently mid-transcode (the parent
   *  detail page is also polling). The form swaps the asset
   *  uploader + manual ref input for a read-only notice — the
   *  server-side `transcoding_in_progress` guard would refuse a
   *  second /asset/.../complete dispatch anyway, but disabling
   *  the affordance here gives the publisher a clearer signal
   *  than "submit-then-error". */
  isTranscoding: boolean
  fetchFn: typeof fetch
  sleep: (ms: number) => Promise<void>
  navigate: (url: string) => void
  routerNavigate: (path: string) => void
  /** Shared lifecycle token for the form mount. `disposed` flips
   *  to true exactly once — when ROUTE_CHANGE_START_EVENT fires —
   *  and stays true. All renders within a single form mount share
   *  this object reference, so a deferred callback bound during
   *  render N (e.g. the asset-uploader's onUploaded) sees the
   *  same flip even after render N+1 has supplanted it. The
   *  listener that flips this lives in `renderDatasetForm` so
   *  it's bound once per mount, not once per re-render. PR #112
   *  followup — dataset-form.ts:disposed race.
   *
   *  `uploader` caches the asset-uploader DOM element across
   *  renderForm calls so a parent re-render (input change,
   *  save-in-progress repaint) doesn't tear down an in-flight
   *  upload. Without this, the uploader's internal `state`
   *  closure variables (XHR controller, progress, mid-flight
   *  promise chain) all keep running on a detached element
   *  while a fresh idle uploader mounts in the new DOM — and
   *  the publisher sees "Choose a file" even though an upload
   *  is still progressing in the background, with no way to
   *  see its progress or cancel. `uploaderFormat` records the
   *  format the cached uploader was constructed for; a format
   *  change forces a fresh uploader (its mime-acceptance logic
   *  is set at construction time). PR #112 followup —
   *  dataset-form.ts:asset uploader subtree preservation. */
  lifecycle: {
    disposed: boolean
    uploader?: HTMLElement
    uploaderFormat?: string
    /** Cached auxiliary-asset uploader subtrees (thumbnail /
     *  legend), preserved across parent re-renders so an in-flight
     *  image upload isn't torn down when an unrelated field change
     *  repaints the form. Aux uploaders aren't format-keyed (they
     *  accept images regardless of the dataset's primary format),
     *  so there's no `*Format` companion the way `data` has. */
    thumbnailUploader?: HTMLElement
    legendUploader?: HTMLElement
  }
}

/**
 * One auxiliary-image slot (thumbnail or legend): a guided
 * uploader (edit mode, where the `/asset` endpoint has a row to
 * scope against) plus a manual ref/URL input that doubles as the
 * create-mode entry point and the escape hatch for external /
 * already-encoded `r2:` refs the uploader can't express. Mirrors
 * the `data_ref` uploader-plus-manual-input layout in `renderForm`.
 */
function auxAssetField(
  content: HTMLElement,
  state: FormState,
  ctx: RenderContext,
  opts: {
    kind: AuxAssetKind
    refValue: string
    setRef: (v: string) => void
    uploaderLabelKey: MessageKey
    manualLabelKey: MessageKey
    manualHelpKey: MessageKey
    placeholder: string
    inputId: string
    errorField: string
    cacheKey: 'thumbnailUploader' | 'legendUploader'
    /** Fetchable URL for the dataset's own data frame, forwarded to
     *  the uploader's globe-thumbnail generator (thumbnail only). */
    dataAssetUrl?: string | null
    /** The dataset's render hints, forwarded so a generated thumbnail
     *  matches the live globe (thumbnail only). */
    dataAssetOverlay?: DatasetOverlayOptions | null
    /** Resolved URL of the currently-saved image for this slot, shown
     *  as a preview above the uploader. Null → no preview. */
    currentImageUrl?: string | null
  },
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'publisher-form-aux-asset'

  // Preview of the currently-saved image (edit mode), so the
  // publisher sees the actual thumbnail / legend rather than only its
  // `r2:` ref text.
  if (opts.currentImageUrl) {
    const preview = document.createElement('img')
    preview.className = 'publisher-form-aux-preview'
    preview.src = opts.currentImageUrl
    preview.alt = t(opts.uploaderLabelKey)
    preview.loading = 'lazy'
    wrap.appendChild(preview)
  }

  // Guided uploader — edit mode only. The `/asset` init endpoint
  // is scoped to a saved dataset id, so create mode (no row yet)
  // gets only the manual input; once the draft is saved the
  // publisher lands on the edit page where the uploader appears.
  if (ctx.mode === 'edit' && ctx.datasetId) {
    const uploaderWrap = document.createElement('div')
    uploaderWrap.className = 'publisher-field'
    const label = document.createElement('span')
    label.className = 'publisher-field-label'
    label.textContent = t(opts.uploaderLabelKey)
    uploaderWrap.appendChild(label)

    // Reuse the previously-mounted uploader subtree across renders
    // so a parent repaint (title edit, save-in-progress) doesn't
    // interrupt an in-flight upload. Same rationale as the `data`
    // uploader's subtree preservation, minus the format key.
    const cached = ctx.lifecycle[opts.cacheKey]
    if (cached) {
      uploaderWrap.appendChild(cached)
    } else {
      const uploaderEl = renderAssetUploader({
        datasetId: ctx.datasetId,
        kind: opts.kind,
        format: state.format,
        currentDataRef: opts.refValue || null,
        dataAssetUrl: opts.dataAssetUrl ?? null,
        dataAssetOverlay: opts.dataAssetOverlay ?? null,
        navigate: ctx.navigate,
        fetchFn: ctx.fetchFn,
        sleep: ctx.sleep,
        onUploaded: outcome => {
          if (ctx.lifecycle.disposed) return
          if (outcome.mode !== 'aux') return
          // The server already stamped the row's `*_ref`; mirror it
          // into form state + the manual input so a later Save
          // doesn't omit it and the publisher sees the new value.
          opts.setRef(outcome.ref)
          const manual = content.querySelector<HTMLInputElement>(`#${opts.inputId}`)
          if (manual) manual.value = outcome.ref
        },
      })
      ctx.lifecycle[opts.cacheKey] = uploaderEl
      uploaderWrap.appendChild(uploaderEl)
    }
    wrap.appendChild(uploaderWrap)
  }

  // Manual ref input — both modes.
  wrap.appendChild(
    inputField({
      id: opts.inputId,
      labelKey: opts.manualLabelKey,
      required: false,
      value: opts.refValue,
      placeholder: opts.placeholder,
      helpKey: opts.manualHelpKey,
      error: findError(state.errors, opts.errorField),
      onChange: v => {
        opts.setRef(v)
      },
    }),
  )

  return wrap
}

/**
 * Build the dataset's render hints from the detail row, mirroring
 * the public serializer's mapping (bbox surfaces only when all four
 * corners are present; lonOrigin / flip / celestialBody only when
 * populated). Returns null when nothing is set, so the generator
 * takes the plain full-globe path. The shape matches the live
 * globe's `DatasetOverlayOptions`, so a thumbnail generated from it
 * looks like the real globe.
 */
function overlayFromRow(row: PublisherDatasetDetail): DatasetOverlayOptions | null {
  const overlay: DatasetOverlayOptions = {}
  if (
    row.bbox_n != null &&
    row.bbox_s != null &&
    row.bbox_w != null &&
    row.bbox_e != null
  ) {
    overlay.boundingBox = { n: row.bbox_n, s: row.bbox_s, w: row.bbox_w, e: row.bbox_e }
  }
  if (typeof row.lon_origin === 'number') overlay.lonOrigin = row.lon_origin
  if (row.is_flipped_in_y === 1) overlay.isFlippedInY = true
  if (row.celestial_body && row.celestial_body.trim()) {
    overlay.celestialBody = row.celestial_body
  }
  return Object.keys(overlay).length > 0 ? overlay : null
}

/**
 * Resolve the dataset's data into a URL the globe-thumbnail
 * generator can fetch as a 2:1 frame.
 *
 * The server resolves the row's `data_ref` (an `r2:` ref or a bare
 * URL) to a public URL and hands it back as `state.dataUrl`, so an
 * already-uploaded dataset gets the one-click "Generate from this
 * dataset's data" path without re-uploading:
 *
 *  - **Image** datasets: the data frame *is* a 2:1 equirectangular
 *    image, wrapped directly. A legacy `https://` `data_ref` is a
 *    fallback for any path that didn't carry a resolved `dataUrl`.
 *  - **Video** datasets: `dataUrl` is the HLS playlist, which the
 *    uploader loads into a scrubable `<video>` so the publisher
 *    picks a frame. Legacy `vimeo:` refs don't resolve to a public
 *    URL → null → the manual frame picker.
 *
 * Returns null for anything else (tours) and when no URL resolved,
 * which hides the one-click button and leaves the manual frame
 * picker as the path.
 */
function thumbnailDataSourceUrl(state: FormState): string | null {
  const isImage =
    state.format === 'image/png' ||
    state.format === 'image/jpeg' ||
    state.format === 'image/webp'
  const isVideo = state.format === 'video/mp4'
  if (!isImage && !isVideo) return null
  if (state.dataUrl.trim()) return state.dataUrl.trim()
  // Legacy fallback only applies to a directly-fetchable image ref.
  if (isImage) {
    return /^https:\/\//i.test(state.dataRef.trim()) ? state.dataRef.trim() : null
  }
  return null
}

/**
 * Media card — the thumbnail + legend auxiliary images. Both feed
 * the public catalog: `thumbnail_ref` is the browse-card image,
 * `legend_ref` the colour-scale legend shown alongside the loaded
 * dataset.
 */
function mediaCard(
  content: HTMLElement,
  state: FormState,
  ctx: RenderContext,
): HTMLElement {
  const card = document.createElement('section')
  card.className = 'publisher-card publisher-glass publisher-form-card'

  const heading = document.createElement('h2')
  heading.className = 'publisher-card-heading'
  heading.textContent = t('publisher.datasetForm.section.media')
  card.appendChild(heading)

  card.appendChild(
    auxAssetField(content, state, ctx, {
      kind: 'thumbnail',
      refValue: state.thumbnailRef,
      setRef: v => {
        state.thumbnailRef = v
      },
      uploaderLabelKey: 'publisher.datasetForm.field.thumbnail',
      manualLabelKey: 'publisher.datasetForm.field.thumbnailManual',
      manualHelpKey: 'publisher.datasetForm.help.thumbnail',
      placeholder: 'r2:datasets/.../thumbnail.png',
      inputId: 'dataset-thumbnail-ref',
      errorField: 'thumbnail_ref',
      cacheKey: 'thumbnailUploader',
      dataAssetUrl: thumbnailDataSourceUrl(state),
      dataAssetOverlay: state.overlay,
      currentImageUrl: state.currentThumbnailUrl,
    }),
  )

  card.appendChild(
    auxAssetField(content, state, ctx, {
      kind: 'legend',
      refValue: state.legendRef,
      setRef: v => {
        state.legendRef = v
      },
      uploaderLabelKey: 'publisher.datasetForm.field.legend',
      manualLabelKey: 'publisher.datasetForm.field.legendManual',
      manualHelpKey: 'publisher.datasetForm.help.legend',
      placeholder: 'r2:datasets/.../legend.png',
      inputId: 'dataset-legend-ref',
      errorField: 'legend_ref',
      cacheKey: 'legendUploader',
      currentImageUrl: state.currentLegendUrl,
    }),
  )

  return card
}

function renderForm(
  content: HTMLElement,
  state: FormState,
  ctx: RenderContext,
): void {
  const shell = document.createElement('main')
  shell.className = 'publisher-shell publisher-dataset-form'

  // Top header: back link + title on the left, action buttons on the
  // right (the deck moves Cancel / Save here from the form footer).
  const header = document.createElement('header')
  header.className = 'publisher-dataset-form-header'

  const headerMain = document.createElement('div')
  headerMain.className = 'publisher-dataset-form-header-main'
  headerMain.appendChild(backLink())
  const heading = document.createElement('h1')
  heading.className = 'publisher-detail-title'
  heading.textContent =
    ctx.mode === 'edit'
      ? t('publisher.datasetForm.headingEdit')
      : t('publisher.datasetForm.headingNew')
  headerMain.appendChild(heading)
  header.appendChild(headerMain)
  header.appendChild(buildActions())
  shell.appendChild(header)

  if (state.topLevelError) {
    shell.appendChild(renderTopLevelError(state.topLevelError, state.topLevelErrorDetails))
  }

  // Two-column layout: a sticky left rail (section nav + publish
  // readiness) and the form cards on the right.
  const layout = document.createElement('div')
  layout.className = 'publisher-dataset-form-layout'
  const rail = document.createElement('aside')
  rail.className = 'publisher-dataset-form-rail'
  rail.appendChild(
    buildSectionNav(state.activeSection, id => {
      state.activeSection = id
      update()
    }),
  )
  rail.appendChild(buildReadiness(state))
  layout.appendChild(rail)

  const form = document.createElement('form')
  form.className = 'publisher-form'
  form.setAttribute('novalidate', '')
  form.addEventListener('submit', e => {
    e.preventDefault()
    void onSubmit()
  })

  const identityCard = document.createElement('section')
  identityCard.className = 'publisher-card publisher-glass publisher-form-card'

  const cardHeading = document.createElement('h2')
  cardHeading.className = 'publisher-card-heading'
  cardHeading.textContent = t('publisher.datasetForm.section.identity')
  identityCard.appendChild(cardHeading)

  identityCard.appendChild(
    inputField({
      id: 'dataset-title',
      labelKey: 'publisher.datasetForm.field.title',
      required: true,
      value: state.title,
      placeholder: t('publisher.datasetForm.placeholder.title'),
      error: findError(state.errors, 'title'),
      onChange: v => {
        state.title = v
        if (!state.slugLocked) state.slug = deriveSlug(v)
        update()
      },
      onInput: v => {
        // Live-update the slug field as the user types, without
        // re-rendering the whole form (which would steal focus).
        if (!state.slugLocked) {
          const slugInput = content.querySelector<HTMLInputElement>('#dataset-slug')
          if (slugInput) slugInput.value = deriveSlug(v)
          state.slug = deriveSlug(v)
        }
      },
    }),
  )

  identityCard.appendChild(
    inputField({
      id: 'dataset-slug',
      labelKey: 'publisher.datasetForm.field.slug',
      required: false,
      value: state.slug,
      placeholder: 'sst-anomaly-2026-04',
      error: findError(state.errors, 'slug'),
      helpKey: 'publisher.datasetForm.help.slug',
      onChange: v => {
        state.slug = v
        state.slugLocked = true
      },
      onInput: v => {
        // Mark locked the moment the user types into the field,
        // so subsequent title edits don't clobber their override.
        state.slug = v
        state.slugLocked = true
      },
    }),
  )

  identityCard.appendChild(
    radioGroup({
      legendKey: 'publisher.datasetForm.field.format',
      name: 'format',
      options: FORMATS.map(f => ({ value: f.value, label: t(f.labelKey) })),
      value: state.format,
      required: true,
      error: findError(state.errors, 'format'),
      // Format is asset-coupled: changing it mid-transcode would
      // leave the row's declared format contradicting the HLS
      // data_ref the workflow is about to write. The server
      // rejects the change with 409 `transcoding_in_progress`;
      // disabling here is the publisher-friendly counterpart.
      // PR #112 followup — dataset-form.ts:937.
      disabled: ctx.mode === 'edit' && ctx.datasetId !== null && ctx.isTranscoding,
      onChange: v => {
        state.format = v
        update()
      },
    }),
  )

  identityCard.appendChild(
    radioGroup({
      legendKey: 'publisher.datasetForm.field.visibility',
      name: 'visibility',
      options: VISIBILITIES.map(v => ({ value: v.value, label: t(v.labelKey) })),
      value: state.visibility,
      required: false,
      error: findError(state.errors, 'visibility'),
      onChange: v => {
        state.visibility = v
        update()
      },
    }),
  )

  // The primary dataset-data upload lives in the Media section
  // (alongside thumbnail + legend), built here into `dataUploadEl`
  // and inserted into the media card below. data_ref is required by
  // `validateForPublish` server-side but draft-saveable empty. In
  // create mode the dataset id doesn't exist yet — the uploader
  // needs an id to scope its /asset endpoint against — so we show a
  // clear "save a draft first" notice plus the manual ref input as
  // a fallback for `vimeo:` / external URLs. In edit mode we hand
  // off to the asset uploader (3pd/C); the manual ref input stays
  // available for the non-upload paths (legacy / external).
  const dataUploadEl = document.createElement('div')
  dataUploadEl.className = 'publisher-form-data-upload'
  dataUploadEl.appendChild(
    el('h3', {
      className: 'publisher-form-subheading',
      textContent: t('publisher.datasetForm.dataUpload.heading'),
    }),
  )
  if (ctx.mode === 'edit' && ctx.datasetId && ctx.isTranscoding) {
    // Row is currently mid-transcode. The detail page has the
    // 5-second poller (it auto-refreshes when transcoding
    // clears); the edit page intentionally does NOT — an
    // editor who lands here mid-transcode has to reload or
    // navigate back to the detail page to see the completed
    // state. Replace both the uploader and the manual ref
    // input with a read-only notice so the publisher doesn't
    // try to start a second upload (which the server-side
    // `transcoding_in_progress` guard would 409 anyway) or
    // paste a manual ref into a row whose data_ref is about
    // to be overwritten by /transcode-complete (the data_ref
    // mutation guard added in /AE would 409 the save). Adding
    // a poller here is a candidate follow-up if editor-mid-
    // transcode turns out to be a common workflow; today's
    // assumption is that it's a corner case worth a static
    // notice + a reload prompt rather than another poll loop.
    //
    // Clear the cached uploader: this branch doesn't mount one,
    // so the cached element (if any from a prior render) is
    // about to be unreachable. The uploader's in-flight state,
    // if any, has already arrived at this branch via
    // ctx.isTranscoding = true — its work is done.
    ctx.lifecycle.uploader = undefined
    ctx.lifecycle.uploaderFormat = undefined
    const refDisplay = document.createElement('div')
    refDisplay.className = 'publisher-field'
    const refLabel = document.createElement('span')
    refLabel.className = 'publisher-field-label'
    refLabel.textContent = t('publisher.datasetForm.field.dataRef')
    refDisplay.appendChild(refLabel)
    const notice = document.createElement('p')
    notice.className = 'publisher-form-notice'
    notice.setAttribute('role', 'status')
    notice.textContent = t('publisher.datasetForm.transcoding.notice')
    refDisplay.appendChild(notice)
    if (state.dataRef) {
      const current = document.createElement('p')
      current.className = 'publisher-asset-uploader-current'
      current.textContent = state.dataRef
      refDisplay.appendChild(current)
    }
    dataUploadEl.appendChild(refDisplay)
  } else if (ctx.mode === 'edit' && ctx.datasetId) {
    // Edit mode mounts BOTH the guided uploader and the manual
    // text input. The uploader covers the "I have an MP4 / PNG
    // on my disk" case; the manual input covers the
    // "swap to a `vimeo:` legacy URL or paste an existing
    // `r2:videos/...` ref" case, which the uploader can't
    // express (its flow always uploads bytes). Fix for PR #112
    // Copilot #5 — the prior single-uploader layout left
    // editors no way to change a `vimeo:` / `url:` /
    // already-transcoded `r2:` ref short of round-tripping
    // through the API.
    const uploaderWrap = document.createElement('div')
    uploaderWrap.className = 'publisher-field'
    const label = document.createElement('span')
    label.className = 'publisher-field-label'
    label.textContent = t('publisher.datasetForm.field.dataRef')
    uploaderWrap.appendChild(label)
    // Reuse the previously-mounted uploader DOM across renders
    // when the format is unchanged. This preserves the
    // uploader's internal state (in-flight XHR, progress,
    // mid-flight promise chain) so a parent re-render — e.g.
    // the publisher edits the title while a multi-GB upload is
    // progressing — doesn't tear down the upload UI. Format
    // changes still recreate the uploader: its mime-acceptance
    // logic is set at construction time, and a publisher
    // switching format mid-upload is a meaningful state
    // change. PR #112 followup — dataset-form.ts:asset uploader
    // subtree preservation.
    if (ctx.lifecycle.uploader && ctx.lifecycle.uploaderFormat === state.format) {
      uploaderWrap.appendChild(ctx.lifecycle.uploader)
    } else {
      const uploaderEl = renderAssetUploader({
        datasetId: ctx.datasetId,
        format: state.format,
        currentDataRef: state.dataRef || null,
        navigate: ctx.navigate,
        fetchFn: ctx.fetchFn,
        sleep: ctx.sleep,
        onUploaded: outcome => {
          // Bail if the user navigated away during the upload
          // (which can take minutes for a multi-GB video). Without
          // this guard, the deferred callback would call update()
          // or mutate #dataset-data-ref on the next page's DOM.
          // `ctx.lifecycle` is the shared per-mount token — flips
          // only on route navigation, not on internal re-renders,
          // so an upload in flight across input changes still
          // resolves correctly. PR #112 followup —
          // dataset-form.ts:disposed race.
          if (ctx.lifecycle.disposed) return
          // On a direct upload (image), the server already wrote
          // `data_ref` to the row. Mirror the field-state so a
          // subsequent form save doesn't clobber it with an empty
          // string. On a video upload the server stamped
          // `transcoding=1` and cleared data_ref — flip
          // `ctx.isTranscoding` and rerender so the manual ref
          // input + Save button are replaced with the read-only
          // transcoding notice. Without the rerender the publisher
          // could type a fresh data_ref into the still-mounted
          // manual input and Save would clobber the in-flight
          // transcode's eventual master.m3u8 — PR #112 followup
          // (dataset-form.ts:1007).
          if (outcome.mode === 'direct') {
            state.dataRef = outcome.dataRef
            // Reflect the new ref in the manual input below so
            // the publisher sees what the row now points at.
            const manual = content.querySelector<HTMLInputElement>('#dataset-data-ref')
            if (manual) manual.value = outcome.dataRef
            // The uploader's job is done — drop the cache so a
            // future format change or new upload starts fresh.
            ctx.lifecycle.uploader = undefined
            ctx.lifecycle.uploaderFormat = undefined
          } else {
            state.dataRef = ''
            ctx.isTranscoding = true
            // Cache cleared by the isTranscoding branch on next
            // render (transcoding-locked branch doesn't mount
            // an uploader at all); the in-flight upload's
            // completion has already arrived here.
            ctx.lifecycle.uploader = undefined
            ctx.lifecycle.uploaderFormat = undefined
            update()
          }
        },
      })
      ctx.lifecycle.uploader = uploaderEl
      ctx.lifecycle.uploaderFormat = state.format
      uploaderWrap.appendChild(uploaderEl)
    }
    dataUploadEl.appendChild(uploaderWrap)
    // Manual ref input — for editors who want to swap to a
    // legacy `vimeo:` / `url:` ref or paste an already-encoded
    // `r2:videos/...` value without re-uploading bytes.
    dataUploadEl.appendChild(
      inputField({
        id: 'dataset-data-ref',
        labelKey: 'publisher.datasetForm.field.dataRefManual',
        required: false,
        value: state.dataRef,
        placeholder: t('publisher.datasetForm.placeholder.dataRef'),
        helpKey: 'publisher.datasetForm.help.dataRefManual',
        error: findError(state.errors, 'data_ref'),
        onChange: v => {
          state.dataRef = v
        },
      }),
    )
  } else {
    // Create-mode — the file uploader needs a saved dataset id, so
    // make the two-step explicit: save a draft, then upload on the
    // edit page. The manual ref input stays for pasting a `vimeo:`
    // ref or external URL by hand.
    const notice = document.createElement('p')
    notice.className = 'publisher-form-data-upload-notice'
    notice.textContent = t('publisher.datasetForm.dataUpload.createNotice')
    dataUploadEl.appendChild(notice)
    dataUploadEl.appendChild(
      inputField({
        id: 'dataset-data-ref',
        labelKey: 'publisher.datasetForm.field.dataRef',
        required: false,
        value: state.dataRef,
        placeholder: t('publisher.datasetForm.placeholder.dataRef'),
        helpKey: 'publisher.datasetForm.help.dataRef',
        error: findError(state.errors, 'data_ref'),
        onChange: v => {
          state.dataRef = v
        },
      }),
    )
  }

  identityCard.appendChild(
    inputField({
      id: 'dataset-organization',
      labelKey: 'publisher.datasetForm.field.organization',
      required: false,
      value: state.organization,
      placeholder: 'NOAA/PMEL',
      error: findError(state.errors, 'organization'),
      onChange: v => {
        state.organization = v
      },
    }),
  )

  identityCard.id = 'ds-section-identity'
  identityCard.dataset.section = 'ds-section-identity'
  const abstractEl = abstractCard(state, update)
  abstractEl.id = 'ds-section-abstract'
  abstractEl.dataset.section = 'ds-section-abstract'
  const mediaEl = mediaCard(content, state, ctx)
  mediaEl.id = 'ds-section-media'
  mediaEl.dataset.section = 'ds-section-media'
  // Primary dataset-data upload leads the Media section (before the
  // thumbnail + legend). Insert it right after the section heading.
  mediaEl.insertBefore(dataUploadEl, mediaEl.children[1] ?? null)
  const licensingEl = licensingCard(state, update)
  licensingEl.id = 'ds-section-licensing'
  licensingEl.dataset.section = 'ds-section-licensing'
  const timeEl = timeRangeCard(state)
  timeEl.id = 'ds-section-timespace'
  timeEl.dataset.section = 'ds-section-timespace'
  // Geography shares the "Time & space" step with the time-range card.
  const geoEl = geographyCard(state)
  geoEl.dataset.section = 'ds-section-timespace'
  const catEl = categorizationCard(state)
  catEl.id = 'ds-section-categorization'
  catEl.dataset.section = 'ds-section-categorization'
  const cards = [identityCard, abstractEl, mediaEl, licensingEl, timeEl, geoEl, catEl]
  for (const card of cards) {
    // Stepper: only the active section's card(s) are shown. Use inline
    // display (not the `hidden` attribute) because the card classes
    // set `display`, which would override `[hidden]`.
    if (card.dataset.section !== state.activeSection) card.style.display = 'none'
    form.appendChild(card)
  }

  layout.appendChild(form)
  shell.appendChild(layout)
  content.replaceChildren(shell)

  /** Cancel + Save-draft buttons, mounted in the top header. They
   *  live outside the <form>, so Save is a plain button that calls
   *  the same submit path the form's submit event used to. */
  function buildActions(): HTMLElement {
    const actions = document.createElement('div')
    actions.className = 'publisher-form-actions publisher-dataset-form-header-actions'

    const cancel = document.createElement('a')
    cancel.href = '/publish/datasets'
    cancel.className = 'publisher-button publisher-button-secondary'
    cancel.textContent = t('publisher.datasetForm.action.cancel')
    cancel.addEventListener('click', e => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      e.preventDefault()
      // In edit mode the natural cancel target is the detail page the
      // publisher arrived from; in create mode it's the list.
      if (ctx.mode === 'edit' && ctx.datasetId) {
        ctx.routerNavigate(`/publish/datasets/${encodeURIComponent(ctx.datasetId)}`)
      } else {
        ctx.routerNavigate('/publish/datasets')
      }
    })
    actions.appendChild(cancel)

    const submit = document.createElement('button')
    submit.type = 'button'
    submit.className = 'publisher-button publisher-button-primary'
    submit.textContent = state.isSaving
      ? t('publisher.datasetForm.action.saving')
      : t('publisher.datasetForm.action.saveDraft')
    submit.disabled = state.isSaving
    submit.addEventListener('click', () => void onSubmit())
    actions.appendChild(submit)

    return actions
  }

  // Internal re-render. The lifecycle/disposed bookkeeping lives
  // ONE level up (in `renderDatasetForm`), so this function just
  // checks the shared flag and re-renders. Internal re-renders
  // (input changes, save-in-progress repaints) do NOT dispose
  // the lifecycle — only route navigation does. That way, an
  // onSubmit handler bound during render N can still call its
  // captured update() after the server responds, and the
  // update() will paint errors / success states into render N+1.
  // The asset-uploader's onUploaded closure (which captures
  // ctx) sees the same lifecycle and bails only on a true
  // navigation, never on a sibling re-render. PR #112 followup —
  // dataset-form.ts:disposed race.
  function update(): void {
    if (ctx.lifecycle.disposed) return
    renderForm(content, state, ctx)
  }

  async function onSubmit(): Promise<void> {
    state.isSaving = true
    state.errors = []
    state.topLevelError = null
    update()

    const body: Record<string, unknown> = {
      title: state.title.trim(),
      format: state.format,
      visibility: state.visibility,
    }
    // Only send slug if the publisher manually overrode it.
    // Otherwise the server's deriveSlug() runs and we get
    // exactly the same value we previewed.
    if (state.slugLocked && state.slug.trim()) {
      body.slug = state.slug.trim()
    }
    // Trim — leading/trailing whitespace shouldn't survive into
    // the persisted row. An empty post-trim value is omitted
    // entirely so the column lands NULL rather than `""`.
    const trimmed = (v: string): string => v.trim()
    const setIfPresent = (field: string, value: string): void => {
      const t = trimmed(value)
      if (t) body[field] = t
    }
    setIfPresent('data_ref', state.dataRef)
    setIfPresent('thumbnail_ref', state.thumbnailRef)
    setIfPresent('legend_ref', state.legendRef)
    setIfPresent('abstract', state.abstract)
    setIfPresent('organization', state.organization)
    setIfPresent('license_spdx', state.licenseSpdx)
    setIfPresent('license_url', state.licenseUrl)
    setIfPresent('license_statement', state.licenseStatement)
    setIfPresent('attribution_text', state.attributionText)
    setIfPresent('rights_holder', state.rightsHolder)
    setIfPresent('doi', state.doi)
    setIfPresent('citation_text', state.citationText)
    // Time range. The form holds date + time as separate
    // `YYYY-MM-DD` / `HH:MM` strings; compose into ISO 8601 UTC
    // for the server. Empty date short-circuits the composer to
    // empty ISO (which the helper then skips).
    setIfPresent('start_time', dateTimeToIso(state.startDate, state.startTime))
    setIfPresent('end_time', dateTimeToIso(state.endDate, state.endTime))
    setIfPresent('period', state.period)
    // Geography & projection. The validator requires the full
    // bounding-box set (n/s/w/e) together, so only send it when all
    // four parse as finite numbers — a partially-filled box is
    // treated as "no box" rather than a guaranteed validation error.
    const num = (v: string): number | null => {
      const t = v.trim()
      if (!t) return null
      const n = Number(t)
      return Number.isFinite(n) ? n : null
    }
    const bn = num(state.bboxN)
    const bs = num(state.bboxS)
    const bw = num(state.bboxW)
    const be = num(state.bboxE)
    if (bn != null && bs != null && bw != null && be != null) {
      body.bounding_box = { n: bn, s: bs, w: bw, e: be }
    }
    const lon = num(state.lonOrigin)
    if (lon != null) body.lon_origin = lon
    // Always send the flip flag (a checkbox is explicitly on/off) so
    // it can be toggled back off on edit, unlike the omit-when-empty
    // text fields.
    body.is_flipped_in_y = state.isFlippedInY
    setIfPresent('celestial_body', state.celestialBody)
    const radius = num(state.radiusMi)
    if (radius != null) body.radius_mi = radius
    // Arrays — omit when empty so the join tables stay empty
    // instead of carrying placeholder rows.
    if (state.keywords.length > 0) body.keywords = [...state.keywords]
    if (state.tags.length > 0) body.tags = [...state.tags]

    const endpoint =
      ctx.mode === 'edit' && ctx.datasetId
        ? editEndpoint(ctx.datasetId)
        : CREATE_ENDPOINT
    const method = ctx.mode === 'edit' ? 'PUT' : 'POST'

    const result = await publisherSend<{ dataset: { id: string } }>(
      endpoint,
      body,
      {
        fetchFn: ctx.fetchFn,
        sleep: ctx.sleep,
        method,
      },
    )
    state.isSaving = false

    if (result.ok) {
      clearWarmupFlag()
      // On create, send the publisher straight to the edit page
      // (which mounts the asset uploader) rather than the read-only
      // detail page. The structural reason the uploader can't live
      // on /new is that the asset-init endpoint is scoped by
      // dataset id — there's no row to attach the upload to yet.
      // Navigating to detail then forcing an Edit click is two
      // extra clicks of friction; jumping to /edit lets the
      // publisher pick a file as their next action, which is
      // almost certainly what they want after Save Draft on a
      // greenfield row. Edit-mode saves keep the existing
      // navigate-to-detail behavior — the publisher was already
      // editing, the natural next step is to review.
      const id = encodeURIComponent(result.data.dataset.id)
      const target = ctx.mode === 'create'
        ? `/publish/datasets/${id}/edit`
        : `/publish/datasets/${id}`
      ctx.routerNavigate(target)
      return
    }
    if (result.kind === 'validation') {
      state.errors = result.errors
      // Jump the stepper to the first offending field's section so the
      // error isn't hidden in a collapsed section.
      if (result.errors.length > 0) {
        state.activeSection = sectionForField(result.errors[0].field)
      }
      update()
      return
    }
    if (result.kind === 'session') {
      if (handleSessionError({ navigate: ctx.navigate }) === 'show-error') {
        state.topLevelError = 'session'
        state.topLevelErrorDetails = {}
        update()
      }
      return
    }
    if (result.kind === 'server') {
      state.topLevelError = 'server'
      state.topLevelErrorDetails = { status: result.status, body: result.body }
      update()
      return
    }
    // network / not_found — surface as a transient network error.
    state.topLevelError = 'network'
    state.topLevelErrorDetails = {}
    update()
  }
}

/**
 * Convert a server-side ISO 8601 timestamp into the local-time
 * `YYYY-MM-DD` / `HH:MM` pair the date + time inputs read.
 * Returns `['', '']` for null / unparseable input. Inverse of
 * `dateTimeToIso`.
 */
function isoToDateTime(iso: string | null | undefined): [string, string] {
  if (!iso) return ['', '']
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ['', '']
  const pad = (n: number): string => String(n).padStart(2, '0')
  return [
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  ]
}

function initialState(
  mode: DatasetFormMode,
  row: PublisherDatasetDetail | undefined,
  initialKeywords: ReadonlyArray<string>,
  initialTags: ReadonlyArray<string>,
  dataUrl: string | null | undefined,
  thumbnailUrl: string | null | undefined,
  legendUrl: string | null | undefined,
): FormState {
  if (mode === 'create' || !row) {
    return {
      title: '',
      slug: '',
      slugLocked: false,
      activeSection: 'ds-section-identity',
      format: 'video/mp4',
      visibility: 'public',
      dataRef: '',
      thumbnailRef: '',
      legendRef: '',
      dataUrl: '',
      overlay: null,
      currentThumbnailUrl: null,
      currentLegendUrl: null,
      organization: '',
      abstract: '',
      abstractPreviewing: false,
      licenseSpdx: '',
      licenseUrl: '',
      licenseStatement: '',
      licenseChooserOpen: true,
      licenseAdapt: '',
      licenseCommercial: '',
      attributionText: '',
      rightsHolder: '',
      doi: '',
      citationText: '',
      startDate: '',
      startTime: '',
      endDate: '',
      endTime: '',
      period: '',
      bboxN: '',
      bboxS: '',
      bboxW: '',
      bboxE: '',
      lonOrigin: '',
      isFlippedInY: false,
      celestialBody: '',
      radiusMi: '',
      keywords: [],
      tags: [],
      isSaving: false,
      errors: [],
      topLevelError: null,
      topLevelErrorDetails: {},
    }
  }
  const [startDate, startTime] = isoToDateTime(row.start_time)
  const [endDate, endTime] = isoToDateTime(row.end_time)
  return {
    title: row.title,
    slug: row.slug,
    // In edit mode the publisher (or a server `deriveSlug` long
    // ago) already committed to a slug — treat it as manually
    // chosen so subsequent title edits don't clobber it.
    slugLocked: true,
    activeSection: 'ds-section-identity',
    format: row.format,
    visibility: row.visibility,
    dataRef: row.data_ref ?? '',
    thumbnailRef: row.thumbnail_ref ?? '',
    legendRef: row.legend_ref ?? '',
    dataUrl: dataUrl ?? '',
    overlay: overlayFromRow(row),
    currentThumbnailUrl: thumbnailUrl ?? null,
    currentLegendUrl: legendUrl ?? null,
    organization: row.organization ?? '',
    abstract: row.abstract ?? '',
    abstractPreviewing: false,
    licenseSpdx: row.license_spdx ?? '',
    licenseUrl: row.license_url ?? '',
    licenseStatement: row.license_statement ?? '',
    // Open the chooser only when no license is set yet (nothing to
    // overwrite); an already-licensed row starts collapsed.
    licenseChooserOpen: !(row.license_spdx ?? '').trim(),
    licenseAdapt: '',
    licenseCommercial: '',
    attributionText: row.attribution_text ?? '',
    rightsHolder: row.rights_holder ?? '',
    doi: row.doi ?? '',
    citationText: row.citation_text ?? '',
    startDate,
    startTime,
    endDate,
    endTime,
    period: row.period ?? '',
    bboxN: row.bbox_n != null ? String(row.bbox_n) : '',
    bboxS: row.bbox_s != null ? String(row.bbox_s) : '',
    bboxW: row.bbox_w != null ? String(row.bbox_w) : '',
    bboxE: row.bbox_e != null ? String(row.bbox_e) : '',
    lonOrigin: row.lon_origin != null ? String(row.lon_origin) : '',
    isFlippedInY: row.is_flipped_in_y === 1,
    celestialBody: row.celestial_body ?? '',
    radiusMi: row.radius_mi != null ? String(row.radius_mi) : '',
    keywords: [...initialKeywords],
    tags: [...initialTags],
    isSaving: false,
    errors: [],
    topLevelError: null,
    topLevelErrorDetails: {},
  }
}

/**
 * Boot the dataset form — used by both /publish/datasets/new
 * (mode='create') and /publish/datasets/:id/edit (mode='edit').
 * Idempotent — calling again resets the form to either defaults
 * (create) or the supplied `initial` row (edit).
 */
export function renderDatasetForm(
  content: HTMLElement,
  options: DatasetFormOptions,
): void {
  const state = initialState(
    options.mode,
    options.initial,
    options.initialKeywords ?? [],
    options.initialTags ?? [],
    options.dataUrl,
    options.thumbnailUrl,
    options.legendUrl,
  )
  // One lifecycle token per form mount, shared across every
  // renderForm call (internal re-renders included). Flipped to
  // disposed=true exactly once — when the router fires
  // ROUTE_CHANGE_START_EVENT — and stays flipped. Asset-uploader
  // onUploaded callbacks and any other deferred work check this
  // before mutating the DOM. The listener self-detaches on fire
  // so we don't leak one per form visit. PR #112 followup —
  // dataset-form.ts:disposed race.
  const lifecycle: { disposed: boolean } = { disposed: false }
  const onRouteStart = (): void => {
    lifecycle.disposed = true
    window.removeEventListener(ROUTE_CHANGE_START_EVENT, onRouteStart)
  }
  window.addEventListener(ROUTE_CHANGE_START_EVENT, onRouteStart)

  renderForm(content, state, {
    mode: options.mode,
    datasetId: options.initial?.id ?? null,
    isTranscoding: !!options.initial?.transcoding,
    fetchFn: options.fetchFn ?? globalThis.fetch,
    sleep: options.sleep ?? (ms => new Promise(r => setTimeout(r, ms))),
    navigate:
      options.navigate ??
      (url => {
        window.location.href = url
      }),
    routerNavigate:
      options.routerNavigate ??
      (path => {
        window.location.href = path
      }),
    lifecycle,
  })
}
