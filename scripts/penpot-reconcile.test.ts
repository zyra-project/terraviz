import { describe, it, expect } from 'vitest'
import {
  reconcile,
  reconcileFile,
  isRoundTrippable,
  isBuildArtifact,
  modeSetName,
  titleCaseHyphenated,
  collectTokenNames,
  type PenpotGraph,
  type RepoTokenFile,
} from './penpot-reconcile.ts'

function graph(sets: PenpotGraph['sets']): PenpotGraph {
  return { file: 'TerraViz - Design System', sets, themes: [] }
}

describe('isRoundTrippable', () => {
  it('accepts Penpot-storable types with plain values', () => {
    expect(isRoundTrippable('color', '#4da6ff')).toBe(true)
    expect(isRoundTrippable('dimension', '28px')).toBe(true)
    expect(isRoundTrippable('fontWeight', '600')).toBe(true)
  })

  it('rejects the hostile set', () => {
    expect(isRoundTrippable('number', '1.55')).toBe(false) // no Penpot number type
    expect(isRoundTrippable('dimension', 'calc(100vh - 8rem)')).toBe(false) // Penpot rejects calc
  })

  it('rejects leaked build artifacts', () => {
    expect(isRoundTrippable('dimension', 'calc(28px * var(--ui-scale))')).toBe(false)
    expect(isRoundTrippable('dimension', 'max(44px, 2rem)')).toBe(false)
  })

  it('rejects non-string and unknown types', () => {
    expect(isRoundTrippable('dimension', 5 as unknown)).toBe(false)
    expect(isRoundTrippable('shadow', '0 0 1px')).toBe(false)
  })
})

describe('isBuildArtifact', () => {
  it('flags ui-scale wrapping, max() floors, and blur()', () => {
    expect(isBuildArtifact('var(--ui-scale)')).toBe(true)
    expect(isBuildArtifact('max( 44px , 3rem )')).toBe(true)
    expect(isBuildArtifact('blur(12px)')).toBe(true)
  })
  it('does not flag plain or calc values', () => {
    expect(isBuildArtifact('28px')).toBe(false)
    expect(isBuildArtifact('calc(100vh - 8rem)')).toBe(false)
  })
})

describe('name helpers', () => {
  it('title-cases hyphenated keys and maps mode set names', () => {
    expect(titleCaseHyphenated('phone-portrait')).toBe('Phone-Portrait')
    expect(modeSetName('tablet')).toBe('Modes/Tablet')
    expect(modeSetName('mobile-native')).toBe('Modes/Mobile-Native')
  })
})

describe('reconcileFile — base value overlay', () => {
  const repoJson = {
    component: {
      x: {
        size: { $value: '28px', $type: 'dimension', $description: 'btn' },
        max: { $value: 'calc(100vh - 8rem)', $type: 'dimension' },
        lh: { $value: '1.55', $type: 'number' },
      },
    },
  }
  const file: RepoTokenFile = { label: 'x.json', baseSetName: 'Components/X', json: repoJson }

  it('takes the designer-changed Penpot value (designer wins)', () => {
    const g = graph([
      { name: 'Components/X', tokens: [{ name: 'component.x.size', type: 'dimension', value: '40px' }] },
    ])
    const out = reconcileFile(file, g) as never
    expect((out as any).json.component.x.size.$value).toBe('40px')
  })

  it('never overlays hostile tokens — calc and number keep the repo value', () => {
    const g = graph([
      {
        name: 'Components/X',
        tokens: [
          // even if Penpot somehow held values for these, they must be ignored
          { name: 'component.x.max', type: 'dimension', value: '50vh' },
          { name: 'component.x.lh', type: 'number', value: '2' },
        ],
      },
    ])
    const out = reconcileFile(file, g) as any
    expect(out.json.component.x.max.$value).toBe('calc(100vh - 8rem)')
    expect(out.json.component.x.lh.$value).toBe('1.55')
  })

  it('rejects an exported build-artifact value and warns', () => {
    const g = graph([
      {
        name: 'Components/X',
        tokens: [{ name: 'component.x.size', type: 'dimension', value: 'calc(28px * var(--ui-scale))' }],
      },
    ])
    const out = reconcileFile(file, g) as any
    expect(out.json.component.x.size.$value).toBe('28px') // kept repo
    expect(out.warnings.map((w: any) => w.kind)).toContain('build-artifact-rejected')
  })

  it('warns when a round-trippable token is absent from the export', () => {
    const g = graph([{ name: 'Components/X', tokens: [] }])
    const out = reconcileFile(file, g) as any
    expect(out.json.component.x.size.$value).toBe('28px')
    expect(out.warnings.find((w: any) => w.kind === 'missing-in-export')?.path).toBe('component.x.size')
  })
})

describe('reconcileFile — mode overlay (the §1 mode inversion)', () => {
  const repoJson = {
    component: {
      chat: {
        'panel-width': {
          $value: '380px',
          $type: 'dimension',
          $extensions: {
            'com.tokens-studio.modes': {
              default: '380px',
              tablet: 'calc(100vw - 1.5rem)', // hostile override
              'phone-portrait': '100%',
            },
          },
        },
      },
    },
  }
  const file: RepoTokenFile = { label: 'chat.json', baseSetName: 'Components/Chat', json: repoJson }

  it('overlays round-trippable mode overrides from Modes/* and keeps hostile ones', () => {
    const g = graph([
      { name: 'Components/Chat', tokens: [{ name: 'component.chat.panel-width', type: 'dimension', value: '400px' }] },
      { name: 'Modes/Phone-Portrait', tokens: [{ name: 'component.chat.panel-width', type: 'dimension', value: '90%' }] },
      // Modes/Tablet intentionally has no entry — the tablet override is calc (hostile)
    ])
    const out = reconcileFile(file, g) as any
    const modes = out.json.component.chat['panel-width'].$extensions['com.tokens-studio.modes']
    expect(out.json.component.chat['panel-width'].$value).toBe('400px') // base overlaid
    expect(modes.default).toBe('400px') // default mirrors base
    expect(modes.tablet).toBe('calc(100vw - 1.5rem)') // hostile kept
    expect(modes['phone-portrait']).toBe('90%') // round-trippable overlaid
  })

  it('warns when a round-trippable mode override is missing from its mode set', () => {
    const g = graph([
      { name: 'Components/Chat', tokens: [{ name: 'component.chat.panel-width', type: 'dimension', value: '380px' }] },
      // Modes/Phone-Portrait missing entirely
    ])
    const out = reconcileFile(file, g) as any
    expect(out.warnings.find((w: any) => w.kind === 'missing-mode-in-export')?.mode).toBe('phone-portrait')
  })
})

describe('reconcile — whole-graph concerns', () => {
  const repoFiles: RepoTokenFile[] = [
    {
      label: 'a.json',
      baseSetName: 'Components/A',
      json: { component: { a: { size: { $value: '10px', $type: 'dimension' } } } },
    },
  ]

  it('produces an empty diff for an identity graph', () => {
    const g = graph([{ name: 'Components/A', tokens: [{ name: 'component.a.size', type: 'dimension', value: '10px' }] }])
    const { files } = reconcile(repoFiles, g)
    expect(JSON.stringify(files[0]!.json)).toBe(JSON.stringify(repoFiles[0]!.json))
  })

  it('flags a token present in Penpot but absent from the repo schema (not auto-added)', () => {
    const g = graph([
      {
        name: 'Components/A',
        tokens: [
          { name: 'component.a.size', type: 'dimension', value: '10px' },
          { name: 'component.a.brand-new', type: 'dimension', value: '99px' },
        ],
      },
    ])
    const { files, warnings } = reconcile(repoFiles, g)
    const newWarn = warnings.find((w) => w.kind === 'new-in-penpot')
    expect(newWarn?.path).toBe('component.a.brand-new')
    // schema is repo-owned: the new token is NOT written into the file
    expect(collectTokenNames(files[0]!.json).has('component.a.brand-new')).toBe(false)
  })
})
