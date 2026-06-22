import { describe, it, expect, vi } from 'vitest'
import { WakeWordDetector, startWakeWord, type WakeWordScorer } from './voiceWakeWord'

/** Push `n` frames of `score` into a detector. */
function pushN(d: WakeWordDetector, score: number, n: number): void {
  for (let i = 0; i < n; i++) d.push(score)
}

describe('WakeWordDetector', () => {
  it('does not fire below threshold', () => {
    const onWake = vi.fn()
    const d = new WakeWordDetector({ threshold: 0.6, triggerFrames: 3, onWake })
    pushN(d, 0.5, 10)
    expect(onWake).not.toHaveBeenCalled()
  })

  it('fires once after triggerFrames consecutive hits', () => {
    const onWake = vi.fn()
    const d = new WakeWordDetector({ threshold: 0.6, triggerFrames: 3, cooldownMs: 0, onWake })
    d.push(0.9)
    d.push(0.9)
    expect(onWake).not.toHaveBeenCalled() // only 2 of 3
    d.push(0.9)
    expect(onWake).toHaveBeenCalledTimes(1)
  })

  it('a single-frame spike below the run length does not fire', () => {
    const onWake = vi.fn()
    const d = new WakeWordDetector({ threshold: 0.6, triggerFrames: 3, onWake })
    d.push(0.9)
    d.push(0.9)
    d.push(0.1) // resets the run
    pushN(d, 0.1, 5)
    expect(onWake).not.toHaveBeenCalled()
  })

  it('respects the cooldown, then re-arms', () => {
    let t = 1000
    const onWake = vi.fn()
    const d = new WakeWordDetector({ threshold: 0.6, triggerFrames: 2, cooldownMs: 500, onWake, now: () => t })
    pushN(d, 0.9, 2)
    expect(onWake).toHaveBeenCalledTimes(1)
    expect(d.armed).toBe(false)

    // Still in cooldown — loud frames are ignored.
    t = 1300
    pushN(d, 0.9, 5)
    expect(onWake).toHaveBeenCalledTimes(1)
    expect(d.armed).toBe(false)

    // Past the cooldown — re-arms and can fire again.
    t = 1600
    expect(d.armed).toBe(true)
    pushN(d, 0.9, 2)
    expect(onWake).toHaveBeenCalledTimes(2)
  })

  it('reset clears hit run and cooldown', () => {
    let t = 0
    const onWake = vi.fn()
    const d = new WakeWordDetector({ threshold: 0.6, triggerFrames: 2, cooldownMs: 1000, onWake, now: () => t })
    pushN(d, 0.9, 2)
    expect(d.armed).toBe(false)
    d.reset()
    expect(d.armed).toBe(true)
    pushN(d, 0.9, 2)
    expect(onWake).toHaveBeenCalledTimes(2)
  })
})

describe('startWakeWord (scorer composition)', () => {
  const dummyStream = {} as MediaStream

  it('fires onWake when the scorer feeds enough hits, and stop() releases it', async () => {
    let emit: ((score: number) => void) | null = null
    let stopped = false
    const scorer: WakeWordScorer = (_stream, onScore) => {
      emit = onScore
      return { stop: () => { stopped = true } }
    }
    const onWake = vi.fn()
    const session = await startWakeWord(dummyStream, { scorer, threshold: 0.6, triggerFrames: 2, cooldownMs: 0, onWake })

    emit!(0.9)
    emit!(0.9)
    expect(onWake).toHaveBeenCalledTimes(1)

    session.stop()
    expect(stopped).toBe(true)
    // Scores after stop are ignored.
    emit!(0.9); emit!(0.9)
    expect(onWake).toHaveBeenCalledTimes(1)
  })

  it('is inert with the default (no scorer) backend', async () => {
    const onWake = vi.fn()
    const session = await startWakeWord(dummyStream, { onWake })
    session.stop()
    expect(onWake).not.toHaveBeenCalled()
  })

  it('cancels a still-loading scorer: stop() before it resolves releases the late capture', async () => {
    let resolveScorer: (() => void) | null = null
    let captureStopped = false
    const scorer: WakeWordScorer = () => new Promise<{ stop: () => void }>((res) => {
      resolveScorer = () => res({ stop: () => { captureStopped = true } })
    })
    const session = startWakeWord(dummyStream, { scorer })
    session.stop()         // stop while the scorer (model load) is still pending
    resolveScorer!()       // load finishes only now
    await Promise.resolve()
    await Promise.resolve()
    expect(captureStopped).toBe(true) // the late-arriving capture was released
  })

  it('soft-fails a scorer that rejects (does not throw)', async () => {
    const scorer: WakeWordScorer = () => Promise.reject(new Error('model load failed'))
    expect(() => startWakeWord(dummyStream, { scorer })).not.toThrow()
    await Promise.resolve()
  })
})
