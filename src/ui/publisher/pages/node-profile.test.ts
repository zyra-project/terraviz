// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the /publish/node-profile page — form rendering from the
 * stored profile, the privileged gate, and the PUT body the Save
 * button composes (incl. link rows and the splash tagline). The Embedding card's own
 * behaviour is in `components/embedding-card.test.ts`; here, only
 * who sees it and how.
 */

import { describe, it, expect, vi } from 'vitest'
import { FEATURE_KEYS } from '../../../types/node-features'
import { renderNodeProfilePage } from './node-profile'
import { until } from '../../../test-utils'

interface RouteMap {
  [pathPrefix: string]: unknown
}

function mockFetch(routes: RouteMap, capture?: { puts: Array<{ url: string; body: unknown }> }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const method = init?.method ?? 'GET'
    if (method === 'PUT') {
      capture?.puts.push({ url, body: JSON.parse(String(init?.body)) })
      const body = { profile: JSON.parse(String(init?.body)) }
      return { ok: true, status: 200, type: 'basic', json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
    }
    const match = Object.keys(routes).find(k => url.includes(k))
    const body = match ? routes[match] : {}
    return { ok: true, status: 200, type: 'basic', json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
  })
}

const ADMIN_ME = { role: 'admin', is_admin: true }
const PROFILE = {
  profile: {
    orgName: 'Coastal Science Center',
    mission: 'Connect visitors with live ocean data.',
    aboutMd: '## About',
    regionFocus: 'Gulf coast',
    defaultTone: 'educational',
    links: [{ label: 'Website', url: 'https://coastal.example.org' }],
    logoUrl: null,
    tagline: 'Gulf Coast Science',
  },
}

const flush = () => new Promise<void>(r => setTimeout(r, 0))

describe('renderNodeProfilePage', () => {
  it('renders the form pre-filled from the stored profile', async () => {
    const mount = document.createElement('div')
    await renderNodeProfilePage(mount, {
      fetchFn: mockFetch({ '/publish/me': ADMIN_ME, '/publish/node-profile': PROFILE }),
    })
    expect((mount.querySelector('#nodeprofile-org') as HTMLInputElement).value).toBe('Coastal Science Center')
    expect((mount.querySelector('#nodeprofile-mission') as HTMLTextAreaElement).value).toBe('Connect visitors with live ocean data.')
    expect((mount.querySelector('#nodeprofile-tagline') as HTMLInputElement).value).toBe('Gulf Coast Science')
    expect(mount.querySelectorAll('.publisher-nodeprofile-link-row')).toHaveLength(1)
  })

  it('labels the tagline field and names the default it falls back to', async () => {
    const mount = document.createElement('div')
    await renderNodeProfilePage(mount, {
      // An older deploy's profile carries no `tagline` at all.
      fetchFn: mockFetch({
        '/publish/me': ADMIN_ME,
        '/publish/node-profile': { profile: { ...PROFILE.profile, tagline: undefined } },
      }),
    })
    const input = mount.querySelector('#nodeprofile-tagline') as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.maxLength).toBe(80)
    // Named by its label alone; the hint describes it rather than
    // lengthening its name.
    const label = mount.querySelector('label[for="nodeprofile-tagline"]')!
    expect(label.textContent).toBe('Loading screen tagline (optional)')
    expect(input.closest('label')).toBeNull()
    const hint = mount.querySelector(`#${input.getAttribute('aria-describedby')}`)!
    expect(hint.textContent).toContain('up to 80 characters')
    expect(hint.textContent).toContain('“Science On a Sphere”')
  })

  it('cleans a pasted tab or invisible character out of the tagline before saving', async () => {
    const capture = { puts: [] as Array<{ url: string; body: unknown }> }
    const mount = document.createElement('div')
    await renderNodeProfilePage(mount, {
      fetchFn: mockFetch({ '/publish/me': ADMIN_ME, '/publish/node-profile': { profile: null } }, capture),
    })
    ;(mount.querySelector('#nodeprofile-org') as HTMLInputElement).value = 'GSL'
    ;(mount.querySelector('#nodeprofile-tagline') as HTMLInputElement).value = 'Global\tSystems\u200B Laboratory'
    Array.from(mount.querySelectorAll('button')).find(b => b.textContent === 'Save profile')!.click()
    await until(() => capture.puts.length === 1, 'the profile PUT')
    expect((capture.puts[0].body as { tagline: string }).tagline).toBe('Global Systems Laboratory')
    // The field shows what was saved.
    expect((mount.querySelector('#nodeprofile-tagline') as HTMLInputElement).value).toBe('Global Systems Laboratory')
  })

  it('mounts the markdown toolbar on About and Preview renders sanitized markdown', async () => {
    const mount = document.createElement('div')
    await renderNodeProfilePage(mount, {
      fetchFn: mockFetch({ '/publish/me': ADMIN_ME, '/publish/node-profile': PROFILE }),
    })
    // The shared GitHub-issue-style toolbar sits above the textarea.
    expect(mount.querySelector('.publisher-markdown-toolbar')).toBeTruthy()
    // Toggling Preview renders the markdown (## About → <h2>) and
    // hides the editing surfaces; toggling back restores them.
    const toggle = mount.querySelector('.publisher-form-toggle') as HTMLButtonElement
    toggle.click()
    const preview = mount.querySelector('.publisher-form-markdown-preview') as HTMLElement
    expect(preview.hidden).toBe(false)
    expect(preview.querySelector('h2')?.textContent).toBe('About')
    expect((mount.querySelector('#nodeprofile-about') as HTMLElement).hidden).toBe(true)
    toggle.click()
    expect(preview.hidden).toBe(true)
    expect((mount.querySelector('#nodeprofile-about') as HTMLElement).hidden).toBe(false)
  })

  it('shows the restricted card for a non-privileged caller', async () => {
    const mount = document.createElement('div')
    await renderNodeProfilePage(mount, {
      fetchFn: mockFetch({ '/publish/me': { role: 'publisher', is_admin: false }, '/publish/node-profile': { profile: null } }),
    })
    expect(mount.querySelector('.publisher-nodeprofile-restricted')).toBeTruthy()
    expect(mount.querySelector('#nodeprofile-org')).toBeNull()
  })

  it('renders the Features card for an admin, checked from the stored map', async () => {
    const mount = document.createElement('div')
    await renderNodeProfilePage(mount, {
      fetchFn: mockFetch({
        '/publish/me': ADMIN_ME,
        '/publish/node-profile': PROFILE,
        '/publish/node-settings': { features: { blog: false, events: false } },
      }),
    })
    const toggles = mount.querySelectorAll<HTMLInputElement>('.publisher-nodeprofile-feature-toggle')
    expect(toggles).toHaveLength(FEATURE_KEYS.length)
    const byName = new Map(
      Array.from(mount.querySelectorAll('.publisher-nodeprofile-feature-row')).map(row => [
        row.querySelector('.publisher-nodeprofile-feature-name')?.textContent,
        row.querySelector<HTMLInputElement>('.publisher-nodeprofile-feature-toggle')!,
      ]),
    )
    expect(byName.get('Blog')?.checked).toBe(false)
    expect(byName.get('Events')?.checked).toBe(false)
    expect(byName.get('Datasets')?.checked).toBe(true)
  })

  it('hides the Features card for a service caller (profile form still renders)', async () => {
    const mount = document.createElement('div')
    await renderNodeProfilePage(mount, {
      fetchFn: mockFetch({
        '/publish/me': { role: 'service', is_admin: false },
        '/publish/node-profile': PROFILE,
        '/publish/node-settings': { features: {} },
      }),
    })
    expect(mount.querySelector('#nodeprofile-org')).toBeTruthy()
    expect(mount.querySelector('.publisher-nodeprofile-feature-toggle')).toBeNull()
  })

  it('renders the Embedding card for an admin, editable, from the stored policy', async () => {
    const mount = document.createElement('div')
    await renderNodeProfilePage(mount, {
      fetchFn: mockFetch({
        '/publish/me': ADMIN_ME,
        '/publish/node-profile': PROFILE,
        '/publish/node-settings': {
          features: {},
          embedding: { mode: 'list', origins: ['https://www.example.org'] },
        },
      }),
    })
    const card = mount.querySelector('.publisher-nodeprofile-embedding')
    expect(card).toBeTruthy()
    expect(card!.querySelector<HTMLInputElement>('input[value="list"]')?.checked).toBe(true)
    expect(card!.querySelector<HTMLInputElement>('.publisher-nodeprofile-embed-input')?.value).toBe(
      'https://www.example.org',
    )
    const buttons = Array.from(card!.querySelectorAll('button')).map(b => b.textContent)
    expect(buttons).toContain('Save embedding')
  })

  it('shows the Embedding card read-only to a service caller', async () => {
    const mount = document.createElement('div')
    await renderNodeProfilePage(mount, {
      fetchFn: mockFetch({
        '/publish/me': { role: 'service', is_admin: false },
        '/publish/node-profile': PROFILE,
        '/publish/node-settings': { features: {}, embedding: { mode: 'self', origins: [] } },
      }),
    })
    const card = mount.querySelector('.publisher-nodeprofile-embedding')
    expect(card).toBeTruthy()
    expect(card!.querySelectorAll('input[type="radio"]')).toHaveLength(0)
    expect(card!.querySelector('.publisher-nodeprofile-embed-modes .publisher-nodeprofile-feature-name')?.textContent).toBe(
      'No other site',
    )
    expect(Array.from(card!.querySelectorAll('button')).map(b => b.textContent)).not.toContain('Save embedding')
  })

  it('hides the Embedding card when the settings response carries no policy (an older deploy)', async () => {
    const mount = document.createElement('div')
    await renderNodeProfilePage(mount, {
      fetchFn: mockFetch({
        '/publish/me': ADMIN_ME,
        '/publish/node-profile': PROFILE,
        '/publish/node-settings': { features: {} },
      }),
    })
    expect(mount.querySelector('.publisher-nodeprofile-feature-toggle')).toBeTruthy()
    expect(mount.querySelector('.publisher-nodeprofile-embedding')).toBeNull()
  })

  it('Save features PUTs the full toggle map and fires the change event', async () => {
    const mount = document.createElement('div')
    const capture = { puts: [] as Array<{ url: string; body: unknown }> }
    await renderNodeProfilePage(mount, {
      fetchFn: mockFetch(
        {
          '/publish/me': ADMIN_ME,
          '/publish/node-profile': PROFILE,
          '/publish/node-settings': { features: {} },
        },
        capture,
      ),
    })
    const fired = vi.fn()
    window.addEventListener('publisher:featureschange', fired, { once: true })

    const byName = new Map(
      Array.from(mount.querySelectorAll('.publisher-nodeprofile-feature-row')).map(row => [
        row.querySelector('.publisher-nodeprofile-feature-name')?.textContent,
        row.querySelector<HTMLInputElement>('.publisher-nodeprofile-feature-toggle')!,
      ]),
    )
    byName.get('Blog')!.checked = false
    byName.get('Tours')!.checked = false

    const saveButtons = Array.from(mount.querySelectorAll<HTMLButtonElement>('.publisher-button-primary'))
    const featuresSave = saveButtons.find(b => b.textContent === 'Save features')!
    featuresSave.click()
    await flush()

    const put = capture.puts.find(p => p.url.includes('/publish/node-settings'))
    expect(put).toBeTruthy()
    const body = put!.body as { features: Record<string, boolean> }
    expect(body.features.blog).toBe(false)
    expect(body.features.tours).toBe(false)
    expect(body.features.datasets).toBe(true)
    expect(Object.keys(body.features)).toHaveLength(FEATURE_KEYS.length)
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it('Save PUTs the composed body including added links', async () => {
    const capture = { puts: [] as Array<{ url: string; body: unknown }> }
    const mount = document.createElement('div')
    await renderNodeProfilePage(mount, {
      fetchFn: mockFetch({ '/publish/me': ADMIN_ME, '/publish/node-profile': { profile: null } }, capture),
    })

    ;(mount.querySelector('#nodeprofile-org') as HTMLInputElement).value = 'New Node'
    ;(mount.querySelector('#nodeprofile-mission') as HTMLTextAreaElement).value = 'A mission.'
    ;(mount.querySelector('#nodeprofile-tagline') as HTMLInputElement).value = '  Global Systems Laboratory '
    // Add one link row and fill it.
    const buttons = Array.from(mount.querySelectorAll('button'))
    const addLink = buttons.find(b => b.textContent === 'Add link')!
    addLink.click()
    ;(mount.querySelector('.publisher-nodeprofile-link-label') as HTMLInputElement).value = 'Docs'
    ;(mount.querySelector('.publisher-nodeprofile-link-url') as HTMLInputElement).value = 'https://docs.example.org'

    const save = buttons.find(b => b.textContent === 'Save profile')!
    save.click()
    await flush()

    expect(capture.puts).toHaveLength(1)
    expect(capture.puts[0].url).toContain('/api/v1/publish/node-profile')
    expect(capture.puts[0].body).toEqual({
      orgName: 'New Node',
      tagline: 'Global Systems Laboratory',
      mission: 'A mission.',
      aboutMd: null,
      regionFocus: null,
      defaultTone: null,
      links: [{ label: 'Docs', url: 'https://docs.example.org' }],
    })
    expect(mount.querySelector('.publisher-nodeprofile-status')!.textContent).toBe('Profile saved.')
  })

  it('renders the logo card with a preview when a logo is set, and Remove clears it', async () => {
    const mount = document.createElement('div')
    const withLogo = {
      profile: { ...PROFILE.profile, logoUrl: 'https://assets.example.org/logo.png' },
    }
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const method = init?.method ?? 'GET'
      let body: unknown = {}
      if (method === 'DELETE') body = { logoUrl: null }
      else if (url.includes('/publish/me')) body = ADMIN_ME
      else if (url.includes('/publish/node-profile')) body = withLogo
      return { ok: true, status: 200, type: 'basic', json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
    })
    await renderNodeProfilePage(mount, { fetchFn })

    const img = mount.querySelector('.publisher-nodeprofile-logo-img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('https://assets.example.org/logo.png')

    const remove = Array.from(mount.querySelectorAll('button')).find(b => b.textContent === 'Remove logo')!
    expect(remove.hidden).toBe(false)
    remove.click()
    await flush()
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)
    expect(mount.querySelector('.publisher-nodeprofile-logo-img')).toBeNull()
    expect(mount.querySelector('.publisher-nodeprofile-logo-none')).toBeTruthy()
  })

  it('uploads a picked file as base64 JSON and updates the preview', async () => {
    const mount = document.createElement('div')
    const posts: Array<{ url: string; body: { contentType: string; dataBase64: string } }> = []
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const method = init?.method ?? 'GET'
      let body: unknown = {}
      if (method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init?.body)) })
        body = { logoUrl: 'https://assets.example.org/new-logo.png' }
      } else if (url.includes('/publish/me')) body = ADMIN_ME
      else if (url.includes('/publish/node-profile')) body = PROFILE
      return { ok: true, status: 200, type: 'basic', json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
    })
    await renderNodeProfilePage(mount, { fetchFn })

    const fileInput = mount.querySelector('#nodeprofile-logo-file') as HTMLInputElement
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])], 'logo.png', { type: 'image/png' })
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
    fileInput.dispatchEvent(new Event('change'))
    await flush()
    await flush() // arrayBuffer → send → render

    expect(posts).toHaveLength(1)
    expect(posts[0].url).toContain('/api/v1/publish/node-profile/logo')
    expect(posts[0].body.contentType).toBe('image/png')
    expect(posts[0].body.dataBase64.length).toBeGreaterThan(0)
    const img = mount.querySelector('.publisher-nodeprofile-logo-img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('https://assets.example.org/new-logo.png')
  })

  it('treats a non-http(s) logoUrl as no logo — placeholder shown, Remove hidden', async () => {
    const mount = document.createElement('div')
    const weird = { profile: { ...PROFILE.profile, logoUrl: 'javascript:alert(1)' } } // eslint-disable-line no-script-url
    await renderNodeProfilePage(mount, {
      fetchFn: mockFetch({ '/publish/me': ADMIN_ME, '/publish/node-profile': weird }),
    })
    expect(mount.querySelector('.publisher-nodeprofile-logo-img')).toBeNull()
    expect(mount.querySelector('.publisher-nodeprofile-logo-none')).toBeTruthy()
    const remove = Array.from(mount.querySelectorAll('button')).find(b => b.textContent === 'Remove logo')!
    expect(remove.hidden).toBe(true)
  })

  it('blocks an oversized file client-side', async () => {
    const mount = document.createElement('div')
    const fetchFn = mockFetch({ '/publish/me': ADMIN_ME, '/publish/node-profile': PROFILE })
    await renderNodeProfilePage(mount, { fetchFn })

    const fileInput = mount.querySelector('#nodeprofile-logo-file') as HTMLInputElement
    const big = new File([new Uint8Array(512 * 1024 + 1)], 'big.png', { type: 'image/png' })
    Object.defineProperty(fileInput, 'files', { value: [big], configurable: true })
    fileInput.dispatchEvent(new Event('change'))
    await flush()

    // No POST fired — only the two initial GETs.
    expect(fetchFn.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true)
    const logoStatus = mount.querySelector('.publisher-nodeprofile-logo-status')!
    expect(logoStatus.classList.contains('publisher-nodeprofile-status-error')).toBe(true)
  })

  it('blocks Save client-side when orgName is empty', async () => {
    const capture = { puts: [] as Array<{ url: string; body: unknown }> }
    const mount = document.createElement('div')
    await renderNodeProfilePage(mount, {
      fetchFn: mockFetch({ '/publish/me': ADMIN_ME, '/publish/node-profile': { profile: null } }, capture),
    })
    const save = Array.from(mount.querySelectorAll('button')).find(b => b.textContent === 'Save profile')!
    save.click()
    await flush()
    expect(capture.puts).toHaveLength(0)
    const status = mount.querySelector('.publisher-nodeprofile-status')!
    expect(status.classList.contains('publisher-nodeprofile-status-error')).toBe(true)
  })
})

/**
 * A fetch that holds every request of one method until released, so a
 * test can press a button again while its request is in flight. Every
 * other request goes straight through to `base`.
 */
function holdMethod(base: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, method: string) {
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === method) await gate
    return base(input, init)
  })
  const sent = (): number => fetchFn.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === method).length
  return { fetchFn: fetchFn as unknown as typeof fetch, release, sent }
}

/** The page's reads with a logo already set, answering an upload with a
 *  new logo and a delete with none (or with `deleteStatus`). */
function logoFetch(opts: { deleteStatus?: number } = {}) {
  const withLogo = { profile: { ...PROFILE.profile, logoUrl: 'https://assets.example.org/logo.png' } }
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const method = init?.method ?? 'GET'
    let status = 200
    let body: unknown = {}
    if (method === 'DELETE') {
      status = opts.deleteStatus ?? 200
      body = status < 400 ? { logoUrl: null } : { error: 'server_error' }
    } else if (method === 'POST') body = { logoUrl: 'https://assets.example.org/new-logo.png' }
    else if (url.includes('/publish/me')) body = ADMIN_ME
    else if (url.includes('/publish/node-profile')) body = withLogo
    return {
      ok: status < 400,
      status,
      type: 'basic',
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  }
}

function button(mount: HTMLElement, text: string): HTMLButtonElement {
  return Array.from(mount.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === text)!
}

// Disabling the focused button would drop focus to <body>, losing a
// keyboard or screen-reader user's place; each is marked busy instead,
// and a press while busy does nothing.
describe('renderNodeProfilePage — buttons stay focusable while busy', () => {
  it('Save profile keeps focus and sends no second PUT while one is in flight', async () => {
    const capture = { puts: [] as Array<{ url: string; body: unknown }> }
    const held = holdMethod(mockFetch({ '/publish/me': ADMIN_ME, '/publish/node-profile': PROFILE }, capture), 'PUT')
    const mount = document.createElement('div')
    document.body.replaceChildren(mount)
    await renderNodeProfilePage(mount, { fetchFn: held.fetchFn })

    const save = button(mount, 'Save profile')
    save.focus()
    save.click()
    await until(() => held.sent() === 1, 'the profile PUT to start')
    expect(save.disabled).toBe(false)
    expect(save.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(save)
    // Said in words, since aria-disabled changing on the focused button
    // is not reliably announced.
    expect(mount.querySelector('.publisher-nodeprofile-status')!.textContent).toBe('Saving…')
    // A second press while busy sends nothing more.
    save.click()
    held.release()
    await until(() => !save.hasAttribute('aria-disabled'), 'the save to finish')
    expect(held.sent()).toBe(1)
    expect(capture.puts).toHaveLength(1)
    expect(document.activeElement).toBe(save)
    expect(mount.querySelector('.publisher-nodeprofile-status')!.textContent).toBe('Profile saved.')
    // Pressable again once it is done.
    save.click()
    await until(() => held.sent() === 2, 'a second save after the first finished')
  })

  it('Save features keeps focus and sends no second PUT while one is in flight', async () => {
    const held = holdMethod(
      mockFetch({
        '/publish/me': ADMIN_ME,
        '/publish/node-profile': PROFILE,
        '/publish/node-settings': { features: {} },
      }),
      'PUT',
    )
    const mount = document.createElement('div')
    document.body.replaceChildren(mount)
    await renderNodeProfilePage(mount, { fetchFn: held.fetchFn })

    const save = button(mount, 'Save features')
    save.focus()
    save.click()
    await until(() => held.sent() === 1, 'the features PUT to start')
    expect(save.disabled).toBe(false)
    expect(save.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(save)
    expect(save.closest('.publisher-nodeprofile-actions')!.querySelector('[role="status"]')!.textContent).toBe('Saving…')
    save.click()
    held.release()
    await until(() => !save.hasAttribute('aria-disabled'), 'the save to finish')
    expect(held.sent()).toBe(1)
    expect(document.activeElement).toBe(save)
  })

  it('Choose logo keeps focus and opens no second picker while an upload runs', async () => {
    const base = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      let body: unknown = {}
      if (init?.method === 'POST') body = { logoUrl: 'https://assets.example.org/new-logo.png' }
      else if (url.includes('/publish/me')) body = ADMIN_ME
      else if (url.includes('/publish/node-profile')) body = PROFILE
      return { ok: true, status: 200, type: 'basic', json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
    })
    const held = holdMethod(base, 'POST')
    const mount = document.createElement('div')
    document.body.replaceChildren(mount)
    await renderNodeProfilePage(mount, { fetchFn: held.fetchFn })

    const choose = button(mount, 'Choose image…')
    const fileInput = mount.querySelector('#nodeprofile-logo-file') as HTMLInputElement
    const picker = vi.spyOn(fileInput, 'click').mockImplementation(() => {})
    choose.focus()
    choose.click()
    expect(picker).toHaveBeenCalledTimes(1)
    // The picker hands back a file, as a browser's would.
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', { type: 'image/png' })
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
    fileInput.dispatchEvent(new Event('change'))
    await until(() => held.sent() === 1, 'the logo upload to start')
    expect(choose.disabled).toBe(false)
    expect(choose.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(choose)
    choose.click()
    expect(picker).toHaveBeenCalledTimes(1)
    held.release()
    await until(() => !choose.hasAttribute('aria-disabled'), 'the upload to finish')
    expect(held.sent()).toBe(1)
    expect(document.activeElement).toBe(choose)
  })

  it('Remove logo sends one DELETE while busy, then hands focus to Choose as it hides', async () => {
    const held = holdMethod(logoFetch(), 'DELETE')
    const mount = document.createElement('div')
    document.body.replaceChildren(mount)
    await renderNodeProfilePage(mount, { fetchFn: held.fetchFn })

    const remove = button(mount, 'Remove logo')
    remove.focus()
    remove.click()
    await until(() => held.sent() === 1, 'the DELETE to start')
    expect(remove.disabled).toBe(false)
    expect(remove.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(remove)
    expect(mount.querySelector('.publisher-nodeprofile-logo-status')!.textContent).toBe('Removing…')
    remove.click()
    held.release()
    await until(() => remove.hidden, 'Remove to hide once the logo is gone')
    expect(held.sent()).toBe(1)
    expect(document.activeElement).toBe(button(mount, 'Choose image…'))
    expect(mount.querySelector('.publisher-nodeprofile-logo-status')!.textContent).toBe('Logo removed.')
  })

  it('Remove logo leaves focus alone when the user has moved on before it hides', async () => {
    const held = holdMethod(logoFetch(), 'DELETE')
    const mount = document.createElement('div')
    document.body.replaceChildren(mount)
    await renderNodeProfilePage(mount, { fetchFn: held.fetchFn })

    const remove = button(mount, 'Remove logo')
    remove.focus()
    remove.click()
    await until(() => held.sent() === 1, 'the DELETE to start')
    const orgName = mount.querySelector('#nodeprofile-org') as HTMLInputElement
    orgName.focus()
    held.release()
    await until(() => remove.hidden, 'Remove to hide once the logo is gone')
    expect(document.activeElement).toBe(orgName)
  })

  it('a failed Remove keeps the button, and focus on it', async () => {
    const held = holdMethod(logoFetch({ deleteStatus: 500 }), 'DELETE')
    const mount = document.createElement('div')
    document.body.replaceChildren(mount)
    await renderNodeProfilePage(mount, { fetchFn: held.fetchFn })

    const remove = button(mount, 'Remove logo')
    remove.focus()
    remove.click()
    held.release()
    await until(() => held.sent() === 1 && !remove.hasAttribute('aria-disabled'), 'the failed delete to finish')
    expect(remove.hidden).toBe(false)
    expect(document.activeElement).toBe(remove)
    const logoStatus = mount.querySelector('.publisher-nodeprofile-logo-status')!
    expect(logoStatus.classList.contains('publisher-nodeprofile-status-error')).toBe(true)
    expect(mount.querySelector('.publisher-nodeprofile-logo-img')).toBeTruthy()
  })

  it('treats the logo block as one operation: Remove is busy while an upload runs', async () => {
    const held = holdMethod(logoFetch(), 'POST')
    const mount = document.createElement('div')
    document.body.replaceChildren(mount)
    await renderNodeProfilePage(mount, { fetchFn: held.fetchFn })

    const fileInput = mount.querySelector('#nodeprofile-logo-file') as HTMLInputElement
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', { type: 'image/png' })
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
    fileInput.dispatchEvent(new Event('change'))
    await until(() => held.sent() === 1, 'the logo upload to start')
    const remove = button(mount, 'Remove logo')
    expect(remove.getAttribute('aria-disabled')).toBe('true')
    remove.click()
    held.release()
    await until(() => !remove.hasAttribute('aria-disabled'), 'the upload to finish')
    expect(held.fetchFn).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: 'DELETE' }))
    expect(mount.querySelector('.publisher-nodeprofile-logo-img')!.getAttribute('src')).toBe(
      'https://assets.example.org/new-logo.png',
    )
  })
})
