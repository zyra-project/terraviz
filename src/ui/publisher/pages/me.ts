/**
 * /publish/me — the publisher's own profile page.
 *
 * Fetches `GET /api/v1/publish/me` via the shared `publisherGet`
 * helper in `../api.ts`, which handles the auth-retry +
 * opaqueredirect detection logic uniformly across the portal.
 * On a session-error result the page delegates to
 * `handleSessionError`, which either auto-navigates through the
 * redirect-back endpoint (typical) or surfaces the error card
 * when the warmup loop guard fires (genuine auth gap).
 *
 * Other error kinds (network / server) render the local error
 * card with a Refresh button — the user's auth state is fine,
 * only the connection or backend is hiccupping.
 */

import { t } from '../../../i18n'
import {
  publisherGet,
  handleSessionError,
  clearWarmupFlag,
} from '../api'
import { buildErrorCard, type ErrorCardDetails } from '../components/error-card'

interface PublisherMeResponse {
  id: string
  email: string
  display_name: string
  affiliation: string | null
  role: string
  is_admin: boolean
  status: string
  created_at: string
}

type ErrorKind = 'session' | 'server' | 'network' | 'not_found'

const ME_ENDPOINT = '/api/v1/publish/me'

interface PublisherMeFetchOptions {
  fetchFn?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  navigate?: (url: string) => void
}

/** Render a glass-surface card with the given child nodes. */
function card(...children: HTMLElement[]): HTMLElement {
  const el = document.createElement('section')
  el.className = 'publisher-card publisher-glass'
  for (const child of children) el.appendChild(child)
  return el
}

function heading(text: string): HTMLElement {
  const h = document.createElement('h2')
  h.className = 'publisher-card-heading'
  h.textContent = text
  return h
}

function field(label: string, value: string, extraValueClass = ''): HTMLElement {
  const row = document.createElement('div')
  row.className = 'publisher-field'

  const labelEl = document.createElement('span')
  labelEl.className = 'publisher-field-label'
  labelEl.textContent = label

  const valueEl = document.createElement('span')
  valueEl.className = `publisher-field-value ${extraValueClass}`.trim()
  valueEl.textContent = value

  row.appendChild(labelEl)
  row.appendChild(valueEl)
  return row
}

function badge(text: string, kind: 'admin' | 'role' | 'status'): HTMLElement {
  const el = document.createElement('span')
  el.className = `publisher-badge publisher-badge-${kind}`
  el.textContent = text
  return el
}

function renderLoading(mount: HTMLElement): void {
  const shell = document.createElement('main')
  shell.className = 'publisher-shell'
  shell.setAttribute('aria-busy', 'true')
  const status = document.createElement('p')
  status.className = 'publisher-loading'
  status.setAttribute('role', 'status')
  status.textContent = t('publisher.me.loading')
  shell.appendChild(status)
  mount.replaceChildren(shell)
}

function renderError(
  mount: HTMLElement,
  kind: ErrorKind,
  details: ErrorCardDetails = {},
): void {
  const shell = document.createElement('main')
  shell.className = 'publisher-shell'
  shell.appendChild(buildErrorCard(kind, details))
  mount.replaceChildren(shell)
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

/**
 * Format an ISO 8601 timestamp using the active locale.
 * Falls back to the raw string if `Date` can't parse it.
 */
function formatCreatedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function renderProfile(mount: HTMLElement, me: PublisherMeResponse): void {
  const shell = document.createElement('main')
  shell.className = 'publisher-shell'

  const head = heading(t('publisher.me.heading'))
  const fields = document.createElement('div')
  fields.className = 'publisher-fields'

  fields.appendChild(field(t('publisher.me.field.email'), me.email))

  // Role badge. Under the two-tier model the role itself encodes
  // admin-ness (role === 'admin'), so there's no separate admin
  // badge — `is_admin` is just a legacy mirror of the role.
  const roleRow = document.createElement('div')
  roleRow.className = 'publisher-field'
  const roleLabel = document.createElement('span')
  roleLabel.className = 'publisher-field-label'
  roleLabel.textContent = t('publisher.me.field.role')
  const roleValue = document.createElement('span')
  roleValue.className = 'publisher-field-value'
  roleValue.appendChild(badge(localizedRole(me.role), me.role === 'admin' ? 'admin' : 'role'))
  roleRow.appendChild(roleLabel)
  roleRow.appendChild(roleValue)
  fields.appendChild(roleRow)

  // Affiliation. Empty/null renders an explicit "not set" rather
  // than an empty value so the publisher knows the field exists.
  fields.appendChild(
    field(
      t('publisher.me.field.affiliation'),
      me.affiliation && me.affiliation.length > 0
        ? me.affiliation
        : t('publisher.me.affiliation.none'),
    ),
  )

  // Status with a coloured badge.
  const statusRow = document.createElement('div')
  statusRow.className = 'publisher-field'
  const statusLabel = document.createElement('span')
  statusLabel.className = 'publisher-field-label'
  statusLabel.textContent = t('publisher.me.field.status')
  const statusValue = document.createElement('span')
  statusValue.className = 'publisher-field-value'
  const statusBadge = badge(localizedStatus(me.status), 'status')
  statusBadge.dataset.status = me.status
  statusValue.appendChild(statusBadge)
  statusRow.appendChild(statusLabel)
  statusRow.appendChild(statusValue)
  fields.appendChild(statusRow)

  fields.appendChild(
    field(t('publisher.me.field.memberSince'), formatCreatedAt(me.created_at)),
  )

  const profileCard = card(head, fields)
  shell.appendChild(profileCard)
  mount.replaceChildren(shell)
}

/**
 * Boot the /publish/me page. Renders a loading state, kicks off
 * the fetch via the shared `publisherGet` helper, then swaps in
 * the profile card or an error card based on the result.
 * Idempotent — calling it again replaces the current contents
 * in-place.
 *
 * The auth-handling complexity (opaqueredirect retry + auto-
 * warmup + sessionStorage loop guard) lives in `../api.ts`. This
 * function just maps the helper's discriminated result onto the
 * page's render functions. `options` is injectable for tests.
 */
export async function renderMePage(
  mount: HTMLElement,
  options: PublisherMeFetchOptions = {},
): Promise<void> {
  renderLoading(mount)
  const result = await publisherGet<PublisherMeResponse>(ME_ENDPOINT, {
    fetchFn: options.fetchFn,
    sleep: options.sleep,
  })
  if (result.ok) {
    clearWarmupFlag()
    renderProfile(mount, result.data)
    return
  }
  if (result.kind === 'session') {
    if (handleSessionError({ navigate: options.navigate }) === 'show-error') {
      renderError(mount, 'session')
    }
    return
  }
  if (result.kind === 'server') {
    renderError(mount, 'server', { status: result.status, body: result.body })
    return
  }
  // `not_found` is an unexpected response for /me — the route
  // never 404s if the publisher is authenticated. Treat as a
  // generic network error so the user sees a Refresh option.
  renderError(mount, result.kind)
}
