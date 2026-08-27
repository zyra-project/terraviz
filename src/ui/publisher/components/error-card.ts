// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Shared error-card renderer used by every portal page.
 *
 * Five surfaces, each with its own primary action:
 *
 *   - `session` → "Sign in" button (top-level nav through the
 *     redirect-back endpoint, same URL the auto-warmup uses).
 *   - `network` / `server` → "Refresh" button (plain reload).
 *   - `not_found` → no action button; the page-level back link
 *     handles recovery.
 *
 * For `server`, additionally renders a `<details>` disclosure
 * with the HTTP status code and response body. This is the
 * operator-debugging affordance: a 503 `identity_missing`, a 403
 * with a structured error envelope, or a 5xx
 * `{error, message}` payload from the publish-middleware's
 * exception wrap are all far more useful exposed than swallowed
 * behind a generic "the server returned an error" line.
 */

import { t } from '../../../i18n'
import { buildSignInUrl } from '../api'

export type ErrorKind = 'session' | 'server' | 'network' | 'not_found'

export interface ErrorCardDetails {
  /** HTTP status code for `server` kind; ignored otherwise. */
  status?: number
  /** Raw response body for `server` kind; ignored otherwise. */
  body?: string
}

/**
 * Build the error card DOM. Doesn't mount itself — caller appends
 * the returned element into its own shell. Idempotent / pure
 * (no event listeners survive between renders).
 */
export function buildErrorCard(
  kind: ErrorKind,
  details: ErrorCardDetails = {},
): HTMLElement {
  const card = document.createElement('section')
  card.className = 'publisher-card publisher-glass publisher-error'
  card.setAttribute('role', 'alert')

  const msg = document.createElement('p')
  msg.className = 'publisher-error-message'
  msg.textContent = messageFor(kind)
  card.appendChild(msg)

  if (kind === 'server' && (details.status || details.body)) {
    card.appendChild(buildServerDetails(details))
  }

  const action = actionFor(kind)
  if (action) card.appendChild(action)
  return card
}

function messageFor(kind: ErrorKind): string {
  switch (kind) {
    case 'session':
      return t('publisher.me.error.session')
    case 'network':
      return t('publisher.me.error.network')
    case 'not_found':
      return t('publisher.datasetDetail.notFound')
    case 'server':
      return t('publisher.me.error.server')
  }
}

function actionFor(kind: ErrorKind): HTMLElement | null {
  // not_found has no retry action — the page-level back link is
  // the right recovery.
  if (kind === 'not_found') return null

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'publisher-button'
  if (kind === 'session') {
    btn.textContent = t('publisher.me.error.signIn')
    btn.addEventListener('click', () => {
      window.location.href = buildSignInUrl()
    })
  } else {
    btn.textContent = t('publisher.me.error.refresh')
    btn.addEventListener('click', () => {
      window.location.reload()
    })
  }
  return btn
}

/**
 * Render a `<details>` disclosure with the HTTP status and the
 * raw response body. Operator-debugging affordance: closed by
 * default so the generic message dominates the surface, but a
 * publisher (who in Phase 3 IS the operator) can expand to see
 * the underlying server response when something goes wrong.
 */
function buildServerDetails(details: ErrorCardDetails): HTMLElement {
  const wrap = document.createElement('details')
  wrap.className = 'publisher-error-details'

  const summary = document.createElement('summary')
  summary.textContent = t('publisher.error.detailsSummary')
  wrap.appendChild(summary)

  if (details.status) {
    const status = document.createElement('p')
    status.className = 'publisher-error-status'
    status.textContent = t('publisher.error.statusLine', { status: details.status })
    wrap.appendChild(status)
  }

  if (details.body) {
    const pre = document.createElement('pre')
    pre.className = 'publisher-error-body'
    // textContent (not innerHTML) so a malicious / malformed body
    // can't escape into DOM markup.
    pre.textContent = formatBody(details.body)
    wrap.appendChild(pre)
  }
  return wrap
}

/**
 * Pretty-print a JSON response body if we can; fall through to
 * the raw text otherwise. Bounded to 4 KB so a runaway HTML
 * 500-page response doesn't blow up the card.
 */
function formatBody(raw: string): string {
  const truncated =
    raw.length > 4096 ? raw.slice(0, 4096) + '\n…(truncated)' : raw
  try {
    return JSON.stringify(JSON.parse(truncated), null, 2)
  } catch {
    return truncated
  }
}
