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
  OUTPUT_MODE,
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
import { IDENTITY_PARAMS } from './equirectRtt'
import {
  OUTPUT_EVENT,
  OUTPUT_RENDER_CONFIG_EVENT,
  OUTPUT_STATE_EVENT,
  defaultRenderConfig,
  type MirroredDataset,
  type OutputGlobeState,
  type OutputStateMessage,
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

  it('applies a view for its own geometry', () => {
    const store = createOutputStateStore()
    const view = {
      mode: OUTPUT_MODE,
      dayNight: false,
      params: { cameraOffset: { x: 0.5, y: 0, z: 0 }, split: true },
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
  listenedBefore: () => boolean
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
  return {
    label: 'output-3',
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
    listenedBefore: () => handlers.size > 0 && !listenedLate,
  }
}

describe('connectOutputLink', () => {
  it('installs both listeners before announcing the window', async () => {
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
      [OUTPUT_RENDER_CONFIG_EVENT, OUTPUT_STATE_EVENT].sort(),
    )
  })

  it('announces itself with its label, monitor and mode', async () => {
    const host = fakeHost()

    await connectOutputLink(host)

    expect(host.emit).toHaveBeenCalledWith(OUTPUT_EVENT, {
      type: 'output_ready',
      label: 'output-3',
      monitorName: '\\\\.\\DISPLAY2',
      mode: OUTPUT_MODE,
    })
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
  it('accepts a well-formed config', () => {
    expect(isRenderConfig({ framebufferWidth: 8192, debugOverlay: true })).toBe(true)
  })

  it.each([
    ['null', null],
    ['a string', 'output_render_config'],
    ['a missing width', { debugOverlay: false }],
    ['a missing flag', { framebufferWidth: 4096 }],
    ['a non-numeric width', { framebufferWidth: '4096', debugOverlay: false }],
    ['a NaN width', { framebufferWidth: Number.NaN, debugOverlay: false }],
    ['a non-boolean flag', { framebufferWidth: 4096, debugOverlay: 1 }],
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

    host.deliverConfig({ framebufferWidth: 8192, debugOverlay: true })

    expect(link.renderConfig()).toEqual({ framebufferWidth: 8192, debugOverlay: true })
    expect(seen).toHaveBeenCalledWith({ framebufferWidth: 8192, debugOverlay: true })
  })

  it('delivers every config, including one that changed nothing', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const seen = vi.fn()
    link.onRenderConfig(seen)

    host.deliverConfig({ framebufferWidth: 8192, debugOverlay: false })
    host.deliverConfig({ framebufferWidth: 8192, debugOverlay: false })

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
    host.deliverConfig({ framebufferWidth: 8192, debugOverlay: true })

    host.deliverConfig({ framebufferWidth: 'wide' })

    // Dropping the bad message is right; letting it blank the settings
    // would drop an 8K installation to a default nobody chose.
    expect(link.renderConfig()).toEqual({ framebufferWidth: 8192, debugOverlay: true })
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

    expect(() =>
      host.deliverConfig({ framebufferWidth: 1024, debugOverlay: false }),
    ).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('detaches the config listener on stop too', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const seen = vi.fn()
    link.onRenderConfig(seen)

    await link.stop()
    host.deliverConfig({ framebufferWidth: 1024, debugOverlay: true })

    expect(seen).not.toHaveBeenCalled()
  })

  it('unsubscribes one listener without touching the others', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const stays = vi.fn()
    const off = link.onRenderConfig(vi.fn())
    link.onRenderConfig(stays)

    off()
    host.deliverConfig({ framebufferWidth: 1024, debugOverlay: false })

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
