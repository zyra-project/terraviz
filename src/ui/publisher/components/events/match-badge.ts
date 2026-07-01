/**
 * The **Match Badge** — the shared visual primitive of the Events tab
 * redesign (`docs/events-tab-handoff/EVENTS_TAB_IMPLEMENTATION_BRIEF.md`
 * §5). It replaces the old "mashed text run" ("Match 100%Topic —Time
 * 100%Geo") with three per-facet tags (Topic / Time / Geo) plus one
 * composite percentage, each colour-graded by the same thresholds.
 *
 * Pure + framework-free: `renderMatchBadge` builds a detached DOM node,
 * and `matchTone` is exported so the store + tests can reason about
 * tone without the DOM. Values are on the **display scale (0–100)** —
 * the caller multiplies the backend's 0–1 `signals` / `score` by 100.
 * `null` renders as an em-dash ("—") and a neutral tone (the matcher
 * leaves geo `null` until dataset bounding boxes land, so "—" is the
 * common real case).
 */

import { t } from '../../../../i18n'

/** Composite/facet ≥ this is a strong match (green). */
export const MATCH_STRONG_MIN = 85
/** Composite/facet in `[MATCH_MID_MIN, MATCH_STRONG_MIN)` is a mid
 *  match that wants a human look (amber); below is weak (red). */
export const MATCH_MID_MIN = 60

export type MatchTone = 'strong' | 'mid' | 'weak' | 'na'

export interface MatchScores {
  /** Topical (lexical) relevance, 0–100 or null. */
  topic: number | null
  /** Temporal alignment, 0–100 or null. */
  time: number | null
  /** Geographic overlap, 0–100 or null. */
  geo: number | null
  /** Composite overall match, 0–100 or null. */
  composite: number | null
}

/** Resolve a 0–100 score (or null) to a colour tone. */
export function matchTone(score: number | null): MatchTone {
  if (score == null || !Number.isFinite(score)) return 'na'
  if (score >= MATCH_STRONG_MIN) return 'strong'
  if (score >= MATCH_MID_MIN) return 'mid'
  return 'weak'
}

/** Convert a backend 0–1 signal/score to the display 0–100 scale, or
 *  pass through `null`. Rounds to a whole percent. */
export function toDisplayScore(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw)) return null
  return Math.round(raw * 100)
}

interface Facet {
  /** Compact visible abbreviation (T / Ti / G). */
  abbr: string
  /** Full facet name for the accessible label. */
  full: string
  value: number | null
}

function facetTag(facet: Facet): HTMLElement {
  const tone = matchTone(facet.value)
  const display = facet.value == null ? '—' : String(facet.value)
  const tag = document.createElement('span')
  tag.className = `publisher-events-match-tag publisher-events-match-tag-${tone}`
  // Visible: compact "T 98"; accessible: "Topic 98 out of 100".
  tag.textContent = `${facet.abbr} ${display}`
  tag.setAttribute(
    'aria-label',
    facet.value == null
      ? t('publisher.events.match.facetNa', { facet: facet.full })
      : t('publisher.events.match.facetAria', { facet: facet.full, value: String(facet.value) }),
  )
  return tag
}

/**
 * Render the compact-row Match Badge (the form used in A's dataset
 * rows and C's table): three facet tags + a right-aligned composite %.
 */
export function renderMatchBadge(scores: MatchScores): HTMLElement {
  const badge = document.createElement('span')
  badge.className = 'publisher-events-match-badge'
  badge.setAttribute('role', 'group')
  // Name the group so the facet tags read as belonging to "Match".
  badge.setAttribute('aria-label', t('publisher.events.match'))

  badge.append(
    facetTag({ abbr: t('publisher.events.match.topicAbbr'), full: t('publisher.events.signal.topic'), value: scores.topic }),
    facetTag({ abbr: t('publisher.events.match.timeAbbr'), full: t('publisher.events.signal.temporal'), value: scores.time }),
    facetTag({ abbr: t('publisher.events.match.geoAbbr'), full: t('publisher.events.signal.geo'), value: scores.geo }),
  )

  const composite = document.createElement('span')
  const tone = matchTone(scores.composite)
  composite.className = `publisher-events-match-composite publisher-events-match-composite-${tone}`
  composite.textContent = scores.composite == null ? '—' : `${scores.composite}%`
  composite.setAttribute(
    'aria-label',
    scores.composite == null
      ? t('publisher.events.match.compositeNa')
      : t('publisher.events.match.compositeAria', { value: String(scores.composite) }),
  )
  badge.append(composite)
  return badge
}
