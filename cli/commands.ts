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

import { createReadStream, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, extname } from 'node:path'
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

// --- upload (Phase 1b) --------------------------------------------

const UPLOAD_KINDS = new Set([
  'data',
  'thumbnail',
  'legend',
  'caption',
  'sphere_thumbnail',
])

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.vtt': 'text/vtt',
  '.json': 'application/json',
}

function detectMime(path: string, override: string | undefined): string | null {
  if (override) return override
  const ext = extname(path).toLowerCase()
  return MIME_BY_EXT[ext] ?? null
}

interface InitAssetEnvelope {
  upload_id: string
  kind: string
  target: 'r2' | 'stream'
  stream?: { upload_url: string; stream_uid: string }
  r2?: {
    method: 'PUT'
    url: string
    headers: Record<string, string>
    key: string
  }
  expires_at: string
  /**
   * `true` when the server is running with `MOCK_R2=true` /
   * `MOCK_STREAM=true` for this target — no real bytes need to
   * be transferred (the mint URL is unreachable). The CLI honors
   * this flag by skipping the byte upload entirely; `/complete`
   * trusts the publisher's claimed digest as ground truth on the
   * server side. Optional for backwards compatibility with
   * pre-1b/I servers.
   */
  mock?: boolean
}

interface CompleteEnvelope {
  dataset?: { id: string }
  upload?: { id: string; status: string }
  verified_digest?: string
  idempotent?: boolean
}

const TRANSCODE_RETRY_MAX = 30 // ~ 5 minutes total at 10 s spacing
const TRANSCODE_RETRY_DELAY_MS = 10_000

/**
 * Hard cap on what the CLI will read into memory for the upload
 * body. Server-side validation allows up to 10 GB for `data`
 * videos; pulling 10 GB into memory in a Node process is asking
 * for OOMs and unbounded latency. The first cut of the CLI
 * (Phase 1b) buffers; streaming / TUS-resumable uploads are a
 * Phase 3 / Phase 4 follow-on. Until that ships we fail fast at a
 * size where a bog-standard host has comfortable headroom.
 */
const CLI_INMEMORY_UPLOAD_LIMIT = 256 * 1024 * 1024 // 256 MB

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

/**
 * Stream-hash a file via `fs.createReadStream` + `crypto.createHash`.
 * Memory footprint is one chunk (~64 KB) regardless of file size, so
 * it's safe even for the multi-GB video assets we cap above.
 */
function streamingHash(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk as Buffer))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export async function runUpload(ctx: CommandContext): Promise<number> {
  const datasetId = ctx.args.positional[0]
  const kind = ctx.args.positional[1]
  const path = ctx.args.positional[2]
  if (!datasetId || !kind || !path) {
    ctx.stderr.write(
      'Usage: terraviz upload <dataset_id> <kind> <path> [--mime=<type>]\n' +
        '  kind ∈ data | thumbnail | legend | caption | sphere_thumbnail\n',
    )
    return 2
  }
  if (!UPLOAD_KINDS.has(kind)) {
    ctx.stderr.write(
      `Unknown kind "${kind}". Allowed: data | thumbnail | legend | caption | sphere_thumbnail\n`,
    )
    return 2
  }

  const mimeOverride = getString(ctx.args.options, 'mime')
  const mime = detectMime(path, mimeOverride)
  if (!mime) {
    ctx.stderr.write(
      `Could not infer mime from extension "${extname(path)}". Pass --mime=<type> explicitly.\n`,
    )
    return 2
  }

  // Hash via streaming SHA-256 so a multi-GB video doesn't load into
  // memory just to be hashed. The upload body still buffers (see
  // CLI_INMEMORY_UPLOAD_LIMIT below) — TUS-resumable streaming
  // uploads are a Phase 3 publisher-portal / Phase 4 federation
  // concern. Until then, fail fast with a clear message before
  // OOM-ing the host.
  let bytes: Uint8Array
  let size: number
  let digest: string
  if (ctx.readFile) {
    // Test mode — readFile returns a string. Hash the materialised
    // bytes the same way to keep the test surface small.
    bytes = new TextEncoder().encode(ctx.readFile(path))
    size = bytes.byteLength
    digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex')
  } else {
    let stat
    try {
      stat = statSync(path)
    } catch (e) {
      ctx.stderr.write(`Could not stat ${path}: ${e instanceof Error ? e.message : e}\n`)
      return 2
    }
    if (stat.size > CLI_INMEMORY_UPLOAD_LIMIT) {
      ctx.stderr.write(
        `${path} is ${formatBytes(stat.size)}; the CLI currently uploads via an in-memory ` +
          `buffer capped at ${formatBytes(CLI_INMEMORY_UPLOAD_LIMIT)}. ` +
          `Streaming / TUS-resumable uploads are a future-phase follow-on; until then, please ` +
          `upload large assets via the publisher portal (Phase 3) or split the asset.\n`,
      )
      return 5
    }
    // Stream-hash first so we never need to hold the whole file
    // twice (once as Buffer, once as the hash input). Then read
    // into memory for the upload body — within the cap above.
    try {
      digest = 'sha256:' + (await streamingHash(path))
    } catch (e) {
      ctx.stderr.write(`Could not hash ${path}: ${e instanceof Error ? e.message : e}\n`)
      return 2
    }
    try {
      bytes = readFileSync(path) as unknown as Uint8Array
    } catch (e) {
      ctx.stderr.write(`Could not read ${path}: ${e instanceof Error ? e.message : e}\n`)
      return 2
    }
    size = bytes.byteLength
  }

  ctx.stdout.write(
    `Uploading ${path} (${size} bytes) → ${datasetId} as ${kind}.\n` +
      `  digest: ${digest}\n`,
  )

  // `kind` was validated against `UPLOAD_KINDS` above, so it's
  // safe to widen the string into the AssetKind union the client
  // method expects.
  const init = await ctx.client.initAssetUpload<InitAssetEnvelope>(datasetId, {
    kind: kind as 'data' | 'thumbnail' | 'legend' | 'caption' | 'sphere_thumbnail',
    mime,
    size,
    content_digest: digest,
  })
  if (!init.ok) return emitFailure(ctx, init.status, init.error, init.message, init.errors)

  const env = init.body
  ctx.stdout.write(`  upload_id: ${env.upload_id} (target: ${env.target})\n`)

  const target = env.target
  let url: string
  let headers: Record<string, string> = {}
  if (target === 'stream' && env.stream) {
    url = env.stream.upload_url
  } else if (target === 'r2' && env.r2) {
    url = env.r2.url
    headers = env.r2.headers
  } else {
    ctx.stderr.write(`Server returned an unrecognised init envelope shape.\n`)
    return 1
  }

  if (env.mock) {
    // Server is in MOCK_R2 / MOCK_STREAM mode — the mint URL is a
    // stub (mock-r2.localhost / mock-stream.localhost) that doesn't
    // accept real bytes. Skip the PUT/POST entirely; `/complete`
    // will trust our claimed digest as ground truth.
    ctx.stdout.write(`  mock mode — skipping byte upload.\n`)
  } else {
    const upload = await ctx.client.uploadBytes(target, url, headers, bytes, mime, basename(path))
    if (!upload.ok) {
      ctx.stderr.write(
        `Upload failed (${upload.status})${upload.message ? `: ${upload.message}` : ''}\n`,
      )
      return 1
    }
    ctx.stdout.write(`  bytes uploaded.\n`)
  }

  // Poll /complete. Stream returns 202 transcode_in_progress while
  // the asset is transcoding; everything else is a one-shot.
  const maxAttempts = target === 'stream' ? TRANSCODE_RETRY_MAX : 1
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const completed = await ctx.client.completeAssetUpload<CompleteEnvelope>(datasetId, env.upload_id)
    if (completed.ok) {
      ctx.stdout.write(
        `  completed${completed.body.idempotent ? ' (idempotent retry)' : ''}.\n` +
          (completed.body.verified_digest
            ? `  verified_digest: ${completed.body.verified_digest}\n`
            : ''),
      )
      return 0
    }
    if (completed.status === 202) {
      // Transcode still running — wait + retry.
      ctx.stdout.write(`  transcode in progress, retrying in ${TRANSCODE_RETRY_DELAY_MS / 1000}s…\n`)
      await sleep(TRANSCODE_RETRY_DELAY_MS)
      continue
    }
    return emitFailure(ctx, completed.status, completed.error, completed.message, completed.errors)
  }
  ctx.stderr.write(
    `Stream transcode did not finish within ${(maxAttempts * TRANSCODE_RETRY_DELAY_MS) / 1000}s. ` +
      `Re-run \`terraviz upload\` later — the same upload_id remains valid until /complete succeeds.\n`,
  )
  return 1
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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

  upload <id> <kind> <path> [--mime=<type>]
                                      Upload an asset and finalise it.
                                      kind ∈ data | thumbnail | legend |
                                              caption | sphere_thumbnail.
                                      Mime sniffed from extension; --mime
                                      overrides. Polls Stream transcode for
                                      "data" kind videos before completing.

  tour publish <metadata.json>        Create a tour (does not auto-publish)
  tour update <id> <metadata.json>    Patch tour metadata
  tour preview <id> [--ttl=<seconds>] Mint a short-lived preview URL

  import-snapshot [--list=<path>] [--enriched=<path>] [--dry-run]
                                      One-shot bulk import of the legacy SOS
                                      catalog snapshot. Idempotent — re-running
                                      skips rows whose legacy_id is already
                                      published. Always run with --dry-run
                                      first to see the plan.
  import-snapshot --reindex [--dry-run]
                                      Walk every published dataset and re-enqueue
                                      its embed job. Use after wiring up
                                      Vectorize on a catalog that was already
                                      populated, or for a model-version bump.

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
