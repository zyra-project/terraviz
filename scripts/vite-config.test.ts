// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, describe, expect, it } from 'vitest'
import { resolveBuildChannel } from '../vite.config'

// `resolveBuildChannel` decides the `session_start.build_channel` a
// bundle reports. The dev server's default is what lets a contributor's
// own rows be told from visitors when they send at all (#531).
describe('resolveBuildChannel', () => {
  const saved = process.env.VITE_BUILD_CHANNEL
  afterEach(() => {
    if (saved === undefined) delete process.env.VITE_BUILD_CHANNEL
    else process.env.VITE_BUILD_CHANNEL = saved
  })

  it('is internal under the dev server and public for a build when nothing is set', () => {
    delete process.env.VITE_BUILD_CHANNEL
    expect(resolveBuildChannel({}, 'development')).toBe('internal')
    expect(resolveBuildChannel({}, 'production')).toBe('public')
  })

  it('treats any mode other than development as a build', () => {
    delete process.env.VITE_BUILD_CHANNEL
    expect(resolveBuildChannel({}, 'test')).toBe('public')
    expect(resolveBuildChannel({}, 'staging')).toBe('public')
  })

  it('lets an explicit value win in either mode, public included', () => {
    delete process.env.VITE_BUILD_CHANNEL
    expect(resolveBuildChannel({ VITE_BUILD_CHANNEL: 'public' }, 'development')).toBe('public')
    expect(resolveBuildChannel({ VITE_BUILD_CHANNEL: 'canary' }, 'production')).toBe('canary')
    expect(resolveBuildChannel({ VITE_BUILD_CHANNEL: 'internal' }, 'production')).toBe('internal')
  })

  it('prefers the shell over .env, as every other VITE_* knob does', () => {
    process.env.VITE_BUILD_CHANNEL = 'canary'
    expect(resolveBuildChannel({ VITE_BUILD_CHANNEL: 'internal' }, 'development')).toBe('canary')
  })

  it('ignores an unknown value and falls back to the mode default', () => {
    delete process.env.VITE_BUILD_CHANNEL
    expect(resolveBuildChannel({ VITE_BUILD_CHANNEL: 'staging' }, 'production')).toBe('public')
    expect(resolveBuildChannel({ VITE_BUILD_CHANNEL: 'Internal' }, 'development')).toBe('internal')
  })
})
