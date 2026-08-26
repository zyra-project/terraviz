// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isWebXRAvailable,
  isImmersiveVrSupported,
  isImmersiveArSupported,
  getInputArchetype,
  classifyXrDevice,
} from './vrCapability'

/**
 * Feature detection for WebXR boils down to asking navigator.xr
 * whether a given session mode is supported. Tests mock navigator.xr
 * to exercise the three states that matter: missing entirely,
 * present-and-supported, present-and-unsupported, and
 * present-but-throwing (the error-to-false semantics are the reason
 * the helpers exist).
 */

/**
 * Capture the original navigator.xr property descriptor BEFORE any
 * test mutates it. `navigator` is the same object reference across
 * the entire test suite, so storing `navigator` alone (as previous
 * code did) and reading `.xr` from it in afterEach would return
 * whatever the last test wrote — leaking state across files.
 */
const originalXrDescriptor = Object.getOwnPropertyDescriptor(navigator, 'xr')

/** Swap navigator.xr to a given value (or remove the property entirely). */
function setNavXr(xr: unknown): void {
  Object.defineProperty(navigator, 'xr', {
    value: xr,
    configurable: true,
    writable: true,
  })
}

/** Restore navigator.xr to its pre-test state — prevents test leakage. */
function restoreNav(): void {
  if (originalXrDescriptor) {
    Object.defineProperty(navigator, 'xr', originalXrDescriptor)
  } else {
    // Property never existed on the test-env's navigator; delete so
    // subsequent tests don't inherit a stale value.
    delete (navigator as unknown as Record<string, unknown>).xr
  }
}

describe('vrCapability', () => {
  afterEach(() => {
    restoreNav()
    vi.restoreAllMocks()
  })

  describe('isWebXRAvailable', () => {
    it('returns true when navigator.xr exists and is truthy', () => {
      setNavXr({ isSessionSupported: () => Promise.resolve(true) })
      expect(isWebXRAvailable()).toBe(true)
    })

    it('returns false when navigator.xr is explicitly undefined', () => {
      setNavXr(undefined)
      expect(isWebXRAvailable()).toBe(false)
    })

    it('returns false when navigator.xr is null', () => {
      setNavXr(null)
      expect(isWebXRAvailable()).toBe(false)
    })
  })

  describe('isImmersiveVrSupported', () => {
    it('returns false when WebXR itself is unavailable', async () => {
      setNavXr(undefined)
      expect(await isImmersiveVrSupported()).toBe(false)
    })

    it('returns true when navigator.xr.isSessionSupported resolves to true', async () => {
      const isSessionSupported = vi.fn().mockResolvedValue(true)
      setNavXr({ isSessionSupported })
      expect(await isImmersiveVrSupported()).toBe(true)
      expect(isSessionSupported).toHaveBeenCalledWith('immersive-vr')
    })

    it('returns false when isSessionSupported resolves to false', async () => {
      setNavXr({ isSessionSupported: vi.fn().mockResolvedValue(false) })
      expect(await isImmersiveVrSupported()).toBe(false)
    })

    it('returns false (does NOT reject) when isSessionSupported throws', async () => {
      // "No headset connected" / "not implemented" typically surface
      // as rejections; we catch them so callers can treat the result
      // as a plain boolean and hide the UI accordingly.
      setNavXr({
        isSessionSupported: vi.fn().mockRejectedValue(new Error('no device')),
      })
      expect(await isImmersiveVrSupported()).toBe(false)
    })

    it('coerces truthy non-boolean returns to true', async () => {
      // Some implementations historically returned values other than
      // strict booleans. The double-bang in our code handles that.
      setNavXr({
        isSessionSupported: vi.fn().mockResolvedValue('yes' as unknown as boolean),
      })
      expect(await isImmersiveVrSupported()).toBe(true)
    })
  })

  describe('isImmersiveArSupported', () => {
    it('returns false when WebXR itself is unavailable', async () => {
      setNavXr(undefined)
      expect(await isImmersiveArSupported()).toBe(false)
    })

    it('returns true when isSessionSupported resolves to true for immersive-ar', async () => {
      const isSessionSupported = vi.fn().mockResolvedValue(true)
      setNavXr({ isSessionSupported })
      expect(await isImmersiveArSupported()).toBe(true)
      expect(isSessionSupported).toHaveBeenCalledWith('immersive-ar')
    })

    it('returns false when isSessionSupported resolves to false', async () => {
      setNavXr({ isSessionSupported: vi.fn().mockResolvedValue(false) })
      expect(await isImmersiveArSupported()).toBe(false)
    })

    it('returns false when isSessionSupported rejects', async () => {
      setNavXr({
        isSessionSupported: vi.fn().mockRejectedValue(new Error('not supported')),
      })
      expect(await isImmersiveArSupported()).toBe(false)
    })

    it('queries VR and AR independently', async () => {
      // Real-world case: PCVR supports immersive-vr but not
      // immersive-ar. The helpers should return the correct answer
      // for each mode without cross-contamination.
      const isSessionSupported = vi.fn().mockImplementation((mode: string) => {
        return Promise.resolve(mode === 'immersive-vr')
      })
      setNavXr({ isSessionSupported })
      expect(await isImmersiveVrSupported()).toBe(true)
      expect(await isImmersiveArSupported()).toBe(false)
    })
  })

  describe('getInputArchetype', () => {
    // The three buckets `controller` / `screen` / `transient` plus
    // `unknown` for the lazy-resolution case where the session hasn't
    // surfaced any input sources yet — see the helper's doc comment
    // for why each shape needs distinct UX paths.

    function makeSource(targetRayMode: XRTargetRayMode): XRInputSource {
      // Only the field the archetype helper inspects is populated —
      // the full XRInputSource surface (gripSpace, gamepad, etc.) is
      // irrelevant to the bucket decision.
      return { targetRayMode } as unknown as XRInputSource
    }

    it('returns `unknown` for null / undefined session', () => {
      expect(getInputArchetype(null)).toBe('unknown')
      expect(getInputArchetype(undefined)).toBe('unknown')
    })

    it('returns `unknown` when inputSources is empty', () => {
      // Handheld-AR sessions start in this state — a transient
      // `screen` source only appears on the user's first tap. The
      // caller is expected to re-resolve on `inputsourceschange`.
      expect(getInputArchetype({ inputSources: [] })).toBe('unknown')
    })

    it('classifies a single `screen` source as `screen`', () => {
      expect(
        getInputArchetype({ inputSources: [makeSource('screen')] }),
      ).toBe('screen')
    })

    it('classifies a single `tracked-pointer` source as `controller`', () => {
      // Single-controller cases (Magic Leap 2, or a Quest user with
      // one controller put down) still fall through the existing
      // controller code path.
      expect(
        getInputArchetype({
          inputSources: [makeSource('tracked-pointer')],
        }),
      ).toBe('controller')
    })

    it('classifies two `tracked-pointer` sources as `controller`', () => {
      // Standard Quest / PCVR / Pico shape.
      expect(
        getInputArchetype({
          inputSources: [
            makeSource('tracked-pointer'),
            makeSource('tracked-pointer'),
          ],
        }),
      ).toBe('controller')
    })

    it('classifies `transient-pointer` sources as `transient`', () => {
      // Vision Pro pinch / HoloLens 2 hand-ray.
      expect(
        getInputArchetype({
          inputSources: [makeSource('transient-pointer')],
        }),
      ).toBe('transient')
    })

    it('classifies `gaze` sources as `transient`', () => {
      // Cardboard-style and older XR shells route through gaze; same
      // fallback UX as transient-pointer.
      expect(
        getInputArchetype({ inputSources: [makeSource('gaze')] }),
      ).toBe('transient')
    })

    it('prefers `screen` when mixed with other source types', () => {
      // Defensive: shouldn't happen in practice (handheld AR doesn't
      // also emit tracked-pointer), but if it ever does, screen wins
      // so the DOM zoom overlay still mounts.
      expect(
        getInputArchetype({
          inputSources: [
            makeSource('tracked-pointer'),
            makeSource('screen'),
          ],
        }),
      ).toBe('screen')
    })

    it('prefers `controller` over `transient` in mixed sessions', () => {
      // Real-world case: Quest 3 with hands enabled emits both a
      // `tracked-pointer` per controller AND a `transient-pointer`
      // per hand-pinch. We want the existing controller path to
      // stay authoritative when controllers are in hand.
      expect(
        getInputArchetype({
          inputSources: [
            makeSource('tracked-pointer'),
            makeSource('transient-pointer'),
          ],
        }),
      ).toBe('controller')
    })

    it('ignores unrecognized targetRayMode values', () => {
      // Future spec additions / vendor experiments shouldn't crash
      // the classifier; they read as `unknown` so the caller
      // re-resolves rather than mounting the wrong UI.
      expect(
        getInputArchetype({
          inputSources: [
            makeSource('eyeball-tracking' as unknown as XRTargetRayMode),
          ],
        }),
      ).toBe('unknown')
    })

    it('accepts an array-like inputSources (XRInputSourceArray)', () => {
      // Real XR sessions expose an XRInputSourceArray, not a plain
      // array — exercising the iterable-protocol path makes sure
      // the helper doesn't assume `Array.isArray`.
      const arrayLike: XRInputSourceArray = Object.assign(
        [makeSource('screen')] as XRInputSource[],
        {
          [Symbol.iterator]: function* () {
            yield makeSource('screen')
          },
        },
      ) as unknown as XRInputSourceArray
      expect(getInputArchetype({ inputSources: arrayLike })).toBe('screen')
    })
  })

  describe('classifyXrDevice', () => {
    // Substring match on UA, narrowed by session mode for
    // ambiguous cases (Android in AR mode is a phone; in VR mode
    // it's almost always a tethered Quest Link routed through a PC).

    it('returns `quest-pro` for Quest Pro UA before the generic Quest branch', () => {
      // Order matters — `Quest Pro` must match before plain `Quest`.
      expect(
        classifyXrDevice(
          'Mozilla/5.0 (X11; Linux x86_64; Quest Pro) Chrome/120',
          'ar',
        ),
      ).toBe('quest-pro')
    })

    it('returns `quest` for generic Quest UAs (Quest 2 / 3)', () => {
      expect(
        classifyXrDevice(
          'Mozilla/5.0 (X11; Linux x86_64; Quest 3) Chrome/120',
          'vr',
        ),
      ).toBe('quest')
    })

    it('returns `pico` for Pico headsets', () => {
      expect(
        classifyXrDevice(
          'Mozilla/5.0 (Linux; Android 12; Pico Neo 4) AppleWebKit/537',
          'vr',
        ),
      ).toBe('pico')
    })

    it('returns `vision-pro` for visionOS', () => {
      expect(
        classifyXrDevice(
          'Mozilla/5.0 (Macintosh; Apple Vision Pro) Safari/605',
          'ar',
        ),
      ).toBe('vision-pro')
    })

    it('returns `hololens` for HoloLens 2 Edge', () => {
      expect(
        classifyXrDevice(
          'Mozilla/5.0 (Windows NT 10.0; HoloLens) Edge/120',
          'ar',
        ),
      ).toBe('hololens')
    })

    it('returns `magic-leap` for Magic Leap 2', () => {
      expect(
        classifyXrDevice(
          'Mozilla/5.0 (Linux; Magic Leap 2) Chrome/120',
          'ar',
        ),
      ).toBe('magic-leap')
    })

    it('returns `android-ar` for Android phones in AR mode', () => {
      // Pixel / Galaxy on Chrome with ARCore.
      expect(
        classifyXrDevice(
          'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120',
          'ar',
        ),
      ).toBe('android-ar')
    })

    it('does NOT bucket Android UAs as `android-ar` when mode is vr', () => {
      // The `android-ar` bucket is for handheld AR specifically;
      // an Android UA in VR mode falls through to whichever later
      // bucket (`pcvr` via the Linux base, or `unknown`) the rest
      // of the UA matches. The rule is: Android alone is not
      // sufficient to bucket as phone-AR — mode is the second
      // discriminator.
      expect(
        classifyXrDevice(
          'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120',
          'vr',
        ),
      ).not.toBe('android-ar')
    })

    it('returns `pcvr` for desktop OS UAs', () => {
      expect(
        classifyXrDevice('Mozilla/5.0 (Windows NT 10.0) Chrome/120', 'vr'),
      ).toBe('pcvr')
      expect(
        classifyXrDevice(
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120',
          'vr',
        ),
      ).toBe('pcvr')
      expect(
        classifyXrDevice(
          'Mozilla/5.0 (X11; Linux x86_64) Chrome/120',
          'vr',
        ),
      ).toBe('pcvr')
    })

    it('returns `unknown` for empty or unrecognized UAs', () => {
      expect(classifyXrDevice('', 'vr')).toBe('unknown')
      expect(classifyXrDevice('SomeNewDevice/1.0', 'ar')).toBe('unknown')
    })
  })
})
