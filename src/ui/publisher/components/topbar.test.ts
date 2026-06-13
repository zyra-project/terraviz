import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderTopbar, teardownTopbar } from './topbar'
import { PublisherRouter, ROUTE_CHANGE_EVENT } from '../router'

function clickWith(el: HTMLElement, init: Partial<MouseEventInit> = {}): MouseEvent {
  const e = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  })
  el.dispatchEvent(e)
  return e
}

describe('renderTopbar', () => {
  const originalPath = window.location.pathname
  let host: HTMLDivElement
  let router: PublisherRouter

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    router = new PublisherRouter([{ pattern: '/publish/me', handler: vi.fn() }], vi.fn())
  })

  afterEach(() => {
    teardownTopbar(host)
    router.stop()
    host.remove()
    window.history.replaceState(null, '', originalPath)
  })

  it('renders all section tabs in order', () => {
    renderTopbar(host, router)
    const links = host.querySelectorAll<HTMLAnchorElement>(
      'a.publisher-nav-link:not(.publisher-nav-link-signout)',
    )
    expect(Array.from(links).map(a => a.textContent)).toEqual([
      'Profile',
      'Datasets',
      'Tours',
      'Workflows',
      'Right now',
      'Analytics',
      'Import',
    ])
  })

  it('hides the admin-only Users tab by default', () => {
    renderTopbar(host, router)
    const labels = Array.from(
      host.querySelectorAll<HTMLAnchorElement>('a.publisher-nav-link'),
    ).map(a => a.textContent)
    expect(labels).not.toContain('Users')
  })

  it('hides the Users tab when isAdmin is false', () => {
    renderTopbar(host, router, { isAdmin: false })
    const labels = Array.from(
      host.querySelectorAll<HTMLAnchorElement>('a.publisher-nav-link'),
    ).map(a => a.textContent)
    expect(labels).not.toContain('Users')
  })

  it('shows the Users tab when isAdmin is true', () => {
    renderTopbar(host, router, { isAdmin: true })
    const usersLink = Array.from(
      host.querySelectorAll<HTMLAnchorElement>('a.publisher-nav-link'),
    ).find(a => a.textContent === 'Users')
    expect(usersLink).toBeTruthy()
    expect(usersLink?.getAttribute('href')).toBe('/publish/users')
  })

  it('marks the link that matches the current path as active', () => {
    window.history.replaceState(null, '', '/publish/datasets')
    renderTopbar(host, router)
    const active = host.querySelector<HTMLAnchorElement>('.publisher-nav-link-active')
    expect(active?.textContent).toBe('Datasets')
    expect(active?.getAttribute('aria-current')).toBe('page')
  })

  it('does not stamp aria-current on inactive links', () => {
    window.history.replaceState(null, '', '/publish/datasets')
    renderTopbar(host, router)
    const inactive = Array.from(
      host.querySelectorAll<HTMLAnchorElement>('a.publisher-nav-link'),
    ).filter(a => !a.classList.contains('publisher-nav-link-active'))
    expect(inactive.length).toBeGreaterThan(0)
    for (const link of inactive) {
      // Absence of the attribute is the spec-correct
      // "not current" state. `aria-current="false"` confuses
      // some assistive tech.
      expect(link.hasAttribute('aria-current')).toBe(false)
    }
  })

  it('keeps the parent tab active on sub-paths (e.g., /publish/datasets/abc)', () => {
    window.history.replaceState(null, '', '/publish/datasets/some-id')
    renderTopbar(host, router)
    const active = host.querySelector<HTMLAnchorElement>('.publisher-nav-link-active')
    expect(active?.textContent).toBe('Datasets')
  })

  it('does not mark any link active on an unknown path', () => {
    window.history.replaceState(null, '', '/publish/unknown')
    renderTopbar(host, router)
    expect(host.querySelector('.publisher-nav-link-active')).toBeNull()
  })

  it('intercepts plain left-clicks and calls router.navigate()', () => {
    renderTopbar(host, router)
    const datasets = Array.from(
      host.querySelectorAll<HTMLAnchorElement>('a.publisher-nav-link'),
    ).find(a => a.textContent === 'Datasets')!
    const navSpy = vi.spyOn(router, 'navigate').mockResolvedValue()

    const event = clickWith(datasets)
    expect(event.defaultPrevented).toBe(true)
    expect(navSpy).toHaveBeenCalledWith('/publish/datasets')
  })

  it('lets cmd/ctrl-click fall through to the browser default', () => {
    renderTopbar(host, router)
    const datasets = Array.from(
      host.querySelectorAll<HTMLAnchorElement>('a.publisher-nav-link'),
    ).find(a => a.textContent === 'Datasets')!
    const navSpy = vi.spyOn(router, 'navigate').mockResolvedValue()

    const event = clickWith(datasets, { metaKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(navSpy).not.toHaveBeenCalled()

    const event2 = clickWith(datasets, { ctrlKey: true })
    expect(event2.defaultPrevented).toBe(false)
  })

  it('lets middle-click fall through', () => {
    renderTopbar(host, router)
    const datasets = Array.from(
      host.querySelectorAll<HTMLAnchorElement>('a.publisher-nav-link'),
    ).find(a => a.textContent === 'Datasets')!
    const navSpy = vi.spyOn(router, 'navigate').mockResolvedValue()

    const event = clickWith(datasets, { button: 1 })
    expect(event.defaultPrevented).toBe(false)
    expect(navSpy).not.toHaveBeenCalled()
  })

  it('updates active state when the route-change event fires', () => {
    window.history.replaceState(null, '', '/publish/me')
    renderTopbar(host, router)
    expect(
      host.querySelector<HTMLAnchorElement>('.publisher-nav-link-active')?.textContent,
    ).toBe('Profile')

    window.dispatchEvent(
      new CustomEvent(ROUTE_CHANGE_EVENT, { detail: { path: '/publish/tours' } }),
    )
    expect(
      host.querySelector<HTMLAnchorElement>('.publisher-nav-link-active')?.textContent,
    ).toBe('Tours')
  })

  it('removes the prior listener and DOM on re-render', () => {
    renderTopbar(host, router)
    const first = host.querySelector('.publisher-topbar')!
    renderTopbar(host, router)
    const second = host.querySelector('.publisher-topbar')!
    expect(host.querySelectorAll('.publisher-topbar').length).toBe(1)
    expect(first).not.toBe(second)
  })

  it('mounts the back-to-Terraviz link with the correct aria-label and href', () => {
    renderTopbar(host, router)
    const back = host.querySelector<HTMLAnchorElement>('.publisher-topbar-back')
    expect(back?.getAttribute('aria-label')).toBe('Back to Terraviz')
    expect(back?.getAttribute('href')).toBe('/')
  })

  it('mounts a Sign out link pointing at /api/v1/logout', () => {
    renderTopbar(host, router)
    const signOut = host.querySelector<HTMLAnchorElement>(
      '.publisher-nav-link-signout',
    )
    expect(signOut?.textContent).toBe('Sign out')
    expect(signOut?.getAttribute('href')).toBe('/api/v1/logout')
  })

  it('Sign out is NOT a section tab (no SPA navigation intercept)', () => {
    renderTopbar(host, router)
    const signOut = host.querySelector<HTMLAnchorElement>(
      '.publisher-nav-link-signout',
    )!
    // Distinct from the section tabs: no aria-current toggling,
    // and a plain left-click should NOT be intercepted (the server
    // endpoint at /api/v1/logout handles the redirect to Access).
    const navSpy = vi.spyOn(router, 'navigate').mockResolvedValue()
    const event = clickWith(signOut)
    expect(event.defaultPrevented).toBe(false)
    expect(navSpy).not.toHaveBeenCalled()
  })

  it('Sign out is not marked active on any route', () => {
    window.history.replaceState(null, '', '/publish/me')
    renderTopbar(host, router)
    const signOut = host.querySelector<HTMLAnchorElement>(
      '.publisher-nav-link-signout',
    )!
    expect(signOut.classList.contains('publisher-nav-link-active')).toBe(false)
    expect(signOut.getAttribute('aria-current')).not.toBe('page')
  })
})
