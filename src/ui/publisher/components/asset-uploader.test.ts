import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashFileSha256, renderAssetUploader } from './asset-uploader'

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
