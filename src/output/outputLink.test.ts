// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the output's side of the link.
 *
 * Three properties decide whether an installation works, and each fails
 * quietly rather than loudly if it breaks: a stale diff must not win
 * over a fresh one, an idle heartbeat must not read as a dataset
 * change, and the listener must be installed before the window
 * announces itself.
 */

import { describe, it, expect, vi } from 'vitest'

import {
  PICTURE_KEYS,
  PLAYHEAD_KEYS,
  connectOutputLink,
  STATE_KEYS,
  changesPicture,
  createOutputStateStore,
  isRenderConfig,
  isStateMessage,
  outputInitialState,
  type OutputLinkHost,
  type StateKey,
} from './outputLink'
import { DEFAULT_OUTPUT_MODE, IPC_ORPHAN_MS, IPC_STALE_MS } from '../services/multiOutput/protocol'
import { IDENTITY_ORIENTATION, IDENTITY_PARAMS } from './equirectRtt'
import {
  OUTPUT_EVENT,
  OUTPUT_REATTACH_EVENT,
  OUTPUT_RENDER_CONFIG_EVENT,
  OUTPUT_STATE_EVENT,
  defaultRenderConfig,
  type MirroredDataset,
  type OutputGlobeState,
  type OutputRenderConfig,
  type OutputStateMessage,
  type OutputWarpSet,
} from '../services/multiOutput/protocol'
import { until } from '../test-utils'

function dataset(id: string): MirroredDataset {
  return {
    id,
    url: `https://cdn.example/${id}.m3u8`,
    kind: 'video',
    overlay: { datasetId: id, datasetTitle: id },
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: '2026-01-08T00:00:00.000Z',
  }
}

function full(seq: number, over: Partial<OutputGlobeState> = {}): OutputStateMessage {
  return { seq, full: true, state: { ...outputInitialState(), ...over } }
}

function diff(seq: number, state: Partial<OutputGlobeState>): OutputStateMessage {
  return { seq, full: false, state }
}

/** A whole config, as the manager always sends one, with fields replaced by `over`. */
function config(over: Partial<OutputRenderConfig> = {}): OutputRenderConfig {
  return { ...defaultRenderConfig(), ...over }
}

/** `config()` with one field gone — the shape an older or foreign sender would put on the wire. */
function configWithout(key: keyof OutputRenderConfig): Record<string, unknown> {
  const c: Record<string, unknown> = { ...config() }
  delete c[key]
  return c
}

/** A set as the manager sends one. The text is opaque here: the scene parses it, not the link. */
const WARP: OutputWarpSet = {
  id: '0123456789abcdef',
  texture: { surface: 'sphere', rotationOffsetDeg: 0 },
  meshes: [{ id: 'P1', viewport: { x: 0, y: 0, w: 0.5, h: 0.5 }, text: '2\n2 2\n' }],
}

describe('the store: which messages win', () => {
  it('applies a newer diff', () => {
    const store = createOutputStateStore()
    const r = store.accept(diff(1, { simulationDate: '2026-03-01T00:00:00.000Z' }))

    expect(r.applied).toBe(true)
    expect(r.changed).toEqual(['simulationDate'])
    expect(store.state().simulationDate).toBe('2026-03-01T00:00:00.000Z')
  })

  it('drops a diff that is not newer, so a late delivery cannot win', () => {
    const store = createOutputStateStore()
    store.accept(diff(5, { dataset: dataset('FRESH') }))

    // The exact failure `seq` exists for: a diff queued earlier and
    // delivered later would otherwise show the previous dataset with
    // nothing on screen to say the output is behind.
    const r = store.accept(diff(4, { dataset: dataset('STALE') }))

    expect(r.applied).toBe(false)
    expect(r.changed).toEqual([])
    expect(store.state().dataset?.id).toBe('FRESH')
  })

  it('drops a diff at the same seq', () => {
    const store = createOutputStateStore()
    store.accept(diff(5, { dataset: dataset('FIRST') }))
    expect(store.accept(diff(5, { dataset: dataset('SECOND') })).applied).toBe(false)
    expect(store.state().dataset?.id).toBe('FIRST')
  })

  it('applies a snapshot at the seq it already holds — the heartbeat resync', () => {
    const store = createOutputStateStore()
    store.accept(diff(7, { simulationDate: '2026-03-01T00:00:00.000Z' }))

    // `full()` does not advance `seq`, so the resync arrives at the
    // number already held. Gating snapshots on `seq` would drop it and
    // an output that missed a diff would stay wrong indefinitely.
    const r = store.accept(full(7, { dataset: dataset('MISSED') }))

    expect(r.applied).toBe(true)
    expect(store.state().dataset?.id).toBe('MISSED')
  })

  it('applies a snapshot at a lower seq — the manager restarted', () => {
    const store = createOutputStateStore()
    store.accept(diff(120, { dataset: dataset('OLD') }))

    // `seq` resets on manager restart, and a full always accompanies
    // it. Refusing it would strand the output for the whole session.
    const r = store.accept(full(0, { dataset: dataset('AFTER_RESTART') }))

    expect(r.applied).toBe(true)
    expect(store.state().dataset?.id).toBe('AFTER_RESTART')
    expect(store.seq()).toBe(0)
  })
})

describe('the store: what counts as a change', () => {
  it('reports nothing for a heartbeat snapshot that changed nothing', () => {
    const store = createOutputStateStore()
    store.accept(full(3, { dataset: dataset('SST') }))

    // The manager sends a full every second while idle. Reporting every
    // key here is what would rebuild the HLS instance once a second.
    const r = store.accept(full(3, { dataset: dataset('SST') }))

    expect(r.applied).toBe(true)
    expect(r.changed).toEqual([])
  })

  it('keeps a snapshot folded before anyone subscribed, and never re-announces it', () => {
    // Why `output/main.ts` applies `link.state()` once after
    // subscribing. `connectOutputLink` installs its IPC listener
    // before emitting `output_ready`, so the manager's first snapshot
    // can be folded while it is still awaiting that emit — with the
    // consumer's listener not yet registered. Nothing replays it: the
    // idle heartbeat sends a *full* snapshot every second, but the
    // store compares against what it holds, so the repeat reports
    // nothing. The state is not lost; it is simply never announced,
    // and an output would sit on the idle Earth with a dataset already
    // up on the control window.
    const store = createOutputStateStore()

    const first = store.accept(full(1, { dataset: dataset('SST') }))
    expect(first.changed).toContain('dataset')
    // Retained — which is what makes reading it after subscribing a
    // fix rather than a guess.
    expect(store.state().dataset?.id).toBe('SST')

    // A second later, the heartbeat. Identical, so silent.
    expect(store.accept(full(1, { dataset: dataset('SST') })).changed).toEqual([])
  })

  it('reports only the keys that differ inside a snapshot', () => {
    const store = createOutputStateStore()
    store.accept(full(3, { dataset: dataset('SST') }))

    const r = store.accept(
      full(3, { dataset: dataset('SST'), simulationDate: '2026-04-01T00:00:00.000Z' }),
    )

    expect(r.changed).toEqual(['simulationDate'])
  })

  it('treats an absent key in a diff as unchanged, not as cleared', () => {
    const store = createOutputStateStore()
    store.accept(diff(1, { dataset: dataset('SST') }))
    store.accept(diff(2, { simulationDate: '2026-04-01T00:00:00.000Z' }))

    expect(store.state().dataset?.id).toBe('SST')
  })

  it('applies an explicit null, which is how a dataset is unloaded', () => {
    const store = createOutputStateStore()
    store.accept(diff(1, { dataset: dataset('SST') }))

    const r = store.accept(diff(2, { dataset: null }))

    expect(r.changed).toEqual(['dataset'])
    expect(store.state().dataset).toBeNull()
  })

  it('sees a reordered layer stack as a change', () => {
    // Array order *is* z-order on this path — there is no depth buffer
    // to disagree with it — so a reorder has to reach the renderer.
    const store = createOutputStateStore()
    const a = { id: 'a', datasetId: 'a', url: 'u/a', kind: 'image' as const, overlay: { datasetId: 'a' } }
    const b = { id: 'b', datasetId: 'b', url: 'u/b', kind: 'image' as const, overlay: { datasetId: 'b' } }
    store.accept(diff(1, { layers: [a, b] }))

    expect(store.accept(diff(2, { layers: [b, a] })).changed).toEqual(['layers'])
  })
})

describe('the store: the mode check', () => {
  it('drops a view belonging to another geometry but keeps the rest', () => {
    const store = createOutputStateStore()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const held = store.state().view

    const r = store.accept(
      diff(1, {
        // Only reachable through a manager/window disagreement, which
        // is exactly the fault the discriminant makes detectable.
        view: { mode: 'flat-perspective', dayNight: false, params: IDENTITY_PARAMS } as never,
        simulationDate: '2026-05-01T00:00:00.000Z',
      }),
    )

    expect(r.changed).toEqual(['simulationDate'])
    expect(store.state().view).toBe(held)
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })

  it('tells the two real geometries apart, whichever this window is', () => {
    // Both arms carry the same parameters, so only the discriminant can
    // say a view was meant for a window of the other kind.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const params = { cameraOffset: { x: 0.25, y: 0, z: 0 }, orientation: IDENTITY_ORIENTATION, split: false, rotationOffsetRad: 0 }
    const warpWindow = createOutputStateStore('projector-warp')
    expect(warpWindow.state().view.mode).toBe('projector-warp')
    expect(warpWindow.accept(diff(1, { view: { mode: 'sos-equirect', dayNight: true, params } })).changed).toEqual([])
    expect(warpWindow.accept(diff(2, { view: { mode: 'projector-warp', dayNight: true, params } })).changed).toEqual([
      'view',
    ])
    const equirectWindow = createOutputStateStore('sos-equirect')
    expect(
      equirectWindow.accept(diff(1, { view: { mode: 'projector-warp', dayNight: true, params } })).changed,
    ).toEqual([])
    expect(errors).toHaveBeenCalledTimes(2)
    errors.mockRestore()
  })

  it('applies a view for its own geometry', () => {
    const store = createOutputStateStore()
    const view = {
      mode: DEFAULT_OUTPUT_MODE,
      dayNight: false,
      params: { cameraOffset: { x: 0.5, y: 0, z: 0 }, orientation: IDENTITY_ORIENTATION, split: true, rotationOffsetRad: 0 },
    }

    expect(store.accept(diff(1, { view })).changed).toEqual(['view'])
    expect(store.state().view.params.split).toBe(true)
  })
})

describe('the initial state', () => {
  it('starts on the centred, unsplit projection with day/night on', () => {
    const s = outputInitialState()
    expect(s.view.dayNight).toBe(true)
    expect(s.view.params).toEqual(IDENTITY_PARAMS)
    expect(s.dataset).toBeNull()
    expect(s.layers).toEqual([])
  })

  it('does not alias the shader’s own constant', () => {
    // `IDENTITY_PARAMS` is module-scoped. Aliasing it would let a later
    // in-place write edit the identity projection for everything.
    const s = outputInitialState()
    expect(s.view.params.cameraOffset).not.toBe(IDENTITY_PARAMS.cameraOffset)
    expect(outputInitialState().view.params.cameraOffset).not.toBe(s.view.params.cameraOffset)
  })
})

describe('isStateMessage', () => {
  it('accepts a well-formed message', () => {
    expect(isStateMessage(full(1))).toBe(true)
    expect(isStateMessage(diff(2, { simulationDate: null }))).toBe(true)
  })

  it.each([
    ['null', null],
    ['a string', 'output_state'],
    ['a missing seq', { full: true, state: {} }],
    ['a non-finite seq', { seq: Number.NaN, full: true, state: {} }],
    ['a missing full flag', { seq: 1, state: {} }],
    ['a null state', { seq: 1, full: true, state: null }],
  ])('rejects %s', (_label, payload) => {
    // The output's capability grants a broad listen. A malformed
    // payload must cost one dropped message, not an exception thrown
    // out of the IPC callback in a window nobody is watching.
    expect(isStateMessage(payload)).toBe(false)
  })
})

function fakeHost(): OutputLinkHost & {
  emit: ReturnType<typeof vi.fn>
  deliver: (payload: unknown) => void
  deliverConfig: (payload: unknown) => void
  deliverReattach: () => void
  listenedBefore: () => boolean
  /** Move the link's clock. Case 3's thresholds are 5 s and 60 s, so
   *  a real clock would mean a minute-long test that fails on a
   *  loaded runner. */
  advance: (ms: number) => void
} {
  // Keyed by event: the link listens on two channels now, and a fake
  // that kept one handler would silently route state to the config
  // listener — which is exactly the bug the two channels exist to make
  // impossible, hidden inside the test harness.
  const handlers = new Map<string, (payload: unknown) => void>()
  let emitted = false
  // Any listen at all after the emit, not just the last one: the
  // question is whether *every* channel was live before the manager was
  // told to start talking, and a flag overwritten per call answers a
  // weaker one.
  let listenedLate = false
  const emit = vi.fn(async () => {
    emitted = true
  })
  let clock = 0
  return {
    label: 'output-3',
    nowMs: () => clock,
    advance: (ms: number) => {
      clock += ms
    },
    monitorName: async () => '\\\\.\\DISPLAY2',
    listen: async (event, h) => {
      handlers.set(event, h)
      if (emitted) listenedLate = true
      return () => {
        handlers.delete(event)
      }
    },
    emit,
    deliver: payload => handlers.get(OUTPUT_STATE_EVENT)?.(payload),
    deliverConfig: payload => handlers.get(OUTPUT_RENDER_CONFIG_EVENT)?.(payload),
    deliverReattach: () => handlers.get(OUTPUT_REATTACH_EVENT)?.({}),
    listenedBefore: () => handlers.size > 0 && !listenedLate,
  }
}

describe('connectOutputLink', () => {
  it('installs every listener before announcing the window', async () => {
    const host = fakeHost()
    const listen = vi.spyOn(host, 'listen')

    await connectOutputLink(host)

    // The manager replies to `output_ready` with this window's render
    // config and the first full snapshot immediately. Announcing first
    // races the listeners against that reply: the output would sit on
    // the idle Earth until the next heartbeat a second later, and would
    // lose its resolution until the operator next changed it.
    expect(host.listenedBefore()).toBe(true)
    expect(listen.mock.calls.map(c => c[0]).sort()).toEqual(
      [OUTPUT_REATTACH_EVENT, OUTPUT_RENDER_CONFIG_EVENT, OUTPUT_STATE_EVENT].sort(),
    )
  })

  it('re-announces when the manager pokes it', async () => {
    // Case 6: a control window whose page reloaded finds this window
    // still alive and asks who it is. The reply is an ordinary
    // `output_ready`, so the manager's one serve path does the rest —
    // config, then the first snapshot, exactly as at boot.
    const host = fakeHost()
    await connectOutputLink(host)
    host.emit.mockClear()

    host.deliverReattach()
    await until(() => host.emit.mock.calls.length > 0, 'the re-announcement')

    const [event, payload] = host.emit.mock.calls[0]
    expect(event).toBe(OUTPUT_EVENT)
    expect(payload).toMatchObject({ type: 'output_ready', label: 'output-3' })
  })

  it('takes an orphaned link back to live on the poke alone', async () => {
    // The reason the poke exists at all. Past `IPC_ORPHAN_MS` the
    // output has stopped pinging by design, so nothing it does can
    // recover the link — this event is the only thing that can, and
    // recording contact is what makes it work rather than the
    // re-announcement, which the manager may never even answer.
    const host = fakeHost()
    const link = await connectOutputLink(host)
    host.advance(IPC_ORPHAN_MS + 1)
    expect(link.checkHealth()).toBe('orphaned')

    host.deliverReattach()

    expect(link.checkHealth()).toBe('live')
  })

  it('announces itself with its label, monitor and mode', async () => {
    const host = fakeHost()

    await connectOutputLink(host)

    expect(host.emit).toHaveBeenCalledWith(OUTPUT_EVENT, {
      type: 'output_ready',
      label: 'output-3',
      monitorName: '\\\\.\\DISPLAY2',
      mode: DEFAULT_OUTPUT_MODE,
    })
  })

  it('announces the mode it was given, never one it read off the wire', async () => {
    const host = fakeHost()

    await connectOutputLink(host, 'projector-warp')

    expect(host.emit).toHaveBeenCalledWith(OUTPUT_EVENT, expect.objectContaining({ type: 'output_ready', mode: 'projector-warp' }))
  })

  it('listens on the channel the manager targets', async () => {
    const host = fakeHost()
    const listen = vi.spyOn(host, 'listen')

    await connectOutputLink(host)

    expect(listen).toHaveBeenCalledWith(OUTPUT_STATE_EVENT, expect.any(Function))
  })

  it('notifies with the keys that changed', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const seen = vi.fn()
    link.onChange(seen)

    host.deliver(diff(1, { dataset: dataset('SST') }))

    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen.mock.calls[0][0]).toEqual(['dataset'])
    expect(link.state().dataset?.id).toBe('SST')
  })

  it('stays silent on a heartbeat that changed nothing', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const seen = vi.fn()
    link.onChange(seen)
    host.deliver(full(1, { dataset: dataset('SST') }))
    seen.mockClear()

    host.deliver(full(1, { dataset: dataset('SST') }))

    // A positive anchor first would be circular here, so instead: the
    // message *was* applied (seq advanced past the initial -1 already,
    // and state still holds the dataset), it simply was not news.
    expect(link.state().dataset?.id).toBe('SST')
    expect(seen).not.toHaveBeenCalled()
  })

  it('drops a payload that is not a state message', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const seen = vi.fn()
    link.onChange(seen)

    host.deliver({ nonsense: true })

    expect(seen).not.toHaveBeenCalled()
    // Still live afterwards — a bad payload costs one message.
    host.deliver(diff(1, { dataset: dataset('SST') }))
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('isolates a listener that throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const good = vi.fn()
    link.onChange(() => {
      throw new Error('scene rebuild failed')
    })
    link.onChange(good)

    expect(() => host.deliver(diff(1, { dataset: dataset('SST') }))).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('detaches on stop', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const seen = vi.fn()
    link.onChange(seen)

    await link.stop()
    host.deliver(diff(1, { dataset: dataset('SST') }))

    expect(seen).not.toHaveBeenCalled()
  })

  it('is safe to stop twice', async () => {
    const link = await connectOutputLink(fakeHost())
    await link.stop()
    await expect(link.stop()).resolves.toBeUndefined()
  })
})

describe('isRenderConfig', () => {
  it('accepts a well-formed config, with or without a warp set', () => {
    expect(isRenderConfig(config({ framebufferWidth: 8192, debugOverlay: true }))).toBe(true)
    expect(isRenderConfig(config({ warp: WARP }))).toBe(true)
    expect(isRenderConfig(config({ warp: { ...WARP, texture: null } }))).toBe(true)
    expect(isRenderConfig(config({ warp: { ...WARP, texture: { surface: 'mesh', rotationOffsetDeg: null } } }))).toBe(
      true,
    )
  })

  it.each([
    ['null', null],
    ['a string', 'output_render_config'],
    // What rung 11 sent, and what a warp window once took as a whole
    // config: `setWarp` then received `undefined` and threw on its id.
    ['the two-field payload from before calibration and the warp', { framebufferWidth: 8192, debugOverlay: true }],
    ['a missing width', configWithout('framebufferWidth')],
    ['a missing flag', configWithout('debugOverlay')],
    ['a missing calibration', configWithout('calibration')],
    ['a missing warp', configWithout('warp')],
    ['a missing blend gamma', configWithout('blendGamma')],
    ['a non-numeric width', { ...config(), framebufferWidth: '4096' }],
    ['a NaN width', config({ framebufferWidth: Number.NaN })],
    ['a non-boolean flag', { ...config(), debugOverlay: 1 }],
    ['a non-boolean calibration', { ...config(), calibration: 'on' }],
    ['a non-numeric blend gamma', { ...config(), blendGamma: '2.2' }],
    ['a NaN blend gamma', config({ blendGamma: Number.NaN })],
    ['a warp that is not a set', { ...config(), warp: 'P1.data' }],
    ['a warp whose id is not a content id', config({ warp: { ...WARP, id: 'P1' } })],
    ['a warp whose meshes are not a list', { ...config(), warp: { ...WARP, meshes: {} } }],
    ['a mesh with no text', { ...config(), warp: { ...WARP, meshes: [{ id: 'P1', viewport: WARP.meshes[0].viewport }] } }],
    [
      'a mesh whose viewport is not numbers',
      { ...config(), warp: { ...WARP, meshes: [{ ...WARP.meshes[0], viewport: { x: '0', y: 0, w: 0.5, h: 0.5 } }] } },
    ],
    ['a texture of neither shape', { ...config(), warp: { ...WARP, texture: { surface: 'sphere', rotationOffsetDeg: null } } }],
  ])('rejects %s', (_label, payload) => {
    // Same posture as `isStateMessage`: fail closed, cost one dropped
    // message. The scene clamps an unusable *number* up to its lowest
    // rung, so nothing here reaches `setSize` as a zero — what this
    // rejects is a payload that is not a config at all, which would
    // otherwise overwrite a real one with garbage and be reported to
    // every listener as the operator's choice.
    expect(isRenderConfig(payload)).toBe(false)
  })
})

describe('the render-config channel', () => {
  it('starts at the contract default rather than at nothing', async () => {
    const link = await connectOutputLink(fakeHost())

    // A window that rendered at no resolution until a config arrived
    // would be black for the length of the handshake.
    expect(link.renderConfig()).toEqual(defaultRenderConfig())
  })

  it('holds what the manager sent and tells its listeners', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const seen = vi.fn()
    link.onRenderConfig(seen)

    host.deliverConfig(config({ framebufferWidth: 8192, debugOverlay: true }))

    expect(link.renderConfig()).toEqual(config({ framebufferWidth: 8192, debugOverlay: true }))
    expect(seen).toHaveBeenCalledWith(config({ framebufferWidth: 8192, debugOverlay: true }))
  })

  it('delivers every config, including one that changed nothing', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const seen = vi.fn()
    link.onRenderConfig(seen)

    host.deliverConfig(config({ framebufferWidth: 8192 }))
    host.deliverConfig(config({ framebufferWidth: 8192 }))

    // Unlike state, which is diffed because a heartbeat restates it
    // every second. Nothing repeats on this channel unasked, so a
    // second message means the operator did something twice, and the
    // consumer's own setters are the idempotent ones.
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('keeps the config it holds when a malformed one arrives', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = fakeHost()
    const link = await connectOutputLink(host)
    host.deliverConfig(config({ framebufferWidth: 8192, debugOverlay: true }))

    host.deliverConfig({ framebufferWidth: 'wide' })

    // Dropping the bad message is right; letting it blank the settings
    // would drop an 8K installation to a default nobody chose.
    expect(link.renderConfig()).toEqual(config({ framebufferWidth: 8192, debugOverlay: true }))
  })

  it('keeps the warp it holds when a config without one arrives', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const seen = vi.fn()
    link.onRenderConfig(seen)
    host.deliverConfig(config({ warp: WARP }))

    host.deliverConfig({ framebufferWidth: 8192, debugOverlay: true })

    // Taken as a whole config, this would reach a warp window's
    // `setWarp` as `undefined`, which throws on its id and leaves the
    // rest of the config unapplied. Dropped, the projectors keep the
    // warp they were drawing.
    expect(seen).toHaveBeenCalledTimes(1)
    expect(link.renderConfig().warp).toEqual(WARP)
  })

  it('does not route state onto the config channel', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const seen = vi.fn()
    link.onRenderConfig(seen)

    host.deliver(diff(1, { dataset: dataset('SST') }))

    expect(seen).not.toHaveBeenCalled()
    // The positive anchor: the state channel did take it.
    expect(link.state().dataset?.id).toBe('SST')
  })

  it('isolates a config listener that throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const good = vi.fn()
    link.onRenderConfig(() => {
      throw new Error('framebuffer reallocation failed')
    })
    link.onRenderConfig(good)

    expect(() => host.deliverConfig(config({ framebufferWidth: 1024 }))).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('detaches the config listener on stop too', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const seen = vi.fn()
    link.onRenderConfig(seen)

    await link.stop()
    host.deliverConfig(config({ framebufferWidth: 1024, debugOverlay: true }))

    expect(seen).not.toHaveBeenCalled()
  })

  it('unsubscribes one listener without touching the others', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const stays = vi.fn()
    const off = link.onRenderConfig(vi.fn())
    link.onRenderConfig(stays)

    off()
    host.deliverConfig(config({ framebufferWidth: 1024 }))

    expect(stays).toHaveBeenCalledTimes(1)
  })
})

describe('STATE_KEYS', () => {
  it('names every key of the initial state', () => {
    // `output/main.ts` passes this as "everything changed" when it
    // applies the state held at subscribe time. A key missing here is
    // one applied on diffs and skipped on that initial pass — a
    // difference that would only show at boot, which is the hardest
    // place to notice it.
    expect([...STATE_KEYS].sort()).toEqual(Object.keys(outputInitialState()).sort())
  })
})

/**
 * Which diffs are worth a frame.
 *
 * The wrong answer here is invisible in both directions and expensive
 * in one: too eager burns a GPU budget on redrawing an identical
 * 4096×2048 sphere sixty times a second, too lazy leaves a stale
 * picture that looks exactly like a dropped texture upload.
 */
describe('changesPicture', () => {
  it('classifies every state key, exactly once', () => {
    // The compile-time partition proof beside the lists is the real
    // guard; this is the runtime half of it, so a list that drifts from
    // the type fails here rather than in front of an audience.
    const classified = [...PICTURE_KEYS, ...PLAYHEAD_KEYS]
    expect([...classified].sort()).toEqual([...STATE_KEYS].sort())
    expect(new Set(classified).size).toBe(classified.length)
  })

  it('draws for anything composited', () => {
    for (const key of PICTURE_KEYS) {
      expect(changesPicture([key])).toBe(true)
    }
  })

  it('does not draw for the playhead keys alone', () => {
    // These arrive on every frame the operator's globe plays. Nothing
    // here reads them except the correction, which reports its own
    // pixel change by comparing `currentTime` across the steer.
    expect(changesPicture(PLAYHEAD_KEYS)).toBe(false)
    expect(changesPicture([])).toBe(false)
  })

  it('draws when a picture key rides along with a playhead one', () => {
    // A dataset load publishes `dataset`, `primary` and `playback`
    // together. Testing `some` rather than `every` is what keeps that
    // load from being suppressed by the two keys beside it.
    expect(changesPicture(['playback', 'dataset'] as StateKey[])).toBe(true)
  })
})

describe('announcing a close (rung 13)', () => {
  it('emits output_closing when the window is asked to close', async () => {
    // The only thing separating an operator's Alt+F4 from a crash. A
    // killed process cannot report its own death, so without this
    // announcement every deliberate close is logged as a crash — and
    // three in a minute blocklist a working monitor.
    const host = fakeHost()
    // A holder rather than a bare `let`: TypeScript narrows a variable
    // assigned only inside a callback to its initialiser, and would
    // reject the call below as unreachable.
    const closer: { fire?: () => void } = {}
    host.onCloseRequested = async handler => {
      closer.fire = handler
    }
    await connectOutputLink(host)
    const before = host.emit.mock.calls.length

    closer.fire?.()
    await until(
      () => host.emit.mock.calls.length > before,
      'the closing announcement',
    )

    expect(host.emit.mock.calls.at(-1)?.[1]).toMatchObject({
      type: 'output_closing',
      label: host.label,
    })
  })

  it('connects on a host that has no close notion at all', async () => {
    // The static fixture page. Losing the announcement costs a
    // misclassified close, never the link.
    const host = fakeHost()
    delete host.onCloseRequested
    await expect(connectOutputLink(host)).resolves.toBeTruthy()
  })
})


describe('link health (rung 13, case 3)', () => {
  it('starts live and stays live while the heartbeat lands', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)

    expect(link.checkHealth()).toBe('live')
    host.advance(IPC_STALE_MS - 1)
    host.deliver(diff(1, { simulationDate: '2026-01-01T00:00:00.000Z' }))
    host.advance(IPC_STALE_MS - 1)

    expect(link.checkHealth()).toBe('live')
  })

  it('goes stale and pings, carrying how long it has been quiet', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    host.emit.mockClear()

    host.advance(IPC_STALE_MS)

    expect(link.checkHealth()).toBe('stale')
    expect(host.emit).toHaveBeenCalledWith(OUTPUT_EVENT, {
      type: 'output_health_check',
      label: 'output-3',
      silentMs: IPC_STALE_MS,
    })
  })

  it('counts an unchanged heartbeat as contact', async () => {
    // The manager's idle heartbeat repeats a full snapshot every
    // second, and the store discards it as changing nothing. Recording
    // contact only for messages that changed something would take a
    // perfectly healthy idle link stale in five seconds — which is the
    // single most likely way to get this wrong.
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const idle = full(1, { simulationDate: '2026-01-01T00:00:00.000Z' })

    for (let t = 0; t < IPC_STALE_MS * 3; t += 1000) {
      host.advance(1000)
      host.deliver(idle)
    }

    expect(link.checkHealth()).toBe('live')
  })

  it('counts a config message as contact too', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)

    host.advance(IPC_STALE_MS - 1)
    host.deliverConfig(config({ framebufferWidth: 2048 }))
    host.advance(IPC_STALE_MS - 1)

    expect(link.checkHealth()).toBe('live')
  })

  it('stops pinging once orphaned', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    host.advance(IPC_ORPHAN_MS)
    host.emit.mockClear()

    expect(link.checkHealth()).toBe('orphaned')
    expect(host.emit).not.toHaveBeenCalled()
  })

  it('recovers when the manager comes back', async () => {
    // The plan's recovery path: a relaunched control window finds the
    // window through `getAll()` and sends a fresh snapshot, and the
    // output "exits stale state on receipt".
    const host = fakeHost()
    const link = await connectOutputLink(host)
    host.advance(IPC_ORPHAN_MS * 2)
    expect(link.checkHealth()).toBe('orphaned')

    host.deliver(full(9, { simulationDate: '2026-02-02T00:00:00.000Z' }))

    expect(link.checkHealth()).toBe('live')
  })

  it('does not let a ping rejection escape into the render loop', async () => {
    // `checkHealth` runs per frame. A ping that cannot be delivered is
    // precisely the situation being reported, so letting its rejection
    // propagate would turn a degraded link into a dropped frame.
    const host = fakeHost()
    const link = await connectOutputLink(host)
    host.emit.mockRejectedValue(new Error('channel gone'))
    host.advance(IPC_STALE_MS)

    expect(() => link.checkHealth()).not.toThrow()
    expect(link.linkHealth()).toBe('stale')
  })

  it('reports through linkHealth() without sending anything', async () => {
    // The HUD paints twice a second off this reader; if it evaluated,
    // opening the overlay would change the ping cadence.
    const host = fakeHost()
    const link = await connectOutputLink(host)
    host.advance(IPC_STALE_MS)
    host.emit.mockClear()

    expect(link.linkHealth()).toBe('live')
    expect(host.emit).not.toHaveBeenCalled()
  })
})

describe('reporting the GPU context (rung 13, case 5)', () => {
  it('emits a loss and a recovery on the shared event channel', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    host.emit.mockClear()

    link.reportGpuState('lost')
    link.reportGpuState('restored')

    expect(host.emit.mock.calls).toEqual([
      [OUTPUT_EVENT, { type: 'output_gpu_lost', label: 'output-3' }],
      [OUTPUT_EVENT, { type: 'output_gpu_recovered', label: 'output-3' }],
    ])
  })

  it('says nothing for live, which is the boot state and not a transition', async () => {
    // The scene only ever *leaves* `live`, so there is no third
    // message. `main.ts` pushes the current state once at connect —
    // that push is the one that would otherwise announce a healthy
    // window to the manager on every launch.
    const host = fakeHost()
    const link = await connectOutputLink(host)
    host.emit.mockClear()

    link.reportGpuState('live')

    expect(host.emit).not.toHaveBeenCalled()
  })

  it('does not let a failed report escape into a DOM event handler', async () => {
    // This is called from `webglcontextlost`. A report that cannot be
    // delivered is a worse link, not a reason to throw inside the
    // handler for the failure being reported.
    const host = fakeHost()
    const link = await connectOutputLink(host)
    host.emit.mockRejectedValue(new Error('channel gone'))

    expect(() => link.reportGpuState('lost')).not.toThrow()
  })

  it('stays quiet once the link is stopped', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    await link.stop()
    host.emit.mockClear()

    link.reportGpuState('lost')

    expect(host.emit).not.toHaveBeenCalled()
  })
})

describe('reporting a stream that died', () => {
  // The output emits no telemetry of its own. It tells the control
  // window, and the control window reports it.
  it('tells the control window which dataset could not play', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    host.emit.mockClear()

    link.reportStreamFailure('ds-7')

    expect(host.emit.mock.calls).toEqual([
      [OUTPUT_EVENT, { type: 'output_dataset_stalled', label: 'output-3', datasetId: 'ds-7' }],
    ])
  })

  it('does not throw when the report cannot be delivered', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    host.emit.mockRejectedValue(new Error('channel gone'))

    expect(() => link.reportStreamFailure('ds-7')).not.toThrow()
  })

  it('stays quiet once the link is stopped', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    await link.stop()
    host.emit.mockClear()

    link.reportStreamFailure('ds-7')

    expect(host.emit).not.toHaveBeenCalled()
  })
})

describe('re-announcing on a poke (rung 13, case 6 + case 5)', () => {
  it('notifies subscribers after the re-announcement, not before', async () => {
    // The manager drops an event whose label has no record, so the
    // announcement has to reach it first. Keeping the same order as the
    // first announcement means one rule rather than two.
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const order: string[] = []
    host.emit.mockImplementation(async () => {
      order.push('announce')
    })
    link.onReannounce(() => order.push('reannounce'))

    host.deliverReattach()
    await until(() => order.includes('reannounce'), 'the reannounce hook')

    expect(order).toEqual(['announce', 'reannounce'])
  })

  it('lets a subscriber report state a fresh manager has never heard', async () => {
    // The gap this closes: a manager that booted after a control-window
    // reload adopts the output with `gpuLost: false`, so an output
    // sitting in `lost` gets no Display lost badge. GPU state travels on
    // edges and has no heartbeat to re-state it.
    const host = fakeHost()
    const link = await connectOutputLink(host)
    link.onReannounce(() => link.reportGpuState('lost'))
    host.emit.mockClear()

    host.deliverReattach()

    await until(
      () =>
        host.emit.mock.calls.some(
          c => (c[1] as { type?: string })?.type === 'output_gpu_lost',
        ),
      'the replayed GPU state',
    )
  })

  it('keeps notifying the others when one subscriber throws', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const seen: string[] = []
    link.onReannounce(() => {
      throw new Error('listener blew up')
    })
    link.onReannounce(() => seen.push('second'))

    host.deliverReattach()

    await until(() => seen.length > 0, 'the surviving listener')
    expect(seen).toEqual(['second'])
  })

  it('unsubscribes, and goes quiet once the link stops', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const seen: string[] = []
    const off = link.onReannounce(() => seen.push('fired'))

    off()
    host.deliverReattach()
    await new Promise(r => setTimeout(r, 0))

    expect(seen).toEqual([])
  })
})
