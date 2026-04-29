/**
 * Resolve the CLI's runtime configuration: server URL + auth.
 *
 * Resolution order, highest-priority first:
 *   1. Explicit flags (`--server`, `--client-id`, `--client-secret`,
 *      `--insecure-local`).
 *   2. Environment variables (`TERRAVIZ_SERVER`,
 *      `TERRAVIZ_INSECURE_LOCAL`, `TERRAVIZ_ACCESS_CLIENT_ID`,
 *      `TERRAVIZ_ACCESS_CLIENT_SECRET`).
 *   3. Persisted config in `~/.terraviz/config.json` (created by
 *      `terraviz login` in Phase 3 — Phase 1a only reads it if a
 *      contributor wrote it by hand).
 *   4. Defaults: server `https://terraviz.app`, no auth headers.
 *
 * The auth path is intentionally pluggable: a service-token caller
 * gets `Cf-Access-Client-Id` + `-Secret` headers; a `--insecure-local`
 * caller gets none, which is fine because the server's
 * `DEV_BYPASS_ACCESS=true` middleware skips Access verification.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

export interface CliConfig {
  server: string
  /** When true, no Access headers are sent (dev mode against localhost). */
  insecureLocal: boolean
  /** Cloudflare Access service-token client id, if configured. */
  clientId?: string
  /** Cloudflare Access service-token client secret, if configured. */
  clientSecret?: string
}

export interface ResolveOptions {
  flagServer?: string
  flagInsecureLocal?: boolean
  flagClientId?: string
  flagClientSecret?: string
  /** Override `process.env`; tests pass a fresh object. */
  env?: Record<string, string | undefined>
  /** Override `~/.terraviz/config.json` location for tests. */
  configPath?: string
}

export const DEFAULT_SERVER = 'https://terraviz.app'

interface PersistedConfig {
  server?: string
  client_id?: string
  client_secret?: string
}

function readPersisted(path: string): PersistedConfig | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as PersistedConfig
  } catch {
    return null
  }
}

export function resolveConfig(options: ResolveOptions = {}): CliConfig {
  const env = options.env ?? process.env
  const configPath =
    options.configPath ?? resolve(homedir(), '.terraviz', 'config.json')
  const persisted = readPersisted(configPath) ?? {}

  const server =
    options.flagServer ??
    env.TERRAVIZ_SERVER ??
    persisted.server ??
    DEFAULT_SERVER

  // Boolean flags: explicit truthy from any layer wins.
  const insecureLocal =
    options.flagInsecureLocal === true ||
    env.TERRAVIZ_INSECURE_LOCAL === '1' ||
    env.TERRAVIZ_INSECURE_LOCAL === 'true'

  const clientId =
    options.flagClientId ?? env.TERRAVIZ_ACCESS_CLIENT_ID ?? persisted.client_id
  const clientSecret =
    options.flagClientSecret ??
    env.TERRAVIZ_ACCESS_CLIENT_SECRET ??
    persisted.client_secret

  return {
    server: server.replace(/\/+$/, ''),
    insecureLocal,
    clientId: clientId || undefined,
    clientSecret: clientSecret || undefined,
  }
}

/**
 * Auth headers to attach to every CLI request. Returns an empty
 * object for `--insecure-local` (or when neither token half is set).
 * The publisher API middleware refuses no-auth + non-loopback host
 * via the `dev_bypass_unsafe` envelope, so callers can't accidentally
 * send unauthenticated traffic to production.
 */
export function authHeaders(config: CliConfig): Record<string, string> {
  if (config.insecureLocal) return {}
  if (!config.clientId || !config.clientSecret) return {}
  return {
    'Cf-Access-Client-Id': config.clientId,
    'Cf-Access-Client-Secret': config.clientSecret,
  }
}
