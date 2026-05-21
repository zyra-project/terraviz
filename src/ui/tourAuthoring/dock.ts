/**
 * Floating tour-authoring dock — attaches to the regular SPA chrome
 * when the user opens `/?tourEdit=<id>` (or `=new`). First commit
 * (tour/A) ships:
 *
 *   - Dock chrome (header, close button)
 *   - One working capture: "Add camera step" → flyTo task from the
 *     current map view
 *   - In-memory task list rendered below the dock buttons
 *   - "Discard" button → navigates back to /publish/tours
 *
 * Later sub-phases extend the action set, add the task editor,
 * autosave, preview, and publish. Each capture function lives next
 * to the button so the per-task UX stays co-located with the wire
 * shape it produces.
 *
 * Architectural choice: the dock is a pure DOM mount. State lives
 * in `state.ts`; the renderer hands back a `dispose()` so the host
 * can tear down on session end.
 */

import { t } from '../../i18n'
import { escapeAttr, escapeHtml } from '../domUtils'
import { logger } from '../../utils/logger'
import type {
  Dataset,
  FlyToTaskParams,
  LoadDatasetTaskParams,
  MapViewContext,
  TourTaskDef,
} from '../../types'
import {
  appendTask,
  createEmptyState,
} from './state'

/**
 * Host-supplied callbacks. The dock only needs:
 *   - `getMapView()` → current viewport (`MapViewContext` shape) for
 *     camera-step capture
 *   - `onDiscard()` → user wants out; host clears the URL param and
 *     routes back to /publish/tours
 */
export interface TourAuthoringCallbacks {
  /** Current map view — used by the camera-step capture. */
  getMapView: () => MapViewContext | null
  /**
   * Phase 3pt/B — current primary-panel dataset, if any. Used by
   * the "Add current dataset" capture to record a `loadDataset`
   * task. Returns null when the primary panel is empty (no dataset
   * loaded yet) — the button no-ops in that case, same defensive
   * shape `getMapView` uses.
   */
  getCurrentDataset: () => Dataset | null
  /** User wants out — host clears the URL param and routes to
   *  /publish/tours. */
  onDiscard: () => void
}

export interface TourAuthoringHandle {
  /** Tear down the dock DOM + listeners. Idempotent. */
  dispose: () => void
}

/**
 * Mount the dock at the top-right of the viewport. Returns a
 * handle the host can use to dispose the dock on session end
 * (or on a re-mount). Re-mounting without disposing leaves
 * stacked docks — the host is responsible for the lifecycle.
 *
 * `tourId` is the URL-param value (`'new'` for fresh drafts, a
 * ULID otherwise). Stored on the state object for tour/E's
 * autosave; the dock itself doesn't act on it in tour/A.
 */
export function mountTourAuthoringDock(
  tourId: string,
  callbacks: TourAuthoringCallbacks,
): TourAuthoringHandle {
  let state = createEmptyState(tourId)
  const root = document.createElement('div')
  root.className = 'tour-authoring-dock'
  root.setAttribute('aria-label', t('tour.dock.aria'))
  root.setAttribute('role', 'region')
  document.body.appendChild(root)

  function render(): void {
    // Capture buttons grouped by intent — the simple stack at the
    // top (camera + dataset), the layout row (1/2/4 globes), the
    // environment toggles (day/night / clouds / stars / borders,
    // each with on+off), and the rotation-rate input. Phase 3pt/D
    // ships drag-to-reorder + click-to-edit on the task list; for
    // now the list is render-only.
    root.innerHTML = `
      <div class="tour-authoring-dock-header">
        <span class="tour-authoring-dock-title">${escapeHtml(t('tour.dock.title'))}</span>
        <button type="button" class="tour-authoring-dock-close"
                aria-label="${escapeAttr(t('tour.dock.discard.aria'))}">×</button>
      </div>
      <div class="tour-authoring-dock-actions">
        <button type="button" class="tour-authoring-action" data-action="capture-camera">
          ${escapeHtml(t('tour.dock.action.captureCamera'))}
        </button>
        <button type="button" class="tour-authoring-action" data-action="capture-dataset">
          ${escapeHtml(t('tour.dock.action.captureDataset'))}
        </button>
      </div>
      <div class="tour-authoring-dock-group">
        <span class="tour-authoring-dock-group-label">${escapeHtml(t('tour.dock.group.layout'))}</span>
        <div class="tour-authoring-dock-chiprow">
          <button type="button" class="tour-authoring-chip" data-action="layout" data-view="1globe">${escapeHtml(t('tour.dock.layout.1'))}</button>
          <button type="button" class="tour-authoring-chip" data-action="layout" data-view="2globes">${escapeHtml(t('tour.dock.layout.2'))}</button>
          <button type="button" class="tour-authoring-chip" data-action="layout" data-view="4globes">${escapeHtml(t('tour.dock.layout.4'))}</button>
        </div>
      </div>
      <div class="tour-authoring-dock-group">
        <span class="tour-authoring-dock-group-label">${escapeHtml(t('tour.dock.group.env'))}</span>
        ${renderEnvRow('envShowEarth', 'env.earth')}
        ${renderEnvRow('envShowDayNightLighting', 'env.dayNight')}
        ${renderEnvRow('envShowClouds', 'env.clouds')}
        ${renderEnvRow('envShowStars', 'env.stars')}
        ${renderEnvRow('envShowWorldBorder', 'env.borders')}
      </div>
      <div class="tour-authoring-dock-group">
        <label class="tour-authoring-dock-group-label" for="${ROTATION_INPUT_ID}">${escapeHtml(t('tour.dock.group.rotation'))}</label>
        <div class="tour-authoring-dock-inputrow">
          <input id="${ROTATION_INPUT_ID}" class="tour-authoring-input" type="number" step="0.1" min="-10" max="10"
                 value="1" aria-label="${escapeAttr(t('tour.dock.rotation.input.aria'))}">
          <button type="button" class="tour-authoring-chip" data-action="capture-rotation">${escapeHtml(t('tour.dock.rotation.add'))}</button>
        </div>
      </div>
      <div class="tour-authoring-dock-group">
        <label class="tour-authoring-dock-group-label" for="${PAUSE_INPUT_ID}">${escapeHtml(t('tour.dock.group.flow'))}</label>
        <div class="tour-authoring-dock-inputrow">
          <input id="${PAUSE_INPUT_ID}" class="tour-authoring-input" type="number" step="0.5" min="0" max="600"
                 value="5" aria-label="${escapeAttr(t('tour.dock.pause.seconds.aria'))}">
          <button type="button" class="tour-authoring-chip" data-action="capture-pause-seconds">${escapeHtml(t('tour.dock.pause.seconds.add'))}</button>
        </div>
        <div class="tour-authoring-dock-chiprow">
          <button type="button" class="tour-authoring-chip" data-action="capture-pause-input">${escapeHtml(t('tour.dock.pause.input.add'))}</button>
          <button type="button" class="tour-authoring-chip" data-action="capture-loop">${escapeHtml(t('tour.dock.loop.add'))}</button>
          <button type="button" class="tour-authoring-chip" data-action="capture-unload-all">${escapeHtml(t('tour.dock.unloadAll.add'))}</button>
        </div>
      </div>
      <ol class="tour-authoring-task-list" aria-label="${escapeAttr(t('tour.dock.taskList.aria'))}">
        ${state.tasks.length === 0
          ? `<li class="tour-authoring-task-empty">${escapeHtml(t('tour.dock.taskList.empty'))}</li>`
          : state.tasks
              .map((task, i) => `<li class="tour-authoring-task">
                <span class="tour-authoring-task-index">${i + 1}.</span>
                <span class="tour-authoring-task-label">${escapeHtml(describeTask(task))}</span>
              </li>`)
              .join('')}
      </ol>
    `
    wireButtons()
  }

  function renderEnvRow(taskKey: EnvToggleKey, labelKey: EnvLabelKey): string {
    return `
      <div class="tour-authoring-dock-envrow">
        <span class="tour-authoring-dock-envrow-label">${escapeHtml(t(labelKey))}</span>
        <button type="button" class="tour-authoring-chip" data-action="env" data-task="${taskKey}" data-state="on">${escapeHtml(t('tour.dock.env.on'))}</button>
        <button type="button" class="tour-authoring-chip" data-action="env" data-task="${taskKey}" data-state="off">${escapeHtml(t('tour.dock.env.off'))}</button>
      </div>
    `
  }

  function pushCaptured(task: TourTaskDef | null): void {
    if (!task) return
    state = appendTask(state, task)
    render()
  }

  function wireButtons(): void {
    root.querySelector('.tour-authoring-dock-close')?.addEventListener('click', () => {
      callbacks.onDiscard()
    })
    root
      .querySelector<HTMLButtonElement>('[data-action="capture-camera"]')
      ?.addEventListener('click', () => pushCaptured(captureCameraStep(callbacks)))
    root
      .querySelector<HTMLButtonElement>('[data-action="capture-dataset"]')
      ?.addEventListener('click', () => pushCaptured(captureCurrentDataset(callbacks)))
    root
      .querySelectorAll<HTMLButtonElement>('[data-action="layout"]')
      .forEach(btn => {
        btn.addEventListener('click', () => {
          const view = btn.dataset.view
          if (view) pushCaptured({ setEnvView: view })
        })
      })
    root
      .querySelectorAll<HTMLButtonElement>('[data-action="env"]')
      .forEach(btn => {
        btn.addEventListener('click', () => {
          const taskKey = btn.dataset.task as EnvToggleKey | undefined
          const value = btn.dataset.state as 'on' | 'off' | undefined
          if (!taskKey || !value) return
          pushCaptured(buildEnvTask(taskKey, value))
        })
      })
    root
      .querySelector<HTMLButtonElement>('[data-action="capture-rotation"]')
      ?.addEventListener('click', () => {
        const input = root.querySelector<HTMLInputElement>(`#${ROTATION_INPUT_ID}`)
        if (!input) return
        const value = parseFloat(input.value)
        // Defensive — `<input type=number>` returns '' for blank.
        if (Number.isFinite(value)) pushCaptured({ setGlobeRotationRate: value })
      })
    root
      .querySelector<HTMLButtonElement>('[data-action="capture-pause-seconds"]')
      ?.addEventListener('click', () => {
        const input = root.querySelector<HTMLInputElement>(`#${PAUSE_INPUT_ID}`)
        if (!input) return
        const value = parseFloat(input.value)
        // Negative or zero pauses don't make sense — the runtime
        // would skip them, but keeping invalid tasks out of the
        // file keeps the post-3pt/D editor cleaner.
        if (Number.isFinite(value) && value > 0) pushCaptured({ pauseSeconds: value })
      })
    root
      .querySelector<HTMLButtonElement>('[data-action="capture-pause-input"]')
      ?.addEventListener('click', () => pushCaptured({ pauseForInput: '' }))
    root
      .querySelector<HTMLButtonElement>('[data-action="capture-loop"]')
      ?.addEventListener('click', () => pushCaptured({ loopToBeginning: '' }))
    root
      .querySelector<HTMLButtonElement>('[data-action="capture-unload-all"]')
      ?.addEventListener('click', () => pushCaptured({ unloadAllDatasets: '' }))
  }

  render()
  return {
    dispose() {
      root.remove()
    },
  }
}

/** Unique input ids keep the `<label for="...">` association valid
 *  even when multiple docks coexist (which the singleton guard in
 *  `index.ts` should prevent, but defending here keeps the page
 *  predictable if a test mounts more than one). */
const ROTATION_INPUT_ID = 'tour-authoring-rotation-input'
const PAUSE_INPUT_ID = 'tour-authoring-pause-input'

/** Discriminating union of the env-toggle task keys the dock can
 *  emit. Phase 3pt/B; tour/C extends with more `envShow*` task
 *  shapes (alpha for clouds, etc.) and richer overlay captures. */
type EnvToggleKey =
  | 'envShowDayNightLighting'
  | 'envShowClouds'
  | 'envShowStars'
  | 'envShowWorldBorder'
  | 'envShowEarth'

type EnvLabelKey =
  | 'env.dayNight'
  | 'env.clouds'
  | 'env.stars'
  | 'env.borders'
  | 'env.earth'

/** Phase 3pt/B — build an env-toggle task. Keyed on the dock's
 *  `data-task` attribute so each chip button stays declarative.
 *  Switch (rather than direct object construction) keeps TS's
 *  discriminated-union checker happy without an `as` cast. */
function buildEnvTask(key: EnvToggleKey, value: 'on' | 'off'): TourTaskDef {
  switch (key) {
    case 'envShowDayNightLighting':
      return { envShowDayNightLighting: value }
    case 'envShowClouds':
      return { envShowClouds: value }
    case 'envShowStars':
      return { envShowStars: value }
    case 'envShowWorldBorder':
      return { envShowWorldBorder: value }
    case 'envShowEarth':
      return { envShowEarth: value }
  }
}

/**
 * Phase 3pt/B — record a `loadDataset` task for the currently-
 * loaded primary-panel dataset. Returns null when no dataset is
 * loaded (typical at session start) so the button no-ops rather
 * than emitting a useless `{ id: '' }` task. The capture mirrors
 * the SOS authoring tool's "Add current dataset" gesture, which
 * is the dominant tour-creation workflow — a publisher loads a
 * dataset, finds the view they like, captures both.
 */
function captureCurrentDataset(callbacks: TourAuthoringCallbacks): TourTaskDef | null {
  const dataset = callbacks.getCurrentDataset()
  if (!dataset) {
    logger.warn('[tourAuthoring] capture-dataset: no current dataset on the primary panel')
    return null
  }
  const params: LoadDatasetTaskParams = { id: dataset.id }
  return { loadDataset: params }
}

/**
 * Build a `flyTo` task from the current map view. Returns null
 * when the renderer can't supply a view (e.g. boot race — the
 * dock loaded before MapLibre had its first render). Caller
 * logs + skips.
 *
 * `altmi` is derived from the renderer's zoom level via the
 * inverse of `execFlyTo`'s zoom math in `tourEngine.ts`:
 *
 *     altKm = (6371 × 2) / 2^zoom
 *     altmi = altKm / (MI_TO_KM × SOS_ALTITUDE_SCALE)
 *
 * The two constants come from `tourEngine.ts`. Inlined here
 * rather than imported so the dock isn't coupled to the engine's
 * private module surface.
 */
function captureCameraStep(callbacks: TourAuthoringCallbacks): TourTaskDef | null {
  const view = callbacks.getMapView()
  if (!view) {
    logger.warn('[tourAuthoring] capture-camera: no view context available')
    return null
  }
  const altMi = altmiFromZoom(view.zoom)
  const params: FlyToTaskParams = {
    lat: roundTo(view.center.lat, 4),
    lon: roundTo(view.center.lng, 4),
    altmi: roundTo(altMi, 0),
    // Default to animated — that's what almost every SOS-format tour
    // uses, and the user can flip it later via the task editor (tour/D).
    animated: true,
  }
  return { flyTo: params }
}

const MI_TO_KM = 1.60934
const SOS_ALTITUDE_SCALE = 0.2
const EARTH_RADIUS_KM = 6371

function altmiFromZoom(zoom: number): number {
  const altKm = (EARTH_RADIUS_KM * 2) / Math.pow(2, zoom)
  return altKm / (MI_TO_KM * SOS_ALTITUDE_SCALE)
}

function roundTo(n: number, decimals: number): number {
  const factor = Math.pow(10, decimals)
  return Math.round(n * factor) / factor
}

/**
 * One-line task summary for the in-dock task list. Mirrors the
 * SOS authoring tool's convention: action name + key params.
 * Phase 3pt/D extends this with click-to-edit; for now it's
 * just a label.
 */
function describeTask(task: TourTaskDef): string {
  if ('flyTo' in task) {
    const p = task.flyTo
    return t('tour.task.flyTo.summary', { lat: p.lat, lon: p.lon, altmi: p.altmi })
  }
  if ('loadDataset' in task) {
    // Title isn't on the task (the engine resolves id → dataset
    // at run-time). Show the id so the publisher can spot the
    // task — tour/D's editor will fetch the dataset row for a
    // richer label.
    return t('tour.task.loadDataset.summary', { id: task.loadDataset.id })
  }
  if ('setEnvView' in task) {
    return t('tour.task.setEnvView.summary', { view: task.setEnvView })
  }
  if ('envShowDayNightLighting' in task) {
    return t('tour.task.env.dayNight', { state: task.envShowDayNightLighting })
  }
  if ('envShowClouds' in task) {
    return t('tour.task.env.clouds', { state: task.envShowClouds })
  }
  if ('envShowStars' in task) {
    return t('tour.task.env.stars', { state: task.envShowStars })
  }
  if ('envShowWorldBorder' in task) {
    return t('tour.task.env.borders', { state: task.envShowWorldBorder })
  }
  if ('envShowEarth' in task) {
    return t('tour.task.env.earth', { state: task.envShowEarth })
  }
  if ('setGlobeRotationRate' in task) {
    return t('tour.task.rotation.summary', { rate: task.setGlobeRotationRate })
  }
  if ('pauseSeconds' in task) {
    return t('tour.task.pause.seconds', { seconds: task.pauseSeconds })
  }
  if ('pauseForInput' in task) {
    return t('tour.task.pause.input')
  }
  if ('loopToBeginning' in task) {
    return t('tour.task.loop')
  }
  if ('unloadAllDatasets' in task) {
    return t('tour.task.unloadAll')
  }
  // Unknown task shape — fall back to the JSON key. Future
  // sub-phases extend this switch as more captures land.
  const key = Object.keys(task)[0]
  return key
}
