# Canonical Repository Transition

> **Status: draft for review.** Nothing has been transferred, deleted, or
> reconfigured. This document proposes the terms and the sequence. It is not an
> agreement until the sign-off block at the end is filled in.
>
> **Last reviewed:** 2026-09-04
> **Revisit when:** any phase completes, GSL ITS answers the T0 questions, or
> 90 days pass without movement.
>
> **Where this lives.** Repository root, alongside
> [`GOVERNANCE.md`](GOVERNANCE.md), until the transition completes. Unlike
> `GOVERNANCE.md` and `MAINTAINERS.md`, which are permanent, this document
> describes a one-time operation and should not outlive it. T4 retires it. The
> git history keeps it, and any permalink into a specific commit keeps
> resolving after the move.

---

## What changes

`NOAA-GSL/terraviz` becomes the canonical repository for TerraViz. Development,
issues, review, and releases move there. `zyra-project/terraviz` becomes a
genuine GitHub fork of it, in the same relationship every other node operator's
fork has.

That is the whole change. Everything below is the conditions under which it
happens and the things that must not change with it.

## What does not change

- **The license.** Apache-2.0, unchanged. Contributions made by federal
  employees in the course of official duties are US Government works under
  17 U.S.C. § 105 and are not subject to domestic copyright. This is already
  stated in [`CONTRIBUTING.md`](CONTRIBUTING.md) and is not altered by the
  transfer.
- **Attribution.** `CITATION.cff`, the Zenodo concept DOI, and the author list
  travel with the repository. A transfer does not touch them.
- **The contribution path.** DCO sign-off (`git commit -s`), no CLA, outside
  pull requests accepted. See [`GOVERNANCE.md`](GOVERNANCE.md).
- **Node autonomy.** Nodes remain self-contained. A node operator's fork keeps
  its own catalog, its own D1, its own R2, and its own `node_identity`. The
  canonical repo's location has no bearing on data sovereignty. See
  [`docs/federation-scoping.md`](docs/federation-scoping.md).

## Why now

Three reasons, in the order that matters to the agency.

**Compliance.** The SHARE IT Act (P.L. 118-187, enacted 2024-12-23) directs
that custom-developed code, including code developed by federal employees as
part of their official duties, be shared across government in a public or
private repository, with a published inventory of custom-developed code.

The statute does not specify which organization must host canonical
development. A public Apache-2.0 repository, an agency-controlled copy, and a
`code.json` entry in NOAA's inventory is a defensible reading of compliance as
it stands. **So the statute does not decide this question in either
direction**, and it should not be cited as though it does. What would decide it
is DOC's implementing CIO policy, which has not been read for this document.
See open question 7.

**Provenance.** An institution evaluating TerraViz for adoption asks where the
code came from and who can assert rights over it. A NOAA-owned repository under
Apache-2.0 answers that in one sentence. The current arrangement requires a
paragraph and a caveat, and that paragraph is a real drag on the second-node
conversation.

**Continuity.** TerraViz has one maintainer. That is the project's largest
single risk and it is not solved by this transition, but the transition is a
precondition for solving it. A NOAA repository with an unfilled maintainer slot
is a staffing gap the lab can be asked to fill.

## Non-goals

This transition does **not**:

- Change who decides the technical direction of TerraViz. See
  [`GOVERNANCE.md`](GOVERNANCE.md).
- Make TerraViz a NOAA-only project or restrict non-federal contribution.
- Change the federation design, the node tiers, or any published API contract.
- Route ordinary code changes through a ticket queue, or add approval steps
  disconnected from a change's actual risk. Review discipline itself **is** in
  scope and needs strengthening; see open question 7. Ceremonial gates are the
  non-goal, not review.
- Move Zyra, Zyra Editor, Depot Explorer, or the WordPress plugin. Those are
  separate decisions and are out of scope here.

---

## The nine conditions

Each is stated as something verifiable. "Promised" is not "verified." The
pre-cutover checklist in Phase T2 is where each gets checked.

### 1. Governance and merge authority, in-repo

`GOVERNANCE.md` and `MAINTAINERS.md` land in `NOAA-GSL/terraviz` **before**
the transfer, naming the technical lead and the merge authority.

*Verified by:* both files present on `main` with a signed-off commit, reviewed
by ______________________.

### 2. CI and Actions parity, tested not promised

Every workflow that runs today runs after cutover. The load-bearing ones:
`transcode-hls.yml`, `zyra-scheduler.yml`, `zyra-run.yml`, `zyra-spike.yml`,
and the token that drives `repository_dispatch`.

Known constraints to confirm with GSL ITS before anything moves:

| Question | Answer |
|---|---|
| Is the org Actions policy an allowlist? Which third-party actions are permitted? | |
| Are `actions/checkout@v4` and `actions/setup-node@v4` permitted? | |
| Can the repo hold a fine-grained PAT or App token for `repository_dispatch` (Contents: Read and write)? | |
| Can the repo pull from `ghcr.io/noaa-gsl/*`? | |
| Are self-hosted runners required, or is `ubuntu-22.04` available? | |
| Can Cloudflare Pages/Access secrets live in repo or environment secrets? | |
| Is Dependabot / secret scanning / code scanning mandatory, and does any of it block merges? | |

*Verified by:* a full green run of the four workflows above against a
scratch repo in `NOAA-GSL`, before transfer. Not a promise, a run.

### 3. External contributor pathway preserved

Outside pull requests accepted. DCO sign-off, no CLA. Non-federal contributors
can be granted triage or write access on the same terms as anyone else.

**On GitHub licensing, so the question gets asked correctly.** "Do external
users need a license?" invites a reflexive yes that would be wrong for this
case. There are three distinct access levels and they have different answers:

| Access level | Org relationship | Consumes a seat? |
|---|---|---|
| Fork the repo, open a pull request | None at all | **No.** No invitation, no membership, nothing. This is how nearly all outside contribution happens. |
| Outside collaborator with triage or write on a **public** repo | Invited to the repo, not the org | **No.** GitHub's license reference lists this explicitly under people who do not consume a license. |
| Full organization member | Member of `NOAA-GSL` | **Yes.** |

Outside collaborators on **private or internal** repositories do consume a
seat. Since `NOAA-GSL/terraviz` is public, that case does not arise. Under
Enterprise Managed Users the role is named "repository collaborator" rather
than "outside collaborator," and the public-repo exemption still applies.

So the licensing objection, if it comes, is answerable. What is genuinely
unknown is org policy, which is a separate constraint from billing.

Questions for GSL ITS:

| Question | Answer |
|---|---|
| Is the enterprise on Enterprise Managed Users (EMU)? | |
| Does org policy permit inviting outside collaborators to public repos at all, independent of licensing? | |
| If yes, what is the approval process and turnaround? | |
| Are third-party GitHub Apps permitted org-wide? The DCO sign-off check is one. | |
| Any restriction on contributions from foreign nationals or non-US accounts? | |

One point worth making preemptively, because it is the security objection that
usually follows: pull requests opened **from a fork never receive repository
secrets**. Fork-PR CI runs are compile-only by design. Accepting outside pull
requests does not expose credentials, and no policy exception is needed to
allow them.

*Verified by:* one outside PR from a non-NOAA account merged before cutover is
declared complete, or a written statement of the approval process and its SLA.

### 4. Attribution unchanged

`CITATION.cff`, the Zenodo concept DOI, the `NOTICE` file, and the author list
carry over untouched. Zenodo's GitHub integration re-points at the new
repository path.

*Verified by:* `CITATION.cff` diff is empty; the concept DOI resolves; the next
tagged release deposits correctly.

### 5. `zyra-project/terraviz` continues as the community fork

A genuine GitHub fork of `NOAA-GSL/terraviz`, created after the transfer, so
cross-fork pull requests, review threads, and DCO sign-off all work natively.
Not a mirror, not a relay, not a synced shell.

**On the label.** "Community edition" is the working name and it carries
baggage worth deciding about deliberately. In common usage (MySQL, GitLab) a
community edition is the *feature-reduced* half of a two-tier product. **Today
there are no significant differences between the two**, so the term would
describe a distinction that does not exist. "Community fork" says the same
thing without implying one.

The term worth watching is "hardened." If NOAA-GSL comes to be described as the
hardened build, the community fork is by implication the unhardened one, which
is both untrue today and the wrong direction to allow. Hardening belongs
upstream in the canonical repository where every node gets it. See
[`GOVERNANCE.md`](GOVERNANCE.md) §Divergence, which states the policy while the
answer is still "no differences." That is cheaper to write now than to
negotiate after the first government-specific requirement lands.

**Explicit anti-pattern.** Do not reproduce the `zyra-project/zyra` sync
arrangement. It splits discussion across two issue trackers with comments that
do not sync, silently drops issues past the 100 most recently updated, and
depends on a personal access token with push rights into a federal org held in
an outside org's secrets. That last item alone will not survive a security
review and should not.

**One tracker.** Issues and pull requests belong upstream. The community fork
sets `blank_issues_enabled: false` in `.github/ISSUE_TEMPLATE/config.yml` with
a redirect to `NOAA-GSL/terraviz`. Five lines, no bot.

**Separate infrastructure and separate billing.** The community fork's
deployment is not a GSL expense and should not move onto GSL billing. GSL pays
for the GSL node. That separation is the federated cost model working as
designed, not a gap to be closed.

*Verified by:* `zyra-project/terraviz` shows "forked from NOAA-GSL/terraviz";
its default branch holds the source tree; a test pull request from the fork to
upstream opens natively.

### 6. Who holds the "TerraViz" name

______________________________________________

*This is deliberately blank. Nobody has answered it. The federation scoping doc
contemplates a `TRADEMARK_POLICY.md` "drafted by Zyra leadership" without
establishing who that is. It needs an answer before, not after.*

### 7. No archiving or visibility change without notice, and a documented exit

The repository is not archived, made private, or deleted without written notice
to the maintainers. Notice period: ______ days.

"Handoff" is defined in [`GOVERNANCE.md`](GOVERNANCE.md) §Transferring canonical
status rather than here, so there is one definition rather than two. That
section carries the inventory of what canonical status consists of, who decides
a transfer, and a dormancy backstop for the case where the host has stopped
participating rather than actively handing off.

This is worth stating plainly to the receiving organization: a documented exit
is a service to the host, not a hedge against it. If other institutions adopt
TerraViz and the host later cannot fund it, the host does not want to be the
organization that ended a platform others depend on.

*Verified by:* `GOVERNANCE.md` §Transferring canonical status present on `main`,
and acknowledged in the sign-off block below.

### 8. The GSL node embeds correctly in the GSL WordPress site

This is a cutover gate rather than a follow-up, because the embed is the
GSL-visible deliverable and it depends on edge configuration that does not
travel with the code.

The specific hazard: the repository ships no Content-Security-Policy. Upstream
enforces its policy at the Cloudflare edge through Transform Rules, and **edge
rules do not travel with a fork or a redeploy**. A node standing up at a new
path inherits none of it, including `frame-ancestors`. Without a policy that
names the GSL WordPress origin, every block renders its server-side fallback
and the globe never loads. It fails quietly, which is why it needs to be a
checked box rather than an assumption.

**Direct collision with ITS Decision 1.** If the GSL node is placed behind
Cloudflare Access, the iframe renders an SSO interstitial instead of the globe.
"Restrict to NOAA-internal access" and "embed in the GSL website" cannot both
be true. That trade-off should be surfaced before the audience decision is
made, not discovered afterward.

**Plugin configuration.** The plugin's node origin setting defaults to the
canonical node. A GSL install left on the default embeds *upstream*, not GSL.
The `Settings → Terraviz` origin must be pointed at the GSL node explicitly,
and the plugin's own default should follow canonical when it moves.

*Verified by:* a real page on the GSL WordPress site rendering `Dataset`,
`Tour`, and `Catalog` blocks against the NOAA-GSL-deployed node, with the
fullscreen toggle working and no console errors.

### 9. Separate test and production environments

Two GSL environments, both standing before cutover is declared complete:

| Environment | Branch | Hostname | Access |
|---|---|---|---|
| Test | `staging` | `terraviz.test.gsl.noaa.gov` (existing) | Internal, behind Cloudflare Access |
| Production | `main` | `terraviz.gsl.noaa.gov` (proposed) | Public |

This is a cutover gate rather than a follow-up because retrofitting
environment separation onto a live public node means downtime and a data
migration. The promotion path has to exist before there is anything to promote.

**Resource isolation is the load-bearing part.** Separate D1, R2, KV, and
Vectorize per environment, not shared. If test and production share a D1, test
publishes land in the public catalog. Note that the two D1 bindings already
share one physical database named `sphere-feedback`, so this needs care:
select by binding name, and provision a distinct database per environment.

**Two environments are two nodes.** Each needs its own `node_identity`
provisioned by `terraviz init-node`, or test must be excluded from federation
entirely. Two hosts signing federation responses with the same Ed25519 key is
a correctness problem, not a cosmetic one.

**This interacts with condition 8.** If test is behind Access, the WordPress
embed cannot be validated there, for exactly the reason condition 8 describes.
Decide explicitly: either embed validation happens against production, or the
embed path is exempted from Access on test. Do not discover this during the
first embed attempt.

**Hostname shape.** Two options, and they are not equivalent:

| Option | What it takes | Trade-off |
|---|---|---|
| `terraviz.gsl.noaa.gov` | DNS record on the GSL zone, custom domain on the Pages project | Separate origin, which is how the app is built today. The WordPress embed needs `frame-ancestors`. **Recommended.** |
| `gsl.noaa.gov/terraviz` | Worker route or reverse proxy on the main GSL zone, plus base-path support in the app | Same origin as the WordPress site, so the embed needs no CSP work at all. But routes are served at `/dataset/…`, `/publish/…`, `/api/v1/…` today with no path prefix. Would need scoping before it can be committed to. |

**Implementation shape.** Either one Pages project using Production and Preview
environments, or two Pages projects. One project is less setup, but Preview
bindings apply to *every* preview deployment, so each PR preview would share
the test D1 with `staging`. If test is meant to be a stable pre-production
mirror, two projects is the cleaner answer.

*Verified by:* a commit to `staging` deploys to the test hostname and nowhere
else; a merge to `main` deploys to production and nowhere else; a write on test
does not appear in the production catalog.

---

## Mechanics and sequence

### This transition is the first run of the procedure it establishes

`GOVERNANCE.md` §Transferring canonical status describes how canonical status
moves between hosts. Moving from `zyra-project` to `NOAA-GSL` is the first
instance of it, so the inventory in that section is the checklist this plan has
to pass. Three rows are not currently covered by the phases below and need
owners before T4 closes:

| Inventory row | Status in this plan |
|---|---|
| Published contracts (`/schema/v1`, embed URL grammar, federation feed) | Served by whichever node is canonical. Not addressed. Decide whether these move with the repository or stay with the GSL node. |
| Default node origin compiled into the WordPress plugin and the CLI | Plugin defaults to "the canonical node." Not addressed. The default has to follow, or every fresh install points at the wrong place. |
| npm package names the CLI publishes under | Not addressed. If the scope changes, existing installs break; if it does not, a federal project publishes under a personal scope. |

The remaining rows are covered: git history, issue history, and release
artifacts by the transfer itself, the Zenodo deposit in T3, the name in open
question 6, and the documentation domain in T4.

### The fork-network problem

`NOAA-GSL/terraviz` is currently a fork of `zyra-project/terraviz`. GitHub has
no operation that inverts a fork relationship. A standalone repository cannot
be converted into a fork, and a network root with child forks attached cannot
leave its own network. So the direction has to be reversed structurally, not
by relabeling.

The mechanism is **repository transfer, then fork back out**. Transfer
preserves issues, pull requests, stars, watchers, and the wiki, sets up
redirects from the old URLs, and carries the existing fork network with it.
Forking back gives `zyra-project/terraviz` a genuine fork relationship, which
is what makes cross-fork pull requests, review threads, and DCO sign-off work
natively between the two.

The alternative considered and rejected was a history push into a recreated
repository. It preserves commits, tags, and authorship but loses the issue
history, the stars, the URL redirects, and the fork network, and it leaves the
two repositories in separate networks so cross-fork pull requests do not work.
Recorded here because the choice is not obvious and someone will ask.

> **Verify before executing:** transfer does not carry Actions secrets,
> environment secrets, deploy keys, or Pages configuration. Those get recreated
> by hand in T3. Confirm current GitHub behavior at transfer time rather than
> trusting this note.

> **One thing transfer does that a history push does not:** existing outside
> forks follow the network automatically, so their upstream silently becomes a
> repository inside a federal organization. Notify them before T3 rather than
> after. They may reasonably want to repoint at `zyra-project/terraviz` (the
> community fork) instead.

### Phases

| Phase | Work | Done when |
|---|---|---|
| **T0 — Clearances** | Ethics office consult on § 105 and outside-activity status. GSL ITS answers the §2 table. Name resolved (§6). DOC implementing policy read (open question 7). Outside forks notified. | All five answered in writing. |
| **T1 — Clear the collision** | Confirm `NOAA-GSL/terraviz` (last updated 2026-06-16) holds no unique commits. Archive a bare clone, then delete it to free the name for the transfer. | Bare clone stored at ______________; name available. |
| **T2 — Parity proof** | Scratch repo in `NOAA-GSL`. Run the four workflows green. | Checklist below all green. |
| **T3 — Transfer** | Transfer `zyra-project/terraviz` → `NOAA-GSL`. Recreate secrets, branch protections, CODEOWNERS, DCO check, Cloudflare deploy hooks. Land `GOVERNANCE.md` and `MAINTAINERS.md`. Re-point Zenodo. | `main` builds and deploys from the new path. |
| **T4 — Fork back and document** | Fork `NOAA-GSL/terraviz` → `zyra-project/terraviz` as the community fork. Issue redirect upstream. Update every doc, README badge, and `docs/SELF_HOSTING.md` reference. Walk the `GOVERNANCE.md` canonical-status inventory row by row. Retire this document: move it to `docs/history/` or delete it. | Community fork shows "forked from NOAA-GSL/terraviz"; no stale canonical references remain; every inventory row has an owner; this document no longer sits at the repository root. |

### Pre-cutover checklist (all must be green before T4)

- [ ] `transcode-hls.yml` green in `NOAA-GSL`
- [ ] `zyra-scheduler.yml` green in `NOAA-GSL`
- [ ] `zyra-run.yml` green in `NOAA-GSL`, including the GHCR pull
- [ ] `repository_dispatch` fires with the org-permitted token type
- [ ] `npm run type-check`, `check:i18n-strings`, and the binding/deploy checks pass
- [ ] Cloudflare Pages build succeeds from the new remote
- [ ] Bindings confirmed on **both** Production and Preview
- [ ] D1 selected by binding name, not by the shared `sphere-feedback` DB name
- [ ] Catalog migrations documented for the new path in `docs/SELF_HOSTING.md`
- [ ] `GOVERNANCE.md` and `MAINTAINERS.md` merged
- [ ] Bare clone of the old `NOAA-GSL/terraviz` archived
- [ ] Every outside fork enumerated and contacted before transfer
- [ ] Ownership of the published contracts (`/schema/v1`, embed grammar, feed) decided
- [ ] WordPress plugin and CLI default node origin repointed
- [ ] npm package scope for the CLI decided and documented
- [ ] This document retired from the repository root (see T4)
- [ ] `zyra-project/terraviz` re-forked from `NOAA-GSL/terraviz` and showing the fork relationship

**Environment gate (condition 9):**

- [ ] `staging` branch exists with branch protection; promotion path to `main` documented
- [ ] Test and production have **separate** D1, R2, KV, and Vectorize resources
- [ ] Bindings confirmed per environment, not shared
- [ ] Distinct `node_identity` per environment, or test excluded from federation
- [ ] `terraviz.gsl.noaa.gov` (or agreed production hostname) resolves and serves
- [ ] Cloudflare Access on test only; production unauthenticated
- [ ] A write on test is confirmed absent from the production catalog
- [ ] CI deploy job routes by ref: `staging` to test, `main` to production

**Embed gate (condition 8):**

- [ ] CSP set at the edge for the new deployment, with `frame-ancestors` naming the GSL WordPress origin
- [ ] No `X-Frame-Options: DENY` or `SAMEORIGIN` on the node from `_headers`, Cloudflare, or a NOAA security baseline
- [ ] Node **not** behind Cloudflare Access, or embed path explicitly exempted
- [ ] Node serves `/schema/v1/*.schema.json` (the plugin generates its PHP wire types from it)
- [ ] Embed URL grammar `v1` resolves at the new origin
- [ ] Plugin `Settings → Terraviz` node origin points at the GSL node, not the default canonical
- [ ] Plugin "test connection" probe passes from the GSL WordPress host
- [ ] GSL WordPress host egress reaches the node (blocks server-render their fallback from the public read API in PHP)
- [ ] `iframe allow="fullscreen"` present, fullscreen toggle appears and works
- [ ] `Dataset`, `Tour`, and `Catalog` blocks all render live on a real GSL page
- [ ] Plugin CI smoke test repointed from the old canonical node
- [ ] If publishing is enabled: R2 CORS allows the GSL WordPress origin (browser uploads directly to presigned URLs), and a service token is minted against the GSL node

### Rollback

Through T2, rollback is deleting the scratch repo. T3 is the commit point:
transfer redirects are one-way and re-transferring back would be a second
disruptive move. Do not start T3 until every box above is checked, the GSL node
deploys green from a scratch remote, and the outside forks have been notified.

---

## Open questions

1. Ethics office position on § 105 and on continued operation of the
   `zyra-project` org: ______________________
2. Does GSL ITS require a security review before the repo goes canonical, and
   what is its scope and duration? ______________________
3. Who is the second maintainer, and what is the funding path? ______________
4. Does the `terraviz.zyra-project.org` domain stay, move, or retire? ________
5. What happens to `zyra-project/zyra`'s relay arrangement, which has the same
   PAT exposure? ______________________
6. **How is AI-assisted code reviewed, and by whom?** Most changes are
   AI-assisted. Today the person who prompts the change is the person who
   approves it, which is self-approval with extra steps rather than review.
   This is the strongest present-tense argument for a second maintainer and it
   should be answered before cutover, not after. See
   [`GOVERNANCE.md`](GOVERNANCE.md) §Review of AI-assisted changes.
   ______________________
7. **What does DOC's implementing CIO policy for the SHARE IT Act and M-16-21
   actually require?** Specifically: does an agency-controlled mirror plus a
   `code.json` entry satisfy it, or does it require canonical development in an
   agency namespace? Peer agencies read the requirement as "stored in
   accessible repositories, public and private," which a mirror satisfies.
   Until DOC's policy is read, compliance is an open question and not a reason.
   ______________________

---

## Sign-off

| Role | Name | Date | Notes |
|---|---|---|---|
| Technical lead | Eric Hackathorn | | |
| GSL supervisor | | | |
| GSL ITS | | | |
| DOC/NOAA ethics | | | |

*This document is not an agreement until this block is complete. Conditions 1
through 9 are the terms; the phases are the sequence. If a condition cannot be
met, record why here rather than dropping it.*
