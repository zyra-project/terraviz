/**
 * Host-agnostic bridge from the docent stream to the Orbit character.
 *
 * Maps {@link DocentStreamChunk} events onto the small surface shared
 * by `OrbitController` (standalone `/orbit` page) and
 * `OrbitAvatarNode` (VR scene / future 2D companion):
 *
 * | Stream event                            | Orbit reaction                          |
 * |-----------------------------------------|-----------------------------------------|
 * | `onUserSubmit()`                        | `setState('LISTENING')`                 |
 * | no first delta within `thinkingDelayMs` | `setState('THINKING')`                  |
 * | first `{ type: 'delta' }` chunk         | `setState('TALKING')`                   |
 * | `{ type: 'action' }` chunk              | `playGesture('beckon')`                 |
 * | `{ type: 'auto-load' }` chunk           | `playGesture('affirm')`                 |
 * | `{ type: 'rewrite' }` chunk             | (no state change — visual stays put)    |
 * | `{ type: 'done', fallback: false }`     | `setState('CHATTING')`                  |
 * | `{ type: 'done', fallback: true }`      | `setState('CONFUSED')` then `'CHATTING'`|
 * | `onAbort()` (network / manual)          | same as `done` with `fallback: true`    |
 *
 * The bridge holds no Three.js / DOM references and never imports the
 * docent service implementation — only its type. So a single bridge
 * instance can drive an `OrbitAvatarNode` from VR, an `OrbitController`
 * on the standalone page, or a future 2D-companion mount, all with
 * identical behaviour. The existing chat UI calls `onUserSubmit()` /
 * `onChunk(c)` / `onAbort()` against this bridge in addition to its
 * existing rendering work.
 *
 * See:
 *   - docs/VR_INVESTIGATION_PLAN.md §Phase 4 commit 3 (this module)
 *   - docs/ORBIT_CHARACTER_INTEGRATION_PLAN.md §6 (event-mapping table)
 */

import type { GestureKind, StateKey } from './orbitCharacter'
import type { DocentStreamChunk } from './docentService'

/**
 * Subset of {@link OrbitController} / {@link OrbitAvatarNode} the
 * bridge depends on. Duck-typed so test doubles don't need to
 * subclass the full controller, and so a future host that wraps the
 * avatar (e.g. a 2D-companion mount with extra animation hooks)
 * can satisfy the interface without inheriting unrelated behaviour.
 */
export interface OrbitDocentTarget {
  setState(state: StateKey): void
  playGesture(kind: GestureKind): void
  getState(): StateKey
}

/**
 * Pluggable timer surface — defaults to `window.setTimeout` /
 * `clearTimeout`. Tests inject a fake (or use `vi.useFakeTimers()`)
 * to step the bridge through its time-driven transitions
 * deterministically without sleeping.
 */
export interface OrbitDocentBridgeScheduler {
  setTimeout(handler: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface OrbitDocentBridgeOptions {
  /**
   * Hold time on LISTENING before escalating to THINKING when no
   * first-delta chunk arrives. Default 800 ms — tuned to feel
   * responsive on fast LLM paths (cached / local) and to bridge the
   * 2–3 s first-token latency on cloud paths without leaving the
   * avatar idle.
   */
  thinkingDelayMs?: number
  /**
   * How long CONFUSED is held after a fallback `done` before snapping
   * back to CHATTING. Brief by design — reads as "uhh, sorry" not
   * "I have no idea what you said." Default 1500 ms.
   */
  confusedHoldMs?: number
  scheduler?: OrbitDocentBridgeScheduler
}

const DEFAULT_THINKING_DELAY_MS = 800
const DEFAULT_CONFUSED_HOLD_MS = 1500

const defaultScheduler: OrbitDocentBridgeScheduler = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Stateful bridge — one instance per Orbit target. Construct once at
 * mount, dispose at unmount; the bridge tolerates redundant calls
 * (a `done` after a `done`, a chunk before any submit, etc.).
 */
export class OrbitDocentBridge {
  private readonly target: OrbitDocentTarget
  private readonly thinkingDelayMs: number
  private readonly confusedHoldMs: number
  private readonly scheduler: OrbitDocentBridgeScheduler

  /**
   * Whether a stream is currently active — i.e. the user submitted
   * and we haven't seen a `done` (or aborted) yet. Stale chunks that
   * arrive after a stream ends are ignored, so a delayed network
   * tail can't yank the avatar back into TALKING after CHATTING has
   * already settled.
   */
  private streamActive = false
  /** Whether the first `delta` of the current stream has arrived. */
  private gotFirstDelta = false
  private thinkingTimer: unknown = null
  private confusedTimer: unknown = null

  constructor(target: OrbitDocentTarget, options: OrbitDocentBridgeOptions = {}) {
    this.target = target
    this.thinkingDelayMs = options.thinkingDelayMs ?? DEFAULT_THINKING_DELAY_MS
    this.confusedHoldMs = options.confusedHoldMs ?? DEFAULT_CONFUSED_HOLD_MS
    this.scheduler = options.scheduler ?? defaultScheduler
  }

  /**
   * Call when the user submits a message. Sets LISTENING immediately
   * and arms the THINKING escalation timer.
   */
  onUserSubmit(): void {
    this.cancelTimers()
    this.streamActive = true
    this.gotFirstDelta = false
    this.target.setState('LISTENING')
    this.thinkingTimer = this.scheduler.setTimeout(() => {
      this.thinkingTimer = null
      // Race guard: a delta may have arrived between scheduling and
      // firing; only escalate if we're still waiting.
      if (this.streamActive && !this.gotFirstDelta) {
        this.target.setState('THINKING')
      }
    }, this.thinkingDelayMs)
  }

  /** Call for each chunk emitted by the docent stream. */
  onChunk(chunk: DocentStreamChunk): void {
    if (!this.streamActive) return

    switch (chunk.type) {
      case 'delta':
        if (!this.gotFirstDelta) {
          this.gotFirstDelta = true
          this.cancelThinkingTimer()
          this.target.setState('TALKING')
        }
        return
      case 'action':
        this.target.playGesture('beckon')
        return
      case 'auto-load':
        this.target.playGesture('affirm')
        return
      case 'rewrite':
        // A rewrite revises previously-streamed text; the visual is
        // already TALKING (or about to be after the first delta). No
        // state change — the avatar shouldn't flinch when the text
        // beneath it gets revised.
        return
      case 'done':
        this.handleDone(chunk.fallback)
        return
    }
  }

  /**
   * Call when the stream is aborted before a `done` chunk — typically
   * a network error, a user-initiated abort, or a host unmount mid-
   * stream. Treated as a fallback finish so the avatar still ends in
   * a sensible resting state.
   */
  onAbort(): void {
    if (!this.streamActive) return
    this.handleDone(true)
  }

  private handleDone(fallback: boolean): void {
    this.streamActive = false
    this.cancelThinkingTimer()
    if (fallback) {
      this.target.setState('CONFUSED')
      this.confusedTimer = this.scheduler.setTimeout(() => {
        this.confusedTimer = null
        this.target.setState('CHATTING')
      }, this.confusedHoldMs)
    } else {
      this.target.setState('CHATTING')
    }
  }

  private cancelThinkingTimer(): void {
    if (this.thinkingTimer !== null) {
      this.scheduler.clearTimeout(this.thinkingTimer)
      this.thinkingTimer = null
    }
  }

  private cancelTimers(): void {
    this.cancelThinkingTimer()
    if (this.confusedTimer !== null) {
      this.scheduler.clearTimeout(this.confusedTimer)
      this.confusedTimer = null
    }
  }

  /**
   * Stop responding to further events and cancel pending timers.
   * Idempotent. Doesn't reset the avatar's state — the host decides
   * whether a returning-to-IDLE pose is appropriate at unmount.
   */
  dispose(): void {
    this.streamActive = false
    this.cancelTimers()
  }
}
