import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  openPrivacyUI,
  closePrivacyUI,
  isPrivacyUIOpen,
  disposePrivacyUI,
} from './privacyUI'
import { loadConfig, setTier } from '../analytics/config'
import { emit, resetForTests, size, __peek } from '../analytics/emitter'
import type { LayerLoadedEvent, DwellEvent } from '../types'

// ---- Fixtures ----

function layerLoaded(id = 'A'): LayerLoadedEvent {
  return {
    event_type: 'layer_loaded',
    layer_id: id,
    layer_source: 'network',
    slot_index: '0',
    trigger: 'browse',
    load_ms: 100,
  }
}

function dwell(): DwellEvent {
  return {
    event_type: 'dwell',
    view_target: 'chat',
    duration_ms: 1000,
  }
}

// ---- Setup ----

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  resetForTests()
})

afterEach(() => {
  disposePrivacyUI()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

// ---- Rendering + open/close ----

describe('privacyUI — open / close', () => {
  it('lazy-mounts the dialog on first open', () => {
    expect(document.getElementById('privacy-ui-panel')).toBeNull()
    openPrivacyUI()
    expect(document.getElementById('privacy-ui-panel')).not.toBeNull()
    expect(isPrivacyUIOpen()).toBe(true)
  })

  it('hides the dialog on close and keeps it in the DOM for reopen', () => {
    openPrivacyUI()
    const panel = document.getElementById('privacy-ui-panel')!
    closePrivacyUI()
    expect(isPrivacyUIOpen()).toBe(false)
    expect(panel.classList.contains('hidden')).toBe(true)
    // Reopen is cheap — same node.
    openPrivacyUI()
    expect(document.getElementById('privacy-ui-panel')).toBe(panel)
    expect(panel.classList.contains('hidden')).toBe(false)
  })

  it('closes on Escape', () => {
    openPrivacyUI()
    const ev = new KeyboardEvent('keydown', { key: 'Escape' })
    document.dispatchEvent(ev)
    expect(isPrivacyUIOpen()).toBe(false)
  })

  it('closes on backdrop click', () => {
    openPrivacyUI()
    const backdrop = document.getElementById('privacy-ui-backdrop')!
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(isPrivacyUIOpen()).toBe(false)
  })

  it('returns focus to the trigger on close', () => {
    const trigger = document.createElement('button')
    trigger.id = 'fake-trigger'
    document.body.appendChild(trigger)
    const focusSpy = vi.spyOn(trigger, 'focus')

    openPrivacyUI(trigger)
    closePrivacyUI()
    expect(focusSpy).toHaveBeenCalled()
  })

  it('traps Tab + Shift-Tab focus inside the dialog', () => {
    openPrivacyUI()
    const panel = document.getElementById('privacy-ui-panel')!
    // Use the same query the trap uses, but skip the offsetParent
    // filter — happy-dom doesn't compute layout, so the production
    // filter would zero everything out in this environment. The
    // trap's own selector is what we exercise here.
    // Same selector the trap uses, so first/last match its view.
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    )
    expect(focusables.length).toBeGreaterThan(1)
    const first = focusables[0]
    const last = focusables[focusables.length - 1]

    // Tab from the last focusable should cycle back to the first.
    last.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
    expect(document.activeElement).toBe(first)

    // Shift-Tab from the first should cycle to the last.
    first.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }))
    expect(document.activeElement).toBe(last)
  })
})

describe('privacyUI — tier selection', () => {
  it('reflects the currently persisted tier on open', () => {
    setTier('research')
    openPrivacyUI()
    const checked = document.querySelector<HTMLInputElement>(
      'input[name="privacy-ui-tier"]:checked',
    )
    expect(checked?.value).toBe('research')
  })

  it('persists the new tier and announces the change', () => {
    setTier('essential')
    openPrivacyUI()
    const off = document.querySelector<HTMLInputElement>(
      'input[name="privacy-ui-tier"][value="off"]',
    )!
    off.checked = true
    off.dispatchEvent(new Event('change', { bubbles: true }))

    expect(loadConfig().tier).toBe('off')
    const status = document.getElementById('privacy-ui-status')
    expect(status?.textContent ?? '').toMatch(/off/i)
  })

  it('emits a settings_changed event carrying the new tier', () => {
    setTier('essential')
    openPrivacyUI()
    const research = document.querySelector<HTMLInputElement>(
      'input[name="privacy-ui-tier"][value="research"]',
    )!
    research.checked = true
    research.dispatchEvent(new Event('change', { bubbles: true }))

    const queued = __peek()
    const lastSettings = [...queued]
      .reverse()
      .find((e) => e.event_type === 'settings_changed')
    expect(lastSettings?.key).toBe('telemetry_tier')
    expect(lastSettings?.value_class).toBe('research')
  })

  it('drops the in-flight queue when switching to Off', () => {
    setTier('research')
    // Pre-seed queue *before* opening the UI.
    emit(layerLoaded())
    emit(dwell())
    expect(size()).toBeGreaterThan(0)

    openPrivacyUI()
    const off = document.querySelector<HTMLInputElement>(
      'input[name="privacy-ui-tier"][value="off"]',
    )!
    off.checked = true
    off.dispatchEvent(new Event('change', { bubbles: true }))

    expect(size()).toBe(0)
  })

  it('strips queued Tier B events when stepping down Research → Essential', () => {
    setTier('research')
    emit(layerLoaded()) // Tier A
    emit(dwell()) // Tier B
    expect(__peek().map((e) => e.event_type)).toContain('dwell')

    openPrivacyUI()
    const essential = document.querySelector<HTMLInputElement>(
      'input[name="privacy-ui-tier"][value="essential"]',
    )!
    essential.checked = true
    essential.dispatchEvent(new Event('change', { bubbles: true }))

    const remaining = __peek().map((e) => e.event_type)
    expect(remaining).not.toContain('dwell')
    expect(remaining).toContain('layer_loaded')
  })
})

describe('privacyUI — session ID display', () => {
  it('renders the current in-memory session id, not a persisted one', () => {
    openPrivacyUI()
    const id = document.getElementById('privacy-ui-session-id')?.textContent ?? ''
    // Session IDs are UUID-ish — at minimum non-empty and not persisted.
    expect(id.length).toBeGreaterThan(8)
    for (const key of Object.keys(localStorage)) {
      const val = localStorage.getItem(key) ?? ''
      expect(val).not.toContain(id)
    }
  })
})

describe('privacyUI — accessibility shape', () => {
  it('renders as a modal dialog with a labeled heading', () => {
    openPrivacyUI()
    const panel = document.getElementById('privacy-ui-panel')!
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.getAttribute('aria-modal')).toBe('true')
    const labelledby = panel.getAttribute('aria-labelledby')
    expect(labelledby).toBeTruthy()
    expect(document.getElementById(labelledby!)?.textContent).toMatch(/privacy/i)
  })

  it('uses a radiogroup for the tier selector', () => {
    openPrivacyUI()
    const group = document.querySelector('[role="radiogroup"]')
    expect(group).not.toBeNull()
    const radios = document.querySelectorAll('input[name="privacy-ui-tier"]')
    expect(radios.length).toBe(3)
  })

  it('includes a link to the canonical /privacy page', () => {
    openPrivacyUI()
    const link = document.querySelector<HTMLAnchorElement>('.privacy-ui-policy-link')
    expect(link?.getAttribute('href')).toBe('/privacy')
  })
})
