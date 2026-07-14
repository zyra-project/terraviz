/**
 * /publish/featured-hero — set the "Right now" hero override (Phase C
 * of `docs/HERO_ADMIN_SCOPING.md`).
 *
 * Privileged-only (staff / admin / service). The page fetches the
 * caller's role (`/api/v1/publish/me`), the catalog datasets for the
 * picker (`/api/v1/publish/datasets`), and the current pin
 * (`/api/v1/featured-hero`), then renders a form: dataset picker,
 * mandatory activation window, optional headline, a live preview of
 * the real hero card, and Set / Clear buttons wired to
 * `PUT` / `DELETE /api/v1/publish/featured-hero`.
 *
 * Non-privileged callers get a restricted card (the API also enforces
 * 403, but gating here avoids a fill-then-reject round-trip).
 *
 * The preview reuses the live hero-panel stylesheet so the curator
 * sees exactly what ships. The portal boots its own CSS bundle
 * (`publisher.css`), so the hero styles are imported here explicitly.
 */

import { fetchFeatures, renderFeatureDisabledCard } from '../features'
import { t } from '../../../i18n'
import { publisherGet, publisherSend, handleSessionError } from '../api'
import { buildErrorCard } from '../components/error-card'
import { dateTimeToIso } from '../components/dataset-form'
import '../../../styles/hero-panel.css'

/** Keep in sync with `HERO_HEADLINE_MAX_LEN` in the backend store
 *  (`functions/api/v1/_lib/hero-override-store.ts`). The API is the
 *  hard cap; this just stops the input early. */
const HERO_HEADLINE_MAX_LEN = 120

interface MeResponse {
  role: string
  is_admin: boolean
}
interface DatasetsResponse {
  datasets: Array<{ id: string; title: string; thumbnail_url?: string | null }>
}
interface HeroResponse {
  hero: { datasetId: string; window: { start: string; end: string }; headline?: string } | null
}

const ME_ENDPOINT = '/api/v1/publish/me'
// Published only — pinning a draft/retracted dataset would never resolve
// in the public catalog's dataset list, so the override would silently
// fall through to auto-derive. Restrict the picker to what can actually
// surface as a hero.
const DATASETS_ENDPOINT = '/api/v1/publish/datasets?limit=500&status=published'
const HERO_PUBLIC_ENDPOINT = '/api/v1/featured-hero'
const HERO_WRITE_ENDPOINT = '/api/v1/publish/featured-hero'

export interface FeaturedHeroPageOptions {
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
}

function clientIsPrivileged(me: MeResponse): boolean {
  return me.is_admin === true || me.role === 'admin' || me.role === 'service'
}

/** Split an ISO timestamp into the local-time `YYYY-MM-DD` value an
 *  `<input type="date">` wants. Inverse of dataset-form's
 *  {@link dateTimeToIso} (which composes the local date + time inputs
 *  back into a UTC ISO string). Returns '' when unparseable. */
function isoToDateLocal(iso: string | undefined): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local-time `HH:MM` for an `<input type="time">`. */
function isoToTimeLocal(iso: string | undefined): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  children: (HTMLElement | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  Object.assign(node, props)
  for (const c of children) node.append(c)
  return node
}

export async function renderFeaturedHeroPage(
  mount: HTMLElement,
  options: FeaturedHeroPageOptions = {},
): Promise<void> {
  if (!(await fetchFeatures()).hero) {
    renderFeatureDisabledCard(mount, 'hero')
    return
  }
  const fetchFn = options.fetchFn
  mount.replaceChildren(shell(el('p', { className: 'publisher-loading', textContent: t('publisher.hero.loading') })))

  const [meRes, datasetsRes, heroRes] = await Promise.all([
    publisherGet<MeResponse>(ME_ENDPOINT, { fetchFn }),
    publisherGet<DatasetsResponse>(DATASETS_ENDPOINT, { fetchFn }),
    publisherGet<HeroResponse>(HERO_PUBLIC_ENDPOINT, { fetchFn }),
  ])

  // Any of the three fetches failing is a page-level error — render
  // the error card rather than a partially-functional form (an empty
  // picker or a wrongly-cleared "no current pin" would mislead the
  // curator). `me` first so an auth gap surfaces the sign-in path.
  for (const res of [meRes, datasetsRes, heroRes]) {
    if (res.ok) continue
    if (res.kind === 'session') {
      if (handleSessionError({ navigate: options.navigate }) === 'navigating') return
      mount.replaceChildren(shell(buildErrorCard('session')))
      return
    }
    // Preserve the real failure kind (network vs server vs not_found)
    // and disclose status/body for server errors so operators can
    // diagnose, rather than collapsing everything to a generic
    // "server error".
    const details = res.kind === 'server' ? { status: res.status, body: res.body } : {}
    mount.replaceChildren(shell(buildErrorCard(res.kind, details)))
    return
  }
  // After the guard above, all three are ok — narrow the types.
  if (!meRes.ok || !datasetsRes.ok || !heroRes.ok) return

  if (!clientIsPrivileged(meRes.data)) {
    mount.replaceChildren(
      shell(
        card(
          heading(t('publisher.hero.title')),
          el('p', { className: 'publisher-hero-restricted', textContent: t('publisher.hero.restricted') }),
        ),
      ),
    )
    return
  }

  renderForm(mount, {
    datasets: datasetsRes.data.datasets,
    currentHero: heroRes.data.hero,
    fetchFn,
    navigate: options.navigate,
  })
}

/** Wrap page content in the portal's `<main class="publisher-shell">`
 *  landmark, matching the other portal pages (see index.ts). */
function shell(...children: HTMLElement[]): HTMLElement {
  const m = el('main', { className: 'publisher-shell' })
  for (const c of children) m.append(c)
  return m
}

interface FormState {
  datasets: DatasetsResponse['datasets']
  currentHero: HeroResponse['hero']
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
}

function renderForm(mount: HTMLElement, state: FormState): void {
  const { datasets, currentHero } = state

  // ----- Controls -----
  const select = el('select', { className: 'publisher-hero-select', id: 'hero-dataset' })
  select.append(el('option', { value: '', textContent: t('publisher.hero.pickDataset') }))
  for (const d of datasets) {
    select.append(el('option', { value: d.id, textContent: d.title }))
  }
  if (currentHero) select.value = currentHero.datasetId

  // Separate date + time inputs (not `datetime-local`) to match the
  // portal convention — some browsers hide the time scrubber on
  // datetime-local (see dataset-form.ts). Default span: now → +7 days,
  // so the curator only narrows it.
  const now = new Date()
  const week = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  const startSeed = currentHero ? currentHero.window.start : now.toISOString()
  const endSeed = currentHero ? currentHero.window.end : week.toISOString()
  const dateLabel = t('publisher.datasetForm.datetime.date')
  const timeLabel = t('publisher.datasetForm.datetime.time')
  const mkDate = (id: string, iso: string, aria: string) =>
    el('input', { type: 'date', className: 'publisher-hero-input', id, value: isoToDateLocal(iso), ariaLabel: aria })
  const mkTime = (id: string, iso: string, aria: string) =>
    el('input', { type: 'time', className: 'publisher-hero-input', id, value: isoToTimeLocal(iso), ariaLabel: aria })
  const startDate = mkDate('hero-start-date', startSeed, `${t('publisher.hero.windowStart')} ${dateLabel}`)
  const startTime = mkTime('hero-start-time', startSeed, `${t('publisher.hero.windowStart')} ${timeLabel}`)
  const endDate = mkDate('hero-end-date', endSeed, `${t('publisher.hero.windowEnd')} ${dateLabel}`)
  const endTime = mkTime('hero-end-time', endSeed, `${t('publisher.hero.windowEnd')} ${timeLabel}`)

  const headlineInput = el('input', {
    type: 'text',
    className: 'publisher-hero-input',
    id: 'hero-headline',
    maxLength: HERO_HEADLINE_MAX_LEN,
    value: currentHero?.headline ?? '',
  })

  const status = el('div', { className: 'publisher-hero-status', role: 'status' })
  const preview = el('div', { className: 'publisher-hero-preview hero-panel' })

  const titleFor = (id: string): string => datasets.find(d => d.id === id)?.title ?? ''
  const thumbFor = (id: string): string | null => datasets.find(d => d.id === id)?.thumbnail_url ?? null

  const updatePreview = (): void => {
    const id = select.value
    if (!id) {
      preview.replaceChildren()
      preview.classList.add('hidden')
      return
    }
    preview.classList.remove('hidden')
    const display = headlineInput.value.trim() || titleFor(id)
    const inner = el('div', { className: 'hero-panel-inner' })
    const cardBtn = el('div', { className: 'hero-panel-card' })
    const thumb = thumbFor(id)
    if (thumb) {
      const img = el('img', { className: 'hero-panel-thumb', src: thumb, alt: '' })
      cardBtn.append(img)
    }
    const text = el('span', { className: 'hero-panel-text' }, [
      el('span', { className: 'hero-panel-eyebrow', textContent: t('browse.hero.heading') }),
      el('span', { className: 'hero-panel-title', textContent: display }),
      el('span', { className: 'hero-panel-badge', textContent: t('browse.hero.label') }),
    ])
    cardBtn.append(text)
    inner.append(cardBtn)
    preview.replaceChildren(inner)
  }
  select.addEventListener('change', updatePreview)
  headlineInput.addEventListener('input', updatePreview)
  updatePreview()

  // ----- Buttons -----
  const setBtn = el('button', { type: 'button', className: 'publisher-button publisher-button-primary', textContent: t('publisher.hero.set') })
  const clearBtn = el('button', { type: 'button', className: 'publisher-button', textContent: t('publisher.hero.clear') })
  // Track whether a pin actually exists server-side, updated only on
  // a confirmed Set/Clear. Clear is enabled iff there's a real pin —
  // not derived from the (locally-mutable) select value, which would
  // wrongly enable Clear after a failed Set or a fresh selection.
  let hasPin = !!currentHero
  clearBtn.disabled = !hasPin

  const setBusy = (busy: boolean): void => {
    setBtn.disabled = busy
    clearBtn.disabled = busy || !hasPin
  }

  setBtn.addEventListener('click', () => {
    const datasetId = select.value
    const startIso = dateTimeToIso(startDate.value, startTime.value)
    const endIso = dateTimeToIso(endDate.value, endTime.value)
    status.textContent = ''
    status.classList.remove('publisher-hero-status-error')
    if (!datasetId) {
      showError(status, t('publisher.hero.error.noDataset'))
      return
    }
    if (!startIso || !endIso || Date.parse(startIso) >= Date.parse(endIso)) {
      showError(status, t('publisher.hero.error.window'))
      return
    }
    const headline = headlineInput.value.trim()
    setBusy(true)
    void publisherSend<HeroResponse>(
      HERO_WRITE_ENDPOINT,
      { dataset_id: datasetId, window: { start: startIso, end: endIso }, ...(headline ? { headline } : {}) },
      { method: 'PUT', fetchFn: state.fetchFn },
    ).then(res => {
      if (res.ok) {
        hasPin = true
        setBusy(false)
        showSuccess(status, t('publisher.hero.saved'))
        return
      }
      setBusy(false)
      handleWriteError(res, status, state.navigate)
    })
  })

  clearBtn.addEventListener('click', () => {
    status.textContent = ''
    setBusy(true)
    void publisherSend<unknown>(HERO_WRITE_ENDPOINT, null, { method: 'DELETE', fetchFn: state.fetchFn }).then(res => {
      if (res.ok || (!res.ok && res.kind === 'not_found')) {
        hasPin = false
        setBusy(false)
        showSuccess(status, t('publisher.hero.cleared'))
        select.value = ''
        headlineInput.value = ''
        updatePreview()
        return
      }
      setBusy(false)
      handleWriteError(res, status, state.navigate)
    })
  })

  // ----- Layout -----
  const form = card(
    heading(t('publisher.hero.title')),
    el('p', { className: 'publisher-hero-intro', textContent: t('publisher.hero.intro') }),
    labelled(t('publisher.hero.dataset'), select),
    labelled(t('publisher.hero.windowStart'), dateTimeRow(startDate, startTime)),
    labelled(t('publisher.hero.windowEnd'), dateTimeRow(endDate, endTime)),
    labelled(t('publisher.hero.headline'), headlineInput),
    el('div', { className: 'publisher-hero-preview-wrap' }, [
      el('span', { className: 'publisher-field-label', textContent: t('publisher.hero.preview') }),
      preview,
    ]),
    el('div', { className: 'publisher-hero-actions' }, [setBtn, clearBtn]),
    status,
  )
  mount.replaceChildren(shell(form))
}

function handleWriteError(
  res: { ok: false; kind: string; errors?: Array<{ message: string }> },
  status: HTMLElement,
  navigate?: (url: string) => void,
): void {
  if (res.kind === 'session') {
    if (handleSessionError({ navigate }) === 'navigating') return
    showError(status, t('publisher.hero.error.session'))
    return
  }
  if (res.kind === 'validation' && res.errors && res.errors.length > 0) {
    showError(status, res.errors[0].message)
    return
  }
  showError(status, t('publisher.hero.error.generic'))
}

function showError(status: HTMLElement, message: string): void {
  status.textContent = message
  status.classList.add('publisher-hero-status-error')
}

/** Set a success status, clearing any error styling left by a prior
 *  failed attempt so e.g. "Hero cleared." doesn't render red. */
function showSuccess(status: HTMLElement, message: string): void {
  status.textContent = message
  status.classList.remove('publisher-hero-status-error')
}

// ----- Small DOM helpers (mirror the me.ts card/heading idiom) -----

function card(...children: HTMLElement[]): HTMLElement {
  const c = el('section', { className: 'publisher-card publisher-glass' })
  for (const child of children) c.append(child)
  return c
}

function heading(text: string): HTMLElement {
  return el('h2', { className: 'publisher-card-heading', textContent: text })
}

function labelled(label: string, control: HTMLElement): HTMLElement {
  const wrap = el('label', { className: 'publisher-hero-field' })
  wrap.append(el('span', { className: 'publisher-field-label', textContent: label }))
  wrap.append(control)
  return wrap
}

/** A date + time input pair, laid out side by side. */
function dateTimeRow(dateInput: HTMLElement, timeInput: HTMLElement): HTMLElement {
  return el('div', { className: 'publisher-hero-datetime-row' }, [dateInput, timeInput])
}
