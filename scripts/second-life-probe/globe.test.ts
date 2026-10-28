// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAX_WEB_RATE, MIN_WEB_RATE, readWebSettings } from '../../src/output/webMode'

// LSL compiles only in-world, so nothing here runs the script. These
// tests hold what it writes to what the output page reads, which is the
// part that can drift without anyone in Second Life noticing: a renamed
// key, a value the page no longer takes or a narrowed range leaves every
// globe quietly showing a default. A change in what a value *means* is
// not caught here; that is the grammar's v2 rule.

const read = (file: string): string =>
  readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** A global's initial value, as written. */
function constant(script: string, type: string, name: string): string {
  const value = script.match(new RegExp(`^${type}\\s+${name}\\s*=\\s*([^;]+);`, 'm'))?.[1]
  expect(value, `${type} ${name}`).toBeDefined()
  return (value as string).trim()
}

/** One LSL function's body: from its signature to the brace closing it at column 0. */
function body(script: string, signature: string): string {
  const start = script.indexOf(`\n${signature}\n{`)
  expect(start, signature).toBeGreaterThan(-1)
  return script.slice(start, script.indexOf('\n}\n', start))
}

/** The string literals in some LSL source. */
const literals = (source: string): string[] => [...source.matchAll(/"([^"]*)"/g)].map((m) => m[1])

/** The `key=value` segments in some literals; a value is empty where the script appends one. */
const segments = (source: string): Array<{ key: string; value: string }> =>
  literals(source)
    .flatMap((literal) => literal.split('&'))
    .filter((segment) => segment.includes('='))
    .map((segment) => ({ key: segment.slice(0, segment.indexOf('=')), value: segment.slice(segment.indexOf('=') + 1) }))

const BARE = readWebSettings('', '')
const ID = '01KQG611HF8YXJNRBEHT0757KT'

// Both globe scripts write the page's address, and the exhibit's globe
// script is the smoke test's core, so every check here holds for both.
// `own` is what one writes after the # and the other doesn't: the
// exhibit's sound, which the smoke test leaves to the page's silent
// default. `commands` is the script that hears the owner's chat: the
// smoke test's globe itself, and the exhibit's owner script, which holds
// the channel and the dataset names for the exhibit's globe.
const GLOBES = [
  { name: 'smoke-test', file: './terraviz-globe.lsl', commands: './terraviz-globe.lsl', own: [] as string[] },
  {
    name: 'exhibit',
    file: '../second-life-exhibit/terraviz-exhibit.lsl',
    commands: '../second-life-exhibit/terraviz-exhibit-owner.lsl',
    own: ['sound'],
  },
]
/** Every key some globe writes and not every one does. */
const OWN = new Set(GLOBES.flatMap((g) => g.own))

describe.each(GLOBES)('second-life $name globe script', ({ file, commands, own }) => {
  const globe = read(file)
  const chat = read(commands)
  const address = body(globe, 'string address()')
  /** What address() puts before the #: the lines that build `setup`. */
  const setupSegments = segments(address.split('\n').filter((line) => /\bsetup\b/.test(line)).join('\n'))
  /** What it puts after: the lines that build `live`. */
  const liveSegments = segments(address.split('\n').filter((line) => /\blive\b/.test(line)).join('\n'))
  const setupKeys = setupSegments.map((s) => s.key)
  const liveKeys = liveSegments.map((s) => s.key)

  it('listens on a channel no other script of the kit uses', () => {
    // An owner's /7 reaches every object of theirs listening on 7, so a
    // globe on the probe's channel would act on the probe's commands.
    const chan = constant(chat, 'integer', 'CHAN')
    expect(chan).not.toBe(constant(read('./probe.template.lsl'), 'integer', 'CHAN'))
    expect(chan).not.toBe(constant(read('./node-check.lsl'), 'integer', 'CHAN'))
    for (const other of GLOBES.filter((g) => g.file !== file)) {
      expect(chan, other.name).not.toBe(constant(read(other.commands), 'integer', 'CHAN'))
    }
  })

  it('writes exactly these keys, and the page acts on each one', () => {
    // Pinned, so a key added to the script has to be added here, with a
    // sample the page must act on where the script appends the value.
    const samples: Record<string, string> = {
      fit: 'fill',
      width: '1024',
      telemetry: '1',
      dataset: ID,
      t: '61.2',
      paused: '1',
      at: '1792865189.482',
      rate: '2',
      rotation: '90',
      debug: '1',
      sound: '1',
    }
    const written = segments(address)
    const expected = Object.keys(samples).filter((key) => !OWN.has(key) || own.includes(key))
    expect(new Set(written.map((s) => s.key))).toEqual(new Set(expected))
    for (const { key, value } of written) {
      // A value written as a literal is checked as written: `telemetry=on`
      // would read as off, and so would `paused=yes` in a page that
      // stopped taking it.
      const sample = value === '' ? samples[key] : value
      expect(readWebSettings(`?${key}=${sample}`, ''), `${key}=${sample}`).not.toEqual(BARE)
      expect(readWebSettings('', `#${key}=${sample}`), `#${key}=${sample}`).not.toEqual(BARE)
    }
  })

  it('puts only what the page needs at load before the #', () => {
    // Everything before the # reloads every copy when it changes, and a
    // measured globe must not reload (docs/PRIVACY.md). telemetry has to
    // be there, since the page counts its minute from when it loaded.
    expect(new Set(setupKeys)).toEqual(new Set(['fit', 'telemetry']))
    expect(new Set(liveKeys)).toEqual(new Set(['dataset', 't', 'paused', 'at', 'rate', 'width', 'rotation', 'debug', ...own]))
    // Every key written lands in one half or the other, once: a key on a
    // line naming neither, a continuation of `setup` say, would slip
    // past both lists above.
    expect(setupSegments.length + liveSegments.length).toBe(segments(address).length)
    expect(setupKeys.filter((key) => liveKeys.includes(key))).toEqual([])
    // Something always follows the #: the rotation and width go in
    // unconditionally, so no change can drop the fragment and reload.
    expect(address).toMatch(/^ {4}live \+= \["width=" \+ \(string\)gWidth, "rotation=" \+ num\(gRotation\)\];$/m)
  })

  it('composes addresses the page reads as meant', () => {
    // The shapes address() builds: setup in the query, the session after the #.
    const playing = readWebSettings(
      '?fit=fill&telemetry=1',
      `#dataset=${ID}&t=61.2&at=1792865189.482&rate=2&width=2048&rotation=90&debug=1`,
    )
    expect(playing).toEqual({
      datasetId: ID,
      fit: 'fill',
      framebufferWidth: 2048,
      view: { latDeg: 0, lonDeg: 90, zoom: 0 },
      debug: true,
      telemetry: true,
      sound: false,
      clock: { positionS: 61.2, atUnixS: 1792865189.482, rate: 2, paused: false },
    })

    const paused = readWebSettings('?fit=fill', `#dataset=${ID}&t=30.5&paused=1&width=2048&rotation=0`)
    expect(paused.clock).toEqual({ positionS: 30.5, atUnixS: null, rate: 1, paused: true })
    expect(paused.telemetry).toBe(false)
    expect(paused.debug).toBe(false)

    // "/8 steer query" joins the two halves with & instead of #.
    const steered = readWebSettings(`?fit=fill&dataset=${ID}&t=61.2&at=1792865189.482&width=2048&rotation=90`, '')
    const hashed = readWebSettings('?fit=fill', `#dataset=${ID}&t=61.2&at=1792865189.482&width=2048&rotation=90`)
    expect(steered).toEqual(hashed)

    const earth = readWebSettings('?fit=fill', '#width=2048&rotation=0')
    expect(earth.datasetId).toBeNull()
  })

  it('keeps its rates inside what the page plays, at the three decimal places it writes', () => {
    // The page reads a rate outside its range as 1, so a limit that
    // rounds outside it would quietly play at normal speed.
    for (const name of ['MIN_RATE', 'MAX_RATE']) {
      const written = Number(Number(constant(globe, 'float', name)).toFixed(3))
      expect(written, name).toBeGreaterThanOrEqual(MIN_WEB_RATE)
      expect(written, name).toBeLessThanOrEqual(MAX_WEB_RATE)
      expect(readWebSettings('', `#rate=${written}`).clock.rate, name).toBe(written)
    }
  })

  it('accepts exactly the dataset ids the page does', () => {
    // A character the script lets through and the page refuses turns
    // every visitor's globe to the live Earth; one the script refuses
    // and the page takes is a dataset the owner cannot show.
    const chars = JSON.parse(constant(globe, 'string', 'ID_CHARS')) as string
    const pageTakes = (id: string) => readWebSettings(`?dataset=${encodeURIComponent(id)}`, '').datasetId === id
    const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i))
    expect(new Set(chars)).toEqual(new Set(printable.filter(pageTakes)))
    const max = Number(constant(globe, 'integer', 'ID_MAX'))
    expect(pageTakes('A'.repeat(max))).toBe(true)
    expect(pageTakes('A'.repeat(max + 1))).toBe(false)
    // And the check uses them, rather than a number of its own.
    const check = body(globe, 'integer isId(string s)')
    expect(check).toContain('n > ID_MAX')
    expect(check).toContain('llSubStringIndex(ID_CHARS,')
    expect(check).not.toMatch(/n > \d/)
  })

  it('knows presets by lowercase names, with ids the page accepts', () => {
    // The listener lowercases the name it looks up, and keeps an id's case.
    const presets = literals(chat.match(/^list PRESETS = \[([\s\S]*?)\];/m)?.[1] ?? '')
    expect(presets.length % 3).toBe(0)
    expect(presets.length).toBeGreaterThan(0)
    const names: string[] = []
    for (let i = 0; i < presets.length; i += 3) {
      const [name, id] = presets.slice(i, i + 2)
      expect(name).toBe(name.toLowerCase())
      expect(name).not.toMatch(/\s/)
      expect(readWebSettings(`?dataset=${id}`, '').datasetId, name).toBe(id)
      names.push(name)
    }
    expect(new Set(names).size).toBe(names.length)
  })

  it('never asks Second Life for media larger than it allows', () => {
    const size = (name: string) => Number(constant(globe, 'integer', name))
    expect(size('MEDIA_W')).toBeGreaterThan(0)
    expect(size('MEDIA_W')).toBeLessThanOrEqual(2048)
    expect(size('MEDIA_W')).toBe(2 * size('MEDIA_H'))
  })

  it('gives no one the media to click', () => {
    // A visitor who can interact can navigate the face, and a viewer
    // broadcasts that navigation to everyone near the globe
    // (docs/SECOND_LIFE_COMPAT.md section 7, item 4). The permissions
    // go with every call, in the one list the call sends, since a face
    // given only an address takes defaults that let anyone click.
    const media = body(globe, 'integer setMedia()')
    const sent = media.match(/list p = \[([\s\S]*?)\];/)?.[1] ?? ''
    expect(sent).toContain('PRIM_MEDIA_PERMS_INTERACT, PRIM_MEDIA_PERM_NONE')
    expect(sent).toContain('PRIM_MEDIA_PERMS_CONTROL, PRIM_MEDIA_PERM_NONE')
    expect(sent).toContain('PRIM_MEDIA_CURRENT_URL, url')
    // Nothing chooses what goes: no condition before the call.
    const call = media.indexOf('llSetPrimMediaParams(FACE, p)')
    expect(call).toBeGreaterThan(-1)
    expect(media.slice(0, call)).not.toMatch(/\bif\b|\bp \+=/)
  })
})
