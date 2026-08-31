// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyAnswer,
  isAnswered,
  MANUAL_STEPS,
  pendingQuestions,
  QUESTIONS,
  renderManualStep,
  renderManualSteps,
  lineText,
} from './interview'
import { buildHandoff, renderHandoff } from './handoff'
import { defaultState, DEFAULT_NAMES, type SetupState } from './state'

describe('QUESTIONS', () => {
  it('gives every question help text and an env-var escape hatch', () => {
    for (const q of QUESTIONS) {
      expect(q.help?.length, `${q.key} has no help`).toBeGreaterThan(0)
      expect(q.envVar, `${q.key} has no env var`).toBeTruthy()
    }
  })

  it('validates every answer it accepts', () => {
    for (const q of QUESTIONS) expect(q.validate, `${q.key} is unvalidated`).toBeTypeOf('function')
  })

  // The old guide's single worst factual error was claiming this
  // granted admin. The prompt has to say what the code does.
  it('tells the truth about TRUSTED_PUBLISHER_DOMAINS being read-only', () => {
    const q = QUESTIONS.find(x => x.key === 'trustedPublisherDomains')!
    const help = q.help!.join(' ')
    expect(help).toMatch(/READ-ONLY|reviewer/)
    expect(help).toMatch(/does not make anyone/i)
    // "Auto-approve domains" reads like it opens a door to the
    // internet. It cannot: `publish/_middleware.ts` verifies the
    // Access JWT and only then consults the trusted-domain list, so
    // a domain named here reaches nobody Access does not already
    // admit. The prompt has to say so, or the scariest-sounding
    // reading is the one an operator acts on.
    expect(help).toMatch(/Access/)
  })
})

describe('applyAnswer', () => {
  it('splits owner/repo into two fields', () => {
    const next = applyAnswer(defaultState(), 'githubRepo', 'me/mine')
    expect(next.githubOwner).toBe('me')
    expect(next.githubRepo).toBe('mine')
  })

  it('normalises a domain list, dropping @ and blanks', () => {
    const next = applyAnswer(defaultState(), 'trustedPublisherDomains', ' @a.org , b.org ,')
    expect(next.trustedPublisherDomains).toBe('a.org,b.org')
  })

  it('strips a trailing slash from the R2 origin', () => {
    expect(applyAnswer(defaultState(), 'r2PublicBase', 'https://a.org/').r2PublicBase).toBe(
      'https://a.org',
    )
  })

  it('trims a plain answer', () => {
    expect(applyAnswer(defaultState(), 'hostname', '  a.org ').hostname).toBe('a.org')
  })

  it('does not mutate the input state', () => {
    const state = defaultState()
    applyAnswer(state, 'hostname', 'a.org')
    expect(state.hostname).toBeUndefined()
  })
})

describe('pendingQuestions', () => {
  it('asks everything on a fresh state', () => {
    const pending = pendingQuestions(defaultState(), {})
    expect(pending.map(q => q.key)).toEqual([
      'accountId',
      'hostname',
      'pagesProject',
      'staffEmailDomain',
      'trustedPublisherDomains',
    ])
  })

  it('skips what the environment already supplies', () => {
    const pending = pendingQuestions(defaultState(), {
      CLOUDFLARE_ACCOUNT_ID: 'x',
      TERRAVIZ_HOSTNAME: 'y',
    })
    expect(pending.map(q => q.key)).not.toContain('accountId')
    expect(pending.map(q => q.key)).not.toContain('hostname')
  })

  it('skips what a previous run already recorded', () => {
    const state: SetupState = { ...defaultState(), hostname: 'a.org' }
    expect(pendingQuestions(state, {}).map(q => q.key)).not.toContain('hostname')
  })

  // The default is always populated, so "answered" can only mean the
  // operator chose something else.
  it('still asks for the project name while it holds the default', () => {
    const state: SetupState = { ...defaultState(), pagesProject: DEFAULT_NAMES.pagesProject }
    expect(pendingQuestions(state, {}).map(q => q.key)).toContain('pagesProject')
    const chosen: SetupState = { ...defaultState(), pagesProject: 'mine' }
    expect(pendingQuestions(chosen, {}).map(q => q.key)).not.toContain('pagesProject')
  })

  it('hides feature-gated questions unless the feature was requested', () => {
    expect(pendingQuestions(defaultState(), {}).map(q => q.key)).not.toContain('r2PublicBase')
    const withR2 = pendingQuestions(defaultState(), {}, { features: new Set(['r2']) })
    expect(withR2.map(q => q.key)).toContain('r2PublicBase')
  })

  it('asks nothing once everything is answered', () => {
    const env = Object.fromEntries(QUESTIONS.map(q => [q.envVar, 'set']))
    expect(pendingQuestions(defaultState(), env)).toEqual([])
  })
})

describe('isAnswered', () => {
  it('prefers the environment over state', () => {
    const q = QUESTIONS.find(x => x.key === 'hostname')!
    expect(isAnswered(q, defaultState(), { TERRAVIZ_HOSTNAME: 'x' })).toBe(true)
  })

  it('needs both halves of owner/repo', () => {
    const q = QUESTIONS.find(x => x.key === 'githubRepo')!
    const partial: SetupState = { ...defaultState(), githubOwner: 'me' }
    expect(isAnswered(q, partial, {})).toBe(false)
  })
})

describe('MANUAL_STEPS', () => {
  it('explains what breaks, not just what to click', () => {
    for (const step of MANUAL_STEPS) {
      expect(step.why.length, `${step.id} has no rationale`).toBeGreaterThan(40)
      expect(step.steps.length, `${step.id} has no instructions`).toBeGreaterThan(0)
    }
  })

  // Asking a human to self-certify something checkable invites a
  // wrong answer that the tool then trusts.
  it('marks checkable prerequisites as detected rather than self-certified', () => {
    const byId = new Map(MANUAL_STEPS.map(s => [s.id, s]))
    expect(byId.get('zero-trust')?.verification).toBe('detected')
    expect(byId.get('node-key')?.verification).toBe('detected')
    expect(byId.get('dns')?.verification).toBe('detected')
    // Billing state is genuinely invisible to us.
    expect(byId.get('workers-paid')?.verification).toBe('self')
  })

  // A docsUrl attached to the wrong step is worse than none — it sends
  // someone learning Cloudflare confidently to the wrong page. These
  // pairs were checked to resolve; the mapping is what drifts.
  it('points each docs link at its own subject', () => {
    const doc = (id: string) => MANUAL_STEPS.find(s => s.id === id)?.docsUrl ?? ''
    expect(doc('api-token')).toContain('/api/get-started/create-token')
    expect(doc('dns')).toContain('/manage-domains/add-site')
    expect(doc('zero-trust')).toContain('/cloudflare-one/')
    expect(doc('git-connect')).toContain('/pages/configuration/git-integration')
    expect(doc('r2-token')).toContain('/r2/api/tokens')
    expect(doc('workers-paid')).toContain('/workers/platform/pricing')
    expect(doc('fork')).toContain('/working-with-forks/fork-a-repo')
    // Not a vendor page: the exact section of our own guide that
    // says which version and how to check it. It matches
    // MARKDOWN_URL, so applyDocLinks retargets it at the reader's
    // own fork rather than sending them upstream.
    expect(doc('node')).toContain('SELF_HOSTING.md#03-tools')
    // node-key is our own script, not a Cloudflare task.
    expect(doc('node-key')).toBe('')
    // An allowlist of hosts rather than one host: forking is a GitHub
    // task, and the point of this check is that a link goes somewhere
    // we trust and vouched for, not that everything is Cloudflare.
    const DOC_HOSTS = [
      'https://developers.cloudflare.com/',
      'https://docs.github.com/',
      // Our own guide, pinned to the repo rather than to all of
      // github.com — the point is that a link goes somewhere we
      // vouched for, and 'any GitHub URL' vouches for nothing.
      'https://github.com/zyra-project/terraviz/',
    ]
    for (const s of MANUAL_STEPS) {
      if (s.docsUrl) expect(DOC_HOSTS.some(h => s.docsUrl!.startsWith(h))).toBe(true)
    }
  })

  // The lines used to be hand-wrapped for a 66-column terminal, with
  // two-space continuation indents — which the web console then
  // re-wrapped at its own width, breaking sentences mid-phrase inside a
  // monospace box. Each entry is a whole thought now; the renderers
  // wrap. A leading indent means someone is hand-wrapping again.
  it('carries whole thoughts, not terminal-width fragments', () => {
    for (const step of MANUAL_STEPS) {
      for (const line of step.steps) {
        if (typeof line !== 'string') continue
        expect(line, `${step.id}: "${line}"`).not.toMatch(/^\s/)
        // Long enough to be a sentence, not a wrapped fragment.
        expect(line.trim(), `${step.id}: "${line}"`).toMatch(/[.:?]$/)
      }
    }
  })

  // Someone installing forked, then missed the clone in Phase 0 and
  // had nowhere to run anything. Forking and cloning are one action
  // in a reader's head; splitting them across two documents loses the
  // second half.
  it('tells you to clone the fork, not just create it', () => {
    const fork = MANUAL_STEPS.find(s => s.id === 'fork')!
    const text = fork.steps.map(lineText).join('\n')
    expect(text).toMatch(/git clone/)
    expect(text).toMatch(/\{\{W3\}\}/)
    // And which repo to clone, since a clone of upstream works right
    // up until there is nowhere to push to.
    expect(text).toMatch(/not zyra-project\/terraviz/)
  })

  // Someone installing hit `'tsx' is not recognized` at the first
  // `npm run` step. tsx is a normal dependency, so any `npm install`
  // provides it — but `npm install` appeared in none of the ten steps.
  // It lived only in the guide, which a person working the sheet as a
  // recipe never opens.
  it('installs dependencies in the step that clones', () => {
    const fork = MANUAL_STEPS.find(s => s.id === 'fork')!
    expect(fork.steps.map(lineText).join('\n')).toMatch(/npm install/)
  })

  // Every `npm run` the sheet asks you to execute depends on that
  // having happened. Scanned over `code` lines only — prose mentions
  // npm run freely ("every command starts with npm run") without
  // asking anyone to type one, and treating that as the trigger makes
  // the check fire on step 1 forever.
  it('installs dependencies before the first command it asks you to run', () => {
    const commandsSoFar: string[] = []
    for (const step of MANUAL_STEPS) {
      const code = step.steps
        .filter((l): l is { code: string } => typeof l !== 'string' && 'code' in l)
        .map(l => l.code)
      const asksToRun = code.some(c => /npm run/.test(c))
      const installsHere = code.some(c => /npm install/.test(c))
      if (asksToRun && !installsHere && !commandsSoFar.some(c => /npm install/.test(c))) {
        throw new Error(`${step.id} runs an npm script before any step installs dependencies`)
      }
      commandsSoFar.push(...code)
    }
    expect(commandsSoFar.some(c => /npm install/.test(c))).toBe(true)
  })

  /**
   * Derived from what `provision.ts` actually runs, not restated.
   *
   * The previous version of this test was a hand-written list of six
   * permissions, and it was written from the same wrong source as the
   * step it guarded. Both omitted Workers KV Storage and Vectorize —
   * so a token minted from the checklist created the D1 database and
   * then failed on `kv namespace create`, several minutes in, with an
   * authentication error that named no permission. A list checked
   * against a list can only catch deletions; it cannot catch the
   * permission nobody thought of.
   *
   * So the product set comes out of the provisioning source. Adding a
   * fifth resource type to Phase 2 now fails here until the token step
   * names the permission that creates it.
   */
  const WRANGLER_PERMISSION: Record<string, string> = {
    d1: 'D1',
    kv: 'Workers KV Storage',
    r2: 'Workers R2 Storage',
    vectorize: 'Vectorize',
  }

  /**
   * The permission rows only, never the prose around them.
   *
   * Searching the whole step for "Vectorize" passes on a step that
   * merely *mentions* Vectorize — and the note explaining which
   * permissions a Pages-only token fails on does exactly that. The
   * first draft of this check was satisfied by that sentence while the
   * table row was missing, which is the same false-negative it was
   * written to remove. A grant is a table row: scope, permission,
   * access level.
   */
  const grantedPermissions = (): string[] =>
    MANUAL_STEPS.find(s => s.id === 'api-token')!
      .steps.filter((l): l is { code: string } => typeof l !== 'string' && 'code' in l)
      .flatMap(l => l.code.split('\n'))
      .map(row => /^\s*(?:Account|Zone|User)\s+→\s+(.+?)\s{2,}(Read|Edit)\b/.exec(row))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => m[1].trim())

  it('names a permission for every resource the tool provisions', () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'provision.ts'),
      'utf8',
    )
    // `run(['vectorize', 'create', …])` — the first argument of every
    // wrangler invocation is the product.
    const products = new Set(
      [...source.matchAll(/run\(\[\s*'([a-z0-9]+)'/g)].map(m => m[1]),
    )
    expect(products.size, 'no wrangler calls found — did provision.ts move?').toBeGreaterThan(0)

    const granted = grantedPermissions()
    expect(granted.length, 'no permission rows parsed — did the table format change?')
      .toBeGreaterThan(0)

    const unnamed = [...products]
      .filter(p => WRANGLER_PERMISSION[p])
      .filter(p => !granted.includes(WRANGLER_PERMISSION[p]))
      .map(p => `${p} → ${WRANGLER_PERMISSION[p]}`)

    expect(
      unnamed,
      'provision.ts runs these wrangler products, but the API-token step ' +
        'does not tell anyone to grant the permission each one needs',
    ).toEqual([])

    // Every product the mapping does not cover is a gap in the mapping
    // itself, which would otherwise make the filter above silently
    // vacuous. `pages` is REST-side, asserted separately below.
    const unmapped = [...products].filter(p => !WRANGLER_PERMISSION[p] && p !== 'pages')
    expect(unmapped, 'add these to WRANGLER_PERMISSION with their token permission').toEqual([])
  })

  // The REST-driven half: Pages bindings and Access have no wrangler
  // command to derive from, so they stay named here.
  it('lists the permissions the REST calls need', () => {
    const granted = grantedPermissions()
    for (const perm of [
      'Cloudflare Pages',
      'Access: Apps and Policies',
      'Access: Service Tokens',
      'Access: Organizations',
      'Zone WAF',
    ]) {
      expect(granted, `${perm} is not granted by any permission row`).toContain(perm)
    }
  })

  /**
   * Grant-only-what-you-need is the whole point of the split, and it
   * only works if each optional row says what turns it on. A row that
   * reads "only for optional steps" tells a reader they might not need
   * it and gives them no way to decide.
   */
  it('names the trigger beside each optional permission', () => {
    const text = MANUAL_STEPS.find(s => s.id === 'api-token')!.steps
      .map(lineText)
      .join('\n')
    // The scope column is part of the assertion, not decoration. Both
    // names live behind a dropdown that opens on Account, so a row
    // reading `Account → Zone WAF` is the exact mistake this step
    // exists to prevent — and it would satisfy a pattern that started
    // matching at the permission name.
    expect(text).toMatch(/Zone\s+→\s+Zone WAF\s+Edit\s+--only=waf/)
    expect(text).toMatch(/Zone\s+→\s+Zone\s+Read\s+--only=r2/)
  })

  /**
   * The guide must cite these steps by name, never by position.
   *
   * `MANUAL_STEPS` is numbered at render time from its array index, so
   * inserting a step renumbers every one after it. The guide carried
   * `# from --manual step 3` pointing at the API-token step, which had
   * been sixth for some time — a stale number that reads as authoritative
   * and sends someone to "Fork the repository" for a token.
   *
   * Titles do not drift the way indices do, and a wrong title is
   * obvious where a wrong number is not. So the reference form is the
   * name.
   */
  it('is cited by name in the guide, never by step number', () => {
    const guide = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/SELF_HOSTING.md'),
      'utf8',
    )
    const numbered = [...guide.matchAll(/--manual step \d+/g)].map(m => m[0])
    expect(
      numbered,
      'cite the step by its title instead — inserting a manual step renumbers ' +
        'every later one, and nothing recomputes these',
    ).toEqual([])
  })

  /**
   * A `§N.M` pointing into the guide has to land on a real section.
   *
   * The Git-connect step tells the reader that §5.2 lists the
   * `VITE_*` variables, because duplicating that table here would
   * give it two copies to drift apart. That trade only holds while
   * the pointer is right — a stale one is worse than no pointer,
   * since GitHub answers a missing fragment with the top of the
   * document and the reader concludes the list does not exist.
   *
   * Subsections are written two ways: `## 8.5 …` headings for most
   * phases, and `**15.1 …**` bold labels inside Phase 15. Both count.
   */
  it('points its section references at sections that exist', () => {
    const guide = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/SELF_HOSTING.md'),
      'utf8',
    )
    const sections = new Set([
      ...[...guide.matchAll(/^#{2,3} (\d+\.\d+)\b/gm)].map(m => m[1]),
      ...[...guide.matchAll(/^\*\*(\d+\.\d+) /gm)].map(m => m[1]),
    ])
    expect(sections.size, 'no subsections parsed — did the guide restructure?')
      .toBeGreaterThan(10)

    const dangling = MANUAL_STEPS.flatMap(s =>
      s.steps
        .flatMap(l => [...lineText(l).matchAll(/§(\d+\.\d+)/g)].map(m => m[1]))
        .filter(ref => !sections.has(ref))
        .map(ref => `${s.id} → §${ref}`),
    )
    expect(dangling, 'SELF_HOSTING.md has no such subsection').toEqual([])
  })

  it('renders a step with its heading, rationale and link', () => {
    const text = renderManualStep(MANUAL_STEPS[0], 1)
    expect(text).toContain('1. ')
    expect(text).toContain('Why:')
    expect(text).toContain('https://')
  })

  it('hides feature-gated steps unless requested', () => {
    expect(renderManualSteps()).not.toContain('Mint the R2 S3 API token')
    expect(renderManualSteps(new Set(['r2']))).toContain('Mint the R2 S3 API token')
  })
})

describe('handoff report', () => {
  const state: SetupState = {
    ...defaultState(),
    hostname: 'terraviz.example.org',
    accessAud: 'AUD123',
    d1: { name: 'db', id: 'd1id' },
  }

  it('prints the values it knows, ready to copy', () => {
    const text = renderHandoff(buildHandoff(state))
    expect(text).toContain('VITE_API_ORIGIN = https://terraviz.example.org')
    expect(text).toContain('TERRAVIZ_SERVER = https://terraviz.example.org')
  })

  it('marks what is already handled', () => {
    const text = renderHandoff(buildHandoff(state))
    expect(text).toContain('✓ ACCESS_AUD = AUD123')
  })

  it('names a source for values it cannot know', () => {
    const text = renderHandoff(buildHandoff(state))
    expect(text).toContain('CF_ACCESS_CLIENT_SECRET')
    expect(text).toContain('save it at creation')
  })

  // Sending someone to a dashboard field that has no effect is worse
  // than saying nothing.
  it('words the VITE_* destination differently for each build model', () => {
    expect(renderHandoff(buildHandoff(state, { gitConnected: true }))).toContain(
      'Cloudflare Pages → Settings',
    )
    expect(renderHandoff(buildHandoff(state, { gitConnected: false }))).toContain('CI job')
    expect(renderHandoff(buildHandoff(state))).toContain('Wherever your build runs')
  })

  it('adds the R2 credential group only when the feature is wanted', () => {
    expect(renderHandoff(buildHandoff(state))).not.toContain('r2/api-tokens')
    expect(renderHandoff(buildHandoff(state, { features: new Set(['r2']) }))).toContain(
      'r2/api-tokens',
    )
  })

  it('marks an exported credential as done', () => {
    const text = renderHandoff(
      buildHandoff(state, {
        features: new Set(['r2']),
        available: new Set(['R2_ACCESS_KEY_ID']),
      }),
    )
    expect(text).toContain('✓ R2_ACCESS_KEY_ID')
    expect(text).toContain('→ R2_SECRET_ACCESS_KEY')
  })

  it('never prints a secret value', () => {
    const text = renderHandoff(buildHandoff(state, { features: new Set(['r2', 'transcode']) }))
    expect(text).not.toMatch(/SECRET\s*=/)
  })
})
