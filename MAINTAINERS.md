# Maintainers

> **Status: draft for review.** Roles and process are defined in
> [`GOVERNANCE.md`](GOVERNANCE.md).
>
> **Last reviewed:** 2026-08-31
> **Revisit when:** anyone is added or moves to emeritus.

## Active

| Name | GitHub | Role | Area |
|---|---|---|---|
| Eric Hackathorn | @Hackshaven | Technical lead | Whole tree |
| | | Maintainer | |
| | | Maintainer | |

**Two rows are blank on purpose.** TerraViz currently has one maintainer, which
is the project's largest single risk. The blanks stay until they are filled by
people, not by aspiration. See [`GOVERNANCE.md`](GOVERNANCE.md) §Honest
statement of current state.

Candidate areas for a second maintainer, roughly in order of how much they
would relieve:

- **Backend and catalog.** `functions/api/v1/**`, D1 migrations, the publisher
  API, R2 asset flow.
- **Globe and rendering.** The WebGL2 `CustomLayerInterface`, MapLibre
  integration, GIBS layers, tour engine.
- **Workflows and operations.** The Zyra integration, GHA runners, transcode
  pipeline, deploy checks.

A maintainer does not need to be a NOAA employee, and non-federal candidates
(CIRES, university, museum, or partner node operators) are actively preferred
for the second slot, because a second maintainer inside the same lab does not
reduce the correlated failure.

## Emeritus

None yet.

## Contacting maintainers

Open an issue. For anything that should not be public, ______________________.

## Becoming a maintainer

By invitation, based on sustained review-quality contribution. There is no
commit threshold. If you have been reviewing pull requests and triaging issues
and want to formalize it, say so in an issue and it will be discussed in the
open. See [`GOVERNANCE.md`](GOVERNANCE.md) §Becoming and ceasing to be a
maintainer.

All commits require DCO sign-off (`git commit -s`). No CLA. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).
