/**
 * "Enter VR" / "Enter AR" buttons — the only DOM affordances for
 * the immersive feature.
 *
 * Feature-gated per mode: each button is independently shown only if
 * the corresponding session mode is supported. Browsers without
 * WebXR see neither. Quest 2/3/Pro typically see both. PCVR via
 * SteamVR sees VR only.
 *
 * Both buttons hide themselves while a session is active and
 * re-show on session end via `onSessionEnd`.
 *
 * See {@link file://./../../docs/VR_INVESTIGATION_PLAN.md VR_INVESTIGATION_PLAN.md}.
 */

import { isImmersiveVrSupported, isImmersiveArSupported } from '../utils/vrCapability'
import { enterImmersive, loadThree, type VrMode, type VrSessionContext } from '../services/vrSession'
import { logger } from '../utils/logger'

const VR_BUTTON_ID = 'vr-enter-btn'
const AR_BUTTON_ID = 'vr-enter-ar-btn'

/**
 * Wire each button to its corresponding mode. Idempotent for any
 * given DOM element; safe to call once at boot.
 */
export async function initVrButton(ctx: VrSessionContext): Promise<void> {
  const vrButton = document.getElementById(VR_BUTTON_ID) as HTMLButtonElement | null
  const arButton = document.getElementById(AR_BUTTON_ID) as HTMLButtonElement | null

  if (!vrButton && !arButton) {
    logger.debug('[VR] initVrButton: no buttons in DOM, skipping')
    return
  }

  // Detect each mode in parallel — they're independent calls and
  // there's no reason to serialize them.
  const [vrSupported, arSupported] = await Promise.all([
    vrButton ? isImmersiveVrSupported() : Promise.resolve(false),
    arButton ? isImmersiveArSupported() : Promise.resolve(false),
  ])

  if (!vrSupported && !arSupported) {
    logger.debug('[VR] Neither immersive mode supported — buttons stay hidden')
    return
  }

  // Warm-load the Three.js chunk in the background now that we know
  // SOMETHING is supported. The first click → session-start becomes
  // near-instant on good connections instead of waiting for the
  // ~180 KB gzipped download. Safe if the user never taps.
  void loadThree().catch(err =>
    logger.debug('[VR] Three.js prefetch failed (non-fatal):', err),
  )

  // Build a context wrapper that re-shows whichever buttons are
  // supported when the session ends. Both buttons hide while a
  // session is live so the user can't accidentally start a second.
  function showSupportedButtons(): void {
    if (vrSupported && vrButton) {
      vrButton.classList.remove('hidden')
      vrButton.setAttribute('aria-hidden', 'false')
    }
    if (arSupported && arButton) {
      arButton.classList.remove('hidden')
      arButton.setAttribute('aria-hidden', 'false')
    }
  }

  function hideAllButtons(): void {
    for (const btn of [vrButton, arButton]) {
      if (!btn) continue
      btn.classList.add('hidden')
      btn.setAttribute('aria-hidden', 'true')
    }
  }

  const sessionCtx: VrSessionContext = {
    ...ctx,
    onSessionEnd: () => {
      showSupportedButtons()
      ctx.onSessionEnd?.()
    },
  }

  /**
   * Wire one button to one immersive mode. Single source of truth
   * for the click → enter → hide / fail handling so VR and AR can't
   * drift in behaviour.
   */
  function wireButton(btn: HTMLButtonElement, mode: VrMode): void {
    btn.addEventListener('click', async () => {
      if (btn.classList.contains('pending')) return
      btn.classList.add('pending')
      btn.setAttribute('aria-busy', 'true')
      try {
        await enterImmersive(mode, sessionCtx)
        // Session is live — hide both buttons.
        hideAllButtons()
      } catch (err) {
        logger.error(`[VR] enterImmersive(${mode}) failed:`, err)
        btn.title = err instanceof Error ? err.message : `Failed to enter ${mode.toUpperCase()}`
      } finally {
        btn.classList.remove('pending')
        btn.removeAttribute('aria-busy')
      }
    })
  }

  if (vrSupported && vrButton) {
    wireButton(vrButton, 'vr')
  }
  if (arSupported && arButton) {
    wireButton(arButton, 'ar')
  }

  showSupportedButtons()
}
