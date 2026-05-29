import { describe, expect, it, vi } from 'vitest'
import { runInitNode } from './init-node'
import type { CommandContext } from './commands'
import type { TerravizClient } from './lib/client'
import { parseArgs } from './lib/args'

function makeStream() {
  let buf = ''
  return {
    write(chunk: string) {
      buf += chunk
      return true
    },
    text() {
      return buf
    },
  }
}

interface CtxOverrides {
  setNodeIdentity?: unknown
  readFile?: (path: string) => string
}

function makeCtx(argv: string[], overrides: CtxOverrides = {}) {
  const parsed = parseArgs(argv)
  const setNodeIdentity =
    overrides.setNodeIdentity ??
    vi.fn(async () => ({
      ok: true as const,
      status: 200,
      body: {
        identity: {
          node_id: 'NODE_ULID',
          display_name: 'Terraviz — Acme',
          base_url: 'https://terraviz.acme.org',
          contact_email: 'ops@acme.org',
          public_key: 'ed25519:abc',
        },
      },
    }))
  const client = { setNodeIdentity } as unknown as TerravizClient
  const stdout = makeStream()
  const stderr = makeStream()
  const ctx: CommandContext = {
    client,
    args: { positional: parsed.positional, options: parsed.options },
    stdout,
    stderr,
    readFile: overrides.readFile,
  }
  return { ctx, stdout, stderr, setNodeIdentity }
}

describe('terraviz init-node', () => {
  it('requires --display-name and --base-url', async () => {
    const { ctx, stderr } = makeCtx(['init-node', '--display-name=X'])
    const code = await runInitNode(ctx)
    expect(code).toBe(2)
    expect(stderr.text()).toContain('Usage: terraviz init-node')
  })

  it('sends the identity body with an explicit --public-key', async () => {
    const { ctx, stdout, setNodeIdentity } = makeCtx([
      'init-node',
      '--display-name=Terraviz — Acme',
      '--base-url=https://terraviz.acme.org',
      '--contact=ops@acme.org',
      '--public-key=ed25519:abc',
    ])
    const code = await runInitNode(ctx)
    expect(code).toBe(0)
    expect(setNodeIdentity).toHaveBeenCalledWith({
      display_name: 'Terraviz — Acme',
      base_url: 'https://terraviz.acme.org',
      description: null,
      contact_email: 'ops@acme.org',
      public_key: 'ed25519:abc',
    })
    expect(stdout.text()).toContain('Node identity provisioned')
    expect(stdout.text()).toContain('NODE_ULID')
  })

  it('reads the public key from node-public-key.txt by default', async () => {
    const readFile = vi.fn(
      (_p: string) =>
        'ed25519:fromfile\n\n# Paste this into your node\'s well-known document\n',
    )
    const { ctx, setNodeIdentity } = makeCtx(
      ['init-node', '--display-name=N', '--base-url=https://n.example.org'],
      { readFile },
    )
    const code = await runInitNode(ctx)
    expect(code).toBe(0)
    expect(readFile).toHaveBeenCalledWith('node-public-key.txt')
    expect(setNodeIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ public_key: 'ed25519:fromfile' }),
    )
  })

  it('proceeds (key omitted) when the default key file is absent', async () => {
    const readFile = vi.fn((_p: string) => {
      throw new Error('ENOENT')
    })
    const { ctx, setNodeIdentity } = makeCtx(
      ['init-node', '--display-name=N', '--base-url=https://n.example.org'],
      { readFile },
    )
    const code = await runInitNode(ctx)
    expect(code).toBe(0)
    expect(setNodeIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ public_key: undefined }),
    )
  })

  it('errors when an explicitly-named key file is missing', async () => {
    const readFile = vi.fn((_p: string) => {
      throw new Error('ENOENT')
    })
    const { ctx, stderr } = makeCtx(
      [
        'init-node',
        '--display-name=N',
        '--base-url=https://n.example.org',
        '--public-key-file=missing.txt',
      ],
      { readFile },
    )
    const code = await runInitNode(ctx)
    expect(code).toBe(2)
    expect(stderr.text()).toContain('Could not read missing.txt')
  })

  it('surfaces the gen-node-key hint on a public_key-required error', async () => {
    const setNodeIdentity = vi.fn(async () => ({
      ok: false as const,
      status: 400,
      error: 'validation_failed',
      errors: [{ field: 'public_key', code: 'required', message: 'public_key is required' }],
    }))
    const { ctx, stderr } = makeCtx(
      ['init-node', '--display-name=N', '--base-url=https://n.example.org'],
      { setNodeIdentity, readFile: () => { throw new Error('ENOENT') } },
    )
    const code = await runInitNode(ctx)
    expect(code).toBe(1)
    expect(stderr.text()).toContain('npm run gen:node-key')
  })
})
