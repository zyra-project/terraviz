import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HandsFreeController, type StartWake } from './voiceHandsFree'
import {
  resetVoiceEngines,
  registerStreamingSttEngine,
  createFakeStreamingSttEngine,
  type FakeStreamingSttEngine,
} from '../services/voiceService'
import type { StartVad } from '../services/voiceRealtimeSession'

/** A driveable wake-word seam: `fire()` simulates a detected wake phrase. */
function makeWake() {
  let onWake: (() => void) | null = null
  let stopped = false
  const startWake: StartWake = (cb) => { onWake = cb; stopped = false; return { stop: () => { stopped = true } } }
  return {
    startWake,
    fire: () => onWake?.(),
    get started() { return onWake !== null },
    get stopped() { return stopped },
  }
}

/** Mic + VAD seams the controller forwards to its session. */
function makeSeams() {
  const tracks = [{ stop: vi.fn() }]
  const stream = { getTracks: () => tracks } as unknown as MediaStream
  let vadCbs: { onSpeechStart?: () => void; onSpeechEnd?: () => void } = {}
  const startVad: StartVad = (_s, opts) => {
    vadCbs = { onSpeechStart: opts?.onSpeechStart, onSpeechEnd: opts?.onSpeechEnd }
    return { stop: () => {} }
  }
  return {
    acquireMic: () => Promise.resolve(stream),
    startVad,
    speechStart: () => vadCbs.onSpeechStart?.(),
    speechEnd: () => vadCbs.onSpeechEnd?.(),
  }
}

let engine: FakeStreamingSttEngine

beforeEach(() => {
  resetVoiceEngines()
  engine = createFakeStreamingSttEngine({ provider: 'browser', languages: ['en'] })
  registerStreamingSttEngine(engine)
})

describe('HandsFreeController.sync', () => {
  it('stays inert for mode "off"', () => {
    const c = new HandsFreeController({ onPartial: () => {}, onTurn: () => {} })
    c.sync({ mode: 'off', lang: 'en', provider: 'auto' })
    expect(c.isActive()).toBe(false)
  })

  it('stays inert when no streaming engine resolves', () => {
    resetVoiceEngines() // no engine registered
    const c = new HandsFreeController({ onPartial: () => {}, onTurn: () => {} })
    c.sync({ mode: 'open-mic', lang: 'en', provider: 'auto' })
    expect(c.isActive()).toBe(false)
  })

  it('activates for a hands-free mode when an engine resolves', () => {
    const c = new HandsFreeController({ onPartial: () => {}, onTurn: () => {} }, makeSeams())
    c.sync({ mode: 'open-mic', lang: 'en', provider: 'auto' })
    expect(c.isActive()).toBe(true)
    expect(c.currentMode).toBe('open-mic')
  })

  it('tears down when switched back to off', () => {
    const c = new HandsFreeController({ onPartial: () => {}, onTurn: () => {} }, makeSeams())
    c.sync({ mode: 'open-mic', lang: 'en', provider: 'auto' })
    expect(c.isActive()).toBe(true)
    c.sync({ mode: 'off', lang: 'en', provider: 'auto' })
    expect(c.isActive()).toBe(false)
  })
})

describe('HandsFreeController open-mic flow', () => {
  it('forwards partials and turns from a VAD-gated capture', async () => {
    const partials: string[] = []
    const turns: string[] = []
    const seams = makeSeams()
    const c = new HandsFreeController(
      { onPartial: (t) => partials.push(t), onTurn: (t) => turns.push(t) },
      seams,
    )
    c.sync({ mode: 'open-mic', lang: 'en', provider: 'auto' })
    // arm() awaits the mic; let the microtask settle.
    await Promise.resolve()
    await Promise.resolve()

    seams.speechStart()        // VAD onset -> session begins streaming
    engine.emitPartial('hel')
    engine.emitTurn('hello')
    expect(partials).toEqual(['hel'])
    expect(turns).toEqual(['hello'])
  })

  it('toggleMute disarms and re-arms the session', async () => {
    const c = new HandsFreeController({ onPartial: () => {}, onTurn: () => {} }, makeSeams())
    c.sync({ mode: 'open-mic', lang: 'en', provider: 'auto' })
    await Promise.resolve()
    expect(c.toggleMute()).toBe(true)
    expect(c.isMuted()).toBe(true)
    expect(c.toggleMute()).toBe(false)
    expect(c.isMuted()).toBe(false)
  })

  it('setBusy(true) drops any in-flight turn (self-trigger guard)', async () => {
    const turns: string[] = []
    const seams = makeSeams()
    const c = new HandsFreeController({ onPartial: () => {}, onTurn: (t) => turns.push(t) }, seams)
    c.sync({ mode: 'open-mic', lang: 'en', provider: 'auto' })
    await Promise.resolve()
    seams.speechStart()
    expect(engine.active).toBe(true)
    c.setBusy(true)
    expect(engine.active).toBe(false) // streaming stopped while Orbit speaks
    c.setBusy(false)
    // A fresh utterance after resume still flows.
    seams.speechStart()
    engine.emitTurn('again')
    expect(turns).toEqual(['again'])
  })
})

describe('HandsFreeController push-to-talk', () => {
  it('captures only between press and release', async () => {
    const turns: string[] = []
    const c = new HandsFreeController({ onPartial: () => {}, onTurn: (t) => turns.push(t) }, makeSeams())
    c.sync({ mode: 'push-to-talk', lang: 'en', provider: 'auto' })
    expect(engine.active).toBe(false) // not listening until pressed

    await c.press()
    expect(engine.active).toBe(true)
    engine.emitTurn('one')
    expect(turns).toEqual(['one'])

    c.release()
    expect(engine.active).toBe(false)
  })
})

describe('HandsFreeController wake-word', () => {
  const flush = async () => { await Promise.resolve(); await Promise.resolve() }

  it('stays silent until a wake, then captures a single turn and releases', async () => {
    const turns: string[] = []
    const wake = makeWake()
    const c = new HandsFreeController(
      { onPartial: () => {}, onTurn: (t) => turns.push(t) },
      { ...makeSeams(), startWake: wake.startWake },
    )
    c.sync({ mode: 'wake-word', lang: 'en', provider: 'auto' })
    expect(c.isActive()).toBe(true)
    expect(wake.started).toBe(true)
    expect(engine.active).toBe(false) // nothing streams before a wake

    wake.fire()
    await flush()
    expect(engine.active).toBe(true) // wake armed a turn

    engine.emitTurn('show me sea ice')
    expect(turns).toEqual(['show me sea ice'])
    expect(engine.active).toBe(false) // turn ended, mic released
    // Wake listener keeps running for the next "Hey Orbit".
    expect(wake.stopped).toBe(false)
  })

  it('abandons the turn and reports a misfire when no speech follows a wake', async () => {
    vi.useFakeTimers()
    try {
      const onWakeMisfire = vi.fn()
      const wake = makeWake()
      const c = new HandsFreeController(
        { onPartial: () => {}, onTurn: () => {}, onWakeMisfire },
        { ...makeSeams(), startWake: wake.startWake },
      )
      c.sync({ mode: 'wake-word', lang: 'en', provider: 'auto' })
      wake.fire()
      await vi.advanceTimersByTimeAsync(0) // let arm() + startCapture settle
      expect(engine.active).toBe(true)

      await vi.advanceTimersByTimeAsync(10_000) // past the capture window
      expect(onWakeMisfire).toHaveBeenCalledTimes(1)
      expect(engine.active).toBe(false) // mic released
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores wakes while Orbit is busy (self-trigger guard)', async () => {
    const wake = makeWake()
    const c = new HandsFreeController(
      { onPartial: () => {}, onTurn: () => {} },
      { ...makeSeams(), startWake: wake.startWake },
    )
    c.sync({ mode: 'wake-word', lang: 'en', provider: 'auto' })
    c.setBusy(true)
    wake.fire()
    await flush()
    expect(engine.active).toBe(false) // no capture while speaking
  })

  it('mute stops the wake listener; unmute restarts it', async () => {
    const wake = makeWake()
    const c = new HandsFreeController(
      { onPartial: () => {}, onTurn: () => {} },
      { ...makeSeams(), startWake: wake.startWake },
    )
    c.sync({ mode: 'wake-word', lang: 'en', provider: 'auto' })
    expect(c.toggleMute()).toBe(true)
    expect(wake.stopped).toBe(true)
    expect(c.toggleMute()).toBe(false)
    expect(wake.started).toBe(true)
    expect(wake.stopped).toBe(false)
  })

  it('teardown stops the wake listener', () => {
    const wake = makeWake()
    const c = new HandsFreeController(
      { onPartial: () => {}, onTurn: () => {} },
      { ...makeSeams(), startWake: wake.startWake },
    )
    c.sync({ mode: 'wake-word', lang: 'en', provider: 'auto' })
    c.sync({ mode: 'off', lang: 'en', provider: 'auto' })
    expect(wake.stopped).toBe(true)
    expect(c.isActive()).toBe(false)
  })

  it('stays inert for wake-word when unconfigured and no startWake seam is injected', () => {
    // No `startWake` dep + no VITE model URL in the test env → the mode
    // can't actually run, so it must fall back to inert (not a dead mode).
    const c = new HandsFreeController({ onPartial: () => {}, onTurn: () => {} }, makeSeams())
    c.sync({ mode: 'wake-word', lang: 'en', provider: 'auto' })
    expect(c.isActive()).toBe(false)
  })

  it('does not report a misfire when the mic fails to arm on wake', async () => {
    vi.useFakeTimers()
    try {
      const onWakeMisfire = vi.fn()
      const wake = makeWake()
      const c = new HandsFreeController(
        { onPartial: () => {}, onTurn: () => {}, onWakeMisfire },
        { acquireMic: () => Promise.reject(new Error('denied')), startWake: wake.startWake },
      )
      c.sync({ mode: 'wake-word', lang: 'en', provider: 'auto' })
      wake.fire()
      await vi.advanceTimersByTimeAsync(10_000) // past the capture window
      expect(engine.active).toBe(false)
      // A mic failure is not a "wake but no speech" — no false-fire row.
      expect(onWakeMisfire).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
