// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Right-to-left locale list.
 *
 * No RTL locale ships in L1 — the set exists so {@link directionFor}
 * returns `'rtl'` once Arabic / Hebrew / etc. land in `locales/`.
 * The CSS audit (logical properties) tracked as L1.5 in
 * `docs/I18N_PLAN.md` blocks shipping any of these.
 */

const RTL_LOCALES: ReadonlySet<string> = new Set([
  'ar',
  'fa',
  'he',
  'ur',
])

/** Direction attribute value for an active locale. */
export function directionFor(locale: string): 'ltr' | 'rtl' {
  const base = locale.split('-')[0]?.toLowerCase() ?? locale
  return RTL_LOCALES.has(base) ? 'rtl' : 'ltr'
}
