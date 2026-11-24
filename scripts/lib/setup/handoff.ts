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

import { CAPABILITIES, type SetupFeature } from './capabilities'
import { wrap } from './prompt'
import { DEFAULT_NAMES, type SetupState } from './state'

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
  features?: Set<SetupFeature>
  /**
   * True when a Git remote drives the build, false for Direct Upload,
   * undefined when the run never checked. The three cases put the
   * VITE_* variables in different places, and guessing wrong sends an
   * operator to a dashboard field that has no effect.
   */
  gitConnected?: boolean
  /** Names the current shell already exports. */
  available?: Set<string>
  /**
   * The shell's `CATALOG_R2_BUCKET`, trimmed. Compared by value, not
   * name: an export left over from another bucket is not done.
   */
  shellBucket?: string
}

function has(env: Set<string> | undefined, name: string): boolean {
  return env ? env.has(name) : false
}

export function buildHandoff(state: SetupState, opts: HandoffOptions = {}): HandoffGroup[] {
  const groups: HandoffGroup[] = []
  const site = state.hostname ? `https://${state.hostname}` : null
  const features = opts.features ?? new Set()
  // The bindings step writes CATALOG_R2_BUCKET to Pages, but the CLI
  // and the GitHub workflow runners (transcode-hls.yml, zyra-run.yml)
  // read their own copy, and without one they address
  // terraviz-assets. Only a renamed bucket needs it.
  const bucket = state.r2Bucket.name
  const bucketItem = (writers: string, status: HandoffStatus): HandoffItem[] =>
    bucket === DEFAULT_NAMES.r2Bucket
      ? []
      : [
          {
            name: 'CATALOG_R2_BUCKET',
            status,
            value: bucket,
            why: `without it, ${writers} ${DEFAULT_NAMES.r2Bucket}, not your bucket`,
          },
        ]

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
      // `resolveBuildChannel` returns 'public' for a build unless told
      // 'internal' or 'canary' (only the dev server defaults to
      // 'internal'), and TELEMETRY_BUILD_ENABLED is
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
  // Both runners write into the bucket through the S3 API.
  if (features.has('transcode') || features.has('zyra')) {
    githubItems.push(
      { name: 'R2_S3_ENDPOINT', status: 'todo', source: 'the R2 API token you minted' },
      { name: 'R2_ACCESS_KEY_ID', status: 'todo', source: 'same' },
      { name: 'R2_SECRET_ACCESS_KEY', status: 'todo', source: 'same' },
    )
  }
  githubItems.push(...bucketItem('the transcode and Zyra workflow runners write to', 'todo'))
  groups.push({
    destination: `GitHub${repo ? ` (${repo})` : ''} → Settings → Secrets and variables → Actions`,
    intro:
      '`npm run setup -- --github-secrets` prints ready-to-run `gh` commands ' +
      'for these. TERRAVIZ_SERVER is needed as BOTH a secret and a Variable — ' +
      'the secrets context is not allowed in a workflow\'s environment.url.',
    items: githubItems,
  })

  // ── Workflows ───────────────────────────────────────────────────
  // A secret set on a workflow that is turned off does nothing. Forks
  // start with Actions off and scheduled workflows stay off after
  // that, so each one the chosen features run is named here.
  const chosen = CAPABILITIES.filter(c => c.feature && features.has(c.feature))
  const workflowItems: HandoffItem[] = []
  for (const cap of chosen) {
    for (const w of cap.workflows) {
      if (workflowItems.some(i => i.name === w.file)) continue
      workflowItems.push({ name: w.file, status: 'todo', why: `${cap.title} · ${w.when}` })
    }
  }
  if (workflowItems.length > 0) {
    groups.push({
      destination: `GitHub${repo ? ` (${repo})` : ''} → Actions`,
      intro:
        'Turn each of these on. A fork starts with Actions off, and its ' +
        'scheduled workflows stay off until you enable them one by one. A ' +
        'workflow that is off never runs, and nothing on the node says so.',
      items: workflowItems,
    })
  }

  // ── Analytics archive (Phase 14.2) ──────────────────────────────
  if (features.has('analytics')) {
    groups.push({
      destination: 'Cloudflare Pages → Settings → Variables and Secrets (Phase 14.2)',
      intro:
        'Setup does not create the analytics archive yet. The nightly ' +
        'export has nowhere to write until these exist; then redeploy.',
      items: [
        { name: 'ANALYTICS_R2', status: 'todo', source: 'an R2 bucket of its own, bound under this name' },
        { name: 'CF_ACCOUNT_ID', status: 'todo', value: state.accountId || undefined },
        {
          name: 'ANALYTICS_SQL_TOKEN',
          status: 'todo',
          source: 'a token with exactly Account → Account Analytics → Read',
        },
      ],
    })
  }

  // ── R2 credentials ──────────────────────────────────────────────
  if (features.has('r2') || features.has('transcode') || features.has('zyra')) {
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
        ...bucketItem(
          'upload and migrate-r2-* write to',
          opts.shellBucket === bucket ? 'done' : 'todo',
        ),
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
  // ── Left out ────────────────────────────────────────────────────
  // What this run did not set up, so an operator can see how far the
  // node goes rather than finding out from a 503 or a feed that never
  // refreshes.
  const leftOut = CAPABILITIES.filter(c => c.feature && !features.has(c.feature))
  if (leftOut.length > 0) {
    groups.push({
      destination: 'Not set up by this run — re-run with --with=<feature> to add one',
      items: leftOut.map(c => ({
        name: `--with=${c.feature}`,
        status: 'optional' as const,
        why: c.needs.includes('github-actions')
          ? `${c.title}; needs GitHub Actions in a repository you control`
          : c.title,
      })),
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
