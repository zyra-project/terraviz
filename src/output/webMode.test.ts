// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import {
  MAX_WEB_RATE,
  MIN_WEB_RATE,
  defaultWebFramebufferWidth,
  mergedParams,
  readWebSettings,
  rotationOffsetRadFor,
  sameClock,
} from './webMode'
import { IDENTITY_PARAMS, equirectSourceUv } from './equirectRtt'

describe('readWebSettings', () => {
  it('reads nothing from a bare address: the idle Earth, letterboxed, on its own clock', () => {
    expect(readWebSettings('', '')).toEqual({
      datasetId: null,
      fit: 'contain',
      framebufferWidth: null,
      centreLonDeg: 0,
      debug: false,
      telemetry: false,
      clock: { positionS: 0, atUnixS: null, rate: 1, paused: false },
    })
  })

  it('reads a full setup from the query', () => {
    const s = readWebSettings('?dataset=01KQG611HF8YXJNRBEHT0757KT&fit=fill&width=2048&rotation=-90&debug=1', '')
    expect(s.datasetId).toBe('01KQG611HF8YXJNRBEHT0757KT')
    expect(s.fit).toBe('fill')
    expect(s.framebufferWidth).toBe(2048)
    expect(s.centreLonDeg).toBe(270)
    expect(s.debug).toBe(true)
  })

  it('lets the fragment replace the query, key by key', () => {
    // A controller moves a setting into the fragment and the page does
    // not care which half it came from.
    const s = readWebSettings('?dataset=AAA&width=2048', '#dataset=BBB&t=5')
    expect(s.datasetId).toBe('BBB')
    expect(s.framebufferWidth).toBe(2048)
    expect(s.clock.positionS).toBe(5)
  })

  it('accepts the fragment with or without its #', () => {
    expect(mergedParams('', '#a=1').get('a')).toBe('1')
    expect(mergedParams('', 'a=1').get('a')).toBe('1')
  })

  it('fails closed one value at a time', () => {
    // A bad width costs the width; the dataset still loads.
    const s = readWebSettings('?dataset=AAA&width=3000&fit=stretch&rotation=east', '')
    expect(s.datasetId).toBe('AAA')
    expect(s.framebufferWidth).toBeNull()
    expect(s.fit).toBe('contain')
    expect(s.centreLonDeg).toBe(0)
  })

  it('takes plain decimals only', () => {
    // `Number()` reads every one of these as 4096.
    for (const loose of ['0x1000', '4.096e3', ' 4096', '4096 ', '+4096']) {
      expect(readWebSettings(`?width=${encodeURIComponent(loose)}`, '').framebufferWidth).toBeNull()
    }
    expect(readWebSettings('?width=4096', '').framebufferWidth).toBe(4096)
    expect(readWebSettings('?width=4096.0', '').framebufferWidth).toBe(4096)
    expect(readWebSettings('', '#t=.5').clock.positionS).toBe(0.5)
    expect(readWebSettings('', '#t=1e2').clock.positionS).toBe(0)
  })

  it('refuses a dataset id that is not one, rather than putting it in an API path', () => {
    for (const bad of ['../secrets', 'a b', 'a/b', '', 'x'.repeat(129)]) {
      expect(readWebSettings(`?dataset=${encodeURIComponent(bad)}`, '').datasetId).toBeNull()
    }
  })

  it('reads the boolean flags with the grammar convention', () => {
    expect(readWebSettings('?debug', '').debug).toBe(true)
    expect(readWebSettings('?debug=yes', '').debug).toBe(true)
    expect(readWebSettings('?debug=0', '').debug).toBe(false)
    expect(readWebSettings('?debug=FALSE', '').debug).toBe(false)
    // Exactly `embedMode`'s reading, which does not trim: a padded zero
    // is not one of the two opt-outs.
    expect(readWebSettings('?debug=%200', '').debug).toBe(true)
  })

  it('reads the telemetry switch as off unless the address turns it on', () => {
    // Off by default: the page loads for everyone near a globe, with no
    // notice, so only an owner who chose to measure one turns it on.
    expect(readWebSettings('', '').telemetry).toBe(false)
    expect(readWebSettings('?telemetry=1', '').telemetry).toBe(true)
    expect(readWebSettings('?telemetry=TRUE', '').telemetry).toBe(true)
    // Unlike the other flags, a bare `telemetry` and anything but `1` or
    // `true` is off. Read the usual way, `off`, `no` and an empty value
    // would turn a privacy switch on.
    for (const off of ['0', 'false', 'off', 'no', '', '%201']) {
      expect(readWebSettings(`?telemetry=${off}`, '').telemetry).toBe(false)
    }
    expect(readWebSettings('?telemetry', '').telemetry).toBe(false)
    // The fragment replaces the query here as everywhere.
    expect(readWebSettings('?telemetry=1', '#telemetry=0').telemetry).toBe(false)
  })

  it('wraps a rotation past a full turn rather than refusing it', () => {
    expect(readWebSettings('?rotation=370', '').centreLonDeg).toBe(10)
  })
})

describe('rotation', () => {
  // The grammar says `rotation` is the longitude at the centre of the
  // picture. Checked through the shader's own mirror, because the
  // offset it feeds turns the picture east and the obvious mapping is
  // the wrong way round (found in review).
  it('puts the named longitude at the centre of the picture', () => {
    for (const lon of [0, 90, -90, 137.5, 180]) {
      const centre = readWebSettings(`?rotation=${lon}`, '').centreLonDeg
      const params = { ...IDENTITY_PARAMS, rotationOffsetRad: rotationOffsetRadFor(centre) }
      const sampled = equirectSourceUv(0.5, 0.5, params)
      // Source u is lon / 360 + 0.5; compared round the turn, since
      // 180 and -180 are one meridian.
      const sampledLon = (sampled.u - 0.5) * 360
      const apart = ((((sampledLon - lon) % 360) + 540) % 360) - 180
      expect(apart).toBeCloseTo(0, 9)
    }
  })
})

describe('defaultWebFramebufferWidth', () => {
  it('takes the narrowest rung that fills the page as displayed', () => {
    expect(defaultWebFramebufferWidth(1024)).toBe(1024)
    expect(defaultWebFramebufferWidth(1025)).toBe(2048)
    expect(defaultWebFramebufferWidth(1920)).toBe(2048)
    expect(defaultWebFramebufferWidth(2048)).toBe(2048)
  })

  it('never goes past the desktop default, and takes it when the size is unknown', () => {
    expect(defaultWebFramebufferWidth(5120)).toBe(4096)
    expect(defaultWebFramebufferWidth(0)).toBe(4096)
    expect(defaultWebFramebufferWidth(NaN)).toBe(4096)
  })
})

describe('the clock', () => {
  it('is a position, the moment it was current, and a rate', () => {
    expect(readWebSettings('', '#t=40.5&at=1761288000.25&rate=0.5').clock).toEqual({
      positionS: 40.5,
      atUnixS: 1761288000.25,
      rate: 0.5,
      paused: false,
    })
  })

  it('reads each key on its own, so one missing costs only itself', () => {
    // `paused` without a `t` used to be dropped with it, and the clip
    // played (found in review).
    expect(readWebSettings('', '#paused=1').clock).toEqual({ positionS: 0, atUnixS: null, rate: 1, paused: true })
    expect(readWebSettings('', '#rate=2').clock.rate).toBe(2)
    expect(readWebSettings('', '#at=1761288000').clock.atUnixS).toBe(1761288000)
    expect(readWebSettings('', '#t=nonsense&rate=2&paused=1').clock).toEqual({
      positionS: 0,
      atUnixS: null,
      rate: 2,
      paused: true,
    })
  })

  it('reads paused with the boolean convention', () => {
    expect(readWebSettings('', '#t=12&paused=1').clock.paused).toBe(true)
    expect(readWebSettings('', '#t=12&paused=0').clock.paused).toBe(false)
  })

  it('treats an empty or negative t as the start', () => {
    // Number('') is 0, which happens to be the default too; the point
    // is that neither is read as a deliberate value.
    expect(readWebSettings('', '#t=').clock.positionS).toBe(0)
    expect(readWebSettings('', '#t=-1').clock.positionS).toBe(0)
  })

  it('falls back to when this copy read it, for a missing or bad anchor', () => {
    expect(readWebSettings('', '#t=1').clock.atUnixS).toBeNull()
    expect(readWebSettings('', '#t=1&at=0').clock.atUnixS).toBeNull()
    expect(readWebSettings('', '#t=1&at=soon').clock.atUnixS).toBeNull()
  })

  it('falls back to rate 1 for a rate it will not play', () => {
    // The player's own limits less the trim's room: 16 itself left a
    // copy behind for good, 0.0625 seeked it every few seconds.
    expect(MIN_WEB_RATE).toBeCloseTo(1 / 12, 12)
    expect(MAX_WEB_RATE).toBeCloseTo(12.8, 12)
    for (const bad of ['0', '-1', 'fast', '16', '13', '0.0625', '0.08']) {
      expect(readWebSettings('', `#t=1&rate=${bad}`).clock.rate).toBe(1)
    }
    expect(readWebSettings('', '#t=1&rate=12.8').clock.rate).toBe(12.8)
    expect(readWebSettings('', '#t=1&rate=0.0834').clock.rate).toBe(0.0834)
  })

  it('tells a changed clock from one a # change left alone', () => {
    const a = readWebSettings('', '#t=40&debug=1').clock
    expect(sameClock(a, readWebSettings('', '#t=40&debug=0').clock)).toBe(true)
    expect(sameClock(a, readWebSettings('', '#t=41').clock)).toBe(false)
    expect(sameClock(a, readWebSettings('', '#t=40&paused=1').clock)).toBe(false)
  })
})
