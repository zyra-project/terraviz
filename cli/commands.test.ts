/**
 * Tests for the CLI command implementations.
 *
 * Each test wires up a fake `TerravizClient` whose methods return
 * fixed `Result` payloads, then invokes a command and asserts on:
 *   - the exit code
 *   - the stdout / stderr text
 *   - which client method was called and with what arguments
 */

import { describe, expect, it, vi } from 'vitest'
import {
  HELP_TEXT,
  runGet,
  runHelp,
  runList,
  runMe,
  runPreview,
  runPublish,
  runRetract,
  runTour,
  runUpdate,
  runUpload,
  type CommandContext,
} from './commands'
import type { TerravizClient } from './lib/client'
import { parseArgs } from './lib/args'

interface BufStream {
  write(chunk: string): boolean
  text(): string
}

function makeStream(): BufStream {
  let buf = ''
  return {
    write(chunk: string) {
      buf += chunk
      return true
    },
    text() {
      return buf
    },
  }
}

function fakeClient(
  overrides: Partial<Record<keyof TerravizClient, unknown>> = {},
): TerravizClient {
  // Default everything to an "ok with placeholder body" so command
  // tests can override only the methods they care about.
  const ok = (body: unknown) =>
    Promise.resolve({ ok: true as const, status: 200, body })
  const stub = {
    serverUrl: 'http://localhost:8788',
    me: vi.fn(() => ok({ id: 'PUB1', email: 'me@x', display_name: 'me', role: 'staff', is_admin: true, status: 'active' })),
    list: vi.fn(() => ok({ datasets: [], next_cursor: null })),
    get: vi.fn(() => ok({ dataset: { id: 'DS1', slug: 's', title: 'T', published_at: null } })),
    createDataset: vi.fn(() => ok({ dataset: { id: 'DS1', slug: 's', title: 'T', published_at: null } })),
    updateDataset: vi.fn(() => ok({ dataset: { id: 'DS1', slug: 's', title: 'T', published_at: null } })),
    publishDataset: vi.fn(() => ok({ dataset: { id: 'DS1', slug: 's', title: 'T', published_at: '2026-04-28T20:00:00Z' } })),
    retractDataset: vi.fn(() => ok({ dataset: { id: 'DS1', slug: 's', title: 'T', published_at: null } })),
    previewDataset: vi.fn(() => ok({ token: 'abc.def', url: '/api/v1/datasets/DS1/preview/abc.def', expires_in: 900 })),
    createTour: vi.fn(() => ok({ tour: { id: 'TR1', slug: 's', title: 'T', published_at: null } })),
    updateTour: vi.fn(() => ok({ tour: { id: 'TR1', slug: 's', title: 'T', published_at: null } })),
    previewTour: vi.fn(() => ok({ token: 'tk', url: '/api/v1/tours/TR1/preview/tk', expires_in: 900 })),
    initAssetUpload: vi.fn(() =>
      ok({
        upload_id: 'UP1',
        kind: 'thumbnail',
        target: 'r2',
        r2: {
          method: 'PUT',
          url: 'https://mock-r2.localhost/terraviz-assets/k',
          headers: { 'Content-Type': 'image/png' },
          key: 'datasets/DS1/by-digest/sha256/aaa/thumbnail.png',
        },
        expires_at: '2026-04-29T13:00:00Z',
      }),
    ),
    completeAssetUpload: vi.fn(() =>
      ok({ dataset: { id: 'DS1' }, verified_digest: 'sha256:abc' }),
    ),
    uploadBytes: vi.fn(() => Promise.resolve({ ok: true, status: 200 })),
    ...overrides,
  } as unknown as TerravizClient
  return stub
}

function makeCtx(
  positional: string[],
  optionsArr: string[] = [],
  client = fakeClient(),
  fileMap: Record<string, string> = {},
): { ctx: CommandContext; stdout: BufStream; stderr: BufStream } {
  const stdout = makeStream()
  const stderr = makeStream()
  const args = parseArgs([...positional, ...optionsArr])
  return {
    ctx: {
      client,
      args,
      stdout,
      stderr,
      readFile: (p: string) => {
        if (p in fileMap) return fileMap[p]
        throw new Error(`No such fixture: ${p}`)
      },
    },
    stdout,
    stderr,
  }
}

describe('runMe', () => {
  it('prints a human summary by default', async () => {
    const { ctx, stdout } = makeCtx([])
    expect(await runMe(ctx)).toBe(0)
    expect(stdout.text()).toContain('me <me@x>')
    expect(stdout.text()).toContain('staff (admin)')
  })

  it('prints JSON under --json', async () => {
    const { ctx, stdout } = makeCtx([], ['--json'])
    expect(await runMe(ctx)).toBe(0)
    const body = JSON.parse(stdout.text())
    expect(body.id).toBe('PUB1')
  })

  it('returns a non-zero exit on a failed call', async () => {
    const client = fakeClient({
      me: vi.fn(() =>
        Promise.resolve({ ok: false as const, status: 401, error: 'unauthenticated' }),
      ),
    })
    const { ctx, stderr } = makeCtx([], [], client)
    expect(await runMe(ctx)).toBe(1)
    expect(stderr.text()).toContain('unauthenticated')
  })
})

describe('runList', () => {
  it('prints "(no datasets)" on an empty result', async () => {
    const { ctx, stdout } = makeCtx([])
    expect(await runList(ctx)).toBe(0)
    expect(stdout.text()).toBe('(no datasets)\n')
  })

  it('prints a row per dataset', async () => {
    const client = fakeClient({
      list: vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          status: 200,
          body: {
            datasets: [
              { id: 'A', slug: 'alpha', title: 'Alpha', published_at: '2026-01-01T00:00:00Z' },
              { id: 'B', slug: 'beta', title: 'Beta', published_at: null },
            ],
            next_cursor: null,
          },
        }),
      ),
    })
    const { ctx, stdout } = makeCtx([], [], client)
    expect(await runList(ctx)).toBe(0)
    expect(stdout.text()).toContain('published')
    expect(stdout.text()).toContain('draft')
    expect(stdout.text()).toContain('Alpha')
  })

  it('rejects an unknown --status', async () => {
    const { ctx, stderr } = makeCtx([], ['--status=bogus'])
    expect(await runList(ctx)).toBe(2)
    expect(stderr.text()).toContain('--status must be one of')
  })

  it('forwards --status, --limit, --cursor to client.list', async () => {
    const list = vi.fn(() =>
      Promise.resolve({ ok: true as const, status: 200, body: { datasets: [], next_cursor: null } }),
    )
    const client = fakeClient({ list })
    const { ctx } = makeCtx([], ['--status=draft', '--limit=5', '--cursor=Z'], client)
    expect(await runList(ctx)).toBe(0)
    expect(list).toHaveBeenCalledWith({ status: 'draft', limit: 5, cursor: 'Z' })
  })
})

describe('runGet', () => {
  it('rejects when no id is provided', async () => {
    const { ctx, stderr } = makeCtx([])
    expect(await runGet(ctx)).toBe(2)
    expect(stderr.text()).toContain('Usage: terraviz get <id>')
  })

  it('prints the dataset as JSON when found', async () => {
    const { ctx, stdout } = makeCtx(['DS1'])
    expect(await runGet(ctx)).toBe(0)
    const body = JSON.parse(stdout.text())
    expect(body.id).toBe('DS1')
  })
})

describe('runPublish', () => {
  it('rejects when no file path is given', async () => {
    const { ctx, stderr } = makeCtx([])
    expect(await runPublish(ctx)).toBe(2)
    expect(stderr.text()).toContain('Usage: terraviz publish')
  })

  it('rejects malformed JSON', async () => {
    const { ctx, stderr } = makeCtx(['/tmp/bad.json'], [], fakeClient(), {
      '/tmp/bad.json': 'not json',
    })
    expect(await runPublish(ctx)).toBe(2)
    expect(stderr.text()).toContain('not valid JSON')
  })

  it('creates and publishes by default', async () => {
    const createDataset = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        status: 201,
        body: { dataset: { id: 'DS1', slug: 'd', title: 'T', published_at: null } },
      }),
    )
    const publishDataset = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        status: 200,
        body: { dataset: { id: 'DS1', slug: 'd', title: 'T', published_at: '2026-01-01T00:00:00Z' } },
      }),
    )
    const client = fakeClient({ createDataset, publishDataset })
    const { ctx, stdout } = makeCtx(['/tmp/m.json'], [], client, {
      '/tmp/m.json': JSON.stringify({ title: 'T', format: 'video/mp4' }),
    })
    expect(await runPublish(ctx)).toBe(0)
    expect(createDataset).toHaveBeenCalledWith({ title: 'T', format: 'video/mp4' })
    expect(publishDataset).toHaveBeenCalledWith('DS1')
    expect(stdout.text()).toContain('Created draft DS1')
    expect(stdout.text()).toContain('Published DS1')
  })

  it('skips the publish step under --draft-only', async () => {
    const publishDataset = vi.fn(() =>
      Promise.resolve({ ok: true as const, status: 200, body: { dataset: { id: 'DS1', slug: 'd', title: 'T', published_at: null } } }),
    )
    const client = fakeClient({ publishDataset })
    const { ctx } = makeCtx(['/tmp/m.json'], ['--draft-only'], client, {
      '/tmp/m.json': JSON.stringify({ title: 'T', format: 'video/mp4' }),
    })
    expect(await runPublish(ctx)).toBe(0)
    expect(publishDataset).not.toHaveBeenCalled()
  })

  it('surfaces validation errors and exits 1', async () => {
    const createDataset = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        status: 400,
        error: 'bad_request',
        errors: [{ field: 'title', code: 'too_short', message: 'short' }],
      }),
    )
    const client = fakeClient({ createDataset })
    const { ctx, stderr } = makeCtx(['/tmp/m.json'], [], client, {
      '/tmp/m.json': JSON.stringify({ title: 'a' }),
    })
    expect(await runPublish(ctx)).toBe(1)
    expect(stderr.text()).toContain('title: too_short')
  })
})

describe('runUpdate', () => {
  it('rejects without id + path', async () => {
    const { ctx, stderr } = makeCtx(['onlyid'])
    expect(await runUpdate(ctx)).toBe(2)
    expect(stderr.text()).toContain('Usage: terraviz update')
  })

  it('forwards the parsed body to client.updateDataset', async () => {
    const updateDataset = vi.fn(() =>
      Promise.resolve({ ok: true as const, status: 200, body: { dataset: { id: 'DS1', slug: 's', title: 'X', published_at: null } } }),
    )
    const client = fakeClient({ updateDataset })
    const { ctx } = makeCtx(['DS1', '/tmp/m.json'], [], client, {
      '/tmp/m.json': JSON.stringify({ title: 'X' }),
    })
    expect(await runUpdate(ctx)).toBe(0)
    expect(updateDataset).toHaveBeenCalledWith('DS1', { title: 'X' })
  })
})

describe('runRetract', () => {
  it('calls client.retractDataset', async () => {
    const retractDataset = vi.fn(() =>
      Promise.resolve({ ok: true as const, status: 200, body: { dataset: { id: 'DS1', slug: 's', title: 'T', published_at: null } } }),
    )
    const client = fakeClient({ retractDataset })
    const { ctx } = makeCtx(['DS1'], [], client)
    expect(await runRetract(ctx)).toBe(0)
    expect(retractDataset).toHaveBeenCalledWith('DS1')
  })
})

describe('runPreview', () => {
  it('prints the preview URL from server + relative URL', async () => {
    const { ctx, stdout } = makeCtx(['DS1'])
    expect(await runPreview(ctx)).toBe(0)
    expect(stdout.text()).toContain('http://localhost:8788/api/v1/datasets/DS1/preview/abc.def')
    expect(stdout.text()).toContain('expires in 900s')
  })

  it('forwards --ttl to the client', async () => {
    const previewDataset = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        status: 200,
        body: { token: 't', url: '/u', expires_in: 60 },
      }),
    )
    const client = fakeClient({ previewDataset })
    const { ctx } = makeCtx(['DS1'], ['--ttl=60'], client)
    expect(await runPreview(ctx)).toBe(0)
    expect(previewDataset).toHaveBeenCalledWith('DS1', { ttl_seconds: 60 })
  })
})

describe('runTour', () => {
  it('rejects when no subcommand is given', async () => {
    const { ctx, stderr } = makeCtx([])
    expect(await runTour(ctx)).toBe(2)
    expect(stderr.text()).toContain('Usage: terraviz tour')
  })

  it('publish creates a tour', async () => {
    const createTour = vi.fn(() =>
      Promise.resolve({ ok: true as const, status: 201, body: { tour: { id: 'TR1', slug: 's', title: 'T', published_at: null } } }),
    )
    const client = fakeClient({ createTour })
    const { ctx, stdout } = makeCtx(['publish', '/tmp/t.json'], [], client, {
      '/tmp/t.json': JSON.stringify({ title: 'T', tour_json_ref: 'r2:x' }),
    })
    expect(await runTour(ctx)).toBe(0)
    expect(createTour).toHaveBeenCalled()
    expect(stdout.text()).toContain('Created tour TR1')
  })

  it('preview prints the URL', async () => {
    const previewTour = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        status: 200,
        body: { token: 't', url: '/api/v1/tours/TR1/preview/t', expires_in: 900 },
      }),
    )
    const client = fakeClient({ previewTour })
    const { ctx, stdout } = makeCtx(['preview', 'TR1'], [], client)
    expect(await runTour(ctx)).toBe(0)
    expect(stdout.text()).toContain('/api/v1/tours/TR1/preview/t')
  })
})

describe('runUpload', () => {
  it('rejects when positional args are missing', async () => {
    const { ctx, stderr } = makeCtx([])
    expect(await runUpload(ctx)).toBe(2)
    expect(stderr.text()).toContain('Usage: terraviz upload')
  })

  it('rejects an unknown kind', async () => {
    const { ctx, stderr } = makeCtx(['DS1', 'manifest', '/tmp/asset.png'], [], fakeClient(), {
      '/tmp/asset.png': 'fake bytes',
    })
    expect(await runUpload(ctx)).toBe(2)
    expect(stderr.text()).toContain('Unknown kind')
  })

  it('rejects a path with no inferable mime', async () => {
    const { ctx, stderr } = makeCtx(['DS1', 'thumbnail', '/tmp/file.weird'], [], fakeClient(), {
      '/tmp/file.weird': 'fake',
    })
    expect(await runUpload(ctx)).toBe(2)
    expect(stderr.text()).toContain('Could not infer mime')
  })

  it('honours --mime override', async () => {
    const initFn = vi.fn(
      (_id: string, _body: { mime: string; size: number; content_digest: string }) =>
        Promise.resolve({
          ok: true as const,
          status: 200,
          body: {
            upload_id: 'UP1',
            kind: 'thumbnail',
            target: 'r2' as const,
            r2: {
              method: 'PUT' as const,
              url: 'https://mock-r2.localhost/k',
              headers: { 'Content-Type': 'image/png' },
              key: 'k',
            },
            expires_at: '2026-04-29T13:00:00Z',
          },
        }),
    )
    const client = fakeClient({ initAssetUpload: initFn })
    const { ctx } = makeCtx(
      ['DS1', 'thumbnail', '/tmp/file.weird'],
      ['--mime=image/png'],
      client,
      { '/tmp/file.weird': 'fake bytes' },
    )
    expect(await runUpload(ctx)).toBe(0)
    expect(initFn).toHaveBeenCalledWith(
      'DS1',
      expect.objectContaining({ mime: 'image/png' }),
    )
  })

  it('flows init → upload → complete for an R2 thumbnail', async () => {
    const initFn = vi.fn(
      (_id: string, _body: { kind: string; mime: string; size: number; content_digest: string }) =>
        Promise.resolve({
          ok: true as const,
          status: 200,
          body: {
            upload_id: 'UP1',
            kind: 'thumbnail',
            target: 'r2' as const,
            r2: {
              method: 'PUT' as const,
              url: 'https://mock-r2.localhost/k',
              headers: { 'Content-Type': 'image/png' },
              key: 'k',
            },
            expires_at: '2026-04-29T13:00:00Z',
          },
        }),
    )
    const uploadFn = vi.fn(
      (_target: 'r2' | 'stream', _url: string, _h: Record<string, string>, _b: Uint8Array, _m: string, _f: string) =>
        Promise.resolve({ ok: true, status: 200 }),
    )
    const completeFn = vi.fn((_id: string, _uploadId: string) =>
      Promise.resolve({
        ok: true as const,
        status: 200,
        body: { dataset: { id: 'DS1' }, verified_digest: 'sha256:xyz' },
      }),
    )
    const client = fakeClient({
      initAssetUpload: initFn,
      uploadBytes: uploadFn,
      completeAssetUpload: completeFn,
    })
    const { ctx, stdout } = makeCtx(
      ['DS1', 'thumbnail', '/tmp/thumb.png'],
      [],
      client,
      { '/tmp/thumb.png': 'fake png bytes' },
    )
    expect(await runUpload(ctx)).toBe(0)

    expect(initFn).toHaveBeenCalledOnce()
    expect(initFn).toHaveBeenCalledWith(
      'DS1',
      expect.objectContaining({
        kind: 'thumbnail',
        mime: 'image/png',
        size: expect.any(Number),
        content_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      }),
    )

    expect(uploadFn).toHaveBeenCalledOnce()
    expect(uploadFn).toHaveBeenCalledWith(
      'r2',
      'https://mock-r2.localhost/k',
      expect.any(Object),
      expect.any(Uint8Array),
      'image/png',
      'thumb.png',
    )

    expect(completeFn).toHaveBeenCalledWith('DS1', 'UP1')
    expect(stdout.text()).toContain('completed')
    expect(stdout.text()).toContain('verified_digest: sha256:xyz')
  })

  it('uses POST/multipart for Stream targets', async () => {
    const initFn = vi.fn(
      (_id: string, _body: unknown) =>
        Promise.resolve({
          ok: true as const,
          status: 200,
          body: {
            upload_id: 'UP1',
            kind: 'data',
            target: 'stream' as const,
            stream: { upload_url: 'https://upload.cloudflarestream.com/abc', stream_uid: 'abc' },
            expires_at: '2026-04-29T13:00:00Z',
          },
        }),
    )
    const uploadFn = vi.fn(
      (_target: 'r2' | 'stream', _url: string, _h: Record<string, string>, _b: Uint8Array, _m: string, _f: string) =>
        Promise.resolve({ ok: true, status: 200 }),
    )
    const client = fakeClient({ initAssetUpload: initFn, uploadBytes: uploadFn })
    const { ctx } = makeCtx(['DS1', 'data', '/tmp/v.mp4'], [], client, {
      '/tmp/v.mp4': 'fake mp4',
    })
    expect(await runUpload(ctx)).toBe(0)
    expect(uploadFn).toHaveBeenCalledWith(
      'stream',
      'https://upload.cloudflarestream.com/abc',
      expect.any(Object),
      expect.any(Uint8Array),
      'video/mp4',
      'v.mp4',
    )
  })

  it('retries /complete when Stream returns 202 transcode_in_progress', async () => {
    const initFn = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        status: 200,
        body: {
          upload_id: 'UP1',
          kind: 'data',
          target: 'stream',
          stream: { upload_url: 'https://upload.cloudflarestream.com/abc', stream_uid: 'abc' },
          expires_at: '2026-04-29T13:00:00Z',
        },
      }),
    )
    const completeResponses = [
      { ok: false as const, status: 202, error: 'transcode_in_progress' },
      { ok: false as const, status: 202, error: 'transcode_in_progress' },
      { ok: true as const, status: 200, body: { dataset: { id: 'DS1' }, verified_digest: 'sha256:x' } },
    ]
    let i = 0
    const completeFn = vi.fn(() => Promise.resolve(completeResponses[i++]))
    const client = fakeClient({
      initAssetUpload: initFn,
      completeAssetUpload: completeFn,
      uploadBytes: vi.fn(() => Promise.resolve({ ok: true, status: 200 })),
    })
    const { ctx } = makeCtx(['DS1', 'data', '/tmp/v.mp4'], [], client, {
      '/tmp/v.mp4': 'fake',
    })
    // Patch sleep to skip the actual delay.
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((fn: () => void) => {
      fn()
      return 0 as unknown as ReturnType<typeof realSetTimeout>
    }) as typeof setTimeout
    try {
      expect(await runUpload(ctx)).toBe(0)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
    expect(completeFn).toHaveBeenCalledTimes(3)
  })

  it('surfaces validation errors from /asset', async () => {
    const initFn = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        status: 400,
        error: 'http_error',
        errors: [{ field: 'size', code: 'size_exceeded', message: 'too big' }],
      }),
    )
    const client = fakeClient({ initAssetUpload: initFn })
    const { ctx, stderr } = makeCtx(['DS1', 'thumbnail', '/tmp/t.png'], [], client, {
      '/tmp/t.png': 'fake',
    })
    expect(await runUpload(ctx)).toBe(1)
    expect(stderr.text()).toContain('size_exceeded')
  })

  it('surfaces upload-byte failures', async () => {
    const uploadFn = vi.fn(() =>
      Promise.resolve({ ok: false, status: 403, message: 'SignatureDoesNotMatch' }),
    )
    const client = fakeClient({ uploadBytes: uploadFn })
    const { ctx, stderr } = makeCtx(['DS1', 'thumbnail', '/tmp/t.png'], [], client, {
      '/tmp/t.png': 'fake',
    })
    expect(await runUpload(ctx)).toBe(1)
    expect(stderr.text()).toContain('Upload failed')
    expect(stderr.text()).toContain('403')
  })

  it('skips uploadBytes entirely when the server flags mock=true', async () => {
    const initFn = vi.fn(
      (_id: string, _body: unknown) =>
        Promise.resolve({
          ok: true as const,
          status: 200,
          body: {
            upload_id: 'UP1',
            kind: 'thumbnail',
            target: 'r2' as const,
            r2: {
              method: 'PUT' as const,
              url: 'https://mock-r2.localhost/k',
              headers: { 'Content-Type': 'image/png' },
              key: 'k',
            },
            expires_at: '2026-04-29T13:00:00Z',
            mock: true,
          },
        }),
    )
    const uploadFn = vi.fn(() => Promise.resolve({ ok: true, status: 200 }))
    const completeFn = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        status: 200,
        body: { dataset: { id: 'DS1' }, verified_digest: 'sha256:xyz' },
      }),
    )
    const client = fakeClient({
      initAssetUpload: initFn,
      uploadBytes: uploadFn,
      completeAssetUpload: completeFn,
    })
    const { ctx, stdout } = makeCtx(['DS1', 'thumbnail', '/tmp/t.png'], [], client, {
      '/tmp/t.png': 'fake',
    })
    expect(await runUpload(ctx)).toBe(0)
    expect(uploadFn).not.toHaveBeenCalled()
    expect(completeFn).toHaveBeenCalledOnce()
    expect(stdout.text()).toContain('mock mode')
    expect(stdout.text()).toContain('completed')
  })
})

describe('runHelp', () => {
  it('writes the help banner', async () => {
    const { ctx, stdout } = makeCtx([])
    expect(runHelp(ctx)).toBe(0)
    expect(stdout.text()).toBe(HELP_TEXT)
  })
})
