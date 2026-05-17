/**
 * Unit tests for `github-dispatch.ts`. The integration coverage
 * (the /complete handler firing the dispatch and stamping
 * transcoding=1) lives in the complete.test.ts video-transcode
 * describe block. This file pins the helper's contract in
 * isolation.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  dispatchTranscode,
  TRANSCODE_HLS_EVENT_TYPE,
} from './github-dispatch'
import { ConfigurationError, UpstreamError } from './errors'

const ENV_OK = {
  GITHUB_OWNER: 'zyra-project',
  GITHUB_REPO: 'terraviz',
  GITHUB_DISPATCH_TOKEN: 'ghp_test',
}

const PAYLOAD = {
  dataset_id: '01HX0000000000000000000000',
  upload_id: '01HY0000000000000000000000',
  source_key: 'uploads/01HX0000000000000000000000/01HY0000000000000000000000/source.mp4',
  source_digest: 'sha256:' + 'a'.repeat(64),
}

describe('dispatchTranscode — mock mode', () => {
  it('short-circuits without fetching when MOCK_GITHUB_DISPATCH=true', async () => {
    const fetchSpy = vi.fn<typeof fetch>()
    const result = await dispatchTranscode(
      { ...ENV_OK, MOCK_GITHUB_DISPATCH: 'true' },
      PAYLOAD,
      fetchSpy,
    )
    expect(result.ok).toBe(true)
    expect(result.mocked).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('dispatchTranscode — config errors', () => {
  it('throws ConfigurationError when GITHUB_OWNER is missing', async () => {
    const fetchSpy = vi.fn<typeof fetch>()
    await expect(() =>
      dispatchTranscode({ ...ENV_OK, GITHUB_OWNER: undefined }, PAYLOAD, fetchSpy),
    ).rejects.toThrow(ConfigurationError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('throws ConfigurationError when GITHUB_DISPATCH_TOKEN is missing', async () => {
    const fetchSpy = vi.fn<typeof fetch>()
    await expect(() =>
      dispatchTranscode({ ...ENV_OK, GITHUB_DISPATCH_TOKEN: undefined }, PAYLOAD, fetchSpy),
    ).rejects.toThrow(ConfigurationError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('dispatchTranscode — happy path', () => {
  it('POSTs to the dispatches endpoint with the right body + headers', async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }))
    const result = await dispatchTranscode(ENV_OK, PAYLOAD, fetchSpy)
    expect(result).toEqual({ ok: true, mocked: false })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/zyra-project/terraviz/dispatches')
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer ghp_test')
    expect(headers.Accept).toBe('application/vnd.github+json')
    const body = JSON.parse(init?.body as string) as {
      event_type: string
      client_payload: typeof PAYLOAD
    }
    expect(body.event_type).toBe(TRANSCODE_HLS_EVENT_TYPE)
    expect(body.client_payload).toEqual(PAYLOAD)
  })
})

describe('dispatchTranscode — upstream errors', () => {
  it('throws UpstreamError carrying the HTTP status on non-204', async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ message: 'Bad credentials' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    await expect(() => dispatchTranscode(ENV_OK, PAYLOAD, fetchSpy)).rejects.toMatchObject({
      name: 'UpstreamError',
      status: 401,
    })
  })

  it('throws UpstreamError when fetch itself rejects', async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError('NetworkError'))
    await expect(() => dispatchTranscode(ENV_OK, PAYLOAD, fetchSpy)).rejects.toBeInstanceOf(
      UpstreamError,
    )
  })
})
