// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The subscriber side of the federation feed (metadata Phase 5, step
 * 5): pull a peer's signed feed and mirror what it says into storage.
 *
 * Pure apart from what is injected — `fetch`, a clock, a run-id source
 * and a `FederationMirrorStore` — so every rule below is a unit test
 * and nothing here names D1 (federation-scoping.md §7 Directive 1). The
 * D1 store is `federation-mirror-d1.ts`.
 *
 * **Trust.** A page is used only if its `Terraviz-Signature` verifies
 * against the peer's **pinned** key, with the peer's `node_id` as the
 * key id and the exact path and query this pull asked for as the
 * target, so a page signed for another request, another node or a
 * different cursor is refused. The body is then checked field by
 * field: a page that verifies but says it is from a different node, or
 * carries a schema version this build does not know, is refused too.
 * Nothing is repaired; a refused page stops the pull, leaves the cursor
 * where the last good page put it, and is recorded as the peer's
 * `last_sync_error`.
 *
 * **What is mirrored.** Each dataset as the wire carried it, keyed by
 * `(peer, id)`, with `originNode` required to equal the pinned peer's
 * own id. Missing origins and claims about a third node are refused:
 * v1 has no relaying, and the only key this node holds is the peer's.
 *
 * **Full sync.** A pull with no stored cursor, or one asked for as
 * full, starts from the beginning of the feed and is authoritative
 * once its last page arrives. That is the only way a subscriber learns
 * of a hard delete or a row leaving `public` visibility, which the
 * feed cannot tombstone. A full sync larger than one pull's page cap
 * is carried across pulls under one run id (`full_sync_run`); a pull
 * that stops on a cap or an error never reconciles, since a partial
 * view would drop rows the peer still has.
 *
 * **The sweep is deferred.** The feed holds back rows changed in its
 * last `FEED_SETTLE_SECONDS`, so a row edited while the full sync ran
 * can be missing from it and still exist. Finishing a full sync
 * therefore only records the run (`sweep_run`) and a time
 * (`sweep_after`, the settle window plus clock skew later). The first
 * complete incremental pull that starts after that time covers the
 * window, stamps what it delivers with the same run, and then drops
 * the rest (`finishSweep`). A row changed again inside every settle
 * window is invisible to the feed altogether, and so can be dropped
 * and come back on its next quiet moment.
 *
 * **Held rows are kept.** A page lists in `held` the visible rows its
 * node could not serialize. Each is stamped with the run, as a
 * delivered row would be, but its stored copy is left as it was, so a
 * sweep keeps it. A held id this mirror has no copy of changes nothing.
 *
 * **A sweep that would empty the mirror is refused.** A peer that does
 * not send `held` skips any row it cannot serialize, so if its
 * serializer breaks it serves signed pages with nothing in them, and a
 * full sync over those pages completes having seen nothing. Swept as
 * usual, that deletes the whole mirror. So before deleting, the sweep
 * counts what it keeps and what it drops, and `sweepIsPlausible`
 * refuses one that keeps nothing, or drops more than half the mirror
 * and more than `SWEEP_GUARD_MIN_ROWS` rows.
 *
 * A refused sweep deletes nothing and stays pending: every complete
 * pull after it refuses it again, failing as `sweep-refused` with the
 * counts, so the refusal stays visible rather than being reported once.
 * A pull's pages are applied either way. It ends when a new full sync
 * replaces the pending sweep, or when an operator accepts it: a pull
 * given `acceptSweep` runs the sweep if the counts are exactly the ones
 * accepted. Exact, because the operator approved those counts and no
 * others; if a pull changed them, the operator is shown the new ones.
 *
 * **One pull per peer.** A pull takes the peer's lease before reading
 * its state and releases it when done; every write is conditional on
 * holding it, so two pulls cannot interleave their pages or move each
 * other's cursor. A pull that finds the lease held returns
 * `sync-in-progress` and records nothing.
 *
 * **Bounds.** Redirects are refused (the target is signed, and a
 * redirect is somewhere this node did not choose to ask), the body is
 * read with a byte cap before it is parsed, each row has its own cap,
 * a page with more entries than were asked for is refused, and a pull
 * stops after `maxPages` pages. A Pages Function has a CPU budget and
 * a D1 query budget per request (1000 on the paid plan; a page costs
 * one statement per entry plus one, so the defaults stay near 810),
 * so the default caps are small; on the Free plan's 50 queries the page limit has to come
 * down too. A pull that hits the cap reports `complete: false` and
 * the next pull continues from the saved cursor.
 */

import {
  SIGNATURE_HEADER,
  importNodePublicKey,
  verifyFederationBody,
  type SignatureFailure,
} from './federation-signature'
import { FEED_SCHEMA_VERSION, FEED_SETTLE_SECONDS } from './federation-feed'
import { isLoopbackHost } from './loopback'

export const FEED_PATH = '/api/v1/federation/feed'
/** Rows asked for per page. */
export const PULL_PAGE_LIMIT = 100
/** Pages one pull fetches before it stops and reports `complete: false`. */
export const PULL_MAX_PAGES = 8
/** How long a pull holds a peer's lease; longer than any pull runs. */
export const PULL_LEASE_MS = 5 * 60_000
/** Clock skew allowed between this node and a peer for the sweep. */
export const SWEEP_SKEW_MS = 60_000
/** A sweep may drop up to this many rows whatever share of the mirror
 *  they are, so a small peer's ordinary withdrawals are not refused. */
export const SWEEP_GUARD_MIN_ROWS = 5

/** What a pending sweep would keep (rows its run delivered) and drop. */
export interface SweepCounts {
  kept: number
  dropped: number
}

/**
 * Whether a sweep looks like a peer withdrawing rows rather than a peer
 * whose feed has stopped carrying them. A sweep that keeps nothing is
 * refused, since a full sync delivered no rows into a mirror that has
 * some. So is one that drops more than half the mirror and more than
 * `SWEEP_GUARD_MIN_ROWS` rows.
 */
export function sweepIsPlausible({ kept, dropped }: SweepCounts): boolean {
  if (dropped === 0) return true
  if (kept === 0) return false
  return dropped <= SWEEP_GUARD_MIN_ROWS || dropped * 2 <= kept + dropped
}

/** A peer's cursor is opaque here: anything URL-safe and bounded. */
const CURSOR_RE = /^[A-Za-z0-9._~-]{1,512}$/
/** Bytes read from one page before it is refused unparsed. */
export const PULL_MAX_BODY_BYTES = 4 * 1024 * 1024
/** Serialized size of one mirrored row; under D1's per-value limit. */
export const PULL_MAX_ROW_BYTES = 1024 * 1024
export const PULL_TIMEOUT_MS = 15_000

/** Dataset and node ids the mirror will key on: the alphabet node ids
 *  are signed with, which covers ULIDs and the legacy SOS ids. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** Whether `s` is shaped like a node or dataset id on the wire. */
export function isFederationId(s: string): boolean {
  return ID_RE.test(s)
}

export type PeerStatus = 'pending' | 'active' | 'paused' | 'blocked'

export interface FederationPeer {
  /** The peer's `node_id`. */
  id: string
  /** `https://host[:port]`, no path. */
  baseUrl: string
  displayName: string
  /** Pinned `ed25519:<base64>` key. */
  publicKey: string
  status: PeerStatus
  /** When the last pull was attempted, whatever its outcome. */
  lastSyncAt: string | null
  lastSyncCursor: string | null
  lastSyncError: string | null
  /** Non-null while a full sync is in progress across pulls. */
  fullSyncRun: string | null
  /** A finished full sync whose sweep is still to run. */
  sweepRun: string | null
  /** Epoch ms after which an incremental pull may run the sweep. */
  sweepAfterMs: number | null
  syncLeaseExpiresMs?: number | null
}

export interface MirroredDataset {
  remoteId: string
  originNode: string
  payloadJson: string
}

/** One verified page, applied as a unit. */
export interface MirrorPage {
  peerId: string
  /** The lease the write is conditional on. */
  leaseId: string
  /** Stamped on every row this page delivers. */
  runId: string
  /** The run id while a full sync is in progress, else `null`. */
  fullSyncRun: string | null
  /** The page's cursor, saved as the peer's resume point. */
  cursor: string
  datasets: MirroredDataset[]
  tombstones: string[]
  /** Rows the peer could not serve: stamped with `runId`, payload kept. */
  held: string[]
  /** The page's signature header, kept on each row it delivered. */
  signature: string
  fetchedAt: string
}

export interface FederationMirrorStore {
  /** Take the peer's lease if it is free or expired, returning the
   *  peer as it stands under the lease, else `null`. */
  acquireLease(
    peerId: string,
    leaseId: string,
    nowMs: number,
    untilMs: number,
  ): Promise<FederationPeer | null>
  releaseLease(peerId: string, leaseId: string): Promise<void>
  /** Upsert the datasets, delete the tombstones, stamp the held rows'
   *  `seen_run` without touching their payloads, and save the cursor
   *  and `full_sync_run` — all or nothing, and only under the lease.
   *  `false` when the lease was lost and nothing was written. */
  applyPage(page: MirrorPage): Promise<boolean>
  /** Clear `full_sync_run` and record the run as the pending sweep.
   *  `false` when the lease was lost. */
  finishFullSync(peerId: string, runId: string, leaseId: string, sweepAfterMs: number): Promise<boolean>
  /** How many of the peer's rows the sweep run delivered, and how many
   *  it did not and would drop. */
  countSweep(peerId: string, sweepRun: string): Promise<SweepCounts>
  /** Drop the peer's rows the sweep run did not deliver and clear the
   *  pending sweep, together. Returns how many rows went, or `null`
   *  when the lease was lost (or the sweep replaced) and nothing was. */
  finishSweep(peerId: string, sweepRun: string, leaseId: string): Promise<number | null>
  /** Stamp `last_sync_at` and set or clear `last_sync_error`. */
  recordSyncResult(
    peerId: string,
    leaseId: string,
    result: { at: string; error: string | null },
  ): Promise<void>
}

export type PullFailure =
  | 'peer-not-active'
  | 'sync-in-progress'
  | 'lease-lost'
  | 'bad-peer'
  | 'network'
  | 'timeout'
  | 'redirect'
  | 'http-status'
  | 'invalid-cursor'
  | 'too-large'
  | 'row-too-large'
  | 'invalid-body'
  | 'node-mismatch'
  | 'unsupported-version'
  | 'sweep-refused'
  | SignatureFailure

export interface PullResult {
  ok: boolean
  /** Why the pull stopped, when it did not finish cleanly. */
  error?: PullFailure
  /** HTTP status, for `http-status`. */
  status?: number
  /** Whether this pull was (or continued) a full sync. */
  full: boolean
  /** The feed said it had nothing more (`has_more: false`). */
  complete: boolean
  pages: number
  upserted: number
  tombstoned: number
  /** Ids the peer listed as held: rows it could not serve this time. */
  held: number
  /** Rows dropped by a sweep this pull ran. */
  reconciled: number
  /** A finished full sync is waiting for its sweep. */
  reconcilePending: boolean
  /** For `sweep-refused`: what the refused sweep would have kept and dropped. */
  sweepRefused?: SweepCounts
  /** The counts of a sweep the guard refused and the operator accepted,
   *  set only when this pull ran it. */
  sweepAccepted?: SweepCounts
}

export interface PullDeps {
  fetch: typeof fetch
  store: FederationMirrorStore
  /** Milliseconds since the epoch. */
  now: () => number
  newRunId: () => string
  /** Defaults to `crypto.randomUUID()`. */
  newLeaseId?: () => string
}

export interface PullOptions {
  /** Start a full sync even though a cursor is stored. */
  full?: boolean
  maxPages?: number
  pageLimit?: number
  maxBodyBytes?: number
  timeoutMs?: number
  /** Run a pending sweep the guard refuses, if its counts are exactly
   *  these: the ones a refusal reported, which the operator accepted. */
  acceptSweep?: SweepCounts
}

type ResolvedPullOptions = Required<Omit<PullOptions, 'acceptSweep'>> & { acceptSweep: SweepCounts | null }

/**
 * The origin of a peer base URL, or `null` for anything that is not a
 * plain `https://` origin on the default port with a public-looking
 * dotted host: no credentials, path, query or fragment, no IP literal,
 * no loopback name, no trailing dot, and none of the suffixes reserved
 * for private or test networks. Peers are public nodes, and a base URL
 * is the only thing an operator types that this node will fetch. A
 * name can still resolve to a private address; Workers' own egress
 * rules are what stop that, not this check.
 */
const PRIVATE_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa',
  '.lan',
  '.test',
  '.invalid',
  '.example',
]

export function parsePeerBaseUrl(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.port !== '') return null
  if (url.username || url.password || url.search || url.hash) return null
  if (url.pathname !== '/' && url.pathname !== '') return null
  if (/[?#]/.test(raw)) return null
  const host = url.hostname
  if (host.startsWith('[') || /^[0-9.]+$/.test(host)) return null
  if (!host.includes('.') || host.endsWith('.') || isLoopbackHost(host)) return null
  if (PRIVATE_SUFFIXES.some(s => host === s.slice(1) || host.endsWith(s))) return null
  return url.origin
}

/** The path and query a pull requests, which is also the signed target.
 *  Built here, once, so the URL fetched and the target verified cannot
 *  disagree. */
export function feedTarget(cursor: string | null, limit: number): string {
  const params: string[] = []
  if (cursor !== null) params.push(`since=${encodeURIComponent(cursor)}`)
  params.push(`limit=${limit}`)
  return `${FEED_PATH}?${params.join('&')}`
}

class PullError extends Error {
  constructor(
    readonly code: PullFailure,
    readonly status?: number,
  ) {
    super(code)
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = res.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await res.body?.cancel().catch(() => {})
    throw new PullError('too-large')
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new PullError('too-large')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new PullError('invalid-body')
  }
}

interface ValidPage {
  cursor: string
  hasMore: boolean
  datasets: MirroredDataset[]
  tombstones: string[]
  held: string[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Check a verified body against the feed schema, strictly. */
function validateFeedPage(body: unknown, peerId: string, pageLimit: number): ValidPage {
  if (!isPlainObject(body)) throw new PullError('invalid-body')
  if (body.schema_version !== FEED_SCHEMA_VERSION) {
    throw new PullError(
      typeof body.schema_version === 'number' ? 'unsupported-version' : 'invalid-body',
    )
  }
  if (body.node_id !== peerId) throw new PullError('node-mismatch')
  const { cursor, has_more: hasMore, datasets, tombstones } = body
  // The cursor is the peer's to format; it is only sent back.
  if (typeof cursor !== 'string' || !CURSOR_RE.test(cursor)) {
    throw new PullError('invalid-body')
  }
  // `held` is optional on the wire: absent means nothing was held.
  const held = body.held === undefined ? [] : body.held
  if (
    typeof hasMore !== 'boolean' ||
    !Array.isArray(datasets) ||
    !Array.isArray(tombstones) ||
    !Array.isArray(held)
  ) {
    throw new PullError('invalid-body')
  }
  // More entries than asked for would blow the statement budget. A held
  // row is one of the page's rows, so it counts against the limit too.
  if (datasets.length + tombstones.length + held.length > pageLimit) throw new PullError('invalid-body')

  const seen = new Set<string>()
  const rows: MirroredDataset[] = []
  for (const d of datasets) {
    if (!isPlainObject(d) || typeof d.id !== 'string' || !ID_RE.test(d.id)) {
      throw new PullError('invalid-body')
    }
    if (seen.has(d.id)) throw new PullError('invalid-body')
    seen.add(d.id)
    if (d.originNode !== peerId) throw new PullError('invalid-body')
    const originNode = peerId
    const payloadJson = JSON.stringify(d)
    if (new TextEncoder().encode(payloadJson).byteLength > PULL_MAX_ROW_BYTES) {
      throw new PullError('row-too-large')
    }
    rows.push({ remoteId: d.id, originNode, payloadJson })
  }
  const dropped: string[] = []
  for (const t of tombstones) {
    // An id both upserted and tombstoned in one page has no order to
    // settle it by.
    if (typeof t !== 'string' || !ID_RE.test(t) || seen.has(t)) throw new PullError('invalid-body')
    seen.add(t)
    dropped.push(t)
  }
  const kept: string[] = []
  for (const h of held) {
    // Held means not served this time, so an id the page also delivers
    // or retracts contradicts itself.
    if (typeof h !== 'string' || !ID_RE.test(h) || seen.has(h)) throw new PullError('invalid-body')
    seen.add(h)
    kept.push(h)
  }
  return { cursor, hasMore, datasets: rows, tombstones: dropped, held: kept }
}

async function fetchPage(
  fetchFn: typeof fetch,
  url: string,
  timeoutMs: number,
  maxBodyBytes: number,
): Promise<{ text: string; signature: string | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let res: Response
    try {
      res = await fetchFn(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
    } catch {
      throw new PullError(controller.signal.aborted ? 'timeout' : 'network')
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {})
      throw new PullError('redirect', res.status)
    }
    if (res.status !== 200) {
      if (res.status === 400 && new URL(url).pathname === FEED_PATH) {
        try {
          const errorBody: unknown = JSON.parse(await readCapped(res, 4096))
          if (isPlainObject(errorBody) && errorBody.error === 'invalid_cursor') throw new PullError('invalid-cursor', 400)
        } catch (error) {
          if (error instanceof PullError && error.code === 'invalid-cursor') throw error
        }
      }
      await res.body?.cancel().catch(() => {})
      throw new PullError('http-status', res.status)
    }
    if (res.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      await res.body?.cancel().catch(() => {})
      throw new PullError('invalid-body')
    }
    try {
      const text = await readCapped(res, maxBodyBytes)
      return { text, signature: res.headers.get(SIGNATURE_HEADER) }
    } catch (err) {
      if (err instanceof PullError) throw err
      throw new PullError(controller.signal.aborted ? 'timeout' : 'network')
    }
  } finally {
    clearTimeout(timer)
  }
}

export const DISCOVERY_PATH = '/.well-known/terraviz.json'
/** A discovery document is a few hundred bytes; this is generous. */
export const DISCOVERY_MAX_BYTES = 64 * 1024

/** What a peer's discovery document says about it, as checked here. */
export interface PeerDiscovery {
  nodeId: string
  displayName: string
  /** The document's `base_url`, normalized by `parsePeerBaseUrl`. */
  baseUrl: string
  publicKey: string
  /** `federation.feed`; `false` when the node predates the field. */
  feed: boolean
}

export type DiscoveryFailure =
  | 'network'
  | 'timeout'
  | 'redirect'
  | 'http-status'
  | 'too-large'
  | 'invalid-body'

/**
 * Fetch and check `<origin>/.well-known/terraviz.json`, the same way a
 * feed page is fetched: no redirects, a byte cap, a timeout. The
 * document is unsigned, so it is never trusted on its own: the caller
 * compares it with the node id and key the operator was given out of
 * band (adding a peer), and only the pinned key is used afterwards.
 */
export async function fetchPeerDiscovery(
  fetchFn: typeof fetch,
  origin: string,
  timeoutMs = PULL_TIMEOUT_MS,
): Promise<{ ok: true; doc: PeerDiscovery } | { ok: false; error: DiscoveryFailure; status?: number }> {
  let text: string
  try {
    ;({ text } = await fetchPage(fetchFn, origin + DISCOVERY_PATH, timeoutMs, DISCOVERY_MAX_BYTES))
  } catch (err) {
    if (!(err instanceof PullError)) throw err
    return { ok: false, error: err.code as DiscoveryFailure, ...(err.status !== undefined ? { status: err.status } : {}) }
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, error: 'invalid-body' }
  }
  if (!isPlainObject(body)) return { ok: false, error: 'invalid-body' }
  const { node_id: nodeId, display_name: displayName, base_url: rawBase, public_key: publicKey } = body
  if (typeof nodeId !== 'string' || !ID_RE.test(nodeId)) return { ok: false, error: 'invalid-body' }
  if (typeof displayName !== 'string' || displayName.length > 200 || /[\x00-\x1f\x7f<>]/.test(displayName)) return { ok: false, error: 'invalid-body' }
  if (typeof publicKey !== 'string' || publicKey.length > 200) return { ok: false, error: 'invalid-body' }
  const baseUrl = typeof rawBase === 'string' ? parsePeerBaseUrl(rawBase.replace(/\/$/, '')) : null
  if (baseUrl === null) return { ok: false, error: 'invalid-body' }
  const fed = body.federation
  const feed = isPlainObject(fed) && fed.feed === true
  return { ok: true, doc: { nodeId, displayName, baseUrl, publicKey, feed } }
}

/** The text recorded as `last_sync_error`: a code, never response text. */
export function describePullFailure(error: PullFailure, status?: number): string {
  return status === undefined ? error : `${error}:${status}`
}

/**
 * Pull one peer's feed, applying each verified page as it arrives.
 * Never throws for anything the peer sends; a store failure does
 * throw, after an attempt to record it, since the mirror's state is
 * then unknown. `peer` names the peer; its state is re-read under the
 * lease, so a caller's stale copy cannot move the cursor back.
 */
export async function pullPeer(
  peer: FederationPeer,
  deps: PullDeps,
  opts: PullOptions = {},
): Promise<PullResult> {
  const maxPages = opts.maxPages ?? PULL_MAX_PAGES
  const pageLimit = opts.pageLimit ?? PULL_PAGE_LIMIT
  const maxBodyBytes = opts.maxBodyBytes ?? PULL_MAX_BODY_BYTES
  const timeoutMs = opts.timeoutMs ?? PULL_TIMEOUT_MS
  const empty: PullResult = {
    ok: false,
    full: false,
    complete: false,
    pages: 0,
    upserted: 0,
    tombstoned: 0,
    held: 0,
    reconciled: 0,
    reconcilePending: false,
  }
  if (peer.status !== 'active') return { ...empty, error: 'peer-not-active' }

  const startMs = deps.now()
  const leaseId = (deps.newLeaseId ?? (() => crypto.randomUUID()))()
  const fresh = await deps.store.acquireLease(peer.id, leaseId, startMs, startMs + PULL_LEASE_MS)
  if (fresh === null) return { ...empty, error: 'sync-in-progress' }

  try {
    return await pullUnderLease(fresh, leaseId, startMs, deps, {
      maxPages,
      pageLimit,
      maxBodyBytes,
      timeoutMs,
      full: opts.full === true,
      acceptSweep: opts.acceptSweep ?? null,
    })
  } finally {
    await deps.store.releaseLease(peer.id, leaseId).catch(() => {})
  }
}

async function pullUnderLease(
  peer: FederationPeer,
  leaseId: string,
  startMs: number,
  deps: PullDeps,
  opts: ResolvedPullOptions,
): Promise<PullResult> {
  let runId: string
  let cursor: string | null
  let full: boolean
  if (opts.full) {
    runId = deps.newRunId()
    cursor = null
    full = true
  } else if (peer.fullSyncRun !== null) {
    runId = peer.fullSyncRun
    cursor = peer.lastSyncCursor
    full = true
  } else if (peer.lastSyncCursor === null) {
    runId = deps.newRunId()
    cursor = null
    full = true
  } else {
    // While a sweep is pending, an incremental pull stamps its rows
    // with the sweep's run, so the sweep keeps what it delivers.
    runId = peer.sweepRun ?? deps.newRunId()
    cursor = peer.lastSyncCursor
    full = false
  }

  const result: PullResult = {
    ok: false,
    full,
    complete: false,
    pages: 0,
    upserted: 0,
    tombstoned: 0,
    held: 0,
    reconciled: 0,
    reconcilePending: !full && peer.sweepRun !== null,
  }
  if (peer.status !== 'active') return { ...result, error: 'peer-not-active' }

  const record = (error: string | null) =>
    deps.store.recordSyncResult(peer.id, leaseId, { at: new Date(deps.now()).toISOString(), error })

  const origin = parsePeerBaseUrl(peer.baseUrl)
  let publicKey: CryptoKey | null = null
  if (origin !== null && ID_RE.test(peer.id)) {
    try {
      publicKey = await importNodePublicKey(peer.publicKey)
    } catch {
      publicKey = null
    }
  }

  try {
    if (origin === null || publicKey === null) throw new PullError('bad-peer')
    while (result.pages < opts.maxPages) {
      const target = feedTarget(cursor, opts.pageLimit)
      const { text, signature } = await fetchPage(
        deps.fetch,
        origin + target,
        opts.timeoutMs,
        opts.maxBodyBytes,
      )
      const verified = await verifyFederationBody(text, signature, {
        publicKey,
        expectedKeyId: peer.id,
        expectedTarget: target,
        now: Math.floor(deps.now() / 1000),
      })
      if (!verified.ok) throw new PullError(verified.reason)
      const page = validateFeedPage(verified.body, peer.id, opts.pageLimit)

      const applied = await deps.store.applyPage({
        peerId: peer.id,
        leaseId,
        runId,
        fullSyncRun: full ? runId : null,
        cursor: page.cursor,
        datasets: page.datasets,
        tombstones: page.tombstones,
        held: page.held,
        signature: signature!,
        fetchedAt: new Date(deps.now()).toISOString(),
      })
      if (!applied) throw new PullError('lease-lost')
      result.pages++
      result.upserted += page.datasets.length
      result.tombstoned += page.tombstones.length
      result.held += page.held.length
      cursor = page.cursor
      if (!page.hasMore) {
        result.complete = true
        break
      }
    }
    if (result.complete && full) {
      const sweepAfterMs = deps.now() + FEED_SETTLE_SECONDS * 1000 + SWEEP_SKEW_MS
      if (!(await deps.store.finishFullSync(peer.id, runId, leaseId, sweepAfterMs))) {
        throw new PullError('lease-lost')
      }
      result.reconcilePending = true
    } else if (
      result.complete &&
      peer.sweepRun !== null &&
      peer.sweepAfterMs !== null &&
      startMs >= peer.sweepAfterMs
    ) {
      // This pull began after the settle window closed, so it saw
      // every row the full sync's last page held back.
      const counts = await deps.store.countSweep(peer.id, peer.sweepRun)
      const refused = !sweepIsPlausible(counts)
      if (refused) {
        // Counts identify the rows. While a sweep is pending, every row
        // a pull delivers or holds, and every new row, is stamped with
        // its run, and a retraction only removes rows; only a full sync
        // stamps another run, and it replaces this sweep when it ends.
        // So the rows it would drop only ever shrink, and the same count
        // dropped is the same rows the operator was shown.
        const accept = opts.acceptSweep
        if (accept === null || accept.kept !== counts.kept || accept.dropped !== counts.dropped) {
          // Left pending, so the next complete pull refuses it again.
          result.sweepRefused = counts
          throw new PullError('sweep-refused')
        }
      }
      const removed = await deps.store.finishSweep(peer.id, peer.sweepRun, leaseId)
      if (removed === null) throw new PullError('lease-lost')
      result.reconciled = removed
      result.reconcilePending = false
      if (refused) result.sweepAccepted = counts
    }
    result.ok = true
    await record(null)
    return result
  } catch (err) {
    if (!(err instanceof PullError)) {
      await record('store-error').catch(() => {})
      throw err
    }
    result.error = err.code
    if (err.status !== undefined) result.status = err.status
    await record(describePullFailure(err.code, err.status))
    return result
  }
}
