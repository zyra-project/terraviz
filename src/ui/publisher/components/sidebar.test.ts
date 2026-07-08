import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderSidebar, teardownSidebar } from './sidebar'
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

/** Section links live inside the grouped `<nav>`, excluding the
 *  account footer (Profile + Sign out). */
function sectionLabels(host: HTMLElement): (string | null)[] {
  return Array.from(
    host.querySelectorAll<HTMLAnchorElement>('.publisher-nav a.publisher-nav-link'),
  ).map(a => a.textContent)
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

  it('renders the grouped section nav in order (non-admin)', () => {
    renderSidebar(host, router)
    expect(sectionLabels(host)).toEqual([
      'Datasets',
      'Workflows',
      'Import',
      'Right now',
      'Tours',
      'Analytics',
      'Feedback',
    ])
  })

  it('renders group headings', () => {
    renderSidebar(host, router)
    const labels = Array.from(
      host.querySelectorAll('.publisher-nav-group-label'),
    ).map(el => el.textContent)
    // The Settings group is admin-only (Node profile + Users), so it
    // is omitted entirely for a non-admin caller.
    expect(labels).toEqual(['Catalog', 'Current events', 'Insights'])
  })

  it('hides the admin-only links by default', () => {
    renderSidebar(host, router)
    const labels = sectionLabels(host)
    expect(labels).not.toContain('Users')
    expect(labels).not.toContain('Events')
    expect(labels).not.toContain('Feeds')
  })

  it('shows the admin-only links (and the Settings group) when isAdmin is true', () => {
    renderSidebar(host, router, { isAdmin: true })
    const labels = sectionLabels(host)
    expect(labels).toContain('Events')
    expect(labels).toContain('Feeds')
    expect(labels).toContain('Node profile')
    const usersLink = Array.from(
      host.querySelectorAll<HTMLAnchorElement>('a.publisher-nav-link'),
    ).find(a => a.textContent === 'Users')
    expect(usersLink?.getAttribute('href')).toBe('/publish/users')
    expect(
      Array.from(host.querySelectorAll('.publisher-nav-group-label')).map(el => el.textContent),
    ).toContain('Settings')
  })

  it('renders the account link + sign-out in the footer', () => {
    renderSidebar(host, router)
    const footer = host.querySelector('.publisher-sidebar-footer')!
    const links = Array.from(
      footer.querySelectorAll<HTMLAnchorElement>('a.publisher-nav-link'),
    ).map(a => a.textContent)
    expect(links).toEqual(['Profile', 'Sign out'])
  })

  it('marks the link that matches the current path as active', () => {
    window.history.replaceState(null, '', '/publish/datasets')
    renderSidebar(host, router)
    const active = host.querySelector<HTMLAnchorElement>('.publisher-nav-link-active')
    expect(active?.textContent).toBe('Datasets')
    expect(active?.getAttribute('aria-current')).toBe('page')
  })

  it('does not stamp aria-current on inactive links', () => {
    window.history.replaceState(null, '', '/publish/datasets')
    renderSidebar(host, router)
    const inactive = Array.from(
      host.querySelectorAll<HTMLAnchorElement>('a.publisher-nav-link'),
    ).filter(a => !a.classList.contains('publisher-nav-link-active'))
    expect(inactive.length).toBeGreaterThan(0)
    for (const link of inactive) {
      expect(link.hasAttribute('aria-current')).toBe(false)
    }
  })

  it('keeps the parent link active on sub-paths (e.g., /publish/datasets/abc)', () => {
    window.history.replaceState(null, '', '/publish/datasets/some-id')
    renderSidebar(host, router)
    const active = host.querySelector<HTMLAnchorElement>('.publisher-nav-link-active')
    expect(active?.textContent).toBe('Datasets')
  })

  it('does not mark any link active on an unknown path', () => {
    window.history.replaceState(null, '', '/publish/unknown')
    renderSidebar(host, router)
    expect(host.querySelector('.publisher-nav-link-active')).toBeNull()
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

  it('lets cmd/ctrl-click fall through to the browser default', () => {
    renderSidebar(host, router)
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
    renderSidebar(host, router)
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
    renderSidebar(host, router)
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
    renderSidebar(host, router)
    const first = host.querySelector('.publisher-sidebar')!
    renderSidebar(host, router)
    const second = host.querySelector('.publisher-sidebar')!
    expect(host.querySelectorAll('.publisher-sidebar').length).toBe(1)
    expect(first).not.toBe(second)
  })

  it('mounts the back-to-Terraviz link with the correct aria-label and href', () => {
    renderSidebar(host, router)
    const back = host.querySelector<HTMLAnchorElement>('.publisher-sidebar-back')
    expect(back?.getAttribute('aria-label')).toBe('Back to Terraviz')
    expect(back?.getAttribute('href')).toBe('/')
  })

  it('mounts a Sign out link pointing at /api/v1/logout', () => {
    renderSidebar(host, router)
    const signOut = host.querySelector<HTMLAnchorElement>('.publisher-nav-link-signout')
    expect(signOut?.textContent).toBe('Sign out')
    expect(signOut?.getAttribute('href')).toBe('/api/v1/logout')
  })

  it('Sign out is NOT a section link (no SPA navigation intercept)', () => {
    renderSidebar(host, router)
    const signOut = host.querySelector<HTMLAnchorElement>('.publisher-nav-link-signout')!
    const navSpy = vi.spyOn(router, 'navigate').mockResolvedValue()
    const event = clickWith(signOut)
    expect(event.defaultPrevented).toBe(false)
    expect(navSpy).not.toHaveBeenCalled()
  })

  it('Sign out is not marked active on any route', () => {
    window.history.replaceState(null, '', '/publish/me')
    renderSidebar(host, router)
    const signOut = host.querySelector<HTMLAnchorElement>('.publisher-nav-link-signout')!
    expect(signOut.classList.contains('publisher-nav-link-active')).toBe(false)
    expect(signOut.getAttribute('aria-current')).not.toBe('page')
  })
})
