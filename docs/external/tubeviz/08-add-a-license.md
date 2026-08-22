# Add a LICENSE

> **Not for filing.** tubeviz is upstream and unaffiliated; nothing here is to be opened as an issue on that repository. Kept as the analysis record behind [`docs/TOUR_DIRECTION_PLAN.md`](../../TOUR_DIRECTION_PLAN.md). See that document's §3 for why none of this code may be imported.

**Labels:** `documentation`, `good first issue`, `blocker`

## Summary

The repository has no `LICENSE` file, so by default nobody may legally copy,
modify, or redistribute it.

## Background

- No `LICENSE` / `COPYING` at the repository root.
- [`pyproject.toml`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/pyproject.toml)
  declares no `license` field and no license classifier.
- The package is otherwise publish-ready: a console entry point
  (`tubeviz = "tubeviz.cli:main"`), pinned dependency ranges, a hatchling build,
  and a maintained `CHANGELOG.md`.

Without an explicit grant, default copyright applies: readers may look, but not
fork, vendor, package, or contribute with any certainty.

## Why this is worth doing

It is the single highest-leverage five-minute change in the repo. Everything
else in this issue set assumes people other than the author can work on the
code.

There is also a dependency dimension worth a sentence in the README: the runtime
leans on FFmpeg and yt-dlp, and the optional extras pull in PyTorch via
`open_clip_torch`. Those are the licences downstream packagers will ask about.

## Proposal

- Add a `LICENSE` at the root. MIT or Apache-2.0 fits the ecosystem; Apache-2.0
  additionally grants patent rights, which matters for a project shipping signal
  and image-processing algorithms.
- Add `license` + classifier metadata to `pyproject.toml`.
- Optionally add a short `## License` section to the README noting the
  distinction between tubeviz's own licence and the rights status of any media a
  user ingests (see **#2**).

## Acceptance criteria

- [ ] `LICENSE` exists at the repository root.
- [ ] `pyproject.toml` declares it.
- [ ] README states it.
