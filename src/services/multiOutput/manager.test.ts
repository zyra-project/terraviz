// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the control window's output manager.
 *
 * The point of `MultiOutputHost` is that these run with no Tauri and
 * one monitor, and the thing they most need to pin is the **spawn
 * sequence**. A hardware spike found two ways monitor placement goes
 * wrong (signed origins, physical-vs-logical units), and the ordering
 * that avoids both — hidden → position → size → fullscreen → show —
 * is invisible in a diff and catastrophic on an installation: get it
 * wrong and the window fullscreens onto the operator's desk instead of
 * the sphere, or slides across a capture feed on every spawn. A fake
 * host that records the call order is the only place that is checkable
 * without three monitors.
 */

import { describe, it, expect, vi } from 'vitest'
import { OUTPUT_STATE_EVENT, type OutputEvent, type OutputStateMessage } from './protocol'
import {
  MultiOutputManager,
  OUTPUT_ENTRY_URL,
  type MultiOutputHost,
  type OutputMonitor,
  type OutputWindowHandle,
} from './manager'

/** A three-monitor desk shaped like the spike's: the primary at the
 *  origin, one to its **left** at a negative x, one to its right. */
const MONITORS: OutputMonitor[] = [
  {
    name: '\\\\.\\DISPLAY2',
    position: { x: 0, y: 0 },
    size: { width: 2560, height: 1440 },
    scaleFactor: 1,
  },
  {
    name: '\\\\.\\DISPLAY1',
    position: { x: -1680, y: 383 },
    size: { width: 1680, height: 1050 },
    scaleFactor: 1,
  },
  {
    // A HiDPI panel: physical size is twice the logical one, which is
    // exactly the case a scaleFactor conversion would corrupt.
    name: '\\\\.\\DISPLAY3',
    position: { x: 2560, y: 381 },
    size: { width: 3840, height: 2160 },
    scaleFactor: 2,
  },
]

interface Emitted {
  label: string
  event: string
  payload: OutputStateMessage
}

/** One live subscription. A **list**, not a map keyed by event name:
 *  keying by name silently collapses a double registration, which is
 *  precisely the bug this fake once hid — `start()` raced with itself
 *  and the "is idempotent" test could not see it. */
interface Registration {
  event: string
  handler: (payload: unknown) => void
  active: boolean
}

interface FakeOptions {
  monitors?: OutputMonitor[]
  /** Reject from this stage of the spawn sequence onward. */
  failAt?: 'setPosition' | 'setSize' | 'setFullscreen' | 'show'
  /** Make `close()` reject, as a window whose process already died does. */
  failClose?: boolean
}

function createFakeHost(options: FakeOptions = {}) {
  const monitors = options.monitors ?? MONITORS
  const calls: string[] = []
  const emitted: Emitted[] = []
  const registrations: Registration[] = []
  const closed: string[] = []

  const host: MultiOutputHost = {
    availableMonitors: async () => monitors,

    async createWindow(label, url) {
      calls.push(`create:${label}:${url}`)
      const step = async (name: string, note: string) => {
        calls.push(note)
        if (options.failAt === name) throw new Error(`${name} rejected`)
      }
      const handle: OutputWindowHandle = {
        setPosition: (x, y) => step('setPosition', `setPosition:${label}:${x},${y}`),
        setSize: (w, h) => step('setSize', `setSize:${label}:${w}x${h}`),
        setFullscreen: on => step('setFullscreen', `setFullscreen:${label}:${on}`),
        show: () => step('show', `show:${label}`),
        close: async () => {
          calls.push(`close:${label}`)
          if (options.failClose) throw new Error('close rejected')
          closed.push(label)
        },
      }
      return handle
    },

    async emitTo(label, event, payload) {
      emitted.push({ label, event, payload: payload as OutputStateMessage })
    },

    async listen(event, handler) {
      const registration: Registration = { event, handler, active: true }
      registrations.push(registration)
      return () => { registration.active = false }
    },
  }

  /** Deliver an output→manager event, as the IPC channel would. A
   *  doubly-registered listener therefore delivers twice — visible. */
  const send = (event: OutputEvent) => {
    for (const r of registrations) if (r.active) r.handler(event)
  }

  return {
    host,
    calls,
    emitted,
    closed,
    send,
    /** How many subscriptions are currently live. */
    activeListeners: () => registrations.filter(r => r.active).length,
    /** How many were ever created, live or not. */
    totalListeners: () => registrations.length,
  }
}

const ready = (label: string): OutputEvent => ({
  type: 'output_ready',
  label,
  monitorName: null,
  mode: 'sos-equirect',
})

describe('spawn sequence', () => {
  it('places, sizes, fullscreens and only then shows', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)

    await manager.addOutput({ monitorIndex: 0 })

    expect(fake.calls).toEqual([
      `create:output-1:${OUTPUT_ENTRY_URL}`,
      'setPosition:output-1:0,0',
      'setSize:output-1:2560x1440',
      'setFullscreen:output-1:true',
      'show:output-1',
    ])
  })

  it('passes a signed origin through unchanged', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)

    await manager.addOutput({ monitorIndex: 1 })

    expect(fake.calls).toContain('setPosition:output-1:-1680,383')
  })

  it('passes physical pixels through without a scaleFactor conversion', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)

    await manager.addOutput({ monitorIndex: 2 })

    // The monitor reports scaleFactor 2. Dividing by it would send
    // 1920x1080 and put the window on the wrong monitor at the wrong
    // size; the physical setters take the reported numbers as-is.
    expect(fake.calls).toContain('setPosition:output-1:2560,381')
    expect(fake.calls).toContain('setSize:output-1:3840x2160')
  })

  it('mints labels the capability glob matches, incrementing per output', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)

    const a = await manager.addOutput({ monitorIndex: 0 })
    const b = await manager.addOutput({ monitorIndex: 1 })

    expect(a.label).toBe('output-1')
    expect(b.label).toBe('output-2')
  })

  it('does not reuse a label after a removal', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)

    await manager.addOutput({ monitorIndex: 0 })
    await manager.removeOutput('output-1')
    const next = await manager.addOutput({ monitorIndex: 0 })

    // A reused label would collide with an output the OS has not
    // finished tearing down, and with any state still in flight to it.
    expect(next.label).toBe('output-2')
  })

  it('rejects a monitor index that is not there, without creating a window', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)

    await expect(manager.addOutput({ monitorIndex: 7 })).rejects.toThrow(/no monitor at index 7/)
    expect(fake.calls).toEqual([])
    expect(manager.outputs()).toEqual([])
  })

  it.each(['setPosition', 'setSize', 'setFullscreen', 'show'] as const)(
    'closes the window when %s rejects, instead of leaking it',
    async failAt => {
      const fake = createFakeHost({ failAt })
      const manager = new MultiOutputManager(fake.host)

      await expect(manager.addOutput({ monitorIndex: 0 })).rejects.toThrow(`${failAt} rejected`)

      // Without this the window exists but never reaches records/handles,
      // so nothing can ever reach it — on an installation that is a
      // hidden, undecorated window you cannot close without killing the
      // app. It must be gone, and leave no half-record behind.
      expect(fake.closed).toEqual(['output-1'])
      expect(manager.outputs()).toEqual([])
    },
  )

  it('surfaces the original failure even if the cleanup close also fails', async () => {
    const fake = createFakeHost({ failAt: 'show', failClose: true })
    const manager = new MultiOutputManager(fake.host)

    // The caller needs to know why the spawn failed, not why the
    // tidy-up did.
    await expect(manager.addOutput({ monitorIndex: 0 })).rejects.toThrow('show rejected')
    expect(manager.outputs()).toEqual([])
  })

  it('ignores an explicitly-undefined view setting rather than overwriting the default', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)

    // What a spread of an optional field produces. It must not pin the
    // output to a centred camera by accident.
    const record = await manager.addOutput({
      monitorIndex: 0,
      view: { trackCamera: undefined as unknown as boolean },
    })

    expect(record.view.trackCamera).toBe(true)
  })
})

describe('removal', () => {
  it('closes the window and drops the record', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)

    await manager.addOutput({ monitorIndex: 0 })
    await manager.removeOutput('output-1')

    expect(fake.closed).toEqual(['output-1'])
    expect(manager.outputs()).toEqual([])
  })

  it('is a no-op for a label that is already gone', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)

    // The operator closing a window by hand and the panel's remove
    // button race; neither may throw.
    await expect(manager.removeOutput('output-9')).resolves.toBeUndefined()
  })

  it('drops the record even when close rejects, and does not strand the others', async () => {
    const fake = createFakeHost({ failClose: true })
    const manager = new MultiOutputManager(fake.host)
    await manager.addOutput({ monitorIndex: 0 })
    await manager.addOutput({ monitorIndex: 1 })

    // A rejecting close must not escape: closeAll() runs these in
    // parallel, so one stuck window would reject the whole thing and
    // strand every other output's teardown.
    await expect(manager.closeAll()).resolves.toBeUndefined()
    expect(manager.outputs()).toEqual([])
    expect(fake.calls.filter(c => c.startsWith('close:'))).toHaveLength(2)
  })

  it('closeAll tears down every output', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)

    await manager.addOutput({ monitorIndex: 0 })
    await manager.addOutput({ monitorIndex: 1 })
    await manager.closeAll()

    expect(fake.closed.sort()).toEqual(['output-1', 'output-2'])
    expect(manager.outputs()).toEqual([])
  })
})

describe('broadcast', () => {
  it('sends nothing to an output that has not announced output_ready', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })

    await manager.applyState({ simulationDate: '2026-01-01T00:00:00Z' })

    expect(fake.emitted).toEqual([])
  })

  it('replies to output_ready with a full snapshot', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    await manager.applyState({ simulationDate: '2026-01-01T00:00:00Z' })

    fake.send(ready('output-1'))

    expect(fake.emitted).toHaveLength(1)
    expect(fake.emitted[0].event).toBe(OUTPUT_STATE_EVENT)
    expect(fake.emitted[0].payload.full).toBe(true)
    expect(fake.emitted[0].payload.state).toMatchObject({
      simulationDate: '2026-01-01T00:00:00Z',
    })
  })

  it('sends diffs to every ready output once they are ready', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    await manager.addOutput({ monitorIndex: 1 })
    fake.send(ready('output-1'))
    fake.send(ready('output-2'))
    fake.emitted.length = 0

    await manager.applyState({ simulationDate: '2026-02-02T00:00:00Z' })

    expect(fake.emitted.map(e => e.label).sort()).toEqual(['output-1', 'output-2'])
    expect(fake.emitted.every(e => e.payload.full === false)).toBe(true)
  })

  it('broadcasts nothing from applyState when the state did not actually change', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    fake.emitted.length = 0

    await manager.applyState({ simulationDate: null })

    expect(fake.emitted).toEqual([])
  })
})

describe('the heartbeat', () => {
  it('puts something on the wire every tick, even with nothing changed', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    fake.emitted.length = 0

    await manager.tick()

    // `IPC_STALE_MS` (5s) is measured against the STATE_TICK_MS cadence.
    // A tick that emits nothing means that cadence does not exist, and
    // every output badges itself stale on a paused or static globe.
    expect(fake.emitted).toHaveLength(1)
    expect(fake.emitted[0].event).toBe(OUTPUT_STATE_EVENT)
  })

  it('carries a full snapshot when idle, so a missed diff self-heals', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    await manager.applyState({ simulationDate: '2026-07-07T00:00:00Z' })
    fake.emitted.length = 0

    await manager.tick()

    const msg = fake.emitted[0].payload
    expect(msg.full).toBe(true)
    expect(msg.state).toMatchObject({ simulationDate: '2026-07-07T00:00:00Z' })
  })

  it('sends the diff rather than a snapshot when something did change', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    fake.emitted.length = 0

    await manager.applyState({ simulationDate: '2026-08-08T00:00:00Z' })

    expect(fake.emitted[0].payload.full).toBe(false)
  })

  it('projects the heartbeat per output like any other message', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0, view: { trackCamera: false } })
    fake.send(ready('output-1'))
    await manager.applyState({
      view: { dayNight: true, cameraOffset: { x: 0.6, y: 0, z: 0 }, split: false },
    })
    fake.emitted.length = 0

    await manager.tick()

    const state = fake.emitted[0].payload.state as { view: { cameraOffset: unknown } }
    expect(state.view.cameraOffset).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('does not beat at an output that is not ready', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })

    await manager.tick()

    expect(fake.emitted).toEqual([])
  })

  it('projects the view per output', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0, view: { trackCamera: true } })
    await manager.addOutput({ monitorIndex: 1, view: { trackCamera: false } })
    fake.send(ready('output-1'))
    fake.send(ready('output-2'))
    fake.emitted.length = 0

    await manager.applyState({
      view: { dayNight: true, cameraOffset: { x: 0.5, y: 0, z: 0 }, split: false },
    })

    const byLabel = Object.fromEntries(fake.emitted.map(e => [e.label, e.payload]))
    expect((byLabel['output-1'].state as { view: { cameraOffset: unknown } }).view.cameraOffset)
      .toEqual({ x: 0.5, y: 0, z: 0 })
    expect((byLabel['output-2'].state as { view: { cameraOffset: unknown } }).view.cameraOffset)
      .toEqual({ x: 0, y: 0, z: 0 })
  })

  it('every output on one change carries the same seq', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    await manager.addOutput({ monitorIndex: 1 })
    fake.send(ready('output-1'))
    fake.send(ready('output-2'))
    fake.emitted.length = 0

    await manager.applyState({ simulationDate: '2026-04-04T00:00:00Z' })

    const seqs = new Set(fake.emitted.map(e => e.payload.seq))
    expect(seqs.size).toBe(1)
  })

  it('pushes a fresh view when one output toggles camera tracking', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0, view: { trackCamera: true } })
    fake.send(ready('output-1'))
    await manager.applyState({
      view: { dayNight: true, cameraOffset: { x: 0.5, y: 0, z: 0 }, split: false },
    })
    fake.emitted.length = 0

    await manager.setOutputView('output-1', { trackCamera: false })

    // Without this the toggle looks inert until someone pans.
    expect(fake.emitted).toHaveLength(1)
    expect((fake.emitted[0].payload.state as { view: { cameraOffset: unknown } }).view.cameraOffset)
      .toEqual({ x: 0, y: 0, z: 0 })
  })

  it('stamps the view push with a seq that outranks what the output already applied', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0, view: { trackCamera: true } })
    fake.send(ready('output-1'))
    await manager.applyState({
      view: { dayNight: true, cameraOffset: { x: 0.5, y: 0, z: 0 }, split: false },
    })
    const lastApplied = fake.emitted[fake.emitted.length - 1].payload.seq

    await manager.setOutputView('output-1', { trackCamera: false })

    // Re-using `lastApplied` would lose under most-recent-wins
    // coalescing and the toggle would silently do nothing.
    const pushed = fake.emitted[fake.emitted.length - 1].payload.seq
    expect(pushed).toBeGreaterThan(lastApplied)
  })

  it('keeps the sequence monotonic across interleaved view pushes and diffs', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    fake.emitted.length = 0

    await manager.applyState({ simulationDate: '2026-01-01T00:00:00Z' })
    await manager.setOutputView('output-1', { split: true })
    await manager.applyState({ simulationDate: '2026-01-02T00:00:00Z' })

    const seqs = fake.emitted.map(e => e.payload.seq)
    expect(seqs).toHaveLength(3)
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
    }
  })
})

describe('event routing', () => {
  it('drops an event whose label names no live output', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })

    fake.send(ready('output-99'))

    expect(fake.emitted).toEqual([])
    expect(manager.outputs()[0].ready).toBe(false)
  })

  it('drops a payload that is not a well-formed event', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })

    for (const bad of [null, undefined, 'output_ready', 42, {}, { type: 'output_ready' }, { label: 'output-1' }, { type: 'output_ready', label: 'main' }]) {
      fake.send(bad as never)
    }

    expect(manager.outputs()[0].ready).toBe(false)
    expect(fake.emitted).toEqual([])
  })

  it('records the last event for a live output', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })

    fake.send(ready('output-1'))
    fake.send({ type: 'output_dataset_stalled', label: 'output-1', datasetId: 'ds-1' })

    expect(manager.outputs()[0].lastEvent).toEqual({
      type: 'output_dataset_stalled',
      label: 'output-1',
      datasetId: 'ds-1',
    })
  })

  it('stops sending diffs to an output that announced it is closing', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    fake.send({ type: 'output_closing', label: 'output-1' })
    fake.emitted.length = 0

    await manager.applyState({ simulationDate: '2026-05-05T00:00:00Z' })

    expect(fake.emitted).toEqual([])
  })
})

describe('lifecycle', () => {
  it('start() is idempotent — one listener, one timer', async () => {
    vi.useFakeTimers()
    try {
      const fake = createFakeHost()
      const manager = new MultiOutputManager(fake.host)
      const listen = vi.spyOn(fake.host, 'listen')

      await manager.start()
      await manager.start()

      expect(listen).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(1)
      manager.stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('start() called concurrently still registers exactly one listener', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)

    // Sequential calls were already guarded; *concurrent* ones were not,
    // because the guard read `unlisten` only after awaiting the
    // subscribe. Both saw null, both subscribed, and `stop()` then left
    // one live — delivering into a manager that believed it had stopped.
    await Promise.all([manager.start(), manager.start(), manager.start()])

    expect(fake.totalListeners()).toBe(1)

    // One delivery, not three.
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    expect(fake.emitted).toHaveLength(1)
  })

  it('a stop() during an in-flight start() leaves nothing listening', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)

    const starting = manager.start()
    manager.stop()
    await starting

    expect(fake.activeListeners()).toBe(0)
  })

  it('stop() unlistens and leaves outputs running', async () => {
    const fake = createFakeHost()
    const manager = new MultiOutputManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })

    manager.stop()

    // An output that keeps showing its last state is correct for an
    // audience mid-session; tearing it down is closeAll()'s job.
    expect(fake.activeListeners()).toBe(0)
    expect(fake.closed).toEqual([])
    expect(manager.outputs()).toHaveLength(1)
  })

  it('does not enumerate monitors or open IPC until asked', async () => {
    const fake = createFakeHost()
    const monitors = vi.spyOn(fake.host, 'availableMonitors')
    // Construction alone is what boot does before the operator has
    // ever enabled outputs; the plan requires it to cost nothing.
    void new MultiOutputManager(fake.host)

    expect(monitors).not.toHaveBeenCalled()
    expect(fake.activeListeners()).toBe(0)
    expect(fake.calls).toEqual([])
  })
})
