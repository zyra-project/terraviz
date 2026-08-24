import { describe, it, expect } from 'vitest'
import {
  maxVideoPanelsForViewport,
  MAX_VIDEO_PANELS_PHONE,
  UNCAPPED_VIDEO_PANELS,
} from './deviceCapability'

// ---------------------------------------------------------------------------
// maxVideoPanelsForViewport — the phone video-decode cap (terraviz#230)
// ---------------------------------------------------------------------------
describe('maxVideoPanelsForViewport', () => {
  it('caps the phone from the crash report', () => {
    expect(maxVideoPanelsForViewport(393, 852)).toBe(MAX_VIDEO_PANELS_PHONE)
  })

  it('still caps that phone once it is rotated', () => {
    // The reason this classifies on the shorter edge. A width-only test
    // reads 852 here, sails past any phone threshold, and lets the tour
    // build four decoders on the very device that crashes.
    expect(maxVideoPanelsForViewport(852, 393)).toBe(MAX_VIDEO_PANELS_PHONE)
  })

  it('answers the same in both orientations for any device', () => {
    for (const [w, h] of [[393, 852], [430, 932], [820, 1180], [1440, 900]]) {
      expect(maxVideoPanelsForViewport(w, h)).toBe(maxVideoPanelsForViewport(h, w))
    }
  })

  it('leaves iPads uncapped in either orientation', () => {
    // 768 is an iPad's short edge, which is why the threshold is not
    // the 768px mobile breakpoint. iPads have not been shown to have
    // this problem, and capping them would remove a layout that works.
    expect(maxVideoPanelsForViewport(768, 1024)).toBe(UNCAPPED_VIDEO_PANELS)
    expect(maxVideoPanelsForViewport(1024, 768)).toBe(UNCAPPED_VIDEO_PANELS)
    expect(maxVideoPanelsForViewport(744, 1133)).toBe(UNCAPPED_VIDEO_PANELS) // iPad mini
    expect(maxVideoPanelsForViewport(820, 1180)).toBe(UNCAPPED_VIDEO_PANELS) // iPad Air
  })

  it('leaves desktops uncapped', () => {
    expect(maxVideoPanelsForViewport(1440, 900)).toBe(UNCAPPED_VIDEO_PANELS)
    // Including a touchscreen one: the cap is a viewport test, not
    // isMobile(), which maxTouchPoints would make true here.
    expect(maxVideoPanelsForViewport(1920, 1080)).toBe(UNCAPPED_VIDEO_PANELS)
  })

  it('keeps clear margin between the largest phone and the smallest tablet', () => {
    // Phones top out near 440 on the short edge; tablets start near 744.
    // The threshold has to sit in that gap rather than near either end.
    expect(maxVideoPanelsForViewport(440, 956)).toBe(MAX_VIDEO_PANELS_PHONE)
    expect(maxVideoPanelsForViewport(744, 1133)).toBe(UNCAPPED_VIDEO_PANELS)
  })
})
