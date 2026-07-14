/**
 * Portal-side helpers for the per-node feature toggles
 * (`src/types/node-features.ts`).
 *
 * `fetchFeatures()` is a module-cached read of the AUTHED
 * `GET /api/v1/publish/node-settings` endpoint — every gated page
 * calls it first thing, so the cache keeps that to one network read
 * per portal load. The authed endpoint matters: it answers
 * `private, no-store` straight from D1, so an admin's save is
 * visible on the very next read. (The toggle map also rides the
 * public `/api/v1/node-profile` payload, but that response is
 * `public, max-age=300` — the browser/edge would serve a stale
 * all-on copy for up to five minutes after a save, making the
 * portal's sidebar and page gates disagree with the already-updated
 * server gate. The public payload remains the right source for the
 * public blog SPA, where that propagation window is acceptable.)
 *
 * Fail-open: any fetch problem resolves to all-enabled, matching the
 * server-side gate's semantics (the API 403 is the real enforcement;
 * this layer only avoids a fetch-then-reject round-trip and renders
 * the right card).
 *
 * `renderFeatureDisabledCard()` is the disabled-state surface a gated
 * page renders instead of its content — the same card idiom as the
 * per-page "restricted" cards, plus a hint that an admin can
 * re-enable the feature under Node profile.
 */

import { t } from '../../i18n'
import {
  defaultFeatures,
  normalizeFeatures,
  type FeatureKey,
  type FeatureMap,
} from '../../types/node-features'
import { publisherGet } from './api'

/** Authed, `no-store` — reads D1 directly, fresh after every save. */
const SETTINGS_ENDPOINT = '/api/v1/publish/node-settings'
/** Public identity payload — fine for the org name, whose staleness
 *  (≤300 s browser/edge cache) is cosmetic. */
const IDENTITY_ENDPOINT = '/api/v1/node-profile'

/** Fired on `window` after an admin saves the toggle set, so the
 *  portal chrome can re-resolve and re-render the sidebar. */
export const FEATURES_CHANGE_EVENT = 'publisher:featureschange'

let cachedFeatures: Promise<FeatureMap> | null = null
let cachedOrgName: Promise<string | null> | null = null

/** The node's feature toggles, cached for the life of the portal
 *  chunk. `resetFeaturesCache()` after a settings save (or in tests). */
export function fetchFeatures(options: { fetchFn?: typeof fetch } = {}): Promise<FeatureMap> {
  if (!cachedFeatures) {
    cachedFeatures = publisherGet<{ features?: unknown }>(SETTINGS_ENDPOINT, options)
      .then(res => (res.ok ? normalizeFeatures(res.data.features) : defaultFeatures()))
      .catch(() => defaultFeatures())
  }
  return cachedFeatures
}

/** The public org name for the chrome footer, cached like the
 *  toggles. Deliberately the cacheable public read — a stale org
 *  name is harmless, unlike stale toggles. */
export function fetchPublicOrgName(options: { fetchFn?: typeof fetch } = {}): Promise<string | null> {
  if (!cachedOrgName) {
    cachedOrgName = publisherGet<{ profile?: { orgName?: string | null } | null }>(
      IDENTITY_ENDPOINT,
      options,
    )
      .then(res => (res.ok ? res.data.profile?.orgName ?? null : null))
      .catch(() => null)
  }
  return cachedOrgName
}

/** Drop the cached reads — the next read refetches. */
export function resetFeaturesCache(): void {
  cachedFeatures = null
  cachedOrgName = null
}

/** Localized display name for a feature key. */
export function featureLabel(feature: FeatureKey): string {
  switch (feature) {
    case 'events':
      return t('publisher.feature.events')
    case 'blog':
      return t('publisher.feature.blog')
    case 'hero':
      return t('publisher.feature.hero')
    case 'tours':
      return t('publisher.feature.tours')
    case 'workflows':
      return t('publisher.feature.workflows')
    case 'analytics':
      return t('publisher.feature.analytics')
    case 'feedback':
      return t('publisher.feature.feedback')
    case 'datasets':
      return t('publisher.feature.datasets')
  }
}

/**
 * Replace `mount` with the shared "this feature is turned off" card.
 * Gated pages call this (and return) before fetching their feature
 * API — deep links and typed URLs land here even though the sidebar
 * hides the tab; the API's 403 `feature_disabled` is the backstop.
 */
export function renderFeatureDisabledCard(mount: HTMLElement, feature: FeatureKey): void {
  const shell = document.createElement('main')
  shell.className = 'publisher-shell'

  const card = document.createElement('section')
  card.className = 'publisher-card publisher-glass publisher-feature-disabled'

  const heading = document.createElement('h2')
  heading.className = 'publisher-card-heading'
  heading.textContent = t('publisher.featureDisabled.title', { feature: featureLabel(feature) })
  card.appendChild(heading)

  const body = document.createElement('p')
  body.className = 'publisher-feature-disabled-body'
  body.textContent = t('publisher.featureDisabled.body', { feature: featureLabel(feature) })
  card.appendChild(body)

  shell.appendChild(card)
  mount.replaceChildren(shell)
}
