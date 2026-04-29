/**
 * Command implementations for the `terraviz` CLI.
 *
 * Each command is an async function over a `CommandContext` —
 * client + parsed-args + IO streams — that returns a numeric exit
 * code. The main entry point in `terraviz.ts` dispatches to the
 * right one and writes the exit code; that keeps the entry point
 * itself a 30-line argv-routing function while testing happens
 * directly against these handlers with a stubbed fetch.
 */

import { readFileSync } from 'node:fs'
import type { TerravizClient } from './lib/client'
import { getNumber, getString, type ParsedArgs } from './lib/args'

export interface CommandContext {
  client: TerravizClient
  args: ParsedArgs
  /** Test-friendly stdout sink; defaults to process.stdout in main. */
  stdout: { write(chunk: string): boolean }
  /** Test-friendly stderr sink; defaults to process.stderr in main. */
  stderr: { write(chunk: string): boolean }
  /** Test-friendly fs reader; defaults to readFileSync. */
  readFile?: (path: string) => string
}

interface DatasetEnvelope {
  dataset: { id: string; slug: string; title: string; published_at: string | null }
}
interface DatasetListEnvelope {
  datasets: Array<DatasetEnvelope['dataset']>
  next_cursor: string | null
}
interface TourEnvelope {
  tour: { id: string; slug: string; title: string; published_at: string | null }
}
interface PreviewEnvelope {
  token: string
  url: string
  expires_in: number
}
interface MeEnvelope {
  id: string
  email: string
  display_name: string
  role: string
  is_admin: boolean
  status: string
}

function readBodyFile(ctx: CommandContext, path: string): Record<string, unknown> {
  const reader = ctx.readFile ?? ((p: string) => readFileSync(p, 'utf-8'))
  let raw: string
  try {
    raw = reader(path)
  } catch (e) {
    throw new Error(`Could not read ${path}: ${e instanceof Error ? e.message : e}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${e instanceof Error ? e.message : e}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`)
  }
  return parsed as Record<string, unknown>
}

function emitFailure(ctx: CommandContext, status: number, error: string, message?: string, errors?: Array<{ field: string; code: string; message: string }>): number {
  ctx.stderr.write(`Error (${status}): ${error}${message ? ` — ${message}` : ''}\n`)
  if (errors?.length) {
    for (const e of errors) {
      ctx.stderr.write(`  ${e.field}: ${e.code} — ${e.message}\n`)
    }
  }
  return 1
}

function jsonOut(ctx: CommandContext, value: unknown): void {
  ctx.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

// --- me -----------------------------------------------------------

export async function runMe(ctx: CommandContext): Promise<number> {
  const result = await ctx.client.me<MeEnvelope>()
  if (!result.ok) return emitFailure(ctx, result.status, result.error, result.message)
  if (ctx.args.options.json === true) {
    jsonOut(ctx, result.body)
  } else {
    const m = result.body
    ctx.stdout.write(
      `${m.display_name} <${m.email}>\n` +
        `  id:       ${m.id}\n` +
        `  role:     ${m.role}${m.is_admin ? ' (admin)' : ''}\n` +
        `  status:   ${m.status}\n`,
    )
  }
  return 0
}

// --- list ---------------------------------------------------------

export async function runList(ctx: CommandContext): Promise<number> {
  const status = getString(ctx.args.options, 'status')
  if (status && !['draft', 'published', 'retracted'].includes(status)) {
    ctx.stderr.write(`--status must be one of draft|published|retracted (got "${status}").\n`)
    return 2
  }
  const limit = getNumber(ctx.args.options, 'limit')
  const cursor = getString(ctx.args.options, 'cursor')
  const result = await ctx.client.list<DatasetListEnvelope>({
    status: status as 'draft' | 'published' | 'retracted' | undefined,
    limit,
    cursor,
  })
  if (!result.ok) return emitFailure(ctx, result.status, result.error, result.message)

  if (ctx.args.options.json === true) {
    jsonOut(ctx, result.body)
    return 0
  }
  const rows = result.body.datasets
  if (rows.length === 0) {
    ctx.stdout.write('(no datasets)\n')
    return 0
  }
  for (const r of rows) {
    const state = r.published_at ? 'published' : 'draft'
    ctx.stdout.write(`${r.id}  ${state.padEnd(9)} ${r.slug.padEnd(40)} ${r.title}\n`)
  }
  if (result.body.next_cursor) {
    ctx.stdout.write(`-- more — pass --cursor=${result.body.next_cursor}\n`)
  }
  return 0
}

// --- get ----------------------------------------------------------

export async function runGet(ctx: CommandContext): Promise<number> {
  const id = ctx.args.positional[0]
  if (!id) {
    ctx.stderr.write('Usage: terraviz get <id>\n')
    return 2
  }
  const result = await ctx.client.get<DatasetEnvelope>(id)
  if (!result.ok) return emitFailure(ctx, result.status, result.error, result.message)
  jsonOut(ctx, result.body.dataset)
  return 0
}

// --- publish (create + flip to published) -------------------------

export async function runPublish(ctx: CommandContext): Promise<number> {
  const path = ctx.args.positional[0]
  if (!path) {
    ctx.stderr.write('Usage: terraviz publish <metadata.json>\n')
    return 2
  }
  let body: Record<string, unknown>
  try {
    body = readBodyFile(ctx, path)
  } catch (e) {
    ctx.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    return 2
  }
  const created = await ctx.client.createDataset<DatasetEnvelope>(body)
  if (!created.ok) {
    return emitFailure(ctx, created.status, created.error, created.message, created.errors)
  }
  const id = created.body.dataset.id
  ctx.stdout.write(`Created draft ${id} (${created.body.dataset.slug}).\n`)

  if (ctx.args.options['draft-only'] === true) {
    return 0
  }

  const flipped = await ctx.client.publishDataset<DatasetEnvelope>(id)
  if (!flipped.ok) {
    ctx.stderr.write(
      `Created the draft, but the publish step failed. The draft is at\n` +
        `  ${ctx.client.serverUrl}/api/v1/publish/datasets/${id}\n`,
    )
    return emitFailure(ctx, flipped.status, flipped.error, flipped.message, flipped.errors)
  }
  ctx.stdout.write(`Published ${id} (${flipped.body.dataset.published_at}).\n`)
  return 0
}

// --- update -------------------------------------------------------

export async function runUpdate(ctx: CommandContext): Promise<number> {
  const id = ctx.args.positional[0]
  const path = ctx.args.positional[1]
  if (!id || !path) {
    ctx.stderr.write('Usage: terraviz update <id> <metadata.json>\n')
    return 2
  }
  let body: Record<string, unknown>
  try {
    body = readBodyFile(ctx, path)
  } catch (e) {
    ctx.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    return 2
  }
  const result = await ctx.client.updateDataset<DatasetEnvelope>(id, body)
  if (!result.ok) {
    return emitFailure(ctx, result.status, result.error, result.message, result.errors)
  }
  ctx.stdout.write(`Updated ${id}.\n`)
  return 0
}

// --- retract ------------------------------------------------------

export async function runRetract(ctx: CommandContext): Promise<number> {
  const id = ctx.args.positional[0]
  if (!id) {
    ctx.stderr.write('Usage: terraviz retract <id>\n')
    return 2
  }
  const result = await ctx.client.retractDataset<DatasetEnvelope>(id)
  if (!result.ok) return emitFailure(ctx, result.status, result.error, result.message)
  ctx.stdout.write(`Retracted ${id}.\n`)
  return 0
}

// --- preview ------------------------------------------------------

export async function runPreview(ctx: CommandContext): Promise<number> {
  const id = ctx.args.positional[0]
  if (!id) {
    ctx.stderr.write('Usage: terraviz preview <id> [--ttl=<seconds>]\n')
    return 2
  }
  const ttlSeconds = getNumber(ctx.args.options, 'ttl')
  const result = await ctx.client.previewDataset<PreviewEnvelope>(id, {
    ttl_seconds: ttlSeconds,
  })
  if (!result.ok) return emitFailure(ctx, result.status, result.error, result.message)
  if (ctx.args.options.json === true) {
    jsonOut(ctx, result.body)
  } else {
    ctx.stdout.write(`${ctx.client.serverUrl}${result.body.url}\n`)
    ctx.stdout.write(`(expires in ${result.body.expires_in}s)\n`)
  }
  return 0
}

// --- tour subcommands ---------------------------------------------

export async function runTour(ctx: CommandContext): Promise<number> {
  const sub = ctx.args.positional[0]
  if (!sub) {
    ctx.stderr.write('Usage: terraviz tour <publish|update|preview> ...\n')
    return 2
  }
  // Re-shape the parsed args: the first positional was the subcommand,
  // pass the rest forward as positionals.
  const subArgs: ParsedArgs = {
    positional: ctx.args.positional.slice(1),
    options: ctx.args.options,
  }
  const subCtx: CommandContext = { ...ctx, args: subArgs }
  switch (sub) {
    case 'publish':
      return runTourPublish(subCtx)
    case 'update':
      return runTourUpdate(subCtx)
    case 'preview':
      return runTourPreview(subCtx)
    default:
      ctx.stderr.write(`Unknown tour subcommand: ${sub}\n`)
      return 2
  }
}

async function runTourPublish(ctx: CommandContext): Promise<number> {
  const path = ctx.args.positional[0]
  if (!path) {
    ctx.stderr.write('Usage: terraviz tour publish <metadata.json>\n')
    return 2
  }
  let body: Record<string, unknown>
  try {
    body = readBodyFile(ctx, path)
  } catch (e) {
    ctx.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    return 2
  }
  const result = await ctx.client.createTour<TourEnvelope>(body)
  if (!result.ok) {
    return emitFailure(ctx, result.status, result.error, result.message, result.errors)
  }
  ctx.stdout.write(`Created tour ${result.body.tour.id} (${result.body.tour.slug}).\n`)
  return 0
}

async function runTourUpdate(ctx: CommandContext): Promise<number> {
  const id = ctx.args.positional[0]
  const path = ctx.args.positional[1]
  if (!id || !path) {
    ctx.stderr.write('Usage: terraviz tour update <id> <metadata.json>\n')
    return 2
  }
  let body: Record<string, unknown>
  try {
    body = readBodyFile(ctx, path)
  } catch (e) {
    ctx.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    return 2
  }
  const result = await ctx.client.updateTour<TourEnvelope>(id, body)
  if (!result.ok) {
    return emitFailure(ctx, result.status, result.error, result.message, result.errors)
  }
  ctx.stdout.write(`Updated tour ${id}.\n`)
  return 0
}

async function runTourPreview(ctx: CommandContext): Promise<number> {
  const id = ctx.args.positional[0]
  if (!id) {
    ctx.stderr.write('Usage: terraviz tour preview <id>\n')
    return 2
  }
  const ttlSeconds = getNumber(ctx.args.options, 'ttl')
  const result = await ctx.client.previewTour<PreviewEnvelope>(id, { ttl_seconds: ttlSeconds })
  if (!result.ok) return emitFailure(ctx, result.status, result.error, result.message)
  ctx.stdout.write(`${ctx.client.serverUrl}${result.body.url}\n`)
  ctx.stdout.write(`(expires in ${result.body.expires_in}s)\n`)
  return 0
}

// --- help ---------------------------------------------------------

export const HELP_TEXT = `terraviz — Terraviz catalog publishing CLI

Usage:
  terraviz <command> [args] [flags]

Commands:
  me                                  Show your publisher profile
  list [--status=draft|published|retracted] [--limit=N] [--cursor=X]
                                      List your datasets
  get <id>                            Print a dataset as JSON
  publish <metadata.json> [--draft-only]
                                      Create a draft and (unless --draft-only)
                                      flip it to published
  update <id> <metadata.json>         Patch dataset metadata
  retract <id>                        Retract a dataset
  preview <id> [--ttl=<seconds>]      Mint a short-lived preview URL

  tour publish <metadata.json>        Create a tour (does not auto-publish)
  tour update <id> <metadata.json>    Patch tour metadata
  tour preview <id> [--ttl=<seconds>] Mint a short-lived preview URL

Global flags:
  --server <url>                      Server base URL (default https://terraviz.app)
  --insecure-local                    Skip Access auth (use for localhost dev)
  --client-id <id>                    Cloudflare Access service-token client id
  --client-secret <secret>            Cloudflare Access service-token client secret
  --json                              Print full JSON output for me / list / preview

Environment variables:
  TERRAVIZ_SERVER, TERRAVIZ_INSECURE_LOCAL,
  TERRAVIZ_ACCESS_CLIENT_ID, TERRAVIZ_ACCESS_CLIENT_SECRET
`

export function runHelp(ctx: CommandContext): number {
  ctx.stdout.write(HELP_TEXT)
  return 0
}
