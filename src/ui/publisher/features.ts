/**
 * Portal-side helpers for the per-node feature toggles
 * (`src/types/node-features.ts`).
 *
 * `fetchFeatures()` is a module-cached read of the public
 * `GET /api/v1/node-profile` payload (which carries the toggle map) —
 * every gated page calls it first thing, so the cache keeps that to
 * one network read per portal load. Fail-open: any fetch problem
 * resolves to all-enabled, matching the server-side gate's semantics
 * (the API 403 is the real enforcement; this layer only avoids a
 * fetch-then-reject round-trip and renders the right card).
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

const FEATURES_ENDPOINT = '/api/v1/node-profile'

let cached: Promise<FeatureMap> | null = null

/** The node's feature toggles, cached for the life of the portal
 *  chunk. `resetFeaturesCache()` after a settings save (or in tests). */
export function fetchFeatures(options: { fetchFn?: typeof fetch } = {}): Promise<FeatureMap> {
  if (!cached) {
    cached = publisherGet<{ features?: unknown }>(FEATURES_ENDPOINT, options)
      .then(res => (res.ok ? normalizeFeatures(res.data.features) : defaultFeatures()))
      .catch(() => defaultFeatures())
  }
  return cached
}

/** Drop the cached toggle map — the next `fetchFeatures()` refetches. */
export function resetFeaturesCache(): void {
  cached = null
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
