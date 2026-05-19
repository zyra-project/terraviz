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

/** Tab discriminator on a video dataset's uploader. The tab strip
 *  is mounted only when `options.format === 'video/mp4'` since
 *  image-sequence input is video-only by design. */
type UploaderTab = 'video' | 'frames'

/** Per-frame mime allowlist mirrors `validateImageSequenceInit`
 *  on the publisher API. Worth duplicating client-side so the
 *  picker rejects the file before any network call. */
const FRAME_MIME_ALLOWLIST: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
])

/** Frame-count cap mirrors `MAX_IMAGE_SEQUENCE_FRAMES` on the
 *  publisher API. The hash budget + JSON-response-size discussion
 *  lives in `docs/CATALOG_IMAGE_SEQUENCE_PLAN.md` §Open Q4. */
const MAX_FRAMES = 10_000

/** Aggregate-size cap mirrors `SIZE_IMAGE_SEQUENCE_TOTAL` on the
 *  publisher API (10 GB). Enforced client-side as well as
 *  server-side so a publisher who drags in tens of GB of high-res
 *  PNGs gets a fail-fast rejection before the ~100 s in-browser
 *  hash budget burns. The two values must agree — if a future
 *  change raises the server cap, raise this constant too. */
const MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024

/** Bounded concurrency for the per-frame PUT pool. 5 matches the
 *  Phase 3pf plan recommendation — high enough that R2's edge
 *  parallelises the writes, low enough that a typical residential
 *  uplink doesn't get saturated by HTTP/1.1 connection limits or
 *  the browser's per-host socket cap. */
const FRAME_UPLOAD_CONCURRENCY = 5

/** Stage labels for the frame-sequence flow. Distinct from `Stage`
 *  because the frame stages carry an N/M counter for "hashing 47/240"
 *  / "uploading 47/240" status lines. */
type FramesStage =
  | 'idle'
  | 'picked'
  | 'hashing'
  | 'minting'
  | 'uploading'
  | 'completing'
  | 'done-transcoding'
  | 'error'

interface FramesState {
  stage: FramesStage
  /** Picked + lexicographically-sorted files. Cleared on retry. */
  files: File[]
  /** Resolved per-frame MIME (`image/png` / `image/jpeg` /
   *  `image/webp`). Computed once in `handleFramesPicked` from
   *  the first file's `type` (or filename fallback) and asserted
   *  to match every subsequent file — so the run path uses a
   *  verified value rather than re-deriving on a potentially
   *  empty array. */
  mime: string
  /** 1-based progress counter for `hashing` / `uploading` stages. */
  current: number
  /** Aggregate progress fraction 0..1 for the visible `<progress>`. */
  progress: number
  errorDetail?: string
}

const INITIAL_FRAMES: FramesState = {
  stage: 'idle',
  files: [],
  mime: '',
  current: 0,
  progress: 0,
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
  let framesState: FramesState = INITIAL_FRAMES
  // Tab strip is only mounted for video-format datasets — that's
  // where image-sequence input is meaningful (the catalog encodes
  // every frames upload to a video HLS bundle). Image / tour
  // datasets see the single-file picker unchanged.
  let activeTab: UploaderTab = 'video'
  const tabsEnabled = options.format === 'video/mp4'

  function paint(): void {
    const frag = document.createDocumentFragment()
    if (tabsEnabled) {
      frag.appendChild(buildTabStrip())
    }
    if (tabsEnabled && activeTab === 'frames') {
      frag.appendChild(buildFramesBody(framesState))
    } else {
      frag.appendChild(buildBody(state))
    }
    root.replaceChildren(frag)
  }

  function buildTabStrip(): HTMLElement {
    const strip = document.createElement('div')
    strip.className = 'publisher-asset-uploader-tabs'
    strip.setAttribute('role', 'tablist')
    for (const tab of ['video', 'frames'] as UploaderTab[]) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className =
        'publisher-asset-uploader-tab' +
        (activeTab === tab ? ' publisher-asset-uploader-tab-active' : '')
      btn.setAttribute('role', 'tab')
      btn.setAttribute('aria-selected', activeTab === tab ? 'true' : 'false')
      btn.textContent = t(
        tab === 'video'
          ? 'publisher.assetUploader.tab.video'
          : 'publisher.assetUploader.tab.frames',
      )
      // Disable tab switching once an upload is in flight on
      // either side — flipping mid-upload would either lose the
      // in-flight state (frames → video) or risk firing a
      // duplicate dispatch (video → frames mid-transcode).
      const lockedSingle =
        state.stage !== 'idle' && state.stage !== 'error' && state.stage !== 'done-direct'
      const lockedFrames =
        framesState.stage !== 'idle' &&
        framesState.stage !== 'picked' &&
        framesState.stage !== 'error'
      btn.disabled = lockedSingle || lockedFrames
      btn.addEventListener('click', () => {
        if (activeTab === tab) return
        activeTab = tab
        paint()
      })
      strip.appendChild(btn)
    }
    return strip
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

  function buildFramesBody(s: FramesState): DocumentFragment {
    const frag = document.createDocumentFragment()

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

    // Multi-file picker — `multiple` attribute lets the publisher
    // select an entire directory of frames in one go. Same
    // disabled-while-busy rule as the single-file picker.
    const inputRow = document.createElement('div')
    inputRow.className = 'publisher-asset-uploader-input-row'
    const inputId = 'dataset-asset-frames'
    const label = document.createElement('label')
    label.className = 'publisher-asset-uploader-label'
    label.setAttribute('for', inputId)
    label.textContent = t('publisher.assetUploader.frames.pickFiles')
    inputRow.appendChild(label)

    const input = document.createElement('input')
    input.type = 'file'
    input.id = inputId
    input.multiple = true
    input.className = 'publisher-asset-uploader-input'
    input.accept = [...FRAME_MIME_ALLOWLIST].join(',') + ',.png,.jpg,.jpeg,.webp'
    input.disabled =
      s.stage !== 'idle' && s.stage !== 'picked' && s.stage !== 'error'
    input.addEventListener('change', () => {
      const picked = Array.from(input.files ?? [])
      if (picked.length === 0) return
      handleFramesPicked(picked)
    })
    inputRow.appendChild(input)
    frag.appendChild(inputRow)

    if (s.stage === 'picked' && s.files.length > 0) {
      // Summary line — frame count + total size. Per the Phase 3pf
      // plan, the thumbnail strip + manual-order textarea + display-
      // naming preview are deferred to a follow-up; v1 ships the
      // count + size as the minimum useful affordance.
      const total = s.files.reduce((sum, f) => sum + f.size, 0)
      const summary = document.createElement('p')
      summary.className = 'publisher-asset-uploader-frames-summary'
      summary.textContent = t('publisher.assetUploader.frames.frameCount', {
        count: String(s.files.length),
        size: formatBytes(total),
      })
      frag.appendChild(summary)

      const startBtn = document.createElement('button')
      startBtn.type = 'button'
      startBtn.className = 'publisher-button publisher-button-primary'
      startBtn.textContent = t('publisher.assetUploader.frames.startUpload', {
        count: String(s.files.length),
      })
      startBtn.addEventListener('click', () => {
        void runFrameSequence(s.files)
      })
      frag.appendChild(startBtn)
    }

    // Stage-specific status line.
    if (s.stage !== 'idle' && s.stage !== 'picked') {
      const status = document.createElement('p')
      status.className = `publisher-asset-uploader-status publisher-asset-uploader-status-${s.stage}`
      status.setAttribute('role', 'status')
      status.textContent = framesStatusText(s)
      frag.appendChild(status)
    }

    if (
      s.stage === 'hashing' ||
      s.stage === 'minting' ||
      s.stage === 'uploading' ||
      s.stage === 'completing'
    ) {
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

  function framesStatusText(s: FramesState): string {
    if (s.stage === 'hashing') {
      return t('publisher.assetUploader.frames.hashingProgress', {
        current: String(s.current),
        total: String(s.files.length),
      })
    }
    if (s.stage === 'uploading') {
      return t('publisher.assetUploader.frames.uploadingProgress', {
        current: String(s.current),
        total: String(s.files.length),
      })
    }
    if (s.stage === 'minting') return t('publisher.assetUploader.status.minting')
    if (s.stage === 'completing') return t('publisher.assetUploader.status.completing')
    if (s.stage === 'done-transcoding')
      return t('publisher.assetUploader.status.doneTranscoding')
    if (s.stage === 'error') return t('publisher.assetUploader.status.error')
    return ''
  }

  /**
   * Validate the picked file list (count + uniform mime), sort
   * lexicographically by filename, and move into the `picked`
   * stage so the publisher sees the count + a "Start upload"
   * button before any network call.
   */
  function handleFramesPicked(picked: File[]): void {
    if (picked.length > MAX_FRAMES) {
      framesState = {
        ...INITIAL_FRAMES,
        stage: 'error',
        errorDetail: t('publisher.assetUploader.frames.tooMany', {
          max: String(MAX_FRAMES),
        }),
      }
      paint()
      return
    }
    if (picked.length < 1) {
      framesState = {
        ...INITIAL_FRAMES,
        stage: 'error',
        errorDetail: t('publisher.assetUploader.frames.tooFew'),
      }
      paint()
      return
    }
    // Enforce uniform mime — ffmpeg's image-sequence demuxer
    // expects one extension across the sequence, and the
    // server-side `validateImageSequenceInit` rejects mixed mimes
    // anyway. Failing fast here saves the 30+ second hash budget.
    let firstMime = ''
    for (const f of picked) {
      const mime = f.type || mimeFromFilename(f.name)
      if (!FRAME_MIME_ALLOWLIST.has(mime)) {
        framesState = {
          ...INITIAL_FRAMES,
          stage: 'error',
          errorDetail: t('publisher.assetUploader.frames.unsupportedMime', {
            actual: mime || 'unknown',
          }),
        }
        paint()
        return
      }
      if (!firstMime) firstMime = mime
      else if (mime !== firstMime) {
        framesState = {
          ...INITIAL_FRAMES,
          stage: 'error',
          errorDetail: t('publisher.assetUploader.frames.mixedMime', {
            actual: mime,
            expected: firstMime,
          }),
        }
        paint()
        return
      }
    }
    // Aggregate-size cap mirrors the server's
    // `SIZE_IMAGE_SEQUENCE_TOTAL` (10 GB) so a publisher who picks
    // tens of GB of high-res PNGs fails fast rather than waiting
    // out the in-browser hash budget before the server rejects.
    const totalBytes = picked.reduce((sum, f) => sum + f.size, 0)
    if (totalBytes > MAX_TOTAL_BYTES) {
      framesState = {
        ...INITIAL_FRAMES,
        stage: 'error',
        errorDetail: t('publisher.assetUploader.frames.totalSizeExceeded', {
          actual: formatBytes(totalBytes),
          max: formatBytes(MAX_TOTAL_BYTES),
        }),
      }
      paint()
      return
    }
    // Lexicographic sort by filename. Deterministic encode order
    // for the typical `frame_00001.png … frame_99999.png` shape;
    // the manual-order textarea is a deferred follow-up for
    // publishers whose filenames don't naturally sort.
    const sorted = [...picked].sort((a, b) => a.name.localeCompare(b.name))
    framesState = {
      ...INITIAL_FRAMES,
      stage: 'picked',
      files: sorted,
      mime: firstMime,
    }
    paint()
  }

  /**
   * Drive the multi-frame upload: hash every frame, build the
   * canonical source-filenames JSON, POST /asset for the
   * presigned-URL bundle, parallel-bounded PUT every frame plus
   * the source-filenames blob, then POST /complete. Outcome is
   * always `transcoding` mode — frame-source uploads land at the
   * same /transcode-complete callback the MP4 path uses.
   */
  async function runFrameSequence(files: File[]): Promise<void> {
    if (!options.datasetId) {
      options.onMissingDataset?.()
      return
    }
    const total = files.length
    try {
      // 1. Hash every frame. Serial to keep the in-browser memory
      //    budget bounded (~8 MB peak per `hashFileSha256` call).
      framesState = {
        ...framesState,
        stage: 'hashing',
        current: 0,
        progress: 0,
      }
      paint()
      const frameDigests: Array<{ filename: string; digest: string; size: number }> = []
      for (let i = 0; i < files.length; i++) {
        const f = files[i]
        const digest = await (options.hashFn ?? hashFileSha256)(f)
        frameDigests.push({ filename: f.name, digest, size: f.size })
        framesState = {
          ...framesState,
          current: i + 1,
          progress: (i + 1) / total / 2, // hashing is ~half the perceived wait
        }
        paint()
      }

      // 2. Build canonical source-filenames JSON. Stable order +
      //    minimal whitespace so server-side hash agrees with the
      //    client hash bit-for-bit. The shape is documented at
      //    `docs/CATALOG_IMAGE_SEQUENCE_PLAN.md` §"Frames as data".
      const sourceFilenames = frameDigests.map((f, index) => ({
        index,
        filename: f.filename,
      }))
      const sourceFilenamesJson = JSON.stringify(sourceFilenames)
      const sourceFilenamesDigest = await sha256OfString(sourceFilenamesJson)

      // 3. Mint presigned PUTs.
      framesState = { ...framesState, stage: 'minting', progress: 0.5 }
      paint()
      const totalSize = frameDigests.reduce((sum, f) => sum + f.size, 0)
      const initResult = await publisherSend<ImageSequenceInitResponse>(
        `/api/v1/publish/datasets/${encodeURIComponent(options.datasetId)}/asset`,
        {
          kind: 'data',
          // Use the mime resolved + asserted-uniform during
          // handleFramesPicked, not a re-derivation from
          // files[0].type — by here we already know every file's
          // mime matches and is in the allowlist. (The prior
          // fallback to `'image/png'` could mask an invariant
          // violation by sending a wrong mime to the server.)
          mime: framesState.mime,
          frames: frameDigests,
          size: totalSize,
          source_filenames_digest: sourceFilenamesDigest,
        },
        { fetchFn: options.fetchFn, sleep: options.sleep },
      )
      if (!initResult.ok) {
        return failFrames('mint', initResult)
      }
      clearWarmupFlag()
      const init = initResult.data

      // 4. PUT every frame + the source-filenames blob.
      //    Parallel-bounded so the browser doesn't open more
      //    concurrent connections than the per-host cap.
      if (!init.mock) {
        framesState = {
          ...framesState,
          stage: 'uploading',
          current: 0,
          progress: 0.5,
        }
        paint()
        const uploadJobs: Array<() => Promise<void>> = []
        for (let i = 0; i < init.frames.length; i++) {
          const mint = init.frames[i]
          const file = files[i]
          uploadJobs.push(async () => {
            await putWithProgress(
              { method: mint.method, url: mint.url, headers: mint.headers },
              file,
              () => {
                /* per-frame progress isn't shown — N progress bars
                   would be unusable; the aggregate counter ticks
                   on completion only. */
              },
              options.xhrFactory,
            )
            // Stage-guard: a sibling worker may have failed and
            // transitioned `framesState` into `'error'` while this
            // PUT was mid-flight (`runBoundedQueue`'s
            // first-failure-wins only stops workers BETWEEN
            // iterations; the await above can still resolve after
            // the error transition). Mutating `current` / `progress`
            // on top of the error state would surface as a stale
            // counter overwriting the error banner, so skip the
            // update unless the stage is still 'uploading'.
            if (framesState.stage !== 'uploading') return
            framesState = {
              ...framesState,
              current: framesState.current + 1,
              progress: 0.5 + (framesState.current + 1) / total / 2,
            }
            paint()
          })
        }
        await runBoundedQueue(uploadJobs, FRAME_UPLOAD_CONCURRENCY)
        // PUT the source-filenames blob alongside. JSON body, so
        // we don't bother with XHR-progress — it's <1 MB and
        // completes in one round-trip on a typical uplink.
        // Honour `options.fetchFn` (defaults to globalThis.fetch)
        // so tests can capture the request without touching the
        // network, mirroring how `publisherSend` resolves its
        // fetch implementation.
        //
        // Retry on transient failure: if this PUT fails after
        // every frame has already landed, the publisher is in a
        // strictly worse spot than a frame failure — the frames
        // are sitting in R2, the asset_uploads row is still
        // `'pending'`, and re-picking files mints a fresh
        // upload_id leaving the prior frames orphaned. Two
        // retries with short backoffs absorb a network blip;
        // beyond that we surface the error and the publisher's
        // recovery is re-pick (the orphan-frames cost is bounded
        // by the per-upload R2 prefix's lifecycle policy).
        const blob = new Blob([sourceFilenamesJson], { type: 'application/json' })
        const blobFetch = options.fetchFn ?? globalThis.fetch
        const blobSleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
        let blobErr: Error | null = null
        for (let attempt = 0; attempt < 3; attempt++) {
          blobErr = null
          try {
            const blobRes = await blobFetch(init.source_filenames.url, {
              method: init.source_filenames.method,
              headers: init.source_filenames.headers,
              body: blob,
            })
            if (blobRes.ok) {
              blobErr = null
              break
            }
            blobErr = new Error(`source-filenames PUT returned ${blobRes.status}`)
          } catch (err) {
            blobErr = err instanceof Error ? err : new Error(String(err))
          }
          if (attempt < 2) await blobSleep(200 * (attempt + 1))
        }
        if (blobErr) throw blobErr
      }

      // 5. Finalize.
      framesState = { ...framesState, stage: 'completing', progress: 1 }
      paint()
      const completeResult = await publisherSend<AssetCompleteResponse>(
        `/api/v1/publish/datasets/${encodeURIComponent(options.datasetId)}/asset/${init.upload_id}/complete`,
        {},
        { fetchFn: options.fetchFn, sleep: options.sleep },
      )
      if (!completeResult.ok) {
        return failFrames('complete', completeResult)
      }
      framesState = { ...framesState, stage: 'done-transcoding', progress: 1 }
      paint()
      // Frame-source completion always lands in transcoding mode —
      // the dispatch fires alongside the stamp.
      options.onUploaded({ mode: 'transcoding' })
    } catch (err) {
      framesState = {
        ...framesState,
        stage: 'error',
        errorDetail: err instanceof Error ? err.message : String(err),
      }
      paint()
    }
  }

  function failFrames<T>(
    stage: 'mint' | 'complete',
    result: PublisherSendResult<T>,
  ): void {
    if (result.ok) return
    if (result.kind === 'session') {
      if (handleSessionError({ navigate: options.navigate }) === 'show-error') {
        framesState = {
          ...framesState,
          stage: 'error',
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
    framesState = { ...framesState, stage: 'error', errorDetail: detail }
    paint()
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
/** Wire shape of the publisher API's image-sequence /asset
 *  response (Phase 3pf). Mirrors the type returned by the
 *  route handler in `functions/api/v1/publish/datasets/[id]/asset.ts`. */
interface ImageSequenceInitResponse {
  upload_id: string
  kind: 'data'
  target: 'r2'
  frames: Array<{
    filename: string
    index: number
    method: 'PUT'
    url: string
    headers: Record<string, string>
    key: string
  }>
  source_filenames: {
    method: 'PUT'
    url: string
    headers: Record<string, string>
    key: string
  }
  expires_at: string
  mock: boolean
}

/** SHA-256 of a JS string (UTF-8 bytes). Returns `sha256:<hex>`
 *  to match the publisher API's claimed-digest format. Used for
 *  the canonical source-filenames JSON the publisher PUTs as a
 *  sibling of the frames; the GHA runner re-verifies. */
async function sha256OfString(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s)
  const buf = await crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return `sha256:${hex}`
}

/** Format bytes for the frame-summary line. Same shape as the
 *  publisher API's `formatBytes` in `asset-uploads.ts` so the
 *  client and server agree on cap-message wording. */
function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

/** Run a list of async jobs through a bounded-concurrency pool.
 *  The worker functions are invoked in order but resolve in
 *  whatever order the network returns. First-failure aborts the
 *  remaining workers — same pattern the runner-side
 *  `downloadFrames` uses. */
async function runBoundedQueue(
  jobs: Array<() => Promise<void>>,
  concurrency: number,
): Promise<void> {
  let cursor = 0
  let firstError: Error | null = null
  async function worker(): Promise<void> {
    while (firstError === null) {
      const i = cursor++
      if (i >= jobs.length) return
      try {
        await jobs[i]()
      } catch (err) {
        if (firstError === null) {
          firstError = err instanceof Error ? err : new Error(String(err))
        }
        return
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  if (firstError) throw firstError
}

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
