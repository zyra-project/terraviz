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

  /**
   * Re-enqueue the embed job for an already-published dataset. Used
   * by `terraviz import-snapshot --reindex` (Phase 1d/D) to backfill
   * the Vectorize index after an operator wires up the bindings, or
   * to roll out a future model-version bump as a one-off pass.
   */
  reindexDataset<T = unknown>(id: string): Promise<Result<T>> {
    return this.request<T>(
      'POST',
      `/api/v1/publish/datasets/${encodeURIComponent(id)}/reindex`,
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

  // --- Asset upload endpoints (Phase 1b) --------------------------

  /** Initiate an asset upload — mints a Stream direct-upload URL or R2 presigned PUT. */
  initAssetUpload<T = unknown>(
    datasetId: string,
    body: {
      kind: 'data' | 'thumbnail' | 'legend' | 'caption' | 'sphere_thumbnail'
      mime: string
      size: number
      content_digest: string
    },
  ): Promise<Result<T>> {
    return this.request<T>(
      'POST',
      `/api/v1/publish/datasets/${encodeURIComponent(datasetId)}/asset`,
      body,
    )
  }

  /** Finalise an asset upload — server verifies the digest and flips the row. */
  completeAssetUpload<T = unknown>(
    datasetId: string,
    uploadId: string,
  ): Promise<Result<T>> {
    return this.request<T>(
      'POST',
      `/api/v1/publish/datasets/${encodeURIComponent(datasetId)}/asset/${encodeURIComponent(uploadId)}/complete`,
    )
  }

  /**
   * PUT bytes to a presigned R2 URL or POST bytes to a Stream
   * direct-upload URL. Used by the upload command after `initAssetUpload`.
   *
   * For R2: a regular PUT with `Content-Type` matching the SigV4
   * signature.
   * For Stream: multipart/form-data with `file` field — Stream's
   * direct-upload endpoint accepts both raw and multipart; the
   * multipart form is what the dashboard / browser flows use.
   */
  async uploadBytes(
    target: 'r2' | 'stream',
    url: string,
    headers: Record<string, string>,
    body: Uint8Array,
    mime: string,
    filename: string,
  ): Promise<{ ok: boolean; status: number; message?: string }> {
    // The DOM `BodyInit` and `BlobPart` types resolved against
    // `ArrayBuffer` (not `ArrayBufferLike`) — Uint8Array views over
    // a shared buffer fail the structural check. Round-trip through
    // a fresh ArrayBuffer to land on the strictly-typed branch.
    const buffer = body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer
    let res: Response
    try {
      if (target === 'r2') {
        res = await this.fetchImpl(url, {
          method: 'PUT',
          headers: { ...headers, 'Content-Length': String(body.byteLength) },
          body: buffer,
        })
      } else {
        const form = new FormData()
        form.append('file', new Blob([buffer], { type: mime }), filename)
        res = await this.fetchImpl(url, { method: 'POST', body: form })
      }
    } catch (e) {
      return { ok: false, status: 0, message: String(e) }
    }
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status }
    const text = await res.text().catch(() => '')
    return { ok: false, status: res.status, message: text.slice(0, 200) }
  }
}
