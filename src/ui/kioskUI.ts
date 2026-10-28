// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The exhibit kiosk's screen (docs/SECOND_LIFE_COMPAT.md §7 item 9): what
 * the globe beside it shows, to read.
 *
 * Two layouts, chosen by the window (`kioskLayout`). In a window at least
 * the size of Second Life's largest media face, 2048×1024, which is the
 * face the kiosk script asks for, it is one fixed stage of that size, laid
 * out in pixels and scaled to fit, because a later step maps touches on
 * the face to places on it. In anything smaller, which is an ordinary
 * browser, it is a page that reflows in rems: a stage scaled to the window
 * cancels browser zoom, so its text could never be made larger, and on a
 * phone it was a few pixels high.
 *
 * Display only. Nothing here is a control: in Second Life the page never
 * learns who is looking at it, so a click could not be held to the
 * globe's hold and talk rules, and touches go to a script instead.
 *
 * The labels go through the i18n layer. The dataset's own text comes from
 * the node as written, usually English, so each piece of it is isolated
 * and takes its own direction (`dir="auto"`, `<bdi>`): under a
 * right-to-left page an English title would otherwise move its closing
 * full stop to the front. The date is the one line that changes while a
 * dataset stays the same, so it has its own setter, which touches the DOM
 * only when the words change.
 */
import { t } from '../i18n'
import type { KioskDataset, KioskWhen } from '../output/kioskModel'
import { DEFAULT_DISPLAY } from '../services/colorScaleDisplay'
import { renderColorbar } from './colorbarUI'

/** The stage, in CSS pixels: Second Life's largest media face, 2:1. */
export const KIOSK_STAGE = { width: 2048, height: 1024 } as const

/** The abstract's type size on the stage, largest first: it shrinks to
 *  fit the column, and below the smallest it is cut with a fade. */
export const ABSTRACT_FONT_PX = { max: 34, min: 26 } as const

/** The date's type size on the stage: it shrinks to stay on one line. */
export const DATE_FONT_PX = { max: 50, min: 30 } as const

export type KioskView =
  | { kind: 'earth' }
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'notFound' }
  | { kind: 'dataset'; dataset: KioskDataset }

export type KioskLayout = 'stage' | 'page'

export interface KioskScreen {
  /** Show what the globe shows. */
  show(view: KioskView): void
  /** The date line, as the clock ticks. */
  setWhen(when: KioskWhen): void
  /** Fit the screen to the window. */
  fit(): void
}

/** The stage for a window the size of the media face or larger; a page
 *  that reflows for anything smaller. */
export function kioskLayout(width: number, height: number): KioskLayout {
  return width >= KIOSK_STAGE.width && height >= KIOSK_STAGE.height ? 'stage' : 'page'
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  return node
}

/** What the globe is doing, beside its date. Whether it is sped up or
 *  slowed down, not by how much: the clip's own speed is arbitrary, so a
 *  number reads as a multiple of real time, which it isn't. */
export function whenState(when: KioskWhen): string {
  switch (when.state) {
    case 'playing':
      if (when.rate > 1) return t('kiosk.when.playingFaster')
      if (when.rate < 1) return t('kiosk.when.playingSlower')
      return t('kiosk.when.playing')
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

  const head = el('header', 'kiosk-head')
  const eyebrow = el('p', 'kiosk-eyebrow')
  const brand = el('p', 'kiosk-brand')
  brand.textContent = 'Terraviz' // i18n-exempt: product name, as the app's own title writes it
  head.append(eyebrow, brand)

  const main = el('main', 'kiosk-main')
  const title = el('h1', 'kiosk-title')
  title.dir = 'auto'
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

  let layout: KioskLayout | null = null
  let shownWhen = ''
  let dateLength = -1
  let whenHeight = -1

  const fitAbstract = (): void => {
    abstract.classList.remove('kiosk-abstract-cut')
    if (layout !== 'stage') {
      abstract.style.fontSize = ''
      return
    }
    const px = fitFontPx(ABSTRACT_FONT_PX.min, ABSTRACT_FONT_PX.max, (size) => {
      abstract.style.fontSize = `${size}px`
      return abstract.scrollHeight > abstract.clientHeight + 1
    })
    abstract.style.fontSize = `${px}px`
    if (abstract.scrollHeight > abstract.clientHeight + 1) abstract.classList.add('kiosk-abstract-cut')
    whenHeight = when.offsetHeight
  }

  // On the stage the date stays on one line, a span included, smaller if
  // it must be; the abstract below is fitted again whenever the row's
  // height moves anyway (a long badge wrapping under the date), since a
  // fit made for a shorter row leaves the abstract cut mid-line.
  const fitDate = (): void => {
    if (layout !== 'stage') {
      date.style.fontSize = ''
      return
    }
    date.style.fontSize = `${fitFontPx(DATE_FONT_PX.min, DATE_FONT_PX.max, (size) => {
      date.style.fontSize = `${size}px`
      return date.scrollWidth > when.clientWidth + 1
    })}px`
  }

  const fit = (): void => {
    const next = kioskLayout(window.innerWidth, window.innerHeight)
    if (next !== layout) {
      layout = next
      stage.dataset.layout = next
      document.body.classList.toggle('kiosk-scroll', next === 'page')
      fitDate()
      fitAbstract()
    }
    if (layout === 'page') {
      stage.style.transform = ''
      return
    }
    // Scaled up to the window and centred in it. In Second Life the
    // window is the stage's own size, so the scale is 1 and nothing moves.
    const scale = Math.min(window.innerWidth / KIOSK_STAGE.width, window.innerHeight / KIOSK_STAGE.height)
    const x = (window.innerWidth - KIOSK_STAGE.width * scale) / 2
    const y = (window.innerHeight - KIOSK_STAGE.height * scale) / 2
    stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
  }

  const labelled = (node: HTMLElement, label: string, value: string): void => {
    node.replaceChildren()
    node.hidden = value === ''
    if (value === '') return
    const name = el('span', 'kiosk-label')
    name.textContent = label
    const words = document.createElement('bdi')
    words.textContent = value
    node.append(name, words)
  }

  const paragraphs = (lines: string[]): void => {
    abstract.replaceChildren(...lines.map((line) => {
      const p = el('p', 'kiosk-paragraph')
      p.dir = 'auto'
      p.textContent = line
      return p
    }))
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
    dateLength = -1
    date.textContent = ''
    state.textContent = ''
    const ds = view.kind === 'dataset' ? view.dataset : null
    if (view.kind === 'earth') {
      title.textContent = t('kiosk.earth.title')
      paragraphs([t('kiosk.earth.about')])
      labelled(credit, t('kiosk.credit'), t('kiosk.earth.credit'))
    } else if (view.kind === 'loading') {
      title.textContent = t('kiosk.loading')
      paragraphs([])
      labelled(credit, '', '')
    } else if (view.kind === 'unavailable') {
      title.textContent = t('kiosk.unavailable.title')
      paragraphs([t('kiosk.unavailable.body')])
      labelled(credit, '', '')
    } else if (view.kind === 'notFound') {
      title.textContent = t('kiosk.notFound.title')
      paragraphs([t('kiosk.notFound.body')])
      labelled(credit, '', '')
    } else if (ds) {
      title.textContent = ds.title
      paragraphs(ds.abstract)
      labelled(credit, t('kiosk.credit'), ds.credit)
    }
    labelled(license, t('kiosk.license'), ds ? [ds.license, ds.licenseText].filter(Boolean).join(' · ') : '')
    setImage(thumb, ds?.thumbnail ?? null)
    setLegend(ds)
    document.title = ds ? t('kiosk.pageTitleDataset', { title: ds.title }) : t('kiosk.pageTitle')
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
    // Digits are of one width, so only a change of length can change the
    // date's; a date is fitted again then, not on every tick.
    if (next.text.length !== dateLength) {
      dateLength = next.text.length
      fitDate()
    }
    if (layout === 'stage' && when.offsetHeight !== whenHeight) fitAbstract()
  }

  fit()
  return { show, setWhen, fit }
}
