// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The dataset browser's subtitle: the line under the Terraviz title in
 * the browse panel, which a node sets in its profile
 * (`node_profile.browse_subtitle`, edited at /publish/node-profile) and
 * which otherwise reads the app's own translated "Browse environmental
 * datasets from NOAA Science On a Sphere" (`browse.subtitle`).
 *
 * The line arrives with the public node profile the loading screen's
 * tagline comes from (`nodeFeatures`), and is written in when that
 * read answers, as the node's own text (`writeNodeLine`: through
 * `textContent`, shown as written in every locale). Unlike the
 * tagline it needs no hold-back, and the reason is an ordering in
 * `main.ts`'s `initialize`: it awaits this read's `settle()` (for
 * Orbit) before any path reveals the browse panel, and `settle` either
 * has the answer or aborts the read. A line the read delivers after
 * that abort is dropped (`nodeFeatures`), so the default stays. So the
 * line is settled before the panel is on screen or in the
 * accessibility tree. Moving that wait later (making chat set-up lazy,
 * say) would reopen a visible swap here. A read that fails leaves the
 * default in place.
 */

import { writeNodeLine } from './splashTagline'

/** Write the node's browse subtitle into `el` once `subtitle` settles;
 *  leave the default for null, an empty line, or a rejected read.
 *  Never rejects. */
export async function bindBrowseSubtitle(
  el: HTMLElement | null,
  subtitle: Promise<string | null>,
): Promise<void> {
  let value: string | null = null
  try {
    value = await subtitle
  } catch {
    return
  }
  const text = typeof value === 'string' ? value.trim() : ''
  if (el && text) writeNodeLine(el, text)
}
