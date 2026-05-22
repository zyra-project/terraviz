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
  moveTask,
  removeTaskAt,
  updateTaskAt,
} from './state'
import { fetchTourJson, publishTour, updateTourMetadata } from './api'
import { createAutosaveManager, type AutosaveStatus } from './autosave'

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
  // Phase 3pt/D — index of the task currently expanded for inline
  // JSON edit; -1 when no row is being edited.
  let editingIndex = -1
  // Phase 3pt-review/B — buffer the in-progress textarea contents
  // so a re-render (e.g. autosave status flip) doesn't reset the
  // editor to `JSON.stringify(task)` and eat the publisher's
  // unsaved typing. Null when the buffer is empty; the current
  // editing row writes into it on every `input`. Copilot
  // discussion_r3284513411.
  let editorBuffer: string | null = null
  // Drag source index — tracked across `dragstart`/`drop` events.
  let draggingIndex = -1
  // Phase 3pt/E — autosave status surfaced in the dock header.
  let autosaveStatus: AutosaveStatus = 'idle'
  let autosaveError = ''
  // Phase 3pt/G — publish lifecycle. `idle` → user can click;
  // `publishing` → server round-trip in flight; `published` →
  // success badge displayed briefly. `error` carries the
  // server's message in the title tooltip.
  let publishStatus: 'idle' | 'publishing' | 'published' | 'error' = 'idle'
  let publishError = ''
  // Phase 3pt-review/C — rename UI. `titleValue` mirrors the
  // input's text and is the only source of truth while the
  // publisher is typing (re-renders preserve it via the same
  // pattern editorBuffer uses for the JSON editor).
  // `metadataSaveTimer` debounces the PUT round-trip;
  // `metadataSaveError` surfaces a failed save as inline text
  // under the input. Phase 3pt-review/D extends this to also
  // cover description + visibility, all bundled into one PUT.
  let titleValue = ''
  let descriptionValue = ''
  let visibilityValue: 'public' | 'federated' | 'restricted' | 'private' = 'public'
  let metadataSaveError = ''
  let metadataSaveTimer: ReturnType<typeof setTimeout> | null = null
  // Phase 3pt-review/E — capture-input values held in closure
  // state so a re-render (autosave-status flip, capture appended
  // elsewhere) doesn't wipe partial typing back to the default.
  // Strings rather than numbers so an interim blank state during
  // typing round-trips cleanly. Copilot discussion_r3285756544.
  let rotationValue = '1'
  let pauseValue = '5'
  // Phase 3pt-review/A — per-mount input ids so duplicate-id
  // label associations can't happen if a second dock ever
  // coexists.
  const inputIds = nextDockInputIds()
  const root = document.createElement('div')
  root.className = 'tour-authoring-dock'
  root.setAttribute('aria-label', t('tour.dock.aria'))
  root.setAttribute('role', 'region')
  document.body.appendChild(root)

  // Phase 3pt/E — autosave manager. Promotes a `'new'` sentinel
  // to a server-issued ULID after the first save; the dock's
  // `getTourId` getter reads through so callers stay current.
  const autosave = createAutosaveManager(tourId, {
    onStatusChange: (status, error) => {
      autosaveStatus = status
      autosaveError = error ?? ''
      render()
    },
    onTourIdResolved: newId => {
      state = { ...state, tourId: newId }
      // Rewrite the URL so a reload reopens the same draft.
      // History.replaceState keeps the back button clean (no
      // intermediate `?tourEdit=new` entry).
      const url = new URL(window.location.href)
      url.searchParams.set('tourEdit', newId)
      window.history.replaceState({}, '', url.toString())
    },
  })

  function requestAutosave(): void {
    autosave.requestSave({ tourTasks: state.tasks })
  }

  /**
   * Phase 3pt/G — publish the current draft. Flushes any
   * pending autosave first so the published snapshot matches
   * what the publisher just captured (otherwise a fresh
   * capture could publish with stale R2 content). Surfaces
   * server-side errors via the publishStatus badge.
   */
  async function runPublish(): Promise<void> {
    // Need a real id; can't publish a `new` sentinel. Phase
    // 3pt-review/B — Copilot discussion_r3284513397.
    //
    // `flush()` only drains existing `pendingPayload`; if the
    // publisher clicked Publish before any capture, no
    // `requestAutosave` has fired and the queue is empty.
    // Without the explicit requestSave below, the tourId would
    // stay `'new'` and publish would 404. Bumping the queue
    // with the current state (typically the empty
    // `{tourTasks: []}` seeded by `createEmptyState`)
    // guarantees the autosave loop mints the draft + the
    // empty file lands at the canonical R2 key before publish
    // round-trips.
    if (autosave.getTourId() === 'new') {
      autosave.requestSave({ tourTasks: state.tasks })
    }
    await autosave.flush()
    const id = autosave.getTourId()
    if (id === 'new') {
      // Flush didn't promote — autosave failed; surface that
      // instead of a misleading publish error.
      publishStatus = 'error'
      publishError = autosaveError || 'Could not create draft before publishing.'
      render()
      return
    }
    publishStatus = 'publishing'
    publishError = ''
    render()
    const result = await publishTour(id)
    if ('error' in result) {
      publishStatus = 'error'
      publishError = result.error
    } else {
      publishStatus = 'published'
      publishError = ''
    }
    render()
  }

  // Phase 3pt/E — re-opening an existing tour. Fetch the
  // persisted TourFile and seed state before the first render.
  if (tourId !== 'new') {
    void fetchTourJson(tourId).then(result => {
      if ('error' in result) {
        autosaveStatus = 'error'
        autosaveError = result.error
        render()
        return
      }
      const tasks = Array.isArray(result.tourFile?.tourTasks)
        ? result.tourFile.tourTasks
        : []
      state = { ...state, tasks }
      // Phase 3pt-review/C-D — seed every metadata field the
      // dock surfaces so the publisher can read + edit the
      // values currently persisted on the row.
      titleValue = result.tour?.title ?? ''
      descriptionValue = result.tour?.description ?? ''
      const v = result.tour?.visibility
      if (v === 'public' || v === 'federated' || v === 'restricted' || v === 'private') {
        visibilityValue = v
      }
      autosaveStatus = 'saved'
      render()
    })
  }

  /**
   * Phase 3pt-review/C-D — debounced metadata PUT. Title /
   * description / visibility all live in the D1 `tours` row
   * (the R2 TourFile carries only `tourTasks`), so we PUT them
   * together to /publish/tours/{id}. For a `'new'` tour we
   * first need the autosave manager to mint the row; we trigger
   * that via `requestSave` + `flush`, then PUT onto the
   * resolved id.
   *
   * Server-side `validateTitle` requires ≥3 chars after trim;
   * we mirror that here so the round-trip doesn't fire on
   * obviously-invalid input. Description + visibility have
   * looser rules (optional ≤8000-char string, fixed enum) so
   * the server's verdict is the source of truth — its message
   * lands in `metadataSaveError` on failure.
   */
  async function persistMetadata(): Promise<void> {
    const trimmedTitle = titleValue.trim()
    if (trimmedTitle.length < 3) {
      // Below the server's minimum — bail without a round-trip
      // and clear any prior error so the inputs don't look stuck.
      if (metadataSaveError) {
        metadataSaveError = ''
        render()
      }
      return
    }
    if (autosave.getTourId() === 'new') {
      autosave.requestSave({ tourTasks: state.tasks })
      await autosave.flush()
    }
    const id = autosave.getTourId()
    if (id === 'new') {
      // Autosave failed to mint a row — its status badge is
      // already showing the error; don't double-surface.
      return
    }
    const result = await updateTourMetadata(id, {
      title: trimmedTitle,
      description: descriptionValue,
      visibility: visibilityValue,
    })
    if ('error' in result) {
      metadataSaveError = result.error
      render()
      return
    }
    if (metadataSaveError) {
      metadataSaveError = ''
      render()
    }
  }

  function scheduleMetadataSave(): void {
    if (metadataSaveTimer !== null) clearTimeout(metadataSaveTimer)
    metadataSaveTimer = setTimeout(() => {
      metadataSaveTimer = null
      void persistMetadata()
    }, 800)
  }

  function render(): void {
    // Capture buttons grouped by intent — the simple stack at the
    // top (camera + dataset), the layout row (1/2/4 globes), the
    // environment toggles (day/night / clouds / stars / borders,
    // each with on+off), and the rotation-rate input. Phase 3pt/D
    // ships drag-to-reorder + click-to-edit on the task list; for
    // now the list is render-only.
    //
    // Phase 3pt-review/C-D — restore focus + selection on any
    // metadata field across re-renders, keyed by `data-dock-field`.
    // Without this, an autosave-status flip during typing would
    // yank focus mid-keystroke.
    const active = document.activeElement
    const focusedField =
      active instanceof HTMLElement ? active.dataset.dockField ?? null : null
    let cursorStart = 0
    let cursorEnd = 0
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      cursorStart = active.selectionStart ?? 0
      cursorEnd = active.selectionEnd ?? 0
    }
    root.innerHTML = `
      <div class="tour-authoring-dock-header">
        <span class="tour-authoring-dock-title">${escapeHtml(t('tour.dock.title'))}</span>
        <span class="tour-authoring-dock-status tour-authoring-dock-status-${autosaveStatus}"
              role="status"
              aria-live="polite"
              title="${escapeAttr(autosaveError || autosaveStatusLabel(autosaveStatus))}">${escapeHtml(autosaveStatusLabel(autosaveStatus))}</span>
        <button type="button" class="tour-authoring-dock-publish tour-authoring-dock-publish-${publishStatus}"
                data-action="publish"
                ${publishStatus === 'publishing' ? 'disabled' : ''}
                title="${escapeAttr(publishError || t('tour.dock.publish.aria'))}"
                aria-label="${escapeAttr(t('tour.dock.publish.aria'))}">${escapeHtml(publishButtonLabel(publishStatus))}</button>
        <button type="button" class="tour-authoring-dock-close"
                aria-label="${escapeAttr(t('tour.dock.discard.aria'))}">×</button>
      </div>
      <div class="tour-authoring-dock-metadata">
        <input type="text" class="tour-authoring-dock-title-input"
               data-dock-field="title"
               value="${escapeAttr(titleValue)}"
               maxlength="200"
               placeholder="${escapeAttr(t('tour.dock.titleInput.placeholder'))}"
               aria-label="${escapeAttr(t('tour.dock.titleInput.aria'))}">
        <textarea class="tour-authoring-dock-description"
                  data-dock-field="description"
                  rows="2"
                  maxlength="8000"
                  placeholder="${escapeAttr(t('tour.dock.description.placeholder'))}"
                  aria-label="${escapeAttr(t('tour.dock.description.aria'))}">${escapeHtml(descriptionValue)}</textarea>
        <label class="tour-authoring-dock-visibility-label">
          <span>${escapeHtml(t('tour.dock.visibility.label'))}</span>
          <select class="tour-authoring-dock-visibility"
                  data-dock-field="visibility"
                  aria-label="${escapeAttr(t('tour.dock.visibility.aria'))}">
            <option value="public" ${visibilityValue === 'public' ? 'selected' : ''}>${escapeHtml(t('tour.dock.visibility.public'))}</option>
            <option value="federated" ${visibilityValue === 'federated' ? 'selected' : ''}>${escapeHtml(t('tour.dock.visibility.federated'))}</option>
            <option value="restricted" ${visibilityValue === 'restricted' ? 'selected' : ''}>${escapeHtml(t('tour.dock.visibility.restricted'))}</option>
            <option value="private" ${visibilityValue === 'private' ? 'selected' : ''}>${escapeHtml(t('tour.dock.visibility.private'))}</option>
          </select>
        </label>
      </div>
      ${metadataSaveError
        ? `<div class="tour-authoring-dock-metadata-errormsg" role="alert">${escapeHtml(metadataSaveError)}</div>`
        : ''}
      ${publishStatus === 'error' && publishError
        ? `<div class="tour-authoring-dock-publish-errormsg" role="alert">${escapeHtml(publishError)}</div>`
        : ''}
      <div class="tour-authoring-dock-actions">
        <button type="button" class="tour-authoring-action" data-action="capture-camera">
          ${escapeHtml(t('tour.dock.action.captureCamera'))}
        </button>
        <button type="button" class="tour-authoring-action" data-action="capture-tilt">
          ${escapeHtml(t('tour.dock.action.captureTilt'))}
        </button>
        <button type="button" class="tour-authoring-action" data-action="capture-dataset">
          ${escapeHtml(t('tour.dock.action.captureDataset'))}
        </button>
        <div class="tour-authoring-dock-chiprow">
          <button type="button" class="tour-authoring-chip" data-action="capture-reset-zoom">${escapeHtml(t('tour.dock.action.resetZoom'))}</button>
          <button type="button" class="tour-authoring-chip" data-action="capture-reset-and-zoom">${escapeHtml(t('tour.dock.action.resetAndZoom'))}</button>
        </div>
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
        <label class="tour-authoring-dock-group-label" for="${inputIds.rotation}">${escapeHtml(t('tour.dock.group.rotation'))}</label>
        <div class="tour-authoring-dock-inputrow">
          <input id="${inputIds.rotation}" class="tour-authoring-input" type="number" step="0.1" min="-10" max="10"
                 data-dock-field="rotation"
                 value="${escapeAttr(rotationValue)}" aria-label="${escapeAttr(t('tour.dock.rotation.input.aria'))}">
          <button type="button" class="tour-authoring-chip" data-action="capture-rotation">${escapeHtml(t('tour.dock.rotation.add'))}</button>
        </div>
      </div>
      <div class="tour-authoring-dock-group">
        <label class="tour-authoring-dock-group-label" for="${inputIds.pause}">${escapeHtml(t('tour.dock.group.flow'))}</label>
        <div class="tour-authoring-dock-inputrow">
          <input id="${inputIds.pause}" class="tour-authoring-input" type="number" step="0.5" min="0" max="600"
                 data-dock-field="pause"
                 value="${escapeAttr(pauseValue)}" aria-label="${escapeAttr(t('tour.dock.pause.seconds.aria'))}">
          <button type="button" class="tour-authoring-chip" data-action="capture-pause-seconds">${escapeHtml(t('tour.dock.pause.seconds.add'))}</button>
        </div>
        <div class="tour-authoring-dock-chiprow">
          <button type="button" class="tour-authoring-chip" data-action="capture-pause-input">${escapeHtml(t('tour.dock.pause.input.add'))}</button>
          <button type="button" class="tour-authoring-chip" data-action="capture-loop">${escapeHtml(t('tour.dock.loop.add'))}</button>
          <button type="button" class="tour-authoring-chip" data-action="capture-unload-all">${escapeHtml(t('tour.dock.unloadAll.add'))}</button>
        </div>
        ${renderUnloadByHandleRow()}
      </div>
      <div class="tour-authoring-dock-group">
        <span class="tour-authoring-dock-group-label">${escapeHtml(t('tour.dock.group.player'))}</span>
        ${renderEnvRow('enableTourPlayer', 'tour.dock.player.enable')}
        ${renderEnvRow('tourPlayerWindow', 'tour.dock.player.window')}
      </div>
      <ol class="tour-authoring-task-list" aria-label="${escapeAttr(t('tour.dock.taskList.aria'))}">
        ${state.tasks.length === 0
          ? `<li class="tour-authoring-task-empty">${escapeHtml(t('tour.dock.taskList.empty'))}</li>`
          : state.tasks.map((task, i) => renderTaskRow(task, i)).join('')}
      </ol>
    `
    // Some implementations (happy-dom included) don't honour the
    // inline `selected` attribute on <option> elements built via
    // innerHTML, so set the select's value imperatively. Real
    // browsers handle either path; this is just belt-and-braces.
    const visSelect = root.querySelector<HTMLSelectElement>(
      '.tour-authoring-dock-visibility',
    )
    if (visSelect) visSelect.value = visibilityValue
    wireButtons()
    // Phase 3pt-review/C-D — restore focus + selection on the
    // previously-focused metadata field so a re-render during
    // typing doesn't yank the caret out from under the publisher.
    if (focusedField) {
      const restored = root.querySelector<HTMLElement>(
        `[data-dock-field="${focusedField}"]`,
      )
      if (restored) {
        restored.focus()
        if (
          restored instanceof HTMLInputElement ||
          restored instanceof HTMLTextAreaElement
        ) {
          restored.setSelectionRange(cursorStart, cursorEnd)
        }
      }
    }
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

  /** Phase 3pt/F — unload-by-handle dropdown. Only renders when
   *  at least one `loadDataset` task has been captured with a
   *  handle; an empty list would offer the user a no-op chip. */
  function renderUnloadByHandleRow(): string {
    const handles = collectDatasetHandles(state.tasks)
    if (handles.length === 0) return ''
    return `
      <div class="tour-authoring-dock-inputrow">
        <select class="tour-authoring-input" id="${inputIds.unloadHandle}"
                aria-label="${escapeAttr(t('tour.dock.unload.handle.aria'))}">
          ${handles.map(h => `<option value="${escapeAttr(h)}">${escapeHtml(h)}</option>`).join('')}
        </select>
        <button type="button" class="tour-authoring-chip" data-action="capture-unload-handle">${escapeHtml(t('tour.dock.unload.handle.add'))}</button>
      </div>
    `
  }

  /** Phase 3pt/D — render one task row with drag handle, label,
   *  edit/delete buttons, and (when expanded) the inline JSON
   *  editor. `draggable=true` on the `<li>` itself opts the row
   *  into HTML5 drag-and-drop; the dragover/drop handlers are
   *  delegated on the `<ol>` to keep the per-row markup terse. */
  function renderTaskRow(task: TourTaskDef, i: number): string {
    const isEditing = editingIndex === i
    // Restore the in-progress buffer when re-rendering the row
    // that's currently being edited, so a render fired by
    // autosave-status changes doesn't blow away unsaved typing.
    const json =
      isEditing && editorBuffer !== null
        ? editorBuffer
        : JSON.stringify(task, null, 2)
    return `<li class="tour-authoring-task${isEditing ? ' tour-authoring-task-editing' : ''}"
                draggable="true" data-task-index="${i}">
      <span class="tour-authoring-task-handle" aria-hidden="true">☰</span>
      <span class="tour-authoring-task-index">${i + 1}.</span>
      <span class="tour-authoring-task-label">${escapeHtml(describeTask(task))}</span>
      <button type="button" class="tour-authoring-task-btn" data-action="edit-task" data-index="${i}"
              aria-label="${escapeAttr(t('tour.dock.task.edit.aria', { n: i + 1 }))}">✎</button>
      <button type="button" class="tour-authoring-task-btn" data-action="delete-task" data-index="${i}"
              aria-label="${escapeAttr(t('tour.dock.task.delete.aria', { n: i + 1 }))}">×</button>
      ${isEditing
        ? `<div class="tour-authoring-task-editor">
            <textarea class="tour-authoring-task-editor-input"
                      aria-label="${escapeAttr(t('tour.dock.task.editor.aria', { n: i + 1 }))}"
                      data-index="${i}">${escapeHtml(json)}</textarea>
            <div class="tour-authoring-task-editor-actions">
              <span class="tour-authoring-task-editor-error" data-error-for="${i}"></span>
              <button type="button" class="tour-authoring-chip" data-action="cancel-edit">${escapeHtml(t('tour.dock.task.editor.cancel'))}</button>
              <button type="button" class="tour-authoring-chip" data-action="save-edit" data-index="${i}">${escapeHtml(t('tour.dock.task.editor.save'))}</button>
            </div>
          </div>`
        : ''}
    </li>`
  }

  function pushCaptured(task: TourTaskDef | null): void {
    if (!task) return
    state = appendTask(state, task)
    requestAutosave()
    render()
  }

  function wireButtons(): void {
    root.querySelector('.tour-authoring-dock-close')?.addEventListener('click', () => {
      callbacks.onDiscard()
    })
    root
      .querySelector<HTMLInputElement>('.tour-authoring-dock-title-input')
      ?.addEventListener('input', e => {
        titleValue = (e.target as HTMLInputElement).value
        scheduleMetadataSave()
      })
    root
      .querySelector<HTMLTextAreaElement>('.tour-authoring-dock-description')
      ?.addEventListener('input', e => {
        descriptionValue = (e.target as HTMLTextAreaElement).value
        scheduleMetadataSave()
      })
    root
      .querySelector<HTMLSelectElement>('.tour-authoring-dock-visibility')
      ?.addEventListener('change', e => {
        const v = (e.target as HTMLSelectElement).value
        if (v === 'public' || v === 'federated' || v === 'restricted' || v === 'private') {
          visibilityValue = v
          scheduleMetadataSave()
        }
      })
    root
      .querySelector<HTMLButtonElement>('[data-action="publish"]')
      ?.addEventListener('click', () => {
        void runPublish()
      })
    root
      .querySelector<HTMLButtonElement>('[data-action="capture-camera"]')
      ?.addEventListener('click', () => pushCaptured(captureCameraStep(callbacks)))
    root
      .querySelector<HTMLButtonElement>('[data-action="capture-dataset"]')
      ?.addEventListener('click', () =>
        pushCaptured(captureCurrentDataset(callbacks, state.tasks)),
      )
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
      .querySelector<HTMLInputElement>(`#${inputIds.rotation}`)
      ?.addEventListener('input', e => {
        rotationValue = (e.target as HTMLInputElement).value
      })
    root
      .querySelector<HTMLInputElement>(`#${inputIds.pause}`)
      ?.addEventListener('input', e => {
        pauseValue = (e.target as HTMLInputElement).value
      })
    root
      .querySelector<HTMLButtonElement>('[data-action="capture-rotation"]')
      ?.addEventListener('click', () => {
        const value = parseFloat(rotationValue)
        // Defensive — `<input type=number>` returns '' for blank.
        if (Number.isFinite(value)) pushCaptured({ setGlobeRotationRate: value })
      })
    root
      .querySelector<HTMLButtonElement>('[data-action="capture-pause-seconds"]')
      ?.addEventListener('click', () => {
        const value = parseFloat(pauseValue)
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

    // Phase 3pt/F — additional simple captures.
    root
      .querySelector<HTMLButtonElement>('[data-action="capture-tilt"]')
      ?.addEventListener('click', () => pushCaptured(captureTiltRotate(callbacks)))
    root
      .querySelector<HTMLButtonElement>('[data-action="capture-reset-zoom"]')
      ?.addEventListener('click', () => pushCaptured({ resetCameraZoomOut: '' }))
    root
      .querySelector<HTMLButtonElement>('[data-action="capture-reset-and-zoom"]')
      ?.addEventListener('click', () => pushCaptured({ resetCameraAndZoomOut: '' }))
    root
      .querySelector<HTMLButtonElement>('[data-action="capture-unload-handle"]')
      ?.addEventListener('click', () => {
        const select = root.querySelector<HTMLSelectElement>(
          `#${inputIds.unloadHandle}`,
        )
        if (!select || !select.value) return
        pushCaptured({ unloadDataset: select.value })
      })

    // Phase 3pt/D — task-row controls. Per-row click handlers for
    // edit / delete / save / cancel; delegated drag handlers on
    // the parent `<ol>` for reorder.
    root
      .querySelectorAll<HTMLButtonElement>('[data-action="delete-task"]')
      .forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.index ?? '', 10)
          if (Number.isInteger(idx)) {
            state = removeTaskAt(state, idx)
            if (editingIndex === idx) {
              editingIndex = -1
              editorBuffer = null
            } else if (editingIndex > idx) editingIndex -= 1
            requestAutosave()
            render()
          }
        })
      })
    root
      .querySelectorAll<HTMLButtonElement>('[data-action="edit-task"]')
      .forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.index ?? '', 10)
          if (!Number.isInteger(idx)) return
          // Toggle behaviour: clicking the same row's edit button
          // again collapses the editor. Single-row-at-a-time
          // expansion keeps the UI obvious.
          editingIndex = editingIndex === idx ? -1 : idx
          editorBuffer = null
          render()
        })
      })
    root
      .querySelector<HTMLButtonElement>('[data-action="cancel-edit"]')
      ?.addEventListener('click', () => {
        editingIndex = -1
        editorBuffer = null
        render()
      })
    root
      .querySelector<HTMLTextAreaElement>('.tour-authoring-task-editor-input')
      ?.addEventListener('input', e => {
        editorBuffer = (e.target as HTMLTextAreaElement).value
      })
    root
      .querySelector<HTMLButtonElement>('[data-action="save-edit"]')
      ?.addEventListener('click', () => {
        const idx = editingIndex
        if (idx < 0) return
        const textarea = root.querySelector<HTMLTextAreaElement>(
          `.tour-authoring-task-editor-input[data-index="${idx}"]`,
        )
        const errorEl = root.querySelector<HTMLElement>(`[data-error-for="${idx}"]`)
        if (!textarea || !errorEl) return
        const parsed = parseEditorJson(textarea.value)
        if (parsed.ok) {
          state = updateTaskAt(state, idx, parsed.task)
          editingIndex = -1
          editorBuffer = null
          requestAutosave()
          render()
        } else {
          // Inline error keeps the user in the editor with their
          // text intact — no popup, no nav. Same defensive shape
          // the dataset-form validators use.
          errorEl.textContent = parsed.error
          errorEl.classList.add('tour-authoring-task-editor-error-visible')
        }
      })

    const list = root.querySelector<HTMLOListElement>('.tour-authoring-task-list')
    if (list) {
      list.addEventListener('dragstart', e => {
        const li = (e.target as HTMLElement | null)?.closest<HTMLLIElement>('.tour-authoring-task')
        if (!li) return
        draggingIndex = parseInt(li.dataset.taskIndex ?? '', 10)
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move'
          // Older Safari requires SOMETHING to be set on the
          // DataTransfer for the drag to register at all. The
          // payload itself is ignored — we read `draggingIndex`
          // on drop, which is more reliable across browsers.
          e.dataTransfer.setData('text/plain', String(draggingIndex))
        }
        li.classList.add('tour-authoring-task-dragging')
      })
      list.addEventListener('dragover', e => {
        if (draggingIndex < 0) return
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      })
      list.addEventListener('drop', e => {
        const li = (e.target as HTMLElement | null)?.closest<HTMLLIElement>('.tour-authoring-task')
        if (!li || draggingIndex < 0) return
        e.preventDefault()
        const dropIndex = parseInt(li.dataset.taskIndex ?? '', 10)
        if (Number.isInteger(dropIndex) && dropIndex !== draggingIndex) {
          state = moveTask(state, draggingIndex, dropIndex)
          // Keep the editor following the moved task if it was
          // the one being edited; otherwise leave the user where
          // they were (defensive: clear if the index now points
          // at a different row).
          if (editingIndex === draggingIndex) {
            editingIndex = dropIndex
          } else if (editingIndex >= 0) {
            editingIndex = -1
            editorBuffer = null
          }
          requestAutosave()
        }
        draggingIndex = -1
        render()
      })
      list.addEventListener('dragend', () => {
        draggingIndex = -1
        root
          .querySelectorAll('.tour-authoring-task-dragging')
          .forEach(el => el.classList.remove('tour-authoring-task-dragging'))
      })
    }
  }

  render()
  return {
    dispose() {
      // Flush pending writes before tearing down — the host
      // typically calls dispose on Discard or navigation. We
      // fire-and-forget; a network failure here can't be
      // surfaced through the UI since we're tearing it down.
      if (metadataSaveTimer !== null) {
        clearTimeout(metadataSaveTimer)
        metadataSaveTimer = null
        void persistMetadata()
      }
      void autosave.flush()
      root.remove()
    },
  }
}

/** Phase 3pt/E — render the autosave status badge text. */
function autosaveStatusLabel(status: AutosaveStatus): string {
  switch (status) {
    case 'saving':
      return t('tour.dock.autosave.saving')
    case 'saved':
      return t('tour.dock.autosave.saved')
    case 'error':
      return t('tour.dock.autosave.error')
    case 'idle':
      return t('tour.dock.autosave.idle')
  }
}

/** Phase 3pt/G — render the publish-button label per status. */
function publishButtonLabel(
  status: 'idle' | 'publishing' | 'published' | 'error',
): string {
  switch (status) {
    case 'publishing':
      return t('tour.dock.publish.publishing')
    case 'published':
      return t('tour.dock.publish.published')
    case 'error':
      return t('tour.dock.publish.error')
    case 'idle':
      return t('tour.dock.publish.idle')
  }
}

/** Per-mount counter — every dock instance gets unique input ids.
 *  Constant ids would break `<label for="...">` association if
 *  multiple docks ever coexist (tests, hot-reload, a lifecycle
 *  bug). The singleton guard in `index.ts` shouldn't allow it,
 *  but defending here keeps the page predictable. Phase 3pt-
 *  review/A — Copilot discussion_r3284321812. */
let dockInstanceCounter = 0
function nextDockInputIds(): {
  rotation: string
  pause: string
  unloadHandle: string
} {
  const n = ++dockInstanceCounter
  return {
    rotation: `tour-authoring-rotation-input-${n}`,
    pause: `tour-authoring-pause-input-${n}`,
    unloadHandle: `tour-authoring-unload-handle-select-${n}`,
  }
}

/** Discriminating union of the env-toggle task keys the dock can
 *  emit. Phase 3pt/B; tour/C extends with more `envShow*` task
 *  shapes (alpha for clouds, etc.) and richer overlay captures. */
type EnvToggleKey =
  | 'envShowDayNightLighting'
  | 'envShowClouds'
  | 'envShowStars'
  | 'envShowWorldBorder'
  | 'envShowEarth'
  | 'enableTourPlayer'
  | 'tourPlayerWindow'

type EnvLabelKey =
  | 'env.dayNight'
  | 'env.clouds'
  | 'env.stars'
  | 'env.borders'
  | 'env.earth'
  | 'tour.dock.player.enable'
  | 'tour.dock.player.window'

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
    case 'enableTourPlayer':
      return { enableTourPlayer: value }
    case 'tourPlayerWindow':
      return { tourPlayerWindow: value }
  }
}

/**
 * Phase 3pt/F — capture the current tilt + bearing as a
 * `tiltRotateCamera` task. The map's `bearing` is the rotation
 * (around the Z axis, 0 = north up) and `pitch` is the tilt
 * (0 = top-down). Animated defaults true, matching how
 * captureCameraStep handles the flyTo case.
 */
function captureTiltRotate(callbacks: TourAuthoringCallbacks): TourTaskDef | null {
  const view = callbacks.getMapView()
  if (!view) {
    logger.warn('[tourAuthoring] capture-tilt: no view context available')
    return null
  }
  return {
    tiltRotateCamera: {
      tilt: roundTo(view.pitch, 1),
      rotate: roundTo(view.bearing, 1),
      animated: true,
    },
  }
}

/**
 * Phase 3pt/B — record a `loadDataset` task for the currently-
 * loaded primary-panel dataset. Returns null when no dataset is
 * loaded (typical at session start) so the button no-ops rather
 * than emitting a useless `{ id: '' }` task.
 *
 * Phase 3pt/F — auto-assigns a local `datasetID` handle so
 * subsequent `unloadDataset` captures have something to
 * reference. Handles count sequentially across the existing
 * captured tasks (e.g. `dataset1`, `dataset2`, ...) so the
 * publisher doesn't have to name them. The catalog `id` lives
 * in `params.id`; the local handle in `params.datasetID`.
 */
function captureCurrentDataset(
  callbacks: TourAuthoringCallbacks,
  existingTasks: TourTaskDef[],
): TourTaskDef | null {
  const dataset = callbacks.getCurrentDataset()
  if (!dataset) {
    logger.warn('[tourAuthoring] capture-dataset: no current dataset on the primary panel')
    return null
  }
  const handle = nextDatasetHandle(existingTasks)
  const params: LoadDatasetTaskParams = { id: dataset.id, datasetID: handle }
  return { loadDataset: params }
}

/** Generate the next sequential `dataset{N}` handle by scanning
 *  the captured tasks. Phase 3pt/F. */
function nextDatasetHandle(existingTasks: TourTaskDef[]): string {
  let highest = 0
  for (const task of existingTasks) {
    if ('loadDataset' in task) {
      const id = task.loadDataset.datasetID
      if (typeof id === 'string') {
        const match = /^dataset(\d+)$/.exec(id)
        if (match) {
          const n = parseInt(match[1], 10)
          if (n > highest) highest = n
        }
      }
    }
  }
  return `dataset${highest + 1}`
}

/** List the local-handle strings emitted by `loadDataset` tasks
 *  in the current state. Used by the unload-by-handle dropdown
 *  so the publisher only sees handles that actually exist. */
function collectDatasetHandles(tasks: TourTaskDef[]): string[] {
  const out: string[] = []
  for (const task of tasks) {
    if ('loadDataset' in task) {
      const id = task.loadDataset.datasetID
      if (typeof id === 'string' && id.length > 0 && !out.includes(id)) {
        out.push(id)
      }
    }
  }
  return out
}

/**
 * Phase 3pt/D — parse + validate text from the inline JSON
 * editor. Returns the parsed `TourTaskDef` on success, an
 * error string on failure.
 *
 * The shape check is intentionally minimal: a single-key
 * object with arbitrary key + value. We do NOT validate the
 * key against the known task-name allowlist here. Doing so
 * would couple the editor to `TourTaskDef`'s discriminated-
 * union surface, which churns as new task types land
 * (tour/F's added five new keys; future commits will add
 * more), and tourEngine.ts already logs + skips unknown task
 * keys at run-time with a clear warning. The trade-off: a
 * typo (e.g. `flytTo` instead of `flyTo`) round-trips through
 * the editor unflagged and shows up as a silent no-op when
 * the tour plays. Acceptable for v1; a future tour/?-letter
 * commit can add a per-key warning by importing the canonical
 * key list from a single source of truth once the task set
 * stabilises. Phase 3pt-review/A — Copilot
 * discussion_r3284321829.
 */
function parseEditorJson(
  text: string,
): { ok: true; task: TourTaskDef } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: t('tour.dock.task.editor.error.json', { detail: message }) }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: t('tour.dock.task.editor.error.shape') }
  }
  const keys = Object.keys(parsed)
  if (keys.length !== 1) {
    return { ok: false, error: t('tour.dock.task.editor.error.shape') }
  }
  // Trust that the single-key object is a TourTaskDef shape —
  // tourEngine will validate against its discriminated union at
  // run-time. Casting through `unknown` keeps the type system
  // honest about the trust boundary.
  return { ok: true, task: parsed as unknown as TourTaskDef }
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
  if ('unloadDataset' in task) {
    return t('tour.task.unload.handle', { handle: task.unloadDataset })
  }
  if ('tiltRotateCamera' in task) {
    const p = task.tiltRotateCamera
    return t('tour.task.tiltRotate.summary', { tilt: p.tilt, rotate: p.rotate })
  }
  if ('resetCameraZoomOut' in task) {
    return t('tour.task.resetZoom')
  }
  if ('resetCameraAndZoomOut' in task) {
    return t('tour.task.resetAndZoom')
  }
  if ('enableTourPlayer' in task) {
    return t('tour.task.player.enable', { state: task.enableTourPlayer })
  }
  if ('tourPlayerWindow' in task) {
    return t('tour.task.player.window', { state: task.tourPlayerWindow })
  }
  // Unknown task shape — fall back to the JSON key. Future
  // sub-phases extend this switch as more captures land.
  const key = Object.keys(task)[0]
  return key
}
