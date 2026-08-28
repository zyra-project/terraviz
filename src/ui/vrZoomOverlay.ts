// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * In-AR DOM zoom slider for screen-tap and transient-pointer devices.
 *
 * Mounted by `vrSession` when the resolved `inputClass` lacks
 * thumbstick zoom (Android phone AR; later, Vision Pro / HoloLens
 * via PR 4). Ungated by default for controller-class sessions —
 * Quest / PCVR users keep their existing thumbstick path and never
 * see this overlay.
 *
 * The slider drives the globe scale through a host-supplied
 * callback so this module stays free of Three.js. The host clamps
 * to MIN/MAX_GLOBE_SCALE and applies the value to `globe.scale`
 * inside its render loop.
 *
 * RTL-safe: uses `inset-inline-end` and `padding-inline-*` rather
 * than physical `right` / `padding-right` (per CLAUDE.md §CSS).
 *
 * NOTE: the file lives in `src/ui/` (not `src/services/`) so the
 * `check:i18n-strings` lint scans it for hard-coded user-visible
 * strings.
 */

import { t } from '../i18n'

/** Inputs to {@link createVrZoomOverlay}. */
export interface VrZoomOverlayOptions {
  /** Called every time the user moves the slider. The value is in
   *  the host's normalized scale range — caller maps it to the
   *  globe scale and clamps to MIN/MAX_GLOBE_SCALE. */
  readonly onZoom: (scale: number) => void
  /** Initial scale to render the slider at. Caller usually passes
   *  the current `globe.scale.x`. */
  readonly initialScale: number
  /** Min scale value the slider should permit. */
  readonly minScale: number
  /** Max scale value the slider should permit. */
  readonly maxScale: number
}

/** Returned handle. The overlay is fully self-contained — caller only
 *  needs to mount, set scale (rare), and dispose on session end. */
export interface VrZoomOverlayHandle {
  /** Append the overlay element to `parent`. Idempotent. */
  mount(parent: HTMLElement): void
  /** Remove the overlay from the DOM but keep the handle reusable. */
  unmount(): void
  /** Update the slider position from the outside. Useful when the
   *  globe scale changes via another input (e.g. pinch zoom on AR
   *  devices that also support it). */
  setScale(scale: number): void
  /** Fully tear down listeners + DOM. Idempotent. */
  dispose(): void
}

/** Linear → log mapping so each unit of slider travel feels like a
 *  fixed multiplicative zoom. Without this the bottom 30 % of travel
 *  feels frozen and the top 70 % flies past max. */
function scaleToSlider(scale: number, min: number, max: number): number {
  const lnMin = Math.log(min)
  const lnMax = Math.log(max)
  const t01 = (Math.log(scale) - lnMin) / (lnMax - lnMin)
  return Math.max(0, Math.min(1, t01))
}

function sliderToScale(t01: number, min: number, max: number): number {
  const lnMin = Math.log(min)
  const lnMax = Math.log(max)
  return Math.exp(lnMin + t01 * (lnMax - lnMin))
}

/** Create the overlay. Pure DOM — no Three.js touch. */
export function createVrZoomOverlay(opts: VrZoomOverlayOptions): VrZoomOverlayHandle {
  const host = document.createElement('div')
  host.className = 'vr-zoom-overlay'
  host.setAttribute('role', 'group')
  host.setAttribute('aria-label', t('vr.zoomSlider.aria'))

  const label = document.createElement('div')
  label.className = 'vr-zoom-overlay-label'
  label.textContent = t('vr.zoomSlider.label')
  host.appendChild(label)

  const slider = document.createElement('input')
  slider.type = 'range'
  slider.className = 'vr-zoom-overlay-slider'
  slider.min = '0'
  slider.max = '1000'
  slider.step = '1'
  slider.value = String(
    Math.round(scaleToSlider(opts.initialScale, opts.minScale, opts.maxScale) * 1000),
  )
  slider.title = t('vr.zoomSlider.title')
  slider.setAttribute('aria-label', t('vr.zoomSlider.aria'))
  // Vertical orientation: native via `orient` (Firefox) and
  // `appearance: slider-vertical` (Chromium/WebKit), both set in CSS.
  slider.setAttribute('orient', 'vertical')
  host.appendChild(slider)

  const onInput = (): void => {
    const t01 = Number(slider.value) / 1000
    const scale = sliderToScale(t01, opts.minScale, opts.maxScale)
    opts.onZoom(scale)
  }
  // Both `input` (live drag) and `change` (commit) — input fires
  // continuously on touch and gives smooth zoom feedback.
  slider.addEventListener('input', onInput)
  slider.addEventListener('change', onInput)

  let mounted = false

  // Closed-over helpers so the handle methods don't depend on `this`
  // binding — callers can destructure (e.g. `const { dispose } = handle`)
  // without losing the receiver, which would otherwise throw on
  // dispose. Caught in Copilot review of #96.
  function mount(parent: HTMLElement): void {
    if (mounted) return
    parent.appendChild(host)
    mounted = true
  }
  function unmount(): void {
    if (!mounted) return
    host.parentElement?.removeChild(host)
    mounted = false
  }
  function setScale(scale: number): void {
    slider.value = String(
      Math.round(scaleToSlider(scale, opts.minScale, opts.maxScale) * 1000),
    )
  }
  function dispose(): void {
    slider.removeEventListener('input', onInput)
    slider.removeEventListener('change', onInput)
    unmount()
  }

  return { mount, unmount, setScale, dispose }
}
