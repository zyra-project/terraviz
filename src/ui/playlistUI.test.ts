import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  closeAddPopover,
  closePlaylistManager,
  destroyPlaylistUI,
  handleImportFile,
  initPlaylistUI,
  isPlaylistManagerOpen,
  openAddToPlaylistPopover,
  openPlaylistManager,
} from './playlistUI'
import {
  addToPlaylist,
  createPlaylist,
  loadPlaylists,
  resetPlaylistsForTests,
} from '../services/playlistService'

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  resetPlaylistsForTests()
  delete document.body.dataset.playlistUiListenersWired
  // happy-dom does not implement these — assign no-ops so `vi.spyOn`
  // can wrap them in individual tests.
  ;(window as unknown as { alert: (msg?: string) => void }).alert = () => {}
  ;(window as unknown as { confirm: (msg?: string) => boolean }).confirm = () => true
  ;(window as unknown as { prompt: (msg?: string, def?: string) => string | null }).prompt = () => null
  initPlaylistUI()
})

afterEach(() => {
  destroyPlaylistUI()
  closePlaylistManager()
  closeAddPopover()
  document.body.innerHTML = ''
  localStorage.clear()
  resetPlaylistsForTests()
})

describe('playlist manager', () => {
  it('lazy-mounts the panel on first open', () => {
    expect(document.getElementById('playlist-manager')).not.toBeNull()
    openPlaylistManager()
    expect(isPlaylistManagerOpen()).toBe(true)
    expect(document.getElementById('playlist-manager')?.classList.contains('hidden')).toBe(false)
  })

  it('renders the empty-state when no playlists exist', () => {
    openPlaylistManager()
    const panel = document.getElementById('playlist-manager')!
    expect(panel.querySelector('.pl-mgr-empty')).not.toBeNull()
    expect(panel.querySelector('.pl-mgr-list')).toBeNull()
  })

  it('renders a row per saved playlist', () => {
    createPlaylist('alpha')
    createPlaylist('beta')
    openPlaylistManager()
    const rows = document.querySelectorAll('.pl-mgr-row')
    expect(rows.length).toBe(2)
  })

  it('close button hides the panel', () => {
    openPlaylistManager()
    const closeBtn = document.getElementById('playlist-manager-close') as HTMLButtonElement
    closeBtn.click()
    expect(isPlaylistManagerOpen()).toBe(false)
    expect(document.getElementById('playlist-manager')?.classList.contains('hidden')).toBe(true)
  })

  it('re-renders when a playlist is added while open', () => {
    openPlaylistManager()
    expect(document.querySelectorAll('.pl-mgr-row').length).toBe(0)
    createPlaylist('new one')
    expect(document.querySelectorAll('.pl-mgr-row').length).toBe(1)
  })

  it('delete button removes the playlist after confirm', () => {
    const p = createPlaylist('to delete')
    openPlaylistManager()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const deleteBtn = document.querySelector<HTMLButtonElement>('.pl-mgr-row-delete')!
    expect(deleteBtn.dataset.id).toBe(p.id)
    deleteBtn.click()
    expect(loadPlaylists()).toEqual([])
    confirmSpy.mockRestore()
  })

  it('rename button updates the name when prompt returns a value', () => {
    const p = createPlaylist('orig')
    openPlaylistManager()
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('renamed')
    const renameBtn = document.querySelector<HTMLButtonElement>('.pl-mgr-row-rename')!
    renameBtn.click()
    expect(loadPlaylists().find((x) => x.id === p.id)?.name).toBe('renamed')
    promptSpy.mockRestore()
  })

  it('expand toggle keeps the manager open even though it re-renders the panel', () => {
    const p = createPlaylist('with entries')
    addToPlaylist(p.id, 'INTERNAL_A')
    openPlaylistManager()
    expect(isPlaylistManagerOpen()).toBe(true)

    const toggleBtn = document.querySelector<HTMLButtonElement>('.pl-mgr-row-toggle')!
    // Dispatch a real bubbling MouseEvent so the document-level
    // outside-click handler runs after the toggle's re-render —
    // mimicking the exact path that closed the panel before the
    // composedPath() fix.
    toggleBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    expect(isPlaylistManagerOpen()).toBe(true)
    expect(document.querySelectorAll('.pl-mgr-entry').length).toBe(1)
  })

  it('clicking truly outside the panel still closes it', () => {
    createPlaylist('orig')
    openPlaylistManager()
    expect(isPlaylistManagerOpen()).toBe(true)
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    outside.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(isPlaylistManagerOpen()).toBe(false)
  })

  it('renders entries only when the row is expanded', () => {
    const p = createPlaylist('with entries')
    addToPlaylist(p.id, 'INTERNAL_A')
    addToPlaylist(p.id, 'INTERNAL_B')
    openPlaylistManager()
    // Inactive rows start collapsed — no entries rendered.
    expect(document.querySelectorAll('.pl-mgr-entry').length).toBe(0)
    // Click the toggle to expand.
    const toggleBtn = document.querySelector<HTMLButtonElement>('.pl-mgr-row-toggle')!
    toggleBtn.click()
    expect(document.querySelectorAll('.pl-mgr-entry').length).toBe(2)
  })

  it('search filters the visible rows by name substring', () => {
    createPlaylist('Aurora Borealis')
    createPlaylist('Ocean Temperature')
    createPlaylist('Aurora Australis')
    openPlaylistManager()
    expect(document.querySelectorAll('.pl-mgr-row').length).toBe(3)
    const search = document.getElementById('playlist-manager-search') as HTMLInputElement
    search.value = 'aurora'
    search.dispatchEvent(new Event('input'))
    const rows = document.querySelectorAll('.pl-mgr-row')
    expect(rows.length).toBe(2)
  })

  it('search non-match shows the empty-results message', () => {
    createPlaylist('Aurora')
    openPlaylistManager()
    const search = document.getElementById('playlist-manager-search') as HTMLInputElement
    search.value = 'no-such-thing'
    search.dispatchEvent(new Event('input'))
    expect(document.querySelectorAll('.pl-mgr-row').length).toBe(0)
    expect(document.querySelector('.pl-mgr-empty')?.textContent).toContain('no-such-thing')
  })
})

describe('add-to-playlist popover', () => {
  it('opens anchored under the trigger element', () => {
    createPlaylist('first')
    const trigger = document.createElement('button')
    trigger.dataset.datasetId = 'DATASET_X'
    document.body.appendChild(trigger)
    openAddToPlaylistPopover('DATASET_X', trigger)
    const popover = document.getElementById('playlist-add-popover')
    expect(popover?.classList.contains('hidden')).toBe(false)
  })

  it('lists existing playlists', () => {
    createPlaylist('first')
    createPlaylist('second')
    const trigger = document.createElement('button')
    trigger.dataset.datasetId = 'DATASET_X'
    document.body.appendChild(trigger)
    openAddToPlaylistPopover('DATASET_X', trigger)
    expect(document.querySelectorAll('.pl-add-option').length).toBe(2)
  })

  it('clicking an option adds the dataset to that playlist', () => {
    const p = createPlaylist('first')
    const trigger = document.createElement('button')
    trigger.dataset.datasetId = 'DATASET_X'
    document.body.appendChild(trigger)
    openAddToPlaylistPopover('DATASET_X', trigger)
    const option = document.querySelector<HTMLButtonElement>('.pl-add-option')!
    option.click()
    const updated = loadPlaylists().find((x) => x.id === p.id)
    expect(updated?.datasets).toEqual([{ datasetId: 'DATASET_X', pauseForInput: true }])
  })

  it('does not double-add when the dataset is already in the playlist', () => {
    const p = createPlaylist('first')
    addToPlaylist(p.id, 'DATASET_X')
    const trigger = document.createElement('button')
    trigger.dataset.datasetId = 'DATASET_X'
    document.body.appendChild(trigger)
    openAddToPlaylistPopover('DATASET_X', trigger)
    const option = document.querySelector<HTMLButtonElement>('.pl-add-option')!
    expect(option.dataset.alreadyIn).toBe('1')
    option.click()
    expect(loadPlaylists().find((x) => x.id === p.id)?.datasets.length).toBe(1)
  })

  it('"new playlist" option creates and adds in one step', () => {
    const trigger = document.createElement('button')
    trigger.dataset.datasetId = 'DATASET_Y'
    document.body.appendChild(trigger)
    openAddToPlaylistPopover('DATASET_Y', trigger)
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Fresh playlist')
    const newBtn = document.getElementById('playlist-add-new') as HTMLButtonElement
    newBtn.click()
    const lists = loadPlaylists()
    expect(lists).toHaveLength(1)
    expect(lists[0].name).toBe('Fresh playlist')
    expect(lists[0].datasets).toEqual([{ datasetId: 'DATASET_Y', pauseForInput: true }])
    promptSpy.mockRestore()
  })
})

describe('"click to continue" prompt', () => {
  it('shows when the active entry has pauseForInput', async () => {
    const { initPlaylistPlayback, play, resetPlaylistPlaybackForTests } =
      await import('../services/playlistPlayback')
    resetPlaylistPlaybackForTests()
    initPlaylistPlayback({
      loadDataset: async () => {},
      hasTourOnLoad: () => false,
    })
    const p = createPlaylist('with pause')
    addToPlaylist(p.id, 'DATASET_A')
    // Re-fetch so we get the just-mutated playlist.
    const playlist = loadPlaylists().find((x) => x.id === p.id)!
    playlist.datasets[0].pauseForInput = true
    play(playlist)
    // The prompt is mounted by initPlaylistUI and toggled via the
    // onPlaybackChange listener — give the microtask queue a beat
    // so the listener has fired.
    await Promise.resolve()
    const host = document.getElementById('playlist-continue-prompt')
    expect(host).not.toBeNull()
    expect(host?.classList.contains('hidden')).toBe(false)
    resetPlaylistPlaybackForTests()
  })

  it('stays hidden when no playlist is playing', () => {
    const host = document.getElementById('playlist-continue-prompt')
    expect(host).not.toBeNull()
    expect(host?.classList.contains('hidden')).toBe(true)
  })
})

describe('handleImportFile', () => {
  it('imports a valid JSON file with playlists', async () => {
    const json = JSON.stringify([
      {
        id: 'pl-imported',
        name: 'imported',
        createdAt: '2026-01-01T00:00:00.000Z',
        datasets: [{ datasetId: 'X' }],
      },
    ])
    const file = new File([json], 'playlists.json', { type: 'application/json' })
    await handleImportFile(file)
    const lists = loadPlaylists()
    expect(lists.some((p) => p.id === 'pl-imported')).toBe(true)
  })

  it('rejects malformed JSON', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const file = new File(['not json {{{'], 'playlists.json', { type: 'application/json' })
    await handleImportFile(file)
    expect(loadPlaylists()).toEqual([])
    expect(alertSpy).toHaveBeenCalled()
    alertSpy.mockRestore()
  })

  it('rejects files larger than IMPORT_MAX_BYTES', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    // Generate a 1.5 MB string.
    const huge = 'a'.repeat(1_500_000)
    const file = new File([huge], 'huge.json', { type: 'application/json' })
    await handleImportFile(file)
    expect(loadPlaylists()).toEqual([])
    expect(alertSpy).toHaveBeenCalled()
    alertSpy.mockRestore()
  })

  it('rejects JSON that contains no valid playlists', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const file = new File([JSON.stringify([{ junk: true }])], 'bad.json', {
      type: 'application/json',
    })
    await handleImportFile(file)
    expect(loadPlaylists()).toEqual([])
    expect(alertSpy).toHaveBeenCalled()
    alertSpy.mockRestore()
  })
})
