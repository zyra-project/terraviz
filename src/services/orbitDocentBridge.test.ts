import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OrbitDocentBridge, type OrbitDocentTarget } from './orbitDocentBridge'
import type { DocentStreamChunk } from './docentService'
import type { ChatAction } from '../types'
import type { GestureKind, StateKey } from './orbitCharacter'

/**
 * Minimal mock target — records every setState / playGesture call in
 * order so each test can assert on the exact sequence the bridge
 * produced. Initial getState() is IDLE, the avatar's resting pose.
 */
function createTarget(): {
  target: OrbitDocentTarget
  states: StateKey[]
  gestures: GestureKind[]
} {
  const states: StateKey[] = []
  const gestures: GestureKind[] = []
  let current: StateKey = 'IDLE'
  return {
    target: {
      setState: (s: StateKey) => {
        current = s
        states.push(s)
      },
      playGesture: (g: GestureKind) => {
        gestures.push(g)
      },
      getState: () => current,
    },
    states,
    gestures,
  }
}

const fakeAction: ChatAction = {
  type: 'load-dataset',
  datasetId: 'INTERNAL_TEST',
  datasetTitle: 'Test Dataset',
}

describe('OrbitDocentBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('switches to LISTENING on user submit', () => {
    const { target, states } = createTarget()
    const bridge = new OrbitDocentBridge(target)

    bridge.onUserSubmit()

    expect(states).toEqual(['LISTENING'])
  })

  it('escalates to THINKING after the configured delay when no delta arrives', () => {
    const { target, states } = createTarget()
    const bridge = new OrbitDocentBridge(target, { thinkingDelayMs: 500 })

    bridge.onUserSubmit()
    vi.advanceTimersByTime(499)
    expect(states).toEqual(['LISTENING'])

    vi.advanceTimersByTime(1)
    expect(states).toEqual(['LISTENING', 'THINKING'])
  })

  it('skips THINKING when the first delta arrives before the timer fires', () => {
    const { target, states } = createTarget()
    const bridge = new OrbitDocentBridge(target, { thinkingDelayMs: 500 })

    bridge.onUserSubmit()
    vi.advanceTimersByTime(200)
    bridge.onChunk({ type: 'delta', text: 'Hello' })
    // Advance well past the original timer — should NOT escalate.
    vi.advanceTimersByTime(1000)

    expect(states).toEqual(['LISTENING', 'TALKING'])
  })

  it('drives TALKING from LISTENING on the first delta only', () => {
    const { target, states } = createTarget()
    const bridge = new OrbitDocentBridge(target)

    bridge.onUserSubmit()
    bridge.onChunk({ type: 'delta', text: 'Hello' })
    bridge.onChunk({ type: 'delta', text: ' world' })
    bridge.onChunk({ type: 'delta', text: '!' })

    // Two LISTENING / TALKING transitions, no extra TALKING re-entries.
    expect(states).toEqual(['LISTENING', 'TALKING'])
  })

  it('drives TALKING from THINKING when delta arrives mid-think', () => {
    const { target, states } = createTarget()
    const bridge = new OrbitDocentBridge(target, { thinkingDelayMs: 500 })

    bridge.onUserSubmit()
    vi.advanceTimersByTime(500)
    bridge.onChunk({ type: 'delta', text: 'Hello' })

    expect(states).toEqual(['LISTENING', 'THINKING', 'TALKING'])
  })

  it('plays beckon gesture on action chunks', () => {
    const { target, gestures } = createTarget()
    const bridge = new OrbitDocentBridge(target)

    bridge.onUserSubmit()
    bridge.onChunk({ type: 'action', action: fakeAction })

    expect(gestures).toEqual(['beckon'])
  })

  it('plays affirm gesture on auto-load chunks', () => {
    const { target, gestures } = createTarget()
    const bridge = new OrbitDocentBridge(target)

    bridge.onUserSubmit()
    bridge.onChunk({ type: 'auto-load', action: fakeAction, alternatives: [] })

    expect(gestures).toEqual(['affirm'])
  })

  it('ignores rewrite chunks (no state or gesture change)', () => {
    const { target, states, gestures } = createTarget()
    const bridge = new OrbitDocentBridge(target)

    bridge.onUserSubmit()
    bridge.onChunk({ type: 'delta', text: 'Hi' })
    bridge.onChunk({ type: 'rewrite', text: 'Hello there' })

    expect(states).toEqual(['LISTENING', 'TALKING'])
    expect(gestures).toEqual([])
  })

  it('settles in CHATTING on a normal done', () => {
    const { target, states } = createTarget()
    const bridge = new OrbitDocentBridge(target)

    bridge.onUserSubmit()
    bridge.onChunk({ type: 'delta', text: 'Hi' })
    bridge.onChunk({ type: 'done', fallback: false })

    expect(states).toEqual(['LISTENING', 'TALKING', 'CHATTING'])
  })

  it('shows CONFUSED then CHATTING on a fallback done', () => {
    const { target, states } = createTarget()
    const bridge = new OrbitDocentBridge(target, { confusedHoldMs: 1500 })

    bridge.onUserSubmit()
    bridge.onChunk({ type: 'delta', text: 'Hi' })
    bridge.onChunk({ type: 'done', fallback: true })
    expect(states).toEqual(['LISTENING', 'TALKING', 'CONFUSED'])

    vi.advanceTimersByTime(1500)
    expect(states).toEqual(['LISTENING', 'TALKING', 'CONFUSED', 'CHATTING'])
  })

  it('treats onAbort the same as a fallback done', () => {
    const { target, states } = createTarget()
    const bridge = new OrbitDocentBridge(target, { confusedHoldMs: 1500 })

    bridge.onUserSubmit()
    bridge.onAbort()
    expect(states).toEqual(['LISTENING', 'CONFUSED'])

    vi.advanceTimersByTime(1500)
    expect(states).toEqual(['LISTENING', 'CONFUSED', 'CHATTING'])
  })

  it('ignores chunks before any submit', () => {
    const { target, states, gestures } = createTarget()
    const bridge = new OrbitDocentBridge(target)

    bridge.onChunk({ type: 'delta', text: 'orphan' })
    bridge.onChunk({ type: 'done', fallback: false })

    expect(states).toEqual([])
    expect(gestures).toEqual([])
  })

  it('ignores chunks that arrive after a done settles the stream', () => {
    const { target, states, gestures } = createTarget()
    const bridge = new OrbitDocentBridge(target)

    bridge.onUserSubmit()
    bridge.onChunk({ type: 'delta', text: 'Hi' })
    bridge.onChunk({ type: 'done', fallback: false })
    // Late tail — should be inert.
    bridge.onChunk({ type: 'delta', text: 'late' })
    bridge.onChunk({ type: 'action', action: fakeAction })

    expect(states).toEqual(['LISTENING', 'TALKING', 'CHATTING'])
    expect(gestures).toEqual([])
  })

  it('cancels pending CONFUSED timer when a new submit arrives', () => {
    const { target, states } = createTarget()
    // Bump the THINKING delay well past the test window so this test
    // isolates the CONFUSED → CHATTING cancel behaviour. (A separate
    // test covers THINKING escalation explicitly.)
    const bridge = new OrbitDocentBridge(target, {
      thinkingDelayMs: 10_000,
      confusedHoldMs: 1500,
    })

    bridge.onUserSubmit()
    bridge.onAbort() // schedules CONFUSED → CHATTING
    bridge.onUserSubmit() // user fires off another message before the timer

    // Step well past the original confusedHoldMs — the cancelled
    // CHATTING transition must NOT fire on top of the new LISTENING.
    vi.advanceTimersByTime(2000)
    expect(states).toEqual(['LISTENING', 'CONFUSED', 'LISTENING'])
  })

  it('dispose cancels pending timers and silences future chunks', () => {
    const { target, states, gestures } = createTarget()
    const bridge = new OrbitDocentBridge(target, {
      thinkingDelayMs: 500,
      confusedHoldMs: 1500,
    })

    bridge.onUserSubmit()
    bridge.dispose()
    vi.advanceTimersByTime(2000)

    bridge.onChunk({ type: 'delta', text: 'Hi' })
    bridge.onChunk({ type: 'action', action: fakeAction })

    // Only the synchronous LISTENING from the original submit should
    // have landed. No THINKING (cancelled), no TALKING (post-dispose),
    // no beckon (post-dispose).
    expect(states).toEqual(['LISTENING'])
    expect(gestures).toEqual([])
  })
})
