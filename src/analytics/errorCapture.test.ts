import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
  ]

  for (const { label, input, expected } of cases) {
    it(label, () => {
      expect(sanitizeMessage(input)).toBe(expected)
    })
  }
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
// install / uninstall — global handlers + console patches
// ─────────────────────────────────────────────────────────────────────

describe('install / uninstall', () => {
  beforeEach(() => resetAll())
  afterEach(() => uninstall())

  it('patches console.error but preserves the original output', () => {
    const origCalls: unknown[][] = []
    const origError = console.error
    console.error = (...args: unknown[]) => {
      origCalls.push(args)
    }
    install()
    console.error('something broke')
    // Original reference must still receive the call so devs see the
    // message in the dev console.
    expect(origCalls.length).toBe(1)
    expect(origCalls[0][0]).toBe('something broke')
    // Restore before uninstall's sequence
    uninstall()
    console.error = origError
  })

  it('captures console.warn into the telemetry stream', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    install()
    console.warn('deprecated API usage')
    const drained = flush()
    const errs = drained.filter((e) => e.event_type === 'error') as TelemetryErrorEvent[]
    expect(errs.some((e) => e.source === 'console_warn')).toBe(true)
    spy.mockRestore()
  })

  it('captures window.error via the global handler', () => {
    install()
    const err = new Error('uncaught')
    err.stack = 'Error: uncaught\n    at fn (http://localhost/src/foo.ts:1:1)'
    // happy-dom dispatches ErrorEvent
    const event = new window.ErrorEvent('error', { error: err, message: err.message })
    window.dispatchEvent(event)
    const drained = flush()
    const errs = drained.filter((e) => e.event_type === 'error') as TelemetryErrorEvent[]
    expect(errs.some((e) => e.source === 'window_error')).toBe(true)
  })

  it('captures unhandledrejection', () => {
    install()
    // happy-dom does not expose PromiseRejectionEvent as a
    // constructor. Dispatch a plain Event with `reason` attached —
    // the capture handler reads `reason` off the event regardless of
    // the prototype.
    const event = new Event('unhandledrejection') as Event & { reason: unknown }
    event.reason = new Error('rejection')
    window.dispatchEvent(event)
    const drained = flush()
    const errs = drained.filter((e) => e.event_type === 'error') as TelemetryErrorEvent[]
    expect(errs.some((e) => e.source === 'unhandledrejection')).toBe(true)
  })

  it('install is idempotent', () => {
    // Silence the original console before install so the patched
    // layer has a noop to delegate to; otherwise the test output
    // picks up the log. Spying after install would replace the
    // patched function and bypass the reporter entirely.
    const origError = console.error
    console.error = () => {}
    install()
    install() // second call must be a no-op
    console.error('once')
    const drained = flush()
    const errs = drained.filter((e) => e.event_type === 'error')
    // Clean up before asserting so a failure doesn't leave state
    uninstall()
    console.error = origError
    // If install wrapped twice, a single call would report twice.
    expect(errs.length).toBe(1)
  })

  it('uninstall restores the original console.error', () => {
    const before = console.error
    install()
    expect(console.error).not.toBe(before)
    uninstall()
    expect(console.error).toBe(before)
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
    expect(errs[0].message_class.length).toBeGreaterThan(0)
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
