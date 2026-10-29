// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { t } from '../i18n'
import type { KioskDataset } from '../output/kioskModel'
import { ABSTRACT_FONT_PX, fitFontPx, KIOSK_STAGE, kioskLayout, mountKiosk, whenState } from './kioskUI'

const dataset = (over: Partial<KioskDataset> = {}): KioskDataset => ({
  id: 'DS1',
  title: 'Sea Surface Temperature',
  abstract: ['What the ocean is doing.', 'And why it matters.'],
  thumbnail: 'https://node.example/thumb.jpg',
  legend: { kind: 'image', url: 'https://node.example/legend.png' },
  credit: 'NOAA',
  license: 'CC-BY-4.0',
  licenseText: '',
  kind: 'video',
  startTime: null,
  endTime: null,
  period: '',
  frameCount: null,
  lengthS: 100,
  retryS: 0,
  ...over,
})

const q = (sel: string): HTMLElement => document.querySelector(sel) as HTMLElement

/** Sets the window's size for `fit()`, which reads it. */
function windowSize(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
}

describe('kioskLayout', () => {
  it("is the stage at Second Life's largest media face, or larger, and a page that reflows below it", () => {
    expect(KIOSK_STAGE).toEqual({ width: 2048, height: 1024 })
    expect(kioskLayout(2048, 1024)).toBe('stage')
    expect(kioskLayout(3840, 2160)).toBe('stage')
    // A desktop browser, zoomed or not, and a phone.
    expect(kioskLayout(1920, 1080)).toBe('page')
    expect(kioskLayout(2048, 900)).toBe('page')
    expect(kioskLayout(390, 844)).toBe('page')
  })
})

describe('mountKiosk', () => {
  const size = { width: window.innerWidth, height: window.innerHeight }

  beforeEach(() => {
    document.body.innerHTML = '<div id="kiosk"></div>'
    document.body.className = 'kiosk-body-page'
  })

  afterEach(() => windowSize(size.width, size.height))

  it('lays out the stage at the media face, at its own scale, and a page in a smaller window', () => {
    windowSize(2048, 1024)
    const screen = mountKiosk(q('#kiosk'))
    expect(q('.kiosk-stage').dataset.layout).toBe('stage')
    expect(q('.kiosk-stage').style.transform).toBe('translate(0px, 0px) scale(1)')
    expect(document.body.classList.contains('kiosk-scroll')).toBe(false)
    // A browser at 1440 wide gets a page it can zoom and scroll.
    windowSize(1440, 900)
    screen.fit()
    expect(q('.kiosk-stage').dataset.layout).toBe('page')
    expect(q('.kiosk-stage').style.transform).toBe('')
    expect(document.body.classList.contains('kiosk-scroll')).toBe(true)
  })

  it('shows the live Earth, its credit, and no picture or legend', () => {
    const screen = mountKiosk(q('#kiosk'))
    screen.show({ kind: 'earth' })
    expect(q('.kiosk-title').textContent).toBe(t('kiosk.earth.title'))
    expect(q('.kiosk-abstract').textContent).toBe(t('kiosk.earth.about'))
    expect(q('.kiosk-credit').textContent).toBe(t('kiosk.credit') + t('kiosk.earth.credit'))
    expect(q('.kiosk-thumb').hidden).toBe(true)
    expect(q('.kiosk-legend').hidden).toBe(true)
    expect(q('.kiosk-license').hidden).toBe(true)
    expect(document.title).toBe(t('kiosk.pageTitle'))
  })

  it("shows a dataset's title, abstract, picture, legend image, credit and licence", () => {
    const screen = mountKiosk(q('#kiosk'))
    screen.show({ kind: 'dataset', dataset: dataset({ licenseText: 'Use freely' }) })
    expect(q('.kiosk-title').textContent).toBe('Sea Surface Temperature')
    const paragraphs = [...document.querySelectorAll('.kiosk-abstract p')].map((p) => p.textContent)
    expect(paragraphs).toEqual(['What the ocean is doing.', 'And why it matters.'])
    const thumb = q('.kiosk-thumb') as HTMLImageElement
    expect(thumb.hidden).toBe(false)
    expect(thumb.src).toBe('https://node.example/thumb.jpg')
    // Decorative: the title beside it already says what it is.
    expect(thumb.alt).toBe('')
    const legend = q('.kiosk-legend-image') as HTMLImageElement
    expect(legend.src).toBe('https://node.example/legend.png')
    expect(legend.alt).toBe(t('kiosk.legendAlt', { title: 'Sea Surface Temperature' }))
    expect(q('.kiosk-credit').textContent).toBe(t('kiosk.credit') + 'NOAA')
    expect(q('.kiosk-license').textContent).toBe(t('kiosk.license') + 'CC-BY-4.0 · Use freely')
    expect(document.title).toBe(t('kiosk.pageTitleDataset', { title: 'Sea Surface Temperature' }))
  })

  it("isolates the node's text, which takes its own direction whatever the page's", () => {
    const screen = mountKiosk(q('#kiosk'))
    screen.show({ kind: 'dataset', dataset: dataset() })
    expect(q('.kiosk-title').dir).toBe('auto')
    for (const p of document.querySelectorAll<HTMLElement>('.kiosk-abstract p')) expect(p.dir).toBe('auto')
    expect(q('.kiosk-credit bdi').textContent).toBe('NOAA')
    expect(q('.kiosk-license bdi').textContent).toBe('CC-BY-4.0')
  })

  it("draws a data-encoded dataset's legend as the app's own colour bar, not a control", () => {
    const screen = mountKiosk(q('#kiosk'))
    screen.show({
      kind: 'dataset',
      dataset: dataset({
        legend: {
          kind: 'scale',
          scale: { stops: [{ t: 0, rgba: [0, 0, 0, 0] }, { t: 1, rgba: [255, 0, 0, 255] }], vmin: 0, vmax: 200, units: 'µg m-3' },
        },
      }),
    })
    const bar = q('.kiosk-legend .panel-colorbar')
    expect(bar).not.toBeNull()
    expect(bar.tagName).toBe('DIV')
    expect(bar.getAttribute('role')).toBe('img')
    expect(bar.textContent).toContain('µg m-3')
    // Display only: nothing on the stage can be clicked or focused.
    expect(document.querySelectorAll('.kiosk-stage button, .kiosk-stage a, .kiosk-stage input, .kiosk-stage [tabindex]')).toHaveLength(0)
  })

  it('writes the date and what the globe is doing, touching the screen only when the words change', () => {
    const screen = mountKiosk(q('#kiosk'))
    screen.show({ kind: 'dataset', dataset: dataset() })
    screen.setWhen({ state: 'playing', text: 'Jan 6, 2024', rate: 2 })
    expect(q('.kiosk-date').textContent).toBe('Jan 6, 2024')
    expect(q('.kiosk-state').textContent).toBe(t('kiosk.when.playingFaster'))
    const node = q('.kiosk-date').firstChild
    screen.setWhen({ state: 'playing', text: 'Jan 6, 2024', rate: 2 })
    expect(q('.kiosk-date').firstChild).toBe(node)
    // With no date the row is invisible but keeps its place.
    screen.setWhen({ state: 'none', text: '', rate: 1 })
    expect(q('.kiosk-when').style.visibility).toBe('hidden')
    expect(q('.kiosk-when').hidden).toBe(false)
  })

  it('says loading, that a description could not be read, or that a dataset could not be found', () => {
    const screen = mountKiosk(q('#kiosk'))
    screen.show({ kind: 'loading' })
    expect(q('.kiosk-title').textContent).toBe(t('kiosk.loading'))
    screen.show({ kind: 'unavailable' })
    expect(q('.kiosk-title').textContent).toBe(t('kiosk.unavailable.title'))
    expect(q('.kiosk-abstract').textContent).toBe(t('kiosk.unavailable.body'))
    expect(q('.kiosk-legend').hidden).toBe(true)
    screen.show({ kind: 'notFound' })
    expect(q('.kiosk-title').textContent).toBe(t('kiosk.notFound.title'))
    expect(q('.kiosk-abstract').textContent).toBe(t('kiosk.notFound.body'))
  })

  it('shrinks the abstract on the stage, cuts it with a fade below the smallest size, and does neither on a page', () => {
    windowSize(2048, 1024)
    // A layout engine's answers: the abstract overflows its box at every size.
    const box = Object.getOwnPropertyDescriptors(HTMLElement.prototype)
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains('kiosk-abstract') ? 1000 : 0 },
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains('kiosk-abstract') ? 400 : 0 },
    })
    try {
      const screen = mountKiosk(q('#kiosk'))
      screen.show({ kind: 'dataset', dataset: dataset() })
      expect(q('.kiosk-abstract').style.fontSize).toBe(`${ABSTRACT_FONT_PX.min}px`)
      expect(q('.kiosk-abstract').classList.contains('kiosk-abstract-cut')).toBe(true)
      windowSize(1440, 900)
      screen.fit()
      expect(q('.kiosk-abstract').style.fontSize).toBe('')
      expect(q('.kiosk-abstract').classList.contains('kiosk-abstract-cut')).toBe(false)
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', box.scrollHeight ?? { configurable: true, value: 0 })
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', box.clientHeight ?? { configurable: true, value: 0 })
    }
  })
})

describe('whenState', () => {
  it('names what the globe is doing, and whether it is sped up or slowed down, not by how much', () => {
    expect(whenState({ state: 'playing', text: 'x', rate: 1 })).toBe(t('kiosk.when.playing'))
    expect(whenState({ state: 'playing', text: 'x', rate: 2 })).toBe(t('kiosk.when.playingFaster'))
    expect(whenState({ state: 'playing', text: 'x', rate: 0.5 })).toBe(t('kiosk.when.playingSlower'))
    expect(whenState({ state: 'paused', text: 'x', rate: 1 })).toBe(t('kiosk.when.paused'))
    expect(whenState({ state: 'live', text: 'x', rate: 1 })).toBe(t('kiosk.when.live'))
    expect(whenState({ state: 'span', text: 'x', rate: 1 })).toBe('')
  })
})

describe('fitFontPx', () => {
  it('takes the largest size that fits, or the smallest when none does', () => {
    expect(fitFontPx(22, 34, () => false)).toBe(34)
    expect(fitFontPx(22, 34, (px) => px > 27)).toBe(27)
    expect(fitFontPx(22, 34, () => true)).toBe(22)
  })
})
