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
