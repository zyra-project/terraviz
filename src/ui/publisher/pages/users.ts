/**
 * /publish/users — the admin Users tab.
 *
 * Admin-only (the API enforces 403 regardless via `isAdmin`). Lists
 * publisher accounts with a status filter and lets an admin:
 *   - approve / reject a pending account,
 *   - suspend / reactivate,
 *   - change role (promote to admin, demote to publisher, read-only).
 *
 * Mutations go through `PATCH /api/v1/publish/publishers/{id}` via the
 * shared `publisherSend` helper, which surfaces validation (the
 * self-lockout / last-admin guardrails come back as `server` 409s).
 *
 * The gate follows the analytics-page precedent: fetch `/me`, show a
 * restricted message for non-admins, otherwise load the list.
 */

import { t } from '../../../i18n'
import {
  clearWarmupFlag,
  handleSessionError,
  publisherGet,
  publisherSend,
  type PublisherSendResult,
} from '../api'
import { buildErrorCard } from '../components/error-card'
import type { ListPublishersResponse, PublisherSummary, UpdatePublisherPayload } from '../types'

const ME_ENDPOINT = '/api/v1/publish/me'
const PUBLISHERS_ENDPOINT = '/api/v1/publish/publishers'

const STATUS_FILTERS = ['pending', 'active', 'suspended', 'all'] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

interface MeResponse {
  id: string
  role: string
  is_admin: boolean
}

export interface UsersPageOptions {
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
  /** Confirmation hook for destructive actions; defaults to window.confirm. */
  confirm?: (message: string) => boolean
}

function clientIsAdmin(me: MeResponse): boolean {
  return me.is_admin === true || me.role === 'admin'
}

function shell(...children: HTMLElement[]): HTMLElement {
  const main = document.createElement('main')
  main.className = 'publisher-shell publisher-users'
  main.append(...children)
  return main
}

function localizedRole(role: string): string {
  switch (role) {
    case 'admin':
      return t('publisher.me.role.admin')
    case 'publisher':
      return t('publisher.me.role.publisher')
    case 'service':
      return t('publisher.me.role.service')
    case 'readonly':
      return t('publisher.me.role.readonly')
    default:
      return role
  }
}

function localizedStatus(status: string): string {
  switch (status) {
    case 'active':
      return t('publisher.me.status.active')
    case 'pending':
      return t('publisher.me.status.pending')
    case 'suspended':
      return t('publisher.me.status.suspended')
    default:
      return status
  }
}

function currentFilter(): StatusFilter {
  const raw = new URLSearchParams(window.location.search).get('status')
  return (STATUS_FILTERS as readonly string[]).includes(raw ?? '') ? (raw as StatusFilter) : 'pending'
}

function buildListUrl(filter: StatusFilter): string {
  return filter === 'all' ? PUBLISHERS_ENDPOINT : `${PUBLISHERS_ENDPOINT}?status=${filter}`
}

function loadingShell(): HTMLElement {
  const p = document.createElement('p')
  p.className = 'publisher-loading'
  p.setAttribute('role', 'status')
  p.textContent = t('publisher.users.loading')
  const s = shell(p)
  s.setAttribute('aria-busy', 'true')
  return s
}

function restrictedShell(): HTMLElement {
  const h1 = document.createElement('h1')
  h1.textContent = t('publisher.users.title')
  const p = document.createElement('p')
  p.className = 'publisher-hero-restricted'
  p.textContent = t('publisher.users.restricted')
  return shell(h1, p)
}

export async function renderUsersPage(
  mount: HTMLElement,
  options: UsersPageOptions = {},
): Promise<void> {
  const fetchFn = options.fetchFn
  mount.replaceChildren(loadingShell())

  const meRes = await publisherGet<MeResponse>(ME_ENDPOINT, { fetchFn })
  if (!meRes.ok) {
    if (meRes.kind === 'session') {
      if (handleSessionError({ navigate: options.navigate }) === 'show-error') {
        mount.replaceChildren(shell(buildErrorCard('session')))
      }
      return
    }
    const details = meRes.kind === 'server' ? { status: meRes.status, body: meRes.body } : {}
    mount.replaceChildren(shell(buildErrorCard(meRes.kind, details)))
    return
  }
  if (!clientIsAdmin(meRes.data)) {
    mount.replaceChildren(restrictedShell())
    return
  }
  clearWarmupFlag()

  const filter = currentFilter()
  const listRes = await publisherGet<ListPublishersResponse>(buildListUrl(filter), { fetchFn })
  if (!listRes.ok) {
    if (listRes.kind === 'session') {
      if (handleSessionError({ navigate: options.navigate }) === 'show-error') {
        mount.replaceChildren(shell(buildErrorCard('session')))
      }
      return
    }
    const details = listRes.kind === 'server' ? { status: listRes.status, body: listRes.body } : {}
    mount.replaceChildren(shell(buildErrorCard(listRes.kind, details)))
    return
  }

  mount.replaceChildren(
    renderList(meRes.data, filter, listRes.data.publishers, mount, options),
  )
}

function renderList(
  me: MeResponse,
  filter: StatusFilter,
  publishers: PublisherSummary[],
  mount: HTMLElement,
  options: UsersPageOptions,
): HTMLElement {
  const root = shell()

  const h1 = document.createElement('h1')
  h1.textContent = t('publisher.users.title')
  root.appendChild(h1)

  // Status filter tabs — navigate by ?status= so the view is
  // bookmarkable, mirroring the datasets page.
  const tabs = document.createElement('nav')
  tabs.className = 'publisher-users-filters'
  tabs.setAttribute('aria-label', t('publisher.users.title'))
  for (const f of STATUS_FILTERS) {
    const a = document.createElement('a')
    a.href = `/publish/users${f === 'all' ? '' : `?status=${f}`}`
    a.className = 'publisher-users-filter'
    if (f === filter) a.setAttribute('aria-current', 'page')
    a.textContent = t(`publisher.users.filter.${f}` as FilterLabelKey)
    a.addEventListener('click', e => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      e.preventDefault()
      const url = new URL(window.location.href)
      if (f === 'all') url.searchParams.delete('status')
      else url.searchParams.set('status', f)
      window.history.pushState({}, '', url.toString())
      void renderUsersPage(mount, options)
    })
    tabs.appendChild(a)
  }
  root.appendChild(tabs)

  if (publishers.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'publisher-empty'
    empty.textContent = t('publisher.users.empty')
    root.appendChild(empty)
    return root
  }

  const table = document.createElement('table')
  table.className = 'publisher-table publisher-users-table'
  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const key of [
    'publisher.users.col.user',
    'publisher.users.col.role',
    'publisher.users.col.status',
    'publisher.users.col.actions',
  ] as const) {
    const th = document.createElement('th')
    th.textContent = t(key)
    headRow.appendChild(th)
  }
  thead.appendChild(headRow)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  for (const p of publishers) {
    tbody.appendChild(renderRow(me, p, options))
  }
  table.appendChild(tbody)
  root.appendChild(table)
  return root
}

type FilterLabelKey =
  | 'publisher.users.filter.pending'
  | 'publisher.users.filter.active'
  | 'publisher.users.filter.suspended'
  | 'publisher.users.filter.all'

function renderRow(
  me: MeResponse,
  publisher: PublisherSummary,
  options: UsersPageOptions,
): HTMLElement {
  const isSelf = publisher.id === me.id
  const tr = document.createElement('tr')

  // User cell — display name over email.
  const userCell = document.createElement('td')
  const name = document.createElement('div')
  name.className = 'publisher-users-name'
  name.textContent = publisher.display_name
  const email = document.createElement('div')
  email.className = 'publisher-users-email'
  email.textContent = publisher.email
  userCell.append(name, email)
  tr.appendChild(userCell)

  // Role cell — a select for promote/demote/edit-role. The service
  // role is never offered (machine-token only); a current service
  // row renders read-only text instead.
  const roleCell = document.createElement('td')
  const statusBadge = document.createElement('span')
  const actionStatus = document.createElement('span')
  actionStatus.className = 'publisher-row-action-status'

  if (publisher.role === 'service') {
    roleCell.textContent = localizedRole(publisher.role)
  } else {
    const select = document.createElement('select')
    select.className = 'publisher-users-role-select'
    if (isSelf) select.disabled = true
    for (const r of ['admin', 'publisher', 'readonly'] as const) {
      const opt = document.createElement('option')
      opt.value = r
      opt.textContent = localizedRole(r)
      if (r === publisher.role) opt.selected = true
      select.appendChild(opt)
    }
    select.addEventListener('change', () => {
      const next = select.value
      void applyUpdate(publisher, { role: next }, { select, statusEl: actionStatus }, options).then(ok => {
        if (!ok) select.value = publisher.role
        else publisher.role = next
      })
    })
    roleCell.appendChild(select)
  }
  tr.appendChild(roleCell)

  // Status cell.
  const statusCell = document.createElement('td')
  statusBadge.className = 'publisher-badge publisher-badge-status'
  statusBadge.dataset.status = publisher.status
  statusBadge.textContent = localizedStatus(publisher.status)
  statusCell.appendChild(statusBadge)
  tr.appendChild(statusCell)

  // Actions cell — status transitions appropriate to the row.
  const actionsCell = document.createElement('td')
  actionsCell.className = 'publisher-users-actions'

  const setStatus = (
    next: 'active' | 'suspended',
    confirmKey: ConfirmKey | null,
    btn: HTMLButtonElement,
  ): void => {
    if (confirmKey) {
      const confirmFn = options.confirm ?? ((m: string) => window.confirm(m))
      if (!confirmFn(t(confirmKey, { name: publisher.display_name }))) return
    }
    void applyUpdate(publisher, { status: next }, { select: btn, statusEl: actionStatus }, options).then(
      ok => {
        if (ok) {
          publisher.status = next
          statusBadge.dataset.status = next
          statusBadge.textContent = localizedStatus(next)
          rebuildActions()
        }
      },
    )
  }

  const rebuildActions = (): void => {
    actionsCell.replaceChildren()
    if (publisher.status === 'pending') {
      actionsCell.appendChild(actionButton('publisher.users.action.approve', 'primary', b => setStatus('active', null, b)))
      actionsCell.appendChild(actionButton('publisher.users.action.reject', 'danger', b => setStatus('suspended', 'publisher.users.confirm.reject', b)))
    } else if (publisher.status === 'active') {
      if (!isSelf) {
        actionsCell.appendChild(actionButton('publisher.users.action.suspend', 'danger', b => setStatus('suspended', 'publisher.users.confirm.suspend', b)))
      }
    } else if (publisher.status === 'suspended') {
      actionsCell.appendChild(actionButton('publisher.users.action.reactivate', 'primary', b => setStatus('active', null, b)))
    }
    actionsCell.appendChild(actionStatus)
  }
  rebuildActions()
  tr.appendChild(actionsCell)

  return tr
}

type ConfirmKey =
  | 'publisher.users.confirm.reject'
  | 'publisher.users.confirm.suspend'

type ActionLabelKey =
  | 'publisher.users.action.approve'
  | 'publisher.users.action.reject'
  | 'publisher.users.action.suspend'
  | 'publisher.users.action.reactivate'

function actionButton(
  labelKey: ActionLabelKey,
  variant: 'primary' | 'danger',
  onClick: (btn: HTMLButtonElement) => void,
): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `publisher-button publisher-button-${variant} publisher-row-action`
  btn.textContent = t(labelKey)
  btn.addEventListener('click', () => onClick(btn))
  return btn
}

/** Pull a human-readable message off a non-session PATCH failure:
 *  the field-level validation messages, or the server envelope's
 *  `message` (the guardrail 409s ship `{ error, message }`), falling
 *  back to the generic localized label. */
function failureMessage(
  res: Exclude<PublisherSendResult<unknown>, { ok: true } | { ok: false; kind: 'session' }>,
): string {
  if (res.kind === 'validation') {
    const joined = res.errors.map(e => e.message).join('; ')
    if (joined) return joined
  }
  if (res.kind === 'server' && res.body) {
    try {
      const parsed = JSON.parse(res.body) as { message?: unknown }
      if (typeof parsed.message === 'string' && parsed.message) return parsed.message
    } catch {
      /* non-JSON body — fall through to the generic label */
    }
  }
  return t('publisher.users.action.failed')
}

/**
 * Apply a PATCH and reflect success/failure on the control. Returns
 * true on success. A session expiry routes through the shared
 * `handleSessionError` (redirect-back warmup) like the rest of the
 * portal; validation and guardrail (409) failures surface their
 * server message inline rather than a flat "Update failed".
 */
async function applyUpdate(
  publisher: PublisherSummary,
  payload: UpdatePublisherPayload,
  ui: { select: HTMLSelectElement | HTMLButtonElement; statusEl: HTMLElement },
  options: UsersPageOptions,
): Promise<boolean> {
  ui.select.disabled = true
  ui.statusEl.classList.remove('publisher-row-action-status-error')
  ui.statusEl.textContent = ''
  const res = await publisherSend<{ publisher: PublisherSummary }>(
    `${PUBLISHERS_ENDPOINT}/${encodeURIComponent(publisher.id)}`,
    payload,
    { method: 'PATCH', fetchFn: options.fetchFn },
  )
  ui.select.disabled = false
  if (res.ok) return true

  if (res.kind === 'session') {
    // Same auto-warmup the other pages use; only surface a message
    // when the loop guard declines to redirect.
    if (handleSessionError({ navigate: options.navigate }) === 'show-error') {
      ui.statusEl.textContent = t('publisher.users.action.failed')
      ui.statusEl.classList.add('publisher-row-action-status-error')
    }
    return false
  }

  ui.statusEl.textContent = failureMessage(res)
  ui.statusEl.classList.add('publisher-row-action-status-error')
  return false
}
