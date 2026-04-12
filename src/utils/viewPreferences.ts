/**
 * View preferences persistence — user choices about what parts of
 * the UI to show alongside the globe. Currently covers the Dataset
 * info panel and the per-dataset legend. Stored under a single
 * localStorage key as JSON so the set can grow without proliferating
 * keys.
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
}

const DEFAULTS: ViewPreferences = {
  infoPanelVisible: true,
  legendVisible: true,
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
    }
  } catch (err) {
    logger.warn('[viewPreferences] Failed to parse, using defaults:', err)
    return { ...DEFAULTS }
  }
}

/** Persist preferences to localStorage. Errors are logged but ignored. */
export function saveViewPreferences(prefs: ViewPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch (err) {
    logger.warn('[viewPreferences] Failed to save:', err)
  }
}
