// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { until } from '../test-utils'
import type { OutputMonitor, OutputRecord } from '../services/multiOutput/manager'
import {
  defaultRenderConfig,
  type OutputMode,
  type OutputRenderConfig,
} from '../services/multiOutput/protocol'
import {
  closeOutputUI,
  initOutputUI,
  monitorKey,
  openOutputUI,
  resetOutputUIForTests,
  monitorLayout,
  type OutputPanelManager,
} from './outputUI'

function monitor(over: Partial<OutputMonitor> = {}): OutputMonitor {
  return {
    name: 'DISPLAY1',
    position: { x: 0, y: 0 },
    size: { width: 1920, height: 1080 },
    scaleFactor: 1,
    ...over,
  }
}

function record(label: string, on: OutputMonitor): OutputRecord {
  return {
    label,
    mode: 'sos-equirect',
    view: { trackCamera: true, split: false, rotationOffsetDeg: 0 },
    render: defaultRenderConfig(),
    monitor: on,
    ready: false,
    lastHealthCheckAtMs: null,
    gpuLost: false,
    stallReported: false,
    health: 'starting' as const,
    lastEvent: null,
    departing: false,
    announcedClosing: false,
    warpRef: null,
  }
}

/**
 * A manager fake.
 *
 * Structural, which is the whole reason `OutputPanelManager` is an
 * interface rather than the `MultiOutputManager` class: a class with
 * private fields is typed nominally, so satisfying that type would mean
 * constructing a real manager, which needs a host, which needs Tauri.
 */
function fakeManager(
  monitors: OutputMonitor[] = [monitor()],
  /** What the platform calls primary. Omit for "the first enumerated
   *  display"; pass `null` for a platform that will not say. */
  primary: OutputMonitor | null | undefined = undefined,
) {
  const records: OutputRecord[] = []
  const changeListeners = new Set<() => void>()
  let restoreOnLaunch = false
  let decoderBudget: number | null = null
  const mgr = {
    start: vi.fn(async () => {}),
    listMonitors: vi.fn(async () => monitors),
    primaryMonitor: vi.fn(async () =>
      primary === undefined ? (monitors[0] ?? null) : primary,
    ),
    outputs: vi.fn(() => [...records]),
    addOutput: vi.fn(async ({ monitorIndex, mode }: { monitorIndex: number; mode?: OutputMode }) => {
      const target = monitors[monitorIndex]
      if (!target) throw new Error(`no monitor at index ${monitorIndex}`)
      const rec = { ...record(`output-${records.length + 1}`, target), mode: mode ?? 'sos-equirect' }
      records.push(rec)
      return rec
    }),
    readWarpFiles: vi.fn(async () => ({ ok: false as const, refusal: { code: 'nothing-picked' as const } })),
    importWarpSet: vi.fn(async () => ({ ok: false as const, refusal: { code: 'no-output' as const } })),
    clearOutputWarp: vi.fn(async () => {}),
    removeOutput: vi.fn(async (label: string) => {
      const i = records.findIndex(r => r.label === label)
      if (i >= 0) records.splice(i, 1)
    }),
    setOutputView: vi.fn(async (label: string, view: Record<string, boolean>) => {
      const rec = records.find(r => r.label === label)
      if (rec) Object.assign(rec.view, view)
    }),
    setOutputRenderConfig: vi.fn(
      async (label: string, render: Partial<OutputRenderConfig>) => {
        const rec = records.find(r => r.label === label)
        if (rec) Object.assign(rec.render, render)
      },
    ),
    framebufferWidths: vi.fn((): readonly number[] => [1024, 2048, 4096, 8192]),
    decoderLoad: vi.fn(() => ({ used: 1 + records.length, budget: decoderBudget ?? 8 })),
    setDecoderBudget: vi.fn((budget: number | null) => {
      decoderBudget = budget
    }),
    onOutputsChanged: vi.fn((listener: () => void) => {
      changeListeners.add(listener)
      return () => changeListeners.delete(listener)
    }),
    isRestoreOnLaunch: vi.fn(() => restoreOnLaunch),
    setRestoreOnLaunch: vi.fn((enabled: boolean) => {
      restoreOnLaunch = enabled
    }),
  }
  return {
    mgr: mgr as unknown as OutputPanelManager,
    raw: mgr,
    records,
    /** Fire what the real manager fires on a crash or a health change. */
    notifyChanged: () => {
      for (const listener of [...changeListeners]) listener()
    },
    liveListeners: () => changeListeners.size,
  }
}

function mount(mgr: OutputPanelManager | null): void {
  initOutputUI({ manager: async () => mgr })
  openOutputUI()
}

/** The panel's body settles asynchronously — two IPC round trips in the
 *  real thing. Anchor on the section headings rather than on whatever a
 *  case is about to assert, so the assertion stays meaningful. */
function painted(): boolean {
  return document.querySelectorAll('.output-section').length >= 3
}

const $ = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel)
const $$ = (sel: string): Element[] => [...document.querySelectorAll(sel)]

/**
 * A row's switch, found by its label rather than its position.
 *
 * Index-based lookup was here first and its own comment predicted how
 * it would fail — "an unscoped index would silently start meaning a
 * different control the next time a section moves" — which is exactly
 * what rung 14b's fourth toggle did. Scoping to the row was not the
 * fix; the ordinal was. A test asserting on the *debug overlay* switch
 * should say so, and then adding a control above it is not a test
 * change at all.
 */
const toggle = (labelText: string): HTMLInputElement => {
  const found = $$('.output-item .output-toggle').find(
    el => el.querySelector('.output-toggle-label')?.textContent === labelText,
  )
  if (!found) throw new Error(`no toggle labelled "${labelText}"`)
  return found.querySelector('.output-toggle-box') as HTMLInputElement
}

beforeEach(() => {
  // The SPA's app-wide live region (`src/index.html`). The panel
  // announces health transitions through it rather than through a
  // region of its own, because `refresh` replaces the whole panel body
  // and a region swapped out with its content never announces.
  document.body.innerHTML =
    '<div id="a11y-announcer" aria-live="polite" aria-atomic="true"></div>'
})

afterEach(() => {
  resetOutputUIForTests()
  vi.restoreAllMocks()
})

describe('monitorKey', () => {
  it('separates two displays that share a name', () => {
    // Windows display names are positional and reassignable, which is
    // why the origin is half the identity — matching on the name alone
    // would call these one monitor and refuse the second output.
    expect(monitorKey(monitor({ position: { x: 0, y: 0 } }))).not.toBe(
      monitorKey(monitor({ position: { x: -1680, y: 0 } })),
    )
  })

  it('survives a null name rather than collapsing every unnamed display', () => {
    expect(monitorKey(monitor({ name: null, position: { x: 0, y: 0 } }))).not.toBe(
      monitorKey(monitor({ name: null, position: { x: 1920, y: 0 } })),
    )
  })
})

describe('the Outputs panel', () => {
  it('says so when there is no manager, instead of offering dead controls', async () => {
    mount(null)

    await until(() => $('.output-note') !== null, 'the unavailable note')
    expect($('.output-monitor-select')).toBeNull()
    expect($('.output-add-btn')).toBeNull()
  })

  it('lists every detected display', async () => {
    const left = monitor({ name: 'LEFT', position: { x: -1680, y: 0 } })
    const { mgr } = fakeManager([left, monitor({ name: 'RIGHT' })], left)
    mount(mgr)

    await until(painted, 'the panel body')
    const options = $$('.output-monitor-select option')
    expect(options.map(o => o.textContent)).toEqual([
      'LEFT — 1920×1080 (primary)',
      'RIGHT — 1920×1080',
    ])
  })

  it('warns before the click when the only display is the one in use', async () => {
    const { mgr } = fakeManager([monitor()])
    mount(mgr)

    await until(painted, 'the panel body')
    expect($('.output-warning')).not.toBeNull()
  })

  it('does not warn when there is somewhere else to put an output', async () => {
    const { mgr } = fakeManager([monitor({ name: 'A' }), monitor({ name: 'B', position: { x: 1920, y: 0 } })])
    mount(mgr)

    await until(painted, 'the panel body')
    expect($('.output-warning')).toBeNull()
  })

  it('opens the IPC link before spawning, never after', async () => {
    const { mgr, raw } = fakeManager()
    const order: string[] = []
    raw.start.mockImplementation(async () => { order.push('start') })
    raw.addOutput.mockImplementation(async () => {
      order.push('addOutput')
      return record('output-1', monitor())
    })
    mount(mgr)
    await until(painted, 'the panel body')

    $<HTMLButtonElement>('.output-add-btn')!.click()

    await until(() => order.length === 2, 'the add to finish')
    // The output emits `output_ready` over this link as it boots, so a
    // listener installed afterwards races the window it is for — and
    // loses silently, leaving an output that renders nothing.
    expect(order).toEqual(['start', 'addOutput'])
  })

  it('adds the kind of output the operator picked, which the window is spawned as', async () => {
    const { mgr, raw } = fakeManager()
    mount(mgr)
    await until(painted, 'the panel body')
    const modes = $$('.output-mode-select option').map(o => (o as HTMLOptionElement).value)
    // An LED sphere by default: a projector rig draws nothing until it has
    // a warp, so it must be the operator's choice rather than the fallback.
    // The default names no mode — the manager's default is the geometry —
    // which keeps `sos-equirect` out of the web entry chunk altogether.
    expect(modes).toEqual(['', 'projector-warp'])
    expect($<HTMLSelectElement>('.output-mode-select')!.value).toBe('')

    $<HTMLSelectElement>('.output-mode-select')!.value = 'projector-warp'
    $<HTMLButtonElement>('.output-add-btn')!.click()

    await until(() => raw.addOutput.mock.calls.length === 1, 'the add')
    expect(raw.addOutput).toHaveBeenCalledWith({ monitorIndex: 0, mode: 'projector-warp' })
  })

  it('gives a projector-warp row its warp controls in place of the framebuffer ladder', async () => {
    const { mgr, records } = fakeManager()
    records.push({ ...record('output-1', monitor({ size: { width: 3840, height: 2160 } })), mode: 'projector-warp' })
    mount(mgr)
    await until(() => $('.output-item') !== null, 'the row')

    const row = $('.output-item')!
    expect(row.querySelector('.output-item-meta')!.textContent).toContain('Projector warp')
    // The buffer is the display's own pixels, so the ladder is not offered.
    expect(row.querySelector('.output-field-select')).toBeNull()
    expect(row.textContent).toContain("this display's own 3840×2160")
    // The field turns the content; the rig's own rotation is in the warp.
    expect(row.querySelector('label[for="output-rotation-output-1"]')!.textContent).toBe('Content rotation (°)')
    // No set, so no warp to have a rotation.
    expect(row.textContent).not.toContain('Warp rotation')
    expect(row.querySelector('.output-warp')).not.toBeNull()
  })

  it("states the warp's own rotation beside the content rotation, as the bundle said it", async () => {
    const { mgr, records } = fakeManager()
    const warp = {
      id: '0123456789abcdef',
      texture: { surface: 'sphere', rotationOffsetDeg: 37 } as const,
      meshes: [{ id: 'P1', viewport: { x: 0, y: 0, w: 1, h: 1 }, text: '' }],
    }
    const base = record('output-1', monitor())
    records.push({ ...base, mode: 'projector-warp', warpRef: warp.id, render: { ...base.render, warp } })
    mount(mgr)
    await until(() => $('.output-item') !== null, 'the row')

    expect($('.output-item')!.textContent).toContain('Warp rotation: 37°, already in the meshes')
  })

  it('shows a new output and takes its display out of the picker', async () => {
    const { mgr } = fakeManager([
      monitor({ name: 'A' }),
      monitor({ name: 'B', position: { x: 1920, y: 0 } }),
    ])
    mount(mgr)
    await until(painted, 'the panel body')

    $<HTMLButtonElement>('.output-add-btn')!.click()

    await until(() => $('.output-item') !== null, 'the new output row')
    const options = $$('.output-monitor-select option') as HTMLOptionElement[]
    // Two fullscreen windows on one monitor means one of them is
    // invisible and the operator cannot tell which. The manager takes
    // any index, so this guard exists only here.
    expect(options[0].disabled).toBe(true)
    expect(options[1].disabled).toBe(false)
    expect(options[0].textContent).toContain('already in use')
  })

  it('refuses the add outright once every display is spoken for', async () => {
    const { mgr } = fakeManager([monitor()])
    mount(mgr)
    await until(painted, 'the panel body')

    $<HTMLButtonElement>('.output-add-btn')!.click()

    await until(() => $('.output-item') !== null, 'the new output row')
    // A select whose every option is disabled has no valid value to
    // submit, so the button must go with it.
    expect($<HTMLButtonElement>('.output-add-btn')!.disabled).toBe(true)
    expect($<HTMLSelectElement>('.output-monitor-select')!.disabled).toBe(true)
  })

  it('reports a failed spawn inline and leaves the button usable', async () => {
    const { mgr, raw } = fakeManager()
    raw.addOutput.mockRejectedValue(new Error('window creation refused'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mount(mgr)
    await until(painted, 'the panel body')

    $<HTMLButtonElement>('.output-add-btn')!.click()

    await until(() => $('.output-error') !== null, 'the inline error')
    expect($('.output-error')!.textContent).toContain('window creation refused')
    // Recoverable: the operator can unplug, fix and retry without
    // reopening the panel.
    expect($<HTMLButtonElement>('.output-add-btn')!.disabled).toBe(false)
  })

  it('removes an output and frees its display again', async () => {
    const { mgr, raw } = fakeManager()
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')

    $<HTMLButtonElement>('.output-item-remove')!.click()

    await until(() => $('.output-item') === null, 'the row to go')
    expect(raw.removeOutput).toHaveBeenCalledWith('output-1')
    expect($<HTMLButtonElement>('.output-add-btn')!.disabled).toBe(false)
  })

  it('shows what is spending the machine\'s decoder budget', async () => {
    const { mgr, raw } = fakeManager()
    raw.decoderLoad.mockReturnValue({ used: 3, budget: 4 })
    mount(mgr)
    await until(painted, 'the panel body')

    // Windows that can hold a decoder, across the control window and
    // every output — the cross-window count `maxVideoPanels()` cannot
    // see, which is the whole reason the field exists.
    expect(document.body.textContent).toContain('3 of 4 video decoders in use')
    expect($<HTMLInputElement>('.output-field-number')!.value).toBe('4')
  })

  it('refuses to offer Add when the budget is spent, and says what to close', async () => {
    const { mgr, raw } = fakeManager()
    raw.decoderLoad.mockReturnValue({ used: 4, budget: 4 })
    mount(mgr)
    await until(painted, 'the panel body')

    // The manager refuses this too and would throw; disabling here is
    // the affordance, so an operator sees the machine is full rather
    // than clicking and being told.
    expect($<HTMLButtonElement>('.output-add-btn')!.disabled).toBe(true)
    expect(document.body.textContent).toContain('No decoders left')
  })

  it('pins the budget and repaints against the new one', async () => {
    const { mgr, raw } = fakeManager()
    raw.decoderLoad.mockReturnValue({ used: 4, budget: 4 })
    mount(mgr)
    await until(painted, 'the panel body')
    expect($<HTMLButtonElement>('.output-add-btn')!.disabled).toBe(true)

    raw.decoderLoad.mockReturnValue({ used: 4, budget: 16 })
    const input = $<HTMLInputElement>('.output-field-number')!
    input.value = '16'
    input.dispatchEvent(new Event('change'))

    await until(
      () => $<HTMLButtonElement>('.output-add-btn')?.disabled === false,
      'the Add button to come back',
    )
    expect(raw.setDecoderBudget).toHaveBeenCalledWith(16)
    // The number gates the button and the warning above it, so unlike
    // the per-output toggles this one does repaint.
    expect(document.body.textContent).not.toContain('No decoders left')
  })

  it('clears the pin rather than storing an unusable budget', async () => {
    const { mgr, raw } = fakeManager()
    mount(mgr)
    await until(painted, 'the panel body')

    const input = $<HTMLInputElement>('.output-field-number')!
    input.value = ''
    input.dispatchEvent(new Event('change'))

    // An emptied box means "I have not measured this machine", and the
    // manager answers with what the machine reports — never 0, which
    // would refuse every output and every globe panel.
    await until(() => raw.setDecoderBudget.mock.calls.length === 1, 'the budget write')
    expect(raw.setDecoderBudget).toHaveBeenCalledWith(null)
  })

  it('pushes the debug overlay on its own channel, not as a view change', async () => {
    const { mgr, raw } = fakeManager()
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')

    const overlay = toggle('Debug overlay (drawn on the output)')
    expect(overlay.checked).toBe(false)

    overlay.checked = true
    overlay.dispatchEvent(new Event('change'))

    await until(() => raw.setOutputRenderConfig.mock.calls.length === 1, 'the config push')
    expect(raw.setOutputRenderConfig).toHaveBeenCalledWith('output-1', {
      debugOverlay: true,
    })
    // Window configuration, not globe state: routing this through
    // `setOutputView` would put a checkbox inside the sequence the
    // aggregator diffs.
    expect(raw.setOutputView).not.toHaveBeenCalled()
  })

  it('pushes the calibration pattern on the config channel, beside the debug HUD', async () => {
    const { mgr, raw } = fakeManager()
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')

    const pattern = toggle('Calibration pattern')
    expect(pattern.checked).toBe(false)

    pattern.checked = true
    pattern.dispatchEvent(new Event('change'))

    await until(() => raw.setOutputRenderConfig.mock.calls.length === 1, 'the config push')
    expect(raw.setOutputRenderConfig).toHaveBeenCalledWith('output-1', { calibration: true })
    // The same reason the debug HUD goes here: it is a property of one
    // window, and routing it through the view would put it inside the
    // sequence the aggregator diffs — and would put a test pattern on
    // every output when the operator is aligning one sphere.
    expect(raw.setOutputView).not.toHaveBeenCalled()
  })

  it('sits directly above the rotation it is used with', async () => {
    const { mgr } = fakeManager()
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')

    // Not decoration: the pattern is what the rotation is turned
    // *against*, and an operator doing that job reaches for the two in
    // this order. Pinned so a later control cannot quietly land between
    // them.
    const row = $('.output-item')!
    const kids = [...row.children]
    const pattern = kids.findIndex(
      el => el.querySelector('.output-toggle-label')?.textContent === 'Calibration pattern',
    )
    const rotation = kids.findIndex(el => el.querySelector('.output-rotation-number') !== null)
    expect(pattern).toBeGreaterThan(-1)
    expect(rotation).toBe(pattern + 1)
  })

  it('puts the debug checkbox back when the output refuses it', async () => {
    const { mgr, raw } = fakeManager()
    raw.setOutputRenderConfig.mockRejectedValue(new Error('output is gone'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')

    const overlay = toggle('Debug overlay (drawn on the output)')
    overlay.checked = true
    overlay.dispatchEvent(new Event('change'))

    await until(() => overlay.disabled === false, 'the in-flight guard to clear')
    // A control that claims a state the output is not in is worse than
    // one that visibly refuses.
    expect(overlay.checked).toBe(false)
  })

  it('offers the rungs the manager reports, not a list of its own', async () => {
    const { mgr, raw } = fakeManager()
    raw.framebufferWidths.mockReturnValue([2048, 4096])
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')

    const select = $<HTMLSelectElement>('.output-field-select')!
    // Read through the manager because `outputUI` may not import
    // `multiOutput/` at runtime — a hard-coded ladder here would be a
    // second copy free to disagree with the one the output snaps to.
    expect([...select.options].map(o => o.value)).toEqual(['2048', '4096'])
    expect([...select.options].map(o => o.textContent)).toEqual([
      '2048×1024',
      '4096×2048',
    ])
  })

  it('starts on the resolution the output is actually running', async () => {
    const { mgr, records } = fakeManager()
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')

    expect($<HTMLSelectElement>('.output-field-select')!.value).toBe(
      String(records[0].render.framebufferWidth),
    )
  })

  it('pushes a resolution change on the config channel', async () => {
    const { mgr, raw } = fakeManager()
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')

    const select = $<HTMLSelectElement>('.output-field-select')!
    select.value = '8192'
    select.dispatchEvent(new Event('change'))

    await until(() => raw.setOutputRenderConfig.mock.calls.length === 1, 'the config push')
    // A number, not the select's string: `setSize` would take '8192'
    // and produce a buffer of NaN by NaN.
    expect(raw.setOutputRenderConfig).toHaveBeenCalledWith('output-1', {
      framebufferWidth: 8192,
    })
  })

  it('puts the picker back on the running resolution when the change fails', async () => {
    const { mgr, raw } = fakeManager()
    raw.setOutputRenderConfig.mockRejectedValue(new Error('out of GPU memory'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')

    const select = $<HTMLSelectElement>('.output-field-select')!
    const before = select.value
    select.value = '8192'
    select.dispatchEvent(new Event('change'))

    await until(() => select.disabled === false, 'the in-flight guard to clear')
    // An 8K allocation is exactly the change that can be refused, and a
    // picker left claiming 8192 would send an operator hunting a
    // performance problem on a buffer that never existed.
    expect(select.value).toBe(before)
  })

  it('shows a width off the ladder rather than a blank select', async () => {
    const { mgr, records } = fakeManager()
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')
    // A record from somewhere the parse did not narrow.
    records[0].render.framebufferWidth = 3000
    closeOutputUI()
    openOutputUI()
    await until(() => $('.output-item') !== null, 'the repainted row')

    const select = $<HTMLSelectElement>('.output-field-select')!
    // Not rounded to a neighbour the output is not running, and not
    // blank — a blank select reads as a broken panel.
    expect(select.value).toBe('3000')
    expect(select.options[0].textContent).toBe('3000×1500')
  })

  it('pushes a view toggle straight to that output', async () => {
    const { mgr, raw } = fakeManager()
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')

    const track = toggle('Track operator camera')
    const split = toggle('Split sphere')
    expect(track.checked).toBe(true)
    expect(split.checked).toBe(false)

    track.checked = false
    track.dispatchEvent(new Event('change'))

    await until(() => raw.setOutputView.mock.calls.length === 1, 'the view push')
    expect(raw.setOutputView).toHaveBeenCalledWith('output-1', { trackCamera: false })
    // No refresh: `setOutputView` already pushed the view and mutated
    // the record, so repainting would spend a monitor enumeration per
    // click. One from the add, none from the toggle.
    expect(raw.listMonitors).toHaveBeenCalledTimes(2)
  })

  it('puts the checkbox back when the output refuses the change', async () => {
    const { mgr, raw } = fakeManager()
    raw.setOutputView.mockRejectedValue(new Error('output is gone'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')

    const split = toggle('Split sphere')
    split.checked = true
    split.dispatchEvent(new Event('change'))

    await until(() => !split.disabled, 'the change to settle')
    // A control claiming a state the output is not in is worse than one
    // that visibly refuses.
    expect(split.checked).toBe(false)
  })

  it('closes on Escape and gives focus back to what opened it', async () => {
    const { mgr } = fakeManager()
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    initOutputUI({ manager: async () => mgr })
    openOutputUI(trigger)
    await until(painted, 'the panel body')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect($('.output-panel')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('spends nothing more on a panel that has since closed', async () => {
    const { mgr, raw } = fakeManager()
    const manager = vi.fn(async () => mgr)
    initOutputUI({ manager })
    openOutputUI()

    closeOutputUI()

    // Positive anchor: the manager lookup really did resolve, so the
    // assertions below mean "the refresh stopped there" rather than
    // "it had not started yet".
    await manager.mock.results[0]!.value
    await new Promise(r => setTimeout(r, 0))

    expect(manager).toHaveBeenCalledTimes(1)
    // It bails at the first of the two checkpoints, so a closed panel
    // does not even pay for the monitor enumeration.
    expect(raw.listMonitors).not.toHaveBeenCalled()
    expect($('.output-panel')).toBeNull()
  })

  it('names each output by the display the picker offered, not a constant', async () => {
    // Linux reports `name: null` often enough that this is the common
    // case there, not an edge one. A hardcoded index labelled every
    // unnamed display "Display 1": two outputs, one name, and two Remove
    // buttons with the same accessible name.
    const { mgr } = fakeManager([
      monitor({ name: null }),
      monitor({ name: null, position: { x: 1920, y: 0 } }),
    ])
    mount(mgr)
    await until(painted, 'the panel body')

    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the first row')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $$('.output-item').length === 2, 'the second row')

    const names = $$('.output-item-name').map(n => n.textContent)
    expect(names).toEqual(['Display 1', 'Display 2'])
    // The accessible name has to distinguish them too — it is the only
    // thing a screen-reader user has to tell the two Remove buttons apart.
    const removeLabels = ($$('.output-item-remove') as HTMLElement[]).map(b =>
      b.getAttribute('aria-label'),
    )
    expect(new Set(removeLabels).size).toBe(2)
  })

  it('falls back to the origin for a display unplugged since the spawn', async () => {
    const gone = monitor({ name: null, position: { x: 1920, y: 0 } })
    const { mgr, raw, records } = fakeManager([monitor({ name: null }), gone])
    mount(mgr)
    await until(painted, 'the panel body')
    records.push(record('output-9', gone))
    // The display is no longer enumerated, so it has no index to name it
    // by. The signed origin is unique and stays true with nothing plugged
    // in; naming the state properly is rung 13.
    raw.listMonitors.mockResolvedValue([monitor({ name: null })])

    openOutputUI()

    await until(() => $('.output-item') !== null, 'the row for the gone display')
    expect($('.output-item-name')!.textContent).toBe('Display at 1920, 0')
  })

  it('shows the launch opt-in off by default', async () => {
    const { mgr } = fakeManager()
    mount(mgr)

    await until(painted, 'the panel body')
    // Off by default on purpose: an operator who added an output once,
    // on a laptop later taken home, should not have a window try to
    // open on a projector that is not there.
    expect($<HTMLInputElement>('#output-restore-launch')!.checked).toBe(false)
  })

  it('writes the launch opt-in straight through', async () => {
    const { mgr, raw } = fakeManager()
    mount(mgr)
    await until(painted, 'the panel body')

    const box = $<HTMLInputElement>('#output-restore-launch')!
    box.checked = true
    box.dispatchEvent(new Event('change'))

    expect(raw.setRestoreOnLaunch).toHaveBeenCalledWith(true)
  })

  it('reflects an opt-in the manager already had', async () => {
    const { mgr, raw } = fakeManager()
    raw.isRestoreOnLaunch.mockReturnValue(true)
    mount(mgr)

    await until(painted, 'the panel body')
    expect($<HTMLInputElement>('#output-restore-launch')!.checked).toBe(true)
  })

  it('renders the unavailable state when opened before it was wired', async () => {
    // Copilot read `source?.manager().catch(...)` as calling `.catch()`
    // on `undefined`. Optional chaining short-circuits the *whole* chain,
    // so the expression is `undefined` and `.catch` is never reached —
    // but the path was genuinely untested, which is why this exists.
    // `resetOutputUIForTests` in afterEach leaves `source` null.
    openOutputUI()

    await until(() => $('.output-note') !== null, 'the unavailable note')
    expect($('.output-panel')).not.toBeNull()
    expect($('.output-monitor-select')).toBeNull()
  })

  it('reopening does not leave two panels stacked', async () => {
    const { mgr } = fakeManager()
    mount(mgr)
    await until(painted, 'the first body')

    openOutputUI()

    await until(painted, 'the second body')
    expect($$('.output-panel')).toHaveLength(1)
  })
})

/**
 * The position diagram's arithmetic.
 *
 * Kept pure and tested here because the thing it gets wrong is silent:
 * a diagram drawn from a bad layout still looks like a diagram, and an
 * operator reads it as the truth about their desk right up to the
 * moment a fullscreen window opens on the wrong display.
 */
describe('the health badge', () => {
  it('shows nothing for a healthy output', async () => {
    // A row of green "OK" chips trains an operator to stop reading
    // them, and this panel is where someone goes when they suspect a
    // problem. The steady state should look exactly as it did before
    // the badge existed.
    const fake = fakeManager()
    mount(fake.mgr)
    await until(painted, 'the panel to settle')
    await fake.mgr.addOutput({ monitorIndex: 0 })
    fake.records[0].ready = true
    fake.records[0].health = 'live'
    fake.notifyChanged()
    await until(() => $$('.output-item').length === 1, 'the row')

    expect($('.output-item-health')).toBeNull()
  })

  it('badges a stale link, and says what that means', async () => {
    const fake = fakeManager()
    mount(fake.mgr)
    await until(painted, 'the panel to settle')
    await fake.mgr.addOutput({ monitorIndex: 0 })
    fake.records[0].health = 'stale'
    fake.notifyChanged()

    await until(() => $('.output-item-health') !== null, 'the badge')
    const badge = $<HTMLElement>('.output-item-health')
    expect(badge?.classList.contains('is-stale')).toBe(true)
    // The label is two words; the accessible name has to carry the part
    // that is not obvious — that the sphere still shows a picture.
    expect(badge?.textContent ?? '').toMatch(/last frame/i)
    // And it has to carry it as *content*. `aria-label` shipped here
    // first and is discarded: ARIA forbids naming an element whose role
    // is `generic`, which is what a bare `<span>` is, so the whole
    // explanation was dropped and only "Link stale" announced.
    expect(badge?.hasAttribute('aria-label')).toBe(false)
    // The visible chip stays two words — the explanation is for AT.
    expect($('.output-item-health-label')?.textContent).toBe('Link stale')
  })

  it('badges a lost GPU context, and says the sphere is blank rather than stale', async () => {
    // The distinction is the entire value of the badge. A stale output
    // is showing an old picture; this one is showing nothing at all,
    // and on a projector both look like "something on the wall" until
    // someone reads the row.
    const fake = fakeManager()
    mount(fake.mgr)
    await until(painted, 'the panel to settle')
    await fake.mgr.addOutput({ monitorIndex: 0 })
    fake.records[0].health = 'gpu-lost'
    fake.notifyChanged()

    await until(() => $('.output-item-health') !== null, 'the badge')
    const badge = $<HTMLElement>('.output-item-health')
    expect(badge?.classList.contains('is-gpu-lost')).toBe(true)
    expect($('.output-item-health-label')?.textContent).toBe('Display lost')
    expect(badge?.textContent ?? '').toMatch(/nothing at all/i)
    expect(badge?.hasAttribute('aria-label')).toBe(false)
  })

  it('announces a transition, because the repaint itself is silent', async () => {
    // `onOutputsChanged` repaints the panel so an operator does not
    // have to close and reopen the one surface that would tell them an
    // output went quiet. A screen-reader operator gets nothing from
    // that: the body is replaced wholesale and a swapped-out subtree
    // says nothing. Without this the badge solves the problem for
    // people who can see it and reproduces it for people who cannot.
    const fake = fakeManager()
    mount(fake.mgr)
    await until(painted, 'the panel to settle')
    await fake.mgr.addOutput({ monitorIndex: 0 })
    fake.notifyChanged()
    await until(() => $$('.output-item').length === 1, 'the row')

    fake.records[0].health = 'stale'
    fake.notifyChanged()

    const live = document.getElementById('a11y-announcer')!
    await until(() => (live.textContent ?? '') !== '', 'the announcement')
    expect(live.textContent).toMatch(/DISPLAY1/)
    expect(live.textContent).toMatch(/stale/i)
    expect(live.textContent).toMatch(/last frame/i)
  })

  it('says nothing about the state the panel opened on', async () => {
    // An operator who just opened the panel is about to read it. Being
    // told what is already on screen is the noise that teaches people
    // to stop listening to the channel.
    const fake = fakeManager()
    await fake.mgr.addOutput({ monitorIndex: 0 })
    fake.records[0].health = 'stale'

    mount(fake.mgr)
    await until(() => $$('.output-item').length === 1, 'the row')
    // One frame — the exact delay `announcePolite` schedules on — so
    // an announcement that was going to happen has happened.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

    expect(document.getElementById('a11y-announcer')!.textContent).toBe('')
  })

  it('folds a whole installation going quiet into one utterance', async () => {
    // The announcer is atomic and each write replaces the last, so a
    // control window that stops talking — taking every output stale in
    // the same tick — has to arrive as one string or every output but
    // the last is silently dropped.
    const second = monitor({ name: 'DISPLAY2', position: { x: 1920, y: 0 } })
    const fake = fakeManager([monitor(), second])
    mount(fake.mgr)
    await until(painted, 'the panel to settle')
    await fake.mgr.addOutput({ monitorIndex: 0 })
    await fake.mgr.addOutput({ monitorIndex: 1 })
    fake.notifyChanged()
    await until(() => $$('.output-item').length === 2, 'both rows')

    for (const r of fake.records) r.health = 'stale'
    fake.notifyChanged()

    const live = document.getElementById('a11y-announcer')!
    await until(() => (live.textContent ?? '') !== '', 'the announcement')
    expect(live.textContent).toMatch(/DISPLAY1/)
    expect(live.textContent).toMatch(/DISPLAY2/)
  })

  it('repaints on a change the panel did not cause', async () => {
    // The manager has fired `onOutputsChanged` since rung 13a and
    // nothing subscribed, so a crash stayed on screen until the panel
    // was reopened — the one moment an operator is least likely to
    // reach for.
    const fake = fakeManager()
    mount(fake.mgr)
    await until(painted, 'the panel to settle')
    await fake.mgr.addOutput({ monitorIndex: 0 })
    fake.notifyChanged()
    await until(() => $$('.output-item').length === 1, 'the row')

    fake.records.length = 0
    fake.notifyChanged()

    await until(() => $$('.output-item').length === 0, 'the row to go')
  })

  it('drops its subscription when the panel closes', async () => {
    const fake = fakeManager()
    mount(fake.mgr)
    await until(painted, 'the panel to settle')
    expect(fake.liveListeners()).toBe(1)

    closeOutputUI()

    expect(fake.liveListeners()).toBe(0)
  })

  it('keeps exactly one subscription across repaints', async () => {
    // Every refresh re-subscribes, so without dropping the previous one
    // a panel left open through a few changes would repaint once per
    // listener and grow from there.
    const fake = fakeManager()
    mount(fake.mgr)
    await until(painted, 'the panel to settle')
    fake.notifyChanged()
    await until(() => fake.raw.outputs.mock.calls.length >= 2, 'a repaint')
    fake.notifyChanged()
    await until(() => fake.raw.outputs.mock.calls.length >= 3, 'another repaint')

    expect(fake.liveListeners()).toBe(1)
  })
})

describe('monitorLayout', () => {
  it('places a negative origin inside the box instead of off its edge', () => {
    // The arrangement the hardware spike behind this feature actually
    // found: primary on the right, secondary at x = -1680. A layout
    // that assumed a non-negative origin would put LEFT at a negative
    // fraction, which CSS renders outside the container.
    const layout = monitorLayout([
      monitor({ name: 'LEFT', position: { x: -1680, y: 0 }, size: { width: 1680, height: 1050 } }),
      monitor({ name: 'RIGHT', position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } }),
    ])

    expect(layout).not.toBeNull()
    const [left, right] = layout!.boxes
    expect(left.x).toBe(0)
    expect(right.x).toBeCloseTo(1680 / 3600)
    // And left really is to the left, which is the one thing the
    // diagram exists to say.
    expect(left.x).toBeLessThan(right.x)
  })

  it('is to scale, so a 4K beside a 1080p reads as the bigger panel', () => {
    const layout = monitorLayout([
      monitor({ position: { x: 0, y: 0 }, size: { width: 3840, height: 2160 } }),
      monitor({ position: { x: 3840, y: 0 }, size: { width: 1920, height: 1080 } }),
    ])!

    const [big, small] = layout.boxes
    expect(big.width).toBeCloseTo(3840 / 5760)
    expect(small.width).toBeCloseTo(1920 / 5760)
    expect(big.height).toBeCloseTo(1)
    expect(small.height).toBeCloseTo(0.5)
    expect(layout.aspect).toBeCloseTo(5760 / 2160)
  })

  it('stacks vertically when that is how the desk is arranged', () => {
    const layout = monitorLayout([
      monitor({ position: { x: 0, y: -1080 }, size: { width: 1920, height: 1080 } }),
      monitor({ position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } }),
    ])!

    expect(layout.boxes[0].y).toBe(0)
    expect(layout.boxes[1].y).toBeCloseTo(0.5)
    expect(layout.aspect).toBeCloseTo(1920 / 2160)
  })

  it('drops an undrawable display without losing the others or their indices', () => {
    // One bad entry must not cost the diagram — the same per-entry
    // tolerance rung 10's persistence parse uses. The surviving box
    // still has to point at its own option, so the index is the one
    // from the array passed in, not a position in the filtered list.
    const layout = monitorLayout([
      monitor({ name: 'BROKEN', size: { width: 0, height: 0 } }),
      monitor({ name: 'REAL', position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } }),
    ])!

    expect(layout.boxes).toHaveLength(1)
    expect(layout.boxes[0].index).toBe(1)
  })

  it('refuses to draw when there is no arrangement', () => {
    // An empty framed box reads as a failure; no diagram reads as a
    // machine with nothing to show, which is what it is.
    expect(monitorLayout([])).toBeNull()
    expect(monitorLayout([monitor({ size: { width: 0, height: 0 } })])).toBeNull()
    expect(
      monitorLayout([monitor({ size: { width: Number.NaN, height: Number.NaN } })]),
    ).toBeNull()
    expect(
      monitorLayout([monitor({ position: { x: Number.POSITIVE_INFINITY, y: 0 } })]),
    ).toBeNull()
  })
})

describe('the position diagram', () => {
  const boxes = (): HTMLElement[] => $$('.output-monitor-box') as HTMLElement[]

  it('draws one box per display, in the order the desk has them', async () => {
    const left = monitor({ name: 'LEFT', position: { x: -1920, y: 0 } })
    const { mgr } = fakeManager([left, monitor({ name: 'RIGHT' })], left)
    mount(mgr)

    await until(painted, 'the panel body')
    const drawn = boxes()
    expect(drawn).toHaveLength(2)
    expect(parseFloat(drawn[0].style.left)).toBeCloseTo(0)
    expect(parseFloat(drawn[1].style.left)).toBeCloseTo(50)
    expect(parseFloat(drawn[0].style.width)).toBeCloseTo(50)
  })

  it('is hidden from assistive technology, because the picker already says it', async () => {
    // Not an oversight: every fact the diagram draws is in the option
    // text below it, and a second reading of one choice — or worse, a
    // second control for it — is noise in a screen reader.
    const { mgr } = fakeManager()
    mount(mgr)

    await until(painted, 'the panel body')
    expect($('.output-monitor-map')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('marks the primary display the platform named, not the first one', async () => {
    const first = monitor({ name: 'FIRST' })
    const second = monitor({ name: 'SECOND', position: { x: 1920, y: 0 } })
    const { mgr } = fakeManager([first, second], second)
    mount(mgr)

    await until(painted, 'the panel body')
    expect(boxes()[0].classList.contains('is-primary')).toBe(false)
    expect(boxes()[1].classList.contains('is-primary')).toBe(true)
    const options = $$('.output-monitor-select option')
    expect(options[1].textContent).toContain('primary')
    expect(options[0].textContent).not.toContain('primary')
  })

  it('marks nothing when the platform will not say which is primary', async () => {
    // X11 can leave no display marked, and a guess that is usually
    // right and silently wrong is the failure the name-only monitor
    // match was rejected for.
    const { mgr } = fakeManager([monitor({ name: 'A' }), monitor({ name: 'B', position: { x: 1920, y: 0 } })], null)
    mount(mgr)

    await until(painted, 'the panel body')
    expect(boxes().some(b => b.classList.contains('is-primary'))).toBe(false)
    expect($$('.output-monitor-select option').some(o => o.textContent?.includes('primary'))).toBe(
      false,
    )
  })

  it('keeps the panel when the primary lookup rejects', async () => {
    // A marker is worth less than the panel. The enumeration failing is
    // fatal to it; this is not.
    const { mgr, raw } = fakeManager()
    raw.primaryMonitor.mockRejectedValue(new Error('no'))
    mount(mgr)

    await until(painted, 'the panel body')
    expect($('.output-monitor-map')).not.toBeNull()
    expect(boxes().some(b => b.classList.contains('is-primary'))).toBe(false)
  })

  it('dims a display that already has an output rather than hiding it', async () => {
    const a = monitor({ name: 'A' })
    const b = monitor({ name: 'B', position: { x: 1920, y: 0 } })
    const { mgr } = fakeManager([a, b], a)
    mount(mgr)
    await until(painted, 'the panel body')

    const select = $<HTMLSelectElement>('.output-monitor-select')!
    select.value = '1'
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => boxes().some(box => box.classList.contains('is-occupied')), 'the add')

    // Still two boxes: a display with an output on it is part of the
    // arrangement, and a hole where it sits would misdescribe the desk.
    expect(boxes()).toHaveLength(2)
    expect(boxes()[0].classList.contains('is-occupied')).toBe(false)
    expect(boxes()[1].classList.contains('is-occupied')).toBe(true)
  })

  it('moves the highlight when the picker changes', async () => {
    const a = monitor({ name: 'A' })
    const { mgr } = fakeManager([a, monitor({ name: 'B', position: { x: 1920, y: 0 } })], a)
    mount(mgr)
    await until(painted, 'the panel body')

    expect(boxes()[0].classList.contains('is-selected')).toBe(true)
    const select = $<HTMLSelectElement>('.output-monitor-select')!
    select.value = '1'
    select.dispatchEvent(new Event('change'))

    expect(boxes()[0].classList.contains('is-selected')).toBe(false)
    expect(boxes()[1].classList.contains('is-selected')).toBe(true)
  })

  it('omits the diagram rather than drawing an empty frame', async () => {
    const { mgr } = fakeManager([monitor({ size: { width: 0, height: 0 } })])
    mount(mgr)

    await until(painted, 'the panel body')
    expect($('.output-monitor-map')).toBeNull()
    // The display is still listed: it can be picked even if it cannot
    // be drawn to scale.
    expect($$('.output-monitor-select option')).toHaveLength(1)
  })
})

describe('the rotation offset control (rung 14)', () => {
  const slider = () => $<HTMLInputElement>('.output-field-slider')
  const number = () => $<HTMLInputElement>('.output-rotation-number')

  const withOutput = async () => {
    const fake = fakeManager()
    mount(fake.mgr)
    await until(painted, 'the panel to settle')
    await fake.mgr.addOutput({ monitorIndex: 0 })
    fake.notifyChanged()
    await until(() => slider() !== null, 'the rotation control')
    return fake
  }

  it('offers a slider and a number showing the same value', async () => {
    // Two controls for one job: finding the rotation is a drag while
    // watching the sphere, reproducing a known one is typing it.
    const fake = await withOutput()
    fake.records[0].view.rotationOffsetDeg = 0

    expect(slider()!.value).toBe('0')
    expect(number()!.value).toBe('0')
  })

  it('commits a drag live, because the operator is looking at the sphere', async () => {
    // `input`, not `change`. A rotation that only lands on mouse-up
    // makes calibration a drag-release-look loop instead of a turn.
    const fake = await withOutput()

    slider()!.value = '90'
    slider()!.dispatchEvent(new Event('input'))

    await until(() => fake.raw.setOutputView.mock.calls.length > 0, 'the commit')
    expect(fake.raw.setOutputView).toHaveBeenCalledWith('output-1', { rotationOffsetDeg: 90 })
    // And the other control follows, so neither can show a value the
    // output is not running at.
    expect(number()!.value).toBe('90')
  })

  it('wraps a typed value into range instead of rejecting it', async () => {
    const fake = await withOutput()

    number()!.value = '370'
    number()!.dispatchEvent(new Event('change'))

    await until(() => fake.raw.setOutputView.mock.calls.length > 0, 'the commit')
    expect(fake.raw.setOutputView).toHaveBeenCalledWith('output-1', { rotationOffsetDeg: 10 })
    expect(slider()!.value).toBe('10')
  })

  it('ignores a half-typed value rather than snapping the sphere to zero', async () => {
    // `Number('')` is 0, not NaN — so a lone `Number.isFinite` guard
    // reads a field cleared for retyping as a deliberate zero and spins
    // the picture back to the prime meridian between keystrokes. This
    // test failed against exactly that, on the first version.
    const fake = await withOutput()

    for (const halfTyped of ['', '   ', '-']) {
      number()!.value = halfTyped
      number()!.dispatchEvent(new Event('change'))
    }

    expect(fake.raw.setOutputView).not.toHaveBeenCalled()
  })

  it('puts the value back when the commit fails', async () => {
    // Same posture as every other control here: one that reports a
    // state the output is not in is worse than one that refuses.
    const fake = await withOutput()
    fake.raw.setOutputView.mockRejectedValueOnce(new Error('no such window'))

    slider()!.value = '120'
    slider()!.dispatchEvent(new Event('input'))

    await until(() => slider()!.value === '0', 'the value to be put back')
    expect(number()!.value).toBe('0')
  })
})

describe('announcing a GPU recovery (rung 13, case 5 — review)', () => {
  it('says the display recovered, not that the link is in contact', async () => {
    // `live` from any other state says "in contact with the control
    // window" — true the whole time a GPU was lost, since the link was
    // never what failed. A screen-reader operator would be told the one
    // fact that was never in doubt and not the one that changed.
    const fake = fakeManager()
    mount(fake.mgr)
    await until(painted, 'the panel to settle')
    await fake.mgr.addOutput({ monitorIndex: 0 })
    fake.records[0].health = 'gpu-lost'
    fake.notifyChanged()
    await until(() => $('.output-item-health') !== null, 'the badge')
    document.getElementById('a11y-announcer')!.textContent = ''

    fake.records[0].health = 'live'
    fake.notifyChanged()

    const live = document.getElementById('a11y-announcer')!
    await until(() => (live.textContent ?? '') !== '', 'the announcement')
    expect(live.textContent).toMatch(/recovered/i)
    expect(live.textContent).not.toMatch(/in contact/i)
  })

  it('still says "in contact" when a stale link recovers', async () => {
    // The special case is keyed on where the transition came *from*, so
    // the ordinary stale→live recovery is untouched.
    const fake = fakeManager()
    mount(fake.mgr)
    await until(painted, 'the panel to settle')
    await fake.mgr.addOutput({ monitorIndex: 0 })
    fake.records[0].health = 'stale'
    fake.notifyChanged()
    await until(() => $('.output-item-health') !== null, 'the badge')
    document.getElementById('a11y-announcer')!.textContent = ''

    fake.records[0].health = 'live'
    fake.notifyChanged()

    const live = document.getElementById('a11y-announcer')!
    await until(() => (live.textContent ?? '') !== '', 'the announcement')
    expect(live.textContent).toMatch(/in contact/i)
  })
})

describe('the rotation slider under a fast drag (review)', () => {
  it('does not let an older commit overwrite a newer one', async () => {
    // `input` fires per drag event, so several commits are in flight at
    // once and settle in whatever order IPC returns them. Without a
    // generation guard a slow early commit resolving last rewrites the
    // baseline to its own stale value.
    const fake = fakeManager()
    mount(fake.mgr)
    await until(painted, 'the panel to settle')
    await fake.mgr.addOutput({ monitorIndex: 0 })
    fake.notifyChanged()
    await until(() => $('.output-field-slider') !== null, 'the rotation control')
    const slider = $<HTMLInputElement>('.output-field-slider')!

    // The first commit hangs; the second resolves straight away.
    let releaseFirst: (() => void) | undefined
    fake.raw.setOutputView.mockImplementationOnce(
      async () => new Promise<void>(resolve => { releaseFirst = () => resolve() }),
    )
    slider.value = '30'
    slider.dispatchEvent(new Event('input'))
    slider.value = '200'
    slider.dispatchEvent(new Event('input'))
    await until(() => fake.raw.setOutputView.mock.calls.length === 2, 'both commits')

    // Now let the stale one finish, and fail it — the worst case, since
    // its catch would otherwise repaint both controls.
    releaseFirst?.()
    await new Promise(r => setTimeout(r, 0))

    expect(slider.value).toBe('200')
    expect($<HTMLInputElement>('.output-rotation-number')!.value).toBe('200')
  })
})
