/**
 * STATES table — the persistent-state vocabulary for the Orbit character.
 *
 * The 14 tuned states below are the output of nine prototype iterations;
 * do not retune them here without updating the design doc first. The
 * design doc is the spec of record now that the prototype is gone.
 *
 * See docs/ORBIT_CHARACTER_DESIGN.md §State and gesture catalog.
 */

import type { StateKey, SubMode, HeadMotion } from './orbitTypes'

export interface StateConfig {
  label: string
  orbitSpeed: number
  orbitRadiusScale: number
  pupilSize: number
  pupilBrightness: number
  pupilPulse: boolean
  pupilJitter: number
  upperLid: number
  lowerLid: number
  subMode: SubMode
  trail: number
  head: HeadMotion
  blinkInterval: number
  blinkDuration: number
  pupilColor?: string
}

// Baseline lid coverage for "open-eye" states. The reference
// concept art has lids visible at all times except during full shock
// — zero-lid eyes read as ghostly/vacant without any top or bottom
// rim. States like IDLE / CHATTING / LISTENING / TALKING get a
// small symmetric coverage (top + bottom each ~8 %) so the lid
// silhouette is always part of the face. SURPRISED and EXCITED
// stay at 0 because those specifically ARE wide-open-eye states
// (shock / thrill).
export const STATES: Record<StateKey, StateConfig> = {
  // Behavior —────────────────────────────────────────────────────────
  IDLE:       { label: 'Idle',       orbitSpeed: 0.5,  orbitRadiusScale: 1.00, pupilSize: 1.00, pupilBrightness: 1.00, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.28, lowerLid: 0.22, subMode: 'orbit',     trail: 0.00, head: 'none',  blinkInterval: 4.0, blinkDuration: 0.14 },
  CHATTING:   { label: 'Chatting',   orbitSpeed: 0.5,  orbitRadiusScale: 1.00, pupilSize: 1.20, pupilBrightness: 1.00, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.28, lowerLid: 0.22, subMode: 'orbit',     trail: 0.00, head: 'none',  blinkInterval: 3.5, blinkDuration: 0.14 },
  LISTENING:  { label: 'Listening',  orbitSpeed: 0.3,  orbitRadiusScale: 1.00, pupilSize: 1.15, pupilBrightness: 0.95, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.28, lowerLid: 0.22, subMode: 'listening', trail: 0.00, head: 'none',  blinkInterval: 5.0, blinkDuration: 0.14 },
  TALKING:    { label: 'Talking',    orbitSpeed: 1.2,  orbitRadiusScale: 1.00, pupilSize: 1.20, pupilBrightness: 1.00, pupilPulse: true,  pupilJitter: 0.00, upperLid: 0.22, lowerLid: 0.18, subMode: 'figure8',   trail: 0.55, head: 'none',  blinkInterval: 3.0, blinkDuration: 0.14 },
  POINTING:   { label: 'Pointing',   orbitSpeed: 0.5,  orbitRadiusScale: 1.00, pupilSize: 0.90, pupilBrightness: 1.10, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.22, lowerLid: 0.10, subMode: 'point',     trail: 1.00, head: 'none',  blinkInterval: 5.0, blinkDuration: 0.14 },
  PRESENTING: { label: 'Presenting', orbitSpeed: 0.4,  orbitRadiusScale: 1.00, pupilSize: 0.95, pupilBrightness: 1.10, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.15, lowerLid: 0.05, subMode: 'trace',     trail: 1.00, head: 'none',  blinkInterval: 4.0, blinkDuration: 0.14 },
  THINKING:   { label: 'Thinking',   orbitSpeed: 0.2,  orbitRadiusScale: 0.70, pupilSize: 0.80, pupilBrightness: 0.80, pupilPulse: false, pupilJitter: 0.03, upperLid: 0.20, lowerLid: 0.05, subMode: 'cluster',   trail: 0.00, head: 'none',  blinkInterval: 3.0, blinkDuration: 0.16 },

  // Emotion —─────────────────────────────────────────────────────────
  CURIOUS:    { label: 'Curious',    orbitSpeed: 0.6,  orbitRadiusScale: 1.00, pupilSize: 1.35, pupilBrightness: 1.05, pupilPulse: false, pupilJitter: 0.05, upperLid: 0.18, lowerLid: 0.18, subMode: 'orbit',     trail: 0.30, head: 'none',  blinkInterval: 3.0, blinkDuration: 0.14 },
  HAPPY:      { label: 'Happy',      orbitSpeed: 0.9,  orbitRadiusScale: 1.05, pupilSize: 1.10, pupilBrightness: 1.10, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.06, lowerLid: 0.48, subMode: 'orbit',     trail: 0.35, head: 'none',  blinkInterval: 2.5, blinkDuration: 0.14 },
  EXCITED:    { label: 'Excited',    orbitSpeed: 2.5,  orbitRadiusScale: 1.30, pupilSize: 1.30, pupilBrightness: 1.20, pupilPulse: false, pupilJitter: 0.35, upperLid: 0.00, lowerLid: 0.00, subMode: 'burst',     trail: 0.70, head: 'none',  blinkInterval: 4.0, blinkDuration: 0.11 },
  SURPRISED:  { label: 'Surprised',  orbitSpeed: 0.2,  orbitRadiusScale: 1.30, pupilSize: 0.55, pupilBrightness: 1.30, pupilPulse: false, pupilJitter: 0.55, upperLid: 0.00, lowerLid: 0.00, subMode: 'scatter',   trail: 0.00, head: 'none',  blinkInterval: 0,   blinkDuration: 0 },
  SLEEPY:     { label: 'Sleepy',     orbitSpeed: 0.15, orbitRadiusScale: 0.80, pupilSize: 0.70, pupilBrightness: 0.45, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.48, lowerLid: 0.42, subMode: 'cluster',   trail: 0.00, head: 'none',  blinkInterval: 1.5, blinkDuration: 0.38 },
  SOLEMN:     { label: 'Solemn',     orbitSpeed: 0.22, orbitRadiusScale: 0.82, pupilSize: 0.85, pupilBrightness: 0.60, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.32, lowerLid: 0.22, subMode: 'cluster',   trail: 0.00, head: 'none',  blinkInterval: 4.5, blinkDuration: 0.22, pupilColor: '#7db5e8' },
  CONFUSED:   { label: 'Confused',   orbitSpeed: 0.35, orbitRadiusScale: 1.10, pupilSize: 0.95, pupilBrightness: 0.90, pupilPulse: false, pupilJitter: 0.40, upperLid: 0.40, lowerLid: 0.40, subMode: 'confused',  trail: 0.00, head: 'tilt',  blinkInterval: 3.2, blinkDuration: 0.18, pupilColor: '#d9a85c' },

  // Head-gesture —────────────────────────────────────────────────────
  YES:        { label: 'Yes',        orbitSpeed: 0.5,  orbitRadiusScale: 0.75, pupilSize: 1.10, pupilBrightness: 1.10, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.08, lowerLid: 0.22, subMode: 'nod',       trail: 0.00, head: 'nod',   blinkInterval: 3.0, blinkDuration: 0.14 },
  NO:         { label: 'No',         orbitSpeed: 0.5,  orbitRadiusScale: 0.75, pupilSize: 0.90, pupilBrightness: 0.95, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.15, lowerLid: 0.08, subMode: 'shake',     trail: 0.00, head: 'shake', blinkInterval: 3.0, blinkDuration: 0.14 },
}

export const BEHAVIOR_STATES: StateKey[] = ['IDLE', 'CHATTING', 'LISTENING', 'TALKING', 'POINTING', 'PRESENTING', 'THINKING']
export const EMOTION_STATES: StateKey[] = ['CURIOUS', 'HAPPY', 'EXCITED', 'SURPRISED', 'SLEEPY', 'SOLEMN', 'CONFUSED']
export const GESTURE_STATES: StateKey[] = ['YES', 'NO']

export const ALL_STATES: StateKey[] = [
  ...BEHAVIOR_STATES,
  ...EMOTION_STATES,
  ...GESTURE_STATES,
]

// -----------------------------------------------------------------------
// EXPRESSIONS — procedural squash/stretch parameters per state.
//
// Kept separate from STATES on purpose: STATES encodes *motion*
// (orbit speed, pupil size, lid angles) and is locked pending a
// design-doc update. EXPRESSIONS encodes *shape* (breathing cadence,
// melt, hop, gasp, talk pulse) and is additive — every state falls
// back to EXPRESSION_DEFAULT unless it names an override.
//
// Adding a new state only requires (a) extending `StateKey` in
// orbitTypes.ts and (b) adding the motion row to STATES; omitting
// it from EXPRESSIONS just means it breathes at the default pace.
// Adding new fields to ExpressionConfig defaults sanely via the
// spread in expressionFor, so old entries don't need to be
// retrofitted. See `docs/ORBIT_CHARACTER_VINYL_REDESIGN.md` §5.
// -----------------------------------------------------------------------

export interface ExpressionConfig {
  /** Breath cycles per second. */
  breathRate: number
  /** Peak Y-scale offset during breathing. X/Z move inversely. */
  breathAmp: number
  /**
   * Extra X/Z widening for "melted" low-energy states (SLEEPY,
   * SOLEMN). Added to the X/Z scale on top of the breathing
   * offset. Leave at 0 for normal states.
   */
  meltXZ: number
  /**
   * Rhythmic Y hop layered on top of the breathing curve — reads as
   * "barely contained excitement." Triggered at twice the breath
   * rate. Use 0 for most states; EXCITED sets a small non-zero amp.
   */
  hopAmp: number
  /**
   * One-shot spring when entering this state — a sharp Y stretch
   * followed by a damped oscillation back to rest. Used by
   * SURPRISED.
   */
  surpriseGasp: boolean
  /**
   * Pulse sub-sphere scales in time with the pupil pulse. Reads as
   * the satellites "breathing with the voice." Used by TALKING.
   */
  talkPulse: boolean
  /**
   * Sparkle trail intensity. 0 hides the trail entirely; 1.0 is full
   * brightness. During steady idle orbit (submode = 'orbit') the
   * long trail buffer wraps into a visible sparkle ring; during
   * breakaway sub-modes (POINTING / TRACE / BURST) the same trail
   * reads as a comet wake behind the sub. See
   * `docs/ORBIT_CHARACTER_VINYL_REDESIGN.md` §4.
   */
  trailIntensity: number
  /**
   * Visible trail length in world space — the path distance (in
   * metres) behind the sub at which the trail fades to zero. Drives
   * the sparkle shader's `uFadeEnd` uniform. Because alpha is now
   * distance-based rather than age-based, this controls how long
   * the trail APPEARS regardless of how fast the sub is moving:
   *
   *   - Slow states (IDLE, CHATTING, LISTENING): a long fade
   *     distance (~0.65 m) so the trail wraps the full orbit
   *     circumference and reads as a closed sparkle ring.
   *   - Expressive states (TALKING, POINTING, PRESENTING): medium
   *     fade so the trail reads as a comet wake, long enough to
   *     convey direction.
   *   - Fast states (EXCITED): short fade so the sub doesn't leave
   *     a "star field" behind at high speed.
   */
  trailFadeDistance: number
}

export const EXPRESSION_DEFAULT: ExpressionConfig = {
  breathRate: 0.8,
  breathAmp: 0.012,
  meltXZ: 0,
  hopAmp: 0,
  surpriseGasp: false,
  talkPulse: false,
  trailIntensity: 0.80,
  trailFadeDistance: 0.45,
}

/**
 * Per-state overrides — only list the fields that differ from
 * EXPRESSION_DEFAULT. Every state not mentioned here gets the
 * default silently (extensibility requirement).
 *
 * Trail intensity ranges:
 *   - quiet states (SLEEPY, SOLEMN, THINKING): 0.25–0.40 — trail
 *     still visible but dim, reads as "barely there wake."
 *   - default active states: 0.80 (fallback).
 *   - expressive states (TALKING, POINTING, PRESENTING, EXCITED):
 *     0.9–1.2 — trail is a primary visual element in these modes.
 */
export const EXPRESSIONS: Partial<Record<StateKey, Partial<ExpressionConfig>>> = {
  // Quiet / slow states — long fade distance so the trail wraps the
  // full orbit circumference and reads as a closed sparkle ring.
  IDLE:       { trailFadeDistance: 0.65 },
  CHATTING:   { trailFadeDistance: 0.65 },
  LISTENING:  { trailFadeDistance: 0.60 },
  SLEEPY:     { breathRate: 0.35, breathAmp: 0.018, meltXZ: 0.025, trailIntensity: 0.25, trailFadeDistance: 0.50 },
  SOLEMN:     { breathRate: 0.40, breathAmp: 0.015, meltXZ: 0.018, trailIntensity: 0.35, trailFadeDistance: 0.50 },
  THINKING:   { breathRate: 0.55, breathAmp: 0.014, trailIntensity: 0.30, trailFadeDistance: 0.40 },
  // Expressive — medium fade, trail reads as a comet tail conveying
  // direction.
  TALKING:    { talkPulse: true, trailIntensity: 0.95, trailFadeDistance: 0.35 },
  HAPPY:      { trailIntensity: 0.95, trailFadeDistance: 0.45 },
  CURIOUS:    { trailIntensity: 0.90, trailFadeDistance: 0.45 },
  POINTING:   { trailIntensity: 1.10, trailFadeDistance: 0.40 },
  PRESENTING: { trailIntensity: 1.10, trailFadeDistance: 0.40 },
  SURPRISED:  { breathRate: 0.8,  breathAmp: 0.004, surpriseGasp: true, trailIntensity: 0.90, trailFadeDistance: 0.30 },
  // Fast state — short fade so the sub's high speed doesn't paint a
  // star field behind it.
  EXCITED:    { breathRate: 2.4,  breathAmp: 0.006, hopAmp: 0.010, trailIntensity: 1.15, trailFadeDistance: 0.22 },
}

/** Merge the per-state override (if any) with EXPRESSION_DEFAULT. */
export function expressionFor(state: StateKey): ExpressionConfig {
  return { ...EXPRESSION_DEFAULT, ...(EXPRESSIONS[state] ?? {}) }
}
