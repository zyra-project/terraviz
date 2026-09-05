// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, describe, expect, it, vi } from 'vitest'

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

  it('degrades to null when the host factory rejects', async () => {
    const createHost = vi.fn(() => Promise.reject(new Error('no tauri here')))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const handle = start({ ...DESKTOP, createHost })

    // Resolves rather than rejecting: a desktop launch without a host
    // should lose outputs, not boot.
    await expect(handle.ready).resolves.toBeNull()
    expect(() => publishGlobeState(datasetPatch('IGNORED'))).not.toThrow()
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
