// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { until } from '../test-utils'
import type { OutputMonitor, OutputRecord, WarpAssignRefusal } from '../services/multiOutput/manager'
import { defaultRenderConfig } from '../services/multiOutput/protocol'
import type { WarpSource } from '../services/multiOutput/warpImport'
import type { WarpMesh } from '../output/projectorWarp'
import type { BundleLayout } from '../services/multiOutput/warpImport'
import {
  buildWarpSection,
  describeWarpRefusal,
  displayStretchPercent,
  rasterStretchPercent,
  warpRotationNote,
  type OutputWarpManager,
} from './outputWarpUI'

const MONITOR: OutputMonitor = {
  name: 'PROJECTORS',
  position: { x: 0, y: 0 },
  size: { width: 3840, height: 2160 },
  scaleFactor: 1,
}

function record(over: Partial<OutputRecord> = {}): OutputRecord {
  return {
    label: 'output-1',
    mode: 'projector-warp',
    view: { trackCamera: true, split: false, rotationOffsetDeg: 0 },
    render: defaultRenderConfig(),
    monitor: MONITOR,
    ready: true,
    lastHealthCheckAtMs: null,
    gpuLost: false,
    stallReported: false,
    health: 'live',
    lastEvent: null,
    departing: false,
    announcedClosing: false,
    warpRef: null,
    ...over,
  }
}

function source(id: string, aspect = 16 / 9): WarpSource {
  return { id, sourceName: `${id}.data`, text: '2\n…', mesh: { cols: 41, rows: 41, aspect, nodes: [] } as WarpMesh }
}

function fakeManager() {
  const mgr = {
    readWarpFiles: vi.fn(async () => ({
      ok: true as const,
      sources: [source('P1'), source('P3')] as readonly WarpSource[],
      layout: null as BundleLayout | null,
    })),
    importWarpSet: vi.fn(async () => ({ ok: true as const, id: '0123456789abcdef', meshes: 2 })),
    clearOutputWarp: vi.fn(async () => {}),
    setOutputRenderConfig: vi.fn(async () => {}),
  }
  return { mgr: mgr as unknown as OutputWarpManager, raw: mgr }
}

/** Pick files the way the browser does: `files` set, then `change`. */
function pick(section: HTMLElement, names: string[]): void {
  const input = section.querySelector<HTMLInputElement>('input[type="file"]')!
  const files = names.map((name) => new File(['2'], name))
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  input.dispatchEvent(new Event('change'))
}

let repaint: ReturnType<typeof vi.fn>
beforeEach(() => {
  // The app-wide announcer lives outside the panel in the real page, so
  // it survives the repaint that follows an import or a clear.
  document.body.innerHTML = '<div id="a11y-announcer" aria-live="polite" aria-atomic="true"></div>'
  repaint = vi.fn()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

/** Unmount what a test mounted, keeping the announcer. */
function resetBody(): void {
  for (const el of [...document.body.children]) if (el.id !== 'a11y-announcer') el.remove()
}

const announced = (): string => document.getElementById('a11y-announcer')!.textContent ?? ''

function mountSection(over: Partial<OutputRecord> = {}, mgr = fakeManager(), monitor = MONITOR) {
  const section = buildWarpSection(mgr.mgr, record({ monitor, ...over }), monitor, 'PROJECTORS', repaint as () => void)
  document.body.appendChild(section)
  return { section, ...mgr }
}

/** A desk monitor of another shape: 16:10 against a 16:9 calibration. */
const DESK: OutputMonitor = { ...MONITOR, name: 'DESK', size: { width: 1680, height: 1050 } }

/** SOS's quadrants as a bundle's layout states them, on the display sphere-sim's default rig spans. */
const SOS_RIG: BundleLayout = {
  framebuffer: { width: 7680, height: 4320 },
  texture: { surface: 'sphere', rotationOffsetDeg: 0 },
  projectors: [
    { id: 'P1', viewport: { x: 0, y: 0, w: 0.5, h: 0.5 } },
    { id: 'P2', viewport: { x: 0.5, y: 0, w: 0.5, h: 0.5 } },
    { id: 'P3', viewport: { x: 0, y: 0.5, w: 0.5, h: 0.5 } },
    { id: 'P4', viewport: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } },
  ],
}

/** Read `sources` on `monitor` and return the warnings the panel shows before the choice. */
async function warningsFor(sources: WarpSource[], layout: BundleLayout | null, monitor: OutputMonitor): Promise<string[]> {
  const mgr = fakeManager()
  mgr.raw.readWarpFiles.mockResolvedValue({ ok: true, sources, layout })
  const { section } = mountSection({}, mgr, monitor)
  pick(section, ['rig.zip'])
  await until(() => section.querySelector('.output-warp-choose') !== null, 'the choice')
  const warnings = [...section.querySelectorAll('.output-warp-pending .output-warning')].map((el) => el.textContent ?? '')
  resetBody()
  return warnings
}

describe('rasterStretchPercent', () => {
  it('is silent when a mesh fits its quadrant, and says how far off when it does not', () => {
    const quadrant = { w: 0.5, h: 0.5 }
    expect(rasterStretchPercent(16 / 9, quadrant, { width: 3840, height: 2160 })).toBeNull()
    // The plan's example: 2048×1080 quadrants under a 16:9 mesh.
    expect(rasterStretchPercent(16 / 9, quadrant, { width: 4096, height: 2160 })).toBe(7)
    expect(rasterStretchPercent(4 / 3, quadrant, { width: 3840, height: 2160 })).toBe(33)
    expect(rasterStretchPercent(0, quadrant, { width: 3840, height: 2160 })).toBeNull()
  })
})

describe('displayStretchPercent', () => {
  it('measures a whole display against the one a bundle was solved for', () => {
    expect(displayStretchPercent({ width: 7680, height: 4320 }, { width: 3840, height: 2160 })).toBeNull()
    // The desk monitor from the first hardware import: 16:10 under a 16:9 rig.
    expect(displayStretchPercent({ width: 7680, height: 4320 }, { width: 1680, height: 1050 })).toBe(10)
    expect(displayStretchPercent({ width: 4096, height: 2160 }, { width: 3840, height: 2160 })).toBe(6)
  })
})

/** A placed pair's layout, as sphere-sim writes it: halves at full height of a 3840×1080 display. */
const PAIR: BundleLayout = {
  framebuffer: { width: 3840, height: 1080 },
  texture: { surface: 'sphere', rotationOffsetDeg: 37 },
  projectors: [
    { id: 'P1', viewport: { x: 0, y: 0, w: 0.5, h: 1 } },
    { id: 'P2', viewport: { x: 0.5, y: 0, w: 0.5, h: 1 } },
  ],
}

describe('warpRotationNote', () => {
  const set = (texture: BundleLayout['texture'] | null) => ({ id: '0123456789abcdef', texture, meshes: [] })
  it('says what the bundle baked in, that nothing said, or nothing at all with no set', () => {
    expect(warpRotationNote(null)).toBeNull()
    expect(warpRotationNote(set(null))).toContain('unknown')
    expect(warpRotationNote(set({ surface: 'sphere', rotationOffsetDeg: 37 }))).toContain('37°')
    expect(warpRotationNote(set({ surface: 'sphere', rotationOffsetDeg: 0 }))).toContain('0°')
    expect(warpRotationNote(set({ surface: 'mesh', rotationOffsetDeg: null }))).toContain('none')
  })
})

describe('describeWarpRefusal', () => {
  it('words every refusal, naming what the operator has to find', () => {
    const cases: [WarpAssignRefusal, string[]][] = [
      [{ code: 'nothing-picked' }, ['No file']],
      [{ code: 'too-large', bytes: 40 * 1024 * 1024 }, ['40 MB']],
      [{ code: 'mixed-selection' }, ['not both']],
      [{ code: 'unsupported-file', file: 'notes.txt' }, ['notes.txt']],
      [{ code: 'archive', file: 'rig.zip', zip: { code: 'zip64', detail: '' } }, ['rig.zip', 'zip64']],
      [{ code: 'archive', file: 'rig.zip', zip: { code: 'compressed', detail: '', entry: 'warp/P1.data' } }, ['rig.zip', '.data files']],
      [{ code: 'archive', file: 'rig.zip', zip: { code: 'checksum', detail: '', entry: 'warp/P1.data' } }, ['warp/P1.data', 'checksum']],
      [{ code: 'no-meshes', file: 'rig.zip' }, ['rig.zip', 'warp/<id>.data']],
      [{ code: 'too-many', count: 65 }, ['65']],
      [{ code: 'bad-name', file: '.data' }, ['.data']],
      [{ code: 'duplicate-id', ids: ['P1', 'p1'] }, ['P1, p1']],
      [{ code: 'not-text', file: 'P1.data' }, ['P1.data']],
      [{ code: 'mesh', file: 'P2.data', mesh: { code: 'bad-node', line: 1204, detail: '' } }, ['P2.data', 'bad-node', '1204']],
      [{ code: 'mesh', file: 'P2.data', mesh: { code: 'bad-extent', detail: '' } }, ['P2.data', 'bad-extent']],
      [{ code: 'layout', reason: 'unplaceable', ids: ['P5'] }, ['P5']],
      [{ code: 'layout', reason: 'duplicate', ids: ['P1'] }, ['P1', 'one quadrant']],
      [{ code: 'set', set: { code: 'overlap', ids: ['P1', 'P2'] } }, ['overlap']],
      [
        { code: 'bundle-layout', file: 'rig.zip/layout.json', problem: { code: 'format', format: 'sphere-sim/projector-layout@2' } },
        ['rig.zip/layout.json', 'projector-layout@2', 'does not read'],
      ],
      [
        { code: 'bundle-layout', file: 'rig.zip/layout.json', problem: { code: 'unknown-mesh', mesh: 'warp/P9.data' } },
        ['rig.zip/layout.json', 'unknown-mesh: warp/P9.data'],
      ],
      [
        { code: 'bundle-layout', file: 'rig.zip/layout.json', problem: { code: 'uv', uv: 'fisheye' } },
        ['rig.zip/layout.json', '"fisheye"', 'equirectangular', 'nothing is imported'],
      ],
      [{ code: 'bundle-layout', file: 'rig.zip/layout.json', problem: { code: 'origin' } }, ['(origin)']],
      [{ code: 'no-output' }, ['no longer open']],
      [{ code: 'not-a-warp-output' }, ['projector-warp']],
      [{ code: 'storage', reason: 'no-room' }, ['no room']],
      [{ code: 'storage', reason: 'unavailable' }, ['between launches']],
    ]
    for (const [refusal, fragments] of cases) {
      const text = describeWarpRefusal(refusal)
      for (const fragment of fragments) expect(text, refusal.code).toContain(fragment)
    }
  })
})

describe('buildWarpSection', () => {
  it('says what the output is drawing — or why nothing', () => {
    expect(mountSection().section.querySelector('.output-warp-status')!.textContent).toContain('No warp set')
    resetBody()
    // A reference with nothing loaded is a stored set that could not be read.
    expect(mountSection({ warpRef: 'feedfacecafebeef' }).section.querySelector('.output-warp-status')!.textContent).toContain(
      'could not be read',
    )
    resetBody()
    const warp = {
      id: '0123456789abcdef',
      texture: null,
      meshes: [
        { id: 'P1', viewport: { x: 0, y: 0, w: 0.5, h: 0.5 }, text: '' },
        { id: 'P2', viewport: { x: 0.5, y: 0, w: 0.5, h: 0.5 }, text: '' },
      ],
    }
    const loaded = mountSection({ warpRef: warp.id, render: { ...defaultRenderConfig(), warp } }).section
    expect(loaded.querySelector('.output-warp-status')!.textContent).toBe('Drawing 2 meshes: P1, P2.')
  })

  it('asks for the place and the frame before using SOS\'s quadrants, and imports only on the answer', async () => {
    const { section, raw } = mountSection()
    pick(section, ['sphere-sim-files.zip'])
    await until(() => section.querySelector('.output-warp-choose') !== null, 'the layout question')

    expect(section.textContent).toContain('Read 2 meshes: P1, P3.')
    // The answer is the declaration the files cannot make: where the meshes
    // go, and that their (u, v) address an equirectangular frame — with the
    // fisheye case named, since a dome's mesh would import here otherwise.
    const choose = section.querySelector<HTMLButtonElement>('.output-warp-choose')!
    expect(choose.textContent).toContain('equirectangular')
    expect(choose.textContent).toContain('SOS quadrants')
    expect(section.textContent).toContain('fisheye frame')
    // In reading order, top row first, as the display would be read.
    const cells = [...section.querySelectorAll('.output-warp-cell')]
    expect(cells.map((c) => c.textContent)).toEqual(['P3', 'P4', 'P1', 'P2'])
    expect(cells.filter((c) => c.classList.contains('is-filled')).map((c) => c.textContent)).toEqual(['P3', 'P1'])
    expect(section.querySelector('.output-warp-layout')!.getAttribute('aria-hidden')).toBe('true')
    expect(raw.importWarpSet).not.toHaveBeenCalled()

    section.querySelector<HTMLButtonElement>('.output-warp-choose')!.click()
    await until(() => repaint.mock.calls.length > 0, 'the repaint')
    expect(raw.importWarpSet).toHaveBeenCalledWith('output-1', expect.any(Array), 'sos-quadrants')
  })

  it('puts what arrives after a read in a polite live region that was there first', async () => {
    const { section } = mountSection()
    const region = section.querySelector('.output-warp-pending')!
    // Registered empty, before anything changes it — a region born with
    // its content is never announced.
    expect(region.getAttribute('role')).toBe('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.childElementCount).toBe(0)

    pick(section, ['sphere-sim-files.zip'])
    await until(() => section.querySelector('.output-warp-choose') !== null, 'the layout question')

    expect(region.contains(section.querySelector('.output-warp-choose'))).toBe(true)
    expect(region.textContent).toContain("Science On a Sphere's four quadrants")
  })

  it('announces an import and a clear, which repaint the region away', async () => {
    const { section } = mountSection()
    pick(section, ['sphere-sim-files.zip'])
    await until(() => section.querySelector('.output-warp-choose') !== null, 'the layout question')
    section.querySelector<HTMLButtonElement>('.output-warp-choose')!.click()
    await until(() => announced() !== '', 'the import announcement')
    expect(announced()).toBe('Drawing 2 meshes: P1, P3.')

    resetBody()
    document.getElementById('a11y-announcer')!.textContent = ''
    const cleared = mountSection({ warpRef: 'feedfacecafebeef' }).section
    cleared.querySelector<HTMLButtonElement>('.output-warp-clear')!.click()
    await until(() => announced() !== '', 'the clear announcement')
    expect(announced()).toContain('No warp set')
  })

  it("draws a bundle's own layout and imports it on one click, asking nothing", async () => {
    const mgr = fakeManager()
    mgr.raw.readWarpFiles.mockResolvedValue({ ok: true, sources: [source('P1'), source('P2')], layout: PAIR })
    const { section } = mountSection({}, mgr)
    pick(section, ['placed.zip'])
    await until(() => section.querySelector('.output-warp-choose') !== null, 'the layout')

    expect(section.textContent).toContain('The bundle says where each mesh goes')
    expect(section.textContent).not.toContain('Science On a Sphere')
    const cells = [...section.querySelectorAll<HTMLElement>('.output-warp-cell')]
    expect(cells.map((c) => [c.textContent, c.style.left, c.style.bottom, c.style.width, c.style.height])).toEqual([
      ['P1', '0%', '0%', '50%', '100%'],
      ['P2', '50%', '0%', '50%', '100%'],
    ])
    expect(cells.every((c) => c.classList.contains('is-filled'))).toBe(true)
    // The diagram is hidden from a screen reader, so the mapping is said in words.
    const said = [...section.querySelectorAll('.sr-only li')].map((li) => li.textContent)
    expect(said).toEqual([
      'P1: 50% of the display wide and 100% tall, 0% in from the left edge and 0% up from the bottom.',
      'P2: 50% of the display wide and 100% tall, 50% in from the left edge and 0% up from the bottom.',
    ])
    expect(section.textContent).toContain("The sphere's rotation, 37°, is already in these meshes.")

    const choose = section.querySelector<HTMLButtonElement>('.output-warp-choose')!
    expect(choose.textContent).toBe('Import')
    choose.click()
    await until(() => repaint.mock.calls.length > 0, 'the repaint')
    expect(mgr.raw.importWarpSet).toHaveBeenCalledWith('output-1', expect.any(Array), PAIR)
  })

  it('compares the display a bundle was solved for with this one', async () => {
    const mgr = fakeManager()
    const quadrants = (framebuffer: BundleLayout['framebuffer']): BundleLayout => ({
      framebuffer,
      texture: { surface: 'mesh', rotationOffsetDeg: null },
      projectors: [{ id: 'P1', viewport: { x: 0, y: 0, w: 0.5, h: 0.5 } }],
    })
    const read = async (layout: BundleLayout) => {
      mgr.raw.readWarpFiles.mockResolvedValue({ ok: true, sources: [source('P1')], layout })
      const { section } = mountSection({}, mgr)
      pick(section, ['rig.zip'])
      await until(() => section.querySelector('.output-warp-choose') !== null, 'the layout')
      const text = section.textContent ?? ''
      resetBody()
      return text
    }

    // This display is 3840×2160: the same size says nothing, and twice the
    // size is a resample.
    expect(await read(quadrants({ width: 3840, height: 2160 }))).not.toContain('Solved for')
    expect(await read(quadrants({ width: 7680, height: 4320 }))).toContain('the same shape, so every mesh is resampled')
    expect(await read(quadrants({ width: 3840, height: 2160 }))).toContain("a model's own texture layout")
  })

  it('says a stretch every projector shares once, as a fact about the display', async () => {
    // The first hardware import: sphere-sim's default rig, read on a 16:10
    // desk monitor. Every mesh fits the display it was solved for, so this
    // display is the whole story — one line, not one per projector.
    const sources = ['P1', 'P2', 'P3', 'P4'].map((id) => source(id))
    expect(await warningsFor(sources, SOS_RIG, DESK)).toEqual([
      "Solved for a 7680×4320 display, but this one is 1680×1050, a different shape, so every projector's picture will be stretched by 10%.",
    ])
    expect(await warningsFor([source('P1')], { ...SOS_RIG, projectors: SOS_RIG.projectors.slice(0, 1) }, DESK)).toEqual([
      "Solved for a 7680×4320 display, but this one is 1680×1050, a different shape, so the projector's picture will be stretched by 10%.",
    ])
    // On a display of its own shape, nothing to say beyond the resample.
    expect(await warningsFor(sources, SOS_RIG, MONITOR)).toEqual([])
  })

  it('reports each picture as it will be when a mesh does not fit even its own layout', async () => {
    // P4 is a 4:3 mesh in a 16:9 quadrant of its own layout, so the
    // display is not the whole story: it is stated as a fact, and each
    // picture as it will be on this display, shared stretches once.
    const sources = [source('P1'), source('P2'), source('P3'), source('P4', 4 / 3)]
    expect(await warningsFor(sources, SOS_RIG, DESK)).toEqual([
      'Solved for a 7680×4320 display, but this one is 1680×1050, a different shape.',
      'P1, P2, P3 were solved for 1.778:1 rasters, but their parts of this display are 1.600:1, so their pictures will be stretched by 10%.',
      'P4 was solved for a 1.333:1 raster, but its part of this display is 1.600:1, so its picture will be stretched by 20%.',
    ])
    // The same misfit on the display it was solved for: no display line,
    // and only the mesh that does not fit.
    expect(await warningsFor(sources, SOS_RIG, MONITOR)).toEqual([
      'P4 was solved for a 1.333:1 raster, but its part of this display is 1.778:1, so its picture will be stretched by 33%.',
    ])
    // A layout at odds with its mesh, on a display that happens to suit
    // the mesh: the two cancel, and the picture is not warned about.
    const dci = { ...SOS_RIG, framebuffer: { width: 4096, height: 2160 }, projectors: SOS_RIG.projectors.slice(0, 1) }
    expect(await warningsFor([source('P1')], dci, MONITOR)).toEqual([
      'Solved for a 4096×2160 display, but this one is 3840×2160, a different shape.',
    ])
  })

  it('imports nothing when the operator declines', async () => {
    const { section, raw } = mountSection()
    pick(section, ['P1.data', 'P3.data'])
    await until(() => section.querySelector('.output-warp-cancel') !== null, 'the layout question')

    section.querySelector<HTMLButtonElement>('.output-warp-cancel')!.click()

    expect(section.querySelector('.output-warp-choose')).toBeNull()
    expect(raw.importWarpSet).not.toHaveBeenCalled()
  })

  it('warns, before the choice, when a mesh is not the shape of its quadrant', async () => {
    const mgr = fakeManager()
    mgr.raw.readWarpFiles.mockResolvedValue({ ok: true, sources: [source('P1', 4 / 3)], layout: null })
    const { section } = mountSection({}, mgr)
    pick(section, ['P1.data'])
    await until(() => section.querySelector('.output-warp-choose') !== null, 'the layout question')

    expect(section.querySelector('.output-warp-pending .output-warning')!.textContent).toContain('stretched by 33%')
  })

  it('says a stretch shared by several meshes once when placing them in quadrants', async () => {
    const sources = ['P1', 'P2', 'P3', 'P4'].map((id) => source(id))
    expect(await warningsFor(sources, null, DESK)).toEqual([
      'P1, P2, P3, P4 were solved for 1.778:1 rasters, but their parts of this display are 1.600:1, so their pictures will be stretched by 10%.',
    ])
    // Two projector models: one sentence each.
    expect(await warningsFor([source('P1'), source('P2', 4 / 3), source('P3'), source('P4', 4 / 3)], null, DESK)).toEqual([
      'P1, P3 were solved for 1.778:1 rasters, but their parts of this display are 1.600:1, so their pictures will be stretched by 10%.',
      'P2, P4 were solved for 1.333:1 rasters, but their parts of this display are 1.600:1, so their pictures will be stretched by 20%.',
    ])
  })

  it('shows a refusal from reading, and one from importing, without repainting', async () => {
    const mgr = fakeManager()
    mgr.raw.readWarpFiles.mockResolvedValueOnce({ ok: false, refusal: { code: 'no-meshes', file: 'rig.zip' } } as never)
    const { section } = mountSection({}, mgr)
    pick(section, ['rig.zip'])
    await until(() => section.querySelector('.output-error') !== null, 'the read refusal')
    expect(section.querySelector('.output-error')!.textContent).toContain('rig.zip holds no warp meshes')

    mgr.raw.importWarpSet.mockResolvedValueOnce({ ok: false, refusal: { code: 'storage', reason: 'no-room' } } as never)
    pick(section, ['P1.data'])
    await until(() => section.querySelector('.output-warp-choose') !== null, 'the layout question')
    section.querySelector<HTMLButtonElement>('.output-warp-choose')!.click()
    await until(() => section.querySelector('.output-error')?.textContent?.includes('no room') ?? false, 'the import refusal')
    expect(repaint).not.toHaveBeenCalled()
  })

  it('clears the warp, and only offers to when there is one', async () => {
    expect(mountSection().section.querySelector<HTMLButtonElement>('.output-warp-clear')!.disabled).toBe(true)
    resetBody()
    const { section, raw } = mountSection({ warpRef: 'feedfacecafebeef' })
    const clear = section.querySelector<HTMLButtonElement>('.output-warp-clear')!
    expect(clear.disabled).toBe(false)

    clear.click()

    await until(() => repaint.mock.calls.length > 0, 'the repaint')
    expect(raw.clearOutputWarp).toHaveBeenCalledWith('output-1')
  })

  it('commits a blend gamma that is one, and puts back one that is not', async () => {
    const { section, raw } = mountSection()
    const gamma = section.querySelector<HTMLInputElement>('.output-warp-gamma')!
    expect(gamma.value).toBe('2.2')

    for (const bad of ['', '0', '-1', '11']) {
      gamma.value = bad
      gamma.dispatchEvent(new Event('change'))
      expect(gamma.value, bad).toBe('2.2')
    }
    expect(raw.setOutputRenderConfig).not.toHaveBeenCalled()

    gamma.value = '2.4'
    gamma.dispatchEvent(new Event('change'))
    await until(() => raw.setOutputRenderConfig.mock.calls.length === 1, 'the commit')
    expect(raw.setOutputRenderConfig).toHaveBeenCalledWith('output-1', { blendGamma: 2.4 })
  })
})
