// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Credits panel — Tools → Credits.
 *
 * Single canonical surface for every attribution TerraViz needs to
 * display: basemap providers (NASA GIBS, OpenMapTiles, OSM,
 * terrain) and per-dataset developer / source credits.
 *
 * Both kinds of credit ride the same MapLibre channel: source
 * `attribution` strings, read at render time from
 * `map.getStyle().sources[…].attribution`.
 *
 *   - Basemap sources already declare `attribution` in
 *     mapRenderer.ts's style spec; nothing changes there.
 *   - Dataset loads register a phantom GeoJSON source named
 *     `__dataset-credits` whose only payload is the attribution
 *     string. The source carries no features and no layers
 *     reference it; it exists only to feed its attribution into
 *     MapLibre's source-attribution pipeline. Unload removes it.
 *
 * The panel walks `map.getStyle().sources` for every viewport,
 * groups dataset attributions per panel and merges basemap
 * attributions across panels (they're the same on every panel
 * today). No subscription to viewportManager state — the
 * MapLibre source map IS the source of truth.
 *
 * Visual / interaction shape mirrors privacyUI: dark glass
 * surface, escape-to-close, focus-trap, click-out-to-close,
 * ARIA labelled.
 *
 * Design note vs the original PR description: the PR proposed
 * id-suffixed phantom sources (`__dataset-credits-${id}`) so that
 * a future multi-overlay-per-panel feature could carry several
 * attributions on one map. Each MapRenderer today renders at most
 * one dataset, so a single non-suffixed source per panel is
 * simpler — register replaces, clear removes — and the migration
 * to id-suffixed would be a localised one-file change inside this
 * module if the requirement materialises.
 */

import type { Dataset } from '../types'
import type { ViewportManager } from '../services/viewportManager'
import { escapeHtml, escapeAttr } from './domUtils'
import { t } from '../i18n'

/** Source id used for the phantom dataset-credits source on each
 *  MapRenderer. Single source per map — register replaces, clear
 *  removes. The double-underscore prefix marks it as
 *  internal/non-rendering. */
export const DATASET_CREDITS_SOURCE_ID = '__dataset-credits'

/** Source ids that should be excluded from the basemap section.
 *  Today only the phantom dataset-credits source needs filtering;
 *  a future feature might add more internal sources to skip. */
const NON_BASEMAP_SOURCE_IDS = new Set<string>([DATASET_CREDITS_SOURCE_ID])

// ---------------------------------------------------------------------------
// composeDatasetAttribution — assemble the credit string for one Dataset
// ---------------------------------------------------------------------------

/**
 * Compose a one-line attribution string for a Dataset, used as the
 * `attribution` field of the phantom dataset-credits source.
 *
 * The string is assembled from whichever metadata fields the
 * dataset actually carries — fields that aren't populated are
 * omitted rather than rendered as empty placeholders.
 *
 * Output shape (parts joined by " · "):
 *   - title (always)
 *   - "Data: <provider>" — `enriched.datasetDeveloper.name` if
 *     present, otherwise `organization`
 *   - "Vis: <name>" — `enriched.visDeveloper.name` if present
 *   - "Source: <url>" — `websiteLink` if present, otherwise
 *     `enriched.catalogUrl`
 *
 * The panel renders this string as a single line in the dataset's
 * "Loaded — Panel N" section. Future structured credits
 * (clickable affiliation URLs, per-line layout, license badges)
 * are an opt-in follow-up; for now MapLibre's flat string surface
 * keeps the model simple.
 *
 * Pure — no DOM access, no globals. Tested independently.
 */
export function composeDatasetAttribution(dataset: Dataset): string {
  const parts: string[] = [dataset.title]

  const dataDev = dataset.enriched?.datasetDeveloper?.name?.trim()
  const dataOrg = dataset.organization?.trim()
  const dataProvider = dataDev || dataOrg
  if (dataProvider) parts.push(`Data: ${dataProvider}`)

  const visDev = dataset.enriched?.visDeveloper?.name?.trim()
  if (visDev) parts.push(`Vis: ${visDev}`)

  const sourceUrl = dataset.websiteLink?.trim() || dataset.enriched?.catalogUrl?.trim()
  if (sourceUrl) parts.push(`Source: ${sourceUrl}`)

  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// Reading attributions back out of MapLibre
// ---------------------------------------------------------------------------

/** Minimal MapLibre map shape we depend on — just enough to read
 *  source attributions. Avoids a hard dependency on `maplibre-gl`
 *  in this module so unit tests can mock with plain objects. */
type AttributionReadableMap = {
  getStyle?: () => { sources?: Record<string, { attribution?: string } | undefined> | undefined } | undefined
}

/** Read every basemap attribution string declared on the map's
 *  current style, dropping the phantom dataset-credits source.
 *  De-duped — if multiple sources share an identical attribution
 *  (as Blue Marble + Black Marble might if they were ever combined),
 *  the panel shows it once. */
export function readBasemapAttributions(map: AttributionReadableMap | null): string[] {
  if (!map) return []
  const sources = map.getStyle?.()?.sources
  if (!sources) return []
  const out = new Set<string>()
  for (const [id, src] of Object.entries(sources)) {
    if (NON_BASEMAP_SOURCE_IDS.has(id)) continue
    const text = src?.attribution?.trim()
    if (text) out.add(text)
  }
  return Array.from(out)
}

/** Read the phantom dataset-credits source's attribution string,
 *  or null if no dataset is loaded on this panel. */
export function readDatasetAttribution(map: AttributionReadableMap | null): string | null {
  if (!map) return null
  const src = map.getStyle?.()?.sources?.[DATASET_CREDITS_SOURCE_ID]
  return src?.attribution?.trim() || null
}

// ---------------------------------------------------------------------------
// The Credits panel UI
// ---------------------------------------------------------------------------

let mounted = false
let lastTrigger: HTMLElement | null = null
let escHandler: ((ev: KeyboardEvent) => void) | null = null

/** Per-panel snapshot used to render the "Loaded" sections. */
interface PanelCreditsSnapshot {
  /** 1-based panel number for display ("Loaded — Panel 1"). */
  panelLabel: number
  /** Dataset attribution string, or null if the panel is empty. */
  datasetAttribution: string | null
}

/** Snapshot every panel's current credit state at render time.
 *  Pure read against MapLibre styles; no subscriptions. */
function snapshotPanelCredits(viewports: ViewportManager): {
  basemap: string[]
  panels: PanelCreditsSnapshot[]
} {
  const basemap = new Set<string>()
  const panels: PanelCreditsSnapshot[] = []

  // viewports.getAll() returns MapRenderer[]. Each MapRenderer
  // exposes getMap() returning MaplibreMap. We'd like to pass
  // the result straight into readBasemapAttributions, but
  // MapLibre's StyleSpecification.sources is keyed by a
  // SourceSpecification *discriminated union* — and one variant
  // (VideoSourceSpecification) has no `attribution` field, so
  // TypeScript refuses the structural narrowing the helpers want.
  // Cast at the renderer-by-renderer boundary to a structural
  // shape that exposes only what we need; runtime access is a
  // plain optional-chain and is safe regardless of variant.
  viewports.getAll().forEach((renderer, idx) => {
    const map = (renderer as unknown as { getMap: () => AttributionReadableMap | null }).getMap()
    for (const text of readBasemapAttributions(map)) {
      basemap.add(text)
    }
    panels.push({
      panelLabel: idx + 1,
      datasetAttribution: readDatasetAttribution(map),
    })
  })

  return { basemap: Array.from(basemap), panels }
}

// ---------------------------------------------------------------------------
// linkifyAttribution — render attribution text with clickable URLs
// ---------------------------------------------------------------------------

/** Match http / https URLs (whitespace-bounded). The attribution
 *  strings TerraViz produces always have URLs at the tail of a
 *  " · "-separated part, so trailing-punctuation edge cases don't
 *  arise in practice. */
const URL_RE = /(https?:\/\/[^\s]+)/g

/** Belt-and-suspenders scheme whitelist. The regex above only
 *  accepts http(s), but if a future regex change widens the
 *  match, this guard ensures only safe schemes ever land in
 *  href. Prevents `javascript:`, `data:`, `file:`, etc. */
const SAFE_URL_SCHEME = /^https?:\/\//i

/**
 * Render an attribution string as HTML where URLs become clickable
 * `<a target="_blank" rel="noopener noreferrer">` anchors and all
 * other text is HTML-escaped.
 *
 * Security guards (see PR #69 review thread):
 *   - URL_RE only matches `http://` / `https://`. Schemes like
 *     `javascript:` or `data:` never match, so they pass through
 *     the non-URL branch and get escaped as plain text.
 *   - SAFE_URL_SCHEME re-checks the matched URL before wrapping
 *     it — defense in depth in case the regex widens later.
 *   - escapeAttr on the href value prevents quote-break attribute
 *     injection from URLs containing `"` or `>`.
 *   - escapeHtml on the visible URL text and the surrounding
 *     non-URL segments prevents HTML/script injection from the
 *     publisher-supplied attribution.
 *   - rel="noopener noreferrer" defends against reverse
 *     tabnabbing and strips the Referer header to the destination.
 */
export function linkifyAttribution(text: string): string {
  let out = ''
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0]
    const start = m.index ?? 0
    if (start > last) {
      out += escapeHtml(text.slice(last, start))
    }
    if (SAFE_URL_SCHEME.test(url)) {
      out += `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`
    } else {
      // Unreachable today (URL_RE only matches http(s)), but kept
      // as defense-in-depth: if a future regex change ever widens
      // the match, an untrusted scheme still falls back to plain
      // text instead of becoming a hostile href.
      out += escapeHtml(url)
    }
    last = start + url.length
  }
  if (last < text.length) {
    out += escapeHtml(text.slice(last))
  }
  return out
}

/** Build the panel DOM. Returns the backdrop element so callers
 *  can add it to the document. */
function buildPanel(snapshot: ReturnType<typeof snapshotPanelCredits>, panelCount: number): HTMLElement {
  const backdrop = document.createElement('div')
  backdrop.id = 'credits-backdrop'
  backdrop.className = 'privacy-ui-backdrop'

  const panel = document.createElement('section')
  panel.id = 'credits-panel'
  panel.className = 'privacy-ui-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-labelledby', 'credits-panel-title')
  panel.tabIndex = -1

  const basemapHtml = snapshot.basemap.length
    ? snapshot.basemap.map(text => `<li>${linkifyAttribution(text)}</li>`).join('')
    : `<li class="credits-empty">${escapeHtml(t('credits.empty.basemap'))}</li>`

  // Hide empty per-panel sections in the single-panel case so the
  // "Loaded — Panel 1" header doesn't read as overkill. With
  // multiple panels the per-panel headings carry useful structure
  // even when individual panels are empty.
  const loadedHtml = snapshot.panels
    .map(p => {
      if (!p.datasetAttribution) {
        return panelCount > 1
          ? `<section class="credits-section">
               <h3 class="credits-section-title">${escapeHtml(t('credits.section.loadedPanel', { n: p.panelLabel }))}</h3>
               <p class="credits-empty">${escapeHtml(t('credits.empty.dataset'))}</p>
             </section>`
          : ''
      }
      const heading = panelCount > 1
        ? t('credits.section.loadedPanel', { n: p.panelLabel })
        : t('credits.section.loaded')
      return `<section class="credits-section">
                <h3 class="credits-section-title">${escapeHtml(heading)}</h3>
                <p class="credits-dataset">${linkifyAttribution(p.datasetAttribution)}</p>
              </section>`
    })
    .join('')

  panel.innerHTML = `
    <div class="privacy-ui-header">
      <h2 id="credits-panel-title">${escapeHtml(t('credits.title'))}</h2>
      <button type="button" id="credits-panel-close" class="privacy-ui-close" aria-label="${escapeAttr(t('credits.close.aria'))}">×</button>
    </div>
    <p class="privacy-ui-desc">${escapeHtml(t('credits.desc'))}</p>
    <section class="credits-section">
      <h3 class="credits-section-title">${escapeHtml(t('credits.section.basemap'))}</h3>
      <ul class="credits-list">${basemapHtml}</ul>
    </section>
    ${loadedHtml}
    <div class="privacy-ui-meta">
      <a class="privacy-ui-policy-link" href="https://github.com/zyra-project/terraviz/blob/main/MISSION.md" target="_blank" rel="noopener">${escapeHtml(t('credits.aboutLink'))}</a>
    </div>
  `

  backdrop.appendChild(panel)
  return backdrop
}

/** Open the credits panel. Idempotent — a second call while
 *  open is a no-op. The trigger element (typically the Tools
 *  menu item) gets focus restored on close. */
export function openCreditsPanel(
  viewports: ViewportManager,
  trigger: HTMLElement | null = null,
): void {
  if (mounted) return
  mounted = true
  lastTrigger = trigger

  const snapshot = snapshotPanelCredits(viewports)
  const backdrop = buildPanel(snapshot, viewports.getPanelCount())
  document.body.appendChild(backdrop)

  // Wire close affordances: backdrop click, X button, ESC + Tab
  // focus trap. ESC stops propagation so global ESC handlers
  // (e.g. fullscreen exit) don't fire alongside us; Tab cycles
  // focus between the first and last focusable elements inside
  // the panel so AT-driven keyboard nav can't escape the modal
  // while it's open. Mirrors the privacyUI dialog pattern.
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) closeCreditsPanel()
  })
  document
    .getElementById('credits-panel-close')
    ?.addEventListener('click', () => closeCreditsPanel())
  escHandler = (ev: KeyboardEvent) => {
    if (!mounted) return
    if (ev.key === 'Escape') {
      ev.stopPropagation()
      closeCreditsPanel()
    } else if (ev.key === 'Tab') {
      trapFocus(ev)
    }
  }
  document.addEventListener('keydown', escHandler)

  // Focus the panel itself so screen readers announce the dialog
  // and the ESC handler captures keys as soon as the user looks
  // at it.
  document.getElementById('credits-panel')?.focus()
}

/** Return focusable descendants of the credits panel, skipping
 *  disabled controls. Mirrors privacyUI.getFocusableInPanel. */
function getFocusableInPanel(): HTMLElement[] {
  const panel = document.getElementById('credits-panel')
  if (!panel) return []
  return Array.from(
    panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  )
}

/** Cycle Tab / Shift-Tab between the first and last focusable
 *  elements inside the modal so keyboard focus can't escape to
 *  the underlying page while the dialog is open. Required by
 *  `aria-modal="true"`. Mirrors privacyUI.trapFocus. */
function trapFocus(ev: KeyboardEvent): void {
  const focusables = getFocusableInPanel()
  if (focusables.length === 0) return
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  const active = document.activeElement as HTMLElement | null
  const panel = document.getElementById('credits-panel')
  const withinPanel = !!(active && panel?.contains(active))

  if (ev.shiftKey) {
    if (!withinPanel || active === first) {
      ev.preventDefault()
      last.focus()
    }
  } else {
    if (!withinPanel || active === last) {
      ev.preventDefault()
      first.focus()
    }
  }
}

/** Close the credits panel. Idempotent. Restores focus to the
 *  element that opened it. */
export function closeCreditsPanel(): void {
  if (!mounted) return
  mounted = false
  document.getElementById('credits-backdrop')?.remove()
  if (escHandler) {
    document.removeEventListener('keydown', escHandler)
    escHandler = null
  }
  if (lastTrigger instanceof HTMLElement) {
    lastTrigger.focus()
  }
  lastTrigger = null
}

/** True when the credits panel is open. Exported for tests and
 *  for the Tools menu's open/close state. */
export function isCreditsPanelOpen(): boolean {
  return mounted
}

/** Tear down. Idempotent. Exposed for tests. */
export function disposeCreditsPanel(): void {
  closeCreditsPanel()
}

// ---------------------------------------------------------------------------
// Phantom-source helpers (called from MapRenderer)
// ---------------------------------------------------------------------------
//
// MapRenderer.setDatasetCredits(dataset) calls these to register
// or clear the phantom source. They live here (rather than
// inline in MapRenderer) so the source-id constant, attribution
// composition, and the read paths above all stay in one module.

type MutableMap = {
  getSource: (id: string) => unknown
  removeSource: (id: string) => void
  addSource: (id: string, source: {
    type: 'geojson'
    data: { type: 'FeatureCollection'; features: [] }
    attribution: string
  }) => void
}

/** Register or replace the dataset-credits phantom source on a
 *  map. If `dataset` is null, removes any existing credits source.
 *  Otherwise builds the attribution string and sets the source.
 *  Idempotent — calling with the same dataset twice is a no-op
 *  beyond the redundant remove/add. */
export function setDatasetCreditsSource(
  map: MutableMap | null,
  dataset: Dataset | null,
): void {
  if (!map) return
  // Always clear first so swapping datasets doesn't pile up
  // sources or leak stale attributions.
  if (map.getSource(DATASET_CREDITS_SOURCE_ID)) {
    map.removeSource(DATASET_CREDITS_SOURCE_ID)
  }
  if (dataset) {
    map.addSource(DATASET_CREDITS_SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      attribution: composeDatasetAttribution(dataset),
    })
  }
}
