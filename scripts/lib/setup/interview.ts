// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The interactive interview — `npm run setup -- --interactive`.
 *
 * Two kinds of thing stand between a fresh clone and a running node,
 * and they need opposite treatment:
 *
 *   - **Values only the operator knows** (account id, hostname, staff
 *     email domain). Ask for these, explain exactly where each comes
 *     from, validate the answer against the shape the API expects,
 *     and re-prompt rather than failing three phases later.
 *   - **Actions only a human can take** (enable Workers Paid, move
 *     nameservers, complete a Zero Trust OAuth flow). These cannot be
 *     asked for at all — they can only be explained, then *detected*.
 *
 * Detection beats confirmation wherever it is available. "Have you
 * enabled Workers Paid? [y/N]" records an opinion; a failing API call
 * records a fact. So the manual steps below carry instructions for
 * the human and, where the tool can check, a note that it will find
 * out on its own rather than a prompt that invites a wrong answer.
 *
 * Everything here is data plus pure functions. The rendering is
 * testable, `--manual` prints the same instructions with no terminal
 * involved, and the flow control lives in the orchestrator.
 */

import { requiredNodeLabel } from '../node-version'
import { validators, wrap, type Question } from './prompt'
import { DEFAULT_NAMES, type SetupState } from './state'

/** Which `SetupState` field an answer lands in. */
export type AnswerKey =
  | 'accountId'
  | 'hostname'
  | 'pagesProject'
  | 'staffEmailDomain'
  | 'trustedPublisherDomains'
  | 'r2PublicBase'
  | 'githubRepo'

export interface InterviewQuestion extends Question {
  key: AnswerKey
  /** Env var that supplies this without a prompt. */
  envVar: string
  /** Skip unless the operator wants this optional feature. */
  featureGate?: 'r2' | 'transcode'
}

export const QUESTIONS: InterviewQuestion[] = [
  {
    key: 'accountId',
    envVar: 'CLOUDFLARE_ACCOUNT_ID',
    label: 'Cloudflare account ID',
    help: [
      'Cloudflare dashboard → any page → the sidebar shows "Account ID"',
      'with a copy button. It is also the 32-hex segment in every',
      'dashboard URL: dash.cloudflare.com/<account-id>/...',
    ],
    example: '8f4c1d2e9a7b6c5d4e3f2a1b0c9d8e7f',
    validate: validators.accountId,
  },
  {
    key: 'hostname',
    envVar: 'TERRAVIZ_HOSTNAME',
    label: 'Public hostname',
    help: [
      'The address people will visit. Its zone must already be on',
      'Cloudflare DNS — Cloudflare provisions the certificate and the',
      'CNAME for you, but only for a zone it controls.',
      'Hostname only: no https://, no trailing path.',
    ],
    example: 'terraviz.your-org.org',
    validate: validators.hostname,
  },
  {
    key: 'pagesProject',
    envVar: 'CLOUDFLARE_PAGES_PROJECT_NAME',
    label: 'Pages project name',
    help: [
      'Becomes <name>.pages.dev, which also serves your preview',
      'deployments. Lowercase letters, digits and dashes.',
    ],
    defaultValue: DEFAULT_NAMES.pagesProject,
    validate: validators.projectName,
  },
  {
    key: 'staffEmailDomain',
    envVar: 'TERRAVIZ_STAFF_EMAIL_DOMAIN',
    label: 'Staff email domain',
    help: [
      'The Access Allow policy matches "emails ending in" this domain.',
      'Everyone with an address here can reach the publisher portal.',
      'A domain, not an address — your-org.org, not you@your-org.org.',
      'Without it the application exists but no human can sign in.',
    ],
    example: 'your-org.org',
    validate: validators.emailDomain,
  },
  {
    key: 'trustedPublisherDomains',
    envVar: 'TRUSTED_PUBLISHER_DOMAINS',
    label: 'Auto-approve domains',
    help: [
      'Optional, and reversible later from the portal Users tab.',
      '',
      'This only sorts people Cloudflare Access already admits. A',
      'domain listed here opens nothing on its own — Access decides',
      'who reaches the portal at all, this decides what greets them.',
      '',
      'Fill it in: anyone with an address at these domains can sign',
      'in and read the portal straight away. They land READ-ONLY',
      '(role reviewer) and can publish nothing. This does not make',
      'anyone an admin — you become admin by being first to sign in.',
      '',
      'Leave it blank: every sign-in waits for you, your own team',
      'included. Nobody is locked out silently — a queued account is',
      'told it is awaiting approval. Safer for a domain you share;',
      'tedious for a colleague waiting on you.',
      '',
      'Comma-separated. Only worth it for domains you control.',
    ],
    example: 'your-org.org,partner.org',
    optional: true,
    validate: validators.emailDomainList,
  },
  {
    key: 'r2PublicBase',
    envVar: 'R2_PUBLIC_BASE',
    label: 'R2 public asset origin',
    help: [
      'Optional, needed before publisher asset uploads work. A hostname',
      'on one of your Cloudflare zones that will serve the bucket',
      'publicly — the tool attaches it to R2 for you.',
      'Give the full origin, including https://.',
    ],
    example: 'https://assets.your-org.org',
    optional: true,
    featureGate: 'r2',
    validate: validators.url,
  },
  {
    key: 'githubRepo',
    envVar: 'GITHUB_REPO',
    label: 'Fork repo (owner/repo)',
    help: [
      'Optional, needed only for publisher video uploads. The repo that',
      'hosts transcode-hls.yml — your fork. The publisher API fires a',
      'repository_dispatch at it when someone uploads a video.',
    ],
    example: 'your-org/terraviz',
    optional: true,
    featureGate: 'transcode',
    validate: validators.repoSlug,
  },
]

/** Apply an answer to state, splitting `owner/repo` where needed. */
export function applyAnswer(state: SetupState, key: AnswerKey, value: string): SetupState {
  const next = { ...state }
  switch (key) {
    case 'githubRepo': {
      const [owner, repo] = value.trim().split('/')
      next.githubOwner = owner
      next.githubRepo = repo
      return next
    }
    case 'r2PublicBase':
      next.r2PublicBase = value.trim().replace(/\/+$/, '')
      return next
    case 'trustedPublisherDomains':
      next.trustedPublisherDomains = value
        .split(',')
        .map(s => s.trim().replace(/^@/, ''))
        .filter(Boolean)
        .join(',')
      return next
    default:
      next[key] = value.trim()
      return next
  }
}

/** Is this question already answered, by state or by the environment? */
export function isAnswered(
  question: InterviewQuestion,
  state: SetupState,
  env: Record<string, string | undefined>,
): boolean {
  if (env[question.envVar]) return true
  switch (question.key) {
    case 'githubRepo':
      return Boolean(state.githubOwner && state.githubRepo)
    case 'pagesProject':
      // The default is always populated, so "answered" means the
      // operator (or a previous run) chose something other than it.
      return state.pagesProject !== DEFAULT_NAMES.pagesProject
    default:
      return Boolean(state[question.key])
  }
}

export interface PendingOptions {
  /** Include questions gated on optional features. */
  features?: Set<'r2' | 'transcode'>
}

export function pendingQuestions(
  state: SetupState,
  env: Record<string, string | undefined>,
  opts: PendingOptions = {},
): InterviewQuestion[] {
  return QUESTIONS.filter(q => {
    if (q.featureGate && !opts.features?.has(q.featureGate)) return false
    return !isAnswered(q, state, env)
  })
}

// ── Manual steps ──────────────────────────────────────────────────

/**
 * One line of a manual step's instructions.
 *
 * These are rendered to two surfaces with different shapes: a terminal
 * ~66 columns wide, and a web card whose width the reader controls. The
 * array used to be plain strings hand-wrapped for the terminal, with
 * two-space continuation indents — so the console re-wrapped
 * already-wrapped text and produced things like "needs no IdP / setup;"
 * mid-sentence, in a monospace box that made prose look like terminal
 * output.
 *
 * So a line says what *kind* of thing it is and lets each renderer
 * decide how to lay it out. Entries are whole thoughts; neither the
 * author nor the data does any wrapping.
 *
 * - a bare string is an **action** — something to go and do
 * - `{ note }` is context around the actions, not a step in itself
 * - `{ code }` is a literal: a command, or a table whose alignment
 *   carries meaning. Preserved exactly, monospace on both surfaces.
 */
export type StepLine = string | { note: string } | { code: string }

export const lineText = (l: StepLine): string =>
  typeof l === 'string' ? l : 'note' in l ? l.note : l.code

export interface ManualStep {
  id: string
  title: string
  /** Why it matters — what breaks without it. */
  why: string
  /**
   * Deep link to where the work happens — the Cloudflare dashboard for
   * all but the fork step, which is on GitHub.
   */
  url?: string
  /**
   * The vendor's own documentation for this task, when there is a
   * canonical page for it — Cloudflare's, or GitHub's for the fork
   * step. The dashboard link says *where*; this says *what the thing
   * is*, which is what someone new to the platform actually needs.
   * Every URL here was checked to resolve.
   */
  docsUrl?: string
  steps: StepLine[]
  /**
   * How completion is established. `detected` means a later step will
   * find out and say so, which is worth stating so the operator is
   * not asked to self-certify something checkable.
   */
  verification: 'detected' | 'self'
  /** Only relevant if the operator wants this optional feature. */
  featureGate?: 'r2' | 'transcode'
}

export const MANUAL_STEPS: ManualStep[] = [
  {
    id: 'node',
    title: 'Install Node.js and npm',
    why:
      'Every command in this install starts with npm run, including ' +
      'the setup tool itself. Without Node you cannot run step one. It ' +
      'is listed here rather than in the prose above the checklist ' +
      'because someone working through numbered steps reads the ' +
      'numbered steps.',
    url: 'https://nodejs.org/en/download',
    docsUrl: 'https://github.com/zyra-project/terraviz/blob/main/docs/SELF_HOSTING.md#03-tools',
    steps: [
      `Install the LTS build from nodejs.org — this repo needs Node.js ${requiredNodeLabel()}. It carries npm with it.`,
      'Check what you have:',
      { code: 'node --version' },
      { note: 'Anything older than the version this repo requires and setup will stop with the number it found. You do not have to get this right up front — it is checked, not trusted.' },
      { note: 'Take an LTS release — 22 or 24 both work, and the download button gives you 24. One dependency ships precompiled binaries only for the Node majors current when it was published. On anything older or newer, npm install tries to compile it and stops on a missing C++ toolchain.' },
    ],
    verification: 'detected',
  },
  {
    id: 'git',
    title: 'Install git and Git LFS',
    why:
      'The next step clones your fork, and Cloudflare Pages builds ' +
      'from that remote. Downloading the repo as a zip gets you the ' +
      'code and no remote, which does not surface until Phase 5 has ' +
      'nothing to connect to. LFS belongs here for the opposite ' +
      'reason: a clone without it fails so quietly that nothing ' +
      'surfaces at all.',
    url: 'https://git-scm.com/install/',
    docsUrl: 'https://github.com/zyra-project/terraviz/blob/main/docs/SELF_HOSTING.md#03-tools',
    steps: [
      'Install git if you do not have it. macOS and most Linux ship with it.',
      { code: 'git --version' },
      'Turn on Git LFS in the same sitting. Git for Windows bundles it. On macOS and Linux it is a separate package — get it from git-lfs.com, or use brew install git-lfs or apt install git-lfs.',
      'Either way, run this once per machine:',
      { code: 'git lfs install' },
      { note: 'Seven of the images the globe renders are stored in LFS. Clone without it and you get small text files carrying .jpg names. Nothing reports it — the build passes, the deploy passes, and the globe comes up missing its stars.' },
      { note: 'You will also need a browser you can sign in to Cloudflare with — most of the steps below are dashboard clicking. On a headless machine, see the wrangler login note in the guide.' },
    ],
    // Not `detected`, though it looks like it should be. The tool
    // never runs git — it reads and writes files and calls wrangler —
    // so a check here would exist only to make this label true, and
    // would cost plan mode the property of running no commands at
    // all. Claiming detection we do not do is the inversion this
    // field exists to prevent, so: self.
    verification: 'self',
  },
  {
    id: 'fork',
    title: 'Fork the repository',
    why:
      'Everything here assumes your own copy. Phase 3 rewrites ' +
      'wrangler.toml with your resource IDs, Phase 5 points Pages at ' +
      'your remote, and the transcode workflow runs in your repo — none ' +
      'of which works against a repo you cannot push to. Cloning ' +
      'upstream directly fails late rather than early: it clones, it ' +
      'runs locally, and nothing complains until you have IDs to push ' +
      'and nowhere to push them.',
    url: 'https://github.com/zyra-project/terraviz/fork',
    docsUrl:
      'https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/fork-a-repo',
    steps: [
      'Press Create fork. Nothing on that page needs changing: the owner is you, the repository name stays terraviz, and "Copy the main branch only" stays ticked.',
      { note: 'main is the only branch a node needs, so leaving that box ticked is correct.' },
      'Open the Actions tab of your new fork and enable workflows.',
      { note: 'GitHub creates every fork with Actions turned off. Leave them off and the transcode and deploy workflows never run.' },
      'Write the result down as owner/repo. That is the W3 the interview asks you for.',
      'Clone your fork onto the machine you will install from. Everything after this runs inside that checkout.',
      { code: 'git clone https://github.com/{{W3}}.git\ncd terraviz\nnpm install' },
      { note: 'npm install is not optional and not just for contributors — it puts the tooling every later `npm run` command needs on your path. Skip it and the first one fails with something like \'tsx\' is not recognized.' },
      { note: 'Clone your fork, not zyra-project/terraviz. A clone of upstream runs fine and then has nowhere to push the resource IDs Phase 3 writes.' },
    ],
    verification: 'self',
  },
  {
    id: 'workers-paid',
    title: 'Enable Workers Paid ($5/month)',
    why:
      'Optional — every product this node binds has a Workers Free ' +
      'allocation, so a free-plan account installs and runs. What you buy ' +
      'is headroom. Workers AI stops at 10,000 Neurons a day, roughly 200 ' +
      'Orbit turns, and that ceiling cannot be raised without upgrading. ' +
      'It fails soft, which is worse than failing loudly: Orbit quietly ' +
      'degrades to its keyword engine mid-demo.',
    url: 'https://dash.cloudflare.com/?to=/:account/workers/plans',
    docsUrl: 'https://developers.cloudflare.com/workers/platform/pricing/',
    steps: [
      'Open Workers & Pages, go to Plans, and subscribe to Workers Paid.',
      { note: 'Billing is per account, not per project. One subscription covers every node you run on this account.' },
    ],
    verification: 'self',
  },
  {
    id: 'dns',
    title: 'Put your domain on Cloudflare DNS',
    why:
      'Pages provisions the certificate and CNAME for your custom domain, ' +
      'and R2 can only serve a public bucket from a zone Cloudflare controls. ' +
      'Neither works on a domain hosted elsewhere.',
    url: 'https://dash.cloudflare.com/?to=/:account/add-site',
    docsUrl: 'https://developers.cloudflare.com/fundamentals/manage-domains/add-site/',
    steps: [
      'Add your domain to Cloudflare, then change its nameservers at your registrar to the two Cloudflare gives you.',
      { note: 'You do not need to transfer the registration. Cloudflare only needs to answer DNS for the domain.' },
      { note: 'The change usually takes minutes to take effect, occasionally a few hours.' },
    ],
    verification: 'detected',
  },
  {
    id: 'api-token',
    title: 'Mint a Cloudflare API token',
    why: 'Everything this tool does runs through it.',
    url: 'https://dash.cloudflare.com/profile/api-tokens',
    docsUrl: 'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/',
    steps: [
      'Go to My Profile, then API Tokens, then Create Token, and choose Custom token.',
      'Add these five first. Every node needs them, because Phase 2 creates all five resources.',
      {
        code: [
          'Account → Cloudflare Pages           Edit   the project and its bindings',
          'Account → D1                         Edit   creates the database, runs migrations',
          'Account → Workers KV Storage         Edit   creates both KV namespaces',
          'Account → Workers R2 Storage         Edit   creates the assets bucket',
          'Account → Vectorize                  Edit   creates the search index',
        ].join('\n'),
      },
      'Add these three for a publisher node. A viewer node never calls Access, so skip them.',
      {
        code: [
          'Account → Access: Apps and Policies  Edit   the publisher application',
          'Account → Access: Service Tokens     Edit   the CLI credential',
          'Account → Access: Organizations      Read   discovers your team domain',
        ].join('\n'),
      },
      'Add these two only if you intend to run the step named beside each one.',
      {
        code: [
          'Zone    → Zone                       Read   --only=r2 and --only=waf',
          'Zone    → Zone WAF                   Edit   --only=waf',
        ].join('\n'),
      },
      {
        note: 'These two are the ones people cannot find. Each permission row has three dropdowns, and the first one — the scope — starts on Account. Zone permissions are not in the Account list at all. Change that first dropdown to Zone and the middle one refills with `Zone`, `Zone WAF` and the rest.',
      },
      {
        note: 'A zone-scoped row also needs the Zone Resources section below Permissions. Leave it unset and the token carries the permission but reaches no zone. Include the zone your node runs on, or every zone in the account.',
      },
      {
        note: 'Both names above are current. If some other permission is missing from the list, `GET /user/tokens/permission_groups` returns every one with its scope.',
      },
      'Copy the token when it is shown and put it in your shell, where the setup tool will find it.',
      { code: 'export CLOUDFLARE_API_TOKEN=...' },
      { note: 'Cloudflare shows the token once. If you lose it, revoke it and mint another.' },
      {
        note: 'That export also outranks wrangler login. Wrangler prefers the token over your browser session, so Phases 2 and 4 run with these scopes rather than your own account access. A token holding only the Pages permission gets through the Pages step and then fails on D1, KV or Vectorize.',
      },
    ],
    verification: 'detected',
  },
  {
    id: 'analytics-engine',
    title: 'Turn on Analytics Engine',
    why:
      'It is off until someone opens it once, and the Pages deploy then ' +
      'fails outright rather than degrading: "Failed to publish your ' +
      'Function. You need to enable Analytics Engine." Nothing earlier ' +
      'in the install touches it. So the first sign is a deploy that ' +
      'will not publish, long after the binding was set, reading like a ' +
      'fault in the code rather than an account setting.',
    url: 'https://dash.cloudflare.com/?to=/:account/workers/analytics-engine',
    docsUrl: 'https://developers.cloudflare.com/analytics/analytics-engine/get-started/',
    steps: [
      'Open Workers & Pages, then Analytics Engine, and create a dataset.',
      'Give it these two values. They are the ones Phase 8 binds, and the names have to match.',
      {
        code: ['Dataset Name     terraviz_events', 'Dataset Binding  ANALYTICS'].join('\n'),
      },
      {
        note: 'The dialog asks for both. `terraviz_events` is what the Grafana dashboards and the export pipeline read; `ANALYTICS` is what `functions/api/ingest.ts` writes through.',
      },
      {
        note: 'Creating the dataset here is not what makes it real — a dataset appears on first write either way. What this does is enable the product on your account, which is the part the deploy checks for.',
      },
    ],
    // `self`, though the deploy does fail loudly if you skip it. The
    // badge means "this tool will notice", and this tool never
    // deploys — Cloudflare does, minutes later, in a different
    // window. Claiming detection we do not do is the inversion this
    // field exists to prevent.
    verification: 'self',
  },
  {
    id: 'zero-trust',
    title: 'Complete Zero Trust onboarding',
    why:
      'The Access application that gates the publisher API cannot exist ' +
      'until the account has a Zero Trust organization and at least one ' +
      'identity provider. Without it every /api/v1/publish/** route 503s.',
    url: 'https://one.dash.cloudflare.com/',
    docsUrl: 'https://developers.cloudflare.com/cloudflare-one/setup/',
    steps: [
      'Pick a team name when Cloudflare asks for one. It becomes your team domain, and you will need that later as W12.',
      { code: '<team>.cloudflareaccess.com' },
      'Go to Settings, then Authentication, and add at least one login method.',
      { note: 'One-time PIN emails a code and needs no identity provider, so it is the quickest way to get working. Google, Okta or Entra are better once real staff are signing in.' },
      { note: 'The free Zero Trust plan covers up to 50 users, which is more than most nodes need.' },
    ],
    verification: 'detected',
  },
  {
    id: 'node-key',
    title: 'Generate the node keypair',
    why:
      'Signs your node federation responses and is advertised at ' +
      '/.well-known/terraviz.json. The generator also writes ' +
      'node-public-key.txt, which `terraviz init-node` reads in Phase 9.',
    steps: [
      'Run the generator from your checkout.',
      { code: 'npm run gen:node-key' },
      { note: 'It writes NODE_ID_PRIVATE_KEY_PEM into .dev.vars, readable only by you, and node-public-key.txt beside it.' },
      { note: 'Back that file up. Generating a second key gives your node a new identity, which means re-provisioning it everywhere.' },
    ],
    verification: 'detected',
  },
  {
    id: 'git-connect',
    title: 'Connect the Pages project to your Git remote (or skip it)',
    why:
      'The Cloudflare↔GitHub handshake is an OAuth flow with no API, so ' +
      'this tool creates a Direct Upload project. Cloudflare will not run ' +
      'your build until you connect a remote, which means the VITE_* build ' +
      'variables have to be set wherever the build actually happens.',
    url: 'https://dash.cloudflare.com/?to=/:account/workers-and-pages',
    docsUrl: 'https://developers.cloudflare.com/pages/configuration/git-integration/',
    steps: [
      {
        note: 'Both options below happen in the Cloudflare dashboard, not on GitHub. Cloudflare asks GitHub for access partway through the first one; you never start from the GitHub side.',
      },
      {
        note: '`VITE_*` is a naming convention, not a product. Vite is the bundler that builds this app, and it copies variables with that prefix into the JavaScript it emits. That is why they belong wherever the build runs — by the time a visitor loads the page, the values are already inside the file being served.',
      },
      {
        note: 'None of them is required — the build succeeds with all of them unset, so this is tuning rather than a gate. §5.2 of the guide lists them with their values. `VITE_API_ORIGIN` is the one most likely to be wanted later: desktop builds and deep-link host recognition read it. The Earth textures need no variable at all — they ship in your own build.',
      },
      'Option A — let Cloudflare build. In Workers & Pages, open your project, then Settings, then Builds, then Connect to Git.',
      {
        note: 'Set the `VITE_*` variables in the dashboard afterwards, under the same Settings tab. Cloudflare rebuilds on every push to your default branch.',
      },
      'Option B — keep Direct Upload and build in CI. Set the `VITE_*` variables in the CI job instead, then deploy the finished directory.',
      { code: 'wrangler pages deploy dist/ --project-name <your-project>' },
      {
        note: '`npm run setup` already made you a Direct Upload project, so B is keeping what you have and A is converting it. Take A if you want a push to deploy itself and would rather not maintain a workflow — that is most nodes. Take B if you want deploys gated on the tests your fork already runs, or would rather not grant Cloudflare access to the repository.',
      },
      {
        note: 'Cloudflare moves this menu occasionally. If Builds is not where this says, look for Git repository or Connect to Git anywhere in the project settings — the wording changes, the capability does not.',
      },
    ],
    verification: 'detected',
  },
  {
    id: 'r2-token',
    title: 'Mint the R2 S3 API token',
    why:
      'Server-side presigned uploads and digest verification need S3-API ' +
      'credentials. Automating this would require a token that can create ' +
      'tokens — a credential that could grant itself more authority — so it ' +
      'stays a deliberate manual step.',
    url: 'https://dash.cloudflare.com/?to=/:account/r2/api-tokens',
    docsUrl: 'https://developers.cloudflare.com/r2/api/tokens/',
    steps: [
      'Go to R2, then Manage R2 API Tokens, then Create API token.',
      'Give it Object Read & Write, scoped to your assets bucket rather than the whole account.',
      'Copy all three values before you leave the page and put them in your shell.',
      {
        code: [
          'export R2_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com',
          'export R2_ACCESS_KEY_ID=...',
          'export R2_SECRET_ACCESS_KEY=...',
        ].join('\n'),
      },
      { note: 'The secret is shown once. If you lose it, delete the token and make another.' },
      'Re-run setup. The bindings step reads all three from your shell.',
    ],
    verification: 'self',
    featureGate: 'r2',
  },
]

export function renderManualStep(step: ManualStep, index?: number): string {
  const heading = index === undefined ? step.title : `${index}. ${step.title}`
  const lines = [heading, '']
  const why = wrap(step.why, 66)
  lines.push(`   Why: ${why[0] ?? ''}`)
  for (const line of why.slice(1)) lines.push(`        ${line}`)
  lines.push('')
  // "Where" rather than "Dashboard": six of these land in Cloudflare's
  // dashboard, but forking happens on GitHub, and a label that names
  // the wrong product is a small lie in the one place someone new is
  // trusting the output.
  if (step.url) lines.push(`   Where: ${step.url}`)
  if (step.docsUrl) lines.push(`   Docs:  ${step.docsUrl}`)
  if (step.url || step.docsUrl) lines.push('')
  // Each surface wraps to its own width. The data carries whole
  // thoughts, so the terminal is free to break them at 66 columns and
  // the web card at whatever the reader's viewport allows.
  // `{{W3}}` is a live substitution slot on the web console. The
  // terminal has no worksheet to read, so it falls back to the
  // guide's own placeholder convention — `<W3>` — rather than
  // printing braces at someone.
  const slots = (t: string): string => t.replace(/\{\{(\w+)\}\}/g, '<$1>')
  for (const raw of step.steps) {
    const line = typeof raw === 'string' ? slots(raw) : raw
    if (typeof line === 'string') {
      const body = wrap(line, 62)
      lines.push(`   - ${body[0] ?? ''}`)
      for (const rest of body.slice(1)) lines.push(`     ${rest}`)
    } else if ('note' in line) {
      for (const rest of wrap(slots(line.note), 62)) lines.push(`     ${rest}`)
    } else {
      // A literal: a command, or a table whose columns carry meaning.
      for (const rest of slots(line.code).split('\n')) lines.push(`       ${rest}`)
    }
  }
  lines.push('')
  lines.push(
    step.verification === 'detected'
      ? '   (setup detects whether this is done — no need to confirm)'
      : '   (setup cannot check this one; it is on you)',
  )
  return lines.join('\n')
}

export function renderManualSteps(features: Set<'r2' | 'transcode'> = new Set()): string {
  const steps = MANUAL_STEPS.filter(s => !s.featureGate || features.has(s.featureGate))
  const out = [
    'Manual prerequisites — the parts no API can do for you.',
    '',
    'Before you start: have somewhere to put secrets. Four of the',
    'values below are shown exactly once, by three different vendors,',
    'and none can be read back — the only recovery is to revoke and',
    'mint again. A password manager is enough.',
    '',
  ]
  steps.forEach((step, i) => {
    out.push(renderManualStep(step, i + 1))
    out.push('')
  })
  return out.join('\n')
}
