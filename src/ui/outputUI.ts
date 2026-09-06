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
  outputs(): OutputRecord[]
  addOutput(options: AddOutputOptions): Promise<OutputRecord>
  removeOutput(label: string): Promise<void>
  setOutputView(label: string, view: Partial<OutputViewSettings>): Promise<void>
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
 */
export function monitorKey(monitor: OutputMonitor): string {
  return `${monitor.name ?? ''}@${monitor.position.x},${monitor.position.y}`
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
  try {
    monitors = await mgr.listMonitors()
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
    buildAdder(mgr, monitors, records, body),
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

function buildAdder(
  mgr: OutputPanelManager,
  monitors: OutputMonitor[],
  records: OutputRecord[],
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
    const params = {
      name: monitorName(monitor, index),
      width: monitor.size.width,
      height: monitor.size.height,
    }
    const inUse = occupied.has(monitorKey(monitor))
    opt.textContent = t(
      inUse ? 'outputs.monitor.optionInUse' : 'outputs.monitor.option',
      params,
    )
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

  row.append(label, select, addBtn)
  section.appendChild(row)
  return section
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
    buildToggle(
      mgr,
      record,
      'trackCamera',
      t('outputs.item.trackCamera'),
      record.view.trackCamera,
    ),
  )
  item.appendChild(
    buildToggle(mgr, record, 'split', t('outputs.item.split'), record.view.split),
  )
  return item
}

/**
 * One per-output view toggle.
 *
 * Deliberately does **not** refresh the panel on change. `setOutputView`
 * pushes the new view to that output immediately and mutates the record
 * in place, so the checkbox already agrees with the manager; a refresh
 * would spend a monitor enumeration on every click. On failure the box
 * is put back, because a control that reports a state the output is not
 * in is worse than one that visibly refuses.
 */
function buildToggle(
  mgr: OutputPanelManager,
  record: OutputRecord,
  key: keyof OutputViewSettings,
  labelText: string,
  initial: boolean,
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
    void mgr
      .setOutputView(record.label, { [key]: next })
      .catch(err => {
        logger.warn('[outputUI] view change failed:', err)
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
