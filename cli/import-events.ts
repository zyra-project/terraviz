// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `terraviz import-events` — ingest current events into the catalog
 * (`docs/CURRENT_EVENTS_PLAN.md` §9).
 *
 * **Default mode: registry-driven.** One `POST
 * /api/v1/publish/events/refresh` has the backend iterate its enabled
 * feed connectors (EONET + any operator-added RSS feeds from the
 * `/publish/feeds` console), fetch each feed server-side, and run the
 * shared upsert + match (+ AI enrichment) path. The cron therefore
 * ingests whatever the node is *configured* for, not a hardcoded feed.
 *
 * **Direct mode** (`--file` / `--source-url`): fetch/read one EONET
 * feed locally, map it with the pure `lib/eonet.ts` mapper, and POST
 * each body to the create endpoint — offline runs, tests, and one-off
 * backfills of a specific feed.
 *
 * Both paths are idempotent on `(feed_id, external_id)` — re-runs
 * refresh open events instead of duplicating them — and every ingested
 * event lands `proposed`; nothing reaches end-users until a curator
 * approves it.
 *
 * Typically run on a schedule (see `.github/workflows/import-events.yml`)
 * with a Cloudflare Access service token. `--dry-run` prints the plan
 * without writing.
 */

import { readFileSync } from 'node:fs'
import type { CommandContext } from './commands'
import { getString, getBool, getNumber } from './lib/args'
import { mapEonetFeed, EONET_DEFAULT_URL, type EonetFeed, type EventCreateBody } from './lib/eonet'

/** Modest pacing between create round-trips. The endpoint runs the
 *  matcher per event; pacing keeps a batch gentle on the backend. */
const DEFAULT_PACE_MS = 150

interface CreateEnvelope {
  created: boolean
  event: { id: string; title: string } | null
}

/** The refresh endpoint's aggregate + per-connector summary. */
interface RefreshEnvelope {
  fetched: number
  mappable: number
  created: number
  refreshed: number
  failed: number
  feeds: Array<{ id: string; kind: string; label: string; created: number; refreshed: number; failed: number; error?: string }>
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function loadFeed(ctx: CommandContext, file: string | undefined, sourceUrl: string): Promise<EonetFeed> {
  if (file) {
    const reader = ctx.readFile ?? ((p: string) => readFileSync(p, 'utf-8'))
    return JSON.parse(reader(file)) as EonetFeed
  }
  const res = await fetch(sourceUrl)
  if (!res.ok) throw new Error(`feed fetch failed (${res.status}) for ${sourceUrl}`)
  return (await res.json()) as EonetFeed
}

/** Registry-driven default: one server-side pull over every enabled
 *  connector. The per-feed outcomes come back in the response. */
async function runRefreshMode(ctx: CommandContext, dryRun: boolean): Promise<number> {
  if (dryRun) {
    ctx.stdout.write(
      'Dry run — would trigger POST /api/v1/publish/events/refresh (the ' +
        'server pulls every enabled feed connector). Re-run without ' +
        '--dry-run to apply.\n',
    )
    return 0
  }
  const result = await ctx.client.refreshEvents<RefreshEnvelope>()
  if (!result.ok) {
    ctx.stderr.write(
      `refresh failed (${result.status}): ${result.error}` +
        (result.message ? ` — ${result.message}` : '') +
        '\n',
    )
    return 1
  }
  const r = result.body
  ctx.stdout.write(
    `Registry refresh complete (${r.feeds.length} enabled connector(s)):\n` +
      `  fetched:               ${r.fetched}\n` +
      `  mappable:              ${r.mappable}\n` +
      `  created:               ${r.created}\n` +
      `  refreshed (existing):  ${r.refreshed}\n` +
      `  failed:                ${r.failed}\n`,
  )
  for (const f of r.feeds) {
    ctx.stdout.write(
      `  - ${f.label} [${f.kind}]: +${f.created} / ~${f.refreshed} / !${f.failed}` +
        (f.error ? ` — ${f.error}` : '') +
        '\n',
    )
  }
  return r.failed > 0 || r.feeds.some(f => f.error) ? 1 : 0
}

export async function runImportEvents(ctx: CommandContext): Promise<number> {
  const file = getString(ctx.args.options, 'file')
  const sourceUrlOpt = getString(ctx.args.options, 'source-url')
  const dryRun = getBool(ctx.args.options, 'dry-run')
  const paceMs = getNumber(ctx.args.options, 'pace-ms') ?? DEFAULT_PACE_MS

  // No explicit feed → the registry-driven server-side pull.
  if (!file && !sourceUrlOpt) return runRefreshMode(ctx, dryRun)

  const sourceUrl = sourceUrlOpt ?? EONET_DEFAULT_URL
  let feed: EonetFeed
  try {
    feed = await loadFeed(ctx, file, sourceUrl)
  } catch (e) {
    ctx.stderr.write(`Could not load the EONET feed: ${e instanceof Error ? e.message : String(e)}\n`)
    return 2
  }

  const bodies: EventCreateBody[] = mapEonetFeed(feed)
  const total = Array.isArray(feed.events) ? feed.events.length : 0
  ctx.stdout.write(
    `EONET ingest plan:\n` +
      `  feed events:           ${total}\n` +
      `  mappable events:       ${bodies.length}\n` +
      `  skipped (unmappable):  ${total - bodies.length}\n`,
  )

  if (dryRun) {
    ctx.stdout.write('\nDry run — no events will be ingested. Re-run without --dry-run to apply.\n')
    return 0
  }

  let created = 0
  let updated = 0
  let failed = 0
  for (const body of bodies) {
    const result = await ctx.client.createEvent<CreateEnvelope>(body as unknown as Record<string, unknown>)
    if (!result.ok) {
      failed++
      ctx.stderr.write(
        `[${body.externalId}] ingest failed (${result.status}): ${result.error}` +
          (result.message ? ` — ${result.message}` : '') +
          '\n',
      )
      if (result.errors?.length) {
        for (const e of result.errors) ctx.stderr.write(`    ${e.field}: ${e.code} — ${e.message}\n`)
      }
      continue
    }
    if (result.body.created) created++
    else updated++
    if (paceMs > 0) await sleep(paceMs)
  }

  ctx.stdout.write(
    `\nIngest complete:\n` +
      `  created:               ${created}\n` +
      `  refreshed (existing):  ${updated}\n` +
      `  failed:                ${failed}\n`,
  )
  return failed > 0 ? 1 : 0
}
