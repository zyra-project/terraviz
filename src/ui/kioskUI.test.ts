// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { beforeEach, describe, expect, it } from 'vitest'
import { t } from '../i18n'
import type { KioskDataset } from '../output/kioskModel'
import { fitFontPx, KIOSK_STAGE, mountKiosk, whenState } from './kioskUI'

const dataset = (over: Partial<KioskDataset> = {}): KioskDataset => ({
  id: 'DS1',
  title: 'Sea Surface Temperature',
  abstract: 'What the ocean is doing.',
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

describe('mountKiosk', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="kiosk"></div>'
  })

  it("lays out one fixed stage the size of Second Life's largest media face", () => {
    mountKiosk(q('#kiosk'))
    expect(KIOSK_STAGE).toEqual({ width: 2048, height: 1024 })
    expect(q('.kiosk-stage').style.width).toBe('2048px')
    expect(q('.kiosk-stage').style.height).toBe('1024px')
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
  })

  it("shows a dataset's title, abstract, picture, legend image, credit and licence", () => {
    const screen = mountKiosk(q('#kiosk'))
    screen.show({ kind: 'dataset', dataset: dataset({ licenseText: 'Use freely' }) })
    expect(q('.kiosk-title').textContent).toBe('Sea Surface Temperature')
    expect(q('.kiosk-abstract').textContent).toBe('What the ocean is doing.')
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
    expect(bar.textContent).toContain('µg m-3')
    // Display only: nothing on the stage can be clicked or focused.
    expect(document.querySelectorAll('.kiosk-stage button, .kiosk-stage a, .kiosk-stage input, .kiosk-stage [tabindex]')).toHaveLength(0)
  })

  it('writes the date and what the globe is doing, touching the screen only when the words change', () => {
    const screen = mountKiosk(q('#kiosk'))
    screen.show({ kind: 'dataset', dataset: dataset() })
    screen.setWhen({ state: 'playing', text: 'Jan 6, 2024', rate: 2 })
    expect(q('.kiosk-date').textContent).toBe('Jan 6, 2024')
    expect(q('.kiosk-state').textContent).toBe(t('kiosk.when.playingAt', { rate: '2' }))
    const node = q('.kiosk-date').firstChild
    screen.setWhen({ state: 'playing', text: 'Jan 6, 2024', rate: 2 })
    expect(q('.kiosk-date').firstChild).toBe(node)
    // With no date the row is invisible but keeps its place.
    screen.setWhen({ state: 'none', text: '', rate: 1 })
    expect(q('.kiosk-when').style.visibility).toBe('hidden')
    expect(q('.kiosk-when').hidden).toBe(false)
  })

  it('says loading, then that a description could not be read', () => {
    const screen = mountKiosk(q('#kiosk'))
    screen.show({ kind: 'loading' })
    expect(q('.kiosk-title').textContent).toBe(t('kiosk.loading'))
    screen.show({ kind: 'unavailable' })
    expect(q('.kiosk-title').textContent).toBe(t('kiosk.unavailable.title'))
    expect(q('.kiosk-legend').hidden).toBe(true)
  })
})

describe('whenState', () => {
  it('names what the globe is doing', () => {
    expect(whenState({ state: 'playing', text: 'x', rate: 1 })).toBe(t('kiosk.when.playing'))
    expect(whenState({ state: 'playing', text: 'x', rate: 0.5 })).toBe(t('kiosk.when.playingAt', { rate: '0.5' }))
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
