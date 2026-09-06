// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OutputMonitor } from './manager'
import {
  createOutputConfigStore,
  defaultOutputConfig,
  matchMonitorIndex,
  OUTPUT_CONFIG_STORAGE_KEY,
  OUTPUT_CONFIG_VERSION,
  parseOutputConfig,
  toPersistedOutput,
  type PersistedOutput,
  type StorageLike,
} from './outputPersistence'

function monitor(over: Partial<OutputMonitor> = {}): OutputMonitor {
  return {
    name: '\\\\.\\DISPLAY1',
    position: { x: 0, y: 0 },
    size: { width: 1920, height: 1080 },
    scaleFactor: 1,
    ...over,
  }
}

function persisted(over: Partial<PersistedOutput> = {}): PersistedOutput {
  return {
    label: 'output-1',
    monitorName: '\\\\.\\DISPLAY1',
    monitorOrigin: { x: 0, y: 0 },
    mode: 'sos-equirect',
    trackOperatorCamera: true,
    split: false,
    ...over,
  }
}

function memoryStorage(initial?: string): StorageLike & { written: string[] } {
  let value = initial ?? null
  const written: string[] = []
  return {
    written,
    getItem: () => value,
    setItem: (_k, v) => {
      value = v
      written.push(v)
    },
  }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('matchMonitorIndex', () => {
  it('matches on name and signed origin together', () => {
    expect(matchMonitorIndex(persisted(), [monitor()])).toBe(0)
  })

  it('refuses a name-only match', () => {
    // The rule this module exists for. Windows display names are
    // positional: the same `\\.\DISPLAY1` can name a different physical
    // panel after a replug. Restoring onto it would put a projector on
    // the wrong monitor with nothing on screen to say so.
    expect(
      matchMonitorIndex(persisted(), [monitor({ position: { x: 1920, y: 0 } })]),
    ).toBeNull()
  })

  it('refuses an origin-only match', () => {
    expect(matchMonitorIndex(persisted(), [monitor({ name: '\\\\.\\DISPLAY2' })])).toBeNull()
  })

  it('matches a negative origin, which is where the bug lived', () => {
    // The spike's primary-left monitor sat at x = −1680. An origin that
    // had been through an unsigned or logical conversion would miss it.
    const left = persisted({ monitorOrigin: { x: -1680, y: 0 } })
    expect(matchMonitorIndex(left, [monitor({ position: { x: -1680, y: 0 } })])).toBe(0)
  })

  it('matches an unnamed display by origin, rather than never matching', () => {
    // Linux reports `name: null` often enough that treating it as
    // unmatchable would make restore useless there.
    const unnamed = persisted({ monitorName: null })
    expect(matchMonitorIndex(unnamed, [monitor({ name: null })])).toBe(0)
  })

  it('picks the right monitor out of several', () => {
    const target = persisted({ monitorName: 'RIGHT', monitorOrigin: { x: 1920, y: 0 } })
    const monitors = [
      monitor({ name: 'LEFT', position: { x: -1680, y: 0 } }),
      monitor({ name: 'CENTRE' }),
      monitor({ name: 'RIGHT', position: { x: 1920, y: 0 } }),
    ]
    expect(matchMonitorIndex(target, monitors)).toBe(2)
  })

  it('returns null when the display is simply gone', () => {
    expect(matchMonitorIndex(persisted(), [])).toBeNull()
  })
})

describe('parseOutputConfig', () => {
  it('returns defaults for nothing stored', () => {
    expect(parseOutputConfig(null)).toEqual(defaultOutputConfig())
    // Off by default: an install that never enabled outputs must
    // enumerate no monitors and open no IPC link.
    expect(defaultOutputConfig().autoRestoreOnLaunch).toBe(false)
  })

  it('returns defaults for a blob that is not JSON', () => {
    expect(parseOutputConfig('{oh no')).toEqual(defaultOutputConfig())
  })

  it('resets on a version it does not recognise', () => {
    const future = JSON.stringify({
      version: OUTPUT_CONFIG_VERSION + 1,
      outputs: [persisted()],
      autoRestoreOnLaunch: true,
    })

    // Half-applying a shape nobody wrote would spawn windows from
    // guesses. Losing a list the operator can rebuild in three clicks
    // is the cheaper failure.
    expect(parseOutputConfig(future)).toEqual(defaultOutputConfig())
  })

  it('round-trips a real config', () => {
    const config = {
      version: OUTPUT_CONFIG_VERSION,
      outputs: [persisted(), persisted({ label: 'output-2', split: true })],
      autoRestoreOnLaunch: true,
    }
    expect(parseOutputConfig(JSON.stringify(config))).toEqual(config)
  })

  it('drops one malformed entry and keeps the rest', () => {
    const raw = JSON.stringify({
      version: OUTPUT_CONFIG_VERSION,
      outputs: [
        persisted(),
        { label: 'output-2' }, // no origin, no mode
        persisted({ label: 'output-3' }),
      ],
      autoRestoreOnLaunch: false,
    })

    const config = parseOutputConfig(raw)

    // One schema slip must not cost an installation its other outputs.
    expect(config.outputs.map(o => o.label)).toEqual(['output-1', 'output-3'])
  })

  it('rejects a NaN origin rather than storing one that never matches', () => {
    const raw = JSON.stringify({
      version: OUTPUT_CONFIG_VERSION,
      outputs: [{ ...persisted(), monitorOrigin: { x: 'nope', y: 0 } }],
      autoRestoreOnLaunch: false,
    })

    // A NaN compares unequal to itself, so such an entry would sit in
    // the config forever, silently matching nothing.
    expect(parseOutputConfig(raw).outputs).toEqual([])
  })

  it('rejects an unknown mode', () => {
    const raw = JSON.stringify({
      version: OUTPUT_CONFIG_VERSION,
      outputs: [{ ...persisted(), mode: 'fisheye' }],
      autoRestoreOnLaunch: false,
    })

    // Phase 2's mode, written by a newer build. This one cannot render
    // it, and spawning it as an equirect would be inventing intent.
    expect(parseOutputConfig(raw).outputs).toEqual([])
  })

  it('treats a non-boolean autoRestore as off', () => {
    const raw = JSON.stringify({
      version: OUTPUT_CONFIG_VERSION,
      outputs: [],
      autoRestoreOnLaunch: 'yes',
    })
    expect(parseOutputConfig(raw).autoRestoreOnLaunch).toBe(false)
  })

  it('defaults camera tracking on and split off, matching a fresh output', () => {
    const raw = JSON.stringify({
      version: OUTPUT_CONFIG_VERSION,
      outputs: [{ label: 'output-1', monitorName: null, monitorOrigin: { x: 0, y: 0 }, mode: 'sos-equirect' }],
      autoRestoreOnLaunch: false,
    })
    const [output] = parseOutputConfig(raw).outputs
    expect(output.trackOperatorCamera).toBe(true)
    expect(output.split).toBe(false)
  })
})

describe('toPersistedOutput', () => {
  it('copies the origin rather than aliasing the live monitor', () => {
    const live = monitor({ position: { x: -1680, y: 0 } })
    const output = toPersistedOutput('output-1', live, 'sos-equirect', {
      trackCamera: false,
      split: true,
    })

    live.position.x = 9999

    // An alias would let a later mutation rewrite history that was
    // already serialised once.
    expect(output.monitorOrigin.x).toBe(-1680)
    expect(output.trackOperatorCamera).toBe(false)
    expect(output.split).toBe(true)
  })
})

describe('createOutputConfigStore', () => {
  it('reads back what it wrote', () => {
    const store = createOutputConfigStore(memoryStorage())
    const config = { ...defaultOutputConfig(), autoRestoreOnLaunch: true, outputs: [persisted()] }

    store.write(config)

    expect(store.read()).toEqual(config)
  })

  it('writes under the documented key', () => {
    const storage = memoryStorage()
    const setItem = vi.spyOn(storage, 'setItem')

    createOutputConfigStore(storage).write(defaultOutputConfig())

    expect(setItem.mock.calls[0][0]).toBe(OUTPUT_CONFIG_STORAGE_KEY)
  })

  it('is inert but usable when storage is unavailable', () => {
    const store = createOutputConfigStore(null)

    // Private-mode Safari and a locked-down webview should cost the
    // operator persistence, not the feature.
    expect(() => store.write({ ...defaultOutputConfig(), autoRestoreOnLaunch: true })).not.toThrow()
    expect(store.read()).toEqual(defaultOutputConfig())
  })

  it('survives a throwing setItem — a full quota must not break live outputs', () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }

    expect(() => createOutputConfigStore(storage).write(defaultOutputConfig())).not.toThrow()
  })

  it('survives a throwing getItem', () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {},
    }

    expect(createOutputConfigStore(storage).read()).toEqual(defaultOutputConfig())
  })
})
