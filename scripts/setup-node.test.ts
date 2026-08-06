import { describe, expect, it } from 'vitest'
import {
  checkNodeVersion,
  collectSecrets,
  parseDotEnv,
  runSetup,
  type SetupDeps,
} from './setup-node.ts'
import type { CommandResult } from './lib/setup/provision.ts'

interface Harness {
  deps: SetupDeps
  out: () => string
  errOut: () => string
  writes: Map<string, string>
  calls: string[][]
}

function harness(overrides: Partial<SetupDeps> & { files?: Record<string, string> } = {}): Harness {
  const chunks: string[] = []
  const errChunks: string[] = []
  const writes = new Map<string, string>()
  const calls: string[][] = []
  const files: Record<string, string> = overrides.files ?? {}

  const deps: SetupDeps = {
    argv: [],
    env: {},
    stdout: { write: s => void chunks.push(s) },
    stderr: { write: s => void errChunks.push(s) },
    runner: async argv => {
      calls.push(argv)
      return { code: 0, stdout: '', stderr: '' } satisfies CommandResult
    },
    readFile: p => {
      if (p in files) return files[p]
      throw new Error(`unexpected read: ${p}`)
    },
    writeFile: (p, c) => void writes.set(p, c),
    exists: p => p in files,
    ...overrides,
  }
  return { deps, out: () => chunks.join(''), errOut: () => errChunks.join(''), writes, calls }
}

/**
 * The pre-flight sheet lists Node as `detected` — "setup will catch
 * this". That claim has to be true, and the failing path is the one
 * nobody can reach by running the suite, since the suite runs on a
 * supported version by definition. So it is injected.
 */
describe('checkNodeVersion', () => {
  it('rejects a major below what engines requires, and says what it found', () => {
    expect(checkNodeVersion('v18.20.4')).toEqual({ ok: false, found: '18.20.4' })
    expect(checkNodeVersion('v20.11.0').ok).toBe(false)
  })

  it('accepts the required major and anything newer', () => {
    expect(checkNodeVersion('v22.0.0').ok).toBe(true)
    expect(checkNodeVersion('v24.1.0').ok).toBe(true)
  })

  it('refuses a version it cannot parse rather than assuming the best', () => {
    expect(checkNodeVersion('unknown').ok).toBe(false)
  })
})

describe('runSetup — Node version gate', () => {
  it('stops before doing anything, naming the version and where to get one', () => {
    const out: string[] = []
    const err: string[] = []
    const code = runSetup({
      argv: [],
      env: {},
      stdout: { write: s => void out.push(s) },
      stderr: { write: s => void err.push(s) },
      runner: () => {
        throw new Error('must not run a command on an unsupported Node')
      },
      readFile: () => '',
      writeFile: () => {},
      exists: () => false,
      nodeVersion: 'v18.20.4',
    } as unknown as SetupDeps)
    return Promise.resolve(code).then(c => {
      expect(c).toBe(2)
      expect(err.join('')).toContain('Node 18.20.4 is too old')
      expect(err.join('')).toContain('nodejs.org')
      expect(out.join('')).toBe('')
    })
  })
})

describe('parseDotEnv', () => {
  it('reads plain assignments and strips quotes', () => {
    expect(parseDotEnv('A=1\nB="two"\nC=\'three\'')).toEqual({ A: '1', B: 'two', C: 'three' })
  })

  it('ignores comments, blanks and malformed lines', () => {
    expect(parseDotEnv('# note\n\nBARE\n=novalue\nD=4')).toEqual({ D: '4' })
  })

  it('keeps base64 padding and other = characters in the value', () => {
    expect(parseDotEnv('K=abc=def==').K).toBe('abc=def==')
  })
})

describe('collectSecrets', () => {
  it('reads a manifest secret from the environment', () => {
    const s = collectSecrets({ PREVIEW_SIGNING_KEY: 'env-value' }, null)
    expect(s.PREVIEW_SIGNING_KEY).toBe('env-value')
  })

  it('falls back to .dev.vars', () => {
    const s = collectSecrets({}, 'NODE_ID_PRIVATE_KEY_PEM=from-file')
    expect(s.NODE_ID_PRIVATE_KEY_PEM).toBe('from-file')
  })

  it('prefers the environment over .dev.vars', () => {
    const s = collectSecrets(
      { PREVIEW_SIGNING_KEY: 'from-env' },
      'PREVIEW_SIGNING_KEY=from-file',
    )
    expect(s.PREVIEW_SIGNING_KEY).toBe('from-env')
  })

  // The safety property this allowlist exists for: .dev.vars carries
  // DEV_BYPASS_ACCESS=true and the MOCK_* flags, and pushing those to
  // a production Pages environment would disable Access auth on the
  // publisher API.
  it('never picks up dev-only flags from .dev.vars', () => {
    const devVars = [
      'DEV_BYPASS_ACCESS=true',
      'DEV_PUBLISHER_EMAIL=dev@localhost',
      'MOCK_R2=true',
      'MOCK_AI=true',
      'MOCK_STREAM=true',
      'ALLOW_DEV_PREVIEW_FALLBACK=true',
      'PREVIEW_SIGNING_KEY=real',
    ].join('\n')
    const s = collectSecrets({}, devVars)
    expect(Object.keys(s)).toEqual(['PREVIEW_SIGNING_KEY'])
    expect(s.DEV_BYPASS_ACCESS).toBeUndefined()
    expect(s.MOCK_R2).toBeUndefined()
  })

  it('ignores an environment variable that is not a manifest secret', () => {
    const s = collectSecrets({ SOMETHING_ELSE: 'x' }, null)
    expect(s.SOMETHING_ELSE).toBeUndefined()
  })
})

describe('runSetup — plan mode', () => {
  it('is the default and makes no changes', async () => {
    const h = harness({ files: { 'wrangler.toml': 'name = "terraviz"\n' } })
    const code = await runSetup(h.deps)
    expect(code).toBe(0)
    expect(h.writes.size).toBe(0)
    expect(h.calls).toEqual([])
    expect(h.out()).toContain('PLAN (no changes')
    expect(h.out()).toContain('Re-run with --apply')
  })

  it('shows what it would create', async () => {
    const h = harness({ files: { 'wrangler.toml': '' }, argv: ['--only=resources'] })
    await runSetup(h.deps)
    expect(h.out()).toContain('would ensure D1')
    expect(h.out()).toContain('would ensure Vectorize')
    expect(h.out()).toContain('created on first write')
  })

  it('reports unknown steps rather than silently doing everything', async () => {
    const h = harness({ argv: ['--only=bogus'] })
    expect(await runSetup(h.deps)).toBe(2)
    expect(h.errOut()).toContain('unknown step')
  })

  it('rejects an unrecognised flag', async () => {
    const h = harness({ argv: ['--force'] })
    expect(await runSetup(h.deps)).toBe(2)
  })

  it('prints help without touching anything', async () => {
    const h = harness({ argv: ['--help'] })
    expect(await runSetup(h.deps)).toBe(0)
    expect(h.out()).toContain('Prerequisites this tool cannot do for you')
    expect(h.writes.size).toBe(0)
  })
})

describe('runSetup — wrangler.toml step', () => {
  const CONFIG = [
    '[[d1_databases]]',
    'binding = "CATALOG_DB"',
    'database_name = "sphere-feedback"',
    'database_id = "78fbe5c3-8e40-4504-b183-155b0069222e"',
    '',
  ].join('\n')

  // A fresh clone is legitimately still pinned upstream, so the plan
  // reports it and carries on; only an apply treats it as fatal,
  // because running migrations against upstream's database is the
  // failure this whole guard exists to prevent.
  it('reports upstream pinning in plan mode without failing', async () => {
    const h = harness({
      argv: ['--only=wrangler-toml'],
      files: { 'wrangler.toml': CONFIG },
    })
    expect(await runSetup(h.deps)).toBe(0)
    expect(h.out()).toContain('still pinned to upstream')
    expect(h.writes.size).toBe(0)
  })

  it('refuses to apply while still pinned upstream', async () => {
    const h = harness({
      argv: ['--only=wrangler-toml', '--apply'],
      files: { 'wrangler.toml': CONFIG },
    })
    expect(await runSetup(h.deps)).toBe(1)
    expect(h.errOut()).toContain('still pinned to upstream')
    expect(h.writes.has('wrangler.toml')).toBe(false)
  })

  it('writes the repointed file under --apply', async () => {
    const h = harness({
      argv: ['--only=wrangler-toml', '--apply'],
      files: {
        'wrangler.toml': CONFIG,
        '.terraviz-setup.json': JSON.stringify({ d1: { name: 'db', id: 'MY-ID' } }),
      },
    })
    expect(await runSetup(h.deps)).toBe(0)
    expect(h.writes.get('wrangler.toml')).toContain('database_id = "MY-ID"')
  })

  it('does not write the file in plan mode', async () => {
    const h = harness({
      argv: ['--only=wrangler-toml'],
      files: {
        'wrangler.toml': CONFIG,
        '.terraviz-setup.json': JSON.stringify({ d1: { name: 'db', id: 'MY-ID' } }),
      },
    })
    await runSetup(h.deps)
    expect(h.writes.has('wrangler.toml')).toBe(false)
    expect(h.out()).toContain('would set')
  })
})

describe('runSetup — migrations step', () => {
  // The order was once load-bearing: FEEDBACK_DB's migrations dir also
  // held the generated catalog snapshot, which on an empty database
  // applied for real and created the catalog schema outside the
  // migration tracker, after which every CATALOG_DB migration failed on
  // "table node_identity already exists". The snapshot moved to
  // `schema/`, so the two sets are disjoint and either order works.
  // Pinned anyway, because a stable order keeps the output readable.
  it('applies CATALOG_DB before FEEDBACK_DB', async () => {
    const h = harness({ argv: ['--only=migrations', '--apply'], files: {} })
    expect(await runSetup(h.deps)).toBe(0)
    expect(h.calls.map(c => c[3])).toEqual(['CATALOG_DB', 'FEEDBACK_DB'])
  })

  /**
   * There used to be a tolerated failure here. `catalog-schema.sql` sat
   * in FEEDBACK_DB's migrations dir, wrangler queued it as a migration,
   * and it always failed — so `npm run setup` special-cased that one
   * filename and carried on.
   *
   * The file moved out of the migrations tree, so there is nothing left
   * to tolerate. This pins the consequence: a FEEDBACK_DB migration
   * failure is now just a failure, including one phrased the way the
   * snapshot's used to be.
   */
  it('no longer tolerates a snapshot-shaped failure on FEEDBACK_DB', async () => {
    const h = harness({
      argv: ['--only=migrations', '--apply'],
      files: {},
      runner: async argv =>
        argv[3] === 'FEEDBACK_DB'
          ? {
              code: 1,
              stdout: '',
              stderr:
                'Migration catalog-schema.sql failed with the following errors:\n' +
                'table analytics_daily already exists',
            }
          : { code: 0, stdout: '', stderr: '' },
    })
    expect(await runSetup(h.deps)).toBe(1)
    expect(h.errOut()).toContain('analytics_daily')
  })

  // An "already exists" failure is a schema problem, and continuing
  // past it would report a broken install as a clean one.
  it('fails on an already-exists error from a real migration', async () => {
    const h = harness({
      argv: ['--only=migrations', '--apply'],
      files: {},
      runner: async argv =>
        argv[3] === 'FEEDBACK_DB'
          ? {
              code: 1,
              stdout: '',
              stderr:
                'Migration 0008_events.sql failed with the following errors:\n' +
                'table events already exists',
            }
          : { code: 0, stdout: '', stderr: '' },
    })
    expect(await runSetup(h.deps)).toBe(1)
    expect(h.errOut()).toContain('0008_events.sql')
  })

  it('fails the same way on CATALOG_DB', async () => {
    const h = harness({
      argv: ['--only=migrations', '--apply'],
      files: {},
      runner: async () => ({ code: 1, stdout: '', stderr: 'table datasets already exists' }),
    })
    expect(await runSetup(h.deps)).toBe(1)
  })

  it('stops on the first failure instead of reporting success', async () => {
    const h = harness({
      argv: ['--only=migrations', '--apply'],
      files: {},
      runner: async () => ({ code: 1, stdout: '', stderr: 'no such database' }),
    })
    expect(await runSetup(h.deps)).toBe(1)
    expect(h.errOut()).toContain('no such database')
  })

  it('honours --local-migrations for a dry run', async () => {
    const h = harness({
      argv: ['--only=migrations', '--apply', '--local-migrations'],
      files: {},
    })
    await runSetup(h.deps)
    expect(h.calls[0]).toContain('--local')
    expect(h.calls[0]).not.toContain('--remote')
  })
})

describe('runSetup — bindings step', () => {
  const state = JSON.stringify({
    accountId: 'acct',
    pagesProject: 'my-node',
    d1: { name: 'db', id: 'd1id' },
    telemetryKv: { name: 'TELEMETRY_KILL_SWITCH', id: 'kv1' },
    catalogKv: { name: 'CATALOG_KV', id: 'kv2' },
  })

  it('needs a token and account id before it will write', async () => {
    const h = harness({
      argv: ['--only=bindings', '--apply'],
      files: { '.terraviz-setup.json': state },
    })
    expect(await runSetup(h.deps)).toBe(2)
    expect(h.errOut()).toContain('Cloudflare Pages → Edit')
  })

  it('PATCHes both environments and reports the manual leftovers', async () => {
    let body: unknown
    const h = harness({
      argv: ['--only=bindings', '--apply'],
      env: { CLOUDFLARE_API_TOKEN: 'tok' },
      files: { '.terraviz-setup.json': state },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body))
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    expect(await runSetup(h.deps)).toBe(0)
    const configs = (body as { deployment_configs: Record<string, unknown> }).deployment_configs
    expect(Object.keys(configs).sort()).toEqual(['preview', 'production'])
    expect(h.out()).toContain('left unset')
  })

  it('surfaces an API failure rather than claiming success', async () => {
    const h = harness({
      argv: ['--only=bindings', '--apply'],
      env: { CLOUDFLARE_API_TOKEN: 'tok' },
      files: { '.terraviz-setup.json': state },
      fetchImpl: (async () =>
        new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), {
          status: 403,
          statusText: 'Forbidden',
        })) as unknown as typeof fetch,
    })
    expect(await runSetup(h.deps)).toBe(1)
    expect(h.errOut()).toContain('Cloudflare Pages → Edit')
  })

  // R2 / Vectorize / AE / AI bindings resolve from default *names*
  // even with no state at all, so "something resolved" is not proof
  // the resources exist. Only the D1 + KV ids are.
  it('refuses to write a half-wired project when the resource ids are unknown', async () => {
    const h = harness({
      argv: ['--only=bindings', '--apply'],
      env: { CLOUDFLARE_API_TOKEN: 'tok' },
      files: { '.terraviz-setup.json': JSON.stringify({ accountId: 'a' }) },
      fetchImpl: (async () => {
        throw new Error('must not reach the API')
      }) as unknown as typeof fetch,
    })
    expect(await runSetup(h.deps)).toBe(1)
    expect(h.errOut()).toContain('no resource ID for')
    expect(h.errOut()).toContain('the resources step first')
  })

  it('still plans without ids, so an operator can preview the shape', async () => {
    const h = harness({ argv: ['--only=bindings'], files: {} })
    expect(await runSetup(h.deps)).toBe(0)
    expect(h.out()).toContain('CATALOG_DB')
  })
})

describe('runSetup — state persistence', () => {
  it('never persists a secret value', async () => {
    const h = harness({
      argv: ['--only=bindings', '--apply'],
      env: { CLOUDFLARE_API_TOKEN: 'tok', PREVIEW_SIGNING_KEY: 'NEVER-PERSIST-ME' },
      files: {
        '.terraviz-setup.json': JSON.stringify({
          accountId: 'a',
          d1: { name: 'db', id: 'x' },
          telemetryKv: { name: 'TELEMETRY_KILL_SWITCH', id: 'kv1' },
          catalogKv: { name: 'CATALOG_KV', id: 'kv2' },
        }),
      },
      fetchImpl: (async () =>
        new Response(JSON.stringify({ success: true }), { status: 200 })) as unknown as typeof fetch,
    })
    await runSetup(h.deps)
    expect(h.writes.get('.terraviz-setup.json')).not.toContain('NEVER-PERSIST-ME')
  })

  it('writes no state file in plan mode', async () => {
    const h = harness({ argv: ['--only=resources'], files: {} })
    await runSetup(h.deps)
    expect(h.writes.has('.terraviz-setup.json')).toBe(false)
  })
})

describe('runSetup — access step', () => {
  const state = JSON.stringify({
    accountId: 'acct',
    pagesProject: 'my-node',
    hostname: 'terraviz.example.org',
    staffEmailDomain: 'example.org',
  })

  /** Minimal Access API stub keyed by "METHOD /suffix". */
  function accessFetch(routes: Record<string, unknown>, seen: string[] = []): typeof fetch {
    return (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const path = new URL(url).pathname.replace(/^\/client\/v4\/accounts\/[^/]+/, '')
      seen.push(`${method} ${path}`)
      const key = `${method} ${path}`
      if (!(key in routes)) {
        return new Response(JSON.stringify({ success: false, errors: [{ message: 'no stub' }] }), {
          status: 404,
          statusText: 'Not Found',
        })
      }
      return new Response(JSON.stringify({ success: true, result: routes[key] }), { status: 200 })
    }) as unknown as typeof fetch
  }

  const HAPPY = {
    'GET /access/organizations': { auth_domain: 'acme.cloudflareaccess.com' },
    'GET /access/apps': [],
    'POST /access/apps': { id: 'app1', name: 'Terraviz Publisher', aud: 'AUD123' },
    'GET /access/service_tokens': [],
    'POST /access/service_tokens': {
      id: 'tok1',
      name: 'terraviz-cli',
      client_id: 'CID',
      client_secret: 'CSECRET',
    },
    'GET /access/apps/app1/policies': [],
    'POST /access/apps/app1/policies': { id: 'p', name: 'x', decision: 'allow' },
  }

  it('plans without touching the network or needing credentials', async () => {
    const h = harness({
      argv: ['--only=access'],
      files: { '.terraviz-setup.json': state },
      fetchImpl: (async () => {
        throw new Error('plan mode must not call the API')
      }) as unknown as typeof fetch,
    })
    expect(await runSetup(h.deps)).toBe(0)
    expect(h.out()).toContain('terraviz.example.org/api/v1/publish')
    expect(h.out()).toContain('my-node.pages.dev/publish/*')
  })

  it('records the team domain and AUD, and prints the token secret once', async () => {
    const h = harness({
      argv: ['--only=access', '--apply'],
      env: { CLOUDFLARE_API_TOKEN: 'tok' },
      files: { '.terraviz-setup.json': state },
      fetchImpl: accessFetch(HAPPY),
    })
    expect(await runSetup(h.deps)).toBe(0)
    const saved = JSON.parse(h.writes.get('.terraviz-setup.json')!)
    expect(saved.accessTeamDomain).toBe('acme.cloudflareaccess.com')
    expect(saved.accessAud).toBe('AUD123')
    expect(saved.accessAppId).toBe('app1')
    expect(saved.serviceTokenId).toBe('tok1')
    expect(h.out()).toContain('CSECRET')
  })

  // The client secret is unrecoverable, so it must never be the thing
  // that lands in a file the operator forgets about.
  it('never persists the service token secret', async () => {
    const h = harness({
      argv: ['--only=access', '--apply'],
      env: { CLOUDFLARE_API_TOKEN: 'tok' },
      files: { '.terraviz-setup.json': state },
      fetchImpl: accessFetch(HAPPY),
    })
    await runSetup(h.deps)
    expect(h.writes.get('.terraviz-setup.json')).not.toContain('CSECRET')
  })

  it('warns that an adopted token has no recoverable secret', async () => {
    const h = harness({
      argv: ['--only=access', '--apply'],
      env: { CLOUDFLARE_API_TOKEN: 'tok' },
      files: { '.terraviz-setup.json': state },
      fetchImpl: accessFetch({
        ...HAPPY,
        'GET /access/service_tokens': [{ id: 'tok1', name: 'terraviz-cli', client_id: 'CID' }],
      }),
    })
    expect(await runSetup(h.deps)).toBe(0)
    expect(h.out()).toContain('not recoverable')
  })

  it('stops with a pointer at Zero Trust onboarding when there is no organization', async () => {
    const h = harness({
      argv: ['--only=access', '--apply'],
      env: { CLOUDFLARE_API_TOKEN: 'tok' },
      files: { '.terraviz-setup.json': state },
      fetchImpl: accessFetch({}),
    })
    expect(await runSetup(h.deps)).toBe(1)
    expect(h.errOut()).toContain('Zero Trust')
  })

  it('flags a missing staff domain — without it no human can sign in', async () => {
    const h = harness({
      argv: ['--only=access', '--apply'],
      env: { CLOUDFLARE_API_TOKEN: 'tok' },
      files: {
        '.terraviz-setup.json': JSON.stringify({
          accountId: 'acct',
          pagesProject: 'my-node',
          hostname: 'terraviz.example.org',
        }),
      },
      fetchImpl: accessFetch(HAPPY),
    })
    expect(await runSetup(h.deps)).toBe(0)
    expect(h.out()).toContain('no human can sign in')
  })

  it('requires credentials before it will write', async () => {
    const h = harness({
      argv: ['--only=access', '--apply'],
      files: { '.terraviz-setup.json': state },
    })
    expect(await runSetup(h.deps)).toBe(2)
    expect(h.errOut()).toContain('Access: Apps and Policies')
  })
})

describe('runSetup — secrets step', () => {
  it('generates the preview key and names gen:node-key for the other', async () => {
    const h = harness({
      argv: ['--only=secrets', '--apply'],
      files: { '.dev.vars': 'DEV_BYPASS_ACCESS=true\n' },
    })
    expect(await runSetup(h.deps)).toBe(0)
    const written = h.writes.get('.dev.vars')!
    expect(written).toContain('PREVIEW_SIGNING_KEY=')
    expect(written).toContain('DEV_BYPASS_ACCESS=true')
    expect(h.out()).toContain('gen:node-key')
  })

  it('writes nothing in plan mode', async () => {
    const h = harness({ argv: ['--only=secrets'], files: { '.dev.vars': 'A=1\n' } })
    await runSetup(h.deps)
    expect(h.writes.has('.dev.vars')).toBe(false)
    expect(h.out()).toContain('would write')
  })

  // The whole point of generating into .dev.vars: one run can create
  // the key and push it, without the value passing through a shell.
  it('feeds the generated key straight into the bindings step', async () => {
    let body: string | undefined
    const h = harness({
      argv: ['--only=secrets,bindings', '--apply'],
      env: { CLOUDFLARE_API_TOKEN: 'tok' },
      files: {
        '.dev.vars': 'NODE_ID_PRIVATE_KEY_PEM=nk\n',
        '.terraviz-setup.json': JSON.stringify({
          accountId: 'a',
          d1: { name: 'db', id: 'x' },
          telemetryKv: { name: 'TELEMETRY_KILL_SWITCH', id: 'k1' },
          catalogKv: { name: 'CATALOG_KV', id: 'k2' },
        }),
      },
      fetchImpl: (async (_u: string, init: RequestInit) => {
        body = String(init.body)
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    expect(await runSetup(h.deps)).toBe(0)
    const parsed = JSON.parse(body!)
    expect(parsed.deployment_configs.production.env_vars.PREVIEW_SIGNING_KEY.type).toBe(
      'secret_text',
    )
  })
})

describe('runSetup — step selection', () => {
  // waf rewrites the zone's custom-rule list and the rulesets API
  // replaces rather than appends, so it must never run just because
  // someone typed --apply.
  it('excludes waf and r2 from a default run', async () => {
    const h = harness({ files: { 'wrangler.toml': 'name = "x"\n' } })
    await runSetup(h.deps)
    expect(h.out()).not.toContain('WAF skip rules')
    expect(h.out()).not.toContain('R2 public domain')
  })

  it('runs them when asked explicitly', async () => {
    const h = harness({
      argv: ['--only=waf'],
      files: { '.terraviz-setup.json': JSON.stringify({ hostname: 'a.example.org' }) },
    })
    expect(await runSetup(h.deps)).toBe(0)
    expect(h.out()).toContain('WAF skip rules')
  })

  it('includes the Pages project step by default', async () => {
    const h = harness({ files: { 'wrangler.toml': 'name = "x"\n' } })
    await runSetup(h.deps)
    expect(h.out()).toContain('Phase 5 — Pages project')
  })
})

describe('runSetup — pages step', () => {
  const state = JSON.stringify({
    accountId: 'acct',
    pagesProject: 'my-node',
    hostname: 'terraviz.example.org',
  })

  function pagesFetch(routes: Record<string, unknown>): typeof fetch {
    return (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const path = new URL(url).pathname.replace(/^\/client\/v4/, '')
      const key = `${method} ${path}`
      if (!(key in routes)) {
        return new Response(JSON.stringify({ success: false, errors: [{ message: 'missing' }] }), {
          status: 404,
          statusText: 'Not Found',
        })
      }
      return new Response(JSON.stringify({ success: true, result: routes[key] }), { status: 200 })
    }) as unknown as typeof fetch
  }

  it('creates the project and attaches the domain', async () => {
    const h = harness({
      argv: ['--only=pages', '--apply'],
      env: { CLOUDFLARE_API_TOKEN: 'tok' },
      files: { '.terraviz-setup.json': state },
      fetchImpl: pagesFetch({
        'POST /accounts/acct/pages/projects': { name: 'my-node' },
        'GET /accounts/acct/pages/projects/my-node/domains': [],
        'POST /accounts/acct/pages/projects/my-node/domains': {
          name: 'terraviz.example.org',
          status: 'pending',
        },
      }),
    })
    expect(await runSetup(h.deps)).toBe(0)
    expect(h.out()).toContain('project  my-node  created')
    expect(h.out()).toContain('terraviz.example.org')
  })

  // Direct Upload means Cloudflare never runs the build, so the
  // VITE_* variables have to live in CI instead. Silence here would
  // produce a site built without them.
  it('warns that a created project is Direct Upload', async () => {
    const h = harness({
      argv: ['--only=pages', '--apply'],
      env: { CLOUDFLARE_API_TOKEN: 'tok' },
      files: { '.terraviz-setup.json': state },
      fetchImpl: pagesFetch({
        'POST /accounts/acct/pages/projects': { name: 'my-node' },
        'GET /accounts/acct/pages/projects/my-node/domains': [],
        'POST /accounts/acct/pages/projects/my-node/domains': { name: 'x' },
      }),
    })
    await runSetup(h.deps)
    expect(h.out()).toContain('Direct Upload')
    expect(h.out()).toContain('VITE_*')
  })

  it('stays quiet about Direct Upload for a Git-connected project', async () => {
    const h = harness({
      argv: ['--only=pages', '--apply'],
      env: { CLOUDFLARE_API_TOKEN: 'tok' },
      files: { '.terraviz-setup.json': state },
      fetchImpl: pagesFetch({
        'GET /accounts/acct/pages/projects/my-node': {
          name: 'my-node',
          source: { type: 'github' },
        },
        'GET /accounts/acct/pages/projects/my-node/domains': [
          { name: 'terraviz.example.org', status: 'active' },
        ],
      }),
    })
    expect(await runSetup(h.deps)).toBe(0)
    expect(h.out()).not.toContain('Direct Upload')
  })
})

describe('runSetup — r2 step', () => {
  it('refuses to guess the site origin', async () => {
    const h = harness({
      argv: ['--only=r2', '--apply'],
      env: { CLOUDFLARE_API_TOKEN: 'tok' },
      files: { '.terraviz-setup.json': JSON.stringify({ accountId: 'a' }) },
    })
    expect(await runSetup(h.deps)).toBe(2)
    expect(h.errOut()).toContain('TERRAVIZ_HOSTNAME is required')
  })

  it('shows the origins it would allow', async () => {
    const h = harness({
      argv: ['--only=r2'],
      files: { '.terraviz-setup.json': JSON.stringify({ hostname: 'a.example.org' }) },
    })
    expect(await runSetup(h.deps)).toBe(0)
    expect(h.out()).toContain('GET/HEAD')
    expect(h.out()).toContain('https://a.example.org')
  })

  // A failed API call must still leave the operator with something
  // they can paste, rather than a policy they have to re-derive.
  it('prints the dashboard JSON when the CORS call fails', async () => {
    const h = harness({
      argv: ['--only=r2', '--apply'],
      env: { CLOUDFLARE_API_TOKEN: 'tok' },
      files: {
        '.terraviz-setup.json': JSON.stringify({ accountId: 'a', hostname: 'a.example.org' }),
      },
      fetchImpl: (async () =>
        new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'nope' }] }), {
          status: 403,
          statusText: 'Forbidden',
        })) as unknown as typeof fetch,
    })
    expect(await runSetup(h.deps)).toBe(1)
    expect(h.errOut()).toContain('AllowedOrigins')
    expect(h.errOut()).toContain('Content-Range')
  })
})

describe('runSetup — github secrets', () => {
  it('prints the script and exits without touching anything', async () => {
    const h = harness({
      argv: ['--github-secrets'],
      files: { '.terraviz-setup.json': JSON.stringify({ githubOwner: 'me', githubRepo: 'mine' }) },
    })
    expect(await runSetup(h.deps)).toBe(0)
    expect(h.out()).toContain('gh secret set CF_ACCESS_CLIENT_ID --repo me/mine')
    expect(h.writes.size).toBe(0)
    expect(h.calls).toEqual([])
  })
})

describe('runSetup — interactive mode', () => {
  /** A prompter that answers from a script and records what it saw. */
  function scriptedPrompter(answers: Record<string, string>, confirmYes = true) {
    const asked: string[] = []
    const said: string[] = []
    return {
      asked,
      said: () => said.join(''),
      prompter: {
        ask: async (q: { key: string }) => {
          asked.push(q.key)
          return answers[q.key] ?? null
        },
        confirm: async () => confirmYes,
        say: (t: string) => void said.push(t),
        close: () => {},
      },
    }
  }

  it('asks only for what it cannot discover', async () => {
    const p = scriptedPrompter({
      accountId: '8f4c1d2e9a7b6c5d4e3f2a1b0c9d8e7f',
      hostname: 'a.example.org',
      pagesProject: 'my-node',
      staffEmailDomain: 'example.org',
    })
    const h = harness({
      argv: ['--interactive', '--only=bindings'],
      env: { TERRAVIZ_HOSTNAME: 'already.set' },
      files: {},
      prompter: p.prompter,
    })
    await runSetup(h.deps)
    expect(p.asked).not.toContain('hostname')
    expect(p.asked).toContain('accountId')
  })

  it('records answers into state', async () => {
    const p = scriptedPrompter({
      accountId: '8f4c1d2e9a7b6c5d4e3f2a1b0c9d8e7f',
      hostname: 'a.example.org',
      pagesProject: 'my-node',
      staffEmailDomain: 'example.org',
      trustedPublisherDomains: 'example.org',
    })
    const h = harness({
      argv: ['--interactive', '--only=bindings'],
      files: {},
      prompter: p.prompter,
    })
    await runSetup(h.deps)
    const saved = JSON.parse(h.writes.get('.terraviz-setup.json')!)
    expect(saved.accountId).toBe('8f4c1d2e9a7b6c5d4e3f2a1b0c9d8e7f')
    expect(saved.hostname).toBe('a.example.org')
    expect(saved.staffEmailDomain).toBe('example.org')
  })

  // Saving in plan mode is an exception to "plan writes nothing", so
  // it has to be announced rather than silent.
  it('announces that it saved answers on a plan run', async () => {
    const p = scriptedPrompter({ accountId: '8f4c1d2e9a7b6c5d4e3f2a1b0c9d8e7f' })
    const h = harness({ argv: ['--interactive', '--only=bindings'], files: {}, prompter: p.prompter })
    await runSetup(h.deps)
    expect(p.said()).toContain('Answers saved')
  })

  it('warns when the API token is missing from the shell', async () => {
    const p = scriptedPrompter({})
    const h = harness({ argv: ['--interactive', '--only=bindings'], files: {}, prompter: p.prompter })
    await runSetup(h.deps)
    expect(p.said()).toContain('CLOUDFLARE_API_TOKEN is not set')
  })

  it('aborts without applying when the confirmation is declined', async () => {
    const p = scriptedPrompter({ accountId: '8f4c1d2e9a7b6c5d4e3f2a1b0c9d8e7f' }, false)
    const h = harness({
      argv: ['--interactive', '--apply', '--only=bindings'],
      env: { CLOUDFLARE_API_TOKEN: 'tok' },
      files: {},
      prompter: p.prompter,
      fetchImpl: (async () => {
        throw new Error('must not reach the API')
      }) as unknown as typeof fetch,
    })
    expect(await runSetup(h.deps)).toBe(0)
    expect(p.said()).toContain('Nothing applied')
  })

  // The whole point of --interactive is that a skipped question tells
  // you how to supply it instead, rather than failing three phases on.
  it('names the env var for a skipped required question', async () => {
    const p = scriptedPrompter({})
    const h = harness({ argv: ['--interactive', '--only=bindings'], files: {}, prompter: p.prompter })
    await runSetup(h.deps)
    expect(p.said()).toContain('CLOUDFLARE_ACCOUNT_ID')
  })

  it('includes feature-gated questions when --with is given', async () => {
    const p = scriptedPrompter({})
    const h = harness({
      argv: ['--interactive', '--with=r2', '--only=bindings'],
      files: {},
      prompter: p.prompter,
    })
    await runSetup(h.deps)
    expect(p.asked).toContain('r2PublicBase')
  })

  // Without a prompter (no TTY), the interview must fall through
  // rather than hang.
  it('does not block when no prompter is available', async () => {
    const h = harness({ argv: ['--interactive', '--only=bindings'], files: {} })
    expect(await runSetup(h.deps)).toBe(0)
  })
})

describe('runSetup — manual instructions', () => {
  it('prints the prerequisites and exits without touching anything', async () => {
    const h = harness({ argv: ['--manual'] })
    expect(await runSetup(h.deps)).toBe(0)
    expect(h.out()).toContain('Enable Workers Paid')
    expect(h.out()).toContain('Complete Zero Trust onboarding')
    expect(h.writes.size).toBe(0)
    expect(h.calls).toEqual([])
  })

  it('adds the R2 token step under --with=r2', async () => {
    const h = harness({ argv: ['--manual', '--with=r2'] })
    await runSetup(h.deps)
    expect(h.out()).toContain('Mint the R2 S3 API token')
  })

  it('rejects an unknown feature', async () => {
    const h = harness({ argv: ['--with=bogus'] })
    expect(await runSetup(h.deps)).toBe(2)
    expect(h.errOut()).toContain('unknown feature')
  })
})

describe('runSetup — handoff report', () => {
  it('ends every run with the paste-elsewhere checklist', async () => {
    const h = harness({
      argv: ['--only=bindings'],
      files: { '.terraviz-setup.json': JSON.stringify({ hostname: 'a.example.org' }) },
    })
    await runSetup(h.deps)
    expect(h.out()).toContain('Values you need to paste elsewhere')
    expect(h.out()).toContain('VITE_API_ORIGIN = https://a.example.org')
  })
})
