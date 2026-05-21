import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  initTourAuthoring,
  readTourEditParam,
  teardownTourAuthoring,
} from './index'

afterEach(() => {
  teardownTourAuthoring()
  // Reset location so the next test starts with no `?tourEdit=`.
  window.history.replaceState({}, '', '/')
})

describe('readTourEditParam', () => {
  it('returns null when the URL has no tourEdit param', () => {
    expect(readTourEditParam(new URL('https://t.local/'))).toBeNull()
  })

  it('returns null when the param is present but empty', () => {
    expect(readTourEditParam(new URL('https://t.local/?tourEdit='))).toBeNull()
  })

  it('returns the value when present', () => {
    expect(readTourEditParam(new URL('https://t.local/?tourEdit=new'))).toBe('new')
    expect(
      readTourEditParam(new URL('https://t.local/?tourEdit=01HXAAAAAAAAAAAAAAAAAAAAAA')),
    ).toBe('01HXAAAAAAAAAAAAAAAAAAAAAA')
  })
})

describe('initTourAuthoring (tour/A)', () => {
  it('returns null and mounts no dock when the URL has no tourEdit param', () => {
    window.history.replaceState({}, '', '/')
    const handle = initTourAuthoring({
      getMapView: () => null,
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    expect(handle).toBeNull()
    expect(document.querySelector('.tour-authoring-dock')).toBeNull()
  })

  it('mounts the dock when ?tourEdit= is present', () => {
    window.history.replaceState({}, '', '/?tourEdit=new')
    const handle = initTourAuthoring({
      getMapView: () => null,
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    expect(handle).not.toBeNull()
    expect(document.querySelector('.tour-authoring-dock')).toBeTruthy()
  })

  it('returns the same handle on a second call (idempotent guard)', () => {
    window.history.replaceState({}, '', '/?tourEdit=new')
    const first = initTourAuthoring({
      getMapView: () => null,
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    const second = initTourAuthoring({
      getMapView: () => null,
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    expect(second).toBe(first)
    // Only one dock in the DOM — guard prevents stacking.
    expect(document.querySelectorAll('.tour-authoring-dock')).toHaveLength(1)
  })

  it('clears the singleton when the host fires onDiscard', () => {
    window.history.replaceState({}, '', '/?tourEdit=new')
    const onDiscard = vi.fn()
    initTourAuthoring({
      getMapView: () => null,
      getCurrentDataset: () => null,
      onDiscard,
    })
    document.querySelector<HTMLButtonElement>('.tour-authoring-dock-close')!.click()
    expect(onDiscard).toHaveBeenCalledOnce()
    // Dock removed; a subsequent init (e.g. after navigation back
    // to tour-edit mode) should mount a fresh dock rather than
    // hitting the already-mounted guard.
    expect(document.querySelector('.tour-authoring-dock')).toBeNull()
  })
})
