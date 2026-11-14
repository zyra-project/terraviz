// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The loading screen's tagline: the line under the Terraviz title,
 * which a node sets in its profile (`node_profile.tagline`, edited at
 * /publish/node-profile) and which otherwise reads the app's own
 * translated "Science On a Sphere" (`loading.subtitle`).
 *
 * The tagline arrives with the public node profile, after the splash
 * has painted, so the subtitle starts **held back**: `index.html`
 * marks it `data-tagline="pending"`, and `loading.css` hides it
 * (`visibility: hidden`, so a screen reader cannot read the default
 * either, with its line's space reserved) until
 * {@link bindSplashTagline} settles it. Showing the default and then
 * swapping in the node's own line would flash the wrong name on every
 * load of a node that set one, which is the case this exists for.
 *
 * Two deadlines bound the hold-back. The binder reveals the default
 * {@link SPLASH_TAGLINE_WAIT_MS} after the read **started** (main.ts
 * starts it before the i18n bootstrap, so a cold load's script and
 * locale downloads do not count against it). The CSS reveals it by
 * itself after a longer delay from first paint, a safety net for a
 * page whose boot never binds it (the portal and blog share this
 * shell) or a script that never runs. A tagline that lands after
 * either is still applied: the splash is usually up for seconds more,
 * and the operator's line is worth one late change.
 *
 * The operator's tagline is shown as written, in every locale: it is
 * usually an organization's name, which is not translated. It is set
 * through `textContent`, never markup, `data-i18n` is dropped so
 * nothing re-applies the default over it, and it is marked `lang=""`
 * (language unknown), so the page's locale does not case it — under
 * Turkish, `text-transform: uppercase` would dot the capital I of an
 * English name — and `dir="auto"`, so a left-to-right name ending in
 * punctuation lays out correctly on a right-to-left page. The line is
 * branding, not news, so it sits in no live region and its change is
 * never announced: the splash speaks only through its status line (or
 * the alert that replaces it when WebGL 2 is missing).
 * It once relied on a nested `aria-live="off"` inside an assertive
 * splash, which WebKit skips in favour of the next live ancestor.
 *
 * {@link splashTagline} answers the same question for the VR loading
 * scene (`vrLoading.ts`), which draws this line onto a canvas.
 */

import { t } from '../i18n'

/** The attribute `index.html` sets and `loading.css` holds back on. */
export const SPLASH_TAGLINE_PENDING_ATTR = 'data-tagline'

/** How long after the read starts the default is revealed if the node
 *  has not answered. A same-origin, KV-cached read normally answers in
 *  well under this. */
export const SPLASH_TAGLINE_WAIT_MS = 1500

/** The node's tagline, once the profile read has answered. */
let nodeTagline: string | null = null

/** The tagline the splash shows: the node's own, or the app's. */
export function splashTagline(): string {
  return nodeTagline ?? t('loading.subtitle')
}

/** True when {@link splashTagline} is the node's own line rather than
 *  the translated default — which decides whose casing rules apply. */
export function isNodeTagline(): boolean {
  return nodeTagline !== null
}

export interface BindSplashTaglineOptions {
  /** Reveal the default this long after the call if `tagline` has not
   *  settled. Omitted, only the settle (or the CSS) reveals it. */
  revealAfterMs?: number
  /** Settles once the default is in the visitor's language (the i18n
   *  bootstrap). The default is never revealed before it, so a page
   *  in another locale does not show the English line first; the
   *  node's own line, shown as written, does not wait. */
  defaultReady?: Promise<unknown>
}

/**
 * Settle the splash subtitle `el` from the node's tagline: write it in
 * when there is one, and reveal the line either way (the default once
 * `defaultReady` settles). Resolves once the tagline has settled;
 * never rejects, and a rejected `tagline` reveals the default.
 */
export async function bindSplashTagline(
  el: HTMLElement | null,
  tagline: Promise<string | null>,
  options: BindSplashTaglineOptions = {},
): Promise<void> {
  const reveal = (): void => el?.removeAttribute(SPLASH_TAGLINE_PENDING_ATTR)
  const ready = options.defaultReady ?? Promise.resolve()
  const revealDefault = (): void => {
    void ready.then(reveal, reveal)
  }
  const timer = options.revealAfterMs === undefined ? null : setTimeout(revealDefault, options.revealAfterMs)

  let value: string | null = null
  try {
    value = await tagline
  } catch {
    value = null
  }
  if (timer !== null) clearTimeout(timer)
  const text = typeof value === 'string' ? value.trim() : ''
  nodeTagline = text.length > 0 ? text : null
  if (el && nodeTagline) {
    writeNodeLine(el, nodeTagline)
    reveal()
  } else {
    revealDefault()
  }
}

/**
 * Write a node's own display line into `el`, which holds the app's
 * translated default: as text, never markup; with `data-i18n` dropped,
 * so nothing re-applies the default over it; `lang=""` (language
 * unknown), so the page's locale does not case it; and `dir="auto"`,
 * so a left-to-right line lays out on a right-to-left page. Shared
 * with the dataset browser's subtitle (`browseSubtitle.ts`).
 */
export function writeNodeLine(el: HTMLElement, text: string): void {
  el.removeAttribute('data-i18n')
  el.textContent = text
  el.lang = ''
  el.dir = 'auto'
}

/** Test seam: forget the node's tagline. */
export function resetSplashTaglineForTests(): void {
  nodeTagline = null
}
