// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { until } from '../test-utils'
import type { KioskView } from '../ui/kioskUI'
import { KioskDataError, type KioskDataset, type KioskWhen } from './kioskModel'
import { createKioskPage, KIOSK_LENGTH_RETRIES, KIOSK_RETRY_DELAYS_MS } from './kioskPage'
import type { WebClock } from './webMode'

const clock = (over: Partial<WebClock> = {}): WebClock => ({ positionS: 0, atUnixS: null, rate: 1, paused: false, ...over })

const dataset = (id: string, over: Partial<KioskDataset> = {}): KioskDataset => ({
  id,
  title: `Title ${id}`,
  abstract: [],
  thumbnail: null,
  legend: null,
  credit: '',
  license: '',
  licenseText: '',
  kind: 'video',
  startTime: new Date('2024-01-01T00:00:00Z'),
  endTime: new Date('2024-01-11T00:00:00Z'),
  period: 'P1D',
  frameCount: null,
  lengthS: 100,
  retryS: 0,
  ...over,
})

/** A page over fake time, a fake screen, and reads the test settles by hand. */
function harness() {
  const shown: KioskView[] = []
  const whens: KioskWhen[] = []
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
  const reads: { id: string; resolve: (ds: KioskDataset) => void; reject: (e: unknown) => void }[] = []
  const logs: string[] = []
  let now = Date.UTC(2026, 9, 28, 12)
  const page = createKioskPage({
    screen: { show: (v) => shown.push(v), setWhen: (w) => whens.push(w) },
    fetchDataset: (id) => new Promise((resolve, reject) => reads.push({ id, resolve, reject })),
    log: (message) => logs.push(message),
    nowMs: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => { (timer as { cleared: boolean }).cleared = true },
  })
  return {
    page,
    shown,
    whens,
    timers,
    reads,
    logs,
    advance: (ms: number) => { now += ms },
    last: () => shown[shown.length - 1],
    lastWhen: () => whens[whens.length - 1],
  }
}

describe('createKioskPage', () => {
  it('shows the live Earth, dated now, for an address naming no dataset', () => {
    const h = harness()
    h.page.apply({ datasetId: null, clock: clock() })
    expect(h.last()).toEqual({ kind: 'earth' })
    expect(h.lastWhen().state).toBe('live')
    expect(h.reads).toHaveLength(0)
  })

  it("shows a dataset once it is read, dated on the globe's clock", async () => {
    const h = harness()
    h.page.apply({ datasetId: 'A', clock: clock({ positionS: 50, paused: true }) })
    expect(h.last()).toEqual({ kind: 'loading' })
    h.reads[0].resolve(dataset('A'))
    await until(() => h.last().kind === 'dataset', 'A shown')
    expect(h.last()).toMatchObject({ kind: 'dataset', dataset: { id: 'A' } })
    expect(h.lastWhen()).toMatchObject({ state: 'paused', text: 'Jan 6, 2024' })
  })

  it('drops a read that lands after the address moved on', async () => {
    const h = harness()
    h.page.apply({ datasetId: 'A', clock: clock() })
    h.page.apply({ datasetId: 'B', clock: clock() })
    h.reads[1].resolve(dataset('B'))
    await until(() => h.last().kind === 'dataset', 'B shown')
    h.reads[0].resolve(dataset('A'))
    // One more turn for A's handler to run, if it were going to show.
    await new Promise((r) => setTimeout(r, 0))
    const datasets = h.shown.filter((v) => v.kind === 'dataset')
    expect(datasets).toHaveLength(1)
    expect(h.last()).toMatchObject({ dataset: { id: 'B' } })
  })

  it('tries a failed read again on a widening schedule, while the address still asks for it', async () => {
    const h = harness()
    h.page.apply({ datasetId: 'A', clock: clock() })
    h.reads[0].reject(new KioskDataError('network', 'no answer'))
    await until(() => h.timers.length === 1, 'the first retry')
    expect(h.last()).toEqual({ kind: 'unavailable' })
    expect(h.timers[0].ms).toBe(KIOSK_RETRY_DELAYS_MS[0])
    h.timers[0].fn()
    h.reads[1].reject(new KioskDataError('http', 'HTTP 503'))
    await until(() => h.timers.length === 2, 'the second retry')
    expect(h.timers[1].ms).toBe(KIOSK_RETRY_DELAYS_MS[1])
    h.timers[1].fn()
    h.reads[2].resolve(dataset('A'))
    await until(() => h.last().kind === 'dataset', 'A shown at last')
    // And an address that moves on cancels a retry still waiting.
    const g = harness()
    g.page.apply({ datasetId: 'A', clock: clock() })
    g.reads[0].reject(new KioskDataError('network', 'no answer'))
    await until(() => g.timers.length === 1, 'a retry waiting')
    g.page.apply({ datasetId: null, clock: clock() })
    expect(g.timers[0].cleared).toBe(true)
  })

  it('says a dataset the node has not got cannot be found, and does not ask again', async () => {
    const h = harness()
    h.page.apply({ datasetId: 'A', clock: clock() })
    h.reads[0].reject(new KioskDataError('not_found', 'dataset A not found'))
    // The decision to wait or not is made in the same step as this.
    await until(() => h.last().kind === 'notFound', 'not found')
    expect(h.timers).toHaveLength(0)
  })

  it("shows the live Earth for a dataset the globe can't show, as the globe does", async () => {
    const h = harness()
    h.page.apply({ datasetId: 'A', clock: clock() })
    h.reads[0].reject(new KioskDataError('not_playable', "the globe can't show A"))
    await until(() => h.last().kind === 'earth', 'the live Earth')
    expect(h.lastWhen().state).toBe('live')
    expect(h.timers).toHaveLength(0)
  })

  it('keeps to the slowest retry once the schedule runs out', async () => {
    const h = harness()
    h.page.apply({ datasetId: 'A', clock: clock() })
    for (let i = 0; i < KIOSK_RETRY_DELAYS_MS.length + 2; i++) {
      h.reads[i].reject(new KioskDataError('network', 'no answer'))
      await until(() => h.timers.length === i + 1, `retry ${i + 1}`)
      h.timers[i].fn()
    }
    const slowest = KIOSK_RETRY_DELAYS_MS[KIOSK_RETRY_DELAYS_MS.length - 1]
    expect(h.timers.map((t) => t.ms)).toEqual([...KIOSK_RETRY_DELAYS_MS, slowest, slowest])
  })

  it('drops a failure that lands after the address moved on, rather than covering the next dataset with it', async () => {
    const h = harness()
    h.page.apply({ datasetId: 'A', clock: clock() })
    h.page.apply({ datasetId: 'B', clock: clock() })
    h.reads[1].resolve(dataset('B'))
    await until(() => h.last().kind === 'dataset', 'B shown')
    h.reads[0].reject(new KioskDataError('network', 'no answer'))
    // One more turn for A's failure to run, if it were going to show.
    await new Promise((r) => setTimeout(r, 0))
    expect(h.shown.some((v) => v.kind === 'unavailable')).toBe(false)
    expect(h.last()).toMatchObject({ dataset: { id: 'B' } })
    expect(h.timers).toHaveLength(0)
  })

  it('reads a length the node could not give yet again when it says to, then more slowly, for as long as the dataset is up', async () => {
    const h = harness()
    h.page.apply({ datasetId: 'A', clock: clock({ positionS: 50, paused: true }) })
    h.reads[0].resolve(dataset('A', { lengthS: 0, retryS: 15 }))
    await until(() => h.timers.length === 1, 'a length retry')
    expect(h.lastWhen().state).toBe('span')
    for (let i = 1; i <= KIOSK_LENGTH_RETRIES + 1; i++) {
      h.timers[i - 1].fn()
      h.reads[i].resolve(dataset('A', { lengthS: 0, retryS: 15 }))
      await until(() => h.timers.length === i + 1, `read ${i}`)
    }
    const slowest = KIOSK_RETRY_DELAYS_MS[KIOSK_RETRY_DELAYS_MS.length - 1]
    expect(h.timers.map((t) => t.ms)).toEqual([...Array(KIOSK_LENGTH_RETRIES).fill(15_000), slowest, slowest])
    // A re-read with no length draws nothing new.
    expect(h.shown.filter((v) => v.kind === 'dataset')).toHaveLength(1)
    // The one that brings it does, and dates the clip.
    h.timers[h.timers.length - 1].fn()
    h.reads[h.reads.length - 1].resolve(dataset('A'))
    await until(() => h.shown.filter((v) => v.kind === 'dataset').length === 2, 'the length arrives')
    expect(h.lastWhen()).toMatchObject({ state: 'paused', text: 'Jan 6, 2024' })
  })

  it('leaves the dataset up when a read for its length fails, and asks again later', async () => {
    const g = harness()
    g.page.apply({ datasetId: 'A', clock: clock() })
    g.reads[0].resolve(dataset('A', { lengthS: 0, retryS: 15 }))
    await until(() => g.timers.length === 1, 'a length retry')
    g.timers[0].fn()
    g.reads[1].reject(new KioskDataError('network', 'no answer'))
    await until(() => g.timers.length === 2, 'asked again')
    expect(g.last()).toMatchObject({ kind: 'dataset', dataset: { id: 'A' } })
    expect(g.timers[1].ms).toBe(KIOSK_RETRY_DELAYS_MS[0])
    g.timers[1].fn()
    g.reads[2].resolve(dataset('A'))
    await until(() => g.lastWhen().state !== 'span', 'the length arrives')
    expect(g.shown.some((v) => v.kind === 'unavailable')).toBe(false)
  })

  it('times a clock with no anchor from when this copy read it, and keeps that moment when only the dataset changes', async () => {
    const h = harness()
    h.page.apply({ datasetId: 'A', clock: clock() })
    h.reads[0].resolve(dataset('A'))
    await until(() => h.last().kind === 'dataset', 'A shown')
    h.advance(50_000)
    h.page.tick()
    expect(h.lastWhen().text).toBe('Jan 6, 2024')
    h.page.apply({ datasetId: 'B', clock: clock() })
    h.reads[1].resolve(dataset('B'))
    await until(() => h.last().kind === 'dataset' && (h.last() as { dataset: KioskDataset }).dataset.id === 'B', 'B shown')
    expect(h.lastWhen().text).toBe('Jan 6, 2024')
    // A new clock starts its own moment.
    h.page.apply({ datasetId: 'B', clock: clock({ positionS: 10 }) })
    expect(h.lastWhen().text).toBe('Jan 2, 2024')
  })

  it('stops for good when disposed', async () => {
    const h = harness()
    h.page.apply({ datasetId: 'A', clock: clock() })
    h.page.dispose()
    h.reads[0].resolve(dataset('A'))
    await new Promise((r) => setTimeout(r, 0))
    expect(h.shown.filter((v) => v.kind === 'dataset')).toHaveLength(0)
    const whens = h.whens.length
    h.page.tick()
    h.page.apply({ datasetId: 'B', clock: clock() })
    expect(h.whens).toHaveLength(whens)
    expect(h.reads).toHaveLength(1)
  })
})
