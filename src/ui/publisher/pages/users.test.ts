import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderUsersPage } from './users'

interface RouteSpec {
  status?: number
  body?: unknown
}

/** Build a fetch mock routing on `${method} ${pathWithoutQuery}`. */
function mockFetch(routes: Record<string, RouteSpec>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const method = init?.method ?? 'GET'
    const bare = String(path).split('?')[0]
    const spec = routes[`${method} ${bare}`] ?? routes[bare] ?? {}
    const status = spec.status ?? 200
    const body = spec.body ?? {}
    return {
      ok: status >= 200 && status < 300,
      status,
      type: 'basic',
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  })
}

const ME_ADMIN = { id: 'PUB-ADMIN', role: 'admin', is_admin: true }

function publisher(overrides: Record<string, unknown> = {}) {
  return {
    id: 'PUB-1',
    email: 'newcomer@example.com',
    display_name: 'Newcomer',
    affiliation: null,
    role: 'publisher',
    is_admin: 0,
    status: 'pending',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const flush = () => new Promise<void>(r => setTimeout(r, 0))

let mount: HTMLElement
beforeEach(() => {
  mount = document.createElement('div')
  document.body.replaceChildren(mount)
  window.history.pushState({}, '', '/publish/users')
})

describe('renderUsersPage', () => {
  it('shows a restricted message for a non-admin', async () => {
    const routes = {
      '/api/v1/publish/me': { body: { id: 'PUB-X', role: 'publisher', is_admin: false } },
    }
    await renderUsersPage(mount, { fetchFn: mockFetch(routes) })
    expect(mount.querySelector('.publisher-hero-restricted')).not.toBeNull()
    expect(mount.querySelector('.publisher-users-table')).toBeNull()
  })

  it('renders the publisher list for an admin', async () => {
    const routes = {
      '/api/v1/publish/me': { body: ME_ADMIN },
      '/api/v1/publish/publishers': { body: { publishers: [publisher()], next_cursor: null } },
    }
    await renderUsersPage(mount, { fetchFn: mockFetch(routes) })
    expect(mount.querySelector('.publisher-users-table')).not.toBeNull()
    expect(mount.textContent).toContain('newcomer@example.com')
    // Pending rows expose Approve + Reject.
    const labels = Array.from(mount.querySelectorAll('button')).map(b => b.textContent)
    expect(labels).toContain('Approve')
    expect(labels).toContain('Reject')
  })

  it('approves a pending publisher via PATCH and updates the badge', async () => {
    const routes = {
      '/api/v1/publish/me': { body: ME_ADMIN },
      '/api/v1/publish/publishers': { body: { publishers: [publisher()], next_cursor: null } },
      'PATCH /api/v1/publish/publishers/PUB-1': {
        body: { publisher: publisher({ status: 'active' }) },
      },
    }
    const fetchFn = mockFetch(routes)
    await renderUsersPage(mount, { fetchFn })

    const approve = Array.from(mount.querySelectorAll('button')).find(b => b.textContent === 'Approve')!
    approve.click()
    await flush()

    const patchCall = fetchFn.mock.calls.find(
      c => (c[1]?.method ?? 'GET') === 'PATCH' && String(c[0]).includes('/PUB-1'),
    )
    expect(patchCall).toBeTruthy()
    expect(JSON.parse(String(patchCall![1]!.body))).toEqual({ status: 'active' })
    expect(mount.querySelector('.publisher-badge-status')?.getAttribute('data-status')).toBe('active')
  })

  it('changes a role via the select (PATCH role)', async () => {
    const routes = {
      '/api/v1/publish/me': { body: ME_ADMIN },
      '/api/v1/publish/publishers': {
        body: { publishers: [publisher({ id: 'PUB-2', status: 'active' })], next_cursor: null },
      },
      'PATCH /api/v1/publish/publishers/PUB-2': {
        body: { publisher: publisher({ id: 'PUB-2', status: 'active', role: 'admin' }) },
      },
    }
    const fetchFn = mockFetch(routes)
    await renderUsersPage(mount, { fetchFn })

    const select = mount.querySelector('.publisher-users-role-select') as HTMLSelectElement
    select.value = 'admin'
    select.dispatchEvent(new Event('change'))
    await flush()

    const patchCall = fetchFn.mock.calls.find(c => (c[1]?.method ?? 'GET') === 'PATCH')
    expect(JSON.parse(String(patchCall![1]!.body))).toEqual({ role: 'admin' })
  })

  it('disables the role select for the admin viewing their own row', async () => {
    const routes = {
      '/api/v1/publish/me': { body: ME_ADMIN },
      '/api/v1/publish/publishers': {
        body: {
          publishers: [publisher({ id: 'PUB-ADMIN', email: 'admin@example.com', role: 'admin', status: 'active' })],
          next_cursor: null,
        },
      },
    }
    await renderUsersPage(mount, { fetchFn: mockFetch(routes) })
    const select = mount.querySelector('.publisher-users-role-select') as HTMLSelectElement
    expect(select.disabled).toBe(true)
    // No Suspend button on the self row.
    expect(Array.from(mount.querySelectorAll('button')).map(b => b.textContent)).not.toContain('Suspend')
  })

  it('surfaces the guardrail message when the PATCH is rejected (409)', async () => {
    const routes = {
      '/api/v1/publish/me': { body: ME_ADMIN },
      '/api/v1/publish/publishers': { body: { publishers: [publisher()], next_cursor: null } },
      'PATCH /api/v1/publish/publishers/PUB-1': {
        status: 409,
        body: { error: 'last_admin', message: 'Cannot demote or suspend the last active admin.' },
      },
    }
    await renderUsersPage(mount, { fetchFn: mockFetch(routes) })
    const approve = Array.from(mount.querySelectorAll('button')).find(b => b.textContent === 'Approve')!
    approve.click()
    await flush()
    expect(mount.querySelector('.publisher-row-action-status-error')?.textContent).toBe(
      'Cannot demote or suspend the last active admin.',
    )
  })

  it('routes a session expiry during PATCH through handleSessionError', async () => {
    sessionStorage.clear()
    const navigate = vi.fn()
    const routes = {
      '/api/v1/publish/me': { body: ME_ADMIN },
      '/api/v1/publish/publishers': { body: { publishers: [publisher()], next_cursor: null } },
      'PATCH /api/v1/publish/publishers/PUB-1': { status: 401, body: {} },
    }
    await renderUsersPage(mount, { fetchFn: mockFetch(routes), navigate })
    const approve = Array.from(mount.querySelectorAll('button')).find(b => b.textContent === 'Approve')!
    approve.click()
    await flush()
    // First session error auto-navigates to the redirect-back warmup.
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate.mock.calls[0][0]).toContain('/api/v1/publish/redirect-back')
  })

  it('shows an empty-state message when no users match', async () => {
    const routes = {
      '/api/v1/publish/me': { body: ME_ADMIN },
      '/api/v1/publish/publishers': { body: { publishers: [], next_cursor: null } },
    }
    await renderUsersPage(mount, { fetchFn: mockFetch(routes) })
    expect(mount.querySelector('.publisher-empty')).not.toBeNull()
  })
})
