/**
 * Session lifecycle helper — builds the `session_start` event from
 * runtime signals, then registers a `pagehide` listener that emits
 * `session_end` with duration and event count.
 *
 * Kept separate from `emitter.ts` so the emitter stays focused on
 * queueing + transport and doesn't know about DOM / WebXR / locale.
 * Call `initSession()` once from `main.ts` after the app has
 * initialized.
 */

import { emit, getEventCount, getSessionDurationMs, TELEMETRY_SCHEMA_VERSION } from '.'
import {
  isImmersiveArSupported,
  isImmersiveVrSupported,
  isWebXRAvailable,
} from '../utils/vrCapability'
import type {
  AspectClass,
  BuildChannel,
  OsFamily,
  Platform,
  ScreenClass,
  SessionEndEvent,
  SessionStartEvent,
  ViewportClass,
  VrCapability,
} from '../types'

// Vite-injected defines — see vite.config.ts.
declare const __APP_VERSION__: string
declare const __BUILD_CHANNEL__: string

let started = false
let sessionEnded = false
let pagehideAbort: AbortController | null = null

/**
 * Emit `session_start` and register the `session_end` unload hook.
 * Idempotent — a second call in the same session is a no-op so HMR
 * in dev doesn't duplicate session_start events.
 *
 * Safe to call before or after the transport is wired: session_start
 * enqueues either way, and session_end rides the beacon installed
 * by `setTransport()` as long as `initSession()` ran first
 * (listeners fire in registration order).
 */
export async function initSession(): Promise<void> {
  if (started) return
  started = true

  const vrCapable = await detectVrCapability()
  const os = detectOs()

  const event: SessionStartEvent = {
    event_type: 'session_start',
    app_version: appVersion(),
    platform: detectPlatform(os),
    os,
    locale: detectLocale(),
    viewport_class: classifyViewport(),
    aspect_class: classifyAspect(),
    screen_class: classifyScreen(),
    build_channel: detectBuildChannel(),
    vr_capable: vrCapable,
    schema_version: TELEMETRY_SCHEMA_VERSION,
  }
  emit(event)

  if (typeof window !== 'undefined') {
    pagehideAbort = new AbortController()
    window.addEventListener(
      'pagehide',
      () => emitSessionEnd('pagehide'),
      { signal: pagehideAbort.signal },
    )
    // visibilitychange covers the iOS Safari case where `pagehide`
    // is missed on tab-switching; treated as a session_end too.
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'hidden') {
          emitSessionEnd('visibilitychange')
        }
      },
      { signal: pagehideAbort.signal },
    )
  }
}

/** Emit exactly one `session_end` per session. Repeat calls (pagehide
 * fires twice on iOS, or visibilitychange fires before pagehide) are
 * coalesced into the first one to avoid double-counting. */
export function emitSessionEnd(
  reason: SessionEndEvent['exit_reason'],
): void {
  if (sessionEnded) return
  sessionEnded = true
  const event: SessionEndEvent = {
    event_type: 'session_end',
    exit_reason: reason,
    duration_ms: getSessionDurationMs(),
    event_count: getEventCount(),
  }
  emit(event)
}

/** Test helper — clear "has a session started yet" guard and unwire
 * the pagehide listener. Not exported from the analytics barrel. */
export function __resetSessionForTests(): void {
  started = false
  sessionEnded = false
  pagehideAbort?.abort()
  pagehideAbort = null
}

// ---------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------

function appVersion(): string {
  try {
    return typeof __APP_VERSION__ === 'string' && __APP_VERSION__.length > 0
      ? __APP_VERSION__
      : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Shell type. Tauri mobile vs Tauri desktop is distinguished by
 * the already-detected OS family so we only consult the UA once. */
function detectPlatform(os: OsFamily): Platform {
  const win = typeof window !== 'undefined'
    ? (window as unknown as { __TAURI__?: unknown })
    : null
  const isTauri = !!win?.__TAURI__
  if (!isTauri) return 'web'
  if (os === 'ios' || os === 'android') return 'mobile'
  return 'desktop'
}

/** OS family. Uses the structured `navigator.userAgentData.platform`
 * when available (modern Chromium — gives a clean string like
 * `"macOS"` with zero parsing), with a UA substring fallback for
 * every other engine. Only the bucket leaves this function; the
 * raw UA string is never emitted. */
function detectOs(): OsFamily {
  if (typeof navigator === 'undefined') return 'unknown'
  const uaData = (navigator as Navigator & {
    userAgentData?: { platform?: string }
  }).userAgentData
  const structured = uaData?.platform
  if (structured) {
    const s = structured.toLowerCase()
    if (s === 'macos' || s === 'mac os' || s === 'mac os x') return 'mac'
    if (s === 'windows') return 'windows'
    if (s === 'linux') return 'linux'
    if (s === 'ios') return 'ios'
    if (s === 'android') return 'android'
  }
  const ua = navigator.userAgent ?? ''
  // Order matters — iPadOS 13+ masquerades as Mac in the UA unless
  // you check `maxTouchPoints`. Check iOS first via Apple touch
  // signals, then the rest by substring.
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios'
  if (
    ua.includes('Macintosh') &&
    typeof navigator.maxTouchPoints === 'number' &&
    navigator.maxTouchPoints > 1
  ) {
    return 'ios' // iPad masquerading as Mac
  }
  if (/Android/i.test(ua)) return 'android'
  if (/Windows/i.test(ua)) return 'windows'
  if (/Mac OS X|Macintosh/i.test(ua)) return 'mac'
  if (/Linux|X11/i.test(ua)) return 'linux'
  return 'unknown'
}

function detectLocale(): string {
  if (typeof navigator === 'undefined') return 'unknown'
  return navigator.language || 'unknown'
}

/** Browser-viewport width bucket. Unchanged shape from Commit 7. */
function classifyViewport(): ViewportClass {
  if (typeof window === 'undefined') return 'md'
  const w = window.innerWidth || 1024
  if (w < 480) return 'xs'
  if (w < 768) return 'sm'
  if (w < 1280) return 'md'
  if (w < 1920) return 'lg'
  return 'xl'
}

/** Aspect-ratio bucket derived from the *viewport* (not the
 * physical display) — layout decisions care about the area the
 * app actually gets. Coarse on purpose; see the plan's
 * "Session-start enrichment" section for the cardinality math. */
function classifyAspect(): AspectClass {
  if (typeof window === 'undefined') return 'landscape'
  const w = window.innerWidth || 1024
  const h = window.innerHeight || 768
  if (h === 0) return 'landscape'
  const ratio = w / h
  if (ratio < 0.6) return 'portrait-tall'
  if (ratio < 0.95) return 'portrait'
  if (ratio < 1.1) return 'square'
  if (ratio < 1.8) return 'landscape'
  if (ratio < 2.2) return 'wide'
  return 'ultrawide'
}

/** Physical-display bucket — separate from viewport because a user
 * on a 4K monitor may resize the window to 1080p. `screen.width`
 * reflects the display, not the browser chrome. */
function classifyScreen(): ScreenClass {
  if (typeof screen === 'undefined') return '1080p'
  const w = screen.width || 1920
  if (w < 768) return 'mobile'
  if (w < 1366) return 'tablet'
  if (w < 2048) return '1080p'
  if (w < 2880) return '2k'
  return '4k+'
}

/** Build audience — baked into the bundle at build time via the
 * `__BUILD_CHANNEL__` Vite define. Validated at runtime so an
 * unexpected value can't slip through. */
function detectBuildChannel(): BuildChannel {
  try {
    const v = typeof __BUILD_CHANNEL__ === 'string' ? __BUILD_CHANNEL__ : ''
    if (v === 'internal' || v === 'canary' || v === 'public') return v
  } catch {
    // define absent (e.g. running under vitest without vite) — fall through
  }
  return 'public'
}

async function detectVrCapability(): Promise<VrCapability> {
  if (!isWebXRAvailable()) return 'none'
  const [vr, ar] = await Promise.all([
    isImmersiveVrSupported(),
    isImmersiveArSupported(),
  ])
  if (vr && ar) return 'both'
  if (vr) return 'vr'
  if (ar) return 'ar'
  return 'none'
}
