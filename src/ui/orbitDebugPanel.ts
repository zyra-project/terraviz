/**
 * Debug panel wiring for the Orbit standalone page.
 *
 * Phase 3 adds gesture buttons (Shrug, Wave, Beckon, Affirm) that
 * disable while a gesture is playing to match the design doc's
 * one-at-a-time rule. Phase 4 will add flight controls + scale
 * preset; Phase 5 adds the palette radio group.
 */

import type { OrbitController, StateKey, GestureKind, PaletteKey, ScaleKey } from '../services/orbitCharacter'
import {
  BEHAVIOR_STATES, EMOTION_STATES, GESTURE_STATES, STATES,
  GESTURE_KEYS, GESTURES,
  PALETTE_KEYS, PALETTES,
  PRESET_KEYS, SCALE_PRESETS,
} from '../services/orbitCharacter'
import { OrbitDocentBridge } from '../services/orbitDocentBridge'
import type { ChatAction } from '../types'

/**
 * Stand-in dataset payload for the docent demo buttons. The bridge
 * doesn't read any field beyond the discriminator on action chunks
 * (it only triggers a beckon / affirm gesture), so a synthetic action
 * is enough to exercise the wiring without coupling to real catalog
 * data.
 */
const DEMO_ACTION: ChatAction = {
  type: 'load-dataset',
  datasetId: 'INTERNAL_DEMO',
  datasetTitle: 'Demo dataset',
}

export interface OrbitDebugPanelHandle {
  /**
   * Clear any background timers the panel started (gesture-playing
   * poll, flight-mode poll). Call before re-mounting the panel or
   * during HMR teardown so timers don't stack. The standalone
   * /orbit page never tears down in normal flow, but lifecycle
   * hooks keep the module embedding-friendly.
   */
  dispose(): void
}

export function initOrbitDebugPanel(controller: OrbitController): OrbitDebugPanelHandle {
  const noop: OrbitDebugPanelHandle = { dispose() {} }
  const panel = document.querySelector<HTMLElement>('.orbit-debug-panel')
  const toggleBtn = document.querySelector<HTMLButtonElement>('.orbit-debug-toggle')
  const stateSelect = document.getElementById('orbit-debug-state') as HTMLSelectElement | null
  const gestureHost = document.getElementById('orbit-debug-gestures')
  const paletteHost = document.getElementById('orbit-debug-palettes')

  if (!panel || !toggleBtn || !stateSelect || !gestureHost || !paletteHost) return noop

  populateStateOptions(stateSelect)
  stateSelect.value = controller.getState()

  stateSelect.addEventListener('change', () => {
    controller.setState(stateSelect.value as StateKey)
  })

  const gestureButtons = buildGestureButtons(gestureHost, controller)
  buildPaletteSwatches(paletteHost, controller)

  const scaleHost = document.getElementById('orbit-debug-scales')
  const flyBtn = document.getElementById('orbit-debug-fly') as HTMLButtonElement | null
  const homeBtn = document.getElementById('orbit-debug-home') as HTMLButtonElement | null
  if (scaleHost) buildScaleControl(scaleHost, controller)
  const flightIntervalId = (flyBtn && homeBtn) ? wireFlightButtons(flyBtn, homeBtn, controller) : null

  // Docent stream simulator. The bridge is wired straight to the live
  // controller — clicking through the buttons drives the same state /
  // gesture transitions the real docent will trigger from VR / 2D
  // companion hosts later, so designers can preview each transition
  // without spinning up the LLM stack. The bridge holds no DOM /
  // network references; it's safe to keep alive for the page's
  // lifetime and dispose alongside the panel.
  const docentBridge = new OrbitDocentBridge(controller)
  const docentHost = document.getElementById('orbit-debug-docent')
  if (docentHost) buildDocentSteps(docentHost, docentBridge)

  toggleBtn.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('is-collapsed')
    toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
    toggleBtn.innerHTML = collapsed ? '&#x25B8;' : '&#x25BE;'
    announce(collapsed ? 'Debug panel collapsed' : 'Debug panel expanded')
  })

  // Poll gesture-playing state at a cheap rate so buttons disable
  // while any gesture runs. Gestures are short (≤ 1.8 s), so 10 Hz
  // is plenty and doesn't fight the render loop.
  const gestureIntervalId = window.setInterval(() => {
    const playing = controller.isGesturePlaying()
    for (const btn of gestureButtons) btn.disabled = playing
  }, 100)

  return {
    dispose(): void {
      window.clearInterval(gestureIntervalId)
      if (flightIntervalId !== null) window.clearInterval(flightIntervalId)
      docentBridge.dispose()
    },
  }
}

function populateStateOptions(select: HTMLSelectElement): void {
  select.innerHTML = ''
  appendGroup(select, 'Behavior', BEHAVIOR_STATES)
  appendGroup(select, 'Emotion', EMOTION_STATES)
  appendGroup(select, 'Head', GESTURE_STATES)
}

function appendGroup(select: HTMLSelectElement, label: string, keys: StateKey[]): void {
  const group = document.createElement('optgroup')
  group.label = label
  keys.forEach((k) => {
    const opt = document.createElement('option')
    opt.value = k
    opt.textContent = STATES[k].label
    group.appendChild(opt)
  })
  select.appendChild(group)
}

function buildPaletteSwatches(host: HTMLElement, controller: OrbitController): void {
  host.innerHTML = ''
  const updateChecked = () => {
    const current = controller.getPalette()
    host.querySelectorAll<HTMLButtonElement>('.orbit-debug-palette').forEach((btn) => {
      btn.setAttribute('aria-checked', btn.dataset.palette === current ? 'true' : 'false')
    })
  }
  for (const key of PALETTE_KEYS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'orbit-debug-palette'
    btn.dataset.palette = key
    btn.setAttribute('role', 'radio')
    btn.setAttribute('aria-label', `${key} palette`)
    btn.title = key
    btn.style.setProperty('--swatch', PALETTES[key].accent)
    btn.appendChild(document.createElement('span'))
    btn.addEventListener('click', () => {
      controller.setPalette(key as PaletteKey)
      updateChecked()
      announce(`Palette: ${key}`)
    })
    host.appendChild(btn)
  }
  updateChecked()
}

function buildScaleControl(host: HTMLElement, controller: OrbitController): void {
  host.innerHTML = ''
  const sync = () => {
    const current = controller.getScalePreset()
    host.querySelectorAll<HTMLButtonElement>('.orbit-debug-scale').forEach((btn) => {
      btn.setAttribute('aria-checked', btn.dataset.preset === current ? 'true' : 'false')
    })
  }
  for (const key of PRESET_KEYS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'orbit-debug-scale'
    btn.dataset.preset = key
    btn.setAttribute('role', 'radio')
    btn.textContent = SCALE_PRESETS[key].label
    btn.title = SCALE_PRESETS[key].tag
    btn.addEventListener('click', () => {
      controller.setScalePreset(key as ScaleKey)
      sync()
      announce(`Scale: ${SCALE_PRESETS[key].label}`)
    })
    host.appendChild(btn)
  }
  sync()
}

function wireFlightButtons(
  flyBtn: HTMLButtonElement,
  homeBtn: HTMLButtonElement,
  controller: OrbitController,
): number {
  flyBtn.addEventListener('click', () => {
    if (controller.flyToEarth()) announce('Orbit flying to Earth')
  })
  homeBtn.addEventListener('click', () => {
    if (controller.flyHome()) announce('Orbit returning to chat position')
  })
  // Poll flight mode — disable buttons inappropriately for current state.
  //   rest:   Fly enabled, Home disabled
  //   out:    both disabled (in transit)
  //   atEarth: Fly disabled, Home enabled
  //   back:   both disabled
  // Returned interval id is cleared by the panel's dispose handle.
  return window.setInterval(() => {
    const mode = controller.getFlightMode()
    flyBtn.disabled = mode !== 'rest'
    homeBtn.disabled = mode !== 'atEarth'
    flyBtn.setAttribute('aria-disabled', String(flyBtn.disabled))
    homeBtn.setAttribute('aria-disabled', String(homeBtn.disabled))
  }, 120)
}

function buildGestureButtons(host: HTMLElement, controller: OrbitController): HTMLButtonElement[] {
  host.innerHTML = ''
  const buttons: HTMLButtonElement[] = []
  for (const kind of GESTURE_KEYS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'orbit-debug-gesture'
    btn.textContent = GESTURES[kind].label
    btn.setAttribute('aria-label', `Play ${GESTURES[kind].label} gesture`)
    btn.addEventListener('click', () => {
      controller.playGesture(kind as GestureKind)
      announce(`Playing ${GESTURES[kind].label}`)
    })
    host.appendChild(btn)
    buttons.push(btn)
  }
  return buttons
}

/**
 * Step buttons that drive the {@link OrbitDocentBridge} as if a real
 * docent stream were arriving. Each button invokes one bridge entry
 * point — Submit kicks the LISTENING / THINKING flow; Delta lands
 * the first-token transition; Done ✓ / Done ✗ settle the avatar
 * into CHATTING (with or without the brief CONFUSED detour). Visuals
 * reuse the gesture-button class so the row reads as part of the
 * same affordance vocabulary as the rest of the debug panel.
 */
function buildDocentSteps(host: HTMLElement, bridge: OrbitDocentBridge): void {
  host.innerHTML = ''
  const steps: { label: string; ariaLabel: string; run: () => void; announce: string }[] = [
    {
      label: 'Submit',
      ariaLabel: 'Simulate user submit',
      run: () => bridge.onUserSubmit(),
      announce: 'Docent: user submit',
    },
    {
      label: 'Delta',
      ariaLabel: 'Simulate first delta chunk',
      run: () => bridge.onChunk({ type: 'delta', text: '…' }),
      announce: 'Docent: delta chunk',
    },
    {
      label: 'Action',
      ariaLabel: 'Simulate action chunk',
      run: () => bridge.onChunk({ type: 'action', action: DEMO_ACTION }),
      announce: 'Docent: action chunk',
    },
    {
      label: 'Auto-load',
      ariaLabel: 'Simulate auto-load chunk',
      run: () => bridge.onChunk({ type: 'auto-load', action: DEMO_ACTION, alternatives: [] }),
      announce: 'Docent: auto-load chunk',
    },
    {
      label: 'Done ✓',
      ariaLabel: 'Simulate done chunk (LLM)',
      run: () => bridge.onChunk({ type: 'done', fallback: false }),
      announce: 'Docent: done',
    },
    {
      label: 'Done ✗',
      ariaLabel: 'Simulate done chunk with fallback',
      run: () => bridge.onChunk({ type: 'done', fallback: true }),
      announce: 'Docent: done (fallback)',
    },
    {
      label: 'Abort',
      ariaLabel: 'Simulate stream abort',
      run: () => bridge.onAbort(),
      announce: 'Docent: abort',
    },
  ]
  for (const step of steps) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'orbit-debug-gesture'
    btn.textContent = step.label
    btn.setAttribute('aria-label', step.ariaLabel)
    btn.addEventListener('click', () => {
      step.run()
      announce(step.announce)
    })
    host.appendChild(btn)
  }
}

function announce(msg: string): void {
  const live = document.getElementById('a11y-announcer')
  if (live) live.textContent = msg
}
