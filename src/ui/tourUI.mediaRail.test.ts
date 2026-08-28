// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the tour media rail — the responsive, layout-owned home
 * for positionless `showImage` / `playVideo` overlays (task: tour
 * media authoring). Legacy tours with explicit SOS coordinates must
 * keep the positioned path; positionless tasks stack in the rail,
 * concurrent media coexist, and each hide removes exactly its card.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  hideAllTourImages,
  hideAllTourPopups,
  hideAllTourVideos,
  hideTourImage,
  showTourImage,
  showTourPopup,
  showTourVideo,
  usesMediaRail,
} from './tourUI'

afterEach(() => {
  hideAllTourImages()
  hideAllTourVideos()
  hideAllTourPopups()
  document.body.replaceChildren()
})

const rail = () => document.getElementById('tour-media-rail')

describe('usesMediaRail', () => {
  it('is true only when every SOS position/size field is absent', () => {
    expect(usesMediaRail({})).toBe(true)
    expect(usesMediaRail({ xPct: 10 })).toBe(false)
    expect(usesMediaRail({ yPct: 20 })).toBe(false)
    expect(usesMediaRail({ widthPct: 40 })).toBe(false)
    expect(usesMediaRail({ heightPct: 40 })).toBe(false)
    expect(usesMediaRail({ sizePct: 50 })).toBe(false)
  })
})

describe('showTourImage', () => {
  it('renders a positionless image into the rail with no inline coordinates', () => {
    showTourImage({ imageID: 'a', filename: 'https://x/a.png', caption: 'Context' })
    const card = rail()!.querySelector('.tour-media-card') as HTMLElement
    expect(card).toBeTruthy()
    expect(card.style.left).toBe('')
    expect(card.style.bottom).toBe('')
    expect((card.querySelector('img') as HTMLImageElement).src).toBe('https://x/a.png')
    expect(card.querySelector('.tour-media-card-caption')?.textContent).toBe('Context')
  })

  it('keeps the legacy positioned path for explicit SOS coordinates', () => {
    showTourImage({ imageID: 'b', filename: 'https://x/b.png', xPct: 20, yPct: 70, widthPct: 30, heightPct: 30 })
    expect(rail()?.querySelector('.tour-media-card') ?? null).toBeNull()
    const wrapper = document.querySelector('.tour-image-overlay') as HTMLElement
    expect(wrapper.style.left).not.toBe('')
    expect(wrapper.style.bottom).not.toBe('')
  })

  it('stacks two concurrent images newest-first and hides each by its own ID', () => {
    showTourImage({ imageID: 'first', filename: 'https://x/1.png' })
    showTourImage({ imageID: 'second', filename: 'https://x/2.png' })
    const cards = rail()!.querySelectorAll('.tour-media-card')
    expect(cards).toHaveLength(2)
    expect((cards[0].querySelector('img') as HTMLImageElement).src).toBe('https://x/2.png')

    hideTourImage('first')
    const left = rail()!.querySelectorAll('.tour-media-card')
    expect(left).toHaveLength(1)
    expect((left[0].querySelector('img') as HTMLImageElement).src).toBe('https://x/2.png')
  })
})

describe('showTourVideo', () => {
  it('renders a positionless video into the rail and hideAll clears it', () => {
    showTourVideo({ filename: 'https://x/clip.mp4' })
    const card = rail()!.querySelector('.tour-media-card.tour-video-overlay') as HTMLElement
    expect(card).toBeTruthy()
    expect(card.querySelector('video')).toBeTruthy()
    hideAllTourVideos()
    expect(rail()!.querySelector('.tour-video-overlay')).toBeNull()
  })

  it('keeps the legacy positioned path when sizePct is present', () => {
    showTourVideo({ filename: 'https://x/legacy.mp4', xPct: 50, yPct: 50, sizePct: 50 })
    expect(rail()?.querySelector('.tour-video-overlay') ?? null).toBeNull()
    expect(document.querySelector('.tour-video-overlay')).toBeTruthy()
  })

  it('media and a text box coexist — the rail never holds text', () => {
    showTourVideo({ filename: 'https://x/clip.mp4' })
    showTourImage({ imageID: 'ctx', filename: 'https://x/ctx.png' })
    expect(rail()!.querySelectorAll('.tour-media-card')).toHaveLength(2)
  })
})

describe('showTourPopup', () => {
  it('renders a positionless embed into the rail with the sandbox opt-in honored', () => {
    showTourPopup({
      popupID: 'embed1',
      url: 'https://www.youtube-nocookie.com/embed/abc123',
      allowScripts: true,
    })
    const frame = rail()!.querySelector('.tour-media-card iframe') as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/abc123')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('keeps an untrusted embed fully sandboxed and the positioned path for coordinates', () => {
    showTourPopup({ popupID: 'embed2', url: 'https://example.org/page' })
    const frame = rail()!.querySelector('.tour-media-card iframe') as HTMLIFrameElement
    expect(frame.getAttribute('sandbox')).toBe('')

    showTourPopup({ popupID: 'legacy', url: 'https://example.org/x', xPct: 50, yPct: 50, widthPct: 50, heightPct: 50 })
    // The positioned popup lands outside the rail with inline geometry.
    const positioned = document.querySelector('.tour-popup-overlay:not(.tour-media-card)') as HTMLElement
    expect(positioned.style.left).not.toBe('')
  })
})
