// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  repointWranglerToml,
  stillPinnedUpstream,
  UPSTREAM_PINNED_IDS,
} from './wrangler-toml'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const realConfig = (): string => readFileSync(resolve(REPO_ROOT, 'wrangler.toml'), 'utf-8')

const FIXTURE = `
name = "terraviz"

[ai]
binding = "AI"

[[d1_databases]]
binding = "FEEDBACK_DB"
database_name = "sphere-feedback"
database_id = "OLD-D1"
migrations_dir = "migrations"

[[d1_databases]]
binding = "CATALOG_DB"
database_name = "sphere-feedback"
database_id = "OLD-D1"
migrations_dir = "migrations/catalog"

# Example command quoting the upstream id:
#   wrangler kv key put telemetry_enabled disabled --namespace-id=OLD-TEL
[[kv_namespaces]]
binding = "TELEMETRY_KILL_SWITCH"
id = "OLD-TEL"

[[kv_namespaces]]
binding = "CATALOG_KV"
id = "OLD-CAT"

[[r2_buckets]]
binding = "CATALOG_R2"
bucket_name = "terraviz-assets"
`.trimStart()

/**
 * The same shape, carrying the real upstream IDs.
 *
 * `stillPinnedUpstream` matches on those exact values, so exercising
 * it needs a source that contains them. Using the committed
 * `wrangler.toml` for that couples the test to whether *this*
 * checkout has been through `npm run setup` — which is what broke on
 * a downstream fork. A fixture cannot drift out from under it.
 */
const UPSTREAM_SHAPED = FIXTURE.replace(/OLD-D1/g, UPSTREAM_PINNED_IDS.d1)
  .replace(/OLD-TEL/g, UPSTREAM_PINNED_IDS.telemetryKv)
  .replace(/OLD-CAT/g, UPSTREAM_PINNED_IDS.catalogKv)

describe('repointWranglerToml', () => {
  it('rewrites both D1 blocks even though they share a database_name', () => {
    const { text, changes } = repointWranglerToml(FIXTURE, { d1DatabaseId: 'NEW-D1' })
    expect(changes.map(c => c.binding)).toEqual(['FEEDBACK_DB', 'CATALOG_DB'])
    expect(text).not.toContain('OLD-D1')
    expect(text.match(/database_id = "NEW-D1"/g)).toHaveLength(2)
  })

  it('distinguishes the two KV blocks, which share a section header', () => {
    const { text } = repointWranglerToml(FIXTURE, {
      telemetryKvId: 'NEW-TEL',
      catalogKvId: 'NEW-CAT',
    })
    const telBlock = text.slice(text.indexOf('TELEMETRY_KILL_SWITCH'))
    expect(telBlock).toMatch(/id = "NEW-TEL"/)
    const catBlock = text.slice(text.indexOf('binding = "CATALOG_KV"'))
    expect(catBlock).toMatch(/id = "NEW-CAT"/)
  })

  it('leaves example commands inside comments alone', () => {
    const { text } = repointWranglerToml(FIXTURE, { telemetryKvId: 'NEW-TEL' })
    expect(text).toContain('--namespace-id=OLD-TEL')
  })

  it('preserves migrations_dir, which is what disambiguates the D1 blocks', () => {
    const { text } = repointWranglerToml(FIXTURE, { d1DatabaseId: 'NEW-D1' })
    expect(text).toContain('migrations_dir = "migrations"')
    expect(text).toContain('migrations_dir = "migrations/catalog"')
  })

  it('is idempotent — a second run reports no changes', () => {
    const first = repointWranglerToml(FIXTURE, { d1DatabaseId: 'NEW-D1' })
    const second = repointWranglerToml(first.text, { d1DatabaseId: 'NEW-D1' })
    expect(second.changes).toEqual([])
    expect(second.text).toBe(first.text)
  })

  it('ignores undefined targets rather than blanking the field', () => {
    const { text, changes } = repointWranglerToml(FIXTURE, {})
    expect(changes).toEqual([])
    expect(text).toBe(FIXTURE)
  })

  it('reports a binding whose block is absent instead of silently skipping', () => {
    const { unmatched } = repointWranglerToml('name = "x"\n', { d1DatabaseId: 'NEW' })
    expect(unmatched).toContain('d1_databases/FEEDBACK_DB')
  })

  it('records line numbers an operator can act on', () => {
    const { changes } = repointWranglerToml(FIXTURE, { catalogKvId: 'NEW-CAT' })
    expect(changes).toHaveLength(1)
    const line = FIXTURE.split('\n')[changes[0].line - 1]
    expect(line).toContain('id = ')
  })

  // The point of the whole module: it has to work on the file that
  // actually ships, not just a fixture shaped like it.
  it('repoints the real wrangler.toml', () => {
    const { text, changes, unmatched } = repointWranglerToml(realConfig(), {
      d1DatabaseId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      telemetryKvId: '11111111111111111111111111111111',
      catalogKvId: '22222222222222222222222222222222',
    })
    expect(unmatched).toEqual([])
    expect(changes.map(c => `${c.binding}.${c.key}`)).toEqual([
      'FEEDBACK_DB.database_id',
      'CATALOG_DB.database_id',
      'TELEMETRY_KILL_SWITCH.id',
      'CATALOG_KV.id',
    ])
    expect(stillPinnedUpstream(text)).toEqual([])
  })
})

describe('stillPinnedUpstream', () => {
  it('reports nothing once repointed', () => {
    const { text } = repointWranglerToml(realConfig(), {
      d1DatabaseId: 'mine-d1',
      telemetryKvId: 'mine-tel',
      catalogKvId: 'mine-cat',
    })
    expect(stillPinnedUpstream(text)).toEqual([])
  })

  it('flags every block that still carries an upstream id', () => {
    expect(stillPinnedUpstream(UPSTREAM_SHAPED).sort()).toEqual([
      'CATALOG_DB',
      'CATALOG_KV',
      'FEEDBACK_DB',
      'TELEMETRY_KILL_SWITCH',
    ])
  })

  it('flags only the blocks that were not repointed', () => {
    const { text } = repointWranglerToml(UPSTREAM_SHAPED, {
      d1DatabaseId: 'mine-d1',
      telemetryKvId: 'mine-tel',
      catalogKvId: UPSTREAM_PINNED_IDS.catalogKv,
    })
    expect(stillPinnedUpstream(text)).toEqual(['CATALOG_KV'])
  })
})

/**
 * Upstream repo hygiene, not module behaviour.
 *
 * These assert that the committed `wrangler.toml` still aims at
 * upstream's own resources — they catch a contributor accidentally
 * committing their own IDs. That is worth catching, but only *here*.
 *
 * On a fork they are actively wrong. Phase 3 of the install guide
 * tells an operator to run `npm run setup --apply --only=wrangler-toml`,
 * which rewrites exactly these IDs — so a fork that follows the
 * documented workflow, then runs `npm test`, inherits a permanently
 * red suite for doing the right thing. That is what happened: a
 * downstream fork reported both of these failing after a partial
 * install.
 *
 * `GITHUB_REPOSITORY` is set by GitHub Actions to `owner/repo`, so
 * upstream CI runs them and a fork's CI does not. A pull request from
 * a fork *to* upstream runs in upstream's context and is still
 * checked, which is the case that matters. Locally the variable is
 * usually absent and the checks are skipped: we assert this only
 * where we can prove which repo we are.
 */
const UPSTREAM_REPO = 'zyra-project/terraviz'
const slug = process.env.GITHUB_REPOSITORY?.toLowerCase()
const onUpstream = slug === UPSTREAM_REPO

// Plain `describe` / `describe.skip` rather than `describe.runIf`, which
// would be this repo's only use of that helper. Same reporting either
// way — the suite shows as skipped — and a reader does not need to know
// a vitest-specific API to see what gates it.
const describeUpstream = onUpstream ? describe : describe.skip

describeUpstream('the committed wrangler.toml (upstream only)', () => {
  it('is still pinned to upstream, not to anyone\'s real resources', () => {
    expect(stillPinnedUpstream(realConfig()).sort()).toEqual([
      'CATALOG_DB',
      'CATALOG_KV',
      'FEEDBACK_DB',
      'TELEMETRY_KILL_SWITCH',
    ])
  })

  it('ships the ids UPSTREAM_PINNED_IDS names', () => {
    const config = realConfig()
    expect(config).toContain(UPSTREAM_PINNED_IDS.d1)
    expect(config).toContain(UPSTREAM_PINNED_IDS.telemetryKv)
    expect(config).toContain(UPSTREAM_PINNED_IDS.catalogKv)
  })
})
