import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountTourAuthoringDock } from './dock'
import type { Dataset, MapViewContext } from '../../types'

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'DS_TEST',
    title: 'Test Dataset',
    format: 'video/mp4',
    dataLink: '/api/v1/datasets/DS_TEST/manifest',
    ...overrides,
  }
}

function makeView(overrides: Partial<MapViewContext> = {}): MapViewContext {
  return {
    center: { lat: 29, lng: -89 },
    zoom: 3,
    bearing: 0,
    pitch: 0,
    bounds: { west: -180, south: -90, east: 180, north: 90 },
    visibleCountries: [],
    visibleOceans: [],
    ...overrides,
  }
}

afterEach(() => {
  // Each test mounts the dock to body; tear them all down so the
  // next test starts from a clean DOM.
  document.querySelectorAll('.tour-authoring-dock').forEach(el => el.remove())
})

describe('mountTourAuthoringDock (tour/A)', () => {
  it('appends a dock element with the documented role + aria label', () => {
    mountTourAuthoringDock('new', {
      getMapView: () => makeView(), getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    const dock = document.querySelector('.tour-authoring-dock')!
    expect(dock).toBeTruthy()
    expect(dock.getAttribute('role')).toBe('region')
    expect(dock.getAttribute('aria-label')).toBe('Tour authoring dock')
  })

  it('shows the empty-state message when no tasks have been captured', () => {
    mountTourAuthoringDock('new', {
      getMapView: () => makeView(), getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    const empty = document.querySelector('.tour-authoring-task-empty')
    expect(empty?.textContent).toContain('No tasks captured yet')
  })

  it('appends a flyTo task when "Add camera step" is clicked', () => {
    mountTourAuthoringDock('new', {
      getCurrentDataset: () => null, getMapView: () => makeView({ center: { lat: 35.7, lng: 139.7 }, zoom: 5 }),
      onDiscard: () => {},
    })
    const btn = document.querySelector<HTMLButtonElement>('[data-action="capture-camera"]')!
    btn.click()
    const tasks = document.querySelectorAll('.tour-authoring-task')
    expect(tasks).toHaveLength(1)
    const label = tasks[0].querySelector('.tour-authoring-task-label')?.textContent ?? ''
    // The summary template renders "Camera → {lat}, {lon} at {altmi} mi".
    expect(label).toContain('Camera')
    expect(label).toContain('35.7')
    expect(label).toContain('139.7')
  })

  it('renders captured tasks in capture order with 1-based indices', () => {
    mountTourAuthoringDock('new', {
      getCurrentDataset: () => null, getMapView: () => makeView({ center: { lat: 0, lng: 0 } }),
      onDiscard: () => {},
    })
    const btn = document.querySelector<HTMLButtonElement>('[data-action="capture-camera"]')!
    btn.click()
    btn.click()
    btn.click()
    const indices = Array.from(document.querySelectorAll('.tour-authoring-task-index')).map(
      el => el.textContent,
    )
    expect(indices).toEqual(['1.', '2.', '3.'])
  })

  it('does not capture a task when the renderer has no view context yet', () => {
    // Boot race — dock mounts before MapLibre fires its first
    // render. Click should no-op (warning logged, no task added)
    // rather than crash.
    mountTourAuthoringDock('new', {
      getMapView: () => null,
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    document.querySelector<HTMLButtonElement>('[data-action="capture-camera"]')!.click()
    expect(document.querySelectorAll('.tour-authoring-task')).toHaveLength(0)
    expect(document.querySelectorAll('.tour-authoring-task-empty')).toHaveLength(1)
  })

  it('fires onDiscard when the close button is clicked', () => {
    const onDiscard = vi.fn()
    mountTourAuthoringDock('new', {
      getMapView: () => makeView(), getCurrentDataset: () => null,
      onDiscard,
    })
    document.querySelector<HTMLButtonElement>('.tour-authoring-dock-close')!.click()
    expect(onDiscard).toHaveBeenCalledOnce()
  })

  it('appends a loadDataset task when "Add current dataset" is clicked', () => {
    // Phase 3pt/B — "current dataset" capture mirrors the SOS
    // authoring tool's "Add current dataset" gesture.
    mountTourAuthoringDock('new', {
      getMapView: () => makeView(),
      getCurrentDataset: () => makeDataset({ id: 'DS_HURR', title: 'Hurricane Tracks' }),
      onDiscard: () => {},
    })
    document.querySelector<HTMLButtonElement>('[data-action="capture-dataset"]')!.click()
    const labels = Array.from(document.querySelectorAll('.tour-authoring-task-label')).map(
      el => el.textContent ?? '',
    )
    expect(labels).toHaveLength(1)
    expect(labels[0]).toContain('Load dataset')
    expect(labels[0]).toContain('DS_HURR')
  })

  it('no-ops "Add current dataset" when no dataset is loaded', () => {
    mountTourAuthoringDock('new', {
      getMapView: () => makeView(),
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    document.querySelector<HTMLButtonElement>('[data-action="capture-dataset"]')!.click()
    expect(document.querySelectorAll('.tour-authoring-task')).toHaveLength(0)
    expect(document.querySelectorAll('.tour-authoring-task-empty')).toHaveLength(1)
  })

  it('captures setEnvView tasks from the Layout chips (1 / 2 / 4 globes)', () => {
    mountTourAuthoringDock('new', {
      getMapView: () => makeView(),
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    document
      .querySelectorAll<HTMLButtonElement>('[data-action="layout"]')
      .forEach(btn => btn.click())
    const labels = Array.from(document.querySelectorAll('.tour-authoring-task-label')).map(
      el => el.textContent ?? '',
    )
    expect(labels).toHaveLength(3)
    // Order matches DOM order — `1globe`, `2globes`, `4globes`.
    expect(labels[0]).toContain('1globe')
    expect(labels[1]).toContain('2globes')
    expect(labels[2]).toContain('4globes')
  })

  it('captures env-toggle tasks (day/night / clouds / stars / borders × on/off)', () => {
    mountTourAuthoringDock('new', {
      getMapView: () => makeView(),
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    // Pick day/night on + clouds off as a representative pair.
    document
      .querySelector<HTMLButtonElement>(
        '[data-action="env"][data-task="envShowDayNightLighting"][data-state="on"]',
      )!
      .click()
    document
      .querySelector<HTMLButtonElement>(
        '[data-action="env"][data-task="envShowClouds"][data-state="off"]',
      )!
      .click()
    const labels = Array.from(document.querySelectorAll('.tour-authoring-task-label')).map(
      el => el.textContent ?? '',
    )
    expect(labels).toHaveLength(2)
    expect(labels[0]).toContain('Day/night')
    expect(labels[0]).toContain('on')
    expect(labels[1]).toContain('Clouds')
    expect(labels[1]).toContain('off')
  })

  it('captures setGlobeRotationRate from the rotation input', () => {
    mountTourAuthoringDock('new', {
      getMapView: () => makeView(),
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    const input = document.querySelector<HTMLInputElement>(
      '#tour-authoring-rotation-input',
    )!
    input.value = '2.5'
    document
      .querySelector<HTMLButtonElement>('[data-action="capture-rotation"]')!
      .click()
    const label = document.querySelector('.tour-authoring-task-label')?.textContent ?? ''
    expect(label).toContain('Rotation rate')
    expect(label).toContain('2.5')
  })

  it('no-ops the rotation capture when the input is blank or non-numeric', () => {
    mountTourAuthoringDock('new', {
      getMapView: () => makeView(),
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    const input = document.querySelector<HTMLInputElement>(
      '#tour-authoring-rotation-input',
    )!
    input.value = ''
    document
      .querySelector<HTMLButtonElement>('[data-action="capture-rotation"]')!
      .click()
    expect(document.querySelectorAll('.tour-authoring-task')).toHaveLength(0)
  })

  it('captures pauseSeconds when the pause input is valid', () => {
    // Phase 3pt/C — flow-control captures.
    mountTourAuthoringDock('new', {
      getMapView: () => makeView(),
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    const input = document.querySelector<HTMLInputElement>(
      '#tour-authoring-pause-input',
    )!
    input.value = '3'
    document
      .querySelector<HTMLButtonElement>('[data-action="capture-pause-seconds"]')!
      .click()
    const label = document.querySelector('.tour-authoring-task-label')?.textContent ?? ''
    expect(label).toContain('Pause 3')
  })

  it('refuses pauseSeconds for 0 / negative / blank input', () => {
    mountTourAuthoringDock('new', {
      getMapView: () => makeView(),
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    const input = document.querySelector<HTMLInputElement>(
      '#tour-authoring-pause-input',
    )!
    const btn = document.querySelector<HTMLButtonElement>(
      '[data-action="capture-pause-seconds"]',
    )!
    for (const value of ['', '0', '-1']) {
      input.value = value
      btn.click()
    }
    expect(document.querySelectorAll('.tour-authoring-task')).toHaveLength(0)
  })

  it('captures pauseForInput / loopToBeginning / unloadAllDatasets buttons', () => {
    mountTourAuthoringDock('new', {
      getMapView: () => makeView(),
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    document
      .querySelector<HTMLButtonElement>('[data-action="capture-pause-input"]')!
      .click()
    document.querySelector<HTMLButtonElement>('[data-action="capture-loop"]')!.click()
    document
      .querySelector<HTMLButtonElement>('[data-action="capture-unload-all"]')!
      .click()
    const labels = Array.from(document.querySelectorAll('.tour-authoring-task-label')).map(
      el => el.textContent ?? '',
    )
    expect(labels).toEqual([
      'Pause for input',
      'Loop to beginning',
      'Unload all datasets',
    ])
  })

  it('renders the env.earth toggle alongside the other env rows', () => {
    // Earth visibility (`envShowEarth`) was added in tour/C alongside
    // the existing day-night / clouds / stars / borders rows.
    mountTourAuthoringDock('new', {
      getMapView: () => makeView(),
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    document
      .querySelector<HTMLButtonElement>(
        '[data-action="env"][data-task="envShowEarth"][data-state="on"]',
      )!
      .click()
    const label = document.querySelector('.tour-authoring-task-label')?.textContent ?? ''
    expect(label).toContain('Earth')
    expect(label).toContain('on')
  })

  describe('additional captures (tour/F)', () => {
    it('captures tiltRotateCamera from current pitch + bearing', () => {
      mountTourAuthoringDock('new', {
        getMapView: () => makeView({ pitch: 35, bearing: 120 }),
        getCurrentDataset: () => null,
        onDiscard: () => {},
      })
      document
        .querySelector<HTMLButtonElement>('[data-action="capture-tilt"]')!
        .click()
      const label = document.querySelector('.tour-authoring-task-label')?.textContent ?? ''
      expect(label).toContain('Tilt 35')
      expect(label).toContain('rotate 120')
    })

    it('captures resetCameraZoomOut and resetCameraAndZoomOut', () => {
      mountTourAuthoringDock('new', {
        getMapView: () => makeView(),
        getCurrentDataset: () => null,
        onDiscard: () => {},
      })
      document
        .querySelector<HTMLButtonElement>('[data-action="capture-reset-zoom"]')!
        .click()
      document
        .querySelector<HTMLButtonElement>('[data-action="capture-reset-and-zoom"]')!
        .click()
      const labels = Array.from(document.querySelectorAll('.tour-authoring-task-label')).map(
        el => el.textContent ?? '',
      )
      expect(labels).toEqual(['Reset zoom', 'Reset camera + zoom'])
    })

    it('captures enableTourPlayer / tourPlayerWindow toggles', () => {
      mountTourAuthoringDock('new', {
        getMapView: () => makeView(),
        getCurrentDataset: () => null,
        onDiscard: () => {},
      })
      document
        .querySelector<HTMLButtonElement>(
          '[data-action="env"][data-task="enableTourPlayer"][data-state="on"]',
        )!
        .click()
      document
        .querySelector<HTMLButtonElement>(
          '[data-action="env"][data-task="tourPlayerWindow"][data-state="off"]',
        )!
        .click()
      const labels = Array.from(document.querySelectorAll('.tour-authoring-task-label')).map(
        el => el.textContent ?? '',
      )
      expect(labels[0]).toContain('Tour player')
      expect(labels[0]).toContain('on')
      expect(labels[1]).toContain('Player window')
      expect(labels[1]).toContain('off')
    })

    it('auto-assigns sequential dataset handles on captureCurrentDataset', () => {
      mountTourAuthoringDock('new', {
        getMapView: () => makeView(),
        getCurrentDataset: () => makeDataset({ id: 'DS_A' }),
        onDiscard: () => {},
      })
      const btn = document.querySelector<HTMLButtonElement>(
        '[data-action="capture-dataset"]',
      )!
      btn.click()
      btn.click()
      btn.click()
      // Labels are "Load dataset → DS_A" three times; check the
      // underlying state via the editor JSON to confirm handles.
      const editBtns = document.querySelectorAll<HTMLButtonElement>(
        '[data-action="edit-task"]',
      )
      editBtns[0].click()
      const json = JSON.parse(
        document.querySelector<HTMLTextAreaElement>(
          '.tour-authoring-task-editor-input',
        )!.value,
      )
      expect(json.loadDataset.datasetID).toBe('dataset1')
      document
        .querySelector<HTMLButtonElement>('[data-action="cancel-edit"]')!
        .click()
      editBtns[2].click()
      const json3 = JSON.parse(
        document.querySelector<HTMLTextAreaElement>(
          '.tour-authoring-task-editor-input',
        )!.value,
      )
      expect(json3.loadDataset.datasetID).toBe('dataset3')
    })

    it('renders the unload-by-handle dropdown only after a dataset capture', () => {
      mountTourAuthoringDock('new', {
        getMapView: () => makeView(),
        getCurrentDataset: () => makeDataset({ id: 'DS_A' }),
        onDiscard: () => {},
      })
      // Empty state → no dropdown.
      expect(
        document.querySelector('#tour-authoring-unload-handle-select'),
      ).toBeNull()
      // Capture a dataset → dropdown appears with one handle.
      document
        .querySelector<HTMLButtonElement>('[data-action="capture-dataset"]')!
        .click()
      const select = document.querySelector<HTMLSelectElement>(
        '#tour-authoring-unload-handle-select',
      )!
      expect(select).toBeTruthy()
      const options = Array.from(select.options).map(o => o.value)
      expect(options).toEqual(['dataset1'])
      // Click + Unload by handle → captures unloadDataset for the
      // selected handle.
      document
        .querySelector<HTMLButtonElement>('[data-action="capture-unload-handle"]')!
        .click()
      const labels = Array.from(document.querySelectorAll('.tour-authoring-task-label')).map(
        el => el.textContent ?? '',
      )
      expect(labels[1]).toContain('Unload dataset')
      expect(labels[1]).toContain('dataset1')
    })
  })

  describe('task editor (tour/D)', () => {
    function dock() {
      return mountTourAuthoringDock('new', {
        getMapView: () => makeView(),
        getCurrentDataset: () => null,
        onDiscard: () => {},
      })
    }
    function addThreeCaptures(): void {
      // Three flyTo tasks at distinct positions so reordering is
      // observable in the rendered labels.
      const positions: [number, number][] = [[10, 20], [30, 40], [50, 60]]
      for (const [lat, lng] of positions) {
        document.querySelectorAll('.tour-authoring-dock').forEach(el => el.remove())
        // Re-mount with the next position pre-loaded so the
        // capture button picks it up.
      }
      // Simpler: just click camera 3 times against the same view; the
      // task labels will be identical, but the count + index checks
      // still work and the reorder behaviour is observable via
      // expanded JSON.
    }
    void addThreeCaptures

    it('removes a task when the delete button is clicked', () => {
      dock()
      const cam = document.querySelector<HTMLButtonElement>(
        '[data-action="capture-camera"]',
      )!
      cam.click()
      cam.click()
      expect(document.querySelectorAll('.tour-authoring-task')).toHaveLength(2)
      document
        .querySelector<HTMLButtonElement>(
          '.tour-authoring-task:first-child [data-action="delete-task"]',
        )!
        .click()
      expect(document.querySelectorAll('.tour-authoring-task')).toHaveLength(1)
    })

    it('expands an inline JSON editor when the edit button is clicked', () => {
      dock()
      document
        .querySelector<HTMLButtonElement>('[data-action="capture-camera"]')!
        .click()
      document
        .querySelector<HTMLButtonElement>('[data-action="edit-task"]')!
        .click()
      const editor = document.querySelector<HTMLTextAreaElement>(
        '.tour-authoring-task-editor-input',
      )!
      expect(editor).toBeTruthy()
      // Pretty-printed JSON of the captured flyTo task.
      expect(editor.value).toContain('"flyTo"')
      expect(editor.value).toContain('"lat"')
    })

    it('saves an edited task back into state when Save is clicked', () => {
      dock()
      document
        .querySelector<HTMLButtonElement>('[data-action="capture-camera"]')!
        .click()
      document
        .querySelector<HTMLButtonElement>('[data-action="edit-task"]')!
        .click()
      const editor = document.querySelector<HTMLTextAreaElement>(
        '.tour-authoring-task-editor-input',
      )!
      editor.value = JSON.stringify({ pauseSeconds: 7 })
      document
        .querySelector<HTMLButtonElement>('[data-action="save-edit"]')!
        .click()
      // Editor collapses; label reflects the new task shape.
      expect(document.querySelector('.tour-authoring-task-editor-input')).toBeNull()
      const label = document.querySelector('.tour-authoring-task-label')?.textContent ?? ''
      expect(label).toContain('Pause 7')
    })

    it('shows an inline error and keeps the editor open when Save sees invalid JSON', () => {
      dock()
      document
        .querySelector<HTMLButtonElement>('[data-action="capture-camera"]')!
        .click()
      document
        .querySelector<HTMLButtonElement>('[data-action="edit-task"]')!
        .click()
      const editor = document.querySelector<HTMLTextAreaElement>(
        '.tour-authoring-task-editor-input',
      )!
      editor.value = '{not valid json'
      document
        .querySelector<HTMLButtonElement>('[data-action="save-edit"]')!
        .click()
      const error = document.querySelector<HTMLElement>(
        '.tour-authoring-task-editor-error',
      )!
      expect(error.classList.contains('tour-authoring-task-editor-error-visible')).toBe(true)
      expect(error.textContent).toContain('Invalid JSON')
      // Editor still open — user's text preserved (untouched DOM).
      expect(document.querySelector('.tour-authoring-task-editor-input')).toBeTruthy()
    })

    it('rejects JSON that is not a single-key object', () => {
      dock()
      document
        .querySelector<HTMLButtonElement>('[data-action="capture-camera"]')!
        .click()
      document
        .querySelector<HTMLButtonElement>('[data-action="edit-task"]')!
        .click()
      const editor = document.querySelector<HTMLTextAreaElement>(
        '.tour-authoring-task-editor-input',
      )!
      editor.value = '{"flyTo": {}, "pauseSeconds": 5}'
      document
        .querySelector<HTMLButtonElement>('[data-action="save-edit"]')!
        .click()
      const error = document.querySelector<HTMLElement>(
        '.tour-authoring-task-editor-error',
      )!
      expect(error.textContent).toMatch(/exactly one task key/)
    })

    it('collapses the editor on Cancel without modifying state', () => {
      dock()
      document
        .querySelector<HTMLButtonElement>('[data-action="capture-camera"]')!
        .click()
      const beforeLabel = document
        .querySelector('.tour-authoring-task-label')!
        .textContent
      document
        .querySelector<HTMLButtonElement>('[data-action="edit-task"]')!
        .click()
      const editor = document.querySelector<HTMLTextAreaElement>(
        '.tour-authoring-task-editor-input',
      )!
      editor.value = JSON.stringify({ pauseSeconds: 99 })
      document
        .querySelector<HTMLButtonElement>('[data-action="cancel-edit"]')!
        .click()
      expect(document.querySelector('.tour-authoring-task-editor-input')).toBeNull()
      // Label unchanged.
      expect(document.querySelector('.tour-authoring-task-label')?.textContent).toBe(
        beforeLabel,
      )
    })

    it('reorders tasks on a drag-drop gesture (drop later → reorder later)', () => {
      dock()
      const cam = document.querySelector<HTMLButtonElement>(
        '[data-action="capture-camera"]',
      )!
      cam.click()
      cam.click()
      cam.click()
      // Edit task 1 to make it identifiable.
      document
        .querySelector<HTMLButtonElement>('[data-action="edit-task"]')!
        .click()
      const editor = document.querySelector<HTMLTextAreaElement>(
        '.tour-authoring-task-editor-input',
      )!
      editor.value = JSON.stringify({ pauseSeconds: 1 })
      document
        .querySelector<HTMLButtonElement>('[data-action="save-edit"]')!
        .click()
      // The labels now read: ["Pause 1 sec", "Camera → ...", "Camera → ..."].
      const items = Array.from(
        document.querySelectorAll<HTMLLIElement>('.tour-authoring-task'),
      )
      expect(items[0].querySelector('.tour-authoring-task-label')?.textContent).toContain(
        'Pause',
      )
      // Drag item 0 onto item 2 → it should land at index 2.
      const list = document.querySelector<HTMLOListElement>('.tour-authoring-task-list')!
      const transfer = new DataTransfer()
      // Use the items[0] (Pause) and items[2] (Camera) refs.
      items[0].dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }),
      )
      items[2].dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: transfer }))
      items[2].dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }))
      list.dispatchEvent(new DragEvent('dragend', { bubbles: true }))
      const afterLabels = Array.from(
        document.querySelectorAll('.tour-authoring-task-label'),
      ).map(el => el.textContent ?? '')
      // After moving index 0 → index 2: [Cam, Cam, Pause]
      expect(afterLabels[2]).toContain('Pause')
    })
  })

  it('captures altmi from zoom (higher zoom → lower altitude)', () => {
    // Inverse of `execFlyTo`'s zoom math in `tourEngine.ts`:
    //   altKm = (6371 × 2) / 2^zoom
    //   altmi = altKm / (MI_TO_KM × SOS_ALTITUDE_SCALE)
    // At zoom 0: altKm = 12742, altmi ≈ 39580 (very high).
    // At zoom 5: altKm = 398.18, altmi ≈ 1236.
    // Just confirm the relationship — exact magnitudes vary with
    // the constants, so we assert "higher zoom yields smaller
    // altmi" rather than pinning the number.
    function altmiAt(zoom: number): number {
      document.querySelectorAll('.tour-authoring-dock').forEach(el => el.remove())
      let captured: { altmi: number } | null = null
      mountTourAuthoringDock('new', {
        getCurrentDataset: () => null, getMapView: () => makeView({ zoom }),
        onDiscard: () => {},
      })
      // Patch the label parser by reading the rendered text.
      const btn = document.querySelector<HTMLButtonElement>(
        '[data-action="capture-camera"]',
      )!
      btn.click()
      const label =
        document.querySelector('.tour-authoring-task-label')?.textContent ?? ''
      const match = /at (\d+) mi/.exec(label)
      if (match) captured = { altmi: parseInt(match[1], 10) }
      return captured?.altmi ?? -1
    }
    const lo = altmiAt(0)
    const hi = altmiAt(5)
    expect(lo).toBeGreaterThan(hi)
  })
})
