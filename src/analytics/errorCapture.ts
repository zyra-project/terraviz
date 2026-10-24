// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Error capture pipeline.
 *
 * Three input sources funnel through a shared sanitize → dedup →
 * emit path:
 *
 *   1. Global uncaught handlers — window.error, unhandledrejection
 *   2. The Tauri `native_panic` event, emitted by the Rust panic hook
 *      in src-tauri/src/lib.rs (desktop only)
 *   3. Explicit call sites — reportError(category, err) from code
 *      that wants to report a caught failure
 *
 * 1 and 2 are attached by `install()`, which `src/main.ts` calls on
 * the SPA path as soon as boot has set the transport. Nothing else
 * installs them: the publisher portal and the blog never boot the app,
 * and an output window boots from its own entry and emits nothing
 * (MULTI_MONITOR_PLAN.md §3.6). The global handlers see every error
 * on the page, not only ours, so they drop what a browser extension
 * or another site's script raised (`isForeignError`) — the policy
 * says those are dropped entirely, and each would also spend a slot
 * of the per-session cap.
 *
 * The console is deliberately **not** patched, though the plan
 * proposed it. Exception messages are what the sanitizer was built
 * for; log lines are not. The app's own `logger.warn` / `logger.error`
 * lines interpolate whatever the author had to hand, and some of it
 * is exactly what telemetry promises never to send: the multi-output
 * manager logs a monitor's OS display name and its origin, which
 * `outputTelemetry` reports as an enumeration index precisely so the
 * name never leaves the machine, and no pattern rule can tell a
 * display name from prose. HLS.js failures and our own shader
 * compiles already reach `reportError` from their call sites with a
 * real category, where a patch would report them twice. MapLibre's do
 * not — nothing listens for its `error` event, so it logs to the
 * console instead — and that gap wants a listener with a category, not
 * a patch that would carry every other log line with it.
 *
 * Privacy discipline is non-negotiable: message text is sanitized
 * (URLs, emails, UUIDs, digit runs, file paths stripped) and
 * truncated to 80 chars before emit; stack frames outside our own
 * namespace collapse to `<external>`; line/column numbers are
 * dropped. See docs/PRIVACY.md §2 and
 * docs/ANALYTICS_IMPLEMENTATION_PLAN.md "Console and crash capture"
 * for the full spec.
 *
 * Reporter-internal discipline: a reentrant guard prevents the
 * pipeline from recursing into itself if the reporter's own code
 * throws.
 */

import type {
  ErrorCategory,
  ErrorSource,
  ErrorEvent as TelemetryErrorEvent,
  ErrorDetailEvent,
} from '../types'
import { emit, isSilencedPath, tierGate } from './emitter'

// --- Caps (docs/ANALYTICS_IMPLEMENTATION_PLAN.md) ---

export const TIER_A_CAP_PER_SIG = 3
export const TIER_A_CAP_TOTAL = 30
export const TIER_B_CAP_PER_SIG = 1
export const TIER_B_CAP_TOTAL = 10
export const MESSAGE_CLASS_MAX = 80
/** How much of a message's first line the sanitizer reads. */
export const SANITIZE_INPUT_MAX = 1024
export const MAX_FRAMES = 10
export const STACK_SIGNATURE_HEX_LEN = 12
/** Distinct signatures the occurrence counter remembers. It is bumped
 * before any cap applies, so with a global handler live, an error
 * whose message varies per frame would otherwise grow it for the life
 * of a kiosk that runs for days. */
export const MAX_TRACKED_SIGNATURES = 256

/** `code` reaches Tier A verbatim, and the global handlers let any
 * thrower set it, so only short identifier-shaped values pass:
 * `ERR_NETWORK`, `404`, a DOMException's number. */
const CODE_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/

// --- Internal state (reset via resetForTests) ---

interface CaptureState {
  installed: boolean
  insideCapture: boolean
  windowErrorHandler: EventListener | null
  rejectionHandler: EventListener | null
  /** Tauri event-listener detacher returned by `listen()`. Set on
   * desktop / mobile when the panic-hook listener installs; null on
   * web and on environments where the lazy import fails. */
  tauriUnlisten: (() => void) | null
  /** Per-signature total occurrence count, for at most
   * `MAX_TRACKED_SIGNATURES` signatures. */
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

/** Install the global handlers and the Tauri panic listener. Safe to
 * call multiple times; becomes a no-op after the first successful
 * call. Declines on a silenced path (the privacy page), where every
 * report would be dropped at `emit()` anyway, and does not latch
 * there, so a later call from a page that may emit still installs. */
export function install(): void {
  if (state.installed) return
  if (isSilencedPath()) return
  state.installed = true

  if (typeof window !== 'undefined') {
    const onError: EventListener = (event) => {
      const ee = event as ErrorEvent
      // Chrome raises this whenever a ResizeObserver callback resizes
      // what it observes, which five UI modules can. It is benign, has
      // no stack to attribute, and would otherwise be the commonest
      // `uncaught` report and spend the session's cap on nothing.
      if (typeof ee.message === 'string' && /^ResizeObserver loop\b/.test(ee.message)) return
      if (isForeignError(stackOf(ee.error), ee.filename)) return
      const err = ee.error ?? ee.message
      reportError('uncaught', err, 'window_error')
    }
    const onRejection: EventListener = (event) => {
      const re = event as PromiseRejectionEvent
      if (isForeignError(stackOf(re.reason))) return
      reportError('uncaught', re.reason, 'unhandledrejection')
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    state.windowErrorHandler = onError
    state.rejectionHandler = onRejection
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
        // The hook sends `file:line`. The file says which module
        // panicked; the line is what the policy promises Tier A never
        // carries, and the digit rule only strips runs of six.
        const where = payload?.location?.replace(/:\d+(?::\d+)?$/, '')
        const message = where
          ? `${payload?.message} (${where})`
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

/** Remove the global handlers and the Tauri panic listener. */
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

  // Take the first line before any other rule — a multi-line stack
  // trace in a message collapses to just the top-line summary — and
  // only so much of it: every rule below runs over text any thrower on
  // the page controls, and the output keeps 80 characters anyway.
  let msg = (raw.split(/[\r\n]/)[0] ?? '').slice(0, SANITIZE_INPUT_MAX)

  // URLs — handle before path/digit rules so :port and ?query don't
  // match those patterns. Any scheme, not a list: `zyra://` deep links,
  // `wss://` with a token, `asset://localhost/%2FUsers%2F…` (what
  // `convertFileSrc` returns on macOS and Linux) all carry something.
  msg = msg.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
  msg = msg.replace(/\bdata:[^\s'"`]+/gi, '<url>')
  msg = msg.replace(/\basset\.localhost\/\S+/gi, '<url>')
  // A relative URL with a query string (`/api/v1/search?q=…`).
  msg = msg.replace(/(^|[\s('"`=])\/[^\s'"`?]*\?[^\s'"`]+/g, '$1<url>')

  // Emails — local@domain.tld
  msg = msg.replace(/\b[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '<email>')

  // UUIDs — 8-4-4-4-12 hex
  msg = msg.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    '<uuid>',
  )

  // Normalize in-repo paths FIRST — strip any prefix up to `src/` or
  // `node_modules/` so local and CI paths compare equal. Run before
  // the absolute-path rule so those tokens survive. Anchored to the
  // start of a token: unanchored, a long token with no `/src/` in it
  // costs quadratic time, and an 80 KB rejection reason held the main
  // thread for eight seconds.
  msg = msg.replace(/(?<!\S)\S*\/(src\/[\w./-]+)/g, '$1')
  msg = msg.replace(/(?<!\S)\S*\/(node_modules\/[\w./-]+)/g, '$1')

  // Home directories first. The segment after `/home/`, `/Users/` or
  // `C:\Users\` is the account name, and an account name can hold a
  // space (`C:\Users\John Smith`) or an apostrophe (`O'Brien`), where
  // the general rule below stops — leaving the surname behind. So that
  // segment runs to the next separator or quote (an apostrophe only
  // ends it before a non-letter), then the path's remainder to
  // whitespace. Windows separators may arrive doubled, as JSON and
  // Rust's `{:?}` write them. Mounted volumes are named the same way.
  // An unquoted home directory followed by prose loses the prose too;
  // stripping too much is the safe way to be wrong.
  msg = msg.replace(
    /\/(?:home|Users|Volumes|media)\/(?:[^/'"`]|'(?=\w))+(?:\/[^\s'"`]*)?/g,
    '<path>',
  )
  msg = msg.replace(
    /\b[A-Z]:\\+Users\\+(?:[^\\'"`]|'(?=\w))+(?:\\[^\s'"`]*)?/gi,
    '<path>',
  )

  // Other absolute filesystem paths NOT already normalized above, and
  // UNC shares (`\\fs01\profiles$\jsmith\…`, a roaming profile).
  msg = msg.replace(
    /\/(?:var|tmp|root|usr|opt|etc|private|mnt|run)\/[^\s'"`]+/g,
    '<path>',
  )
  msg = msg.replace(/\b[A-Z]:\\[^\s'"`]+/g, '<path>')
  msg = msg.replace(/(?<!\S)\\\\[^'"`]+/g, '<path>')

  // Addresses on the visitor's own network: an Ollama box at
  // `192.168.1.23:11434`, a laptop at `erics-macbook-pro.local`.
  msg = msg.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, '<ip>')
  msg = msg.replace(
    /\b[\w-]+(?:\.[\w-]+)*\.(?:local|lan|internal|localdomain|home\.arpa)\b/gi,
    '<host>',
  )

  // Opaque tokens — API keys, JWT segments, ULIDs: one word of 20+
  // characters that is mostly random. Digits and mixed case are the
  // tell; Chrome's `ERR_HTTP2_PROTOCOL_ERROR` is long but has neither
  // much of the one nor any of the other, and stays.
  msg = msg.replace(/(?<![\w-])[\w-]{20,}(?![\w-])/g, (word) =>
    looksLikeToken(word) ? '<token>' : word)

  // Quoted text that holds a space is someone's words, not an
  // identifier — an engine echoing a value back (V8's `Cannot create
  // property 'role' on string 'what is the flood risk at…'`). Quoted
  // identifiers (`reading 'addEventListener'`) carry the diagnosis and
  // stay. The opening quote must follow a delimiter and the closing
  // one precede another, so a contraction's apostrophe opens nothing.
  msg = msg.replace(
    /(^|[\s(,:=[])(['"`])((?:(?!\2)[^\r\n])*)\2(?=$|[\s),.:;!?\]])/g,
    (match, pre: string, quote: string, body: string) =>
      /\s/.test(body) ? `${pre}${quote}<str>${quote}` : match,
  )

  // Long digit runs (6+) — IDs, timestamps, tokens
  msg = msg.replace(/\b\d{6,}\b/g, '<num>')

  // Collapse internal whitespace
  msg = msg.replace(/\s+/g, ' ').trim()

  if (msg.length > MESSAGE_CLASS_MAX) {
    msg = msg.slice(0, MESSAGE_CLASS_MAX - 3) + '...'
  }
  return msg
}

function looksLikeToken(word: string): boolean {
  const digits = word.replace(/\D/g, '').length
  return digits >= 3 || (digits > 0 && /[a-z]/.test(word) && /[A-Z]/.test(word))
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
  const raw = stackFrames(stack).map((f) => classifyFrame(f.fn, f.url))
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

interface RawFrame {
  fn: string
  url: string
}

/** The frames of a stack, and nothing else. V8 (Chrome, Edge, the
 * Windows webview, Node) opens a stack with `Name: message`, every
 * line of the message included, and Safari / Firefox frames are
 * `fn@url` — so read naively, a message holding `jane@school` parses
 * as a frame named after the text before the `@`, lands in
 * `frames_json` with only its spaces removed, and never meets the
 * sanitizer. A stack with any `at` frame is therefore read as V8:
 * from its first frame on, `at` lines only. */
function stackFrames(stack: string): RawFrame[] {
  const lines = stack.split('\n').map((l) => l.trim()).filter(Boolean)
  const firstV8 = lines.findIndex((l) => /^at\s/.test(l))
  if (firstV8 >= 0) {
    return lines.slice(firstV8).map(splitV8Frame).filter((f): f is RawFrame => f !== null)
  }
  return lines.map(splitAtSignFrame).filter((f): f is RawFrame => f !== null)
}

/** Chrome / Node: "at functionName (url:line:col)" or "at url:line:col". */
function splitV8Frame(line: string): RawFrame | null {
  const match = /^at\s+(?:(.+?)\s+\()?(.+?)(?::\d+:\d+)?\)?$/.exec(line)
  if (!match) return null
  return { fn: (match[1] ?? '<anonymous>').trim(), url: (match[2] ?? '').trim() }
}

/** Safari / Firefox: "functionName@url:line:col". */
function splitAtSignFrame(line: string): RawFrame | null {
  const match = /^(.*?)@(.+?)(?::\d+:\d+)?$/.exec(line)
  if (!match) return null
  return { fn: (match[1] || '<anonymous>').trim(), url: (match[2] ?? '').trim() }
}

/** A location with no slash names no script: V8's `<anonymous>` and
 * `native`, WebKit's `[native code]`, Firefox's `debugger eval code`.
 * `classifyFrame` counts these as ours, which is right for reporting
 * the function name, but they say nothing about whose code was
 * running, so `isForeignError` steps over them. */
function isBuiltinLocation(url: string): boolean {
  return /^[^/]*$/.test(url)
}

function isExtensionUrl(url: string): boolean {
  return EXTENSION_URL_PATTERNS.some((pat) => pat.test(url))
}

function classifyFrame(fn: string, url: string): NormalizedFrame {
  // Browser-extension frames are dropped at the source
  if (isExtensionUrl(url)) return { fn: '<external>', src: 'external' }
  for (const pat of OWN_URL_PATTERNS) {
    if (pat.test(url)) return { fn: sanitizeFunctionName(fn), src: 'own' }
  }
  return { fn: '<external>', src: 'external' }
}

/** True when an error that reached a global handler was raised by a
 * browser extension or by another site's script rather than by this
 * app: the script it came from is an extension, the first frame with a
 * script location is an extension's, or no such frame is ours.
 * Built-in frames (`JSON.parse`, `[native code]`) are stepped over, so
 * an extension that throws inside `JSON.parse` is still the
 * extension's. An error with no located frame is kept, since nothing
 * says whose it is. Only the global handlers ask — an explicit
 * `reportError` is our own code reporting itself. Never throws: it
 * runs inside an `error` listener, where a throw would raise the event
 * it is handling. */
export function isForeignError(
  stack: string | undefined | null,
  filename?: string,
): boolean {
  try {
    if (typeof filename === 'string' && isExtensionUrl(filename)) return true
    if (typeof stack !== 'string' || !stack) return false
    const located = stackFrames(stack).filter((f) => !isBuiltinLocation(f.url))
    if (located.length === 0) return false
    if (isExtensionUrl(located[0].url)) return true
    return !located.some((f) => isFirstPartyLocation(f.url))
  } catch {
    return false
  }
}

/** Whether a frame's script is this app's. Asked by origin, not by
 * path: the bundle's directory is a build setting a self-hoster may
 * change, and the dev server serves `src/` from its root, so neither
 * `/assets/` nor `/src/` appears in every URL of ours — while a
 * third-party script can sit under either. Cloudflare's own injected
 * scripts share the origin under `/cdn-cgi/` and are not ours. A
 * location with no web origin (a file path, as test runs report) is
 * judged by the repo directories in it. */
function isFirstPartyLocation(url: string): boolean {
  const origin = typeof location !== 'undefined' ? location.origin : ''
  if (origin && origin !== 'null' && url.startsWith(`${origin}/`)) {
    return !url.startsWith(`${origin}/cdn-cgi/`)
  }
  if (/^(?:tauri:\/\/|https?:\/\/tauri\.localhost\/)/i.test(url)) return true
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^file:/i.test(url)) return false
  return /\/(?:src|node_modules)\//.test(url)
}

/** The stack of a thrown value, read without assuming it is an
 * `Error` from this realm. Never throws: reading `.stack` off a
 * revoked Proxy or a cross-origin window does. */
function stackOf(thrown: unknown): string | undefined {
  try {
    const stack = (thrown as { stack?: unknown } | null | undefined)?.stack
    return typeof stack === 'string' ? stack : undefined
  } catch {
    return undefined
  }
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
      code: (typeof maybeCode === 'string' || typeof maybeCode === 'number') &&
        CODE_PATTERN.test(String(maybeCode))
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

  const prevCount = state.sigCounts.get(sig)
  if (prevCount !== undefined) {
    state.sigCounts.set(sig, prevCount + 1)
  } else if (state.sigCounts.size < MAX_TRACKED_SIGNATURES) {
    state.sigCounts.set(sig, 1)
  }

  // Tier A emission, up to the caps. The emitter applies the tier gate
  // again; asking it here first is so a report the tier drops does not
  // spend the cap — or a visitor who turns telemetry on mid-session
  // finds the budget already used by reports nobody sent.
  const keyA = `A|${sig}`
  const emittedA = state.sigEmissions.get(keyA) ?? 0
  if (
    tierGate('error') &&
    emittedA < TIER_A_CAP_PER_SIG &&
    state.tierATotal < TIER_A_CAP_TOTAL
  ) {
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

  // Tier B emission — only on 'research', by the same gate and for the
  // same reason. Only emit if we actually have a stack; no stack ==
  // no useful error_detail.
  if (n.stackSignature === null || n.frames.length === 0) return
  const keyB = `B|${sig}`
  const emittedB = state.sigEmissions.get(keyB) ?? 0
  if (
    tierGate('error_detail') &&
    emittedB < TIER_B_CAP_PER_SIG &&
    state.tierBTotal < TIER_B_CAP_TOTAL
  ) {
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
