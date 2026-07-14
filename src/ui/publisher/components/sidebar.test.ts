import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderSidebar, teardownSidebar, initialsOf } from './sidebar'
import { defaultFeatures } from '../../../types/node-features'
import { PublisherRouter, ROUTE_CHANGE_EVENT } from '../router'

function clickWith(el: HTMLElement, init: Partial<MouseEventInit> = {}): MouseEvent {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })
  el.dispatchEvent(e)
  return e
}

function linkLabels(host: HTMLElement): string[] {
  return Array.from(
    host.querySelectorAll<HTMLAnchorElement>(
      'a.publisher-nav-link:not(.publisher-nav-link-signout) .publisher-nav-link-label',
    ),
  ).map(s => s.textContent ?? '')
}

describe('renderSidebar', () => {
  const originalPath = window.location.pathname
  let host: HTMLDivElement
  let router: PublisherRouter

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    router = new PublisherRouter([{ pattern: '/publish/me', handler: vi.fn() }], vi.fn())
  })

  afterEach(() => {
    teardownSidebar(host)
    router.stop()
    host.remove()
    window.history.replaceState(null, '', originalPath)
  })

  it('renders the non-admin nav in grouped order', () => {
    renderSidebar(host, router)
    // Admin-only items (Feeds/Events/Blog/Node profile/Team) are hidden.
    expect(linkLabels(host)).toEqual([
      'Overview',
      'Datasets',
      'Workflows',
      'Import',
      'Right now',
      'Tours',
      'Analytics',
      'Feedback',
      'Account',
    ])
  })

  it('renders group headers for populated groups', () => {
    renderSidebar(host, router, { isAdmin: true })
    const groups = Array.from(
      host.querySelectorAll<HTMLElement>('.publisher-nav-group-label'),
    ).map(g => g.textContent)
    expect(groups).toEqual(['Catalog', 'Newsroom', 'Insights', 'Settings'])
  })

  it('shows admin-only links when isAdmin is true', () => {
    renderSidebar(host, router, { isAdmin: true })
    const labels = linkLabels(host)
    expect(labels).toContain('Feeds')
    expect(labels).toContain('Events')
    expect(labels).toContain('Blog')
    expect(labels).toContain('Node profile')
    expect(labels).toContain('Team')
  })

  it('hides admin-only links by default', () => {
    renderSidebar(host, router)
    const labels = linkLabels(host)
    expect(labels).not.toContain('Feeds')
    expect(labels).not.toContain('Events')
    expect(labels).not.toContain('Team')
  })

  it('hides links whose feature toggle is off', () => {
    renderSidebar(host, router, {
      isAdmin: true,
      features: { ...defaultFeatures(), blog: false, tours: false, datasets: false },
    })
    const labels = linkLabels(host)
    expect(labels).not.toContain('Blog')
    expect(labels).not.toContain('Tours')
    expect(labels).not.toContain('Datasets')
    expect(labels).not.toContain('Import') // rides the datasets toggle
    // Untagged + enabled items stay.
    expect(labels).toContain('Overview')
    expect(labels).toContain('Workflows')
    expect(labels).toContain('Node profile')
  })

  it('drops a whole group when every item in it is toggled off', () => {
    renderSidebar(host, router, {
      isAdmin: true,
      features: { ...defaultFeatures(), events: false, hero: false, blog: false, tours: false },
    })
    const headers = Array.from(host.querySelectorAll('.publisher-nav-group-label')).map(
      h => h.textContent,
    )
    expect(headers).not.toContain('Newsroom')
    expect(headers).toContain('Catalog')
  })

  it('undefined features (optimistic first render) shows everything', () => {
    renderSidebar(host, router, { isAdmin: true })
    expect(linkLabels(host)).toContain('Blog')
    expect(linkLabels(host)).toContain('Tours')
  })

  it('renders the events badge only when the count is positive and admin', () => {
    renderSidebar(host, router, { isAdmin: true, eventsBadge: 8 })
    const badge = host.querySelector('.publisher-nav-badge')
    expect(badge?.textContent).toBe('8')

    renderSidebar(host, router, { isAdmin: true, eventsBadge: 0 })
    expect(host.querySelector('.publisher-nav-badge')).toBeNull()
  })

  it('prefers the signed-in person for the footer name + avatar initials', () => {
    renderSidebar(host, router, {
      isAdmin: true,
      identity: { orgName: 'The Zyra Project', displayName: 'Eric Hackathorn', roleLabel: 'Admin' },
    })
    // The footer identifies the person, not the org: "Eric Hackathorn" → EH.
    expect(host.querySelector('.publisher-sidebar-user-name')?.textContent).toBe('Eric Hackathorn')
    expect(host.querySelector('.publisher-sidebar-user-role')?.textContent).toBe('Admin')
    expect(host.querySelector('.publisher-sidebar-avatar')?.textContent).toBe('EH')
  })

  it('falls back to the org name when no display name is present', () => {
    renderSidebar(host, router, {
      isAdmin: true,
      identity: { orgName: 'The Zyra Project', roleLabel: 'Admin' },
    })
    expect(host.querySelector('.publisher-sidebar-user-name')?.textContent).toBe('The Zyra Project')
    // Leading article dropped: "The Zyra Project" → "ZP".
    expect(host.querySelector('.publisher-sidebar-avatar')?.textContent).toBe('ZP')
  })

  it('initialsOf drops a leading article and handles single words', () => {
    expect(initialsOf('The Zyra Project')).toBe('ZP')
    expect(initialsOf('NOAA')).toBe('NO')
    expect(initialsOf('Coastal Science Center')).toBe('CS')
    expect(initialsOf('')).toBe('·')
  })

  it('marks the current path active and keeps the parent active on sub-paths', () => {
    window.history.replaceState(null, '', '/publish/datasets/abc')
    renderSidebar(host, router)
    const active = host.querySelector<HTMLAnchorElement>('.publisher-nav-link-active')
    expect(active?.querySelector('.publisher-nav-link-label')?.textContent).toBe('Datasets')
    expect(active?.getAttribute('aria-current')).toBe('page')
  })

  it('marks Overview active on the bare /publish root', () => {
    window.history.replaceState(null, '', '/publish')
    renderSidebar(host, router)
    const active = host.querySelector<HTMLAnchorElement>('.publisher-nav-link-active')
    expect(active?.querySelector('.publisher-nav-link-label')?.textContent).toBe('Overview')
  })

  it('intercepts plain left-clicks and calls router.navigate()', () => {
    renderSidebar(host, router)
    const datasets = Array.from(
      host.querySelectorAll<HTMLAnchorElement>('a.publisher-nav-link'),
    ).find(a => a.textContent === 'Datasets')!
    const navSpy = vi.spyOn(router, 'navigate').mockResolvedValue()

    const event = clickWith(datasets)
    expect(event.defaultPrevented).toBe(true)
    expect(navSpy).toHaveBeenCalledWith('/publish/datasets')
  })

  it('lets cmd/ctrl/middle-click fall through to the browser default', () => {
    renderSidebar(host, router)
    const datasets = Array.from(
      host.querySelectorAll<HTMLAnchorElement>('a.publisher-nav-link'),
    ).find(a => a.textContent === 'Datasets')!
    const navSpy = vi.spyOn(router, 'navigate').mockResolvedValue()

    expect(clickWith(datasets, { metaKey: true }).defaultPrevented).toBe(false)
    expect(clickWith(datasets, { button: 1 }).defaultPrevented).toBe(false)
    expect(navSpy).not.toHaveBeenCalled()
  })

  it('updates active state when the route-change event fires', () => {
    window.history.replaceState(null, '', '/publish/me')
    renderSidebar(host, router)
    expect(
      host
        .querySelector<HTMLAnchorElement>('.publisher-nav-link-active .publisher-nav-link-label')
        ?.textContent,
    ).toBe('Account')

    window.dispatchEvent(
      new CustomEvent(ROUTE_CHANGE_EVENT, { detail: { path: '/publish/tours' } }),
    )
    expect(
      host
        .querySelector<HTMLAnchorElement>('.publisher-nav-link-active .publisher-nav-link-label')
        ?.textContent,
    ).toBe('Tours')
  })

  it('removes the prior sidebar + listener on re-render', () => {
    renderSidebar(host, router)
    const first = host.querySelector('.publisher-sidebar')!
    renderSidebar(host, router)
    expect(host.querySelectorAll('.publisher-sidebar').length).toBe(1)
    expect(first).not.toBe(host.querySelector('.publisher-sidebar'))
  })

  it('mounts the back-to-Terraviz link and a Sign out link', () => {
    renderSidebar(host, router)
    const back = host.querySelector<HTMLAnchorElement>('.publisher-sidebar-back')
    expect(back?.getAttribute('aria-label')).toBe('Back to Terraviz')
    expect(back?.getAttribute('href')).toBe('/')

    const signOut = host.querySelector<HTMLAnchorElement>('.publisher-nav-link-signout')
    expect(signOut?.textContent).toBe('Sign out')
    expect(signOut?.getAttribute('href')).toBe('/api/v1/logout')
  })

  it('Sign out is not intercepted and never marked active', () => {
    window.history.replaceState(null, '', '/publish/me')
    renderSidebar(host, router)
    const signOut = host.querySelector<HTMLAnchorElement>('.publisher-nav-link-signout')!
    const navSpy = vi.spyOn(router, 'navigate').mockResolvedValue()
    const event = clickWith(signOut)
    expect(event.defaultPrevented).toBe(false)
    expect(navSpy).not.toHaveBeenCalled()
    expect(signOut.classList.contains('publisher-nav-link-active')).toBe(false)
  })
})
