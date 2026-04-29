/**
 * scripts/clean-d1-state.ts — cross-platform `rm -rf` for the
 * Wrangler local D1 directory.
 *
 * `npm run db:reset` chains migrate + seed against a fresh local
 * D1; the previous `rm -rf .wrangler/state/v3/d1` was POSIX-only
 * and broke on Windows shells. Running this through `tsx` works on
 * every platform Wrangler supports.
 */

import { rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const target = resolve(__dirname, '..', '.wrangler', 'state', 'v3', 'd1')

rmSync(target, { recursive: true, force: true })
