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

export const STATES: Record<StateKey, StateConfig> = {
  // Behavior —────────────────────────────────────────────────────────
  IDLE:       { label: 'Idle',       orbitSpeed: 0.5,  orbitRadiusScale: 1.00, pupilSize: 1.00, pupilBrightness: 1.00, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.00, lowerLid: 0.00, subMode: 'orbit',     trail: 0.00, head: 'none',  blinkInterval: 4.0, blinkDuration: 0.14 },
  CHATTING:   { label: 'Chatting',   orbitSpeed: 0.5,  orbitRadiusScale: 1.00, pupilSize: 1.20, pupilBrightness: 1.00, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.00, lowerLid: 0.00, subMode: 'orbit',     trail: 0.00, head: 'none',  blinkInterval: 3.5, blinkDuration: 0.14 },
  LISTENING:  { label: 'Listening',  orbitSpeed: 0.3,  orbitRadiusScale: 1.00, pupilSize: 1.15, pupilBrightness: 0.95, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.00, lowerLid: 0.00, subMode: 'listening', trail: 0.00, head: 'none',  blinkInterval: 5.0, blinkDuration: 0.14 },
  TALKING:    { label: 'Talking',    orbitSpeed: 1.2,  orbitRadiusScale: 1.00, pupilSize: 1.20, pupilBrightness: 1.00, pupilPulse: true,  pupilJitter: 0.00, upperLid: 0.00, lowerLid: 0.00, subMode: 'figure8',   trail: 0.55, head: 'none',  blinkInterval: 3.0, blinkDuration: 0.14 },
  POINTING:   { label: 'Pointing',   orbitSpeed: 0.5,  orbitRadiusScale: 1.00, pupilSize: 0.90, pupilBrightness: 1.10, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.22, lowerLid: 0.10, subMode: 'point',     trail: 1.00, head: 'none',  blinkInterval: 5.0, blinkDuration: 0.14 },
  PRESENTING: { label: 'Presenting', orbitSpeed: 0.4,  orbitRadiusScale: 1.00, pupilSize: 0.95, pupilBrightness: 1.10, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.15, lowerLid: 0.05, subMode: 'trace',     trail: 1.00, head: 'none',  blinkInterval: 4.0, blinkDuration: 0.14 },
  THINKING:   { label: 'Thinking',   orbitSpeed: 0.2,  orbitRadiusScale: 0.70, pupilSize: 0.80, pupilBrightness: 0.80, pupilPulse: false, pupilJitter: 0.03, upperLid: 0.20, lowerLid: 0.05, subMode: 'cluster',   trail: 0.00, head: 'none',  blinkInterval: 3.0, blinkDuration: 0.16 },

  // Emotion —─────────────────────────────────────────────────────────
  CURIOUS:    { label: 'Curious',    orbitSpeed: 0.6,  orbitRadiusScale: 1.00, pupilSize: 1.35, pupilBrightness: 1.05, pupilPulse: false, pupilJitter: 0.05, upperLid: 0.00, lowerLid: 0.00, subMode: 'orbit',     trail: 0.30, head: 'none',  blinkInterval: 3.0, blinkDuration: 0.14 },
  HAPPY:      { label: 'Happy',      orbitSpeed: 0.9,  orbitRadiusScale: 1.05, pupilSize: 1.10, pupilBrightness: 1.10, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.06, lowerLid: 0.48, subMode: 'orbit',     trail: 0.35, head: 'none',  blinkInterval: 2.5, blinkDuration: 0.14 },
  EXCITED:    { label: 'Excited',    orbitSpeed: 2.5,  orbitRadiusScale: 1.30, pupilSize: 1.30, pupilBrightness: 1.20, pupilPulse: false, pupilJitter: 0.35, upperLid: 0.00, lowerLid: 0.00, subMode: 'burst',     trail: 0.70, head: 'none',  blinkInterval: 4.0, blinkDuration: 0.11 },
  SURPRISED:  { label: 'Surprised',  orbitSpeed: 0.2,  orbitRadiusScale: 1.30, pupilSize: 0.55, pupilBrightness: 1.30, pupilPulse: false, pupilJitter: 0.55, upperLid: 0.00, lowerLid: 0.00, subMode: 'scatter',   trail: 0.00, head: 'none',  blinkInterval: 0,   blinkDuration: 0 },
  SLEEPY:     { label: 'Sleepy',     orbitSpeed: 0.15, orbitRadiusScale: 0.80, pupilSize: 0.70, pupilBrightness: 0.45, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.56, lowerLid: 0.18, subMode: 'cluster',   trail: 0.00, head: 'none',  blinkInterval: 1.5, blinkDuration: 0.38 },
  SOLEMN:     { label: 'Solemn',     orbitSpeed: 0.22, orbitRadiusScale: 0.82, pupilSize: 0.85, pupilBrightness: 0.60, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.24, lowerLid: 0.08, subMode: 'cluster',   trail: 0.00, head: 'none',  blinkInterval: 4.5, blinkDuration: 0.22, pupilColor: '#7db5e8' },
  CONFUSED:   { label: 'Confused',   orbitSpeed: 0.35, orbitRadiusScale: 1.10, pupilSize: 0.95, pupilBrightness: 0.90, pupilPulse: false, pupilJitter: 0.40, upperLid: 0.08, lowerLid: 0.12, subMode: 'confused',  trail: 0.00, head: 'tilt',  blinkInterval: 3.2, blinkDuration: 0.18, pupilColor: '#d9a85c' },

  // Head-gesture —────────────────────────────────────────────────────
  YES:        { label: 'Yes',        orbitSpeed: 0.5,  orbitRadiusScale: 0.75, pupilSize: 1.10, pupilBrightness: 1.10, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.00, lowerLid: 0.22, subMode: 'nod',       trail: 0.00, head: 'nod',   blinkInterval: 3.0, blinkDuration: 0.14 },
  NO:         { label: 'No',         orbitSpeed: 0.5,  orbitRadiusScale: 0.75, pupilSize: 0.90, pupilBrightness: 0.95, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.15, lowerLid: 0.00, subMode: 'shake',     trail: 0.00, head: 'shake', blinkInterval: 3.0, blinkDuration: 0.14 },
}

export const BEHAVIOR_STATES: StateKey[] = ['IDLE', 'CHATTING', 'LISTENING', 'TALKING', 'POINTING', 'PRESENTING', 'THINKING']
export const EMOTION_STATES: StateKey[] = ['CURIOUS', 'HAPPY', 'EXCITED', 'SURPRISED', 'SLEEPY', 'SOLEMN', 'CONFUSED']
export const GESTURE_STATES: StateKey[] = ['YES', 'NO']

export const ALL_STATES: StateKey[] = [
  ...BEHAVIOR_STATES,
  ...EMOTION_STATES,
  ...GESTURE_STATES,
]
