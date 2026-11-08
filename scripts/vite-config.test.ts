// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// @vitest-environment node
//
// Node, not happy-dom: under happy-dom `import path from 'path'` in the
// config resolves to the npm `path` polyfill and prints a deprecation
// warning on every run.

import { afterEach, describe, expect, it } from 'vitest'
import type { ConfigEnv, UserConfig } from 'vite'
import config from '../vite.config'

// The rule itself is tested in `scripts/lib/build-channel.test.ts`.
// This pins the wiring: that the config hands it `mode` and the loaded
// env, and bakes the result in as a JSON string (#531).
const factory = config as (env: ConfigEnv) => UserConfig

function channelFor(mode: string, command: ConfigEnv['command']): unknown {
  return factory({ mode, command, isSsrBuild: false, isPreview: false }).define?.__BUILD_CHANNEL__
}

describe('vite.config build channel', () => {
  const saved = process.env.VITE_BUILD_CHANNEL
  afterEach(() => {
    if (saved === undefined) delete process.env.VITE_BUILD_CHANNEL
    else process.env.VITE_BUILD_CHANNEL = saved
  })

  it('bakes in internal for the dev server and public for a build', () => {
    // An empty shell value overrides any VITE_BUILD_CHANNEL in a local
    // .env file (loadEnv puts the shell over .env) and reads as unset,
    // so a contributor's own .env.local cannot change the outcome.
    process.env.VITE_BUILD_CHANNEL = ''
    expect(channelFor('development', 'serve')).toBe('"internal"')
    expect(channelFor('production', 'build')).toBe('"public"')
  })

  it('passes an explicit value through from the environment', () => {
    process.env.VITE_BUILD_CHANNEL = 'canary'
    expect(channelFor('development', 'serve')).toBe('"canary"')
    expect(channelFor('production', 'build')).toBe('"canary"')
  })
})
