/**
 * Tests for the Cloudflare Stream helpers.
 *
 * Coverage:
 *   - `mintDirectUploadUrl` in mock mode returns a deterministic
 *     local URL + uid keyed off the clock; expiry stamps TTL ahead.
 *   - `mintDirectUploadUrl` in real mode POSTs to the documented
 *     Stream endpoint with the right Authorization + body shape and
 *     surfaces failures from the API as a thrown error.
 *   - `getTranscodeStatus` mock mode reports ready immediately; real
 *     mode normalises Stream's vocabulary onto the four-state enum
 *     the route handlers branch on.
 *   - `streamPlaybackUrl` builds the documented HLS URL pattern and
 *     refuses to emit a URL when the subdomain is unset.
 *   - Real-mode helpers fail closed with a clear message when
 *     credentials are missing, instead of silently making a malformed
 *     request.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  getTranscodeStatus,
  mintDirectUploadUrl,
  MOCK_STREAM_SUBDOMAIN,
  MOCK_STREAM_UPLOAD_HOST,
  STREAM_DIRECT_UPLOAD_TTL_SECONDS,
  streamPlaybackUrl,
  type StreamEnv,
} from './stream-store'

const FIXED_NOW = new Date('2026-04-29T12:00:00.000Z')

const REAL_CREDS: StreamEnv = {
  STREAM_ACCOUNT_ID: 'acct1234',
  STREAM_API_TOKEN: 'cf-token-abc',
  STREAM_CUSTOMER_SUBDOMAIN: 'customer-real.cloudflarestream.com',
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('mintDirectUploadUrl — mock mode', () => {
  const env: StreamEnv = { MOCK_STREAM: 'true' }

  it('returns a deterministic local URL and uid for a fixed clock', async () => {
    const a = await mintDirectUploadUrl(env, { now: FIXED_NOW })
    const b = await mintDirectUploadUrl(env, { now: FIXED_NOW })
    expect(a.upload_url).toBe(b.upload_url)
    expect(a.stream_uid).toBe(b.stream_uid)
    expect(a.upload_url).toContain(MOCK_STREAM_UPLOAD_HOST)
    expect(a.stream_uid).toMatch(/^[0-9a-f]{32}$/)
  })

  it('produces a different uid when the clock differs', async () => {
    const a = await mintDirectUploadUrl(env, { now: FIXED_NOW })
    const b = await mintDirectUploadUrl(env, { now: new Date(FIXED_NOW.getTime() + 1) })
    expect(a.stream_uid).not.toBe(b.stream_uid)
  })

  it('stamps an expiry TTL ahead', async () => {
    const result = await mintDirectUploadUrl(env, { now: FIXED_NOW })
    const exp = new Date(result.expires_at).getTime()
    expect(exp - FIXED_NOW.getTime()).toBe(STREAM_DIRECT_UPLOAD_TTL_SECONDS * 1000)
  })
})

describe('mintDirectUploadUrl — real mode', () => {
  it('POSTs to the documented Stream endpoint with bearer auth', async () => {
    const fetchStub = vi.fn(async (_url: string, init?: RequestInit) => {
      return jsonResponse({
        success: true,
        result: { uploadURL: 'https://upload.cloudflarestream.com/abcdef', uid: 'abc123def456' },
      })
    }) as unknown as typeof fetch
    const result = await mintDirectUploadUrl(REAL_CREDS, {
      now: FIXED_NOW,
      maxDurationSeconds: 60,
      meta: { dataset_id: 'DS001', upload_id: 'UP001' },
      fetchImpl: fetchStub,
    })
    expect(result.upload_url).toBe('https://upload.cloudflarestream.com/abcdef')
    expect(result.stream_uid).toBe('abc123def456')

    expect(fetchStub).toHaveBeenCalledOnce()
    const [url, init] = (fetchStub as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct1234/stream/direct_upload')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer cf-token-abc')
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    const body = JSON.parse(init?.body as string)
    expect(body.maxDurationSeconds).toBe(60)
    expect(body.meta).toEqual({ dataset_id: 'DS001', upload_id: 'UP001' })
    expect(typeof body.expiry).toBe('string')
  })

  it('throws on a Stream API error', async () => {
    const fetchStub = vi.fn(async () =>
      jsonResponse({ success: false, errors: [{ code: 1, message: 'Token quota exceeded' }] }, { status: 429 }),
    ) as unknown as typeof fetch
    await expect(
      mintDirectUploadUrl(REAL_CREDS, { now: FIXED_NOW, fetchImpl: fetchStub }),
    ).rejects.toThrow(/Token quota exceeded/)
  })

  it('throws on a malformed Stream response', async () => {
    const fetchStub = vi.fn(async () =>
      jsonResponse({ success: true, result: {} }),
    ) as unknown as typeof fetch
    await expect(
      mintDirectUploadUrl(REAL_CREDS, { now: FIXED_NOW, fetchImpl: fetchStub }),
    ).rejects.toThrow(/Stream direct_upload failed/)
  })

  it('throws when credentials are missing', async () => {
    await expect(
      mintDirectUploadUrl(
        { STREAM_ACCOUNT_ID: 'acct1234' },
        { now: FIXED_NOW, fetchImpl: vi.fn() as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/MOCK_STREAM=true|STREAM_API_TOKEN/)
  })
})

describe('getTranscodeStatus', () => {
  it('mock mode reports ready immediately', async () => {
    const result = await getTranscodeStatus({ MOCK_STREAM: 'true' }, 'any')
    expect(result).toEqual({ state: 'ready', ready: true, raw_state: 'ready' })
  })

  it('normalises Stream states onto the four-state enum', async () => {
    const cases: Array<{ raw: string; state: string; ready: boolean }> = [
      { raw: 'ready', state: 'ready', ready: true },
      { raw: 'inprogress', state: 'processing', ready: false },
      { raw: 'queued', state: 'processing', ready: false },
      { raw: 'downloading', state: 'processing', ready: false },
      { raw: 'pendingupload', state: 'pending', ready: false },
      { raw: 'error', state: 'error', ready: false },
      { raw: '', state: 'pending', ready: false },
    ]
    for (const { raw, state, ready } of cases) {
      const fetchStub = vi.fn(async () =>
        jsonResponse({ success: true, result: { uid: 'u', status: { state: raw } } }),
      ) as unknown as typeof fetch
      const result = await getTranscodeStatus(REAL_CREDS, 'u', { fetchImpl: fetchStub })
      expect(result.state).toBe(state)
      expect(result.ready).toBe(ready)
      expect(result.raw_state).toBe(raw)
    }
  })

  it('surfaces error reason text', async () => {
    const fetchStub = vi.fn(async () =>
      jsonResponse({
        success: true,
        result: { uid: 'u', status: { state: 'error', errorReasonText: 'codec_not_supported' } },
      }),
    ) as unknown as typeof fetch
    const result = await getTranscodeStatus(REAL_CREDS, 'u', { fetchImpl: fetchStub })
    expect(result.state).toBe('error')
    expect(result.errors).toEqual(['codec_not_supported'])
  })

  it('throws on a Stream API error', async () => {
    const fetchStub = vi.fn(async () =>
      jsonResponse({ success: false, errors: [{ code: 10006, message: 'video not found' }] }, { status: 404 }),
    ) as unknown as typeof fetch
    await expect(
      getTranscodeStatus(REAL_CREDS, 'missing', { fetchImpl: fetchStub }),
    ).rejects.toThrow(/video not found/)
  })
})

describe('streamPlaybackUrl', () => {
  it('builds the documented HLS playback URL pattern', () => {
    const url = streamPlaybackUrl(REAL_CREDS, 'abc123')
    expect(url).toBe('https://customer-real.cloudflarestream.com/abc123/manifest/video.m3u8')
  })

  it('uses the mock subdomain when MOCK_STREAM=true and no override is set', () => {
    const url = streamPlaybackUrl({ MOCK_STREAM: 'true' }, 'abc123')
    expect(url).toBe(`https://${MOCK_STREAM_SUBDOMAIN}/abc123/manifest/video.m3u8`)
  })

  it('throws when the subdomain is unset and MOCK_STREAM is off', () => {
    expect(() => streamPlaybackUrl({}, 'abc123')).toThrow(/STREAM_CUSTOMER_SUBDOMAIN/)
  })

  it('encodes the uid into the path', () => {
    const url = streamPlaybackUrl(REAL_CREDS, 'a/b c')
    expect(url).toContain('/a%2Fb%20c/manifest/video.m3u8')
  })
})
