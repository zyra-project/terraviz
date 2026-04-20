/**
 * postMessage bridge for the Orbit standalone page.
 *
 * Lets a parent window (iframe host, Electron/Tauri shell, future
 * docent integration) drive the character without sharing a module
 * graph with us. Messages use a discriminated union on a `type`
 * field namespaced `orbit:*` — anything not matching is ignored so
 * the bridge coexists with other message traffic on the same window.
 *
 * Protocol:
 *
 *   parent → us:
 *     { type: 'orbit:setState',         state: 'TALKING' }
 *     { type: 'orbit:playGesture',      gesture: 'affirm' }
 *     { type: 'orbit:setPalette',       palette: 'amber' }
 *     { type: 'orbit:setScalePreset',   preset: 'planetary' }
 *     { type: 'orbit:setEyeMode',       eyes: 'two' }
 *     { type: 'orbit:setReducedMotion', reduced: true }
 *     { type: 'orbit:flyToEarth' }
 *     { type: 'orbit:flyHome' }
 *
 *   us → parent (on init, if we're iframed):
 *     { type: 'orbit:ready' }
 *
 * All string values validate against the same allow-lists URL
 * overrides use. Unknown actions log a warn and drop — no action at
 * a distance via typos.
 *
 * No origin check — this page is an internal preview surface, not
 * authenticated. The controller exposes only safe setters (state /
 * palette / gesture / etc.); the worst a malicious sender can do is
 * change what Orbit looks like.
 */

import {
  ALL_STATES, PALETTE_KEYS, GESTURE_KEYS, PRESET_KEYS,
  type OrbitController,
  type StateKey, type PaletteKey, type GestureKind,
  type ScaleKey, type EyeMode,
} from '../services/orbitCharacter'

const STATES_SET = new Set<StateKey>(ALL_STATES)
const PALETTES_SET = new Set<PaletteKey>(PALETTE_KEYS)
const GESTURES_SET = new Set<GestureKind>(GESTURE_KEYS)
const PRESETS_SET = new Set<ScaleKey>(PRESET_KEYS)
const EYES_SET = new Set<EyeMode>(['one', 'two'])

export interface OrbitBridgeHandle {
  dispose(): void
}

export function initOrbitPostMessageBridge(controller: OrbitController): OrbitBridgeHandle {
  const handler = (ev: MessageEvent): void => {
    dispatch(controller, ev.data)
  }
  window.addEventListener('message', handler)

  // Announce readiness to an iframe host so the parent knows when
  // it can start driving the character. A parent that isn't
  // listening ignores this; a cross-origin parent that refuses
  // postMessage (shouldn't happen with targetOrigin '*') swallows
  // the exception.
  if (window.parent !== window) {
    try {
      window.parent.postMessage({ type: 'orbit:ready' }, '*')
    } catch {
      /* cross-origin refusals are harmless — parent just won't know */
    }
  }

  return {
    dispose(): void {
      window.removeEventListener('message', handler)
    },
  }
}

function dispatch(controller: OrbitController, data: unknown): void {
  if (data === null || typeof data !== 'object') return
  const msg = data as Record<string, unknown>
  const type = msg.type
  if (typeof type !== 'string' || !type.startsWith('orbit:')) return

  switch (type) {
    case 'orbit:setState': {
      const s = String(msg.state ?? '').toUpperCase()
      if (STATES_SET.has(s as StateKey)) controller.setState(s as StateKey)
      else warn('unknown state', s)
      return
    }
    case 'orbit:playGesture': {
      const g = String(msg.gesture ?? '').toLowerCase()
      if (GESTURES_SET.has(g as GestureKind)) controller.playGesture(g as GestureKind)
      else warn('unknown gesture', g)
      return
    }
    case 'orbit:setPalette': {
      const p = String(msg.palette ?? '').toLowerCase()
      if (PALETTES_SET.has(p as PaletteKey)) controller.setPalette(p as PaletteKey)
      else warn('unknown palette', p)
      return
    }
    case 'orbit:setScalePreset': {
      const pr = String(msg.preset ?? '').toLowerCase()
      if (PRESETS_SET.has(pr as ScaleKey)) controller.setScalePreset(pr as ScaleKey)
      else warn('unknown preset', pr)
      return
    }
    case 'orbit:setEyeMode': {
      const e = String(msg.eyes ?? '').toLowerCase()
      if (EYES_SET.has(e as EyeMode)) controller.setEyeMode(e as EyeMode)
      else warn('unknown eye mode', e)
      return
    }
    case 'orbit:setReducedMotion': {
      // `Boolean("false") === true` would silently misfire from
      // stringly-typed callers, so accept a narrow set of truthy /
      // falsy encodings and warn on anything else.
      const parsed = parseBoolish(msg.reduced)
      if (parsed === null) warn('reduced must be boolean / 0 | 1 / "true" | "false"', msg.reduced)
      else controller.setReducedMotion(parsed)
      return
    }
    case 'orbit:flyToEarth': {
      controller.flyToEarth()
      return
    }
    case 'orbit:flyHome': {
      controller.flyHome()
      return
    }
    default:
      // Silently drop unknown orbit:* types. Allows future
      // extension without breaking older callers that haven't
      // upgraded.
      return
  }
}

function warn(label: string, value: unknown): void {
  console.warn(`[Orbit postMessage] ${label}: ${String(value)}`)
}

/**
 * Lenient-but-not-sloppy boolean coercion for wire-format booleans.
 * Accepts native booleans, numeric `0` / `1`, and the strings
 * `'true'` / `'false'` (case-insensitive). Returns `null` for
 * anything else so the caller can warn and drop rather than
 * silently invert the user's intent.
 */
function parseBoolish(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 0) return value === 1
  if (typeof value === 'string') {
    const v = value.toLowerCase()
    if (v === 'true') return true
    if (v === 'false') return false
  }
  return null
}
