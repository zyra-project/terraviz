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

export function initOrbitDebugPanel(controller: OrbitController): void {
  const panel = document.querySelector<HTMLElement>('.orbit-debug-panel')
  const toggleBtn = document.querySelector<HTMLButtonElement>('.orbit-debug-toggle')
  const stateSelect = document.getElementById('orbit-debug-state') as HTMLSelectElement | null
  const gestureHost = document.getElementById('orbit-debug-gestures')
  const paletteHost = document.getElementById('orbit-debug-palettes')

  if (!panel || !toggleBtn || !stateSelect || !gestureHost || !paletteHost) return

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
  if (flyBtn && homeBtn) wireFlightButtons(flyBtn, homeBtn, controller)

  toggleBtn.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('is-collapsed')
    toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
    toggleBtn.innerHTML = collapsed ? '&#x25B8;' : '&#x25BE;'
    announce(collapsed ? 'Debug panel collapsed' : 'Debug panel expanded')
  })

  // Poll gesture-playing state at a cheap rate so buttons disable
  // while any gesture runs. Gestures are short (≤ 1.8 s), so 10 Hz
  // is plenty and doesn't fight the render loop.
  setInterval(() => {
    const playing = controller.isGesturePlaying()
    for (const btn of gestureButtons) btn.disabled = playing
  }, 100)
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

function wireFlightButtons(flyBtn: HTMLButtonElement, homeBtn: HTMLButtonElement, controller: OrbitController): void {
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
  setInterval(() => {
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

function announce(msg: string): void {
  const live = document.getElementById('a11y-announcer')
  if (live) live.textContent = msg
}
