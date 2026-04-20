/**
 * Bootstrap for the Orbit standalone page.
 *
 * Runs at `/orbit` (production) or `/orbit.html` (fallback). Wires the
 * OrbitController to its canvas host and initializes the debug panel.
 * See docs/ORBIT_CHARACTER_INTEGRATION_PLAN.md.
 */

import './styles/tokens.css'
import './styles/orbit.css'
import {
  OrbitController, ALL_STATES, STATES, GESTURE_KEYS, PRESET_KEYS,
  type StateKey, type PaletteKey, type GestureKind, type ScaleKey, type EyeMode,
} from './services/orbitCharacter'
import { initOrbitDebugPanel } from './ui/orbitDebugPanel'
import { initOrbitPerfHud } from './ui/orbitPerfHud'
import { initOrbitPostMessageBridge } from './ui/orbitPostMessageBridge'

const ALLOWED_STATES = new Set<StateKey>(ALL_STATES)
const ALLOWED_PALETTES = new Set<PaletteKey>(['cyan', 'green', 'amber', 'violet'])
const ALLOWED_GESTURES = new Set<GestureKind>(GESTURE_KEYS)
const ALLOWED_PRESETS = new Set<ScaleKey>(PRESET_KEYS)
// Eye mode is narrowed to 'two' under the vinyl redesign; the URL
// parameter is accepted for API stability but only the one literal
// value is valid.
const ALLOWED_EYES = new Set<EyeMode>(['two'])

interface UrlOverrides {
  state?: StateKey
  palette?: PaletteKey
  gesture?: GestureKind
  preset?: ScaleKey
  eyes?: EyeMode
  fly?: boolean
  reduced?: boolean
}

function readUrlOverrides(): UrlOverrides {
  if (typeof window === 'undefined') return {}
  const params = new URLSearchParams(window.location.search)
  const out: UrlOverrides = {}
  const s = params.get('state')?.toUpperCase()
  if (s && ALLOWED_STATES.has(s as StateKey)) out.state = s as StateKey
  const p = params.get('palette')?.toLowerCase()
  if (p && ALLOWED_PALETTES.has(p as PaletteKey)) out.palette = p as PaletteKey
  const g = params.get('gesture')?.toLowerCase()
  if (g && ALLOWED_GESTURES.has(g as GestureKind)) out.gesture = g as GestureKind
  const pr = params.get('preset')?.toLowerCase()
  if (pr && ALLOWED_PRESETS.has(pr as ScaleKey)) out.preset = pr as ScaleKey
  const e = params.get('eyes')?.toLowerCase()
  if (e && ALLOWED_EYES.has(e as EyeMode)) out.eyes = e as EyeMode
  if (params.get('fly') === '1' || params.get('fly') === 'true') out.fly = true
  // ?reduced=1 forces reduced-motion mode regardless of OS setting —
  // useful for design reviews and screenshots without flipping system
  // accessibility settings. Omit (or `?reduced=0`) to honor the OS.
  const r = params.get('reduced')
  if (r === '1' || r === 'true') out.reduced = true
  else if (r === '0' || r === 'false') out.reduced = false
  return out
}

function announce(msg: string): void {
  const live = document.getElementById('a11y-announcer')
  if (live) live.textContent = msg
}

function updateCanvasAriaLabel(state: StateKey): void {
  const host = document.getElementById('orbit-canvas-host')
  if (host) host.setAttribute('aria-label', `Orbit character, ${labelFor(state)}`)
}

function labelFor(state: StateKey): string {
  return STATES[state].label
}

function bootstrap(): void {
  const host = document.getElementById('orbit-canvas-host')
  if (!host) {
    console.error('Orbit: #orbit-canvas-host not found')
    return
  }

  const overrides = readUrlOverrides()

  const controller = new OrbitController({
    container: host,
    palette: overrides.palette ?? 'cyan',
    onStateChange: (state) => {
      updateCanvasAriaLabel(state)
      announce(`Orbit is now ${labelFor(state).toLowerCase()}`)
    },
  })

  if (overrides.state) controller.setState(overrides.state)
  if (overrides.preset) controller.setScalePreset(overrides.preset)
  if (overrides.eyes) controller.setEyeMode(overrides.eyes)
  if (overrides.reduced !== undefined) controller.setReducedMotion(overrides.reduced)
  updateCanvasAriaLabel(controller.getState())

  initOrbitDebugPanel(controller)

  const hudEl = document.getElementById('orbit-perf-hud')
  if (hudEl) initOrbitPerfHud(hudEl)

  // Bridge so a parent window (iframe host, Electron/Tauri shell,
  // future docent integration) can drive Orbit via postMessage.
  // Posts `orbit:ready` to `window.parent` on init if iframed;
  // listens for `orbit:*` messages to set state / play gestures /
  // etc. See orbitPostMessageBridge.ts for the protocol.
  initOrbitPostMessageBridge(controller)

  // URL-param gestures fire once on load. Delay until the scene has a
  // frame or two so Beckon's direction vector is computed from a
  // settled head position.
  if (overrides.gesture) {
    setTimeout(() => controller.playGesture(overrides.gesture!), 250)
  }
  // ?fly=1 triggers a Fly-to-Earth on load. Useful for demo links
  // like /orbit?preset=planetary&fly=1 to show the scale lesson.
  if (overrides.fly) {
    setTimeout(() => controller.flyToEarth(), 400)
  }

  // Expose for console debugging and the eventual postMessage bridge.
  // Kept as a property on a namespaced object so it doesn't collide
  // with anything the main app might someday inject.
  ;(window as unknown as { __orbit?: { controller: OrbitController } }).__orbit = {
    controller,
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true })
} else {
  bootstrap()
}
