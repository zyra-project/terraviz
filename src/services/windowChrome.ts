// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Window chrome — fullscreen, decorations, and the idle cursor
 * (`docs/MULTI_MONITOR_PLAN.md` §3.6).
 *
 * All of this exists for one reason: **a title bar leaks into the
 * signal.** The common installation pattern is an HDMI capture card
 * taking a monitor as input, and everything the OS draws around the
 * window — border, title bar, a cursor parked in a corner — arrives on
 * the sphere with the picture. Output windows already spawn fullscreen
 * and decorationless; this is the same treatment for the *control*
 * window, which operators also capture, plus the escape hatch that
 * makes an undecorated window recoverable.
 *
 * ## One module, both windows
 *
 * `src/output/main.ts` and `src/main.ts` both import this. That is
 * deliberate: F11 means the same thing in both places and the Tauri
 * calls are identical, so a second copy is a second place for the
 * decorations half to be forgotten. It costs the output bundle nothing
 * it was not already paying — the Tauri import is lazy and behind the
 * same desktop gate `outputLink` uses.
 *
 * ## Why the decorations and the fullscreen move together
 *
 * `setFullscreen(true)` alone leaves the title bar on some window
 * managers and removes it on others. Pairing it with
 * `setDecorations(false)` is what makes the result the same picture
 * everywhere, which for a capture surface is the whole point. They are
 * one operation here so no call site can do half of it.
 *
 * ## What the web build gets
 *
 * The standard Fullscreen API, which covers browser-source capture
 * (OBS, vMix). It cannot remove decorations because there are none to
 * remove, so that half is a no-op rather than an error. Two things do
 * *not* transfer and are handled rather than ignored: the browser exits
 * fullscreen on Escape without telling anyone who asked for it, so the
 * controller listens for `fullscreenchange` rather than trusting its
 * own last write; and `requestFullscreen` requires a user gesture, so a
 * persisted preference is **not** restored at boot on web — see
 * `restoreOnLaunch`.
 */

import { logger } from '../utils/logger'

/** Where the control window's fullscreen preference lives (§3.6). */
export const CONTROL_FULLSCREEN_KEY = 'sos-control-fullscreen'

/**
 * How long the pointer must hold still before it disappears.
 *
 * Long enough not to fight an operator who is still working, short
 * enough that a cursor abandoned mid-show is gone before anyone
 * photographs it.
 */
export const CURSOR_IDLE_MS = 3000

/** The slice of `localStorage` this module uses, injectable for tests. */
export interface ChromeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * The platform surface: make this window fullscreen, and show or hide
 * its decorations.
 *
 * A seam rather than a direct Tauri call for the reason
 * `MultiOutputHost` is one — it is what lets the controller below be
 * driven from a test with no packaged build, and it is the single
 * place the web fallback substitutes itself.
 */
export interface WindowChromeHost {
  setFullscreen(next: boolean): Promise<void>
  /** No-op where the platform has no decorations to hide. */
  setDecorations(shown: boolean): Promise<void>
  /** What the platform currently reports, or `null` when it will not
   *  say — the controller then trusts its own last write. */
  isFullscreen(): boolean | null
  /**
   * Ask the platform once, asynchronously, at construction.
   *
   * Exists because the window can already be fullscreen before any of
   * this code runs: the `--kiosk` flag applies it in Rust `setup()`,
   * and a window manager can do it unasked. Without this the Tools
   * button would offer "Enter fullscreen" over a kiosk window and the
   * first press would be a no-op — the same class of bug as reading
   * `document.fullscreenElement` on desktop.
   *
   * Optional: the DOM host answers synchronously and needs none.
   */
  queryFullscreen?(): Promise<boolean | null>
  /**
   * End the application.
   *
   * **Optional, and its absence is the web build's safety.** A browser
   * tab cannot close itself unasked, and Ctrl+Q is Firefox's own quit —
   * binding it there would either do nothing or take the browser down.
   * The DOM host therefore does not implement this, and
   * `createQuitHotkey` is inert without it by construction rather than
   * by a second platform test at the call site.
   */
  quit?(): Promise<void>
}

/** The same desktop gate `bootMultiOutput` and the output entry apply. */
export function isDesktop(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as unknown as { __TAURI__?: unknown }).__TAURI__)
  )
}

/**
 * Read the persisted preference, defaulting to windowed.
 *
 * Windowed rather than "whatever was stored last" on a parse failure:
 * a decorationless fullscreen window an operator did not ask for and
 * cannot see the title bar of is a much worse first launch than a
 * forgotten preference.
 */
export function readFullscreenPreference(storage: ChromeStorage | null = defaultStorage()): boolean {
  if (!storage) return false
  try {
    return storage.getItem(CONTROL_FULLSCREEN_KEY) === 'true'
  } catch (err) {
    logger.warn('[windowChrome] could not read the fullscreen preference:', err)
    return false
  }
}

export function writeFullscreenPreference(
  value: boolean,
  storage: ChromeStorage | null = defaultStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(CONTROL_FULLSCREEN_KEY, String(value))
  } catch (err) {
    // Quota, private mode, a partition change. Costs the operator one
    // relaunch in the wrong state, never the toggle they just used.
    logger.warn('[windowChrome] could not persist the fullscreen preference:', err)
  }
}

function defaultStorage(): ChromeStorage | null {
  try {
    // Access, not just presence: private-mode Safari has the object and
    // throws on use, and a throw here would take out the boot that
    // reads this.
    if (typeof localStorage === 'undefined') return null
    localStorage.getItem(CONTROL_FULLSCREEN_KEY)
    return localStorage
  } catch {
    return null
  }
}

/**
 * Whether this keystroke is the fullscreen toggle.
 *
 * Pure, because every clause is a bug someone has shipped:
 *
 * - **`repeat`** — holding F11 down delivers a keydown per repeat
 *   interval, and a toggle bound to those flickers the window between
 *   states for as long as the key is held. On a capture surface that is
 *   a strobing signal.
 * - **Modifiers** — Shift+F11 and Ctrl+F11 are bound elsewhere by
 *   desktop environments and by the webview's own devtools; claiming
 *   them silently takes them away.
 * - **`defaultPrevented`** — something upstream already answered this
 *   keystroke, and a second handler acting on it is how one press
 *   produces two actions.
 *
 * **macOS note:** F11 is Mission Control's "show desktop" by default
 * and, on a keyboard with media keys, needs Fn. That is a system
 * binding rather than something to work around here — the Tools menu
 * entry is the reliable path on a Mac, which is why the feature does
 * not ship as a shortcut alone.
 */
export function isFullscreenHotkey(ev: KeyboardEvent): boolean {
  return (
    ev.key === 'F11' &&
    !ev.repeat &&
    !ev.altKey &&
    !ev.ctrlKey &&
    !ev.metaKey &&
    !ev.shiftKey &&
    !ev.defaultPrevented
  )
}

/**
 * Is this the quit hotkey?
 *
 * Ctrl+Q, and the clauses are the ones `isFullscreenHotkey` learned the
 * hard way plus one this key needs more than F11 does. `repeat` matters
 * here in a way it does not for a toggle: holding the keys down on a
 * toggle strobes a window, while holding them on *this* queues a second
 * exit behind the one already tearing the process down.
 *
 * **Ctrl only, never Cmd.** macOS already quits on Cmd+Q through the
 * standard application menu, so binding it here would put two handlers
 * on one keystroke and race the OS for it. Ctrl+Q is unbound on macOS
 * and is the muscle memory operators bring from the other two
 * platforms, so it is wired everywhere and Cmd+Q is left to the system.
 * That is also why `metaKey` is an explicit no rather than an omission:
 * Ctrl+Cmd+Q must reach the OS untouched.
 */
export function isQuitHotkey(ev: KeyboardEvent): boolean {
  return (
    // Lower-cased because `key` follows the shift state, and compared
    // rather than read off `code` so a non-QWERTY layout gets the key
    // its legend shows.
    ev.key.toLowerCase() === 'q' &&
    ev.ctrlKey &&
    !ev.repeat &&
    !ev.altKey &&
    !ev.metaKey &&
    !ev.shiftKey &&
    !ev.defaultPrevented
  )
}

export interface QuitHotkeyOptions {
  host: WindowChromeHost
  /** Where the handler is attached. Injectable so a test needs no
   *  page, the same seam the fullscreen controller uses. */
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null
}

/**
 * Bind Ctrl+Q to ending the application (rung 9 step 29).
 *
 * The checklist asserted "Cmd/Ctrl+Q exits cleanly" as if it already
 * existed; nothing bound it. It matters for the kiosk launch
 * specifically: `--kiosk` brings the window up fullscreen and
 * decorationless, so there is no close button, no title bar to
 * right-click, and no menu bar. Alt+F4 answers that on Windows and
 * nothing answers it portably.
 *
 * Wired in the control window only. An output keeps F11 as its escape
 * hatch — recover the title bar, then close the one window — because
 * ending the whole installation from the projector is not what an
 * operator at the sphere means by "get me out of this". The capability
 * split enforces the same thing a layer down: an output has no
 * `core:default`, so its `quit` would be refused even if it were wired.
 *
 * Returns a disposer.
 */
export function createQuitHotkey(options: QuitHotkeyOptions): () => void {
  const target = options.target ?? (typeof window !== 'undefined' ? window : null)
  const quit = options.host.quit

  const onKeyDown = (ev: Event): void => {
    if (!isQuitHotkey(ev as KeyboardEvent)) return
    // Nothing to do and nothing to claim: on the web this is Firefox's
    // own quit, and swallowing it would be a worse answer than leaving
    // it alone.
    if (!quit) return
    // Claimed only once we know we are acting on it, so a modified or
    // repeated Ctrl+Q still reaches whatever else wanted it.
    ;(ev as KeyboardEvent).preventDefault()
    void quit().catch(err => logger.warn('[windowChrome] could not exit:', err))
  }

  target?.addEventListener('keydown', onKeyDown)
  return () => target?.removeEventListener('keydown', onKeyDown)
}

export interface FullscreenController {
  /** What this window is in, as far as anyone can tell. */
  isFullscreen(): boolean
  /** Go there. Resolves once the platform has been asked. */
  set(next: boolean): Promise<void>
  toggle(): Promise<boolean>
  /** Called whenever the state changes, including when the platform
   *  changed it without being asked (Escape on the web). */
  onChange(listener: (fullscreen: boolean) => void): () => void
  dispose(): void
}

export interface FullscreenControllerOptions {
  host: WindowChromeHost
  /** Persist every change under `CONTROL_FULLSCREEN_KEY`. The control
   *  window does; an output does not, since it has no preference of its
   *  own — it is fullscreen by construction and F11 is a temporary
   *  escape hatch, not a setting. */
  persist?: boolean
  storage?: ChromeStorage | null
  /** Where the F11 handler and the web's `fullscreenchange` are
   *  attached. Injectable so a test needs no page. */
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null
  /** Whether this window starts fullscreen. An output does. */
  initial?: boolean
}

/**
 * Own one window's fullscreen state.
 *
 * Holds its own view of the state rather than asking the platform every
 * time, because two of the three platforms cannot be asked: Tauri's
 * `isFullscreen` is an async command, and the DOM's answer is only
 * meaningful once a request has resolved. The held value is corrected
 * by whatever the host *can* report, so an Escape-exit on the web does
 * not leave the Tools menu claiming fullscreen.
 */
export function createFullscreenController(
  options: FullscreenControllerOptions,
): FullscreenController {
  const { host, persist = false, storage = defaultStorage() } = options
  const target = options.target ?? (typeof window !== 'undefined' ? window : null)
  const listeners = new Set<(fullscreen: boolean) => void>()
  let current = options.initial ?? false

  const announce = (next: boolean): void => {
    if (next === current) return
    current = next
    for (const listener of listeners) {
      // Isolated: a Tools-menu button that throws while updating its
      // own label must not stop the cursor hider from being told, and
      // must not unwind into a keydown handler.
      try {
        listener(next)
      } catch (err) {
        logger.error('[windowChrome] fullscreen listener threw:', err)
      }
    }
  }

  const apply = async (next: boolean): Promise<void> => {
    try {
      await host.setFullscreen(next)
      // Decorations follow, never lead: a window that dropped its title
      // bar and then failed to go fullscreen is one an operator cannot
      // move, resize or close.
      await host.setDecorations(!next)
    } catch (err) {
      // The platform refused. Report what it actually is rather than
      // what was asked for, so the menu does not claim a state the
      // window is not in.
      logger.warn('[windowChrome] could not change fullscreen:', err)
      announce(host.isFullscreen() ?? current)
      return
    }
    if (persist) writeFullscreenPreference(next, storage)
    announce(next)
  }

  // The browser exits fullscreen on Escape without consulting whoever
  // asked for it, so the held value has to be corrected from the event
  // rather than trusted. Harmless on desktop, where it never fires.
  const onPlatformChange = (): void => {
    const reported = host.isFullscreen()
    if (reported !== null) announce(reported)
  }
  target?.addEventListener('fullscreenchange', onPlatformChange)

  // Fire-and-forget: nothing downstream may wait on it, and a platform
  // that refuses simply leaves the held value alone.
  void host
    .queryFullscreen?.()
    .then(reported => {
      if (reported !== null && reported !== undefined) announce(reported)
    })
    .catch(err => logger.warn('[windowChrome] could not read the window state:', err))

  const onKeyDown = (ev: Event): void => {
    if (!isFullscreenHotkey(ev as KeyboardEvent)) return
    // Claimed only once we know we are acting on it, so a modified or
    // repeated F11 still reaches whatever else wanted it.
    ;(ev as KeyboardEvent).preventDefault()
    void apply(!current)
  }
  target?.addEventListener('keydown', onKeyDown)

  return {
    isFullscreen: () => current,
    set: apply,
    async toggle() {
      await apply(!current)
      return current
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      listeners.clear()
      target?.removeEventListener('keydown', onKeyDown)
      target?.removeEventListener('fullscreenchange', onPlatformChange)
    },
  }
}

/**
 * The real host on desktop, and the only Tauri importer here.
 *
 * **Constructed synchronously, imported lazily.** Both halves matter.
 * The Tauri module has to be a dynamic import for the reason every
 * other one in this codebase is — the web build must not carry it. But
 * the *host* cannot be async to build, because the Tools menu reads the
 * fullscreen state while it lays out its markup: an awaited host would
 * either delay the whole menu behind a chunk load or let it render a
 * stale state and correct it a frame later. Deferring the import to the
 * first call gets both, and costs nothing, since every method here is
 * already async.
 *
 * Both grants it needs (`core:window:allow-set-fullscreen`,
 * `…allow-set-decorations`) are already in `default.json` **and** in
 * `output.json` — §6 provisioned them ahead of this rung, so nothing
 * here widens the ACL.
 *
 * A failed import falls back to the DOM host rather than throwing: that
 * still fullscreens the webview, which is most of what was asked for,
 * and it means a chunk-load hiccup costs the decorations rather than
 * the feature.
 */
export function createDesktopChromeHost(): WindowChromeHost {
  type TauriWindow = {
    setFullscreen(next: boolean): Promise<void>
    setDecorations(shown: boolean): Promise<void>
    isFullscreen(): Promise<boolean>
  }
  let pending: Promise<TauriWindow | null> | null = null
  const self = (): Promise<TauriWindow | null> =>
    (pending ??= import('@tauri-apps/api/window')
      .then(m => m.getCurrentWindow() as unknown as TauriWindow)
      .catch(err => {
        logger.warn('[windowChrome] the Tauri window API did not load:', err)
        return null
      }))
  const dom = createDomChromeHost()

  return {
    async setFullscreen(next) {
      const win = await self()
      if (win) await win.setFullscreen(next)
      else await dom.setFullscreen(next)
    },
    async setDecorations(shown) {
      const win = await self()
      // The DOM host has none to hide, so its no-op is the right
      // fallback rather than a skipped step.
      if (win) await win.setDecorations(shown)
    },
    // Tauri answers this asynchronously, and a synchronous reader
    // cannot await — so the synchronous answer is "trust your own last
    // write" and the real one arrives through `queryFullscreen` below.
    isFullscreen: () => null,
    async queryFullscreen() {
      const win = await self()
      // `core:window:allow-is-fullscreen` is granted to `main` and to
      // `output-*`. A refusal costs the seeded state, not the feature.
      return win ? await win.isFullscreen() : dom.isFullscreen()
    },
    async quit() {
      // Not `getCurrentWindow().close()`: Tauri exits when the *last*
      // window closes, and an installation with outputs up has several,
      // so closing the control window would leave the app running with
      // its operator surface gone — worse than doing nothing.
      //
      // `invoke` needs `core:default`, which `default.json` grants the
      // main window and `output.json` withholds, so this resolves in
      // the control window and is refused in an output. That refusal is
      // the point rather than a limitation, and it is why the failure
      // is logged rather than thrown: a hotkey that cannot fire should
      // not take down the render loop that heard it.
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('quit_app')
    },
  }
}

/**
 * The web fallback: the standard Fullscreen API.
 *
 * `setDecorations` is a deliberate no-op rather than a rejection —
 * there is no title bar in a browser tab, so the operation has already
 * succeeded, and rejecting would make the controller report a failure
 * for a request that was fully honoured.
 */
export function createDomChromeHost(doc: Document = document): WindowChromeHost {
  return {
    async setFullscreen(next) {
      if (next) await doc.documentElement.requestFullscreen()
      else if (doc.fullscreenElement) await doc.exitFullscreen()
    },
    async setDecorations() {
      /* nothing to hide */
    },
    isFullscreen: () => doc.fullscreenElement !== null,
  }
}

/** Whichever host this build should use. Synchronous — see
 *  `createDesktopChromeHost` for why that is load-bearing. */
export function resolveChromeHost(): WindowChromeHost {
  return isDesktop() ? createDesktopChromeHost() : createDomChromeHost()
}

/**
 * Whether a persisted fullscreen preference may be applied at boot.
 *
 * **Desktop only**, and not for tidiness: `requestFullscreen` requires
 * a user gesture, so restoring on the web throws a console error on
 * every launch and changes nothing. Tauri's `setFullscreen` has no such
 * rule, which is what makes step 26 of the smoke checklist — quit,
 * relaunch, still fullscreen — an installation feature rather than a
 * browser one.
 */
export function restoreOnLaunch(storage: ChromeStorage | null = defaultStorage()): boolean {
  return isDesktop() && readFullscreenPreference(storage)
}

export interface IdleCursor {
  /** Start or stop watching. The control window turns this on when it
   *  goes fullscreen and off when it comes back. */
  setActive(active: boolean): void
  dispose(): void
}

export interface IdleCursorOptions {
  /** Toggled on the root element; the stylesheet does the hiding. */
  root?: { classList: Pick<DOMTokenList, 'add' | 'remove'> } | null
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null
  idleMs?: number
  setTimer?: (fn: () => void, ms: number) => number
  clearTimer?: (id: number) => void
}

/** The class the stylesheet keys the hidden cursor off. */
export const CURSOR_IDLE_CLASS = 'cursor-idle'

/**
 * Hide the pointer after it holds still, while active.
 *
 * Only while fullscreen, because that is the only time the control
 * window is a capture surface — hiding the cursor of a windowed app an
 * operator is still driving would be a bug, not a feature.
 *
 * The hidden state is a class rather than an inline style so the rule
 * lives in CSS, where the `*` selector it needs is expressible: a
 * `cursor: none` on the root alone is overridden by every button's own
 * `cursor: pointer`, which is most of the chrome this is trying to
 * clear from the signal.
 *
 * Any pointer movement reveals it again and restarts the clock. The
 * listener is `pointermove` rather than `mousemove` so a pen or touch
 * contact counts, and it is **passive**: this never calls
 * `preventDefault`, and saying so up front stops the browser blocking
 * scroll on the chance that it might.
 */
export function createIdleCursor(options: IdleCursorOptions = {}): IdleCursor {
  const root =
    options.root ?? (typeof document !== 'undefined' ? document.documentElement : null)
  const target = options.target ?? (typeof window !== 'undefined' ? window : null)
  const idleMs = options.idleMs ?? CURSOR_IDLE_MS
  const setTimer =
    options.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number)
  const clearTimer = options.clearTimer ?? (id => globalThis.clearTimeout(id))

  let timer: number | null = null
  let active = false

  const show = (): void => {
    root?.classList.remove(CURSOR_IDLE_CLASS)
  }

  const arm = (): void => {
    if (timer !== null) clearTimer(timer)
    timer = setTimer(() => {
      timer = null
      // Re-checked at fire time, not only at arm time: `setActive(false)`
      // between the two would otherwise hide the cursor of a window that
      // has already left fullscreen.
      if (active) root?.classList.add(CURSOR_IDLE_CLASS)
    }, idleMs)
  }

  const onMove = (): void => {
    if (!active) return
    show()
    arm()
  }
  target?.addEventListener('pointermove', onMove, { passive: true })

  return {
    setActive(next) {
      if (next === active) return
      active = next
      if (active) {
        // Armed immediately rather than on the first movement: an
        // operator who clicks Fullscreen and then takes their hand off
        // the mouse never generates one.
        arm()
      } else {
        if (timer !== null) clearTimer(timer)
        timer = null
        show()
      }
    },
    dispose() {
      if (timer !== null) clearTimer(timer)
      timer = null
      show()
      target?.removeEventListener('pointermove', onMove)
    },
  }
}
