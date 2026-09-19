// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the output's debug HUD.
 *
 * The formatting is not cosmetic here. An operator in front of a sphere
 * acts on these numbers and has nothing else to check them against, so
 * a wrong sign or a stale reading sends someone hunting the wrong
 * output.
 */

import { describe, it, expect, vi } from 'vitest'

import {
  OVERLAY_REFRESH_MS,
  createDebugOverlay,
  createDrawTimer,
  createFpsMeter,
  formatOverlay,
  type DebugOverlayReading,
} from './debugOverlay'

function reading(over: Partial<DebugOverlayReading> = {}): DebugOverlayReading {
  return {
    datasetId: 'SST',
    driftS: 0,
    syncKind: 'playing',
    fps: 30,
    drawMs: 4.2,
    rafHz: 60,
    link: 'live',
    gpu: 'NVIDIA GeForce RTX 4090 Laptop GPU',
    gpuState: 'live',
    framebuffer: { width: 4096, height: 2048 },
    ...over,
  }
}

describe('formatOverlay', () => {
  it('says why there is no number, when there is no number', () => {
    // A bare dash cannot separate "this is a still image, which has no
    // playhead" from "this element has been seeking for ten seconds".
    // The first hardware pass recorded exactly that ambiguity — "sync
    // just shows a dash" — against a dataset that turned out to be in a
    // seek loop, and the HUD is the only place an operator can ask.
    const image = formatOverlay(reading({ driftS: null, syncKind: 'not-ready' }))
    const stuck = formatOverlay(reading({ driftS: null, syncKind: 'seeking' }))

    expect(image.find(l => l.startsWith('sync'))).toContain('not-ready')
    expect(stuck.find(l => l.startsWith('sync'))).toContain('seeking')
    expect(image).not.toEqual(stuck)
  })

  it('still shows a bare dash before the correction has ever run', () => {
    // No link attached — the static fixture page, or a launch where the
    // host failed. There is no outcome to name and inventing one would
    // be worse than the dash.
    const line = formatOverlay(reading({ driftS: null, syncKind: null })).find(l =>
      l.startsWith('sync'),
    )
    expect(line?.trim()).toBe('sync  —')
  })

  it('prints the number, not the kind, once there is one', () => {
    const line = formatOverlay(reading({ driftS: 0.25, syncKind: 'playing' })).find(l =>
      l.startsWith('sync'),
    )
    expect(line).not.toContain('playing')
  })

  it('signs the drift so ahead and behind are distinguishable', () => {
    // The field an operator acts on. Getting the sign backwards sends
    // someone hunting a lead output that is actually late.
    const ahead = formatOverlay(reading({ driftS: 0.25 })).find(l => l.startsWith('sync'))
    const behind = formatOverlay(reading({ driftS: -0.25 })).find(l => l.startsWith('sync'))

    expect(ahead).toContain('+250 ms')
    expect(behind).toContain('250 ms')
    expect(behind).not.toContain('+')
  })

  it('rounds drift to whole milliseconds', () => {
    // The hard-seek threshold is 150 ms; sub-millisecond precision is
    // noise a reader has to look past.
    expect(formatOverlay(reading({ driftS: 0.0004 })).find(l => l.startsWith('sync'))).toContain(
      '+0 ms',
    )
  })

  it('shows a dash rather than a zero when nothing is steering', () => {
    // An image dataset has no playhead. Printing "0 ms" would read as
    // "perfectly in sync", which is a different and wrong claim.
    const line = formatOverlay(reading({ driftS: null })).find(l => l.startsWith('sync'))
    expect(line).not.toContain('0 ms')
    expect(line).toContain('—')
  })

  it('shows a dash for an absent dataset', () => {
    expect(formatOverlay(reading({ datasetId: null })).find(l => l.startsWith('data'))).toContain(
      '—',
    )
  })

  it('says so when the driver will not name the GPU', () => {
    // Silence here would read as "no GPU line", which is the same thing
    // a broken HUD looks like. The whole point of the field is that an
    // operator can tell the difference.
    expect(formatOverlay(reading({ gpu: null })).find(l => l.startsWith('gpu'))).toContain(
      'unreported',
    )
  })

  it('leaves the gpu line undecorated while the context is live', () => {
    // Same rule as the Outputs panel's health badge: nothing is drawn
    // for the healthy case. A line that carries "(live)" on every
    // output of every installation is a line an operator stops
    // reading, and this HUD is read at a glance from a few metres.
    const line = formatOverlay(reading({ gpuState: 'live' })).find(l => l.startsWith('gpu'))
    expect(line).toBe('gpu   NVIDIA GeForce RTX 4090 Laptop GPU')
  })

  it('names a lost context beside the renderer, not on a line of its own', () => {
    // Beside it because it is the same subject, and because the HUD is
    // six lines over a sphere — a seventh for a field that is empty
    // almost always is the wrong trade.
    expect(
      formatOverlay(reading({ gpuState: 'lost' })).find(l => l.startsWith('gpu')),
    ).toContain('context lost')
  })

  it('keeps saying so after a restore', () => {
    // A restore is not silence. Three rebuilds its GL state, but this
    // window has still had a GPU event this session, and that is worth
    // knowing when someone is working out why a sphere looked wrong
    // ten minutes ago.
    expect(
      formatOverlay(reading({ gpuState: 'restored' })).find(l => l.startsWith('gpu')),
    ).toContain('context restored')
  })

  it('reports the framebuffer, which is not the window', () => {
    // The two differ by design — `output.css` letterboxes one into the
    // other — so this is how the resolution picker is confirmed.
    expect(
      formatOverlay(reading({ framebuffer: { width: 8192, height: 4096 } })).find(l =>
        l.startsWith('buf'),
      ),
    ).toContain('8192×4096')
  })

  it('shows the offered callback rate beside the taken frame rate', () => {
    // 19 of 60 and 19 of 19 are different faults with different owners:
    // the first is this loop declining to draw on callbacks it is
    // getting, the second is a browser that is not offering them. Two
    // hardware passes could not tell those apart, and `draw` alone
    // cannot either — an overrunning GPU blocks at present, between
    // callbacks, where only this number moves.
    const starved = formatOverlay(reading({ fps: 18.8, rafHz: 19.1 })).find(l => l.startsWith('fps'))
    expect(starved).toContain('18.8')
    expect(starved).toContain('19.1')
    const declining = formatOverlay(reading({ fps: 18.8, rafHz: 59.7 })).find(l =>
      l.startsWith('fps'),
    )
    expect(declining).toContain('59.7')
  })

  it('shows the draw cost beside the frame rate, and a dash before the first frame', () => {
    // The pair is the point: 30 fps next to 4 ms is a window with
    // headroom, 19 next to 53 ms is one that cannot keep up, and fps
    // alone cannot tell those apart because it is capped, floored and —
    // while the camera moves — ceilinged by the control window.
    expect(formatOverlay(reading({ drawMs: 52.7 })).find(l => l.startsWith('draw'))).toContain(
      '52.7 ms',
    )
    const unmeasured = formatOverlay(reading({ drawMs: null })).find(l => l.startsWith('draw'))
    expect(unmeasured).toContain('—')
    // Never a zero: that would be a claim about a draw nobody timed.
    expect(unmeasured).not.toContain('0.0')
  })
})

describe('createFpsMeter', () => {
  it('measures over the interval between samples, not since the start', () => {
    // A cumulative count divided by time-since-start folds in however
    // long the first frame took. That is the measurement error the
    // decoder-budget spike chased before differencing two samples.
    const meter = createFpsMeter()
    meter.tick(0)
    // A slow first second: 5 frames.
    for (let i = 1; i < 5; i++) meter.tick(i * 200)
    expect(meter.sample(1000)).toBeCloseTo(5, 5)

    // A fast second: 30 frames. A since-the-start meter would report
    // ~17.5 here; the delta reports the truth.
    for (let i = 0; i < 30; i++) meter.tick(1000 + i * 33)
    expect(meter.sample(2000)).toBeCloseTo(30, 5)
  })

  it('holds its last value rather than dividing by zero', () => {
    const meter = createFpsMeter()
    meter.tick(100)
    meter.sample(200)
    // Same instant twice — a zero window would be Infinity or NaN on
    // screen, which reads as a broken output rather than a fast one.
    expect(Number.isFinite(meter.sample(200))).toBe(true)
  })

  it('reads zero before any frame has been drawn', () => {
    expect(createFpsMeter().sample(1000)).toBe(0)
  })

  it('does not report zero for an output drawing at the 1 Hz floor', () => {
    // The defect this exists for, found on hardware: a static output
    // draws once a second and the HUD samples about twice a second, so
    // roughly every other window holds no frame. Closing those reported
    // `0.0` — the same reading a black projector gives, which is the one
    // state the 1 Hz floor and the skip-while-lost rule exist to make
    // visible.
    const meter = createFpsMeter()
    let nextDraw = 0
    const readings: number[] = []
    for (let now = 0; now <= 6000; now += 500) {
      if (now >= nextDraw) {
        meter.tick(now)
        nextDraw = now + 1000
      }
      readings.push(meter.sample(now))
    }
    // The first sample lands at the same instant as the first frame and
    // has no window yet; everything after it must be a live reading.
    const settled = readings.slice(1)
    expect(settled.every(r => r > 0)).toBe(true)
    // And in the right neighbourhood of the truth — one frame a second.
    // Not exactly 1: a window shorter than the frame period reports the
    // frame it happens to contain over its own length, so the value
    // rides between the true rate and twice it.
    expect(Math.min(...settled)).toBeGreaterThanOrEqual(0.9)
    expect(Math.max(...settled)).toBeLessThanOrEqual(2.1)
  })

  it('decays toward zero while nothing is drawn', () => {
    // The other half of the same rule: holding the window open must not
    // hold the *value* open, or a stalled output would report its last
    // healthy rate forever — the invisible failure the HUD is for.
    const meter = createFpsMeter()
    meter.tick(0)
    meter.tick(33)
    const first = meter.sample(66)
    expect(first).toBeGreaterThan(10)
    const later = [1000, 5000, 20000].map(now => meter.sample(now))
    expect(later[0]).toBeLessThan(first)
    expect(later[1]).toBeLessThan(later[0])
    expect(later[2]).toBeLessThan(0.1)
  })

  it('reports the real rate again once an output recovers', () => {
    // The other side of holding the window open, and the reason the
    // hold needs a matching release. `sample()` leaves `since` alone
    // while no frame arrives, so without a restart the first window
    // after an outage spans the outage as well: ten seconds of a lost
    // context followed by a healthy 30 fps read as 1.4, and an operator
    // reading that concludes the output is still dark.
    const meter = createFpsMeter()
    meter.tick(0)
    meter.tick(33)
    expect(meter.sample(66)).toBeGreaterThan(10)

    // Ten seconds with nothing drawn, sampled throughout as the HUD
    // does.
    for (let now = 500; now <= 10000; now += 500) meter.sample(now)
    expect(meter.sample(10000)).toBeLessThan(1)

    // Recovery: a full 30 fps second.
    for (let i = 0; i < 30; i++) meter.tick(10000 + i * (1000 / 30))
    expect(meter.sample(11000)).toBeCloseTo(30, 0)
  })
})

describe('createDrawTimer', () => {
  it('means the frames in the window, and starts over on each reading', () => {
    const timer = createDrawTimer()
    timer.record(10)
    timer.record(20)
    expect(timer.sample()).toBeCloseTo(15, 5)
    // A fast window after a slow one must read fast — the whole point of
    // the field is to catch a draw cost changing when a dataset loads.
    timer.record(2)
    timer.record(4)
    expect(timer.sample()).toBeCloseTo(3, 5)
  })

  it('reads nothing at all before the first frame', () => {
    // A dash, never a zero: a zero-millisecond draw is a claim, and
    // "not measured yet" is the truth.
    expect(createDrawTimer().sample()).toBeNull()
  })

  it('holds its last value across a window with no frames', () => {
    // Unlike fps, a mean over nothing is not a small number — it is
    // unknown. And a static output draws once a second, so the next
    // window will have one.
    const timer = createDrawTimer()
    timer.record(8)
    expect(timer.sample()).toBeCloseTo(8, 5)
    expect(timer.sample()).toBeCloseTo(8, 5)
  })

  it('ignores a negative or non-finite duration', () => {
    // A clock that went backwards would otherwise drag the mean under
    // zero and report a free draw, which is the one answer this field
    // must never give.
    const timer = createDrawTimer()
    timer.record(-5)
    timer.record(Number.NaN)
    expect(timer.sample()).toBeNull()
    timer.record(6)
    timer.record(-100)
    expect(timer.sample()).toBeCloseTo(6, 5)
  })
})

function fakeDom() {
  const created: FakeEl[] = []
  interface FakeEl {
    id: string
    hidden: boolean
    textContent: string
    remove: () => void
    removed: boolean
  }
  const doc = {
    createElement: () => {
      const el: FakeEl = {
        id: '',
        hidden: false,
        textContent: '',
        removed: false,
        remove: () => {
          el.removed = true
        },
      }
      created.push(el)
      return el as unknown as HTMLElement
    },
    body: { appendChild: () => undefined as unknown as Node },
  }
  return { doc: doc as never, created }
}

describe('createDebugOverlay', () => {
  it('starts hidden and paints nothing until shown', () => {
    const { doc, created } = fakeDom()
    const read = vi.fn(reading)
    const timer: { fire?: () => void } = {}

    createDebugOverlay(read, {
      document: doc,
      setInterval: fn => {
        timer.fire = fn
        return 1
      },
      clearInterval: () => {},
    })
    timer.fire?.()

    expect(created[0].hidden).toBe(true)
    // Not merely blank — never read. A hidden HUD must not be walking
    // the mirror and the renderer twice a second on a projector.
    expect(read).not.toHaveBeenCalled()
  })

  it('paints immediately when shown rather than waiting out the interval', () => {
    const { doc, created } = fakeDom()
    const overlay = createDebugOverlay(reading, {
      document: doc,
      setInterval: () => 1,
      clearInterval: () => {},
    })

    overlay.setVisible(true)

    // Half a second of empty box after ticking the toggle reads as "it
    // did not work".
    expect(created[0].hidden).toBe(false)
    expect(created[0].textContent).toContain('SST')
  })

  it('re-reads on every refresh, holding no copy of its own', () => {
    const { doc, created } = fakeDom()
    let id = 'FIRST'
    const timer: { fire?: () => void } = {}
    const overlay = createDebugOverlay(() => reading({ datasetId: id }), {
      document: doc,
      setInterval: fn => {
        timer.fire = fn
        return 1
      },
      clearInterval: () => {},
    })
    overlay.setVisible(true)

    id = 'SECOND'
    timer.fire?.()

    expect(created[0].textContent).toContain('SECOND')
  })

  it('survives a reader that throws', () => {
    const { doc, created } = fakeDom()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const timer: { fire?: () => void } = {}
    const overlay = createDebugOverlay(
      () => {
        throw new Error('mirror torn down')
      },
      {
        document: doc,
        setInterval: fn => {
          timer.fire = fn
          return 1
        },
        clearInterval: () => {},
      },
    )

    // A HUD that throws must not take down the window it is drawn over
    // — an operator losing the readout still has the picture.
    expect(() => overlay.setVisible(true)).not.toThrow()
    expect(() => timer.fire?.()).not.toThrow()
    expect(created[0].removed).toBe(false)
  })

  it('stops its timer and removes itself on dispose', () => {
    const { doc, created } = fakeDom()
    const clearInterval = vi.fn()
    const overlay = createDebugOverlay(reading, {
      document: doc,
      setInterval: () => 42,
      clearInterval,
    })

    overlay.dispose()

    expect(clearInterval).toHaveBeenCalledWith(42)
    expect(created[0].removed).toBe(true)
  })

  it('degrades to an inert handle with no document', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const overlay = createDebugOverlay(reading, {
      document: undefined,
      setInterval: () => 1,
      clearInterval: () => {},
    })

    // The static fixture page can load this file without a DOM. Losing
    // the HUD is right; throwing out of boot is not.
    expect(() => overlay.setVisible(true)).not.toThrow()
    expect(() => overlay.dispose()).not.toThrow()
  })

  it('refreshes about twice a second', () => {
    // Slow enough that a human reads it, fast enough to feel live —
    // and independent of the render loop, which drops to 1 Hz for
    // static content and would freeze the fps readout with it.
    expect(OVERLAY_REFRESH_MS).toBeGreaterThanOrEqual(250)
    expect(OVERLAY_REFRESH_MS).toBeLessThanOrEqual(1000)
  })
})
