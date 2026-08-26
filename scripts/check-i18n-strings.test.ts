// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { scanFile } from './check-i18n-strings'

function tmpFile(name: string, contents: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'terraviz-i18n-strings-'))
  mkdirSync(dir, { recursive: true })
  const path = resolve(dir, name)
  writeFileSync(path, contents, 'utf-8')
  return path
}

describe('check-i18n-strings · scanFile', () => {
  it('flags a hard-coded textContent assignment', () => {
    const path = tmpFile(
      'a.ts',
      `el.textContent = 'Submit form'\n`,
    )
    const violations = scanFile(path)
    expect(violations.length).toBe(1)
    expect(violations[0]?.literal).toBe('Submit form')
    expect(violations[0]?.line).toBe(1)
  })

  it('flags placeholder, title, alt, innerText assignments', () => {
    const path = tmpFile(
      'b.ts',
      [
        `el.placeholder = 'Search datasets'`,
        `el.title = 'Open settings'`,
        `el.alt = 'Globe icon'`,
        `el.innerText = 'Loading data'`,
      ].join('\n') + '\n',
    )
    const violations = scanFile(path)
    expect(violations.length).toBe(4)
  })

  it('flags setAttribute(aria-label, …) with English prose', () => {
    const path = tmpFile(
      'c.ts',
      `el.setAttribute('aria-label', 'Close dialog')\n`,
    )
    const violations = scanFile(path)
    expect(violations.length).toBe(1)
    expect(violations[0]?.literal).toBe('Close dialog')
  })

  it('respects an inline `i18n-exempt:` comment', () => {
    const path = tmpFile(
      'd.ts',
      `el.textContent = 'FPS metric' // i18n-exempt: debug HUD\n`,
    )
    const violations = scanFile(path)
    expect(violations).toEqual([])
  })

  it('rejects a bare `i18n-exempt` marker with no colon (reason missing)', () => {
    // The "mandatory reason" convention is enforced here, not just
    // documented. A bare marker without `:` doesn't count.
    const path = tmpFile(
      'd2.ts',
      `el.textContent = 'Submit form' // i18n-exempt\n`,
    )
    const violations = scanFile(path)
    expect(violations.length).toBe(1)
  })

  it('rejects `i18n-exempt:` with no rationale after it (empty reason)', () => {
    // Colon present, but nothing after — still no reason, still
    // flagged. Stops drive-by exemption stamps.
    const path = tmpFile(
      'd3.ts',
      `el.textContent = 'Submit form' // i18n-exempt:\n`,
    )
    const violations = scanFile(path)
    expect(violations.length).toBe(1)
  })

  it('skips literals routed through t()', () => {
    const path = tmpFile(
      'e.ts',
      `el.textContent = t('app.title')\n`,
    )
    const violations = scanFile(path)
    expect(violations).toEqual([])
  })

  it('skips template-literal assignments (interpolation handled separately)', () => {
    const path = tmpFile(
      'f.ts',
      'el.textContent = `${count} items found`\n',
    )
    const violations = scanFile(path)
    expect(violations).toEqual([])
  })

  it('skips HTML-bearing literals (markup-template scope deferred)', () => {
    const path = tmpFile(
      'g.ts',
      `el.innerHTML = '<div class="foo">Hello world</div>'\n`,
    )
    const violations = scanFile(path)
    expect(violations).toEqual([])
  })

  it('skips literals that are only locale-key-shaped', () => {
    const path = tmpFile(
      'h.ts',
      `el.textContent = 'app.title'\n`,
    )
    const violations = scanFile(path)
    expect(violations).toEqual([])
  })

  it('skips literals that have no spaces', () => {
    const path = tmpFile(
      'i.ts',
      `el.placeholder = 'searchPlaceholder'\n`,
    )
    const violations = scanFile(path)
    expect(violations).toEqual([])
  })

  // --- Canvas `fillText` heuristic (VR / AR modules) ---
  //
  // The VR HUD, controller tooltips, tour overlay, and loading
  // scene all paint user-visible text onto a CanvasRenderingContext2D.
  // The DOM-property heuristics can't see those — the fillText
  // regex covers them.

  it('flags a hard-coded ctx.fillText(literal, ...) call', () => {
    const path = tmpFile(
      'j.ts',
      `ctx.fillText('Loading question', x, y)\n`,
    )
    const violations = scanFile(path)
    expect(violations.length).toBe(1)
    expect(violations[0]?.literal).toBe('Loading question')
  })

  it('flags fillText on alternate context-variable names', () => {
    // Real VR call sites sometimes use `c` or `context` rather than
    // the conventional `ctx`. The heuristic intentionally accepts
    // any identifier before `.fillText(`.
    const path = tmpFile(
      'j2.ts',
      [
        `c.fillText('Drag to rotate', 0, 0)`,
        `context.fillText('Pinch to zoom', 0, 0)`,
      ].join('\n') + '\n',
    )
    const violations = scanFile(path)
    expect(violations.length).toBe(2)
  })

  it('skips fillText literals routed through t()', () => {
    const path = tmpFile(
      'k.ts',
      `ctx.fillText(t('vr.hud.exit'), x, y)\n`,
    )
    const violations = scanFile(path)
    expect(violations).toEqual([])
  })

  it('skips fillText with a runtime variable (not a string literal)', () => {
    // Dataset titles, dynamic FPS counters, etc. — caller is
    // responsible for routing the runtime value through t() at
    // the point where the value originates, not at the canvas.
    const path = tmpFile(
      'l.ts',
      `ctx.fillText(title, x, y)\n`,
    )
    const violations = scanFile(path)
    expect(violations).toEqual([])
  })

  it('skips fillText literals that are symbol-only (no English prose)', () => {
    // Glyphs / emoji used as iconography, not language. Pass the
    // same English-prose gate as the DOM checks above.
    const path = tmpFile(
      'm.ts',
      [
        `ctx.fillText('✕', x, y)`,
        `ctx.fillText('\u{1F30D}', x, y)`,
        `ctx.fillText('…', x, y)`,
      ].join('\n') + '\n',
    )
    const violations = scanFile(path)
    expect(violations).toEqual([])
  })

  it('skips a single-word fillText literal (consistent with DOM heuristic)', () => {
    // The existing DOM heuristic requires `[A-Za-z]{3,}.* ` — at
    // least one space after the prose run. Single-word canvas
    // labels ("Continue", "Exit") fall through the same gap. If
    // this changes in a future scope widening, both heuristics
    // should move together.
    const path = tmpFile(
      'n.ts',
      `ctx.fillText('Continue', x, y)\n`,
    )
    const violations = scanFile(path)
    expect(violations).toEqual([])
  })

  it('respects `i18n-exempt:` on a fillText call', () => {
    const path = tmpFile(
      'o.ts',
      `ctx.fillText('FPS metric', x, y) // i18n-exempt: debug HUD\n`,
    )
    const violations = scanFile(path)
    expect(violations).toEqual([])
  })
})
