// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  resetMultiOutputBootForTests,
  startMultiOutput,
  type MultiOutputBootHandle,
} from './bootMultiOutput'
import {
  publishGlobeState,
  resetGlobeStateEventsForTests,
  subscribeGlobeState,
} from './globeStateEvents'
import type { MultiOutputHost } from './manager'
import type { MirroredDataset } from './protocol'

/**
 * Every enabled case passes `isDesktop: true` explicitly.
 *
 * The default gate reads `window.__TAURI__`, which the happy-dom test
 * environment never defines — so a case that omits it takes the disabled
 * branch, subscribes to nothing, and passes while asserting nothing.
 * That is a vacuous test wearing a real one's name.
 */
const DESKTOP = { isDesktop: true } as const

function fakeHost(): MultiOutputHost & {
  availableMonitors: ReturnType<typeof vi.fn>
  createWindow: ReturnType<typeof vi.fn>
  emitTo: ReturnType<typeof vi.fn>
  listen: ReturnType<typeof vi.fn>
} {
  return {
    availableMonitors: vi.fn(async () => []),
    createWindow: vi.fn(async () => ({}) as never),
    emitTo: vi.fn(async () => {}),
    listen: vi.fn(async () => () => {}),
  }
}

/** A host factory whose promise the test resolves by hand, so the
 *  window between subscribing and having a manager can be inspected. */
function deferredHost() {
  const host = fakeHost()
  let release: () => void = () => {}
  const promise = new Promise<MultiOutputHost>(resolve => {
    release = () => resolve(host)
  })
  return { host, release, createHost: vi.fn(() => promise) }
}

function datasetPatch(id: string): { dataset: MirroredDataset } {
  return {
    dataset: {
      id,
      url: `https://cdn.example/${id}.jpg`,
      kind: 'image',
      overlay: { datasetId: id, datasetTitle: id },
    },
  }
}

let handles: MultiOutputBootHandle[] = []

function start(options: Parameters<typeof startMultiOutput>[0]): MultiOutputBootHandle {
  const handle = startMultiOutput(options)
  handles.push(handle)
  return handle
}

/**
 * `restoreOutputs` on the real manager, spied at the prototype.
 *
 * The boot module constructs the manager itself — that is what it is
 * for — so there is no instance to inject into. Stubbing it also keeps
 * these cases off the persistence path: the default store is
 * localStorage-backed and happy-dom shares it across files.
 */
let restoreSpy = vi.fn(async () => [])

beforeEach(async () => {
  const mod = await import('./manager')
  restoreSpy = vi.fn(async () => [])
  vi.spyOn(mod.MultiOutputManager.prototype, 'restoreOutputs').mockImplementation(
    restoreSpy as unknown as typeof mod.MultiOutputManager.prototype.restoreOutputs,
  )
})

afterEach(() => {
  for (const handle of handles) handle.stop()
  handles = []
  resetMultiOutputBootForTests()
  resetGlobeStateEventsForTests()
  vi.restoreAllMocks()
})

describe('startMultiOutput — disabled', () => {
  it('does nothing at all on a non-desktop build', async () => {
    const createHost = vi.fn(async () => fakeHost())

    const handle = start({ isDesktop: false, createHost })

    await expect(handle.ready).resolves.toBeNull()
    expect(createHost).not.toHaveBeenCalled()
    // The publisher must be untouched: a listener attached here would be
    // the web bundle paying for a feature it cannot have.
    expect(() => publishGlobeState({ simulationDate: '2026-01-01T00:00:00.000Z' })).not.toThrow()
  })

  it('reports itself unavailable, so no Outputs entry is offered', () => {
    expect(start({ isDesktop: false }).available).toBe(false)
  })
})

describe('startMultiOutput — enabled', () => {
  it('forwards a patch published after the host resolves', async () => {
    const { host, release, createHost } = deferredHost()
    const handle = start({ ...DESKTOP, createHost })
    release()
    const manager = await handle.ready
    expect(manager).not.toBeNull()

    publishGlobeState(datasetPatch('AFTER'))

    expect(manager!.currentState().dataset?.id).toBe('AFTER')
    expect(host.emitTo).not.toHaveBeenCalled() // no ready outputs yet
  })

  it('queues patches published while the host is still being built', async () => {
    const { release, createHost } = deferredHost()
    const handle = start({ ...DESKTOP, createHost })

    // Two DIFFERENT keys, deliberately. The aggregator is most-recent-wins
    // per key, so publishing two datasets and asserting the second would
    // also pass against a queue that keeps only the newest patch — the
    // exact loss this queue exists to prevent. Two keys distinguish them.
    publishGlobeState({ simulationDate: '2026-03-04T05:06:07.000Z' })
    publishGlobeState(datasetPatch('QUEUED'))

    release()
    const manager = await handle.ready

    expect(manager).not.toBeNull()
    expect(manager!.currentState().dataset?.id).toBe('QUEUED')
    // Survives only if the earlier patch was drained too.
    expect(manager!.currentState().simulationDate).toBe('2026-03-04T05:06:07.000Z')
  })

  it('builds no manager when stopped before the host resolves', async () => {
    const { host, release, createHost } = deferredHost()
    const handle = start({ ...DESKTOP, createHost })

    // The one branch this module is written for: boot starts the host,
    // the app tears down, then the import chain finally settles.
    handle.stop()
    release()

    await expect(handle.ready).resolves.toBeNull()
    expect(host.listen).not.toHaveBeenCalled()
    expect(host.emitTo).not.toHaveBeenCalled()
    expect(host.availableMonitors).not.toHaveBeenCalled()
  })

  it('detaches from the publisher on stop', async () => {
    const { release, createHost } = deferredHost()
    const handle = start({ ...DESKTOP, createHost })
    release()
    const manager = await handle.ready
    publishGlobeState(datasetPatch('BEFORE_STOP'))
    expect(manager!.currentState().dataset?.id).toBe('BEFORE_STOP')

    handle.stop()

    // Positive anchor: a probe proves the publish actually ran, so the
    // negative assertion below means "not delivered" rather than
    // "nothing was published".
    const probe = vi.fn()
    subscribeGlobeState(probe)
    publishGlobeState(datasetPatch('AFTER_STOP'))

    expect(probe).toHaveBeenCalledTimes(1)
    expect(manager!.currentState().dataset?.id).toBe('BEFORE_STOP')
  })

  it('reports itself available synchronously, before any host resolves', () => {
    const { createHost } = deferredHost()

    // Synchronous on purpose: the Tools menu reads this while building
    // its markup. Nothing is released, so the host is still pending.
    expect(start({ ...DESKTOP, createHost }).available).toBe(true)
  })

  it('stays available when the host fails — the panel reports that, not the menu', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const createHost = vi.fn(() => Promise.reject(new Error('no tauri here')))

    const handle = start({ ...DESKTOP, createHost })

    // `available` is the desktop gate, not a health check. Flipping it
    // on a failed host would hide the menu entry that is the only place
    // an operator could be told outputs are unavailable — and the retry
    // path means the next open may well succeed.
    await expect(handle.ready).resolves.toBeNull()
    expect(handle.available).toBe(true)
  })

  it('degrades to null when the host factory rejects', async () => {
    const createHost = vi.fn(() => Promise.reject(new Error('no tauri here')))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const handle = start({ ...DESKTOP, createHost })

    // Resolves rather than rejecting: a desktop launch without a host
    // should lose outputs, not boot.
    await expect(handle.ready).resolves.toBeNull()
    expect(() => publishGlobeState(datasetPatch('IGNORED'))).not.toThrow()
  })

  it('can retry after the host factory rejects', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing = vi.fn(() => Promise.reject(new Error('chunk load failed')))
    const first = start({ ...DESKTOP, createHost: failing })
    await expect(first.ready).resolves.toBeNull()

    // The failure path must release the module sentinel. Without that the
    // dead handle stays installed and a transient chunk-load failure costs
    // the whole session its outputs with no way back.
    const { release, createHost } = deferredHost()
    const second = start({ ...DESKTOP, createHost })
    release()

    expect(second).not.toBe(first)
    // Awaited before asserting the call: the manager module is imported
    // dynamically now, so the host factory is invoked a microtask later
    // rather than synchronously.
    await expect(second.ready).resolves.not.toBeNull()
    expect(createHost).toHaveBeenCalledTimes(1)
  })

  it('opens no link and enumerates no monitors at boot', async () => {
    const { host, release, createHost } = deferredHost()
    const handle = start({ ...DESKTOP, createHost })
    release()

    // Positive anchor first — without it the three zero-call assertions
    // below would also hold on the disabled path.
    await expect(handle.ready).resolves.not.toBeNull()

    expect(host.listen).not.toHaveBeenCalled()
    expect(host.availableMonitors).not.toHaveBeenCalled()
    expect(host.createWindow).not.toHaveBeenCalled()
  })

  it('asks the manager to restore, and does not block ready on it', async () => {
    const { release, createHost } = deferredHost()
    const handle = start({ ...DESKTOP, createHost })
    release()

    const manager = await handle.ready

    // Unconditional: the opt-in test lives in the manager, so there is
    // only one reader of that flag. `ready` resolving without waiting
    // for the restore is the point — restored outputs are paced apart,
    // and awaiting them would put that stagger on the boot path.
    expect(manager).not.toBeNull()
    expect(restoreSpy).toHaveBeenCalledTimes(1)
  })

  it('survives a restore that rejects', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    restoreSpy.mockRejectedValueOnce(new Error('monitor enumeration failed'))
    const { release, createHost } = deferredHost()

    const handle = start({ ...DESKTOP, createHost })
    release()

    // An unhandled rejection here would surface as a boot-time error
    // for a feature the operator may not even use.
    await expect(handle.ready).resolves.not.toBeNull()
  })

  it('is idempotent — a second call reuses the first link', async () => {
    const { release, createHost } = deferredHost()

    const first = start({ ...DESKTOP, createHost })
    const second = start({ ...DESKTOP, createHost })
    release()
    await first.ready

    // Listeners live in a module-scoped set, so a second subscription
    // would forward every patch twice — invisible here, but at rung 9 an
    // output applying each diff twice against one sequence bump.
    expect(second).toBe(first)
    expect(createHost).toHaveBeenCalledTimes(1)
  })

  it('can be started again after stop', async () => {
    const a = deferredHost()
    const first = start({ ...DESKTOP, createHost: a.createHost })
    a.release()
    await first.ready
    first.stop()

    const b = deferredHost()
    const second = start({ ...DESKTOP, createHost: b.createHost })
    b.release()

    expect(second).not.toBe(first)
    await expect(second.ready).resolves.not.toBeNull()
  })
})
