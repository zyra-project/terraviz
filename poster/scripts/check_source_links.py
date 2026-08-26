#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Zyra Project

# Apache-2.0
"""Validate poster source-code links don't drift from main.

Scans poster/index.html for GitHub source links of the form

    https://github.com/zyra-project/terraviz/blob/main/<path>

and asserts that <path> exists in the local checkout. Catches
file renames and moves before they ship as broken links — the
poster intentionally links filenames in §4-style cards directly
to source so visitors can dive into the technical details.

Also flags `#L<n>` line-pinned fragments as warnings, since the
poster deliberately avoids line-pinned URLs (line numbers are
unstable across refactors). File-level links survive any edit
that doesn't rename or move the file.

Stdlib only. Returns:
  0 — all links resolve, no warnings
  1 — at least one link points at a path that no longer exists
  2 — usage error (poster/index.html missing — run build_poster.py)
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
POSTER = HERE.parent
REPO = POSTER.parent
INDEX = POSTER / "index.html"

# Match the canonical source-link shape and capture (path, fragment).
# The path stops at any character that can't appear in a URL path
# segment within an HTML attribute (quote, whitespace, ), #).
LINK_RE = re.compile(
    r'https://github\.com/zyra-project/terraviz/blob/main/'
    r'([^"\'\s)#]+)'           # path
    r'(#[^"\'\s)]+)?'          # optional fragment
)

LINE_PIN_RE = re.compile(r'^#L\d+')


def main() -> int:
    if not INDEX.exists():
        print(
            f"error: {INDEX} not found — run "
            f"poster/scripts/build_poster.py first",
            file=sys.stderr,
        )
        return 2

    html = INDEX.read_text(encoding="utf-8")
    matches = list(LINK_RE.finditer(html))
    if not matches:
        print("no source links found in poster/index.html — nothing to check")
        return 0

    # Group by path so the report is readable when the same file
    # is linked from multiple sections.
    paths = sorted({m.group(1) for m in matches})
    line_pinned = sorted({
        m.group(1) + m.group(2)
        for m in matches
        if m.group(2) and LINE_PIN_RE.match(m.group(2))
    })

    broken: list[str] = [p for p in paths if not (REPO / p).is_file()]

    print(f"checked {len(paths)} unique source link(s):")
    for p in paths:
        marker = "ok " if (REPO / p).is_file() else "!! "
        print(f"  [{marker}] {p}")

    if line_pinned:
        print()
        print(
            "warning: line-pinned fragments found (these go stale "
            "on every refactor):"
        )
        for url in line_pinned:
            print(f"  - {url}")

    if broken:
        print()
        print(
            f"error: {len(broken)} source link(s) point at paths "
            f"that no longer exist in this checkout:",
            file=sys.stderr,
        )
        for p in broken:
            print(f"  - {p}", file=sys.stderr)
        print(
            "Update the poster section to reference the new path, "
            "or remove the link if the file was deleted.",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
