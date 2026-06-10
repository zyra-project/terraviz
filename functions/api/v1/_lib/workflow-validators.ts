/**
 * Body validation for the Zyra workflow API (Phase Z1,
 * `docs/ZYRA_INTEGRATION_PLAN.md` §API surface).
 *
 * Three surfaces, one error envelope (`{ field, code, message }`,
 * matching `validators.ts` so the portal client's existing
 * validation-error parsing covers these routes too):
 *
 *   - `validatePipeline`     — the security boundary. Every stage/
 *     command pair must be on `ZYRA_STAGE_ALLOWLIST`, args must be
 *     scalar and bounded, and at least one arg must equal
 *     `WORKFLOW_OUTPUT_PATH` so the publish leg has an MP4 to find.
 *     Enforced at save AND re-enforced at dispatch time — a row
 *     edited around the API (or saved under an older allowlist)
 *     doesn't get to run.
 *   - `validateMetadataTemplate` — keys restricted to the dataset-
 *     PATCH subset, placeholders restricted to the known variables.
 *   - `validateWorkflowInput` — the whole create/PATCH body.
 */

import {
  MAX_ERROR_SUMMARY_LENGTH,
  MAX_METADATA_TEMPLATE_BYTES,
  MAX_PIPELINE_ARG_LENGTH,
  MAX_PIPELINE_JSON_BYTES,
  MAX_PIPELINE_STAGES,
  METADATA_TEMPLATE_ALLOWED_FIELDS,
  METADATA_TEMPLATE_VARIABLES,
  WORKFLOW_OUTPUT_PATH,
  WORKFLOW_RUN_STATUSES,
  ZYRA_STAGE_ALLOWLIST,
  type WorkflowRunStatus,
} from '../../../../src/types/zyra-workflow-constants'
import { isValidSchedule } from './workflow-schedule'

export interface WorkflowValidationError {
  field: string
  code: string
  message: string
}

function err(field: string, code: string, message: string): WorkflowValidationError {
  return { field, code, message }
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/
const PLACEHOLDER_RE = /\{\{\s*([a-z_]+)\s*\}\}/g

// --- Pipeline -----------------------------------------------------

export function validatePipeline(
  pipelineJson: unknown,
  errors: WorkflowValidationError[],
): void {
  if (typeof pipelineJson !== 'string') {
    errors.push(err('pipeline_json', 'required', 'pipeline_json is required (a JSON string).'))
    return
  }
  if (pipelineJson.length > MAX_PIPELINE_JSON_BYTES) {
    errors.push(
      err('pipeline_json', 'too_large', `Pipeline JSON must be ≤ ${MAX_PIPELINE_JSON_BYTES} bytes.`),
    )
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(pipelineJson)
  } catch {
    errors.push(err('pipeline_json', 'invalid_json', 'Pipeline is not valid JSON.'))
    return
  }
  const stages = (parsed as { stages?: unknown })?.stages
  if (!Array.isArray(stages) || stages.length === 0) {
    errors.push(err('pipeline_json', 'invalid_shape', 'Pipeline must be { stages: [...] } with at least one stage.'))
    return
  }
  if (stages.length > MAX_PIPELINE_STAGES) {
    errors.push(err('pipeline_json', 'too_many_stages', `Pipeline must have ≤ ${MAX_PIPELINE_STAGES} stages.`))
    return
  }

  let writesOutput = false
  stages.forEach((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      errors.push(err(`pipeline_json.stages[${i}]`, 'invalid_shape', 'Stage must be an object.'))
      return
    }
    const { stage, command, args } = entry as {
      stage?: unknown
      command?: unknown
      args?: unknown
    }
    const allowedCommands =
      typeof stage === 'string' ? ZYRA_STAGE_ALLOWLIST[stage] : undefined
    if (!allowedCommands) {
      errors.push(
        err(
          `pipeline_json.stages[${i}].stage`,
          'not_allowlisted',
          `Stage must be one of: ${Object.keys(ZYRA_STAGE_ALLOWLIST).join(', ')}.`,
        ),
      )
      return
    }
    if (typeof command !== 'string' || !allowedCommands.includes(command)) {
      errors.push(
        err(
          `pipeline_json.stages[${i}].command`,
          'not_allowlisted',
          `Command for stage "${String(stage)}" must be one of: ${allowedCommands.join(', ')}.`,
        ),
      )
      return
    }
    if (args !== undefined) {
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        errors.push(err(`pipeline_json.stages[${i}].args`, 'invalid_shape', 'args must be an object.'))
        return
      }
      for (const [key, value] of Object.entries(args)) {
        const kind = typeof value
        if (kind !== 'string' && kind !== 'number' && kind !== 'boolean') {
          errors.push(
            err(`pipeline_json.stages[${i}].args.${key}`, 'invalid_value', 'Arg values must be string, number, or boolean.'),
          )
          continue
        }
        if (kind === 'string' && (value as string).length > MAX_PIPELINE_ARG_LENGTH) {
          errors.push(
            err(`pipeline_json.stages[${i}].args.${key}`, 'too_long', `Arg values must be ≤ ${MAX_PIPELINE_ARG_LENGTH} characters.`),
          )
          continue
        }
        if (value === WORKFLOW_OUTPUT_PATH) writesOutput = true
      }
    }
  })

  if (errors.length === 0 && !writesOutput) {
    errors.push(
      err(
        'pipeline_json',
        'missing_output',
        `At least one stage arg must equal "${WORKFLOW_OUTPUT_PATH}" — the publish leg reads the MP4 from there.`,
      ),
    )
  }
}

// --- Metadata template ---------------------------------------------

export function validateMetadataTemplate(
  template: unknown,
  errors: WorkflowValidationError[],
): void {
  if (typeof template !== 'string') {
    errors.push(err('metadata_template', 'required', 'metadata_template is required (a JSON string).'))
    return
  }
  if (template.length > MAX_METADATA_TEMPLATE_BYTES) {
    errors.push(
      err('metadata_template', 'too_large', `Template must be ≤ ${MAX_METADATA_TEMPLATE_BYTES} bytes.`),
    )
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(template)
  } catch {
    errors.push(err('metadata_template', 'invalid_json', 'Template is not valid JSON.'))
    return
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    errors.push(err('metadata_template', 'invalid_shape', 'Template must be a JSON object.'))
    return
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!METADATA_TEMPLATE_ALLOWED_FIELDS.includes(key)) {
      errors.push(
        err(
          `metadata_template.${key}`,
          'unknown_field',
          `Template fields must be one of: ${METADATA_TEMPLATE_ALLOWED_FIELDS.join(', ')}.`,
        ),
      )
      continue
    }
    const strings: string[] =
      typeof value === 'string'
        ? [value]
        : Array.isArray(value) && value.every(v => typeof v === 'string')
          ? (value as string[])
          : []
    if (strings.length === 0 && typeof value !== 'string') {
      errors.push(
        err(`metadata_template.${key}`, 'invalid_value', 'Template values must be strings or string arrays.'),
      )
      continue
    }
    for (const s of strings) {
      for (const match of s.matchAll(PLACEHOLDER_RE)) {
        if (!METADATA_TEMPLATE_VARIABLES.includes(match[1])) {
          errors.push(
            err(
              `metadata_template.${key}`,
              'unknown_placeholder',
              `Unknown placeholder "${match[1]}". Available: ${METADATA_TEMPLATE_VARIABLES.join(', ')}.`,
            ),
          )
        }
      }
    }
  }
}

// --- Whole-body validation ------------------------------------------

export interface WorkflowInput {
  name: string
  description: string | null
  pipeline_json: string
  metadata_template: string
  schedule: string
  enabled: boolean
  target_dataset_id: string
}

/**
 * Validate a create body (`required = true`) or a PATCH body
 * (`required = false` — only supplied fields are checked; returns
 * the validated subset).
 */
export function validateWorkflowInput(
  body: unknown,
  required: boolean,
):
  | { ok: true; value: Partial<WorkflowInput> }
  | { ok: false; errors: WorkflowValidationError[] } {
  const errors: WorkflowValidationError[] = []
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, errors: [err('body', 'invalid_body', 'Body must be a JSON object.')] }
  }
  const b = body as Record<string, unknown>
  const value: Partial<WorkflowInput> = {}

  if (b.name !== undefined || required) {
    if (typeof b.name !== 'string' || b.name.trim().length < 3 || b.name.trim().length > 120) {
      errors.push(err('name', 'invalid_value', 'Name must be a string of 3–120 characters.'))
    } else {
      value.name = b.name.trim()
    }
  }
  if (b.description !== undefined) {
    if (b.description !== null && (typeof b.description !== 'string' || b.description.length > 2000)) {
      errors.push(err('description', 'invalid_value', 'Description must be ≤ 2000 characters (or null).'))
    } else {
      value.description = (b.description as string | null)
    }
  }
  if (b.pipeline_json !== undefined || required) {
    validatePipeline(b.pipeline_json, errors)
    if (typeof b.pipeline_json === 'string') value.pipeline_json = b.pipeline_json
  }
  if (b.metadata_template !== undefined || required) {
    validateMetadataTemplate(b.metadata_template, errors)
    if (typeof b.metadata_template === 'string') value.metadata_template = b.metadata_template
  }
  if (b.schedule !== undefined || required) {
    if (typeof b.schedule !== 'string' || !isValidSchedule(b.schedule)) {
      errors.push(
        err('schedule', 'invalid_value', 'Schedule must be an ISO-8601 duration between PT15M and P90D (e.g. PT1H, P1D, P1W).'),
      )
    } else {
      value.schedule = b.schedule
    }
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') {
      errors.push(err('enabled', 'invalid_value', 'enabled must be a boolean.'))
    } else {
      value.enabled = b.enabled
    }
  }
  if (b.target_dataset_id !== undefined || required) {
    if (typeof b.target_dataset_id !== 'string' || !ULID_RE.test(b.target_dataset_id)) {
      errors.push(err('target_dataset_id', 'invalid_value', 'target_dataset_id must be a dataset ULID.'))
    } else {
      value.target_dataset_id = b.target_dataset_id
    }
  }
  // v1 is overwrite-only; reject attempts to set anything else so a
  // future append mode is an explicit migration, not a latent enum.
  if (b.update_mode !== undefined && b.update_mode !== 'overwrite') {
    errors.push(err('update_mode', 'invalid_value', 'update_mode must be "overwrite" in v1.'))
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value }
}

// --- Run-status callback ---------------------------------------------

export interface RunStatusInput {
  status: WorkflowRunStatus
  gha_run_id: string | null
  upload_id: string | null
  error_summary: string | null
}

export function validateRunStatusInput(
  body: unknown,
): { ok: true; value: RunStatusInput } | { ok: false; errors: WorkflowValidationError[] } {
  const errors: WorkflowValidationError[] = []
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, errors: [err('body', 'invalid_body', 'Body must be a JSON object.')] }
  }
  const b = body as Record<string, unknown>
  if (
    typeof b.status !== 'string' ||
    !(WORKFLOW_RUN_STATUSES as readonly string[]).includes(b.status) ||
    b.status === 'queued'
  ) {
    errors.push(
      err('status', 'invalid_value', 'status must be one of: running, succeeded, failed, canceled.'),
    )
  }
  if (b.gha_run_id !== undefined && b.gha_run_id !== null && !/^\d{1,20}$/.test(String(b.gha_run_id))) {
    errors.push(err('gha_run_id', 'invalid_value', 'gha_run_id must be a numeric GitHub Actions run id.'))
  }
  if (b.upload_id !== undefined && b.upload_id !== null && !ULID_RE.test(String(b.upload_id))) {
    errors.push(err('upload_id', 'invalid_value', 'upload_id must be a ULID.'))
  }
  if (b.error_summary !== undefined && b.error_summary !== null && typeof b.error_summary !== 'string') {
    errors.push(err('error_summary', 'invalid_value', 'error_summary must be a string.'))
  }
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      status: b.status as WorkflowRunStatus,
      gha_run_id: b.gha_run_id == null ? null : String(b.gha_run_id),
      upload_id: b.upload_id == null ? null : String(b.upload_id),
      error_summary:
        b.error_summary == null
          ? null
          : String(b.error_summary).slice(0, MAX_ERROR_SUMMARY_LENGTH),
    },
  }
}
