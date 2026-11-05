// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isPublisherPortalPath } from '../src/utils/publisherPath'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * `public/_headers` is the only thing that keeps the publisher portal
 * from being framed by another site.
 *
 * `_redirects` sends every path to `index.html`, so the public app,
 * its `?embed=1` view and `/publish` are one document. Whatever a node
 * decides about embedding the public app, the portal is an admin
 * surface and must refuse to be framed by anyone but itself. Cloudflare
 * Access gates it, but clickjacking protection should not rest on that.
 *
 * Pages applies every rule whose pattern matches and joins a repeated
 * header with a comma. That makes two edits silently dangerous: a
 * second `X-Frame-Options` value (a conflicting pair blocks framing
 * outright, even same-origin), and a widened `frame-ancestors` on the
 * portal rule itself. The parser below follows Pages' own (shipped in
 * wrangler as `parseHeaders`, and applied by the asset server's
 * `attachHeaders`), so the assertions are about what a browser
 * receives. Three of its rules are easy to get wrong, and each let an
 * unsafe edit pass an earlier version of this test:
 *
 * - a line is a pattern because of what it starts with (`/` or a
 *   scheme), not because it is unindented, so a header written at
 *   column 0 still belongs to the pattern above it;
 * - a repeated pattern replaces the earlier block outright, so a
 *   second `/publish/*` block would silently drop the portal's
 *   headers. This test refuses repeats rather than allowing them;
 * - a block's `! Name` lines apply before its headers, whatever
 *   order they are written in.
 *
 * Which paths are "the portal" is not written down here: it is
 * `isPublisherPortalPath`, the predicate `src/main.ts` boots the portal
 * on. The corpus is a spread of path shapes, and each one the gate
 * accepts must be one the rules protect. A hand-kept list let the gate
 * accept `/publisher` while the test called it a public path.
 */

interface HeaderRule {
  pattern: string
  /** Lowercased name → value. A name repeated inside one block is
   *  joined with ", ", as Pages does. */
  set: Map<string, string>
  /** `! Name` lines, lowercased. Applied before `set`. */
  unset: string[]
}

interface ParsedHeaders {
  rules: HeaderRule[]
  /** Lines Pages would warn about and ignore. Any of these in the
   *  real file is a mistake, so the test fails on them. */
  problems: string[]
}

/** Pages' test for "this line starts a new rule". */
const LINE_IS_A_PATTERN = /^([^\s]+:\/\/|\/)/

/** Parse `_headers` the way Pages does. Whitespace around a line is
 *  ignored, `#` starts a comment, a line starting with `/` or a scheme
 *  opens a rule, `Name: value` and `! Name` lines belong to it. */
function parseHeadersFile(text: string): ParsedHeaders {
  const rules: HeaderRule[] = []
  const problems: string[] = []
  let rule: HeaderRule | null = null
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim()
    const where = `line ${index + 1}`
    if (line === '' || line.startsWith('#')) return
    if (LINE_IS_A_PATTERN.test(line)) {
      rule = { pattern: line, set: new Map(), unset: [] }
      rules.push(rule)
      return
    }
    if (!rule) {
      problems.push(`${where}: a header before any pattern`)
      return
    }
    const colon = line.indexOf(':')
    if (colon < 0) {
      if (line.startsWith('!')) rule.unset.push(line.slice(1).trim().toLowerCase())
      else problems.push(`${where}: neither "Name: value" nor "! Name"`)
      return
    }
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (name === '' || name.includes(' ') || value === '') {
      problems.push(`${where}: not a valid "Name: value" pair`)
      return
    }
    const existing = rule.set.get(name)
    rule.set.set(name, existing ? `${existing}, ${value}` : value)
  })
  const seen = new Set<string>()
  for (const { pattern, set, unset } of rules) {
    if (set.size === 0 && unset.length === 0) problems.push(`${pattern}: a pattern with no headers`)
    if (seen.has(pattern)) problems.push(`${pattern}: repeated, so it replaces the earlier block`)
    seen.add(pattern)
  }
  return { rules, problems }
}

/** Pages' pattern grammar: `*` is a greedy splat, `:name` one segment.
 *  A pattern naming a host (`https://:project.pages.dev/*`) is treated
 *  as matching every host, so a rule scoped to the preview hostname is
 *  still checked: the portal there is the same portal. */
function matches(pattern: string, path: string): boolean {
  const hostScoped = /^https?:\/\/[^/]+(\/.*)$/.exec(pattern)
  if (hostScoped) pattern = hostScoped[1]
  if (!pattern.startsWith('/')) return false
  const source = pattern
    .split(/(\*|:[A-Za-z]\w*)/)
    .map(part => {
      if (part === '*') return '.*'
      if (part.startsWith(':')) return '[^/]+'
      return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
  return new RegExp(`^${source}$`).test(path)
}

/** Every value each header receives on `path`, in the order Pages
 *  attaches them. A repeated pattern keeps its first position and its
 *  last block, as a keyed object does in Pages. */
function headersFor(parsed: ParsedHeaders, path: string): Map<string, string[]> {
  const effective = new Map<string, HeaderRule>()
  for (const rule of parsed.rules) effective.set(rule.pattern, rule)
  const out = new Map<string, string[]>()
  for (const rule of effective.values()) {
    if (!matches(rule.pattern, path)) continue
    for (const name of rule.unset) out.delete(name)
    for (const [name, value] of rule.set) out.set(name, [...(out.get(name) ?? []), value])
  }
  return out
}

/** The `frame-ancestors` source list each CSP policy enforces. A
 *  comma separates policies, both inside one value and between the
 *  values Pages joins. Within one policy a browser uses the **first**
 *  `frame-ancestors` and ignores any repeat, so only the first is
 *  read: `frame-ancestors *; frame-ancestors 'self'` allows every
 *  site, and must not count as limited. */
function frameAncestorsLists(cspValues: string[]): string[][] {
  const lists: string[][] = []
  for (const policy of cspValues.join(',').split(',')) {
    for (const directive of policy.split(';')) {
      const [name, ...sources] = directive.trim().split(/\s+/)
      if (name?.toLowerCase() === 'frame-ancestors') {
        lists.push(sources)
        break
      }
    }
  }
  return lists
}

const rules = parseHeadersFile(readFileSync(resolve(REPO_ROOT, 'public/_headers'), 'utf8'))

describe('public/_headers parses cleanly', () => {
  it('has no line Pages would ignore, and no repeated pattern', () => {
    expect(rules.problems).toEqual([])
  })
})

/** Path shapes worth asking the gate about: real portal routes,
 *  near-misses that share the prefix, and the ordinary public routes. */
const PATH_CORPUS = [
  '/publish',
  '/publish/',
  '/publish//x',
  '/publish/overview',
  '/publish/users',
  '/publish/datasets/01HXYZ/edit',
  '/publish/node-profile',
  '/publisher',
  '/publishing',
  '/publish.',
  '/publish-x',
  '/publish;x',
  '/publish%20',
  '/publish%2Fusers',
  '/Publish',
  '/%70ublish',
  '//publish',
  '/',
  '/dataset/sea-surface-temperature',
  '/blog',
  '/orbit',
]

const PORTAL_PATHS = PATH_CORPUS.filter(isPublisherPortalPath)
const PUBLIC_PATHS = PATH_CORPUS.filter(path => !isPublisherPortalPath(path))

describe('the portal gate', () => {
  it('is the predicate src/main.ts boots the portal on', () => {
    // The tests below hold the predicate to _headers. That only
    // protects anything while the boot gate is that predicate, so a
    // return to a hand-written prefix test fails here.
    const main = readFileSync(resolve(REPO_ROOT, 'src/main.ts'), 'utf8')
    expect(main).toMatch(/if \(isPublisherPortalPath\(location\.pathname\)\)/)
    expect(main).not.toMatch(/pathname\.startsWith\(\s*['"`]\/publish/)
  })

  it('accepts the portal and nothing that merely shares its prefix', () => {
    expect(PORTAL_PATHS).toEqual(expect.arrayContaining(['/publish', '/publish/', '/publish/users']))
    expect(PUBLIC_PATHS).toEqual(
      expect.arrayContaining(['/publisher', '/publishing', '/publish-x', '/publish%2Fusers', '/']),
    )
  })
})

describe('public/_headers: the publisher portal refuses to be framed', () => {
  it.each(PORTAL_PATHS)('%s carries frame-ancestors limited to the node itself', path => {
    const csp = headersFor(rules, path).get('content-security-policy') ?? []
    // Every policy is enforced, so one policy limited to 'self' (or
    // 'none') is what blocks other sites; a second, broader one cannot
    // widen it. Loosening the portal rule in place leaves no such
    // policy, and fails here.
    const limited = frameAncestorsLists(csp).filter(
      sources =>
        sources.length > 0 && sources.every(source => ["'self'", "'none'"].includes(source.toLowerCase())),
    )
    expect(limited.length).toBeGreaterThan(0)
  })

  it.each(PORTAL_PATHS)('%s carries exactly one X-Frame-Options value', path => {
    const xfo = headersFor(rules, path).get('x-frame-options') ?? []
    // Joined values are one header to the browser; a conflicting pair
    // blocks framing entirely, so the set must hold one value.
    const values = new Set(xfo.join(',').split(',').map(v => v.trim().toLowerCase()))
    expect([...values]).toEqual(['sameorigin'])
  })

  it('the portal rules leave the ordinary security headers in place', () => {
    const headers = headersFor(rules, '/publish/datasets')
    expect(headers.get('x-content-type-options')).toEqual(['nosniff'])
    expect(headers.get('referrer-policy')).toEqual(['strict-origin-when-cross-origin'])
  })
})

describe('public/_headers: what public/_routes.json keeps from the middleware is locked statically', () => {
  // The middleware enforces the node's embedding setting, but only on
  // requests that reach Functions. A directory `_routes.json` excludes
  // still answers a missing file with the app's index.html, and the app
  // boots from any path, so each one needs its own static lock.
  const routes = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/_routes.json'), 'utf8')) as {
    exclude: string[]
  }
  const directories = routes.exclude.filter(rule => rule.endsWith('/*'))

  it('finds the excluded directories', () => {
    expect(directories).toEqual(expect.arrayContaining(['/assets/*', '/publish/*']))
  })

  it.each(directories)('%s falls back to a locked page', rule => {
    const path = `${rule.slice(0, -1)}no-such-file?embed=1`.split('?')[0]
    const headers = headersFor(rules, path)
    const limited = frameAncestorsLists(headers.get('content-security-policy') ?? []).filter(
      sources => sources.length > 0 && sources.every(source => ["'self'", "'none'"].includes(source.toLowerCase())),
    )
    expect(limited.length).toBeGreaterThan(0)
    const xfo = new Set((headers.get('x-frame-options') ?? []).join(',').split(',').map(v => v.trim().toLowerCase()))
    expect([...xfo]).toEqual(['sameorigin'])
  })
})

describe('public/_headers: the public app stays embeddable by default', () => {
  // The default posture (docs/WORDPRESS_INTEGRATION_PLAN.md §4): any
  // site may embed the app. A static framing rule here would override
  // that for every node, whatever its operator chose.
  it.each(PUBLIC_PATHS)(
    '%s gets no framing restriction from _headers',
    path => {
      const headers = headersFor(rules, path)
      expect(headers.get('x-frame-options')).toBeUndefined()
      expect(frameAncestorsLists(headers.get('content-security-policy') ?? [])).toEqual([])
    },
  )
})

describe('public/_headers: the microphone is the app\'s own, and nothing else is', () => {
  // Orbit's voice input needs the microphone. Until November 2026 this
  // was `microphone=()`, under which Chromium refuses getUserMedia
  // without a prompt, so on every node that kept this file the Cloud
  // engine and every hands-free mode failed in Chrome and Edge.
  // `(self)` is the narrowest value that lets voice work, in Chromium:
  // the app's own documents may ask, a cross-origin frame inside the app
  // (a tour's video embed) may not, and a site embedding the app gets
  // nothing unless it also delegates with `allow="microphone"`. Firefox
  // does not implement the header and Safari only partly, so there the
  // boundary is that the app never delegates the microphone to a frame.
  //
  // `microphone=()` is allowed too: SELF_HOSTING §14.5 offers it to an
  // operator who wants voice off. What must not happen is a wider value,
  // a second value, or a path left without one.
  it('is set by the catch-all rule alone, so no narrower rule can widen or drop it', () => {
    const touching = rules.rules
      .filter(rule => rule.set.has('permissions-policy') || rule.unset.includes('permissions-policy'))
      .map(rule => rule.pattern)
    expect(touching).toEqual(['/*'])
  })

  // The corpus, plus a path under every rule, so each block is exercised.
  const samples = [...new Set([...PATH_CORPUS, ...rules.rules.map(rule => rule.pattern.replace(/\*$/, 'x'))])]

  it.each(samples)('%s gets one well-formed policy, with the microphone at most the app\'s own', path => {
    const values = headersFor(rules, path).get('permissions-policy') ?? []
    expect(values).toHaveLength(1)
    const members = values[0].split(',').map(member => member.trim())
    // A browser drops the whole header over one malformed member, camera
    // and location included, so every member must be a plain allowlist.
    for (const member of members) expect(member).toMatch(/^[a-z][a-z0-9-]*=\((?:self)?\)$/)
    const policy = new Map(members.map(member => member.split('=') as [string, string]))
    // A repeated key is not an error to a browser: the last one wins.
    expect(policy.size).toBe(members.length)
    expect(policy.get('camera')).toBe('()')
    expect(policy.get('geolocation')).toBe('()')
    expect(['()', '(self)']).toContain(policy.get('microphone'))
  })
})

describe('reading frame-ancestors the way a browser does', () => {
  it('takes the first directive in a policy and ignores a repeat', () => {
    // Permissive first, restrictive second: the browser allows anyone.
    expect(frameAncestorsLists(["frame-ancestors *; frame-ancestors 'self'"])).toEqual([['*']])
    expect(frameAncestorsLists(["frame-ancestors 'self'; frame-ancestors *"])).toEqual([["'self'"]])
  })

  it('reads one list per policy, whether policies arrive joined or apart', () => {
    expect(frameAncestorsLists(["frame-ancestors *, frame-ancestors 'self'"])).toEqual([['*'], ["'self'"]])
    expect(frameAncestorsLists(['frame-ancestors *', "frame-ancestors 'self'"])).toEqual([['*'], ["'self'"]])
    expect(frameAncestorsLists(["connect-src 'self'"])).toEqual([])
  })

  it('would fail the portal check on a permissive-first duplicate', () => {
    const parsed = parseHeadersFile("/publish\n  Content-Security-Policy: frame-ancestors *; frame-ancestors 'self'\n")
    const lists = frameAncestorsLists(headersFor(parsed, '/publish').get('content-security-policy') ?? [])
    const limited = lists.filter(
      sources => sources.length > 0 && sources.every(source => ["'self'", "'none'"].includes(source.toLowerCase())),
    )
    expect(limited).toEqual([])
  })
})

describe('the _headers parser', () => {
  it('matches Pages patterns the way Pages does', () => {
    expect(matches('/*', '/anything/at/all')).toBe(true)
    expect(matches('/publish/*', '/publish/x')).toBe(true)
    expect(matches('/publish/*', '/publish')).toBe(false)
    expect(matches('/publish', '/publisher')).toBe(false)
    expect(matches('/a/:id/b', '/a/1/b')).toBe(true)
    expect(matches('/a/:id/b', '/a/1/2/b')).toBe(false)
    expect(matches('https://example.org/*', '/x')).toBe(true)
    expect(matches('https://example.org/a', '/x')).toBe(false)
  })

  it('applies a detach line to the headers set before it', () => {
    const parsed = parseHeadersFile('/*\n  X-A: one\n/p/*\n  ! X-A\n  X-B: two\n')
    expect(headersFor(parsed, '/p/q').get('x-a')).toBeUndefined()
    expect(headersFor(parsed, '/p/q').get('x-b')).toEqual(['two'])
  })

  it("applies a block's detach lines before its headers, in any written order", () => {
    const parsed = parseHeadersFile('/*\n  X-A: one\n/p/*\n  X-A: two\n  ! X-A\n')
    expect(headersFor(parsed, '/p/q').get('x-a')).toEqual(['two'])
  })

  it('reads a header at column 0 as a header, not a pattern', () => {
    const parsed = parseHeadersFile('/*\nX-Frame-Options: DENY\n')
    expect(parsed.problems).toEqual([])
    expect(headersFor(parsed, '/anything').get('x-frame-options')).toEqual(['DENY'])
  })

  it('lets a repeated pattern replace the earlier block, and reports it', () => {
    const parsed = parseHeadersFile('/p/*\n  X-A: one\n/q\n  X-B: two\n/p/*\n  X-C: three\n')
    expect(headersFor(parsed, '/p/x').get('x-a')).toBeUndefined()
    expect(headersFor(parsed, '/p/x').get('x-c')).toEqual(['three'])
    expect(parsed.problems).toEqual(['/p/*: repeated, so it replaces the earlier block'])
  })

  it('reports lines Pages would ignore', () => {
    expect(parseHeadersFile('X-A: one\n').problems).toHaveLength(1)
    expect(parseHeadersFile('/p\n  nonsense\n').problems).toHaveLength(2)
    expect(parseHeadersFile('/p\n  X-A:\n').problems).toHaveLength(2)
  })

  it('checks a rule scoped to a host against the path', () => {
    const parsed = parseHeadersFile('https://:project.pages.dev/*\n  X-A: one\n')
    expect(headersFor(parsed, '/publish').get('x-a')).toEqual(['one'])
  })

  it('joins repeated headers across matching rules', () => {
    const parsed = parseHeadersFile('/*\n  X-A: one\n\n# note\n/p/*\n  X-A: two\n')
    expect(headersFor(parsed, '/p/q').get('x-a')).toEqual(['one', 'two'])
    expect(headersFor(parsed, '/q').get('x-a')).toEqual(['one'])
  })
})
