/**
 * WebXR feature detection.
 *
 * `navigator.xr` is present in any browser that implements the WebXR
 * Device API, but the presence of the API doesn't tell us whether a
 * headset is actually reachable — we still have to ask the system
 * whether `immersive-vr` sessions are supported. That answer is async
 * because on some platforms it triggers a device probe.
 *
 * The two-step check (sync presence, async support) lets callers gate
 * UI immediately (hide the button if `xr` is missing) and then refine
 * asynchronously (remove the button if the device can't run an
 * immersive session).
 */

import { logger } from './logger'

/**
 * True if `navigator.xr` exists. Cheap sync check — safe to call
 * during module init before any user interaction.
 *
 * Does **not** guarantee the device can actually enter a VR session;
 * pair with `isImmersiveVrSupported()` for that.
 */
export function isWebXRAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'xr' in navigator && !!navigator.xr
}

/**
 * Ask the browser whether an `immersive-vr` session can be started.
 *
 * Resolves to false (rather than rejecting) on any error so callers
 * can treat it as a plain boolean. Errors at this layer almost always
 * mean "no headset connected" or "API not implemented"; either way,
 * we want the VR UI hidden.
 */
export async function isImmersiveVrSupported(): Promise<boolean> {
  if (!isWebXRAvailable()) return false
  try {
    const xr = navigator.xr!
    const supported = await xr.isSessionSupported('immersive-vr')
    return !!supported
  } catch (err) {
    logger.debug('[VR] isSessionSupported(immersive-vr) threw:', err)
    return false
  }
}

/**
 * Ask the browser whether an `immersive-ar` (passthrough) session
 * can be started. On Meta Quest, this corresponds to mixed-reality
 * mode — the camera feed shows behind the WebGL framebuffer's
 * transparent pixels.
 *
 * Quest 2/3/Pro all support this; PCVR + browsers without
 * passthrough hardware return false. Same error-to-false semantics
 * as `isImmersiveVrSupported()`.
 */
export async function isImmersiveArSupported(): Promise<boolean> {
  if (!isWebXRAvailable()) return false
  try {
    const xr = navigator.xr!
    const supported = await xr.isSessionSupported('immersive-ar')
    return !!supported
  } catch (err) {
    logger.debug('[VR] isSessionSupported(immersive-ar) threw:', err)
    return false
  }
}
