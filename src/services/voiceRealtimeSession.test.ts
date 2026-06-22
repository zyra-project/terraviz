import { describe, it, expect, vi } from 'vitest'
import { RealtimeVoiceSession, type RealtimeState, type StartVad } from './voiceRealtimeSession'
import { createFakeStreamingSttEngine } from './voiceService'

/** A mic stream whose tracks record stop() for teardown assertions. */
function makeFakeMic() {
  const tracks = [{ stop: vi.fn() }]
  const stream = { getTracks: () => tracks } as unknown as MediaStream
  return { acquireMic: () => Promise.resolve(stream), tracks }
}

/** A VAD seam that lets the test drive speech onset/offset. */
function makeFakeVad() {
  let cbs: { onSpeechStart?: () => void; onSpeechEnd?: () => void } = {}
  let stopped = false
  const startVad: StartVad = (_stream, opts) => {
    cbs = { onSpeechStart: opts?.onSpeechStart, onSpeechEnd: opts?.onSpeechEnd }
    return { stop: () => { stopped = true } }
  }
  return {
    startVad,
    speechStart: () => cbs.onSpeechStart?.(),
    speechEnd: () => cbs.onSpeechEnd?.(),
    get stopped() { return stopped },
  }
}

describe('RealtimeVoiceSession — open-mic mode', () => {
  it('arms, VAD-gates capture, emits a turn, then re-listens', async () => {
    const engine = createFakeStreamingSttEngine({})
    const mic = makeFakeMic()
    const vad = makeFakeVad()
    const states: RealtimeState[] = []
    const turns: string[] = []
    const partials: string[] = []
    const session = new RealtimeVoiceSession({
      engine, lang: 'en', mode: 'open-mic',
      onTurn: (t) => turns.push(t),
      onPartial: (t) => partials.push(t),
      onStateChange: (s) => states.push(s),
      acquireMic: mic.acquireMic,
      startVad: vad.startVad,
    })

    await session.arm()
    expect(session.getState()).toBe('listening')
    expect(engine.active).toBe(false) // no audio streamed yet — VAD gate

    vad.speechStart()
    expect(session.getState()).toBe('capturing')
    expect(engine.active).toBe(true)

    engine.emitPartial('hel')
    engine.emitTurn('hello world')
    expect(partials).toEqual(['hel'])
    expect(turns).toEqual(['hello world'])
    // open-mic auto-ends the stream after a turn and re-listens.
    expect(engine.active).toBe(false)
    expect(session.getState()).toBe('listening')

    expect(states).toEqual(['listening', 'capturing', 'listening'])
  })

  it('VAD offset with no turn stops streaming (audio leaves device only during speech)', async () => {
    const engine = createFakeStreamingSttEngine({})
    const mic = makeFakeMic()
    const vad = makeFakeVad()
    const session = new RealtimeVoiceSession({
      engine, lang: 'en', mode: 'open-mic',
      onTurn: () => {}, acquireMic: mic.acquireMic, startVad: vad.startVad,
    })
    await session.arm()
    vad.speechStart()
    expect(engine.active).toBe(true)
    vad.speechEnd()
    expect(engine.active).toBe(false)
    expect(session.getState()).toBe('listening')
  })

  it('disarm stops the VAD and the mic tracks', async () => {
    const engine = createFakeStreamingSttEngine({})
    const mic = makeFakeMic()
    const vad = makeFakeVad()
    const session = new RealtimeVoiceSession({
      engine, lang: 'en', mode: 'open-mic',
      onTurn: () => {}, acquireMic: mic.acquireMic, startVad: vad.startVad,
    })
    await session.arm()
    session.disarm()
    expect(session.getState()).toBe('idle')
    expect(vad.stopped).toBe(true)
    expect(mic.tracks[0]!.stop).toHaveBeenCalled()
  })
})

describe('RealtimeVoiceSession — push-to-talk mode', () => {
  it('does not start VAD; capture is button-driven and stays until release', async () => {
    const engine = createFakeStreamingSttEngine({})
    const mic = makeFakeMic()
    const vad = makeFakeVad()
    const session = new RealtimeVoiceSession({
      engine, lang: 'en', mode: 'push-to-talk',
      onTurn: () => {}, acquireMic: mic.acquireMic, startVad: vad.startVad,
    })
    await session.arm()
    expect(session.getState()).toBe('listening')

    session.startCapture()
    expect(session.getState()).toBe('capturing')
    expect(engine.active).toBe(true)

    // A turn arrives mid-press — push-to-talk keeps capturing until release.
    engine.emitTurn('first')
    expect(session.getState()).toBe('capturing')
    expect(engine.active).toBe(true)

    session.stopCapture()
    expect(session.getState()).toBe('listening')
    expect(engine.active).toBe(false)
  })
})

describe('RealtimeVoiceSession — suspension (self-trigger guard)', () => {
  it('suspending drops the in-flight turn and ignores VAD until resumed', async () => {
    const engine = createFakeStreamingSttEngine({})
    const mic = makeFakeMic()
    const vad = makeFakeVad()
    const session = new RealtimeVoiceSession({
      engine, lang: 'en', mode: 'open-mic',
      onTurn: () => {}, acquireMic: mic.acquireMic, startVad: vad.startVad,
    })
    await session.arm()
    vad.speechStart()
    expect(session.getState()).toBe('capturing')

    session.setSuspended(true)
    expect(session.getState()).toBe('suspended')
    expect(engine.active).toBe(false)

    // VAD fires while Orbit is speaking — must be ignored (no self-trigger).
    vad.speechStart()
    expect(engine.active).toBe(false)
    expect(session.getState()).toBe('suspended')

    session.setSuspended(false)
    expect(session.getState()).toBe('listening')
    vad.speechStart()
    expect(session.getState()).toBe('capturing')
    expect(engine.active).toBe(true)
  })
})

describe('RealtimeVoiceSession — mic acquisition failure', () => {
  it('reports an error and stays idle when the mic is denied', async () => {
    const engine = createFakeStreamingSttEngine({})
    const onError = vi.fn()
    const session = new RealtimeVoiceSession({
      engine, lang: 'en', mode: 'open-mic',
      onTurn: () => {}, onError,
      acquireMic: () => Promise.reject(new Error('NotAllowedError')),
    })
    await session.arm()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'NotAllowedError' }))
    expect(session.getState()).toBe('idle')
  })
})

describe('RealtimeVoiceSession — engine ends unexpectedly', () => {
  it('recovers to listening when the engine ends mid-capture (not via stop)', async () => {
    const engine = createFakeStreamingSttEngine({})
    const mic = makeFakeMic()
    const vad = makeFakeVad()
    const session = new RealtimeVoiceSession({
      engine, lang: 'en', mode: 'open-mic',
      onTurn: () => {}, acquireMic: mic.acquireMic, startVad: vad.startVad,
    })
    await session.arm()
    vad.speechStart()
    expect(session.getState()).toBe('capturing')

    // Engine ends on its own (Web Speech timeout / permission loss).
    engine.endActiveSession()
    expect(session.getState()).toBe('listening')

    // The session can capture again on the next onset.
    vad.speechStart()
    expect(session.getState()).toBe('capturing')
    expect(engine.active).toBe(true)
  })
})
