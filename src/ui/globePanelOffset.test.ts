// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initGlobePanelOffset, occupiedInset, type GlobePanelOffsetHandle } from './globePanelOffset'

describe('occupiedInset', () => {
  it('is zero with nothing open', () => {
    expect(occupiedInset(1366, [], false)).toBe(0)
  })

  it('is the distance from the panel to the inline-end edge', () => {
    expect(occupiedInset(1366, [{ left: 946, right: 1366 }], false)).toBe(420)
  })

  it('counts the margin outside a floating popover', () => {
    expect(occupiedInset(1366, [{ left: 1114, right: 1354 }], false)).toBe(252)
  })

  it('takes the wider of two panels', () => {
    const panels = [{ left: 946, right: 1366 }, { left: 1114, right: 1354 }]
    expect(occupiedInset(1366, panels, false)).toBe(420)
  })

  it('measures from the left edge in a right-to-left page', () => {
    expect(occupiedInset(1366, [{ left: 0, right: 420 }], true)).toBe(420)
  })

  it('is even, so half of it is a whole pixel', () => {
    expect(occupiedInset(1366, [{ left: 1114.5, right: 1354 }], false)).toBe(252)
    expect(occupiedInset(1366, [{ left: 1113, right: 1354 }], false) % 2).toBe(0)
  })

  it('leaves the globe alone on a narrow window', () => {
    expect(occupiedInset(768, [{ left: 348, right: 768 }], false)).toBe(0)
  })

  it('still centres in a quarter of the window, with both panels open at a large UI scale', () => {
    expect(occupiedInset(1366, [{ left: 334, right: 1366 }], false)).toBe(1032)
  })

  it('leaves the globe alone when the panel takes most of the window', () => {
    expect(occupiedInset(1366, [{ left: 0, right: 1366 }], false)).toBe(0)
  })
})

describe('initGlobePanelOffset', () => {
  let grid: HTMLElement
  let browse: HTMLElement
  let resizeMaps: ReturnType<typeof vi.fn<() => void>>
  let handle: GlobePanelOffsetHandle

  const openBrowse = (): void => {
    browse.classList.remove('hidden')
    document.body.classList.add('browse-open')
    handle.refresh()
  }
  const closeBrowse = (): void => {
    document.body.classList.remove('browse-open')
    handle.refresh()
  }

  beforeEach(() => {
    vi.useFakeTimers()
    Object.defineProperty(window, 'innerWidth', { value: 1366, configurable: true })
    document.body.innerHTML = `
      <aside id="browse-overlay" class="hidden"></aside>
      <div id="map-grid"><div class="map-viewport"></div></div>
      <div id="map-controls"><div id="tools-menu-popover" class="hidden"></div></div>`
    document.body.className = ''
    grid = document.getElementById('map-grid')!
    browse = document.getElementById('browse-overlay')!
    Object.defineProperty(browse, 'offsetWidth', { value: 420, configurable: true })
    resizeMaps = vi.fn<() => void>()
    handle = initGlobePanelOffset({ grid, resizeMaps })
  })

  afterEach(() => {
    handle.dispose()
    vi.useRealTimers()
  })

  it('leaves the grid untouched while nothing is open', () => {
    expect(grid.style.insetInlineStart).toBe('')
    expect(grid.style.transform).toBe('')
    expect(resizeMaps).not.toHaveBeenCalled()
  })

  it('widens the grid under the browse panel and glides to the new centre', () => {
    openBrowse()
    expect(grid.style.insetInlineStart).toBe('-420px')
    expect(resizeMaps).toHaveBeenCalledTimes(1)
    // Heading for rest at the widened box's own centre.
    expect(grid.style.transform).toBe('translateX(0px)')
    expect(grid.style.transition).toContain('transform')

    vi.runAllTimers()
    expect(grid.style.transform).toBe('')
    expect(grid.style.transition).toBe('')
    expect(grid.style.insetInlineStart).toBe('-420px')
    expect(resizeMaps).toHaveBeenCalledTimes(1)
  })

  it('glides back with the window still covered, then gives the width back', () => {
    openBrowse()
    vi.runAllTimers()
    resizeMaps.mockClear()

    closeBrowse()
    // Still widened during the move; translated half the width back.
    expect(grid.style.insetInlineStart).toBe('-420px')
    expect(grid.style.transform).toBe('translateX(210px)')
    expect(resizeMaps).not.toHaveBeenCalled()

    vi.runAllTimers()
    expect(grid.style.insetInlineStart).toBe('')
    expect(grid.style.transform).toBe('')
    expect(resizeMaps).toHaveBeenCalledTimes(1)
  })

  it('moves the other way in a right-to-left page', () => {
    document.documentElement.dir = 'rtl'
    try {
      openBrowse()
      vi.runAllTimers()
      closeBrowse()
      expect(grid.style.transform).toBe('translateX(-210px)')
    } finally {
      document.documentElement.dir = ''
    }
  })

  it('does not move while several globes share the window', () => {
    grid.appendChild(document.createElement('div'))
    openBrowse()
    expect(grid.style.insetInlineStart).toBe('')
    expect(resizeMaps).not.toHaveBeenCalled()
  })

  it('jumps instead of gliding when the reader asked for less motion', () => {
    const matchMedia = vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
    try {
      openBrowse()
      expect(grid.style.insetInlineStart).toBe('-420px')
      expect(grid.style.transform).toBe('')
      expect(grid.style.transition).toBe('')
    } finally {
      matchMedia.mockRestore()
    }
  })

  it('tells the stylesheets how far the corner buttons step aside', () => {
    const root = document.documentElement
    openBrowse()
    expect(root.style.getPropertyValue('--panel-push-top')).toBe('-420px')
    expect(root.style.getPropertyValue('--panel-push-bar')).toBe('-420px')
    expect(document.body.classList.contains('buttons-beside-panel')).toBe(true)
    // And what hangs off the globe panel's own edge.
    expect(root.style.getPropertyValue('--panel-push-view')).toBe('-420px')

    closeBrowse()
    expect(root.style.getPropertyValue('--panel-push-top')).toBe('')
    expect(root.style.getPropertyValue('--panel-push-bar')).toBe('')
    expect(document.body.classList.contains('buttons-beside-panel')).toBe(false)
  })

  it('moves the buttons, though not the globe, while several globes share the window', () => {
    grid.appendChild(document.createElement('div'))
    openBrowse()
    expect(document.documentElement.style.getPropertyValue('--panel-push-bar')).toBe('-420px')
    expect(document.documentElement.style.getPropertyValue('--panel-push-view')).toBe('')
    expect(grid.style.insetInlineStart).toBe('')
  })

  describe('when the window cannot hold both panels', () => {
    let popover: HTMLElement
    let closeBrowse: ReturnType<typeof vi.fn<() => void>>
    let closeTools: ReturnType<typeof vi.fn<() => void>>

    const openTools = (): void => {
      popover.classList.remove('hidden')
      handle.refresh()
    }

    beforeEach(() => {
      handle.dispose()
      popover = document.getElementById('tools-menu-popover')!
      // 240px wide, 12px in from the edge: where the bar has it before
      // the bar itself is pushed (happy-dom applies no translate).
      popover.getBoundingClientRect = () => {
        const right = window.innerWidth - 12
        return { left: right - 240, right, top: 0, bottom: 600, width: 240, height: 600 } as DOMRect
      }
      closeBrowse = vi.fn<() => void>(() => { document.body.classList.remove('browse-open') })
      closeTools = vi.fn<() => void>(() => { popover.classList.add('hidden') })
      handle = initGlobePanelOffset({ grid, resizeMaps, closeBrowse, closeTools })
    })

    it('leaves both open on a window with room to spare', () => {
      openBrowse()
      openTools()
      expect(closeBrowse).not.toHaveBeenCalled()
      expect(closeTools).not.toHaveBeenCalled()
    })

    it('closes the browse panel when Tools opens second', () => {
      Object.defineProperty(window, 'innerWidth', { value: 900, configurable: true })
      openBrowse()
      openTools()
      expect(closeBrowse).toHaveBeenCalledTimes(1)
      expect(closeTools).not.toHaveBeenCalled()
    })

    it('closes Tools when the browse panel opens second', () => {
      Object.defineProperty(window, 'innerWidth', { value: 900, configurable: true })
      openTools()
      openBrowse()
      expect(closeTools).toHaveBeenCalledTimes(1)
      expect(closeBrowse).not.toHaveBeenCalled()
    })
  })

  it('puts the grid and the buttons back on dispose', () => {
    openBrowse()
    handle.dispose()
    expect(grid.style.insetInlineStart).toBe('')
    expect(grid.style.transform).toBe('')
    expect(document.documentElement.style.getPropertyValue('--panel-push-top')).toBe('')
    expect(document.body.classList.contains('buttons-beside-panel')).toBe(false)
  })
})
