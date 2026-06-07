#!/usr/bin/env bash
# SessionStart hook: ensure the `graphify` CLI is available so the
# vendored `/graphify` skill (.claude/skills/graphify/) can shell out
# to it in Claude Code web sessions.
#
# The skill's SKILL.md also self-installs graphifyy on first run, so
# this hook is a pre-warm, not a hard dependency. It is best-effort
# and MUST never fail a session: every path ends in `|| true`, and we
# exit 0 unconditionally.
#
# Pinned to the version the skill was vendored at — see
# .claude/skills/graphify/VENDORED.md. Bump both together.
set +e

GRAPHIFY_VERSION="0.8.33"

# Already on PATH at the pinned version? Nothing to do. A *different*
# version is not good enough — the vendored skill (SKILL.md +
# references) is matched to this CLI, so fall through and (re)install
# the pin rather than letting the skill drive an incompatible CLI.
if command -v graphify >/dev/null 2>&1; then
  current="$(graphify --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  if [ "$current" = "$GRAPHIFY_VERSION" ]; then
    exit 0
  fi
fi

# Prefer pipx (isolated), fall back to pip --user, then a system pip.
# `--force` so a mismatched pre-existing install is replaced, not skipped.
if command -v pipx >/dev/null 2>&1; then
  pipx install --force "graphifyy==${GRAPHIFY_VERSION}" >/dev/null 2>&1 || true
elif command -v pip3 >/dev/null 2>&1; then
  pip3 install --user --quiet "graphifyy==${GRAPHIFY_VERSION}" >/dev/null 2>&1 \
    || pip3 install --user --quiet --break-system-packages "graphifyy==${GRAPHIFY_VERSION}" >/dev/null 2>&1 \
    || true
fi

exit 0
