/**
 * Pre-merge probe for the slice-C AI date/location enrichment
 * (`functions/api/v1/_lib/events-enrich.ts`).
 *
 * Pulls a handful of *live* items from real feeds, builds the exact
 * production prompt, calls the real Workers AI model over the REST API,
 * and runs each reply through the production validation pipeline
 * (JSON extraction → confidence gate → date plausibility → regions.ts
 * place resolution). The output shows precisely what would land in the
 * curator queue — the part the stubbed unit tests can't cover.
 *
 * Run it locally with your own Cloudflare credentials (an API token
 * with Workers AI permission); nothing is written anywhere:
 *
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
 *     npx tsx scripts/enrich-probe.ts [--per-feed 4] [--feed <rss url>]...
 *
 * Dev tooling — output is intentionally not i18n'd.
 */

import { parseRssFeed } from '../cli/lib/rss'
import {
  buildEnrichPrompt,
  extractJsonObject,
  isPlausibleDate,
  ENRICH_MODEL_ID,
  MIN_CONFIDENCE,
} from '../functions/api/v1/_lib/events-enrich'
import { resolveRegion } from '../src/data/regions'

/** Plain-news defaults — no GeoRSS, no structured dates, so every item
 *  exercises the enrichment path. Override with --feed. */
const DEFAULT_FEEDS = [
  'https://www.theguardian.com/environment/rss',
  'https://reliefweb.int/disasters/rss.xml',
  'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
]

function argValues(flag: string): string[] {
  const out: string[] = []
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1]) out.push(argv[++i])
  }
  return out
}

async function runModel(
  accountId: string,
  token: string,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${ENRICH_MODEL_ID}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, max_tokens: 128 }),
    },
  )
  if (!res.ok) throw new Error(`Workers AI responded ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const body = (await res.json()) as { result?: { response?: string } }
  return body.result?.response ?? ''
}

async function main(): Promise<number> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!accountId || !token) {
    console.error(
      'Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (a token with Workers AI permission).',
    )
    return 2
  }
  const feeds = argValues('--feed').length > 0 ? argValues('--feed') : DEFAULT_FEEDS
  const perFeed = Number(argValues('--per-feed')[0] ?? 4)

  let accepted = 0
  let rejected = 0
  for (const url of feeds) {
    console.log(`\n━━ ${url}`)
    let xml: string
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`feed responded ${res.status}`)
      xml = await res.text()
    } catch (e) {
      console.log(`  (skipped: ${e instanceof Error ? e.message : String(e)})`)
      continue
    }
    const items = parseRssFeed(xml).slice(0, perFeed)
    for (const item of items) {
      const input = { title: item.title, summary: item.summary ?? null, publishedAt: item.publishedAt ?? null }
      const { system, user } = buildEnrichPrompt(input)
      let reply: string
      try {
        reply = await runModel(accountId, token, [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ])
      } catch (e) {
        console.log(`  ✗ model call failed: ${e instanceof Error ? e.message : String(e)}`)
        continue
      }

      console.log(`\n  「${item.title}」`)
      console.log(`    published: ${item.publishedAt ?? '—'}`)
      console.log(`    model:     ${reply.replace(/\s+/g, ' ').slice(0, 160)}`)

      // The exact production validation pipeline, step by step.
      const parsed = extractJsonObject(reply)
      if (!parsed) {
        console.log('    → REJECTED: unparseable output')
        rejected++
        continue
      }
      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0
      if (confidence < MIN_CONFIDENCE) {
        console.log(`    → REJECTED: confidence ${confidence} < ${MIN_CONFIDENCE}`)
        rejected++
        continue
      }
      const verdicts: string[] = []
      if (typeof parsed.date === 'string') {
        verdicts.push(
          isPlausibleDate(parsed.date, input.publishedAt)
            ? `date ✓ ${parsed.date.slice(0, 10)}`
            : `date ✗ ${parsed.date} (implausible vs publish anchor)`,
        )
      } else verdicts.push('date — (null)')
      if (typeof parsed.place === 'string') {
        const region = resolveRegion(parsed.place)
        verdicts.push(
          region
            ? `place ✓ ${region.name} [${region.bounds.join(', ')}]`
            : `place ✗ "${parsed.place}" (not in regions.ts — dropped)`,
        )
      } else verdicts.push('place — (null)')
      console.log(`    → ACCEPTED (conf ${confidence}): ${verdicts.join(' · ')}`)
      accepted++
    }
  }
  console.log(`\nDone. ${accepted} accepted, ${rejected} gated out.`)
  return 0
}

main().then(
  code => process.exit(code),
  err => {
    console.error(err)
    process.exit(1)
  },
)
