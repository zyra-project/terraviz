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
 * Every feed — registered, preset, or a pasted custom URL — carries a
 * **Preview** toggle that dry-runs the URL through the server-side
 * preview endpoint (`GET /api/v1/publish/feeds/preview`) and lists the
 * latest mapped items inline, so the operator can see what a feed
 * would ingest before (or after) adding it.
 *
 * Every mutation re-renders the page from the server state (the queue
 * pattern `events.ts` uses). Feeds only change what lands in the
 * curator review queue — nothing surfaces publicly without approval.
 */

import { t } from '../../../i18n'
import { publisherGet, publisherSend, handleSessionError } from '../api'
import { buildErrorCard, type ErrorKind } from '../components/error-card'
import { FEED_PRESET_CATEGORIES, presetsForCategory, type FeedPresetCategory } from '../feed-presets'

const ME_ENDPOINT = '/api/v1/publish/me'
const FEEDS_ENDPOINT = '/api/v1/publish/feeds'
const PREVIEW_ENDPOINT = '/api/v1/publish/feeds/preview'
const REFRESH_ENDPOINT = '/api/v1/publish/events/refresh'
const YOUTUBE_CHANNELS_ENDPOINT = '/api/v1/publish/media/youtube-channels'

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

interface PreviewResponse {
  items: Array<{ title: string; publishedAt: string | null; url: string }>
}

interface YoutubeChannel {
  channelId: string
  channelName: string
  builtin: boolean
  /** Built-in channels switched off for this node — excluded from the
   *  media search until re-enabled. Always false for custom channels. */
  disabled?: boolean
}

interface YoutubeChannelsResponse {
  channels: YoutubeChannel[]
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
      // An unknown category (stored via the API, or from a newer
      // deployment) shows verbatim rather than collapsing to "Other".
      return category || t('publisher.feeds.category.other')
  }
}

export async function renderFeedsPage(mount: HTMLElement, options: FeedsPageOptions = {}): Promise<void> {
  const fetchFn = options.fetchFn
  mount.replaceChildren(shell(el('p', { className: 'publisher-loading', textContent: t('publisher.feeds.loading') })))

  const [meRes, feedsRes, channelsRes] = await Promise.all([
    publisherGet<MeResponse>(ME_ENDPOINT, { fetchFn }),
    publisherGet<FeedsResponse>(FEEDS_ENDPOINT, { fetchFn }),
    // The YouTube channel allowlist is a secondary card; a failure here
    // (e.g. an older deploy without the route) must not sink the page.
    publisherGet<YoutubeChannelsResponse>(YOUTUBE_CHANNELS_ENDPOINT, { fetchFn }),
  ])

  const renderFailure = (res: { kind: ErrorKind; status?: number; body?: string }): void => {
    if (res.kind === 'session') {
      if (handleSessionError({ navigate: options.navigate }) === 'navigating') return
      mount.replaceChildren(shell(buildErrorCard('session')))
      return
    }
    const details = res.kind === 'server' ? { status: res.status, body: res.body } : {}
    mount.replaceChildren(shell(buildErrorCard(res.kind, details)))
  }

  if (!meRes.ok) {
    renderFailure(meRes)
    return
  }

  // Gate on role before looking at the feeds response — for a
  // non-privileged caller the feeds fetch legitimately 403s, and the
  // restricted card (not a generic error card) is the right surface.
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

  if (!feedsRes.ok) {
    renderFailure(feedsRes)
    return
  }

  // `null` = the channels endpoint is unavailable (older deploy where
  // the route 404s, or a transient failure) — distinct from a valid
  // response. renderConsole omits the whole card in that case rather
  // than showing an allowlist UI whose Add/Remove actions would 404.
  const channels =
    channelsRes.ok && Array.isArray(channelsRes.data.channels) ? channelsRes.data.channels : null
  renderConsole(mount, feedsRes.data.feeds, channels, options)
}

/** Re-fetch the connector list and re-render — after every mutation. */
async function reload(mount: HTMLElement, options: FeedsPageOptions): Promise<void> {
  await renderFeedsPage(mount, options)
}

function renderConsole(
  mount: HTMLElement,
  feeds: FeedRow[],
  channels: YoutubeChannel[] | null,
  options: FeedsPageOptions,
): void {
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
    // Surface the server's own `{ error, message }` when it sent one
    // (the users-page pattern) — far more debuggable than the generic
    // label for operator mistakes like a rejected URL.
    if (res.kind === 'server' && res.body) {
      try {
        const parsed = JSON.parse(res.body) as { message?: unknown }
        if (typeof parsed.message === 'string' && parsed.message) {
          showError(parsed.message)
          return false
        }
      } catch {
        /* non-JSON body — fall through to the generic label */
      }
    }
    showError(t('publisher.feeds.error.generic'))
    return false
  }

  /**
   * A Preview toggle + its inline result panel. Clicking dry-runs the
   * feed URL through the server-side preview endpoint and lists the
   * latest mapped items (title, date, link); clicking again collapses.
   * `getUrl` is lazy so the custom form can preview whatever is typed.
   */
  let previewSeq = 0
  const previewControl = (kind: string, getUrl: () => string): { button: HTMLButtonElement; panel: HTMLElement } => {
    const panel = el('div', {
      className: 'publisher-feeds-preview',
      id: `feeds-preview-${++previewSeq}`,
      hidden: true,
    })
    const button = el('button', {
      type: 'button',
      className: 'publisher-button publisher-button-small',
      textContent: t('publisher.feeds.preview'),
    })
    button.setAttribute('aria-expanded', 'false')
    button.setAttribute('aria-controls', panel.id)
    // Monotonic token per request — a stale in-flight response (rapid
    // collapse → reopen) must not overwrite a newer panel state.
    let requestToken = 0
    button.addEventListener('click', () => {
      if (!panel.hidden) {
        panel.hidden = true
        panel.replaceChildren()
        button.textContent = t('publisher.feeds.preview')
        button.setAttribute('aria-expanded', 'false')
        return
      }
      const url = getUrl()
      if (!/^https?:\/\//i.test(url)) {
        showError(t('publisher.feeds.preview.invalidUrl'))
        return
      }
      panel.hidden = false
      button.textContent = t('publisher.feeds.preview.hide')
      button.setAttribute('aria-expanded', 'true')
      panel.replaceChildren(
        el('p', { className: 'publisher-feeds-preview-note', textContent: t('publisher.feeds.preview.loading') }),
      )
      const token = ++requestToken
      const query = `${PREVIEW_ENDPOINT}?kind=${encodeURIComponent(kind)}&url=${encodeURIComponent(url)}`
      void publisherGet<PreviewResponse>(query, { fetchFn: options.fetchFn }).then(res => {
        if (panel.hidden || token !== requestToken) return // collapsed or superseded while loading
        if (!res.ok) {
          panel.replaceChildren(
            el('p', {
              className: 'publisher-feeds-preview-note publisher-feeds-status-error',
              textContent: t('publisher.feeds.preview.error'),
            }),
          )
          return
        }
        const items = Array.isArray(res.data.items) ? res.data.items : []
        if (items.length === 0) {
          panel.replaceChildren(
            el('p', { className: 'publisher-feeds-preview-note', textContent: t('publisher.feeds.preview.empty') }),
          )
          return
        }
        const list = el('ul', { className: 'publisher-feeds-preview-list' })
        for (const item of items) {
          const link = el('a', {
            className: 'publisher-feeds-preview-title',
            textContent: item.title,
            href: item.url,
            target: '_blank',
            rel: 'noopener noreferrer',
          })
          const li = el('li', { className: 'publisher-feeds-preview-item' }, [link])
          if (item.publishedAt) {
            li.append(el('span', { className: 'publisher-feeds-preview-date', textContent: item.publishedAt.slice(0, 10) }))
          }
          list.append(li)
        }
        panel.replaceChildren(list)
      })
    })
    return { button, panel }
  }

  // ── Card 1: your feeds ─────────────────────────────────────────
  const runBtn = el('button', {
    type: 'button',
    className: 'publisher-button publisher-button-primary',
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
      className: 'publisher-button publisher-button-small',
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
      className: 'publisher-button publisher-button-small publisher-button-danger',
      textContent: t('publisher.feeds.remove'),
    })
    removeBtn.addEventListener('click', () => {
      removeBtn.disabled = true
      void send(`${FEEDS_ENDPOINT}/${feed.id}`, null, 'DELETE').then(ok => {
        if (ok) void reload(mount, options)
        else removeBtn.disabled = false
      })
    })

    const preview = previewControl(feed.kind, () => feed.url)
    return el('div', { className: 'publisher-feeds-entry' }, [
      el('div', { className: 'publisher-feeds-row' }, [
        dot,
        el('span', { className: 'publisher-feeds-row-main' }, [
          el('span', { className: 'publisher-feeds-row-label', textContent: feed.label }),
          meta,
        ]),
        el('span', { className: 'publisher-feeds-row-actions' }, [preview.button, toggleBtn, removeBtn]),
      ]),
      preview.panel,
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
        className: 'publisher-button publisher-button-small',
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
      const preview = previewControl(preset.kind, () => preset.url)
      suggested.append(
        el('div', { className: 'publisher-feeds-entry' }, [
          el('div', { className: 'publisher-feeds-preset' }, [
            el('span', { className: 'publisher-feeds-row-main' }, [
              el('span', { className: 'publisher-feeds-row-label', textContent: preset.label }),
              el('span', { className: 'publisher-feeds-row-meta', textContent: t(preset.descriptionKey) }),
            ]),
            el('span', { className: 'publisher-feeds-row-actions' }, [preview.button, addBtn]),
          ]),
          preview.panel,
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
  // Category is a free-text combobox: the three curated presets plus
  // any categories already in use on existing feeds are offered as
  // datalist suggestions, but the publisher can type a new one. The
  // backend stores an arbitrary string (`feed_connectors.category`
  // TEXT, capped at 60 chars server-side, no enum), so a custom
  // category persists and reappears here on the next render.
  const presetByLabel = new Map<string, string>()
  const categoryOptions: string[] = []
  const seenCategoryLabels = new Set<string>()
  const addCategoryOption = (value: string): void => {
    const label = categoryLabel(value)
    const key = label.toLowerCase()
    if (seenCategoryLabels.has(key)) return
    seenCategoryLabels.add(key)
    categoryOptions.push(label)
  }
  for (const c of FEED_PRESET_CATEGORIES) {
    presetByLabel.set(categoryLabel(c).toLowerCase(), c)
    addCategoryOption(c)
  }
  // Distinct categories already stored on the publisher's feeds — this
  // is what makes a previously-created custom category reappear.
  for (const f of feeds) {
    if (f.category) addCategoryOption(f.category)
  }

  const categoryList = el('datalist', { id: 'feeds-category-list' })
  for (const label of categoryOptions) {
    categoryList.append(el('option', { value: label }))
  }
  const categoryInput = el('input', {
    type: 'text',
    className: 'publisher-feeds-input',
    id: 'feeds-custom-category',
    maxLength: 60,
    placeholder: t('publisher.feeds.custom.category.placeholder'),
  })
  categoryInput.setAttribute('list', 'feeds-category-list')

  /** Map the typed/selected display label back to the stored category:
   *  a preset label collapses to its key ('Natural hazards' →
   *  'hazards') so it groups with feeds added from the preset gallery;
   *  anything else is stored verbatim; empty → no category. */
  const resolveCategory = (): string | null => {
    const typed = categoryInput.value.trim()
    if (!typed) return null
    return presetByLabel.get(typed.toLowerCase()) ?? typed
  }

  const addCustomBtn = el('button', {
    type: 'button',
    className: 'publisher-button publisher-button-primary',
    textContent: t('publisher.feeds.custom.add'),
  })
  addCustomBtn.addEventListener('click', () => {
    const label = labelInput.value.trim()
    const url = urlInput.value.trim()
    if (!label || !/^https?:\/\//i.test(url)) {
      showError(t('publisher.feeds.custom.invalid'))
      return
    }
    const category = resolveCategory()
    addCustomBtn.disabled = true
    void send(
      FEEDS_ENDPOINT,
      { kind: 'rss', label, url, ...(category ? { category } : {}) },
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

  // Category field carries a hint + the datalist that backs the combobox.
  const categoryField = labelled(t('publisher.feeds.custom.category'), categoryInput)
  categoryField.append(
    el('span', {
      className: 'publisher-feeds-hint',
      textContent: t('publisher.feeds.custom.category.hint'),
    }),
    categoryList,
  )

  const customPreview = previewControl('rss', () => urlInput.value.trim())
  const custom = card(
    heading(t('publisher.feeds.custom.title')),
    el('p', { className: 'publisher-feeds-intro', textContent: t('publisher.feeds.custom.intro') }),
    labelled(t('publisher.feeds.custom.label'), labelInput),
    labelled(t('publisher.feeds.custom.url'), urlInput),
    categoryField,
    el('div', { className: 'publisher-feeds-actions' }, [customPreview.button, addCustomBtn]),
    customPreview.panel,
  )

  // ── Card 4: agency-YouTube channel allowlist ───────────────────
  // When the channels endpoint is unavailable (older deploy), the
  // Media channels tab shows a note instead of an allowlist UI whose
  // Add/Remove would 404.
  const mediaContent =
    channels !== null
      ? renderChannelsCard(mount, channels, options, showError, send)
      : card(
          heading(t('publisher.feeds.channels.title')),
          el('p', { className: 'publisher-feeds-restricted', textContent: t('publisher.feeds.channels.unavailable') }),
        )

  // Page header + two tabs (News feeds / Media channels), matching
  // the review deck. Tabs toggle panel visibility in place — no
  // refetch — so switching tabs is instant.
  const header = el('header', { className: 'publisher-page-header' }, [
    el('div', { className: 'publisher-page-titles' }, [
      el('h1', { className: 'publisher-page-title', textContent: t('publisher.feeds.pageTitle') }),
      el('p', { className: 'publisher-page-subtitle', textContent: t('publisher.feeds.pageSubtitle') }),
    ]),
  ])

  const newsPanel = el('div', { className: 'publisher-feeds-panel' }, [yourFeeds, suggested, custom])
  const mediaPanel = el('div', { className: 'publisher-feeds-panel' }, [mediaContent])
  mediaPanel.hidden = true

  const tabs = el('div', { className: 'publisher-tabs', role: 'tablist' }) as HTMLElement
  const makeTab = (labelKey: 'publisher.feeds.tab.news' | 'publisher.feeds.tab.media', panel: HTMLElement, active: boolean): HTMLElement => {
    const tab = el('button', {
      type: 'button',
      className: active ? 'publisher-tab publisher-tab-active' : 'publisher-tab',
      textContent: t(labelKey),
    }) as HTMLButtonElement
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', active ? 'true' : 'false')
    tab.addEventListener('click', () => {
      newsPanel.hidden = panel !== newsPanel
      mediaPanel.hidden = panel !== mediaPanel
      for (const el2 of Array.from(tabs.children)) {
        const isThis = el2 === tab
        el2.classList.toggle('publisher-tab-active', isThis)
        el2.setAttribute('aria-selected', isThis ? 'true' : 'false')
      }
    })
    return tab
  }
  tabs.append(makeTab('publisher.feeds.tab.news', newsPanel, true), makeTab('publisher.feeds.tab.media', mediaPanel, false))

  mount.replaceChildren(shell(header, tabs, newsPanel, mediaPanel))
}

/** The "Trusted video channels" card — the reputable-source allowlist
 *  the YouTube media suggestion filters against. The built-in agency
 *  defaults are shown as fixed; the node's own channels (any vetted
 *  channel, agency or not) are added by URL and removable. */
function renderChannelsCard(
  mount: HTMLElement,
  channels: YoutubeChannel[],
  options: FeedsPageOptions,
  showError: (message: string) => void,
  send: (endpoint: string, body: unknown, method: 'POST' | 'DELETE') => Promise<boolean>,
): HTMLElement {
  const wrap = card(
    heading(t('publisher.feeds.channels.title')),
    el('p', { className: 'publisher-feeds-intro', textContent: t('publisher.feeds.channels.intro') }),
  )

  const list = el('ul', { className: 'publisher-feeds-channels' })
  for (const ch of channels) {
    const row = el('li', { className: 'publisher-feeds-channel-row' })
    if (ch.builtin && ch.disabled) row.classList.add('publisher-feeds-channel-row-off')
    const metaText = ch.builtin
      ? ch.disabled
        ? t('publisher.feeds.channels.builtinDisabled')
        : t('publisher.feeds.channels.builtin')
      : ch.channelId
    const main = el('span', { className: 'publisher-feeds-row-main' }, [
      el('span', { className: 'publisher-feeds-row-label', textContent: ch.channelName }),
      el('span', { className: 'publisher-feeds-row-meta', textContent: metaText }),
    ])
    row.append(main)
    if (ch.builtin) {
      // Built-ins can't be removed (code constants) — a node switches
      // one off/on per-node instead, dropping it from the media search.
      const toggle = el('button', {
        type: 'button',
        className: 'publisher-button publisher-button-small',
        textContent: ch.disabled ? t('publisher.feeds.channels.enable') : t('publisher.feeds.channels.disable'),
      })
      toggle.addEventListener('click', () => {
        toggle.disabled = true
        void send(
          `${YOUTUBE_CHANNELS_ENDPOINT}/${encodeURIComponent(ch.channelId)}`,
          { disabled: !ch.disabled },
          'POST',
        ).then(ok => {
          if (ok) void reload(mount, options)
          else toggle.disabled = false
        })
      })
      row.append(toggle)
    } else {
      const remove = el('button', {
        type: 'button',
        className: 'publisher-button publisher-button-small',
        textContent: t('publisher.feeds.channels.remove'),
      })
      remove.addEventListener('click', () => {
        remove.disabled = true
        void send(`${YOUTUBE_CHANNELS_ENDPOINT}/${encodeURIComponent(ch.channelId)}`, undefined, 'DELETE').then(
          ok => {
            if (ok) void reload(mount, options)
            else remove.disabled = false
          },
        )
      })
      row.append(remove)
    }
    list.append(row)
  }
  wrap.append(list)

  const urlInput = el('input', {
    type: 'text',
    className: 'publisher-feeds-input',
    id: 'feeds-channel-url',
    placeholder: 'https://youtube.com/@… or /channel/UC…', // i18n-exempt: URL shape hint
    maxLength: 300,
  })
  const addBtn = el('button', {
    type: 'button',
    className: 'publisher-button publisher-button-primary',
    textContent: t('publisher.feeds.channels.add'),
  })
  addBtn.addEventListener('click', () => {
    const url = urlInput.value.trim()
    if (!url) {
      showError(t('publisher.feeds.channels.invalid'))
      return
    }
    addBtn.disabled = true
    void send(YOUTUBE_CHANNELS_ENDPOINT, { url }, 'POST').then(ok => {
      if (ok) void reload(mount, options)
      else addBtn.disabled = false
    })
  })
  wrap.append(
    el('label', { className: 'publisher-feeds-field' }, [
      el('span', { className: 'publisher-field-label', textContent: t('publisher.feeds.channels.url') }),
      urlInput,
    ]),
    el('div', { className: 'publisher-feeds-actions' }, [addBtn]),
  )
  return wrap
}
