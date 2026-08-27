// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

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

/**
 * Coarse input archetype for an active WebXR session. The three
 * buckets correspond to the input shapes the device-support matrix
 * needs distinct UX paths for:
 *
 *   - `controller` — Quest, PCVR, Pico, Lynx. Two
 *     `tracked-pointer` sources with gamepads (trigger / grip /
 *     thumbstick). The existing interaction layer assumes this.
 *   - `screen` — handheld AR on Android (ARCore + Chrome). A
 *     transient `screen` source per tap; no persistent gamepad.
 *     Needs an in-DOM zoom affordance and a HUD-tap exit because
 *     there is no grip button to press.
 *   - `transient` — Vision Pro, HoloLens 2, Quest with hands
 *     toggled, Magic Leap. `transient-pointer` (or `gaze`) sources
 *     fire on pinch / look-and-tap. Same lack of gamepad axes as
 *     `screen` so the same fallback UX applies.
 *   - `unknown` — session has zero input sources reported yet, or
 *     a mode this code doesn't yet recognize. Callers should treat
 *     this as "wait and reclassify on the next
 *     `inputsourceschange`" rather than mounting any UI.
 *
 * Resolution is mode-of-the-present-sources: if any source reports
 * `screen` the archetype is `screen`; otherwise if any reports
 * `tracked-pointer` it's `controller`; otherwise transient/gaze
 * sources resolve to `transient`. Mixed cases (Quest with one
 * controller + one hand) resolve to `controller` so the existing
 * thumbstick/grip path stays active.
 */
export type VrInputArchetype = 'controller' | 'screen' | 'transient' | 'unknown'

interface XRSessionLike {
  readonly inputSources: ArrayLike<XRInputSource> | Iterable<XRInputSource>
}

export function getInputArchetype(
  session: XRSessionLike | null | undefined,
): VrInputArchetype {
  if (!session) return 'unknown'
  const sources = session.inputSources
  if (!sources) return 'unknown'
  let hasScreen = false
  let hasTracked = false
  let hasTransient = false
  for (const source of sources as Iterable<XRInputSource>) {
    if (!source) continue
    switch (source.targetRayMode) {
      case 'screen':
        hasScreen = true
        break
      case 'tracked-pointer':
        hasTracked = true
        break
      case 'transient-pointer':
      case 'gaze':
        hasTransient = true
        break
    }
  }
  if (hasScreen) return 'screen'
  if (hasTracked) return 'controller'
  if (hasTransient) return 'transient'
  return 'unknown'
}

/**
 * Coarse device classifier for `vr_session_started.device_class`.
 * Substring match on the UA, narrowed by session mode for the
 * cases that need it (Android phones report a non-Quest UA but
 * only matter when they're actually in an AR session — desktop
 * Chrome on Android in a 2D tab shouldn't bucket as `android-ar`).
 *
 * Returns the matched bucket; only the bucket leaves this function,
 * the raw UA is never emitted. Order matters: more-specific
 * variants come first so `Quest Pro` doesn't fall through to the
 * generic `Quest` branch, and `Android` only matters in AR mode
 * (in VR it almost certainly means a tethered/PCVR session).
 *
 * Buckets currently emitted: `quest`, `quest-pro`, `pico`,
 * `vision-pro`, `hololens`, `magic-leap`, `android-ar`, `pcvr`,
 * `unknown`. Additions need a corresponding ANALYTICS.md row and
 * positional-layout entry — see `docs/VR_DEVICE_SUPPORT_PLAN.md`
 * §Telemetry.
 */
export function classifyXrDevice(
  ua: string,
  mode: 'ar' | 'vr',
): string {
  if (/Quest\s*Pro/i.test(ua)) return 'quest-pro'
  if (/Quest/i.test(ua)) return 'quest'
  if (/Pico/i.test(ua)) return 'pico'
  if (/Vision/i.test(ua)) return 'vision-pro'
  if (/HoloLens/i.test(ua)) return 'hololens'
  if (/Magic\s*Leap/i.test(ua)) return 'magic-leap'
  // Android phones running ARCore + Chrome land here only when the
  // session is actually `immersive-ar` — in `immersive-vr` an
  // Android UA is almost always Quest Link / Pico Link routed
  // through a tethered PC, so PCVR is the correct bucket.
  if (mode === 'ar' && /Android/i.test(ua)) return 'android-ar'
  if (/Windows|Mac OS X|Macintosh|X11|Linux/i.test(ua)) return 'pcvr'
  return 'unknown'
}
