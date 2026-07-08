import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashFileSha256, renderAssetUploader } from './asset-uploader'
import { ROUTE_CHANGE_START_EVENT } from '../router'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function pickFile(mount: HTMLElement, mime: string, body = 'bytes'): void {
  const input = mount.querySelector<HTMLInputElement>('input[type="file"]')!
  const file = new File([body], 'video.mp4', { type: mime })
  Object.defineProperty(input, 'files', {
    value: { 0: file, length: 1, item: (i: number) => (i === 0 ? file : null) } as unknown as FileList,
    configurable: true,
  })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

// A minimal XHR stand-in that fires `load` after a synthetic
// upload-progress sequence, mirroring the shape the uploader
// component listens for. Returns a factory so each test gets a
// fresh instance.
function fakeXhrFactory(opts: { status?: number; progressSteps?: number[] } = {}) {
  const status = opts.status ?? 204
  const progressSteps = opts.progressSteps ?? [0.25, 0.5, 0.75, 1]
  return () => {
    const upload = {
      listeners: new Map<string, Array<(ev: ProgressEvent) => void>>(),
      addEventListener(type: string, fn: (ev: ProgressEvent) => void) {
        const list = this.listeners.get(type) ?? []
        list.push(fn)
        this.listeners.set(type, list)
      },
    }
    const xhr = {
      upload,
      status: 0,
      responseText: '',
      listeners: new Map<string, Array<() => void>>(),
      open() {},
      setRequestHeader() {},
      addEventListener(type: string, fn: () => void) {
        const list = this.listeners.get(type) ?? []
        list.push(fn)
        this.listeners.set(type, list)
      },
      send() {
        // Fire progress events first, then load.
        queueMicrotask(() => {
          for (const fraction of progressSteps) {
            for (const fn of upload.listeners.get('progress') ?? []) {
              fn({ lengthComputable: true, loaded: fraction * 100, total: 100 } as ProgressEvent)
            }
          }
          xhr.status = status
          for (const fn of xhr.listeners.get('load') ?? []) fn()
        })
      },
    }
    return xhr as unknown as XMLHttpRequest
  }
}

describe('renderAssetUploader', () => {
  let mount: HTMLDivElement

  beforeEach(() => {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    sessionStorage.clear()
  })

  it('renders an idle status and the current ref when one is supplied', () => {
    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        format: 'video/mp4',
        currentDataRef: 'r2:videos/01ABC/master.m3u8',
        onUploaded: () => {},
      }),
    )
    expect(mount.textContent).toContain('Current reference:')
    expect(mount.textContent).toContain('r2:videos/01ABC/master.m3u8')
    expect(mount.querySelector('.publisher-asset-uploader-status')?.textContent).toBe(
      'Choose a file to upload.',
    )
  })

  it('refuses a file whose mime doesn’t match the dataset format', async () => {
    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        format: 'video/mp4',
        onUploaded: () => {},
        hashFn: async () => 'sha256:' + 'a'.repeat(64),
        fetchFn: vi.fn() as unknown as typeof fetch,
      }),
    )
    pickFile(mount, 'image/png')
    await new Promise(r => setTimeout(r, 0))
    expect(mount.querySelector('.publisher-asset-uploader-status-error')?.textContent).toBe(
      'Upload failed.',
    )
    expect(mount.textContent).toContain("doesn't match the dataset's declared format")
  })

  it('runs hash → mint → upload → complete and reports a transcoding outcome on video', async () => {
    const onUploaded = vi.fn()
    const fetchFn = vi
      .fn()
      // /asset — mint presigned PUT
      .mockResolvedValueOnce(
        jsonResponse(
          {
            upload_id: 'UP-1',
            kind: 'data',
            target: 'r2',
            r2: { method: 'PUT', url: 'https://r2.example/put', headers: {}, key: 'uploads/X' },
            expires_at: 'soon',
            mock: false,
          },
          201,
        ),
      )
      // /complete — video → transcoding
      .mockResolvedValueOnce(
        jsonResponse({ dataset: { data_ref: '' }, transcoding: true }, 202),
      )

    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        format: 'video/mp4',
        onUploaded,
        hashFn: async () => 'sha256:' + 'a'.repeat(64),
        fetchFn: fetchFn as unknown as typeof fetch,
        xhrFactory: fakeXhrFactory(),
      }),
    )

    pickFile(mount, 'video/mp4', 'mock-mp4-bytes')
    // microtask + queueMicrotask + a couple of awaits to settle
    for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))

    expect(onUploaded).toHaveBeenCalledWith({ mode: 'transcoding' })
    expect(mount.textContent).toContain('Transcoding the video')
    // Two fetches: /asset + /complete.
    expect(fetchFn).toHaveBeenCalledTimes(2)
    const firstUrl = fetchFn.mock.calls[0][0]
    expect(firstUrl).toContain('/api/v1/publish/datasets/01AAAAAAAAAAAAAAAAAAAAAAAA/asset')
    const secondUrl = fetchFn.mock.calls[1][0]
    expect(secondUrl).toContain('/asset/UP-1/complete')
  })

  it('reports a direct outcome for non-video uploads', async () => {
    const onUploaded = vi.fn()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            upload_id: 'UP-2',
            kind: 'data',
            target: 'r2',
            r2: { method: 'PUT', url: 'https://r2.example/put', headers: {}, key: 'k' },
            expires_at: 'soon',
            mock: false,
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ dataset: { data_ref: 'r2:datasets/X/by-digest/.../asset.png' } }),
      )

    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        format: 'image/png',
        onUploaded,
        hashFn: async () => 'sha256:' + 'b'.repeat(64),
        fetchFn: fetchFn as unknown as typeof fetch,
        xhrFactory: fakeXhrFactory(),
      }),
    )

    pickFile(mount, 'image/png', 'mock-png-bytes')
    for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))

    expect(onUploaded).toHaveBeenCalledWith({
      mode: 'direct',
      dataRef: 'r2:datasets/X/by-digest/.../asset.png',
    })
  })

  it('normalizes image/jpg → image/jpeg before mint so the server allowlist matches', async () => {
    // PR #112 followup — a few legacy browsers stamp
    // `image/jpg` on JPEG files. mimeAcceptedForFormat accepts
    // both as matching a JPEG-format dataset, but the server's
    // /asset init allowlist only takes the canonical
    // `image/jpeg`. The client now normalises before sending so
    // the gate and the request body agree, avoiding the
    // "passes client validation, fails at mint" dead-end.
    const onUploaded = vi.fn()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            upload_id: 'UP-JPG',
            kind: 'data',
            target: 'r2',
            r2: { method: 'PUT', url: 'https://r2.example/put', headers: {}, key: 'k' },
            expires_at: 'soon',
            mock: false,
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ dataset: { data_ref: 'r2:datasets/X/by-digest/.../asset.jpg' } }),
      )

    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        format: 'image/jpeg',
        onUploaded,
        hashFn: async () => 'sha256:' + 'c'.repeat(64),
        fetchFn: fetchFn as unknown as typeof fetch,
        xhrFactory: fakeXhrFactory(),
      }),
    )

    pickFile(mount, 'image/jpg', 'mock-jpeg-bytes')
    for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))

    // Mint call body uses image/jpeg (the canonical form), not
    // the file's reported image/jpg.
    const mintCall = fetchFn.mock.calls[0]
    const mintBody = JSON.parse(mintCall[1].body as string) as { mime: string }
    expect(mintBody.mime).toBe('image/jpeg')
    // And the upload succeeded end-to-end (direct outcome).
    expect(onUploaded).toHaveBeenCalledWith({
      mode: 'direct',
      dataRef: 'r2:datasets/X/by-digest/.../asset.jpg',
    })
  })

  it('skips the XHR PUT when the mint response is mock=true', async () => {
    const xhrFactory = vi.fn(fakeXhrFactory())
    const onUploaded = vi.fn()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            upload_id: 'UP-3',
            kind: 'data',
            target: 'r2',
            r2: { method: 'PUT', url: 'https://mock-r2.localhost/put', headers: {}, key: 'k' },
            expires_at: 'soon',
            mock: true,
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ dataset: { data_ref: 'r2:datasets/X/asset.png' } }),
      )

    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        format: 'image/png',
        onUploaded,
        hashFn: async () => 'sha256:' + 'c'.repeat(64),
        fetchFn: fetchFn as unknown as typeof fetch,
        xhrFactory,
      }),
    )

    pickFile(mount, 'image/png')
    for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))

    expect(xhrFactory).not.toHaveBeenCalled()
    expect(onUploaded).toHaveBeenCalled()
  })

  it('mints the draft lazily via ensureDatasetId when no id is set (create single-step)', async () => {
    // Create form: the uploader is mounted with an empty datasetId +
    // an `ensureDatasetId` that saves the draft on first file pick.
    // The subsequent /asset + /complete calls must target the
    // freshly-minted id.
    const onUploaded = vi.fn()
    const ensureDatasetId = vi.fn().mockResolvedValue('01NEWDRAFTIDNEWDRAFTIDNEW')
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            upload_id: 'UP-NEW',
            kind: 'data',
            target: 'r2',
            r2: { method: 'PUT', url: 'https://r2.example/put', headers: {}, key: 'k' },
            expires_at: 'soon',
            mock: true,
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ dataset: { data_ref: 'r2:datasets/NEW/asset.png' } }),
      )

    mount.appendChild(
      renderAssetUploader({
        datasetId: '',
        ensureDatasetId,
        format: 'image/png',
        onUploaded,
        hashFn: async () => 'sha256:' + 'd'.repeat(64),
        fetchFn: fetchFn as unknown as typeof fetch,
        xhrFactory: fakeXhrFactory(),
      }),
    )

    pickFile(mount, 'image/png', 'mock-png-bytes')
    for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))

    expect(ensureDatasetId).toHaveBeenCalledTimes(1)
    // The mint targets the id ensureDatasetId returned.
    const mintUrl = fetchFn.mock.calls[0][0]
    expect(mintUrl).toContain('/api/v1/publish/datasets/01NEWDRAFTIDNEWDRAFTIDNEW/asset')
    expect(onUploaded).toHaveBeenCalledWith({
      mode: 'direct',
      dataRef: 'r2:datasets/NEW/asset.png',
    })
  })

  it('aborts the upload (no /asset call) when ensureDatasetId cannot save the draft', async () => {
    // e.g. the title is missing — the parent form surfaces the
    // validation error and ensureDatasetId resolves null. The
    // uploader must not attempt a mint against an empty id.
    const onUploaded = vi.fn()
    const ensureDatasetId = vi.fn().mockResolvedValue(null)
    const fetchFn = vi.fn()

    mount.appendChild(
      renderAssetUploader({
        datasetId: '',
        ensureDatasetId,
        format: 'image/png',
        onUploaded,
        hashFn: async () => 'sha256:' + 'e'.repeat(64),
        fetchFn: fetchFn as unknown as typeof fetch,
        xhrFactory: fakeXhrFactory(),
      }),
    )

    pickFile(mount, 'image/png', 'mock-png-bytes')
    for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))

    expect(ensureDatasetId).toHaveBeenCalledTimes(1)
    expect(fetchFn).not.toHaveBeenCalled()
    expect(onUploaded).not.toHaveBeenCalled()
  })
})

describe('renderAssetUploader — auxiliary kinds (thumbnail / legend)', () => {
  let mount: HTMLDivElement

  beforeEach(() => {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    sessionStorage.clear()
  })

  it('never mounts the frames tab strip for an aux kind, even on a video dataset', () => {
    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'thumbnail',
        // A thumbnail can ride on a video dataset — the tab strip
        // must still stay hidden (image-sequence input is data-only).
        format: 'video/mp4',
        onUploaded: () => {},
      }),
    )
    expect(mount.querySelector('.publisher-asset-uploader-tabs')).toBeNull()
    expect(mount.querySelector('input[id^="dataset-asset-file-"]')).not.toBeNull()
  })

  it('accepts an image regardless of the dataset format and reports an aux outcome', async () => {
    const onUploaded = vi.fn()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            upload_id: 'UP-THUMB',
            kind: 'thumbnail',
            target: 'r2',
            r2: { method: 'PUT', url: 'https://r2.example/put', headers: {}, key: 'k' },
            expires_at: 'soon',
            mock: false,
          },
          201,
        ),
      )
      // /complete stamps thumbnail_ref (no data_ref, no transcoding).
      .mockResolvedValueOnce(
        jsonResponse({ dataset: { thumbnail_ref: 'r2:datasets/X/by-digest/aa/thumbnail.png' } }),
      )

    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'thumbnail',
        // Dataset's primary format is video — the thumbnail upload
        // must still accept a PNG.
        format: 'video/mp4',
        onUploaded,
        hashFn: async () => 'sha256:' + 'd'.repeat(64),
        fetchFn: fetchFn as unknown as typeof fetch,
        xhrFactory: fakeXhrFactory(),
      }),
    )

    pickFile(mount, 'image/png', 'mock-png-bytes')
    for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))

    // The mint body carried kind=thumbnail, not data.
    const mintBody = JSON.parse(fetchFn.mock.calls[0][1].body as string) as { kind: string }
    expect(mintBody.kind).toBe('thumbnail')
    expect(onUploaded).toHaveBeenCalledWith({
      mode: 'aux',
      kind: 'thumbnail',
      ref: 'r2:datasets/X/by-digest/aa/thumbnail.png',
    })
  })

  it('reads legend_ref from the complete response for a legend upload', async () => {
    const onUploaded = vi.fn()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            upload_id: 'UP-LEGEND',
            kind: 'legend',
            target: 'r2',
            r2: { method: 'PUT', url: 'https://r2.example/put', headers: {}, key: 'k' },
            expires_at: 'soon',
            mock: false,
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ dataset: { legend_ref: 'r2:datasets/X/by-digest/bb/legend.webp' } }),
      )

    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'legend',
        format: 'image/png',
        onUploaded,
        hashFn: async () => 'sha256:' + 'e'.repeat(64),
        fetchFn: fetchFn as unknown as typeof fetch,
        xhrFactory: fakeXhrFactory(),
      }),
    )

    pickFile(mount, 'image/webp', 'mock-webp-bytes')
    for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))

    expect(onUploaded).toHaveBeenCalledWith({
      mode: 'aux',
      kind: 'legend',
      ref: 'r2:datasets/X/by-digest/bb/legend.webp',
    })
  })

  it('errors instead of reporting success when the complete response omits the ref', async () => {
    // PR #207 Copilot review — a 200 complete with no stamped ref
    // must surface as a failure, not a false success that sets the
    // form ref to an empty string.
    const onUploaded = vi.fn()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            upload_id: 'UP-NOREF',
            kind: 'thumbnail',
            target: 'r2',
            r2: { method: 'PUT', url: 'https://r2.example/put', headers: {}, key: 'k' },
            expires_at: 'soon',
            mock: false,
          },
          201,
        ),
      )
      // /complete returns 200 but without thumbnail_ref.
      .mockResolvedValueOnce(jsonResponse({ dataset: {} }))

    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'thumbnail',
        format: 'image/png',
        onUploaded,
        hashFn: async () => 'sha256:' + 'a'.repeat(64),
        fetchFn: fetchFn as unknown as typeof fetch,
        xhrFactory: fakeXhrFactory(),
      }),
    )

    pickFile(mount, 'image/png', 'mock-png-bytes')
    for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))

    expect(onUploaded).not.toHaveBeenCalled()
    expect(mount.querySelector('.publisher-asset-uploader-status-error')).not.toBeNull()
    expect(mount.textContent).toContain("didn't return a saved reference")
  })

  it('renders the globe-thumbnail generator only for the thumbnail kind', () => {
    // Legend uploader: no generator block.
    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'legend',
        format: 'image/png',
        onUploaded: () => {},
      }),
    )
    expect(mount.querySelector('.publisher-asset-uploader-generate')).toBeNull()
    // Thumbnail uploader: generator block present.
    mount.replaceChildren(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'thumbnail',
        format: 'image/png',
        onUploaded: () => {},
      }),
    )
    expect(mount.querySelector('.publisher-asset-uploader-generate')).not.toBeNull()
  })

  it('hides the "from this dataset’s data" button unless a data URL is supplied', () => {
    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'thumbnail',
        format: 'image/png',
        onUploaded: () => {},
      }),
    )
    expect(mount.textContent).not.toContain('Generate from this dataset')
    // Manual 2:1 frame picker is always offered.
    expect(mount.querySelector('input[id^="dataset-asset-generate-"]')).not.toBeNull()

    mount.replaceChildren(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'thumbnail',
        format: 'image/png',
        dataAssetUrl: 'https://cdn.example/data.png',
        onUploaded: () => {},
      }),
    )
    expect(mount.textContent).toContain('Generate from this dataset')
  })

  it('generates a preview from a picked 2:1 frame, then uploads it on confirm', async () => {
    const onUploaded = vi.fn()
    const generated = new Blob(['globe'], { type: 'image/webp' })
    const generateThumbnail = vi.fn().mockResolvedValue(generated)
    const decodeImage = vi
      .fn()
      .mockResolvedValue({ width: 2048, height: 1024 } as unknown as HTMLImageElement)
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            upload_id: 'UP-GEN',
            kind: 'thumbnail',
            target: 'r2',
            r2: { method: 'PUT', url: 'https://r2.example/put', headers: {}, key: 'k' },
            expires_at: 'soon',
            mock: false,
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ dataset: { thumbnail_ref: 'r2:datasets/X/by-digest/cc/thumbnail.webp' } }),
      )

    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'thumbnail',
        format: 'image/png',
        onUploaded,
        hashFn: async () => 'sha256:' + 'a'.repeat(64),
        fetchFn: fetchFn as unknown as typeof fetch,
        xhrFactory: fakeXhrFactory(),
        generateThumbnail,
        decodeImage,
      }),
    )

    // Pick a frame in the generator's file input.
    const genInput = mount.querySelector<HTMLInputElement>(
      'input[id^="dataset-asset-generate-"]',
    )!
    const frame = new File(['frame'], 'frame.png', { type: 'image/png' })
    Object.defineProperty(genInput, 'files', {
      value: { 0: frame, length: 1, item: (i: number) => (i === 0 ? frame : null) },
      configurable: true,
    })
    genInput.dispatchEvent(new Event('change', { bubbles: true }))
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0))

    // Decode + render ran; a preview is shown.
    expect(decodeImage).toHaveBeenCalledOnce()
    expect(generateThumbnail).toHaveBeenCalledOnce()
    expect(mount.querySelector('.publisher-asset-uploader-generate-preview')).not.toBeNull()
    // No upload yet — the publisher hasn't confirmed.
    expect(fetchFn).not.toHaveBeenCalled()

    // Confirm — "Use this thumbnail" uploads the generated capture
    // through the normal aux path.
    const useBtn = Array.from(mount.querySelectorAll('button')).find(
      b => b.textContent === 'Use this thumbnail',
    )!
    useBtn.click()
    for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))

    const mintBody = JSON.parse(fetchFn.mock.calls[0][1].body as string) as { kind: string }
    expect(mintBody.kind).toBe('thumbnail')
    expect(onUploaded).toHaveBeenCalledWith({
      mode: 'aux',
      kind: 'thumbnail',
      ref: 'r2:datasets/X/by-digest/cc/thumbnail.webp',
    })
  })

  it('re-renders the preview with the new rotation when a slider is moved', async () => {
    const generated = new Blob(['globe'], { type: 'image/webp' })
    const generateThumbnail = vi.fn().mockResolvedValue(generated)
    const decodeImage = vi
      .fn()
      .mockResolvedValue({ width: 2048, height: 1024 } as unknown as HTMLImageElement)

    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'thumbnail',
        format: 'image/png',
        onUploaded: () => {},
        generateThumbnail,
        decodeImage,
      }),
    )

    // Generate an initial preview.
    const genInput = mount.querySelector<HTMLInputElement>(
      'input[id^="dataset-asset-generate-"][type="file"]',
    )!
    const frame = new File(['frame'], 'frame.png', { type: 'image/png' })
    Object.defineProperty(genInput, 'files', {
      value: { 0: frame, length: 1, item: (i: number) => (i === 0 ? frame : null) },
      configurable: true,
    })
    genInput.dispatchEvent(new Event('change', { bubbles: true }))
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0))

    expect(generateThumbnail).toHaveBeenCalledTimes(1)
    // First render is at the default orientation.
    expect(generateThumbnail.mock.calls[0][1]).toMatchObject({ lonOrigin: 0, latOrigin: 0 })

    // Drag the longitude slider and release.
    const lonSlider = mount.querySelector<HTMLInputElement>(
      'input[type="range"][id$="-lon"]',
    )!
    lonSlider.value = '120'
    lonSlider.dispatchEvent(new Event('input', { bubbles: true }))
    lonSlider.dispatchEvent(new Event('change', { bubbles: true }))
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0))

    // Re-rendered at the new longitude, reusing the decoded source
    // (no second decode).
    expect(generateThumbnail).toHaveBeenCalledTimes(2)
    expect(generateThumbnail.mock.calls[1][1]).toMatchObject({ lonOrigin: 120, latOrigin: 0 })
    expect(decodeImage).toHaveBeenCalledTimes(1)
  })

  it('generates from the dataset data URL when the one-click button is used', async () => {
    const generated = new Blob(['globe'], { type: 'image/webp' })
    const generateThumbnail = vi.fn().mockResolvedValue(generated)
    const decodeImage = vi
      .fn()
      .mockResolvedValue({ width: 2048, height: 1024 } as unknown as HTMLImageElement)
    const fetchImageBlob = vi
      .fn()
      .mockResolvedValue(new Blob(['data'], { type: 'image/png' }))

    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'thumbnail',
        format: 'image/png',
        dataAssetUrl: 'https://cdn.example/data.png',
        onUploaded: () => {},
        generateThumbnail,
        decodeImage,
        fetchImageBlob,
      }),
    )

    const fromDataBtn = Array.from(mount.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Generate from this dataset'),
    )!
    fromDataBtn.click()
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0))

    expect(fetchImageBlob).toHaveBeenCalledWith('https://cdn.example/data.png')
    expect(generateThumbnail).toHaveBeenCalledOnce()
    expect(mount.querySelector('.publisher-asset-uploader-generate-preview')).not.toBeNull()
  })

  it('lets a video dataset capture a frame from its own stream and renders a thumbnail', async () => {
    const generated = new Blob(['globe'], { type: 'image/webp' })
    const generateThumbnail = vi.fn().mockResolvedValue(generated)
    const capturedCanvas = document.createElement('canvas')
    const dispose = vi.fn()
    const fakeVideo = document.createElement('video')
    const loadVideoScrub = vi.fn().mockResolvedValue({
      video: fakeVideo,
      capture: () => capturedCanvas,
      dispose,
    })

    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'thumbnail',
        format: 'video/mp4',
        dataAssetUrl: 'https://assets.example/master.m3u8',
        onUploaded: () => {},
        generateThumbnail,
        loadVideoScrub,
      }),
    )

    // One-click "Generate from this dataset's data" → loads the stream.
    Array.from(mount.querySelectorAll('button'))
      .find(b => b.textContent?.includes('Generate from this dataset'))!
      .click()
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0))

    expect(loadVideoScrub).toHaveBeenCalledWith('https://assets.example/master.m3u8')
    // The scrub UI mounts the video + a Capture button.
    expect(mount.contains(fakeVideo)).toBe(true)
    const captureBtn = Array.from(mount.querySelectorAll('button')).find(
      b => b.textContent === 'Capture this frame',
    )!
    expect(captureBtn).toBeTruthy()

    // Capturing renders a globe thumbnail from the grabbed frame and
    // tears the stream down.
    captureBtn.click()
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0))

    expect(generateThumbnail).toHaveBeenCalledOnce()
    expect(generateThumbnail.mock.calls[0][0]).toBe(capturedCanvas)
    expect(dispose).toHaveBeenCalled()
    expect(mount.querySelector('.publisher-asset-uploader-generate-preview')).not.toBeNull()
  })

  it('disposes a video stream that finishes loading after a route change', async () => {
    // A slow HLS load that resolves only after the publisher has
    // navigated away must NOT re-attach a live stream — it should be
    // disposed. PR #208 Copilot review (in-flight scrub load).
    const dispose = vi.fn()
    let resolveLoad: (h: unknown) => void = () => {}
    const loadVideoScrub = vi.fn(
      () => new Promise(res => { resolveLoad = res }),
    ) as unknown as (url: string) => Promise<never>

    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'thumbnail',
        format: 'video/mp4',
        dataAssetUrl: 'https://assets.example/master.m3u8',
        onUploaded: () => {},
        loadVideoScrub,
      }),
    )
    Array.from(mount.querySelectorAll('button'))
      .find(b => b.textContent?.includes('Generate from this dataset'))!
      .click()
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0))

    // Navigate away while still "Loading video…".
    window.dispatchEvent(new Event(ROUTE_CHANGE_START_EVENT))
    // Now the load resolves — too late.
    resolveLoad({ video: document.createElement('video'), capture: () => document.createElement('canvas'), dispose })
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0))

    expect(dispose).toHaveBeenCalled()
    expect(mount.querySelector('.publisher-asset-uploader-generate-video')).toBeNull()
  })

  it('disposes the video stream when the scrub is cancelled', async () => {
    const dispose = vi.fn()
    const loadVideoScrub = vi.fn().mockResolvedValue({
      video: document.createElement('video'),
      capture: () => document.createElement('canvas'),
      dispose,
    })
    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'thumbnail',
        format: 'video/mp4',
        dataAssetUrl: 'https://assets.example/master.m3u8',
        onUploaded: () => {},
        loadVideoScrub,
      }),
    )
    Array.from(mount.querySelectorAll('button'))
      .find(b => b.textContent?.includes('Generate from this dataset'))!
      .click()
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0))
    Array.from(mount.querySelectorAll('button'))
      .find(b => b.textContent === 'Cancel')!
      .click()
    expect(dispose).toHaveBeenCalled()
    expect(mount.querySelector('.publisher-asset-uploader-generate-video')).toBeNull()
  })

  it('forwards the dataset render hints (overlay) when generating from its own data', async () => {
    const generated = new Blob(['globe'], { type: 'image/webp' })
    const generateThumbnail = vi.fn().mockResolvedValue(generated)
    const decodeImage = vi
      .fn()
      .mockResolvedValue({ width: 2048, height: 1024 } as unknown as HTMLImageElement)
    const fetchImageBlob = vi.fn().mockResolvedValue(new Blob(['data'], { type: 'image/png' }))
    const overlay = { boundingBox: { n: 60, s: 20, w: -10, e: 30 }, isFlippedInY: true }

    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'thumbnail',
        format: 'image/png',
        dataAssetUrl: 'https://cdn.example/data.png',
        dataAssetOverlay: overlay,
        onUploaded: () => {},
        generateThumbnail,
        decodeImage,
        fetchImageBlob,
      }),
    )

    Array.from(mount.querySelectorAll('button'))
      .find(b => b.textContent?.includes('Generate from this dataset'))!
      .click()
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0))

    expect(generateThumbnail).toHaveBeenCalled()
    expect(generateThumbnail.mock.calls[0][1]).toMatchObject({ overlay })
  })

  it('does NOT apply the dataset overlay to a hand-picked frame', async () => {
    const generated = new Blob(['globe'], { type: 'image/webp' })
    const generateThumbnail = vi.fn().mockResolvedValue(generated)
    const decodeImage = vi
      .fn()
      .mockResolvedValue({ width: 2048, height: 1024 } as unknown as HTMLImageElement)

    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'thumbnail',
        format: 'image/png',
        // A regional overlay exists on the dataset, but the publisher
        // picks an arbitrary frame — its projection is unknown, so the
        // overlay must NOT be applied.
        dataAssetOverlay: { boundingBox: { n: 60, s: 20, w: -10, e: 30 } },
        onUploaded: () => {},
        generateThumbnail,
        decodeImage,
      }),
    )

    const genInput = mount.querySelector<HTMLInputElement>(
      'input[id^="dataset-asset-generate-"][type="file"]',
    )!
    const frame = new File(['frame'], 'frame.png', { type: 'image/png' })
    Object.defineProperty(genInput, 'files', {
      value: { 0: frame, length: 1, item: (i: number) => (i === 0 ? frame : null) },
      configurable: true,
    })
    genInput.dispatchEvent(new Event('change', { bubbles: true }))
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0))

    expect(generateThumbnail).toHaveBeenCalled()
    expect(generateThumbnail.mock.calls[0][1]?.overlay).toBeUndefined()
  })

  it('surfaces a generator error without uploading', async () => {
    const generateThumbnail = vi.fn().mockRejectedValue(new Error('render failed'))
    const decodeImage = vi
      .fn()
      .mockResolvedValue({ width: 2048, height: 1024 } as unknown as HTMLImageElement)
    const fetchFn = vi.fn()

    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'thumbnail',
        format: 'image/png',
        onUploaded: () => {},
        fetchFn: fetchFn as unknown as typeof fetch,
        generateThumbnail,
        decodeImage,
      }),
    )

    const genInput = mount.querySelector<HTMLInputElement>(
      'input[id^="dataset-asset-generate-"]',
    )!
    const frame = new File(['frame'], 'frame.png', { type: 'image/png' })
    Object.defineProperty(genInput, 'files', {
      value: { 0: frame, length: 1, item: (i: number) => (i === 0 ? frame : null) },
      configurable: true,
    })
    genInput.dispatchEvent(new Event('change', { bubbles: true }))
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0))

    expect(mount.querySelector('.publisher-asset-uploader-generate .publisher-asset-uploader-status-error')).not.toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('disables "Use this thumbnail" while a rotation re-render is in flight', async () => {
    const g1 = new Blob(['g1'], { type: 'image/webp' })
    const g2 = new Blob(['g2'], { type: 'image/webp' })
    let resolveSecond!: (b: Blob) => void
    const generateThumbnail = vi
      .fn()
      .mockResolvedValueOnce(g1)
      // The rotation re-render hangs until we resolve it, so we can
      // observe the in-flight state.
      .mockImplementationOnce(
        () =>
          new Promise<Blob>(r => {
            resolveSecond = r
          }),
      )
    const decodeImage = vi
      .fn()
      .mockResolvedValue({ width: 2048, height: 1024 } as unknown as HTMLImageElement)

    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'thumbnail',
        format: 'image/png',
        onUploaded: () => {},
        generateThumbnail,
        decodeImage,
      }),
    )

    const useBtn = (): HTMLButtonElement | undefined =>
      Array.from(mount.querySelectorAll('button')).find(
        b => b.textContent === 'Use this thumbnail',
      ) as HTMLButtonElement | undefined
    const discardBtn = (): HTMLButtonElement | undefined =>
      Array.from(mount.querySelectorAll('button')).find(
        b => b.textContent === 'Discard',
      ) as HTMLButtonElement | undefined

    // Initial generate → preview, Use enabled.
    const genInput = mount.querySelector<HTMLInputElement>(
      'input[id^="dataset-asset-generate-"][type="file"]',
    )!
    const frame = new File(['frame'], 'frame.png', { type: 'image/png' })
    Object.defineProperty(genInput, 'files', {
      value: { 0: frame, length: 1, item: (i: number) => (i === 0 ? frame : null) },
      configurable: true,
    })
    genInput.dispatchEvent(new Event('change', { bubbles: true }))
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0))
    expect(useBtn()?.disabled).toBe(false)
    expect(discardBtn()?.disabled).toBe(false)

    // Move the longitude slider → re-render starts but hangs.
    const lon = mount.querySelector<HTMLInputElement>('input[type="range"][id$="-lon"]')!
    lon.value = '90'
    lon.dispatchEvent(new Event('input', { bubbles: true }))
    lon.dispatchEvent(new Event('change', { bubbles: true }))
    for (let i = 0; i < 2; i++) await new Promise(r => setTimeout(r, 0))
    // Use + Discard are inert while the re-render is in flight — Use
    // can't upload a stale capture, and Discard can't be undone by a
    // late render repainting the preview.
    expect(useBtn()?.disabled).toBe(true)
    expect(discardBtn()?.disabled).toBe(true)

    // Let the re-render settle → both re-enable.
    resolveSecond(g2)
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0))
    expect(useBtn()?.disabled).toBe(false)
    expect(discardBtn()?.disabled).toBe(false)
  })

  it('surfaces an error + disposes the stream if capturing the video frame throws', async () => {
    const dispose = vi.fn()
    const loadVideoScrub = vi.fn().mockResolvedValue({
      video: document.createElement('video'),
      capture: () => {
        // e.g. drawImage on a not-yet-decodable frame (videoWidth=0).
        throw new Error('InvalidStateError')
      },
      dispose,
    })

    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'thumbnail',
        format: 'video/mp4',
        dataAssetUrl: 'https://assets.example/master.m3u8',
        onUploaded: () => {},
        loadVideoScrub,
      }),
    )
    Array.from(mount.querySelectorAll('button'))
      .find(b => b.textContent?.includes('Generate from this dataset'))!
      .click()
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0))

    Array.from(mount.querySelectorAll('button'))
      .find(b => b.textContent === 'Capture this frame')!
      .click()
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0))

    expect(dispose).toHaveBeenCalled()
    expect(
      mount.querySelector('.publisher-asset-uploader-generate .publisher-asset-uploader-status-error'),
    ).not.toBeNull()
    expect(mount.querySelector('.publisher-asset-uploader-generate-video')).toBeNull()
  })

  it('moves to the error state (no unhandled rejection) when a rotation re-render fails', async () => {
    const generated = new Blob(['globe'], { type: 'image/webp' })
    // First render (the initial preview) succeeds; the rotation
    // re-render rejects.
    const generateThumbnail = vi
      .fn()
      .mockResolvedValueOnce(generated)
      .mockRejectedValueOnce(new Error('context lost'))
    const decodeImage = vi
      .fn()
      .mockResolvedValue({ width: 2048, height: 1024 } as unknown as HTMLImageElement)

    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'thumbnail',
        format: 'image/png',
        onUploaded: () => {},
        generateThumbnail,
        decodeImage,
      }),
    )

    const genInput = mount.querySelector<HTMLInputElement>(
      'input[id^="dataset-asset-generate-"][type="file"]',
    )!
    const frame = new File(['frame'], 'frame.png', { type: 'image/png' })
    Object.defineProperty(genInput, 'files', {
      value: { 0: frame, length: 1, item: (i: number) => (i === 0 ? frame : null) },
      configurable: true,
    })
    genInput.dispatchEvent(new Event('change', { bubbles: true }))
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0))
    expect(mount.querySelector('.publisher-asset-uploader-generate-preview')).not.toBeNull()

    // Move the longitude slider — the re-render rejects.
    const lonSlider = mount.querySelector<HTMLInputElement>(
      'input[type="range"][id$="-lon"]',
    )!
    lonSlider.value = '90'
    lonSlider.dispatchEvent(new Event('input', { bubbles: true }))
    lonSlider.dispatchEvent(new Event('change', { bubbles: true }))
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0))

    // The generator surfaces the error rather than throwing into the void.
    expect(
      mount.querySelector('.publisher-asset-uploader-generate .publisher-asset-uploader-status-error'),
    ).not.toBeNull()
    expect(mount.querySelector('.publisher-asset-uploader-generate-preview')).toBeNull()
  })

  it('rejects a non-image file for an aux kind before any network call', async () => {
    const fetchFn = vi.fn()
    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'thumbnail',
        format: 'image/png',
        onUploaded: () => {},
        hashFn: async () => 'sha256:' + 'f'.repeat(64),
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    )
    // An MP4 is a valid `data` asset but not a valid thumbnail.
    pickFile(mount, 'video/mp4')
    await new Promise(r => setTimeout(r, 0))
    expect(mount.querySelector('.publisher-asset-uploader-status-error')?.textContent).toBe(
      'Upload failed.',
    )
    expect(mount.textContent).toContain("isn't a supported image")
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('renderAssetUploader — frames tab (3pf/D)', () => {
  let mount: HTMLDivElement

  beforeEach(() => {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    sessionStorage.clear()
  })

  function pickFrames(mount: HTMLElement, files: File[]): void {
    // The frames tab has its own multi-file input (id=
    // `dataset-asset-frames-<suffix>`). The MP4 tab's input id is
    // `dataset-asset-file-<suffix>`. The suffix is randomized per
    // uploader instance — query by id-prefix selector.
    const input = mount.querySelector<HTMLInputElement>(
      'input[type="file"][id^="dataset-asset-frames-"]',
    )!
    Object.defineProperty(input, 'files', {
      value: {
        length: files.length,
        item: (i: number) => files[i] ?? null,
        ...Object.fromEntries(files.map((f, i) => [i, f])),
      } as unknown as FileList,
      configurable: true,
    })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function clickFramesTab(mount: HTMLElement): void {
    const tabs = mount.querySelectorAll<HTMLButtonElement>(
      '.publisher-asset-uploader-tab',
    )
    // Second tab is the frames tab (order is video then frames).
    tabs[1]!.click()
  }

  it('renders the tab strip only when format is video/mp4', () => {
    // Image dataset → no tab strip.
    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        format: 'image/png',
        onUploaded: () => {},
      }),
    )
    expect(mount.querySelector('.publisher-asset-uploader-tabs')).toBeNull()
    // Video dataset → tab strip with two tabs.
    mount.replaceChildren(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        format: 'video/mp4',
        onUploaded: () => {},
      }),
    )
    expect(mount.querySelectorAll('.publisher-asset-uploader-tab')).toHaveLength(2)
  })

  it('switches to the frames picker when the frames tab is clicked', () => {
    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        format: 'video/mp4',
        onUploaded: () => {},
      }),
    )
    expect(mount.querySelector('input[id^="dataset-asset-frames-"]')).toBeNull()
    clickFramesTab(mount)
    expect(mount.querySelector('input[id^="dataset-asset-frames-"]')).not.toBeNull()
    // Single-file picker is no longer present.
    expect(mount.querySelector('input[id^="dataset-asset-file-"]')).toBeNull()
  })

  it('shows the frame-count + size summary after files are picked', () => {
    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        format: 'video/mp4',
        onUploaded: () => {},
      }),
    )
    clickFramesTab(mount)
    pickFrames(mount, [
      new File(['a'.repeat(1024)], 'frame_001.png', { type: 'image/png' }),
      new File(['b'.repeat(2048)], 'frame_002.png', { type: 'image/png' }),
    ])
    const summary = mount.querySelector('.publisher-asset-uploader-frames-summary')
    expect(summary).not.toBeNull()
    expect(summary?.textContent).toContain('2')
    // "Start upload" button is visible.
    expect(
      Array.from(mount.querySelectorAll('button')).some(b =>
        b.textContent?.includes('Upload 2'),
      ),
    ).toBe(true)
  })

  it('rejects mixed-mime frame batches before any network call', () => {
    const fetchSpy = vi.fn()
    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        format: 'video/mp4',
        onUploaded: () => {},
        fetchFn: fetchSpy as unknown as typeof fetch,
      }),
    )
    clickFramesTab(mount)
    pickFrames(mount, [
      new File(['a'], 'frame_001.png', { type: 'image/png' }),
      new File(['b'], 'frame_002.jpg', { type: 'image/jpeg' }),
    ])
    // Error surface visible.
    expect(mount.querySelector('.publisher-asset-uploader-status-error')).not.toBeNull()
    // No fetch ever fired — the validation gate is client-side.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects unsupported mimes (e.g., TIFF)', () => {
    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        format: 'video/mp4',
        onUploaded: () => {},
      }),
    )
    clickFramesTab(mount)
    pickFrames(mount, [
      new File(['a'], 'frame_001.tif', { type: 'image/tiff' }),
    ])
    expect(mount.querySelector('.publisher-asset-uploader-status-error')).not.toBeNull()
  })

  it('drives the full mint → PUT → complete flow and signals onUploaded with transcoding mode', async () => {
    const fetchSpy = vi
      .fn()
      // /asset response with two presigned frames + source-filenames blob
      .mockResolvedValueOnce(
        jsonResponse({
          upload_id: '01UPLOADAAAAAAAAAAAAAAAAAA',
          kind: 'data',
          target: 'r2',
          frames: [
            {
              filename: 'frame_001.png',
              index: 0,
              method: 'PUT',
              url: 'https://r2.test/frames/00000.png',
              headers: {},
              key: 'uploads/X/Y/frames/00000.png',
            },
            {
              filename: 'frame_002.png',
              index: 1,
              method: 'PUT',
              url: 'https://r2.test/frames/00001.png',
              headers: {},
              key: 'uploads/X/Y/frames/00001.png',
            },
          ],
          source_filenames: {
            method: 'PUT',
            url: 'https://r2.test/source_filenames.json',
            headers: {},
            key: 'uploads/X/Y/source_filenames.json',
          },
          expires_at: '2026-01-01T00:00:00.000Z',
          mock: false,
        }),
      )
      // source-filenames blob PUT (via fetch, not XHR)
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      // /complete response → transcoding=true
      .mockResolvedValueOnce(
        jsonResponse({
          dataset: { data_ref: '' },
          transcoding: true,
        }),
      )

    const onUploaded = vi.fn()
    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        format: 'video/mp4',
        onUploaded,
        fetchFn: fetchSpy as unknown as typeof fetch,
        xhrFactory: fakeXhrFactory(),
        // Deterministic hashes so the test doesn't time-bound on
        // SHA-256 computation. The validator only checks shape.
        hashFn: async (_f: File) => `sha256:${'a'.repeat(64)}`,
      }),
    )
    clickFramesTab(mount)
    pickFrames(mount, [
      new File(['a'.repeat(100)], 'frame_001.png', { type: 'image/png' }),
      new File(['b'.repeat(100)], 'frame_002.png', { type: 'image/png' }),
    ])
    // Click the "Start upload" button.
    const startBtn = Array.from(mount.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Upload 2'),
    )!
    startBtn.click()
    // Allow the async runFrameSequence pipeline to flush —
    // `crypto.subtle.digest` (used for the canonical
    // source-filenames hash) yields to a macrotask, so
    // microtask-only drains aren't enough.
    for (let i = 0; i < 16; i++) await new Promise(r => setTimeout(r, 0))

    // The /asset POST + the blob PUT + the /complete POST.
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    // First call is /asset — verify the body carried `frames`
    // (the discriminator) and a valid `source_filenames_digest`.
    const initBody = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as {
      frames: Array<{ filename: string; digest: string }>
      source_filenames_digest: string
    }
    expect(initBody.frames).toHaveLength(2)
    expect(initBody.source_filenames_digest).toMatch(/^sha256:[0-9a-f]{64}$/)

    // onUploaded fires with transcoding mode (frame-source uploads
    // always go through the transcode pipeline).
    expect(onUploaded).toHaveBeenCalledWith({ mode: 'transcoding' })
  })

  it('retries a transient source-filenames blob PUT failure', async () => {
    // 3pf-review/C — the prior shape threw on the first non-2xx
    // and left the asset_uploads row stuck `'pending'` with every
    // frame already in R2. Two retries with short backoffs absorb
    // a network blip.
    const fetchSpy = vi
      .fn()
      // /asset response
      .mockResolvedValueOnce(
        jsonResponse({
          upload_id: '01UPLOADAAAAAAAAAAAAAAAAAA',
          kind: 'data',
          target: 'r2',
          frames: [
            {
              filename: 'frame_001.png',
              index: 0,
              method: 'PUT',
              url: 'https://r2.test/frames/00000.png',
              headers: {},
              key: 'uploads/X/Y/frames/00000.png',
            },
          ],
          source_filenames: {
            method: 'PUT',
            url: 'https://r2.test/source_filenames.json',
            headers: {},
            key: 'uploads/X/Y/source_filenames.json',
          },
          expires_at: '2026-01-01T00:00:00.000Z',
          mock: false,
        }),
      )
      // First blob PUT: 503 (transient)
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      // Second blob PUT: succeeds
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      // /complete response → transcoding=true
      .mockResolvedValueOnce(
        jsonResponse({ dataset: { data_ref: '' }, transcoding: true }),
      )

    const onUploaded = vi.fn()
    mount.appendChild(
      renderAssetUploader({
        datasetId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        format: 'video/mp4',
        onUploaded,
        fetchFn: fetchSpy as unknown as typeof fetch,
        xhrFactory: fakeXhrFactory(),
        hashFn: async () => `sha256:${'a'.repeat(64)}`,
        // Skip the retry backoff so the test doesn't time-bound.
        sleep: () => Promise.resolve(),
      }),
    )
    clickFramesTab(mount)
    pickFrames(mount, [
      new File(['a'.repeat(100)], 'frame_001.png', { type: 'image/png' }),
    ])
    const startBtn = Array.from(mount.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Upload 1'),
    )!
    startBtn.click()
    for (let i = 0; i < 16; i++) await new Promise(r => setTimeout(r, 0))

    // 4 calls: /asset + first blob PUT (failed) + second blob PUT
    // (succeeded) + /complete.
    expect(fetchSpy).toHaveBeenCalledTimes(4)
    expect(onUploaded).toHaveBeenCalledWith({ mode: 'transcoding' })
  })
})

describe('hashFileSha256', () => {
  // PR #112 followup — the upload-flow tests all inject `hashFn`,
  // so the real `@noble/hashes` dynamic imports and the chunked
  // hashing loop never run under test. A wrong package subpath
  // (the `sha2.js` / `utils.js` shape is package-specific) would
  // only surface in the browser when a publisher picks a file.
  // These tests exercise the real implementation.

  it('matches a Web Crypto reference digest for a small file', async () => {
    // 'hello world' has a well-known SHA-256 hash:
    //   b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
    const file = new File([new TextEncoder().encode('hello world')], 'hello.txt', {
      type: 'text/plain',
    })
    const digest = await hashFileSha256(file)
    expect(digest).toBe(
      'sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    )
  })

  it('matches a Web Crypto reference digest for the empty file', async () => {
    // Empty-input SHA-256 is one of the most-cited test vectors;
    // the chunked loop should skip its body entirely and still
    // return the correct digest of zero bytes.
    const file = new File([new Uint8Array(0)], 'empty.bin', { type: 'application/octet-stream' })
    const digest = await hashFileSha256(file)
    expect(digest).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('handles files larger than the chunk boundary (chunked loop coverage)', async () => {
    // The hasher accumulates across `slice → arrayBuffer →
    // update` iterations. A file bigger than the chunk size
    // exercises that path; a one-shot hash of the same bytes
    // should match (validated against the streaming hash itself
    // by re-running on a single-blob File of the same bytes).
    const bytes = new Uint8Array(8 * 1024 * 1024 + 17) // 8 MB + slop
    // Deterministic non-zero payload so we're not hashing all
    // zeros (which is degenerate for some hash implementations).
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff
    const bigFile = new File([bytes], 'big.bin', { type: 'application/octet-stream' })
    const digest = await hashFileSha256(bigFile)
    // Cross-check via the platform's Web Crypto: the digest of
    // the same bytes should match regardless of chunking.
    const ref = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
    const refHex = Array.from(new Uint8Array(ref))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
    expect(digest).toBe(`sha256:${refHex}`)
  })
})
