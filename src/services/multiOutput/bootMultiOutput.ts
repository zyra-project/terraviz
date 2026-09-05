// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Boot-side composition of the multi-monitor output feature
 * (`docs/MULTI_MONITOR_PLAN.md` §3, delivery rung 8).
 *
 * Rung 7 gave the control window a way to *publish* globe state
 * (`globeStateEvents`) and rung 6 gave it something able to *consume*
 * one (`MultiOutputManager.applyState`). This module is the only place
 * that knows about both, and it exists because none of the three
 * alternatives work:
 *
 * - **`main.ts`** exports nothing and boots on import, so wiring placed
 *   there cannot be reached by a test.
 * - **`globeStateEvents`** must not learn what an output is; that is the
 *   whole point of it being a seam.
 * - **`manager.ts`** must not import the publisher, or the seam closes
 *   from the other side and the manager stops being constructible
 *   without the app around it.
 *
 * So the composition lives here, `main.ts` calls it once, and the parts
 * either side stay ignorant of each other.
 *
 * **`start()` is deliberately never called.** It opens the Tauri IPC
 * listener and installs the 1 Hz heartbeat; boot must do neither, since
 * an app with no outputs would be paying for a link nobody is on. Rung 9
 * — the first commit that can actually spawn an output — is what starts
 * it.
 *
 * **Subscription is synchronous; the host is not.** `createTauriHost()`
 * awaits three dynamic imports, and `subscribeGlobeState` deliberately
 * has no replay, so a patch published in that window would be gone for
 * good. Subscribing before the first await and queueing until the
 * manager exists is what keeps the first dataset load — which on a
 * normal boot happens well inside that window — from vanishing. The
 * failure would not even surface here: it appears at rung 9, as an
 * output receiving a `full()` snapshot describing a dataset the
 * aggregator was never told about.
 *
 * Desktop-only, and the gate is inside this module rather than at the
 * call site, so the web build's only cost is one function call that
 * returns a shared inert handle.
 *
 * **The `import('./manager')` inside `startMultiOutput` must stay
 * dynamic.** Making it a static import is the one edit that silently
 * undoes the paragraph above: it pulls `manager` + `stateAggregator` +
 * `protocol` — about 1,200 lines for a feature the web build cannot
 * reach — into the entry chunk, where nothing can tree-shake them
 * because the manager is constructed at runtime. That regression is
 * invisible to the plugin-literal grep used to police Tauri leakage,
 * since `createTauriHost`'s own imports stay dynamic either way; it
 * shipped once for exactly that reason. Check for `sos-equirect` in
 * `dist/assets/main-*.js` instead — it belongs in a `manager-*.js`
 * chunk, not the entry.
 */

import { subscribeGlobeState, type GlobeStatePatch } from './globeStateEvents'
import type { MultiOutputHost, MultiOutputManager } from './manager'
import { logger } from '../../utils/logger'

export interface MultiOutputBootOptions {
  /** Override the desktop gate. Tests must pass this explicitly: the
   *  default reads `window.__TAURI__`, which the happy-dom test
   *  environment never defines, so a case that omits it silently
   *  exercises the disabled branch and asserts nothing. */
  isDesktop?: boolean
  /** Injectable host factory. `createTauriHost` is the only Tauri
   *  importer, so overriding this is what makes the whole path testable
   *  without a packaged desktop build. */
  createHost?: () => Promise<MultiOutputHost>
}

export interface MultiOutputBootHandle {
  /**
   * Resolves to the manager once its host is built, or `null` when the
   * feature is off (web) or the host could not be created.
   *
   * It resolves rather than rejecting on failure: a desktop launch where
   * the Tauri host is unavailable should lose *outputs*, not boot.
   */
  ready: Promise<MultiOutputManager | null>
  /** Detach from the publisher and stop the manager. Idempotent. */
  stop(): void
}

/** The web/disabled handle. Shared because it holds no state — there is
 *  nothing to detach from and nothing to stop. */
const INERT: MultiOutputBootHandle = {
  ready: Promise.resolve(null),
  stop: () => {},
}

/**
 * The live handle, if any.
 *
 * Listeners live in a module-scoped set, so a second `startMultiOutput()`
 * without this guard would attach a second listener and forward every
 * patch twice — invisible in the control window, and at rung 9 an output
 * applying each diff twice against a sequence that only advanced once.
 */
let active: MultiOutputBootHandle | null = null

function detectDesktop(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as unknown as { __TAURI__?: unknown }).__TAURI__)
  )
}

/**
 * Wire the globe-state publisher to a `MultiOutputManager`.
 *
 * Returns synchronously. Calling it twice returns the same handle rather
 * than building a second link.
 */
export function startMultiOutput(
  options: MultiOutputBootOptions = {},
): MultiOutputBootHandle {
  if (active) return active
  if (!(options.isDesktop ?? detectDesktop())) return INERT

  let manager: MultiOutputManager | null = null
  let stopped = false
  let ownsActive = false
  const queued: GlobeStatePatch[] = []

  // Releasing the module sentinel is shared by `stop()` and the failure
  // path. Without it on failure the dead handle stays installed and every
  // later call returns it, so a transient chunk-load failure would cost
  // the whole session its outputs with no way to retry.
  const releaseActive = (): void => {
    if (!ownsActive) return
    active = null
    ownsActive = false
  }

  // A rejected `applyState` would escape the publisher's synchronous
  // try/catch as an unhandled rejection — a broken output link must not
  // surface as one, nor unwind into the dataset load that published.
  const forward = (target: MultiOutputManager, patch: GlobeStatePatch): void => {
    void target
      .applyState(patch)
      .catch(err => logger.warn('[multiOutput] applyState failed:', err))
  }

  const unsubscribe = subscribeGlobeState(patch => {
    if (manager) forward(manager, patch)
    else queued.push(patch)
  })

  const ready = (async (): Promise<MultiOutputManager | null> => {
    try {
      // Dynamic, and that is the whole point: a static import would put
      // `manager` + `stateAggregator` + `protocol` — about 1,200 lines
      // for a desktop-only feature — into the web entry chunk, where
      // nothing can reach them. Rollup splits on this call instead, so
      // the web build downloads none of it. The subscription above is
      // already installed, so deferring the import costs no patches.
      const mod = await import('./manager')
      if (stopped) return null
      const host = await (options.createHost ?? mod.createTauriHost)()
      // Checked after *both* awaits: stop() can land during either.
      if (stopped) return null
      manager = new mod.MultiOutputManager(host)
      // Drained in publication order: `applyState` folds into the
      // aggregator synchronously before its first await, so a loop of
      // un-awaited calls still applies them in order.
      for (const patch of queued.splice(0)) forward(manager, patch)
      return manager
    } catch (err) {
      logger.warn(
        '[multiOutput] host unavailable; outputs are off for this session:',
        err,
      )
      unsubscribe()
      releaseActive()
      return null
    }
  })()

  const handle: MultiOutputBootHandle = {
    ready,
    stop() {
      stopped = true
      unsubscribe()
      // Safe even though `start()` was never called — both the unlisten
      // and the interval clear are null-guarded.
      manager?.stop()
      manager = null
      queued.length = 0
      releaseActive()
    },
  }

  active = handle
  ownsActive = true
  return handle
}

/** Test hook: forget the live handle without stopping it. */
export function resetMultiOutputBootForTests(): void {
  active = null
}
