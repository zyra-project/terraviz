#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Zyra Project

# SessionStart hook: make `actionlint` available so the PostToolUse hook
# .claude/hooks/check-actionlint.mjs can lint workflow edits locally
# instead of waiting for the Actionlint job in ci.yml.
#
# The version and checksum are READ FROM ci.yml rather than duplicated
# here, so bumping the CI pin bumps this too and the two cannot drift.
# ci.yml pins deliberately — "this job exists to be the backstop, so its
# own supply chain shouldn't be a moving target" — and a local installer
# that floated to latest would quietly undo that.
#
# shellcheck is a soft dependency: actionlint picks it up automatically
# when present and uses it to lint every `run:` block, so without it the
# local check reports strictly less than CI. Installed when apt-get is
# available and unprivileged installs are possible; skipped otherwise.
#
# Like the other SessionStart hooks this MUST never fail a session:
# every path is best-effort and we exit 0 unconditionally.
set +e

cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

CI="/.github/workflows/ci.yml"
CI=".${CI}"
[ -f "$CI" ] || exit 0

VERSION="$(grep -oE 'ACTIONLINT_VERSION:[[:space:]]*[0-9]+\.[0-9]+\.[0-9]+' "$CI" | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
SHA256="$(grep -oE 'ACTIONLINT_SHA256:[[:space:]]*[0-9a-f]{64}' "$CI" | head -1 | grep -oE '[0-9a-f]{64}')"
[ -n "$VERSION" ] && [ -n "$SHA256" ] || exit 0

DEST="${HOME}/.local/bin"
BIN="${DEST}/actionlint"

# Already at the pinned version? Nothing to do. A different version is
# not good enough: the point is to reproduce what CI will say.
if [ -x "$BIN" ]; then
  current="$("$BIN" --version 2>/dev/null | head -1 | tr -d '[:space:]')"
  [ "$current" = "$VERSION" ] && exit 0
fi

mkdir -p "$DEST" 2>/dev/null || exit 0

tmp="$(mktemp -d 2>/dev/null)" || exit 0
trap 'rm -rf "$tmp"' EXIT

url="https://github.com/rhysd/actionlint/releases/download/v${VERSION}/actionlint_${VERSION}_linux_amd64.tar.gz"
curl -fsSL --max-time 60 -o "$tmp/actionlint.tar.gz" "$url" 2>/dev/null || exit 0

# Refuse to install anything whose checksum does not match the CI pin.
echo "${SHA256}  ${tmp}/actionlint.tar.gz" | sha256sum -c - >/dev/null 2>&1 || exit 0

tar xzf "$tmp/actionlint.tar.gz" -C "$tmp" actionlint 2>/dev/null || exit 0
install -m 0755 "$tmp/actionlint" "$BIN" 2>/dev/null || exit 0

# Soft dependency — actionlint finds it on PATH by itself.
if ! command -v shellcheck >/dev/null 2>&1; then
  apt-get install -y --no-install-recommends shellcheck >/dev/null 2>&1 || true
fi

exit 0
