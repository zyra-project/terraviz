/**
 * `/publish/workflows/new` + `/publish/workflows/{id}/edit` — the
 * workflow form (Phase Z2 of `docs/ZYRA_INTEGRATION_PLAN.md`).
 *
 * The pipeline is authored as YAML (or JSON — `JSON.parse` is
 * tried first) in a textarea and converted to canonical JSON
 * client-side before save, keeping a YAML parser out of the Pages
 * Functions bundle; on edit, the stored JSON is rendered back to
 * YAML so the editor always shows Zyra's native dialect. The `yaml` package is lazy-imported on first
 * parse so it only ever loads inside the publisher chunk, and only
 * for publishers who actually open this form. Validate calls the
 * server's static dry-run (`POST /{id}/validate`); per-field
 * errors from save/validate render in a shared list.
 */

import { t } from '../../../i18n'
import { handleSessionError, type PublisherValidationError } from '../api'
import {
  createDraftDataset,
  createWorkflow,
  getWorkflow,
  patchWorkflow,
  validateWorkflow,
  type PublisherWorkflow,
  type WorkflowInputBody,
} from '../workflows-api'
import { STAGE_SNIPPETS, WORKFLOW_TEMPLATES } from '../workflow-templates'

export interface WorkflowEditPageOptions {
  navigate?: (url: string) => void
  getFn?: typeof getWorkflow
  createFn?: typeof createWorkflow
  patchFn?: typeof patchWorkflow
  validateFn?: typeof validateWorkflow
  /** Override the minimal-draft creation — tests inject a stub. */
  createDatasetFn?: typeof createDraftDataset
  /** Confirmation hook — defaults to `window.confirm`. */
  confirm?: (message: string) => boolean
  /** YAML parser injection point for tests (avoids the lazy import). */
  parseYaml?: (text: string) => unknown
  /** YAML serializer injection point for tests (avoids the lazy import). */
  stringifyYaml?: (value: unknown) => string
}

/** Schedule presets offered via a datalist; the field stays free
 *  text so any valid ISO-8601 duration in bounds works. */
const SCHEDULE_PRESETS = ['PT1H', 'PT6H', 'PT12H', 'P1D', 'P1W'] as const

/** Which form area a server validation error belongs to — drives
 *  the per-field highlighting (Phase Z3 richer validation
 *  surfacing). Exported for tests. */
export function errorArea(
  field: string,
): 'pipeline' | 'template' | 'name' | 'schedule' | 'target' | 'other' {
  if (field.startsWith('pipeline_json')) return 'pipeline'
  if (field.startsWith('metadata_template')) return 'template'
  if (field === 'name') return 'name'
  if (field === 'schedule') return 'schedule'
  if (field === 'target_dataset_id') return 'target'
  return 'other'
}

export async function renderWorkflowEditPage(
  content: HTMLElement,
  id: string | null,
  options: WorkflowEditPageOptions = {},
): Promise<void> {
  const navigate = options.navigate ?? ((url: string) => window.location.assign(url))
  const getFn = options.getFn ?? getWorkflow

  let existing: PublisherWorkflow | null = null
  let pipelineDisplay = ''
  if (id) {
    content.replaceChildren(messageShell(t('publisher.workflows.loading')))
    const result = await getFn(id)
    if (!result.ok) {
      if (result.kind === 'session' && handleSessionError({ navigate }) === 'navigating') return
      content.replaceChildren(messageShell(t('publisher.workflows.error')))
      return
    }
    existing = result.data.workflow
    // Storage is canonical JSON, but publishers author and read
    // YAML — it's what Zyra produces and saves natively — so the
    // editor round-trips the stored pipeline back to YAML for
    // display. Save converts YAML→JSON as before.
    pipelineDisplay = await toDisplayYaml(existing.pipeline_json, options.stringifyYaml)
  }

  content.replaceChildren(buildForm(existing, pipelineDisplay, navigate, options))
}

/** Stored canonical JSON → display YAML. Falls back to the raw
 *  stored string when it doesn't parse (it is still editable, and
 *  save-side validation reports the real problem). */
async function toDisplayYaml(
  pipelineJson: string,
  stringifyYaml?: (value: unknown) => string,
): Promise<string> {
  try {
    const parsed = JSON.parse(pipelineJson) as unknown
    const stringify = stringifyYaml ?? (await import('yaml')).stringify
    return stringify(parsed)
  } catch {
    return pipelineJson
  }
}

function messageShell(message: string): HTMLElement {
  const shell = document.createElement('main')
  shell.className = 'publisher-shell'
  const card = document.createElement('section')
  card.className = 'publisher-card publisher-glass publisher-empty'
  const p = document.createElement('p')
  p.className = 'publisher-empty-message'
  p.textContent = message
  card.appendChild(p)
  shell.appendChild(card)
  return shell
}

interface Field {
  input: HTMLInputElement | HTMLTextAreaElement
  wrap: HTMLElement
}

function buildField(
  label: string,
  hint: string | null,
  input: HTMLInputElement | HTMLTextAreaElement,
): Field {
  const wrap = document.createElement('label')
  wrap.className = 'publisher-form-field'
  const caption = document.createElement('span')
  caption.className = 'publisher-form-label'
  caption.textContent = label
  wrap.appendChild(caption)
  wrap.appendChild(input)
  if (hint) {
    const hintEl = document.createElement('span')
    hintEl.className = 'publisher-form-help'
    hintEl.textContent = hint
    wrap.appendChild(hintEl)
  }
  return { input, wrap }
}

function buildForm(
  existing: PublisherWorkflow | null,
  pipelineDisplay: string,
  navigate: (url: string) => void,
  options: WorkflowEditPageOptions,
): HTMLElement {
  const createFn = options.createFn ?? createWorkflow
  const patchFn = options.patchFn ?? patchWorkflow
  const validateFn = options.validateFn ?? validateWorkflow

  const shell = document.createElement('main')
  shell.className = 'publisher-shell'

  const h2 = document.createElement('h2')
  h2.textContent = existing
    ? t('publisher.workflows.form.heading.edit')
    : t('publisher.workflows.form.heading.new')
  shell.appendChild(h2)

  const form = document.createElement('form')
  form.className = 'publisher-card publisher-glass publisher-form'

  const name = document.createElement('input')
  name.className = 'publisher-form-input'
  name.type = 'text'
  name.required = true
  name.value = existing?.name ?? ''
  form.appendChild(buildField(t('publisher.workflows.form.name'), null, name).wrap)

  const description = document.createElement('input')
  description.className = 'publisher-form-input'
  description.type = 'text'
  description.value = existing?.description ?? ''
  form.appendChild(buildField(t('publisher.workflows.form.description'), null, description).wrap)

  const schedule = document.createElement('input')
  schedule.className = 'publisher-form-input'
  schedule.type = 'text'
  schedule.required = true
  schedule.value = existing?.schedule ?? 'P1D'
  schedule.setAttribute('list', 'workflow-schedule-presets')
  const datalist = document.createElement('datalist')
  datalist.id = 'workflow-schedule-presets'
  for (const preset of SCHEDULE_PRESETS) {
    const option = document.createElement('option')
    option.value = preset
    datalist.appendChild(option)
  }
  const scheduleField = buildField(
    t('publisher.workflows.form.schedule'),
    t('publisher.workflows.form.schedule.hint'),
    schedule,
  )
  scheduleField.wrap.appendChild(datalist)
  form.appendChild(scheduleField.wrap)

  const target = document.createElement('input')
  target.className = 'publisher-form-input'
  target.type = 'text'
  target.required = true
  target.value = existing?.target_dataset_id ?? ''
  const targetField = buildField(
    t('publisher.workflows.form.target'),
    t('publisher.workflows.form.target.hint'),
    target,
  )
  // Phase Z3 — create the draft shell without leaving the form.
  const createTargetBtn = document.createElement('button')
  createTargetBtn.type = 'button'
  createTargetBtn.className = 'publisher-tab publisher-workflow-create-target'
  createTargetBtn.textContent = t('publisher.workflows.form.createTarget')
  const createTargetStatus = document.createElement('span')
  createTargetStatus.className = 'publisher-row-action-status'
  createTargetBtn.addEventListener('click', () => {
    const createDataset = options.createDatasetFn ?? createDraftDataset
    const title = name.value.trim()
    if (title.length < 3) {
      createTargetStatus.textContent = t('publisher.workflows.form.createTarget.needName')
      createTargetStatus.classList.add('publisher-row-action-status-error')
      return
    }
    createTargetBtn.disabled = true
    createTargetStatus.classList.remove('publisher-row-action-status-error')
    createTargetStatus.textContent = t('publisher.workflows.form.createTarget.creating')
    void createDataset(title)
      .then(result => {
        if (!result.ok) {
          createTargetStatus.textContent = t('publisher.workflows.form.createTarget.failed')
          createTargetStatus.classList.add('publisher-row-action-status-error')
          return
        }
        target.value = result.data.dataset.id
        createTargetStatus.textContent = t('publisher.workflows.form.createTarget.done')
      })
      // publisherSend resolves with an error envelope rather than
      // rejecting, but a thrown stub or unexpected exception must
      // not leave the button stuck on "Creating…" (PR #178 Copilot
      // review).
      .catch(() => {
        createTargetStatus.textContent = t('publisher.workflows.form.createTarget.failed')
        createTargetStatus.classList.add('publisher-row-action-status-error')
      })
      .finally(() => {
        createTargetBtn.disabled = false
      })
  })
  form.appendChild(targetField.wrap)
  // Interactive controls must not nest inside the field's <label>
  // (invalid semantics; label activation steals the click) — the
  // action row is a sibling (PR #178 Copilot review).
  const targetActions = document.createElement('div')
  targetActions.className = 'publisher-form-actions publisher-workflow-target-actions'
  targetActions.appendChild(createTargetBtn)
  targetActions.appendChild(createTargetStatus)
  form.appendChild(targetActions)

  const pipeline = document.createElement('textarea')
  pipeline.className = 'publisher-form-input publisher-form-textarea'
  pipeline.rows = 14
  pipeline.spellcheck = false
  pipeline.value = pipelineDisplay

  const template = document.createElement('textarea')

  // Phase Z3 — guided authoring: a template picker that seeds both
  // textareas, and an insert-stage palette generated from the same
  // allowlist the server validates against.
  const confirmFn = options.confirm ?? ((message: string) => window.confirm(message))
  const guided = document.createElement('div')
  guided.className = 'publisher-form-field publisher-workflow-guided'

  const templatePicker = document.createElement('select')
  templatePicker.className = 'publisher-form-input'
  templatePicker.setAttribute('aria-label', t('publisher.workflows.form.templatePicker'))
  const templateBlank = document.createElement('option')
  templateBlank.value = ''
  templateBlank.textContent = t('publisher.workflows.form.templatePicker')
  templatePicker.appendChild(templateBlank)
  for (const wt of WORKFLOW_TEMPLATES) {
    const option = document.createElement('option')
    option.value = wt.id
    option.textContent = t(wt.labelKey)
    templatePicker.appendChild(option)
  }
  templatePicker.addEventListener('change', () => {
    const chosen = WORKFLOW_TEMPLATES.find(wt => wt.id === templatePicker.value)
    if (!chosen) return
    const dirty = pipeline.value.trim().length > 0 || template.value.trim().length > 0
    if (dirty && !confirmFn(t('publisher.workflows.form.template.overwriteConfirm'))) {
      templatePicker.value = ''
      return
    }
    pipeline.value = chosen.pipelineYaml
    template.value = chosen.metadataTemplate
    statusLine.textContent = t('publisher.workflows.form.template.applied')
  })
  guided.appendChild(templatePicker)

  const stagePicker = document.createElement('select')
  stagePicker.className = 'publisher-form-input'
  stagePicker.setAttribute('aria-label', t('publisher.workflows.form.insertStage'))
  const stageBlank = document.createElement('option')
  stageBlank.value = ''
  stageBlank.textContent = t('publisher.workflows.form.insertStage')
  stagePicker.appendChild(stageBlank)
  for (const snippet of STAGE_SNIPPETS) {
    const option = document.createElement('option')
    option.value = snippet.id
    option.textContent = snippet.id // i18n-exempt: Zyra stage/command identifiers
    stagePicker.appendChild(option)
  }
  stagePicker.addEventListener('change', () => {
    const chosen = STAGE_SNIPPETS.find(sn => sn.id === stagePicker.value)
    stagePicker.value = ''
    if (!chosen) return
    void (async () => {
      // Snippets are YAML; if the textarea currently holds JSON
      // (pasted by the user, or the unparsable-fallback path),
      // appending YAML would create an unparseable mix — convert
      // to YAML first (PR #178 Copilot review).
      let current = pipeline.value
      if (current.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(current) as unknown
          const stringify = options.stringifyYaml ?? (await import('yaml')).stringify
          current = stringify(parsed)
        } catch {
          // Leave as-is; Validate will surface the real problem.
        }
      }
      if (current.trim().length === 0) current = 'stages:\n'
      if (!current.endsWith('\n')) current += '\n'
      pipeline.value = current + chosen.snippet
    })()
  })
  guided.appendChild(stagePicker)
  form.appendChild(guided)

  form.appendChild(
    buildField(
      t('publisher.workflows.form.pipeline'),
      t('publisher.workflows.form.pipeline.hint'),
      pipeline,
    ).wrap,
  )

  template.className = 'publisher-form-input publisher-form-textarea'
  template.rows = 8
  template.spellcheck = false
  template.value = existing ? prettyJson(existing.metadata_template) : ''
  form.appendChild(
    buildField(
      t('publisher.workflows.form.template'),
      t('publisher.workflows.form.template.hint'),
      template,
    ).wrap,
  )

  const enabledWrap = document.createElement('label')
  enabledWrap.className = 'publisher-form-field publisher-form-radio'
  const enabled = document.createElement('input')
  enabled.type = 'checkbox'
  enabled.checked = existing?.enabled ?? false
  enabledWrap.appendChild(enabled)
  const enabledLabel = document.createElement('span')
  enabledLabel.textContent = t('publisher.workflows.form.enabled')
  enabledWrap.appendChild(enabledLabel)
  form.appendChild(enabledWrap)

  const errorList = document.createElement('ul')
  errorList.className = 'publisher-form-error'
  form.appendChild(errorList)

  const statusLine = document.createElement('p')
  statusLine.className = 'publisher-form-help'
  form.appendChild(statusLine)

  const buttons = document.createElement('div')
  buttons.className = 'publisher-form-actions'

  const validateBtn = document.createElement('button')
  validateBtn.type = 'button'
  validateBtn.className = 'publisher-tab'
  validateBtn.textContent = t('publisher.workflows.form.validate')
  buttons.appendChild(validateBtn)

  const saveBtn = document.createElement('button')
  saveBtn.type = 'submit'
  saveBtn.className = 'publisher-tab publisher-tab-active'
  saveBtn.textContent = t('publisher.workflows.form.save')
  buttons.appendChild(saveBtn)
  form.appendChild(buttons)

  // Phase Z3 — richer validation surfacing: highlight the form
  // area each server error belongs to alongside the grouped list.
  // Complete over errorArea()'s range so 'other' errors still get
  // a visible anchor — the grouped list itself (PR #178 Copilot
  // review). tabindex makes the list focusable for the
  // first-offender focus below.
  errorList.tabIndex = -1
  const areaInputs: Record<ReturnType<typeof errorArea>, HTMLElement> = {
    pipeline,
    template,
    name,
    schedule,
    target,
    other: errorList,
  }
  const showErrors = (errors: PublisherValidationError[]): void => {
    for (const input of Object.values(areaInputs)) input.removeAttribute('aria-invalid')
    errorList.replaceChildren(
      ...errors.map(err => {
        const area = errorArea(err.field)
        if (area !== 'other') areaInputs[area].setAttribute('aria-invalid', 'true')
        const li = document.createElement('li')
        li.textContent = `${err.field}: ${err.message}` // i18n-exempt: server-side validation messages are en-only in v1
        return li
      }),
    )
    errors[0] && areaInputs[errorArea(errors[0].field)].focus()
  }

  const collectBody = async (): Promise<WorkflowInputBody | null> => {
    errorList.replaceChildren()
    statusLine.textContent = ''
    let pipelineJson: string
    try {
      pipelineJson = await toCanonicalJson(pipeline.value, options.parseYaml)
    } catch {
      statusLine.textContent = t('publisher.workflows.form.pipelineParseError')
      return null
    }
    let templateJson: string
    try {
      templateJson = await toCanonicalJson(template.value, options.parseYaml)
    } catch {
      statusLine.textContent = t('publisher.workflows.form.templateParseError')
      return null
    }
    return {
      name: name.value,
      description: description.value || null,
      schedule: schedule.value.trim(),
      target_dataset_id: target.value.trim(),
      pipeline_json: pipelineJson,
      metadata_template: templateJson,
      enabled: enabled.checked,
    }
  }

  validateBtn.addEventListener('click', () => {
    void (async () => {
      const body = await collectBody()
      if (!body) return
      validateBtn.disabled = true
      // /new has no row id yet; the validate route ignores the id,
      // so a placeholder segment keeps one endpoint serving both.
      const result = await validateFn(existing?.id ?? 'new', body)
      validateBtn.disabled = false
      if (!result.ok) {
        if (result.kind === 'validation') showErrors(result.errors)
        else statusLine.textContent = t('publisher.workflows.error')
        return
      }
      if (result.data.ok) {
        statusLine.textContent = t('publisher.workflows.form.validate.ok')
      } else {
        showErrors(result.data.errors ?? [])
      }
    })()
  })

  form.addEventListener('submit', e => {
    e.preventDefault()
    void (async () => {
      const body = await collectBody()
      if (!body) return
      saveBtn.disabled = true
      saveBtn.textContent = t('publisher.workflows.form.saving')
      const result = existing ? await patchFn(existing.id, body) : await createFn(body)
      saveBtn.disabled = false
      saveBtn.textContent = t('publisher.workflows.form.save')
      if (!result.ok) {
        if (result.kind === 'validation') showErrors(result.errors)
        else if (result.kind === 'session' && handleSessionError({ navigate }) === 'navigating') return
        else statusLine.textContent = t('publisher.workflows.error')
        return
      }
      navigate(`/publish/workflows/${encodeURIComponent(result.data.workflow.id)}`)
    })()
  })

  shell.appendChild(form)
  return shell
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/**
 * Canonicalize the textarea content to a JSON string. JSON input
 * passes through `JSON.parse` directly; anything else goes through
 * the lazily-imported YAML parser. Throws when neither parser
 * accepts the text or it parses to a non-object.
 */
async function toCanonicalJson(
  text: string,
  parseYaml?: (text: string) => unknown,
): Promise<string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    const parse = parseYaml ?? (await import('yaml')).parse
    parsed = parse(text)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('not an object')
  }
  return JSON.stringify(parsed)
}
