#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Zyra Project

# SessionStart hook: surface Git LFS files that are still pointer stubs.
#
# A clone made without git-lfs leaves 131-byte text files where the
# skybox and specular textures should be, and nothing says so — the
# build reports zero errors and the globe comes up with no stars. That
# is worth one line at session start, because the alternative is
# noticing it after a deploy.
#
# Runs with --quiet, so it prints nothing until something is actually
# wrong. Advisory only: the underlying script exits 0 by design without
# --strict (see its header for why this must not gate every build), and
# this hook exits 0 unconditionally like every other SessionStart hook
# here.
set +e

cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

[ -f scripts/check-lfs.ts ] || exit 0
[ -x node_modules/.bin/tsx ] || exit 0   # deps not installed yet

node_modules/.bin/tsx scripts/check-lfs.ts --quiet 2>&1

exit 0
