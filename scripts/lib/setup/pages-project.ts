// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Pages project + custom domain — `SELF_HOSTING.md` Phase 5.
 *
 * ## The one thing that genuinely cannot be automated
 *
 * Connecting a Pages project to a Git remote is an **OAuth handshake**
 * between Cloudflare and GitHub/GitLab, performed in the dashboard.
 * There is no API for it, and there is no way around it: a token
 * cannot grant Cloudflare access to your repositories on your behalf.
 *
 * So a project this module creates is a **Direct Upload** project.
 * That is a supported, first-class deploy model — you build in CI and
 * `wrangler pages deploy dist/` — and it is the path Phase 5.3
 * already describes as the alternative. The consequence worth being
 * loud about: with Direct Upload, **Cloudflare never runs your
 * build**, so `build_config` and the `VITE_*` build variables have no
 * effect on the deploy. They must be present in the CI job that runs
 * `npm run build`.
 *
 * We still set `build_config` on creation. It costs one field, and it
 * is exactly right the moment an operator connects Git in the
 * dashboard afterwards — which converts the project in place.
 *
 * ## Custom domains
 *
 * `POST …/domains` attaches the hostname and nothing more. The
 * dashboard's Set up a custom domain flow also creates the CNAME, but
 * the API call does not, even on a zone that is on Cloudflare DNS: a
 * fresh install sat at `pending` with "CNAME record not set" until an
 * operator added the record by hand. This step still makes no DNS
 * call, because doing so needs Zone → DNS → Edit, and the token the
 * guide prescribes is already at Cloudflare's 10-permission cap. It
 * prints the exact record instead (`cnameInstruction`), whenever the
 * domain is not yet `active`.
 */

import { CfApi, isAuthError, type CfError } from './cf-request'

export function explainPagesPermissions(errors: CfError[]): string | null {
  if (!isAuthError(errors)) return null
  return 'The API token needs Account → Cloudflare Pages → Edit.'
}

export interface PagesProject {
  name: string
  subdomain?: string
  production_branch?: string
  /** Present when the project is connected to a Git remote. */
  source?: { type?: string } | null
}

export interface PagesDomain {
  name: string
  status?: string
}

export interface BuildConfig {
  build_command: string
  destination_dir: string
  root_dir: string
}

/** Matches the build settings Phase 5.2 prescribes. */
export const DEFAULT_BUILD_CONFIG: BuildConfig = {
  build_command: 'npm run build',
  destination_dir: 'dist',
  root_dir: '',
}

export interface CreateProjectBody {
  name: string
  production_branch: string
  build_config: BuildConfig
}

export function buildProjectBody(
  name: string,
  productionBranch = 'main',
  buildConfig: BuildConfig = DEFAULT_BUILD_CONFIG,
): CreateProjectBody {
  if (!name) throw new Error('buildProjectBody: a project name is required')
  return { name, production_branch: productionBranch, build_config: buildConfig }
}

export class PagesProjectApi {
  private readonly api: CfApi

  constructor(
    private readonly accountId: string,
    opts: { apiToken: string; fetchImpl?: typeof fetch; apiBase?: string },
  ) {
    this.api = new CfApi({ ...opts, explain: explainPagesPermissions })
  }

  /** Null when the project does not exist. */
  getProject(name: string): Promise<PagesProject | null> {
    return this.api.request<PagesProject>(
      `/accounts/${this.accountId}/pages/projects/${encodeURIComponent(name)}`,
      { allowMissing: true },
    )
  }

  createProject(body: CreateProjectBody): Promise<PagesProject> {
    return this.api.post<PagesProject>(`/accounts/${this.accountId}/pages/projects`, body)
  }

  listDomains(project: string): Promise<PagesDomain[]> {
    return this.api.requireResult<PagesDomain[]>(
      `/accounts/${this.accountId}/pages/projects/${encodeURIComponent(project)}/domains`,
    )
  }

  addDomain(project: string, name: string): Promise<PagesDomain> {
    return this.api.post<PagesDomain>(
      `/accounts/${this.accountId}/pages/projects/${encodeURIComponent(project)}/domains`,
      { name },
    )
  }
}

export interface EnsureProjectResult {
  project: PagesProject
  created: boolean
  /**
   * True when the project builds from a connected Git remote. False
   * means Direct Upload, and the caller should say so — it changes
   * where the `VITE_*` build variables have to live.
   */
  gitConnected: boolean
}

export async function ensurePagesProject(
  api: PagesProjectApi,
  opts: { name: string; productionBranch?: string },
): Promise<EnsureProjectResult> {
  const existing = await api.getProject(opts.name)
  if (existing) {
    return {
      project: existing,
      created: false,
      gitConnected: Boolean(existing.source?.type),
    }
  }
  const project = await api.createProject(
    buildProjectBody(opts.name, opts.productionBranch ?? 'main'),
  )
  // Freshly created via the API is always Direct Upload — the Git
  // handshake has no API.
  return { project, created: true, gitConnected: false }
}

export interface EnsureDomainResult {
  name: string
  created: boolean
  status?: string
}

/**
 * The DNS record a custom domain needs, as lines to print, or `null`
 * once the domain is `active`. The target is the project's own
 * `*.pages.dev` hostname as the API reports it, because Cloudflare
 * suffixes the subdomain when the name is already taken on
 * `pages.dev`. When the API leaves it out, the name-based guess is
 * printed with a warning that it is one.
 *
 * Pending (and initializing) is also the state while certificates
 * issue, so the wording allows for a record that already exists. Any
 * other status that is not active (`blocked`, `deactivated`, `error`)
 * may have a cause a record will not fix, so it is named rather than
 * explained away.
 */
export function cnameInstruction(
  domain: EnsureDomainResult,
  project: Pick<PagesProject, 'name' | 'subdomain'>,
): string[] | null {
  if (domain.status === 'active') return null
  const target = project.subdomain || `${project.name}.pages.dev`
  const lines = [
    'Attaching a domain through the API does not create its DNS record.',
    'If the zone does not have it yet, add this record (proxied, on Cloudflare DNS):',
    `  ${domain.name}  CNAME  ${target}`,
  ]
  if (!project.subdomain) {
    lines.push(
      "The API did not report the project's pages.dev hostname, so that one is a guess.",
      "Check it on the project's overview page: Cloudflare adds a suffix when the name is taken.",
    )
  }
  const status = domain.status
  if (!status || status === 'pending' || status === 'initializing') {
    lines.push('The domain stays pending until the record exists.')
  } else {
    lines.push(
      `Its status is "${status}", which a missing record may not explain; ` +
        "the project's Custom domains page says why.",
    )
  }
  return lines
}

export async function ensureCustomDomain(
  api: PagesProjectApi,
  project: string,
  hostname: string,
): Promise<EnsureDomainResult> {
  const bare = hostname.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  const existing = (await api.listDomains(project)).find(d => d.name === bare)
  if (existing) return { name: bare, created: false, status: existing.status }
  const domain = await api.addDomain(project, bare)
  return { name: bare, created: true, status: domain.status }
}
