// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Shared i18n bootstrap for entry points (`main.ts`, `orbitMain.ts`,
 * future entries). Synchronously initializes the runtime in English,
 * detects the user's preferred locale, lazy-loads its message chunk
 * if needed, then walks `data-i18n*` attributes on the live document
 * to apply the active translations to the static HTML shell.
 */

import { applyI18nAttributes } from './applyI18nAttributes'
import { detectLocale } from './detect'
import {
  initI18n,
  PICKER_LOCALES,
  setLocale,
  SOURCE_LOCALE,
  SUPPORTED_LOCALES,
  type Locale,
} from './index'

export async function bootstrapI18n(): Promise<Locale> {
  initI18n()
  const detected = detectLocale({
    supported: SUPPORTED_LOCALES,
    pickerSupported: PICKER_LOCALES,
    fallback: SOURCE_LOCALE,
  }) as Locale
  if (detected !== SOURCE_LOCALE) {
    await setLocale(detected)
  }
  applyI18nAttributes(document)
  return detected
}
