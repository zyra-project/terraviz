/**
 * Publisher portal entry point.
 *
 * Lazy-loaded from `src/main.ts` when the user navigates to a
 * `/publish/*` path. The portal is a small admin UI on top of the
 * already-shipped publisher API (`/api/v1/publish/**`); see
 * [`docs/CATALOG_PUBLISHING_TOOLS.md`](../../../docs/CATALOG_PUBLISHING_TOOLS.md)
 * for the full design.
 *
 * Phase 3pa scaffolding: the lazy chunk, the History API router,
 * and a single placeholder page wired to every route. Real pages
 * land in 3pa/B (i18n keys), 3pa/C (/publish/me content) and the
 * subsequent sub-phases (3pb–3pg).
 *
 * The portal lives behind Cloudflare Access in production
 * (`DEV_BYPASS_ACCESS=true` for local dev). When this entry runs
 * the user is already authenticated; the portal can call
 * `/api/v1/publish/me` immediately to fetch identity.
 */

import { emit } from '../../analytics'
import { logger } from '../../utils/logger'
import { t } from '../../i18n'
import { PublisherRouter, type RouteHandler } from './router'
import { renderOverviewPage } from './pages/overview'
import { renderMePage, localizedRole } from './pages/me'
import { renderDatasetsPage } from './pages/datasets'
import { renderDatasetDetailPage } from './pages/dataset-detail'
import { renderDatasetEditPage } from './pages/dataset-edit'
import { renderDatasetNewPage } from './pages/dataset-new'
import { renderToursPage } from './pages/tours'
import { renderWorkflowsPage } from './pages/workflows'
import { renderWorkflowDetailPage } from './pages/workflow-detail'
import { renderWorkflowEditPage } from './pages/workflow-edit'
import { renderFeaturedHeroPage } from './pages/featured-hero'
import { renderNodeProfilePage } from './pages/node-profile'
import { renderBlogPage } from './pages/blog'
import { renderBlogEditPage } from './pages/blog-edit'
import { renderFeedsPage } from './pages/feeds'
import { renderEventsPage } from './pages/events'
import { renderAnalyticsPage } from './pages/analytics'
import { renderUsersPage } from './pages/users'
import { renderFeedbackPage } from './pages/feedback'
import { renderImportPage } from './pages/import'
import { renderSidebar, type SidebarIdentity } from './components/sidebar'
import { publisherGet } from './api'
import { FEATURES_CHANGE_EVENT, fetchFeatures, fetchPublicOrgName } from './features'
import type { FeatureMap } from '../../types/node-features'
import '../../styles/publisher.css'

const PORTAL_ROOT_ID = 'publisher-root'
const PORTAL_CONTENT_ID = 'publisher-content'

/**
 * Map the visited pathname to the `route` enum the
 * `publisher_portal_loaded` event ships. Anything outside the
 * known sections lands as `unknown` — including the notFound
 * fallback, since a typo'd URL is still a portal-load visit.
 *
 * Exported for the corresponding test; not part of the runtime
 * surface anyone else should import.
 */
export function routeForPath(
  pathname: string,
):
  | 'overview'
  | 'me'
  | 'datasets'
  | 'tours'
  | 'featured_hero'
  | 'node_profile'
  | 'blog'
  | 'events'
  | 'feeds'
  | 'import'
  | 'workflows'
  | 'analytics'
  | 'feedback'
  | 'users'
  | 'unknown' {
  // Normalise a trailing slash so `/publish/` maps to the same route
  // as `/publish` (the router treats them identically).
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  if (path === '/publish' || path.startsWith('/publish/overview')) return 'overview'
  if (path.startsWith('/publish/me')) return 'me'
  if (path.startsWith('/publish/datasets')) return 'datasets'
  if (path.startsWith('/publish/tours')) return 'tours'
  if (path.startsWith('/publish/workflows')) return 'workflows'
  if (path.startsWith('/publish/featured-hero')) return 'featured_hero'
  if (path.startsWith('/publish/node-profile')) return 'node_profile'
  if (path.startsWith('/publish/blog')) return 'blog'
  if (path.startsWith('/publish/events')) return 'events'
  if (path.startsWith('/publish/feeds')) return 'feeds'
  if (path.startsWith('/publish/import')) return 'import'
  if (path.startsWith('/publish/analytics')) return 'analytics'
  if (path.startsWith('/publish/feedback')) return 'feedback'
  if (path.startsWith('/publish/users')) return 'users'
  return 'unknown'
}

/**
 * Resolve (or create) the portal's mount point. The host page
 * (index.html) doesn't include a `#publisher-root` element by
 * default — the SPA-only DOM stays untouched for the 99.9% of
 * visits that never hit `/publish`. When the portal boots it
 * either reuses an existing host node or appends one to `<body>`
 * and hides every SPA-only top-level element so the two trees
 * don't fight for the viewport.
 */
interface PortalMount {
  root: HTMLElement
  content: HTMLElement
}

function ensureMount(): PortalMount {
  let root = document.getElementById(PORTAL_ROOT_ID)
  if (!root) {
    root = document.createElement('div')
    root.id = PORTAL_ROOT_ID
    root.className = 'publisher-portal'
    document.body.appendChild(root)
  }
  // Build (or reuse) the content slot. The topbar mounts ahead of
  // it on each boot via `renderTopbar(root, ...)`; pages render
  // into `content` so a route change replaces page contents
  // without touching the topbar.
  let content = document.getElementById(PORTAL_CONTENT_ID)
  if (!content) {
    // Plain <div>, not <main>. Each page renderer mounts its own
    // <main class="publisher-shell"> inside this wrapper as the
    // page-level landmark; making the wrapper a <main> too would
    // produce nested <main> elements, which screen readers and
    // HTML validators both flag.
    content = document.createElement('div')
    content.id = PORTAL_CONTENT_ID
    content.className = 'publisher-content'
    root.appendChild(content)
  }
  // Hide the SPA's loading splash. It's `position: fixed;
  // z-index: 1000; opacity: 1` and only fades out when the SPA's
  // own boot path adds a `.fade-out` class. Because our route gate
  // skips the SPA boot entirely, the splash would otherwise sit on
  // top of the portal forever.
  const loading = document.getElementById('loading-screen')
  if (loading) loading.style.display = 'none'
  const spa = document.getElementById('app')
  if (spa) spa.style.display = 'none'
  return { root, content }
}

/**
 * Render the placeholder content for any sub-phase that hasn't
 * shipped yet. 3pa wires every route to this — the actual page
 * implementations replace it in 3pa/C onwards.
 *
 * DOM is constructed via createElement + textContent rather than
 * innerHTML so route params (e.g., the `:id` segment) cannot
 * carry HTML into the page. The fixed-shape scaffold doesn't need
 * the convenience of template literals.
 */
function renderPlaceholder(mount: HTMLElement, sectionLabel: string, subPhase: string): void {
  const shell = document.createElement('main')
  shell.className = 'publisher-shell'

  const title = document.createElement('h1')
  title.textContent = t('publisher.portal.title')
  shell.appendChild(title)

  const section = document.createElement('p')
  section.className = 'publisher-section'
  section.textContent = sectionLabel
  shell.appendChild(section)

  const comingSoon = document.createElement('p')
  comingSoon.className = 'publisher-coming-soon'
  comingSoon.textContent = t('publisher.placeholder.comingSoon', { subPhase })
  shell.appendChild(comingSoon)

  mount.replaceChildren(shell)
}

function overviewPage(mount: HTMLElement, router: () => PublisherRouter): RouteHandler {
  return () =>
    renderOverviewPage(mount, {
      routerNavigate: path => void router().navigate(path),
    })
}

function mePage(mount: HTMLElement): RouteHandler {
  return () => renderMePage(mount)
}

function datasetsPage(mount: HTMLElement, router: () => PublisherRouter): RouteHandler {
  return () =>
    renderDatasetsPage(mount, {
      routerNavigate: path => void router().navigate(path),
    })
}

function datasetNewPage(mount: HTMLElement, router: () => PublisherRouter): RouteHandler {
  return () =>
    renderDatasetNewPage(mount, {
      routerNavigate: path => void router().navigate(path),
    })
}

function datasetDetailPage(
  mount: HTMLElement,
  router: () => PublisherRouter,
): RouteHandler {
  return params => {
    const id = params.id ?? ''
    if (!id) {
      renderPlaceholder(mount, t('publisher.section.notFound'), '3pa/A')
      return
    }
    void renderDatasetDetailPage(mount, id, {
      routerNavigate: path => void router().navigate(path),
    })
  }
}

function datasetEditPage(
  mount: HTMLElement,
  router: () => PublisherRouter,
): RouteHandler {
  return params => {
    const id = params.id ?? ''
    if (!id) {
      renderPlaceholder(mount, t('publisher.section.notFound'), '3pa/A')
      return
    }
    void renderDatasetEditPage(mount, id, {
      routerNavigate: path => void router().navigate(path),
    })
  }
}

function toursPage(mount: HTMLElement): RouteHandler {
  // Phase 3pt/A introduced the landing page; tour/G upgrades it
  // to a real list backed by GET /api/v1/publish/tours.
  return () => void renderToursPage(mount)
}

function workflowsPage(mount: HTMLElement, router: () => PublisherRouter): RouteHandler {
  return () =>
    void renderWorkflowsPage(mount, {
      navigate: path => void router().navigate(path),
    })
}

function workflowNewPage(mount: HTMLElement, router: () => PublisherRouter): RouteHandler {
  return () =>
    void renderWorkflowEditPage(mount, null, {
      navigate: path => void router().navigate(path),
    })
}

function workflowDetailPage(
  mount: HTMLElement,
  router: () => PublisherRouter,
): RouteHandler {
  return params => {
    const id = params.id ?? ''
    if (!id) {
      renderPlaceholder(mount, t('publisher.section.notFound'), '3pa/A')
      return
    }
    void renderWorkflowDetailPage(mount, id, {
      navigate: path => void router().navigate(path),
    })
  }
}

function workflowEditPage(
  mount: HTMLElement,
  router: () => PublisherRouter,
): RouteHandler {
  return params => {
    const id = params.id ?? ''
    if (!id) {
      renderPlaceholder(mount, t('publisher.section.notFound'), '3pa/A')
      return
    }
    void renderWorkflowEditPage(mount, id, {
      navigate: path => void router().navigate(path),
    })
  }
}

function importPage(mount: HTMLElement): RouteHandler {
  return () => renderImportPage(mount)
}

function featuredHeroPage(mount: HTMLElement): RouteHandler {
  return () => void renderFeaturedHeroPage(mount)
}

function nodeProfilePage(mount: HTMLElement): RouteHandler {
  return () => void renderNodeProfilePage(mount)
}

function blogPage(mount: HTMLElement, getRouter: () => { navigate: (p: string) => void }): RouteHandler {
  return () => void renderBlogPage(mount, { navigate: p => getRouter().navigate(p) })
}

function blogEditPage(mount: HTMLElement, getRouter: () => { navigate: (p: string) => void }): RouteHandler {
  return params => void renderBlogEditPage(mount, { postId: params.id, navigate: p => getRouter().navigate(p) })
}

function eventsPage(mount: HTMLElement): RouteHandler {
  return () => void renderEventsPage(mount)
}

function feedsPage(mount: HTMLElement): RouteHandler {
  return () => void renderFeedsPage(mount)
}

function analyticsPage(mount: HTMLElement): RouteHandler {
  return () => void renderAnalyticsPage(mount)
}

function usersPage(mount: HTMLElement): RouteHandler {
  return () => void renderUsersPage(mount)
}

function feedbackPage(mount: HTMLElement): RouteHandler {
  return () => void renderFeedbackPage(mount)
}

function notFoundPage(mount: HTMLElement): RouteHandler {
  return () => renderPlaceholder(mount, t('publisher.section.notFound'), '3pa/A')
}

interface PortalChrome {
  isAdmin: boolean
  identity: SidebarIdentity
  eventsBadge: number
  features: FeatureMap
}

/**
 * Best-effort probe that fills in the sidebar's admin-only links,
 * feature-gated links, footer identity, and events badge. Every read
 * degrades safely — the pages and their APIs enforce access
 * independently, so a hidden-but-reachable link (or a missing badge)
 * is harmless. The events count is only fetched for admins with the
 * events feature on (the endpoint 403s otherwise).
 */
async function resolvePortalChrome(): Promise<PortalChrome> {
  // The org name and the toggle map ride the same public
  // node-profile payload, read once through the module cache the
  // gated pages share — one fetch + parse, fail-open to all-enabled.
  const [meRes, orgName, features] = await Promise.all([
    publisherGet<{ role: string; is_admin: boolean; display_name: string }>(
      '/api/v1/publish/me',
    ),
    fetchPublicOrgName(),
    fetchFeatures(),
  ])
  const isAdmin = meRes.ok && (meRes.data.is_admin === true || meRes.data.role === 'admin')
  const identity: SidebarIdentity = {
    orgName,
    displayName: meRes.ok ? meRes.data.display_name : null,
    roleLabel: meRes.ok ? localizedRole(meRes.data.role) : null,
  }
  let eventsBadge = 0
  if (isAdmin && features.events) {
    const ev = await publisherGet<{ events: unknown[] }>('/api/v1/publish/events?status=proposed')
    if (ev.ok && Array.isArray(ev.data.events)) eventsBadge = ev.data.events.length
  }
  return { isAdmin, identity, eventsBadge, features }
}

let activeRouter: PublisherRouter | null = null
let featuresChangeListener: (() => void) | null = null

/**
 * Boot the publisher portal. Idempotent — calling twice reuses the
 * existing router rather than mounting a second one.
 */
export async function bootPublisherPortal(): Promise<void> {
  if (activeRouter) {
    logger.debug('[publisher] bootPublisherPortal called twice; reusing router')
    return
  }

  const { root, content } = ensureMount()
  // Page handlers that need router-driven SPA navigation receive
  // a `() => PublisherRouter` accessor so they see the live
  // router even though it's constructed in the same expression.
  const getRouter = (): PublisherRouter => {
    if (!activeRouter) throw new Error('publisher router not yet initialised')
    return activeRouter
  }
  activeRouter = new PublisherRouter(
    [
      { pattern: '/publish', handler: overviewPage(content, getRouter) },
      { pattern: '/publish/overview', handler: overviewPage(content, getRouter) },
      { pattern: '/publish/me', handler: mePage(content) },
      { pattern: '/publish/datasets', handler: datasetsPage(content, getRouter) },
      // `/publish/datasets/new` must come BEFORE the `:id` pattern
      // — otherwise the matcher captures "new" as the id and
      // routes to the detail page.
      { pattern: '/publish/datasets/new', handler: datasetNewPage(content, getRouter) },
      {
        pattern: '/publish/datasets/:id/edit',
        handler: datasetEditPage(content, getRouter),
      },
      { pattern: '/publish/datasets/:id', handler: datasetDetailPage(content, getRouter) },
      { pattern: '/publish/tours', handler: toursPage(content) },
      { pattern: '/publish/workflows', handler: workflowsPage(content, getRouter) },
      // Like datasets: `/new` must precede the `:id` patterns so
      // the matcher doesn't capture "new" as an id.
      { pattern: '/publish/workflows/new', handler: workflowNewPage(content, getRouter) },
      {
        pattern: '/publish/workflows/:id/edit',
        handler: workflowEditPage(content, getRouter),
      },
      { pattern: '/publish/workflows/:id', handler: workflowDetailPage(content, getRouter) },
      { pattern: '/publish/featured-hero', handler: featuredHeroPage(content) },
      { pattern: '/publish/node-profile', handler: nodeProfilePage(content) },
      { pattern: '/publish/blog/new', handler: blogEditPage(content, getRouter) },
      { pattern: '/publish/blog/:id/edit', handler: blogEditPage(content, getRouter) },
      { pattern: '/publish/blog', handler: blogPage(content, getRouter) },
      { pattern: '/publish/events', handler: eventsPage(content) },
      { pattern: '/publish/feeds', handler: feedsPage(content) },
      { pattern: '/publish/analytics', handler: analyticsPage(content) },
      { pattern: '/publish/feedback', handler: feedbackPage(content) },
      { pattern: '/publish/users', handler: usersPage(content) },
      { pattern: '/publish/import', handler: importPage(content) },
    ],
    notFoundPage(content),
  )
  // Render the sidebar immediately (without admin-only links, footer
  // identity, or the events badge) so the portal never blocks on the
  // network. The chrome probe is best-effort — it fills in admin
  // links, the user footer, and the events count — so we fire it in
  // the background and re-render once it resolves. The pages and APIs
  // gate independently.
  const bootedRouter = activeRouter
  renderSidebar(root, bootedRouter, { isAdmin: false })
  await bootedRouter.start()
  // One emit per portal-chunk load — the publisher visits
  // /publish/*, the chunk resolves, the first route dispatches,
  // we fire. Subsequent in-portal navigation is *not* counted
  // here; the `dwell` tracker (later sub-phases) covers
  // intra-portal time-spent, and `publisher_action` covers writes.
  emit({
    event_type: 'publisher_portal_loaded',
    route: routeForPath(window.location.pathname),
  })
  logger.info('[publisher] portal booted at', window.location.pathname)

  void resolvePortalChrome().then(chrome => {
    // Guard against a teardown (or re-boot) that happened while the
    // probe was in flight — only re-render the sidebar we mounted.
    if (activeRouter === bootedRouter) {
      renderSidebar(root, bootedRouter, chrome)
    }
  })

  // An admin saving the Features card resets the toggle cache and
  // fires this event — re-resolve the chrome so hidden/re-enabled
  // tabs appear without a reload.
  featuresChangeListener = () => {
    if (activeRouter !== bootedRouter) return
    void resolvePortalChrome().then(chrome => {
      if (activeRouter === bootedRouter) renderSidebar(root, bootedRouter, chrome)
    })
  }
  window.addEventListener(FEATURES_CHANGE_EVENT, featuresChangeListener)
}

/** Tear down the portal — only used by tests. */
export function teardownPublisherPortal(): void {
  if (activeRouter) {
    activeRouter.stop()
    activeRouter = null
  }
  if (featuresChangeListener) {
    window.removeEventListener(FEATURES_CHANGE_EVENT, featuresChangeListener)
    featuresChangeListener = null
  }
  const root = document.getElementById(PORTAL_ROOT_ID)
  if (root) root.remove()
  const loading = document.getElementById('loading-screen')
  if (loading) loading.style.display = ''
  const spa = document.getElementById('app')
  if (spa) spa.style.display = ''
}
