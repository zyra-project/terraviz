/**
 * Glass-surface left sidebar with grouped section nav.
 *
 * Lives on the inline-start edge of every portal page. Renders the
 * portal title + back-to-Terraviz link at the top, the section nav
 * grouped under headers (Catalog / Newsroom / Insights / Settings)
 * with a standalone Overview entry above them, and a user identity
 * footer (signed-in user's avatar + name + role + Sign out) pinned to
 * the bottom.
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
import type { FeatureKey, FeatureMap } from '../../../types/node-features'
import {
  ROUTE_CHANGE_EVENT,
  type PublisherRouter,
  type RouteChangeDetail,
} from '../router'

type NavLabelKey =
  | 'publisher.nav.overview'
  | 'publisher.nav.datasets'
  | 'publisher.nav.workflows'
  | 'publisher.nav.import'
  | 'publisher.nav.feeds'
  | 'publisher.nav.events'
  | 'publisher.nav.featuredHero'
  | 'publisher.nav.blog'
  | 'publisher.nav.tours'
  | 'publisher.nav.analytics'
  | 'publisher.nav.feedback'
  | 'publisher.nav.nodeProfile'
  | 'publisher.nav.team'
  | 'publisher.nav.account'

type GroupLabelKey =
  | 'publisher.nav.group.catalog'
  | 'publisher.nav.group.newsroom'
  | 'publisher.nav.group.insights'
  | 'publisher.nav.group.settings'

export interface NavItem {
  path: string
  labelKey: NavLabelKey
  /** When true the link is only shown to admins (role === 'admin'). */
  adminOnly?: boolean
  /** When set, the link hides while that feature toggle is off. Like
   *  `adminOnly` this is visibility only — the page and API still
   *  gate independently. */
  feature?: FeatureKey
  /** When true, the events count badge renders on this item. */
  badge?: 'events'
}

interface NavGroup {
  /** Undefined for the top (Overview) group, which has no header. */
  labelKey?: GroupLabelKey
  items: NavItem[]
}

const NAV_GROUPS: ReadonlyArray<NavGroup> = [
  { items: [{ path: '/publish/overview', labelKey: 'publisher.nav.overview' }] },
  {
    labelKey: 'publisher.nav.group.catalog',
    items: [
      { path: '/publish/datasets', labelKey: 'publisher.nav.datasets', feature: 'datasets' },
      { path: '/publish/workflows', labelKey: 'publisher.nav.workflows', feature: 'workflows' },
      { path: '/publish/import', labelKey: 'publisher.nav.import', feature: 'datasets' },
    ],
  },
  {
    labelKey: 'publisher.nav.group.newsroom',
    items: [
      { path: '/publish/feeds', labelKey: 'publisher.nav.feeds', adminOnly: true, feature: 'events' },
      { path: '/publish/events', labelKey: 'publisher.nav.events', adminOnly: true, feature: 'events', badge: 'events' },
      { path: '/publish/featured-hero', labelKey: 'publisher.nav.featuredHero', feature: 'hero' },
      { path: '/publish/blog', labelKey: 'publisher.nav.blog', adminOnly: true, feature: 'blog' },
      { path: '/publish/tours', labelKey: 'publisher.nav.tours', feature: 'tours' },
    ],
  },
  {
    labelKey: 'publisher.nav.group.insights',
    items: [
      { path: '/publish/analytics', labelKey: 'publisher.nav.analytics', feature: 'analytics' },
      { path: '/publish/feedback', labelKey: 'publisher.nav.feedback', feature: 'feedback' },
    ],
  },
  {
    labelKey: 'publisher.nav.group.settings',
    items: [
      { path: '/publish/node-profile', labelKey: 'publisher.nav.nodeProfile', adminOnly: true },
      { path: '/publish/users', labelKey: 'publisher.nav.team', adminOnly: true },
      { path: '/publish/me', labelKey: 'publisher.nav.account' },
    ],
  },
]

export interface SidebarIdentity {
  orgName?: string | null
  displayName?: string | null
  /** Already-localized role label (e.g. "Admin"). */
  roleLabel?: string | null
}

export interface SidebarOptions {
  /** Show admin-only nav links (Feeds / Events / Blog / Node profile /
   *  Team). The page and API still gate independently — this only
   *  controls visibility. */
  isAdmin?: boolean
  /** Footer identity; filled in asynchronously after the initial
   *  render so the sidebar never blocks on the network. */
  identity?: SidebarIdentity
  /** Count of events awaiting review; renders as a badge on the
   *  Events item when > 0. */
  eventsBadge?: number
  /** The node's feature toggles. Items whose `feature` is `false`
   *  here are hidden. Undefined (the optimistic first render, or a
   *  failed chrome fetch) shows everything — fail-open, matching the
   *  server-side gate. Visibility only; pages and APIs still gate. */
  features?: FeatureMap
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
 * `pathname` is "active" for a nav link if the current page equals
 * that link's path exactly OR sits beneath it as a sub-path. So
 * `/publish/datasets/abc` keeps the Datasets item highlighted on the
 * detail view. The Overview item additionally matches the bare
 * `/publish` root (which renders the Overview page).
 */
function isActive(linkPath: string, currentPath: string): boolean {
  if (currentPath === linkPath) return true
  if (currentPath.startsWith(linkPath + '/')) return true
  if (linkPath === '/publish/overview' && (currentPath === '/publish' || currentPath === '/publish/')) {
    return true
  }
  return false
}

function applyActiveState(nav: HTMLElement, currentPath: string): void {
  nav.querySelectorAll<HTMLAnchorElement>('a.publisher-nav-link').forEach(a => {
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

/** Two-letter uppercase initials from an org / display name. A
 *  leading article ("The Zyra Project" → "ZP") is dropped so the
 *  avatar reads from the meaningful words. */
export function initialsOf(name: string): string {
  let words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length > 1 && /^(the|a|an)$/i.test(words[0])) words = words.slice(1)
  if (words.length === 0) return '·'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

function buildNav(activeRouter: PublisherRouter, options: SidebarOptions): HTMLElement {
  const nav = document.createElement('nav')
  nav.className = 'publisher-nav'
  nav.setAttribute('aria-label', t('publisher.nav.aria'))

  for (const group of NAV_GROUPS) {
    const visible = group.items.filter(
      item =>
        (!item.adminOnly || options.isAdmin) &&
        (!item.feature || options.features?.[item.feature] !== false),
    )
    if (visible.length === 0) continue

    const groupEl = document.createElement('div')
    groupEl.className = 'publisher-nav-group'
    if (group.labelKey) {
      const label = document.createElement('div')
      label.className = 'publisher-nav-group-label'
      label.textContent = t(group.labelKey)
      groupEl.appendChild(label)
    }

    for (const item of visible) {
      const a = document.createElement('a')
      a.href = item.path
      a.className = 'publisher-nav-link'

      const label = document.createElement('span')
      label.className = 'publisher-nav-link-label'
      label.textContent = t(item.labelKey)
      a.appendChild(label)

      if (item.badge === 'events' && options.eventsBadge && options.eventsBadge > 0) {
        const badge = document.createElement('span')
        badge.className = 'publisher-nav-badge'
        badge.textContent = String(options.eventsBadge)
        badge.setAttribute(
          'aria-label',
          t('publisher.nav.eventsBadge.aria', { count: options.eventsBadge }),
        )
        a.appendChild(badge)
      }

      a.addEventListener('click', e => {
        if (!isPlainLeftClick(e)) return
        e.preventDefault()
        void activeRouter.navigate(item.path)
      })
      groupEl.appendChild(a)
    }
    nav.appendChild(groupEl)
  }
  return nav
}

function buildFooter(options: SidebarOptions): HTMLElement {
  const footer = document.createElement('div')
  footer.className = 'publisher-sidebar-footer'

  // The footer identifies the signed-in *person* (whose session this
  // is and who Sign out logs out), so prefer their display name — the
  // avatar then reads as their initials (e.g. "Eric Hackathorn" → EH).
  // Fall back to the host org name, then the portal title.
  const name =
    options.identity?.displayName?.trim() ||
    options.identity?.orgName?.trim() ||
    t('publisher.portal.title')

  const user = document.createElement('div')
  user.className = 'publisher-sidebar-user'
  user.setAttribute('aria-label', t('publisher.nav.userMenu.aria', { name }))

  const avatar = document.createElement('span')
  avatar.className = 'publisher-sidebar-avatar'
  avatar.textContent = initialsOf(name)
  avatar.setAttribute('aria-hidden', 'true')
  user.appendChild(avatar)

  const meta = document.createElement('div')
  meta.className = 'publisher-sidebar-user-meta'
  const nameEl = document.createElement('span')
  nameEl.className = 'publisher-sidebar-user-name'
  nameEl.textContent = name
  meta.appendChild(nameEl)
  if (options.identity?.roleLabel) {
    const roleEl = document.createElement('span')
    roleEl.className = 'publisher-sidebar-user-role'
    roleEl.textContent = options.identity.roleLabel
    meta.appendChild(roleEl)
  }
  user.appendChild(meta)
  footer.appendChild(user)

  // Plain anchor — no SPA intercept; the server endpoint at
  // /api/v1/logout handles the cross-origin redirect to Cloudflare
  // Access's team-level logout.
  const signOut = document.createElement('a')
  signOut.href = '/api/v1/logout'
  signOut.className = 'publisher-nav-link publisher-nav-link-signout'
  signOut.textContent = t('publisher.nav.signOut')
  footer.appendChild(signOut)

  return footer
}

/**
 * Render the sidebar into `host`. Idempotent — calling twice removes
 * the prior sidebar before mounting a fresh one (the route-change
 * listener and DOM both get replaced cleanly). Re-rendering is how
 * the boot path fills in admin-only links, the footer identity, and
 * the events badge once its background probes resolve.
 */
export function renderSidebar(
  host: HTMLElement,
  activeRouter: PublisherRouter,
  options: SidebarOptions = {},
): void {
  // Remove any prior sidebar + listener.
  const prior = host.querySelector('.publisher-sidebar')
  if (prior) prior.remove()
  const priorListener = (host as HostWithListener).__publisherSidebarListener
  if (priorListener) {
    window.removeEventListener(ROUTE_CHANGE_EVENT, priorListener as EventListener)
  }

  const bar = document.createElement('aside')
  bar.className = 'publisher-sidebar publisher-glass'

  const header = document.createElement('div')
  header.className = 'publisher-sidebar-header'

  const back = document.createElement('a')
  back.href = '/'
  back.className = 'publisher-sidebar-back'
  back.setAttribute('aria-label', t('publisher.nav.backToTerraviz'))
  back.textContent = '←'
  header.appendChild(back)

  const title = document.createElement('span')
  title.className = 'publisher-sidebar-title'
  title.textContent = t('publisher.portal.title')
  header.appendChild(title)

  bar.appendChild(header)

  const nav = buildNav(activeRouter, options)
  bar.appendChild(nav)
  bar.appendChild(buildFooter(options))

  host.insertBefore(bar, host.firstChild)

  applyActiveState(nav, window.location.pathname)
  const listener = (e: Event): void => {
    const detail = (e as CustomEvent<RouteChangeDetail>).detail
    applyActiveState(nav, detail?.path ?? window.location.pathname)
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
  const bar = host.querySelector('.publisher-sidebar')
  if (bar) bar.remove()
}
