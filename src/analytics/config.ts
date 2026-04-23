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

/** Generate a fresh session ID. `crypto.randomUUID()` is the primary;
 * a Math.random-based fallback covers environments without crypto
 * (older test harnesses, extremely stripped-down builds). */
export function generateSessionId(): string {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }
  const rand = (n: number) => Math.floor(Math.random() * n).toString(16)
  return `${rand(0xffffffff)}-${rand(0xffff)}-4${rand(0xfff)}-${rand(0xffff)}-${rand(0xffffffff)}${rand(0xffff)}`
}
