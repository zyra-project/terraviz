// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Persist the VR globe's placement across sessions via WebXR
 * Anchors.
 *
 * Problem with naive position-save: Quest's `local-floor` reference
 * space gets re-based every session based on where the user is
 * standing at entry. A saved coordinate like `(x: 1.2, y: 0.8,
 * z: -0.5)` means a different physical location each time — the
 * globe ends up in a different spot whenever the user re-enters
 * VR even if it stays in the same real room.
 *
 * WebXR Anchors solve this. An anchor is a system-tracked reference
 * point bolted to the real world. Once created at a hit-test point,
 * the system tracks its position across tracking adjustments —
 * within a session for sure, and across sessions via a persistent
 * handle (Meta Quest's implementation).
 *
 * This module handles only the persistent-handle localStorage
 * round-trip. Anchor creation, pose tracking, and restore calls
 * live in `vrSession.ts` where they have access to the XRSession.
 */

const STORAGE_KEY = 'sos-vr-globe-anchor-handle'

/** Save the persistent-handle UUID. Failure is non-fatal. */
export function savePersistedAnchorHandle(handle: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, handle)
  } catch {
    // localStorage can throw in private browsing or if quota is
    // exceeded. Not a blocker — the globe simply won't persist.
  }
}

/** Load the last-saved handle, or null if none / storage blocked. */
export function loadPersistedAnchorHandle(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

/** Clear the saved handle — useful after a failed restore. */
export function clearPersistedAnchorHandle(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore.
  }
}
