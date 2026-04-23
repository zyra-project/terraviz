/**
 * Shared types for the Orbit character.
 *
 * Enums mirror the design doc's state-and-gesture catalog. `GestureKind`
 * populates in Phase 3 (gesture overlays); `ScaleKey` is wired in Phase 4.
 */

export type PaletteKey = 'cyan' | 'green' | 'amber' | 'violet'

export type ScaleKey = 'close' | 'continental' | 'planetary'

/**
 * Eye configuration — narrowed to a single literal as part of the
 * vinyl-toy redesign (see `docs/ORBIT_CHARACTER_VINYL_REDESIGN.md`).
 * The original single-lens configuration read as ominous; the
 * paired-eye rig is now permanent. The type alias stays so any
 * lingering external callers still compile; setters just validate
 * against the one legal value.
 */
export type EyeMode = 'two'

// Behavior register — who Orbit is being.
export type BehaviorState =
  | 'IDLE' | 'CHATTING' | 'LISTENING' | 'TALKING'
  | 'POINTING' | 'PRESENTING' | 'THINKING'

// Emotion register — how Orbit feels about what it's doing.
export type EmotionState =
  | 'CURIOUS' | 'HAPPY' | 'EXCITED' | 'SURPRISED'
  | 'SLEEPY' | 'SOLEMN' | 'CONFUSED'

// Head-gesture register — dwell-able full-body responses.
export type HeadGestureState = 'YES' | 'NO'

export type StateKey = BehaviorState | EmotionState | HeadGestureState

export type { GestureKind } from './orbitGestures'

export type SubMode =
  | 'orbit' | 'figure8' | 'point' | 'trace'
  | 'cluster' | 'burst' | 'scatter' | 'listening'
  | 'nod' | 'shake' | 'confused'

export type HeadMotion = 'none' | 'nod' | 'shake' | 'tilt'

export interface Palette {
  base: string
  accent: string
  glow: string
  /**
   * Left side of the vinyl body's horizontal gradient. The four
   * defaults all read as "soft toy": warm pink / mint / peach /
   * lavender. Paired with `cool` via `onBeforeCompile` gradient
   * injection in `createBodyMaterial`.
   */
  warm: string
  /** Right side of the vinyl body's horizontal gradient. */
  cool: string
}

export const PALETTES: Record<PaletteKey, Palette> = {
  cyan:   { base: '#faf5e8', accent: '#5cefd7', glow: '#a8f5e5', warm: '#f7c9d6', cool: '#c9e6e5' },
  green:  { base: '#faf5e8', accent: '#7eef5c', glow: '#b5f5a0', warm: '#d6f0c9', cool: '#c9d6f0' },
  amber:  { base: '#fff5e0', accent: '#efb75c', glow: '#f5d8a0', warm: '#f7d9b8', cool: '#f2e9cf' },
  violet: { base: '#f5f0fa', accent: '#b87cef', glow: '#d4b0f5', warm: '#e4cdf7', cool: '#f7cde0' },
}
