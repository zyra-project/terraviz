import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isWebXRAvailable,
  isImmersiveVrSupported,
  isImmersiveArSupported,
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
})
