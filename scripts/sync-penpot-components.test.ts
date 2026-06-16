import { describe, it, expect } from 'vitest'
import {
  buildComponentTokenSets,
  buildPluginCode,
  listComponentFiles,
} from './sync-penpot-components.ts'

describe('sync-penpot-components', () => {
  const { plans, skipped } = buildComponentTokenSets()
  const planByName = new Map(plans.map((p) => [p.name, p]))

  it('produces one set per JSON file in tokens/components/', () => {
    const fileCount = listComponentFiles().length
    expect(plans.length).toBe(fileCount)
  })

  it('returns the skipped list (number type + calc values)', () => {
    const skippedPaths = skipped.map((s) => `${s.path}|${s.reason.split(' ')[0]}`)
    expect(skippedPaths).toContain('component.chat.msg-line-height|unsupported')
    expect(skippedPaths).toContain('component.chat.panel-max-height|calc()')
  })

  it('names sets under the Components/ namespace, title-cased per file stem', () => {
    expect(planByName.has('Components/Browse')).toBe(true)
    expect(planByName.has('Components/Chat')).toBe(true)
    expect(planByName.has('Components/Playback')).toBe(true)
    expect(planByName.has('Components/Tools-Menu')).toBe(true)
  })

  it('covers the Tier-2 component sets (info-panel, help) with their base values', () => {
    expect(planByName.has('Components/Info-Panel')).toBe(true)
    expect(planByName.has('Components/Help')).toBe(true)

    const info = planByName.get('Components/Info-Panel')!
    expect(info.specs.find((s) => s.name === 'component.info-panel.max-width')?.value).toBe('340px')
    expect(info.specs.find((s) => s.name === 'component.info-panel.body-padding')?.value).toBe('0.75rem')

    const help = planByName.get('Components/Help')!
    expect(help.specs.find((s) => s.name === 'component.help.panel-width')?.value).toBe('640px')
    expect(help.specs.find((s) => s.name === 'component.help.trigger-size')?.value).toBe('36px')
  })

  it('mirrors the JSON path in token names', () => {
    const browse = planByName.get('Components/Browse')!
    const browseNames = new Set(browse.specs.map((s) => s.name))
    expect(browseNames.has('component.browse.panel-width')).toBe(true)
    expect(browseNames.has('component.browse.thumb-size-expanded')).toBe(true)
    expect(browseNames.has('component.browse.chat-btn-size')).toBe(true)
  })

  it('maps W3C fontWeight to Penpot fontWeights', () => {
    const browse = planByName.get('Components/Browse')!
    const titleWeight = browse.specs.find((s) => s.name === 'component.browse.title-weight')
    expect(titleWeight).toMatchObject({ type: 'fontWeights', value: '600' })
  })

  it('uses the default $value only — ignores mode overrides', () => {
    const browse = planByName.get('Components/Browse')!
    const panelWidth = browse.specs.find((s) => s.name === 'component.browse.panel-width')
    expect(panelWidth?.value).toBe('420px')

    const chat = planByName.get('Components/Chat')!
    const trigger = chat.specs.find((s) => s.name === 'component.chat.trigger-height')
    expect(trigger?.value).toBe('44px')
  })

  it('skips W3C $type "number" since Penpot has no matching TokenType', () => {
    const chat = planByName.get('Components/Chat')!
    const lineHeight = chat.specs.find((s) => s.name === 'component.chat.msg-line-height')
    expect(lineHeight).toBeUndefined()
  })

  it('skips calc() values — Penpot addToken rejects them with "Value not valid"', () => {
    const chat = planByName.get('Components/Chat')!
    const panelMax = chat.specs.find((s) => s.name === 'component.chat.panel-max-height')
    expect(panelMax).toBeUndefined()
  })

  it('emits only Penpot-supported token types', () => {
    const types = new Set(plans.flatMap((p) => p.specs.map((s) => s.type)))
    for (const t of types) {
      expect(['color', 'dimension', 'fontWeights']).toContain(t)
    }
  })

  it('produces unique token names within each set', () => {
    for (const plan of plans) {
      const names = plan.specs.map((s) => s.name)
      expect(new Set(names).size, plan.name).toBe(names.length)
    }
  })

  it('captures $description when present', () => {
    const browse = planByName.get('Components/Browse')!
    const panel = browse.specs.find((s) => s.name === 'component.browse.panel-width')
    expect(panel?.description).toMatch(/width/i)
    const cardPad = browse.specs.find((s) => s.name === 'component.browse.card-padding')
    expect(cardPad?.description).toBeUndefined()
  })

  it('plugin code embeds every set name and a sample token', () => {
    const code = buildPluginCode(plans)
    expect(code).toContain('"Components/Browse"')
    expect(code).toContain('"Components/Chat"')
    expect(code).toContain('"Components/Playback"')
    expect(code).toContain('"Components/Tools-Menu"')
    expect(code).toContain('"component.browse.panel-width"')
    expect(code).toContain('penpot.library.local.tokens')
    expect(code).toContain('addToken')
  })

  it('plugin code summary includes the unchanged-token list per set', () => {
    const code = buildPluginCode(plans)
    expect(code).toMatch(/created,\s*updated,\s*unchanged,\s*orphans,\s*typeMismatches/)
  })
})
