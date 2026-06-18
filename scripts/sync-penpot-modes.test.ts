import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildModeOverrides,
  buildPluginCode,
  listSourceFiles,
  THEME_GROUP,
} from './sync-penpot-modes.ts'

describe('sync-penpot-modes', () => {
  const result = buildModeOverrides()
  const setByName = new Map(result.modeSets.map((s) => [s.name, s]))
  const themeByName = new Map(result.themes.map((t) => [t.name, t]))

  // Temp dirs created by individual tests; cleaned up after the suite.
  const tmpDirs: string[] = []
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
  })

  it('emits one set per non-default mode in the JSONs', () => {
    expect(setByName.has('Modes/Mobile-Native')).toBe(true)
    expect(setByName.has('Modes/Tablet')).toBe(true)
    expect(setByName.has('Modes/Phone-Portrait')).toBe(true)
    expect(result.modeSets).toHaveLength(3)
  })

  it('Modes/Mobile-Native carries only the global tokens with that override', () => {
    const ms = setByName.get('Modes/Mobile-Native')!
    const names = new Set(ms.specs.map((s) => s.name))
    expect(names).toEqual(new Set(['radius.lg', 'radius.xl', 'touch.min']))
    expect(ms.specs.find((s) => s.name === 'radius.lg')?.value).toBe('10px')
    expect(ms.specs.find((s) => s.name === 'touch.min')?.value).toBe('48px')
  })

  it('mode override values come from the override entry, not the default', () => {
    const tablet = setByName.get('Modes/Tablet')!
    const triggerH = tablet.specs.find((s) => s.name === 'component.chat.trigger-height')
    expect(triggerH?.value).toBe('48px')
    const phone = setByName.get('Modes/Phone-Portrait')!
    const panelW = phone.specs.find((s) => s.name === 'component.browse.panel-width')
    expect(panelW?.value).toBe('100%')
  })

  it('folds Tier-2 (info-panel, help) overrides into the existing mode sets', () => {
    const tablet = setByName.get('Modes/Tablet')!
    expect(
      tablet.specs.find((s) => s.name === 'component.info-panel.body-max-height-expanded')?.value,
    ).toBe('40vh')
    expect(tablet.specs.find((s) => s.name === 'component.help.trigger-size')?.value).toBe('48px')
    expect(tablet.specs.find((s) => s.name === 'component.help.panel-max-height')?.value).toBe('70vh')

    const phone = setByName.get('Modes/Phone-Portrait')!
    expect(phone.specs.find((s) => s.name === 'component.help.panel-width')?.value).toBe('100vw')
    expect(phone.specs.find((s) => s.name === 'component.help.panel-max-height')?.value).toBe('100dvh')
    expect(phone.specs.find((s) => s.name === 'component.help.trigger-size')?.value).toBe('40px')
  })

  it('skips the Tier-2 calc() tablet width overrides (repo stays authoritative)', () => {
    const calcSkips = result.skipped
      .filter((s) => s.mode === 'tablet' && /calc\(\)/i.test(s.reason))
      .map((s) => s.name)
    expect(calcSkips).toContain('component.info-panel.max-width')
    expect(calcSkips).toContain('component.help.panel-width')
  })

  it('skips calc() override values with a stderr-style reason', () => {
    const skip = result.skipped.find(
      (s) =>
        s.mode === 'tablet' &&
        s.name === 'component.chat.panel-width',
    )
    expect(skip?.reason).toMatch(/calc\(\)/i)
    const tablet = setByName.get('Modes/Tablet')!
    expect(tablet.specs.find((s) => s.name === 'component.chat.panel-width')).toBeUndefined()
  })

  it('emits four themes (Default + one per mode) in the Default group', () => {
    expect(result.themes).toHaveLength(4)
    for (const t of result.themes) expect(t.group).toBe(THEME_GROUP)
    expect(themeByName.has('Default')).toBe(true)
    expect(themeByName.has('Tablet')).toBe(true)
    expect(themeByName.has('Phone Portrait')).toBe(true)
    expect(themeByName.has('Mobile Native')).toBe(true)
  })

  it('Default theme activates only the base sets', () => {
    const def = themeByName.get('Default')!
    expect(def.sets).toEqual([
      'Global',
      'Components/Browse',
      'Components/Chat',
      'Components/Help',
      'Components/Info-Panel',
      'Components/Playback',
      'Components/Tools-Menu',
    ])
  })

  it('Phone Portrait theme inherits Tablet overrides (CSS-cascade parity)', () => {
    const phone = themeByName.get('Phone Portrait')!
    const idxTablet = phone.sets.indexOf('Modes/Tablet')
    const idxPhone = phone.sets.indexOf('Modes/Phone-Portrait')
    expect(idxTablet).toBeGreaterThan(-1)
    expect(idxPhone).toBeGreaterThan(idxTablet) // phone-portrait wins on collision
  })

  it('Mobile Native theme does not pull in viewport-mode sets', () => {
    const mn = themeByName.get('Mobile Native')!
    expect(mn.sets).not.toContain('Modes/Tablet')
    expect(mn.sets).not.toContain('Modes/Phone-Portrait')
    expect(mn.sets[mn.sets.length - 1]).toBe('Modes/Mobile-Native')
  })

  it('every set name in every theme refers to a base set or a generated mode set', () => {
    const known = new Set([...result.baseSets, ...result.modeSets.map((m) => m.name)])
    for (const t of result.themes) {
      for (const s of t.sets) expect(known.has(s), `${t.name}: ${s}`).toBe(true)
    }
  })

  it('no spec name is duplicated within a single mode set', () => {
    for (const ms of result.modeSets) {
      const names = ms.specs.map((s) => s.name)
      expect(new Set(names).size, ms.name).toBe(names.length)
    }
  })

  it('plugin code embeds the plan and refuses to run without base sets', () => {
    const code = buildPluginCode(result)
    expect(code).toContain('"Modes/Tablet"')
    expect(code).toContain('"Modes/Phone-Portrait"')
    expect(code).toContain('"Modes/Mobile-Native"')
    expect(code).toContain('"Components/Browse"')
    expect(code).toMatch(/missing base sets/)
    expect(code).toContain('addToken')
  })

  it('plugin code wires themes via addTheme({ sets: [...] }) — recreate-on-change', () => {
    const code = buildPluginCode(result)
    // Theme creation passes the full sets array at construction time;
    // see the comment in buildPluginCode for why theme.addSet is not
    // used (it is rejected by the current Penpot plugin API version).
    expect(code).toContain('tokens.addTheme({ group: t.group, name: t.name, sets: t.sets })')
    expect(code).toContain('existing.remove()')
    expect(code).toContain('activeSets')
    // Activates the Default theme at the end so the file leaves
    // "manual" mode after seeding.
    expect(code).toMatch(/defaultTheme[\s\S]*toggleActive/)
  })

  it('derives base sets from the source-file listing, not a hard-coded list', () => {
    // One base set per source file — global → "Global", each
    // tokens/components/*.json → Components/<TitleCase>. Deriving (vs.
    // hard-coding) means a newly added component file is activated
    // under every theme instead of silently left inactive.
    const files = listSourceFiles()
    expect(result.baseSets).toHaveLength(files.length)
    expect(result.baseSets).toContain('Global')
    const componentSets = result.baseSets.filter((n) => n.startsWith('Components/'))
    expect(componentSets).toHaveLength(files.length - 1)
    // The Default theme activates exactly the derived base sets.
    expect(themeByName.get('Default')!.sets).toEqual(result.baseSets)
  })

  it('records a skip (not a silent drop) for a modes block with a malformed $type', () => {
    const dir = mkdtempSync(join(tmpdir(), 'penpot-modes-'))
    tmpDirs.push(dir)
    const file = join(dir, 'malformed.json')
    // $type is a number, not a string — but the token still carries a
    // com.tokens-studio.modes override. It must surface in `skipped`
    // rather than vanishing.
    writeFileSync(
      file,
      JSON.stringify({
        bad: {
          token: {
            $value: '8px',
            $type: 42,
            $extensions: { 'com.tokens-studio.modes': { default: '8px', tablet: '10px' } },
          },
        },
      }),
    )
    const res = buildModeOverrides([file])
    const skip = res.skipped.find((s) => s.name === 'bad.token' && s.mode === 'tablet')
    expect(skip?.reason).toMatch(/malformed \$type/i)
    // And it did not leak into any mode set.
    expect(res.modeSets.flatMap((m) => m.specs).find((s) => s.name === 'bad.token')).toBeUndefined()
  })
})
