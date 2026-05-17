import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  publisherGet,
  publisherSend,
  handleSessionError,
  clearWarmupFlag,
  warmupAlreadyAttempted,
  buildSignInUrl,
} from './api'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function opaqueRedirect(): Response {
  return Object.assign(new Response('', { status: 200 }), {
    type: 'opaqueredirect' as const,
    status: 0,
  })
}

describe('publisherGet', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('returns ok+data on a 200 JSON response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ value: 42 }))
    const result = await publisherGet<{ value: number }>('/api/v1/publish/me', { fetchFn })
    expect(result).toEqual({ ok: true, data: { value: 42 } })
  })

  it('passes redirect: manual and credentials: same-origin', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}))
    await publisherGet('/api/v1/publish/me', { fetchFn })
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/publish/me',
      expect.objectContaining({
        redirect: 'manual',
        credentials: 'same-origin',
      }),
    )
  })

  it('returns network on a thrown fetch', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const result = await publisherGet('/api/v1/publish/me', { fetchFn })
    expect(result).toEqual({ ok: false, kind: 'network' })
  })

  it('returns session on 401', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    const result = await publisherGet('/api/v1/publish/me', { fetchFn })
    expect(result).toEqual({ ok: false, kind: 'session' })
  })

  it('returns server on 5xx with status + body for operator debugging', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'identity_missing', message: 'No node identity.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const result = await publisherGet('/api/v1/publish/me', { fetchFn })
    expect(result.ok).toBe(false)
    if (!result.ok && result.kind === 'server') {
      expect(result.status).toBe(503)
      expect(result.body).toContain('identity_missing')
    } else {
      throw new Error('expected kind: server')
    }
  })

  it('returns server when JSON parse fails (the parse-failure path lands on the JSON-success branch)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response('not json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const result = await publisherGet('/api/v1/publish/me', { fetchFn })
    // Parse failure on a 200 response falls into the catch-all
    // server case, but `res.ok` was true at the time so the
    // helper returns the lightweight server kind without
    // status/body.
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind === 'server' || result.kind === 'network').toBe(true)
    }
  })

  it('retries once on opaqueredirect and returns ok when the retry succeeds', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(opaqueRedirect())
      .mockResolvedValueOnce(jsonResponse({ value: 1 }))
    const sleep = vi.fn().mockResolvedValue(undefined)
    const result = await publisherGet<{ value: number }>('/api/v1/publish/me', {
      fetchFn,
      sleep,
    })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledOnce()
    expect(result).toEqual({ ok: true, data: { value: 1 } })
  })

  it('returns session when both attempts are opaqueredirect', async () => {
    const fetchFn = vi.fn().mockResolvedValue(opaqueRedirect())
    const sleep = vi.fn().mockResolvedValue(undefined)
    const result = await publisherGet('/api/v1/publish/me', { fetchFn, sleep })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ ok: false, kind: 'session' })
  })

  it('returns network when the retry throws', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(opaqueRedirect())
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const sleep = vi.fn().mockResolvedValue(undefined)
    const result = await publisherGet('/api/v1/publish/me', { fetchFn, sleep })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ ok: false, kind: 'network' })
  })
})

describe('publisherSend', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('POSTs the JSON body and returns the response on 201', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ dataset: { id: 'NEW' } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const result = await publisherSend<{ dataset: { id: string } }>(
      '/api/v1/publish/datasets',
      { title: 'My dataset' },
      { fetchFn },
    )
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/publish/datasets',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'manual',
        body: JSON.stringify({ title: 'My dataset' }),
      }),
    )
    expect(result).toEqual({ ok: true, data: { dataset: { id: 'NEW' } } })
  })

  it('honours method: PUT for updates', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    await publisherSend(
      '/api/v1/publish/datasets/01ABC',
      { title: 'Renamed' },
      { fetchFn, method: 'PUT' },
    )
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/publish/datasets/01ABC',
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  it('returns kind: validation with errors on 400', async () => {
    const errorsBody = {
      errors: [
        { field: 'title', code: 'too_short', message: 'Title must be at least 3 characters.' },
        { field: 'format', code: 'required', message: 'Format is required.' },
      ],
    }
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(errorsBody), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const result = await publisherSend('/api/v1/publish/datasets', {}, { fetchFn })
    expect(result).toEqual({
      ok: false,
      kind: 'validation',
      errors: errorsBody.errors,
    })
  })

  it('synthesises a root-level validation error when 400 body is unparseable', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response('garbage', {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const result = await publisherSend('/api/v1/publish/datasets', {}, { fetchFn })
    expect(result.ok).toBe(false)
    if (!result.ok && result.kind === 'validation') {
      expect(result.errors[0].field).toBe('_root')
    }
  })

  it('returns kind: validation with synthetic root error when 400 body has no errors array', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'bad request' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const result = await publisherSend('/api/v1/publish/datasets', {}, { fetchFn })
    expect(result.ok).toBe(false)
    if (!result.ok && result.kind === 'validation') {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].field).toBe('_root')
    }
  })

  it('parses 409 with errors envelope as validation (publish-while-transcoding)', async () => {
    // PR #112 followup: the /publish endpoint returns 409 with
    // a field-level `{ errors: [{ field: 'transcoding', ... }] }`
    // envelope when the row is mid-transcode. The client needs
    // to surface that as a per-field error so the form renders a
    // precise message rather than a generic toast.
    const errorsBody = {
      errors: [
        {
          field: 'transcoding',
          code: 'transcoding_in_progress',
          message:
            'Cannot publish while a video transcode is in flight. Wait for it to finish.',
        },
      ],
    }
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(errorsBody), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const result = await publisherSend('/api/v1/publish/datasets/01XYZ/publish', {}, { fetchFn })
    expect(result).toEqual({
      ok: false,
      kind: 'validation',
      errors: errorsBody.errors,
    })
  })

  it('returns kind: server for 409 without errors envelope (transcode_upload_mismatch)', async () => {
    // The other 409 envelope: `{ error, message }` from
    // jsonError(). Should fall through to the generic
    // server-error shape so the caller can read the simple
    // envelope without misclassifying as a validation failure.
    const conflictBody = {
      error: 'transcode_upload_mismatch',
      message: 'Active transcode is bound to a different upload.',
    }
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(conflictBody), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const result = await publisherSend(
      '/api/v1/publish/datasets/01XYZ/transcode-complete',
      {},
      { fetchFn },
    )
    expect(result.ok).toBe(false)
    if (!result.ok && result.kind === 'server') {
      expect(result.status).toBe(409)
      expect(result.body).toContain('transcode_upload_mismatch')
    } else {
      expect.fail('expected kind: server for 409 without errors envelope')
    }
  })

  it('returns kind: session on 401', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    const result = await publisherSend('/api/v1/publish/datasets', {}, { fetchFn })
    expect(result).toEqual({ ok: false, kind: 'session' })
  })

  it('returns kind: not_found on 404', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    const result = await publisherSend(
      '/api/v1/publish/datasets/missing',
      {},
      { fetchFn, method: 'PUT' },
    )
    expect(result).toEqual({ ok: false, kind: 'not_found' })
  })

  it('returns kind: server on 5xx with status + body for operator debugging', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'identity_missing', message: 'No node identity.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const result = await publisherSend('/api/v1/publish/datasets', {}, { fetchFn })
    expect(result.ok).toBe(false)
    if (!result.ok && result.kind === 'server') {
      expect(result.status).toBe(503)
      expect(result.body).toContain('identity_missing')
    } else {
      throw new Error('expected kind: server')
    }
  })

  it('retries once on opaqueredirect and succeeds on the retry', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(opaqueRedirect())
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    const sleep = vi.fn().mockResolvedValue(undefined)
    const result = await publisherSend('/api/v1/publish/datasets', {}, { fetchFn, sleep })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledOnce()
    expect(result.ok).toBe(true)
  })

  it('tolerates a 204 No Content response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    const result = await publisherSend('/api/v1/publish/datasets/01ABC', {}, {
      fetchFn,
      method: 'DELETE',
    })
    expect(result).toEqual({ ok: true, data: undefined })
  })
})

describe('handleSessionError', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  afterEach(() => {
    sessionStorage.clear()
  })

  it("returns 'navigating' and marks the warmup flag on a fresh call", () => {
    const navigate = vi.fn()
    const action = handleSessionError({ navigate })
    expect(action).toBe('navigating')
    expect(warmupAlreadyAttempted()).toBe(true)
    expect(navigate).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/v1\/publish\/redirect-back\?to=/),
    )
  })

  it("returns 'show-error' and clears the flag when warmup already attempted", () => {
    sessionStorage.setItem('publisher_warmup_attempted', '1')
    const navigate = vi.fn()
    const action = handleSessionError({ navigate })
    expect(action).toBe('show-error')
    expect(warmupAlreadyAttempted()).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe('buildSignInUrl', () => {
  it('encodes the current pathname + search into the to= parameter', () => {
    // jsdom defaults to / for window.location; we set a more
    // interesting path to verify encoding behaviour.
    window.history.replaceState(null, '', '/publish/datasets/abc-123')
    const url = buildSignInUrl()
    expect(url).toBe(
      `/api/v1/publish/redirect-back?to=${encodeURIComponent('/publish/datasets/abc-123')}`,
    )
    // restore for other tests
    window.history.replaceState(null, '', '/')
  })
})

describe('clearWarmupFlag', () => {
  it('is a no-op when no flag is set', () => {
    sessionStorage.clear()
    expect(() => clearWarmupFlag()).not.toThrow()
    expect(warmupAlreadyAttempted()).toBe(false)
  })

  it('clears an existing flag', () => {
    sessionStorage.setItem('publisher_warmup_attempted', '1')
    clearWarmupFlag()
    expect(warmupAlreadyAttempted()).toBe(false)
  })
})
