/**
 * "Right now" hero panel UI — Phase 7 §9.1 of
 * `docs/WEB_CATALOG_FEATURES_PLAN.md`.
 *
 * Renders a single pinned hero card above the chip rail on the
 * catalog landing surface (catalog mode only). The candidate comes
 * from `heroService.getHeroCandidate()` — a curator override or a
 * fresh real-time dataset. When nothing qualifies the panel hides
 * entirely (no "nothing happening today" message); the surface below
 * shifts up to fill the space.
 *
 * Mounts into the static `#hero-panel` element declared in
 * `index.html` (hidden by default). Clicking the card loads the
 * dataset through the same callback the browse grid uses. A subtle
 * dismiss button hides the panel for the rest of the session
 * (per-session, not persisted — it reappears next launch).
 *
 * Lifecycle mirrors the floating-panel idioms used elsewhere
 * (`playlistUI`, `downloadDialogUI`): an AbortController guards the
 * async candidate resolution so closing/leaving the catalog mid-fetch
 * can't render a stale hero, and `destroyHeroPanel()` is the
 * symmetric teardown for `renderHeroPanel()`.
 */

import type { Dataset } from '../types'
import { getHeroCandidate, type HeroCandidate } from '../services/heroService'
import { escapeHtml, escapeAttr } from './domUtils'
import { t } from '../i18n'
import { logger } from '../utils/logger'

/** Options for a hero render pass. */
export interface HeroPanelOptions {
  datasets: readonly Dataset[]
  /** Load a dataset — the same handler the browse grid's Load uses. */
  onSelect: (id: string) => void
  /** Only catalog mode shows the hero; pass `getCatalogMode()`. */
  isCatalogMode: boolean
}

/** Session-scoped dismiss flag. Not persisted — a dismissed hero
 *  reappears on the next launch. */
let dismissed = false

/** Guards the async candidate resolution against a render that's been
 *  superseded (or a catalog close) mid-fetch. */
let activeController: AbortController | null = null

function hostEl(): HTMLElement | null {
  return document.getElementById('hero-panel')
}

function hide(host: HTMLElement): void {
  host.classList.add('hidden')
  host.setAttribute('aria-hidden', 'true')
  host.innerHTML = ''
}

/**
 * Resolve and render the hero. No-ops to hidden when not in catalog
 * mode, when the user has dismissed it this session, or when no
 * candidate qualifies. Safe to call repeatedly — each call aborts the
 * previous in-flight resolution.
 */
export async function renderHeroPanel(opts: HeroPanelOptions): Promise<void> {
  const host = hostEl()
  if (!host) return

  // Abort any prior in-flight resolution before starting a new one.
  activeController?.abort()

  if (!opts.isCatalogMode || dismissed) {
    activeController = null
    hide(host)
    return
  }

  const controller = new AbortController()
  activeController = controller

  let candidate: HeroCandidate | null = null
  try {
    candidate = await getHeroCandidate(opts.datasets, { signal: controller.signal })
  } catch (err) {
    logger.warn('[hero] candidate resolution failed:', err)
  }

  // A newer render (or a dismiss/close) superseded us — drop this result.
  if (activeController !== controller || controller.signal.aborted) return

  if (!candidate) {
    hide(host)
    return
  }

  renderCard(host, candidate, opts.onSelect)
}

function renderCard(
  host: HTMLElement,
  candidate: HeroCandidate,
  onSelect: (id: string) => void,
): void {
  const { dataset, headline } = candidate
  const title = headline && headline.length > 0 ? headline : dataset.title
  const thumb = dataset.thumbnailLink
    ? `<img class="hero-panel-thumb" src="${escapeAttr(dataset.thumbnailLink)}" alt="" loading="lazy">`
    : ''

  host.innerHTML =
    `<div class="hero-panel-inner">`
    + `<button type="button" class="hero-panel-dismiss" aria-label="${escapeAttr(t('browse.hero.dismiss.aria'))}">&#x2715;</button>`
    + `<button type="button" class="hero-panel-card" data-id="${escapeAttr(dataset.id)}"`
    + ` aria-label="${escapeAttr(t('browse.card.load.aria', { title }))}">`
    + thumb
    + `<span class="hero-panel-text">`
    + `<span class="hero-panel-eyebrow">${escapeHtml(t('browse.hero.heading'))}</span>`
    + `<span class="hero-panel-title">${escapeHtml(title)}</span>`
    + `<span class="hero-panel-badge">${escapeHtml(t('browse.hero.label'))}</span>`
    + `</span>`
    + `</button>`
    + `</div>`
  host.classList.remove('hidden')
  host.removeAttribute('aria-hidden')

  host.querySelector('.hero-panel-card')?.addEventListener('click', () => {
    onSelect(dataset.id)
  })
  host.querySelector('.hero-panel-dismiss')?.addEventListener('click', (e) => {
    e.stopPropagation()
    dismissed = true
    activeController?.abort()
    activeController = null
    hide(host)
  })
}

/** Symmetric teardown — abort any in-flight fetch and clear the host.
 *  Does NOT reset the session dismiss flag. */
export function destroyHeroPanel(): void {
  activeController?.abort()
  activeController = null
  const host = hostEl()
  if (host) hide(host)
}

/** Test-only — reset the session dismiss flag + in-flight controller.
 *  Aborts any in-flight fetch first so a late resolution can't render
 *  into the DOM after a test has moved on. */
export function resetHeroPanelForTests(): void {
  dismissed = false
  activeController?.abort()
  activeController = null
}
