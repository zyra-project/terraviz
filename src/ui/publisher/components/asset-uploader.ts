/**
 * Asset uploader component for the publisher portal — Phase 3pd.
 *
 * Replaces the 3pc/F-fix2 manual data_ref text input with a
 * guided three-stage flow that mirrors the asset_uploads pipeline:
 *
 *   1. /asset       — POST with the file's SHA-256 + size; server
 *                     mints a short-lived R2 presigned PUT URL.
 *   2. presigned    — PUT the file bytes directly to R2. XHR drives
 *                     this so the publisher gets upload-progress
 *                     events (fetch's body upload doesn't surface
 *                     them).
 *   3. /complete    — POST to verify the digest server-side and
 *                     either write `data_ref` immediately (images)
 *                     or fire a repository_dispatch + stamp
 *                     `transcoding=1` (video).
 *
 * Stage names + states are surfaced through an inline status
 * line + `<progress>` element so the publisher sees what's
 * happening at every step. Failures map to per-stage error
 * messages with the underlying API code (404 / 409 / 503 / etc.)
 * exposed in a disclosure for the operator-debugging cases the
 * 3pc error-card pattern established.
 *
 * The component takes a `currentDataRef` initial value (from
 * the existing row in edit mode) and renders it as a read-only
 * monospace display above the picker — the publisher sees what
 * the row currently points at without losing the picker. Once
 * an upload lands, the new ref (image case) or the
 * transcoding state (video case) is handed to the parent form
 * via `onUploaded`.
 */

import { t, type MessageKey } from '../../../i18n'
import {
  clearWarmupFlag,
  handleSessionError,
  publisherSend,
  type PublisherSendResult,
} from '../api'

/** Result of a finished upload. `mode='direct'` means data_ref
 *  is set on the row already; `mode='transcoding'` means a
 *  video transcode is in flight. The parent's responsibility
 *  on a transcoding outcome is just to re-render so its UI
 *  surface (the dataset form's manual data_ref input / Save
 *  button, the detail page's lifecycle controls) reflects the
 *  new state. Live status polling happens on the detail page
 *  (3pd/D, `startTranscodePolling` in
 *  `src/ui/publisher/pages/dataset-detail.ts`); the edit page
 *  does not poll, so an editor mid-transcode sees the
 *  read-only notice until they navigate away or reload. */
export type AssetUploadOutcome =
  | { mode: 'direct'; dataRef: string }
  | { mode: 'transcoding' }

export interface AssetUploaderOptions {
  /** Dataset id this uploader writes to. Required — the asset
   *  endpoints are scoped to the row. */
  datasetId: string
  /** Dataset's declared `format` (`video/mp4`, `image/png`, etc.).
   *  Used to pre-validate the picked file before any network call
   *  and to constrain the `accept` attribute on the input. */
  format: string
  /** Current `data_ref` from the existing row in edit mode, if
   *  any. Surfaced read-only above the picker so the publisher
   *  sees what they'd be replacing. */
  currentDataRef?: string | null
  /** Fired when the upload finishes successfully. */
  onUploaded: (outcome: AssetUploadOutcome) => void
  /** Fired when the publisher's draft hasn't been saved yet (the
   *  asset endpoints require an existing dataset id). The parent
   *  form is expected to surface a "Save draft first" notice. */
  onMissingDataset?: () => void
  /** Injected fetch — defaults to `globalThis.fetch`. */
  fetchFn?: typeof fetch
  /** Injected XHR factory — tests pass a stub that emits
   *  progress events without actual network IO. */
  xhrFactory?: () => XMLHttpRequest
  /** Injected SHA-256 — tests pass a deterministic hash so
   *  fixture digests round-trip without computing. */
  hashFn?: (file: File) => Promise<string>
  /** Injected sleep used by the API helpers' retry loops. */
  sleep?: (ms: number) => Promise<void>
  /** Navigation for the session-expired flow. */
  navigate?: (url: string) => void
}

interface AssetInitResponse {
  upload_id: string
  kind: 'data'
  target: 'r2'
  r2: { method: 'PUT'; url: string; headers: Record<string, string>; key: string }
  expires_at: string
  mock: boolean
}

interface AssetCompleteResponse {
  dataset: { data_ref: string }
  transcoding?: boolean
}

type Stage =
  | 'idle'
  | 'hashing'
  | 'minting'
  | 'uploading'
  | 'completing'
  | 'done-direct'
  | 'done-transcoding'
  | 'error'

interface StageState {
  stage: Stage
  /** 0..1 fraction shown in the progress bar. */
  progress: number
  /** Operator-facing key for the inline status line. */
  statusKey: MessageKey
  /** Raw API kind for the error card disclosure. */
  errorKind?: PublisherSendResult<unknown> extends infer T
    ? T extends { ok: false; kind: infer K }
      ? K
      : never
    : never
  /** Free-text detail attached to the error disclosure. */
  errorDetail?: string
}

const INITIAL: StageState = {
  stage: 'idle',
  progress: 0,
  statusKey: 'publisher.assetUploader.status.idle',
}

const STAGE_STATUS_KEY: Record<Stage, MessageKey> = {
  idle: 'publisher.assetUploader.status.idle',
  hashing: 'publisher.assetUploader.status.hashing',
  minting: 'publisher.assetUploader.status.minting',
  uploading: 'publisher.assetUploader.status.uploading',
  completing: 'publisher.assetUploader.status.completing',
  'done-direct': 'publisher.assetUploader.status.doneDirect',
  'done-transcoding': 'publisher.assetUploader.status.doneTranscoding',
  error: 'publisher.assetUploader.status.error',
}

/** Chunk size for incremental hashing — 8 MB. Large enough that
 *  per-chunk overhead is negligible, small enough that 4K video
 *  uploads don't blow the tab's memory budget. */
const HASH_CHUNK_BYTES = 8 * 1024 * 1024

/**
 * SHA-256 of a File via streaming chunks. The browser-native
 * `crypto.subtle.digest` only operates on a complete
 * `BufferSource` (no incremental API), so an `arrayBuffer()`
 * over a 4K MP4 would load the whole file into memory before
 * hashing — risky for >1 GB clips. Instead we slice the file
 * into `HASH_CHUNK_BYTES` chunks and feed each chunk into an
 * incremental SHA-256 from `@noble/hashes`. Fix for PR #112
 * Copilot #2.
 *
 * Returns the `sha256:<hex>` form the publisher API expects.
 */
export async function hashFileSha256(file: File): Promise<string> {
  // Dynamic import keeps `@noble/hashes` out of the main SPA
  // bundle — only loaded when the publisher actually opens the
  // uploader. ~10 KB tax on the portal lazy chunk.
  const { sha256 } = await import('@noble/hashes/sha2.js')
  const { bytesToHex } = await import('@noble/hashes/utils.js')
  const hasher = sha256.create()
  for (let offset = 0; offset < file.size; offset += HASH_CHUNK_BYTES) {
    const slice = file.slice(offset, offset + HASH_CHUNK_BYTES)
    const buf = await slice.arrayBuffer()
    hasher.update(new Uint8Array(buf))
    // The local `buf` + `slice` go out of scope on the next
    // iteration, letting the GC reclaim each chunk before we
    // read the next one. Peak memory ≈ HASH_CHUNK_BYTES + the
    // hasher's small internal state.
  }
  return `sha256:${bytesToHex(hasher.digest())}`
}

/**
 * Render the uploader into a fresh element and return it. The
 * caller appends this to the form card. Idempotent — calling
 * again creates a new instance; the old one is GC-eligible once
 * detached.
 */
export function renderAssetUploader(options: AssetUploaderOptions): HTMLElement {
  const root = document.createElement('div')
  root.className = 'publisher-asset-uploader'

  let state: StageState = INITIAL

  function paint(): void {
    root.replaceChildren(buildBody(state))
  }

  function buildBody(s: StageState): DocumentFragment {
    const frag = document.createDocumentFragment()

    // Current ref line — only when edit mode with an existing
    // ref, and only when no upload is in flight (the in-flight
    // status replaces this line). The publisher sees what
    // they're about to replace.
    if (options.currentDataRef && s.stage === 'idle') {
      const current = document.createElement('p')
      current.className = 'publisher-asset-uploader-current'
      const label = document.createElement('span')
      label.className = 'publisher-asset-uploader-current-label'
      label.textContent = t('publisher.assetUploader.current')
      const value = document.createElement('span')
      value.className = 'publisher-asset-uploader-current-value publisher-field-value-mono'
      value.textContent = options.currentDataRef
      current.appendChild(label)
      current.appendChild(value)
      frag.appendChild(current)
    }

    // File picker. The label is mounted alongside the input
    // (and explicitly bound via `for` / `id`) so screen readers
    // announce "Pick a file, file picker" rather than leaving
    // the input unlabeled. Fix for PR #112 Copilot #4.
    const inputRow = document.createElement('div')
    inputRow.className = 'publisher-asset-uploader-input-row'

    const inputId = 'dataset-asset-file'
    const label = document.createElement('label')
    label.className = 'publisher-asset-uploader-label'
    label.setAttribute('for', inputId)
    label.textContent = t('publisher.assetUploader.pickFile')
    inputRow.appendChild(label)

    const input = document.createElement('input')
    input.type = 'file'
    input.id = inputId
    input.className = 'publisher-asset-uploader-input'
    input.accept = acceptForFormat(options.format)
    // Re-enable only when the uploader is idle, in an error
    // state the publisher can retry from, or done with a
    // direct (non-transcode) finalisation. `done-transcoding`
    // keeps the picker disabled — starting a second upload
    // while the first transcode is still in flight would fire
    // an overlapping dispatch, and the /asset/.../complete
    // route's `transcoding_in_progress` guard (migration 0012,
    // 3pd-followup/C) would refuse it anyway. Cleaner to
    // disable here.
    input.disabled =
      s.stage !== 'idle' &&
      s.stage !== 'error' &&
      s.stage !== 'done-direct'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return
      void run(file)
    })
    inputRow.appendChild(input)

    frag.appendChild(inputRow)

    // Status line + progress.
    const status = document.createElement('p')
    status.className = `publisher-asset-uploader-status publisher-asset-uploader-status-${s.stage}`
    status.setAttribute('role', 'status')
    status.textContent = t(s.statusKey)
    frag.appendChild(status)

    if (s.stage !== 'idle' && s.stage !== 'error' && !s.stage.startsWith('done-')) {
      const bar = document.createElement('progress')
      bar.className = 'publisher-asset-uploader-progress'
      bar.max = 1
      bar.value = s.progress
      frag.appendChild(bar)
    }

    if (s.stage === 'error' && s.errorDetail) {
      const det = document.createElement('details')
      det.className = 'publisher-asset-uploader-error-details'
      const summary = document.createElement('summary')
      summary.textContent = t('publisher.assetUploader.errorDetails')
      det.appendChild(summary)
      const pre = document.createElement('pre')
      pre.textContent = s.errorDetail
      det.appendChild(pre)
      frag.appendChild(det)
    }

    return frag
  }

  async function run(file: File): Promise<void> {
    if (!options.datasetId) {
      options.onMissingDataset?.()
      return
    }
    // Browsers sometimes report `File.type === ''` for files
    // dragged from certain OS file managers, or for ext-only
    // matches. Fall back to deriving the MIME from the filename
    // extension before checking — otherwise valid uploads
    // fail at the client gate before the server can speak.
    // Fix for PR #112 Copilot #3.
    //
    // `image/jpg` → `image/jpeg` normalization: a few legacy
    // browsers / OS file managers stamp `image/jpg` on JPEG
    // files. `mimeAcceptedForFormat` recognises both as
    // matching a JPEG-format dataset, but the server's
    // /asset init allowlist only accepts the canonical
    // `image/jpeg`. Without normalisation here the client
    // gate passes and the server then 400s at mint time —
    // confusing dead-end UX. Normalise to the canonical form
    // before either the gate check or the request body so
    // both halves agree. PR #112 followup.
    const rawMime = file.type || mimeFromFilename(file.name)
    const effectiveMime = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime
    if (!mimeAcceptedForFormat(effectiveMime, options.format)) {
      state = {
        ...INITIAL,
        stage: 'error',
        statusKey: 'publisher.assetUploader.status.error',
        errorDetail: t('publisher.assetUploader.mimeMismatch', {
          actual: effectiveMime || 'unknown',
          expected: options.format,
        }),
      }
      paint()
      return
    }

    try {
      // 1. Hash.
      state = { ...state, stage: 'hashing', progress: 0, statusKey: STAGE_STATUS_KEY.hashing }
      paint()
      const digest = await (options.hashFn ?? hashFileSha256)(file)

      // 2. Mint presigned PUT.
      state = { ...state, stage: 'minting', statusKey: STAGE_STATUS_KEY.minting }
      paint()
      const initResult = await publisherSend<AssetInitResponse>(
        `/api/v1/publish/datasets/${encodeURIComponent(options.datasetId)}/asset`,
        {
          kind: 'data',
          mime: effectiveMime,
          size: file.size,
          content_digest: digest,
        },
        { fetchFn: options.fetchFn, sleep: options.sleep },
      )
      if (!initResult.ok) {
        return fail('mint', initResult)
      }
      clearWarmupFlag()
      const init = initResult.data

      // 3. PUT to R2 via XHR (for upload-progress events).
      if (!init.mock) {
        state = { ...state, stage: 'uploading', progress: 0, statusKey: STAGE_STATUS_KEY.uploading }
        paint()
        await putWithProgress(init.r2, file, fraction => {
          state = { ...state, progress: fraction }
          paint()
        }, options.xhrFactory)
      }

      // 4. Finalize.
      state = {
        ...state,
        stage: 'completing',
        progress: 1,
        statusKey: STAGE_STATUS_KEY.completing,
      }
      paint()
      const completeResult = await publisherSend<AssetCompleteResponse>(
        `/api/v1/publish/datasets/${encodeURIComponent(options.datasetId)}/asset/${init.upload_id}/complete`,
        {},
        { fetchFn: options.fetchFn, sleep: options.sleep },
      )
      if (!completeResult.ok) {
        return fail('complete', completeResult)
      }

      // 5. Wire the outcome up to the parent.
      const isTranscoding = completeResult.data.transcoding === true
      if (isTranscoding) {
        state = {
          ...state,
          stage: 'done-transcoding',
          progress: 1,
          statusKey: STAGE_STATUS_KEY['done-transcoding'],
        }
        paint()
        options.onUploaded({ mode: 'transcoding' })
      } else {
        state = {
          ...state,
          stage: 'done-direct',
          progress: 1,
          statusKey: STAGE_STATUS_KEY['done-direct'],
        }
        paint()
        options.onUploaded({ mode: 'direct', dataRef: completeResult.data.dataset.data_ref })
      }
    } catch (err) {
      state = {
        ...state,
        stage: 'error',
        statusKey: STAGE_STATUS_KEY.error,
        errorDetail: err instanceof Error ? err.message : String(err),
      }
      paint()
    }
  }

  function fail<T>(stage: 'mint' | 'complete', result: PublisherSendResult<T>): void {
    if (result.ok) return
    if (result.kind === 'session') {
      if (handleSessionError({ navigate: options.navigate }) === 'show-error') {
        state = {
          ...state,
          stage: 'error',
          statusKey: STAGE_STATUS_KEY.error,
          errorDetail: t('publisher.assetUploader.sessionExpired'),
        }
        paint()
      }
      return
    }
    let detail: string
    if (result.kind === 'validation') {
      detail = result.errors.map(e => `${e.field}: ${e.message}`).join('; ')
    } else if (result.kind === 'server') {
      detail = `${stage}: HTTP ${result.status ?? '?'} ${result.body ?? ''}`
    } else {
      detail = `${stage}: ${result.kind}`
    }
    state = { ...state, stage: 'error', statusKey: STAGE_STATUS_KEY.error, errorDetail: detail }
    paint()
  }

  paint()
  return root
}

/**
 * Map the dataset's declared format to a sensible `accept`
 * attribute on the file input so the file picker pre-filters
 * what the publisher sees. Always permissive enough that the
 * mime-mismatch check in `run()` is the authoritative gate; the
 * `accept` attribute is hint-only.
 */
function acceptForFormat(format: string): string {
  switch (format) {
    case 'video/mp4':
      return 'video/mp4,.mp4'
    case 'image/png':
      return 'image/png,.png'
    case 'image/jpeg':
      return 'image/jpeg,.jpg,.jpeg'
    case 'image/webp':
      return 'image/webp,.webp'
    case 'tour/json':
      return 'application/json,.json'
    default:
      return ''
  }
}

function mimeAcceptedForFormat(mime: string, format: string): boolean {
  if (mime === format) return true
  if (format === 'tour/json' && mime === 'application/json') return true
  // Some browsers report `image/jpeg` as `image/jpg` historically.
  if (format === 'image/jpeg' && mime === 'image/jpg') return true
  return false
}

/**
 * Derive a MIME type from a filename when `File.type` is empty
 * (some browsers report empty MIME for files dragged from
 * certain OS-side file pickers). Conservative: only the four
 * shapes the publisher form accepts. Anything unknown returns
 * empty string so the mime-mismatch gate catches it cleanly.
 */
function mimeFromFilename(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.mp4')) return 'video/mp4'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.json')) return 'application/json'
  return ''
}

/**
 * PUT a file to a presigned URL via XHR so the publisher gets
 * upload-progress events. fetch() doesn't surface request-body
 * progress, so this stays on XHR even though the rest of the
 * portal uses fetch.
 */
function putWithProgress(
  r2: { method: 'PUT'; url: string; headers: Record<string, string> },
  file: File,
  onProgress: (fraction: number) => void,
  xhrFactory?: () => XMLHttpRequest,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = (xhrFactory ?? (() => new XMLHttpRequest()))()
    xhr.open(r2.method, r2.url)
    for (const [k, v] of Object.entries(r2.headers)) {
      xhr.setRequestHeader(k, v)
    }
    xhr.upload.addEventListener('progress', event => {
      if (event.lengthComputable) {
        onProgress(event.loaded / event.total)
      }
    })
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1)
        resolve()
      } else {
        reject(new Error(`R2 PUT returned ${xhr.status}: ${xhr.responseText || 'no body'}`))
      }
    })
    xhr.addEventListener('error', () => reject(new Error('R2 PUT failed: network error')))
    xhr.addEventListener('abort', () => reject(new Error('R2 PUT aborted')))
    xhr.send(file)
  })
}
