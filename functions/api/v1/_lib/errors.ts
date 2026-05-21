/**
 * Typed errors used by the storage helpers (`r2-store.ts`,
 * `stream-store.ts`) so the route handlers can distinguish
 * "operator forgot to set credentials" from "the upstream service
 * failed" without regex-matching error messages.
 *
 * `ConfigurationError` → 503 with a `*_unconfigured` code; the
 * operator needs to fix the deploy.
 *
 * `UpstreamError` → 502 with a `*_upstream_error` code; the call
 * may succeed on retry. The optional `status` carries the upstream
 * HTTP status when known so handlers can map specific codes (e.g.
 * 404 → mark upload row failed with a stable reason).
 */

export class ConfigurationError extends Error {
  readonly kind = 'configuration' as const
  constructor(message: string) {
    super(message)
    this.name = 'ConfigurationError'
  }
}

export class UpstreamError extends Error {
  readonly kind = 'upstream' as const
  constructor(message: string, public readonly status?: number) {
    super(message)
    this.name = 'UpstreamError'
  }
}

export function isConfigurationError(err: unknown): err is ConfigurationError {
  return err instanceof Error && (err as { kind?: string }).kind === 'configuration'
}

export function isUpstreamError(err: unknown): err is UpstreamError {
  return err instanceof Error && (err as { kind?: string }).kind === 'upstream'
}

/**
 * Reduce an arbitrary `unknown` error into a safe string to return
 * over the wire.
 *
 *  • `ConfigurationError` and `UpstreamError` are constructed by our
 *    own code (`r2-store.ts`, `stream-store.ts`, etc.), so their
 *    `.message` is operator-authored and intentionally informative
 *    (e.g. "CATALOG_R2 binding missing"). The message is preserved
 *    after a light scrub (newline-collapse + 256-char cap) — enough
 *    to defeat stack-trace inclusion while keeping codes readable
 *    for the publisher CLI.
 *  • Any other thrown value (an SDK error, a JSON parse failure, a
 *    raw `TypeError` from a destructure) is logged server-side via
 *    `console.error` so wrangler tail still surfaces it, and the
 *    caller receives only the generic `fallback`. This is the case
 *    CodeQL's "Information exposure through a stack trace" rule
 *    fires on: `err.message` from an arbitrary `unknown` is exactly
 *    where internal paths, bucket names, or stack frames can leak.
 */
const MAX_REASON_LEN = 256
function scrub(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LEN)
}

export function safeErrorReason(err: unknown, fallback: string): string {
  if (isConfigurationError(err) || isUpstreamError(err)) {
    return scrub(err.message) || fallback
  }
  console.error('[errors] unexpected error reduced to fallback message:', err)
  return fallback
}
