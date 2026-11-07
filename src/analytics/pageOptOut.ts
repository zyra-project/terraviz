// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Whether this page load reports nothing: a cap on the telemetry tier
 * for the life of the page, below whatever the visitor stored and
 * never above it, and never written anywhere.
 *
 * It exists for the embedded view. An embed (`?embed=1`) shows no
 * first-run notice and no Tools menu, so it has no Privacy panel, and a
 * mode chosen on the node's own site does not reach a frame on another
 * site, because browsers partition its storage
 * (`docs/PRIVACY_ANALYSIS.md` §9l). The maintainer decided on
 * 6 November 2026 to give it two controls, and these are they:
 *
 * - **`telemetry=` in the address**, the switch a site embedding the
 *   app can set in its embed code. A single value reads the way the
 *   output page reads the same key (`src/output/webMode.ts`): only `1`
 *   or `true`, in any case, leaves reporting alone, and every other
 *   value, an empty one included, turns it off, so a misread fails
 *   toward off. Here it can only lower, which is why it is read more
 *   generously than the output page reads it: from the query **and**
 *   the part after `#` (where the grammar tells controllers to put
 *   session settings, so a host writing `#telemetry=0` must not get an
 *   embed that keeps reporting), and when the key appears more than
 *   once, in either, any value that turns it off wins. `telemetry=1`
 *   never raises a stored Off. It applies to any page of the app, not
 *   only an embed, since a kiosk or a demo may want it too.
 * - **Global Privacy Control, where no notice is shown.** In the embed
 *   view the browser's GPC signal is the only preference the app can
 *   hear, so it turns reporting off there. Elsewhere the notice and the
 *   Privacy panel are the visitor's controls, unchanged. The output
 *   page already honours GPC for itself (`src/output/webTelemetry.ts`).
 *
 * Pure reader plus a thin browser read. The emitter holds the latched
 * result (`optOutForPage`), and `main.ts` latches it at module
 * evaluation, before anything can emit or a URL writer can drop the key.
 */

import { getEmbedMode } from '../utils/embedMode'

/** Why this page reports nothing: its address said so, or the browser
 *  sent Global Privacy Control to an embed. */
export type PageOptOut = 'address' | 'gpc'

export interface PageOptOutInput {
  /** The page's query string, `location.search`. */
  search: string
  /** The part after `#`, `location.hash`; `''` when there is none. */
  hash?: string
  /** Whether the embed view is on (`getEmbedMode()`), the one view
   *  that shows no notice. */
  embed: boolean
  /** `navigator.globalPrivacyControl === true`. */
  gpc: boolean
}

/** Whether a `telemetry` value leaves reporting alone. */
function leavesOn(value: string): boolean {
  const lowered = value.toLowerCase()
  return lowered === '1' || lowered === 'true'
}

/**
 * The opt-out this page load asks for, or `null` for none. The address
 * is checked first, so a page with both reports `'address'`.
 */
export function readPageOptOut(input: PageOptOutInput): PageOptOut | null {
  const values = [
    ...new URLSearchParams(input.search).getAll('telemetry'),
    ...new URLSearchParams((input.hash ?? '').replace(/^#/, '')).getAll('telemetry'),
  ]
  if (values.some((value) => !leavesOn(value))) return 'address'
  if (input.embed && input.gpc) return 'gpc'
  return null
}

/** `readPageOptOut` over the running page. `null` outside a browser. */
export function pageOptOutFromBrowser(): PageOptOut | null {
  if (typeof window === 'undefined') return null
  const gpc =
    typeof navigator !== 'undefined' &&
    (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true
  return readPageOptOut({
    search: window.location.search,
    hash: window.location.hash,
    embed: getEmbedMode(),
    gpc,
  })
}
