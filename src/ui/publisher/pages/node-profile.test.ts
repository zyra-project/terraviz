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
