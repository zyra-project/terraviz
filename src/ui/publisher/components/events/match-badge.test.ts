/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest'
import {
  matchTone,
  toDisplayScore,
  renderMatchBadge,
  MATCH_STRONG_MIN,
  MATCH_MID_MIN,
} from './match-badge'

describe('matchTone', () => {
  it('maps scores to tones at the documented thresholds', () => {
    expect(matchTone(100)).toBe('strong')
    expect(matchTone(MATCH_STRONG_MIN)).toBe('strong')
    expect(matchTone(MATCH_STRONG_MIN - 1)).toBe('mid')
    expect(matchTone(MATCH_MID_MIN)).toBe('mid')
    expect(matchTone(MATCH_MID_MIN - 1)).toBe('weak')
    expect(matchTone(0)).toBe('weak')
  })

  it('treats null / non-finite as "na"', () => {
    expect(matchTone(null)).toBe('na')
    expect(matchTone(NaN)).toBe('na')
  })
})

describe('toDisplayScore', () => {
  it('converts a 0–1 signal to a whole 0–100 percent', () => {
    expect(toDisplayScore(0.91)).toBe(91)
    expect(toDisplayScore(1)).toBe(100)
    expect(toDisplayScore(0)).toBe(0)
  })
  it('passes null/undefined through', () => {
    expect(toDisplayScore(null)).toBeNull()
    expect(toDisplayScore(undefined)).toBeNull()
  })
})

describe('renderMatchBadge', () => {
  it('renders three facet tags + a composite, toned per threshold', () => {
    const badge = renderMatchBadge({ topic: 98, time: 95, geo: 40, composite: 98 })
    // The group carries an accessible name so screen readers announce it.
    expect(badge.getAttribute('role')).toBe('group')
    expect(badge.getAttribute('aria-label')).toBe('Match')
    const tags = badge.querySelectorAll('.publisher-events-match-tag')
    expect(tags).toHaveLength(3)
    // Topic 98 → strong, Geo 40 → weak.
    expect(tags[0].textContent).toBe('T 98')
    expect(tags[0].className).toContain('publisher-events-match-tag-strong')
    expect(tags[2].textContent).toBe('G 40')
    expect(tags[2].className).toContain('publisher-events-match-tag-weak')

    const composite = badge.querySelector('.publisher-events-match-composite')!
    expect(composite.textContent).toBe('98%')
    expect(composite.className).toContain('publisher-events-match-composite-strong')
  })

  it('renders null facets/composite as an em-dash with the neutral tone', () => {
    const badge = renderMatchBadge({ topic: 61, time: null, geo: null, composite: 61 })
    const tags = badge.querySelectorAll('.publisher-events-match-tag')
    // Topic 61 → mid (amber).
    expect(tags[0].className).toContain('publisher-events-match-tag-mid')
    // Time + Geo null → "—" + na tone.
    expect(tags[1].textContent).toBe('Ti —')
    expect(tags[1].className).toContain('publisher-events-match-tag-na')
    expect(tags[2].textContent).toBe('G —')
    const composite = badge.querySelector('.publisher-events-match-composite')!
    expect(composite.textContent).toBe('61%')
    expect(composite.className).toContain('publisher-events-match-composite-mid')
  })

  it('gives every tag + the composite an accessible label', () => {
    const badge = renderMatchBadge({ topic: 98, time: null, geo: 40, composite: 98 })
    const tags = badge.querySelectorAll('.publisher-events-match-tag')
    expect(tags[0].getAttribute('aria-label')).toBe('Topic 98 out of 100')
    expect(tags[1].getAttribute('aria-label')).toBe('Time not available')
    expect(badge.querySelector('.publisher-events-match-composite')!.getAttribute('aria-label')).toBe(
      'Overall match 98 out of 100',
    )
  })
})
