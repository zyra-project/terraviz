import { describe, expect, it } from 'vitest'
import {
  appendTask,
  createEmptyState,
  moveTask,
  removeTaskAt,
  updateTaskAt,
} from './state'
import type { TourTaskDef } from '../../types'

const FLY: TourTaskDef = { flyTo: { lat: 0, lon: 0, altmi: 1000, animated: true } }
const PAUSE: TourTaskDef = { pauseSeconds: 5 }
const LOOP: TourTaskDef = { loopToBeginning: '' }

describe('createEmptyState + appendTask', () => {
  it('creates an empty state with the supplied tourId', () => {
    const s = createEmptyState('new')
    expect(s).toEqual({ tourId: 'new', title: '', tasks: [] })
  })

  it('appendTask returns a new state (no aliasing)', () => {
    const a = createEmptyState('new')
    const b = appendTask(a, FLY)
    expect(b).not.toBe(a)
    expect(b.tasks).toEqual([FLY])
    expect(a.tasks).toEqual([])
  })
})

describe('removeTaskAt', () => {
  it('drops the task at the given index', () => {
    const s = appendTask(appendTask(createEmptyState('new'), FLY), PAUSE)
    const after = removeTaskAt(s, 0)
    expect(after.tasks).toEqual([PAUSE])
  })

  it('no-ops on out-of-range indices', () => {
    const s = appendTask(createEmptyState('new'), FLY)
    expect(removeTaskAt(s, -1)).toBe(s)
    expect(removeTaskAt(s, 99)).toBe(s)
  })
})

describe('moveTask (tour/D)', () => {
  it('moves a task from one index to another', () => {
    const s = appendTask(
      appendTask(appendTask(createEmptyState('new'), FLY), PAUSE),
      LOOP,
    )
    // Move index 2 (LOOP) → index 0
    const after = moveTask(s, 2, 0)
    expect(after.tasks).toEqual([LOOP, FLY, PAUSE])
  })

  it('moves earlier → later (drop the dragged behind the target)', () => {
    const s = appendTask(
      appendTask(appendTask(createEmptyState('new'), FLY), PAUSE),
      LOOP,
    )
    // 0 → 2: FLY moves to the end
    const after = moveTask(s, 0, 2)
    expect(after.tasks).toEqual([PAUSE, LOOP, FLY])
  })

  it('no-ops on out-of-range or self-move', () => {
    const s = appendTask(createEmptyState('new'), FLY)
    expect(moveTask(s, 0, 0)).toBe(s)
    expect(moveTask(s, -1, 0)).toBe(s)
    expect(moveTask(s, 0, 99)).toBe(s)
  })
})

describe('updateTaskAt (tour/D)', () => {
  it('replaces the task at the given index', () => {
    const s = appendTask(appendTask(createEmptyState('new'), FLY), PAUSE)
    const after = updateTaskAt(s, 1, LOOP)
    expect(after.tasks).toEqual([FLY, LOOP])
  })

  it('no-ops on out-of-range index', () => {
    const s = appendTask(createEmptyState('new'), FLY)
    expect(updateTaskAt(s, 99, PAUSE)).toBe(s)
  })
})
