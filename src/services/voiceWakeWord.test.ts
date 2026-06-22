import { describe, it, expect, vi } from 'vitest'
import { WakeWordDetector } from './voiceWakeWord'

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
