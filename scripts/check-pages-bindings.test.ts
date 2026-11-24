// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Unit coverage for the bindings audit. The diff function is pure
 * (expected manifest + ProjectBindings → DiffEntry list), so most
 * of the work is feeding it stubbed actuals and asserting the
 * specific shape of the missing/extra/wrong-environment cases.
 *
 * The end-to-end check against the real Cloudflare REST endpoint
 * runs separately — see CATALOG_BACKEND_DEVELOPMENT.md for the
 * "post-binding-setup sanity check" flow.
 */

import { describe, expect, it } from 'vitest'
import {
  checkBucketNames,
  diffBindings,
  formatDiffTable,
  RestApiSource,
  type ProjectBindings,
} from './lib/cf-pages-api.ts'
import {
  EXPECTED_BINDINGS,
  type ExpectedBinding,
} from './lib/expected-bindings.ts'
import { runCheck } from './check-pages-bindings.ts'

function emptyEnv() {
  return {
    plaintext: new Set<string>(),
    secret: new Set<string>(),
    d1: new Set<string>(),
    kv: new Set<string>(),
    r2: new Set<string>(),
    vectorize: new Set<string>(),
    ai: new Set<string>(),
    analytics_engine: new Set<string>(),
  }
}

function fullyConfigured(): ProjectBindings {
  // Mirror the EXPECTED_BINDINGS manifest into both environments —
  // the "operator wired everything correctly" baseline.
  const proj: ProjectBindings = { production: emptyEnv(), preview: emptyEnv() }
  for (const exp of EXPECTED_BINDINGS) {
    for (const env of exp.environments) {
      const buckets = proj[env]
      switch (exp.type) {
        case 'plaintext':
          buckets.plaintext.add(exp.name)
          break
        case 'secret':
          buckets.secret.add(exp.name)
          break
        case 'd1':
          buckets.d1.add(exp.name)
          break
        case 'kv':
          buckets.kv.add(exp.name)
          break
        case 'r2':
          buckets.r2.add(exp.name)
          break
        case 'vectorize':
          buckets.vectorize.add(exp.name)
          break
        case 'ai':
          buckets.ai.add(exp.name)
          break
        case 'analytics_engine':
          buckets.analytics_engine.add(exp.name)
          break
      }
    }
  }
  return proj
}

describe('diffBindings', () => {
  it('reports every expected binding as present when fully configured', () => {
    const entries = diffBindings(EXPECTED_BINDINGS, fullyConfigured())
    const missing = entries.filter(e => e.status === 'missing')
    expect(missing).toEqual([])
  })

  it('flags a binding missing in Preview but present in Production', () => {
    const proj = fullyConfigured()
    proj.preview.d1.delete('CATALOG_DB')
    const entries = diffBindings(EXPECTED_BINDINGS, proj)
    const missing = entries.filter(e => e.status === 'missing')
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatchObject({
      name: 'CATALOG_DB',
      environment: 'preview',
      status: 'missing',
    })
    // The hint should ride along so the operator knows what to do.
    expect(missing[0].hint).toMatch(/D1/)
  })

  it('flags a binding missing in both environments', () => {
    const proj = fullyConfigured()
    proj.production.vectorize.delete('CATALOG_VECTORIZE')
    proj.preview.vectorize.delete('CATALOG_VECTORIZE')
    const entries = diffBindings(EXPECTED_BINDINGS, proj)
    const missing = entries.filter(e => e.status === 'missing')
    expect(missing.map(m => m.environment).sort()).toEqual(['preview', 'production'])
    for (const m of missing) {
      expect(m.name).toBe('CATALOG_VECTORIZE')
    }
  })

  it('flags an unexpected env var as informational, not a failure', () => {
    const proj = fullyConfigured()
    proj.production.plaintext.add('CUSTOM_OPERATOR_VAR')
    const entries = diffBindings(EXPECTED_BINDINGS, proj)
    const extras = entries.filter(e => e.status === 'unexpected')
    expect(extras.some(e => e.name === 'CUSTOM_OPERATOR_VAR')).toBe(true)
    // No "missing" entries triggered by the unknown extra.
    const missing = entries.filter(e => e.status === 'missing')
    expect(missing).toEqual([])
  })

  it('emits wrong_type when an expected name lives in a different bucket (1f/N)', () => {
    // Operator created CATALOG_VECTORIZE as a plaintext env var
    // instead of wiring the actual Vectorize binding — pre-1f/N
    // this surfaced as two unrelated rows (missing vectorize +
    // unexpected plaintext) the operator had to mentally
    // correlate. Now collapses into one explicit wrong_type row.
    const proj = fullyConfigured()
    proj.production.vectorize.delete('CATALOG_VECTORIZE')
    proj.production.plaintext.add('CATALOG_VECTORIZE')
    const entries = diffBindings(EXPECTED_BINDINGS, proj)
    const prod = entries.filter(
      e => e.environment === 'production' && e.name === 'CATALOG_VECTORIZE',
    )
    // Exactly one row for production CATALOG_VECTORIZE — wrong_type,
    // not missing+unexpected.
    expect(prod).toHaveLength(1)
    expect(prod[0].status).toBe('wrong_type')
    expect(prod[0].type).toBe('vectorize')
    expect(prod[0].hint).toMatch(/Found as plaintext but expected vectorize/)
    // No phantom "unexpected" row for the same name.
    const unexpected = entries.filter(
      e =>
        e.environment === 'production' &&
        e.name === 'CATALOG_VECTORIZE' &&
        e.status === 'unexpected',
    )
    expect(unexpected).toHaveLength(0)
  })

  it('honours per-binding environments', () => {
    // Construct a manifest where one entry is Production-only.
    const proj = fullyConfigured()
    proj.preview.kv.delete('CATALOG_KV')
    const productionOnly: ExpectedBinding[] = EXPECTED_BINDINGS.map(b =>
      b.name === 'CATALOG_KV'
        ? { ...b, environments: ['production'] }
        : b,
    )
    const entries = diffBindings(productionOnly, proj)
    const missing = entries.filter(e => e.status === 'missing')
    // Removing CATALOG_KV from Preview is fine when the manifest
    // declares it Production-only.
    expect(missing.find(m => m.name === 'CATALOG_KV')).toBeUndefined()
  })
})

describe('formatDiffTable', () => {
  it('produces a stable table layout with status glyphs', () => {
    const proj = fullyConfigured()
    proj.preview.d1.delete('CATALOG_DB')
    const entries = diffBindings(EXPECTED_BINDINGS, proj)
    const out = formatDiffTable(entries)
    expect(out).toMatch(/Env\s+Type\s+Name\s+Status/)
    expect(out).toMatch(/preview\s+d1\s+CATALOG_DB\s+MISSING/)
    expect(out).toMatch(/production\s+d1\s+CATALOG_DB\s+OK/)
  })
})

describe('RestApiSource', () => {
  it('shells the deployment_configs into typed sets', async () => {
    const cfResponse = {
      success: true,
      result: {
        deployment_configs: {
          production: {
            env_vars: {
              ACCESS_TEAM_DOMAIN: { value: 'example.cloudflareaccess.com', type: 'plain_text' },
              NODE_ID_PRIVATE_KEY_PEM: { value: null, type: 'secret_text' },
            },
            d1_databases: { CATALOG_DB: { id: 'abc' } },
            kv_namespaces: { CATALOG_KV: { namespace_id: 'def' } },
            r2_buckets: { CATALOG_R2: { name: 'terraviz-assets' } },
            vectorize_bindings: { CATALOG_VECTORIZE: { index_name: 'terraviz-datasets' } },
            ai_bindings: { AI: {} },
            analytics_engine_datasets: { ANALYTICS: { dataset: 'terraviz_events' } },
          },
          preview: {
            env_vars: {},
          },
        },
      },
    }
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(cfResponse), { status: 200 })
    const source = new RestApiSource({
      apiToken: 'tok',
      accountId: 'acct',
      projectName: 'terraviz',
      fetchImpl,
    })
    const proj = await source.fetchProject()
    expect(proj.production.plaintext.has('ACCESS_TEAM_DOMAIN')).toBe(true)
    expect(proj.production.secret.has('NODE_ID_PRIVATE_KEY_PEM')).toBe(true)
    expect(proj.production.d1.has('CATALOG_DB')).toBe(true)
    expect(proj.production.kv.has('CATALOG_KV')).toBe(true)
    expect(proj.production.r2.has('CATALOG_R2')).toBe(true)
    expect(proj.production.vectorize.has('CATALOG_VECTORIZE')).toBe(true)
    expect(proj.production.ai.has('AI')).toBe(true)
    expect(proj.production.analytics_engine.has('ANALYTICS')).toBe(true)
    expect(proj.preview.d1.size).toBe(0)
  })

  it('throws on non-2xx with a useful message', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('forbidden', { status: 403, statusText: 'Forbidden' })
    const source = new RestApiSource({
      apiToken: 'bad',
      accountId: 'acct',
      projectName: 'terraviz',
      fetchImpl,
    })
    await expect(source.fetchProject()).rejects.toThrow(/403/)
  })

  it('throws when the API replies success=false', async () => {
    const cfResponse = {
      success: false,
      errors: [{ message: 'Project not found' }],
      result: null,
    }
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(cfResponse), { status: 200 })
    const source = new RestApiSource({
      apiToken: 'tok',
      accountId: 'acct',
      projectName: 'nope',
      fetchImpl,
    })
    await expect(source.fetchProject()).rejects.toThrow(/Project not found/)
  })
})

describe('runCheck', () => {
  function mkStream() {
    let buf = ''
    return {
      stream: { write: (s: string) => (buf += s) },
      get out() {
        return buf
      },
    }
  }

  it('exits 2 with a usage hint when env is missing', async () => {
    const stdout = mkStream()
    const stderr = mkStream()
    const code = await runCheck({
      env: {},
      stdout: stdout.stream,
      stderr: stderr.stream,
    })
    expect(code).toBe(2)
    expect(stderr.out).toMatch(/CLOUDFLARE_API_TOKEN/)
    expect(stderr.out).toMatch(/CLOUDFLARE_ACCOUNT_ID/)
  })

  it('exits 0 when fully configured', async () => {
    const proj = fullyConfigured()
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: {
            deployment_configs: {
              production: serialise(proj.production),
              preview: serialise(proj.preview),
            },
          },
        }),
        { status: 200 },
      )
    const stdout = mkStream()
    const stderr = mkStream()
    const code = await runCheck({
      env: { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acct' },
      stdout: stdout.stream,
      stderr: stderr.stream,
      fetchImpl,
    })
    expect(code).toBe(0)
    expect(stdout.out).toMatch(/All required bindings present/)
  })

  it('exits 1 when a required binding is missing', async () => {
    const proj = fullyConfigured()
    proj.preview.d1.delete('CATALOG_DB')
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: {
            deployment_configs: {
              production: serialise(proj.production),
              preview: serialise(proj.preview),
            },
          },
        }),
        { status: 200 },
      )
    const stdout = mkStream()
    const stderr = mkStream()
    const code = await runCheck({
      env: { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acct' },
      stdout: stdout.stream,
      stderr: stderr.stream,
      fetchImpl,
    })
    expect(code).toBe(1)
    expect(stdout.out).toMatch(/CATALOG_DB/)
    expect(stdout.out).toMatch(/MISSING/)
  })

  it('exits 2 when the Cloudflare API returns 403', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('forbidden', { status: 403, statusText: 'Forbidden' })
    const stdout = mkStream()
    const stderr = mkStream()
    const code = await runCheck({
      env: { CLOUDFLARE_API_TOKEN: 'bad', CLOUDFLARE_ACCOUNT_ID: 'acct' },
      stdout: stdout.stream,
      stderr: stderr.stream,
      fetchImpl,
    })
    expect(code).toBe(2)
    expect(stderr.out).toMatch(/403/)
  })
})

describe('checkBucketNames', () => {
  // Round-trip through RestApiSource so the values are read the way
  // the real audit reads them, not set on the struct by hand.
  async function project(
    bucket: string | { production: string; preview: string },
    values: Record<string, string | null> = {},
    shape: (env: ReturnType<typeof emptyEnv>) => void = () => {},
  ): Promise<ProjectBindings> {
    const proj = fullyConfigured()
    shape(proj.production)
    shape(proj.preview)
    const per = typeof bucket === 'string' ? { production: bucket, preview: bucket } : bucket
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: {
            deployment_configs: {
              production: serialise(proj.production, { bucket: per.production, values }),
              preview: serialise(proj.preview, { bucket: per.preview, values }),
            },
          },
        }),
        { status: 200 },
      )
    return new RestApiSource({ apiToken: 't', accountId: 'a', projectName: 'p', fetchImpl })
      .fetchProject()
  }
  const withVariable = (env: ReturnType<typeof emptyEnv>) => env.plaintext.add('CATALOG_R2_BUCKET')

  it('passes the default bucket with CATALOG_R2_BUCKET unset', async () => {
    expect(checkBucketNames(await project('terraviz-assets'))).toEqual({
      mismatches: [],
      unverified: [],
    })
  })

  it('flags a renamed bucket with CATALOG_R2_BUCKET unset, in both environments', async () => {
    const { mismatches } = checkBucketNames(await project('node-assets'))
    expect(mismatches).toEqual([
      { environment: 'production', bound: 'node-assets', addressed: 'terraviz-assets', fromDefault: true },
      { environment: 'preview', bound: 'node-assets', addressed: 'terraviz-assets', fromDefault: true },
    ])
  })

  // Preview bound to a bucket of its own, with no variable, sends its
  // S3-API paths to the default name while production is fine.
  it('flags only the environment that disagrees', async () => {
    const { mismatches } = checkBucketNames(
      await project({ production: 'terraviz-assets', preview: 'preview-assets' }),
    )
    expect(mismatches.map(m => m.environment)).toEqual(['preview'])
  })

  it('passes a renamed bucket whose CATALOG_R2_BUCKET agrees', async () => {
    const proj = await project('node-assets', { CATALOG_R2_BUCKET: 'node-assets' }, withVariable)
    expect(checkBucketNames(proj)).toEqual({ mismatches: [], unverified: [] })
  })

  it('flags a CATALOG_R2_BUCKET that names a different bucket', async () => {
    const proj = await project('node-assets', { CATALOG_R2_BUCKET: 'other-assets' }, withVariable)
    expect(checkBucketNames(proj).mismatches[0]).toMatchObject({
      bound: 'node-assets',
      addressed: 'other-assets',
      fromDefault: false,
    })
  })

  // `functions/` reads `env.CATALOG_R2_BUCKET?.trim() || 'terraviz-assets'`.
  it('reads a blank CATALOG_R2_BUCKET as unset, as the Worker does', async () => {
    const proj = await project('node-assets', { CATALOG_R2_BUCKET: '  ' }, withVariable)
    expect(checkBucketNames(proj).mismatches[0]).toMatchObject({ fromDefault: true })
  })

  // An unread pair must not read as all-clear.
  it('reports a secret CATALOG_R2_BUCKET as unverified rather than passing it', async () => {
    const proj = await project('node-assets', {}, env => env.secret.add('CATALOG_R2_BUCKET'))
    const { mismatches, unverified } = checkBucketNames(proj)
    expect(mismatches).toEqual([])
    expect(unverified).toEqual([
      { environment: 'production', reason: 'secret-variable' },
      { environment: 'preview', reason: 'secret-variable' },
    ])
  })

  it('reports a plaintext value the API did not return as unverified', async () => {
    const proj = await project('node-assets', { CATALOG_R2_BUCKET: null }, withVariable)
    expect(checkBucketNames(proj).unverified[0]).toEqual({
      environment: 'production',
      reason: 'value-not-returned',
    })
  })
})

describe('runCheck bucket consistency', () => {
  async function run(
    bucket: string,
    shape: (env: ReturnType<typeof emptyEnv>) => void = () => {},
  ): Promise<{ code: number; out: string }> {
    const proj = fullyConfigured()
    shape(proj.production)
    shape(proj.preview)
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: {
            deployment_configs: {
              production: serialise(proj.production, { bucket }),
              preview: serialise(proj.preview, { bucket }),
            },
          },
        }),
        { status: 200 },
      )
    let out = ''
    const code = await runCheck({
      env: { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acct' },
      stdout: { write: s => (out += s) },
      stderr: { write: () => {} },
      fetchImpl,
    })
    return { code, out }
  }

  it('exits 1 when every binding is present but the bucket names disagree', async () => {
    const { code, out } = await run('node-assets')
    expect(code).toBe(1)
    expect(out).not.toMatch(/All required bindings present/)
    expect(out).toContain('the CATALOG_R2 binding names "node-assets"')
  })

  // An older setup run could have reverted the binding while the
  // variable stayed right, so the remedy must not pick a side.
  it('does not tell the operator which of the two to copy', async () => {
    const { out } = await run('node-assets')
    expect(out).toContain('Point both at the bucket that holds your assets')
    expect(out).not.toMatch(/Set CATALOG_R2_BUCKET=/)
  })

  it('still exits 0 for a pair it could not read, but says so', async () => {
    const { code, out } = await run('node-assets', env => env.secret.add('CATALOG_R2_BUCKET'))
    expect(code).toBe(0)
    expect(out).toContain('could not check that CATALOG_R2 and CATALOG_R2_BUCKET')
  })
})

/**
 * Inverse of `shellEnvironment` — turn one environment's typed
 * sets back into the Cloudflare deployment_config shape so the
 * test can feed it through fetch -> RestApiSource -> diffBindings.
 */
function serialise(
  env: ReturnType<typeof emptyEnv>,
  opts: { bucket?: string; values?: Record<string, string | null> } = {},
): Record<string, unknown> {
  const env_vars: Record<string, { value: string | null; type: string }> = {}
  for (const name of env.plaintext) {
    const value = opts.values && name in opts.values ? opts.values[name] : 'x'
    env_vars[name] = { value, type: 'plain_text' }
  }
  for (const name of env.secret) env_vars[name] = { value: null, type: 'secret_text' }
  return {
    env_vars,
    d1_databases: Object.fromEntries([...env.d1].map(n => [n, { id: 'x' }])),
    kv_namespaces: Object.fromEntries([...env.kv].map(n => [n, { namespace_id: 'x' }])),
    // The bucket name is read by the CATALOG_R2_BUCKET consistency
    // check, so the default has to be a name that agrees with an
    // unset variable.
    r2_buckets: Object.fromEntries(
      [...env.r2].map(n => [n, { name: opts.bucket ?? 'terraviz-assets' }]),
    ),
    vectorize_bindings: Object.fromEntries(
      [...env.vectorize].map(n => [n, { index_name: 'x' }]),
    ),
    ai_bindings: Object.fromEntries([...env.ai].map(n => [n, {}])),
    analytics_engine_datasets: Object.fromEntries(
      [...env.analytics_engine].map(n => [n, { dataset: 'x' }]),
    ),
  }
}
