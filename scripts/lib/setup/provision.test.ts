// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import {
  applyMigrations,
  ensureD1,
  ensureKv,
  ensureR2Bucket,
  ensureVectorizeIndex,
  ensureVectorizeMetadata,
  extractJson,
  isAlreadyExists,
  kvTitleMatches,
  type CommandResult,
  type CommandRunner,
} from './provision'

/** Records every argv it is handed and replies from a script. */
function stubRunner(
  replies: Array<(argv: string[]) => CommandResult | undefined>,
): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = []
  const run: CommandRunner = async argv => {
    calls.push(argv)
    for (const reply of replies) {
      const r = reply(argv)
      if (r) return r
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })
const err = (stderr: string, code = 1): CommandResult => ({ code, stdout: '', stderr })

describe('extractJson', () => {
  it('parses clean JSON', () => {
    expect(extractJson<number[]>('[1,2,3]')).toEqual([1, 2, 3])
  })

  it('skips a leading wrangler banner', () => {
    const out = '⛅️ wrangler 4.112.0\n----------\n[{"name":"db","uuid":"u"}]'
    expect(extractJson<Array<{ uuid: string }>>(out)?.[0].uuid).toBe('u')
  })

  it('trims a trailing update notice', () => {
    const out = '[{"name":"db"}]\nNote that there is a newer version of Wrangler available.'
    expect(extractJson<Array<{ name: string }>>(out)?.[0].name).toBe('db')
  })

  it('returns null rather than throwing on unparseable output', () => {
    expect(extractJson('no json here')).toBeNull()
    expect(extractJson('{ definitely not json')).toBeNull()
  })
})

describe('kvTitleMatches', () => {
  it('matches the exact title', () => {
    expect(kvTitleMatches('CATALOG_KV', 'CATALOG_KV')).toBe(true)
  })

  it('matches the worker-name-prefixed title wrangler actually creates', () => {
    expect(kvTitleMatches('terraviz-CATALOG_KV', 'CATALOG_KV')).toBe(true)
  })

  it('does not match an unrelated namespace that merely contains the name', () => {
    expect(kvTitleMatches('CATALOG_KV_OLD', 'CATALOG_KV')).toBe(false)
    expect(kvTitleMatches('someCATALOG_KV', 'CATALOG_KV')).toBe(false)
  })

  it('handles a missing title', () => {
    expect(kvTitleMatches(undefined, 'CATALOG_KV')).toBe(false)
  })
})

describe('isAlreadyExists', () => {
  it('recognises the phrasings each product uses', () => {
    expect(isAlreadyExists(err('A namespace with this account ID and title already exists'))).toBe(
      true,
    )
    expect(isAlreadyExists(err('code: 10053'))).toBe(true)
    expect(isAlreadyExists(err('network unreachable'))).toBe(false)
  })
})

describe('ensureD1', () => {
  it('adopts an existing database without creating one', async () => {
    const { run, calls } = stubRunner([
      a => (a[1] === 'list' ? ok('[{"name":"sphere-feedback","uuid":"abc"}]') : undefined),
    ])
    expect(await ensureD1(run, 'sphere-feedback')).toEqual({ id: 'abc', created: false })
    expect(calls.some(c => c[1] === 'create')).toBe(false)
  })

  it('creates then re-lists to resolve the id', async () => {
    let created = false
    const { run, calls } = stubRunner([
      a => {
        if (a[1] === 'create') {
          created = true
          return ok('created')
        }
        if (a[1] === 'list') {
          return ok(created ? '[{"name":"db","uuid":"new"}]' : '[]')
        }
        return undefined
      },
    ])
    expect(await ensureD1(run, 'db')).toEqual({ id: 'new', created: true })
    expect(calls.filter(c => c[1] === 'list')).toHaveLength(2)
  })

  // Converging on the right end state is not the same as having
  // created it; the operator-facing output says "created" or
  // "adopted" off this flag.
  it('reports a raced already-exists create as adopted, not created', async () => {
    let listed = 0
    const { run } = stubRunner([
      a => {
        if (a[1] === 'create') return err('database already exists')
        if (a[1] === 'list') {
          listed += 1
          return ok(listed === 1 ? '[]' : '[{"name":"db","uuid":"raced"}]')
        }
        return undefined
      },
    ])
    expect(await ensureD1(run, 'db')).toEqual({ id: 'raced', created: false })
  })

  it('fails loudly when the id cannot be resolved after creating', async () => {
    const { run } = stubRunner([a => (a[1] === 'list' ? ok('[]') : ok())])
    await expect(ensureD1(run, 'db')).rejects.toThrow(/ID could not be resolved/)
  })

  it('surfaces a list failure instead of pretending the resource is absent', async () => {
    const { run } = stubRunner([a => (a[1] === 'list' ? err('not authorized', 1) : undefined)])
    await expect(ensureD1(run, 'db')).rejects.toThrow(/not authorized/)
  })
})

describe('ensureKv', () => {
  it('adopts a prefixed namespace title', async () => {
    const { run, calls } = stubRunner([
      a =>
        a[2] === 'list'
          ? ok('[{"id":"kvid","title":"terraviz-CATALOG_KV"}]')
          : undefined,
    ])
    expect(await ensureKv(run, 'CATALOG_KV')).toEqual({ id: 'kvid', created: false })
    expect(calls.some(c => c[2] === 'create')).toBe(false)
  })

  it('creates when genuinely absent', async () => {
    let made = false
    const { run } = stubRunner([
      a => {
        if (a[2] === 'create') {
          made = true
          return ok()
        }
        if (a[2] === 'list') return ok(made ? '[{"id":"n","title":"CATALOG_KV"}]' : '[]')
        return undefined
      },
    ])
    expect(await ensureKv(run, 'CATALOG_KV')).toEqual({ id: 'n', created: true })
  })

  it('reports a raced already-exists create as adopted, not created', async () => {
    let listed = 0
    const { run } = stubRunner([
      a => {
        if (a[2] === 'create') return err('a namespace with this account ID and title already exists')
        if (a[2] === 'list') {
          listed += 1
          return ok(listed === 1 ? '[]' : '[{"id":"raced","title":"CATALOG_KV"}]')
        }
        return undefined
      },
    ])
    expect(await ensureKv(run, 'CATALOG_KV')).toEqual({ id: 'raced', created: false })
  })
})

describe('ensureR2Bucket', () => {
  it('reports created on success', async () => {
    const { run } = stubRunner([() => ok()])
    expect(await ensureR2Bucket(run, 'b')).toEqual({ created: true })
  })

  it('treats already-exists as adopted, not as a failure', async () => {
    const { run } = stubRunner([() => err('The bucket you tried to create already exists.')])
    expect(await ensureR2Bucket(run, 'b')).toEqual({ created: false })
  })

  it('still throws on a real failure', async () => {
    const { run } = stubRunner([() => err('Authentication error')])
    await expect(ensureR2Bucket(run, 'b')).rejects.toThrow(/Authentication error/)
  })
})

describe('ensureVectorizeIndex', () => {
  it('creates with 768 dimensions and cosine distance', async () => {
    const { run, calls } = stubRunner([a => (a[1] === 'list' ? ok('[]') : ok())])
    await ensureVectorizeIndex(run, 'terraviz-datasets')
    const create = calls.find(c => c[1] === 'create')
    expect(create).toEqual([
      'vectorize',
      'create',
      'terraviz-datasets',
      '--dimensions=768',
      '--metric=cosine',
    ])
  })

  it('adopts an existing index', async () => {
    const { run, calls } = stubRunner([
      a => (a[1] === 'list' ? ok('[{"name":"terraviz-datasets"}]') : undefined),
    ])
    expect(await ensureVectorizeIndex(run, 'terraviz-datasets')).toEqual({ created: false })
    expect(calls.some(c => c[1] === 'create')).toBe(false)
  })

  it('reports a raced already-exists create as adopted, not created', async () => {
    const { run } = stubRunner([
      a => (a[1] === 'list' ? ok('[]') : err('index already exists')),
    ])
    expect(await ensureVectorizeIndex(run, 'terraviz-datasets')).toEqual({ created: false })
  })
})

describe('ensureVectorizeMetadata', () => {
  it('creates only the missing properties', async () => {
    const { run, calls } = stubRunner([
      a =>
        a[1] === 'list-metadata-index'
          ? ok('{"metadataIndexes":[{"propertyName":"peer_id"}]}')
          : ok(),
    ])
    const res = await ensureVectorizeMetadata(run, 'idx', [
      'peer_id',
      'category',
      'visibility',
    ])
    expect(res.existing).toEqual(['peer_id'])
    expect(res.created).toEqual(['category', 'visibility'])
    const created = calls.filter(c => c[1] === 'create-metadata-index')
    expect(created).toHaveLength(2)
    expect(created[0]).toContain('--property-name=category')
    expect(created[0]).toContain('--type=string')
  })

  it('creates all three when the list call is unreadable', async () => {
    const { run, calls } = stubRunner([
      a => (a[1] === 'list-metadata-index' ? err('unsupported') : ok()),
    ])
    const res = await ensureVectorizeMetadata(run, 'idx', ['peer_id', 'category'])
    expect(res.created).toEqual(['peer_id', 'category'])
    expect(calls.filter(c => c[1] === 'create-metadata-index')).toHaveLength(2)
  })
})

describe('applyMigrations', () => {
  it('targets the binding name, never the database name', async () => {
    const { run, calls } = stubRunner([() => ok()])
    await applyMigrations(run, 'CATALOG_DB')
    expect(calls[0]).toEqual([
      'd1',
      'migrations',
      'apply',
      'CATALOG_DB',
      '--config',
      'wrangler.toml',
      '--remote',
    ])
    expect(calls[0]).not.toContain('sphere-feedback')
  })

  it('can target the local database for a dry run', async () => {
    const { run, calls } = stubRunner([() => ok()])
    await applyMigrations(run, 'FEEDBACK_DB', false)
    expect(calls[0]).toContain('--local')
    expect(calls[0]).not.toContain('--remote')
  })
})
