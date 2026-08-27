// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Zip Download Service — web-only "package a dataset as a .zip"
 * entry point for §8.2 of `WEB_CATALOG_FEATURES_PLAN.md`.
 *
 * Walks the dataset's resolved assets (from `downloadService.resolve
 * Assets`), fetches each one through `globalThis.fetch` with per-asset
 * progress callbacks + a shared `AbortController`, packages them into
 * a `JSZip` instance with a `manifest.json` describing the contents,
 * generates a blob, and triggers a normal `<a download>` to save it.
 *
 * Design notes:
 *  - Per-asset error tolerance: a 404 on the legend doesn't kill the
 *    zip; the failure is recorded in the manifest and the download
 *    proceeds. Only a primary-asset failure aborts.
 *  - Size cap: callers HEAD every asset up-front via `estimateZipSize`
 *    so the dialog can disable the start button above 1.5 GB before
 *    the user waits for any bytes.
 *  - Abort path: a user-triggered cancel signals through the shared
 *    AbortController; in-flight fetches throw, the zip blob is never
 *    generated, no partial file lands on disk.
 *  - Manifest-only mode: if every asset fetch fails, the zip is not
 *    produced — surfacing nothing-but-a-manifest would mislead the
 *    user into thinking the download succeeded.
 *
 * Web-only by design. Desktop has its own offline-cache flow via
 * Tauri (`downloadService.downloadDataset`) and doesn't need to ship
 * JSZip into the desktop bundle.
 */

import JSZip from 'jszip'
import type { Dataset } from '../types'
import {
  expandFrameAssets,
  resolveAssets,
  resolveAuxiliaryAssetsOnly,
  type AssetKind,
  type ResolvedAsset,
} from './downloadService'
import { logger } from '../utils/logger'

/** Hard cap above which the dialog disables the Start button. Multi-
 *  GB zips OOM the tab; the cap is the safety net behind the dialog's
 *  warning at 1 GB. Tunable; matches §8.4 risk note in the plan. */
export const ZIP_HARD_CAP_BYTES = 1.5 * 1024 * 1024 * 1024 // 1.5 GiB

/** Warning threshold — the dialog surfaces an "are you sure?" message
 *  but still lets the user proceed. */
export const ZIP_WARNING_BYTES = 1 * 1024 * 1024 * 1024 // 1 GiB

/** Concurrency cap for HEAD-based size probing. The Vimeo proxy and
 *  R2 public origins both serve HEAD cheaply, but parallelism beyond
 *  ~6 hits browser per-host connection limits and risks rate-limit
 *  responses on some CDNs. Six matches the conventional browser
 *  HTTP/1 per-host cap. */
const HEAD_CONCURRENCY = 6

/** What inside `dataset.frames` looks unreasonable to even attempt
 *  to size-estimate. Above this threshold we sample a few frames and
 *  multiply rather than HEADing every one — keeps the dialog
 *  responsive on 10k-frame datasets. The estimate is approximate
 *  anyway; the 1.5 GB cap is what enforces correctness. */
const FRAME_SAMPLE_THRESHOLD = 50
const FRAME_SAMPLE_SIZE = 5

/** Progress callback fired during the fetch loop. */
export interface ZipProgress {
  /** 0..1 — overall progress across HEAD + fetch + zip-generate. */
  fraction: number
  /** Human-readable phase label, suitable for direct display. */
  phase: 'fetching' | 'packaging' | 'done'
  /** Currently-fetching asset filename, if known. */
  currentFile?: string
}

/** Failure record kept in the manifest for assets that errored out
 *  mid-fetch. The zip still produces; the user sees the breakdown
 *  via a toast and inside `manifest.json`. */
export interface ZipFailure {
  filename: string
  url: string
  reason: string
}

/** Final result returned by `buildZip`. */
export interface ZipResult {
  /** The generated archive. Caller is responsible for revoking the
   *  blob-URL after the trigger fires. */
  blob: Blob
  /** Suggested download filename (`{dataset-id}.zip`). */
  filename: string
  /** Bytes successfully included in the archive. */
  bytesWritten: number
  /** Per-asset failures the manifest also records. */
  failures: ZipFailure[]
}

export interface BuildZipOptions {
  /** AssetKind allow-list. Defaults to "include every kind". The
   *  dialog passes the user's checked checkboxes here. */
  selectedKinds?: ReadonlySet<AssetKind>
  /** Caller-supplied abort signal. Aborting before `done` rejects
   *  with `DOMException('AbortError')`. */
  signal?: AbortSignal
  /** Progress callback fired ~per asset + during zip generation. */
  onProgress?: (progress: ZipProgress) => void
  /** Override fetch — only used by tests. */
  fetchImpl?: typeof globalThis.fetch
}

/** Per-asset entry in the in-archive `manifest.json`. */
interface ManifestEntry {
  kind: AssetKind
  filename: string
  url: string
  sourceOfTruth: ResolvedAsset['sourceOfTruth']
  bytes?: number
  /** Set when the fetch failed and the file was omitted from the zip. */
  error?: string
}

/** The full shape of the in-archive `manifest.json`. */
interface ZipManifest {
  datasetId: string
  title: string
  format: string
  downloadedAt: string
  framesDigest?: string
  notes: string[]
  assets: ManifestEntry[]
}

/**
 * Walk the dataset's resolvable assets so the caller can pre-flight
 * the zip dialog. The expand-frames toggle is gated on `dataset.frames`
 * being populated and the caller opting in (the dialog always opts in
 * for frame datasets — there's nothing else to download).
 *
 * Frame-mode takes a fundamentally different path from the default:
 * post-transcode publisher datasets carry an HLS-only video manifest
 * (data_ref = `r2:.../master.m3u8`), so `resolveAssets()` would throw
 * "HLS-streamed and not yet available for offline download" before
 * the frame URLs could be offered. For frame-mode the frame bundle
 * IS the primary data, so we skip the video primary resolution
 * entirely and resolve only auxiliary assets.
 */
export async function listDownloadableAssets(
  dataset: Dataset,
  opts: { includeFrames?: boolean; signal?: AbortSignal } = {},
): Promise<ResolvedAsset[]> {
  if (opts.includeFrames && dataset.frames) {
    const frames = expandFrameAssets(dataset)
    const aux = resolveAuxiliaryAssetsOnly(dataset)
    return [...frames, ...aux]
  }
  return resolveAssets(dataset, { signal: opts.signal })
}

/**
 * Estimate the total zip size by HEAD-probing each asset whose
 * `sizeBytes` isn't already known. Returns the sum of all known sizes
 * (rounded up to a per-asset 0-byte floor — a 404 still counts as 0
 * rather than NaN). Asset HEAD failures are silently treated as 0
 * since the asset will be skipped at fetch time too.
 *
 * For frames-mode datasets the per-frame HEAD set is sampled (every
 * Nth frame) above `FRAME_SAMPLE_THRESHOLD` so the dialog stays
 * responsive on 10k-frame datasets. The result is an approximation;
 * the 1.5 GB hard cap is the source of truth for "can this proceed".
 */
export async function estimateZipSize(
  assets: ReadonlyArray<ResolvedAsset>,
  opts: { signal?: AbortSignal; fetchImpl?: typeof globalThis.fetch } = {},
): Promise<{ bytes: number; sampled: boolean; perAsset: Map<string, number> }> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const perAsset = new Map<string, number>()

  // Frame-sequence sampling: if there are more than the threshold
  // many "frame" kinds, HEAD a few of them and multiply by the total
  // count rather than HEADing every one.
  const frameAssets = assets.filter(a => a.kind === 'frame')
  const nonFrameAssets = assets.filter(a => a.kind !== 'frame')
  let sampled = false
  let frameBytes = 0

  if (frameAssets.length > FRAME_SAMPLE_THRESHOLD) {
    sampled = true
    const stride = Math.max(1, Math.floor(frameAssets.length / FRAME_SAMPLE_SIZE))
    const samples: ResolvedAsset[] = []
    for (let i = 0; i < frameAssets.length && samples.length < FRAME_SAMPLE_SIZE; i += stride) {
      samples.push(frameAssets[i])
    }
    const sampleSizes = await runConcurrent(
      samples,
      a => headSize(a, fetchImpl, opts.signal),
      HEAD_CONCURRENCY,
    )
    const okSamples = sampleSizes.filter(n => n > 0)
    if (okSamples.length > 0) {
      const avg = okSamples.reduce((s, n) => s + n, 0) / okSamples.length
      frameBytes = Math.round(avg * frameAssets.length)
      // We didn't HEAD every frame individually; the perAsset map
      // gets the average per frame so the dialog can render an
      // approximate "estimated bytes per frame × N" without
      // pretending we know each one exactly.
      for (const a of frameAssets) perAsset.set(a.filename, Math.round(avg))
    } else {
      // Every sample HEAD failed (CORS, 404, etc). Treat the frame
      // bundle as 0-bytes-known; the dialog will surface that as
      // "size unknown" rather than misleading.
      for (const a of frameAssets) perAsset.set(a.filename, 0)
    }
  } else {
    const frameSizes = await runConcurrent(
      frameAssets,
      a => headSize(a, fetchImpl, opts.signal),
      HEAD_CONCURRENCY,
    )
    frameAssets.forEach((a, i) => perAsset.set(a.filename, frameSizes[i]))
    frameBytes = frameSizes.reduce((s, n) => s + n, 0)
  }

  let nonFrameBytes = 0
  const sizes = await runConcurrent(
    nonFrameAssets,
    async (a) => {
      if (a.sizeBytes !== undefined) return a.sizeBytes
      return headSize(a, fetchImpl, opts.signal)
    },
    HEAD_CONCURRENCY,
  )
  nonFrameAssets.forEach((a, i) => perAsset.set(a.filename, sizes[i]))
  nonFrameBytes = sizes.reduce((s, n) => s + n, 0)

  return { bytes: frameBytes + nonFrameBytes, sampled, perAsset }
}

/**
 * Probe a single asset for its byte size, returning 0 on any error.
 * The 0 sentinel matters: it's what `estimateZipSize` sums into the
 * running total, and what the dialog renders as "unknown" rather
 * than NaN.
 *
 * Two-step strategy:
 *  1. HEAD the URL. Servers that include Content-Length on HEAD are
 *     the happy path.
 *  2. If HEAD returned 2xx without a Content-Length, fall back to a
 *     `Range: bytes=0-0` GET and parse the `Content-Range` response
 *     header (format: `bytes 0-0/<total>`). This catches origins
 *     that elide Content-Length on HEAD because computing it would
 *     require actually generating the resource — Cloudflare Images'
 *     `/cdn-cgi/image/` transformation pipeline does this. The
 *     Range GET only pulls one byte, so it's still cheap.
 *
 * Both Content-Length and Content-Range are normally CORS-safelisted
 * for our own origins; for third-party origins that don't expose
 * either, the probe returns 0 and the dialog renders "size unknown".
 */
async function headSize(
  asset: ResolvedAsset,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<number> {
  if (asset.sizeBytes !== undefined) return asset.sizeBytes
  try {
    const res = await fetchImpl(asset.url, { method: 'HEAD', signal })
    if (res.ok) {
      const len = res.headers.get('content-length')
      if (len) {
        const n = Number(len)
        if (Number.isFinite(n) && n > 0) return n
      }
    }
  } catch {
    // Fall through to the Range-GET fallback rather than giving up
    // — some origins reject HEAD outright but accept Range GETs.
  }
  try {
    const res = await fetchImpl(asset.url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      signal,
    })
    if (!res.ok && res.status !== 206) return 0
    // Range responses carry `Content-Range: bytes 0-0/<total>`; pull
    // the total. If the server ignored the Range header and returned
    // the whole body (200 OK), fall back to Content-Length.
    const range = res.headers.get('content-range')
    if (range) {
      const match = range.match(/\/(\d+)\s*$/)
      if (match) {
        const n = Number(match[1])
        if (Number.isFinite(n) && n > 0) return n
      }
    }
    const len = res.headers.get('content-length')
    if (len) {
      const n = Number(len)
      // A 200 OK with the full body: Content-Length is the answer.
      // A 206 with Content-Length: 1 from the Range GET is useless;
      // only trust the value when we got a 200.
      if (Number.isFinite(n) && n > 0 && res.status === 200) return n
    }
    return 0
  } catch {
    return 0
  }
}

/** Bounded-concurrency runner. Returns results in input order. */
async function runConcurrent<T, R>(
  items: ReadonlyArray<T>,
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

/**
 * Build a zip archive for `dataset` over the selected `assets`.
 *
 * Per-asset error tolerance: a 404 / network error on any non-primary
 * asset records a failure in the manifest and proceeds. A primary-
 * asset failure throws — there's no point producing a zip with only
 * a legend and a thumbnail.
 *
 * Caller's responsibility: drive the `<a download>` trigger from the
 * returned blob and revoke the object URL afterwards.
 */
export async function buildZip(
  dataset: Dataset,
  assets: ReadonlyArray<ResolvedAsset>,
  options: BuildZipOptions = {},
): Promise<ZipResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const onProgress = options.onProgress ?? (() => {})
  const signal = options.signal
  const selected = options.selectedKinds
    ? assets.filter(a => options.selectedKinds!.has(a.kind))
    : [...assets]

  if (selected.length === 0) {
    throw new Error('No assets selected for zip download.')
  }

  const zip = new JSZip()
  const failures: ZipFailure[] = []
  const manifestEntries: ManifestEntry[] = []
  let bytesWritten = 0
  let assetsDone = 0

  // "Primary-equivalent" — the asset role that, if absent, means the
  // archive is meaningless. The `primary` kind is the default, but
  // frame-mode datasets replace the rendered primary with their
  // per-frame entries (see `listDownloadableAssets`), so for those
  // the frame bundle takes the role. We compute this once over the
  // user's selection so the per-asset error branch can treat the
  // right kind as fatal.
  const hasPrimary = selected.some(a => a.kind === 'primary')
  const primaryEquivalentKinds = new Set<AssetKind>(
    hasPrimary ? ['primary'] : ['frame'],
  )

  // Phase 1: fetch each asset in series — sequential download keeps
  // peak memory bounded (a single asset's bytes live in memory before
  // being handed to JSZip). Parallel fetches would multiply peak
  // memory by the concurrency factor.
  for (const asset of selected) {
    if (signal?.aborted) {
      throw new DOMException('Zip download aborted by user', 'AbortError')
    }
    onProgress({
      fraction: assetsDone / (selected.length + 1),
      phase: 'fetching',
      currentFile: asset.filename,
    })

    // The try/catch wraps ONLY the network step. The mid-download
    // cap check and zip.file call live outside it so a cap throw
    // escapes the loop entirely rather than being swallowed by the
    // catch's "treat non-primary failure as recorded warning" path.
    let buf: ArrayBuffer | null = null
    try {
      const res = await fetchImpl(asset.url, { signal })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      // Pre-arrayBuffer cap check. `res.arrayBuffer()` materializes
      // the entire response body in memory before our post-fetch
      // guard at line ~430 ever runs — a single 5 GB response can
      // OOM the tab during that allocation even though the
      // bytesWritten+byteLength check would have rejected it
      // afterward. Inspect Content-Length first and abort before
      // touching the body when the server declares an over-cap
      // size. Origins that omit Content-Length skip this check —
      // the post-arrayBuffer guard then catches them at the cost
      // of one materialised buffer (best we can do without
      // streaming the body chunk-by-chunk, which JSZip doesn't
      // support natively).
      const declaredLen = res.headers.get('content-length')
      if (declaredLen) {
        const declared = Number(declaredLen)
        if (Number.isFinite(declared) && declared > 0 &&
            bytesWritten + declared > ZIP_HARD_CAP_BYTES) {
          throw new Error(
            `Zip would exceed the ${formatCapForError(ZIP_HARD_CAP_BYTES)} cap ` +
            `after adding ${asset.filename} (server declared ${declared} bytes). ` +
            `Uncheck some assets and try again.`,
          )
        }
      }
      buf = await res.arrayBuffer()
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') throw err
      // Cap-error throws need to escape the loop unconditionally —
      // they're not a network failure, and re-classifying them as
      // a recorded non-primary warning would defeat the safety
      // net. The marker is the error message's "cap" substring,
      // which we own and ship from the throws above + below.
      if (err instanceof Error && / cap /.test(err.message)) throw err
      const reason = err instanceof Error ? err.message : String(err)
      logger.warn(`[zip] Failed to fetch ${asset.filename}:`, reason)
      if (primaryEquivalentKinds.has(asset.kind)) {
        // The user came here to download the data. Without the
        // primary (or, for frame-mode datasets, the frame bundle)
        // the archive is meaningless — surface the failure rather
        // than producing a manifest-only zip.
        throw new Error(
          `Failed to download the primary asset (${asset.filename}): ${reason}`,
        )
      }
      failures.push({ filename: asset.filename, url: asset.url, reason })
      manifestEntries.push({
        kind: asset.kind,
        filename: asset.filename,
        url: asset.url,
        sourceOfTruth: asset.sourceOfTruth,
        error: reason,
      })
      assetsDone++
      continue
    }

    // Post-arrayBuffer cap check — defence in depth for the origins
    // that don't return Content-Length. The buffer is already
    // allocated, so this can't prevent the *first* over-cap
    // response from OOMing the tab; what it does prevent is the
    // archive growing further (the next asset's allocation, plus
    // the eventual JSZip generate pass).
    if (bytesWritten + buf.byteLength > ZIP_HARD_CAP_BYTES) {
      throw new Error(
        `Zip would exceed the ${formatCapForError(ZIP_HARD_CAP_BYTES)} cap ` +
        `after adding ${asset.filename}. The size estimate was too low ` +
        `(some origins don't expose Content-Length). Uncheck some assets ` +
        `and try again.`,
      )
    }
    zip.file(asset.filename, buf)
    bytesWritten += buf.byteLength
    manifestEntries.push({
      kind: asset.kind,
      filename: asset.filename,
      url: asset.url,
      sourceOfTruth: asset.sourceOfTruth,
      bytes: buf.byteLength,
    })
    assetsDone++
  }

  // Safety net: if the fetch loop completed but zero asset bytes
  // made it into the archive, refuse to produce a manifest-only
  // zip. This catches the case where every selected asset's kind
  // happens to be non-primary-equivalent (none of the per-asset
  // throws fire) but they all failed — frame-mode dataset whose
  // every frame 404s, or a selection consisting only of auxiliary
  // assets where every one failed.
  if (bytesWritten === 0) {
    throw new Error(
      'Zip would contain no data — every selected asset failed to download.',
    )
  }

  // Manifest — describes the archive's contents, the source-of-
  // truth provenance per asset, and any failures so the user can
  // tell at a glance whether their archive is complete.
  const manifest: ZipManifest = {
    datasetId: dataset.id,
    title: dataset.title,
    format: dataset.format,
    downloadedAt: new Date().toISOString(),
    framesDigest: dataset.frames?.framesDigest,
    notes: buildManifestNotes(manifestEntries, dataset),
    assets: manifestEntries,
  }
  zip.file('manifest.json', JSON.stringify(manifest, null, 2))

  onProgress({ fraction: assetsDone / (selected.length + 1), phase: 'packaging' })

  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } },
    metadata => {
      // Check the abort signal inside the packaging callback so a
      // cancel landing after all fetches finished still stops the
      // download before saveBlobAsDownload triggers. JSZip itself
      // doesn't expose a cancellation API; throwing from this
      // callback rejects the generateAsync promise, which we
      // re-throw as an AbortError below.
      if (signal?.aborted) {
        throw new DOMException('Zip download aborted by user', 'AbortError')
      }
      // JSZip's `metadata.percent` is the zip-generate phase (0-100);
      // map it onto the tail of the overall progress bar.
      const generateFraction = metadata.percent / 100
      const baseFraction = assetsDone / (selected.length + 1)
      const remaining = 1 - baseFraction
      onProgress({
        fraction: baseFraction + generateFraction * remaining,
        phase: 'packaging',
        currentFile: metadata.currentFile ?? undefined,
      })
    },
  )

  // Final abort check before handing the blob back. The packaging
  // callback runs on every "current file" tick but the generate
  // can finish between ticks (small archives complete in one
  // call), so a cancel arriving in that window otherwise sneaks
  // past — the caller would saveBlobAsDownload after the user
  // already hit Cancel.
  if (signal?.aborted) {
    throw new DOMException('Zip download aborted by user', 'AbortError')
  }

  onProgress({ fraction: 1, phase: 'done' })

  return {
    blob,
    filename: `${sanitizeFilenameStem(dataset.id)}.zip`,
    bytesWritten,
    failures,
  }
}

/** GiB-rounded string for the in-error cap label so the message is
 *  readable without depending on formatBytes (which lives in a
 *  sibling module and would cycle the import graph). */
function formatCapForError(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024)
  return `${gib.toFixed(1)} GiB`
}

/** Build the human-readable "notes" array for `manifest.json` based
 *  on which buckets the resolved assets fell into. The dialog
 *  shows roughly the same string for the user before they hit start;
 *  keeping it in the manifest too means the archive carries its own
 *  provenance trail. */
function buildManifestNotes(entries: ReadonlyArray<ManifestEntry>, dataset: Dataset): string[] {
  const notes: string[] = []
  const primary = entries.find(e => e.kind === 'primary')
  if (primary) {
    switch (primary.sourceOfTruth) {
      case 'publisher':
        notes.push('Primary asset is the publisher\'s canonical upload (source MP4 / source image).')
        break
      case 'vimeo':
        notes.push('Primary asset is the best-quality MP4 from the Vimeo proxy. ' +
          'The dataset streams as HLS adaptive video; this archive contains a single MP4 transcode of that stream, not the original source.')
        break
      case 'sos':
        notes.push('Primary asset is served from the legacy SOS catalog (sos.noaa.gov).')
        break
      case 'external':
        notes.push('Primary asset is hosted externally — see the URL in the manifest for provenance.')
        break
    }
  }
  const hasFrames = entries.some(e => e.kind === 'frame')
  if (hasFrames) {
    notes.push(`Includes ${entries.filter(e => e.kind === 'frame').length} source frames.` +
      (dataset.frames?.framesDigest ? ' Compare framesDigest above against the publisher-signed digest for integrity.' : ''))
  }
  return notes
}

/** Strip filesystem-unfriendly characters from a stem like a dataset
 *  id. Dataset IDs are ULIDs in production but legacy `INTERNAL_SOS_*`
 *  rows have underscores and digits; keep [A-Za-z0-9_.-] verbatim and
 *  replace everything else with `_` so the saved file always has a
 *  sensible filename. */
function sanitizeFilenameStem(stem: string): string {
  // First pass: drop everything outside the safe set so a stem of
  // only punctuation (`!!!!`) doesn't collapse to `_` and look like
  // a valid filename. If anything safe survives we run a second
  // pass replacing the dropped runs with `_` in the original
  // sequence so embedded spaces become readable underscores.
  if (!/[A-Za-z0-9._-]/.test(stem)) return 'dataset'
  return stem.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64)
}

/**
 * Trigger a browser save dialog for `blob` named `filename`. Creates
 * a temporary anchor, clicks it, and revokes the object URL on
 * the next tick. Caller doesn't need to manage the lifecycle.
 */
export function saveBlobAsDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  // Same revoke-on-next-tick pattern playlistUI's triggerExport uses
  // — avoids the click-handler racing with the URL revocation.
  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 0)
}

/** Test-only surface for the pure helpers (manifest notes, filename
 *  sanitization, sample-decision). Don't import outside *.test.ts. */
export const __test__ = {
  buildManifestNotes,
  sanitizeFilenameStem,
  FRAME_SAMPLE_THRESHOLD,
  FRAME_SAMPLE_SIZE,
}
