import { describe, expect, it, vi } from 'vitest'
import { renderToursPage } from './tours'
import type { TourListItem } from '../../tourAuthoring/api'

function makeTour(overrides: Partial<TourListItem> = {}): TourListItem {
  return {
    id: '01HXAAAAAAAAAAAAAAAAAAAAAA',
    slug: 'sample-tour',
    title: 'Sample tour',
    description: null,
    tour_json_ref: 'r2:tours/01HXAAAAAAAAAAAAAAAAAAAAAA/draft.json',
    thumbnail_ref: null,
    visibility: 'public',
    updated_at: '2026-05-21T12:00:00.000Z',
    published_at: null,
    publisher_id: 'PUB-STAFF',
    ...overrides,
  }
}

describe('renderToursPage (tour/A → /G)', () => {
  it('renders the empty-state shell when the list is empty', async () => {
    const content = document.createElement('div')
    await renderToursPage(content, {
      navigate: () => {},
      createDraft: vi.fn(),
      listFn: vi.fn(async () => ({ tours: [], next_cursor: null })),
    })
    expect(content.querySelector('h2')?.textContent).toBe('Tours')
    expect(content.querySelector('.publisher-empty')?.textContent).toContain('No tours yet')
  })

  it('renders a table of tours when the list has rows', async () => {
    const content = document.createElement('div')
    await renderToursPage(content, {
      navigate: () => {},
      createDraft: vi.fn(),
      listFn: vi.fn(async () => ({
        tours: [
          makeTour({ id: '01HX01', title: 'Draft one' }),
          makeTour({
            id: '01HX02',
            title: 'Published one',
            published_at: '2026-05-21T13:00:00Z',
          }),
        ],
        next_cursor: null,
      })),
    })
    const rows = content.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Draft one')
    expect(rows[0].textContent).toContain('Draft')
    expect(rows[1].textContent).toContain('Published one')
    expect(rows[1].textContent).toContain('Published')
  })

  it('Edit / title link navigates to /?tourEdit=<id>', async () => {
    const content = document.createElement('div')
    const navigate = vi.fn()
    await renderToursPage(content, {
      navigate,
      createDraft: vi.fn(),
      listFn: vi.fn(async () => ({
        tours: [makeTour({ id: '01HX_T1' })],
        next_cursor: null,
      })),
    })
    content.querySelector<HTMLAnchorElement>('.publisher-row-link')!.click()
    expect(navigate).toHaveBeenCalledWith('/?tourEdit=01HX_T1')
  })

  it('POSTs /publish/tours/draft and navigates to /?tourEdit=<new-id> on New tour click', async () => {
    const content = document.createElement('div')
    const navigate = vi.fn()
    const createDraft = vi.fn(async () => ({
      tour: {
        id: '01HXAAAAAAAAAAAAAAAAAAAAAA',
        slug: 'untitled-tour-aaaaaa',
        title: 'Untitled tour AAAAAA',
        tour_json_ref: 'r2:tours/01HXAAAAAAAAAAAAAAAAAAAAAA/draft.json',
        updated_at: '2026-05-21T20:30:00.000Z',
      },
    }))
    await renderToursPage(content, {
      navigate,
      createDraft,
      listFn: vi.fn(async () => ({ tours: [], next_cursor: null })),
    })
    content
      .querySelector<HTMLButtonElement>('button[aria-label="Start a new tour"]')!
      .click()
    await Promise.resolve()
    await Promise.resolve()
    expect(createDraft).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith('/?tourEdit=01HXAAAAAAAAAAAAAAAAAAAAAA')
  })

  it('surfaces a list-fetch error inline', async () => {
    const content = document.createElement('div')
    await renderToursPage(content, {
      navigate: () => {},
      createDraft: vi.fn(),
      listFn: vi.fn(async () => ({
        error: 'Network unavailable',
        kind: 'network' as const,
      })),
    })
    expect(content.querySelector('.publisher-empty')?.textContent).toContain(
      'Network unavailable',
    )
  })

  it('delegates session errors to the shared warmup handler', async () => {
    // Phase 3pt-review/H — mirrors the /publish/datasets pattern.
    // A `kind: 'session'` from listTours triggers the auto-warmup
    // redirect via `handleSessionError`; the page deliberately
    // renders nothing afterwards because the navigation has
    // already unmounted it. Copilot discussion_r3291171442.
    window.history.replaceState(null, '', '/publish/tours')
    sessionStorage.clear()
    const content = document.createElement('div')
    const navigate = vi.fn()
    await renderToursPage(content, {
      navigate,
      createDraft: vi.fn(),
      listFn: vi.fn(async () => ({
        error: 'Session expired — please sign in again',
        kind: 'session' as const,
      })),
    })
    expect(navigate).toHaveBeenCalledOnce()
    expect(content.querySelector('.publisher-empty')).toBeNull()
  })

  it('marks table headers with scope="col" for screen-reader navigation', async () => {
    const content = document.createElement('div')
    await renderToursPage(content, {
      navigate: () => {},
      createDraft: vi.fn(),
      listFn: vi.fn(async () => ({
        tours: [makeTour({ id: '01HX01' })],
        next_cursor: null,
      })),
    })
    const ths = content.querySelectorAll('thead th')
    expect(ths.length).toBeGreaterThan(0)
    ths.forEach(th => expect(th.getAttribute('scope')).toBe('col'))
  })

  it('clears prior content (idempotent re-render)', async () => {
    const content = document.createElement('div')
    content.innerHTML = '<div class="stale">stale</div>'
    await renderToursPage(content, {
      navigate: () => {},
      createDraft: vi.fn(),
      listFn: vi.fn(async () => ({ tours: [], next_cursor: null })),
    })
    expect(content.querySelector('.stale')).toBeNull()
    expect(content.querySelector('.publisher-shell')).toBeTruthy()
  })

  describe('Delete (tour/G)', () => {
    it('confirms first, then DELETEs and removes the row on success', async () => {
      const content = document.createElement('div')
      const deleteFn = vi.fn(async () => ({ deleted_id: '01HX_T1' }))
      const confirm = vi.fn<(message: string) => boolean>(() => true)
      await renderToursPage(content, {
        navigate: () => {},
        createDraft: vi.fn(),
        listFn: vi.fn(async () => ({
          tours: [makeTour({ id: '01HX_T1', title: 'Goodbye tour' })],
          next_cursor: null,
        })),
        deleteFn,
        confirm,
      })
      const deleteBtn = content.querySelector<HTMLButtonElement>(
        '.publisher-row-delete',
      )!
      deleteBtn.click()
      expect(confirm).toHaveBeenCalledOnce()
      expect(confirm.mock.calls[0]?.[0]).toContain('Goodbye tour')
      // Microtask pumps for the async delete + DOM removal.
      await Promise.resolve()
      await Promise.resolve()
      expect(deleteFn).toHaveBeenCalledWith('01HX_T1')
      expect(content.querySelector('tbody tr')).toBeNull()
    })

    it('does not DELETE when the publisher cancels the confirm', async () => {
      const content = document.createElement('div')
      const deleteFn = vi.fn()
      await renderToursPage(content, {
        navigate: () => {},
        createDraft: vi.fn(),
        listFn: vi.fn(async () => ({
          tours: [makeTour({ id: '01HX_T1' })],
          next_cursor: null,
        })),
        deleteFn,
        confirm: () => false,
      })
      content.querySelector<HTMLButtonElement>('.publisher-row-delete')!.click()
      await Promise.resolve()
      expect(deleteFn).not.toHaveBeenCalled()
      // Row stays.
      expect(content.querySelectorAll('tbody tr')).toHaveLength(1)
    })

    it('surfaces a server error inline and keeps the row visible', async () => {
      const content = document.createElement('div')
      const deleteFn = vi.fn(async () => ({ error: 'Server error (500)' }))
      await renderToursPage(content, {
        navigate: () => {},
        createDraft: vi.fn(),
        listFn: vi.fn(async () => ({
          tours: [makeTour({ id: '01HX_T1' })],
          next_cursor: null,
        })),
        deleteFn,
        confirm: () => true,
      })
      const deleteBtn = content.querySelector<HTMLButtonElement>(
        '.publisher-row-delete',
      )!
      deleteBtn.click()
      await Promise.resolve()
      await Promise.resolve()
      expect(content.querySelectorAll('tbody tr')).toHaveLength(1)
      expect(
        content.querySelector('.publisher-row-action-status')?.textContent,
      ).toContain('Server error')
      expect(deleteBtn.disabled).toBe(false)
    })
  })
})
