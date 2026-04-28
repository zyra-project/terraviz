/**
 * Thin HTTP client wrapping fetch + the Access auth headers.
 *
 * Each method returns either `{ ok: true, status, body }` or
 * `{ ok: false, status, error, errors? }` so command handlers don't
 * need to throw — the CLI's exit-code mapping is "0 if ok, 1 if
 * not". Validation errors (400) come back with a populated
 * `errors` array; everything else carries a single `error` string.
 *
 * The client is generic over the response body type; commands cast
 * to the shape they expect. Cloudflare Pages Functions always emit
 * JSON for these endpoints, so a non-JSON 5xx body collapses to a
 * synthetic `error: "non_json_response"` envelope.
 */

import { authHeaders, type CliConfig } from './config'

export type Result<T> =
  | { ok: true; status: number; body: T }
  | {
      ok: false
      status: number
      error: string
      message?: string
      errors?: Array<{ field: string; code: string; message: string }>
    }

export interface ClientOptions {
  /** Test-friendly override for the global fetch. */
  fetchImpl?: typeof fetch
}

export class TerravizClient {
  private readonly config: CliConfig
  private readonly fetchImpl: typeof fetch

  constructor(config: CliConfig, options: ClientOptions = {}) {
    this.config = config
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  get serverUrl(): string {
    return this.config.server
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Result<T>> {
    const headers: Record<string, string> = {
      ...authHeaders(this.config),
      Accept: 'application/json',
    }
    const init: RequestInit = { method, headers }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const url = `${this.config.server}${path}`
    let res: Response
    try {
      res = await this.fetchImpl(url, init)
    } catch (e) {
      return { ok: false, status: 0, error: 'network_error', message: String(e) }
    }

    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      return {
        ok: false,
        status: res.status,
        error: 'non_json_response',
        message: text.slice(0, 200),
      }
    }

    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status, body: parsed as T }
    }
    const env = (parsed ?? {}) as {
      error?: string
      message?: string
      errors?: Result<unknown> extends { errors: infer E } ? E : never
    }
    return {
      ok: false,
      status: res.status,
      error: env.error ?? 'http_error',
      message: env.message,
      errors: (env as { errors?: Array<{ field: string; code: string; message: string }> })
        .errors,
    }
  }

  // --- Read endpoints ---------------------------------------------

  me<T = unknown>(): Promise<Result<T>> {
    return this.request<T>('GET', '/api/v1/publish/me')
  }

  list<T = unknown>(query: {
    status?: 'draft' | 'published' | 'retracted'
    limit?: number
    cursor?: string
  } = {}): Promise<Result<T>> {
    const params = new URLSearchParams()
    if (query.status) params.set('status', query.status)
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    if (query.cursor) params.set('cursor', query.cursor)
    const qs = params.toString()
    return this.request<T>('GET', `/api/v1/publish/datasets${qs ? `?${qs}` : ''}`)
  }

  get<T = unknown>(id: string): Promise<Result<T>> {
    return this.request<T>('GET', `/api/v1/publish/datasets/${encodeURIComponent(id)}`)
  }

  // --- Write endpoints --------------------------------------------

  createDataset<T = unknown>(body: Record<string, unknown>): Promise<Result<T>> {
    return this.request<T>('POST', '/api/v1/publish/datasets', body)
  }

  updateDataset<T = unknown>(
    id: string,
    body: Record<string, unknown>,
  ): Promise<Result<T>> {
    return this.request<T>(
      'PUT',
      `/api/v1/publish/datasets/${encodeURIComponent(id)}`,
      body,
    )
  }

  publishDataset<T = unknown>(id: string): Promise<Result<T>> {
    return this.request<T>(
      'POST',
      `/api/v1/publish/datasets/${encodeURIComponent(id)}/publish`,
    )
  }

  retractDataset<T = unknown>(id: string): Promise<Result<T>> {
    return this.request<T>(
      'POST',
      `/api/v1/publish/datasets/${encodeURIComponent(id)}/retract`,
    )
  }

  previewDataset<T = unknown>(
    id: string,
    options: { ttl_seconds?: number } = {},
  ): Promise<Result<T>> {
    return this.request<T>(
      'POST',
      `/api/v1/publish/datasets/${encodeURIComponent(id)}/preview`,
      options.ttl_seconds ? { ttl_seconds: options.ttl_seconds } : {},
    )
  }

  createTour<T = unknown>(body: Record<string, unknown>): Promise<Result<T>> {
    return this.request<T>('POST', '/api/v1/publish/tours', body)
  }

  updateTour<T = unknown>(
    id: string,
    body: Record<string, unknown>,
  ): Promise<Result<T>> {
    return this.request<T>(
      'PUT',
      `/api/v1/publish/tours/${encodeURIComponent(id)}`,
      body,
    )
  }

  previewTour<T = unknown>(
    id: string,
    options: { ttl_seconds?: number } = {},
  ): Promise<Result<T>> {
    return this.request<T>(
      'POST',
      `/api/v1/publish/tours/${encodeURIComponent(id)}/preview`,
      options.ttl_seconds ? { ttl_seconds: options.ttl_seconds } : {},
    )
  }
}
