/**
 * /publish/feeds — the current-events feed console
 * (`docs/CURRENT_EVENTS_PLAN.md` §9).
 *
 * Privileged-only (admin / service). Three cards:
 *
 *   1. **Your feeds** — every registered connector with its enabled
 *      state, category, and last-run bookkeeping; pause/resume and
 *      remove per row, plus a Run-now button that hits the refresh
 *      endpoint (all enabled feeds) and reports the ingest summary.
 *   2. **Suggested feeds** — the curated preset catalog
 *      (`../feed-presets.ts`), grouped by category with one-click Add;
 *      a preset already registered (same URL) shows as added.
 *   3. **Add your own** — label + RSS/Atom URL + category for any feed
 *      not in the catalog.
 *
 * Every mutation re-renders the page from the server state (the queue
 * pattern `events.ts` uses). Feeds only change what lands in the
 * curator review queue — nothing surfaces publicly without approval.
 */

import { t } from '../../../i18n'
import { publisherGet, publisherSend, handleSessionError } from '../api'
import { buildErrorCard } from '../components/error-card'
import { FEED_PRESET_CATEGORIES, presetsForCategory, type FeedPresetCategory } from '../feed-presets'

const ME_ENDPOINT = '/api/v1/publish/me'
const FEEDS_ENDPOINT = '/api/v1/publish/feeds'
const REFRESH_ENDPOINT = '/api/v1/publish/events/refresh'

interface MeResponse {
  role: string
  is_admin: boolean
}

interface FeedRow {
  id: string
  kind: string
  label: string
  url: string
  category: string | null
  enabled: boolean
  lastRunAt: string | null
  lastRunStatus: 'ok' | 'error' | null
  lastRunError: string | null
}

interface FeedsResponse {
  feeds: FeedRow[]
}

interface RefreshResponse {
  created: number
  refreshed: number
  failed: number
}

export interface FeedsPageOptions {
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
}

function clientIsPrivileged(me: MeResponse): boolean {
  return me.is_admin === true || me.role === 'admin' || me.role === 'service'
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

function shell(...children: HTMLElement[]): HTMLElement {
  const m = el('main', { className: 'publisher-shell' })
  for (const c of children) m.append(c)
  return m
}

function card(...children: HTMLElement[]): HTMLElement {
  const c = el('section', { className: 'publisher-card publisher-glass' })
  for (const child of children) c.append(child)
  return c
}

function heading(text: string): HTMLElement {
  return el('h2', { className: 'publisher-card-heading', textContent: text })
}

function categoryLabel(category: FeedPresetCategory | string | null): string {
  switch (category) {
    case 'hazards':
      return t('publisher.feeds.category.hazards')
    case 'science-news':
      return t('publisher.feeds.category.scienceNews')
    case 'news':
      return t('publisher.feeds.category.news')
    default:
      return t('publisher.feeds.category.other')
  }
}

export async function renderFeedsPage(mount: HTMLElement, options: FeedsPageOptions = {}): Promise<void> {
  const fetchFn = options.fetchFn
  mount.replaceChildren(shell(el('p', { className: 'publisher-loading', textContent: t('publisher.feeds.loading') })))

  const [meRes, feedsRes] = await Promise.all([
    publisherGet<MeResponse>(ME_ENDPOINT, { fetchFn }),
    publisherGet<FeedsResponse>(FEEDS_ENDPOINT, { fetchFn }),
  ])

  for (const res of [meRes, feedsRes]) {
    if (res.ok) continue
    if (res.kind === 'session') {
      if (handleSessionError({ navigate: options.navigate }) === 'navigating') return
      mount.replaceChildren(shell(buildErrorCard('session')))
      return
    }
    const details = res.kind === 'server' ? { status: res.status, body: res.body } : {}
    mount.replaceChildren(shell(buildErrorCard(res.kind, details)))
    return
  }
  if (!meRes.ok || !feedsRes.ok) return

  if (!clientIsPrivileged(meRes.data)) {
    mount.replaceChildren(
      shell(
        card(
          heading(t('publisher.feeds.title')),
          el('p', { className: 'publisher-feeds-restricted', textContent: t('publisher.feeds.restricted') }),
        ),
      ),
    )
    return
  }

  renderConsole(mount, feedsRes.data.feeds, options)
}

/** Re-fetch the connector list and re-render — after every mutation. */
async function reload(mount: HTMLElement, options: FeedsPageOptions): Promise<void> {
  await renderFeedsPage(mount, options)
}

function renderConsole(mount: HTMLElement, feeds: FeedRow[], options: FeedsPageOptions): void {
  const status = el('div', { className: 'publisher-feeds-status', role: 'status' })
  const showError = (message: string): void => {
    status.textContent = message
    status.classList.add('publisher-feeds-status-error')
  }
  const showInfo = (message: string): void => {
    status.textContent = message
    status.classList.remove('publisher-feeds-status-error')
  }

  const send = async (
    endpoint: string,
    body: unknown,
    method: 'POST' | 'DELETE',
  ): Promise<boolean> => {
    const res = await publisherSend<unknown>(endpoint, body, { method, fetchFn: options.fetchFn })
    if (res.ok) return true
    if (res.kind === 'session') {
      if (handleSessionError({ navigate: options.navigate }) === 'navigating') return false
      showError(t('publisher.feeds.error.session'))
      return false
    }
    if (res.kind === 'validation' && res.errors && res.errors.length > 0) {
      showError(res.errors[0].message)
      return false
    }
    showError(t('publisher.feeds.error.generic'))
    return false
  }

  // ── Card 1: your feeds ─────────────────────────────────────────
  const runBtn = el('button', {
    type: 'button',
    className: 'publisher-btn publisher-btn-primary',
    textContent: t('publisher.feeds.runNow'),
  })
  runBtn.addEventListener('click', () => {
    runBtn.disabled = true
    showInfo(t('publisher.feeds.running'))
    void publisherSend<RefreshResponse>(REFRESH_ENDPOINT, {}, { method: 'POST', fetchFn: options.fetchFn }).then(
      res => {
        runBtn.disabled = false
        if (res.ok) {
          showInfo(
            t('publisher.feeds.runDone', {
              created: String(res.data.created),
              refreshed: String(res.data.refreshed),
              failed: String(res.data.failed),
            }),
          )
          void reload(mount, options)
          return
        }
        showError(t('publisher.feeds.error.run'))
      },
    )
  })

  const list = el('div', { className: 'publisher-feeds-list' })
  if (feeds.length === 0) {
    list.append(el('p', { className: 'publisher-empty-message', textContent: t('publisher.feeds.empty') }))
  }
  for (const feed of feeds) {
    list.append(feedRow(feed))
  }

  function feedRow(feed: FeedRow): HTMLElement {
    const dot = el('span', {
      className: `publisher-feeds-dot ${feed.enabled ? 'publisher-feeds-dot-on' : 'publisher-feeds-dot-off'}`,
    })
    const lastRun = feed.lastRunAt
      ? feed.lastRunStatus === 'error'
        ? t('publisher.feeds.lastRun.error', { detail: feed.lastRunError ?? '' })
        : t('publisher.feeds.lastRun.ok', { when: feed.lastRunAt.slice(0, 16).replace('T', ' ') })
      : t('publisher.feeds.lastRun.never')
    const meta = el('span', { className: 'publisher-feeds-row-meta' }, [
      `${categoryLabel(feed.category)} · ${lastRun}`,
    ])
    if (feed.lastRunStatus === 'error') meta.classList.add('publisher-feeds-row-meta-error')

    const toggleBtn = el('button', {
      type: 'button',
      className: 'publisher-btn publisher-btn-small',
      textContent: feed.enabled ? t('publisher.feeds.pause') : t('publisher.feeds.resume'),
    })
    toggleBtn.addEventListener('click', () => {
      toggleBtn.disabled = true
      void send(`${FEEDS_ENDPOINT}/${feed.id}`, { enabled: !feed.enabled }, 'POST').then(ok => {
        if (ok) void reload(mount, options)
        else toggleBtn.disabled = false
      })
    })

    const removeBtn = el('button', {
      type: 'button',
      className: 'publisher-btn publisher-btn-small publisher-btn-danger',
      textContent: t('publisher.feeds.remove'),
    })
    removeBtn.addEventListener('click', () => {
      removeBtn.disabled = true
      void send(`${FEEDS_ENDPOINT}/${feed.id}`, null, 'DELETE').then(ok => {
        if (ok) void reload(mount, options)
        else removeBtn.disabled = false
      })
    })

    return el('div', { className: 'publisher-feeds-row' }, [
      dot,
      el('span', { className: 'publisher-feeds-row-main' }, [
        el('span', { className: 'publisher-feeds-row-label', textContent: feed.label }),
        meta,
      ]),
      el('span', { className: 'publisher-feeds-row-actions' }, [toggleBtn, removeBtn]),
    ])
  }

  const yourFeeds = card(
    heading(t('publisher.feeds.title')),
    el('p', { className: 'publisher-feeds-intro', textContent: t('publisher.feeds.intro') }),
    list,
    el('div', { className: 'publisher-feeds-actions' }, [runBtn]),
    status,
  )

  // ── Card 2: suggested presets, grouped by category ─────────────
  const registeredUrls = new Set(feeds.map(f => f.url))
  const suggested = card(heading(t('publisher.feeds.suggested')))
  for (const category of FEED_PRESET_CATEGORIES) {
    const presets = presetsForCategory(category)
    if (presets.length === 0) continue
    suggested.append(el('h3', { className: 'publisher-feeds-group', textContent: categoryLabel(category) }))
    for (const preset of presets) {
      const added = registeredUrls.has(preset.url)
      const addBtn = el('button', {
        type: 'button',
        className: 'publisher-btn publisher-btn-small',
        textContent: added ? t('publisher.feeds.addedBadge') : t('publisher.feeds.add'),
        disabled: added,
      })
      addBtn.addEventListener('click', () => {
        addBtn.disabled = true
        void send(
          FEEDS_ENDPOINT,
          { kind: preset.kind, label: preset.label, url: preset.url, category: preset.category },
          'POST',
        ).then(ok => {
          if (ok) void reload(mount, options)
          else addBtn.disabled = false
        })
      })
      suggested.append(
        el('div', { className: 'publisher-feeds-preset' }, [
          el('span', { className: 'publisher-feeds-row-main' }, [
            el('span', { className: 'publisher-feeds-row-label', textContent: preset.label }),
            el('span', { className: 'publisher-feeds-row-meta', textContent: t(preset.descriptionKey) }),
          ]),
          addBtn,
        ]),
      )
    }
  }

  // ── Card 3: bring your own ─────────────────────────────────────
  const labelInput = el('input', {
    type: 'text',
    className: 'publisher-feeds-input',
    id: 'feeds-custom-label',
    maxLength: 120,
  })
  const urlInput = el('input', {
    type: 'url',
    className: 'publisher-feeds-input',
    id: 'feeds-custom-url',
    placeholder: 'https://…', // i18n-exempt: URL shape hint, not prose
  })
  const categorySelect = el('select', { className: 'publisher-feeds-input', id: 'feeds-custom-category' })
  for (const c of FEED_PRESET_CATEGORIES) {
    categorySelect.append(el('option', { value: c, textContent: categoryLabel(c) }))
  }
  categorySelect.append(el('option', { value: '', textContent: t('publisher.feeds.category.other') }))

  const addCustomBtn = el('button', {
    type: 'button',
    className: 'publisher-btn publisher-btn-primary',
    textContent: t('publisher.feeds.custom.add'),
  })
  addCustomBtn.addEventListener('click', () => {
    const label = labelInput.value.trim()
    const url = urlInput.value.trim()
    if (!label || !/^https?:\/\//i.test(url)) {
      showError(t('publisher.feeds.custom.invalid'))
      return
    }
    addCustomBtn.disabled = true
    void send(
      FEEDS_ENDPOINT,
      { kind: 'rss', label, url, ...(categorySelect.value ? { category: categorySelect.value } : {}) },
      'POST',
    ).then(ok => {
      if (ok) void reload(mount, options)
      else addCustomBtn.disabled = false
    })
  })

  const labelled = (label: string, control: HTMLElement): HTMLElement => {
    const wrap = el('label', { className: 'publisher-feeds-field' })
    wrap.append(el('span', { className: 'publisher-field-label', textContent: label }))
    wrap.append(control)
    return wrap
  }

  const custom = card(
    heading(t('publisher.feeds.custom.title')),
    el('p', { className: 'publisher-feeds-intro', textContent: t('publisher.feeds.custom.intro') }),
    labelled(t('publisher.feeds.custom.label'), labelInput),
    labelled(t('publisher.feeds.custom.url'), urlInput),
    labelled(t('publisher.feeds.custom.category'), categorySelect),
    el('div', { className: 'publisher-feeds-actions' }, [addCustomBtn]),
  )

  mount.replaceChildren(shell(yourFeeds, suggested, custom))
}
