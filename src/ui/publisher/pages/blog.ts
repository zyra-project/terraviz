/**
 * /publish/blog — the blog authoring list (Phase 3d;
 * `docs/CURRENT_EVENTS_PLAN.md` §7).
 *
 * Lists every post (drafts included, newest-updated first) with a
 * status badge, linking each row into the editor
 * (`/publish/blog/:id/edit`) plus a "New post" button
 * (`/publish/blog/new`). Privileged-gated client-side — the API
 * enforces 403 on writes independently. Mirrors `tours.ts`.
 */

import { t } from '../../../i18n'
import { publisherGet, handleSessionError } from '../api'
import { buildErrorCard } from '../components/error-card'

interface MeResponse {
  role: string
  is_admin: boolean
}

export interface BlogPostListItem {
  id: string
  slug: string
  title: string
  status: 'draft' | 'published'
  updatedAt: string
  publishedAt: string | null
}

interface BlogListResponse {
  posts: BlogPostListItem[]
}

const ME_ENDPOINT = '/api/v1/publish/me'
const BLOG_ENDPOINT = '/api/v1/publish/blog'

export interface BlogPageOptions {
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
}

function clientIsPrivileged(me: MeResponse): boolean {
  return me.is_admin === true || me.role === 'admin' || me.role === 'service'
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

function shell(...children: HTMLElement[]): HTMLElement {
  const m = el('main', { className: 'publisher-shell' })
  for (const c of children) m.append(c)
  return m
}

function card(...children: HTMLElement[]): HTMLElement {
  const c = el('section', { className: 'publisher-card publisher-glass' })
  for (const child of children) c.append(child)
  return c
}

export async function renderBlogPage(mount: HTMLElement, options: BlogPageOptions = {}): Promise<void> {
  const fetchFn = options.fetchFn
  const navigate = options.navigate ?? ((url: string) => { window.location.href = url })
  mount.replaceChildren(shell(el('p', { className: 'publisher-loading', textContent: t('publisher.blog.loading') })))

  const [meRes, listRes] = await Promise.all([
    publisherGet<MeResponse>(ME_ENDPOINT, { fetchFn }),
    publisherGet<BlogListResponse>(BLOG_ENDPOINT, { fetchFn }),
  ])
  for (const res of [meRes, listRes]) {
    if (res.ok) continue
    if (res.kind === 'session') {
      if (handleSessionError({ navigate: options.navigate }) === 'navigating') return
      mount.replaceChildren(shell(buildErrorCard('session')))
      return
    }
    const details = res.kind === 'server' ? { status: res.status, body: res.body } : {}
    mount.replaceChildren(shell(buildErrorCard(res.kind, details)))
    return
  }
  if (!meRes.ok || !listRes.ok) return

  if (!clientIsPrivileged(meRes.data)) {
    mount.replaceChildren(
      shell(
        card(
          el('h2', { className: 'publisher-card-heading', textContent: t('publisher.blog.title') }),
          el('p', { className: 'publisher-blog-restricted', textContent: t('publisher.blog.restricted') }),
        ),
      ),
    )
    return
  }

  const header = el('div', { className: 'publisher-blog-header' })
  header.append(
    el('div', { className: 'publisher-page-titles' }, [
      el('h2', { className: 'publisher-card-heading', textContent: t('publisher.blog.title') }),
      el('p', { className: 'publisher-page-subtitle', textContent: t('publisher.blog.subtitle') }),
    ]),
  )
  const newBtn = el('button', {
    type: 'button',
    className: 'publisher-button publisher-button-primary publisher-blog-new-btn',
    textContent: t('publisher.blog.new'),
  })
  newBtn.addEventListener('click', () => navigate('/publish/blog/new'))
  header.append(newBtn)

  const body = card(header)
  const posts = listRes.data.posts
  if (posts.length === 0) {
    body.append(el('p', { className: 'publisher-blog-empty', textContent: t('publisher.blog.empty') }))
  } else {
    const table = el('table', { className: 'publisher-table' })
    const thead = el('thead')
    const headRow = el('tr')
    // Deck layout: status badge folded under the title, no standalone
    // Status column.
    for (const key of ['publisher.blog.col.title', 'publisher.blog.col.updated', 'publisher.blog.col.link'] as const) {
      headRow.append(el('th', { textContent: t(key) }))
    }
    thead.append(headRow)
    table.append(thead)
    const tbody = el('tbody')
    for (const post of posts) {
      const tr = el('tr')
      const titleCell = el('td')
      // Title link + status badge stacked (deck fold — no separate
      // Status column).
      const titleStack = el('div', { className: 'publisher-cell-title' })
      const link = el('a', {
        className: 'publisher-row-link',
        href: `/publish/blog/${encodeURIComponent(post.id)}/edit`,
        textContent: post.title,
      })
      link.addEventListener('click', e => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        navigate(`/publish/blog/${encodeURIComponent(post.id)}/edit`)
      })
      titleStack.append(link)
      titleStack.append(
        el('span', {
          className: `publisher-blog-badge publisher-blog-badge-${post.status}`,
          textContent: post.status === 'published' ? t('publisher.blog.status.published') : t('publisher.blog.status.draft'),
        }),
      )
      titleCell.append(titleStack)
      tr.append(titleCell)
      tr.append(el('td', { className: 'publisher-cell-updated', textContent: post.updatedAt.slice(0, 10) }))
      // Actions: Edit (all rows, opens the editor) + View (published
      // only — a public page to link to). Consistent action pills with
      // the other list pages.
      const actionsCell = el('td', { className: 'publisher-cell-actions' })
      const edit = el('a', {
        className: 'publisher-row-action publisher-row-edit',
        href: `/publish/blog/${encodeURIComponent(post.id)}/edit`,
        textContent: t('publisher.blog.list.edit'),
      })
      edit.addEventListener('click', e => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        navigate(`/publish/blog/${encodeURIComponent(post.id)}/edit`)
      })
      actionsCell.append(edit)
      if (post.status === 'published') {
        const view = el('a', {
          className: 'publisher-row-action publisher-blog-view-link',
          href: `/blog/${encodeURIComponent(post.slug)}`,
          textContent: t('publisher.blog.list.view'),
        })
        view.target = '_blank'
        view.rel = 'noopener'
        actionsCell.append(view)
      }
      tr.append(actionsCell)
      tbody.append(tr)
    }
    table.append(tbody)
    body.append(table)
  }

  mount.replaceChildren(shell(body))
}
