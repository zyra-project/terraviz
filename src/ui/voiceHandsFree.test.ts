import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HandsFreeController } from './voiceHandsFree'
import {
  resetVoiceEngines,
  registerStreamingSttEngine,
  createFakeStreamingSttEngine,
  type FakeStreamingSttEngine,
} from '../services/voiceService'
import type { StartVad } from '../services/voiceRealtimeSession'

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
