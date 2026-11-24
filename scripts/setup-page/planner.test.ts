// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CAPABILITIES,
  planNode,
  setupCommand,
  VIEWER_STEPS,
  type ActionsAnswer,
  type CapabilityId,
} from '../lib/setup/capabilities'
import {
  applyPlanner,
  assertPlannerPresent,
  EXPORT_STORAGE_KEY,
  PLAN_LOGIC,
  PLANNER_MARK,
  PLANNER_STORAGE_KEY,
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
const jsCommand = new Function(
  'features',
  'tier',
  'viewerSteps',
  `${PLAN_LOGIC}; return tvpCommand(features, tier, viewerSteps)`,
) as (features: string[], tier: number, viewerSteps: readonly string[]) => string

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
        expect(jsCommand(js.features, js.tier, VIEWER_STEPS)).toBe(
          setupCommand(ts.features, ts.tier),
        )
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

// The runtime as the page runs it: the section's markup, three stub
// tier buttons standing in for the export's picker, and the script.
describe('the runtime, executed', () => {
  let clicks: number[]

  function mount(stored?: { caps: string[]; actions: string | null }): void {
    localStorage.clear()
    if (stored) localStorage.setItem(PLANNER_STORAGE_KEY, JSON.stringify(stored))
    document.body.innerHTML =
      plannerSection() +
      [1, 2, 3].map(n => `<button data-tier="${n}">Tier ${n}</button>`).join('')
    clicks = []
    for (const b of Array.from(document.querySelectorAll('button[data-tier]'))) {
      b.addEventListener('click', () => clicks.push(Number(b.getAttribute('data-tier'))))
    }
    new Function(plannerRuntime())()
  }
  const box = (id: string) => document.getElementById(`tvp-cap-${id}`) as HTMLInputElement
  const radio = (v: string) => document.getElementById(`tvp-actions-${v}`) as HTMLInputElement
  const change = (input: HTMLInputElement, checked: boolean): void => {
    input.checked = checked
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }

  beforeEach(() => mount())

  it('ticks and locks what a choice implies, and frees it again', () => {
    change(box('video'), true)
    for (const id of ['publish', 'assets']) {
      expect(box(id).checked, id).toBe(true)
      expect(box(id).getAttribute('aria-disabled'), id).toBe('true')
      expect(box(id).disabled, id).toBe(false)
    }
    expect(document.querySelector('[data-tvp-implied="publish"]')?.textContent).toContain(
      'Included with',
    )
    change(box('video'), false)
    expect(box('publish').checked).toBe(false)
    expect(box('publish').hasAttribute('aria-disabled')).toBe(false)
  })

  it('refuses to untick an implied box', () => {
    change(box('video'), true)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    box('publish').dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
  })

  it('moves the tier picker when the answers move the tier, and only then', () => {
    change(box('feeds'), true)
    expect(clicks).toEqual([2])
    // The operator overrides by hand; a change that keeps Tier 2 must
    // not snap it back.
    ;(document.querySelector('button[data-tier="3"]') as HTMLButtonElement).click()
    change(radio('yes'), true)
    change(box('zyra'), true)
    expect(clicks).toEqual([2, 3])
    change(box('desktop'), true)
    expect(clicks).toEqual([2, 3, 3])
  })

  it('keeps the picker’s pressed state in step', () => {
    change(box('desktop'), true)
    const pressed = Array.from(document.querySelectorAll('button[data-tier]')).map(b =>
      b.getAttribute('aria-pressed'),
    )
    expect(pressed).toEqual(['false', 'false', 'true'])
  })

  it('claims no tier for an untouched form, including one cleared again', () => {
    expect(document.querySelector('[data-tvp-plan]')?.textContent).toContain('Tick what you want')
    change(box('analytics'), true)
    change(box('analytics'), false)
    expect(clicks).toEqual([2])
    expect(document.querySelector('[data-tvp-plan]')?.textContent).toContain('Tick what you want')
  })

  it('restores saved answers without moving the picker', () => {
    mount({ caps: ['zyra'], actions: 'no' })
    expect(box('zyra').checked).toBe(true)
    expect(radio('no').checked).toBe(true)
    expect(document.querySelector('[data-tvp-blocked="zyra"]')?.textContent).toContain(
      'Not possible without GitHub Actions',
    )
    expect(document.querySelector('[data-tvp-plan]')?.textContent).toContain(
      'Not possible without GitHub Actions',
    )
    expect(clicks).toEqual([])
  })

  it('ignores stored ids it does not know', () => {
    mount({ caps: ['teleport', 'feeds'], actions: 'sideways' })
    expect(box('feeds').checked).toBe(true)
    expect(radio('yes').checked || radio('no').checked || radio('unsure').checked).toBe(false)
  })
})
