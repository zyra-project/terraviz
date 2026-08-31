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
 */
export function isWorkersAiQuotaError(err: unknown): boolean {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : ''
  if (!message) return false
  return QUOTA_PATTERNS.some(re => re.test(message))
}
