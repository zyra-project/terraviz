/**
 * Telemetry config — persisted tier preference + per-launch session ID.
 *
 * Tier lives in localStorage (`sos-telemetry-config`). Session ID lives
 * in memory only and rotates on every app launch. Compile-time flags
 * are read from Vite `define` constants so builds can opt out of
 * telemetry entirely — `VITE_TELEMETRY_ENABLED=false` tree-shakes the
 * emit code paths.
 *
 * See docs/ANALYTICS_IMPLEMENTATION_PLAN.md and docs/PRIVACY.md for the
 * surrounding design.
 */

import type { TelemetryConfig, TelemetryTier } from '../types'

const CONFIG_STORAGE_KEY = 'sos-telemetry-config'

/** Bumped when the event schema changes in a breaking way. Emitted as
 * a blob on `session_start` so the ingest side can route old + new
 * clients to the right Iceberg partition. */
export const TELEMETRY_SCHEMA_VERSION = '1.0'

/** Compile-time kill switch. Set `VITE_TELEMETRY_ENABLED=false` at
 * build time for a telemetry-free build (F-Droid, federal delivery,
 * etc.). The value is inlined by Vite and the emit bodies guarded by
 * this constant get removed by the minifier. */
export const TELEMETRY_BUILD_ENABLED: boolean =
  import.meta.env.VITE_TELEMETRY_ENABLED !== 'false'

/** Dev convenience. When `VITE_TELEMETRY_CONSOLE=true`, the emitter
 * logs every flush to `console.debug` instead of sending. Defaults on
 * in `npm run dev`, off in `npm run build`. */
export const TELEMETRY_CONSOLE_MODE: boolean =
  import.meta.env.VITE_TELEMETRY_CONSOLE === 'true'

const DEFAULT_CONFIG: TelemetryConfig = {
  tier: 'essential',
}

/** Read the persisted config, falling back to defaults on missing,
 * invalid JSON, or an unexpected tier value. */
export function loadConfig(): TelemetryConfig {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_CONFIG }
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_CONFIG }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_CONFIG }
    const tier = parsed.tier
    if (tier !== 'off' && tier !== 'essential' && tier !== 'research') {
      return { ...DEFAULT_CONFIG }
    }
    return { tier }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/** Persist a partial config update. Silently no-ops when localStorage
 * is unavailable (SSR, very-locked-down privacy modes). */
export function saveConfig(partial: Partial<TelemetryConfig>): void {
  if (typeof localStorage === 'undefined') return
  try {
    const next: TelemetryConfig = { ...loadConfig(), ...partial }
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Swallow — storage failures must not break the app
  }
}

/** Set the active tier. Convenience wrapper around saveConfig. */
export function setTier(tier: TelemetryTier): void {
  saveConfig({ tier })
}

/** Generate a fresh session ID.
 *
 * Uses `crypto.randomUUID()` when available (all supported browsers
 * and Workers runtimes), and falls back to `crypto.getRandomValues()`
 * for the handful of environments that have the Crypto interface
 * but not the `randomUUID()` helper (very old Safari, some shims).
 * Both paths are CSPRNG-backed — never `Math.random()`, which CodeQL
 * correctly flags as predictable. */
export function generateSessionId(): string {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    // RFC 4122 v4 UUID assembled from 16 CSPRNG bytes.
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  // No Crypto interface at all (extremely stripped-down test harness).
  // Throw rather than silently emitting predictable IDs — analytics is
  // not safety-critical, but a session id from Math.random is worse
  // than a hard failure that surfaces in CI.
  throw new Error('generateSessionId: no Web Crypto available in this environment')
}
