/**
 * General Feedback Service — posts app-level feedback (bug reports,
 * feature requests, other) to /api/general-feedback.
 *
 * Distinct from the AI response feedback flow in chatUI.ts; this one
 * is driven by the help panel's feedback form.
 *
 * Uses the browser/webview native fetch rather than the Tauri HTTP
 * plugin. The endpoint is same-origin, so native fetch resolves the
 * relative URL correctly and sends an Origin header that matches the
 * server's CORS allowlist — mirrors chatUI.submitInlineRating() which
 * also uses plain fetch() to hit /api/feedback on both web and desktop.
 * The Tauri HTTP plugin is only needed for cross-origin calls like
 * local LLM servers where the webview's CORS policy would block the
 * request.
 */

import type { GeneralFeedbackPayload } from '../types'
import { logger } from '../utils/logger'

export interface SubmitResult {
  ok: boolean
  status: number
  error?: string
}

/**
 * POST a general feedback payload to the server. Returns a SubmitResult
 * describing success/failure — callers should surface the error message
 * in the UI rather than throwing.
 */
export async function submitGeneralFeedback(payload: GeneralFeedbackPayload): Promise<SubmitResult> {
  try {
    const res = await fetch('/api/general-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.ok) {
      return { ok: true, status: res.status }
    }
    let error = `HTTP ${res.status}`
    try {
      const body = await res.json() as { error?: string }
      if (body?.error) error = body.error
    } catch {
      // non-JSON error body
    }
    return { ok: false, status: res.status, error }
  } catch (err) {
    logger.warn('[generalFeedback] network error', err)
    return { ok: false, status: 0, error: 'Network error — please try again' }
  }
}
