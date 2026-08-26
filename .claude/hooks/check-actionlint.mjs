#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// PostToolUse hook: lint GitHub Actions workflows at edit time, so a
// broken expression or a bad `runs-on` surfaces now rather than from the
// Actionlint job in ci.yml after a push.
//
// Lints ALL workflows, not just the edited one, because that is what CI
// does and it costs ~0.23s for the repo's 17 files (a single file is
// ~0.03s — the difference is not worth the weaker guarantee). Matching
// CI's scope means a clean run here implies a clean run there.
//
// One caveat it cannot fix: actionlint uses shellcheck to lint `run:`
// blocks when shellcheck is on PATH, and reports strictly less without
// it. ci.yml's own comment says so. install-actionlint.sh tries to
// install both; where it cannot, this hook silently checks less. It only
// ever speaks when it finds something, so silence is never a claim that
// the workflows are clean.
//
// Files are passed explicitly. Invoked bare, actionlint walks up for a
// `.git` directory and, failing to find one, prints "no project was
// found" and exits 0 — a green result that checked nothing. ci.yml
// guards against the same trap.
//
// Fails OPEN, like the other guards.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { relative, isAbsolute, join } from 'node:path'

const WORKFLOW_DIR = '.github/workflows'

function resolveActionlint(root) {
  const candidates = [
    join(process.env.HOME ?? '', '.local', 'bin', 'actionlint'),
    join(root, 'actionlint'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  try {
    return execFileSync('command', ['-v', 'actionlint'], { shell: true, encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

function main() {
  let raw = ''
  try {
    raw = readFileSync(0, 'utf8')
  } catch {
    return
  }

  const payload = JSON.parse(raw)
  if (payload.tool_name !== 'Write' && payload.tool_name !== 'Edit') return

  const filePath = payload?.tool_input?.file_path
  if (typeof filePath !== 'string') return

  const root = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd()
  const rel = (isAbsolute(filePath) ? relative(root, filePath) : filePath).split('\\').join('/')

  if (!rel.startsWith(`${WORKFLOW_DIR}/`) || !/\.ya?ml$/.test(rel)) return

  const bin = resolveActionlint(root)
  if (!bin) return // not installed — see install-actionlint.sh

  let files
  try {
    files = readdirSync(join(root, WORKFLOW_DIR))
      .filter((f) => /\.ya?ml$/.test(f))
      .sort()
      .map((f) => `${WORKFLOW_DIR}/${f}`)
  } catch {
    return
  }
  if (files.length === 0) return

  try {
    execFileSync(bin, ['-no-color', ...files], { cwd: root, timeout: 60_000, stdio: 'pipe' })
    return // clean
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.killed) return

    const out = (String(err?.stdout ?? '') + String(err?.stderr ?? '')).trim()
    // "no project was found" means it linted nothing, not that it passed.
    if (!out || out.includes('no project was found')) return

    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason:
          `actionlint reported problems in the workflows:\n\n${out}\n\n` +
          `The Actionlint job in ci.yml runs the same check.`,
      })
    )
  }
}

try {
  main()
} catch {
  // Fail open — never break a session over a workflow lint.
}
process.exit(0)
