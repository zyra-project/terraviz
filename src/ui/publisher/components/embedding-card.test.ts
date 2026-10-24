// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The Embedding card: the live-policy analysis (pure), and the card's
 * behaviour — the posture radios, the list editor and its inline
 * errors, the body Save sends, server errors landing on the right row,
 * the read-only view, and the readout of what the node sends.
 */

import { describe, expect, it, vi } from 'vitest'
import { until } from '../../../test-utils'
import type { EmbedPolicy } from '../../../types/node-embedding'
import {
  analyzeLivePolicy,
  buildEmbeddingCard,
  embedPolicyFromSettings,
  frameAncestorsDirectives,
} from './embedding-card'

const ANY: EmbedPolicy = { mode: 'any', origins: [] }
const SELF: EmbedPolicy = { mode: 'self', origins: [] }
const LIST: EmbedPolicy = { mode: 'list', origins: ['https://www.example.org', 'https://example.org'] }

describe('frameAncestorsDirectives', () => {
  it('finds the directive in every policy of a joined value', () => {
    expect(
      frameAncestorsDirectives("default-src 'self'; frame-ancestors 'none', frame-ancestors 'self' https://A.org"),
    ).toEqual(["frame-ancestors 'none'", "frame-ancestors 'self' https://a.org"])
    expect(frameAncestorsDirectives(null)).toEqual([])
    expect(frameAncestorsDirectives("connect-src 'self'")).toEqual([])
  })
})

describe('analyzeLivePolicy', () => {
  it('all clear when the node sends exactly what the setting says', () => {
    expect(analyzeLivePolicy(ANY, { csp: null, xfo: null })).toEqual([{ kind: 'ok' }])
    expect(analyzeLivePolicy(SELF, { csp: "frame-ancestors 'self'", xfo: null })).toEqual([{ kind: 'ok' }])
    expect(
      analyzeLivePolicy(LIST, {
        csp: "connect-src 'self', frame-ancestors 'self' https://www.example.org https://example.org",
        xfo: null,
      }),
    ).toEqual([{ kind: 'ok' }])
  })

  it('all clear with file: in the list, compared as the token the middleware sends', () => {
    const policy: EmbedPolicy = { mode: 'list', origins: ['https://www.example.org', 'file:'] }
    expect(analyzeLivePolicy(policy, { csp: "frame-ancestors 'self' https://www.example.org file:", xfo: null })).toEqual([
      { kind: 'ok' },
    ])
  })

  it('flags X-Frame-Options under any, where nothing will override it', () => {
    expect(analyzeLivePolicy(ANY, { csp: null, xfo: 'SAMEORIGIN' })).toEqual([{ kind: 'xfo', value: 'SAMEORIGIN' }])
    // Just after a save to any, the old directive is still served and
    // browsers still ignore the header. Minutes from now they follow
    // it, so it is a warning now, after the "doesn't match yet".
    expect(analyzeLivePolicy(ANY, { csp: "frame-ancestors 'self'", xfo: 'SAMEORIGIN' }, SELF)).toEqual([
      { kind: 'pending' },
      { kind: 'xfo', value: 'SAMEORIGIN' },
    ])
  })

  it('notes the header for a restriction still on its way, since that restriction will override it', () => {
    expect(analyzeLivePolicy(LIST, { csp: null, xfo: 'SAMEORIGIN' })).toEqual([
      { kind: 'pending' },
      { kind: 'xfo-ignored', value: 'SAMEORIGIN' },
    ])
  })

  it('notes, rather than flags, an X-Frame-Options that a frame-ancestors overrides', () => {
    // What a node behind a shared Cloudflare zone sees on every check:
    // the setting matches, and the header is a footnote.
    const list = "frame-ancestors 'self' https://www.example.org https://example.org"
    expect(analyzeLivePolicy(LIST, { csp: list, xfo: 'SAMEORIGIN' })).toEqual([
      { kind: 'ok' },
      { kind: 'xfo-ignored', value: 'SAMEORIGIN' },
    ])
    expect(analyzeLivePolicy(SELF, { csp: "frame-ancestors 'self'", xfo: 'SAMEORIGIN' })).toEqual([
      { kind: 'ok' },
      { kind: 'xfo-ignored', value: 'SAMEORIGIN' },
    ])
    // Someone else's frame-ancestors overrides it too; that policy is
    // the problem, and the header stays a note after it.
    expect(analyzeLivePolicy(ANY, { csp: "frame-ancestors 'self'", xfo: 'DENY' })).toEqual([
      { kind: 'extra', value: "frame-ancestors 'self'" },
      { kind: 'xfo-ignored', value: 'DENY' },
    ])
  })

  it('flags a frame-ancestors the setting did not produce', () => {
    expect(analyzeLivePolicy(ANY, { csp: "frame-ancestors 'none'", xfo: null })).toEqual([
      { kind: 'extra', value: "frame-ancestors 'none'" },
    ])
    expect(
      analyzeLivePolicy(LIST, {
        csp: "frame-ancestors 'self' https://www.example.org https://example.org, frame-ancestors 'self'",
        xfo: null,
      }),
    ).toEqual([{ kind: 'extra', value: "frame-ancestors 'self'" }])
  })

  it("reports the directive a save to any just replaced as pending, not as someone else's", () => {
    expect(analyzeLivePolicy(ANY, { csp: "frame-ancestors 'self'", xfo: null }, SELF)).toEqual([{ kind: 'pending' }])
    // A different directive is still someone else's.
    expect(analyzeLivePolicy(ANY, { csp: "frame-ancestors 'none'", xfo: null }, SELF)).toEqual([
      { kind: 'extra', value: "frame-ancestors 'none'" },
    ])
  })

  it('says a save is still propagating when its own directive is missing', () => {
    expect(analyzeLivePolicy(SELF, { csp: null, xfo: null })).toEqual([{ kind: 'pending' }])
    // The old setting's directive is still live: one "pending", not an
    // extra policy as well.
    expect(analyzeLivePolicy(LIST, { csp: "frame-ancestors 'self'", xfo: null })).toEqual([{ kind: 'pending' }])
  })
})

describe('embedPolicyFromSettings', () => {
  it('hides the card for a response with no policy, an older deploy', () => {
    expect(embedPolicyFromSettings({ features: {} })).toBeNull()
    expect(embedPolicyFromSettings(null)).toBeNull()
  })

  it('reads a policy, and treats a malformed one as any', () => {
    expect(embedPolicyFromSettings({ embedding: LIST })).toEqual(LIST)
    expect(embedPolicyFromSettings({ embedding: { mode: 'sometimes' } })).toEqual(ANY)
    expect(embedPolicyFromSettings({ embedding: null })).toEqual(ANY)
    expect(embedPolicyFromSettings({ embedding: { mode: 'self', origins: ['https://x.org'] } })).toEqual(SELF)
  })
})

// ----- The card -----

interface Call {
  url: string
  method: string
  body: unknown
}

/** A fetch that answers `HEAD /` with `live`, and a node-settings PUT
 *  with `put` (200 echoing the body unless a 400 is given). */
function makeFetch(opts: {
  live?: { csp?: string; xfo?: string }
  put?: { status: number; body: unknown }
}) {
  const calls: Call[] = []
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method, body })
    if (method === 'HEAD') {
      const headers = new Headers()
      if (opts.live?.csp) headers.set('Content-Security-Policy', opts.live.csp)
      if (opts.live?.xfo) headers.set('X-Frame-Options', opts.live.xfo)
      return { ok: true, status: 200, type: 'basic', headers } as unknown as Response
    }
    const status = opts.put?.status ?? 200
    const payload = opts.put?.body ?? { features: {}, ...(body as object) }
    return {
      ok: status < 400,
      status,
      type: 'basic',
      redirected: false,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response
  })
  return { fetchFn: fetchFn as unknown as typeof fetch, calls }
}

function mount(policy: EmbedPolicy, opts: Parameters<typeof makeFetch>[0] & { canEdit?: boolean } = {}) {
  const { fetchFn, calls } = makeFetch(opts)
  const card = buildEmbeddingCard({ policy, canEdit: opts.canEdit ?? true, fetchFn })
  document.body.replaceChildren(card)
  const q = <T extends Element>(selector: string) => card.querySelector<T>(selector)
  const qa = <T extends Element>(selector: string) => Array.from(card.querySelectorAll<T>(selector))
  const radio = (mode: string) => q<HTMLInputElement>(`input[type="radio"][value="${mode}"]`)!
  const inputs = () => qa<HTMLInputElement>('.publisher-nodeprofile-embed-input')
  const save = () => qa<HTMLButtonElement>('button').find(b => b.textContent === 'Save embedding')
  const puts = () => calls.filter(c => c.method === 'PUT')
  return { card, calls, q, qa, radio, inputs, save, puts }
}

function choose(radio: HTMLInputElement): void {
  radio.checked = true
  radio.dispatchEvent(new Event('change'))
}

describe('buildEmbeddingCard', () => {
  it('offers the three postures as labelled radios in a fieldset, checked from the policy', () => {
    const { q, qa, radio } = mount(ANY)
    expect(q('fieldset legend')?.textContent).toBe('Who can embed this node')
    expect(qa('input[type="radio"]')).toHaveLength(3)
    expect(radio('any').checked).toBe(true)
    for (const mode of ['any', 'list', 'self']) {
      const r = radio(mode)
      // The label carries the name only; the description is tied once,
      // by aria-describedby, not read again inside the name.
      const label = document.querySelector<HTMLLabelElement>(`label[for="${r.id}"]`)!
      const desc = document.getElementById(r.getAttribute('aria-describedby')!)!
      expect(desc.textContent!.length).toBeGreaterThan(0)
      expect(label.contains(desc)).toBe(false)
      expect(label.textContent).not.toContain(desc.textContent)
    }
  })

  it('shows the list only for "Only sites I list", with one empty row to start', () => {
    const { q, radio, inputs } = mount(ANY)
    const block = q<HTMLElement>('.publisher-nodeprofile-embed-origins')!
    expect(block.hidden).toBe(true)
    choose(radio('list'))
    expect(block.hidden).toBe(false)
    expect(inputs()).toHaveLength(1)
    expect(inputs()[0].getAttribute('aria-label')).toBe('Site 1')
  })

  it('pre-fills the list, and Save sends it trimmed with empty rows skipped', async () => {
    const view = mount(LIST)
    expect(view.inputs().map(i => i.value)).toEqual(LIST.origins)
    view.q<HTMLButtonElement>('.publisher-nodeprofile-embed-origins .publisher-button')!.click()
    view.inputs()[2].value = '  https://news.example.org  '
    view.q<HTMLButtonElement>('.publisher-nodeprofile-embed-origins .publisher-button')!.click()
    view.save()!.click()
    await until(() => view.puts().length === 1, 'the PUT')
    expect(view.puts()[0].url).toContain('/api/v1/publish/node-settings')
    expect(view.puts()[0].body).toEqual({
      embedding: {
        mode: 'list',
        origins: ['https://www.example.org', 'https://example.org', 'https://news.example.org'],
      },
    })
    await until(() => view.q('[role="status"]')?.textContent !== '', 'the saved message')
    expect(view.q('.publisher-nodeprofile-actions [role="status"]')?.textContent).toMatch(/saved/i)
  })

  it('sends no origins for "No other site", even with rows still filled in', async () => {
    const view = mount(LIST)
    choose(view.radio('self'))
    view.save()!.click()
    await until(() => view.puts().length === 1, 'the PUT')
    expect(view.puts()[0].body).toEqual({ embedding: { mode: 'self', origins: [] } })
  })

  it('marks a bad site inline, focuses it, and sends nothing', () => {
    const view = mount(LIST)
    view.inputs()[1].value = 'http://example.org/embed'
    view.save()!.click()
    const bad = view.inputs()[1]
    expect(bad.getAttribute('aria-invalid')).toBe('true')
    const errorId = bad.getAttribute('aria-describedby')!.split(' ')[0]
    const error = document.getElementById(errorId)!
    expect(error.hidden).toBe(false)
    expect(error.textContent).toBe('A site must start with \u2068https://\u2069.')
    expect(document.activeElement).toBe(bad)
    expect(view.puts()).toHaveLength(0)
    // Typing clears the error.
    bad.value = 'https://example.net'
    bad.dispatchEvent(new Event('input'))
    expect(bad.hasAttribute('aria-invalid')).toBe(false)
    expect(error.hidden).toBe(true)
  })

  it('isolates every literal token that ends in punctuation, so an RTL sentence cannot move it', () => {
    const view = mount(LIST)
    const group = view.q<HTMLElement>('.publisher-nodeprofile-embed-list')!
    expect(document.getElementById(group.getAttribute('aria-describedby')!)!.textContent).toMatch(
      /^One site per row: \u2068https:\/\/\u2069 and the host name/,
    )
    const errorFor = (raw: string): string => {
      view.inputs()[1].value = raw
      view.save()!.click()
      return document.getElementById(view.inputs()[1].getAttribute('aria-describedby')!.split(' ')[0])!.textContent!
    }
    expect(errorFor('https://example.org/embed')).toBe(
      'Enter only \u2068https://\u2069 and the host, with no path or trailing slash.',
    )
    expect(errorFor('https://bücher.example')).toBe(
      'Enter the punycode form (starting \u2068xn--\u2069) of an international domain name.',
    )
  })

  it('refuses a duplicate by naming the row it repeats', () => {
    const view = mount(LIST)
    view.inputs()[1].value = 'https://WWW.example.org'
    view.save()!.click()
    expect(view.inputs()[1].getAttribute('aria-invalid')).toBe('true')
    const error = document.getElementById(view.inputs()[1].getAttribute('aria-describedby')!.split(' ')[0])!
    // It quotes the site, which stays right if rows above are removed.
    expect(error.textContent).toBe('This repeats \u2068https://www.example.org\u2069, listed above.')
    expect(view.puts()).toHaveLength(0)
  })

  it('needs at least one site for the list posture', () => {
    const view = mount(ANY)
    choose(view.radio('list'))
    view.save()!.click()
    expect(view.q('.publisher-nodeprofile-actions [role="status"]')?.textContent).toBe(
      'List at least one site, or choose "No other site".',
    )
    expect(view.puts()).toHaveLength(0)
  })

  it('puts a server field error on the row that sent that entry', async () => {
    const view = mount(
      { mode: 'list', origins: ['https://a.example.org', 'https://b.example.org'] },
      {
        put: {
          status: 400,
          body: { errors: [{ field: 'embedding.origins[1]', code: 'bad_host', message: 'Bad host.' }] },
        },
      },
    )
    // An empty row between the two: the server's index 1 is the third row.
    view.q<HTMLButtonElement>('.publisher-nodeprofile-embed-origins .publisher-button')!.click()
    const rows = view.inputs()
    const third = rows[2]
    third.value = rows[1].value
    rows[1].value = ''
    view.save()!.click()
    await until(() => third.getAttribute('aria-invalid') === 'true', 'the server error on the row')
    expect(rows[1].hasAttribute('aria-invalid')).toBe(false)
    const error = document.getElementById(third.getAttribute('aria-describedby')!.split(' ')[0])!
    expect(error.textContent).toBe('Enter a valid host name, such as www.example.org.')
  })

  it('removing a row renumbers the rest and keeps focus in the list', () => {
    const view = mount({ mode: 'list', origins: ['https://a.example.org', 'https://b.example.org', 'https://c.example.org'] })
    view.qa<HTMLButtonElement>('.publisher-nodeprofile-embed-remove')[0].click()
    expect(view.inputs().map(i => i.getAttribute('aria-label'))).toEqual(['Site 1', 'Site 2'])
    expect(view.qa('.publisher-nodeprofile-embed-remove').map(b => b.getAttribute('aria-label'))).toEqual([
      'Remove site 1',
      'Remove site 2',
    ])
    expect(document.activeElement).toBe(view.inputs()[0])
  })

  it('read-only for a caller who is not an admin: the setting as text, said to be read-only first', () => {
    const view = mount(LIST, { canEdit: false })
    // No disabled radios for Tab to skip: the posture is text.
    expect(view.qa('input[type="radio"]')).toHaveLength(0)
    expect(view.q('.publisher-nodeprofile-embed-modes .publisher-nodeprofile-feature-name')?.textContent).toBe(
      'Only sites I list',
    )
    expect(view.save()).toBeUndefined()
    expect(view.inputs()).toHaveLength(0)
    expect(view.qa('.publisher-nodeprofile-embed-readonly li').map(li => li.textContent)).toEqual(LIST.origins)
    expect(view.qa('.publisher-nodeprofile-embed-readonly li').every(li => li.getAttribute('dir') === 'ltr')).toBe(true)
    expect(view.q('.publisher-nodeprofile-embed-origins')?.hasAttribute('hidden')).toBe(false)
    // The read-only note comes before the setting it explains.
    const note = view.qa('p').find(p => p.textContent === 'Only an admin can change who may embed this node.')!
    const modes = view.q('.publisher-nodeprofile-embed-modes')!
    expect(note.compareDocumentPosition(modes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('numbers each row visibly, as its name reads, and keeps URLs left-to-right', () => {
    const view = mount({ mode: 'list', origins: ['https://a.example.org', 'https://b.example.org'] })
    expect(view.qa('.publisher-nodeprofile-embed-num').map(n => n.textContent)).toEqual(['1.', '2.'])
    expect(view.inputs().every(input => input.getAttribute('dir') === 'ltr')).toBe(true)
    view.qa<HTMLButtonElement>('.publisher-nodeprofile-embed-remove')[0].click()
    expect(view.qa('.publisher-nodeprofile-embed-num').map(n => n.textContent)).toEqual(['1.'])
  })

  it('keeps focus on Save while the request runs, marking it busy rather than disabled', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const { fetchFn } = makeFetch({ live: {} })
    const slow = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') await gate
      return fetchFn(input, init)
    }) as unknown as typeof fetch
    const card = buildEmbeddingCard({ policy: SELF, canEdit: true, fetchFn: slow })
    document.body.replaceChildren(card)
    const save = Array.from(card.querySelectorAll('button')).find(b => b.textContent === 'Save embedding')!
    save.focus()
    save.click()
    expect(save.disabled).toBe(false)
    expect(save.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(save)
    // A second press while busy sends nothing more.
    save.click()
    release()
    await until(() => !save.hasAttribute('aria-disabled'), 'the save to finish')
    expect((slow as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(c => c[1]?.method === 'PUT')).toHaveLength(1)
    expect(document.activeElement).toBe(save)
  })

  it('ties "list at least one site" to the first field, so moving there reads it', () => {
    const view = mount(ANY)
    choose(view.radio('list'))
    view.save()!.click()
    const first = view.inputs()[0]
    expect(first.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(first.getAttribute('aria-describedby')!)?.textContent).toBe(
      'List at least one site, or choose "No other site".',
    )
    expect(document.activeElement).toBe(first)
  })

  it('accepts file:, explaining it in a disclosure rather than in the list description', async () => {
    const view = mount(LIST)
    // The group still carries only the general hint, which a screen
    // reader repeats after every failed Save.
    const group = view.q<HTMLElement>('.publisher-nodeprofile-embed-list')!
    const described = group.getAttribute('aria-describedby')!.split(' ')
    expect(described).toHaveLength(1)
    expect(document.getElementById(described[0])!.textContent).toMatch(/^One site per row/)
    // The disclosure says how, with the colon spelled out, and what it admits.
    const help = view.q<HTMLDetailsElement>('details.publisher-nodeprofile-embed-file')!
    expect(help.open).toBe(false)
    expect(help.querySelector('summary')!.textContent).toBe('Allow a page opened from a file')
    expect(Array.from(help.querySelectorAll('p'), p => p.textContent)).toEqual([
      'A page opened from a file has an address starting \u2068file://\u2069 and no site to list. ' +
        'To allow one, add a row with only \u2068file:\u2069 in it. ' +
        'That is the word file followed by a colon, not \u2068file://\u2069 or a path.',
      'Any page opened from a file can then embed this node, not only yours. ' +
        'Chrome, Edge and other Chromium browsers allow this. Test any other browser before you rely on it.',
    ])
    view.inputs()[1].value = 'file:'
    view.save()!.click()
    await until(() => view.puts().length === 1, 'the PUT')
    expect(view.puts()[0].body).toEqual({ embedding: { mode: 'list', origins: ['https://www.example.org', 'file:'] } })
  })

  it.each([['file:///Users/me/embed.html'], ['file://'], ['file'], ['/Users/me/embed.html']])(
    'points %j at file:, rather than at https://, and says what it admits',
    raw => {
      const view = mount(LIST)
      view.inputs()[1].value = raw
      view.save()!.click()
      const error = document.getElementById(view.inputs()[1].getAttribute('aria-describedby')!.split(' ')[0])!
      expect(error.textContent).toBe(
        'Enter only \u2068file:\u2069, the word file followed by a colon, to allow pages opened from a file. ' +
          'That allows every such page, not only yours.',
      )
      expect(view.puts()).toHaveLength(0)
    },
  )

  it('read-only: says what a listed file: admits, since it is not a site', () => {
    const plain = mount(LIST, { canEdit: false })
    expect(plain.q('details.publisher-nodeprofile-embed-file')).toBeNull()
    expect(plain.qa('p').some(p => p.textContent?.includes('page opened from a file'))).toBe(false)

    const view = mount({ mode: 'list', origins: ['https://www.example.org', 'file:'] }, { canEdit: false })
    expect(view.qa('.publisher-nodeprofile-embed-readonly li').map(li => li.textContent)).toEqual([
      'https://www.example.org',
      'file:',
    ])
    const note = view.qa('p').find(p => p.textContent === '\u2068file:\u2069 in this list lets any page opened from a file embed this node.')
    expect(note).toBeDefined()
    expect(view.q('.publisher-nodeprofile-embed-readonly')!.compareDocumentPosition(note!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('refuses a wildcard over shared hosting in the portal\'s words', () => {
    const view = mount(LIST)
    view.inputs()[1].value = 'https://*.wordpress.com'
    view.save()!.click()
    const error = document.getElementById(view.inputs()[1].getAttribute('aria-describedby')!)!
    expect(error.textContent).toBe(
      'This wildcard covers sites anyone can create on that service. List your own sites one by one instead.',
    )
  })

  it('says first when the enforced policy is not what was saved, and drops it after a good save', async () => {
    const { fetchFn, calls } = makeFetch({ live: {} })
    const card = buildEmbeddingCard({ policy: SELF, problem: 'refused', canEdit: true, fetchFn })
    document.body.replaceChildren(card)
    const problem = card.querySelector('.publisher-nodeprofile-embed-problem')!
    expect(problem.textContent).toMatch(/no longer accepted/)
    expect(card.querySelector('h2')!.nextElementSibling!.nextElementSibling).toBe(problem)
    Array.from(card.querySelectorAll('button')).find(b => b.textContent === 'Save embedding')!.click()
    await until(() => calls.some(c => c.method === 'PUT'), 'the save')
    await until(() => card.querySelector('.publisher-nodeprofile-embed-problem') === null, 'the warning to go')
  })
})

describe('buildEmbeddingCard: what this node sends now', () => {
  it('reads HEAD / on render and shows the two headers, quietly', async () => {
    const view = mount(SELF, { live: { csp: "frame-ancestors 'self'" } })
    await until(() => view.qa('.publisher-nodeprofile-embed-live-values dd').length === 2, 'the readout')
    const head = view.calls.find(c => c.method === 'HEAD')!
    expect(head.url).toBe('/')
    const values = view.qa('.publisher-nodeprofile-embed-live-values dd').map(dd => dd.textContent)
    expect(values).toEqual(["frame-ancestors 'self'", '(not sent)'])
    expect(view.q('.publisher-nodeprofile-embed-finding')?.textContent).toBe('This matches the saved setting.')
    // Not announced: nobody asked.
    expect(view.q('.publisher-nodeprofile-embed-live [role="status"]')?.textContent).toBe('')
  })

  it('announces through a visually hidden region, since the verdict is already on screen', () => {
    const view = mount(SELF, { live: {} })
    expect(view.q('.publisher-nodeprofile-embed-live [role="status"]')?.classList.contains('sr-only')).toBe(true)
  })

  it('shows header values left-to-right, and "not sent" as prose rather than code', async () => {
    const view = mount(SELF, { live: { csp: "frame-ancestors 'self'" } })
    await until(() => view.qa('.publisher-nodeprofile-embed-live-values dd').length === 2, 'the readout')
    const [csp, xfo] = view.qa('.publisher-nodeprofile-embed-live-values dd')
    expect(csp.querySelector('code')?.getAttribute('dir')).toBe('ltr')
    expect(xfo.querySelector('code')).toBeNull()
  })

  it('warns about X-Frame-Options, and announces a check the user asked for', async () => {
    const view = mount(ANY, { live: { xfo: 'SAMEORIGIN' } })
    await until(() => view.qa('.publisher-nodeprofile-embed-finding-warn').length === 1, 'the warning')
    // The header value is isolated, so it keeps its order in a
    // right-to-left sentence.
    expect(view.q('.publisher-nodeprofile-embed-finding-warn')?.textContent).toContain(
      'X-Frame-Options: \u2068SAMEORIGIN\u2069',
    )
    view.qa<HTMLButtonElement>('button').find(b => b.textContent === 'Check again')!.click()
    const liveStatus = view.q('.publisher-nodeprofile-embed-live [role="status"]')!
    await until(() => (liveStatus.textContent ?? '').includes('SAMEORIGIN'), 'the announced verdict')
  })

  it('shows an overridden X-Frame-Options as a note under the all-clear, not as a warning', async () => {
    const view = mount(LIST, {
      live: { csp: "frame-ancestors 'self' https://www.example.org https://example.org", xfo: 'SAMEORIGIN' },
    })
    await until(() => view.qa('.publisher-nodeprofile-embed-finding').length === 2, 'the readout')
    const findings = view.qa('.publisher-nodeprofile-embed-finding')
    expect(findings[0].textContent).toBe('This matches the saved setting.')
    expect(findings[1].textContent).toContain('X-Frame-Options: ⁨SAMEORIGIN⁩')
    expect(findings[1].textContent).toContain('Current browsers ignore this node')
    expect(view.qa('.publisher-nodeprofile-embed-finding-warn')).toHaveLength(0)
    // A check the user asks for announces both, the verdict first.
    view.qa<HTMLButtonElement>('button').find(b => b.textContent === 'Check again')!.click()
    const liveStatus = view.q('.publisher-nodeprofile-embed-live [role="status"]')!
    await until(() => (liveStatus.textContent ?? '').includes('Current browsers ignore this node'), 'the announced verdict')
    expect(liveStatus.textContent).toMatch(/^This matches the saved setting\. /)
  })

  it('compares against the newly saved policy after a save', async () => {
    const view = mount(ANY, { live: {} })
    await until(() => view.qa('.publisher-nodeprofile-embed-finding').length === 1, 'the first readout')
    choose(view.radio('self'))
    view.save()!.click()
    await until(() => view.puts().length === 1, 'the PUT')
    await until(
      () => (view.q('.publisher-nodeprofile-actions [role="status"]')?.textContent ?? '').length > 0,
      'the save outcome',
    )
    view.qa<HTMLButtonElement>('button').find(b => b.textContent === 'Check again')!.click()
    await until(
      () => (view.q('.publisher-nodeprofile-embed-live [role="status"]')?.textContent ?? '').includes("doesn't match"),
      'the pending verdict',
    )
  })

  it('says so when the check itself fails', async () => {
    const card = buildEmbeddingCard({
      policy: ANY,
      canEdit: true,
      fetchFn: vi.fn(async () => {
        throw new TypeError('offline')
      }) as unknown as typeof fetch,
    })
    document.body.replaceChildren(card)
    await until(() => card.querySelector('.publisher-nodeprofile-embed-finding-warn') !== null, 'the error')
    expect(card.querySelector('.publisher-nodeprofile-embed-finding-warn')?.textContent).toBe(
      "Couldn't check what this node sends.",
    )
  })

  it('treats an error status as a failed check, not as a page with no framing headers', async () => {
    // A 503 error page sends neither header, which under "any" would
    // otherwise read as "This matches the saved setting."
    for (const status of [403, 503]) {
      const card = buildEmbeddingCard({
        policy: ANY,
        canEdit: true,
        fetchFn: vi.fn(
          async () => ({ ok: false, status, type: 'basic', headers: new Headers() }) as unknown as Response,
        ) as unknown as typeof fetch,
      })
      document.body.replaceChildren(card)
      await until(() => card.querySelector('.publisher-nodeprofile-embed-finding') !== null, `the readout for ${status}`)
      const findings = [...card.querySelectorAll('.publisher-nodeprofile-embed-finding')].map(li => li.textContent)
      expect(findings).toEqual(["Couldn't check what this node sends."])
      expect(card.querySelectorAll('.publisher-nodeprofile-embed-live-values dd')).toHaveLength(0)
    }
  })
})
