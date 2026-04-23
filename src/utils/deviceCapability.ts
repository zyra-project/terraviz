/**
 * Device capability detection for adaptive performance tuning.
 */

/** True when the viewport is narrow (≤768px) or the device supports touch input. */
export function isMobile(): boolean {
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
const BORDERS_TEXTURE_BASE = 'https://d3sik7mbbzunjo.cloudfront.net/terraviz/basemaps'
export function getBordersTextureUrl(): string {
  return isMobile()
    ? `${BORDERS_TEXTURE_BASE}/country-borders-black-4096.png`
    : `${BORDERS_TEXTURE_BASE}/country-borders-black-8192.png`
}
