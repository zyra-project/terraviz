#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Zyra Project

# SessionStart hook: surface planning docs whose `Last reviewed:` date
# has aged out, before their directives get applied.
#
# CLAUDE.md asks for exactly this and asks for it at exactly this moment
# — "Before applying its directives, verify the doc is still current …
# surface that to the user before proceeding rather than silently
# applying potentially stale guidance." Left to memory, the check is
# skipped precisely when a session is busy enough to need it.
#
# Runs with --quiet, so it prints nothing at all until a doc actually
# crosses a threshold. Advisory only: the underlying script exits 0 by
# design (see its header for why a date must not gate CI), and this hook
# exits 0 unconditionally like every other SessionStart hook here.
set +e

cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

[ -f scripts/check-doc-freshness.ts ] || exit 0
[ -x node_modules/.bin/tsx ] || exit 0   # deps not installed yet

node_modules/.bin/tsx scripts/check-doc-freshness.ts --quiet 2>&1

exit 0
