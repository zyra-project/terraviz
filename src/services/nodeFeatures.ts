// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The public SPA's read of this node's feature toggles
 * (`src/types/node-features.ts`), from the public
 * `GET /api/v1/node-profile` the blog boot and the portal chrome
 * already read — and, from the same response, the node's two display
 * lines (`profile.tagline` for the loading screen, `profile.browseSubtitle`
 * for the dataset browser), so neither costs a second request. The
 * lines have no deadline of their own here: their binders
 * (`src/ui/splashTagline.ts`, `src/ui/browseSubtitle.ts`) take each
 * whenever it arrives, and a read that fails or is aborted answers
 * null, the app's own line.
 *
 * Most toggles need no client read at all: a disabled feature's
 * public endpoint answers empty and the surface that renders it
 * degrades on its own. `orbit` is the exception, because hiding Orbit
 * means not drawing the trigger and not starting the chat — including
 * the hands-free wake word, which opens the microphone — and the only
 * way to know that before drawing is to ask. `hero` is the other: the
 * panel falls back to sources the `hero` switch does not gate (the
 * static file, an approved event, which the `events` switch gates,
 * and the real-time pick), so an empty portal pin did not hide it,
 * and `main.ts` applies `features.hero` through
 * `heroPanelUI.setHeroEnabled`. Unlike `orbit` it is not re-read, so
 * an open page picks a change up on its next load.
 *
 * **Fail-open, and bounded.** Every failure answers all-enabled: a
 * network error, a non-2xx, a body that is not the expected JSON, and
 * a request still outstanding when the wait's deadline passes. The
 * deadline is the wait's, not the request's — boot starts the request
 * at the top and waits for it only where the chat is set up, and the
 * catalog load in between must not count against it, or a slow but
 * working network would fail open. On the deadline the request is
 * aborted and the wait resolves without it, whether or not the fetch
 * layer honours the signal, so the answer boot acted on is the only
 * one and nothing can hold boot past it. The worst outcome is a
 * disabled Orbit offered to a page whose node did not answer in time;
 * its endpoints refuse it, which withdraws it (`orbitAvailability`),
 * and so does {@link watchForOrbitWithdrawal}'s next re-read. For the
 * hero it is a panel the node turned off shown for the life of the
 * page, since nothing refuses it and nothing re-reads.
 *
 * `no-store` on the request: the endpoint is served with a five-minute
 * `max-age`, and a browser holding an `orbit: true` from before the
 * operator turned it off would otherwise hand that back.
 *
 * `apiFetch` rather than `fetch`, so a desktop build asks the node it
 * is configured for rather than its own bundled `index.html`. Note
 * that `npm run dev` proxies `/api` to the production node, so a dev
 * server follows production's toggle unless `VITE_DEV_API_TARGET`
 * points elsewhere.
 */

import { defaultFeatures, normalizeFeatures, type FeatureMap } from '../types/node-features'
import { apiFetch } from './catalogSource'
import { withdrawOrbit, isOrbitWithdrawn, onOrbitWithdrawn } from './orbitAvailability'
import { logger } from '../utils/logger'

const NODE_PROFILE_PATH = '/api/v1/node-profile'

/** How long a caller waits for the toggles before assuming
 *  all-enabled, measured from the wait, not the request. */
export const NODE_FEATURES_TIMEOUT_MS = 3000

/** How often a page with Orbit on asks whether it still should be.
 *  Matches the server's cache TTL, which bounds propagation anyway. */
export const ORBIT_RECHECK_MS = 5 * 60_000

type FetchFn = (path: string, init?: RequestInit) => Promise<Response>

export interface NodeFeaturesOptions {
  fetchFn?: FetchFn
}

/** A read in flight. */
export interface PendingNodeFeatures {
  /**
   * The node's feature map, waiting at most `timeoutMs` **from this
   * call**. Never rejects. Idempotent: later calls return the first
   * call's answer, so every waiter acts on the same one.
   */
  settle(timeoutMs?: number): Promise<FeatureMap>
  /**
   * The node's splash tagline once the read finishes, or null when it
   * has none, the read failed, or a `settle` deadline aborted it.
   * Never rejects, and has no deadline of its own: a request that
   * stalls past the abort leaves it pending, which its one reader,
   * the splash, tolerates by revealing the default from CSS.
   */
  tagline: Promise<string | null>
  /**
   * The node's dataset-browser subtitle, on the same terms as
   * {@link tagline} but one: a line the read delivers after a `settle`
   * deadline aborted it answers null. The browse panel is revealed
   * once `settle` answers, so a line landing later would swap the
   * default under a visitor; the abort normally ends the read, and
   * this holds when a fetch layer carries on regardless. The splash
   * tagline keeps a late line, since the splash is still up.
   */
  browseSubtitle: Promise<string | null>
}

interface ProfileRead {
  features: FeatureMap
  tagline: string | null
  browseSubtitle: string | null
}

function failedRead(): ProfileRead {
  return { features: defaultFeatures(), tagline: null, browseSubtitle: null }
}

/** A display line of `profile` as a display string: a non-empty,
 *  trimmed string, or null for anything else (an older node that does
 *  not send the field included). The node bounds and validates it; this
 *  only refuses what is not text, since it reaches the page through
 *  `textContent` either way. */
function profileLine(body: unknown, key: 'tagline' | 'browseSubtitle'): string | null {
  if (!body || typeof body !== 'object') return null
  const profile = (body as { profile?: unknown }).profile
  if (!profile || typeof profile !== 'object') return null
  const raw = (profile as Record<string, unknown>)[key]
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Start reading the toggles now; wait for them later. */
export function startNodeFeaturesRead(opts: NodeFeaturesOptions = {}): PendingNodeFeatures {
  const fetchFn = opts.fetchFn ?? apiFetch
  const controller = new AbortController()
  const read = (async (): Promise<ProfileRead> => {
    try {
      const res = await fetchFn(NODE_PROFILE_PATH, { signal: controller.signal, cache: 'no-store' })
      if (!res.ok) return failedRead()
      const body = (await res.json()) as { features?: unknown } | null
      return {
        features: normalizeFeatures(body?.features),
        tagline: profileLine(body, 'tagline'),
        browseSubtitle: profileLine(body, 'browseSubtitle'),
      }
    } catch (err) {
      logger.debug('[nodeFeatures] read failed; treating every feature as enabled:', err)
      return failedRead()
    }
  })()

  let settled: Promise<FeatureMap> | null = null
  return {
    settle(timeoutMs = NODE_FEATURES_TIMEOUT_MS) {
      settled ??= new Promise<FeatureMap>(resolve => {
        const timer = setTimeout(() => {
          controller.abort()
          resolve(defaultFeatures())
        }, timeoutMs)
        void read.then(({ features }) => {
          clearTimeout(timer)
          resolve(features)
        })
      })
      return settled
    },
    tagline: read.then(r => r.tagline),
    browseSubtitle: read.then(r => (controller.signal.aborted ? null : r.browseSubtitle)),
  }
}

/** Read the toggles and wait for them — for a caller that has nothing
 *  to overlap the request with. Never rejects. */
export function fetchNodeFeatures(
  opts: NodeFeaturesOptions & { timeoutMs?: number } = {},
): Promise<FeatureMap> {
  return startNodeFeaturesRead(opts).settle(opts.timeoutMs)
}

/**
 * Re-read the toggles every {@link ORBIT_RECHECK_MS} while Orbit is on,
 * and withdraw it when the node says off. Without this, a page that
 * never reloads — a kiosk — keeps offering Orbit, and any hands-free
 * microphone, until a visitor's turn happens to be refused. Only a
 * definite `orbit: false` withdraws: every failure answers all-enabled,
 * so a network blip cannot take Orbit away. Stops itself once Orbit is
 * withdrawn by any path. Returns the stop.
 */
export function watchForOrbitWithdrawal(
  opts: NodeFeaturesOptions & { intervalMs?: number } = {},
): () => void {
  if (isOrbitWithdrawn()) return () => {}
  let inFlight = false
  const timer = setInterval(() => {
    if (inFlight) return
    inFlight = true
    void fetchNodeFeatures(opts)
      .then(features => {
        if (!features.orbit) withdrawOrbit('recheck')
      })
      .finally(() => {
        inFlight = false
      })
  }, opts.intervalMs ?? ORBIT_RECHECK_MS)
  const unsubscribe = onOrbitWithdrawn(() => stop())
  function stop(): void {
    clearInterval(timer)
    unsubscribe()
  }
  return stop
}
