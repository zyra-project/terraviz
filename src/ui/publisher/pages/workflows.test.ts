// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, beforeEach } from 'vitest'
import { renderWorkflowsPage } from './workflows'
import type { PublisherWorkflow } from '../workflows-api'

function workflow(overrides: Partial<PublisherWorkflow> = {}): PublisherWorkflow {
  return {
    id: '01HX0000000000000000000000',
    publisher_id: '01HX0000000000000000000001',
    name: 'Weekly drought',
    description: null,
    pipeline_json: '{"stages":[]}',
    metadata_template: '{}',
    schedule: 'P1W',
    enabled: true,
    target_dataset_id: '01HX0000000000000000000002',
    update_mode: 'overwrite',
    last_run_at: '2026-06-09T12:00:00.000Z',
    next_run_at: '2026-06-16T12:00:00.000Z',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-09T12:00:00.000Z',
    ...overrides,
  }
}

describe('renderWorkflowsPage', () => {
  let mount: HTMLElement

  beforeEach(() => {
    mount = document.createElement('div')
    document.body.replaceChildren(mount)
  })

  it('renders a row per workflow with enabled badge and links', async () => {
    await renderWorkflowsPage(mount, {
      listFn: async () => ({
        ok: true,
        data: { workflows: [workflow(), workflow({ id: '01HX0000000000000000000003', enabled: false })] },
      }),
      navigate: () => {},
    })
    const rows = mount.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(2)
    const badges = mount.querySelectorAll('.publisher-badge')
    expect(badges[0].className).toContain('publisher-badge-published')
    expect(badges[1].className).toContain('publisher-badge-draft')
    const detailLink = mount.querySelector<HTMLAnchorElement>('a.publisher-row-link')
    expect(detailLink?.getAttribute('href')).toBe('/publish/workflows/01HX0000000000000000000000')
  })

  it('hydrates the last-run status badge and runs a workflow on demand', async () => {
    const runCalls: string[] = []
    const failedRun = {
      id: 'r1',
      workflow_id: 'wf1',
      status: 'failed' as const,
      trigger: 'manual',
      created_at: '2026-06-09T12:00:00.000Z',
      started_at: null,
      finished_at: null,
      gha_run_id: null,
      upload_id: null,
      error_summary: 'exit 1',
    }
    await renderWorkflowsPage(mount, {
      listFn: async () => ({ ok: true, data: { workflows: [workflow({ id: 'wf1' })] } }),
      runsFn: async () => ({ ok: true, data: { runs: [failedRun] } }),
      runFn: async (id: string) => {
        runCalls.push(id)
        return { ok: true, data: { run: failedRun, mocked: true } }
      },
      navigate: () => {},
    })
    // Status badge hydrated into the last-run cell.
    await new Promise(r => setTimeout(r, 0))
    const badge = mount.querySelector('.publisher-workflows-runstatus')
    expect(badge?.textContent).toBe('Failed')

    // Run now posts to the run endpoint and reports queued.
    const runBtn = mount.querySelector<HTMLButtonElement>('.publisher-workflows-run')!
    runBtn.click()
    await new Promise(r => setTimeout(r, 0))
    expect(runCalls).toEqual(['wf1'])
    expect(mount.querySelector('.publisher-row-action-status')?.textContent).toBe('Queued ✓')
  })

  it('renders the empty state when no workflows exist', async () => {
    await renderWorkflowsPage(mount, {
      listFn: async () => ({ ok: true, data: { workflows: [] } }),
      navigate: () => {},
    })
    expect(mount.querySelector('.publisher-empty')).not.toBeNull()
    expect(mount.querySelector('table')).toBeNull()
  })

  it('renders the error shell on server failures', async () => {
    await renderWorkflowsPage(mount, {
      listFn: async () => ({ ok: false, kind: 'server', status: 500 }),
      navigate: () => {},
    })
    expect(mount.querySelector('.publisher-empty-message')).not.toBeNull()
    expect(mount.querySelector('table')).toBeNull()
  })

  it('SPA-navigates on plain clicks of the New workflow link', async () => {
    const visited: string[] = []
    await renderWorkflowsPage(mount, {
      listFn: async () => ({ ok: true, data: { workflows: [] } }),
      navigate: url => visited.push(url),
    })
    const newLink = mount.querySelector<HTMLAnchorElement>('a.publisher-workflows-new')
    newLink?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(visited).toEqual(['/publish/workflows/new'])
  })
})
