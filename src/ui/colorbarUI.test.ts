// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the colorbar surface.
 *
 * The layering assertion below exists because the checkerboard behind
 * the ramp has already been lost twice in one change: once to a
 * `background-image` declaration carrying `<position> / <size>`, which
 * is `background` shorthand syntax and silently drops the whole
 * declaration, and once to an inline `backgroundImage` assignment that
 * replaced the stylesheet's layer instead of stacking on it. Both are
 * invisible in review and invisible on screen unless a threshold is
 * active, which is the one time the checker matters.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { renderColorbar, openDisplayControls, closeDisplayControls } from './colorbarUI'
import { DEFAULT_DISPLAY, type ColorScaleDisplay } from '../services/colorScaleDisplay'
import type { ColorScale } from '../types/color-scale'

const SCALE: ColorScale = {
  stops: [
    { t: 0, rgba: [255, 255, 229, 0] },
    { t: 1, rgba: [102, 37, 6, 255] },
  ],
  vmin: 0,
  vmax: 0.0005,
  units: 'kg m-2',
  transparentRange: 12 / 256,
}

const display = (over: Partial<ColorScaleDisplay> = {}): ColorScaleDisplay => ({
  ...DEFAULT_DISPLAY,
  ...over,
  stretch: { ...DEFAULT_DISPLAY.stretch, ...over.stretch },
  threshold: { ...DEFAULT_DISPLAY.threshold, ...over.threshold },
})

beforeEach(() => {
  closeDisplayControls()
  document.body.innerHTML = ''
})

describe('renderColorbar', () => {
  it('layers the ramp over the checkerboard rather than replacing it', () => {
    const el = renderColorbar({ scale: SCALE, display: DEFAULT_DISPLAY })
    const gradient = el.querySelector('.panel-colorbar-gradient') as HTMLElement
    // Only the ramp is set inline. `background-image` itself must stay
    // untouched so the stylesheet keeps composing ramp-over-checker;
    // assigning it here is exactly the regression this guards.
    expect(gradient.style.getPropertyValue('--colorbar-ramp')).toContain('linear-gradient')
    expect(gradient.style.backgroundImage).toBe('')
  })

  it('renders as a button only when it can be opened', () => {
    expect(renderColorbar({ scale: SCALE, display: DEFAULT_DISPLAY }).tagName).toBe('DIV')
    const interactive = renderColorbar({
      scale: SCALE, display: DEFAULT_DISPLAY, onOpen: () => {},
    })
    expect(interactive.tagName).toBe('BUTTON')
  })

  it('calls onOpen when tapped', () => {
    let opened = 0
    const el = renderColorbar({
      scale: SCALE, display: DEFAULT_DISPLAY, onOpen: () => { opened++ },
    })
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(opened).toBe(1)
  })

  it('carries the range in the accessible name, since the ticks read as loose digits', () => {
    const el = renderColorbar({ scale: SCALE, display: DEFAULT_DISPLAY, title: 'Smoke' })
    const label = el.getAttribute('aria-label') ?? ''
    expect(label).toContain('Smoke')
    expect(label).toContain('kg m-2')
  })

  it('shows the units once, outside the ticks', () => {
    const el = renderColorbar({ scale: SCALE, display: DEFAULT_DISPLAY })
    expect(el.querySelector('.panel-colorbar-units')?.textContent).toBe('kg m-2')
    const noUnits = renderColorbar({
      scale: { ...SCALE, units: undefined }, display: DEFAULT_DISPLAY,
    })
    expect(noUnits.querySelector('.panel-colorbar-units')).toBeNull()
  })

  it('reports the stretched sub-range, not the full extent', () => {
    // A bar that kept showing the dataset's full range while the globe
    // showed a tenth of it would be a lie in the most authoritative
    // place on screen.
    const el = renderColorbar({
      scale: SCALE, display: display({ stretch: { lo: 0, hi: 0.5 } }),
    })
    const ticks = [...el.querySelectorAll('.panel-colorbar-tick')].map((n) => n.textContent)
    expect(ticks.length).toBeGreaterThan(0)
    // Half of 5e-4 is 2.5e-4, so nothing above that can be labelled.
    for (const label of ticks) {
      expect(Number(label)).toBeLessThanOrEqual(0.00025 + 1e-12)
    }
  })
})

describe('openDisplayControls', () => {
  it('mounts one popover and replaces any already open', () => {
    openDisplayControls({ scale: SCALE, display: DEFAULT_DISPLAY, onChange: () => {} })
    openDisplayControls({ scale: SCALE, display: DEFAULT_DISPLAY, onChange: () => {} })
    expect(document.querySelectorAll('.colorbar-controls')).toHaveLength(1)
  })

  it('offers every palette, with the active one checked', () => {
    openDisplayControls({
      scale: SCALE, display: display({ palette: 'viridis' }), onChange: () => {},
    })
    const swatches = [...document.querySelectorAll('.colorbar-palette-swatch')]
    expect(swatches).toHaveLength(5)
    const checked = swatches.filter((s) => s.getAttribute('aria-checked') === 'true')
    expect(checked).toHaveLength(1)
  })

  it('writes a palette choice through immediately, with no Apply step', () => {
    const seen: ColorScaleDisplay[] = []
    openDisplayControls({
      scale: SCALE, display: DEFAULT_DISPLAY, onChange: (d) => seen.push(d),
    })
    const viridis = [...document.querySelectorAll('.colorbar-palette-swatch')]
      .find((s) => s.textContent === 'Viridis') as HTMLButtonElement
    viridis.click()
    expect(seen).toHaveLength(1)
    expect(seen[0].palette).toBe('viridis')
  })

  it('treats a slider parked at its end as no bound at all', () => {
    // Otherwise resetting a threshold to its extreme would leave a
    // constraint in place that the UI shows as absent.
    const seen: ColorScaleDisplay[] = []
    openDisplayControls({
      scale: SCALE, display: DEFAULT_DISPLAY, onChange: (d) => seen.push(d),
    })
    const sliders = [...document.querySelectorAll('.colorbar-controls-slider')] as HTMLInputElement[]
    // Groups are [range lo, range hi, threshold lo, threshold hi].
    const thresholdLo = sliders[2]
    thresholdLo.value = '0'
    thresholdLo.dispatchEvent(new Event('input', { bubbles: true }))
    expect(seen.at(-1)!.threshold).toEqual({ min: null, max: null })

    thresholdLo.value = '0.5'
    thresholdLo.dispatchEvent(new Event('input', { bubbles: true }))
    expect(seen.at(-1)!.threshold.min).toBeCloseTo(0.00025, 9)
  })

  it('keeps the handles ordered when one is dragged past the other', () => {
    const seen: ColorScaleDisplay[] = []
    openDisplayControls({
      scale: SCALE, display: DEFAULT_DISPLAY, onChange: (d) => seen.push(d),
    })
    const sliders = [...document.querySelectorAll('.colorbar-controls-slider')] as HTMLInputElement[]
    sliders[0].value = '0.9' // range low handle dragged above the high one
    sliders[0].dispatchEvent(new Event('input', { bubbles: true }))
    const { lo, hi } = seen.at(-1)!.stretch
    expect(lo).toBeLessThanOrEqual(hi)
  })

  it('enables reset only once something has been changed', () => {
    openDisplayControls({ scale: SCALE, display: DEFAULT_DISPLAY, onChange: () => {} })
    const reset = document.querySelector('.colorbar-controls-reset') as HTMLButtonElement
    expect(reset.disabled).toBe(true)
    const magma = [...document.querySelectorAll('.colorbar-palette-swatch')]
      .find((s) => s.textContent === 'Magma') as HTMLButtonElement
    magma.click()
    expect(reset.disabled).toBe(false)
  })

  it('resets to the default and closes', () => {
    const seen: ColorScaleDisplay[] = []
    openDisplayControls({
      scale: SCALE, display: display({ palette: 'turbo' }), onChange: (d) => seen.push(d),
    })
    ;(document.querySelector('.colorbar-controls-reset') as HTMLButtonElement).click()
    expect(seen.at(-1)).toEqual(DEFAULT_DISPLAY)
    expect(document.querySelector('.colorbar-controls')).toBeNull()
  })

  it('closes on Escape', () => {
    openDisplayControls({ scale: SCALE, display: DEFAULT_DISPLAY, onChange: () => {} })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.querySelector('.colorbar-controls')).toBeNull()
  })

  it('is safe to close when nothing is open', () => {
    expect(() => closeDisplayControls()).not.toThrow()
  })
})
