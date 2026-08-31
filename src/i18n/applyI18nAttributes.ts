// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * DOM walker that translates HTML markup carrying `data-i18n*`
 * attributes. Run once after DOMContentLoaded and again before each
 * locale-switch reload (so the page re-paints in the new locale on
 * the next load — see `setLocale()`).
 *
 * Supported attributes (each one accepts a message key):
 *
 *   - `data-i18n`              → element textContent
 *   - `data-i18n-aria-label`   → aria-label attribute
 *   - `data-i18n-title`        → title attribute
 *   - `data-i18n-placeholder`  → placeholder attribute
 *
 * If a key resolves to its raw form (i.e., no translation exists in
 * the active locale and no English fallback either), `t()` returns
 * the key string itself. We still write it so a missing key is
 * visible in the UI rather than silently leaving the source markup.
 */

import { t } from './index'

interface AttributeMapping {
  /** `data-` attribute that names the message key. */
  readonly dataAttr: string
  /** Either `'text'` (textContent) or the live attribute to set. */
  readonly target: 'text' | string
}

const MAPPINGS: readonly AttributeMapping[] = [
  { dataAttr: 'data-i18n', target: 'text' },
  { dataAttr: 'data-i18n-aria-label', target: 'aria-label' },
  { dataAttr: 'data-i18n-title', target: 'title' },
  { dataAttr: 'data-i18n-placeholder', target: 'placeholder' },
]

/**
 * Walk the subtree rooted at `root` and apply translations to every
 * element with a `data-i18n*` attribute. Idempotent — safe to call
 * multiple times for the same root (re-translation is a no-op on
 * locale stability).
 */
export function applyI18nAttributes(root: ParentNode = document): void {
  for (const mapping of MAPPINGS) {
    const selector = `[${mapping.dataAttr}]`
    const elements = root.querySelectorAll<HTMLElement>(selector)
    for (const el of elements) {
      const key = el.getAttribute(mapping.dataAttr)
      if (!key) continue
      // Cast — the runtime accepts arbitrary strings even when the
      // generated MessageKey union is narrower; `data-i18n` keys come
      // from authored HTML and are validated at runtime via fallback.
      const value = t(key as never)
      if (mapping.target === 'text') {
        el.textContent = value
      } else {
        el.setAttribute(mapping.target, value)
      }
    }
  }
}
