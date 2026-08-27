// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * /publish/me — the publisher's Account page.
 *
 * Fetches `GET /api/v1/publish/me` via the shared `publisherGet`
 * helper in `../api.ts`, which handles the auth-retry +
 * opaqueredirect detection logic uniformly across the portal. On a
 * session-error result the page delegates to `handleSessionError`,
 * which either auto-navigates through the redirect-back endpoint
 * (typical) or surfaces the error card when the warmup loop guard
 * fires (genuine auth gap). Other error kinds render the local error
 * card with a Refresh button.
 *
 * Layout follows the UI/UX review deck's Account page: an identity
 * header, an editable Profile section, an Account & security
 * section, and an Active-sessions section. Sign-in, password, and
 * 2FA are owned by the identity provider (Cloudflare Access), so
 * those controls are shown for parity with the deck but are inert,
 * with a note pointing at the provider — no fabricated session list.
 * The profile edit reuses the admin `PATCH /publish/publishers/{id}`
 * route, which the server restricts to admins; non-admins see the
 * fields read-only with a note.
 */

import { t } from '../../../i18n'
import {
  publisherGet,
  publisherSend,
  handleSessionError,
  clearWarmupFlag,
} from '../api'
import { buildErrorCard, type ErrorCardDetails } from '../components/error-card'
import { initialsOf } from '../components/sidebar'

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

interface MePageOptions {
  fetchFn?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  navigate?: (url: string) => void
}

// --- Small DOM helpers --------------------------------------------

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function card(...children: HTMLElement[]): HTMLElement {
  const c = el('section', 'publisher-card publisher-glass')
  for (const child of children) c.appendChild(child)
  return c
}

function heading(text: string): HTMLElement {
  return el('h2', 'publisher-card-heading', text)
}

function badge(text: string, kind: 'admin' | 'role' | 'status'): HTMLElement {
  return el('span', `publisher-badge publisher-badge-${kind}`, text)
}

/** Localize a publisher role. Exported so the sidebar footer + Users
 *  tab reuse the single source of truth (avoids a drifting second
 *  copy). */
// Switch on the raw stored string (not the authz-normalized role) so a
// genuinely unknown / future role shows verbatim rather than being
// mislabeled as the fail-closed `reviewer` (right for gating, wrong for
// a human-facing badge). The legacy `publisher` / `readonly` strings
// render as their canonical labels (Author / Reviewer): the roles were
// renamed (migration 0039) and the old names are retired, so we never
// surface them — even while an un-migrated row still carries the legacy
// string.
export function localizedRole(role: string): string {
  switch (role) {
    case 'admin':
      return t('publisher.me.role.admin')
    case 'editor':
      return t('publisher.me.role.editor')
    case 'author':
    case 'publisher': // legacy alias — role renamed to author
      return t('publisher.me.role.author')
    case 'contributor':
      return t('publisher.me.role.contributor')
    case 'reviewer':
    case 'readonly': // legacy alias — role renamed to reviewer
      return t('publisher.me.role.reviewer')
    case 'service':
      return t('publisher.me.role.service')
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

function renderLoading(mount: HTMLElement): void {
  const shell = el('main', 'publisher-shell')
  shell.setAttribute('aria-busy', 'true')
  const status = el('p', 'publisher-loading', t('publisher.me.loading'))
  status.setAttribute('role', 'status')
  shell.appendChild(status)
  mount.replaceChildren(shell)
}

function renderError(mount: HTMLElement, kind: ErrorKind, details: ErrorCardDetails = {}): void {
  const shell = el('main', 'publisher-shell')
  shell.appendChild(buildErrorCard(kind, details))
  mount.replaceChildren(shell)
}

// --- Sections -----------------------------------------------------

function renderIdentityCard(me: PublisherMeResponse): HTMLElement {
  const head = el('div', 'publisher-account-identity')

  const avatar = el('span', 'publisher-account-avatar', initialsOf(me.display_name || me.email))
  avatar.setAttribute('aria-hidden', 'true')
  head.appendChild(avatar)

  const meta = el('div', 'publisher-account-identity-meta')
  meta.appendChild(el('div', 'publisher-account-name', me.display_name || me.email))
  meta.appendChild(el('div', 'publisher-account-email', me.email))
  head.appendChild(meta)

  const badges = el('div', 'publisher-account-badges')
  badges.appendChild(badge(localizedRole(me.role), me.role === 'admin' ? 'admin' : 'role'))
  const statusBadge = badge(localizedStatus(me.status), 'status')
  statusBadge.dataset.status = me.status
  badges.appendChild(statusBadge)
  head.appendChild(badges)

  return card(head)
}

function renderProfileCard(
  me: PublisherMeResponse,
  options: MePageOptions,
  onSaved: () => void,
): HTMLElement {
  const canEdit = me.is_admin === true || me.role === 'admin'

  const form = el('div', 'publisher-account-form')

  const nameField = el('div', 'publisher-account-field')
  const nameLabel = el('label', 'publisher-account-label', t('publisher.account.field.displayName'))
  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.className = 'publisher-form-input'
  nameInput.id = 'publisher-account-display-name'
  nameInput.value = me.display_name
  nameInput.disabled = !canEdit
  nameLabel.setAttribute('for', nameInput.id)
  nameField.append(nameLabel, nameInput, el('p', 'publisher-account-hint', t('publisher.account.field.displayName.hint')))
  form.appendChild(nameField)

  const affField = el('div', 'publisher-account-field')
  const affLabel = el('label', 'publisher-account-label', t('publisher.account.field.affiliation'))
  const affInput = document.createElement('input')
  affInput.type = 'text'
  affInput.className = 'publisher-form-input'
  affInput.id = 'publisher-account-affiliation'
  affInput.value = me.affiliation ?? ''
  affInput.disabled = !canEdit
  affLabel.setAttribute('for', affInput.id)
  affField.append(affLabel, affInput, el('p', 'publisher-account-hint', t('publisher.account.field.affiliation.hint')))
  form.appendChild(affField)

  const actions = el('div', 'publisher-account-actions')
  const status = el('span', 'publisher-account-save-status')
  status.setAttribute('role', 'status')

  if (!canEdit) {
    actions.appendChild(el('p', 'publisher-account-readonly-note', t('publisher.account.readonlyNote')))
  } else {
    const cancel = el('button', 'publisher-button', t('publisher.account.cancel')) as HTMLButtonElement
    cancel.type = 'button'
    cancel.addEventListener('click', () => {
      nameInput.value = me.display_name
      affInput.value = me.affiliation ?? ''
      status.textContent = ''
      status.className = 'publisher-account-save-status'
    })

    const save = el('button', 'publisher-button publisher-button-primary', t('publisher.account.save')) as HTMLButtonElement
    save.type = 'button'
    save.addEventListener('click', () => {
      void (async () => {
        save.disabled = true
        cancel.disabled = true
        save.textContent = t('publisher.account.saving')
        status.textContent = ''
        status.className = 'publisher-account-save-status'
        const res = await publisherSend<{ publisher: unknown }>(
          `/api/v1/publish/publishers/${encodeURIComponent(me.id)}`,
          { display_name: nameInput.value.trim(), affiliation: affInput.value.trim() || null },
          { method: 'PATCH', fetchFn: options.fetchFn },
        )
        save.disabled = false
        cancel.disabled = false
        save.textContent = t('publisher.account.save')
        if (res.ok) {
          me.display_name = nameInput.value.trim()
          me.affiliation = affInput.value.trim() || null
          status.textContent = t('publisher.account.saved')
          status.className = 'publisher-account-save-status publisher-account-save-ok'
          // Keep the identity header (name + avatar initials) in sync
          // with the just-saved values.
          onSaved()
        } else {
          status.textContent = t('publisher.account.saveError')
          status.className = 'publisher-account-save-status publisher-account-save-error'
        }
      })()
    })
    actions.append(cancel, save, status)
  }

  return card(heading(t('publisher.account.profile.heading')), form, actions)
}

/** A security row: label + current value + an inert action button. */
function securityRow(label: string, value: string, action: string): HTMLElement {
  const row = el('div', 'publisher-account-security-row')
  const info = el('div', 'publisher-account-security-info')
  info.appendChild(el('span', 'publisher-account-security-label', label))
  info.appendChild(el('span', 'publisher-account-security-value', value))
  row.appendChild(info)
  const btn = el('button', 'publisher-button', action) as HTMLButtonElement
  btn.type = 'button'
  btn.disabled = true
  row.appendChild(btn)
  return row
}

function renderSecurityCard(me: PublisherMeResponse): HTMLElement {
  const rows = el('div', 'publisher-account-security')
  rows.appendChild(securityRow(t('publisher.account.security.email'), me.email, t('publisher.account.security.change')))
  rows.appendChild(
    securityRow(
      t('publisher.account.security.password'),
      t('publisher.account.security.passwordMasked'),
      t('publisher.account.security.changePassword'),
    ),
  )
  rows.appendChild(
    securityRow(
      t('publisher.account.security.twofa'),
      t('publisher.account.security.twofaStatus'),
      t('publisher.account.security.enable2fa'),
    ),
  )
  const note = el('p', 'publisher-account-idp-note', t('publisher.account.security.idpNote'))
  return card(heading(t('publisher.account.security.heading')), rows, note)
}

function renderSessionsCard(): HTMLElement {
  return card(
    heading(t('publisher.account.sessions.heading')),
    el('p', 'publisher-account-sessions-empty', t('publisher.account.sessions.unavailable')),
  )
}

function renderAccount(mount: HTMLElement, me: PublisherMeResponse, options: MePageOptions): void {
  const shell = el('main', 'publisher-shell publisher-account')
  let identityCard = renderIdentityCard(me)
  shell.appendChild(identityCard)
  shell.appendChild(
    renderProfileCard(me, options, () => {
      const next = renderIdentityCard(me)
      identityCard.replaceWith(next)
      identityCard = next
    }),
  )
  shell.appendChild(renderSecurityCard(me))
  shell.appendChild(renderSessionsCard())
  mount.replaceChildren(shell)
}

/**
 * Boot the /publish/me (Account) page. Renders a loading state,
 * kicks off the fetch via the shared `publisherGet` helper, then
 * swaps in the account view or an error card based on the result.
 * Idempotent. The auth-handling complexity lives in `../api.ts`.
 */
export async function renderMePage(mount: HTMLElement, options: MePageOptions = {}): Promise<void> {
  renderLoading(mount)
  const result = await publisherGet<PublisherMeResponse>(ME_ENDPOINT, {
    fetchFn: options.fetchFn,
    sleep: options.sleep,
  })
  if (result.ok) {
    clearWarmupFlag()
    renderAccount(mount, result.data, options)
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
  // `not_found` is unexpected for /me — treat as a generic network
  // error so the user sees a Refresh option.
  renderError(mount, result.kind)
}
