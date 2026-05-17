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
import { renderAssetUploader } from './asset-uploader'
import { renderMarkdown } from '../../../services/markdownRenderer'
import type { PublisherDatasetDetail } from '../types'
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
  // Categorization (3pc/C3b). Both arrays cap at 20 entries
  // server-side; chip-input applies the same cap so the UI
  // matches the validator.
  keywords: ReadonlyArray<string>
  tags: ReadonlyArray<string>
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
  input.type = 'text'
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

function licensingCard(state: FormState, update: () => void): HTMLElement {
  const card = document.createElement('section')
  card.className = 'publisher-card publisher-glass publisher-form-card'

  const heading = document.createElement('h2')
  heading.className = 'publisher-card-heading'
  heading.textContent = t('publisher.datasetForm.section.licensing')
  card.appendChild(heading)

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
}

function renderForm(
  content: HTMLElement,
  state: FormState,
  ctx: RenderContext,
): void {
  const shell = document.createElement('main')
  shell.className = 'publisher-shell'

  shell.appendChild(backLink())

  const heading = document.createElement('h1')
  heading.className = 'publisher-detail-title'
  heading.textContent =
    ctx.mode === 'edit'
      ? t('publisher.datasetForm.headingEdit')
      : t('publisher.datasetForm.headingNew')
  shell.appendChild(heading)

  if (state.topLevelError) {
    shell.appendChild(renderTopLevelError(state.topLevelError, state.topLevelErrorDetails))
  }

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

  // data_ref is required by `validateForPublish` server-side but
  // draft-saveable empty. In create mode the dataset id doesn't
  // exist yet — the uploader needs an id to scope its
  // /asset endpoint against — so we keep the manual ref input as
  // a fallback for `vimeo:` / external URLs. In edit mode we hand
  // off to the asset uploader (3pd/C); the manual ref input stays
  // available for the non-upload paths (legacy / external).
  if (ctx.mode === 'edit' && ctx.datasetId && ctx.isTranscoding) {
    // Row is currently mid-transcode — the parent detail page is
    // polling and will navigate the publisher back here once the
    // workflow finishes. Replace both the uploader and the
    // manual ref input with a read-only notice so the publisher
    // doesn't try to start a second upload (which the server-side
    // `transcoding_in_progress` guard would 409 anyway) or paste
    // a manual ref into a row whose data_ref is about to be
    // overwritten by /transcode-complete. Mirrors the publish-
    // button gate on the detail page.
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
    identityCard.appendChild(refDisplay)
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
    uploaderWrap.appendChild(
      renderAssetUploader({
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
          // PR #112 followup — dataset-form.ts:onUploaded race.
          if (disposed) return
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
          } else {
            state.dataRef = ''
            ctx.isTranscoding = true
            update()
          }
        },
      }),
    )
    identityCard.appendChild(uploaderWrap)
    // Manual ref input — for editors who want to swap to a
    // legacy `vimeo:` / `url:` ref or paste an already-encoded
    // `r2:videos/...` value without re-uploading bytes.
    identityCard.appendChild(
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
    // Create-mode fallback — the publisher can still paste a
    // `vimeo:` ref or an external URL by hand. Once the draft
    // saves and they navigate to the edit page, the uploader
    // shows up.
    identityCard.appendChild(
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

  form.appendChild(identityCard)
  form.appendChild(abstractCard(state, update))
  form.appendChild(licensingCard(state, update))
  form.appendChild(timeRangeCard(state))
  form.appendChild(categorizationCard(state))

  // Submit row.
  const actions = document.createElement('div')
  actions.className = 'publisher-form-actions'

  const cancel = document.createElement('a')
  cancel.href = '/publish/datasets'
  cancel.className = 'publisher-button publisher-button-secondary'
  cancel.textContent = t('publisher.datasetForm.action.cancel')
  cancel.addEventListener('click', e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    // In edit mode the natural cancel target is the detail page
    // the publisher arrived from; in create mode it's the list.
    if (ctx.mode === 'edit' && ctx.datasetId) {
      ctx.routerNavigate(`/publish/datasets/${encodeURIComponent(ctx.datasetId)}`)
    } else {
      ctx.routerNavigate('/publish/datasets')
    }
  })
  actions.appendChild(cancel)

  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'publisher-button publisher-button-primary'
  submit.textContent = state.isSaving
    ? t('publisher.datasetForm.action.saving')
    : t('publisher.datasetForm.action.saveDraft')
  submit.disabled = state.isSaving
  actions.appendChild(submit)

  form.appendChild(actions)

  shell.appendChild(form)
  content.replaceChildren(shell)

  // Track whether this form mount is still the active page so
  // deferred callbacks (notably the asset-uploader's onUploaded,
  // which can fire after a multi-minute upload completes) don't
  // clobber the next page's DOM if the user navigated away while
  // the upload was in flight. The router fires
  // ROUTE_CHANGE_START_EVENT before the destination handler
  // renders into `content`; from that moment any update() or
  // post-upload DOM mutation from this form mount is unsafe.
  // The listener detaches itself the moment it fires (so we don't
  // accumulate one listener per form visit — PR #112 followup
  // fixed the original leak), and update() also detaches it
  // before re-rendering (which immediately re-binds a fresh
  // listener on the new mount).
  let disposed = false
  const onRouteStart = (): void => {
    disposed = true
    window.removeEventListener(ROUTE_CHANGE_START_EVENT, onRouteStart)
  }
  window.addEventListener(ROUTE_CHANGE_START_EVENT, onRouteStart)

  function update(): void {
    if (disposed) return
    window.removeEventListener(ROUTE_CHANGE_START_EVENT, onRouteStart)
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
      ctx.routerNavigate(
        `/publish/datasets/${encodeURIComponent(result.data.dataset.id)}`,
      )
      return
    }
    if (result.kind === 'validation') {
      state.errors = result.errors
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
): FormState {
  if (mode === 'create' || !row) {
    return {
      title: '',
      slug: '',
      slugLocked: false,
      format: 'video/mp4',
      visibility: 'public',
      dataRef: '',
      organization: '',
      abstract: '',
      abstractPreviewing: false,
      licenseSpdx: '',
      licenseUrl: '',
      licenseStatement: '',
      attributionText: '',
      rightsHolder: '',
      doi: '',
      citationText: '',
      startDate: '',
      startTime: '',
      endDate: '',
      endTime: '',
      period: '',
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
    format: row.format,
    visibility: row.visibility,
    dataRef: row.data_ref ?? '',
    organization: row.organization ?? '',
    abstract: row.abstract ?? '',
    abstractPreviewing: false,
    licenseSpdx: row.license_spdx ?? '',
    licenseUrl: row.license_url ?? '',
    licenseStatement: row.license_statement ?? '',
    attributionText: row.attribution_text ?? '',
    rightsHolder: row.rights_holder ?? '',
    doi: row.doi ?? '',
    citationText: row.citation_text ?? '',
    startDate,
    startTime,
    endDate,
    endTime,
    period: row.period ?? '',
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
  )
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
  })
}
