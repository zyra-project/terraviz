# Governance

> **Status: draft for review.** Not yet adopted. This describes how TerraViz is
> intended to be governed once the canonical repository transition completes.
> See [`CANONICAL_TRANSITION.md`](CANONICAL_TRANSITION.md).
>
> **Last reviewed:** 2026-08-31
> **Revisit when:** a second maintainer joins, the first non-GSL node goes
> live, or 12 months pass.

TerraViz is developed in the open under Apache-2.0. This document says who
decides what, how those decisions get made, and what commitments the hosting
organization takes on. It is deliberately short. Governance documents that
describe a larger project than the one that exists are worse than none.

## Honest statement of current state

TerraViz has **one maintainer**. Everything below describes a structure built
for more than one, because the structure has to exist before the second person
can be recruited into it, not after. Until `MAINTAINERS.md` lists at least two
active people, read every "the maintainers decide" clause as "one person
decides, in public, with a written record."

That is a real risk and it is named here rather than papered over.

## Scope

This document governs `NOAA-GSL/terraviz`, the canonical repository. It does
not govern node operators' forks, which are independently owned and operated.
It does not govern Zyra, Zyra Editor, Depot Explorer, or the WordPress plugin,
which have their own repositories and their own arrangements.

## Roles

**Contributor.** Anyone who opens an issue or a pull request. No agreement to
sign beyond DCO sign-off on commits (`git commit -s`). No CLA. Federal and
non-federal contributors are treated identically. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).

**Maintainer.** Holds write access and merge authority. Reviews pull requests,
triages issues, and cuts releases. Listed in [`MAINTAINERS.md`](MAINTAINERS.md)
with an area of responsibility. Maintainers need not be NOAA employees.

**Technical lead.** One maintainer holds the tiebreaking vote on technical
direction and is responsible for the roadmap. Named in `MAINTAINERS.md`.

**Node operator.** Runs a TerraViz deployment. Not a governance role. Node
operators have no obligation to the canonical repository and the canonical
repository has no authority over their nodes. This separation is the point of
the federation design and is not negotiable.

## Decisions

**Ordinary changes** land by lazy consensus: a pull request with a maintainer
approval, green CI, and no unresolved objection. One maintainer's approval is
sufficient. Nobody merges their own change without a second approval once there
is a second maintainer to give one.

**Consequential changes** need explicit agreement from all active maintainers,
recorded in the pull request or an issue. A change is consequential if it does
any of the following:

- Alters a published API contract or the catalog schema in a
  backward-incompatible way
- Changes the license, the DCO requirement, or the contribution terms
- Adds a runtime framework or a heavy dependency
- Changes the analytics surface in any way. All eight privacy invariants must
  hold. See [`docs/ANALYTICS_CONTRIBUTING.md`](docs/ANALYTICS_CONTRIBUTING.md).
- Changes the federation tier definitions or the node identity model

**Disagreement** is resolved by discussion in the open. If discussion does not
converge, the technical lead decides and records the reasoning. A maintainer
who disagrees may record dissent in the same thread. There is no voting
mechanism because there is no body large enough to need one.

## Becoming and ceasing to be a maintainer

A contributor becomes a maintainer by invitation from the existing maintainers,
based on sustained review-quality contribution. There is no commit-count
threshold. The invitation and the acceptance are recorded in a pull request
that edits `MAINTAINERS.md`.

A maintainer becomes emeritus by resigning, or after twelve months without
review or merge activity. Emeritus status is recorded, not deleted. Removal
for cause requires agreement from all other active maintainers and a written
reason in the `MAINTAINERS.md` commit.

**If the technical lead's employment changes**, the role does not lapse.
Maintainer status is held by a person, not by an employer. A technical lead who
leaves NOAA remains technical lead until the maintainers agree otherwise, and
retains repository access on the same terms as any other non-federal
maintainer. Loss of a `noaa.gov` address is not by itself grounds for removal.

*This clause exists because it is the failure mode most likely to go unstated
and most costly to discover late. Confirm it is compatible with GSL org policy
before adoption.*

## Repository lifecycle

The hosting organization commits to the following. These are the terms under
which the canonical repository moved.

- **No archiving, deletion, or change to private visibility** without ______
  days' written notice to the maintainers.
- **Defined handoff.** If the organization stops hosting the project, the
  code, the issue and pull request history, and the release artifacts transfer
  to a named successor or are mirrored to a location the maintainers can reach.
- **Independent preservation is expected, not merely permitted.** Tagged
  releases deposit to Zenodo under the existing concept DOI. Mirrors to
  ______________________ are maintained. Neither requires permission and
  neither is treated as a signal of distrust.

## Downstream forks

Node operators fork and run TerraViz freely under Apache-2.0. No notification,
registration, or permission is required, and no phone-home mechanism exists or
will be added.

`zyra-project/terraviz` is one such fork with no special status. It is not a
mirror, not a staging area, and not a second issue tracker. Issues and pull
requests belong upstream. Downstream forks that want to send changes back use
GitHub's ordinary cross-fork pull request flow, which preserves attribution,
review threads, and DCO sign-off.

*Explicit non-goal: bidirectional issue synchronization or pull request
relaying between repositories. Splitting a discussion across two trackers with
partial sync loses comments and drops issues silently. One venue.*

## Divergence between the canonical repository and downstream forks

**Current state: none.** `NOAA-GSL/terraviz` and `zyra-project/terraviz` run the
same software. There are no government-only features and no capability a node
operator outside NOAA lacks. This section exists to keep it that way by
default, and to say what happens if that changes.

**Configuration, not code.** Government-specific requirements are met by
deployment posture, configuration, and documentation: Access policies, edge
CSP, branding and disclaimers, records handling, conformance artifacts. None of
those require code the community fork does not have. A requirement that appears
to need a fork-only patch should first be tried as configuration.

**Security fixes flow upstream and reach every node.** Hardening lands in the
canonical repository and ships to all forks. No node runs a version with a
known-fixed vulnerability because the fix was scoped to one operator. If the
word "hardened" is used to describe a NOAA build, that is a signal to check
which direction the hardening is flowing, because publishing the unhardened
build to the public is the wrong way round.

**If NOAA-specific code becomes genuinely necessary**, it lands in the
canonical repository behind a flag or configuration gate rather than as a
fork-only patch, so every fork carries the same code with the feature off.

**If true divergence becomes unavoidable**, it is documented in-repo: what
differs, why, and who maintains it. Security posture is not an acceptable
axis of divergence.

*Revisit when:* any government-specific requirement is proposed that cannot be
met by configuration.

## Review of AI-assisted changes

**Status: unresolved. This section names the problem rather than solving it.**

Most changes to TerraViz are AI-assisted. Combined with a single maintainer,
that produces a specific weakness that the branch protections do not address:
**the person who prompts a change is the person who approves it.** That is
self-approval with extra steps, not review.

It matters more for generated code than for hand-written code, for two reasons.
Generated code is fluent before it is correct, so it fails the eyeball test in
a way that buggy hand-written code usually does not. And the reviewer is
holding the same mental model they gave the model, which is the worst position
from which to notice that the framing itself was wrong. Noticing something is
amiss and knowing what correct means are precisely the things a model is
weakest at, so they are the things a human has to supply.

**What stands in today, honestly labeled as partial.** Type-check,
`check:i18n-strings`, unit tests, binding and deploy checks, CodeQL, and
Dependabot all run and all catch real defects. None of them catch a change that
is internally consistent and does the wrong thing. That gap is currently
covered by one person's attention.

**Risk-tiered review is the near-term direction.** Not every change needs the
same scrutiny, and pretending otherwise produces ceremony rather than safety.
Higher scrutiny belongs on: anything touching `functions/api/v1/publish/**`,
the analytics ingest path and the eight privacy invariants, authentication and
Access configuration, D1 migrations, and the federation identity and signing
code. Token changes, translations, and documentation do not need the same bar.
CODEOWNERS is the mechanism and it is currently closer to placeholder than to
policy, which should be fixed before cutover.

**AI-assisted review is a partial measure and should be described as one.** A
second model reviewing a diff catches some things and is cheap, but errors
correlate across models with similar training. It does not substitute for a
human who was not in the original loop.

**What changes with a second maintainer.** Independent review becomes possible
for the first time. This is the strongest present-tense argument for the second
maintainer in [`MAINTAINERS.md`](MAINTAINERS.md), stronger than bus factor,
because bus factor is a future loss and this is a current gap.

*Revisit when:* a second maintainer joins, or a change ships that independent
review would have caught.

## Name and marks

______________________________________________

*Unresolved. Recorded as blank rather than assumed.*

## Amending this document

By pull request, with agreement from all active maintainers. The amendment
history is the git history.
