// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import {
  MAX_WEB_RATE,
  MIN_WEB_RATE,
  defaultWebFramebufferWidth,
  mergedParams,
  readWebSettings,
  sameClock,
  sameView,
} from './webMode'
import { MAX_CAMERA_OFFSET, MAX_CAMERA_ZOOM, equirectSourceUv } from './equirectRtt'
import { viewParams } from './webCamera'

describe('readWebSettings', () => {
  it('reads nothing from a bare address: the idle Earth, letterboxed, on its own clock', () => {
    expect(readWebSettings('', '')).toEqual({
      datasetId: null,
      fit: 'contain',
      framebufferWidth: null,
      view: { latDeg: 0, lonDeg: 0, zoom: 0 },
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
    expect(s.view.lonDeg).toBe(270)
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
    expect(s.view.lonDeg).toBe(0)
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
    expect(readWebSettings('?rotation=370', '').view.lonDeg).toBe(10)
  })
})

/** What the picture shows at output `(u, v)` for this address, through
 *  the shader's own mirror. */
function shownAt(hash: string, u: number, v: number): { lat: number; lon: number } {
  const sampled = equirectSourceUv(u, v, viewParams(readWebSettings('', hash).view))
  return { lat: (sampled.v - 0.5) * 180, lon: (sampled.u - 0.5) * 360 }
}

/** Two longitudes apart, round the turn: 180 and -180 are one meridian. */
function lonApart(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180
}

describe('the camera', () => {
  // The grammar says `rotation` is the longitude at the centre of the
  // picture and `lat` its latitude. Checked through the shader's own
  // mirror, because an offset that turns the picture east makes the
  // obvious mapping the wrong way round (found in review of `rotation`).
  it('puts the named longitude at the centre of the picture', () => {
    for (const lon of [0, 90, -90, 137.5, 180]) {
      const shown = shownAt(`#rotation=${lon}`, 0.5, 0.5)
      expect(shown.lat).toBeCloseTo(0, 9)
      expect(lonApart(shown.lon, lon)).toBeCloseTo(0, 9)
    }
  })

  it('puts the named latitude there too, north up', () => {
    for (const [lat, lon] of [[-60, 30], [45, -120], [10, 180]]) {
      const shown = shownAt(`#lat=${lat}&rotation=${lon}`, 0.5, 0.5)
      expect(shown.lat).toBeCloseTo(lat, 9)
      expect(lonApart(shown.lon, lon)).toBeCloseTo(0, 9)
      // Up the picture is north, on the same meridian.
      const above = shownAt(`#lat=${lat}&rotation=${lon}`, 0.5, 0.51)
      expect(above.lat).toBeGreaterThan(lat)
      expect(lonApart(above.lon, lon)).toBeCloseTo(0, 6)
    }
  })

  it('brings a pole to the centre on the rotation meridian: up from the South Pole, down from the North', () => {
    // The ozone hole on the equator, in front of whoever faces the centre.
    for (const lon of [0, 90, 200]) {
      expect(shownAt(`#lat=-90&rotation=${lon}`, 0.5, 0.5).lat).toBeCloseTo(-90, 9)
      const above = shownAt(`#lat=-90&rotation=${lon}`, 0.5, 0.52)
      expect(above.lat).toBeGreaterThan(-90)
      expect(lonApart(above.lon, lon)).toBeCloseTo(0, 6)
      // At the North Pole the named meridian runs down the picture, and
      // the one opposite it up, as on the app's globe at a bearing of 0.
      const below = shownAt(`#lat=90&rotation=${lon}`, 0.5, 0.48)
      expect(below.lat).toBeLessThan(90)
      expect(lonApart(below.lon, lon)).toBeCloseTo(0, 6)
      const northAbove = shownAt(`#lat=90&rotation=${lon}`, 0.5, 0.52)
      expect(lonApart(northAbove.lon, lon + 180)).toBeCloseTo(0, 6)
    }
  })

  it('magnifies the centre for a zoom, and keeps the whole Earth', () => {
    const span = (hash: string): number => shownAt(hash, 0.5, 0.505).lat - shownAt(hash, 0.5, 0.495).lat
    expect(span('#lat=-60&zoom=2')).toBeLessThan(span('#lat=-60') / 2)
    // Still the named place at the centre.
    expect(shownAt('#lat=-60&rotation=30&zoom=2', 0.5, 0.5).lat).toBeCloseTo(-60, 9)
    // The far side shrinks rather than going: the frame's edge still
    // shows the antipode of the centre.
    const far = shownAt('#lat=0&rotation=0&zoom=2', 0, 0.5)
    expect(Math.abs(lonApart(far.lon, 180))).toBeLessThan(1e-6)
  })

  it('reads a zoom past what the projection can magnify as that most', () => {
    // So a move between two zooms past it is no motion at all, and a
    // number too big to move toward cannot reach the motion.
    expect(MAX_CAMERA_ZOOM).toBeCloseTo(1 / (1 - MAX_CAMERA_OFFSET) - 1, 12)
    expect(viewParams({ latDeg: 0, lonDeg: 0, zoom: MAX_CAMERA_ZOOM }).cameraOffset.x).toBeCloseTo(MAX_CAMERA_OFFSET, 12)
    expect(readWebSettings('', '#zoom=12').view.zoom).toBe(MAX_CAMERA_ZOOM)
    // Finite, so a plain decimal, and big enough to overflow the motion.
    expect(readWebSettings('', `#zoom=${'9'.repeat(308)}`).view.zoom).toBe(MAX_CAMERA_ZOOM)
    expect(sameView(readWebSettings('', '#zoom=12').view, readWebSettings('', '#zoom=20').view)).toBe(true)
    expect(readWebSettings('', '#zoom=2.5').view.zoom).toBe(2.5)
  })

  it('fails closed one key at a time', () => {
    expect(readWebSettings('', '#lat=91&rotation=30&zoom=2').view).toEqual({ latDeg: 0, lonDeg: 30, zoom: 2 })
    expect(readWebSettings('', '#lat=-30&zoom=-1').view).toEqual({ latDeg: -30, lonDeg: 0, zoom: 0 })
    expect(readWebSettings('', '#lat=south&zoom=1e1').view).toEqual({ latDeg: 0, lonDeg: 0, zoom: 0 })
    expect(readWebSettings('', '#lat=-90&zoom=0').view).toEqual({ latDeg: -90, lonDeg: 0, zoom: 0 })
    // A `-0` is the default, so a bare address and `lat=-0` are one view.
    expect(sameView(readWebSettings('', '#lat=-0&zoom=-0').view, readWebSettings('', '').view)).toBe(true)
    expect(Object.is(readWebSettings('', '#lat=-0').view.latDeg, 0)).toBe(true)
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
