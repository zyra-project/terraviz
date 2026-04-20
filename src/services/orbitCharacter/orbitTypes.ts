/**
 * Shared types for the Orbit character.
 *
 * Enums mirror the design doc's state-and-gesture catalog. `GestureKind`
 * populates in Phase 3 (gesture overlays); `ScaleKey` is wired in Phase 4.
 */

export type PaletteKey = 'cyan' | 'green' | 'amber' | 'violet'

export type ScaleKey = 'close' | 'continental' | 'planetary'

/**
 * Eye configuration — design A/B between an iconic single inset
 * lens-eye (EVE / BB-8 lineage) and a mammalian paired-eye rig that
 * enables vergence cues. Both modes share the same eye-field /
 * pupil shaders and gaze code; only geometry placement and pupil
 * excursion scaling differ. Persisted across page loads via URL
 * param so design reviews can deep-link directly into a config.
 */
export type EyeMode = 'one' | 'two'

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
}

export const PALETTES: Record<PaletteKey, Palette> = {
  cyan:   { base: '#faf5e8', accent: '#5cefd7', glow: '#a8f5e5' },
  green:  { base: '#faf5e8', accent: '#7eef5c', glow: '#b5f5a0' },
  amber:  { base: '#fff5e0', accent: '#efb75c', glow: '#f5d8a0' },
  violet: { base: '#f5f0fa', accent: '#b87cef', glow: '#d4b0f5' },
}
