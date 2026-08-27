// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { WORKFLOW_TEMPLATES } from '../../src/ui/publisher/workflow-templates'
import {
  validateMetadataTemplate,
  validatePipeline,
  type WorkflowValidationError,
} from '../../functions/api/v1/_lib/workflow-validators'
import { buildRunVars, renderSidecar } from './workflow-sidecar'
import { renderPipelineJson } from '../../src/types/zyra-pipeline-args'

/**
 * The templates are what the picker hands a user as a starting
 * point, so a typo in one is a broken save with no obvious cause.
 * Run each through the same validators `/validate` uses, then
 * through the runner's interpolation, so both halves are exercised
 * on the shipped text rather than on a paraphrase of it.
 *
 * Lives under `cli/` rather than beside the templates because the
 * dependency direction here is one-way — `functions/` and `cli/`
 * import from `src/`, never the reverse — and this test needs the
 * validator and the runner as well as the templates themselves.
 */

const CTX = { now: new Date('2026-07-24T13:07:00Z'), runId: '01HX0000000000000000000000' }

describe.each(WORKFLOW_TEMPLATES.map(t => [t.id, t] as const))('template %s', (_id, template) => {
  const pipelineJson = JSON.stringify(parseYaml(template.pipelineYaml))

  it('saves clean through /validate', () => {
    const errors: WorkflowValidationError[] = []
    validatePipeline(pipelineJson, errors)
    validateMetadataTemplate(template.metadataTemplate, errors)
    expect(errors).toEqual([])
  })

  it('interpolates without leaving braces behind', () => {
    const rendered = renderPipelineJson(pipelineJson, CTX)
    expect(rendered).not.toContain('{{')

    // No frames-meta: the state a run is in before its pipeline has
    // produced one, and permanently for templates with no
    // scan-frames stage.
    const vars = buildRunVars({ runId: CTX.runId, now: CTX.now })
    const { fields } = renderSidecar(JSON.parse(template.metadataTemplate), vars)
    for (const value of Object.values(fields)) {
      expect(JSON.stringify(value)).not.toContain('{{')
    }
  })
})

describe('the model-cycle template', () => {
  const template = WORKFLOW_TEMPLATES.find(t => t.id === 'gefs-cycle-sos')!

  it('names frames by valid time so the dates survive the chain', () => {
    // GEFS filenames are cycle-relative (f000/f006, no date), so the
    // whole point is that --output-names replaces them downstream.
    const rendered = renderPipelineJson(
      JSON.stringify(parseYaml(template.pipelineYaml)),
      CTX,
    )
    const stages = JSON.parse(rendered).stages
    expect(stages[0].args['output-names']).toEqual([
      '20260724T060000.tif',
      '20260724T120000.tif',
    ])
    // The next stage has to read the renamed files, not the sources.
    expect(stages[1].args.inputs).toEqual([
      '/work/tif/20260724T060000.tif',
      '/work/tif/20260724T120000.tif',
    ])
  })

  it('publishes real dates with no frames-meta at all', () => {
    // The reason valid_iso exists: this template has no scan-frames
    // stage, so data_start/data_end would be null and every dated
    // field would drop.
    const vars = buildRunVars({ runId: CTX.runId, now: CTX.now })
    const { fields, warnings } = renderSidecar(JSON.parse(template.metadataTemplate), vars)
    expect(warnings).toEqual([])
    expect(fields.start_time).toBe('2026-07-24T06:00:00Z')
    expect(fields.end_time).toBe('2026-07-24T12:00:00Z')
  })
})
