/**
 * Persist the VR globe's placement across sessions.
 *
 * After the user places the globe on a real surface (via
 * `vrPlacement` hit-test), we save the resulting world position to
 * localStorage. On the next AR session, we restore that position
 * before the loading scene fades, so the globe appears right where
 * it was left.
 *
 * Caveats:
 *   - Local-floor coordinates are anchored to the user's
 *     reference-space setup per session. For normal Quest usage in
 *     the same room, these coordinates are reliably stable across
 *     sessions. Moving to a different room or re-running Quest's
 *     boundary setup will invalidate the saved position — the
 *     globe may appear in an odd spot; the user can just re-place.
 *   - Orientation is NOT persisted — only position. The globe's
 *     rotation is user-driven (grab + spin) and resets to identity
 *     on each session. That's typically what users expect.
 *   - For stronger cross-session robustness (system-tracked
 *     anchors that survive room-boundary recalibration), the
 *     WebXR Anchors spec's `persistAnchor` is the correct
 *     primitive but it's not widely implemented outside Meta
 *     Quest's browser and doesn't have standard TS types yet.
 *     This simple localStorage approach covers the main UX win
 *     ("my globe is STILL on my table") without the API wrangling.
 */

const STORAGE_KEY = 'sos-vr-globe-position'

export interface PersistedPosition {
  x: number
  y: number
  z: number
}

/** Save the globe's current world position. Failure is non-fatal. */
export function savePersistedPlacement(pos: PersistedPosition): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pos))
  } catch {
    // localStorage can throw in private browsing or if quota is
    // exceeded. Not a blocker — the globe simply won't persist.
  }
}

/** Restore the last-saved globe position, or null if none / malformed. */
export function loadPersistedPlacement(): PersistedPosition | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as PersistedPosition).x !== 'number' ||
      typeof (parsed as PersistedPosition).y !== 'number' ||
      typeof (parsed as PersistedPosition).z !== 'number'
    ) {
      return null
    }
    return parsed as PersistedPosition
  } catch {
    return null
  }
}

/** Clear the saved position. Called if we want to force default placement next session. */
export function clearPersistedPlacement(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore — see savePersistedPlacement for why.
  }
}
