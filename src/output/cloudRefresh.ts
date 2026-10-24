// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Keeping an output's clouds current (`docs/SECOND_LIFE_COMPAT.md`
 * §7 item 8).
 *
 * The cloud image is replaced upstream every ten minutes, and an output
 * used to load it once, at startup — so a page left open showed the sky
 * from whenever it loaded, and in Second Life, where every visitor's
 * copy loads on its own, two visitors at one globe could see different
 * skies.
 *
 * **Asked, not downloaded.** Each check is a `cache: 'no-cache'` fetch:
 * the browser revalidates its cached copy with the server, so an
 * unchanged image costs a 304 rather than a megabyte. The upstream
 * server sends a readable `Last-Modified` (and CORS for any origin), and
 * an image whose `Last-Modified` and address are both unchanged is not
 * decoded or re-uploaded.
 *
 * **Timed from the image, not from the page.** The next check is due a
 * period after the image's own `Last-Modified`, plus a margin, rather
 * than a period after this page happened to load. Every visitor's copy
 * reads the same `Last-Modified`, so they all change at about the same
 * moment, without anyone having to know the producer's schedule.
 *
 * **The size follows the frame**, through `url()`, read at every check:
 * a frame resized to a different rung picks the other image on its next
 * check.
 *
 * Reading TerraViz's own copy of the clouds, once one exists, is the
 * cloud-copy change's to add; this reads whatever `url()` names.
 */

import { logger } from '../utils/logger'

/** How often the upstream image is replaced. */
export const CLOUD_PERIOD_MS = 10 * 60_000
/** How long after the expected replacement to look, so the new image
 *  has landed by the time we ask. */
export const CLOUD_MARGIN_MS = 60_000
/** How soon to look again when the replacement is late. */
export const CLOUD_RETRY_MS = 2 * 60_000
/** Past this many periods without a change, the producer has stopped
 *  rather than run late; checks drop back to once a period. */
const STALE_PERIODS = 3

/**
 * When to check next, given the current image's `Last-Modified`.
 *
 * Due a period after it, plus the margin. If that moment has already
 * passed, the replacement is late: look again soon, until the image is
 * so old that the producer has evidently stopped, then once a period.
 * With no `Last-Modified` there is nothing to align to: a period from
 * now.
 */
export function nextCloudCheckMs(lastModifiedMs: number | null, nowMs: number): number {
  if (lastModifiedMs === null) return nowMs + CLOUD_PERIOD_MS
  const due = lastModifiedMs + CLOUD_PERIOD_MS + CLOUD_MARGIN_MS
  if (due > nowMs) return due
  return nowMs - lastModifiedMs < STALE_PERIODS * CLOUD_PERIOD_MS ? nowMs + CLOUD_RETRY_MS : nowMs + CLOUD_PERIOD_MS
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface CloudRefreshDeps {
  /** The image to fetch, read at every check. */
  url: () => string
  /** Called with each new image after the first. */
  onImage: (image: TexImageSource) => void
  fetchFn?: FetchFn
  /** Blob to something a texture can take. The default decodes through
   *  an `Image`, which is how the first load always worked, so the
   *  texture's orientation is unchanged. */
  decode?: (blob: Blob) => Promise<TexImageSource>
  nowMs?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface CloudRefresh {
  /** The first image, for the scene's `loadCloudImage`. Resolves `null`
   *  on failure, which is an Earth without clouds rather than an error. */
  first(): Promise<TexImageSource | null>
  /** Start checking. Idempotent. */
  start(): void
  stop(): void
}

function decodeThroughImage(blob: Blob): Promise<TexImageSource> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('cloud image did not decode'))
    }
    img.src = url
  })
}

export function createCloudRefresh(deps: CloudRefreshDeps): CloudRefresh {
  const fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init))
  const decode = deps.decode ?? decodeThroughImage
  const nowMs = deps.nowMs ?? (() => Date.now())
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))

  /** What the current image is, so an unchanged one is not re-decoded. */
  let held: { url: string; lastModified: string | null } | null = null
  let timer: unknown = null
  let running = false

  /** The image at `url()` if it differs from the one held, else `null`. */
  const fetchIfChanged = async (): Promise<TexImageSource | null> => {
    const url = deps.url()
    const res = await fetchFn(url, { cache: 'no-cache', mode: 'cors' })
    if (!res.ok) throw new Error(`clouds: HTTP ${res.status}`)
    const lastModified = res.headers.get('Last-Modified')
    if (held && held.url === url && lastModified !== null && held.lastModified === lastModified) {
      // Unchanged. The body is not needed, so it is not read.
      void res.body?.cancel().catch(() => {})
      return null
    }
    const image = await decode(await res.blob())
    held = { url, lastModified }
    return image
  }

  const heldModifiedMs = (): number | null => {
    const parsed = held?.lastModified ? Date.parse(held.lastModified) : NaN
    return Number.isFinite(parsed) ? parsed : null
  }

  const schedule = (): void => {
    if (!running) return
    // Clamped to a period and a margin. The due time is an absolute one
    // read off this computer's clock, and a clock far enough behind put
    // it more than 2^31 ms out, which `setTimeout` fires at once: the
    // page then rescheduled the same overflow forever, revalidating
    // back to back (found in review). A clock merely hours out delayed
    // every refresh by hours. Clamped, the worst a wrong clock costs is
    // alignment with other visitors, never the refresh itself.
    const delay = Math.min(
      CLOUD_PERIOD_MS + CLOUD_MARGIN_MS,
      Math.max(0, nextCloudCheckMs(heldModifiedMs(), nowMs()) - nowMs()),
    )
    timer = setTimer(() => void check(), delay)
  }

  /** Replace a pending check with one timed from what is held now. */
  const reschedule = (): void => {
    if (!running) return
    if (timer !== null) clearTimer(timer)
    timer = null
    schedule()
  }

  const check = async (): Promise<void> => {
    timer = null
    try {
      const image = await fetchIfChanged()
      if (image && running) deps.onImage(image)
    } catch (err) {
      // The image already showing stays up; the next check tries again.
      logger.warn('[Output] cloud refresh failed:', err)
    }
    schedule()
  }

  return {
    async first() {
      try {
        const image = await fetchIfChanged()
        // The scene does not wait for this before `start()` is called,
        // so checking may already be running, timed from nothing. Retime
        // it from the image now held, or copies that loaded at different
        // moments stay out of step for the first cycle (found in review).
        reschedule()
        return image
      } catch (err) {
        logger.warn('[Output] cloud texture unavailable:', err)
        return null
      }
    },
    start() {
      if (running) return
      running = true
      schedule()
    },
    stop() {
      running = false
      if (timer !== null) clearTimer(timer)
      timer = null
    },
  }
}
