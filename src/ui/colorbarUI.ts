// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The colorbar, and the controls behind it.
 *
 * A data-encoded dataset carries its exact palette, range and units on
 * the row, and until now nothing drew them: legends were a
 * publisher-uploaded PNG, which for these datasets is at best redundant
 * and at worst describes an older encode. This renders the real thing
 * from the `ColorScale` and doubles as the entry point to the display
 * transforms. See `docs/DATA_ANALYSIS_PLAN.md` §A1.
 *
 * The bar itself is a button, mirroring the existing "tap the legend to
 * enlarge" affordance — except that here the tap opens palette, range
 * and threshold controls rather than a zoom.
 *
 * All colour comes from `displayGradientStops`, which samples the same
 * LUT the shader receives, so the bar and the globe cannot disagree —
 * including about where a threshold hides values, which shows up as a
 * transparent band in the bar and reads exactly right.
 */

import {
  DEFAULT_DISPLAY,
  PALETTE_IDS,
  colorbarTicks,
  dataQuantileOfLuma,
  displayGradientStops,
  fractionKept,
  isDefaultDisplay,
  lumaAtDataQuantile,
  valueAtPosition,
  type ColorScaleDisplay,
  type PaletteId,
} from '../services/colorScaleDisplay'
import { lumaToValue } from '../types/color-scale'
import type { ColorScale } from '../types/color-scale'
import { t } from '../i18n'
import { formatNumber } from '../i18n/format'

/** Significant digits for every number the bar prints.
 *
 *  Three, matching `formatProbeReading`, and for the same reason: the
 *  measured error budget is ~0.4% of full scale, so a fourth digit
 *  would be encoder noise rendered as precision. The colorbar is the
 *  most authoritative-looking surface in the app and should not
 *  over-claim on it. */
const SIGNIFICANT_DIGITS = 3

function formatValue(value: number, units?: string): string {
  const text = formatNumber(value, { maximumSignificantDigits: SIGNIFICANT_DIGITS })
  return units ? t('probe.value', { value: text, units }) : text
}

/** `rgba()` from a LUT sample. Straight alpha, matching the LUT. */
function css(rgba: readonly [number, number, number, number]): string {
  return `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${(rgba[3] / 255).toFixed(3)})`
}

export interface ColorbarOptions {
  scale: ColorScale
  display: ColorScaleDisplay
  /** Dataset title, for the accessible name. */
  title?: string
  /** Opens the controls. Omit to render a non-interactive bar. */
  onOpen?: () => void
}

/**
 * Build (or rebuild) the floating colorbar element.
 *
 * Returns a fresh element each call; callers replace rather than
 * mutate, because a display change alters the gradient, the ticks and
 * the accessible description together and a partial update is how those
 * drift apart.
 */
export function renderColorbar(options: ColorbarOptions): HTMLElement {
  const { scale, display, title, onOpen } = options
  const el = document.createElement(onOpen ? 'button' : 'div')
  el.className = 'panel-colorbar'
  if (el instanceof HTMLButtonElement) el.type = 'button'

  const gradient = document.createElement('div')
  gradient.className = 'panel-colorbar-gradient'
  const stops = displayGradientStops(scale, display, 32)
    .map((s) => `${css(s.rgba)} ${(s.position * 100).toFixed(1)}%`)
    .join(', ')
  // Only the ramp is supplied here; the stylesheet composes it over the
  // checkerboard and owns the layer sizes. Assigning `backgroundImage`
  // directly would overwrite that composition and drop the checker, so
  // a thresholded band would read as "the same colour as the panel"
  // rather than as "hidden" — which is the one moment the checker
  // exists for, and the reason this indirection is worth having.
  gradient.style.setProperty('--colorbar-ramp', `linear-gradient(to right, ${stops})`)

  const axis = document.createElement('div')
  axis.className = 'panel-colorbar-axis'
  for (const tick of colorbarTicks(scale, display, 4)) {
    const mark = document.createElement('span')
    mark.className = 'panel-colorbar-tick'
    mark.style.insetInlineStart = `${(tick.position * 100).toFixed(2)}%`
    mark.textContent = formatNumber(tick.value, { maximumSignificantDigits: SIGNIFICANT_DIGITS })
    axis.appendChild(mark)
  }

  el.appendChild(gradient)
  el.appendChild(axis)

  if (scale.units) {
    const units = document.createElement('div')
    units.className = 'panel-colorbar-units'
    units.textContent = scale.units
    el.appendChild(units)
  }

  // The accessible name carries the numbers, because the tick labels are
  // absolutely positioned and read as a meaningless run of digits.
  const lo = formatValue(valueAtPosition(scale, display, 0), scale.units)
  const hi = formatValue(valueAtPosition(scale, display, 1), scale.units)
  const name = title
    ? t('colorbar.ariaWithTitle', { title, min: lo, max: hi })
    : t('colorbar.aria', { min: lo, max: hi })
  el.setAttribute('aria-label', onOpen ? t('colorbar.ariaAdjust', { name }) : name)
  if (onOpen) {
    el.title = t('colorbar.tapToAdjust')
    el.addEventListener('click', (ev) => {
      ev.stopPropagation()
      onOpen()
    })
  }
  return el
}

// --- the controls popover --------------------------------------------

export interface DisplayControlsOptions {
  scale: ColorScale
  display: ColorScaleDisplay
  onChange: (next: ColorScaleDisplay) => void
  /**
   * The 256-bin area-weighted distribution of the frame on screen, if
   * one can be read.
   *
   * Without it the sliders divide the palette's nominal range evenly,
   * which on a real field is close to useless: measured on a published
   * RRFS smoke frame, half the data sits below 8% of the travel and the
   * top three quarters of the slider changes the picture by under 3%.
   * With it, half travel means half the data. Read once when the
   * controls open — dragging still costs only a LUT rebuild.
   */
  distribution?: () => Float64Array | null
}

let openPopover: HTMLElement | null = null

/** Close the display controls, if open. Safe to call unconditionally. */
export function closeDisplayControls(): void {
  openPopover?.remove()
  openPopover = null
  document.removeEventListener('keydown', onEscape, true)
}

function onEscape(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') {
    ev.stopPropagation()
    closeDisplayControls()
  }
}

/**
 * Open the palette / range / threshold controls.
 *
 * Every control writes through `onChange` immediately rather than
 * behind an Apply button: the whole point of these transforms is that
 * they cost one LUT upload, so dragging a threshold across a playing
 * video is the interaction, and staging it behind a commit would hide
 * the only thing that makes the feature feel like what it is.
 */
export function openDisplayControls(options: DisplayControlsOptions): HTMLElement {
  closeDisplayControls()
  const { scale, onChange } = options
  let display = options.display

  const root = document.createElement('div')
  root.className = 'colorbar-controls'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'false')
  root.setAttribute('aria-label', t('colorbar.controls.title'))

  const header = document.createElement('div')
  header.className = 'colorbar-controls-header'
  const heading = document.createElement('h2')
  heading.textContent = t('colorbar.controls.title')
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'colorbar-controls-close'
  close.setAttribute('aria-label', t('colorbar.controls.close'))
  close.textContent = '×' // i18n-exempt: a glyph, not a word
  close.addEventListener('click', closeDisplayControls)
  header.append(heading, close)
  root.appendChild(header)

  // Live preview of what the globe is doing, so the controls explain
  // themselves without the user having to look away and back.
  let preview = renderColorbar({ scale, display })
  preview.classList.add('colorbar-controls-preview')
  root.appendChild(preview)

  const apply = (next: ColorScaleDisplay): void => {
    display = next
    onChange(next)
    const fresh = renderColorbar({ scale, display })
    fresh.classList.add('colorbar-controls-preview')
    preview.replaceWith(fresh)
    preview = fresh
    resetBtn.disabled = isDefaultDisplay(display)
  }

  // --- palette ---
  const paletteGroup = document.createElement('div')
  paletteGroup.className = 'colorbar-controls-group'
  const paletteLabel = document.createElement('span')
  paletteLabel.className = 'colorbar-controls-label'
  paletteLabel.id = 'colorbar-palette-label'
  paletteLabel.textContent = t('colorbar.palette.label')
  const paletteRow = document.createElement('div')
  paletteRow.className = 'colorbar-palette-row'
  paletteRow.setAttribute('role', 'radiogroup')
  paletteRow.setAttribute('aria-labelledby', paletteLabel.id)
  const paletteButtons = new Map<PaletteId, HTMLButtonElement>()
  for (const id of PALETTE_IDS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'colorbar-palette-swatch'
    btn.setAttribute('role', 'radio')
    btn.textContent = t(`colorbar.palette.${id}` as Parameters<typeof t>[0])
    const swatchStops = displayGradientStops(
      scale, { ...DEFAULT_DISPLAY, palette: id }, 12)
      .map((s) => `rgb(${s.rgba[0]}, ${s.rgba[1]}, ${s.rgba[2]}) ${(s.position * 100).toFixed(0)}%`)
      .join(', ')
    btn.style.setProperty('--swatch', `linear-gradient(to right, ${swatchStops})`)
    btn.addEventListener('click', () => {
      apply({ ...display, palette: id })
      for (const [pid, b] of paletteButtons) {
        b.setAttribute('aria-checked', String(pid === id))
      }
    })
    btn.setAttribute('aria-checked', String(display.palette === id))
    paletteButtons.set(id, btn)
    paletteRow.appendChild(btn)
  }
  paletteGroup.append(paletteLabel, paletteRow)
  root.appendChild(paletteGroup)

  // --- range (contrast stretch) ---
  const stretchWeights = options.distribution?.() ?? null
  const stretchAt = (p: number): number => lumaAtDataQuantile(stretchWeights, p) / 255
  const { group: rangeGroup, readout: rangeReadout } = sliderPair({
    labelText: t('colorbar.range.label'),
    minLabel: t('colorbar.range.min'),
    maxLabel: t('colorbar.range.max'),
    initial: [
      dataQuantileOfLuma(stretchWeights, display.stretch.lo * 255),
      dataQuantileOfLuma(stretchWeights, display.stretch.hi * 255),
    ],
    onInput: ([lo, hi]) => {
      // The stretch is skewed the same way the threshold is: spreading
      // the ramp evenly over a nominal range puts every visible colour
      // change into the first few percent of the travel.
      apply({ ...display, stretch: { lo: stretchAt(lo), hi: stretchAt(hi) } })
      rangeReadout.textContent = describeRange(scale, display)
    },
  })
  rangeReadout.textContent = describeRange(scale, display)
  root.appendChild(rangeGroup)

  // --- threshold ---
  //
  // Positions are data quantiles, not fractions of the palette's range.
  // See `DisplayControlsOptions.distribution`.
  const weights = options.distribution?.() ?? null
  const valueAtSlider = (p: number): number =>
    lumaToValue(lumaAtDataQuantile(weights, p), scale)
  const sliderAtValue = (v: number): number =>
    dataQuantileOfLuma(weights, ((v - scale.vmin) / (scale.vmax - scale.vmin)) * 255)

  const initialMin = display.threshold.min === null ? 0 : sliderAtValue(display.threshold.min)
  const initialMax = display.threshold.max === null ? 1 : sliderAtValue(display.threshold.max)
  const { group: thresholdGroup, readout: thresholdReadout } = sliderPair({
    labelText: t('colorbar.threshold.label'),
    minLabel: t('colorbar.threshold.min'),
    maxLabel: t('colorbar.threshold.max'),
    initial: [initialMin, initialMax],
    onInput: ([lo, hi]) => {
      // A handle parked at its end means "no bound on that side"
      // rather than "a bound that happens to sit at the extreme", so
      // that resetting a slider genuinely clears the constraint.
      const min = lo <= 0 ? null : valueAtSlider(lo)
      const max = hi >= 1 ? null : valueAtSlider(hi)
      apply({ ...display, threshold: { min, max } })
      thresholdReadout.textContent = describeThreshold(scale, display, weights)
    },
  })
  thresholdReadout.textContent = describeThreshold(scale, display, weights)
  root.appendChild(thresholdGroup)

  // --- reset ---
  const resetBtn = document.createElement('button')
  resetBtn.type = 'button'
  resetBtn.className = 'colorbar-controls-reset'
  resetBtn.textContent = t('colorbar.reset')
  resetBtn.disabled = isDefaultDisplay(display)
  resetBtn.addEventListener('click', () => {
    apply({ ...DEFAULT_DISPLAY })
    closeDisplayControls()
  })
  root.appendChild(resetBtn)

  document.body.appendChild(root)
  openPopover = root
  document.addEventListener('keydown', onEscape, true)
  return root
}

/** A two-handle range built from two `<input type="range">`s.
 *
 *  Two inputs rather than one custom widget because a native range is
 *  keyboard-accessible, screen-reader-announced and touch-sized for
 *  free, and none of that is worth reimplementing for a slider. The
 *  handles are kept ordered on input so dragging one past the other
 *  cannot invert the range. */
function sliderPair(opts: {
  labelText: string
  minLabel: string
  maxLabel: string
  initial: [number, number]
  onInput: (next: [number, number]) => void
}): { group: HTMLElement; readout: HTMLElement } {
  const group = document.createElement('div')
  group.className = 'colorbar-controls-group'

  const head = document.createElement('div')
  head.className = 'colorbar-controls-head'
  const label = document.createElement('span')
  label.className = 'colorbar-controls-label'
  label.textContent = opts.labelText
  const readout = document.createElement('span')
  readout.className = 'colorbar-controls-readout'
  head.append(label, readout)
  group.appendChild(head)

  const make = (ariaLabel: string, value: number): HTMLInputElement => {
    const input = document.createElement('input')
    input.type = 'range'
    input.min = '0'
    input.max = '1'
    input.step = '0.005'
    input.value = String(value)
    input.className = 'colorbar-controls-slider'
    input.setAttribute('aria-label', ariaLabel)
    return input
  }
  const lo = make(opts.minLabel, opts.initial[0])
  const hi = make(opts.maxLabel, opts.initial[1])

  const emit = (): void => {
    const a = Number(lo.value)
    const b = Number(hi.value)
    opts.onInput([Math.min(a, b), Math.max(a, b)])
  }
  lo.addEventListener('input', emit)
  hi.addEventListener('input', emit)

  group.append(lo, hi)
  return { group, readout }
}

function describeRange(scale: ColorScale, display: ColorScaleDisplay): string {
  return t('colorbar.range.readout', {
    min: formatValue(valueAtPosition(scale, display, 0), scale.units),
    max: formatValue(valueAtPosition(scale, display, 1), scale.units),
  })
}

function describeThreshold(
  scale: ColorScale,
  display: ColorScaleDisplay,
  weights: Float64Array | null,
): string {
  const { min, max } = display.threshold
  if (min === null && max === null) return t('colorbar.threshold.none')

  const band = min !== null && max === null
    ? t('colorbar.threshold.above', { value: formatValue(min, scale.units) })
    : min === null && max !== null
      ? t('colorbar.threshold.below', { value: formatValue(max, scale.units) })
      : t('colorbar.threshold.between', {
        min: formatValue(min as number, scale.units),
        max: formatValue(max as number, scale.units),
      })

  // How much of the field survives, when that is knowable. "Only
  // 0.00028 and below" sounds decisive and on this data keeps 99.8% of
  // the frame; a control that appears to do nothing is
  // indistinguishable from one that is broken.
  const kept = fractionKept(weights, scale, display.threshold)
  if (kept === null) return band
  return t('colorbar.threshold.keeps', {
    band,
    percent: formatNumber(kept * 100, { maximumSignificantDigits: 2 }),
  })
}
