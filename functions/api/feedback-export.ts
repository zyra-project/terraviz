// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Cloudflare Pages Function — /api/feedback-export
 *
 * Streams feedback as JSONL for RLHF training data extraction.
 *
 * Auth: `_feedback-auth.ts`. A Cloudflare Access token verified
 * against the team's keys (preferred), else the legacy
 * `FEEDBACK_ADMIN_TOKEN` bearer, kept for `wrangler dev`, scripts
 * and break-glass. §6.4's Access application covers only
 * `/api/feedback-admin`, so on such a node this path takes the
 * bearer or a token the caller sends itself.
 *
 * The web admin UI no longer calls this path directly — the
 * dashboard at `/api/feedback-admin` proxies the same export
 * via `?action=ai-export` so a single Access destination covers
 * every admin operation. This route remains for direct
 * scripting (CI exports, ad-hoc curl checks) and break-glass.
 *
 * GET /api/feedback-export
 *   ?since=ISO_DATE       — only entries after this date
 *   ?rating=thumbs-up     — filter by rating (thumbs-up or thumbs-down)
 *   ?limit=1000           — max entries (default 1000, max 10000)
 *   ?include_prompt=true  — include full system prompt (default false, saves bandwidth)
 */

import { authenticateFeedbackAdmin, type FeedbackAdminEnv } from './_feedback-auth'
import { streamAiExport } from './_feedback-helpers'

type Env = FeedbackAdminEnv

export const onRequestGet: PagesFunction<Env> = async (context) => {
  if (!(await authenticateFeedbackAdmin(context.request, context.env))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const db = context.env.FEEDBACK_DB
  if (!db) {
    return new Response(JSON.stringify({ error: 'Database not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const url = new URL(context.request.url)
  const since = url.searchParams.get('since')
  const rating = url.searchParams.get('rating')
  const includePrompt = url.searchParams.get('include_prompt') === 'true'
  const limit = parseInt(url.searchParams.get('limit') ?? '1000') || 1000

  try {
    const stream = await streamAiExport(db, { since, rating, includePrompt, limit })
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/jsonl',
        'Content-Disposition': `attachment; filename="feedback-export-${new Date().toISOString().slice(0, 10)}.jsonl"`,
      },
    })
  } catch (err) {
    console.error('Export query failed:', err)
    return new Response(JSON.stringify({ error: 'Export failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
