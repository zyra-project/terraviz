import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authHeaders, DEFAULT_SERVER, resolveConfig } from './config'

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'tv-cli-')), 'config.json')
}

describe('resolveConfig', () => {
  it('falls back to the default server when nothing is set', () => {
    const config = resolveConfig({ env: {}, configPath: '/nonexistent.json' })
    expect(config.server).toBe(DEFAULT_SERVER)
    expect(config.insecureLocal).toBe(false)
    expect(config.clientId).toBeUndefined()
  })

  it('flags beat env beat persisted', () => {
    const path = tmpPath()
    writeFileSync(
      path,
      JSON.stringify({
        server: 'https://persisted.example',
        client_id: 'persisted-id',
      }),
    )
    const config = resolveConfig({
      configPath: path,
      env: { TERRAVIZ_SERVER: 'https://env.example' },
      flagServer: 'https://flag.example',
      flagClientId: 'flag-id',
    })
    expect(config.server).toBe('https://flag.example')
    expect(config.clientId).toBe('flag-id')
  })

  it('reads insecureLocal from any layer', () => {
    expect(resolveConfig({ flagInsecureLocal: true, env: {} }).insecureLocal).toBe(true)
    expect(
      resolveConfig({ env: { TERRAVIZ_INSECURE_LOCAL: '1' } }).insecureLocal,
    ).toBe(true)
    expect(
      resolveConfig({ env: { TERRAVIZ_INSECURE_LOCAL: 'true' } }).insecureLocal,
    ).toBe(true)
  })

  it('strips trailing slashes from server', () => {
    const config = resolveConfig({
      flagServer: 'https://example.com//',
      env: {},
    })
    expect(config.server).toBe('https://example.com')
  })
})

describe('authHeaders', () => {
  it('returns no headers under --insecure-local', () => {
    expect(
      authHeaders({
        server: 'http://localhost:8788',
        insecureLocal: true,
        clientId: 'x',
        clientSecret: 'y',
      }),
    ).toEqual({})
  })

  it('returns no headers when only one half is set', () => {
    expect(
      authHeaders({ server: 'https://example', insecureLocal: false, clientId: 'x' }),
    ).toEqual({})
    expect(
      authHeaders({ server: 'https://example', insecureLocal: false, clientSecret: 'y' }),
    ).toEqual({})
  })

  it('returns Cf-Access headers when both halves are set', () => {
    expect(
      authHeaders({
        server: 'https://example',
        insecureLocal: false,
        clientId: 'CID',
        clientSecret: 'SECRET',
      }),
    ).toEqual({
      'Cf-Access-Client-Id': 'CID',
      'Cf-Access-Client-Secret': 'SECRET',
    })
  })
})
