import { vi } from 'vitest'

// happy-dom does not implement the Canvas 2D API. Stub it globally so any
// test that constructs a canvas (SphereRenderer glow textures, etc.) doesn't
// blow up on `canvas.getContext('2d')`.
if (typeof HTMLCanvasElement !== 'undefined') {
  const mockCtx = {
    drawImage: vi.fn(),
    getImageData: vi.fn().mockReturnValue({ data: new Uint8ClampedArray(4) }),
    putImageData: vi.fn(),
    createRadialGradient: vi.fn().mockReturnValue({ addColorStop: vi.fn() }),
    fillRect: vi.fn(),
    fillStyle: '',
  }
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockCtx)
}

/**
 * No unit test may open a socket.
 *
 * Several suites render a page that fires a capability probe — the
 * publisher pages ask `/api/v1/publish/me` — without awaiting it. A test
 * that does not inject its own `fetchFn` therefore left a real request
 * to `localhost:3000` in flight, which failed with `ECONNREFUSED` some
 * unpredictable time later and logged from `api.ts` as it did.
 *
 * When that log landed after the test file had finished, vitest was
 * already closing the worker's RPC channel and turned it into
 * `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was
 * pending` — a CI failure with **zero failing tests**, attributed to
 * whichever file happened to be last. That is the worst shape a red
 * build can take: it teaches people to press re-run instead of reading,
 * which is the same reasoning behind `check:tick-drain`.
 *
 * Rejecting here fixes the timing (no socket, so the failure is a
 * microtask rather than real I/O) and, more importantly, makes the
 * underlying mistake loud: the message names the URL and says what to
 * do. A test that genuinely wants to exercise fetch still overrides
 * this with `vi.stubGlobal('fetch', …)`, and one that injects a
 * `fetchFn` never reaches it at all.
 */
// Deliberately a plain function, not `vi.fn()`. A suite that calls
// `vi.resetAllMocks()` in a hook would blank a mock's implementation and
// leave `fetch` returning `undefined`, which fails far away from the
// cause — the first version of this did exactly that to 33 tests.
globalThis.fetch = ((input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : String((input as Request).url ?? input)
  return Promise.reject(new Error(
    `Unit tests must not use the network (attempted fetch: ${url}).\n`
    + '  Inject a fetch — most surfaces take a `fetchFn` — or override the '
    + 'global with vi.stubGlobal(\'fetch\', …) for this test.',
  ))
}) as unknown as typeof fetch
