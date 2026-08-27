// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the executors behind Orbit's value answers.
 *
 * Two things are load-bearing and neither is obvious from reading the
 * happy path:
 *
 *   1. **The availability gate.** These tools exist to let Orbit state
 *      numbers, and the prompt otherwise forbids exactly that. If the
 *      gate leaks — a picture dataset, a browser with no WebGL2, a
 *      dataset mid-load — the tools are offered with nothing behind
 *      them, and the failure mode is Orbit confidently answering from
 *      training-time knowledge. So the gate is asserted, not assumed.
 *   2. **Absent data must not read as a low value.** A smoke field is
 *      mostly empty; a `noData` point that returns `vmin` produces "the
 *      smoke there is very light" for somewhere the dataset says
 *      nothing at all.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  executeFindExtremum,
  executeProbeValue,
  executeSummarizeRegion,
  analysisAvailability,
  isAnalysisAvailable,
  registerAnalysisSource,
  valuesQuestionKind,
  type DocentAnalysisSource,
} from './docentAnalysisTools'
import type { LumaSnapshot } from './glLumaSampler'
import type { ColorScale, DatasetOverlayOptions } from '../types'
import { logger } from '../utils/logger'

/** vmin 0 / vmax 255 makes luma and value numerically equal, so an
 *  expectation can be read straight off the fixture. */
const SCALE: ColorScale = {
  stops: [
    { t: 0, rgba: [0, 0, 0, 0] },
    { t: 1, rgba: [255, 255, 255, 255] },
  ],
  vmin: 0,
  vmax: 255,
  units: 'mg m-2',
  transparentRange: 12 / 256,
}

/** The bbox the live RRFS rows carry. */
const OPTIONS: DatasetOverlayOptions = {
  boundingBox: { n: 85, s: 5, w: -175, e: -20 },
  colorScale: SCALE,
}

function snap(w: number, h: number, fill: (x: number, y: number) => number): LumaSnapshot {
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fill(x, y)
  return { data, width: w, height: h }
}

function makeSource(over: Partial<DocentAnalysisSource> = {}): DocentAnalysisSource {
  return {
    frame: () => ({ snapshot: snap(8, 8, () => 200), scale: SCALE, options: OPTIONS }),
    datasetTitle: () => 'Wildfire Smoke Overhead',
    visibleBounds: () => ({ n: 85, s: 5, w: -175, e: -20 }),
    ...over,
  }
}

beforeEach(() => registerAnalysisSource(null))

describe('isAnalysisAvailable', () => {
  it('is false with nothing registered', () => {
    expect(isAnalysisAvailable()).toBe(false)
  })

  it('is false for a dataset with no frame — a picture, or no WebGL2', () => {
    // The single call covers every reason: a picture row has no
    // colorScale, a browser without WebGL2 has no sampler, and a
    // dataset mid-load has no decoded frame. All three arrive here as
    // a null frame.
    registerAnalysisSource(makeSource({ frame: () => null }))
    expect(isAnalysisAvailable()).toBe(false)
  })

  it('is true once a data-encoded frame is readable', () => {
    registerAnalysisSource(makeSource())
    expect(isAnalysisAvailable()).toBe(true)
  })

  it('is false rather than throwing when the source is mid-teardown', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerAnalysisSource(makeSource({ frame: () => { throw new Error('renderer gone') } }))
    expect(isAnalysisAvailable()).toBe(false)
    warn.mockRestore()
  })

  it('every executor refuses when unavailable, not just the gate', () => {
    // Belt and braces: the gate keeps the tools out of the array, but
    // a model that calls one anyway (a stale tool id in history, a
    // provider replaying a call) must not reach a null frame.
    registerAnalysisSource(null)
    expect(executeProbeValue({ lat: 40, lon: -105 }).ok).toBe(false)
    expect(executeSummarizeRegion({}).ok).toBe(false)
    expect(executeFindExtremum({}).ok).toBe(false)
  })
})

describe('executeProbeValue', () => {
  it('reports the value at a point inside coverage', () => {
    registerAnalysisSource(makeSource())
    const r = executeProbeValue({ lat: 45, lon: -100 })
    expect(r.ok).toBe(true)
    expect(r.value).toBeCloseTo(200, 6)
    expect(r.units).toBe('mg m-2')
    expect(r.dataset).toBe('Wildfire Smoke Overhead')
    expect(r.precision).toMatch(/quantised/i)
  })

  it('distinguishes "no data here" from "outside coverage"', () => {
    // Two different sentences. Absent data inside the box is a real
    // answer about a covered place; outside the box the dataset has no
    // opinion at all, and conflating them tells a user the field is
    // empty somewhere it was never measured.
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(8, 8, () => 0), scale: SCALE, options: OPTIONS }),
    }))
    const inside = executeProbeValue({ lat: 45, lon: -100 })
    expect(inside.ok).toBe(true)
    expect(inside.noData).toBe(true)

    const outside = executeProbeValue({ lat: -45, lon: -100 })
    expect(outside.ok).toBe(false)
    expect(outside.error).toMatch(/coverage/i)
  })

  it('rejects a missing or unparseable coordinate', () => {
    registerAnalysisSource(makeSource())
    expect(executeProbeValue({}).ok).toBe(false)
    expect(executeProbeValue({ lat: 'north', lon: -100 }).ok).toBe(false)
  })

  it('rounds to three significant digits, like the hover readout', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({
        snapshot: snap(1, 1, () => 137),
        scale: { ...SCALE, vmax: 1 },
        options: { ...OPTIONS, colorScale: { ...SCALE, vmax: 1 } },
      }),
    }))
    const r = executeProbeValue({ lat: 45, lon: -100 })
    // 137/255 = 0.537254901…; the transport cannot resolve past the
    // third digit, so neither does the answer.
    expect(r.value).toBeCloseTo(0.537, 9)
  })
})

describe('executeSummarizeRegion', () => {
  it('summarises the whole dataset by default', () => {
    registerAnalysisSource(makeSource())
    const r = executeSummarizeRegion({})
    expect(r.ok).toBe(true)
    expect(r.region).toMatch(/whole dataset/i)
    expect(r.mean).toBeCloseTo(200, 6)
    expect(r.coverage).toBeCloseTo(1, 6)
  })

  it('narrows to a named region from the same table Orbit already uses', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({
        snapshot: snap(8, 8, (_x, y) => (y < 4 ? 240 : 40)),
        scale: SCALE,
        options: OPTIONS,
      }),
    }))
    const whole = executeSummarizeRegion({})
    const alaska = executeSummarizeRegion({ region_name: 'alaska' })
    expect(alaska.ok).toBe(true)
    expect(alaska.region).toBe('Alaska')
    expect(alaska.mean).not.toBeCloseTo(whole.mean!, 6)
  })

  it('errors on a region it cannot place, rather than answering about everywhere', () => {
    // The quietly wrong alternative: fall back to the whole dataset and
    // return statistics labelled with a region they do not describe.
    registerAnalysisSource(makeSource())
    const r = executeSummarizeRegion({ region_name: 'Mordor' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/unknown region/i)
    expect(r.mean).toBeUndefined()
  })

  it('accepts an explicit bbox', () => {
    registerAnalysisSource(makeSource())
    const r = executeSummarizeRegion({ bbox: { north: 60, south: 40, west: -120, east: -90 } })
    expect(r.ok).toBe(true)
    expect(r.mean).toBeCloseTo(200, 6)
  })

  it('says so in prose when coverage is too low for a bare mean', () => {
    // A mean over 6% of a box is a different claim from a mean over all
    // of it, and the model needs words it can repeat, not a flag.
    registerAnalysisSource(makeSource({
      frame: () => ({
        snapshot: snap(4, 4, (x, y) => (x === 0 && y === 0 ? 200 : 0)),
        scale: SCALE,
        options: OPTIONS,
      }),
    }))
    const r = executeSummarizeRegion({})
    expect(r.ok).toBe(true)
    expect(r.coverage).toBeCloseTo(0.0625, 4)
    expect(r.caveat).toMatch(/6%/)
  })

  it('reports an empty region as empty rather than as zero', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 0), scale: SCALE, options: OPTIONS }),
    }))
    const r = executeSummarizeRegion({})
    expect(r.ok).toBe(false)
    expect(r.mean).toBeUndefined()
  })
})

describe('executeFindExtremum', () => {
  it('locates the maximum and says where it is', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({
        snapshot: snap(8, 8, (x, y) => (x === 6 && y === 1 ? 250 : 100)),
        scale: SCALE,
        options: OPTIONS,
      }),
    }))
    const r = executeFindExtremum({ kind: 'max' })
    expect(r.ok).toBe(true)
    expect(r.value).toBeCloseTo(250, 6)
    // Inside the dataset's own box, which is the only claim worth
    // pinning — the exact lat/lon is datasetProbe's contract, tested
    // there against its inverse.
    expect(r.lat!).toBeGreaterThan(5)
    expect(r.lat!).toBeLessThan(85)
    expect(r.lon!).toBeGreaterThan(-175)
    expect(r.lon!).toBeLessThan(-20)
    expect(r.precision).toMatch(/quantised/i)
  })

  it('finds the minimum among data, not the absent band', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({
        snapshot: snap(8, 8, (x, y) => (x === 2 && y === 2 ? 30 : x < 4 ? 0 : 150)),
        scale: SCALE,
        options: OPTIONS,
      }),
    }))
    const r = executeFindExtremum({ kind: 'min' })
    expect(r.ok).toBe(true)
    expect(r.value).toBeCloseTo(30, 6)
  })

  it('defaults to the maximum, which is what the question usually means', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({
        snapshot: snap(4, 4, (x) => (x === 0 ? 20 : 220)),
        scale: SCALE,
        options: OPTIONS,
      }),
    }))
    expect(executeFindExtremum({}).value).toBeCloseTo(220, 6)
  })

  it('scopes to a named region', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({
        snapshot: snap(16, 16, (_x, y) => (y < 4 ? 250 : 90)),
        scale: SCALE,
        options: OPTIONS,
      }),
    }))
    const r = executeFindExtremum({ kind: 'max', region_name: 'mexico' })
    expect(r.ok).toBe(true)
    expect(r.region).toBe('Mexico')
    // Mexico is far south of the hot northern band, so the scoped
    // maximum must be the cooler value — proof the window was applied
    // rather than ignored.
    expect(r.value).toBeCloseTo(90, 6)
  })
})

describe('saying what the number is of', () => {
  it('carries the frame time, because these are animations', () => {
    // Without it, "the smoke is worst at 47.5N" is a claim about an
    // unnamed instant of an 85-frame forecast.
    registerAnalysisSource(makeSource())
    const t = 'Jul 28, 2026 at 12:00 PM'
    expect(executeProbeValue({ lat: 45, lon: -100 }, t).frameTime).toBe(t)
    expect(executeSummarizeRegion({}, t).frameTime).toBe(t)
    expect(executeFindExtremum({}, t).frameTime).toBe(t)
  })

  it('omits the time rather than inventing one when there is none', () => {
    registerAnalysisSource(makeSource())
    expect(executeFindExtremum({}, null).frameTime).toBeUndefined()
    expect(executeFindExtremum({}).frameTime).toBeUndefined()
  })

  it('names the region on every scoped answer', () => {
    // The live failure: find_extremum scoped to a region, and the
    // answer read as a whole-dataset claim because the region was
    // never mentioned.
    registerAnalysisSource(makeSource())
    expect(executeFindExtremum({ region_name: 'mexico' }).region).toBe('Mexico')
    expect(executeFindExtremum({}).region).toMatch(/whole dataset/i)
  })

  it('flags an extremum that is clipping at the top of the scale', () => {
    // A max of exactly vmax means the field saturates there — a floor,
    // not a measurement. Quoting it as exact overstates the encoding.
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 255), scale: SCALE, options: OPTIONS }),
    }))
    const r = executeFindExtremum({ kind: 'max' })
    expect(r.value).toBeCloseTo(255, 6)
    expect(r.saturated).toMatch(/at least/i)
  })

  it('says nothing about saturation for an unclipped field', () => {
    registerAnalysisSource(makeSource())
    expect(executeFindExtremum({ kind: 'max' }).saturated).toBeUndefined()
  })

  it('never flags a minimum as saturated', () => {
    // vmin is the bottom of the scale, and the no-data band already
    // covers "nothing here" — a min is not a clipped reading.
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 255), scale: SCALE, options: OPTIONS }),
    }))
    expect(executeFindExtremum({ kind: 'min' }).saturated).toBeUndefined()
  })
})

describe('coordinates', () => {
  it('keeps a western longitude precise, not rounded to significant figures', () => {
    // Three significant figures turns -119.53 into -120 — half a
    // degree, about 50 km — while leaving -9.53 alone. Precision that
    // varies with magnitude is not precision.
    registerAnalysisSource(makeSource())
    const r = executeProbeValue({ lat: 47.531, lon: -119.534 })
    expect(r.lon).toBeCloseTo(-119.534, 9)
    expect(r.lat).toBeCloseTo(47.531, 9)
  })

  it('keeps the sign, which is the whole difference between Washington and China', () => {
    registerAnalysisSource(makeSource())
    const r = executeProbeValue({ lat: 47.5, lon: -119.5 })
    expect(r.lon).toBe(-119.5)
    expect(r.lon).toBeLessThan(0)
  })

  it('reports the extremum’s position without magnitude-dependent rounding', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({
        snapshot: snap(64, 64, (x, y) => (x === 40 && y === 20 ? 250 : 100)),
        scale: SCALE,
        options: OPTIONS,
      }),
    }))
    const r = executeFindExtremum({ kind: 'max' })
    // Inside the dataset box, and carrying more than three significant
    // figures of longitude.
    expect(r.lon!).toBeLessThan(0)
    expect(Math.abs(r.lon! - Math.round(r.lon!))).toBeGreaterThan(0)
  })
})

describe('units travel joined to the number', () => {
  // Live failure: a column-integrated dataset in kg m-2 was reported as
  // "150 micrograms per cubic metre" — a concentration unit belonging to
  // the near-surface dataset the same reply recommended. `units` as a
  // separate field lost to a unit the model had seen a thousand times
  // for smoke, so the value now arrives pre-joined and quotable.
  const COLUMN: ColorScale = { ...SCALE, vmax: 5e-4, units: 'kg m-2' }
  const COLUMN_OPTS: DatasetOverlayOptions = { ...OPTIONS, colorScale: COLUMN }

  it('joins value and units for a probe', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 128), scale: COLUMN, options: COLUMN_OPTS }),
    }))
    const r = executeProbeValue({ lat: 45, lon: -100 })
    expect(r.valueText).toBe(`${r.value} kg m-2`)
    expect(r.valueText).not.toMatch(/microgram|µg|per cubic/i)
  })

  it('joins the mean for a region', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 128), scale: COLUMN, options: COLUMN_OPTS }),
    }))
    const r = executeSummarizeRegion({})
    expect(r.meanText).toBe(`${r.mean} kg m-2`)
  })

  it('folds the clipping caveat into the quotable string', () => {
    // So "at least" is not something the model has to remember to add.
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 255), scale: COLUMN, options: COLUMN_OPTS }),
    }))
    const r = executeFindExtremum({ kind: 'max' })
    expect(r.valueText).toMatch(/^at least /)
    expect(r.valueText).toContain('kg m-2')
  })

  it('says "at least" only when the field is actually clipping', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 100), scale: COLUMN, options: COLUMN_OPTS }),
    }))
    expect(executeFindExtremum({ kind: 'max' }).valueText).not.toMatch(/at least/)
  })

  it('omits units cleanly for a scale that carries none', () => {
    const bare: ColorScale = { ...COLUMN, units: undefined }
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 128), scale: bare, options: { ...OPTIONS, colorScale: bare } }),
    }))
    const r = executeProbeValue({ lat: 45, lon: -100 })
    expect(r.valueText).toBe(String(r.value))
    expect(r.valueText).not.toContain('undefined')
  })
})

describe('a value is attributed to the dataset it was measured from', () => {
  // The two shipped smoke rows share a bounding box exactly, so a
  // mix-up is invisible in the coordinates — but one is a column
  // loading in kg m-2 and the other a near-surface concentration in
  // kg m-3, three orders of magnitude apart. Reporting one under the
  // other's name is the worst available outcome: right place, right
  // grid, wrong quantity, and nothing on screen contradicting it.
  const COLUMN: ColorScale = { ...SCALE, vmax: 5e-4, units: 'kg m-2' }
  const COLUMN_OPTS: DatasetOverlayOptions = {
    boundingBox: { n: 85, s: 5, w: -175, e: -20 },
    colorScale: COLUMN,
    datasetId: 'INTERNAL_SMOKE_COLUMN',
    datasetTitle: 'Wildfire Smoke Overhead',
  }

  it('names the frame’s dataset, not whatever app state believes', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 128), scale: COLUMN, options: COLUMN_OPTS }),
      // App state has drifted onto the sibling row — the exact
      // divergence a multi-globe layout or a mid-load switch produces.
      datasetTitle: () => 'RRFS Smoke — Near-Surface, North America',
    }))
    expect(executeProbeValue({ lat: 45, lon: -100 }).dataset).toBe('Wildfire Smoke Overhead')
    expect(executeSummarizeRegion({}).dataset).toBe('Wildfire Smoke Overhead')
    expect(executeFindExtremum({}).dataset).toBe('Wildfire Smoke Overhead')
  })

  it('reports the units of the frame it measured', () => {
    // The units come from the frame's own scale, so they cannot drift
    // apart from the name now that both ride the same options object.
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 128), scale: COLUMN, options: COLUMN_OPTS }),
      datasetTitle: () => 'RRFS Smoke — Near-Surface, North America',
    }))
    const r = executeProbeValue({ lat: 45, lon: -100 })
    expect(r.units).toBe('kg m-2')
    expect(r.valueText).toContain('kg m-2')
    expect(r.valueText).not.toContain('m-3')
  })

  it('falls back to app state for a frame with no stamp', () => {
    // Options built before identity was stamped still get a name
    // rather than none.
    registerAnalysisSource(makeSource())
    expect(executeProbeValue({ lat: 45, lon: -100 }).dataset).toBe('Wildfire Smoke Overhead')
  })
})

describe('an extremum carries the scope it was found in', () => {
  // Live failure: "the worst smoke is at 47.5N 119.5W, 0.00023 kg m-2"
  // came back for a frame whose real maximum was more than twice that
  // and elsewhere — the model had narrowed the search and said nothing,
  // so a regional answer read as a claim about the whole dataset. A
  // prompt rule already asked for the region to be named and did not
  // survive the sentence. So the scope rides inside the quotable string:
  // dropping it now means dropping the number too.
  it('says so when the search covered the whole dataset', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 100), scale: SCALE, options: OPTIONS }),
    }))
    expect(executeFindExtremum({ kind: 'max' }).valueText)
      .toBe('100 mg m-2, the highest anywhere in the whole dataset')
  })

  it('names the region when the search was narrowed to one', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(64, 64, () => 100), scale: SCALE, options: OPTIONS }),
    }))
    const r = executeFindExtremum({ kind: 'max', region_name: 'gulf of mexico' })
    // The table's spelling, not the caller's — the chip, the panel and
    // the sentence all have to agree on which box was measured.
    expect(r.valueText).toContain('the highest anywhere in Gulf of Mexico')
    expect(r.valueText).not.toContain('the whole dataset')
  })

  it('distinguishes a view-scoped search from a dataset-wide one', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(64, 64, () => 100), scale: SCALE, options: OPTIONS }),
      visibleBounds: () => ({ n: 50, s: 30, w: -125, e: -100 }),
    }))
    expect(executeFindExtremum({ kind: 'max', region: 'view' }).valueText)
      .toContain('the highest anywhere in the current view')
  })

  it('reads as a minimum when asked for one', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 100), scale: SCALE, options: OPTIONS }),
    }))
    expect(executeFindExtremum({ kind: 'min' }).valueText)
      .toBe('100 mg m-2, the lowest anywhere in the whole dataset')
  })

  it('keeps the clipping caveat and the scope in one sentence', () => {
    // Both caveats are structural, so neither can be dropped without
    // the other — "at least X, the highest anywhere in Y" is the whole
    // claim, and it is one string.
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 255), scale: SCALE, options: OPTIONS }),
    }))
    const r = executeFindExtremum({ kind: 'max' })
    expect(r.valueText).toBe('at least 255 mg m-2, the highest anywhere in the whole dataset')
  })
})

describe('the globe gets asked whether it agrees', () => {
  // Reported live: an extremum whose coordinates, probed by hand on the
  // globe, read "No data". The reducer and the coordinate mapping are
  // both right — their composition is unit-tested across five bbox
  // shapes in datasetStats.test.ts — so the divergence has to be the
  // snapshot and the renderer's probe holding different state. Nothing
  // was comparing them, so it took a person pointing at the globe.
  // `vi.spyOn` hands back the *same* spy on a second call, so without
  // the clear the counts accumulate across tests in this block and
  // every assertion after the first one is really asserting history.
  const warn = () => vi.spyOn(logger, 'warn').mockImplementation(() => {}).mockClear()

  it('says nothing when the two paths agree', () => {
    const spy = warn()
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 200), scale: SCALE, options: OPTIONS }),
      probeAt: () => ({ value: 200, noData: false }),
    }))
    expect(executeFindExtremum({ kind: 'max' }).ok).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('warns when the probe reports no data where the answer points', () => {
    // The exact live symptom.
    const spy = warn()
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 200), scale: SCALE, options: OPTIONS }),
      probeAt: () => ({ value: 0, noData: true }),
    }))
    const r = executeFindExtremum({ kind: 'max' })
    // Still answers — an unverifiable location beats no answer, as long
    // as it is not silent.
    expect(r.ok).toBe(true)
    expect(spy).toHaveBeenCalledOnce()
    expect(String(spy.mock.calls[0][0])).toMatch(/globe disagrees/i)
    expect(String(spy.mock.calls[0][0])).toMatch(/no data/i)
  })

  it('warns when the probe reports a different value there', () => {
    const spy = warn()
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 200), scale: SCALE, options: OPTIONS }),
      probeAt: () => ({ value: 12, noData: false }),
    }))
    executeFindExtremum({ kind: 'max' })
    expect(spy).toHaveBeenCalledOnce()
  })

  it('tolerates a disagreement inside one quantisation step', () => {
    // The two paths read the same byte through different transports;
    // one luma step apart is the transport, not a bug, and warning on
    // it would train the reader to ignore the warning.
    const spy = warn()
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 200), scale: SCALE, options: OPTIONS }),
      probeAt: () => ({ value: 200.9, noData: false }),
    }))
    executeFindExtremum({ kind: 'max' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('skips the check for a host that cannot probe', () => {
    const spy = warn()
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 200), scale: SCALE, options: OPTIONS }),
    }))
    expect(executeFindExtremum({ kind: 'max' }).ok).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('the gate says which way it went', () => {
  // Reported live: no measurement card on a build that renders them.
  // The cards were fine; the tools had never been offered, and nothing
  // said so — Orbit answered about values from somewhere else and the
  // reply looked measured. A closed gate is correct behaviour. Closing
  // silently is what cost the debugging round.
  it('names a missing registration', () => {
    registerAnalysisSource(null)
    expect(analysisAvailability()).toEqual({ available: false, reason: 'no-source-registered' })
  })

  it('distinguishes a registered source with no readable frame', () => {
    // A picture dataset, a browser with no WebGL2, a dataset mid-load —
    // and, most likely in production today, a globe whose earth layer
    // was never built because the basemap host stalled (#337), so the
    // renderer never assigned a probe source.
    registerAnalysisSource(makeSource({ frame: () => null }))
    expect(analysisAvailability()).toEqual({ available: false, reason: 'no-frame' })
  })

  it('reports a source that throws separately from one that declines', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {}).mockClear()
    registerAnalysisSource(makeSource({ frame: () => { throw new Error('renderer gone') } }))
    expect(analysisAvailability()).toEqual({ available: false, reason: 'source-threw' })
    expect(warn).toHaveBeenCalled()
  })

  it('is available with a readable frame', () => {
    registerAnalysisSource(makeSource())
    expect(analysisAvailability()).toEqual({ available: true, reason: 'ok' })
  })

  it('keeps isAnalysisAvailable in step with it', () => {
    // Two readings of one fact; drift either way is a bug.
    for (const src of [null, makeSource({ frame: () => null }), makeSource()]) {
      registerAnalysisSource(src)
      expect(isAnalysisAvailable()).toBe(analysisAvailability().available)
    }
  })
})

describe('valuesQuestionKind', () => {
  // Biased toward missing a question rather than answering the wrong
  // one: a false negative leaves the model to call the tool, which is
  // the status quo. A false positive measures something nobody asked
  // about and moves the globe for it.
  it('catches the superlative phrasings people actually type', () => {
    for (const q of [
      'Where is the smoke worst?',
      'where is it highest',
      'Where is the smoke the most intense right now?',
      'which region has the peak values',
      'where is the maximum',
    ]) expect(valuesQuestionKind(q)).toBe('max')
  })

  it('catches the other end too', () => {
    for (const q of ['where is it lowest', 'Where is the air cleanest?', 'which area is the least affected']) {
      expect(valuesQuestionKind(q)).toBe('min')
    }
  })

  it('declines anything that is not a where-question about an extreme', () => {
    for (const q of [
      'what does this dataset show?',
      'how much smoke is over Colorado?',
      'what is the average',
      'tell me about wildfire smoke',
      'load the near-surface dataset',
      'is this the worst fire season on record?', // about history, not the frame
    ]) expect(valuesQuestionKind(q)).toBeNull()
  })
})
