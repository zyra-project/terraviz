/**
 * Single "Enter immersive mode" button — adapts to whatever the
 * device supports.
 *
 * Design choice: AR passthrough is strictly better than VR for the
 * Science On a Sphere use case (a virtual globe in your real room
 * IS the SOS experience), so when both are available we prefer AR.
 * VR is only used as a fallback for hardware that can't do
 * passthrough (PCVR via SteamVR, etc.).
 *
 *   AR + VR available → button reads "Enter AR", launches immersive-ar
 *   VR only           → button reads "Enter VR", launches immersive-vr
 *   Neither           → button hidden
 *
 * The button hides itself for the duration of an active session and
 * re-shows on session end via `onSessionEnd`.
 *
 * See {@link file://./../../docs/VR_INVESTIGATION_PLAN.md VR_INVESTIGATION_PLAN.md}
 * Phase 2.1 for the AR design discussion. If a future user really
 * wants the dark-void VR mode on AR-capable hardware, the right
 * place is a small "Mode" toggle in settings — deferred until
 * someone asks.
 */

import { isImmersiveVrSupported, isImmersiveArSupported } from '../utils/vrCapability'
import { enterImmersive, loadThree, type VrMode, type VrSessionContext } from '../services/vrSession'
import { logger } from '../utils/logger'

const BUTTON_ID = 'vr-enter-btn'

/**
 * Wire the immersive-mode button. Safe to call even if the button
 * element is missing from the DOM — logs and no-ops. Safe to call
 * on every boot; idempotent for any given button element.
 */
export async function initVrButton(ctx: VrSessionContext): Promise<void> {
  const button = document.getElementById(BUTTON_ID) as HTMLButtonElement | null
  if (!button) {
    logger.debug('[VR] initVrButton: no #vr-enter-btn element, skipping')
    return
  }

  // Detect both modes in parallel — no reason to serialize independent calls.
  const [vrSupported, arSupported] = await Promise.all([
    isImmersiveVrSupported(),
    isImmersiveArSupported(),
  ])

  if (!vrSupported && !arSupported) {
    logger.debug('[VR] Neither immersive mode supported — button stays hidden')
    return
  }

  // Prefer AR — it's the better SOS experience. Fall back to VR for
  // hardware that lacks passthrough.
  const mode: VrMode = arSupported ? 'ar' : 'vr'
  const labelText = mode === 'ar' ? 'Enter AR' : 'Enter VR'
  const titleText =
    mode === 'ar'
      ? 'Enter passthrough AR mode (globe appears in your room)'
      : 'Enter immersive VR mode'

  // Update the visible label + accessibility attributes for whichever
  // mode the device picked. The DOM ships with "Enter VR" as a
  // sensible default for screen readers / no-JS browsers.
  const labelSpan = button.querySelector('.vr-btn-label')
  if (labelSpan) labelSpan.textContent = labelText
  button.title = titleText
  button.setAttribute('aria-label', titleText)
  button.classList.remove('hidden')
  button.setAttribute('aria-hidden', 'false')

  // Warm-load the Three.js chunk in the background now that we know
  // the device supports SOMETHING. The first click → session-start
  // becomes near-instant on good connections instead of waiting for
  // the ~180 KB gzipped download. Safe if the user never taps.
  void loadThree().catch(err =>
    logger.debug('[VR] Three.js prefetch failed (non-fatal):', err),
  )

  const sessionCtx: VrSessionContext = {
    ...ctx,
    onSessionEnd: () => {
      // Restore the button when the user comes back out, then
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
      await enterImmersive(mode, sessionCtx)
      // Session is live — hide the button so it doesn't overlap any
      // DOM that might be briefly visible during the transition.
      button.classList.add('hidden')
      button.setAttribute('aria-hidden', 'true')
    } catch (err) {
      logger.error(`[VR] enterImmersive(${mode}) failed:`, err)
      // Surface a simple user-facing message via the title tooltip;
      // a polished version would route through the app's
      // #error-message banner.
      button.title = err instanceof Error ? err.message : `Failed to enter ${mode.toUpperCase()}`
    } finally {
      button.classList.remove('pending')
      button.removeAttribute('aria-busy')
    }
  })
}
