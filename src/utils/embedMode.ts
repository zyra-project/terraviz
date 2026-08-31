// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Embed mode — `?embed=1` minimal-chrome URL routing.
 *
 * Embed mode strips TerraViz's app chrome so the globe (or, in
 * catalog mode, the dataset browser) can be dropped into an
 * `<iframe>` on a host page — a WordPress post, a kiosk display,
 * the poster — without the surrounding navigation. It suppresses
 * the tools menu, help trigger, home button, the Orbit chat
 * trigger, and (outside catalog mode) the browse overlay and the
 * catalog↔sphere tab control. The globe and the playback transport
 * stay. The dataset/tour/catalog boot itself is unchanged — embed
 * mode composes with `?dataset=`, `?tour=`, and `?catalog=true`.
 *
 * This is a purely presentational mode: it applies body classes and
 * lets `src/styles/embed.css` hide the chrome. Nothing is torn out
 * of the boot path, so an embed and a full app load are the same
 * code with a different CSS surface.
 *
 * Grammar and the full flag list: `docs/EMBED_URL_GRAMMAR.md`.
 * Consumer context: `docs/WORDPRESS_INTEGRATION_PLAN.md` §3.
 */

/**
 * Read the embed-mode flag from the current URL. True when the URL
 * carries `?embed=1` (or any value other than the explicit opt-outs
 * `false` / `0`, case-insensitive), false otherwise — mirroring the
 * `?catalog=` convention in `catalogMode.ts` so the two flags parse
 * identically.
 */
export function getEmbedMode(): boolean {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  const raw = params.get('embed')
  if (raw === null) return false
  const lowered = raw.toLowerCase()
  return lowered !== 'false' && lowered !== '0'
}

/**
 * Whether the Orbit chat trigger should be kept in embed mode. Off
 * by default (a bare `?embed=1` is fully minimal); opt back in with
 * `?embed=1&chat=1` for a "dataset + ask Orbit" embed. Only
 * meaningful while embed mode is active — outside embed mode the
 * chat trigger shows regardless and this returns false.
 */
export function getEmbedShowChat(): boolean {
  if (!getEmbedMode()) return false
  const params = new URLSearchParams(window.location.search)
  const raw = params.get('chat')
  if (raw === null) return false
  const lowered = raw.toLowerCase()
  return lowered !== 'false' && lowered !== '0'
}

/**
 * Apply the embed-mode body classes if the URL calls for them.
 * Idempotent; safe to call once early in boot before any chrome
 * renders so the CSS surface decision is made on the first paint
 * rather than after a flash of full chrome. No-op when embed mode
 * is off. Returns whether embed mode was applied so the caller can
 * gate side effects (e.g. skipping the first-launch privacy
 * disclosure banner inside an embed).
 */
export function applyEmbedMode(): boolean {
  if (typeof document === 'undefined') return false
  if (!getEmbedMode()) return false
  document.body.classList.add('embed-mode')
  if (getEmbedShowChat()) document.body.classList.add('embed-show-chat')
  return true
}
