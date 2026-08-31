#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// PostToolUse hook: remind you to add a module-map row when you create
// a new module, instead of finding out from CI after a push.
//
// CLAUDE.md: "When you add a module, add its row in the same PR."
// `npm run check:doc-coverage` enforces that in the type-check chain,
// but only once you push — by which point the context has moved on.
//
// Cost control. The check scans the whole repo (~0.8s via tsx, ~1.2s
// through npm) and has no single-file mode, so running it on every
// write would tax the common case to catch a rare one. The gate is
// structural rather than a micro-optimization:
//
//   doc-coverage can only NEWLY fail when a new module file appears.
//   Editing a module that is already documented cannot change its
//   coverage status.
//
// So we run the real check only when the written file is new — matcher
// is Write (Edit cannot create a file), and the path is untracked by
// git. In a normal session that fires a handful of times, not on every
// keystroke.
//
// The gates below are a PREFILTER ONLY. They decide whether to run the
// check, never what the verdict is — scripts/check-doc-coverage.ts
// stays the single source of truth for coverage itself. A prefilter
// that drifts makes this hook fire slightly too often or too rarely;
// it can never produce a wrong answer. (A file created by Bash rather
// than Write is simply missed here — CI still catches it.)
//
// Fails OPEN, like the other guards: any error allows the session to
// continue silently.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { relative, isAbsolute, basename, join } from 'node:path'

// Mirrors COVERAGE_ROOTS in scripts/check-doc-coverage.ts. Without
// this, creating any new .ts anywhere — a script, a fixture — pays for
// a whole-repo scan to be told it was never covered. `scripts/` alone
// is 108 files.
const COVERED_ROOTS = [
  { prefix: 'src/', ext: /\.ts$/ },
  { prefix: 'src-tauri/src/', ext: /\.rs$/ },
  { prefix: 'functions/', ext: /\.ts$/ },
  { prefix: 'cli/', ext: /\.ts$/ },
  // `scripts/lib/` only, not `scripts/` — matches COVERAGE_ROOTS, so a
  // new one-shot CLI at the top of scripts/ still skips without paying
  // for a scan.
  { prefix: 'scripts/lib/', ext: /\.ts$/ },
]

// Mirrors EXCLUDE_BASENAME in scripts/check-doc-coverage.ts. Prefilter
// only — keeps routine test-file creation from paying for a scan.
const EXCLUDED = [/\.test\.ts$/, /\.d\.ts$/, /^messages\.ts$/, /^messages\.[^.]+\.ts$/, /^test-setup\.ts$/]

function main() {
  let raw = ''
  try {
    raw = readFileSync(0, 'utf8')
  } catch {
    return
  }

  const payload = JSON.parse(raw)
  if (payload.tool_name !== 'Write') return

  const filePath = payload?.tool_input?.file_path
  if (typeof filePath !== 'string') return

  const root = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd()
  const rel = (isAbsolute(filePath) ? relative(root, filePath) : filePath).split('\\').join('/')

  // Outside the repo, or outside a root the module maps actually cover.
  // `src-tauri/src/` is checked before `src/` would ever match it, since
  // the prefixes are compared as written and do not overlap.
  if (rel.startsWith('..')) return
  if (!COVERED_ROOTS.some((r) => rel.startsWith(r.prefix) && r.ext.test(rel))) return
  if (EXCLUDED.some((re) => re.test(basename(rel)))) return

  // Already tracked => not a new module => coverage status unchanged.
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', rel], { cwd: root, stdio: 'ignore' })
    return
  } catch {
    // Non-zero means untracked, i.e. new. Fall through and check.
  }

  const tsx = join(root, 'node_modules', '.bin', 'tsx')
  const script = join(root, 'scripts', 'check-doc-coverage.ts')
  if (!existsSync(tsx) || !existsSync(script)) return // deps not installed

  try {
    execFileSync(tsx, [script], { cwd: root, timeout: 30_000, stdio: 'pipe' })
    return // exit 0 — documented, or legitimately doc-exempt
  } catch (err) {
    const out = String(err?.stdout ?? '') + String(err?.stderr ?? '')
    // A timeout or a missing interpreter is not a coverage failure.
    if (err?.killed || !out.includes('[doc-coverage]')) return

    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason:
          `A new module was created and the module map does not cover it yet.\n\n` +
          `${out.trim()}\n\n` +
          `CLAUDE.md requires the row in the same change as the module.`,
      })
    )
  }
}

try {
  main()
} catch {
  // Fail open — never break a session over a documentation reminder.
}
process.exit(0)
