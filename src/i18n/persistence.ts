// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Locale preference persistence — mirrors `src/utils/viewPreferences.ts`.
 *
 * Stores the user's chosen locale tag under `sos-locale-prefs` in
 * localStorage. Validates against the supplied supported list on
 * read; an unknown stored value (e.g., a locale that was removed)
 * silently falls back to undefined so the caller can re-detect.
 */

import { logger } from '../utils/logger'

const STORAGE_KEY = 'sos-locale-prefs'

interface StoredPrefs {
  locale: string
}

/** Read the persisted locale, validated against the supported list. */
export function loadLocalePref(supported: readonly string[]): string | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Partial<StoredPrefs>
    const locale = typeof parsed?.locale === 'string' ? parsed.locale : undefined
    if (!locale) return undefined
    return supported.includes(locale) ? locale : undefined
  } catch (err) {
    logger.warn('[i18n.persistence] Failed to read locale pref:', err)
    return undefined
  }
}

/** Persist the active locale. Errors are logged but ignored. */
export function saveLocalePref(locale: string): void {
  try {
    const blob: StoredPrefs = { locale }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(blob))
  } catch (err) {
    logger.warn('[i18n.persistence] Failed to save locale pref:', err)
  }
}

/** Clear the stored preference — used by tests; not exposed via UI. */
export function clearLocalePref(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch (err) {
    logger.warn('[i18n.persistence] Failed to clear locale pref:', err)
  }
}
