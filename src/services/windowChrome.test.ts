// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for window chrome (`docs/MULTI_MONITOR_PLAN.md` §3.6).
 *
 * The failures here are all *visible in a captured signal* — a title
 * bar left on, a window strobing under a held key, a cursor parked in
 * a corner of a projected sphere — so they are worth pinning even
 * though each individual rule is two lines.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

import {
  CONTROL_FULLSCREEN_KEY,
  CURSOR_IDLE_CLASS,
  CURSOR_IDLE_MS,
  createDomChromeHost,
  createFullscreenController,
  createIdleCursor,
  createQuitHotkey,
  isFullscreenHotkey,
  isQuitHotkey,
  readFullscreenPreference,
  writeFullscreenPreference,
  type ChromeStorage,
  type WindowChromeHost,
} from './windowChrome'

function key(over: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: 'F11',
    repeat: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    preventDefault: () => {},
    ...over,
  } as KeyboardEvent
}

/** A target that hands back the handlers it was given. */
function fakeTarget() {
  const handlers = new Map<string, ((ev: unknown) => void)[]>()
  return {
    target: {
      addEventListener: (type: string, fn: unknown) => {
        handlers.set(type, [...(handlers.get(type) ?? []), fn as (ev: unknown) => void])
      },
      removeEventListener: (type: string, fn: unknown) => {
        handlers.set(type, (handlers.get(type) ?? []).filter(h => h !== fn))
      },
    },
    fire: (type: string, ev: unknown = {}) => {
      for (const h of [...(handlers.get(type) ?? [])]) h(ev)
    },
    count: (type: string) => (handlers.get(type) ?? []).length,
  }
}

function fakeHost(over: Partial<WindowChromeHost> = {}) {
  const calls: string[] = []
  const host: WindowChromeHost = {
    setFullscreen: async next => {
      calls.push(`fullscreen:${next}`)
    },
    setDecorations: async shown => {
      calls.push(`decorations:${shown}`)
    },
    isFullscreen: () => null,
    ...over,
  }
  return { host, calls }
}

function memoryStorage(initial?: string): ChromeStorage {
  let value = initial ?? null
  return {
    getItem: () => value,
    setItem: (_k, v) => {
      value = v
    },
  }
}

describe('isFullscreenHotkey', () => {
  it('accepts a bare F11', () => {
    expect(isFullscreenHotkey(key())).toBe(true)
  })

  it('ignores a key repeat', () => {
    // Holding F11 delivers a keydown per repeat interval. A toggle
    // bound to those flickers the window between states for as long as
    // the key is held — on a capture surface, a strobing signal.
    expect(isFullscreenHotkey(key({ repeat: true }))).toBe(false)
  })

  it.each([
    ['alt', { altKey: true }],
    ['ctrl', { ctrlKey: true }],
    ['meta', { metaKey: true }],
    ['shift', { shiftKey: true }],
  ])('ignores %s+F11', (_label, mods) => {
    // Desktop environments and the webview's own devtools bind these.
    // Claiming them silently takes them away.
    expect(isFullscreenHotkey(key(mods))).toBe(false)
  })

  it('ignores an event something else already handled', () => {
    expect(isFullscreenHotkey(key({ defaultPrevented: true }))).toBe(false)
  })

  it('ignores every other key', () => {
    expect(isFullscreenHotkey(key({ key: 'F10' }))).toBe(false)
    expect(isFullscreenHotkey(key({ key: 'Escape' }))).toBe(false)
  })
})

describe('the fullscreen preference', () => {
  it('round-trips through storage', () => {
    const storage = memoryStorage()
    writeFullscreenPreference(true, storage)
    expect(readFullscreenPreference(storage)).toBe(true)
    writeFullscreenPreference(false, storage)
    expect(readFullscreenPreference(storage)).toBe(false)
  })

  it('defaults to windowed for anything it does not recognise', () => {
    // A decorationless fullscreen window the operator did not ask for,
    // and whose title bar they cannot see to fix it, is a much worse
    // first launch than a forgotten preference.
    expect(readFullscreenPreference(memoryStorage('yes'))).toBe(false)
    expect(readFullscreenPreference(memoryStorage())).toBe(false)
    expect(readFullscreenPreference(null)).toBe(false)
  })

  it('uses the key the plan named', () => {
    const storage = memoryStorage()
    const setItem = vi.spyOn(storage, 'setItem')
    writeFullscreenPreference(true, storage)
    expect(setItem).toHaveBeenCalledWith(CONTROL_FULLSCREEN_KEY, 'true')
  })

  it('survives a storage that throws on write', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storage: ChromeStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded')
      },
    }
    // Costs the operator one relaunch in the wrong state, never the
    // toggle they just used.
    expect(() => writeFullscreenPreference(true, storage)).not.toThrow()
  })
})

describe('createFullscreenController', () => {
  it('drops the decorations with the same call that goes fullscreen', async () => {
    const { host, calls } = fakeHost()
    const controller = createFullscreenController({ host, target: fakeTarget().target })

    await controller.set(true)

    // `setFullscreen(true)` alone leaves the title bar on some window
    // managers and removes it on others; pairing them is what makes the
    // captured picture the same everywhere.
    expect(calls).toEqual(['fullscreen:true', 'decorations:false'])
  })

  it('brings the decorations back on the way out', async () => {
    const { host, calls } = fakeHost()
    const controller = createFullscreenController({ host, target: fakeTarget().target })
    await controller.set(true)
    calls.length = 0

    await controller.set(false)

    expect(calls).toEqual(['fullscreen:false', 'decorations:true'])
  })

  it('changes the fullscreen state before touching the decorations', async () => {
    const { host, calls } = fakeHost({
      setFullscreen: async () => {
        throw new Error('window manager refused')
      },
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const controller = createFullscreenController({ host, target: fakeTarget().target })

    await controller.set(true)

    // Decorations follow, never lead. A window that dropped its title
    // bar and then failed to go fullscreen is one the operator cannot
    // move, resize or close.
    expect(calls).not.toContain('decorations:false')
  })

  it('reports what the window is, not what was asked for, when the platform refuses', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { host } = fakeHost({
      setFullscreen: async () => {
        throw new Error('refused')
      },
      isFullscreen: () => false,
    })
    const controller = createFullscreenController({ host, target: fakeTarget().target })

    await controller.set(true)

    // A menu claiming a state the window is not in is worse than one
    // that visibly did nothing.
    expect(controller.isFullscreen()).toBe(false)
  })

  it('toggles on F11 and claims the keystroke', async () => {
    const { host, calls } = fakeHost()
    const t = fakeTarget()
    const controller = createFullscreenController({ host, target: t.target })
    const changed = vi.fn()
    controller.onChange(changed)
    const preventDefault = vi.fn()

    t.fire('keydown', key({ preventDefault }))

    // Anchored on the change landing rather than on `calls` — the host
    // is called partway through `apply`, so waiting on it would assert
    // the state before it was written.
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    expect(preventDefault).toHaveBeenCalled()
    expect(controller.isFullscreen()).toBe(true)
    expect(calls).toEqual(['fullscreen:true', 'decorations:false'])
  })

  it('leaves a modified F11 for whoever else wanted it', () => {
    const { host, calls } = fakeHost()
    const t = fakeTarget()
    createFullscreenController({ host, target: t.target })
    const preventDefault = vi.fn()

    t.fire('keydown', key({ ctrlKey: true, preventDefault }))

    // Claimed only once we know we are acting on it.
    expect(preventDefault).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it('follows the platform out of fullscreen when nobody asked it to', async () => {
    // The browser exits on Escape without consulting whoever requested
    // it. A controller that trusted its own last write would leave the
    // Tools menu claiming fullscreen over a windowed app.
    let reported = false
    const { host } = fakeHost({ isFullscreen: () => reported })
    const t = fakeTarget()
    const controller = createFullscreenController({ host, target: t.target })
    await controller.set(true)
    reported = true
    t.fire('fullscreenchange')
    expect(controller.isFullscreen()).toBe(true)

    reported = false
    t.fire('fullscreenchange')

    expect(controller.isFullscreen()).toBe(false)
  })

  it('trusts its own state where the platform will not answer', async () => {
    // Tauri's `isFullscreen` is an async command a synchronous reader
    // cannot await, so the host returns null and nothing else on that
    // path changes the state behind the controller's back.
    const { host } = fakeHost({ isFullscreen: () => null })
    const t = fakeTarget()
    const controller = createFullscreenController({ host, target: t.target })
    await controller.set(true)

    t.fire('fullscreenchange')

    expect(controller.isFullscreen()).toBe(true)
  })

  it('persists only when asked to', async () => {
    const storage = memoryStorage()
    const setItem = vi.spyOn(storage, 'setItem')
    const controller = createFullscreenController({
      host: fakeHost().host,
      target: fakeTarget().target,
      storage,
    })

    await controller.set(true)

    // An output has no fullscreen *preference*: it is fullscreen by
    // construction, and F11 there is a temporary escape hatch for
    // grabbing the window during calibration, not a setting to restore.
    expect(setItem).not.toHaveBeenCalled()
  })

  it('persists the control window\'s choice', async () => {
    const storage = memoryStorage()
    const controller = createFullscreenController({
      host: fakeHost().host,
      target: fakeTarget().target,
      persist: true,
      storage,
    })

    await controller.set(true)

    expect(readFullscreenPreference(storage)).toBe(true)
  })

  it('starts where the caller says it starts', () => {
    const controller = createFullscreenController({
      host: fakeHost().host,
      target: fakeTarget().target,
      initial: true,
    })
    // An output window is spawned fullscreen, so a controller that
    // assumed windowed would make its first F11 a no-op.
    expect(controller.isFullscreen()).toBe(true)
  })

  it('tells its listeners, and only on a real change', async () => {
    const seen = vi.fn()
    const controller = createFullscreenController({
      host: fakeHost().host,
      target: fakeTarget().target,
    })
    controller.onChange(seen)

    await controller.set(true)
    await controller.set(true)

    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen).toHaveBeenCalledWith(true)
  })

  it('isolates a listener that throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const controller = createFullscreenController({
      host: fakeHost().host,
      target: fakeTarget().target,
    })
    const good = vi.fn()
    controller.onChange(() => {
      throw new Error('menu repaint failed')
    })
    controller.onChange(good)

    // A Tools-menu button that throws updating its own label must not
    // stop the cursor hider being told.
    await expect(controller.set(true)).resolves.toBeUndefined()
    expect(good).toHaveBeenCalledWith(true)
  })

  it('detaches both listeners on dispose', () => {
    const t = fakeTarget()
    const controller = createFullscreenController({ host: fakeHost().host, target: t.target })
    expect(t.count('keydown')).toBe(1)
    expect(t.count('fullscreenchange')).toBe(1)

    controller.dispose()

    expect(t.count('keydown')).toBe(0)
    expect(t.count('fullscreenchange')).toBe(0)
  })
})

describe('createDomChromeHost', () => {
  it('treats hiding decorations as already done', async () => {
    const doc = { documentElement: {}, fullscreenElement: null } as unknown as Document
    // There is no title bar in a browser tab, so the request was fully
    // honoured. Rejecting would make the controller report a failure
    // and roll back a fullscreen that actually worked.
    await expect(createDomChromeHost(doc).setDecorations(false)).resolves.toBeUndefined()
  })

  it('reads fullscreen off the document', () => {
    const out = { documentElement: {}, fullscreenElement: null } as unknown as Document
    const inside = { documentElement: {}, fullscreenElement: {} } as unknown as Document
    expect(createDomChromeHost(out).isFullscreen()).toBe(false)
    expect(createDomChromeHost(inside).isFullscreen()).toBe(true)
  })

  it('does not ask to exit a fullscreen it is not in', async () => {
    const exitFullscreen = vi.fn(async () => {})
    const doc = {
      documentElement: {},
      fullscreenElement: null,
      exitFullscreen,
    } as unknown as Document

    await createDomChromeHost(doc).setFullscreen(false)

    // `exitFullscreen` rejects when the document is not fullscreen, and
    // that rejection would be reported as a failed toggle.
    expect(exitFullscreen).not.toHaveBeenCalled()
  })
})

describe('createIdleCursor', () => {
  type TokenFn = (...tokens: string[]) => void
  let root: { classList: { add: Mock<TokenFn>; remove: Mock<TokenFn> } }

  beforeEach(() => {
    root = { classList: { add: vi.fn<TokenFn>(), remove: vi.fn<TokenFn>() } }
  })

  function build(over: { idleMs?: number } = {}) {
    const t = fakeTarget()
    const timer: { fire?: () => void } = {}
    const clearTimer = vi.fn()
    const cursor = createIdleCursor({
      root,
      target: t.target,
      setTimer: fn => {
        timer.fire = fn
        return 7
      },
      clearTimer,
      ...over,
    })
    return { cursor, t, timer, clearTimer }
  }

  it('does nothing at all until it is made active', () => {
    const { t, timer } = build()

    t.fire('pointermove')
    timer.fire?.()

    // A windowed app the operator is still driving must keep its
    // pointer. Hiding it there would be a bug, not a feature.
    expect(root.classList.add).not.toHaveBeenCalled()
  })

  it('starts the clock the moment it goes active, not on first movement', () => {
    const { cursor, timer } = build()

    cursor.setActive(true)
    timer.fire?.()

    // An operator who clicks Fullscreen and takes their hand off the
    // mouse never generates a pointermove, so a hider that waited for
    // one would never fire.
    expect(root.classList.add).toHaveBeenCalledWith(CURSOR_IDLE_CLASS)
  })

  it('reveals a hidden pointer as soon as it moves', () => {
    const { cursor, t, timer } = build()
    cursor.setActive(true)
    timer.fire?.()
    root.classList.remove.mockClear()

    t.fire('pointermove')

    expect(root.classList.remove).toHaveBeenCalledWith(CURSOR_IDLE_CLASS)
  })

  it('restarts the clock rather than stacking timers while still visible', () => {
    const { cursor, t, clearTimer } = build()
    cursor.setActive(true)

    // Moved before the countdown expired, so there is a pending timer
    // to replace. Leaving it running would hide the pointer at the
    // original deadline, mid-movement.
    t.fire('pointermove')

    expect(clearTimer).toHaveBeenCalledWith(7)
  })

  it('does not hide a pointer whose window left fullscreen mid-countdown', () => {
    const { cursor, timer } = build()
    cursor.setActive(true)

    cursor.setActive(false)
    timer.fire?.()

    // Re-checked at fire time, not only at arm time: a pending timer
    // from a window that has since been restored would otherwise hide
    // the cursor of an app the operator is using.
    expect(root.classList.add).not.toHaveBeenCalled()
  })

  it('reveals the pointer when it stops being active', () => {
    const { cursor, timer } = build()
    cursor.setActive(true)
    timer.fire?.()
    root.classList.remove.mockClear()

    cursor.setActive(false)

    // Leaving fullscreen with the cursor still hidden strands an
    // operator with an invisible pointer over a windowed app.
    expect(root.classList.remove).toHaveBeenCalledWith(CURSOR_IDLE_CLASS)
  })

  it('is idempotent on a repeated setActive', () => {
    const { cursor, clearTimer } = build()
    cursor.setActive(true)
    cursor.setActive(true)
    // A second arm would leave the first timer running and unreferenced.
    expect(clearTimer).not.toHaveBeenCalled()
  })

  it('restores the pointer and stops its timer on dispose', () => {
    const { cursor, clearTimer, t } = build()
    cursor.setActive(true)

    cursor.dispose()

    expect(clearTimer).toHaveBeenCalledWith(7)
    expect(root.classList.remove).toHaveBeenCalledWith(CURSOR_IDLE_CLASS)
    expect(t.count('pointermove')).toBe(0)
  })

  it('waits a few seconds, not a fraction of one', () => {
    // Long enough not to fight an operator still working, short enough
    // that a cursor abandoned mid-show is gone before anyone
    // photographs it.
    expect(CURSOR_IDLE_MS).toBeGreaterThanOrEqual(2000)
    expect(CURSOR_IDLE_MS).toBeLessThanOrEqual(6000)
  })
})

/**
 * The quit hotkey (rung 9 step 29).
 *
 * The checklist asserted "Cmd/Ctrl+Q exits cleanly" as if it existed;
 * nothing bound it. What makes it worth testing rather than eyeballing
 * is that every wrong answer here is expensive in one direction or the
 * other: a hotkey that fires when it should not ends a show, and one
 * that does not fire leaves a kiosk window with no way out.
 */
describe('isQuitHotkey', () => {
  const q = (over: Partial<KeyboardEvent> = {}): KeyboardEvent =>
    key({ key: 'q', ctrlKey: true, ...over })

  it('accepts Ctrl+Q', () => {
    expect(isQuitHotkey(q())).toBe(true)
  })

  it('accepts the shifted-looking key a caps-lock keyboard reports', () => {
    // `key` follows the shift state, so a caps-locked keyboard sends
    // 'Q' with shiftKey false. Comparing case-sensitively would leave
    // that operator with no way out of a kiosk window.
    expect(isQuitHotkey(q({ key: 'Q' }))).toBe(true)
  })

  it('ignores Q on its own', () => {
    expect(isQuitHotkey(q({ ctrlKey: false }))).toBe(false)
  })

  it('leaves Cmd+Q to the operating system', () => {
    // macOS already quits on Cmd+Q through the standard application
    // menu. Answering it here would put two handlers on one keystroke.
    expect(isQuitHotkey(q({ ctrlKey: false, metaKey: true }))).toBe(false)
    expect(isQuitHotkey(q({ metaKey: true }))).toBe(false)
  })

  it('ignores a held key, because a second exit is not a no-op', () => {
    // The clause that matters more here than on a toggle: holding F11
    // strobes a window, holding this queues another exit behind the one
    // already tearing the process down.
    expect(isQuitHotkey(q({ repeat: true }))).toBe(false)
  })

  it('ignores other modifiers and an already-handled event', () => {
    expect(isQuitHotkey(q({ altKey: true }))).toBe(false)
    expect(isQuitHotkey(q({ shiftKey: true }))).toBe(false)
    expect(isQuitHotkey(q({ defaultPrevented: true }))).toBe(false)
  })
})

describe('createQuitHotkey', () => {
  const press = (fire: (type: string, ev: unknown) => void, over: Partial<KeyboardEvent> = {}) =>
    fire('keydown', key({ key: 'q', ctrlKey: true, ...over }))

  function host(over: Partial<WindowChromeHost> = {}): WindowChromeHost {
    return {
      setFullscreen: async () => {},
      setDecorations: async () => {},
      isFullscreen: () => false,
      ...over,
    }
  }

  it('ends the application on Ctrl+Q', () => {
    const quit = vi.fn(async () => {})
    const { target, fire } = fakeTarget()
    createQuitHotkey({ host: host({ quit }), target })

    press(fire)

    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('is inert on a host that cannot quit, and does not swallow the key', () => {
    // The web build. Ctrl+Q is Firefox's own quit, so claiming it there
    // would be a worse answer than leaving it alone — which is why the
    // DOM host implements no `quit` and this needs no platform test.
    const preventDefault = vi.fn()
    const { target, fire } = fakeTarget()
    createQuitHotkey({ host: host(), target })

    fire('keydown', key({ key: 'q', ctrlKey: true, preventDefault }))

    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('claims the key only when it is acting on it', () => {
    const quit = vi.fn(async () => {})
    const preventDefault = vi.fn()
    const { target, fire } = fakeTarget()
    createQuitHotkey({ host: host({ quit }), target })

    // A modified press must still reach whatever else wanted it.
    fire('keydown', key({ key: 'q', ctrlKey: true, shiftKey: true, preventDefault }))
    expect(preventDefault).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()

    fire('keydown', key({ key: 'q', ctrlKey: true, preventDefault }))
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it('survives a refused quit rather than throwing into the loop', () => {
    // An output would be refused by the capability split — no
    // `core:default`, so no `invoke` at all. A hotkey that cannot fire
    // must not take down the render loop that heard it.
    const quit = vi.fn(async () => {
      throw new Error('forbidden')
    })
    const { target, fire } = fakeTarget()
    createQuitHotkey({ host: host({ quit }), target })

    expect(() => press(fire)).not.toThrow()
  })

  it('stops listening once disposed', () => {
    const quit = vi.fn(async () => {})
    const { target, fire } = fakeTarget()
    const dispose = createQuitHotkey({ host: host({ quit }), target })

    dispose()
    press(fire)

    expect(quit).not.toHaveBeenCalled()
  })
})
