import { describe, expect, it } from 'vitest'

import type { SceneSignals } from './core/signals'
import { MARKER, renderPrSummary } from './summary'
import type { DiffManifest, ReportManifest, ReportShot } from './report/types'

const emptySignals = (): SceneSignals => ({
  consoleErrors: [],
  consoleWarnings: [],
  pageErrors: [],
  failedRequests: [],
  badResponses: [],
})

const shot = (over: Partial<ReportShot> = {}): ReportShot => ({
  scene: 'catalog-landing',
  description: '',
  viewport: 'desktop',
  width: 1440,
  height: 900,
  file: 'catalog-landing-desktop.png',
  sha256: 'x',
  signals: emptySignals(),
  ...over,
})

const manifest = (shots: ReportShot[]): ReportManifest => ({
  generatedAt: '2026-06-14T00:00:00.000Z',
  baseUrl: 'http://localhost:4173',
  viewports: ['desktop', 'mobile'],
  shots,
})

describe('renderPrSummary', () => {
  it('leads with the update marker and is advisory', () => {
    const md = renderPrSummary(manifest([shot()]))
    expect(md.startsWith(MARKER)).toBe(true)
    expect(md).toContain('Advisory')
    expect(md).toContain('No baseline to diff against')
  })

  it('summarizes changed shots in a table when a diff is present', () => {
    const diff: DiffManifest = {
      generatedAt: '2026-06-14T00:00:00.000Z',
      baselineDir: '/b',
      threshold: 0.001,
      comparisons: [
        {
          scene: 'catalog-landing',
          viewport: 'desktop',
          file: 'catalog-landing-desktop.png',
          changedPixels: 4200,
          ratio: 0.0325,
          status: 'changed',
          changed: true,
        },
        {
          scene: 'help-panel',
          viewport: 'mobile',
          file: 'help-panel-mobile.png',
          changedPixels: 0,
          ratio: 0,
          status: 'new',
          changed: false,
        },
      ],
    }
    const md = renderPrSummary(manifest([shot()]), diff)
    expect(md).toContain('1 shot(s) changed, 1 new')
    expect(md).toContain('| catalog-landing | desktop | 3.25% (4200 px) |')
  })

  it('lists shots with problems in a details block', () => {
    const bad = emptySignals()
    bad.pageErrors.push('boom')
    bad.badResponses.push({ url: 'u', status: 500 })
    const md = renderPrSummary(manifest([shot({ signals: bad })]))
    expect(md).toContain('Shots with problems')
    expect(md).toContain('| catalog-landing | desktop | 1 | 1 | 0 |')
  })

  it('links the run URL when provided', () => {
    const md = renderPrSummary(manifest([shot()]), undefined, {
      runUrl: 'https://example/run/1',
    })
    expect(md).toContain('(https://example/run/1)')
  })
})
