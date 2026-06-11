/**
 * /api/v1/publish/analytics-export — the nightly analytics export
 * tick (Phase A of `docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md`).
 *
 * POST          → export every day from the bookmark
 *                 (`analytics_export_state.last_day + 1`) through
 *                 yesterday (UTC), capped at MAX_DAYS_PER_RUN per
 *                 invocation so a long-dormant deploy catches up
 *                 across several ticks instead of timing out on
 *                 one. First run (no bookmark) exports just
 *                 yesterday. The bookmark advances after each
 *                 successfully exported day, so a mid-run failure
 *                 keeps completed progress.
 * POST ?day=…   → re-export one explicit day (`YYYY-MM-DD`, UTC,
 *                 in the past). Idempotent; used for operator
 *                 backfill while AE still remembers the rows. Never
 *                 rewinds the bookmark.
 *
 * Caller must be privileged (staff / admin / service). The GHA cron
 * (`.github/workflows/analytics-export.yml`) authenticates with the
 * same Cloudflare Access service token the Zyra scheduler uses; the
 * publish middleware JIT-provisions it as `role='service'`.
 *
 * 503 `export_unconfigured` spells out which of the four pieces
 * (CATALOG_DB, ANALYTICS_R2, CF_ACCOUNT_ID, ANALYTICS_SQL_TOKEN) is
 * missing so a fork's first deploy is debuggable from the response.
 */

import type { CatalogEnv } from '../_lib/env'
import type { PublisherData } from './_middleware'
import {
  addDays,
  exportDay,
  isValidDay,
  readBookmark,
  advanceBookmark,
  yesterdayUtc,
  type ExportDaySummary,
} from '../_lib/analytics-export'
import { isPrivileged } from '../_lib/publisher-store'
import { writeAuditEvent } from '../_lib/audit-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

/** Catch-up cap per invocation. Daily cron means this only matters
 * after an outage; 7 keeps the worst tick bounded. */
export const MAX_DAYS_PER_RUN = 7

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  const env = context.env
  const missing = [
    !env.CATALOG_DB && 'CATALOG_DB',
    !env.ANALYTICS_R2 && 'ANALYTICS_R2',
    !env.CF_ACCOUNT_ID && 'CF_ACCOUNT_ID',
    !env.ANALYTICS_SQL_TOKEN && 'ANALYTICS_SQL_TOKEN',
  ].filter((m): m is string => typeof m === 'string')
  if (missing.length > 0) {
    return jsonError(
      503,
      'export_unconfigured',
      `Analytics export is not configured on this deployment. Missing: ${missing.join(', ')}.`,
    )
  }
  const db = env.CATALOG_DB!
  const r2 = env.ANALYTICS_R2!
  const sql = {
    accountId: env.CF_ACCOUNT_ID!,
    token: env.ANALYTICS_SQL_TOKEN!,
    dataset: env.ANALYTICS_AE_DATASET,
  }

  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(
      403,
      'forbidden_role',
      'Analytics export is restricted to staff, admin, and service callers.',
    )
  }

  const explicitDay = new URL(context.request.url).searchParams.get('day')
  const yesterday = yesterdayUtc()

  let days: string[]
  if (explicitDay !== null) {
    if (!isValidDay(explicitDay) || explicitDay > yesterday) {
      return jsonError(
        400,
        'invalid_day',
        `day must be a complete UTC day in YYYY-MM-DD form, no later than ${yesterday}.`,
      )
    }
    days = [explicitDay]
  } else {
    const bookmark = await readBookmark(db)
    const first = bookmark ? addDays(bookmark, 1) : yesterday
    days = []
    for (let day = first; day <= yesterday && days.length < MAX_DAYS_PER_RUN; day = addDays(day, 1)) {
      days.push(day)
    }
  }

  const exported: ExportDaySummary[] = []
  let failure: { day: string; message: string } | null = null
  for (const day of days) {
    try {
      exported.push(await exportDay({ db, r2, sql, day }))
      if (explicitDay === null) await advanceBookmark(db, day)
    } catch (err) {
      // Log the full error for `wrangler tail`; the wire response
      // carries only the first line (same posture as the publish
      // middleware's sanitizer).
      console.error(`[analytics-export] day ${day} failed`, err)
      const raw = err instanceof Error ? err.message : String(err)
      failure = { day, message: raw.split('\n', 1)[0] ?? '' }
      break
    }
  }

  if (exported.length > 0) {
    await writeAuditEvent(db, {
      actor_kind: 'publisher',
      actor_id: publisher.id,
      action: 'analytics.export',
      subject_kind: 'analytics_day',
      subject_id: exported[exported.length - 1].day,
      metadata_json: JSON.stringify({
        days: exported.map(d => d.day),
        rows: exported.reduce((n, d) => n + d.rows, 0),
        truncated_chunks: exported.reduce((n, d) => n + d.truncatedChunks, 0),
      }),
    })
  }

  if (failure) {
    return new Response(JSON.stringify({ error: 'export_failed', ...failure, exported }), {
      status: 502,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }
  return new Response(JSON.stringify({ exported }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}
