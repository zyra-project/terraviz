/**
 * View preferences persistence — user choices about what parts of
 * the UI to show alongside the globe. Covers the Dataset info panel,
 * the per-dataset legend, and shared globe-overlay flags that need
 * to stay in sync between 2D (MapLibre) and VR (Three.js).
 *
 * Two access patterns are supported:
 *
 * 1. **Blob load/save.** `loadViewPreferences()` / `saveViewPreferences()`
 *    hand back and persist the full object. Used by initial bootstrap
 *    and by UI code that already tracks its own flag values.
 *
 * 2. **In-memory shared flags.** `getBordersVisible()` /
 *    `setBordersVisible()` (and future siblings) wrap a lazily-
 *    initialized module-level cache so VR can poll the value every
 *    frame without hitting localStorage. Setters persist through
 *    `saveViewPreferences()`. This is the pattern for tour-driven
 *    env toggles (`envShowWorldBorder`, `envShowClouds`, etc.) that
 *    need to bridge the 2D MapLibre surface and the VR Three.js
 *    scene without threading a new callback through every consumer.
 *
 * Defaults favour discovery for first-time users (info panel on,
 * legend on) and persist the user's override once they flip a
 * toggle. Invalid or missing values fall back to defaults silently.
 */

import { logger } from './logger'

const STORAGE_KEY = 'sos-view-prefs'

export interface ViewPreferences {
  /** Whether the dataset info panel (bottom-left) is visible. */
  infoPanelVisible: boolean
  /** Whether dataset legends are visible (inline in info panel or
   *  floating per-panel in multi-view). */
  legendVisible: boolean
  /**
   * Country/coastline borders overlay. Toggled from the Tools menu,
   * from tour `envShowWorldBorder` tasks, and reflected in VR as a
   * transparent-PNG shell on top of each globe. Defaults to false —
   * the 2D default for a freshly-loaded dataset is no borders, and
   * the Tools menu button starts inactive.
   */
  bordersVisible: boolean
  /**
   * Default placement mode for VR tour overlays. When true, panels
   * ride in front of the user's head (gaze-follow, subtitle-style)
   * instead of floating near the globe (world-anchored). Per-overlay
   * `anchor` hints in the tour JSON still win — this only sets the
   * default for overlays that don't specify. No UI toggle ships in
   * the initial release; tour authors typically control placement
   * via the per-overlay field, and this is kept as a programmatic
   * escape hatch for a future Tools-menu or HUD setting.
   */
  gazeFollowOverlays: boolean
}

const DEFAULTS: ViewPreferences = {
  infoPanelVisible: true,
  legendVisible: true,
  bordersVisible: false,
  gazeFollowOverlays: false,
}

/** Read preferences from localStorage, falling back to defaults. */
export function loadViewPreferences(): ViewPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw)
    return {
      infoPanelVisible: typeof parsed?.infoPanelVisible === 'boolean' ? parsed.infoPanelVisible : DEFAULTS.infoPanelVisible,
      legendVisible: typeof parsed?.legendVisible === 'boolean' ? parsed.legendVisible : DEFAULTS.legendVisible,
      bordersVisible: typeof parsed?.bordersVisible === 'boolean' ? parsed.bordersVisible : DEFAULTS.bordersVisible,
      gazeFollowOverlays: typeof parsed?.gazeFollowOverlays === 'boolean' ? parsed.gazeFollowOverlays : DEFAULTS.gazeFollowOverlays,
    }
  } catch (err) {
    logger.warn('[viewPreferences] Failed to parse, using defaults:', err)
    return { ...DEFAULTS }
  }
}

/**
 * Persist preferences to localStorage. Errors are logged but
 * ignored.
 *
 * Field-level-set flags (`bordersVisible`, `gazeFollowOverlays`)
 * are deliberately NOT written from the incoming blob — they're
 * re-read from the cache (the source of truth for flags that flow
 * through `setBordersVisible` / `setGazeFollowOverlays`). Without
 * this guard, a caller that holds a long-lived `ViewPreferences`
 * instance from a prior `loadViewPreferences()` — and later
 * re-saves it after toggling a different field — would clobber
 * any newer borders/gazeFollow state that was written field-by-
 * field in between (from the 2D Tools menu button, a tour's
 * `envShowWorldBorder` task, or future VR toggles).
 *
 * Blob callers that legitimately intend to change the shared flags
 * should use {@link setBordersVisible} / {@link setGazeFollowOverlays}
 * alongside this save — those setters update both the cache and
 * localStorage directly and aren't affected by the guard.
 */
export function saveViewPreferences(prefs: ViewPreferences): void {
  const current = ensureCache()
  const next: ViewPreferences = {
    ...prefs,
    bordersVisible: current.bordersVisible,
    gazeFollowOverlays: current.gazeFollowOverlays,
  }
  cache = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch (err) {
    logger.warn('[viewPreferences] Failed to save:', err)
  }
}

// ── In-memory shared flags ─────────────────────────────────────────
//
// Lazy-initialized module cache so VR's per-frame poll doesn't touch
// localStorage. Every getter resolves `cache` on first access;
// setters mutate it in place AND persist. Callers that already have
// a ViewPreferences instance (the UI bootstrap path) should keep
// using loadViewPreferences/saveViewPreferences — the in-memory
// cache stays coherent because setters update it.

let cache: ViewPreferences | null = null

function ensureCache(): ViewPreferences {
  if (!cache) cache = loadViewPreferences()
  return cache
}

/**
 * Current borders-overlay state. Cheap — reads from the in-memory
 * cache, which is safe to call every frame from the VR session poll.
 */
export function getBordersVisible(): boolean {
  return ensureCache().bordersVisible
}

/**
 * Update the shared borders flag. Callers:
 *
 * - The 2D Tools menu borders button handler (after toggling
 *   MapLibre layer visibility).
 * - The tour engine's `execWorldBorder` (after iterating renderers).
 * - Any future UI entry point that toggles borders.
 *
 * VR reads the flag via {@link getBordersVisible} every frame and
 * reflects it on its own globe shells — no additional wiring needed
 * here.
 *
 * Not idempotent at this layer — always writes to localStorage.
 * Downstream consumers that care (like `vrScene.setBordersVisible`)
 * already short-circuit repeat writes, and toggling borders is a
 * user-initiated action that happens rarely enough that a redundant
 * localStorage write is immaterial.
 */
export function setBordersVisible(visible: boolean): void {
  const current = ensureCache()
  current.bordersVisible = visible
  saveViewPreferences(current)
}

/**
 * Default placement mode for VR tour overlays. Read every frame by
 * vrSession → `tourOverlay.setGazeFollowDefault`. Per-overlay
 * `anchor` hints on individual tour tasks still win.
 */
export function getGazeFollowOverlays(): boolean {
  return ensureCache().gazeFollowOverlays
}

export function setGazeFollowOverlays(enabled: boolean): void {
  const current = ensureCache()
  current.gazeFollowOverlays = enabled
  saveViewPreferences(current)
}
