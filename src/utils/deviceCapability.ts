/**
 * Device capability detection for adaptive performance tuning.
 */

import { EARTH_ASSET_BASE } from '../config/endpoints'

/**
 * True when the viewport is narrow (≤768px) or the device supports
 * touch input. Returns `false` in non-browser contexts (SSR, tests
 * loaded without jsdom, build-time tooling) so callers that import
 * this module at top level — e.g. `earthTileLayer.ts` reads it both
 * via `getCloudTextureUrl()` and the atmosphere step-tier pick —
 * don't blow up before any code runs.
 */
export function isMobile(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  return (
    window.innerWidth <= 768 || navigator.maxTouchPoints > 0
  )
}

/**
 * True when running as a native mobile app (Tauri iOS or Android),
 * as opposed to the web build or Tauri desktop. Used to gate mobile-
 * specific UX adaptations (bottom sheets, larger touch targets, etc.)
 * that shouldn't apply to desktop Tauri or web-on-mobile.
 */
export const IS_MOBILE_NATIVE: boolean = (() => {
  if (typeof window === 'undefined') return false
  if (!(window as any).__TAURI__) return false
  // Tauri sets these in the mobile webview's user agent
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
})()

/**
 * Largest *shorter* viewport edge still treated as a phone.
 *
 * Classified on the smaller of the two dimensions so the answer does not
 * change when the device rotates. Width alone leaves the crash open in
 * landscape — the 393x852 phone from the report reads 852 wide once
 * turned, sails past any width test, and builds four decoders anyway.
 *
 * 600 rather than the 768 mobile breakpoint because 768 is an iPad's
 * *short* edge. Phones top out near 440 on the short side and tablets
 * start around 744, so 600 sits in the gap and leaves iPads uncapped, as
 * intended — they have not been shown to have this problem.
 *
 * Deliberately not {@link isMobile}, which is also true for
 * `maxTouchPoints > 0`: a touchscreen laptop, an iPad, a Quest headset.
 * Those have the decode headroom a phone does not.
 */
const PHONE_MAX_SHORT_EDGE_PX = 600

/**
 * Most simultaneous video panels a phone will hold.
 *
 * Measured on an iPhone 16 against the Climate Futures tour: four globes
 * with no datasets is fine, four with *image* datasets is fine, and
 * video dies somewhere between the second and third decoder — while
 * still loading, before anything animates. So the ceiling is on video
 * decoders existing, not on playback, panel count, or WebGL contexts,
 * and there is no window in which to intervene once the layout has asked
 * for four. See terraviz#230.
 *
 * Two is the largest value observed to survive.
 */
export const MAX_VIDEO_PANELS_PHONE = 2

/** Every layout the app offers — the answer for anything not a phone. */
export const UNCAPPED_VIDEO_PANELS = 4

/**
 * How many video panels a viewport of these dimensions may hold at once.
 *
 * Pure, so the policy is testable without a window. Order-independent:
 * the same device answers the same in either orientation.
 */
export function maxVideoPanelsForViewport(widthPx: number, heightPx: number): number {
  return Math.min(widthPx, heightPx) <= PHONE_MAX_SHORT_EDGE_PX
    ? MAX_VIDEO_PANELS_PHONE
    : UNCAPPED_VIDEO_PANELS
}

/** {@link maxVideoPanelsForViewport} for the live viewport. */
export function maxVideoPanels(): number {
  if (typeof window === 'undefined') return UNCAPPED_VIDEO_PANELS
  return maxVideoPanelsForViewport(window.innerWidth, window.innerHeight)
}

interface NetworkInformation {
  effectiveType?: string
}

/** True when the Network Information API reports 2g or slow-2g. */
export function isSlowNetwork(): boolean {
  const conn = (navigator as Navigator & { connection?: NetworkInformation }).connection
  return conn?.effectiveType === '2g' || conn?.effectiveType === 'slow-2g'
}

const CLOUD_TEXTURE_BASE = 'https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov'

/** Cloud texture URL — 4K on mobile to reduce download size and GPU memory, 8K on desktop. */
export function getCloudTextureUrl(): string {
  return isMobile()
    ? `${CLOUD_TEXTURE_BASE}/clouds_4096.jpg`
    : `${CLOUD_TEXTURE_BASE}/clouds_8192.jpg`
}

/**
 * Country-borders overlay texture (equirectangular PNG with black
 * lines on transparent background). Served from the same CloudFront
 * basemaps path the Earth diffuse / lights textures use
 * (src/services/photorealEarth.ts). 4K on mobile / standalone VR
 * headsets (Quest reports as mobile via touch points), 8K on
 * desktop. Both variants are small (~635 KB) since the lines are
 * sparse and PNG compresses alpha well; the mobile pick is more
 * about GPU memory than download.
 */
// Same basemap host as the diffuse / lights / normal tiers; resolved
// from `VITE_EARTH_ASSET_BASE` (see src/config/endpoints.ts).
const BORDERS_TEXTURE_BASE = EARTH_ASSET_BASE
export function getBordersTextureUrl(): string {
  return isMobile()
    ? `${BORDERS_TEXTURE_BASE}/country-borders-black-4096.png`
    : `${BORDERS_TEXTURE_BASE}/country-borders-black-8192.png`
}
