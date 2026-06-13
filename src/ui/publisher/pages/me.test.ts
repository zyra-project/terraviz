import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderMePage } from './me'

const SAMPLE: ReturnType<typeof samplePayload> = samplePayload()

function samplePayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '01ABC',
    email: 'jane@example.org',
    display_name: 'Jane Doe',
    affiliation: 'NOAA/PMEL',
    role: 'admin',
    is_admin: true,
    status: 'active',
    created_at: '2024-09-15T12:00:00Z',
    ...overrides,
  }
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Page-level tests for /publish/me. The fetch+retry+opaqueredirect
 * machinery is exercised in `../api.test.ts`; here we focus on the
 * rendering — loading state, profile shape variants, and the
 * action-button behaviour on the three error kinds.
 */
describe('renderMePage', () => {
  let mount: HTMLDivElement

  beforeEach(() => {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    sessionStorage.clear()
  })

  it('renders a loading state immediately, then swaps in the profile', async () => {
    let resolveFetch: (r: Response) => void = () => {}
    const fetchFn = vi.fn().mockReturnValue(
      new Promise<Response>(r => {
        resolveFetch = r
      }),
    )

    const pending = renderMePage(mount, { fetchFn: fetchFn as unknown as typeof fetch })

    expect(mount.querySelector('.publisher-loading')).not.toBeNull()
    expect(mount.querySelector('.publisher-card')).toBeNull()

    resolveFetch(jsonResponse(SAMPLE))
    await pending

    expect(mount.querySelector('.publisher-loading')).toBeNull()
    expect(mount.querySelector('.publisher-card')).not.toBeNull()
    expect(mount.textContent).toContain('jane@example.org')
    expect(mount.textContent).toContain('NOAA/PMEL')
  })

  it('renders the admin role with the admin-styled badge', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(SAMPLE))
    await renderMePage(mount, { fetchFn: fetchFn as unknown as typeof fetch })

    const adminBadge = mount.querySelector('.publisher-badge-admin')
    expect(adminBadge?.textContent).toBe('Admin')
  })

  it('renders a publisher role with the plain role badge (no admin styling)', async () => {
    const payload = samplePayload({ role: 'publisher', is_admin: false })
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(payload))
    await renderMePage(mount, { fetchFn: fetchFn as unknown as typeof fetch })

    expect(mount.querySelector('.publisher-badge-admin')).toBeNull()
    expect(mount.querySelector('.publisher-badge-role')?.textContent).toBe('Publisher')
  })

  it("renders an explicit 'Not set' when affiliation is null", async () => {
    const payload = samplePayload({ affiliation: null })
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(payload))
    await renderMePage(mount, { fetchFn: fetchFn as unknown as typeof fetch })
    expect(mount.textContent).toContain('Not set')
  })

  it('applies the status data-status attribute so the badge can colour-code', async () => {
    const payload = samplePayload({ status: 'pending' })
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(payload))
    await renderMePage(mount, { fetchFn: fetchFn as unknown as typeof fetch })

    const statusBadge = mount.querySelector<HTMLElement>('.publisher-badge-status')
    expect(statusBadge?.dataset.status).toBe('pending')
    expect(statusBadge?.textContent).toBe('Pending approval')
  })

  it('falls back to the raw role string for unknown roles', async () => {
    const payload = samplePayload({ role: 'future-role-name' })
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(payload))
    await renderMePage(mount, { fetchFn: fetchFn as unknown as typeof fetch })
    expect(mount.textContent).toContain('future-role-name')
  })

  it('renders the server-error card with a Refresh button on 5xx', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 503 }))
    await renderMePage(mount, { fetchFn: fetchFn as unknown as typeof fetch })

    expect(mount.querySelector('.publisher-error')?.getAttribute('role')).toBe('alert')
    expect(mount.textContent).toContain('server returned an error')
    const btn = mount.querySelector<HTMLButtonElement>('.publisher-button')
    expect(btn?.textContent).toBe('Refresh')
  })

  it('renders the network-error card with a Refresh button when fetch throws', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    await renderMePage(mount, { fetchFn: fetchFn as unknown as typeof fetch })

    expect(mount.textContent).toContain("Couldn't reach the server")
    const btn = mount.querySelector<HTMLButtonElement>('.publisher-button')
    expect(btn?.textContent).toBe('Refresh')
  })

  it('Refresh button on a server error calls window.location.reload', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 503 }))
    await renderMePage(mount, { fetchFn: fetchFn as unknown as typeof fetch })

    const reload = vi.fn()
    Object.defineProperty(window.location, 'reload', {
      configurable: true,
      value: reload,
    })

    mount.querySelector<HTMLButtonElement>('.publisher-button')?.click()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('on a session error WITH the warmup flag already set, renders the Sign in card', async () => {
    // sessionStorage flag set → handleSessionError returns
    // 'show-error' and the page renders the session card.
    sessionStorage.setItem('publisher_warmup_attempted', '1')
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    const navigate = vi.fn()
    await renderMePage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      navigate,
    })

    expect(navigate).not.toHaveBeenCalled()
    expect(mount.textContent).toContain('session has expired')
    const btn = mount.querySelector<HTMLButtonElement>('.publisher-button')
    expect(btn?.textContent).toBe('Sign in')
  })

  it('Sign in button navigates to /api/v1/publish/redirect-back with the current path encoded', async () => {
    sessionStorage.setItem('publisher_warmup_attempted', '1')
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    await renderMePage(mount, { fetchFn: fetchFn as unknown as typeof fetch })

    let navigatedTo: string | null = null
    Object.defineProperty(window.location, 'href', {
      configurable: true,
      set(v: string) {
        navigatedTo = v
      },
      get() {
        return ''
      },
    })

    mount.querySelector<HTMLButtonElement>('.publisher-button')?.click()
    expect(navigatedTo).toMatch(/^\/api\/v1\/publish\/redirect-back\?to=/)
  })

  it('on a session error WITHOUT the warmup flag, auto-navigates and renders no error card', async () => {
    // Fresh tab — the page delegates to handleSessionError which
    // returns 'navigating' and fires the auto-warmup. No error
    // card is rendered (the browser is about to leave the page).
    sessionStorage.clear()
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    const navigate = vi.fn()
    await renderMePage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      navigate,
    })

    expect(navigate).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/v1\/publish\/redirect-back\?to=/),
    )
    expect(mount.querySelector('.publisher-error')).toBeNull()
  })

  it('clears the warmup flag on a successful profile render', async () => {
    sessionStorage.setItem('publisher_warmup_attempted', '1')
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(SAMPLE))
    await renderMePage(mount, { fetchFn: fetchFn as unknown as typeof fetch })
    expect(sessionStorage.getItem('publisher_warmup_attempted')).toBeNull()
  })
})
