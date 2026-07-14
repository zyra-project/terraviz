/**
 * `/publish/workflows` — Zyra workflow list (Phase Z2 of
 * `docs/ZYRA_INTEGRATION_PLAN.md`).
 *
 * Mirrors the tours list: table of registered workflows (name,
 * schedule, target dataset, enabled state, last run) with a New
 * workflow button. Rows link to the detail page (run history +
 * Run now); Edit links to the form.
 */

import { fetchFeatures, renderFeatureDisabledCard } from '../features'
import { t } from '../../../i18n'
import { clearWarmupFlag, handleSessionError } from '../api'
import {
  listWorkflows,
  listWorkflowRuns,
  runWorkflow,
  type PublisherWorkflow,
  type PublisherWorkflowRun,
} from '../workflows-api'

export interface WorkflowsPageOptions {
  navigate?: (url: string) => void
  /** Override the list call — tests inject a stub. */
  listFn?: typeof listWorkflows
  /** Override the per-workflow runs call (last-run status probe). */
  runsFn?: typeof listWorkflowRuns
  /** Override the run-now call. */
  runFn?: typeof runWorkflow
}

interface RowCtx {
  navigate: (url: string) => void
  runsFn: typeof listWorkflowRuns
  runFn: typeof runWorkflow
}

export async function renderWorkflowsPage(
  content: HTMLElement,
  options: WorkflowsPageOptions = {},
): Promise<void> {
  if (!(await fetchFeatures()).workflows) {
    renderFeatureDisabledCard(content, 'workflows')
    return
  }
  const navigate = options.navigate ?? ((url: string) => window.location.assign(url))
  const list = options.listFn ?? listWorkflows

  content.replaceChildren(buildMessageShell(t('publisher.workflows.loading')))

  const result = await list()
  if (!result.ok) {
    if (result.kind === 'session') {
      if (handleSessionError({ navigate }) === 'navigating') return
    }
    content.replaceChildren(buildMessageShell(t('publisher.workflows.error')))
    return
  }
  clearWarmupFlag()

  const ctx: RowCtx = {
    navigate,
    runsFn: options.runsFn ?? listWorkflowRuns,
    runFn: options.runFn ?? runWorkflow,
  }
  content.replaceChildren(buildShell(result.data.workflows, ctx))

  // Best-effort last-run status: the list endpoint carries only a
  // timestamp, so probe each workflow's newest run and stamp a
  // Success/Failed/Running badge into its last-run cell. Bounded by
  // the (small) workflow count; failures leave the cell as-is.
  void hydrateRunStatuses(content, result.data.workflows, ctx.runsFn)
}

const RUN_STATUS_LABEL: Record<PublisherWorkflowRun['status'], string> = {
  succeeded: t('publisher.workflows.runStatus.success'),
  failed: t('publisher.workflows.runStatus.failed'),
  running: t('publisher.workflows.runStatus.running'),
  queued: t('publisher.workflows.runStatus.queued'),
  canceled: t('publisher.workflows.runStatus.canceled'),
}

const RUN_STATUS_KIND: Record<PublisherWorkflowRun['status'], 'published' | 'draft' | 'retracted'> = {
  succeeded: 'published',
  failed: 'retracted',
  running: 'draft',
  queued: 'draft',
  canceled: 'draft',
}

async function hydrateRunStatuses(
  content: HTMLElement,
  workflows: PublisherWorkflow[],
  runsFn: typeof listWorkflowRuns,
): Promise<void> {
  await Promise.all(
    workflows.map(async wf => {
      const res = await runsFn(wf.id)
      if (!res.ok) return
      // Single pass for the newest run — no need to sort the whole list
      // (listWorkflowRuns can return up to 50) just to take the max.
      let newest: (typeof res.data.runs)[number] | undefined
      for (const run of res.data.runs) {
        if (!newest || (Date.parse(run.created_at) || 0) > (Date.parse(newest.created_at) || 0)) {
          newest = run
        }
      }
      if (!newest) return
      const cell = content.querySelector<HTMLElement>(
        `[data-workflow-lastrun="${CSS.escape(wf.id)}"]`,
      )
      if (!cell) return
      const badge = document.createElement('span')
      badge.className = `publisher-badge publisher-badge-status publisher-badge-${RUN_STATUS_KIND[newest.status]} publisher-workflows-runstatus`
      badge.textContent = RUN_STATUS_LABEL[newest.status]
      cell.prepend(badge)
    }),
  )
}

function buildMessageShell(message: string): HTMLElement {
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

function buildShell(workflows: PublisherWorkflow[], ctx: RowCtx): HTMLElement {
  const shell = document.createElement('main')
  shell.className = 'publisher-shell'

  // Page header mirrors the datasets list (deck layout): stacked
  // title + subtitle on the start side, a primary "New workflow"
  // button on the end side.
  const header = document.createElement('header')
  header.className = 'publisher-page-header'
  const titles = document.createElement('div')
  titles.className = 'publisher-page-titles'
  const h1 = document.createElement('h1')
  h1.className = 'publisher-page-title'
  h1.textContent = t('publisher.workflows.heading')
  const sub = document.createElement('p')
  sub.className = 'publisher-page-subtitle'
  sub.textContent = t('publisher.workflows.intro')
  titles.append(h1, sub)
  header.appendChild(titles)

  const newLink = document.createElement('a')
  newLink.href = '/publish/workflows/new'
  newLink.className = 'publisher-button publisher-button-primary publisher-workflows-new'
  newLink.textContent = t('publisher.workflows.new')
  interceptNav(newLink, ctx.navigate)
  header.appendChild(newLink)
  shell.appendChild(header)

  if (workflows.length === 0) {
    const empty = document.createElement('section')
    empty.className = 'publisher-card publisher-glass publisher-empty'
    const emptyTitle = document.createElement('p')
    emptyTitle.className = 'publisher-empty-message'
    emptyTitle.textContent = t('publisher.workflows.empty.title')
    empty.appendChild(emptyTitle)
    const emptyHint = document.createElement('p')
    emptyHint.className = 'publisher-tour-empty-hint'
    emptyHint.textContent = t('publisher.workflows.empty.hint')
    empty.appendChild(emptyHint)
    shell.appendChild(empty)
    return shell
  }

  shell.appendChild(buildTable(workflows, ctx))
  return shell
}

function buildTable(workflows: PublisherWorkflow[], ctx: RowCtx): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'publisher-table-wrap publisher-glass'
  const table = document.createElement('table')
  table.className = 'publisher-table'

  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  // Deck layout: no standalone Enabled column — the enabled badge sits
  // under the workflow name (same fold as the datasets status badge).
  for (const key of [
    'publisher.workflows.col.name',
    'publisher.workflows.col.schedule',
    'publisher.workflows.col.target',
    'publisher.workflows.col.lastRun',
    'publisher.workflows.col.actions',
  ] as const) {
    const th = document.createElement('th')
    th.scope = 'col'
    th.textContent = t(key)
    headRow.appendChild(th)
  }
  thead.appendChild(headRow)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  for (const workflow of workflows) {
    tbody.appendChild(buildRow(workflow, ctx))
  }
  table.appendChild(tbody)
  wrap.appendChild(table)
  return wrap
}

function buildRow(workflow: PublisherWorkflow, ctx: RowCtx): HTMLElement {
  const tr = document.createElement('tr')
  const detailPath = `/publish/workflows/${encodeURIComponent(workflow.id)}`

  const nameCell = document.createElement('td')
  // Name + enabled badge stacked (deck fold — no separate column).
  const nameStack = document.createElement('div')
  nameStack.className = 'publisher-cell-title'
  const nameLink = document.createElement('a')
  nameLink.className = 'publisher-row-link'
  nameLink.href = detailPath
  nameLink.textContent = workflow.name
  interceptNav(nameLink, ctx.navigate)
  nameStack.appendChild(nameLink)
  const badge = document.createElement('span')
  badge.className = `publisher-badge publisher-badge-status publisher-badge-${workflow.enabled ? 'published' : 'draft'}`
  badge.textContent = workflow.enabled
    ? t('publisher.workflows.enabled.on')
    : t('publisher.workflows.enabled.off')
  nameStack.appendChild(badge)
  nameCell.appendChild(nameStack)
  tr.appendChild(nameCell)

  const scheduleCell = document.createElement('td')
  scheduleCell.textContent = workflow.schedule // i18n-exempt: ISO-8601 duration token
  tr.appendChild(scheduleCell)

  const targetCell = document.createElement('td')
  const targetLink = document.createElement('a')
  targetLink.className = 'publisher-row-action'
  targetLink.href = `/publish/datasets/${encodeURIComponent(workflow.target_dataset_id)}`
  targetLink.textContent = workflow.target_dataset_id
  interceptNav(targetLink, ctx.navigate)
  targetCell.appendChild(targetLink)
  tr.appendChild(targetCell)

  const lastRunCell = document.createElement('td')
  lastRunCell.className = 'publisher-cell-updated'
  // Inner flex wrapper (NOT the <td> itself) holds the hydrated status
  // badge + timestamp. Setting display:flex on a <td> drops it from the
  // table's column model, which is what pushed the actions out of line.
  const lastRunWrap = document.createElement('div')
  lastRunWrap.className = 'publisher-workflows-lastrun'
  lastRunWrap.dataset.workflowLastrun = workflow.id
  const when = document.createElement('span')
  when.textContent = workflow.last_run_at
    ? formatDate(workflow.last_run_at)
    : t('publisher.workflows.lastRun.never')
  lastRunWrap.appendChild(when)
  lastRunCell.appendChild(lastRunWrap)
  tr.appendChild(lastRunCell)

  const actionsCell = document.createElement('td')
  actionsCell.className = 'publisher-cell-actions'

  const runBtn = document.createElement('button')
  runBtn.type = 'button'
  runBtn.className = 'publisher-row-action publisher-workflows-run'
  runBtn.textContent = t('publisher.workflows.action.runNow')
  const runStatus = document.createElement('span')
  runStatus.className = 'publisher-row-action-status'
  runBtn.addEventListener('click', () => {
    runBtn.disabled = true
    runStatus.textContent = ''
    runStatus.classList.remove('publisher-row-action-status-error')
    void ctx.runFn(workflow.id).then(res => {
      runBtn.disabled = false
      if (res.ok) {
        runStatus.textContent = t('publisher.workflows.run.queued')
      } else {
        runStatus.textContent = t('publisher.workflows.run.failed')
        runStatus.classList.add('publisher-row-action-status-error')
      }
    })
  })
  actionsCell.appendChild(runBtn)

  const editLink = document.createElement('a')
  editLink.href = `${detailPath}/edit`
  editLink.className = 'publisher-row-action publisher-row-edit'
  editLink.textContent = t('publisher.workflows.action.edit')
  interceptNav(editLink, ctx.navigate)
  actionsCell.appendChild(editLink)
  actionsCell.appendChild(runStatus)
  tr.appendChild(actionsCell)

  return tr
}

/** SPA-navigate on plain left clicks; keep modified clicks native
 *  so cmd-click → new tab works (the tours-list convention). */
function interceptNav(a: HTMLAnchorElement, navigate: (url: string) => void): void {
  a.addEventListener('click', e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(a.getAttribute('href') ?? '/publish/workflows')
  })
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
