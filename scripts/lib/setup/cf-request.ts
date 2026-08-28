// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Shared Cloudflare v4 API transport for the setup steps.
 *
 * Every Cloudflare endpoint answers with the same
 * `{ success, result, errors }` envelope, and every one of them can
 * fail for the same two boring reasons — the token lacks a
 * permission, or the resource name is wrong. Writing that handling
 * once means each step module is just its endpoints and its body
 * shapes.
 *
 * The `explain` hook is the point of the abstraction. A bare
 * `10000: Authentication error` sends an operator to the wrong place;
 * each caller knows which permission its own endpoints need and can
 * say so. Cloudflare's own message is always preserved alongside.
 */

export interface CfError {
  code?: number
  message?: string
}

/** Turn a Cloudflare error list into a caller-specific hint, or null. */
export type ErrorExplainer = (errors: CfError[]) => string | null

export interface CfApiOptions {
  apiToken: string
  fetchImpl?: typeof fetch
  apiBase?: string
  /** Caller-specific permission hint appended to auth failures. */
  explain?: ErrorExplainer
}

interface Envelope<T> {
  success?: boolean
  result?: T
  errors?: CfError[]
}

export function isAuthError(errors: CfError[]): boolean {
  return errors.some(
    e =>
      e.code === 10000 ||
      e.code === 9109 ||
      /authentication|permission|forbidden|not authorized/i.test(e.message ?? ''),
  )
}

/** Raised for a Cloudflare response we understood but that failed. */
export class CfApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors: CfError[],
  ) {
    super(message)
    this.name = 'CfApiError'
  }
}

export class CfApi {
  constructor(private readonly opts: CfApiOptions) {}

  get base(): string {
    return this.opts.apiBase ?? 'https://api.cloudflare.com/client/v4'
  }

  /**
   * `path` is everything after `/client/v4`. Returns `result`.
   *
   * `allowMissing` turns a 404 into `null` instead of a throw — some
   * endpoints (a WAF entrypoint ruleset on a zone that has never had
   * a custom rule) legitimately do not exist yet, and "absent" is a
   * state to act on rather than an error.
   */
  async request<T>(
    path: string,
    init: RequestInit & { allowMissing?: boolean } = {},
  ): Promise<T | null> {
    const { allowMissing, ...rest } = init
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const res = await fetchImpl(`${this.base}${path}`, {
      ...rest,
      headers: {
        Authorization: `Bearer ${this.opts.apiToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(rest.headers ?? {}),
      },
    })
    const text = await res.text()
    let parsed: Envelope<T> | null = null
    try {
      parsed = JSON.parse(text) as Envelope<T>
    } catch {
      /* non-JSON body — fall through to the raw text */
    }

    if (res.status === 404 && allowMissing) return null

    if (!res.ok || parsed?.success === false) {
      const errors = parsed?.errors ?? []
      const cloudflare = errors.length
        ? errors.map(e => `${e.code ?? '?'}: ${e.message ?? 'unknown'}`).join('; ')
        : text.slice(0, 300)
      const hint = errors.length ? this.opts.explain?.(errors) : null
      throw new CfApiError(
        `Cloudflare API ${res.status} ${res.statusText}: ${cloudflare}` +
          (hint ? `\n  → ${hint}` : ''),
        res.status,
        errors,
      )
    }

    if (!parsed || parsed.result === undefined) {
      // A few endpoints answer 200 with `result: null` on success
      // (deletes, some PUTs). Callers that care pass a nullable T.
      return null
    }
    return parsed.result
  }

  /** `request` that refuses to return null — for endpoints that must produce a value. */
  async requireResult<T>(path: string, init: RequestInit = {}): Promise<T> {
    const result = await this.request<T>(path, init)
    if (result === null) {
      throw new Error(`Cloudflare API returned no result for ${path}`)
    }
    return result
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.requireResult<T>(path, { method: 'POST', body: JSON.stringify(body) })
  }

  put<T>(path: string, body: unknown): Promise<T | null> {
    return this.request<T>(path, { method: 'PUT', body: JSON.stringify(body) })
  }
}

/**
 * Resolve the Cloudflare zone that owns a hostname.
 *
 * Matching is by longest suffix rather than by "strip the first
 * label": an account can hold both `example.org` and
 * `eu.example.org` as separate zones, and picking the wrong one puts
 * a DNS record or a WAF rule on a zone that never sees the traffic.
 * The longest matching zone name is the most specific one, which is
 * the one actually serving the host.
 */
export function matchZone<T extends { name?: string }>(
  zones: T[],
  hostname: string,
): T | null {
  const host = hostname.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()
  let best: T | null = null
  for (const zone of zones) {
    const name = zone.name?.toLowerCase()
    if (!name) continue
    if (host === name || host.endsWith(`.${name}`)) {
      if (!best || name.length > (best.name?.length ?? 0)) best = zone
    }
  }
  return best
}
