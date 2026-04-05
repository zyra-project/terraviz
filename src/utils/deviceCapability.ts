/**
 * Device capability detection for adaptive performance tuning.
 */

/** True when the viewport is narrow (≤768px) or the device supports touch input. */
export function isMobile(): boolean {
  return (
    window.innerWidth <= 768 || navigator.maxTouchPoints > 0
  )
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
