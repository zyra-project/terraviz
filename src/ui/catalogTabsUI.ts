/**
 * Catalog ↔ Sphere segmented control.
 *
 * A two-state segmented control pinned to the top of the viewport
 * that lets visitors flip between the dataset browser (Catalog tab)
 * and the loaded globe view (Sphere tab) once they've entered
 * catalog mode via `?catalog=true`. See
 * `docs/WEB_CATALOG_FEATURES_PLAN.md` §3.2.
 *
 * The control is feature-gated: it mounts on the first call to
 * `initCatalogTabs` but only becomes visible when
 * `showCatalogTabs()` is called. Caller in `main.ts` decides when
 * to show it (catalog mode is active) and which tab is active.
 *
 * This module owns DOM rendering and click wiring. It does NOT
 * touch the URL, body classes, or browse-panel visibility — those
 * live in `main.ts` so the state machine has a single source of
 * truth.
 */

import { t, tAttr } from '../i18n'
import { escapeHtml } from './domUtils'

export interface CatalogTabsCallbacks {
  /** User clicked the Catalog tab — open the browse panel and
   *  ensure `?catalog=true` is in the URL. */
  onSelectCatalog: () => void
  /** User clicked the Sphere tab — dismiss the browse panel and
   *  drop `?catalog=true` from the URL. */
  onSelectSphere: () => void
}

const HOST_ID = 'catalog-tabs'

/**
 * Mount the segmented control under `#ui`. Always rebuilds the
 * DOM — re-calls during a session (or in tests that reset the
 * document) replace whatever was there. Initial visibility is
 * hidden; `showCatalogTabs()` reveals it.
 */
export function initCatalogTabs(callbacks: CatalogTabsCallbacks): void {
  const ui = document.getElementById('ui')
  if (!ui) return

  const existing = document.getElementById(HOST_ID)
  if (existing) existing.remove()

  const host = document.createElement('div')
  host.id = HOST_ID
  host.className = 'catalog-tabs hidden'
  // ARIA: this is a two-state segmented control, not a true tab
  // pattern — there's no separate tabpanel element to control and
  // no arrow-key navigation between siblings. Use `role="group"` +
  // `aria-pressed` on each button, which is the WAI-ARIA pattern
  // for toggle-button groups. (Earlier draft used `role="tablist"`
  // / `role="tab"` / `aria-controls` without matching tabpanels —
  // caught by review, fixed here.)
  host.setAttribute('role', 'group')
  host.setAttribute('aria-label', tAttr('catalogTabs.aria'))
  host.innerHTML = `
    <button type="button"
            id="catalog-tab-catalog"
            class="catalog-tab"
            aria-pressed="true">
      ${escapeHtml(t('catalogTabs.catalog'))}
    </button>
    <button type="button"
            id="catalog-tab-sphere"
            class="catalog-tab"
            aria-pressed="false">
      ${escapeHtml(t('catalogTabs.sphere'))}
    </button>
  `

  ui.appendChild(host)

  host.querySelector<HTMLButtonElement>('#catalog-tab-catalog')
    ?.addEventListener('click', () => callbacks.onSelectCatalog())
  host.querySelector<HTMLButtonElement>('#catalog-tab-sphere')
    ?.addEventListener('click', () => callbacks.onSelectSphere())
}

function getHost(): HTMLElement | null {
  return document.getElementById(HOST_ID)
}

/** Reveal the tab control. */
export function showCatalogTabs(): void {
  getHost()?.classList.remove('hidden')
}

/** Hide the tab control without unmounting. */
export function hideCatalogTabs(): void {
  getHost()?.classList.add('hidden')
}

/**
 * Update which tab is visually active. Active = highlighted +
 * `aria-pressed=true`; inactive = subdued + `aria-pressed=false`.
 *
 * Caller decides which tab reflects the current state — typically
 * Catalog when the browse panel is the primary surface, Sphere
 * when the globe is.
 */
export function setActiveCatalogTab(tab: 'catalog' | 'sphere'): void {
  const host = getHost()
  if (!host) return
  const catalogBtn = host.querySelector<HTMLButtonElement>('#catalog-tab-catalog')
  const sphereBtn = host.querySelector<HTMLButtonElement>('#catalog-tab-sphere')
  if (!catalogBtn || !sphereBtn) return
  const catalogActive = tab === 'catalog'
  catalogBtn.classList.toggle('active', catalogActive)
  catalogBtn.setAttribute('aria-pressed', catalogActive ? 'true' : 'false')
  sphereBtn.classList.toggle('active', !catalogActive)
  sphereBtn.setAttribute('aria-pressed', !catalogActive ? 'true' : 'false')
}
