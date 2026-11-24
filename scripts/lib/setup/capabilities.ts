// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * What a node can do, and what each capability needs before it works.
 *
 * ## Why this exists
 *
 * The install used to be described by tier alone: a viewer node, a
 * publisher node, a publisher node with a desktop app. A tier says
 * what you get. It does not say what each part of it needs, and the
 * line that actually divides a publisher node is not the tier at all.
 * It is whether the operator can run GitHub Actions in a repository
 * they control. Video uploads, Zyra pipelines, the events and video
 * feeds and the analytics history all run there. A node deployed from
 * a clone of upstream with Direct Upload gets the publisher portal and
 * none of those, and nothing up front said so: video uploads answer
 * 503, and the rest fail silently (the feeds stop arriving, scheduled
 * runs never start, the analytics tab stays empty).
 *
 * So this module states, once, what each capability needs. Three
 * surfaces read it and must not disagree:
 *
 *   - `npm run setup -- --with=`: takes `SETUP_FEATURES`, and the
 *     handoff lists the workflows to turn on and what was left out.
 *   - `/setup`: the questionnaire `shell.ts` injects asks which
 *     capabilities the operator wants and whether they can run
 *     Actions, then shows the plan `planNode` returns.
 *   - `docs/SELF_HOSTING.md`: the capability table and Reference B.
 *     `capabilities.test.ts` fails when the guide stops naming a
 *     workflow listed here, or when a workflow file disappears.
 *
 * Pure data and pure functions: no I/O, no DOM.
 */

/** Optional features `npm run setup -- --with=` understands. */
export const SETUP_FEATURES = ['r2', 'transcode', 'zyra', 'feeds', 'analytics'] as const
export type SetupFeature = (typeof SETUP_FEATURES)[number]

export const isSetupFeature = (s: string): s is SetupFeature =>
  (SETUP_FEATURES as readonly string[]).includes(s)

/** What a capability can need beyond a deployed viewer node. */
export type Requirement =
  | 'backend'
  | 'r2-public'
  | 'github-actions'
  | 'scheduled-workflows'
  | 'analytics-bucket'
  | 'desktop-signing'

export interface RequirementInfo {
  label: string
  /** A few words, for a badge beside a capability. */
  short: string
  detail: string
  /** Where in `SELF_HOSTING.md` it is set up. */
  where: string
}

export const REQUIREMENTS: Record<Requirement, RequirementInfo> = {
  backend: {
    label: 'The publisher backend',
    short: 'Publisher backend',
    detail: 'D1, KV, Vectorize, Cloudflare Access and the node keys.',
    where: 'Phases 2–11',
  },
  'r2-public': {
    label: 'R2 public domain and S3 token',
    short: 'R2 public bucket',
    detail: 'A public hostname for the asset bucket, its CORS policy, and an S3 API token for uploads.',
    where: 'Phase 8.5',
  },
  'github-actions': {
    label: 'GitHub Actions in a repository you control',
    short: 'GitHub Actions',
    detail:
      'A fork, or your own copy, that you can push to, with Actions turned on and the ' +
      'workflow secrets set. A clone of upstream cannot run them.',
    where: 'Phases 0.2 and 8.6',
  },
  'scheduled-workflows': {
    label: 'Scheduled workflows turned on',
    short: 'Scheduled workflows',
    detail:
      'GitHub starts a fork with scheduled workflows off. Turn each one on in the ' +
      'Actions tab; until then it never runs, and nothing says so.',
    where: 'Reference B',
  },
  'analytics-bucket': {
    label: 'An analytics archive bucket and SQL token',
    short: 'Analytics bucket',
    detail: 'A second R2 bucket bound as ANALYTICS_R2, plus a read-only Analytics Engine SQL token.',
    where: 'Phase 14.2',
  },
  'desktop-signing': {
    label: 'Desktop signing keys',
    short: 'Signing keys',
    detail: 'A Tauri updater key pair, and Apple signing secrets if you notarize.',
    where: 'Phase 15',
  },
}

export interface Workflow {
  /** File name under `.github/workflows/`. */
  file: string
  /** What starts it. */
  trigger: 'dispatch' | 'schedule' | 'manual'
  /** Plain-language cadence or cause, for the plan and the handoff. */
  when: string
}

export type CapabilityId =
  | 'publish'
  | 'assets'
  | 'video'
  | 'zyra'
  | 'feeds'
  | 'analytics'
  | 'desktop'

export type NodeTier = 1 | 2 | 3

export interface Capability {
  id: CapabilityId
  /** The checkbox label: what the operator wants to do. */
  title: string
  /** What it gives them, in a sentence. */
  summary: string
  needs: Requirement[]
  /** Capabilities that come with it whether or not they were ticked. */
  implies: CapabilityId[]
  workflows: Workflow[]
  /** The `--with=` value that sets it up, when setup has one. */
  feature?: SetupFeature
  tier: NodeTier
  /** What happens on a node that has it switched on without Actions. */
  withoutActions?: string
  /** A way to get some of it by hand when Actions are not available. */
  byHand?: string
}

/** Every node has these, whatever else it does. */
export const BASELINE = 'The globe, the Science On a Sphere catalog and Orbit.'

export const CAPABILITIES: readonly Capability[] = [
  {
    id: 'publish',
    title: 'Publish your own datasets, tours and blog posts',
    summary:
      'The publisher portal: metadata, tours, the blog, semantic search and the events review queue.',
    needs: ['backend'],
    implies: [],
    workflows: [],
    tier: 2,
  },
  {
    id: 'assets',
    title: 'Upload images and other files',
    summary: 'Thumbnails, legends, still-image datasets and tour media, stored in your R2 bucket.',
    needs: ['backend', 'r2-public'],
    implies: ['publish'],
    workflows: [],
    feature: 'r2',
    tier: 2,
  },
  {
    id: 'video',
    title: 'Upload videos and image sequences',
    summary:
      'Publishers upload a video, or a sequence of frames, and the node turns it into adaptive HLS in your bucket.',
    needs: ['backend', 'r2-public', 'github-actions'],
    implies: ['publish', 'assets'],
    workflows: [
      { file: 'transcode-hls.yml', trigger: 'dispatch', when: 'on each video upload' },
    ],
    feature: 'transcode',
    tier: 2,
    withoutActions:
      'Finishing a video or image-sequence upload answers 503 github_dispatch_unconfigured. ' +
      'The uploaded files stay in R2.',
  },
  {
    id: 'zyra',
    title: 'Run scheduled data pipelines with Zyra',
    summary:
      'Fetch model output on a schedule and publish it as a dataset, with no one at the keyboard.',
    needs: ['backend', 'r2-public', 'github-actions', 'scheduled-workflows'],
    implies: ['publish', 'assets'],
    // A run publishes its video or frames through asset completion,
    // which hands them to the same transcode pipeline an upload uses.
    workflows: [
      { file: 'zyra-run.yml', trigger: 'dispatch', when: 'on each workflow run' },
      { file: 'zyra-scheduler.yml', trigger: 'schedule', when: 'every 15 minutes' },
      {
        file: 'transcode-hls.yml',
        trigger: 'dispatch',
        when: 'when a run publishes its video or frames',
      },
    ],
    feature: 'zyra',
    tier: 2,
    withoutActions:
      'Run now answers 503 dispatch_unconfigured and records a failed run, and scheduled runs never start.',
  },
  {
    id: 'feeds',
    title: 'Keep current events and video suggestions coming in',
    summary:
      'Poll your news and hazard feeds for events to pair with datasets, and index video sources for media suggestions.',
    needs: ['backend', 'github-actions', 'scheduled-workflows'],
    implies: ['publish'],
    workflows: [
      { file: 'import-events.yml', trigger: 'schedule', when: 'every 6 hours' },
      { file: 'refresh-video-sources.yml', trigger: 'schedule', when: 'every 12 hours' },
    ],
    feature: 'feeds',
    tier: 2,
    withoutActions:
      'Nothing refreshes on its own: new events never arrive and video sitemaps are never indexed, ' +
      'and nothing says so.',
    byHand:
      'On /publish/feeds, press Run all enabled feeds now (News feeds) and Index now (Media channels). ' +
      'Or schedule `npm run terraviz -- import-events --server=https://<your node>` yourself, with ' +
      '`TERRAVIZ_ACCESS_CLIENT_ID` and `TERRAVIZ_ACCESS_CLIENT_SECRET` set; without `--server` it ' +
      'reaches another node.',
  },
  {
    id: 'analytics',
    title: 'Keep visitor analytics history in the portal',
    summary:
      'A nightly export archives each day of telemetry and fills the portal’s analytics tab.',
    needs: ['backend', 'analytics-bucket', 'github-actions', 'scheduled-workflows'],
    implies: ['publish'],
    workflows: [
      { file: 'analytics-export.yml', trigger: 'schedule', when: 'daily, 00:25 UTC' },
      { file: 'analytics-backfill.yml', trigger: 'manual', when: 'once, by hand, at first setup' },
    ],
    feature: 'analytics',
    tier: 2,
    withoutActions:
      'The analytics tab stays empty: it reads rollups only the export writes, and a day ' +
      'Analytics Engine has dropped cannot be exported later.',
  },
  {
    id: 'desktop',
    title: 'Ship a branded desktop app',
    summary:
      'Signed Windows, macOS and Linux builds of your node, with an update feed you control.',
    needs: ['backend', 'github-actions', 'desktop-signing'],
    implies: ['publish'],
    workflows: [
      { file: 'release.yml', trigger: 'manual', when: 'when you cut a release' },
    ],
    tier: 3,
    withoutActions: 'No installers and no update feed: release.yml builds and signs them.',
  },
]

export const capabilityById = (id: CapabilityId): Capability => {
  const found = CAPABILITIES.find(c => c.id === id)
  if (!found) throw new Error(`unknown capability: ${id}`)
  return found
}

export const TIER_NAMES: Record<NodeTier, string> = {
  1: 'Viewer node',
  2: 'Publisher node',
  3: 'Publisher node + desktop app',
}

/** Can the operator run GitHub Actions in a repository they control? */
export type ActionsAnswer = 'yes' | 'no' | 'unsure'

export interface NodePlan {
  tier: NodeTier
  /** Ticked or implied, and achievable with the answer given. */
  have: Capability[]
  /** Ticked or implied, but needing Actions the operator said they lack. */
  blocked: Capability[]
  /** Needing Actions when the operator is not sure they have them. */
  atRisk: Capability[]
  /** What the plan has to set up, in install order. */
  requirements: Requirement[]
  /** Workflows to turn on in the repository, for `have` and `atRisk`. */
  workflows: Workflow[]
  /** The `--with=` features for `have` and `atRisk`. */
  features: SetupFeature[]
}

/** Install order: the order `REQUIREMENTS` declares them in. */
export const REQUIREMENT_ORDER = Object.keys(REQUIREMENTS) as Requirement[]

/**
 * What a node with these capabilities needs, given whether the
 * operator can run GitHub Actions.
 *
 * Implied capabilities are added (video brings asset uploads and the
 * portal with it). A capability needing Actions is `blocked` when the
 * answer is no and `atRisk` when it is unsure; blocked ones contribute
 * nothing to the requirements, workflows or features, so the plan only
 * asks for what will work. The tier is the highest a kept capability
 * needs, so a blocked desktop app leaves a publisher node (the portal
 * it implies needs no Actions) rather than claiming Tier 3.
 */
export function planNode(selected: readonly CapabilityId[], actions: ActionsAnswer): NodePlan {
  const wanted = new Set<CapabilityId>()
  const add = (id: CapabilityId): void => {
    if (wanted.has(id)) return
    wanted.add(id)
    for (const dep of capabilityById(id).implies) add(dep)
  }
  for (const id of selected) add(id)

  const plan: NodePlan = {
    tier: 1,
    have: [],
    blocked: [],
    atRisk: [],
    requirements: [],
    workflows: [],
    features: [],
  }
  const requirements = new Set<Requirement>()
  const features = new Set<SetupFeature>()
  for (const cap of CAPABILITIES) {
    if (!wanted.has(cap.id)) continue
    const needsActions = cap.needs.includes('github-actions')
    if (needsActions && actions === 'no') {
      plan.blocked.push(cap)
      continue
    }
    if (needsActions && actions === 'unsure') plan.atRisk.push(cap)
    else plan.have.push(cap)
    for (const r of cap.needs) requirements.add(r)
    for (const w of cap.workflows) {
      if (!plan.workflows.some(x => x.file === w.file)) plan.workflows.push(w)
    }
    if (cap.feature) features.add(cap.feature)
    if (cap.tier > plan.tier) plan.tier = cap.tier
  }
  plan.requirements = REQUIREMENT_ORDER.filter(r => requirements.has(r))
  plan.features = SETUP_FEATURES.filter(f => features.has(f))
  return plan
}

/** The `npm run setup` invocation for a set of features. */
export function setupCommand(features: readonly SetupFeature[]): string {
  return features.length === 0
    ? 'npm run setup -- --interactive'
    : `npm run setup -- --interactive --with=${features.join(',')}`
}

/**
 * The features a set of `--with=` values amounts to: everything the
 * capabilities behind them imply, through `planNode` so the closure is
 * computed once. Video and Zyra both publish into R2, so either brings
 * `r2`: asking for uploads without the public bucket they land in
 * would set up a node that accepts an upload and cannot show it.
 */
export function expandFeatures(features: Iterable<SetupFeature>): Set<SetupFeature> {
  const wanted = new Set(features)
  const ids = CAPABILITIES.filter(c => c.feature && wanted.has(c.feature)).map(c => c.id)
  return new Set([...wanted, ...planNode(ids, 'yes').features])
}

/** Capabilities a set of features sets up. */
export const capabilitiesForFeatures = (features: ReadonlySet<SetupFeature>): Capability[] =>
  CAPABILITIES.filter(c => c.feature && features.has(c.feature))
