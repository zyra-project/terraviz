import { describe, it, expect, vi } from 'vitest'
import { EnergyVad, rmsEnergy } from './voiceVad'

/** Push `n` frames of the given energy into a VAD. */
function pushFrames(vad: EnergyVad, energy: number, n: number): void {
  for (let i = 0; i < n; i++) vad.push(energy)
}

describe('EnergyVad', () => {
  it('stays silent below threshold', () => {
    const onSpeechStart = vi.fn()
    const vad = new EnergyVad({ threshold: 0.02, attackFrames: 3, onSpeechStart })
    pushFrames(vad, 0.01, 20)
    expect(onSpeechStart).not.toHaveBeenCalled()
    expect(vad.speaking).toBe(false)
  })

  it('fires onset only after attackFrames consecutive loud frames', () => {
    const onSpeechStart = vi.fn()
    const vad = new EnergyVad({ threshold: 0.02, attackFrames: 3, onSpeechStart })
    vad.push(0.5)
    vad.push(0.5)
    expect(onSpeechStart).not.toHaveBeenCalled() // only 2 of 3
    vad.push(0.5)
    expect(onSpeechStart).toHaveBeenCalledTimes(1)
    expect(vad.speaking).toBe(true)
    // No re-fire while it stays loud.
    pushFrames(vad, 0.5, 5)
    expect(onSpeechStart).toHaveBeenCalledTimes(1)
  })

  it('a brief spike shorter than attackFrames does not trigger', () => {
    const onSpeechStart = vi.fn()
    const vad = new EnergyVad({ threshold: 0.02, attackFrames: 3, onSpeechStart })
    vad.push(0.5)
    vad.push(0.5)
    vad.push(0.0) // resets attack run
    pushFrames(vad, 0.0, 5)
    expect(onSpeechStart).not.toHaveBeenCalled()
  })

  it('fires offset only after releaseFrames of silence (hangover)', () => {
    const onSpeechEnd = vi.fn()
    const vad = new EnergyVad({ threshold: 0.02, attackFrames: 2, releaseFrames: 4, onSpeechEnd })
    pushFrames(vad, 0.5, 2) // -> speaking
    expect(vad.speaking).toBe(true)
    pushFrames(vad, 0.0, 3) // 3 < 4, still speaking
    expect(onSpeechEnd).not.toHaveBeenCalled()
    expect(vad.speaking).toBe(true)
    vad.push(0.0) // 4th silent frame -> offset
    expect(onSpeechEnd).toHaveBeenCalledTimes(1)
    expect(vad.speaking).toBe(false)
  })

  it('a brief dropout mid-utterance does not end the turn', () => {
    const onSpeechEnd = vi.fn()
    const vad = new EnergyVad({ threshold: 0.02, attackFrames: 2, releaseFrames: 4, onSpeechEnd })
    pushFrames(vad, 0.5, 2) // speaking
    vad.push(0.0)
    vad.push(0.0) // 2 silent (< 4)
    vad.push(0.5) // loud again resets release
    pushFrames(vad, 0.0, 3) // 3 silent (< 4)
    expect(onSpeechEnd).not.toHaveBeenCalled()
    expect(vad.speaking).toBe(true)
  })

  it('reset() returns to silence without firing callbacks', () => {
    const onSpeechStart = vi.fn()
    const onSpeechEnd = vi.fn()
    const vad = new EnergyVad({ threshold: 0.02, attackFrames: 2, onSpeechStart, onSpeechEnd })
    pushFrames(vad, 0.5, 2)
    expect(vad.speaking).toBe(true)
    vad.reset()
    expect(vad.speaking).toBe(false)
    expect(onSpeechEnd).not.toHaveBeenCalled()
    // After reset it needs a fresh attack run to fire again.
    vad.push(0.5)
    expect(onSpeechStart).toHaveBeenCalledTimes(1) // from before reset
    vad.push(0.5)
    expect(onSpeechStart).toHaveBeenCalledTimes(2)
  })
})

describe('rmsEnergy', () => {
  it('is 0 for silence and for an empty frame', () => {
    expect(rmsEnergy(new Float32Array(0))).toBe(0)
    expect(rmsEnergy(new Float32Array([0, 0, 0, 0]))).toBe(0)
  })

  it('computes RMS of a frame', () => {
    // RMS of [±0.5] is 0.5.
    expect(rmsEnergy(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5, 6)
    // Full-scale square wave -> 1.0.
    expect(rmsEnergy(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(1, 6)
  })
})
