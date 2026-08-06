/**
 * Idempotent resource provisioning for `npm run setup`
 * (`SELF_HOSTING.md` Phase 2).
 *
 * ## Why this shells out to wrangler instead of calling the REST API
 *
 * Cloudflare has a REST endpoint for every resource here, and calling
 * them directly would avoid a subprocess. It would also mean this
 * file owns the URL shape, the request body, and the pagination of
 * five separate product APIs — and silently rots the day any of them
 * moves. `wrangler` is already a documented prerequisite, is
 * version-pinned in `package.json`, and is the surface Cloudflare
 * actually maintains for these operations.
 *
 * The one thing wrangler cannot do is set Pages bindings; that is
 * precisely why `scripts/lib/cf-pages-api.ts` exists and says so in
 * its header. So the split is: wrangler for resources, REST for
 * bindings. Nothing here duplicates something wrangler already does
 * well.
 *
 * ## Adopt-or-create, never create-blindly
 *
 * Every `ensure*` lists first and only creates what is genuinely
 * absent. A half-finished install re-run must converge, not
 * accumulate a second `sphere-feedback-2`. Where a list format is not
 * dependable enough to branch on (R2), the fallback is
 * create-and-tolerate-already-exists, which reaches the same end
 * state.
 */

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

/** Injectable command execution — the seam every test drives. */
export type CommandRunner = (argv: string[]) => Promise<CommandResult>

export interface EnsureResult {
  /** Cloudflare-assigned ID, when the resource type has one. */
  id?: string
  /** True when this run created it; false when it already existed. */
  created: boolean
}

/**
 * Pull the first JSON value out of command output.
 *
 * Wrangler interleaves banners, proxy warnings and update notices
 * with its payload, and only some subcommands take `--json`. Rather
 * than pin to one version's exact stdout, find the first `[` or `{`
 * and parse from there, trimming trailing noise back to the last
 * closing bracket if the first attempt fails.
 */
export function extractJson<T>(text: string): T | null {
  const start = text.search(/[[{]/)
  if (start < 0) return null
  const tail = text.slice(start)
  try {
    return JSON.parse(tail) as T
  } catch {
    // Trailing banner after the payload — walk back to the last
    // plausible terminator and retry.
    const lastArray = tail.lastIndexOf(']')
    const lastObject = tail.lastIndexOf('}')
    const end = Math.max(lastArray, lastObject)
    if (end <= 0) return null
    try {
      return JSON.parse(tail.slice(0, end + 1)) as T
    } catch {
      return null
    }
  }
}

/** Cloudflare and wrangler both phrase this differently per product. */
export function isAlreadyExists(result: CommandResult): boolean {
  const blob = `${result.stdout}\n${result.stderr}`
  return /already exists|10053|duplicate/i.test(blob)
}

function fail(op: string, result: CommandResult): never {
  const detail = (result.stderr || result.stdout || '').trim().slice(0, 400)
  throw new Error(`${op} failed (exit ${result.code}): ${detail}`)
}

// ── D1 ────────────────────────────────────────────────────────────

interface D1ListEntry {
  uuid?: string
  name?: string
}

export async function listD1(run: CommandRunner): Promise<D1ListEntry[]> {
  const res = await run(['d1', 'list', '--json'])
  if (res.code !== 0) fail('wrangler d1 list', res)
  return extractJson<D1ListEntry[]>(res.stdout) ?? []
}

export async function ensureD1(run: CommandRunner, name: string): Promise<EnsureResult> {
  const existing = (await listD1(run)).find(d => d.name === name)
  if (existing?.uuid) return { id: existing.uuid, created: false }

  const res = await run(['d1', 'create', name])
  // An already-exists error means something else won the race (or the
  // list above could not see it). We converge on the same end state
  // either way, but we did not create it — and `created` drives the
  // "created"/"adopted" wording the operator reads.
  const created = res.code === 0
  if (!created && !isAlreadyExists(res)) fail(`wrangler d1 create ${name}`, res)

  // Re-list rather than parse the create output: the create banner's
  // shape has changed across wrangler majors, the list JSON has not.
  const after = (await listD1(run)).find(d => d.name === name)
  if (!after?.uuid) {
    throw new Error(
      `D1 database "${name}" exists but its ID could not be resolved from ` +
        '`wrangler d1 list --json`. Set it by hand in .terraviz-setup.json.',
    )
  }
  return { id: after.uuid, created }
}

// ── KV ────────────────────────────────────────────────────────────

interface KvListEntry {
  id?: string
  title?: string
}

export async function listKv(run: CommandRunner): Promise<KvListEntry[]> {
  const res = await run(['kv', 'namespace', 'list'])
  if (res.code !== 0) fail('wrangler kv namespace list', res)
  return extractJson<KvListEntry[]>(res.stdout) ?? []
}

/**
 * Match a namespace title against the binding name we asked for.
 *
 * `wrangler kv namespace create CATALOG_KV` does not necessarily
 * title the namespace `CATALOG_KV` — when a config file supplies a
 * worker name it prefixes it (`terraviz-CATALOG_KV`), and that
 * convention has shifted between wrangler versions. Accept the exact
 * title or any `<prefix>-<name>` form so adoption works either way,
 * while still refusing an unrelated namespace that merely contains
 * the substring.
 */
export function kvTitleMatches(title: string | undefined, name: string): boolean {
  if (!title) return false
  return title === name || title.endsWith(`-${name}`)
}

export async function ensureKv(run: CommandRunner, name: string): Promise<EnsureResult> {
  const existing = (await listKv(run)).find(n => kvTitleMatches(n.title, name))
  if (existing?.id) return { id: existing.id, created: false }

  const res = await run(['kv', 'namespace', 'create', name])
  const created = res.code === 0
  if (!created && !isAlreadyExists(res)) {
    fail(`wrangler kv namespace create ${name}`, res)
  }

  const after = (await listKv(run)).find(n => kvTitleMatches(n.title, name))
  if (!after?.id) {
    throw new Error(
      `KV namespace "${name}" exists but its ID could not be resolved from ` +
        '`wrangler kv namespace list`. Set it by hand in .terraviz-setup.json.',
    )
  }
  return { id: after.id, created }
}

// ── R2 ────────────────────────────────────────────────────────────

/**
 * R2 bindings address the bucket by name, so no ID lookup is needed —
 * only "does it exist". `r2 bucket list` has no `--json` flag and its
 * table format is not worth branching on, so this creates and
 * tolerates an already-exists error, which converges on the same
 * state either way.
 */
export async function ensureR2Bucket(
  run: CommandRunner,
  name: string,
): Promise<EnsureResult> {
  const res = await run(['r2', 'bucket', 'create', name])
  if (res.code === 0) return { created: true }
  if (isAlreadyExists(res)) return { created: false }
  fail(`wrangler r2 bucket create ${name}`, res)
}

// ── Vectorize ─────────────────────────────────────────────────────

interface VectorizeListEntry {
  name?: string
}

export async function listVectorize(run: CommandRunner): Promise<VectorizeListEntry[]> {
  const res = await run(['vectorize', 'list', '--json'])
  if (res.code !== 0) fail('wrangler vectorize list', res)
  return extractJson<VectorizeListEntry[]>(res.stdout) ?? []
}

export async function ensureVectorizeIndex(
  run: CommandRunner,
  name: string,
  dimensions = 768,
  metric = 'cosine',
): Promise<EnsureResult> {
  const existing = (await listVectorize(run)).find(i => i.name === name)
  if (existing) return { created: false }

  const res = await run([
    'vectorize',
    'create',
    name,
    `--dimensions=${dimensions}`,
    `--metric=${metric}`,
  ])
  const created = res.code === 0
  if (!created && !isAlreadyExists(res)) fail(`wrangler vectorize create ${name}`, res)
  return { created }
}

interface MetadataIndexList {
  metadataIndexes?: Array<{ propertyName?: string }>
}

export async function listVectorizeMetadata(
  run: CommandRunner,
  index: string,
): Promise<string[]> {
  const res = await run(['vectorize', 'list-metadata-index', index])
  // A brand-new index legitimately has none, and some wrangler
  // versions exit non-zero rather than printing an empty list. Treat
  // an unreadable answer as "none known" — the create below is
  // already tolerant of duplicates, so the worst case is a redundant
  // create that reports "already exists".
  if (res.code !== 0) return []
  const parsed = extractJson<MetadataIndexList | Array<{ propertyName?: string }>>(res.stdout)
  if (!parsed) return []
  const entries = Array.isArray(parsed) ? parsed : (parsed.metadataIndexes ?? [])
  return entries.map(e => e.propertyName).filter((p): p is string => Boolean(p))
}

/**
 * Ensure every required metadata index exists. Without these the
 * Vectorize query filters (`peer_id` / `category` / `visibility`)
 * silently match nothing, which surfaces much later as "semantic
 * search returns no results" — a failure with no obvious link back to
 * a missing provisioning step.
 */
export async function ensureVectorizeMetadata(
  run: CommandRunner,
  index: string,
  properties: readonly string[],
): Promise<{ created: string[]; existing: string[] }> {
  const present = new Set(await listVectorizeMetadata(run, index))
  const created: string[] = []
  const existing: string[] = []

  for (const property of properties) {
    if (present.has(property)) {
      existing.push(property)
      continue
    }
    const res = await run([
      'vectorize',
      'create-metadata-index',
      index,
      `--property-name=${property}`,
      '--type=string',
    ])
    if (res.code !== 0 && !isAlreadyExists(res)) {
      fail(`wrangler vectorize create-metadata-index ${index} ${property}`, res)
    }
    if (res.code === 0) created.push(property)
    else existing.push(property)
  }
  return { created, existing }
}

// ── Migrations ────────────────────────────────────────────────────

/**
 * Apply a migration set by **binding name**. Never by database name:
 * both `[[d1_databases]]` blocks share `database_name`, so the bare
 * name is ambiguous and wrangler resolves it to the first match —
 * applying the feedback migrations and leaving the catalog tables
 * uncreated (`SELF_HOSTING.md` Phase 4).
 */
export async function applyMigrations(
  run: CommandRunner,
  binding: 'FEEDBACK_DB' | 'CATALOG_DB',
  remote = true,
): Promise<CommandResult> {
  const argv = ['d1', 'migrations', 'apply', binding, '--config', 'wrangler.toml']
  argv.push(remote ? '--remote' : '--local')
  return run(argv)
}

