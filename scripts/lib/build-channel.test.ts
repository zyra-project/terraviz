// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { resolveBuildChannel } from './build-channel'

// `resolveBuildChannel` decides the `session_start.build_channel` a
// bundle reports. The dev server's default is what lets a contributor's
// own rows be told from visitors when they send at all (#531).
describe('resolveBuildChannel', () => {
  it('is internal under the dev server and public for a build when nothing is set', () => {
    expect(resolveBuildChannel({}, 'development')).toBe('internal')
    expect(resolveBuildChannel({}, 'production')).toBe('public')
  })

  it('treats any mode other than development as a build', () => {
    expect(resolveBuildChannel({}, 'test')).toBe('public')
    expect(resolveBuildChannel({}, 'staging')).toBe('public')
  })

  it('lets an explicit value win in either mode, public included', () => {
    expect(resolveBuildChannel({ VITE_BUILD_CHANNEL: 'public' }, 'development')).toBe('public')
    expect(resolveBuildChannel({ VITE_BUILD_CHANNEL: 'canary' }, 'production')).toBe('canary')
    expect(resolveBuildChannel({ VITE_BUILD_CHANNEL: 'internal' }, 'production')).toBe('internal')
  })

  it('ignores an empty or unknown value and falls back to the mode default', () => {
    expect(resolveBuildChannel({ VITE_BUILD_CHANNEL: '' }, 'development')).toBe('internal')
    expect(resolveBuildChannel({ VITE_BUILD_CHANNEL: 'staging' }, 'production')).toBe('public')
    expect(resolveBuildChannel({ VITE_BUILD_CHANNEL: 'Internal' }, 'development')).toBe('internal')
  })
})
