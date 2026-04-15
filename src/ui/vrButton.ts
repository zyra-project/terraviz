/**
 * "Enter VR" button — the only DOM affordance for the VR feature.
 *
 * Feature-gated: on init, we await {@link isImmersiveVrSupported}
 * and only reveal the button if it resolves true. Browsers without
 * WebXR (desktop, Tauri, mobile Safari) never see the button and
 * never pay the Three.js bundle cost, because clicking is the only
 * thing that triggers `import('three')`.
 *
 * The button hides itself for the duration of an active session
 * (nothing to click while in VR, and it'd be confusing if shown
 * on any possible re-entry into the 2D DOM) and re-shows on
 * session end via `onSessionEnd`.
 *
 * See {@link file://./../../docs/VR_INVESTIGATION_PLAN.md VR_INVESTIGATION_PLAN.md}.
 */

import { isImmersiveVrSupported } from '../utils/vrCapability'
import { enterVr, loadThree, type VrSessionContext } from '../services/vrSession'
import { logger } from '../utils/logger'

const BUTTON_ID = 'vr-enter-btn'

/**
 * Wire the Enter VR button. Safe to call even if the button element
 * is missing from the DOM — logs and no-ops. Safe to call on every
 * boot; idempotent for any given button element.
 */
export async function initVrButton(ctx: VrSessionContext): Promise<void> {
  const button = document.getElementById(BUTTON_ID) as HTMLButtonElement | null
  if (!button) {
    logger.debug('[VR] initVrButton: no #vr-enter-btn element, skipping')
    return
  }

  // Keep the button hidden while we feature-detect. The DOM default
  // has the `hidden` class so there's no flicker if detection fails.
  const supported = await isImmersiveVrSupported()
  if (!supported) {
    logger.debug('[VR] Immersive VR not supported — button stays hidden')
    return
  }

  button.classList.remove('hidden')
  button.setAttribute('aria-hidden', 'false')

  // Warm-load the Three.js chunk in the background now that we know
  // the device can enter VR. The first click→session-start becomes
  // near-instant on good connections instead of waiting for the
  // ~150 KB gzipped download. Safe if the user never taps — it's
  // just a cached promise.
  void loadThree().catch(err =>
    logger.debug('[VR] Three.js prefetch failed (non-fatal):', err),
  )

  const originalCtx: VrSessionContext = {
    ...ctx,
    onSessionEnd: () => {
      // Restore the button when the user comes back out of VR, then
      // forward to the caller's own onSessionEnd (if any) so it can
      // do post-session UI work.
      button.classList.remove('hidden')
      button.setAttribute('aria-hidden', 'false')
      ctx.onSessionEnd?.()
    },
  }

  button.addEventListener('click', async () => {
    if (button.classList.contains('pending')) return
    button.classList.add('pending')
    button.setAttribute('aria-busy', 'true')
    try {
      await enterVr(originalCtx)
      // Session is live — hide the button so it doesn't overlap
      // any DOM that might be briefly visible during the transition.
      button.classList.add('hidden')
      button.setAttribute('aria-hidden', 'true')
    } catch (err) {
      logger.error('[VR] enterVr failed:', err)
      // Surface a simple user-facing message. A more polished
      // implementation would route through the app's `#error-message`
      // banner; for MVP a title tooltip is enough signal.
      button.title = err instanceof Error ? err.message : 'Failed to enter VR'
    } finally {
      button.classList.remove('pending')
      button.removeAttribute('aria-busy')
    }
  })
}
