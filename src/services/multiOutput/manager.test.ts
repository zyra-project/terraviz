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
import { until } from '../../test-utils'
import {
  DEFAULT_BLEND_GAMMA,
  DEFAULT_FRAMEBUFFER_WIDTH,
  OUTPUT_REATTACH_EVENT,
  OUTPUT_RENDER_CONFIG_EVENT,
  OUTPUT_STATE_EVENT,
  type OutputEvent,
  type OutputMode,
  type OutputRenderConfig,
  type OutputStateMessage,
} from './protocol'
import { createWarpSetStore, WARP_SET_KEY_PREFIX, type WarpSetStore, type WarpStorageLike } from './warpStorage'
import { readWarpSources, warpSetId, type WarpSource } from './warpImport'
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
import { CRASH_STORM_LIMIT, STALE_REPORT_TTL_MS } from './outputHealth'

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
  /** Announce `output_ready` from this point in the spawn sequence, as
   *  a real output does — its webview starts loading at
   *  `createWindow`, so its boot runs concurrently with everything the
   *  manager does afterwards. */
  announceReadyAt?: 'setPosition' | 'setSize' | 'setFullscreen' | 'show'
  /** Windows this app already owns before the manager boots — the
   *  control-window reload case 6 exists for. */
  existing?: string[]
  /** Labels among `existing` that answer the reattach poke. Omit for
   *  "all of them"; pass `[]` for a window that has gone unresponsive. */
  answerReattach?: string[]
  /** The geometry a window says it is when it answers a poke, as its
   *  own URL told it. Omit for `sos-equirect`. */
  modes?: Record<string, OutputMode>
  /** Hold every `close()` until this settles, as a window slow to tear
   *  down does. */
  closeGate?: Promise<unknown>
}

function createFakeHost(options: FakeOptions = {}) {
  const monitors = options.monitors ?? MONITORS
  const calls: string[] = []
  const emitted: Emitted[] = []
  const registrations: Registration[] = []
  const closed: string[] = []
  /** Per-label destroy handlers, so a test can fire one. The value is
   *  `unknown` rather than `void` because the manager's handler is
   *  async — a departure that would read as a crash waits out
   *  `OUTPUT_CLOSING_GRACE_MS` for a late announcement — and `destroy`
   *  hands that promise back so a test awaits the real chain instead
   *  of guessing how many turns it takes. */
  const destroyers = new Map<string, () => unknown>()

  /** The parts of a handle that are the same however the window came
   *  to exist — which is exactly what adopting one has to prove. */
  const handleFor = (label: string): OutputWindowHandle => ({
    setPosition: async () => {},
    setSize: async () => {},
    setFullscreen: async () => {},
    show: async () => {},
    close: async () => {
      calls.push(`close:${label}`)
      await options.closeGate
      if (options.failClose) throw new Error('close rejected')
      closed.push(label)
    },
    // Captured rather than ignored so a test can destroy a window the
    // way the OS would — which is the only way to reach the crash path
    // at all.
    onDestroyed: async handler => {
      destroyers.set(label, handler)
    },
  })

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
        if (options.announceReadyAt === name) send(ready(label))
        if (options.failAt === name) throw new Error(`${name} rejected`)
      }
      return {
        ...handleFor(label),
        setPosition: (x, y) => step('setPosition', `setPosition:${label}:${x},${y}`),
        setSize: (w, h) => step('setSize', `setSize:${label}:${w}x${h}`),
        setFullscreen: on => step('setFullscreen', `setFullscreen:${label}:${on}`),
        show: () => step('show', `show:${label}`),
      }
    },

    // The real host returns every `output-*` window the app owns,
    // spawned by this manager or a previous one. The fake's are always
    // from a previous one, which is the case worth exercising.
    async existingOutputs() {
      calls.push('existingOutputs')
      return (options.existing ?? []).map(label => ({ label, handle: handleFor(label) }))
    },

    async emitTo(label, event, payload) {
      emitted.push({ label, event, payload: payload as OutputStateMessage })
      // A real output answers the poke by re-announcing over the link,
      // which is what makes the manager's one serve path do the rest.
      // Synchronous here rather than deferred: the manager awaits the
      // emit and then sleeps, so anything the window says lands well
      // inside that window either way.
      if (event === OUTPUT_REATTACH_EVENT) {
        const answers = options.answerReattach ?? options.existing ?? []
        if (answers.includes(label)) send(ready(label, options.modes?.[label]))
      }
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
    /** Destroy a window the way the OS does. Await it: the manager's
     *  handler is async for the grace window above. */
    destroy: async (label: string) => {
      await destroyers.get(label)?.()
    },
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
/**
 * `Storage` over a Map, for the warp store — the same isolation reason
 * as `memoryStore`: happy-dom's `localStorage` is shared across cases.
 */
function memoryWarpStorage(): WarpStorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: key => void map.delete(key),
    get length() {
      return map.size
    },
    key: index => [...map.keys()][index] ?? null,
  }
}

function makeManager(host: MultiOutputHost, deps: MultiOutputDeps = {}): MultiOutputManager {
  return new MultiOutputManager(host, {
    store: deps.store ?? memoryStore(),
    warpStore: deps.warpStore ?? createWarpSetStore(memoryWarpStorage()),
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

const ready = (label: string, mode: OutputMode = 'sos-equirect'): OutputEvent => ({
  type: 'output_ready',
  label,
  monitorName: null,
  mode,
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

  it('spawns a projector-warp output with its mode on the URL, the one thing it can read before IPC', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)

    await manager.addOutput({ monitorIndex: 0, mode: 'projector-warp' })

    expect(fake.calls[0]).toBe(`create:output-1:${OUTPUT_ENTRY_URL}?mode=projector-warp`)
    expect(manager.outputs()[0].mode).toBe('projector-warp')
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

  it('hears an output that announces itself mid-placement', async () => {
    // The webview starts loading at `createWindow`, so the output's
    // boot runs concurrently with the placement sequence — four awaited
    // IPC calls, plus the destroy registration. An `output_ready` that
    // lands in that gap used to be dropped by `handleOutputEvent` for
    // an unknown label, and nothing ever retried: the record stayed
    // `ready: false` for the life of the window, the first snapshot and
    // the render config were never sent, and the operator got an output
    // stuck on the idle Earth with no error anywhere.
    const fake = createFakeHost({ announceReadyAt: 'setPosition' })
    const manager = makeManager(fake.host)
    await manager.start()

    await manager.addOutput({ monitorIndex: 0 })

    expect(manager.outputs()[0].ready).toBe(true)
    // And it was actually served: config first, then the snapshot.
    expect(configEmits(fake.emitted)).toHaveLength(1)
    expect(stateEmits(fake.emitted)).toHaveLength(1)
  })

  it('leaves nothing behind when placement fails after registration', async () => {
    // The record now goes in before the window is placed, so the
    // failure path has to take it out again — otherwise a spawn that
    // threw leaves a phantom output holding a decoder slot and listed
    // in the panel.
    const fake = createFakeHost({ failAt: 'setFullscreen' })
    const manager = makeManager(fake.host, { controlPanels: () => 1 })

    await expect(manager.addOutput({ monitorIndex: 0 })).rejects.toThrow(/setFullscreen/)

    expect(manager.outputs()).toEqual([])
    // The control window's own panel and nothing else — the phantom
    // gave its slot back.
    expect(manager.decoderLoad().used).toBe(1)
    expect(fake.calls).toContain('close:output-1')
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

  it('projects the snapshot into a projector-warp output\'s own arm', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0, mode: 'projector-warp' })

    fake.send(ready('output-1', 'projector-warp'))

    const states = stateEmits(fake.emitted)
    expect((states[0].payload.state as { view: { mode: string } }).view.mode).toBe('projector-warp')
  })

  it('closes a window that announces the wrong geometry, sends it nothing, and keeps its configuration', async () => {
    // A projector-warp output driven as sos-equirect would put an
    // unwarped globe across projectors calibrated for a warp. Not
    // serving it is not enough, since an undriven output draws its own
    // idle Earth, so it is closed. The configuration is not what is
    // wrong, so it stays, and nothing in the telemetry schema is true of
    // a build disagreeing with itself.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fake = createFakeHost()
    const store = memoryStore()
    const manager = makeManager(fake.host, { store })
    await manager.start()
    await manager.addOutput({ monitorIndex: 0, mode: 'projector-warp' })
    const seen = vi.fn()
    manager.onOutputsChanged(seen)
    vi.mocked(emit).mockClear()

    fake.send(ready('output-1'))
    await until(() => seen.mock.calls.length > 0, 'the panel told')

    expect(fake.closed).toEqual(['output-1'])
    expect(fake.emitted).toEqual([])
    expect(manager.outputs()).toEqual([])
    expect(store.current().outputs.map(o => [o.label, o.mode])).toEqual([['output-1', 'projector-warp']])
    expect(reported('output_removed')).toEqual([])
    expect(errors.mock.calls.flat().join(' ')).toMatch(/announced 'sos-equirect' but was spawned as 'projector-warp'/)
    errors.mockRestore()
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
      {
        label: 'output-1',
        config: {
          framebufferWidth: DEFAULT_FRAMEBUFFER_WIDTH,
          debugOverlay: true,
          calibration: false,
          warp: null,
          blendGamma: DEFAULT_BLEND_GAMMA,
        },
      },
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
      view: { dayNight: true, camera: { lat: 0, lon: 0, zoom: 1, bearing: 0 } },
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
      view: { dayNight: true, camera: { lat: 0, lon: 0, zoom: 1, bearing: 0 } },
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
      view: { dayNight: true, camera: { lat: 0, lon: 0, zoom: 1, bearing: 0 } },
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
      view: { dayNight: true, camera: { lat: 0, lon: 0, zoom: 1, bearing: 0 } },
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

describe('a stale link (rung 13, case 3)', () => {
  it('answers a health check with the config and a fresh snapshot', async () => {
    // Reaching the handler *is* the answer to "is anyone there", so the
    // reply is a resync rather than an acknowledgement: whatever cost
    // the output its heartbeat may also have cost it a diff, and a full
    // snapshot is the same round trip as a ping reply.
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    fake.emitted.length = 0

    fake.send({ type: 'output_health_check', label: 'output-1', silentMs: 5000 })

    expect(configEmits(fake.emitted)).toHaveLength(1)
    const states = stateEmits(fake.emitted)
    expect(states).toHaveLength(1)
    expect((states[0].payload as OutputStateMessage).full).toBe(true)
  })

  it('sends the config before the state, as the ready path does', async () => {
    // One serve path, not two. A restored 8K output that got its state
    // first would render at the default and then reallocate — a
    // resolution pop caused by nothing but ordering, and a second copy
    // of that ordering is a second place for it to drift.
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0, render: { framebufferWidth: 8192 } })
    fake.send(ready('output-1'))
    fake.emitted.length = 0

    fake.send({ type: 'output_health_check', label: 'output-1', silentMs: 7000 })

    expect(fake.emitted.map(e => e.event)).toEqual([
      OUTPUT_RENDER_CONFIG_EVENT,
      OUTPUT_STATE_EVENT,
    ])
  })

  it('serves an output whose announcement was missed, once it says what it is', async () => {
    // A ping proves the window is up and listening, which is what
    // `output_ready` proves. Without this an output that lost its
    // announcement — a manager restart, or the spawn-ordering race —
    // stays un-served for the life of the window. A ping does not say
    // what geometry the window is, so the reply is the reattach poke,
    // and the window's answer is what gets served.
    const fake = createFakeHost({ answerReattach: ['output-1'] })
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    // No `output_ready` at all.
    expect(manager.outputs()[0].ready).toBe(false)
    fake.emitted.length = 0

    fake.send({ type: 'output_health_check', label: 'output-1', silentMs: 5000 })
    await until(() => stateEmits(fake.emitted).length > 0, 'the serve')

    expect(manager.outputs()[0].ready).toBe(true)
    expect(fake.emitted.map(e => e.event)).toEqual([
      OUTPUT_REATTACH_EVENT,
      OUTPUT_RENDER_CONFIG_EVENT,
      OUTPUT_STATE_EVENT,
    ])
  })

  it('sends nothing to a window that pings before announcing, until it says what it is', async () => {
    // The ping is how a mismatched window would otherwise be driven
    // before its announcement said what geometry it is.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fake = createFakeHost({ answerReattach: [] })
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0, mode: 'projector-warp' })
    fake.emitted.length = 0

    fake.send({ type: 'output_health_check', label: 'output-1', silentMs: 5000 })
    fake.send({ type: 'output_health_check', label: 'output-1', silentMs: 6000 })
    await until(() => fake.emitted.length === 2, 'two pokes')

    expect(fake.emitted.map(e => e.event)).toEqual([OUTPUT_REATTACH_EVENT, OUTPUT_REATTACH_EVENT])
    expect(manager.outputs()[0].ready).toBe(false)

    fake.send(ready('output-1'))
    await until(() => fake.closed.length === 1, 'the close')
    expect(fake.emitted.map(e => e.event)).toEqual([OUTPUT_REATTACH_EVENT, OUTPUT_REATTACH_EVENT])
    errors.mockRestore()
  })

  it('badges an output that reported the link stale, and notifies', async () => {
    // The badge is the only place this surfaces. A stale output renders
    // its last frame, which looks entirely correct on the sphere.
    const fake = createFakeHost()
    let clock = 0
    const manager = makeManager(fake.host, { nowMs: () => clock })
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    expect(manager.outputs()[0].health).toBe('live')
    const seen = vi.fn()
    manager.onOutputsChanged(seen)

    fake.send({ type: 'output_health_check', label: 'output-1', silentMs: 5000 })

    expect(manager.outputs()[0].health).toBe('stale')
    expect(seen).toHaveBeenCalled()
  })

  it('clears the badge once the complaints stop', async () => {
    // Nothing arrives to say the link recovered — the output simply
    // goes quiet — so the heartbeat is the only thing that can notice.
    const fake = createFakeHost()
    let clock = 0
    const manager = makeManager(fake.host, { nowMs: () => clock })
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    fake.send({ type: 'output_health_check', label: 'output-1', silentMs: 5000 })
    expect(manager.outputs()[0].health).toBe('stale')

    clock += STALE_REPORT_TTL_MS
    await manager.tick()

    expect(manager.outputs()[0].health).toBe('live')
  })

  it('badges a spawned output as starting until it announces', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })

    expect(manager.outputs()[0].health).toBe('starting')
    fake.send(ready('output-1'))
    expect(manager.outputs()[0].health).toBe('live')
  })

  it('does not persist the health fields', async () => {
    // A complaint from last Tuesday means nothing to a window that has
    // not been spawned yet. `toPersistedOutput` takes a `Pick`, so this
    // holds by construction — asserted so a later field addition to
    // that pick cannot quietly change it.
    const fake = createFakeHost()
    const store = memoryStore()
    const manager = makeManager(fake.host, { store })
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    fake.send({ type: 'output_health_check', label: 'output-1', silentMs: 5000 })

    const [persisted] = store.current().outputs
    expect(persisted).not.toHaveProperty('health')
    expect(persisted).not.toHaveProperty('lastHealthCheckAtMs')
  })

  it('ignores a ping from a label it does not know', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.emitted.length = 0

    fake.send({ type: 'output_health_check', label: 'output-9', silentMs: 5000 })

    expect(fake.emitted).toEqual([])
  })
})

describe('a lost GPU context (rung 13, case 5)', () => {
  const gpuLost = (label: string) => ({ type: 'output_gpu_lost' as const, label })
  const gpuBack = (label: string) => ({ type: 'output_gpu_recovered' as const, label })

  it('badges the output and notifies the panel', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    expect(manager.outputs()[0].health).toBe('live')
    const seen = vi.fn()
    manager.onOutputsChanged(seen)

    fake.send(gpuLost('output-1'))

    expect(manager.outputs()[0].health).toBe('gpu-lost')
    expect(seen).toHaveBeenCalled()
  })

  it('outranks a stale link, because it is a report rather than a guess', async () => {
    // An output can be both: its context goes, and separately the
    // control window stops reaching it. `stale` is inferred from
    // silence and says the sphere holds an old frame; `gpu-lost` is
    // the window stating outright that it holds nothing. The specific
    // claim wins.
    const fake = createFakeHost()
    let clock = 0
    const manager = makeManager(fake.host, { nowMs: () => clock })
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))

    fake.send({ type: 'output_health_check', label: 'output-1', silentMs: 5000 })
    expect(manager.outputs()[0].health).toBe('stale')

    fake.send(gpuLost('output-1'))
    expect(manager.outputs()[0].health).toBe('gpu-lost')
  })

  it('does NOT age out the way a stale link does', async () => {
    // The two facts decay differently and this is the one that must
    // not. An output stops complaining about its link by going quiet,
    // so `stale` has to expire on a TTL — but a lost context is
    // announced once and then nothing more is said about it, so the
    // same treatment would declare a black projector healthy five
    // seconds later. Only the matching recovery clears it.
    const fake = createFakeHost()
    let clock = 0
    const manager = makeManager(fake.host, { nowMs: () => clock })
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    fake.send(gpuLost('output-1'))

    clock += STALE_REPORT_TTL_MS * 100
    await manager.tick()

    expect(manager.outputs()[0].health).toBe('gpu-lost')
  })

  it('clears the badge when the output says the context came back', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    fake.send(gpuLost('output-1'))
    expect(manager.outputs()[0].health).toBe('gpu-lost')

    fake.send(gpuBack('output-1'))

    expect(manager.outputs()[0].health).toBe('live')
  })

  it('reports the incident as a PAIR — opened on the loss, closed on the recovery', async () => {
    // The first draft emitted only the opening row and argued that one
    // row per incident avoided double-counting. Review caught that
    // `recovered` is defined on the schema as whether the output
    // carried on afterwards — and an output Three rebuilds does — so a
    // never-updated `false` reported every recovered installation as
    // unrecovered, on the dashboard panel this rung added.
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    vi.mocked(emit).mockClear()

    fake.send(gpuLost('output-1'))
    fake.send(gpuBack('output-1'))

    const failures = vi
      .mocked(emit)
      .mock.calls.map(c => c[0])
      .filter(e => e.event_type === 'output_failure')
    expect(failures).toEqual([
      // Opening: nothing attempted here, nothing known about the
      // outcome yet.
      { event_type: 'output_failure', kind: 'gpu-loss', retries: 0, recovered: false },
      // Closing: `retries: 1` credits the browser and Three's
      // `initGLContext()`, which is the only thing that retried.
      { event_type: 'output_failure', kind: 'gpu-loss', retries: 1, recovered: true },
    ])
  })

  it('leaves an incident that never comes back with only its opening row', async () => {
    // So "incidents" is the count of `recovered: false` rows, whatever
    // happened afterwards — which is what makes the pair countable.
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    vi.mocked(emit).mockClear()

    fake.send(gpuLost('output-1'))

    const failures = vi
      .mocked(emit)
      .mock.calls.map(c => c[0])
      .filter(e => e.event_type === 'output_failure')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ recovered: false })
  })

  it('does not close an incident this manager never opened', async () => {
    // A reattached output reports its standing `restored` state to the
    // fresh manager that poked it. Without the latch check that would
    // open a recovery for a loss this installation never saw, and the
    // dashboard would count a recovery that did not happen here.
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    vi.mocked(emit).mockClear()

    fake.send(gpuBack('output-1'))

    expect(
      vi
        .mocked(emit)
        .mock.calls.map(c => c[0])
        .filter(e => e.event_type === 'output_failure'),
    ).toEqual([])
  })

  it('does not persist the GPU latch', async () => {
    // Same `Pick` that keeps `health` and `lastHealthCheckAtMs` out. A
    // GPU that failed last Tuesday says nothing about a window that has
    // not been spawned yet.
    const fake = createFakeHost()
    const store = memoryStore()
    const manager = makeManager(fake.host, { store })
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    fake.send(gpuLost('output-1'))

    const [persisted] = store.current().outputs
    expect(persisted).not.toHaveProperty('gpuLost')
  })

  it('ignores a report from a label it does not know', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    vi.mocked(emit).mockClear()

    fake.send(gpuLost('output-9'))

    expect(manager.outputs()[0].health).toBe('live')
    expect(vi.mocked(emit)).not.toHaveBeenCalled()
  })
})

describe('a stream that died on an output', () => {
  // The output emits nothing of its own (`outputTelemetry.ts`); it tells
  // the manager, and the manager reports it.
  it('reports one output_failure for each stream the output says died', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    vi.mocked(emit).mockClear()

    fake.send({ type: 'output_dataset_stalled', label: 'output-1', datasetId: 'ds-1' })

    const failures = vi
      .mocked(emit)
      .mock.calls.map(c => c[0])
      .filter(e => e.event_type === 'output_failure')
    // Nothing on this side retried or recovered it, so `0` and `false`
    // are literal. The dataset id stays out of the event.
    expect(failures).toEqual([{ event_type: 'output_failure', kind: 'hls-stalled', retries: 0, recovered: false }])
  })

  it('ignores one from a label it does not know', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    vi.mocked(emit).mockClear()

    fake.send({ type: 'output_dataset_stalled', label: 'output-9', datasetId: 'ds-1' })

    expect(vi.mocked(emit)).not.toHaveBeenCalled()
  })

  const stalledRows = () =>
    vi
      .mocked(emit)
      .mock.calls.map(c => c[0])
      .filter(e => e.event_type === 'output_failure')

  it('reports at most once per output per dataset, and again for a new dataset', async () => {
    // The bound for an output that does not keep to one per stream: a
    // buggy rebuild loop, or a compromised window.
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    vi.mocked(emit).mockClear()

    for (let i = 0; i < 5; i++) fake.send({ type: 'output_dataset_stalled', label: 'output-1', datasetId: 'ds-1' })
    expect(stalledRows()).toHaveLength(1)

    // The control window publishes a dataset: a new stream on every
    // output, owed its own report.
    await manager.applyState({ dataset: null })
    fake.send({ type: 'output_dataset_stalled', label: 'output-1', datasetId: 'ds-1' })
    expect(stalledRows()).toHaveLength(2)
  })

  it('does not report one from a window on its way out', async () => {
    // Its stream ending is the close.
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    fake.send(ready('output-1'))
    fake.send({ type: 'output_closing', label: 'output-1' })
    vi.mocked(emit).mockClear()

    fake.send({ type: 'output_dataset_stalled', label: 'output-1', datasetId: 'ds-1' })

    expect(stalledRows()).toEqual([])
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
        rotationOffsetDeg: 0,
        framebufferWidth: DEFAULT_FRAMEBUFFER_WIDTH,
        debugOverlay: false,
        warpId: null,
        blendGamma: DEFAULT_BLEND_GAMMA,
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

/** One persisted output, as a previous launch left it. Shared by the
 *  restore and the boot scan, which read the same entries by label —
 *  the coupling case 6's ordering rule exists for. */
const persistedOn = (label: string, monitor: OutputMonitor) => ({
  label,
  monitorName: monitor.name,
  monitorOrigin: { x: monitor.position.x, y: monitor.position.y },
  mode: 'sos-equirect' as const,
  trackOperatorCamera: true,
  split: false,
  rotationOffsetDeg: 0,
  framebufferWidth: DEFAULT_FRAMEBUFFER_WIDTH,
  debugOverlay: false,
  warpId: null,
  blendGamma: DEFAULT_BLEND_GAMMA,
})

describe('restoreOutputs', () => {
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
    expect(restored[0].view).toEqual({ trackCamera: false, split: true, rotationOffsetDeg: 0 })
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
    await fake.destroy('output-1')

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

    await fake.destroy('output-1')

    expect(manager.decoderLoad().used).toBe(1)
  })

  it('stops broadcasting to a window that is gone', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.addOutput({ monitorIndex: 0 })
    fake.emitted.length = 0

    await fake.destroy('output-1')
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
      await fake.destroy(record.label)
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
      await fake.destroy(record.label)
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
      await fake.destroy(record.label)
    }

    await expect(manager.addOutput({ monitorIndex: 0 })).rejects.toThrow(/refusing outputs/)
  })

  it('blocks only the monitor that did it', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)

    for (let i = 0; i < CRASH_STORM_LIMIT; i++) {
      const record = await manager.addOutput({ monitorIndex: 0 })
      await fake.destroy(record.label)
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

    await fake.destroy('output-1')

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
    await fake.destroy('output-1')

    expect(store.current().outputs).toEqual([])
  })

  it('honours an output_closing that lands just after the destroy', async () => {
    // The output fires its announcement from a close-requested handler
    // and lets the window go without waiting for it — a hook that can
    // block is a hook that can strand an undecorated window. So on an
    // Alt+F4 the announcement and the destroy are in flight together
    // and nothing orders them. Reading absence immediately would let
    // the winner of that race decide, which is how a healthy monitor
    // collects a strike.
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    vi.mocked(emit).mockClear()

    const destroyed = fake.destroy('output-1')
    // Synchronously after the destroy handler has started, which is
    // exactly the ordering the grace window exists for.
    fake.send({ type: 'output_closing', label: 'output-1' })
    await destroyed

    expect(manager.outputs()).toHaveLength(0)
    expect(reported('output_removed')).toEqual([
      { event_type: 'output_removed', mode: 'sos-equirect', reason: 'operator-close' },
    ])
    expect(reported('output_failure')).toEqual([])
  })

  it('does not blocklist a monitor for three late-announced closes', async () => {
    // The harm the grace window is actually for. Without it, three
    // Alt+F4 closes whose announcements lose the race read as three
    // crashes and the display refuses new outputs for the session —
    // with nothing on screen to say why, and no way back but a
    // relaunch.
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()

    for (let i = 0; i < CRASH_STORM_LIMIT; i++) {
      const record = await manager.addOutput({ monitorIndex: 0 })
      const destroyed = fake.destroy(record.label)
      fake.send({ type: 'output_closing', label: record.label })
      await destroyed
    }

    await expect(manager.addOutput({ monitorIndex: 0 })).resolves.toBeTruthy()
  })

  it('still calls a silent destroy a crash once the grace window passes', async () => {
    // The grace window must not soften the detector. Absence is still
    // the signal; it is only believed a beat later.
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.start()
    await manager.addOutput({ monitorIndex: 0 })
    vi.mocked(emit).mockClear()

    await fake.destroy('output-1')

    expect(reported('output_removed')).toEqual([
      { event_type: 'output_removed', mode: 'sos-equirect', reason: 'crash' },
    ])
    expect(reported('output_failure')).toHaveLength(1)
  })

  it('notifies a listener so an open panel can repaint', async () => {
    // Without this a crash is invisible until the panel is reopened.
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.addOutput({ monitorIndex: 0 })
    const seen = vi.fn()
    manager.onOutputsChanged(seen)

    await fake.destroy('output-1')

    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('survives a listener that throws', async () => {
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.addOutput({ monitorIndex: 0 })
    manager.onOutputsChanged(() => {
      throw new Error('panel exploded')
    })

    await expect(fake.destroy('output-1')).resolves.toBeUndefined()
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

  it('reports a projector-warp output as native, added or restored', async () => {
    // Its stored width names a 2:1 frame it does not draw, and its real
    // spanned size would fingerprint a rig — so neither goes on the wire.
    const fake = createFakeHost()
    const manager = makeManager(fake.host)
    await manager.addOutput({ monitorIndex: 0, mode: 'projector-warp', render: { framebufferWidth: 8192 } })

    const restoring = createFakeHost()
    const restorer = makeManager(restoring.host, {
      store: memoryStore({
        autoRestoreOnLaunch: true,
        outputs: [{ ...persistedOn('output-1', MONITORS[1]), mode: 'projector-warp' }],
      }),
    })
    await restorer.restoreOutputs()

    expect(reported('output_added')).toEqual([
      { event_type: 'output_added', mode: 'projector-warp', framebuffer_bucket: 'native', monitor_index: 0 },
      { event_type: 'output_added', mode: 'projector-warp', framebuffer_bucket: 'native', monitor_index: 1 },
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
          rotationOffsetDeg: 0,
          framebufferWidth: 4096,
          debugOverlay: false,
          warpId: null,
          blendGamma: DEFAULT_BLEND_GAMMA,
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
    await fake.destroy(record.label)

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
    await fake.destroy('output-1')

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

    await fake.destroy('output-1')

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
      await fake.destroy(record.label)
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
    await fake.destroy('output-1')

    const payloads = JSON.stringify(vi.mocked(emit).mock.calls)
    expect(payloads).not.toContain('DISPLAY')
    expect(payloads).not.toContain('output-1')
  })
})

/**
 * The boot scan for windows that outlived their manager
 * (`docs/MULTI_MONITOR_PLAN.md` §3 "Failure recovery", case 6).
 *
 * The case is a control window whose *page* reloaded — not a process
 * that died, which would take the outputs with it. What a test can
 * express is the state that leaves behind: `output-*` windows the
 * platform still owns, and a manager whose `records` map has never
 * heard of them.
 */
describe('adoptOrphanedOutputs', () => {
  it('costs a launch with no orphans exactly one call', async () => {
    const fake = createFakeHost()
    const monitors = vi.spyOn(fake.host, 'availableMonitors')

    const adopted = await makeManager(fake.host).adoptOrphanedOutputs()

    // Unconditional, so it has to be cheap: no monitor enumeration and
    // no IPC link on the overwhelmingly common launch, which is the
    // same property `restoreOutputs` protects.
    expect(adopted).toEqual([])
    expect(monitors).not.toHaveBeenCalled()
    expect(fake.activeListeners()).toBe(0)
    expect(fake.calls).toEqual(['existingOutputs'])
  })

  it('adopts a survivor with the settings it had, and serves it', async () => {
    const fake = createFakeHost({ existing: ['output-1'] })
    const store = memoryStore({
      outputs: [
        { ...persistedOn('output-1', MONITORS[1]), trackOperatorCamera: false, split: true },
      ],
    })

    const adopted = await makeManager(fake.host, { store }).adoptOrphanedOutputs()

    expect(adopted).toHaveLength(1)
    expect(adopted[0].label).toBe('output-1')
    expect(adopted[0].view).toEqual({ trackCamera: false, split: true, rotationOffsetDeg: 0 })
    expect(adopted[0].monitor).toEqual(MONITORS[1])
    // No window was created: the whole point is that the imagery on the
    // projector never went away.
    expect(fake.calls).not.toContain(`create:output-1:${OUTPUT_ENTRY_URL}`)
    expect(fake.closed).toEqual([])
  })

  it('serves a reattached output through the one path, config before state', async () => {
    const fake = createFakeHost({ existing: ['output-1'] })
    const store = memoryStore({ outputs: [persistedOn('output-1', MONITORS[0])] })

    await makeManager(fake.host, { store }).adoptOrphanedOutputs()

    // A reattachment is answered by the same serve path a first
    // announcement is, so the ordering that stops a restored 8K output
    // popping resolution has to hold here too.
    const order = fake.emitted
      .filter(e => e.label === 'output-1')
      .map(e => e.event)
    expect(order[0]).toBe(OUTPUT_REATTACH_EVENT)
    expect(order[1]).toBe(OUTPUT_RENDER_CONFIG_EVENT)
    expect(order[2]).toBe(OUTPUT_STATE_EVENT)
  })

  it('adopts a projector-warp survivor that says it is one', async () => {
    const fake = createFakeHost({ existing: ['output-1'], modes: { 'output-1': 'projector-warp' } })
    const store = memoryStore({ outputs: [{ ...persistedOn('output-1', MONITORS[0]), mode: 'projector-warp' }] })

    const adopted = await makeManager(fake.host, { store }).adoptOrphanedOutputs()

    expect(adopted.map(r => [r.label, r.mode])).toEqual([['output-1', 'projector-warp']])
    expect(fake.closed).toEqual([])
  })

  it('closes a survivor that booted as a different geometry from its entry, and keeps the entry', async () => {
    // The one reachable way to a mismatch: the record comes from the
    // stored config and the mode from a window that outlived the page
    // that wrote it. Driving it would put an unwarped picture on the
    // projectors; the entry is kept so the next restore spawns it again
    // from the right URL.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    // A close slow enough to outlast the reattach wait: the window did
    // answer, so it must not be reported silent and closed a second time.
    let release!: () => void
    const fake = createFakeHost({ existing: ['output-1'], closeGate: new Promise<void>(r => (release = r)) })
    const store = memoryStore({ outputs: [{ ...persistedOn('output-1', MONITORS[0]), mode: 'projector-warp' }] })
    vi.mocked(emit).mockClear()

    const manager = makeManager(fake.host, { store })
    const adopted = await manager.adoptOrphanedOutputs()
    release()
    await until(() => fake.closed.length > 0, 'the close')

    expect(adopted).toEqual([])
    expect(fake.closed).toEqual(['output-1'])
    expect(manager.outputs()).toEqual([])
    expect(fake.emitted.filter(e => e.event !== OUTPUT_REATTACH_EVENT)).toEqual([])
    expect(store.current().outputs.map(o => o.label)).toEqual(['output-1'])
    expect(reported('output_removed')).toEqual([])
    expect(reported('output_failure')).toEqual([])
    errors.mockRestore()
  })

  it('closes a window no persisted entry describes', async () => {
    const fake = createFakeHost({ existing: ['output-7'] })
    const store = memoryStore({ outputs: [] })

    const manager = makeManager(fake.host, { store })
    const adopted = await manager.adoptOrphanedOutputs()

    // There is nothing to build a truthful record from — no monitor, no
    // view, not even a mode to report a removal with. A row that
    // guessed would be the name-only monitor match in another costume.
    expect(adopted).toEqual([])
    expect(fake.closed).toEqual(['output-7'])
    expect(manager.outputs()).toEqual([])
  })

  it('closes a survivor whose monitor is no longer there', async () => {
    const gone = {
      name: 'UNPLUGGED',
      position: { x: 5000, y: 0 },
      size: { width: 1920, height: 1080 },
      scaleFactor: 1,
    }
    const fake = createFakeHost({ existing: ['output-1'] })
    const store = memoryStore({ outputs: [persistedOn('output-1', gone)] })
    vi.mocked(emit).mockClear()

    const adopted = await makeManager(fake.host, { store }).adoptOrphanedOutputs()

    expect(adopted).toEqual([])
    expect(fake.closed).toEqual(['output-1'])
    expect(reported('output_removed')).toEqual([
      { event_type: 'output_removed', mode: 'sos-equirect', reason: 'monitor-gone' },
    ])
  })

  it('closes a survivor that never answers, and says the recovery failed', async () => {
    const fake = createFakeHost({ existing: ['output-1'], answerReattach: [] })
    const store = memoryStore({ outputs: [persistedOn('output-1', MONITORS[0])] })
    vi.mocked(emit).mockClear()

    const manager = makeManager(fake.host, { store })
    const adopted = await manager.adoptOrphanedOutputs()

    // Absence is the signal here exactly as it is for a departure: a
    // window that will not answer is a window nothing can drive.
    expect(adopted).toEqual([])
    expect(manager.outputs()).toEqual([])
    expect(fake.closed).toEqual(['output-1'])
    expect(reported('output_removed')).toEqual([
      { event_type: 'output_removed', mode: 'sos-equirect', reason: 'crash' },
    ])
    expect(reported('output_failure')).toEqual([
      { event_type: 'output_failure', kind: 'ipc-silence', retries: 1, recovered: false },
    ])
  })

  it('reports a recovered output as the case-3 failure it was', async () => {
    const fake = createFakeHost({ existing: ['output-1'] })
    const store = memoryStore({ outputs: [persistedOn('output-1', MONITORS[0])] })
    vi.mocked(emit).mockClear()

    await makeManager(fake.host, { store }).adoptOrphanedOutputs()

    // No `output_added`: no window was created, and counting a reload
    // as new outputs would inflate the metric every time a dev saves a
    // file. The failure it *did* experience is its control window going
    // quiet — which is case 3's name for it, deliberately.
    expect(reported('output_added')).toEqual([])
    expect(reported('output_failure')).toEqual([
      { event_type: 'output_failure', kind: 'ipc-silence', retries: 1, recovered: true },
    ])
  })

  it('leaves nothing for the restore to respawn', async () => {
    const fake = createFakeHost({ existing: ['output-1'] })
    const store = memoryStore({
      autoRestoreOnLaunch: true,
      outputs: [persistedOn('output-1', MONITORS[0])],
    })

    const manager = makeManager(fake.host, { store })
    await manager.adoptOrphanedOutputs()
    const restored = await manager.restoreOutputs()

    // The ordering rule the boot wiring depends on. Without the skip,
    // this asks Tauri for a second window under a label that already
    // exists, on a monitor that already has one.
    expect(restored).toEqual([])
    expect(fake.calls).not.toContain(`create:output-1:${OUTPUT_ENTRY_URL}`)
    expect(manager.outputs().map(r => r.label)).toEqual(['output-1'])
  })

  it('advances the label counter past what it adopted', async () => {
    const fake = createFakeHost({ existing: ['output-3'] })
    const store = memoryStore({ outputs: [persistedOn('output-3', MONITORS[0])] })

    const manager = makeManager(fake.host, { store })
    await manager.adoptOrphanedOutputs()
    const added = await manager.addOutput({ monitorIndex: 1 })

    // A fresh manager's counter starts at 1, so without this the
    // operator's next Add mints `output-1`… and then `output-3` again.
    expect(added.label).toBe('output-4')
  })

  it('leaves a configured output that was not on screen alone', async () => {
    // The scan adopts what it finds; it must not rewrite the config
    // with only that. `output-2` was configured and is simply not
    // running — the chained `restoreOutputs()` is what brings it back,
    // and it can only do that if the entry is still there to read.
    const fake = createFakeHost({ existing: ['output-1'] })
    const store = memoryStore({
      autoRestoreOnLaunch: true,
      outputs: [persistedOn('output-1', MONITORS[0]), persistedOn('output-2', MONITORS[1])],
    })

    const manager = makeManager(fake.host, { store })
    await manager.adoptOrphanedOutputs()

    expect(store.current().outputs.map(o => o.label)).toEqual(['output-1', 'output-2'])

    // And the restore then actually does bring it back.
    const restored = await manager.restoreOutputs()
    expect(restored.map(r => r.label)).toEqual(['output-2'])
  })

  it('keeps an unanswering output configured, the way a crash is kept', async () => {
    // `commitDeparture` persists a hand-close and deliberately does not
    // persist a crash: the operator still wants that output, something
    // took it away. A reattach timeout is the same case, and dropping
    // it would make a transient IPC outage permanent.
    const fake = createFakeHost({ existing: ['output-1'], answerReattach: [] })
    const store = memoryStore({ outputs: [persistedOn('output-1', MONITORS[0])] })

    await makeManager(fake.host, { store }).adoptOrphanedOutputs()

    expect(fake.closed).toEqual(['output-1'])
    expect(store.current().outputs.map(o => o.label)).toEqual(['output-1'])
  })

  it('reserves the label of a window it could not close', async () => {
    // A `close()` that rejects leaves the window — and its label — on
    // screen. Minting that label again asks Tauri for a duplicate.
    const fake = createFakeHost({ existing: ['output-2'], failClose: true })
    const store = memoryStore({ outputs: [] })

    const manager = makeManager(fake.host, { store })
    await manager.adoptOrphanedOutputs()
    const added = await manager.addOutput({ monitorIndex: 0 })

    expect(added.label).toBe('output-3')
  })

  it('survives a host that will not enumerate its windows', async () => {
    const fake = createFakeHost()
    vi.spyOn(fake.host, 'existingOutputs').mockRejectedValue(new Error('nope'))

    // Costs the scan and nothing else — the restore behind it still has
    // to run, so this must not reject.
    await expect(makeManager(fake.host).adoptOrphanedOutputs()).resolves.toEqual([])
  })
})

describe('warp sets (rung 16)', () => {
  /** The smallest mesh the parser accepts: 2×2, 16:9, every node drawn. */
  const MESH = ['2', '2 2', '-1.777778 1 0.25 0.75 1', '1.777778 1 0.75 0.75 1', '-1.777778 -1 0.25 0.25 1', '1.777778 -1 0.75 0.25 1', ''].join('\n')
  const OTHER = MESH.replace('0.25 0.75', '0.3 0.75')

  function sources(files: Record<string, string>): readonly WarpSource[] {
    const read = readWarpSources(Object.entries(files).map(([name, text]) => ({ name, bytes: new TextEncoder().encode(text) })))
    if (!read.ok) throw new Error(read.refusal.code)
    return read.sources
  }

  async function warpOutput(options: { warpStore?: WarpSetStore; store?: ReturnType<typeof memoryStore> } = {}) {
    const fake = createFakeHost()
    const storage = memoryWarpStorage()
    const warpStore = options.warpStore ?? createWarpSetStore(storage)
    const store = options.store ?? memoryStore()
    const manager = makeManager(fake.host, { warpStore, store })
    await manager.start()
    await manager.addOutput({ monitorIndex: 0, mode: 'projector-warp' })
    fake.send(ready('output-1', 'projector-warp'))
    fake.emitted.length = 0
    return { fake, manager, storage, warpStore, store }
  }

  it('stores the set, names it in the config, and sends it to the output', async () => {
    const { fake, manager, storage, store } = await warpOutput()

    const result = await manager.importWarpSet('output-1', sources({ 'P1.data': MESH, 'P2.data': MESH }), 'sos-quadrants')

    if (!result.ok) throw new Error(JSON.stringify(result.refusal))
    expect(result.meshes).toBe(2)
    expect([...storage.map.keys()]).toEqual([`sos-multi-output-warp:${result.id}`])
    expect(store.current().outputs[0].warpId).toBe(result.id)
    const sent = configEmits(fake.emitted)[0].config
    expect(sent.warp?.id).toBe(result.id)
    expect(sent.warp?.meshes.map(m => [m.id, m.viewport])).toEqual([
      ['P1', { x: 0, y: 0, w: 0.5, h: 0.5 }],
      ['P2', { x: 0.5, y: 0, w: 0.5, h: 0.5 }],
    ])
    // The file names stay behind: the output has no use for them.
    expect(sent.warp?.meshes[0]).not.toHaveProperty('sourceName')
    // Nothing picked said what the meshes address.
    expect(sent.warp?.texture).toBeNull()
  })

  it("places by a bundle's own layout, and carries what it says the meshes address", async () => {
    const { fake, manager, warpStore } = await warpOutput()
    const layout = {
      framebuffer: { width: 3840, height: 1080 },
      texture: { surface: 'sphere', rotationOffsetDeg: 37 } as const,
      projectors: [
        { id: 'P1', viewport: { x: 0, y: 0, w: 0.5, h: 1 } },
        { id: 'P2', viewport: { x: 0.5, y: 0, w: 0.5, h: 1 } },
      ],
    }

    const result = await manager.importWarpSet('output-1', sources({ 'P1.data': MESH, 'P2.data': MESH }), layout)

    if (!result.ok) throw new Error(JSON.stringify(result.refusal))
    const sent = configEmits(fake.emitted)[0].config
    expect(sent.warp?.meshes.map(m => m.viewport)).toEqual(layout.projectors.map(p => p.viewport))
    expect(sent.warp?.texture).toEqual({ surface: 'sphere', rotationOffsetDeg: 37 })
    const stored = warpStore.read(result.id)
    expect(stored.ok && [stored.set.layoutFrom, stored.set.texture]).toEqual(['bundle', layout.texture])
  })

  /** SOS's P3 quadrant as a bundle's layout states it, rotation stated. */
  const P3_LAYOUT = {
    framebuffer: { width: 7680, height: 4320 },
    texture: { surface: 'sphere', rotationOffsetDeg: 0 } as const,
    projectors: [{ id: 'P3', viewport: { x: 0, y: 0.5, w: 0.5, h: 0.5 } }],
  }

  it('tells every output drawing a set what a later import says about its texture', async () => {
    // The id leaves the texture out, so the same meshes imported without
    // their layout.json and then with it are one set. Both rows name it,
    // so both must state the same rotation.
    const { fake, manager } = await warpOutput()
    await manager.addOutput({ monitorIndex: 1, mode: 'projector-warp' })
    fake.send(ready('output-2', 'projector-warp'))
    const loose = await manager.importWarpSet('output-1', sources({ 'P3.data': MESH }), 'sos-quadrants')
    fake.emitted.length = 0

    const bundled = await manager.importWarpSet('output-2', sources({ 'P3.data': MESH }), P3_LAYOUT)

    expect(bundled.ok && bundled.id).toBe(loose.ok && loose.id)
    expect(manager.outputs().map(o => [o.label, o.render.warp?.texture])).toEqual([
      ['output-1', P3_LAYOUT.texture],
      ['output-2', P3_LAYOUT.texture],
    ])
    expect(configEmits(fake.emitted).map(e => [e.label, e.config.warp?.texture])).toEqual([
      ['output-1', P3_LAYOUT.texture],
      ['output-2', P3_LAYOUT.texture],
    ])
  })

  it('keeps what a bundle said about a set when the same meshes arrive without it', async () => {
    const { manager, warpStore } = await warpOutput()
    const bundled = await manager.importWarpSet('output-1', sources({ 'P3.data': MESH }), P3_LAYOUT)
    await manager.addOutput({ monitorIndex: 1, mode: 'projector-warp' })

    const loose = await manager.importWarpSet('output-2', sources({ 'P3.data': MESH }), 'sos-quadrants')

    expect(loose.ok && loose.id).toBe(bundled.ok && bundled.id)
    expect(manager.outputs().map(o => o.render.warp?.texture)).toEqual([P3_LAYOUT.texture, P3_LAYOUT.texture])
    const stored = warpStore.read(loose.ok ? loose.id : '')
    expect(stored.ok && [stored.set.layoutFrom, stored.set.texture]).toEqual(['bundle', P3_LAYOUT.texture])
  })

  it('refuses, changing nothing, for an output that is not a warp output or does not exist', async () => {
    const fake = createFakeHost()
    const store = memoryStore()
    const manager = makeManager(fake.host, { store })
    await manager.addOutput({ monitorIndex: 0 })

    const set = sources({ 'P1.data': MESH })
    expect(await manager.importWarpSet('output-1', set, 'sos-quadrants')).toEqual({
      ok: false,
      refusal: { code: 'not-a-warp-output' },
    })
    expect(await manager.importWarpSet('output-9', set, 'sos-quadrants')).toEqual({
      ok: false,
      refusal: { code: 'no-output' },
    })
    expect(store.current().outputs[0].warpId).toBeNull()
  })

  it('passes a layout refusal through, and keeps the set the output had', async () => {
    const { manager, store } = await warpOutput()
    const first = await manager.importWarpSet('output-1', sources({ 'P1.data': MESH }), 'sos-quadrants')

    const second = await manager.importWarpSet('output-1', sources({ 'Projector 1.data': MESH }), 'sos-quadrants')

    expect(second).toEqual({ ok: false, refusal: { code: 'layout', reason: 'unplaceable', ids: ['Projector 1'] } })
    expect(store.current().outputs[0].warpId).toBe(first.ok && first.id)
  })

  it('refuses a set storage will not take, whole, and keeps the one the output had', async () => {
    const storage = memoryWarpStorage()
    let full = false
    const warpStore = createWarpSetStore({
      ...storage,
      get length() {
        return storage.length
      },
      setItem: (key, value) => {
        if (full) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' })
        storage.setItem(key, value)
      },
    })
    const { fake, manager, store } = await warpOutput({ warpStore })
    const first = await manager.importWarpSet('output-1', sources({ 'P1.data': MESH }), 'sos-quadrants')
    fake.emitted.length = 0
    full = true

    const second = await manager.importWarpSet('output-1', sources({ 'P1.data': OTHER }), 'sos-quadrants')

    expect(second).toEqual({ ok: false, refusal: { code: 'storage', reason: 'no-room' } })
    expect(store.current().outputs[0].warpId).toBe(first.ok && first.id)
    expect(configEmits(fake.emitted)).toEqual([])
  })

  it('deletes the set it replaces, unless another output still names it', async () => {
    const { fake, manager, warpStore } = await warpOutput()
    await manager.addOutput({ monitorIndex: 1, mode: 'projector-warp' })
    fake.send(ready('output-2', 'projector-warp'))
    const shared = sources({ 'P1.data': MESH })
    const a = await manager.importWarpSet('output-1', shared, 'sos-quadrants')
    await manager.importWarpSet('output-2', shared, 'sos-quadrants')

    // output-2 still names it, so replacing output-1's keeps it.
    const b = await manager.importWarpSet('output-1', sources({ 'P1.data': OTHER }), 'sos-quadrants')
    expect(warpStore.list().sort()).toEqual([a.ok && a.id, b.ok && b.id].sort())

    // Now nothing does.
    await manager.clearOutputWarp('output-2')
    expect(warpStore.list()).toEqual([b.ok && b.id])
  })

  it('clears to nothing: no reference, no stored set, and the output told', async () => {
    const { fake, manager, warpStore, store } = await warpOutput()
    await manager.importWarpSet('output-1', sources({ 'P1.data': MESH }), 'sos-quadrants')
    fake.emitted.length = 0

    await manager.clearOutputWarp('output-1')

    expect(store.current().outputs[0].warpId).toBeNull()
    expect(warpStore.list()).toEqual([])
    expect(configEmits(fake.emitted)[0].config.warp).toBeNull()
  })

  it('lets a set go with a deliberate removal, and keeps it through a crash', async () => {
    const removed = await warpOutput()
    await removed.manager.importWarpSet('output-1', sources({ 'P1.data': MESH }), 'sos-quadrants')
    await removed.manager.removeOutput('output-1')
    expect(removed.warpStore.list()).toEqual([])

    // A crash is the display taking the output away, not the operator
    // letting go of it: the calibration stays for the next launch.
    const crashed = await warpOutput()
    await crashed.manager.importWarpSet('output-1', sources({ 'P1.data': MESH }), 'sos-quadrants')
    await crashed.fake.destroy('output-1')
    expect(crashed.manager.outputs()).toEqual([])
    expect(crashed.warpStore.list()).toHaveLength(1)
  })

  it('restores an output with its set loaded, re-read through the same check', async () => {
    const storage = memoryWarpStorage()
    const warpStore = createWarpSetStore(storage)
    const set = sources({ 'P3.data': MESH })
    const id = warpSetId([{ id: 'P3', viewport: { x: 0, y: 0.5, w: 0.5, h: 0.5 }, text: MESH }])
    warpStore.write(id, { layoutFrom: 'sos-quadrants', texture: null, meshes: [{ id: 'P3', viewport: { x: 0, y: 0.5, w: 0.5, h: 0.5 }, text: set[0].text, sourceName: 'P3.data' }] }, 'x')
    const fake = createFakeHost()
    const manager = makeManager(fake.host, {
      warpStore,
      store: memoryStore({
        autoRestoreOnLaunch: true,
        outputs: [{ ...persistedOn('output-1', MONITORS[0]), mode: 'projector-warp', warpId: id }],
      }),
    })

    await manager.restoreOutputs()
    fake.send(ready('output-1', 'projector-warp'))

    const sent = configEmits(fake.emitted)[0].config
    expect(sent.warp?.id).toBe(id)
    expect(sent.warp?.meshes[0].viewport).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 })
    expect(sent.warp?.texture).toBeNull()
  })

  it('restores what a stored set says its meshes address, so the panel can say it again', async () => {
    const warpStore = createWarpSetStore(memoryWarpStorage())
    const viewport = { x: 0, y: 0, w: 1, h: 1 }
    const id = warpSetId([{ id: 'P1', viewport, text: MESH }])
    const texture = { surface: 'mesh', rotationOffsetDeg: null } as const
    warpStore.write(id, { layoutFrom: 'bundle', texture, meshes: [{ id: 'P1', viewport, text: MESH, sourceName: 'P1.data' }] }, 'x')
    const fake = createFakeHost()
    const manager = makeManager(fake.host, {
      warpStore,
      store: memoryStore({
        autoRestoreOnLaunch: true,
        outputs: [{ ...persistedOn('output-1', MONITORS[0]), mode: 'projector-warp', warpId: id }],
      }),
    })

    const [restored] = await manager.restoreOutputs()

    expect(restored.render.warp?.texture).toEqual(texture)
  })

  it('restores an output whose set cannot be read as drawing nothing — and keeps the reference', async () => {
    // A set a later build refuses is still the operator's calibration.
    // Dropping the reference would let the next save stop naming it, and
    // a deliberate removal would then delete it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const missing = 'feedfacecafebeef'
    const fake = createFakeHost()
    const store = memoryStore({
      autoRestoreOnLaunch: true,
      outputs: [{ ...persistedOn('output-1', MONITORS[0]), mode: 'projector-warp', warpId: missing }],
    })
    const manager = makeManager(fake.host, { store })

    await manager.restoreOutputs()
    fake.send(ready('output-1', 'projector-warp'))

    expect(configEmits(fake.emitted)[0].config.warp).toBeNull()
    expect(store.current().outputs[0].warpId).toBe(missing)
    warn.mockRestore()
  })

  it('costs a damaged set the one output using it, and restores its neighbour untouched', async () => {
    // Appendix B's W9(b) with no sphere: one key per set is what makes
    // this true, since no restore ever reads two sets in one parse.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storage = memoryWarpStorage()
    const warpStore = createWarpSetStore(storage)
    const P3 = { x: 0, y: 0.5, w: 0.5, h: 0.5 }
    const good = warpSetId([{ id: 'P3', viewport: P3, text: MESH }])
    const damaged = warpSetId([{ id: 'P3', viewport: P3, text: OTHER }])
    warpStore.write(good, { layoutFrom: 'sos-quadrants', texture: null, meshes: [{ id: 'P3', viewport: P3, text: MESH, sourceName: 'P3.data' }] }, 'x')
    warpStore.write(damaged, { layoutFrom: 'sos-quadrants', texture: null, meshes: [{ id: 'P3', viewport: P3, text: OTHER, sourceName: 'P3.data' }] }, 'x')
    // One byte changed after the write, the way a hand edit or a bad
    // sector would: still JSON, still a plausible mesh, a different set.
    const key = `${WARP_SET_KEY_PREFIX}${damaged}`
    storage.map.set(key, storage.map.get(key)!.replace('0.3 0.75', '0.4 0.75'))
    const fake = createFakeHost()
    const store = memoryStore({
      autoRestoreOnLaunch: true,
      outputs: [
        { ...persistedOn('output-1', MONITORS[0]), mode: 'projector-warp', warpId: damaged },
        { ...persistedOn('output-2', MONITORS[1]), mode: 'projector-warp', warpId: good },
      ],
    })
    const manager = makeManager(fake.host, { warpStore, store })

    await manager.restoreOutputs()
    fake.send(ready('output-1', 'projector-warp'))
    fake.send(ready('output-2', 'projector-warp'))

    const sent = new Map(configEmits(fake.emitted).map(e => [e.label, e.config]))
    expect(sent.get('output-1')?.warp).toBeNull()
    expect(sent.get('output-2')?.warp?.id).toBe(good)
    // Both still configured, both still naming their sets: the damaged
    // one is the operator's to re-import, never the restore's to forget.
    expect(store.current().outputs.map(o => [o.label, o.warpId])).toEqual([
      ['output-1', damaged],
      ['output-2', good],
    ])
    expect(warn.mock.calls.some(call => String(call[0]).includes('altered'))).toBe(true)
    warn.mockRestore()
  })

  it('refuses an oversized pick by its size, without reading a byte of it', async () => {
    const { manager } = await warpOutput()
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0))

    const read = await manager.readWarpFiles([{ name: 'huge.zip', size: 64 * 1024 * 1024, arrayBuffer }])

    expect(read).toMatchObject({ ok: false, refusal: { code: 'too-large' } })
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it('reads picked files into sources', async () => {
    const { manager } = await warpOutput()
    const bytes = new TextEncoder().encode(MESH)

    const read = await manager.readWarpFiles([
      { name: 'P2.data', size: bytes.length, arrayBuffer: async () => bytes.slice().buffer },
    ])

    expect(read.ok && read.sources.map(s => s.id)).toEqual(['P2'])
  })
})
