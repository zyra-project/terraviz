/**
 * Shader-settings service — the runtime side of the §7.2 globe-
 * shader uniforms. Persists the user's specular-strength preset
 * (Tools menu only — the other three knobs are dev-tuned via
 * `?tune=shader`, not user-controllable) and exposes the live
 * snapshot via `getShaderSettings()` for the renderer to read
 * each frame.
 *
 * Load precedence per uniform, highest first:
 *
 *   1. Live override set by the `?tune=shader` dev tuner — never
 *      persisted; resets on reload.
 *   2. `localStorage[SPECULAR_STORAGE_KEY]` — specular preset only.
 *   3. `SHADER_DEFAULTS` below (the value the codebase has tuned
 *      against the Blue Marble reference). Contrast / saturation /
 *      bump only flow through this layer.
 *
 * Renderer integration is event-driven. Subscribers register via
 * `onShaderSettingsChange(listener)`; the service fires the
 * listener whenever the snapshot mutates — `setSpecularPreset` or
 * `setTunerValue` are the only two write paths. Subscribers then
 * call `getShaderSettings()` to pick up the new values and
 * `triggerRepaint` (2D) / update Three.js uniforms (VR). The tuner
 * panel listens too so its sliders re-sync if a Tools-menu click
 * changes specular from elsewhere.
 *
 * `getShaderSettings()` returns a fresh object spread each call so
 * mutating the returned snapshot can't corrupt the live state.
 */

import type { SpecularPreset } from '../types/index'

export type { SpecularPreset } from '../types/index'

/** The three Tools-menu specular presets, mirroring the plan. */
export const SPECULAR_PRESETS: Record<SpecularPreset, number> = {
  none: 0.0,
  default: 0.35,
  comfortable: 0.55,
} as const

/**
 * Shipped default snapshot. `default` is named to match the
 * Tools-menu preset; contrast/saturation/bump are dev-tuned and
 * shipped as one bundle. Editing these numbers (after using the
 * tuner to confirm) is the canonical way to ship a look change.
 *
 * Why these numbers (2026-05-26 tuning pass — to be replaced once
 * the tuner page goes live):
 *  - contrast 1.10 — slight S-curve to deepen ocean blues
 *  - saturation 1.20 — push the Blue Marble greens/blues a touch
 *  - specular 0.35 — Adrian's "reduce specular" ask, was 0.60
 *  - bump 0.17 — normal-map intensity. The first-pass guess at
 *    0.85 was wildly overbaked given the 8192 asset's bake depth
 *    (every minor topographic ripple shaded as a Grand-Canyon-
 *    sized escarpment). 0.17 keeps mountain ranges visible
 *    without the whole continent reading as scratched.
 */
export const SHADER_DEFAULTS = {
  contrast: 1.10,
  saturation: 1.20,
  specularStrength: SPECULAR_PRESETS.default,
  bumpStrength: 0.17,
} as const

/** Hard-clamp band for any incoming value. */
const CONTRAST_MIN = 0.0
const CONTRAST_MAX = 2.0
const SATURATION_MIN = 0.0
const SATURATION_MAX = 2.0
const SPECULAR_MIN = 0.0
const SPECULAR_MAX = 1.0
const BUMP_MIN = 0.0
const BUMP_MAX = 2.0

/** localStorage key for the persisted specular-preset choice. */
const SPECULAR_STORAGE_KEY = 'sos-shader-specular.v1'

/** A snapshot of every shader uniform the §7.2 work touches. */
export interface ShaderSettings {
  contrast: number
  saturation: number
  specularStrength: number
  bumpStrength: number
}

/** Live mutable state — the renderer pulls from this each frame. */
const state: ShaderSettings = { ...SHADER_DEFAULTS }

/** Event name dispatched whenever any uniform changes. */
const CHANGE_EVENT = 'sos-shader-settings:change'
const target: EventTarget = typeof window === 'undefined'
  ? new EventTarget()
  : window

/**
 * Internal — validate a numeric input against a [min, max] band.
 * Despite the legacy name overlap with GLSL's `clamp()`, this is a
 * REJECTION filter, not a clamp: out-of-band values return `null`
 * so the caller can decide what to do (the tuner treats nulls as
 * "no-op the write"; the loader treats them as "fall through to
 * the next precedence layer"). Hard-clamping silently to the edge
 * would mask runaway sliders / corrupted persisted state.
 */
function validateInBand(raw: unknown, min: number, max: number): number | null {
  if (raw == null) return null
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return null
  if (n < min || n > max) return null
  return n
}

/**
 * Read the persisted specular-strength preset from localStorage,
 * returning `null` on a missing/invalid entry. Versioned to match
 * the `sos-browse-view-mode.v1` / `sos-ui-scale.v1` pattern.
 */
export function loadSpecularPreset(): SpecularPreset | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(SPECULAR_STORAGE_KEY)
    if (raw === 'none' || raw === 'default' || raw === 'comfortable') {
      return raw
    }
    return null
  } catch {
    return null
  }
}

/** Persist the specular-strength preset choice. Best-effort. */
function persistSpecularPreset(preset: SpecularPreset): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SPECULAR_STORAGE_KEY, preset)
  } catch {
    /* swallow — at worst the choice reverts on reload */
  }
}

/** Boot the runtime: apply persisted preferences over the shipped
 *  defaults. Called once at startup. */
export function initShaderSettings(): ShaderSettings {
  const preset = loadSpecularPreset()
  if (preset != null) {
    state.specularStrength = SPECULAR_PRESETS[preset]
  }
  return getShaderSettings()
}

/** Immutable read of the live settings snapshot. */
export function getShaderSettings(): ShaderSettings {
  return { ...state }
}

/**
 * Pick a Tools-menu preset. Updates the live specular-strength
 * uniform, persists the choice, and notifies subscribers.
 */
export function setSpecularPreset(preset: SpecularPreset): void {
  state.specularStrength = SPECULAR_PRESETS[preset]
  persistSpecularPreset(preset)
  notify()
}

/**
 * Map the current specular value back to a preset name (the radio
 * needs to know which button is active). Returns `null` if the
 * value sits between presets — the tuner can write any value, not
 * just preset values.
 */
export function matchSpecularPreset(value: number): SpecularPreset | null {
  for (const [name, target] of Object.entries(SPECULAR_PRESETS) as Array<
    [SpecularPreset, number]
  >) {
    if (Math.abs(value - target) < 0.01) return name
  }
  return null
}

/**
 * Tuner-only setter — writes a freeform value to any of the
 * shader uniforms. Does NOT persist (the tuner is a dev surface;
 * shipping requires editing SHADER_DEFAULTS above). Out-of-band
 * input (outside the per-uniform TUNER_BANDS range, NaN, or
 * non-numeric) is rejected as a no-op — the live snapshot stays
 * on its previous value rather than silently snapping to the
 * band edge. See `validateInBand` for the rationale.
 */
export function setTunerValue(
  key: keyof ShaderSettings,
  raw: number,
): void {
  const band = TUNER_BANDS[key]
  const value = validateInBand(raw, band.min, band.max)
  if (value == null) return
  state[key] = value
  notify()
}

/** Safe-band metadata exposed to the tuner UI so the sliders can
 *  build their min/max/step from a single source of truth. */
export const TUNER_BANDS: Record<keyof ShaderSettings, { min: number; max: number; step: number }> = {
  contrast: { min: CONTRAST_MIN, max: CONTRAST_MAX, step: 0.01 },
  saturation: { min: SATURATION_MIN, max: SATURATION_MAX, step: 0.01 },
  specularStrength: { min: SPECULAR_MIN, max: SPECULAR_MAX, step: 0.01 },
  bumpStrength: { min: BUMP_MIN, max: BUMP_MAX, step: 0.01 },
}

/** Subscribe to setting changes. Returns an unsubscribe callback.
 *  Used by the renderer to call `triggerRepaint` and by the tuner
 *  panel to re-sync sliders if a change came from elsewhere. */
export function onShaderSettingsChange(
  listener: (settings: ShaderSettings) => void,
): () => void {
  const handler = () => listener(getShaderSettings())
  target.addEventListener(CHANGE_EVENT, handler)
  return () => target.removeEventListener(CHANGE_EVENT, handler)
}

function notify(): void {
  target.dispatchEvent(new Event(CHANGE_EVENT))
}

/** Test-only — reset to shipped defaults. */
export function resetShaderSettingsForTests(): void {
  Object.assign(state, SHADER_DEFAULTS)
}

/** Test-only — localStorage key for the specular preset. */
export const SHADER_SPECULAR_STORAGE_KEY = SPECULAR_STORAGE_KEY
