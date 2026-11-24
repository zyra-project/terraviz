// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CAPABILITIES,
  planNode,
  setupCommand,
  type ActionsAnswer,
  type CapabilityId,
} from '../lib/setup/capabilities'
import {
  applyPlanner,
  assertPlannerPresent,
  EXPORT_STORAGE_KEY,
  PLAN_LOGIC,
  PLANNER_MARK,
  plannerData,
  plannerRuntime,
  plannerSection,
} from './planner'

type JsPlan = {
  tier: number
  have: string[]
  blocked: string[]
  atRisk: string[]
  requirements: string[]
  workflows: Array<{ file: string }>
  features: string[]
}

// The page's plan, run from the same source the page carries.
const jsPlan = new Function(
  'D',
  'selected',
  'actions',
  `${PLAN_LOGIC}; return tvpPlan(D, selected, actions)`,
) as (d: unknown, selected: string[], actions: string) => JsPlan
const jsCommand = new Function('features', `${PLAN_LOGIC}; return tvpCommand(features)`) as (
  features: string[],
) => string

/** Every subset of the capabilities. */
function subsets(): CapabilityId[][] {
  const ids = CAPABILITIES.map(c => c.id)
  const out: CapabilityId[][] = []
  for (let mask = 0; mask < 1 << ids.length; mask++) {
    out.push(ids.filter((_, i) => mask & (1 << i)))
  }
  return out
}

describe('the page plan', () => {
  // The page has no bundler, so it carries planNode restated in plain
  // JavaScript. This is what keeps the two from drifting.
  it('agrees with planNode for every selection and answer', () => {
    const data = plannerData()
    const answers: ActionsAnswer[] = ['yes', 'no', 'unsure']
    let compared = 0
    for (const selected of subsets()) {
      for (const actions of answers) {
        const ts = planNode(selected, actions)
        const js = jsPlan(data, selected, actions)
        const ids = (caps: { id: string }[]) => caps.map(c => c.id)
        expect(
          {
            tier: js.tier,
            have: js.have,
            blocked: js.blocked,
            atRisk: js.atRisk,
            requirements: js.requirements,
            workflows: js.workflows.map(w => w.file),
            features: js.features,
          },
          `${selected.join(',') || '(none)'} / ${actions}`,
        ).toEqual({
          tier: ts.tier,
          have: ids(ts.have),
          blocked: ids(ts.blocked),
          atRisk: ids(ts.atRisk),
          requirements: ts.requirements,
          workflows: ts.workflows.map(w => w.file),
          features: ts.features,
        })
        expect(jsCommand(js.features)).toBe(setupCommand(ts.features))
        compared++
      }
    }
    expect(compared).toBe(3 * 2 ** CAPABILITIES.length)
  })
})

describe('plannerSection', () => {
  const html = plannerSection()

  it('offers one checkbox per capability, named by its title', () => {
    for (const cap of CAPABILITIES) {
      expect(html).toContain(`data-tvp-cap="${cap.id}"`)
      expect(html).toContain(`id="tvp-cap-${cap.id}-title"`)
    }
  })

  it('asks the GitHub Actions question as one radio group with three answers', () => {
    expect(html.match(/name="tvp-actions"/g)).toHaveLength(3)
    for (const v of ['yes', 'no', 'unsure']) expect(html).toContain(`value="${v}"`)
  })

  // A checkbox's accessible name is its title; the summary, needs and
  // "included with" note describe it. A label wrapping all of them
  // would read every word as the name.
  it('names each checkbox by its title and describes it by the rest', () => {
    expect(html).toContain('aria-labelledby="tvp-cap-video-title"')
    expect(html).toContain(
      'aria-describedby="tvp-cap-video-sum tvp-cap-video-needs tvp-cap-video-implied tvp-cap-video-blocked"',
    )
  })

  it('marks a capability that needs Actions on its card', () => {
    const video = html.slice(html.indexOf('tvp-cap-video'), html.indexOf('tvp-cap-zyra'))
    expect(video).toContain('GitHub Actions')
  })
})

describe('plannerRuntime', () => {
  // The tier buttons' aria-pressed starts from the export's stored
  // tier. An export that renamed its key would leave it out of step.
  it('reads the storage key the export actually uses', () => {
    const page = readFileSync(resolve(__dirname, '../../public/setup.html'), 'utf8')
    expect(page).toContain(`const KEY = '${EXPORT_STORAGE_KEY}'`)
  })

  it('is valid JavaScript', () => {
    expect(() => new Function(plannerRuntime())).not.toThrow()
  })

  it('cannot close its own script element', () => {
    expect(plannerRuntime()).not.toMatch(/<\/script/i)
  })
})

describe('applyPlanner', () => {
  const page = [
    '<body>',
    '<section data-noprint="1"><p>hero</p></section>',
    '<section data-noprint="1"><button data-tier="1">Tier 1</button><button data-tier="2">Tier 2</button></section>',
    '</body>',
  ].join('\n')

  it('puts the questions directly in front of the tier picker', () => {
    const { html, applied } = applyPlanner(page, 'data-tv-injected')
    expect(applied).toBe(true)
    const planner = html.indexOf(`${PLANNER_MARK}="1"`)
    const hero = html.indexOf('hero')
    const picker = html.indexOf('data-tier="1"')
    expect(hero).toBeLessThan(planner)
    expect(planner).toBeLessThan(picker)
    expect(html).toContain('data-tv-injected="planner"')
  })

  it('is idempotent', () => {
    const once = applyPlanner(page, 'data-tv-injected').html
    const twice = applyPlanner(once, 'data-tv-injected')
    expect(twice.applied).toBe(false)
    expect(twice.html).toBe(once)
  })

  it('leaves a fragment with no tier picker alone', () => {
    const fragment = '<body><p>no picker</p></body>'
    expect(applyPlanner(fragment, 'data-tv-injected')).toEqual({ html: fragment, applied: false })
  })

  // The build calls this, so a real page that lost its picker cannot
  // ship without its first question.
  it('fails the build on a page without the questions', () => {
    expect(() => assertPlannerPresent('<body><p>no picker</p></body>')).toThrow(/tier\s+picker/)
    expect(() => assertPlannerPresent(applyPlanner(page, 'data-tv-injected').html)).not.toThrow()
  })
})
