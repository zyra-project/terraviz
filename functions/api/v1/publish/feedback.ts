/**
 * GET /api/v1/publish/feedback — feedback review for the
 * `/publish/feedback` portal tab (Phase C of
 * `docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md`).
 *
 * A thin read-only facade over the same `_feedback-helpers`
 * the legacy `/api/feedback-admin` endpoint uses — one data layer,
 * two auth surfaces (this one rides the publish middleware and is
 * readable by any active publisher; feedback-admin keeps Cloudflare
 * Access / bearer-token for scripts). Views:
 *
 *   ?view=ai&days=30&recent=100         → AI thumbs dashboard JSON
 *   ?view=general&days=30&recent=100    → bug/feature/other/idea/content JSON
 *   ?view=screenshot&id=N               → one inline screenshot data URL
 *   ?view=screenshot-file&id=N          → one R2-backed screenshot,
 *                                         streamed as image bytes (the
 *                                         standalone widget's PNGs);
 *                                         list rows carry
 *                                         `screenshotIsFile` so the
 *                                         portal picks the right view
 *
 * CSV/JSONL exports intentionally stay on
 * `/api/feedback-admin?action=…` — they're machine interfaces with
 * their own bearer-token fallback; the portal page links out.
 *
 * No KV caching: feedback volume is tiny, the data is already in
 * D1, and a reviewer expects a just-submitted report to appear on
 * refresh.
 */

import type { CatalogEnv } from '../_lib/env'
import {
  fetchAiDashboard,
  fetchGeneralDashboard,
  fetchScreenshot,
} from '../../_feedback-helpers'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const ALLOWED_VIEWS = ['ai', 'general', 'screenshot', 'screenshot-file'] as const

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

/** Clamp an integer query param into [min, max], falling back to
 * `fallback` on absent/malformed input (review filters, unlike the
 * analytics endpoint's strict enums, are tolerant ranges). */
function intParam(params: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = params.get(name)
  if (raw === null) return fallback
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed) || String(parsed) !== raw.trim()) return fallback
  return Math.min(Math.max(parsed, min), max)
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.FEEDBACK_DB) {
    return jsonError(503, 'binding_missing', 'FEEDBACK_DB binding is not configured on this deployment.')
  }
  // Read-only view is open to any active publisher (the middleware
  // has already rejected pending / suspended accounts). There are no
  // mutation routes under this path — the page only reads.
  const params = new URL(context.request.url).searchParams
  const view = params.get('view') ?? ''
  if (!(ALLOWED_VIEWS as readonly string[]).includes(view)) {
    return jsonError(400, 'invalid_view', `view must be one of: ${ALLOWED_VIEWS.join(', ')}.`)
  }
  const db = context.env.FEEDBACK_DB

  if (view === 'screenshot' || view === 'screenshot-file') {
    // Strict parse, no clamping — an identifier is either valid or
    // it isn't; rounding `id=0` up to row 1 would serve the wrong
    // record.
    const raw = params.get('id') ?? ''
    const id = /^[1-9]\d*$/.test(raw) ? parseInt(raw, 10) : 0
    if (id < 1) {
      return jsonError(400, 'invalid_id', 'id must be a positive integer.')
    }
    const result = await fetchScreenshot(db, id)
    if (!result) {
      return jsonError(404, 'not_found', `No screenshot for general_feedback id ${id}.`)
    }

    if (view === 'screenshot-file') {
      // R2-backed binary (standalone widget). Streamed rather than
      // re-encoded to a data URL — these run up to ~9 MB.
      if (!result.r2Key || !context.env.CATALOG_R2) {
        return jsonError(404, 'not_found', `No stored screenshot file for general_feedback id ${id}.`)
      }
      const object = await context.env.CATALOG_R2.get(result.r2Key)
      if (!object) {
        return jsonError(404, 'not_found', `Screenshot object is missing from R2 for general_feedback id ${id}.`)
      }
      // nosniff + inline disposition: the bytes are attacker-supplied
      // (magic-checked as PNG at ingest); make sure no browser ever
      // reinterprets them as anything but the declared image type.
      return new Response(object.body, {
        status: 200,
        headers: {
          'Content-Type': object.httpMetadata?.contentType ?? 'image/png',
          'Content-Disposition': `inline; filename="feedback-${id}.png"`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store',
        },
      })
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
    })
  }

  const days = intParam(params, 'days', 30, 1, 365)
  const recent = intParam(params, 'recent', 100, 1, 200)
  const data =
    view === 'ai'
      ? await fetchAiDashboard(db, days, recent)
      : await fetchGeneralDashboard(db, days, recent)
  return new Response(JSON.stringify({ view, days, data }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}
