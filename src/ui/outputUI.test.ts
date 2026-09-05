// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { until } from '../test-utils'
import type { OutputMonitor, OutputRecord } from '../services/multiOutput/manager'
import {
  closeOutputUI,
  initOutputUI,
  monitorKey,
  openOutputUI,
  resetOutputUIForTests,
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
    view: { trackCamera: true, split: false },
    monitor: on,
    ready: false,
    lastEvent: null,
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
function fakeManager(monitors: OutputMonitor[] = [monitor()]) {
  const records: OutputRecord[] = []
  const mgr = {
    start: vi.fn(async () => {}),
    listMonitors: vi.fn(async () => monitors),
    outputs: vi.fn(() => [...records]),
    addOutput: vi.fn(async ({ monitorIndex }: { monitorIndex: number }) => {
      const target = monitors[monitorIndex]
      if (!target) throw new Error(`no monitor at index ${monitorIndex}`)
      const rec = record(`output-${records.length + 1}`, target)
      records.push(rec)
      return rec
    }),
    removeOutput: vi.fn(async (label: string) => {
      const i = records.findIndex(r => r.label === label)
      if (i >= 0) records.splice(i, 1)
    }),
    setOutputView: vi.fn(async (label: string, view: Record<string, boolean>) => {
      const rec = records.find(r => r.label === label)
      if (rec) Object.assign(rec.view, view)
    }),
  }
  return { mgr: mgr as unknown as OutputPanelManager, raw: mgr, records }
}

function mount(mgr: OutputPanelManager | null): void {
  initOutputUI({ manager: async () => mgr })
  openOutputUI()
}

/** The panel's body settles asynchronously — two IPC round trips in the
 *  real thing. Anchor on the section headings rather than on whatever a
 *  case is about to assert, so the assertion stays meaningful. */
function painted(): boolean {
  return document.querySelectorAll('.output-section').length >= 2
}

const $ = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel)
const $$ = (sel: string): Element[] => [...document.querySelectorAll(sel)]

beforeEach(() => {
  document.body.innerHTML = ''
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
    const { mgr } = fakeManager([
      monitor({ name: 'LEFT', position: { x: -1680, y: 0 } }),
      monitor({ name: 'RIGHT' }),
    ])
    mount(mgr)

    await until(painted, 'the panel body')
    const options = $$('.output-monitor-select option')
    expect(options.map(o => o.textContent)).toEqual([
      'LEFT — 1920×1080',
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

  it('pushes a view toggle straight to that output', async () => {
    const { mgr, raw } = fakeManager()
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')

    const [track, split] = $$('.output-toggle-box') as HTMLInputElement[]
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

    const split = ($$('.output-toggle-box') as HTMLInputElement[])[1]
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

  it('reopening does not leave two panels stacked', async () => {
    const { mgr } = fakeManager()
    mount(mgr)
    await until(painted, 'the first body')

    openOutputUI()

    await until(painted, 'the second body')
    expect($$('.output-panel')).toHaveLength(1)
  })
})
