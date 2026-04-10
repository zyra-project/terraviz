import { describe, it, expect, vi, afterEach } from 'vitest'
import { captureGlobeScreenshot } from './screenshotService'

describe('captureGlobeScreenshot', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('returns a data URL when canvas is present', () => {
    const canvas = document.createElement('canvas')
    canvas.id = 'globe-canvas'
    canvas.width = 100
    canvas.height = 100
    // jsdom canvas has no real rendering context — mock toDataURL
    canvas.toDataURL = vi.fn().mockReturnValue('data:image/jpeg;base64,fakescreenshot')
    document.body.appendChild(canvas)

    const result = captureGlobeScreenshot()
    expect(result).toBe('data:image/jpeg;base64,fakescreenshot')
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.6)
  })

  it('downsizes canvas exceeding SCREENSHOT_MAX_SIZE', () => {
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

    const result = captureGlobeScreenshot()
    // Should use the offscreen canvas, not the original
    expect(result).toBe('data:image/jpeg;base64,downsized')
    expect(offscreenToDataURL).toHaveBeenCalledWith('image/jpeg', 0.6)
    // Original canvas toDataURL should NOT be called (offscreen was used)
    expect(canvas.toDataURL).not.toHaveBeenCalled()
  })

  it('returns null when canvas is missing', () => {
    expect(captureGlobeScreenshot()).toBeNull()
  })
})
