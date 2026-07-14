/**
 * /publish/blog/new + /publish/blog/:id/edit — the blog post editor
 * (Phase 3d; `docs/CURRENT_EVENTS_PLAN.md` §7).
 *
 * Tabbed sections:
 *   1. **Content** — title, summary, and the markdown body with the
 *      shared toolbar + sanitized Preview.
 *   2. **Sources** — pick the datasets the post draws on (the same
 *      catalog search the events tab uses) and optionally cite a
 *      current event; these selections feed both the AI Generate call
 *      and the saved post's citations.
 *   3. **Media** — suggested imagery for the cited event (the same
 *      engine as the Events tab: NASA Worldview, Wikimedia Commons,
 *      USGS ShakeMap, NHC cones, agency YouTube, plus the event's own
 *      story image). Each card can be inserted into the post body as
 *      markdown, or set as the post's cover image.
 *   4. **AI draft** — tone / length / companion-tour controls around
 *      `POST /api/v1/publish/blog/generate`; a successful draft fills
 *      the content fields (the curator edits from there — nothing is
 *      saved until they say so).
 *
 * Save creates (`POST /publish/blog`) or updates (`PUT
 * /publish/blog/:id`); Publish / Unpublish are the explicit status
 * transitions. Privileged-gated client-side; the API enforces 403
 * independently.
 */

import { fetchFeatures, renderFeatureDisabledCard } from '../features'
import { t } from '../../../i18n'
import { publisherGet, publisherSend, handleSessionError } from '../api'
import { buildErrorCard } from '../components/error-card'
import { attachToolbar, renderMarkdownToolbar } from '../components/markdown-toolbar'
import { loadPublishedDatasets, filterDatasetsByTitle } from '../components/events/dataset-search'
import {
  buildWorldviewSnapshot,
  fetchCommonsSuggestions,
  fetchNhcConeSuggestion,
  fetchShakemapSuggestion,
  fetchYoutubeSuggestions,
  looksLikeQuake,
  looksLikeTropical,
  type MediaSuggestion,
} from '../components/events/media-suggest'
import type { ReviewEvent } from '../components/events/events-model'
import { resolveRegion } from '../../../data/regions'
import { renderMarkdown } from '../../../services/markdownRenderer'
import type { PublisherDataset } from '../types'

interface MeResponse {
  role: string
  is_admin: boolean
}

interface PostWire {
  id: string
  slug: string
  title: string
  summary: string | null
  bodyMd: string
  datasetIds: string[]
  eventId: string | null
  status: 'draft' | 'published'
  publishedAt: string | null
  tourId: string | null
  coverImageUrl: string | null
  coverImageAlt: string | null
}

const ME_ENDPOINT = '/api/v1/publish/me'
const BLOG_ENDPOINT = '/api/v1/publish/blog'
// Approved only: the public post drops a citation whose event isn't
// approved, and generation grounds itself in the event's text — the
// picker must not offer anything that hasn't passed the curator gate.
const EVENTS_ENDPOINT = '/api/v1/publish/events?status=approved'
const GENERATE_ENDPOINT = '/api/v1/publish/blog/generate'

/** Cap on candidate rows in the pickers. */
const PICKER_ROWS = 12

export interface BlogEditPageOptions {
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
  /** Post id when editing; omitted on /publish/blog/new. */
  postId?: string
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

function labelled(label: string, control: HTMLElement): HTMLElement {
  const wrap = el('label', { className: 'publisher-blog-field' })
  wrap.append(el('span', { className: 'publisher-field-label', textContent: label }), control)
  return wrap
}

function setStatus(node: HTMLElement, message: string, isError: boolean): void {
  node.textContent = message
  node.classList.toggle('publisher-blog-status-error', isError)
}

function handleWriteError(
  res: { ok: false; kind: string; errors?: Array<{ message: string }>; body?: string },
  status: HTMLElement,
  navigate?: (url: string) => void,
): void {
  if (res.kind === 'session') {
    if (handleSessionError({ navigate }) === 'navigating') return
    setStatus(status, t('publisher.blog.error.session'), true)
    return
  }
  if (res.kind === 'validation' && res.errors && res.errors.length > 0) {
    setStatus(status, res.errors[0].message, true)
    return
  }
  if (res.kind === 'server' && res.body) {
    // The blog routes return typed `{ error, message }` failures whose
    // message is written for the curator ("Workers AI is not bound on
    // this deployment", "The model call failed or timed out — try
    // again") — show it instead of a generic shrug, same policy as
    // the validation branch above.
    try {
      const parsed = JSON.parse(res.body) as { message?: unknown }
      if (typeof parsed.message === 'string' && parsed.message.trim()) {
        setStatus(status, parsed.message, true)
        return
      }
    } catch {
      // Not JSON — fall through to the generic message.
    }
  }
  setStatus(status, t('publisher.blog.error.generic'), true)
}

/**
 * The media engine reads `geometry.boundingBox` / `geometry.point`, but
 * an event can carry a region *name* with no bbox (ingest inferred a
 * region string, or a curator typed one) — the geo-gated sources would
 * then stay dark even though the place is known. Resolve the name to a
 * bbox client-side via the same `regions.ts` the events backend uses on
 * edit, so a named region ("Iowa") behaves like an explicit box. Leaves
 * the event untouched when it already has a box/point, or the name isn't
 * a known region.
 */
function withResolvedGeometry(ev: ReviewEvent): ReviewEvent {
  const g = ev.geometry
  if (!g || g.boundingBox || g.point || !g.regionName) return ev
  const region = resolveRegion(g.regionName)
  if (!region) return ev
  const [w, s, e, n] = region.bounds
  return { ...ev, geometry: { ...g, boundingBox: { n, s, w, e } } }
}

export async function renderBlogEditPage(mount: HTMLElement, options: BlogEditPageOptions = {}): Promise<void> {
  if (!(await fetchFeatures()).blog) {
    renderFeatureDisabledCard(mount, 'blog')
    return
  }
  const fetchFn = options.fetchFn
  const navigate = options.navigate ?? ((url: string) => { window.location.href = url })
  mount.replaceChildren(shell(el('p', { className: 'publisher-loading', textContent: t('publisher.blog.loading') })))

  const [meRes, postRes] = await Promise.all([
    publisherGet<MeResponse>(ME_ENDPOINT, { fetchFn }),
    options.postId
      ? publisherGet<{ post: PostWire }>(`${BLOG_ENDPOINT}/${encodeURIComponent(options.postId)}`, { fetchFn })
      : Promise.resolve(null),
  ])
  for (const res of [meRes, postRes]) {
    if (!res || res.ok) continue
    if (res.kind === 'session') {
      if (handleSessionError({ navigate: options.navigate }) === 'navigating') return
      mount.replaceChildren(shell(buildErrorCard('session')))
      return
    }
    const details = res.kind === 'server' ? { status: res.status, body: res.body } : {}
    mount.replaceChildren(shell(buildErrorCard(res.kind, details)))
    return
  }
  if (!meRes.ok || (postRes && !postRes.ok)) return

  if (!clientIsPrivileged(meRes.data)) {
    mount.replaceChildren(
      shell(
        card(
          el('h2', { className: 'publisher-card-heading', textContent: t('publisher.blog.editor.title') }),
          el('p', { className: 'publisher-blog-restricted', textContent: t('publisher.blog.restricted') }),
        ),
      ),
    )
    return
  }

  const existing = postRes?.ok ? postRes.data.post : null
  let postId = existing?.id ?? null
  let postStatus: 'draft' | 'published' = existing?.status ?? 'draft'
  // The AI-generated companion tour (tours-row id). Set by a
  // generate-with-tour, persisted with the post so the public page
  // can offer "Play the companion tour" once the tour is published.
  let companionTourId: string | null = existing?.tourId ?? null

  // ----- Grounding state -----
  const selected = new Map<string, string>() // dataset id → title
  let citedEventId: string | null = existing?.eventId ?? null
  let catalog: PublisherDataset[] = []
  let events: ReviewEvent[] = []

  // ----- Cover-image state (Media tab) -----
  let coverImageUrl: string | null = existing?.coverImageUrl ?? null
  let coverImageAlt: string | null = existing?.coverImageAlt ?? null

  // ----- Content fields -----
  const titleInput = el('input', {
    type: 'text', className: 'publisher-blog-input', id: 'blog-title', maxLength: 200,
    value: existing?.title ?? '',
  })
  const summaryInput = el('textarea', {
    className: 'publisher-blog-textarea', id: 'blog-summary', rows: 2, maxLength: 500,
    value: existing?.summary ?? '',
  })
  const bodyInput = el('textarea', {
    className: 'publisher-blog-textarea', id: 'blog-body', rows: 16,
    value: existing?.bodyMd ?? '',
  })
  const toolbar = renderMarkdownToolbar()
  attachToolbar(toolbar, bodyInput, { onChange: () => {} })
  const preview = el('div', { className: 'publisher-form-markdown-preview' })
  preview.hidden = true
  const renderPreview = (): void => {
    if (bodyInput.value.trim()) {
      // renderMarkdown runs `marked` then sanitizeMarkdownHtml — safe
      // to set as innerHTML (XSS-tested in markdownRenderer.test.ts).
      preview.innerHTML = renderMarkdown(bodyInput.value)
    } else {
      preview.replaceChildren(el('p', { className: 'publisher-form-markdown-empty', textContent: t('publisher.datasetForm.preview.empty') }))
    }
  }
  const previewToggle = el('button', {
    type: 'button', className: 'publisher-form-toggle',
    textContent: t('publisher.datasetForm.action.preview'),
  })
  previewToggle.addEventListener('click', () => {
    const show = preview.hidden
    preview.hidden = !show
    bodyInput.hidden = show
    toolbar.hidden = show
    previewToggle.textContent = show ? t('publisher.datasetForm.action.edit') : t('publisher.datasetForm.action.preview')
    if (show) renderPreview()
  })

  // ----- Dataset picker -----
  const chips = el('div', { className: 'publisher-blog-chips' })
  const renderChips = (): void => {
    chips.replaceChildren()
    for (const [id, title] of selected) {
      const chip = el('span', { className: 'publisher-blog-chip' }, [title])
      const x = el('button', { type: 'button', className: 'publisher-blog-chip-x', textContent: '✕' }) // i18n-exempt: glyph; aria below
      x.setAttribute('aria-label', t('publisher.blog.picker.removeAria', { title }))
      x.addEventListener('click', () => {
        selected.delete(id)
        renderChips()
      })
      chip.append(x)
      chips.append(chip)
    }
    if (selected.size === 0) {
      chips.append(el('p', { className: 'publisher-blog-picker-hint', textContent: t('publisher.blog.picker.none') }))
    }
  }
  const dsSearch = el('input', {
    type: 'search', className: 'publisher-blog-input', placeholder: t('publisher.blog.picker.searchPlaceholder'), disabled: true,
  })
  dsSearch.setAttribute('aria-label', t('publisher.blog.picker.searchPlaceholder'))
  const dsCandidates = el('div', { className: 'publisher-blog-candidates' })
  const renderDsCandidates = (): void => {
    dsCandidates.replaceChildren()
    const matches = filterDatasetsByTitle(catalog, dsSearch.value, new Set(selected.keys()), PICKER_ROWS)
    for (const d of matches) {
      const row = el('button', { type: 'button', className: 'publisher-blog-candidate', textContent: d.title })
      row.addEventListener('click', () => {
        selected.set(d.id, d.title)
        renderChips()
        renderDsCandidates()
      })
      dsCandidates.append(row)
    }
  }
  dsSearch.addEventListener('input', renderDsCandidates)

  // ----- Event picker (single select) -----
  const evSelect = el('select', { className: 'publisher-blog-input publisher-blog-event-select', disabled: true })
  evSelect.setAttribute('aria-label', t('publisher.blog.event.label'))
  const renderEventOptions = (): void => {
    evSelect.replaceChildren()
    evSelect.append(el('option', { value: '', textContent: t('publisher.blog.event.none') }))
    for (const ev of events) {
      evSelect.append(el('option', { value: ev.id, textContent: ev.title }))
    }
    if (citedEventId) evSelect.value = citedEventId
  }
  evSelect.addEventListener('change', () => {
    citedEventId = evSelect.value || null
    // The event's approved dataset pairings were already vetted on
    // the Events tab — seed them as grounding chips so the curator
    // doesn't re-pick them by hand. Additive merge: existing chips
    // stay, seeded ones are removable like any other.
    if (!citedEventId) return
    const ev = events.find(e => e.id === citedEventId)
    let added = false
    for (const link of ev?.links ?? []) {
      if (link.status !== 'approved' || selected.has(link.datasetId)) continue
      selected.set(link.datasetId, link.datasetTitle ?? link.datasetId)
      added = true
    }
    if (added) {
      renderChips()
      renderDsCandidates()
    }
  })

  // ----- Generate controls -----
  const toneInput = el('input', {
    type: 'text', className: 'publisher-blog-input', id: 'blog-tone', maxLength: 200,
    placeholder: t('publisher.blog.generate.tonePlaceholder'),
  })
  const lengthSelect = el('select', { className: 'publisher-blog-input', id: 'blog-length' })
  for (const [value, key] of [
    ['short', 'publisher.blog.generate.length.short'],
    ['medium', 'publisher.blog.generate.length.medium'],
    ['long', 'publisher.blog.generate.length.long'],
  ] as const) {
    lengthSelect.append(el('option', { value, textContent: t(key) }))
  }
  lengthSelect.value = 'medium'
  const tourCheck = el('input', { type: 'checkbox', id: 'blog-include-tour' })
  const tourWrap = el('label', { className: 'publisher-blog-check' }, [tourCheck, t('publisher.blog.generate.includeTour')])
  const genStatus = el('span', { className: 'publisher-blog-status' })
  genStatus.setAttribute('role', 'status')
  // Appears after a generate-with-tour: the companion tour is a draft
  // on the Tours tab; this deep-links its authoring dock, where
  // "Preview from start" plays it without publishing anything.
  const genTourLink = el('a', {
    className: 'publisher-blog-tour-link',
    textContent: t('publisher.blog.generate.previewTour'),
  })
  genTourLink.target = '_blank'
  genTourLink.rel = 'noopener'
  // The link mirrors `companionTourId` at all times — it represents
  // the post's PERSISTED tour linkage (saved with the post), not the
  // last generate attempt. A failed regenerate, or a regenerate
  // without the tour box, leaves the existing linkage (and so the
  // link) in place.
  const refreshTourLink = (): void => {
    if (companionTourId) {
      genTourLink.href = `/?tourEdit=${encodeURIComponent(companionTourId)}`
      genTourLink.hidden = false
    } else {
      genTourLink.hidden = true
    }
  }
  refreshTourLink()
  const genBtn = el('button', {
    type: 'button', className: 'publisher-button publisher-button-primary publisher-blog-generate-btn',
    textContent: t('publisher.blog.generate.run'),
  })
  genBtn.addEventListener('click', () => {
    if (selected.size === 0) {
      setStatus(genStatus, t('publisher.blog.generate.needDatasets'), true)
      return
    }
    genBtn.disabled = true
    setStatus(genStatus, t('publisher.blog.generate.working'), false)
    void publisherSend<{ draft: { title: string; summary: string; bodyMd: string }; tour: { id: string } | null; tourError: string | null }>(
      GENERATE_ENDPOINT,
      {
        datasetIds: [...selected.keys()],
        ...(citedEventId ? { eventId: citedEventId } : {}),
        ...(toneInput.value.trim() ? { tone: toneInput.value.trim() } : {}),
        length: lengthSelect.value,
        includeTour: tourCheck.checked,
      },
      { method: 'POST', fetchFn },
    )
      .then(res => {
        if (!res.ok) {
          handleWriteError(res, genStatus, options.navigate)
          return
        }
        titleInput.value = res.data.draft.title
        summaryInput.value = res.data.draft.summary
        bodyInput.value = res.data.draft.bodyMd
        // Keep an open Preview pane in sync with the drafted body.
        if (!preview.hidden) renderPreview()
        if (res.data.tour) {
          companionTourId = res.data.tour.id
          setStatus(genStatus, t('publisher.blog.generate.doneWithTour'), false)
        } else if (res.data.tourError) {
          setStatus(genStatus, t('publisher.blog.generate.doneTourFailed', { reason: res.data.tourError }), false)
        } else {
          setStatus(genStatus, t('publisher.blog.generate.done'), false)
        }
        refreshTourLink()
      })
      .catch(() => setStatus(genStatus, t('publisher.blog.error.generic'), true))
      .finally(() => {
        genBtn.disabled = false
      })
  })

  // ----- Media tab: suggested imagery + cover picker -----
  // Insert markdown at the body cursor, on its own line, keeping any
  // open Preview in sync. Reuses the same textarea the toolbar drives.
  const insertIntoBody = (markdown: string): void => {
    const ta = bodyInput
    const start = ta.selectionStart ?? ta.value.length
    const end = ta.selectionEnd ?? start
    const before = ta.value.slice(0, start)
    const needsLead = before.length > 0 && !before.endsWith('\n')
    ta.setRangeText((needsLead ? '\n\n' : '') + markdown + '\n', start, end, 'end')
    ta.focus()
    if (!preview.hidden) renderPreview()
  }

  // Source label for a suggestion badge — reuses the Events-tab strings
  // (they name the media SOURCE, not anything event-specific).
  const mediaBadge = (kind: MediaSuggestion['kind']): string => {
    switch (kind) {
      case 'commons': return t('publisher.events.suggest.commons')
      case 'shakemap': return t('publisher.events.suggest.shakemap')
      case 'nhc': return t('publisher.events.suggest.nhc')
      case 'youtube': return t('publisher.events.suggest.youtube')
      case 'worldview': return t('publisher.events.suggest.worldview')
    }
  }

  const coverPreview = el('div', { className: 'publisher-blog-cover' })
  const renderCover = (): void => {
    coverPreview.replaceChildren()
    if (!coverImageUrl) {
      coverPreview.append(el('p', { className: 'publisher-blog-picker-hint', textContent: t('publisher.blog.media.noCover') }))
      return
    }
    const fig = el('figure', { className: 'publisher-blog-cover-figure' })
    const img = document.createElement('img')
    img.className = 'publisher-blog-cover-img'
    img.src = coverImageUrl
    img.alt = coverImageAlt ?? ''
    img.loading = 'lazy'
    const remove = el('button', {
      type: 'button', className: 'publisher-button publisher-button-small publisher-button-danger',
      textContent: t('publisher.blog.media.removeCover'),
    })
    remove.addEventListener('click', () => {
      coverImageUrl = null
      coverImageAlt = null
      renderCover()
    })
    fig.append(img, remove)
    coverPreview.append(fig)
  }

  const mediaGrid = el('div', { className: 'publisher-blog-media-grid' })
  // Explains, per source, why a suggestion didn't appear — a missing
  // date/location prerequisite, or an empty result — so a sparse grid
  // reads as "nothing matched" rather than "broken".
  const mediaNotes = el('div', { className: 'publisher-blog-media-notes' })
  // A suggestion card: preview + provenance + "Insert into post" and
  // (image sources only) "Set as cover". The agency-YouTube card is a
  // video — it inserts a linked thumbnail, never a cover.
  const mediaCard = (s: MediaSuggestion, badge: string): HTMLElement => {
    const isVideo = s.kind === 'youtube' && typeof s.embedUrl === 'string'
    const altText = s.title ?? badge
    const wrap = el('div', { className: 'publisher-blog-media-card' })
    const img = document.createElement('img')
    img.className = 'publisher-blog-media-preview'
    img.src = s.url
    img.alt = altText
    img.loading = 'lazy'
    // A candidate whose preview 404s removes itself (same as the Events tab).
    img.addEventListener('error', () => wrap.remove())
    wrap.append(img)
    wrap.append(
      el('div', { className: 'publisher-blog-media-meta' }, [
        el('span', { className: 'publisher-blog-media-badge', textContent: badge }),
        el('span', { className: 'publisher-blog-media-attribution', textContent: s.attribution }),
      ]),
    )
    const actions = el('div', { className: 'publisher-blog-media-actions' })
    const insertBtn = el('button', {
      type: 'button', className: 'publisher-button publisher-button-small',
      textContent: t('publisher.blog.media.insert'),
    })
    insertBtn.addEventListener('click', () => {
      insertIntoBody(
        isVideo && s.embedUrl ? `[![${altText}](${s.url})](${s.embedUrl})` : `![${altText}](${s.url})`,
      )
    })
    actions.append(insertBtn)
    if (!isVideo) {
      const coverBtn = el('button', {
        type: 'button', className: 'publisher-button publisher-button-small publisher-button-primary',
        textContent: t('publisher.blog.media.setCover'),
      })
      coverBtn.addEventListener('click', () => {
        coverImageUrl = s.url
        coverImageAlt = altText
        renderCover()
      })
      actions.append(coverBtn)
    }
    wrap.append(actions)
    return wrap
  }

  // Rebuild the suggestion grid for the currently-cited event. Cheap
  // sources render synchronously; the fetched ones append as they
  // resolve, each guarded by a token so a stale in-flight fetch (the
  // curator changed the cited event meanwhile) can't append into a
  // grid that has moved on.
  let mediaRenderedFor: string | null | undefined = undefined
  let mediaToken = 0
  const rebuildMedia = (): void => {
    const token = ++mediaToken
    mediaRenderedFor = citedEventId
    const rawEv = citedEventId ? events.find(e => e.id === citedEventId) ?? null : null
    // Resolve a region name to a bbox so named-region events light up the
    // geo-gated sources just like explicitly-boxed ones.
    const ev = rawEv ? withResolvedGeometry(rawEv) : null
    mediaGrid.replaceChildren()
    mediaNotes.replaceChildren()
    if (!ev) {
      mediaGrid.append(el('p', { className: 'publisher-blog-picker-hint', textContent: t('publisher.blog.media.needEvent') }))
      return
    }
    const append = (s: MediaSuggestion, badge: string): void => {
      if (token === mediaToken) mediaGrid.append(mediaCard(s, badge))
    }

    // Per-source "why it didn't show" reasons. Each source owns one key
    // so a late async result can clear or set its own line; the block
    // re-renders (token-guarded) whenever the set changes.
    const reasons = new Map<string, string>()
    const renderNotes = (): void => {
      if (token !== mediaToken) return
      mediaNotes.replaceChildren()
      if (reasons.size === 0) return
      mediaNotes.append(el('p', { className: 'publisher-blog-media-note-label', textContent: t('publisher.blog.media.notShownLabel') }))
      const list = el('ul', { className: 'publisher-blog-media-note-list' })
      for (const msg of reasons.values()) list.append(el('li', { textContent: msg }))
      mediaNotes.append(list)
    }
    const setReason = (key: string, msg: string): void => {
      if (token !== mediaToken) return
      reasons.set(key, msg)
      renderNotes()
    }

    const hasLocation = Boolean(ev.geometry?.boundingBox ?? ev.geometry?.point)
    const hasDate = Boolean(ev.occurredStart ?? ev.source.publishedAt)
    const ff = fetchFn ?? fetch
    // A region NAME that didn't resolve to a box (it survived
    // withResolvedGeometry with no bbox/point) — name the culprit so the
    // curator knows the stored region isn't recognized, rather than
    // seeing a generic "add a location" for a place that looks set.
    const unresolvedRegion = !hasLocation ? (rawEv?.geometry?.regionName ?? null) : null
    const noLocationHint = unresolvedRegion
      ? t('publisher.blog.media.hintUnknownRegion', { region: unresolvedRegion })
      : t('publisher.blog.media.hintNeedsLocation')

    // The event's own vetted story image (the feed's enclosure / og:image
    // / a prior curator pick) — the most on-topic candidate when present.
    if (ev.imageUrl && /^https?:\/\//i.test(ev.imageUrl)) {
      append(
        { kind: 'commons', url: ev.imageUrl, attribution: ev.source.name, title: ev.imageAlt ?? ev.title },
        t('publisher.blog.media.eventImage'),
      )
    }

    // A missing/unrecognized location blocks both the satellite view and
    // nearby photos — surface it once (naming the culprit region when the
    // event has one) rather than repeating it per source.
    if (!hasLocation) reasons.set('location', noLocationHint)

    // Satellite view — needs both a date and a location.
    const worldview = buildWorldviewSnapshot(ev)
    if (worldview) append(worldview, mediaBadge('worldview'))
    else if (!hasDate) reasons.set('worldview', t('publisher.blog.media.hintNeedsDate'))

    // Nearby photos — need a location; empty when nothing public-domain
    // is near the point.
    if (hasLocation) {
      void fetchCommonsSuggestions(ev, ff).then(rs => {
        if (token !== mediaToken) return
        if (rs.length) for (const r of rs) append(r, mediaBadge(r.kind))
        else setReason('commons', t('publisher.blog.media.commonsEmpty'))
      })
    }

    // Hazard maps — only relevant to their event type; the note only
    // appears when the event reads like that hazard but nothing matched.
    if (looksLikeQuake(ev)) {
      void fetchShakemapSuggestion(ev, ff).then(r => {
        if (token !== mediaToken) return
        if (r) append(r, mediaBadge(r.kind))
        else setReason('shakemap', t('publisher.blog.media.shakemapEmpty'))
      })
    }
    if (looksLikeTropical(ev)) {
      void fetchNhcConeSuggestion(ev, ff).then(r => {
        if (token !== mediaToken) return
        if (r) append(r, mediaBadge(r.kind))
        else setReason('nhc', t('publisher.blog.media.nhcEmpty'))
      })
    }

    // Agency video — key-gated + allowlist-matched; empty is common.
    void fetchYoutubeSuggestions(ev, ff).then(rs => {
      if (token !== mediaToken) return
      if (rs.length) for (const r of rs) append(r, mediaBadge(r.kind))
      else setReason('youtube', t('publisher.blog.media.youtubeEmpty'))
    })

    renderNotes()
  }

  // Re-pull the approved-events list so the Media tab reflects edits the
  // curator made in the Events tab (a location or date attached after
  // this editor loaded) — otherwise the suggestions seed off the stale
  // mount-time snapshot and geo/date-gated sources never appear. Fires
  // on each Media-tab open when an event is cited; single-flight.
  let refreshingEvents = false
  const refreshEventsForMedia = (): void => {
    if (refreshingEvents) return
    refreshingEvents = true
    void publisherGet<{ events: ReviewEvent[] }>(EVENTS_ENDPOINT, { fetchFn })
      .then(res => {
        if (res.ok) {
          events = res.data.events
          renderEventOptions()
        }
      })
      .finally(() => {
        refreshingEvents = false
        // Rebuild against the freshest event data (or leave the instant
        // snapshot render in place if the refresh failed).
        rebuildMedia()
      })
  }

  // ----- Save / publish actions -----
  const saveStatus = el('span', { className: 'publisher-blog-status' })
  saveStatus.setAttribute('role', 'status')
  const saveBtn = el('button', {
    type: 'button', className: 'publisher-button publisher-button-primary publisher-blog-save-btn',
    textContent: t('publisher.blog.save'),
  })
  const publishBtn = el('button', {
    type: 'button', className: 'publisher-button publisher-blog-publish-btn',
  })
  const refreshPublishBtn = (): void => {
    publishBtn.textContent = postStatus === 'published' ? t('publisher.blog.unpublish') : t('publisher.blog.publish')
    publishBtn.hidden = postId === null
  }
  refreshPublishBtn()

  const composeBody = () => ({
    title: titleInput.value.trim(),
    summary: summaryInput.value.trim() || null,
    bodyMd: bodyInput.value,
    datasetIds: [...selected.keys()],
    eventId: citedEventId,
    tourId: companionTourId,
    coverImageUrl,
    coverImageAlt,
  })

  saveBtn.addEventListener('click', () => {
    if (!titleInput.value.trim() || !bodyInput.value.trim()) {
      setStatus(saveStatus, t('publisher.blog.error.required'), true)
      return
    }
    saveBtn.disabled = true
    setStatus(saveStatus, '', false)
    const req = postId
      ? publisherSend<{ post: PostWire }>(`${BLOG_ENDPOINT}/${encodeURIComponent(postId)}`, composeBody(), { method: 'PUT', fetchFn })
      : publisherSend<{ post: PostWire }>(BLOG_ENDPOINT, composeBody(), { method: 'POST', fetchFn })
    void req
      .then(res => {
        if (!res.ok) {
          handleWriteError(res, saveStatus, options.navigate)
          return
        }
        const wasNew = postId === null
        postId = res.data.post.id
        postStatus = res.data.post.status
        refreshPublishBtn()
        setStatus(saveStatus, t('publisher.blog.saved'), false)
        if (wasNew) navigate(`/publish/blog/${encodeURIComponent(postId)}/edit`)
      })
      .finally(() => {
        saveBtn.disabled = false
      })
  })

  publishBtn.addEventListener('click', () => {
    if (!postId) return
    publishBtn.disabled = true
    const action = postStatus === 'published' ? 'unpublish' : 'publish'
    void publisherSend<{ post: PostWire }>(
      `${BLOG_ENDPOINT}/${encodeURIComponent(postId)}`,
      { action },
      { method: 'POST', fetchFn },
    )
      .then(res => {
        if (!res.ok) {
          handleWriteError(res, saveStatus, options.navigate)
          return
        }
        postStatus = res.data.post.status
        refreshPublishBtn()
        setStatus(
          saveStatus,
          postStatus === 'published'
            ? t('publisher.blog.published', { slug: res.data.post.slug })
            : t('publisher.blog.unpublished'),
          false,
        )
      })
      .finally(() => {
        publishBtn.disabled = false
      })
  })

  // ----- Layout: tabbed stepper (left-rail nav + one section shown) —
  // mirrors the dataset form so the editor isn't one long page. -----
  const bodyField = el('div', { className: 'publisher-blog-field' })
  const bodyLabelRow = el('div', { className: 'publisher-form-label-row' }, [
    el('span', { className: 'publisher-field-label', textContent: t('publisher.blog.field.body') }),
    previewToggle,
  ])
  bodyField.append(bodyLabelRow, toolbar, bodyInput, preview)

  // Section 1 — Content: the post itself (title, summary, body).
  const contentCard = card(
    el('h2', { className: 'publisher-card-heading', textContent: t('publisher.blog.tab.content') }),
    labelled(t('publisher.blog.field.title'), titleInput),
    labelled(t('publisher.blog.field.summary'), summaryInput),
    bodyField,
  )
  // Section 2 — Sources: the datasets + event the post is grounded in.
  const sourcesCard = card(
    el('h2', { className: 'publisher-card-heading', textContent: t('publisher.blog.tab.sources') }),
    el('p', { className: 'publisher-blog-intro', textContent: t('publisher.blog.grounding.intro') }),
    labelled(t('publisher.blog.picker.label'), dsSearch),
    dsCandidates,
    chips,
    labelled(t('publisher.blog.event.label'), evSelect),
  )
  // Section 3 — Media: suggested imagery for the cited event, plus the
  // post's cover-image picker.
  const mediaCardSection = card(
    el('h2', { className: 'publisher-card-heading', textContent: t('publisher.blog.tab.media') }),
    el('p', { className: 'publisher-blog-intro', textContent: t('publisher.blog.media.intro') }),
    el('h3', { className: 'publisher-blog-subheading', textContent: t('publisher.blog.media.coverLabel') }),
    coverPreview,
    el('h3', { className: 'publisher-blog-subheading', textContent: t('publisher.blog.media.suggestionsLabel') }),
    mediaGrid,
    mediaNotes,
  )
  // Section 4 — AI draft: generate the body from the sources.
  const aiCard = card(
    el('h2', { className: 'publisher-card-heading', textContent: t('publisher.blog.tab.aiDraft') }),
    el('p', { className: 'publisher-blog-intro', textContent: t('publisher.blog.generate.intro') }),
    labelled(t('publisher.blog.generate.tone'), toneInput),
    labelled(t('publisher.blog.generate.length'), lengthSelect),
    tourWrap,
    el('div', { className: 'publisher-blog-actions' }, [genBtn]),
    genStatus,
    genTourLink,
  )

  const SECTIONS: ReadonlyArray<{
    id: string
    labelKey:
      | 'publisher.blog.tab.content'
      | 'publisher.blog.tab.sources'
      | 'publisher.blog.tab.media'
      | 'publisher.blog.tab.aiDraft'
    card: HTMLElement
  }> = [
    { id: 'blog-content', labelKey: 'publisher.blog.tab.content', card: contentCard },
    { id: 'blog-sources', labelKey: 'publisher.blog.tab.sources', card: sourcesCard },
    { id: 'blog-media', labelKey: 'publisher.blog.tab.media', card: mediaCardSection },
    { id: 'blog-aidraft', labelKey: 'publisher.blog.tab.aiDraft', card: aiCard },
  ]
  const navLinks = new Map<string, HTMLButtonElement>()
  // Toggle visibility in place (no re-render) so field state, an
  // in-flight generate, and the open Preview all survive a tab switch.
  const showSection = (id: string): void => {
    if (id === 'blog-media') {
      // Render instantly from the current snapshot when the cited event
      // changed since the last build (fetched sources aren't re-hit on an
      // unchanged revisit)…
      if (mediaRenderedFor !== citedEventId) rebuildMedia()
      // …then, when an event is cited, re-pull the events list so edits
      // made in the Events tab (a location/date attached after this
      // editor loaded) flow in and rebuild against the fresh data.
      if (citedEventId) refreshEventsForMedia()
    }
    for (const s of SECTIONS) s.card.style.display = s.id === id ? '' : 'none'
    for (const [sid, btn] of navLinks) {
      const on = sid === id
      btn.className = on
        ? 'publisher-form-nav-link publisher-form-nav-link-active'
        : 'publisher-form-nav-link'
      if (on) btn.setAttribute('aria-current', 'step')
      else btn.removeAttribute('aria-current')
    }
  }
  const nav = el('nav', { className: 'publisher-form-nav' })
  nav.setAttribute('aria-label', t('publisher.blog.editor.navAria'))
  for (const s of SECTIONS) {
    s.card.classList.add('publisher-form-card')
    s.card.dataset.section = s.id
    const btn = el('button', {
      type: 'button',
      className: 'publisher-form-nav-link',
      textContent: t(s.labelKey),
    })
    btn.dataset.section = s.id
    btn.addEventListener('click', () => showSection(s.id))
    navLinks.set(s.id, btn)
    nav.append(btn)
  }

  // Page header: back link + title on the start side; Save / Publish on
  // the end side so they're reachable from any tab.
  const back = el('a', {
    className: 'publisher-back-link',
    href: '/publish/blog',
    textContent: `← ${t('publisher.blog.editor.back')}`,
  })
  back.addEventListener('click', e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate('/publish/blog')
  })
  const headerMain = el('div', { className: 'publisher-dataset-form-header-main' }, [
    back,
    el('h1', {
      className: 'publisher-detail-title',
      textContent: existing
        ? t('publisher.blog.editor.headingEdit')
        : t('publisher.blog.editor.headingNew'),
    }),
  ])
  const header = el('header', { className: 'publisher-dataset-form-header' }, [
    headerMain,
    el('div', { className: 'publisher-detail-actions' }, [saveBtn, publishBtn, saveStatus]),
  ])

  const rail = el('aside', { className: 'publisher-dataset-form-rail' }, [nav])
  const formCol = el('div', { className: 'publisher-form' }, [contentCard, sourcesCard, mediaCardSection, aiCard])
  const layout = el('div', { className: 'publisher-dataset-form-layout' }, [rail, formCol])

  mount.replaceChildren(
    el('main', { className: 'publisher-shell publisher-dataset-form' }, [header, layout]),
  )
  showSection('blog-content')
  renderChips()
  renderEventOptions()
  renderCover()

  // ----- Lazy loads: the catalog for the picker + the events list -----
  void loadPublishedDatasets(fetchFn, options.navigate).then(list => {
    if (list === null) return
    catalog = list
    dsSearch.disabled = false
    // Editing an existing post: resolve its dataset ids to chips.
    if (existing) {
      for (const id of existing.datasetIds) {
        const hit = list.find(d => d.id === id)
        selected.set(id, hit?.title ?? id)
      }
      renderChips()
    }
  })
  void publisherGet<{ events: ReviewEvent[] }>(EVENTS_ENDPOINT, { fetchFn }).then(res => {
    if (!res.ok) {
      // Mirror loadPublishedDatasets: route a session error through the
      // shared recovery flow; other failures leave the picker disabled.
      if (res.kind === 'session') handleSessionError({ navigate: options.navigate })
      return
    }
    // Keep the full ReviewEvent objects — the Media tab seeds its
    // suggestion engine off each event's geometry / date / keywords.
    events = res.data.events
    evSelect.disabled = false
    renderEventOptions()
    // If the Media tab was opened before the events arrived, its grid
    // is showing the "cite an event" hint against a not-yet-loaded
    // event; refresh it now that the cited event can resolve.
    if (mediaRenderedFor !== undefined && mediaRenderedFor === citedEventId && citedEventId) rebuildMedia()
  })
}
