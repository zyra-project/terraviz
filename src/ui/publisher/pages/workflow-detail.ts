/**
 * `/publish/workflows/{id}` — workflow detail + run history
 * (Phase Z2 of `docs/ZYRA_INTEGRATION_PLAN.md`).
 *
 * Definition summary, a Run now button (POST /run — 409 from the
 * active-run guard renders inline, not as a failure), and the run
 * table with zyra-editor-style status badges. `gha_run_id` links
 * out to the Actions log.
 */

import { t } from '../../../i18n'
import { clearWarmupFlag, handleSessionError } from '../api'
import {
  getWorkflow,
  listWorkflowRuns,
  runWorkflow,
  type PublisherWorkflow,
  type PublisherWorkflowRun,
} from '../workflows-api'

export interface WorkflowDetailPageOptions {
  navigate?: (url: string) => void
  getFn?: typeof getWorkflow
  runsFn?: typeof listWorkflowRuns
  runFn?: typeof runWorkflow
  /** Repo slug ("owner/name") used to build Actions log links.
   *  Defaults to the canonical repo; forks override via the
   *  portal config later. */
  repoSlug?: string
}

const DEFAULT_REPO_SLUG = 'zyra-project/terraviz'

export async function renderWorkflowDetailPage(
  content: HTMLElement,
  id: string,
  options: WorkflowDetailPageOptions = {},
): Promise<void> {
  const navigate = options.navigate ?? ((url: string) => window.location.assign(url))
  const getFn = options.getFn ?? getWorkflow
  const runsFn = options.runsFn ?? listWorkflowRuns
  const runFn = options.runFn ?? runWorkflow

  content.replaceChildren(messageShell(t('publisher.workflows.loading')))

  const [workflowResult, runsResult] = await Promise.all([getFn(id), runsFn(id)])
  if (!workflowResult.ok) {
    if (workflowResult.kind === 'session' && handleSessionError({ navigate }) === 'navigating') return
    content.replaceChildren(messageShell(t('publisher.workflows.error')))
    return
  }
  clearWarmupFlag()
  const workflow = workflowResult.data.workflow
  const runs = runsResult.ok ? runsResult.data.runs : []

  const shell = document.createElement('main')
  shell.className = 'publisher-shell'

  const header = document.createElement('div')
  header.className = 'publisher-tour-list-header'
  const h2 = document.createElement('h2')
  h2.textContent = workflow.name
  header.appendChild(h2)

  const actions = document.createElement('div')
  const editLink = document.createElement('a')
  editLink.className = 'publisher-tab'
  editLink.href = `/publish/workflows/${encodeURIComponent(id)}/edit`
  editLink.textContent = t('publisher.workflows.action.edit')
  editLink.addEventListener('click', e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(editLink.getAttribute('href') ?? '/publish/workflows')
  })
  actions.appendChild(editLink)

  const runBtn = document.createElement('button')
  runBtn.type = 'button'
  runBtn.className = 'publisher-tab publisher-tab-active'
  runBtn.textContent = t('publisher.workflows.runNow')
  const runStatus = document.createElement('span')
  runStatus.className = 'publisher-row-action-status'
  runBtn.addEventListener('click', () => {
    runBtn.disabled = true
    runStatus.textContent = ''
    runStatus.classList.remove('publisher-row-action-status-error')
    void runFn(id).then(result => {
      runBtn.disabled = false
      if (!result.ok) {
        const inProgress = result.kind === 'server' && result.status === 409
        runStatus.textContent = inProgress
          ? t('publisher.workflows.runNow.inProgress')
          : t('publisher.workflows.runNow.failed')
        // 409 is the active-run guard doing its job — informational,
        // not an error (PR #176 Copilot review).
        if (!inProgress) runStatus.classList.add('publisher-row-action-status-error')
        return
      }
      runStatus.textContent = t('publisher.workflows.runNow.queued')
      void renderWorkflowDetailPage(content, id, options)
    })
  })
  actions.appendChild(runBtn)
  actions.appendChild(runStatus)
  header.appendChild(actions)
  shell.appendChild(header)

  shell.appendChild(buildSummary(workflow))

  const runsHeading = document.createElement('h3')
  runsHeading.textContent = t('publisher.workflows.runs.heading')
  shell.appendChild(runsHeading)
  if (runs.length === 0) {
    shell.appendChild(messageCard(t('publisher.workflows.runs.empty')))
  } else {
    shell.appendChild(buildRunsTable(runs, options.repoSlug ?? DEFAULT_REPO_SLUG))
  }

  content.replaceChildren(shell)
}

function messageShell(message: string): HTMLElement {
  const shell = document.createElement('main')
  shell.className = 'publisher-shell'
  shell.appendChild(messageCard(message))
  return shell
}

function messageCard(message: string): HTMLElement {
  const card = document.createElement('section')
  card.className = 'publisher-card publisher-glass publisher-empty'
  const p = document.createElement('p')
  p.className = 'publisher-empty-message'
  p.textContent = message
  card.appendChild(p)
  return card
}

function buildSummary(workflow: PublisherWorkflow): HTMLElement {
  const card = document.createElement('section')
  card.className = 'publisher-card publisher-glass'
  const grid = document.createElement('div')
  grid.className = 'publisher-fields'
  const rows: Array<[string, string]> = [
    [t('publisher.workflows.col.schedule'), workflow.schedule],
    [t('publisher.workflows.col.target'), workflow.target_dataset_id],
    [
      t('publisher.workflows.col.enabled'),
      workflow.enabled
        ? t('publisher.workflows.enabled.on')
        : t('publisher.workflows.enabled.off'),
    ],
    [
      t('publisher.workflows.detail.nextRun'),
      workflow.next_run_at ?? t('publisher.workflows.lastRun.never'),
    ],
  ]
  if (workflow.description) {
    rows.push([t('publisher.workflows.form.description'), workflow.description])
  }
  for (const [term, detail] of rows) {
    const row = document.createElement('div')
    row.className = 'publisher-field'
    const label = document.createElement('span')
    label.className = 'publisher-field-label'
    label.textContent = term
    row.appendChild(label)
    const value = document.createElement('span')
    value.className = 'publisher-field-value'
    value.textContent = detail
    row.appendChild(value)
    grid.appendChild(row)
  }
  card.appendChild(grid)
  return card
}

function buildRunsTable(runs: PublisherWorkflowRun[], repoSlug: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'publisher-table-wrap publisher-glass'
  const table = document.createElement('table')
  table.className = 'publisher-table'

  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const key of [
    'publisher.workflows.runs.col.status',
    'publisher.workflows.runs.col.trigger',
    'publisher.workflows.runs.col.created',
    'publisher.workflows.runs.col.finished',
    'publisher.workflows.runs.col.detail',
  ] as const) {
    const th = document.createElement('th')
    th.scope = 'col'
    th.textContent = t(key)
    headRow.appendChild(th)
  }
  thead.appendChild(headRow)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  for (const run of runs) {
    const tr = document.createElement('tr')

    const statusCell = document.createElement('td')
    const badge = document.createElement('span')
    badge.className = `publisher-badge publisher-badge-status publisher-badge-run-${run.status}`
    badge.textContent = statusLabel(run.status)
    statusCell.appendChild(badge)
    tr.appendChild(statusCell)

    const triggerCell = document.createElement('td')
    triggerCell.textContent =
      run.trigger === 'manual'
        ? t('publisher.workflows.runs.trigger.manual')
        : t('publisher.workflows.runs.trigger.schedule')
    tr.appendChild(triggerCell)

    const createdCell = document.createElement('td')
    createdCell.className = 'publisher-cell-updated'
    createdCell.textContent = formatDate(run.created_at)
    tr.appendChild(createdCell)

    const finishedCell = document.createElement('td')
    finishedCell.className = 'publisher-cell-updated'
    finishedCell.textContent = run.finished_at ? formatDate(run.finished_at) : '—' // i18n-exempt: typographic placeholder
    tr.appendChild(finishedCell)

    const detailCell = document.createElement('td')
    if (run.gha_run_id) {
      const log = document.createElement('a')
      log.className = 'publisher-row-action'
      log.href = `https://github.com/${repoSlug}/actions/runs/${encodeURIComponent(run.gha_run_id)}`
      log.target = '_blank'
      log.rel = 'noopener'
      log.textContent = t('publisher.workflows.runs.log')
      detailCell.appendChild(log)
    }
    if (run.error_summary) {
      const err = document.createElement('span')
      err.className = 'publisher-row-action-status publisher-row-action-status-error'
      err.textContent = run.error_summary
      detailCell.appendChild(err)
    }
    tr.appendChild(detailCell)
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  wrap.appendChild(table)
  return wrap
}

function statusLabel(status: PublisherWorkflowRun['status']): string {
  switch (status) {
    case 'queued':
      return t('publisher.workflows.runs.status.queued')
    case 'running':
      return t('publisher.workflows.runs.status.running')
    case 'succeeded':
      return t('publisher.workflows.runs.status.succeeded')
    case 'failed':
      return t('publisher.workflows.runs.status.failed')
    case 'canceled':
      return t('publisher.workflows.runs.status.canceled')
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
