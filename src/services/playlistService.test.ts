import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  addToPlaylist,
  createPlaylist,
  DEFAULT_ENTRY_DURATION_SEC,
  deletePlaylist,
  effectiveDuration,
  exportPlaylistsJson,
  getPlaylist,
  importPlaylists,
  loadPlaylists,
  onPlaylistsChange,
  PLAYLIST_NAME_MAX_LEN,
  PLAYLIST_STORAGE_KEY,
  removeFromPlaylist,
  renamePlaylist,
  reorderPlaylist,
  resetPlaylistsForTests,
  savePlaylist,
  setEntryDuration,
  setEntryPauseForInput,
  setPlaylistLoop,
  type Playlist,
} from './playlistService'

beforeEach(() => {
  localStorage.clear()
  resetPlaylistsForTests()
})

afterEach(() => {
  localStorage.clear()
  resetPlaylistsForTests()
})

describe('loadPlaylists', () => {
  it('returns an empty array when nothing is persisted', () => {
    expect(loadPlaylists()).toEqual([])
  })

  it('returns a deep copy — mutating the result does not corrupt cache', () => {
    createPlaylist('a')
    const copy = loadPlaylists()
    copy[0].name = 'mutated'
    copy[0].datasets.push({ datasetId: 'INJECTED' })
    const fresh = loadPlaylists()
    expect(fresh[0].name).toBe('a')
    expect(fresh[0].datasets).toEqual([])
  })

  it('returns an empty array when localStorage holds malformed JSON', () => {
    localStorage.setItem(PLAYLIST_STORAGE_KEY, 'not json')
    resetPlaylistsForTests()
    expect(loadPlaylists()).toEqual([])
  })

  it('returns an empty array when the parsed value is not an array', () => {
    localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify({ name: 'wrong shape' }))
    resetPlaylistsForTests()
    expect(loadPlaylists()).toEqual([])
  })

  it('drops items missing required fields but keeps valid siblings', () => {
    localStorage.setItem(
      PLAYLIST_STORAGE_KEY,
      JSON.stringify([
        { id: 'pl-good', name: 'good', createdAt: '2026-01-01T00:00:00.000Z', datasets: [] },
        { id: '', name: 'no id', createdAt: '2026-01-01T00:00:00.000Z', datasets: [] },
        { id: 'pl-no-name', createdAt: '2026-01-01T00:00:00.000Z', datasets: [] },
        null,
        'string',
      ]),
    )
    resetPlaylistsForTests()
    const list = loadPlaylists()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('pl-good')
  })

  it('drops entries missing datasetId but keeps valid ones', () => {
    localStorage.setItem(
      PLAYLIST_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'pl-1',
          name: 'mixed',
          createdAt: '2026-01-01T00:00:00.000Z',
          datasets: [
            { datasetId: 'A', durationSec: 5 },
            { datasetId: '' },
            { foo: 'bar' },
            null,
            { datasetId: 'B' },
          ],
        },
      ]),
    )
    resetPlaylistsForTests()
    const list = loadPlaylists()
    expect(list[0].datasets).toEqual([{ datasetId: 'A', durationSec: 5 }, { datasetId: 'B' }])
  })

  it('drops non-positive or non-finite durationSec values', () => {
    localStorage.setItem(
      PLAYLIST_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'pl-1',
          name: 'bad durations',
          createdAt: '2026-01-01T00:00:00.000Z',
          datasets: [
            { datasetId: 'A', durationSec: 0 },
            { datasetId: 'B', durationSec: -5 },
            { datasetId: 'C', durationSec: Number.NaN },
            { datasetId: 'D', durationSec: 12 },
          ],
        },
      ]),
    )
    resetPlaylistsForTests()
    const ds = loadPlaylists()[0].datasets
    expect(ds[0].durationSec).toBeUndefined()
    expect(ds[1].durationSec).toBeUndefined()
    expect(ds[2].durationSec).toBeUndefined()
    expect(ds[3].durationSec).toBe(12)
  })
})

describe('createPlaylist', () => {
  it('creates a playlist with the given name and empty datasets', () => {
    const p = createPlaylist('My favourites')
    expect(p.name).toBe('My favourites')
    expect(p.datasets).toEqual([])
    expect(p.id).toMatch(/^pl-\d+-[0-9a-f]+$/)
    expect(p.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('trims whitespace from the name', () => {
    expect(createPlaylist('  spaced  ').name).toBe('spaced')
  })

  it('clamps over-long names to PLAYLIST_NAME_MAX_LEN', () => {
    const long = 'x'.repeat(PLAYLIST_NAME_MAX_LEN + 50)
    expect(createPlaylist(long).name.length).toBe(PLAYLIST_NAME_MAX_LEN)
  })

  it('persists the playlist so a fresh read picks it up', () => {
    createPlaylist('persisted')
    resetPlaylistsForTests()
    const list = loadPlaylists()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('persisted')
  })

  it('generates unique ids for back-to-back creates', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) {
      seen.add(createPlaylist(`p${i}`).id)
    }
    expect(seen.size).toBe(100)
  })
})

describe('addToPlaylist', () => {
  it('appends an entry with no durationSec by default', () => {
    const p = createPlaylist('a')
    addToPlaylist(p.id, 'DATASET_A')
    // New entries default to pauseForInput so a freshly built
    // playlist walks the user through datasets at their own pace.
    expect(getPlaylist(p.id)?.datasets).toEqual([{ datasetId: 'DATASET_A', pauseForInput: true }])
  })

  it('is idempotent — re-adding the same dataset is a no-op', () => {
    const p = createPlaylist('a')
    addToPlaylist(p.id, 'DATASET_A')
    addToPlaylist(p.id, 'DATASET_A')
    expect(getPlaylist(p.id)?.datasets).toHaveLength(1)
  })

  it('preserves an existing durationSec when a duplicate is rejected', () => {
    const p = createPlaylist('a')
    addToPlaylist(p.id, 'DATASET_A')
    setEntryDuration(p.id, 0, 90)
    addToPlaylist(p.id, 'DATASET_A')
    expect(getPlaylist(p.id)?.datasets[0].durationSec).toBe(90)
  })

  it('no-ops for an unknown playlist id', () => {
    addToPlaylist('pl-missing', 'A')
    expect(loadPlaylists()).toEqual([])
  })

  it('no-ops for an empty datasetId', () => {
    const p = createPlaylist('a')
    addToPlaylist(p.id, '')
    expect(getPlaylist(p.id)?.datasets).toEqual([])
  })
})

describe('removeFromPlaylist + reorderPlaylist', () => {
  it('removes the entry at the given index', () => {
    const p = createPlaylist('a')
    addToPlaylist(p.id, 'A')
    addToPlaylist(p.id, 'B')
    addToPlaylist(p.id, 'C')
    removeFromPlaylist(p.id, 1)
    expect(getPlaylist(p.id)?.datasets.map((e) => e.datasetId)).toEqual(['A', 'C'])
  })

  it('no-ops on out-of-range index', () => {
    const p = createPlaylist('a')
    addToPlaylist(p.id, 'A')
    removeFromPlaylist(p.id, 99)
    expect(getPlaylist(p.id)?.datasets).toHaveLength(1)
  })

  it('reorders entries within a playlist', () => {
    const p = createPlaylist('a')
    addToPlaylist(p.id, 'A')
    addToPlaylist(p.id, 'B')
    addToPlaylist(p.id, 'C')
    reorderPlaylist(p.id, 0, 2)
    expect(getPlaylist(p.id)?.datasets.map((e) => e.datasetId)).toEqual(['B', 'C', 'A'])
  })

  it('clamps out-of-range reorder indices to the edges', () => {
    const p = createPlaylist('a')
    addToPlaylist(p.id, 'A')
    addToPlaylist(p.id, 'B')
    reorderPlaylist(p.id, 0, 99)
    expect(getPlaylist(p.id)?.datasets.map((e) => e.datasetId)).toEqual(['B', 'A'])
  })
})

describe('setEntryDuration + effectiveDuration', () => {
  it('writes a positive override', () => {
    const p = createPlaylist('a')
    addToPlaylist(p.id, 'A')
    setEntryDuration(p.id, 0, 45)
    expect(getPlaylist(p.id)?.datasets[0].durationSec).toBe(45)
  })

  it('rejects non-positive and non-finite values', () => {
    const p = createPlaylist('a')
    addToPlaylist(p.id, 'A')
    setEntryDuration(p.id, 0, 0)
    setEntryDuration(p.id, 0, -5)
    setEntryDuration(p.id, 0, Number.NaN)
    expect(getPlaylist(p.id)?.datasets[0].durationSec).toBeUndefined()
  })

  it('clears the override when passed undefined', () => {
    const p = createPlaylist('a')
    addToPlaylist(p.id, 'A')
    setEntryDuration(p.id, 0, 90)
    setEntryDuration(p.id, 0, undefined)
    expect(getPlaylist(p.id)?.datasets[0].durationSec).toBeUndefined()
  })

  it('falls back to DEFAULT_ENTRY_DURATION_SEC when no override is set', () => {
    expect(effectiveDuration({ datasetId: 'A' })).toBe(DEFAULT_ENTRY_DURATION_SEC)
  })

  it('returns the override when set', () => {
    expect(effectiveDuration({ datasetId: 'A', durationSec: 90 })).toBe(90)
  })
})

describe('setEntryPauseForInput', () => {
  it('sets the flag when true is passed', () => {
    const p = createPlaylist('a')
    addToPlaylist(p.id, 'A')
    setEntryPauseForInput(p.id, 0, true)
    expect(getPlaylist(p.id)?.datasets[0].pauseForInput).toBe(true)
  })

  it('removes the flag when false is passed', () => {
    const p = createPlaylist('a')
    addToPlaylist(p.id, 'A')
    setEntryPauseForInput(p.id, 0, true)
    setEntryPauseForInput(p.id, 0, false)
    expect(getPlaylist(p.id)?.datasets[0].pauseForInput).toBeUndefined()
  })

  it('no-ops for out-of-range index or unknown playlist', () => {
    const p = createPlaylist('a')
    addToPlaylist(p.id, 'A')
    // New entries default to pauseForInput=true; clear it first so
    // the no-op assertion is testing the rejection path, not the
    // default.
    setEntryPauseForInput(p.id, 0, false)
    setEntryPauseForInput(p.id, 99, true)
    setEntryPauseForInput('pl-missing', 0, true)
    expect(getPlaylist(p.id)?.datasets[0].pauseForInput).toBeUndefined()
  })

  it('roundtrips through localStorage', () => {
    const p = createPlaylist('a')
    addToPlaylist(p.id, 'A')
    setEntryPauseForInput(p.id, 0, true)
    resetPlaylistsForTests()
    expect(loadPlaylists()[0].datasets[0].pauseForInput).toBe(true)
  })
})

describe('setPlaylistLoop', () => {
  it('sets and clears the loop flag', () => {
    const p = createPlaylist('a')
    setPlaylistLoop(p.id, true)
    expect(getPlaylist(p.id)?.loop).toBe(true)
    setPlaylistLoop(p.id, false)
    expect(getPlaylist(p.id)?.loop).toBeUndefined()
  })

  it('no-ops for unknown playlist', () => {
    setPlaylistLoop('pl-missing', true)
    expect(loadPlaylists()).toEqual([])
  })

  it('roundtrips through localStorage', () => {
    const p = createPlaylist('a')
    setPlaylistLoop(p.id, true)
    resetPlaylistsForTests()
    expect(loadPlaylists()[0].loop).toBe(true)
  })
})

describe('renamePlaylist + deletePlaylist', () => {
  it('renames an existing playlist', () => {
    const p = createPlaylist('old')
    renamePlaylist(p.id, 'new')
    expect(getPlaylist(p.id)?.name).toBe('new')
  })

  it('rejects an empty-after-trim name', () => {
    const p = createPlaylist('keep')
    renamePlaylist(p.id, '   ')
    expect(getPlaylist(p.id)?.name).toBe('keep')
  })

  it('deletes by id', () => {
    const a = createPlaylist('a')
    const b = createPlaylist('b')
    deletePlaylist(a.id)
    expect(loadPlaylists().map((p) => p.id)).toEqual([b.id])
  })

  it('no-ops when deleting an unknown id', () => {
    createPlaylist('a')
    deletePlaylist('pl-not-real')
    expect(loadPlaylists()).toHaveLength(1)
  })
})

describe('onPlaylistsChange', () => {
  it('fires the listener after a create + delete', () => {
    const listener = vi.fn()
    const unsub = onPlaylistsChange(listener)
    const p = createPlaylist('a')
    expect(listener).toHaveBeenCalledTimes(1)
    deletePlaylist(p.id)
    expect(listener).toHaveBeenCalledTimes(2)
    unsub()
  })

  it('does not fire after unsubscribe', () => {
    const listener = vi.fn()
    const unsub = onPlaylistsChange(listener)
    unsub()
    createPlaylist('a')
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('importPlaylists + exportPlaylistsJson', () => {
  it('replaces all playlists with the imported array (default)', () => {
    createPlaylist('original')
    const incoming: Playlist[] = [{
      id: 'pl-imported',
      name: 'imported',
      createdAt: '2026-01-01T00:00:00.000Z',
      datasets: [{ datasetId: 'X' }],
    }]
    const result = importPlaylists(incoming)
    expect(result).toEqual({ imported: 1, skipped: 0 })
    const list = loadPlaylists()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('pl-imported')
  })

  it('merge mode appends to existing and re-ids on collision', () => {
    const original = createPlaylist('original')
    const incoming: Playlist[] = [{
      id: original.id, // collision
      name: 'colliding',
      createdAt: '2026-01-01T00:00:00.000Z',
      datasets: [],
    }]
    importPlaylists(incoming, { merge: true })
    const list = loadPlaylists()
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe(original.id)
    expect(list[1].id).not.toBe(original.id)
    expect(list[1].name).toBe('colliding')
  })

  it('merge mode produces unique ids when multiple incoming playlists collide', () => {
    const original = createPlaylist('original')
    // Three colliders all carrying the same id as `original`. Without
    // updating the existingIds set as the merge walks, a freshly
    // generated id could collide with a previously-merged one.
    const incoming: Playlist[] = [
      { id: original.id, name: 'a', createdAt: '2026-01-01T00:00:00.000Z', datasets: [] },
      { id: original.id, name: 'b', createdAt: '2026-01-01T00:00:00.000Z', datasets: [] },
      { id: original.id, name: 'c', createdAt: '2026-01-01T00:00:00.000Z', datasets: [] },
    ]
    importPlaylists(incoming, { merge: true })
    const ids = loadPlaylists().map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('skips invalid items, reports count', () => {
    const incoming = [
      { id: 'ok', name: 'ok', createdAt: '2026-01-01T00:00:00.000Z', datasets: [] },
      null,
      { id: '', name: '', createdAt: '2026-01-01T00:00:00.000Z', datasets: [] },
      'string',
    ]
    const result = importPlaylists(incoming)
    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(3)
  })

  it('returns 0/0 when given a non-array', () => {
    expect(importPlaylists({ not: 'array' })).toEqual({ imported: 0, skipped: 0 })
  })

  it('exportPlaylistsJson roundtrips through importPlaylists', () => {
    createPlaylist('a')
    const p2 = createPlaylist('b')
    addToPlaylist(p2.id, 'DATASET_X')
    setEntryDuration(p2.id, 0, 60)

    const json = exportPlaylistsJson()
    localStorage.clear()
    resetPlaylistsForTests()
    expect(loadPlaylists()).toEqual([])

    importPlaylists(JSON.parse(json))
    const restored = loadPlaylists()
    expect(restored).toHaveLength(2)
    expect(restored[1].datasets[0]).toEqual({
      datasetId: 'DATASET_X',
      durationSec: 60,
      pauseForInput: true,
    })
  })
})

describe('savePlaylist', () => {
  it('inserts a new playlist when the id is unseen', () => {
    savePlaylist({
      id: 'pl-new',
      name: 'fresh',
      createdAt: '2026-01-01T00:00:00.000Z',
      datasets: [{ datasetId: 'A' }],
    })
    expect(getPlaylist('pl-new')?.datasets).toEqual([{ datasetId: 'A' }])
  })

  it('replaces an existing playlist when the id matches', () => {
    const p = createPlaylist('orig')
    savePlaylist({
      id: p.id,
      name: 'replaced',
      createdAt: p.createdAt,
      datasets: [{ datasetId: 'Z' }],
    })
    expect(getPlaylist(p.id)?.name).toBe('replaced')
    expect(getPlaylist(p.id)?.datasets).toEqual([{ datasetId: 'Z' }])
  })

  it('rejects an invalid shape silently', () => {
    savePlaylist({ id: '', name: '', createdAt: '', datasets: [] })
    expect(loadPlaylists()).toEqual([])
  })
})
