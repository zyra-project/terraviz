// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Initial-locale detection.
 *
 * Resolution order:
 *   1. Stored override from `loadLocalePref()` (user picked one)
 *   2. `?lang=` query param (lets us share localized links + aids QA)
 *   3. `navigator.languages[]` walked through the BCP-47 ladder
 *      (`pt-BR` → `pt` → fallback). Stops at the first supported tag.
 *   4. Default: the source locale (typically `'en'`).
 */

import { loadLocalePref } from './persistence'

export interface DetectOptions {
  /** Every locale the runtime can load. Used for the explicit-
   *  intent signals — `?lang=…` overrides and stored prefs —
   *  where the user (or a test rig) deliberately picked a locale
   *  and we should honor it even if coverage is low. */
  supported: readonly string[]
  /** Subset of `supported` that should also be eligible via
   *  browser auto-detect (`navigator.languages`). Defaults to
   *  `supported`. Production wires this to the ≥80%-coverage
   *  PICKER_LOCALES so a visitor with browser-set Arabic doesn't
   *  silently land on an empty Arabic UI — they fall through to
   *  English unless they explicitly opt in via `?lang=ar`. */
  pickerSupported?: readonly string[]
  fallback: string
  /** Override `navigator.languages` for tests. */
  navigatorLanguages?: readonly string[]
  /** Override `?lang=…` parsing for tests. */
  queryLang?: string | null
}

/** Walk the BCP-47 ladder for one tag against the supported set. */
export function pickFallback(
  tag: string,
  supported: readonly string[],
): string | undefined {
  if (!tag) return undefined
  const segments = tag.split('-')
  // Try progressively shorter tags: "zh-Hant-TW" → "zh-Hant" → "zh".
  for (let i = segments.length; i > 0; i--) {
    const candidate = segments.slice(0, i).join('-')
    if (supported.includes(candidate)) return candidate
    // Also try the lowercase base ("EN" → "en") to be defensive about
    // navigator/browser inconsistencies. We don't lowercase the whole
    // tag because BCP-47 region subtags are conventionally uppercase
    // and "en-US" is a different supported entry than "en-us".
    const lower = candidate.toLowerCase()
    if (lower !== candidate && supported.includes(lower)) return lower
  }
  return undefined
}

/** Resolve the initial locale given the user's environment. */
export function detectLocale(opts: DetectOptions): string {
  const { supported, fallback } = opts
  // Browser auto-detect uses the narrower picker-eligible set so
  // a low-coverage locale doesn't get auto-selected. Explicit
  // user signals (stored pref, `?lang=` override) still honor
  // the full `supported` list.
  const pickerSupported = opts.pickerSupported ?? supported

  // 1. Stored preference wins.
  const stored = safeLoadStored(supported)
  if (stored) return stored

  // 2. Query param ?lang=xx-YY.
  const queryLang = opts.queryLang ?? readQueryLang()
  if (queryLang) {
    const matched = pickFallback(queryLang, supported)
    if (matched) return matched
  }

  // 3. Walk navigator.languages — only match against
  //    picker-eligible locales (≥80% coverage in production).
  const navLangs = opts.navigatorLanguages ?? readNavigatorLanguages()
  for (const tag of navLangs) {
    const matched = pickFallback(tag, pickerSupported)
    if (matched) return matched
  }

  // 4. Final fallback.
  return fallback
}

function safeLoadStored(supported: readonly string[]): string | undefined {
  try {
    return loadLocalePref(supported)
  } catch {
    // SSR / non-browser test contexts may not have localStorage.
    return undefined
  }
}

function readQueryLang(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('lang')
  } catch {
    return null
  }
}

function readNavigatorLanguages(): readonly string[] {
  try {
    if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
      return navigator.languages
    }
    if (typeof navigator.language === 'string') {
      return [navigator.language]
    }
  } catch {
    // No navigator (SSR / scripts).
  }
  return []
}
