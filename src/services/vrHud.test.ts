// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, afterEach, vi } from 'vitest'
import * as THREE from 'three'
import { createVrHud, hudActionAt, voiceCaption, type VrHudState } from './vrHud'

const BASE: VrHudState = {
  datasetTitle: 'Sea Surface Temperature',
  isPlaying: false,
  hasVideo: true,
  isMuted: true,
  panelCount: 1,
  primaryIndex: 0,
  browseOpen: false,
}

const at = (state: VrHudState, u: number) => hudActionAt(state, { x: u, y: 0.5 })

describe('hudActionAt', () => {
  it('lays the bar out as play, mute, title, mic, browse, exit', () => {
    const state = { ...BASE, voice: { phase: 'idle' as const, caption: '' } }
    expect(at(state, 0.06)).toBe('play-pause')
    expect(at(state, 0.18)).toBe('mute')
    expect(at(state, 0.4)).toBeNull() // the title
    expect(at(state, 0.65)).toBe('voice')
    expect(at(state, 0.79)).toBe('browse')
    expect(at(state, 0.93)).toBe('exit-vr')
  })

  it('gives the mic band back to the title when voice is unavailable', () => {
    expect(at({ ...BASE, voice: null }, 0.65)).toBeNull()
    expect(at(BASE, 0.65)).toBeNull()
    // Browse and exit don't move with it.
    expect(at(BASE, 0.79)).toBe('browse')
    expect(at(BASE, 0.93)).toBe('exit-vr')
  })

  it('has no playback buttons for an image dataset', () => {
    const image = { ...BASE, hasVideo: false }
    expect(at(image, 0.06)).toBeNull()
    expect(at(image, 0.18)).toBeNull()
  })

  it('ignores a hit outside the bar', () => {
    expect(hudActionAt(BASE, { x: 0.93, y: 1.2 })).toBeNull()
    expect(hudActionAt(BASE, { x: 0.93, y: -0.1 })).toBeNull()
  })
})

describe('voiceCaption', () => {
  it('hides the strip when voice is unavailable or has nothing to say', () => {
    expect(voiceCaption(null)).toBeNull()
    expect(voiceCaption(undefined)).toBeNull()
    expect(voiceCaption({ phase: 'idle', caption: '' })).toBeNull()
  })

  it('prompts before anything is heard, then shows the transcript', () => {
    expect(voiceCaption({ phase: 'listening', caption: '' })).toEqual({
      label: 'Listening…',
      text: 'Ask Orbit about the data, then tap the mic to send.',
    })
    expect(voiceCaption({ phase: 'listening', caption: 'where is the ozone hole' })?.text)
      .toBe('where is the ozone hole')
  })

  it('shows the question while Orbit thinks and the sentence while it speaks', () => {
    expect(voiceCaption({ phase: 'thinking', caption: 'where is the ozone hole' }))
      .toEqual({ label: 'Thinking…', text: 'where is the ozone hole' })
    expect(voiceCaption({ phase: 'speaking', caption: 'Over Antarctica.' }))
      .toEqual({ label: 'Orbit', text: 'Over Antarctica.' })
  })

  it('keeps a finished reply up while it lingers, and says when hearing failed', () => {
    expect(voiceCaption({ phase: 'idle', caption: 'Over Antarctica.' }))
      .toEqual({ label: 'Orbit', text: 'Over Antarctica.' })
    expect(voiceCaption({ phase: 'error', caption: '' })?.text)
      .toBe('Couldn’t hear that. Tap the mic to try again.')
  })
})

describe('caption strip text', () => {
  /** Text column of the caption canvas: 1024 px less 28 px padding each side. */
  const COLUMN = 968
  /** Every character 20 px wide, so a line holds 48 of them. */
  const CHAR = 20
  const URL = 'https://example.org/datasets/sea-surface-temperature/monthly-anomaly/2024/september'
  const JAPANESE = '北極の海氷は毎年九月に最小になります。夏の融解期が終わると再び広がり、三月ごろに最大となります。近年はその面積が小さくなっています。観測が始まった一九七九年以降、九月の海氷面積は十年あたり約一割のペースで減少しています。'

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * Draw `text` as a spoken caption through the real `createVrHud`
   * and return the lines it put on the caption canvas. The canvas
   * stub measures text in proportion to its character count.
   */
  function captionLinesDrawn(text: string): string[] {
    const drawn: string[] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      // The caption has its own canvas, 192 px tall; the bar's is 256.
      const isCaption = this.height === 192
      const props: Record<PropertyKey, unknown> = {}
      return new Proxy(props, {
        get(target, prop) {
          if (prop in target) return target[prop]
          if (prop === 'measureText') return (s: string) => ({ width: s.length * CHAR })
          // x = 28 is the text column; the label above it is drawn there
          // too, on the first row (y = 34).
          if (prop === 'fillText') return (s: string, _x: number, y: number) => { if (isCaption && y > 34) drawn.push(s) }
          return () => {}
        },
        set(target, prop, value) {
          target[prop] = value
          return true
        },
      }) as never
    })
    const hud = createVrHud(THREE)
    hud.setState({ ...BASE, voice: { phase: 'speaking', caption: text } })
    hud.dispose()
    return drawn
  }

  const width = (line: string) => line.length * CHAR

  it('leaves a caption that fits on one line alone', () => {
    expect(captionLinesDrawn('Over Antarctica.')).toEqual(['Over Antarctica.'])
  })

  it('wraps onto a second line and ends with an ellipsis when the text runs over', () => {
    const lines = captionLinesDrawn(
      'Sea ice in the Arctic reaches its smallest extent every September, after the summer melt, and then grows back through the winter until March.',
    )
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('Sea ice in the Arctic reaches its smallest')
    expect(lines[1]!.endsWith('…')).toBe(true)
    for (const line of lines) expect(width(line)).toBeLessThanOrEqual(COLUMN)
  })

  it('shortens a word too long for the column instead of running off the canvas', () => {
    expect(width(URL)).toBeGreaterThan(COLUMN)
    const lines = captionLinesDrawn(`${URL} has the data.`)
    expect(lines).toHaveLength(2)
    expect(lines[0]!.startsWith('https://example.org/')).toBe(true)
    expect(lines[0]!.endsWith('…')).toBe(true)
    expect(lines[1]).toBe('has the data.')
    for (const line of lines) expect(width(line)).toBeLessThanOrEqual(COLUMN)
  })

  it('breaks text written without spaces by character, so it fills both lines', () => {
    expect(JAPANESE).not.toMatch(/s/)
    expect(JAPANESE.length).toBeGreaterThan(96) // more than two full lines
    const lines = captionLinesDrawn(JAPANESE)
    expect(lines).toHaveLength(2)
    // The first line is full, and the second carries on from it.
    expect(lines[0]).toBe(JAPANESE.slice(0, 48))
    expect(lines[1]!.startsWith(JAPANESE.slice(48, 60))).toBe(true)
    expect(lines[1]!.endsWith('…')).toBe(true)
    for (const line of lines) expect(width(line)).toBeLessThanOrEqual(COLUMN)
  })

  it('gives a short text without spaces a single line', () => {
    expect(captionLinesDrawn('北極の海氷')).toEqual(['北極の海氷'])
  })
})
