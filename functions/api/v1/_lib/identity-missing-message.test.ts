// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { IDENTITY_MISSING_MESSAGE } from './catalog-store'

const FUNCTIONS_ROOT = resolve(import.meta.dirname, '../../../..', 'functions')

const sources = (): { path: string; text: string }[] =>
  readdirSync(FUNCTIONS_ROOT, { recursive: true, encoding: 'utf8' })
    .filter(p => p.endsWith('.ts') && !p.endsWith('.test.ts'))
    .map(p => ({ path: `functions/${p}`, text: readFileSync(resolve(FUNCTIONS_ROOT, p), 'utf8') }))

/**
 * The 503 `identity_missing` hint has to name a command that works.
 *
 * Six endpoints raise this error, and every one of them carried its
 * own copy of the sentence "Run `npm run gen:node-key`." That command
 * cannot fix the condition from either side: it *updates*
 * `node_identity.public_key` rather than inserting the row, and it
 * reaches only the local `.wrangler/` SQLite file. An operator on a
 * deployed node who follows it changes nothing and still gets the
 * 503; a contributor locally gets "No node_identity row found in
 * local D1" and an exit code of 0.
 *
 * Six copies is how it stayed wrong — fixing one would have left
 * five. The message is a shared constant now, and these assertions
 * are what stop a seventh raise site from pasting a literal back in.
 */
describe('the identity_missing hint', () => {
  it('is not duplicated as a literal at any raise site', () => {
    const offenders = sources()
      .filter(f => !f.path.endsWith('_lib/catalog-store.ts'))
      .filter(f => /Node identity has not been provisioned/.test(f.text))
      .map(f => f.path)

    expect(
      offenders,
      'these files inline the message instead of importing IDENTITY_MISSING_MESSAGE ' +
        'from _lib/catalog-store — the duplication is what let all six copies name a ' +
        'command that cannot fix the error',
    ).toEqual([])
  })

  it('is what every raise site actually sends', () => {
    const raisers = sources().filter(
      f => /'identity_missing'/.test(f.text) && !f.path.endsWith('_lib/catalog-store.ts'),
    )

    // Guards the guard: if the endpoints are ever restructured so this
    // finds nothing, the assertion below would pass vacuously.
    expect(raisers.length, 'expected the identity_missing endpoints to be found').toBeGreaterThan(0)

    for (const f of raisers) {
      expect(f.text, `${f.path} raises identity_missing without the shared message`).toMatch(
        /IDENTITY_MISSING_MESSAGE/,
      )
    }
  })

  // `gen:node-key` is the right answer to a different question — it
  // mints the keypair, and `terraviz init-node` reads the public half
  // out of node-public-key.txt. It is only wrong as the fix for a
  // missing row, which is what this error reports.
  it('names the commands that write the row, and not the one that does not', () => {
    expect(IDENTITY_MISSING_MESSAGE).not.toMatch(/gen:node-key/)
    expect(IDENTITY_MISSING_MESSAGE, 'the deployed-node fix').toMatch(/init-node/)
    expect(IDENTITY_MISSING_MESSAGE, 'the local-dev fix').toMatch(/db:seed/)
  })
})
