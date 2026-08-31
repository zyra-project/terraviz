// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The handoff report — every value the operator has to put somewhere
 * this tool cannot reach.
 *
 * A provisioner that stops at "done" leaves the worst part of an
 * install undocumented: the half-dozen values that have to be typed
 * into a *different* system. GitHub Actions secrets, the `VITE_*`
 * build variables, the R2 S3 credentials. Each one is a place where
 * an operator either goes hunting through a 1700-line guide or, more
 * likely, forgets — and then hits a failure hours later with no
 * obvious link back.
 *
 * So the run ends with a checklist: what is already handled, what is
 * still outstanding, the exact destination for each, and — where the
 * value is known and not secret — the value itself, ready to copy.
 *
 * ## What is deliberately not printed
 *
 * Secret *values*, except the service-token secret at the moment of
 * creation (Cloudflare shows it once; not printing it would lose it).
 * Everything else that is secret is named, with where to get it, and
 * referenced as `"$VAR"` so a copied command reads from a shell that
 * already has it.
 */

import { wrap } from './prompt'
import type { SetupState } from './state'

export type HandoffStatus = 'done' | 'todo' | 'optional'

export interface HandoffItem {
  name: string
  status: HandoffStatus
  /** Value to copy, when known and safe to print. */
  value?: string
  /** How to obtain it, when it isn't known. */
  source?: string
  why?: string
}

export interface HandoffGroup {
  destination: string
  /** Where to click, when the destination is a UI. */
  url?: string
  intro?: string
  items: HandoffItem[]
}

export interface HandoffOptions {
  /** Features the operator opted into; gates whole groups. */
  features?: Set<'r2' | 'transcode'>
  /**
   * True when a Git remote drives the build, false for Direct Upload,
   * undefined when the run never checked. The three cases put the
   * VITE_* variables in different places, and guessing wrong sends an
   * operator to a dashboard field that has no effect.
   */
  gitConnected?: boolean
  /** Names the current shell already exports. */
  available?: Set<string>
}

function has(env: Set<string> | undefined, name: string): boolean {
  return env ? env.has(name) : false
}

export function buildHandoff(state: SetupState, opts: HandoffOptions = {}): HandoffGroup[] {
  const groups: HandoffGroup[] = []
  const site = state.hostname ? `https://${state.hostname}` : null
  const features = opts.features ?? new Set()

  // ── Build variables ─────────────────────────────────────────────
  // VITE_* are baked in at build time. Changing one later needs a
  // rebuild, not just a redeploy — which is why they are called out
  // separately from bindings rather than lumped in with them.
  groups.push({
    destination:
      opts.gitConnected === true
        ? 'Cloudflare Pages → Settings → Variables and Secrets → Build'
        : opts.gitConnected === false
          ? 'Your CI job (the one that runs `npm run build`)'
          : 'Wherever your build runs',
    intro:
      opts.gitConnected === true
        ? 'Cloudflare runs your build, so these belong in the dashboard.'
        : opts.gitConnected === false
          ? 'This is a Direct Upload project — Cloudflare never runs your ' +
            'build, so these must be exported wherever the build happens. ' +
            'Setting them in the Pages dashboard has no effect.'
          : 'If the Pages project is connected to Git, Cloudflare runs the ' +
            'build and these belong in its dashboard. On a Direct Upload ' +
            'project they must be exported in your CI job instead — setting ' +
            'them in the dashboard would have no effect.',
    items: [
      // Both already resolve to these values with nothing set:
      // `resolveBuildChannel` returns 'public' for anything that is
      // not 'internal' or 'canary', and TELEMETRY_BUILD_ENABLED is
      // `!== 'false'`. Printing them as work to do sends an operator
      // to a dashboard to type in the default. Still named, so the
      // list stays complete, carrying the value that would change
      // something rather than the one that would not.
      {
        name: 'VITE_BUILD_CHANNEL',
        status: 'optional',
        why: 'already public; set it only for an internal or canary build',
      },
      {
        name: 'VITE_TELEMETRY_ENABLED',
        status: 'optional',
        why: 'already on; false is the only value that changes anything',
      },
      {
        name: 'VITE_API_ORIGIN',
        status: site ? 'todo' : 'optional',
        value: site ?? undefined,
        why: 'desktop builds and deep-link host recognition',
      },
      {
        name: 'VITE_EARTH_ASSET_BASE',
        status: 'optional',
        source: 'nothing — the Earth textures ship in your own build',
        why: 'set it only to serve them from a CDN instead',
      },
    ],
  })

  // ── GitHub ──────────────────────────────────────────────────────
  const repo =
    state.githubOwner && state.githubRepo
      ? `${state.githubOwner}/${state.githubRepo}`
      : null
  const githubItems: HandoffItem[] = [
    {
      name: 'CF_ACCESS_CLIENT_ID',
      status: has(opts.available, 'CF_ACCESS_CLIENT_ID') ? 'done' : 'todo',
      source: 'printed by the access step (Cloudflare shows the pair once)',
    },
    {
      name: 'CF_ACCESS_CLIENT_SECRET',
      status: has(opts.available, 'CF_ACCESS_CLIENT_SECRET') ? 'done' : 'todo',
      source: 'same — save it at creation or rotate the token',
    },
    {
      name: 'TERRAVIZ_SERVER',
      status: site ? 'todo' : 'optional',
      value: site ?? undefined,
      why: 'the URL workflows POST results back to',
    },
  ]
  if (features.has('transcode')) {
    githubItems.push(
      { name: 'R2_S3_ENDPOINT', status: 'todo', source: 'the R2 API token you minted' },
      { name: 'R2_ACCESS_KEY_ID', status: 'todo', source: 'same' },
      { name: 'R2_SECRET_ACCESS_KEY', status: 'todo', source: 'same' },
    )
  }
  groups.push({
    destination: `GitHub${repo ? ` (${repo})` : ''} → Settings → Secrets and variables → Actions`,
    intro:
      '`npm run setup -- --github-secrets` prints ready-to-run `gh` commands ' +
      'for these. TERRAVIZ_SERVER is needed as BOTH a secret and a Variable — ' +
      'the secrets context is not allowed in a workflow\'s environment.url.',
    items: githubItems,
  })

  // ── R2 credentials ──────────────────────────────────────────────
  if (features.has('r2') || features.has('transcode')) {
    groups.push({
      destination: 'Your shell, then re-run `npm run setup -- --apply --only=bindings`',
      url: 'https://dash.cloudflare.com/?to=/:account/r2/api-tokens',
      intro:
        'Minting these needs a token that can create tokens, so it stays ' +
        'manual. Once exported, the bindings step pushes them to Pages.',
      items: [
        {
          name: 'R2_S3_ENDPOINT',
          status: has(opts.available, 'R2_S3_ENDPOINT') ? 'done' : 'todo',
          source: 'shown when the R2 API token is created',
        },
        {
          name: 'R2_ACCESS_KEY_ID',
          status: has(opts.available, 'R2_ACCESS_KEY_ID') ? 'done' : 'todo',
        },
        {
          name: 'R2_SECRET_ACCESS_KEY',
          status: has(opts.available, 'R2_SECRET_ACCESS_KEY') ? 'done' : 'todo',
          source: 'shown once at creation',
        },
      ],
    })
  }

  // ── Recorded, nothing to do ─────────────────────────────────────
  const recorded: HandoffItem[] = []
  if (state.accessAud) {
    recorded.push({
      name: 'ACCESS_AUD',
      status: 'done',
      value: state.accessAud,
      why: 'written to both Pages environments',
    })
  }
  if (state.accessTeamDomain) {
    recorded.push({ name: 'ACCESS_TEAM_DOMAIN', status: 'done', value: state.accessTeamDomain })
  }
  if (state.d1.id) {
    recorded.push({ name: 'D1 database id', status: 'done', value: state.d1.id })
  }
  if (state.serviceTokenClientId) {
    recorded.push({
      name: 'CF_ACCESS_CLIENT_ID',
      status: 'done',
      value: state.serviceTokenClientId,
      why: 'the id is not secret; the matching secret is not stored anywhere',
    })
  }
  if (recorded.length > 0) {
    groups.push({
      destination: 'Already handled — recorded in .terraviz-setup.json',
      items: recorded,
    })
  }

  return groups
}

const GLYPH: Record<HandoffStatus, string> = {
  done: '✓',
  todo: '→',
  optional: '·',
}

export function renderHandoff(groups: HandoffGroup[]): string {
  const out: string[] = [
    '',
    '════ Values you need to paste elsewhere ════',
    '',
    '  ✓ already handled    → do this    · optional',
    '',
  ]
  for (const group of groups) {
    out.push(`── ${group.destination}`)
    if (group.url) out.push(`   ${group.url}`)
    if (group.intro) {
      for (const line of wrap(group.intro, 68)) out.push(`   ${line}`)
    }
    out.push('')
    for (const item of group.items) {
      const value = item.value ? ` = ${item.value}` : ''
      out.push(`   ${GLYPH[item.status]} ${item.name}${value}`)
      if (!item.value && item.source) out.push(`       from: ${item.source}`)
      if (item.why) out.push(`       (${item.why})`)
    }
    out.push('')
  }
  return out.join('\n') + '\n'
}
