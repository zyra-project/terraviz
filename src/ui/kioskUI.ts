// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The exhibit kiosk's screen (docs/SECOND_LIFE_COMPAT.md §7 item 9): what
 * the globe beside it shows, to read. One fixed 2048×1024 stage, the size
 * of the media face it is drawn on in Second Life, scaled to fit any
 * other window, because a later step maps touches on the face to places
 * on it.
 *
 * Display only. Nothing here is a control: in Second Life the page never
 * learns who is looking at it, so a click could not be held to the
 * globe's hold and talk rules, and touches go to a script instead.
 *
 * The labels go through the i18n layer, so each visitor's copy reads in
 * the language of their own browser; the dataset's own text comes from
 * the node as written. The date is the one line that changes while a
 * dataset stays the same, so it has its own setter, which touches the DOM
 * only when the words change.
 */
import { t } from '../i18n'
import { formatNumber } from '../i18n/format'
import type { KioskDataset, KioskWhen } from '../output/kioskModel'
import { DEFAULT_DISPLAY } from '../services/colorScaleDisplay'
import { renderColorbar } from './colorbarUI'

/** The stage, in CSS pixels: Second Life's largest media face, 2:1. */
export const KIOSK_STAGE = { width: 2048, height: 1024 } as const

/** The abstract's type size, largest first: it shrinks to fit the
 *  column, and below the smallest it is cut with a fade instead. */
export const ABSTRACT_FONT_PX = { max: 34, min: 22 } as const

export type KioskView =
  | { kind: 'earth' }
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'dataset'; dataset: KioskDataset }

export interface KioskScreen {
  /** Show what the globe shows. */
  show(view: KioskView): void
  /** The date line, as the clock ticks. */
  setWhen(when: KioskWhen): void
  /** Re-fit the stage to the window. */
  fit(): void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  return node
}

/** What the globe is doing, beside its date. */
export function whenState(when: KioskWhen): string {
  switch (when.state) {
    case 'playing':
      return when.rate === 1
        ? t('kiosk.when.playing')
        : t('kiosk.when.playingAt', { rate: formatNumber(when.rate, { maximumFractionDigits: 3 }) })
    case 'paused':
      return t('kiosk.when.paused')
    case 'live':
      return t('kiosk.when.live')
    default:
      return ''
  }
}

/**
 * The largest size from `max` down to `min` at which `node` holds its
 * text without overflowing, by halving the range; `min` when none does.
 * `overflows` is asked at each size tried, so a test can answer without
 * a layout engine.
 */
export function fitFontPx(min: number, max: number, overflows: (px: number) => boolean): number {
  if (!overflows(max)) return max
  let lo = min, hi = max
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (overflows(mid)) hi = mid
    else lo = mid
  }
  return lo
}

export function mountKiosk(root: HTMLElement): KioskScreen {
  const stage = el('div', 'kiosk-stage')
  stage.style.width = `${KIOSK_STAGE.width}px`
  stage.style.height = `${KIOSK_STAGE.height}px`

  const head = el('header', 'kiosk-head')
  const eyebrow = el('p', 'kiosk-eyebrow')
  const brand = el('p', 'kiosk-brand')
  brand.textContent = 'Terraviz' // i18n-exempt: product name, as the app's own title writes it
  head.append(eyebrow, brand)

  const main = el('main', 'kiosk-main')
  const title = el('h1', 'kiosk-title')
  const when = el('p', 'kiosk-when')
  const date = el('span', 'kiosk-date')
  const state = el('span', 'kiosk-state')
  when.append(date, state)
  const abstract = el('div', 'kiosk-abstract')
  main.append(title, when, abstract)

  const side = el('aside', 'kiosk-side')
  const thumb = el('img', 'kiosk-thumb')
  thumb.alt = ''
  thumb.decoding = 'async'
  const legend = el('figure', 'kiosk-legend')
  const credit = el('p', 'kiosk-credit')
  const license = el('p', 'kiosk-license')
  side.append(thumb, legend, credit, license)

  const body = el('div', 'kiosk-body')
  body.append(main, side)
  stage.append(head, body)
  root.replaceChildren(stage)

  let shownWhen = ''

  // Scaled to the window and centred in it. In Second Life the window is
  // the stage's own size, so the scale is 1 and nothing moves.
  const fit = (): void => {
    const raw = Math.min(window.innerWidth / KIOSK_STAGE.width, window.innerHeight / KIOSK_STAGE.height)
    const scale = raw > 0 && Number.isFinite(raw) ? raw : 1
    const x = Math.max(0, (window.innerWidth - KIOSK_STAGE.width * scale) / 2)
    const y = Math.max(0, (window.innerHeight - KIOSK_STAGE.height * scale) / 2)
    stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
  }

  const fitAbstract = (): void => {
    abstract.classList.remove('kiosk-abstract-cut')
    const px = fitFontPx(ABSTRACT_FONT_PX.min, ABSTRACT_FONT_PX.max, (size) => {
      abstract.style.fontSize = `${size}px`
      return abstract.scrollHeight > abstract.clientHeight + 1
    })
    abstract.style.fontSize = `${px}px`
    if (abstract.scrollHeight > abstract.clientHeight + 1) abstract.classList.add('kiosk-abstract-cut')
  }

  const labelled = (node: HTMLElement, label: string, value: string): void => {
    node.replaceChildren()
    node.hidden = value === ''
    if (value === '') return
    const name = el('span', 'kiosk-label')
    name.textContent = label
    node.append(name, document.createTextNode(value))
  }

  const setImage = (node: HTMLImageElement, url: string | null): void => {
    node.hidden = url === null
    if (url === null) node.removeAttribute('src')
    else if (node.getAttribute('src') !== url) node.src = url
  }

  const setLegend = (ds: KioskDataset | null): void => {
    legend.replaceChildren()
    legend.hidden = !ds?.legend
    if (!ds?.legend) return
    const caption = el('figcaption', 'kiosk-label')
    caption.textContent = t('kiosk.legend')
    legend.append(caption)
    if (ds.legend.kind === 'image') {
      const img = el('img', 'kiosk-legend-image')
      img.alt = t('kiosk.legendAlt', { title: ds.title })
      img.decoding = 'async'
      img.src = ds.legend.url
      legend.append(img)
    } else {
      legend.append(renderColorbar({ scale: ds.legend.scale, display: DEFAULT_DISPLAY, title: ds.title }))
    }
  }

  const show = (view: KioskView): void => {
    eyebrow.textContent = t('kiosk.nowShowing')
    stage.dataset.view = view.kind
    shownWhen = ''
    date.textContent = ''
    state.textContent = ''
    const ds = view.kind === 'dataset' ? view.dataset : null
    if (view.kind === 'earth') {
      title.textContent = t('kiosk.earth.title')
      abstract.textContent = t('kiosk.earth.about')
      labelled(credit, t('kiosk.credit'), t('kiosk.earth.credit'))
    } else if (view.kind === 'loading') {
      title.textContent = t('kiosk.loading')
      abstract.textContent = ''
      labelled(credit, '', '')
    } else if (view.kind === 'unavailable') {
      title.textContent = t('kiosk.unavailable.title')
      abstract.textContent = t('kiosk.unavailable.body')
      labelled(credit, '', '')
    } else if (ds) {
      title.textContent = ds.title
      abstract.textContent = ds.abstract
      labelled(credit, t('kiosk.credit'), ds.credit)
    }
    labelled(license, t('kiosk.license'), ds ? [ds.license, ds.licenseText].filter(Boolean).join(' · ') : '')
    setImage(thumb, ds?.thumbnail ?? null)
    setLegend(ds)
    fitAbstract()
  }

  const setWhen = (next: KioskWhen): void => {
    const words = `${next.text}\u0000${whenState(next)}`
    if (words === shownWhen) return
    shownWhen = words
    date.textContent = next.text
    state.textContent = whenState(next)
    state.hidden = state.textContent === ''
    // Hidden by visibility, not removed: the row keeps its height, so the
    // abstract fitted below it doesn't move when a date arrives.
    when.style.visibility = next.text === '' ? 'hidden' : ''
  }

  fit()
  return { show, setWhen, fit }
}
