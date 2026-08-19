/** `terraviz import-sos inventory` — safe native-SOS discovery and conversion planning. */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { CommandContext } from './commands'
import { getBool, getBoolDefault, getNumber, getString } from './lib/args'
import { loadSosCatalog } from './lib/sos-catalog'
import { buildSosConversionPlans, loadSosImportPolicy } from './lib/sos-conversion'
import { crawlSosPlaylists } from './lib/sos-crawler'
import { createSosPlaylistReader } from './lib/sos-source'
import { sosPathToFtpUrl } from './lib/sos-source'

export interface SosInventoryDocument {
  schemaVersion: 1
  generatedAt: string
  mode: 'metadata-only'
  inputs: { catalog: string; roots: string[]; policy: string | null }
  counts: {
    catalogDatasets: number
    playlists: number
    clips: number
    readyForTransfer: number
    needsReview: number
    unsupported: number
    crawlIssues: number
  }
  crawl: Awaited<ReturnType<typeof crawlSosPlaylists>>
  plans: ReturnType<typeof buildSosConversionPlans>
}

function usage(ctx: CommandContext): number {
  ctx.stderr.write(
    'Usage: terraviz import-sos inventory <root.sos> [...] --catalog=<sos_sqlite.db>\n' +
      '       [--output=<inventory.json>] [--cache-dir=<dir>] [--policy=<policy.yaml>]\n' +
      '       [--max-depth=9] [--max-playlist-bytes=5242880] [--timeout-ms=30000]\n' +
      '       [--no-network] [--refresh]\n',
  )
  return 2
}

export async function runImportSos(ctx: CommandContext): Promise<number> {
  const [subcommand, ...positionalRoots] = ctx.args.positional
  if (subcommand !== 'inventory' && subcommand !== 'plan') return usage(ctx)

  const catalogOption = getString(ctx.args.options, 'catalog')
  if (!catalogOption) return usage(ctx)
  const rootOption = getString(ctx.args.options, 'playlist')
  const roots = [...positionalRoots, ...(rootOption ? [rootOption] : [])].map(root => {
    const mapped = sosPathToFtpUrl(root)
    if (mapped) return mapped
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(root)) return root
    return resolve(root)
  })
  if (roots.length === 0) return usage(ctx)

  const catalogPath = resolve(catalogOption)
  const outputPath = resolve(getString(ctx.args.options, 'output') ?? 'sos-import-inventory.json')
  const policyPath = getString(ctx.args.options, 'policy')
  const cacheDir = resolve(
    getString(ctx.args.options, 'cache-dir') ?? '.cache/terraviz/sos-playlists',
  )
  const maxDepth = getNumber(ctx.args.options, 'max-depth') ?? 9
  const maxBytes = getNumber(ctx.args.options, 'max-playlist-bytes') ?? 5 * 1024 * 1024
  const timeoutMs = getNumber(ctx.args.options, 'timeout-ms') ?? 30_000

  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 50) {
    ctx.stderr.write('--max-depth must be an integer from 0 to 50.\n')
    return 2
  }
  if (!(maxBytes > 0) || !(timeoutMs > 0)) {
    ctx.stderr.write('--max-playlist-bytes and --timeout-ms must be positive.\n')
    return 2
  }

  try {
    const catalog = loadSosCatalog(catalogPath)
    const policy = loadSosImportPolicy(policyPath ? resolve(policyPath) : undefined)
    const reader = createSosPlaylistReader({
      cacheDir,
      maxBytes,
      timeoutMs,
      refresh: getBool(ctx.args.options, 'refresh'),
      allowNetwork: getBoolDefault(ctx.args.options, 'network', true),
    })
    const crawl = await crawlSosPlaylists(roots, reader, { maxDepth })
    const plans = buildSosConversionPlans(crawl.playlists, catalog, policy)
    const document: SosInventoryDocument = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      mode: 'metadata-only',
      inputs: { catalog: catalogPath, roots, policy: policyPath ? resolve(policyPath) : null },
      counts: {
        catalogDatasets: catalog.datasets.length,
        playlists: crawl.playlists.length,
        clips: plans.length,
        readyForTransfer: plans.filter(plan => plan.readiness === 'ready_for_transfer').length,
        needsReview: plans.filter(plan => plan.readiness === 'needs_review').length,
        unsupported: plans.filter(plan => plan.readiness === 'unsupported').length,
        crawlIssues: crawl.issues.length,
      },
      crawl,
      plans,
    }
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    ctx.stdout.write(
      `SOS inventory written to ${outputPath}\n` +
        `  catalog datasets:   ${document.counts.catalogDatasets}\n` +
        `  playlists fetched:  ${document.counts.playlists}\n` +
        `  clips planned:      ${document.counts.clips}\n` +
        `  ready for transfer: ${document.counts.readyForTransfer}\n` +
        `  needs review:       ${document.counts.needsReview}\n` +
        `  unsupported:        ${document.counts.unsupported}\n` +
        `  crawl issues:       ${document.counts.crawlIssues}\n`,
    )
    const rootFailures = crawl.issues.filter(issue =>
      roots.includes(issue.source) && issue.code === 'fetch_failed',
    )
    return rootFailures.length ? 1 : 0
  } catch (error) {
    ctx.stderr.write(`SOS inventory failed: ${error instanceof Error ? error.message : error}\n`)
    return 1
  }
}
