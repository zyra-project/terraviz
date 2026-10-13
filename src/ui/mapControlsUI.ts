// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Map Controls positioning helper.
 *
 * The actual toolbar UI lives in `toolsMenuUI.ts` now — this module
 * just exposes the positioning helper that sits the map-controls
 * bar above the playback transport when a video is loaded. Kept as a
 * separate file so callers (main.ts) don't need to pull in the full
 * tools-menu module just to reposition.
 */

/**
 * Update the bottom offset of the map-controls host so it sits above
 * the playback controls when a video is loaded. Called from
 * showPlaybackControls and on window resize.
 */
export function updateMapControlsPosition(): void {
  const mapControls = document.getElementById('map-controls')
  if (!mapControls || mapControls.classList.contains('hidden')) return

  const playback = document.getElementById('playback-controls')
  if (playback && !playback.classList.contains('hidden')) {
    // Measured from the transport's top edge where there is a layout to
    // measure: it rests at the bottom (height + its 12px margin), but
    // lifts over the info panel on a window too narrow for both
    // (`initPlaybackPositioning`), and the bar goes with it.
    const parent = mapControls.offsetParent?.getBoundingClientRect()
    const above = parent && parent.height > 0
      ? parent.bottom - playback.getBoundingClientRect().top
      : playback.offsetHeight + 12
    setBottom(mapControls, `${Math.round(above + 4)}px`)
  } else {
    setBottom(mapControls, '0.75rem')
  }
}

/**
 * Where the bar sits, and the same value as `--map-controls-bottom` for
 * the Tools popover that hangs above it: the popover's height limit is
 * the window less the bar, so it has to know how high the bar was put.
 */
function setBottom(mapControls: HTMLElement, bottom: string): void {
  mapControls.style.bottom = bottom
  mapControls.style.setProperty('--map-controls-bottom', bottom)
}
