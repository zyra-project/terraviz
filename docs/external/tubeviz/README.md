# Upstream read: `interrupt21h/tubeviz`

> **Nothing here is to be filed anywhere.** tubeviz is an unaffiliated upstream
> project. These notes exist to record what was read and what was concluded —
> they are not a backlog, and they are not proposals for that project's
> maintainer.

## What this is

Notes from a code read of [tubeviz](https://github.com/interrupt21h/tubeviz) by
Scott Muller — an AI-directed, video-first music visualizer — at commit
[`87b048a`](https://github.com/interrupt21h/tubeviz/commit/87b048a5c54ea8ed6054651b32dda5adb7b87b45)
(v0.24.0). The eleven numbered files were originally drafted as issue bodies
before it was settled that nothing would be filed upstream. They are kept
because the analysis is accurate and it is the reasoning behind the TerraViz
plan; they are **not** kept as a to-do list.

**The actual deliverable is [`docs/TOUR_DIRECTION_PLAN.md`](../../TOUR_DIRECTION_PLAN.md).**
Read that first. It scopes what TerraViz can build, and its §3 records the
licensing position that governs all of it.

## The licensing position, in one paragraph

tubeviz publishes no LICENSE file, so default copyright applies and no
permission to copy exists. TerraViz is Apache-2.0 and its
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md) forbids contributing third-party
code we don't have rights to. **No tubeviz code — no file, function, shader, or
line-by-line port — may enter this repository.** What may travel is the design
idea, credited by name. Full reasoning, including the clean-room caveat and the
one request that would change the answer, is in
[`TOUR_DIRECTION_PLAN.md` §3](../../TOUR_DIRECTION_PLAN.md#3-licensing--what-we-may-and-may-not-take).

## Which notes fed the plan

| Note | Became |
|---|---|
| [03](03-director-driver-seam.md) — driver seam for the shot planner | **D1**, shot sequencing for generated tours |
| [04](04-visual-fingerprint-similarity.md) — fingerprint as retrieval | **D2**, dataset visual fingerprint |
| [03](03-director-driver-seam.md) + tubeviz's beat-accent alignment | **D3**, pacing from the data's own dynamics (parked) |
| tubeviz's Studio In/Out trim (v0.23) | **D4**, publisher usable range |

The remaining notes — [01](01-pluggable-ingest-sources.md),
[02](02-clip-rights-provenance.md), [05](05-timeline-contract-versioning.md),
[06](06-visual-regression-harness.md), [07](07-renderer-parity.md),
[08](08-add-a-license.md)–[11](11-studio-network-hardening.md) — describe
tubeviz's own gaps and have no TerraViz counterpart. Several of them are
patterns TerraViz *already* has (a versioned shared contract, a visual
regression harness, a pure-planner/thin-renderer split), which is why they read
as observations rather than plans.

[08](08-add-a-license.md) is the one note with any onward relevance: adding a
licence is what would make tubeviz's code importable at all, and §3 of the plan
treats that as a courteous request someone could make, not a dependency.

## Standing caveat

Every code link in these notes is pinned to a commit SHA, so line anchors stay
correct as both projects move. Observations about tubeviz were true at
`87b048a` and may not stay true.
