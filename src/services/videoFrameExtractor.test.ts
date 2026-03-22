import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VideoFrameExtractor } from './videoFrameExtractor'

// happy-dom provides canvas and video elements but does not implement
// CanvasRenderingContext2D.drawImage fully, so we stub it to avoid errors.

describe('VideoFrameExtractor', () => {
  let extractor: VideoFrameExtractor

  beforeEach(() => {
    extractor = new VideoFrameExtractor()
  })

  it('getCanvas() returns an HTMLCanvasElement', () => {
    expect(extractor.getCanvas()).toBeInstanceOf(HTMLCanvasElement)
  })

  it('stopLoop() does not throw when the loop was never started', () => {
    expect(() => extractor.stopLoop()).not.toThrow()
  })

  it('destroy() does not throw when the loop was never started', () => {
    expect(() => extractor.destroy()).not.toThrow()
  })

  it('stopLoop() is idempotent', () => {
    extractor.stopLoop()
    extractor.stopLoop()
    expect(extractor.getCanvas()).toBeInstanceOf(HTMLCanvasElement)
  })
})

// ---------------------------------------------------------------------------
// extractFrame — canvas sizing
// ---------------------------------------------------------------------------
describe('VideoFrameExtractor.extractFrame', () => {
  it('returns the canvas element', () => {
    const extractor = new VideoFrameExtractor()
    const canvas = extractor.getCanvas()

    // Stub drawImage so the test doesn't rely on unimplemented canvas APIs
    const ctx = canvas.getContext('2d')!
    vi.spyOn(ctx, 'drawImage').mockImplementation(() => {})

    const video = document.createElement('video')
    const result = extractor.extractFrame(video)
    expect(result).toBe(canvas)
  })

  it('resizes canvas to match video dimensions', () => {
    const extractor = new VideoFrameExtractor()
    const canvas = extractor.getCanvas()
    const ctx = canvas.getContext('2d')!
    vi.spyOn(ctx, 'drawImage').mockImplementation(() => {})

    const video = document.createElement('video')
    // Manually set read-only properties via defineProperty
    Object.defineProperty(video, 'videoWidth', { value: 1920, configurable: true })
    Object.defineProperty(video, 'videoHeight', { value: 1080, configurable: true })

    extractor.extractFrame(video)
    expect(canvas.width).toBe(1920)
    expect(canvas.height).toBe(1080)
  })

  it('does not resize when video has no dimensions', () => {
    const extractor = new VideoFrameExtractor()
    const canvas = extractor.getCanvas()
    const originalWidth = canvas.width
    const ctx = canvas.getContext('2d')!
    vi.spyOn(ctx, 'drawImage').mockImplementation(() => {})

    const video = document.createElement('video') // videoWidth/Height = 0
    extractor.extractFrame(video)
    expect(canvas.width).toBe(originalWidth)
  })
})

// ---------------------------------------------------------------------------
// startLoop / stopLoop
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// startLoop / stopLoop
// rAF re-queues itself on every tick, so vi.runAllTimers() causes an
// infinite loop. Instead, stub rAF to capture the callback and invoke it
// exactly once ourselves.
// ---------------------------------------------------------------------------
describe('VideoFrameExtractor.startLoop', () => {
  function stubRaf() {
    let pending: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const tick = () => pending?.(performance.now())
    return { tick }
  }

  it('calls onFrame when video is playing', () => {
    const { tick } = stubRaf()

    const extractor = new VideoFrameExtractor()
    const ctx = extractor.getCanvas().getContext('2d')!
    vi.spyOn(ctx, 'drawImage').mockImplementation(() => {})

    const video = document.createElement('video')
    Object.defineProperty(video, 'paused', { value: false, configurable: true })
    Object.defineProperty(video, 'ended', { value: false, configurable: true })
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true })

    const onFrame = vi.fn()
    extractor.startLoop(video, onFrame)
    tick()

    expect(onFrame).toHaveBeenCalled()
    extractor.stopLoop()
    vi.unstubAllGlobals()
  })

  it('does not call onFrame when video is paused', () => {
    const { tick } = stubRaf()

    const extractor = new VideoFrameExtractor()
    const ctx = extractor.getCanvas().getContext('2d')!
    vi.spyOn(ctx, 'drawImage').mockImplementation(() => {})

    const video = document.createElement('video') // paused by default

    const onFrame = vi.fn()
    extractor.startLoop(video, onFrame)
    tick()

    expect(onFrame).not.toHaveBeenCalled()
    extractor.stopLoop()
    vi.unstubAllGlobals()
  })
})
