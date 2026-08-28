// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Screenshot-trace recorder for the Weblate screenshot pipeline.
 *
 * Gated entirely behind `import.meta.env.VITE_I18N_TRACE`: the only
 * production caller is `t()` in `./index.ts`, inside an
 * `if (import.meta.env.VITE_I18N_TRACE === 'true')` branch. Vite
 * inlines `import.meta.env.VITE_*` as a string literal when the var
 * is set and as `undefined` when it isn't, so in a normal build the
 * guard becomes `undefined === 'true'` — statically `false`. Rollup
 * drops the dead call, and — because this module has no import-time
 * side effects — the whole module falls out of the bundle. Keep it
 * side-effect-free at module scope for that elimination to hold.
 *
 * When the flag *is* set (CI screenshot-capture builds only), every
 * resolved message key is collected into a Set and mirrored onto
 * `window.__i18nTrace`. The Playwright capturer drives the app to a
 * scene, reads which keys that scene rendered, and associates them
 * with the uploaded screenshot in Weblate.
 *
 * See `docs/WEBLATE_SCREENSHOT_SYNC_PLAN.md`.
 */

/** Handle the Playwright capturer reads off `window.__i18nTrace`. */
export interface I18nTrace {
  /** Keys resolved since the last {@link I18nTrace.reset}. */
  readonly seen: Set<string>
  /** Clear the set — the capturer calls this between scenes. */
  reset(): void
}

declare global {
  interface Window {
    __i18nTrace?: I18nTrace
  }
}

// Allocated lazily on first `recordI18nKey()` rather than at module
// scope, so import time is *unambiguously* side-effect-free (just a
// binding declaration + functions). That's what lets Rollup drop the
// whole module when the `VITE_I18N_TRACE` guard is dead — a
// module-scope `new Set()` could be treated conservatively as a side
// effect and keep the module as a bare import.
let trace: I18nTrace | undefined

function ensureTrace(): I18nTrace {
  if (!trace) {
    const seen = new Set<string>()
    trace = { seen, reset: () => seen.clear() }
  }
  return trace
}

/**
 * Record a resolved message key. Lazily creates the trace and
 * publishes its handle on `window` on first call, so the module
 * carries no import-time side effect (which is what lets it
 * tree-shake away when the flag is off). Safe in non-DOM contexts
 * (SSR / tests) — the `window` write is guarded.
 */
export function recordI18nKey(key: string): void {
  const t = ensureTrace()
  t.seen.add(key)
  if (typeof window !== 'undefined' && window.__i18nTrace !== t) {
    window.__i18nTrace = t
  }
}

/** Test-only: reset to the pristine (un-allocated) state between cases. */
export function __resetI18nTraceForTests(): void {
  trace = undefined
}
