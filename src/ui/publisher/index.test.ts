import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../analytics', () => ({
  emit: vi.fn(),
}))

import { emit } from '../../analytics'
import {
  bootPublisherPortal,
  teardownPublisherPortal,
  routeForPath,
} from './index'

describe('routeForPath', () => {
  it.each<[string, ReturnType<typeof routeForPath>]>([
    ['/publish', 'me'],
    ['/publish/me', 'me'],
    ['/publish/me/', 'me'],
    ['/publish/datasets', 'datasets'],
    ['/publish/datasets/abc-123', 'datasets'],
    ['/publish/tours', 'tours'],
    ['/publish/import', 'import'],
    ['/publish/analytics', 'analytics'],
    ['/publish/feedback', 'feedback'],
    ['/publish/anything-else', 'unknown'],
    ['/publish/random/path', 'unknown'],
  ])('maps %s → %s', (path, expected) => {
    expect(routeForPath(path)).toBe(expected)
  })
})

describe('bootPublisherPortal', () => {
  const originalPath = window.location.pathname

  beforeEach(() => {
    vi.mocked(emit).mockClear()
  })

  afterEach(() => {
    teardownPublisherPortal()
    window.history.replaceState(null, '', originalPath)
  })

  it('emits publisher_portal_loaded with the visited route', async () => {
    window.history.replaceState(null, '', '/publish/me')
    await bootPublisherPortal()
    expect(emit).toHaveBeenCalledWith({
      event_type: 'publisher_portal_loaded',
      route: 'me',
    })
  })

  it('emits route=datasets when landing on /publish/datasets/:id', async () => {
    window.history.replaceState(null, '', '/publish/datasets/abc-123')
    await bootPublisherPortal()
    expect(emit).toHaveBeenCalledWith({
      event_type: 'publisher_portal_loaded',
      route: 'datasets',
    })
  })

  it('emits route=unknown for an unknown portal path', async () => {
    window.history.replaceState(null, '', '/publish/no-such-route')
    await bootPublisherPortal()
    expect(emit).toHaveBeenCalledWith({
      event_type: 'publisher_portal_loaded',
      route: 'unknown',
    })
  })

  it('does not double-emit on a second boot call (idempotent)', async () => {
    window.history.replaceState(null, '', '/publish/tours')
    await bootPublisherPortal()
    expect(vi.mocked(emit)).toHaveBeenCalledTimes(1)
    await bootPublisherPortal()
    expect(vi.mocked(emit)).toHaveBeenCalledTimes(1)
  })
})
