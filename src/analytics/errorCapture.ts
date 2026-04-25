/**
 * Error and console capture pipeline.
 *
 * Three input sources funnel through a shared sanitize → dedup →
 * emit path:
 *
 *   1. Global uncaught handlers — window.error, unhandledrejection
 *   2. Monkey-patched console.error / console.warn — catches
 *      library-internal errors that log but never throw (MapLibre,
 *      HLS.js, Three.js, Tauri plugins)
 *   3. Explicit call sites — reportError(category, err) from code
 *      that wants to report a caught failure
 *
 * Privacy discipline is non-negotiable: message text is sanitized
 * (URLs, emails, UUIDs, digit runs, file paths stripped) and
 * truncated to 80 chars before emit; stack frames outside our own
 * namespace collapse to `<external>`; line/column numbers are
 * dropped. See docs/PRIVACY.md "Crash reports" and
 * docs/ANALYTICS_IMPLEMENTATION_PLAN.md "Console and crash capture"
 * for the full spec.
 *
 * Reporter-internal discipline: a reentrant guard prevents the
 * pipeline from recursing into itself if the reporter's own code
 * throws or calls console.error. The original console references
 * are always used for dev logging inside the reporter.
 */

import type {
  ErrorCategory,
  ErrorSource,
  ErrorEvent as TelemetryErrorEvent,
  ErrorDetailEvent,
} from '../types'
import { emit } from './emitter'

// --- Caps (docs/ANALYTICS_IMPLEMENTATION_PLAN.md) ---

export const TIER_A_CAP_PER_SIG = 3
export const TIER_A_CAP_TOTAL = 30
export const TIER_B_CAP_PER_SIG = 1
export const TIER_B_CAP_TOTAL = 10
export const MESSAGE_CLASS_MAX = 80
export const MAX_FRAMES = 10
export const STACK_SIGNATURE_HEX_LEN = 12

// --- Internal state (reset via resetForTests) ---

interface CaptureState {
  installed: boolean
  insideCapture: boolean
  originalConsoleError: typeof console.error | null
  originalConsoleWarn: typeof console.warn | null
  windowErrorHandler: EventListener | null
  rejectionHandler: EventListener | null
  /** Tauri event-listener detacher returned by `listen()`. Set on
   * desktop / mobile when the panic-hook listener installs; null on
   * web and on environments where the lazy import fails. */
  tauriUnlisten: (() => void) | null
  /** Per-signature total occurrence count. */
  sigCounts: Map<string, number>
  /** Emissions so far, keyed by `${tier}|${sig}` where tier is 'A' or 'B'. */
  sigEmissions: Map<string, number>
  tierATotal: number
  tierBTotal: number
}

function createState(): CaptureState {
  return {
    installed: false,
    insideCapture: false,
    originalConsoleError: null,
    originalConsoleWarn: null,
    windowErrorHandler: null,
    rejectionHandler: null,
    tauriUnlisten: null,
    sigCounts: new Map(),
    sigEmissions: new Map(),
    tierATotal: 0,
    tierBTotal: 0,
  }
}

let state = createState()

// --- Public API ---

/** Report a caught error from application code. `category` classifies
 * the failure site; `source` defaults to `'caught'`. Never throws;
 * reporter-internal failures are silently dropped. */
export function reportError(
  category: ErrorCategory,
  err: unknown,
  source: ErrorSource = 'caught',
): void {
  if (state.insideCapture) return
  state.insideCapture = true
  try {
    const normalized = normalize(category, source, err)
    if (normalized === null) return
    emitNormalized(normalized)
  } catch {
    // Reporter-internal error — silently drop to avoid loops
  } finally {
    state.insideCapture = false
  }
}

/** Install global handlers and patch the console. Safe to call
 * multiple times; becomes a no-op after the first successful call. */
export function install(): void {
  if (state.installed) return
  state.installed = true

  if (typeof window !== 'undefined') {
    const onError: EventListener = (event) => {
      const ee = event as ErrorEvent
      const err = ee.error ?? ee.message
      reportError('uncaught', err, 'window_error')
    }
    const onRejection: EventListener = (event) => {
      const re = event as PromiseRejectionEvent
      reportError('uncaught', re.reason, 'unhandledrejection')
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    state.windowErrorHandler = onError
    state.rejectionHandler = onRejection
  }

  if (typeof console !== 'undefined') {
    state.originalConsoleError = console.error
    state.originalConsoleWarn = console.warn
    const origErr = state.originalConsoleError
    const origWarn = state.originalConsoleWarn
    console.error = (...args: unknown[]): void => {
      origErr.apply(console, args)
      reportError('console', stringifyArgs(args), 'console_error')
    }
    console.warn = (...args: unknown[]): void => {
      origWarn.apply(console, args)
      reportError('console', stringifyArgs(args), 'console_warn')
    }
  }

  // Tauri native panic listener. Lazy-imported behind the existing
  // __TAURI__ sentinel so web builds never touch
  // @tauri-apps/api/event. The Rust side (src-tauri/src/lib.rs)
  // installs a panic hook that emits `native_panic` payloads;
  // forwarding them through reportError gives them a proper
  // `category=native_panic` + `source=tauri_panic` envelope and
  // runs them through the same sanitizer + dedupe pipeline.
  attachTauriPanicListener()
}

function attachTauriPanicListener(): void {
  const win = typeof window !== 'undefined'
    ? (window as unknown as { __TAURI__?: unknown })
    : null
  if (!win || !win.__TAURI__) return
  void import('@tauri-apps/api/event').then((mod) => {
    // Re-check inside the async callback — uninstall() may have run
    // between import start and resolution, in which case attaching
    // would leak a listener.
    if (!state.installed) return
    void mod
      .listen<NativePanicPayload>('native_panic', (event) => {
        const payload = event.payload
        const message = payload?.location
          ? `${payload.message} (${payload.location})`
          : payload?.message ?? '<unknown native panic>'
        reportError('native_panic', message, 'tauri_panic')
      })
      .then((unlisten) => {
        // Stash for uninstall(). If install was torn down between
        // listen() resolving and us getting here, fire the unlisten
        // right away.
        if (!state.installed) {
          unlisten()
          return
        }
        state.tauriUnlisten = unlisten
      })
      .catch(() => {
        // Tauri event API not available (web build masquerading as
        // Tauri, plugin missing) — silently no-op.
      })
  }).catch(() => {
    // Lazy import failed (extremely locked-down environment) —
    // silently no-op. The Rust default hook still logs to stderr
    // / Tauri log, so panics aren't silent at the OS level.
  })
}

/** Shape mirrors `NativePanicPayload` in src-tauri/src/lib.rs. */
interface NativePanicPayload {
  message: string
  location: string | null
}

/** Remove global handlers and restore the original console. */
export function uninstall(): void {
  if (!state.installed) return
  state.installed = false

  if (typeof window !== 'undefined') {
    if (state.windowErrorHandler) {
      window.removeEventListener('error', state.windowErrorHandler)
    }
    if (state.rejectionHandler) {
      window.removeEventListener('unhandledrejection', state.rejectionHandler)
    }
  }

  if (state.originalConsoleError) console.error = state.originalConsoleError
  if (state.originalConsoleWarn) console.warn = state.originalConsoleWarn
  state.originalConsoleError = null
  state.originalConsoleWarn = null
  state.windowErrorHandler = null
  if (state.tauriUnlisten) {
    state.tauriUnlisten()
    state.tauriUnlisten = null
  }
  state.rejectionHandler = null
}

// --- Sanitizer ---

/** Sanitize a raw error message: strip URLs, emails, UUIDs, long
 * digit runs, absolute file paths; collapse whitespace; truncate to
 * MESSAGE_CLASS_MAX. Returns an empty string for cross-origin
 * `"Script error."` (which carries no usable information). */
export function sanitizeMessage(raw: string): string {
  if (typeof raw !== 'string') return ''
  if (raw === 'Script error.' || raw === 'Script error') return ''

  let msg = raw

  // URLs — handle before path/digit rules so :port and ?query don't
  // match those patterns.
  msg = msg.replace(/https?:\/\/\S+/gi, '<url>')
  msg = msg.replace(/\btauri:\/\/\S+/gi, '<url>')
  msg = msg.replace(/\bfile:\/\/\S+/gi, '<url>')
  msg = msg.replace(/\basset\.localhost\/\S+/gi, '<url>')

  // Take the first line before any other rule — a multi-line stack
  // trace in a message collapses to just the top-line summary.
  msg = msg.split(/[\r\n]/)[0] ?? ''

  // Emails — local@domain.tld
  msg = msg.replace(/\b[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '<email>')

  // UUIDs — 8-4-4-4-12 hex
  msg = msg.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    '<uuid>',
  )

  // Normalize in-repo paths FIRST — strip any prefix up to `src/` or
  // `node_modules/` so local and CI paths compare equal. Run before
  // the absolute-path rule so those tokens survive.
  msg = msg.replace(/\S*\/(src\/[\w./-]+)/g, '$1')
  msg = msg.replace(/\S*\/(node_modules\/[\w./-]+)/g, '$1')

  // Absolute filesystem paths NOT already normalized above.
  msg = msg.replace(
    /\/(?:home|Users|var|tmp|root|usr|opt|etc|private)\/[^\s'"`]+/g,
    '<path>',
  )
  msg = msg.replace(/\b[A-Z]:\\[^\s'"`]+/g, '<path>')

  // Long digit runs (6+) — IDs, timestamps, tokens
  msg = msg.replace(/\b\d{6,}\b/g, '<num>')

  // Collapse internal whitespace
  msg = msg.replace(/\s+/g, ' ').trim()

  if (msg.length > MESSAGE_CLASS_MAX) {
    msg = msg.slice(0, MESSAGE_CLASS_MAX - 3) + '...'
  }
  return msg
}

// --- Stack normalization ---

interface NormalizedFrame {
  fn: string
  /** `'own'` = our code (src/) or bundled libraries we ship;
   * `'external'` = browser extension, third-party script, unknown. */
  src: 'own' | 'external'
}

const OWN_URL_PATTERNS = [
  /\/src\//,
  /\/node_modules\//,
  /\/assets\//, // Vite-built bundles
  /tauri:\/\//,
  /asset\.localhost\//,
  /^[^/]*$/, // bare script tags, no slashes
]

const EXTENSION_URL_PATTERNS = [
  /^chrome-extension:/,
  /^moz-extension:/,
  /^safari-extension:/,
  /^safari-web-extension:/,
]

/** Parse a stack trace into normalized frames and compute a stable
 * signature. Accepts Chrome, Firefox, and Safari formats. Returns
 * null if no frames could be parsed. */
export function normalizeStack(stack: string | undefined | null): {
  signature: string
  frames: NormalizedFrame[]
} | null {
  if (!stack || typeof stack !== 'string') return null
  const lines = stack.split('\n')
  const raw: NormalizedFrame[] = []

  for (const line of lines) {
    const frame = parseFrameLine(line)
    if (frame) raw.push(frame)
  }
  if (raw.length === 0) return null

  // Collapse consecutive externals into a single <external> marker.
  const frames: NormalizedFrame[] = []
  for (const f of raw) {
    if (
      f.src === 'external' &&
      frames.length > 0 &&
      frames[frames.length - 1].src === 'external'
    ) {
      continue
    }
    frames.push(f)
    if (frames.length >= MAX_FRAMES) break
  }

  const sigInput = frames.map((f) => `${f.src}:${f.fn}`).join('\n')
  const signature = shortHash(sigInput)
  return { signature, frames }
}

function parseFrameLine(line: string): NormalizedFrame | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  // Chrome / Node format: "    at functionName (url:line:col)"
  // or                   "    at url:line:col"
  let match = /^at\s+(?:(.+?)\s+\()?(.+?)(?::\d+:\d+)?\)?$/.exec(trimmed)
  if (match) {
    const fn = (match[1] ?? '<anonymous>').trim()
    const url = (match[2] ?? '').trim()
    return classifyFrame(fn, url)
  }

  // Safari / Firefox: "functionName@url:line:col"
  match = /^(.*?)@(.+?)(?::\d+:\d+)?$/.exec(trimmed)
  if (match) {
    const fn = (match[1] || '<anonymous>').trim()
    const url = (match[2] ?? '').trim()
    return classifyFrame(fn, url)
  }

  return null
}

function classifyFrame(fn: string, url: string): NormalizedFrame {
  // Browser-extension frames are dropped at the source
  for (const pat of EXTENSION_URL_PATTERNS) {
    if (pat.test(url)) return { fn: '<external>', src: 'external' }
  }
  for (const pat of OWN_URL_PATTERNS) {
    if (pat.test(url)) return { fn: sanitizeFunctionName(fn), src: 'own' }
  }
  return { fn: '<external>', src: 'external' }
}

function sanitizeFunctionName(fn: string): string {
  // Strip bound-function and async-wrapper noise; cap length.
  let name = fn.replace(/^async\s+/, '').replace(/^\*/, '')
  name = name.replace(/\s+/g, '')
  if (!name || name === '<anonymous>') return '<anonymous>'
  if (name.length > 60) name = name.slice(0, 60) + '...'
  return name
}

// --- Normalization pipeline ---

interface NormalizedError {
  category: ErrorCategory
  source: ErrorSource
  code: string
  messageClass: string
  stackSignature: string | null
  frames: NormalizedFrame[]
}

function normalize(
  category: ErrorCategory,
  source: ErrorSource,
  err: unknown,
): NormalizedError | null {
  const { message, stack, code } = extractFields(err)
  const messageClass = sanitizeMessage(message)
  if (messageClass === '') return null // `Script error.` and similar
  const normalized = normalizeStack(stack)
  return {
    category,
    source,
    code: code ?? 'unknown',
    messageClass,
    stackSignature: normalized?.signature ?? null,
    frames: normalized?.frames ?? [],
  }
}

function extractFields(err: unknown): {
  message: string
  stack: string | undefined
  code: string | undefined
} {
  if (err instanceof Error) {
    const maybeCode = (err as unknown as { code?: unknown }).code
    return {
      message: err.message || err.name || 'Error',
      stack: err.stack,
      code: typeof maybeCode === 'string' || typeof maybeCode === 'number'
        ? String(maybeCode)
        : undefined,
    }
  }
  if (typeof err === 'string') return { message: err, stack: undefined, code: undefined }
  if (err === null || err === undefined) {
    return { message: 'null', stack: undefined, code: undefined }
  }
  try {
    return { message: String(err), stack: undefined, code: undefined }
  } catch {
    return { message: 'unknown', stack: undefined, code: undefined }
  }
}

// --- Dedup + emission ---

function emitNormalized(n: NormalizedError): void {
  const sig = `${n.category}|${n.source}|${n.messageClass}|${n.stackSignature ?? ''}`

  const prevCount = state.sigCounts.get(sig) ?? 0
  state.sigCounts.set(sig, prevCount + 1)

  // Tier A emission (always emits up to caps; the event-level tier
  // gate in the emitter filters Off / Essential / Research).
  const keyA = `A|${sig}`
  const emittedA = state.sigEmissions.get(keyA) ?? 0
  if (emittedA < TIER_A_CAP_PER_SIG && state.tierATotal < TIER_A_CAP_TOTAL) {
    const event: TelemetryErrorEvent = {
      event_type: 'error',
      category: n.category,
      source: n.source,
      code: n.code,
      message_class: n.messageClass,
      count_in_batch: 1,
    }
    emit(event)
    state.sigEmissions.set(keyA, emittedA + 1)
    state.tierATotal++
  }

  // Tier B emission — dropped silently at the emitter if tier !==
  // 'research'. Only emit if we actually have a stack; no stack ==
  // no useful error_detail.
  if (n.stackSignature === null || n.frames.length === 0) return
  const keyB = `B|${sig}`
  const emittedB = state.sigEmissions.get(keyB) ?? 0
  if (emittedB < TIER_B_CAP_PER_SIG && state.tierBTotal < TIER_B_CAP_TOTAL) {
    const event: ErrorDetailEvent = {
      event_type: 'error_detail',
      category: n.category,
      source: n.source,
      message_class: n.messageClass,
      stack_signature: n.stackSignature,
      frames_json: JSON.stringify(
        n.frames.map((f) => ({ fn: f.fn })),
      ),
      count_in_batch: 1,
    }
    emit(event)
    state.sigEmissions.set(keyB, emittedB + 1)
    state.tierBTotal++
  }
}

function stringifyArgs(args: unknown[]): string {
  if (args.length === 0) return ''
  const first = args[0]
  if (first instanceof Error) return first.message || first.name || 'Error'
  if (typeof first === 'string') return first
  try {
    return String(first)
  } catch {
    return 'console'
  }
}

// --- Test helpers (not exported from the barrel) ---

/** Reset all capture state. Tests call this between cases. */
export function resetForTests(): void {
  uninstall()
  state = createState()
}

/** Peek at the per-signature counter for tests. */
export function __getSigCount(
  category: ErrorCategory,
  source: ErrorSource,
  messageClass: string,
  stackSig: string | null = null,
): number {
  const sig = `${category}|${source}|${messageClass}|${stackSig ?? ''}`
  return state.sigCounts.get(sig) ?? 0
}

// --- Tiny non-crypto hash (djb2 xor) ---

/** Short hex signature for stack fingerprinting. Not cryptographic
 * — dedup identity only. 12 hex chars ≈ 48 bits of collision
 * resistance is plenty for within-session uniqueness. */
function shortHash(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i)
    h = h >>> 0 // coerce to unsigned 32-bit
  }
  const hex = h.toString(16).padStart(8, '0')
  // Double-round for a slightly longer signature that survives a
  // single 32-bit collision. Good enough for a dedup key.
  let h2 = 0
  for (let i = input.length - 1; i >= 0; i--) {
    h2 = ((h2 << 5) + h2) ^ input.charCodeAt(i)
    h2 = h2 >>> 0
  }
  return (hex + h2.toString(16).padStart(8, '0')).slice(0, STACK_SIGNATURE_HEX_LEN)
}
