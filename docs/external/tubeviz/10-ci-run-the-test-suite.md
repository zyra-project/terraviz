# CI: run the existing test suite on every push and PR

**Labels:** `chore`, `testing`, `infrastructure`

## Summary

There is no `.github/` directory. ~3,000 lines of tests exist and nothing runs
them automatically.

## Background

The suite is substantive and covers the parts most likely to break silently:

- [`tests/test_schema_migration_trim.py`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/tests/test_schema_migration_trim.py)
  — the v0.23 SQLite migration
- [`tests/test_native_vector_manifest.py`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/tests/test_native_vector_manifest.py)
  — the native manifest contract
- [`tests/test_selection_seed.py`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/tests/test_selection_seed.py)
  — selection determinism
- [`tests/test_live_download_guard.py`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/tests/test_live_download_guard.py)
  — the live/upcoming-stream rejection rule

[`pyproject.toml`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/pyproject.toml)
already configures `pythonpath = ["src"]` and `testpaths = ["tests"]`, and a
`dev` extra with pytest and httpx. A workflow is ~20 lines.

## Proposal

`.github/workflows/ci.yml`:

- **test** — Python 3.11 / 3.12 / 3.13 matrix on `ubuntu-latest`;
  `apt-get install ffmpeg`; `pip install -e '.[dev]'`; `pytest -q`.
  Deliberately *without* the `semantic` extra so CI proves the no-OpenCLIP path
  keeps working — the degraded path most users actually run.
- **semantic** (optional, one Python version) — installs `.[semantic]` and runs
  only the tests that need it, so a PyTorch download doesn't sit on the critical path.
- **native** — `cmake` + FFmpeg dev libs, build only
  ([`native/CMakeLists.txt`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/native/CMakeLists.txt)),
  no rendering. Catches compile breaks in
  [`native/src/effects.cpp`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/native/src/effects.cpp),
  which is where most native churn lands.

Worth adding at the same time: `ruff` for lint/format. The codebase is already
consistent (`from __future__ import annotations` everywhere, modern `X | None`
unions), so adoption should be near-zero-diff.

## Acceptance criteria

- [ ] Tests run on push and PR across the supported Python versions.
- [ ] The default job passes with **no** optional extras installed.
- [ ] The native build compiles in CI.
- [ ] A status badge in the README.

## Related

**#6** proposes a visual regression job. Land this first — it is the cheap half
and the harness will want somewhere to hang.
