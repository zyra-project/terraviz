/**
 * Shared HTTP client for the publisher portal.
 *
 * Centralises the auth-handling logic that originated in
 * /publish/me's page module:
 *
 *   1. Fetch with `redirect: 'manual'` so we can recognise
 *      Cloudflare Access's cross-origin login redirect (which
 *      surfaces as `opaqueredirect` and is CORS-blocked at the
 *      fetch boundary, indistinguishable from a network error
 *      under default `redirect: 'follow'`).
 *   2. On opaqueredirect, wait briefly and retry once — covers
 *      the case where Access sets the API-app cookie via
 *      Set-Cookie on the redirect response (cookie handling
 *      lives below the fetch API, so the browser processes the
 *      header even when fetch can't read the response body).
 *   3. On persistent opaqueredirect, return a `session` result —
 *      the page-level code calls `handleSessionError` to either
 *      auto-warmup via top-level navigation (the typical fix)
 *      or surface the error card (genuine auth gap).
 *
 * Page modules consume this rather than inlining their own
 * fetch + auth handling so 3pb–3pg endpoints all inherit the
 * same behaviour.
 */

import { t } from '../../i18n'
import { logger } from '../../utils/logger'

export type PublisherApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'session' | 'network' | 'not_found' }
  | { ok: false; kind: 'server'; status?: number; body?: string }

export interface PublisherFetchOptions {
  /** Injected fetch implementation; defaults to `globalThis.fetch`. */
  fetchFn?: typeof fetch
  /** Injected sleep implementation; defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>
}

export interface SessionErrorHandlerOptions {
  /** Injected navigation function; defaults to setting
   *  `window.location.href`. */
  navigate?: (url: string) => void
}

const COOKIE_WARMUP_DELAY_MS = 100

/**
 * sessionStorage key used to break the auto-warmup infinite loop.
 * If the user lands on a portal page with this flag set, we've
 * already attempted the redirect-back warmup on this tab, so a
 * persistent opaqueredirect points at a real auth gap (no team
 * session, policy doesn't match the user, etc.) and the page
 * should surface the error card rather than ping-pong forever.
 *
 * sessionStorage is per-tab and survives the cross-origin redirect
 * chain through Cloudflare Access; it clears when the tab closes,
 * so a returning visitor starts fresh.
 */
const WARMUP_FLAG_KEY = 'publisher_warmup_attempted'

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function defaultNavigate(url: string): void {
  window.location.href = url
}

function isAccessRedirect(res: Response): boolean {
  return res.type === 'opaqueredirect' || res.status === 0
}

export function warmupAlreadyAttempted(): boolean {
  try {
    return sessionStorage.getItem(WARMUP_FLAG_KEY) === '1'
  } catch {
    // sessionStorage may throw in private-browsing modes that
    // disable storage. Conservatively treat as "already
    // attempted" so we surface the error card rather than
    // looping on auto-warmup against a broken storage layer.
    return true
  }
}

function markWarmupAttempted(): void {
  try {
    sessionStorage.setItem(WARMUP_FLAG_KEY, '1')
  } catch {
    /* swallow — see warmupAlreadyAttempted */
  }
}

export function clearWarmupFlag(): void {
  try {
    sessionStorage.removeItem(WARMUP_FLAG_KEY)
  } catch {
    /* swallow */
  }
}

function signInUrl(): string {
  const here = window.location.pathname + window.location.search
  return `/api/v1/publish/redirect-back?to=${encodeURIComponent(here)}`
}

/**
 * GET `path` and parse the response as JSON.
 *
 * Returns a discriminated result rather than throwing — call sites
 * pattern-match on `result.ok` and `result.kind`, which keeps the
 * happy and unhappy paths visible side-by-side in the caller.
 *
 * The retry-once-on-opaqueredirect logic is inside the helper.
 * The decide-what-to-do-on-session-error logic (auto-warmup vs
 * show error card) is delegated to `handleSessionError` because
 * it's a page-level concern — different pages may want to recover
 * differently.
 */
export async function publisherGet<T>(
  path: string,
  options: PublisherFetchOptions = {},
): Promise<PublisherApiResult<T>> {
  const fetchFn = options.fetchFn ?? globalThis.fetch
  const sleep = options.sleep ?? defaultSleep

  const doFetch = (): Promise<Response> =>
    fetchFn(path, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
    })

  let res: Response
  try {
    res = await doFetch()
  } catch (err) {
    logger.warn(`[publisher-api] ${path} fetch threw`, err)
    return { ok: false, kind: 'network' }
  }

  if (isAccessRedirect(res)) {
    logger.debug(`[publisher-api] ${path} opaqueredirect; retrying once after cookie warmup`)
    await sleep(COOKIE_WARMUP_DELAY_MS)
    try {
      res = await doFetch()
    } catch (err) {
      logger.warn(`[publisher-api] ${path} retry fetch threw`, err)
      return { ok: false, kind: 'network' }
    }
    if (isAccessRedirect(res)) {
      return { ok: false, kind: 'session' }
    }
  }

  if (res.status === 401) return { ok: false, kind: 'session' }
  // 404 is distinct because portal pages typically want a
  // different surface ("dataset not found, back to list?") than
  // for a 5xx ("the server crashed, retry?"). The publisher API
  // returns 404 both for missing rows and rows the caller can't
  // see (to avoid leaking other publishers' draft IDs); the
  // portal renders the same UI for both since it doesn't know
  // which case applies.
  if (res.status === 404) return { ok: false, kind: 'not_found' }
  if (!res.ok) {
    logger.warn(`[publisher-api] ${path} returned`, res.status)
    // Capture the body so the error card can disclose it.
    // Operator debugging: a 503 identity_missing or 403 with a
    // structured `error` field is far more useful than the
    // generic "server returned an error" we used to render.
    let body = ''
    try {
      body = await res.text()
    } catch {
      /* swallow — fall back to empty body */
    }
    return { ok: false, kind: 'server', status: res.status, body }
  }

  try {
    const data = (await res.json()) as T
    return { ok: true, data }
  } catch (err) {
    logger.warn(`[publisher-api] ${path} JSON parse failed`, err)
    return { ok: false, kind: 'server' }
  }
}

export type SessionErrorAction = 'navigating' | 'show-error'

/**
 * Decide how to handle a `session`-kind error: either auto-
 * navigate through the redirect-back endpoint to land the API-app
 * cookie via a top-level Access flow, or — if we've already tried
 * the warmup once this tab session — surface the error card so
 * the user sees a Sign in button.
 *
 * Returns:
 *   - `'navigating'` when an auto-navigation was triggered. The
 *     caller should NOT render anything further; the browser is
 *     about to leave the page.
 *   - `'show-error'` when the warmup flag was already set,
 *     indicating a genuine auth gap. The caller should render
 *     the session-error UI and let the user click Sign in
 *     explicitly. The flag is cleared here so a subsequent
 *     Refresh / explicit Sign in click starts fresh.
 */
export function handleSessionError(
  options: SessionErrorHandlerOptions = {},
): SessionErrorAction {
  const navigate = options.navigate ?? defaultNavigate
  if (warmupAlreadyAttempted()) {
    clearWarmupFlag()
    return 'show-error'
  }
  markWarmupAttempted()
  logger.debug('[publisher-api] auto-navigating to redirect-back to land API-app cookie')
  navigate(signInUrl())
  return 'navigating'
}

/** Build the URL the "Sign in" button navigates to. Exported so
 *  page-level code (e.g., /publish/me's error card) can mint the
 *  same redirect-back URL the auto-warmup uses, keeping the
 *  manual fallback in lockstep with the automatic recovery. */
export function buildSignInUrl(): string {
  return signInUrl()
}

/**
 * Field-level validation error envelope. The publisher API
 * returns `{ errors: [{ field, code, message }] }` on a 400
 * response per `CATALOG_PUBLISHING_TOOLS.md`. Surface so the
 * caller can render per-field error messages alongside the form.
 */
export interface PublisherValidationError {
  field: string
  code: string
  message: string
}

/**
 * Write-side equivalent of `publisherGet`. Sends a JSON body via
 * POST/PUT/PATCH and routes the response through the same retry +
 * auth-handling pipeline.
 *
 * Distinguishes 400 (validation) from generic server errors so the
 * caller can render per-field error UI without spelunking response
 * bodies. The retry-on-opaqueredirect path is identical to the GET
 * helper — Access can intercept any method, not just GETs.
 */
export type PublisherSendResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'validation'; errors: PublisherValidationError[] }
  | { ok: false; kind: 'session' | 'network' | 'not_found' }
  | { ok: false; kind: 'server'; status?: number; body?: string }

export interface PublisherSendOptions extends PublisherFetchOptions {
  method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
}

export async function publisherSend<T>(
  path: string,
  body: unknown,
  options: PublisherSendOptions = {},
): Promise<PublisherSendResult<T>> {
  const fetchFn = options.fetchFn ?? globalThis.fetch
  const sleep = options.sleep ?? defaultSleep
  const method = options.method ?? 'POST'

  const doFetch = (): Promise<Response> =>
    fetchFn(path, {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
    })

  let res: Response
  try {
    res = await doFetch()
  } catch (err) {
    logger.warn(`[publisher-api] ${method} ${path} fetch threw`, err)
    return { ok: false, kind: 'network' }
  }

  if (isAccessRedirect(res)) {
    logger.debug(`[publisher-api] ${method} ${path} opaqueredirect; retrying once`)
    await sleep(COOKIE_WARMUP_DELAY_MS)
    try {
      res = await doFetch()
    } catch (err) {
      logger.warn(`[publisher-api] ${method} ${path} retry fetch threw`, err)
      return { ok: false, kind: 'network' }
    }
    if (isAccessRedirect(res)) return { ok: false, kind: 'session' }
  }

  if (res.status === 401) return { ok: false, kind: 'session' }
  if (res.status === 404) return { ok: false, kind: 'not_found' }

  if (res.status === 400 || res.status === 409) {
    // The publisher API uses `{ errors: [{ field, code, message }] }`
    // for both 400 (validation) and a subset of 409 conflicts that
    // are still field-shaped (e.g., publish-while-transcoding —
    // dataset-mutations.ts returns a `transcoding` field error
    // because the publish blocker IS the row's transcoding state).
    // Falling through to the generic `kind: 'server'` branch for
    // 409 would lose the per-field message and surface a generic
    // toast — PR #112 followup (dataset-mutations.ts:632).
    //
    // A 409 without an `errors: [...]` envelope (the simple
    // `{ error, message }` shape used by transcode_upload_mismatch
    // and friends) falls through to the generic server-error path
    // so the caller still sees the status and body.
    let body: { errors?: PublisherValidationError[] } | null = null
    try {
      body = (await res.json()) as { errors?: PublisherValidationError[] }
    } catch {
      body = null
    }
    const errors = body && Array.isArray(body.errors) ? body.errors : []
    if (errors.length > 0) {
      return { ok: false, kind: 'validation', errors }
    }
    if (res.status === 409) {
      // 409 with no field-level envelope — generic conflict.
      // Re-serialize the parsed body so the caller can read
      // `{ error, message }` from it.
      return {
        ok: false,
        kind: 'server',
        status: 409,
        body: body ? JSON.stringify(body) : '',
      }
    }
    // 400 fallback — synthesize a validation error so the form
    // still has something to render even when the response body
    // is missing or malformed.
    return {
      ok: false,
      kind: 'validation',
      errors: [
        {
          field: '_root',
          code: 'invalid',
          message: body
            ? t('publisher.api.fallbackError.validationFailed')
            : t('publisher.api.fallbackError.invalidJson'),
        },
      ],
    }
  }

  if (!res.ok) {
    logger.warn(`[publisher-api] ${method} ${path} returned`, res.status)
    let body = ''
    try {
      body = await res.text()
    } catch {
      /* swallow */
    }
    return { ok: false, kind: 'server', status: res.status, body }
  }

  // 201 Created (POST) and 200 OK (PUT) both carry a JSON body;
  // 204 No Content carries none. Tolerate both.
  if (res.status === 204) {
    return { ok: true, data: undefined as T }
  }
  try {
    const data = (await res.json()) as T
    return { ok: true, data }
  } catch (err) {
    logger.warn(`[publisher-api] ${method} ${path} JSON parse failed`, err)
    return { ok: false, kind: 'server' }
  }
}
