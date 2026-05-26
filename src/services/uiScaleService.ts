/**
 * UI-scale service — the runtime side of the `--ui-scale` token
 * (§7.1). Reads the persisted preference, applies it as an inline
 * `:root { --ui-scale: N }` style, and exposes a tiny API for the
 * Tools menu radio to write the user's choice.
 *
 * Load precedence at boot, highest first:
 *
 *   1. `localStorage["sos-ui-scale.v1"]` — the user's saved choice.
 *   2. `VITE_DEFAULT_UI_SCALE` — build-time env var (used by the
 *      SOS deployment, which ships with `1.5` as a forced default).
 *   3. `1.0` — the universal fallback. We deliberately do NOT flip
 *      the default to `1.5` upstream; that's a community decision
 *      and invalidates muscle memory for the existing user base.
 *
 * The three presets exposed to the UI (Comfortable / Default /
 * Compact = 1.5 / 1.0 / 0.85) come straight out of the plan. The
 * radio in the Tools menu writes via `setUiScale()`; other call
 * sites (URL params, tour scripts) are intentionally out of scope.
 */

/**
 * The three discrete UI-scale presets exposed in the Tools menu.
 * The radio is presets-only — a freeform slider invites bad
 * intermediate values and there's no shareable-look use case here.
 */
export const UI_SCALE_PRESETS = {
  comfortable: 1.5,
  default: 1.0,
  compact: 0.85,
} as const

/** Discriminated union over the preset IDs the UI offers. */
export type UiScalePreset = keyof typeof UI_SCALE_PRESETS

/**
 * Hard limits for any value that lands in `setUiScale()`. Outside
 * this band the UI either becomes unusable (too tiny to tap) or
 * starts clipping at common viewport sizes (too large). The
 * presets all fall safely inside.
 */
const UI_SCALE_MIN = 0.5
const UI_SCALE_MAX = 2.0

/** localStorage key for the persisted user preference. Versioned
 *  the same way `sos-browse-view-mode.v1` is so a future schema
 *  change can ignore stale shapes. */
const STORAGE_KEY = 'sos-ui-scale.v1'

/**
 * Coerce any incoming value to a finite number inside the safe
 * band. Non-numeric input, NaN, ±Infinity, and out-of-range
 * values all collapse to `null` so callers can fall back to the
 * next layer of the precedence chain.
 */
export function sanitizeUiScale(raw: unknown): number | null {
  if (raw == null) return null
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return null
  if (n < UI_SCALE_MIN || n > UI_SCALE_MAX) return null
  return n
}

/**
 * Read the build-time env-var override. Returns `null` if the
 * env var is unset or malformed. Wrapped so tests can stub the
 * env without touching `import.meta.env` directly.
 */
function readEnvDefault(): number | null {
  const raw = import.meta.env.VITE_DEFAULT_UI_SCALE
  return sanitizeUiScale(raw)
}

/**
 * Read the persisted user preference from localStorage. SSR-safe.
 * Returns `null` on storage failure or missing/invalid values.
 */
function readPersistedScale(): number | null {
  if (typeof window === 'undefined') return null
  try {
    return sanitizeUiScale(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    return null
  }
}

/**
 * Resolve the boot-time UI scale per the precedence chain:
 * localStorage → env var → 1.0.
 *
 * Pure with respect to its inputs — callers pass them in so the
 * precedence is testable without mocking `import.meta.env`.
 */
export function resolveUiScale(
  persisted: number | null,
  envDefault: number | null,
): number {
  return persisted ?? envDefault ?? UI_SCALE_PRESETS.default
}

/**
 * Read the scale to apply at boot. Combines the precedence chain
 * with the runtime sources (localStorage + env). Pure-module
 * tests target {@link resolveUiScale} + {@link sanitizeUiScale};
 * this is the integration entry point.
 */
export function loadUiScale(): number {
  return resolveUiScale(readPersistedScale(), readEnvDefault())
}

/**
 * Apply a scale value as an inline `--ui-scale` on `:root`. Idempotent
 * and safe to call repeatedly. SSR-safe — no-op outside the browser.
 */
function applyToRoot(value: number): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty('--ui-scale', String(value))
}

/**
 * Persist a scale value to localStorage. Best-effort — silent on
 * storage failure (Safari private mode, quota errors, etc.).
 */
function persistScale(value: number): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    /* swallow — at-worst the user's choice reverts on reload */
  }
}

/**
 * Boot the UI-scale runtime. Resolves the precedence chain, writes
 * the resulting value to `:root { --ui-scale }`, and returns it so
 * the caller can hand it to the Tools-menu radio for the initial
 * selected state. Called once from `main.ts` before any UI render.
 */
export function initUiScale(): number {
  const value = loadUiScale()
  applyToRoot(value)
  return value
}

/**
 * Write a user-selected scale. Sanitises the input, applies it to
 * `:root`, persists it to localStorage, and returns the value that
 * actually landed (so the caller can sync UI state). Out-of-band
 * inputs collapse to the default preset.
 */
export function setUiScale(raw: number): number {
  const value = sanitizeUiScale(raw) ?? UI_SCALE_PRESETS.default
  applyToRoot(value)
  persistScale(value)
  return value
}

/**
 * Map a numeric scale to the closest matching preset, or `null` if
 * the value sits outside the preset range. Used where we need to
 * know whether the active scale IS one of the named presets
 * (telemetry, programmatic logic) — UI highlighting should use
 * {@link nearestPreset} so one radio is always selected.
 * A small tolerance (±0.01) tolerates floating-point round-trips.
 */
export function matchPreset(value: number): UiScalePreset | null {
  for (const [name, target] of Object.entries(UI_SCALE_PRESETS) as Array<
    [UiScalePreset, number]
  >) {
    if (Math.abs(value - target) < 0.01) return name
  }
  return null
}

/**
 * Map any scale value to the preset whose target it sits closest
 * to. Always returns a preset — even a freeform value (e.g. a
 * forker shipping `VITE_DEFAULT_UI_SCALE=1.25`, or a localStorage
 * entry hand-edited mid-session) gets a meaningful radio
 * highlight rather than a radiogroup with no selection. Ties
 * resolve to the first preset declared in {@link UI_SCALE_PRESETS}
 * (deterministic, but the bands are wide enough that real-world
 * inputs never land exactly on a midpoint).
 */
export function nearestPreset(value: number): UiScalePreset {
  let best: UiScalePreset = 'default'
  let bestDistance = Infinity
  for (const [name, target] of Object.entries(UI_SCALE_PRESETS) as Array<
    [UiScalePreset, number]
  >) {
    const distance = Math.abs(value - target)
    if (distance < bestDistance) {
      best = name
      bestDistance = distance
    }
  }
  return best
}

/** Test-only: localStorage key, exported so tests can clear it. */
export const UI_SCALE_STORAGE_KEY = STORAGE_KEY
