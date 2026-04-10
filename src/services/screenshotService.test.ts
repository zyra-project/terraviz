import { describe, it, expect, vi, afterEach } from 'vitest'

// Force the MapRenderer to be absent so the tests exercise the DOM
// fallback path — we're verifying the fallback's downsample logic
// here, not the renderer's repaint-and-wait behavior.
vi.mock('./mapRenderer', () => ({
  getActiveMapRenderer: () => null,
}))

// Mock html2canvas so the captureFullScreen tests can run without
// booting a real browser renderer. The mock captures the options it
// was called with so we can assert on ignoreElements + onclone.
const html2canvasMock = vi.fn()
vi.mock('html2canvas', () => ({
  default: (el: HTMLElement, opts: unknown) => html2canvasMock(el, opts),
}))

import { captureGlobeScreenshot, captureFullScreen } from './screenshotService'

describe('captureGlobeScreenshot (DOM fallback)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('returns a data URL when canvas is present', async () => {
    const canvas = document.createElement('canvas')
    canvas.id = 'globe-canvas'
    canvas.width = 100
    canvas.height = 100
    // jsdom canvas has no real rendering context — mock toDataURL
    canvas.toDataURL = vi.fn().mockReturnValue('data:image/jpeg;base64,fakescreenshot')
    document.body.appendChild(canvas)

    const result = await captureGlobeScreenshot()
    expect(result).toBe('data:image/jpeg;base64,fakescreenshot')
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.6)
  })

  it('downsizes canvas exceeding SCREENSHOT_MAX_SIZE', async () => {
    const canvas = document.createElement('canvas')
    canvas.id = 'globe-canvas'
    canvas.width = 1920
    canvas.height = 1080
    canvas.toDataURL = vi.fn().mockReturnValue('data:image/jpeg;base64,original')

    // Mock offscreen canvas created by document.createElement
    const offscreenToDataURL = vi.fn().mockReturnValue('data:image/jpeg;base64,downsized')
    const mockCtx = { drawImage: vi.fn() }
    const origCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreateElement(tag)
      if (tag === 'canvas' && !el.id) {
        // This is the offscreen canvas
        const c = el as HTMLCanvasElement
        c.getContext = vi.fn().mockReturnValue(mockCtx) as never
        c.toDataURL = offscreenToDataURL
      }
      return el
    })
    document.body.appendChild(canvas)

    const result = await captureGlobeScreenshot()
    // Should use the offscreen canvas, not the original
    expect(result).toBe('data:image/jpeg;base64,downsized')
    expect(offscreenToDataURL).toHaveBeenCalledWith('image/jpeg', 0.6)
    // Original canvas toDataURL should NOT be called (offscreen was used)
    expect(canvas.toDataURL).not.toHaveBeenCalled()
  })

  it('returns null when canvas is missing', async () => {
    expect(await captureGlobeScreenshot()).toBeNull()
  })
})

describe('captureFullScreen', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    html2canvasMock.mockReset()
    vi.restoreAllMocks()
  })

  it('lazy-loads html2canvas and returns a composite data URL', async () => {
    // Prime the globe canvas so the fallback can pre-capture it
    const globe = document.createElement('canvas')
    globe.id = 'globe-canvas'
    globe.width = 200
    globe.height = 100
    globe.toDataURL = vi.fn().mockReturnValue('data:image/jpeg;base64,globe')
    document.body.appendChild(globe)

    // html2canvas returns a mock canvas whose toDataURL we can observe
    const compositeToDataURL = vi.fn().mockReturnValue('data:image/jpeg;base64,composite')
    const compositeCanvas = {
      width: 800,
      height: 600,
      toDataURL: compositeToDataURL,
    } as unknown as HTMLCanvasElement
    html2canvasMock.mockResolvedValue(compositeCanvas)

    const result = await captureFullScreen()

    expect(html2canvasMock).toHaveBeenCalledTimes(1)
    expect(result).toBe('data:image/jpeg;base64,composite')
  })

  it('excludes the help panel and triggers via ignoreElements', async () => {
    const globe = document.createElement('canvas')
    globe.id = 'globe-canvas'
    globe.width = 100
    globe.height = 100
    globe.toDataURL = vi.fn().mockReturnValue('data:image/jpeg;base64,globe')
    document.body.appendChild(globe)

    html2canvasMock.mockResolvedValue({
      width: 100,
      height: 100,
      toDataURL: vi.fn().mockReturnValue('data:image/jpeg;base64,composite'),
    } as unknown as HTMLCanvasElement)

    await captureFullScreen()

    const opts = html2canvasMock.mock.calls[0][1] as { ignoreElements: (el: Element) => boolean }
    const ignore = opts.ignoreElements

    // Real element lookups — make a synthetic element with an id and
    // ask the predicate whether it should be excluded.
    const helpPanel = document.createElement('div')
    helpPanel.id = 'help-panel'
    const helpTrigger = document.createElement('button')
    helpTrigger.id = 'help-trigger'
    const helpTriggerBrowse = document.createElement('button')
    helpTriggerBrowse.id = 'help-trigger-browse'
    const infoPanel = document.createElement('section')
    infoPanel.id = 'info-panel'

    expect(ignore(helpPanel)).toBe(true)
    expect(ignore(helpTrigger)).toBe(true)
    expect(ignore(helpTriggerBrowse)).toBe(true)
    // Info panel and other UI stays included
    expect(ignore(infoPanel)).toBe(false)
  })

  it('replaces the globe canvas in the cloned DOM with an img', async () => {
    const globe = document.createElement('canvas')
    globe.id = 'globe-canvas'
    globe.width = 400
    globe.height = 300
    // Give it a parent so replaceChild has somewhere to act
    const wrapper = document.createElement('div')
    wrapper.appendChild(globe)
    document.body.appendChild(wrapper)
    globe.toDataURL = vi.fn().mockReturnValue('data:image/jpeg;base64,globe-full')

    html2canvasMock.mockResolvedValue({
      width: 400,
      height: 300,
      toDataURL: vi.fn().mockReturnValue('data:image/jpeg;base64,composite'),
    } as unknown as HTMLCanvasElement)

    await captureFullScreen()

    const opts = html2canvasMock.mock.calls[0][1] as {
      onclone: (doc: Document) => void
    }

    // Build a minimal cloned document the way html2canvas would and
    // run onclone against it. The globe canvas should be replaced by
    // an <img> pointing at the pre-captured data URL.
    const cloneDoc = document.implementation.createHTMLDocument('clone')
    const cloneWrapper = cloneDoc.createElement('div')
    const cloneCanvas = cloneDoc.createElement('canvas')
    cloneCanvas.id = 'globe-canvas'
    cloneWrapper.appendChild(cloneCanvas)
    cloneDoc.body.appendChild(cloneWrapper)

    opts.onclone(cloneDoc)

    const replaced = cloneWrapper.querySelector('img')
    expect(replaced).not.toBeNull()
    expect(replaced?.src).toContain('data:image/jpeg;base64,globe-full')
    // The original canvas should be gone
    expect(cloneWrapper.querySelector('canvas')).toBeNull()
  })

  it('returns null when html2canvas throws', async () => {
    const globe = document.createElement('canvas')
    globe.id = 'globe-canvas'
    globe.width = 100
    globe.height = 100
    globe.toDataURL = vi.fn().mockReturnValue('data:image/jpeg;base64,globe')
    document.body.appendChild(globe)

    html2canvasMock.mockRejectedValue(new Error('render failed'))

    const result = await captureFullScreen()
    expect(result).toBeNull()
  })
})
