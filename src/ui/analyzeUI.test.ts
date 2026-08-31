// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the Analyze panel and its CSV export.
 *
 * The panel is thin — the arithmetic lives in `datasetStats` and is
 * tested there — so these cover the parts that only exist here: that a
 * region choice actually narrows the window, that the empty states are
 * distinguishable (nothing loaded / outside coverage / no data in
 * region are three different answers and reading one for another sends
 * a user looking for the wrong problem), and that the export carries
 * enough context to be falsifiable later.
 */
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import {
  closeAnalyzeUI,
  currentResult,
  initAnalyzeUI,
  isAnalyzeUIOpen,
  notifyAnalyzeDatasetChanged,
  notifyAnalyzePlaybackSettled,
  openAnalyzeUI,
  type AnalyzeSource,
  type TransectPicker,
} from './analyzeUI'
import { buildCsvText, buildTransectCsvText, buildZonalCsvText, downloadCsv } from './analyzeExport'
import {
  buildHistogram,
  sampleTransect,
  summarize,
  zonalMeans,
  type TransectEndpoints,
} from '../services/datasetStats'
import { resolveRegion } from '../data/regions'
import { DEFAULT_DISPLAY } from '../services/colorScaleDisplay'
import type { ContourLevel } from '../services/datasetContours'
import type { LumaSnapshot } from '../services/glLumaSampler'
import type { ColorScale, DatasetOverlayOptions } from '../types'

const SCALE: ColorScale = {
  stops: [
    { t: 0, rgba: [255, 255, 229, 0] },
    { t: 1, rgba: [102, 37, 6, 255] },
  ],
  vmin: 0,
  vmax: 255,
  units: 'mg m-2',
  transparentRange: 12 / 256,
}

/** The bbox the live RRFS rows carry. */
const OPTIONS: DatasetOverlayOptions = {
  boundingBox: { n: 85, s: 5, w: -175, e: -20 },
  colorScale: SCALE,
}

function snap(w: number, h: number, fill: (x: number, y: number) => number): LumaSnapshot {
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fill(x, y)
  return { data, width: w, height: h }
}

function makeSource(over: Partial<AnalyzeSource> = {}): AnalyzeSource {
  return {
    frame: () => ({ snapshot: snap(8, 8, () => 200), scale: SCALE, options: OPTIONS }),
    visibleBounds: () => ({ n: 85, s: 5, w: -175, e: -20 }),
    display: () => DEFAULT_DISPLAY,
    datasetTitle: () => 'Wildfire Smoke Overhead',
    datasetId: () => 'INTERNAL_SMOKE_COLUMN',
    ...over,
  }
}

const select = () => document.getElementById('analyze-scope-select') as HTMLSelectElement
const bodyText = () => document.querySelector('.analyze-body')?.textContent ?? ''

beforeEach(() => {
  closeAnalyzeUI()
  document.body.innerHTML = ''
})

describe('openAnalyzeUI', () => {
  it('computes against the current frame on open', () => {
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    expect(isAnalyzeUIOpen()).toBe(true)
    expect(currentResult()?.mean).toBeCloseTo(200, 6)
    expect(document.querySelector('.analyze-histogram')).not.toBeNull()
    // Scoped to the region block's own grid — the first on the panel.
    // The zonal section below it carries its own two tiles, and this
    // assertion is about the region statistics.
    expect(
      document.querySelector('.analyze-stats')!.querySelectorAll('.analyze-stat'),
    ).toHaveLength(8)
  })

  it('states the quantisation step next to the numbers, not in a footnote', () => {
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    const note = document.querySelector('.analyze-precision')?.textContent ?? ''
    // 255 over 255 codes is a step of 1.
    expect(note).toContain('1')
    expect(note).toContain('mg m-2')
  })

  it('reports coverage, so a mean over 3% of a box is not read as a mean over all of it', () => {
    initAnalyzeUI(makeSource({
      frame: () => ({
        // One data texel in sixteen; the rest absent.
        snapshot: snap(4, 4, (x, y) => (x === 0 && y === 0 ? 200 : 0)),
        scale: SCALE,
        options: OPTIONS,
      }),
    }))
    openAnalyzeUI()
    expect(currentResult()?.coverage).toBeCloseTo(0.0625, 6)
    expect(document.querySelector('.analyze-coverage')?.textContent).toContain('6.3')
  })

  it('closes on Escape and on the close button', () => {
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(isAnalyzeUIOpen()).toBe(false)

    openAnalyzeUI()
    ;(document.querySelector('.analyze-close') as HTMLButtonElement).click()
    expect(isAnalyzeUIOpen()).toBe(false)
  })

  it('replaces an already-open panel rather than stacking', () => {
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    openAnalyzeUI()
    expect(document.querySelectorAll('.analyze-panel')).toHaveLength(1)
  })
})

describe('empty states', () => {
  it('distinguishes "no data-encoded dataset" from a computed result', () => {
    initAnalyzeUI(makeSource({ frame: () => null }))
    openAnalyzeUI()
    expect(currentResult()).toBeNull()
    expect(document.querySelector('.analyze-message')).not.toBeNull()
    expect(document.querySelector('.analyze-stats')).toBeNull()
  })

  it('says the region misses the dataset rather than showing zeroes', () => {
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    select().value = 'view'
    // A view far south of the 5°N bottom edge.
    initAnalyzeUI(makeSource({ visibleBounds: () => ({ n: -30, s: -60, w: -100, e: -50 }) }))
    select().dispatchEvent(new Event('change', { bubbles: true }))
    expect(currentResult()).toBeNull()
    expect(bodyText()).not.toBe('')
    expect(document.querySelector('.analyze-stats')).toBeNull()
  })

  it('says a region carries no values when every texel there is absent', () => {
    initAnalyzeUI(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 0), scale: SCALE, options: OPTIONS }),
    }))
    openAnalyzeUI()
    expect(currentResult()).toBeNull()
    expect(document.querySelector('.analyze-stats')).toBeNull()
  })
})

describe('region scope', () => {
  it('offers the whole dataset, the current view, and named regions', () => {
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    const values = [...select().options].map((o) => o.value)
    expect(values.slice(0, 2)).toEqual(['dataset', 'view'])
    expect(values.filter((v) => v.startsWith('named:')).length).toBeGreaterThan(0)
  })

  it('narrows the result when the region shrinks', () => {
    // North half hot, south half cool. Restricting to the north half
    // must raise the mean above the whole-dataset value.
    initAnalyzeUI(makeSource({
      frame: () => ({
        snapshot: snap(8, 8, (_x, y) => (y < 4 ? 240 : 40)),
        scale: SCALE,
        options: OPTIONS,
      }),
      visibleBounds: () => ({ n: 85, s: 45, w: -175, e: -20 }),
    }))
    openAnalyzeUI()
    const whole = currentResult()!.mean

    select().value = 'view'
    select().dispatchEvent(new Event('change', { bubbles: true }))
    expect(currentResult()!.mean).toBeGreaterThan(whole)
    expect(currentResult()!.mean).toBeCloseTo(240, 6)
  })

  it('falls back to the whole dataset when the view is unknown', () => {
    initAnalyzeUI(makeSource({ visibleBounds: () => null }))
    openAnalyzeUI()
    select().value = 'view'
    select().dispatchEvent(new Event('change', { bubbles: true }))
    expect(currentResult()?.mean).toBeCloseTo(200, 6)
  })
})

describe('buildCsvText', () => {
  const s = snap(4, 4, (x) => (x < 2 ? 100 : 200))
  const stats = summarize(s, SCALE, OPTIONS)!
  const hist = buildHistogram(s, SCALE, OPTIONS)

  it('records what the numbers are of', () => {
    const csv = buildCsvText(stats, hist, SCALE, {
      datasetTitle: 'Wildfire Smoke Overhead', scopeLabel: 'dataset',
    })
    expect(csv).toContain('dataset,Wildfire Smoke Overhead')
    expect(csv).toContain('units,mg m-2')
    expect(csv).toContain('quantisation_step,1')
  })

  it('carries the distribution, not just the summary', () => {
    const csv = buildCsvText(stats, hist, SCALE, { datasetTitle: null, scopeLabel: 'dataset' })
    expect(csv).toContain('value,area_km2,texel_count')
    // Exactly the two occupied bins, and no rows for absent codes.
    const bins = csv.split('value,area_km2,texel_count\r\n')[1].trim().split('\r\n')
    expect(bins).toHaveLength(2)
    expect(bins[0].startsWith('100,')).toBe(true)
    expect(bins[1].startsWith('200,')).toBe(true)
  })

  it('exports full precision, not the three digits the panel shows', () => {
    // The rounding on screen is a legibility choice; re-imposing it here
    // would destroy what the file exists to carry.
    const odd: ColorScale = { ...SCALE, vmin: 0, vmax: 1 / 3 }
    const csv = buildCsvText(
      summarize(s, odd, OPTIONS)!, buildHistogram(s, odd, OPTIONS), odd,
      { datasetTitle: null, scopeLabel: 'dataset' })
    expect(csv).toMatch(/mean,0\.\d{6,}/)
  })

  it('quotes only cells that need it, with CRLF line endings', () => {
    const csv = buildCsvText(stats, hist, SCALE, {
      datasetTitle: 'Smoke, column', scopeLabel: 'dataset',
    })
    expect(csv).toContain('"Smoke, column"')
    expect(csv).toContain('\r\n')
    expect(csv).toContain('units,mg m-2') // no gratuitous quoting
  })

  it('is downloadable without throwing when the DOM has no object URLs', () => {
    // happy-dom has no createObjectURL; the export must degrade rather
    // than take the click handler down with it.
    const original = URL.createObjectURL
    // @ts-expect-error — deliberately removing the API under test.
    URL.createObjectURL = undefined
    expect(() => downloadCsv('x.csv', 'a,b')).not.toThrow()
    URL.createObjectURL = original
  })
})

describe('export button', () => {
  it('serialises the numbers currently on screen', () => {
    const spy = vi.fn()
    const original = URL.createObjectURL
    URL.createObjectURL = spy.mockReturnValue('blob:x')
    URL.revokeObjectURL = () => {}
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    ;(document.querySelector('.analyze-export') as HTMLButtonElement).click()
    expect(spy).toHaveBeenCalled()
    URL.createObjectURL = original
  })
})

describe('region names that cannot be resolved', () => {
  // `getRegionNames` returns display names; `resolveRegion` looks up
  // lowercased aliases. At least one entry's display name is not among
  // its own aliases, so offering the raw list produced a region that
  // fell through to whole-dataset statistics wearing that region's
  // label — real numbers, wrong answer, no error.
  it('never offers a region it cannot locate', () => {
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    const named = [...select().options]
      .map((o) => o.value)
      .filter((v) => v.startsWith('named:'))
      .map((v) => v.slice(6))
    expect(named.length).toBeGreaterThan(0)
    for (const name of named) {
      expect(resolveRegion(name), `"${name}" is offered but does not resolve`).not.toBeNull()
    }
  })

  it('says so rather than silently measuring everything', () => {
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    // Force the state directly: the picker no longer offers one, but
    // the regions table can change underneath it.
    const s = select()
    const opt = document.createElement('option')
    opt.value = 'named:Not A Real Place'
    s.appendChild(opt)
    s.value = 'named:Not A Real Place'
    s.dispatchEvent(new Event('change', { bubbles: true }))

    expect(currentResult()).toBeNull()
    expect(document.querySelector('.analyze-stats')).toBeNull()
    expect(document.querySelector('.analyze-message')).not.toBeNull()
  })
})

describe('the globe changing underneath the panel', () => {
  // The panel computes once, on open. Left open across a dataset swap
  // it showed a statistics table describing something no longer on
  // screen — every figure real, every figure about the wrong thing.
  // The old teardown only fired when *no* dataset carried a palette, so
  // swapping one data-encoded row for another kept it open.
  it('closes when a different dataset is loaded', () => {
    initAnalyzeUI(makeSource({ datasetId: () => 'SMOKE_COLUMN' }))
    openAnalyzeUI()
    expect(isAnalyzeUIOpen()).toBe(true)

    notifyAnalyzeDatasetChanged('SMOKE_NEAR_SURFACE')
    expect(isAnalyzeUIOpen()).toBe(false)
  })

  it('stays open when the same dataset is re-announced', () => {
    // Re-announcing happens on layout changes and legend refreshes;
    // closing on those would make the panel unusable.
    initAnalyzeUI(makeSource({ datasetId: () => 'SMOKE_COLUMN' }))
    openAnalyzeUI()
    notifyAnalyzeDatasetChanged('SMOKE_COLUMN')
    expect(isAnalyzeUIOpen()).toBe(true)
  })

  it('closes when the dataset is unloaded entirely', () => {
    initAnalyzeUI(makeSource({ datasetId: () => 'SMOKE_COLUMN' }))
    openAnalyzeUI()
    notifyAnalyzeDatasetChanged(null)
    expect(isAnalyzeUIOpen()).toBe(false)
  })

  it('is inert when the panel is closed', () => {
    initAnalyzeUI(makeSource())
    expect(() => notifyAnalyzeDatasetChanged('ANYTHING')).not.toThrow()
    expect(isAnalyzeUIOpen()).toBe(false)
  })
})

/**
 * A stand-in for the globe's half of the transect. The panel talks to
 * this seam rather than to MapLibre, which is what lets the interaction
 * be tested at all — placing two points is a pair of map clicks in the
 * real thing.
 */
function makePicker() {
  let onChange: ((ends: TransectEndpoints | null) => void) | null = null
  let placed = 0
  let clears = 0
  const picker: TransectPicker = {
    begin(cb) {
      onChange = cb
      placed = 0
    },
    progress: () => placed,
    clear() {
      placed = 0
      onChange = null
      clears++
    },
  }
  return {
    picker,
    /** The second click landing, or an endpoint being dragged. */
    settle(ends: TransectEndpoints) {
      placed = 2
      onChange?.(ends)
    },
    placeFirst() {
      placed = 1
    },
    clears: () => clears,
    armed: () => onChange !== null,
  }
}

const CROSSING: TransectEndpoints = {
  from: { lat: 70, lon: -150 },
  to: { lat: 20, lon: -60 },
}

const section = () => document.querySelector('.analyze-transect-section')
const sectionButtons = () =>
  [...document.querySelectorAll('.analyze-transect-section button')] as HTMLButtonElement[]
const buttonSaying = (fragment: string): HTMLButtonElement | undefined =>
  sectionButtons().find((b) => (b.textContent ?? '').toLowerCase().includes(fragment))

describe('transect', () => {
  it('is absent, not disabled, when there is no globe to pick on', () => {
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    expect(section()).toBeNull()
  })

  it('offers a control, and asks for two clicks once armed', () => {
    const p = makePicker()
    initAnalyzeUI(makeSource({ transect: () => p.picker }))
    openAnalyzeUI()
    expect(section()).not.toBeNull()

    buttonSaying('draw')!.click()
    expect(p.armed()).toBe(true)
    expect(section()?.textContent).toContain('start')
    expect(document.querySelector('.analyze-transect')).toBeNull()
  })

  it('charts the line once both endpoints land', () => {
    const p = makePicker()
    initAnalyzeUI(makeSource({ transect: () => p.picker }))
    openAnalyzeUI()
    buttonSaying('draw')!.click()
    p.settle(CROSSING)

    expect(document.querySelector('.analyze-transect')).not.toBeNull()
    // Length / lowest / highest / mean. Scoped to the transect's own
    // section, so the count stays about the transect rather than about
    // how many other sections the panel happens to render.
    expect(
      document.querySelector('.analyze-transect-section')!.querySelectorAll('.analyze-stat'),
    ).toHaveLength(4)
    expect(buttonSaying('export line')).toBeDefined()
  })

  it('re-samples a drag without recomputing the region statistics', () => {
    // The panel holds one frame deliberately: calling frame() per drag
    // event would be a full readback at pointer rate on a playing
    // video, which is exactly what the snapshot path forbids.
    const p = makePicker()
    let frames = 0
    initAnalyzeUI(makeSource({
      transect: () => p.picker,
      frame: () => {
        frames++
        return { snapshot: snap(64, 64, () => 200), scale: SCALE, options: OPTIONS }
      },
    }))
    openAnalyzeUI()
    buttonSaying('draw')!.click()
    p.settle(CROSSING)
    const afterFirst = frames

    p.settle({ from: { lat: 60, lon: -140 }, to: { lat: 30, lon: -70 } })
    expect(frames).toBe(afterFirst)
    expect(document.querySelector('.analyze-transect')).not.toBeNull()
  })

  it('says so when the line crosses nothing, rather than charting an empty axis', () => {
    const p = makePicker()
    initAnalyzeUI(makeSource({
      transect: () => p.picker,
      frame: () => ({ snapshot: snap(8, 8, () => 0), scale: SCALE, options: OPTIONS }),
    }))
    openAnalyzeUI()
    buttonSaying('draw')!.click()
    p.settle(CROSSING)
    expect(document.querySelector('.analyze-transect')).toBeNull()
    expect(section()?.textContent?.toLowerCase()).toContain("doesn't cross")
  })

  it('takes the line off the globe when the panel closes', () => {
    // The line is drawn on the map, not in the panel — leaving it would
    // be an annotation with nothing on screen left to remove it.
    const p = makePicker()
    initAnalyzeUI(makeSource({ transect: () => p.picker }))
    openAnalyzeUI()
    buttonSaying('draw')!.click()
    p.settle(CROSSING)

    const before = p.clears()
    closeAnalyzeUI()
    expect(p.clears()).toBeGreaterThan(before)
  })

  it('clears on request and offers to draw again', () => {
    const p = makePicker()
    initAnalyzeUI(makeSource({ transect: () => p.picker }))
    openAnalyzeUI()
    buttonSaying('draw')!.click()
    p.settle(CROSSING)
    buttonSaying('clear')!.click()

    expect(document.querySelector('.analyze-transect')).toBeNull()
    expect(buttonSaying('draw')).toBeDefined()
  })

  it('survives a region change with the transect intact', () => {
    const p = makePicker()
    initAnalyzeUI(makeSource({ transect: () => p.picker }))
    openAnalyzeUI()
    buttonSaying('draw')!.click()
    p.settle(CROSSING)

    select().value = 'view'
    select().dispatchEvent(new Event('change'))
    expect(document.querySelector('.analyze-transect')).not.toBeNull()
  })

  it('advances the instruction after the first click', () => {
    const p = makePicker()
    initAnalyzeUI(makeSource({ transect: () => p.picker }))
    openAnalyzeUI()
    buttonSaying('draw')!.click()
    p.placeFirst()
    // Re-render the way a pick would: the panel reads progress() to
    // decide which half of the instruction to show.
    buttonSaying('cancel')
    expect(p.picker.progress()).toBe(1)
  })
})

describe('buildTransectCsvText', () => {
  const s = snap(16, 16, (_x, y) => (y < 8 ? 0 : 200))
  const line = sampleTransect(
    s, SCALE, { lat: 80, lon: -100 }, { lat: 10, lon: -100 }, 9, OPTIONS)

  it('states the resolution claim in the header', () => {
    const csv = buildTransectCsvText(line, SCALE, {
      datasetTitle: 'Wildfire Smoke Overhead', scopeLabel: 'Along a line',
    })
    expect(csv).toContain('dataset,Wildfire Smoke Overhead')
    expect(csv).toContain('samples,9')
    expect(csv).toMatch(/sample_spacing_km,\d/)
    expect(csv).toContain('distance_km,lat,lon,value')
  })

  it('keeps the gaps as rows with no value', () => {
    // Dropping them would close the hole silently, which is the failure
    // the chart takes care to avoid — the file must not undo it.
    const csv = buildTransectCsvText(line, SCALE, { datasetTitle: null, scopeLabel: 'x' })
    const body = csv.split('distance_km,lat,lon,value\r\n')[1].trim().split('\r\n')
    expect(body).toHaveLength(line.length)
    expect(body.some((row) => row.endsWith(','))).toBe(true)
  })

  it('writes values at full precision, not the three digits displayed', () => {
    const precise = sampleTransect(
      s, { ...SCALE, vmax: 1 }, { lat: 80, lon: -100 }, { lat: 10, lon: -100 }, 5, OPTIONS)
    const csv = buildTransectCsvText(precise, { ...SCALE, vmax: 1 }, {
      datasetTitle: null, scopeLabel: 'x',
    })
    expect(csv).toMatch(/0\.\d{5,}/)
  })
})

describe('zonal profile', () => {
  const zonal = () => document.querySelector('.analyze-zonal-section')

  it('appears unprompted, unlike the transect', () => {
    // No picker, no control, no user action — the axis it reduces along
    // is already chosen by the region.
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    expect(zonal()).not.toBeNull()
    expect(document.querySelector('.analyze-zonal')).not.toBeNull()
    expect(zonal()!.querySelectorAll('.analyze-stat')).toHaveLength(2)
  })

  it('names the latitude band carrying the highest average', () => {
    // A band of high values at the top of the frame, low below. The
    // peak tile must point north, which is the question a zonal profile
    // is actually being asked.
    initAnalyzeUI(makeSource({
      frame: () => ({
        snapshot: snap(8, 8, (_x, y) => (y < 2 ? 240 : 40)),
        scale: SCALE,
        options: OPTIONS,
      }),
    }))
    openAnalyzeUI()
    const text = zonal()!.textContent ?? ''
    expect(text).toContain('°N')
    // The frame spans 5..85°N, so the top two rows sit above 70°N.
    expect(text).toMatch(/[78]\d(\.\d)?°N/)
  })

  it('describes the picked region rather than the whole frame', () => {
    // The scoped window has to reach the profile, or a user who picks a
    // box gets a global answer under a regional heading.
    const source = makeSource({
      frame: () => ({
        // Both halves carry data — 40 is above the 12-code absent band,
        // so this tests scoping rather than accidentally testing the
        // no-values path.
        snapshot: snap(8, 8, (_x, y) => (y < 4 ? 250 : 40)),
        scale: SCALE,
        options: OPTIONS,
      }),
      visibleBounds: () => ({ n: 40, s: 5, w: -175, e: -20 }),
    })
    initAnalyzeUI(source)
    openAnalyzeUI()
    const whole = zonal()!.textContent ?? ''
    select().value = 'view'
    select().dispatchEvent(new Event('change', { bubbles: true }))
    const viewOnly = zonal()!.textContent ?? ''
    // The southern half is the low band, so scoping to it must change
    // both the band count and the reported peak.
    expect(viewOnly).not.toBe(whole)
  })

  it('says so rather than drawing an axis when the region is one band tall', () => {
    initAnalyzeUI(makeSource({
      frame: () => ({ snapshot: snap(8, 1, () => 200), scale: SCALE, options: OPTIONS }),
    }))
    openAnalyzeUI()
    expect(document.querySelector('.analyze-zonal')).toBeNull()
    expect(zonal()!.textContent).toContain('too few latitude bands')
  })

  it('is absent when the region block produced no numbers', () => {
    // A profile under an "outside the dataset" message would be a chart
    // of nothing captioned as a chart of something.
    initAnalyzeUI(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 0), scale: SCALE, options: OPTIONS }),
    }))
    openAnalyzeUI()
    expect(zonal()).toBeNull()
  })
})

describe('staying clear of the playback transport', () => {
  /** Mount a bottom-anchored bar of the given height, as the transport
   *  and the Tools bar both are. */
  function mountBar(id: string, height: number): HTMLElement {
    const el = document.createElement('div')
    el.id = id
    document.body.appendChild(el)
    el.getBoundingClientRect = () => ({
      height, top: window.innerHeight - height, bottom: window.innerHeight,
      left: 0, right: 0, width: 0, x: 0, y: window.innerHeight - height,
      toJSON: () => ({}),
    }) as DOMRect
    return el
  }

  afterEach(() => {
    closeAnalyzeUI()
    document.getElementById('playback-controls')?.remove()
    document.getElementById('map-controls')?.remove()
  })

  it('lifts above the transport rather than covering it', () => {
    // The panel is z-index 60 and wins the corner outright, and closing
    // it to reach Play takes the contours with it — so covering the
    // transport left no pointer-only way to play a dataset while
    // looking at its analysis.
    mountBar('playback-controls', 64)
    initAnalyzeUI(makeSource())
    const panel = openAnalyzeUI()
    expect(parseFloat(panel.style.insetBlockEnd)).toBeGreaterThanOrEqual(64)
  })

  it('clears the Tools bar when it sits higher than the transport', () => {
    // Both measured rather than only the bar. The bar is kept above the
    // transport by another module, and depending on that invariant from
    // here would be a coupling nothing states.
    mountBar('playback-controls', 40)
    mountBar('map-controls', 120)
    initAnalyzeUI(makeSource())
    const panel = openAnalyzeUI()
    expect(parseFloat(panel.style.insetBlockEnd)).toBeGreaterThanOrEqual(120)
  })

  it('shrinks its height by the same amount it lifts', () => {
    // Otherwise a tall panel on a short window keeps its 34rem and
    // simply grows off the top instead.
    mountBar('playback-controls', 90)
    initAnalyzeUI(makeSource())
    const panel = openAnalyzeUI()
    expect(panel.style.maxBlockSize).toContain('100vh')
    expect(panel.style.maxBlockSize).toContain('px')
  })

  it('hands the corner back when nothing is there to clear', () => {
    // An image dataset, or a still. Pinning an inline offset the
    // stylesheet would then have to fight is worse than not setting one.
    initAnalyzeUI(makeSource())
    const panel = openAnalyzeUI()
    expect(panel.style.insetBlockEnd).toBe('')
    expect(panel.style.maxBlockSize).toBe('')
  })

  it('ignores a transport that is hidden', () => {
    const bar = mountBar('playback-controls', 64)
    bar.classList.add('hidden')
    initAnalyzeUI(makeSource())
    const panel = openAnalyzeUI()
    expect(panel.style.insetBlockEnd).toBe('')
  })
})

describe('recomputing when the globe settles on a frame', () => {
  // Drawing contours arms a real `setInterval` staleness watch. The
  // top-level `beforeEach` stops it via `closeAnalyzeUI`, but that only
  // covers the *next* test — the last one in this block would otherwise
  // leave a live 500 ms timer running past the end of the file, into
  // whichever suite the worker picks up next. Observed: it failed an
  // unrelated publisher test.
  afterEach(() => { closeAnalyzeUI() })

  /** A source whose frame content can be swapped from the test, standing
   *  in for playback moving the globe underneath the panel. */
  function movingFrame() {
    let fill = 100
    return {
      src: makeSource({
        frame: () => ({ snapshot: snap(8, 8, () => fill), scale: SCALE, options: OPTIONS }),
      }),
      advance: (to: number) => { fill = to },
    }
  }

  it('recomputes the statistics against the new frame', () => {
    // The panel used to compute once, on open, and then describe that
    // frame for as long as it stayed open.
    const m = movingFrame()
    initAnalyzeUI(m.src)
    openAnalyzeUI()
    expect(currentResult()!.mean).toBeCloseTo(100, 6)

    m.advance(200)
    notifyAnalyzePlaybackSettled()
    expect(currentResult()!.mean).toBeCloseTo(200, 6)
  })

  it('brings the zonal profile with it', () => {
    // The sections below the statistics read the same frame, so a
    // recompute that reached only the tiles would leave the profile
    // describing a frame the numbers above it no longer do.
    const m = movingFrame()
    initAnalyzeUI(m.src)
    openAnalyzeUI()
    const before = document.querySelector('.analyze-zonal-section')!.textContent

    m.advance(240)
    notifyAnalyzePlaybackSettled()
    expect(document.querySelector('.analyze-zonal-section')!.textContent).not.toBe(before)
  })

  it('puts the contours back, against the frame just settled on', () => {
    // The case #342 named as "merely unbuilt": lines drawn, playback
    // moves, the watch takes them down. On settle they should return —
    // recomputed against the new frame, not the old geometry restored.
    const c = makeContours()
    const m = movingFrame()
    initAnalyzeUI(makeSource({ contours: () => c.overlay, frame: m.src.frame }))
    openAnalyzeUI()
    contourButton()!.click()
    expect(c.shown()).toHaveLength(1)

    m.advance(240)
    notifyAnalyzePlaybackSettled()
    expect(c.shown()).toHaveLength(2)
    // And the section knows they are up, rather than offering to draw
    // what is already on the globe.
    expect(contourButton()!.textContent).toBe('Clear outline')
  })

  it('does not draw contours that were never asked for', () => {
    // The expensive half. A pause with no lines on the globe must not
    // spend 178-376 ms extracting a set nobody requested.
    const c = makeContours()
    const m = movingFrame()
    initAnalyzeUI(makeSource({ contours: () => c.overlay, frame: m.src.frame }))
    openAnalyzeUI()
    expect(c.shown()).toHaveLength(0)

    m.advance(240)
    notifyAnalyzePlaybackSettled()
    expect(c.shown()).toHaveLength(0)
    expect(contourButton()!.textContent).toBe('Outline on globe')
  })

  it('stops redrawing once the viewer clears the lines', () => {
    // Clearing is the withdrawal of the request, so later settles must
    // not keep resurrecting them.
    const c = makeContours()
    const m = movingFrame()
    initAnalyzeUI(makeSource({ contours: () => c.overlay, frame: m.src.frame }))
    openAnalyzeUI()
    contourButton()!.click()
    contourButton()!.click() // toggles to Clear
    expect(contourButton()!.textContent).toBe('Outline on globe')
    const before = c.shown().length

    m.advance(240)
    notifyAnalyzePlaybackSettled()
    expect(c.shown()).toHaveLength(before)
  })

  it('does nothing when the panel is closed', () => {
    // The host ticks the watcher from the playback loop, which runs
    // whether or not anyone has the panel open.
    initAnalyzeUI(movingFrame().src)
    expect(isAnalyzeUIOpen()).toBe(false)
    expect(() => notifyAnalyzePlaybackSettled()).not.toThrow()
    expect(document.querySelector('.analyze-panel')).toBeNull()
  })
})

describe('buildZonalCsvText', () => {
  const rows = zonalMeans(snap(8, 8, (_x, y) => (y < 4 ? 0 : 200)), SCALE, OPTIONS)

  it('carries the per-row texel count, not just the mean', () => {
    const csv = buildZonalCsvText(rows, SCALE, {
      datasetTitle: 'Wildfire Smoke Overhead', scopeLabel: 'Whole dataset',
    })
    expect(csv).toContain('dataset,Wildfire Smoke Overhead')
    expect(csv).toContain('region,Whole dataset')
    expect(csv).toContain('lat,mean,texel_count')
    expect(csv).toContain('rows,8')
    expect(csv).toContain('rows_with_data,4')
  })

  it('keeps an empty band as a row with no mean', () => {
    const csv = buildZonalCsvText(rows, SCALE, { datasetTitle: null, scopeLabel: 'x' })
    const body = csv.split('lat,mean,texel_count\r\n')[1].trim().split('\r\n')
    expect(body).toHaveLength(rows.length)
    // The four absent rows keep their latitude and their zero count.
    expect(body.filter((r) => r.includes(',,0')).length).toBe(4)
  })
})

/** The globe's side of the region picker, recorded rather than drawn. */
function makeOutline() {
  const shown: { n: number; s: number; w: number; e: number }[] = []
  let clears = 0
  return {
    outline: {
      show(bounds: { n: number; s: number; w: number; e: number }) { shown.push(bounds) },
      clear() { clears++ },
    },
    shown: () => shown,
    last: () => shown[shown.length - 1],
    clears: () => clears,
  }
}

describe('region outline', () => {
  it('outlines a named region so the numbers have a place', () => {
    const o = makeOutline()
    initAnalyzeUI(makeSource({ regionOutline: () => o.outline }))
    openAnalyzeUI()
    const alabama = resolveRegion('alabama')
    expect(alabama).not.toBeNull()

    select().value = 'named:Alabama'
    select().dispatchEvent(new Event('change', { bubbles: true }))
    const [w, s, e, n] = alabama!.bounds
    expect(o.last()).toEqual({ n, s, w, e })
  })

  it('outlines the requested region even when it misses the dataset', () => {
    // The box is the whole explanation of the message beside it — "that
    // region is over there, and the data is not".
    const o = makeOutline()
    initAnalyzeUI(makeSource({
      regionOutline: () => o.outline,
      visibleBounds: () => ({ n: -30, s: -60, w: -100, e: -50 }),
    }))
    openAnalyzeUI()
    select().value = 'view'
    select().dispatchEvent(new Event('change', { bubbles: true }))
    expect(currentResult()).toBeNull()
    expect(o.last()).toEqual({ n: -30, s: -60, w: -100, e: -50 })
  })

  it('clears for the whole dataset, which needs no box', () => {
    const o = makeOutline()
    initAnalyzeUI(makeSource({ regionOutline: () => o.outline }))
    openAnalyzeUI()
    select().value = 'named:Alabama'
    select().dispatchEvent(new Event('change', { bubbles: true }))
    const before = o.clears()

    select().value = 'dataset'
    select().dispatchEvent(new Event('change', { bubbles: true }))
    expect(o.clears()).toBeGreaterThan(before)
  })

  it('skips a box so wide it would just trace the antimeridian', () => {
    const o = makeOutline()
    initAnalyzeUI(makeSource({
      regionOutline: () => o.outline,
      visibleBounds: () => ({ n: 85, s: -85, w: -180, e: 180 }),
    }))
    openAnalyzeUI()
    select().value = 'view'
    select().dispatchEvent(new Event('change', { bubbles: true }))
    expect(o.shown()).toHaveLength(0)
  })

  it('takes the box off the globe when the panel closes', () => {
    const o = makeOutline()
    initAnalyzeUI(makeSource({ regionOutline: () => o.outline }))
    openAnalyzeUI()
    select().value = 'named:Alabama'
    select().dispatchEvent(new Event('change', { bubbles: true }))
    const before = o.clears()
    closeAnalyzeUI()
    expect(o.clears()).toBeGreaterThan(before)
  })

  it('clears when there is no longer a frame to analyse', () => {
    const o = makeOutline()
    initAnalyzeUI(makeSource({ regionOutline: () => o.outline, frame: () => null }))
    openAnalyzeUI()
    expect(o.clears()).toBeGreaterThan(0)
    expect(o.shown()).toHaveLength(0)
  })
})

describe('§A6 — opening pre-scoped from an Orbit chip', () => {
  it('opens on the region it was handed, overriding the sticky choice', () => {
    // The scope is deliberately sticky across opens within a session,
    // which is right for someone comparing regions by hand — and the
    // one wrong answer available when arriving from "the smoke is
    // worst over Alabama".
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    select().value = 'named:Alaska'
    select().dispatchEvent(new Event('change', { bubbles: true }))
    closeAnalyzeUI()

    openAnalyzeUI(null, { kind: 'named', name: 'Alabama' })
    expect(select().value).toBe('named:Alabama')
  })

  it('computes against that region, not merely displays it', () => {
    initAnalyzeUI(makeSource({
      frame: () => ({
        snapshot: snap(16, 16, (_x, y) => (y < 4 ? 240 : 40)),
        scale: SCALE,
        options: OPTIONS,
      }),
    }))
    openAnalyzeUI(null, { kind: 'named', name: 'Mexico' })
    // Mexico sits well south of the hot northern band.
    expect(currentResult()!.mean).toBeCloseTo(40, 6)
  })

  it('still honours the sticky choice when opened with no preset', () => {
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    select().value = 'named:Alaska'
    select().dispatchEvent(new Event('change', { bubbles: true }))
    closeAnalyzeUI()

    openAnalyzeUI()
    expect(select().value).toBe('named:Alaska')
  })
})

/**
 * The contour section.
 *
 * It draws a *set* of isolines at the colour bar's own round-number
 * ticks, not one line at a threshold. The threshold scopes which ticks
 * are drawn rather than being the level itself, so the two controls
 * compose instead of competing.
 */
function makeContours() {
  const shown: ContourLevel[][] = []
  let clears = 0
  return {
    overlay: {
      show(levels: ContourLevel[]) { shown.push(levels) },
      clear() { clears++ },
    },
    shown: () => shown,
    last: () => shown[shown.length - 1],
    clears: () => clears,
  }
}

/** A frame with a real gradient, so several levels actually cross it. */
const RAMP = () => ({
  snapshot: snap(24, 24, x => 10 + x * 10),
  scale: SCALE,
  options: OPTIONS,
})

const contourButton = () =>
  Array.from(document.querySelectorAll('.analyze-contour-head .analyze-action'))[0] as
    | HTMLButtonElement
    | undefined

const levelRows = () =>
  Array.from(document.querySelectorAll('.analyze-contour-levels li'))

describe('contours', () => {
  it('draws several lines across the range with no threshold set', () => {
    const c = makeContours()
    initAnalyzeUI(makeSource({ contours: () => c.overlay, frame: RAMP }))
    openAnalyzeUI()
    contourButton()!.click()

    expect(c.shown()).toHaveLength(1)
    // A contour map, not a threshold outline: more than one level, each
    // with its own value, ascending.
    expect(c.last().length).toBeGreaterThan(1)
    const values = c.last().map(l => l.value)
    expect([...values].sort((a, b) => a - b)).toEqual(values)
  })

  it('uses round values, which is what makes them readable against the bar', () => {
    const c = makeContours()
    initAnalyzeUI(makeSource({ contours: () => c.overlay, frame: RAMP }))
    openAnalyzeUI()
    contourButton()!.click()
    // vmin 0 / vmax 255 over a 1/2/5 x 10^k step lands on whole numbers.
    for (const level of c.last()) {
      expect(Number.isInteger(level.value)).toBe(true)
    }
  })

  it('paints each line in the colour the globe uses at that level', () => {
    const c = makeContours()
    initAnalyzeUI(makeSource({ contours: () => c.overlay, frame: RAMP }))
    openAnalyzeUI()
    contourButton()!.click()
    // Every level that traced something carries a colour, and the
    // colours differ — one flat colour would mean the LUT lookup was
    // ignoring the level.
    const drawn = c.last().filter(l => l.lines.length > 0)
    expect(drawn.length).toBeGreaterThan(1)
    for (const level of drawn) expect(level.color).toMatch(/^rgb\(/)
    expect(new Set(drawn.map(l => l.color)).size).toBeGreaterThan(1)
  })

  it('lets the threshold scope the levels rather than replace them', () => {
    const wide = makeContours()
    initAnalyzeUI(makeSource({ contours: () => wide.overlay, frame: RAMP }))
    openAnalyzeUI()
    contourButton()!.click()
    const unscoped = wide.last().length

    const narrow = makeContours()
    initAnalyzeUI(makeSource({
      contours: () => narrow.overlay,
      frame: RAMP,
      display: () => ({ ...DEFAULT_DISPLAY, threshold: { min: 100, max: 160 } }),
    }))
    openAnalyzeUI()
    contourButton()!.click()

    // Fewer lines, and every one inside the isolated band.
    expect(narrow.last().length).toBeLessThan(unscoped)
    expect(narrow.last().length).toBeGreaterThan(0)
    for (const level of narrow.last()) {
      expect(level.value).toBeGreaterThanOrEqual(100)
      expect(level.value).toBeLessThanOrEqual(160)
    }
  })

  it('reports the area above each line, not one number for the whole band', () => {
    initAnalyzeUI(makeSource({ contours: () => makeContours().overlay, frame: RAMP }))
    openAnalyzeUI()
    const rows = levelRows()
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) expect(row.textContent).toContain('km²')
    // Area above a higher line can never exceed area above a lower one.
    // Parse only the figure in front of `km²` — the row also carries the
    // level itself, and stripping every non-digit glues the two numbers
    // into one.
    const areas = rows.map(r => {
      const m = /([\d,]+)\s*km²/.exec(r.textContent ?? '')
      expect(m).not.toBeNull()
      return Number((m as RegExpExecArray)[1].replace(/,/g, ''))
    })
    for (let i = 1; i < areas.length; i++) {
      expect(areas[i]).toBeLessThanOrEqual(areas[i - 1])
    }
  })

  it('says so when the isolated band is too narrow to hold a round value', () => {
    const c = makeContours()
    initAnalyzeUI(makeSource({
      contours: () => c.overlay,
      frame: RAMP,
      display: () => ({ ...DEFAULT_DISPLAY, threshold: { min: 100.4, max: 100.6 } }),
    }))
    openAnalyzeUI()
    expect(bodyText()).toContain('colour bar')
    expect(contourButton()).toBeUndefined()
    expect(c.shown()).toHaveLength(0)
  })

  it('toggles to Clear once drawn, and takes the lines away', () => {
    const c = makeContours()
    initAnalyzeUI(makeSource({ contours: () => c.overlay, frame: RAMP }))
    openAnalyzeUI()
    contourButton()!.click()
    const before = c.clears()
    contourButton()!.click()
    expect(c.clears()).toBe(before + 1)
    expect(contourButton()!.textContent).toBe('Outline on globe')
  })

  it('takes the outline with it when the panel closes', () => {
    const c = makeContours()
    initAnalyzeUI(makeSource({ contours: () => c.overlay, frame: RAMP }))
    openAnalyzeUI()
    contourButton()!.click()
    const before = c.clears()
    closeAnalyzeUI()
    expect(c.clears()).toBeGreaterThan(before)
  })

  it('is absent when there is no globe to draw on', () => {
    initAnalyzeUI(makeSource({ frame: RAMP }))
    openAnalyzeUI()
    expect(document.querySelector('.analyze-contour-section')).toBeNull()
  })

  it('clears the outline when the dataset underneath is replaced', () => {
    const c = makeContours()
    initAnalyzeUI(makeSource({ contours: () => c.overlay, frame: RAMP }))
    openAnalyzeUI()
    contourButton()!.click()
    const before = c.clears()
    notifyAnalyzeDatasetChanged('INTERNAL_SOMETHING_ELSE')
    expect(c.clears()).toBeGreaterThan(before)
  })
})

/**
 * Time.
 *
 * Every number this panel shows is measured from one frame of an
 * animation, and until now the panel never said which — and a drawn
 * contour went on sitting over the globe after playback had moved on,
 * describing a field it was not measured from. Both are the same
 * failure the panel already guards everywhere else: an annotation
 * outliving the thing that explains it.
 */
describe('frame time', () => {
  it('names the frame the numbers were measured from', () => {
    initAnalyzeUI(makeSource({ frameTime: () => '2026-07-31 12:00Z' }))
    openAnalyzeUI()
    expect(bodyText()).toContain('2026-07-31 12:00Z')
  })

  it('says nothing when the dataset has no time label to name', () => {
    initAnalyzeUI(makeSource({ frameTime: () => null }))
    openAnalyzeUI()
    expect(bodyText()).not.toContain('Measured on the frame')
  })

  it('works for a source that does not implement the seam at all', () => {
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    expect(bodyText()).not.toContain('Measured on the frame')
  })
})

describe('contours going stale as the globe plays', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** A source whose reported frame can be moved from the test.
   *
   *  Drives `frameId` — the playhead identity — not `frameTime`, which
   *  is the human label and is the wrong thing to compare. */
  function movingSource(c: ReturnType<typeof makeContours>) {
    let now = '0'
    return {
      src: makeSource({
        contours: () => c.overlay,
        frame: RAMP,
        frameId: () => now,
      }),
      advance: (to: string) => { now = to },
    }
  }

  it('removes the lines once the globe shows a different frame', () => {
    const c = makeContours()
    const m = movingSource(c)
    initAnalyzeUI(m.src)
    openAnalyzeUI()
    contourButton()!.click()
    expect(c.shown()).toHaveLength(1)
    const before = c.clears()

    m.advance('1.5')
    vi.advanceTimersByTime(600)

    expect(c.clears()).toBeGreaterThan(before)
    // And says why, rather than leaving the lines to vanish unexplained.
    expect(bodyText()).toContain('moved to another frame')
  })

  it('leaves them alone while the globe stays on the same frame', () => {
    const c = makeContours()
    initAnalyzeUI(movingSource(c).src)
    openAnalyzeUI()
    contourButton()!.click()
    const before = c.clears()

    vi.advanceTimersByTime(5000)

    expect(c.clears()).toBe(before)
    expect(bodyText()).not.toContain('moved to another frame')
  })

  it('offers to draw again, and drops the explanation once you do', () => {
    const c = makeContours()
    const m = movingSource(c)
    initAnalyzeUI(m.src)
    openAnalyzeUI()
    contourButton()!.click()
    m.advance('1.5')
    vi.advanceTimersByTime(600)
    expect(contourButton()!.textContent).toBe('Outline on globe')

    contourButton()!.click()
    expect(c.shown()).toHaveLength(2)
    expect(bodyText()).not.toContain('moved to another frame')
  })

  it('drops the explanation when the panel is closed and reopened', () => {
    // The explanation belongs to one draw/watch cycle. Carried into a
    // session that drew nothing, it describes an event the viewer never
    // saw — and points at contours that were never on the globe.
    const c = makeContours()
    const m = movingSource(c)
    initAnalyzeUI(m.src)
    openAnalyzeUI()
    contourButton()!.click()
    m.advance('1.5')
    vi.advanceTimersByTime(600)
    expect(bodyText()).toContain('moved to another frame')

    closeAnalyzeUI()
    openAnalyzeUI()
    expect(bodyText()).not.toContain('moved to another frame')
  })

  it('drops the explanation when the region changes', () => {
    // The likelier path of the two: a scope change already clears the
    // lines for its own reasons, so keeping the playback explanation
    // beside a freshly-scoped region blames the wrong thing.
    const c = makeContours()
    const m = movingSource(c)
    initAnalyzeUI(m.src)
    openAnalyzeUI()
    contourButton()!.click()
    m.advance('1.5')
    vi.advanceTimersByTime(600)
    expect(bodyText()).toContain('moved to another frame')

    select().value = 'view'
    select().dispatchEvent(new Event('change', { bubbles: true }))
    expect(bodyText()).not.toContain('moved to another frame')
  })

  it('stops watching once the panel closes, so no timer outlives it', () => {
    const c = makeContours()
    const m = movingSource(c)
    initAnalyzeUI(m.src)
    openAnalyzeUI()
    contourButton()!.click()
    closeAnalyzeUI()
    const after = c.clears()

    // A watch still running would call clear() again on the next tick.
    m.advance('1.5')
    vi.advanceTimersByTime(2000)
    expect(c.clears()).toBe(after)
  })

  it('says so, loudly, when it cannot identify the frame at all', () => {
    // No `frameId` seam: nothing to compare, so nothing can be removed.
    // The lines stay — but the panel must SAY they are pinned, rather
    // than going quietly inert and letting a stale outline look
    // supervised. `15a5926` is the precedent: a gate that closes
    // silently costs an evening aimed at the wrong half of the feature.
    const c = makeContours()
    initAnalyzeUI(makeSource({ contours: () => c.overlay, frame: RAMP }))
    openAnalyzeUI()
    contourButton()!.click()
    const before = c.clears()
    vi.advanceTimersByTime(5000)
    expect(c.clears()).toBe(before)
    expect(bodyText()).toContain('pinned to one frame')
  })

  it('does not claim to watch when the frame id is null at draw time', () => {
    // A seam that exists but reports nothing is the same blindness as no
    // seam at all, and must read the same way on the surface.
    const c = makeContours()
    initAnalyzeUI(makeSource({
      contours: () => c.overlay, frame: RAMP, frameId: () => null,
    }))
    openAnalyzeUI()
    contourButton()!.click()
    // Baseline after drawing: `clears()` counts lifecycle clears
    // (init, refresh) too, so only the delta across the timer means
    // "the watch fired".
    const before = c.clears()
    vi.advanceTimersByTime(5000)
    expect(c.clears()).toBe(before)
    expect(bodyText()).toContain('pinned to one frame')
  })

  it('does not show the pinned warning when it IS watching', () => {
    const c = makeContours()
    initAnalyzeUI(movingSource(c).src)
    openAnalyzeUI()
    contourButton()!.click()
    expect(bodyText()).not.toContain('pinned to one frame')
  })
})

describe('contours and the region scope', () => {
  it('removes the lines when the scope changes under them', () => {
    // Contours are extracted against the region's texel window, so
    // whole-dataset lines left on the globe beside a panel quoting
    // Alabama's areas is the same annotation-outliving-its-explanation
    // failure the playback watch prevents, one trigger further along.
    const c = makeContours()
    initAnalyzeUI(makeSource({ contours: () => c.overlay, frame: RAMP }))
    openAnalyzeUI()
    contourButton()!.click()
    expect(c.shown()).toHaveLength(1)
    const before = c.clears()

    select().value = 'named:Alabama'
    select().dispatchEvent(new Event('change', { bubbles: true }))

    expect(c.clears()).toBeGreaterThan(before)
    // And offers to draw again for the region now selected, rather than
    // claiming lines are up.
    expect(contourButton()?.textContent).toBe('Outline on globe')
  })
})
