import { describe, it, expect, beforeEach, vi } from 'vitest'
import { errorArea, renderWorkflowEditPage } from './workflow-edit'
import { WORKFLOW_TEMPLATES } from '../workflow-templates'

describe('errorArea', () => {
  it('maps server validation fields onto form areas', () => {
    expect(errorArea('pipeline_json.stages[2].command')).toBe('pipeline')
    expect(errorArea('metadata_template.title')).toBe('template')
    expect(errorArea('name')).toBe('name')
    expect(errorArea('schedule')).toBe('schedule')
    expect(errorArea('target_dataset_id')).toBe('target')
    expect(errorArea('update_mode')).toBe('other')
  })
})

describe('renderWorkflowEditPage — YAML display round-trip', () => {
  it('shows the stored pipeline as YAML when editing', async () => {
    const mount = document.createElement('div')
    document.body.replaceChildren(mount)
    const stored = JSON.stringify({
      stages: [{ stage: 'visualize', command: 'compose-video', args: { output: '/work/output/dataset.mp4' } }],
    })
    const getFn = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        workflow: {
          id: '01HX0000000000000000000000',
          publisher_id: 'p',
          name: 'W',
          description: null,
          pipeline_json: stored,
          metadata_template: '{}',
          schedule: 'P1D',
          enabled: false,
          target_dataset_id: '01HX0000000000000000000001',
          update_mode: 'overwrite',
          last_run_at: null,
          next_run_at: null,
          created_at: '',
          updated_at: '',
        },
      },
    })
    const { stringify } = await import('yaml')
    await renderWorkflowEditPage(mount, '01HX0000000000000000000000', {
      navigate: () => {},
      getFn,
      stringifyYaml: stringify,
    })
    const pipeline = mount.querySelector('textarea')!
    expect(pipeline.value).toContain('stages:')
    expect(pipeline.value).toContain('command: compose-video')
    expect(pipeline.value.trim().startsWith('{')).toBe(false)
  })
})

describe('renderWorkflowEditPage — guided authoring', () => {
  let mount: HTMLDivElement

  beforeEach(() => {
    mount = document.createElement('div')
    document.body.replaceChildren(mount)
  })

  function textareas(): HTMLTextAreaElement[] {
    return Array.from(mount.querySelectorAll('textarea'))
  }

  it('seeds both textareas when a template is picked on a blank form', async () => {
    await renderWorkflowEditPage(mount, null, { navigate: () => {} })
    const picker = mount.querySelector<HTMLSelectElement>('.publisher-workflow-guided select')
    picker!.value = WORKFLOW_TEMPLATES[0].id
    picker!.dispatchEvent(new Event('change'))
    const [pipeline, template] = textareas()
    expect(pipeline.value).toBe(WORKFLOW_TEMPLATES[0].pipelineYaml)
    expect(template.value).toBe(WORKFLOW_TEMPLATES[0].metadataTemplate)
  })

  it('asks before overwriting non-empty textareas and respects a decline', async () => {
    const confirm = vi.fn().mockReturnValue(false)
    await renderWorkflowEditPage(mount, null, { navigate: () => {}, confirm })
    const [pipeline] = textareas()
    pipeline.value = 'stages: []'
    const picker = mount.querySelector<HTMLSelectElement>('.publisher-workflow-guided select')
    picker!.value = WORKFLOW_TEMPLATES[0].id
    picker!.dispatchEvent(new Event('change'))
    expect(confirm).toHaveBeenCalled()
    expect(pipeline.value).toBe('stages: []')
  })

  it('appends a stage snippet via the insert-stage palette', async () => {
    await renderWorkflowEditPage(mount, null, { navigate: () => {} })
    const pickers = mount.querySelectorAll<HTMLSelectElement>('.publisher-workflow-guided select')
    const stagePicker = pickers[1]
    stagePicker.value = 'visualize compose-video'
    stagePicker.dispatchEvent(new Event('change'))
    const [pipeline] = textareas()
    expect(pipeline.value.startsWith('stages:\n')).toBe(true)
    expect(pipeline.value).toContain('command: compose-video')
    expect(pipeline.value).toContain('/work/output/dataset.mp4')
    expect(stagePicker.value).toBe('')
  })

  it('creates a draft dataset from the workflow name and fills the target field', async () => {
    const createDatasetFn = vi.fn().mockResolvedValue({
      ok: true,
      data: { dataset: { id: '01HX0000000000000000000000' } },
    })
    await renderWorkflowEditPage(mount, null, { navigate: () => {}, createDatasetFn })
    const name = mount.querySelector<HTMLInputElement>('input.publisher-form-input')
    name!.value = 'Drought Risk (Weekly)'
    mount.querySelector<HTMLButtonElement>('.publisher-workflow-create-target')!.click()
    await vi.waitFor(() => {
      const target = mount.querySelectorAll<HTMLInputElement>('input.publisher-form-input')[3]
      expect(target.value).toBe('01HX0000000000000000000000')
    })
    expect(createDatasetFn).toHaveBeenCalledWith('Drought Risk (Weekly)')
  })

  it('refuses to create a draft without a usable workflow name', async () => {
    const createDatasetFn = vi.fn()
    await renderWorkflowEditPage(mount, null, { navigate: () => {}, createDatasetFn })
    mount.querySelector<HTMLButtonElement>('.publisher-workflow-create-target')!.click()
    expect(createDatasetFn).not.toHaveBeenCalled()
    expect(
      mount.querySelector('.publisher-row-action-status-error')?.textContent,
    ).toBeTruthy()
  })
})
