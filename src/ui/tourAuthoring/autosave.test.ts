import { describe, expect, it, vi } from 'vitest'
import { createAutosaveManager } from './autosave'
import type { TourFile } from '../../types'

interface FakeScheduler {
  scheduled: Array<() => void>
  setTimeout: (cb: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  flushOne: () => void
}

function makeScheduler(): FakeScheduler {
  const scheduled: Array<() => void> = []
  return {
    scheduled,
    setTimeout: (cb: () => void) => {
      const handle = scheduled.length
      scheduled.push(cb)
      return handle
    },
    clearTimeout: (handle: unknown) => {
      const idx = handle as number
      if (idx >= 0 && idx < scheduled.length) scheduled[idx] = () => {}
    },
    flushOne: () => {
      const cb = scheduled.shift()
      cb?.()
    },
  }
}

function emptyTour(): TourFile {
  return { tourTasks: [] }
}

describe('createAutosaveManager (tour/E)', () => {
  it('on first save against tourId="new", POSTs /draft then PUTs the JSON', async () => {
    const createDraft = vi.fn(async () => ({ tour: { id: 'NEWID', slug: 'x', title: 't', tour_json_ref: 'r2:...', updated_at: 't' } }))
    const saveTourJson = vi.fn(async () => ({ tour: { id: 'NEWID', slug: 'x', title: 't', tour_json_ref: 'r2:...', updated_at: 't2' } }))
    const sched = makeScheduler()
    const onTourIdResolved = vi.fn()
    const onStatusChange = vi.fn()
    const mgr = createAutosaveManager(
      'new',
      { onStatusChange, onTourIdResolved },
      {
        debounceMs: 100,
        api: { createDraftTour: createDraft, saveTourJson },
        scheduler: { setTimeout: sched.setTimeout, clearTimeout: sched.clearTimeout },
      },
    )
    mgr.requestSave(emptyTour())
    expect(createDraft).not.toHaveBeenCalled() // still debounced
    sched.flushOne()
    // Pump microtasks for the async chain.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(createDraft).toHaveBeenCalledOnce()
    expect(saveTourJson).toHaveBeenCalledOnce()
    expect(saveTourJson).toHaveBeenCalledWith('NEWID', emptyTour())
    expect(mgr.getTourId()).toBe('NEWID')
    expect(onTourIdResolved).toHaveBeenCalledWith('NEWID')
    // Status flow: saving → saved.
    const statusCalls = onStatusChange.mock.calls.map(c => c[0])
    expect(statusCalls[0]).toBe('saving')
    expect(statusCalls.at(-1)).toBe('saved')
  })

  it('subsequent saves skip the create-draft step', async () => {
    const createDraft = vi.fn(async () => ({ tour: { id: 'NEWID', slug: 'x', title: 't', tour_json_ref: 'r2:...', updated_at: 't' } }))
    const saveTourJson = vi.fn(async () => ({ tour: { id: 'NEWID', slug: 'x', title: 't', tour_json_ref: 'r2:...', updated_at: 't2' } }))
    const sched = makeScheduler()
    const mgr = createAutosaveManager(
      'new',
      { onStatusChange: () => {} },
      {
        debounceMs: 100,
        api: { createDraftTour: createDraft, saveTourJson },
        scheduler: { setTimeout: sched.setTimeout, clearTimeout: sched.clearTimeout },
      },
    )
    mgr.requestSave(emptyTour())
    sched.flushOne()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    mgr.requestSave({ tourTasks: [{ pauseSeconds: 5 }] })
    sched.flushOne()
    await Promise.resolve()
    await Promise.resolve()
    expect(createDraft).toHaveBeenCalledOnce()
    expect(saveTourJson).toHaveBeenCalledTimes(2)
    expect(saveTourJson).toHaveBeenNthCalledWith(2, 'NEWID', { tourTasks: [{ pauseSeconds: 5 }] })
  })

  it('opens against an existing id and PUTs directly (no draft create)', async () => {
    const createDraft = vi.fn()
    const saveTourJson = vi.fn(async () => ({ tour: { id: 'EXISTING', slug: 'x', title: 't', tour_json_ref: 'r2:...', updated_at: 't' } }))
    const sched = makeScheduler()
    const mgr = createAutosaveManager(
      'EXISTING',
      { onStatusChange: () => {} },
      {
        debounceMs: 100,
        api: { createDraftTour: createDraft, saveTourJson },
        scheduler: { setTimeout: sched.setTimeout, clearTimeout: sched.clearTimeout },
      },
    )
    mgr.requestSave(emptyTour())
    sched.flushOne()
    await Promise.resolve()
    await Promise.resolve()
    expect(createDraft).not.toHaveBeenCalled()
    expect(saveTourJson).toHaveBeenCalledWith('EXISTING', emptyTour())
  })

  it('debounces — two requestSave calls within the window produce one save', async () => {
    const saveTourJson = vi.fn(async () => ({ tour: { id: 'X', slug: 'x', title: 't', tour_json_ref: 'r2:...', updated_at: 't' } }))
    const sched = makeScheduler()
    const mgr = createAutosaveManager(
      'X',
      { onStatusChange: () => {} },
      {
        debounceMs: 100,
        api: { createDraftTour: vi.fn(), saveTourJson },
        scheduler: { setTimeout: sched.setTimeout, clearTimeout: sched.clearTimeout },
      },
    )
    mgr.requestSave({ tourTasks: [{ pauseSeconds: 1 }] })
    mgr.requestSave({ tourTasks: [{ pauseSeconds: 2 }] })
    mgr.requestSave({ tourTasks: [{ pauseSeconds: 3 }] })
    // Only the last `setTimeout` is live — the earlier ones got
    // cleared. flushOne walks the queue in insertion order; the
    // first two are no-ops (cleared), the third runs the save.
    sched.flushOne()
    sched.flushOne()
    sched.flushOne()
    await Promise.resolve()
    await Promise.resolve()
    expect(saveTourJson).toHaveBeenCalledOnce()
    expect(saveTourJson).toHaveBeenCalledWith('X', { tourTasks: [{ pauseSeconds: 3 }] })
  })

  it('surfaces server errors via onStatusChange', async () => {
    const saveTourJson = vi.fn(async () => ({ error: 'Server error (500)' }))
    const sched = makeScheduler()
    const onStatusChange = vi.fn()
    const mgr = createAutosaveManager(
      'X',
      { onStatusChange },
      {
        debounceMs: 100,
        api: { createDraftTour: vi.fn(), saveTourJson },
        scheduler: { setTimeout: sched.setTimeout, clearTimeout: sched.clearTimeout },
      },
    )
    mgr.requestSave(emptyTour())
    sched.flushOne()
    await Promise.resolve()
    await Promise.resolve()
    const lastCall = onStatusChange.mock.calls.at(-1)
    expect(lastCall?.[0]).toBe('error')
    expect(lastCall?.[1]).toContain('Server error')
  })

  it('serializes saves: a debounce fire during an in-flight save is queued, not raced', async () => {
    // Phase 3pt-review/A — Copilot discussion_r3284321754. Two
    // saves arriving in close succession must reach the server
    // in order. The first save is held by a manual gate so we
    // can observe what happens when the second debounce fires
    // mid-flight; the runner must queue rather than start a
    // parallel doSave() that races the in-flight one.
    let firstResolve: (() => void) | null = null
    const callOrder: Array<{ id: string; tasks: number }> = []
    const saveTourJson = vi.fn(async (id: string, file: { tourTasks: unknown[] }) => {
      callOrder.push({ id, tasks: file.tourTasks.length })
      if (firstResolve == null) {
        // First call — pause until the test releases it.
        await new Promise<void>(r => {
          firstResolve = r
        })
      }
      return { tour: { id, slug: 'x', title: 't', tour_json_ref: 'r2:...', updated_at: 't' } }
    })
    const sched = makeScheduler()
    const mgr = createAutosaveManager(
      'X',
      { onStatusChange: () => {} },
      {
        debounceMs: 100,
        api: { createDraftTour: vi.fn(), saveTourJson },
        scheduler: { setTimeout: sched.setTimeout, clearTimeout: sched.clearTimeout },
      },
    )
    // Save #1 with 1 task; save #2 with 3 tasks so the
    // payloads are distinguishable by length.
    mgr.requestSave({ tourTasks: [{ pauseSeconds: 1 }] })
    sched.flushOne()
    await Promise.resolve()
    mgr.requestSave({
      tourTasks: [
        { pauseSeconds: 1 },
        { pauseSeconds: 2 },
        { pauseSeconds: 3 },
      ],
    })
    sched.flushOne()
    await Promise.resolve()
    // Only save #1 has happened so far — save #2 is queued
    // behind the in-flight one rather than racing it.
    expect(callOrder).toHaveLength(1)
    expect(callOrder[0].tasks).toBe(1)
    // Release save #1; save #2 should fire next, with its full
    // 3-task payload. The non-null assertion is safe — save #1
    // has already started (callOrder length is 1) and its first
    // statement assigned `firstResolve`.
    ;(firstResolve as unknown as () => void)()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(callOrder).toHaveLength(2)
    expect(callOrder[1].tasks).toBe(3)
  })

  it('flush() fires immediately bypassing the debounce', async () => {
    const saveTourJson = vi.fn(async () => ({ tour: { id: 'X', slug: 'x', title: 't', tour_json_ref: 'r2:...', updated_at: 't' } }))
    const sched = makeScheduler()
    const mgr = createAutosaveManager(
      'X',
      { onStatusChange: () => {} },
      {
        debounceMs: 100,
        api: { createDraftTour: vi.fn(), saveTourJson },
        scheduler: { setTimeout: sched.setTimeout, clearTimeout: sched.clearTimeout },
      },
    )
    mgr.requestSave(emptyTour())
    await mgr.flush()
    expect(saveTourJson).toHaveBeenCalledOnce()
    // Pending handle cleared — flushOne after this is a no-op.
    sched.flushOne()
    expect(saveTourJson).toHaveBeenCalledOnce()
  })
})
