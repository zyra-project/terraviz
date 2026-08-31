#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Zyra Project

# Apache-2.0
"""Build poster/index.html from poster/sections/*.

Concatenates the four template files (_head.html, _styles.css,
_body-open.html, _footer.html) and every sec-*.html partial in
numeric order into a single self-contained HTML file. The CSS
is inlined into a <style> block in the head so the rendered
file works under file:// without a server, matching how the
companion posters in the series ship.

Stdlib only; no third-party dependencies. Runs from anywhere:

    python3 poster/scripts/build_poster.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
POSTER = HERE.parent
SECTIONS = POSTER / "sections"
OUTPUT = POSTER / "index.html"

# _head.html must contain this marker; the build script replaces
# it with <style>...</style> wrapping the contents of _styles.css.
CSS_MARKER = "<!-- INLINE_CSS -->"


def _read(path: Path) -> str:
    if not path.exists():
        sys.exit(f"error: missing required file: {path}")
    return path.read_text(encoding="utf-8")


# Matches the two-line SPDX header that every source file carries (see
# scripts/check-license-headers.ts), in either the HTML or the CSS comment
# style, plus the blank line under it.
_LICENSE_HEADER = re.compile(
    r"\A(?:<!--|/\*)\s*SPDX-License-Identifier:[^\n]*\n"
    r"(?:<!--|/\*)\s*Copyright[^\n]*\n\s*\n",
)


def _read_partial(path: Path) -> str:
    """Read a fragment, dropping its licence header.

    Every partial under sections/ carries the repository's SPDX header, and
    every one of them is concatenated into a single document. Kept, they would
    put nineteen identical copyright blocks inside one page. _head.html is
    deliberately NOT read through here: it leads the output, so its header
    becomes the built page's one header, sitting under the doctype exactly
    where the check expects it.
    """
    return _LICENSE_HEADER.sub("", _read(path), count=1)


def build() -> None:
    head = _read(SECTIONS / "_head.html")
    styles = _read_partial(SECTIONS / "_styles.css")
    body_open = _read_partial(SECTIONS / "_body-open.html")
    footer = _read_partial(SECTIONS / "_footer.html")

    if CSS_MARKER not in head:
        sys.exit(
            f"error: {SECTIONS / '_head.html'} must contain the "
            f"marker {CSS_MARKER!r} where inlined CSS is injected"
        )
    head_with_css = head.replace(
        CSS_MARKER,
        f"<style>\n{styles.rstrip()}\n  </style>",
    )

    sections = sorted(SECTIONS.glob("sec-*.html"))
    if not sections:
        sys.exit("error: no sec-*.html partials found")

    parts: list[str] = [head_with_css.rstrip(), body_open.rstrip()]
    for section in sections:
        parts.append(f"\n  <!-- {section.name} -->")
        parts.append(_read_partial(section).rstrip())
    parts.append(footer.rstrip())

    output = "\n".join(parts) + "\n"
    OUTPUT.write_text(output, encoding="utf-8")

    rel = OUTPUT.relative_to(POSTER.parent)
    line_count = output.count("\n")
    print(f"wrote {rel}")
    print(f"  sections: {len(sections)}")
    print(f"  bytes:    {len(output.encode('utf-8'))}")
    print(f"  lines:    {line_count}")


if __name__ == "__main__":
    build()
