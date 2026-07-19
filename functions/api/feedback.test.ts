/**
 * Wire-level tests for POST /api/feedback's payload dispatch — the
 * standalone-widget branch (`_standalone-feedback.ts`) plus a
 * regression check that the Orbit AI thumbs branch kept its
 * origin-gated behaviour. The feedback tables live in the root
 * `migrations/` dir, so the fixture applies those migrations itself
 * (same pattern as `v1/publish/feedback.test.ts`).
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { onRequestPost as feedbackPost, onRequestOptions as feedbackOptions } from './feedback'
import { decodePngDataUrl } from './_standalone-feedback'
import { asD1 } from './v1/_lib/test-helpers'

const MIGRATIONS_DIR = resolve(__dirname, '../../migrations')

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
  for (const file of files) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), 'utf-8'))
  }
  return db
}

interface FakeR2Put {
  key: string
  bytes: Uint8Array
  contentType?: string
}

function fakeR2() {
  const puts: FakeR2Put[] = []
  const bucket = {
    async put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
      puts.push({ key, bytes: value, contentType: opts?.httpMetadata?.contentType })
      return {}
    },
  }
  return { puts, bucket: bucket as unknown as R2Bucket }
}

/** A tiny but magic-valid PNG payload as a data URL. */
function pngDataUrl(extraBytes = 16): string {
  const bytes = new Uint8Array(8 + extraBytes)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  for (let i = 8; i < bytes.length; i++) bytes[i] = i % 251
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
}

function widgetBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'terraviz-standalone',
    type: 'idea',
    rating: 4,
    text: 'Test from vitest',
    name: null,
    email: null,
    meta: { when: '2026-07-19T00:00:00Z', viewport: '800×600', dpr: 1, uiScale: 1, ua: 'curl' },
    screenshot: null,
    ...overrides,
  }
}

function ctx(opts: {
  env?: Record<string, unknown>
  body?: unknown
  rawBody?: string
  headers?: Record<string, string>
  method?: string
}) {
  const headers = new Headers({ 'Content-Type': 'application/json', ...(opts.headers ?? {}) })
  const request = new Request('https://terraviz.zyra-project.org/api/feedback', {
    method: opts.method ?? 'POST',
    headers,
    body: opts.method === 'OPTIONS' ? undefined : (opts.rawBody ?? JSON.stringify(opts.body ?? {})),
  })
  return {
    request,
    env: opts.env ?? {},
    params: {},
    data: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/feedback',
  } as unknown as Parameters<typeof feedbackPost>[0]
}

/**
 * happy-dom's Request implements the browser's forbidden-header list,
 * silently dropping `Origin` and `Content-Length`. Tests that need
 * those headers use this hand-rolled stub instead — the handlers only
 * touch `request.headers.get()`, `request.text()`, and `request.url`.
 */
function stubCtx(opts: {
  env?: Record<string, unknown>
  rawBody: string
  headers?: Record<string, string>
}) {
  const lower = new Map(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    request: {
      url: 'https://terraviz.zyra-project.org/api/feedback',
      headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
      text: async () => opts.rawBody,
    },
    env: opts.env ?? {},
    params: {},
    data: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/feedback',
  } as unknown as Parameters<typeof feedbackPost>[0]
}

describe('POST /api/feedback — standalone widget branch', () => {
  it('accepts a curl-style submission (no Origin header) with wildcard CORS and stores the row', async () => {
    const sqlite = freshDb()
    const res = await feedbackPost(ctx({
      env: { FEEDBACK_DB: asD1(sqlite) },
      body: widgetBody(),
      headers: { 'CF-IPCountry': 'US' },
    }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    const payload = (await res.json()) as { ok: boolean; id: string }
    expect(payload.ok).toBe(true)
    expect(payload.id).toMatch(/^\d+$/)

    const row = sqlite.prepare('SELECT * FROM general_feedback WHERE id = ?').get(Number(payload.id)) as Record<string, unknown>
    expect(row).toMatchObject({
      kind: 'idea',
      message: 'Test from vitest',
      rating: 4,
      source: 'terraviz-standalone',
      status: 'new',
      country: 'US',
      screenshot_r2_key: '',
    })
    expect(JSON.parse(row.meta as string)).toMatchObject({ viewport: '800×600', dpr: 1 })
  })

  it('stores reporter name/email and the dataset display string from meta', async () => {
    const sqlite = freshDb()
    const res = await feedbackPost(ctx({
      env: { FEEDBACK_DB: asD1(sqlite) },
      body: widgetBody({
        name: 'Ada',
        email: 'ada@example.com',
        meta: { dataset: 'Sea Surface Temperature (sst-anomaly)' },
      }),
    }))
    expect(res.status).toBe(200)
    const row = sqlite.prepare('SELECT reporter_name, contact, dataset_id FROM general_feedback').get() as Record<string, unknown>
    expect(row).toEqual({
      reporter_name: 'Ada',
      contact: 'ada@example.com',
      dataset_id: 'Sea Surface Temperature (sst-anomaly)',
    })
  })

  it('rejects invalid type, empty text, oversize text, and out-of-range ratings', async () => {
    const env = { FEEDBACK_DB: asD1(freshDb()) }
    const bad = [
      widgetBody({ type: 'rant' }),
      widgetBody({ text: '   ' }),
      widgetBody({ text: 'x'.repeat(5001) }),
      widgetBody({ rating: 0 }),
      widgetBody({ rating: 6 }),
      widgetBody({ rating: 2.5 }),
    ]
    for (const body of bad) {
      const res = await feedbackPost(ctx({ env, body }))
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400)
    }
  })

  it('rejects non-JSON bodies and oversize payloads', async () => {
    const env = { FEEDBACK_DB: asD1(freshDb()) }
    expect((await feedbackPost(ctx({ env, rawBody: 'not json' }))).status).toBe(400)
    // Declared-length fast path…
    expect(
      (await feedbackPost(stubCtx({ env, rawBody: '{}', headers: { 'Content-Length': '99999999' } }))).status,
    ).toBe(413)
    // …and the actual-body backstop for requests that lie about it.
    expect(
      (await feedbackPost(stubCtx({ env, rawBody: '9'.repeat(12_500_001) }))).status,
    ).toBe(413)
  })

  it('decodes a PNG screenshot into R2 and stores only the key', async () => {
    const sqlite = freshDb()
    const { puts, bucket } = fakeR2()
    const res = await feedbackPost(ctx({
      env: { FEEDBACK_DB: asD1(sqlite), CATALOG_R2: bucket },
      body: widgetBody({ screenshot: pngDataUrl() }),
    }))
    expect(res.status).toBe(200)
    expect(puts).toHaveLength(1)
    expect(puts[0].key).toMatch(/^feedback\/screenshots\/[0-9a-f-]+\.png$/)
    expect(puts[0].contentType).toBe('image/png')
    expect(Array.from(puts[0].bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])

    const row = sqlite.prepare('SELECT screenshot, screenshot_r2_key FROM general_feedback').get() as Record<string, string>
    expect(row.screenshot_r2_key).toBe(puts[0].key)
    expect(row.screenshot).toBe('') // never base64 in the row
  })

  it('rejects non-PNG screenshot data URLs', async () => {
    const env = { FEEDBACK_DB: asD1(freshDb()), CATALOG_R2: fakeR2().bucket }
    for (const screenshot of [
      'data:image/jpeg;base64,/9j/4AAQ',
      'data:image/png;base64,!!!not-base64!!!',
      `data:image/png;base64,${Buffer.from('not a png').toString('base64')}`,
      'https://example.com/x.png',
    ]) {
      const res = await feedbackPost(ctx({ env, body: widgetBody({ screenshot }) }))
      expect(res.status, screenshot.slice(0, 40)).toBe(400)
    }
  })

  it('still stores the report when R2 is unbound (screenshot dropped, not the text)', async () => {
    const sqlite = freshDb()
    const res = await feedbackPost(ctx({
      env: { FEEDBACK_DB: asD1(sqlite) },
      body: widgetBody({ screenshot: pngDataUrl() }),
    }))
    expect(res.status).toBe(200)
    const row = sqlite.prepare('SELECT message, screenshot_r2_key FROM general_feedback').get() as Record<string, string>
    expect(row.message).toBe('Test from vitest')
    expect(row.screenshot_r2_key).toBe('')
  })

  it('fails honestly with 503 when FEEDBACK_DB is unbound (client falls back to mailto)', async () => {
    const res = await feedbackPost(ctx({ env: {}, body: widgetBody() }))
    expect(res.status).toBe(503)
  })

  it('rate-limits per IP after 10 submissions in the window', async () => {
    const env = { FEEDBACK_DB: asD1(freshDb()) }
    let last = 0
    for (let i = 0; i < 11; i++) {
      const res = await feedbackPost(ctx({
        env,
        body: widgetBody(),
        headers: { 'CF-Connecting-IP': '203.0.113.77' },
      }))
      last = res.status
      if (i < 10) expect(res.status, `request ${i + 1}`).toBe(200)
    }
    expect(last).toBe(429)
  })
})

describe('POST /api/feedback — AI thumbs branch regression', () => {
  const aiBody = {
    rating: 'thumbs-up',
    comment: 'nice',
    messageId: 'msg-1',
    messages: [{ id: 'msg-1', role: 'docent', text: 'hello', timestamp: 1 }],
    datasetId: null,
    timestamp: 1,
  }

  it('still enforces the origin gate (no Origin → 403)', async () => {
    const res = await feedbackPost(ctx({ env: { FEEDBACK_DB: asD1(freshDb()) }, body: aiBody }))
    expect(res.status).toBe(403)
  })

  it('still stores thumbs feedback from an allowed origin', async () => {
    const sqlite = freshDb()
    const res = await feedbackPost(stubCtx({
      env: { FEEDBACK_DB: asD1(sqlite) },
      rawBody: JSON.stringify(aiBody),
      headers: { Origin: 'http://localhost:5173' },
    }))
    expect(res.status).toBe(200)
    const row = sqlite.prepare('SELECT rating, message_id FROM feedback').get() as Record<string, string>
    expect(row).toEqual({ rating: 'thumbs-up', message_id: 'msg-1' })
  })
})

describe('OPTIONS /api/feedback', () => {
  it('answers preflight from any origin with wildcard CORS', async () => {
    const res = await feedbackOptions(ctx({ method: 'OPTIONS', headers: { Origin: 'https://anywhere.example' } }))
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST')
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type')
  })
})

describe('decodePngDataUrl', () => {
  it('round-trips a valid PNG and rejects bad magic', () => {
    const good = decodePngDataUrl(pngDataUrl(4))
    expect(good).not.toBeNull()
    expect(good!.length).toBe(12)
    expect(decodePngDataUrl(`data:image/png;base64,${Buffer.from('GIF89a').toString('base64')}`)).toBeNull()
  })
})
