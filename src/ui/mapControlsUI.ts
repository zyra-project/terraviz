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
    const height = playback.offsetHeight
    mapControls.style.bottom = `${height + 16}px`
  } else {
    mapControls.style.bottom = '0.75rem'
  }
}
