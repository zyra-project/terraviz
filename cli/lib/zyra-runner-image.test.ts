// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The runner image default, guarded.
 *
 * `zyra-scheduler` is built with `ZYRA_EXTRAS=connectors` only, so it
 * has neither `processing` nor `visualization` and dies at the first
 * `convert-format` or `heatmap` stage. The default sat on that image
 * for several releases; nothing caught it because the
 * `ZYRA_SCHEDULER_IMAGE` repo variable was overriding it in practice,
 * and the variable's name points the wrong way.
 *
 * Clearing that variable would have fallen back to an image that
 * fails partway through a pipeline — reading as a Zyra bug rather
 * than a configuration one. Cheap to assert, expensive to debug.
 */

const workflow = readFileSync(
  join(import.meta.dirname, '..', '..', '.github', 'workflows', 'zyra-run.yml'),
  'utf-8',
)

function defaultImage(): string {
  const m = /^\s*ZYRA_IMAGE_DEFAULT:\s*(\S+)\s*$/m.exec(workflow)
  if (!m) throw new Error('ZYRA_IMAGE_DEFAULT not found in zyra-run.yml')
  return m[1]
}

describe('zyra-run.yml runner image', () => {
  it('defaults to the zyra image, not zyra-scheduler', () => {
    const image = defaultImage()
    expect(image).toMatch(/^ghcr\.io\/noaa-gsl\/zyra[@:]/)
    expect(image).not.toContain('zyra-scheduler')
  })

  it('is pinned by digest, as the file documents', () => {
    // A tag is fine in the repo variable — a human sets that and can
    // see what it says. The committed default is the fallback nobody
    // is looking at, so it should not be able to move underneath us.
    expect(defaultImage()).toMatch(/@sha256:[0-9a-f]{64}$/)
  })
})
