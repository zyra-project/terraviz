import { describe, expect, it } from 'vitest'

import { scenes } from './scenes'

describe('screenshot scene manifest', () => {
  it('covers the high-traffic surface (~15–30 scenes)', () => {
    expect(scenes.length).toBeGreaterThanOrEqual(15)
    expect(scenes.length).toBeLessThanOrEqual(30)
  })

  it('every scene has a unique name', () => {
    const names = scenes.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('names are filesystem- and Weblate-safe slugs', () => {
    // Used verbatim as `<name>.png` and as the Weblate screenshot
    // name, so keep them to lowercase / digits / dashes.
    for (const s of scenes) {
      expect(s.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    }
  })

  it('every scene has a non-empty description and a setup function', () => {
    for (const s of scenes) {
      expect(s.description.trim().length).toBeGreaterThan(0)
      expect(typeof s.setup).toBe('function')
    }
  })

  it('covers the publisher and admin surfaces', () => {
    const names = scenes.map((s) => s.name)
    expect(names).toEqual(expect.arrayContaining(['publish-datasets']))
    expect(names.some((n) => n.startsWith('admin-'))).toBe(true)
  })

  it('covers the alternate browse views and help', () => {
    const names = scenes.map((s) => s.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'browse-graph-view',
        'browse-timeline-view',
        'browse-map-view',
        'help-panel',
      ]),
    )
  })

  it('covers the globe-overlay surfaces', () => {
    const names = scenes.map((s) => s.name)
    expect(names).toEqual(
      expect.arrayContaining(['tools-menu', 'orbit-settings']),
    )
  })
})
