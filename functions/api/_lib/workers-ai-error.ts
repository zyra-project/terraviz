// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Workers AI error classification helper for Phase 1f/D's quota
 * guard rail.
 *
 * Workers AI surfaces "you have exhausted your free-tier neuron
 * budget" as an exception whose `.message` contains the platform
 * code. The exact wording has shifted over time
 * ("3036 neurons exhausted", "4006 quota exceeded"); pattern-
 * matching the message is the cheapest reliable signal short of a
 * dedicated usage API (which doesn't exist for free-tier accounts
 * at the time of writing).
 *
 * The helper is shared between:
 *   - `functions/api/chat/completions.ts` — wraps `ai.run` in a
 *     try/catch and labels quota-shaped errors as 503
 *     `quota_exhausted` so the SPA can degrade gracefully.
 *   - `functions/api/v1/_lib/search-datasets.ts` — wraps the
 *     embed + query path and returns
 *     `degraded: 'quota_exhausted'` on the same signal.
 *
 * **Conservative on false positives.** The patterns below match
 * unambiguous customer-quota signals only. We deliberately do
 * NOT match "Capacity temporarily exceeded for this model" /
 * "Service temporarily unavailable" / similar generic load-
 * shedding messages — those text strings are also used for
 * provider-side incidents where the customer has plenty of
 * quota left. Misclassifying load-shedding as quota exhaustion
 * would route operators toward "upgrade to Workers Paid" when
 * the right action is "wait for the Cloudflare incident to
 * clear" (Phase 1f/N — caught by Copilot review on 1f/D).
 */

const QUOTA_PATTERNS: RegExp[] = [
  /\b4006\b/,
  /\b3036\b/,
  /quota\s+exceeded/i,
  /quota\s+exhausted/i,
  /neurons?\s+exhausted/i,
  /free[-\s]tier\s+limit/i,
]

/**
 * Returns true when the error looks like a Workers AI quota /
 * neuron-budget exhaustion. Pattern-based; conservative on false
 * positives. Accepts any caught value (Error / string / unknown).
 *
 * A message that is itself a JSON error body is reduced to its
 * error text first (`workersAiErrorMessage`), here rather than in
 * each caller, so no caller can forget: the patterns must match the
 * error, not a `request_id` that happens to contain `4006`.
 */
export function isWorkersAiQuotaError(err: unknown): boolean {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : ''
  const message = workersAiErrorMessage(raw)
  if (!message) return false
  return QUOTA_PATTERNS.some(re => re.test(message))
}

/**
 * The error text inside a Workers AI error body, for classifying and
 * reporting it.
 *
 * `isWorkersAiQuotaError` is pattern-based, so it must only ever see
 * the platform's error *message* (it applies this itself): run over
 * a whole JSON envelope,
 * `\b4006\b` also matches a `request_id` such as
 * `9f1c2b7a-3e5d-4006-…`, and a 400 "No such model" came back as
 * `quota_exhausted`. A JSON object body is reduced to its error
 * `code: message` pairs — the Cloudflare `{ errors: [{ code,
 * message }] }` envelope, `{ error: "…" }`, `{ error: { code,
 * message } }`, `{ internalCode, description }` and a top-level
 * `{ code, message }`. A JSON body in none of those shapes yields
 * `''` (nothing trustworthy to classify, and not worth echoing to
 * the client); anything that is not a JSON object is returned as
 * is, since then the text *is* the message.
 */
export function workersAiErrorMessage(body: string): string {
  if (!body.trim().startsWith('{')) return body
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  if (!parsed || typeof parsed !== 'object') return ''
  const obj = parsed as Record<string, unknown>

  if (Array.isArray(obj.errors)) {
    const parts = obj.errors
      .map(e => (e && typeof e === 'object' ? codeAndMessage(e as Record<string, unknown>) : ''))
      .filter(Boolean)
    if (parts.length) return parts.join('; ')
  }
  if (typeof obj.error === 'string') return obj.error
  if (obj.error && typeof obj.error === 'object') {
    const inner = codeAndMessage(obj.error as Record<string, unknown>)
    if (inner) return inner
  }
  if (typeof obj.description === 'string') {
    return codeAndMessage({ code: obj.internalCode, message: obj.description })
  }
  return codeAndMessage(obj)
}

function codeAndMessage(e: Record<string, unknown>): string {
  const message = typeof e.message === 'string' ? e.message : ''
  const code = typeof e.code === 'number' || typeof e.code === 'string' ? String(e.code) : ''
  if (code && message) return `${code}: ${message}`
  return message || code
}
