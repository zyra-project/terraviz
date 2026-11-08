// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Which `session_start.build_channel` a bundle reports, decided when
 * Vite starts (`vite.config.ts` bakes it into `__BUILD_CHANNEL__`).
 *
 * Its own module rather than a function in `vite.config.ts` so that
 * something type-checks it: no tsconfig covers the config file, while
 * `functions/tsconfig.json` already includes `scripts/lib/`. Testing it
 * here also avoids importing the config, which loads Vite's Node API.
 */

import type { BuildChannel } from '../../src/types'

/**
 * An explicit `public`, `internal` or `canary` in `VITE_BUILD_CHANNEL`
 * wins. With none, the dev server (`mode === 'development'`) is
 * `internal` and every other mode `public`, so a contributor who turns
 * console mode off to test the real transport still sends rows that
 * can be told from visitors (#531). A built bundle is `public` by
 * default, as before. Any other value is ignored rather than reported,
 * so a typo cannot put a bespoke string on the wire.
 *
 * Takes the env object `loadEnv` returns, which already puts a shell
 * variable over the same key in `.env` / `.env.local`, so precedence
 * matches every other `VITE_*` setting with no second read here.
 *
 * Keyed on `mode` rather than Vite's `command` because the client's
 * console-mode default (`resolveConsoleMode` in
 * `src/analytics/config.ts`) can only see `import.meta.env.MODE`, and
 * the two defaults must agree. The cost is that a dev server started
 * with a custom mode (`vite --mode staging`) is treated as a build:
 * `public`, with console mode off. Nothing in this repo passes
 * `--mode`; anyone who does should set both variables.
 */
export function resolveBuildChannel(
  env: Record<string, string | undefined>,
  mode: string,
): BuildChannel {
  const raw = env.VITE_BUILD_CHANNEL
  if (raw === 'public' || raw === 'internal' || raw === 'canary') return raw
  return mode === 'development' ? 'internal' : 'public'
}
