// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The loading screen's tagline: the line under the TerraViz title,
 * which a node sets in its profile (`node_profile.tagline`, edited at
 * /publish/node-profile) and which otherwise reads the app's own
 * translated "Science On a Sphere" (`loading.subtitle`).
 *
 * The tagline arrives with the public node profile, after the splash
 * has painted, so the subtitle starts **held back**: `index.html`
 * marks it `data-tagline="pending"`, and `loading.css` keeps it
 * invisible (its space reserved, so nothing shifts) until
 * {@link bindSplashTagline} settles it. Showing the default and then
 * swapping in the node's own line would flash the wrong name on every
 * load of a node that set one, which is the case this exists for. The
 * same CSS reveals the line on its own after a short delay, so a slow
 * read, or a page whose boot never binds it (the portal and blog
 * share this shell), never leaves it hidden. A tagline that lands
 * after that is still applied: the splash is usually up for seconds
 * more, and the operator's line is worth one late change.
 *
 * The operator's tagline is shown as written, in every locale: it is
 * usually an organization's name, which is not translated. It is set
 * through `textContent`, never markup, and `data-i18n` is dropped
 * from the element so nothing re-applies the default over it.
 *
 * {@link splashTagline} answers the same question for the VR loading
 * scene (`vrLoading.ts`), which draws this line onto a canvas.
 */

import { t } from '../i18n'

/** The attribute `index.html` sets and `loading.css` holds back on. */
export const SPLASH_TAGLINE_PENDING_ATTR = 'data-tagline'

/** The node's tagline, once the profile read has answered. */
let nodeTagline: string | null = null

/** The tagline the splash shows: the node's own, or the app's. */
export function splashTagline(): string {
  return nodeTagline ?? t('loading.subtitle')
}

/**
 * Settle the splash subtitle `el` from the node's tagline: write it in
 * when there is one, then reveal the line either way. Resolves once
 * done; never rejects, and a rejected `tagline` reveals the default.
 */
export async function bindSplashTagline(
  el: HTMLElement | null,
  tagline: Promise<string | null>,
): Promise<void> {
  let value: string | null = null
  try {
    value = await tagline
  } catch {
    value = null
  }
  const text = typeof value === 'string' ? value.trim() : ''
  nodeTagline = text.length > 0 ? text : null
  if (!el) return
  if (nodeTagline) {
    el.removeAttribute('data-i18n')
    el.textContent = nodeTagline
  }
  el.removeAttribute(SPLASH_TAGLINE_PENDING_ATTR)
}

/** Test seam: forget the node's tagline. */
export function resetSplashTaglineForTests(): void {
  nodeTagline = null
}
