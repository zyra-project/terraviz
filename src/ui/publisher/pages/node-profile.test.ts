/**
 * Tests for the /publish/node-profile page — form rendering from the
 * stored profile, the privileged gate, and the PUT body the Save
 * button composes (incl. link rows).
 */

import { describe, it, expect, vi } from 'vitest'
import { renderNodeProfilePage } from './node-profile'

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
    expect(mount.querySelectorAll('.publisher-nodeprofile-link-row')).toHaveLength(1)
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

  it('Save PUTs the composed body including added links', async () => {
    const capture = { puts: [] as Array<{ url: string; body: unknown }> }
    const mount = document.createElement('div')
    await renderNodeProfilePage(mount, {
      fetchFn: mockFetch({ '/publish/me': ADMIN_ME, '/publish/node-profile': { profile: null } }, capture),
    })

    ;(mount.querySelector('#nodeprofile-org') as HTMLInputElement).value = 'New Node'
    ;(mount.querySelector('#nodeprofile-mission') as HTMLTextAreaElement).value = 'A mission.'
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
    const statuses = mount.querySelectorAll('.publisher-nodeprofile-status')
    const logoStatus = statuses[statuses.length - 1]
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
