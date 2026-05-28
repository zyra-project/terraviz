/**
 * Tools Menu UI — single wrench-icon button plus a collapsible popover
 * that hosts every map-related toggle, the viewport layout picker,
 * the Clear action, and an entry point to Orbit settings.
 *
 * Replaces the previous horizontal `#map-controls` toolbar which was
 * growing past the bottom-right corner once the layout picker shipped,
 * and consolidates the previously standalone `#auto-rotate-standalone`
 * button and the Orbit settings entry point into one place.
 *
 * Layout:
 *
 *   [🧭 Browse]  [⚙️ Tools]      ← two small buttons, always visible
 *
 * When the Tools button is clicked, a popover slides in above it:
 *
 *   ┌─ Tools ─────────── ✕ ┐
 *   │ View                  │
 *   │  [ ] Labels           │
 *   │  [ ] Borders          │
 *   │  [ ] Terrain          │
 *   │  [ ] Auto-rotate      │
 *   │ Layout                │
 *   │  (1) (2↔) (2↕) (4)    │
 *   │ Actions               │
 *   │  [ Clear markers ]    │
 *   │ Orbit                 │
 *   │  [ Settings… ]        │
 *   └───────────────────────┘
 *
 * Toggle actions fan out across every viewport in the current
 * ViewportManager so overlay state stays synchronised across panels.
 * The Browse and Tools buttons sit on top of MapLibre, so they
 * receive clicks before the map. The popover uses `pointer-events:
 * auto` on itself and the map-grid remains the only thing under
 * `pointer-events: none` regions.
 */

import type { ViewportManager, ViewLayout } from '../services/viewportManager'
import { updateMapControlsPosition } from './mapControlsUI'
import { openPrivacyUI } from './privacyUI'
import { openPlaylistManager } from './playlistUI'
import { emit } from '../analytics'
import { setBordersVisible } from '../utils/viewPreferences'
import {
  loadUiScale,
  nearestPreset,
  setUiScale,
  UI_SCALE_PRESETS,
  type UiScalePreset,
} from '../services/uiScaleService'
import {
  getShaderSettings,
  matchSpecularPreset,
  setSpecularPreset,
  SPECULAR_PRESETS,
  type SpecularPreset,
} from '../services/shaderSettingsService'
import {
  getLocale,
  NATIVE_NAMES,
  PICKER_LOCALES,
  t,
  tAttr,
  tHtml,
  type Locale,
} from '../i18n'
import { saveLocalePref } from '../i18n/persistence'
import { escapeAttr, escapeHtml } from './domUtils'

/** Fire a `settings_changed` event for a toggle/action in the Tools
 * popover. `key` is the logical name (labels / borders / etc.) and
 * `value_class` is a short label describing the new value — for
 * booleans this is "on" / "off", for categorical values it's the
 * value itself. Never carries user data. */
function emitSetting(key: string, valueClass: string): void {
  emit({ event_type: 'settings_changed', key, value_class: valueClass })
}

/** True when the browser is currently rendering some element
 *  fullscreen. Wraps `document.fullscreenElement` (which some
 *  test environments leave as `undefined` rather than `null`) so
 *  the rest of the file doesn't have to repeat the falsy check. */
function isFullscreen(): boolean {
  return Boolean(document.fullscreenElement)
}

/** Toggle the document into / out of fullscreen via the standard
 *  Fullscreen API. Errors (autoplay-policy denial, browser
 *  feature-policy block) are swallowed silently — the button keeps
 *  its current state and the `fullscreenchange` event never fires,
 *  so `syncFullscreenButton` doesn't have anything to do. */
async function toggleFullscreen(): Promise<void> {
  try {
    if (isFullscreen()) {
      await document.exitFullscreen()
    } else {
      await document.documentElement.requestFullscreen()
    }
  } catch {
    // Silent — the request was denied (autoplay policy, top-level
    // browsing context, Permissions Policy) and the icon stays
    // where it was.
  }
}

/** Mirror the current fullscreen state into the toolbar button's
 *  icon, tooltip, ARIA label, and `aria-pressed`. Called once at
 *  init and again whenever `fullscreenchange` fires. */
function syncFullscreenButton(): void {
  const btn = document.getElementById('tools-menu-fullscreen')
  if (!btn) return
  const on = isFullscreen()
  const label = on
    ? t('mapControls.fullscreen.exit')
    : t('mapControls.fullscreen.enter')
  btn.setAttribute('title', label)
  btn.setAttribute('aria-label', label)
  btn.setAttribute('aria-pressed', on ? 'true' : 'false')
  // The glyph (U+26F6 SQUARED FOUR CORNERS, text style) stays the
  // same in both states — the active background + aria-pressed +
  // accessible label convey the transition. Pairing it with a
  // distinct "exit fullscreen" glyph would require choosing one of
  // the ambiguous diagonal-arrow codepoints, none of which read as
  // clearly as a label change.
}

/**
 * Runtime Tauri-shell detection — matches the same `__TAURI__`
 * sentinel the rest of the code keys off of. Read fresh inside
 * initToolsMenu rather than cached at module load so tests can
 * toggle `window.__TAURI__` between cases.
 */
function isTauri(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { __TAURI__?: unknown }).__TAURI__
}

/** Callbacks the tools menu fires out into the rest of the app. */
export interface ToolsMenuCallbacks {
  /** Multi-viewport: user picked a layout from the picker. */
  onSetLayout?: (layout: ViewLayout) => void
  /** User clicked Browse — open the dataset list. */
  onOpenBrowse?: () => void
  /** User clicked Orbit settings — open the chat settings dialog. */
  onOpenOrbitSettings?: () => void
  /** User toggled dataset info visibility. */
  onToggleDatasetInfo?: (visible: boolean) => void
  /** User toggled legend visibility. */
  onToggleLegend?: (visible: boolean) => void
  /** User clicked Credits — open the credits / attribution
   *  dialog. The Tools menu hands its always-visible toggle
   *  button as `trigger` so the credits panel can restore focus
   *  there when it closes (the menu item itself is hidden by
   *  closePopover() before the dialog opens, so it isn't a
   *  reliable focus target). */
  onOpenCredits?: (trigger: HTMLElement) => void
  /** Announce something for screen readers. */
  announce?: (message: string) => void
  /** Get the currently loaded dataset (used by the Share action). */
  getCurrentDataset: () => { id: string; title: string } | null
}

/** Open/close state for the popover. Tracked here because DOM tests
 *  need a deterministic way to introspect it. */
let isOpen = false

/** Set up the tools menu inside `#map-controls`, replacing whatever
 *  is there. Idempotent — re-calling rebuilds the DOM so init can be
 *  driven from tests as well as the app boot path. */
export function initToolsMenu(
  viewports: ViewportManager,
  callbacks: ToolsMenuCallbacks = { getCurrentDataset: () => null },
): void {
  const container = document.getElementById('map-controls')
  if (!container) return

  // Reset open state whenever we rebuild — matters for tests that
  // call initToolsMenu multiple times and for main.ts init flows
  // that re-run on hot-reload. Without this the module-level flag
  // leaks between invocations.
  isOpen = false

  const gateMeetOrbit = isTauri()

  const { onSetLayout, onOpenBrowse, onOpenOrbitSettings, onToggleDatasetInfo, onToggleLegend, onOpenCredits, announce } = callbacks
  const currentLayout = viewports.getLayout()

  // Resolve the current UI scale (precedence: localStorage → env →
  // 1.0) so the radio's initial active button matches what's
  // already applied to :root. initUiScale() ran at module-eval in
  // main.ts; we only read the current value here. We use
  // `nearestPreset()` rather than `matchPreset()` so a non-preset
  // value (e.g. VITE_DEFAULT_UI_SCALE=1.25 or a hand-edited
  // localStorage entry) still highlights *some* button — an
  // unselected button group is confusing UX.
  const currentUiScalePreset = nearestPreset(loadUiScale())

  // Resolve the current specular preset (§7.2). matchSpecularPreset
  // returns null when the live value is between presets — the
  // ?tune=shader page can write any value — so we fall back to
  // 'default' for the highlight rather than leaving the radio
  // unselected. Same UX reasoning as the UI-scale row above.
  const currentSpecular = matchSpecularPreset(getShaderSettings().specularStrength)
    ?? 'default'

  const activeLocale = getLocale()
  // Only show locales that have crossed the picker-visibility
  // coverage gate (PICKER_LOCALES, gated at ≥80% by the codegen).
  // Always include the currently-active locale even if it's below
  // threshold, so a user who landed via `?lang=ar` (or has a
  // stored pref for a below-threshold locale) can see their
  // active selection in the dropdown and switch out of it.
  // Both BCP-47 tags (validated at codegen time against ^[a-z]…$)
  // and the curated NATIVE_NAMES are trusted today, but escape
  // anyway — defense in depth keeps this safe if either source is
  // ever extended to translator input or runtime overrides (see
  // L2 partner-overrides plan in docs/I18N_PLAN.md).
  const visibleLocales: readonly Locale[] = PICKER_LOCALES.includes(activeLocale)
    ? PICKER_LOCALES
    : [...PICKER_LOCALES, activeLocale]
  const localeOptions = visibleLocales
    .map((l) => `<option value="${escapeAttr(l)}"${l === activeLocale ? ' selected' : ''}>${escapeHtml(NATIVE_NAMES[l] ?? l)}</option>`)
    .join('')

  container.classList.remove('hidden')
  container.classList.add('tools-menu-host')
  // Every translated string flows through tHtml/tAttr because
  // these blobs land directly in innerHTML — translator content
  // arrives via Weblate (untrusted) and the build-time forbidden-
  // pattern gate catches script-class HTML but not e.g. <img src>
  // or attribute breakouts. tHtml escapes for element text;
  // tAttr escapes for quoted attribute values.
  container.innerHTML = `
    <button type="button" class="tools-menu-btn tools-menu-browse" id="tools-menu-browse" title="${tAttr('tools.browse.aria')}" aria-label="${tAttr('tools.browse.aria')}">
      <span class="tools-menu-btn-icon" aria-hidden="true">&#x1F5C2;&#xFE0E;</span>
      <span class="tools-menu-btn-label">${tHtml('tools.browse.label')}</span>
    </button>
    <button type="button" class="tools-menu-btn tools-menu-toggle" id="tools-menu-toggle" title="${tAttr('tools.toggle.aria')}" aria-label="${tAttr('tools.toggle.aria')}" aria-expanded="false" aria-haspopup="true">
      <span class="tools-menu-btn-icon" aria-hidden="true">&#x1F527;&#xFE0E;</span>
    </button>
    <button type="button" class="tools-menu-btn tools-menu-fullscreen" id="tools-menu-fullscreen" title="${tAttr('mapControls.fullscreen.enter')}" aria-label="${tAttr('mapControls.fullscreen.enter')}" aria-pressed="false">
      <span class="tools-menu-btn-icon" aria-hidden="true">&#x26F6;&#xFE0E;</span>
    </button>
    <div id="tools-menu-popover" class="tools-menu-popover hidden" role="dialog" aria-modal="false" aria-label="${tAttr('tools.toggle.aria')}">
      <div class="tools-menu-popover-header">
        <span class="tools-menu-popover-title">${tHtml('tools.popover.title')}</span>
        <button type="button" class="tools-menu-close" id="tools-menu-close" aria-label="${tAttr('tools.close.aria')}">&#x2715;</button>
      </div>
      <section class="tools-menu-section" aria-label="${tAttr('tools.section.view.aria')}">
        <h4 class="tools-menu-section-title">${tHtml('tools.section.view')}</h4>
        <button type="button" class="tools-menu-item" id="tools-menu-labels" aria-pressed="false">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">${tHtml('tools.toggles.labels')}</span>
        </button>
        <button type="button" class="tools-menu-item" id="tools-menu-borders" aria-pressed="false">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">${tHtml('tools.toggles.borders')}</span>
        </button>
        <button type="button" class="tools-menu-item" id="tools-menu-terrain" aria-pressed="false">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">${tHtml('tools.toggles.terrain')}</span>
        </button>
        <button type="button" class="tools-menu-item" id="tools-menu-autorotate" aria-pressed="false">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">${tHtml('tools.toggles.autoRotate')}</span>
        </button>
        <div class="tools-menu-subsep" aria-hidden="true"></div>
        <button type="button" class="tools-menu-item active" id="tools-menu-info" aria-pressed="true">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">${tHtml('tools.toggles.datasetInfo')}</span>
        </button>
        <button type="button" class="tools-menu-item active" id="tools-menu-legend" aria-pressed="true">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">${tHtml('tools.toggles.legend')}</span>
        </button>
      </section>
      <section class="tools-menu-section" aria-label="${tAttr('tools.uiScale.section.aria')}">
        <h4 class="tools-menu-section-title">${tHtml('tools.uiScale.section')}</h4>
        <div class="tools-menu-uiscale-row" role="group" aria-label="${tAttr('tools.uiScale.aria')}">
          <button type="button" class="tools-menu-uiscale-btn${currentUiScalePreset === 'compact' ? ' active' : ''}" id="tools-menu-uiscale-compact" aria-pressed="${currentUiScalePreset === 'compact'}" data-uiscale="compact">${tHtml('tools.uiScale.compact')}</button>
          <button type="button" class="tools-menu-uiscale-btn${currentUiScalePreset === 'default' ? ' active' : ''}" id="tools-menu-uiscale-default" aria-pressed="${currentUiScalePreset === 'default'}" data-uiscale="default">${tHtml('tools.uiScale.default')}</button>
          <button type="button" class="tools-menu-uiscale-btn${currentUiScalePreset === 'comfortable' ? ' active' : ''}" id="tools-menu-uiscale-comfortable" aria-pressed="${currentUiScalePreset === 'comfortable'}" data-uiscale="comfortable">${tHtml('tools.uiScale.comfortable')}</button>
        </div>
      </section>
      <section class="tools-menu-section" aria-label="${tAttr('tools.specular.section.aria')}">
        <h4 class="tools-menu-section-title">${tHtml('tools.specular.section')}</h4>
        <div class="tools-menu-uiscale-row" role="group" aria-label="${tAttr('tools.specular.aria')}">
          <button type="button" class="tools-menu-uiscale-btn${currentSpecular === 'none' ? ' active' : ''}" id="tools-menu-specular-none" aria-pressed="${currentSpecular === 'none'}" data-specular="none">${tHtml('tools.specular.none')}</button>
          <button type="button" class="tools-menu-uiscale-btn${currentSpecular === 'default' ? ' active' : ''}" id="tools-menu-specular-default" aria-pressed="${currentSpecular === 'default'}" data-specular="default">${tHtml('tools.specular.default')}</button>
          <button type="button" class="tools-menu-uiscale-btn${currentSpecular === 'comfortable' ? ' active' : ''}" id="tools-menu-specular-comfortable" aria-pressed="${currentSpecular === 'comfortable'}" data-specular="comfortable">${tHtml('tools.specular.comfortable')}</button>
        </div>
      </section>
      <section class="tools-menu-section" aria-label="${tAttr('tools.section.language.aria')}">
        <h4 class="tools-menu-section-title">${tHtml('tools.section.language')}</h4>
        <div class="tools-menu-language-row">
          <label for="tools-menu-language" class="sr-only">${tHtml('tools.language.aria')}</label>
          <select id="tools-menu-language" class="tools-menu-language-select" aria-label="${tAttr('tools.language.aria')}">
            ${localeOptions}
          </select>
        </div>
      </section>
      <section class="tools-menu-section" aria-label="${tAttr('tools.section.layout.aria')}">
        <h4 class="tools-menu-section-title">${tHtml('tools.section.layout')}</h4>
        <div class="tools-menu-layout-row" role="radiogroup" aria-label="${tAttr('tools.layout.aria')}">
          <button type="button" class="tools-menu-layout-btn${currentLayout === '1' ? ' active' : ''}" id="tools-menu-layout-1" aria-pressed="${currentLayout === '1'}" title="${tAttr('tools.layout.single')}">1</button>
          <button type="button" class="tools-menu-layout-btn${currentLayout === '2h' ? ' active' : ''}" id="tools-menu-layout-2h" aria-pressed="${currentLayout === '2h'}" title="${tAttr('tools.layout.twoHorizontal')}">2&#x2194;</button>
          <button type="button" class="tools-menu-layout-btn${currentLayout === '2v' ? ' active' : ''}" id="tools-menu-layout-2v" aria-pressed="${currentLayout === '2v'}" title="${tAttr('tools.layout.twoVertical')}">2&#x2195;</button>
          <button type="button" class="tools-menu-layout-btn${currentLayout === '4' ? ' active' : ''}" id="tools-menu-layout-4" aria-pressed="${currentLayout === '4'}" title="${tAttr('tools.layout.four')}">4</button>
        </div>
      </section>
      <section class="tools-menu-section" aria-label="${tAttr('tools.section.actions.aria')}">
        <h4 class="tools-menu-section-title">${tHtml('tools.section.actions')}</h4>
        <button type="button" class="tools-menu-item" id="tools-menu-clear">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">${tHtml('tools.actions.clear')}</span>
        </button>
        <button type="button" class="tools-menu-item" id="tools-menu-share">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">${tHtml('tools.actions.share')}</span>
        </button>
      </section>
      <section class="tools-menu-section" aria-label="${tAttr('tools.section.playlists.aria')}">
        <h4 class="tools-menu-section-title">${tHtml('tools.section.playlists')}</h4>
        <button type="button" class="tools-menu-item" id="tools-menu-playlists">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">${tHtml('tools.actions.playlists')}</span>
        </button>
      </section>
      <section class="tools-menu-section" aria-label="${tAttr('tools.section.orbit.aria')}">
        <h4 class="tools-menu-section-title">${tHtml('tools.section.orbit')}</h4>
        <button type="button" class="tools-menu-item" id="tools-menu-orbit-settings">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">${tHtml('tools.actions.orbitSettings')}</span>
        </button>
        ${gateMeetOrbit ? '' : `
        <a class="tools-menu-item tools-menu-item-link" id="tools-menu-meet-orbit" href="/orbit" target="_blank" rel="noopener">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">${tHtml('tools.actions.meetOrbit')}</span>
        </a>`}
      </section>
      <section class="tools-menu-section" aria-label="${tAttr('tools.section.about.aria')}">
        <h4 class="tools-menu-section-title">${tHtml('tools.section.about')}</h4>
        ${onOpenCredits ? `
        <button type="button" class="tools-menu-item" id="tools-menu-credits">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">${tHtml('tools.actions.credits')}</span>
        </button>` : ''}
        <button type="button" class="tools-menu-item" id="tools-menu-privacy">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">${tHtml('tools.actions.privacy')}</span>
        </button>
      </section>
    </div>
  `

  const browseBtn = document.getElementById('tools-menu-browse') as HTMLButtonElement
  const toggleBtn = document.getElementById('tools-menu-toggle') as HTMLButtonElement
  const closeBtn = document.getElementById('tools-menu-close') as HTMLButtonElement

  browseBtn.addEventListener('click', (ev) => {
    ev.stopPropagation()
    closePopover()
    onOpenBrowse?.()
  })

  toggleBtn.addEventListener('click', (ev) => {
    ev.stopPropagation()
    if (isOpen) {
      closePopover()
    } else {
      openPopover()
    }
  })

  closeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation()
    closePopover()
  })

  // Fullscreen toggle — Plan §3.3. Uses the Fullscreen API,
  // which Tauri's webview honours (the
  // `core:window:allow-set-fullscreen` capability is granted in
  // capabilities/default.json, so no fallback to the native
  // window API is required). `fullscreenchange` keeps the icon /
  // label in sync when the visitor exits via Escape or the
  // browser chrome.
  const fullscreenBtn = document.getElementById('tools-menu-fullscreen') as HTMLButtonElement | null
  fullscreenBtn?.addEventListener('click', (ev) => {
    ev.stopPropagation()
    closePopover()
    void toggleFullscreen()
  })
  if (!document.body.dataset.toolsMenuFullscreenWired) {
    document.body.dataset.toolsMenuFullscreenWired = 'true'
    document.addEventListener('fullscreenchange', syncFullscreenButton)
  }
  syncFullscreenButton()

  // Outside click closes the popover. We look up #map-controls
  // inside the handler rather than closing over the `container`
  // reference so re-init flows (tests, hot reload) don't leave
  // stale listeners pointing at detached DOM nodes.
  if (!document.body.dataset.toolsMenuListenersWired) {
    document.body.dataset.toolsMenuListenersWired = 'true'
    document.addEventListener('click', (ev) => {
      if (!isOpen) return
      const target = ev.target as Node | null
      if (!target) return
      const host = document.getElementById('map-controls')
      if (host && host.contains(target)) return
      closePopover()
    })
    // Escape closes the popover. Stop propagation so other handlers
    // (tour engine, chat) don't interpret the same keypress.
    document.addEventListener('keydown', (ev) => {
      if (!isOpen) return
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        closePopover()
        const toggle = document.getElementById('tools-menu-toggle') as HTMLButtonElement | null
        toggle?.focus()
      }
    })
    // Keep the Tools bar positioned above the playback transport
    // on window resize / orientation change.
    window.addEventListener('resize', updateMapControlsPosition)
  }

  // --- View toggles ---

  const labelsBtn = document.getElementById('tools-menu-labels') as HTMLButtonElement
  const bordersBtn = document.getElementById('tools-menu-borders') as HTMLButtonElement
  const terrainBtn = document.getElementById('tools-menu-terrain') as HTMLButtonElement
  const autoRotateBtn = document.getElementById('tools-menu-autorotate') as HTMLButtonElement
  const infoBtn = document.getElementById('tools-menu-info') as HTMLButtonElement
  const legendBtn = document.getElementById('tools-menu-legend') as HTMLButtonElement
  const clearBtn = document.getElementById('tools-menu-clear') as HTMLButtonElement
  const shareBtn = document.getElementById('tools-menu-share') as HTMLButtonElement
  const orbitSettingsBtn = document.getElementById('tools-menu-orbit-settings') as HTMLButtonElement
  const meetOrbitLink = document.getElementById('tools-menu-meet-orbit') as HTMLAnchorElement | null

  // Meet Orbit is a plain anchor with target="_blank" — native
  // navigation handles opening the character page. We just close
  // the popover so the main app goes back to its normal state and
  // announce for screen readers. No-op when Meet Orbit is gated off
  // (desktop build).
  meetOrbitLink?.addEventListener('click', () => {
    closePopover()
    announce?.(t('tools.announce.meetOrbit'))
  })

  // --- Language picker ---
  // Persists the choice and reloads — vanilla TS has no per-module
  // re-render hook, so reload is the sanctioned UX (see I18N_PLAN.md).
  const languageSelect = document.getElementById('tools-menu-language') as HTMLSelectElement | null
  languageSelect?.addEventListener('change', () => {
    const next = languageSelect.value as Locale
    saveLocalePref(next)
    window.location.reload()
  })

  // --- UI-size radio (§7.1) ---
  // Three discrete presets — Compact / Default / Comfortable. The
  // service writes to :root + localStorage; we only mirror the
  // active class so the radio's visual state stays in sync.
  const uiScaleButtons: Array<{ btn: HTMLButtonElement; preset: UiScalePreset }> = []
  for (const preset of Object.keys(UI_SCALE_PRESETS) as UiScalePreset[]) {
    const btn = document.getElementById(`tools-menu-uiscale-${preset}`) as HTMLButtonElement | null
    if (btn) uiScaleButtons.push({ btn, preset })
  }
  for (const { btn, preset } of uiScaleButtons) {
    btn.addEventListener('click', () => {
      setUiScale(UI_SCALE_PRESETS[preset])
      for (const other of uiScaleButtons) {
        const active = other.preset === preset
        other.btn.classList.toggle('active', active)
        other.btn.setAttribute('aria-pressed', String(active))
      }
      emitSetting('ui_scale', preset)
      announce?.(t('tools.uiScale.announce', { label: t(`tools.uiScale.${preset}`) }))
    })
  }

  // --- Specular preset radio (§7.2) ---
  // Three discrete presets — None / Default / Comfortable mirror the
  // plan-fixed names. The service writes the value into the shader-
  // settings snapshot + localStorage and fires a change event that
  // the earth-tile layer subscribes to via triggerRepaint, so the
  // glint updates on the next frame without waiting for camera motion.
  const specularButtons: Array<{ btn: HTMLButtonElement; preset: SpecularPreset }> = []
  for (const preset of Object.keys(SPECULAR_PRESETS) as SpecularPreset[]) {
    const btn = document.getElementById(`tools-menu-specular-${preset}`) as HTMLButtonElement | null
    if (btn) specularButtons.push({ btn, preset })
  }
  for (const { btn, preset } of specularButtons) {
    btn.addEventListener('click', () => {
      setSpecularPreset(preset)
      for (const other of specularButtons) {
        const active = other.preset === preset
        other.btn.classList.toggle('active', active)
        other.btn.setAttribute('aria-pressed', String(active))
      }
      emitSetting('specular', preset)
      announce?.(t('tools.specular.announce', { label: t(`tools.specular.${preset}`) }))
    })
  }

  labelsBtn.addEventListener('click', () => {
    // Target state is derived from the button class, not from any
    // renderer's reported state — newly-created siblings may still
    // be loading their style when the click fires. MapLibre queues
    // layer operations internally until the style is ready.
    const next = !labelsBtn.classList.contains('active')
    for (const r of viewports.getAll()) r.toggleLabels?.(next)
    setButtonState(labelsBtn, next)
    emitSetting('labels', next ? 'on' : 'off')
    announce?.(t(next ? 'tools.announce.labels.on' : 'tools.announce.labels.off'))
  })

  bordersBtn.addEventListener('click', () => {
    const next = !bordersBtn.classList.contains('active')
    for (const r of viewports.getAll()) r.toggleBoundaries?.(next)
    // Mirror to the shared preference so VR's per-frame poll picks
    // the same state up on its next frame. 2D-only sessions never
    // hit that getter, so the cost is just a localStorage write.
    setBordersVisible(next)
    setButtonState(bordersBtn, next)
    emitSetting('borders', next ? 'on' : 'off')
    announce?.(t(next ? 'tools.announce.borders.on' : 'tools.announce.borders.off'))
  })

  terrainBtn.addEventListener('click', () => {
    const next = !terrainBtn.classList.contains('active')
    for (const r of viewports.getAll()) {
      // toggleTerrain is not on the GlobeRenderer interface yet — cast
      // through the underlying MapRenderer which implements it.
      ;(r as unknown as { toggleTerrain?: (v: boolean) => void }).toggleTerrain?.(next)
    }
    setButtonState(terrainBtn, next)
    emitSetting('terrain', next ? 'on' : 'off')
    announce?.(t(next ? 'tools.announce.terrain.on' : 'tools.announce.terrain.off'))
  })

  autoRotateBtn.addEventListener('click', () => {
    // Auto-rotate is primary-only — MapLibre's easeTo is per-map and
    // the camera sync mirrors the primary's motion to siblings, so
    // auto-rotating the primary automatically spins them all.
    const primary = viewports.getPrimary()
    if (!primary) return
    const next = primary.toggleAutoRotate()
    setButtonState(autoRotateBtn, next)
    emitSetting('auto_rotate', next ? 'on' : 'off')
    announce?.(t(next ? 'tools.announce.autoRotate.on' : 'tools.announce.autoRotate.off'))
  })

  infoBtn.addEventListener('click', () => {
    const next = !infoBtn.classList.contains('active')
    setButtonState(infoBtn, next)
    onToggleDatasetInfo?.(next)
    emitSetting('dataset_info', next ? 'on' : 'off')
    announce?.(t(next ? 'tools.announce.datasetInfo.on' : 'tools.announce.datasetInfo.off'))
  })

  legendBtn.addEventListener('click', () => {
    const next = !legendBtn.classList.contains('active')
    setButtonState(legendBtn, next)
    onToggleLegend?.(next)
    emitSetting('legend', next ? 'on' : 'off')
    announce?.(t(next ? 'tools.announce.legend.on' : 'tools.announce.legend.off'))
  })

  clearBtn.addEventListener('click', () => {
    for (const r of viewports.getAll()) {
      r.clearMarkers?.()
      ;(r as unknown as { clearHighlights?: () => void }).clearHighlights?.()
    }
    announce?.(t('tools.announce.cleared'))
  })

  shareBtn.addEventListener('click', async () => {
    closePopover()
    const dataset = callbacks.getCurrentDataset?.()
    if (!dataset) {
      announce?.(t('tools.announce.noDatasetToShare'))
      return
    }
    const { shareDataset, buildDatasetShareUrl } = await import('../services/shareService')
    const shared = await shareDataset({
      title: dataset.title,
      text: t('tools.share.text', { title: dataset.title }),
      url: buildDatasetShareUrl(dataset.id),
    })
    if (shared) announce?.(t('tools.announce.shared'))
  })

  orbitSettingsBtn.addEventListener('click', () => {
    closePopover()
    onOpenOrbitSettings?.()
  })

  const playlistsBtn = document.getElementById('tools-menu-playlists') as HTMLButtonElement | null
  playlistsBtn?.addEventListener('click', () => {
    closePopover()
    openPlaylistManager()
  })

  // Credits button is only rendered when `onOpenCredits` is wired
  // (see template above). Skipping the listener entirely when the
  // callback is absent means there's no dead control in the DOM —
  // the About section just shows Privacy.
  if (onOpenCredits) {
    const creditsBtn = document.getElementById('tools-menu-credits') as HTMLButtonElement | null
    creditsBtn?.addEventListener('click', () => {
      closePopover()
      // Pass the Tools toggle button (which stays visible as the
      // popover's anchor) as the credits panel's focus-restore
      // target. The menu item itself is hidden by closePopover()
      // above, so it can't reliably receive focus on close.
      onOpenCredits(toggleBtn)
      announce?.(t('tools.announce.creditsOpened'))
    })
  }

  const privacyBtn = document.getElementById('tools-menu-privacy') as HTMLButtonElement | null
  privacyBtn?.addEventListener('click', () => {
    closePopover()
    openPrivacyUI(privacyBtn)
    announce?.(t('tools.announce.privacyOpened'))
  })

  // --- Layout picker (dev flag only) ---

  if (onSetLayout) {
    const layouts: ViewLayout[] = ['1', '2h', '2v', '4']
    const layoutBtns = new Map<ViewLayout, HTMLButtonElement>()
    for (const l of layouts) {
      const btn = document.getElementById(`tools-menu-layout-${l}`) as HTMLButtonElement | null
      if (btn) layoutBtns.set(l, btn)
    }
    for (const [layout, btn] of layoutBtns) {
      btn.addEventListener('click', () => {
        onSetLayout(layout)
        for (const [l, b] of layoutBtns) {
          const active = l === layout
          b.classList.toggle('active', active)
          b.setAttribute('aria-pressed', String(active))
        }
        announce?.(t('tools.announce.layout', { label: layoutLabel(layout) }))
      })
    }
  }

}

/** Open the popover and focus its close button for keyboard users. */
function openPopover(): void {
  const popover = document.getElementById('tools-menu-popover')
  const toggle = document.getElementById('tools-menu-toggle')
  if (!popover || !toggle) return
  popover.classList.remove('hidden')
  toggle.setAttribute('aria-expanded', 'true')
  isOpen = true
  const close = document.getElementById('tools-menu-close') as HTMLButtonElement | null
  close?.focus()
}

/** Close the popover. */
function closePopover(): void {
  const popover = document.getElementById('tools-menu-popover')
  const toggle = document.getElementById('tools-menu-toggle')
  if (!popover || !toggle) return
  popover.classList.add('hidden')
  toggle.setAttribute('aria-expanded', 'false')
  isOpen = false
}

/** Whether the popover is currently open — used by tests. */
export function isToolsMenuOpen(): boolean {
  return isOpen
}

/**
 * Briefly pulse the Browse button to draw the user's attention.
 * Called by main.ts after init on mobile (where the browse panel
 * starts closed so the globe is visible) so first-time users notice
 * where datasets live.
 *
 * The animation is a gentle halo that radiates outward for ~1.2s
 * per cycle and runs two cycles total. Tapping the button cancels
 * the animation immediately so the pulse doesn't keep drawing
 * attention after the user has already engaged. Respects
 * `prefers-reduced-motion` — users who've opted out see no
 * animation, just the button in its normal state.
 */
export function pulseBrowseButton(): void {
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return
  }
  const btn = document.getElementById('tools-menu-browse')
  if (!btn) return
  btn.classList.add('pulse-attention')
  const clearPulse = () => {
    btn.classList.remove('pulse-attention')
    btn.removeEventListener('click', clearPulse)
  }
  // Clear when the animation finishes naturally (2 cycles × 1.2s)
  window.setTimeout(clearPulse, 2600)
  // Or immediately if the user taps the button before it finishes
  btn.addEventListener('click', clearPulse, { once: true })
}

/** Sync a toggle button's `.active` class + aria-pressed to a bool. */
function setButtonState(btn: HTMLElement, active: boolean): void {
  btn.classList.toggle('active', active)
  btn.setAttribute('aria-pressed', String(active))
}

/**
 * Sync the toolbar button states to explicit values. Called by
 * main.ts after tours, goHome, layout changes, or when loading
 * persisted view preferences so the toolbar reflects the actual
 * renderer + preferences state.
 */
export function syncToolsMenuState(state: {
  labels?: boolean
  borders?: boolean
  terrain?: boolean
  autoRotate?: boolean
  datasetInfo?: boolean
  legend?: boolean
}): void {
  if (state.labels !== undefined) {
    const btn = document.getElementById('tools-menu-labels')
    if (btn) setButtonState(btn, state.labels)
  }
  if (state.borders !== undefined) {
    const btn = document.getElementById('tools-menu-borders')
    if (btn) setButtonState(btn, state.borders)
  }
  if (state.terrain !== undefined) {
    const btn = document.getElementById('tools-menu-terrain')
    if (btn) setButtonState(btn, state.terrain)
  }
  if (state.autoRotate !== undefined) {
    const btn = document.getElementById('tools-menu-autorotate')
    if (btn) setButtonState(btn, state.autoRotate)
  }
  if (state.datasetInfo !== undefined) {
    const btn = document.getElementById('tools-menu-info')
    if (btn) setButtonState(btn, state.datasetInfo)
  }
  if (state.legend !== undefined) {
    const btn = document.getElementById('tools-menu-legend')
    if (btn) setButtonState(btn, state.legend)
  }
}

/**
 * Sync the layout picker buttons to the given layout. Called by
 * main.ts when a layout change comes from a non-UI path (tours,
 * URL init, `setEnvView` API) so the picker buttons stay in sync.
 */
export function syncToolsMenuLayout(layout: ViewLayout): void {
  const layouts: ViewLayout[] = ['1', '2h', '2v', '4']
  for (const l of layouts) {
    const btn = document.getElementById(`tools-menu-layout-${l}`)
    if (btn) {
      const active = l === layout
      btn.classList.toggle('active', active)
      btn.setAttribute('aria-pressed', String(active))
    }
  }
}

/** Human-readable label for a layout value, used in announcements. */
function layoutLabel(layout: ViewLayout): string {
  switch (layout) {
    case '1': return t('tools.layout.single')
    case '2h': return t('tools.layout.twoHorizontal')
    case '2v': return t('tools.layout.twoVertical')
    case '4': return t('tools.layout.four')
  }
}
