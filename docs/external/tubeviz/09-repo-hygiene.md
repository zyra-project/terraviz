# Repo hygiene: remove the nested duplicate tree, committed bytecode, and the third copy of the C++ source

**Labels:** `chore`, `good first issue`

## Summary

An entire older snapshot of the project is committed one directory down, ~100
`.pyc` files are tracked, and the C++ renderer source exists in three places.
None of it is load-bearing; all of it misleads readers and tooling.

## Background — what's actually there

**1. A nested stale copy of the whole project.** Alongside the real package at
`src/tubeviz/`, the repository also contains:

- [`src/src/tubeviz/`](https://github.com/interrupt21h/tubeviz/tree/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/src/tubeviz)
  — an older copy of the package (~890 KB). It predates the Studio GUI: it has
  no `gui.py`, no `static/gui.html`, no `visual_director.py`, no
  `visual_features.py`, and its `cli.py`, `library.py`, `models.py`,
  `scene_selector.py` and `native_render.py` all differ from the live ones.
- [`src/tests/`](https://github.com/interrupt21h/tubeviz/tree/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tests),
  [`src/native/`](https://github.com/interrupt21h/tubeviz/tree/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/native),
  [`src/pyproject.toml`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/pyproject.toml),
  [`src/README.md`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/README.md)
  — the matching older siblings. `src/tests/` is missing 12 of the current test
  files, including every `test_vector_*` and `test_visual_director`.

It is inert (`pyproject.toml` sets `pythonpath = ["src"]`, so `import tubeviz`
resolves to `src/tubeviz`), but it doubles what a reader has to disambiguate and
poisons repo-wide grep.

**2. Tracked bytecode.** 97 `.pyc` files are committed under
`__pycache__/` directories, for two different interpreters (`cpython-313` and
`cpython-314`). The [`.gitignore`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/.gitignore)
has no `__pycache__` entry (and lists `sample/machine-viz-test.mp4` and
`.pytest_cache` twice).

**3. Three copies of the C++ source.**
[`native/`](https://github.com/interrupt21h/tubeviz/tree/87b048a5c54ea8ed6054651b32dda5adb7b87b45/native)
and
[`src/tubeviz/native_src/`](https://github.com/interrupt21h/tubeviz/tree/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/native_src)
are currently byte-identical; `src/src/tubeviz/native_src/` is the stale third.
The duplication is *intentional* — the build resolver checks both:

- [`native_render.py#L363`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/native_render.py#L363)
  — `parents[2] / "native"` (source checkout)
- [`native_render.py#L367`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/native_render.py#L367)
  — `parent / "native_src"` (installed wheel)

…but two hand-synced copies of 1,500 lines of C++ will drift, and the failure
mode is subtle: a wheel install silently renders with older effect code.

## Why this is worth doing

Everything here is invisible to users and expensive for contributors: three
`effects.cpp` files, two `cli.py` files, and stale `.pyc` files that can shadow
imports in an unlucky environment. It is also the cheapest possible signal that
the project is meant to be worked on by more than one person.

## Proposal

- `git rm -r src/src src/tests src/native src/pyproject.toml src/README.md`
- `git rm -r --cached '**/__pycache__'`; add `__pycache__/`, `*.py[cod]`,
  `*.egg-info/`, `build/`, `dist/` to `.gitignore`; drop the duplicate entries.
- Keep **one** canonical `native/` tree and make the packaged copy a build-time
  artefact — a hatch build hook that copies `native/` into
  `tubeviz/native_src/` at wheel-build time — rather than a committed duplicate.
  `native_render.py` keeps both lookup paths unchanged.
- Consider adding `screenshot.png` (250 KB) to Git LFS, or leaving it; it is the
  README's hero image and only paid for once.

## Acceptance criteria

- [ ] `find . -name '*.pyc' -not -path './.git/*'` returns nothing tracked.
- [ ] Exactly one copy of each `.cpp`/`.hpp` in version control.
- [ ] `pip install .` still produces a wheel whose `tubeviz/native_src/` builds.
- [ ] `pytest` passes unchanged.
