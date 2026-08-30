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

**Changed on 2026-08-26: tubeviz is now Apache-2.0.** When these notes were
written it carried no LICENSE, so nothing in it could be copied. It now has a
`LICENSE`, a `NOTICE`, `license = "Apache-2.0"` in `pyproject.toml`, and an
`SPDX-License-Identifier` header on every source file. TerraViz is Apache-2.0
too, so importing is permitted subject to the ordinary §4 obligations: include
the licence, retain notices, state changes, carry NOTICE. We still mostly won't,
because the SPA is TypeScript and a port is a rewrite regardless. The Zyra side
is a real new option. Full reasoning in
[`TOUR_DIRECTION_PLAN.md` §3](../../TOUR_DIRECTION_PLAN.md#3-licensing--apache-20-both-sides).

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

**Two notes are resolved upstream**, both in v0.34.0 and both marked as such at
the top of their files. [08](08-add-a-license.md): the Apache-2.0 relicense
above. [09](09-repo-hygiene.md): the nested `src/src/` tree is deleted, no
`.pyc` is tracked, and the C++ source has a single canonical home, with
`tests/test_repository_layout.py` asserting all three so they cannot silently
regress. Still open there: `.gitignore` has no `__pycache__` entry and lists two
paths twice.

Re-checked at v0.34.0, [01](01-pluggable-ingest-sources.md) and
[02](02-clip-rights-provenance.md) remain accurate: `ingest.py` still imports
`YouTubeSource` concretely, and `library.py` still has no licence or rights
column. The new `acquisition.py` is about acquisition *quality* (rejecting title
cards, talking heads, slideshows), not a source seam.

## Standing caveat

Every code link in these notes is pinned to a commit SHA, so line anchors stay
correct as both projects move. Observations were true at `87b048a` (v0.24.0).

Upstream is moving quickly: 28 commits in five days took it to v0.34.0, adding
LLM-assisted direction (`ai_music_director.py`, `ai_edit_consultant.py`),
vision-model scene description (`vision_ai.py`), an audio-AI path behind an
optional `audio-ai` extra, a codec-glitch effect stack, and a rebuilt Studio.
Notes 03–07 have not been re-verified against that, so treat their line
references as historical rather than current.
