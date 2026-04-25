import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { TelemetryEvent, SessionStartEvent, LayerLoadedEvent } from '../../src/types'
import {
  onRequestPost,
  onRequestOptions,
  toDataPoint,
  environmentOf,
  countryOf,
  isInternalRequest,
  CF_ACCESS_HEADERS,
  __resetRateLimitState,
  MAX_BODY_BYTES,
  RATE_LIMIT_PER_IP,
  RATE_LIMIT_PER_SESSION,
  KILL_SWITCH_KEY,
} from './ingest'

// ─────────────────────────────────────────────────────────────────────
// Test scaffolding — minimal PagesFunction context mock
// ─────────────────────────────────────────────────────────────────────

interface Env {
  ANALYTICS?: AnalyticsEngineDataset
  TELEMETRY_KILL_SWITCH?: KVNamespace
  CF_PAGES?: string
  CF_PAGES_BRANCH?: string
}

interface FakeAE {
  datapoints: AnalyticsEngineDataPoint[]
  writeDataPoint: (p: AnalyticsEngineDataPoint) => void
}

function makeAE(): FakeAE {
  const datapoints: AnalyticsEngineDataPoint[] = []
  return {
    datapoints,
    writeDataPoint(p) {
      datapoints.push(p)
    },
  }
}

function makeKV(values: Record<string, string | null> = {}): KVNamespace {
  return {
    get: vi.fn(async (key: string) => values[key] ?? null),
  } as unknown as KVNamespace
}

interface CtxOpts {
  method?: string
  url?: string
  origin?: string | null
  body?: string | object
  headers?: Record<string, string>
  ip?: string
  env?: Partial<Env>
}

function makeCtx(opts: CtxOpts = {}): Parameters<typeof onRequestPost>[0] {
  // Build a lowercase header map. `Origin` is a forbidden request
  // header in Node's undici and gets silently dropped if we try to
  // set it on a real Request, so we fake the whole request object.
  const headers = new Map<string, string>()
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    headers.set(k.toLowerCase(), v)
  }
  if (opts.origin !== null) {
    headers.set('origin', opts.origin ?? 'http://localhost:5173')
  }
  if (opts.ip) headers.set('cf-connecting-ip', opts.ip)

  let bodyText = ''
  if (typeof opts.body === 'string') {
    bodyText = opts.body
  } else if (opts.body !== undefined) {
    bodyText = JSON.stringify(opts.body)
  }

  const fakeRequest = {
    method: opts.method ?? 'POST',
    url: opts.url ?? 'https://terraviz.pages.dev/api/ingest',
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
      has: (name: string) => headers.has(name.toLowerCase()),
    },
    text: async () => bodyText,
    json: async () => (bodyText ? JSON.parse(bodyText) : undefined),
  }

  return {
    request: fakeRequest as unknown as Request,
    env: (opts.env ?? {}) as Env,
    params: {},
    data: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/ingest',
  } as unknown as Parameters<typeof onRequestPost>[0]
}

function sessionStart(): SessionStartEvent {
  return {
    event_type: 'session_start',
    app_version: '0.2.3',
    platform: 'web',
    os: 'mac',
    locale: 'en-US',
    viewport_class: 'lg',
    aspect_class: 'wide',
    screen_class: '1080p',
    build_channel: 'public',
    vr_capable: 'none',
    schema_version: '1.0',
  }
}

function layerLoaded(id = 'A'): LayerLoadedEvent {
  return {
    event_type: 'layer_loaded',
    layer_id: id,
    layer_source: 'network',
    slot_index: '0',
    trigger: 'browse',
    load_ms: 1234,
  }
}

function body(events: TelemetryEvent[], session_id = 'session-1') {
  return { session_id, events }
}

// ─────────────────────────────────────────────────────────────────────
// environmentOf
// ─────────────────────────────────────────────────────────────────────

describe('environmentOf', () => {
  it('returns local when CF_PAGES is unset', () => {
    expect(environmentOf({})).toBe('local')
  })
  it('returns production when on main', () => {
    expect(environmentOf({ CF_PAGES: '1', CF_PAGES_BRANCH: 'main' })).toBe('production')
  })
  it('returns preview for feature branches', () => {
    expect(environmentOf({ CF_PAGES: '1', CF_PAGES_BRANCH: 'feature/x' })).toBe('preview')
  })
  it('returns preview when branch is empty but CF_PAGES is set', () => {
    expect(environmentOf({ CF_PAGES: '1' })).toBe('preview')
  })
})

// ─────────────────────────────────────────────────────────────────────
// countryOf
// ─────────────────────────────────────────────────────────────────────

describe('countryOf', () => {
  it('returns the upper-cased 2-letter code', () => {
    expect(countryOf('US')).toBe('US')
    expect(countryOf('de')).toBe('DE')
    expect(countryOf(' jp ')).toBe('JP')
  })

  it('returns XX for null / empty / wrong length', () => {
    expect(countryOf(null)).toBe('XX')
    expect(countryOf('')).toBe('XX')
    expect(countryOf('U')).toBe('XX')
    expect(countryOf('USA')).toBe('XX')
  })

  it('returns XX for non-alpha codes', () => {
    expect(countryOf('12')).toBe('XX')
    expect(countryOf('!!')).toBe('XX')
  })

  it('normalizes Cloudflare Tor / unknown pseudo-codes to XX', () => {
    expect(countryOf('T1')).toBe('XX')
    expect(countryOf('t1')).toBe('XX')
    expect(countryOf('XX')).toBe('XX')
  })
})

// ─────────────────────────────────────────────────────────────────────
// isInternalRequest
// ─────────────────────────────────────────────────────────────────────

function fakeRequest(headers: Record<string, string>): Request {
  const h = new Headers(headers)
  return { headers: h } as unknown as Request
}

describe('isInternalRequest', () => {
  it('returns true when Cf-Access-Authenticated-User-Email is present', () => {
    const req = fakeRequest({
      'Cf-Access-Authenticated-User-Email': 'alice@example.com',
    })
    expect(isInternalRequest(req)).toBe(true)
  })

  it('returns true when Cf-Access-Jwt-Assertion is present', () => {
    const req = fakeRequest({
      'Cf-Access-Jwt-Assertion': 'eyJhbGciOiJSUzI1NiJ9.payload.signature',
    })
    expect(isInternalRequest(req)).toBe(true)
  })

  it('returns false when no Cloudflare Access header is present', () => {
    const req = fakeRequest({})
    expect(isInternalRequest(req)).toBe(false)
  })

  it('returns false when the header is present but empty', () => {
    const req = fakeRequest({ 'Cf-Access-Authenticated-User-Email': '   ' })
    expect(isInternalRequest(req)).toBe(false)
  })

  it('exposes both header names in CF_ACCESS_HEADERS', () => {
    expect(CF_ACCESS_HEADERS).toContain('cf-access-authenticated-user-email')
    expect(CF_ACCESS_HEADERS).toContain('cf-access-jwt-assertion')
  })
})

// ─────────────────────────────────────────────────────────────────────
// toDataPoint
// ─────────────────────────────────────────────────────────────────────

describe('toDataPoint', () => {
  it('always puts event_type / environment / country / internal in blobs 1–4', () => {
    const dp = toDataPoint(sessionStart(), 'sess', 'production', 'US', false)
    expect(dp.blobs![0]).toBe('session_start')
    expect(dp.blobs![1]).toBe('production')
    expect(dp.blobs![2]).toBe('US')
    expect(dp.blobs![3]).toBe('false')
  })

  it('encodes internal=true in blob 4', () => {
    const dp = toDataPoint(sessionStart(), 'sess', 'production', 'US', true)
    expect(dp.blobs![3]).toBe('true')
  })

  it('puts the session_id in indexes', () => {
    const dp = toDataPoint(sessionStart(), 'abc-123', 'production', 'US', false)
    expect(dp.indexes).toEqual(['abc-123'])
  })

  it('separates string and number fields into blobs and doubles', () => {
    const dp = toDataPoint(layerLoaded('X'), 'sess', 'production', 'DE', false)
    // Strings: layer_id, layer_source, slot_index, trigger (plus event_type + environment + country + internal)
    expect(dp.blobs!.length).toBeGreaterThanOrEqual(8)
    expect(dp.blobs!).toContain('X')
    expect(dp.blobs!).toContain('network')
    // Numbers: load_ms (and possibly client_offset_ms if stamped, though
    // call sites in these tests don't stamp it)
    expect(dp.doubles!).toContain(1234)
  })

  it('serializes event-level booleans as "true" / "false" strings into blobs', () => {
    const event = {
      ...sessionStart(),
      resumed: true,
    }
    const dp = toDataPoint(event, 'sess', 'production', 'US', false)
    // Both the server-stamped internal blob and the event's resumed
    // field should appear; the event field lands at blob 5+ after
    // alphabetical ordering.
    expect(dp.blobs!.filter((b) => b === 'true').length).toBeGreaterThanOrEqual(1)
  })

  it('skips null and undefined fields entirely', () => {
    const event = {
      event_type: 'vr_session_ended',
      mode: 'vr',
      exit_reason: 'user',
      duration_ms: 5000,
      mean_fps: null,
    } as unknown as TelemetryEvent
    const dp = toDataPoint(event, 'sess', 'production', 'US', false)
    // null mean_fps should not appear anywhere
    expect(dp.doubles!.includes(NaN)).toBe(false)
    expect(dp.blobs!.includes('null')).toBe(false)
  })

  it('orders per-event string fields alphabetically after the four server blobs', () => {
    // app_version comes before the other alphabetically-ordered
    // fields, but sits in blob5 because blobs 1–4 are the server-
    // stamped event_type / environment / country / internal.
    const dp = toDataPoint(sessionStart(), 'sess', 'production', 'JP', false)
    expect(dp.blobs![0]).toBe('session_start')
    expect(dp.blobs![1]).toBe('production')
    expect(dp.blobs![2]).toBe('JP')
    expect(dp.blobs![3]).toBe('false')
    expect(dp.blobs![4]).toBe('0.2.3') // app_version
  })

  it('accepts XX for unknown country', () => {
    const dp = toDataPoint(sessionStart(), 'sess', 'production', 'XX', false)
    expect(dp.blobs![2]).toBe('XX')
  })
})

// ─────────────────────────────────────────────────────────────────────
// onRequestPost — happy path
// ─────────────────────────────────────────────────────────────────────

describe('onRequestPost — happy path', () => {
  beforeEach(() => {
    __resetRateLimitState()
  })

  it('returns 204 and writes datapoints for a valid batch', async () => {
    const ae = makeAE()
    const ctx = makeCtx({
      body: body([sessionStart(), layerLoaded('A'), layerLoaded('B')]),
      ip: '10.0.0.1',
      env: { ANALYTICS: ae as unknown as AnalyticsEngineDataset },
    })
    const res = await onRequestPost(ctx)
    expect(res.status).toBe(204)
    expect(ae.datapoints.length).toBe(3)
    // All datapoints carry the session ID as an index.
    for (const dp of ae.datapoints) {
      expect(dp.indexes).toEqual(['session-1'])
    }
  })

  it('injects the environment tag on every datapoint', async () => {
    const ae = makeAE()
    const ctx = makeCtx({
      body: body([sessionStart()]),
      ip: '10.0.0.2',
      env: {
        ANALYTICS: ae as unknown as AnalyticsEngineDataset,
        CF_PAGES: '1',
        CF_PAGES_BRANCH: 'main',
      },
    })
    await onRequestPost(ctx)
    expect(ae.datapoints[0].blobs![1]).toBe('production')
  })

  it('injects the country tag from CF-IPCountry on every datapoint', async () => {
    const ae = makeAE()
    const ctx = makeCtx({
      body: body([sessionStart(), layerLoaded('A')]),
      ip: '10.0.0.7',
      headers: { 'CF-IPCountry': 'DE' },
      env: { ANALYTICS: ae as unknown as AnalyticsEngineDataset },
    })
    await onRequestPost(ctx)
    expect(ae.datapoints).toHaveLength(2)
    for (const dp of ae.datapoints) {
      expect(dp.blobs![2]).toBe('DE')
    }
  })

  it('defaults country to XX when CF-IPCountry is missing', async () => {
    const ae = makeAE()
    const ctx = makeCtx({
      body: body([sessionStart()]),
      ip: '10.0.0.8',
      env: { ANALYTICS: ae as unknown as AnalyticsEngineDataset },
    })
    await onRequestPost(ctx)
    expect(ae.datapoints[0].blobs![2]).toBe('XX')
  })

  it('normalizes Tor origin (T1) to XX', async () => {
    const ae = makeAE()
    const ctx = makeCtx({
      body: body([sessionStart()]),
      ip: '10.0.0.9',
      headers: { 'CF-IPCountry': 'T1' },
      env: { ANALYTICS: ae as unknown as AnalyticsEngineDataset },
    })
    await onRequestPost(ctx)
    expect(ae.datapoints[0].blobs![2]).toBe('XX')
  })

  it('stamps internal=true on every datapoint when Cloudflare Access header is present', async () => {
    const ae = makeAE()
    const ctx = makeCtx({
      body: body([sessionStart(), layerLoaded('A')]),
      ip: '10.0.0.10',
      headers: { 'Cf-Access-Authenticated-User-Email': 'alice@example.com' },
      env: { ANALYTICS: ae as unknown as AnalyticsEngineDataset },
    })
    await onRequestPost(ctx)
    expect(ae.datapoints).toHaveLength(2)
    for (const dp of ae.datapoints) {
      expect(dp.blobs![3]).toBe('true')
    }
  })

  it('defaults internal=false when no Access header is present', async () => {
    const ae = makeAE()
    const ctx = makeCtx({
      body: body([sessionStart()]),
      ip: '10.0.0.11',
      env: { ANALYTICS: ae as unknown as AnalyticsEngineDataset },
    })
    await onRequestPost(ctx)
    expect(ae.datapoints[0].blobs![3]).toBe('false')
  })

  it('stamps internal=true when the JWT assertion header is present', async () => {
    const ae = makeAE()
    const ctx = makeCtx({
      body: body([sessionStart()]),
      ip: '10.0.0.12',
      headers: {
        'Cf-Access-Jwt-Assertion': 'eyJhbGciOiJSUzI1NiJ9.payload.signature',
      },
      env: { ANALYTICS: ae as unknown as AnalyticsEngineDataset },
    })
    await onRequestPost(ctx)
    expect(ae.datapoints[0].blobs![3]).toBe('true')
  })

  it('accepts a request without the ANALYTICS binding and returns 204', async () => {
    const ctx = makeCtx({
      body: body([sessionStart()]),
      ip: '10.0.0.3',
      env: {}, // no ANALYTICS
    })
    const res = await onRequestPost(ctx)
    expect(res.status).toBe(204)
  })

  it('sets CORS headers on success', async () => {
    const ae = makeAE()
    const ctx = makeCtx({
      body: body([sessionStart()]),
      ip: '10.0.0.4',
      origin: 'http://localhost:5173',
      env: { ANALYTICS: ae as unknown as AnalyticsEngineDataset },
    })
    const res = await onRequestPost(ctx)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
  })

  it('accepts same-origin requests regardless of the allowlist', async () => {
    const ae = makeAE()
    const ctx = makeCtx({
      url: 'https://terraviz.pages.dev/api/ingest',
      origin: 'https://terraviz.pages.dev',
      body: body([sessionStart()]),
      ip: '10.0.0.5',
      env: { ANALYTICS: ae as unknown as AnalyticsEngineDataset },
    })
    const res = await onRequestPost(ctx)
    expect(res.status).toBe(204)
  })

  it('accepts any *.pages.dev subdomain origin', async () => {
    const ae = makeAE()
    const ctx = makeCtx({
      url: 'https://main.example.pages.dev/api/ingest',
      origin: 'https://preview-abc.terraviz.pages.dev',
      body: body([sessionStart()]),
      ip: '10.0.0.6',
      env: { ANALYTICS: ae as unknown as AnalyticsEngineDataset },
    })
    const res = await onRequestPost(ctx)
    expect(res.status).toBe(204)
  })
})

// ─────────────────────────────────────────────────────────────────────
// onRequestPost — rejection paths
// ─────────────────────────────────────────────────────────────────────

describe('onRequestPost — rejections', () => {
  beforeEach(() => {
    __resetRateLimitState()
  })

  it('rejects missing Origin with 403', async () => {
    const ctx = makeCtx({ origin: null, body: body([sessionStart()]) })
    const res = await onRequestPost(ctx)
    expect(res.status).toBe(403)
  })

  it('rejects a disallowed Origin with 403', async () => {
    const ctx = makeCtx({ origin: 'https://evil.example', body: body([sessionStart()]) })
    const res = await onRequestPost(ctx)
    expect(res.status).toBe(403)
  })

  it('rejects invalid JSON with 400', async () => {
    const ctx = makeCtx({ body: '{not json' })
    const res = await onRequestPost(ctx)
    expect(res.status).toBe(400)
  })

  it('rejects a body missing session_id with 400', async () => {
    const ctx = makeCtx({ body: { events: [sessionStart()] } })
    const res = await onRequestPost(ctx)
    expect(res.status).toBe(400)
  })

  it('rejects a body missing events with 400', async () => {
    const ctx = makeCtx({ body: { session_id: 'sess' } })
    const res = await onRequestPost(ctx)
    expect(res.status).toBe(400)
  })

  it('rejects an empty events array with 400', async () => {
    const ctx = makeCtx({ body: { session_id: 'sess', events: [] } })
    const res = await onRequestPost(ctx)
    expect(res.status).toBe(400)
  })

  it('rejects an unknown event_type with 400 (fail closed)', async () => {
    const ctx = makeCtx({
      body: { session_id: 'sess', events: [{ event_type: 'sql_injection_attempt' }] },
    })
    const res = await onRequestPost(ctx)
    expect(res.status).toBe(400)
  })

  it('rejects an event with a nested object field with 400', async () => {
    const ctx = makeCtx({
      body: {
        session_id: 'sess',
        events: [{
          event_type: 'session_start',
          // nested object should never survive validation
          malicious: { nested: 'payload' },
        }],
      },
    })
    const res = await onRequestPost(ctx)
    expect(res.status).toBe(400)
  })

  it('rejects oversized Content-Length with 413 before reading body', async () => {
    const ctx = makeCtx({
      body: body([sessionStart()]),
      headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) },
      ip: '10.0.1.1',
    })
    const res = await onRequestPost(ctx)
    expect(res.status).toBe(413)
  })

  it('rejects non-finite numbers with 400', async () => {
    // JSON.parse cannot produce NaN/Infinity, so this tests our
    // Number.isFinite guard via an explicit encode bypass.
    const ctx = makeCtx({
      body: `{"session_id":"sess","events":[{"event_type":"layer_loaded","load_ms":1e400}]}`,
    })
    const res = await onRequestPost(ctx)
    expect(res.status).toBe(400)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Rate limiting
// ─────────────────────────────────────────────────────────────────────

describe('onRequestPost — rate limits', () => {
  beforeEach(() => {
    __resetRateLimitState()
  })

  it('returns 429 after RATE_LIMIT_PER_IP requests from the same IP', async () => {
    for (let i = 0; i < RATE_LIMIT_PER_IP; i++) {
      // Use distinct session IDs so the per-session limit doesn't
      // kick in first.
      const ctx = makeCtx({
        body: body([sessionStart()], `sess-${i}`),
        ip: '10.0.2.1',
      })
      const res = await onRequestPost(ctx)
      expect(res.status).toBe(204)
    }
    const overCtx = makeCtx({
      body: body([sessionStart()], 'sess-over'),
      ip: '10.0.2.1',
    })
    const over = await onRequestPost(overCtx)
    expect(over.status).toBe(429)
  })

  it('returns 429 after RATE_LIMIT_PER_SESSION requests from one session', async () => {
    for (let i = 0; i < RATE_LIMIT_PER_SESSION; i++) {
      // Use distinct IPs so the per-IP limit doesn't kick in first.
      const ctx = makeCtx({
        body: body([sessionStart()], 'sticky-session'),
        ip: `10.0.3.${i}`,
      })
      const res = await onRequestPost(ctx)
      expect(res.status).toBe(204)
    }
    const overCtx = makeCtx({
      body: body([sessionStart()], 'sticky-session'),
      ip: '10.0.3.200',
    })
    const over = await onRequestPost(overCtx)
    expect(over.status).toBe(429)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Kill switch
// ─────────────────────────────────────────────────────────────────────

describe('onRequestPost — kill switch', () => {
  beforeEach(() => {
    __resetRateLimitState()
  })

  it('returns 410 when the kill switch value is "disabled"', async () => {
    const ae = makeAE()
    const kv = makeKV({ [KILL_SWITCH_KEY]: 'disabled' })
    const ctx = makeCtx({
      body: body([sessionStart()]),
      ip: '10.0.4.1',
      env: {
        ANALYTICS: ae as unknown as AnalyticsEngineDataset,
        TELEMETRY_KILL_SWITCH: kv,
      },
    })
    const res = await onRequestPost(ctx)
    expect(res.status).toBe(410)
    expect(res.headers.get('Retry-After')).toBe('300')
    // No datapoints should have been written
    expect(ae.datapoints.length).toBe(0)
  })

  it('also trips on "false"', async () => {
    const kv = makeKV({ [KILL_SWITCH_KEY]: 'false' })
    const ctx = makeCtx({
      body: body([sessionStart()]),
      ip: '10.0.4.2',
      env: { TELEMETRY_KILL_SWITCH: kv },
    })
    const res = await onRequestPost(ctx)
    expect(res.status).toBe(410)
  })

  it('allows traffic when the kill switch is set to "true"', async () => {
    const kv = makeKV({ [KILL_SWITCH_KEY]: 'true' })
    const ctx = makeCtx({
      body: body([sessionStart()]),
      ip: '10.0.4.3',
      env: { TELEMETRY_KILL_SWITCH: kv },
    })
    const res = await onRequestPost(ctx)
    expect(res.status).toBe(204)
  })

  it('allows traffic when the KV key is absent', async () => {
    const kv = makeKV({})
    const ctx = makeCtx({
      body: body([sessionStart()]),
      ip: '10.0.4.4',
      env: { TELEMETRY_KILL_SWITCH: kv },
    })
    const res = await onRequestPost(ctx)
    expect(res.status).toBe(204)
  })

  it('fails open when the KV binding itself is absent', async () => {
    const ctx = makeCtx({
      body: body([sessionStart()]),
      ip: '10.0.4.5',
      env: {}, // no TELEMETRY_KILL_SWITCH
    })
    const res = await onRequestPost(ctx)
    expect(res.status).toBe(204)
  })
})

// ─────────────────────────────────────────────────────────────────────
// OPTIONS (CORS preflight)
// ─────────────────────────────────────────────────────────────────────

describe('onRequestOptions', () => {
  it('returns 204 with CORS headers for an allowed origin', async () => {
    const ctx = makeCtx({ method: 'OPTIONS', origin: 'http://localhost:5173' })
    const res = await onRequestOptions(ctx)
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST')
  })

  it('returns 403 for a disallowed origin', async () => {
    const ctx = makeCtx({ method: 'OPTIONS', origin: 'https://evil.example' })
    const res = await onRequestOptions(ctx)
    expect(res.status).toBe(403)
  })
})
