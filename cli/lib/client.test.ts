import { describe, expect, it, vi } from 'vitest'
import { TerravizClient } from './client'

const SERVER = 'https://test.example'
const baseConfig = { server: SERVER, insecureLocal: false }

function recordingFetch(handler: (input: RequestInfo, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; method: string; headers: Headers; body: string | null }> = []
  const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    })
    return handler(input, init)
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

describe('TerravizClient', () => {
  it('attaches Access headers when both halves of the service token are set', async () => {
    const { fetchImpl, calls } = recordingFetch(
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    const client = new TerravizClient(
      { ...baseConfig, clientId: 'CID', clientSecret: 'SECRET' },
      { fetchImpl },
    )
    await client.me()
    expect(calls[0].headers.get('Cf-Access-Client-Id')).toBe('CID')
    expect(calls[0].headers.get('Cf-Access-Client-Secret')).toBe('SECRET')
  })

  it('omits Access headers under --insecure-local', async () => {
    const { fetchImpl, calls } = recordingFetch(
      () => new Response(JSON.stringify({}), { status: 200 }),
    )
    const client = new TerravizClient(
      { ...baseConfig, insecureLocal: true, clientId: 'x', clientSecret: 'y' },
      { fetchImpl },
    )
    await client.me()
    expect(calls[0].headers.get('Cf-Access-Client-Id')).toBeNull()
  })

  it('returns ok:true with parsed body for 2xx', async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ id: 'PUB1' }), { status: 200 }),
    )
    const client = new TerravizClient(baseConfig, { fetchImpl })
    const result = await client.me<{ id: string }>()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.body.id).toBe('PUB1')
  })

  it('returns ok:false with error envelope for 4xx', async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response(JSON.stringify({ error: 'unauthenticated', message: 'bad' }), {
          status: 401,
        }),
    )
    const client = new TerravizClient(baseConfig, { fetchImpl })
    const result = await client.me()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(401)
      expect(result.error).toBe('unauthenticated')
      expect(result.message).toBe('bad')
    }
  })

  it('captures structured validation errors on 400', async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            errors: [{ field: 'title', code: 'required', message: 'Title is required.' }],
          }),
          { status: 400 },
        ),
    )
    const client = new TerravizClient(baseConfig, { fetchImpl })
    const result = await client.createDataset({})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors?.[0].field).toBe('title')
    }
  })

  it('handles network errors as ok:false network_error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom')
    }) as unknown as typeof fetch
    const client = new TerravizClient(baseConfig, { fetchImpl })
    const result = await client.me()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('network_error')
    }
  })

  it('handles non-JSON 5xx bodies gracefully', async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response('<html>oops</html>', { status: 502 }),
    )
    const client = new TerravizClient(baseConfig, { fetchImpl })
    const result = await client.me()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(502)
      expect(result.error).toBe('non_json_response')
    }
  })

  it('list() builds a ?status=&limit=&cursor= query string', async () => {
    const { fetchImpl, calls } = recordingFetch(
      () => new Response(JSON.stringify({ datasets: [] }), { status: 200 }),
    )
    const client = new TerravizClient(baseConfig, { fetchImpl })
    await client.list({ status: 'draft', limit: 10, cursor: 'XYZ' })
    expect(calls[0].url).toBe(
      `${SERVER}/api/v1/publish/datasets?status=draft&limit=10&cursor=XYZ`,
    )
  })

  it('PUT updateDataset sends a JSON body', async () => {
    const { fetchImpl, calls } = recordingFetch(
      () => new Response(JSON.stringify({ dataset: {} }), { status: 200 }),
    )
    const client = new TerravizClient(baseConfig, { fetchImpl })
    await client.updateDataset('DS001', { title: 'New' })
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].headers.get('Content-Type')).toBe('application/json')
    expect(JSON.parse(calls[0].body!)).toEqual({ title: 'New' })
  })
})
