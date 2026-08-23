import { describe, it, expect } from 'vitest'
import { maxVideoPanelsForWidth, MAX_VIDEO_PANELS_PHONE, UNCAPPED_VIDEO_PANELS } from './deviceCapability'

// ---------------------------------------------------------------------------
// maxVideoPanelsForWidth — the phone video-decode cap (terraviz#230)
// ---------------------------------------------------------------------------
describe('maxVideoPanelsForWidth', () => {
  it('caps a phone-width viewport at two video panels', () => {
    expect(maxVideoPanelsForWidth(393)).toBe(MAX_VIDEO_PANELS_PHONE)
    expect(maxVideoPanelsForWidth(768)).toBe(MAX_VIDEO_PANELS_PHONE)
  })

  it('leaves anything wider uncapped', () => {
    expect(maxVideoPanelsForWidth(769)).toBe(UNCAPPED_VIDEO_PANELS)
    expect(maxVideoPanelsForWidth(1440)).toBe(UNCAPPED_VIDEO_PANELS)
  })

  it('keys on width alone, so a touchscreen desktop is not treated as a phone', () => {
    // The cap deliberately does not use isMobile(), which is also true
    // for maxTouchPoints > 0 — a touch laptop, an iPad, a Quest. Those
    // have the decode headroom a phone does not.
    expect(maxVideoPanelsForWidth(1920)).toBe(UNCAPPED_VIDEO_PANELS)
  })
})
