/**
 * Glass-surface top bar with section tabs.
 *
 * Lives at the top of every portal page. Renders the portal title,
 * a Back-to-Terraviz link, and a tab nav with one entry per
 * section. Active-state tracking is decoupled from the router via
 * the `publisher:routechange` CustomEvent so the topbar doesn't
 * need to hold a router reference past initial setup.
 *
 * Click handling: nav links keep real `href`s so middle-click /
 * cmd-click / right-click → Open in new tab continue to work; the
 * click handler short-circuits same-window navigations to
 * `router.navigate()` for SPA-style transitions.
 */

import { t } from '../../../i18n'
import {
  ROUTE_CHANGE_EVENT,
  type PublisherRouter,
  type RouteChangeDetail,
} from '../router'

export interface NavLink {
  path: string
  labelKey:
    | 'publisher.nav.profile'
    | 'publisher.nav.datasets'
    | 'publisher.nav.tours'
    | 'publisher.nav.workflows'
    | 'publisher.nav.featuredHero'
    | 'publisher.nav.analytics'
    | 'publisher.nav.feedback'
    | 'publisher.nav.import'
    | 'publisher.nav.users'
  /** When true the link is only shown to admins (role === 'admin'). */
  adminOnly?: boolean
}

const NAV_LINKS: ReadonlyArray<NavLink> = [
  { path: '/publish/me', labelKey: 'publisher.nav.profile' },
  { path: '/publish/datasets', labelKey: 'publisher.nav.datasets' },
  { path: '/publish/tours', labelKey: 'publisher.nav.tours' },
  { path: '/publish/workflows', labelKey: 'publisher.nav.workflows' },
  { path: '/publish/featured-hero', labelKey: 'publisher.nav.featuredHero' },
  { path: '/publish/analytics', labelKey: 'publisher.nav.analytics' },
  { path: '/publish/feedback', labelKey: 'publisher.nav.feedback' },
  { path: '/publish/import', labelKey: 'publisher.nav.import' },
  { path: '/publish/users', labelKey: 'publisher.nav.users', adminOnly: true },
]

export interface TopbarOptions {
  /** Show admin-only nav links (e.g. the Users tab). The page and
   *  API still gate independently — this only controls visibility. */
  isAdmin?: boolean
}

/**
 * A modified-key click (cmd/ctrl/shift/middle/right) should fall
 * through to the browser's default behaviour so power users can
 * open a portal section in a new tab. Only intercept plain left-
 * clicks.
 */
function isPlainLeftClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
}

/**
 * `pathname` is "active" for a nav link if the current page
 * either equals that link's path exactly OR sits beneath it as a
 * sub-path. So `/publish/datasets/abc` keeps the Datasets tab
 * highlighted on the detail view.
 */
function isActive(linkPath: string, currentPath: string): boolean {
  if (currentPath === linkPath) return true
  return currentPath.startsWith(linkPath + '/')
}

function applyActiveState(nav: HTMLElement, currentPath: string): void {
  nav.querySelectorAll<HTMLAnchorElement>('a.publisher-nav-link').forEach(a => {
    const active = isActive(a.pathname, currentPath)
    a.classList.toggle('publisher-nav-link-active', active)
    // `aria-current` is set on the matching link and *removed*
    // from every other one. Some assistive technologies announce
    // `aria-current="false"` as "not current" on every inactive
    // link, which is noise — the spec treats absence as the
    // implicit non-current state.
    if (active) {
      a.setAttribute('aria-current', 'page')
    } else {
      a.removeAttribute('aria-current')
    }
  })
}

/**
 * Render the topbar into `host`. Idempotent — calling twice
 * removes the prior topbar before mounting a fresh one (the
 * route-change listener and DOM both get replaced cleanly).
 */
export function renderTopbar(
  host: HTMLElement,
  router: PublisherRouter,
  options: TopbarOptions = {},
): void {
  // Remove any prior topbar + listener.
  const prior = host.querySelector('.publisher-topbar')
  if (prior) prior.remove()
  const priorListener = (host as HostWithListener).__publisherTopbarListener
  if (priorListener) {
    window.removeEventListener(ROUTE_CHANGE_EVENT, priorListener as EventListener)
  }

  const bar = document.createElement('header')
  bar.className = 'publisher-topbar publisher-glass'

  const titleBlock = document.createElement('div')
  titleBlock.className = 'publisher-topbar-title-block'

  const back = document.createElement('a')
  back.href = '/'
  back.className = 'publisher-topbar-back'
  back.setAttribute('aria-label', t('publisher.nav.backToTerraviz'))
  back.textContent = '←'
  titleBlock.appendChild(back)

  const title = document.createElement('span')
  title.className = 'publisher-topbar-title'
  title.textContent = t('publisher.portal.title')
  titleBlock.appendChild(title)

  bar.appendChild(titleBlock)

  const nav = document.createElement('nav')
  nav.className = 'publisher-nav'
  nav.setAttribute('aria-label', t('publisher.nav.aria'))

  for (const link of NAV_LINKS) {
    if (link.adminOnly && !options.isAdmin) continue
    const a = document.createElement('a')
    a.href = link.path
    a.className = 'publisher-nav-link'
    a.textContent = t(link.labelKey)
    a.addEventListener('click', e => {
      if (!isPlainLeftClick(e)) return
      e.preventDefault()
      void router.navigate(link.path)
    })
    nav.appendChild(a)
  }
  bar.appendChild(nav)

  // "Sign out" sits to the far right, visually separated from
  // the section tabs. Plain anchor — no SPA intercept; the
  // server endpoint at /api/v1/logout handles the cross-origin
  // redirect to Cloudflare Access's team-level logout.
  const signOut = document.createElement('a')
  signOut.href = '/api/v1/logout'
  signOut.className = 'publisher-nav-link publisher-nav-link-signout'
  signOut.textContent = t('publisher.nav.signOut')
  bar.appendChild(signOut)

  host.insertBefore(bar, host.firstChild)

  applyActiveState(nav, window.location.pathname)
  const listener = (e: Event): void => {
    const detail = (e as CustomEvent<RouteChangeDetail>).detail
    applyActiveState(nav, detail?.path ?? window.location.pathname)
  }
  ;(host as HostWithListener).__publisherTopbarListener = listener
  window.addEventListener(ROUTE_CHANGE_EVENT, listener as EventListener)
}

interface HostWithListener extends HTMLElement {
  __publisherTopbarListener?: (e: Event) => void
}

/** Tear down the topbar listener; only used by tests. */
export function teardownTopbar(host: HTMLElement): void {
  const listener = (host as HostWithListener).__publisherTopbarListener
  if (listener) {
    window.removeEventListener(ROUTE_CHANGE_EVENT, listener as EventListener)
    delete (host as HostWithListener).__publisherTopbarListener
  }
  const bar = host.querySelector('.publisher-topbar')
  if (bar) bar.remove()
}
