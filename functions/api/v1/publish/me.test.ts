import { describe, expect, it } from 'vitest'
import { onRequestGet } from './me'
import type { PublisherRow } from '../_lib/publisher-store'

const PUB: PublisherRow = {
  id: 'PUB001',
  email: 'staff@example.com',
  display_name: 'Staff User',
  affiliation: 'NOAA',
  org_id: null,
  role: 'staff',
  is_admin: 1,
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
}

describe('GET /api/v1/publish/me', () => {
  it('returns the publisher row from context.data', async () => {
    const ctx = {
      request: new Request('https://localhost/api/v1/publish/me'),
      env: {},
      params: {},
      data: { publisher: PUB },
      waitUntil: () => {},
      passThroughOnException: () => {},
      next: async () => new Response(null),
      functionPath: '/api/v1/publish/me',
    } as unknown as Parameters<PagesFunction>[0]
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const body = JSON.parse(await res.text()) as {
      id: string
      role: string
      is_admin: boolean
      status: string
    }
    expect(body.id).toBe('PUB001')
    expect(body.role).toBe('staff')
    expect(body.is_admin).toBe(true)
    expect(body.status).toBe('active')
  })
})
