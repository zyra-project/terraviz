/**
 * /publish/blog/new + /publish/blog/:id/edit — the blog post editor
 * (Phase 3d; `docs/CURRENT_EVENTS_PLAN.md` §7).
 *
 * Three sections:
 *   1. **Grounding** — pick the datasets the post draws on (the same
 *      catalog search the events tab uses) and optionally cite a
 *      current event; these selections feed both the AI Generate call
 *      and the saved post's citations.
 *   2. **Generate** — tone / length / companion-tour controls around
 *      `POST /api/v1/publish/blog/generate`; a successful draft fills
 *      the content fields (the curator edits from there — nothing is
 *      saved until they say so).
 *   3. **Content** — title, summary, and the markdown body with the
 *      shared toolbar + sanitized Preview.
 *
 * Save creates (`POST /publish/blog`) or updates (`PUT
 * /publish/blog/:id`); Publish / Unpublish are the explicit status
 * transitions. Privileged-gated client-side; the API enforces 403
 * independently.
 */

import { t } from '../../../i18n'
import { publisherGet, publisherSend, handleSessionError } from '../api'
import { buildErrorCard } from '../components/error-card'
import { attachToolbar, renderMarkdownToolbar } from '../components/markdown-toolbar'
import { loadPublishedDatasets, filterDatasetsByTitle } from '../components/events/dataset-search'
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
}

interface ReviewEventLite {
  id: string
  title: string
  /** The event's dataset pairings from the review queue — approved
   *  ones seed the grounding chips when the event is cited. */
  links?: Array<{ datasetId: string; datasetTitle: string; status: string }>
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

export async function renderBlogEditPage(mount: HTMLElement, options: BlogEditPageOptions = {}): Promise<void> {
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
  let events: ReviewEventLite[] = []

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
      selected.set(link.datasetId, link.datasetTitle)
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
    type: 'button', className: 'publisher-btn publisher-btn-primary publisher-blog-generate-btn',
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

  // ----- Save / publish actions -----
  const saveStatus = el('span', { className: 'publisher-blog-status' })
  saveStatus.setAttribute('role', 'status')
  const saveBtn = el('button', {
    type: 'button', className: 'publisher-btn publisher-btn-primary publisher-blog-save-btn',
    textContent: t('publisher.blog.save'),
  })
  const publishBtn = el('button', {
    type: 'button', className: 'publisher-btn publisher-blog-publish-btn',
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

  // ----- Layout -----
  const grounding = card(
    el('h2', { className: 'publisher-card-heading', textContent: t('publisher.blog.grounding.title') }),
    el('p', { className: 'publisher-blog-intro', textContent: t('publisher.blog.grounding.intro') }),
    labelled(t('publisher.blog.picker.label'), dsSearch),
    dsCandidates,
    chips,
    labelled(t('publisher.blog.event.label'), evSelect),
  )
  const generate = card(
    el('h2', { className: 'publisher-card-heading', textContent: t('publisher.blog.generate.title') }),
    labelled(t('publisher.blog.generate.tone'), toneInput),
    labelled(t('publisher.blog.generate.length'), lengthSelect),
    tourWrap,
    el('div', { className: 'publisher-blog-actions' }, [genBtn]),
    genStatus,
    genTourLink,
  )
  const bodyField = el('div', { className: 'publisher-blog-field' })
  const bodyLabelRow = el('div', { className: 'publisher-form-label-row' }, [
    el('span', { className: 'publisher-field-label', textContent: t('publisher.blog.field.body') }),
    previewToggle,
  ])
  bodyField.append(bodyLabelRow, toolbar, bodyInput, preview)
  const content = card(
    el('h2', { className: 'publisher-card-heading', textContent: t('publisher.blog.editor.title') }),
    labelled(t('publisher.blog.field.title'), titleInput),
    labelled(t('publisher.blog.field.summary'), summaryInput),
    bodyField,
    el('div', { className: 'publisher-blog-actions' }, [saveBtn, publishBtn]),
    saveStatus,
  )
  mount.replaceChildren(shell(grounding, generate, content))
  renderChips()
  renderEventOptions()

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
  void publisherGet<{ events: ReviewEventLite[] }>(EVENTS_ENDPOINT, { fetchFn }).then(res => {
    if (!res.ok) {
      // Mirror loadPublishedDatasets: route a session error through the
      // shared recovery flow; other failures leave the picker disabled.
      if (res.kind === 'session') handleSessionError({ navigate: options.navigate })
      return
    }
    events = res.data.events.map(e => ({ id: e.id, title: e.title, links: e.links }))
    evSelect.disabled = false
    renderEventOptions()
  })
}
