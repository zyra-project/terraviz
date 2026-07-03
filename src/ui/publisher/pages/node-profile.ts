/**
 * /publish/node-profile — edit the node / host-organization profile
 * (Phase 3d; the "about the host" context AI-generated drafts ground
 * themselves in, reusable later for an about page or footer
 * attribution).
 *
 * Privileged-only (admin / service) — the API enforces 403 on writes;
 * gating here avoids a fill-then-reject round-trip. Renders a single
 * form (org name, mission, about markdown, region focus, default
 * tone, outbound links) backed by `GET`/`PUT
 * /api/v1/publish/node-profile`. Mirrors `featured-hero.ts`.
 */

import { t } from '../../../i18n'
import { publisherGet, publisherSend, handleSessionError } from '../api'
import { buildErrorCard } from '../components/error-card'
import { attachToolbar, renderMarkdownToolbar } from '../components/markdown-toolbar'
import { renderMarkdown } from '../../../services/markdownRenderer'

/** Keep in sync with the backend store bounds
 *  (`functions/api/v1/_lib/node-profile-store.ts`). The API is the
 *  hard cap; these just stop the inputs early. */
const ORG_NAME_MAX_LEN = 200
const MISSION_MAX_LEN = 1_000
const ABOUT_MAX_LEN = 10_000
const REGION_MAX_LEN = 200
const TONE_MAX_LEN = 200
const MAX_LINKS = 10

interface MeResponse {
  role: string
  is_admin: boolean
}

interface ProfileLink {
  label: string
  url: string
}

interface ProfileResponse {
  profile: {
    orgName: string
    mission: string | null
    aboutMd: string | null
    regionFocus: string | null
    defaultTone: string | null
    links: ProfileLink[]
    logoUrl: string | null
  } | null
}

const ME_ENDPOINT = '/api/v1/publish/me'
const PROFILE_ENDPOINT = '/api/v1/publish/node-profile'
const LOGO_ENDPOINT = '/api/v1/publish/node-profile/logo'

/** Keep in sync with `LOGO_MAX_BYTES` / `LOGO_CONTENT_TYPES` in the
 *  backend store — the API is the hard cap; these stop bad picks
 *  before a wasted round-trip. */
const LOGO_MAX_BYTES = 512 * 1024
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp']

export interface NodeProfilePageOptions {
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

export async function renderNodeProfilePage(
  mount: HTMLElement,
  options: NodeProfilePageOptions = {},
): Promise<void> {
  const fetchFn = options.fetchFn
  mount.replaceChildren(shell(el('p', { className: 'publisher-loading', textContent: t('publisher.nodeProfile.loading') })))

  const [meRes, profileRes] = await Promise.all([
    publisherGet<MeResponse>(ME_ENDPOINT, { fetchFn }),
    publisherGet<ProfileResponse>(PROFILE_ENDPOINT, { fetchFn }),
  ])

  for (const res of [meRes, profileRes]) {
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
  if (!meRes.ok || !profileRes.ok) return

  if (!clientIsPrivileged(meRes.data)) {
    mount.replaceChildren(
      shell(
        card(
          heading(t('publisher.nodeProfile.title')),
          el('p', { className: 'publisher-nodeprofile-restricted', textContent: t('publisher.nodeProfile.restricted') }),
        ),
      ),
    )
    return
  }

  renderForm(mount, {
    profile: profileRes.data.profile,
    fetchFn,
    navigate: options.navigate,
  })
}

function shell(...children: HTMLElement[]): HTMLElement {
  const m = el('main', { className: 'publisher-shell' })
  for (const c of children) m.append(c)
  return m
}

interface FormState {
  profile: ProfileResponse['profile']
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
}

function renderForm(mount: HTMLElement, state: FormState): void {
  const { profile } = state

  const orgName = el('input', {
    type: 'text',
    className: 'publisher-nodeprofile-input',
    id: 'nodeprofile-org',
    maxLength: ORG_NAME_MAX_LEN,
    value: profile?.orgName ?? '',
  })
  const mission = el('textarea', {
    className: 'publisher-nodeprofile-textarea',
    id: 'nodeprofile-mission',
    rows: 3,
    maxLength: MISSION_MAX_LEN,
    value: profile?.mission ?? '',
  })
  const about = el('textarea', {
    className: 'publisher-nodeprofile-textarea',
    id: 'nodeprofile-about',
    rows: 8,
    maxLength: ABOUT_MAX_LEN,
    value: profile?.aboutMd ?? '',
  })
  // GitHub-issue-style markdown helpers on the About field — the same
  // toolbar + Edit/Preview toggle the dataset abstract uses. The
  // preview renders through the shared sanitized markdown pipeline.
  const aboutToolbar = renderMarkdownToolbar()
  attachToolbar(aboutToolbar, about, { onChange: () => {} })
  const aboutPreview = el('div', { className: 'publisher-form-markdown-preview' })
  aboutPreview.hidden = true
  const aboutToggle = el('button', {
    type: 'button',
    className: 'publisher-form-toggle',
    textContent: t('publisher.datasetForm.action.preview'),
  })
  aboutToggle.addEventListener('click', () => {
    const showPreview = aboutPreview.hidden
    aboutPreview.hidden = !showPreview
    about.hidden = showPreview
    aboutToolbar.hidden = showPreview
    aboutToggle.textContent = showPreview
      ? t('publisher.datasetForm.action.edit')
      : t('publisher.datasetForm.action.preview')
    if (!showPreview) return
    if (about.value.trim().length === 0) {
      aboutPreview.replaceChildren(
        el('p', { className: 'publisher-form-markdown-empty', textContent: t('publisher.datasetForm.preview.empty') }),
      )
      return
    }
    // renderMarkdown runs `marked` then sanitizeMarkdownHtml — safe to
    // set as innerHTML (XSS-tested in markdownRenderer.test.ts).
    aboutPreview.innerHTML = renderMarkdown(about.value)
  })

  const region = el('input', {
    type: 'text',
    className: 'publisher-nodeprofile-input',
    id: 'nodeprofile-region',
    maxLength: REGION_MAX_LEN,
    value: profile?.regionFocus ?? '',
  })
  const tone = el('input', {
    type: 'text',
    className: 'publisher-nodeprofile-input',
    id: 'nodeprofile-tone',
    maxLength: TONE_MAX_LEN,
    value: profile?.defaultTone ?? '',
  })

  // ----- Links: a small dynamic list of {label, url} rows -----
  const linkRows = el('div', { className: 'publisher-nodeprofile-links' })
  const addLinkRow = (link?: ProfileLink): void => {
    if (linkRows.children.length >= MAX_LINKS) return
    const label = el('input', {
      type: 'text',
      className: 'publisher-nodeprofile-input publisher-nodeprofile-link-label',
      placeholder: t('publisher.nodeProfile.links.labelPlaceholder'),
      ariaLabel: t('publisher.nodeProfile.links.labelPlaceholder'),
      value: link?.label ?? '',
    })
    const url = el('input', {
      type: 'url',
      className: 'publisher-nodeprofile-input publisher-nodeprofile-link-url',
      placeholder: 'https://', // i18n-exempt: URL scheme hint, not prose
      ariaLabel: t('publisher.nodeProfile.links.urlPlaceholder'),
      value: link?.url ?? '',
    })
    const remove = el('button', {
      type: 'button',
      className: 'publisher-events-icon-btn publisher-events-icon-btn-reject',
      textContent: '✕', // i18n-exempt: glyph; the aria-label below carries the meaning
    })
    remove.setAttribute('aria-label', t('publisher.nodeProfile.links.removeAria'))
    const row = el('div', { className: 'publisher-nodeprofile-link-row' }, [label, url, remove])
    remove.addEventListener('click', () => row.remove())
    linkRows.append(row)
  }
  for (const link of profile?.links ?? []) addLinkRow(link)
  const addLink = el('button', {
    type: 'button',
    className: 'publisher-btn publisher-btn-small',
    textContent: t('publisher.nodeProfile.links.add'),
  })
  addLink.addEventListener('click', () => addLinkRow())

  const collectLinks = (): ProfileLink[] => {
    const out: ProfileLink[] = []
    for (const row of Array.from(linkRows.children)) {
      const label = (row.querySelector('.publisher-nodeprofile-link-label') as HTMLInputElement).value.trim()
      const url = (row.querySelector('.publisher-nodeprofile-link-url') as HTMLInputElement).value.trim()
      if (label || url) out.push({ label, url })
    }
    return out
  }

  // ----- Save -----
  const status = el('div', { className: 'publisher-nodeprofile-status', role: 'status' })
  const saveBtn = el('button', {
    type: 'button',
    className: 'publisher-btn publisher-btn-primary',
    textContent: t('publisher.nodeProfile.save'),
  })
  saveBtn.addEventListener('click', () => {
    status.textContent = ''
    status.classList.remove('publisher-nodeprofile-status-error')
    const name = orgName.value.trim()
    if (!name) {
      status.textContent = t('publisher.nodeProfile.error.orgName')
      status.classList.add('publisher-nodeprofile-status-error')
      return
    }
    const body = {
      orgName: name,
      mission: mission.value.trim() || null,
      aboutMd: about.value.trim() || null,
      regionFocus: region.value.trim() || null,
      defaultTone: tone.value.trim() || null,
      links: collectLinks(),
    }
    saveBtn.disabled = true
    void publisherSend<ProfileResponse>(PROFILE_ENDPOINT, body, { method: 'PUT', fetchFn: state.fetchFn })
      .then(res => {
        if (res.ok) {
          status.textContent = t('publisher.nodeProfile.saved')
          return
        }
        if (res.kind === 'session') {
          if (handleSessionError({ navigate: state.navigate }) === 'navigating') return
          status.textContent = t('publisher.nodeProfile.error.session')
        } else if (res.kind === 'validation' && res.errors && res.errors.length > 0) {
          status.textContent = res.errors[0].message
        } else {
          status.textContent = t('publisher.nodeProfile.error.generic')
        }
        status.classList.add('publisher-nodeprofile-status-error')
      })
      .finally(() => {
        saveBtn.disabled = false
      })
  })

  const form = card(
    heading(t('publisher.nodeProfile.title')),
    el('p', { className: 'publisher-nodeprofile-intro', textContent: t('publisher.nodeProfile.intro') }),
    labelled(t('publisher.nodeProfile.orgName'), orgName),
    labelled(t('publisher.nodeProfile.mission'), mission),
    aboutField(t('publisher.nodeProfile.aboutMd'), aboutToggle, aboutToolbar, about, aboutPreview),
    labelled(t('publisher.nodeProfile.regionFocus'), region),
    labelled(t('publisher.nodeProfile.defaultTone'), tone),
    el('div', { className: 'publisher-nodeprofile-links-wrap' }, [
      el('span', { className: 'publisher-field-label', textContent: t('publisher.nodeProfile.links') }),
      linkRows,
      addLink,
    ]),
    el('div', { className: 'publisher-nodeprofile-actions' }, [saveBtn]),
    status,
  )
  mount.replaceChildren(shell(form, renderLogoCard(state)))
}

/**
 * The logo card — preview, upload (base64-in-JSON to the dedicated
 * logo route), and remove. Uploading requires a saved profile; the
 * API enforces that, and the card surfaces its field error verbatim.
 */
function renderLogoCard(state: FormState): HTMLElement {
  // Normalize once at the boundary: anything non-http(s) is treated
  // as "no logo" everywhere (preview AND the Remove button), so the
  // two can't disagree about whether a logo exists.
  const httpUrl = (u: string | null | undefined): string | null =>
    u && /^https?:\/\//i.test(u) ? u : null
  let logoUrl = httpUrl(state.profile?.logoUrl)

  const preview = el('div', { className: 'publisher-nodeprofile-logo-preview' })
  const renderPreview = (): void => {
    preview.replaceChildren(
      logoUrl
        ? el('img', { src: logoUrl, alt: t('publisher.nodeProfile.logo.alt'), className: 'publisher-nodeprofile-logo-img' })
        : el('p', { className: 'publisher-nodeprofile-logo-none', textContent: t('publisher.nodeProfile.logo.none') }),
    )
  }
  renderPreview()

  const status = el('div', { className: 'publisher-nodeprofile-status', role: 'status' })
  const setStatus = (message: string, isError: boolean): void => {
    status.textContent = message
    status.classList.toggle('publisher-nodeprofile-status-error', isError)
  }

  const fileInput = el('input', { type: 'file', className: 'publisher-nodeprofile-logo-file', id: 'nodeprofile-logo-file' })
  fileInput.accept = LOGO_TYPES.join(',')
  fileInput.hidden = true
  const chooseBtn = el('button', {
    type: 'button',
    className: 'publisher-btn publisher-btn-small',
    textContent: t('publisher.nodeProfile.logo.choose'),
  })
  chooseBtn.addEventListener('click', () => fileInput.click())

  const removeBtn = el('button', {
    type: 'button',
    className: 'publisher-btn publisher-btn-small',
    textContent: t('publisher.nodeProfile.logo.remove'),
  })
  const refreshRemove = (): void => {
    removeBtn.hidden = logoUrl === null
  }
  refreshRemove()

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    fileInput.value = ''
    if (!file) return
    if (!LOGO_TYPES.includes(file.type)) {
      setStatus(t('publisher.nodeProfile.logo.error.type'), true)
      return
    }
    if (file.size > LOGO_MAX_BYTES) {
      setStatus(t('publisher.nodeProfile.logo.error.size'), true)
      return
    }
    chooseBtn.disabled = true
    setStatus(t('publisher.nodeProfile.logo.uploading'), false)
    void file
      .arrayBuffer()
      .then(buf => {
        // Chunked btoa — String.fromCharCode(...allBytes) overflows
        // the argument limit on files past ~100 KB.
        const bytes = new Uint8Array(buf)
        let bin = ''
        const CHUNK = 0x8000
        for (let i = 0; i < bytes.length; i += CHUNK) {
          bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
        }
        return publisherSend<{ logoUrl: string | null }>(
          LOGO_ENDPOINT,
          { contentType: file.type, dataBase64: btoa(bin) },
          { method: 'POST', fetchFn: state.fetchFn },
        )
      })
      .then(res => {
        if (res.ok) {
          logoUrl = httpUrl(res.data.logoUrl)
          renderPreview()
          refreshRemove()
          setStatus(t('publisher.nodeProfile.logo.uploaded'), false)
          return
        }
        if (res.kind === 'session') {
          if (handleSessionError({ navigate: state.navigate }) === 'navigating') return
          setStatus(t('publisher.nodeProfile.error.session'), true)
        } else if (res.kind === 'validation' && res.errors && res.errors.length > 0) {
          setStatus(res.errors[0].message, true)
        } else {
          setStatus(t('publisher.nodeProfile.error.generic'), true)
        }
      })
      .catch(() => setStatus(t('publisher.nodeProfile.error.generic'), true))
      .finally(() => {
        chooseBtn.disabled = false
      })
  })

  removeBtn.addEventListener('click', () => {
    removeBtn.disabled = true
    void publisherSend<{ logoUrl: string | null }>(LOGO_ENDPOINT, {}, { method: 'DELETE', fetchFn: state.fetchFn })
      .then(res => {
        if (res.ok) {
          logoUrl = null
          renderPreview()
          refreshRemove()
          setStatus(t('publisher.nodeProfile.logo.removed'), false)
          return
        }
        if (res.kind === 'session') {
          if (handleSessionError({ navigate: state.navigate }) === 'navigating') return
          setStatus(t('publisher.nodeProfile.error.session'), true)
        } else {
          setStatus(t('publisher.nodeProfile.error.generic'), true)
        }
      })
      .finally(() => {
        removeBtn.disabled = false
      })
  })

  return card(
    heading(t('publisher.nodeProfile.logo.label')),
    el('p', { className: 'publisher-nodeprofile-intro', textContent: t('publisher.nodeProfile.logo.hint') }),
    preview,
    el('div', { className: 'publisher-nodeprofile-actions' }, [chooseBtn, removeBtn, fileInput]),
    status,
  )
}

// ----- Small DOM helpers (mirror the featured-hero.ts idiom) -----

function card(...children: HTMLElement[]): HTMLElement {
  const c = el('section', { className: 'publisher-card publisher-glass' })
  for (const child of children) c.append(child)
  return c
}

function heading(text: string): HTMLElement {
  return el('h2', { className: 'publisher-card-heading', textContent: text })
}

function labelled(label: string, control: HTMLElement): HTMLElement {
  const wrap = el('label', { className: 'publisher-nodeprofile-field' })
  wrap.append(el('span', { className: 'publisher-field-label', textContent: label }))
  wrap.append(control)
  return wrap
}

/** The About field: label + Edit/Preview toggle on one row, then the
 *  markdown toolbar, the textarea, and the (initially hidden) preview.
 *  A `div` rather than `labelled`'s `<label>` wrapper — a button
 *  inside a label would re-trigger itself via label activation. */
function aboutField(
  label: string,
  toggle: HTMLElement,
  toolbar: HTMLElement,
  textarea: HTMLElement,
  preview: HTMLElement,
): HTMLElement {
  const wrap = el('div', { className: 'publisher-nodeprofile-field' })
  const row = el('div', { className: 'publisher-form-label-row' }, [
    el('span', { className: 'publisher-field-label', textContent: label }),
    toggle,
  ])
  wrap.append(row, toolbar, textarea, preview)
  return wrap
}
