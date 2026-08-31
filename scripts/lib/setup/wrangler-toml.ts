// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Repoint the fork-pinned resource IDs in `wrangler.toml`
 * (`SELF_HOSTING.md` Phase 3).
 *
 * The file ships with upstream's real IDs. Every `wrangler` command
 * an operator runs from their shell — `d1 migrations apply`,
 * `d1 execute` — resolves its target through this file, so leaving
 * them in place aims destructive commands at a database the operator
 * does not own. This is the single most consequential edit in the
 * whole install, and it was the one the old guide made impossible to
 * sequence correctly (it asked for the IDs before creating them).
 *
 * ## Why a block-scoped rewrite and not a string replace
 *
 * Both `[[d1_databases]]` blocks declare
 * `database_name = "sphere-feedback"` and differ only by `binding`
 * and `migrations_dir`. A naive replace of the upstream UUID happens
 * to work today (both blocks carry the same value, and both should
 * end up with the same new value) but silently does the wrong thing
 * the moment a fork splits them onto two physical databases. The KV
 * blocks are worse: they carry *different* IDs under the same
 * `[[kv_namespaces]]` header, so only a block-scoped edit can tell
 * them apart.
 *
 * So: parse into blocks, identify each by its `binding` key, and
 * rewrite the target field inside that block only.
 *
 * ## What is deliberately left alone
 *
 * Comment lines. `wrangler.toml` embeds example shell commands that
 * quote upstream's KV namespace ID (`wrangler kv key put … --
 * namespace-id=9c022b12…`). Rewriting text inside comments would be
 * surprising, and the guide now sources those values from the
 * operator's worksheet instead. Only real key/value assignments are
 * touched.
 */

export interface RepointTargets {
  /** D1 database ID for both FEEDBACK_DB and CATALOG_DB. */
  d1DatabaseId?: string
  /** KV namespace ID for TELEMETRY_KILL_SWITCH. */
  telemetryKvId?: string
  /** KV namespace ID for CATALOG_KV. */
  catalogKvId?: string
  /** Only when the fork renamed the bucket. */
  r2BucketName?: string
  /** Only when the fork renamed the index. */
  vectorizeIndexName?: string
  /** Only when the fork renamed the dataset. */
  analyticsDataset?: string
  /** Only when the fork renamed the database. */
  d1DatabaseName?: string
}

export interface RepointChange {
  /** TOML table header the change landed in, e.g. `d1_databases`. */
  section: string
  /** The block's `binding` value, e.g. `CATALOG_DB`. */
  binding: string
  /** Key rewritten, e.g. `database_id`. */
  key: string
  from: string
  to: string
  /** 1-indexed line number in the source. */
  line: number
}

export interface RepointResult {
  text: string
  changes: RepointChange[]
  /**
   * Bindings we were given a value for but could not find a block
   * for. Surfaced rather than swallowed: it means `wrangler.toml`
   * drifted from what this tool expects, and the operator needs to
   * know before they run a migration.
   */
  unmatched: string[]
}

/** One `[section]` / `[[section]]` block and its line range. */
interface Block {
  section: string
  /** Index of the header line. */
  start: number
  /** Index one past the last line of the block. */
  end: number
  binding?: string
}

const HEADER = /^\s*\[\[?([A-Za-z0-9_.-]+)\]?\]\s*$/
/** `key = "value"` with the value captured, ignoring comment lines. */
function assignment(key: string): RegExp {
  return new RegExp(`^(\\s*${key}\\s*=\\s*")([^"]*)("\\s*.*)$`)
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = HEADER.exec(lines[i])
    if (!m) continue
    if (blocks.length > 0) blocks[blocks.length - 1].end = i
    blocks.push({ section: m[1], start: i, end: lines.length })
  }
  for (const b of blocks) {
    for (let i = b.start + 1; i < b.end; i++) {
      const line = lines[i]
      if (/^\s*#/.test(line)) continue
      const m = assignment('binding').exec(line)
      if (m) {
        b.binding = m[2]
        break
      }
    }
  }
  return blocks
}

/**
 * Rewrite `key` inside `block` to `value`. Returns the change, or
 * null when the key is absent or already correct (idempotency: a
 * second run against an already-repointed file reports no changes).
 */
function rewrite(
  lines: string[],
  block: Block,
  key: string,
  value: string,
): RepointChange | null {
  const re = assignment(key)
  for (let i = block.start + 1; i < block.end; i++) {
    if (/^\s*#/.test(lines[i])) continue
    const m = re.exec(lines[i])
    if (!m) continue
    if (m[2] === value) return null
    lines[i] = `${m[1]}${value}${m[3]}`
    return {
      section: block.section,
      binding: block.binding ?? '(unnamed)',
      key,
      from: m[2],
      to: value,
      line: i + 1,
    }
  }
  return null
}

export function repointWranglerToml(
  source: string,
  targets: RepointTargets,
): RepointResult {
  const lines = source.split('\n')
  const blocks = parseBlocks(lines)
  const changes: RepointChange[] = []
  const unmatched: string[] = []

  const find = (section: string, binding: string): Block | undefined =>
    blocks.find(b => b.section === section && b.binding === binding)

  /** Apply one (section, binding, key) → value edit. */
  const set = (
    section: string,
    binding: string,
    key: string,
    value: string | undefined,
  ): void => {
    if (value === undefined) return
    const block = find(section, binding)
    if (!block) {
      unmatched.push(`${section}/${binding}`)
      return
    }
    const change = rewrite(lines, block, key, value)
    if (change) changes.push(change)
  }

  // Both D1 blocks point at the same physical database — one
  // instance, two migration directories (see wrangler.toml's own
  // comment and SELF_HOSTING.md Phase 4).
  set('d1_databases', 'FEEDBACK_DB', 'database_id', targets.d1DatabaseId)
  set('d1_databases', 'CATALOG_DB', 'database_id', targets.d1DatabaseId)
  set('d1_databases', 'FEEDBACK_DB', 'database_name', targets.d1DatabaseName)
  set('d1_databases', 'CATALOG_DB', 'database_name', targets.d1DatabaseName)

  set('kv_namespaces', 'TELEMETRY_KILL_SWITCH', 'id', targets.telemetryKvId)
  set('kv_namespaces', 'CATALOG_KV', 'id', targets.catalogKvId)

  set('r2_buckets', 'CATALOG_R2', 'bucket_name', targets.r2BucketName)
  set('vectorize', 'CATALOG_VECTORIZE', 'index_name', targets.vectorizeIndexName)
  set(
    'analytics_engine_datasets',
    'ANALYTICS',
    'dataset',
    targets.analyticsDataset,
  )

  return { text: lines.join('\n'), changes, unmatched }
}

/**
 * The upstream IDs as shipped. Used to warn an operator that a file
 * still aims at upstream — the failure this catches (running
 * `d1 migrations apply` against someone else's database) is bad
 * enough to be worth naming explicitly rather than inferring.
 */
export const UPSTREAM_PINNED_IDS: Record<string, string> = {
  d1: '78fbe5c3-8e40-4504-b183-155b0069222e',
  telemetryKv: '9c022b1295314939b76a28769fef6195',
  catalogKv: '00000000000000000000000000000000',
}

/** True when any block still carries an upstream-pinned ID. */
export function stillPinnedUpstream(source: string): string[] {
  const hits: string[] = []
  const lines = source.split('\n')
  const blocks = parseBlocks(lines)
  const check = (section: string, binding: string, key: string, pinned: string): void => {
    const block = blocks.find(b => b.section === section && b.binding === binding)
    if (!block) return
    const re = assignment(key)
    for (let i = block.start + 1; i < block.end; i++) {
      if (/^\s*#/.test(lines[i])) continue
      const m = re.exec(lines[i])
      if (m && m[2] === pinned) hits.push(binding)
    }
  }
  check('d1_databases', 'FEEDBACK_DB', 'database_id', UPSTREAM_PINNED_IDS.d1)
  check('d1_databases', 'CATALOG_DB', 'database_id', UPSTREAM_PINNED_IDS.d1)
  check('kv_namespaces', 'TELEMETRY_KILL_SWITCH', 'id', UPSTREAM_PINNED_IDS.telemetryKv)
  check('kv_namespaces', 'CATALOG_KV', 'id', UPSTREAM_PINNED_IDS.catalogKv)
  return hits
}
