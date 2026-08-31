// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * CSV export for the Analyze panel.
 *
 * The numbers on screen are a summary; the export is the evidence. It
 * carries the full 256-bin distribution alongside the summary
 * statistics, because a histogram is the one artefact here that cannot
 * be reconstructed from the tiles — and because someone checking a
 * claim about a field wants the distribution, not a mean.
 *
 * The header block records what the numbers are *of*: the dataset, the
 * region, the units, and the quantisation step. A CSV that says
 * "mean, 0.000123" and nothing else is unfalsifiable a week later.
 *
 * `buildCsvText` is pure so the format is testable without a DOM. The
 * serialisation rules match `src/ui/publisher/analytics-charts.ts`
 * (RFC-4180, CRLF, quote only when needed) rather than importing it —
 * that module is publisher-portal-scoped.
 */

import {
  LUMA_LEVELS,
  type LumaHistogram,
  type RegionStats,
  type TransectSample,
  type ZonalSample,
} from '../services/datasetStats'
import { lumaToValue } from '../types/color-scale'
import type { DisplayColorScale } from '../types/unit-scale'

type Cell = string | number | null | undefined

function cell(value: Cell): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function rows(list: readonly Cell[][]): string {
  return list.map((r) => r.map(cell).join(',')).join('\r\n')
}

export interface CsvContext {
  datasetTitle: string | null
  scopeLabel: string
}

/**
 * The unit rows every export shares.
 *
 * `source_units` appears only when the scale was restated for
 * readability — `units, µg m-3` over a dataset the publisher stored as
 * `kg m-3`. The file is the artefact somebody checks a claim against a
 * week later, quite possibly against the model output itself, and the
 * two are the same measurement only if the file says so.
 */
function unitRows(scale: DisplayColorScale): Cell[][] {
  const list: Cell[][] = [['units', scale.units ?? '']]
  if (scale.sourceUnits) list.push(['source_units', scale.sourceUnits])
  return list
}

/**
 * Serialise a summary plus its distribution.
 *
 * Values are written at full precision rather than the three
 * significant digits the panel displays: the rounding is a presentation
 * choice about what is *legible*, and re-imposing it here would destroy
 * information the file exists to carry. The quantisation step is in the
 * header so a reader can see how much of that precision is real.
 */
export function buildCsvText(
  stats: RegionStats,
  hist: LumaHistogram,
  scale: DisplayColorScale,
  ctx: CsvContext,
): string {
  const step = Math.abs(scale.vmax - scale.vmin) / 255
  const head: Cell[][] = [
    ['dataset', ctx.datasetTitle ?? ''],
    ['region', ctx.scopeLabel],
    ...unitRows(scale),
    ['value_min', scale.vmin],
    ['value_max', scale.vmax],
    ['quantisation_step', step],
    [],
    ['statistic', 'value'],
    ['mean', stats.mean],
    ['median', stats.median],
    ['min', stats.min],
    ['max', stats.max],
    ['p10', stats.p10],
    ['p90', stats.p90],
    ['std_dev', stats.stdDev],
    ['area_km2', stats.areaKm2],
    ['texels_with_data', stats.count],
    ['texels_examined', stats.examined],
    ['coverage_fraction', stats.coverage],
    [],
    ['value', 'area_km2', 'texel_count'],
  ]

  const bins: Cell[][] = []
  for (let luma = 0; luma < LUMA_LEVELS; luma++) {
    // Absent-data codes carry no area by construction; emitting them
    // would put rows in the file that the statistics above excluded.
    if (hist.weights[luma] <= 0) continue
    bins.push([lumaToValue(luma, scale), hist.weights[luma], hist.counts[luma]])
  }

  return `${rows(head)}\r\n${rows(bins)}\r\n`
}

/**
 * Serialise a transect: one row per sample, in order along the line.
 *
 * Absent samples are kept with an empty value rather than dropped. A
 * reader reconstructing the profile needs to know the line crossed a
 * hole there — removing the row would close the gap silently, which is
 * the same failure the chart takes care to avoid.
 *
 * `sample_spacing_km` is in the header because it is the resolution
 * claim: the samples are placed one per grid cell crossed, so a reader
 * can see that a bump narrower than that spacing is not resolved.
 */
export function buildTransectCsvText(
  samples: readonly TransectSample[],
  scale: DisplayColorScale,
  ctx: CsvContext,
): string {
  const step = Math.abs(scale.vmax - scale.vmin) / 255
  const total = samples.length > 0 ? samples[samples.length - 1].distanceKm : 0
  const withData = samples.reduce((n, s) => n + (s.value == null ? 0 : 1), 0)
  const head: Cell[][] = [
    ['dataset', ctx.datasetTitle ?? ''],
    ['region', ctx.scopeLabel],
    ...unitRows(scale),
    ['value_min', scale.vmin],
    ['value_max', scale.vmax],
    ['quantisation_step', step],
    ['length_km', total],
    ['samples', samples.length],
    ['samples_with_data', withData],
    ['sample_spacing_km', samples.length > 1 ? total / (samples.length - 1) : 0],
    [],
    ['distance_km', 'lat', 'lon', 'value'],
  ]
  const body = samples.map((s): Cell[] => [s.distanceKm, s.lat, s.lon, s.value])
  return `${rows(head)}\r\n${rows(body)}\r\n`
}

/**
 * Serialise a zonal profile: one row per image row, north to south.
 *
 * Rows with no data are kept with an empty mean, for the same reason
 * absent transect samples are — a latitude band nothing was measured at
 * is a fact about the field, and dropping the row would let a reader
 * join two latitudes that are not neighbours.
 *
 * `texel_count` rides along per row because it is what makes a mean
 * interpretable: near a pole, or at the edge of a region, a row can be
 * a handful of texels wide, and a mean over four texels does not
 * deserve the same weight as one over four thousand. The chart cannot
 * show that; the file can.
 */
export function buildZonalCsvText(
  samples: readonly ZonalSample[],
  scale: DisplayColorScale,
  ctx: CsvContext,
): string {
  const step = Math.abs(scale.vmax - scale.vmin) / 255
  const withData = samples.reduce((n, s) => n + (s.mean == null ? 0 : 1), 0)
  const head: Cell[][] = [
    ['dataset', ctx.datasetTitle ?? ''],
    ['region', ctx.scopeLabel],
    ...unitRows(scale),
    ['value_min', scale.vmin],
    ['value_max', scale.vmax],
    ['quantisation_step', step],
    ['rows', samples.length],
    ['rows_with_data', withData],
    [],
    ['lat', 'mean', 'texel_count'],
  ]
  const body = samples.map((s): Cell[] => [s.lat, s.mean, s.count])
  return `${rows(head)}\r\n${rows(body)}\r\n`
}

/** Trigger a browser download. No-op-safe outside a DOM. */
export function downloadCsv(filename: string, text: string): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
