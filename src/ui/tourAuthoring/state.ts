/**
 * In-memory tour-authoring state — the dock reads / writes here as
 * the publisher captures tasks; the autosave manager
 * (`autosave.ts`) flushes to R2 + the `tours` row.
 *
 * Only the model + reducers live here. The dock owns the
 * orchestration (capture buttons, render loop) and the autosave
 * manager owns the persistence loop; this module is deliberately
 * narrow so the reducers can be tested in isolation. The id is
 * either a server-issued ULID (when the dock opens against an
 * existing tour) or the sentinel `'new'` (fresh draft, no
 * backend row yet — promoted to a ULID after the first save).
 */

import type { TourTaskDef } from '../../types'

export interface TourAuthoringState {
  /** Server ULID for an existing tour, or `'new'` for a fresh draft. */
  tourId: string
  /** Free-text title kept in sync with the dock's rename input.
   *  The dock is the source of truth for the live value; this
   *  field is here for parity with the persisted row shape. */
  title: string
  /** Ordered list of tour tasks captured so far. */
  tasks: TourTaskDef[]
}

export function createEmptyState(tourId: string): TourAuthoringState {
  return { tourId, title: '', tasks: [] }
}

/** Append a captured task. Returns a new state object so the caller
 *  can re-render without aliasing. */
export function appendTask(
  state: TourAuthoringState,
  task: TourTaskDef,
): TourAuthoringState {
  return { ...state, tasks: [...state.tasks, task] }
}

/** Remove the task at `index`. */
export function removeTaskAt(
  state: TourAuthoringState,
  index: number,
): TourAuthoringState {
  if (index < 0 || index >= state.tasks.length) return state
  const next = state.tasks.slice()
  next.splice(index, 1)
  return { ...state, tasks: next }
}

/** Move a task from `fromIndex` to `toIndex`. Used by the drag-
 *  to-reorder editor (tour/D). No-op when either index is out
 *  of range or the move is a self-noop — keeps the rendering
 *  call site oblivious to drop-on-self gestures. */
export function moveTask(
  state: TourAuthoringState,
  fromIndex: number,
  toIndex: number,
): TourAuthoringState {
  if (
    fromIndex < 0 ||
    fromIndex >= state.tasks.length ||
    toIndex < 0 ||
    toIndex >= state.tasks.length ||
    fromIndex === toIndex
  ) {
    return state
  }
  const next = state.tasks.slice()
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return { ...state, tasks: next }
}

/** Replace the task at `index`. Used by the click-to-edit JSON
 *  textarea (tour/D). No-op on out-of-range indices. The caller
 *  is responsible for validating the new task shape — the model
 *  trusts well-formed `TourTaskDef` input. */
export function updateTaskAt(
  state: TourAuthoringState,
  index: number,
  task: TourTaskDef,
): TourAuthoringState {
  if (index < 0 || index >= state.tasks.length) return state
  const next = state.tasks.slice()
  next[index] = task
  return { ...state, tasks: next }
}
