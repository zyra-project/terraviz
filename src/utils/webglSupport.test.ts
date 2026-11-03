// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, vi } from 'vitest'
import { hasWebGL2, showWebGLUnavailable } from './webglSupport'

/**
 * A canvas stub that answers only the context types it is told to, so a
 * case can describe a browser precisely — "WebGL 1 but not 2" is the one
 * that matters and is otherwise unreachable on a real headless canvas.
 */
function canvasWith(...supported: string[]): () => HTMLCanvasElement {
  return () => ({
    getContext: (type: string) => (supported.includes(type) ? {} : null),
  }) as unknown as HTMLCanvasElement
}

describe('hasWebGL2', () => {
  it('accepts a browser with WebGL 2', () => {
    expect(hasWebGL2(canvasWith('webgl2'))).toBe(true)
  })

  it('rejects a browser with WebGL 1 but not WebGL 2', () => {
    // The regression guard for the MapLibre 6 upgrade. Before it, the
    // preflight was `getContext('webgl2') || getContext('webgl')`, so this
    // browser cleared it and then failed inside the renderer — losing the
    // troubleshooting screen and leaving a blank globe. If someone
    // reinstates the fallback, this is the case that fails.
    expect(hasWebGL2(canvasWith('webgl'))).toBe(false)
  })

  it('rejects a browser with no WebGL at all', () => {
    expect(hasWebGL2(canvasWith())).toBe(false)
  })

  it('rejects rather than throwing when context creation throws', () => {
    // Some drivers throw out of `getContext` instead of returning null.
    // That browser has no WebGL 2 either, and an exception here would
    // escape into boot ahead of the screen that explains the problem.
    const throwing = () => ({
      getContext: () => { throw new Error('GPU process crashed') },
    }) as unknown as HTMLCanvasElement
    expect(hasWebGL2(throwing)).toBe(false)
  })

  it('reads a real canvas through the default factory', () => {
    // Pins that the default argument is wired to the document at all — a
    // factory defaulted to something inert would make every call above
    // pass while the shipped path tested nothing.
    const spy = vi.spyOn(document, 'createElement')
    hasWebGL2()
    expect(spy).toHaveBeenCalledWith('canvas')
    spy.mockRestore()
  })
})

describe('showWebGLUnavailable', () => {
  function screenWithStatus(): HTMLElement {
    const screen = document.createElement('div')
    screen.id = 'loading-screen'
    screen.className = 'fade-out'
    screen.innerHTML = '<div id="loading-status" role="status">Starting up</div>'
    return screen
  }

  it('announces the problem itself, since it replaces the status line', () => {
    // The loading screen is not a live region and this removes the one
    // inside it, so without its own alert the message is never spoken.
    const screen = screenWithStatus()
    showWebGLUnavailable(screen)
    expect(screen.querySelector('#loading-status')).toBeNull()
    const alerts = screen.querySelectorAll('[role="alert"]')
    expect(alerts).toHaveLength(1)
    expect(alerts[0].querySelector('h1')?.textContent).toBe('WebGL 2 is not available')
    expect(alerts[0].textContent).toContain('requires WebGL 2')
  })

  it('keeps the fix-it steps out of the alert', () => {
    const screen = screenWithStatus()
    showWebGLUnavailable(screen)
    const details = screen.querySelector('details')
    expect(details).not.toBeNull()
    expect(details!.closest('[role="alert"]')).toBeNull()
    expect(screen.querySelector('[role="alert"] details, [role="alert"] summary')).toBeNull()
  })

  it('marks its English text as English, and shows the screen', () => {
    const screen = screenWithStatus()
    showWebGLUnavailable(screen)
    expect(screen.querySelector('[role="alert"]')!.closest('[lang]')?.getAttribute('lang')).toBe('en')
    expect(screen.style.display).toBe('flex')
    expect(screen.classList.contains('fade-out')).toBe(false)
  })
})
