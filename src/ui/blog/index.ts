// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Public blog surface (Phase 3d; `docs/CURRENT_EVENTS_PLAN.md` §7).
 *
 * Booted by `main.ts` on `/blog` and `/blog/:slug` — the same
 * lazy-chunk gate the publisher portal uses, so catalog visitors never
 * pay this bundle's cost. Reads the public, KV-cached endpoints
 * shipped in the blog data layer:
 *
 *   - `/blog`       → `GET /api/v1/blog` — published-post cards.
 *   - `/blog/:slug` → `GET /api/v1/blog/:slug` — the full post:
 *     markdown body rendered through the shared sanitized pipeline,
 *     the "Explore the data" list linking each cited dataset into the
 *     globe (`/dataset/:id` deep links), and the cited event's source
 *     attribution (only present while that event is approved).
 *
 * Static content pages — no router; navigation is plain links. Every
 * link that loads a page of this app carries the address's
 * `telemetry` switch (`appLink`), since the next page reads it afresh
 * (`src/analytics/pageOptOut.ts`).
 */

import { t } from '../../i18n'
import { renderMarkdown } from '../../services/markdownRenderer'
import '../../styles/blog.css'

/** The lean host-org identity from `GET /api/v1/node-profile`. */
interface PublicIdentity {
  orgName: string
  logoUrl: string | null
}

interface PublicPostCard {
  slug: string
  title: string
  summary: string | null
  publishedAt: string | null
  datasetCount: number
}

interface PublicPost {
  slug: string
  title: string
  summary: string | null
  bodyMd: string
  publishedAt: string | null
  /** The post's own curator-picked lead image (Media tab), preferred
   *  over the cited event's story image. http(s)-guarded server-side
   *  and re-guarded here before it reaches an `<img src>`. */
  coverImageUrl?: string | null
  coverImageAlt?: string | null
  datasets: Array<{ id: string; title: string }>
  event: { id: string; title: string; sourceName: string; sourceUrl: string; imageUrl?: string | null; imageAlt?: string | null } | null
  /** The published companion tour, when one exists and is playable. */
  tour?: { id: string } | null
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  children: (HTMLElement | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  Object.assign(node, props)
  for (const c of children) node.append(c)
  return node
}

/** The two parts of an address that can carry `telemetry`. */
export interface AddressParts {
  /** `location.search`, or `''`. */
  search: string
  /** `location.hash`, or `''`. */
  hash: string
}

/** The address this page loaded at, set by `bootBlogPage`. */
let bootAddress: AddressParts = { search: '', hash: '' }

/** The `telemetry` values in one part of an address (`?…` or `#…`). */
function telemetryValues(part: string): string[] {
  return new URLSearchParams(part.replace(/^[?#]/, '')).getAll('telemetry')
}

/** `extra` joined onto one part of an address with `&`, or as the
 *  whole part when it is empty. */
function joinPart(part: string, extra: string): string {
  return part === '' || part.endsWith('&') ? `${part}${extra}` : `${part}&${extra}`
}

/**
 * `dest`, a path on this site, with the `telemetry` values of this
 * page's address added in the part each came from: a query value to
 * the query, a value after `#` to the part after `#`. Only that key
 * travels. The blog holds no catalog, layout or tour state for the next
 * page to keep, the part after `#` on a post is more often an anchor
 * than a setting, and `telemetry` is the one key whose loss changes
 * what the next page sends.
 *
 * The values are those of the address the page loaded at **and** of
 * the address now, without repeats. The page reads the switch once and
 * keeps it for its life, so a link has to carry what it loaded with
 * even after an in-page anchor has replaced the part after `#`; and a
 * host that sets `#telemetry=0` after the page loaded has asked the
 * next page not to report. Carrying both can only turn reporting off,
 * as the switch itself can only lower. A value the destination already
 * carries in that part is not added twice.
 */
export function carryTelemetry(dest: string, now: AddressParts, boot: AddressParts): string {
  const hashAt = dest.indexOf('#')
  let path = hashAt < 0 ? dest : dest.slice(0, hashAt)
  let fragment = hashAt < 0 ? '' : dest.slice(hashAt + 1)
  const queryAt = path.indexOf('?')
  const query = queryAt < 0 ? '' : path.slice(queryAt + 1)

  const missing = (from: string[], present: string): string[] => {
    const have = new Set(telemetryValues(present))
    return [...new Set(from)].filter((value) => !have.has(value))
  }
  const toQuery = missing([...telemetryValues(boot.search), ...telemetryValues(now.search)], query)
  const toFragment = missing([...telemetryValues(boot.hash), ...telemetryValues(now.hash)], fragment)
  const pairs = (values: string[]): string =>
    new URLSearchParams(values.map((value) => ['telemetry', value])).toString()

  if (toQuery.length > 0) {
    path = queryAt < 0 ? `${path}?${pairs(toQuery)}` : `${path.slice(0, queryAt)}?${joinPart(query, pairs(toQuery))}`
  }
  if (toFragment.length > 0) fragment = joinPart(fragment, pairs(toFragment))
  return fragment ? `${path}#${fragment}` : path
}

/**
 * Point `link` at `dest`, a page of this app, carrying the address's
 * `telemetry` switch (`carryTelemetry`). The `href` is the real
 * destination, so a middle click, "Open link in new tab" or a copied
 * link carries it too, and it is rebuilt as the visitor reaches for the
 * link, the way the info panel's related links are
 * (`src/services/datasetLoader.ts`), since the part after `#` can
 * change after the page has rendered. `click` covers a link followed
 * from the keyboard, whose `focus` may have come before the change.
 */
function appLink(link: HTMLAnchorElement, dest: string): HTMLAnchorElement {
  // Written only when it changes, so the usual case, an address that
  // has not moved since render, touches nothing assistive tech watches.
  const refresh = (): void => {
    const next = carryTelemetry(dest, { search: location.search, hash: location.hash }, bootAddress)
    if (link.getAttribute('href') !== next) link.setAttribute('href', next)
  }
  refresh()
  for (const type of ['pointerdown', 'focus', 'contextmenu', 'click'] as const) {
    link.addEventListener(type, refresh)
  }
  return link
}

/**
 * Give the links in a rendered post body that load a page of this site
 * the address's `telemetry` switch. A link to another site is left
 * alone, so the switch never leaves the node; so is one that only moves
 * within this page (`#…`), which loads nothing. The body's links are
 * already sanitized (`sanitizeMarkdownHtml` keeps `http(s):`, `mailto:`,
 * `/` and `#`), and a protocol-relative `//host/…` resolves to its own
 * host's origin here, so one naming another site is left alone too.
 */
function carryTelemetryInBody(body: HTMLElement): void {
  for (const link of body.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const raw = (link.getAttribute('href') ?? '').trim()
    if (raw.startsWith('#')) continue
    let url: URL
    try {
      url = new URL(raw, location.href)
    } catch {
      continue
    }
    // The protocol test as well as the origin: an opaque origin (a
    // sandboxed frame) is "null", and so is a `mailto:` link's.
    if (!/^https?:$/.test(url.protocol) || url.origin !== location.origin) continue
    appLink(link, `${url.pathname}${url.search}${url.hash}`)
  }
}

/**
 * Fetch the public host-org identity for the header, plus whether the
 * node's blog feature is enabled (the same payload carries the
 * feature toggles). Degrades to a null identity + blog-enabled on any
 * failure — the header just shows the app title, and a storage blip
 * never blanks the blog (fail-open, matching the server-side gate;
 * the gated API reads are the real enforcement). The logo URL is
 * re-guarded to http(s) client-side before it reaches an `<img src>`,
 * mirroring the events-source sanitize discipline.
 */
async function fetchIdentity(): Promise<{ identity: PublicIdentity | null; blogEnabled: boolean }> {
  try {
    const res = await fetch('/api/v1/node-profile')
    if (!res.ok) return { identity: null, blogEnabled: true }
    const { profile, features } = (await res.json()) as {
      profile: PublicIdentity | null
      features?: { blog?: unknown }
    }
    const blogEnabled = features?.blog !== false
    if (!profile || typeof profile.orgName !== 'string' || !profile.orgName) {
      return { identity: null, blogEnabled }
    }
    const logoUrl =
      typeof profile.logoUrl === 'string' && /^https?:\/\//i.test(profile.logoUrl) ? profile.logoUrl : null
    return { identity: { orgName: profile.orgName, logoUrl }, blogEnabled }
  } catch {
    return { identity: null, blogEnabled: true }
  }
}

/** The shared page chrome: a header linking home + back to the list,
 *  with the host org's logo when one is configured. */
function chrome(content: HTMLElement, identity: PublicIdentity | null = null): HTMLElement {
  const root = el('div', { className: 'blog-root' })
  const header = el('header', { className: 'blog-header' })
  const home = appLink(el('a', { className: 'blog-home-link' }), '/')
  if (identity?.logoUrl) {
    home.append(el('img', { className: 'blog-logo', src: identity.logoUrl, alt: identity.orgName }))
  }
  home.append(el('span', { textContent: identity?.orgName ?? t('app.title') }))
  const index = appLink(el('a', { className: 'blog-index-link', textContent: t('blog.public.indexLink') }), '/blog')
  header.append(home, index)
  const main = el('main', { className: 'blog-main' })
  main.append(content)
  root.append(header, main)
  return root
}

function dateLabel(iso: string | null): string {
  return iso ? iso.slice(0, 10) : ''
}

function renderList(posts: PublicPostCard[]): HTMLElement {
  const wrap = el('div', { className: 'blog-list' })
  wrap.append(el('h1', { className: 'blog-list-title', textContent: t('blog.public.title') }))
  if (posts.length === 0) {
    wrap.append(el('p', { className: 'blog-empty', textContent: t('blog.public.empty') }))
    return wrap
  }
  for (const post of posts) {
    const card = appLink(el('a', { className: 'blog-card' }), `/blog/${encodeURIComponent(post.slug)}`)
    card.append(el('h2', { className: 'blog-card-title', textContent: post.title }))
    if (post.summary) card.append(el('p', { className: 'blog-card-summary', textContent: post.summary }))
    const meta = el('p', { className: 'blog-card-meta' })
    meta.textContent = post.datasetCount > 0
      ? t('blog.public.cardMeta', { date: dateLabel(post.publishedAt), count: String(post.datasetCount) })
      : dateLabel(post.publishedAt)
    card.append(meta)
    wrap.append(card)
  }
  return wrap
}

function renderPost(post: PublicPost): HTMLElement {
  const wrap = el('article', { className: 'blog-post' })
  wrap.append(el('h1', { className: 'blog-post-title', textContent: post.title }))
  const meta = el('p', { className: 'blog-post-meta', textContent: dateLabel(post.publishedAt) })
  wrap.append(meta)
  if (post.summary) wrap.append(el('p', { className: 'blog-post-summary', textContent: post.summary }))

  // Lead image. The post's own cover (curator pick from the Media tab)
  // wins; otherwise fall back to the cited event's vetted story image,
  // captioned with the citation it came from. http(s) re-guarded
  // client-side before either reaches <img src>.
  const cover = post.coverImageUrl && /^https?:\/\//i.test(post.coverImageUrl) ? post.coverImageUrl : null
  const eventImage = post.event?.imageUrl && /^https?:\/\//i.test(post.event.imageUrl) ? post.event.imageUrl : null
  if (cover) {
    const figure = el('figure', { className: 'blog-post-figure' })
    const img = el('img', {
      className: 'blog-post-image',
      src: cover,
      alt: post.coverImageAlt ?? post.title,
      loading: 'lazy',
    })
    img.addEventListener('error', () => figure.remove())
    figure.append(img)
    wrap.append(figure)
  } else if (eventImage && post.event) {
    const figure = el('figure', { className: 'blog-post-figure' })
    const img = el('img', {
      className: 'blog-post-image',
      src: eventImage,
      alt: post.event.imageAlt ?? post.event.title,
      loading: 'lazy',
    })
    // A dead image link should drop the whole figure, caption included.
    img.addEventListener('error', () => figure.remove())
    figure.append(
      img,
      el('figcaption', {
        className: 'blog-post-figcaption',
        textContent: `${post.event.title} — ${post.event.sourceName}`,
      }),
    )
    wrap.append(figure)
  }

  const body = el('div', { className: 'blog-post-body' })
  // renderMarkdown runs `marked` then sanitizeMarkdownHtml — safe to
  // set as innerHTML (XSS-tested in markdownRenderer.test.ts).
  body.innerHTML = renderMarkdown(post.bodyMd)
  carryTelemetryInBody(body)
  wrap.append(body)

  if (post.event) {
    const cite = el('p', { className: 'blog-post-citation' })
    cite.append(t('blog.public.citation') + ' ')
    const link = el('a', {
      href: post.event.sourceUrl,
      textContent: `${post.event.title} — ${post.event.sourceName}`,
    })
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    cite.append(link)
    wrap.append(cite)
  }

  if (post.tour?.id) {
    // `?tour=` boots the globe with the tour playing (posterDeepLinks
    // resolves published catalog tours by id).
    const tourWrap = el('p', { className: 'blog-post-tour' })
    tourWrap.append(
      appLink(
        el('a', { className: 'blog-post-tour-btn', textContent: t('blog.public.playTour') }),
        `/?tour=${encodeURIComponent(post.tour.id)}`,
      ),
    )
    wrap.append(tourWrap)
  }

  if (post.datasets.length > 0) {
    const explore = el('section', { className: 'blog-post-explore' })
    explore.append(el('h2', { className: 'blog-post-explore-title', textContent: t('blog.public.explore') }))
    const list = el('ul', { className: 'blog-post-explore-list' })
    for (const d of post.datasets) {
      const li = el('li')
      // `/dataset/:id` deep links boot the globe with the dataset
      // loaded (deepLinkService handles the path on SPA start).
      li.append(appLink(el('a', { textContent: d.title }), `/dataset/${encodeURIComponent(d.id)}`))
      list.append(li)
    }
    explore.append(list)
    wrap.append(explore)
  }
  return wrap
}

function renderMissing(): HTMLElement {
  const wrap = el('div', { className: 'blog-missing' })
  wrap.append(el('h1', { textContent: t('blog.public.missing.title') }))
  wrap.append(el('p', {}, [appLink(el('a', { textContent: t('blog.public.missing.back') }), '/blog')]))
  return wrap
}

/** Entry point — called from main.ts's `/blog` route gate. */
export async function bootBlogPage(): Promise<void> {
  // First, before anything renders a link: `appLink` carries what the
  // page loaded with as well as what the address says now.
  bootAddress = { search: location.search, hash: location.hash }
  document.body.replaceChildren(chrome(el('p', { className: 'blog-loading', textContent: t('blog.public.loading') })))
  document.body.classList.add('blog-body')

  const path = location.pathname.replace(/\/+$/, '')
  // Kicked off alongside the content fetch; never rejects.
  const identityPromise = fetchIdentity()

  try {
    // Inside the try so a malformed percent-encoding (`/blog/%E0%A4`)
    // renders the missing view instead of throwing out of the boot.
    const slug = path === '/blog' ? null : decodeURIComponent(path.slice('/blog/'.length))
    const { identity, blogEnabled } = await identityPromise
    // Blog toggled off for this node: render the missing view for both
    // routes (the gated APIs — empty list / slug 404 — are the backstop).
    if (!blogEnabled) {
      document.body.replaceChildren(chrome(renderMissing(), identity))
      return
    }
    if (!slug) {
      const res = await fetch('/api/v1/blog')
      const { posts } = (await res.json()) as { posts: PublicPostCard[] }
      document.body.replaceChildren(chrome(renderList(posts), identity))
      return
    }
    const res = await fetch(`/api/v1/blog/${encodeURIComponent(slug)}`)
    if (!res.ok) {
      document.body.replaceChildren(chrome(renderMissing(), identity))
      return
    }
    const { post } = (await res.json()) as { post: PublicPost }
    document.title = post.title // i18n-exempt: the post's own title, already localized content
    document.body.replaceChildren(chrome(renderPost(post), identity))
  } catch {
    document.body.replaceChildren(chrome(renderMissing(), (await identityPromise).identity))
  }
}
