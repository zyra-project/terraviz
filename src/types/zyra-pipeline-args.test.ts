// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import {
  cycleStart,
  isoDurationSeconds,
  parsePlaceholder,
  renderArgPlaceholders,
  renderPipelineJson,
  validateArgPlaceholders,
} from './zyra-pipeline-args'

const CTX = { now: new Date('2026-07-24T13:07:00Z'), runId: '01HX0000000000000000000000' }

describe('isoDurationSeconds', () => {
  it('parses common durations', () => {
    expect(isoDurationSeconds('PT6H')).toBe(21_600)
    expect(isoDurationSeconds('PT5H')).toBe(18_000)
    expect(isoDurationSeconds('P1D')).toBe(86_400)
    expect(isoDurationSeconds('P1W')).toBe(604_800)
    expect(isoDurationSeconds('PT90M')).toBe(5_400)
  })
  it('rejects junk', () => {
    expect(isoDurationSeconds('6h')).toBeNull()
    expect(isoDurationSeconds('P')).toBeNull()
    expect(isoDurationSeconds('')).toBeNull()
  })
})

describe('cycleStart', () => {
  it('floors to the most recent available cycle', () => {
    // 13:07Z with 6h cycles and 5h lag: 13:07-5h = 08:07 → floor → 06:00.
    const c = cycleStart(CTX.now, 21_600, 18_000)
    expect(c.toISOString()).toBe('2026-07-24T06:00:00.000Z')
  })
  it('crosses the date boundary when the lag pushes it back', () => {
    // 03:00Z with 6h cycles and 5h lag: 22:00 previous day → 18:00 cycle.
    const c = cycleStart(new Date('2026-07-24T03:00:00Z'), 21_600, 18_000)
    expect(c.toISOString()).toBe('2026-07-23T18:00:00.000Z')
  })
})

describe('parsePlaceholder / validateArgPlaceholders', () => {
  it('accepts the vocabulary', () => {
    expect(parsePlaceholder('run_date')).toEqual({ name: 'run_date' })
    expect(parsePlaceholder('cycle_date:PT6H:PT5H')).toEqual({
      name: 'cycle_date',
      intervalSeconds: 21_600,
      lagSeconds: 18_000,
    })
  })
  it('rejects unknown names, missing params, bad durations', () => {
    expect(typeof parsePlaceholder('tomorrow')).toBe('string')
    expect(typeof parsePlaceholder('cycle_date')).toBe('string')
    expect(typeof parsePlaceholder('cycle_hour:6h:5h')).toBe('string')
    expect(typeof parsePlaceholder('run_date:PT1H:PT1H')).toBe('string')
  })
  it('takes an optional offset on the valid-time pair only', () => {
    expect(parsePlaceholder('valid_iso:PT6H:PT7H')).toEqual({
      name: 'valid_iso',
      intervalSeconds: 21_600,
      lagSeconds: 25_200,
    })
    expect(parsePlaceholder('valid_iso:PT6H:PT7H:PT42H')).toEqual({
      name: 'valid_iso',
      intervalSeconds: 21_600,
      lagSeconds: 25_200,
      offsetSeconds: 151_200,
    })
    // cycle_date names the cycle itself — an offset there would be
    // silently meaningless, so it is an error rather than ignored.
    expect(typeof parsePlaceholder('cycle_date:PT6H:PT5H:PT42H')).toBe('string')
    expect(typeof parsePlaceholder('valid_iso:PT6H:PT7H:42h')).toBe('string')
    expect(typeof parsePlaceholder('valid_iso:PT6H')).toBe('string')
    // Four params is past the arity of anything in the vocabulary.
    expect(typeof parsePlaceholder('valid_iso:PT6H:PT7H:PT1H:PT2H')).toBe('string')
  })
  it('scopes the vocabulary to the caller', () => {
    // Same syntax, different name sets: data_start is a metadata
    // variable and means nothing in a pipeline arg, and vice versa.
    expect(typeof parsePlaceholder('data_start')).toBe('string')
    expect(parsePlaceholder('data_start', ['data_start'])).toEqual({ name: 'data_start' })
    expect(typeof parsePlaceholder('cycle_date:PT6H:PT5H', ['data_start'])).toBe('string')
  })
  it('rejects unterminated or mismatched braces', () => {
    // matchAll() sees no complete placeholder here; the residual-brace
    // check must catch it or the literal leaks into a URL.
    expect(validateArgPlaceholders('https://x/gefs.{{cycle_date:PT6H:PT5H/f000.grib2')).toHaveLength(1)
    expect(validateArgPlaceholders('stray }} closer')).toHaveLength(1)
    expect(validateArgPlaceholders('{{run_date}} then {{broken')).toHaveLength(1)
    // Single braces are ordinary characters.
    expect(validateArgPlaceholders('a{b}c')).toEqual([])
  })

  it('collects errors from a URL-shaped string', () => {
    const errors = validateArgPlaceholders(
      'https://x/gefs.{{cycle_date:PT6H:PT5H}}/{{cycle_hr}}/f000.grib2',
    )
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('cycle_hr')
  })

  it('separates an unknown name from a malformed one', () => {
    // A client can act on these differently — "did you mean…" for a
    // typo'd name, "check the parameters" for the rest — so they must
    // not arrive under one code.
    const code = (v: string) => validateArgPlaceholders(v).map(e => e.code)
    expect(code('{{cycle_hr:PT6H:PT5H}}')).toEqual(['unknown_placeholder'])
    // Known name, wrong arity / bad duration / stray braces are all
    // "the name was fine, the rest was not".
    expect(code('{{cycle_date}}')).toEqual(['invalid_placeholder'])
    expect(code('{{cycle_date:6h:5h}}')).toEqual(['invalid_placeholder'])
    expect(code('{{valid_iso:PT6H:PT7H:42h}}')).toEqual(['invalid_placeholder'])
    expect(code('stray }} closer')).toEqual(['invalid_placeholder'])
    // The vocabulary decides "unknown", so the same body is classified
    // differently depending on which surface is asking.
    expect(validateArgPlaceholders('{{data_start}}').map(e => e.code)).toEqual([
      'unknown_placeholder',
    ])
    expect(validateArgPlaceholders('{{data_start}}', ['data_start'])).toEqual([])
  })
})

describe('renderArgPlaceholders', () => {
  it('renders a dated URL', () => {
    const url = renderArgPlaceholders(
      'https://noaa-gefs-pds.s3.amazonaws.com/gefs.{{cycle_date:PT6H:PT5H}}/{{cycle_hour:PT6H:PT5H}}/chem/f000.grib2',
      CTX,
    )
    expect(url).toBe('https://noaa-gefs-pds.s3.amazonaws.com/gefs.20260724/06/chem/f000.grib2')
  })
  it('renders run vars', () => {
    expect(renderArgPlaceholders('{{run_date}}/{{run_id}}', CTX)).toBe(
      '2026-07-24/01HX0000000000000000000000',
    )
  })
  it('renders valid times relative to the cycle', () => {
    // 13:07Z, 6-hourly cycles, 7h lag -> the 06:00Z cycle. f000 is
    // valid at the cycle; f042 is 42h past it, two days on.
    expect(renderArgPlaceholders('{{valid_iso:PT6H:PT7H}}', CTX)).toBe('2026-07-24T06:00:00Z')
    expect(renderArgPlaceholders('{{valid_iso:PT6H:PT7H:PT42H}}', CTX)).toBe(
      '2026-07-26T00:00:00Z',
    )
    // No colons, no dashes: what Zyra's %Y%m%dT%H%M%S parses back.
    expect(renderArgPlaceholders('{{valid_compact:PT6H:PT7H:PT6H}}', CTX)).toBe('20260724T120000')
  })
  it('names frames by valid time for --output-names', () => {
    // The pairing this exists for: the source URL carries the
    // cycle-relative name, the output carries the valid time.
    const pipeline = JSON.stringify({
      stages: [
        {
          stage: 'process',
          command: 'convert-format',
          args: {
            inputs: [
              'https://x/gefs.{{cycle_date:PT6H:PT7H}}/{{cycle_hour:PT6H:PT7H}}/chem/f000.grib2',
              'https://x/gefs.{{cycle_date:PT6H:PT7H}}/{{cycle_hour:PT6H:PT7H}}/chem/f006.grib2',
            ],
            output_names: [
              '{{valid_compact:PT6H:PT7H}}.tif',
              '{{valid_compact:PT6H:PT7H:PT6H}}.tif',
            ],
          },
        },
      ],
    })
    const args = JSON.parse(renderPipelineJson(pipeline, CTX)).stages[0].args
    expect(args.inputs[0]).toBe('https://x/gefs.20260724/06/chem/f000.grib2')
    expect(args.output_names).toEqual(['20260724T060000.tif', '20260724T120000.tif'])
  })
  it('throws on malformed placeholders', () => {
    expect(() => renderArgPlaceholders('{{cycle_date}}', CTX)).toThrow(/requires interval/)
  })
  it('throws on unterminated braces instead of passing them through', () => {
    expect(() => renderArgPlaceholders('https://x/{{cycle_date:PT6H:PT5H', CTX)).toThrow(
      /Unterminated or mismatched/,
    )
  })
})

describe('renderPipelineJson', () => {
  it('renders strings and array elements, leaves numbers alone', () => {
    const pipeline = JSON.stringify({
      stages: [
        {
          stage: 'process',
          command: 'decode-grib2',
          args: {
            file_or_url: 'https://x/gefs.{{cycle_date:PT6H:PT5H}}/f000.grib2',
            raw: true,
          },
        },
        {
          stage: 'process',
          command: 'reproject',
          args: { dst_bounds: [-180, -90, 180, 90], width: 2048 },
        },
      ],
    })
    const rendered = JSON.parse(renderPipelineJson(pipeline, CTX))
    expect(rendered.stages[0].args.file_or_url).toBe('https://x/gefs.20260724/f000.grib2')
    expect(rendered.stages[1].args.dst_bounds).toEqual([-180, -90, 180, 90])
  })
  it('names the offending stage on failure', () => {
    const pipeline = JSON.stringify({
      stages: [{ stage: 'acquire', command: 'http', args: { url: '{{bogus}}' } }],
    })
    expect(() => renderPipelineJson(pipeline, CTX)).toThrow(/stages\[0\].args.url/)
  })
})
