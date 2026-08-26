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


def build() -> None:
    head = _read(SECTIONS / "_head.html")
    styles = _read(SECTIONS / "_styles.css")
    body_open = _read(SECTIONS / "_body-open.html")
    footer = _read(SECTIONS / "_footer.html")

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
        parts.append(_read(section).rstrip())
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
