// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CAPABILITIES,
  expandFeatures,
  planNode,
  SETUP_FEATURES,
  setupCommand,
  type CapabilityId,
} from './capabilities'

const WORKFLOWS = resolve(__dirname, '../../../.github/workflows')

/** The keys directly under a workflow's `on:` block. */
function triggers(file: string): string[] {
  const text = readFileSync(resolve(WORKFLOWS, file), 'utf8')
  const lines = text.split('\n')
  const start = lines.findIndex(l => /^on:\s*$/.test(l))
  if (start === -1) return []
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const m = /^ {2}([a-z_]+):/.exec(line)
    if (m) out.push(m[1])
  }
  return out
}

describe('the capability manifest', () => {
  // A workflow renamed or deleted would leave /setup, the handoff and
  // the guide telling operators to turn on a file that is not there.
  it('names only workflows that exist, with the trigger it claims', () => {
    const expected = { dispatch: 'repository_dispatch', schedule: 'schedule', manual: 'workflow_dispatch' }
    for (const cap of CAPABILITIES) {
      for (const w of cap.workflows) {
        expect(existsSync(resolve(WORKFLOWS, w.file)), w.file).toBe(true)
        expect(triggers(w.file), w.file).toContain(expected[w.trigger])
      }
    }
  })

  it('says a capability needs Actions exactly when it runs a workflow', () => {
    for (const cap of CAPABILITIES) {
      expect(cap.needs.includes('github-actions'), cap.id).toBe(cap.workflows.length > 0)
    }
  })

  // Forks start with scheduled workflows off; a capability that runs
  // one has to say so or the plan omits the step that makes it work.
  it('says a capability needs scheduled workflows exactly when it runs one', () => {
    for (const cap of CAPABILITIES) {
      const scheduled = cap.workflows.some(w => w.trigger === 'schedule')
      expect(cap.needs.includes('scheduled-workflows'), cap.id).toBe(scheduled)
    }
  })

  it('explains what breaks without Actions for every capability that needs them', () => {
    for (const cap of CAPABILITIES) {
      if (cap.needs.includes('github-actions')) expect(cap.withoutActions, cap.id).toBeTruthy()
    }
  })

  it('maps every setup feature to exactly one capability', () => {
    for (const feature of SETUP_FEATURES) {
      expect(CAPABILITIES.filter(c => c.feature === feature), feature).toHaveLength(1)
    }
  })

  it('implies only capabilities it lists, without cycles back to itself', () => {
    const ids = new Set(CAPABILITIES.map(c => c.id))
    for (const cap of CAPABILITIES) {
      for (const dep of cap.implies) {
        expect(ids.has(dep), `${cap.id} → ${dep}`).toBe(true)
        expect(dep).not.toBe(cap.id)
      }
    }
  })
})

describe('planNode', () => {
  const ids = (caps: { id: CapabilityId }[]) => caps.map(c => c.id)

  it('is a viewer node when nothing is wanted', () => {
    const plan = planNode([], 'yes')
    expect(plan.tier).toBe(1)
    expect(plan.have).toEqual([])
    expect(plan.requirements).toEqual([])
    expect(setupCommand(plan.features)).toBe('npm run setup -- --interactive')
  })

  it('brings in what a capability implies', () => {
    const plan = planNode(['video'], 'yes')
    expect(ids(plan.have)).toEqual(['publish', 'assets', 'video'])
    expect(plan.features).toEqual(['r2', 'transcode'])
    expect(plan.requirements).toEqual(['backend', 'r2-public', 'github-actions'])
    expect(plan.workflows.map(w => w.file)).toEqual(['transcode-hls.yml'])
  })

  // The case that prompted this: a clone of upstream, deployed by
  // Direct Upload, with nowhere to run Actions.
  it('blocks what needs Actions when the operator has none, and asks for nothing it needs', () => {
    const plan = planNode(['assets', 'video', 'zyra', 'feeds', 'analytics'], 'no')
    expect(ids(plan.have)).toEqual(['publish', 'assets'])
    expect(ids(plan.blocked)).toEqual(['video', 'zyra', 'feeds', 'analytics'])
    expect(plan.requirements).toEqual(['backend', 'r2-public'])
    expect(plan.workflows).toEqual([])
    expect(plan.features).toEqual(['r2'])
  })

  // The tier follows what is kept, so a blocked desktop app leaves a
  // publisher node rather than claiming Tier 3.
  it('keeps what a blocked wish implies when that needs no Actions', () => {
    const plan = planNode(['desktop'], 'no')
    expect(ids(plan.blocked)).toEqual(['desktop'])
    expect(ids(plan.have)).toEqual(['publish'])
    expect(plan.tier).toBe(2)
  })

  it('plans for what needs Actions when the operator is unsure, but flags it', () => {
    const plan = planNode(['feeds'], 'unsure')
    expect(ids(plan.have)).toEqual(['publish'])
    expect(ids(plan.atRisk)).toEqual(['feeds'])
    expect(plan.features).toEqual(['feeds'])
    expect(plan.requirements).toContain('scheduled-workflows')
  })

  it('reaches Tier 3 only through the desktop app', () => {
    expect(planNode(['zyra', 'feeds', 'analytics'], 'yes').tier).toBe(2)
    expect(planNode(['desktop'], 'yes').tier).toBe(3)
  })

  it('lists a workflow once however many capabilities share it', () => {
    const plan = planNode(['video', 'zyra', 'feeds', 'analytics', 'desktop'], 'yes')
    const files = plan.workflows.map(w => w.file)
    expect(new Set(files).size).toBe(files.length)
  })
})

describe('expandFeatures', () => {
  // Video and Zyra publish into R2; without the public bucket an
  // upload is accepted and can never be shown.
  it('brings r2 with the features that publish into the bucket', () => {
    expect([...expandFeatures(['transcode'])].sort()).toEqual(['r2', 'transcode'])
    expect([...expandFeatures(['zyra'])].sort()).toEqual(['r2', 'zyra'])
  })

  it('adds nothing to a feature that needs no bucket', () => {
    expect([...expandFeatures(['feeds'])]).toEqual(['feeds'])
  })
})
