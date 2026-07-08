/**
 * Left-rail sidebar navigation (publisher UI refresh).
 *
 * Lives down the inline-start edge of every portal page. Renders the
 * portal title + a Back-to-Terraviz link, then the section nav grouped
 * into labelled clusters (Catalog / Current events / Insights /
 * Settings), and finally an account footer (Account + Sign out).
 * Replaces the earlier horizontal `topbar.ts`.
 *
 * Active-state tracking is decoupled from the router via the
 * `publisher:routechange` CustomEvent so the sidebar doesn't need to
 * hold a router reference past initial setup.
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

type NavLabelKey =
  | 'publisher.nav.profile'
  | 'publisher.nav.datasets'
  | 'publisher.nav.tours'
  | 'publisher.nav.workflows'
  | 'publisher.nav.featuredHero'
  | 'publisher.nav.nodeProfile'
  | 'publisher.nav.blog'
  | 'publisher.nav.events'
  | 'publisher.nav.feeds'
  | 'publisher.nav.analytics'
  | 'publisher.nav.feedback'
  | 'publisher.nav.import'
  | 'publisher.nav.users'

type GroupLabelKey =
  | 'publisher.nav.group.catalog'
  | 'publisher.nav.group.events'
  | 'publisher.nav.group.insights'
  | 'publisher.nav.group.settings'

export interface NavLink {
  path: string
  labelKey: NavLabelKey
  /** When true the link is only shown to admins (role === 'admin'). */
  adminOnly?: boolean
}

interface NavGroup {
  labelKey: GroupLabelKey
  links: ReadonlyArray<NavLink>
}

/**
 * The section nav, grouped to mirror the wireframe's clustered rail
 * (and the design board's frame organisation). Each page + API gates
 * independently; `adminOnly` only controls visibility.
 */
const NAV_GROUPS: ReadonlyArray<NavGroup> = [
  {
    labelKey: 'publisher.nav.group.catalog',
    links: [
      { path: '/publish/datasets', labelKey: 'publisher.nav.datasets' },
      { path: '/publish/workflows', labelKey: 'publisher.nav.workflows' },
      { path: '/publish/import', labelKey: 'publisher.nav.import' },
    ],
  },
  {
    labelKey: 'publisher.nav.group.events',
    links: [
      { path: '/publish/featured-hero', labelKey: 'publisher.nav.featuredHero' },
      { path: '/publish/events', labelKey: 'publisher.nav.events', adminOnly: true },
      { path: '/publish/feeds', labelKey: 'publisher.nav.feeds', adminOnly: true },
      { path: '/publish/tours', labelKey: 'publisher.nav.tours' },
      { path: '/publish/blog', labelKey: 'publisher.nav.blog', adminOnly: true },
    ],
  },
  {
    labelKey: 'publisher.nav.group.insights',
    links: [
      { path: '/publish/analytics', labelKey: 'publisher.nav.analytics' },
      { path: '/publish/feedback', labelKey: 'publisher.nav.feedback' },
    ],
  },
  {
    labelKey: 'publisher.nav.group.settings',
    links: [
      { path: '/publish/node-profile', labelKey: 'publisher.nav.nodeProfile', adminOnly: true },
      { path: '/publish/users', labelKey: 'publisher.nav.users', adminOnly: true },
    ],
  },
]

/** The account footer link (its own cluster at the rail's end). */
const ACCOUNT_LINK: NavLink = { path: '/publish/me', labelKey: 'publisher.nav.profile' }

export interface SidebarOptions {
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
 * `pathname` is "active" for a nav link if the current page either
 * equals that link's path exactly OR sits beneath it as a sub-path.
 * So `/publish/datasets/abc` keeps the Datasets link highlighted on
 * the detail view.
 */
function isActive(linkPath: string, currentPath: string): boolean {
  if (currentPath === linkPath) return true
  return currentPath.startsWith(linkPath + '/')
}

function applyActiveState(rail: HTMLElement, currentPath: string): void {
  rail.querySelectorAll<HTMLAnchorElement>('a.publisher-nav-link').forEach(a => {
    const active = isActive(a.pathname, currentPath)
    a.classList.toggle('publisher-nav-link-active', active)
    // `aria-current` is set on the matching link and *removed* from
    // every other one. Some assistive technologies announce
    // `aria-current="false"` as "not current" on every inactive link,
    // which is noise — the spec treats absence as the implicit
    // non-current state.
    if (active) {
      a.setAttribute('aria-current', 'page')
    } else {
      a.removeAttribute('aria-current')
    }
  })
}

/** Build one nav link anchor wired for SPA navigation. */
function navLink(link: NavLink, router: PublisherRouter): HTMLAnchorElement {
  const a = document.createElement('a')
  a.href = link.path
  a.className = 'publisher-nav-link'
  a.textContent = t(link.labelKey)
  a.addEventListener('click', e => {
    if (!isPlainLeftClick(e)) return
    e.preventDefault()
    void router.navigate(link.path)
  })
  return a
}

/**
 * Render the sidebar into `host`. Idempotent — calling twice removes
 * the prior sidebar before mounting a fresh one (the route-change
 * listener and DOM both get replaced cleanly).
 */
export function renderSidebar(
  host: HTMLElement,
  router: PublisherRouter,
  options: SidebarOptions = {},
): void {
  // Remove any prior sidebar + listener.
  const prior = host.querySelector('.publisher-sidebar')
  if (prior) prior.remove()
  const priorListener = (host as HostWithListener).__publisherSidebarListener
  if (priorListener) {
    window.removeEventListener(ROUTE_CHANGE_EVENT, priorListener as EventListener)
  }

  const rail = document.createElement('aside')
  rail.className = 'publisher-sidebar'

  // ── Brand ───────────────────────────────────────────────────────
  const brand = document.createElement('div')
  brand.className = 'publisher-sidebar-brand'

  const back = document.createElement('a')
  back.href = '/'
  back.className = 'publisher-sidebar-back'
  back.setAttribute('aria-label', t('publisher.nav.backToTerraviz'))
  back.textContent = '←'
  brand.appendChild(back)

  const title = document.createElement('span')
  title.className = 'publisher-sidebar-title'
  title.textContent = t('publisher.portal.title')
  brand.appendChild(title)

  rail.appendChild(brand)

  // ── Grouped nav ─────────────────────────────────────────────────
  const nav = document.createElement('nav')
  nav.className = 'publisher-nav'
  nav.setAttribute('aria-label', t('publisher.nav.aria'))

  for (const group of NAV_GROUPS) {
    const links = group.links.filter(l => !l.adminOnly || options.isAdmin)
    if (links.length === 0) continue

    const section = document.createElement('div')
    section.className = 'publisher-nav-group'

    const heading = document.createElement('div')
    heading.className = 'publisher-nav-group-label'
    heading.textContent = t(group.labelKey)
    section.appendChild(heading)

    for (const link of links) section.appendChild(navLink(link, router))
    nav.appendChild(section)
  }
  rail.appendChild(nav)

  // ── Account footer ──────────────────────────────────────────────
  const footer = document.createElement('div')
  footer.className = 'publisher-sidebar-footer'
  footer.appendChild(navLink(ACCOUNT_LINK, router))

  // "Sign out" — plain anchor, no SPA intercept; the server endpoint
  // at /api/v1/logout handles the cross-origin redirect to Cloudflare
  // Access's team-level logout.
  const signOut = document.createElement('a')
  signOut.href = '/api/v1/logout'
  signOut.className = 'publisher-nav-link publisher-nav-link-signout'
  signOut.textContent = t('publisher.nav.signOut')
  footer.appendChild(signOut)

  rail.appendChild(footer)

  host.insertBefore(rail, host.firstChild)

  applyActiveState(rail, window.location.pathname)
  const listener = (e: Event): void => {
    const detail = (e as CustomEvent<RouteChangeDetail>).detail
    applyActiveState(rail, detail?.path ?? window.location.pathname)
  }
  ;(host as HostWithListener).__publisherSidebarListener = listener
  window.addEventListener(ROUTE_CHANGE_EVENT, listener as EventListener)
}

interface HostWithListener extends HTMLElement {
  __publisherSidebarListener?: (e: Event) => void
}

/** Tear down the sidebar listener; only used by tests. */
export function teardownSidebar(host: HTMLElement): void {
  const listener = (host as HostWithListener).__publisherSidebarListener
  if (listener) {
    window.removeEventListener(ROUTE_CHANGE_EVENT, listener as EventListener)
    delete (host as HostWithListener).__publisherSidebarListener
  }
  const rail = host.querySelector('.publisher-sidebar')
  if (rail) rail.remove()
}
