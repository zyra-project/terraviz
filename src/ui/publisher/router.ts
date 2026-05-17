/**
 * Tiny History API router for the publisher portal.
 *
 * The portal is a handful of pages (`/publish/me`,
 * `/publish/datasets`, `/publish/datasets/:id`, `/publish/tours`,
 * `/publish/import`) — small enough that a ~50-line router built
 * on `history.pushState` + `popstate` is cheaper than pulling in
 * a router library, and matches the project's "vanilla TS with a
 * few focused libraries" stance.
 *
 * The route table is a plain array of pattern + handler pairs.
 * Patterns may include a single `:id` placeholder; the matched
 * value is passed to the handler as `params.id`. No nested routes,
 * no query parsing — the portal doesn't need them yet.
 *
 * After every successful dispatch the router fires a
 * `publisher:routechange` CustomEvent on `window` with
 * `detail: { path }`. The top nav (and any future cross-page
 * surface) can subscribe to update its own state without holding
 * a reference to the router instance.
 */

import { logger } from '../../utils/logger'

export const ROUTE_CHANGE_EVENT = 'publisher:routechange'
/** Dispatched at the *start* of a route transition, before the
 *  destination handler runs. Subscribers (e.g. the dataset-
 *  detail polling loop) use this to tear down side effects on
 *  the outgoing page before the incoming page renders into the
 *  same mount element. Compare with `ROUTE_CHANGE_EVENT` which
 *  fires *after* the handler resolves — too late to cancel
 *  in-flight work that could clobber the new page's DOM.
 *  PR #112 followup — route-change race on
 *  dataset-detail.ts:682. */
export const ROUTE_CHANGE_START_EVENT = 'publisher:routechange:start'

export interface RouteChangeDetail {
  path: string
}

export interface RouteParams {
  id?: string
}

export type RouteHandler = (params: RouteParams) => void | Promise<void>

export interface Route {
  pattern: string
  handler: RouteHandler
}

/**
 * Match a path against a pattern containing at most one `:id`
 * placeholder. Returns the extracted params on match, or `null`.
 *
 * Both pattern and path are normalised by stripping any trailing
 * slash so `/publish/datasets` and `/publish/datasets/` are
 * equivalent. The root `/` is the one exception — it's preserved
 * as `/`.
 */
export function matchRoute(pattern: string, path: string): RouteParams | null {
  const norm = (s: string) => (s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s)
  const pat = norm(pattern)
  const p = norm(path)

  const patSegs = pat.split('/')
  const pathSegs = p.split('/')
  if (patSegs.length !== pathSegs.length) return null

  const params: RouteParams = {}
  for (let i = 0; i < patSegs.length; i++) {
    if (patSegs[i] === ':id') {
      if (!pathSegs[i]) return null
      // `decodeURIComponent` throws on malformed percent-encoding
      // (e.g. a stray `%E0%A4` from a pasted URL). Treating that as
      // a non-match — letting the notFound handler run — is far
      // friendlier than letting the URIError abort the whole
      // dispatch and stranding the publisher on a blank page.
      try {
        params.id = decodeURIComponent(pathSegs[i])
      } catch {
        return null
      }
    } else if (patSegs[i] !== pathSegs[i]) {
      return null
    }
  }
  return params
}

export class PublisherRouter {
  private routes: Route[]
  private notFound: RouteHandler
  private boundPopState = (): void => {
    void this.dispatch()
  }

  constructor(routes: Route[], notFound: RouteHandler) {
    this.routes = routes
    this.notFound = notFound
  }

  /** Begin listening for navigation and dispatch the current URL. */
  start(): Promise<void> {
    window.addEventListener('popstate', this.boundPopState)
    return this.dispatch()
  }

  /** Stop listening; safe to call multiple times. Used in tests. */
  stop(): void {
    window.removeEventListener('popstate', this.boundPopState)
  }

  /**
   * Navigate to a new path. Calls `pushState` so back/forward work,
   * then dispatches. No-op if the path is the current location.
   */
  navigate(path: string): Promise<void> {
    if (path === window.location.pathname + window.location.search) {
      return Promise.resolve()
    }
    window.history.pushState({}, '', path)
    return this.dispatch()
  }

  /** Dispatch the current `location.pathname` to its route handler. */
  async dispatch(): Promise<void> {
    const path = window.location.pathname
    // Fire the *start* event before the handler runs so listeners
    // can tear down in-flight side effects (e.g. the dataset-
    // detail polling loop) before the destination page mounts
    // into the same content element. The `end` event below fires
    // after the handler resolves — that's the topbar's cue to
    // refresh active-tab state, but it's too late to cancel
    // racing paint() calls from the outgoing page.
    window.dispatchEvent(
      new CustomEvent<RouteChangeDetail>(ROUTE_CHANGE_START_EVENT, {
        detail: { path },
      }),
    )
    let handled = false
    for (const route of this.routes) {
      const params = matchRoute(route.pattern, path)
      if (params) {
        try {
          await route.handler(params)
        } catch (err) {
          logger.error('[publisher] route handler failed', route.pattern, err)
        }
        handled = true
        break
      }
    }
    if (!handled) {
      // Same try/catch the matched-route branch above uses — a
      // throwing notFound handler shouldn't suppress the
      // route-change event (the topbar listens for it to refresh
      // its active-tab state and would otherwise stay stale).
      try {
        await this.notFound({})
      } catch (err) {
        logger.error('[publisher] notFound handler failed', err)
      }
    }
    window.dispatchEvent(
      new CustomEvent<RouteChangeDetail>(ROUTE_CHANGE_EVENT, {
        detail: { path },
      }),
    )
  }
}
