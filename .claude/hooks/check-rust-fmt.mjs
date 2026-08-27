#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// PostToolUse hook: tell you when the Rust source drifts out of rustfmt.
//
// The desktop app's Rust backend is the least-linted code in the repo:
// no rustfmt.toml, no clippy.toml, and desktop.yml caches ~/.cargo but
// never runs a lint step. Eight files getting materially less scrutiny
// than the 649 TypeScript ones.
//
// Flags rather than auto-formats, deliberately. This repo runs no
// formatter on TypeScript by choice, so a hook that silently rewrote
// source would import a convention the project has not opted into.
// Flagging also avoids a subtler failure: rewriting a file immediately
// after a write invalidates the exact-string match a follow-up Edit
// depends on.
//
// `cargo fmt --check` covers the whole crate in ~0.7s without
// compiling, so there is no need to target the single edited file —
// and using the canonical command means no rustfmt edition/config
// handling to drift out of sync with Cargo.toml.
//
// Clippy is deliberately NOT here. It needs the full dependency tree
// compiled, which is minutes on a cold cache — CI, where ~/.cargo is
// already warmed, is the right home for it.
//
// Fails OPEN, like the other guards.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { relative, isAbsolute, join } from 'node:path'

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

  if (!rel.startsWith('src-tauri/') || !rel.endsWith('.rs')) return

  const crate = join(root, 'src-tauri')
  if (!existsSync(join(crate, 'Cargo.toml'))) return

  try {
    execFileSync('cargo', ['fmt', '--check'], { cwd: crate, timeout: 60_000, stdio: 'pipe' })
    return // formatted
  } catch (err) {
    // No toolchain in this environment is not a formatting failure.
    if (err?.code === 'ENOENT' || err?.killed) return

    // Both streams: `cargo fmt --check` writes its diff to stdout in the
    // versions measured here, but reading only one stream would fail
    // open if that ever changed — and check-doc-coverage.mjs already
    // combines them, so this keeps the two hooks consistent.
    const out = String(err?.stdout ?? '') + String(err?.stderr ?? '')
    if (!out.includes('Diff in')) return

    const files = [...new Set([...out.matchAll(/^Diff in (\S+?):/gm)].map((m) => m[1]))]
      .map((f) => f.replace(`${root}/`, ''))
      .join(', ')

    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason:
          `Rust source is not rustfmt-clean: ${files}\n\n` +
          `Run \`cargo fmt\` in src-tauri/ to fix. ` +
          `(\`cargo fmt --check\` there shows the diff.)`,
      })
    )
  }
}

try {
  main()
} catch {
  // Fail open — never break a session over formatting.
}
process.exit(0)
