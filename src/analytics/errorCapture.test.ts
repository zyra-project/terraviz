// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ErrorEvent as TelemetryErrorEvent, ErrorDetailEvent } from '../types'
import { flush, resetForTests as resetEmitter } from './emitter'
import { setTier } from './config'
import {
  reportError,
  install,
  uninstall,
  sanitizeMessage,
  normalizeStack,
  resetForTests as resetCapture,
  __getSigCount,
  TIER_A_CAP_PER_SIG,
  TIER_A_CAP_TOTAL,
  TIER_B_CAP_PER_SIG,
  MESSAGE_CLASS_MAX,
  MAX_TRACKED_SIGNATURES,
  isForeignError,
} from './errorCapture'

function resetAll(): void {
  localStorage.clear()
  resetEmitter()
  resetCapture()
  setTier('research') // default to research in most tests so both tiers flow
}

// ─────────────────────────────────────────────────────────────────────
// sanitizeMessage — fixture table
// ─────────────────────────────────────────────────────────────────────

describe('sanitizeMessage', () => {
  const cases: Array<{ label: string; input: string; expected: string }> = [
    {
      label: 'cross-origin Script error. drops to empty',
      input: 'Script error.',
      expected: '',
    },
    {
      label: 'Script error (no period) also drops',
      input: 'Script error',
      expected: '',
    },
    {
      label: 'https URL with query string is stripped',
      input: 'Failed to fetch https://api.example.com/v1?token=abc123&key=xyz',
      expected: 'Failed to fetch <url>',
    },
    {
      label: 'http URL is stripped',
      input: 'GET http://localhost:8080/api failed',
      expected: 'GET <url> failed',
    },
    {
      label: 'multiple URLs all stripped',
      input: 'https://a.com/x failed, see https://b.com/y',
      expected: '<url> failed, see <url>',
    },
    {
      label: 'tauri:// URL stripped',
      input: 'cannot load tauri://localhost/asset',
      expected: 'cannot load <url>',
    },
    {
      label: 'file:// URL stripped',
      input: 'ENOENT file:///Users/alice/project/src/foo.ts',
      expected: 'ENOENT <url>',
    },
    {
      label: 'asset.localhost URL stripped',
      input: 'loading asset.localhost/abc123.png failed',
      expected: 'loading <url> failed',
    },
    {
      label: 'email is stripped',
      input: 'notify alice@example.com of failure',
      expected: 'notify <email> of failure',
    },
    {
      label: 'v4 UUID is stripped',
      input: 'dataset 550e8400-e29b-41d4-a716-446655440000 missing',
      expected: 'dataset <uuid> missing',
    },
    {
      label: 'long digit run (6+) stripped',
      input: 'request id 123456789 failed',
      expected: 'request id <num> failed',
    },
    {
      label: 'short digits preserved',
      input: 'HTTP 404 not found',
      expected: 'HTTP 404 not found',
    },
    {
      label: 'absolute home path stripped',
      input: 'cannot read /home/alice/secret/keys.json',
      expected: 'cannot read <path>',
    },
    {
      label: 'absolute Users path stripped',
      input: 'file not found: /Users/bob/project/secret.env',
      expected: 'file not found: <path>',
    },
    {
      label: 'Windows path stripped',
      input: 'access denied C:\\Users\\carol\\secret.txt',
      expected: 'access denied <path>',
    },
    {
      label: 'src/ prefix normalized',
      input: 'TypeError in /home/alice/repo/src/services/foo.ts',
      expected: 'TypeError in src/services/foo.ts',
    },
    {
      label: 'node_modules/ prefix normalized',
      input: 'crash in /home/alice/repo/node_modules/maplibre-gl/dist/x.js',
      expected: 'crash in node_modules/maplibre-gl/dist/x.js',
    },
    {
      label: 'first line only',
      input: 'TypeError: oops\n    at foo\n    at bar',
      expected: 'TypeError: oops',
    },
    {
      label: 'collapses internal whitespace',
      input: 'too    many\t\tspaces',
      expected: 'too many spaces',
    },
    {
      label: 'truncates to MESSAGE_CLASS_MAX',
      input: 'x'.repeat(200),
      expected: 'x'.repeat(MESSAGE_CLASS_MAX - 3) + '...',
    },
    {
      label: 'token inside URL is stripped as part of the URL',
      input: 'https://example.com/auth?token=eyJhbGciOiJIUzI1NiJ9.aaa failed',
      expected: '<url> failed',
    },
    {
      label: 'account name with a space in a Unix home path is stripped whole',
      input: 'cannot open /Users/jane doe/Library/x.db',
      expected: 'cannot open <path>',
    },
    {
      label: 'account name with a space in a Windows profile path is stripped whole',
      input: 'access denied C:\\Users\\John Smith\\AppData\\Local\\x.txt',
      expected: 'access denied <path>',
    },
    {
      label: 'quoted home path ends at its quote, keeping the text after',
      input: 'failed to read "/home/ann lee/notes.txt": not found',
      expected: 'failed to read "<path>": not found',
    },
    {
      label: 'in-repo normalization leaves no part of a spaced account name behind',
      input: 'TypeError in /home/john smith/repo/src/services/foo.ts',
      expected: 'TypeError in <path>',
    },
    {
      label: "account name with an apostrophe is stripped whole",
      input: "denied C:\\Users\\Sean O'Brien\\AppData\\x.txt",
      expected: 'denied <path>',
    },
    {
      label: 'doubled Windows separators, as JSON and Rust write them',
      input: 'denied C:\\\\Users\\\\John Smith\\\\AppData\\\\x.txt',
      expected: 'denied <path>',
    },
    {
      label: 'a mounted volume name is stripped like an account name',
      input: 'cannot open /Volumes/Jane Drive/data.nc',
      expected: 'cannot open <path>',
    },
    {
      label: 'UNC share path is stripped',
      input: 'cannot open \\\\fs01\\profiles$\\jsmith42\\x.db',
      expected: 'cannot open <path>',
    },
    {
      label: 'any scheme is a URL, not only http',
      input: 'bad link zyra://dataset/X?lat=40.01 and asset://localhost/%2FUsers%2Fjsmith%2Fx',
      expected: 'bad link <url> and <url>',
    },
    {
      label: 'relative URL with a query string is stripped',
      input: 'GET /api/v1/search?q=flooding+near+412+Elm failed',
      expected: 'GET <url> failed',
    },
    {
      label: 'LAN address and local hostname are stripped',
      input: 'cannot reach 192.168.1.23:11434 or erics-macbook-pro.local',
      expected: 'cannot reach <ip> or <host>',
    },
    {
      label: 'opaque token is stripped',
      input: 'Incorrect API key sk-proj-a1B2c3D4e5F6g7H8i9J0 provided',
      expected: 'Incorrect API key <token> provided',
    },
    {
      label: 'a long identifier-like error code survives the token rule',
      input: 'net::ERR_HTTP2_PROTOCOL_ERROR',
      expected: 'net::ERR_HTTP2_PROTOCOL_ERROR',
    },
    {
      label: 'quoted text with a space, an echoed value, is stripped',
      input: "Cannot create property 'role' on string 'what is the flood risk at my house'",
      expected: "Cannot create property 'role' on string '<str>'",
    },
    {
      label: 'quoted identifiers stay',
      input: "Cannot read properties of undefined (reading 'addEventListener')",
      expected: "Cannot read properties of undefined (reading 'addEventListener')",
    },
    {
      label: 'apostrophes in contractions open no quote',
      input: "can't load the dataset's frames",
      expected: "can't load the dataset's frames",
    },
  ]

  for (const { label, input, expected } of cases) {
    it(label, () => {
      expect(sanitizeMessage(input)).toBe(expected)
    })
  }

  it('reads a bounded prefix, so a huge message cannot stall the page', () => {
    // Unbounded, an 80 KB token with no `/src/` in it took eight
    // seconds on the path-normalization rule. The bound is generous:
    // bounded, this is well under a millisecond.
    const huge = 'x'.repeat(80_000)
    const started = performance.now()
    const out = sanitizeMessage(huge)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(out.length).toBe(MESSAGE_CLASS_MAX)
  })
})

// ─────────────────────────────────────────────────────────────────────
// normalizeStack — frame classification and external collapse
// ─────────────────────────────────────────────────────────────────────

describe('normalizeStack', () => {
  it('returns null for empty or missing stacks', () => {
    expect(normalizeStack(undefined)).toBeNull()
    expect(normalizeStack(null)).toBeNull()
    expect(normalizeStack('')).toBeNull()
  })

  it('parses Chrome-format frames and classifies src/ as own', () => {
    const stack = [
      'Error: oops',
      '    at loadDataset (http://localhost:5173/src/services/datasetLoader.ts:42:10)',
      '    at onClick (http://localhost:5173/src/ui/browseUI.ts:89:5)',
    ].join('\n')
    const result = normalizeStack(stack)
    expect(result).not.toBeNull()
    expect(result!.frames.every((f) => f.src === 'own')).toBe(true)
    expect(result!.frames.map((f) => f.fn)).toEqual([
      'loadDataset',
      'onClick',
    ])
  })

  it('collapses consecutive chrome-extension frames to a single <external>', () => {
    const stack = [
      'Error: oops',
      '    at ext1 (chrome-extension://abc/foo.js:1:1)',
      '    at ext2 (chrome-extension://abc/bar.js:1:1)',
      '    at ext3 (chrome-extension://abc/baz.js:1:1)',
      '    at ourHandler (http://localhost/src/foo.ts:1:1)',
    ].join('\n')
    const result = normalizeStack(stack)!
    const externals = result.frames.filter((f) => f.src === 'external')
    expect(externals.length).toBe(1)
    expect(externals[0].fn).toBe('<external>')
    expect(result.frames.some((f) => f.fn === 'ourHandler')).toBe(true)
  })

  it('treats cross-origin non-extension URLs as external', () => {
    const stack = [
      'Error: oops',
      '    at suspicious (https://evil.example/script.js:10:10)',
    ].join('\n')
    const result = normalizeStack(stack)!
    expect(result.frames.every((f) => f.src === 'external')).toBe(true)
  })

  it('parses Safari-style stacks (functionName@url format)', () => {
    const stack = [
      'loadDataset@http://localhost:5173/src/services/datasetLoader.ts:42:10',
      'onClick@http://localhost:5173/src/ui/browseUI.ts:89:5',
    ].join('\n')
    const result = normalizeStack(stack)!
    expect(result.frames.map((f) => f.fn)).toEqual(['loadDataset', 'onClick'])
  })

  it('produces a stable signature for the same normalized stack', () => {
    const stack = 'at foo (http://localhost/src/a.ts:1:1)\nat bar (http://localhost/src/b.ts:2:2)'
    const a = normalizeStack(stack)!
    const b = normalizeStack(stack)!
    expect(a.signature).toBe(b.signature)
    expect(a.signature.length).toBeGreaterThan(0)
  })

  it('produces different signatures for different stacks', () => {
    const s1 = 'at foo (http://localhost/src/a.ts:1:1)'
    const s2 = 'at bar (http://localhost/src/b.ts:2:2)'
    expect(normalizeStack(s1)!.signature).not.toBe(normalizeStack(s2)!.signature)
  })

  it('never reads a V8 message line as a frame', () => {
    // V8 opens a stack with the message, every line of it. A line with
    // an `@` in it is the Safari frame shape, and its text would land
    // in frames_json as a function name, unsanitized.
    const stack = [
      'Error: invalid contact jane.doe@school',
      'second line with secret jdoe@corp',
      '    at submit (https://example.org/assets/main.js:1:1)',
    ].join('\n')
    expect(normalizeStack(stack)!.frames.map((f) => f.fn)).toEqual(['submit'])
  })

  it('caps the frame list at the configured max', () => {
    const frames = Array.from({ length: 30 }, (_, i) =>
      `    at fn${i} (http://localhost/src/x.ts:1:1)`,
    )
    const result = normalizeStack(['Error: x', ...frames].join('\n'))!
    expect(result.frames.length).toBeLessThanOrEqual(10)
  })
})

// ─────────────────────────────────────────────────────────────────────
// reportError — drop, dedup, cap, tier routing
// ─────────────────────────────────────────────────────────────────────

describe('reportError', () => {
  beforeEach(() => resetAll())

  it('drops Script error. silently', () => {
    reportError('uncaught', 'Script error.', 'window_error')
    expect(flush()).toEqual([])
  })

  it('drops Script error (no period) silently', () => {
    reportError('uncaught', 'Script error', 'window_error')
    expect(flush()).toEqual([])
  })

  it('emits an error event for a regular Error', () => {
    reportError('hls', new Error('playlist 404'), 'caught')
    const drained = flush()
    const errEvent = drained.find((e) => e.event_type === 'error') as
      | TelemetryErrorEvent
      | undefined
    expect(errEvent).toBeTruthy()
    expect(errEvent?.category).toBe('hls')
    expect(errEvent?.message_class).toBe('playlist 404')
    expect(errEvent?.count_in_batch).toBe(1)
  })

  it('handles string errors', () => {
    reportError('llm', 'something went wrong', 'caught')
    const drained = flush()
    const errEvent = drained.find((e) => e.event_type === 'error') as
      | TelemetryErrorEvent
      | undefined
    expect(errEvent?.message_class).toBe('something went wrong')
  })

  it('handles non-Error, non-string throwables', () => {
    reportError('uncaught', { oops: true }, 'caught')
    const drained = flush()
    const errEvent = drained.find((e) => e.event_type === 'error') as
      | TelemetryErrorEvent
      | undefined
    expect(errEvent).toBeTruthy()
  })

  it('handles null / undefined throwables', () => {
    reportError('uncaught', null, 'caught')
    reportError('uncaught', undefined, 'caught')
    // Both should emit something (a 'null' or 'undefined' message
    // class) rather than throw or silently drop.
    const drained = flush()
    expect(drained.filter((e) => e.event_type === 'error').length).toBe(2)
  })

  it('emits Tier B error_detail when a stack is available and tier=research', () => {
    setTier('research')
    const err = new Error('boom')
    err.stack = [
      'Error: boom',
      '    at fn1 (http://localhost/src/foo.ts:1:1)',
      '    at fn2 (http://localhost/src/bar.ts:2:2)',
    ].join('\n')
    reportError('tile', err, 'caught')
    const drained = flush()
    const detail = drained.find((e) => e.event_type === 'error_detail') as
      | ErrorDetailEvent
      | undefined
    expect(detail).toBeTruthy()
    expect(detail?.stack_signature.length).toBeGreaterThan(0)
    const frames = JSON.parse(detail!.frames_json) as Array<{ fn: string }>
    expect(frames.length).toBeGreaterThan(0)
  })

  it('Tier B error_detail is dropped when tier=essential', () => {
    setTier('essential')
    const err = new Error('boom')
    err.stack = 'Error: boom\n    at fn (http://localhost/src/a.ts:1:1)'
    reportError('tile', err, 'caught')
    const drained = flush()
    expect(drained.some((e) => e.event_type === 'error')).toBe(true)
    expect(drained.some((e) => e.event_type === 'error_detail')).toBe(false)
  })

  it('drops everything when tier=off', () => {
    setTier('off')
    reportError('tile', new Error('boom'), 'caught')
    expect(flush()).toEqual([])
  })

  // --- Dedup behavior ---

  it('counts every report against the per-signature counter', () => {
    // Use a string error (no stack) so the signature is deterministic
    // without needing to know the stack hash.
    for (let i = 0; i < 7; i++) reportError('tile', 'flaky', 'caught')
    expect(__getSigCount('tile', 'caught', 'flaky')).toBe(7)
  })

  it('emits only up to TIER_A_CAP_PER_SIG copies of a repeated error', () => {
    setTier('essential') // focus on Tier A
    for (let i = 0; i < 10; i++) reportError('tile', new Error('flaky'), 'caught')
    const drained = flush()
    const errs = drained.filter((e) => e.event_type === 'error')
    expect(errs.length).toBe(TIER_A_CAP_PER_SIG)
  })

  it('emits different errors independently under the per-sig cap', () => {
    setTier('essential')
    for (let i = 0; i < 5; i++) reportError('tile', new Error('A'), 'caught')
    for (let i = 0; i < 5; i++) reportError('tile', new Error('B'), 'caught')
    const drained = flush()
    const errs = drained.filter((e) => e.event_type === 'error') as TelemetryErrorEvent[]
    const classes = new Set(errs.map((e) => e.message_class))
    expect(classes.has('A')).toBe(true)
    expect(classes.has('B')).toBe(true)
    expect(errs.length).toBe(TIER_A_CAP_PER_SIG * 2)
  })

  it('enforces TIER_A_CAP_TOTAL across all signatures', () => {
    setTier('essential')
    // Emit many distinct errors; cap should kick in before all land.
    for (let i = 0; i < 50; i++) {
      reportError('tile', new Error(`distinct-${i}`), 'caught')
    }
    const drained = flush()
    const errs = drained.filter((e) => e.event_type === 'error')
    expect(errs.length).toBeLessThanOrEqual(TIER_A_CAP_TOTAL)
  })

  it('only emits one Tier B detail per signature', () => {
    setTier('research')
    const mk = () => {
      const err = new Error('boom')
      err.stack = 'Error: boom\n    at fn (http://localhost/src/foo.ts:1:1)'
      return err
    }
    for (let i = 0; i < 5; i++) reportError('tile', mk(), 'caught')
    const drained = flush()
    const details = drained.filter((e) => e.event_type === 'error_detail')
    expect(details.length).toBe(TIER_B_CAP_PER_SIG)
  })

  it('stops remembering new signatures past MAX_TRACKED_SIGNATURES', () => {
    // An error whose message varies per frame must not grow the
    // counter for the life of the page.
    for (let i = 0; i < MAX_TRACKED_SIGNATURES + 10; i++) {
      reportError('tile', `varying-${i}`, 'caught')
    }
    reportError('tile', 'varying-0', 'caught')
    expect(__getSigCount('tile', 'caught', 'varying-0')).toBe(2)
    expect(__getSigCount('tile', 'caught', `varying-${MAX_TRACKED_SIGNATURES - 1}`)).toBe(1)
    expect(__getSigCount('tile', 'caught', `varying-${MAX_TRACKED_SIGNATURES}`)).toBe(0)
  })

  it('does not spend the cap on reports the tier drops', () => {
    setTier('off')
    for (let i = 0; i < TIER_A_CAP_TOTAL; i++) reportError('tile', `while-off-${i}`, 'caught')
    setTier('essential')
    reportError('tile', 'after turning on', 'caught')
    const errs = flush().filter((e) => e.event_type === 'error') as TelemetryErrorEvent[]
    expect(errs.map((e) => e.message_class)).toEqual(['after turning on'])
  })

  it('passes an identifier-shaped code and replaces anything else', () => {
    setTier('essential')
    const withCode = (code: unknown) => Object.assign(new Error(`code ${String(code)}`), { code })
    reportError('download', withCode('ERR_NETWORK'), 'caught')
    reportError('download', withCode(18), 'caught')
    reportError('download', withCode('see /home/alice for details'), 'caught')
    reportError('download', withCode('x'.repeat(33)), 'caught')
    const codes = (flush().filter((e) => e.event_type === 'error') as TelemetryErrorEvent[])
      .map((e) => e.code)
    expect(codes).toEqual(['ERR_NETWORK', '18', 'unknown', 'unknown'])
  })

  it('reentrant guard — no recursion if reporter calls itself', () => {
    // Simulate a reporter-internal error by monkey-patching
    // sanitizeMessage to throw. Reporter must silently drop.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    reportError('uncaught', new Error('outer'), 'caught')
    // Follow-up call still works (guard flag was cleared)
    reportError('uncaught', new Error('subsequent'), 'caught')
    const drained = flush()
    expect(drained.filter((e) => e.event_type === 'error').length).toBeGreaterThanOrEqual(1)
    spy.mockRestore()
  })
})

// ─────────────────────────────────────────────────────────────────────
// install / uninstall — global handlers
// ─────────────────────────────────────────────────────────────────────

/** A frame from the built bundle, served by this page's own origin —
 * what production stacks look like. */
const OWN_FRAME = `    at fn (${location.origin}/assets/main-B1x2y3z4.js:1:1)`

/** Fire an uncaught error at `window` the way the browser would. */
function dispatchWindowError(
  message: string,
  { frames = [OWN_FRAME], filename }: { frames?: string[]; filename?: string } = {},
): void {
  const err = new Error(message)
  err.stack = [`Error: ${message}`, ...frames].join('\n')
  // happy-dom dispatches ErrorEvent
  window.dispatchEvent(new window.ErrorEvent('error', { error: err, message, filename }))
}

/** Fire an unhandled rejection. happy-dom does not expose
 * PromiseRejectionEvent as a constructor, so a plain Event carries
 * `reason` — the handler reads it regardless of the prototype. */
function dispatchRejection(reason: unknown): void {
  const event = new Event('unhandledrejection') as Event & { reason: unknown }
  event.reason = reason
  window.dispatchEvent(event)
}

describe('install / uninstall', () => {
  beforeEach(() => resetAll())
  afterEach(() => uninstall())

  it('leaves console.error and console.warn untouched', () => {
    const before = { error: console.error, warn: console.warn }
    install()
    expect(console.error).toBe(before.error)
    expect(console.warn).toBe(before.warn)
  })

  it('reports nothing for console output', () => {
    // The app's own log lines interpolate values the sanitizer cannot
    // recognise (a monitor's display name, for one), so a console line
    // must never reach the stream. The window error after it proves the
    // pipeline was live while the console lines went by.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    install()
    console.error('[multiOutput] output-2 crashed on DELL U2720Q')
    console.warn('[multiOutput] not restoring output-1: no monitor matches LG HDR 4K')
    dispatchWindowError('boom')
    const errs = flush().filter((e) => e.event_type === 'error') as TelemetryErrorEvent[]
    expect(errs.map((e) => e.source)).toEqual(['window_error'])
    errSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('declines on the privacy page, and does not latch there', () => {
    const originalPath = window.location.pathname
    try {
      window.history.pushState(null, '', '/privacy')
      install()
      window.history.pushState(null, '', '/')
      dispatchWindowError('missed')
      expect(flush()).toEqual([])
      // A later call from a page that may emit still installs.
      install()
      dispatchWindowError('caught')
      const errs = flush().filter((e) => e.event_type === 'error') as TelemetryErrorEvent[]
      expect(errs.map((e) => e.message_class)).toEqual(['caught'])
    } finally {
      window.history.pushState(null, '', originalPath)
    }
  })

  it('captures window.error via the global handler', () => {
    install()
    dispatchWindowError('uncaught')
    const drained = flush()
    const errs = drained.filter((e) => e.event_type === 'error') as TelemetryErrorEvent[]
    expect(errs.some((e) => e.source === 'window_error')).toBe(true)
  })

  it('captures unhandledrejection', () => {
    install()
    dispatchRejection(new Error('rejection'))
    const drained = flush()
    const errs = drained.filter((e) => e.event_type === 'error') as TelemetryErrorEvent[]
    expect(errs.some((e) => e.source === 'unhandledrejection')).toBe(true)
  })

  // Each foreign case is followed by one of ours, so an empty result
  // means the foreign one was dropped, not that nothing was listening.
  const messagesAfter = (): string[] =>
    (flush().filter((e) => e.event_type === 'error') as TelemetryErrorEvent[])
      .map((e) => e.message_class)

  it('drops a window error from a browser extension script', () => {
    install()
    dispatchWindowError('autofill failed', {
      frames: [],
      filename: 'chrome-extension://abcdef/content.js',
    })
    dispatchWindowError('ours')
    expect(messagesAfter()).toEqual(['ours'])
  })

  it('drops an error thrown in an extension frame, even when our code called it', () => {
    install()
    dispatchWindowError('patched fetch threw', {
      frames: ['    at wrapped (moz-extension://abc/inject.js:1:1)', OWN_FRAME],
    })
    dispatchWindowError('ours')
    expect(messagesAfter()).toEqual(['ours'])
  })

  it('drops a rejection whose stack has no frame of ours', () => {
    install()
    const foreign = new Error('third party')
    foreign.stack = 'Error: third party\n    at x (https://evil.example/s.js:1:1)'
    dispatchRejection(foreign)
    dispatchRejection(new Error('ours'))
    expect(messagesAfter()).toEqual(['ours'])
  })

  it('keeps an uncaught value with no stack to attribute', () => {
    install()
    dispatchRejection('plain string reason')
    expect(messagesAfter()).toEqual(['plain string reason'])
  })

  it('drops the benign ResizeObserver loop error', () => {
    install()
    window.dispatchEvent(new window.ErrorEvent('error', {
      message: 'ResizeObserver loop completed with undelivered notifications.',
    }))
    dispatchWindowError('ours')
    expect(messagesAfter()).toEqual(['ours'])
  })

  it('survives a rejection reason whose stack cannot be read', () => {
    install()
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    dispatchRejection(proxy)
    dispatchWindowError('ours')
    expect(messagesAfter()).toContain('ours')
  })

  it('install is idempotent', () => {
    install()
    install() // second call must be a no-op
    dispatchWindowError('once')
    // If install attached twice, one error would report twice: the
    // per-signature cap is 3, so the second copy would not be dropped.
    const errs = flush().filter((e) => e.event_type === 'error')
    expect(errs.length).toBe(1)
  })

  it('uninstall detaches the global handlers', () => {
    install()
    uninstall()
    dispatchWindowError('after uninstall')
    expect(flush()).toEqual([])
  })

  it('isForeignError never throws, whatever it is handed', () => {
    expect(isForeignError(42 as unknown as string)).toBe(false)
    expect(isForeignError(undefined, 42 as unknown as string)).toBe(false)
  })
})

describe('isForeignError — whose code threw', () => {
  const stack = (...frames: string[]) => ['Error: x', ...frames].join('\n')
  const at = (url: string) => `    at f (${url}:1:1)`

  it('reads our own origin as ours, whatever the path', () => {
    // The dev server serves `src/` from its root, so a dev URL has no
    // `/src/` in it; a self-hoster may move the bundle off `/assets/`.
    expect(isForeignError(stack(at(`${location.origin}/ui/browseUI.ts`)))).toBe(false)
    expect(isForeignError(stack(at(`${location.origin}/static/main.js`)))).toBe(false)
  })

  it('reads another origin as foreign, even under /assets/', () => {
    expect(isForeignError(stack(at('https://cdn.example.com/assets/widget.js')))).toBe(true)
  })

  it("reads Cloudflare's injected scripts as foreign though same-origin", () => {
    expect(isForeignError(stack(at(`${location.origin}/cdn-cgi/scripts/beacon.js`)))).toBe(true)
  })

  it('steps over built-in frames to find the extension beneath', () => {
    expect(isForeignError(stack(
      '    at JSON.parse (<anonymous>)',
      at('chrome-extension://abc/content.js'),
      OWN_FRAME,
    ))).toBe(true)
  })

  it('does not count a built-in frame as ours', () => {
    expect(isForeignError(stack(
      at('https://static.cloudflareinsights.com/beacon.min.js'),
      '    at Array.forEach (<anonymous>)',
    ))).toBe(true)
    // WebKit's shape for the same thing.
    expect(isForeignError(
      'forEach@[native code]\nrun@https://other.example/x.js:1:1',
    )).toBe(true)
  })

  it('keeps a stack of built-ins alone, which names nobody', () => {
    expect(isForeignError(stack('    at JSON.parse (<anonymous>)'))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Boot wiring — who calls install()
// ─────────────────────────────────────────────────────────────────────

describe('boot wiring', () => {
  // This pipeline once shipped with its own tests and no caller, so no
  // `uncaught` or `native_panic` report was ever sent while three docs
  // described them. `main.ts` boots on import and exports nothing, so
  // the call is pinned in its source — the technique
  // `mapRendererProbeSource.test.ts` uses for code a unit test cannot
  // reach. Comments are stripped so prose quoting the call cannot pass.
  const source = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf-8')
    .replace(/\/\/[^\n]*/g, '')
  const TRANSPORT = 'setTransport(createFetchTransport())'
  const INSTALL = 'installErrorCapture()'
  const DATASETS = 'await this.loadDatasets()'

  it('finds every anchor these tests order against', () => {
    // An anchor renamed away would make `indexOf` return -1 and the
    // ordering below pass for any placement.
    for (const anchor of [TRANSPORT, INSTALL, DATASETS]) expect(source).toContain(anchor)
    expect(source.split(INSTALL)).toHaveLength(2)
  })

  it('installs behind the build flag', () => {
    expect(source).toMatch(/if\s*\(\s*TELEMETRY_BUILD_ENABLED\s*\)\s*installErrorCapture\(\)/)
  })

  it('installs right behind the transport, ahead of the catalog load', () => {
    // Before the transport, a queued report is drained unsent if boot
    // stops short of it, and on desktop it stops the previous session's
    // persisted queue being replayed. After `initialize()` returns, the
    // catalog fetch, the `?dataset=` load and the deep links — the
    // likeliest uncaught errors of a session — have already happened.
    const at = source.indexOf(INSTALL)
    expect(source.indexOf(TRANSPORT)).toBeLessThan(at)
    expect(at).toBeLessThan(source.indexOf(DATASETS))
  })
})

// ---------------------------------------------------------------------------
// Tauri native panic listener (Commit 10)
// ---------------------------------------------------------------------------

// Stub @tauri-apps/api/event so install() can attach a listener
// without needing the real Tauri runtime. Captured `listenCallback`
// lets the test invoke the listener as if Rust had emitted a
// `native_panic` event.
let listenCallback: ((event: { payload: unknown }) => void) | null = null
let unlistenSpy = vi.fn()
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_eventName: string, cb: (event: { payload: unknown }) => void) => {
    listenCallback = cb
    return unlistenSpy
  }),
}))

describe('tauri native_panic listener', () => {
  beforeEach(() => {
    resetAll()
    listenCallback = null
    unlistenSpy = vi.fn()
    // Pretend we're in Tauri so attachTauriPanicListener proceeds.
    ;(window as unknown as { __TAURI__?: unknown }).__TAURI__ = { ipc: {} }
  })

  afterEach(() => {
    uninstall()
    delete (window as unknown as { __TAURI__?: unknown }).__TAURI__
  })

  it('emits an error event with category=native_panic + source=tauri_panic when a panic event arrives', async () => {
    install()
    // Yield to the lazy import + listen() attach.
    await new Promise((r) => setTimeout(r, 0))
    expect(listenCallback).not.toBeNull()

    listenCallback!({
      payload: {
        message: 'forced panic for testing',
        location: 'src-tauri/src/lib.rs:42',
      },
    })

    const drained = flush()
    const errs = drained.filter(
      (e): e is TelemetryErrorEvent => e.event_type === 'error',
    )
    expect(errs).toHaveLength(1)
    expect(errs[0].category).toBe('native_panic')
    expect(errs[0].source).toBe('tauri_panic')
    // The module stays; its line number does not reach Tier A.
    expect(errs[0].message_class).toContain('lib.rs')
    expect(errs[0].message_class).not.toContain(':42')
  })

  it('handles a panic payload with no location field', async () => {
    install()
    await new Promise((r) => setTimeout(r, 0))
    listenCallback!({ payload: { message: 'panic without location', location: null } })

    const errs = flush().filter((e) => e.event_type === 'error')
    expect(errs).toHaveLength(1)
  })

  it('falls back to a placeholder message when the payload is malformed', async () => {
    install()
    await new Promise((r) => setTimeout(r, 0))
    listenCallback!({ payload: null })

    const errs = flush().filter((e) => e.event_type === 'error')
    expect(errs).toHaveLength(1)
    if (errs[0].event_type !== 'error') throw new Error('unreachable')
    expect(errs[0].message_class).toContain('unknown native panic')
  })

  it('does not attach a listener when __TAURI__ is absent', async () => {
    delete (window as unknown as { __TAURI__?: unknown }).__TAURI__
    install()
    await new Promise((r) => setTimeout(r, 0))
    expect(listenCallback).toBeNull()
  })

  it('uninstall fires the unlisten detacher', async () => {
    install()
    await new Promise((r) => setTimeout(r, 0))
    // Yield once more so the .then() that stashes the unlistener runs.
    await new Promise((r) => setTimeout(r, 0))
    uninstall()
    expect(unlistenSpy).toHaveBeenCalledTimes(1)
  })
})
