/**
 * Simple log-level gating so production builds stay silent.
 *
 * Levels (lowest → highest): debug, info, warn, error, silent.
 * Default level is 'debug' in development and 'warn' in production.
 * Override at runtime:  (window as any).__LOG_LEVEL__ = 'debug'
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const __BUNDLED_DEV__: boolean

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
}

// Vite replaces __BUNDLED_DEV__ at compile time.
// In dev mode (npm run dev) it becomes `true`, in production builds `false`.
// Falls back to 'debug' if the define is somehow missing (e.g. tests).
const DEFAULT_LEVEL: LogLevel =
  (typeof __BUNDLED_DEV__ !== 'undefined' ? __BUNDLED_DEV__ : true)
    ? 'debug'
    : 'warn'

/** Runtime override — set by the debug checkbox in Orbit settings. */
let runtimeLevel: LogLevel | null = null

function currentLevel(): LogLevel {
  if (runtimeLevel) return runtimeLevel
  if (typeof window !== 'undefined' && (window as any).__LOG_LEVEL__) {
    return (window as any).__LOG_LEVEL__ as LogLevel
  }
  return DEFAULT_LEVEL
}

/** Override the log level at runtime (e.g. when the debug checkbox is toggled). Pass null to reset to default. */
export function setLogLevel(level: LogLevel | null): void {
  runtimeLevel = level
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel()]
}

/** Leveled logger that gates output based on the current log level. */
export const logger = {
  /**
   * True if messages at `level` would be emitted given the current
   * log level. Use this to skip expensive argument construction
   * (object allocations, `.toFixed()` strings, JSON.stringify, etc.)
   * that would otherwise run unconditionally before being thrown
   * away by the level gate.
   */
  isEnabled(level: LogLevel): boolean {
    return shouldLog(level)
  },
  /** Log a debug-level message (development only by default). */
  debug(...args: unknown[]): void {
    if (shouldLog('debug')) console.log(...args)
  },
  /** Log an info-level message. */
  info(...args: unknown[]): void {
    if (shouldLog('info')) console.log(...args)
  },
  /** Log a warning-level message. */
  warn(...args: unknown[]): void {
    if (shouldLog('warn')) console.warn(...args)
  },
  /** Log an error-level message. */
  error(...args: unknown[]): void {
    if (shouldLog('error')) console.error(...args)
  },
}
