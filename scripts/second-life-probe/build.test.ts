// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildProbeScript, embeddedLines, MAX_EMBEDDED_CHARACTERS, PAGE_MARKER, servedPage, unembeddable } from './build'

const read = (file: string): string =>
  readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const page = read('./probe.html')
const template = read('./probe.template.lsl')
const committed = read('./terraviz-probe.lsl')

describe('second-life probe kit', () => {
  it('commits exactly the script its template and page generate', () => {
    // The script is what someone pastes into a prim; a hand edit to it,
    // or a page change nobody regenerated, would go in-world untested.
    expect(committed).toBe(buildProbeScript(page, template))
  })

  it('serves exactly the tested page, line for line', () => {
    expect(servedPage(committed)).toBe(embeddedLines(page).map((l) => `${l}\n`).join(''))
  })

  it('holds a page with nothing an LSL string literal would need escaped', () => {
    expect(unembeddable(page)).toEqual([])
  })

  it('refuses a page that would need escaping, rather than escaping it', () => {
    expect(() => buildProbeScript('<p title="x">', template)).toThrow(/escaped/)
    expect(() => buildProbeScript('a\\b', template)).toThrow(/escaped/)
    expect(() => buildProbeScript('café', template)).toThrow(/escaped/)
  })

  it('carries dollar signs through as written', () => {
    // Each of these means something to String.replace in a replacement
    // string: the marker, a single $, the template before it, after it.
    const code = "<script>var r='$& $$ $` $';</script>"
    expect(unembeddable(code)).toEqual([])
    expect(servedPage(buildProbeScript(code, template))).toBe(`${code}\n`)
  })

  it('needs the marker exactly once', () => {
    expect(() => buildProbeScript('<p>', 'no marker')).toThrow(/exactly once/)
    expect(() => buildProbeScript('<p>', `${PAGE_MARKER}\n${PAGE_MARKER}`)).toThrow(/exactly once/)
  })

  it('reads Windows line endings as the same script', () => {
    const crlf = (s: string) => s.replace(/\n/g, '\r\n')
    expect(buildProbeScript(crlf(page), crlf(template))).toBe(committed)
  })

  it('ignores a byte-order mark rather than refusing or copying it', () => {
    // Saved invisibly by some Windows editors. Refused, it reads as a
    // mystery character on line 1; copied, it lands ahead of the SPDX line.
    expect(buildProbeScript(`\uFEFF${page}`, `\uFEFF${template}`)).toBe(committed)
  })

  it('keeps the embedded page small enough to build in a script', () => {
    const embedded = embeddedLines(page).reduce((sum, line) => sum + line.length + 1, 0)
    expect(embedded).toBeLessThanOrEqual(MAX_EMBEDDED_CHARACTERS)
  })

  it('never asks Second Life for media larger than it allows', () => {
    // llmediaentry.h caps shared media at 2048 a side, and a script that
    // asks for more gets LSL_STATUS_BOUNDS_ERROR rather than a smaller size.
    const size = (name: string) => Number(template.match(new RegExp(`integer ${name} = (\\d+);`))?.[1])
    expect(size('MEDIA_W')).toBeGreaterThan(0)
    expect(size('MEDIA_W')).toBeLessThanOrEqual(2048)
    expect(size('MEDIA_H')).toBeGreaterThan(0)
    expect(size('MEDIA_H')).toBeLessThanOrEqual(2048)
    expect(size('MEDIA_W')).toBe(2 * size('MEDIA_H'))
  })
})
