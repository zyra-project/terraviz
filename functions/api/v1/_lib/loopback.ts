/**
 * Loopback hostname check — shared by the publish middleware's
 * `DEV_BYPASS_ACCESS=true` gate and the asset-complete handler's
 * `MOCK_R2=true` gate. Both env vars are dev-only and need a
 * defense-in-depth refusal on any non-loopback hostname so a
 * misconfigured production deploy can't accidentally honor them.
 *
 * Accepts the documented IPv4/IPv6 loopback addresses plus any
 * `*.localhost` subdomain (RFC 6761 reserves the entire TLD for
 * loopback resolution).
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost')
}
