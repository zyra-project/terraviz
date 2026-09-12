// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The Outputs panel (Tools → Outputs) — `docs/MULTI_MONITOR_PLAN.md`
 * §"Delivery plan" rungs 9-10, and the first part of the multi-monitor
 * feature an operator can see.
 *
 * Rungs 1-8 built a manager that can spawn output windows, a protocol
 * to talk to them, and a publish seam feeding it live globe state — with
 * nothing anywhere able to call `addOutput`. This is that caller. The
 * plan's boot flow step 2 is this panel: enumerate monitors, present a
 * picker, spawn on the chosen one.
 *
 * **Every import from `services/multiOutput/` is type-only, and must
 * stay that way.** `main.ts` imports this module eagerly, so a runtime
 * import here would pull `manager` + `stateAggregator` + `protocol` back
 * into the web entry chunk — undoing commit `c8df3380`, which moved them
 * out. The manager arrives at runtime through `OutputPanelSource`
 * instead, which is also what lets a test drive this file without Tauri.
 *
 * **`start()` is called on the first add, not when the panel opens.** It
 * opens the IPC listener and the 1 Hz heartbeat, and until the operator
 * commits to an output there is nothing on that link to hear. It is
 * awaited *before* the spawn because the output announces `output_ready`
 * over that same link as soon as it boots — starting afterwards would
 * race the window and lose the announcement, leaving an output that
 * renders nothing and a manager that never marks it ready.
 *
 * Nothing calls `stop()` when the last output goes: an output whose
 * `close()` rejected is still out there, and cutting the heartbeat would
 * strand it on its last frame with no way back. `dispose()` already
 * tears the link down through the boot handle.
 *
 * **The "Restore outputs on launch" opt-in (rung 10) is off by default,
 * and that is a decision rather than caution.** An operator who added an
 * output once, on a laptop they later took home, should not have a
 * window try to open on a projector that is not there. It is also what
 * keeps the plan's "an install that never enabled outputs pays nothing"
 * true one step further out: with it off, boot enumerates no monitor and
 * opens no IPC link. The panel only reads and writes the flag — the
 * restore itself, and the decision not to run one, belong to the manager
 * so there is a single reader of it.
 */

import { t } from '../i18n'
import { logger } from '../utils/logger'
import type {
  AddOutputOptions,
  OutputMonitor,
  OutputRecord,
} from '../services/multiOutput/manager'
import type { OutputRenderConfig } from '../services/multiOutput/protocol'
import type { OutputViewSettings } from '../services/multiOutput/stateAggregator'

/**
 * What the panel drives.
 *
 * A structural subset rather than `MultiOutputManager` itself: a class
 * with private fields is typed **nominally** in TypeScript, so a fake
 * could not satisfy that type without being a real instance — which
 * needs a host, which needs Tauri. Naming the seven methods the panel
 * actually calls keeps the test fake small and states the surface this
 * file depends on, which is the part that must not grow quietly.
 */
export interface OutputPanelManager {
  start(): Promise<void>
  listMonitors(): Promise<OutputMonitor[]>
  /** Which of those the platform calls primary, or `null` when it will
   *  not say. Asked rather than inferred — see `MultiOutputHost`. */
  primaryMonitor(): Promise<OutputMonitor | null>
  outputs(): OutputRecord[]
  addOutput(options: AddOutputOptions): Promise<OutputRecord>
  removeOutput(label: string): Promise<void>
  setOutputView(label: string, view: Partial<OutputViewSettings>): Promise<void>
  setOutputRenderConfig(label: string, render: Partial<OutputRenderConfig>): Promise<void>
  /** Windows that can hold a video decoder, against the machine's
   *  budget — see `buildDecoderBudget`. */
  decoderLoad(): { used: number; budget: number }
  /** Pin the budget, or `null` to go back to what the machine reports. */
  setDecoderBudget(budget: number | null): void
  /**
   * The framebuffer rungs this build offers.
   *
   * Read through the manager rather than imported from `protocol.ts`,
   * and that is not a preference: every `multiOutput/` import in this
   * module is type-only because `main.ts` imports the panel eagerly,
   * so a runtime one puts the IPC contract — `sos-equirect` and all —
   * into the web entry graph, which is the regression `c8df3380`
   * removed and the grep in that commit polices. The manager is
   * already the panel's only window onto the subsystem; asking it what
   * it supports fits that exactly.
   */
  framebufferWidths(): readonly number[]
  isRestoreOnLaunch(): boolean
  setRestoreOnLaunch(enabled: boolean): void
}

export interface OutputPanelSource {
  /**
   * The manager, or `null` when the host could not be built.
   *
   * A promise because the boot handle resolves one: `createTauriHost()`
   * awaits dynamic imports, and on a fast open the panel can arrive
   * first. `null` is a real answer here, not an error — a desktop launch
   * whose host failed should say so in the panel rather than offer
   * controls that cannot work.
   */
  manager(): Promise<OutputPanelManager | null>
}

/**
 * Identity of a monitor, for "does this display already have an output".
 *
 * Name **and** signed origin, which is the rule §3 "Persistence" states
 * for rung 10's restore matching — kept identical here so the two cannot
 * disagree about what "the same monitor" means. A name alone is not an
 * identity: Windows display names are positional and reassignable, so
 * two machines can both report `\\.\DISPLAY1` for different panels.
 *
 * Exported for the test, and for rung 10 to reuse rather than re-derive.
 *
 * **`outputHealth.monitorKeyOf` is the same function, deliberately
 * duplicated** — read its docstring before "fixing" this. The panel
 * needs this at runtime and every `multiOutput/` import here is
 * type-only, so sharing one definition would put the IPC contract into
 * the web entry chunk. Change both or neither.
 */
export function monitorKey(monitor: OutputMonitor): string {
  return `${monitor.name ?? ''}@${monitor.position.x},${monitor.position.y}`
}

/** One monitor's place in the arrangement, as fractions of the whole. */
export interface MonitorLayoutBox {
  /** Index into the array passed in, so a box can be tied back to the
   *  option that selects it. */
  index: number
  /** Left and top edges, 0..1 of the arrangement's bounding box. */
  x: number
  y: number
  /** Extent, 0..1 of the same box. */
  width: number
  height: number
}

export interface MonitorLayout {
  boxes: MonitorLayoutBox[]
  /** Width over height of the whole arrangement, for the container. */
  aspect: number
}

/**
 * The monitor arrangement, normalised for drawing (rung 9 step 5).
 *
 * An operator adding an output is answering a question about *physical
 * space* — which of these displays is the projector — and a list of
 * names cannot answer it. `\\.\DISPLAY1` and `\\.\DISPLAY2` say nothing
 * about which is on the left, and the resolution only helps when the
 * panels differ. The diagram is the part that does, and it is why an
 * output landing on the wrong display is something to notice before
 * clicking Add rather than after a fullscreen window covers the screen
 * the operator was reading.
 *
 * Pure and exported so the arithmetic is tested without a DOM, the same
 * reason `monitorKey` is. Fractions rather than pixels because the
 * element it fills has a size only the browser knows; the caller sets
 * percentages and one aspect ratio, and CSS does the scaling.
 *
 * Signed origins are the whole difficulty and are handled by
 * subtracting the minimum: the hardware spike behind this feature found
 * a primary-left arrangement whose secondary sat at `x = -1680`, and a
 * layout that assumed a non-negative origin would have drawn it off the
 * left edge of its own container.
 *
 * Returns `null` rather than an empty layout when there is nothing to
 * draw — no monitors, or an arrangement with no extent. A diagram of
 * nothing is a broken-looking box, and the panel simply omits it.
 */
export function monitorLayout(monitors: readonly OutputMonitor[]): MonitorLayout | null {
  const drawable = monitors
    .map((monitor, index) => ({ monitor, index }))
    // A monitor the platform describes with a zero, negative or
    // non-finite extent cannot be drawn, and one bad entry must not
    // cost the diagram: it is dropped and the rest are still placed,
    // the same per-entry tolerance rung 10's persistence parse uses.
    .filter(
      ({ monitor }) =>
        monitor.size.width > 0 &&
        monitor.size.height > 0 &&
        Number.isFinite(monitor.size.width) &&
        Number.isFinite(monitor.size.height) &&
        Number.isFinite(monitor.position.x) &&
        Number.isFinite(monitor.position.y),
    )
  if (drawable.length === 0) return null

  const left = Math.min(...drawable.map(d => d.monitor.position.x))
  const top = Math.min(...drawable.map(d => d.monitor.position.y))
  const right = Math.max(...drawable.map(d => d.monitor.position.x + d.monitor.size.width))
  const bottom = Math.max(...drawable.map(d => d.monitor.position.y + d.monitor.size.height))
  const spanX = right - left
  const spanY = bottom - top
  if (!(spanX > 0) || !(spanY > 0)) return null

  return {
    aspect: spanX / spanY,
    boxes: drawable.map(({ monitor, index }) => ({
      index,
      x: (monitor.position.x - left) / spanX,
      y: (monitor.position.y - top) / spanY,
      width: monitor.size.width / spanX,
      height: monitor.size.height / spanY,
    })),
  }
}

/** A monitor's display name, falling back to its 1-based position in the
 *  enumeration — `availableMonitors()` reports `name: null` often enough
 *  on Linux that an unnamed row would otherwise be unpickable. */
function monitorName(monitor: OutputMonitor, index: number): string {
  return monitor.name ?? t('outputs.monitor.unnamed', { index: index + 1 })
}

/**
 * The name to show for an output's monitor.
 *
 * Resolved against the **current enumeration** rather than from the
 * record alone, so a row reads with the same string the picker offered
 * — the operator chose "Display 2", so the row has to say "Display 2".
 *
 * The record cannot answer this by itself: `availableMonitors()` reports
 * `name: null` often enough on Linux that the fallback carries the
 * enumeration index, and a record holds no index. Passing a constant
 * there (this was `0`) labels *every* unnamed display "Display 1", which
 * makes two outputs indistinguishable and gives their Remove buttons the
 * same accessible name.
 *
 * A monitor absent from the enumeration has been unplugged since the
 * output was spawned. Its index is gone, so the signed origin stands in:
 * unique, and true whether or not anything is plugged into it. Naming
 * that state properly is rung 13's health badges.
 */
function monitorRowName(
  monitor: OutputMonitor,
  monitors: readonly OutputMonitor[],
): string {
  const index = monitors.findIndex(m => monitorKey(m) === monitorKey(monitor))
  if (index >= 0) return monitorName(monitors[index], index)
  return (
    monitor.name ??
    t('outputs.monitor.unnamedAt', { x: monitor.position.x, y: monitor.position.y })
  )
}

let source: OutputPanelSource | null = null
let root: HTMLElement | null = null
let lastTrigger: HTMLElement | null = null
/**
 * Guards against an older refresh finishing last.
 *
 * Both awaits in `refresh` — the manager and the monitor enumeration —
 * are IPC round trips, so an add followed by a quick remove can leave
 * two in flight. Without the token the slower one repaints the list it
 * read before the change, and the panel shows an output that is gone.
 */
let refreshToken = 0

/** Wire the panel to its manager. Called once at boot; opening the panel
 *  before this happens renders the unavailable state rather than
 *  throwing. */
export function initOutputUI(src: OutputPanelSource): void {
  source = src
}

/** Test hook: forget the source and tear down any open panel. */
export function resetOutputUIForTests(): void {
  closeOutputUI()
  source = null
  refreshToken = 0
}

export function openOutputUI(triggeredBy?: HTMLElement | null): HTMLElement {
  closeOutputUI()
  lastTrigger = triggeredBy ?? null

  root = document.createElement('div')
  root.className = 'output-panel'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'false')
  root.setAttribute('aria-label', t('outputs.title'))

  const header = document.createElement('div')
  header.className = 'output-header'
  const heading = document.createElement('h2')
  heading.textContent = t('outputs.title')
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'output-close'
  close.setAttribute('aria-label', t('outputs.close'))
  close.textContent = '×' // i18n-exempt: a glyph, not a word
  close.addEventListener('click', () => closeOutputUI())
  header.append(heading, close)
  root.appendChild(header)

  const intro = document.createElement('p')
  intro.className = 'output-intro'
  intro.textContent = t('outputs.intro')
  root.appendChild(intro)

  const body = document.createElement('div')
  body.className = 'output-body'
  // The shell mounts synchronously so Escape, focus restore and the
  // close button all work while the monitor enumeration is still in
  // flight — an operator who opens this by mistake should not have to
  // wait for an IPC round trip to get out of it.
  body.textContent = t('outputs.loading')
  root.appendChild(body)

  document.body.appendChild(root)
  document.addEventListener('keydown', onEscape, true)
  void refresh(body)
  return root
}

export function closeOutputUI(): void {
  if (!root) return
  root.remove()
  root = null
  document.removeEventListener('keydown', onEscape, true)
  // Bump so a refresh still in flight cannot paint into the detached
  // body — harmless to the DOM, but it would also clear the error a
  // reopen is about to show.
  refreshToken++
  lastTrigger?.focus()
  lastTrigger = null
}

function onEscape(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') {
    ev.stopPropagation()
    closeOutputUI()
  }
}

async function refresh(body: HTMLElement): Promise<void> {
  const token = ++refreshToken
  const mgr = await source?.manager().catch(() => null)
  if (token !== refreshToken) return

  if (!mgr) {
    replace(body, message(t('outputs.unavailable'), 'output-note'))
    return
  }

  let monitors: OutputMonitor[]
  let primary: OutputMonitor | null
  try {
    // Together, because they are two round trips to the same subsystem
    // and the panel is already waiting. The primary is settled
    // separately though: a platform that will not answer it costs a
    // marker, while one that cannot enumerate at all costs the panel,
    // so a rejection here must not take the enumeration down with it.
    ;[monitors, primary] = await Promise.all([
      mgr.listMonitors(),
      mgr.primaryMonitor().catch(err => {
        logger.warn('[outputUI] could not identify the primary monitor:', err)
        return null
      }),
    ])
  } catch (err) {
    logger.warn('[outputUI] could not enumerate monitors:', err)
    if (token === refreshToken) {
      replace(body, message(t('outputs.monitors.empty'), 'output-note'))
    }
    return
  }
  if (token !== refreshToken) return

  const records = mgr.outputs()
  replace(
    body,
    buildAdder(mgr, monitors, records, primary, body),
    buildList(mgr, records, monitors, body),
    buildLaunchSection(mgr),
  )
}

/**
 * The "Restore outputs on launch" opt-in (rung 10).
 *
 * Off by default and deliberately so: an operator who added an output
 * once, on a laptop they later took home, should not have a window try
 * to open on a projector that is not there. It is also what keeps the
 * plan's "an install that never enabled outputs pays nothing" true —
 * with this off, boot enumerates no monitor and opens no IPC link.
 *
 * Writes straight through rather than on a Save button: there is one
 * setting, and its effect is a launch away.
 */
function buildLaunchSection(mgr: OutputPanelManager): HTMLElement {
  const section = document.createElement('section')
  section.className = 'output-section'

  const label = document.createElement('label')
  label.className = 'output-toggle'

  const box = document.createElement('input')
  box.type = 'checkbox'
  box.className = 'output-toggle-box'
  box.id = 'output-restore-launch'
  box.checked = mgr.isRestoreOnLaunch()
  box.addEventListener('change', () => {
    mgr.setRestoreOnLaunch(box.checked)
  })

  const text = document.createElement('span')
  text.className = 'output-toggle-label'
  text.textContent = t('outputs.restoreOnLaunch')

  label.append(box, text)
  section.append(label, message(t('outputs.restoreOnLaunch.hint'), 'output-note'))
  return section
}

/**
 * One display's line in the picker.
 *
 * Four keys rather than one template plus composed fragments, because
 * composition is where the punctuation and the word order stop being
 * translatable: "(primary, already in use)" is one phrase in English
 * and two clauses joined differently elsewhere. Each state is a
 * sentence a translator can read whole.
 *
 * The primary marker lives **here**, in text, rather than only in the
 * diagram: that is what makes it survive a screen reader, a colour
 * vision deficiency and a monochrome projector preview, and the
 * diagram's accent is reinforcement rather than the statement.
 */
function monitorOptionLabel(
  monitor: OutputMonitor,
  index: number,
  state: { primary: boolean; inUse: boolean },
): string {
  const params = {
    name: monitorName(monitor, index),
    width: monitor.size.width,
    height: monitor.size.height,
  }
  if (state.primary && state.inUse) return t('outputs.monitor.optionPrimaryInUse', params)
  if (state.primary) return t('outputs.monitor.optionPrimary', params)
  if (state.inUse) return t('outputs.monitor.optionInUse', params)
  return t('outputs.monitor.option', params)
}

/**
 * The position diagram (rung 9 step 5).
 *
 * A scale picture of the displays as the platform reports them, with
 * the primary accented, the ones that already have an output dimmed,
 * and the currently picked one highlighted. It answers the question a
 * list of names cannot — *which* of these is the projector — and it is
 * live: changing the picker moves the highlight, so the operator
 * confirms the choice against the desk before a fullscreen window
 * appears somewhere they were not expecting.
 *
 * **Presentational, deliberately.** Every fact it draws is already in
 * the option text the select carries, so it is `aria-hidden` rather
 * than a second reading of the same choice — and it is not a second
 * *control*, which would be worse: two tab stops writing one value,
 * one of them a grid of unlabelled rectangles.
 *
 * Returns `null` when there is nothing to draw. An empty framed box
 * reads as a failure; an absent diagram reads as a machine with one
 * display, which is what it is.
 */
function buildMonitorMap(
  monitors: readonly OutputMonitor[],
  occupied: ReadonlySet<string>,
  primaryKey: string | null,
  select: HTMLSelectElement,
): HTMLElement | null {
  const layout = monitorLayout(monitors)
  if (!layout) return null

  const map = document.createElement('div')
  map.className = 'output-monitor-map'
  map.setAttribute('aria-hidden', 'true')
  // The one number the stylesheet cannot derive. Everything else about
  // the sizing — how tall the diagram may get, and the width that keeps
  // the ratio under that cap — stays in CSS, where it can be said in
  // rem against the panel's own scale.
  map.style.setProperty('--output-map-aspect', String(layout.aspect))

  const boxes = layout.boxes.map(box => {
    const monitor = monitors[box.index]
    const el = document.createElement('div')
    el.className = 'output-monitor-box'
    el.dataset.index = String(box.index)
    // Physical `left` / `top` / `width` / `height`, set here rather
    // than in the stylesheet, and that is the point rather than an
    // oversight: this is a picture of a desk. A display on the
    // operator's left is on the left in every locale, so the diagram is
    // the one part of this panel that must **not** flip under
    // `dir="rtl"` — which is exactly what the logical properties the
    // rest of the app uses would do to it.
    el.style.left = `${box.x * 100}%`
    el.style.top = `${box.y * 100}%`
    el.style.width = `${box.width * 100}%`
    el.style.height = `${box.height * 100}%`

    const isPrimary = primaryKey !== null && monitorKey(monitor) === primaryKey
    if (isPrimary) el.classList.add('is-primary')
    if (occupied.has(monitorKey(monitor))) el.classList.add('is-occupied')
    // The same sentence the option carries, for a hover. The element is
    // `aria-hidden`, so this is for a pointer rather than for AT, which
    // reads the option itself.
    el.title = monitorOptionLabel(monitor, box.index, {
      primary: isPrimary,
      inUse: occupied.has(monitorKey(monitor)),
    })

    const size = document.createElement('span')
    size.className = 'output-monitor-box-size'
    size.textContent = t('outputs.monitor.mapSize', {
      width: monitor.size.width,
      height: monitor.size.height,
    })
    el.appendChild(size)
    map.appendChild(el)
    return el
  })

  const markSelected = (): void => {
    for (const el of boxes) {
      el.classList.toggle('is-selected', el.dataset.index === select.value)
    }
  }
  markSelected()
  select.addEventListener('change', markSelected)
  return map
}

function buildAdder(
  mgr: OutputPanelManager,
  monitors: OutputMonitor[],
  records: OutputRecord[],
  primary: OutputMonitor | null,
  body: HTMLElement,
): HTMLElement {
  const section = document.createElement('section')
  section.className = 'output-section'
  const title = document.createElement('h3')
  title.className = 'output-section-title'
  title.textContent = t('outputs.monitors.title')
  section.appendChild(title)

  if (monitors.length === 0) {
    section.appendChild(message(t('outputs.monitors.empty'), 'output-note'))
    return section
  }

  // An output opens fullscreen and undecorated. On a single-monitor
  // machine that means it covers the window the operator is reading
  // this in — recoverable (the window is still Alt-Tabbable) but worth
  // saying before the click rather than after.
  if (monitors.length === 1) {
    section.appendChild(message(t('outputs.singleMonitor'), 'output-warning'))
  }

  const occupied = new Set(records.map(r => monitorKey(r.monitor)))
  // Joined on the same identity the restore matching uses, rather than
  // on the array index: `primaryMonitor()` is a second call and nothing
  // guarantees the platform enumerates in a stable order between the
  // two.
  const primaryKey = primary ? monitorKey(primary) : null

  const row = document.createElement('div')
  row.className = 'output-add-row'

  const label = document.createElement('label')
  label.className = 'output-add-label'
  label.htmlFor = 'output-monitor-select'
  label.textContent = t('outputs.monitors.label')

  const select = document.createElement('select')
  select.id = 'output-monitor-select'
  select.className = 'output-monitor-select'
  monitors.forEach((monitor, index) => {
    const opt = document.createElement('option')
    opt.value = String(index)
    const inUse = occupied.has(monitorKey(monitor))
    opt.textContent = monitorOptionLabel(monitor, index, {
      primary: primaryKey !== null && monitorKey(monitor) === primaryKey,
      inUse,
    })
    // Two fullscreen windows on one monitor means one of them is
    // invisible, and the operator has no way to tell which. The manager
    // does not refuse this — `addOutput` takes any index — so the guard
    // has to be here, where the choice is made.
    opt.disabled = inUse
    select.appendChild(opt)
  })

  const firstFree = monitors.findIndex(m => !occupied.has(monitorKey(m)))
  const addBtn = document.createElement('button')
  addBtn.type = 'button'
  addBtn.className = 'output-add-btn'
  addBtn.textContent = t('outputs.add')
  // Every display already has an output; there is nothing left to pick,
  // and a select whose every option is disabled has no valid value to
  // submit.
  if (firstFree === -1) {
    select.disabled = true
    addBtn.disabled = true
  } else {
    select.value = String(firstFree)
  }

  addBtn.addEventListener('click', () => {
    void add(mgr, Number(select.value), addBtn, section, body)
  })

  // Before the row, not after: the diagram is what the choice is made
  // *from*, and the select is where it is recorded.
  const map = buildMonitorMap(monitors, occupied, primaryKey, select)
  if (map) section.appendChild(map)

  row.append(label, select, addBtn)
  section.appendChild(row)

  const { used, budget } = mgr.decoderLoad()
  // The manager refuses this too, and would throw. Disabling here is
  // the affordance rather than the invariant: an operator should see
  // that the machine is full and what to do about it, not click and be
  // told.
  if (used >= budget) {
    addBtn.disabled = true
    section.appendChild(message(t('outputs.decoders.spent'), 'output-warning'))
  }
  section.appendChild(buildDecoderBudget(mgr, body, used, budget))
  return section
}

/**
 * The machine's decoder budget (rung 11c, plan §"Cross-window decoder
 * budget").
 *
 * It sits under Add rather than on an output because it is a property
 * of the **machine**, not of any window: one GPU and one media stack
 * are shared by everything on the box, and the whole reason the field
 * exists is that `maxVideoPanels()` answers per window and so cannot
 * see the others.
 *
 * The count is windows that can hold a decoder, not decoders currently
 * decoding — outputs mirror the primary, so every one of them flips
 * from free to costing a decoder the moment a video is loaded, and a
 * dataset load is not a place a refusal can happen. Counting windows
 * puts the refusal on Add, where there is a control to disable.
 *
 * Repainting the whole panel on change is right here, unlike the
 * per-output toggles: this number gates the Add button and the warning
 * above it, so the section's own state is what changed.
 */
function buildDecoderBudget(
  mgr: OutputPanelManager,
  body: HTMLElement,
  used: number,
  budget: number,
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'output-section'

  const field = document.createElement('label')
  field.className = 'output-field'

  const label = document.createElement('span')
  label.className = 'output-field-label'
  label.textContent = t('outputs.decoders.label')

  const input = document.createElement('input')
  input.type = 'number'
  input.className = 'output-field-number'
  input.min = '1'
  input.value = String(budget)

  input.addEventListener('change', () => {
    const next = Number(input.value)
    // Anything unusable clears the pin rather than storing it, and the
    // manager answers with what the machine reports — so an operator
    // who empties the box gets the default back instead of a broken
    // installation. `setDecoderBudget` applies the same rule; asking
    // for `null` here is what makes "empty means unset" explicit.
    mgr.setDecoderBudget(Number.isFinite(next) && next >= 1 ? next : null)
    // Repaint: this number gates the Add button and the warning above
    // it, so the section it lives in is what changed. Unlike the
    // per-output toggles, which change only themselves and would spend
    // a monitor enumeration per click for nothing.
    void refresh(body)
  })

  field.append(label, input)
  wrap.append(
    field,
    message(t('outputs.decoders.used', { used, budget }), 'output-note'),
    message(t('outputs.decoders.hint'), 'output-note'),
  )
  return wrap
}

async function add(
  mgr: OutputPanelManager,
  monitorIndex: number,
  addBtn: HTMLButtonElement,
  section: HTMLElement,
  body: HTMLElement,
): Promise<void> {
  section.querySelector('.output-error')?.remove()
  addBtn.disabled = true
  const restore = addBtn.textContent
  addBtn.textContent = t('outputs.adding')
  try {
    // Awaited before the spawn: the output emits `output_ready` over
    // this link the moment it boots, so a listener installed afterwards
    // would race the window it was installed for. Idempotent, so paying
    // it on every add costs nothing after the first.
    await mgr.start()
    await mgr.addOutput({ monitorIndex })
  } catch (err) {
    logger.warn('[outputUI] add output failed:', err)
    addBtn.textContent = restore
    addBtn.disabled = false
    section.appendChild(
      message(t('outputs.addFailed', { message: describe(err) }), 'output-error'),
    )
    return
  }
  // Full refresh rather than appending a row: the new output makes its
  // monitor unpickable, so the picker above has to be rebuilt too.
  await refresh(body)
}

function buildList(
  mgr: OutputPanelManager,
  records: OutputRecord[],
  monitors: readonly OutputMonitor[],
  body: HTMLElement,
): HTMLElement {
  const section = document.createElement('section')
  section.className = 'output-section'
  const title = document.createElement('h3')
  title.className = 'output-section-title'
  title.textContent = t('outputs.list.title')
  section.appendChild(title)

  if (records.length === 0) {
    section.appendChild(message(t('outputs.list.empty'), 'output-note'))
    return section
  }

  const list = document.createElement('ul')
  list.className = 'output-list'
  for (const record of records) {
    list.appendChild(buildRow(mgr, record, monitors, body))
  }
  section.appendChild(list)
  return section
}

function buildRow(
  mgr: OutputPanelManager,
  record: OutputRecord,
  monitors: readonly OutputMonitor[],
  body: HTMLElement,
): HTMLElement {
  const item = document.createElement('li')
  item.className = 'output-item'
  item.dataset.label = record.label

  const head = document.createElement('div')
  head.className = 'output-item-head'

  const name = document.createElement('span')
  name.className = 'output-item-name'
  // The monitor's own name, not the window label: `output-1` is the IPC
  // address and means nothing to an operator standing at a rack asking
  // which projector this is.
  const displayName = monitorRowName(record.monitor, monitors)
  name.textContent = displayName

  const meta = document.createElement('span')
  meta.className = 'output-item-meta'
  meta.textContent = t('outputs.item.meta', {
    width: record.monitor.size.width,
    height: record.monitor.size.height,
    mode: t('outputs.mode.sosEquirect'),
  })

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'output-item-remove'
  remove.textContent = t('outputs.item.remove')
  remove.setAttribute(
    'aria-label',
    t('outputs.item.removeAria', { monitor: displayName }),
  )
  remove.addEventListener('click', () => {
    void removeOutput(mgr, record.label, remove, body)
  })

  head.append(name, meta, remove)
  item.appendChild(head)

  item.appendChild(
    buildToggle(t('outputs.item.trackCamera'), record.view.trackCamera, next =>
      mgr.setOutputView(record.label, { trackCamera: next }),
    ),
  )
  item.appendChild(
    buildToggle(t('outputs.item.split'), record.view.split, next =>
      mgr.setOutputView(record.label, { split: next }),
    ),
  )
  item.appendChild(
    // A different channel from the two above — window configuration
    // rather than a projection of globe state — but the same control,
    // because to the operator it is the same kind of switch. The label
    // says the HUD is drawn *on the output* rather than here, since
    // that is the part someone about to run a show needs to know.
    buildToggle(t('outputs.item.debugOverlay'), record.render.debugOverlay, next =>
      mgr.setOutputRenderConfig(record.label, { debugOverlay: next }),
    ),
  )
  item.appendChild(buildFramebufferPicker(mgr, record))
  return item
}

/**
 * The per-output framebuffer picker (rung 11b).
 *
 * **This is not the monitor's resolution**, and the panel says so by
 * placement: the head line above already carries the display's own
 * pixel count, so "3840×2160 · SOS equirectangular" over
 * "Framebuffer: 4096×2048" makes the distinction without a sentence
 * explaining it. Calling the control "Resolution" would erase exactly
 * the difference the plan's "the frame and the monitor are two
 * rectangles" section exists to keep — an output is fullscreen on its
 * monitor whatever this says, and a rung below the monitor's own count
 * scales *up* rather than shrinking into a corner.
 *
 * The whole ladder is offered rather than only the rungs at or below
 * the monitor: 1024 is the "preview an LED sphere on a desk monitor"
 * workflow and 8192 is a sphere fed by a 1080p preview window, so
 * filtering by the monitor would remove the two cases the picker is
 * most for.
 */
function buildFramebufferPicker(
  mgr: OutputPanelManager,
  record: OutputRecord,
): HTMLElement {
  const label = document.createElement('label')
  label.className = 'output-field'

  const text = document.createElement('span')
  text.className = 'output-field-label'
  text.textContent = t('outputs.item.framebuffer')

  const select = document.createElement('select')
  select.className = 'output-field-select'
  for (const width of mgr.framebufferWidths()) {
    const option = document.createElement('option')
    option.value = String(width)
    // Half, always: an equirectangular frame that is not 2:1 is not
    // equirectangular, so the height is shown rather than chosen.
    option.textContent = t('outputs.item.framebufferOption', {
      width,
      height: width / 2,
    })
    select.appendChild(option)
  }
  // Assigning and reading back is how the DOM answers "is this one of
  // my options": an unmatched value leaves `select.value` empty. That
  // should be unreachable — the parse only accepts a rung and this
  // control only offers them — but a blank select reads as a broken
  // panel, so a width from somewhere else is *shown* rather than
  // rounded to a neighbour the output is not running at.
  select.value = String(record.render.framebufferWidth)
  if (!select.value) {
    const own = document.createElement('option')
    own.value = String(record.render.framebufferWidth)
    own.textContent = t('outputs.item.framebufferOption', {
      width: record.render.framebufferWidth,
      height: record.render.framebufferWidth / 2,
    })
    select.prepend(own)
    select.value = own.value
  }

  let applied = select.value
  select.addEventListener('change', () => {
    const next = select.value
    select.disabled = true
    void mgr
      .setOutputRenderConfig(record.label, { framebufferWidth: Number(next) })
      .then(() => {
        applied = next
      })
      .catch(err => {
        // Same posture as the toggles: a control that reports a state
        // the output is not in is worse than one that visibly refuses.
        logger.warn('[outputUI] framebuffer change failed:', err)
        select.value = applied
      })
      .finally(() => {
        select.disabled = false
      })
  })

  label.append(text, select)
  return label
}

/**
 * One per-output checkbox.
 *
 * Takes the commit as a callback rather than a settings key, because
 * the three switches on a row now write through two different manager
 * methods onto two different channels — and the part worth having once
 * is not the field name, it is everything below: disable while in
 * flight, put the box back on failure, and do not refresh.
 *
 * Deliberately does **not** refresh the panel on change. The manager
 * pushes the new value to that output immediately and mutates the
 * record in place, so the checkbox already agrees with it; a refresh
 * would spend a monitor enumeration on every click. On failure the box
 * is put back, because a control that reports a state the output is not
 * in is worse than one that visibly refuses.
 */
function buildToggle(
  labelText: string,
  initial: boolean,
  commit: (next: boolean) => Promise<void>,
): HTMLElement {
  const label = document.createElement('label')
  label.className = 'output-toggle'

  const box = document.createElement('input')
  box.type = 'checkbox'
  box.className = 'output-toggle-box'
  box.checked = initial
  box.addEventListener('change', () => {
    const next = box.checked
    box.disabled = true
    void commit(next)
      .catch(err => {
        logger.warn('[outputUI] setting change failed:', err)
        box.checked = !next
      })
      .finally(() => {
        box.disabled = false
      })
  })

  const text = document.createElement('span')
  text.className = 'output-toggle-label'
  text.textContent = labelText

  label.append(box, text)
  return label
}

async function removeOutput(
  mgr: OutputPanelManager,
  label: string,
  btn: HTMLButtonElement,
  body: HTMLElement,
): Promise<void> {
  btn.disabled = true
  try {
    await mgr.removeOutput(label)
  } catch (err) {
    // `removeOutput` absorbs a rejecting `close()` and drops the record
    // anyway, so this is close to unreachable — but a manager that did
    // throw must not leave a dead button behind.
    logger.warn('[outputUI] remove output failed:', err)
    btn.disabled = false
    return
  }
  await refresh(body)
}

function message(text: string, className: string): HTMLElement {
  const el = document.createElement('p')
  el.className = className
  el.textContent = text
  return el
}

function replace(host: HTMLElement, ...children: HTMLElement[]): void {
  host.replaceChildren(...children)
}

/** The message from a thrown value, for the inline add error. Falls back
 *  to the localized generic rather than `String(err)`, which for a
 *  non-Error reads as `[object Object]`. */
function describe(err: unknown): string {
  return err instanceof Error && err.message ? err.message : t('outputs.addFailed.generic')
}
