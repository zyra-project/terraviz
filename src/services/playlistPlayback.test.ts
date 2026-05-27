import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  getActive,
  initPlaylistPlayback,
  notifyTourEnded,
  onPlaybackChange,
  pause,
  play,
  type PlaylistPlaybackCallbacks,
  resetPlaylistPlaybackForTests,
  resume,
  skipNext,
  skipPrev,
  skipTo,
  stop,
} from './playlistPlayback'
import { DEFAULT_ENTRY_DURATION_SEC, type Playlist } from './playlistService'

interface Harness {
  loadDataset: ReturnType<typeof vi.fn<(datasetId: string) => Promise<void>>>
  hasTourOnLoad: ReturnType<typeof vi.fn<(datasetId: string) => boolean>>
}

function setupHarness(opts: { tourFor?: string[] } = {}): Harness {
  const tourSet = new Set(opts.tourFor ?? [])
  const h: Harness = {
    loadDataset: vi.fn(async () => {}),
    hasTourOnLoad: vi.fn((id: string) => tourSet.has(id)),
  }
  initPlaylistPlayback(h as PlaylistPlaybackCallbacks)
  return h
}

function makePlaylist(datasetIds: Array<string | [string, number]>): Playlist {
  return {
    id: 'pl-test',
    name: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
    datasets: datasetIds.map((d) => {
      if (Array.isArray(d)) return { datasetId: d[0], durationSec: d[1] }
      return { datasetId: d }
    }),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  resetPlaylistPlaybackForTests()
})

afterEach(() => {
  vi.useRealTimers()
  resetPlaylistPlaybackForTests()
})

describe('play()', () => {
  it('loads the first entry on play', async () => {
    const h = setupHarness()
    play(makePlaylist(['A', 'B', 'C']))
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('A'))
    expect(getActive()?.index).toBe(0)
  })

  it('starts at the given index when startAt is set', async () => {
    const h = setupHarness()
    play(makePlaylist(['A', 'B', 'C']), { startAt: 2 })
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('C'))
    expect(getActive()?.index).toBe(2)
  })

  it('clamps an out-of-range startAt to the last entry', async () => {
    const h = setupHarness()
    play(makePlaylist(['A', 'B']), { startAt: 99 })
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('B'))
    expect(getActive()?.index).toBe(1)
  })

  it('refuses to play an empty playlist', () => {
    const h = setupHarness()
    play(makePlaylist([]))
    expect(h.loadDataset).not.toHaveBeenCalled()
    expect(getActive()).toBeNull()
  })

  it('single-active: starting playlist B stops A', async () => {
    const h = setupHarness()
    play(makePlaylist(['A1', 'A2', 'A3']))
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('A1'))
    const playlistB: Playlist = {
      id: 'pl-other',
      name: 'B',
      createdAt: '2026-01-01T00:00:00.000Z',
      datasets: [{ datasetId: 'B1' }],
    }
    play(playlistB)
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('B1'))
    expect(getActive()?.playlist.id).toBe('pl-other')
  })
})

describe('auto-advance timer', () => {
  it('advances to the next entry after durationSec elapses', async () => {
    const h = setupHarness()
    play(makePlaylist([['A', 10], ['B', 10]]))
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('A'))
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('B'))
    expect(getActive()?.index).toBe(1)
  })

  it('falls back to DEFAULT_ENTRY_DURATION_SEC when durationSec is omitted', async () => {
    const h = setupHarness()
    play(makePlaylist(['A', 'B']))
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('A'))
    await vi.advanceTimersByTimeAsync(DEFAULT_ENTRY_DURATION_SEC * 1000 - 1)
    expect(h.loadDataset).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2)
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('B'))
  })

  it('stops at end-of-list', async () => {
    const h = setupHarness()
    play(makePlaylist([['A', 5], ['B', 5]]))
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('A'))
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('B'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(getActive()).toBeNull()
  })

  it('continues advancing even when loadDataset throws', async () => {
    const h = setupHarness()
    h.loadDataset.mockImplementation(async (id: string) => {
      if (id === 'A') throw new Error('boom')
    })
    play(makePlaylist([['A', 5], ['B', 5]]))
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('B'))
  })
})

describe('pause + resume', () => {
  it('pause clears the timer; resume re-arms with the remaining time', async () => {
    const h = setupHarness()
    play(makePlaylist([['A', 10], ['B', 10]]))
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('A'))
    await vi.advanceTimersByTimeAsync(3_000)
    pause()
    expect(getActive()?.paused).toBe(true)
    // Time passes while paused — should NOT advance
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.loadDataset).toHaveBeenCalledTimes(1)
    resume()
    // 7 seconds remained when paused — should advance after 7 more seconds
    await vi.advanceTimersByTimeAsync(6_999)
    expect(h.loadDataset).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2)
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('B'))
  })

  it('pause / resume are idempotent', () => {
    setupHarness()
    play(makePlaylist(['A', 'B']))
    pause()
    pause() // second pause is a no-op
    expect(getActive()?.paused).toBe(true)
    resume()
    resume() // second resume is a no-op
    expect(getActive()?.paused).toBe(false)
  })
})

describe('skipNext / skipPrev / skipTo', () => {
  it('skipNext advances immediately, bypassing the timer', async () => {
    const h = setupHarness()
    play(makePlaylist(['A', 'B', 'C']))
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('A'))
    skipNext()
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('B'))
    expect(getActive()?.index).toBe(1)
  })

  it('skipPrev decrements; no-op at index 0', async () => {
    const h = setupHarness()
    play(makePlaylist(['A', 'B', 'C']))
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('A'))
    skipPrev() // no-op
    expect(getActive()?.index).toBe(0)
    skipNext()
    skipPrev()
    expect(getActive()?.index).toBe(0)
  })

  it('skipTo clamps out-of-range indices', async () => {
    const h = setupHarness()
    play(makePlaylist(['A', 'B', 'C']))
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('A'))
    skipTo(99)
    expect(getActive()?.index).toBe(2)
    skipTo(-5)
    expect(getActive()?.index).toBe(0)
  })

  it('skipNext at the last entry stops the playlist', async () => {
    setupHarness()
    play(makePlaylist(['A']))
    skipNext()
    expect(getActive()).toBeNull()
  })
})

describe('tour deferral', () => {
  it('does not start the timer for a tour-bearing entry', async () => {
    const h = setupHarness({ tourFor: ['A'] })
    play(makePlaylist([['A', 5], ['B', 5]]))
    await vi.waitFor(() => expect(getActive()?.waitingForTour).toBe(true))
    // Even after 60 s — far past the 5 s durationSec — we stay on A.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.loadDataset).toHaveBeenCalledTimes(1)
    expect(getActive()?.index).toBe(0)
  })

  it('notifyTourEnded advances to the next entry', async () => {
    const h = setupHarness({ tourFor: ['A'] })
    play(makePlaylist([['A', 5], ['B', 5]]))
    await vi.waitFor(() => expect(getActive()?.waitingForTour).toBe(true))
    notifyTourEnded()
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('B'))
    expect(getActive()?.index).toBe(1)
    expect(getActive()?.waitingForTour).toBe(false)
  })

  it('notifyTourEnded is a no-op when no tour is pending', async () => {
    const h = setupHarness()
    play(makePlaylist([['A', 5], ['B', 5]]))
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('A'))
    notifyTourEnded()
    expect(getActive()?.index).toBe(0)
    expect(h.loadDataset).toHaveBeenCalledTimes(1)
  })
})

describe('onPlaybackChange', () => {
  it('fires on play / skip / stop', async () => {
    const h = setupHarness()
    const listener = vi.fn()
    const unsub = onPlaybackChange(listener)
    play(makePlaylist(['A', 'B']))
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('A'))
    expect(listener).toHaveBeenCalled()
    listener.mockClear()
    skipNext()
    expect(listener).toHaveBeenCalled()
    listener.mockClear()
    stop()
    expect(listener).toHaveBeenCalledWith(null)
    unsub()
  })

  it('does not fire after unsubscribe', () => {
    setupHarness()
    const listener = vi.fn()
    const unsub = onPlaybackChange(listener)
    unsub()
    play(makePlaylist(['A']))
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('stop', () => {
  it('clears active state and the timer', async () => {
    const h = setupHarness()
    play(makePlaylist([['A', 10], ['B', 10]]))
    await vi.waitFor(() => expect(h.loadDataset).toHaveBeenCalledWith('A'))
    stop()
    expect(getActive()).toBeNull()
    // Timer should be gone — advancing time does not call loadDataset again.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.loadDataset).toHaveBeenCalledTimes(1)
  })
})
