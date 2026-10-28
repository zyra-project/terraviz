// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The kiosk page composed (docs/SECOND_LIFE_COMPAT.md §7 item 9): each
 * reading of the address in, the screen out. `kioskMain` hands it every
 * reading, at load and on each `hashchange`, and calls `tick` a few
 * times a second for the date.
 *
 * Its own module for `webOutput`'s reason: the ordering has wrong answers
 * and the entry point exports nothing. A dataset that loads after the
 * address has moved on is dropped, so a slow read can't put the last
 * dataset's text beside the next one's picture. A read that fails is
 * tried again on a widening schedule while the address still asks for
 * it, unless the node said there is no such dataset, since a screen in a
 * permanent exhibit should recover by itself. A video whose exact length
 * the node can't give yet (it is still reading the stream's playlists)
 * is read again when the node says to, a few times, and shows its span
 * meanwhile rather than a date from a guessed length.
 *
 * The clock is the globe's: an address with no `at` is timed from when
 * this copy read it, and only a change to the clock moves that moment,
 * so a change to the dataset alone doesn't restart the date.
 */
import type { KioskScreen } from '../ui/kioskUI'
import { earthWhen, KioskDataError, kioskWhen, type KioskDataset } from './kioskModel'
import { sameClock, type WebClock, type WebOutputSettings } from './webMode'

/** Waits before trying a failed read again, the last repeating. */
export const KIOSK_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000, 300_000]

/** Times the card is read again for a length the node couldn't give. */
export const KIOSK_LENGTH_RETRIES = 4

export interface KioskPageDeps {
  screen: Pick<KioskScreen, 'show' | 'setWhen'>
  fetchDataset: (id: string) => Promise<KioskDataset>
  nowMs?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  log?: (message: string) => void
}

export interface KioskPage {
  apply(reading: Pick<WebOutputSettings, 'datasetId' | 'clock'>): void
  tick(): void
  dispose(): void
}

export function createKioskPage(deps: KioskPageDeps): KioskPage {
  const now = deps.nowMs ?? (() => Date.now())
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const log = deps.log ?? (() => {})

  // `undefined` until the first reading, so the first is always applied.
  let wanted: string | null | undefined
  let clock: WebClock | null = null
  let readAtMs = 0
  let shown: KioskDataset | null = null
  let view: 'earth' | 'loading' | 'unavailable' | 'dataset' = 'loading'
  let generation = 0
  let timer: unknown = null

  const cancel = (): void => {
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  const tick = (): void => {
    if (view === 'earth') deps.screen.setWhen(earthWhen(now()))
    else if (view === 'dataset' && shown && clock) deps.screen.setWhen(kioskWhen(shown, clock, now(), readAtMs))
    else deps.screen.setWhen({ state: 'none', text: '', rate: 1 })
  }

  /** Read `id`: `attempt` failed reads so far, `lengthReads` reads made
   *  only to learn the length. */
  const load = (id: string, gen: number, attempt: number, lengthReads: number): void => {
    timer = null
    deps.fetchDataset(id).then(
      (ds) => {
        if (gen !== generation) return
        shown = ds
        view = 'dataset'
        deps.screen.show({ kind: 'dataset', dataset: ds })
        tick()
        if (ds.lengthS === 0 && ds.retryS > 0 && lengthReads < KIOSK_LENGTH_RETRIES) {
          timer = setTimer(() => load(id, gen, 0, lengthReads + 1), ds.retryS * 1000)
        }
      },
      (err: unknown) => {
        if (gen !== generation) return
        log(`[kiosk] ${err instanceof Error ? err.message : String(err)}`)
        // A read for the length alone that fails leaves the dataset up:
        // its span is still right, and its text has not changed.
        if (lengthReads > 0 && shown) return
        shown = null
        view = 'unavailable'
        deps.screen.show({ kind: 'unavailable' })
        tick()
        if (err instanceof KioskDataError && err.failure === 'not_found') return
        const delay = KIOSK_RETRY_DELAYS_MS[Math.min(attempt, KIOSK_RETRY_DELAYS_MS.length - 1)]
        timer = setTimer(() => load(id, gen, attempt + 1, 0), delay)
      },
    )
  }

  const apply = (reading: Pick<WebOutputSettings, 'datasetId' | 'clock'>): void => {
    if (!clock || !sameClock(clock, reading.clock)) {
      clock = reading.clock
      readAtMs = now()
    }
    if (reading.datasetId !== wanted) {
      wanted = reading.datasetId
      generation++
      cancel()
      shown = null
      if (wanted === null) {
        view = 'earth'
        deps.screen.show({ kind: 'earth' })
      } else {
        view = 'loading'
        deps.screen.show({ kind: 'loading' })
        load(wanted, generation, 0, 0)
      }
    }
    tick()
  }

  const dispose = (): void => {
    generation++
    cancel()
  }

  return { apply, tick, dispose }
}
