// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * scripts/lib/cli.ts — shared CLI helpers for tsx-based scripts.
 *
 * `isInvokedAsScript()` is the cross-platform "is this file the
 * entry point" check used to gate `main()`-style top-level calls.
 * The naive ``import.meta.url === `file://${process.argv[1]}` ``
 * comparison is broken on Windows (path separators, drive letters,
 * file-URL percent-encoding) and on POSIX systems where either side
 * may be reached via a symlink (e.g. an `npm link`-ed bin or
 * tsx-resolved entry). Both sides are canonicalized via
 * `realpathSync.native` so symlink indirection on either side does
 * not suppress the script's CLI behavior.
 */

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function isInvokedAsScript(importMetaUrl: string): boolean {
  if (!process.argv[1]) return false
  try {
    const here = realpathSync.native(fileURLToPath(importMetaUrl))
    const argv1 = realpathSync.native(resolve(process.argv[1]))
    return here === argv1
  } catch {
    return false
  }
}
