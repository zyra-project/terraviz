// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FUNCTION_ROUTE_PREFIXES, isPublicAppPath } from '../functions/_middleware'
import { isPublisherPortalPath } from '../src/utils/publisherPath'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * `public/_routes.json` decides which requests invoke Pages Functions,
 * and so which pay for one. Before it existed every request did, which
 * cost nothing while Functions lived only under `/api/` and friends.
 * The root middleware (`functions/_middleware.ts`) changes that: with
 * no routes file it would run on every image, script and tile too.
 *
 * Three things have to stay true, and each has a way to break quietly:
 *
 * - **Every Function route stays routed.** Excluding one turns a live
 *   endpoint into the SPA's `index.html`. The routes are read from the
 *   `functions/` tree, so a new one is covered without editing this.
 * - **The static output stays out.** Every top-level entry in `public/`
 *   must be excluded, or explicitly named below as routed on purpose,
 *   so a file added to `public/` cannot quietly cost an invocation per
 *   request.
 * - **The portal stays out.** `public/_headers` governs `/publish`; the
 *   middleware skips it as well, but it should never be asked.
 *
 * The file must also pass the checks wrangler runs before a deploy
 * (`validateRoutes` in wrangler's Pages code): at most 100 rules,
 * each at most 100 characters and starting with `/`, and no rule
 * covered by a `/…/*` rule beside it.
 */

interface RoutesSpec {
  version: number
  include: string[]
  exclude: string[]
}

const routes = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/_routes.json'), 'utf8')) as RoutesSpec

/** Pages' routes grammar: `*` matches anything, `/` included. */
function ruleMatches(rule: string, path: string): boolean {
  const source = rule
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`).test(path)
}

/** Does this path invoke Functions? An exclude beats an include. */
function invokesFunctions(spec: RoutesSpec, path: string): boolean {
  if (spec.exclude.some(rule => ruleMatches(rule, path))) return false
  return spec.include.some(rule => ruleMatches(rule, path))
}

/** wrangler's overlap check, verbatim in effect. */
function hasOverlappingRules(rules: string[]): boolean {
  for (const splat of rules.filter(rule => rule.endsWith('/*'))) {
    const prefix = splat.slice(0, -1)
    if (rules.some(rule => rule !== splat && rule.startsWith(prefix))) return true
  }
  return false
}

/** Every file under `functions/` that Pages turns into a route, as a
 *  concrete path: `[param]` becomes one segment, `[[param]]` two. */
function functionRoutePaths(): string[] {
  const root = resolve(REPO_ROOT, 'functions')
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        if (name === '_lib' || name === 'node_modules') continue
        walk(full)
        continue
      }
      if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.d.ts')) continue
      if (name.startsWith('_')) continue // _middleware.ts and helper modules
      const source = readFileSync(full, 'utf8')
      if (!/export\s+(const|async function|function)\s+onRequest/.test(source)) continue
      const route = relative(root, full)
        .replace(/\.ts$/, '')
        .replace(/(^|\/)index$/, '')
        .replace(/\[\[[^\]]+\]\]/g, 'a/b')
        .replace(/\[[^\]]+\]/g, 'x')
      out.push(`/${route}`)
    }
  }
  walk(root)
  return out
}

describe('public/_routes.json is a file Pages will deploy', () => {
  it('is version 1 with at least one include', () => {
    expect(routes.version).toBe(1)
    expect(routes.include.length).toBeGreaterThan(0)
  })

  it('stays inside the rule limits', () => {
    const all = [...routes.include, ...routes.exclude]
    expect(all.length).toBeLessThanOrEqual(100)
    for (const rule of all) {
      expect(rule.length).toBeLessThanOrEqual(100)
      expect(rule.startsWith('/')).toBe(true)
    }
  })

  it('has no overlapping rules', () => {
    expect(hasOverlappingRules(routes.include)).toBe(false)
    expect(hasOverlappingRules(routes.exclude)).toBe(false)
  })
})

describe('public/_routes.json: Function routes stay routed', () => {
  const paths = functionRoutePaths()

  it('finds the routes it is meant to check', () => {
    // A guard on the walk itself: these are known to exist.
    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/ingest',
        '/api/v1/publish/node-settings',
        '/.well-known/terraviz.json',
      ]),
    )
    expect(paths.some(path => path.startsWith('/schema/'))).toBe(true)
  })

  it.each(paths)('%s invokes Functions', path => {
    expect(invokesFunctions(routes, path)).toBe(true)
  })

  it('the middleware leaves every Function route alone', () => {
    for (const path of paths) expect(isPublicAppPath(path)).toBe(false)
  })

  it('names one middleware prefix per top-level functions/ directory, and no more', () => {
    const dirs = readdirSync(resolve(REPO_ROOT, 'functions')).filter(
      name => !name.startsWith('_') && statSync(resolve(REPO_ROOT, 'functions', name)).isDirectory(),
    )
    expect([...FUNCTION_ROUTE_PREFIXES].sort()).toEqual(dirs.map(dir => `/${dir}/`).sort())
  })
})

describe('public/_routes.json: the static output stays out', () => {
  /** Top-level `public/` entries that are not static files a browser
   *  fetches: Pages' own config, and `schema/`, which shares its
   *  prefix with the STAC schema Functions and so stays routed. */
  const NOT_STATIC = new Set(['_headers', '_redirects', '_routes.json', 'schema'])

  const entries = readdirSync(resolve(REPO_ROOT, 'public')).filter(name => !NOT_STATIC.has(name))

  it.each(entries)('public/%s is excluded', name => {
    const isDir = statSync(resolve(REPO_ROOT, 'public', name)).isDirectory()
    if (isDir) {
      expect(invokesFunctions(routes, `/${name}/anything.js`)).toBe(false)
      return
    }
    expect(invokesFunctions(routes, `/${name}`)).toBe(false)
    // Pages serves `x.html` at `/x` too (and 308s the long form).
    if (name.endsWith('.html')) expect(invokesFunctions(routes, `/${name.slice(0, -5)}`)).toBe(false)
  })

  it.each(['/assets/main-abc123.js', '/assets/basemaps/x.jpg', '/docs/index.html'])(
    '%s, from the build rather than public/, is excluded',
    path => {
      expect(invokesFunctions(routes, path)).toBe(false)
    },
  )
})

describe('public/_routes.json: the app is routed, the portal is not', () => {
  it.each(['/', '/dataset/sea-surface-temperature', '/blog', '/blog/a-post', '/orbit', '/output/output', '/output/kiosk', '/publisher'])(
    '%s invokes the middleware, which treats it as the public app',
    path => {
      expect(invokesFunctions(routes, path)).toBe(true)
      expect(isPublicAppPath(path)).toBe(true)
    },
  )

  it.each(['/publish', '/publish/', '/publish/users', '/publish/datasets/x/edit'])(
    '%s never reaches a Function, and the middleware would skip it anyway',
    path => {
      expect(isPublisherPortalPath(path)).toBe(true)
      expect(invokesFunctions(routes, path)).toBe(false)
      expect(isPublicAppPath(path)).toBe(false)
    },
  )
})

describe('the routes matcher', () => {
  it('matches the way Pages does', () => {
    expect(ruleMatches('/*', '/a/b/c')).toBe(true)
    expect(ruleMatches('/publish/*', '/publish/x/y')).toBe(true)
    expect(ruleMatches('/publish/*', '/publish')).toBe(false)
    expect(ruleMatches('/publish', '/publisher')).toBe(false)
    expect(invokesFunctions({ version: 1, include: ['/*'], exclude: ['/a/*'] }, '/a/b')).toBe(false)
  })

  it('finds overlaps the way wrangler does', () => {
    expect(hasOverlappingRules(['/a/*', '/a/b'])).toBe(true)
    expect(hasOverlappingRules(['/a/*', '/a'])).toBe(false)
  })
})
