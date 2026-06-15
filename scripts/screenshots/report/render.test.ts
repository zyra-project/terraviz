import { describe, expect, it } from 'vitest'

import type { SceneSignals } from '../core/signals'

import {
  escapeHtml,
  renderReportHtml,
  summarizeSignals,
} from './render'
import type { DiffManifest, ReportManifest, ReportShot } from './types'

const emptySignals = (): SceneSignals => ({
  consoleErrors: [],
  consoleWarnings: [],
  pageErrors: [],
  failedRequests: [],
  badResponses: [],
})

const shot = (over: Partial<ReportShot> = {}): ReportShot => ({
  scene: 'catalog-landing',
  description: 'The catalog landing surface',
  viewport: 'desktop',
  width: 1440,
  height: 900,
  file: 'catalog-landing-desktop.png',
  sha256: 'abc',
  signals: emptySignals(),
  ...over,
})

const manifest = (shots: ReportShot[]): ReportManifest => ({
  generatedAt: '2026-06-14T00:00:00.000Z',
  baseUrl: 'http://localhost:4173',
  viewports: ['desktop', 'mobile'],
  shots,
})

describe('summarizeSignals', () => {
  it('counts errors, failures, axe and flags ok=false on any hard problem', () => {
    const s = emptySignals()
    s.consoleErrors.push('boom')
    s.pageErrors.push('crash')
    s.failedRequests.push({ url: 'u', method: 'GET', failure: 'x' })
    s.badResponses.push({ url: 'u', status: 500 })
    s.axeViolations = [
      {
        id: 'color-contrast',
        impact: 'serious',
        nodes: 2,
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.x/color-contrast',
        targets: ['.a > span', '#b'],
      },
    ]
    s.consoleWarnings.push('meh')

    const sum = summarizeSignals(s)
    expect(sum).toMatchObject({
      errors: 2,
      failures: 2,
      axe: 1,
      warnings: 1,
      total: 5,
      ok: false,
    })
  })

  it('treats warnings as non-blocking (ok stays true)', () => {
    const s = emptySignals()
    s.consoleWarnings.push('just a warning')
    expect(summarizeSignals(s)).toMatchObject({ total: 0, ok: true })
  })
})

describe('escapeHtml', () => {
  it('escapes angle brackets, ampersands and quotes', () => {
    expect(escapeHtml(`<img src="x" onerror='y'>&`)).toBe(
      '&lt;img src=&quot;x&quot; onerror=&#39;y&#39;&gt;&amp;',
    )
  })
})

describe('renderReportHtml', () => {
  it('renders a scene section, the image and the viewport label', () => {
    const html = renderReportHtml(manifest([shot()]))
    expect(html).toContain('<title>Terraviz visual report</title>')
    expect(html).toContain('id="scene-catalog-landing"')
    expect(html).toContain('src="catalog-landing-desktop.png"')
    expect(html).toContain('desktop · 1440×900')
    expect(html).toContain('badge-ok')
  })

  it('flags scenes with problems and lists each problem, escaped', () => {
    const bad = emptySignals()
    bad.pageErrors.push('TypeError: <script>')
    const html = renderReportHtml(manifest([shot({ signals: bad })]))

    expect(html).toContain('scene-problems')
    expect(html).toContain('page error: TypeError: &lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('links the a11y rule to its docs and lists the offending selectors', () => {
    const bad = emptySignals()
    bad.axeViolations = [
      {
        id: 'color-contrast',
        impact: 'serious',
        nodes: 2,
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.x/color-contrast',
        targets: ['.card > span', '#cta'],
      },
    ]
    const html = renderReportHtml(manifest([shot({ signals: bad })]))

    expect(html).toContain(
      '<a href="https://dequeuniversity.com/rules/axe/4.x/color-contrast"',
    )
    expect(html).toContain('>color-contrast</a>')
    expect(html).toContain('<details><summary>2 node(s)</summary>')
    expect(html).toContain('<code>.card &gt; span</code>')
    expect(html).toContain('<code>#cta</code>')
  })

  it('renders the diff triptych and changed badge when diffs are supplied', () => {
    const diffs: DiffManifest = {
      generatedAt: '2026-06-14T00:00:00.000Z',
      baselineDir: '/baseline',
      threshold: 0.001,
      comparisons: [
        {
          scene: 'catalog-landing',
          viewport: 'desktop',
          file: 'catalog-landing-desktop.png',
          baselineFile: 'baseline-catalog-landing-desktop.png',
          diffFile: 'diff-catalog-landing-desktop.png',
          changedPixels: 4200,
          ratio: 0.0325,
          status: 'changed',
          changed: true,
        },
      ],
    }
    const html = renderReportHtml(manifest([shot()]), { diffs })
    expect(html).toContain('shot(s) changed vs baseline')
    expect(html).toContain('changed 3.25% (4200 px)')
    expect(html).toContain('src="baseline-catalog-landing-desktop.png"')
    expect(html).toContain('src="diff-catalog-landing-desktop.png"')
  })

  it('shows a soft "new (no baseline)" badge and no triptych for new shots', () => {
    const diffs: DiffManifest = {
      generatedAt: '2026-06-14T00:00:00.000Z',
      baselineDir: '/baseline',
      threshold: 0.001,
      comparisons: [
        {
          scene: 'catalog-landing',
          viewport: 'desktop',
          file: 'catalog-landing-desktop.png',
          changedPixels: 0,
          ratio: 0,
          status: 'new',
          changed: false,
        },
      ],
    }
    const html = renderReportHtml(manifest([shot()]), { diffs })
    expect(html).toContain('new (no baseline)')
    expect(html).not.toContain('class="diff-row"')
  })

  it('groups multiple viewports under one scene', () => {
    const html = renderReportHtml(
      manifest([
        shot({ viewport: 'desktop', file: 'catalog-landing-desktop.png' }),
        shot({ viewport: 'mobile', width: 390, height: 844, file: 'catalog-landing-mobile.png' }),
      ]),
    )
    // One section, two figures.
    expect(html.match(/id="scene-catalog-landing"/g)).toHaveLength(1)
    expect(html.match(/<figure class="shot/g)).toHaveLength(2)
  })
})
