/**
 * Simple log-level gating so production builds stay silent.
 *
 * Levels (lowest → highest): debug, info, warn, error, silent.
 * Default level is 'info' in development and 'warn' in production.
 * Override at runtime:  (window as any).__LOG_LEVEL__ = 'debug'
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
}

const DEFAULT_LEVEL: LogLevel =
  typeof import.meta !== 'undefined' && (import.meta as any).env?.DEV
    ? 'info'
    : 'warn'

function currentLevel(): LogLevel {
  if (typeof window !== 'undefined' && (window as any).__LOG_LEVEL__) {
    return (window as any).__LOG_LEVEL__ as LogLevel
  }
  return DEFAULT_LEVEL
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel()]
}

export const logger = {
  debug(...args: unknown[]): void {
    if (shouldLog('debug')) console.log(...args)
  },
  info(...args: unknown[]): void {
    if (shouldLog('info')) console.log(...args)
  },
  warn(...args: unknown[]): void {
    if (shouldLog('warn')) console.warn(...args)
  },
  error(...args: unknown[]): void {
    if (shouldLog('error')) console.error(...args)
  },
}
