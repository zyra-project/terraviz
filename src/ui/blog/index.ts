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
 * Static content pages — no router; navigation is plain links.
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
  datasets: Array<{ id: string; title: string }>
  event: { id: string; title: string; sourceName: string; sourceUrl: string; imageUrl?: string | null } | null
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

/**
 * Fetch the public host-org identity for the header. Degrades to
 * null on any failure — the header just shows the app title. The
 * logo URL is re-guarded to http(s) client-side before it reaches an
 * `<img src>`, mirroring the events-source sanitize discipline.
 */
async function fetchIdentity(): Promise<PublicIdentity | null> {
  try {
    const res = await fetch('/api/v1/node-profile')
    if (!res.ok) return null
    const { profile } = (await res.json()) as { profile: PublicIdentity | null }
    if (!profile || typeof profile.orgName !== 'string' || !profile.orgName) return null
    const logoUrl =
      typeof profile.logoUrl === 'string' && /^https?:\/\//i.test(profile.logoUrl) ? profile.logoUrl : null
    return { orgName: profile.orgName, logoUrl }
  } catch {
    return null
  }
}

/** The shared page chrome: a header linking home + back to the list,
 *  with the host org's logo when one is configured. */
function chrome(content: HTMLElement, identity: PublicIdentity | null = null): HTMLElement {
  const root = el('div', { className: 'blog-root' })
  const header = el('header', { className: 'blog-header' })
  const home = el('a', { className: 'blog-home-link', href: '/' })
  if (identity?.logoUrl) {
    home.append(el('img', { className: 'blog-logo', src: identity.logoUrl, alt: identity.orgName }))
  }
  home.append(el('span', { textContent: identity?.orgName ?? t('app.title') }))
  const index = el('a', { className: 'blog-index-link', href: '/blog', textContent: t('blog.public.indexLink') })
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
    const card = el('a', { className: 'blog-card', href: `/blog/${encodeURIComponent(post.slug)}` })
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

  // Lead image: the cited event's vetted story image (feed enclosure /
  // og:image / curator pick), captioned with the citation it came
  // from. http(s) re-guarded client-side before it reaches <img src>.
  if (post.event?.imageUrl && /^https?:\/\//i.test(post.event.imageUrl)) {
    const figure = el('figure', { className: 'blog-post-figure' })
    const img = el('img', {
      className: 'blog-post-image',
      src: post.event.imageUrl,
      alt: post.event.title,
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
      el('a', {
        className: 'blog-post-tour-btn',
        href: `/?tour=${encodeURIComponent(post.tour.id)}`,
        textContent: t('blog.public.playTour'),
      }),
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
      li.append(el('a', { href: `/dataset/${encodeURIComponent(d.id)}`, textContent: d.title }))
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
  wrap.append(el('p', {}, [el('a', { href: '/blog', textContent: t('blog.public.missing.back') })]))
  return wrap
}

/** Entry point — called from main.ts's `/blog` route gate. */
export async function bootBlogPage(): Promise<void> {
  document.body.replaceChildren(chrome(el('p', { className: 'blog-loading', textContent: t('blog.public.loading') })))
  document.body.classList.add('blog-body')

  const path = location.pathname.replace(/\/+$/, '')
  // Kicked off alongside the content fetch; never rejects.
  const identityPromise = fetchIdentity()

  try {
    // Inside the try so a malformed percent-encoding (`/blog/%E0%A4`)
    // renders the missing view instead of throwing out of the boot.
    const slug = path === '/blog' ? null : decodeURIComponent(path.slice('/blog/'.length))
    if (!slug) {
      const res = await fetch('/api/v1/blog')
      const { posts } = (await res.json()) as { posts: PublicPostCard[] }
      document.body.replaceChildren(chrome(renderList(posts), await identityPromise))
      return
    }
    const res = await fetch(`/api/v1/blog/${encodeURIComponent(slug)}`)
    if (!res.ok) {
      document.body.replaceChildren(chrome(renderMissing(), await identityPromise))
      return
    }
    const { post } = (await res.json()) as { post: PublicPost }
    document.title = post.title // i18n-exempt: the post's own title, already localized content
    document.body.replaceChildren(chrome(renderPost(post), await identityPromise))
  } catch {
    document.body.replaceChildren(chrome(renderMissing(), await identityPromise))
  }
}
