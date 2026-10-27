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
 * `(peer, id)`, with the `originNode` the peer claims for it (the
 * peer's own id when it claims none). That claim is the peer's
 * statement and is stored as one, not checked against a third node:
 * the only key this node holds is the peer's.
 *
 * **Full sync.** A pull with no stored cursor, or one asked for as
 * full, starts from the beginning of the feed and is authoritative
 * when its last page arrives: rows from this peer that the run did not
 * deliver are dropped (`finishFullSync`). That is the only way a
 * subscriber learns of a hard delete or a row leaving `public`
 * visibility, which the feed cannot tombstone. A full sync larger than
 * one pull's page cap is carried across pulls under one run id
 * (`full_sync_run`), so it still reconciles when it finishes; a pull
 * that stops on a cap or an error never reconciles, since a partial
 * view would drop rows the peer still has.
 *
 * **Bounds.** Redirects are refused (the target is signed, and a
 * redirect is somewhere this node did not choose to ask), the body is
 * read with a byte cap before it is parsed, each row has its own cap,
 * and a pull stops after `maxPages` pages. A Pages Function has a CPU
 * budget per request, so the default cap is small; a pull that hits it
 * reports `complete: false` and the next pull continues from the
 * saved cursor.
 */

import {
  SIGNATURE_HEADER,
  importNodePublicKey,
  verifyFederationBody,
  type SignatureFailure,
} from './federation-signature'
import { FEED_SCHEMA_VERSION, decodeFeedCursor } from './federation-feed'

export const FEED_PATH = '/api/v1/federation/feed'
/** Rows asked for per page. */
export const PULL_PAGE_LIMIT = 100
/** Pages one pull fetches before it stops and reports `complete: false`. */
export const PULL_MAX_PAGES = 10
/** Bytes read from one page before it is refused unparsed. */
export const PULL_MAX_BODY_BYTES = 4 * 1024 * 1024
/** Serialized size of one mirrored row; under D1's per-value limit. */
export const PULL_MAX_ROW_BYTES = 1024 * 1024
export const PULL_TIMEOUT_MS = 15_000

/** Dataset and node ids the mirror will key on: the alphabet node ids
 *  are signed with, which covers ULIDs and the legacy SOS ids. */
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

export type PeerStatus = 'active' | 'paused' | 'blocked'

export interface FederationPeer {
  /** The peer's `node_id`. */
  id: string
  /** `https://host[:port]`, no path. */
  baseUrl: string
  displayName: string
  /** Pinned `ed25519:<base64>` key. */
  publicKey: string
  status: PeerStatus
  syncIntervalMinutes: number
  lastSyncAt: string | null
  lastSyncCursor: string | null
  lastSyncError: string | null
  /** Non-null while a full sync is in progress across pulls. */
  fullSyncRun: string | null
}

export interface MirroredDataset {
  remoteId: string
  originNode: string
  payloadJson: string
}

/** One verified page, applied as a unit. */
export interface MirrorPage {
  peerId: string
  /** Stamped on every row this page delivers. */
  runId: string
  /** The run id while a full sync is in progress, else `null`. */
  fullSyncRun: string | null
  /** The page's cursor, saved as the peer's resume point. */
  cursor: string
  datasets: MirroredDataset[]
  tombstones: string[]
  /** The page's signature header, kept on each row it delivered. */
  signature: string
  fetchedAt: string
}

export interface FederationMirrorStore {
  /** Upsert the datasets, delete the tombstones, and save the cursor
   *  and `full_sync_run` — all or nothing. */
  applyPage(page: MirrorPage): Promise<void>
  /** Drop the peer's rows the run did not deliver and clear
   *  `full_sync_run`, together. Returns how many rows went. */
  finishFullSync(peerId: string, runId: string): Promise<number>
  /** Stamp `last_sync_at` and set or clear `last_sync_error`. */
  recordSyncResult(peerId: string, result: { at: string; error: string | null }): Promise<void>
}

export type PullFailure =
  | 'peer-not-active'
  | 'bad-peer'
  | 'network'
  | 'timeout'
  | 'redirect'
  | 'http-status'
  | 'too-large'
  | 'row-too-large'
  | 'invalid-body'
  | 'node-mismatch'
  | 'unsupported-version'
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
  /** Rows dropped when a full sync finished. */
  reconciled: number
}

export interface PullDeps {
  fetch: typeof fetch
  store: FederationMirrorStore
  /** Milliseconds since the epoch. */
  now: () => number
  newRunId: () => string
}

export interface PullOptions {
  /** Start a full sync even though a cursor is stored. */
  full?: boolean
  maxPages?: number
  pageLimit?: number
  maxBodyBytes?: number
  timeoutMs?: number
}

/**
 * The origin of a peer base URL, or `null` for anything that is not a
 * plain `https://` origin with a dotted host: no credentials, path,
 * query or fragment, no IP literal and no `localhost`. Peers are
 * public nodes, and a base URL is the only thing an operator types
 * that this node will fetch.
 */
export function parsePeerBaseUrl(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password || url.search || url.hash) return null
  if (url.pathname !== '/' && url.pathname !== '') return null
  if (/[?#]/.test(raw)) return null
  const host = url.hostname
  if (host.startsWith('[') || /^[0-9.]+$/.test(host)) return null
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost')) return null
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
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new PullError('invalid-body')
  }
}

interface ValidPage {
  cursor: string
  hasMore: boolean
  datasets: MirroredDataset[]
  tombstones: string[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Check a verified body against the feed schema, strictly. */
function validateFeedPage(body: unknown, peerId: string): ValidPage {
  if (!isPlainObject(body)) throw new PullError('invalid-body')
  if (body.schema_version !== FEED_SCHEMA_VERSION) {
    throw new PullError(
      typeof body.schema_version === 'number' ? 'unsupported-version' : 'invalid-body',
    )
  }
  if (body.node_id !== peerId) throw new PullError('node-mismatch')
  const { cursor, has_more: hasMore, datasets, tombstones } = body
  if (typeof cursor !== 'string' || decodeFeedCursor(cursor) === null) {
    throw new PullError('invalid-body')
  }
  if (typeof hasMore !== 'boolean' || !Array.isArray(datasets) || !Array.isArray(tombstones)) {
    throw new PullError('invalid-body')
  }

  const seen = new Set<string>()
  const rows: MirroredDataset[] = []
  for (const d of datasets) {
    if (!isPlainObject(d) || typeof d.id !== 'string' || !ID_RE.test(d.id)) {
      throw new PullError('invalid-body')
    }
    if (seen.has(d.id)) throw new PullError('invalid-body')
    seen.add(d.id)
    let originNode = peerId
    if (d.originNode !== undefined) {
      if (typeof d.originNode !== 'string' || !ID_RE.test(d.originNode)) {
        throw new PullError('invalid-body')
      }
      originNode = d.originNode
    }
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
  return { cursor, hasMore, datasets: rows, tombstones: dropped }
}

async function fetchPage(
  deps: PullDeps,
  url: string,
  timeoutMs: number,
  maxBodyBytes: number,
): Promise<{ text: string; signature: string | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let res: Response
    try {
      res = await deps.fetch(url, {
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
      await res.body?.cancel().catch(() => {})
      throw new PullError('http-status', res.status)
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

/** The text recorded as `last_sync_error`: a code, never response text. */
export function describePullFailure(error: PullFailure, status?: number): string {
  return status === undefined ? error : `${error}:${status}`
}

/**
 * Pull one peer's feed, applying each verified page as it arrives.
 * Never throws for anything the peer sends; a store failure does
 * throw, since the mirror's state is then unknown.
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

  let runId: string
  let cursor: string | null
  let full: boolean
  if (peer.fullSyncRun !== null) {
    runId = peer.fullSyncRun
    cursor = peer.lastSyncCursor
    full = true
  } else if (opts.full || peer.lastSyncCursor === null) {
    runId = deps.newRunId()
    cursor = null
    full = true
  } else {
    runId = deps.newRunId()
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
    reconciled: 0,
  }
  if (peer.status !== 'active') return { ...result, error: 'peer-not-active' }

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
    while (result.pages < maxPages) {
      const target = feedTarget(cursor, pageLimit)
      const { text, signature } = await fetchPage(deps, origin + target, timeoutMs, maxBodyBytes)
      const verified = await verifyFederationBody(text, signature, {
        publicKey,
        expectedKeyId: peer.id,
        expectedTarget: target,
        now: Math.floor(deps.now() / 1000),
      })
      if (!verified.ok) throw new PullError(verified.reason)
      const page = validateFeedPage(verified.body, peer.id)

      await deps.store.applyPage({
        peerId: peer.id,
        runId,
        fullSyncRun: full ? runId : null,
        cursor: page.cursor,
        datasets: page.datasets,
        tombstones: page.tombstones,
        signature: signature!,
        fetchedAt: new Date(deps.now()).toISOString(),
      })
      result.pages++
      result.upserted += page.datasets.length
      result.tombstoned += page.tombstones.length
      cursor = page.cursor
      if (!page.hasMore) {
        result.complete = true
        break
      }
    }
    if (result.complete && full) {
      result.reconciled = await deps.store.finishFullSync(peer.id, runId)
    }
    result.ok = true
    await deps.store.recordSyncResult(peer.id, { at: new Date(deps.now()).toISOString(), error: null })
    return result
  } catch (err) {
    if (!(err instanceof PullError)) throw err
    result.error = err.code
    if (err.status !== undefined) result.status = err.status
    await deps.store.recordSyncResult(peer.id, {
      at: new Date(deps.now()).toISOString(),
      error: describePullFailure(err.code, err.status),
    })
    return result
  }
}
