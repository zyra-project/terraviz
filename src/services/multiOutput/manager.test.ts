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

import { describe, it, expect, vi, beforeEach } from 'vitest'

// The manager reports to telemetry through `outputTelemetry`, which
// emits through this barrel. Stubbed rather than left real so the
// payloads can be asserted, and so a case that is not about telemetry
// does not queue events into a shared emitter for the next one to see.
vi.mock('../../analytics', () => ({ emit: vi.fn() }))

import { emit } from '../../analytics'
import {
  DEFAULT_FRAMEBUFFER_WIDTH,
  OUTPUT_RENDER_CONFIG_EVENT,
  OUTPUT_STATE_EVENT,
  type OutputEvent,
  type OutputRenderConfig,
  type OutputStateMessage,
} from './protocol'
import {
  MultiOutputManager,
  OUTPUT_ENTRY_URL,
  type MultiOutputDeps,
  type MultiOutputHost,
  type OutputMonitor,
  type OutputWindowHandle,
} from './manager'
import {
  OUTPUT_RESTORE_STAGGER_MS,
  defaultOutputConfig,
  type OutputConfigStore,
  type PersistedOutputConfig,
} from './outputPersistence'
import { CRASH_STORM_LIMIT } from './outputHealth'

/** Telemetry payloads of one event type, in the order they were sent. */
function reported(eventType: string): Record<string, unknown>[] {
  return vi
    .mocked(emit)
    .mock.calls.map(([event]) => event as unknown as Record<string, unknown>)
    .filter(event => event.event_type === eventType)
}

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

/**
 * The state emits only.
 *
 * Two channels reach an output now — state and render config — so a
 * test about broadcast has to say which it means. Filtering rather than
 * slicing, because config and state are emitted in a defined order and
 * an index would quietly encode it in tests that are not about it.
 */
function stateEmits(emitted: readonly Emitted[]): Emitted[] {
  return emitted.filter(e => e.event === OUTPUT_STATE_EVENT)
}

/** The render-config emits only, payload narrowed. */
function configEmits(
  emitted: readonly Emitted[],
): { label: string; config: OutputRenderConfig }[] {
  return emitted
    .filter(e => e.event === OUTPUT_RENDER_CONFIG_EVENT)
    .map(e => ({ label: e.label, config: e.payload as unknown as OutputRenderConfig }))
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
  /** What the platform calls primary. Omit for "the first enumerated
   *  display"; pass `null` for a platform that will not say. */
  primary?: OutputMonitor | null
}

function createFakeHost(options: FakeOptions = {}) {
  const monitors = options.monitors ?? MONITORS
  const calls: string[] = []
  const emitted: Emitted[] = []
  const registrations: Registration[] = []
  const closed: string[] = []
  /** Per-label destroy handlers, so a test can fire one. */
  const destroyers = new Map<string, () => void>()

  const host: MultiOutputHost = {
    availableMonitors: async () => monitors,

    // The first enumerated display, which is what both desktop
    // platforms report for a default arrangement. `options.primary` is
    // for the cases that matter: a machine whose primary is not first,
    // and a platform that will not say at all.
    primaryMonitor: async () =>
      options.primary === undefined ? (monitors[0] ?? null) : options.primary,

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
        // Captured rather than ignored so a test can destroy a window
        // the way the OS would — which is the only way to reach the
        // crash path at all.
        onDestroyed: async handler => {
          destroyers.set(label, handler)
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
    /** Destroy a window the way the OS does. */
    destroy: (label: string) => destroyers.get(label)?.(),
    send,
    /** How many subscriptions are currently live. */
    activeListeners: () => registrations.filter(r => r.active).length,
    /** How many were ever created, live or not. */
    totalListeners: () => registrations.length,
  }
}

/**
 * An in-memory config store.
 *
 * Every manager in this file gets one. The default store is backed by
 * `localStorage`, which happy-dom provides and shares across cases — so
 * without this, one test's outputs would be visible to the next, and a
 * restore test would read whatever ran before it.
 */
function memoryStore(initial?: Partial<PersistedOutputConfig>): OutputConfigStore & {
  current: () => PersistedOutputConfig
  writes: number
} {
  let config: PersistedOutputConfig = { ...defaultOutputConfig(), ...initial }
  let writes = 0
  return {
    read: () => structuredClone(config),
    write: next => {
      config = structuredClone(next)
      writes++
    },
    current: () => structuredClone(config),
    get writes() {
      return writes
    },
  }
}

/** Construct a manager with an isolated store and a free stagger. */
function makeManager(host: MultiOutputHost, deps: MultiOutputDeps = {}): MultiOutputManager {
  return new MultiOutputManager(host, {
    store: deps.store ?? memoryStore(),
    sleep: deps.sleep ?? (async () => {}),
    // Stated, never inherited. The default reads `maxVideoPanels()`,
    // which answers from happy-dom's viewport size — so a case about
    // anything else would silently depend on the test environment's
    // window dimensions and start refusing spawns if they changed.
    // Large enough here that only the cases *about* the budget meet it.
    machineDecoderBudget: deps.machineDecoderBudget ?? (() => 99),
    ...deps,
  })
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
    const manager = makeManager(fake.host)

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
    const manager = makeManager(fake.host)

    await manager.addOutput({ monitorIndex: 1 })

    expect(fake.calls).toContain('setPosition:output-1:-1680,383')
  })

  it('passes physical pixels through without a scaleFactor conversion', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)

    await manager.addOutput({ monitorIndex: 2 })

    // The monitor reports scaleFactor 2. Dividing by it would send
    // 1920x1080 and put the window on the wrong monitor at the wrong
    // size; the physical setters take the reported numbers as-is.
    expect(fake.calls).toContain('setPosition:output-1:2560,381')
    expect(fake.calls).toContain('setSize:output-1:3840x2160')
  })

  it('mints labels the capability glob matches, incrementing per output', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)

    const a = await manager.addOutput({ monitorIndex: 0 })
    const b = await manager.addOutput({ monitorIndex: 1 })

    expect(a.label).toBe('output-1')
    expect(b.label).toBe('output-2')
  })

  it('does not reuse a label after a removal', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)

    await manager.addOutput({ monitorIndex: 0 })
    await manager.removeOutput('output-1')
    const next = await manager.addOutput({ monitorIndex: 0 })

    // A reused label would collide with an output the OS has not
    // finished tearing down, and with any state still in flight to it.
    expect(next.label).toBe('output-2')
  })

  it('rejects a monitor index that is not there, without creating a window', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)

    await expect(manager.addOutput({ monitorIndex: 7 })).rejects.toThrow(/no monitor at index 7/)
    expect(fake.calls).toEqual([])
    expect(manager.outputs()).toEqual([])
  })

  it.each(['setPosition', 'setSize', 'setFullscreen', 'show'] as const)(
    'closes the window when %s rejects, instead of leaking it',
    async failAt => {
      const fake = createFakeHost({ failAt })
      const manager = makeManager(fake.host)

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
    const manager = makeManager(fake.host)

    // The caller needs to know why the spawn failed, not why the
    // tidy-up did.
    await expect(manager.addOutput({ monitorIndex: 0 })).rejects.toThrow('show rejected')
    expect(manager.outputs()).toEqual([])
  })

  it('ignores an explicitly-undefined view setting rather than overwriting the default', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)

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
    const manager = makeManager(fake.host)

    await manager.addOutput({ monitorIndex: 0 })
    await manager.removeOutput('output-1')

    expect(fake.closed).toEqual(['output-1'])
    expect(manager.outputs()).toEqual([])
  })

  it('is a no-op for a label that is already gone', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)

    // The operator closing a window by hand and the panel's remove
    // button race; neither may throw.
    await expect(manager.removeOutput('output-9')).resolves.toBeUndefined()
  })

  it('drops the record even when close rejects, and does not strand the others', async () => {
    const fake = createFakeHost({ failClose: true })
    const manager = makeManager(fake.host)
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
    const manager = makeManager(fake.host)

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
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })

    await manager.applyState({ simulationDate: '2026-01-01T00:00:00Z' })

    expect(fake.emitted).toEqual([])
  })

  it('replies to output_ready with a full snapshot', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    await manager.applyState({ simulationDate: '2026-01-01T00:00:00Z' })

    fake.send(ready('output-1'))

    const states = stateEmits(fake.emitted)
    expect(states).toHaveLength(1)
    expect(states[0].payload.full).toBe(true)
    expect(states[0].payload.state).toMatchObject({
      simulationDate: '2026-01-01T00:00:00Z',
    })
  })

  it('sends the render config before the first state, not after', async () => {
    // A restored 8K output that got its state first would render at the
    // default and then reallocate — a resolution pop on a projector at
    // every launch, caused by nothing but ordering.
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0, render: { framebufferWidth: 8192 } })

    fake.send(ready('output-1'))

    expect(fake.emitted.map(e => e.event)).toEqual([
      OUTPUT_RENDER_CONFIG_EVENT,
      OUTPUT_STATE_EVENT,
    ])
    expect(configEmits(fake.emitted)[0].config.framebufferWidth).toBe(8192)
  })

  it('says nothing on the config channel to an output that is not ready', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })

    await manager.setOutputRenderConfig('output-1', { debugOverlay: true })

    // Still booting: it would apply a config against a window that does
    // not yet have a renderer. It gets this one with its first snapshot.
    expect(configEmits(fake.emitted)).toEqual([])
    fake.send(ready('output-1'))
    expect(configEmits(fake.emitted)[0].config.debugOverlay).toBe(true)
  })

  it('pushes a config change to a ready output straight away', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    fake.emitted.length = 0

    await manager.setOutputRenderConfig('output-1', { debugOverlay: true })

    // Ticking the box with a static globe on screen must not appear to
    // do nothing until someone happens to pan — the same reason
    // `setOutputView` pushes.
    expect(configEmits(fake.emitted)).toEqual([
      { label: 'output-1', config: { framebufferWidth: DEFAULT_FRAMEBUFFER_WIDTH, debugOverlay: true } },
    ])
    // And nothing on the state channel: a window setting is not a globe
    // change, so it must not consume a sequence number.
    expect(stateEmits(fake.emitted)).toEqual([])
  })

  it('changes only the settings named, leaving the rest alone', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0, render: { framebufferWidth: 8192 } })
    fake.send(ready('output-1'))
    fake.emitted.length = 0

    await manager.setOutputRenderConfig('output-1', { debugOverlay: true })

    // A partial that reset the resolution would drop an installation's
    // 8K output to the default because someone ticked a debug box.
    expect(configEmits(fake.emitted)[0].config.framebufferWidth).toBe(8192)
  })

  it('sends diffs to every ready output once they are ready', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
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
    const manager = makeManager(fake.host)
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
    const manager = makeManager(fake.host)
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
    const manager = makeManager(fake.host)
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
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    fake.emitted.length = 0

    await manager.applyState({ simulationDate: '2026-08-08T00:00:00Z' })

    expect(fake.emitted[0].payload.full).toBe(false)
  })

  it('projects the heartbeat per output like any other message', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0, view: { trackCamera: false } })
    fake.send(ready('output-1'))
    await manager.applyState({
      view: { dayNight: true, camera: { lat: 0, lon: 0, zoom: 1 } },
    })
    fake.emitted.length = 0

    await manager.tick()

    const state = fake.emitted[0].payload.state as { view: { params: { cameraOffset: unknown } } }
    expect(state.view.params.cameraOffset).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('does not beat at an output that is not ready', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })

    await manager.tick()

    expect(fake.emitted).toEqual([])
  })

  it('projects the view per output', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0, view: { trackCamera: true } })
    await manager.addOutput({ monitorIndex: 1, view: { trackCamera: false } })
    fake.send(ready('output-1'))
    fake.send(ready('output-2'))
    fake.emitted.length = 0

    await manager.applyState({
      view: { dayNight: true, camera: { lat: 0, lon: 0, zoom: 1 } },
    })

    const byLabel = Object.fromEntries(fake.emitted.map(e => [e.label, e.payload]))
    expect((byLabel['output-1'].state as { view: { params: { cameraOffset: unknown } } }).view.params.cameraOffset)
      .toEqual({ x: 0.5, y: 0, z: 0 })
    expect((byLabel['output-2'].state as { view: { params: { cameraOffset: unknown } } }).view.params.cameraOffset)
      .toEqual({ x: 0, y: 0, z: 0 })
  })

  it('every output on one change carries the same seq', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
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
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0, view: { trackCamera: true } })
    fake.send(ready('output-1'))
    await manager.applyState({
      view: { dayNight: true, camera: { lat: 0, lon: 0, zoom: 1 } },
    })
    fake.emitted.length = 0

    await manager.setOutputView('output-1', { trackCamera: false })

    // Without this the toggle looks inert until someone pans.
    expect(fake.emitted).toHaveLength(1)
    expect((fake.emitted[0].payload.state as { view: { params: { cameraOffset: unknown } } }).view.params.cameraOffset)
      .toEqual({ x: 0, y: 0, z: 0 })
  })

  it('stamps the view push with a seq that outranks what the output already applied', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0, view: { trackCamera: true } })
    fake.send(ready('output-1'))
    await manager.applyState({
      view: { dayNight: true, camera: { lat: 0, lon: 0, zoom: 1 } },
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
    const manager = makeManager(fake.host)
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
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })

    fake.send(ready('output-99'))

    expect(fake.emitted).toEqual([])
    expect(manager.outputs()[0].ready).toBe(false)
  })

  it('drops a payload that is not a well-formed event', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
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
    const manager = makeManager(fake.host)
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
    const manager = makeManager(fake.host)
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
      const manager = makeManager(fake.host)
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
    const manager = makeManager(fake.host)

    // Sequential calls were already guarded; *concurrent* ones were not,
    // because the guard read `unlisten` only after awaiting the
    // subscribe. Both saw null, both subscribed, and `stop()` then left
    // one live — delivering into a manager that believed it had stopped.
    await Promise.all([manager.start(), manager.start(), manager.start()])

    expect(fake.totalListeners()).toBe(1)

    // One delivery, not three.
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    expect(stateEmits(fake.emitted)).toHaveLength(1)
  })

  it('a stop() during an in-flight start() leaves nothing listening', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)

    const starting = manager.start()
    manager.stop()
    await starting

    expect(fake.activeListeners()).toBe(0)
  })

  it('stop() unlistens and leaves outputs running', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
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
    void makeManager(fake.host)

    expect(monitors).not.toHaveBeenCalled()
    expect(fake.activeListeners()).toBe(0)
    expect(fake.calls).toEqual([])
  })
})

describe('persistence', () => {
  it('records an added output so the next launch can bring it back', async () => {
    const fake = createFakeHost()
    const store = memoryStore()
    const manager = makeManager(fake.host, { store })

    await manager.addOutput({ monitorIndex: 1 })

    // The left-hand monitor's signed origin, stored as reported. A
    // value that had been through a logical conversion could not be
    // compared against a fresh `Monitor.position` on a HiDPI desk.
    expect(store.current().outputs).toEqual([
      {
        label: 'output-1',
        monitorName: '\\\\.\\DISPLAY1',
        monitorOrigin: { x: -1680, y: 383 },
        mode: 'sos-equirect',
        trackOperatorCamera: true,
        split: false,
        framebufferWidth: DEFAULT_FRAMEBUFFER_WIDTH,
        debugOverlay: false,
      },
    ])
  })

  it('records a config change even before the output has announced itself', async () => {
    const fake = createFakeHost()
    const store = memoryStore()
    const manager = makeManager(fake.host, { store })
    await manager.addOutput({ monitorIndex: 0 })

    await manager.setOutputRenderConfig('output-1', { framebufferWidth: 8192 })

    // The operator's choice is theirs whether or not the window has
    // announced itself; one made during boot that vanished at relaunch
    // would be a very hard thing to report.
    expect(store.current().outputs[0].framebufferWidth).toBe(8192)
  })

  it('forgets a removed output', async () => {
    const fake = createFakeHost()
    const store = memoryStore()
    const manager = makeManager(fake.host, { store })
    await manager.addOutput({ monitorIndex: 0 })
    await manager.addOutput({ monitorIndex: 1 })

    await manager.removeOutput('output-1')

    expect(store.current().outputs.map(o => o.label)).toEqual(['output-2'])
  })

  it('records a view toggle even before the output has announced itself', async () => {
    const fake = createFakeHost()
    const store = memoryStore()
    const manager = makeManager(fake.host, { store })
    await manager.addOutput({ monitorIndex: 0 })

    // Deliberately no `output_ready`. A toggle flipped while the window
    // is still booting is still the operator's choice, and one that
    // vanished at relaunch would be very hard to report.
    await manager.setOutputView('output-1', { split: true })

    expect(store.current().outputs[0].split).toBe(true)
  })

  it('keeps the operator opt-in when records change', async () => {
    const fake = createFakeHost()
    const store = memoryStore({ autoRestoreOnLaunch: true })
    const manager = makeManager(fake.host, { store })

    await manager.addOutput({ monitorIndex: 0 })

    expect(store.current().autoRestoreOnLaunch).toBe(true)
  })

  it('round-trips the restore-on-launch flag', () => {
    const store = memoryStore()
    const manager = makeManager(createFakeHost().host, { store })

    expect(manager.isRestoreOnLaunch()).toBe(false)
    manager.setRestoreOnLaunch(true)
    expect(manager.isRestoreOnLaunch()).toBe(true)
    expect(store.current().autoRestoreOnLaunch).toBe(true)
  })
})

describe('the decoder budget', () => {
  it('falls back to what the machine reports until someone pins it', () => {
    const manager = makeManager(createFakeHost().host, {
      store: memoryStore(),
      machineDecoderBudget: () => 4,
    })

    // Falling back rather than storing the machine's answer is what
    // keeps an unset budget tracking reality — a control window resized
    // below the phone threshold is reflected rather than frozen at
    // whatever was true the first time the panel was opened.
    expect(manager.decoderBudget()).toBe(4)
  })

  it('prefers the operator\'s number once they have measured the machine', () => {
    const store = memoryStore()
    const manager = makeManager(createFakeHost().host, {
      store,
      machineDecoderBudget: () => 4,
    })

    manager.setDecoderBudget(16)

    // The whole point of the field: a spike ran 16 outputs at 8192×4096
    // at full rate on a 4090 laptop, and the same build must not crash
    // an Intel-iGPU NUC. The value is a property of the deployment.
    expect(manager.decoderBudget()).toBe(16)
    expect(store.current().concurrentDecoderBudget).toBe(16)
  })

  it('clears back to the machine when the operator unsets it', () => {
    const manager = makeManager(createFakeHost().host, {
      machineDecoderBudget: () => 4,
    })
    manager.setDecoderBudget(16)

    manager.setDecoderBudget(null)

    expect(manager.decoderBudget()).toBe(4)
  })

  it('refuses a budget that would refuse everything', () => {
    const manager = makeManager(createFakeHost().host, {
      machineDecoderBudget: () => 4,
    })

    manager.setDecoderBudget(0)

    // Stored as unset rather than as 0. A budget of zero refuses every
    // output *and* every control panel, which reads as a broken app.
    expect(manager.decoderBudget()).toBe(4)
  })

  it('counts the control window as well as the outputs', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host, {
      controlPanels: () => 2,
      machineDecoderBudget: () => 6,
    })
    await manager.addOutput({ monitorIndex: 0 })

    // The cross-window part is the whole reason this exists:
    // `maxVideoPanels()` answers per window, so nothing before this
    // could see two globes and an output as three decoders on one GPU.
    expect(manager.decoderLoad()).toEqual({ used: 3, budget: 6 })
  })

  it('refuses an output that would cross the budget', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host, {
      controlPanels: () => 1,
      machineDecoderBudget: () => 2,
    })
    await manager.addOutput({ monitorIndex: 0 })

    await expect(manager.addOutput({ monitorIndex: 1 })).rejects.toThrow(/decoder budget/)
    // Refused *before* the window: the ceiling is on decoders existing,
    // and there is no window in which to intervene once one has been
    // asked for.
    expect(fake.calls.filter(c => c.startsWith('create:'))).toHaveLength(1)
  })

  it('counts a spawned output that has not announced itself yet', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host, {
      controlPanels: () => 0,
      machineDecoderBudget: () => 1,
    })
    await manager.addOutput({ monitorIndex: 0 })

    // Never `output_ready`. A window still booting is about to build a
    // decoder, and a budget that waited for the announcement would let
    // a second Add through the gap.
    await expect(manager.addOutput({ monitorIndex: 1 })).rejects.toThrow(/decoder budget/)
  })

  it('lets a removed output give its budget back', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host, {
      controlPanels: () => 0,
      machineDecoderBudget: () => 1,
    })
    await manager.addOutput({ monitorIndex: 0 })

    await manager.removeOutput('output-1')

    await expect(manager.addOutput({ monitorIndex: 1 })).resolves.toBeDefined()
  })

})

describe('restoreOutputs', () => {
  const persistedOn = (label: string, monitor: OutputMonitor) => ({
    label,
    monitorName: monitor.name,
    monitorOrigin: { x: monitor.position.x, y: monitor.position.y },
    mode: 'sos-equirect' as const,
    trackOperatorCamera: true,
    split: false,
    framebufferWidth: DEFAULT_FRAMEBUFFER_WIDTH,
    debugOverlay: false,
  })

  it('costs nothing when the operator never opted in', async () => {
    const fake = createFakeHost()
    const monitors = vi.spyOn(fake.host, 'availableMonitors')
    const store = memoryStore({
      autoRestoreOnLaunch: false,
      outputs: [persistedOn('output-1', MONITORS[0])],
    })

    const restored = await makeManager(fake.host, { store }).restoreOutputs()

    // The plan's boot flow step 1: an install that has not enabled
    // outputs enumerates no monitors and opens no IPC link.
    expect(restored).toEqual([])
    expect(monitors).not.toHaveBeenCalled()
    expect(fake.activeListeners()).toBe(0)
    expect(fake.calls).toEqual([])
  })

  it('costs nothing when opted in with nothing configured', async () => {
    const fake = createFakeHost()
    const monitors = vi.spyOn(fake.host, 'availableMonitors')
    const store = memoryStore({ autoRestoreOnLaunch: true, outputs: [] })

    await makeManager(fake.host, { store }).restoreOutputs()

    expect(monitors).not.toHaveBeenCalled()
    expect(fake.activeListeners()).toBe(0)
  })

  it('brings back an output on the monitor it was on, with its settings', async () => {
    const fake = createFakeHost()
    const store = memoryStore({
      autoRestoreOnLaunch: true,
      outputs: [{ ...persistedOn('output-1', MONITORS[1]), trackOperatorCamera: false, split: true }],
    })

    const restored = await makeManager(fake.host, { store }).restoreOutputs()

    expect(restored).toHaveLength(1)
    expect(restored[0].view).toEqual({ trackCamera: false, split: true })
    // The same spawn sequence a fresh output goes through — the order
    // is the correctness, so restore must not have its own copy of it.
    expect(fake.calls).toEqual([
      `create:output-1:${OUTPUT_ENTRY_URL}`,
      'setPosition:output-1:-1680,383',
      'setSize:output-1:1680x1050',
      'setFullscreen:output-1:true',
      'show:output-1',
    ])
  })

  it('opens the IPC link before the first restored window boots', async () => {
    const fake = createFakeHost()
    const store = memoryStore({
      autoRestoreOnLaunch: true,
      outputs: [persistedOn('output-1', MONITORS[0])],
    })

    const manager = makeManager(fake.host, { store })
    const listenersAtSpawn: number[] = []
    vi.spyOn(fake.host, 'createWindow').mockImplementation(async label => {
      listenersAtSpawn.push(fake.activeListeners())
      return {
        setPosition: async () => {},
        setSize: async () => {},
        setFullscreen: async () => {},
        show: async () => {},
        close: async () => { fake.closed.push(label) },
        onDestroyed: async () => {},
      }
    })

    await manager.restoreOutputs()

    // A restored output emits `output_ready` as it boots. A listener
    // installed after the spawn races the window it is for.
    expect(listenersAtSpawn).toEqual([1])
  })

  it('skips a monitor that matches by name alone, and says so', async () => {
    // The same display name at a different origin: the machine has been
    // rearranged, or a driver reassigned the positional names.
    const moved = { ...MONITORS[0], position: { x: 4096, y: 0 } }
    const fake = createFakeHost({ monitors: [moved] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = memoryStore({
      autoRestoreOnLaunch: true,
      outputs: [persistedOn('output-1', MONITORS[0])],
    })

    const restored = await makeManager(fake.host, { store }).restoreOutputs()

    // Restoring onto it would put a projector on the wrong monitor with
    // nothing on screen to say so.
    expect(restored).toEqual([])
    expect(fake.calls).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('restores the outputs whose monitors are present and skips the rest', async () => {
    const fake = createFakeHost({ monitors: [MONITORS[0], MONITORS[2]] })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = memoryStore({
      autoRestoreOnLaunch: true,
      outputs: [
        persistedOn('output-1', MONITORS[0]),
        persistedOn('output-2', MONITORS[1]), // unplugged
        persistedOn('output-3', MONITORS[2]),
      ],
    })

    const restored = await makeManager(fake.host, { store }).restoreOutputs()

    // An installation with three projectors must not lose all three
    // because one was unplugged.
    expect(restored.map(r => r.label)).toEqual(['output-1', 'output-3'])
  })

  it('keeps going when one window refuses to spawn', async () => {
    const fake = createFakeHost()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = memoryStore({
      autoRestoreOnLaunch: true,
      outputs: [persistedOn('output-1', MONITORS[0]), persistedOn('output-2', MONITORS[1])],
    })
    const real = fake.host.createWindow.bind(fake.host)
    let first = true
    vi.spyOn(fake.host, 'createWindow').mockImplementation(async (label, url) => {
      if (first) {
        first = false
        throw new Error('webview creation refused')
      }
      return real(label, url)
    })

    const restored = await makeManager(fake.host, { store }).restoreOutputs()

    expect(restored.map(r => r.label)).toEqual(['output-2'])
  })

  it('paces the spawns rather than firing them together', async () => {
    const fake = createFakeHost()
    const sleep = vi.fn(async () => {})
    const store = memoryStore({
      autoRestoreOnLaunch: true,
      outputs: [
        persistedOn('output-1', MONITORS[0]),
        persistedOn('output-2', MONITORS[1]),
        persistedOn('output-3', MONITORS[2]),
      ],
    })

    await makeManager(fake.host, { store, sleep }).restoreOutputs()

    // Startup contention is the one cost the spike could measure — and
    // only *between* spawns, so a single output pays nothing.
    expect(sleep.mock.calls).toEqual([
      [OUTPUT_RESTORE_STAGGER_MS],
      [OUTPUT_RESTORE_STAGGER_MS],
    ])
  })

  it('does not pace a single restored output', async () => {
    const fake = createFakeHost()
    const sleep = vi.fn(async () => {})
    const store = memoryStore({
      autoRestoreOnLaunch: true,
      outputs: [persistedOn('output-1', MONITORS[0])],
    })

    await makeManager(fake.host, { store, sleep }).restoreOutputs()

    expect(sleep).not.toHaveBeenCalled()
  })

  it('advances the label counter past what it restored', async () => {
    const fake = createFakeHost()
    const store = memoryStore({
      autoRestoreOnLaunch: true,
      outputs: [persistedOn('output-1', MONITORS[0]), persistedOn('output-2', MONITORS[1])],
    })
    const manager = makeManager(fake.host, { store })
    await manager.restoreOutputs()

    const added = await manager.addOutput({ monitorIndex: 2 })

    // Minting `output-1` again would address a window already on screen
    // — two records, one window, and the other unreachable.
    expect(added.label).toBe('output-3')
    expect(manager.outputs().map(o => o.label)).toEqual(['output-1', 'output-2', 'output-3'])
  })

  it('is held to the decoder budget, one output at a time', async () => {
    const fake = createFakeHost()
    const store = memoryStore({
      autoRestoreOnLaunch: true,
      concurrentDecoderBudget: 2,
      outputs: [
        persistedOn('output-1', MONITORS[0]),
        persistedOn('output-2', MONITORS[1]),
        persistedOn('output-3', MONITORS[2]),
      ],
    })
    const manager = makeManager(fake.host, { store, controlPanels: () => 1 })

    const restored = await manager.restoreOutputs()

    // A machine whose budget was lowered — or which now reports less
    // than it did — must not bring back every window it was configured
    // with just because they fitted last time. One control panel plus
    // one output spends a budget of two; the rest are skipped, and the
    // per-output failure path already in place means the set survives.
    expect(restored.map(r => r.label)).toEqual(['output-1'])
    expect(store.current().outputs.map(o => o.label)).toEqual(['output-1'])
  })

  it('rewrites the config with what actually came up', async () => {
    const fake = createFakeHost({ monitors: [MONITORS[0]] })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = memoryStore({
      autoRestoreOnLaunch: true,
      outputs: [persistedOn('output-1', MONITORS[0]), persistedOn('output-2', MONITORS[1])],
    })

    await makeManager(fake.host, { store }).restoreOutputs()

    // The unplugged entry is dropped rather than retried every launch.
    // The operator re-picks the display, which is also the only way
    // they find out it moved.
    expect(store.current().outputs.map(o => o.label)).toEqual(['output-1'])
    expect(store.current().autoRestoreOnLaunch).toBe(true)
  })
})

/**
 * Departures (rung 13, failure recovery case 1).
 *
 * Before this the manager recorded output events and acted on none, so
 * a window that went away stayed in `records` — still receiving diffs,
 * still holding a decoder slot, still listed in the panel. Every case
 * here is a way that shows up in front of an audience.
 */
describe('an output window that goes away', () => {
  it('drops a crashed output from the records', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.addOutput({ monitorIndex: 0 })
    expect(manager.outputs()).toHaveLength(1)

    // Destroyed having said nothing — a killed webview process.
    fake.destroy('output-1')

    expect(manager.outputs()).toHaveLength(0)
  })

  it('frees the crashed output’s decoder slot', async () => {
    // The reason a lingering record is not merely untidy: it counts
    // against the budget, so an operator replacing a crashed output can
    // be refused on behalf of a window that no longer exists.
    const fake = createFakeHost()
    const manager = makeManager(fake.host, {
      machineDecoderBudget: () => 2,
      controlPanels: () => 1,
    })
    await manager.addOutput({ monitorIndex: 0 })
    expect(manager.decoderLoad().used).toBe(2)

    fake.destroy('output-1')

    expect(manager.decoderLoad().used).toBe(1)
  })

  it('stops broadcasting to a window that is gone', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.addOutput({ monitorIndex: 0 })
    fake.emitted.length = 0

    fake.destroy('output-1')
    await manager.applyState({ simulationDate: '2026-01-01T00:00:00.000Z' })

    expect(fake.emitted).toHaveLength(0)
  })

  it('tells an operator’s own close apart from a crash', async () => {
    // An output closed with Alt+F4 announces itself first. Both end in
    // a destroy, and only the announcement separates them — which is
    // why the output emits `output_closing` at all.
    //
    // Two things make this assertion mean something. The link has to be
    // **open**, or the announcement reaches nobody and the departure is
    // a silent destroy — the exact case this is meant to tell apart.
    // And it has to run the guard's full count: one misread close looks
    // identical to one correctly-read close, because a single crash
    // does not blocklist anything.
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()

    for (let i = 0; i < CRASH_STORM_LIMIT; i++) {
      const record = await manager.addOutput({ monitorIndex: 0 })
      fake.send({ type: 'output_closing', label: record.label })
      fake.destroy(record.label)
      expect(manager.outputs()).toHaveLength(0)
    }

    // Three deliberate closes must not blocklist a perfectly good
    // monitor — an operator rearranging their displays would lock
    // themselves out of one.
    await expect(manager.addOutput({ monitorIndex: 0 })).resolves.toBeTruthy()
  })

  it('does not treat its own close as a crash', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)

    for (let i = 0; i < CRASH_STORM_LIMIT; i++) {
      const record = await manager.addOutput({ monitorIndex: 0 })
      await manager.removeOutput(record.label)
      // The destroy arrives after the close resolves, as it does in
      // Tauri — the record is already gone and there is nothing to
      // classify.
      fake.destroy(record.label)
    }

    // Removing three outputs is not a storm. If it were, an operator
    // rearranging their displays would lock themselves out.
    await expect(manager.addOutput({ monitorIndex: 0 })).resolves.toBeTruthy()
  })

  it('refuses a monitor that crashed three outputs in a minute', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)

    for (let i = 0; i < CRASH_STORM_LIMIT; i++) {
      const record = await manager.addOutput({ monitorIndex: 0 })
      fake.destroy(record.label)
    }

    await expect(manager.addOutput({ monitorIndex: 0 })).rejects.toThrow(/refusing outputs/)
  })

  it('blocks only the monitor that did it', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)

    for (let i = 0; i < CRASH_STORM_LIMIT; i++) {
      const record = await manager.addOutput({ monitorIndex: 0 })
      fake.destroy(record.label)
    }

    // The other display is fine and must stay usable — the whole point
    // of keying the guard.
    await expect(manager.addOutput({ monitorIndex: 1 })).resolves.toBeTruthy()
  })

  it('keeps a crashed output in the config, so a relaunch brings it back', async () => {
    // The operator still wants that output — the display took it away.
    // Dropping it turns a four-projector installation into a
    // three-projector one silently, which is the invisible failure this
    // module is written against. It also bounds what an ordinary quit
    // can cost: `quit_app` is `app.exit(0)`, so if Tauri delivers the
    // destroys here first they all read as crashes, and without this
    // rule every shutdown would wipe the restore config.
    const fake = createFakeHost()
    const store = memoryStore({ autoRestoreOnLaunch: true })
    const manager = makeManager(fake.host, { store })
    await manager.addOutput({ monitorIndex: 0 })
    expect(store.current().outputs).toHaveLength(1)

    fake.destroy('output-1')

    expect(manager.outputs()).toHaveLength(0)
    expect(store.current().outputs.map(o => o.label)).toEqual(['output-1'])
  })

  it('drops an output the operator closed by hand from the config', async () => {
    // The other half, and the reason the rule is a split rather than
    // "never persist a departure": a deliberate close that came back
    // next launch would look broken rather than honoured.
    const fake = createFakeHost()
    const store = memoryStore({ autoRestoreOnLaunch: true })
    const manager = makeManager(fake.host, { store })
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    expect(store.current().outputs).toHaveLength(1)

    fake.send({ type: 'output_closing', label: 'output-1' })
    fake.destroy('output-1')

    expect(store.current().outputs).toEqual([])
  })

  it('notifies a listener so an open panel can repaint', async () => {
    // Without this a crash is invisible until the panel is reopened.
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.addOutput({ monitorIndex: 0 })
    const seen = vi.fn()
    manager.onOutputsChanged(seen)

    fake.destroy('output-1')

    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('survives a listener that throws', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.addOutput({ monitorIndex: 0 })
    manager.onOutputsChanged(() => {
      throw new Error('panel exploded')
    })

    expect(() => fake.destroy('output-1')).not.toThrow()
    expect(manager.outputs()).toHaveLength(0)
  })
})

describe('telemetry', () => {
  beforeEach(() => {
    vi.mocked(emit).mockClear()
  })

  it('reports an add with a bucket and a monitor index', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)

    await manager.addOutput({ monitorIndex: 2, render: { framebufferWidth: 8192 } })

    expect(reported('output_added')).toEqual([
      {
        event_type: 'output_added',
        mode: 'sos-equirect',
        framebuffer_bucket: '8k',
        monitor_index: 2,
      },
    ])
  })

  it('reports a restored output too', async () => {
    // The event describes an output existing rather than an operator
    // gesture, and an installation that brings four back every launch
    // is the population this is Tier A for. Emitting from `spawn()`
    // is what makes that true by construction rather than by someone
    // remembering to add a second call.
    const fake = createFakeHost()
    const store = memoryStore({
      autoRestoreOnLaunch: true,
      outputs: [
        {
          label: 'output-1',
          monitorName: MONITORS[1].name,
          monitorOrigin: { x: MONITORS[1].position.x, y: MONITORS[1].position.y },
          mode: 'sos-equirect' as const,
          trackOperatorCamera: true,
          split: false,
          framebufferWidth: 4096,
          debugOverlay: false,
        },
      ],
    })

    await makeManager(fake.host, { store }).restoreOutputs()

    expect(reported('output_added')).toEqual([
      {
        event_type: 'output_added',
        mode: 'sos-equirect',
        framebuffer_bucket: '4k',
        monitor_index: 1,
      },
    ])
  })

  it('reports a Remove as an operator close, exactly once', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    const record = await manager.addOutput({ monitorIndex: 0 })

    await manager.removeOutput(record.label)
    // The destroy lands afterwards, as Tauri delivers it. The record is
    // already gone, so there is nothing left to classify — and nothing
    // to report a second time.
    fake.destroy(record.label)

    expect(reported('output_removed')).toEqual([
      { event_type: 'output_removed', mode: 'sos-equirect', reason: 'operator-close' },
    ])
  })

  it('says nothing for a second Remove of the same label', async () => {
    // `removeOutput` is documented safe to call twice — the panel's
    // button and a hand-close race — so a repeat must not invent a
    // second removal.
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    const record = await manager.addOutput({ monitorIndex: 0 })

    await manager.removeOutput(record.label)
    await manager.removeOutput(record.label)

    expect(reported('output_removed')).toHaveLength(1)
  })

  it('reports a hand-close as an operator close, and not as a failure', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    // `output_closing` arrives over the IPC link, so the link has to be
    // open for the announcement to be heard at all — without this the
    // departure is a silent destroy and classifies as a crash.
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })

    fake.send({ type: 'output_closing', label: 'output-1' })
    fake.destroy('output-1')

    expect(reported('output_removed')).toEqual([
      { event_type: 'output_removed', mode: 'sos-equirect', reason: 'operator-close' },
    ])
    expect(reported('output_failure')).toEqual([])
  })

  it('reports a crash as both a removal and a failure', async () => {
    // Two events rather than one: the removal answers "how many
    // outputs stopped, and why", the failure answers "how healthy is
    // this installation". A dashboard asks those separately.
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.addOutput({ monitorIndex: 0 })

    fake.destroy('output-1')

    expect(reported('output_removed')).toEqual([
      { event_type: 'output_removed', mode: 'sos-equirect', reason: 'crash' },
    ])
    expect(reported('output_failure')).toEqual([
      { event_type: 'output_failure', kind: 'crash', retries: 0, recovered: false },
    ])
  })

  it('reports a spawn the storm guard refused', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    for (let i = 0; i < CRASH_STORM_LIMIT; i++) {
      const record = await manager.addOutput({ monitorIndex: 0 })
      fake.destroy(record.label)
    }
    vi.mocked(emit).mockClear()

    await expect(manager.addOutput({ monitorIndex: 0 })).rejects.toThrow(/refusing outputs/)

    expect(reported('output_removed')).toEqual([
      {
        event_type: 'output_removed',
        mode: 'sos-equirect',
        reason: 'rejected-by-storm-guard',
      },
    ])
    // No add to pair it with — the window was never created.
    expect(reported('output_added')).toEqual([])
  })

  it('says nothing when the decoder budget refuses a spawn', async () => {
    // The decided reason enum has no value for it, and rightly: the
    // panel already shows "N of M in use" and disables Add, so a spent
    // budget is an affordance rather than something to report after
    // the fact.
    const fake = createFakeHost()
    const manager = makeManager(fake.host, {
      machineDecoderBudget: () => 1,
      controlPanels: () => 1,
    })

    await expect(manager.addOutput({ monitorIndex: 0 })).rejects.toThrow(/decoder budget/)

    expect(vi.mocked(emit)).not.toHaveBeenCalled()
  })

  it('puts no monitor name and no window label on the wire', async () => {
    // The one field that could identify hardware is reported as an
    // index. A regression here is invisible in the app and permanent
    // in the warehouse.
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.addOutput({ monitorIndex: 1 })
    fake.destroy('output-1')

    const payloads = JSON.stringify(vi.mocked(emit).mock.calls)
    expect(payloads).not.toContain('DISPLAY')
    expect(payloads).not.toContain('output-1')
  })
})
